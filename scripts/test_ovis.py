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
import sys
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


class SupervisorLock(unittest.TestCase):
    """herdr must not inherit the supervisor's lock (fd 9).

    It did, on 2026-11-01: herdr outlives the supervisor by design, so after
    `ovis.sh stop` the lock stayed held by herdr and every later supervisor's
    `flock -n` failed in silence. Ovis never came back until herdr restarted.
    """

    def test_herdr_starts_without_fd_9(self) -> None:
        if not shutil.which("script"):
            self.skipTest("util-linux script not installed")
        with tempfile.TemporaryDirectory() as td:
            mark = os.path.join(td, "fds")
            herdr = os.path.join(td, "herdr")
            with open(herdr, "w") as fh:
                fh.write('#!/usr/bin/env bash\n'
                         f'if [ "$1" = status ]; then [ -s "{mark}" ] && printf "server:\\n  status: running\\n"; exit 0; fi\n'
                         f'echo "$SHELL" > "{mark}.shell"\n'
                         f'ls /proc/$$/fd > "{mark}.tmp" && mv "{mark}.tmp" "{mark}"; sleep 3\n')
            os.chmod(herdr, 0o755)
            lock = os.path.join(td, "lock")
            # SHELL=/bin/sh is what the container's panes got: herdr must get bash anyway.
            proc = sourced(f'HERDR="{herdr}"; exec 9>"{lock}"; start_herdr && echo STARTED', SHELL="/bin/sh")
            self.assertIn("STARTED", proc.stdout, proc.stderr)
            with open(mark) as fh:
                fds = fh.read().split()
            self.assertIn("0", fds, "control: the listing must be of real descriptors")
            self.assertNotIn("9", fds, "herdr inherited the supervisor lock")
            with open(mark + ".shell") as fh:
                # Unset in the container, herdr's panes got /bin/sh, which has no
                # bracketed paste: text pasted from Ovis ran as `^[[200~...`.
                self.assertEqual(fh.read().strip(), "/bin/bash")

    def test_control_the_server_launch_closes_it_too(self) -> None:
        with open(OVIS, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('exec "$BUN" server/index.ts ) >> "$LOG" 2>&1 9>&- &', src)


class Relay(unittest.TestCase):
    """scripts/ovis_forward.py: Ovis binds loopback behind it, so its LAN banner stays off."""

    def test_relays_both_ways_and_passes_a_half_close(self) -> None:
        import socket
        import threading
        import time

        upstream = socket.socket()
        upstream.bind(("127.0.0.1", 0))
        upstream.listen(1)
        target_port = upstream.getsockname()[1]
        received = bytearray()

        def echo_after_eof() -> None:
            conn, _ = upstream.accept()
            while chunk := conn.recv(65536):
                received.extend(chunk)
            conn.sendall(b"R" * 300_000)   # the whole answer comes after the client's EOF
            conn.close()

        threading.Thread(target=echo_after_eof, daemon=True).start()
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        listen_port = probe.getsockname()[1]
        probe.close()
        relay = subprocess.Popen([sys.executable, os.path.join(SCRIPTS, "ovis_forward.py"), "127.0.0.1",
                                  str(listen_port), "127.0.0.1", str(target_port)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertIn("ovis-forward", relay.stdout.readline())
            client = socket.create_connection(("127.0.0.1", listen_port), timeout=10)
            client.sendall(b"Q" * 200_000)
            client.shutdown(socket.SHUT_WR)
            answer = bytearray()
            while chunk := client.recv(65536):
                answer.extend(chunk)
            client.close()
            time.sleep(0.1)
            self.assertEqual(bytes(received), b"Q" * 200_000)
            self.assertEqual(bytes(answer), b"R" * 300_000)
        finally:
            relay.terminate()
            relay.wait(timeout=10)
            upstream.close()

    def test_ovis_binds_loopback_and_the_relay_owns_the_published_port(self) -> None:
        with open(OVIS, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('HOST=127.0.0.1 PORT="$OVIS_INTERNAL_PORT"', src)
        self.assertNotIn("HOST=0.0.0.0", src)
        self.assertIn('ovis_forward.py" 0.0.0.0 "$OVIS_CONTAINER_PORT"', src)


class DefaultPiPane(unittest.TestCase):
    """Opening Ovis lands on pi, not on herdr's bare shell.

    herdr's first pane is a shell. The operator opened Ovis's chat on it, typed
    "hello", and got `bash: hello: command not found` (2026-11-01). The
    supervisor now starts pi there (through pi-local.sh) whenever no pane runs pi.
    """

    def run_ensure(self, agents: str, panes: str, **extra: str) -> list[str]:
        with tempfile.TemporaryDirectory() as td:
            calls = os.path.join(td, "calls")
            herdr = os.path.join(td, "herdr")
            with open(herdr, "w") as fh:
                fh.write('#!/usr/bin/env bash\n'
                         f'echo "$*" >> "{calls}"\n'
                         f'case "$1 $2" in "agent list") echo \'{agents}\';; "pane list") echo \'{panes}\';; esac\n')
            os.chmod(herdr, 0o755)
            run_dir = os.path.join(td, "run")
            os.makedirs(run_dir)
            sourced(f'HERDR="{herdr}"; RUN_DIR="{run_dir}"; ensure_pi_pane', **extra)
            if not os.path.exists(calls):
                return []
            with open(calls) as fh:
                return [ln for ln in fh.read().splitlines() if ln.startswith("pane run")]

    SHELL_ONLY = ('{"result":{"panes":[{"pane_id":"w1:p1","agent_status":"unknown"}]}}')
    NO_AGENTS = '{"result":{"agents":[]}}'
    PI_RUNNING = '{"result":{"agents":[{"agent":"pi","pane_id":"w2:p1"}]}}'

    def test_starts_pi_in_the_shell_pane_when_none_runs(self) -> None:
        runs = self.run_ensure(self.NO_AGENTS, self.SHELL_ONLY)
        self.assertEqual(len(runs), 1, runs)
        self.assertTrue(runs[0].startswith("pane run w1:p1 bash "), runs[0])

    def test_leaves_it_alone_when_pi_already_runs(self) -> None:
        self.assertEqual(self.run_ensure(self.PI_RUNNING, self.SHELL_ONLY), [])

    def test_off_switch(self) -> None:
        self.assertEqual(self.run_ensure(self.NO_AGENTS, self.SHELL_ONLY, OVIS_PI_PANE="0"), [])

    def test_control_the_supervisor_calls_it(self) -> None:
        with open(OVIS, encoding="utf-8") as fh:
            src = fh.read()
        body = src[src.index("supervise() {"):src.index("healthy() {")]
        self.assertIn("ensure_pi_pane", body)


class PiLocalDropsTheShim(unittest.TestCase):
    """`pi`/`qpi` aliases reach pi-local.sh with the shim still first on PATH in a
    herdr pane; its own `exec pi` must not resolve to the shim and relaunch."""

    def test_strip_path(self) -> None:
        cases = [("/s:/a:/b", "/a:/b"), ("/a:/s:/b", "/a:/b"), ("/a:/b:/s", "/a:/b"),
                 ("/s:/a:/s", "/a"), ("/a:/b", "/a:/b"), ("/a:/sx:/b", "/a:/sx:/b")]
        for path, want in cases:
            got = subprocess.run([BASH, "-c", f'source "{SCRIPTS}/lib.sh"; strip_path "{path}" /s'],
                                 capture_output=True, text=True, timeout=30).stdout
            self.assertEqual(got, want, path)

    def test_pi_local_strips_it_before_resolving_pi(self) -> None:
        with open(PI_LOCAL, encoding="utf-8") as fh:
            src = fh.read()
        strip = src.index('PATH="$(strip_path "$PATH" "$REPO_ROOT/scripts/ovis-shims")"')
        self.assertLess(strip, src.index("command -v pi >/dev/null"))
        self.assertLess(strip, src.index('exec pi "${pi_flags[@]}"'))


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
