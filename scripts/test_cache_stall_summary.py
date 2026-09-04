#!/usr/bin/env python3
"""The prompt-cache guard must not report absence when the log says otherwise.

WHY THIS FILE EXISTS. llama pays a prompt-cache cost that lands INSIDE wall-clock
TTFT and OUTSIDE the engine's own prompt_ms, so a comparison that ignores it
reads as "llama loses badly on TTFT" for a reason that is not the engine. That is
the same shape as the leftover-container queue wait already retracted from
bench_cross_engine.py, which is why cache_stalls() exists at all.

It was reporting false negatives. The 32K arm of run 20260904-153020 logged five
"making room for prompt cache entry" lines -- 685, 685, 685, 1373 and 1378 MiB --
while its first round spent 165.63 s of wall TTFT against 39.5 s of engine
prompt_ms. run.meta recorded `cache_stalls_llama=none logged in 394s window`,
because the summary only ever counted "prompt cache update took ... ms" lines and
llama had logged none of those in that arm. The evidence was captured in the
.cache-stalls file and then contradicted by the field people actually read.

A guard that reports a false negative is worse than no guard, because it is
trusted. These tests pin the three verdicts it must be able to give: quantified,
absent, and -- the one that was missing -- "there are lines here I do not
recognise, go and read them".
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPARE = os.path.join(REPO, "scripts", "ninfer-compare.sh")
LIB = os.path.join(REPO, "scripts", "lib.sh")


def extract_function(name: str) -> str:
    """Pull the real function out of the runner, so this tests shipped code."""
    with open(COMPARE) as fh:
        src = fh.read()
    start = src.index(f"{name}() {{")
    end = src.index("\n}\n", start) + 3
    return src[start:end]


def run_cache_stalls(log_lines: str) -> tuple[str, str, str]:
    """Run the real cache_stalls() against a stubbed `docker logs`."""
    body = extract_function("cache_stalls")
    with tempfile.TemporaryDirectory() as td:
        logfile = os.path.join(td, "engine.log")
        with open(logfile, "w") as fh:
            fh.write(log_lines)
        script = f"""
        set -uo pipefail
        source "{LIB}"
        set +e
        RUN_DIR="{td}"
        LLAMA_CT="fake-llama"
        # Stub docker: report the container running, and serve the canned log.
        docker() {{
          case "$1" in
            inspect) echo true ;;
            logs)    cat "{logfile}" ;;
            *)       return 0 ;;
          esac
        }}
        {body}
        cache_stalls llama $(date -u +%s)
        """
        proc = subprocess.run(["bash", "-c", script], capture_output=True,
                              text=True, timeout=60)
        meta = ""
        metafile = os.path.join(td, "run.meta")
        if os.path.exists(metafile):
            with open(metafile) as fh:
                meta = fh.read()
        captured = ""
        cs = os.path.join(td, "llama.cache-stalls")
        if os.path.exists(cs):
            with open(cs) as fh:
                captured = fh.read()
        return meta, captured, proc.stdout + proc.stderr


EVICTIONS = (
    "80.39.776.717 W srv alloc:  - making room for prompt cache entry, "
    "removing oldest entry (size = 685.399 MiB)\n"
    "86.39.287.974 W srv alloc:  - making room for prompt cache entry, "
    "removing oldest entry (size = 1373.472 MiB)\n"
)
UPDATES = "srv  update_slots: prompt cache update took 1121.50 ms\n"


class CacheStallSummary(unittest.TestCase):
    def test_evictions_alone_are_not_reported_as_none(self):
        """THE REGRESSION. Five evictions once summarised as 'none logged'."""
        meta, captured, _ = run_cache_stalls(EVICTIONS)
        self.assertNotIn("none logged", meta)
        self.assertIn("evictions=2", meta)
        self.assertIn("max_evicted_mib=1373", meta)
        self.assertIn("evicted_mib=2059", meta)
        self.assertIn("making room", captured)

    def test_updates_are_still_quantified(self):
        meta, _, _ = run_cache_stalls(UPDATES)
        self.assertIn("updates=1", meta)
        self.assertIn("max_ms=1122", meta)

    def test_both_kinds_are_reported_together(self):
        meta, _, _ = run_cache_stalls(UPDATES + EVICTIONS)
        self.assertIn("updates=1", meta)
        self.assertIn("evictions=2", meta)

    def test_a_genuinely_quiet_arm_says_none(self):
        """The absence verdict must survive -- it is the common, correct case."""
        meta, captured, _ = run_cache_stalls("srv: nothing interesting here\n")
        self.assertIn("none logged", meta)
        self.assertEqual(captured, "")

    def test_unrecognised_lines_say_so_instead_of_claiming_absence(self):
        """If a future llama build renames these lines, the guard must degrade to
        'read the file', never to 'nothing happened'."""
        meta, captured, out = run_cache_stalls(
            "srv: prompt_save: length 20586, state 914.502 MiB\n")
        self.assertIn("UNPARSED", meta)
        self.assertNotIn("none logged", meta)
        self.assertIn("prompt_save", captured)
        self.assertIn("before trusting TTFT", out)

    def test_the_arm_is_never_left_without_a_verdict(self):
        for name, log in (("evictions", EVICTIONS), ("updates", UPDATES),
                          ("quiet", "nothing\n"),
                          ("unknown", "srv: prompt_save: length 1, state 1 MiB\n")):
            with self.subTest(name):
                meta, _, _ = run_cache_stalls(log)
                self.assertRegex(meta, r"cache_stalls_llama=\S")


if __name__ == "__main__":
    unittest.main()
