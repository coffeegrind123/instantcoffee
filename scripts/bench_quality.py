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
assertions — see the note below the second table before comparing anything to
these:

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

BOTH ROWS ABOVE ARE ON THE FIVE-TASK SET, AND THAT SET HIT ITS CEILING. 100%
at all four levels means it could no longer tell them apart on CORRECTNESS —
only on LOC and wall — so re-running it to re-decide REASONING_EFFORT would
have taught nothing.

THREE HARDER TASKS WERE ADDED 2026-08-23: eval_expr, overlap_minutes,
parse_csv_line. The denominator is therefore 40, not 25, and NEITHER ROW ABOVE
IS COMPARABLE WITH ANY ROW MEASURED AFTER THAT DATE. They are kept because
they are what the `medium` decision was actually made on; do not read them
against a new run.

The three were chosen so that the OBVIOUS SHORTCUT passes most assertions and
fails the one that carries the contract — under-thinking and over-engineering
both have to cost correctness, or the task only measures verbosity. That claim
is not a guess; each shortcut was written and scored, 2026-08-23:

    eval_expr        `return float(eval(s))`        4/5  SyntaxError, not ValueError
    overlap_minutes  fromisoformat, no tz handling  3/5  naive vs aware TypeError,
                                                         and no start/end check
    parse_csv_line   `next(csv.reader([s]))`        4/5  accepts an unterminated quote

Adding a task still means writing its reference in the same commit. You will
not be able to skip it — the grid will not start.

FIRST RUN ON THE EIGHT-TASK SET, 2026-08-23 PM, V3 / b10573 / q8_0 / 96K:

    effort   pass%    LOC   reason_chars     wall
    none     100.0    283              0     36.3s
    low      100.0    205         30,235    136.9s
    medium   100.0    198         40,319    189.8s
    xhigh     90.0    254         83,868    495.7s

The tie is broken, and `xhigh` is the level that broke it — 36/40, the only
level below 100%, and simultaneously the second-most verbose. Every one of the
four lost assertions is eval_expr.

AND THEN THE PART THAT MATTERS MORE: THIS TASK SET IS NOT DETERMINISTIC.
The five-task set scored identically on every re-run; eval_expr does not, so a
single grid cell is ONE SAMPLE and must not be read as a level difference.
Re-run with --only eval_expr --level X --repeat N, which is what those flags
are for:

    medium   6 samples, 5 clean, one 3/5 at 89 LOC
    xhigh    5 samples, 3 clean, two 1/5 at 99 LOC

Directionally that is what the bench was built to detect and it is NOT
separable at n=5. Do not report "xhigh regressed" from one grid; report that
eval_expr fails sometimes at every level and somewhat more often at xhigh.

