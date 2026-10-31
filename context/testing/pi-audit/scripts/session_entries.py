#!/usr/bin/env python3
"""Count every entry of the newest pi session file by (type, customType).

    python3 session_entries.py [sessions dir]     # default ~/.pi/agent/sessions

Count ALL entry types: a loop iteration is a `custom_message` entry, not a
`message` or a `custom` one, and a reader that skips a type reports a clean
zero for something it cannot see. The /loop check (L1) expects 0
`('custom_message', 'loop-rules')` on loop-driven runs; with the fix reverted
the same 2-iteration loop wrote 1.
"""
import collections
import glob
import json
import os
import sys

root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.pi/agent/sessions")
files = sorted(glob.glob(root + "/**/*.jsonl", recursive=True), key=os.path.getmtime)
if not files:
    sys.exit(f"no session files under {root}")
counts = collections.Counter()
with open(files[-1], encoding="utf-8") as fh:
    for line in fh:
        e = json.loads(line)
        custom = e.get("customType") or (e.get("message") or {}).get("customType")
        counts[(e.get("type"), custom)] += 1
print(os.path.basename(files[-1]))
for key, n in sorted(counts.items(), key=str):
    print(n, key)
