#!/usr/bin/env python3
"""Build the token map and the isolated-chunk slice files. Runs in the sidecar.

WHY THIS IS A FILE AND NOT A `python -c "..."` BLOCK IN THE RUNNER.

It used to be the latter, interpolated into a double-quoted shell string. Two
things go wrong there and both are silent:

  - A backtick in a COMMENT is command substitution. Measured 2026-08-24: the
    word ``sl`` in backticks produced `ppl-cliff-run.sh: line 245: sl: command
    not found` and the shell spliced the empty result into the Python source. It
    happened to land inside a comment, so nothing was corrupted — that is luck,
    not a design.
  - A double quote anywhere in the block terminates the string early and the
    rest is parsed as shell. That one does fail loudly, but only at the point
    the runner has already checked its preflight and is about to stop llama.

Neither can happen to a file. The runner passes arguments; the shell parses
nothing but arguments.

WHAT IT DOES, in the order the checks matter.

  1. Tokenize the corpus through llama-server with ``parse_special=False``,
     which is what perplexity does (see ppl_tokens.py), and PROVE the map by
     reconstructing the corpus from the pieces byte for byte.
  2. For each ``N:A:K`` spec, cut the byte range for corpus tokens
     [A, A + max(K,2)*N) and re-tokenize the cut to check it still produces the
     same ids. A BPE cut is not automatically a token boundary once the left
     context is gone, and the failure mode is a file that looks right.
  3. Write the slice PLUS ONE NEWLINE. ``arg.cpp:1791-1800`` pops a single
     trailing newline from a -f file, so a slice that ends in one arrives a
     token short — and perplexity does not complain: ``n_chunk`` is
     ``min(--chunks, tokens/n_ctx)``, so it quietly scores K-1 chunks and exits
     0. Measured on the 8192:4096:3 slice, which announced two chunks and lost
     the third. Appending unconditionally means the pop always takes this byte.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ppl_tokens as P  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--corpus-base", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--specs", required=True, help="comma-separated N:A:K")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    with open(args.corpus, "rb") as fh:
        raw = P.strip_trailing_newline(fh.read())
    pieces = P.tokenize_with_pieces(raw.decode("utf-8"), args.url)
    ids = [i for i, _ in pieces]
    offs = P.byte_offsets([p for _, p in pieces], raw)
    print(f"    map           {len(ids)} tokens, {offs[-1]} bytes, reconstruction EXACT")

    map_path = os.path.join(args.outdir, f"{args.corpus_base}.tokmap.json")
    with open(map_path, "w") as fh:
        json.dump({"corpus": args.corpus, "ids": ids, "byte_offsets": offs}, fh)
    print(f"    wrote         {map_path}")

    bad = 0
    for spec in args.specs.split(","):
        n, a, k = (int(x) for x in spec.split(":"))
        span = k * n if k > 2 else 2 * n
        if a + span > len(ids):
            print(f"    {spec:<20} REFUSED: [{a}, {a + span}) runs past the corpus "
                  f"({len(ids)} tokens)")
            bad = 1
            continue
        sliced = raw[offs[a]:offs[a + span]]
        got = [i for i, _ in P.tokenize_with_pieces(sliced.decode("utf-8"), args.url)]
        want = ids[a:a + span]
        if got != want:
            d = next((i for i in range(min(len(got), len(want))) if got[i] != want[i]), None)
            print(f"    {spec:<20} MISMATCH: {len(got)} tokens against {len(want)}, "
                  f"first difference at {d}")
            bad = 1
            continue
        path = os.path.join(args.outdir, f"{args.corpus_base}-c{n}-a{a}-k{k}.txt")
        with open(path, "wb") as fh:
            fh.write(sliced + b"\n")
        print(f"    {spec:<20} {len(sliced)} bytes + 1 newline for -f to pop, "
              f"{len(want)} tokens, re-tokenizes EXACT -> {os.path.basename(path)}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
