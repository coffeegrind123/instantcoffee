#!/usr/bin/env python3
"""Teach the bundled Ovis server about this stack's pi sessions.

    python3 scripts/ovis_patch.py [OVIS_DIR]        (default /opt/ovis)

Prints `changed` when it wrote anything (the server must restart to load it),
`unchanged` when everything was already in place. Exits 2, changing nothing,
when the bundle or a file is not the one these edits were written against.

What it does, for .pi/extensions/ovis-bridge.ts (measured 2026-11-01):

  server/pi-native-catalog*.ts  NEW. A pi provider for Ovis's native-catalog
                                seam (server/catalog-sources.ts): the pane's
                                live command list from the bridge's file.
  server/index.ts               imports it, so it registers.
  server/pi-entry-notices.ts    NEW. This stack's pi entries that pi draws
                                with a custom renderer (/stack reports, subagent
                                transcripts, notify() saved by the bridge, ...).
  server/transcript-records.ts  piNotice shows them as chat notices.
  server/pi.ts                  serves the bridge's preview of a session pi
                                has not written yet (it writes nothing before
                                the first message), so a command run first shows.
  server/outcome.ts             counts those entries as a pi command's result,
                                so a command run from the chat is not left at
                                "No result seen".
  server/dialogs/live.ts        allows pi's footer the extension-status line,
                                or no pi dialog shows as a card while a status
                                (the /loop pill, ...) is set.
  server/workspace-routes.ts    a new workspace, or a tab with an agent, is a
                                plain pane (OVIS_PANE_PLAIN), so the picker
                                decides; a bare + tab opens on pi.
  dist/index.html               loads instantcoffee-defaults.js: the picker
                                defaults to pi until this browser chose.
  server/conversation-metadata.ts
                                the bridge's "ovis-meta" effort outranks the
                                `thinkingLevel: "off"` pi records for a model
                                configured with `reasoning: false`.

Applied at every `ovis.sh start` from the checkout, so a git pull updates it
without an image rebuild. Each edited file is pinned to the sha256 of the
bundle's original: an Ovis upgrade that changes one is refused here, loudly,
rather than half-patched. Re-pin these hashes when OVIS_BUNDLE_TAG moves.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys

BUNDLE_VERSION = "40"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATCH_DIR = os.path.join(REPO, "vendor", "ovis-patches")
# (file in vendor/ovis-patches, where it goes in the bundle)
NEW_FILES = (
    ("pi-native-catalog.ts", "server/pi-native-catalog.ts"),
    ("pi-native-catalog-rows.ts", "server/pi-native-catalog-rows.ts"),
    ("pi-entry-notices.ts", "server/pi-entry-notices.ts"),
    ("instantcoffee-defaults.js", "dist/instantcoffee-defaults.js"),
)
MARK = "instantcoffee:"
EXIT_REFUSED = 2
# Touched whenever anything here changed: ovis.sh restarts a server older than it.
STAMP = ".instantcoffee-patched"

EDITS: list[tuple[str, str, list[tuple[str, str]]]] = [
    (
        "server/index.ts",
        "9261e2f446db225de84c048ec25646d1f2383f6f92f71b9fc0f242359cf71d03",
        [(
            'import { holdOpenCodeNative } from "./opencode-native.ts";\n',
            'import { holdOpenCodeNative } from "./opencode-native.ts";\n'
            '// instantcoffee: pi\'s live command list (vendor/ovis-patches)\n'
            'import "./pi-native-catalog.ts";\n',
        )],
    ),
    (
        "server/transcript-records.ts",
        "ac04732fcf4138038fc9762e655029e48c4f335e9481d8387b91be7daae989ed",
        [
            (
                'import { trimOutput } from "./tool-output.ts";\n',
                'import { trimOutput } from "./tool-output.ts";\n'
                '// instantcoffee: this stack\'s pi entries as chat notices (vendor/ovis-patches)\n'
                'import { piEntryNotice } from "./pi-entry-notices.ts";\n',
            ),
            (
                '  const entry = record(value);\n'
                '  if (entry.type !== "custom_message" || entry.display === false',
                '  const entry = record(value);\n'
                '  // instantcoffee: /stack reports, subagent transcripts, notify() and the like\n'
                '  const ours = piEntryNotice(entry);\n'
                '  if (ours !== undefined) return ours;\n'
                '  if (entry.type !== "custom_message" || entry.display === false',
            ),
        ],
    ),
    (
        "server/pi.ts",
        "942a935cfba18ff76b4ac0ce64dc4c14bdc626f64f3ee25d7e7fd481ddfa7373",
        [
            (
                'import { readFileSync, realpathSync } from "node:fs";\n',
                '// instantcoffee: existsSync for the unwritten-session preview (vendor/ovis-patches)\n'
                'import { existsSync, readFileSync, realpathSync } from "node:fs";\n',
            ),
            (
                '  const unwritten = unwrittenSession(session.value, matches[0]!);\n'
                '  return unwritten === null ? null : { unwritten };\n',
                '  const unwritten = unwrittenSession(session.value, matches[0]!);\n'
                '  // instantcoffee: pi writes no session file before its first message, so a command run first\n'
                '  // (/stack, /persona, ...) lived in memory only; ovis-bridge keeps a preview of it until then\n'
                '  const preview = unwritten === null ? null : join(process.env.OVIS_PI_PREVIEW_DIR || "/tmp/ovis/preview", basename(unwritten.path));\n'
                '  if (preview !== null && existsSync(preview)) return { path: preview, agentDir };\n'
                '  return unwritten === null ? null : { unwritten };\n',
            ),
        ],
    ),
    (
        "server/outcome.ts",
        "13c0f0975725f22756df9428bcd98536838107076b5a8ff6029fec00f00b0962",
        [
            (
                'import { ANSI_RE, cleanLine, type DialogReader, type ParsedPrompt } from "./dialogs/shared.ts";\n',
                'import { ANSI_RE, cleanLine, type DialogReader, type ParsedPrompt } from "./dialogs/shared.ts";\n'
                '// instantcoffee: this stack\'s pi report entries count as a command\'s result (vendor/ovis-patches)\n'
                'import { NOTICE_TYPES } from "./pi-entry-notices.ts";\n',
            ),
            (
                '        || (entry.type === "custom" && entry.customType === "context_clear")) {\n',
                '        || (entry.type === "custom" && entry.customType === "context_clear")\n'
                '        // instantcoffee: /stack reports, notify() saved by ovis-bridge, ...\n'
                '        || (entry.type === "custom" && NOTICE_TYPES.includes(String(entry.customType)))) {\n',
            ),
            (
                '    if (["pi", "omp", "gjc", "omo"].includes(sent.agent) && PI_EVIDENCE_TYPES.has(String(entry.type))) {\n',
                '    // instantcoffee: a pi command\'s report (an entry this stack draws with a renderer) written after\n'
                '    // the send and before the next one; pi marks no command start, so the window is the binding\n'
                '    if (sent.agent === "pi" && entry.type === "custom" && NOTICE_TYPES.includes(String(entry.customType))) return evidence;\n'
                '    if (["pi", "omp", "gjc", "omo"].includes(sent.agent) && PI_EVIDENCE_TYPES.has(String(entry.type))) {\n',
            ),
        ],
    ),
    (
        "server/dialogs/live.ts",
        "7d88df6d6399da477941dc441fad5d90d567fab75523a555ba66a5603dca84b5",
        [(
            'const PI_FOOTER_LINES = 2;\n',
            '// instantcoffee: plus the line of extension statuses pi draws under them (setStatus, which this\n'
            '// stack uses), wrapped to two on a phone. At 2, every pi dialog in a pane with a status set was\n'
            '// refused as stale: /persona\'s select never became a card (2026-11-01).\n'
            'const PI_FOOTER_LINES = 4;\n',
        )],
    ),
    (
        "server/workspace-routes.ts",
        "e99735d862bf394d1b436268ecf7525818152cd5841ac89ba795424fe734c652",
        [(
            '        ...(typeof payload.label === "string" ? { label: payload.label } : {}),\n',
            '        ...(typeof payload.label === "string" ? { label: payload.label } : {}),\n'
            '        // instantcoffee: where an agent was picked (the New workspace dialog, a tab with an agent),\n'
            '        // the pane is plain and the pick decides: Shell is a shell, pi is started below by agent.start.\n'
            '        // A bare new tab (the + button) keeps scripts/ovis-shims/pane-shell: pi, then bash on quit.\n'
            '        ...(inWorkspace && !payload.agent ? {} : { env: { OVIS_PANE_PLAIN: "1" } }),\n',
        )],
    ),
    (
        "dist/index.html",
        "31220cd3ace10ea556b085bedfe1fa529f272e05a70e48add5d4cacbba4295e6",
        [(
            '    <meta charset="UTF-8" />\n',
            '    <meta charset="UTF-8" />\n'
            '    <!-- instantcoffee: the New workspace / New tab picker defaults to pi (vendor/ovis-patches) -->\n'
            '    <script src="/instantcoffee-defaults.js"></script>\n',
        )],
    ),
    (
        "server/conversation-metadata.ts",
        "b99ad91363d3f4277be00f3b62845b53e3c07500ba3e2114ea14884b562898a3",
        [(
            '      if (entry.type === "thinking_level_change") metadata.reasoning_effort = label(entry.thinkingLevel);\n',
            '      // instantcoffee: the stack\'s effort (ovis-bridge "ovis-meta") outranks the "off" pi records\n'
            '      if (entry.type === "custom" && entry.customType === "ovis-meta" && label(record(entry.data).reasoningEffort)) {\n'
            '        metadata.reasoning_effort = label(record(entry.data).reasoningEffort);\n'
            '        (metadata as ConversationMetadata & { effort_source?: string }).effort_source = "stack";\n'
            '      }\n'
            '      if (entry.type === "thinking_level_change" && (metadata as { effort_source?: string }).effort_source !== "stack") '
            'metadata.reasoning_effort = label(entry.thinkingLevel);\n',
        )],
    ),
]


class Refused(Exception):
    pass


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write(path: str, text: str) -> None:
    tmp = f"{path}.instantcoffee.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    shutil.copymode(path, tmp) if os.path.exists(path) else None
    os.replace(tmp, path)


def base_text(path: str, rel: str, original: str, edits: list[tuple[str, str]]) -> str | None:
    """What to patch: the file itself, or its .orig when it carries an older
    version of these edits. None when it is already current."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if all(new in text for _, new in edits):
        return None
    if sha256(text) == original:
        return text
    backup = f"{path}.orig"
    if MARK in text and os.path.exists(backup):
        with open(backup, encoding="utf-8") as fh:
            saved = fh.read()
        if sha256(saved) == original:
            return saved
    raise Refused(f"{rel} is neither the bundle's original nor patched by us (sha256 {sha256(text)[:12]})")


