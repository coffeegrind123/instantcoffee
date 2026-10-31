#!/usr/bin/env python3
"""Timestamp a `pi --mode json` event stream: seconds since T0 for each event.

    t0=$(date +%s.%N); pi --mode json -p '...' </dev/null | python3 event_timeline.py "$t0"

Shows where a run's time goes (the gap before `session` is extension load). The
`</dev/null` is not optional: `pi -p` with a non-TTY stdin waits for EOF.
"""
import json
import sys
import time

t0 = float(sys.argv[1])
for line in sys.stdin:
    t = time.time() - t0
    try:
        d = json.loads(line)
        label = d.get("type", "?") + " " + str((d.get("message") or {}).get("role", ""))
    except ValueError:
        label = line[:100].rstrip()
    print(f"{t:6.1f} {label}", flush=True)
print(f"{time.time() - t0:6.1f} EOF", flush=True)
