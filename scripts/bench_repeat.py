#!/usr/bin/env python3
"""Repetition benchmark: what n-gram speculative decoding is actually worth.

Runs INSIDE the compose network, like bench.py. Driven by
./scripts/spec-sweep.sh --workload repeat, or directly:

    docker compose --profile tools run --rm --build \
        --entrypoint python bench /work/scripts/bench_repeat.py --repeat 3

WHY bench.py CANNOT MEASURE THIS
--------------------------------
bench.py gives every prompt a unique nonce and a body of shuffled keywords,
deliberately, so that no run is served out of the prefix cache. That is correct
for measuring raw prefill and decode, and it is exactly wrong for measuring an
n-gram drafter: `ngram-simple` builds a lookup table from the live context and
drafts spans it has already seen. Random keyword soup contains nothing to look
up, so ngram-simple never fires and its row comes back flat.

A flat row there means "this workload had no repetition". It does NOT mean
"ngram-simple is useless", and reading it that way would retire the cheapest
speedup available to this stack. Hence this file: a workload with the shape the
real agent produces.

WHAT IT MEASURES
----------------
The prompt carries a synthetic source file; the task is to emit that file back
with one small, precisely specified edit. That is the single most common shape
of agentic coding traffic — pi reads a file and rewrites it with a change — and
the output is then almost entirely verbatim spans drawn from the prompt.

In llama.cpp b10200 the relevant engine facts, read from source rather than
assumed:

  * ngram-simple defaults are size_n=12, size_m=48, min_hits=1
    (common/common.h:358-362). It looks up a 12-token context and proposes up
    to 48 tokens in ONE step, with no llama_decode at all.
  * MTP drafts params.n_max tokens, each costing a full MTP forward pass
    (common/speculative.cpp:1520-1670).
  * The 48 is not clipped by --spec-draft-n-max. The per-slot ceiling dp.n_max
    is slot.get_n_draft_max() = n_ctx - prompt.n_tokens() - 2
    (tools/server/server-context.cpp:470, 3009) — a remaining-context budget,
    not the draft-length flag.
  * Priority is hard-coded with every n-gram impl ahead of every draft-model
    impl (common/speculative.cpp:2404-2437), and arbitration is first-non-empty,
    so an ngram hit skips the MTP pass entirely.

So on repetitive output the ceiling is 48 free tokens per cycle against MTP's 2
paid ones. This measures how much of that ceiling a real generation reaches.

THE CONTROL, WHICH IS THE POINT
-------------------------------
A repetition benchmark that only reports tok/s can be fooled twice:

  1. The model ignores the instruction and writes something new. Output is not
     repetitive, ngram cannot fire, the row is flat — and the flatness is caused
     by the PROMPT, not by the drafter. Reporting that as an ngram result would
     be a false negative with a confident face on it.
  2. The prompt is served from the prefix cache, so prefill is fiction.

Both are checked rather than hoped for. Every row reports `echo` — the fraction
of generated size_n-token windows that also occur in the prompt, computed with
the model's OWN tokenizer via llama-server's /tokenize endpoint, falling back to
whitespace tokens only if that endpoint is unavailable (and saying so). A row
whose echo is below --min-echo is marked UNREPEATED and excluded from the
summary, exactly as bench.py excludes CACHED rows. An excluded row is a broken
measurement, not a slow one.

Read the summary as: high echo + low draft/cycle means the drafter is not
exploiting repetition that is demonstrably there. High echo + high draft/cycle
is ngram-simple doing its job.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama:8080").rstrip("/")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")
TIMEOUT = float(os.environ.get("BENCH_TIMEOUT", "900"))

# Matches ngram-simple's default lookup width (common/common.h:359). The echo
# metric is only meaningful if it asks the same question the engine asks.
NGRAM_N = int(os.environ.get("BENCH_NGRAM_N", "12"))

FIELDS = ("area", "count", "label", "offset", "weight", "index", "limit", "scale")


def build_file(n_funcs: int) -> str:
    """A deterministic, code-shaped module.

    Deterministic on purpose: the run-to-run variable must be the engine
    config, not the payload. The nonce that busts the prefix cache is added by
    the caller, ahead of this text, never inside it — a nonce sprinkled through
    the body would break the very repetition being measured.
    """
    out = ["VERSION = \"1.0.0\"", ""]
    for i in range(n_funcs):
        f = FIELDS[i % len(FIELDS)]
        out += [
            f"def compute_{f}_{i}(records, factor=1.0):",
            f'    """Aggregate the {f} column of records, scaled by factor."""',
            "    if not records:",
            "        return 0.0",
            "    total = 0.0",
            "    for record in records:",
            f'        value = record.get("{f}")',
            "        if value is None:",
            "            continue",
            "        total += float(value) * factor",
            "    return total / len(records)",
            "",
        ]
    return "\n".join(out)


def post(path: str, payload: dict) -> tuple[int, dict, float]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{LLAMA_URL}{path}", data=data, headers={"Content-Type": "application/json"}
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, json.loads(resp.read().decode()), time.monotonic() - started
    except urllib.error.HTTPError as exc:
        return exc.code, {"error": exc.read().decode()[:400]}, time.monotonic() - started
    except Exception as exc:  # noqa: BLE001 - report, never crash the sweep
        return 0, {"error": f"{type(exc).__name__}: {exc}"}, time.monotonic() - started


_TOKENIZE_OK: bool | None = None


def tokenize(text: str) -> tuple[list, bool]:
    """Model tokens via /tokenize; whitespace tokens if that is unavailable.

    Returns (tokens, exact). `exact` is False when the fallback was used, and
    that is surfaced in the output rather than quietly assumed — a coverage
    figure computed on whitespace is a different measurement from one computed
    on model tokens, and the reader has to know which one they are looking at.
    """
    global _TOKENIZE_OK

    if _TOKENIZE_OK is not False:
        status, body, _ = post("/tokenize", {"content": text})
        if status == 200 and isinstance(body.get("tokens"), list):
            _TOKENIZE_OK = True
            return body["tokens"], True
        _TOKENIZE_OK = False

    return text.split(), False


def echo_fraction(prompt: str, completion: str) -> tuple[float, bool, int]:
    """Fraction of completion n-gram windows that also occur in the prompt.

    This is the drafter's-eye view: ngram-simple can only propose a span it has
    already seen in this context, so the share of the output that is a repeat
    of the prompt is the ceiling on what it could ever draft.
    """
    p_toks, exact_p = tokenize(prompt)
    c_toks, exact_c = tokenize(completion)
    exact = exact_p and exact_c

    n = NGRAM_N
    if len(c_toks) <= n:
        return 0.0, exact, len(c_toks)

    seen = set()
    for i in range(len(p_toks) - n + 1):
        seen.add(tuple(p_toks[i : i + n]))

    windows = len(c_toks) - n + 1
    hits = sum(1 for i in range(windows) if tuple(c_toks[i : i + n]) in seen)
    return hits / windows, exact, len(c_toks)


def bench_one(n_funcs: int, max_tokens: int, min_echo: float, run_index: int) -> dict:
    nonce = f"{os.getpid()}-{run_index}-{time.time_ns()}"
    source = build_file(n_funcs)

    # Nonce first: the prefix cache matches from the start of the prompt, so a
    # nonce anywhere else lets the body hit the cache (bench.py, same reason).
    prompt = (
        f"Session {nonce}.\n\n"
        "Here is a Python module:\n\n"
        f"```python\n{source}\n```\n\n"
        "Output the complete module again, character for character identical, "
        "changing only the VERSION string from \"1.0.0\" to \"1.0.1\". "
        "Output only the code in a single fenced block, with no commentary."
    )

    payload = {
        "model": MODEL_ALIAS,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": False,
    }

    status, body, wall = post("/v1/chat/completions", payload)
    row: dict = {
        "requested": n_funcs,
        "status": status,
        "wall_s": round(wall, 2),
        "workload": "repeat",
    }

    if status != 200:
        row["error"] = str(body.get("error", ""))[:300]
        return row

    t = body.get("timings") or {}
    if not t:
        row["error"] = (
            "no `timings` block in the response — talking to forge instead of "
            "llama, or an engine that does not report it"
        )
        return row

    row["prompt_n"] = t.get("prompt_n")
    row["prompt_tps"] = t.get("prompt_per_second")
    row["predicted_n"] = t.get("predicted_n")
    row["predicted_tps"] = t.get("predicted_per_second")

    cache_n = t.get("cache_n")
    row["cache_n"] = cache_n
    if cache_n:
        row["cached"] = True

    draft_n = t.get("draft_n")
    if draft_n:
        accepted = t.get("draft_n_accepted", 0)
        row["draft_n"] = draft_n
        row["draft_accepted"] = accepted
        row["draft_acceptance"] = round(accepted / draft_n, 3)

    try:
        completion = body["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        completion = ""

    echo, exact, n_out = echo_fraction(prompt, completion)
    row["echo"] = round(echo, 3)
    row["echo_exact_tokenizer"] = exact
    row["completion_tokens_measured"] = n_out

    if echo < min_echo:
        row["unrepeated"] = True

    return row


def fmt(row: dict) -> str:
    if row.get("error"):
        return f"  funcs={row['requested']:<4} status={row['status']:<4} ERROR {row['error']}"

    flags = ""
    if row.get("cached"):
        flags += "  CACHED (excluded)"
    if row.get("unrepeated"):
        flags += f"  UNREPEATED echo={row['echo']:.0%} (excluded)"

    draft = ""
    if row.get("draft_n"):
        draft = (
            f" draft={row['draft_accepted']}/{row['draft_n']} "
            f"({row['draft_acceptance']:.0%} accepted)"
        )

    return (
        f"  funcs={row['requested']:<4} "
        f"prompt={row.get('prompt_n', 0):<6} "
        f"out={row.get('predicted_n', 0):<5} "
        f"decode={row.get('predicted_tps') or 0:>6.1f} tok/s  "
        f"echo={row.get('echo', 0):>5.0%}  "
        f"wall={row['wall_s']:>6.2f}s{draft}{flags}"
    )


def usage() -> None:
    print(__doc__)
    print(
        "options:\n"
        "  --funcs N        functions in the generated module (default 12)\n"
        "  --repeat N       runs (default 3)\n"
        "  --max-tokens N   generation cap (default 2048)\n"
        "  --min-echo F     below this, a row is UNREPEATED and excluded (default 0.5)\n"
    )


def main() -> int:
    args = sys.argv[1:]
    n_funcs, repeat, max_tokens, min_echo = 12, 3, 2048, 0.5

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--funcs":
            n_funcs = int(args[i + 1]); i += 2
        elif a == "--repeat":
            repeat = int(args[i + 1]); i += 2
        elif a == "--max-tokens":
            max_tokens = int(args[i + 1]); i += 2
        elif a == "--min-echo":
            min_echo = float(args[i + 1]); i += 2
        elif a in ("-h", "--help"):
            usage()
            return 0
        else:
            print(f"unknown argument: {a}", file=sys.stderr)
            return 2

    print(f"\nbench-repeat — {MODEL_ALIAS} via {LLAMA_URL}")
    print(
        f"repetitive rewrite workload; echo measured over {NGRAM_N}-token windows "
        f"(ngram-simple's default lookup width)\n"
    )

    rows = []
    for run_index in range(1, repeat + 1):
        row = bench_one(n_funcs, max_tokens, min_echo, run_index)
        rows.append(row)
        print(fmt(row), flush=True)

    usable = [
        r for r in rows
        if not r.get("error") and not r.get("cached") and not r.get("unrepeated")
    ]
    print()

    if not usable:
        print(
            "no usable rows. Every run errored, hit the prompt cache, or failed the\n"
            "echo floor. A low echo means the model did not reproduce the file, so the\n"
            "workload — not the drafter — is what needs fixing: raise --max-tokens so\n"
            "the file fits, or lower --funcs."
        )
        print(json.dumps({"model": MODEL_ALIAS, "rows": rows}, indent=2))
        return 1

    if not all(r.get("echo_exact_tokenizer") for r in usable):
        print(
            "NOTE: /tokenize was unavailable, so echo was computed on whitespace "
            "tokens.\n      Treat it as an approximation, not a token-exact figure."
        )

    best_tg = max(r["predicted_tps"] or 0 for r in usable)
    mean_echo = sum(r["echo"] for r in usable) / len(usable)
    print(f"best decode: {best_tg:.1f} tok/s     mean echo: {mean_echo:.0%} "
          f"across {len(usable)} usable run(s)")

    drafted = [r for r in usable if r.get("draft_n")]
    if drafted:
        total_d = sum(r["draft_n"] for r in drafted)
        total_a = sum(r["draft_accepted"] for r in drafted)
        total_p = sum(r["predicted_n"] or 0 for r in drafted)
        cycles = total_p - total_a
        dpc = (total_d / cycles) if cycles > 0 else 0.0
        print(f"draft acceptance: {total_a}/{total_d} = {total_a / total_d:.1%}")
        print(f"draft per cycle:  {dpc:.2f} tokens")
        print(
            "\nWith ngram-simple enabled, draft/cycle can reach 48 (its size_m) because a\n"
            "lookup hit costs no forward pass. With draft-mtp alone it cannot exceed\n"
            "SPEC_DRAFT_N_MAX, and each drafted token costs one MTP pass. A high echo\n"
            "with draft/cycle pinned near n-max is repetition the engine is paying full\n"
            "price for."
        )
    else:
        print(
            "no draft counters in timings — SPEC_TYPE is off, or this GGUF has no MTP "
            "head (block_count must be 65, not 64)"
        )

    print(json.dumps({"model": MODEL_ALIAS, "rows": rows}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
