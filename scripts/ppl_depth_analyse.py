#!/usr/bin/env python3
"""Read llama-perplexity default-mode logs and answer the depth question.

THE MEASUREMENT THIS SUPPORTS, and why it needed a new instrument.

kv-cache-fidelity-measured.md §3d: perplexity climbs steeply with n_ctx on this
model — 11.61 at 4096, 16.06 at 8192, 94.00 at 16384 — and every mechanical
explanation offered so far has been refused by its own control. The one confound
left standing is that DEFAULT-MODE PERPLEXITY SCORES A DIFFERENT SET OF TOKENS AT
EVERY DEPTH. From perplexity.cpp b10573:542-600:

    first = n_ctx/2
    tokens_data = tokens + start + first
    process_logits(..., tokens_data, n_ctx - 1 - first, ...)   scores [i+1]

so chunk `j` scores absolute offsets [N/2+1, N-1] — the whole top half, never a
subrange — and each scored token's history is exactly its offset. Change N and
the document is partitioned differently. §3d compared 17 chunks of one partition
against 8 chunks of another.

WHY THE FILLER-REGION DESIGN IN THE 2026-08-24c HANDOFF DOES NOT CLOSE. That
plan placed a 1024-token region at offset N/2 in both a 2048 arm and an 8192 arm
and called them "the same tokens". They are not: the 8192 arm's chunk also
scores the 3071 corpus tokens that follow the region, and perplexity emits ONE
number per chunk covering all 4095. R's contribution is not separable, and no
filler placement makes it so, because the scored set is always the top half.

WHAT WORKS INSTEAD — ROTATION, NOT PLACEMENT. Prefix the corpus with exactly N/2
tokens of filler and every corpus token moves half a chunk. The pass then scores
the EXACT COMPLEMENT of the unprefixed pass:

    F = 0     chunk j scores corpus [jN + N/2 + 1,  jN + N - 1]
    F = N/2   chunk j scores corpus [jN + 1,        jN + N/2 - 1]

Union: every corpus token except the multiples of N/2, each scored exactly once,
each with history in [N/2+1, N-1] — the same history distribution §3d measured,
now over a token set that is IDENTICAL at every depth. Two passes per depth.

WHAT IS STILL NOT IDENTICAL, stated rather than buried: the union misses the
multiples of N/2, so the deeper arm scores a few tokens the shallow arm does not
(55 against 13 over a 57,343-token window; symmetric difference 42 tokens,
0.073%). The sets are nested, so this cannot be a partition artefact of the kind
§3d suffered, and `asymmetry_bound_pct` below prices the worst case explicitly.

WARM-UP CHUNKS ARE DROPPED, and that is not cosmetic. In the F=N/2 pass, chunk 0
carries N/2 tokens of FILLER as the history of its scored corpus tokens. Keeping
it would charge the deeper arm more filler-context than the shallow one — the
exact shape of confound this exists to remove. Every chunk whose scored range is
not fully inside the analysis window is dropped, which drops those.

PRECISION. perplexity prints a RUNNING estimate, `[i]PPL_i`, to four decimals,
where PPL_i is over the first i chunks. So cum_nll(i) = ln(PPL_i) * i * S with
S = n_ctx - 1 - n_ctx/2, and a window's NLL is cum_nll(last) - cum_nll(first-1):
two printed values, not a sum of many, so the rounding does not accumulate.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import sys
from dataclasses import dataclass, field

RE_HEADER = re.compile(
    r"calculating perplexity over (\d+) chunks, n_ctx=(\d+), batch_size=(\d+), n_seq=(\d+)")
RE_CHUNK = re.compile(r"\[(\d+)\](\d+\.\d+)")
RE_FINAL = re.compile(r"Final estimate: PPL = ([\d.]+) \+/- ([\d.]+)")
RE_ONLY = re.compile(r"tokenizes to only (\d+) tokens")


@dataclass
class PassLog:
    """One llama-perplexity default-mode run."""
    path: str
    n_ctx: int
    n_chunk: int
    batch_size: int
    n_seq: int
    cum_ppl: dict = field(default_factory=dict)   # chunk index (1-based) -> running PPL
    final_ppl: float | None = None
    token_count: int | None = None                # only set on the error path

    @property
    def scored_per_chunk(self) -> int:
        """S = n_ctx - 1 - n_ctx/2, straight from perplexity.cpp's n_token."""
        return self.n_ctx - 1 - self.n_ctx // 2

    def cum_nll(self, i: int) -> float:
        """Total NLL over chunks 1..i. cum_nll(0) is 0 by definition."""
        if i == 0:
            return 0.0
        if i not in self.cum_ppl:
            raise KeyError(f"{self.path}: no running estimate for chunk {i}")
        return math.log(self.cum_ppl[i]) * i * self.scored_per_chunk

    def window_nll(self, first: int, last: int) -> float:
        """NLL over chunks [first, last], both 1-based and inclusive."""
        if first < 1 or last < first:
            raise ValueError(f"bad window [{first}, {last}]")
        return self.cum_nll(last) - self.cum_nll(first - 1)

    def per_chunk_nll(self) -> dict:
        out = {}
        for i in sorted(self.cum_ppl):
            if i - 1 == 0 or (i - 1) in self.cum_ppl:
                out[i] = self.cum_nll(i) - self.cum_nll(i - 1)
        return out


