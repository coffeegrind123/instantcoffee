#!/usr/bin/env python3
"""pi-local.sh gives the browser native tools only to a pi that can run them.

The browser runs through pi's built-in MCP (pi >= 0.99), registered by
.pi/extensions/browser-mcp.ts; `--tools +codemode` needs pi >= 1.1.0. An older
pi falls back to the CLI skill. The launcher also prunes the retired
pi-mcp-adapter from pi's settings (left installed it registers `/mcp` and takes
over the built-in) and turns pi's install telemetry off.

The version is read from the package.json beside the resolved `pi` binary,
which is TAB-indented in the published package: the first draft's ` *` pattern
matched nothing and silently turned the gate off. The fake install below is
tab-indented for that reason.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest

BASH = shutil.which("bash") or "/bin/bash"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(REPO, "scripts", "lib.sh")
PI_LOCAL = os.path.join(REPO, "scripts", "pi-local.sh")


def bash(script: str, env: dict[str, str] | None = None) -> str:
    full = dict(os.environ)
    full.update(env or {})
    proc = subprocess.run([BASH, "-c", f'source "{LIB}"; {script}'],
                          capture_output=True, text=True, env=full, timeout=60)
    return proc.stdout.strip()


def fake_pi(root: str, version: str) -> str:
    """A pi install laid out like npm's: bin symlink -> dist/bundle/cli.js."""
    pkg = os.path.join(root, "node_modules", "@earendil-works", "pi-coding-agent")
    os.makedirs(os.path.join(pkg, "dist", "bundle"))
    with open(os.path.join(pkg, "package.json"), "w") as fh:
        fh.write(json.dumps({"name": "@earendil-works/pi-coding-agent", "version": version}, indent="\t"))
    cli = os.path.join(pkg, "dist", "bundle", "cli.js")
    with open(cli, "w") as fh:
        fh.write(f"#!/bin/sh\necho {version}\n")
    os.chmod(cli, 0o755)
    bindir = os.path.join(root, "bin")
    os.makedirs(bindir)
    os.symlink(cli, os.path.join(bindir, "pi"))
    return bindir


class VersionGe(unittest.TestCase):
    def test_table(self) -> None:
        cases = [("1.0.4", "1.0.4", True), ("1.0.10", "1.0.4", True), ("1.4.0", "1.0.4", True),
                 ("1.0.3", "1.0.4", False), ("0.99.2", "1.0.4", False), ("0.87.1", "1.0.4", False),
                 ("", "1.0.4", False)]
        for a, b, want in cases:
            got = bash(f'version_ge "{a}" "{b}" && echo yes || echo no')
            self.assertEqual(got, "yes" if want else "no", f"version_ge {a!r} {b!r}")


