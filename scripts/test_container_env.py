#!/usr/bin/env python3
"""A per-invocation override has to reach pi-local.sh inside the container.

WHY THIS FILE EXISTS. `env_get` lets an exported variable win over .env, so

    ORCHESTRATOR=1 ./scripts/pi-local.sh

works. The same line through ./scripts/pi-container.sh did nothing: the
script ends in `docker exec ... pi-local.sh`, and docker exec starts the
process with the CONTAINER's environment, not the caller's. The override was
dropped in silence and the session came up without orchestrator mode
(2026-09-24).

pi-container.sh now forwards every variable that is exported in the caller
AND is a key the stack reads (.env, .env.local, .env.local.example), as
`-e NAME` with no value — docker copies the value from its own environment, so
a secret never appears on a command line or in --print-only. These tests drive
`env_forward_args` from lib.sh, which is what both exec paths call.
"""

from __future__ import annotations

import os
import subprocess
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def forward(env: dict[str, str]) -> list[str]:
    """What env_forward_args prints, one argument per line, under `env`."""
    base = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME")}
    out = subprocess.run(
        ["bash", "-c", 'source scripts/lib.sh; env_forward_args'],
        cwd=REPO, env={**base, **env}, capture_output=True, text=True, check=True,
    )
    return out.stdout.split("\n")[:-1] if out.stdout else []


class EnvForwarding(unittest.TestCase):
    def test_an_exported_env_key_is_forwarded_by_name(self) -> None:
        self.assertEqual(forward({"ORCHESTRATOR": "1"}), ["-e", "ORCHESTRATOR"])

    def test_the_value_never_appears(self) -> None:
        args = forward({"SUBAGENT_MAX_CONCURRENT": "7"})
        self.assertIn("SUBAGENT_MAX_CONCURRENT", args)
        self.assertNotIn("7", " ".join(args))

    def test_a_key_only_in_the_example_file_is_forwarded(self) -> None:
        # DEEPSEEK_API_KEY lives in .env.local; the tracked example documents it.
        self.assertIn("DEEPSEEK_API_KEY", forward({"DEEPSEEK_API_KEY": "sk-test"}))

    def test_an_unrelated_variable_is_not(self) -> None:
        self.assertEqual(forward({"SOME_UNRELATED_THING": "x"}), [])

    def test_nothing_exported_forwards_nothing(self) -> None:
        self.assertEqual(forward({}), [])

    def test_control_the_keys_exist_where_the_scan_looks(self) -> None:
        # Without this, a scan that matched no file would pass every negative above.
        with open(os.path.join(REPO, ".env"), encoding="utf-8") as fh:
            self.assertIn("\nORCHESTRATOR=", fh.read())
        with open(os.path.join(REPO, ".env.local.example"), encoding="utf-8") as fh:
            self.assertIn("DEEPSEEK_API_KEY=", fh.read())

    def test_both_exec_paths_use_it(self) -> None:
        with open(os.path.join(REPO, "scripts", "pi-container.sh"), encoding="utf-8") as fh:
            src = fh.read()
        execs = [ln for ln in src.splitlines()
                 if "docker exec" in ln and "pi-local.sh" in ln and not ln.lstrip().startswith("#")]
        self.assertGreaterEqual(len(execs), 2, "the print-only and the real exec")
        for ln in execs:
            self.assertIn("${FORWARD_ENV[@]}", ln, ln.strip())


if __name__ == "__main__":
    unittest.main()
