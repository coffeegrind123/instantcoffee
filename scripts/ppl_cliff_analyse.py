#!/usr/bin/env python3
"""Read an isolated-chunk run and say WHICH tokens made the chunk a cliff.

WHAT IT IS GIVEN. `ppl-cliff-run.sh` stages, for each `--chunk N:A:K`, a file
holding corpus tokens [A, A + max(K,2)*N) and runs `llama-perplexity -c N
--chunks K --kl-divergence-base`. Because perplexity clears the memory before
every batch (perplexity.cpp:547), chunk j of that file is BYTE-FOR-BYTE the same
computation as the arm chunk that covers corpus [A + jN, A + (j+1)N) — so the
arm's own per-chunk number is the control, and it is read out of the arm logs
rather than typed in.

THREE THINGS IT REPORTS, in the order they are worth reading.

  1. THE CONTROL. isolated PPL against arm PPL, per chunk. The arm prints a
     four-decimal RUNNING estimate, so its per-chunk value is a difference of
     two rounded logs; `ppl_depth_analyse.PassLog.per_chunk_nll` already does
     that arithmetic and is imported rather than reimplemented. A relative
     difference above 1e-3 fails the chunk: the slice is not the chunk, and
     every per-token number behind it is about some other text.

  2. WHERE THE NLL IS. Per-token NLL across the scored range, summarised as a
     decile profile and as the count of tokens at the storage ceiling. A chunk
     whose mean is 15.28 nats can be a few catastrophic tokens dragging an
     otherwise fine chunk, or every token being hopeless; those are different
     findings and the aggregate cannot tell them apart.

     THE STORED NLL SATURATES at 16 + log_sum_exp (perplexity.cpp:86). Values at
     the ceiling are lower bounds and are counted separately, never averaged in
     as if exact. The arm's own PPL is computed from float logits and is exact;
     this file is for WHICH and WHY.

  3. WHAT THE MODEL WANTED INSTEAD. For the worst positions, the top-1 token and
     its NLL beside the actual token and its NLL. "Confidently wrong" and
     "uncertain" both produce a large NLL and mean opposite things.

DETOKENIZATION WITHOUT THE SERVER. The analysis runs while llama is stopped, so
token ids are turned back into text from the corpus's own map — every id that
occurs in the corpus has its bytes there. An id that does not occur prints as
`<id N>` rather than being guessed at; if a llama-server is reachable it is
asked instead, and the report says which happened.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ppl_tokens as P              # noqa: E402
import ppl_depth_analyse as D       # noqa: E402


def load_map(path: str) -> dict:
    with open(path) as fh:
        return json.load(fh)


class Pieces:
    """id -> bytes, from the corpus map, with the server as a fallback."""

    def __init__(self, mp: dict, raw: bytes, url: str = None):
        self.table = {}
        ids, offs = mp["ids"], mp["byte_offsets"]
        for i, tok in enumerate(ids):
            if tok not in self.table:
                self.table[tok] = raw[offs[i]:offs[i + 1]]
        self.url = url
        self.from_server = 0

    def text(self, tok: int) -> str:
        if tok in self.table:
            return self.table[tok].decode("utf-8", "replace")
        if self.url:
            try:
                body = json.dumps({"tokens": [tok]}).encode()
                req = urllib.request.Request(self.url.rstrip("/") + "/detokenize",
                                             data=body,
                                             headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as fh:
                    s = json.loads(fh.read())["content"]
                self.table[tok] = s.encode("utf-8")
                self.from_server += 1
                return s
            except Exception:
                pass
        return f"<id {tok}>"


def arm_chunk_ppls(armdir: str) -> list:
    """Every (n_ctx, filler, scored_lo, scored_hi, ppl) an arm run measured.

    The filler comes from the file name (`arm-<n_ctx>-f<filler>.log`), which is
    what ppl-depth-run.sh writes; a file that does not parse is skipped rather
    than guessed at, and the count of skipped files is returned so an empty
    control is visible as an empty control.
    """
    rows, skipped = [], []
    for name in sorted(os.listdir(armdir)):
        if not name.endswith(".log"):
            continue
        base = name[:-4]
        parts = base.split("-")
        if len(parts) != 3 or not parts[2].startswith("f") \
                or not parts[1].isdigit() or not parts[2][1:].isdigit():
            skipped.append(name)
            continue
        n_ctx, filler = int(parts[1]), int(parts[2][1:])
        try:
            lg = D.read_log(os.path.join(armdir, name))
        except Exception:
            skipped.append(name)
            continue
        if lg.n_ctx != n_ctx:
            skipped.append(name)
            continue
        for i, nll in lg.per_chunk_nll().items():
            lo, hi = D.scored_corpus_range(n_ctx, filler, i - 1)
            rows.append({"log": name, "n_ctx": n_ctx, "filler": filler,
                         "chunk0": i - 1, "scored": [lo, hi],
                         "nll": nll, "ppl": math.exp(nll / lg.scored_per_chunk)})
    return rows, skipped


def decile_profile(values: list) -> list:
    s = sorted(values)
    n = len(s)
    return [round(s[min(n - 1, int(q * n / 10))], 4) for q in range(11)] if n else []


def analyse_spec(outdir: str, corpus_base: str, spec: str, mp: dict, pieces: Pieces,
                 arms: list, worst: int) -> dict:
    n_ctx, a, k = (int(x) for x in spec.split(":"))
    name = f"c{n_ctx}-a{a}-k{k}"
    logits = os.path.join(outdir, f"{corpus_base}-{name}.logits")
    out = {"spec": spec, "n_ctx": n_ctx, "corpus_start": a, "chunks": k,
           "logits": logits}
    if not os.path.exists(logits):
        out["error"] = f"missing {logits}"
        return out

    body = P.LogitsBody(logits)
    out["header"] = {"n_ctx": body.n_ctx, "n_vocab": body.n_vocab,
                     "n_chunk": body.n_chunk, "scored_per_chunk": body.scored}
    if body.n_ctx != n_ctx:
        out["error"] = f"header says n_ctx={body.n_ctx}, spec says {n_ctx}"
        return out

    # The staged file's own token array must be the corpus slice it claims to
    # be. This is the same check stage 1 made against the server, now made
    # against perplexity itself — the one that actually matters.
    want = mp["ids"][a:a + body.n_chunk * body.n_ctx]
    out["slice_matches_corpus"] = P.compare_arrays(
        want, body.h["tokens"], "corpus_map", "perplexity")

    out["by_chunk"] = []
    for j in range(body.n_chunk):
        lo = a + j * n_ctx + n_ctx // 2 + 1
        hi = a + j * n_ctx + n_ctx - 1
        rows = body.chunk_nll(j)
        exact = [r["nll"] for r in rows if not r["saturated"]]
        sat = body.saturated(j, rows)
        total = sum(r["nll"] for r in rows)
        rec = {
            "chunk": j,
            "scored_corpus": [lo, hi],
            "file_ppl_from_logprobs": math.exp(total / len(rows)) if rows else None,
            "mean_nll_from_logprobs": total / len(rows) if rows else None,
            "saturated": sat["saturated"],
            "saturated_pct": round(sat["saturated_pct"], 3),
            # per RECORD, not per chunk: 16 + log_sum_exp varies across a chunk,
            # so the range of ceilings actually hit is reported and no single
            # number is presented as "the" ceiling.
            "ceiling_hit": None if not sat["saturated"] else
                [round(sat["ceiling_min"], 4), round(sat["ceiling_median"], 4),
                 round(sat["ceiling_max"], 4)],
            "deciles_nll": decile_profile([r["nll"] for r in rows]),
            "deciles_nll_unsaturated": decile_profile(exact),
        }
        match = [r for r in arms if r["scored"][0] == lo and r["scored"][1] == hi]
        if match:
            arm = min(match, key=lambda r: abs(r["n_ctx"] - n_ctx))
            iso = rec["file_ppl_from_logprobs"]
            # THE CONTROL IS ON NLL, NOT PPL. The stored log-probs saturate, so
            # the file's own mean is a LOWER bound and comparing it to the arm's
            # exact PPL would fail every cliff by construction. What must agree
            # is the arm's number against the arm's number for the same scored
            # range — the isolated pass prints its own running estimate, and
            # `--from-run` supplies the source arm's. `iso_ppl_from_log` is
            # filled in by the caller from the isolated run's log.
            rec["arm"] = {"log": arm["log"], "n_ctx": arm["n_ctx"],
                          "filler": arm["filler"], "chunk0": arm["chunk0"],
                          "ppl": arm["ppl"], "nll": arm["nll"]}
            rec["logprob_floor_ratio"] = (iso / arm["ppl"]) if (iso and arm["ppl"]) else None
        worst_rows = sorted(rows, key=lambda r: -r["nll"])[:worst]
        rec["worst"] = []
        for r in worst_rows:
            t = body.top1(j, r["pos"] - body.first - 1)
            rec["worst"].append({
                "corpus_pos": a + j * n_ctx + r["pos"],
                "actual": r["token"], "actual_text": pieces.text(r["token"]),
                "nll": round(r["nll"], 4), "saturated": r["saturated"],
                "top1": t["top1"], "top1_text": pieces.text(t["top1"]),
                "top1_nll": round(t["top1_nll"], 4)})
        out["by_chunk"].append(rec)
    body.close()
    return out


def iso_chunk_ppls(logdir: str, spec: str) -> dict:
    """The isolated pass's OWN per-chunk PPL, read from its running estimate."""
    n_ctx, a, k = (int(x) for x in spec.split(":"))
    name = f"c{n_ctx}-a{a}-k{k}.log"
    path = os.path.join(logdir, name)
    if not os.path.exists(path):
        return {}
    lg = D.read_log(path)
    return {i - 1: math.exp(v / lg.scored_per_chunk)
            for i, v in lg.per_chunk_nll().items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--outdir", required=True, help="the /captures subdirectory the run wrote to")
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--corpus-base", required=True)
    ap.add_argument("--specs", required=True, help="comma-separated N:A:K")
    ap.add_argument("--arms", help="a directory of arm-*.log files for the control")
    ap.add_argument("--logdir", help="the isolated run's own logs, for the PPL control")
    ap.add_argument("--url", default=os.environ.get("LLAMA_URL"),
                    help="a llama-server, used only to detokenize ids the corpus lacks")
    ap.add_argument("--worst", type=int, default=8)
    ap.add_argument("--json", help="write the full report here")
    args = ap.parse_args()

    with open(args.corpus, "rb") as fh:
        raw = P.strip_trailing_newline(fh.read())
    mp = load_map(os.path.join(args.outdir, f"{args.corpus_base}.tokmap.json"))
    pieces = Pieces(mp, raw, args.url)

    report = {"corpus": args.corpus, "tokens": len(mp["ids"]), "bytes": len(raw)}

    tokens_logits = os.path.join(args.outdir, f"{args.corpus_base}.tokens.logits")
    if os.path.exists(tokens_logits):
        h = P.read_logits_header(tokens_logits)
        report["token_array"] = P.compare_arrays(mp["ids"], h["tokens"],
                                                 "server_map", "perplexity")
        report["token_array"]["n_ctx"] = h["n_ctx"]
        v = report["token_array"]
        print("==> perplexity's own token array against the /tokenize map")
        print(f"    n_ctx {v['n_ctx']}, perplexity wrote {v['len_perplexity']} of the "
              f"map's {v['len_server_map']} tokens")
        print(f"    compared {v['covered']}, mismatches {v['mismatches']}  ->  {v['verdict']}")
        if v["first_mismatch"]:
            print(f"    first at {v['first_mismatch']['index']}: "
                  f"{v['first_mismatch']['context_server_map']} against "
                  f"{v['first_mismatch']['context_perplexity']}")
    else:
        print("==> no token-array pass in this run (--skip-tokens)")

    arms, skipped = ([], [])
    if args.arms and os.path.isdir(args.arms):
        arms, skipped = arm_chunk_ppls(args.arms)
        print(f"\n==> control arms: {len(arms)} chunks from "
              f"{len(set(r['log'] for r in arms))} logs"
              + (f", {len(skipped)} files skipped: {skipped}" if skipped else ""))
    else:
        print("\n==> no --arms directory: the isolation is UNCONTROLLED this run")

    report["specs"] = []
    for spec in args.specs.split(","):
        res = analyse_spec(args.outdir, args.corpus_base, spec, mp, pieces, arms, args.worst)
        if args.logdir:
            iso = iso_chunk_ppls(args.logdir, spec)
            for rec in res.get("by_chunk", []):
                if rec["chunk"] in iso:
                    rec["iso_ppl_from_log"] = iso[rec["chunk"]]
                    if rec.get("arm"):
                        armppl = rec["arm"]["ppl"]
                        rel = abs(iso[rec["chunk"]] - armppl) / armppl if armppl else None
                        rec["control_rel_diff"] = rel
                        rec["control"] = "PASS" if (rel is not None and rel <= 1e-3) else "FAIL"
        report["specs"].append(res)
        print_spec(res, pieces)

    if pieces.from_server:
        print(f"\n    ({pieces.from_server} token ids were not in the corpus and were "
              f"detokenized by the server)")

    if args.json:
        with open(args.json, "w") as fh:
            json.dump(report, fh, indent=1)
        print(f"\n==> wrote {args.json}")


def print_spec(res: dict, pieces: Pieces):
    print(f"\n==> {res['spec']}   n_ctx={res['n_ctx']} from corpus token {res['corpus_start']}")
    if "error" in res:
        print(f"    ERROR: {res['error']}")
        return
    sm = res["slice_matches_corpus"]
    print(f"    slice vs map  compared {sm['covered']}, mismatches {sm['mismatches']}  ->  {sm['verdict']}")
    for rec in res["by_chunk"]:
        lo, hi = rec["scored_corpus"]
        print(f"    chunk {rec['chunk']}  scores corpus {lo}..{hi}")
        if "iso_ppl_from_log" in rec:
            line = f"      isolated PPL {rec['iso_ppl_from_log']:.4f}"
            if rec.get("arm"):
                line += (f"   arm {rec['arm']['log']} chunk {rec['arm']['chunk0']} "
                         f"PPL {rec['arm']['ppl']:.4f}   {rec.get('control', '?')}"
                         f" (rel {rec.get('control_rel_diff', float('nan')):.2e})")
            print(line)
        elif rec.get("arm"):
            print(f"      arm {rec['arm']['log']} chunk {rec['arm']['chunk0']} "
                  f"PPL {rec['arm']['ppl']:.4f}")
        ceil = rec["ceiling_hit"]
        where = ("none at their ceiling" if not ceil else
                 f"at ceilings spanning {ceil[0]:.2f}..{ceil[2]:.2f} nats "
                 f"(median {ceil[1]:.2f})")
        print(f"      log-prob mean NLL {rec['mean_nll_from_logprobs']:.4f} "
              f"(PPL {rec['file_ppl_from_logprobs']:.4f}, a LOWER bound: "
              f"{rec['saturated']} of {res['header']['scored_per_chunk']} tokens "
              f"({rec['saturated_pct']}%) {where})")
        print(f"      NLL deciles   {rec['deciles_nll']}")
        print(f"      worst tokens (actual -> what the model wanted):")
        for w in rec["worst"]:
            print(f"        {w['corpus_pos']:>7}  {w['nll']:>7.3f}"
                  f"{'*' if w['saturated'] else ' '}  {w['actual_text']!r:<24}"
                  f" -> {w['top1_text']!r:<24} ({w['top1_nll']:.3f})")


if __name__ == "__main__":
    main()