class InstalledVersion(unittest.TestCase):
    def test_reads_tab_indented_package_json(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            bindir = fake_pi(td, "1.4.0")
            got = bash("installed_pi_version", {"PATH": f"{bindir}:{os.environ['PATH']}"})
            self.assertEqual(got, "1.4.0")

    def test_empty_without_pi(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            # PATH with the basic tools but no pi.
            tools = os.path.join(td, "tools")
            os.makedirs(tools)
            for name in ("dirname", "readlink", "grep", "sed", "head", "tr", "sort"):
                path = subprocess.run(["bash", "-c", f"command -v {name}"], capture_output=True, text=True).stdout.strip()
                os.symlink(path, os.path.join(tools, name))
            got = bash("installed_pi_version; echo \"[$?]\"", {"PATH": tools})
            self.assertEqual(got, "[0]", "no pi must print nothing and not fail")


class LaunchFlags(unittest.TestCase):
    def launch(self, version: str) -> tuple[list[str], dict]:
        with tempfile.TemporaryDirectory() as td:
            bindir = fake_pi(os.path.join(td, "pi"), version)
            agent = os.path.join(td, "agent")
            os.makedirs(agent)
            with open(os.path.join(agent, "settings.json"), "w") as fh:
                json.dump({"packages": ["npm:pi-mcp-adapter@2.26.0", "npm:something-else@1.0.0"]}, fh)
            env = dict(os.environ)
            env.update({"PATH": f"{bindir}:{os.environ['PATH']}", "PI_CODING_AGENT_DIR": agent,
                        "BROWSER_MCP_ENABLED": "1", "BROWSER_MCP_NATIVE": "1", "BROWSER_MCP_AUTOUP": "0"})
            proc = subprocess.run([PI_LOCAL, "--print-only"], capture_output=True, text=True,
                                  env=env, timeout=120, stdin=subprocess.DEVNULL)
            line = next((l for l in proc.stdout.splitlines() if l.startswith("pi ")), "")
            self.assertTrue(line, f"no command printed; stderr: {proc.stderr[-500:]}")
            with open(os.path.join(agent, "settings.json")) as fh:
                settings = json.load(fh)
            return line.split(), settings

    def test_new_pi_gets_native_browser_and_codemode(self) -> None:
        flags, _ = self.launch("1.4.0")
        self.assertTrue(any(f.endswith("/.pi/extensions/browser-mcp.ts") for f in flags))
        self.assertTrue(any(f.endswith("/skills/browser-tools") for f in flags))
        i = flags.index("--tools")
        self.assertEqual(flags[i + 1], "+codemode")
        self.assertNotIn("--mcp-config", flags, "the adapter is retired")

    def test_pi_before_099_falls_back_to_cli(self) -> None:
        flags, _ = self.launch("0.98.0")
        self.assertFalse(any(f.endswith("browser-mcp.ts") for f in flags))
        self.assertTrue(any(f.endswith("/skills/browser") for f in flags), "control: the CLI skill instead")
        self.assertNotIn("--tools", flags)

    def test_pi_10_gets_native_without_codemode(self) -> None:
        flags, _ = self.launch("1.0.4")
        self.assertTrue(any(f.endswith("browser-mcp.ts") for f in flags))
        self.assertNotIn("--tools", flags, "+name entries in --tools arrived in 1.1.0")

    def test_settings_prune_the_adapter_and_turn_telemetry_off(self) -> None:
        _, settings = self.launch("1.4.0")
        self.assertEqual(settings["packages"], ["npm:something-else@1.0.0"])
        self.assertIs(settings["enableInstallTelemetry"], False)


class PrintOnlyHasNoSideEffects(unittest.TestCase):
    """--print-only prints the command and stops. It used to start the browser
    server first (BROWSER_MCP_AUTOUP), which left a browser running after what
    reads as a dry run. Driven from a mirror of the repo whose scripts/browser.sh
    is a stub that records being called."""

    def browser_up_called(self) -> bool:
        with tempfile.TemporaryDirectory() as td:
            mirror = os.path.join(td, "repo")
            os.makedirs(os.path.join(mirror, "scripts"))
            for name in os.listdir(REPO):
                if name not in ("scripts", ".git"):
                    os.symlink(os.path.join(REPO, name), os.path.join(mirror, name))
            for name in os.listdir(os.path.join(REPO, "scripts")):
                if name != "browser.sh":
                    os.symlink(os.path.join(REPO, "scripts", name), os.path.join(mirror, "scripts", name))
            marker = os.path.join(td, "browser-called")
            stub = os.path.join(mirror, "scripts", "browser.sh")
            with open(stub, "w") as fh:
                fh.write(f'#!/bin/sh\necho "$*" >> "{marker}"\nexit 0\n')
            os.chmod(stub, 0o755)
            bindir = fake_pi(os.path.join(td, "pi"), "1.4.0")
            agent = os.path.join(td, "agent")
            env = dict(os.environ)
            env.update({"PATH": f"{bindir}:{os.environ['PATH']}", "PI_CODING_AGENT_DIR": agent,
                        "BROWSER_MCP_ENABLED": "1", "BROWSER_MCP_NATIVE": "1", "BROWSER_MCP_AUTOUP": "1",
                        "PI_AUTO_UPDATE": "0"})
            args = [os.path.join(mirror, "scripts", "pi-local.sh"), "--print-only"]
            subprocess.run(args, capture_output=True, text=True, env=env, timeout=120, stdin=subprocess.DEVNULL)
            if not os.path.exists(marker):
                return False
            with open(marker) as fh:
                return "up" in fh.read().split()

    def test_print_only_does_not_start_the_browser(self) -> None:
        # Red before the fix (the stub recorded `up`), which is what shows the
        # stub can see the call at all.
        self.assertFalse(self.browser_up_called(), "--print-only started the browser server")


if __name__ == "__main__":
    unittest.main()
