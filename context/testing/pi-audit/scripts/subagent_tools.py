#!/usr/bin/env python3
"""What a subagent child actually called, from the newest session's transcript.

    python3 subagent_tools.py [sessions dir]

A parent's --mode json stream does not show a child's tool calls; the
`subagent-turn` entries pi-subagents-lite writes into the parent session do.
They record result SIZES, not content, so fencing of a child's results cannot
be read from here.
"""
import glob
import json
import os
import sys

root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.pi/agent/sessions")
files = sorted(glob.glob(root + "/**/*.jsonl", recursive=True), key=os.path.getmtime)
if not files:
    sys.exit(f"no session files under {root}")
with open(files[-1], encoding="utf-8") as fh:
    for line in fh:
        e = json.loads(line)
        if e.get("type") == "custom" and e.get("customType") == "subagent-turn":
            for entry in e["data"].get("lines", []):
                if "[TOOL]" in entry or "[TOOL_RESULT]" in entry:
                    print(entry[25:220].replace("\n", " "))
        m = e.get("message") or {}
        if e.get("type") == "message" and m.get("role") == "toolResult" and m.get("toolName") == "Agent":
            print("AGENT RESULT:", " ".join(b.get("text", "") for b in m.get("content", []))[:400])
