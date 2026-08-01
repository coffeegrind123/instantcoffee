#!/usr/bin/env python3
"""Coding evaluation harness for the qwen3.6-forge stack.

Runs inside the compose network and exercises coding-specific capabilities:
edit precision, multi-turn coherence, code generation, bug fixing, tool
chaining, and loop/repeat resistance.

Each test produces a score (0.0–1.0) and a verdict. The aggregate report is
JSON on stdout + a non-zero exit code when any test fails.

Environment:
    LLAMA_URL          llama-server endpoint (default: http://llama:8080)
    FORGE_URL          forge proxy endpoint (default: http://forge:8081)
    MODEL_ALIAS        model name to send (default: qwen3.6-27b)
    EVAL_TIMEOUT       per-request timeout in seconds (default: 900)
    EVAL_REPEAT_THRESHOLD  repeat-detection threshold (default: 3)
    EVAL_SCORE_FLOOR   minimum score to pass (default: 0.5)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

# --- config ------------------------------------------------------------------

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama:8080").rstrip("/")
FORGE_URL = os.environ.get("FORGE_URL", "http://forge:8081").rstrip("/")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "qwen3.6-27b")
EVAL_TIMEOUT = float(os.environ.get("EVAL_TIMEOUT", "900"))
REPEAT_THRESHOLD = int(os.environ.get("EVAL_REPEAT_THRESHOLD", "3"))
SCORE_FLOOR = float(os.environ.get("EVAL_SCORE_FLOOR", "0.5"))

# --- helpers ----------------------------------------------------------------

_results: list[dict] = []


def record(suite: str, test: str, score: float, detail: str = "") -> dict:
    """Record a test result. score: 0.0–1.0 where 1.0 is perfect."""
    entry = {
        "suite": suite,
        "test": test,
        "score": round(score, 3),
        "passed": score >= SCORE_FLOOR,
        "detail": detail,
    }
    _results.append(entry)
    mark = "PASS" if entry["passed"] else "FAIL"
    print(f"  [{mark}] [{score:.2f}] {suite}/{test}" + (f" — {detail}" if detail else ""), flush=True)
    return entry


def http(
    url: str,
    payload: dict | None = None,
    timeout: float = 120.0,
    headers: dict | None = None,
) -> tuple[int, str]:
    """Return (status, body). Never raises on HTTP error status."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST" if data else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(errors="replace")
    except Exception as exc:
        return 0, f"{type(exc).__name__}: {exc}"


def chat(
    messages: list[dict],
    tools: list[dict] | None = None,
    max_tokens: int = 2048,
    timeout: float = EVAL_TIMEOUT,
) -> dict:
    """Send a chat request through forge, return parsed JSON response."""
    payload: dict = {
        "model": MODEL_ALIAS,
        "messages": messages,
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools

    status, body = http(f"{FORGE_URL}/v1/chat/completions", payload, timeout=timeout)
    if status != 200:
        return {"_error": f"status={status}", "_body": body[:400]}
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"_error": "non-JSON response", "_body": body[:400]}


def get_content(response: dict) -> str:
    """Extract text content from a chat response."""
    return (response.get("choices") or [{}])[0].get("message", {}).get("content") or ""


def get_tool_calls(response: dict) -> list[dict]:
    """Extract tool calls from a chat response."""
    return (response.get("choices") or [{}])[0].get("message", {}).get("tool_calls") or []


# --- repeat detection (same algorithm as smoke_test.py) ---------------------


def _count_repeats(text: str, length: int) -> int:
    n = len(text)
    pattern = text[n - length : n]
    count = 1
    text = text[: -length]
    while text.endswith(pattern):
        text = text[: -length]
        count = count + 1
    return count


