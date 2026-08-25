#!/usr/bin/env python3
"""Prove a context window is REAL, not just advertised.

Runs INSIDE the compose network like bench.py:

    docker compose --profile tools run --rm --build \
        --entrypoint python bench /work/scripts/ctx_needle.py --tokens 90000

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
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_lib import TokenCounter, build_document, nonce, post  # noqa: E402

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama:8080")
MODEL     = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")

# The filler generator, the tokenizer-calibrated document builder and the nonce
# moved to probe_lib.py on 2026-08-23 so bench_literal.py could use the same
# calibrator instead of a second copy of it. Behaviour here is unchanged; the
# 90,055-token result recorded in versions.lock was re-verified after the move.
_count = TokenCounter(LLAMA_URL)


def build(tokens: int, a: str, b: str) -> str:
    head = f"FACT ALPHA: the alpha access code is {a}.\n"
    tail = f"FACT OMEGA: the omega access code is {b}.\n"
    return build_document(_count, tokens, head, tail)


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

    status, body = post(LLAMA_URL, "/v1/chat/completions", {
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
        c_status, c_body = post(LLAMA_URL, "/v1/chat/completions", {
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
