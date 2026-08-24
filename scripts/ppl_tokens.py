#!/usr/bin/env python3
"""perplexity's OWN token array, and the per-token NLL behind a chunk's number.

WHY THIS EXISTS. `kv-cache-fidelity-measured.md` §3e found that the depth effect
is a CLIFF rather than a slope: over thirty 4096-token spans of `deep-plus-pi`
the 8192/2048 ratio has a median of 1.74 and an upper quartile of 18.9, and one
span moves 149,597x. "What makes a span a cliff" was left open, with a named
blocker: span boundaries are token offsets, and the only token->byte mapping
available was `llama-server`'s `/tokenize` SCALED by the ratio of two totals
(157,626 against 161,254), which drifts up to ~2,000 tokens across the file.

THE SCALING WAS NEVER NECESSARY, and that is the first thing this module fixes.
The two totals differ because of ONE flag, not because of two tokenizers:

    perplexity.cpp:473   common_tokenize(ctx, params.prompt, true)
                         -> add_special = true, parse_special = FALSE (the
                            default 4th argument of common_tokenize)

    llama-server /tokenize   parse_special defaults to TRUE

Measured on this box against `deep-plus-pi.txt`, 571,603 bytes:

    /tokenize  (defaults)                     157,626 tokens
    /tokenize  parse_special=true             157,626
    /tokenize  parse_special=FALSE            161,254   <- perplexity's count
    perplexity's own probe (probe-corpus.log) 161,254

So `parse_special=False` reproduces the count exactly and no scaling is needed.
`add_special` is a no-op on this model (Qwen3 sets add_bos=false): true and
false both return 157,626 above.

MATCHING TOTALS ARE NOT MATCHING ARRAYS, and this repo has already been bitten
by exactly that. §3e's own account: a corpus altered in 414 places produced
IDENTICAL token counts, so the control for length passed on a corrupt corpus and
only the alignment control caught it. A count is not a checksum. Hence
`read_logits_header`: `--kl-divergence-base` makes perplexity write its array to
disk before it decodes anything, and `ppl-cliff-run.sh` compares the two element
by element rather than by length.

    perplexity.cpp:462-469, 517-525 — the writer, in order:
        8   "_logits_"
        4   n_ctx    (int32)             <- written at open, before tokenizing
        4   n_vocab  (int32)
        4   n_chunk  (int32)
        4 * n_chunk * n_ctx   the evaluation tokens (llama_token = int32)
        then, per scored token, nv uint16 of log-probs (see LogitsBody)

    The token array is written BEFORE the first llama_decode, so a run killed
    the moment the file reaches 20 + n_chunk*n_ctx*4 bytes has cost one model
    load and no inference at all.

ONE TRAILING NEWLINE. `common_arg`'s `-f` handler (arg.cpp:1791-1800) pops a
single trailing '\n' from the file before it becomes params.prompt. Corpora
built by `capture.sh export` end in `<|im_end|>` with no trailing newline, so
this is currently a no-op — `strip_trailing_newline` applies it anyway, because
a corpus that ends in a newline would otherwise disagree in its last token and
that disagreement would be reported as a tokenizer mismatch.

WHAT THE BODY IS FOR. A chunk's perplexity is ONE number over 4095 scored
tokens, and §3e's cliff chunk (corpus 86017..90111 at n_ctx 8192) reports
4,313,018 — mean NLL 15.276 nats, against ln(151936) = 11.93 for a uniform
distribution over the vocabulary. The model is not uncertain there; it is
confidently wrong. Which tokens, and wrong in favour of WHAT, is not a question
an aggregate can answer, and `--kl-divergence-base` answers both: `LogitsBody`
reads the exact per-token NLL, and `top1()` decodes what the model would have
predicted instead.

    perplexity.cpp:80-106 — log_softmax's storage, per scored token:
        float  scale        = (max_logit - min_logit)/65535
        float  min_log_prob = min_logit - max_logit - log_sum_exp
        uint16 q[n_vocab]   = round((logit - min_logit)/scale), or 0 below it
      so   NLL(tok) = -(scale*q[tok] + min_log_prob)

    THE STORED NLL SATURATES, and a cliff is exactly where that bites:
        min_logit = max(min_logit, max_logit - 16)
    clamps the window 16 nats below the peak, so any token whose true NLL
    exceeds 16 + log_sum_exp is stored AT that value with q = 0. Read a
    saturated token as ">= this", never as "=". `LogitsBody.nll()` returns the
    saturation ceiling alongside every value so the caller can tell which is
    which, and `saturated()` counts them. The ARM's own number is exact — it is
    computed from the float logits, not from this file — so the file is an
    instrument for WHICH tokens and WHY, never for how much.

    THE CEILING IS PER RECORD, NOT PER CHUNK. It is 16 + log_sum_exp, and
    log_sum_exp comes from that position's own logits, so it varies across a
    chunk: over the 8192 chunk at corpus 86017..90111 the ceilings actually hit
    span several nats. A report that prints ONE ceiling for a chunk is printing
    a number that does not exist, and the first version of this analyser did
    exactly that — it printed record 0's NLL and called it the ceiling, which is
    only the ceiling if record 0 happens to be saturated. `saturated()` returns
    the min, median and max of the ceilings that were actually hit.
"""

