#!/usr/bin/env python3
"""Turn a backend read timeout on the STREAMING path into a clean 408.

THE BUG (forge-guardrails 0.8.3, 0.9.0 AND 0.9.5 — read out of the installed
module on 2026-08-30, not from the issue text). ``OpenAICompatClient.send()``
wraps its POST::

    except httpx.ReadTimeout as exc:
        raise BackendError(408, "Read timeout") from exc

``send_stream()`` has no equivalent. Its ``async with self._http.stream(...)``
block and the ``async for line in response.aiter_lines()`` loop inside it are
unguarded, so an ``httpx.ReadTimeout`` mid-stream propagates raw.

Upstream: https://github.com/antoinezambelli/forge/issues/142 (OPEN). Confirmed
still open and still present at 0.9.5: in the installed
``clients/openai_compat.py`` the only ``ReadTimeout`` is at line 299, inside
``send()`` (274-328); ``send_stream()`` starts at 329 and has none.

WHY IT MATTERS HERE, SPECIFICALLY. pi streams every turn of every session, and
this stack sets FORGE_BACKEND_TIMEOUT=600 against a 27B on one 4090 — a deep
turn at 96K can and does approach that. So the streaming path is the ONLY path
that matters here, and it is the unguarded one.

What the client gets instead of a 408 is::

    can only concatenate list (not "str") to list

which is a secondary TypeError raised downstream by something that expected a
BackendError and received a raw httpx exception. That is the same
uninterpretable string as forge issue #151 and as the bug
forge_merge_consecutive.py fixes, from a different cause — so on this stack the
message is genuinely ambiguous between two unrelated failures, and the one that
looks like a forge bug is actually "your backend did not answer in time".

WHY THE WRAPPER, RATHER THAN A try/except INSIDE THE BODY. ``send_stream`` is an
async GENERATOR: the timeout can surface when the stream is opened, or on any
later ``aiter_lines()`` pull, and a ``try`` around only the ``async with`` header
would miss the second. Wrapping the whole thing means re-indenting ~90 lines,
which is a large textual edit against source that upstream is still changing —
exactly the kind of patch that breaks on the next release for no good reason.

So the original method is renamed to ``_forge_send_stream_inner`` and a thin
generator takes its name, re-yielding through one try/except. Every raise site
inside the original — stream open, header check, line iteration, the
REASONING_MESSAGE_FIELDS type guard — is covered by construction, and the edit
is two lines.

WHY ReadTimeout AND NOT TimeoutException. To match ``send()`` exactly, which is
what upstream issue #142 asks for. Catching the broader class would also swallow
ConnectTimeout and PoolTimeout, which mean different things (backend down /
client pool exhausted) and should not all be reported as 408 read timeouts by a
patch whose stated purpose is to make the two methods agree.
"""

from __future__ import annotations

import sys
from pathlib import Path

CLIENT_REL = "forge/clients/openai_compat.py"

MARKER = "_forge_send_stream_inner"

# The signature is matched in full rather than by `async def send_stream(`
# alone: a partial match would rename a method whose parameters had changed
# underneath this patch, and the wrapper below forwards *args/**kwargs, so the
# mismatch would surface as a TypeError at request time rather than at build
# time. If forge changes this signature the build should fail here.
OLD = '''    async def send_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[ToolSpec] | None = None,
        sampling: dict[str, Any] | None = None,
        passthrough: dict[str, Any] | None = None,
        inbound_anthropic_body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> AsyncIterator[StreamChunk]:
'''

NEW = '''    async def send_stream(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> AsyncIterator[StreamChunk]:
        """Read timeouts on the streaming path become a clean 408.

        send() has always converted httpx.ReadTimeout into
        BackendError(408, "Read timeout"); this method did not, so a timeout
        mid-stream escaped raw and surfaced downstream as
        "can only concatenate list (not \\'str\\') to list".

        Upstream: antoinezambelli/forge#142 (open at 0.9.5).
        See patches/forge_stream_timeout.py.
        """
        try:
            async for chunk in self._forge_send_stream_inner(*args, **kwargs):
                yield chunk
        except httpx.ReadTimeout as exc:
            raise BackendError(408, "Read timeout") from exc

    async def _forge_send_stream_inner(
        self,
        messages: list[dict[str, str]],
        tools: list[ToolSpec] | None = None,
        sampling: dict[str, Any] | None = None,
        passthrough: dict[str, Any] | None = None,
        inbound_anthropic_body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> AsyncIterator[StreamChunk]:
'''


def fail(message: str) -> None:
    print(f"forge_stream_timeout: {message}", file=sys.stderr)
    raise SystemExit(1)


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_stream_timeout.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    path = root / CLIENT_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")

    source = path.read_text()
    if MARKER in source:
        print(f"forge_stream_timeout: {CLIENT_REL} already patched")
        return 0

    # If upstream fixes #142, this patch must STOP rather than add a second
    # layer. The check is deliberately narrow: send() already contains one
    # ReadTimeout handler, so the test is whether a second exists.
    if source.count("httpx.ReadTimeout") != 1:
        fail(
            f"expected exactly 1 httpx.ReadTimeout handler in {CLIENT_REL} "
            f"(send()'s), found {source.count('httpx.ReadTimeout')}. Upstream "
            "may have fixed #142 — re-read the file; this patch is probably "
            "obsolete and should be dropped from Dockerfile.forge."
        )

    count = source.count(OLD)
    if count != 1:
        fail(
            f"expected 1 occurrence of the send_stream signature in {CLIENT_REL}, "
            f"found {count}. forge changed it — re-read the file before shipping."
        )

    # httpx and BackendError are both already imported by this module (send()
    # uses both). Checked rather than assumed: the wrapper references them.
    for name in ("import httpx", "BackendError"):
        if name not in source:
            fail(f"{CLIENT_REL} does not reference {name!r} — the wrapper would NameError")

    path.write_text(source.replace(OLD, NEW))
    print(f"forge_stream_timeout: patched {CLIENT_REL} (send_stream wrapped)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