def parse_log(text: str, path: str = "<memory>") -> PassLog:
    """Parse one run. Raises on anything that is not a scored default-mode pass.

    The error path is parsed too and reported as `token_count`, because it is
    the ONLY way default mode ever prints how many tokens it read — and that
    number is what pins the filler size to perplexity's own tokenizer rather
    than to llama-server's, which parses control tokens and does not agree.
    """
    only = RE_ONLY.search(text)
    head = RE_HEADER.search(text)
    if head is None:
        if only is not None:
            return PassLog(path=path, n_ctx=0, n_chunk=0, batch_size=0, n_seq=0,
                           token_count=int(only.group(1)))
        raise ValueError(f"{path}: no 'calculating perplexity over' header — "
                         f"this is not a completed default-mode perplexity run")
    p = PassLog(path=path,
                n_chunk=int(head.group(1)), n_ctx=int(head.group(2)),
                batch_size=int(head.group(3)), n_seq=int(head.group(4)))
    for m in RE_CHUNK.finditer(text):
        p.cum_ppl[int(m.group(1))] = float(m.group(2))
    fin = RE_FINAL.search(text)
    if fin:
        p.final_ppl = float(fin.group(1))
    if not p.cum_ppl:
        raise ValueError(f"{path}: header present but no [i]PPL running estimates")
    missing = [i for i in range(1, p.n_chunk + 1) if i not in p.cum_ppl]
    if missing:
        raise ValueError(f"{path}: declared {p.n_chunk} chunks but chunks "
                         f"{missing} never printed — the pass did not finish")
    return p


def read_log(path: str) -> PassLog:
    with open(path, encoding="utf-8", errors="replace") as fh:
        return parse_log(fh.read(), path)


# ---------------------------------------------------------------------------
# Which chunks of a pass land inside the analysis window.
# ---------------------------------------------------------------------------
def scored_corpus_range(n_ctx: int, filler: int, chunk0: int) -> tuple:
    """The corpus positions chunk `chunk0` (0-BASED) scores, inclusive.

    Absolute position of corpus token p is filler + p. Chunk c covers absolute
    [c*N, (c+1)*N) and scores absolute offsets [N/2+1, N-1].
    """
    lo = chunk0 * n_ctx + n_ctx // 2 + 1 - filler
    hi = chunk0 * n_ctx + n_ctx - 1 - filler
    return lo, hi


def chunks_in_window(n_ctx: int, filler: int, n_chunk: int,
                     win_lo: int, win_hi: int) -> tuple:
    """1-based [first, last] whose scored range is fully inside [win_lo, win_hi).

    Returns (None, None) when nothing qualifies. Raises if the qualifying set is
    not contiguous, which would mean the arithmetic above is wrong rather than
    the data being odd.
    """
    keep = []
    for c in range(n_chunk):
        lo, hi = scored_corpus_range(n_ctx, filler, c)
        if lo >= win_lo and hi < win_hi:
            keep.append(c)
    if not keep:
        return None, None
    if keep != list(range(keep[0], keep[-1] + 1)):
        raise AssertionError(f"non-contiguous kept chunks {keep}")
    return keep[0] + 1, keep[-1] + 1


