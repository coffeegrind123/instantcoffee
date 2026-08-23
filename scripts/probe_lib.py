#!/usr/bin/env python3
"""Shared machinery for the depth probes that run inside the compose network.

EXTRACTED FROM ctx_needle.py 2026-08-23, when bench_literal.py needed the same
four things and copying them would have meant two calibrators to keep correct.
ctx_needle.py's behaviour is unchanged; it now imports from here.

Everything in this module talks to a BASE URL passed in by the caller, because
the two probes do not talk to the same place: ctx_needle measures the KV cache
and goes straight to llama, while bench_literal measures the production
tool-call path and goes through forge. A module-level LLAMA_URL — which is what
ctx_needle had — makes the second one impossible to express.
"""

from __future__ import annotations

import json
import random
import string
import urllib.error
import urllib.request

__all__ = ["nonce", "post", "TokenCounter", "filler", "build_document"]


def nonce(n: int = 8) -> str:
    """Random uppercase+digit string. Defeats two different cheats at once.

    A planted fact the model could have memorised is not a retrieval test, and a
    prompt identical to the last run's is served from the prefix cache — which
    would manufacture a pass without the KV cache ever being read at depth.
    """
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=n))


def post(base: str, path: str, payload: dict, timeout: float = 900.0):
    """POST JSON, return (status, parsed-body-or-error-text).

    Never raises for an HTTP error: an error body is evidence and the callers
    print it. Only a transport failure propagates, because that means the thing
    under test is not there at all and a probe result would be meaningless.
    """
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw[:2000]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:2000]


class TokenCounter:
    """Token counts from the SERVER's tokenizer, never from an estimate.

    Memoised, because calibration asks the same short samples repeatedly and
    /tokenize on a 90,000-token document is not free.

    llama-server's /tokenize is not exposed by forge, so this ALWAYS points at
    llama directly even when the probe under it is measuring forge. That is
    correct rather than a shortcut: the tokenizer is a property of the model,
    and asking the proxy about it would only add a hop that can fail.
    """

    def __init__(self, llama_url: str, timeout: float = 300.0) -> None:
        self.base = llama_url
        self.timeout = timeout
        self._cache: dict[str, int] = {}

    def __call__(self, text: str) -> int:
        hit = self._cache.get(text)
        if hit is not None:
            return hit
        status, body = post(self.base, "/tokenize", {"content": text}, self.timeout)
        if status != 200 or not isinstance(body, dict) or "tokens" not in body:
            raise RuntimeError(f"/tokenize failed: {status} {str(body)[:300]}")
        n = len(body["tokens"])
        # Only small samples are worth keeping; a 90k document would be a
        # megabyte of dict key for a number used once.
        if len(text) < 8192:
            self._cache[text] = n
        return n


VOCAB = ["ledger", "turbine", "meridian", "basalt", "quorum", "tessellate",
         "harbor", "cinder", "valence", "ripcord", "alcove", "gantry",
         "fathom", "kindling"]


def filler(n_words: int, seed: int = 1234) -> str:
    """Varied filler, NOT one repeated phrase.

    A repeated phrase is exactly what ngram-simple drafts straight through, and
    a prompt the drafter can predict is not a test of the cache.
    """
    rng = random.Random(seed)
    out = []
    for i in range(n_words):
        out.append(f"{rng.choice(VOCAB)}{i % 97}")
        if i % 24 == 23:
            out.append("\n")
    return " ".join(out)


def build_document(count: TokenCounter, tokens: int, head: str, tail: str,
                   seed: int = 1234, verbose: bool = True) -> str:
    """`head` + calibrated filler + `tail`, totalling ~`tokens` tokens.

    THE WORD COUNT IS CALIBRATED AGAINST THE TOKENIZER, NOT ASSUMED. The first
    version of this used a fixed 1.35 words-per-token and produced 452,701
    tokens for a 90,000 target — a 5x overshoot, because filler like "ledger42"
    is three tokens (word + digits), not the fraction of one the constant
    implied. A generator that cannot hit its own target does not test a context
    limit; it tests the limit's error message.

    Three correction passes: the rate from a 200-word sample is close but not
    exact over 30,000 words, and being 2% over a context limit is a refusal
    rather than a slightly short prompt.
    """
    overhead = count(head + tail)
    if overhead >= tokens:
        raise ValueError(
            f"the fixed parts are already {overhead} tokens, which is not less "
            f"than the {tokens}-token target: nothing to calibrate")

    per_word = count(filler(200, seed)) / 200.0
    n_words = max(1, int((tokens - overhead) / per_word))

    body = filler(n_words, seed)
    for _ in range(3):
        body = filler(n_words, seed)
        total = count(head + body + "\n" + tail)
        err = (total - tokens) / float(tokens)
        if verbose:
            print(f"  calibrating: {n_words} words -> {total} tokens ({err:+.1%})")
        if abs(err) <= 0.01:
            break
        n_words = max(1, int(n_words * (tokens - overhead) / max(1, total - overhead)))
    return head + body + "\n" + tail
