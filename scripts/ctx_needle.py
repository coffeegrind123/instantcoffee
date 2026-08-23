#!/usr/bin/env python3
"""Prove a context window is REAL, not just advertised.

Runs INSIDE the compose network like bench.py:

    docker compose --profile tools run --rm --build \
        --entrypoint python bench /work/scripts/ctx-needle.py --tokens 90000

WHY A SEPARATE SCRIPT
---------------------
`/props` reporting n_ctx = 98304 proves the server ACCEPTED the flag, nothing
more. bench.py proves prefill runs at depth, which is closer but still only
shows tokens went in — a window that silently truncated the middle would give
identical prefill numbers and identical tok/s.

The only thing that proves a window is retrieval from BOTH ENDS of it. Two
distinct facts are planted, one near the start and one near the end, separated
by filler, and the answer has to contain both. A truncating or sliding window
loses the first one; an off-by-one in the KV loses the last.

THE NEGATIVE CONTROL IS NOT OPTIONAL
------------------------------------
A pass proves the window is at least as big as the prompt. It does NOT prove the
limit is enforced rather than silently wrapped. So --control sends a prompt PAST
the window and requires a clean refusal naming the limit. Without it, "it
answered" is consistent with a server quietly dropping tokens, which is the
failure this is meant to catch.

The needles are nonce-based so a prompt-cache hit cannot manufacture a pass.
"""

from __future__ import annotations
import json, os, random, string, sys, urllib.request

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama:8080")
MODEL     = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")


def nonce(n: int = 8) -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=n))


def post(path: str, payload: dict, timeout: int = 900):
    req = urllib.request.Request(
        LLAMA_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:600]


def tokenize(text: str) -> int:
    """Token count from the SERVER's tokenizer, not an estimate."""
    status, body = post("/tokenize", {"content": text}, timeout=300)
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"/tokenize failed: {status} {body}")
    return len(body["tokens"])


VOCAB = ["ledger", "turbine", "meridian", "basalt", "quorum", "tessellate",
         "harbor", "cinder", "valence", "ripcord", "alcove", "gantry",
         "fathom", "kindling"]


def filler(n_words: int) -> str:
    # Varied rather than one repeated phrase: a repeated phrase is exactly what
    # ngram-simple drafts straight through, and a prompt the drafter can predict
    # is not a test of the CACHE.
    rng = random.Random(1234)
    out = []
    for i in range(n_words):
        out.append(f"{rng.choice(VOCAB)}{i % 97}")
        if i % 24 == 23:
            out.append("\n")
    return " ".join(out)


def build(tokens: int, a: str, b: str) -> str:
    """A document of ~`tokens` tokens with a fact at each end.

    The word count is CALIBRATED against the server's tokenizer instead of
    assumed. The first version of this used a fixed 1.35 words-per-token and
    produced 452,701 tokens for a 90,000 target — a 5x overshoot, because filler
    like "ledger42" is three tokens (word + digits), not the fraction of one the
    constant implied. A generator that cannot hit its own target cannot test a
    context limit; it just tests the limit's error message.
    """
    head = f"FACT ALPHA: the alpha access code is {a}.\n"
    tail = f"FACT OMEGA: the omega access code is {b}.\n"
    overhead = tokenize(head + tail)

    per_word = tokenize(filler(200)) / 200.0
    n_words = max(1, int((tokens - overhead) / per_word))

    # One correction pass: the rate from a 200-word sample is close but not
    # exact over 30,000 words, and being 2% over a context limit is a refusal
    # rather than a slightly short prompt.
    for _ in range(3):
        body = filler(n_words)
        total = tokenize(head + body + "\n" + tail)
        err = (total - tokens) / float(tokens)
        print(f"  calibrating: {n_words} words -> {total} tokens ({err:+.1%})")
        if abs(err) <= 0.01:
            break
        n_words = max(1, int(n_words * (tokens - overhead) / max(1, total - overhead)))
    return head + body + "\n" + tail


def main() -> int:
    args = sys.argv[1:]
    tokens, control = 90000, 0
    i = 0
    while i < len(args):
        if args[i] == "--tokens":
            tokens = int(args[i + 1]); i += 2
        elif args[i] == "--control":
            control = int(args[i + 1]); i += 2
        elif args[i] in ("-h", "--help"):
            print(__doc__); return 0
        else:
            print(f"unknown argument: {args[i]}", file=sys.stderr); return 2

    a, b = nonce(), nonce()
    prompt = build(tokens, a, b)
    question = ("\n\nUsing ONLY the document above, reply with exactly this line:\n"
                "ALPHA=<the alpha access code> OMEGA=<the omega access code>\n")

    print(f"ctx-needle — {MODEL} via {LLAMA_URL}")
    print(f"  target ~{tokens} tokens, alpha={a} omega={b}\n")

    status, body = post("/v1/chat/completions", {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt + question}],
        "max_tokens": 128, "temperature": 0.0,
        # TOP-LEVEL, not inside chat_template_kwargs. The nested form is passed
        # to the Jinja template, and this model's template accepts only xhigh,
        # medium and low — "none" makes it raise_exception and the request comes
        # back HTTP 500. The top-level key is a llama-server parameter and is
        # the form bench_quality.py:154 already uses. Thinking is switched off
        # here on purpose: this measures RETRIEVAL from the KV cache, and a
        # reasoning trace would just spend the token budget before the answer.
        "reasoning_effort": "none",
    })

    if status != 200:
        print(f"  [FAIL] HTTP {status}: {body}")
        return 1

    text  = body["choices"][0]["message"]["content"] or ""
    usage = body.get("usage", {})
    n_in  = usage.get("prompt_tokens", "?")
    print(f"  prompt_tokens = {n_in}")
    print(f"  finish_reason = {body['choices'][0].get('finish_reason')}")
    print(f"  answer        = {text.strip()[:200]!r}")

    got_a, got_b = a in text, b in text
    print(f"  [{'PASS' if got_a else 'FAIL'}] alpha needle (start of document) {a}")
    print(f"  [{'PASS' if got_b else 'FAIL'}] omega needle (end of document)   {b}")
    rc = 0 if (got_a and got_b) else 1

    if control:
        print(f"\n  negative control — {control} tokens, PAST the window")
        c_status, c_body = post("/v1/chat/completions", {
            "model": MODEL,
            "messages": [{"role": "user", "content": build(control, nonce(), nonce()) + question}],
            "max_tokens": 16, "temperature": 0.0, "reasoning_effort": "none",
        })
        blob = c_body if isinstance(c_body, str) else json.dumps(c_body)
        refused = c_status != 200 and ("context" in blob.lower() or "exceed" in blob.lower())
        print(f"  HTTP {c_status}: {blob[:220]}")
        print(f"  [{'PASS' if refused else 'FAIL'}] refused cleanly, naming the limit")
        if not refused:
            print("  A prompt past the window that is ANSWERED means the server is")
            print("  silently dropping tokens. The positive result above is void.")
            rc = 1

    print("\n" + ("ALL CHECKS PASSED" if rc == 0 else "FAILED"))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
