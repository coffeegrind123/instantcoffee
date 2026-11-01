#!/usr/bin/env python3
"""Ovis in the pi container: the switch, the token, the port, and the pane.

What these pin, none of which needs a running container, herdr or Ovis:

  * OVIS_ENABLED defaults ON, and 0/false/no/off turn it off — on both sides of
    the container, because pi-container.sh (host) and ovis.sh (inside) share
    `ovis_enabled` from lib.sh.
  * pi-container.sh publishes the Ovis port on 127.0.0.1 only, from OVIS_PORT,
    and not at all when Ovis is off.
  * The token is generated once, mode 0600, and OVIS_TOKEN overrides it without
    touching the file.
  * A pane's launch script carries the caller's exported stack keys (herdr
    starts panes from its own environment and would drop them), deletes itself,
    drops the `pi` shim from PATH and execs the launcher with the arguments
    intact.
  * The `pi` shim removes itself from PATH before it runs pi-local.sh, whose
    own `exec pi` would otherwise run the launcher twice.
  * pi-local.sh loads herdr's pi integration only inside a herdr pane.

The end-to-end path (Ovis showing pi's own transcript and sending it a prompt)
was measured live on 2026-11-01; context/HANDOFF.md part 22.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import unittest

BASH = shutil.which("bash") or "/bin/bash"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, "scripts")
OVIS = os.path.join(SCRIPTS, "ovis.sh")
SHIM = os.path.join(SCRIPTS, "ovis-shims", "pi")
CONTAINER = os.path.join(SCRIPTS, "pi-container.sh")
PI_LOCAL = os.path.join(SCRIPTS, "pi-local.sh")

# Keys the stack reads that a caller might have exported for unrelated reasons.
# Cleared so the host's own environment cannot decide a test.
SCRUB = ("OVIS_ENABLED", "OVIS_PORT", "OVIS_TOKEN", "HERDR_ENV", "HERDR_PANE_ID", "ORCHESTRATOR")


def env_with(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in SCRUB}
    env.update(extra)
    return env


def sourced(script: str, **extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([BASH, "-c", f'source "{OVIS}"; {script}'], capture_output=True,
                          text=True, env=env_with(**extra), timeout=60)


class Switch(unittest.TestCase):
    def enabled(self, **extra: str) -> bool:
        return subprocess.run([BASH, OVIS, "enabled"], env=env_with(**extra),
                              capture_output=True, timeout=60).returncode == 0

    def test_on_by_default(self) -> None:
        self.assertTrue(self.enabled())

    def test_off_spellings(self) -> None:
        for value in ("0", "false", "no", "off", "OFF"):
            self.assertFalse(self.enabled(OVIS_ENABLED=value), value)

    def test_on_spellings(self) -> None:
        for value in ("1", "true", "yes", ""):
            self.assertTrue(self.enabled(OVIS_ENABLED=value), repr(value))

    def test_control_the_tracked_default_is_one(self) -> None:
        with open(os.path.join(REPO, ".env"), encoding="utf-8") as fh:
            self.assertIn("\nOVIS_ENABLED=1\n", fh.read())


class PublishedPort(unittest.TestCase):
    """The `docker run` line pi-container.sh would create the container with."""

    def run_line(self, **extra: str) -> str:
        if not shutil.which("docker"):
            self.skipTest("docker CLI not installed")
        env = env_with(PI_CONTAINER_HOME_HOST="//c/test/pi-home",
                       PI_CONTAINER_NAME="instantcoffee-pi-test-does-not-exist", **extra)
        proc = subprocess.run([BASH, CONTAINER, "--print-only"], capture_output=True, text=True,
                              env=env, timeout=60, stdin=subprocess.DEVNULL)
        line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("docker run")), "")
        self.assertTrue(line, f"no docker run line; stderr: {proc.stderr[-400:]}")
        return line

    def test_loopback_only_by_default(self) -> None:
        line = self.run_line()
        self.assertIn("-p 127.0.0.1:7317:7317", line)
        self.assertNotIn("0.0.0.0:7317", line)

    def test_host_port_follows_ovis_port(self) -> None:
        self.assertIn("-p 127.0.0.1:9123:7317", self.run_line(OVIS_PORT="9123"))

    def test_no_port_when_off(self) -> None:
        self.assertNotIn("7317", self.run_line(OVIS_ENABLED="0"))


class Token(unittest.TestCase):
    def test_generated_once_private_and_stable(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "cfg", "ovis", "token")
            first = sourced("token", OVIS_TOKEN_FILE=path).stdout
            second = sourced("token", OVIS_TOKEN_FILE=path).stdout
            self.assertRegex(first, r"^[0-9a-f]{48}$")
            self.assertEqual(first, second)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_ovis_token_wins_and_leaves_the_file_alone(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "token")
            self.assertEqual(sourced("token", OVIS_TOKEN_FILE=path, OVIS_TOKEN="from-env").stdout,
                             "from-env")
            self.assertFalse(os.path.exists(path))


class NoToken(unittest.TestCase):
    """OVIS_TOKEN=off: no token, none generated, and the server started without one."""

    def test_off_means_no_token_and_no_file(self) -> None:
        for value in ("off", "OFF"):
            with tempfile.TemporaryDirectory() as td:
                path = os.path.join(td, "token")
                self.assertEqual(sourced("token", OVIS_TOKEN_FILE=path, OVIS_TOKEN=value).stdout, "", value)
                self.assertFalse(os.path.exists(path), value)

    def test_the_server_starts_without_ovis_token(self) -> None:
        # The supervisor's own subshell, with bun replaced by a recorder: what
        # matters is what Ovis would see in its environment.
        with tempfile.TemporaryDirectory() as td:
            seen = os.path.join(td, "seen")
            for value, want in (("off", "UNSET"), ("s3cret", "s3cret")):
                script = (f'tok="$(token)"; ( if [[ -n "$tok" ]]; then export OVIS_TOKEN="$tok"; '
                          f'else unset OVIS_TOKEN; fi && echo "${{OVIS_TOKEN-UNSET}}" > "{seen}" )')
                sourced(script, OVIS_TOKEN=value)
                with open(seen) as fh:
                    self.assertEqual(fh.read().strip(), want, value)

    def test_control_the_supervisor_uses_that_wiring(self) -> None:
        # The case above replays the supervisor's lines; this pins that they are its lines.
        with open(OVIS, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('if [[ -n "$tok" ]]; then export OVIS_TOKEN="$tok"; else unset OVIS_TOKEN; fi', src)
        self.assertNotIn('OVIS_TOKEN="$tok" \\', src)


class LaunchScript(unittest.TestCase):
    """What a herdr pane runs: write it with ovis.sh, run it against a fake launcher."""

    def test_carries_keys_deletes_itself_and_keeps_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            run_dir = os.path.join(td, "run")
            work = os.path.join(td, "my project")
            os.makedirs(run_dir)
            os.makedirs(work)
            fake = os.path.join(td, "fake-pi-local")
            with open(fake, "w") as fh:
                fh.write('#!/usr/bin/env bash\necho "PWD=$PWD"\necho "ORCH=$ORCHESTRATOR"\n'
                         'echo "PATH=$PATH"\nfor a in "$@"; do echo "ARG=$a"; done\n')
            os.chmod(fake, 0o755)
            shim_dir = os.path.join(SCRIPTS, "ovis-shims")
            made = sourced(f'RUN_DIR="{run_dir}"; write_launch "{work}" --session "a b" -p "x\'y"',
                           OVIS_PI_LOCAL=fake, ORCHESTRATOR="1",
                           PATH=f"{shim_dir}:{os.environ['PATH']}")
            launch = made.stdout
            self.assertTrue(os.path.isfile(launch), made.stderr)
            self.assertEqual(stat.S_IMODE(os.stat(launch).st_mode), 0o600)

            out = subprocess.run([BASH, launch], capture_output=True, text=True,
                                 env=env_with(), timeout=60).stdout.splitlines()
            self.assertFalse(os.path.exists(launch), "the launch script must delete itself")
            self.assertIn(f"PWD={work}", out)
            self.assertIn("ORCH=1", out, "an exported stack key must reach the pane")
            path_line = next(ln for ln in out if ln.startswith("PATH="))
            self.assertNotIn(shim_dir, path_line)
            self.assertEqual([ln for ln in out if ln.startswith("ARG=")],
                             ["ARG=--session", "ARG=a b", "ARG=-p", "ARG=x'y"])


class Shim(unittest.TestCase):
    def test_leaves_path_and_execs_the_launcher_with_its_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            shim_dir = os.path.join(td, "scripts", "ovis-shims")
            os.makedirs(shim_dir)
            shutil.copy(SHIM, os.path.join(shim_dir, "pi"))
            launcher = os.path.join(td, "scripts", "pi-local.sh")
            with open(launcher, "w") as fh:
                fh.write('#!/usr/bin/env bash\necho "PATH=$PATH"\nprintf "ARG=%s\\n" "$@"\n')
            os.chmod(launcher, 0o755)
            env = env_with(PATH=f"{shim_dir}:{os.environ['PATH']}")
            out = subprocess.run(["pi", "--continue", "two words"], capture_output=True, text=True,
                                 env=env, timeout=60).stdout.splitlines()
            self.assertNotIn(shim_dir, next(ln for ln in out if ln.startswith("PATH=")))
            self.assertEqual([ln for ln in out if ln.startswith("ARG=")],
                             ["ARG=--continue", "ARG=two words"])

    def test_control_the_shim_is_what_ran(self) -> None:
        # Without this the test above could pass by running some other `pi`.
        self.assertTrue(os.access(SHIM, os.X_OK))


class Integration(unittest.TestCase):
    """pi-local.sh --print-only, with and without a herdr pane around it."""

    def flags(self, **extra: str) -> list[str]:
        with tempfile.TemporaryDirectory() as td:
            agent = os.path.join(td, "agent")
            os.makedirs(agent)
            env = env_with(PI_CODING_AGENT_DIR=agent, PI_AUTO_UPDATE="0", BROWSER_MCP_AUTOUP="0", **extra)
            proc = subprocess.run([BASH, PI_LOCAL, "--print-only"], capture_output=True, text=True,
                                  env=env, timeout=120, stdin=subprocess.DEVNULL)
            line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("pi ")), "")
            self.assertTrue(line, f"no command printed; stderr: {proc.stderr[-500:]}")
            return line.split()

    def test_loaded_inside_a_herdr_pane(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".ts") as ext:
            flags = self.flags(HERDR_ENV="1", HERDR_PANE_ID="w1:p1", OVIS_HERDR_INTEGRATION=ext.name)
            self.assertIn(ext.name, flags)
            self.assertEqual(flags[flags.index(ext.name) - 1], "-e")

    def test_absent_outside_herdr(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".ts") as ext:
            self.assertNotIn(ext.name, self.flags(OVIS_HERDR_INTEGRATION=ext.name))

    def test_absent_without_a_pane_id(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".ts") as ext:
            self.assertNotIn(ext.name, self.flags(HERDR_ENV="1", OVIS_HERDR_INTEGRATION=ext.name))


if __name__ == "__main__":
    unittest.main()