@dataclass
class ArmResult:
    n_ctx: int
    ppl: float
    nll: float
    count: int
    passes: list
    missed_tokens: int
    window: tuple

    def as_dict(self) -> dict:
        return {"n_ctx": self.n_ctx, "ppl": self.ppl, "nll": self.nll,
                "scored_tokens": self.count, "missed_tokens": self.missed_tokens,
                "window": list(self.window), "passes": self.passes}


def combine_arm(logs: list, fillers: list, win_lo: int, win_hi: int) -> ArmResult:
    """One depth: several rotations of the same n_ctx over one analysis window."""
    if not logs:
        raise ValueError("no passes for this arm")
    n_ctx = logs[0].n_ctx
    for lg in logs:
        if lg.n_ctx != n_ctx:
            raise ValueError(f"arm mixes n_ctx {n_ctx} and {lg.n_ctx}")
    total_nll = 0.0
    total_count = 0
    detail = []
    for lg, f in zip(logs, fillers):
        first, last = chunks_in_window(n_ctx, f, lg.n_chunk, win_lo, win_hi)
        if first is None:
            detail.append({"path": lg.path, "filler": f, "kept": None})
            continue
        nll = lg.window_nll(first, last)
        cnt = (last - first + 1) * lg.scored_per_chunk
        total_nll += nll
        total_count += cnt
        detail.append({"path": lg.path, "filler": f, "kept": [first, last],
                       "chunks": last - first + 1, "tokens": cnt,
                       "ppl": math.exp(nll / cnt),
                       "corpus_first": scored_corpus_range(n_ctx, f, first - 1)[0],
                       "corpus_last": scored_corpus_range(n_ctx, f, last - 1)[1]})
    if total_count == 0:
        raise ValueError(f"n_ctx={n_ctx}: no chunk of any rotation fits the window")
    span = max(0, win_hi - win_lo - 1)
    # NEGATIVE means the rotations OVERLAP rather than partition — which is what
    # a resolving run does on purpose (four quarter-offsets cover each corpus
    # quarter twice, through two different chunk alignments). The union PPL is
    # then a weighted average and not "the corpus once", so it is reported but
    # must not be read as a depth figure. `span_map()` is the instrument for
    # that shape.
    return ArmResult(n_ctx=n_ctx, ppl=math.exp(total_nll / total_count),
                     nll=total_nll, count=total_count, passes=detail,
                     missed_tokens=span - total_count, window=(win_lo, win_hi))


def rotation_spread_pct(arm: ArmResult) -> float:
    """How far apart the rotations of ONE arm are, as a percentage.

    This is a free yardstick for the whole exercise, and it is worth more than
    the analytic asymmetry bound because it is measured rather than argued. The
    two rotations at a given depth score COMPLEMENTARY halves of the corpus —
    50% disjoint, the largest token-set difference this design can produce — at
    an IDENTICAL history distribution. Whatever they differ by is pure corpus
    heterogeneity, with no depth in it at all.

    Two arms of this probe are 0.07% disjoint. So if the cross-depth difference
    is much larger than the within-depth rotation spread, no plausible token-set
    effect explains it — which is precisely the objection §3d could not answer.
    """
    ppls = [p["ppl"] for p in arm.passes if p.get("kept") is not None]
    if len(ppls) < 2:
        return 0.0
    return 100.0 * (max(ppls) - min(ppls)) / min(ppls)


def asymmetry_bound_pct(shallow: ArmResult, deep: ArmResult,
                        worst_nll: float = 12.0) -> float:
    """Worst-case % error on the deep arm's PPL from the tokens only it scores.

    The two arms' scored sets are NESTED — both miss the multiples of their own
    N/2, and the deeper arm's misses are a subset of the shallow arm's — so the
    whole discrepancy is the |shallow.missed - deep.missed| tokens that the deep
    arm scores and the shallow one does not. `worst_nll` is a deliberately
    absurd per-token NLL (12 nats is p = 6e-6) so the bound cannot be argued
    with.
    """
    extra = abs(shallow.missed_tokens - deep.missed_tokens)
    if deep.count == 0:
        return float("inf")
    d_mean = deep.nll / deep.count
    worst = extra * max(abs(worst_nll - d_mean), abs(d_mean)) / deep.count
    return 100.0 * (math.exp(worst) - 1.0)


