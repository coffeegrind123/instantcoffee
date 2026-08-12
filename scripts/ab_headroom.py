#!/usr/bin/env python3
"""A/B headroom compression against the same stack with compression bypassed.

Run inside the compose network:
    docker compose --profile headroom run --rm ab-headroom

Or directly against a running headroom:
    HEADROOM_URL=http://localhost:8787 python3 scripts/ab_headroom.py --repeat 2

Why this exists
---------------
headroom's published numbers — 92% on code search, "accuracy preserved" on GSM8K
and BFCL — were measured against frontier hosted models. This stack is a 27B at
4 bits with a 64K window whose own tools suite scores 0.73. Compression that a
frontier model shrugs off is not automatically free here, and the failure mode
is not an error: it is a model answering confidently from a view of the data
that no longer contains the answer.

There is a second, structural reason to measure rather than assume. headroom
sizes compression against the model's context window, looked up in LiteLLM's
model table. `qwen3.6-27b` is not in that table, so it falls back to a 128K
default — twice this stack's real window. Whatever it decides is "safe" is
being decided against the wrong number.

Both arms go through headroom, so the network path, the queueing and the
serialization are identical. The control arm sets `x-headroom-bypass: true`,
which headroom documents as the "do not touch my bytes" contract (see
headroom/proxy/compression_decision.py). The only difference between the arms
is whether compression ran.

What it measures
----------------
    quality    the same six objectively-scored tasks the think-lang A/B uses,
               so a regression in ordinary coding ability shows up
    recall     three tasks built specifically to be compressible: a large JSON
               tool result, a long log, and a long file read, each with one
               fact that has to survive. This is where compression can actually
               lose something, and short chat turns would never reveal it.
    cost       prompt tokens actually sent, wall time, and headroom's own
               x-headroom-tokens-* accounting

The recall tasks deliver their payload as a `tool` message, not as a user
message: headroom skips user messages by default, so a payload pasted into the
prompt would be measuring nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The six scored tasks, the transport and the scoring all come from the
# think-lang harness. Sharing them is the point: two copies of "is this model
# still good at editing code" would drift, and then the two A/Bs would stop
# being comparable to each other.
import ab_think_lang as ab  # noqa: E402

HEADROOM_URL = os.environ.get("HEADROOM_URL", "http://headroom:8787").rstrip("/")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "qwen3.6-27b")

BYPASS_HEADERS = {"x-headroom-bypass": "true"}

# Thinking is ON in these requests (ab_think_lang sends enable_thinking=True,
# which is what a pi session runs), and thinking tokens are completion tokens.
# A one-line answer therefore still needs headroom above REASONING_BUDGET, or
# the model spends the whole allowance reasoning and returns nothing — which
# would score zero in BOTH arms and read as "compression cost nothing".
RECALL_MAX_TOKENS = int(os.environ.get("AB_RECALL_MAX_TOKENS", "6144"))


# ── compressible payloads ──────────────────────────────────────────────────
#
# Generated rather than pasted, so the size is honest and the needle's position
# is known. Each one is shaped like something a coding agent actually reads.


def _json_payload(n: int = 220) -> str:
    """An API-shaped array of dicts — SmartCrusher's primary target."""
    rows = []
    for i in range(n):
        rows.append({
            "id": 1000 + i,
            "service": f"svc-{i % 12}",
            "region": ["us-east-1", "eu-west-2", "ap-south-1"][i % 3],
            "latency_ms": 40 + (i * 7) % 300,
            "status": "ok",
            "message": f"request {i} completed normally",
        })
    # The needle. Deliberately not at either end: headroom keeps 30% from the
    # start and 15% from the end, so an item planted there would survive by
    # position rather than by being retained on merit.
    rows[137] = {
        "id": 1137,
        "service": "billing-reconciler",
        "region": "eu-west-2",
        "latency_ms": 9412,
        "status": "error",
        "message": "PaymentLedgerMismatch: ledger drift of 4213 cents on batch B-7741",
    }
    return json.dumps({"results": rows}, indent=None)


def _log_payload(n: int = 600) -> str:
    """A long, boring log with one line that matters — headroom's own demo."""
    lines = []
    for i in range(n):
        lines.append(
            f"2026-08-12T09:{i // 60:02d}:{i % 60:02d}Z INFO  worker-{i % 8} "
            f"handled task {i} in {12 + i % 40}ms"
        )
    lines[402] = (
        "2026-08-12T09:06:42Z FATAL worker-3 unrecoverable: "
        "checkpoint segment 0x5F3A refused by store 'ledger-eu' (code 7741)"
    )
    return "\n".join(lines)


