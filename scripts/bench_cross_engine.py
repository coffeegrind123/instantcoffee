#!/usr/bin/env python3
"""Compare two different inference ENGINES in the same units, over HTTP.

Why this exists, and why `bench.py` cannot do this job
-----------------------------------------------------
`bench.py` reads llama-server's own `timings` block, deliberately: it is measured
around the actual compute, so it is not contaminated by proxy or transport cost.
That is the right instrument for tuning llama.cpp against itself, and the wrong
one the moment a second engine is involved -- ninfer has no `timings` block, and
two engines' self-reported counters are not commensurable even when both exist,
because each decides for itself what to put inside the timed region.

The only currency both engines quote is wall clock at the socket. So this
measures that, on both, with identical prompts:

    prefill rate = prompt_tokens / (time to first content token)
    decode rate  = (content tokens - 1) / (last token time - first token time)

Both numbers include each server's own request-handling path. That is a real
cost the user pays, it is charged to both sides equally, and it is stated rather
than hidden. Where an engine also reports its own counters they are captured and
printed ALONGSIDE the wall-clock figure, never instead of it -- a gap between the
two is information (it is the server path), not an error to reconcile away.

THE PREFIX CACHE WILL LIE TO YOU, ON BOTH ENGINES
-------------------------------------------------
This stack runs llama.cpp with `--cache-prompt`, and ninfer advertises
"compatible-prefix reuse". A benchmark that sends the same long prompt twice
measures a prefill it never performed the second time, and reports a spectacular
number. `bench.py` was rewritten once for exactly this reason, and the version it
replaced scored identically before and after a fix that made prefill ~65x faster.

So every prompt built here carries a fresh random nonce **at the front**, where
it poisons the whole prefix rather than only the tail. `--probe` prints the first
32 characters of each prompt so this is visible rather than promised.

DO NOT TRUST THIS SCRIPT'S PARSER UNTIL YOU HAVE RUN `--probe`
--------------------------------------------------------------
The SSE frame shape and the presence of a `usage` block are properties of a
server this repo does not control. `--probe` dumps the raw first frames and the
raw final frame from whatever endpoint you point it at, so the parser can be
checked against observed bytes instead of assumed ones. A field this script
cannot find is reported by name, loudly, and distinguished from a field that was
present and empty -- because "ninfer reports no token counts" and "our parser
looked in the wrong place" are the same symptom and completely different bugs.

Usage
-----
    # See what an engine actually sends back, before believing any number.
    python3 bench_cross_engine.py --probe --url http://llama:8080 --label llama

    # Measure one engine.
    python3 bench_cross_engine.py --url http://llama:8080 --label llama \\
        --prompt-tokens 90000 --predict 128 --repeat 3

    # Both, one invocation, same prompts, interleaved to share drift.
    python3 bench_cross_engine.py \\
        --arm 'llama=http://llama:8080' \\
        --arm 'ninfer=http://host.docker.internal:8080' \\
        --prompt-tokens 90000 --predict 128 --repeat 3 --json out.json
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field, asdict
import json
import random
import statistics
import string
import sys
import time
import urllib.error
import urllib.request


# A prompt is built from repeated filler and measured in TOKENS by the server,
# not guessed by us. This many characters per token is only the starting guess
# for how much filler to generate; the script then reports what the server
# actually counted, and `--prompt-tokens` is a target rather than a promise.
CHARS_PER_TOKEN_GUESS = 3.6

FILLER_WORDS = (
    "the quick brown fox jumps over the lazy dog while a patient engineer "
    "reads the logs and writes down what actually happened rather than what "
    "was expected to happen because the difference between those two things "
    "is where every interesting bug lives and where every wrong number comes "
    "from in the end "
)


def _nonce(n: int = 24) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))


def build_prompt(target_tokens: int) -> str:
    """Filler of roughly `target_tokens`, with a fresh nonce at the FRONT.

    Front, not back: a nonce appended to the end still leaves a shared prefix
    covering everything before it, which is exactly the part a prefix cache
    reuses. Leading it makes every prompt diverge at character zero.
    """
    nonce = _nonce()
    want_chars = int(target_tokens * CHARS_PER_TOKEN_GUESS)
    reps = max(1, want_chars // len(FILLER_WORDS) + 1)
    body = (FILLER_WORDS * reps)[:want_chars]
    return (
        f"[run {nonce}] Read the following text and then answer.\n\n"
        f"{body}\n\n"
        f"Question: repeat the run id at the top of this message, then count "
        f"slowly from one to forty in words."
    )


@dataclass(slots=True)
class Round:
    """One request, timed at the socket."""

    arm: str
    ok: bool
    error: str | None = None

    ttft_s: float | None = None
    total_s: float | None = None
    decode_s: float | None = None

    content_chunks: int = 0
    content_chars: int = 0
    # Which delta field the text arrived in. On this stack it is
    # `reasoning_content`; printing it stops that being a silent surprise.
    content_fields: list[str] = field(default_factory=list)

    # Whatever the server chose to tell us. None means the field was ABSENT;
    # a value means it was present. The distinction is load-bearing.
    reported_prompt_tokens: int | None = None
    reported_completion_tokens: int | None = None
    # The direct prefix-cache check, better than trusting the nonce: llama
    # reports `usage.prompt_tokens_details.cached_tokens`. Non-zero means part
    # of this prefill did not happen and the prefill rate below is fiction.
    cached_tokens: int | None = None
    missing_fields: list[str] = field(default_factory=list)

    # Engine-native counters, verbatim, for the cross-check.
    native: dict = field(default_factory=dict)

    @property
    def cache_contaminated(self) -> bool:
        return bool(self.cached_tokens)

    @property
    def prefill_tok_s(self) -> float | None:
        if not self.ok or not self.ttft_s or not self.reported_prompt_tokens:
            return None
        if self.cache_contaminated:
            # Refuse to produce the number rather than produce a fast wrong one.
            return None
        return self.reported_prompt_tokens / self.ttft_s

    @property
    def decode_tok_s(self) -> float | None:
        if not self.ok or not self.decode_s or self.decode_s <= 0:
            return None
        n = self.reported_completion_tokens
        if n is None:
            # Fall back to counting streamed chunks. Usually one token per
            # chunk, but that is an assumption, so it is flagged in the report
            # rather than quietly substituted.
            n = self.content_chunks
        if n <= 1:
            return None
        return (n - 1) / self.decode_s


def _post_stream(url: str, payload: dict, timeout: float):
    """POST and yield (monotonic_timestamp, raw_line) for each SSE line."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            yield time.monotonic(), raw