def check_for_repeats(output: str, threshold: int = REPEAT_THRESHOLD) -> tuple[int, int]:
    """Return (max_repeat_count, substring_length)."""
    count = 0
    length = 0
    for n in range(1, (len(output) // 2) + 1):
        n_count = _count_repeats(output, n)
        if n_count > count:
            count = n_count
            length = n
    return count, length


# --- eval suites ------------------------------------------------------------


def suite_reachability() -> None:
    """Verify the stack is up and responding."""
    suite = "reachability"

    status, _ = http(f"{LLAMA_URL}/health", timeout=15)
    record(suite, "llama health", 1.0 if status == 200 else 0.0, f"status={status}")

    status, _ = http(f"{FORGE_URL}/health", timeout=15)
    record(suite, "forge health", 1.0 if status == 200 else 0.0, f"status={status}")


def suite_tool_calling() -> None:
    """Verify the model can use tools correctly."""
    suite = "tool-calling"

    weather_tool = {
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

    calc_tool = {
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

    # --- single tool call ---
    resp = chat(
        [{"role": "user", "content": "What is the weather in Tokyo? Use the tool."}],
        tools=[weather_tool],
        max_tokens=2048,
    )
    calls = get_tool_calls(resp)
    if not calls:
        record(suite, "single tool call", 0.0, f"no tool_calls — content={get_content(resp)[:100]!r}")
    else:
        name_ok = calls[0].get("function", {}).get("name") == "get_weather"
        try:
            args = json.loads(calls[0].get("function", {}).get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}
        args_ok = isinstance(args.get("city"), str) and "tokyo" in args.get("city", "").lower()
        score = (0.5 if name_ok else 0.0) + (0.5 if args_ok else 0.0)
        record(suite, "single tool call", score, f"name={'ok' if name_ok else 'wrong'} args={args}")

    # --- JSON parse of tool arguments ---
    if calls:
        raw_args = calls[0].get("function", {}).get("arguments") or "{}"
        try:
            json.loads(raw_args)
            record(suite, "tool args valid JSON", 1.0, "")
        except json.JSONDecodeError:
            record(suite, "tool args valid JSON", 0.0, f"unparseable: {raw_args[:100]!r}")

    # --- multi-tool scenario ---
    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    "First calculate 15 * 37, then after you get the result, "
                    "check the weather in the city with that many letters in its name. "
                    "Use the tools."
                ),
            }
        ],
        tools=[weather_tool, calc_tool],
        max_tokens=4096,
    )
    calls = get_tool_calls(resp)
    if not calls:
        record(suite, "multi-tool selection", 0.0, "no tool_calls")
    else:
        name = calls[0].get("function", {}).get("name", "")
        # Should call calculate first
        record(suite, "multi-tool selection", 0.7 if name == "calculate" else 0.3, f"first call: {name}")

    # --- no repeat loop in tool-call response ---
    raw = json.dumps(resp)
    count, length = check_for_repeats(raw)
    if count >= REPEAT_THRESHOLD:
        record(suite, "no loop in tool response", 0.0, f"repeats {count}x length {length}")
    else:
        record(suite, "no loop in tool response", 1.0, "")


