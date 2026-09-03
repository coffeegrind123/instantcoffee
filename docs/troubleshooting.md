# Troubleshooting

Symptoms in the order you are likely to hit them.

**An unattended `/loop` run spins forever making no changes, and the transcript
shows empty assistant turns.**
Fixed on 2026-08-27; this entry is here because the symptom is so quiet. Every
turn burned the full generation cap (`eval time = … / 8192 tokens` in
`./scripts/logs.sh llama`, ~85 s each) and reached pi as an assistant message
with **no content, no usage and `stopReason: "stop"`** — a completed turn as far
as anything downstream could tell. forge logged nothing at all for those turns:
no `Retries exhausted`, no error, just `<< SSE 2 events`.

Two independent causes, both fixed:

- **forge had a silent dead end.** `FORGE_MAX_RETRIES=0` bounds the attempt loop
  at one, `FORGE_MAX_TOOL_ERRORS=2` bounds tool-error kinds at three — so the
  first malformed tool call was "not exhausted", forge queued a correction for
  an attempt it could not make, fell out of its own loop and returned an empty
  200. A tool call cut off at the token cap is exactly what produces it.
  `patches/forge_empty_turn.py`, plus `patches/forge_text_sse_passthrough.py` so
  a truncated turn is reported as `length` rather than `stop`.
- **the loop's stuck ladder could not climb.** It cleared its "in a row" streak
  on any turn that was not itself stuck, and an intervention zeroes the very
  counter the next verdict needs — so the streak never passed 1 and the hard
  reset, the rescue model and the compaction were unreachable. Empty turns also
  counted as narration, so three were needed before anything fired. Fixed in
  `vendor/pi-loop-mode` (AP1/AP2 in `tests/empty-turn-ladder.test.ts`).

If something like this appears again, the two cheap instruments are
`./scripts/logs.sh llama | grep "eval time"` — a generation that lands on the
cap every turn is not a model that is thinking hard — and `.pi-loop-log.jsonl`
in the working directory, whose `stuckStreak` says whether the ladder is
actually climbing.

**Every request fails with `502 Backend returned 500`, and nothing else changed
but `.env`.**
Read the rest of that sentence — since 2026-09-02 forge appends the backend's
own explanation, so the message names the cause:

    502 Backend returned 500: Unexpected reasoning effort high.
        Supported types are xhigh (default), medium, and low.
    502 Backend returned 500: System message must be at the beginning.

Both come from the **chat template**, which ships inside the GGUF — so switching
mode switches it, and the modes do not carry the same one. `coding`'s unsloth
GGUF has a 9993-char fork with "Unsloth fixes - developer role, merged system
messages, tool calling" in it; `uc-coding` and `prose` carry Qwen's published
8952-char original, which is stricter. Shapes that work on `coding` and fail on
the other two:

- `REASONING_EFFORT=high` — **the one that takes the whole stack down**, because
  it is baked into llama-server's launch flags, so every request fails rather
  than one. `medium`, `low` and `xhigh` work on both templates. `.env` and
  `docs/reasoning.md` called `high` "silently rewritten to `xhigh`" until
  2026-09-02; that was true of the GGUF it was read out of and false since the
  pin moved on 2026-08-25.
- a `developer` role, or a second leading system message.

`./scripts/smoke-test.sh` prints the active template's length ("jinja chat
template loaded — template is 8952 chars"), which is the fastest way to tell
which one is in service. To see every shape the active template refuses:

```bash
docker compose --profile tools run --rm --build \
    --entrypoint python bench /work/scripts/template_probe.py
```

If the message is a bare `Backend returned 500` with nothing after the code,
either the backend sent an unparsable body (an HTML error page — the detail is
still on `docker logs instantcoffee-llama`) or `FORGE_BACKEND_ERROR_DETAIL=0`.

**The fix is normally to change the value, not the template.** `medium`, `low`
and `xhigh` work on both templates, and one leading system message is legal
everywhere. If you genuinely need the fork's behaviour on the uncensored
weights, `CHAT_TEMPLATE_FILE` exists for it — but read its block in `.env`
first: swapping the template changes the prompt bytes of every request and
invalidates both the prefix cache and every benchmark in `context/bench/`.

```bash
python3 scripts/gguf_probe.py --dump-template unsloth/Qwen3.8-27B-GGUF \
    Qwen3.8-27B-UD-Q4_K_XL.gguf /d/llm-models/unsloth-3.8.jinja
```

Full account: `context/design/the-template-is-part-of-the-model.md`.

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

---

