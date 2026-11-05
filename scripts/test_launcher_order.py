#!/usr/bin/env python3
"""Backend routing and launch-order checks for the pi launchers."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
PI_LOCAL = REPO / "scripts" / "pi-local.sh"
PI_CONTAINER = REPO / "scripts" / "pi-container.sh"


def write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class LauncherOrder(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="pi-launcher-test-")
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.pi_log = self.root / "pi.log"
        self.final_env_log = self.root / "pi-final-env.log"
        self.team_solve_env_log = self.root / "team-solve-env.log"
        self.curl_log = self.root / "curl.log"
        self.docker_log = self.root / "docker.log"
        self.models = self.root / "models"
        self.models.write_text(
            "anthropic claude-main-test\n"
            "anthropic claude-child-test\n"
            "anthropic claude-advisor-test\n"
            "deepseek deepseek-flash\n",
            encoding="utf-8",
        )

        write_executable(
            self.bin / "pi",
            """#!/usr/bin/env bash
printf '%q ' "$@" >> "$PI_FAKE_LOG"
printf '\\n' >> "$PI_FAKE_LOG"
case "${1:-}" in
  --version) printf '9.9.9\\n' ;;
  list) : ;;
  update) exit "${PI_FAKE_UPDATE_RC:-0}" ;;
  --list-models)
    cat "$PI_FAKE_MODELS"
    ;;
esac
if [[ "${1:-}" == "--provider" ]]; then
  printf '%s\\n' "${PI_OFFLINE-<unset>}" >> "$PI_FINAL_ENV_LOG"
  printf '%s\\n' "${PI_TEAM_SOLVE_ACTIVE-<unset>}" >> "$TEAM_SOLVE_ENV_LOG"
fi
exit 0
""",
        )
        write_executable(
            self.bin / "curl",
            """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CURL_FAKE_LOG"
exit 0
""",
        )
        write_executable(
            self.bin / "docker",
            """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_FAKE_LOG"
case "${1:-}" in
  inspect)
    case "${3:-}" in
      *State.Status*) printf 'running\\n' ;;
      *Mounts*) printf '/home/piuser\\n' ;;
      *Image*) printf 'sha256:same\\n' ;;
    esac
    ;;
  image) printf 'sha256:same\\n' ;;
  exec) printf 'fake-ovis-status\\n' ;;
