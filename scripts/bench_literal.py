#!/usr/bin/env python3
"""Do exact literals survive from DEEP CONTEXT into a TOOL-CALL ARGUMENT?

    docker compose --profile tools run --rm --build literal
    docker compose --profile tools run --rm --build literal --tokens 64000 --repeat 3
    ./scripts/bench-literal.sh --sweep 2000,16000,48000,90000

WHY THIS EXISTS
---------------
The Level1Techs divergence experiments (forum.level1techs.com/t/253917, and
`context/design/inference-divergence-and-this-stack.md` for what they mean here)
found that when inference-stack arithmetic drifts — a different attention
backend, a quantized KV cache, a different weight quant — the damage is not
worse prose. It is CORRUPTION OF EXACT LITERALS INSIDE STRUCTURED OUTPUT:

    GigabitEthernet0/0/1.201  ->  GigabitEthernet0/1/4
    ...5432 (p=0.9991)        ->  ...543ql
    page_size=100             ->  size=100
    a hostname's ".tenant"    ->  a different host entirely

Those are high-confidence positions, which is what makes them evidence of drift
rather than of a coin-flip between two plausible tokens.

This stack has no gate that looks for that. `smoke_test.py` makes a real tool
call but at shallow depth. `bench_quality.py` executes generated code against
assertions, which catches a wrong literal only if it happens to break the code,
and only near the top of the window. `ctx_needle.py` does prove verbatim recall
of an 8-character nonce at 90,055 tokens — genuinely the same class of test —
but it is one nonce per end per run, in prose, outside any tool envelope.

WHAT THE GRAMMAR DOES AND DOES NOT PROTECT
------------------------------------------
llama.cpp constrains native tool-call output to the template's format once a
call is detected, so the article's *structural* failures — an envelope that
never closes — are largely not reachable here. That is a real difference from
the vLLM setups it measured, and it is why this probe does not try to measure
them. A grammar cannot constrain the CONTENT of a free-form string parameter.
Every field below is such a parameter, which is exactly the surface the grammar
leaves exposed. The envelope checks are still reported, cheaply, so that "the
grammar held" is an observation here rather than an assumption.

WHY THE CONTROL IS NOT OPTIONAL
-------------------------------
"8 of 16 literals wrong at 90k" means nothing on its own. It is equally
consistent with a prompt the model does not follow, a tool schema it fills in
badly, or a literal shape it cannot tokenize back out — none of which have
anything to do with depth or with the KV cache. So every run also does the
IDENTICAL request at ~2k tokens. Failures that appear in both are the probe's,
not the stack's, and the summary says so in those words. --no-control exists
only so the shallow arm is not paid for twice in a sweep; it prints a warning.

READ THE PER-FIELD TABLE, NOT THE HEADLINE NUMBER
-------------------------------------------------
A pass rate is a number; `port  want=54321 got=543ql len_same` is a finding.
The classifier separates a same-length substitution (the article's failure) from
a truncation, a case fold, or a field the model simply did not fill in, because
those have different causes and only the first one is what this exists to catch.
"""

from __future__ import annotations

import json
import os
import random
import string
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_lib import TokenCounter, build_document, post  # noqa: E402

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama:8080")
FORGE_URL = os.environ.get("FORGE_URL", "http://forge:8081")
MODEL     = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")

# NO DEFAULT, deliberately, for the same reason smoke_test.py has none: this is
# not a tunable, it is the FACT the over-window guard is built on. A default
# here would silently let the probe build a prompt past the real window and
# report the refusal as a fidelity failure.
CTX_SIZE = int(os.environ["CTX_SIZE"]) if os.environ.get("CTX_SIZE") else None

TIMEOUT = float(os.environ.get("LITERAL_TIMEOUT", "900"))

# Depth of the shallow control. Small enough to be nearly free, large enough
# that the record is not the entire prompt.
CONTROL_TOKENS = 2000


# --------------------------------------------------------------------------
# The literals. Each shape is one of the article's observed failure surfaces.
# All are generated per run: a value the model could have memorised is not a
# retrieval test, and an identical prompt is served from the prefix cache.
# --------------------------------------------------------------------------

