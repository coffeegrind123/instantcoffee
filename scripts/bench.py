#!/usr/bin/env python3
"""Throughput benchmark: prefill, decode, and MTP draft acceptance.

Runs INSIDE the compose network via `docker compose --profile tools run --rm
bench`, so it can reach llama-server directly. Use ./scripts/bench.sh.

WHY IT TALKS TO LLAMA AND NOT FORGE, AND WHY IT READS `timings`
---------------------------------------------------------------
This replaces a version that POSTed a fixed prompt and divided token counts by
end-to-end wall clock. That measurement is wrong twice over, and the repo has
already paid for learning it once (see context/design/decisions.md, 2026-08-12):

  1. Wall clock over the proxy measures proxy overhead, not engine throughput.
     llama-server reports its own `timings` block — prompt_per_second and
     predicted_per_second, measured around the actual compute — and forge strips
     it. So the numbers come from llama directly, and proxy cost, if you want
     it, is its own separate row.

  2. A fixed prompt is served out of the prefix cache on the second run.
     `--cache-prompt` is on in this stack, so a repeated benchmark reports a
     prefill rate for work it never did. Every prompt here carries a unique
     nonce, and any run whose `timings.cache_n` shows a reused prefix is marked
     CACHED and excluded rather than reported as a fast run.

The old version scored the same before and after a fix that made prefill ~65x
faster. A benchmark that cannot see a 65x regression is worse than none.

MTP
---
With `--spec-type draft-mtp` llama reports `draft_n` (tokens drafted) and
`draft_n_accepted` (tokens the target model kept). Acceptance rate is the number
to tune SPEC_DRAFT_N_MAX against: raise n-max while acceptance holds, stop when
the extra drafted tokens stop being accepted. Both fields are printed when the
server sends them, so the sweep below is a direct answer to "what draft length
should this model run at", rather than an inherited guess.
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
MAX_TOKENS = int(os.environ.get("BENCH_MAX_TOKENS", "256"))

# Deliberately code-shaped: this stack serves a coding agent, and tokenizer
# behaviour on prose is not what it will meet in practice.
WORDS = [
    "function", "def", "class", "return", "import", "data", "process",
    "value", "result", "config", "module", "handler", "compute",
    "validate", "transform", "execute", "initialize", "finalize",
    "error", "success", "request", "response", "argument", "parameter",
]


def build_prompt(approx_tokens: int, nonce: str) -> str:
    """~1 token per word for a code-tuned tokenizer, plus a unique prefix.

    The nonce goes FIRST. A prefix cache matches from the start of the prompt,
    so a nonce at the end would let the whole body hit the cache and defeat the
    point of having one.
    """
    body = " ".join(WORDS[i % len(WORDS)] for i in range(max(1, approx_tokens - 16)))
    return f"Session {nonce}. Write a Python script that does the following: {body}"


def post(payload: dict) -> tuple[int, dict, float]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{LLAMA_URL}/v1/chat/completions",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.loads(resp.read().decode())
            return resp.status, body, time.monotonic() - started
    except urllib.error.HTTPError as exc:
        return exc.code, {"error": exc.read().decode()[:400]}, time.monotonic() - started
    except Exception as exc:  # noqa: BLE001 - report, do not crash the sweep
        return 0, {"error": f"{type(exc).__name__}: {exc}"}, time.monotonic() - started


def bench_one(approx_tokens: int, run_index: int) -> dict:
    nonce = f"{os.getpid()}-{run_index}-{time.time_ns()}"
    payload = {
        "model": MODEL_ALIAS,
        "messages": [{"role": "user", "content": build_prompt(approx_tokens, nonce)}],
        "max_tokens": MAX_TOKENS,
        "stream": False,
    }
    status, body, wall = post(payload)
    row: dict = {"requested": approx_tokens, "status": status, "wall_s": round(wall, 2)}

    if status != 200:
        row["error"] = body.get("error", "")
        return row

    t = body.get("timings") or {}
    if not t:
        # Not fatal, but say so loudly rather than silently falling back to the
        # wall-clock arithmetic this script exists to stop doing.
        row["error"] = ("no `timings` block in the response — talking to forge "
                        "instead of llama, or an engine that does not report it")
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
        row["draft_acceptance"] = round(accepted / draft_n, 3) if draft_n else None
    return row


def fmt(row: dict) -> str:
    if row.get("error"):
        return (f"  pp={row['requested']:<6} status={row['status']:<4} "
                f"ERROR {row['error']}")
    flag = "  CACHED (excluded)" if row.get("cached") else ""
    draft = ""
    if row.get("draft_n"):
        draft = (f" draft={row['draft_accepted']}/{row['draft_n']} "
                 f"({row['draft_acceptance']:.0%} accepted)")
    return (f"  pp={row['requested']:<6} "
            f"prompt={row.get('prompt_n', 0):<6} "
            f"prefill={row.get('prompt_tps') or 0:>8.1f} tok/s  "
            f"decode={row.get('predicted_tps') or 0:>6.1f} tok/s  "
            f"wall={row['wall_s']:>6.2f}s{draft}{flag}")


def main() -> int:
    args = sys.argv[1:]
    prompt_len = 1024
    sweep = [prompt_len]
    repeat = 1

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--prompt-len":
            prompt_len = int(args[i + 1]); sweep = [prompt_len]; i += 2
        elif a == "--full":
            sweep = [256, 512, 1024, 2048, 4096, 8192, 16384]; i += 1
        elif a == "--repeat":
            repeat = int(args[i + 1]); i += 2
        elif a in ("-h", "--help"):
            print(__doc__)
            return 0
        else:
            print(f"unknown argument: {a}", file=sys.stderr)
            return 2

    print(f"\nbench — {MODEL_ALIAS} via {LLAMA_URL}")
    print("prefill and decode rates come from llama's own timings block; "
          "each prompt carries a unique nonce\n")

    rows = []
    run_index = 0
    for n in sweep:
        for _ in range(repeat):
            run_index += 1
            row = bench_one(n, run_index)
            rows.append(row)
            print(fmt(row), flush=True)

    usable = [r for r in rows if not r.get("error") and not r.get("cached")]
    print()
    if not usable:
        print("no usable rows — every run errored or hit the prompt cache")
        return 1

    best_pp = max(r["prompt_tps"] or 0 for r in usable)
    best_tg = max(r["predicted_tps"] or 0 for r in usable)
    print(f"best prefill: {best_pp:.1f} tok/s     best decode: {best_tg:.1f} tok/s")

    drafted = [r for r in usable if r.get("draft_n")]
    if drafted:
        total_d = sum(r["draft_n"] for r in drafted)
        total_a = sum(r["draft_accepted"] for r in drafted)
        print(f"MTP draft acceptance: {total_a}/{total_d} = {total_a / total_d:.1%} "
              f"across {len(drafted)} run(s)")
        print("Sweep SPEC_DRAFT_N_MAX in .env and re-run: raise it while decode "
              "improves, stop when acceptance stops paying for the extra drafts.")
    else:
        print("no draft counters in timings — SPEC_TYPE is off, or this GGUF has "
              "no MTP head (block_count must be 65, not 64)")

    print(json.dumps({"model": MODEL_ALIAS, "rows": rows}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
