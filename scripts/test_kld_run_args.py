#!/usr/bin/env python3
"""kld-run.sh refuses a bad weights-axis invocation before it touches docker.

Every refusal here has to happen BEFORE preflight: preflight is where llama gets
inspected and, past it, stopped, and a mistake found after the stop costs a
~20 minute cold reload. So `docker` on PATH is a stub that records each call,
and every case asserts the stub was never reached.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, "scripts", "kld-run.sh")
CORPUS = ["--corpus", "/captures/corpus/kld-weights/code.txt"]


class KldRunArgs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.calls = os.path.join(self.tmp.name, "docker-calls")
        stub = os.path.join(self.tmp.name, "docker")
        with open(stub, "w") as f:
            f.write(f'#!/bin/sh\necho "$@" >> "{self.calls}"\nexit 97\n')
        os.chmod(stub, os.stat(stub).st_mode | stat.S_IEXEC)
        self.env = dict(os.environ, PATH=f"{self.tmp.name}:{os.environ['PATH']}")
        # .env is committed, but pin the keys the script reads so the test does
        # not depend on whatever mode the box was last switched to.
        self.env.update(GGUF_FILE="base.gguf", MODELS_DIR="//c/m", CAPTURES_DIR="//d/c", NGL="999")

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args):
        return subprocess.run(["bash", SCRIPT, *args], env=self.env, capture_output=True, text=True, timeout=60)

    def assert_refused(self, args, fragment):
        r = self.run_script(*args)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(fragment, r.stderr)
        self.assertFalse(os.path.exists(self.calls), "docker was reached before the refusal")

    def test_two_axes_at_once(self):
        self.assert_refused(CORPUS + ["--test-gguf", "q.gguf", "--test-kv", "q8_0"], "two axes")

    def test_base_gguf_without_test_gguf(self):
        self.assert_refused(CORPUS + ["--base-gguf", "q8.gguf"], "weights axis")

    def test_models2_without_test_gguf(self):
        self.assert_refused(CORPUS + ["--models2", "//d/m"], "weights axis")

    def test_absolute_path_outside_mounts(self):
        self.assert_refused(CORPUS + ["--test-gguf", "/etc/q.gguf"], "bare name under MODELS_DIR")

    def test_models2_path_needs_models2(self):
        self.assert_refused(CORPUS + ["--test-gguf", "/models2/q.gguf"], "needs --models2")

    def test_base_ngl_must_be_integer(self):
        self.assert_refused(CORPUS + ["--test-gguf", "q.gguf", "--base-ngl", "lots"], "--base-ngl")

    def test_chunks_must_be_positive(self):
        self.assert_refused(CORPUS + ["--test-gguf", "q.gguf", "--chunks", "0"], "--chunks")

    def test_control_valid_invocation_reaches_docker(self):
        """The negative control: a valid weights-axis call DOES reach docker.

        Without this, every case above would also pass against a script that
        refused everything.
        """
        r = self.run_script(*CORPUS, "--test-gguf", "q.gguf", "--base-gguf", "q8.gguf",
                            "--base-ngl", "44", "--chunks", "12", "--dry-run")
        self.assertNotEqual(r.returncode, 0)  # the stub fails the image check
        self.assertTrue(os.path.exists(self.calls), r.stdout + r.stderr)
        self.assertIn("Weights fidelity run", r.stdout)
        self.assertIn("/models/q8.gguf", r.stdout)


if __name__ == "__main__":
    unittest.main()