def _digits(n: int, rng: random.Random) -> str:
    return "".join(rng.choices(string.digits, k=n))


def _hex(n: int, rng: random.Random) -> str:
    return "".join(rng.choices("0123456789abcdef", k=n))


def _lower(n: int, rng: random.Random) -> str:
    return "".join(rng.choices(string.ascii_lowercase, k=n))


def make_record(rng: random.Random) -> dict[str, str]:
    """One inventory record. Field -> exact literal the model must reproduce.

    The shapes, and why each is here:

      port          digits only. The `5432 -> 543ql` case: a digit run that the
                    tokenizer splits, where one flipped token turns a number
                    into text and the argument stops being a port at all.
      host          dotted, hyphenated, mixed digits. The `.tenant` case: many
                    short segments, each a separate token, each an opportunity.
      interface     the article's own `GigabitEthernet0/0/1.201`. A long
                    in-vocabulary prefix followed by a dense punctuated tail is
                    the worst case for a drafter and for a quantized cache
                    alike, because the prefix is nearly free to predict and the
                    tail is not.
      request_id    a UUID. Pure hex with fixed structure; a single wrong nibble
                    is invisible to a human reader and fatal to a lookup.
      commit        40 hex characters with no structure at all. The longest
                    unguessable run in the record.
      config_kwarg  `page_size=NNN`. The psycopg case: a keyword argument where
                    dropping a leading word leaves something that still parses
                    and means something else.
      artifact_path a filesystem path with underscores, digits and a compound
                    extension. Mixed separators, all of them single tokens.
      auth_token    mixed-case alphanumeric, no linguistic prior whatsoever.
                    The hardest field, and the one a model cannot reconstruct
                    from meaning if the cache read is wrong.
    """
    seg = _lower(rng.randint(3, 7), rng)
    return {
        "name":          f"svc-{_lower(4, rng)}-{_digits(2, rng)}",
        "host":          f"{seg}-{_digits(2, rng)}.{_lower(5, rng)}.{_lower(4, rng)}.internal",
        "interface":     f"GigabitEthernet{rng.randint(0,9)}/{rng.randint(0,9)}/"
                         f"{rng.randint(0,9)}.{_digits(3, rng)}",
        "request_id":    f"{_hex(8, rng)}-{_hex(4, rng)}-{_hex(4, rng)}-"
                         f"{_hex(4, rng)}-{_hex(12, rng)}",
        "commit":        _hex(40, rng),
        "config_kwarg":  f"page_size={_digits(3, rng)}",
        "artifact_path": f"/opt/{_lower(5, rng)}/{_lower(4, rng)}_{_digits(4, rng)}.tar.gz",
        "auth_token":    "".join(rng.choices(
                             string.ascii_letters + string.digits, k=28)),
    }


FIELDS = list(make_record(random.Random(0)).keys())


def render_record(label: str, rec: dict[str, str]) -> str:
    width = max(len(k) for k in rec)
    lines = [f"=== INVENTORY RECORD {label} ==="]
    lines += [f"  {k.ljust(width)} = {v}" for k, v in rec.items()]
    lines.append(f"=== END INVENTORY RECORD {label} ===")
    return "\n".join(lines) + "\n"


TOOL = {
    "type": "function",
    "function": {
        "name": "register_endpoint",
        "description": (
            "Register one service endpoint in the inventory. Every argument "
            "must be copied EXACTLY as written in the record, character for "
            "character, with no reformatting, normalisation or abbreviation."
        ),
        "parameters": {
            "type": "object",
            # EVERY FIELD IS A STRING, including the ones that look numeric.
            # An integer-typed parameter would be grammar-constrained to digits,
            # which makes the `5432 -> 543ql` failure mode literally
            # unrepresentable — the probe would report a clean pass because the
            # grammar repaired the symptom it exists to detect.
            "properties": {
                f: {"type": "string", "description": f"The record's {f} value, verbatim."}
                for f in FIELDS
            },
            "required": FIELDS,
        },
    },
}


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------

