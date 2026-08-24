#!/usr/bin/env python3
"""Patch 4's hole on the Anthropic wire: reasoning, and a truthful stop_reason.

`patches/forge_reasoning_passthrough.py` (patch 4) fixed both of these on the
OpenAI wire and said so in its own docstring:

    ``reasoning`` and ``finish_reason`` are only carried on the non-streaming
    OpenAI path for now; the other three emitters build their own event shapes
    and none of this stack's clients reach them.

That is now three defects on the Anthropic side, and the middle one is worse
than "not carried".

DEFECT 1 — REASONING IS EMITTED AS A ``text`` BLOCK, WHICH IS A SAFETY
INVERSION. ``convert_anthropic.py:tool_calls_to_anthropic`` does:

    if tool_calls and tool_calls[0].reasoning and reasoning_replay == "full":
        blocks.append({"type": "text", "text": tool_calls[0].reasoning})

``text`` is *exactly* the block type ``vendor/prinny-channel`` forwards to a
Matrix room — patch 4's whole safety argument is that reasoning must stay off
``content`` for that reason. On the OpenAI wire it does. On the Anthropic wire
the model's private deliberation is labelled as the thing that gets forwarded.
The SSE builder does the same, one block type deeper.

DEFECT 2 — ``text_response_to_anthropic`` HAS NEITHER PARAMETER. Not "does not
carry them": the signature is ``(text, model, usage)``. A reasoning-only turn on
the Anthropic wire loses everything the model generated, which is the exact
failure patch 4 exists to prevent, and ``stop_reason`` is the literal
``"end_turn"`` whether the model finished or was cut off at ``max_tokens``. A
truncated ANSWER is indistinguishable from a finished one.

DEFECT 3 — ``text_to_anthropic_sse`` is defect 2 again, streaming.

THE DECISION THIS ENCODES, AND WHY IT IS NOT THE ANTHROPIC-NATIVE SHAPE.

The obvious fix is a ``thinking`` block — that is what the Anthropic API uses,
and prinny does not forward it. It is rejected here, deliberately.

An Anthropic ``thinking`` block carries a ``signature`` that the API ISSUES and
VERIFIES. A proxy in front of a local model cannot mint one. That leaves three
options and only one of them is safe:

  - **A fabricated signature.** A forged attestation, written into a durable
    transcript, which a later session can replay against the real API. It is the
    one option that cannot be walked back once a transcript exists. Refused.
  - **A ``thinking`` block with no signature.** The real API rejects a thinking
    block without one when it is sent back in a subsequent request, so this
    produces a document that is valid nowhere — it looks native and is not.
    Refused.
  - **Reasoning off ``content`` entirely**, on a top-level ``reasoning_content``
    key. Chosen.

The third also makes the safety property STRUCTURAL rather than borrowed. Any
in-``content`` block relies on prinny's allowlist — code in a different repo —
continuing to allowlist ``text`` only. Keeping reasoning out of ``content``
holds even if that allowlist changes, and it mirrors patch 4's OpenAI decision
exactly: one rule, two wires.

Clients that do not want the key ignore it, the same way they ignore
``reasoning_content`` on the OpenAI wire today.

THE STOP-REASON MAPPING, and the one case where the wire still cannot be
truthful. OpenAI finish reasons map onto Anthropic stop reasons:

    stop            -> end_turn
    length          -> max_tokens
    tool_calls      -> tool_use
    function_call   -> tool_use
    content_filter  -> refusal

An unrecognised value falls back to ``end_turn`` because the Anthropic schema
has no "unknown" — that is the one case this patch cannot fix, and the table is
written out rather than hidden behind a bare ``.get`` so a new upstream value is
visible in review instead of silently becoming "the model finished".

APPLY: same shape as every other patch here — run against a site-packages
directory, refuses if the upstream block is not exactly what it expects, and is
idempotent via a marker.
"""

from __future__ import annotations

import sys
from pathlib import Path

CONVERT_REL = "forge/proxy/convert_anthropic.py"
HANDLER_REL = "forge/proxy/handler.py"


# ── the stop-reason table, inserted once above the first emitter ─────────────

