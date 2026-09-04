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


def run_weights(result_path):
    """The weights that produced a run, read from its run.meta.

    EVERY NUMBER THIS SCRIPT PRINTS CARRIES ITS WEIGHTS, and that is not
    decoration. OPEN-WORK section 2 retracted a whole depth measurement on
    2026-09-03 because its four pairs straddled the `unsloth`/UD-Q4_K_XL ->
    `orcarouter`/Q4_K_M change, and section 3's four-rotation table repeated the
    same mistake in the section below it -- two rows from each model, unnoticed
    until 2026-09-04. run.meta was backfilled across every run directory for
    exactly this; a run that cannot say which weights produced it will
    eventually be compared with one that used different ones.

    Returns the GGUF file name, or None when the directory predates the stamp.
    """
    return run_meta(result_path).get("GGUF_FILE")


def run_meta(result_path):
    """A run directory's run.meta as a dict; empty when it predates the stamp."""
    meta = os.path.join(os.path.dirname(result_path), "run.meta")
    out = {}
    try:
        with open(meta) as fh:
            for line in fh:
                key, sep, val = line.partition("=")
                if sep:
                    out[key.strip()] = val.strip()
    except OSError:
        pass
    return out


def short_weights(result_path):
    """A column-width tag for the weights: 'UD-Q4_K_XL', 'Uncensored-Q4_K_M'."""
    g = run_weights(result_path)
    if not g:
        return "UNSTAMPED"
    return g.replace("Qwen3.8-27B-", "").replace(".gguf", "")


# The 2026-08-24 run, region-matched (see the docstring below) but on the OLD
# weights. Kept because it is the run section 3 was written from.
CLIFF_OLD = [".ppl-cliff-logs/20260824T164959Z/result.json"]
# The same two offsets on the CURRENT weights: section 2's prescribed
# re-measurement, `--chunk 8192:4096:2` and `--chunk 8192:8192:1`. Two
# directories because they were run an hour apart, same stack, same corpus.
CLIFF_CURRENT = [".ppl-cliff-logs/20260903T094414Z/result.json",
                 ".ppl-cliff-logs/20260903T100705Z/result.json"]


def cliff_cross_check(paths=None, title="2026-08-24 run, OLD weights"):
    """The same offset effect, on PER-TOKEN data from a different instrument.

    The depth runs give per-span perplexity. The cliff runs give `nll_series`,
    one NLL per scored token, which is what section 2's MISFIRE RATE is defined
    on -- so this is where the two sections meet. That run happens to carry two
    n_ctx-8192 specs whose `corpus_start` differs by 4096, which is exactly the
    boundary-offset variable, measured for an unrelated purpose.

    THIS COMPARISON IS ONLY VALID BECAUSE IT IS REGION-MATCHED, and the default
    path is pinned to one run for that reason. Every chunk in 20260824T164959Z
    lies in corpus 8k-32k as interleaved 4096-blocks, so offset is the only
    thing that differs.

    Pool it with the other cliff runs and the effect DISAPPEARS: off=0 goes to
    26.7% against off=4096's 28.2%, a ratio of 1.06. That is not a refutation,
    it is a confound -- the other run contributes 86017..90111, an off=0 chunk
    at an 82.3% rate, which is the progress-bar region section 3f calls the
    worst in the corpus. Across regions, REGION DIFFICULTY DWARFS OFFSET.

    So the honest claim is narrow: within a matched region, boundary offset
    moves the misfire rate ~3.4x. Offset is NOT a global determinant of the
    rate, and any sweep that mixes corpus regions will measure difficulty
    instead. (Recorded because the wider claim was made here first, on
    2026-08-31, and had to be walked back within the hour.)
    """
    paths = list(paths or CLIFF_OLD)
    present = [p for p in paths if os.path.exists(p)]
    if not present:
        print("\n(cliff cross-check skipped: %s not present)" % ", ".join(paths))
        return
    weights = {run_weights(p) for p in present}
    print("\n=== cliff cross-check: misfire RATE by boundary offset (per-token) ===")
    print("  %s" % title)
    print("  section 2's quantity, moved by section 3's variable, on a different instrument.")
    for p in present:
        print("  source %-46s weights %s"
              % (os.path.basename(os.path.dirname(p)), run_weights(p) or "UNSTAMPED"))
    if len(weights) > 1:
        print("  REFUSED: these runs do not share weights, so pooling them would")
        print("           measure the model change and call it boundary offset.")
        return
    by_off = {}
    for p in present:
        doc = json.load(open(p))
        for spec in doc.get("specs", []):
            off = spec.get("corpus_start", 0) % 8192
            for c in spec.get("by_chunk", []):
                ser = [x for x in c.get("nll_series", []) if isinstance(x, (int, float))]
                if not ser:
                    continue
                rate = 100.0 * sum(1 for x in ser if x > 10.0) / len(ser)
                mean = sum(ser) / len(ser)
                by_off.setdefault(off, []).append((c.get("chunk"), c.get("scored_corpus"), mean, rate))
    for off in sorted(by_off):
        print("  offset %d:" % off)
        for chunk, scored, mean, rate in by_off[off]:
            print("    chunk %s scored %s  mean_nll %.3f  ppl %8.1f  misfire>10nats %5.2f%%"
                  % (chunk, scored, mean, math.exp(mean), rate))
    if len(by_off) == 2:
        a, b = sorted(by_off)
        ra = sum(r for _c, _s, _m, r in by_off[a]) / len(by_off[a])
        rb = sum(r for _c, _s, _m, r in by_off[b]) / len(by_off[b])
        lo, hi = (ra, rb) if ra < rb else (rb, ra)
        print("  mean misfire rate: offset %d = %.1f%%, offset %d = %.1f%%  (%.1fx)"
              % (a, ra, b, rb, hi / lo if lo else 0))
        print("  -> within this REGION-MATCHED set, the boundary offset moves the MISFIRE")
        print("     RATE itself, not merely the aggregate ppl. Do not pool across corpus")
        print("     regions: region difficulty dominates and the effect vanishes (1.06x).")


