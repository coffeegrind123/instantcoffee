#!/usr/bin/env python3
"""End-to-end verification of the qwen3.6-forge stack.

Runs inside the compose network (`docker compose --profile tools run --rm
smoketest`), so it exercises the same service names the proxy itself uses.

It does not merely check that ports answer. The tool-calling checks are the
point: llama.cpp silently ignores the `tools` parameter when --jinja is missing,
which looks exactly like "the model isn't good at tool calling". These tests
fail loudly on that instead, and print the raw response body when they do.

Exit code 0 = every check passed.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama:8080").rstrip("/")
FORGE_URL = os.environ.get("FORGE_URL", "http://forge:8081").rstrip("/")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "qwen3.6-27b")
CTX_SIZE = int(os.environ.get("CTX_SIZE", "32768"))

# Generous: a cold 27B on one 4090 with a thinking budget is not fast.
INFER_TIMEOUT = float(os.environ.get("SMOKE_TIMEOUT", "600"))

WEATHER_TOOL_OPENAI = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name"},
            },
            "required": ["city"],
        },
    },
}

WEATHER_TOOL_ANTHROPIC = {
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "input_schema": {
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "City name"},
        },
        "required": ["city"],
    },
}

PROMPT = "What is the weather in Paris right now? Use the tool."

_results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> bool:
    _results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""), flush=True)
    return ok


def http(url: str, payload: dict | None = None, timeout: float = 15.0,
         headers: dict | None = None) -> tuple[int, str]:
    """Return (status, body). Never raises on an HTTP error status."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST" if data else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(errors="replace")
    except Exception as exc:  # connection refused, DNS, timeout
        return 0, f"{type(exc).__name__}: {exc}"


def wait_for(url: str, label: str, timeout: float = 900.0) -> bool:
    """Poll a health endpoint until it answers 200 or the deadline passes."""
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        status, body = http(url, timeout=10.0)
        if status == 200:
            return record(f"{label} reachable", True, url)
        last = f"status={status} {body[:120]}"
        time.sleep(5)
    return record(f"{label} reachable", False, f"timed out after {timeout:.0f}s — {last}")


def check_llama_props() -> None:
    status, body = http(f"{LLAMA_URL}/props", timeout=15)
    if status != 200:
        record("llama /props", False, f"status={status} body={body[:200]}")
        return
    try:
        props = json.loads(body)
    except json.JSONDecodeError:
        record("llama /props", False, f"non-JSON body: {body[:200]}")
        return

    n_ctx = props.get("default_generation_settings", {}).get("n_ctx") or props.get("n_ctx")
    record("llama /props", True, f"n_ctx={n_ctx}")

    if isinstance(n_ctx, int) and n_ctx > 0:
        # -np N splits the total context across slots; this is the per-slot value.
        record(
            "context matches CTX_SIZE",
            n_ctx >= CTX_SIZE // max(1, int(os.environ.get("PARALLEL_SLOTS", "1"))),
            f"server reports {n_ctx}, .env asks for {CTX_SIZE}",
        )

    chat_tmpl = props.get("chat_template") or ""
    # The Qwen tool-calling template is what --jinja activates. If the server
    # fell back to a builtin template, tool calls will never parse.
    record(
        "jinja chat template loaded",
        "tools" in chat_tmpl or "tool_call" in chat_tmpl,
        f"template is {len(chat_tmpl)} chars",
    )


def check_models() -> None:
    status, body = http(f"{LLAMA_URL}/v1/models", timeout=15)
    if status != 200:
        record("llama /v1/models", False, f"status={status} body={body[:200]}")
        return
    ids = [m.get("id") for m in json.loads(body).get("data", [])]
    record("llama /v1/models", bool(ids), f"ids={ids}")


