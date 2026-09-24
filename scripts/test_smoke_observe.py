#!/usr/bin/env python3
"""The smoke test's dashboard checks, against a scripted HTTP stub.

Run with: python3 scripts/test_smoke_observe.py
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke_test  # noqa: E402

HEALTH = json.dumps({"ok": True, "id": "instantcoffee-observe", "gitHash": "abc1234"})


def stack(state: str | None, error: str | None = None) -> str:
    return json.dumps({"status": {"state": state, "llamaUrl": "http://llama:8080", "lastError": error}})


class ObserveChecks(unittest.TestCase):
    def setUp(self) -> None:
        smoke_test._results.clear()
        self.sleep = mock.patch.object(smoke_test.time, "sleep", lambda _s: None)
        self.sleep.start()

    def tearDown(self) -> None:
        self.sleep.stop()

    def results(self) -> dict[str, bool]:
        return {name: ok for name, ok, _ in smoke_test._results}

    def test_healthy_dashboard_passes(self) -> None:
        with mock.patch.object(smoke_test, "http", return_value=(200, HEALTH)):
            self.assertTrue(smoke_test.check_observe_health())
        self.assertEqual(self.results(), {"observe dashboard reachable": True, "observe identifies itself": True})

    def test_some_other_server_on_the_port_fails(self) -> None:
        other = json.dumps({"ok": True, "id": "something-else"})
        with mock.patch.object(smoke_test, "http", return_value=(200, other)):
            self.assertFalse(smoke_test.check_observe_health())
        self.assertFalse(self.results()["observe identifies itself"])

    def test_non_json_health_fails_with_the_body(self) -> None:
        with mock.patch.object(smoke_test, "http", return_value=(200, "<html>proxy</html>")):
            self.assertFalse(smoke_test.check_observe_health())
        detail = [d for n, _, d in smoke_test._results if n == "observe identifies itself"][0]
        self.assertIn("<html>proxy</html>", detail)

    def test_poller_that_comes_up_passes(self) -> None:
        replies = iter([(200, stack("starting")), (200, stack("unreachable", "ECONNREFUSED")), (200, stack("ok"))])
        with mock.patch.object(smoke_test, "http", side_effect=lambda *_a, **_k: next(replies)):
            smoke_test.check_observe_sees_llama()
        self.assertTrue(self.results()["observe polls llama"])

    def test_stalled_counts_as_reachable(self) -> None:
        with mock.patch.object(smoke_test, "http", return_value=(200, stack("stalled"))):
            smoke_test.check_observe_sees_llama()
        self.assertTrue(self.results()["observe polls llama"])

    def test_poller_that_never_reaches_llama_fails_with_its_error(self) -> None:
        clock = iter(range(0, 10_000, 5))
        with mock.patch.object(smoke_test, "http", return_value=(200, stack("unreachable", "ECONNREFUSED"))), \
             mock.patch.object(smoke_test.time, "monotonic", lambda: float(next(clock))):
            smoke_test.check_observe_sees_llama()
        self.assertFalse(self.results()["observe polls llama"])
        detail = [d for n, _, d in smoke_test._results if n == "observe polls llama"][0]
        self.assertIn("ECONNREFUSED", detail)


if __name__ == "__main__":
    unittest.main()
