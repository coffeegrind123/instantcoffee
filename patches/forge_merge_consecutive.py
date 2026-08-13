#!/usr/bin/env python3
"""Patch forge's _merge_consecutive() to survive structured message content.

THE BUG (forge-guardrails 0.8.2 AND 0.9.0, clients/llamafile.py):

    "content": target.get("content", "") + "\\n\\n" + m.get("content", ""),

That assumes every message's ``content`` is a ``str``. The OpenAI schema also
allows a LIST of content blocks — ``[{"type": "text", "text": "..."}]`` — which
is what pi sends. When two consecutive same-role messages are merged and either
side is a list, the expression evaluates ``list + str`` and raises:

    TypeError: can only concatenate list (not "str") to list

which forge returns to the client as an opaque HTTP 502.

HOW YOU HIT IT: any turn that leaves two same-role messages adjacent. The
observed case was a request failing mid-load (llama answering 503 "Loading
model"), the user retyping the same question, and pi sending both user messages
— so the first thing you do after a restart is the thing that triggers it.

Reproduced 2026-08-13 against the running proxy, with a control:
    2x user, string content -> 200 OK
    2x user, list content   -> 502 "can only concatenate list ..."
    1x user, list content   -> 200 OK

THE FIX: keep the string path byte-identical, and concatenate block lists when
either side is structured. Coercing to text instead would silently drop image
blocks the moment MMPROJ_FILE is set.

Applied at image build time rather than vendored, so the upstream package stays
a pinned dependency. It verifies the exact source text before rewriting and
exits non-zero if it is absent, so a forge upgrade that touches this line fails
the build loudly instead of quietly shipping unpatched.
"""

from __future__ import annotations

import sys
from pathlib import Path

TARGET_REL = "forge/clients/llamafile.py"

OLD = (
    '                    "content": target.get("content", "") + "\\n\\n" + m.get("content", ""),\n'
)

NEW = (
    '                    "content": _forge_merge_content(\n'
    '                        target.get("content", ""), m.get("content", "")\n'
    '                    ),\n'
)

HELPER = '''

def _forge_merge_content(a, b):
    """Join two message contents that may each be a str or a list of blocks.

    Patched in by patches/forge_merge_consecutive.py — see that file for the bug
    this exists to avoid. str+str keeps upstream's exact behaviour, including the
    blank-line separator; anything structured is merged as blocks so image parts
    survive.
    """
    if isinstance(a, str) and isinstance(b, str):
        return a + "\\n\\n" + b

    def blocks(c):
        if c is None or c == "":
            return []
        if isinstance(c, list):
            return list(c)
        return [{"type": "text", "text": str(c)}]

    return blocks(a) + blocks(b)
'''


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <site-packages-dir>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1]) / TARGET_REL
    if not path.is_file():
        print(f"PATCH FAILED: {path} does not exist", file=sys.stderr)
        return 1

    src = path.read_text(encoding="utf-8")

    if "_forge_merge_content" in src:
        print(f"already patched: {path}")
        return 0

    if OLD not in src:
        print(
            "PATCH FAILED: the expected concatenation was not found in\n"
            f"  {path}\n"
            "forge has changed this line. Re-check whether the structured-content\n"
            "bug still exists before removing this patch — do not just delete it.",
            file=sys.stderr,
        )
        return 1

    if src.count(OLD) != 1:
        print(f"PATCH FAILED: expected 1 occurrence, found {src.count(OLD)}", file=sys.stderr)
        return 1

    path.write_text(src.replace(OLD, NEW, 1) + HELPER, encoding="utf-8")
    print(f"patched {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