def check_openai_tool_call() -> None:
    """The core check: a tool call, through forge, in OpenAI wire format."""
    started = time.monotonic()
    status, body = http(
        f"{FORGE_URL}/v1/chat/completions",
        {
            "model": MODEL_ALIAS,
            "messages": [{"role": "user", "content": PROMPT}],
            "tools": [WEATHER_TOOL_OPENAI],
            "max_tokens": 2048,
        },
        timeout=INFER_TIMEOUT,
    )
    elapsed = time.monotonic() - started

    if status != 200:
        record("forge OpenAI tool call", False, f"status={status} body={body[:400]}")
        return

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        record("forge OpenAI tool call", False, f"non-JSON body: {body[:400]}")
        return

    msg = (data.get("choices") or [{}])[0].get("message", {})
    calls = msg.get("tool_calls") or []
    if not calls:
        # Print the raw evidence — this is the failure that gets misdiagnosed as
        # "the model is bad at tools" when the real cause is a missing --jinja.
        record(
            "forge OpenAI tool call",
            False,
            "no tool_calls in response (is --jinja set?). "
            f"content={str(msg.get('content'))[:200]!r}",
        )
        return

    fn = calls[0].get("function", {})
    name = fn.get("name")
    try:
        args = json.loads(fn.get("arguments") or "{}")
    except json.JSONDecodeError:
        args = {"<unparseable>": fn.get("arguments")}

    usage = data.get("usage", {})
    record(
        "forge OpenAI tool call",
        name == "get_weather",
        f"{name}({args}) in {elapsed:.1f}s, "
        f"{usage.get('completion_tokens', '?')} completion tokens",
    )
    record("tool arguments parse as JSON", isinstance(args.get("city"), str), f"city={args.get('city')!r}")


def check_anthropic_tool_call() -> None:
    """The path Claude Code uses: Anthropic Messages wire format."""
    started = time.monotonic()
    status, body = http(
        f"{FORGE_URL}/v1/messages",
        {
            "model": MODEL_ALIAS,
            "max_tokens": 2048,
            "messages": [{"role": "user", "content": PROMPT}],
            "tools": [WEATHER_TOOL_ANTHROPIC],
        },
        timeout=INFER_TIMEOUT,
        headers={"x-api-key": "local", "anthropic-version": "2023-06-01"},
    )
    elapsed = time.monotonic() - started

    if status != 200:
        record("forge Anthropic tool call", False, f"status={status} body={body[:400]}")
        return

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        record("forge Anthropic tool call", False, f"non-JSON body: {body[:400]}")
        return

    blocks = data.get("content") or []
    uses = [b for b in blocks if b.get("type") == "tool_use"]
    if not uses:
        kinds = [b.get("type") for b in blocks]
        record("forge Anthropic tool call", False, f"no tool_use block; got {kinds}")
        return

    record(
        "forge Anthropic tool call",
        uses[0].get("name") == "get_weather",
        f"{uses[0].get('name')}({uses[0].get('input')}) in {elapsed:.1f}s",
    )
    record("stop_reason is tool_use", data.get("stop_reason") == "tool_use",
           f"stop_reason={data.get('stop_reason')!r}")


def check_plain_completion() -> None:
    """A toolless request must still come back as ordinary text."""
    status, body = http(
        f"{FORGE_URL}/v1/chat/completions",
        {
            "model": MODEL_ALIAS,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "max_tokens": 512,
        },
        timeout=INFER_TIMEOUT,
    )
    if status != 200:
        record("forge plain completion", False, f"status={status} body={body[:300]}")
        return
    data = json.loads(body)
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    record("forge plain completion", bool(content.strip()), f"{content.strip()[:80]!r}")


def main() -> int:
    print(f"\nqwen3.6-forge smoke test\n  llama: {LLAMA_URL}\n  forge: {FORGE_URL}\n")

    print("Reachability")
    llama_up = wait_for(f"{LLAMA_URL}/health", "llama-server")
    forge_up = wait_for(f"{FORGE_URL}/health", "forge proxy", timeout=120)

    if llama_up:
        print("\nBackend")
        check_llama_props()
        check_models()

    if llama_up and forge_up:
        print("\nInference through forge")
        check_plain_completion()
        check_openai_tool_call()
        check_anthropic_tool_call()

    failed = [n for n, ok, _ in _results if not ok]
    print(f"\n{len(_results) - len(failed)}/{len(_results)} checks passed")
    if failed:
        print("Failed: " + ", ".join(failed))
        return 1
    print("Stack is healthy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
