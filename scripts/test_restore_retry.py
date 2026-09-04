#!/usr/bin/env python3
"""restore(): does the stack actually come back, and does it SAY SO when it does not?

WHY THIS FILE EXISTS. On 2026-09-04 a ninfer arm died at container create with

    nvidia-container-cli: ldcache error: process /sbin/ldconfig terminated with
    signal 9

and restore's one and only `docker start` died with the identical fault, rc=1.
restore() then returned 0, the script exited reporting nothing wrong, and
instantcoffee-llama -- the production stack -- stayed DOWN until a human
happened to look at `docker ps`. Six minutes, and it was luck that it was six.

Two separate defects, one test file:

  * ONE ATTEMPT IS THE WRONG NUMBER. The fault that makes restore necessary is
    the same transient hook fault that makes a single start fail, so the retry
    is not belt-and-braces -- it is the whole mechanism. (Measured that day:
    dropping the Docker VM page cache took the box 5.0 -> 14 GiB free and the
    start STILL failed; ~3 minutes later the same command worked untouched. The
    remedy is waiting, not reclaiming, which is why the retry sleeps.)

  * A FAILED RESTORE MUST BE LOUD. The old form sent the reason to /dev/null and
    logged a bare `rc=1`, so the one artefact a later reader would consult
    recorded that it failed and not one word of why.

The guard against over-correction is test_restore_is_idempotent: retrying must
not turn the double-invocation (failure path + EXIT trap) into two restores.
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

LDCACHE_ERR = (
    "Error response from daemon: failed to create task for container: "
    "nvidia-container-cli: ldcache error: process /sbin/ldconfig "
    "terminated with signal 9"
)


def run_restore(fail_starts: int, running: str = "false",
                calls: int = 1) -> tuple[int, str, str, str]:
    """Drive the real restore() against a stub docker that fails `fail_starts` times.

    Returns (rc, stdout+stderr, restore.log, llama-restart.err).
    """
    with tempfile.TemporaryDirectory() as td:
        rundir = os.path.join(td, "run")
        os.makedirs(rundir)
        counter = os.path.join(td, "n")
        with open(counter, "w") as fh:
            fh.write("0")

        # A stub `docker`, because the real failure is a daemon-side fault we
        # cannot summon on demand. It counts start attempts on disk so the count
        # survives the subshells restore() runs its inspects in.
        stub = f'''
docker() {{
  case "$1 $2" in
    "inspect -f")
       # {{{{.State.Running}}}} probe
       echo "{running}"; return 0 ;;
  esac
  case "$1" in
    rm)    return 0 ;;
    start)
       n=$(cat "{counter}"); n=$((n + 1)); echo "$n" > "{counter}"
       if [ "$n" -le {fail_starts} ]; then
         echo "{LDCACHE_ERR}" >&2
         return 1
       fi
       echo "llama"; return 0 ;;
  esac
  return 0
}}
'''
        # Extract the real restore() rather than reimplementing it -- a test
        # against a copy proves nothing about the script that ships.
        body = subprocess.run(
            ["sed", "-n", "/^restore()/,/^}/p", COMPARE],
            capture_output=True, text=True, check=True).stdout
        assert "docker start" in body, "did not extract restore()"

        script = (
            f'source "{LIB}"\n'
            f'{stub}\n'
            f'RUN_DIR="{rundir}"\n'
            'NINFER_CT=ninfer-bench\n'
            'LLAMA_CT=instantcoffee-llama\n'
            'RESTORED=0\n'
            f'{body}\n'
            + "".join(
                f'if restore; then echo "rc{i}=0"; else echo "rc{i}=$?"; fi\n'
                for i in range(calls))
        )
        env = dict(os.environ)
        env["RESTORE_RETRY_EVERY"] = "0"   # no real sleeping in tests
        proc = subprocess.run(["bash", "-c", script], capture_output=True,
                              text=True, env=env, timeout=120)
        log = ""
        logpath = os.path.join(rundir, "restore.log")
        if os.path.exists(logpath):
            log = open(logpath).read()
        err = ""
        errpath = os.path.join(rundir, "llama-restart.err")
        if os.path.exists(errpath):
            err = open(errpath).read()
        return proc.returncode, proc.stdout + proc.stderr, log, err


def attempts(log: str) -> int:
    return len(re.findall(r"llama start attempt \d+ rc=", log))


class TestRestoreRetry(unittest.TestCase):

    def test_clean_start_attempts_once(self):
        """The common case must not become eight docker calls."""
        rc, out, log, _ = run_restore(fail_starts=0)
        self.assertEqual(rc, 0, out)
        self.assertEqual(attempts(log), 1, log)
        self.assertIn("rc=0", log)
        self.assertNotIn("RESTORE FAILED", log)
        self.assertNotIn("RESTORE FAILED", out)

    def test_transient_failure_recovers(self):
        """THE REGRESSION. Two failed starts then a good one must restore the stack."""
        rc, out, log, _ = run_restore(fail_starts=2)
        self.assertEqual(rc, 0, out)
        self.assertEqual(attempts(log), 3, log)
        self.assertRegex(log, r"llama start attempt 3 rc=0")
        self.assertNotIn("RESTORE FAILED", log)
        self.assertNotIn("RESTORE FAILED", out)

    def test_why_it_failed_is_recorded_not_discarded(self):
        """`rc=1` alone is what made the real incident hard to read.

        restore.log is the ACCUMULATING record -- every failed attempt's reason
        lands there under its attempt number. llama-restart.err is the LAST
        attempt only, so on a recovered restore it holds the success and on a
        failed one it holds the fault the warn message points at
        (test_permanent_failure_is_loud_and_bounded asserts that half).
        """
        _, _, log, err = run_restore(fail_starts=2)
        self.assertIn("ldcache error", log)
        self.assertIn("signal 9", log)
        # both failures are in the log, not just the most recent one
        self.assertEqual(log.count("ldcache error"), 2, log)
        # the last attempt succeeded, so the scratch file holds that
        self.assertNotIn("ldcache error", err)

    def test_permanent_failure_is_loud_and_bounded(self):
        """It must give up, and must not pretend the stack is serving."""
        rc, out, log, err = run_restore(fail_starts=99)
        self.assertEqual(attempts(log), 8, log)
        self.assertIn("RESTORE FAILED", log)
        self.assertIn("IS DOWN", log)
        # the operator has to see it without opening a file
        self.assertIn("RESTORE FAILED", out)
        self.assertIn("--restore-only", out)
        self.assertIn("ldcache error", err)
        # restore() still returns 0: it runs from an EXIT trap and must not
        # replace the caller's exit status.
        self.assertEqual(rc, 0, out)

    def test_running_llama_is_left_alone(self):
        """Restore is called on every exit path, including ones that stopped nothing."""
        rc, out, log, _ = run_restore(fail_starts=99, running="true")
        self.assertEqual(rc, 0, out)
        self.assertEqual(attempts(log), 0, log)
        self.assertIn("llama already running", log)

    def test_restore_is_idempotent(self):
        """The failure path and the EXIT trap both call it; only one may act."""
        rc, out, log, _ = run_restore(fail_starts=0, calls=2)
        self.assertEqual(rc, 0, out)
        self.assertEqual(attempts(log), 1, log)
        # entered twice, acted once
        self.assertEqual(len(re.findall(r"restore entered", log)), 2, log)


if __name__ == "__main__":
    unittest.main(verbosity=2)