def classify(want: str, got) -> str:
    """Why a field is wrong, not just that it is.

    THE BUCKETS ARE NOT ARBITRARY, and the first cut of them was wrong. It had a
    `len_same` bucket described as "the article's failure", on the assumption
    that a flipped token substitutes something of equal length. Checked against
    the article's four actual examples, three of them CHANGE LENGTH:

        5432        -> 543ql                  +1   (one token replaced by another)
        page_size=  -> size=                  -5   (a leading token dropped)
        ...0/0/1.201 -> ...0/1/4              -4   (diverges partway, runs to the end)
        .tenant     -> a different hostname    -   (diverges partway)

    So equal length is the wrong discriminator. The real signature of a flipped
    token is a SHARED PREFIX FOLLOWED BY DIVERGENCE TO THE END — the copy was
    proceeding correctly and then went somewhere else — which is `tail_swap`
    here, whatever it does to the length. `dropped_head` is the psycopg case.
    `truncated` and `missing` are much more likely to be the model ignoring the
    instruction, i.e. the probe's problem rather than the stack's.
    """
    if got is None:
        return "missing"
    if not isinstance(got, str):
        return f"nonstring({type(got).__name__})"
    if got == want:
        return "exact"
    if got == "":
        return "empty"
    if got.strip() == want:
        return "whitespace"
    if got.lower() == want.lower():
        return "case"
    if want.startswith(got):
        return "truncated"
    if got.startswith(want):
        return "trailing"
    if want.endswith(got):
        return "dropped_head"
    if got.endswith(want):
        return "extra_head"
    # Shared prefix then divergence to the end. 3 characters is meaningful here
    # because every generated literal is at least 11 characters long; it would
    # not be on a two-token field.
    if len(want) >= 3 and len(got) >= 3 and want[:3] == got[:3]:
        return "tail_swap"
    if len(got) == len(want):
        return "len_same"
    return "other"


def first_diff(want: str, got: str) -> int:
    for i, (a, b) in enumerate(zip(want, got)):
        if a != b:
            return i
    return min(len(want), len(got))


class Result:
    __slots__ = ("ok", "detail", "fields", "elapsed", "prompt_tokens",
                 "envelope", "reasoned", "args", "record")

    def __init__(self) -> None:
        self.ok = False
        self.detail = ""
        self.fields: dict[str, str] = {}
        self.elapsed = 0.0
        self.prompt_tokens = None
        self.envelope: list[str] = []
        self.reasoned = False
        # Kept so the detection control below can re-score a REAL response
        # against a deliberately wrong expectation. Without them the probe can
        # only ever be shown to pass, never shown to be able to fail.
        self.args: dict = {}
        self.record: dict[str, str] = {}


EFFORT_PAYLOAD = {
    # `none` is a TOP-LEVEL llama-server parameter. The nested form goes to the
    # Jinja template, and this model's template accepts only xhigh/medium/low —
    # "none" makes it raise_exception and the request comes back HTTP 500. Same
    # split bench_quality.py uses.
    "none":   {"reasoning_effort": "none"},
    "low":    {"chat_template_kwargs": {"reasoning_effort": "low"}},
    "medium": {"chat_template_kwargs": {"reasoning_effort": "medium"}},
    "xhigh":  {"chat_template_kwargs": {"reasoning_effort": "xhigh"}},
}


