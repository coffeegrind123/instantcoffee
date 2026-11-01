#!/usr/bin/env python3
"""mirror_extensions (lib.sh): pi's extensions copied to local disk per launch.

Measured 2026-11-01 in the pi container: the extension set took 111-113 s to
load from the Windows bind mount and 3-5 s from a copy on the container's own
disk; the copy itself took 4.4 s (3.5 MB, 249 files). So pi-local.sh copies at
launch and loads from the copy. These pin the helper: the layout the
extensions' relative imports need, a fresh directory per launch (a running
session may still spawn subagents from its own copy), and pruning only of
copies older than a day.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(REPO, "scripts", "lib.sh")
PACKAGES = ["pi-toolresult-guard", "pi-loop-mode", "pi-subagents-lite", "rtk-pi", "pi-persona"]


def run(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "-c", f'source "{LIB}"; {script}'], capture_output=True, text=True, timeout=60)


def fake_repo(root: str) -> None:
    os.makedirs(os.path.join(root, ".pi", "extensions", "compaction-guard", "src"))
    open(os.path.join(root, ".pi", "extensions", "stack.ts"), "w").write("// stack\n")
    open(os.path.join(root, ".pi", "extensions", "compaction-guard", "src", "output-cap.ts"), "w").write("//\n")
    for p in PACKAGES + ["prinny-channel"]:
        os.makedirs(os.path.join(root, "vendor", p, "src"))
        open(os.path.join(root, "vendor", p, "src", "index.ts"), "w").write(f"// {p}\n")


class MirrorExtensions(unittest.TestCase):
    def test_copies_the_layout_relative_imports_need(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo, base = os.path.join(td, "repo"), os.path.join(td, "cache")
            fake_repo(repo)
            p = run(f'mirror_extensions "{repo}" "{base}"')
            self.assertEqual(p.returncode, 0, p.stderr)
            d = p.stdout.strip()
            self.assertTrue(d.startswith(base + "/ext."), d)
            # subagents-lite imports ../../../../.pi/extensions/compaction-guard/src/*.ts
            self.assertTrue(os.path.exists(os.path.join(d, ".pi", "extensions", "compaction-guard", "src", "output-cap.ts")))
            for pkg in PACKAGES:
                self.assertTrue(os.path.exists(os.path.join(d, "vendor", pkg, "src", "index.ts")), pkg)
            self.assertFalse(os.path.exists(os.path.join(d, "vendor", "prinny-channel")), "prinny loads from the repo")

    def test_each_launch_gets_its_own_copy(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo, base = os.path.join(td, "repo"), os.path.join(td, "cache")
            fake_repo(repo)
            a = run(f'mirror_extensions "{repo}" "{base}"').stdout.strip()
            b = run(f'mirror_extensions "{repo}" "{base}"').stdout.strip()
            self.assertNotEqual(a, b)
            self.assertTrue(os.path.isdir(a), "a recent copy may still be in use and must survive")

    def test_prunes_only_copies_older_than_a_day(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo, base = os.path.join(td, "repo"), os.path.join(td, "cache")
            fake_repo(repo)
            old = run(f'mirror_extensions "{repo}" "{base}"').stdout.strip()
            day_ago = time.time() - 25 * 3600
            os.utime(old, (day_ago, day_ago))
            run(f'mirror_extensions "{repo}" "{base}"')
            self.assertFalse(os.path.exists(old))

    def test_a_missing_package_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo, base = os.path.join(td, "repo"), os.path.join(td, "cache")
            fake_repo(repo)
            subprocess.run(["rm", "-rf", os.path.join(repo, "vendor", "pi-persona")], check=True)
            p = run(f'mirror_extensions "{repo}" "{base}"')
            self.assertNotEqual(p.returncode, 0, "a partial copy must not be handed to pi")


if __name__ == "__main__":
    unittest.main()
