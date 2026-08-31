#!/usr/bin/env python3
"""Compare spec-sweep configs across rounds, load-aware, with a significance test.

`spec-sweep.sh --report` prints one row per config and is the right tool for
"which arm looks fastest". It is the wrong tool for "is this difference real",
because it cannot see the two things that decide that:

  1. WHICH ROUNDS ARE COMPARABLE. Interleaving (--rounds) protects against
     gradual drift. It does not protect against a spike that lands on one arm
     and not the others. On 2026-08-31 one round had a 10x load difference
     BETWEEN CONFIGS inside it, which flattered the arm that ran while the box
     was quiet. That round has to be dropped, and dropping it must be a rule
     applied to recorded numbers, not a judgement made after seeing the result.

  2. WHETHER THE GAP SURVIVES THE SPREAD. The same config measured 181.4 and
     202.3 tok/s an hour apart on this box. Any comparison that does not carry
     a spread and a p-value is quoting noise with a decimal point on it.

This script does both, and prints the SENSITIVITY of the answer to the round
selection, because that is the number that decides whether a result is worth
acting on. A delta that is +23% on one subset and +2% on another is not a
finding, however small its p-value on the subset you preferred.

Usage:
  python3 scripts/spec_sweep_compare.py --results-dir context/bench/spec-sweep-overnight
  python3 scripts/spec_sweep_compare.py --results-dir <dir> --baseline ngram-pmin-040-n4
  python3 scripts/spec_sweep_compare.py --results-dir <dir> --load-max 8 --load-ratio 2.5

Exit status is 0 whatever the verdict; this reports, it does not gate.
"""

import argparse
import glob
import itertools
import json
import os
import statistics
import sys

# A round is "load-split" when the busiest config in it saw this many times the
# load of the quietest. Interleaving cannot rescue that: the arms were not
# measured under the same conditions, so their means are not comparable.
DEFAULT_LOAD_RATIO = 2.5
# Absolute ceiling. Above this the box was busy for everyone, which is a fair
# but noisy comparison; below it and the ratio test is what matters.
DEFAULT_LOAD_MAX = 8.0
# Permutation tests get expensive fast; above this many samples per side, fall
# back to reporting the difference without a p-value rather than hanging.
MAX_PERM_N = 12


def load_results(results_dir):
    """-> {(workload, round, config): {'tps': [...], 'load': (before, after)}}"""
    out = {}
    for wl_dir in sorted(glob.glob(os.path.join(results_dir, "*"))):
        if not os.path.isdir(wl_dir):
            continue
        wl = os.path.basename(wl_dir)
        for path in sorted(glob.glob(os.path.join(wl_dir, "*.json"))):
            try:
                doc = json.load(open(path))
            except (ValueError, OSError) as exc:
                print("  skipping %s: %s" % (path, exc), file=sys.stderr)
                continue
            cfg = doc.get("config") or {}
            name = cfg.get("name")
            if not name:
                continue
            tps = [r["predicted_tps"] for r in doc.get("rows", [])
                   if r.get("error") is None
                   and not r.get("cached")
                   and not r.get("unrepeated")
                   and isinstance(r.get("predicted_tps"), (int, float))]
            if not tps:
                continue
            out[(wl, cfg.get("round", 1), name)] = {
                "tps": tps,
                "load": (cfg.get("load_before"), cfg.get("load_after")),
            }
    return out


def round_health(data, wl, rnd, load_max, load_ratio):
    """Why this round is or is not usable. -> (ok: bool, reason: str)

    The test is deliberately CONSERVATIVE: it uses the global min and max of
    every load sample in the round, so it cannot tell a shared ramp (every arm
    ramping together, which interleaving handles) from a split (one arm hit).
    It rejects both. That is the right direction for the cost asymmetry —
    accepting a contaminated round yields a wrong verdict, rejecting a clean one
    costs another round — but it means the reason string has to show the
    per-config means, or a reader cannot tell which case they are looking at.
    """
    loads = []
    per_config = {}
    for (w, r, n), v in data.items():
        if w == wl and r == rnd and v["load"][0] is not None:
            vals = [x for x in v["load"] if x is not None]
            loads.extend(vals)
            if vals:
                per_config[n] = sum(vals) / len(vals)
    if not loads:
        return True, "no load recorded"
    lo, hi = min(loads), max(loads)
    detail = ""
    if per_config:
        detail = " [" + ", ".join(
            "%s %.1f" % (n, m) for n, m in sorted(per_config.items(), key=lambda kv: kv[1])
        ) + "]"
    # BOTH conditions, not the ratio alone. At the low end a trivial absolute
    # difference makes a big ratio -- 2.3 vs 6.5 is 2.8x, and on a 16-core box
    # both of those are an idle machine. Gating on the ratio alone rejected a
    # round whose every arm sat under the warn threshold. A round is only
    # incomparable when one arm was measurably busy AND the others were not.
    if lo > 0 and hi / lo >= load_ratio and hi > load_max:
        return False, "LOAD-SPLIT %.1f-%.1f (%.1fx)%s" % (lo, hi, hi / lo, detail)
    if hi > load_max:
        return True, "busy but even %.1f-%.1f%s" % (lo, hi, detail)
    return True, "even %.1f-%.1f%s" % (lo, hi, detail)


