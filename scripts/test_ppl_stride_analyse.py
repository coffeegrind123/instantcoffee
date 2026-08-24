#!/usr/bin/env python3
"""Tests for ppl_stride_analyse.

The alignment arithmetic is the whole product here — if chunk k of the deep arm
is not the same token range as chunk k+d of the shallow arm, every number the
report prints is a comparison of different text and it will look completely
reasonable.  So the round-trip test synthesises logs from a per-token NLL that
depends ONLY on the absolute token index: any two arms must then agree exactly,
chunk for chunk, over their shared range.  A wrong offset breaks that; a right
one cannot.

Every refusal path is exercised too, because a parser that accepts a truncated
log silently reports an arm that stopped early as if it had finished.
"""

import math
import os
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ppl_stride_analyse as M


def write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def true_nll(t: int) -> float:
    """A per-token NLL that is a function of absolute position only."""
    return 2.0 + 1.5 * math.sin(t / 900.0) + 0.4 * ((t // 512) % 3)


def synth_log(window: int, stride: int, n_chunk: int, tokens: int = 70000,
              batch: int = 512, nll=true_nll) -> str:
    """A byte-plausible perplexity_v2 log for the given arm."""
    requested_c = window - stride // 2
    lines = [
        "0.04.402.915 W model has unused tensor blk.64.attn_norm.weight -- ignoring",
        f"0.00.100.000 I Will perform strided perplexity calculation -> "
        f"adjusting context size from {requested_c} to {window}",
        "3.17.096.934 I cmn          init: llama threadpool init, n_threads = 8",
        "3.17.228.032 I perplexity_v2: tokenizing the input ..",
        "3.17.405.128 I perplexity_v2: tokenization took 177.081 ms",
        f"3.17.405.200 I perplexity_v2: have {tokens} tokens. Calculation chunk = {window}",
        f"3.17.405.340 I perplexity_v2: computing over {n_chunk} chunks, n_ctx={window}, "
        f"batch_size={batch}, n_seq=1",
        "3.26.692.787 I perplexity_v2: 7.34 seconds per pass - ETA 2.07 minutes",
    ]
    cum = 0.0
    running = []
    for i in range(n_chunk):
        lo = i * stride + window - stride
        cum += sum(nll(t) for t in range(lo, lo + stride))
        running.append(f"[{i + 1}]{math.exp(cum / ((i + 1) * stride)):.4f},")
    lines.append("".join(running))
    lines.append("")
    return "\n".join(lines)


class TestParse(unittest.TestCase):
    def test_reads_structure_out_of_the_log(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            write(p, synth_log(8192, 512, 40))
            a = M.parse_arm(p)
        self.assertEqual(a["window"], 8192)
        self.assertEqual(a["stride"], 512)
        self.assertEqual(a["batch"], 512)
        self.assertEqual(a["tokens"], 70000)
        self.assertEqual(a["n_chunk"], 40)
        self.assertTrue(a["complete"])

    def test_stride_is_recovered_not_trusted(self):
        # W = C + S/2, so a 1024 stride must come back as 1024 with no hint.
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            write(p, synth_log(4096, 1024, 10))
            self.assertEqual(M.parse_arm(p)["stride"], 1024)

    def test_refuses_a_default_mode_log(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "v1.log")
            open(p, "w").write(
                "3.17.405.340 I perplexity: calculating perplexity over 17 chunks, "
                "n_ctx=4096, batch_size=2048, n_seq=1\n"
                "[1]3.0414,[2]17.3035,\n"
                "5.46.930.279 I Final estimate: PPL = 11.6055 +/- 0.29395\n"
            )
            with self.assertRaisesRegex(M.ParseError, "DEFAULT-mode"):
                M.parse_arm(p)

    def test_refuses_a_truncated_running_series(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            text = synth_log(2048, 512, 8).replace("[4]", "[5]", 1)
            write(p, text)
            with self.assertRaisesRegex(M.ParseError, "not contiguous"):
                M.parse_arm(p)

    def test_incomplete_arm_is_flagged_not_rejected(self):
        # A killed arm still has usable chunks; it must be reported as short.
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            text = synth_log(2048, 512, 8)
            text = text.replace("computing over 8 chunks", "computing over 40 chunks")
            write(p, text)
            a = M.parse_arm(p)
        self.assertEqual(a["n_chunk"], 8)
        self.assertEqual(a["n_chunk_planned"], 40)
        self.assertFalse(a["complete"])

    def test_refuses_a_log_with_no_chunks(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            text = synth_log(2048, 512, 4).rsplit("\n", 2)[0] + "\n"
            write(p, text)
            with self.assertRaisesRegex(M.ParseError, "no '\\[i\\]PPL,'"):
                M.parse_arm(p)

    def test_refuses_a_log_that_never_tokenized(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            write(p, "3.17.228.032 I perplexity_v2: tokenizing the input ..\n")
            with self.assertRaisesRegex(M.ParseError, "have N tokens"):
                M.parse_arm(p)

    def test_refuses_a_window_disagreement(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            text = synth_log(4096, 512, 4).replace("n_ctx=4096", "n_ctx=8192")
            write(p, text)
            with self.assertRaisesRegex(M.ParseError, "same quantity"):
                M.parse_arm(p)


class TestPerChunk(unittest.TestCase):
    def test_differencing_recovers_the_generating_nll(self):
        stride, window, n = 512, 2048, 30
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            write(p, synth_log(window, stride, n))
            a = M.parse_arm(p)
        got = M.per_chunk_nll(a["running"], stride)
        for i in range(n):
            lo = i * stride + window - stride
            want = sum(true_nll(t) for t in range(lo, lo + stride)) / stride
            # 4-decimal printing is the only loss; late chunks are the worst case.
            self.assertAlmostEqual(got[i], want, places=2,
                                   msg=f"chunk {i}: {got[i]} vs {want}")

    def test_range_aggregate_is_near_exact(self):
        stride, window, n = 512, 4096, 40
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.log")
            write(p, synth_log(window, stride, n))
            a = M.parse_arm(p)
        got, ntok = M.range_nll(a["running"], stride, 10, 30)
        lo = 10 * stride + window - stride
        hi = 30 * stride + window - stride + stride
        want = sum(true_nll(t) for t in range(lo, hi)) / (hi - lo)
        self.assertEqual(ntok, hi - lo)
        self.assertAlmostEqual(got, want, places=5)


class TestAlignment(unittest.TestCase):
    STRIDE = 512

    def _arms(self, d, windows, n_chunks):
        arms = []
        for w, n in zip(windows, n_chunks):
            p = os.path.join(d, f"w{w}.log")
            write(p, synth_log(w, self.STRIDE, n))
            arms.append(M.parse_arm(p))
        return arms

    def test_scored_span_matches_the_source(self):
        # chunk i of window W scores [i*S + W - S, i*S + W - 1]
        self.assertEqual(M.scored_span(8192, 512, 0), (7680, 8191))
        self.assertEqual(M.scored_span(2048, 512, 12), (7680, 8191))
        self.assertEqual(M.scored_span(2048, 512, 0), (1536, 2047))

    def test_same_tokens_give_the_same_number_across_windows(self):
        """The load-bearing test. NLL here depends only on absolute position, so
        correctly aligned arms must agree; a one-chunk offset would not."""
        with tempfile.TemporaryDirectory() as d:
            arms = self._arms(d, [2048, 4096, 8192], [60, 56, 48])
            res = M.analyse(arms, self.STRIDE)
        self.assertEqual(res["lo_tok"], 7680)
        for c in res["common"]:
            self.assertAlmostEqual(c["mean_nll"], res["common"][0]["mean_nll"], places=4)
        for row in res["rows"]:
            vals = [row[w] for w in (2048, 4096, 8192)]
            self.assertAlmostEqual(max(vals), min(vals), places=2, msg=str(row))

    def test_a_deliberate_offset_is_detected_by_that_test(self):
        """Control for the control: shift one arm's content by a chunk and the
        agreement above must break, or the test above proves nothing."""
        with tempfile.TemporaryDirectory() as d:
            p2 = os.path.join(d, "w2048.log")
            p8 = os.path.join(d, "w8192.log")
            write(p2, synth_log(2048, 512, 60))
            # Same window label, but generated as if its chunks started a stride late.
            open(p8, "w").write(
                synth_log(8192, 512, 48, nll=lambda t: true_nll(t + 512))
            )
            arms = [M.parse_arm(p2), M.parse_arm(p8)]
            res = M.analyse(arms, self.STRIDE)
        diffs = [abs(r[2048] - r[8192]) for r in res["rows"]]
        self.assertGreater(max(diffs), 0.05)

    def test_common_range_respects_the_shortest_arm(self):
        with tempfile.TemporaryDirectory() as d:
            arms = self._arms(d, [2048, 8192], [60, 10])
            res = M.analyse(arms, self.STRIDE)
        # deep arm: chunks 0..9  -> tokens 7680..12799
        self.assertEqual(res["lo_tok"], 7680)
        self.assertEqual(res["hi_tok"], 12799)
        deep = [c for c in res["common"] if c["window"] == 8192][0]
        shallow = [c for c in res["common"] if c["window"] == 2048][0]
        self.assertEqual((deep["first_chunk"], deep["last_chunk"]), (0, 9))
        self.assertEqual((shallow["first_chunk"], shallow["last_chunk"]), (12, 21))

    def test_refuses_windows_that_do_not_land_on_stride_boundaries(self):
        with tempfile.TemporaryDirectory() as d:
            arms = self._arms(d, [2048, 2304], [40, 40])
            with self.assertRaisesRegex(M.ParseError, "whole number of strides"):
                M.analyse(arms, self.STRIDE)

    def test_refuses_mixed_strides(self):
        with tempfile.TemporaryDirectory() as d:
            a = os.path.join(d, "a.log"); write(a, synth_log(2048, 512, 20))
            b = os.path.join(d, "b.log"); write(b, synth_log(4096, 1024, 20))
            with self.assertRaisesRegex(M.ParseError, "cannot be aligned"):
                M.analyse([M.parse_arm(a), M.parse_arm(b)], 512)

    def test_no_overlap_is_reported_not_crashed(self):
        with tempfile.TemporaryDirectory() as d:
            arms = self._arms(d, [2048, 8192], [4, 4])
            res = M.analyse(arms, self.STRIDE)
        self.assertEqual(res["common"], [])
        txt = M.format_report(arms, res, self.STRIDE, [])
        self.assertIn("NO SHARED TOKEN RANGE", txt)


class TestNullControl(unittest.TestCase):
    def test_identical_repeat_is_reported_identical(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ("a.log", "b.log"):
                write(os.path.join(d, name), synth_log(2048, 512, 20))
            out = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                              "ppl_stride_analyse.py"),
                 os.path.join(d, "a.log"), os.path.join(d, "b.log"), "--stride", "512"],
                capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("IDENTICAL to every printed digit", out.stdout)

    def test_a_differing_repeat_is_named_at_its_first_chunk(self):
        with tempfile.TemporaryDirectory() as d:
            good = synth_log(2048, 512, 20)
            # One printed value moved, chunk index untouched — exactly what a
            # non-deterministic engine would produce.
            bad = re.sub(r"\[7\][0-9.]+,", "[7]9.9999,", good, count=1)
            self.assertNotEqual(good, bad)
            write(os.path.join(d, "a.log"), good)
            write(os.path.join(d, "b.log"), bad)
            out = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                              "ppl_stride_analyse.py"),
                 os.path.join(d, "a.log"), os.path.join(d, "b.log"), "--stride", "512"],
                capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("DIFFERS", out.stdout)
        self.assertIn("first divergence at chunk 7", out.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
