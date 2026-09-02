#!/usr/bin/env python3
"""The experiment runners must NOT have errexit, and lib.sh keeps turning it on.

WHY THIS FILE EXISTS. scripts/lib.sh line 4 runs `set -euo pipefail`. Five
long-running runners deliberately do not want errexit — their steps expect
non-zero exits and they collect failures rather than abort on the first one —
and every one of them declared that by writing `set -uo pipefail` BEFORE
sourcing lib.sh, where it is silently overridden.

It cost four wedged ppl-cliff runs and an OPEN-WORK section. restore() begins
with a `docker kill` of a `--rm` container that has already exited, which always
returns 1; under errexit that killed the script before it could restart llama,
silently, and it read as "the EXIT trap did not fire".

THE SECOND TRAP, which is why this test checks the OPTION and not the line:
`set -uo pipefail` does not undo `set -e`. `-u` and `-o pipefail` only ENABLE
those options. Turning errexit off takes `set +e`, so a fix that merely reorders
the line looks right and changes nothing.
"""

from __future__ import annotations

import os
import re
import subprocess
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Runners whose documented intent is "no errexit".
NO_ERREXIT = [
    "kld-run.sh",
    "ppl-cliff-run.sh",
    "ppl-depth-run.sh",
    "ppl-stride-run.sh",
    "test_llama_watchdog.sh",
]


def errexit_after_prologue(path: str) -> bool:
    """Run the script's real prologue and report whether errexit ends up on.

    The prologue is every `source`/`set` line up to the first `set +e` (or the
    first 200 lines if there is none, which is itself the failure).
    """
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    stop = len(lines)
    for i, ln in enumerate(lines):
        if ln.strip() == "set +e":
            stop = i + 1
            break
    prologue = [
        ln for ln in lines[:stop]
        if re.match(r"^\s*(source|set )", ln) and "lib.sh" in ln or re.match(r"^\s*set ", ln)
    ]
    script = "\n".join(prologue) + '\ncase $- in *e*) echo ON;; *) echo OFF;; esac\n'
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, cwd=REPO)
    return out.stdout.strip().endswith("ON")


class LibShTurnsErrexitOn(unittest.TestCase):
    def test_lib_sh_really_does_set_e(self):
        # The control for every other test here: if lib.sh ever stops setting
        # -e, these tests would pass for the wrong reason.
        out = subprocess.run(
            ["bash", "-c", 'source scripts/lib.sh >/dev/null 2>&1; case $- in *e*) echo ON;; *) echo OFF;; esac'],
            capture_output=True, text=True, cwd=REPO,
        )
        self.assertEqual(out.stdout.strip(), "ON",
                         "lib.sh no longer sets -e; this whole file's premise changed")

    def test_set_uo_pipefail_does_not_disable_errexit(self):
        # The trap that made the first fix a no-op, pinned so nobody re-learns it.
        out = subprocess.run(
            ["bash", "-c", 'set -e; set -uo pipefail; case $- in *e*) echo ON;; *) echo OFF;; esac'],
            capture_output=True, text=True,
        )
        self.assertEqual(out.stdout.strip(), "ON")


class RunnersHaveErrexitOff(unittest.TestCase):
    def test_each_runner_ends_its_prologue_with_errexit_off(self):
        for name in NO_ERREXIT:
            with self.subTest(script=name):
                path = os.path.join(REPO, "scripts", name)
                self.assertFalse(
                    errexit_after_prologue(path),
                    f"{name} runs with errexit ON; a `docker kill` of an already-gone "
                    f"--rm container will abort it silently",
                )

    def test_each_runner_says_set_plus_e_explicitly(self):
        for name in NO_ERREXIT:
            with self.subTest(script=name):
                with open(os.path.join(REPO, "scripts", name), encoding="utf-8") as fh:
                    body = fh.read()
                self.assertRegex(body, r"(?m)^set \+e$",
                                 f"{name} has no explicit `set +e`")

    def test_the_check_detects_errexit_when_it_is_on(self):
        # Control: the detector must report ON for a prologue that leaves it on,
        # or "OFF everywhere" means only that the detector is broken.
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as fh:
            fh.write('set -uo pipefail\nsource "%s/scripts/lib.sh"\n' % REPO)
            bad = fh.name
        self.addCleanup(os.unlink, bad)
        self.assertTrue(errexit_after_prologue(bad),
                        "the detector cannot see errexit; every pass above is meaningless")


class RestoreSurvivesAFailingKill(unittest.TestCase):
    def test_docker_kill_failure_is_not_fatal_to_restore(self):
        # The specific line that wedged four runs: it must be guarded, so that
        # restarting llama does not depend on the errexit fix holding.
        with open(os.path.join(REPO, "scripts", "ppl-cliff-run.sh"), encoding="utf-8") as fh:
            body = fh.read()
        restore = re.search(r'^  restore\(\) \{.*?^  \}', body, re.S | re.M)
        self.assertIsNotNone(restore, "restore() moved or vanished")
        m = re.search(r'docker kill "\$RUNNER_CT"[^\n]*', restore.group(0))
        self.assertIsNotNone(m, "the docker kill in restore() moved or vanished")
        self.assertIn("|| kill_rc=", m.group(0),
                      "restore()'s docker kill is unguarded; an expected failure "
                      "would abort the restart under errexit")

    def test_every_docker_kill_of_the_runner_is_guarded(self):
        # token_pass() has one too, and it was unguarded — found by this file's
        # first version matching the wrong one.
        with open(os.path.join(REPO, "scripts", "ppl-cliff-run.sh"), encoding="utf-8") as fh:
            body = fh.read()
        for line in re.findall(r'^\s*docker kill "\$RUNNER_CT"[^\n]*', body, re.M):
            self.assertTrue("|| true" in line or "|| kill_rc=" in line,
                            f"unguarded: {line.strip()}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
