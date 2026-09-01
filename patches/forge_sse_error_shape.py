#!/usr/bin/env python3
"""A mid-stream failure must be VISIBLE to the client, not just logged.

THE MEASUREMENT (2026-09-01, live). llama-server aborted on a CUDA assert and
kept its port bound without answering. Four turns timed out against it, and each
one reached pi as::

    Error: Stream ended without finish_reason

The backend had been dead for two hours; nothing in that message says so. Here
is every link between the two, each one read off the running system:

1. ``_send_exception`` computes ``error_msg = str(exc)``. The exception was
   ``httpx.ReadTimeout``, which carries no message — httpx builds it in
   ``map_httpcore_exceptions`` from an ``httpcore.ReadTimeout`` that has none.
   forge's own log line is the proof, blank after the colon::

       18:42:28 [forge.proxy] INFO: << ERROR:

2. On the streaming path it then sent ``[{"error": error_msg}]``, i.e. the two
   frames ``data: {"error": ""}`` and ``data: [DONE]``.

3. The OpenAI SDK bundled in pi 0.84.4 guards exactly this case, in
   ``dist/bundle/chunks/chunk-NUHFSC37.js`` — read, not remembered::

       if(data&&data.error)throw new APIError(void 0,data.error,void 0,response.headers)

   ``""`` is falsy. The guard did not fire, so the chunk was yielded as ordinary
   stream data.

4. pi's completions loop only reads ``chunk.choices[0]``. A chunk with no
   ``choices`` is skipped in full, so the error passed through untouched.

5. At ``[DONE]``, ``hasFinishReason`` was still false, and pi raised the one
   message it has for a stream that stopped early.

So a 600-second backend timeout was reported as a protocol anomaly, with the
cause thrown away at step 1 and the last chance to surface it lost at step 3.

WHAT THIS PATCH CHANGES, AND WHAT IT DELIBERATELY DOES NOT

**The message is never empty.** ``str(exc) or f"{type(exc).__name__} ..."``.
An exception class name is a poor error message and a far better one than
nothing; more importantly it is TRUTHY, which is what step 3 turns on.
``forge_llamafile_timeout.py`` is what makes the common case say "Read timeout"
rather than "ReadTimeout (no message)" — the two patches are complementary and
neither makes the other redundant.

**The error becomes an OBJECT.** ``{"error": {"message": ..., "type":
"proxy_error"}}`` rather than ``{"error": "<string>"}``. That is the shape the
OpenAI wire uses for a mid-stream error, and it is what makes the SDK's
``APIError`` carry a readable message instead of stringifying a bare str. It is
also, deliberately, byte-for-byte the object ``_send_error`` already sends on
the non-streaming path, so the two ways forge can report the same fault do not
describe it differently. An earlier draft added ``"code": status`` and produced
``{"message": "Backend returned 408: ...", "code": 502}`` — two numbers for one
failure, the backend's and the proxy's, with nothing saying which was which.

**A terminal chunk carries ``finish_reason: "error"``, emitted BEFORE the error
object** so that a client whose SDK does not check ``error`` still learns the
stream ended abnormally. ``"error"`` is not an OpenAI-defined finish_reason, and
that is the point — pi's ``mapStopReason`` sends every unrecognised value to
``{stopReason: "error", errorMessage: "Provider finish_reason: <reason>"}``,
which the completions loop raises on BEFORE it reaches the ``hasFinishReason``
check. Read off the same bundle as step 3.

**It does NOT fabricate a successful stop.** The obvious "fix" for a client
complaining about a missing finish_reason is to send ``finish_reason: "stop"``.
That would be the worst change available here, and this repo has already paid
for it twice: patch 3 and patch 9 both exist because forge reported "stop" for
turns that were truncated or destroyed, and patch 8 exists because an empty
turn with a natural stop reason is invisible to every retry and every loop
above it. A backend that never answered must not end the stream the way a
model choosing to stop does. If a client reads neither ``error`` nor an unknown
``finish_reason``, it still says "stream ended without finish_reason" — which
is at least true.

THE ANTHROPIC WIRE. The current code sends the same ``[{"error": msg}]`` list
for ``protocol == "anthropic"``, which ``_send_sse_body`` renders with
``event.get("type", "")`` — an SSE frame with an EMPTY event name. No Anthropic
client dispatches on that. This patch emits the wire's own error event
(``event: error`` with ``{"type": "error", "error": {"type": ..., "message":
...}}``). Stated plainly: unlike everything above, that half is derived from the
Anthropic streaming format rather than measured against a live client, because
the failure that produced this patch arrived on ``/v1/chat/completions``. It is
still strictly better than an unnamed event, and vendor/prinny-channel is the
Anthropic-wire consumer that would see it.
"""

