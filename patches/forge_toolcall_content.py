#!/usr/bin/env python3
"""Stop forge destroying the model's own words on a TOOL-CALL turn.

THE BUG (forge-guardrails 0.9.0; STILL PRESENT ON 0.9.5, re-verified
2026-08-30 by a clean build plus test_forge_patches.py inside the image):

A forge ``ToolCall`` carries ``tool``, ``args`` and ``reasoning``. It has no
field for the assistant text that came WITH the call — so on a turn where the
model says something and then calls a tool, the something is not dropped at the
last step, it has nowhere to live in forge's own data model and never survives
the client that parsed it.

``forge/proxy/convert.py::tool_calls_to_openai`` then fills the hole with the
reasoning:

    reasoning = tool_calls[0].reasoning if tool_calls else None
    message = {
        "role": "assistant",
        "content": reasoning if reasoning_replay == "full" else None,
        "tool_calls": tc_list,
    }
    if reasoning and reasoning_replay == "keep-last":
        message["reasoning_content"] = reasoning

Measured 2026-08-23, matched control pair, identical request, no proxy of ours
in the path:

    llama-server :8080   content   "I'm going to look up the current weather in Paris for you."
                         reasoning "The user wants me to say one sentence about what I'm…"
                         tool      weather {"city":"Paris"}

    forge        :8081   content   "The user wants me to say one sentence about what I'm…"
                         reasoning  (no reasoning_content key at all)
                         tool      weather {"city": "Paris"}

The model said a sentence; the client got its private deliberation instead, and
the sentence is gone. On an agent loop the tool-call path is nearly every turn.

WHY IT MATTERS HERE, TWICE OVER:

1. pi renders assistant text as the assistant's answer. Every tool-calling turn
   of every session on this stack has been showing the model's thinking in that
   position, and never showing what it actually said.
2. ``patches/forge_reasoning_passthrough.py`` — the third patch in this image —
   fixed exactly this for ``TextResponse`` and its docstring is explicit about
   why reasoning must NOT go into content: pi maps ``reasoning_content`` onto a
   *thinking* block, and downstream consumers that forward assistant output (the
   Matrix channel in vendor/prinny-channel) allowlist ``text`` blocks only. With
   ``FORGE_REASONING_REPLAY=full``, the tool-call path makes the reasoning a
   text block. It is the leak that patch exists to prevent, on the path that
   patch does not cover.

THE REPLAY POLICY DOES NOT NEED THIS, AND THAT IS THE KEY POINT.
``reasoning_replay`` is really implemented in
``forge/core/reasoning.py::filter_openai_reasoning_messages``, on the INBOUND
path, by deciding how many assistant messages keep their ``reasoning_content``
field before the request goes to the backend — ``full`` keeps all, ``keep-last``
keeps the newest, ``none`` strips them. That mechanism is untouched here and
keeps working. Putting the reasoning into ``content`` on the way OUT is a
second, redundant route to the same replay, and it is the one that costs the
model's text. After this patch ``full`` still means "replay every turn's
reasoning to the backend"; it stops also meaning "and tell the client that
reasoning is what the model said".

THE FIX:

1. ``ToolCall`` gains ``content: str | None``.
2. The llama.cpp client populates it at both native-mode sites (streaming and
   non-streaming) through a helper that mirrors ``_resolve_reasoning``'s own
   priority order, so the text can never be duplicated INTO the reasoning field
   and back out again:
       server separated them          -> content is the answer, use it
       [THINK] tags inside content    -> use what is left after stripping them
       neither                        -> the content IS the reasoning; None
3. ``tool_calls_to_openai`` and ``tool_calls_to_sse_events`` emit that content
   as ``content``, and the reasoning as ``reasoning_content`` whenever the
   replay policy is not ``none``.

WHAT THIS DELIBERATELY DOES NOT TOUCH:

* ``forge/proxy/convert_anthropic.py`` has the same hole in a starker form — it
  appends the reasoning as a ``text`` block and never emits the model's content
  at all. This stack's client speaks OpenAI (pi, through /v1/chat/completions),
  and doing it right on the Anthropic wire means deciding how a ``thinking``
  block is shaped and signed, which is a different piece of work. Left alone
  knowingly, recorded here so nobody has to rediscover it.
* Prompt-mode extraction (``mode == "prompt"``, two more sites). This stack runs
  ``FORGE_CAPABILITY=native``. In prompt mode the call was parsed OUT of the
  text, so "the content that accompanied it" is a genuinely different question.

Applied at image build time rather than vendored, so the upstream package stays
a pinned dependency. It verifies the exact source text before rewriting and
exits non-zero if it is absent, so a forge upgrade that touches these lines
fails the build loudly instead of quietly shipping unpatched.

See context/design/forge-on-the-tool-call-path.md for the measurements.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Every block this patch inserts names the patch file, so one marker settles
# "has this already been applied?" for all three targets.
MARKER = "patches/forge_toolcall_content.py"

WORKFLOW_REL = "forge/core/workflow.py"
CLIENT_REL = "forge/clients/llamafile.py"
CONVERT_REL = "forge/proxy/convert.py"


# --- 1. ToolCall needs somewhere to put it -----------------------------------

WORKFLOW_OLD = """    tool: str
    args: Any  # may be a non-dict when malformed; ResponseValidator rejects shape
    reasoning: str | None = None