def _file_payload() -> str:
    """A long source file. Code is protected by default — this checks that the
    protection actually holds, which is a claim worth testing rather than
    trusting."""
    parts = [
        "# module: settlement/reconcile.py",
        "from __future__ import annotations",
        "",
    ]
    for i in range(90):
        parts += [
            f"def helper_{i}(batch, *, strict: bool = False):",
            f'    """Helper number {i}. Does something unremarkable."""',
            f"    total = sum(x.amount for x in batch if x.kind == {i})",
            "    if strict and total < 0:",
            "        raise ValueError('negative total')",
            "    return total",
            "",
        ]
    parts += [
        "def reconcile_ledger(batch, tolerance_cents: int = 25, *, "
        "ledger_id: str, dry_run: bool = True) -> ReconcileReport:",
        '    """The only function anyone calls from outside this module."""',
        "    return ReconcileReport(ledger_id=ledger_id, drift=0)",
        "",
    ]
    return "\n".join(parts)


def _tool_turn(tool_name: str, args: dict, result: str, question: str) -> list[dict]:
    """A user turn, a tool call, its (large) result, then the question.

    Shaped this way on purpose: headroom's ContentRouter skips user messages,
    so the payload has to arrive as a tool result to be a candidate for
    compression at all.
    """
    return [
        {"role": "user", "content": f"Use {tool_name} and then answer my question."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": tool_name, "arguments": json.dumps(args)},
            }],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": tool_name, "content": result},
        {"role": "user", "content": question},
    ]


# ── recall tasks ───────────────────────────────────────────────────────────
#
# Each returns (score, detail, reply), matching the think-lang task contract so
# both sets can run through the same arm runner.


def task_recall_json(_system: str | None = None):
    msgs = _tool_turn(
        "query_metrics",
        {"window": "1h"},
        _json_payload(),
        "Exactly one result has status 'error'. Reply with one line: "
        "'ANSWER: <service> <latency_ms>'.",
    )
    r = ab._ask_messages(msgs, max_tokens=RECALL_MAX_TOKENS)
    if r.error:
        return 0.0, r.error, r
    text = r.content or ""
    hit_service = "billing-reconciler" in text
    hit_latency = "9412" in text
    score = 1.0 if (hit_service and hit_latency) else (0.5 if hit_service else 0.0)
    return score, f"service={hit_service} latency={hit_latency}", r


def task_recall_log(_system: str | None = None):
    msgs = _tool_turn(
        "read_logs",
        {"path": "/var/log/worker.log"},
        _log_payload(),
        "There is exactly one FATAL line. Reply with one line: "
        "'ANSWER: <worker> <code>'.",
    )
    r = ab._ask_messages(msgs, max_tokens=RECALL_MAX_TOKENS)
    if r.error:
        return 0.0, r.error, r
    text = r.content or ""
    hit_worker = "worker-3" in text
    hit_code = "7741" in text
    score = 1.0 if (hit_worker and hit_code) else (0.5 if hit_code else 0.0)
    return score, f"worker={hit_worker} code={hit_code}", r


def task_recall_code(_system: str | None = None):
    msgs = _tool_turn(
        "read_file",
        {"path": "settlement/reconcile.py"},
        _file_payload(),
        "Reply with one line: 'ANSWER: ' followed by the full signature of "
        "reconcile_ledger, copied exactly.",
    )
    r = ab._ask_messages(msgs, max_tokens=RECALL_MAX_TOKENS)
    if r.error:
        return 0.0, r.error, r
    text = (r.content or "").replace(" ", "")
    have_name = "reconcile_ledger" in (r.content or "")
    have_default = "tolerance_cents:int=25" in text or "tolerance_cents=25" in text
    have_kwonly = "ledger_id" in text and "dry_run" in text
    score = 1.0 if (have_name and have_default and have_kwonly) else (
        0.5 if have_name and (have_default or have_kwonly) else
        0.2 if have_name else 0.0)
    return score, f"name={have_name} default={have_default} kwonly={have_kwonly}", r


RECALL_TASKS = [
    ("recall-json", task_recall_json),
    ("recall-log", task_recall_log),
    ("recall-code", task_recall_code),
]


# ── arms ───────────────────────────────────────────────────────────────────


def _int_header(reply, name: str) -> int:
    try:
        return int(reply.headers.get(name, "") or 0)
    except (TypeError, ValueError):
        return 0


