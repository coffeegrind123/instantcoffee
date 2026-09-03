#!/usr/bin/env python3
"""Read a CONSTRUCTED-corpus cliff run by arm, not by chunk label.

WHY THIS IS NOT A ONE-LINER OVER result.json. ppl_cliff_analyse.py labels every
chunk with its scored range in the corpus it was GIVEN. For a corpus built by
ppl_history_build.py those ranges are positions in the construction, and they
COLLIDE with real source windows — the 2026-09-03 probe reported "12289..16383"
and "20481..24575", both genuine windows measured in August, while all three of
its arms actually scored source tokens 12289..16383. Reading that file without
the manifest is how a content result gets mistaken for a depth result.

So this refuses to run on anything not marked CONSTRUCTED_CORPUS=1, and maps
chunk i to arms[i] from the manifest that was built with the corpus.

MISFIRE is nll > 10 nats, the definition section 3f uses and the same one
cliff_overlap_analyse.py reports, so the two are directly comparable.
"""

from __future__ import annotations

import argparse
import json
import math
import os


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("rundir")
    ap.add_argument("--threshold", type=float, default=10.0)
    args = ap.parse_args()

    meta = {}
    mp = os.path.join(args.rundir, "run.meta")
    if os.path.exists(mp):
        for line in open(mp, encoding="utf-8"):
            k, _, v = line.strip().partition("=")
            meta[k] = v
    if meta.get("CONSTRUCTED_CORPUS") != "1":
        print(f"{args.rundir}: not marked CONSTRUCTED_CORPUS=1 — refusing.\n"
              f"  This reader exists for corpora built by ppl_history_build.py.\n"
              f"  For ordinary runs use cliff_overlap_analyse.py.")
        return 2

    manp = os.path.join(args.rundir, "arms.manifest.json")
    if not os.path.exists(manp):
        print(f"{args.rundir}: CONSTRUCTED_CORPUS=1 but no arms.manifest.json — "
              f"the chunk->arm mapping is unrecoverable. Refusing to guess.")
        return 2
    man = json.load(open(manp, encoding="utf-8"))
    arms = {a["chunk"]: a for a in man["arms"]}

    res = os.path.join(args.rundir, "result.json")
    if not os.path.exists(res):
        print(f"{args.rundir}: no result.json (a failed analysis leaves none, by design).")
        return 2
    d = json.load(open(res, encoding="utf-8"))

    print(f"model      {meta.get('GGUF_FILE','?')}")
    print(f"scored     source tokens {man['scored_start']}..{man['scored_start']+man['scored_tokens']-1}"
          f"  ({man['scored_tokens']} tokens), IDENTICAL in every arm")
    print(f"history    {man['history_tokens']} tokens in every arm — amount is held fixed\n")

    rows = []
    for sp in d.get("specs", []):
        for i, c in enumerate(sp.get("by_chunk", [])):
            arm = arms.get(i)
            if arm is None:
                continue
            series = c.get("nll_series") or []
            rate = (sum(1 for x in series if x > args.threshold) / len(series)) if series else None
            rows.append((arm["label"], arm["history_start"], c.get("iso_ppl_from_log"),
                         c.get("mean_nll_from_logprobs"), rate, len(series)))

    print(f"{'arm':<14} {'history@':>9} {'PPL':>10} {'mean NLL':>9} {'misfire':>9} {'n':>6}")
    for lab, hs, ppl, nll, rate, n in rows:
        print(f"{lab:<14} {hs if hs is not None else '-':>9} "
              f"{ppl if ppl is None else round(ppl,2):>10} "
              f"{nll if nll is None else round(nll,3):>9} "
              f"{'-' if rate is None else format(rate*100,'.1f')+'%':>9} {n:>6}")

    got = [r for r in rows if r[4] is not None]
    if len(got) >= 2:
        lo = min(got, key=lambda r: r[4]); hi = max(got, key=lambda r: r[4])
        print(f"\nmisfire spread: {lo[0]} {lo[4]*100:.1f}%  ->  {hi[0]} {hi[4]*100:.1f}%"
              f"   = {hi[4]/lo[4]:.2f}x" if lo[4] else "")
        # McNemar between the extremes: same tokens, so the pairing is exact.
        for sp in d.get("specs", []):
            bc = sp.get("by_chunk", [])
            ia = next(i for i, r in enumerate(rows) if r is lo)
            ib = next(i for i, r in enumerate(rows) if r is hi)
            A = bc[ia].get("nll_series") or []
            B = bc[ib].get("nll_series") or []
            if len(A) == len(B) and A:
                b = sum(1 for x, y in zip(B, A) if x > args.threshold >= y)
                c_ = sum(1 for x, y in zip(B, A) if y > args.threshold >= x)
                if b + c_:
                    chi = (abs(b - c_) - 1) ** 2 / (b + c_)
                    p = math.erfc(math.sqrt(chi / 2))
                    print(f"McNemar {hi[0]} vs {lo[0]}: {b} vs {c_} discordant, "
                          f"chi2={chi:.1f}, p={'<0.0001' if p < 1e-4 else f'{p:.4f}'}")
            break
    print("\nAmount and scored tokens are identical across arms by construction,")
    print("so any difference here is HISTORY CONTENT alone — the one comparison")
    print("an offset sweep cannot make. See OPEN-WORK section 2.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
