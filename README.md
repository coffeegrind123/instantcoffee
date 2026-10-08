# instantcoffee

[![CI](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/coffeegrind123/instantcoffee/main/badges/ci.json)](https://github.com/coffeegrind123/instantcoffee/actions)

**Opus orchestrating, Haiku working, a Fable advisor thinking — on the hosted Anthropic API, and the plumbing that makes it usable.**

pi talks straight to `api.anthropic.com`. There is no local model, no proxy, and
no GPU. The session runs on `claude-opus-5-5` — launched as
`pi --provider anthropic --model …` — every subagent it spawns runs on
`claude-haiku-5-5`, and the advisor, the one seat that is only ever asked to
plan, runs on `claude-fable-5-1`.

What makes it *pleasant* is what the local-model branch paid for and kept: the
session streamed to a dashboard, bash output filtered before the model reads it,
MCP tools reachable without loading their schemas, a browser the model can
drive, a Matrix channel, a persona system, a compaction guard, an unattended
loop, and in-process subagents. One thing this branch adds because the local one
never needed it: **prompt caching as a first-class feature**, with the cache
tier, its retention, and the warming policy all set by the launcher and reported
back to `/session` and the dashboard.

The interesting part is not that three seats beat one. It is what the seats
force you to be explicit about. The advisor is not a different *kind* of seat —
it is the same `Agent` tool, told to plan — so on a single-model stack nothing
would stop it inheriting the session default, and that inheritance is the bill
nobody chose. The per-type override in
`vendor/pi-subagents-lite/src/models/model-precedence.ts` sits **above** the
session default on purpose, and the launcher writes it as one entry keyed by
agent type, so the advisor cannot be dragged onto the orchestrator's price.

```
                pi  (scripts/pi-local.sh)
                    │
                    │  Anthropic Messages API (POST /v1/messages, x-api-key)
                    ▼
            api.anthropic.com
              ├── claude-opus-5-5    the session — plans, briefs, verifies
              ├── claude-haiku-5-5   every subagent — reads, implements
              └── claude-fable-5-1   the advisor — a per-agent-type override

       ┌─────────────────────┐   observe dashboard :4981
       │  instantcoffee-     │   every pi session event (from the observe
       │  observe            │   extension). Its llama /metrics and forge
       └─────────────────────┘   /usage pollers are gone: there is nothing
                                 on the compose network left to poll.
```

pi talks to Anthropic over HTTPS; the dashboard is a local service in
`docker-compose.yml`, and it is the only Docker in the stack. It used to poll
llama's `/metrics` and forge's `/forge/usage` — the only place decode speed and
draft acceptance were visible — and that path went with the local model. What is
left is the session's own events, and the model's own cache accounting.

**This stack targets pi and nothing else.** Claude Code support was removed
(2026-08-12): it cost a launcher, an Anthropic-wire smoke test, a Harbor agent
subclass, an SDK dependency, and a set of `.env` keys. What changed on this
branch is only *which endpoint pi points at*, and the three seats. `forge` is
gone with it: the guardrail proxy existed to hold a local llama.cpp server to a
wire shape it kept losing, and there is no longer a local server to hold. The
`CLAUDE_*` assertion that used to live in CI went with the keys; the eval-harness
assertion stayed, because that harness is still absent.

## Requirements

- `docker` with Compose — for the observe dashboard, and nothing else. It no
  longer needs GPU support, because the model runs at Anthropic.
- `bash` and `curl`.
- An **Anthropic API key**. It does not live in `.env` — see *Secrets* below.
- `python3` — the launcher writes pi's `models.json` and `settings.json` with it.
- `node` and `npm` — to install and update pi itself, and to run the container
  wrapper and the extension suites.
- `uv` only for one optional extra: MCP-as-a-CLI (`scripts/mcp.sh`). Nothing in
  the core stack needs it.

The 24 GiB VRAM floor, the NVIDIA driver, the ~18 GB of model weights, and the
9–20 minute cold load all went with the local model. A session is ready when the
network is.

### Secrets

`.env` is committed on purpose — there are no secrets in it, and the seat ids
are the whole point. The key lives in the gitignored `.env.local` and is only
ever exported into the launcher's process. It is never written to `models.json`
(which references `$ANTHROPIC_API_KEY`) and never to `auth.json`.

```bash
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' >> .env.local
```

The launcher refuses to start without it rather than launching a session that
cannot reach the model.

## Quick start

```bash
git clone --recurse-submodules <this repo> && cd instantcoffee

# 1. The key — the one thing you must supply.
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' >> .env.local

# 2. The dashboard. Optional, but it is where cacheRead/cacheWrite surface.
docker compose up -d
```

`docker compose up -d` builds the observe image from the `vendor` submodule and
publishes http://127.0.0.1:4981. It is the only service; there is no llama or
forge to bring up behind it.

Then start a session. pi works on your **current directory**, so `cd` to the
project you want it to work on and call the launcher by absolute path:

```bash
cd ~/my-project
~/instantcoffee/scripts/pi-local.sh
```

Add the alias once and you never type the path again:

```bash
echo "alias cpi='~/instantcoffee/scripts/pi-local.sh'" >> ~/.bashrc && . ~/.bashrc
cd ~/my-project && cpi
```

**The first thing after the key is a catalog refresh.** `PI_UPDATE_MODELS_ON_LAUNCH`
defaults on and runs `pi update --models` (fails soft) before launching, because
the catalog bundled with an installed pi lags the published one: pi 0.85.1 ships
none of `claude-opus-5-5`, `claude-haiku-5-5` or `claude-sonnet-5-5` — the
anthropic provider lists 14 models before a refresh and 17 after. pi hides a
provider whose models have no usable credentials, and an id the catalog does not
know is how a seat silently ends up on the parent's model, which is the one
failure this branch exists to prevent. The orchestrator's probe refuses a seat it
still cannot list, and names the fix: `pi update --models`.

## Everyday commands

| Command | What it does |
| --- | --- |
| `cd <project> && ~/instantcoffee/scripts/pi-local.sh` | Launch pi against the hosted API, scoped to that folder |
| `./scripts/pi-container.sh` | The same, in a container with its own home and the browser stack ([docs/container.md](docs/container.md)) |
| `docker compose up -d` | Start the observe dashboard (http://127.0.0.1:4981) |
| `docker compose logs -f observe` | Tail the dashboard |
| `./scripts/browser.sh status` | Is the browser up, and what page is open |
| `./scripts/browser.sh health` | Probe Chrome itself (exit 2 = wedged) |
| `./scripts/mcp.sh --servers` | List MCP servers reachable as a CLI |
| `./scripts/rtk.sh --install` | One-time: install the pinned rtk that filters bash output |
| `./scripts/rtk.sh --check` | Do rtk's filters still behave the way the allow-list assumes |

That is the whole day-to-day surface. There is no `up.sh`/`down.sh`/`logs.sh`
because there is no inference stack to start — the model is a URL. What is left
is the client, the dashboard, and three wrappers around local services the model
reaches for. The measurement and tuning commands the local branch needed —
sweeps, capacity probes, perplexity-at-depth, capture — are gone with the
hardware they measured; what verifies this branch is
**[docs/benchmarking.md](docs/benchmarking.md)**.

## Three seats, and the seats are the design

One model per role, and the roles are the whole design. A frontier model could
run everything itself; it is split because the orchestrator's window is the
scarce resource, and because the three jobs have three different right answers
for cost.

| seat | model | who it is | configured by |
| --- | --- | --- | --- |
| the session | `claude-opus-5-5` | plans, briefs, verifies, keeps the board | `ANTHROPIC_MODEL` in `.env` |
| every subagent | `claude-haiku-5-5` | reads, implements, runs the acceptance commands | `SUBAGENT_MODEL=anthropic/claude-haiku-5-5` |
| the advisor | `claude-fable-5-1` | turns one goal into one ordered, briefable plan — read-only | `ADVISOR_MODEL=anthropic/claude-fable-5-1` |

Turn orchestrator mode on, and the launcher writes the three into pi's agent
dir — `SUBAGENT_MODEL` as the SESSION default that every child inherits, and
`ADVISOR_MODEL` as a per-agent-type `overrides.advisor` entry that beats it:

```bash
ORCHESTRATOR=1 ./scripts/pi-local.sh
# pi -> https://api.anthropic.com  (model: claude-opus-5-5,
#   subagents: claude-haiku-5-5, advisor: claude-fable-5-1, cache: idle/long,
#   orchestrator (15x anthropic/claude-haiku-5-5, advisor anthropic/claude-fable-5-1, depth 2))
```

Those values land in pi's agent directory as `orchestrator-mode.json`, which the
subagent fork reads as its SESSION layer — above every config file — so a "clear" in
`/agents` returns to the three seats rather than dropping the children onto the
orchestrator's model. Agent types `worker`, `explorer` and `advisor` come from
`prompts/orchestrator/agents/` and are seeded above the operator's global agents
and below a project's own. Up to `SUBAGENT_MAX_CONCURRENT` children (15) run at
once, `SUBAGENT_MAX_DEPTH=2` lets a worker or explorer split its own item, and
helpers get no spawn tool at all.

Why a separate *advisor* model and not a fourth kind of worker: the plan is the
one artifact every brief depends on, and getting it wrong is the most expensive
mistake in the loop. So it gets the strongest reasoner, it is consulted only when
there is something real to decide, and it is read-only — it can never implement
the plan it wrote. A file read an explorer can do never goes to the advisor.

Full account, including what the launcher refuses and what each seat costs:
**[docs/orchestrator.md](docs/orchestrator.md)**.

## Prompt caching

On the local branch, "prompt caching" was a pile of llama.cpp flags
(`--cache-prompt`, KV persisted to disk, checkpoints) because there was no
`cache_control` on the OpenAI wire. On the Anthropic wire it is a real API
feature, and the launcher sets it three ways:

- **`models.json`** — `providers.anthropic.apiKey = "$ANTHROPIC_API_KEY"` plus a
  `modelOverrides.<id>.promptCache = {short: 300, long: 3600}` for each of the
  three seats. pi only *warms* an idle prompt cache for a model that declares a
  lifetime, so this block is the switch the whole story hangs off.
- **`settings.json`** — `cacheWarming` (from `PI_CACHE_WARMING`, default `idle`)
  and `showCacheMissNotices`. `idle` also warms between runs, which is what a
  session with long gaps between turns actually needs; `streaming` warms only
  during a run.
- **`PI_CACHE_RETENTION=long`** is exported, which is what makes pi's Anthropic
  serializer emit `cache_control: {type: "ephemeral", ttl: "1h"}` instead of the
  5-minute default.

The tiers are Anthropic's own — 5 minutes short, 1 hour long — not ours to
invent; `PI_CACHE_SHORT_SECONDS` and `PI_CACHE_LONG_SECONDS` name them. pi's
usage model reports `cacheRead` / `cacheWrite` / `cacheWrite1h`, and both
`/session` and the observe dashboard surface them, so a cache that is being
thrown away is visible rather than a silent line on a bill.

That matters for a long orchestrated session specifically. A subagent reuses the
prefix it was spawned with only if the cache is still warm when it runs, and a
wide fan-out is exactly when turns land close enough together for the 5-minute
tier to help and far enough apart that the 1-hour tier is what saves you. Paying
for cache *writes* only makes sense if you can see when they are wasted, which is
why the miss notices are on by default.

## Configuration

Everything is in `.env`, committed on purpose — there are no secrets in it and
the seat ids are the whole point. It is heavily commented; that file, not this
one, is the reference. For machine-local changes that should not be committed,
put the same keys in `.env.local` and the launcher will read it on top.

The handful you are most likely to touch:

| Key | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | The orchestrator's model, passed as `--model` |
| `SUBAGENT_MODEL` | `anthropic/claude-haiku-5-5` | `provider/model-id`, the session default every child inherits |
| `ADVISOR_MODEL` | `anthropic/claude-fable-5-1` | The per-agent-type override that beats the session default |
| `PI_CACHE_WARMING` | `idle` | `streaming` warms only during a run; `idle` also warms between runs |
| `PI_CACHE_RETENTION` | `long` | Selects the 1-hour tier over the 5-minute default |
| `PI_UPDATE_MODELS_ON_LAUNCH` | `1` | Refresh pi's catalog before launching (fails soft) |
| `PI_CONTEXT_WINDOW` | `1000000` | Sizes pi's compaction; a floor, not a model lookup |
| `BIND_ADDR` | `127.0.0.1` | `0.0.0.0` to expose the dashboard on the LAN |

The full table — every cache, browser, MCP, rtk and orchestrator key — is in
`.env` itself with the reasoning that justifies each value.

## Where to read more

| Document | What is in it |
| --- | --- |
| [docs/orchestrator.md](docs/orchestrator.md) | opus orchestrating, haiku children, the fable advisor, and why the per-type override exists |
| [docs/pi.md](docs/pi.md) | `/loop`, subagents, `/prinny`, `/persona`, how the provider config is generated, why pi |
| [docs/context-budget.md](docs/context-budget.md) | MCP without MCP, filtered bash output, the browser — the three big context consumers |
| [docs/reasoning.md](docs/reasoning.md) | Thinking on the Anthropic path, and what happened to `REASONING_EFFORT` and `THINK_LANG` |
| [docs/benchmarking.md](docs/benchmarking.md) | What verifies this branch, and every suite CI runs without a model |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms, in the order you are likely to hit them |
| [docs/container.md](docs/container.md) | Running pi in a container: `Dockerfile.pi`, the mount rules, moving an agent home |
| [docs/layout.md](docs/layout.md) | Every file and directory, and what it is for |
| [docs/changelog.md](docs/changelog.md) | What changed, and when |
| `versions.lock` | **The authority on what is pinned right now.** On this branch that is the observe submodule and rtk — the local-model pins are gone with the layer that served them |
| `context/design/decisions.md` | Why things are the way they are, dated, with the measurements |

## If it is not working

Start here, in this order:

1. **`pi --list-models | grep anthropic`** — if a seat's model is missing, the
   catalog is stale. `pi update --models` is the fix; the launcher runs it on
   every start unless `PI_UPDATE_MODELS_ON_LAUNCH=0`.
2. **The key.** `ANTHROPIC_API_KEY` in `.env.local` (or exported). The launcher
   refuses to start without it, and pi hides a provider whose models have no
   usable credentials.
3. **[docs/troubleshooting.md](docs/troubleshooting.md)** for everything else.