def run_arm(name: str, headers: dict, tasks: list, repeat: int) -> dict:
    ab.REQUEST_HEADERS = dict(headers)
    rows: list[dict] = []
    label = "compressed" if not headers else "bypassed"
    print(f"\n── arm: {name} ({label}) ──", flush=True)

    for i in range(repeat):
        if repeat > 1:
            print(f"  pass {i + 1}/{repeat}", flush=True)
        for task_name, fn in tasks:
            score, detail, reply = fn(None)
            rows.append({
                "task": task_name,
                "pass": i + 1,
                "score": score,
                "detail": detail,
                "seconds": round(reply.seconds, 2),
                "prompt_tokens": reply.prompt_tokens,
                "completion_tokens": reply.completion_tokens,
                # headroom's own accounting. Zero on the bypass arm, which is
                # itself the check that the bypass header did what it claims.
                "hr_before": _int_header(reply, "x-headroom-tokens-before"),
                "hr_after": _int_header(reply, "x-headroom-tokens-after"),
                "hr_saved": _int_header(reply, "x-headroom-tokens-saved"),
                "hr_transforms": reply.headers.get("x-headroom-transforms", ""),
                "hr_failed": reply.headers.get("x-headroom-compression-failed", ""),
                "error": reply.error,
            })
            print(f"    [{score:.2f}] {task_name:<12} {reply.seconds:6.1f}s  "
                  f"prompt={reply.prompt_tokens:>6}  {detail[:56]}", flush=True)

    ab.REQUEST_HEADERS = {}
    return {"name": name, "rows": rows}


def _mean(v: list[float]) -> float:
    return statistics.fmean(v) if v else 0.0


def summarize(arm: dict, task_names: list[str]) -> dict:
    rows = arm["rows"]
    return {
        "name": arm["name"],
        "n": len(rows),
        "score": round(_mean([r["score"] for r in rows]), 3),
        "seconds": round(_mean([r["seconds"] for r in rows]), 2),
        "prompt_tokens": round(_mean([r["prompt_tokens"] for r in rows]), 1),
        "completion_tokens": round(_mean([r["completion_tokens"] for r in rows]), 1),
        "hr_before": sum(r["hr_before"] for r in rows),
        "hr_after": sum(r["hr_after"] for r in rows),
        "hr_saved": sum(r["hr_saved"] for r in rows),
        "compression_failures": sum(1 for r in rows if r["hr_failed"]),
        "errors": sum(1 for r in rows if r["error"]),
        "transforms": sorted({t for r in rows for t in
                              (r["hr_transforms"].split(",") if r["hr_transforms"] else [])}),
        "per_task": {
            t: round(_mean([r["score"] for r in rows if r["task"] == t]), 3)
            for t in task_names
        },
    }


def verdict(base: dict, test: dict, min_delta: float,
            recall_names: list[str]) -> tuple[str, int]:
    """(text, exit code). Non-zero means do not route pi through headroom."""
    if test["errors"] > base["errors"]:
        return ("REJECT — the compressed arm produced more request errors "
                f"({test['errors']} vs {base['errors']}). Compression is "
                "breaking requests, not shrinking them.", 1)

    d_score = test["score"] - base["score"]

    # Recall is judged separately and more harshly than the average. A drop
    # here is the specific thing compression can cost you, and it averages away
    # against six tasks that were never compressible in the first place.
    base_recall = _mean([base["per_task"][t] for t in recall_names])
    test_recall = _mean([test["per_task"][t] for t in recall_names])
    d_recall = test_recall - base_recall

    saved = base["prompt_tokens"] - test["prompt_tokens"]
    saved_pct = (saved / base["prompt_tokens"] * 100) if base["prompt_tokens"] else 0.0

    head = (f"prompt tokens {base['prompt_tokens']:.0f} -> "
            f"{test['prompt_tokens']:.0f} ({saved_pct:+.1f}%), "
            f"score {base['score']:.3f} -> {test['score']:.3f} ({d_score:+.3f}), "
            f"recall {base_recall:.3f} -> {test_recall:.3f} ({d_recall:+.3f}), "
            f"wall {base['seconds']:.1f}s -> {test['seconds']:.1f}s.")

    if test["hr_before"] == 0 and test["hr_after"] == 0:
        return (f"{head} INCONCLUSIVE — headroom reported no token accounting on "
                "the compressed arm, so nothing proves compression ran at all. "
                "Check that HEADROOM_URL points at headroom and not straight at "
                "forge.", 1)

    # A recall comparison where neither arm could answer is not evidence that
    # compression is harmless — it is evidence that the tasks did not work. Say
    # so, rather than let a dead heat at zero read as a pass.
    if base_recall < 0.2:
        return (f"{head} INCONCLUSIVE — the control arm scored {base_recall:.2f} "
                "on recall, so the tasks are failing before compression is even "
                "a factor. Check REASONING_BUDGET against AB_RECALL_MAX_TOKENS "
                f"(currently {RECALL_MAX_TOKENS}) and look at the per-task rows.",
                1)

    if d_recall < -min_delta:
        return (f"{head} REJECT — recall dropped by more than {min_delta:.2f}. "
                "The model answered from a view of the data that no longer had "
                "the answer in it. Lower HEADROOM_TARGET_RATIO, or stay on "
                "HEADROOM_RECOVERY=lossless.", 1)
    if d_score < -min_delta:
        return (f"{head} REJECT — overall quality dropped by more than "
                f"{min_delta:.2f}.", 1)
    if saved_pct < 5:
        return (f"{head} NO CHANGE — under 5% of prompt tokens saved on this "
                "workload. Another hop in the path is not worth that. Leave "
                "HEADROOM_ENABLED=0.", 0)
    return (f"{head} ADOPT — quality and recall held within the noise band of "
            f"{min_delta:.2f} and the saving is real. Set HEADROOM_ENABLED=1 "
            "in .env.", 0)


