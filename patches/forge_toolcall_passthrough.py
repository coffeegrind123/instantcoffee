#!/usr/bin/env python3
"""Stop forge destroying the model's reasoning on the path an agent turn takes.

THE BUG (forge-guardrails 0.9.0, still present with patches 1-6 applied):

``handler.py`` has two places that hand a text response back to the client. One
of them was fixed by ``forge_reasoning_passthrough.py``::

    text = response.content if isinstance(response, TextResponse) else ""
    reasoning = response.reasoning if isinstance(response, TextResponse) else None
    finish_reason = ...
    return _emit_text(text, ..., reasoning=reasoning, finish_reason=finish_reason)

The other one is four lines further down and was not::

    except ToolCallError as exc:
        raw = exc.raw_response or ""
        usage = getattr(exc, "usage", None)
        return _emit_text(raw, model_name, protocol, is_stream, usage=usage)

No ``reasoning``. No ``finish_reason``. And that second branch is not an edge
case — **it is the branch an agent turn takes**. forge treats a bare text reply
as a validation failure whenever the request carries tools, and `.env` sets
``FORGE_MAX_RETRIES=0`` deliberately, with the reason written down beside it::

    # forge treats a bare text reply as a validation failure whenever the
    # request carries tools ... In an agent loop that fires on the majority of
    # turns — after a tool result comes back, answering in text IS correct

So on the majority of turns in an agent loop, forge raises ``_ToolCallExhausted``
and takes this branch. Which means: pi sends tools on every turn, therefore
forge discards the model's reasoning on every turn that answers in text, and
reports every one of them as ``finish_reason: "stop"`` whether it was or not.

MEASURED 2026-08-25, 2x2 control, identical request bodies, same minute. The
no-tools cell is the control — without it, "reasoning is empty" would be equally
well explained by the model simply not thinking::

    port         tools   completion   content   reasoning_content
    forge:8081   no              73         1                 193
    forge:8081   no              66         1                 161
    forge:8081   YES             77        55                   0
    forge:8081   YES            107        85                   0
    llama:8080   no              79        49                 156
    llama:8080   no              65        17                 146
    llama:8080   YES             98        95                 192
    llama:8080   YES             87        57                 155

llama.cpp is blameless in all four cells. Only forge-with-tools loses it.

WHAT IT LOOKED LIKE FROM THE OUTSIDE, which is how this was found: a turn in a
real session that produced 1,948 completion tokens, of which ~500 reached the
transcript as content — a degenerate repetition loop with the sentence

    Reasoning budget reached. Stop thinking and provide the final answer now.

stapled to the end of it. That sentence is ``REASONING_BUDGET_MESSAGE`` from
`.env`; llama-server injects it *before the end-of-thinking tag* when
``--reasoning-budget 4096`` is exhausted. Reproduced against both ports with a
prompt that provokes a long think::

    llama:8080, tools     reasoning_content 12,459 chars, the budget message at
                          char 12,386 of it, finish_reason "tool_calls", AND A
                          TOOL CALL — the turn continued
    forge:8081, tools     reasoning_content 0, content 1,597 chars of the
                          repetition loop, finish_reason "stop", no tool call

pi records that as a clean, completed turn. Nothing retries, nothing continues,
and the operator sees an answer that stops mid-word. This is
``forge_reasoning_passthrough.py``'s own finding — *"a truncated ANSWER looks
identical to a finished one"* — on the one path that patch did not cover, and
it is the path that carries the agent loop.

THE FIX: carry the two fields across the exception, the way ``usage`` already
is. ``_ToolCallExhausted`` exists for exactly this purpose — its docstring calls
itself an "internal exhaustion carrier for the final attempt's request-owned
usage" — so this widens a carrier that is already there rather than inventing a
route.

The handler reads them with ``getattr``, matching the ``usage`` line directly
above it: the ``except`` clause catches the PUBLIC ``ToolCallError``, which any
other caller may raise without the internal subclass's fields.

Note what this does NOT do, and it is the same distinction patch three drew:
reasoning goes to ``reasoning_content``, never into ``content``. pi maps that
onto a thinking block, and ``vendor/prinny-channel`` forwards ``text`` blocks
only — so the model's deliberation becomes visible to the harness without being
relayed to whoever is on the other end of a Matrix room.

DEPENDS ON PATCH THREE. ``TextResponse.reasoning`` and
``TextResponse.finish_reason`` are fields ``forge_reasoning_passthrough.py``
adds; on a pristine forge they do not exist. This verifies that before touching
anything, so the ordering in Dockerfile.forge cannot silently drift.

Applied at image build time rather than vendored, so the upstream package stays a
pinned dependency. It verifies the exact source text before rewriting and exits
non-zero if it is absent, so a forge upgrade that touches these lines fails the
build loudly instead of quietly shipping unpatched.
"""

