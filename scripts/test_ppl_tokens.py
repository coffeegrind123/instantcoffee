#!/usr/bin/env python3
"""Tests for ppl_tokens.

THE LOAD-BEARING TEST is test_nll_round_trips_through_the_writers_arithmetic: it
builds a logits file by running perplexity.cpp's OWN quantisation on synthetic
logits, then asserts that LogitsBody.nll recovers the true NLL to within the
quantisation step. Its control is
test_nll_saturates_and_says_so — a token deliberately pushed below the 16-nat
window must come back flagged `saturated` and equal to the ceiling, or the first
test is only proving that a number survived a round trip.

The second load-bearing pair is test_record_index_maps_to_the_right_token
against test_offsets_are_not_off_by_one_between_chunks: an off-by-one in
`token_index_of` or in `_record_offset` returns a neighbour's NLL, which is a
plausible number rather than an error, so both are asserted against a file whose
records are constructed to be distinguishable.
"""

from __future__ import annotations

import math
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ppl_tokens import (  # noqa: E402
    HEADER_BYTES, LogitsBody, byte_offsets, compare_arrays, read_logits_header,
    strip_trailing_newline)


# ---------------------------------------------------------------------------
# perplexity.cpp:78-106, reimplemented so the tests exercise the real layout.
# ---------------------------------------------------------------------------
def encode_record(logits: list) -> bytes:
    n_vocab = len(logits)
    nv = 2 * ((n_vocab + 1) // 2) + 4
    max_logit = max(logits)
    min_logit = max(min(logits), max_logit - 16)
    sum_exp = sum(math.exp(v - max_logit) for v in logits)
    log_sum_exp = math.log(sum_exp)
    min_log_prob = min_logit - max_logit - log_sum_exp
    scale = (max_logit - min_logit) / 65535.0
    qs = []
    for v in logits:
        if scale and v > min_logit:
            qs.append(max(0, min(65535, int(round((v - min_logit) / scale)))))
        else:
            qs.append(0)
    pad = nv - 4 - n_vocab
    return (struct.pack("<ff", scale, min_log_prob)
            + struct.pack(f"<{n_vocab}H", *qs)
            + b"\x00" * (2 * pad))


def write_logits_file(path: str, n_ctx: int, n_vocab: int, tokens: list,
                      logits_for) -> None:
    """`logits_for(chunk, record_index) -> list of n_vocab floats`."""
    n_chunk = len(tokens) // n_ctx
    first = n_ctx // 2
    scored = n_ctx - 1 - first
    with open(path, "wb") as fh:
        fh.write(b"_logits_")
        fh.write(struct.pack("<iii", n_ctx, n_vocab, n_chunk))
        fh.write(struct.pack(f"<{n_chunk * n_ctx}i", *tokens[:n_chunk * n_ctx]))
        for c in range(n_chunk):
            for i in range(scored):
                fh.write(encode_record(logits_for(c, i)))


def true_nll(logits: list, tok: int) -> float:
    m = max(logits)
    return m + math.log(sum(math.exp(v - m) for v in logits)) - logits[tok]


# ---------------------------------------------------------------------------
class TrailingNewline(unittest.TestCase):
    def test_pops_exactly_one(self):
        self.assertEqual(strip_trailing_newline(b"abc\n"), b"abc")
        self.assertEqual(strip_trailing_newline(b"abc\n\n"), b"abc\n")
        self.assertEqual(strip_trailing_newline(b"abc"), b"abc")

    def test_does_not_touch_a_crlf_pair_beyond_the_newline(self):
        # arg.cpp pops '\n' and stops; the '\r' before it stays. A corpus full
        # of CR progress bars is exactly where getting this wrong would matter.
        self.assertEqual(strip_trailing_newline(b"abc\r\n"), b"abc\r")


class ByteOffsets(unittest.TestCase):
    def test_offsets_index_the_corpus(self):
        pieces = [b"he", b"llo", b" wor", b"ld"]
        raw = b"".join(pieces)
        offs = byte_offsets(pieces, raw)
        self.assertEqual(len(offs), len(pieces) + 1)
        self.assertEqual(raw[offs[1]:offs[3]], b"llo wor")

    def test_multibyte_piece_counts_its_bytes_not_its_characters(self):
        pieces = ["é".encode(), b"x"]
        offs = byte_offsets(pieces, b"".join(pieces))
        self.assertEqual(offs, [0, 2, 3])

    def test_mismatch_raises_and_names_the_byte(self):
        with self.assertRaises(ValueError) as cm:
            byte_offsets([b"abc", b"XYZ"], b"abcdef")
        self.assertIn("first difference at byte 3", str(cm.exception))


class Header(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_reads_what_the_writer_wrote(self):
        path = os.path.join(self.dir, "a.logits")
        toks = list(range(64))
        write_logits_file(path, 8, 5, toks, lambda c, i: [0.0] * 5)
        h = read_logits_header(path)
        self.assertEqual((h["n_ctx"], h["n_vocab"], h["n_chunk"]), (8, 5, 8))
        self.assertEqual(h["tokens"], toks)

    def test_rejects_a_file_that_is_not_one(self):
        path = os.path.join(self.dir, "b.logits")
        with open(path, "wb") as fh:
            fh.write(b"not a logits file at all")
        with self.assertRaises(ValueError):
            read_logits_header(path)

    def test_a_truncated_array_is_an_error_not_a_short_list(self):
        # The whole point of killing the writer early is that the array is
        # complete when we stop it. A file stopped one byte too soon must say
        # so rather than hand back a plausible prefix.
        path = os.path.join(self.dir, "c.logits")
        write_logits_file(path, 8, 5, list(range(64)), lambda c, i: [0.0] * 5)
        want = HEADER_BYTES + 8 * 8 * 4
        with open(path, "rb") as fh:
            data = fh.read(want - 4)
        with open(path, "wb") as fh:
            fh.write(data)
        with self.assertRaises(ValueError) as cm:
            read_logits_header(path)
        self.assertIn("token array", str(cm.exception))


class Compare(unittest.TestCase):
    def test_identical(self):
        v = compare_arrays([1, 2, 3], [1, 2, 3])
        self.assertEqual(v["verdict"], "IDENTICAL")
        self.assertEqual(v["mismatches"], 0)

    def test_truncation_is_not_a_disagreement(self):
        # perplexity drops the corpus's final partial chunk. That is coverage,
        # not a mismatch, and folding it into the verdict would fail every run.
        v = compare_arrays([1, 2, 3, 4, 5], [1, 2, 3])
        self.assertEqual(v["verdict"], "IDENTICAL")
        self.assertEqual(v["covered"], 3)

    def test_a_single_differing_id_is_caught_and_located(self):
        v = compare_arrays([1, 2, 9, 4], [1, 2, 3, 4])
        self.assertEqual(v["verdict"], "DIFFER")
        self.assertEqual(v["mismatches"], 1)
        self.assertEqual(v["first_mismatch"]["index"], 2)

    def test_equal_length_is_not_equal_content(self):
        # §3e's own lesson: a corpus altered in 414 places produced identical
        # token COUNTS. A length check must not be able to pass here.
        v = compare_arrays([1, 2, 3], [3, 2, 1])
        self.assertEqual(v["verdict"], "DIFFER")


class Body(unittest.TestCase):
    N_CTX = 8
    N_VOCAB = 6

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "d.logits")
        # tokens 0..31 over 4 chunks of 8; every record gets logits that peak on
        # a DIFFERENT vocab entry per (chunk, record), so a misread record is a
        # different number rather than a similar one.
        self.tokens = list(range(32))
        self.logit_table = {}

        def logits_for(c, i):
            base = [0.0] * self.N_VOCAB
            base[(c + i) % self.N_VOCAB] = 4.0 + c + i
            self.logit_table[(c, i)] = base
            return base

        write_logits_file(self.path, self.N_CTX, self.N_VOCAB, self.tokens, logits_for)

    def test_record_index_maps_to_the_right_token(self):
        with LogitsBody(self.path) as b:
            self.assertEqual(b.first, 4)
            self.assertEqual(b.scored, 3)
            # record 0 of a chunk scores the chunk's token at index 5
            self.assertEqual(b.token_index_of(0), 5)
            self.assertEqual(b.token_index_of(2), 7)
            self.assertEqual(b.nll(0, 0)["token"], self.tokens[5])
            self.assertEqual(b.nll(2, 1)["token"], self.tokens[2 * 8 + 6])

    def test_offsets_are_not_off_by_one_between_chunks(self):
        with LogitsBody(self.path) as b:
            # the last record of chunk 0 and the first of chunk 1 are distinct
            a = b.top1(0, b.scored - 1)["top1"]
            c = b.top1(1, 0)["top1"]
            self.assertEqual(a, (0 + 2) % self.N_VOCAB)
            self.assertEqual(c, (1 + 0) % self.N_VOCAB)

    def test_nll_round_trips_through_the_writers_arithmetic(self):
        with LogitsBody(self.path) as b:
            for (c, i), logits in list(self.logit_table.items())[:12]:
                tok = self.tokens[c * self.N_CTX + b.token_index_of(i)]
                if tok >= self.N_VOCAB:
                    continue
                got = b.nll(c, i)
                want = true_nll(logits, tok)
                step = (max(logits) - max(min(logits), max(logits) - 16)) / 65535.0
                self.assertLess(abs(got["nll"] - want), step + 1e-4,
                                f"record ({c},{i}) token {tok}")

    def test_nll_saturates_and_says_so(self):
        path = os.path.join(self.dir, "e.logits")
        n_vocab = 4
        # token 3 sits 40 nats below the peak: far outside the 16-nat window, so
        # the writer stores q=0 and the reader must report the ceiling, flagged.
        logits = [50.0, 0.0, 0.0, 10.0]

        def logits_for(c, i):
            return logits

        write_logits_file(path, 8, n_vocab, [3] * 32, logits_for)
        with LogitsBody(path) as b:
            rec = b.nll(0, 0)
            self.assertTrue(rec["saturated"])
            self.assertAlmostEqual(rec["nll"], rec["ceiling"], places=5)
            self.assertLess(rec["nll"], true_nll(logits, 3))
            self.assertAlmostEqual(rec["ceiling"], 16.0, delta=0.01)

    def test_top1_reports_the_argmax_and_the_actual_side_by_side(self):
        path = os.path.join(self.dir, "f.logits")
        n_vocab = 4
        logits = [0.0, 9.0, 0.0, 0.0]   # the model wants token 1
        write_logits_file(path, 8, n_vocab, [2] * 32, lambda c, i: logits)
        with LogitsBody(path) as b:
            t = b.top1(0, 0)
            self.assertEqual(t["top1"], 1)
            self.assertEqual(t["actual"], 2)
            self.assertLess(t["top1_nll"], t["actual_nll"])

    def test_out_of_range_is_an_error_not_a_wrong_number(self):
        with LogitsBody(self.path) as b:
            with self.assertRaises(IndexError):
                b.nll(99, 0)
            with self.assertRaises(IndexError):
                b.nll(0, b.scored)

    def test_the_ceiling_is_per_record_and_record_zero_is_not_it(self):
        """The bug this was written for: the first analyser printed record 0's
        NLL as "the chunk's ceiling". It is only the ceiling if record 0 is
        saturated, and the ceiling is 16 + log_sum_exp, which differs per
        record. Built so record 0 is NOT saturated and the two that are have
        DIFFERENT ceilings — a single-number report cannot pass this."""
        path = os.path.join(self.dir, "g.logits")
        n_vocab = 4
        table = {
            0: [0.0, 0.1, 0.2, 0.3],          # flat: token 3 is nowhere near the clamp
            1: [50.0, 0.0, 0.0, 0.0],         # token 3 is 50 nats down -> saturated
            2: [90.0, 89.0, 89.0, 40.0],      # saturated too, but three near-equal
                                              # top logits make log_sum_exp ~0.55
                                              # instead of ~0, so its ceiling is
                                              # half a nat higher than record 1's
        }
        write_logits_file(path, 8, n_vocab, [3] * 32, lambda c, i: table[i])
        with LogitsBody(path) as b:
            rows = b.chunk_nll(0)
            self.assertFalse(rows[0]["saturated"])
            s = b.saturated(0, rows)
            self.assertEqual(s["saturated"], 2)
            self.assertNotAlmostEqual(rows[0]["nll"], s["ceiling_median"], places=3)
            self.assertLess(s["ceiling_min"], s["ceiling_max"])
            hit = sorted(r["ceiling"] for r in rows if r["saturated"])
            self.assertAlmostEqual(s["ceiling_min"], hit[0], places=6)
            self.assertAlmostEqual(s["ceiling_max"], hit[-1], places=6)

    def test_saturated_summary_counts_what_chunk_nll_flags(self):
        with LogitsBody(self.path) as b:
            s = b.saturated(0)
            rows = b.chunk_nll(0)
            self.assertEqual(s["scored"], len(rows))
            self.assertEqual(s["saturated"], sum(1 for r in rows if r["saturated"]))
            self.assertAlmostEqual(s["sum_nll"], sum(r["nll"] for r in rows), places=6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
