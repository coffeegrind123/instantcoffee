#!/usr/bin/env python3
"""Count tool calls the model stranded inside its reasoning (Strata #804/#1058).

THE FAILURE (context/HANDOFF.md part 17 §3a item 1). The model writes a real
`<tool_call>` inside `<think>`. llama-server splits `reasoning_content` off the
content first, so the markup sits in the reasoning where nothing parses it, the
turn comes back with no `tool_calls`, and the agent sees an empty or call-less
answer. This reads a capture tape (scripts/capture.sh / capture_proxy.py JSONL)
and counts, per the Strata rules, how often a RECOVERABLE call was lost that
way. That count is the evidence a forge patch would need; zero on a big real
tape is the evidence it would not.

THE RULES, from Strata serve/test_reasoning_rescue.py (HANDOFF §3a):
  - Recover only a call whose tool NAME was declared in the request. An
    undeclared name stays text — counted here in its own bucket, never silently.
  - A `<tool_call>` inside a fenced ``` block or an inline `code` span stays
    text: the model is quoting, not calling.
  - A length-cut response (finish_reason == "length") stays text: its wrapper
    may be truncated, so it is not a clean call.
  - It is STRANDED only when the response's real `tool_calls` is empty. If the
    call also came back as a proper tool_call, nothing was lost.

This measures; it does not change forge. It is deliberately strict about what
counts as stranded so a reported hit is a real lost call, not a quoted example.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

OPEN = "<tool_call>"
CLOSE = "</tool_call>"
# A declared name inside the wrapper. json.loads is tried first; this is the
# fallback for a wrapper the model left not-quite-valid.
NAME_RE = re.compile(r'"name"\s*:\s*"([^"]+)"')


def code_spans(text):
    """(start, end) byte ranges covered by a ``` fence or an inline `code` span.

    Fences win over inline backticks: inside an open fence, a lone backtick is
    body, not an inline span. A fence that never closes runs to end of text,
    which is what we want — an unterminated code block keeps swallowing.
    """
    spans = []
    i = 0
    n = len(text)
    while i < n:
        if text.startswith("```", i):
            end = text.find("```", i + 3)
            end = n if end == -1 else end + 3
            spans.append((i, end))
            i = end
            continue
        if text[i] == "`":
            end = text.find("`", i + 1)
            end = n if end == -1 else end + 1
            spans.append((i, end))
            i = end
            continue
        i += 1
    return spans


def in_any_span(pos, spans):
    for a, b in spans:
        if a <= pos < b:
            return True
    return False


def declared_names(request):
    """Tool names the request declared. request.tools[].function.name, with a
    fallback to a bare name, tolerant of a nested body."""
    if not isinstance(request, dict):
        return set()
    body = request.get("body") if isinstance(request.get("body"), dict) else request
    tools = body.get("tools")
    names = set()
    if isinstance(tools, list):
        for t in tools:
            if not isinstance(t, dict):
                continue
            fn = t.get("function") if isinstance(t.get("function"), dict) else t
            name = fn.get("name")
            if isinstance(name, str) and name:
                names.add(name)
    return names


def call_name(wrapper_inner):
    """The tool name inside one <tool_call>…</tool_call> body, or None."""
    try:
        obj = json.loads(wrapper_inner)
        if isinstance(obj, dict) and isinstance(obj.get("name"), str):
            return obj["name"]
    except (ValueError, TypeError):
        pass
    m = NAME_RE.search(wrapper_inner)
    return m.group(1) if m else None


def scan_reasoning(rc, declared):
    """Every <tool_call> opener in the reasoning text, classified.

    Returns a list of dicts: {name, fenced, declared}. The opener position is
    what the fence test keys on; a wrapper opened inside a fence is quoted.
    """
    hits = []
    spans = code_spans(rc)
    start = 0
    while True:
        o = rc.find(OPEN, start)
        if o == -1:
            break
        c = rc.find(CLOSE, o + len(OPEN))
        inner = rc[o + len(OPEN): (c if c != -1 else len(rc))]
        name = call_name(inner)
        hits.append({
            "name": name,
            "fenced": in_any_span(o, spans),
            "declared": name in declared if name else False,
        })
        start = (c + len(CLOSE)) if c != -1 else (o + len(OPEN))
    return hits


