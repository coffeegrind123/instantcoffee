#!/usr/bin/env python3
"""kld-run.sh stops and restarts llama only if it was running (be23669/eedc31c).

The WAS_RUNNING guard sits AFTER preflight, so it was flagged untested in the
2026-10-04 sweep: a test "would have to stub every docker call". It can — a
`docker` stub on PATH that satisfies preflight (image present, files present,
kld_budget JSON, free RAM, quiet server) drives the real script into the guard
and the EXIT trap. The base perplexity pass is stubbed to FAIL, which short-
circuits the run right after the guard fires: that is enough to observe whether
llama was stopped (guard) and restarted (trap), which is the whole claim.

Two cases, the one difference being the container's reported .State.Running:
  running=true  -> `docker stop` AND `docker start` both happen
  running=false -> neither happens, and the run says so

No GPU, no image, no network: every docker invocation is the stub.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, "scripts")

# The stub dispatches on the whole argument string. Order matters: the specific
# `perplexity` / `--entrypoint python` cases are tested before anything generic,
# and `stop`/`start` are logged so the test can assert on them. `inspect -f`
# (the Running probe) prints the contents of a control file the test writes.
STUB = r"""#!/bin/sh
args="$*"
case "$args" in
  "image inspect "*)                 exit 0 ;;
  *" free -m"*)                      printf 'Mem: 0 0 0 0 0 50000\nSwap: 0 0 60000\n'; exit 0 ;;
  *" df -Pm "*)                      printf 'Fs 1M Used Avail Cap M\nx 1 1 9999999 1%% /x\n'; exit 0 ;;
  *" stat -c %s "*)                  echo 1048576; exit 0 ;;
  *" test -f "*)                     exit 0 ;;
  *" mkdir -p "*)                    exit 0 ;;
  *" rm -f "*)                       exit 0 ;;
  *"--entrypoint python"*" -c "*)    echo COMPLETE; exit 0 ;;
  *"--entrypoint python"*)           echo '{"host_weights_mib": 100, "gpu_weights_mib": 15000, "n_vocab": 151936, "unplaced": []}'; exit 0 ;;
  *"perplexity"*)                    echo "stub perplexity: failing on purpose" >&2; exit 1 ;;
  "logs --since "*)                  exit 0 ;;
  "inspect -f "*)                    cat "__RUNNING__"; exit 0 ;;
  "stop "*)                          echo "$args" >> "__CALLS__"; exit 0 ;;
  "start "*)                         echo "$args" >> "__CALLS__"; exit 0 ;;
  "compose "*|*" compose "*)         exit 0 ;;
  *)                                 echo "UNHANDLED: $args" >> "__CALLS__"; exit 0 ;;
esac
"""


class KldRunGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.calls = os.path.join(d, "calls")
        self.running = os.path.join(d, "running")
        open(self.calls, "w").close()
        # Run a MIRROR of scripts/, not the tree in place: lib.sh derives
        # REPO_ROOT from the script's own path, and the real run writes its
        # log dir under ${REPO_ROOT}/.kld-logs. Mirroring sends that into the
        # temp dir, so the test leaves nothing in the real repo to clean up —
        # the guard against a stray cleanup wiping real logits logs, which is
        # how the 2026-10-24 code-pass logs were lost.
        mirror = os.path.join(d, "scripts")
        os.mkdir(mirror)
        for name in os.listdir(SCRIPTS):
            os.symlink(os.path.join(SCRIPTS, name), os.path.join(mirror, name))
        os.remove(os.path.join(mirror, "kld-run.sh"))
        with open(os.path.join(SCRIPTS, "kld-run.sh")) as src, \
                open(os.path.join(mirror, "kld-run.sh"), "w") as dst:
            dst.write(src.read())
        os.chmod(os.path.join(mirror, "kld-run.sh"), 0o755)
        os.symlink(os.path.join(REPO, ".env"), os.path.join(d, ".env"))
        self.script = os.path.join(mirror, "kld-run.sh")
        stub = os.path.join(d, "docker")
        with open(stub, "w") as f:
            f.write(STUB.replace("__CALLS__", self.calls).replace("__RUNNING__", self.running))
        os.chmod(stub, os.stat(stub).st_mode | stat.S_IEXEC)
        self.env = dict(os.environ, PATH=f"{d}:{os.environ['PATH']}")
        # Pin the keys the script reads so the result does not depend on the
        # mode the box was last switched to, and skip the one preflight step
        # that opens the corpus for real (llama's /tokenize count is advisory).
        self.env.update(
            GGUF_FILE="base.gguf", MODELS_DIR="//c/m", CAPTURES_DIR="//d/c",
            NGL="999", FORGE_VERSION="test", SKIP_TOKENIZE="1",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def run_guard(self, running: bool):
        with open(self.running, "w") as f:
            f.write("true" if running else "false")
        # One tiny depth keeps the host-RAM verdict trivially "ok". The base
        # pass fails (stub exit 1), so the run ends right after the guard.
        p = subprocess.run(
            ["bash", self.script, "--corpus", "/captures/x.txt", "--depths", "512"],
            env=self.env, capture_output=True, text=True, timeout=120,
        )
        out = p.stdout + p.stderr
        calls = open(self.calls).read()
        self.assertNotIn("UNHANDLED:", calls, f"stub hit an unstubbed docker call:\n{calls}\n---\n{out}")
        return out, calls

    def test_running_is_stopped_and_restarted(self):
        out, calls = self.run_guard(running=True)
        self.assertRegex(calls, r"^stop .*instantcoffee-llama", f"guard did not stop a running llama:\n{out}")
        self.assertRegex(calls, r"(?m)^start .*instantcoffee-llama", f"EXIT trap did not restart llama:\n{out}")

    def test_stopped_stays_stopped(self):
        out, calls = self.run_guard(running=False)
        self.assertNotIn("stop ", calls, f"a stopped llama was stopped anyway:\n{out}\n---\n{calls}")
        self.assertNotIn("start ", calls, f"a stopped llama was started by the trap:\n{out}\n---\n{calls}")
        self.assertIn("is not running", out, f"the run did not say llama was not running:\n{out}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
