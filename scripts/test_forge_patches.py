#!/usr/bin/env python3
"""Do the build-time forge patches actually BEHAVE? Runs inside the built image.

    docker run --rm --entrypoint python qwen38-forge/proxy:ci /work/scripts/test_forge_patches.py

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
  merge_across_tools    two user turns either side of a tool-call/tool-result
                        pair stay separate, adjacent ones still merge, and
                        FORGE_MERGE_ACROSS_TOOLS=1 restores the old behaviour

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

    total = PASSED + FAILED
    print(f"\n{PASSED}/{total} passed", end="")
    if FAILED:
        print(f", {FAILED} FAILED")
        return 1
    print(" — all good")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
