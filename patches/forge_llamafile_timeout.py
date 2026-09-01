#!/usr/bin/env python3
"""A backend read timeout on the path THIS STACK ACTUALLY TAKES becomes a 408.

THE MEASUREMENT THAT PRODUCED THIS PATCH (2026-09-01, live, not reasoned).
llama-server aborted mid-generation on a CUDA assert and stopped answering
without releasing its port. Four subsequent turns each ran out
FORGE_BACKEND_TIMEOUT and produced, in `docker logs instantcoffee-forge`::

    18:42:09 [forge.proxy] ERROR: Handler error
    Traceback (most recent call last):
      File ".../forge/proxy/server.py", line 878, in _run_handler
      File ".../forge/proxy/handler.py", line 489, in handle_chat_completions
      File ".../forge/core/inference.py", line 347, in run_inference
        response = await client.send(
      File ".../forge/clients/llamafile.py", line 581, in send
      File ".../forge/clients/llamafile.py", line 826, in _send_native
        resp = await self._http.post(
    httpx.ReadTimeout
    18:42:28 [forge.proxy] INFO: << ERROR:
    18:42:28 [forge.proxy] INFO: << SSE complete (openai)

That traceback is the whole justification, and it corrects TWO assumptions that
``forge_stream_timeout.py`` (patch 10) was built on:

  1. **The client is LlamafileClient, not OpenAICompatClient.** Patch 10 guards
     ``forge/clients/openai_compat.py``. Nothing on this stack's chat path goes
     through that module.

  2. **forge's proxy never streams to the backend.** ``run_inference`` takes
     ``stream: bool = False`` and ``handle_chat_completions`` does not pass the
     kwarg, so the backend call is always ``client.send()``. The inbound request
     streams; the outbound one does not, which is exactly why forge emits two
     SSE events for a whole turn rather than one per token. Patch 10's docstring
     says "the streaming path is the ONLY path that matters here". It is the one
     path that never runs.

So the hole patch 10 set out to close was still wide open, one module over, on
the only path that carries traffic. ``openai_compat.send()`` has::

    except httpx.ReadTimeout as exc:
        raise BackendError(408, "Read timeout") from exc

``llamafile.py`` has no ``httpx.ReadTimeout`` handler anywhere — checked by
count on the installed 0.9.5 module, and asserted below so an upstream fix turns
into a build failure rather than a silent double-wrap.

WHY THE EMPTY LOG LINE MATTERS, AND WHAT IT COST. ``httpx.ReadTimeout`` carries
no message: httpx builds it in ``map_httpcore_exceptions`` as
``mapped_exc(str(exc))`` from an ``httpcore.ReadTimeout`` that has none either.
``_send_exception`` does ``error_msg = str(exc)``, which is therefore ``""`` —
that is the blank after ``<< ERROR:`` above, not a redaction. forge then put it
on the wire as ``data: {"error": ""}``, and the OpenAI SDK inside pi checks
``if (data && data.error) throw new APIError(...)`` — read out of pi 0.84.4's
bundled ``chunk-NUHFSC37.js``, not remembered. An empty string is falsy, so the
one check that would have surfaced the failure did not fire, the chunk fell
through pi's ``choices``-only loop untouched, and the turn ended at ``[DONE]``
with ``hasFinishReason`` still false. What the operator saw was::

    Error: Stream ended without finish_reason

for a backend that had been dead for over two hours. Converting the timeout to
``BackendError(408, "Read timeout")`` gives that string something to say;
``forge_sse_error_shape.py`` fixes the wire shape it is said in.

WHY BOTH send() AND send_stream(). ``send()`` is the path measured above and is
the one that matters today. ``send_stream()`` is wrapped in the same edit
because it has the identical hole, because ``run_inference`` will call it the
moment anything passes ``stream=True``, and because leaving one of a matched
pair unguarded is how patch 10's gap happened in the first place. It is a
coroutine and an async generator respectively, so they need different wrappers —
``send()`` returns, ``send_stream()`` re-yields.

WHY THE WRAPPER RATHER THAN A try/except INSIDE THE BODY. Same reason patch 10
gives: ``send_stream`` is a ~190-line async generator whose timeout can surface
at the stream open or on any later ``aiter_lines()`` pull, and re-indenting it
is a large textual edit against source upstream is still changing. Renaming the
original and putting a thin wrapper on its name is two lines and covers every
raise site by construction.

WHY ReadTimeout AND NOT TimeoutException. To match ``openai_compat.send()``
exactly. The broader class also catches ConnectTimeout (backend down) and
PoolTimeout (client pool exhausted), which mean different things and should not
all be reported as "the backend did not answer in time".
"""

from __future__ import annotations

import sys
from pathlib import Path

CLIENT_REL = "forge/clients/llamafile.py"