def table(base: dict, test: dict, task_names: list[str]) -> str:
    def row(label: str, key: str, fmt: str = "{}") -> str:
        return f"| {label} | {fmt.format(base[key])} | {fmt.format(test[key])} |"

    lines = [
        "",
        "| metric | bypassed | compressed |",
        "| --- | --- | --- |",
        row("mean score", "score", "{:.3f}"),
        row("mean prompt tokens", "prompt_tokens", "{:.0f}"),
        row("mean completion tokens", "completion_tokens", "{:.1f}"),
        row("mean seconds", "seconds", "{:.2f}"),
        row("headroom tokens before", "hr_before"),
        row("headroom tokens after", "hr_after"),
        row("headroom tokens saved", "hr_saved"),
        row("compression failures", "compression_failures"),
        row("request errors", "errors"),
        "",
        "| task | bypassed | compressed |",
        "| --- | --- | --- |",
    ]
    for t in task_names:
        lines.append(f"| {t} | {base['per_task'][t]:.2f} | {test['per_task'][t]:.2f} |")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="A/B headroom compression against the same stack bypassed.")
    ap.add_argument("--repeat", type=int, default=2,
                    help="passes per arm; sampling is stochastic (default: 2)")
    ap.add_argument("--min-delta", type=float, default=0.05,
                    help="score difference treated as noise (default: 0.05)")
    ap.add_argument("--recall-only", action="store_true",
                    help="skip the six general tasks; only run the compressible ones")
    ap.add_argument("--json", dest="json_out", default="",
                    help="also write the full result to this path")
    args = ap.parse_args()

    # Both arms talk to headroom. The think-lang harness sends every request to
    # its module-level FORGE_URL, so pointing that at headroom is what puts the
    # compressor in the path for the shared tasks too.
    ab.FORGE_URL = HEADROOM_URL

    tasks = list(RECALL_TASKS) if args.recall_only else [*ab.TASKS, *RECALL_TASKS]
    task_names = [t for t, _ in tasks]
    recall_names = [t for t, _ in RECALL_TASKS]

    print("=" * 68)
    print(f"headroom A/B — {MODEL_ALIAS} via {HEADROOM_URL}")
    print(f"repeat: {args.repeat}   tasks: {len(tasks)}   "
          f"requests: {2 * args.repeat * len(tasks)}")
    print("both arms go through headroom; the control arm sends x-headroom-bypass")
    print("=" * 68)

    base_arm = run_arm("bypass", BYPASS_HEADERS, tasks, args.repeat)
    test_arm = run_arm("headroom", {}, tasks, args.repeat)

    base = summarize(base_arm, task_names)
    test = summarize(test_arm, task_names)

    print("\n" + "=" * 68)
    print(table(base, test, task_names))
    if test["transforms"]:
        print(f"\ntransforms applied: {', '.join(test['transforms'])}")

    text, code = verdict(base, test, args.min_delta, recall_names)
    print(f"\nVERDICT: {text}\n")

    payload = {
        "model": MODEL_ALIAS,
        "headroom_url": HEADROOM_URL,
        "repeat": args.repeat,
        "min_delta": args.min_delta,
        "bypass": base,
        "headroom": test,
        "verdict": text,
        "rows": {"bypass": base_arm["rows"], "headroom": test_arm["rows"]},
    }
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"wrote {args.json_out}")
    else:
        print("```json")
        print(json.dumps({k: v for k, v in payload.items() if k != "rows"}, indent=2))
        print("```")

    return code


if __name__ == "__main__":
    sys.exit(main())