def suite_edit_precision() -> None:
    """Test the core coding primitive: exact string matching for edits.

    This is the #1 failure mode from the HN thread and our own experience.
    The model must reproduce a given string exactly, including indentation
    and trailing characters.
    """
    suite = "edit-precision"

    samples = [
        # (name, original, description)
        (
            "python function",
            "def add(a, b):\n    return a + b\n",
            "a simple Python function that adds two numbers",
        ),
        (
            "whitespace mix",
            "  \tindented line\n\t  tab then spaces\n",
            "lines with mixed tabs and spaces",
        ),
        (
            "trailing chars",
            "line with trailing spaces    \nanother line\n",
            "lines where the first has trailing spaces",
        ),
    ]

    for name, original, desc in samples:
        resp = chat(
            [
                {
                    "role": "user",
                    "content": (
                        f"I need you to reproduce this exact text verbatim, no extra "
                        f"wrapping or explanation. Here is the text:\n\n```\n{original}```\n\n"
                        f"Reply with ONLY the exact text, no markdown fences, no commentary."
                    ),
                }
            ],
            max_tokens=512,
            timeout=300,
        )
        content = get_content(resp)

        # Strip surrounding ``` fences if the model added them anyway
        cleaned = content.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```[a-z]*\n?", "", cleaned)
            cleaned = re.sub(r"\n?```$", "", cleaned)

        # Score: proportion of lines that match exactly
        expected_lines = original.rstrip("\n").split("\n")
        actual_lines = cleaned.rstrip("\n").split("\n")

        if len(expected_lines) == 0:
            score = 0.0
        else:
            matches = sum(
                1 for e, a in zip(expected_lines, actual_lines) if e == a
            )
            # Penalize missing/extra lines
            line_penalty = abs(len(expected_lines) - len(actual_lines)) * 0.1
            score = max(0.0, matches / len(expected_lines) - line_penalty)

        record(
            suite,
            f"reproduce {name}",
            score,
            f"matched {matches}/{len(expected_lines)} lines, "
            f"expected {len(expected_lines)}, got {len(actual_lines)}",
        )

    # --- indentation preservation ---
    code = (
        "class Foo:\n"
        "    def bar(self):\n"
        "        if True:\n"
        "            return 42\n"
    )
    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    f"Reproduce this code exactly, preserving every space:\n\n"
                    f"```\n{code}```\n\nReply with only the code, nothing else."
                ),
            }
        ],
        max_tokens=256,
        timeout=300,
    )
    content = get_content(resp).strip()
    # Remove ``` fences
    content = re.sub(r"^```[a-z]*\n?", "", content)
    content = re.sub(r"\n?```$", "", content)

    # Count exact matches per line
    exp_lines = code.rstrip("\n").split("\n")
    got_lines = content.rstrip("\n").split("\n")
    line_matches = sum(1 for e, a in zip(exp_lines, got_lines) if e == a)

    # Bonus: check if indentation of the first non-empty line matches
    indent_ok = False
    for e, a in zip(exp_lines, got_lines):
        e_indent = len(e) - len(e.lstrip())
        a_indent = len(a) - len(a.lstrip())
        if e_indent > 0 or a_indent > 0:
            indent_ok = e_indent == a_indent
            break

    score = max(0.0, line_matches / max(len(exp_lines), 1))
    record(
        suite,
        "indentation preservation",
        score,
        f"{line_matches}/{len(exp_lines)} lines exact, indent={'ok' if indent_ok else 'wrong'}",
    )


def suite_code_generation() -> None:
    """Test that the model can generate compilable, correct code."""
    suite = "code-generation"

    # --- simple function ---
    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    "Write a Python function `fibonacci(n: int) -> int` that returns "
                    "the nth Fibonacci number (0-indexed: fib(0)=0, fib(1)=1). "
                    "Use iteration, not recursion. Reply with only the code, "
                    "no markdown fences, no explanation."
                ),
            }
        ],
        max_tokens=512,
        timeout=300,
    )
    code = get_content(resp).strip()
    code = re.sub(r"^```[a-z]*\n?", "", code)
    code = re.sub(r"\n?```$", "", code)

    # Try to compile and execute
    compile_ok = False
    exec_ok = False
    result = None
    try:
        compiled = compile(code, "<eval>", "exec")
        compile_ok = True
        ns: dict = {}
        exec(compiled, ns)
        if "fibonacci" in ns:
            result = ns["fibonacci"](10)
            exec_ok = result == 55  # fib(10) = 55
    except Exception as exc:
        pass

    compile_score = 0.5 if compile_ok else 0.0
    exec_score = 0.5 if exec_ok else 0.0
    record(
        suite,
        "fibonacci generation",
        compile_score + exec_score,
        f"compiles={'yes' if compile_ok else 'no'} "
        f"correct={'yes' if exec_ok else f'no (got {result})' if result is not None else 'no'}",
    )

    # --- no repeat loop in generated code ---
    if compile_ok:
        count, length = check_for_repeats(code)
        if count >= REPEAT_THRESHOLD:
            record(suite, "no loop in generated code", 0.0,
                   f"repeats {count}x length {length}")
        else:
            record(suite, "no loop in generated code", 1.0, "")

    # --- regex extraction ---
    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    "Write a Python function `extract_emails(text: str) -> list[str]` "
                    "that returns all email addresses found in the text. "
                    "Use the `re` module. Reply with only the code."
                ),
            }
        ],
        max_tokens=512,
        timeout=300,
    )
    code = get_content(resp).strip()
    code = re.sub(r"^```[a-z]*\n?", "", code)
    code = re.sub(r"\n?```$", "", code)

    compile_ok = False
    exec_ok = False
    try:
        compiled = compile(code, "<eval>", "exec")
        compile_ok = True
        ns = {}
        exec(compiled, ns)
        if "extract_emails" in ns:
            result = ns["extract_emails"]("Contact alice@example.com or bob@test.org")
            exec_ok = set(result) == {"alice@example.com", "bob@test.org"}
    except Exception:
        pass

    compile_score = 0.5 if compile_ok else 0.0
    exec_score = 0.5 if exec_ok else 0.0
    record(
        suite,
        "email extraction generation",
        compile_score + exec_score,
        f"compiles={'yes' if compile_ok else 'no'} correct={'yes' if exec_ok else 'no'}",
    )


