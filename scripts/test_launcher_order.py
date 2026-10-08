#!/usr/bin/env python3
"""The launcher's model-catalog refresh must run BEFORE it asks pi what it knows.

This is a test of ORDER inside `scripts/pi-local.sh`, because that is the whole
of the bug it exists to prevent — and the bug is invisible on the machine of
anyone who has launched the stack before.

What happened: the refresh (`pi update --models`) was written near the end of
the script, alongside the other pi housekeeping, while the orchestrator's probe
(`pi --list-models <id>` … `die`) sits much earlier. pi 0.85.1's BUNDLED catalog
is the one that ships no `claude-opus-5-5` and no `claude-haiku-5-5` — 14
anthropic models before a refresh, 17 after — so:

    launch 1   the probe runs first, the model is unknown, the launcher dies
    launch 2   the catalog is now refreshed, and everything works

A first-run failure that repairs itself on retry reads as a flake rather than a
bug, and it cannot be caught by running the script on a box that has already
launched once. It also cannot be caught by CI running the launcher, because CI
does not run the launcher. So the assertion is made against the source text,
which is the only thing checkable without a pi whose catalog is cold.
"""

import pathlib
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
LAUNCHER = REPO / "scripts" / "pi-local.sh"

REFRESH_ANCHOR = "pi update --models"
PROBE_ANCHOR = "does not list"


class LauncherOrder(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.lines = LAUNCHER.read_text(encoding="utf-8").splitlines()

    def _first_line_of(self, anchor: str) -> int:
        """Index of the first NON-COMMENT line mentioning `anchor`.

        Comments are skipped deliberately. This file's prose discusses both
        commands at length, and a match inside a comment would let the test pass
        while the code did the wrong thing — which is the failure being fixed.
        """
        for i, line in enumerate(self.lines):
            if line.lstrip().startswith("#"):
                continue
            if anchor in line:
                return i
        self.fail(
            f"no non-comment line mentions {anchor!r} — the anchor moved, so this "
            f"test is no longer checking what it claims to. Fix the anchor rather "
            f"than deleting the test."
        )

    def test_the_anchors_still_exist(self) -> None:
        # The control. Without it a launcher that dropped the probe entirely
        # would satisfy the ordering assertion below for the wrong reason.
        self.assertIsInstance(self._first_line_of(REFRESH_ANCHOR), int)
        self.assertIsInstance(self._first_line_of(PROBE_ANCHOR), int)

    def test_the_refresh_runs_before_the_model_probe(self) -> None:
        refresh = self._first_line_of(REFRESH_ANCHOR)
        probe = self._first_line_of(PROBE_ANCHOR)
        self.assertLess(
            refresh,
            probe,
            f"the catalog refresh is at line {refresh + 1} and the model probe at "
            f"line {probe + 1}, so the probe runs first. On a pi whose bundled "
            f"catalog lacks the -5-5 models that means the FIRST launch after a "
            f"clone dies and only the second works. Move the refresh above the probe.",
        )


if __name__ == "__main__":
    unittest.main()
