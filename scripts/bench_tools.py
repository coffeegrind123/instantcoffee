#!/usr/bin/env python3
"""Tool-count benchmark: what a large `tools` array costs at decode time.

Runs INSIDE the compose network, like bench.py and bench_repeat.py:

    docker compose --profile tools run --rm --build \
        --entrypoint python bench /work/scripts/bench_tools.py --repeat 3

WHY THE OTHER TWO BENCHES CANNOT MEASURE THIS
---------------------------------------------
Neither bench.py nor bench_repeat.py sends a `tools` array at all — checked,
with a control: grepping for `"tools"` across scripts/ DOES hit smoke_test.py,
bench_literal.py and ab_think_lang.py, so the absence in the two throughput
benches is real and not a broken search.

That matters because llama.cpp builds its tool-call grammar FROM the tools in
the request. With no tools there is no grammar, no triggers, and nothing for a
trigger-cost change to move. Running either bench against a build that changed
trigger handling returns a flat row, and a flat row would read as "the change
does nothing" when the truth is "the instrument cannot see it". That is a false
negative with a confident face on it, which is exactly the failure bench_repeat
was written to avoid for ngram-simple.

WHAT IT MEASURES
----------------
Decode throughput as a function of the NUMBER OF TOOL SCHEMAS in the request,
with the model answering in prose rather than calling anything. The tools are
present, `tool_choice` is "auto", so the grammar and its triggers are live for
every sampled token — but the tokens being sampled are ordinary text, so what
the row shows is the standing cost of carrying the tool grammar.

The engine fact this exists to track, read from source at b10689 rather than
assumed (common/chat.cpp, common_chat_params_init_qwen3_coder):

    auto is_qwen3_coder = !supports_reasoning;
    ...
    if (is_qwen3_coder) {
        foreach_function(inputs.tools, [&](const json & tool) {
            const std::string name = tool.at("function").at("name");
            tool_call_starts.push_back("<function=" + name + ">");
        });
    }

Before #27679 that loop ran unconditionally, so every tool in the request added
one more trigger string. Qwen3.8 reaches this function (the dispatch needs
`<tool_call>` + `<function=` + `<parameter=` in the template) with
supports_reasoning TRUE (the template contains `<think>`), so on b10689 the
per-tool triggers are gone and on b10573 they are not. Both facts were probed
off the Hub against this stack's actual GGUFs before this file was written.

THE CONTROLS, WHICH ARE THE POINT
---------------------------------
A tool-count curve that only reports tok/s can be fooled three ways, so each is
checked rather than hoped for:

  1. THE ZERO-TOOL ARM. `--counts 0,...` always includes 0 unless you remove it.
     No tools means no grammar, so #27679 cannot touch that row. If a build
     comparison moves the 0 arm, the difference is something else — a different
     model, a different context, a busy box — and the tool-count arms cannot be
     read as a trigger result. This is the arm that makes the rest interpretable.

  2. THE MODEL MIGHT CALL A TOOL. Then it emits a handful of argument tokens
     instead of prose, decode is measured over almost nothing, and the number is
     noise. Every row reports `tool_called`, and a row with it set is excluded
     from the summary rather than averaged in.

  3. THE PREFIX CACHE. A cached prompt makes prefill fiction and shortens the
     run. The nonce goes FIRST in the prompt, because the cache matches from the
     start (same reason as bench.py and bench_repeat.py), and `cache_n` is
     reported on every row.

A fourth, learned from llama.cpp#27342 this week: the FIRST generation after a
model load runs ~10% slow, and a reporter there spent a day bisecting a "13%
regression" that was entirely this. `--warmup` requests are issued and discarded
before any row is kept.

A fifth, which the ballast arm invites and which was CHECKED rather than argued
away: the filler is one sentence repeated, so it is maximally n-gram-friendly,
and if ngram-simple drafted the OUTPUT out of it the ballast arm would be
flattered and the grammar cost overstated. Measured at b10689, n=9, draft
acceptance by arm — control 0.607, ballast≈15 0.616, ballast≈100 0.517,
tools=15 0.542, tools=100 0.578. The ballast arms are not systematically higher;
the one matching 100 tools is the LOWEST of the five and still decoded faster
than its tools counterpart. So the effect is not the filler. Every row carries
`draft_acceptance`, so this stays checkable rather than becoming folklore.

Usage:
    bench_tools.py [--counts 0,5,15,40,100] [--repeat 3] [--max-tokens 512]
                   [--warmup 1] [--json-only]
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama:8080").rstrip("/")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")
TIMEOUT = float(os.environ.get("BENCH_TIMEOUT", "900"))

# Deliberately mundane, and deliberately DISTINCT per index: the thing under
# test is one trigger per tool NAME, so N tools must mean N different names.
# Shapes are modelled on what pi actually puts on the wire (a verb_noun name, a
# one-line description, two or three scalar properties).
_VERBS = ("read", "write", "list", "search", "fetch", "update", "delete",
          "create", "inspect", "render", "compile", "resolve")
_NOUNS = ("file", "record", "index", "buffer", "session", "artifact",
          "manifest", "snapshot", "fragment", "channel", "profile", "token")


def build_tools(n: int, salt: str = "") -> list[dict]:
    """N tool schemas with N DISTINCT names.

    `salt` goes into every name because the tools block renders AHEAD of the
    user message in the chat template, so a nonce in the message does not stop
    the tools prefix being served from the prefix cache. Measured before this
    was added: cache_n reached 10603 on the 100-tool arm. Salting the names is
    what actually defeats it, and it costs nothing else — the thing under test
    is one trigger per distinct name, which is preserved.
    """
    tools = []
    for i in range(n):
        verb = _VERBS[i % len(_VERBS)]
        noun = _NOUNS[(i // len(_VERBS)) % len(_NOUNS)]
        name = f"{verb}_{noun}_{i}{salt}"
        tools.append({
            "type": "function",
            "function": {
                "name": name,
                "description": f"{verb.capitalize()} the {noun} identified by its path or id.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Target path."},
                        "offset": {"type": "integer", "description": "Start offset."},
                        "limit": {"type": "integer", "description": "Maximum items."},
                    },
                    "required": ["path"],
                },
            },
        })
    return tools


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
    except Exception as exc:  # noqa: BLE001 - report, never crash a sweep
        return 0, {"error": f"{type(exc).__name__}: {exc}"}, time.monotonic() - started


# Long enough that decode dominates, and phrased so the model answers in prose.
# It must NOT look like a job for any of the generated tools, or arm 2 above
# fires constantly and the run measures nothing.
_TASK = (
    "Explain, in careful prose and without any code, why speculative decoding "
    "cannot change the text a language model produces. Cover: what the draft "
    "model proposes, what the target model verifies, why a rejected draft "
    "token costs time but not correctness, and why this differs from "
    "quantisation, which does change the distribution. Write at least six "
    "full paragraphs. Do not use bullet points and do not call any function."
)


_FILLER_SENTENCE = (
    "The archivist recorded each measurement in the ledger, noting the "
    "instrument, the ambient conditions, and the name of the observer who "
    "took the reading, so that a later reader could tell a result apart from "
    "an assumption about one. "
)


def tokenize(text: str) -> int | None:
    """Model-token count via /tokenize, or None if the endpoint is unavailable.

    None is propagated rather than replaced with a word count: the ballast arm
    exists to MATCH a token depth, and matching it against a guess would defeat
    the control while still printing a number.
    """
    status, body, _ = post("/tokenize", {"content": text})
    if status == 200 and isinstance(body.get("tokens"), list):
        return len(body["tokens"])
    return None


def build_ballast(target_tokens: int) -> tuple[str, int | None]:
    """Inert prose of approximately `target_tokens` model tokens.

    THE POINT OF THIS ARM. A 100-tool request carries thousands of extra prompt
    tokens, and this stack has already measured decode falling with context
    depth (versions.lock, depth_ppl). So a tools-only curve confounds two
    effects: the cost of the TOOL GRAMMAR and the cost of the DEPTH the schemas
    add. Comparing tools=N against a no-tools request padded to the same depth
    isolates the grammar, which is the only part #27679 touches.
    """
    if target_tokens <= 0:
        return "", 0
    per = tokenize(_FILLER_SENTENCE)
    if not per:
        return _FILLER_SENTENCE * max(1, target_tokens // 40), None
    text = _FILLER_SENTENCE * max(1, round(target_tokens / per))
    return text, tokenize(text)


def bench_one(n_tools: int, max_tokens: int, run_index: int,
              ballast_tokens: int = 0) -> dict:
    nonce = f"{os.getpid()}-{n_tools}-{run_index}-{time.time_ns()}"
    salt = f"_{run_index}_{time.time_ns() % 1_000_000}"

    content = f"Session {nonce}.\n\n{_TASK}"
    ballast_n = 0
    if ballast_tokens > 0:
        pad, ballast_n = build_ballast(ballast_tokens)
        content = (f"Session {nonce}.\n\nBackground notes (ignore them):\n"
                   f"{pad}\n\n{_TASK}")

    payload = {
        "model": MODEL_ALIAS,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": False,
    }
    if n_tools:
        payload["tools"] = build_tools(n_tools, salt)
        payload["tool_choice"] = "auto"

    status, body, wall = post("/v1/chat/completions", payload)
    row: dict = {"n_tools": n_tools, "status": status, "wall_s": round(wall, 2)}
    if ballast_tokens > 0:
        row["arm"] = "ballast"
        row["ballast_target"] = ballast_tokens
        row["ballast_tokens"] = ballast_n
    else:
        row["arm"] = "tools" if n_tools else "control"

    if status != 200:
        row["error"] = str(body.get("error", ""))[:300]
        return row

    t = body.get("timings") or {}
    if not t:
        row["error"] = ("no `timings` block in the response — talking to forge "
                        "instead of llama, or an engine that does not report it")
        return row

    row["prompt_n"] = t.get("prompt_n")
    row["prompt_tps"] = t.get("prompt_per_second")
    row["predicted_n"] = t.get("predicted_n")
    row["predicted_tps"] = t.get("predicted_per_second")
    row["cache_n"] = t.get("cache_n")

    draft_n = t.get("draft_n")
    if draft_n:
        accepted = t.get("draft_n_accepted", 0)
        row["draft_n"] = draft_n
        row["draft_accepted"] = accepted
        row["draft_acceptance"] = round(accepted / draft_n, 3)

    try:
        msg = body["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        msg = {}
    # Control 2: a tool call means decode was measured over argument tokens.
    if msg.get("tool_calls"):
        row["tool_called"] = True
        row["tool_names"] = [c.get("function", {}).get("name")
                             for c in msg["tool_calls"]][:4]
    return row


def usable(row: dict) -> bool:
    return (not row.get("error")) and (not row.get("tool_called")) \
        and isinstance(row.get("predicted_tps"), (int, float))


def fmt(row: dict) -> str:
    if row.get("error"):
        lbl = (f"ballast≈{row.get('matches_n_tools', '?')}"
               if row.get("arm") == "ballast" else f"tools={row['n_tools']}")
        return f"  {lbl:<11} status={row['status']:<4} ERROR {row['error']}"
    flags = []
    if row.get("tool_called"):
        flags.append(f"TOOL-CALLED {row.get('tool_names')}")
    if row.get("cache_n"):
        flags.append(f"cache_n={row['cache_n']}")
    acc = f" acc={row['draft_acceptance']}" if "draft_acceptance" in row else ""
    # A ballast row carries n_tools=0 by construction, so labelling it by tool
    # count alone would make it indistinguishable from the control arm in this
    # log — the two mean opposite things and must not read the same.
    if row.get("arm") == "ballast":
        label = f"ballast≈{row.get('matches_n_tools', '?')}"
    else:
        label = f"tools={row['n_tools']}"
    return (f"  {label:<11} "
            f"prefill={row.get('prompt_tps', 0):>8.1f} "
            f"decode={row.get('predicted_tps', 0):>7.2f} "
            f"out={row.get('predicted_n', 0):>5}{acc}"
            + ("  " + " ".join(flags) if flags else ""))


def main() -> int:
    counts = [0, 5, 15, 40, 100]
    repeat, max_tokens, warmup, json_only = 3, 512, 1, False

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--counts":
            counts = [int(x) for x in args[i + 1].split(",") if x.strip() != ""]; i += 2
        elif a == "--repeat":
            repeat = int(args[i + 1]); i += 2
        elif a == "--max-tokens":
            max_tokens = int(args[i + 1]); i += 2
        elif a == "--warmup":
            warmup = int(args[i + 1]); i += 2
        elif a == "--json-only":
            json_only = True; i += 1
        elif a in ("-h", "--help"):
            print(__doc__)
            return 0
        else:
            print(f"unknown argument: {a} (try --help)", file=sys.stderr)
            return 2

    if 0 not in counts:
        print("[warn] no zero-tool arm: without it a build comparison has no "
              "control and the tool-count rows cannot be attributed to the "
              "tool grammar. Add 0 to --counts unless you know why not.",
              file=sys.stderr)

    out = sys.stderr if json_only else sys.stdout
    print(f"tool-count bench — {LLAMA_URL}, model {MODEL_ALIAS}", file=out)
    print(f"  counts={counts} repeat={repeat} max_tokens={max_tokens} "
          f"warmup={warmup}", file=out)

    # Control 4: discard the first generation(s) after a load.
    for w in range(warmup):
        print(f"  warmup {w + 1}/{warmup} (discarded) ...", file=out)
        bench_one(counts[0], max_tokens, -1 - w)

    rows: list[dict] = []
    depth: dict[int, float] = {}   # n_tools -> median prompt_n of that arm
    for n in counts:
        print(f"\ntools={n}", file=out)
        got = []
        for r in range(repeat):
            row = bench_one(n, max_tokens, r)
            rows.append(row)
            print(fmt(row), file=out)
            if isinstance(row.get("prompt_n"), (int, float)):
                got.append(row["prompt_n"])
        if got:
            depth[n] = statistics.median(got)

    # The depth-matched control. For every tool arm, a no-tools request padded
    # to the same prompt depth. Whatever remains between the two is the tool
    # grammar; whatever they share is the depth.
    base_depth = depth.get(0)
    if base_depth is None:
        print("\n[warn] no usable zero-tool arm, so no ballast arms can be "
              "sized — skipping the depth control.", file=out)
    else:
        for n in counts:
            if n == 0 or n not in depth:
                continue
            extra = int(round(depth[n] - base_depth))
            if extra < 50:
                print(f"\nballast for tools={n}: skipped, only {extra} extra "
                      f"tokens to match", file=out)
                continue
            print(f"\nballast≈tools={n}  (+{extra} tokens, no tools)", file=out)
            for r in range(repeat):
                row = bench_one(0, max_tokens, r, ballast_tokens=extra)
                row["matches_n_tools"] = n
                rows.append(row)
                print(fmt(row), file=out)

    summary = {}
    for n in counts:
        good = [x["predicted_tps"] for x in rows
                if x["n_tools"] == n and x.get("arm") != "ballast" and usable(x)]
        kept = [x for x in rows
                if x["n_tools"] == n and x.get("arm") != "ballast"]
        summary[str(n)] = {
            "runs": len(kept),
            "usable": len(good),
            "excluded_tool_called": sum(1 for x in kept if x.get("tool_called")),
            "excluded_error": sum(1 for x in kept if x.get("error")),
            "decode_mean": round(statistics.mean(good), 2) if good else None,
            "decode_median": round(statistics.median(good), 2) if good else None,
            "decode_min": round(min(good), 2) if good else None,
            "decode_max": round(max(good), 2) if good else None,
        }

    print("\nsummary — decode tok/s by tool count", file=out)
    base = summary.get("0", {}).get("decode_median")
    for n in counts:
        s = summary[str(n)]
        if s["decode_median"] is None:
            print(f"  tools={n:<4} no usable runs "
                  f"({s['excluded_tool_called']} tool-called, "
                  f"{s['excluded_error']} errored)", file=out)
            continue
        rel = ""
        if base and n != 0:
            rel = f"  ({s['decode_median'] / base * 100:5.1f}% of the 0-tool arm)"
        print(f"  tools={n:<4} median={s['decode_median']:>7.2f} "
              f"mean={s['decode_mean']:>7.2f} "
              f"n={s['usable']}/{s['runs']}{rel}", file=out)

    if base is None:
        print("\n[warn] the zero-tool control produced no usable run, so the "
              "rows above are not interpretable as a tool-grammar cost.",
              file=out)

    # The isolated result. Same prompt depth on both sides, tools on one.
    ballast_summary = {}
    print("\ngrammar cost, depth-matched — tools=N against no-tools padded to "
          "the same depth", file=out)
    any_pair = False
    for n in counts:
        if n == 0:
            continue
        t = [x["predicted_tps"] for x in rows
             if x["n_tools"] == n and x.get("arm") == "tools" and usable(x)]
        b = [x["predicted_tps"] for x in rows
             if x.get("arm") == "ballast" and x.get("matches_n_tools") == n
             and usable(x)]
        if not t or not b:
            continue
        any_pair = True
        tm, bm = statistics.median(t), statistics.median(b)
        td = statistics.median([x["prompt_n"] for x in rows
                                if x["n_tools"] == n and x.get("arm") == "tools"
                                and isinstance(x.get("prompt_n"), (int, float))])
        bd = statistics.median([x["prompt_n"] for x in rows
                                if x.get("arm") == "ballast"
                                and x.get("matches_n_tools") == n
                                and isinstance(x.get("prompt_n"), (int, float))])
        ballast_summary[str(n)] = {
            "tools_decode_median": round(tm, 2),
            "ballast_decode_median": round(bm, 2),
            "tools_prompt_n": td, "ballast_prompt_n": bd,
            "depth_delta": round(td - bd, 1),
            "grammar_ratio": round(tm / bm, 4) if bm else None,
        }
        print(f"  tools={n:<4} tools={tm:>7.2f}  ballast={bm:>7.2f}  "
              f"ratio={tm / bm * 100:5.1f}%   "
              f"(depth {int(td)} vs {int(bd)})", file=out)
    if not any_pair:
        print("  no comparable pairs — nothing can be attributed to the "
              "grammar from this run.", file=out)

    print(file=out)
    print(json.dumps({"workload": "tools", "rows": rows, "summary": summary,
                      "grammar_cost": ballast_summary,
                      "counts": counts, "repeat": repeat,
                      "max_tokens": max_tokens, "warmup": warmup}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
