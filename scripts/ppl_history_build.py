#!/usr/bin/env python3
"""Build corpora whose HISTORY content varies while the scored tokens and the
amount of history are held exactly fixed. Runs in the sidecar.

WHY THIS EXISTS. OPEN-WORK section 2's standing hypothesis is that the misfire
rate is set by what a chunk's history CONTAINS. Every instrument built so far
moves the chunk start, and that moves two things at once: with contiguous
history, fixing the scored token and the history AMOUNT determines the start,
and therefore the content. There is no third degree of freedom -- so the
hypothesis cannot be tested by any offset sweep, only by CONSTRUCTING a history.

WHAT IT BUILDS. For n_ctx N, perplexity scores in-chunk positions N/2+1 .. N-1.
So a chunk is [ H tokens of history | S tokens that get scored ] with
H = N/2+1 and S = N-1-N/2. Each arm concatenates a different H-token history
in front of THE SAME S scored tokens. Amount is identical by construction;
only content differs.

Arms are packed into ONE corpus, one chunk each, because perplexity.cpp:547
clears the memory before every batch -- a chunk's result depends on nothing but
its own N tokens. Three arms then cost ONE model load instead of three.

THE JOIN IS VERIFIED, NOT ASSUMED. A BPE cut is not automatically a token
boundary once its left context changes, and a join is the same hazard from the
other side: the last history token and the first scored token can merge, which
would silently shift every scored position and make "the same scored tokens" a
lie. Each arm is tokenized back through llama-server and BOTH halves are
compared id by id. Any mismatch is fatal.

PARSE_SPECIAL=FALSE IS LOAD-BEARING. /tokenize defaults it to True and that
alone re-tokenized a contiguous 8192-token slice to 8114 here. See
ppl_tokens.py's module docstring, which measured the same thing on the whole
corpus (157,626 against perplexity's 161,254).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request


def tokenize(text_bytes: bytes, base_url: str, timeout: float = 900.0) -> list[int]:
    body = json.dumps({
        "content": text_bytes.decode("utf-8", "surrogateescape"),
        "parse_special": False,
    }).encode()
    req = urllib.request.Request(base_url.rstrip("/") + "/tokenize", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as fh:
        return json.loads(fh.read())["tokens"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokmap", required=True,
                    help="ppl_cliff_stage.py's map: {corpus, ids, byte_offsets}")
    ap.add_argument("--n-ctx", type=int, default=8192)
    ap.add_argument("--scored-start", type=int, required=True,
                    help="corpus token index of the FIRST scored token")
    ap.add_argument("--arm", action="append", required=True, metavar="LABEL:START",
                    help="history arm: a label and the corpus token index where "
                         "its H-token history begins. Repeatable; order is the "
                         "chunk order in the output.")
    ap.add_argument("--out", required=True, help="corpus file to write")
    ap.add_argument("--manifest", required=True, help="JSON describing the arms")
    ap.add_argument("--url", required=True)
    args = ap.parse_args()

    tm = json.load(open(args.tokmap, encoding="utf-8"))
    ids, off = tm["ids"], tm["byte_offsets"]
    raw = open(tm["corpus"], "rb").read()

    N = args.n_ctx
    H = N // 2 + 1
    S = N - 1 - N // 2
    sc = args.scored_start
    want_scored = ids[sc:sc + S]
    if len(want_scored) != S:
        print(f"scored range {sc}..{sc+S-1} runs past the corpus ({len(ids)} tokens)",
              file=sys.stderr)
        return 2

    print(f"n_ctx={N}  history={H}  scored={S}  scored corpus tokens {sc}..{sc+S-1}")

    def piece(a: int, b: int) -> bytes:
        return raw[off[a]:off[b]]

    blob = b""
    arms = []
    for idx, spec in enumerate(args.arm):
        label, _, start_s = spec.partition(":")
        hs = int(start_s)
        if hs + H > len(ids):
            print(f"{label}: history {hs}..{hs+H-1} runs past the corpus", file=sys.stderr)
            return 2
        chunk = piece(hs, hs + H) + piece(sc, sc + S)
        got = tokenize(chunk, args.url)
        want_hist = ids[hs:hs + H]
        problems = []
        if len(got) != H + S:
            problems.append(f"token count {len(got)} != {H+S}")
        else:
            if got[:H] != want_hist:
                problems.append("history ids changed")
            if got[H:] != want_scored:
                bad = [i for i in range(S) if got[H + i] != want_scored[i]]
                problems.append(f"SCORED ids changed ({len(bad)}, first at {bad[0]})")
        status = "ok" if not problems else "; ".join(problems)
        print(f"  chunk {idx}  {label:<16} history {hs}..{hs+H-1}  "
              f"{len(chunk):>7} bytes  {status}")
        if problems:
            print("REFUSING: the join changed the tokens it must preserve.", file=sys.stderr)
            return 3
        arms.append({"chunk": idx, "label": label, "history_start": hs,
                     "history_tokens": H, "scored_start": sc, "scored_tokens": S})
        blob += chunk

    # perplexity.cpp:480 refuses a file shorter than 2*n_ctx and returns without
    # scoring anything, so a single-arm build still needs padding to two chunks.
    while len(arms) < 2:
        print("  (padding to 2*n_ctx: perplexity refuses a shorter file)")
        blob += piece(sc, sc + N)
        arms.append({"chunk": len(arms), "label": "_pad", "history_start": None})

    with open(args.out, "wb") as fh:
        fh.write(blob)
    total = tokenize(blob, args.url)
    print(f"wrote {args.out}: {len(blob)} bytes, {len(total)} tokens "
          f"(want {len(arms)*N})")
    if len(total) != len(arms) * N:
        print("REFUSING: the assembled corpus does not tokenize to whole chunks.",
              file=sys.stderr)
        return 4

    with open(args.manifest, "w", encoding="utf-8") as fh:
        json.dump({"n_ctx": N, "history_tokens": H, "scored_tokens": S,
                   "scored_start": sc, "source_corpus": tm["corpus"],
                   "arms": arms}, fh, indent=2)
    print(f"wrote {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