from __future__ import annotations

import sys
from pathlib import Path

WORKFLOW_REL = "forge/core/workflow.py"
INFERENCE_REL = "forge/core/inference.py"
HANDLER_REL = "forge/proxy/handler.py"

# --- 1. the carrier needs two more fields ------------------------------------

INFERENCE_CLASS_OLD = '''class _ToolCallExhausted(ToolCallError):
    """Internal exhaustion carrier for the final attempt's request-owned usage."""

    def __init__(
        self,
        message: str,
        raw_response: str | None,
        usage: TokenUsage | None,
    ) -> None:
        super().__init__(message, raw_response=raw_response)
        self.usage = usage
'''

INFERENCE_CLASS_NEW = '''class _ToolCallExhausted(ToolCallError):
    """Internal exhaustion carrier for the final attempt's request-owned usage.

    Also carries the two things the final attempt knew and the exception used to
    forget: what the model was thinking, and why generation actually stopped.
    Without them the handler's passthrough branch emits a bare string, so an
    agent turn that answers in text — the majority of turns, since forge counts
    a bare text reply as a validation failure whenever tools are present — loses
    its reasoning and is reported as a clean "stop" whether it was one or not.
    """

    def __init__(
        self,
        message: str,
        raw_response: str | None,
        usage: TokenUsage | None,
        reasoning: str | None = None,
        finish_reason: str | None = None,
    ) -> None:
        super().__init__(message, raw_response=raw_response)
        self.usage = usage
        self.reasoning = reasoning
        self.finish_reason = finish_reason
'''

# --- 2. populate them at the one raise site ----------------------------------
#
# `response` is either a TextResponse or a list of ToolCall. Both carry
# reasoning; only TextResponse carries finish_reason, because a validated tool
# call is not a stop condition the backend reports separately.

INFERENCE_RAISE_OLD = '''        if exhausted:
            raw = response.content if isinstance(response, TextResponse) else str(
                [(tc.tool, tc.args) for tc in response]
            )
            raise _ToolCallExhausted(
                f"Exhausted after {budget_label} consecutive failed attempts ({nudge.kind})",
                raw_response=raw,
                usage=attempt_usage,
            )
'''

INFERENCE_RAISE_NEW = '''        if exhausted:
            raw = response.content if isinstance(response, TextResponse) else str(
                [(tc.tool, tc.args) for tc in response]
            )
            # Both shapes carry reasoning. Only TextResponse carries a backend
            # finish_reason; a list of ToolCall got here because its ARGUMENTS
            # failed validation, which is forge's verdict rather than the
            # backend's, so there is nothing honest to report for it.
            if isinstance(response, TextResponse):
                exhausted_reasoning = response.reasoning
                exhausted_finish_reason = response.finish_reason
            else:
                exhausted_reasoning = response[0].reasoning if response else None
                exhausted_finish_reason = None
            raise _ToolCallExhausted(
                f"Exhausted after {budget_label} consecutive failed attempts ({nudge.kind})",
                raw_response=raw,
                usage=attempt_usage,
                reasoning=exhausted_reasoning,
                finish_reason=exhausted_finish_reason,
            )
'''

# --- 3. the handler has to read them off the exception -----------------------

