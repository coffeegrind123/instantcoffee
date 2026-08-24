#!/usr/bin/env python3
"""Align strided-perplexity arms so the SAME tokens are compared at different
history lengths.

`llama-perplexity --ppl-stride S -c C` runs `perplexity_v2()`, which:

  * uses an effective window ``W = C + S//2``  (perplexity.cpp:2043)
  * clears the KV cache at the top of every chunk
  * lets chunk ``i`` cover tokens ``[i*S, i*S + W)``
  * scores ``j = W-S-1 .. W-2``, i.e. the token at absolute index
    ``i*S + j + 1`` for each ``j`` — the LAST ``S`` tokens of the window

so chunk ``i`` of an arm with window ``W`` scores exactly

    [i*S + W - S,  i*S + W - 1]        (S tokens)

and every one of those tokens carries between ``W-S`` and ``W-1`` tokens of
history.  Two arms sharing a stride therefore score identical absolute ranges
whenever ``(W2 - W1) % S == 0``: arm 2's chunk ``k`` is arm 1's chunk
``k + (W2-W1)//S``, token for token.

`perplexity_v2` prints only a RUNNING aggregate, ``[i]exp(nll/count)`` after
each chunk, with ``count = i*S``.  Per-chunk sums are recovered by differencing
the cumulative negative log-likelihood:

    nll_cum(i) = i * S * ln(printed_i)
    chunk i's mean NLL = (nll_cum(i) - nll_cum(i-1)) / S

The printed value carries four decimals, so a differenced per-chunk mean NLL is
good to ~1e-3 nats (~0.05 % of a typical per-token NLL here) — fine for shape.
The AGGREGATE over a range differences only its two endpoints, so it is exact to
about 1e-6 relative and is what the verdict is read off.

There is no ``Final estimate`` line to look for: perplexity.cpp prints that
inside ``perplexity()`` (v1) at line 654 and ``perplexity_v2()`` does not print
one.  The last running value IS the arm's aggregate.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys

# `LOG_INF("%s: have %zu tokens. Calculation chunk = %d\n", ...)`
RE_HAVE = re.compile(r"perplexity_v2: have (\d+) tokens\. Calculation chunk = (\d+)")
# `LOG_INF("%s: computing over %d chunks, n_ctx=%d, batch_size=%d, n_seq=%d\n", ...)`
RE_COMPUTING = re.compile(
    r"perplexity_v2: computing over (\d+) chunks, n_ctx=(\d+), batch_size=(\d+), n_seq=(\d+)"
)
# `LOG_INF("Will perform strided perplexity calculation -> adjusting context size from %d to %d\n", ...)`
RE_ADJUST = re.compile(
    r"adjusting context size from (\d+) to (\d+)"
)
# `LOG("[%d]%.4lf,", i + 1, ...)` — emitted with no timestamp prefix, many per line.
RE_RUNNING = re.compile(r"\[(\d+)\]([0-9]+\.[0-9]+)")
# A v1 log would carry this; a v2 log must not.  Guards against pointing this at
# the wrong kind of run.
RE_V1 = re.compile(r"Final estimate: PPL =")


class ParseError(RuntimeError):
    pass


def parse_arm(path: str) -> dict:
    """Read one arm's log into {window, stride, tokens, chunks: [running...]}.

    Everything structural is read back OUT OF THE RUN rather than recomputed
    from the arguments that were passed to it — `-c` is not the window, and the
    whole point of this script is that the window is what matters.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()

    if RE_V1.search(text):
        raise ParseError(
            f"{path}: carries a 'Final estimate' line, so it is a DEFAULT-mode "
            "perplexity run, not a --ppl-stride one. perplexity_v2() prints no "
            "such line; its last running value is the aggregate."
        )

    m_have = RE_HAVE.search(text)
    if not m_have:
        raise ParseError(
            f"{path}: no 'perplexity_v2: have N tokens. Calculation chunk = W' "
            "line. Either the arm died before tokenizing, or --ppl-stride was "
            "not in effect."
        )
    tokens, window = int(m_have.group(1)), int(m_have.group(2))

    m_comp = RE_COMPUTING.search(text)
    if not m_comp:
        raise ParseError(f"{path}: no 'computing over N chunks' line; the arm did not start.")
    n_chunk_planned = int(m_comp.group(1))
    n_ctx = int(m_comp.group(2))
    batch = int(m_comp.group(3))
    if n_ctx != window:
        raise ParseError(
            f"{path}: 'Calculation chunk = {window}' but 'n_ctx={n_ctx}'. These are "
            "the same quantity in perplexity_v2; a disagreement means the log is "
            "interleaved from two runs."
        )

    m_adj = RE_ADJUST.search(text)
    requested_c = int(m_adj.group(1)) if m_adj else None
    if m_adj and int(m_adj.group(2)) != window:
        raise ParseError(
            f"{path}: the adjust line says the window is {m_adj.group(2)} and the "
            f"v2 header says {window}."
        )
    # W = C + S//2, so the stride is recoverable from the pair and does not have
    # to be taken on trust from the caller.
    stride = 2 * (window - requested_c) if requested_c is not None else None

    running: list[float] = []
    for m in RE_RUNNING.finditer(text):
        idx, val = int(m.group(1)), float(m.group(2))
        if idx != len(running) + 1:
            raise ParseError(
                f"{path}: running series is not contiguous — saw [{idx}] at "
                f"position {len(running) + 1}. Truncated or interleaved log."
            )
        running.append(val)

    if not running:
        raise ParseError(f"{path}: no '[i]PPL,' running values; the arm produced no chunk.")

    return {
        "path": path,
        "tokens": tokens,
        "window": window,
        "stride": stride,
        "batch": batch,
        "n_chunk_planned": n_chunk_planned,
        "n_chunk": len(running),
        "running": running,
        "complete": len(running) == n_chunk_planned,
    }


