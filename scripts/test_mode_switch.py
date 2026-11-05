#!/usr/bin/env python3
"""mode.sh: backend-aware switching, local symmetry, and pi window refresh.

Local modes must declare one identical key set. Anthropic has its own hosted
keys, never reaches Docker, and records the local profile that `mode.sh local`
restores. Local windows come from CTX_SIZE; hosted windows come from
PI_CONTEXT_WINDOW.

Runs against a temp mirror. pi-local.sh is exercised for real through a logging
wrapper, while a fake docker executable fails loudly if a non-restart switch
reaches it. No real Docker or network is used.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MODES = REPO / "modes"
KEY = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

HOSTED = {
    "STACK_BACKEND": "anthropic",
    "ANTHROPIC_MODEL": "claude-opus-5-5",
    "ANTHROPIC_SUBAGENT_MODEL": "claude-haiku-5-5",
    "ANTHROPIC_ADVISOR_MODEL": "claude-fable-5-1",
    "PI_CONTEXT_WINDOW": "1000000",
    "PI_CACHE_SHORT_SECONDS": "300",
    "PI_CACHE_LONG_SECONDS": "3600",
    "PI_CACHE_WARMING": "idle",
    "PI_SHOW_CACHE_MISS_NOTICES": "1",
    "PI_CACHE_RETENTION": "long",
    "PI_UPDATE_MODELS_ON_LAUNCH": "1",
    "PI_COMPACTION_AT_PCT": "0.28",
    "PI_COMPACTION_KEEP_PCT": "0.15",
    "PI_OFFLINE": "0",
    "THINK_LANG": "off",
    "ORCHESTRATOR": "1",
    "SUBAGENTS_ENABLED": "1",
    "SUBAGENT_MODEL": "anthropic/claude-haiku-5-5",
    "ADVISOR_MODEL": "anthropic/claude-fable-5-1",
}


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
        d = Path(self.tmp.name)
        shutil.copytree(MODES, d / "modes")
        scripts = d / "scripts"
        scripts.mkdir()
        (scripts / "lib.sh").symlink_to(REPO / "scripts" / "lib.sh")
        (scripts / "mode.sh").symlink_to(REPO / "scripts" / "mode.sh")
        (scripts / "pi-local.real").symlink_to(REPO / "scripts" / "pi-local.sh")

        self.pi_log = d / "pi-installs.log"
        self.docker_log = d / "docker.log"
        self.pi_log.touch()
        self.docker_log.touch()
        wrapper = scripts / "pi-local.sh"
        wrapper.write_text(
            "#!/usr/bin/env bash\n"
            'printf "%s\\n" "$*" >> "${MODE_TEST_PI_LOG:?}"\n'
            'if [[ "${MODE_TEST_PI_EXIT:-0}" != 0 ]]; then\n'
            '  exit "${MODE_TEST_PI_EXIT}"\n'
            "fi\n"
            'exec "$(dirname "$0")/pi-local.real" "$@"\n'
        )
        wrapper.chmod(0o755)

        fake_bin = d / "bin"
        fake_bin.mkdir()
        fake_docker = fake_bin / "docker"
        fake_docker.write_text(
            "#!/usr/bin/env bash\n"
            'printf "%s\\n" "$*" >> "${MODE_TEST_DOCKER_LOG:?}"\n'
            'if [[ "${MODE_TEST_DOCKER_EXIT:-97}" != 0 ]]; then\n'
            '  echo "FAKE DOCKER INVOKED: $*" >&2\n'
            "  exit 97\n"
            "fi\n"
        )
        fake_docker.chmod(0o755)

        self.env_path = d / ".env"
        shutil.copyfile(REPO / ".env", self.env_path)
        self.agent = d / "agent"
        # Drop any exported stack key: env_get prefers the environment.
        keys = set().union(*(mode_keys(m).keys() for m in self.modes()))
        keys.add("STACK_LAST_LOCAL_MODE")
        keys.add("ANTHROPIC_API_KEY")
        local_state_keys = {
            "PI_OFFLINE",
            "ORCHESTRATOR",
            "SUBAGENTS_ENABLED",
            "SUBAGENT_MODEL",
            "ADVISOR_MODEL",
        }
        keys.update(local_state_keys)
        keys.update(f"STACK_LAST_LOCAL_{key}" for key in local_state_keys)
        self.env = {k: v for k, v in os.environ.items() if k not in keys}
        self.env["PATH"] = f"{fake_bin}{os.pathsep}{self.env.get('PATH', '')}"
        self.env["ANTHROPIC_API_KEY"] = "test-only-not-a-real-key"
        self.env["PI_CODING_AGENT_DIR"] = str(self.agent)
        self.env["MODE_TEST_PI_LOG"] = str(self.pi_log)
        self.env["MODE_TEST_DOCKER_LOG"] = str(self.docker_log)
        self.env["MODE_TEST_DOCKER_EXIT"] = "97"
        self.script = scripts / "mode.sh"

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def modes() -> list[str]:
        return sorted(f[:-4] for f in os.listdir(MODES) if f.endswith(".env"))

    def local_modes(self) -> list[str]:
        return [m for m in self.modes() if mode_keys(m)["STACK_BACKEND"] == "local"]

    def switch(self, *args: str) -> str:
        p = subprocess.run(["bash", str(self.script), *args], env=self.env,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout + p.stderr

    def env_value(self, key: str) -> str:
        with open(self.env_path) as f:
            vals = [m.group(2) for m in map(KEY.match, f) if m and m.group(1) == key]
        return vals[-1] if vals else ""

    def set_env_value(self, key: str, value: str) -> None:
        lines = self.env_path.read_text().splitlines()
        for i in range(len(lines) - 1, -1, -1):
            if KEY.match(lines[i]) and KEY.match(lines[i]).group(1) == key:
                lines[i] = f"{key}={value}"
                break
        else:
            self.fail(f"{key} is not present in .env")
        self.env_path.write_text("\n".join(lines) + "\n")

    def pi_window(self) -> int | None:
        path = self.agent / "models.json"
        if not path.exists():
            return None
        with open(path) as f:
            return json.load(f)["providers"]["forge"]["models"][0]["contextWindow"]

    def pi_installs(self) -> list[str]:
        return self.pi_log.read_text().splitlines()

    def docker_calls(self) -> list[str]:
        return self.docker_log.read_text().splitlines()

    def test_every_mode_declares_a_backend(self):
        for m in self.modes():
            self.assertIn("STACK_BACKEND", mode_keys(m), m)

    def test_mode_list_includes_the_local_alias(self):
        p = subprocess.run(["bash", str(self.script), "--list"], env=self.env,
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        listed = p.stdout.splitlines()
        self.assertIn("local", listed)
        for mode in self.modes():
            self.assertIn(mode, listed)

    def test_two_mode_targets_are_rejected(self):
        p = subprocess.run(["bash", str(self.script), "coding", "prose"], env=self.env,
                           capture_output=True, text=True, timeout=30)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("only one mode can be applied", p.stdout + p.stderr)

    def test_local_modes_declare_identical_keys(self):
        local_modes = self.local_modes()
        self.assertGreaterEqual(len(local_modes), 2)
        sets = {m: set(mode_keys(m)) for m in local_modes}
        union = set().union(*sets.values())
        for m, s in sets.items():
            self.assertEqual(s, union, f"{m} is missing {sorted(union - s)}")

    def test_anthropic_declares_hosted_config(self):
        keys = mode_keys("anthropic")
        for key, value in HOSTED.items():
            self.assertEqual(keys.get(key), value, key)
        self.assertEqual(keys["STACK_BACKEND"], "anthropic")

    def test_dry_window_tracks_ctx(self):
        for m in self.local_modes():
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
        for m in self.local_modes():
            by_ctx.setdefault(mode_keys(m)["CTX_SIZE"], []).append(m)
        pair = next((ms[:2] for ms in by_ctx.values() if len(ms) >= 2), None)
        self.assertIsNotNone(pair, f"no two modes share a window: {by_ctx}")
        self.switch(pair[0])
        before = self.pi_window()
        installs_before = len(self.pi_installs())
        out = self.switch(pair[1])
        self.assertNotIn("restart any running pi session", out)
        self.assertEqual(self.pi_window(), before)
        self.assertEqual(len(self.pi_installs()), installs_before)

    def test_local_to_anthropic_never_invokes_docker(self):
        self.switch("prose")
        self.pi_log.write_text("")

        out = self.switch("anthropic")
        self.assertEqual(self.env_value("STACK_BACKEND"), "anthropic")
        self.assertEqual(self.env_value("STACK_LAST_LOCAL_MODE"), "prose")
        self.assertEqual(self.env_value("PI_CONTEXT_WINDOW"), "1000000")
        self.assertIn("hosted Anthropic backend", out)
        self.assertIn("relaunch any running pi session", out)
        self.assertEqual(self.pi_installs(), ["--install-only"])
        self.assertEqual(self.docker_calls(), [])

        models_text = (self.agent / "models.json").read_text()
        models = json.loads(models_text)
        anthropic = models["providers"]["anthropic"]
        self.assertEqual(anthropic["apiKey"], "$ANTHROPIC_API_KEY")
        self.assertEqual(
            set(anthropic["modelOverrides"]),
            {
                HOSTED["ANTHROPIC_MODEL"],
                HOSTED["ANTHROPIC_SUBAGENT_MODEL"],
                HOSTED["ANTHROPIC_ADVISOR_MODEL"],
            },
        )
        self.assertNotIn("test-only-not-a-real-key", models_text)

        settings = json.loads((self.agent / "settings.json").read_text())
        main_compaction = settings["compaction"]["modelOverrides"][
            f"anthropic/{HOSTED['ANTHROPIC_MODEL']}"
        ]
        self.assertEqual(main_compaction["reserveTokens"], 720000)
        self.assertEqual(main_compaction["keepRecentTokens"], 150000)

        out = self.switch("anthropic", "--restart", "llama")
        self.assertIn("no-op in Anthropic mode", out)
        self.assertEqual(self.docker_calls(), [])

    def test_anthropic_to_last_local_restores_backend_and_forge(self):
        self.switch("coding")
        self.switch("anthropic")
        (self.agent / "models.json").unlink()
        self.pi_log.write_text("")

        out = self.switch("local")
        self.assertEqual(self.env_value("STACK_BACKEND"), "local")
        self.assertEqual(self.env_value("STACK_LAST_LOCAL_MODE"), "coding")
        self.assertEqual(self.env_value("CTX_SIZE"), mode_keys("coding")["CTX_SIZE"])
        self.assertEqual(self.pi_window(), int(mode_keys("coding")["CTX_SIZE"]))
        self.assertEqual(self.env_value("PI_OFFLINE"), "1")
        self.assertEqual(self.env_value("ORCHESTRATOR"), "0")
        self.assertEqual(self.env_value("SUBAGENT_MODEL"), "deepseek/deepseek-flash")
        self.assertEqual(self.env_value("ADVISOR_MODEL"), "")
        self.assertEqual(self.pi_installs(), ["--install-only"])
        self.assertNotIn("recreating llama", out)
        self.assertEqual(self.docker_calls(), [])

        with open(self.agent / "models.json") as f:
            forge = json.load(f)["providers"]["forge"]
        self.assertEqual(forge["api"], "openai-completions")
        settings = json.loads((self.agent / "settings.json").read_text())
        self.assertEqual(settings["cacheWarming"], "off")
        self.assertFalse(settings["showCacheMissNotices"])
        self.assertNotIn("anthropic/", json.dumps(settings))

    def test_anthropic_round_trip_preserves_local_team_settings(self):
        self.switch("coding")
        local_state = {
            "PI_OFFLINE": "0",
            "ORCHESTRATOR": "1",
            "SUBAGENTS_ENABLED": "1",
            "SUBAGENT_MODEL": "deepseek/deepseek-pro",
            "ADVISOR_MODEL": "deepseek/deepseek-flash",
        }
        for key, value in local_state.items():
            self.set_env_value(key, value)

        self.switch("anthropic")
        self.assertEqual(self.env_value("ORCHESTRATOR"), "1")
        self.assertEqual(self.env_value("SUBAGENT_MODEL"), "anthropic/claude-haiku-5-5")

        self.switch("local")
        for key, value in local_state.items():
            self.assertEqual(self.env_value(key), value, key)

    def test_backend_override_refuses_a_switch_it_cannot_apply(self):
        self.switch("coding")
        (Path(self.tmp.name) / ".env.local").write_text("STACK_BACKEND=local\n")

        p = subprocess.run(
            ["bash", str(self.script), "anthropic"],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("overridden by .env.local", p.stdout + p.stderr)
        self.assertEqual(self.env_value("STACK_BACKEND"), "local")

        (Path(self.tmp.name) / ".env.local").unlink()
        pinned = dict(self.env, STACK_BACKEND="local")
        p = subprocess.run(
            ["bash", str(self.script), "anthropic"],
            env=pinned,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("overridden by the environment", p.stdout + p.stderr)
        self.assertEqual(self.env_value("STACK_BACKEND"), "local")

    def test_non_backend_override_refuses_a_mode_it_cannot_apply(self):
        self.switch("coding")
        local = Path(self.tmp.name) / ".env.local"
        local.write_text("CTX_SIZE=131072\n")
        p = subprocess.run(
            ["bash", str(self.script), "coding-192k"],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("CTX_SIZE=131072 from .env.local", p.stdout + p.stderr)
        self.assertEqual(self.env_value("CTX_SIZE"), mode_keys("coding")["CTX_SIZE"])

    def test_duplicate_mode_keys_are_rejected(self):
        bad = Path(self.tmp.name) / "modes" / "bad.env"
        shutil.copyfile(MODES / "coding.env", bad)
        with bad.open("a") as f:
            f.write("\nCTX_SIZE=1\n")
        p = subprocess.run(
            ["bash", str(self.script), "bad"],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("declares duplicate keys: CTX_SIZE", p.stdout + p.stderr)

    def test_provider_config_failure_is_a_mode_failure(self):
        self.switch("coding")
        before = self.env_path.read_text()
        p = subprocess.run(
            ["bash", str(self.script), "anthropic"],
            env=dict(self.env, MODE_TEST_PI_EXIT="42"),
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("pi config was not rewritten", p.stdout + p.stderr)
        self.assertIn("restored .env", p.stdout + p.stderr)
        self.assertEqual(self.env_path.read_text(), before)

    def test_restart_llama_is_opt_in(self):
        self.switch("coding")
        self.env["MODE_TEST_DOCKER_EXIT"] = "0"
        self.docker_log.write_text("")

        out = self.switch("coding", "--restart", "llama")
        self.assertIn("recreating llama", out)
        self.assertEqual(self.docker_calls(), ["compose up -d --force-recreate llama"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
