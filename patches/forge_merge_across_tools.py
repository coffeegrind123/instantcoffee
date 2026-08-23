#!/usr/bin/env python3
"""Stop forge folding every user turn into the FIRST user message on this stack.

THE BEHAVIOUR (forge-guardrails 0.9.0, and it is deliberate upstream):

``forge/clients/llamafile.py::_merge_consecutive`` says what it is for:

    Ensure strict user/assistant alternation for Jinja parity checker.

    llama-server's Mistral Jinja template counts only plain user and plain
    assistant messages (no tool_calls). Messages with tool_calls or role="tool"
    are invisible to the checker. When two plain messages of the same role
    would appear at consecutive visible positions, merge them to avoid a 500.

So it merges two same-role messages that are ADJACENT (the retry-nudge case),
and it also merges two that are separated by an assistant tool-call and a tool
result — because those are invisible to that checker. The second half is what a
coding agent hits on every single turn:

    user1, assistant(tool_calls), tool, user2   ->   user1+user2, assistant, tool

Measured on this stack, model-facing tape against client-facing tape of the same
turn: eight messages became six, and the NEWEST instruction arrived in the middle
of the prompt rather than at the end.

WHY IT COSTS SOMETHING HERE, MEASURED:

Rewriting an early message changes the prompt PREFIX, so llama's KV cache has
nothing to reuse past that point. Three arms, same three-turn conversation, each
with its own nonce so no arm warms another's cache, cache_n from llama itself:

    direct (no forge)     0/395    391/517    513/702     <- reuse GROWS
    forge, keep-last      0/399    352/517    352/635     <- pinned
    forge, full           0/396    349/582    349/754     <- pinned

Read cache_n, not the percentage: without forge the reused prefix grows with the
conversation; through forge it stops growing exactly where the rewrite begins.
On a 90k agentic session that is the difference between re-evaluating a few
hundred tokens a turn and re-evaluating nearly all of them.

AND THE REASON DOES NOT APPLY TO THIS STACK. That parity checker belongs to
llama-server's MISTRAL template. This stack runs Qwen3.8's own template under
``--jinja``, which renders a tool result as its own turn and has no alternation
constraint — verified directly against the live server's ``/apply-template``,
which renders ``[system, user, assistant(tool_calls), tool, user]`` correctly and
without complaint.

THE FIX: merge only messages that are TRULY ADJACENT in the outgoing list. The
cross-tool case becomes opt-in through ``FORGE_MERGE_ACROSS_TOOLS=1``, which
restores the upstream behaviour exactly for anyone whose backend template does
need it. Nothing else about the function changes, including the list-content
merge that patches/forge_merge_consecutive.py fixes — the two patches touch
different lines of the same function and this one is applied second.

WHAT TO WATCH IF YOU EVER SWITCH BACKENDS: a template that DOES count visible
alternation will start returning 500 on the first user-after-tool-result turn.
That is what the flag is for, and it is why the default lives in .env rather
than being hardcoded here.

See context/design/forge-on-the-tool-call-path.md §4 for the measurement.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "patches/forge_merge_across_tools.py"
CLIENT_REL = "forge/clients/llamafile.py"

IMPORT_OLD = """import json
import logging
import re
"""

IMPORT_NEW = """import json
import logging
import os
import re
"""

FLAG = '''

# patches/forge_merge_across_tools.py — see that file. Merging two same-role
# messages that are separated by a tool-call/tool-result pair is a workaround
# for llama-server's MISTRAL template parity checker; on a template that does
# not need it (Qwen3.8's, which this stack runs) it rewrites an early message
# every turn and pins the KV prefix cache. Off by default; set to 1 to restore
# the upstream behaviour.
_FORGE_MERGE_ACROSS_TOOLS = os.environ.get(
    "FORGE_MERGE_ACROSS_TOOLS", ""
).strip().lower() in ("1", "true", "yes", "on")
'''

FLAG_ANCHOR = "def _merge_consecutive(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:"

MERGE_OLD = """            if last_visible_idx is not None and result[last_visible_idx].get("role") == role:
                # Same role at consecutive visible positions — merge
                target = result[last_visible_idx]
"""

MERGE_NEW = """            # patches/forge_merge_across_tools.py: `adjacent` is the case every
            # template needs (a retry nudge straight after user input). The
            # other one — same role either side of a tool-call/tool-result pair
            # — is the Mistral parity workaround, and it is what rewrites the
            # prompt prefix on every agentic turn.
            adjacent = last_visible_idx == len(result) - 1
            if (
                last_visible_idx is not None
                and result[last_visible_idx].get("role") == role
                and (adjacent or _FORGE_MERGE_ACROSS_TOOLS)
            ):
                # Same role at consecutive visible positions — merge
                target = result[last_visible_idx]
"""


def fail(msg: str) -> None:
    print(f"forge_merge_across_tools: {msg}", file=sys.stderr)
    raise SystemExit(1)


def replace_once(source: str, old: str, new: str, what: str) -> str:
    count = source.count(old)
    if count != 1:
        fail(
            f"expected exactly 1 occurrence of the {what} block in {CLIENT_REL}, "
            f"found {count}. forge changed it — re-read the file before shipping this."
        )
    return source.replace(old, new, 1)


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_merge_across_tools.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")
    path = root / CLIENT_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")
    source = path.read_text()
    if MARKER in source:
        print(f"forge_merge_across_tools: {CLIENT_REL} already patched")
        return 0

    if "\nimport os\n" not in source:
        source = replace_once(source, IMPORT_OLD, IMPORT_NEW, "import")
    if source.count(FLAG_ANCHOR) != 1:
        fail(f"_merge_consecutive not found exactly once in {CLIENT_REL}")
    source = source.replace(FLAG_ANCHOR, FLAG.lstrip("\n") + "\n\n" + FLAG_ANCHOR, 1)
    source = replace_once(source, MERGE_OLD, MERGE_NEW, "merge decision")

    path.write_text(source)
    print(f"forge_merge_across_tools: patched {CLIENT_REL} (adjacent-only merge, flag-gated)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
