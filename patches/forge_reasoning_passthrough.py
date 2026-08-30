#!/usr/bin/env python3
"""Stop forge destroying a reasoning-only turn on the way to the client.

THE BUG (forge-guardrails 0.9.0; STILL PRESENT ON 0.9.5, re-verified
2026-08-30 by a clean build plus test_forge_patches.py inside the image):

``TextResponse`` carries one field. ``ToolCall`` carries ``reasoning``;
``TextResponse`` does not, and ``forge/clients/llamafile.py`` says so outright:

    # Strip [THINK] tags from text responses — reasoning is only
    # useful on ToolCall, TextResponse just gets clean content

That holds right up until the model produces reasoning and *nothing else*. Then
``accumulated_content`` is empty, the accumulated reasoning has nowhere to live,
and the client hands back ``TextResponse(content="")``. Everything the model
generated is gone before the response is built.

Measured 2026-08-17, matched control pair, identical request
(``max_tokens=250``, a prompt that induces a long think):

    llama-server :8080  ->  finish_reason "length",
                            reasoning_content: 490 chars, content: 0
    forge        :8081  ->  finish_reason "stop",
                            no reasoning_content key at all, content: 0

llama.cpp is blameless. It parsed the ``<think>`` block correctly, reported the
truncation honestly, and put 490 characters of reasoning on the wire.

WHY IT MATTERS HERE: pi records the result as an assistant message with
``content: []`` and ``stopReason: "stop"`` — a clean, successful, empty turn. It
settles the run. On this stack that has meant a Matrix question answered with
silence, and (before it was guarded) with the *previous* turn's deliberation
forwarded as though it were the answer. Reconstructed from the session that
prompted this: 126 tokens generated, at 43% of the context window, none of them
delivered anywhere.

THE FIX: give ``TextResponse`` an optional ``reasoning`` field, populate it at
every site the llama.cpp client builds one, and emit it as ``reasoning_content``
from the OpenAI response builder.

Note what this does NOT do: it does not put reasoning into ``content``. That
distinction is the whole safety argument. pi maps ``reasoning_content`` onto a
*thinking* block, and downstream consumers that forward assistant output — the
Matrix channel in vendor/prinny-channel — allowlist ``text`` blocks only. So the
model's reasoning becomes visible to the harness without becoming visible to
whoever is on the other end of a chat channel. Setting
``--reasoning-format none`` on llama-server would have recovered the same tokens
by putting them in ``content``, and would have leaked them to Matrix.

``finish_reason`` is fixed here too. ``text_response_to_openai`` hardcodes
``"stop"``, so every text response claims the model finished naturally whether it
did or not — llama-server said ``length`` for the truncated control above and
forge said ``stop``.

That is not only a diagnostic loss. A truncated ANSWER looks identical to a
finished one: the model writes past ``max_tokens``, gets cut mid-sentence, and pi
records a normal completed turn whose last half-sentence is now "the answer" —
forwarded to a chat channel as though the model had said its piece. Nothing
downstream can tell. With a truthful ``length`` the harness can continue
generation instead of shipping a fragment.

The llama.cpp client never read the field at all, which is why it needed adding
rather than passing on: the streaming loop already has ``choice`` in scope
(``choice = chunk["choices"][0]``), so it is one capture there plus the two
non-streaming sites.

Applied at image build time rather than vendored, so the upstream package stays a
pinned dependency. It verifies the exact source text before rewriting and exits
non-zero if it is absent, so a forge upgrade that touches these lines fails the
build loudly instead of quietly shipping unpatched.
"""

from __future__ import annotations

import sys
from pathlib import Path

WORKFLOW_REL = "forge/core/workflow.py"
CLIENT_REL = "forge/clients/llamafile.py"
CONVERT_REL = "forge/proxy/convert.py"
HANDLER_REL = "forge/proxy/handler.py"

# --- 1. TextResponse needs somewhere to put it -------------------------------

WORKFLOW_OLD = '''class TextResponse:
    """Non-tool-call response from the model (reasoning trace, refusal, etc.)."""

    content: str
'''