HELPER_OLD = '''def tool_calls_to_anthropic(
    tool_calls: list[ToolCall],
    model: str = "forge",
    usage: Any | None = None,
    reasoning_replay: ReasoningReplay = DEFAULT_REASONING_REPLAY,
) -> dict[str, Any]:
    """Convert forge ToolCalls to an Anthropic Messages API response object."""
    reasoning_replay = validate_reasoning_replay(reasoning_replay)
    blocks: list[dict[str, Any]] = []

    if tool_calls and tool_calls[0].reasoning and reasoning_replay == "full":
        blocks.append({"type": "text", "text": tool_calls[0].reasoning})

    for tc in tool_calls:
        blocks.append({
            "type": "tool_use",
            "id": f"toolu_{uuid.uuid4().hex[:24]}",
            "name": tc.tool,
            "input": tc.args,
        })

    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": blocks,
        "stop_reason": "tool_use",
        "stop_sequence": None,
        "usage": _anthropic_usage(usage),
    }
'''

HELPER_NEW = '''# OpenAI finish_reason -> Anthropic stop_reason. Written out rather than hidden
# behind a bare .get() so that a value forge starts emitting and this table does
# not know about is visible in review, instead of silently arriving on the wire
# as "the model finished naturally".
_ANTHROPIC_STOP_REASON = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "content_filter": "refusal",
}


def _anthropic_stop_reason(finish_reason: str | None) -> str:
    """Map a finish_reason onto the Anthropic schema.

    An unmapped value becomes "end_turn" because the schema has no "unknown".
    That is the single case where this cannot be truthful, and it is the reason
    the table above is explicit.
    """
    if not finish_reason:
        return "end_turn"
    return _ANTHROPIC_STOP_REASON.get(finish_reason, "end_turn")


def _attach_reasoning(payload: dict[str, Any], reasoning: str | None) -> dict[str, Any]:
    """Put reasoning on the response, NEVER into ``content``.

    ``content`` is what downstream forwards. vendor/prinny-channel allowlists
    ``text`` blocks, so anything placed there can reach a Matrix room; a
    ``thinking`` block would avoid that today but needs a ``signature`` this
    proxy cannot mint, and a fabricated one is a forged attestation in a durable
    transcript. A top-level key is the shape that is safe without depending on
    another repo's allowlist. Mirrors ``reasoning_content`` on the OpenAI wire.
    """
    if reasoning:
        payload["reasoning_content"] = reasoning
    return payload


def tool_calls_to_anthropic(
    tool_calls: list[ToolCall],
    model: str = "forge",
    usage: Any | None = None,
    reasoning_replay: ReasoningReplay = DEFAULT_REASONING_REPLAY,
) -> dict[str, Any]:
    """Convert forge ToolCalls to an Anthropic Messages API response object."""
    reasoning_replay = validate_reasoning_replay(reasoning_replay)
    blocks: list[dict[str, Any]] = []

    for tc in tool_calls:
        blocks.append({
            "type": "tool_use",
            "id": f"toolu_{uuid.uuid4().hex[:24]}",
            "name": tc.tool,
            "input": tc.args,
        })

    reasoning = tool_calls[0].reasoning if tool_calls else None
    if reasoning_replay != "full":
        reasoning = None

    return _attach_reasoning({
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": blocks,
        "stop_reason": "tool_use",
        "stop_sequence": None,
        "usage": _anthropic_usage(usage),
    }, reasoning)
'''


TEXT_OLD = '''def text_response_to_anthropic(
    text: str,
    model: str = "forge",
    usage: Any | None = None,
) -> dict[str, Any]:
    """Convert a text response to an Anthropic Messages API response object."""
    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": _anthropic_usage(usage),
    }
'''

TEXT_NEW = '''def text_response_to_anthropic(
    text: str,
    model: str = "forge",
    usage: Any | None = None,
    reasoning: str | None = None,
    finish_reason: str | None = None,
) -> dict[str, Any]:
    """Convert a text response to an Anthropic Messages API response object.

    ``reasoning`` lands on a top-level key, never in ``content``; see
    ``_attach_reasoning``. ``finish_reason`` replaces a hardcoded "end_turn"
    that made a response truncated at max_tokens indistinguishable from a
    finished one.
    """
    return _attach_reasoning({
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": _anthropic_stop_reason(finish_reason),
        "stop_sequence": None,
        "usage": _anthropic_usage(usage),
    }, reasoning)
'''


SSE_TOOLS_OLD = '''    block_idx = 0

    # Reasoning text first, if present.
    reasoning = tool_calls[0].reasoning if tool_calls else None
    if reasoning and reasoning_replay == "full":
        events.append({
            "type": "content_block_start",
            "index": block_idx,
            "content_block": {"type": "text", "text": ""},
        })
        events.append({
            "type": "content_block_delta",
            "index": block_idx,
            "delta": {"type": "text_delta", "text": reasoning},
        })
        events.append({"type": "content_block_stop", "index": block_idx})
        block_idx += 1

'''