def per_chunk_nll(running: list[float], stride: int) -> list[float]:
    """Mean NLL per token for each chunk, differenced out of the running series."""
    out = []
    prev_cum = 0.0
    for i, ppl in enumerate(running, start=1):
        cum = i * stride * math.log(ppl)
        out.append((cum - prev_cum) / stride)
        prev_cum = cum
    return out


def scored_span(window: int, stride: int, chunk: int) -> tuple[int, int]:
    """Absolute token indices chunk `chunk` scores, inclusive."""
    start = chunk * stride + window - stride
    return start, start + stride - 1


def range_nll(running: list[float], stride: int, lo: int, hi: int) -> tuple[float, int]:
    """Mean NLL over chunks [lo, hi] inclusive, differencing only the endpoints.

    This is the precise figure: it touches two printed values rather than
    hi-lo+1 of them, so the four-decimal print does not accumulate.
    """
    cum_hi = (hi + 1) * stride * math.log(running[hi])
    cum_lo = lo * stride * math.log(running[lo - 1]) if lo > 0 else 0.0
    n = (hi - lo + 1) * stride
    return (cum_hi - cum_lo) / n, n


def analyse(arms: list[dict], stride: int) -> dict:
    """Align every arm on absolute token ranges and compare."""
    for a in arms:
        if a["stride"] is not None and a["stride"] != stride:
            raise ParseError(
                f"{a['path']}: recovered stride {a['stride']} != {stride}. Arms with "
                "different strides score different token sets and cannot be aligned."
            )

    windows = [a["window"] for a in arms]
    base_w = min(windows)
    for w in windows:
        if (w - base_w) % stride:
            raise ParseError(
                f"window {w} is not {base_w} plus a whole number of strides "
                f"({stride}); its chunks land between the other arms' chunks and "
                "no token range is shared. Pick windows whose differences are "
                "multiples of the stride."
            )

    # Absolute first/last scored token of each arm, then the shared range,
    # snapped to chunk boundaries (which coincide across arms by the check above).
    lo_tok = max(scored_span(a["window"], stride, 0)[0] for a in arms)
    hi_tok = min(scored_span(a["window"], stride, a["n_chunk"] - 1)[1] for a in arms)

    rows = []
    common = []
    if hi_tok >= lo_tok:
        for a in arms:
            first = (lo_tok - (a["window"] - stride)) // stride
            last = (hi_tok + 1 - (a["window"] - stride)) // stride - 1
            if first < 0 or last >= a["n_chunk"] or last < first:
                raise ParseError(
                    f"{a['path']}: computed common chunk range [{first},{last}] is "
                    f"outside its {a['n_chunk']} chunks — the alignment arithmetic "
                    "disagrees with the data."
                )
            mean_nll, n_tok = range_nll(a["running"], stride, first, last)
            common.append(
                {
                    "window": a["window"],
                    "first_chunk": first,
                    "last_chunk": last,
                    "n_tokens": n_tok,
                    "mean_nll": mean_nll,
                    "ppl": math.exp(mean_nll),
                    "aggregate_all_chunks": a["running"][-1],
                    "n_chunk": a["n_chunk"],
                }
            )

        chunk_nll = {a["window"]: per_chunk_nll(a["running"], stride) for a in arms}
        n_common = common[0]["last_chunk"] - common[0]["first_chunk"] + 1
        for c in range(n_common):
            row = {"token_lo": lo_tok + c * stride, "token_hi": lo_tok + c * stride + stride - 1}
            for a, info in zip(arms, common):
                row[a["window"]] = chunk_nll[a["window"]][info["first_chunk"] + c]
            rows.append(row)

    return {"lo_tok": lo_tok, "hi_tok": hi_tok, "common": common, "rows": rows}


