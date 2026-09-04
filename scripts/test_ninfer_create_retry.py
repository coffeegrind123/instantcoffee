#!/usr/bin/env python3
"""start_ninfer(): a transient container-create fault must not cost a quiet window.

WHY THIS FILE EXISTS. Twice on 2026-09-04 the ninfer `docker run` died at
container init with

    nvidia-container-cli: ldcache error: process /sbin/ldconfig terminated with
    signal 9

Each failure threw away an entire QUIET WINDOW, and the quiet window -- not GPU
time -- is the scarce resource in this harness: the gate took about an hour to
open on both occasions. A create that fails transiently and is not retried turns
one bad second into another hour of waiting.

Ruled out before writing this, so the retry is not cargo cult: not memory
(dropping the Docker VM page cache took the box 5.0 -> 14 GiB free and the start
still failed), and not a slow ldconfig in this image (it completes instantly,
and the image has FEWER shared objects than llama's -- 739 vs 1173 -- while
llama's image never reproduced the fault).

Not ruled out, and the reason run.meta now carries the attempt count: both
failures landed within seconds of `docker stop instantcoffee-llama`, and every
control that passed lacked that precondition. `ninfer_create_attempts_<name>` is
the instrument -- if attempt 2 routinely wins ~45 s later with nothing else
changed, the fault is a settling window after the GPU is released and the fix
becomes waiting for it explicitly rather than retrying blindly.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(REPO, "scripts", "lib.sh")
COMPARE = os.path.join(REPO, "scripts", "ninfer-compare.sh")

LDCACHE_ERR = ("nvidia-container-cli: ldcache error: process /sbin/ldconfig "
               "terminated with signal 9")


def run_start(fail_creates: int, tries: str = "4", probe_ok: bool = True,
              budget: str | None = None) -> dict:
    """Drive the real start_ninfer() against a stub docker/compose.

    probe_ok=False makes the readiness probe always answer "not ready", which is
    what a still-loading engine looks like from the outside.
    """
    with tempfile.TemporaryDirectory() as td:
        rundir = os.path.join(td, "run")
        os.makedirs(rundir)
        counter = os.path.join(td, "n")
        calls = os.path.join(td, "calls")
        open(counter, "w").write("0")
        open(calls, "w").close()

        stub = f'''
env_get() {{ echo "/models"; }}
compose() {{ return {0 if probe_ok else 1}; }}
docker() {{
  echo "$1" >> "{calls}"
  case "$1" in
    rm) return 0 ;;
    logs) echo "model loaded in 1.0 s"; return 0 ;;
    inspect) echo "true"; return 0 ;;
    run)
      n=$(cat "{counter}"); n=$((n + 1)); echo "$n" > "{counter}"
      if [ "$n" -le {fail_creates} ]; then
        echo "{LDCACHE_ERR}" >&2
        return 125
      fi
      echo "deadbeefcid"; return 0 ;;
  esac
  return 0
}}
'''
        body = subprocess.run(
            ["sed", "-n", "/^start_ninfer()/,/^}/p", COMPARE],
            capture_output=True, text=True, check=True).stdout
        assert "docker run -d" in body, "did not extract start_ninfer()"

        script = (
            f'source "{LIB}"\n{stub}\n'
            f'RUN_DIR="{rundir}"\nNINFER_CT=ninfer-bench\nNETWORK=net\n'
            'NINFER_IMAGE=ninfer-4090:sm89\nNINFER_ARTIFACT=q.ninfer\n'
            f'{body}\n'
            'if start_ninfer 98304 rk4v4-e8 matched; then echo "RC=0"; else echo "RC=$?"; fi\n'
        )
        env = dict(os.environ)
        env["NINFER_CREATE_RETRY_EVERY"] = "0"
        env["NINFER_CREATE_TRIES"] = tries
        if budget is not None:
            env["NINFER_HEALTH_BUDGET"] = budget
        proc = subprocess.run(["bash", "-c", script], capture_output=True,
                              text=True, env=env, timeout=120)
        meta = ""
        mp = os.path.join(rundir, "run.meta")
        if os.path.exists(mp):
            meta = open(mp).read()
        docker_calls = open(calls).read().split()
        return {
            "out": proc.stdout + proc.stderr,
            "meta": meta,
            "creates": docker_calls.count("run"),
            "rms": docker_calls.count("rm"),
            "attempt_errs": sorted(f for f in os.listdir(rundir)
                                   if re.match(r"ninfer-start-attempt\d+\.err$", f)),
        }


class TestNinferCreateRetry(unittest.TestCase):

    def test_clean_create_does_not_retry(self):
        """The common case must stay one docker run."""
        r = run_start(fail_creates=0)
        self.assertIn("RC=0", r["out"])
        self.assertEqual(r["creates"], 1, r["out"])
        self.assertIn("ninfer_create_attempts_matched=1", r["meta"])
        self.assertEqual(r["attempt_errs"], [])

    def test_transient_create_failure_recovers(self):
        """THE REGRESSION: two ldcache faults then a good create must still measure."""
        r = run_start(fail_creates=2)
        self.assertIn("RC=0", r["out"])
        self.assertEqual(r["creates"], 3, r["out"])
        self.assertIn("ninfer_create_attempts_matched=3", r["meta"])
        self.assertIn("transient", r["out"])

    def test_each_failed_attempt_keeps_its_own_reason(self):
        """One overwritten error file cannot show that attempt 1 and 2 differed."""
        r = run_start(fail_creates=2)
        self.assertEqual(r["attempt_errs"],
                         ["ninfer-start-attempt1.err", "ninfer-start-attempt2.err"])
        self.assertIn("ldcache error", r["out"])

    def test_name_is_freed_before_every_attempt(self):
        """A create that fails after claiming the name would else die on a conflict."""
        r = run_start(fail_creates=2)
        self.assertGreaterEqual(r["rms"], 3, r["out"])

    def test_permanent_failure_is_bounded_and_recorded(self):
        """It must give up, say so in run.meta, and not probe a container that is not there."""
        r = run_start(fail_creates=99)
        self.assertIn("RC=1", r["out"])
        self.assertEqual(r["creates"], 4, r["out"])
        self.assertIn("ninfer_create_attempts_matched=FAILED after 4", r["meta"])
        # never claims the engine answered
        self.assertNotIn("answered /health", r["out"])

    def test_health_budget_is_overridable_and_says_a_slow_load_is_not_a_dead_one(self):
        """The 1800 s default threw away a run whose engine was merely slow.

        20260904-204015 timed out at 1800 s with the engine still loading; the
        NEXT run served the identical configuration after `model loaded in
        901.395 s`. The budget has to be raisable, and the give-up message has
        to tell the reader that silence between weights and readiness is normal
        -- otherwise the obvious (wrong) conclusion is that the engine hung.
        """
        r = run_start(fail_creates=0, probe_ok=False, budget="0")
        self.assertIn("RC=1", r["out"])
        self.assertIn("did not become healthy within 0s", r["out"])
        self.assertIn("SLOW load looks identical to a dead one", r["out"])
        self.assertIn("NINFER_HEALTH_BUDGET", r["out"])

    def test_try_count_is_overridable(self):
        """So a run can be made fail-fast when someone is watching it."""
        r = run_start(fail_creates=99, tries="2")
        self.assertEqual(r["creates"], 2, r["out"])
        self.assertIn("FAILED after 2", r["meta"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