SSE_TOOLS_NEW = '''    block_idx = 0

    # Reasoning goes on the message_start payload, NOT into a content block.
    # It used to be emitted as a ``text`` block, which is the one block type
    # vendor/prinny-channel forwards to a Matrix room.
    reasoning = tool_calls[0].reasoning if tool_calls else None
    if reasoning and reasoning_replay == "full":
        _attach_reasoning(events[0]["message"], reasoning)

'''


SSE_TEXT_OLD = '''def text_to_anthropic_sse(
    text: str,
    model: str = "forge",
    usage: Any | None = None,
) -> list[dict[str, Any]]:
    """Build the Anthropic SSE event sequence for a text response."""
    au = _anthropic_usage(usage)
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    return [
        {
            "type": "message_start",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": au["input_tokens"], "output_tokens": 1},
            },
        },'''

SSE_TEXT_NEW = '''def text_to_anthropic_sse(
    text: str,
    model: str = "forge",
    usage: Any | None = None,
    reasoning: str | None = None,
    finish_reason: str | None = None,
) -> list[dict[str, Any]]:
    """Build the Anthropic SSE event sequence for a text response.

    ``reasoning`` rides on the message_start payload rather than as a content
    block, and ``finish_reason`` reaches the message_delta instead of a
    hardcoded "end_turn"; see ``_attach_reasoning`` and
    ``_anthropic_stop_reason``.
    """
    au = _anthropic_usage(usage)
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    return [
        {
            "type": "message_start",
            "message": _attach_reasoning({
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": au["input_tokens"], "output_tokens": 1},
            }, reasoning),
        },'''


SSE_TEXT_STOP_OLD = '''        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": au["output_tokens"]},
        },
        {"type": "message_stop"},
    ]'''

SSE_TEXT_STOP_NEW = '''        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {
                "stop_reason": _anthropic_stop_reason(finish_reason),
                "stop_sequence": None,
            },
            "usage": {"output_tokens": au["output_tokens"]},
        },
        {"type": "message_stop"},
    ]'''


HANDLER_OLD = '''    """Protocol-aware text response emitter.

    ``reasoning`` and ``finish_reason`` are only carried on the non-streaming
    OpenAI path for now; the other three emitters build their own event shapes
    and none of this stack's clients reach them.
    """
    if protocol == "anthropic":
        if is_stream:
            return text_to_anthropic_sse(text, model=model, usage=usage)
        return text_response_to_anthropic(text, model=model, usage=usage)'''

HANDLER_NEW = '''    """Protocol-aware text response emitter.

    ``reasoning`` and ``finish_reason`` are carried on both protocols. On the
    Anthropic wire reasoning lands on a top-level ``reasoning_content`` key
    rather than in ``content``; patches/forge_anthropic_reasoning.py has the
    argument for why not a ``thinking`` block.

    The OpenAI SSE path is still the one place neither is carried.
    """
    if protocol == "anthropic":
        if is_stream:
            return text_to_anthropic_sse(
                text, model=model, usage=usage,
                reasoning=reasoning, finish_reason=finish_reason,
            )
        return text_response_to_anthropic(
            text, model=model, usage=usage,
            reasoning=reasoning, finish_reason=finish_reason,
        )'''


def fail(message: str) -> None:
    print(f"forge_anthropic_reasoning: {message}", file=sys.stderr)
    raise SystemExit(1)


def _apply(path: Path, rel: str, edits: list[tuple[str, str, int]], marker: str) -> None:
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if marker in source:
        print(f"forge_anthropic_reasoning: {rel} already patched")
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
    print(f"forge_anthropic_reasoning: patched {rel} ({len(edits)} site(s))")


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_anthropic_reasoning.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    # The marker is the helper's def line: it exists nowhere in a pristine
    # convert_anthropic.py, and unlike a fragment such as "reasoning_content"
    # it cannot be matched by anything this patch did not write.
    _apply(root / CONVERT_REL, CONVERT_REL,
           [(HELPER_OLD, HELPER_NEW, 1),
            (TEXT_OLD, TEXT_NEW, 1),
            (SSE_TOOLS_OLD, SSE_TOOLS_NEW, 1),
            (SSE_TEXT_OLD, SSE_TEXT_NEW, 1),
            (SSE_TEXT_STOP_OLD, SSE_TEXT_STOP_NEW, 1)],
           marker="def _anthropic_stop_reason(")
    _apply(root / HANDLER_REL, HANDLER_REL, [(HANDLER_OLD, HANDLER_NEW, 1)],
           marker="patches/forge_anthropic_reasoning.py has the")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
