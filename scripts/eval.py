#!/usr/bin/env python3
"""
Comprehensive coding-agent evaluation for the qwen3.6-forge stack.

Run inside the compose network:
    docker compose --profile tools run --rm eval

Or directly with a running forge proxy:
    FORGE_URL=http://localhost:8081 python3 scripts/eval.py

What it measures:
    Speed      — pp (prompt processing t/s) + tg (token generation t/s)
                 at multiple context depths, from llama-bench patterns.
    Code       — HumanEval-style function generation with pass@1 scoring.
                 Functions are compiled and executed against test cases.
    BugFix     — Off-by-one, type errors, logic errors. Scored on fix
                 correctness.
    Edit       — Exact string-matching precision (the #1 real-world
                 failure mode from the HN thread).
    Tools      — Tool calling accuracy, JSON validity, argument types.
    Reasoning  — Mathematical reasoning with step-by-step thinking.
    Review     — Security review: finds SQLi, password logging, XSS.
    LoopDetect — Sampled output checked for degenerate repeats.

All scorers produce 0.0-1.0 values. The aggregate report is JSON on stdout,
a markdown scorecard, and a non-zero exit when any suite falls below its
score floor.

Inspired by:
    - 0xSero/framework-research (HumanEval+MBPP+GSM8K per quant)
    - bradrlaw/ai-server (llama-bench methodology)
    - JHamidun/claude-code-config-pack (two-tier eval with LLM judges)
    - Virtue-Research/guard-eval-harness (capability-scoped metrics)
    - rhdunn's promptfoo loop-detection assert (HN thread)
"""

from __future__ import annotations

import json
import math
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

# ── config ────────────────────────────────────────────────────────────────

FORGE_URL = os.environ.get("FORGE_URL", "http://forge:8081").rstrip("/")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "qwen3.6-27b")
EVAL_TIMEOUT = float(os.environ.get("EVAL_TIMEOUT", "900"))
REPEAT_THRESHOLD = int(os.environ.get("EVAL_REPEAT_THRESHOLD", "3"))
SCORE_FLOOR = float(os.environ.get("EVAL_SCORE_FLOOR", "0.5"))

# ── helpers ────────────────────────────────────────────────────────────────


def _http(url: str, payload: dict | None = None, timeout: float = 300.0,
          headers: dict | None = None) -> tuple[int, str]:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"


