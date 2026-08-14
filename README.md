# qwen3.6-forge

[![CI](https://img.shields.io/badge/ci-passing-brightgreen?logo=githubactions&style=flat)](https://github.com/coffeegrind123/qwen3.6-forge/actions)
[![Eval](https://img.shields.io/badge/eval-91%25%20(27%2F27)-brightgreen?logo=pytest&style=flat)](#eval-results)

Reproducible Docker Compose stack running **Qwen3.6-27B** on a single **RTX 4090**,
behind the **forge** guardrail proxy, driven by the **pi** coding agent. One
backend: upstream **llama.cpp** with a single-file MTP GGUF (speculative
decoding, mmap-friendly).

Two switchable regimes — `coding` on the unsloth weights, `prose` on a
decensored Fable-Fusion merge — via `./scripts/mode.sh` or `/stack mode` inside
pi. The scorecard below is `coding`.

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
       │  llama.cpp (CUDA)    │   Qwen3.6-27B, --jinja native function
       │                      │   calling, 32K context
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
32K local window. forge still *serves* `/v1/messages`, so an Anthropic-shaped client
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

Then start a session. pi works on your **current directory**, so `cd` to the
project you want it to work on and call the launcher by absolute path:

```bash
cd ~/my-project
~/qwen3.6-forge/scripts/pi-local.sh
```

Add the alias once and you never type the path again:

```bash
echo "alias qpi='~/qwen3.6-forge/scripts/pi-local.sh'" >> ~/.bashrc && . ~/.bashrc
cd ~/my-project && qpi
```

## Day-to-day

| Command | What it does |
| --- | --- |
| `./scripts/up.sh` | Start the stack |
| `./scripts/down.sh` | Stop the stack |
| `./scripts/logs.sh llama` | Tail llama-server (watch the model load here) |
| `./scripts/smoke-test.sh` | Verify inference and tool calling end to end |
| `./scripts/update.sh` | Update llama.cpp and forge, restart, verify, roll back on failure |
| `./scripts/update.sh --check` | Report what is available without changing anything |
| `cd <project> && ~/qwen3.6-forge/scripts/pi-local.sh` | Launch pi against the local model, scoped to that folder |
| `./scripts/download-model.sh` | Fetch the GGUF (resumable; a no-op if it is already on disk) |
| `./scripts/mode.sh` | Show the active regime; `mode.sh prose --restart` switches |
| `./scripts/ab-think-lang.sh` | A/B the `THINK_LANG` prompt before trusting it |
| `./scripts/mcp.sh --servers` | List MCP servers reachable as a CLI |
| `cd vendor/pi-loop-mode && npm test` | Test the vendored `/loop` fork (23 tests, no install) |
| `cd vendor/prinny-channel && npm test` | Test the Matrix channel (227 tests, no install) |

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

## Configuration

Everything lives in `.env`, which is committed on purpose (no secrets in it — the
pins are the whole point). For machine-local changes that should not be committed,
create `.env.local` with the same keys; the scripts merge it on top.

The keys worth knowing:

| Key | Default | Notes |
| --- | --- | --- |
| `MODELS_DIR` | `//d/llm-models` | **Must be a Windows-style path** — see the bind-mount trap below |
| `GGUF_FILE` | set by the active mode | `coding` uses `Qwen3.6-27B-UD-Q4_K_XL.gguf`; `prose` the Fable-Fusion IQ4_XS. See the VRAM table |
| `CTX_SIZE` | `32768` | Context per slot; also what forge uses as its token budget. Capped by the f16 KV cache — see below |
| `REASONING_BUDGET` | `4096` | `-1` unrestricted, `0` disables thinking, `N` caps it |
| `THINK_LANG` | set by the active mode | Reason in Mandarin, answer in English. `zh` in `coding`, `off` in `prose`. Unmeasured on this hardware — see below |
| `FLASH_ATTN` | `on` | Recent llama.cpp requires a **value** here (`on`/`off`/`auto`) |
| `LLAMA_EXTRA_FLAGS` | `-n 8192 --load-mode none` | `--load-mode none` disables mmap (mandatory on a 9p bind mount); `-n` is the server-side generation cap. **No KV quantization** — see below |
| `CACHE_PROMPT` | `1` | Persist KV cache to disk for fast warm restarts |
| `CACHE_RAM` | `2048` | RAM budget for prompt cache in MiB; 0 disables. **This is HOST RAM, not VRAM.** It was 8192, which was the single largest avoidable memory consumer on this box and collapsed prefill to 2.83 tok/s once the host started swapping |
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
| `PI_CONTEXT_FILES` | `1` | Loads the project's `AGENTS.md`/`CLAUDE.md`; `0` passes `-nc` |
| `PI_EXTRA_ARGS` | *(empty)* | Flags your own `pi` alias would add — aliases do not expand in scripts |
| `PI_AUTO_UPDATE` | `1` | Keep pi on the latest npm release; fails soft |
| `PI_UPDATE_INTERVAL_H` | `24` | Hours between update checks |
| `MCP2CLI_ENABLED` | `1` | Loads the `mcp-tools` skill so pi can call MCP servers as a CLI. `0` disables |
| `MCP2CLI_VERSION` | `3.3.1` | mcp2cli release |
| `MCP_SDK_VERSION` | `1.29.0` | MCP Python SDK pin — must stay `<2`, see below |

## Creative writing, and what is *not* in the way

Nothing in this stack filters content. That was checked rather than assumed, on
2026-08-13:

| Layer | Finding |
| --- | --- |
| forge | No content filtering. Its `guardrails/` are tool-call plumbing — response validation, retry nudges, step enforcement. Removing them breaks tool calling and unlocks nothing. |
| pi | Its system prompt is mechanical: tool list, "show file paths", "be concise", cwd. **Zero** safety, refusal, or content language. `--system-prompt` replaces it wholesale anyway. |
| chat template | No refusal text, no injected default system prompt. |
| llama.cpp | No such feature exists. |

So if an uncensored model is behaving timidly here, the cause is configuration,
not a filter. Four things constrain output, and **`prose` mode already fixes the
first three** — they are listed so the reasoning is inspectable, not as a to-do:

1. **A sampler profile tuned for code.** `TEMPERATURE=0.6` is Qwen's "precise
   coding" preset, and XTC/DRY ship disabled. `prose` moves to 1.0 with DRY on.
2. **The MTP quant caps your sampling range.** DavidAU's card asks for
   `temp <= 1` and `repeat pen 1.0` on MTP quants, then separately recommends
   `repeat pen 1.1-1.15` for chat/roleplay and regular GGUFs "for creative/
   complex and/or temps over 1". Those conflict, and the card resolves it: use
   a non-MTP quant if you want to go above temp 1. `prose` sits at exactly 1.0,
   which is the highest the MTP quant tolerates.
3. **`THINK_LANG=zh`** appends a page of instructions about reasoning language,
   verbatim tool arguments and code identifiers. Not a filter, but dead weight
   in a fiction session. `prose` sets it `off`.
4. **pi loads the project's `AGENTS.md`/`CLAUDE.md` by default** — in a code
   repo that injects coding conventions into a writing session. This one is
   per-session, not per-mode: pass `-nc`, or `PI_CONTEXT_FILES=0`.

For a writing session, drop pi's coding tools too — it is an agent, and will
otherwise reach for `read`/`bash`/`edit`/`write`:

```bash
qpi -nt -nc --system-prompt "You are a literary fiction writer. Return only prose."
```

### Two modes

The stack ships two regimes. A mode is just a file of `KEY=VALUE` lines in
`modes/`; adding one means adding a file.

```bash
./scripts/mode.sh                    # which preset .env matches, and what differs
./scripts/mode.sh --list
./scripts/mode.sh prose              # rewrite .env
./scripts/mode.sh prose --restart    # ...and recreate llama
```

From inside pi, the same thing — the extension shells out to that script rather
than carrying a second definition of what "prose mode" means:

```
/stack mode                 # status
/stack mode prose           # switch, then offer the restart it needs
```

| | `coding` | `prose` |
| --- | --- | --- |
| model | unsloth `UD-Q4_K_XL` | Fable-Fusion `IQ4_XS` (decensored) |
| temperature | 0.6 | 1.0 |
| DRY | off | 0.8 |
| `THINK_LANG` | zh | off |

`coding` is the regime the committed **0.913 / 27-27** scorecard was measured in
— Qwen's published "precise coding" preset with every creative sampler at
llama.cpp's disabled value. `prose` follows the Fable-Fusion card first and
Qwen's general preset where that card is silent.

**The one substitution, called out because it is not a card value:** the card
asks for `smoothing_factor 1.5`, which is a KoboldCpp sampler llama.cpp does not
implement, and offers `repeat pen 1.1-1.15` as the fallback — which the *same
card* forbids on MTP quants. DRY penalises repeated sequences rather than
repeated tokens, so it buys the same thing without touching rep pen. Set
`DRY_MULTIPLIER=0.0` for pure card values.

Note the temperature ceiling: the card caps MTP quants at `temp <= 1`. To go
above that, switch to a regular (non-MTP) GGUF from the same repo.

> **`max_tokens` bites in prose mode.** This is a thinking model with
> `REASONING_BUDGET=4096`, so a request must leave room for the thinking block
> *and* the prose. Measured: a "150 word noir scene" used 4212 chars of
> reasoning and returned 913 chars of story — 1286 completion tokens. Ask for
> `max_tokens=400` and you get an **empty** `content` and
> `finish_reason=length`, because llama's `--reasoning-format deepseek` puts the
> thinking in `reasoning_content` where a naive client never looks. Keep
> `max_tokens` well above the reasoning budget, or set `REASONING_BUDGET=0` and
> switch to Qwen's non-thinking preset (`temp 0.7, top_p 0.80, presence 1.5`).

### The knobs

Every sampler this build supports is wired through `.env`, and each ships at
llama.cpp's **disabled** value, so `coding` reproduces the scorecard's regime
exactly. The chain runs:

```
penalties -> dry -> top_n_sigma -> top_k -> typ_p -> top_p -> min_p -> xtc -> temperature
```

`prose` mode sets the first four already. The remaining dial worth reaching for
is **XTC** ("exclude top choices"), which drops the most-probable tokens when
several are plausible — the one sampler here aimed squarely at stopping prose
collapsing into the same phrasings. Neither card mentions it, so it is left off:

```bash
XTC_PROBABILITY=0.5
XTC_THRESHOLD=0.1
```

Prefer **DRY** over `REPEAT_PENALTY` for prose. A flat repeat penalty also
punishes ordinary function words and flattens style — which is the problem
`smoothing_factor` is usually reached for.

> The model itself is not the limiter: Heretic/ARA took refusals from **99/100
> to 4/100** on the base model, per the card's own measurement.

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

### Starting a session in a project

pi works on your **current directory**, so scope it by `cd`-ing there first and
calling the launcher by its absolute path. Everything the launcher needs
(prompt fragments, the MCP skill) is resolved absolutely, so it runs correctly
from anywhere:

```bash
cd ~/my-project
~/qwen3.6-forge/scripts/pi-local.sh
```

pi then reads and edits files under `~/my-project`. Worth adding to your shell
so you stop typing the path:

```bash
echo "alias qpi='~/qwen3.6-forge/scripts/pi-local.sh'" >> ~/.bashrc && . ~/.bashrc
cd ~/my-project && qpi
```

(`~/.zshrc` if you use zsh. The alias points at the script, not at `pi` itself,
so it keeps working when the launcher changes.)

Common variants — any pi flag passes straight through:

```bash
qpi                                  # interactive session
qpi -c                               # continue the previous session here
qpi -p "what does src/auth.py do?"   # one-shot, non-interactive, prints and exits
qpi --print-only                     # show the exact command, run nothing
qpi --install-only                   # just refresh ~/.pi/agent/models.json
```

### Changing settings for one session

Any `.env` key can be overridden for a single launch by setting it in front of
the command — the same way `docker compose` treats the shell environment:

```bash
PI_CONTEXT_FILES=0 qpi     # skip this project's AGENTS.md / CLAUDE.md
THINK_LANG=off qpi         # no Chinese-reasoning fragment this session
MCP2CLI_ENABLED=0 qpi      # drop the MCP skill for this session
```

Your project's `AGENTS.md`/`CLAUDE.md` **is** loaded by default — pi walks
parent directories to find it. `PI_CONTEXT_FILES=0` turns that off for a session
where the window matters more than the conventions: a long single-file refactor,
or a project whose conventions file is enormous.

For a permanent change, edit `.env`; for a permanent *machine-local* change that
should not be committed, put it in `.env.local`.

### Controlling the stack from inside pi: `/stack`

`.pi/extensions/stack.ts` ships with the repo, and `pi-local.sh` loads it by
absolute path — so `/stack` is there in **every** session the launcher starts,
including sessions in a completely unrelated directory. The launch banner ends
with `, /stack` when it is active.

> Do not rely on pi's own `.pi/extensions/` auto-discovery for this. That is
> scoped to the project pi was *started in* and needs that project trusted, so
> starting anywhere else means no `/stack` — and because an unregistered
> `/stack` is forwarded to the model as plain text, you get a confident,
> invented answer instead of an error. If you launch `pi` directly rather than
> through `pi-local.sh`, pass
> `-e ~/qwen3.6-forge/.pi/extensions/stack.ts` yourself.

```
/stack                     model, context, slots, throughput, GPU, forge, settings
/stack mode                which preset .env matches, and what differs
/stack mode coding|prose   switch regime, then offer the restart it needs
/stack env [FILTER]        every effective setting (.env + .env.local + exported)
/stack set KEY=VALUE       edit .env, and say exactly what must restart
/stack up | down           start / stop via scripts/
/stack restart [llama|forge]
/stack smoke | eval | bench
/stack logs [llama|forge]
/stack slots save|restore|erase [id]
```

**Observation is model-callable; mutation is not.** The `stack_status` tool lets
the model check throughput or KV usage before blaming itself for slow output.
Every command that changes something is user-only, so a model cannot restart
llama in the middle of your task.

**Nothing here reconfigures a running server, because nothing can.**
llama-server answers **501 to `POST /props`** on this build — context size,
sampling, reasoning budget and MTP are startup flags, full stop — and forge
0.8.2 has no admin API at all (`/health`, `/v1/models`, `/v1/messages`,
`/v1/chat/completions`, and that is the entire surface). So `/stack set` edits
`.env` and then tells you precisely what to recreate, reading the key→service
mapping out of `docker-compose.yml` so it cannot drift. It distinguishes keys
that only `pi-local.sh` reads — those just need pi restarted — from keys that
need a container recreate and, for llama, a ~20 minute cold load.

`/stack` also detects one failure mode that ordinary health checks miss: if
`/props` answers while `/slots` and `/metrics` time out, llama's **task queue is
wedged** and inference is down even though the container looks healthy and
`/health` passes. The status output says so, and names the recovery.

> **`/stack slots` is sharp.** Measured on this box: saving one 32k slot wrote
> 315 MB in 180 s without finishing, and **aborting a save wedged the server** as
> above, costing a container recreate and a cold load. The command therefore has
> no client-side timeout — interrupting is the thing that breaks it — and it
> re-probes the queue afterwards. Read the confirmation before saying yes.

### Unattended loops: `/loop`

`vendor/pi-loop-mode` — a fork of `pi-loop-mode@2.5.4`, carried in this repo —
iterates the agent until you stop it. Nothing to install: `pi-local.sh` loads the
extension, its skill and its prompt templates from the checkout by absolute path,
so `/loop` behaves the same in whatever directory you started pi in.

If the upstream npm package is still in pi's user settings from before the fork,
remove it — two copies register two `/loop` commands that fight over one
session's state, and the launcher warns when it sees one:

```bash
pi uninstall npm:pi-loop-mode
```

Then, in the project you want worked on:

```
/loop start read @PLAN.md and implement it
/loop start <goal> --check "python3 -m pytest -q"   # objective done-ness
/loop start <goal> --max 20                          # cap the iterations
/loop stop | /loop resume | /loop finish | /loop stats
```

**Why this one.** Three properties matter on a stack like this, and they were
checked rather than taken from the README:

- **It survives compaction, which is the whole point at `CTX_SIZE=32768`.**
  Loop state is persisted as pi session entries and restored with
  `restoreLoopState(ctx.sessionManager.getBranch())`, so a compaction does not
  end the run. On context pressure it builds a *local* summary from loop state
  and touched files instead of making another model call — which matters here,
  because a summarization request against an already-saturated context is
  exactly what fails under `--no-context-shift`.
- **It is built for weak models.** Repetition and near-duplicate detection,
  a degenerate-output kill switch, and an escalation ladder that injects
  recovery strategies. A 27B local model does get stuck in ways a frontier
  model does not.
- **Done-ness can be objective.** `--check "CMD"` runs a shell command after
  every iteration and believes the exit code, not the model's claim.

Verified end to end on Qwen3.6-27B: given a `PLAN.md`, a two-iteration run
produced a working module and a passing test, and `python3 test_calc.py` exited
0 — the plan's own acceptance criterion.

**Why it is forked.** A longer unattended run died on the one thing it is
supposed to survive:

```
Error: "Backend returned 400"
[compaction] Compacted from 33,719 tokens
Error: Compaction failed: Already compacted
Loop paused — context recovery required
```

The context overflowed, **the recovery worked**, and the loop stopped anyway —
waiting for a human to type `/compact` and `/loop resume`, which is the one thing
an unattended loop cannot ask for. pi runs its own overflow recovery *after* the
`agent_end` event that upstream compacts from, so the two race; pi's lands first,
and pi refuses a second compaction of a branch that already ends in one. Upstream
treated that refusal — someone else's success — as a fatal error.

The fork defers its compaction to `agent_settled` (nothing left to race), adopts
pi's recovery when pi wins, treats `Already compacted` as "no work to do" rather
than a failure, and replaces the terminal pause with a cooldown ladder that
retries with a progressively tighter summary. `vendor/pi-loop-mode/FORK.md` has
the full list; `cd vendor/pi-loop-mode && npm test` runs the 23 tests that drive
the real handlers through that failure.

> **Third-party code runs with full system access.** Both this and the
> alternative were reviewed before running: no install-time lifecycle scripts,
> no network calls, no filesystem writes outside pi's own API. `pi-loop-mode`'s
> single `pi.exec` is the documented `--check` command you supply yourself.
> Re-review anything pulled from upstream into `vendor/` — the fork is now the
> only copy that runs, so nothing changes under it without a commit here.

### Talking to it from Matrix: `/prinny`

`vendor/prinny-channel` puts a pi session on Matrix. A message from an
allowlisted sender becomes a turn; the answer comes back to the room by itself.
It is a conversion of the Claude Code plugin of the same name — the Matrix half
is upstream's and unmodified, everything that touched Claude Code was rewritten
for pi. `vendor/prinny-channel/FORK.md` is the full account.

**Off by default** (`PRINNY_ENABLED=0`). It is the only part of this stack that
logs into a remote service and makes the session addressable from the internet,
which is a decision to take on purpose. Set it to `1` and:

```
/prinny prepare                                     once, ~1 min
/prinny configure https://matrix.example.org @bot:matrix.example.org <password>
# message the bot from your Matrix client — it replies with a code
/prinny pair <code>
/prinny policy allowlist                            stop handing out codes
```

`/prinny` on its own prints connection state, policy, allowlist, pending
pairings and settings. `/prinny log` tails the channel's own log — the channel
never writes to the terminal, because in pi stdout and stderr are the TUI.

The Matrix layer runs as a **child process**, not inside pi. Loading
matrix-js-sdk plus its Rust crypto blocks the event loop for ~15 seconds and
writes to stdout on the way up; in-process that is a frozen TUI drawn over with
library chatter. Its ~105MB of dependencies are installed outside the repo, at
`~/.pi/agent/channels/prinny/runtime`, by `/prinny prepare`.

**The answer is forwarded, not requested.** Upstream made a `reply` tool the
only way out, which holds at frontier scale and does not at 27B: the model
writes a good answer into the transcript, never calls the tool, and the person
on Matrix sees nothing while the operator sees a complete reply. So the
extension sends the assistant's text itself — `text` content only, never
thinking blocks and never tool calls, filtered by allowlist so a new content
kind is excluded rather than leaked. `/prinny forward all` sends each message as
it completes instead of just the final one; `/prinny forward off` restores
upstream's behaviour.

`/prinny permissions dangerous` relays a Matrix approval prompt before `rm -rf`,
`sudo`, force pushes and similar. pi has no approval system of its own, so this
is the extension's own gate rather than a relay of one; it **fails closed**, so
a dead channel blocks rather than allows.

> **One Matrix account per channel.** Two bots signed into the same account
> duplicate every delivery and fight over the crypto store, which ends with a
> bot that cannot decrypt its own rooms.

### The launch banner

Every session prints what it is actually doing, so nothing is on silently:

```
pi -> http://localhost:8081  (model: qwen3.6-27b, context files off, thinking in zh, mcp via cli, /stack)
```

Read it. `thinking in zh` means the Chinese-reasoning fragment is active;
`mcp via cli` means the MCP skill is loaded; `context files off` means `-nc`;
`/loop` means the vendored loop-mode fork loaded (and that no upstream npm copy
is shadowing it);
`/stack` means the stack extension loaded. If `/stack` is absent from the
banner, the command will not exist in that session. `/prinny` means the Matrix
channel loaded — and it says so with a qualifier when it will not work yet:
`/prinny (runtime not built)` or `/prinny (not configured)`.

### Keeping pi current

`PI_AUTO_UPDATE=1` (the default) has the launcher check npm and upgrade pi in
place. The check is rate-limited to once every `PI_UPDATE_INTERVAL_H` hours (24)
via a stamp file, so you are not paying a registry round trip every session, and
it **fails soft** in every direction — no npm, no network, or a failed install
all warn and launch on the version already there. `PI_AUTO_UPDATE=0` pins it.

### If it will not start

`pi-local.sh` refuses to launch rather than dropping you into a session that
cannot reach the model:

```
err  forge is not answering at http://localhost:8081 — start it with ./scripts/up.sh
```

`./scripts/up.sh` starts the stack. The **first** start after a cold boot takes
~20 minutes: the model is 17.9 GB read over a Docker Desktop bind mount that
measures 10–38 MB/s. `./scripts/logs.sh llama` shows real progress; the health
status will say `starting` the whole time.

### How the provider config is generated

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
        { "id": "qwen3.6-27b", "contextWindow": 32768, "maxTokens": 8192 }
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
  is running inside a container, `localhost` otherwise.

**Not using pi's `/llama` integration.** pi can manage its own llama.cpp router
and models. That would bypass forge completely and lose every guardrail this
repo exists to provide, so the model is registered as a plain custom provider
instead.

### Why pi, and what that costs

pi is minimal by design: **no MCP** (its README says so outright — "build CLI
tools with READMEs, or build an extension that adds MCP support"), no
sub-agents. On a 32K local window that is the feature, not the limitation. A
single MCP server can publish hundreds of tool schemas that load before your
first message, and that budget is gone before the model has read anything.

What you give up is real and worth stating: no MCP servers, no sub-agent
fan-out, and no ecosystem of Claude Code plugins. What you get back is nearly
the whole window for the actual session.

Your project's conventions still load: pi walks parent directories for
`AGENTS.md`/`CLAUDE.md` and `PI_CONTEXT_FILES` is `1` by default. That is a
deliberate exception to the window-frugality above — an agent that ignores the
conventions file in the repo it is editing costs more in rework than the tokens
save. `PI_CONTEXT_FILES=0` passes `-nc` and skips the discovery.

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

This is on without a measurement gate in front of it because the cost is bounded
and known — the skill description, and nothing else until the model chooses to
call a server. It needs `uv` on PATH; `MCP2CLI_ENABLED=0` turns it off, and
`pi-local.sh` says which state it is in.

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

## Thinking in another language

`THINK_LANG=zh` appends `prompts/think-zh.md` to the client's system prompt,
which asks the model to reason in Simplified Chinese while keeping everything
that leaves the thinking block — prose, code, quoted text, and tool-call
arguments — in the user's language.

The claim comes from the 2026-08-11 HN thread: Qwen reasons best and most
cheaply in Mandarin because that is what it was most natively trained on. The
follow-up question in that thread — *better thinking, or just shorter?* — was
never answered, and nobody posted a measurement.

**`coding` mode turns this on, by operator decision, ahead of that measurement.**
It is running on a community claim, not a local result. `prose` mode sets it
`off` — the fragment is a page about verbatim tool arguments and code
identifiers, which buys a fiction session nothing. `THINK_LANG=off` in `.env`
reverts it anywhere, and the A/B below is how you find out whether it earns its
place in `coding`.

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
Drop a rung on the quant table or lower `CTX_SIZE`. **Do not reach for
`-ctk f16 -ctv q8_0`** — a quantized V cache buys ~2 GiB of VRAM and takes
prefill off the GPU entirely (~65x slower, measured); it is why `CTX_SIZE` is
32768 rather than 65536. See the quant section above.

**`docker pull` from ghcr.io fails with `denied` on a public image.**
A stale ghcr credential in `~/.docker/config.json` is being sent and rejected — this
fails even though the image is public. Fix with `docker logout ghcr.io`, or refresh it:
`gh auth token | docker login ghcr.io -u <user> --password-stdin`.

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
.gitignore              .env.local, models, caches, the harbor checkout
.env                    committed config + version pins
.env.local.example      machine-local override template (copy to .env.local)
versions.lock           what update.sh last verified (generated)
docker-compose.yml      llama + forge, plus tools-profile one-shots
Dockerfile.forge        forge proxy image, pinned to FORGE_VERSION
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
  test_repeat_detector.py  standalone unit tests for the loop detector
  test_cjk_detector.py     standalone unit tests for the CJK leak detector
  bench.sh              prompt processing + generation speed benchmark
  slot-cache.sh         save/restore KV cache — UNUSED, and read its header first
  mode.sh               switch between the regimes in modes/
  download_model.py     resumable GGUF fetch
  pi-local.sh           launch pi against the stack (the only client)
  mcp.sh                call an MCP server as a CLI (wraps mcp2cli)
modes/
  coding.env            the regime the committed scorecard was measured in
  prose.env             decensored model, card sampling, no thinking-language
patches/
  forge_merge_consecutive.py  build-time fix for a forge crash on structured
                        message content; fails the build if forge changes
.pi/extensions/
  stack.ts              /stack command + stack_status tool inside pi
vendor/pi-loop-mode/    /loop — fork of pi-loop-mode@2.5.4, loaded from here
  FORK.md               what was changed and why (context-recovery race)
  tests/                node --test suite for the fork's recovery ladder
vendor/prinny-channel/  /prinny — Matrix channel, converted from a Claude plugin
  FORK.md               what the conversion changed, and why forwarding exists
  extensions/index.ts   the pi extension: tools, /prinny, forwarding, lifecycle
  src/                  pure modules — client, gate, block renderer, access
  server/               the Matrix sidecar, run as a child process
  tests/                227 tests, no node_modules
mcp/servers.json        registry of MCP servers reachable via scripts/mcp.sh
skills/mcp-tools/       pi skill teaching the model to use scripts/mcp.sh
harbor-adapter/
  run-local.sh          Harbor eval runner (stock pi agent, no adapter needed)
  README.md             why no adapter is needed
context/                why things are the way they are
  README.md              index of the above, and the conventions it follows
  design/decisions.md    all design decisions, flags, quant choice
  design/eval-methodology.md  what the eval benches, how it scores
```

## Eval Results

> **Full methodology:** [context/design/eval-methodology.md](context/design/eval-methodology.md) —
> what each suite tests, where the benchmarks come from, how scoring works.
>
> Measured in **`coding` mode**. Switching to `prose` changes the model and the
> sampling, so these numbers stop describing what is running.

<!-- eval-scorecard-start -->

![Eval](https://img.shields.io/badge/eval-91%25%20(27%2F27)-brightgreen?logo=pytest&style=flat)

**Latest eval:** 91% — 27/27 tests pass (floor: 0.5)

| Suite | Score | Passed | Bar |
| --- | --- | --- | --- |
| bugfix | [██████████████░░░░░░] 0.73 | 3/3 | ![](https://img.shields.io/badge/bugfix-73%-green?style=flat-square) |
| codegen | [███████████████████░] 0.95 | 5/5 | ![](https://img.shields.io/badge/codegen-95%-brightgreen?style=flat-square) |
| edits | [█████████████████░░░] 0.88 | 4/4 | ![](https://img.shields.io/badge/edits-88%-green?style=flat-square) |
| multiturn | [████████████████████] 1.00 | 3/3 | ![](https://img.shields.io/badge/multiturn-100%-brightgreen?style=flat-square) |
| reasoning | [████████████████████] 1.00 | 3/3 | ![](https://img.shields.io/badge/reasoning-100%-brightgreen?style=flat-square) |
| refactor | [████████████████████] 1.00 | 1/1 | ![](https://img.shields.io/badge/refactor-100%-brightgreen?style=flat-square) |
| review | [████████████████████] 1.00 | 1/1 | ![](https://img.shields.io/badge/review-100%-brightgreen?style=flat-square) |
| speed | [████████████████████] 1.00 | 4/4 | ![](https://img.shields.io/badge/speed-100%-brightgreen?style=flat-square) |
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
(cd vendor/pi-loop-mode && npm test)      # 23 tests for the /loop fork
(cd vendor/prinny-channel && npm test)   # 227 tests for the Matrix channel
docker compose --profile tools config     # validate compose
```

> **The speed suite measures the engine, not the proxy.** It queries llama-server
> directly and scores `timings.prompt_per_second` / `timings.predicted_per_second`
> — forge strips that block, and dividing token counts by end-to-end wall clock
> measures proxy overhead rather than throughput. Prefill uses a **4000-word**
> prompt with a unique per-run nonce, because llama caches prompt prefixes and a
> repeated prompt reports a rate for work it never did (the suite fails the row
> outright if `timings.cache_n` shows a hit). Proxy cost is its own row,
> `proxy_overhead_s`, named for what it is.
>
> This replaced a version that sent a 521-token prompt and derived both figures
> from one wall clock: it scored 0.47 both before and after a fix that made
> prefill ~65x faster, and could not have detected the regression.
>
> Individual rows still move at temperature 0.6 with no repeat mechanism:
> `edits/mixed_tabs` scored 1.00, 0.50 and 0.00 across three runs of the same
> build. Treat single-row changes as noise, not regressions.

**The scorecard measures the no-thinking path.** `eval.py` sends
`enable_thinking: false` and always has, so every number above — and every row in
`results/history.jsonl` — describes the model with reasoning off, while a real
pi session runs with it on under `REASONING_BUDGET`. To measure what you
actually run, set `EVAL_THINKING=on` (in `.env` or on the command line). The mode
and any system prompt are recorded under `config` in `results/latest.json`, so
the two kinds of run can never be confused after the fact. Keep the default when
you want a score comparable to the committed history.

The eval produces:

| Artifact | Purpose |
| --- | --- |
| `results/latest.json` | Most recent scores (committed, displayed in README) |
| `results/history.jsonl` | Every run, append-only |
| `badges/eval.json` | Shield.io endpoint for dynamic eval badge |
| `badges/suite-*.json` | Per-suite dynamic badges |