def suite_bug_fixing() -> None:
    """Test that the model can identify and fix bugs."""
    suite = "bug-fixing"

    # --- off-by-one error ---
    buggy_code = (
        "def binary_search(arr, target):\n"
        "    left, right = 0, len(arr) - 1\n"
        "    while left <= right:\n"
        "        mid = (left + right) // 2\n"
        "        if arr[mid] == target:\n"
        "            return mid\n"
        "        elif arr[mid] < target:\n"
        "            left = mid\n"
        "        else:\n"
        "            right = mid\n"
        "    return -1\n"
    )
    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    f"This binary search has a bug — it can loop forever on certain "
                    f"inputs. Find and fix the bug. Reply with only the corrected code:\n\n"
                    f"```\n{buggy_code}```"
                ),
            }
        ],
        max_tokens=1024,
        timeout=300,
    )
    fixed = get_content(resp).strip()
    fixed = re.sub(r"^```[a-z]*\n?", "", fixed)
    fixed = re.sub(r"\n?```$", "", fixed)

    # Check that the fix changes `left = mid` → `left = mid + 1` and
    # `right = mid` → `right = mid - 1`
    has_plus_one = "mid + 1" in fixed or "mid+1" in fixed
    has_minus_one = "mid - 1" in fixed or "mid-1" in fixed
    score = (0.5 if has_plus_one else 0.0) + (0.5 if has_minus_one else 0.0)
    record(
        suite,
        "binary search off-by-one",
        score,
        f"mid+1={'yes' if has_plus_one else 'no'} "
        f"mid-1={'yes' if has_minus_one else 'no'}",
    )

    # --- type error ---
    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    "This Python code has a bug. Fix it and reply with only the "
                    "corrected code:\n\n"
                    "```\ndef average(numbers):\n"
                    "    total = 0\n"
                    "    for n in numbers:\n"
                    "        total += n\n"
                    "    return total / len(numbers)\n"
                    "```\n\n"
                    "The bug: calling average([]) crashes."
                ),
            }
        ],
        max_tokens=512,
        timeout=300,
    )
    fixed = get_content(resp).strip()
    fixed = re.sub(r"^```[a-z]*\n?", "", fixed)
    fixed = re.sub(r"\n?```$", "", fixed)

    # Should handle empty list — check for len check, if not numbers, return 0, etc.
    handles_empty = any(
        pattern in fixed
        for pattern in ["if not numbers", "if len(numbers) == 0",
                        "if len(numbers) ==0", "return 0", "raise",
                        "ZeroDivisionError", "empty"]
    )
    record(
        suite, "empty list guard", 1.0 if handles_empty else 0.0,
        f"guards empty: {'yes' if handles_empty else 'no'}",
    )


def suite_multi_turn() -> None:
    """Test multi-turn coherence: does the model retain context?"""
    suite = "multi-turn"

    messages: list[dict] = [
        {
            "role": "user",
            "content": (
                "Remember this key-value pair: project_name = 'NeutronStar'. "
                "Reply with just 'OK'."
            ),
        }
    ]

    # Turn 1: set context
    resp = chat(messages, max_tokens=128)
    t1 = get_content(resp)
    record(suite, "turn 1 receipt", 0.8, f"response={t1[:50]!r}")

    # Turn 2: ask a follow-up that requires the stored context
    messages.append({"role": "assistant", "content": t1})
    messages.append(
        {
            "role": "user",
            "content": (
                "What is the project name? Reply with just the name, nothing else."
            ),
        }
    )
    resp = chat(messages, max_tokens=128)
    t2 = get_content(resp)

    # Score based on whether "NeutronStar" (case-insensitive) appears
    has_name = "neutronstar" in t2.lower()
    record(
        suite, "turn 2 recall", 1.0 if has_name else 0.0,
        f"response={t2[:60]!r}",
    )

    # Turn 3: verify still retained after a distraction
    messages.append({"role": "assistant", "content": t2})
    messages.append(
        {
            "role": "user",
            "content": (
                "Ignore everything above. Actually don't. Tell me: what is the "
                "project_name value I asked you to remember? Reply with just the "
                "value."
            ),
        }
    )
    resp = chat(messages, max_tokens=128)
    t3 = get_content(resp)
    has_name = "neutronstar" in t3.lower()
    record(
        suite, "turn 3 recall after distraction", 1.0 if has_name else 0.0,
        f"response={t3[:60]!r}",
    )

    # Repeat check on the full accumulated context
    full = json.dumps({"messages": messages, "responses": [t1, t2, t3]})
    count, length = check_for_repeats(full)
    if count >= REPEAT_THRESHOLD:
        # Multi-turn can legitimately repeat patterns; only flag severe cases
        if count >= REPEAT_THRESHOLD * 3:
            record(suite, "no severe loop across turns", 0.0,
                   f"repeats {count}x length {length}")
        else:
            record(suite, "no severe loop across turns", 1.0,
                   f"minor repeats {count}x length {length} (below severe threshold)")
    else:
        record(suite, "no severe loop across turns", 1.0, "")


