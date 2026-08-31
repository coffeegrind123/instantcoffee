#!/usr/bin/env python3
"""Tests for spec_sweep_compare.

THE LOAD-BEARING TESTS are the two round_health pairs. The whole point of this
analyser is that it decides comparability from LOAD SPREAD BETWEEN CONFIGS, not
from absolute load — a round where every arm ran at load 15 is a fair (noisy)
comparison, while a round where one arm ran at 3 and another at 40 is not a
comparison at all. Those two cases must come out DIFFERENTLY, so each is
asserted against its opposite:

  test_split_round_is_rejected      <-> test_evenly_busy_round_is_accepted
  test_separated_samples_are_significant <-> test_overlapping_samples_are_not

A test that can only pass is not a test. Both directions are asserted.

The permutation test is exact, so its p-values are checked against hand-computable
cases rather than a tolerance pulled out of the air.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from spec_sweep_compare import (  # noqa: E402
    DEFAULT_LOAD_MAX, DEFAULT_LOAD_RATIO, load_results, perm_p, pool,
    round_health)


def _entry(tps, load_before, load_after):
    return {"tps": list(tps), "load": (load_before, load_after)}


class RoundHealth(unittest.TestCase):
    """Comparability is about load SPREAD across configs, not absolute load."""

    def test_split_round_is_rejected(self):
        # One arm quiet, one hammered: the means are not comparable.
        data = {
            ("repeat", 2, "pin"): _entry([200], 3.3, 3.9),
            ("repeat", 2, "cand"): _entry([185], 36.6, 40.2),
        }
        ok, why = round_health(data, "repeat", 2, DEFAULT_LOAD_MAX, DEFAULT_LOAD_RATIO)
        self.assertFalse(ok)
        self.assertIn("LOAD-SPLIT", why)

    def test_evenly_busy_round_is_accepted(self):
        """CONTROL for the above. Higher absolute load than the split round, but
        even across configs, so it must be USABLE — otherwise the check is just
        thresholding absolute load and the split test proves nothing."""
        data = {
            ("repeat", 2, "pin"): _entry([200], 14.0, 15.0),
            ("repeat", 2, "cand"): _entry([185], 13.5, 15.2),
        }
        ok, why = round_health(data, "repeat", 2, DEFAULT_LOAD_MAX, DEFAULT_LOAD_RATIO)
        self.assertTrue(ok)
        self.assertIn("busy but even", why)

    def test_quiet_and_even_is_accepted(self):
        data = {
            ("repeat", 3, "pin"): _entry([200], 2.8, 3.4),
            ("repeat", 3, "cand"): _entry([210], 3.5, 3.8),
        }
        ok, why = round_health(data, "repeat", 3, DEFAULT_LOAD_MAX, DEFAULT_LOAD_RATIO)
        self.assertTrue(ok)
        self.assertIn("even", why)
        self.assertNotIn("busy", why)

    def test_unstamped_round_is_not_silently_trusted_as_even(self):
        """Results predating load stamping must be reported as unknown, not
        assumed clean. They are still usable — there is nothing else to go on —
        but the reason string has to say so."""
        data = {("repeat", 1, "pin"): _entry([200], None, None)}
        ok, why = round_health(data, "repeat", 1, DEFAULT_LOAD_MAX, DEFAULT_LOAD_RATIO)
        self.assertTrue(ok)
        self.assertEqual(why, "no load recorded")

    def test_quiet_round_is_not_split_however_big_the_ratio(self):
        """A big ratio between two SMALL loads is not a contaminated round.
        2.3 vs 6.5 is 2.8x, and on a 16-core box both are an idle machine.
        Gating on the ratio alone threw away a perfectly good round."""
        data = {
            ("repeat", 3, "pin"): _entry([200], 4.0, 4.0),
            ("repeat", 3, "cand"): _entry([210], 2.3, 2.3),
            ("repeat", 3, "cand2"): _entry([205], 6.5, 6.5),
        }
        ok, why = round_health(data, "repeat", 3, DEFAULT_LOAD_MAX, DEFAULT_LOAD_RATIO)
        self.assertTrue(ok, why)
        self.assertNotIn("LOAD-SPLIT", why)

    def test_same_ratio_IS_split_once_the_load_is_material(self):
        """CONTROL for the above: identical 2.8x ratio, but scaled up so one arm
        is genuinely busy. This one must be rejected, or the quiet-round test is
        passing because the split check stopped working."""
        data = {
            ("repeat", 3, "pin"): _entry([200], 4.0, 4.0),
            ("repeat", 3, "cand"): _entry([210], 4.6, 4.6),
            ("repeat", 3, "cand2"): _entry([205], 13.0, 13.0),
        }
        ok, why = round_health(data, "repeat", 3, DEFAULT_LOAD_MAX, DEFAULT_LOAD_RATIO)
        self.assertFalse(ok, why)
        self.assertIn("LOAD-SPLIT", why)

    def test_ratio_is_measured_across_configs_not_within_one(self):
        """A single config whose own load drifted during its bench is noisy, but
        it is not a between-config split. Both arms swing the same way here."""
        data = {
            ("repeat", 2, "pin"): _entry([200], 4.0, 11.0),
            ("repeat", 2, "cand"): _entry([185], 4.2, 11.4),
        }
        lo, hi = 4.0, 11.4
        self.assertGreaterEqual(hi / lo, DEFAULT_LOAD_RATIO)  # the span DOES exceed it
        ok, _why = round_health(data, "repeat", 2, DEFAULT_LOAD_MAX, DEFAULT_LOAD_RATIO)
        # ...and it is still rejected, because this implementation cannot tell a
        # shared ramp from a split. Documented, not accidental: with the arms
        # interleaved a shared ramp is the benign case, so this is the
        # conservative direction. If it ever needs loosening, the fix is to
        # compare per-config MEANS, not the global min and max.
        self.assertFalse(ok)


class PermutationTest(unittest.TestCase):
    def test_separated_samples_are_significant(self):
        a = [200.0, 202.0, 204.0, 206.0]
        b = [150.0, 152.0, 154.0, 156.0]
        p = perm_p(a, b)
        # 8 choose 4 = 70 splits; only the observed one (and its mirror) reach
        # the observed separation, so p = 2/70.
        self.assertAlmostEqual(p, 2.0 / 70.0, places=6)

    def test_overlapping_samples_are_not(self):
        """CONTROL. Same machinery, interleaved samples: p must be large, or the
        test above is passing because perm_p always returns something small."""
        a = [200.0, 150.0, 198.0, 152.0]
        b = [199.0, 151.0, 197.0, 153.0]
        p = perm_p(a, b)
        self.assertGreater(p, 0.5)

    def test_returns_none_rather_than_hanging_on_large_inputs(self):
        self.assertIsNone(perm_p([1.0] * 20, [2.0] * 20))


class Pooling(unittest.TestCase):
    def test_pool_concatenates_only_requested_rounds(self):
        data = {
            ("repeat", 1, "pin"): _entry([1.0, 2.0], 3, 3),
            ("repeat", 2, "pin"): _entry([3.0], 3, 3),
            ("repeat", 3, "pin"): _entry([4.0], 3, 3),
            ("synthetic", 2, "pin"): _entry([99.0], 3, 3),
        }
        self.assertEqual(pool(data, "repeat", [1, 3], "pin"), [1.0, 2.0, 4.0])
        self.assertEqual(pool(data, "repeat", [2], "pin"), [3.0])
        self.assertEqual(pool(data, "repeat", [1, 2, 3], "missing"), [])


class LoadResults(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, workload, fname, name, rnd, tps, load=(4.0, 5.0), extra_rows=()):
        d = os.path.join(self.dir, workload)
        os.makedirs(d, exist_ok=True)
        rows = [{"predicted_tps": t} for t in tps]
        rows.extend(extra_rows)
        doc = {"rows": rows,
               "config": {"name": name, "round": rnd, "workload": workload,
                          "load_before": load[0], "load_after": load[1]}}
        with open(os.path.join(d, fname), "w") as f:
            json.dump(doc, f)

    def test_reads_round_and_load(self):
        self._write("repeat", "pin.json", "pin", 1, [180.0, 182.0])
        self._write("repeat", "pin.r2.json", "pin", 2, [190.0], load=(9.0, 9.5))
        got = load_results(self.dir)
        self.assertEqual(got[("repeat", 1, "pin")]["tps"], [180.0, 182.0])
        self.assertEqual(got[("repeat", 2, "pin")]["load"], (9.0, 9.5))

    def test_excludes_errored_cached_and_unrepeated_rows(self):
        """These flags exist because such rows are not measurements. Counting
        them would quietly change every mean in the table."""
        self._write("repeat", "pin.json", "pin", 1, [180.0], extra_rows=[
            {"predicted_tps": 999.0, "error": "boom"},
            {"predicted_tps": 999.0, "cached": True},
            {"predicted_tps": 999.0, "unrepeated": True},
            {"predicted_tps": None},
        ])
        got = load_results(self.dir)
        self.assertEqual(got[("repeat", 1, "pin")]["tps"], [180.0])

    def test_unparseable_json_is_skipped_not_fatal(self):
        self._write("repeat", "good.json", "pin", 1, [180.0])
        with open(os.path.join(self.dir, "repeat", "bad.json"), "w") as f:
            f.write("{not json")
        got = load_results(self.dir)  # must not raise
        self.assertIn(("repeat", 1, "pin"), got)


if __name__ == "__main__":
    unittest.main(verbosity=2)