"""

WORKFLOW_NEW = """    tool: str
    args: Any  # may be a non-dict when malformed; ResponseValidator rejects shape
    reasoning: str | None = None
    # The assistant text that came WITH the call. Without it the response
    # builder has nothing to put in `content` and fills the hole with the
    # reasoning, so the model's own sentence is destroyed on every tool-calling
    # turn. TextResponse gained the mirror image of this in
    # patches/forge_reasoning_passthrough.py; this is the other branch.
    # Added by patches/forge_toolcall_content.py.
    content: str | None = None
"""


# --- 2. the llama.cpp client has to carry it ---------------------------------

CLIENT_HELPER_ANCHOR = "def _downgrade_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:"

CLIENT_HELPER = '''def _forge_toolcall_content(content: str, reasoning_content: str) -> str | None:
    """The assistant text that accompanied a tool call, or None.

    Mirrors _resolve_reasoning's priority order, because the two must not both
    claim the same characters. Where that method takes the content as reasoning,
    this one must return nothing, or the text is delivered twice — once as the
    answer and once as the thinking.

    Added by patches/forge_toolcall_content.py.
    """
    if not content:
        return None
    if reasoning_content:
        # The server separated them: content is the answer.
        return content
    think_text, cleaned = _extract_think_tags(content)
    if think_text:
        # Tags were inline; _resolve_reasoning takes think_text, we take the rest.
        return cleaned or None
    # Nothing separates them, so _resolve_reasoning falls back to the content
    # itself. There is no answer text here, only deliberation.
    return None


'''


CLIENT_STREAM_OLD = """                    result_calls.append(ToolCall(
                        tool=part["name"],
                        args=decode_tool_args(part["args"]),
                        reasoning=reasoning if idx == 0 else None,
                    ))
"""

CLIENT_STREAM_NEW = """                    result_calls.append(ToolCall(
                        tool=part["name"],
                        args=decode_tool_args(part["args"]),
                        reasoning=reasoning if idx == 0 else None,
                        content=(
                            _forge_toolcall_content(
                                accumulated_content, accumulated_reasoning
                            )
                            if idx == 0
                            else None
                        ),
                    ))
"""


CLIENT_WHOLE_OLD = """                result_calls.append(ToolCall(
                    tool=tc_func.get("name", ""),
                    args=decode_tool_args(tc_func.get("arguments")),
                    reasoning=reasoning if i == 0 else None,
                ))
"""

CLIENT_WHOLE_NEW = """                result_calls.append(ToolCall(
                    tool=tc_func.get("name", ""),
                    args=decode_tool_args(tc_func.get("arguments")),
                    reasoning=reasoning if i == 0 else None,
                    content=(
                        _forge_toolcall_content(
                            choice.get("content", "") or "",
                            choice.get("reasoning_content", "") or "",
                        )
                        if i == 0
                        else None
                    ),
                ))
"""


# --- 3. the response builders have to emit it --------------------------------

CONVERT_WHOLE_OLD = """    reasoning = tool_calls[0].reasoning if tool_calls else None
    message: dict[str, Any] = {
        "role": "assistant",
        "content": reasoning if reasoning_replay == "full" else None,
        "tool_calls": tc_list,
    }
    if reasoning and reasoning_replay == "keep-last":
        message["reasoning_content"] = reasoning
