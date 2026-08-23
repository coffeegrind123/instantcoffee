#!/usr/bin/env python3
"""Reasoning effort vs ANSWER QUALITY — objective pass/fail, not output volume.

Runs INSIDE the compose network like bench.py:

    docker compose --profile tools run --rm --build \
        --entrypoint python bench /work/scripts/bench_quality.py

WHY THIS EXISTS
---------------
The first pass at "which reasoning_effort should this stack run?" compared
reasoning-token count against CONTENT LENGTH and concluded medium gave the
"best answer per token". That was the wrong metric. The complaint about Qwen 3.8
at xhigh (Simon Willison, 2026-08-16) is not that the answer is short — it is
that the answer is MASSIVELY OVER-ENGINEERED. More content can therefore mean
worse, and a length comparison cannot see it at all.

This measures two things a length comparison cannot:

  * pass rate — each task carries hidden edge-case assertions; the model's code
                is extracted and EXECUTED against them. Correct or not; no
                judgement call, no LLM grader.
  * LOC       — non-blank lines of the accepted solution, as a direct
                over-engineering proxy. This is the axis actually in dispute.

Measured 2026-08-17 on Qwen3.8-27B-UD-Q4_K_XL (PRE-V3 weights), 5 tasks x 5
assertions:

    effort   pass%    LOC   reason_chars     wall
    none      84.0    164              0    23.3s
    low       96.0     63          9,007    48.3s
    medium   100.0     71         13,876    59.9s
    xhigh    100.0     99         41,489   244.4s

Re-measured 2026-08-23 on the Dynamic V3 weights, b10573, q8_0/q8_0, 96K:

    effort   pass%    LOC   reason_chars     wall
    none     100.0    142              0    21.6s
    low      100.0     74         12,529    63.0s
    medium   100.0     68         15,103    71.1s
    xhigh    100.0     84         43,582   274.1s

THIS BENCH IS NOW AT ITS CEILING. 100% at all four levels means the task set
can no longer tell them apart on CORRECTNESS; it discriminates only on LOC and
wall. Re-running it to re-decide REASONING_EFFORT will teach you nothing until
harder tasks are added — and adding one means writing its reference first.

The wall column of the V3 row was taken on a box at load 20 and is not
comparable with the 2026-08-17 figures. pass% and LOC are contention-proof,
which is the only reason this bench can be run on a busy box at all.

xhigh buys NOTHING over medium on correctness, costs 4x the wall clock, and
writes 40% more code — 39 lines for roman_to_int where low used 13. `none` is
worst on both axes at once: fewest passes AND the most sprawling code, because
with no planning phase it rambles. `low` writes the leanest correct code and is
a defensible choice if terseness is worth 4 points of pass rate; `medium` is
what this stack runs, because a coding agent's failure mode is a wrong function
rather than a verbose one.

THE CONTROL, WHICH IS NOT OPTIONAL — AND IS NOW ENFORCED
--------------------------------------------------------
A pass rate is only meaningful once a KNOWN-CORRECT solution scores 100%.
Otherwise a buggy assertion is indistinguishable from a model failure, in the
direction that flatters the harness.

This used to be a sentence in this docstring describing something a human did
once, in 2026-08-17, by hand. It is now CODE: REFERENCES below holds one
known-correct implementation per task, run() scores every one of them through
the same run_tests() the model output goes through, and main() REFUSES to run
the grid unless all of them are 5/5. `--control` runs just that check.

If you add a task, write its reference implementation in the same commit. You
will not be able to skip it — the grid will not start.

The control was itself controlled, 2026-08-23: one assertion was deliberately
broken (word_wrap('a b',10) expecting ['a','b']) and the check dropped that
task to 4/5 and refused the run. A control that cannot fail proves nothing.

Executing model-written code is why this runs in the throwaway bench container
and nowhere else.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

LLAMA = os.environ.get("LLAMA_URL", "http://llama:8080")
MODEL = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")
MAX_TOKENS = int(os.environ.get("QUALITY_MAX_TOKENS", "6000"))

# (name, spec, [(expression, expected_repr_source), ...])
TASKS = [
    (
        "merge_intervals",
        "Write a Python function merge_intervals(intervals) that merges overlapping closed "
        "intervals. Input is a list of [start,end] lists, unsorted, may be empty, may contain "
        "touching intervals like [1,2],[2,3] which MUST merge into [1,3]. Return a sorted list "
        "of [start,end] lists.",
        [
            ("merge_intervals([])", "[]"),
            ("merge_intervals([[1,3],[2,6],[8,10]])", "[[1,6],[8,10]]"),
            ("merge_intervals([[1,2],[2,3]])", "[[1,3]]"),
            ("merge_intervals([[5,6],[1,2]])", "[[1,2],[5,6]]"),
            ("merge_intervals([[1,10],[2,3]])", "[[1,10]]"),
        ],
    ),
    (
        "word_wrap",
        "Write a Python function word_wrap(text, width) returning a list of lines. Split on "
        "single spaces, never exceed width unless a single word is longer than width (then that "
        "word gets its own line, unbroken). Empty text returns []. Collapsing multiple spaces is "
        "NOT required.",
        [
            ("word_wrap('',5)", "[]"),
            ("word_wrap('a b c',1)", "['a','b','c']"),
            ("word_wrap('hello world',5)", "['hello','world']"),
            ("word_wrap('supercalifragilistic ab',5)", "['supercalifragilistic','ab']"),
            ("word_wrap('a b',10)", "['a b']"),
        ],
    ),
    (
        "roman_to_int",
        "Write a Python function roman_to_int(s) converting a Roman numeral to int. It must raise "
        "ValueError for invalid input such as 'IIII', 'VV', 'IL', or ''. Valid subtractive pairs "
        "are only IV IX XL XC CD CM.",
        [
            ("roman_to_int('III')", "3"),
            ("roman_to_int('MCMXCIV')", "1994"),
            ("_raises(lambda: roman_to_int('IIII'))", "True"),
            ("_raises(lambda: roman_to_int(''))", "True"),
            ("_raises(lambda: roman_to_int('IL'))", "True"),
        ],
    ),
    (
        "flatten_dict",
        "Write a Python function flatten_dict(d, sep='.') that flattens nested dicts into a "
        "single level, joining keys with sep. Empty dict values should vanish entirely (no key "
        "emitted). Lists are treated as leaf values, not recursed into.",
        [
            ("flatten_dict({})", "{}"),
            ("flatten_dict({'a':{'b':1}})", "{'a.b':1}"),
            ("flatten_dict({'a':{}})", "{}"),
            ("flatten_dict({'a':[1,2]})", "{'a':[1,2]}"),
            ("flatten_dict({'a':{'b':{'c':2}},'d':3})", "{'a.b.c':2,'d':3}"),
        ],
    ),
    (
        "next_permutation",
        "Write a Python function next_permutation(nums) that rearranges the list IN PLACE to the "
        "next lexicographically greater permutation, or the smallest permutation if none exists. "
        "Return None.",
        [
            ("_np([1,2,3])", "[1,3,2]"),
            ("_np([3,2,1])", "[1,2,3]"),
            ("_np([1,1,5])", "[1,5,1]"),
            ("_np([1])", "[1]"),
            ("_np([])", "[]"),
        ],
    ),
]

# Helpers the assertions rely on. _raises deliberately returns False for a
# non-ValueError exception: "it crashed somehow" is not "it validated".
HARNESS = """
def _raises(f):
    try:
        f(); return False
    except ValueError:
        return True
    except Exception:
        return False
