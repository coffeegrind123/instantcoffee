# Troubleshooting

Symptoms in the order you are likely to hit them.

**Tool calls never come back / the model "won't use tools".**
Run `./scripts/smoke-test.sh`. It asserts on `tool_calls` specifically, because
llama.cpp *silently ignores* the `tools` parameter when `--jinja` is missing — which
looks identical to a model that is bad at tool calling. The smoke test prints the raw
response body when this happens.

**The first start takes ~25 minutes and the container shows `unhealthy`.**
Expected on this machine, and not a fault. The GGUF is 17.9 GB and it is read
over a Docker Desktop bind mount from the Windows side, which was measured here
at **10–12 MB/s** (`dd` from a throwaway container against the same mount, twice)
— about 24 minutes for a cold load. `start_period` and the smoke test's
`SMOKE_LOAD_TIMEOUT` are sized for that. Warm restarts are much faster because
the host has the file cached. Watch real progress with `./scripts/logs.sh llama`
rather than the health status.

**The load seems stuck: VRAM flat, no new log lines, low CPU.**
Read this before concluding anything, because the two obvious tells are both
misleading on this stack.

*Flat VRAM is normal here.* With `--load-mode none` (no mmap) llama-server
allocates the **whole** weight buffer up front and then streams the file into
it, so `nvidia-smi` jumps to ~18.5 GiB in the first seconds and does not move
again until the KV cache is allocated at the end. It is not a progress bar.
(The old advice in this slot said flat VRAM meant a stall. That applies to an
mmap'd load, which this is not.)

*Silence in the log is also normal.* llama-server prints nothing between
`load_model: loading model ...` and the end of the load.

**The real progress counter** is bytes read by the process — and note that
`init: true` means llama-server is **PID 7**, not PID 1:

```bash
docker exec instantcoffee-llama sh -c 'grep ^rchar /proc/7/io; cat /proc/7/wchan'
```

Sample it twice and divide. `State: D` with `wchan: p9_client_rpc` is the
process waiting on the 9p mount, which is what a healthy load looks like most of
the time.

**Measured here on 2026-08-15, and the reason this entry exists:**

| Condition | Load read rate | Window |
| --- | --- | --- |
| Model download running concurrently, VM at 2.2 GiB free | **2.1 MB/s** | 160 s |
| Download stopped, page cache dropped | **32.3 MB/s** | 300 s |

A **15x** difference, and the whole 17.9 GB load finished in **27 minutes**
wall clock including the slow first half. Do not pull a model and cold-load
another at the same time — they contend for the same 9p mount.

The control that proves the mount itself was fine throughout: `dd` off the same
GGUF read at **12.9 MB/s** while llama was apparently crawling at 2.

Sample over minutes, not seconds. A 13-second window on this same load reported
19.9 MB/s where the 300-second window reported 32.3 — the rate is bursty enough
that a short sample is worthless in either direction.

```bash
docker run --rm -v //d/llm-models:/m alpine \
  dd if=/m/<model>.gguf of=/dev/null bs=1M count=200 skip=6000
```

If that control is *also* slow, then it is memory pressure or the mount. Free
memory with `docker run --rm --privileged alpine sh -c 'sync; echo 3 >
/proc/sys/vm/drop_caches'` and re-measure before restarting anything.

**The model download restarts from zero, or dies with `[Errno 12] Cannot
allocate memory`.**
Memory pressure, not a network fault, and it is reclaimable. Hit during the 3.8
migration at ~6 GB into an 18 GB pull: the VM had 2.1 GiB free with 11 GiB sitting
in page cache, and the transfer failed with `OSError: [Errno 12]`. The download
script retries 12 times, so this shows up as a pull that keeps starting over
rather than as an error you notice. Fix it and let the retry proceed:

```bash
docker run --rm --privileged alpine sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
free -h     # want multiple GiB *free*, not just available
```

That one command took free memory from 2.1 GiB to 11 GiB here. Check
`docker logs <downloader container>` for the `[retry]` lines — a plain
`du -sh $MODELS_DIR/.hf-cache` going *down* is the symptom.

**It is unbearably slow (< 1 tok/s).**
The GPU is not attached and it is running on CPU. Check `docker info | grep -i nvidia`
and that Docker Desktop has GPU support enabled. `./scripts/logs.sh llama` shows how
many layers were actually offloaded.

**CUDA out of memory on load.**
Drop a rung on the quant table or lower `CTX_SIZE`. **Do not reach for
`-ctk f16 -ctv q8_0`** — a quantized V cache buys ~2 GiB of VRAM and takes
prefill off the GPU entirely (~65x slower, measured); it is why `CTX_SIZE` is
98304 since 2026-08-23 (65536 on 2026-08-22, 32768 before that). Proven by
`ctx_needle.py`, not by `/props` — see the quant section above.

**`docker pull` from ghcr.io fails with `denied` on a public image.**
A stale ghcr credential in `~/.docker/config.json` is being sent and rejected — this
fails even though the image is public. Fix with `docker logout ghcr.io`, or refresh it:
`gh auth token | docker login ghcr.io -u <user> --password-stdin`.

**`AttributeError: 'Tool' object has no attribute 'inputSchema'` from an MCP call.**
The mcp2cli install lost its SDK pin. MCP Python SDK 2.0.0 renamed that field
and mcp2cli 3.3.1 still reads the old name. `./scripts/mcp.sh --install`
reinstalls with `mcp==${MCP_SDK_VERSION}` and fixes it.

**A command's output in the session looks nothing like what I get in my own shell.**
That is rtk, and it is doing its job — `git status` comes back as a compact stat
block, a test run comes back as its failures. `./scripts/rtk.sh --status` lists
exactly which commands this applies to; everything else is untouched. If you need the
raw bytes for one session, launch with `RTK_DISABLED=1`; to turn it off for good,
set `RTK_ENABLED=0` in `.env`.

The case that is *not* normal is output that looks wrong rather than short —
a count that disagrees with reality, a test run that reports success when it
failed. Run `./scripts/rtk.sh --check` first: it re-runs every measurement the
allow-list rests on, including that a failing pytest still exits non-zero and
still names what broke. If that passes and the output is still wrong, the command
does not belong on the allow-list — take it out of `vendor/rtk-pi/src/gate.ts`
and record why, the way the entries already there do.

**The bind-mount trap (Docker Desktop on Windows/WSL).**
Docker Desktop resolves bind sources on the **Windows** side. A WSL-style path such as
`/home/you/models` mounts an **empty directory** rather than failing, so the container
sees nothing and the error surfaces somewhere unrelated. `MODELS_DIR` must be the
`//d/...` form. This is why the helper scripts are baked into the forge image instead
of being bind-mounted.

---

[← back to the README](../README.md)