def patch_file(ovis: str, rel: str, original: str, edits: list[tuple[str, str]]) -> bool:
    path = os.path.join(ovis, rel)
    text = base_text(path, rel, original, edits)
    if text is None:
        return False
    for old, new in edits:
        if text.count(old) != 1:
            raise Refused(f"{rel}: anchor found {text.count(old)} times: {old[:60]!r}")
        text = text.replace(old, new)
    backup = f"{path}.orig"
    if not os.path.exists(backup):
        shutil.copy2(path, backup)
    write(path, text)
    return True


def copy_new(ovis: str, name: str, rel: str) -> bool:
    src = os.path.join(PATCH_DIR, name)
    dst = os.path.join(ovis, rel)
    with open(src, encoding="utf-8") as fh:
        want = fh.read()
    if os.path.exists(dst):
        with open(dst, encoding="utf-8") as fh:
            if fh.read() == want:
                return False
    with open(dst + ".instantcoffee.tmp", "w", encoding="utf-8") as fh:
        fh.write(want)
    os.replace(dst + ".instantcoffee.tmp", dst)
    return True


def apply(ovis: str) -> bool:
    try:
        with open(os.path.join(ovis, "bundle.json"), encoding="utf-8") as fh:
            version = str(json.load(fh).get("version"))
    except (OSError, ValueError) as exc:
        raise Refused(f"no readable bundle.json in {ovis}: {exc}") from exc
    if version != BUNDLE_VERSION:
        raise Refused(f"Ovis bundle {version}, these edits are for {BUNDLE_VERSION}")
    # Check every file before writing any, so a refusal changes nothing.
    for rel, original, edits in EDITS:
        base_text(os.path.join(ovis, rel), rel, original, edits)
    changed = False
    for name, rel in NEW_FILES:
        changed |= copy_new(ovis, name, rel)
    for rel, original, edits in EDITS:
        changed |= patch_file(ovis, rel, original, edits)
    stamp = os.path.join(ovis, STAMP)
    if changed or not os.path.exists(stamp):
        with open(stamp, "w", encoding="utf-8") as fh:
            fh.write("patched by scripts/ovis_patch.py\n")
    return changed


def main(argv: list[str]) -> int:
    ovis = argv[1] if len(argv) > 1 else "/opt/ovis"
    try:
        print("changed" if apply(ovis) else "unchanged")
    except Refused as exc:
        print(f"ovis_patch: refused: {exc}", file=sys.stderr)
        return EXIT_REFUSED
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