from __future__ import annotations

import json
import struct
import urllib.request

MAGIC = b"_logits_"
HEADER_STRUCT = struct.Struct("<iii")  # n_ctx, n_vocab, n_chunk
HEADER_BYTES = 8 + HEADER_STRUCT.size


def strip_trailing_newline(raw: bytes) -> bytes:
    """What `-f FNAME` hands perplexity, given the bytes on disk.

    arg.cpp:1791-1800 pops ONE trailing '\\n' and nothing else — not a '\\r\\n'
    pair, not repeated newlines. Reproduced exactly rather than approximated,
    because a corpus whose last token differs would surface as a tokenizer
    disagreement and send the reader after the wrong thing.
    """
    if raw.endswith(b"\n"):
        return raw[:-1]
    return raw


# ---------------------------------------------------------------------------
# The server side: an exact token->byte map, cross-checked against the corpus.
# ---------------------------------------------------------------------------

def tokenize_with_pieces(text: str, base_url: str, timeout: float = 1200.0) -> list:
    """/tokenize with the two flags that make it perplexity's tokenizer.

    `parse_special=False` is the whole point (see the module docstring).
    `with_pieces=True` returns each token's bytes, which is what turns a token
    array into a byte map without 161,254 round trips.

    A piece that is not valid UTF-8 comes back as a LIST OF BYTE VALUES rather
    than a string — 24 of them in `deep-plus-pi.txt`, all inside byte-level BPE
    tokens that split a multi-byte character. Both shapes are handled; treating
    the list as a string would silently corrupt every offset after it.
    """
    body = json.dumps({"content": text, "parse_special": False,
                       "with_pieces": True}).encode()
    req = urllib.request.Request(base_url.rstrip("/") + "/tokenize", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as fh:
        payload = json.loads(fh.read())
    out = []
    for entry in payload["tokens"]:
        piece = entry["piece"]
        out.append((entry["id"],
                    piece.encode("utf-8") if isinstance(piece, str) else bytes(piece)))
    return out


def byte_offsets(pieces: list, raw: bytes) -> list:
    """Cumulative byte offset of every token boundary, PROVED against the file.

    Returns len(pieces)+1 offsets, so `raw[offs[a]:offs[b]]` is exactly the text
    of tokens [a, b).

    The concatenation of the pieces must reproduce `raw` byte for byte. That is
    not a formality: it is the only check that says the map is a map of THIS
    file rather than of something the tokenizer decided it looked like, and it
    is cheap. A mismatch raises with the first differing offset and the bytes on
    both sides, because "the map is wrong somewhere" is not a usable report.
    """
    offs = [0]
    for piece in pieces:
        offs.append(offs[-1] + len(piece))
    recon = b"".join(pieces)
    if recon != raw:
        limit = min(len(recon), len(raw))
        at = next((i for i in range(limit) if recon[i] != raw[i]), limit)
        raise ValueError(
            f"detokenized pieces do not reproduce the corpus: "
            f"{len(recon)} bytes against {len(raw)}, first difference at byte {at}\n"
            f"  pieces: {recon[max(0, at - 40):at + 40]!r}\n"
            f"  corpus: {raw[max(0, at - 40):at + 40]!r}")
    return offs


# ---------------------------------------------------------------------------
# The perplexity side: the array it actually scored.
# ---------------------------------------------------------------------------

def read_logits_header(path: str) -> dict:
    """(n_ctx, n_vocab, n_chunk, tokens) out of a --kl-divergence-base file.

    Reads the header and the token array and STOPS — the body behind it is
    n_chunk * (n_ctx - 1 - n_ctx/2) * nv * 2 bytes and this function never needs
    it. `ppl-cliff-run.sh` kills the writer as soon as the array is on disk, so
    the file it hands here is usually a truncated one and that is expected.
    """
    with open(path, "rb") as fh:
        head = fh.read(HEADER_BYTES)
        if len(head) < HEADER_BYTES or head[:8] != MAGIC:
            raise ValueError(f"{path} does not start with the _logits_ header: "
                             f"first {len(head)} bytes are {head[:20].hex()}")
        n_ctx, n_vocab, n_chunk = HEADER_STRUCT.unpack(head[8:])
        if n_ctx <= 0 or n_vocab <= 0 or n_chunk <= 0:
            raise ValueError(f"{path} header is not plausible: "
                             f"n_ctx={n_ctx} n_vocab={n_vocab} n_chunk={n_chunk}")
        want = n_chunk * n_ctx * 4
        blob = fh.read(want)
        if len(blob) < want:
            raise ValueError(
                f"{path} holds {len(blob)} of the {want} bytes of token array "
                f"({len(blob) // 4} of {n_chunk * n_ctx} tokens). The writer was "
                f"killed before the array was flushed; re-run and wait for the "
                f"file to reach {HEADER_BYTES + want} bytes.")
    return {"n_ctx": n_ctx, "n_vocab": n_vocab, "n_chunk": n_chunk,
            "tokens": list(struct.unpack(f"<{n_chunk * n_ctx}i", blob))}


def compare_arrays(mine: list, theirs: list, label_a: str = "server",
                   label_b: str = "perplexity") -> dict:
    """Element-by-element, over the prefix the shorter one covers.

    The two arrays are NOT expected to be the same length: perplexity writes
    n_chunk*n_ctx tokens and drops the corpus's final partial chunk, so at
    n_ctx=256 over 161,254 tokens it writes 161,024 and omits the last 230.
    That is a truncation, not a disagreement, and is reported as `covered`
    rather than folded into the verdict.
    """
    n = min(len(mine), len(theirs))
    first = None
    diffs = 0
    for i in range(n):
        if mine[i] != theirs[i]:
            diffs += 1
            if first is None:
                first = {"index": i, label_a: mine[i], label_b: theirs[i],
                         "context_" + label_a: mine[max(0, i - 5):i + 5],
                         "context_" + label_b: theirs[max(0, i - 5):i + 5]}
    return {"len_" + label_a: len(mine), "len_" + label_b: len(theirs),
            "covered": n, "mismatches": diffs, "first_mismatch": first,
            "verdict": "IDENTICAL" if diffs == 0 else "DIFFER"}


# ---------------------------------------------------------------------------
# The body: per-token NLL, and what the model wanted instead.
# ---------------------------------------------------------------------------

class LogitsBody:
    """Random access into the log-prob records of a --kl-divergence-base file.

    Record layout, from perplexity.cpp:94-105 (`nv` uint16 per scored token):

        [0:2]   float  scale
        [2:4]   float  min_log_prob
        [4:nv]  uint16 q[i] for i < n_vocab, then padding to an even count

    and the file holds `n_chunk` blocks of `n_ctx - 1 - n_ctx/2` such records,
    in chunk order, immediately after the token array.

    RECORD i OF A CHUNK SCORES TOKEN i + n_ctx/2 + 1 of that chunk, because
    perplexity.cpp:614-620 hands process_logits the logits from `first = n_ctx/2`
    onward and process_logits scores `tokens[i+1]`. Getting that off by one
    turns every NLL into its neighbour's, which reads as plausible noise rather
    than as an error, so `token_index_of` exists and is tested rather than being
    an inline `+ first + 1` at three call sites.
    """

    def __init__(self, path: str, header: dict = None):
        self.path = path
        self.h = header or read_logits_header(path)
        self.n_ctx = self.h["n_ctx"]
        self.n_vocab = self.h["n_vocab"]
        self.n_chunk = self.h["n_chunk"]
        self.nv = 2 * ((self.n_vocab + 1) // 2) + 4
        self.first = self.n_ctx // 2
        self.scored = self.n_ctx - 1 - self.first
        self.rec_bytes = self.nv * 2
        self.body0 = HEADER_BYTES + self.n_chunk * self.n_ctx * 4
        self._fh = open(path, "rb")

    def close(self):
        self._fh.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def token_index_of(self, i: int) -> int:
        """Which token of the chunk record `i` scores."""
        return i + self.first + 1

    def _record_offset(self, chunk: int, i: int) -> int:
        if not 0 <= chunk < self.n_chunk:
            raise IndexError(f"chunk {chunk} outside [0, {self.n_chunk})")
        if not 0 <= i < self.scored:
            raise IndexError(f"record {i} outside [0, {self.scored})")
        return self.body0 + (chunk * self.scored + i) * self.rec_bytes

    def _scalars(self, chunk: int, i: int):
        self._fh.seek(self._record_offset(chunk, i))
        raw = self._fh.read(8)
        if len(raw) < 8:
            raise EOFError(f"{self.path} is short of record ({chunk},{i}); the "
                           f"writer did not get this far")
        return struct.unpack("<ff", raw)

    def nll(self, chunk: int, i: int) -> dict:
        """NLL of the token record `i` scores, and the ceiling it saturates at.

        `ceiling` is what a token stored as q=0 reports: -min_log_prob, which is
        16 + log_sum_exp for this record. `saturated` says the stored value IS
        that ceiling, i.e. the true NLL is only known to be at least this. On
        ordinary text that flag is off; on a cliff chunk it is the finding.
        """
        scale, min_log_prob = self._scalars(chunk, i)
        tok = self.chunk_tokens(chunk)[self.token_index_of(i)]
        self._fh.seek(self._record_offset(chunk, i) + 8 + tok * 2)
        raw = self._fh.read(2)
        if len(raw) < 2:
            raise EOFError(f"{self.path} is short inside record ({chunk},{i})")
        q = struct.unpack("<H", raw)[0]
        value = -(scale * q + min_log_prob)
        ceiling = -min_log_prob
        return {"token": tok, "q": q, "nll": value, "ceiling": ceiling,
                "saturated": q == 0}

    def chunk_tokens(self, chunk: int) -> list:
        lo = chunk * self.n_ctx
        return self.h["tokens"][lo:lo + self.n_ctx]

    def top1(self, chunk: int, i: int) -> dict:
        """The token the model actually put its mass on, and by how much.

        Reads the whole n_vocab row (about 304 KiB for this model), so it is for
        the handful of positions a cliff investigation actually looks at, not
        for a sweep. Returns the argmax id, its NLL, and the NLL of the token
        that was really there, so "confidently wrong" is a number rather than an
        adjective.
        """
        scale, min_log_prob = self._scalars(chunk, i)
        self._fh.seek(self._record_offset(chunk, i) + 8)
        row = self._fh.read(self.n_vocab * 2)
        if len(row) < self.n_vocab * 2:
            raise EOFError(f"{self.path} is short inside record ({chunk},{i})")
        qs = struct.unpack(f"<{self.n_vocab}H", row)
        best = max(range(self.n_vocab), key=qs.__getitem__)
        actual = self.nll(chunk, i)
        return {"top1": best, "top1_nll": -(scale * qs[best] + min_log_prob),
                "actual": actual["token"], "actual_nll": actual["nll"],
                "actual_saturated": actual["saturated"]}

    def chunk_nll(self, chunk: int) -> list:
        """Every scored token of a chunk: (token index in chunk, id, nll, saturated).

        One seek per record rather than one read of the whole chunk: the body is
        1.24 GiB per chunk at n_ctx 8192 for this model's vocabulary, and all of
        it except 8 + 2 bytes per record is the part we are not asking about.
        """
        out = []
        for i in range(self.scored):
            rec = self.nll(chunk, i)
            out.append({"pos": self.token_index_of(i), "token": rec["token"],
                        "nll": rec["nll"], "ceiling": rec["ceiling"],
                        "saturated": rec["saturated"]})
        return out

    def saturated(self, chunk: int, rows: list = None) -> dict:
        rows = rows if rows is not None else self.chunk_nll(chunk)
        hit = sorted(r["ceiling"] for r in rows if r["saturated"])
        total = sum(r["nll"] for r in rows)
        return {"scored": len(rows), "saturated": len(hit),
                "saturated_pct": 100.0 * len(hit) / len(rows) if rows else 0.0,
                "ceiling_min": hit[0] if hit else None,
                "ceiling_median": hit[len(hit) // 2] if hit else None,
                "ceiling_max": hit[-1] if hit else None,
                "sum_nll": total,
                "mean_nll": total / len(rows) if rows else 0.0}


# ---------------------------------------------------------------------------
def _cli():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--header", help="a --kl-divergence-base file: print its header")
    ap.add_argument("--emit-tokens", help="with --header: write the token array here as JSON")
    ap.add_argument("--map", nargs=2, metavar=("CORPUS", "URL"),
                    help="build the token->byte map from a corpus and a llama-server")
    ap.add_argument("--emit-map", help="with --map: write the map here as JSON")
    ap.add_argument("--compare", nargs=2, metavar=("MAP_JSON", "LOGITS"),
                    help="compare a map's ids against perplexity's own array")
    args = ap.parse_args()

    if args.header:
        h = read_logits_header(args.header)
        print(f"n_ctx={h['n_ctx']} n_vocab={h['n_vocab']} n_chunk={h['n_chunk']} "
              f"tokens={len(h['tokens'])}")
        if args.emit_tokens:
            with open(args.emit_tokens, "w") as fh:
                json.dump({"n_ctx": h["n_ctx"], "n_vocab": h["n_vocab"],
                           "n_chunk": h["n_chunk"], "ids": h["tokens"]}, fh)
            print(f"wrote {args.emit_tokens}")

    if args.map:
        corpus, url = args.map
        with open(corpus, "rb") as fh:
            raw = strip_trailing_newline(fh.read())
        pieces = tokenize_with_pieces(raw.decode("utf-8"), url)
        offs = byte_offsets([p for _, p in pieces], raw)
        print(f"{len(pieces)} tokens, {offs[-1]} bytes, reconstruction EXACT")
        if args.emit_map:
            with open(args.emit_map, "w") as fh:
                json.dump({"corpus": corpus, "ids": [i for i, _ in pieces],
                           "byte_offsets": offs}, fh)
            print(f"wrote {args.emit_map}")

    if args.compare:
        map_json, logits = args.compare
        with open(map_json) as fh:
            m = json.load(fh)
        h = read_logits_header(logits)
        verdict = compare_arrays(m["ids"], h["tokens"])
        print(json.dumps(verdict, indent=2)[:2000])


if __name__ == "__main__":
    _cli()