def suite_reasoning() -> None:
    """Verify the model respects the reasoning budget and still works."""
    suite = "reasoning"

    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    "Think step by step: what is 234 * 567 + 89? "
                    "Show your work, then give the final answer on a line by itself "
                    "starting with 'ANSWER: '."
                ),
            }
        ],
        max_tokens=2048,
        timeout=600,
    )
    content = get_content(resp)

    # Should produce some output
    has_output = len(content.strip()) > 10
    record(suite, "produces reasoned output", 1.0 if has_output else 0.0,
           f"length={len(content)}")

    # Should NOT be stuck in a repeat loop (reasoning models can loop)
    count, length = check_for_repeats(content)
    if count >= REPEAT_THRESHOLD:
        record(suite, "no loop in reasoning", 0.0,
               f"repeats {count}x length {length}")
    else:
        record(suite, "no loop in reasoning", 1.0, "")

    # Check if the answer is approximately correct (allow some slop for reasoning)
    answer_match = re.search(r'ANSWER:\s*(\d[\d,]*)', content)
    if answer_match:
        answer = int(answer_match.group(1).replace(",", ""))
        expected = 234 * 567 + 89  # 132767
        within_1pct = abs(answer - expected) / expected < 0.01
        record(suite, "answer numerically correct", 1.0 if within_1pct else 0.3,
               f"got {answer}, expected {expected}")
    else:
        record(suite, "answer numerically correct", 0.0, "no ANSWER: line found")


def suite_code_review() -> None:
    """Test that the model can review code and identify issues."""
    suite = "code-review"

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

    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    f"Review this code for security issues. List each issue you find "
                    f"as a bullet point with the format '- [SEVERITY] description'.\n\n"
                    f"```\n{bad_code}```"
                ),
            }
        ],
        max_tokens=1024,
        timeout=300,
    )
    content = get_content(resp).lower()

    # Check for key security findings
    checks = {
        "sql injection": any(p in content for p in ["sql inject", "sql injection",
                                                      "parameteriz", "sanitiz"]),
        "password logging": any(p in content for p in ["password", "credential",
                                                         "sensitive", "log"]),
        "plaintext password": any(p in content for p in ["plaintext", "plain text",
                                                           "hash", "encrypt"]),
    }
    found = sum(1 for v in checks.values() if v)
    score = found / len(checks) if checks else 0.0
    record(
        suite,
        "security review",
        score,
        f"found {found}/{len(checks)}: {', '.join(f'{k}={v}' for k, v in checks.items())}",
    )