def ask(base: str, document: str, label: str, rec: dict[str, str],
        temp: float, effort: str) -> Result:
    """One request, one expected tool call, scored field by field."""
    res = Result()
    instruction = (
        f"\n\nCall register_endpoint exactly once, for INVENTORY RECORD {label} "
        f"in the document above. Copy every value EXACTLY as written in that "
        f"record — character for character. Do not reformat, normalise, "
        f"abbreviate or correct anything. Do not use any other record.\n"
    )
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": document + instruction}],
        "tools": [TOOL],
        "tool_choice": "auto",
        "max_tokens": 2048,
        "temperature": temp,
    }
    payload.update(EFFORT_PAYLOAD[effort])

    started = time.monotonic()
    status, body = post(base, "/v1/chat/completions", payload, TIMEOUT)
    res.elapsed = time.monotonic() - started

    if status != 200:
        res.detail = f"HTTP {status}: {str(body)[:400]}"
        return res
    if not isinstance(body, dict):
        res.detail = f"non-JSON body: {str(body)[:400]}"
        return res

    choice = (body.get("choices") or [{}])[0]
    msg = choice.get("message", {}) or {}
    usage = body.get("usage") or {}
    res.prompt_tokens = usage.get("prompt_tokens")
    res.reasoned = bool(msg.get("reasoning_content"))

    calls = msg.get("tool_calls") or []
    if not calls:
        res.detail = ("no tool_calls (is --jinja set?); content="
                      f"{str(msg.get('content'))[:200]!r}")
        res.envelope.append("no-tool-call")
        return res
    if len(calls) != 1:
        res.envelope.append(f"{len(calls)}-calls")

    fn = calls[0].get("function") or {}
    if fn.get("name") != "register_endpoint":
        res.envelope.append(f"wrong-name:{fn.get('name')!r}")

    raw_args = fn.get("arguments") or ""
    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
    except json.JSONDecodeError as e:
        res.envelope.append("arguments-not-json")
        res.detail = f"arguments did not parse ({e}): {str(raw_args)[:300]!r}"
        # Every field counts as missing rather than silently vanishing.
        res.fields = {f: "missing" for f in FIELDS}
        return res
    if not isinstance(args, dict):
        res.envelope.append("arguments-not-object")
        res.fields = {f: "missing" for f in FIELDS}
        return res

    extra = [k for k in args if k not in FIELDS]
    if extra:
        res.envelope.append(f"extra-keys:{','.join(sorted(extra))}")

    res.args = args
    res.record = dict(rec)
    res.fields = {f: classify(rec[f], args.get(f)) for f in FIELDS}
    res.ok = all(v == "exact" for v in res.fields.values()) and not res.envelope
    if not res.ok:
        bad = []
        for f in FIELDS:
            verdict = res.fields[f]
            if verdict == "exact":
                continue
            got = args.get(f)
            if isinstance(got, str) and verdict not in ("missing", "empty"):
                at = first_diff(rec[f], got)
                bad.append(f"{f}[{verdict}@{at}] want={rec[f]!r} got={got!r}")
            else:
                bad.append(f"{f}[{verdict}] want={rec[f]!r} got={got!r}")
        res.detail = "; ".join(bad)
    return res


# --------------------------------------------------------------------------
# Detection control — can this probe FAIL?
# --------------------------------------------------------------------------

def detection_control(res: Result) -> bool:
    """Prove the probe can see a corruption, using a response it already has.

    A NEGATIVE RESULT IS ONLY AS GOOD AS ITS CONTROL. "160 literals, none
    corrupted" is a negative result, and the shallow control above does not
    validate it: every field passed there too, so the scoring path for a WRONG
    field was never executed end to end. A probe that scored everything `exact`
    unconditionally would produce exactly the output this one produces.

    So: take the real tool call the control just made and re-score it against a
    deliberately wrong expectation. Mutating the EXPECTED value is equivalent to
    the model having made that exact mistake — the comparison is symmetric — and
    it costs no extra model call.

    Each mutation names the class it must produce. If any mutation comes back
    `exact`, the probe is blind and every pass above is worthless.
    """
    if not res.args:
        print("  [SKIP] the control produced no arguments to re-score")
        return False

    mutations = [
        # last character changed: shares a prefix, diverges to the end
        ("commit", lambda v: v[:-1] + ("0" if v[-1] != "0" else "1"), "tail_swap"),
        # a leading token dropped from the expectation == the model added one
        ("config_kwarg", lambda v: "zz" + v, "dropped_head"),
        # the expectation is longer == the model stopped early
        ("artifact_path", lambda v: v + "TAIL", "truncated"),
        # case fold
        ("auth_token", lambda v: v.upper(), "case"),
    ]

    ok = True
    for field, mutate, expect in mutations:
        want = res.record[field]
        mutated = mutate(want)
        if mutated == want:
            print(f"  [SKIP] {field}: mutation was a no-op on {want!r}")
            continue
        verdict = classify(mutated, res.args.get(field))
        good = verdict == expect
        ok = ok and good
        print(f"  [{'PASS' if good else 'FAIL'}] {field:<13} mutated expectation "
              f"-> {verdict:<13} (must be {expect})")
        if not good:
            print(f"         want'={mutated!r} got={res.args.get(field)!r}")

    unmutated = all(classify(res.record[f], res.args.get(f)) == "exact" for f in FIELDS)
    print(f"  [{'PASS' if unmutated else 'FAIL'}] the same response scores exact "
          f"against the TRUE record")
    return ok and unmutated


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------