## Every request 502s or hangs, but llama is "healthy" — the prompt-cache stall

**Symptom.** forge answers `{"error":{"message":"ReadError (no message)",
"type":"proxy_error"}}` or simply never answers; the smoke test fails
`forge plain completion`; and every liveness signal on the box says the stack is
fine. `docker ps` shows `Up N hours (healthy)`, `/health` returns 200 in ~5 ms,
`nvidia-smi` shows the model resident. `llama-server` is at 100% of one core in
`R` state with the GPU near idle.

**It is not a crash, and probably not a wedge.** llama-server is inside a
**prompt-cache update**, which runs on the main loop and services nothing while
it does. Confirm it in one command:

    docker logs instantcoffee-llama 2>&1 | grep -E 'updating prompt cache|prompt cache update took'

An `updating prompt cache` with no matching `prompt cache update took` after it
is a stall in progress. Note the `2>&1`: llama writes to **stderr**, so without
it every grep of `docker logs` comes back empty and the absence reads as
evidence.

**How long it can last.** Measured on this box on 2026-09-03, same engine, same
day: usually 1.3–2.9 s, but **24.78 s** on one of six otherwise identical quiet
rounds, **39.06 s** and **81.12 s** under load, and once **1,109.11 s — 18
minutes 29 seconds**. That last one ate a smoke-test request whole: forge
cancelled it at exactly 600.000 s (`FORGE_BACKEND_TIMEOUT`) and reported a proxy
error about a server that was, in its own terms, healthy throughout.

**Why the healthcheck cannot see it.** `/health` is answered by an HTTP thread
and never touches the inference loop. `/slots` and `/metrics` post a task to the
same queue a completion goes through, so they answer only while the loop is
turning. During the stall `/health` returned 200 in 37 ms while both of the
others timed out at 10 s; five minutes after a restart all three answered in
~5 ms. That contrast is the diagnostic:

    for e in /health /slots /metrics; do \
      printf '%-9s ' "$e"; \
      curl -sS -o /dev/null -w 'HTTP %{http_code} in %{time_total}s\n' \
        --max-time 10 "http://127.0.0.1:8080$e"; done

`/health` fast + `/slots` and `/metrics` timing out = the loop is inside
something. `/health` failing too = nobody is home, which is the case the
watchdog in `docker-compose.yml` already handles by ending the container.

**Do not turn that diagnostic into a watchdog.** An update that legitimately
finishes after 18m29s is indistinguishable from outside from one that never
will, so any kill threshold short enough to be useful would end a working engine
mid-copy and buy a cold reload for nothing. This is a diagnosis, not a trigger.

**Why the entries are so large here.** Qwen3.8-27B is a hybrid: 48 of its 64
layers hold a constant-size recurrent state, so a cached prompt costs ~150 MiB
before its first KV byte and each `CTX_CHECKPOINTS` copy adds ~150 MiB more. The
server's own cache dump shows a **34-token** prompt occupying **300.559 MiB**,
and a 29,714-token prompt **1,783.870 MiB** against the `CACHE_RAM=2048` cap —
so at long contexts the cache holds exactly one prompt and every prompt switch
evicts it and re-copies more than a gigabyte:

    docker logs instantcoffee-llama 2>&1 | grep -E 'cache state:|- prompt 0x'

**What to do about it.** In the moment: wait, or restart llama
(`docker restart instantcoffee-llama`, then expect a ~5 minute warm reload) and
accept that you may be killing an operation that was about to finish. Note that
`docker restart` on a spinning llama-server can fail with *"tried to kill
container, but did not receive an exit event"* and leave the container `exited`
with the restart policy suppressed — `docker start` it, and if the NVIDIA
prestart hook then dies with `ldcache error: process /sbin/ldconfig terminated
with signal 9`, drop the Docker VM page cache and retry:

    docker run --rm --privileged alpine sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'

Structurally, `CACHE_RAM=0` removes the path entirely at the cost of all
cross-request prefix reuse. **That is a pin change and has not been made** — the
trade has not been measured, only the tail has. `./scripts/cache_stall_probe.py`
is the instrument for measuring it.

**Size does not predict the stall.** Six quiet rounds with an identical
~1252 MiB payload and one eviction each ran 1.32, 1.32, 1.38, 1.98, 2.86 and
24.78 s, and the 24.78 s round had the *most* free memory of the six
(5,460 MiB). So the obvious "it is memory pressure" reading is not supported by
that data and was retracted. Contention makes the tail worse — both three-figure
observations came from a box at load 16–34 with another build running — but the
mechanism behind the variance is not identified.
