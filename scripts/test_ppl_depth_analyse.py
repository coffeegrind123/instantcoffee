#!/usr/bin/env python3
"""Tests for ppl_depth_analyse.

THE LOAD-BEARING TEST is test_matched_arms_agree_when_nll_is_positional: it
synthesises logs from an NLL that depends ONLY on the absolute corpus index, so
two depths that really do score the same token set must return the same
perplexity to the printed precision. Its control is
test_matched_arms_diverge_when_nll_depends_on_history — the same machinery with
an NLL that depends on how much history the token carries must NOT agree, or the
first test is passing for a reason that has nothing to do with the arithmetic.

A test that can only pass is not a test. Both directions are asserted.
"""

from __future__ import annotations

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ppl_depth_analyse import (  # noqa: E402
    PassLog, _fmt_arm, _fmt_span_map, alignment_control, asymmetry_bound_pct,
    chunks_in_window, combine_arm, parse_log, partition_pairs,
    scored_corpus_range, span_map)


# ---------------------------------------------------------------------------
# A synthetic llama-perplexity log, built from a per-token NLL we choose.
# ---------------------------------------------------------------------------
def positional_nll(corpus_pos: int, history: int) -> float:
    """Depends only on WHICH token it is. Deterministic, no RNG, no seed drift."""
    return 1.5 + 0.5 * math.sin(corpus_pos * 0.017) + 0.25 * ((corpus_pos * 37) % 11) / 11.0


def history_nll(corpus_pos: int, history: int) -> float:
    """Depends on how much history the token carries. The control's control."""
    return positional_nll(corpus_pos, history) + 0.0004 * history