def _extract_content(obj: dict) -> tuple[str | None, str | None]:
    """Pull streamed text out of an OpenAI-shaped chunk.

    Returns (text, field_it_came_from).

    `delta.reasoning_content` counts. This is not a nicety -- it is the whole
    measurement on this stack. `REASONING_EFFORT` is pinned to `medium`, so a
    reply opens with reasoning tokens and `delta.content` is literally `null`
    for them. A parser that reads only `content` sets no first-token time, and
    then reports "no content token was ever streamed" for a request the server
    answered perfectly. That reads as a broken ENGINE and is a broken PARSER.
    Observed, not assumed -- see `--probe` output for llama b10689.

    Tolerates `content` as a string and as a list of typed parts.
    """
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices:
        return None, None
    delta = choices[0].get("delta") or {}

    for key in ("content", "reasoning_content"):
        value = delta.get(key)
        if isinstance(value, str) and value:
            return value, key
        if isinstance(value, list):
            parts = [
                p.get("text", "")
                for p in value
                if isinstance(p, dict) and p.get("type") in (None, "text")
            ]
            joined = "".join(parts)
            if joined:
                return joined, key
    return None, None


def run_round(
    arm: str,
    base_url: str,
    prompt: str,
    predict: int,
    timeout: float,
    model: str | None,
) -> Round:
    payload = {
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": predict,
        "temperature": 0.0,
        "stream": True,
        "stream_options": {"include_usage": True},
        # llama.cpp-only, and ignored by servers that do not know it: without
        # this the streamed response carries no `timings`, so the engine-side
        # cross-check silently vanishes exactly where it is most needed.
        #
        # Measured on a QUIET server, TTFT - prompt_ms is a flat 0.68-1.31 s
        # from 201 to 10,432 prompt tokens -- a constant, not something that
        # scales with the prompt. Keep the cross-check anyway: that constant is
        # the number that tells you whether TTFT is a usable prefill proxy, and
        # it is only small while nothing else holds the slot. See
        # `test_llama_ttft_gap_is_constant` for why that word "quiet" is doing
        # real work.
        "timings_per_token": True,
    }
    if model:
        payload["model"] = model

    rnd = Round(arm=arm, ok=False)
    url = base_url.rstrip("/") + "/v1/chat/completions"

    t0 = time.monotonic()
    t_first: float | None = None
    t_last: float | None = None
    saw_usage = False

    try:
        for ts, raw in _post_stream(url, payload, timeout):
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                break
            try:
                obj = json.loads(body)
            except json.JSONDecodeError:
                continue

            usage = obj.get("usage")
            if isinstance(usage, dict) and usage:
                saw_usage = True
                pt = usage.get("prompt_tokens")
                ct = usage.get("completion_tokens")
                if isinstance(pt, int):
                    rnd.reported_prompt_tokens = pt
                if isinstance(ct, int):
                    rnd.reported_completion_tokens = ct
                details = usage.get("prompt_tokens_details")
                if isinstance(details, dict) and isinstance(
                    details.get("cached_tokens"), int
                ):
                    rnd.cached_tokens = details["cached_tokens"]

            # llama.cpp attaches its own block; keep it verbatim as a
            # cross-check on the wall-clock numbers, never as a substitute.
            for key in ("timings", "metrics"):
                if isinstance(obj.get(key), dict):
                    rnd.native[key] = obj[key]

            text, source_field = _extract_content(obj)
            if text:
                if t_first is None:
                    t_first = ts
                t_last = ts
                rnd.content_chunks += 1
                rnd.content_chars += len(text)
                if source_field and source_field not in rnd.content_fields:
                    rnd.content_fields.append(source_field)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        rnd.error = f"{type(exc).__name__}: {exc}"
        return rnd

    t_end = time.monotonic()
    if t_first is None:
        rnd.error = "no content token was ever streamed"
        return rnd

    rnd.ok = True
    rnd.ttft_s = t_first - t0
    rnd.total_s = t_end - t0
    rnd.decode_s = (t_last - t_first) if t_last is not None else 0.0

    if not saw_usage:
        rnd.missing_fields.append("usage")
    if rnd.reported_prompt_tokens is None:
        rnd.missing_fields.append("usage.prompt_tokens")
    if rnd.reported_completion_tokens is None:
        rnd.missing_fields.append("usage.completion_tokens")
    return rnd