def format_report(arms: list[dict], res: dict, stride: int, nulls: list[tuple[dict, dict]]) -> str:
    out = []
    w = out.append
    w("")
    w("==> arms")
    w(f"    {'window':>8}  {'-c':>6}  {'chunks':>7}  {'scored tokens':>26}  {'aggregate':>10}")
    for a in arms:
        lo, _ = scored_span(a["window"], stride, 0)
        _, hi = scored_span(a["window"], stride, a["n_chunk"] - 1)
        flag = "" if a["complete"] else f"  INCOMPLETE ({a['n_chunk']}/{a['n_chunk_planned']})"
        w(
            f"    {a['window']:>8}  {a['window'] - stride // 2:>6}  {a['n_chunk']:>7}  "
            f"{lo:>11,}..{hi:<12,}  {a['running'][-1]:>10.4f}{flag}"
        )
    w("")
    w(f"    corpus tokenizes to {arms[0]['tokens']:,} tokens under perplexity's own")
    w("    tokenizer (parse_special = false). Every scored token carries between")
    w(f"    W-{stride} and W-1 tokens of history, whatever its position in the document.")

    if nulls:
        w("")
        w("==> null control — the same window run twice, in two processes")
        for a, b in nulls:
            same = a["running"] == b["running"]
            w(f"    window {a['window']}: {len(a['running'])} chunks, "
              f"{'IDENTICAL to every printed digit' if same else 'DIFFERS'}")
            if not same:
                for i, (x, y) in enumerate(zip(a["running"], b["running"]), start=1):
                    if x != y:
                        w(f"      first divergence at chunk {i}: {x} vs {y}")
                        break
                w("      The instrument is not deterministic, so no difference between")
                w("      windows below is worth reading. Fix this before anything else.")

    if not res["common"]:
        w("")
        w("    NO SHARED TOKEN RANGE between these arms — nothing to compare.")
        return "\n".join(out)

    w("")
    w("==> the same tokens at every history length")
    w(f"    shared range: tokens {res['lo_tok']:,}..{res['hi_tok']:,} "
      f"({res['common'][0]['n_tokens']:,} tokens, "
      f"{res['common'][0]['last_chunk'] - res['common'][0]['first_chunk'] + 1} chunks)")
    w("")
    base = res["common"][0]
    w(f"    {'window':>8}  {'chunks':>13}  {'mean NLL':>9}  {'PPL':>10}  {'vs shallowest':>13}")
    for c in res["common"]:
        ratio = c["ppl"] / base["ppl"]
        w(
            f"    {c['window']:>8}  {c['first_chunk']:>5}..{c['last_chunk']:<6}  "
            f"{c['mean_nll']:>9.5f}  {c['ppl']:>10.4f}  {ratio:>12.4f}x"
        )
    w("")
    w("    These rows score the identical token set, in the identical order, at the")
    w("    identical place in the document. The only difference is how many tokens")
    w("    of history precede each one — and, unavoidably, its RoPE position: the")
    w("    two cannot be separated by any scoring rule.")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("logs", nargs="+", help="arm logs, one per window")
    ap.add_argument("--stride", type=int, required=True)
    ap.add_argument("--json", help="also write the aligned result here")
    ap.add_argument("--per-chunk", action="store_true", help="print the per-chunk trace")
    args = ap.parse_args()

    parsed = []
    for p in args.logs:
        try:
            parsed.append(parse_arm(p))
        except (ParseError, OSError) as e:
            print(f"err  {e}", file=sys.stderr)
            return 1

    # A repeated window is a null control, not a second arm.
    by_window: dict[int, list[dict]] = {}
    for a in parsed:
        by_window.setdefault(a["window"], []).append(a)
    nulls = [(v[0], v[i]) for v in by_window.values() for i in range(1, len(v))]
    arms = sorted((v[0] for v in by_window.values()), key=lambda a: a["window"])

    try:
        res = analyse(arms, args.stride)
    except ParseError as e:
        print(f"err  {e}", file=sys.stderr)
        return 1

    print(format_report(arms, res, args.stride, nulls))

    if args.per_chunk and res["rows"]:
        print()
        print("==> per-chunk trace (differenced from the running series; ~1e-3 nats)")
        ws = [a["window"] for a in arms]
        print("    " + f"{'tokens':>21}" + "".join(f"{('W=%d' % w):>12}" for w in ws)
              + f"{'ratio':>9}")
        for r in res["rows"]:
            cells = "".join(f"{math.exp(r[w]):>12.4f}" for w in ws)
            ratio = math.exp(r[ws[-1]] - r[ws[0]])
            print(f"    {r['token_lo']:>9,}..{r['token_hi']:<10,}{cells}{ratio:>8.3f}x")

    if args.json:
        os.makedirs(os.path.dirname(os.path.abspath(args.json)) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "stride": args.stride,
                    "arms": [{k: v for k, v in a.items() if k != "running"} | {"running": a["running"]} for a in parsed],
                    "aligned": res,
                    "null_controls": [
                        {"window": a["window"], "identical": a["running"] == b["running"]}
                        for a, b in nulls
                    ],
                },
                fh,
                indent=2,
            )
        print(f"\n    json  {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
