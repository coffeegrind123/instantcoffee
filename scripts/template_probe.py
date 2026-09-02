#!/usr/bin/env python3
"""Find the request shapes the ACTIVE chat template refuses.

Runs INSIDE the compose network like bench.py and ctx_needle.py:

    docker compose --profile tools run --rm --build \
        --entrypoint python bench /work/scripts/template_probe.py

WHY A SEPARATE SCRIPT
---------------------
`smoke_test.py` proves one well-formed request completes, including a real tool
call. That is the shape pi sends on a good day. It says nothing about the shapes
a template REFUSES, and a refusal here is not a soft failure: the template calls
raise_exception(), llama-server answers 500, and forge turns that into an opaque
502 with the diagnostic thrown away. The operator sees "Backend returned 500"
and has no way to learn that the cause was a second system message.

THE TEMPLATE IS PART OF THE MODEL, AND THE MODES DO NOT SHIP THE SAME ONE
------------------------------------------------------------------------
Measured 2026-09-02, read out of the GGUF headers rather than from any model
card (scripts/gguf_probe.py reads the same way):

    coding      unsloth/Qwen3.8-27B-GGUF        template 9993 chars
    uc-coding   orcarouter/...-Uncensored-GGUF  template 8952 chars
    prose       orcarouter/...-Uncensored-GGUF  template 8952 chars

8952 is byte-identical to Qwen's own published chat_template.jinja
(sha256 c3cf9e34…, which is also the hash NInfer's converter pins). unsloth's is
a fork, and its own trailing comment says what it is for: "Unsloth fixes -
developer role, merged system messages, tool calling". So `uc-coding.env`'s
claim that the ONLY difference from `coding` is MODEL_REPO/GGUF_FILE is true of
the .env and false of the behaviour: switching mode also switches which request
shapes are legal.

WHAT EACH CASE IS FOR
---------------------
Every case is one of the differences between those two templates, plus the
control that proves the case is measuring the difference and not the harness.
A case is only evidence next to its control: `reasoning_effort=high` failing
means nothing unless `medium` passes in the same run, on the same server.

FORGE IS MEASURED TOO, AND THAT IS THE POINT
--------------------------------------------
The llama column is what the template does. The forge column is what the
OPERATOR sees. They are different questions and this probe asks both, because
the gap between them — a named exception becoming "Backend returned 500" — is
the part that costs debugging time.

The forge column costs one token of generation per case (max_tokens=1); the
llama column uses /apply-template and generates nothing. Pass --no-forge to
skip inference entirely.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_lib import post  # noqa: E402

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama:8080")
FORGE_URL = os.environ.get("FORGE_URL", "http://forge:8081")
MODEL = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a shell command",
            "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"],
            },
        },
    }
]

# (name, is_control, messages, extra request fields, what a failure means)
CASES = [
    (
        "one leading system",
        True,
        [{"role": "system", "content": "S"}, {"role": "user", "content": "hi"}],
        {},
        "the harness itself is broken; no other row is evidence",
    ),
    (
        "system + developer",
        False,
        [
            {"role": "system", "content": "S"},
            {"role": "developer", "content": "D"},
            {"role": "user", "content": "hi"},
        ],
        {},
        "a client that sends a developer preamble cannot talk to this mode",
    ),
    (
        "two leading system",
        False,
        [
            {"role": "system", "content": "A"},
            {"role": "system", "content": "B"},
            {"role": "user", "content": "hi"},
        ],
        {},
        "forge's _merge_consecutive did not merge them; the template refuses",
    ),
    (
        "late system message",
        False,
        [
            {"role": "system", "content": "S"},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "R"},
            {"role": "user", "content": "again"},
        ],
        {},
        "invalid in BOTH templates — the one row unsloth does not fix",
    ),
    (
        "reasoning_effort=medium",
        True,
        [{"role": "system", "content": "S"}, {"role": "user", "content": "hi"}],
        {"chat_template_kwargs": {"reasoning_effort": "medium"}},
        "the pinned value is broken; the stack is down",
    ),
    (
        "reasoning_effort=high (kwargs)",
        False,
        [{"role": "system", "content": "S"}, {"role": "user", "content": "hi"}],
        {"chat_template_kwargs": {"reasoning_effort": "high"}},
        "REASONING_EFFORT=high is a documented value and a total outage here",
    ),
    (
        "reasoning_effort=high (top level)",
        False,
        [{"role": "system", "content": "S"}, {"role": "user", "content": "hi"}],
        {"reasoning_effort": "high"},
        "llama.cpp special-cases only 'none'; the rest reach the template",
    ),
    (
        "tool args as object",
        True,
        [
            {"role": "system", "content": "S"},
            {"role": "user", "content": "list files"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "bash", "arguments": {"cmd": "ls"}},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "a.txt"},
            {"role": "user", "content": "thanks"},
        ],
        {"tools": TOOLS},
        "the ordinary tool round trip is broken",
    ),
    (
        "tool args as JSON string",
        False,
        [
            {"role": "system", "content": "S"},
            {"role": "user", "content": "list files"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "bash", "arguments": '{"cmd": "ls"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "a.txt"},
            {"role": "user", "content": "thanks"},
        ],
        {"tools": TOOLS},
        "OpenAI-wire arguments are a STRING by spec; llama.cpp parses them "
        "before templating, so this passing is the expected result",
    ),
    (
        "ends on a tool result",
        False,
        [
            {"role": "system", "content": "S"},
            {"role": "user", "content": "list files"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "bash", "arguments": {"cmd": "ls"}},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "a.txt\nb.txt"},
        ],
        {"tools": TOOLS},
        "official's 'No user query found' guard would fire; measured, it does not",
    ),
]


def _one_line(text: object, limit: int = 96) -> str:
    """Pull the human sentence out of an error body and flatten it to one line.

    probe_lib.post() returns an error body as RAW TEXT, not parsed — an error
    body is evidence and parsing it is the caller's job. So this has to try JSON
    itself, and it matters: without it every refused row prints the same
    `{"error":{"code":500,"messag` prefix and the actual sentence — which is the
    one thing forge throws away — never reaches the operator. That would make
    this probe reproduce the defect it exists to report.

    minja's exception is a multi-line backtrace with the raise_exception() call
    quoted in it; the sentence is worth more than the line numbers, so leading
    dashes and newlines are collapsed away.
    """
    if isinstance(text, str):
        try:
            text = json.loads(text)
        except (ValueError, TypeError):
            pass
    if isinstance(text, dict):
        err = text.get("error")
        if isinstance(err, dict):
            text = err.get("message", text)
        elif err is not None:
            text = err
    flat = " ".join(str(text).split()).lstrip("- ")
    # minja puts the backtrace FIRST and the sentence last:
    #   "------------ While executing CallExpression at line 49, column 28 in
    #    source: ...  Error: Jinja Exception: Unexpected reasoning effort high."
    # Truncating from the left therefore prints the same 44 characters of
    # "While executing CallExpression at" for every row and throws away the only
    # part that differs. Take the sentence when there is one.
    for marker in ("Jinja Exception:", "Error:"):
        if marker in flat:
            flat = flat.split(marker, 1)[1].strip()
            break
    return flat[:limit]


def probe_llama(messages, extra):
    """/apply-template renders the prompt and generates nothing."""
    payload = {"messages": messages}
    payload.update(extra)
    try:
        status, body = post(LLAMA_URL, "/apply-template", payload, timeout=120)
    except Exception as exc:  # noqa: BLE001 — see _NOTE_ON_TRANSPORT below
        return None, f"{type(exc).__name__}: {exc}"
    if status == 200 and isinstance(body, dict):
        return True, f"{len(body.get('prompt', ''))} chars"
    return False, f"HTTP {status}: {_one_line(body)}"


def probe_forge(messages, extra, timeout):
    """One token, because the question is whether the request is ACCEPTED."""
    payload = {"model": MODEL, "messages": messages, "max_tokens": 1, "stream": False}
    payload.update(extra)
    try:
        status, body = post(FORGE_URL, "/v1/chat/completions", payload, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"
    if status == 200:
        return True, "accepted"
    return False, f"HTTP {status}: {_one_line(body, 60)}"


# _NOTE_ON_TRANSPORT
# probe_lib.post() deliberately lets a transport failure propagate: for the
# depth probes, "the server is not there" makes every number meaningless, so
# crashing is right. It is wrong HERE. This probe's rows are independent
# questions, the forge column generates a token and so competes with whatever
# the operator is doing on the same GPU, and one slow request should not
# destroy the nine answers around it. A transport failure is therefore recorded
# as its own outcome (`????`) and is never counted as a refusal — a timeout is
# not the template saying no, and reporting it as one would manufacture exactly
# the kind of finding this file exists to avoid.


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-forge", action="store_true",
                    help="skip the forge column; generates nothing at all")
    ap.add_argument("--timeout", type=float,
                    default=float(os.environ.get("BENCH_TIMEOUT", "900")),
                    help="seconds to wait for each forge request "
                         "(default: BENCH_TIMEOUT, then 900)")
    args = ap.parse_args()

    # /props is a GET. probe_lib.post() is POST-only and llama-server answers
    # 501 to a POST here, which is not "no props" — naming the template is the
    # first line of the report, so it gets its own request rather than a shrug.
    props = None
    try:
        with urllib.request.urlopen(LLAMA_URL.rstrip("/") + "/props", timeout=60) as r:
            props = json.loads(r.read())
    except Exception as exc:  # noqa: BLE001 — reported, never fatal
        print(f"/props unavailable ({exc}) — cannot name the template", file=sys.stderr)
    if isinstance(props, dict):
        model = str(props.get("model_path", "?")).replace("\\", "/").split("/")[-1]
        chars = len(props.get("chat_template") or "")
        print(f"model            {model}")
        print(f"chat template    {chars} chars")

    width = max(len(name) for name, *_ in CASES)
    header = f"\n{'case':{width}s}  {'llama':<44s}"
    if not args.no_forge:
        header += "  forge"
    print(header)

    def verdict(ok):
        return "OK  " if ok is True else ("FAIL" if ok is False else "????")

    control_failed = False
    unreachable = 0
    refused = []
    for name, is_control, messages, extra, meaning in CASES:
        ok_l, note_l = probe_llama(messages, extra)
        mark = "·" if is_control else " "
        row = f"{name:{width}s}{mark} {verdict(ok_l)} {note_l:<44.44s}"
        if not args.no_forge:
            ok_f, note_f = probe_forge(messages, extra, args.timeout)
            row += f"  {verdict(ok_f)} {note_f}"
        print(row, flush=True)
        if ok_l is None:
            unreachable += 1
        elif is_control and not ok_l:
            control_failed = True
            print(f"    CONTROL FAILED — {meaning}")
        elif not is_control and not ok_l:
            refused.append((name, meaning))

    print(f"\n· = control, ???? = did not answer (not a refusal). "
          f"{len(refused)} non-control shape(s) refused by this template.")
    for name, meaning in refused:
        print(f"    {name}: {meaning}")

    if control_failed:
        print("\nA control failed. Nothing above is evidence — fix the harness first.")
        return 2
    if unreachable:
        print(f"\n{unreachable} case(s) never got an answer. Re-run on a quiet box "
              f"before quoting the table.")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
