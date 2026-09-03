#!/usr/bin/env python3
"""Token-matched depth analysis over cliff runs — and it REFUSES to mix models.

WHY THIS IS A SCRIPT AND NOT AN AD-HOC PASS OVER result.json.

On 2026-09-03 exactly that ad-hoc pass produced a wrong result. `.ppl-cliff-logs`
holds runs from both sides of a model change (unsloth `UD-Q4_K_XL` until
2026-08-25, `orcarouter Q4_K_M` after), globbing them together looked like one
dataset, and every "token-matched" pair straddled the switch. The identical text
of one chunk scores 18.2527 on the old weights and 15.4423 on the new, so the
comparison was measuring the model. It had to be retracted the same day.

The lesson is not "be careful". It is that a comparison which CAN silently mix
stacks eventually will, so the mixing has to be impossible rather than
discouraged. This tool:

  * reads each run's `run.meta` and refuses to pair chunks whose `GGUF_FILE`
    differs, reporting the split instead of averaging over it;
  * skips runs marked `CONSTRUCTED_CORPUS=1`, whose `scored_corpus` values are
    positions in a built corpus and collide with real source windows;
  * derives each chunk's start from its OWN scored range (`a - (N/2+1)`) rather
    than from the spec's `corpus_start`, which is only correct for chunk 0 of a
    multi-chunk spec — a second bug found the same day.

WHAT IT MEASURES. Two chunks whose scored windows overlap give the same corpus
tokens at two different depths, because a token's depth is `t - start`. On the
shared range each token is its own control, so block difficulty cancels exactly.
The pairing is reported with a McNemar test over discordant pairs, which is the
right test for paired binary outcomes.

MISFIRE is `nll > 10` nats, the definition section 3f uses.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os


def load_runs(root: str) -> tuple[list[dict], list[str]]:
    chunks, notes = [], []
    for f in sorted(glob.glob(os.path.join(root, "*", "result.json"))):
        rundir = os.path.dirname(f)
        meta = {}
        mp = os.path.join(rundir, "run.meta")
        if os.path.exists(mp):
            for line in open(mp, encoding="utf-8"):
                k, _, v = line.strip().partition("=")
                meta[k] = v
        run = os.path.basename(rundir)
        if meta.get("CONSTRUCTED_CORPUS") == "1":
            notes.append(f"skipped {run}: constructed corpus (labels are not source windows)")
            continue
        gguf = meta.get("GGUF_FILE")
        if not gguf:
            notes.append(f"skipped {run}: run.meta has no GGUF_FILE — provenance unknown")
            continue
        d = json.load(open(f, encoding="utf-8"))
        for sp in d.get("specs", []):
            n = sp.get("n_ctx")
            for c in sp.get("by_chunk", []):
                series = c.get("nll_series")
                sc = c.get("scored_corpus")
                if not series or not sc:
                    continue
                a, b = sc
                chunks.append({"run": run, "gguf": gguf, "n_ctx": n,
                               "a": a, "b": b, "start": a - (n // 2 + 1),
                               "nll": series})
    return chunks, notes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", default=".ppl-cliff-logs")
    ap.add_argument("--threshold", type=float, default=10.0)
    ap.add_argument("--min-overlap", type=int, default=500)
    args = ap.parse_args()

    chunks, notes = load_runs(args.logs)
    for n in notes:
        print(f"  note: {n}")

    by_model: dict[str, list[dict]] = {}
    for c in chunks:
        by_model.setdefault(c["gguf"], []).append(c)

    print(f"\n{len(chunks)} chunks with per-token data, across {len(by_model)} model(s):")
    for g, cs in sorted(by_model.items()):
        print(f"  {g:<38} {len(cs)} chunks  starts {sorted({x['start'] for x in cs})}")
    if len(by_model) > 1:
        print("\n  MODELS ARE NOT POOLED. Each block below is one model; a pair that")
        print("  straddled a model change would be measuring the model, not depth.")

    thr = args.threshold
    for gguf, cs in sorted(by_model.items()):
        print(f"\n=== {gguf} ===")
        pairs = []
        for i in range(len(cs)):
            for j in range(i + 1, len(cs)):
                x, y = cs[i], cs[j]
                if x["n_ctx"] != y["n_ctx"] or x["start"] == y["start"]:
                    continue
                lo, hi = max(x["a"], y["a"]), min(x["b"], y["b"])
                if hi - lo < args.min_overlap:
                    continue
                deep, shal = (x, y) if x["start"] < y["start"] else (y, x)
                n = hi - lo + 1
                dm = sum(1 for t in range(lo, hi + 1) if deep["nll"][t - deep["a"]] > thr)
                sm = sum(1 for t in range(lo, hi + 1) if shal["nll"][t - shal["a"]] > thr)
                b = c_ = 0
                for t in range(lo, hi + 1):
                    D = deep["nll"][t - deep["a"]] > thr
                    S = shal["nll"][t - shal["a"]] > thr
                    if D and not S:
                        b += 1
                    elif S and not D:
                        c_ += 1
                pairs.append((lo, hi, n, lo - deep["start"], lo - shal["start"],
                              dm / n, sm / n, b, c_))
        if not pairs:
            print("  no overlapping windows within this model")
            continue
        print(f"  {'shared tokens':>20} {'n':>5} {'depth(deep)':>11} {'depth(shal)':>11} "
              f"{'deep':>7} {'shal':>7}  verdict")
        tb = tc = 0
        dm_t = sm_t = n_t = 0
        for lo, hi, n, dd, sd, dr, sr, b, c_ in sorted(pairs):
            tb += b; tc += c_; dm_t += dr * n; sm_t += sr * n; n_t += n
            print(f"  {lo:>9}..{hi:<9} {n:>5} {dd:>11} {sd:>11} "
                  f"{dr*100:>6.1f}% {sr*100:>6.1f}%  "
                  f"{'deeper worse' if dr > sr else 'shallower worse'}")
        if n_t:
            print(f"\n  pooled over {n_t} paired token-comparisons:")
            print(f"    deeper     {dm_t/n_t*100:.1f}%")
            print(f"    shallower  {sm_t/n_t*100:.1f}%")
            if sm_t:
                print(f"    ratio      {(dm_t/n_t)/(sm_t/n_t):.2f}x")
            if tb + tc:
                chi = (abs(tb - tc) - 1) ** 2 / (tb + tc)
                p = math.erfc(math.sqrt(chi / 2))
                print(f"    McNemar: deeper-only {tb}, shallower-only {tc}, "
                      f"chi2={chi:.1f}, p={'<0.0001' if p < 1e-4 else f'{p:.4f}'}")
            print(f"\n    NOTE: depth and history CONTENT are still confounded here — moving")
            print(f"    the start changes both. Only a constructed history separates them;")
            print(f"    see ppl_history_build.py and OPEN-WORK section 2.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
