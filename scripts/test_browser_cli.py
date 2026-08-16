#!/usr/bin/env python3
"""Standalone unit tests for scripts/browser_cli.py. No server, no network.

    python3 scripts/test_browser_cli.py

What is worth testing here is the layer between a shell word and a JSON value.
Everything else in that file is I/O against a server that has its own test
suite; the argument parser is ours, and its failure mode is the quiet one — a
mistyped parameter that vanishes produces a call that succeeds and does the
wrong thing.
"""

import importlib.util
import io
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("browser_cli", HERE / "browser_cli.py")
assert spec and spec.loader
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f"  ok   {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL {label}: got {got!r}, want {want!r}")


def check_dies(label: str, fn) -> None:
    """The CLI reports argument problems by exiting, not by raising."""
    err = io.StringIO()
    real, sys.stderr = sys.stderr, err
    try:
        fn()
    except SystemExit as e:
        code = e.code
    else:
        code = None
    finally:
        sys.stderr = real
    if code:
        print(f"  ok   {label} (exit {code}: {err.getvalue().strip()[:60]})")
    else:
        FAILURES.append(label)
        print(f"  FAIL {label}: did not exit")


NAVIGATE = {
    "name": "navigate",
    "description": "Navigate the active tab to a URL. Waits for load.",
    "inputSchema": {
        "type": "object",
        "properties": {"url": {"type": "string"}},
        "required": ["url"],
    },
}

SCREENSHOT = {
    "name": "screenshot",
    "description": "Take a screenshot.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "save_path": {"type": "string"},
            "full_resolution": {"type": "boolean", "default": False},
            "quality": {"type": "integer", "default": 60},
            "scale": {"type": "number"},
            "regions": {"type": "array"},
        },
        "required": [],
    },
}


def main() -> int:
    print("browser_cli: argument parsing")
    check("--name value", bc.parse_tool_args(NAVIGATE, ["--url", "https://x.dev"]), {"url": "https://x.dev"})
    check("--name=value", bc.parse_tool_args(NAVIGATE, ["--url=https://x.dev"]), {"url": "https://x.dev"})
    check("dashes in a flag name", bc.parse_tool_args(SCREENSHOT, ["--save-path", "/tmp/a.png"]), {"save_path": "/tmp/a.png"})
    check("--args-json merges", bc.parse_tool_args(NAVIGATE, ["--args-json", '{"url":"https://y.dev"}']), {"url": "https://y.dev"})

    print("browser_cli: type coercion")
    check("integer", bc.parse_tool_args(SCREENSHOT, ["--quality", "80"]), {"quality": 80})
    check("number", bc.parse_tool_args(SCREENSHOT, ["--scale", "1.5"]), {"scale": 1.5})
    check("array as JSON", bc.parse_tool_args(SCREENSHOT, ["--regions", "[1,2]"]), {"regions": [1, 2]})
    check("boolean word", bc.parse_tool_args(SCREENSHOT, ["--full_resolution", "true"]), {"full_resolution": True})
    check("boolean off", bc.parse_tool_args(SCREENSHOT, ["--full_resolution", "no"]), {"full_resolution": False})
    # A bare flag is true ONLY where the schema says boolean — anywhere else it
    # is a missing value, and treating it as a shorthand would silently send the
    # wrong type.
    check("bare boolean flag", bc.parse_tool_args(SCREENSHOT, ["--full_resolution"]), {"full_resolution": True})
    check(
        "bare boolean before another flag",
        bc.parse_tool_args(SCREENSHOT, ["--full_resolution", "--save_path", "/tmp/a.png"]),
        {"full_resolution": True, "save_path": "/tmp/a.png"},
    )

    print("browser_cli: bad input fails loudly")
    check_dies("unknown parameter", lambda: bc.parse_tool_args(NAVIGATE, ["--ur", "https://x.dev"]))
    check_dies("missing value", lambda: bc.parse_tool_args(NAVIGATE, ["--url"]))
    check_dies("non-integer for an integer", lambda: bc.parse_tool_args(SCREENSHOT, ["--quality", "high"]))
    check_dies("non-JSON for an array", lambda: bc.parse_tool_args(SCREENSHOT, ["--regions", "1,2"]))
    check_dies("positional argument", lambda: bc.parse_tool_args(NAVIGATE, ["https://x.dev"]))

    print("browser_cli: result rendering")
    check("text block", bc.text_of({"content": [{"type": "text", "text": "hi"}]}), "hi")
    # An image must never reach the conversation as base64: one screenshot is
    # tens of thousands of tokens, and this model cannot read it anyway.
    img = bc.text_of({"content": [{"type": "image", "mimeType": "image/png", "data": "A" * 5000}]})
    check("image is summarised, not dumped", ("A" * 100 not in img and "save_path" in img), True)
    check("first sentence", bc.first_sentence(NAVIGATE["description"]), "Navigate the active tab to a URL.")
    check("tool name normalising", bc.normalise("get-text-content"), "get_text_content")

    print("browser_cli: help rendering")
    help_text = bc.tool_help(NAVIGATE)
    check("help names the required arg", "--url <string>" in help_text, True)
    check("help marks it required", "(required)" in help_text, True)

    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("\nall browser_cli tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