WHAT THE FAILURES ACTUALLY ARE, read with --show-code rather than guessed: a
99-line shunting-yard with a nested-closure precedence table that raises
ValueError on VALID input. Its per-assertion vector is [F,F,F,F,T] — all four
evaluations wrong, and the only assertion it passes is the one checking that
malformed input raises. A validator strict enough to reject everything scores
exactly like a careful implementation on the error contract and fails all the
work. That is over-engineering costing correctness rather than only lines,
which is the thing the five-task set could not show.

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
    # --- ADDED 2026-08-23, because the five above all scored 100% at every
    # effort level and a bench that cannot separate its levels is not measuring
    # anything. Each of these three has a SHORTCUT that passes most assertions
    # and fails the one that matters, so over-engineering and under-thinking
    # both cost correctness rather than only lines:
    #   eval_expr        `eval()` passes 4/5 and raises SyntaxError, not ValueError
    #   overlap_minutes  ignoring offsets, or mixing naive with aware, is a
    #                    TypeError at the subtraction rather than a wrong number
    #   parse_csv_line   `csv.reader` passes 4/5 and accepts an unterminated quote
    (
        "eval_expr",
        "Write a Python function eval_expr(s) that parses and evaluates an arithmetic "
        "expression string containing integers, + - * /, parentheses and unary minus, and "
        "returns a float. / is true division. * and / bind tighter than + and -; - and / are "
        "LEFT-associative. Raise ValueError for any malformed input, including unbalanced "
        "parentheses and a trailing operator. Do not use eval or exec.",
        [
            ("eval_expr('2+3*4')", "14.0"),
            ("eval_expr('(2+3)*4')", "20.0"),
            ("eval_expr('10-2-3')", "5.0"),
            ("eval_expr('-2*3+7/2')", "-2.5"),
            ("_raises(lambda: eval_expr('2*(3+4'))", "True"),
        ],
    ),
    (
        "overlap_minutes",
        "Write a Python function overlap_minutes(a_start, a_end, b_start, b_end) taking four "
        "ISO-8601 timestamp strings and returning the number of whole minutes the two intervals "
        "overlap, as an int. Intervals are half-open, so touching intervals overlap by 0. A "
        "timestamp may carry a UTC offset such as +02:00; one with NO offset is UTC. Compare in "
        "UTC, not in local wall-clock time. Raise ValueError if either interval ends before it "
        "starts.",
        [
            ("overlap_minutes('2026-01-01T10:00+00:00','2026-01-01T12:00+00:00',"
             "'2026-01-01T11:00+00:00','2026-01-01T13:00+00:00')", "60"),
            ("overlap_minutes('2026-01-01T10:00','2026-01-01T12:00',"
             "'2026-01-01T12:30+01:00','2026-01-01T14:00+01:00')", "30"),
            ("overlap_minutes('2026-01-01T10:00+00:00','2026-01-01T11:00+00:00',"
             "'2026-01-01T11:00+00:00','2026-01-01T12:00+00:00')", "0"),
            ("overlap_minutes('2026-03-28T22:00+00:00','2026-03-29T02:00+00:00',"
             "'2026-03-29T00:30+02:00','2026-03-29T04:00+02:00')", "210"),
            ("_raises(lambda: overlap_minutes('2026-01-01T12:00+00:00','2026-01-01T10:00+00:00',"
             "'2026-01-01T11:00+00:00','2026-01-01T13:00+00:00'))", "True"),
        ],
    ),
    (
        "parse_csv_line",
        "Write a Python function parse_csv_line(s) that splits ONE line of RFC-4180 CSV into a "
        "list of field strings. Fields are comma-separated. A field may be wrapped in double "
        "quotes, in which case it may contain commas, and a literal double quote inside it is "
        "written as two double quotes. Empty fields are empty strings. Raise ValueError if a "
        "quoted field is never closed. Do not use the csv module.",
        [
            ("parse_csv_line('a,b,c')", "['a','b','c']"),
            ("parse_csv_line('a,\"b,c\",d')", "['a','b,c','d']"),
            ("parse_csv_line('a,\"b\"\"c\",d')", "['a','b\"c','d']"),
            ("parse_csv_line('a,,')", "['a','','']"),
            ("_raises(lambda: parse_csv_line('a,\"b'))", "True"),
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
    "eval_expr": '''
import re as _re_expr

_TOK = _re_expr.compile(r"\s*(\d+|[()+\-*/])")

def _tokenize(s):
    pos, out = 0, []
    while pos < len(s):
        m = _TOK.match(s, pos)
        if not m:
            raise ValueError("bad character at %d" % pos)
        out.append(m.group(1))
        pos = m.end()
    if not out:
        raise ValueError("empty expression")
    return out

def eval_expr(s):
    if not isinstance(s, str):
        raise ValueError("not a string")
    toks = _tokenize(s)
    i = 0

    def peek():
        return toks[i] if i < len(toks) else None

    def take():
        nonlocal i
        if i >= len(toks):
            raise ValueError("unexpected end of expression")
        t = toks[i]
        i += 1
        return t

    def atom():
        t = take()
        if t == "-":
            return -atom()
        if t == "+":
            return atom()
        if t == "(":
            v = expr()
            if peek() != ")":
                raise ValueError("unbalanced parenthesis")
            take()
            return v
        if t.isdigit():
            return float(t)
        raise ValueError("unexpected token %r" % t)

    def term():
        v = atom()
        while peek() in ("*", "/"):
            op = take()
            r = atom()
            if op == "*":
                v = v * r
            else:
                if r == 0:
                    raise ValueError("division by zero")
                v = v / r
        return v

    def expr():
        v = term()
        while peek() in ("+", "-"):
            op = take()
            r = term()
            v = v + r if op == "+" else v - r
        return v

    v = expr()
    if i != len(toks):
        raise ValueError("trailing token %r" % toks[i])
    return float(v)
''',
    "overlap_minutes": '''
from datetime import datetime as _dt, timezone as _tz

def _to_utc(s):
    if not isinstance(s, str):
        raise ValueError("not a timestamp string")
    try:
        d = _dt.fromisoformat(s)
    except Exception:
        raise ValueError("not ISO-8601: %r" % (s,))
    # No offset means UTC. Attaching it is what keeps the comparison below from
    # being a naive-vs-aware TypeError.
    if d.tzinfo is None:
        d = d.replace(tzinfo=_tz.utc)
    return d.astimezone(_tz.utc)

def overlap_minutes(a_start, a_end, b_start, b_end):
    a0, a1, b0, b1 = (_to_utc(x) for x in (a_start, a_end, b_start, b_end))
    if a1 < a0 or b1 < b0:
        raise ValueError("interval ends before it starts")
    lo = max(a0, b0)
    hi = min(a1, b1)
    if hi <= lo:
        return 0
    return int((hi - lo).total_seconds() // 60)
''',
    "parse_csv_line": '''
def parse_csv_line(s):
    if not isinstance(s, str):
        raise ValueError("not a string")
    fields, cur, i, n = [], [], 0, len(s)
    while True:
        if i < n and s[i] == '"':
            i += 1
            while True:
                if i >= n:
                    raise ValueError("unterminated quoted field")
                if s[i] == '"':
                    if i + 1 < n and s[i + 1] == '"':
                        cur.append('"')
                        i += 2
                        continue
                    i += 1
                    break
                cur.append(s[i])
                i += 1
        while i < n and s[i] != ",":
            cur.append(s[i])
            i += 1
        fields.append("".join(cur))
        cur = []
        if i >= n:
            return fields
        i += 1
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


def _opt(flag: str, default=None):
    """--flag VALUE, without pulling argparse into a script run by hand."""
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith("--"):
            return sys.argv[i + 1]
        raise SystemExit(f"{flag} needs a value")
    return default


def main() -> int:
    print(f"\nbench-quality — {MODEL} via {LLAMA}")
    print("pass rate is executed, not judged; LOC is the over-engineering proxy\n")

    # Never score a model against assertions that have not been shown to pass a
    # correct answer. A failing control makes every number below meaningless.
    # The control always covers EVERY task, even when --only narrows the grid:
    # it is local, it is cheap, and a harness is either sound or it is not.
    control_ok = run_control()
    if "--control" in sys.argv:
        return 0 if control_ok else 1
    if not control_ok and "--force" not in sys.argv:
        print("refusing to run the grid on a broken harness (--force to override)")
        return 1

    # --only / --level / --repeat exist because a single grid cell is ONE SAMPLE
    # from a sampled process, and the first thing to do with a surprising cell is
    # ask whether it reproduces. --show-code prints what a failing cell actually
    # wrote, because "it scored 1/5" is an interpretation and the code is the
    # evidence.
    only = _opt("--only")
    level = _opt("--level")
    repeat = int(_opt("--repeat", "1"))
    show_code = "--show-code" in sys.argv

    tasks = [t for t in TASKS if only is None or t[0] == only]
    levels = [l for l in LEVELS if level is None or l[0] == level]
    if not tasks:
        print(f"no task named {only!r}; have: {', '.join(t[0] for t in TASKS)}")
        return 1
    if not levels:
        print(f"no level named {level!r}; have: {', '.join(l[0] for l in LEVELS)}")
        return 1
    if repeat < 1:
        print("--repeat must be >= 1")
        return 1
    if (only, level, repeat) != (None, None, 1):
        print(
            f"running {len(levels)} level(s) x {len(tasks)} task(s) x {repeat} "
            f"repeat(s) — NOT the full grid, do not table this against one\n"
        )

    agg = {}
    runs: dict[tuple[str, str], list[int]] = {}
    for name, extra in levels:
        passed = total = loc = reason = empty = 0
        secs = 0.0
        for tname, spec, tests in tasks:
            for rep in range(repeat):
                try:
                    content, rchars, wall = ask(spec, extra)
                except Exception as exc:  # noqa: BLE001 - report, never abort the grid
                    print(f"  {name:7} {tname:17} ERROR {type(exc).__name__}: {exc}")
                    total += len(tests)
                    runs.setdefault((name, tname), []).append(0)
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
                runs.setdefault((name, tname), []).append(sum(res))
                tag = f" #{rep + 1}" if repeat > 1 else ""
                print(
                    f"  {name:7} {tname:17}{tag} {sum(res)}/{len(res)}  loc={nloc:>3}  "
                    f"wall={wall:5.1f}s"
                )
                if show_code and sum(res) != len(res):
                    print(f"  --- what {name} wrote for {tname} ({sum(res)}/{len(res)}) ---")
                    for ln in code.splitlines():
                        print(f"  | {ln}")
                    print(f"  --- per-assertion: {res}")
        agg[name] = (passed, total, loc, secs, reason, empty)

    if repeat > 1:
        print("\n=== REPRODUCIBILITY (per-run scores) ===")
        for (lname, tname), scores in runs.items():
            n = len(tasks[0][2])
            print(
                f"  {lname:7} {tname:17} {scores}   "
                f"{sum(1 for x in scores if x == n)}/{len(scores)} runs at {n}/{n}"
            )

    print("\n=== EFFORT vs QUALITY ===")
    print(
        f"{'effort':8} {'tests passed':>14} {'pass%':>7} {'LOC':>6} "
        f"{'reason_ch':>10} {'total s':>9} {'empty':>6}"
    )
    for name, _ in levels:
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
