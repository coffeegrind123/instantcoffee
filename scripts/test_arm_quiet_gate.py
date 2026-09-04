#!/usr/bin/env python3
"""The per-arm quiet gate: does it hold a busy box off, and let a quiet one through?

WHY THIS FILE EXISTS. ninfer-compare.sh cannot interleave its arms -- one 17 GiB
model at a time fits on the card -- so the second arm starts ten to twenty
minutes after the first, once ninfer has cold-loaded. wait-quiet.sh gates the
START of the run and is structurally unable to gate that second arm. Run
20260904-120707 was lost to exactly this: llama measured at mean load 2.12,
ninfer twelve minutes later at mean 18.02, peak 19.65, on a box three other
sessions had filled in between. The numbers looked perfectly reasonable.

The gate must therefore do four things, and each has a test here:
  * let a quiet box through, and only after HOLD consecutive clean samples --
    a single passing sample once caught a box at 1-min 1.36 with 5-min 7.36 on
    its way back up;
  * refuse to hang forever, because an arm that never runs is worse than one
    with a caveat -- on timeout it returns non-zero, the caller measures anyway,
    and run.meta says so IN THE FILE, not just on a console nobody kept;
  * treat a running rust toolchain as disqualifying at ANY load, because a build
    that is only just starting has not moved the 1-minute average yet;
  * never look at llama's health, which is what wait-quiet.sh does. llama is
    STOPPED for the whole ninfer arm, so a health check there would block until
    timeout on every single ninfer arm and turn the guard into a hang.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(REPO, "scripts", "lib.sh")
COMPARE = os.path.join(REPO, "scripts", "ninfer-compare.sh")


def run_gate(load: str, env: dict[str, str], meta: str | None = None,
             busy_cmd: str = "echo 0") -> tuple[int, str, str]:
    """Call wait_arm_quiet in a real bash, with errexit left ON as lib.sh sets it."""
    with tempfile.TemporaryDirectory() as td:
        loadfile = os.path.join(td, "loadavg")
        with open(loadfile, "w") as fh:
            fh.write(load + "\n")
        metafile = meta if meta is not None else os.path.join(td, "run.meta")
        full = dict(os.environ)
        full.update({
            "ARM_LOADAVG_FILE": loadfile,
            "ARM_BUSY_CMD": busy_cmd,
            "ARM_QUIET_EVERY": "0",
        })
        full.update(env)
        proc = subprocess.run(
            # `if` so that errexit -- which lib.sh turns on -- does not kill the
            # shell on the timeout path before the return code can be printed.
            ["bash", "-c",
             f'source "{LIB}"; '
             f'if wait_arm_quiet arm "{metafile}"; then rc=0; else rc=$?; fi; '
             f'echo "rc=$rc"'],
            capture_output=True, text=True, env=full, timeout=60,
        )
        written = ""
        if os.path.exists(metafile):
            with open(metafile) as fh:
                written = fh.read()
        return proc.returncode, proc.stdout + proc.stderr, written


class QuietGate(unittest.TestCase):
    def test_a_quiet_box_is_let_through_and_recorded_as_ready(self):
        rc, out, meta = run_gate("0.42 0.50 0.60", {"ARM_QUIET_HOLD": "2"})
        self.assertIn("rc=0", out)
        self.assertIn("quiet_gate_arm=result=ready", meta)
        self.assertIn("load=0.42", meta)

    def test_a_loud_box_times_out_rather_than_hanging(self):
        rc, out, meta = run_gate(
            "40.00 38.00 30.00",
            {"ARM_QUIET_HOLD": "3", "ARM_QUIET_TIMEOUT": "1", "ARM_QUIET_EVERY": "1"},
        )
        self.assertIn("rc=1", out)
        self.assertIn("quiet_gate_arm=result=TIMEOUT", meta)

    def test_the_timeout_verdict_reaches_run_meta_not_only_the_console(self):
        """A caveat that lives only on a console is a caveat nobody reads later."""
        _, _, meta = run_gate(
            "40.00 38.00 30.00",
            {"ARM_QUIET_TIMEOUT": "1", "ARM_QUIET_EVERY": "1"},
        )
        self.assertIn("TIMEOUT", meta)
        self.assertIn("load=40.00", meta)

    def test_a_rust_build_disqualifies_a_box_that_looks_quiet(self):
        """A build that is only just starting has not moved the 1-minute average."""
        rc, out, meta = run_gate(
            "0.10 0.10 0.10",
            {"ARM_QUIET_TIMEOUT": "1", "ARM_QUIET_EVERY": "1"},
            busy_cmd="echo 2",
        )
        self.assertIn("rc=1", out)
        self.assertIn("result=TIMEOUT", meta)
        self.assertIn("busy=2", meta)

    def test_one_clean_sample_is_not_a_quiet_window(self):
        """HOLD consecutive samples, and a dirty one resets the streak to zero."""
        with tempfile.TemporaryDirectory() as td:
            counter = os.path.join(td, "n")
            # busy for the first two calls, clean afterwards
            busy = (f'n=$(cat {counter} 2>/dev/null || echo 0); '
                    f'echo $((n+1)) > {counter}; '
                    f'if [ "$n" -lt 2 ]; then echo 1; else echo 0; fi')
            rc, out, meta = run_gate(
                "0.20 0.20 0.20",
                {"ARM_QUIET_HOLD": "3", "ARM_QUIET_TIMEOUT": "30", "ARM_QUIET_EVERY": "0"},
                busy_cmd=busy,
            )
            self.assertIn("rc=0", out)
            self.assertIn("result=ready", meta)
            with open(counter) as fh:
                calls = int(fh.read())
            # 2 dirty + 3 clean; anything fewer means HOLD was not honoured.
            self.assertGreaterEqual(calls, 5)

    def test_the_gate_can_be_disabled_on_purpose(self):
        rc, out, meta = run_gate("99.00 99.00 99.00", {"ARM_QUIET_TIMEOUT": "0"})
        self.assertIn("rc=0", out)
        self.assertIn("quiet_gate_arm=result=disabled", meta)

    def test_it_survives_errexit(self):
        """lib.sh sets `set -euo pipefail`. `[[ test ]] && cmd` returns 1 when the
        test fails, which under errexit aborts the function -- so the ordinary
        no-meta-file and empty-streak paths must not be written that way."""
        proc = subprocess.run(
            ["bash", "-c",
             f'set -euo pipefail; source "{LIB}"; '
             f'ARM_LOADAVG_FILE=/dev/null ARM_QUIET_TIMEOUT=0 wait_arm_quiet arm ""; '
             f'echo SURVIVED'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertIn("SURVIVED", proc.stdout)

    def test_the_gate_does_not_wait_on_llama_health(self):
        """llama is STOPPED for the whole ninfer arm. A health check here -- which
        is what wait-quiet.sh does, correctly, for the start of a run -- would
        block until timeout on every ninfer arm."""
        with open(LIB) as fh:
            src = fh.read()
        start = src.index("wait_arm_quiet()")
        body = src[start:]
        self.assertNotIn("State.Health", body)
        self.assertNotIn("instantcoffee-llama", body)


class Wiring(unittest.TestCase):
    def test_bench_arm_actually_calls_the_gate(self):
        """A gate nothing calls is a comment."""
        with open(COMPARE) as fh:
            src = fh.read()
        start = src.index("bench_arm() {")
        body = src[start:]
        self.assertIn("wait_arm_quiet", body)
        # before the bench container is started, not after it has measured
        self.assertLess(body.index("wait_arm_quiet"),
                        body.index("compose --profile tools run"))

    def test_the_gate_writes_into_this_runs_meta(self):
        with open(COMPARE) as fh:
            src = fh.read()
        self.assertIn('wait_arm_quiet "$label" "$RUN_DIR/run.meta"', src)

    def test_a_gate_timeout_does_not_abort_the_run(self):
        """On timeout the arm is still measured -- with the caveat recorded."""
        with open(COMPARE) as fh:
            src = fh.read()
        self.assertIn('wait_arm_quiet "$label" "$RUN_DIR/run.meta" || true', src)


if __name__ == "__main__":
    unittest.main()


class ContainerAge(unittest.TestCase):
    """Container age is a measurement input, not trivia.

    Three llama arms on identical weights at effectively identical load gave
    wall-clock prefill 1567.8, 1686.8 and 1923.8 t/s; the only variable that
    tracked was how long the container had been up (~6 min, 8.75 min, ~40 min).
    The engine's own counter carried ~10% of it and the server path the rest, and
    the per-round trend inside a fresh run RISES -- so the single discarded
    warm-up round the bench already does cannot absorb it.
    """

    def test_age_of_a_missing_container_is_empty_not_zero(self):
        """Zero would read as 'just started', which is a measurement claim. An
        absent container has no age and must say so."""
        proc = subprocess.run(
            ["bash", "-c",
             f'source "{LIB}"; a="$(container_age_s no-such-container-xyz)"; '
             f'echo "age=[$a]"'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertIn("age=[]", proc.stdout)

    def test_waiting_for_age_zero_returns_at_once(self):
        proc = subprocess.run(
            ["bash", "-c",
             f'set -euo pipefail; source "{LIB}"; '
             f'wait_container_age no-such-container-xyz 0 arm ""; echo DONE'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertIn("DONE", proc.stdout)

    def test_waiting_on_a_missing_container_does_not_hang(self):
        """An arm that cannot find its container is a different failure, and the
        warm-up hold is not the place to raise it -- but it must not block."""
        proc = subprocess.run(
            ["bash", "-c",
             f'set -euo pipefail; source "{LIB}"; '
             f'wait_container_age no-such-container-xyz 99999 arm ""; echo DONE'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertIn("DONE", proc.stdout)

    def test_bench_arm_records_age_at_both_ends(self):
        """Recorded at both ends so a long arm cannot hide a container that was
        fresh when the arm began."""
        with open(COMPARE) as fh:
            src = fh.read()
        self.assertIn('container_age_s_$label=start=${age_start:-unknown} end=', src)
        start = src.index("bench_arm() {")
        body = src[start:]
        # captured before the bench runs, written after it
        self.assertLess(body.index('age_start="$(container_age_s'),
                        body.index("compose --profile tools run"))
        self.assertLess(body.index("compose --profile tools run"),
                        body.index("container_age_s_$label=start="))

    def test_each_arm_ages_its_own_engines_container(self):
        """The llama arm must not report ninfer's age, and the 262K arm shares
        the matched arm's container name."""
        with open(COMPARE) as fh:
            src = fh.read()
        self.assertIn('case "$label" in llama) ct="$LLAMA_CT" ;; *) ct="$NINFER_CT" ;; esac', src)

    def test_min_container_age_is_settable_and_defaults_to_off(self):
        with open(COMPARE) as fh:
            src = fh.read()
        self.assertIn('MIN_CONTAINER_AGE="${MIN_CONTAINER_AGE:-0}"', src)
        self.assertIn('--min-container-age) MIN_CONTAINER_AGE="$2"; shift 2 ;;', src)

    def test_the_warmup_hold_runs_before_the_quiet_gate(self):
        """Both can take minutes; waiting for one after the other is waste."""
        with open(COMPARE) as fh:
            src = fh.read()
        start = src.index("bench_arm() {")
        body = src[start:]
        # the CALL sites, not the comments above them that name both functions
        self.assertLess(body.index('  wait_container_age "$ct"'),
                        body.index('  wait_arm_quiet "$label"'))