def probe(base_url: str, label: str, prompt_tokens: int, timeout: float) -> int:
    """Dump what the server actually sends, before any parser is trusted."""
    prompt = build_prompt(prompt_tokens)
    print(f"=== PROBE {label} :: {base_url}")
    print(f"prompt: {len(prompt)} chars, target ~{prompt_tokens} tokens")
    print(f"prompt head (nonce must differ every run): {prompt[:32]!r}")
    print()

    for path in ("/health", "/v1/models", "/metrics", "/slots", "/props"):
        url = base_url.rstrip("/") + path
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                raw = resp.read(400)
                print(f"  GET {path:14} -> {resp.status}  {raw[:200]!r}")
        except urllib.error.HTTPError as exc:
            print(f"  GET {path:14} -> HTTP {exc.code}")
        except Exception as exc:
            print(f"  GET {path:14} -> {type(exc).__name__}: {exc}")
    print()

    payload = {
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 16,
        "temperature": 0.0,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    url = base_url.rstrip("/") + "/v1/chat/completions"
    print(f"  POST {url}  (streaming, max_tokens=16)")
    frames = []
    try:
        t0 = time.monotonic()
        for ts, raw in _post_stream(url, payload, timeout):
            frames.append((ts - t0, raw.decode("utf-8", "replace").rstrip()))
    except Exception as exc:
        print(f"  FAILED: {type(exc).__name__}: {exc}")
        return 1

    print(f"  {len(frames)} lines received")
    print("  --- first 6 lines, verbatim ---")
    for dt, line in frames[:6]:
        print(f"  [{dt:7.3f}s] {line[:300]}")
    print("  --- last 4 lines, verbatim ---")
    for dt, line in frames[-4:]:
        print(f"  [{dt:7.3f}s] {line[:300]}")
    return 0


def _fmt(value: float | None, width: int = 8, prec: int = 1) -> str:
    return " " * (width - 1) + "-" if value is None else f"{value:{width}.{prec}f}"


def report(rounds: list[Round]) -> str:
    lines = []
    arms = []
    for r in rounds:
        if r.arm not in arms:
            arms.append(r.arm)

    lines.append(
        f"{'arm':10} {'#':>2} {'prompt tok':>10} {'TTFT s':>8} "
        f"{'prefill t/s':>11} {'gen tok':>8} {'decode t/s':>11} {'total s':>8}"
    )
    lines.append("-" * 76)
    for r in rounds:
        if not r.ok:
            lines.append(f"{r.arm:10}  -   FAILED  {r.error}")
            continue
        idx = sum(1 for x in rounds[: rounds.index(r) + 1] if x.arm == r.arm)
        gen = r.reported_completion_tokens
        gen_s = f"{gen:8d}" if gen is not None else f"{r.content_chunks:7d}*"
        flag = "  CACHED" if r.cache_contaminated else ""
        lines.append(
            f"{r.arm:10} {idx:2d} "
            f"{(r.reported_prompt_tokens or 0):10d} "
            f"{_fmt(r.ttft_s, 8, 2)} {_fmt(r.prefill_tok_s, 11)} "
            f"{gen_s} {_fmt(r.decode_tok_s, 11)} {_fmt(r.total_s, 8, 2)}{flag}"
        )

    lines.append("")
    lines.append(f"{'arm':10} {'prefill t/s (median, range)':>34} {'decode t/s (median, range)':>34}")
    lines.append("-" * 80)
    for arm in arms:
        ok = [r for r in rounds if r.arm == arm and r.ok]
        pf = [r.prefill_tok_s for r in ok if r.prefill_tok_s is not None]
        dc = [r.decode_tok_s for r in ok if r.decode_tok_s is not None]
        pf_s = (
            f"{statistics.median(pf):10.1f}  [{min(pf):.1f} .. {max(pf):.1f}]"
            if pf
            else "no reading"
        )
        dc_s = (
            f"{statistics.median(dc):10.1f}  [{min(dc):.1f} .. {max(dc):.1f}]"
            if dc
            else "no reading"
        )
        lines.append(f"{arm:10} {pf_s:>34} {dc_s:>34}")

    contaminated = [r for r in rounds if r.cache_contaminated]
    if contaminated:
        lines.append("")
        lines.append(
            "PREFIX CACHE HIT on "
            f"{len(contaminated)} round(s) -- their prefill rate is WITHHELD, not "
            "reported.\n  The server said it reused "
            + ", ".join(str(r.cached_tokens) for r in contaminated)
            + " prompt tokens, so that much prefill never ran.\n  Every prompt "
            "carries a leading nonce, so a hit here means something else is "
            "sharing\n  the prefix -- check for a second client on the same slot."
        )

    fields = sorted({f_ for r in rounds for f_ in r.content_fields})
    if fields and fields != ["content"]:
        lines.append("")
        lines.append(
            f"Streamed text arrived in: {', '.join(fields)}. "
            "`reasoning_content` is counted as\n  generation, because it is "
            "generation -- the model emits it under REASONING_EFFORT."
        )

    missing = {}
    for r in rounds:
        for f_ in r.missing_fields:
            missing.setdefault(r.arm, set()).add(f_)
    if missing:
        lines.append("")
        lines.append("FIELDS THE SERVER DID NOT SEND (not a parser failure - it was absent):")
        for arm, fields in missing.items():
            lines.append(f"  {arm}: {', '.join(sorted(fields))}")
        lines.append(
            "  A '*' in the 'gen tok' column means that count is streamed CHUNKS, "
            "not tokens.\n  Chunks are usually one token each, but that is an "
            "assumption, not a measurement."
        )

    native = {r.arm for r in rounds if r.native}
    if native:
        lines.append("")
        lines.append(
            "Engine-native counters were also captured for: "
            + ", ".join(sorted(native))
            + " (see --json). They are a CROSS-CHECK on the wall-clock figures "
            "above, not a\nreplacement: the gap between them is the server path, "
            "which the user pays."
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--arm", action="append", default=[],
                   help="label=base_url; repeat for each engine")
    p.add_argument("--url", help="single-engine shorthand, with --label")
    p.add_argument("--label", default="engine")
    p.add_argument("--prompt-tokens", type=int, default=8192)
    p.add_argument("--predict", type=int, default=128)
    p.add_argument("--repeat", type=int, default=3)
    p.add_argument("--timeout", type=float, default=1800.0)
    p.add_argument("--model", default=None, help="value for the `model` field")
    p.add_argument("--probe", action="store_true",
                   help="dump raw endpoint and SSE output, measure nothing")
    p.add_argument("--no-warmup", action="store_true",
                   help="skip the discarded warm-up round (you will measure "
                        "graph capture and queue wait as prefill)")
    p.add_argument("--json", dest="json_out", default=None)
    p.add_argument("--seed", type=int, default=None)
    args = p.parse_args(argv)

    if args.seed is not None:
        random.seed(args.seed)

    arms: list[tuple[str, str]] = []
    for spec in args.arm:
        if "=" not in spec:
            print(f"--arm needs label=url, got {spec!r}", file=sys.stderr)
            return 2
        label, url = spec.split("=", 1)
        arms.append((label.strip(), url.strip()))
    if args.url:
        arms.append((args.label, args.url))
    if not arms:
        print("give --arm label=url (repeatable) or --url with --label",
              file=sys.stderr)
        return 2

    if args.probe:
        rc = 0
        for label, url in arms:
            rc |= probe(url, label, min(args.prompt_tokens, 2048), args.timeout)
            print()
        return rc

    rounds: list[Round] = []

    # One discarded warm-up per arm. A first request into an idle server pays
    # for things the steady state does not, and all of it lands in TTFT, which
    # is the prefill measurement. Measured on this stack at a matched 256-token
    # target: 2.09 s cold against 0.97 s warm, and prompt_ms 694.9 against
    # 291.4 -- so the cold round more than doubles both.
    #
    # RUN THIS ON A QUIET BOX, and that is not advice. The single biggest error
    # in the numbers below is not cold start, it is CONTENTION: a leftover
    # bench container still holding llama's one slot pushed TTFT on a
    # ~1300-token prompt to 11-17 s, which looked exactly like a real,
    # prompt-proportional stall in the engine and was not. It survived long
    # enough to get written down. Kill stray `instantcoffee-bench-run-*`
    # containers before believing anything here.
    if not args.no_warmup:
        for label, url in arms:
            print(f"[warmup] {label} (discarded) ...", file=sys.stderr, flush=True)
            w = run_round(
                label, url, build_prompt(args.prompt_tokens), 8, args.timeout, args.model
            )
            if not w.ok:
                print(f"    warmup FAILED: {w.error}", file=sys.stderr)

    # Interleave the arms round by round rather than draining one then the
    # other: anything that drifts over the session -- thermals, another process
    # taking the GPU, the desktop's VRAM floor -- then lands on both arms
    # instead of on whichever ran second.
    for i in range(args.repeat):
        for label, url in arms:
            prompt = build_prompt(args.prompt_tokens)
            print(f"[{i + 1}/{args.repeat}] {label} ...", file=sys.stderr, flush=True)
            rnd = run_round(label, url, prompt, args.predict, args.timeout, args.model)
            if not rnd.ok:
                print(f"    FAILED: {rnd.error}", file=sys.stderr)
            rounds.append(rnd)

    print()
    print(report(rounds))

    if args.json_out:
        with open(args.json_out, "w") as fh:
            json.dump(
                {
                    "prompt_tokens_target": args.prompt_tokens,
                    "predict": args.predict,
                    "repeat": args.repeat,
                    "arms": {label: url for label, url in arms},
                    "rounds": [asdict(r) for r in rounds],
                },
                fh,
                indent=2,
            )
        print(f"\nwrote {args.json_out}")

    return 0 if any(r.ok for r in rounds) else 1


if __name__ == "__main__":
    sys.exit(main())