def classify(record):
    """Classify one completion record. Returns None for non-completions, else a
    dict with the verdict and the reason it fell where it did."""
    if record.get("kind") != "completion":
        return None
    resp = record.get("response") or {}
    rc = resp.get("reasoning_content") or ""
    tool_calls = resp.get("tool_calls") or []
    finish = resp.get("finish_reason")
    declared = declared_names(record.get("request") or {})

    hits = scan_reasoning(rc, declared)
    out = {
        "capture_id": record.get("capture_id"),
        "seq": record.get("seq"),
        "has_reasoning": bool(rc),
        "markup_hits": len(hits),
        "finish_reason": finish,
        "had_real_tool_calls": bool(tool_calls),
        "stranded": [],      # recoverable: declared, not fenced, not length, no real call
        "undeclared": [],    # markup present, name not declared -> stays text, logged
        "fenced": 0,         # markup inside a code span -> quoted
        "length_cut": 0,     # finish_reason length -> truncated wrapper
    }
    for h in hits:
        if h["fenced"]:
            out["fenced"] += 1
            continue
        if finish == "length":
            out["length_cut"] += 1
            continue
        if not h["declared"]:
            out["undeclared"].append(h["name"])
            continue
        if tool_calls:
            # The call also came back properly; nothing was lost.
            continue
        out["stranded"].append(h["name"])
    return out


def run(paths):
    totals = {
        "completions": 0, "with_reasoning": 0, "with_markup": 0,
        "stranded": 0, "undeclared": 0, "fenced": 0, "length_cut": 0,
    }
    stranded_rows = []
    undeclared_rows = []
    for path in paths:
        fh = sys.stdin if path == "-" else open(path, encoding="utf-8")
        try:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                c = classify(record)
                if c is None:
                    continue
                totals["completions"] += 1
                if c["has_reasoning"]:
                    totals["with_reasoning"] += 1
                if c["markup_hits"]:
                    totals["with_markup"] += 1
                totals["fenced"] += c["fenced"]
                totals["length_cut"] += c["length_cut"]
                totals["undeclared"] += len(c["undeclared"])
                totals["stranded"] += len(c["stranded"])
                for name in c["stranded"]:
                    stranded_rows.append((path, c["capture_id"], c["seq"], name))
                for name in c["undeclared"]:
                    undeclared_rows.append((path, c["capture_id"], c["seq"], name))
        finally:
            if fh is not sys.stdin:
                fh.close()
    return totals, stranded_rows, undeclared_rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("tape", nargs="+", help="capture tape JSONL path(s), or - for stdin")
    ap.add_argument("--json", action="store_true", help="emit the totals as JSON")
    args = ap.parse_args(argv)

    totals, stranded, undeclared = run(args.tape)
    if args.json:
        print(json.dumps(totals))
        return 0

    print(f"completions        {totals['completions']}")
    print(f"  with reasoning   {totals['with_reasoning']}")
    print(f"  with <tool_call> {totals['with_markup']}")
    print(f"STRANDED (recoverable, lost): {totals['stranded']}")
    print(f"  undeclared name (stays text, logged): {totals['undeclared']}")
    print(f"  fenced/quoted (correctly text):       {totals['fenced']}")
    print(f"  length-cut (truncated wrapper):       {totals['length_cut']}")
    if stranded:
        print("\nSTRANDED calls:")
        for path, cid, seq, name in stranded:
            print(f"  {cid} seq={seq} name={name}")
    if undeclared:
        print("\nUndeclared calls in reasoning (Strata keeps as text, but logs):")
        for path, cid, seq, name in undeclared:
            print(f"  {cid} seq={seq} name={name}")
    # The reasoning text carries no tool-call markup on any completion: either
    # nothing is stranded, or the tape has no reasoning to look in. Say which.
    if totals["with_markup"] == 0 and totals["with_reasoning"] == 0:
        print("\nNOTE: no reasoning text on any completion — this tape cannot answer the"
              " question. Capture a session that keeps reasoning_content.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
