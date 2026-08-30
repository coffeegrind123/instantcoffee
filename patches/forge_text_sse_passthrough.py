#!/usr/bin/env python3
"""Carry the reasoning and the real finish_reason on the OpenAI SSE text path.

THE BUG (forge-guardrails 0.9.0, with patches 1-8 applied; still present on
0.9.5, re-verified 2026-08-30), and forge says it
itself. ``handler._emit_text`` routes four ways and its own docstring ends::

    The OpenAI SSE path is still the one place neither is carried.

    if is_stream:
        return text_to_sse_events(text, model=model, usage=usage)   # <- here
    return text_response_to_openai(
        text, model=model, usage=usage, reasoning=reasoning,
        finish_reason=finish_reason,
    )

``text_to_sse_events`` takes neither argument and ends every stream with a
hardcoded::

    "finish_reason": "stop",

That leaves the four emitters disagreeing about the same response. Anthropic
carries both, streaming or not (patch 6). OpenAI non-streaming carries both
(patches 3 and 7). OpenAI streaming carries neither — and **OpenAI streaming is
what pi uses for every turn of every session on this stack.**

WHY IT MATTERS, MEASURED 2026-08-27 against the live pair:

    llama:8080  stream=False, max_tokens=220   finish_reason "length",
                                               completion_tokens 220
    llama:8080  stream=True,  max_tokens=220   220 chunks, finish_reason
                                               "length" on the last one
    forge:8081  stream=True,  max_tokens=220   finish_reason "stop"

llama-server is right in both of its cells and says so in the streaming one, so
this is not a backend that withholds the truth — it is forge dropping it at the
last step. The client is told a turn that ran out of budget mid-sentence ended
because the model had finished. That is the same defect patch 3 fixed for the
non-streaming shape and patch 7 for the exception path; this is the third and
last shape of it, and the only one pi ever sees.

It is also the shape that matters most on this box, because it is how a wedged
turn hides. An unattended ``/loop`` run on 2026-08-27 spent 45 minutes on turns
that generated the full 8,192-token cap and reached pi as ``content: []`` with
``stopReason: "stop"`` — nothing in the transcript said "truncated", so nothing
downstream could treat it as a failed turn rather than a quiet one.
``patches/forge_empty_turn.py`` stops those turns being empty; this patch stops
the ones that remain from lying about why they ended.

THE FIX: give ``text_to_sse_events`` the two arguments its non-streaming twin
already takes, emit the reasoning the way ``tool_calls_to_sse_events`` already
does — its own delta, never merged into ``content`` — and let the backend's
finish_reason through, with ``"stop"`` still the default for callers that have
nothing better to say. Then pass them from ``_emit_text`` and delete the
sentence in its docstring that is no longer true.
"""

from __future__ import annotations

import sys
from pathlib import Path

CONVERT_REL = "forge/proxy/convert.py"
HANDLER_REL = "forge/proxy/handler.py"

# --- 1. the emitter takes what its non-streaming twin takes -------------------

CONVERT_OLD = '''def text_to_sse_events(
    text: str,
    model: str = "forge",
    chunk_size: int = 0,
    usage: Any | None = None,
) -> list[dict[str, Any]]:
    """Convert a text response to SSE chunk objects.

    If chunk_size > 0, splits the text into chunks of that size for
    more realistic streaming. Otherwise sends the full text in one chunk.
    """
    cmpl_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    events: list[dict[str, Any]] = []

    if chunk_size > 0 and len(text) > chunk_size:
        chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]
    else:
        chunks = [text]

    for i, chunk in enumerate(chunks):
        delta: dict[str, Any] = {"content": chunk}
        if i == 0:
            delta["role"] = "assistant"
'''

CONVERT_NEW = '''def text_to_sse_events(
    text: str,
    model: str = "forge",
    chunk_size: int = 0,
    usage: Any | None = None,
    reasoning: str | None = None,
    finish_reason: str | None = None,
) -> list[dict[str, Any]]:
    """Convert a text response to SSE chunk objects.

    If chunk_size > 0, splits the text into chunks of that size for
    more realistic streaming. Otherwise sends the full text in one chunk.

    ``reasoning`` and ``finish_reason`` are the same two things
    ``text_response_to_openai`` carries, for the same reasons — this is the
    streaming shape of that response, and the two must not disagree about it.
    Reasoning rides its own ``reasoning_content`` delta and is never merged into
    ``content``; ``finish_reason`` comes from the backend, so a turn cut off at
    ``max_tokens`` is not reported as one the model chose to end.
    ``"stop"`` remains the default for callers with nothing better to say.
    See patches/forge_text_sse_passthrough.py.
    """
    cmpl_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    events: list[dict[str, Any]] = []

    if chunk_size > 0 and len(text) > chunk_size:
        chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]
    else:
        chunks = [text]

    if reasoning:
        # Its own event, ahead of the text, mirroring tool_calls_to_sse_events.
        # A reasoning-only turn has one empty chunk of text below, so without
        # this the whole response is an empty delta and a finish_reason.
        events.append({
            "id": cmpl_id,
            "object": "chat.completion.chunk",
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "reasoning_content": reasoning},
                "finish_reason": None,
            }],
        })

    for i, chunk in enumerate(chunks):
        delta: dict[str, Any] = {"content": chunk}
        if i == 0 and not reasoning:
            delta["role"] = "assistant"
'''

