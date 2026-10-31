#!/usr/bin/env python3
"""Has the newest pi session's turn finished, and what did it call?

    python3 turn_state.py [sessions dir]          # one JSON line

`done` is true when the last message is an assistant reply with a final stop
reason. Polled from outside a TUI session (docker exec ... python3 turn_state.py)
to know when a typed prompt has been answered.
"""
import glob
import json
import os
import sys

FINAL = ("stop", "end_turn", "length", "error", "aborted")
root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.pi/agent/sessions")
files = sorted(glob.glob(root + "/**/*.jsonl", recursive=True), key=os.path.getmtime)
if not files:
    print(json.dumps({"file": None, "done": False}))
    sys.exit()
msgs = []
with open(files[-1], encoding="utf-8") as fh:
    for line in fh:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "message":
            msgs.append(e["message"])
last = msgs[-1] if msgs else {}
tools = [b.get("name") for m in msgs if m.get("role") == "assistant" for b in m.get("content", []) if b.get("type") == "toolCall"]
text = " ".join(b.get("text", "") for b in last.get("content", []) if b.get("type") == "text")[-300:]
print(json.dumps({
    "file": os.path.basename(files[-1]),
    "done": last.get("role") == "assistant" and last.get("stopReason") in FINAL,
    "stop": last.get("stopReason"),
    "messages": len(msgs),
    "tools": tools,
    "last": text,
}))