def run_depth(count: TokenCounter, base: str, tokens: int, repeat: int,
              temp: float, effort: str, labels: list[str],
              verbose: bool) -> list[tuple[str, str, Result]]:
    """One depth. Returns (label, field-agnostic tag, Result) per call made."""
    out = []
    for r in range(repeat):
        rng = random.Random()
        recs = {lbl: make_record(rng) for lbl in ("ALPHA", "OMEGA")}
        head = render_record("ALPHA", recs["ALPHA"])
        tail = render_record("OMEGA", recs["OMEGA"])
        document = build_document(count, tokens, head, tail, seed=rng.randrange(1 << 30),
                                  verbose=verbose)
        actual = count(document)
        if CTX_SIZE is not None and actual >= CTX_SIZE - 4096:
            raise SystemExit(
                f"refusing to run: the {tokens}-token target built a {actual}-token "
                f"document, and CTX_SIZE is {CTX_SIZE}. Leave room for the "
                f"instruction, the tool schema and the reply, or the refusal "
                f"would be scored as a fidelity failure.")
        for lbl in labels:
            res = ask(base, document, lbl, recs[lbl], temp, effort)
            out.append((lbl, f"{tokens}", res))
            mark = "PASS" if res.ok else "FAIL"
            print(f"  [{mark}] {tokens:>6} tok  {lbl:<5} rep{r + 1}  "
                  f"prompt={res.prompt_tokens}  {res.elapsed:.1f}s"
                  + (f"  reasoned" if res.reasoned else ""))
            if res.envelope:
                print(f"         envelope: {', '.join(res.envelope)}")
            if res.detail:
                for part in res.detail.split("; "):
                    print(f"         {part}")
    return out


def summarise(rows: list[tuple[str, str, Result]], title: str) -> dict[str, int]:
    """Per-field verdict counts, and the table that is worth reading."""
    print(f"\n{title}")
    if not rows:
        print("  (no calls)")
        return {}

    depths = sorted({d for _, d, _ in rows}, key=int)
    width = max(len(f) for f in FIELDS)
    header = "  " + "field".ljust(width) + "  " + "  ".join(d.rjust(8) for d in depths)
    print(header)
    print("  " + "-" * (len(header) - 2))
    totals: dict[str, int] = {}
    for f in FIELDS:
        cells = []
        for d in depths:
            at_depth = [r for _, dd, r in rows if dd == d]
            n = len(at_depth)
            ok = sum(1 for r in at_depth if r.fields.get(f) == "exact")
            cells.append(f"{ok}/{n}".rjust(8))
        print("  " + f.ljust(width) + "  " + "  ".join(cells))
    for _, _, r in rows:
        for f in FIELDS:
            v = r.fields.get(f, "missing")
            totals[v] = totals.get(v, 0) + 1

    print()
    whole = sum(1 for _, _, r in rows if r.ok)
    print(f"  whole records exact: {whole}/{len(rows)}")
    print("  verdicts: " + ", ".join(f"{k}={v}" for k, v in sorted(totals.items())))
    return totals


