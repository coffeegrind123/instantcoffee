#!/usr/bin/env python3
"""The backend said WHY. Say it, instead of "Backend returned 500".

THE MEASUREMENT (2026-09-02, live). Six request shapes were sent through this
stack. Five of them failed, and every one of the five reached the client as the
same sentence::

    {"error": {"message": "Backend returned 500", "type": "proxy_error"}}

llama-server had answered with the cause in every case, and forge had it in
hand. From ``docker logs instantcoffee-llama``, for one of the five::

    Error: Jinja Exception: Unexpected reasoning effort high. Supported types
    are xhigh (default), medium, and low.

Two different faults — a chat template refusing a `reasoning_effort` value, and
a chat template refusing a second system message — are indistinguishable at the
client. The account of what that cost is in
``context/design/the-template-is-part-of-the-model.md``; the short version is
that identifying a one-word config error took a template diff, a live probe and
a log dig, and the sentence naming it had been sitting in the backend's response
body the whole time.

WHY IT IS THROWN AWAY, AND WHY THAT IS NOT A BUG

This is a deliberate upstream policy, not an oversight, and it is documented in
``forge/errors.py`` on ``BackendError``::

    ``detail`` is a forge-authored summary and IS part of the message — safe to
    log (forge never writes a secret into it). A backend's RAW response body
    must be passed as ``raw_body`` instead: a gateway could echo an inbound
    credential into it, and the message is what gets logged and returned to
    callers, so the raw body is kept on ``exc.body`` for debugging but never
    placed in the message.

``_send_exception``'s own docstring repeats it. Every call site already captures
the body (``raise BackendError(resp.status_code, raw_body=resp.text)``); the
message is where it is not allowed to go. So the patch that "just appends
exc.body" is the wrong patch, and this is not it.

WHAT THIS PATCH DOES INSTEAD

It takes the backend's own ``error.message`` STRING out of a well-formed JSON
error envelope, and nothing else. The distinction is the whole design:

* A response that parses as JSON **and** is an object **and** carries
  ``error.message`` (or a top-level ``message``) as a string is a structured
  error envelope — the shape llama.cpp, vLLM, Ollama and the OpenAI wire all
  use to say what went wrong. That field is authored by the backend to be read.
* A body that is HTML, plain text, a redirect page, a truncated stream or
  anything else unparsable is passed over and stays exactly where upstream put
  it, on ``exc.body``. That is the shape an intermediary echoing a request —
  credentials included — produces, and it is untouched by this patch.

So the relaxation is bounded to one string field of one recognised structure,
rather than to "whatever the backend sent". It is not zero risk: a backend could
put a secret in ``error.message``. It is a much smaller surface than the raw
body, and on this stack the backend is llama-server on the loopback interface
with no gateway between them.

AND IT IS A SWITCH, DEFAULT ON

``FORGE_BACKEND_ERROR_DETAIL=0`` restores upstream's behaviour exactly. Default
ON is a judgement about THIS deployment — ``BIND_ADDR=127.0.0.1``, one user, no
credential-bearing intermediary — and not a claim that upstream's default is
wrong. A deployment with a gateway in front of it should set it to 0.

Contrast ``FORGE_MERGE_ACROSS_TOOLS``, which is default OFF: that one gates a
behaviour measured as harmful here, so the safe default is to leave it off. This
one gates information, so the safe default is to have it and the escape hatch is
to drop it.

WHAT IT DOES TO THE TEXT

minja puts its backtrace FIRST and the sentence LAST::

    ------------
    While executing CallExpression at line 49, column 28 in source:
    ...', 'low') %}↵        {{- raise_exception('Unexpected reasoning effort...
                                               ^
    Error: Jinja Exception: Unexpected reasoning effort high. Supported types...

A left-truncated version of that is the same forty characters of "While
executing CallExpression at" for every distinct fault, which is a different way
of saying nothing. So the text after ``Jinja Exception:`` — or failing that,
after ``Error:`` — is preferred when present, whitespace is collapsed to one
line, and the result is capped at 300 characters. The cap is on the DETAIL
only; the status code that was already in the message is untouched.

WHAT IT DELIBERATELY DOES NOT DO

**It does not change any status code.** A 500 from the backend still becomes a
502 from forge. Which side failed is a separate question from what the failure
was, and the mapping at ``_send_exception`` is upstream's to make.

**It does not touch ``exc.body``.** The raw body stays exactly where upstream
keeps it, so anything reading it for debugging is unaffected.

**It does not log more than before.** ``logger.info("<< ERROR: %s", ...)``
already truncates at 120 characters and still does; the detail reaches the log
through the same call and the same cap.

**It does not apply to non-``BackendError`` exceptions.** A forge-authored
exception has a forge-authored message by construction; there is no backend
envelope to read.
"""

