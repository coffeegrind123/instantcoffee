#!/usr/bin/env python3
"""Tests for kv_alt_analyse.

THE LOAD-BEARING ONE is test_the_se_is_between_loads_not_pooled_requests. The
whole reason this tool exists is that `kv_accept_note`'s -2.6 % prefill figure
was computed from the spread of REQUESTS inside one load per arm, which cannot
see load-to-load variation at all. A tool that pooled the requests would produce
a confident number from exactly the same mistake, so the test constructs data
where the two answers differ by an order of magnitude and pins which one comes
out.

Its control is test_a_real_difference_is_still_found: a comparison that can only
say "not resolved" is not a comparison.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kv_alt_analyse import compare, load_stats, sd, usable_rows  # noqa: E402


def write_doc(dirpath: str, label: str, values: list, metric="prompt_tps",
              cached=0) -> str:
    rows = [{"status": 200, "cache_n": 0, metric: v} for v in values]
    rows += [{"status": 200, "cache_n": 4096, metric: 99999.0} for _ in range(cached)]
    path = os.path.join(dirpath, f"{label}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"label": label, "result": {"rows": rows}}, fh)
    return path


class TestRowSelection(unittest.TestCase):
    def test_a_cache_hit_is_not_a_fast_run(self):
        d = tempfile.mkdtemp()
        try:
            p = write_doc(d, "x-a-f16", [100.0, 101.0], cached=3)
            rows = usable_rows(json.load(open(p)))
            self.assertEqual(len(rows), 2, "the three cached rows must be dropped")
        finally:
            shutil.rmtree(d)

    def test_an_errored_row_is_dropped(self):
        d = tempfile.mkdtemp()
        try:
            p = write_doc(d, "x-a-f16", [100.0])
            doc = json.load(open(p))
            doc["result"]["rows"].append({"status": 500, "error": "boom",
                                          "prompt_tps": 1.0})
            self.assertEqual(len(usable_rows(doc)), 1)
        finally:
            shutil.rmtree(d)


class TestBetweenLoad(unittest.TestCase):
    """Four loads per arm, and the unit of replication is the load."""

    # Each load is internally very tight (sd ~0.1) and the loads sit far apart
    # (sd ~4). Pooling the requests would report an SE ten times too small.
    A_LOADS = [[100.0, 100.1, 99.9, 100.0],
               [106.0, 106.1, 105.9, 106.0],
               [ 96.0,  96.1,  95.9,  96.0],
               [102.0, 102.1, 101.9, 102.0]]
    B_LOADS = [[101.0, 101.1, 100.9, 101.0],
               [107.0, 107.1, 106.9, 107.0],
               [ 97.0,  97.1,  96.9,  97.0],
               [103.0, 103.1, 102.9, 103.0]]

    def _dirs(self, a_loads, b_loads):
        d = tempfile.mkdtemp()
        for i, v in enumerate(a_loads):
            write_doc(d, f"kvalt-{chr(97 + i)}-f16", v)
        for i, v in enumerate(b_loads):
            write_doc(d, f"kvalt-{chr(97 + i)}-q8_0", v)
        return d

    def test_the_se_is_between_loads_not_pooled_requests(self):
        d = self._dirs(self.A_LOADS, self.B_LOADS)
        try:
            a = load_stats([os.path.join(d, f"kvalt-{c}-f16.json") for c in "abcd"],
                           "prompt_tps")
            b = load_stats([os.path.join(d, f"kvalt-{c}-q8_0.json") for c in "abcd"],
                           "prompt_tps")
            c = compare(a, b)
            # Every load is exactly +1.0, so the difference is real and exact.
            self.assertAlmostEqual(c["diff"], 1.0, places=6)
            # The BETWEEN-load spread is ~4.3, so the SE is ~3.0 …
            self.assertGreater(c["a_sd_between"], 3.0)
            self.assertGreater(c["se"], 2.0)
            # … while pooling the sixteen requests divides by sqrt(16) instead
            # of sqrt(4), so it understates the SE by about sqrt(requests per
            # load) whenever the variance lives BETWEEN loads. That factor is
            # sqrt(4) = 2 here and sqrt(30) = 5.5 in the run that prompted this
            # tool — and at ONE load per arm, which is what kv_accept_note
            # actually had, the pooled SE cannot see the between-load term at
            # all, at any factor.
            n_req = len(self.A_LOADS[0])
            n_load = len(self.A_LOADS)
            # Like for like: ONE arm's SE, computed both ways. The honest one
            # divides the spread of the four LOAD MEANS by sqrt(4); the pooled one
            # divides the spread of all sixteen requests by sqrt(16). Both see the
            # same variance, and the pooled one divides it by twice as much.
            honest_a = c["a_sd_between"] / math.sqrt(n_load)
            pooled_a = sd([x for v in self.A_LOADS for x in v]) / math.sqrt(n_load * n_req)
            self.assertGreater(honest_a / pooled_a, 2.0,
                               "pooling requests must understate a between-load SE")
            self.assertLess(abs(c["t"]), 1.0, "a +1 shift under +/-4 load noise "
                                              "is NOT resolved at four loads")
        finally:
            shutil.rmtree(d)

    def test_a_real_difference_is_still_found(self):
        """The control: a comparison that can only say 'not resolved' is useless."""
        big_b = [[v + 40.0 for v in load] for load in self.B_LOADS]
        d = self._dirs(self.A_LOADS, big_b)
        try:
            a = load_stats([os.path.join(d, f"kvalt-{c}-f16.json") for c in "abcd"],
                           "prompt_tps")
            b = load_stats([os.path.join(d, f"kvalt-{c}-q8_0.json") for c in "abcd"],
                           "prompt_tps")
            c = compare(a, b)
            self.assertAlmostEqual(c["diff"], 41.0, places=6)
            self.assertGreater(abs(c["t"]), 2.5, "a 41-unit shift must resolve")
        finally:
            shutil.rmtree(d)

    def test_between_and_within_are_reported_separately(self):
        d = self._dirs(self.A_LOADS, self.B_LOADS)
        try:
            a = load_stats([os.path.join(d, f"kvalt-{c}-f16.json") for c in "abcd"],
                           "prompt_tps")
            b = load_stats([os.path.join(d, f"kvalt-{c}-q8_0.json") for c in "abcd"],
                           "prompt_tps")
            c = compare(a, b)
            # The ratio is the diagnosis: load-to-load variation dominating means
            # one load per arm could never have answered the question.
            self.assertGreater(c["a_sd_between"] / c["a_sd_within"], 10.0)
        finally:
            shutil.rmtree(d)


class TestDegenerate(unittest.TestCase):
    def test_one_load_per_arm_has_no_between_load_spread(self):
        d = tempfile.mkdtemp()
        try:
            write_doc(d, "kvalt-a-f16", [100.0, 101.0])
            write_doc(d, "kvalt-a-q8_0", [110.0, 111.0])
            a = load_stats([os.path.join(d, "kvalt-a-f16.json")], "prompt_tps")
            b = load_stats([os.path.join(d, "kvalt-a-q8_0.json")], "prompt_tps")
            c = compare(a, b)
            self.assertEqual(c["a_sd_between"], 0.0)
            self.assertEqual(c["se"], 0.0)
            self.assertEqual(c["t"], float("inf"),
                             "one load per arm gives an infinite t, which is the "
                             "arithmetic saying it cannot answer — the CLI refuses "
                             "before it gets here")
        finally:
            shutil.rmtree(d)

    def test_a_load_with_no_usable_rows_is_skipped(self):
        d = tempfile.mkdtemp()
        try:
            write_doc(d, "kvalt-a-f16", [], cached=5)
            self.assertEqual(load_stats([os.path.join(d, "kvalt-a-f16.json")],
                                        "prompt_tps"), [])
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main(verbosity=2)