"""

CONVERT_WHOLE_NEW = """    reasoning = tool_calls[0].reasoning if tool_calls else None
    # patches/forge_toolcall_content.py: content is the model's own text, and
    # the reasoning goes in the field that is FOR reasoning. The replay policy
    # is enforced inbound by filter_openai_reasoning_messages, so nothing here
    # needs to smuggle the reasoning through `content` to make `full` work.
    tc_content = tool_calls[0].content if tool_calls else None
    message: dict[str, Any] = {
        "role": "assistant",
        "content": tc_content,
        "tool_calls": tc_list,
    }
    if reasoning and reasoning_replay != "none":
        message["reasoning_content"] = reasoning
"""


CONVERT_SSE_OLD = """    reasoning = tool_calls[0].reasoning if tool_calls else None
    if reasoning and reasoning_replay != "none":
        delta: dict[str, Any] = {"role": "assistant"}
        if reasoning_replay == "full":
            delta["content"] = reasoning
        else:
            delta["reasoning_content"] = reasoning
        events.append({
"""

CONVERT_SSE_NEW = """    reasoning = tool_calls[0].reasoning if tool_calls else None
    # patches/forge_toolcall_content.py — see tool_calls_to_openai above. One
    # delta can carry both fields, so the client gets the answer and the
    # thinking in the same chunk, each in its own key.
    tc_content = tool_calls[0].content if tool_calls else None
    if (reasoning and reasoning_replay != "none") or tc_content:
        delta: dict[str, Any] = {"role": "assistant"}
        if reasoning and reasoning_replay != "none":
            delta["reasoning_content"] = reasoning
        if tc_content:
            delta["content"] = tc_content
        events.append({
"""


def fail(msg: str) -> None:
    print(f"forge_toolcall_content: {msg}", file=sys.stderr)
    raise SystemExit(1)


def replace_once(source: str, old: str, new: str, rel: str, what: str) -> str:
    count = source.count(old)
    if count != 1:
        fail(
            f"expected exactly 1 occurrence of the {what} block in {rel}, found "
            f"{count}. forge changed it — re-read the file before shipping this."
        )
    return source.replace(old, new, 1)


def patch_workflow(root: Path) -> None:
    path = root / WORKFLOW_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    # Guard on THIS patch's own marker, never on the absence of WORKFLOW_OLD:
    # WORKFLOW_NEW keeps those three lines and appends to them, so the old text
    # is still present afterwards and "old is gone" would never be true. The
    # first cut of this file made exactly that mistake and appended a SECOND
    # content field on a re-run.
    if MARKER in source:
        print(f"forge_toolcall_content: {WORKFLOW_REL} already patched")
        return
    source = replace_once(source, WORKFLOW_OLD, WORKFLOW_NEW, WORKFLOW_REL, "ToolCall dataclass")
    path.write_text(source)
    print(f"forge_toolcall_content: patched {WORKFLOW_REL} (ToolCall.content)")


def patch_client(root: Path) -> None:
    path = root / CLIENT_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if MARKER in source:
        print(f"forge_toolcall_content: {CLIENT_REL} already patched")
        return
    if source.count(CLIENT_HELPER_ANCHOR) != 1:
        fail(f"helper anchor not found exactly once in {CLIENT_REL}")
    source = source.replace(CLIENT_HELPER_ANCHOR, CLIENT_HELPER + CLIENT_HELPER_ANCHOR, 1)
    source = replace_once(source, CLIENT_STREAM_OLD, CLIENT_STREAM_NEW, CLIENT_REL, "streaming ToolCall")
    source = replace_once(source, CLIENT_WHOLE_OLD, CLIENT_WHOLE_NEW, CLIENT_REL, "non-streaming ToolCall")
    path.write_text(source)
    print(f"forge_toolcall_content: patched {CLIENT_REL} (helper + 2 construction sites)")


def patch_convert(root: Path) -> None:
    path = root / CONVERT_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if MARKER in source:
        print(f"forge_toolcall_content: {CONVERT_REL} already patched")
        return
    source = replace_once(source, CONVERT_WHOLE_OLD, CONVERT_WHOLE_NEW, CONVERT_REL, "tool_calls_to_openai")
    source = replace_once(source, CONVERT_SSE_OLD, CONVERT_SSE_NEW, CONVERT_REL, "tool_calls_to_sse_events")
    path.write_text(source)
    print(f"forge_toolcall_content: patched {CONVERT_REL} (2 response builders)")


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_toolcall_content.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")
    patch_workflow(root)
    patch_client(root)
    patch_convert(root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