HANDLER_OLD = '''    except ToolCallError as exc:
        # Retries exhausted — the model kept returning text instead of tool
        # calls. Return the last text response to the client rather than an
        # error. The client's own agentic loop can decide what to do.
        raw = exc.raw_response or ""
        logger.warning("Retries exhausted, passing through text: %.120s", raw)
        usage = getattr(exc, "usage", None)
        request_facts.usage = usage
        request_facts.completed = True
        return _emit_text(
            raw, model_name, protocol, is_stream, usage=usage,
        )
'''

HANDLER_NEW = '''    except ToolCallError as exc:
        # Retries exhausted — the model kept returning text instead of tool
        # calls. Return the last text response to the client rather than an
        # error. The client's own agentic loop can decide what to do.
        #
        # This is the branch an AGENT turn takes: a bare text reply counts as a
        # validation failure whenever the request carries tools, and answering in
        # text after a tool result is correct, so with FORGE_MAX_RETRIES=0 the
        # majority of turns arrive here. It emitted the text alone, which meant
        # the model's reasoning was discarded on every one of them and every one
        # was reported as a natural "stop" — including the ones llama-server had
        # cut off at the reasoning budget mid-thought.
        #
        # getattr, like the usage line below it: the clause catches the public
        # ToolCallError, and only the internal _ToolCallExhausted carries these.
        raw = exc.raw_response or ""
        logger.warning("Retries exhausted, passing through text: %.120s", raw)
        usage = getattr(exc, "usage", None)
        reasoning = getattr(exc, "reasoning", None)
        finish_reason = getattr(exc, "finish_reason", None)
        request_facts.usage = usage
        request_facts.completed = True
        return _emit_text(
            raw, model_name, protocol, is_stream, usage=usage,
            reasoning=reasoning, finish_reason=finish_reason,
        )
'''


def fail(message: str) -> None:
    print(f"forge_toolcall_passthrough: {message}", file=sys.stderr)
    raise SystemExit(1)


def _apply(path: Path, rel: str, edits: list[tuple[str, str, int]], marker: str) -> None:
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if marker in source:
        print(f"forge_toolcall_passthrough: {rel} already patched")
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
    print(f"forge_toolcall_passthrough: patched {rel} ({len(edits)} site(s))")


def _require_patch_three(root: Path) -> None:
    """The fields this carries have to exist before it can carry them.

    ``TextResponse.reasoning`` and ``TextResponse.finish_reason`` are added by
    ``forge_reasoning_passthrough.py``. Applied out of order, every edit below
    would succeed and the result would raise ``AttributeError`` at the first
    exhausted turn — in production, on the majority path. Checked instead.
    """
    workflow = root / WORKFLOW_REL
    if not workflow.is_file():
        fail(f"{workflow} not found — is this a forge install?")
    source = workflow.read_text()
    for field in ("reasoning: str | None = None", "finish_reason: str | None = None"):
        if field not in source:
            fail(
                f"TextResponse has no `{field}` — apply forge_reasoning_passthrough.py "
                "before this patch (see the COPY/RUN order in Dockerfile.forge)."
            )


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_toolcall_passthrough.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    _require_patch_three(root)

    _apply(
        root / INFERENCE_REL,
        INFERENCE_REL,
        [
            (INFERENCE_CLASS_OLD, INFERENCE_CLASS_NEW, 1),
            (INFERENCE_RAISE_OLD, INFERENCE_RAISE_NEW, 1),
        ],
        marker="exhausted_finish_reason",
    )
    # The marker has to be a string that exists ONLY after this patch, and this
    # file has two ways to get that wrong.
    #
    # NOT 'reasoning=reasoning, finish_reason=finish_reason,' — patch three puts
    # that exact string in this same file, a few lines above the block below, so
    # it would report "already patched" on a correctly-ordered build and silently
    # skip the branch this patch exists for. The same trap patch three documents
    # for convert.py, one file over.
    #
    # NOT the logger line either ('Retries exhausted, passing through text'):
    # that is PRISTINE source, kept verbatim by the replacement, so it is present
    # before the patch runs and would skip every install. Written down because it
    # was the first thing tried here.
    _apply(
        root / HANDLER_REL,
        HANDLER_REL,
        [(HANDLER_OLD, HANDLER_NEW, 1)],
        marker="This is the branch an AGENT turn takes",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
