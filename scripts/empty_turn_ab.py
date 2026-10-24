#!/usr/bin/env python3
"""Does a sampler change make the model stop returning empty answers?

    python empty_turn_ab.py --arm base: --arm fp03:frequency_penalty=0.3 --rounds 40
    python empty_turn_ab.py --workload tape --tape /captures/x.jsonl --min-prompt-tokens 85000 ...
    python empty_turn_ab.py --self-test

THE FAILURE
-----------
QwenLM/Qwen3.8#216: HTTP 200, `finish_reason: "stop"`, empty `content`, and
the reasoning spent. tryingET's logprobs reading: `<|im_end|>` sits in the
top-2 inside `<think>` for thousands of steps and then gets sampled, a per-token
hazard. Long, near-identical enumeration in the reasoning triggers it at close
to 100% even at `medium`, on upstream llama.cpp Q8_0 among others. The thread's
best mitigation is `frequency_penalty: 0.3` (0 of 12, which decides nothing).

llama.cpp's reasoning-budget sampler cannot catch it: at b11118
`common_reasoning_budget_apply` returns without touching the logits unless the
budget is already exhausted, so an EOS sampled inside `<think>` below
REASONING_BUDGET goes straight through.

THE DESIGN
----------
- **Straight to llama, never through forge.** forge retries an empty response
  with a nudge, which is right in production and hides exactly the event this
  counts.
- **The stack's real server-side settings.** Effort and reasoning budget are
  launch flags; this script only overrides per-request sampler fields, so the
  arms differ in the override and nothing else.
- **Paired rounds.** Every arm sees the identical prompt in a round, in a
  shuffled order (seeded), so content and time-of-day drift land on both arms.
- **Two workloads.** `enum` builds the trigger synthetically: a list of
  near-identical records and an instruction to check each one in turn.
  `tape` replays gap-free records from a capture tape at a fill band; a record
  with declared gaps (an imported pi transcript has no system prompt or tool
  schemas) is refused, because replaying it measures a prompt the model never
  saw.
- **Raw evidence.** Every response is written to --out as JSONL; the summary
  is computed from that file's records, not from counters kept on the side.

An answer is EMPTY when `content` is blank and there are no tool calls. The
record also keeps reasoning length, completion tokens and finish_reason, so an
EOS-inside-think stop can be told apart from a budget-forced close that then
produced nothing.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from dataclasses import dataclass, field

DEFAULT_TIMEOUT = 900.0

# Sampler fields an arm may set. Anything else is refused: a typo such as
# `frequency_penatly=0.3` would otherwise be silently ignored by the server and
# the A/B would be an A/A test reported as a null result.
ARM_KEYS = {
    "temperature": float,
    "top_p": float,
    "top_k": int,
    "min_p": float,
    "presence_penalty": float,
    "frequency_penalty": float,
    "repeat_penalty": float,
    "repeat_last_n": int,
    "dry_multiplier": float,
}


@dataclass(frozen=True)
class Arm:
    name: str
    overrides: dict = field(default_factory=dict)


def parse_arm(spec: str) -> Arm:
    """`name:key=val,key=val`; `name:` alone is the server's own settings."""
    if ":" not in spec:
        raise ValueError(f"arm '{spec}' must look like name:key=val[,key=val] (or 'name:' for no override)")
    name, _, rest = spec.partition(":")
    if not name or not name.replace("_", "").replace("-", "").isalnum():
        raise ValueError(f"arm name '{name}' must be alphanumeric")
    overrides = {}
    for kv in filter(None, rest.split(",")):
        key, eq, val = kv.partition("=")
        if not eq:
            raise ValueError(f"arm '{name}': '{kv}' is not key=val")
        if key not in ARM_KEYS:
            raise ValueError(f"arm '{name}': '{key}' is not a sampler field this script allows ({', '.join(sorted(ARM_KEYS))})")
        overrides[key] = ARM_KEYS[key](val)
    return Arm(name=name, overrides=overrides)


# --- the enum workload ------------------------------------------------------------