def _np(x):
    next_permutation(x); return x
"""

# The control the docstring above calls non-optional, made runnable. One
# known-correct implementation per task, scored through the SAME run_tests()
# the model output goes through — so a buggy assertion fails HERE, as a
# reference failure, instead of showing up downstream as a model failure in
# the direction that flatters the harness.
REFERENCES = {
    "merge_intervals": '''
def merge_intervals(intervals):
    if not intervals:
        return []
    out = []
    for iv in sorted((list(x) for x in intervals), key=lambda x: (x[0], x[1])):
        s, e = iv
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out
''',
    "word_wrap": '''
def word_wrap(text, width):
    if not text:
        return []
    lines, cur = [], ""
    for w in text.split(" "):
        if not cur:
            cur = w
        elif len(cur) + 1 + len(w) <= width:
            cur += " " + w
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines
''',
    "roman_to_int": '''
import re as _re
_ROMAN = _re.compile(r"^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$")
_VALS = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}

def roman_to_int(s):
    if not isinstance(s, str) or not s or not _ROMAN.match(s):
        raise ValueError(s)
    total = 0
    for i, ch in enumerate(s):
        v = _VALS[ch]
        if i + 1 < len(s) and v < _VALS[s[i + 1]]:
            total -= v
        else:
            total += v
    return total
''',
    "flatten_dict": '''
def flatten_dict(d, sep="."):
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            for k2, v2 in flatten_dict(v, sep).items():
                out[str(k) + sep + str(k2)] = v2
        else:
            out[k] = v
    return out
''',
    "next_permutation": '''
def next_permutation(nums):
    n = len(nums)
    i = n - 2
    while i >= 0 and nums[i] >= nums[i + 1]:
        i -= 1
    if i >= 0:
        j = n - 1
        while nums[j] <= nums[i]:
            j -= 1
        nums[i], nums[j] = nums[j], nums[i]
    nums[i + 1:] = reversed(nums[i + 1:])
    return None
''',
}


def run_control() -> bool:
    """Score every reference implementation. True only if all are 5/5."""
    print("control — reference implementations through the real assertions")
    ok = True
    for tname, _spec, tests in TASKS:
        ref = REFERENCES.get(tname)
        if ref is None:
            print(f"  {tname:17} NO REFERENCE — add one before trusting this task")
            ok = False
            continue
        res = run_tests(ref, tests)
        n = sum(res)
        flag = "" if n == len(res) else "   <-- ASSERTION IS WRONG, NOT THE MODEL"
        print(f"  {tname:17} {n}/{len(res)}{flag}")
        if n != len(res):
            ok = False
    print("  control PASSED\n" if ok else "  control FAILED\n")
    return ok


LEVELS = [
    ("none", {"reasoning_effort": "none"}),
    ("low", {"chat_template_kwargs": {"reasoning_effort": "low"}}),
    ("medium", {"chat_template_kwargs": {"reasoning_effort": "medium"}}),
    ("xhigh", {"chat_template_kwargs": {"reasoning_effort": "xhigh"}}),
]


def extract_code(text: str) -> str:
    """Longest fenced block, or the whole reply if the model ignored the fence."""
    blocks = re.findall(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    return max(blocks, key=len) if blocks else text


def run_tests(code: str, tests) -> list[bool]:
    """Execute the candidate against the assertions in a separate interpreter.

    Every assertion is wrapped individually: one exploding must not mask the
    rest, or a single bad edge case would score as a total failure.
    """
    prog = code + "\n" + HARNESS + "\n_r=[]\n"
    for expr, expected in tests:
        prog += (
            f"try:\n    _r.append(repr({expr})==repr({expected}))\n"
            f"except Exception:\n    _r.append(False)\n"
        )
    prog += "import json;print('RESULT'+json.dumps(_r))\n"
    try:
        p = subprocess.run(
            [sys.executable, "-c", prog], capture_output=True, text=True, timeout=20
        )
        m = re.search(r"RESULT(\[.*\])", p.stdout)
        return json.loads(m.group(1)) if m else [False] * len(tests)
    except Exception:
        return [False] * len(tests)


def ask(prompt: str, extra: dict):
    body = {
        "model": MODEL,
        # Nonce so no run is served out of the prefix cache (bench.py, same reason).
        "messages": [
            {
                "role": "user",
                "content": f"[{time.time_ns()}] {prompt}\n\n"
                "Reply with one Python code block and nothing else.",
            }
        ],
        "max_tokens": MAX_TOKENS,
        "stream": False,
    }
    body.update(extra)
    req = urllib.request.Request(
        LLAMA + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=900) as resp:
        payload = json.loads(resp.read().decode())
    msg = (payload.get("choices") or [{}])[0].get("message") or {}
    return (
        msg.get("content") or "",
        len(msg.get("reasoning_content") or ""),
        time.monotonic() - started,
    )


def main() -> int:
    print(f"\nbench-quality — {MODEL} via {LLAMA}")
    print("pass rate is executed, not judged; LOC is the over-engineering proxy\n")

    # Never score a model against assertions that have not been shown to pass a
    # correct answer. A failing control makes every number below meaningless.
    control_ok = run_control()
    if "--control" in sys.argv:
        return 0 if control_ok else 1
    if not control_ok and "--force" not in sys.argv:
        print("refusing to run the grid on a broken harness (--force to override)")
        return 1

    agg = {}
    for name, extra in LEVELS:
        passed = total = loc = reason = empty = 0
        secs = 0.0
        for tname, spec, tests in TASKS:
            try:
                content, rchars, wall = ask(spec, extra)
            except Exception as exc:  # noqa: BLE001 - report, never abort the grid
                print(f"  {name:7} {tname:17} ERROR {type(exc).__name__}: {exc}")
                total += len(tests)
                continue
            if not content.strip():
                empty += 1
            code = extract_code(content)
            res = run_tests(code, tests)
            nloc = len([ln for ln in code.splitlines() if ln.strip()])
            passed += sum(res)
            total += len(res)
            loc += nloc
            secs += wall
            reason += rchars
            print(
                f"  {name:7} {tname:17} {sum(res)}/{len(res)}  loc={nloc:>3}  "
                f"wall={wall:5.1f}s"
            )
        agg[name] = (passed, total, loc, secs, reason, empty)

    print("\n=== EFFORT vs QUALITY ===")
    print(
        f"{'effort':8} {'tests passed':>14} {'pass%':>7} {'LOC':>6} "
        f"{'reason_ch':>10} {'total s':>9} {'empty':>6}"
    )
    for name, _ in LEVELS:
        p, t, loc, secs, reason, empty = agg[name]
        print(
            f"{name:8} {f'{p}/{t}':>14} {100 * p / max(t, 1):>6.1f}% {loc:>6} "
            f"{reason:>10} {secs:>8.1f}s {empty:>6}"
        )

    print(
        "\nRead LOC as over-engineering, not effort: a level that ties on pass rate\n"
        "while writing more code is producing a worse answer, which is the whole\n"
        "complaint about the xhigh default. `empty` counts turns that returned no\n"
        "content at all — xhigh can spend a whole budget thinking and answer nothing."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