from __future__ import annotations

import sys
from pathlib import Path

SERVER_REL = "forge/proxy/server.py"

MARKER = "_forge_backend_detail"

# The line as forge_sse_error_shape.py leaves it. This patch runs AFTER that
# one, so the anchor is the patched text, not upstream's `error_msg = str(exc)`.
# If the ordering in Dockerfile.forge is ever changed, this fails loudly rather
# than silently matching nothing.
MSG_OLD = '        error_msg = str(exc) or f"{type(exc).__name__} (no message)"\n'

MSG_NEW = (
    '        error_msg = str(exc) or f"{type(exc).__name__} (no message)"\n'
    "        # The backend's own sentence, when it sent a structured one.\n"
    "        # See patches/forge_backend_error_detail.py.\n"
    "        error_msg += _forge_backend_detail(exc)\n"
)

ANCHOR = "def _status_text(code: int) -> str:"

HELPER = '''import os as _forge_os

# patches/forge_backend_error_detail.py — see that file. Upstream keeps a
# backend's RAW body off the exception message on purpose, because an
# intermediary can echo a credential into it. This lifts ONE string out of a
# recognised JSON error envelope and leaves every other body shape alone.
_FORGE_BACKEND_ERROR_DETAIL = _forge_os.environ.get(
    "FORGE_BACKEND_ERROR_DETAIL", "1"
).strip().lower() in ("1", "true", "yes", "on")

# Long enough for a template exception's sentence, short enough that a body
# which is mostly payload cannot become the error message by accident.
_FORGE_DETAIL_MAX = 300

# minja emits the backtrace first and the sentence last. Both markers are tried
# in order; the first one present wins and everything before it is dropped.
_FORGE_DETAIL_MARKERS = ("Jinja Exception:", "Error:")


def _forge_backend_detail(exc: Exception) -> str:
    """The backend's own error sentence, as a `: ...` suffix, or "".

    Returns the EMPTY STRING for every case it does not positively recognise —
    the switch being off, a non-BackendError, a body that is not JSON, a JSON
    body that is not an object, a missing or non-string message field, and a
    message that adds nothing to what the exception already says. A caller can
    therefore append the result unconditionally.
    """
    if not _FORGE_BACKEND_ERROR_DETAIL:
        return ""
    body = getattr(exc, "body", None)
    if not isinstance(body, str) or not body.strip():
        return ""
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        # HTML, plain text, a truncated stream: not an envelope this
        # understands, so it stays off the message exactly as upstream left it.
        return ""
    if not isinstance(parsed, dict):
        return ""
    message = None
    error = parsed.get("error")
    if isinstance(error, dict):
        message = error.get("message")
    elif isinstance(error, str):
        message = error
    if not isinstance(message, str):
        message = parsed.get("message")
    if not isinstance(message, str) or not message.strip():
        return ""
    for marker in _FORGE_DETAIL_MARKERS:
        if marker in message:
            message = message.split(marker, 1)[1]
            break
    # One line: the backtrace above the sentence is multi-line, and an error
    # message with embedded newlines breaks the log line it goes into.
    flat = " ".join(message.split()).lstrip("- ").strip()
    if not flat:
        return ""
    if len(flat) > _FORGE_DETAIL_MAX:
        flat = flat[: _FORGE_DETAIL_MAX - 1].rstrip() + "\\u2026"
    # str(exc) is "Backend returned 500" — or already carries a forge-authored
    # detail, in which case repeating the same text would say it twice.
    if flat in str(exc):
        return ""
    return f": {flat}"


'''


def fail(message: str) -> None:
    print(f"forge_backend_error_detail: {message}", file=sys.stderr)
    raise SystemExit(1)


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_backend_error_detail.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    path = root / SERVER_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")

    source = path.read_text()
    if MARKER in source:
        print(f"forge_backend_error_detail: {SERVER_REL} already patched")
        return 0

    # The helper calls json.loads at module scope of the patched file.
    if "import json" not in source:
        fail(f"{SERVER_REL} does not import json — the helper would not resolve")

    for label, old in (("error_msg assignment", MSG_OLD),
                       ("_status_text anchor", ANCHOR)):
        count = source.count(old)
        if count != 1:
            fail(
                f"expected 1 occurrence of the {label} in {SERVER_REL}, found "
                f"{count}. forge (or an earlier patch) changed it — re-read the "
                f"file before shipping."
            )

    patched = source.replace(MSG_OLD, MSG_NEW)
    patched = patched.replace(ANCHOR, HELPER + ANCHOR)
    path.write_text(patched)
    print(f"forge_backend_error_detail: patched {SERVER_REL} "
          f"(backend error sentences reach the client)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