MARKER = "_forge_llamafile_send_inner"

# Signatures matched in full, not by `async def send(` alone: a partial match
# would rename a method whose parameters had moved underneath this patch, and
# the wrappers forward *args/**kwargs, so the mismatch would surface as a
# TypeError at request time instead of a build failure here.
SEND_OLD = '''    async def send(
        self,
        messages: list[dict[str, str]],
        tools: list[ToolSpec] | None = None,
        sampling: dict[str, Any] | None = None,
        passthrough: dict[str, Any] | None = None,
        inbound_anthropic_body: dict[str, Any] | None = None,
        raw_openai_tools: RawOpenAITools | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> LLMResponse:
'''

SEND_NEW = '''    async def send(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> LLMResponse:
        """Read timeouts on the non-streaming path become a clean 408.

        openai_compat.send() has always converted httpx.ReadTimeout into
        BackendError(408, "Read timeout"); this client never did, so a backend
        that stopped answering reached the client as an empty SSE error event
        and was reported as "Stream ended without finish_reason".

        This is the method forge's proxy actually calls: run_inference takes
        stream=False by default and handle_chat_completions does not override
        it. See patches/forge_llamafile_timeout.py.
        """
        try:
            return await self._forge_llamafile_send_inner(*args, **kwargs)
        except httpx.ReadTimeout as exc:
            raise BackendError(408, "Read timeout") from exc

    async def _forge_llamafile_send_inner(
        self,
        messages: list[dict[str, str]],
        tools: list[ToolSpec] | None = None,
        sampling: dict[str, Any] | None = None,
        passthrough: dict[str, Any] | None = None,
        inbound_anthropic_body: dict[str, Any] | None = None,
        raw_openai_tools: RawOpenAITools | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> LLMResponse:
'''

STREAM_OLD = '''    async def send_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[ToolSpec] | None = None,
        sampling: dict[str, Any] | None = None,
        passthrough: dict[str, Any] | None = None,
        inbound_anthropic_body: dict[str, Any] | None = None,
        raw_openai_tools: RawOpenAITools | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> AsyncIterator[StreamChunk]:
'''

STREAM_NEW = '''    async def send_stream(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> AsyncIterator[StreamChunk]:
        """Read timeouts on the streaming path become a clean 408.

        The matching half of the send() wrapper above. Nothing on this stack
        reaches it today — forge's proxy never asks the backend to stream — but
        it is the same hole, and leaving one of a matched pair unguarded is how
        the gap this patch closes was introduced.

        See patches/forge_llamafile_timeout.py.
        """
        try:
            async for chunk in self._forge_llamafile_send_stream_inner(*args, **kwargs):
                yield chunk
        except httpx.ReadTimeout as exc:
            raise BackendError(408, "Read timeout") from exc

    async def _forge_llamafile_send_stream_inner(
        self,
        messages: list[dict[str, str]],
        tools: list[ToolSpec] | None = None,
        sampling: dict[str, Any] | None = None,
        passthrough: dict[str, Any] | None = None,
        inbound_anthropic_body: dict[str, Any] | None = None,
        raw_openai_tools: RawOpenAITools | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> AsyncIterator[StreamChunk]:
'''


def fail(message: str) -> None:
    print(f"forge_llamafile_timeout: {message}", file=sys.stderr)
    raise SystemExit(1)


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_llamafile_timeout.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    path = root / CLIENT_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")

    source = path.read_text()
    if MARKER in source:
        print(f"forge_llamafile_timeout: {CLIENT_REL} already patched")
        return 0

    # If upstream gives this client its own handler, STOP rather than add a
    # second layer. llamafile.py has zero today, so any non-zero count means
    # the ground moved and this patch should be re-read before it ships.
    found = source.count("httpx.ReadTimeout")
    if found != 0:
        fail(
            f"expected 0 httpx.ReadTimeout handlers in {CLIENT_REL}, found "
            f"{found}. Upstream may have fixed this — re-read the file; this "
            "patch is probably obsolete and should be dropped from "
            "Dockerfile.forge."
        )

    # Both wrappers reference these by name. Checked, not assumed.
    for name in ("import httpx", "BackendError"):
        if name not in source:
            fail(f"{CLIENT_REL} does not reference {name!r} — the wrapper would NameError")

    for label, old in (("send", SEND_OLD), ("send_stream", STREAM_OLD)):
        count = source.count(old)
        if count != 1:
            fail(
                f"expected 1 occurrence of the {label} signature in "
                f"{CLIENT_REL}, found {count}. forge changed it — re-read the "
                "file before shipping."
            )

    patched = source.replace(SEND_OLD, SEND_NEW).replace(STREAM_OLD, STREAM_NEW)
    path.write_text(patched)
    print(f"forge_llamafile_timeout: patched {CLIENT_REL} (send + send_stream wrapped)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
