#!/usr/bin/env python3
"""Stop forge dropping llama.cpp's prompt-cache counter on the way to the client.

THE BUG (forge-guardrails 0.9.0; STILL PRESENT ON 0.9.5, re-verified
2026-08-30 by a clean build plus test_forge_patches.py inside the image):

llama-server reports how much of the prompt it served from its KV cache:

    "usage": {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15,
              "prompt_tokens_details": {"cached_tokens": 7}}

forge rebuilds that dict from scratch in ``forge/proxy/convert.py`` with exactly
three keys, so the client is told nothing about caching. And the llama.cpp client
(``forge/clients/llamafile.py::_record_usage``) never reads ``cached_tokens``
either, even though ``TokenUsage`` already carries a ``cache_read_input_tokens``
field for precisely this.

Measured 2026-08-16, matched control pair, identical request:

    llama-server :8080  ->  prompt_tokens_details: {cached_tokens: 7}
    forge        :8081  ->  (no prompt_tokens_details at all)

WHY IT MATTERS HERE: pi reads exactly this field —
``pi-ai/dist/api/openai-completions.js`` maps
``rawUsage.prompt_tokens_details?.cached_tokens`` to its ``cacheRead`` counter.
Without it every request in every session reports ``cacheRead: 0``, the footer's
cache-hit indicator can never appear, and the one number that would show whether
the prompt prefix is being reused is invisible. That matters on a stack whose
whole design is built around prefix reuse (CACHE_PROMPT, CACHE_REUSE,
--slot-save-path, frozen tool surfaces): the feature was working the entire time
— llama's own logs show f_sim_best up to 0.988 — and nothing downstream could
see it.

THE FIX: populate ``cache_read_input_tokens`` in the llama.cpp client, and emit
``prompt_tokens_details.cached_tokens`` from the four places convert.py builds a
usage dict — but only when the counter is non-zero, so a backend that reports no
caching produces byte-identical output to before.

Applied at image build time rather than vendored, so the upstream package stays a
pinned dependency. It verifies the exact source text before rewriting and exits
non-zero if it is absent, so a forge upgrade that touches these lines fails the
build loudly instead of quietly shipping unpatched.
"""

from __future__ import annotations

import sys
from pathlib import Path

CONVERT_REL = "forge/proxy/convert.py"
CLIENT_REL = "forge/clients/llamafile.py"

# --- 1. the llama.cpp client has to read the counter at all ------------------

CLIENT_OLD = """        normalized = TokenUsage(
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
        )
"""

CLIENT_NEW = """        details = usage.get("prompt_tokens_details") or {}
        normalized = TokenUsage(
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
            # llama-server reports how much of the prompt came from its KV cache.
            # TokenUsage already carries the field; nothing was filling it.
            cache_read_input_tokens=int(details.get("cached_tokens") or 0),
        )
"""

# --- 2. and the response builder has to pass it on ---------------------------

HELPER_ANCHOR = "# ── Inbound: OpenAI request → forge Messages ─────────────────────\n"

HELPER = '''def _openai_usage(usage: Any) -> dict[str, Any]:
    """Usage dict for an OpenAI-shaped response, including the cache counter.

    ``prompt_tokens_details`` is only added when the backend actually reported a
    cache read, so backends without prompt caching keep byte-identical output.
    """
    block: dict[str, Any] = {
        "prompt_tokens": getattr(usage, "prompt_tokens", 0),
        "completion_tokens": getattr(usage, "completion_tokens", 0),
        "total_tokens": getattr(usage, "total_tokens", 0),
    }
    cached = int(getattr(usage, "cache_read_input_tokens", 0) or 0)
    if cached:
        block["prompt_tokens_details"] = {"cached_tokens": cached}
    return block


'''

USAGE_BLOCK_OLD = """        {target}["usage"] = {{
            "prompt_tokens": getattr(usage, "prompt_tokens", 0),
            "completion_tokens": getattr(usage, "completion_tokens", 0),
            "total_tokens": getattr(usage, "total_tokens", 0),
        }}
"""

USAGE_BLOCK_NEW = """        {target}["usage"] = _openai_usage(usage)
"""

# (target name, how many identical occurrences to expect)
USAGE_TARGETS = [("response", 2), ("final_event", 2)]


def fail(message: str) -> None:
    print(f"forge_cached_tokens: {message}", file=sys.stderr)
    raise SystemExit(1)


def patch_client(root: Path) -> None:
    path = root / CLIENT_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if "cache_read_input_tokens=int(details.get(" in source:
        print(f"forge_cached_tokens: {CLIENT_REL} already patched")
        return
    count = source.count(CLIENT_OLD)
    if count != 1:
        fail(
            f"expected exactly 1 occurrence of the TokenUsage construction in {CLIENT_REL}, "
            f"found {count}. forge changed it — re-read _record_usage() before shipping."
        )
    path.write_text(source.replace(CLIENT_OLD, CLIENT_NEW))
    print(f"forge_cached_tokens: patched {CLIENT_REL}")


def patch_convert(root: Path) -> None:
    path = root / CONVERT_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if "_openai_usage" in source:
        print(f"forge_cached_tokens: {CONVERT_REL} already patched")
        return

    if source.count(HELPER_ANCHOR) != 1:
        fail(f"anchor comment not found exactly once in {CONVERT_REL}")
    source = source.replace(HELPER_ANCHOR, HELPER_ANCHOR + "\n" + HELPER, 1)

    for target, expected in USAGE_TARGETS:
        old = USAGE_BLOCK_OLD.format(target=target)
        count = source.count(old)
        if count != expected:
            fail(
                f"expected {expected} occurrences of the {target} usage block in "
                f"{CONVERT_REL}, found {count}. forge changed it — re-read the file."
            )
        source = source.replace(old, USAGE_BLOCK_NEW.format(target=target))

    path.write_text(source)
    print(f"forge_cached_tokens: patched {CONVERT_REL} ({sum(n for _, n in USAGE_TARGETS)} sites)")


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_cached_tokens.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")
    patch_client(root)
    patch_convert(root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
