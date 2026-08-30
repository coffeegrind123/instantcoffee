#!/usr/bin/env python3
"""Do the build-time forge patches actually BEHAVE? Runs inside the built image.

    docker run --rm --entrypoint python instantcoffee/proxy:ci /work/scripts/test_forge_patches.py

WHY THIS EXISTS, GIVEN THE PATCHES ALREADY FAIL THE BUILD

Each patch verifies the exact source text before rewriting and exits non-zero if
forge has changed it, so an upgrade cannot silently ship unpatched. That is a
check on the INPUT. It says nothing about the output: a patch can apply cleanly
to text that has moved underneath it and produce a package that imports, starts,
serves, and does the wrong thing. Every defect these patches exist to fix was
exactly that shape — forge ran perfectly and returned the wrong field.

So this drives the patched functions directly, in the image, with no server and
no GPU. It is the cheapest gate this repo has for the one class of bug that has
cost it the most.

WHAT IT PINS

  cached_tokens         prompt_tokens_details survives the usage rebuild
  reasoning_passthrough a reasoning-only turn is not destroyed, and
                        finish_reason is the backend's rather than "stop"
  toolcall_content      on a tool-call turn the model's CONTENT is content and
                        its REASONING is reasoning_content — never swapped
  toolcall_passthrough  on the branch an AGENT turn takes — a text reply to a
                        request carrying tools, which forge counts as a
                        validation failure — the reasoning survives and the
                        finish_reason is the backend's rather than "stop"
  merge_across_tools    two user turns either side of a tool-call/tool-result
                        pair stay separate, adjacent ones still merge, and
                        FORGE_MERGE_ACROSS_TOOLS=1 restores the old behaviour
  anthropic_reasoning   on the ANTHROPIC wire reasoning is on a top-level key
                        and NEVER in `content` — the block type prinny forwards
                        — and stop_reason is the backend's rather than
                        "end_turn"
  empty_turn            a validation failure with no attempt left RAISES, so it
                        reaches the passthrough branch, instead of falling out
                        of run_inference's loop and returning an empty 200 with
                        no usage, no finish_reason and no log line
  text_sse_passthrough  the OpenAI SSE text path — the one pi takes on every
                        turn — carries the reasoning in its own delta and the
                        backend's finish_reason, so a truncated turn is not
                        reported as a natural stop

The last one is checked in both directions on purpose. A test that only proves
the new behaviour cannot tell a working flag from a flag that is never read.
"""

from __future__ import annotations

import importlib
import os
import sys

PASSED = 0
FAILED = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print(f"  PASS  {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}" + (f"  — {detail}" if detail else ""))


def eq(name: str, got, want) -> None:
    check(name, got == want, f"got {got!r}, want {want!r}")


