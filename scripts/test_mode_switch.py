#!/usr/bin/env python3
"""mode.sh: every mode declares the same keys, and a window change reaches pi.

mode.sh only rewrites keys the target mode names, so a key one mode sets and
another omits SURVIVES a switch. Modes now come in 96K/128K/192K tiers, two
of them on GSQ from D:, so a surviving CTX_SIZE or MODELS_DIR would silently
keep the 192K window or the D: path after switching back to coding. And pi reads its context window
from models.json at launch, so a switch must rewrite it.

Runs against a temp mirror: .env comes from `git show HEAD:.env`, pi's agent
dir is a temp dir. No docker, no network.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODES = os.path.join(REPO, "modes")
KEY = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def mode_keys(name: str) -> dict[str, str]:
    out = {}
    with open(os.path.join(MODES, f"{name}.env")) as f:
        for line in f:
            m = KEY.match(line)
            if m:
                out[m.group(1)] = m.group(2).strip()
    return out


class ModeSwitch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        for sub in ("scripts", "modes"):
            os.symlink(os.path.join(REPO, sub), os.path.join(d, sub))
        env_text = subprocess.run(
            ["git", "-C", REPO, "show", "HEAD:.env"], capture_output=True, text=True, check=True
        ).stdout
        self.env_path = os.path.join(d, ".env")
        with open(self.env_path, "w") as f:
            f.write(env_text)
        self.agent = os.path.join(d, "agent")
        # Drop any exported stack key: env_get prefers the environment.
        keys = set().union(*(mode_keys(m).keys() for m in self.modes()))
        self.env = {k: v for k, v in os.environ.items() if k not in keys}
        self.env["PI_CODING_AGENT_DIR"] = self.agent
        self.script = os.path.join(d, "scripts", "mode.sh")

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def modes() -> list[str]:
        return sorted(f[:-4] for f in os.listdir(MODES) if f.endswith(".env"))

    def switch(self, mode: str) -> str:
        p = subprocess.run(["bash", self.script, mode], env=self.env,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout + p.stderr

    def env_value(self, key: str) -> str:
        with open(self.env_path) as f:
            vals = [m.group(2) for m in map(KEY.match, f) if m and m.group(1) == key]
        return vals[-1] if vals else ""

    def pi_window(self) -> int | None:
        path = os.path.join(self.agent, "models.json")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)["providers"]["forge"]["models"][0]["contextWindow"]

    def test_every_mode_declares_the_same_keys(self):
        sets = {m: set(mode_keys(m)) for m in self.modes()}
        union = set().union(*sets.values())
        for m, s in sets.items():
            self.assertEqual(s, union, f"{m} is missing {sorted(union - s)}")

    def test_dry_window_tracks_ctx(self):
        for m in self.modes():
            k = mode_keys(m)
            self.assertEqual(k["DRY_PENALTY_LAST_N"], k["CTX_SIZE"], m)

    def test_192k_and_back_resets_window_path_and_pi(self):
        self.switch("coding")
        out = self.switch("coding-192k")
        self.assertEqual(self.env_value("CTX_SIZE"), "196608")
        self.assertEqual(self.env_value("MODELS_DIR"), "//d/llm-models")
        self.assertEqual(self.pi_window(), 196608)
        self.assertIn("restart any running pi session", out)

        out = self.switch("coding")
        self.assertEqual(self.env_value("CTX_SIZE"), mode_keys("coding")["CTX_SIZE"])
        self.assertEqual(self.env_value("MODELS_DIR"), "//c/llm-models")
        self.assertEqual(self.env_value("GGUF_FILE"), mode_keys("coding")["GGUF_FILE"])
        self.assertEqual(self.pi_window(), int(mode_keys("coding")["CTX_SIZE"]))
        self.assertIn("restart any running pi session", out)

    def test_same_window_switch_leaves_pi_alone(self):
        by_ctx: dict[str, list[str]] = {}
        for m in self.modes():
            by_ctx.setdefault(mode_keys(m)["CTX_SIZE"], []).append(m)
        pair = next((ms[:2] for ms in by_ctx.values() if len(ms) >= 2), None)
        self.assertIsNotNone(pair, f"no two modes share a window: {by_ctx}")
        self.switch(pair[0])
        before = self.pi_window()
        out = self.switch(pair[1])
        self.assertNotIn("restart any running pi session", out)
        self.assertEqual(self.pi_window(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
