#!/usr/bin/env python3
"""Unit tests for the repeat/loop detector — no LLM required.

Run with: python3 scripts/test_repeat_detector.py
"""

from __future__ import annotations

import sys


def _count_repeats(text: str, length: int) -> int:
    """From scripts/smoke_test.py."""
    n = len(text)
    pattern = text[n - length : n]
    count = 1
    text = text[: -length]
    while text.endswith(pattern):
        text = text[: -length]
        count = count + 1
    return count


def check_for_repeats(output: str, threshold: int = 3) -> tuple[int, int]:
    """Return (max_repeat_count, substring_length)."""
    count = 0
    length = 0
    for n in range(1, (len(output) // 2) + 1):
        n_count = _count_repeats(output, n)
        if n_count > count:
            count = n_count
            length = n
    return count, length


# --- tests ------------------------------------------------------------------

PASSED = 0
FAILED = 0


def check(name: str, expected_count: int, text: str, threshold: int = 3) -> None:
    global PASSED, FAILED
    count, length = check_for_repeats(text, threshold)
    ok = count >= threshold if expected_count >= threshold else count < threshold
    if ok:
        PASSED += 1
        print(f"  PASS {name}: count={count}, length={length}")
    else:
        FAILED += 1
        print(f"  FAIL {name}: expected {'>=' if expected_count >= threshold else '<'} {threshold}, got count={count}, length={length}")


# --- the checks -------------------------------------------------------------
#
# Wrapped in a function, and the summary guarded by __main__, so that IMPORTING
# this module is side-effect free. Before 2026-08-31 both ran at import time and
# the module ended in sys.exit(), which aborts pytest COLLECTION -- not just
# this file, the entire suite. `pytest scripts/ -q` reported "no tests ran"
# while 124 tests sat there passing, and docs/context-budget.md already warns
# that a collection error is the one check that earns its place over all others.
# It still runs as a script exactly as it did: python3 scripts/test_repeat_detector.py

def _all_checks() -> None:
    global PASSED, FAILED
    PASSED = 0
    FAILED = 0
    # --- degenerate repeats (should be detected) ---------------------------------

    check("exact repeat x3",
         3,
         "hello hello hello ")

    check("exact repeat x5",
         5,
         "The error was: timeout\nThe error was: timeout\nThe error was: timeout\nThe error was: timeout\nThe error was: timeout\n")

    check("substring repeat at end",
         4,
         "OK, let me fix that.\nOK, let me fix that.\nOK, let me fix that.\nOK, let me fix that.")

    check("single char repeat",
         10,
         "aaaaaaaaaaa")  # 11 'a' chars

    check("two-char repeat",
         5,
         "()()()()()()")  # 6 pairs

    # --- legitimate code (should NOT be flagged) ---------------------------------

    check("indentation not a loop",
         0,  # expect count < threshold
         "    def foo():\n        pass\n    def bar():\n        pass\n    def baz():\n        pass\n")

    check("JSON response",
         0,
         '{"tool_calls":[{"function":{"name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"}}]}\n')

    check("normal code block",
         0,
         "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n")

    check("short repeated tokens (below threshold)",
         0,
         "});\n});\n")  # 2 repeats, threshold is 3

    # --- edge cases --------------------------------------------------------------

    check("empty string",
         0,
         "")

    check("single char",
         0,
         "x")

    check("newlines only (4 blank lines IS degenerate)",
         4,  # 4+ newlines in a row is a legitimate degenerate pattern
         "\n\n\n\n")

    # --- boundary: exactly at threshold ------------------------------------------

    check("exactly at threshold (3)",
         3,
         "abc abc abc ")

    check("one below threshold (2)",
         0,  # expect < 3
         "abc abc ")



def test_repeat_detector() -> None:
    """pytest entry point: the same checks, as one assertion."""
    _all_checks()
    assert FAILED == 0, f"{FAILED} of {PASSED + FAILED} repeat-detector checks failed"


if __name__ == "__main__":
    _all_checks()

    total = PASSED + FAILED
    print(f"\n{PASSED}/{total} passed", end="")
    if FAILED:
        print(f", {FAILED} FAILED")
        sys.exit(1)
    else:
        print(" — all good")
        sys.exit(0)
