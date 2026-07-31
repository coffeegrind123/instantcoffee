# qwen3.6-forge

Reproducible Docker Compose stack running **Qwen3.6-27B** on a single **RTX 4090**,
behind the **forge** guardrail proxy.

```
  Claude Code / opencode / aider / your code
                  │
                  │  Anthropic Messages API  (POST /v1/messages)
                  │  OpenAI chat-completions (POST /v1/chat/completions)
                  ▼
       ┌─────────────────────┐   forge proxy      :8081
       │  forge-guardrails   │   response validation, rescue parsing,
       │  (container)        │   retry-with-nudge, reasoning-replay policy
       └──────────┬──────────┘
                  │  OpenAI wire, tools forwarded verbatim
                  ▼
       ┌─────────────────────┐   llama-server     :8080
       │  llama.cpp + CUDA   │   Qwen3.6-27B UD-Q4_K_XL, --jinja native
       │  (container, GPU)   │   function calling, 32K context
       └─────────────────────┘
                  │
              RTX 4090 / 24 GiB
```

Clients talk to **8081** (forge). Nothing should talk to 8080 directly except forge —
that port is exposed only for debugging and metrics.

## Requirements

- Docker Desktop with **GPU support enabled** (Settings → Resources → GPU)
- NVIDIA driver with CUDA support — verified here on driver `596.36`
- ~20 GB of disk for the model, ~5 GB for images
- `bash`, `curl`, and `docker` for the scripts (`python3` optional — the scripts fall
  back to a throwaway container when it is missing)

## Quick start

```bash
git clone <this repo> && cd qwen3.6-forge

# Edit MODELS_DIR in .env first if D: is not where you want ~18 GB to land.
./scripts/setup.sh
```

`setup.sh` checks prerequisites, builds the forge image, downloads the GGUF, starts
both services, and then runs the end-to-end smoke test. It is idempotent — re-run it
any time.

Then point Claude Code at it:

```bash
source scripts/claude-code-env.sh
claude
```

## Day-to-day

| Command | What it does |
| --- | --- |
| `./scripts/up.sh` | Start the stack |
| `./scripts/down.sh` | Stop the stack |
| `./scripts/logs.sh llama` | Tail llama-server (watch the model load here) |
| `./scripts/smoke-test.sh` | Verify inference and tool calling end to end |
| `./scripts/update.sh` | Update llama.cpp **and** forge, restart, verify, roll back on failure |
| `./scripts/update.sh --check` | Report what is available without changing anything |
| `./scripts/download-model.sh` | (Re-)fetch the GGUF named in `.env` |

## Updating

```bash
./scripts/update.sh
```

One command updates both components:

1. Resolves the newest llama.cpp CUDA build from the `org.opencontainers.image.version`
   annotation on ghcr's floating `server-cuda` tag, then pins the **immutable
   per-build tag** (`server-cuda-b10200`), never the floating one.
2. Resolves the newest `forge-guardrails` from PyPI.
3. Shows a current-vs-latest table and asks before touching anything.
4. Pulls, rebuilds, restarts, and runs the smoke test.
5. **If the smoke test fails, the previous pins are restored and the stack is brought
   back up on them.** An update that breaks inference does not get to stay.
6. Rewrites `versions.lock` with the resolved image digest — commit it, that file is
   the record of what was actually verified working.

## Configuration

Everything lives in `.env`, which is committed on purpose (no secrets in it — the
pins are the whole point). For machine-local changes that should not be committed,
create `.env.local` with the same keys; the scripts merge it on top.

The keys worth knowing:

| Key | Default | Notes |
| --- | --- | --- |
| `MODELS_DIR` | `//d/llm-models` | **Must be a Windows-style path** — see the bind-mount trap below |
| `GGUF_FILE` | `Qwen3.6-27B-UD-Q4_K_XL.gguf` | See the VRAM table |
| `CTX_SIZE` | `32768` | Context per slot; also what forge uses as its token budget |
| `REASONING_BUDGET` | `4096` | `-1` unrestricted, `0` disables thinking, `N` caps it |
| `FLASH_ATTN` | `on` | Recent llama.cpp requires a **value** here (`on`/`off`/`auto`) |
| `MMPROJ_FILE` | *(empty)* | Set to `mmproj-F16.gguf` for image input |
| `FORGE_CAPABILITY` | `native` | Keep `native` — llama.cpp with `--jinja` does real function calling |
| `FORGE_REASONING_REPLAY` | `none` | `keep-last` / `full` replay captured reasoning to the backend |
| `BIND_ADDR` | `127.0.0.1` | `0.0.0.0` to expose on the LAN |

## Choosing a quant for 24 GiB

The 4090 has 24.0 GiB. Qwen3.6-27B is a hybrid: only **16 of its 64 layers** use full
attention (the other 48 are Gated DeltaNet, whose recurrent state does not grow with
context). That makes its KV cache far smaller than a normal 27B — about **64 KiB per
token**, so 2.0 GiB at 32K.

