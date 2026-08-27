#!/usr/bin/env python3
"""Stop forge answering an agent turn with a silent, well-formed nothing.

THE BUG (forge-guardrails 0.9.0, still present with patches 1-7 applied):

``run_inference`` has TWO budgets and one loop, and the loop is bounded by only
one of them::

    attempt_limit = max_retries + 1          # FORGE_MAX_RETRIES=0  -> 1
    ...
    if is_tool_error:
        error_tracker.record_result(success=False)
        exhausted = error_tracker.tool_errors_exhausted   # FORGE_MAX_TOOL_ERRORS=2
    else:
        error_tracker.record_retry()
        exhausted = error_tracker.retries_exhausted
    if exhausted:
        raise _ToolCallExhausted(...)        # -> handler passes the text through
    ...append the correction, go round again...
    return None                              # <- the loop just ended

``tool_errors_exhausted`` is ``consecutive_tool_errors > max_tool_errors``, so
with ``.env``'s pair — ``FORGE_MAX_RETRIES=0`` and ``FORGE_MAX_TOOL_ERRORS=2`` —
a tool-error-kind failure is NOT exhausted on its first occurrence. forge
appends the corrective messages for an attempt it has no budget to make, falls
out of the bottom of its own loop, and returns ``None``. ``handler.py`` turns
that into::

    if result is None:
        return _emit_text("", model_name, protocol, is_stream)

An empty 200. No content, no usage, no finish_reason, **and no log line
anywhere** — the one exit from this function that says nothing on the way out.

Only ONE nudge kind takes that path (``TOOL_ERROR_KINDS`` is
``frozenset({'tool_arg_validation'})``), and it is the one a truncated turn
produces: ``decode_tool_args`` hands back the raw string when the arguments do
not parse, and a tool call cut off at the token cap never parses.

MEASURED 2026-08-27, from a live unattended ``/loop`` run against this stack
(Qwen3.8-27B, 96K window, pi in the container), which made zero file changes
across 33 iterations and ~45 minutes of continuous GPU before the operator
stopped it by hand::

    llama-server   eval time = 69830 ms / 8192 tokens    every turn, exactly
                   eval time = 84725 ms / 8192 tokens    the -n 8192 cap
                   eval time = 73826 ms / 8192 tokens
    forge          << SSE 2 events                       and nothing else:
                                                         no "Retries exhausted"
    pi transcript  {"role":"assistant","content":[],
                    "usage":{"totalTokens":0},"stopReason":"stop"}
    prompt growth  ~260 tokens/turn — the whole 8,192-token generation
                   reached the conversation as nothing at all

Reproduced away from the GPU, driving the real ``run_inference`` with the real
validator and ``ErrorTracker(max_retries=0, max_tool_errors=2)``::

    reasoning-only text     raised _ToolCallExhausted (retry budget)      logged
    unknown tool            raised _ToolCallExhausted (retry budget)      logged
    malformed tool args     backend_calls=1  result=None                  SILENT
    empty tool-call list    InferenceResult(response=[], usage=None)      SILENT

    decode_tool_args('{"cmd": "ls -la /etc')  ->  str, not dict

The client cannot tell that turn from a model that chose to say nothing. pi
records it as a completed turn; an unattended loop counts it as narration and
waits for two more; and the operator watches 85 seconds of GPU per turn produce
an empty transcript entry, indefinitely. ``vendor/pi-loop-mode`` carries the
other half of the fix (AP1/AP2 in ``tests/empty-turn-ladder.test.ts``) — this
half is that the dead end should not exist.

THE FIX, in two parts:

1. ``inference.py``: exhaustion is whichever budget runs out FIRST. A failure on
   the last attempt available is exhaustion whatever the tool-error budget says,
   so it raises ``_ToolCallExhausted`` — carrying the usage, the reasoning and
   the backend's finish_reason, through the branch patch 7 taught to forward
   them — instead of appending a correction nothing will ever send. When retries
   ARE available (``FORGE_MAX_RETRIES>0``) nothing changes: ``no_attempt_left``
   is false on every attempt but the last, and the tool-error budget keeps
   deciding exactly as before.

2. ``handler.py``: the two remaining empty exits say so. Both are "shouldn't
   happen" after part 1, and a "shouldn't happen" that returns 200 with an empty
   body and no log is indistinguishable from a model that had nothing to say —
   which is precisely how this cost a session. If either fires, the log carries
   the facts needed to find out why: the attempt count and the usage.
"""

from __future__ import annotations

import sys
from pathlib import Path

INFERENCE_REL = "forge/core/inference.py"
HANDLER_REL = "forge/proxy/handler.py"

# --- 1. the two budgets have to agree about what "exhausted" means ------------

INFERENCE_OLD = '''        if is_tool_error:
            error_tracker.record_result(success=False)
            exhausted = error_tracker.tool_errors_exhausted
            budget_label = f"max_tool_errors={error_tracker.max_tool_errors}"
        else:
            error_tracker.record_retry()
            exhausted = error_tracker.retries_exhausted
            budget_label = f"max_retries={max_retries}"
        if exhausted:
'''