CONVERT_FINAL_OLD = '''    # Final chunk
    final_event = {
        "id": cmpl_id,
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "stop",
        }],
    }
'''

CONVERT_FINAL_NEW = '''    # Final chunk
    final_event = {
        "id": cmpl_id,
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": finish_reason or "stop",
        }],
    }
'''

# --- 2. the one caller passes them -------------------------------------------

HANDLER_OLD = '''    ``reasoning`` and ``finish_reason`` are carried on both protocols. On the
    Anthropic wire reasoning lands on a top-level ``reasoning_content`` key
    rather than in ``content``; patches/forge_anthropic_reasoning.py has the
    argument for why not a ``thinking`` block.

    The OpenAI SSE path is still the one place neither is carried.
    """
'''

HANDLER_NEW = '''    ``reasoning`` and ``finish_reason`` are carried on all four paths, streaming
    or not. On the Anthropic wire reasoning lands on a top-level
    ``reasoning_content`` key rather than in ``content``;
    patches/forge_anthropic_reasoning.py has the argument for why not a
    ``thinking`` block.

    The OpenAI SSE path was the last one to carry neither, which mattered more
    than one path in four suggests: it is the path pi takes on every turn. See
    patches/forge_text_sse_passthrough.py.
    """
'''

HANDLER_CALL_OLD = '''    if is_stream:
        return text_to_sse_events(text, model=model, usage=usage)
'''

HANDLER_CALL_NEW = '''    if is_stream:
        return text_to_sse_events(
            text, model=model, usage=usage,
            reasoning=reasoning, finish_reason=finish_reason,
        )
'''


def fail(message: str) -> None:
    print(f"forge_text_sse_passthrough: {message}", file=sys.stderr)
    raise SystemExit(1)


def _apply(path: Path, rel: str, edits: list[tuple[str, str, int]], marker: str) -> None:
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if marker in source:
        print(f"forge_text_sse_passthrough: {rel} already patched")
        return
    for old, new, expected in edits:
        count = source.count(old)
        if count != expected:
            fail(
                f"expected {expected} occurrence(s) of a block in {rel}, found {count}. "
                "forge changed it — re-read the file before shipping."
            )
        source = source.replace(old, new)
    path.write_text(source)
    print(f"forge_text_sse_passthrough: patched {rel} ({len(edits)} site(s))")


def _require_patch_three(root: Path) -> None:
    """The non-streaming twin must already carry both fields.

    This patch's whole argument is that the two shapes of one response must not
    disagree. If forge_reasoning_passthrough.py has not run, the shape being
    matched is still the lossy one, and matching it would prove nothing.
    """
    source = (root / CONVERT_REL).read_text()
    if "``finish_reason`` comes from the backend." not in source:
        fail(
            "text_response_to_openai does not carry finish_reason — apply "
            "forge_reasoning_passthrough.py before this patch (see the COPY/RUN "
            "order in Dockerfile.forge)."
        )


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_text_sse_passthrough.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    _require_patch_three(root)

    _apply(
        root / CONVERT_REL,
        CONVERT_REL,
        [
            (CONVERT_OLD, CONVERT_NEW, 1),
            (CONVERT_FINAL_OLD, CONVERT_FINAL_NEW, 1),
        ],
        # Present only after this patch. NOT "finish_reason or \\"stop\\"" —
        # patch 3 puts that exact expression in this same file, one function up,
        # so it would report "already patched" on a correctly-ordered build and
        # silently skip the streaming emitter this patch exists for.
        marker="See patches/forge_text_sse_passthrough.py.",
    )
    _apply(
        root / HANDLER_REL,
        HANDLER_REL,
        [
            (HANDLER_OLD, HANDLER_NEW, 1),
            (HANDLER_CALL_OLD, HANDLER_CALL_NEW, 1),
        ],
        marker="it is the path pi takes on every turn",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