def printing_floor(lg: "PassLog", i: int) -> float:
    """Absolute NLL uncertainty on chunk `i` from the log's four printed decimals.

    perplexity prints the RUNNING estimate to 4 dp, so a printed PPL_i carries
    +/- 5e-5 absolute, and cum_nll(i) = ln(PPL_i) * i * S inherits
    i * S * 5e-5 / PPL_i. A per-chunk value is a difference of two of those.

    This exists so the alignment control has a floor it DERIVED rather than a
    threshold someone picked. A fixed constant would be wrong at both ends: it
    is far above the floor for a 4-chunk run and far below it for a 33-chunk one.
    """
    half_ulp = 0.5e-4
    err = 0.0
    for k in (i, i - 1):
        if k <= 0:
            continue
        err += k * lg.scored_per_chunk * half_ulp / lg.cum_ppl[k]
    return err


def alignment_control(a: PassLog, b: PassLog, offset: int) -> dict:
    """b's chunk j+offset must be a's chunk j, token for token.

    This is the control that decides whether any of the rest is readable. `b` is
    the same corpus behind `offset` WHOLE chunks of filler, so llama_memory_clear
    at the top of every chunk (perplexity.cpp:558) means its later chunks are
    bit-identical work to a's. Run it BEFORE reading any depth number.

    WHAT IT CAN AND CANNOT SEE, measured on synthetic logs rather than asserted:

        exact                     1.0e-04  (the printing floor itself)
        filler off by one token   4.4e-04  (4x the floor)
        offset off by one chunk   4.7e-02  (450x the floor)

    So it catches a chunk-scale misalignment with enormous margin and a
    single-token one with about 4x — which is why the run script ALSO reads
    perplexity's own token count off the error path instead of trusting this.
    A passing control is not proof that the filler is exactly N tokens; it is
    proof that it is within a token or two of it.
    """
    if a.n_ctx != b.n_ctx:
        raise ValueError("alignment control needs both passes at the same n_ctx")
    pa, pb = a.per_chunk_nll(), b.per_chunk_nll()
    rows, worst, worst_ratio = [], 0.0, 0.0
    for j in sorted(pa):
        k = j + offset
        if k not in pb:
            continue
        diff = abs(pb[k] - pa[j])
        rel = diff / max(abs(pa[j]), 1e-9)
        floor = printing_floor(a, j) + printing_floor(b, k)
        ratio = diff / max(floor, 1e-12)
        worst = max(worst, rel)
        worst_ratio = max(worst_ratio, ratio)
        rows.append({"a_chunk": j, "b_chunk": k, "a_nll": pa[j], "b_nll": pb[k],
                     "rel_diff": rel, "floor_nll": floor, "floor_ratio": ratio})
    if not rows:
        raise ValueError("alignment control compared nothing - check the offset")
    return {"offset": offset, "pairs": len(rows), "worst_rel_diff": worst,
            "worst_floor_ratio": worst_ratio,
            "verdict": "PASS" if worst_ratio <= 3.0 else "FAIL",
            "rows": rows}