from __future__ import annotations

import sys
from pathlib import Path

SERVER_REL = "forge/proxy/server.py"

MARKER = "_forge_stream_error_events"

MSG_OLD = "        error_msg = str(exc)\n"

MSG_NEW = (
    "        # NEVER empty: httpx.ReadTimeout and friends carry no message, and\n"
    "        # an empty string is falsy — which is the whole reason a dead\n"
    "        # backend reached pi as \"Stream ended without finish_reason\".\n"
    "        # See patches/forge_sse_error_shape.py.\n"
    "        error_msg = str(exc) or f\"{type(exc).__name__} (no message)\"\n"
)

SSE_OLD = (
    "            await self._send_sse_body(writer, [{\"error\": error_msg}], protocol=protocol)\n"
)

SSE_NEW = (
    "            await self._send_sse_body(\n"
    "                writer,\n"
    "                _forge_stream_error_events(error_msg, status, protocol),\n"
    "                protocol=protocol,\n"
    "            )\n"
)

ANCHOR = "def _status_text(code: int) -> str:"

HELPER = '''# Anthropic's error event names its own error type. 502 is this proxy's
# catch-all for a backend fault, which on that wire is an api_error.
_FORGE_ANTHROPIC_ERROR_TYPES = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
    502: "api_error",
}


def _forge_stream_error_events(
    message: str, status: int, protocol: str,
) -> list[dict[str, Any]]:
    """SSE events for a failure AFTER the 200 and the headers went out.

    The status line is already spent by the time a backend fault surfaces, so
    the only way to tell the client is in the body. Both wires get a frame their
    own SDK recognises as an error rather than as ordinary stream data.

    On the OpenAI wire the terminal chunk comes FIRST and carries
    ``finish_reason: "error"``. That value is deliberately not an OpenAI-defined
    one: a client that maps unknown reasons to a failure (pi does) raises with a
    real cause, and a client that does not is left saying the stream ended
    early, which is true. What it must never do is claim "stop" — a backend that
    never answered would then be indistinguishable from a model that finished.

    See patches/forge_sse_error_shape.py for the full chain this closes.
    """
    if protocol == "anthropic":
        return [
            {
                "type": "error",
                "error": {
                    "type": _FORGE_ANTHROPIC_ERROR_TYPES.get(status, "api_error"),
                    "message": message,
                },
            },
        ]
    # Same object _send_error puts in a non-streaming body, so one fault reads
    # the same either way it is reported. `status` is not repeated into it: the
    # message already carries the backend's own code when there is one.
    return [
        {
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}],
        },
        {"error": {"message": message, "type": "proxy_error"}},
    ]


'''


def fail(message: str) -> None:
    print(f"forge_sse_error_shape: {message}", file=sys.stderr)
    raise SystemExit(1)


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_sse_error_shape.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    path = root / SERVER_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")

    source = path.read_text()
    if MARKER in source:
        print(f"forge_sse_error_shape: {SERVER_REL} already patched")
        return 0

    # The helper is annotated with Any and returns dicts built inline; the
    # module already imports both names it needs.
    for name in ("from typing import Any", "import json"):
        if name not in source:
            fail(f"{SERVER_REL} does not contain {name!r} — the helper would not resolve")

    for label, old in (("error_msg assignment", MSG_OLD),
                       ("streaming error emit", SSE_OLD),
                       ("_status_text anchor", ANCHOR)):
        count = source.count(old)
        if count != 1:
            fail(
                f"expected 1 occurrence of the {label} in {SERVER_REL}, found "
                f"{count}. forge changed it — re-read the file before shipping."
            )

    patched = source.replace(MSG_OLD, MSG_NEW)
    patched = patched.replace(SSE_OLD, SSE_NEW)
    patched = patched.replace(ANCHOR, HELPER + ANCHOR)
    path.write_text(patched)
    print(f"forge_sse_error_shape: patched {SERVER_REL} (streaming errors are visible)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