def perm_p(a, b):
    """Two-sided permutation test on the difference of means. None if too big."""
    if len(a) + len(b) > 2 * MAX_PERM_N:
        return None
    obs = abs(statistics.mean(a) - statistics.mean(b))
    pool = a + b
    hits = total = 0
    for idx in itertools.combinations(range(len(pool)), len(a)):
        sel = set(idx)
        x = [pool[i] for i in idx]
        y = [pool[i] for i in range(len(pool)) if i not in sel]
        total += 1
        if abs(statistics.mean(x) - statistics.mean(y)) >= obs - 1e-12:
            hits += 1
    return hits / total


def pool(data, wl, rounds, name):
    out = []
    for rnd in rounds:
        v = data.get((wl, rnd, name))
        if v:
            out.extend(v["tps"])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results-dir", required=True)
    ap.add_argument("--baseline", default=None,
                    help="config every other is compared against "
                         "(default: the alphabetically first, which is usually the pin)")
    ap.add_argument("--load-max", type=float, default=DEFAULT_LOAD_MAX)
    ap.add_argument("--load-ratio", type=float, default=DEFAULT_LOAD_RATIO)
    ap.add_argument("--keep-first-round", action="store_true",
                    help="do not drop round 1 (it pays cold caches; dropped by default "
                         "whenever a later round exists)")
    args = ap.parse_args()

    data = load_results(args.results_dir)
    if not data:
        sys.exit("no usable results under %s" % args.results_dir)

    workloads = sorted({w for (w, _r, _n) in data})
    configs = sorted({n for (_w, _r, n) in data})
    baseline = args.baseline or configs[0]
    if baseline not in configs:
        sys.exit("baseline %r not among %s" % (baseline, configs))

    for wl in workloads:
        rounds = sorted({r for (w, r, _n) in data if w == wl})
        print("\n=== %s ===" % wl)

        print("  round health:")
        usable = []
        for rnd in rounds:
            ok, why = round_health(data, wl, rnd, args.load_max, args.load_ratio)
            cold = (rnd == min(rounds) and len(rounds) > 1 and not args.keep_first_round)
            verdict = "USE"
            if not ok:
                verdict = "DROP"
            elif cold:
                verdict = "DROP(cold)"
            else:
                usable.append(rnd)
            print("    round %-3s %-12s %s" % (rnd, verdict, why))

        if not usable:
            print("  no usable rounds — nothing can be concluded for this workload")
            continue

        if len(usable) < 2:
            print("  WARNING: only %d usable round(s). There is no replication here —"
                  % len(usable))
            print("  a single round cannot distinguish a config difference from whatever")
            print("  else was happening on the box during it. Treat any delta below as a")
            print("  direction to test, not a result. Add rounds.")

        print("  pooled over rounds %s:" % ",".join(str(r) for r in usable))
        base = pool(data, wl, usable, baseline)
        for name in configs:
            v = pool(data, wl, usable, name)
            if not v:
                continue
            print("    %-24s n=%-3d mean=%7.1f  median=%7.1f  min=%6.1f  max=%6.1f"
                  % (name, len(v), statistics.mean(v), statistics.median(v),
                     min(v), max(v)))

        # UNEQUAL n MEANS AN INCOMPLETE OR RAGGED POOL, NOT A RESULT.
        # A round counts as usable as soon as its load stamps look even, which
        # can be true while one config's bench is still running -- so a mid-run
        # read pools n=8 for one arm against n=4 for the other and prints a
        # p-value off it. The permutation test does not care about balance and
        # will happily report SIGNIFICANT. Say it out loud instead.
        counts = {}
        for name in configs:
            v = pool(data, wl, usable, name)
            if v:
                counts[name] = len(v)
        if len(set(counts.values())) > 1:
            print("  WARNING: unequal sample counts %s — the pool is ragged."
                  % ", ".join("%s=%d" % (n, c) for n, c in sorted(counts.items())))
            print("  Either a round is still being measured, or a config is missing from one.")
            print("  Any p-value below is computed on that imbalance; re-read when the run ends.")

        print("  vs %s:" % baseline)
        for name in configs:
            if name == baseline:
                continue
            v = pool(data, wl, usable, name)
            if not v or not base:
                continue
            delta = statistics.mean(v) - statistics.mean(base)
            pct = 100.0 * delta / statistics.mean(base)
            p = perm_p(v, base)
            pstr = "p=%.4f" % p if p is not None else "p=n/a (too many samples)"
            mark = "  SIGNIFICANT" if (p is not None and p < 0.05) else ""
            print("    %-24s delta=%+7.1f (%+.1f%%)  %s%s" % (name, delta, pct, pstr, mark))

        # The number that decides whether to act: how much does the answer move
        # if the round selection moves? A finding that only exists under one
        # subset is not a finding.
        print("  sensitivity (delta%% vs %s across round subsets):" % baseline)
        subsets = [("usable", usable), ("all", rounds)]
        for rnd in rounds:
            subsets.append(("round %s" % rnd, [rnd]))
        header = "    %-24s" % "config" + "".join("%14s" % lbl for lbl, _ in subsets)
        print(header)
        for name in configs:
            if name == baseline:
                continue
            cells = []
            for _lbl, rs in subsets:
                v = pool(data, wl, rs, name)
                b = pool(data, wl, rs, baseline)
                if not v or not b:
                    cells.append("%14s" % "-")
                    continue
                d = 100.0 * (statistics.mean(v) - statistics.mean(b)) / statistics.mean(b)
                cells.append("%13.1f%%" % d)
            print("    %-24s" % name + "".join(cells))
        print("    A result that changes sign or magnitude across these columns is")
        print("    not settled, whatever its p-value on the subset you prefer.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