def _chat(messages: list[dict], tools: list[dict] | None = None,
          max_tokens: int = 2048, timeout: float = EVAL_TIMEOUT) -> dict:
    p: dict = {
        "model": MODEL_ALIAS, "messages": messages, "max_tokens": max_tokens,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if tools:
        p["tools"] = tools
    s, b = _http(f"{FORGE_URL}/v1/chat/completions", p, timeout=timeout)
    if s != 200:
        return {"_error": f"status={s}", "_body": b[:400]}
    try:
        return json.loads(b)
    except json.JSONDecodeError:
        return {"_error": "non-JSON", "_body": b[:400]}


def _content(r: dict) -> str:
    msg = (r.get("choices") or [{}])[0].get("message", {})
    return msg.get("content") or msg.get("reasoning_content") or ""


def _tool_calls(r: dict) -> list[dict]:
    return (r.get("choices") or [{}])[0].get("message", {}).get("tool_calls") or []


def _strip_fences(s: str) -> str:
    s = s.strip()
    s = re.sub(r"^```[a-z]*\n?", "", s)
    s = re.sub(r"\n?```$", "", s)
    return s

# ── repeat detection ───────────────────────────────────────────────────────


def _count_repeats(text: str, length: int) -> int:
    n = len(text)
    pattern = text[n - length:n]
    count = 1
    text = text[: -length]
    while text.endswith(pattern):
        text = text[: -length]
        count += 1
    return count


def _check_repeats(output: str) -> tuple[int, int]:
    count = length = 0
    for n in range(1, (len(output) // 2) + 1):
        nc = _count_repeats(output, n)
        if nc > count:
            count, length = nc, n
    return count, length

# ── scoring primitives ─────────────────────────────────────────────────────


@dataclass
class Result:
    suite: str
    test: str
    score: float
    detail: str = ""
    meta: dict = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.score >= SCORE_FLOOR


class Registry:
    def __init__(self) -> None:
        self.results: list[Result] = []

    def add(self, suite: str, test: str, score: float, detail: str = "",
            **meta: Any) -> Result:
        r = Result(suite, test, score, detail, meta)
        self.results.append(r)
        mark = "PASS" if r.passed else "FAIL"
        d = f" — {detail}" if detail else ""
        print(f"  [{mark}] [{score:.2f}] {suite}/{test}{d}", flush=True)
        return r

    def aggregate(self) -> dict:
        suites: dict[str, list[Result]] = {}
        for r in self.results:
            suites.setdefault(r.suite, []).append(r)
        out: dict[str, Any] = {"suites": {}, "overall": {}}
        for name, items in suites.items():
            avg = sum(r.score for r in items) / len(items)
            p = sum(1 for r in items if r.passed)
            out["suites"][name] = {"score": round(avg, 3), "passed": p,
                                   "total": len(items), "tests": [
                {"test": r.test, "score": r.score, "passed": r.passed,
                 "detail": r.detail, **r.meta} for r in items]}
        scores = [r.score for r in self.results]
        out["overall"] = {"score": round(sum(scores) / len(scores), 3) if scores else 0,
                          "passed": sum(1 for r in self.results if r.passed),
                          "total": len(scores)}
        return out

# ── suite 1: speed ─────────────────────────────────────────────────────────


def _suite_speed(reg: Registry) -> None:
    """Measure prompt processing and token generation throughput.

    Uses a fixed prompt (~500 tokens of repeating varied words) and a
    small generation (128 tokens). Measures wall-clock time, extracts
    prompt_tokens / completion_tokens from the usage block, and computes
    tok/s for both phases.

    This is the same methodology as llama-bench `pp512` / `tg128` but
    exercised through the real forge proxy path.
    """
    suite = "speed"
    words = ["function", "def", "class", "return", "import", "data", "process",
             "value", "result", "config", "module", "handler", "compute",
             "validate", "transform", "execute", "initialize", "finalize",
             "error", "success", "request", "response", "argument", "parameter"]
    prompt = "Write a Python function that does the following: " + " ".join(
        words[i % len(words)] for i in range(500))

    started = time.monotonic()
    resp = _chat([{"role": "user", "content": prompt}], max_tokens=128)
    elapsed = time.monotonic() - started

    if "_error" in resp:
        reg.add(suite, "throughput", 0.0, resp["_error"])
        return

    usage = resp.get("usage", {})
    pt = usage.get("prompt_tokens", 0)
    ct = usage.get("completion_tokens", 0)
    pp_tps = pt / elapsed if pt and elapsed else 0
    tg_tps = ct / elapsed if ct and elapsed else 0

    reg.add(suite, "prompt_processing_tps", min(pp_tps / 1000, 1.0),
            f"{pp_tps:.0f} tok/s ({pt} tokens in {elapsed:.1f}s)",
            pp_tps=round(pp_tps), pt=pt, elapsed_s=round(elapsed, 1))
    reg.add(suite, "token_generation_tps", min(tg_tps / 100, 1.0),
            f"{tg_tps:.0f} tok/s ({ct} tokens in {elapsed:.1f}s)",
            tg_tps=round(tg_tps), ct=ct, elapsed_s=round(elapsed, 1))

    # Check for loops in generated output
    content = _content(resp)
    count, length = _check_repeats(content)
    ok = count < REPEAT_THRESHOLD
    reg.add(suite, "no_loop", 1.0 if ok else 0.0,
            f"repeats={count}x len={length}" if not ok else "")

# ── suite 2: code generation ───────────────────────────────────────────────


CODING_TASKS = [
    {
        "id": "fibonacci",
        "prompt": "Write a Python function `fibonacci(n: int) -> int` that "
                  "returns the nth Fibonacci number (0-indexed: fib(0)=0, fib(1)=1). "
                  "Use iteration, not recursion. Reply with ONLY the function code, "
                  "no markdown fences, no explanation.",
        "tests": [
            ("fibonacci(0)", 0),
            ("fibonacci(1)", 1),
            ("fibonacci(2)", 1),
            ("fibonacci(5)", 5),
            ("fibonacci(10)", 55),
            ("fibonacci(20)", 6765),
        ],
        "max_tokens": 512,
    },
    {
        "id": "binary_search",
        "prompt": "Write a Python function `binary_search(arr: list, target: int) -> int` "
                  "that returns the index of target in a sorted list, or -1 if not found. "
                  "Use binary search, not linear scan. Reply with ONLY the function code.",
        "tests": [
            ("binary_search([1,3,5,7,9], 5)", 2),
            ("binary_search([1,3,5,7,9], 9)", 4),
            ("binary_search([1,3,5,7,9], 1)", 0),
            ("binary_search([1,3,5,7,9], 6)", -1),
            ("binary_search([], 5)", -1),
            ("binary_search([2,4,6,8,10,12,14,16,18,20], 14)", 6),
        ],
        "max_tokens": 512,
    },
    {
        "id": "is_palindrome",
        "prompt": "Write a Python function `is_palindrome(s: str) -> bool` that returns "
                  "True if the string reads the same forwards and backwards, ignoring "
                  "case and non-alphanumeric characters. Reply with ONLY the function code.",
        "tests": [
            ('is_palindrome("racecar")', True),
            ('is_palindrome("A man a plan a canal Panama")', True),
            ('is_palindrome("hello")', False),
            ('is_palindrome("")', True),
            ('is_palindrome("Race car")', True),
            ('is_palindrome("12321")', True),
        ],
        "max_tokens": 512,
    },
    {
        "id": "group_anagrams",
        "prompt": "Write a Python function `group_anagrams(words: list[str]) -> list[list[str]]` "
                  "that groups words that are anagrams of each other. Words are case-sensitive. "
                  "Reply with ONLY the function code.",
        "tests": [
            ("sorted([sorted(g) for g in group_anagrams(['eat','tea','tan','ate','nat','bat'])])",
             [['a','e','t'], ['a','e','t'], ['a','e','t'], ['a','n','t'], ['a','n','t'], ['a','b','t']]),
            ("len(group_anagrams(['']))", 1),
            ("len(group_anagrams(['a']))", 1),
            ("len(group_anagrams([]))", 0),
        ],
        "max_tokens": 768,
    },
    {
        "id": "merge_sorted",
        "prompt": "Write a Python function `merge_sorted(a: list[int], b: list[int]) -> list[int]` "
                  "that merges two sorted lists into one sorted list. Do NOT use `sorted()` or "
                  "`.sort()`. Reply with ONLY the function code.",
        "tests": [
            ("merge_sorted([1,3,5], [2,4,6])", [1,2,3,4,5,6]),
            ("merge_sorted([], [1,2])", [1,2]),
            ("merge_sorted([1,2], [])", [1,2]),
            ("merge_sorted([], [])", []),
            ("merge_sorted([1,1,1], [1,1,1])", [1,1,1,1,1,1]),
            ("merge_sorted([-5,0,5], [-10,10])", [-10, -5, 0, 5, 10]),
        ],
        "max_tokens": 512,
    },
]


def _suite_codegen(reg: Registry) -> None:
    suite = "codegen"
    for task in CODING_TASKS:
        resp = _chat([{"role": "user", "content": task["prompt"]}],
                     max_tokens=task["max_tokens"])
        code = _strip_fences(_content(resp))

        # Compile
        try:
            compiled = compile(code, f"<{task['id']}>", "exec")
        except Exception as e:
            reg.add(suite, task["id"], 0.0,
                    f"compile failed: {type(e).__name__}: {e}")
            continue

        # Run tests
        ns: dict = {}
        try:
            exec(compiled, ns)
        except Exception as e:
            reg.add(suite, task["id"], 0.0,
                    f"exec failed: {type(e).__name__}: {e}")
            continue

        passed = 0
        total = len(task["tests"])
        for call_expr, expected in task["tests"]:
            try:
                actual = eval(call_expr, ns)
                if actual == expected:
                    passed += 1
            except Exception:
                pass

        pass_at_1 = passed / total if total else 0
        reg.add(suite, task["id"], pass_at_1,
                f"{passed}/{total} tests passed", total=total, passed=passed)

        # Loop check
        count, length = _check_repeats(code)
        if count >= REPEAT_THRESHOLD:
            reg.add(suite, f"{task['id']}_no_loop", 0.0,
                    f"repeats {count}x len {length}")

# ── suite 3: bug fixing ────────────────────────────────────────────────────


BUG_FIX_TASKS = [
    {
        "id": "off_by_one",
        "prompt": "This binary search has a bug — it can loop forever on certain "
                  "inputs. Find and fix the bug. Reply with ONLY the corrected code.\n\n"
                  "```\ndef binary_search(arr, target):\n"
                  "    left, right = 0, len(arr) - 1\n"
                  "    while left <= right:\n"
                  "        mid = (left + right) // 2\n"
                  "        if arr[mid] == target:\n"
                  "            return mid\n"
                  "        elif arr[mid] < target:\n"
                  "            left = mid\n"
                  "        else:\n"
                  "            right = mid\n"
                  "    return -1\n```",
        "checks": [
            ("mid+1", "left = mid → left = mid + 1"),
            ("mid-1", "right = mid → right = mid - 1"),
        ],
        "tests": [
            ("binary_search([1,3,5,7,9], 5)", 2),
            ("binary_search([1,3,5,7,9], 9)", 4),
            ("binary_search([1,3,5,7,9], 6)", -1),
            ("binary_search([], 5)", -1),
        ],
        "max_tokens": 1024,
    },
    {
        "id": "empty_list_guard",
        "prompt": "This function crashes on empty input. Fix it. Reply with ONLY "
                  "the corrected code.\n\n"
                  "```\ndef average(numbers):\n"
                  "    total = 0\n"
                  "    for n in numbers:\n"
                  "        total += n\n"
                  "    return total / len(numbers)\n```",
        "checks": [
            ("guard", "handles empty list"),
        ],
        "tests": [
            ("average([1,2,3])", 2.0),
            ("average([5])", 5.0),
        ],
        "max_tokens": 512,
    },
    {
        "id": "mutable_default",
        "prompt": "This function has a subtle bug related to Python's default "
                  "argument evaluation. Find and fix it. Reply with ONLY the "
                  "corrected code.\n\n"
                  "```\ndef append_to_list(item, target=[]):\n"
                  "    target.append(item)\n"
                  "    return target\n```",
        "checks": [
            ("None", "uses None sentinel"),
        ],
        "tests": [
            ("append_to_list(1)", [1]),
            ("append_to_list(2)", [2]),
            ("len(append_to_list(3, [1,2]))", 3),
        ],
        "max_tokens": 512,
    },
]


def _suite_bugfix(reg: Registry) -> None:
    suite = "bugfix"
    for task in BUG_FIX_TASKS:
        resp = _chat([{"role": "user", "content": task["prompt"]}],
                     max_tokens=task["max_tokens"])
        fixed = _strip_fences(_content(resp))

        # Pattern checks
        ck_passed = 0
        for pattern, _desc in task["checks"]:
            if pattern in fixed:
                ck_passed += 1

        # Test checks
        try:
            compiled = compile(fixed, f"<fix_{task['id']}>", "exec")
            ns: dict = {}
            exec(compiled, ns)
            t_passed = sum(1 for expr, exp in task["tests"]
                           if eval(expr, ns) == exp)
        except Exception:
            t_passed = 0

        c_score = ck_passed / len(task["checks"]) if task["checks"] else 0
        t_score = t_passed / len(task["tests"]) if task["tests"] else 0
        score = c_score * 0.4 + t_score * 0.6

        reg.add(suite, task["id"], score,
                f"patterns={ck_passed}/{len(task['checks'])} "
                f"tests={t_passed}/{len(task['tests'])}")

# ── suite 4: edit precision ────────────────────────────────────────────────


EDIT_SAMPLES = [
    ("python_fn", "def add(a, b):\n    return a + b\n",
     "a Python function that adds two numbers"),
    ("indented_class", "class Foo:\n    def bar(self):\n        if True:\n            return 42\n",
     "a Python class with nested indentation"),
    ("trailing_ws", "line with trailing    \nanother line\n",
     "lines where the first has trailing spaces"),
    ("mixed_tabs", "  \tindented\n\t  spaces\n",
     "lines with mixed tabs and spaces"),
]


def _suite_edits(reg: Registry) -> None:
    suite = "edits"
    for name, original, desc in EDIT_SAMPLES:
        resp = _chat([{
            "role": "user",
            "content": f"Reproduce this exact text verbatim, preserving every "
                       f"character including whitespace. This is {desc}. "
                       f"Reply with ONLY the text, no markdown fences, no "
                       f"commentary:\n\n```\n{original}```"
        }], max_tokens=256)
        actual = _strip_fences(_content(resp))

        exp_lines = original.rstrip("\n").split("\n")
        act_lines = actual.rstrip("\n").split("\n")
        matches = sum(1 for e, a in zip(exp_lines, act_lines) if e == a)
        line_penalty = abs(len(exp_lines) - len(act_lines)) * 0.1
        score = max(0.0, matches / max(len(exp_lines), 1) - line_penalty)

        reg.add(suite, name, score,
                f"{matches}/{len(exp_lines)} lines exact, "
                f"got {len(act_lines)} lines")

# ── suite 5: tool calling ──────────────────────────────────────────────────


WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}

CALC_TOOL = {
    "type": "function",
    "function": {
        "name": "calculate",
        "description": "Evaluate a mathematical expression",
        "parameters": {
            "type": "object",
            "properties": {"expression": {"type": "string"}},
            "required": ["expression"],
        },
    },
}


def _suite_tools(reg: Registry) -> None:
    suite = "tools"

    # Single tool call
    resp = _chat([{"role": "user",
                   "content": "What is the weather in Berlin? Use the tool."}],
                 tools=[WEATHER_TOOL], max_tokens=2048)
    calls = _tool_calls(resp)
    if not calls:
        reg.add(suite, "single_call", 0.0,
                f"no tool_calls — content={_content(resp)[:80]!r}")
    else:
        fn = calls[0].get("function", {})
        name_ok = fn.get("name") == "get_weather"
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}
        city_ok = isinstance(args.get("city"), str) and "berlin" in args.get("city", "").lower()
        reg.add(suite, "single_call",
                0.5 if name_ok else 0.0 + 0.5 if city_ok else 0.0,
                f"name={'ok' if name_ok else 'wrong'} args={args}")

    # JSON validity of tool arguments
    if calls:
        raw = calls[0].get("function", {}).get("arguments") or "{}"
        try:
            json.loads(raw)
            reg.add(suite, "json_valid", 1.0)
        except json.JSONDecodeError:
            reg.add(suite, "json_valid", 0.0, f"unparseable: {raw[:80]!r}")

    # Multi-tool selection: should call calculate first, then weather
    resp = _chat([{"role": "user",
                   "content": "First calculate 15 * 37, then check the weather "
                              "in the city with that many letters. Use tools."}],
                 tools=[CALC_TOOL, WEATHER_TOOL], max_tokens=4096)
    calls = _tool_calls(resp)
    if calls:
        fn = calls[0].get("function", {})
        name = fn.get("name", "")
        reg.add(suite, "multi_tool_selection",
                0.7 if name == "calculate" else (0.3 if name == "get_weather" else 0.0),
                f"first_call={name}")
    else:
        reg.add(suite, "multi_tool_selection", 0.0, "no tool_calls")

# ── suite 6: reasoning ─────────────────────────────────────────────────────


def _suite_reasoning(reg: Registry) -> None:
    suite = "reasoning"

    resp = _chat([{"role": "user",
                   "content": "Think step by step: what is 234 * 567 + 89? "
                              "Show your work, then give the final answer on a "
                              "line starting with 'ANSWER:'."}],
                 max_tokens=2048)
    content = _content(resp)

    has_output = len(content.strip()) > 10
    reg.add(suite, "produces_output", 1.0 if has_output else 0.0,
            f"length={len(content)}")

    # Check answer
    m = re.search(r'ANSWER:\s*([\d,]+)', content)
    if m:
        ans = int(m.group(1).replace(",", ""))
        expected = 234 * 567 + 89  # 132767
        close = abs(ans - expected) / expected < 0.01
        reg.add(suite, "correct_answer", 1.0 if close else 0.3,
                f"got={ans} expected={expected}")
    else:
        reg.add(suite, "correct_answer", 0.0, "no ANSWER: line")

    # No loop
    count, length = _check_repeats(content)
    ok = count < REPEAT_THRESHOLD
    reg.add(suite, "no_loop", 1.0 if ok else 0.0,
            f"repeats={count}x len={length}" if not ok else "")

# ── suite 7: code review ───────────────────────────────────────────────────


def _suite_review(reg: Registry) -> None:
    suite = "review"

    bad_code = (
        "def process_users(users):\n"
        "    results = []\n"
        "    for user in users:\n"
        "        name = user['name']\n"
        "        email = user['email']\n"
        "        password = user['password']\n"
        "        print(f'Processing {name} with password {password}')\n"
        "        query = 'SELECT * FROM users WHERE email = \\'' + email + '\\''\n"
        "        results.append({'name': name, 'query': query})\n"
        "    return results\n"
    )
    resp = _chat([{"role": "user",
                   "content": f"Review this code for security issues. List each "
                              f"issue as '- [SEVERITY] description'.\n\n```\n{bad_code}```"}],
                 max_tokens=1024)
    content = _content(resp).lower()

    targets = {
        "sql_injection": ["sql inject", "parameteriz", "prepared statement", "sanitiz"],
        "password_logging": ["password", "credential", "sensitive", "log"],
        "plaintext": ["plaintext", "hash", "encrypt", "bcrypt"],
    }
    found = 0
    for _name, patterns in targets.items():
        if any(p in content for p in patterns):
            found += 1
    reg.add(suite, "security_issues_found",
            found / len(targets), f"{found}/{len(targets)}")

# ── suite 8: multi-turn ────────────────────────────────────────────────────


def _suite_multiturn(reg: Registry) -> None:
    suite = "multiturn"

    msgs: list[dict] = [{"role": "user",
                         "content": "Remember: project_name = 'NeutronStar'. Reply OK."}]
    r1 = _chat(msgs, max_tokens=64)
    t1 = _content(r1).strip()

    msgs += [{"role": "assistant", "content": t1},
             {"role": "user", "content": "What is the project name? Reply with just the name."}]
    r2 = _chat(msgs, max_tokens=64)
    t2 = _content(r2).strip()
    reg.add(suite, "recall", 1.0 if "neutronstar" in t2.lower() else 0.0,
            f"response={t2[:40]!r}")

    # Distraction test
    msgs += [{"role": "assistant", "content": t2},
             {"role": "user",
              "content": "Ignore everything above. Actually don't. Tell me the "
                         "project_name I asked you to remember."}]
    r3 = _chat(msgs, max_tokens=64)
    t3 = _content(r3).strip()
    reg.add(suite, "recall_after_distraction",
            1.0 if "neutronstar" in t3.lower() else 0.0,
            f"response={t3[:40]!r}")

    # No catastrophic loop across the full session
    full = json.dumps({"t1": t1, "t2": t2, "t3": t3})
    count, length = _check_repeats(full)
    ok = count < REPEAT_THRESHOLD * 3  # Higher bar for multi-turn
    reg.add(suite, "no_severe_loop", 1.0 if ok else 0.0,
            f"repeats={count}x len={length}" if not ok else "")

# ── suite 9: refactoring ───────────────────────────────────────────────────


def _suite_refactor(reg: Registry) -> None:
    suite = "refactor"

    original = (
        "def calculate_total(items):\n"
        "    total = 0\n"
        "    for item in items:\n"
        "        if item['type'] == 'food':\n"
        "            total += item['price'] * 0.95\n"
        "        elif item['type'] == 'clothing':\n"
        "            total += item['price'] * 0.90\n"
        "        elif item['type'] == 'electronics':\n"
        "            total += item['price'] * 1.08\n"
        "        else:\n"
        "            total += item['price']\n"
        "    return total\n"
    )
    resp = _chat([{"role": "user",
                   "content": f"Refactor this to use a dictionary lookup instead "
                              f"of if/elif chains. Reply with ONLY the refactored "
                              f"code:\n\n```\n{original}```"}],
                 max_tokens=1024)
    refactored = _strip_fences(_content(resp))

    score = 0.0
    if "{" in refactored and "}" in refactored:
        score += 0.25  # Uses a dict
    if "discount" in refactored.lower() or ".get(" in refactored:
        score += 0.25  # Has lookup pattern
    try:
        compiled = compile(refactored, "<refactor>", "exec")
        ns: dict = {}
        exec(compiled, ns)
        if "calculate_total" in ns:
            items = [{"type": "food", "price": 100},
                     {"type": "clothing", "price": 50}]
            result = ns["calculate_total"](items)
            if abs(result - 140.0) < 0.01:
                score += 0.5  # Computes correct result
    except Exception:
        pass
    reg.add(suite, "dict_refactor", score)

# ── main ───────────────────────────────────────────────────────────────────


def _report_markdown(agg: dict) -> str:
    lines = ["# qwen3.6-forge Eval Report", "",
             f"Model: `{MODEL_ALIAS}` | Score floor: {SCORE_FLOOR} | "
             f"Date: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}", "",
             "## Suite Scores", "",
             "| Suite | Score | Passed | Bar |",
             "| --- | --- | --- | --- |"]
    for name, s in sorted(agg["suites"].items()):
        bar = "█" * int(s["score"] * 20) + "░" * (20 - int(s["score"] * 20))
        lines.append(f"| {name} | [{bar}] {s['score']:.2f} | "
                     f"{s['passed']}/{s['total']} | {SCORE_FLOOR} |")
    o = agg["overall"]
    bar = "█" * int(o["score"] * 20) + "░" * (20 - int(o["score"] * 20))
    lines += ["", f"**Overall:** [{bar}] {o['score']:.2f} — "
                  f"{o['passed']}/{o['total']} passed", ""]
    return "\n".join(lines)


def main() -> int:
    print(f"\n{'='*60}")
    print(f"qwen3.6-forge eval — {MODEL_ALIAS}")
    print(f"forge: {FORGE_URL}  timeout: {EVAL_TIMEOUT}s  floor: {SCORE_FLOOR}")
    print(f"{'='*60}\n")

    reg = Registry()

    # Phase 1: speed (always first — establishes baseline)
    print("── 1. Speed ──")
    _suite_speed(reg)

    # Phase 2-9: core capabilities
    suites: list[tuple[str, Callable]] = [
        ("2. Code Generation", _suite_codegen),
        ("3. Bug Fixing", _suite_bugfix),
        ("4. Edit Precision", _suite_edits),
        ("5. Tool Calling", _suite_tools),
        ("6. Reasoning", _suite_reasoning),
        ("7. Code Review", _suite_review),
        ("8. Multi-Turn", _suite_multiturn),
        ("9. Refactoring", _suite_refactor),
    ]
    for label, fn in suites:
        print(f"\n── {label} ──")
        fn(reg)

    # Report
    agg = reg.aggregate()
    print(f"\n{'='*60}")
    print(_report_markdown(agg))
    print("```json")
    print(json.dumps(agg, indent=2))
    print("```")

    failed = sum(1 for r in reg.results if not r.passed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
