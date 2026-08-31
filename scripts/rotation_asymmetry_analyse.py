#!/usr/bin/env python3
"""Re-analyse the n_ctx-8192 rotation asymmetry from existing depth runs. No GPU.

context/OPEN-WORK.md section 3 records an unexplained result: at n_ctx 8192 the
F=4096 rotation has a median delta-NLL of 2.597 against F=0's 0.365, and there
is "no structural difference to point at". This script re-derives that number
from result.json and then runs the two tests the original analysis could not,
because both need the depth-2048 series as a control:

  1. IS IT SPAN SELECTION? At depth 8192 each span in the span map is fed by
     exactly ONE rotation, so "rotation 4096 is worse" and "the spans rotation
     4096 happens to cover are harder" are confounded by construction. Depth
     2048 is rotation-BALANCED (each span fed by 0,0,1024,1024), so it measures
     a span's intrinsic difficulty free of the rotation question. Comparing the
     AMPLIFICATION log(ppl@8192 / ppl@2048) controls for it.

     Answer (20260824T142049Z): no. Rotation-4096 spans are EASIER at depth 2048
     (median ppl 8.31 vs 13.66) and still amplify 13.4x against 1.4x. The
     control points the opposite way, so the asymmetry is not span selection.

  2. IS IT A DOSE-RESPONSE? The run 20260824T114717Z carries FOUR rotations at
     n_ctx 8192 (F=0, 2048, 4096, 6144) rather than two. A chunk boundary lands
     at corpus index = -F (mod 8192), so each rotation sits at a known circular
     distance from the F=0 alignment. If the effect were an oddity of one arm,
     the four would not order.

     Answer: they order perfectly, and the two rotations at EQUAL distance agree
     (36.58 and 48.98) while the extremes differ 15x (14.77 -> 227.67). That
     turns a binary asymmetry into a monotone dose-response in chunk-boundary
     offset, which is a far stronger constraint on any mechanism.

WHAT THIS RULES OUT, so nobody re-walks it:

  - Span selection / coverage. Test 1 above, and the control runs the wrong way.
  - The document junction. deep-plus-pi.txt is deep-s26b5bb + "\\n\\n" +
    pi-150turn, ONE junction at ~65-73k tokens (its README). The four-rotation
    run windows [8192, 65536], which ends at or before that junction, so its
    monotone ordering is produced with no junction inside the scored range.
  - Corpus difficulty alternating at an 8192 period. Already refuted upstream by
    the rotation-balanced 2048/4096 series; test 1 re-confirms it from the other
    direction.

WHAT IS STILL OPEN: the mechanism. What differs between rotations is where each
scored token's HISTORY begins -- F=0's chunks start at corpus indices congruent
to 0 (mod 8192), F=4096's at 4096. Both give a scored token the same COUNT of
real history (4097..8191 tokens). Section 2's standing hypothesis is that the
misfire rate is set by what the history CONTAINS rather than how much of it
there is; a dose-response in boundary offset is the shape that hypothesis
predicts, and is the reason to test it next.

Usage:
  python3 scripts/rotation_asymmetry_analyse.py
  python3 scripts/rotation_asymmetry_analyse.py --run .ppl-depth-logs/<stamp>
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import random
import statistics
import sys

PERMS = 200000


def _spans(doc):
    """-> [(span_start, rotation, ppl8192, ppl2048, log_amplification)]"""
    out = []
    for e in doc.get("span_map", []):
        b8 = e.get("by_depth", {}).get("8192")
        b2 = e.get("by_depth", {}).get("2048")
        if not b8 or not b2 or not b8.get("rotations"):
            continue
        if b8["ppl"] <= 0 or b2["ppl"] <= 0:
            continue
        out.append((e["span"][0], b8["rotations"][0], b8["ppl"], b2["ppl"],
                    math.log(b8["ppl"] / b2["ppl"])))
    return out


def _perm_p(a, b, stat, n=PERMS, seed=20260831):
    rng = random.Random(seed)
    obs = abs(stat(a) - stat(b))
    pool = list(a) + list(b)
    k = len(a)
    hits = 0
    for _ in range(n):
        rng.shuffle(pool)
        if abs(stat(pool[:k]) - stat(pool[k:])) >= obs - 1e-12:
            hits += 1
    return hits / n


def test_span_selection(doc, label):
    rows = _spans(doc)
    rots = sorted({r[1] for r in rows})
    if len(rots) != 2 or len(rows) < 6:
        return False
    print("\n=== %s: is the asymmetry span SELECTION? ===" % label)
    print("  depth 2048 is rotation-balanced, so it measures intrinsic difficulty.")
    print("  %-10s %4s %14s %14s %16s" % ("rotation", "n", "med ppl@2048", "med ppl@8192", "med log-amp"))
    for rot in rots:
        v = [r for r in rows if r[1] == rot]
        print("  %-10s %4d %14.2f %14.2f %16.3f" % (
            rot, len(v),
            statistics.median([x[3] for x in v]),
            statistics.median([x[2] for x in v]),
            statistics.median([x[4] for x in v])))
    a = [r[4] for r in rows if r[1] == rots[0]]
    b = [r[4] for r in rows if r[1] == rots[1]]
    p_med = _perm_p(a, b, statistics.median)
    p_mean = _perm_p(a, b, statistics.mean)
    print("  permutation on log-amplification: p(median)=%.4f  p(mean)=%.4f" % (p_med, p_mean))
    print("  (the mean is hostage to a single 4.3e6 span; prefer the median)")
    easier = statistics.median([r[3] for r in rows if r[1] == rots[1]]) < \
             statistics.median([r[3] for r in rows if r[1] == rots[0]])
    print("  VERDICT: the high-amplification rotation's spans are %s at depth 2048,"
          % ("EASIER" if easier else "harder"))
    print("           so span selection %s explain it." %
          ("does NOT" if easier else "may"))
    return True


def test_dose_response(doc, label):
    arms = [a for a in doc.get("arms", []) if a.get("n_ctx") == 8192]
    if not arms:
        return False
    passes = arms[0].get("passes", [])
    if len(passes) < 3:
        return False
    print("\n=== %s: dose-response across %d rotations at n_ctx 8192 ===" % (label, len(passes)))
    n = 8192
    rows = []
    for p in passes:
        f = p["filler"]
        start = (-f) % n                      # corpus index where a chunk begins
        dist = min(start, n - start)          # circular distance from the F=0 alignment
        rows.append((f, start, dist, p["ppl"], p.get("kept")))
    print("  %-8s %-16s %-12s %10s  %s" % ("filler", "chunk start", "distance", "ppl", "kept"))
    for f, s, dist, ppl, kept in rows:
        print("  %-8d %-16d %-12d %10.2f  %s" % (f, s, dist, ppl, kept))
    ordered = sorted(rows, key=lambda r: r[2])
    mono = all(ordered[i][3] <= ordered[i + 1][3] for i in range(len(ordered) - 1))
    print("  ordered by distance: %s" % " -> ".join("%.1f" % r[3] for r in ordered))
    print("  MONOTONE in boundary offset: %s" % ("YES" if mono else "no"))
    ties = {}
    for f, s, dist, ppl, _k in rows:
        ties.setdefault(dist, []).append(ppl)
    for dist, v in sorted(ties.items()):
        if len(v) > 1:
            print("  equal-distance pair at %d: %s (ratio %.2f) — these SHOULD agree"
                  % (dist, ", ".join("%.2f" % x for x in v), max(v) / min(v)))
    # A kept-range that differs means the arm is not comparable; say so loudly.
    kepts = {tuple(r[4]) for r in rows if r[4]}
    if len(kepts) > 1:
        print("  NOTE: kept ranges differ across these passes %s — the arm with a" % sorted(kepts))
        print("        different kept range scores a different token count and is not")
        print("        strictly comparable; read its ppl with that in mind.")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", default=None, help="a .ppl-depth-logs/<stamp> directory")
    args = ap.parse_args()

    runs = ([args.run] if args.run
            else sorted(glob.glob(".ppl-depth-logs/*/")))
    if not runs:
        sys.exit("no depth runs found under .ppl-depth-logs/")

    did_any = False
    for r in runs:
        path = os.path.join(r, "result.json")
        if not os.path.exists(path):
            continue
        doc = json.load(open(path))
        label = os.path.basename(os.path.normpath(r))
        did_any |= test_span_selection(doc, label)
        did_any |= test_dose_response(doc, label)
    if not did_any:
        sys.exit("no run carried both a span_map and an 8192 arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