WORKFLOW_NEW = '''class TextResponse:
    """Non-tool-call response from the model (reasoning trace, refusal, etc.)."""

    content: str
    # A turn can be reasoning and nothing else. Without somewhere to put it, the
    # client builds TextResponse(content="") and everything the model generated
    # is destroyed before the response is assembled. ToolCall has carried a
    # reasoning field all along; this is the same field for the other branch.
    reasoning: str | None = None
    # Why generation stopped, straight from the backend. Without it the response
    # builder hardcodes "stop" and a truncated answer is indistinguishable from
    # a finished one.
    finish_reason: str | None = None
'''

# --- 2. the llama.cpp client has to stop dropping it -------------------------
#
# Four construction sites. Two are retry sentinels with no reasoning to carry
# (_STUTTER_RETRY_TEXT / _MALFORMED_TOOL_CALL_RETRY_TEXT) and are left alone;
# the two that carry real model output are patched, in both the streaming and
# the non-streaming path.

CLIENT_EDITS = [
    # streaming: somewhere to put it
    (
        """        accumulated_content = ""
        accumulated_reasoning = ""
""",
        """        accumulated_content = ""
        accumulated_reasoning = ""
        # Why the backend stopped. Only the LAST chunk carries it, so it is
        # captured as it goes past rather than read at the end.
        stream_finish_reason: str | None = None
""",
        1,
    ),
    # streaming: read it off each chunk
    (
        """                choice = chunk["choices"][0]
                delta = choice.get("delta", {})
""",
        """                choice = chunk["choices"][0]
                delta = choice.get("delta", {})
                if choice.get("finish_reason"):
                    stream_finish_reason = choice["finish_reason"]
""",
        1,
    ),
    # streaming, tools present but no tool call extracted
    (
        """                    final = TextResponse(content=cleaned)
""",
        """                    final = TextResponse(
                        content=cleaned,
                        reasoning=self._resolve_reasoning(
                            accumulated_reasoning, think_text
                        ),
                        finish_reason=stream_finish_reason,
                    )
""",
        1,
    ),
    # streaming, no tools
    (
        """            else:
                final = TextResponse(content=accumulated_content)
""",
        """            else:
                final = TextResponse(
                    content=accumulated_content,
                    reasoning=self._resolve_reasoning(
                        accumulated_reasoning, accumulated_content
                    ),
                    finish_reason=stream_finish_reason,
                )
""",
        1,
    ),
    # non-streaming, chat path
    (
        """        content = choice.get("content", "")
        # Strip [THINK] tags from text responses — reasoning is only
        # useful on ToolCall, TextResponse just gets clean content
        if content:
            _, content = _extract_think_tags(content)
        return TextResponse(content=content)
""",
        """        content = choice.get("content", "")
        # Think tags are still stripped OUT of content — reasoning must never be
        # mistaken for the answer — but it is now carried alongside rather than
        # thrown away.
        think_text = ""
        if content:
            think_text, content = _extract_think_tags(content)
        return TextResponse(
            content=content,
            reasoning=self._resolve_reasoning(
                choice.get("reasoning_content", ""), think_text
            ),
            # `choice` above is the MESSAGE; finish_reason sits on the choice.
            finish_reason=choices[0].get("finish_reason"),
        )
""",
        1,
    ),
    # non-streaming, prompt path
    (
        """        # Strip think tags from TextResponse — clean content only
        if content:
            _, content = _extract_think_tags(content)
        return TextResponse(content=content)
""",
        """        # Think tags are stripped out of content, and kept as reasoning.
        think_text = ""
        if content:
            think_text, content = _extract_think_tags(content)
        return TextResponse(
            content=content,
            reasoning=self._resolve_reasoning(reasoning_content, think_text),
            finish_reason=top_choice.get("finish_reason"),
        )
""",
        1,
    ),
]

# --- 3. the response builder has to emit it ----------------------------------

CONVERT_OLD = '''def text_response_to_openai(
    text: str,
    model: str = "forge",
    usage: Any | None = None,
) -> dict[str, Any]:
    """Convert a text response to an OpenAI chat completions response object."""
    response = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": text,
            },
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
'''

