# instantcoffee

[![CI](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/coffeegrind123/instantcoffee/main/badges/ci.json)](https://github.com/coffeegrind123/instantcoffee/actions)

**A 27B coding model on one RTX 4090, and the plumbing that makes it usable.**

Qwen3.8-27B runs under llama.cpp, behind the forge guardrail proxy, driven by the
[pi](https://pi.dev) coding agent. Everything is pinned, every pin is recorded in
`versions.lock`, and one command updates the lot and rolls back if the smoke test
fails.

The interesting part is not that a 27B model fits in 24 GiB — it is what it takes
to make it *pleasant*. Speculative decoding so it types fast enough to wait for.
A 96K window that is actually 96K, proven by planting a nonce at each end of a
90,055-token document and getting both back. Tool calls that survive the round
trip. And a standing fight against everything that would spend your context
window before the model has read a single line of your code.

```
              pi  (scripts/pi-local.sh)
                  │
                  │  OpenAI chat-completions (POST /v1/chat/completions)
                  ▼
       ┌─────────────────────┐   forge proxy      :8081
       │  forge-guardrails   │   response validation, rescue parsing,
       │  (container)        │   retry-with-nudge, reasoning-replay policy
       └──────────┬──────────┘
                  │  OpenAI wire, tools forwarded verbatim
                  ▼
       ┌─────────────────────┐   llama-server     :8080
       │  llama.cpp (CUDA)    │   Qwen3.8-27B, --jinja native function
       │                      │   calling, 96K context
       └─────────────────────┘
                  │
              RTX 4090 / 24 GiB
```

pi talks to **8081** (forge). Nothing should talk to 8080 directly except forge —
that port is exposed only for debugging and metrics.

**This stack targets pi and nothing else.** Claude Code support was removed
(2026-08-12): it cost a launcher, an Anthropic-wire smoke test, a Harbor agent
subclass, an SDK dependency, and a set of `.env` keys, all to serve a client
whose fixed prompt-and-tool-schema overhead is the worst possible fit for a
single-user local window. forge still *serves* `/v1/messages`, so an Anthropic-shaped client
would work — it is simply not what anything here is tuned, measured, or
documented for.

## Requirements

- Docker Desktop with **GPU support enabled** (Settings → Resources → GPU)
- NVIDIA driver with CUDA support — verified here on driver `596.36`
- ~18 GB of disk for the `coding` model, another ~16 GB if you also want
  `prose` (which `uc-coding` shares, so no extra), ~5 GB for images
- `bash`, `curl`, and `docker` for the scripts (`python3` optional — the scripts fall
  back to a throwaway container when it is missing)
- `uv` only for one optional extra: MCP-as-a-CLI (`scripts/mcp.sh`). Nothing in
  the core stack needs it.

## Quick start

```bash
git clone --recurse-submodules <this repo> && cd instantcoffee

# Edit MODELS_DIR in .env first if D: is not where you want ~18 GB to land.
./scripts/setup.sh
```

`setup.sh` checks prerequisites, builds the forge image, downloads the GGUF, starts
both services, and then runs the end-to-end smoke test. It is idempotent — re-run it
any time.

Then start a session. pi works on your **current directory**, so `cd` to the
project you want it to work on and call the launcher by absolute path:

```bash
cd ~/my-project
~/instantcoffee/scripts/pi-local.sh
```

Add the alias once and you never type the path again:

```bash
echo "alias qpi='~/instantcoffee/scripts/pi-local.sh'" >> ~/.bashrc && . ~/.bashrc
cd ~/my-project && qpi
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `./scripts/up.sh` | Start the stack |
| `./scripts/down.sh` | Stop the stack |
| `./scripts/logs.sh llama` | Tail llama-server (watch the model load here) |
| `./scripts/smoke-test.sh` | Verify inference and tool calling end to end |
| `./scripts/mode.sh` | Show the active regime; `mode.sh prose --restart` switches |
| `./scripts/download-model.sh` | Fetch the GGUF (resumable; a no-op if it is already on disk) |
| `./scripts/update.sh` | Update llama.cpp and forge, restart, verify, roll back on failure |
| `./scripts/update.sh --check` | Report what is available without changing anything |
| `cd <project> && ~/instantcoffee/scripts/pi-local.sh` | Launch pi against the local model, scoped to that folder |
| `./scripts/pi-container.sh` | The same, in a container with its own home and the browser stack ([docs/container.md](docs/container.md)) |

That is the whole day-to-day surface. The three dozen measurement and tuning
commands — sweeps, capacity probes, perplexity-at-depth, VRAM floors, capture —
live in **[docs/benchmarking.md](docs/benchmarking.md)**, because burying
`up.sh` among them was making the common case hard to find.

## Three modes

`coding` is the default and runs the stock unsloth weights. `uc-coding` keeps
coding's exact sampler profile but swaps in a decensored build, for coding work
the stock model would deflect on. `prose` runs that same decensored model tuned
for fiction — DRY on, reasoning-language off. `uc-coding` and `prose` share one
GGUF, so `uc-coding` costs no extra disk once you have `prose`.

```bash
./scripts/mode.sh                 # what is active, and what each mode sets
./scripts/mode.sh --list          # coding, uc-coding, prose
./scripts/mode.sh uc-coding       # rewrite .env (nothing is live yet)
./scripts/download-model.sh       # the model has to be on disk first
docker compose up -d --force-recreate llama
```

Switching costs a 9–20 minute cold load, so it is a deliberate act rather than a
toggle — except between `uc-coding` and `prose`, which share a GGUF, so the
model stays put and only the samplers change. **`mode.sh` does not download the
model for you and does not check that it is present** — get the file first, or
you will tear down a working container for one that cannot start.

Which model each mode uses, why it was chosen, and every sampler value it sets:
**[docs/modes.md](docs/modes.md)**. The reasoning for the current decensored-model
pick over its runner-up — and why the model's own author-published GGUF is *not*
used — is in `modes/prose.env`, at length.

## Configuration

Everything is in `.env`, committed on purpose — there are no secrets in it and
the pins are the whole point. It is heavily commented; that file, not this one,
is the reference. For machine-local changes that should not be committed, put the
same keys in `.env.local` and the scripts will merge it on top.

The handful you are most likely to touch:

| Key | Default | Notes |
| --- | --- | --- |
| `MODELS_DIR` | `//d/llm-models` | **Must be a Windows-style path** on Docker Desktop |
| `CTX_SIZE` | `98304` | Context per slot, and forge's token budget. `DRY_PENALTY_LAST_N` must move with it |
| `REASONING_EFFORT` | `medium` | **New in 3.8, and it will bite you.** Upstream defaults to `xhigh`, which eats any budget you give it |
| `REASONING_BUDGET` | `4096` | Guard against a turn that thinks itself out of an answer. At a cap, `xhigh` has returned 12,582 reasoning chars and *zero* content |
| `PI_MAX_TOKENS` | `8192` | Keep `-n` in `LLAMA_EXTRA_FLAGS` equal to it |
| `BIND_ADDR` | `127.0.0.1` | `0.0.0.0` to expose on the LAN |

The full table — every speculative-decoding, KV-cache, forge and pi key — is in
`.env` itself with the measurements that justify each value.

## Updating

```bash
./scripts/update.sh
```

One command updates every pinned component:

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

`update.sh` does not bump rtk — `RTK_VERSION` in `.env` is moved by hand, because
raising it means re-measuring the allow-list. What it *does* do, in the same pass
that smoke-tests the stack, is run `./scripts/rtk.sh --check` and record the
answer in `versions.lock` as `rtk_filters`. A failure there warns rather than
rolls back: rtk breaking means bash output stops being compressed, not that
inference regressed, and tearing down a verified llama/forge update over it would
be the wrong trade.

## Where to read more

| Document | What is in it |
| --- | --- |
| [docs/modes.md](docs/modes.md) | The three regimes, their models, every sampler value |
| [docs/pi.md](docs/pi.md) | `/stack`, `/loop`, subagents, `/prinny`, `/persona`, how the provider config is generated, why pi |
| [docs/context-budget.md](docs/context-budget.md) | MCP without MCP, filtered bash output, the browser — the three big context consumers |
| [docs/reasoning.md](docs/reasoning.md) | `REASONING_EFFORT` in detail, and reasoning in another language |
| [docs/quants.md](docs/quants.md) | What fits in 24 GiB and what each step down costs |
| [docs/benchmarking.md](docs/benchmarking.md) | Verifying it works, every measurement command, capture |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms, in the order you are likely to hit them |
| [docs/container.md](docs/container.md) | Running pi in a container: `Dockerfile.pi`, the mount rules, moving an agent home |
| [docs/layout.md](docs/layout.md) | Every file and directory, and what it is for |
| [docs/changelog.md](docs/changelog.md) | What changed, and when |
| `versions.lock` | **The authority on what is pinned right now.** Not prose — the record of what was verified working |
| `context/design/decisions.md` | Why things are the way they are, dated, with the measurements |

## If it is not working

Start here, in this order:

1. `./scripts/logs.sh llama` — a 27B GGUF takes 9–20 minutes to read off disk on a
   cold start, and every request until it finishes fails with a 503 `Loading model`.
   Nothing is broken; it is loading.
2. `./scripts/smoke-test.sh` — end to end, including a real tool call.
3. **[docs/troubleshooting.md](docs/troubleshooting.md)** for everything else.