def main() -> int:
    from forge.core.workflow import TextResponse, ToolCall
    from forge.proxy import convert

    print("\npatches/forge_toolcall_content.py")
    check("ToolCall carries content", "content" in ToolCall.__dataclass_fields__)
    tc = ToolCall(tool="weather", args={"city": "Paris"}, reasoning="THINKING", content="SPOKEN")

    out = convert.tool_calls_to_openai([tc], model="m", reasoning_replay="full")
    msg = out["choices"][0]["message"]
    eq("content is the model's text, not its reasoning", msg.get("content"), "SPOKEN")
    eq("reasoning goes in reasoning_content", msg.get("reasoning_content"), "THINKING")
    eq("the tool call survives", msg["tool_calls"][0]["function"]["name"], "weather")

    out = convert.tool_calls_to_openai([tc], model="m", reasoning_replay="keep-last")
    msg = out["choices"][0]["message"]
    eq("keep-last keeps the content too", msg.get("content"), "SPOKEN")
    eq("keep-last still emits reasoning_content", msg.get("reasoning_content"), "THINKING")

    out = convert.tool_calls_to_openai([tc], model="m", reasoning_replay="none")
    msg = out["choices"][0]["message"]
    eq("none drops the reasoning", msg.get("reasoning_content"), None)
    eq("...but never the content", msg.get("content"), "SPOKEN")

    events = convert.tool_calls_to_sse_events([tc], model="m", reasoning_replay="full")
    deltas = [c["delta"] for e in events for c in e.get("choices", [])]
    content = "".join(d.get("content") or "" for d in deltas)
    reasoning = "".join(d.get("reasoning_content") or "" for d in deltas)
    eq("streamed content is the model's text", content, "SPOKEN")
    eq("streamed reasoning is in its own field", reasoning, "THINKING")

    print("\npatches/forge_reasoning_passthrough.py")
    check("TextResponse carries reasoning", "reasoning" in TextResponse.__dataclass_fields__)
    check("TextResponse carries finish_reason", "finish_reason" in TextResponse.__dataclass_fields__)
    # Its signature takes the FIELDS, not the TextResponse — the dataclass is
    # what carries them from the client to the caller that unpacks it. Passing
    # the object works (it lands in `content`) and produces a response whose
    # content is a repr, which is why this test asserts the content rather than
    # only asserting the reasoning survived.
    tr = TextResponse(content="", reasoning="ONLY-REASONING", finish_reason="length")
    out = convert.text_response_to_openai(
        tr.content, model="m", reasoning=tr.reasoning, finish_reason=tr.finish_reason
    )
    msg = out["choices"][0]["message"]
    eq("a reasoning-only turn is not destroyed", msg.get("reasoning_content"), "ONLY-REASONING")
    eq("reasoning is NOT merged into content", msg.get("content"), "")
    eq("finish_reason is the backend's, not a hardcoded stop", out["choices"][0]["finish_reason"], "length")

    print("\npatches/forge_toolcall_passthrough.py")
    from forge.core.inference import _ToolCallExhausted
    from forge.errors import ToolCallError
    from forge.proxy import handler

    # 1. The carrier. `usage` was already carried across this exception; the
    #    other two things the final attempt knew were dropped on the floor.
    exhausted = _ToolCallExhausted(
        "exhausted", raw_response="TEXT", usage=None,
        reasoning="THINKING", finish_reason="length",
    )
    eq("the exhaustion carrier keeps the reasoning", exhausted.reasoning, "THINKING")
    eq("...and the real finish_reason", exhausted.finish_reason, "length")
    eq("...and still the text", exhausted.raw_response, "TEXT")

    # 2. The handler reads them with getattr because the `except` clause catches
    #    the PUBLIC error, which any other caller may raise without these. If
    #    that ever became a plain attribute access it would be an AttributeError
    #    on a live request, so the defensive read is pinned rather than assumed.
    plain = ToolCallError("no fields here", raw_response="TEXT")
    eq("a plain ToolCallError has no reasoning", getattr(plain, "reasoning", None), None)
    eq("...and no finish_reason", getattr(plain, "finish_reason", None), None)

    # 3. The emitter. This is the call the passthrough branch makes, with the
    #    arguments it now supplies.
    out = handler._emit_text(
        "TEXT", "m", "openai", False, usage=None,
        reasoning="THINKING", finish_reason="length",
    )
    msg = out["choices"][0]["message"]
    eq("an exhausted turn keeps its reasoning", msg.get("reasoning_content"), "THINKING")
    eq("reasoning is NOT merged into content", msg.get("content"), "TEXT")
    eq(
        "a truncated agent turn is not reported as a natural stop",
        out["choices"][0]["finish_reason"],
        "length",
    )

    # 4. The wiring, which is the half the three above cannot see: the branch
    #    has to actually PASS them. Same shape as the cached_tokens check below —
    #    a source assertion where driving the real path would need a backend, a
    #    validator and an error budget.
    hsrc = open(handler.__file__).read()
    branch = hsrc[hsrc.index("except ToolCallError as exc:"):]
    branch = branch[: branch.index("# run_inference returns None")]
    check(
        "the passthrough branch forwards the reasoning",
        'reasoning = getattr(exc, "reasoning", None)' in branch
        and "reasoning=reasoning" in branch,
    )
    check(
        "the passthrough branch forwards the finish_reason",
        'finish_reason = getattr(exc, "finish_reason", None)' in branch
        and "finish_reason=finish_reason" in branch,
    )

    print("\npatches/forge_cached_tokens.py")
    src = open(convert.__file__).read()
    check("the usage builder knows about cached tokens", "prompt_tokens_details" in src)

    print("\npatches/forge_merge_across_tools.py")
    from forge.clients import llamafile

    tool_pair = [
        {"role": "user", "content": "U1"},
        {"role": "assistant", "content": "A", "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "R"},
        {"role": "user", "content": "U2"},
    ]
    merged = llamafile._merge_consecutive(tool_pair)
    eq("user turns either side of a tool pair stay separate", len(merged), 4)
    eq("...and the newest one is still last", merged[-1]["content"], "U2")

    adjacent = [
        {"role": "user", "content": "U1"},
        {"role": "user", "content": "U2"},
    ]
    merged = llamafile._merge_consecutive(adjacent)
    eq("truly adjacent same-role messages still merge", len(merged), 1)
    check("...and both texts survive the merge", "U1" in merged[0]["content"] and "U2" in merged[0]["content"])

    # The other direction. Without this, a flag that is never read passes.
    os.environ["FORGE_MERGE_ACROSS_TOOLS"] = "1"
    importlib.reload(llamafile)
    merged = llamafile._merge_consecutive(tool_pair)
    eq("FORGE_MERGE_ACROSS_TOOLS=1 restores the upstream merge", len(merged), 3)
    os.environ.pop("FORGE_MERGE_ACROSS_TOOLS", None)
    importlib.reload(llamafile)
    eq("...and clearing it restores the patched behaviour", len(llamafile._merge_consecutive(tool_pair)), 4)

    # ── anthropic_reasoning ───────────────────────────────────────────────
    #
    # The assertion that matters is the NEGATIVE one: nothing carrying the
    # reasoning may appear anywhere inside `content`, on either the block list
    # or the SSE deltas. vendor/prinny-channel allowlists `text` blocks, so a
    # regression here does not throw or log — it forwards the model's private
    # deliberation to a Matrix room and looks like a normal answer.
    import json as _json
    from forge.proxy.convert_anthropic import (
        _anthropic_stop_reason, text_response_to_anthropic, text_to_anthropic_sse,
        tool_calls_to_anthropic, tool_calls_to_anthropic_sse,
    )

    SECRET = "PRIVATE-DELIBERATION-MARKER"
    atc = ToolCall(tool="Bash", args={"command": "ls"}, reasoning=SECRET)

    r = tool_calls_to_anthropic([atc], reasoning_replay="full")
    eq("anthropic tool-call content holds only tool_use blocks",
       sorted({b["type"] for b in r["content"]}), ["tool_use"])
    check("anthropic tool-call reasoning is NOT anywhere in content",
          SECRET not in _json.dumps(r["content"]))
    eq("anthropic tool-call reasoning is on reasoning_content",
       r.get("reasoning_content"), SECRET)
    check("reasoning_replay=none drops it entirely",
          "reasoning_content" not in tool_calls_to_anthropic([atc], reasoning_replay="none"))

    t = text_response_to_anthropic("the answer", reasoning=SECRET, finish_reason="length")
    check("anthropic text reasoning is NOT anywhere in content",
          SECRET not in _json.dumps(t["content"]))
    eq("anthropic text reasoning is on reasoning_content", t.get("reasoning_content"), SECRET)
    eq("anthropic text stop_reason is the backend's", t["stop_reason"], "max_tokens")
    # The old three-argument call is still how several call sites reach it.
    plain = text_response_to_anthropic("the answer")
    eq("anthropic text default stop_reason unchanged", plain["stop_reason"], "end_turn")
    check("no reasoning_content key when there is no reasoning",
          "reasoning_content" not in plain)

    ev = tool_calls_to_anthropic_sse([atc], reasoning_replay="full")
    check("anthropic SSE tool-call opens no text block",
          not any(e.get("content_block", {}).get("type") == "text" for e in ev))
    check("anthropic SSE tool-call reasoning is NOT in any event delta",
          not any(SECRET in _json.dumps(e.get("delta", {})) for e in ev))
    eq("anthropic SSE tool-call reasoning rides on message_start",
       ev[0]["message"].get("reasoning_content"), SECRET)

    ev2 = text_to_anthropic_sse("the answer", reasoning=SECRET, finish_reason="length")
    check("anthropic SSE text reasoning is NOT in any event delta",
          not any(SECRET in _json.dumps(e.get("delta", {})) for e in ev2))
    eq("anthropic SSE text reasoning rides on message_start",
       ev2[0]["message"].get("reasoning_content"), SECRET)
    eq("anthropic SSE text stop_reason is the backend's",
       [e for e in ev2 if e["type"] == "message_delta"][0]["delta"]["stop_reason"],
       "max_tokens")

    # An unmapped finish_reason is the one case the schema cannot express. It
    # is pinned so that a change to the fallback is a test failure rather than a
    # silent "the model finished naturally".
    for fr, want in (("stop", "end_turn"), ("length", "max_tokens"),
                     ("tool_calls", "tool_use"), ("function_call", "tool_use"),
                     ("content_filter", "refusal"), (None, "end_turn"),
                     ("a_reason_forge_invented", "end_turn")):
        eq(f"stop_reason map {fr!r}", _anthropic_stop_reason(fr), want)

    print("\npatches/forge_empty_turn.py")
    # Driven, not pinned. The other budget-shaped checks in this file assert
    # source text because reaching the real path needs a backend, a validator and
    # an error budget; this one supplies all three. The stub client is the only
    # double — everything else is the shipped code, and the ONE thing that makes
    # the defect appear is the pair of budgets .env actually sets.
    import asyncio

    from forge import Message, MessageMeta, MessageRole, MessageType, TextResponse, ToolCall
    from forge.core.inference import TOOL_ERROR_KINDS, run_inference
    from forge.guardrails.error_tracker import ErrorTracker
    from forge.guardrails.response_validator import ResponseValidator

    eq("only tool_arg_validation spends the tool-error budget",
       set(TOOL_ERROR_KINDS), {"tool_arg_validation"})

    class _CM:
        def maybe_compact(self, messages, step_index=None, step_hint=None):
            return messages

        def check_thresholds(self, messages):
            return None

        def invalidate_usage(self):
            pass

        def update_token_count(self, n):
            pass

    class _Client:
        api_format = "openai"

        def __init__(self, response):
            self.response = response
            self.calls = 0

        async def send(self, api_messages, tools=None, sampling=None, passthrough=None,
                       inbound_anthropic_body=None, **kw):
            self.calls += 1
            return self.response

    class _Spec:
        def __init__(self, name):
            self.name = name

    def drive(response):
        """Returns ('raised', exc) or ('returned', result) plus the call count."""
        client = _Client(response)

        async def _run():
            return await run_inference(
                messages=[Message(MessageRole.USER, "hi", MessageMeta(MessageType.USER_INPUT))],
                client=client,
                context_manager=_CM(),
                # .env's pair, and the pair is the defect: the ATTEMPT budget is
                # max_retries + 1 = 1, the tool-error budget is 2, and the second
                # used to outlive the first.
                validator=ResponseValidator(["bash"], rescue_enabled=True),
                error_tracker=ErrorTracker(max_retries=0, max_tool_errors=2),
                tool_specs=[_Spec("bash")],
            )

        try:
            return ("returned", asyncio.run(_run()), client.calls)
        except Exception as exc:  # noqa: BLE001 — the verdict is the exception
            return ("raised", exc, client.calls)

    # The defect: a tool call whose arguments do not decode to a dict. That is
    # what a turn cut off at the token cap produces — decode_tool_args hands back
    # the raw string — and it used to return None here, silently.
    kind, value, calls = drive([ToolCall(tool="bash", args='{"cmd": "ls -la /etc',
                                         reasoning="THINKING")])
    check("a malformed tool call with no attempt left raises rather than vanishing",
          kind == "raised", f"got {kind} {value!r}")
    eq("...and it only ever asked the backend once", calls, 1)
    if kind == "raised":
        check("...and the exception carries the reasoning to the passthrough branch",
              getattr(value, "reasoning", None) == "THINKING",
              f"reasoning={getattr(value, 'reasoning', None)!r}")
        check("...and says which budget ran out first",
              "attempt_limit=1" in str(value), str(value))

    # Controls. Both of these already raised before the patch, on the RETRY
    # budget, and must be untouched by it — a fix that simply raised on
    # everything would pass the case above and fail nothing here.
    kind, value, _ = drive(TextResponse(content="", reasoning="THINKING",
                                        finish_reason="length"))
    check("control — a reasoning-only text turn still raises on the retry budget",
          kind == "raised" and "max_retries=0" in str(value), f"{kind}: {value!r}")
    kind, value, _ = drive([ToolCall(tool="frobnicate", args={"x": 1})])
    check("control — an unknown tool still raises on the retry budget",
          kind == "raised" and "max_retries=0" in str(value), f"{kind}: {value!r}")

    # The handler half cannot be driven without an app, so it is pinned. Both
    # exits are "shouldn't happen" after the fix above; the point of the pin is
    # that neither may go back to being SILENT about it.
    from forge.proxy import handler as _handler

    hsrc = open(_handler.__file__).read()
    eq("both empty exits in the handler are loud", hsrc.count("EMPTY RESPONSE:"), 2)

    print("\npatches/forge_text_sse_passthrough.py")
    # The emitter, through the router, in the shape pi actually asks for:
    # protocol "openai", is_stream True. The other three cells are covered
    # above and are the control — this patch must not have changed them.
    sse = handler._emit_text(
        "TEXT", "m", "openai", True, usage=None,
        reasoning="THINKING", finish_reason="length",
    )
    deltas = [c["delta"] for e in sse for c in e.get("choices", [])]
    eq("streamed text is still the text",
       "".join(d.get("content") or "" for d in deltas), "TEXT")
    eq("streamed reasoning rides its own key",
       "".join(d.get("reasoning_content") or "" for d in deltas), "THINKING")
    check("reasoning is NOT merged into the streamed content",
          "THINKING" not in "".join(d.get("content") or "" for d in deltas))
    eq("a truncated stream is not reported as a natural stop",
       sse[-1]["choices"][0]["finish_reason"], "length")
    check("exactly one delta announces the assistant role",
          sum(1 for d in deltas if d.get("role") == "assistant") == 1,
          f"roles={[d.get('role') for d in deltas]}")

    # Control: a caller with nothing better to say still gets "stop", and a
    # response with no reasoning still streams as one content delta.
    plain = handler._emit_text("TEXT", "m", "openai", True)
    eq("default finish_reason unchanged", plain[-1]["choices"][0]["finish_reason"], "stop")
    plain_deltas = [c["delta"] for e in plain for c in e.get("choices", [])]
    check("no reasoning_content key when there is no reasoning",
          not any("reasoning_content" in d for d in plain_deltas))
    eq("...and the first delta still carries the role", plain_deltas[0].get("role"), "assistant")

    print("\npatches/forge_stream_timeout.py")
    # DRIVEN, not grepped. A fake transport raises httpx.ReadTimeout from the
    # streaming read; the patch must turn that into BackendError(408) the same
    # way send() already does. Without the patch this test sees a raw
    # httpx.ReadTimeout, which is the bug.
    import asyncio
    import httpx as _httpx
    from forge.clients.openai_compat import OpenAICompatClient
    from forge.errors import BackendError as _BackendError

    class _TimeoutStream:
        """Stands in for httpx's stream() context manager, and times out."""

        async def __aenter__(self):
            raise _httpx.ReadTimeout("simulated backend read timeout")

        async def __aexit__(self, *exc):
            return False

    class _LateTimeoutResponse:
        status_code = 200

        async def aiter_lines(self):
            # One good line, THEN the timeout — the mid-stream shape, which a
            # try around only the stream-open would miss.
            yield 'data: {"choices":[{"delta":{"content":"hi"}}]}'
            raise _httpx.ReadTimeout("simulated mid-stream read timeout")

    class _LateStream:
        async def __aenter__(self):
            return _LateTimeoutResponse()

        async def __aexit__(self, *exc):
            return False

    class _FakeHTTP:
        def __init__(self, factory):
            self._factory = factory

        def stream(self, *a, **kw):
            return self._factory()

    def _drive(factory):
        client = OpenAICompatClient.__new__(OpenAICompatClient)
        client._http = _FakeHTTP(factory)
        client._chat_url = "http://backend/v1/chat/completions"
        client._request_headers = lambda extra=None: {}
        client._build_body = lambda *a, **kw: {}

        async def run():
            async for _ in client.send_stream([{"role": "user", "content": "x"}]):
                pass

        try:
            asyncio.run(run())
        except BaseException as exc:  # noqa: BLE001 - the exception IS the result
            return exc
        return None

    for label, factory in (("on stream open", _TimeoutStream),
                           ("mid-stream", _LateStream)):
        got = _drive(factory)
        check(f"a read timeout {label} becomes BackendError, not a raw httpx error",
              isinstance(got, _BackendError), f"got {type(got).__name__}: {got!r}")
        if isinstance(got, _BackendError):
            eq(f"...and it is a 408 {label}", getattr(got, "status_code", None), 408)

    # Control: send()'s handler must still be the only OTHER one, i.e. the patch
    # wrapped rather than duplicated. Two handlers would mean it ran twice.
    import forge.clients.openai_compat as _oc
    _csrc = open(_oc.__file__).read()
    eq("the original send_stream body survives under its inner name",
       _csrc.count("async def _forge_send_stream_inner"), 1)
    # Count HANDLERS, not mentions: the patch's own docstring names the
    # exception too, so a bare count of "httpx.ReadTimeout" is 3 and asserting
    # on it tests the prose rather than the code. (It did, first time round.)
    eq("exactly two ReadTimeout handlers now: send() and the stream wrapper",
       _csrc.count("except httpx.ReadTimeout"), 2)

    total = PASSED + FAILED
    print(f"\n{PASSED}/{total} passed", end="")
    if FAILED:
        print(f", {FAILED} FAILED")
        return 1
    print(" — all good")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
