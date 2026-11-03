#!/usr/bin/env python3
"""A forge pointed at a backend that is not running is not "still loading".

Seen 2026-11-03: .env.local still said FORGE_BACKEND_URL=http://capture:8082
from a `capture.sh on` two days earlier, but the recorder sits behind the
`capture` compose profile, so up.sh recreated forge pointed at it without ever
starting it. forge answered /forge/health, /health was a 502, and pi-local.sh
said llama-server was "still reading the GGUF", while llama had finished
loading minutes earlier. The user was told to wait for a load that had already
finished.

Two fixes, one test each:
  * compose() turns on the `capture` profile whenever forge's backend is the
    recorder, so every caller (up.sh, update.sh, mode.sh...) starts it.
  * forge_not_ready_msg probes llama directly and names the real cause.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest

BASH = shutil.which("bash") or "/bin/bash"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(REPO, "scripts", "lib.sh")

STUB_DOCKER = """#!/bin/sh
printf 'PROFILES=%s\\n' "$COMPOSE_PROFILES"
"""

# Answers the http_code from CODE_<host>_<port> (dots and dashes -> _), or 000.
STUB_CURL = """#!/usr/bin/env bash
url="${@: -1}"
hp="${url#http://}"; hp="${hp%%/*}"
var="CODE_$(printf '%s' "$hp" | tr '.:-' '___')"
printf '%s' "${!var:-000}"
"""


def run(script: str, env: dict[str, str]) -> str:
    with tempfile.TemporaryDirectory() as bindir:
        for name, body in (("docker", STUB_DOCKER), ("curl", STUB_CURL)):
            path = os.path.join(bindir, name)
            with open(path, "w") as fh:
                fh.write(body)
            os.chmod(path, 0o755)
        full = dict(os.environ)
        full.pop("COMPOSE_PROFILES", None)
        full.update(env)
        full["PATH"] = bindir + os.pathsep + full["PATH"]
        proc = subprocess.run([BASH, "-c", f'source "{LIB}"; {script}'],
                              capture_output=True, text=True, env=full, timeout=60)
        return proc.stdout + proc.stderr


class ComposeProfile(unittest.TestCase):
    def profiles(self, env: dict[str, str]) -> str:
        out = run("compose up -d", env)
        line = [ln for ln in out.splitlines() if ln.startswith("PROFILES=")]
        self.assertTrue(line, out)
        return line[0].removeprefix("PROFILES=")

    def test_capture_backend_enables_profile(self) -> None:
        self.assertEqual(self.profiles({"FORGE_BACKEND_URL": "http://capture:8082"}), "capture")

    def test_llama_backend_leaves_profiles_alone(self) -> None:
        self.assertEqual(self.profiles({"FORGE_BACKEND_URL": "http://llama:8080"}), "")

    def test_existing_profiles_are_kept(self) -> None:
        got = self.profiles({"FORGE_BACKEND_URL": "http://capture:8082", "COMPOSE_PROFILES": "spec"})
        self.assertEqual(got.split(","), ["spec", "capture"])

    def test_no_duplicate(self) -> None:
        got = self.profiles({"FORGE_BACKEND_URL": "http://capture:8082", "COMPOSE_PROFILES": "capture"})
        self.assertEqual(got, "capture")


class NotReadyMessage(unittest.TestCase):
    LLAMA = "http://llama.test:8080"

    def msg(self, llama_code: str, backend: str = "http://llama:8080") -> str:
        return run(f'forge_not_ready_msg "{self.LLAMA}"',
                   {"CODE_llama_test_8080": llama_code, "FORGE_BACKEND_URL": backend})

    def test_loaded_llama_is_not_called_loading(self) -> None:
        out = self.msg("200", backend="http://capture:8082")
        self.assertNotIn("still reading", out)
        self.assertIn("http://capture:8082", out)
        self.assertIn("capture.sh", out)

    def test_loaded_llama_other_backend(self) -> None:
        out = self.msg("200", backend="http://elsewhere:9000")
        self.assertNotIn("still reading", out)
        self.assertIn("http://elsewhere:9000", out)
        self.assertNotIn("capture.sh", out)

    def test_loading_llama_says_loading(self) -> None:
        self.assertIn("still reading the GGUF", self.msg("503"))

    def test_unreachable_llama_says_so(self) -> None:
        out = self.msg("000")
        self.assertNotIn("still reading", out)
        self.assertIn("not answering", out)

    def test_progress_hint_does_not_assume_pid_7(self) -> None:
        self.assertNotIn("/proc/7/", self.msg("503"))


if __name__ == "__main__":
    unittest.main()