def boundary_nll(corpus_pos: int, history: int) -> float:
    """Depends on WHERE THE CHUNK STARTED, not on the token or its history.

    A scored token at corpus position `p` carrying `h` tokens of history sits in
    a chunk that began at corpus position `p - h`. So an NLL written as a
    function of `p - h` is exactly a chunk-boundary-placement effect and nothing
    else — which is the alternative reading of the 8192 result, expressed as
    something the comparison has to be able to detect.
    """
    return 1.5 + 2.0 * (((corpus_pos - history) // 2048) % 2)


FILLER_NLL = 4.0


def synth_log(n_ctx: int, filler: int, n_chunk: int, nll_fn,
              n_corpus: int = 10 ** 9) -> str:
    """Render a pass the way llama-perplexity renders one.

    Only the two things the parser reads are reproduced faithfully: the header
    line and the running `[i]PPL,` series to four decimals. The four-decimal
    truncation is deliberate — it is exactly the precision the real analysis has
    to survive.
    """
    S = n_ctx - 1 - n_ctx // 2
    out = [f"3.26.256.694 I perplexity: tokenizing the input ..",
           f"3.26.424.356 I perplexity: calculating perplexity over {n_chunk} "
           f"chunks, n_ctx={n_ctx}, batch_size=2048, n_seq=1"]
    cum = 0.0
    series = []
    for c in range(n_chunk):
        for off in range(n_ctx // 2 + 1, n_ctx):
            a = c * n_ctx + off
            p = a - filler
            cum += FILLER_NLL if (p < 0 or p >= n_corpus) else nll_fn(p, off)
        series.append(f"[{c + 1}]{math.exp(cum / ((c + 1) * S)):.4f},")
    out.append("".join(series))
    out.append(f"4.15.331.433 I Final estimate: PPL = "
               f"{math.exp(cum / (n_chunk * S)):.4f} +/- 1.0")
    return "\n".join(out)


def arm_ppl(n_ctx: int, nll_fn, win_lo: int, win_hi: int, n_chunk_pairs=None):
    """Both rotations at one depth, through the real combine_arm()."""
    f_hi = n_ctx // 2
    chunks = n_chunk_pairs or (win_hi // n_ctx)
    logs, fills = [], []
    for f in (0, f_hi):
        text = synth_log(n_ctx, f, chunks, nll_fn)
        logs.append(parse_log(text, f"arm-{n_ctx}-f{f}.log"))
        fills.append(f)
    return combine_arm(logs, fills, win_lo, win_hi)


REAL_LOG = """0.04.008.730 W model has unused tensor blk.64.attn_norm.weight -- ignoring
3.26.256.694 I perplexity: tokenizing the input ..
3.26.424.197 I perplexity: tokenization took 167.495 ms
3.26.424.356 I perplexity: calculating perplexity over 4 chunks, n_ctx=16384, batch_size=2048, n_seq=1
3.48.174.183 I perplexity: 21.75 seconds per pass - ETA 1.43 minutes
[1]653.5247,[2]226.9466,[3]153.0130,4.15.331.433 I Final estimate: PPL = 94.0001 +/- 3.67534
[4]94.0001,
"""


class TestParse(unittest.TestCase):
    def test_parses_a_real_log(self):
        p = parse_log(REAL_LOG, "D1.log")
        self.assertEqual(p.n_ctx, 16384)
        self.assertEqual(p.n_chunk, 4)
        self.assertEqual(p.n_seq, 1)
        self.assertEqual(p.cum_ppl[1], 653.5247)
        self.assertEqual(p.cum_ppl[4], 94.0001)
        self.assertEqual(p.final_ppl, 94.0001)

    def test_scored_per_chunk_matches_perplexity_cpp(self):
        # n_token = n_ctx - 1 - first, first = n_ctx/2
        for n in (2048, 4096, 8192, 16384):
            p = PassLog(path="x", n_ctx=n, n_chunk=1, batch_size=2048, n_seq=1)
            self.assertEqual(p.scored_per_chunk, n // 2 - 1)

    def test_error_path_yields_the_token_count(self):
        text = ("perplexity: you need at least 80000 tokens to evaluate perplexity "
                "with a context of 40000\n"
                "perplexity: the data file you provided tokenizes to only 71077 tokens\n")
        p = parse_log(text, "probe.log")
        self.assertEqual(p.token_count, 71077)
        self.assertEqual(p.n_ctx, 0)

    def test_unfinished_run_is_refused(self):
        text = synth_log(2048, 0, 8, positional_nll)
        text = text.replace("[8]", "[9]")  # chunk 8 never printed
        with self.assertRaises(ValueError):
            parse_log(text, "short.log")

    def test_not_a_perplexity_log_is_refused(self):
        with self.assertRaises(ValueError):
            parse_log("ggml_cuda_init: found 1 CUDA device\n", "junk.log")

    def test_cum_nll_zero_at_chunk_zero(self):
        p = parse_log(REAL_LOG, "D1.log")
        self.assertEqual(p.cum_nll(0), 0.0)

    def test_window_nll_telescopes(self):
        p = parse_log(synth_log(2048, 0, 8, positional_nll), "a.log")
        per = p.per_chunk_nll()
        self.assertAlmostEqual(p.window_nll(3, 6), sum(per[i] for i in (3, 4, 5, 6)),
                               places=6)


class TestChunkGeometry(unittest.TestCase):
    def test_unshifted_scores_the_top_half(self):
        self.assertEqual(scored_corpus_range(2048, 0, 0), (1025, 2047))
        self.assertEqual(scored_corpus_range(2048, 0, 3), (7169, 8191))

    def test_half_chunk_filler_scores_the_complement(self):
        self.assertEqual(scored_corpus_range(2048, 1024, 0), (1, 1023))
        self.assertEqual(scored_corpus_range(2048, 1024, 4), (8193, 9215))

    def test_the_two_rotations_partition_the_corpus(self):
        n, m = 2048, 65536
        seen = set()
        for f in (0, n // 2):
            for c in range(m // n):
                lo, hi = scored_corpus_range(n, f, c)
                for p in range(max(lo, 0), hi + 1):
                    self.assertNotIn(p, seen, "a token was scored twice")
                    seen.add(p)
        missed = [p for p in range(1, m) if p not in seen]
        # Exactly the multiples of N/2, and nothing else.
        self.assertEqual(missed, [p for p in range(1, m) if p % (n // 2) == 0])

    def test_window_selection_matches_hand_arithmetic(self):
        # Worked out by hand against perplexity.cpp before any of this ran.
        self.assertEqual(chunks_in_window(2048, 0, 32, 8192, 65536), (5, 32))
        self.assertEqual(chunks_in_window(2048, 1024, 32, 8192, 65536), (5, 32))
        self.assertEqual(chunks_in_window(4096, 0, 16, 8192, 65536), (3, 16))
        self.assertEqual(chunks_in_window(4096, 2048, 16, 8192, 65536), (3, 16))
        self.assertEqual(chunks_in_window(8192, 0, 8, 8192, 65536), (2, 8))
        self.assertEqual(chunks_in_window(8192, 4096, 8, 8192, 65536), (2, 8))

    def test_warmup_chunks_carrying_filler_history_are_dropped(self):
        # n_ctx 8192, filler 4096: chunk 0's scored tokens have 4096 filler
        # tokens behind them. It must not survive the window filter.
        first, _ = chunks_in_window(8192, 4096, 8, 8192, 65536)
        self.assertGreater(first, 1)

    def test_nothing_fits_returns_none(self):
        self.assertEqual(chunks_in_window(8192, 0, 1, 8192, 65536), (None, None))


class TestArms(unittest.TestCase):
    WIN = (8192, 65536)

    def test_token_counts_are_what_the_geometry_predicts(self):
        for n, expect in ((2048, 28 * 1023 * 2), (4096, 14 * 2047 * 2),
                          (8192, 7 * 4095 * 2)):
            res = arm_ppl(n, positional_nll, *self.WIN)
            self.assertEqual(res.count, expect, f"n_ctx={n}")

    def test_missed_tokens_are_the_multiples_of_half_n(self):
        for n, expect in ((2048, 55), (4096, 27), (8192, 13)):
            res = arm_ppl(n, positional_nll, *self.WIN)
            self.assertEqual(res.missed_tokens, expect, f"n_ctx={n}")

    def test_matched_arms_agree_when_nll_is_positional(self):
        """THE LOAD-BEARING ONE. Same tokens, different depth, same answer."""
        ppls = [arm_ppl(n, positional_nll, *self.WIN).ppl
                for n in (2048, 4096, 8192)]
        for p in ppls[1:]:
            self.assertAlmostEqual(p / ppls[0], 1.0, places=4,
                                   msg=f"{ppls} should all be equal")

    def test_matched_arms_diverge_when_nll_depends_on_history(self):
        """The control for the control: a real depth effect must show up."""
        ppls = [arm_ppl(n, history_nll, *self.WIN).ppl for n in (2048, 4096, 8192)]
        self.assertLess(ppls[0], ppls[1])
        self.assertLess(ppls[1], ppls[2])
        # 0.0004 nats per history token, mean history 0.75*N: the 8192 arm should
        # carry about exp(0.0004 * 0.75 * (8192-2048)) more.
        self.assertAlmostEqual(ppls[2] / ppls[0],
                               math.exp(0.0004 * 0.75 * (8192 - 2048)), places=1)

    def test_filler_never_reaches_a_kept_chunk(self):
        """If it did, the arm PPL would be pulled toward FILLER_NLL."""
        clean = arm_ppl(2048, positional_nll, *self.WIN).ppl
        # Same corpus, but the filler is scored an order of magnitude worse.
        global FILLER_NLL
        old, FILLER_NLL = FILLER_NLL, 40.0
        try:
            loud = arm_ppl(2048, positional_nll, *self.WIN).ppl
        finally:
            FILLER_NLL = old
        self.assertAlmostEqual(clean, loud, places=6)

    def test_overlapping_rotations_report_a_negative_miss(self):
        """A resolving run covers each token twice; that must not read as a bug."""
        logs, fills = [], []
        for f in (0, 2048, 4096, 6144):
            logs.append(parse_log(synth_log(8192, f, 8, positional_nll),
                                  f"arm-8192-f{f}.log"))
            fills.append(f)
        res = combine_arm(logs, fills, 8192, 65536)
        self.assertLess(res.missed_tokens, 0, "four rotations must overlap")
        self.assertIn("SCORED TWICE", _fmt_arm(res))

    def test_mixed_n_ctx_in_one_arm_is_refused(self):
        a = parse_log(synth_log(2048, 0, 4, positional_nll), "a.log")
        b = parse_log(synth_log(4096, 0, 4, positional_nll), "b.log")
        with self.assertRaises(ValueError):
            combine_arm([a, b], [0, 0], 8192, 16384)


class TestAlignmentControl(unittest.TestCase):
    def test_whole_chunk_shift_reproduces_the_chunks(self):
        a = parse_log(synth_log(2048, 0, 12, positional_nll), "a.log")
        b = parse_log(synth_log(2048, 2048, 13, positional_nll), "b.log")
        ctl = alignment_control(a, b, 1)
        self.assertGreaterEqual(ctl["pairs"], 11)
        self.assertEqual(ctl["verdict"], "PASS")
        self.assertLessEqual(ctl["worst_floor_ratio"], 1.5,
                             "an exact match must sit ON the printing floor")

    def test_a_one_chunk_error_in_the_offset_breaks_it(self):
        """The control for the control. If this passed, the control proves nothing."""
        a = parse_log(synth_log(2048, 0, 12, positional_nll), "a.log")
        b = parse_log(synth_log(2048, 2048, 13, positional_nll), "b.log")
        ctl = alignment_control(a, b, 2)
        self.assertEqual(ctl["verdict"], "FAIL")
        self.assertGreater(ctl["worst_floor_ratio"], 100.0)

    def test_a_one_token_filler_error_is_caught_but_only_just(self):
        """The failure this control actually exists to catch, and its margin.

        Shifting the filler by one token leaves 1022 of a chunk's 1023 scored
        tokens in place and changes no history length, so the chunk average
        moves by only 4e-4 relative. Against the log's own printing floor that
        is still ~22x, well clear of the 3x verdict - but two orders of
        magnitude less margin than a chunk-scale error, which is why the run
        script reads the token count off perplexity's error path as well.
        """
        a = parse_log(synth_log(2048, 0, 12, positional_nll), "a.log")
        for off_by in (2047, 2049):
            b = parse_log(synth_log(2048, off_by, 13, positional_nll), "b.log")
            ctl = alignment_control(a, b, 1)
            self.assertGreater(ctl["worst_floor_ratio"], 3.0,
                               f"filler {off_by}: should still clear the floor")
            self.assertLess(ctl["worst_floor_ratio"], 100.0,
                            f"filler {off_by}: two orders below a chunk-scale error")

    def test_different_n_ctx_is_refused(self):
        a = parse_log(synth_log(2048, 0, 4, positional_nll), "a.log")
        b = parse_log(synth_log(4096, 0, 4, positional_nll), "b.log")
        with self.assertRaises(ValueError):
            alignment_control(a, b, 1)


class TestSpanMap(unittest.TestCase):
    """The instrument that shows what an arm's single number hides."""

    WIN = (8192, 65536)

    def _logs(self, nll_fn):
        out = []
        for n in (2048, 4096, 8192):
            for f in (0, n // 2):
                text = synth_log(n, f, 65536 // n, nll_fn)
                out.append((n, f, parse_log(text, f"arm-{n}-f{f}.log")))
        return out

    def test_every_depth_agrees_in_every_cell_when_nll_is_positional(self):
        rows = span_map(self._logs(positional_nll), 4096, *self.WIN)
        # (65536 - 8192) / 4096 = 14 cells, and every one of them is fed.
        self.assertEqual(len(rows), 14, "8192..65536 on a 4096 grid")
        for r in rows:
            ppls = [v["ppl"] for v in r["by_depth"].values()]
            self.assertGreaterEqual(len(ppls), 2, f"{r['span']} has one depth only")
            self.assertAlmostEqual(max(ppls) / min(ppls), 1.0, places=3,
                                   msg=f"{r['span']}: {r['by_depth']}")

    def test_the_deeper_column_is_higher_everywhere_when_history_costs(self):
        rows = [r for r in span_map(self._logs(history_nll), 4096, *self.WIN)
                if "span" in r]
        for r in rows:
            by = r["by_depth"]
            if 2048 in by and 8192 in by:
                self.assertGreater(by[8192]["ppl"], by[2048]["ppl"], str(r["span"]))

    def test_a_chunk_that_straddles_a_cell_is_reported_not_smeared(self):
        # n_ctx 8192 scores 4095 tokens per chunk; on a 2048 grid nothing fits,
        # and the map must SAY SO rather than come back looking merely empty.
        logs = [(8192, 0, parse_log(synth_log(8192, 0, 8, positional_nll), "arm-8192-f0.log"))]
        rows = span_map(logs, 2048, *self.WIN)
        self.assertEqual([r for r in rows if "span" in r], [])
        straddled = [r for r in rows if "straddled" in r]
        self.assertEqual(len(straddled), 1)
        self.assertGreater(straddled[0]["straddled"][0]["chunks"], 0)
        # …and on a 4096 grid the same chunks land cleanly, with nothing dropped.
        rows = span_map(logs, 4096, *self.WIN)
        self.assertTrue([r for r in rows if "span" in r])
        self.assertEqual([r for r in rows if "straddled" in r], [])

    def test_a_quarter_offset_rotation_straddles_the_natural_grid(self):
        """The case the counter exists for: a resolving run at one depth.

        F = N/4 and F = 3N/4 put every chunk across a cell boundary of the
        4096-token grid that F = 0 and F = N/2 bin perfectly. Without the
        counter the map would print half the passes and look finished.
        """
        logs = [(8192, f, parse_log(synth_log(8192, f, 8, positional_nll),
                                    f"arm-8192-f{f}.log"))
                for f in (0, 2048, 4096, 6144)]
        rows = span_map(logs, 4096, *self.WIN)
        straddled = {(d["n_ctx"], d["filler"]): d["chunks"]
                     for r in rows if "straddled" in r for d in r["straddled"]}
        self.assertEqual(sorted(straddled), [(8192, 2048), (8192, 6144)])
        self.assertIn("NOT BINNED", _fmt_span_map(rows))

    def test_it_records_which_rotations_fed_each_cell(self):
        rows = [r for r in span_map(self._logs(positional_nll), 4096, *self.WIN)
                if "span" in r]
        seen = {tuple(v["rotations"]) for r in rows for v in r["by_depth"].values()}
        self.assertTrue(any(len(t) == 1 for t in seen),
                        "a cell fed by one rotation is exactly the 8192 case")


class TestPartitionPairs(unittest.TestCase):
    """Two partitions of the same tokens at one depth: content vs boundary."""

    WIN = (8192, 65536)
    N = 8192

    def _logs(self, nll_fn):
        return [(self.N, f, parse_log(synth_log(self.N, f, 8, nll_fn),
                                      f"arm-{self.N}-f{f}.log"))
                for f in (0, 2048, 4096, 6144)]

    def test_the_partitions_agree_when_nll_is_positional(self):
        rep = partition_pairs(self._logs(positional_nll), self.N, *self.WIN)
        self.assertEqual(len(rep["pairs"]), 2)
        self.assertAlmostEqual(rep["worst_ratio"], 1.0, places=2, msg=str(rep))

    def test_the_partitions_agree_when_nll_depends_on_history(self):
        """Same depth means the same history distribution, so this must NOT split them."""
        rep = partition_pairs(self._logs(history_nll), self.N, *self.WIN)
        self.assertAlmostEqual(rep["worst_ratio"], 1.0, places=2, msg=str(rep))


    def test_the_partitions_split_on_a_boundary_placement_effect(self):
        """The control for the control: an effect this comparison must catch."""
        rep = partition_pairs(self._logs(boundary_nll), self.N, *self.WIN)
        self.assertGreater(rep["worst_ratio"], 1.5, str(rep))

    def test_one_pair_is_not_a_comparison(self):
        logs = [(self.N, f, parse_log(synth_log(self.N, f, 8, positional_nll),
                                      f"arm-{self.N}-f{f}.log")) for f in (0, 4096)]
        rep = partition_pairs(logs, self.N, *self.WIN)
        self.assertEqual(rep["pairs"], [])

    def test_both_pairs_score_comparable_token_counts(self):
        rep = partition_pairs(self._logs(positional_nll), self.N, *self.WIN)
        counts = [o["tokens"] for o in rep["pairs"]]
        self.assertLess(abs(counts[0] - counts[1]) / max(counts), 0.15,
                        f"the tightened window should leave them close: {counts}")


class TestAsymmetryBound(unittest.TestCase):
    def test_the_bound_is_small_and_positive(self):
        lo = arm_ppl(2048, positional_nll, 8192, 65536)
        hi = arm_ppl(8192, positional_nll, 8192, 65536)
        b = asymmetry_bound_pct(lo, hi)
        self.assertGreater(b, 0.0)
        self.assertLess(b, 1.0, "42 tokens in 57,000 cannot move PPL by 1%")

    def test_the_bound_grows_with_the_asymmetry(self):
        lo = arm_ppl(2048, positional_nll, 8192, 65536)
        hi = arm_ppl(8192, positional_nll, 8192, 65536)
        small = asymmetry_bound_pct(lo, hi)
        hi.missed_tokens -= 1000
        self.assertGreater(asymmetry_bound_pct(lo, hi), small)


if __name__ == "__main__":
    unittest.main(verbosity=2)
