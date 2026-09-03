#!/usr/bin/env python3
"""How long does llama's prompt-cache update stop this engine, and is anything
served while it does?

    ./scripts/cache_stall_probe.py                    # 3 pairs, ~30k prompts
    ./scripts/cache_stall_probe.py --rounds 5
    ./scripts/cache_stall_probe.py --prompt-reps 200  # ~7.5k prompts instead
    ./scripts/cache_stall_probe.py --no-probe         # skip the endpoint sampler

WHAT IT MEASURES, AND WHY IT IS NOT A BENCHMARK

`--cache-ram 2048` makes llama-server save a slot's whole state into a RAM
prompt cache whenever a new prompt takes the slot. On THIS model that save is
not a footnote. Qwen3.8-27B is a hybrid: 48 of its 64 layers carry a
constant-size recurrent state, so a cached prompt costs ~150 MiB before its
first KV byte, each `--ctx-checkpoints` copy costs another ~150 MiB, and the
server's own cache dump shows a **34-token** prompt occupying **300.559 MiB**.
At 30k tokens an entry is ~1.78 GiB against a 2048 MiB cap, so the cache holds
one prompt, and every prompt switch evicts it and copies over a gigabyte.

The whole of that runs on the main loop, between `srv get_availabl: updating
prompt cache` and `srv get_availabl: prompt cache update took N ms`. Nothing
else is serviced in that window: not a request, not `/slots`, not `/metrics`.
`/health` answers throughout, because it is handled by an HTTP thread and never
touches the loop -- which is why a stall here presents as "the backend is
broken" while every liveness signal on the box stays green.

WHAT WAS OBSERVED, 2026-09-03, on one card and one day

    payload      evictions   took          box
    157.9 MiB        1         0.30 s      quiet
    150.0 MiB        0         8.97 s      loaded
    538.1 MiB        2        39.06 s      loaded
   1253.7 MiB        1         1.32-2.86 s quiet   (4 of 6 rounds)
   1252.4 MiB        1        24.78 s      quiet   (1 of 6 rounds)
   1253.7 MiB        2        81.12 s      loaded
    924.1 MiB        3      1109.11 s      loaded  <- 18 min 29 s

The tail is the point. An 18m29s update ate a smoke-test request whole: forge
cancelled it at exactly 600.000 s (`FORGE_BACKEND_TIMEOUT`), and the failure
was reported as `forge plain completion` -- a proxy error about a server that
was, in its own terms, healthy the entire time.

AND SIZE DOES NOT PREDICT IT. The six quiet rounds below carried an identical
~1252 MiB payload with one eviction each and ran 1.32, 1.32, 1.38, 1.98, 2.86
and 24.78 s. The 24.78 s round had the MOST free memory of the six (5460 MiB),
so the obvious "it is memory pressure" reading is not supported by this data
and is not the story. Contention makes the tail worse -- both three-figure
observations above are from a box at load 16-34 with another build running --
but the mechanism behind the variance is not identified here.

WHY A WATCHDOG CANNOT ACT ON THIS

The tempting fix is to make the healthcheck probe `/slots` (it hangs while
`/health` does not) and kill the server after N failures. Do not: an update
that legitimately completes after 18m29s is indistinguishable, from outside,
from one that never will. A kill threshold short enough to be useful would end
a working engine mid-copy and cost a cold reload. Measure it, report it, and
leave the killing to the `/health` path that only fires when nobody is home.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

DEFAULT_URL = os.environ.get("LLAMA_URL", "http://host.docker.internal:8080")
CONTAINER = os.environ.get("LLAMA_CONTAINER", "instantcoffee-llama")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "qwen3.8-27b")

# ~40 tokens. Filler, deliberately: this measures a memcpy-and-evict path whose
# cost is set by the state size, not by what the model has to think about.
SENTENCE = (
    "the quick brown fox jumps over the lazy dog while a patient engineer reads "
    "the logs and writes down what actually happened rather than what was "
    "expected to happen because that difference is where the bugs live "
)

TOOK_RE = re.compile(r"prompt cache update took ([\d.]+) ms")
SAVE_RE = re.compile(r"saving prompt with length (\d+), total state size = ([\d.]+) MiB")
ROOM_RE = re.compile(r"making room for prompt cache entry")


def free_mib() -> tuple[int, int]:
    """MemFree and MemAvailable, in MiB, from the kernel rather than from `free`."""
    with open("/proc/meminfo", encoding="ascii") as fh:
        fields = dict(line.split(":", 1) for line in fh.read().splitlines())
    kb = lambda key: int(fields[key].strip().split()[0])  # noqa: E731
    return kb("MemFree") // 1024, kb("MemAvailable") // 1024


def loadavg() -> float:
    with open("/proc/loadavg", encoding="ascii") as fh:
        return float(fh.read().split()[0])


class EndpointSampler(threading.Thread):
    """Sample /health and /slots throughout, so "nothing was served" is measured.

    /slots posts a SLOT_GET task to the same queue a completion goes through, so
    it answers only while the loop is turning. /health does not, and is the
    control: if both go quiet the server is gone, and if only /slots does, the
    loop is busy or stuck inside one.
    """

    def __init__(self, base: str, timeout: float) -> None:
        super().__init__(daemon=True)
        self.base = base
        self.timeout = timeout
        self.stop = threading.Event()
        self.samples: list[tuple[float, str, object, float]] = []
        self.t0 = time.time()

    def run(self) -> None:
        while not self.stop.is_set():
            for endpoint in ("/health", "/slots"):
                started = time.time()
                try:
                    with urllib.request.urlopen(
                        f"{self.base}{endpoint}", timeout=self.timeout
                    ) as resp:
                        resp.read()
                        code: object = resp.status
                except Exception as exc:  # noqa: BLE001 - the failure IS the datum
                    code = type(exc).__name__
                self.samples.append(
                    (started - self.t0, endpoint, code, time.time() - started)
                )
            self.stop.wait(0.5)

    def report(self) -> None:
        if not self.samples:
            return
        print(f"\n{len(self.samples)} endpoint samples over "
              f"{time.time() - self.t0:.1f}s")
        for endpoint in ("/health", "/slots"):
            rows = [s for s in self.samples if s[1] == endpoint]
            if not rows:
                continue
            secs = sorted(r[3] for r in rows)
            worst = max(rows, key=lambda r: r[3])
            print(f"  {endpoint:8s} n={len(rows):4d}  "
                  f"p50={secs[len(secs) // 2] * 1000:8.1f}ms  "
                  f"p95={secs[int(len(secs) * 0.95)] * 1000:9.1f}ms  "
                  f"max={worst[3]:7.2f}s at t={worst[0]:.1f}s ({worst[2]})  "
                  f"not-200={sum(1 for r in rows if r[2] != 200)}")


def completion(base: str, prompt: str, max_tokens: int, timeout: float):
    body = json.dumps({
        "model": MODEL_ALIAS,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
    }).encode()
    req = urllib.request.Request(
        f"{base}/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json"},
    )
    started = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    usage = data.get("usage") or {}
    return time.time() - started, usage.get("prompt_tokens")


def cache_events(window_s: int) -> tuple[list[str], int, list[tuple[str, str]]]:
    """The engine's own account of the update, not an inference from wall clock.

    `docker logs --since` and not a timestamp filter on the text: llama's own
    log prefix is minutes-since-start, which resets on every reload and cannot
    be compared to a clock.
    """
    proc = subprocess.run(
        ["docker", "logs", CONTAINER, "--since", f"{window_s}s"],
        capture_output=True, text=True, check=False,
    )
    # llama-server logs to stderr; stdout carries nothing worth reading here.
    text = proc.stderr
    return TOOK_RE.findall(text), len(ROOM_RE.findall(text)), SAVE_RE.findall(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--url", default=DEFAULT_URL,
                        help=f"llama-server base URL (default {DEFAULT_URL})")
    parser.add_argument("--rounds", type=int, default=3,
                        help="pairs of mutually-different prompts (default 3)")
    parser.add_argument("--prompt-reps", type=int, default=800,
                        help="filler sentences per prompt, ~40 tokens each "
                             "(default 800, i.e. ~30k tokens)")
    parser.add_argument("--predict", type=int, default=32,
                        help="max_tokens per request (default 32) -- decode is "
                             "not what this measures")
    parser.add_argument("--timeout", type=float, default=2400.0,
                        help="per-request timeout in seconds (default 2400; the "
                             "worst update observed here was 1109 s and forge's "
                             "own ceiling is 600)")
    parser.add_argument("--probe-timeout", type=float, default=20.0,
                        help="per-sample endpoint timeout (default 20)")
    parser.add_argument("--no-probe", action="store_true",
                        help="skip the /health and /slots sampler")
    args = parser.parse_args(argv)

    base = args.url.rstrip("/")
    sampler = None
    if not args.no_probe:
        sampler = EndpointSampler(base, args.probe_timeout)
        sampler.start()

    print(f"cache stall probe against {base}  (container {CONTAINER})")
    print(f"{'round':>5} {'req':>4} {'prompt_tok':>10} {'wall_s':>8} "
          f"{'load':>5} {'free_MiB':>9} {'avail_MiB':>10}  cache-update")
    worst = 0.0
    for rnd in range(1, args.rounds + 1):
        for which in (1, 2):
            mark = time.time()
            free, avail = free_mib()
            load = loadavg()
            # A fresh uuid leads every prompt so no two share a prefix past the
            # chat-template preamble. Without it --cache-reuse 64 would serve
            # round 2 from round 1 and no save would ever happen -- the probe
            # would measure nothing and report zeroes as good news.
            prompt = (f"[stall {uuid.uuid4().hex}] "
                      + SENTENCE * args.prompt_reps
                      + "\nIn one word, what animal is mentioned?")
            try:
                wall, ptok = completion(base, prompt, args.predict, args.timeout)
            except Exception as exc:  # noqa: BLE001
                print(f"{rnd:>5} {which:>4} {'-':>10} {'-':>8} {load:>5.1f} "
                      f"{free:>9} {avail:>10}  REQUEST FAILED: "
                      f"{type(exc).__name__}: {exc}")
                continue
            took, rooms, saves = cache_events(int(time.time() - mark) + 5)
            note = "no update logged"
            if took:
                secs = [float(t) / 1000.0 for t in took]
                worst = max(worst, max(secs))
                note = " + ".join(f"{s:.2f}s" for s in secs)
                if saves:
                    note += f"  (saved {saves[-1][1]} MiB, {rooms} evictions)"
            print(f"{rnd:>5} {which:>4} {ptok:>10} {wall:>8.1f} {load:>5.1f} "
                  f"{free:>9} {avail:>10}  {note}")

    if sampler:
        sampler.stop.set()
        sampler.join(timeout=args.probe_timeout + 5)
        sampler.report()

    print(f"\nworst prompt-cache update this run: {worst:.2f}s of a loop that "
          f"served nothing -- no request, no /slots, no /metrics.")
    print("For the range this has been seen to reach, and why no watchdog acts "
          "on it, read the header of this file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