def build_enum_prompt(items: int, seed: int) -> tuple[str, list[int]]:
    """Near-identical records with a few planted mismatches, and a per-item check.

    Returns (prompt, the 1-based indices of the mismatched records). The
    mismatches give the task a real answer, so a model that answers is doing the
    work rather than refusing it; the near-identical rows are what drives the
    enumeration-shaped reasoning the failure needs.
    """
    rng = random.Random(seed)
    bad = sorted(rng.sample(range(1, items + 1), k=max(3, items // 40)))
    regions = ("eu-west-1", "eu-west-2", "us-east-1", "us-east-2")
    lines = []
    for i in range(1, items + 1):
        port = 8000 + i
        if i in bad:
            port += rng.choice((1, -1, 10, 100))
        lines.append(f"node-{i:04d}  port={port}  region={regions[i % 4]}  status=ok  build=7.3.{seed % 97}")
    prompt = (
        f"Audit run {seed}. Below are {items} node records. The rule: a node's port must be "
        "exactly 8000 plus its node number (node-0042 must have port=8042).\n\n"
        + "\n".join(lines)
        + "\n\nCheck every record one at a time, in order, against the rule. "
        "Then reply with ONLY the node names that break it, comma-separated."
    )
    return prompt, bad


# --- the tape workload -------------------------------------------------------------

def load_tape(path: str, min_tokens: int, max_tokens: int | None = None) -> tuple[list[dict], list[str]]:
    """Gap-free records in the band, and a note for every record refused.

    The band is on the RECORDED prompt_tokens, which is what the server counted
    when the record was made.
    """
    keep, refused = [], []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            r = json.loads(line)
            req = r.get("request") or {}
            ptok = ((r.get("response") or {}).get("usage") or {}).get("prompt_tokens") or 0
            if ptok < min_tokens or (max_tokens and ptok >= max_tokens):
                continue
            if r.get("gaps"):
                refused.append(f"line {n}: gaps {r['gaps']}")
                continue
            if not req.get("messages"):
                refused.append(f"line {n}: no request.messages")
                continue
            keep.append({"line": n, "prompt_tokens": ptok, "messages": req["messages"], "tools": req.get("tools")})
    return keep, refused


# --- classification and statistics ---------------------------------------------------

def classify(status: int, body) -> dict:
    """One response reduced to what the A/B counts, with the evidence kept."""
    if status != 200 or not isinstance(body, dict):
        return {"outcome": "error", "status": status, "error": str(body)[:500]}
    choice = (body.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or ""
    tool_calls = msg.get("tool_calls") or []
    usage = body.get("usage") or {}
    empty = not content.strip() and not tool_calls
    return {
        "outcome": "empty" if empty else "answer",
        "status": status,
        "finish_reason": choice.get("finish_reason"),
        "content_chars": len(content),
        "reasoning_chars": len(reasoning),
        "tool_calls": len(tool_calls),
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "content_head": content[:200],
        "reasoning_tail": reasoning[-300:],
    }


def wilson(k: int, n: int, z: float = 1.959964) -> tuple[float, float]:
    """95% Wilson score interval for k successes in n trials."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    den = 1 + z * z / n
    mid = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, mid - half), min(1.0, mid + half))


def fisher_exact(a: int, b: int, c: int, d: int) -> float:
    """Two-sided Fisher exact p for [[a, b], [c, d]] (sum of tables as or less likely)."""
    r1, r2, c1 = a + b, c + d, a + c
    n = r1 + r2

    def prob(x: int) -> float:
        return math.comb(r1, x) * math.comb(r2, c1 - x) / math.comb(n, c1)

    lo, hi = max(0, c1 - r2), min(r1, c1)
    p_obs = prob(a)
    return min(1.0, sum(p for x in range(lo, hi + 1) if (p := prob(x)) <= p_obs * (1 + 1e-9)))


def summarise(records: list[dict], arms: list[Arm]) -> list[str]:
    out = []
    counts = {}
    for arm in arms:
        rs = [r for r in records if r["arm"] == arm.name]
        n = sum(1 for r in rs if r["outcome"] in ("empty", "answer"))
        k = sum(1 for r in rs if r["outcome"] == "empty")
        err = sum(1 for r in rs if r["outcome"] == "error")
        lo, hi = wilson(k, n)
        counts[arm.name] = (k, n)
        eos_in_think = sum(1 for r in rs if r["outcome"] == "empty" and r.get("reasoning_chars") and r.get("finish_reason") == "stop")
        out.append(f"  {arm.name:10s} empty {k:3d}/{n:<3d}  {100 * k / n if n else 0:5.1f}%  "
                   f"95% CI {100 * lo:5.1f}-{100 * hi:5.1f}%  errors {err}  "
                   f"(empty with reasoning + stop: {eos_in_think})  overrides {arm.overrides or 'none'}")
    base = arms[0].name
    for arm in arms[1:]:
        (k0, n0), (k1, n1) = counts[base], counts[arm.name]
        p = fisher_exact(k0, n0 - k0, k1, n1 - k1)
        out.append(f"  {arm.name} vs {base}: Fisher exact two-sided p = {p:.4f}")
    if counts and all(k == 0 for k, _ in counts.values()):
        out.append("  NO ARM PRODUCED AN EMPTY ANSWER. This run cannot rank the arms: the workload")
        out.append("  did not trigger the failure. That is a statement about the workload, not a")
        out.append("  finding that the failure is gone.")
    return out


def schedule(arms: list[Arm], rounds: int, seed: int) -> list[tuple[int, Arm]]:
    rng = random.Random(seed)
    plan = []
    for r in range(rounds):
        order = list(arms)
        rng.shuffle(order)
        plan.extend((r, a) for a in order)
    return plan


# --- the run ------------------------------------------------------------------------

def request_for(workload: str, rnd: int, args, tape: list[dict]) -> tuple[dict, dict]:
    if workload == "enum":
        prompt, bad = build_enum_prompt(args.items, args.seed * 100003 + rnd)
        return {"messages": [{"role": "user", "content": prompt}]}, {"planted": bad}
    rec = tape[rnd % len(tape)]
    payload = {"messages": rec["messages"]}
    if rec.get("tools"):
        payload["tools"] = rec["tools"]
    return payload, {"tape_line": rec["line"], "recorded_prompt_tokens": rec["prompt_tokens"]}


def run(args) -> int:
    from probe_lib import post

    arms = [parse_arm(s) for s in args.arm]
    if len(arms) < 2:
        print("need at least two --arm (the first is the baseline)", file=sys.stderr)
        return 2
    if len({a.name for a in arms}) != len(arms):
        print("arm names must be unique", file=sys.stderr)
        return 2

    tape: list[dict] = []
    if args.workload == "tape":
        tape, refused = load_tape(args.tape, args.min_prompt_tokens, args.max_prompt_tokens)
        for note in refused[:20]:
            print(f"  refused {note}")
        if not tape:
            print(f"no usable records in {args.tape} at >= {args.min_prompt_tokens} prompt tokens "
                  f"({len(refused)} refused)", file=sys.stderr)
            return 1

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    plan = schedule(arms, args.rounds, args.seed)
    print(f"empty-turn A/B  workload={args.workload}  arms={[a.name for a in arms]}  "
          f"rounds={args.rounds}  requests={len(plan)}  -> {args.out}")

    records = []
    with open(args.out, "a") as out:
        for i, (rnd, arm) in enumerate(plan, 1):
            payload, meta = request_for(args.workload, rnd, args, tape)
            payload.update(model=args.model, stream=False, max_tokens=args.max_tokens, **arm.overrides)
            t0 = time.time()
            try:
                status, body = post(args.llama_url, "/v1/chat/completions", payload, timeout=args.timeout)
            except OSError as e:
                status, body = 0, f"{type(e).__name__}: {e}"
            rec = {"round": rnd, "arm": arm.name, "overrides": arm.overrides, "wall_s": round(time.time() - t0, 2),
                   **meta, **classify(status, body)}
            records.append(rec)
            out.write(json.dumps(rec) + "\n")
            out.flush()
            print(f"  [{i:4d}/{len(plan)}] round {rnd:3d} {arm.name:10s} {rec['outcome']:6s} "
                  f"finish={rec.get('finish_reason')} ptok={rec.get('prompt_tokens')} "
                  f"ctok={rec.get('completion_tokens')} reasoning={rec.get('reasoning_chars')} {rec['wall_s']}s")

    print("\nsummary (from the records just written)")
    for line in summarise(records, arms):
        print(line)
    return 0


def self_test() -> int:
    assert parse_arm("base:") == Arm("base", {})
    assert parse_arm("fp03:frequency_penalty=0.3").overrides == {"frequency_penalty": 0.3}
    try:
        parse_arm("x:frequency_penatly=0.3")
        raise AssertionError("typo accepted")
    except ValueError:
        pass
    p, bad = build_enum_prompt(200, 7)
    assert all(f"node-{b:04d}" in p for b in bad) and len(bad) == 5
    assert fisher_exact(0, 40, 10, 30) < 0.01
    assert abs(fisher_exact(5, 5, 5, 5) - 1.0) < 1e-9
    lo, hi = wilson(0, 40)
    assert lo == 0.0 and 0.08 < hi < 0.095
    print("self-test OK")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--arm", action="append", default=[], help="name:key=val[,key=val]; first is the baseline")
    ap.add_argument("--workload", choices=("enum", "tape"), default="enum")
    ap.add_argument("--rounds", type=int, default=40)
    ap.add_argument("--items", type=int, default=600, help="enum: records per prompt (~25 tokens each)")
    ap.add_argument("--tape", help="tape: a capture JSONL with request/response records")
    ap.add_argument("--min-prompt-tokens", type=int, default=0)
    ap.add_argument("--max-prompt-tokens", type=int, default=None)
    ap.add_argument("--seed", type=int, default=20261004)
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("EMPTY_AB_TIMEOUT", DEFAULT_TIMEOUT)))
    ap.add_argument("--llama-url", default=os.environ.get("LLAMA_URL", "http://llama:8080"))
    ap.add_argument("--model", default=os.environ.get("MODEL_ALIAS", "qwen3.8-27b"))
    ap.add_argument("--out", default=f"/captures/empty-turn-ab/{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.jsonl")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    if args.workload == "tape" and not args.tape:
        ap.error("--workload tape needs --tape")
    try:
        return run(args)
    except ValueError as e:
        print(f"empty_turn_ab: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
