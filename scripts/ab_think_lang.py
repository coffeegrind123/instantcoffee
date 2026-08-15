#!/usr/bin/env python3
"""A/B the THINK_LANG system-prompt fragment against no fragment at all.

Run inside the compose network:
    docker compose --profile tools run --rm ab-think-lang

Or directly against a running forge proxy:
    FORGE_URL=http://localhost:8081 python3 scripts/ab_think_lang.py --repeat 3

Why this exists
---------------
The 2026-08-11 HN thread (dannyw) claims Qwen reasons better and more cheaply in
Mandarin, and that a system prompt should ask it to think in Chinese while
answering in the user's language. The obvious follow-up — "better thinking, or
just shorter because Chinese is denser?" (kadoban) — was asked in the thread and
never answered. Nobody posted a measurement.

So this measures both axes on the hardware in front of you:

    quality   objective scores on tasks with exact answers
    cost      reasoning characters, reasoning tokens, completion tokens, seconds
    safety    whether Chinese leaked out of the thinking block

The third one is the go/no-go. A model that reasons in Chinese and then writes a
Chinese identifier into an edit, or a Chinese character into a file path, has not
saved anything — it has produced a patch that does not apply. Both arms run with
thinking ENABLED in both arms — measuring the fragment without it would
produce a meaningless dead heat.

Sampling at temperature 0.6 is stochastic, so a single run cannot separate a real
effect from noise. --repeat runs the whole task set N times per arm and reports
means; the verdict refuses to call small differences.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

FORGE_URL = os.environ.get("FORGE_URL", "http://forge:8081").rstrip("/")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")
TIMEOUT = float(os.environ.get("AB_TIMEOUT", "900"))

# Code tasks need room for a full reasoning trace AND the answer. Both arms run
# with thinking ON, and REASONING_BUDGET defaults to 4096, so a 3072 cap could be
# spent entirely on thinking — which scores as "no code" and looks like a model
# that cannot write code. Observed on the GPU host 2026-08-12 for both codegen
# and bugfix. Keep this comfortably above REASONING_BUDGET.
TASK_MAX_TOKENS = int(os.environ.get("AB_TASK_MAX_TOKENS", "6144"))

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FRAGMENT = REPO_ROOT / "prompts" / "think-zh.md"

# ── CJK leak detection ─────────────────────────────────────────────────────
#
# The failure mode this whole experiment risks. Ranges, deliberately wider than
# "Chinese": CJK ideographs and their extensions, the CJK compatibility block,
# CJK symbols and punctuation (、。「」), Hiragana/Katakana, and the halfwidth /
# fullwidth forms block, which is where fullwidth commas and colons live. A
# model drifting out of English tends to bring the punctuation first.

CJK_PATTERN = re.compile(
    "["
    "　-〿"   # CJK symbols and punctuation
    "぀-ヿ"   # Hiragana + Katakana
    "㐀-䶿"   # CJK unified ideographs extension A
    "一-鿿"   # CJK unified ideographs
    "豈-﫿"   # CJK compatibility ideographs
    "︰-﹏"   # CJK compatibility forms
    "＀-￯"   # halfwidth and fullwidth forms
    "]"
)


def cjk_chars(text: str) -> list[str]:
    """Every CJK character in `text`, in order, duplicates included."""
    if not text:
        return []
    return CJK_PATTERN.findall(text)


def has_cjk(text: str) -> bool:
    return bool(text) and CJK_PATTERN.search(text) is not None


def cjk_sample(text: str, limit: int = 40) -> str:
    """A short excerpt around the first leak, for a human to look at."""
    m = CJK_PATTERN.search(text or "")
    if not m:
        return ""
    start = max(0, m.start() - limit // 2)
    return text[start:start + limit].replace("\n", "\\n")


# ── transport ──────────────────────────────────────────────────────────────


def _http(url: str, payload: dict, timeout: float) -> tuple[int, str]:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"


@dataclass
class Reply:
    content: str = ""
    reasoning: str = ""
    reasoning_source: str = "none"   # reasoning_content | think-tags | none
    tool_calls: list = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0
    error: str = ""

    @property
    def tool_arg_text(self) -> str:
        """Every tool-call argument concatenated — the leak surface that breaks
        edits and paths, as opposed to prose, which is merely wrong."""
        parts = []
        for c in self.tool_calls:
            fn = c.get("function") or {}
            parts.append(str(fn.get("name", "")))
            parts.append(str(fn.get("arguments", "")))
        return "\n".join(parts)


_THINK_TAGS = re.compile(r"<think>(.*?)</think>", re.S)


def ask(messages: list[dict], system: str | None, tools: list | None = None,
        max_tokens: int = 2048) -> Reply:
    msgs = list(messages)
    if system:
        msgs = [{"role": "system", "content": system}, *msgs]
    payload: dict = {
        "model": MODEL_ALIAS,
        "messages": msgs,
        "max_tokens": max_tokens,
        # The point of the experiment: thinking on, in both arms.
        "chat_template_kwargs": {"enable_thinking": True},
    }
    if tools:
        payload["tools"] = tools

    t0 = time.time()
    status, body = _http(f"{FORGE_URL}/v1/chat/completions", payload, TIMEOUT)
    elapsed = time.time() - t0

    if status != 200:
        return Reply(seconds=elapsed, error=f"status={status} {body[:200]}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return Reply(seconds=elapsed, error=f"non-JSON: {body[:200]}")

    msg = (data.get("choices") or [{}])[0].get("message", {}) or {}
    content = msg.get("content") or ""

    # --reasoning-format deepseek puts thinking in reasoning_content. If the
    # chain ever stops doing that, the reasoning-length numbers would quietly
    # read as zero and look like "Chinese is amazingly terse" — so the source is
    # recorded and reported rather than inferred.
    reasoning = msg.get("reasoning_content") or ""
    source = "reasoning_content" if reasoning else "none"
    if not reasoning:
        found = _THINK_TAGS.findall(content)
        if found:
            reasoning = "\n".join(found)
            source = "think-tags"
            content = _THINK_TAGS.sub("", content).strip()

    usage = data.get("usage") or {}
    return Reply(
        content=content,
        reasoning=reasoning,
        reasoning_source=source,
        tool_calls=msg.get("tool_calls") or [],
        prompt_tokens=int(usage.get("prompt_tokens") or 0),
        completion_tokens=int(usage.get("completion_tokens") or 0),
        seconds=elapsed,
    )


# ── scoring helpers ────────────────────────────────────────────────────────


def strip_fences(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"^```[a-zA-Z0-9_+-]*\n?", "", s)
    s = re.sub(r"\n?```$", "", s)
    return s.strip()


def run_python(source: str, timeout: int = 20) -> tuple[bool, str]:
    """Execute a snippet in a subprocess. Returns (exit-zero, output tail)."""
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "t.py"
        f.write_text(source, encoding="utf-8")
        try:
            p = subprocess.run([sys.executable, str(f)], capture_output=True,
                               text=True, timeout=timeout)
            return p.returncode == 0, (p.stderr or p.stdout)[-200:]
        except subprocess.TimeoutExpired:
            return False, "timeout"
        except Exception as exc:            # pragma: no cover - defensive
            return False, f"{type(exc).__name__}: {exc}"


def extract_code(reply: Reply) -> str:
    body = reply.content
    m = re.search(r"```(?:python)?\s*\n(.*?)```", body, re.S)
    return (m.group(1) if m else strip_fences(body)).strip()


# ── tasks ──────────────────────────────────────────────────────────────────
#
# Each returns (score 0..1, detail). Objective only: exact integers, code that
# runs against assertions, byte-exact strings. Nothing judged by another model,
# because an LLM judge would add its own variance to a measurement whose whole
# purpose is separating a real effect from noise.


def task_math(system: str | None) -> tuple[float, str, Reply]:
    r = ask([{"role": "user", "content":
              "What is 234 * 567 + 89? Work it out, then give the final answer "
              "on its own line starting with 'ANSWER:'."}], system)
    if r.error:
        return 0.0, r.error, r
    m = re.search(r"ANSWER:\s*([\d,]+)", r.content)
    if not m:
        return 0.0, "no ANSWER: line", r
    got = int(m.group(1).replace(",", ""))
    want = 234 * 567 + 89
    return (1.0 if got == want else 0.0), f"got={got} want={want}", r


def task_logic(system: str | None) -> tuple[float, str, Reply]:
    r = ask([{"role": "user", "content":
              "A shop sells widgets in boxes of 12 and crates of 30. A customer "
              "orders 7 boxes and 4 crates, then returns 2 boxes and half of one "
              "crate. Widgets cannot be split, and a returned half crate means 15 "
              "widgets. How many widgets does the customer keep? Give the final "
              "number on its own line starting with 'ANSWER:'."}], system)
    if r.error:
        return 0.0, r.error, r
    m = re.search(r"ANSWER:\s*([\d,]+)", r.content)
    if not m:
        return 0.0, "no ANSWER: line", r
    got = int(m.group(1).replace(",", ""))
    want = (7 * 12 + 4 * 30) - (2 * 12) - 15   # 84 + 120 - 24 - 15 = 165
    return (1.0 if got == want else 0.0), f"got={got} want={want}", r


def task_codegen(system: str | None) -> tuple[float, str, Reply]:
    r = ask([{"role": "user", "content":
              "Write a Python function `merge_intervals(intervals)` that takes a "
              "list of [start, end] pairs and returns them merged and sorted by "
              "start. Overlapping and touching intervals merge. Return only the "
              "function in a single Python code block, no prose."}], system,
            max_tokens=TASK_MAX_TOKENS)
    if r.error:
        return 0.0, r.error, r
    code = extract_code(r)
    if not code:
        return 0.0, "no code", r
    tests = (
        "\nassert merge_intervals([[1,3],[2,6],[8,10],[15,18]]) == "
        "[[1,6],[8,10],[15,18]]\n"
        "assert merge_intervals([[1,4],[4,5]]) == [[1,5]]\n"
        "assert merge_intervals([]) == []\n"
        "assert merge_intervals([[5,6],[1,2]]) == [[1,2],[5,6]]\n"
        "print('ok')\n"
    )
    okay, out = run_python(code + tests)
    return (1.0 if okay else 0.0), ("pass" if okay else out.strip()[:120]), r


BUGGY = (
    "def running_max(values):\n"
    "    out = []\n"
    "    best = 0\n"
    "    for i in range(1, len(values)):\n"
    "        if values[i] > best:\n"
    "            best = values[i]\n"
    "        out.append(best)\n"
    "    return out\n"
)


def task_bugfix(system: str | None) -> tuple[float, str, Reply]:
    r = ask([{"role": "user", "content":
              "This function should return the running maximum, so "
              "running_max([3,1,4,1,5]) == [3,3,4,4,5]. It does not. Fix it and "
              "return only the corrected function in a single Python code "
              f"block, no prose.\n\n```python\n{BUGGY}```"}], system,
            max_tokens=TASK_MAX_TOKENS)
    if r.error:
        return 0.0, r.error, r
    code = extract_code(r)
    if not code:
        return 0.0, "no code", r
    tests = (
        "\nassert running_max([3,1,4,1,5]) == [3,3,4,4,5]\n"
        "assert running_max([-5,-2]) == [-5,-2]\n"
        "assert running_max([7]) == [7]\n"
        "print('ok')\n"
    )
    okay, out = run_python(code + tests)
    return (1.0 if okay else 0.0), ("pass" if okay else out.strip()[:120]), r


EDIT_SRC = (
    "def load_config(path):\n"
    "    with open(path) as fh:\n"
    "        return json.load(fh)\n"
)


def task_edit(system: str | None) -> tuple[float, str, Reply]:
    """Byte-exact reproduction. The thing that breaks first when a model starts
    paraphrasing instead of copying — which is exactly what reasoning in another
    language risks."""
    r = ask([{"role": "user", "content":
              "Change only the function name from `load_config` to "
              "`read_config`. Everything else — indentation, the `with` line, "
              "the return line — must be reproduced byte for byte. Return only "
              f"the resulting code block.\n\n```python\n{EDIT_SRC}```"}], system)
    if r.error:
        return 0.0, r.error, r
    got = extract_code(r)
    want = EDIT_SRC.replace("load_config", "read_config").strip()
    if got.strip() == want:
        return 1.0, "exact", r
    # Partial credit: right rename, whitespace drift.
    if re.sub(r"\s+", "", got) == re.sub(r"\s+", "", want):
        return 0.5, "whitespace drift", r
    return 0.0, f"mismatch: {got[:70]!r}", r


READ_TOOL = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read a file from disk.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute file path"},
                "reason": {"type": "string", "description": "Why, in English"},
            },
            "required": ["path"],
        },
    },
}


def task_toolcall(system: str | None) -> tuple[float, str, Reply]:
    """The highest-consequence leak surface: a path argument. Chinese in prose
    is cosmetic; Chinese in a path is a call that cannot succeed."""
    want_path = "/srv/app/config/settings.production.json"
    r = ask([{"role": "user", "content":
              f"Read the file at {want_path} using the read_file tool. Call the "
              "tool; do not describe what you would do."}], system,
            tools=[READ_TOOL])
    if r.error:
        return 0.0, r.error, r
    if not r.tool_calls:
        return 0.0, "no tool_calls", r
    fn = (r.tool_calls[0].get("function") or {})
    if fn.get("name") != "read_file":
        return 0.2, f"wrong tool: {fn.get('name')}", r
    try:
        args = json.loads(fn.get("arguments") or "{}")
    except json.JSONDecodeError:
        return 0.3, "invalid JSON arguments", r
    got_path = args.get("path", "")
    if got_path == want_path:
        return 1.0, "exact path", r
    return 0.4, f"path={got_path!r}", r


TASKS = [
    ("math", task_math),
    ("logic", task_logic),
    ("codegen", task_codegen),
    ("bugfix", task_bugfix),
    ("edit", task_edit),
    ("toolcall", task_toolcall),
]


# ── arm execution ──────────────────────────────────────────────────────────


def run_arm(name: str, system: str | None, repeat: int, verbose: bool) -> dict:
    rows: list[dict] = []
    print(f"\n── arm: {name} "
          f"({'with system prompt' if system else 'no system prompt'}) ──",
          flush=True)

    for i in range(repeat):
        if repeat > 1:
            print(f"  pass {i + 1}/{repeat}", flush=True)
        for task_name, fn in TASKS:
            score, detail, reply = fn(system)

            visible = reply.content
            args_text = reply.tool_arg_text
            leak_visible = len(cjk_chars(visible))
            leak_args = len(cjk_chars(args_text))

            rows.append({
                "task": task_name,
                "pass": i + 1,
                "score": score,
                "detail": detail,
                "seconds": round(reply.seconds, 2),
                "reasoning_chars": len(reply.reasoning),
                "completion_tokens": reply.completion_tokens,
                "reasoning_source": reply.reasoning_source,
                "cjk_visible": leak_visible,
                "cjk_tool_args": leak_args,
                "cjk_sample": cjk_sample(visible) or cjk_sample(args_text),
                "error": reply.error,
            })

            flag = ""
            if leak_args:
                flag = f"  !! CJK IN TOOL ARGS ({leak_args})"
            elif leak_visible:
                flag = f"  !! CJK in output ({leak_visible})"
            print(f"    [{score:.2f}] {task_name:<9} "
                  f"{reply.seconds:6.1f}s  think={len(reply.reasoning):>6}c  "
                  f"{detail[:52]}{flag}", flush=True)
            if verbose and reply.reasoning:
                print(f"          reasoning[:160]: "
                      f"{reply.reasoning[:160]!r}", flush=True)

    return {"name": name, "system_prompt": bool(system), "rows": rows}


def _mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def summarize(arm: dict) -> dict:
    rows = arm["rows"]
    sources = {r["reasoning_source"] for r in rows}
    return {
        "name": arm["name"],
        "n": len(rows),
        "score": round(_mean([r["score"] for r in rows]), 3),
        "seconds": round(_mean([r["seconds"] for r in rows]), 2),
        "reasoning_chars": round(_mean([r["reasoning_chars"] for r in rows]), 1),
        "completion_tokens": round(
            _mean([r["completion_tokens"] for r in rows]), 1),
        "cjk_visible": sum(r["cjk_visible"] for r in rows),
        "cjk_tool_args": sum(r["cjk_tool_args"] for r in rows),
        "errors": sum(1 for r in rows if r["error"]),
        "reasoning_source": ",".join(sorted(sources)),
        "per_task": {
            t: round(_mean([r["score"] for r in rows if r["task"] == t]), 3)
            for t, _ in TASKS
        },
    }


def verdict(base: dict, test: dict, min_delta: float) -> tuple[str, int]:
    """Returns (text, exit code). Exit non-zero means do not turn it on."""
    if test["cjk_tool_args"]:
        return ("REJECT — Chinese leaked into tool-call arguments "
                f"({test['cjk_tool_args']} chars). Tool calls carry paths and "
                "edit strings; a non-ASCII character there is a call that "
                "cannot succeed. Do not enable THINK_LANG.", 1)
    if test["cjk_visible"]:
        return ("REJECT — Chinese leaked into user-visible output "
                f"({test['cjk_visible']} chars). The fragment did not hold the "
                "language boundary on this model. Do not enable THINK_LANG.", 1)

    d_score = test["score"] - base["score"]
    d_think = base["reasoning_chars"] - test["reasoning_chars"]
    think_pct = (d_think / base["reasoning_chars"] * 100
                 if base["reasoning_chars"] else 0.0)
    d_secs = base["seconds"] - test["seconds"]

    parts = [
        f"no leakage. score {base['score']:.3f} -> {test['score']:.3f} "
        f"({d_score:+.3f}), reasoning {base['reasoning_chars']:.0f} -> "
        f"{test['reasoning_chars']:.0f} chars ({think_pct:+.0f}%), "
        f"wall {base['seconds']:.1f}s -> {test['seconds']:.1f}s ({d_secs:+.1f}s)"
    ]

    if d_score < -min_delta:
        parts.append(f"REJECT — quality dropped by more than {min_delta:.2f}.")
        return (" ".join(parts), 1)
    if abs(d_score) <= min_delta and think_pct >= 15:
        parts.append("ADOPT (cost) — quality is a wash within the noise band "
                     f"of {min_delta:.2f}, and reasoning is materially cheaper. "
                     "This is the 'just shorter' answer to the HN question.")
        return (" ".join(parts), 0)
    if d_score > min_delta:
        parts.append("ADOPT (quality) — scored better than the noise band. "
                     "Re-run with a higher --repeat before trusting it.")
        return (" ".join(parts), 0)
    parts.append("NO CHANGE — neither quality nor cost moved enough to justify "
                 "a non-default system prompt. Leave THINK_LANG=off.")
    return (" ".join(parts), 0)


def table(base: dict, test: dict) -> str:
    def row(label: str, key: str, fmt: str = "{}") -> str:
        return (f"| {label} | {fmt.format(base[key])} | "
                f"{fmt.format(test[key])} |")

    lines = [
        "",
        "| metric | baseline | think-lang |",
        "| --- | --- | --- |",
        row("mean score", "score", "{:.3f}"),
        row("mean seconds", "seconds", "{:.2f}"),
        row("mean reasoning chars", "reasoning_chars", "{:.0f}"),
        row("mean completion tokens", "completion_tokens", "{:.1f}"),
        row("CJK in visible output", "cjk_visible"),
        row("CJK in tool args", "cjk_tool_args"),
        row("request errors", "errors"),
        "",
        "| task | baseline | think-lang |",
        "| --- | --- | --- |",
    ]
    for t, _ in TASKS:
        lines.append(f"| {t} | {base['per_task'][t]:.2f} | "
                     f"{test['per_task'][t]:.2f} |")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="A/B a thinking-language system prompt against no prompt.")
    ap.add_argument("--system-prompt-file", default=str(DEFAULT_FRAGMENT),
                    help=f"fragment under test (default: {DEFAULT_FRAGMENT})")
    ap.add_argument("--repeat", type=int, default=3,
                    help="passes per arm; sampling is stochastic (default: 3)")
    ap.add_argument("--min-delta", type=float, default=0.05,
                    help="score difference treated as noise (default: 0.05)")
    ap.add_argument("--json", dest="json_out", default="",
                    help="also write the full result to this path")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="print the head of each reasoning trace")
    args = ap.parse_args()

    fragment_path = Path(args.system_prompt_file)
    if not fragment_path.is_file():
        print(f"error: {fragment_path} does not exist", file=sys.stderr)
        return 2
    fragment = fragment_path.read_text(encoding="utf-8").strip()
    if not fragment:
        print(f"error: {fragment_path} is empty", file=sys.stderr)
        return 2

    print("=" * 68)
    print(f"think-lang A/B — {MODEL_ALIAS} via {FORGE_URL}")
    print(f"fragment: {fragment_path}")
    print(f"repeat: {args.repeat}   tasks: {len(TASKS)}   "
          f"requests: {2 * args.repeat * len(TASKS)}")
    print("thinking: ON in both arms")
    print("=" * 68)

    base_arm = run_arm("baseline", None, args.repeat, args.verbose)
    test_arm = run_arm("think-lang", fragment, args.repeat, args.verbose)

    base = summarize(base_arm)
    test = summarize(test_arm)

    print("\n" + "=" * 68)
    print(table(base, test))

    # A reasoning-length comparison is meaningless if no reasoning came back.
    # Say so instead of reporting a zero that reads like a result.
    if base["reasoning_chars"] == 0 and test["reasoning_chars"] == 0:
        print("\nWARNING: no reasoning text was returned in either arm "
              f"(source={base['reasoning_source']}). Either thinking is off at "
              "the backend, or forge is not passing reasoning_content through. "
              "The cost columns below mean nothing until that is fixed — check "
              "REASONING_BUDGET in .env (0 disables thinking entirely).")

    text, code = verdict(base, test, args.min_delta)
    print(f"\nVERDICT: {text}\n")

    payload = {
        "model": MODEL_ALIAS,
        "fragment": str(fragment_path),
        "repeat": args.repeat,
        "min_delta": args.min_delta,
        "baseline": base,
        "think_lang": test,
        "verdict": text,
        "rows": {"baseline": base_arm["rows"], "think_lang": test_arm["rows"]},
    }
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(payload, indent=2),
                                       encoding="utf-8")
        print(f"wrote {args.json_out}")
    else:
        print("```json")
        print(json.dumps({k: v for k, v in payload.items() if k != "rows"},
                         indent=2))
        print("```")

    return code


if __name__ == "__main__":
    sys.exit(main())