| GGUF | Weights | @32K ctx | @64K ctx | Verdict on 24 GiB |
| --- | --- | --- | --- | --- |
| `IQ4_XS` | 14.4 GiB | ~17.7 | ~19.7 | Most headroom, lowest quality of the 4-bits |
| `Q4_K_M` | 15.7 GiB | ~19.0 | ~21.0 | Safe |
| **`UD-Q4_K_XL`** | **16.4 GiB** | **~19.7** | **~21.7** | **Default — best quality that still leaves room** |
| `Q5_K_M` | 18.2 GiB | ~21.5 | ~23.5 | Headless only; no room for a desktop |
| `Q6_K` | 21.0 GiB | ~24.3 | — | Does not fit |

Totals include ~1.3 GiB of CUDA context and compute buffers. Note that the card is
never entirely yours: measured on this machine, llama.cpp saw **22992 MiB free** of
24563 MiB with an ordinary Windows desktop running, so budget against ~22.4 GiB
rather than 24. Check yours with:

```bash
docker compose run --rm --no-deps llama --list-devices
```

Going past 64K context needs a quantized KV cache — add to `.env`:

```
LLAMA_EXTRA_FLAGS=-ctk q8_0 -ctv q8_0
```

That roughly halves KV, which brings 128K within reach at `UD-Q4_K_XL`.

## Using it with Claude Code

```bash
source scripts/claude-code-env.sh   # must be sourced, not executed
claude
```

It sets `ANTHROPIC_BASE_URL` to the forge proxy plus a dummy `ANTHROPIC_AUTH_TOKEN`,
and unsets `ANTHROPIC_API_KEY` — forge refuses any request carrying *two* credentials,
and a leftover key in the environment is the usual way that happens. Open a new shell
to go back to the hosted API.

forge serves the Anthropic Messages API on `/v1/messages` and the OpenAI
chat-completions API on `/v1/chat/completions`, so opencode, Continue, aider and
anything else OpenAI-shaped work against the same port.

### Give it enough context

Claude Code's system prompt plus its tool schemas is already a five-figure token
count before your first message, and every connected MCP server adds more. The
default `CTX_SIZE=32768` is fine for API use but tight for Claude Code. For that
workload, put this in `.env.local`:

```
CTX_SIZE=65536
LLAMA_EXTRA_FLAGS=-ctk q8_0 -ctv q8_0
```

The quantized KV cache halves the 4.0 GiB that 64K would otherwise cost, landing the
total near 19.7 GiB — comfortable inside the ~22.4 GiB actually free. `CTX_SIZE` also
drives forge's `--budget-tokens`, so the two can never disagree. Restart with
`./scripts/up.sh` after changing it.

Because `--no-context-shift` is set, overflowing the window fails loudly instead of
silently discarding your oldest turns.

### What does not survive the trip

forge translates Anthropic requests to OpenAI for llama.cpp, and Anthropic-only
fields have no analog on the other side:

- **`cache_control` is dropped** — there is no prompt caching. Every turn re-reads
  the whole conversation, which is the main reason context size matters here.
- **`thinking` blocks are dropped**; forge does not synthesize signed Anthropic
  thinking blocks. Qwen still reasons — `--reasoning-budget 4096` — you just do not
  get it back as replayable thinking.
- **Streaming is not incremental.** forge accepts `stream=true` and returns SSE, but
  inference completes before the events are emitted, because rescue parsing and
  retries need the whole response. Expect the reply to land at once after a pause,
  not to type itself out.
- **The model name is ignored** end to end. `ANTHROPIC_MODEL` is a label.

## Troubleshooting

**Tool calls never come back / the model "won't use tools".**
Run `./scripts/smoke-test.sh`. It asserts on `tool_calls` specifically, because
llama.cpp *silently ignores* the `tools` parameter when `--jinja` is missing — which
looks identical to a model that is bad at tool calling. The smoke test prints the raw
response body when this happens.

**It is unbearably slow (< 1 tok/s).**
The GPU is not attached and it is running on CPU. Check `docker info | grep -i nvidia`
and that Docker Desktop has GPU support enabled. `./scripts/logs.sh llama` shows how
many layers were actually offloaded.

**CUDA out of memory on load.**
Drop a rung on the quant table, lower `CTX_SIZE`, or set
`LLAMA_EXTRA_FLAGS=-ctk q8_0 -ctv q8_0`.

**`docker pull` from ghcr.io fails with `denied` on a public image.**
A stale ghcr credential in `~/.docker/config.json` is being sent and rejected — this
fails even though the image is public. Fix with `docker logout ghcr.io`, or refresh it:
`gh auth token | docker login ghcr.io -u <user> --password-stdin`.

**The bind-mount trap (Docker Desktop on Windows/WSL).**
Docker Desktop resolves bind sources on the **Windows** side. A WSL-style path such as
`/home/you/models` mounts an **empty directory** rather than failing, so the container
sees nothing and the error surfaces somewhere unrelated. `MODELS_DIR` must be the
`//d/...` form. This is why the helper scripts are baked into the forge image instead
of being bind-mounted.

## Layout

```
.env                    committed config + version pins
versions.lock           what update.sh last verified (generated)
docker-compose.yml      llama + forge, plus tools-profile one-shots
Dockerfile.forge        forge proxy image, pinned to FORGE_VERSION
scripts/
  setup.sh              prerequisites -> model -> build -> up -> verify
  update.sh             update everything, verify, roll back on failure
  smoke_test.py         end-to-end checks (runs inside the compose network)
  download_model.py     resumable GGUF fetch
  claude-code-env.sh    source this to point Claude Code at forge
context/design/         why things are the way they are
```
