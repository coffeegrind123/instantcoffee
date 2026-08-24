#!/usr/bin/env python3
"""Compare two arms across SEVERAL COLD LOADS, with the load as the replicate.

WHY THIS EXISTS. `versions.lock:kv_accept_note` records a q8_0-vs-f16 prefill
difference of -2.6 % at 8.26 SE and then says not to quote it, because **each arm
got exactly one cold load, so the load is aliased onto the arm.** Anything that
differs between two loads of the same config — allocator layout, device state,
another tenant — was being charged to the KV type, and the SE that made it look
resolved was computed INSIDE the confound. More repeats cannot fix that; they
tighten a biased estimate.

The fix is the design: alternate the arms across several cold loads and treat
THE LOAD, not the request, as the unit of replication. That is what this reads.
`capacity-probe.sh` writes one JSON per config and one config is one cold load,
so a run of

    --config 'kvalt-a-f16|…' --config 'kvalt-a-q8_0|…'
    --config 'kvalt-b-f16|…' --config 'kvalt-b-q8_0|…'   …

gives four independent loads per arm. The arm mean is then the mean of the four
LOAD means, and its standard error is computed across those four numbers.

READ BOTH SPREADS. The between-load SD is the one that decides whether a
difference is resolved. The within-load SD is printed beside it because their
ratio is the whole point: if between-load variation is comparable to or larger
than within-load variation, then a single-load-per-arm design could never have
answered the question, however many requests it made.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import sys

METRICS = (("prompt_tps", "prefill tok/s"),
           ("predicted_tps", "decode tok/s"),
           ("draft_acceptance", "MTP acceptance"))


def usable_rows(doc: dict) -> list:
    """Rows the bench itself would count: answered, not served from the cache.

    `bench.py` marks a run CACHED when llama reports a reused prefix and excludes
    it rather than reporting a fast run for work it never did. The same exclusion
    has to happen here or a cache hit becomes a throughput win.
    """
    result = doc.get("result") or {}
    rows = result.get("rows") or []
    return [r for r in rows
            if r.get("status") == 200 and not r.get("error")
            and not r.get("cached") and not r.get("cache_n")]


def mean(v: list) -> float:
    return sum(v) / len(v)


def sd(v: list) -> float:
    """Sample standard deviation. Zero for a single value rather than undefined."""
    if len(v) < 2:
        return 0.0
    m = mean(v)
    return math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))


def load_stats(paths: list, metric: str) -> list:
    """One entry per cold load: its label, its mean, its within-load SD and n."""
    out = []
    for p in sorted(paths):
        doc = json.load(open(p, encoding="utf-8"))
        vals = [r[metric] for r in usable_rows(doc)
                if isinstance(r.get(metric), (int, float))]
        if not vals:
            continue
        out.append({"label": doc.get("label") or os.path.basename(p),
                    "mean": mean(vals), "sd": sd(vals), "n": len(vals)})
    return out


def compare(a: list, b: list) -> dict:
    """Two arms, each a list of load means. The unit of replication is the LOAD."""
    am = [x["mean"] for x in a]
    bm = [x["mean"] for x in b]
    diff = mean(bm) - mean(am)
    # Welch, on the between-load spread. With four loads per arm this is a weak
    # test — and saying so is the point: it is the honest weakness that a
    # within-load SE was hiding behind.
    va = sd(am) ** 2 / max(len(am), 1)
    vb = sd(bm) ** 2 / max(len(bm), 1)
    se = math.sqrt(va + vb)
    return {"a_mean": mean(am), "b_mean": mean(bm), "diff": diff,
            "a_sd_between": sd(am), "b_sd_between": sd(bm),
            "a_sd_within": mean([x["sd"] for x in a]),
            "b_sd_within": mean([x["sd"] for x in b]),
            "se": se, "t": (diff / se) if se else float("inf"),
            "pct": 100.0 * diff / mean(am) if mean(am) else 0.0,
            "n_loads_a": len(am), "n_loads_b": len(bm)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default="context/bench/capacity")
    ap.add_argument("--glob", default="kvalt-*.json")
    ap.add_argument("--arm-a", default="f16", help="substring identifying arm A")
    ap.add_argument("--arm-b", default="q8_0", help="substring identifying arm B")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.dir, args.glob)))
    if not paths:
        print(f"err  nothing matched {args.glob} in {args.dir}", file=sys.stderr)
        return 1
    # arm-b first: 'q8_0' and 'f16' are both substrings of nothing else here, but
    # a label like 'x-f16-q8_0' would match both, and matching the more specific
    # one first is the only order that cannot silently mis-bin it.
    a_paths = [p for p in paths if args.arm_a in os.path.basename(p)
               and args.arm_b not in os.path.basename(p)]
    b_paths = [p for p in paths if args.arm_b in os.path.basename(p)]
    print(f"==> {len(a_paths)} loads in arm '{args.arm_a}', "
          f"{len(b_paths)} in arm '{args.arm_b}'")

    report = {"arm_a": args.arm_a, "arm_b": args.arm_b, "metrics": {}}
    for metric, title in METRICS:
        a = load_stats(a_paths, metric)
        b = load_stats(b_paths, metric)
        if len(a) < 2 or len(b) < 2:
            print(f"\n--- {title}: fewer than two loads per arm; "
                  f"nothing this tool can say")
            continue
        c = compare(a, b)
        report["metrics"][metric] = {"loads_a": a, "loads_b": b, **c}
        print(f"\n--- {title}")
        for arm, rows in ((args.arm_a, a), (args.arm_b, b)):
            per = "  ".join(f"{x['label'].split('-')[-2]}:{x['mean']:.4g}" for x in rows)
            print(f"    {arm:<6} {per}")
        print(f"    {args.arm_a} {c['a_mean']:.4g}  ->  {args.arm_b} {c['b_mean']:.4g}   "
              f"diff {c['diff']:+.4g} ({c['pct']:+.2f} %)")
        print(f"    SD between loads   {args.arm_a} {c['a_sd_between']:.4g}   "
              f"{args.arm_b} {c['b_sd_between']:.4g}")
        print(f"    SD within a load   {args.arm_a} {c['a_sd_within']:.4g}   "
              f"{args.arm_b} {c['b_sd_within']:.4g}")
        print(f"    t = {c['t']:+.2f} on {c['n_loads_a']}+{c['n_loads_b']} loads"
              f"   {'RESOLVED' if abs(c['t']) >= 2.5 else 'NOT RESOLVED'} at this n")
        big = max(c["a_sd_between"], c["b_sd_between"])
        small = max(max(c["a_sd_within"], c["b_sd_within"]), 1e-12)
        print(f"    between/within = {big / small:.2f} — "
              + ("load-to-load variation dominates, so a one-load-per-arm design "
                 "could never have answered this" if big > small else
                 "within-load noise dominates; more repeats would help here"))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"\n==> wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