INFERENCE_NEW = '''        if is_tool_error:
            error_tracker.record_result(success=False)
            exhausted = error_tracker.tool_errors_exhausted
            budget_label = f"max_tool_errors={error_tracker.max_tool_errors}"
        else:
            error_tracker.record_retry()
            exhausted = error_tracker.retries_exhausted
            budget_label = f"max_retries={max_retries}"
        # The ATTEMPT budget is the other one, and it is the loop's own bound:
        # `attempt_limit = max_retries + 1`. A tool-error kind spends
        # `max_tool_errors`, which can outlive it — with max_retries=0 and
        # max_tool_errors=2 the first malformed tool call is "not exhausted", so
        # the corrective messages below were appended for an attempt that will
        # never be made, the loop ended, and this function returned None. The
        # caller turns that into an empty 200 with no usage, no finish_reason
        # and no log line. Exhaustion is whichever budget runs out FIRST.
        no_attempt_left = _attempt == attempt_limit - 1
        if no_attempt_left and not exhausted:
            budget_label = (
                f"attempt_limit={attempt_limit}, "
                f"tool-error budget {error_tracker.max_tool_errors} not spent"
            )
        if exhausted or no_attempt_left:
'''

# --- 2. neither remaining empty exit may be silent ----------------------------

HANDLER_NONE_OLD = '''    # run_inference returns None when max_attempts exhausted
    if result is None:
        return _emit_text("", model_name, protocol, is_stream)
'''

HANDLER_NONE_NEW = '''    # run_inference returns None when max_attempts exhausted.
    #
    # Unreachable once forge_empty_turn.py's inference half is applied — a
    # failure on the last available attempt raises instead of falling out of the
    # loop. Kept, and made loud: this exit returns 200 with an empty body, which
    # a client cannot tell from a model that chose to say nothing, and it used to
    # do that without a single line in the log. See patches/forge_empty_turn.py.
    if result is None:
        logger.error(
            "EMPTY RESPONSE: run_inference exhausted its attempts without a "
            "verdict; returning an empty 200. This is a forge dead end, not a "
            "quiet model — check max_retries against max_tool_errors."
        )
        return _emit_text("", model_name, protocol, is_stream)
'''

HANDLER_EMPTY_OLD = '''    # Shouldn't happen, but handle empty tool_calls gracefully
    return _emit_text("", model_name, protocol, is_stream, usage=usage)
'''

HANDLER_EMPTY_NEW = '''    # Shouldn't happen, but handle empty tool_calls gracefully — out loud. A
    # validated EMPTY tool-call list passes every check in ResponseValidator
    # (nothing unknown, no bad args) and arrives here as a success, so the client
    # gets an empty assistant message reported as a natural stop. Same shape as
    # the None exit above, same reason for the log. See patches/forge_empty_turn.py.
    logger.error(
        "EMPTY RESPONSE: validation passed with zero tool calls and no text "
        "(attempts=%s, usage=%s); returning an empty 200.",
        getattr(result, "attempts", "?"),
        usage,
    )
    return _emit_text("", model_name, protocol, is_stream, usage=usage)
'''


def fail(message: str) -> None:
    print(f"forge_empty_turn: {message}", file=sys.stderr)
    raise SystemExit(1)


def _apply(path: Path, rel: str, edits: list[tuple[str, str, int]], marker: str) -> None:
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if marker in source:
        print(f"forge_empty_turn: {rel} already patched")
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
    print(f"forge_empty_turn: patched {rel} ({len(edits)} site(s))")


def _require_patch_seven(root: Path) -> None:
    """The raise site must already carry usage, reasoning and finish_reason.

    Part 1 sends strictly more turns through ``_ToolCallExhausted``. If patch 7
    has not run, that exception drops the reasoning and the real finish_reason,
    so this patch would turn a silent empty turn into a loud LOSSY one — a
    trade, not a fix. Ordering is enforced here rather than left to the
    Dockerfile's RUN list.
    """
    source = (root / INFERENCE_REL).read_text()
    if "exhausted_finish_reason" not in source:
        fail(
            "the exhaustion raise site does not carry finish_reason — apply "
            "forge_toolcall_passthrough.py before this patch (see the COPY/RUN "
            "order in Dockerfile.forge)."
        )


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_empty_turn.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    _require_patch_seven(root)

    _apply(
        root / INFERENCE_REL,
        INFERENCE_REL,
        [(INFERENCE_OLD, INFERENCE_NEW, 1)],
        # Present only after this patch. Not "no_attempt_left" alone on the off
        # chance upstream ever names a local that; the sentence is ours.
        marker="Exhaustion is whichever budget runs out FIRST",
    )
    _apply(
        root / HANDLER_REL,
        HANDLER_REL,
        [
            (HANDLER_NONE_OLD, HANDLER_NONE_NEW, 1),
            (HANDLER_EMPTY_OLD, HANDLER_EMPTY_NEW, 1),
        ],
        marker="EMPTY RESPONSE:",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
