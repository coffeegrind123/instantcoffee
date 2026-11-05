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

import json
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
                # bracketed paste: text pasted from Ovis ran as `^[[200~...`. herdr
                # now gets the pane shell (pi, then bash), whatever the caller had.
                self.assertEqual(fh.read().strip(), os.path.join(SCRIPTS, "ovis-shims", "pane-shell"))

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


class PaneShell(unittest.TestCase):
    """herdr's shell for every new pane: pi first, then bash.

    A new workspace or tab in Ovis opened herdr's default pane, a plain shell, so
    Ovis showed "Message Shell" or a terminal (operator, 2026-11-01). herdr runs
    $SHELL for every new pane; ovis.sh hands it scripts/ovis-shims/pane-shell.
    """

    def run_shell(self, args: list[str], **extra: str) -> list[str]:
        with tempfile.TemporaryDirectory() as td:
            scripts = os.path.join(td, "scripts")
            os.makedirs(os.path.join(scripts, "ovis-shims"))
            shutil.copy(os.path.join(SCRIPTS, "ovis-shims", "pane-shell"), os.path.join(scripts, "ovis-shims", "pane-shell"))
            shutil.copy(os.path.join(SCRIPTS, "lib.sh"), os.path.join(scripts, "lib.sh"))
            launcher = os.path.join(scripts, "pi-local.sh")
            with open(launcher, "w") as fh:
                fh.write('#!/usr/bin/env bash\necho "PI-LOCAL SHELL=$SHELL"\n')
            os.chmod(launcher, 0o755)
            fakebin = os.path.join(td, "bin")
            os.makedirs(fakebin)
            with open(os.path.join(fakebin, "bash"), "w") as fh:
                fh.write('#!/bin/sh\necho "BASH $*"\n')
            os.chmod(os.path.join(fakebin, "bash"), 0o755)
            env = env_with(OVIS_PANE_BASH=os.path.join(fakebin, "bash"), **extra)
            env.pop("OVIS_PANE_PLAIN", None) if "OVIS_PANE_PLAIN" not in extra else None
            out = subprocess.run([BASH, os.path.join(scripts, "ovis-shims", "pane-shell"), *args],
                                 capture_output=True, text=True, env=env, timeout=60)
            return out.stdout.splitlines()

    def test_an_interactive_pane_starts_pi_then_bash(self) -> None:
        out = self.run_shell([])
        self.assertEqual(out[0], "PI-LOCAL SHELL=/bin/bash", out)
        self.assertTrue(out[-1].startswith("BASH"), out)

    def test_a_login_pane_starts_pi_too(self) -> None:
        self.assertEqual(self.run_shell(["-l"])[0], "PI-LOCAL SHELL=/bin/bash")

    def test_a_command_is_just_bash(self) -> None:
        self.assertEqual(self.run_shell(["-c", "echo hi"]), ["BASH -c echo hi"])

    def test_off_switch_and_plain_request(self) -> None:
        self.assertEqual(self.run_shell([], OVIS_PI_PANE="0"), ["BASH -i"])
        self.assertEqual(self.run_shell([], OVIS_PANE_PLAIN="1"), ["BASH -i"])

    def test_control_herdr_gets_it_and_the_typed_launch_is_gone(self) -> None:
        with open(OVIS, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("pane-shell", src[src.index("start_herdr() {"):src.index("# --- the supervisor")])
        self.assertNotIn("ensure_pi_pane", src)
        self.assertIn("--env OVIS_PANE_PLAIN=1", src)


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
        self.assertLess(strip, src.index('exec pi "${LAUNCH_ARGS[@]}"'))


class OvisPatch(unittest.TestCase):
    """scripts/ovis_patch.py on a synthetic bundle: the pinned hashes are swapped
    for the fixture's, so this exercises the logic CI can run; the real bundle's
    files are checked live (HANDOFF part 22)."""

    def setUp(self) -> None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("ovis_patch", os.path.join(SCRIPTS, "ovis_patch.py"))
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.td = tempfile.TemporaryDirectory()
        self.ovis = self.td.name
        os.makedirs(os.path.join(self.ovis, "server"))
        with open(os.path.join(self.ovis, "bundle.json"), "w") as fh:
            json.dump({"version": "40"}, fh)
        edits = []
        for rel, _, pairs in self.mod.EDITS:
            text = "head\n" + "".join(old for old, _ in pairs) + "tail\n"
            os.makedirs(os.path.dirname(os.path.join(self.ovis, rel)), exist_ok=True)
            with open(os.path.join(self.ovis, rel), "w") as fh:
                fh.write(text)
            edits.append((rel, self.mod.sha256(text), pairs))
        self.mod.EDITS = edits

    def tearDown(self) -> None:
        self.td.cleanup()

    def read(self, rel: str) -> str:
        with open(os.path.join(self.ovis, rel)) as fh:
            return fh.read()

    def test_applies_then_is_idempotent(self) -> None:
        self.assertTrue(self.mod.apply(self.ovis))
        for rel, _, pairs in self.mod.EDITS:
            text = self.read(rel)
            for old, new in pairs:
                self.assertIn(new, text, rel)
            self.assertTrue(os.path.exists(os.path.join(self.ovis, rel + ".orig")))
        for _, rel in self.mod.NEW_FILES:
            self.assertTrue(os.path.exists(os.path.join(self.ovis, rel)), rel)
        self.assertFalse(self.mod.apply(self.ovis), "a second run must change nothing")
        self.assertTrue(os.path.exists(os.path.join(self.ovis, self.mod.STAMP)), "no stamp for ovis.sh to compare the server against")

    def test_refuses_another_bundle_and_writes_nothing(self) -> None:
        with open(os.path.join(self.ovis, "bundle.json"), "w") as fh:
            json.dump({"version": "41"}, fh)
        with self.assertRaises(self.mod.Refused):
            self.mod.apply(self.ovis)
        self.assertFalse(os.path.exists(os.path.join(self.ovis, self.mod.NEW_FILES[0][1])))

    def test_refuses_a_changed_file_before_writing_any(self) -> None:
        last = self.mod.EDITS[-1][0]
        with open(os.path.join(self.ovis, last), "a") as fh:
            fh.write("upstream changed this\n")
        with self.assertRaises(self.mod.Refused):
            self.mod.apply(self.ovis)
        first = self.mod.EDITS[0]
        self.assertNotIn(first[2][0][1], self.read(first[0]), "an earlier file was patched before the refusal")

    def test_replaces_an_older_version_of_its_own_edits(self) -> None:
        self.assertTrue(self.mod.apply(self.ovis))
        rel, original, pairs = self.mod.EDITS[1]
        old, new = pairs[0]
        newer = new.replace(self.mod.MARK, self.mod.MARK + " v2")
        self.mod.EDITS[1] = (rel, original, [(old, newer)] + pairs[1:])
        self.assertTrue(self.mod.apply(self.ovis))
        text = self.read(rel)
        self.assertIn(newer, text)
        self.assertNotIn(new, text.replace(newer, ""), "the older edit was left in beside the newer one")

    def test_refuses_a_file_changed_after_our_patch_without_its_backup(self) -> None:
        self.assertTrue(self.mod.apply(self.ovis))
        rel = self.mod.EDITS[0][0]
        os.remove(os.path.join(self.ovis, rel + ".orig"))
        with open(os.path.join(self.ovis, rel), "w") as fh:
            fh.write("instantcoffee: but not ours any more\n")
        with self.assertRaises(self.mod.Refused):
            self.mod.apply(self.ovis)

    def test_every_edit_carries_the_marker(self) -> None:
        for rel, _, pairs in self.mod.EDITS:
            for _, new in pairs:
                self.assertIn(self.mod.MARK, new, rel)


class RendererCoverage(unittest.TestCase):
    """Every entry type an extension here draws with a custom renderer must have
    an Ovis notice format, or it is invisible in the Ovis chat."""

    def test_every_rendered_entry_type_has_a_notice(self) -> None:
        import re
        found: dict[str, str] = {}
        consts: dict[str, str] = {}
        for base in (os.path.join(REPO, ".pi", "extensions"), os.path.join(REPO, "vendor")):
            for root, dirs, files in os.walk(base):
                dirs[:] = [d for d in dirs if d not in ("node_modules", "tests", "test", ".git")]
                for name in files:
                    if not name.endswith(".ts"):
                        continue
                    with open(os.path.join(root, name), encoding="utf-8", errors="replace") as fh:
                        src = fh.read()
                    for m in re.finditer(r'export const ([A-Z_]+) = "([a-z-]+)"', src):
                        consts[m.group(1)] = m.group(2)
                    for m in re.finditer(r'registerEntryRenderer(?:<[^>]*>)?\(\s*(?:"([^"]+)"|\'([^\']+)\'|([A-Z_]+))', src):
                        found[m.group(1) or m.group(2) or m.group(3)] = os.path.relpath(os.path.join(root, name), REPO)
        types = {consts.get(t, t): where for t, where in found.items()}
        self.assertGreaterEqual(len(types), 3, f"control: the scan must find the known renderers, found {types}")
        with open(os.path.join(REPO, "vendor", "ovis-patches", "pi-entry-notices.ts"), encoding="utf-8") as fh:
            notices = fh.read()
        missing = {t: where for t, where in types.items() if f'"{t}":' not in notices}
        self.assertEqual(missing, {}, "entry renderers with no Ovis notice format (vendor/ovis-patches/pi-entry-notices.ts)")


class CustomUiCoverage(unittest.TestCase):
    """A command from a package that draws its own TUI (ctx.ui.custom) must be a
    terminal command in Ovis, or the chat sends into a menu nobody can see."""

    def test_custom_ui_packages_have_their_commands_marked_terminal(self) -> None:
        import re
        with open(os.path.join(REPO, "vendor", "ovis-patches", "pi-native-catalog-rows.ts"), encoding="utf-8") as fh:
            listed = set(re.findall(r'"([a-z-]+)"', re.search(r"TERMINAL_COMMANDS[^=]*=\s*\[([^\]]*)\]", fh.read()).group(1)))
        roots = [os.path.join(REPO, "vendor", d) for d in os.listdir(os.path.join(REPO, "vendor"))]
        roots += [os.path.join(REPO, ".pi", "extensions", f) for f in os.listdir(os.path.join(REPO, ".pi", "extensions"))]
        offenders, custom_packages = {}, 0
        for root in roots:
            files = [root] if root.endswith(".ts") else [os.path.join(d, f) for d, ds, fs in os.walk(root)
                     if not {"node_modules", "tests", "test"} & set(d.split(os.sep)) for f in fs if f.endswith(".ts")]
            text = ""
            for path in files:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    text += fh.read()
            if not re.search(r"ui\.custom(?:<[^>]*>)?\(", text):
                continue
            custom_packages += 1
            commands = set(re.findall(r"registerCommand\(\s*[\"']([a-z-]+)[\"']", text))
            missing = commands - listed
            if missing:
                offenders[os.path.relpath(root, REPO)] = sorted(missing)
        self.assertGreaterEqual(custom_packages, 1, "control: the scan must find pi-subagents-lite's ui.custom")
        self.assertEqual(offenders, {}, "commands that open custom TUI but are not TERMINAL_COMMANDS")

    def test_pi_bundled_extensions_with_custom_ui_are_terminal_commands(self) -> None:
        """pi ships extensions of its own (/mcp, /llama); an update can add a custom UI."""
        import re
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip() if shutil.which("npm") else ""
        bundled = os.path.join(root, "@earendil-works", "pi-coding-agent", "dist", "extensions")
        if not os.path.isdir(bundled):
            self.skipTest("pi is not installed here")
        with open(os.path.join(REPO, "vendor", "ovis-patches", "pi-native-catalog-rows.ts"), encoding="utf-8") as fh:
            listed = set(re.findall(r'"([a-z-]+)"', re.search(r"TERMINAL_COMMANDS[^=]*=\s*\[([^\]]*)\]", fh.read()).group(1)))
        offenders = {}
        for name in os.listdir(bundled):
            folder = os.path.join(bundled, name)
            if not os.path.isfile(os.path.join(folder, "index.js")):
                continue
            # the whole extension: /mcp registers in index.js and draws in ui.js
            src = ""
            for file in sorted(os.listdir(folder)):
                if file.endswith(".js"):
                    with open(os.path.join(folder, file), encoding="utf-8") as fh:
                        src += fh.read()
            if "ui.custom" not in src and ".custom(" not in src:
                continue
            missing = set(re.findall(r'registerCommand\("([a-z-]+)"', src)) - listed
            if missing:
                offenders[name] = sorted(missing)
        self.assertEqual(offenders, {}, "pi's bundled extensions open custom TUI from commands not in TERMINAL_COMMANDS")


class HerdrRestore(unittest.TestCase):
    """herdr restores its panes on restart and types `pi --session <file>` into
    them; with pane-shell starting pi in every pane, that text landed in the
    running pi's editor (2026-11-01). ovis.sh turns the resume off."""

    def run_config(self, existing: str | None) -> tuple[str, str]:
        with tempfile.TemporaryDirectory() as td:
            cfg = os.path.join(td, ".config", "herdr", "config.toml")
            if existing is not None:
                os.makedirs(os.path.dirname(cfg))
                with open(cfg, "w") as fh:
                    fh.write(existing)
            proc = sourced("ensure_herdr_config", HOME=td)
            with open(cfg) as fh:
                return fh.read(), proc.stderr

    def test_creates_it(self) -> None:
        text, _ = self.run_config(None)
        self.assertIn("[session]\nresume_agents_on_restore = false\n", text)

    def test_adds_the_key_to_an_existing_session_table(self) -> None:
        text, _ = self.run_config('[ui]\nx = 1\n[session]\nstartup_per_agent_delay_ms = 5\n')
        self.assertIn("[session]\nresume_agents_on_restore = false\n", text)
        self.assertIn("startup_per_agent_delay_ms = 5", text)
        self.assertEqual(text.count("[session]"), 1)

    def test_adds_a_session_table_to_a_file_without_one(self) -> None:
        text, _ = self.run_config('[ui]\nx = 1\n')
        self.assertTrue(text.startswith("[ui]\nx = 1\n"))
        self.assertIn("[session]\nresume_agents_on_restore = false\n", text)

    def test_leaves_an_explicit_choice_and_warns_on_true(self) -> None:
        text, err = self.run_config('[session]\nresume_agents_on_restore = true\n')
        self.assertIn("resume_agents_on_restore = true", text)
        self.assertIn("resume_agents_on_restore", err)

    def test_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            for _ in range(2):
                sourced("ensure_herdr_config", HOME=td)
            with open(os.path.join(td, ".config", "herdr", "config.toml")) as fh:
                self.assertEqual(fh.read().count("resume_agents_on_restore"), 1)


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
