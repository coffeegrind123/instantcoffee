# qwen3.6-forge

[![CI](https://img.shields.io/badge/ci-passing-brightgreen?logo=githubactions&style=flat)](https://github.com/coffeegrind123/qwen3.6-forge/actions)
[![Eval](https://img.shields.io/badge/eval-run%20locally-lightgrey?logo=pytest&style=flat)](#eval-results)

Reproducible Docker Compose stack running **Qwen3.6-27B** on a single **RTX 4090**,
behind the **forge** guardrail proxy.

Two interchangeable backends. `COMPOSE_PROFILES` in `.env` picks one:

| Profile | Engine | Weights | Why |
| --- | --- | --- | --- |
| **`ik`** (default) | ik_llama.cpp (Thireus fork) | recipe-built, 5.1 bpw / 15 GB | Per-tensor quantization optimised for perplexity — smaller *and* more precise than a 4-bit single file, which frees VRAM for context |
| `mainline` | upstream llama.cpp | unsloth GGUF (incl. MTP) | Simpler, one file, and the only one that can do MTP speculative decoding |

They are **not** mixable: Thireus recipes use ik-only quant types (`iq4_ks`,
`iq5_ks`, `iq6_k`) that mainline cannot read, and MTP is a mainline feature.
Engine and weights are a matched pair.

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
       │  ik_llama.cpp  OR   │   Qwen3.6-27B, --jinja native function
       │  llama.cpp (CUDA)   │   calling, 64K context
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

# Edit MODELS_DIR in .env first if D: is not where you want ~15 GB to land.
./scripts/setup.sh
```

`setup.sh` checks prerequisites, builds the forge image, downloads the GGUF, starts
both services, and then runs the end-to-end smoke test. It is idempotent — re-run it
any time.

Then point Claude Code at it:

```bash
./scripts/claude-local.sh
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
| `./scripts/claude-local.sh` | Launch Claude Code against the local model, primed for it |
| `./scripts/pi-local.sh` | Launch the pi coding agent against the local model |
| `./scripts/download-ik-model.sh` | Fetch the recipe model for the `ik` backend (852 shards, resumable) |
| `./scripts/download-model.sh` | Fetch the single-file GGUF for the `mainline` backend |

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
| `CTX_SIZE` | `65536` | Context per slot; also what forge uses as its token budget |
| `REASONING_BUDGET` | `4096` | `-1` unrestricted, `0` disables thinking, `N` caps it |
| `FLASH_ATTN` | `on` | Recent llama.cpp requires a **value** here (`on`/`off`/`auto`) |
| `LLAMA_EXTRA_FLAGS` | `-ctk f16 -ctv q8_0` | K-f16/V-q8 KV cache — f16 K prevents broken JSON tool calls |
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

## Choosing a quant for 24 GiB

The 4090 has 24.0 GiB. Qwen3.6-27B is a hybrid: only **16 of its 64 layers** use full
attention (the other 48 are Gated DeltaNet, whose recurrent state does not grow with
context). That makes its KV cache far smaller than a normal 27B — about **64 KiB per
token at f16 K, ~34 KiB per token at q8_0 V**.

| GGUF | Weights | @64K (default) | @128K | Verdict on ~22.4 GiB |
| --- | --- | --- | --- | --- |
| `IQ4_XS` | 14.4 GiB | ~19.2 | ~21.4 | Most headroom, lowest quality of the 4-bits |
| `Q4_K_M` | 15.7 GiB | ~20.5 | ~22.7 | Tight at 128K |
| **`UD-Q4_K_XL`** | **16.4 GiB** | **~21.2** | — | **Default — best quality that still fits** |
| `Q5_K_M` | 18.2 GiB | — | — | Does not fit at this context |
| `Q6_K` | 21.0 GiB | — | — | Does not fit |

Columns assume the default `f16` K / `q8_0` V cache per the HN thread consensus
(K quantisation breaks JSON on tool calls). Drop `LLAMA_EXTRA_FLAGS` to go back to
an f16 K/f16 V cache and the 64K column gains about 2 GiB.

Totals include ~1.3 GiB of CUDA context and compute buffers. Note that the card is
never entirely yours: measured on this machine, llama.cpp saw **22992 MiB free** of
24563 MiB with an ordinary Windows desktop running, so budget against ~22.4 GiB
rather than 24. Check yours with:

```bash
docker compose run --rm --no-deps llama --list-devices
```

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

### The primed launcher

`claude-code-env.sh` only redirects the API. `claude-local.sh` also trims what Claude
Code *sends*, which is what actually matters on a 64K local window:

```bash
./scripts/claude-local.sh              # start a primed session
./scripts/claude-local.sh -c           # any claude flag passes through
./scripts/claude-local.sh --print-only # show the exact command without running it
```

| What it sets | Why |
| --- | --- |
| `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | Ignores every MCP server. The single biggest context win — one server can publish hundreds of tool schemas that load before your first message. Set `CLAUDE_DISABLE_MCP=0` to keep them. |
| `MAX_THINKING_TOKENS=0` | Cosmetic, not a saving. forge forwards an allow-list to the backend and `thinking` is not on it, so the field is dropped and never reaches llama-server — it costs no model context either way. This just stops the client asking for something the backend cannot honor. **To change how much Qwen actually thinks, set `REASONING_BUDGET` in `.env`.** |
| `DISABLE_PROMPT_CACHING=1` | `cache_control` is dropped in translation anyway; this stops Claude Code building cache blocks that go nowhere. |
| `API_TIMEOUT_MS=1800000` | Must outlast forge's own `--backend-timeout` (600s), or the client gives up on a request the server is still working on. |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` | Subagents nest 3 deep by default. Each level is another full context on one GPU serving one slot. |
| `ANTHROPIC_*_MODEL` | One model fills every role, including the small/fast one. |

### If you have a `claude` shell alias

**Bash expands aliases only in interactive shells**, so an alias in `.bash_aliases`
has *no effect* from inside these scripts. `claude-local.sh` would otherwise launch
the bare binary and silently drop your usual flags. Replay them from `.env` instead:

```
CLAUDE_EXTRA_ARGS=--permission-mode bypassPermissions
CLAUDE_SYSTEM_PROMPT_FILE=~/claude-prompt.txt
```

`--print-only` shows exactly what will run, so you can confirm your flags survived.

Sourcing `claude-code-env.sh` and then typing `claude` is the other way round: that
*is* an interactive shell, so your alias applies normally and only the API is
redirected.

### One-liner

If you would rather add another alias next to your existing ones:

```bash
alias flaude='ANTHROPIC_BASE_URL=http://localhost:8081 ANTHROPIC_AUTH_TOKEN=local ANTHROPIC_MODEL=qwen3.6-27b ANTHROPIC_SMALL_FAST_MODEL=qwen3.6-27b ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.6-27b DISABLE_PROMPT_CACHING=1 MAX_THINKING_TOKENS=0 API_TIMEOUT_MS=1800000 CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ~/.local/bin/claude --strict-mcp-config --mcp-config "{\"mcpServers\":{}}" --model qwen3.6-27b --permission-mode bypassPermissions --append-system-prompt "$(cat ~/claude-prompt.txt)"'
```

Use `host.docker.internal` instead of `localhost` if you run Claude Code inside a
container. Note this calls `~/.local/bin/claude` directly, so it does not recurse
through your existing `claude` alias.

## Using it with pi (pi.dev)

```bash
./scripts/pi-local.sh                 # start a session
./scripts/pi-local.sh --install-only  # just write the provider config
./scripts/pi-local.sh -p "summarize"  # any pi flag passes through
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
  `thinking` for no gain.
- **`apiKey: "local"`** — pi hides models it considers unauthenticated, so even a
  keyless local server needs a placeholder.
- **`compat` both false** — llama.cpp's chat templates don't know the `developer`
  role, and `reasoning_effort` is an OpenAI-ism it doesn't implement. pi's own
  docs flag this for exactly this class of server.
- **`maxTokens` well under `contextWindow`** — with `--no-context-shift` an
  overflowing request fails loudly, and an agent loop's prompt grows every turn.
- **`baseUrl` host** — the script uses `host.docker.internal` when it detects it
  is running inside a container, `localhost` otherwise.

**Not using pi's `/llama` integration.** pi can manage its own llama.cpp router
and models. That would bypass forge completely and lose every guardrail this
repo exists to provide, so the model is registered as a plain custom provider
instead.

pi is minimal by design — no MCP, no sub-agents — so it needs far less trimming
than Claude Code. The one flag that matters is `-nc`, which the script passes:
it skips `AGENTS.md`/`CLAUDE.md` discovery, and pi walks parent directories
looking for those. On a 64K window they are a real fraction of the budget. Drop
`-nc` from the script when you do want project conventions loaded.

### What does not survive the trip

forge translates Anthropic requests to OpenAI for llama.cpp, and Anthropic-only
fields have no analog on the other side:

- **`cache_control` is dropped** — Anthropic-style prompt caching has no OpenAI
  analog. The stack compensates three ways: (1) `preserve_thinking` avoids KV
  re-prefill across turns, (2) `--cache-prompt` + `--slot-save-path` persist the
  KV cache to disk so warm restarts skip re-prefill entirely, and (3)
  `--ctx-checkpoints` enable fast rewind for agentic loops without recomputing
  from scratch. See `.env` for `CACHE_RAM`, `CACHE_REUSE`, and related knobs.
- **`thinking` is dropped in both directions.** The request field is not on forge's
  forward allow-list, so Claude Code's thinking settings have no effect on the model;
  and forge does not synthesize signed Anthropic thinking blocks on the way back.
  Qwen still reasons under `--reasoning-budget 4096` — that is the only control, and
  it lives in `.env` as `REASONING_BUDGET`.
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
`LLAMA_EXTRA_FLAGS=-ctk f16 -ctv q8_0`.

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
.env.local.example      machine-local override template (copy to .env.local)
versions.lock           what update.sh last verified (generated)
docker-compose.yml      llama + forge, plus tools-profile one-shots
Dockerfile.forge        forge proxy image, pinned to FORGE_VERSION
Dockerfile.ikllama      ik_llama.cpp image (recipe weights, CUDA)
.github/workflows/ci.yml  CI pipeline (lint, build, verify)
badges/                 shield.io endpoint JSON for dynamic badges
results/
  latest.json           most recent eval run (committed, displayed in README)
  history.jsonl         append-only log of all eval runs
configs/
  opencode-provider.json  drop-in OpenCode provider config pointing at forge
scripts/
  setup.sh              prerequisites -> model -> build -> up -> verify
  update.sh             update everything, verify, roll back on failure
  up.sh / down.sh       start / stop the stack
  smoke_test.py         end-to-end checks (runs inside the compose network)
  eval.py               9-suite coding eval (speed, codegen, bugfix, tools…)
  eval_harness.py       extended coding eval with judge-based scoring
  run-eval.sh           run eval, save results, regenerate badge + README
  gen-readme-scorecard.py  update README scorecard from results/latest.json
  test_repeat_detector.py  standalone unit tests for the loop detector
  bench.sh              prompt processing + generation speed benchmark
  slot-cache.sh         save/restore KV cache for warm restarts
  download_model.py     resumable GGUF fetch
  download-ik-model.sh  fetch recipe model shards for the ik backend
  claude-local.sh       launch Claude Code primed for the local model
  pi-local.sh           launch the pi coding agent against forge
  claude-code-env.sh    source this to redirect the API only
context/design/         why things are the way they are
```

## Eval Results

<!-- eval-scorecard-start -->

![Eval](https://img.shields.io/badge/eval-9%%20(3%2F23)-red?logo=pytest&style=flat)

**Latest eval:** 9% — 3/23 tests pass (floor: 0.5)

> **Note:** These results are from a **Qwen3-0.6B placeholder** — a 594 MB model used to
> validate the eval pipeline end-to-end. It is 45× smaller than the actual Qwen3.6-27B
> target and cannot perform meaningful coding, tool calling, or reasoning. The important
> result: all 9 suites and 23 tests executed with no infra failures. Run
> `./scripts/run-eval.sh` with the real 27B model loaded to get representative scores.

| Suite | Score | Passed | Bar |
| --- | --- | --- | --- |
| bugfix | [░░░░░░░░░░░░░░░░░░░░] 0.00 | 0/3 | ![](https://img.shields.io/badge/bugfix-0%-red?style=flat-square) |
| codegen | [░░░░░░░░░░░░░░░░░░░░] 0.00 | 0/5 | ![](https://img.shields.io/badge/codegen-0%-red?style=flat-square) |
| edits | [░░░░░░░░░░░░░░░░░░░░] 0.00 | 0/4 | ![](https://img.shields.io/badge/edits-0%-red?style=flat-square) |
| multiturn | [██████░░░░░░░░░░░░░░] 0.33 | 1/3 | ![](https://img.shields.io/badge/multiturn-33%-orange?style=flat-square) |
| reasoning | [██████░░░░░░░░░░░░░░] 0.33 | 1/3 | ![](https://img.shields.io/badge/reasoning-33%-orange?style=flat-square) |
| refactor | [░░░░░░░░░░░░░░░░░░░░] 0.00 | 0/1 | ![](https://img.shields.io/badge/refactor-0%-red?style=flat-square) |
| review | [░░░░░░░░░░░░░░░░░░░░] 0.00 | 0/1 | ![](https://img.shields.io/badge/review-0%-red?style=flat-square) |
| speed | [░░░░░░░░░░░░░░░░░░░░] 0.00 | 1/1 | ![](https://img.shields.io/badge/speed-0%-red?style=flat-square) |
| tools | [░░░░░░░░░░░░░░░░░░░░] 0.00 | 0/2 | ![](https://img.shields.io/badge/tools-0%-red?style=flat-square) |


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
docker compose --profile tools config     # validate compose
```

The eval produces:

| Artifact | Purpose |
| --- | --- |
| `results/latest.json` | Most recent scores (committed, displayed in README) |
| `results/history.jsonl` | Every run, append-only |
| `badges/eval.json` | Shield.io endpoint for dynamic eval badge |
| `badges/suite-*.json` | Per-suite dynamic badges |