def span_map(logs: list, grid: int, win_lo: int, win_hi: int) -> list:
    """Per-chunk NLL re-binned onto a common grid, so depths compare on spans.

    THIS IS THE INSTRUMENT THE AGGREGATE HIDES. On 2026-08-24 the two rotations
    at n_ctx 8192 came back at 14.77 and 227.67 — a 15x disagreement between two
    passes that differ only in where the chunk boundary falls — while at 2048 and
    4096 they agreed to 9% and 22%. An arm's single number cannot show that, and
    quoting it would have reported a corpus-wide depth effect that is in fact
    concentrated in one rotation's chunks.

    `logs` is a list of (n_ctx, filler, PassLog). A chunk is assigned to a grid
    cell only when its whole scored range fits inside it, so nothing is smeared
    across a boundary; cells where a depth contributed nothing are left out of
    that depth's column rather than filled in.
    """
    cells: dict = {}
    # SILENCE IS NOT SUCCESS. A chunk wider than the grid, or one that straddles
    # a cell boundary, cannot be binned — and the quarter-offset rotations a
    # resolving run uses straddle EVERY cell of the natural grid, so a map drawn
    # without this counter would quietly show half the passes and look complete.
    dropped: dict = {}
    for n_ctx, filler, lg in logs:
        per = lg.per_chunk_nll()
        S = lg.scored_per_chunk
        for i, nll in per.items():
            lo, hi = scored_corpus_range(n_ctx, filler, i - 1)
            if lo < win_lo or hi >= win_hi:
                continue
            cell = (lo // grid) * grid
            if hi >= cell + grid:
                dropped[(n_ctx, filler)] = dropped.get((n_ctx, filler), 0) + 1
                continue
            key = (cell, n_ctx)
            acc = cells.setdefault(key, [0.0, 0, []])
            acc[0] += nll
            acc[1] += S
            acc[2].append(filler)
    out = []
    depths = sorted({n for _, n in cells})
    for cell in sorted({c for c, _ in cells}):
        row = {"span": [cell, cell + grid], "by_depth": {}}
        for n in depths:
            acc = cells.get((cell, n))
            if acc and acc[1]:
                row["by_depth"][n] = {"ppl": math.exp(acc[0] / acc[1]),
                                      "tokens": acc[1],
                                      "rotations": sorted(acc[2])}
        out.append(row)
    if dropped:
        out.append({"straddled": [{"n_ctx": n, "filler": f, "chunks": c}
                                  for (n, f), c in sorted(dropped.items())]})
    return out


def _fmt_span_map(rows: list) -> str:
    straddled = [r for r in rows if "straddled" in r]
    rows = [r for r in rows if "span" in r]
    depths = sorted({n for r in rows for n in r["by_depth"]})
    head = f"{'corpus span':>18} " + " ".join(f"{n:>10}" for n in depths)
    if len(depths) >= 2:
        head += f"   {depths[-1]}/{depths[0]}"
    lines = [head]
    for r in rows:
        cells = []
        for n in depths:
            v = r["by_depth"].get(n)
            cells.append(f"{v['ppl']:>10.2f}" if v else f"{'-':>10}")
        line = f"{r['span'][0]:>8}..{r['span'][1] - 1:<8} " + " ".join(cells)
        lo, hi = r["by_depth"].get(depths[0]), r["by_depth"].get(depths[-1])
        if len(depths) >= 2 and lo and hi:
            line += f"   {hi['ppl'] / lo['ppl']:>8.1f}x"
        lines.append(line)
    for blk in straddled:
        for d in blk["straddled"]:
            lines.append(f"NOT BINNED: n_ctx {d['n_ctx']} filler {d['filler']} — "
                         f"{d['chunks']} chunks straddle this grid and are absent "
                         f"from every row above")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
def _fmt_arm(a: ArmResult) -> str:
    lines = [f"  n_ctx {a.n_ctx:<6} PPL {a.ppl:>10.4f}   "
             f"{a.count} tokens scored, {a.missed_tokens} missed, "
             f"history {a.n_ctx // 2 + 1}..{a.n_ctx - 1}",
             f"      rotation spread {rotation_spread_pct(a):.1f}% "
             f"(two 50%-disjoint halves at the SAME depth — the scale of a pure "
             f"token-set effect)"]
    for p in a.passes:
        if p.get("kept") is None:
            lines.append(f"      filler {p['filler']:<6} no chunk fits the window")
        else:
            lines.append(
                f"      filler {p['filler']:<6} chunks {p['kept'][0]}..{p['kept'][1]}"
                f" ({p['chunks']})  corpus {p['corpus_first']}..{p['corpus_last']}"
                f"  PPL {p['ppl']:.4f}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--logdir", required=True)
    ap.add_argument("--window", default=None,
                    help="corpus analysis window LO,HI (default: derived — LO is "
                         "the largest n_ctx present, HI the largest multiple of it "
                         "every arm covers)")
    ap.add_argument("--control", default=None,
                    help="A,B,OFFSET: log basenames and the whole-chunk offset "
                         "between them")
    ap.add_argument("--spans", type=int, default=0,
                    help="also print a per-span map on a grid of this many "
                         "corpus tokens (e.g. 4096). The aggregate cannot show a "
                         "rotation that disagrees with its own partner; this can.")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.logdir, "*.log")))
    if not paths:
        return _die(f"no *.log under {args.logdir}")

    # arm-<n_ctx>-f<filler>.log is the naming ppl-depth-run.sh writes.
    arms: dict = {}
    parsed: dict = {}
    for p in paths:
        base = os.path.basename(p)
        m = re.match(r"arm-(\d+)-f(\d+)\.log$", base)
        try:
            lg = read_log(p)
        except ValueError as e:
            print(f"    skipped {base}: {e}")
            continue
        parsed[base] = lg
        if m:
            arms.setdefault(int(m.group(1)), []).append((int(m.group(2)), lg))

    if args.window:
        win_lo, win_hi = (int(x) for x in args.window.split(","))
    else:
        if not arms:
            return _die("no arm-<n_ctx>-f<filler>.log files to derive a window from")
        win_lo = max(arms)
        # The tightest end every arm can reach: chunks are whole, so each arm
        # covers up to floor(reach / N) * N.
        reach = min(min(lg.n_chunk * n for f, lg in v) for n, v in arms.items())
        win_hi = min((reach // n) * n for n in arms)
    print(f"==> analysis window   corpus [{win_lo}, {win_hi})  "
          f"{max(0, win_hi - win_lo - 1)} positions")

    report: dict = {"window": [win_lo, win_hi], "arms": [], "control": None}

    results = []
    for n in sorted(arms):
        entries = sorted(arms[n])
        res = combine_arm([lg for _, lg in entries], [f for f, _ in entries],
                          win_lo, win_hi)
        results.append(res)
        report["arms"].append(res.as_dict())
        print(_fmt_arm(res))

    if len(results) >= 2:
        lo, hi = results[0], results[-1]
        bound = asymmetry_bound_pct(lo, hi)
        ratio = hi.ppl / lo.ppl
        report["ppl_ratio_deepest_over_shallowest"] = ratio
        report["asymmetry_bound_pct"] = bound
        report["rotation_spread_pct"] = {r.n_ctx: rotation_spread_pct(r) for r in results}
        print(f"==> PPL({hi.n_ctx}) / PPL({lo.n_ctx}) = {ratio:.4f}")
        print(f"    worst case from the {abs(lo.missed_tokens - hi.missed_tokens)}-token "
              f"set asymmetry: {bound:.3f}% on the deeper arm")

    if args.spans:
        flat = [(n, f, lg) for n, v in arms.items() for f, lg in v]
        rows = span_map(flat, args.spans, win_lo, win_hi)
        report["span_map"] = rows
        print(f"==> per-span map, grid {args.spans}")
        print("\n".join("    " + line for line in _fmt_span_map(rows).split("\n")))

    if args.control:
        a, b, off = args.control.split(",")
        ctl = alignment_control(parsed[a], parsed[b], int(off))
        report["control"] = {k: v for k, v in ctl.items() if k != "rows"}
        report["control"]["rows"] = ctl["rows"]
        verdict = ctl["verdict"]
        print(f"==> alignment control  {a} vs {b} at offset {off}: "
              f"{ctl['pairs']} chunk pairs, worst per-chunk NLL difference "
              f"{ctl['worst_rel_diff']:.3e} relative, "
              f"{ctl['worst_floor_ratio']:.1f}x the log's own printing floor  {verdict}")
        if verdict == "FAIL":
            print("    The filler is NOT a whole number of chunks long. Every")
            print("    rotation in this run is misaligned; the depth numbers above")
            print("    are not readable.")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"==> wrote {args.json}")
    return 0


def _die(msg: str) -> int:
    print(f"err  {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