esac
exit 0
""",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def env(self, backend: str, **extra: str) -> dict[str, str]:
        env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "HOME": str(self.root / "home"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "PI_CODING_AGENT_DIR": str(self.root / "agent"),
            "PI_FAKE_LOG": str(self.pi_log),
            "PI_FAKE_MODELS": str(self.models),
            "PI_FINAL_ENV_LOG": str(self.final_env_log),
            "TEAM_SOLVE_ENV_LOG": str(self.team_solve_env_log),
            "CURL_FAKE_LOG": str(self.curl_log),
            "DOCKER_FAKE_LOG": str(self.docker_log),
            "STACK_BACKEND": backend,
            "ORCHESTRATOR": "1",
            "SUBAGENTS_ENABLED": "1",
            "SUBAGENT_MAX_CONCURRENT": "4",
            "PI_AUTO_UPDATE": "0",
            "PI_UPDATE_MODELS_ON_LAUNCH": "1",
            "PI_CONTEXT_FILES": "0",
            "PI_TELEMETRY": "0",
            "BROWSER_MCP_ENABLED": "0",
            "OBSERVE_ENABLED": "0",
            "PRINNY_ENABLED": "0",
            "RTK_ENABLED": "0",
            "PERSONA_ENABLED": "0",
            "MCP2CLI_ENABLED": "0",
            "THINK_LANG": "off",
            "SUBAGENT_VERIFY": "0",
            "DEEPSEEK_API_KEY": "test-deepseek-key",
            "ANTHROPIC_API_KEY": "test-anthropic-key",
            "ANTHROPIC_MODEL": "claude-main-test",
            "ANTHROPIC_SUBAGENT_MODEL": "claude-child-test",
            "ANTHROPIC_ADVISOR_MODEL": "claude-advisor-test",
            "PI_CONTEXT_WINDOW": "1000000",
            "PI_CACHE_WARMING": "idle",
            "PI_CACHE_RETENTION": "long",
            "PI_CACHE_SHORT_SECONDS": "300",
            "PI_CACHE_LONG_SECONDS": "3600",
            "PI_SHOW_CACHE_MISS_NOTICES": "1",
            "PI_COMPACTION_AT_PCT": "0.28",
            "PI_COMPACTION_KEEP_PCT": "0.15",
            "PI_CONTAINER_HOME_HOST": str(self.root / "container-home"),
            "PI_CONTAINER_HOME": "/home/piuser",
            "PI_CONTAINER_REPO": "/home/piuser/qwen-main",
            "PI_CONTAINER_NAME": "pi-test",
            "PI_CONTAINER_IMAGE": "pi-test:latest",
            "PI_CONTAINER_EXTRA_ARGS": "",
            "OVIS_ENABLED": "0",
        }
        env.update(extra)
        return env

    def run_launcher(
        self, backend: str, *args: str, **extra: str
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(PI_LOCAL), *args],
            cwd=REPO,
            env=self.env(backend, **extra),
            capture_output=True,
            text=True,
            timeout=30,
        )

    def read_seed(self) -> dict[str, object]:
        return json.loads((self.root / "agent" / "orchestrator-mode.json").read_text())

    def read_log(self, path: Path) -> list[str]:
        return path.read_text().splitlines() if path.exists() else []

    def test_local_defaults_and_seed_keep_forge_serialized(self) -> None:
        result = self.run_launcher(
            "local",
            "--print-only",
            SUBAGENT_MODEL="deepseek/deepseek-flash",
            ADVISOR_MODEL="",
            PI_OFFLINE="",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        seed = self.read_seed()
        self.assertEqual(seed["model"], "deepseek/deepseek-flash")
        self.assertNotIn("overrides", seed)
        self.assertEqual(
            seed["concurrency"],
            {"providers": {"deepseek": 4, "forge": 1}},
        )
        self.assertIn("--provider forge", result.stdout)

    def test_hosted_defaults_write_anthropic_metadata_without_the_secret(self) -> None:
        result = self.run_launcher(
            "anthropic",
            "--print-only",
            SUBAGENT_MODEL="deepseek/deepseek-flash",
            ADVISOR_MODEL="",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        seed = self.read_seed()
        self.assertEqual(seed["model"], "anthropic/claude-child-test")
        self.assertEqual(
            seed.get("overrides"),
            {"advisor": "anthropic/claude-advisor-test"},
        )
        self.assertEqual(
            seed["concurrency"],
            {"providers": {"anthropic": 4, "forge": 1}},
        )

        models = json.loads((self.root / "agent" / "models.json").read_text())
        self.assertEqual(
            models["providers"]["anthropic"]["apiKey"],
            "$ANTHROPIC_API_KEY",
        )
        self.assertEqual(
            models["providers"]["anthropic"]["modelOverrides"]["claude-main-test"],
            {"promptCache": {"short": 300, "long": 3600}},
        )
        self.assertNotIn(
            "test-anthropic-key",
            json.dumps(models),
        )
        settings = json.loads((self.root / "agent" / "settings.json").read_text())
        self.assertEqual(
            settings["compaction"]["modelOverrides"]["anthropic/claude-child-test"],
            {"reserveTokens": 720000, "keepRecentTokens": 150000},
        )
        self.assertEqual(settings["cacheWarming"], "idle")
        self.assertEqual(settings["showCacheMissNotices"], True)
        self.assertIn("--provider anthropic", result.stdout)

    def test_hosted_install_only_configures_without_a_key(self) -> None:
        result = self.run_launcher(
            "anthropic",
            "--install-only",
            ANTHROPIC_API_KEY="",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        models = json.loads((self.root / "agent" / "models.json").read_text())
        self.assertEqual(
            models["providers"]["anthropic"]["apiKey"],
            "$ANTHROPIC_API_KEY",
        )
        settings = json.loads((self.root / "agent" / "settings.json").read_text())
        self.assertEqual(settings["cacheWarming"], "idle")
        self.assertNotIn("test-anthropic-key", json.dumps(models))

    def test_hosted_refreshes_catalog_before_both_model_probes(self) -> None:
        result = self.run_launcher("anthropic")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.read_log(self.pi_log)
        update = next(i for i, line in enumerate(commands) if line.startswith("update --models"))
        probes = [i for i, line in enumerate(commands) if line.startswith("--list-models ")]
        self.assertGreaterEqual(len(probes), 3)
        self.assertTrue(all(update < probe for probe in probes), commands)
        self.assertEqual(self.read_log(self.curl_log), [])
        self.assertEqual(commands[-1].split()[0:2], ["--provider", "anthropic"])
        self.assertIn("[backend: anthropic/anthropic]", result.stdout)
        self.assertIn("subagents: anthropic/claude-child-test", result.stdout)
        self.assertIn("advisor: anthropic/claude-advisor-test", result.stdout)
        self.assertEqual(self.read_log(self.final_env_log), ["<unset>"])

    def test_hosted_catalog_refresh_fails_soft(self) -> None:
        result = self.run_launcher("anthropic", PI_FAKE_UPDATE_RC="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.read_log(self.pi_log)
        update = next(i for i, line in enumerate(commands) if line.startswith("update --models"))
        probes = [i for i, line in enumerate(commands) if line.startswith("--list-models ")]
        self.assertTrue(probes)
        self.assertTrue(all(update < probe for probe in probes), commands)
        self.assertIn("catalog refresh failed", result.stdout)

    def test_hosted_main_seat_is_probed_even_without_orchestrator(self) -> None:
        result = self.run_launcher("anthropic", ORCHESTRATOR="0")
        self.assertEqual(result.returncode, 0, result.stderr)
        probes = [
            line.strip()
            for line in self.read_log(self.pi_log)
            if line.startswith("--list-models ")
        ]
        self.assertIn("--list-models claude-main-test", probes)
        self.assertEqual(len(probes), 1)

    def test_team_solve_extension_is_hosted_only_and_can_be_disabled(self) -> None:
        hosted = self.run_launcher("anthropic")
        self.assertEqual(hosted.returncode, 0, hosted.stderr)
        self.assertIn("team-solve.ts", self.read_log(self.pi_log)[-1])
        self.assertIn("/team-solve", hosted.stdout)
        self.assertEqual(self.read_log(self.team_solve_env_log)[-1], "1")

        disabled = self.run_launcher("anthropic", TEAM_SOLVE_ENABLED="0")
        self.assertEqual(disabled.returncode, 0, disabled.stderr)
        self.assertNotIn("team-solve.ts", self.read_log(self.pi_log)[-1])
        self.assertNotIn("/team-solve", disabled.stdout)
        self.assertEqual(self.read_log(self.team_solve_env_log)[-1], "<unset>")

        local = self.run_launcher(
            "local",
            SUBAGENT_MODEL="deepseek/deepseek-flash",
            ADVISOR_MODEL="",
            PI_OFFLINE="",
            TEAM_SOLVE_ENABLED="1",
        )
        self.assertEqual(local.returncode, 0, local.stderr)
        self.assertNotIn("team-solve.ts", self.read_log(self.pi_log)[-1])
        self.assertNotIn("/team-solve", local.stdout)
        self.assertEqual(self.read_log(self.team_solve_env_log)[-1], "<unset>")

    def test_local_keeps_forge_probes_and_never_refreshes_catalog(self) -> None:
        result = self.run_launcher(
            "local",
            SUBAGENT_MODEL="deepseek/deepseek-flash",
            ADVISOR_MODEL="",
            PI_OFFLINE="",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.read_log(self.pi_log)
        self.assertFalse(any(line.startswith("update --models") for line in commands))
        curls = self.read_log(self.curl_log)
        self.assertEqual(len(curls), 2, curls)
        self.assertIn("/forge/health", curls[0])
        self.assertIn("/health", curls[1])
        self.assertEqual(commands[-1].split()[0:2], ["--provider", "forge"])
        self.assertIn("[backend: local/forge]", result.stdout)
        self.assertEqual(self.read_log(self.final_env_log), ["1"])
        ctx = int(
            next(
                line.split("=", 1)[1]
                for line in (REPO / ".env").read_text().splitlines()
                if line.startswith("CTX_SIZE=")
            )
        )
        settings = json.loads((self.root / "agent" / "settings.json").read_text())
        self.assertEqual(settings["compaction"]["reserveTokens"], ctx // 2)
        self.assertEqual(
            settings["compaction"]["keepRecentTokens"],
            max(2000, min(20000, round(ctx * 0.2))),
        )
        self.assertEqual(settings["cacheWarming"], "off")
        self.assertFalse(settings["showCacheMissNotices"])
        self.assertNotIn("anthropic/", json.dumps(settings))

    def test_invalid_backend_and_missing_hosted_key_refuse_launch(self) -> None:
        invalid = self.run_launcher("other", "--print-only")
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("STACK_BACKEND must be 'local' or 'anthropic'", invalid.stderr)

        missing = self.run_launcher("anthropic", "--print-only", ANTHROPIC_API_KEY="")
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("ANTHROPIC_API_KEY is not set", missing.stderr)

    def test_passthrough_cannot_override_backend_or_model_routing(self) -> None:
        local = self.run_launcher(
            "local",
            "--print-only",
            "--provider",
            "anthropic",
            "--model",
            "wrong/model",
            "-p",
            "hello world",
            SUBAGENT_MODEL="deepseek/deepseek-flash",
            ADVISOR_MODEL="",
            PI_OFFLINE="",
        )
        self.assertNotEqual(local.returncode, 0)
        self.assertIn("may not override backend routing", local.stderr)

        hosted = self.run_launcher(
            "anthropic",
            "--print-only",
            "--provider",
            "forge",
            "--model",
            "wrong/model",
            SUBAGENT_MODEL="deepseek/deepseek-flash",
            ADVISOR_MODEL="",
        )
        self.assertNotEqual(hosted.returncode, 0)
        self.assertIn("may not override backend routing", hosted.stderr)

        extra = self.run_launcher(
            "anthropic",
            "--print-only",
            PI_EXTRA_ARGS="--models claude-*",
            SUBAGENT_MODEL="deepseek/deepseek-flash",
            ADVISOR_MODEL="",
        )
        self.assertNotEqual(extra.returncode, 0)
        self.assertIn("PI_EXTRA_ARGS may not override", extra.stderr)

    def test_print_only_includes_caller_arguments(self) -> None:
        result = self.run_launcher(
            "local",
            "--print-only",
            "-p",
            "hello world",
            SUBAGENT_MODEL="deepseek/deepseek-flash",
            ADVISOR_MODEL="",
            PI_OFFLINE="",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-p ", result.stdout)
        self.assertIn(r"hello\ world", result.stdout)

    def test_context_and_compaction_values_are_range_checked(self) -> None:
        local = self.run_launcher("local", "--print-only", CTX_SIZE="0")
        self.assertNotEqual(local.returncode, 0)
        self.assertIn("CTX_SIZE must be a positive integer", local.stderr)

        hosted = self.run_launcher(
            "anthropic",
            "--print-only",
            PI_COMPACTION_AT_PCT="0.3",
            PI_COMPACTION_KEEP_PCT="0.4",
        )
        self.assertNotEqual(hosted.returncode, 0)
        self.assertIn("must be smaller than PI_COMPACTION_AT_PCT", hosted.stderr)

    def test_container_status_is_provider_aware_and_forge_is_not_probed_hosted(self) -> None:
        result = subprocess.run(
            [str(PI_CONTAINER), "--status"],
            cwd=REPO,
            env=self.env(
                "anthropic",
                SUBAGENT_MODEL="deepseek/deepseek-pro",
                ADVISOR_MODEL="anthropic/claude-advisor-override",
                PI_COMPACTION_AT_PCT="0.4",
                PI_COMPACTION_KEEP_PCT="0.2",
            ),
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("backend      anthropic (built-in provider)", result.stdout)
        self.assertIn(
            "api key      present on host; forwarded by the next hosted launch",
            result.stdout,
        )
        self.assertIn(
            "models       main=claude-main-test children=deepseek/deepseek-pro "
            "advisor=anthropic/claude-advisor-override",
            result.stdout,
        )
        self.assertIn("cache        idle; 0.4/0.2 compaction", result.stdout)
        self.assertIn("informational only", result.stdout)
        self.assertNotIn("test-anthropic-key", result.stdout + result.stderr)
        docker_calls = self.read_log(self.docker_log)
        self.assertFalse(any("curl" in line for line in docker_calls), docker_calls)

    def test_container_print_only_forwards_the_key_name_not_its_value(self) -> None:
        result = subprocess.run(
            [str(PI_CONTAINER), "--print-only"],
            cwd=REPO,
            env=self.env("anthropic"),
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-e ANTHROPIC_API_KEY", result.stdout)
        self.assertIn("-e STACK_BACKEND", result.stdout)
        self.assertNotIn("test-anthropic-key", result.stdout + result.stderr)

    def test_container_prompt_cannot_inject_control_flags_after_print_mode(self) -> None:
        result = subprocess.run(
            [str(PI_CONTAINER), "--print-only", "-p", "--stop"],
            cwd=REPO,
            env=self.env("anthropic"),
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-p --stop", result.stdout)
        self.assertFalse(
            any(" stop" in line or "stop " in line for line in self.read_log(self.docker_log)),
            self.read_log(self.docker_log),
        )

    def test_container_double_dash_ends_control_parsing(self) -> None:
        result = subprocess.run(
            [str(PI_CONTAINER), "--print-only", "--", "--stop"],
            cwd=REPO,
            env=self.env("anthropic"),
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-- --stop", result.stdout)
        self.assertFalse(
            any(" stop" in line or "stop " in line for line in self.read_log(self.docker_log)),
            self.read_log(self.docker_log),
        )


if __name__ == "__main__":
    unittest.main()
