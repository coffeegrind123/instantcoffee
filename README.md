# qwen3.6-forge

[![CI](https://img.shields.io/badge/ci-passing-brightgreen?logo=githubactions&style=flat)](https://github.com/coffeegrind123/qwen3.6-forge/actions)
[![Eval](https://img.shields.io/badge/eval-84%25%20(26%2F26)-green?logo=pytest&style=flat)](#eval-results)

Reproducible Docker Compose stack running **Qwen3.6-27B** on a single **RTX 4090**,
behind the **forge** guardrail proxy, driven by the **pi** coding agent. One
backend: upstream **llama.cpp** with an **unsloth GGUF** (MTP speculative
decoding, single-file, mmap-friendly).

```
              pi  (scripts/pi-local.sh)
                  │
                  │  OpenAI chat-completions (POST /v1/chat/completions)
                  ▼
       ┌─────────────────────┐   headroom         :8787
       │  headroom           │   context compression: JSON tool output,
       │  (container)        │   logs, build spew. HEADROOM_ENABLED=0 removes it.
       └──────────┬──────────┘
                  │
                  ▼
       ┌─────────────────────┐   forge proxy      :8081
       │  forge-guardrails   │   response validation, rescue parsing,
       │  (container)        │   retry-with-nudge, reasoning-replay policy
       └──────────┬──────────┘
                  │  OpenAI wire, tools forwarded verbatim
                  ▼
       ┌─────────────────────┐   llama-server     :8080
       │  llama.cpp (CUDA)    │   Qwen3.6-27B, --jinja native function
       │                      │   calling, 64K context
       └─────────────────────┘
                  │
              RTX 4090 / 24 GiB
```

pi talks to **8787** (headroom) by default, or to **8081** (forge) with
`HEADROOM_ENABLED=0`. Nothing should talk to 8080 directly except forge — that
port is exposed only for debugging and metrics.

**This stack targets pi and nothing else.** Claude Code support was removed
(2026-08-12): it cost a launcher, an Anthropic-wire smoke test, a Harbor agent
subclass, an SDK dependency, and a set of `.env` keys, all to serve a client
whose fixed prompt-and-tool-schema overhead is the worst possible fit for a 64K
local window. forge still *serves* `/v1/messages`, so an Anthropic-shaped client
would work — it is simply not what anything here is tuned, measured, or
documented for.

## Requirements

- Docker Desktop with **GPU support enabled** (Settings → Resources → GPU)
- NVIDIA driver with CUDA support — verified here on driver `596.36`
- ~20 GB of disk for the model, ~5 GB for images
- `bash`, `curl`, and `docker` for the scripts (`python3` optional — the scripts fall
  back to a throwaway container when it is missing)
- `uv` only for the two optional extras: MCP-as-a-CLI (`scripts/mcp.sh`) and the
  Harbor eval runner. Nothing in the core stack needs it.

## Quick start

```bash
git clone <this repo> && cd qwen3.6-forge

# Edit MODELS_DIR in .env first if D: is not where you want ~15 GB to land.
./scripts/setup.sh
```

`setup.sh` checks prerequisites, builds the forge image, downloads the GGUF, starts
both services, and then runs the end-to-end smoke test. It is idempotent — re-run it
any time.

Then start a session:

```bash
./scripts/pi-local.sh
```

## Day-to-day

| Command | What it does |
| --- | --- |
| `./scripts/up.sh` | Start the stack |
| `./scripts/down.sh` | Stop the stack |
| `./scripts/logs.sh llama` | Tail llama-server (watch the model load here) |
| `./scripts/smoke-test.sh` | Verify inference and tool calling end to end |
| `./scripts/update.sh` | Update llama.cpp, forge **and** headroom, restart, verify, roll back on failure |
| `./scripts/update.sh --check` | Report what is available without changing anything |
| `./scripts/pi-local.sh` | Launch pi against the local model |
| `./scripts/download-model.sh` | Fetch the GGUF (resumable; a no-op if it is already on disk) |
| `./scripts/ab-think-lang.sh` | A/B the `THINK_LANG` prompt before trusting it |
| `./scripts/headroom.sh status` | Is compression in the path, and configured how |
| `./scripts/ab-headroom.sh` | A/B compression before routing pi through it |
| `./scripts/mcp.sh --servers` | List MCP servers reachable as a CLI |

## Updating

```bash
./scripts/update.sh
```

One command updates every pinned component:

1. Resolves the newest llama.cpp CUDA build from the `org.opencontainers.image.version`
   annotation on ghcr's floating `server-cuda` tag, then pins the **immutable
   per-build tag** (`server-cuda-b10200`), never the floating one.
2. Resolves the newest `forge-guardrails` and `headroom-ai` from PyPI. headroom
   is only rebuilt if this machine has ever built it — an opt-in component does
   not get to make its dependencies a mandatory cost of every update.
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
| `CTX_SIZE` | `32768` | Context per slot; also what forge uses as its token budget. Capped by the f16 KV cache — see below |
| `REASONING_BUDGET` | `4096` | `-1` unrestricted, `0` disables thinking, `N` caps it |
| `THINK_LANG` | `zh` | Reason in Mandarin, answer in English. `off` disables. Unmeasured on this hardware — see below |
| `FLASH_ATTN` | `on` | Recent llama.cpp requires a **value** here (`on`/`off`/`auto`) |
| `LLAMA_EXTRA_FLAGS` | `-n 8192 --load-mode none` | `--load-mode none` disables mmap (mandatory on a 9p bind mount); `-n` is the server-side generation cap. **No KV quantization** — see below |
| `CACHE_PROMPT` | `1` | Persist KV cache to disk for fast warm restarts |
| `CACHE_RAM` | `8192` | RAM budget for prompt cache in MiB; 0 disables |
| `CACHE_REUSE` | `64` | Previous cache entries to compare for reuse |
| `SLOT_PROMPT_SIMILARITY` | `0.20` | Similarity threshold for cache reuse (0.0–1.0) |
| `CTX_CHECKPOINTS` | `16` | KV checkpoints per slot for agentic rewind; 0 disables |
| `CHECKPOINT_MIN_STEP` | `256` | Minimum tokens between checkpoints |
| `SPEC_DRAFT_N_MIN` | `0` | Minimum MTP draft tokens; 0 = auto |
| `SPEC_DRAFT_P_MIN` | `0.75` | Minimum MTP per-token acceptance probability |
| `MMPROJ_FILE` | *(empty)* | Set to `mmproj-F16.gguf` for image input |
| `FORGE_CAPABILITY` | `native` | Keep `native` — llama.cpp with `--jinja` does real function calling |
| `FORGE_REASONING_REPLAY` | `full` | `keep-last` / `full` replay captured reasoning to the backend |
| `BIND_ADDR` | `127.0.0.1` | `0.0.0.0` to expose on the LAN |
| `PI_MAX_TOKENS` | `8192` | Generation cap given to pi; keep `-n` in `LLAMA_EXTRA_FLAGS` equal to it |
| `PI_CONTEXT_FILES` | `0` | `1` loads `AGENTS.md`; `0` passes `-nc` |
| `PI_EXTRA_ARGS` | *(empty)* | Flags your own `pi` alias would add — aliases do not expand in scripts |
| `HEADROOM_ENABLED` | `1` | Routes pi through the compression proxy and starts it with the stack. `0` removes it |
| `HEADROOM_VERSION` | `0.34.0` | `headroom-ai` release from PyPI |
| `HEADROOM_RECOVERY` | `lossless` | `lossless` / `ccr` / `lossy` — see below |
| `HEADROOM_TARGET_RATIO` | *(empty)* | Kompress keep-ratio; empty lets it decide |
| `MCP2CLI_ENABLED` | `1` | Loads the `mcp-tools` skill so pi can call MCP servers as a CLI. `0` disables |
| `MCP2CLI_VERSION` | `3.3.1` | mcp2cli release |
| `MCP_SDK_VERSION` | `1.29.0` | MCP Python SDK pin — must stay `<2`, see below |

## Choosing a quant for 24 GiB

The 4090 has 24.0 GiB. Qwen3.6-27B is a hybrid: only **16 of its 64 layers** use full
attention (the other 48 are Gated DeltaNet, whose recurrent state does not grow with
context). That makes its KV cache far smaller than a normal 27B.

**The KV cache must be f16/f16 here, and that is what sets the context size.**
Measured on this machine on 2026-08-12, not inherited from a guide:

| KV cache | Prompt processing | 12K-token request |
| --- | --- | --- |
| `-ctk f16 -ctv q8_0` | 26–140 tok/s, **falling** as the prompt grows (GPU at 0%) | never finished inside forge's 600s timeout |
| f16 / f16 (what this repo now uses) | **1806 tok/s** | **6.9 s**, correct answer |

A quantized V cache takes prefill off the GPU on build `b10200` — roughly a **65×**
penalty on every prompt, which is exactly the workload a coding agent generates. It
cannot be worked around by disabling flash attention either: llama.cpp refuses to
start with `V cache quantization requires flash_attn`. So the choice is f16/f16, and
f16/f16 costs about **132 KiB per token** against ~98 KiB with a quantized V.

That is why `CTX_SIZE` is **32768** rather than 65536 — a 32K window that answers in
seconds beats a 64K window that times out.

| GGUF | Weights | @32K f16/f16 | Verdict on ~22.4 GiB |
| --- | --- | --- | --- |
| `IQ4_XS` | 14.4 GiB | ~19.8 | Most headroom, lowest quality of the 4-bits |
| `Q4_K_M` | 15.7 GiB | ~21.1 | Fits |
| **`UD-Q4_K_XL`** | **16.4 GiB** | **~21.6 (measured 21566 MiB)** | **Default — best quality that still fits** |
| `Q5_K_M` | 18.2 GiB | — | Does not fit |
| `Q6_K` | 21.0 GiB | — | Does not fit |

Totals include ~1.3 GiB of CUDA context and compute buffers. `-b`/`-ub` are
deliberately left at their defaults: raising them to `4096`/`2048` cost ~850 MiB of
VRAM for a prompt-processing win that does not exist once prefill is actually on the
GPU. Note that the card is never entirely yours: measured here, llama.cpp saw
**22992 MiB free** of 24563 MiB with an ordinary Windows desktop running, so budget
against ~22.4 GiB rather than 24. Check yours with:

```bash
docker compose run --rm --no-deps llama --list-devices
```

## Using it with pi (pi.dev)

```bash
./scripts/pi-local.sh                 # start a session
./scripts/pi-local.sh --install-only  # just write the provider config
./scripts/pi-local.sh -p "summarize"  # any pi flag passes through
./scripts/pi-local.sh --print-only    # show the exact command without running it
```

The launch banner states the route, the model, whether context files are loaded
and whether a thinking-language fragment is active — so a session can never be
running something you did not ask for without saying so:

```
pi -> http://localhost:8081 via forge  (model: qwen3.6-27b, context files off, thinking in zh)
```

pi has no "point at a proxy" flag — custom providers live in
`~/.pi/agent/models.json`. The script generates that entry from `.env`, so the
model id, context window and port cannot drift from what the stack serves. It
*merges* into the file rather than overwriting, since pi keeps other providers
there too.

What it writes, and why each field:

```json
{
  "providers": {
    "forge": {
      "baseUrl": "http://localhost:8081/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen3.6-27b", "contextWindow": 65536, "maxTokens": 16384 }
      ]
    }
  }
}
```

- **`openai-completions`, not `anthropic-messages`.** forge speaks both, but the
  OpenAI endpoint is the short path (pi → forge → llama.cpp). Routing via
  Anthropic would add a translation hop that drops `cache_control` and
  `thinking` for no gain. It is also the only path anything here is measured on.
- **`apiKey: "local"`** — pi hides models it considers unauthenticated, so even a
  keyless local server needs a placeholder.
- **`compat` both false** — llama.cpp's chat templates don't know the `developer`
  role, and `reasoning_effort` is an OpenAI-ism it doesn't implement. pi's own
  docs flag this for exactly this class of server.
- **`maxTokens` well under `contextWindow`** — with `--no-context-shift` an
  overflowing request fails loudly, and an agent loop's prompt grows every turn.
  It comes from `PI_MAX_TOKENS`, and `LLAMA_EXTRA_FLAGS` carries the same number
  as `-n` so the server enforces it even if a client forgets to ask.
- **`baseUrl` host** — the script uses `host.docker.internal` when it detects it
  is running inside a container, `localhost` otherwise. It points at headroom by
  default, and straight at forge when `HEADROOM_ENABLED=0`.

**Not using pi's `/llama` integration.** pi can manage its own llama.cpp router
and models. That would bypass forge completely and lose every guardrail this
repo exists to provide, so the model is registered as a plain custom provider
instead.

### Why pi, and what that costs

pi is minimal by design: **no MCP** (its README says so outright — "build CLI
tools with READMEs, or build an extension that adds MCP support"), no
sub-agents. On a 64K local window that is the feature, not the limitation. A
single MCP server can publish hundreds of tool schemas that load before your
first message, and that budget is gone before the model has read anything.

What you give up is real and worth stating: no MCP servers, no sub-agent
fan-out, and no ecosystem of Claude Code plugins. What you get back is nearly
the whole window for the actual session.

The one flag that matters is `-nc`, which the launcher passes by default: it
skips `AGENTS.md`/`CLAUDE.md` discovery, and pi walks parent directories looking
for those. Set `PI_CONTEXT_FILES=1` when you do want project conventions loaded.

## MCP, without MCP

You can still reach MCP servers — just not by loading their schemas. This is
**on by default**: the launcher passes pi a skill that teaches it about
`./scripts/mcp.sh`, which fronts [mcp2cli](https://github.com/knowsuchagency/mcp2cli):

```bash
./scripts/mcp.sh --servers                    # what is registered
./scripts/mcp.sh everything --search sum      # find a tool
./scripts/mcp.sh everything get-sum --help    # that one tool's arguments
./scripts/mcp.sh everything get-sum --a 20 --b 22
#=> The sum of 20 and 22 is 42.
```

The economics are the whole point. Wiring an MCP server into a client puts every
tool's schema in the prompt on every turn, forever. Here the always-on cost is
the skill's name and description — about 60 tokens, because pi loads a skill's
body only when a task matches — and a tool's schema enters the context only when
the model asks for that one tool with `<tool> --help`. `--compact` lists a whole
server for roughly 2 tokens per tool.

Servers are declared in `mcp/servers.json`, `stdio` or `url`, one line each. An
`auth_header` value takes `env:VAR` and `file:/path` prefixes, so no credential
goes in the committed file — CI rejects a literal one.

Unlike headroom, this is on without a measurement gate in front of it: the cost
is bounded and known — the skill description, and nothing else until the model
chooses to call a server — so there is nothing to weigh. It needs `uv` on PATH;
`MCP2CLI_ENABLED=0` turns it off, and `pi-local.sh` says which state it is in.

Two things that were measured rather than assumed, on 2026-08-12:

- **`uv tool install mcp2cli` is broken as of today.** The MCP Python SDK
  released 2.0.0, which renames `Tool.inputSchema` to `input_schema`; mcp2cli
  3.3.1 still reads the old name, so an unpinned install resolves 2.0.0 and every
  call dies with `AttributeError` before it reaches the server. `MCP_SDK_VERSION`
  pins `mcp==1.29.0` and `scripts/mcp.sh` installs with that pin. CI fails if the
  pin moves to 2.x.
- **mcp2cli's persistent sessions did not work here.** `--session-start` returns
  "session daemon did not start in time". Each call therefore spawns the server
  (~5s for an `npx` one). The skill tells the model to batch questions rather
  than reach for sessions.

### What does not survive the trip

- **Streaming is not incremental.** forge accepts `stream=true` and returns SSE, but
  inference completes before the events are emitted, because rescue parsing and
  retries need the whole response. Expect the reply to land at once after a pause,
  not to type itself out.
- **The model name is ignored** end to end. It is a label; llama.cpp serves
  whatever GGUF it was started with.
- **`reasoning_effort` and the `developer` role are not implemented** by
  llama.cpp's chat templates, which is why the provider entry declares both as
  unsupported. Thinking is controlled server-side by `REASONING_BUDGET` and
  nowhere else.
- **Prompt caching is not an API-level feature here.** There is no
  `cache_control` on the OpenAI wire; the stack gets the same effect from
  `--cache-prompt` + `--slot-save-path` (KV cache persisted to disk, so warm
  restarts skip re-prefill), `preserve_thinking` (no KV re-prefill across
  agentic turns), and `--ctx-checkpoints` (fast rewind). See `.env` for
  `CACHE_RAM`, `CACHE_REUSE` and the related knobs.

## Compression with headroom (optional, off)

[headroom](https://github.com/headroomlabs-ai/headroom) compresses tool output,
logs and JSON before they reach the model. Its headline numbers are about saving
money on hosted APIs; here the binding constraint is a 64K window and prefill
time on one 4090, which is a better fit than the pitch — and headroom documents
that case itself.

**It is on by default.** `./scripts/up.sh` starts it, `./scripts/pi-local.sh`
routes through it, and `HEADROOM_ENABLED=0` takes it out of the path and leaves
the container stopped (`scripts/lib.sh` adds the compose profile from that one
key, so every script follows it).

```bash
./scripts/headroom.sh status    # in the path, and configured how
./scripts/headroom.sh savings   # what it has actually saved
./scripts/ab-headroom.sh --save # what it costs in quality on this model
```

Know what that default means. Every number in `results/` was produced **without**
it — `eval.py` talks straight to forge and always will — so the scorecard
describes the model while a real session now runs through a compressor the
scorecard never saw. headroom's accuracy claims (GSM8K unchanged, BFCL 97%) were
established on frontier hosted models, not on a 4-bit 27B whose own tools suite
scores 0.73. `ab-headroom.sh` is how you close that gap; nothing gates on it.

### Sized for this model, not for Opus

| Decision | Why |
| --- | --- |
| `HEADROOM_RECOVERY=lossless` by default | Format-native compaction only: no CCR markers, and no `headroom_retrieve` tool injected into the request. Nothing the model sees becomes unrecoverable, and no extra tool schema competes with the real ones. `ccr` (lossy + retrieval tool) and `lossy` (no recovery at all) are opt-in, and the A/B is how you earn them. |
| `HEADROOM_TARGET_RATIO` is the lever, not the model table | headroom sizes compression against the model's context window from LiteLLM's table. `qwen3.6-27b` is not in it, so it falls back to a **conservative 128K** — twice this stack's real window. forge's own `--budget-tokens ${CTX_SIZE}` remains the backstop. |
| Built without the `[ml]` extra | `[ml]` pulls `torch` for the Kompress prose model. The GPU is entirely committed to the 27B next door, so that would be multiple GB for a compressor with nowhere to run. The compression that pays for itself in an agent loop — JSON, logs, build output — needs none of it. |
| `-n 16384` on llama-server | headroom's OpenAI shim renames `max_tokens` to `max_completion_tokens` (a real GPT-5-era compatibility fix). llama.cpp does not read that key — it maps `max_tokens` to `n_predict` and copies unknown keys through unused — so without a server-side cap a compressed request would have **no generation limit**. Verified in `tools/server/server-common.cpp`, not assumed. |
| In front of forge, not behind it | Behind forge, every retry-with-nudge would re-enter compression and hand llama.cpp different bytes per attempt, throwing away the prefix-KV reuse `--cache-reuse` exists for. |
| Subscription tracking off | headroom classifies clients by user-agent and would otherwise poll `api.anthropic.com` for quota — pointless outbound traffic from a stack whose premise is that nothing leaves the machine. |

### What the A/B actually measures

`ab-headroom.sh` runs both arms **through headroom**, so the network path is
identical; the control arm sends `x-headroom-bypass: true`, which headroom
documents as the "do not touch my bytes" contract. The only variable is whether
compression ran.

It scores the six objective tasks the think-lang A/B uses (so a regression in
ordinary coding ability shows up) plus three **recall** tasks built to be
compressible — a 220-row JSON tool result, a 600-line log, and a long file read,
each with one fact that has to survive. Those arrive as `tool` messages, not user
messages, because headroom skips user messages by default and a payload pasted
into the prompt would measure nothing.

Recall is judged separately and more harshly than the mean: losing a needle in a
compressed haystack is the specific thing compression can cost you, and it would
otherwise average away against six tasks that were never compressible. A control
arm that cannot answer either returns INCONCLUSIVE rather than a passing dead
heat at zero.

**MCP note.** headroom also ships an MCP server (`headroom_compress`,
`headroom_retrieve`, `headroom_stats`) — unusable here, because pi has no MCP.
That costs less than it sounds: CCR retrieval does *not* go through MCP. The
proxy injects `headroom_retrieve` into the request's own tool array and answers
the call itself, so reversibility is available over the plain proxy path. It is
still off by default for the reason above — a 27B choosing to call it is a claim
to measure, not to assume.

Do not use `headroom wrap` here. It registers Serena at *user* scope in
`~/.claude.json`, which leaks into every other project on the machine and drags
in exactly the tool-schema bloat this stack avoids by using pi.

## Thinking in another language

`THINK_LANG=zh` appends `prompts/think-zh.md` to the client's system prompt,
which asks the model to reason in Simplified Chinese while keeping everything
that leaves the thinking block — prose, code, quoted text, and tool-call
arguments — in the user's language.

The claim comes from the 2026-08-11 HN thread: Qwen reasons best and most
cheaply in Mandarin because that is what it was most natively trained on. The
follow-up question in that thread — *better thinking, or just shorter?* — was
never answered, and nobody posted a measurement.

**This is on by default here, by operator decision, ahead of that measurement.**
It is running on a community claim, not a local result. `THINK_LANG=off` in
`.env` reverts it, and the A/B below is how you find out whether it earns its
place.

It costs nothing in readability on this stack specifically: the provider entry
declares `reasoning: false`, so pi never renders a thinking trace and you would
not be reading it anyway. The real risk is the opposite one — a model reasoning in
Chinese that then writes a Chinese character into an `old_string` or a file path
has produced a patch that does not apply.

That is what the A/B harness checks:

```bash
./scripts/up.sh                       # the stack must be running
./scripts/ab-think-lang.sh --repeat 3 # ~36 requests, both arms, thinking on
```

It runs six objectively-scored tasks with and without the fragment and prints:

| metric | baseline | think-lang |
| --- | --- | --- |
| mean score | … | … |
| mean reasoning chars | … | … |
| CJK in visible output | 0 | … |
| CJK in tool args | 0 | … |

Any Chinese in tool-call arguments exits non-zero and the verdict tells you not
to adopt it, whatever the score did. Since it is already on, treat a non-zero
exit as a signal to set `THINK_LANG=off` rather than as advice you can defer.

`pi-local.sh` prints `thinking in zh` in its launch banner whenever it is
active, so a session can never be running it silently.

Neither llama-server nor forge can inject a system prompt — verified, with the
receipts, in `prompts/README.md` — so this is applied by the launchers, and by
`eval.py` when you set `EVAL_SYSTEM_PROMPT_FILE`.

Adding another language is a file: drop `prompts/think-<code>.md` and set
`THINK_LANG=<code>`. An unknown code fails the launch loudly rather than starting
a session without the prompt it was told to use.

## Troubleshooting

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

**The load stalls: high CPU, no progress, VRAM flat.**
Memory pressure, not a slow disk. The model is mmap'd, so if the VM has little
free memory its pages are evicted as fast as they fault in and the load thrashes
indefinitely. Check with `free -m` (and `docker run --rm --privileged alpine
free -m` for the Docker VM). Seen here with a runaway 5.8 GB `ugrep` on the box:
killing it took *available* from 8.6 GB to 13.4 GB and the load proceeded. VRAM
that is not climbing (`docker exec qwen36-llama nvidia-smi`) is the tell —
distinguish it from a slow-but-progressing load before restarting anything.

**It is unbearably slow (< 1 tok/s).**
The GPU is not attached and it is running on CPU. Check `docker info | grep -i nvidia`
and that Docker Desktop has GPU support enabled. `./scripts/logs.sh llama` shows how
many layers were actually offloaded.

**CUDA out of memory on load.**
Drop a rung on the quant table, lower `CTX_SIZE`, or set
`LLAMA_EXTRA_FLAGS=-ctk f16 -ctv q8_0`.

**`docker pull` from ghcr.io fails with `denied` on a public image.**
A stale ghcr credential in `~/.docker/config.json` is being sent and rejected — this
fails even though the image is public. Fix with `docker logout ghcr.io`, or refresh it:
`gh auth token | docker login ghcr.io -u <user> --password-stdin`.

**`pi-local.sh` says headroom is not answering.**
pi routes at 8787 by default. `./scripts/up.sh` starts that container along with
the rest, so this usually means the stack is not up, or headroom was stopped on
its own with `./scripts/headroom.sh down`. Bring it back with
`./scripts/headroom.sh up`, or set `HEADROOM_ENABLED=0` to go straight to forge.
`./scripts/headroom.sh status` prints which of the two you are in.

**`AttributeError: 'Tool' object has no attribute 'inputSchema'` from an MCP call.**
The mcp2cli install lost its SDK pin. MCP Python SDK 2.0.0 renamed that field
and mcp2cli 3.3.1 still reads the old name. `./scripts/mcp.sh --install`
reinstalls with `mcp==${MCP_SDK_VERSION}` and fixes it.

**The bind-mount trap (Docker Desktop on Windows/WSL).**
Docker Desktop resolves bind sources on the **Windows** side. A WSL-style path such as
`/home/you/models` mounts an **empty directory** rather than failing, so the container
sees nothing and the error surfaces somewhere unrelated. `MODELS_DIR` must be the
`//d/...` form. This is why the helper scripts are baked into the forge image instead
of being bind-mounted.

## Layout

```
.env                    committed config + version pins
.env.local.example      machine-local override template (copy to .env.local)
versions.lock           what update.sh last verified (generated)
docker-compose.yml      llama + forge, plus tools- and headroom-profile services
Dockerfile.forge        forge proxy image, pinned to FORGE_VERSION
Dockerfile.headroom     headroom image, pinned to HEADROOM_VERSION
.github/workflows/ci.yml  CI pipeline (lint, build, verify)
badges/                 shield.io endpoint JSON for dynamic badges
results/
  latest.json           most recent eval run (committed, displayed in README)
  history.jsonl         append-only log of all eval runs
prompts/
  think-zh.md           reason in Mandarin, answer in the user's language
  README.md             why this is applied client-side and not in the engine
scripts/
  lib.sh                shared helpers, sourced by every script here
  setup.sh              prerequisites -> model -> build -> up -> verify
  update.sh             update everything, verify, roll back on failure
  up.sh / down.sh       start / stop the stack
  logs.sh               tail llama or forge
  smoke-test.sh         run smoke_test.py against the running stack
  download-model.sh     runner for download_model.py
  smoke_test.py         end-to-end checks (runs inside the compose network)
  eval.py               9-suite coding eval (speed, codegen, bugfix, tools…)
  eval_harness.py       extended coding eval with judge-based scoring
  run-eval.sh           run eval, save results, regenerate badge + README
  gen-readme-scorecard.py  update README scorecard from results/latest.json
  ab_think_lang.py      A/B a thinking-language prompt: quality, cost, leakage
  ab-think-lang.sh      runner for the above (resolves the fragment from .env)
  ab_headroom.py        A/B compression: tokens saved, quality, needle recall
  ab-headroom.sh        runner for the above
  headroom.sh           up / down / status / savings for the compression proxy
  headroom-entrypoint.sh  baked into the headroom image; validates HEADROOM_RECOVERY
  test_repeat_detector.py  standalone unit tests for the loop detector
  test_cjk_detector.py     standalone unit tests for the CJK leak detector
  bench.sh              prompt processing + generation speed benchmark
  slot-cache.sh         save/restore KV cache for warm restarts
  download_model.py     resumable GGUF fetch
  pi-local.sh           launch pi against the stack (the only client)
  mcp.sh                call an MCP server as a CLI (wraps mcp2cli)
mcp/servers.json        registry of MCP servers reachable via scripts/mcp.sh
skills/mcp-tools/       pi skill teaching the model to use scripts/mcp.sh
harbor-adapter/         Harbor eval runner (stock pi agent, no adapter needed)
context/                why things are the way they are
  README.md              index of the above, and the conventions it follows
  design/decisions.md    all design decisions, flags, quant choice
  design/eval-methodology.md  what the eval benches, how it scores
```

## Eval Results

> **Full methodology:** [context/design/eval-methodology.md](context/design/eval-methodology.md) —
> what each suite tests, where the benchmarks come from, how scoring works.

<!-- eval-scorecard-start -->

![Eval](https://img.shields.io/badge/eval-84%25%20(26%2F26)-green?logo=pytest&style=flat)

**Latest eval:** 84% — 26/26 tests pass (floor: 0.5)

| Suite | Score | Passed | Bar |
| --- | --- | --- | --- |
| bugfix | [██████████████░░░░░░] 0.73 | 3/3 | ![](https://img.shields.io/badge/bugfix-73%-green?style=flat-square) |
| codegen | [███████████████████░] 0.95 | 5/5 | ![](https://img.shields.io/badge/codegen-95%-brightgreen?style=flat-square) |
| edits | [█████████████████░░░] 0.88 | 4/4 | ![](https://img.shields.io/badge/edits-88%-green?style=flat-square) |
| multiturn | [████████████████████] 1.00 | 3/3 | ![](https://img.shields.io/badge/multiturn-100%-brightgreen?style=flat-square) |
| reasoning | [████████████████████] 1.00 | 3/3 | ![](https://img.shields.io/badge/reasoning-100%-brightgreen?style=flat-square) |
| refactor | [████████████████████] 1.00 | 1/1 | ![](https://img.shields.io/badge/refactor-100%-brightgreen?style=flat-square) |
| review | [█████████████░░░░░░░] 0.67 | 1/1 | ![](https://img.shields.io/badge/review-67%-yellow?style=flat-square) |
| speed | [█████████░░░░░░░░░░░] 0.47 | 3/3 | ![](https://img.shields.io/badge/speed-47%-orange?style=flat-square) |
| tools | [██████████████░░░░░░] 0.73 | 3/3 | ![](https://img.shields.io/badge/tools-73%-green?style=flat-square) |


<!-- eval-scorecard-end -->

### Running evaluations

```bash
# Start the stack first
./scripts/up.sh

# Quick smoke test (must pass)
./scripts/smoke-test.sh

# Full 9-suite coding eval
./scripts/run-eval.sh            # run and save results
./scripts/run-eval.sh --history  # also append to history.jsonl
./scripts/run-eval.sh --badge    # also regenerate badges

# Update README with latest results
python3 scripts/gen-readme-scorecard.py --all

# CI-ready: validate everything that doesn't need a GPU
python3 scripts/test_repeat_detector.py   # 14 unit tests
python3 scripts/test_cjk_detector.py      # CJK leak detector, both directions
docker compose --profile tools config     # validate compose
```

**The scorecard measures the no-thinking path.** `eval.py` sends
`enable_thinking: false` and always has, so every number above — and every row in
`results/history.jsonl` — describes the model with reasoning off, while a real
pi session runs with it on under `REASONING_BUDGET`. To measure what you
actually run, set `EVAL_THINKING=on` (in `.env` or on the command line). The mode
and any system prompt are recorded under `config` in `results/latest.json`, so
the two kinds of run can never be confused after the fact. Keep the default when
you want a score comparable to the committed history.

**The scorecard also measures the stack without headroom.** `eval.py` talks
straight to `forge:8081` and always will — the committed history is about the
model, not about a compressor in front of it. Use `./scripts/ab-headroom.sh` to
measure compression; it is a separate number and should stay one.

The eval produces:

| Artifact | Purpose |
| --- | --- |
| `results/latest.json` | Most recent scores (committed, displayed in README) |
| `results/history.jsonl` | Every run, append-only |
| `badges/eval.json` | Shield.io endpoint for dynamic eval badge |
| `badges/suite-*.json` | Per-suite dynamic badges |