CONVERT_NEW = '''def text_response_to_openai(
    text: str,
    model: str = "forge",
    usage: Any | None = None,
    reasoning: str | None = None,
    finish_reason: str | None = None,
) -> dict[str, Any]:
    """Convert a text response to an OpenAI chat completions response object.

    ``reasoning`` is emitted as ``reasoning_content``, never merged into
    ``content``: consumers treat the two differently, and a channel that relays
    assistant text to a person must not relay chain-of-thought with it.

    ``finish_reason`` comes from the backend. It used to be hardcoded ``"stop"``,
    which made a response truncated at ``max_tokens`` indistinguishable from one
    the model chose to end — so a half-finished sentence was recorded as the
    final answer. ``"stop"`` remains the default for callers that have nothing
    better to say.
    """
    message: dict[str, Any] = {
        "role": "assistant",
        "content": text,
    }
    if reasoning:
        message["reasoning_content"] = reasoning
    response = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason or "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
'''

# --- 4. and the handler has to pass it along ---------------------------------

HANDLER_OLD = '''def _emit_text(
    text: str,
    model: str,
    protocol: str,
    is_stream: bool,
    usage: Any | None = None,
) -> dict[str, Any] | list[dict[str, Any]]:
    """Protocol-aware text response emitter."""
    if protocol == "anthropic":
        if is_stream:
            return text_to_anthropic_sse(text, model=model, usage=usage)
        return text_response_to_anthropic(text, model=model, usage=usage)
    if is_stream:
        return text_to_sse_events(text, model=model, usage=usage)
    return text_response_to_openai(text, model=model, usage=usage)
'''

HANDLER_NEW = '''def _emit_text(
    text: str,
    model: str,
    protocol: str,
    is_stream: bool,
    usage: Any | None = None,
    reasoning: str | None = None,
    finish_reason: str | None = None,
) -> dict[str, Any] | list[dict[str, Any]]:
    """Protocol-aware text response emitter.

    ``reasoning`` and ``finish_reason`` are only carried on the non-streaming
    OpenAI path for now; the other three emitters build their own event shapes
    and none of this stack's clients reach them.
    """
    if protocol == "anthropic":
        if is_stream:
            return text_to_anthropic_sse(text, model=model, usage=usage)
        return text_response_to_anthropic(text, model=model, usage=usage)
    if is_stream:
        return text_to_sse_events(text, model=model, usage=usage)
    return text_response_to_openai(
        text, model=model, usage=usage, reasoning=reasoning,
        finish_reason=finish_reason,
    )
'''

# The no-tools passthrough: the one call site that has a TextResponse in hand.
HANDLER_CALL_OLD = '''        text = response.content if isinstance(response, TextResponse) else ""
        return _emit_text(
            text, model_name, protocol, is_stream, usage=usage,
        )
'''

HANDLER_CALL_NEW = '''        text = response.content if isinstance(response, TextResponse) else ""
        reasoning = (
            response.reasoning if isinstance(response, TextResponse) else None
        )
        finish_reason = (
            response.finish_reason if isinstance(response, TextResponse) else None
        )
        return _emit_text(
            text, model_name, protocol, is_stream, usage=usage,
            reasoning=reasoning, finish_reason=finish_reason,
        )
'''


def fail(message: str) -> None:
    print(f"forge_reasoning_passthrough: {message}", file=sys.stderr)
    raise SystemExit(1)


def _apply(path: Path, rel: str, edits: list[tuple[str, str, int]], marker: str) -> None:
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if marker in source:
        print(f"forge_reasoning_passthrough: {rel} already patched")
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
    print(f"forge_reasoning_passthrough: patched {rel} ({len(edits)} site(s))")


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_reasoning_passthrough.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    _apply(root / WORKFLOW_REL, WORKFLOW_REL, [(WORKFLOW_OLD, WORKFLOW_NEW, 1)],
           marker="finish_reason: str | None = None\n\n\ntype LLMResponse")
    _apply(root / CLIENT_REL, CLIENT_REL, CLIENT_EDITS,
           marker="stream_finish_reason: str | None = None")
    # NOT 'message["reasoning_content"] = reasoning' — that string already
    # exists in the tool-call builder under reasoning_replay="keep-last", so it
    # reports "already patched" on a pristine install and silently skips the
    # text path. Caught by applying this to a real copy before shipping it.
    _apply(root / CONVERT_REL, CONVERT_REL, [(CONVERT_OLD, CONVERT_NEW, 1)],
           marker='finish_reason or "stop"')
    _apply(root / HANDLER_REL, HANDLER_REL,
           [(HANDLER_OLD, HANDLER_NEW, 1), (HANDLER_CALL_OLD, HANDLER_CALL_NEW, 1)],
           marker="reasoning=reasoning, finish_reason=finish_reason,")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