def main() -> int:
    args = sys.argv[1:]
    tokens, repeat, temp, effort = 90000, 1, 0.0, "none"
    via, control, labels, verbose = "forge", True, ["ALPHA", "OMEGA"], True
    sweep: list[int] = []

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--tokens":
            tokens = int(args[i + 1]); i += 2
        elif a == "--sweep":
            sweep = [int(x) for x in args[i + 1].split(",") if x.strip()]; i += 2
        elif a == "--repeat":
            repeat = int(args[i + 1]); i += 2
        elif a == "--temp":
            temp = float(args[i + 1]); i += 2
        elif a == "--effort":
            effort = args[i + 1]; i += 2
            if effort not in EFFORT_PAYLOAD:
                print(f"--effort must be one of {sorted(EFFORT_PAYLOAD)}", file=sys.stderr)
                return 2
        elif a == "--via":
            via = args[i + 1]; i += 2
            if via not in ("forge", "llama"):
                print("--via must be forge or llama", file=sys.stderr); return 2
        elif a == "--record":
            want = args[i + 1].upper(); i += 2
            if want == "BOTH":
                labels = ["ALPHA", "OMEGA"]
            elif want in ("ALPHA", "OMEGA"):
                labels = [want]
            else:
                print("--record must be ALPHA, OMEGA or BOTH", file=sys.stderr); return 2
        elif a == "--no-control":
            control = False; i += 1
        elif a == "--quiet":
            verbose = False; i += 1
        elif a in ("-h", "--help"):
            print(__doc__); return 0
        else:
            print(f"unknown argument: {a}", file=sys.stderr); return 2

    if CTX_SIZE is None:
        print("CTX_SIZE is not set in this container's environment.\n"
              "It is not a tunable here — it is the fact the over-window guard\n"
              "is built on, and a default would let this probe score a refusal\n"
              "as a fidelity failure. Run via the `literal` compose service.",
              file=sys.stderr)
        return 2

    base = FORGE_URL if via == "forge" else LLAMA_URL
    depths = sweep or [tokens]

    print(f"bench-literal — {MODEL} via {via} ({base})")
    print(f"  depths={depths} repeat={repeat} temp={temp} effort={effort} "
          f"records={'+'.join(labels)} ctx={CTX_SIZE}")
    print(f"  fields: {', '.join(FIELDS)}\n")

    count = TokenCounter(LLAMA_URL)

    control_rows: list[tuple[str, str, Result]] = []
    if control:
        print("CONTROL — the identical request at shallow depth.")
        print("Anything that fails HERE is the probe, the prompt or the schema,")
        print("not the context window and not the KV cache.\n")
        control_rows = run_depth(count, base, CONTROL_TOKENS, 1, temp, effort,
                                 labels, verbose)

        print("\nDETECTION CONTROL — can this probe report a failure at all?")
        print("The shallow control above only shows the probe PASSING. This")
        print("re-scores that same real response against wrong expectations.\n")
        scored = next((r for _, _, r in control_rows if r.args), None)
        detect_ok = detection_control(scored) if scored else False
        if not detect_ok:
            print("\nVERDICT: THE DETECTION CONTROL FAILED. This probe cannot be")
            print("shown to report a corruption, so any clean result it produces")
            print("means nothing. Fix the scorer before running anything at depth.")
            return 1
    else:
        print("!! --no-control: results below are UNINTERPRETABLE on their own.")
        print("!! A failure at depth cannot be told apart from a probe that")
        print("!! never worked at any depth. Run without --no-control first.\n")

    print("\nDEPTH")
    rows: list[tuple[str, str, Result]] = []
    for d in depths:
        rows += run_depth(count, base, d, repeat, temp, effort, labels, verbose)

    if control:
        summarise(control_rows, "CONTROL — per-field exact matches")
    summarise(rows, "DEPTH — per-field exact matches")

    ctrl_clean = all(r.ok for _, _, r in control_rows) if control else None
    deep_clean = all(r.ok for _, _, r in rows)

    print()
    if control and not ctrl_clean:
        print("VERDICT: THE CONTROL FAILED. Nothing below the control line can be")
        print("attributed to depth or to the cache — fix the probe first. The")
        print("deep results above are reported, not interpreted.")
        return 1
    if deep_clean:
        print("VERDICT: every literal survived at every depth tested.")
        return 0
    print("VERDICT: literals were corrupted at depth while the shallow control")
    print("was clean. That is the failure this probe exists to detect — read the")
    print("per-call lines above for the shapes, and weigh `tail_swap` and")
    print("`dropped_head` most: a copy that ran correctly and then diverged is a")
    print("flipped token. `truncated` and `missing` are more likely the model")
    print("declining to copy at all, which is a prompt problem, not a cache one.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