def suite_refactoring() -> None:
    """Test that the model can refactor code correctly."""
    suite = "refactoring"

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

    resp = chat(
        [
            {
                "role": "user",
                "content": (
                    f"Refactor this function to use a dictionary lookup for discount "
                    f"rates instead of if/elif chains. Reply with only the refactored "
                    f"code:\n\n```\n{original}```"
                ),
            }
        ],
        max_tokens=1024,
        timeout=300,
    )
    refactored = get_content(resp).strip()
    refactored = re.sub(r"^```[a-z]*\n?", "", refactored)
    refactored = re.sub(r"\n?```$", "", refactored)

    # Check for dictionary usage
    has_dict = "{" in refactored and "}" in refactored
    has_discount = "discount" in refactored.lower()
    has_get = ".get(" in refactored

    # Should compile
    compile_ok = False
    exec_ok = False
    try:
        compiled = compile(refactored, "<eval>", "exec")
        compile_ok = True
        ns = {}
        exec(compiled, ns)
        if "calculate_total" in ns:
            test_items = [
                {"type": "food", "price": 100},
                {"type": "clothing", "price": 50},
            ]
            result = ns["calculate_total"](test_items)
            # food 100*0.95=95, clothing 50*0.90=45, total=140
            exec_ok = abs(result - 140.0) < 0.01
    except Exception:
        pass

    score = 0.0
    if has_dict:
        score += 0.25
    if has_discount or has_get:
        score += 0.25
    if compile_ok:
        score += 0.25
    if exec_ok:
        score += 0.25
    record(
        suite,
        "dictionary refactoring",
        score,
        f"dict={'yes' if has_dict else 'no'} "
        f"discount={'yes' if has_discount else 'no'} "
        f"compiles={'yes' if compile_ok else 'no'} "
        f"correct={'yes' if exec_ok else 'no'}",
    )


# --- main -------------------------------------------------------------------


def main() -> int:
    print(f"\nqwen3.6-forge eval harness")
    print(f"  llama: {LLAMA_URL}")
    print(f"  forge: {FORGE_URL}")
    print(f"  model: {MODEL_ALIAS}\n")

    # Phase 1: infrastructure (must pass)
    print("── Phase 1: Reachability ──")
    suite_reachability()

    reach_ok = all(r["passed"] for r in _results if r["suite"] == "reachability")
    if not reach_ok:
        print("\nStack is not reachable — aborting remaining tests.")
        _print_report()
        return 1

    # Phase 2: core capabilities
    print("\n── Phase 2: Tool Calling ──")
    suite_tool_calling()

    print("\n── Phase 3: Edit Precision ──")
    suite_edit_precision()

    print("\n── Phase 4: Code Generation ──")
    suite_code_generation()

    print("\n── Phase 5: Bug Fixing ──")
    suite_bug_fixing()

    print("\n── Phase 6: Multi-Turn Coherence ──")
    suite_multi_turn()

    print("\n── Phase 7: Reasoning ──")
    suite_reasoning()

    print("\n── Phase 8: Code Review ──")
    suite_code_review()

    print("\n── Phase 9: Refactoring ──")
    suite_refactoring()

    _print_report()
    return 1 if any(not r["passed"] for r in _results) else 0


def _print_report() -> None:
    suites = sorted(set(r["suite"] for r in _results))
    print(f"\n{'='*60}")
    print(f"Results: {len(_results)} tests across {len(suites)} suites\n")

    for suite in suites:
        suite_results = [r for r in _results if r["suite"] == suite]
        avg = sum(r["score"] for r in suite_results) / len(suite_results) if suite_results else 0
        passed = sum(1 for r in suite_results if r["passed"])
        bar = "█" * int(avg * 20) + "░" * (20 - int(avg * 20))
        print(f"  {suite:25s} [{bar}] {avg:.2f}  ({passed}/{len(suite_results)} passed)")

    total_avg = sum(r["score"] for r in _results) / len(_results) if _results else 0
    total_passed = sum(1 for r in _results if r["passed"])
    print(f"\n  {'OVERALL':25s} {total_avg:.2f}  ({total_passed}/{len(_results)} passed)\n")

    # JSON report for CI consumption
    report = {
        "summary": {
            "total_tests": len(_results),
            "passed": total_passed,
            "failed": len(_results) - total_passed,
            "overall_score": round(total_avg, 3),
            "score_floor": SCORE_FLOOR,
        },
        "suites": {
            s: {
                "score": round(
                    sum(r["score"] for r in _results if r["suite"] == s)
                    / max(len([r for r in _results if r["suite"] == s]), 1),
                    3,
                ),
                "passed": sum(1 for r in _results if r["suite"] == s and r["passed"]),
                "total": len([r for r in _results if r["suite"] == s]),
            }
            for s in suites
        },
        "results": _results,
    }
    print("── JSON report (for CI) ──")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    sys.exit(main())