def flatness_check():
    """Section 3f's own test: is the misfire rate constant across a chunk?

    3f demonstrates flatness on the worst chunk in the corpus and says the same
    holds for "the other two high-rate chunks". Re-running it over every chunk
    with an nll_series on disk both REPRODUCES that and bounds it.

    Read the low-rate rows with care, and this is the trap worth naming: at a
    5.5% rate a 256-token bin holds about 14 misfires, so a Q4/Q1 ratio of 55x
    is small-count noise, not a refutation of anything. Comparing a low-rate
    chunk against a claim made about high-rate chunks is a category error -- it
    was made once here, on 2026-08-31, and this function exists so the next
    reader sees the rates beside the ratios.
    """
    rows = []
    for path in sorted(glob.glob(".ppl-cliff-logs/*/result.json")):
        try:
            doc = json.load(open(path))
        except (ValueError, OSError):
            continue
        # THE WEIGHTS COLUMN IS LOAD-BEARING HERE. This pools every cliff run on
        # disk, and several scored ranges appear TWICE because section 2's
        # re-measurement re-ran them on the new weights: corpus 8193..12287 is
        # 31.2% on UD-Q4_K_XL and 28.2% on Q4_K_M. Two rows with the same chunk
        # label and different rates read as noise unless the column says why.
        wts = short_weights(path)
        # A CONSTRUCTED-CORPUS RUN'S CHUNK LABELS ARE NOT SOURCE WINDOWS, and
        # its own run.meta says so: "the labels 12289..16383 and 20481..24575
        # appear here by coincidence". Two such runs are on disk, and unlabelled
        # they read as duplicate measurements of source windows that disagree.
        built = run_meta(path).get("CONSTRUCTED_CORPUS") == "1"
        for spec in doc.get("specs", []):
            off = spec.get("corpus_start", 0) % 8192
            for c in spec.get("by_chunk", []):
                ser = [x for x in c.get("nll_series", []) if isinstance(x, (int, float))]
                if len(ser) < 1000:
                    continue
                n = len(ser)
                b = n // 16
                rate = 100.0 * sum(1 for x in ser if x > 10.0) / n
                bins = []
                for i in range(16):
                    seg = ser[i * b:(i + 1) * b] if i < 15 else ser[15 * b:]
                    bins.append(100.0 * sum(1 for x in seg if x > 10.0) / max(1, len(seg)))
                q1 = statistics.mean(bins[:4])
                q4 = statistics.mean(bins[-4:])
                label = str(c.get("scored_corpus"))
                if built:
                    label += " (built)"
                rows.append((label, off, rate, q1, q4,
                             rate * b / 100.0, wts))
    if not rows:
        print("\n(flatness check skipped: no nll_series on disk)")
        return
    print("\n=== section 3f flatness: misfire rate across the scored range ===")
    print("  %-22s %6s %6s %6s %7s %9s  %-18s"
          % ("chunk", "rate%", "Q1%", "Q4%", "Q4/Q1", "misfires/bin", "weights"))
    for sc, off, rate, q1, q4, per_bin, wts in sorted(rows, key=lambda r: -r[2]):
        ratio = (q4 / q1) if q1 else float("inf")
        note = "" if per_bin >= 30 else "   <- too sparse to read"
        print("  %-22s %6.1f %6.1f %6.1f %7.2f %9.0f  %-18s%s"
              % (sc, rate, q1, q4, ratio, per_bin, wts, note))
    high = [r for r in rows if r[2] > 20]
    flat = [r for r in high if 0.8 <= ((r[4] / r[3]) if r[3] else 9) <= 1.25]
    print("  high-rate chunks (>20%%): %d, of which flat (0.8-1.25x): %d"
          % (len(high), len(flat)))
    if any(" (built)" in r[0] for r in rows):
        print("  (built) = a CONSTRUCTED corpus: the range is a position in that")
        print("           file, NOT the source window of the same numbers.")
    print("  -> 3f reproduces where it was claimed; it is NOT universal among")
    print("     high-rate chunks. Read it as 'it can be, and is in the worst", end="")
    print(" chunks'.")


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
    cliff_cross_check(CLIFF_OLD, "2026-08-24 run, OLD weights (UD-Q4_K_XL)")
    cliff_cross_check(CLIFF_CURRENT,
                      "2026-09-03 re-measurement, CURRENT weights -- quote THIS one")
    flatness_check()
    if not did_any:
        sys.exit("no run carried both a span_map and an 8192 arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
