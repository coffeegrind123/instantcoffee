#!/usr/bin/env python3
"""A runner that owns .env must STOP when it is interrupted, not restore and carry on.

WHY THIS FILE EXISTS. spec-sweep.sh and capacity-probe.sh both took .env over
for their run and registered::

    trap 'restore_env || true' EXIT INT TERM

A bash trap on a signal RUNS THE HANDLER AND RESUMES — it does not exit unless
the handler says so. On 2026-09-23 a sweep was stopped with SIGTERM, exactly
as HANDOFF part 14 §5 says to: the handler put .env back and deleted the
backup, the loop went on to the next arm, and that arm wrote its own values
over the restored file and recreated llama with them. The one copy of the
original was already gone. The production .env was rebuilt from git by hand.

So the check is behavioural: each script's own trap line is lifted out and run
against a loop that signals itself, and the loop must not reach its next step.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Runners that back up .env, rewrite it per step, and restore it from a trap.
RUNNERS = ["spec-sweep.sh", "capacity-probe.sh"]

TRAP_RE = re.compile(r"^\s*trap\s+'[^']*restore_env[^']*'\s+[A-Z ]+$")


def trap_lines(name: str) -> list[str]:
    with open(os.path.join(REPO, "scripts", name), encoding="utf-8") as fh:
        return [ln.strip() for ln in fh if TRAP_RE.match(ln)]


def run_interrupted(traps: list[str], sig: signal.Signals) -> subprocess.CompletedProcess:
    """A three-step loop that signals itself during step 1, under the given traps."""
    script = "\n".join([
        "restore_env() { echo RESTORED; }",
        "warn() { :; }",
        *traps,
        "for i in 1 2 3; do",
        "  echo STEP$i",
        f"  if [[ $i == 1 ]]; then kill -{sig.name.removeprefix('SIG')} $$; fi",
        "done",
        "echo FINISHED",
    ])
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)


class InterruptExits(unittest.TestCase):
    def test_each_runner_registers_a_restore_trap(self) -> None:
        for name in RUNNERS:
            with self.subTest(runner=name):
                self.assertTrue(trap_lines(name), f"{name}: no restore_env trap found")

    def test_a_signal_stops_the_run(self) -> None:
        for name in RUNNERS:
            for sig in (signal.SIGTERM, signal.SIGINT):
                with self.subTest(runner=name, signal=sig.name):
                    out = run_interrupted(trap_lines(name), sig)
                    self.assertIn("RESTORED", out.stdout, out.stdout)
                    self.assertNotIn("STEP2", out.stdout,
                                     f"{name}: the loop carried on after {sig.name}")
                    self.assertNotIn("FINISHED", out.stdout, out.stdout)
                    self.assertNotEqual(out.returncode, 0,
                                        f"{name}: an interrupted run reported success")

    def test_a_normal_exit_still_restores(self) -> None:
        for name in RUNNERS:
            with self.subTest(runner=name):
                script = "\n".join([
                    "restore_env() { echo RESTORED; }", "warn() { :; }",
                    *trap_lines(name), "echo DONE",
                ])
                out = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
                self.assertEqual(out.stdout.split(), ["DONE", "RESTORED"], out.stdout)
                self.assertEqual(out.returncode, 0)


if __name__ == "__main__":
    unittest.main()
