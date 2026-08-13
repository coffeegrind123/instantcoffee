# HANDOFF — 2026-08-13

State at the end of a long session. Everything below was measured on this box,
not inferred. Delete this file once the open items are closed.

## Stack state right now

- `qwen36-llama` and `qwen36-forge` **up and healthy**, serving
  `Qwen3.6-27B-UD-Q4_K_XL.gguf` at `CTX_SIZE=32768`.
- Last committed scorecard: **0.91, 27/27** (`results/latest.json`).
- Last commit pushed: see `git log`. Working tree clean.
- pi is installed (0.84.1), configured, and verified end to end:
  `cd <project> && ~/qwen3.6-forge/scripts/pi-local.sh`.

## Fable-Fusion — DOWNLOADED, TESTED, REJECTED (2026-08-13)

Download completed: 17,033,682,400 bytes, byte-exact against `x-linked-size`.
The file is on `/models` beside the incumbent; `.env` is back on
`unsloth/Qwen3.6-27B-MTP-GGUF` and the stack is verified healthy on it (11/11).

Result, in one line: **it ties on quality, loses ~11% of decode speed, and the
only thing that makes it different is not measured by anything here.**

- Smoke **11/11 including `get_weather`** — the ablation did not break tool
  calling, which was the gate this whole test existed for.
- Eval 0.913 / 27-27 — **all 27 individual scores identical to baseline.** The
  suite cannot separate the two models. Responses did differ, so it ran.
- Five-run identical probe: decode **51.2 tok/s baseline vs 45.6 Fable**,
  prefill a wash. The eval's speed row claimed the opposite; it is one sample
  and MTP acceptance is content-dependent. Do not decide on that row.

Full write-up, including the two defects this exposed (eval provenance could not
identify the weights; the tools image bakes the Python and nothing rebuilt it —
both now fixed), is in `context/design/decisions.md`.

Delete the GGUF if you want the 17 GB back; nothing references it now.

## Second model to try (queued, not started)

`bottlecapai/ThinkingCap-Qwen3.6-27B-GGUF` → `ThinkingCap-Qwen3.6-27B-Q4_K_M.gguf`
(15.7 GB, **smaller than what we run now**). Card claims **50% fewer thinking
tokens at identical accuracy**, with multi-seed 95% CIs — far better evidence
than Fable-Fusion's single-run third-party numbers. MTP works on it directly;
they report accept length 3.69 at `--spec-draft-n-max 4` (we run 2).

If it holds up it makes `THINK_LANG=zh` redundant, which would retire an
unverified setting we are currently carrying. **This is the one I would test
first if starting over** — Fable-Fusion is a decensoring, benchmarked only on
commonsense multiple-choice (ARC/HellaSwag/PIQA), none of which measures code,
edit precision or tool calling.

Model cards are downloaded at
`/tmp/claude-0/.../scratchpad/cards/` (may not survive a reboot).

## pi → forge/llama control — BUILT (2026-08-13)

Shipped as `.pi/extensions/stack.ts`: a `/stack` command and a read-only
`stack_status` tool. Documented in README under "Controlling the stack from
inside pi", with the full record in `context/design/decisions.md`.

**Two claims in the research below were wrong, and are corrected there:**

- forge does **not** serve `/forge/health` or `/forge/usage` — those 404 on our
  pinned 0.8.2. They are 0.9.0 routes that got read out of the HEAD clone and
  written down as if probed. There is no usage endpoint to adopt.
- `scripts/slot-cache.sh` did **not** prove the slot syntax. It sends
  `POST /slots?action=..&id_slot=..`, which 404s on b10200; `curl -f` and
  `|| true` hid that. The real route is `POST /slots/{id}?action=..`. Fixed.

**One incident worth knowing about.** Probing slot save wedged llama: an aborted
save stops the task queue draining, so `/slots`, `/metrics` and *all inference*
hang while `/props` keeps answering 200 and the container looks healthy.
Recovery needed a force-recreate and a cold load. `/stack` now detects that
signature and names the fix; `slot-cache.sh` carries a header warning never to
use `save_slots` as an EXIT trap, because shutdown's SIGKILL is exactly that
abort.

## The original research (superseded above where they conflict)

Three repos cloned to `/tmp/research/`: `pi`, `forge` (0.9.0 — we pin 0.8.2,
there is a `MIGRATING_TO_0.9.md`), `llama.cpp` (sparse: `tools/server`).

**Probed against the running b10200 build, not the docs:**

| Endpoint | Result |
| --- | --- |
| `/props` `/slots` `/metrics` `/models` `/v1/models` `/lora-adapters` | 200 |
| `POST /props` | **501 — runtime config changes are NOT implemented** |
| `/tools` | 403 (flag-gated) |
| `/v1/chat/completions/control` | 404 (HEAD only) |

forge's entire HTTP surface is `GET /forge/health`, `GET /forge/usage` (we do
not use this — worth surfacing), `POST /v1/messages`. No admin/config API; it is
CLI-flag driven only.

**Consequence:** "configure llama/forge from pi" can only mean *edit `.env` +
restart*, which is a ~20 min cold load here. The genuinely live controls are
slot KV save/restore/erase (`scripts/slot-cache.sh` proves the syntax) and LoRA
scales. Design accordingly: rich observation, orchestration via the repo's own
scripts, and honesty that reconfiguration restarts.

pi's extension API (`~/.pi/agent/extensions/*.ts` or `.pi/extensions/*.ts`)
offers `registerCommand`, `registerTool`, `registerFlag`, `registerShortcut`,
`pi.exec()`, `pi.on()`. Planned `/stack` command: status (model, n_ctx, slot
cache, MTP, tok/s from `/metrics`, VRAM, forge health+usage), `slots
save|restore|erase`, `set KEY=VALUE` (edits `.env`, warns about restart),
`restart|up|down|smoke|eval|bench`. **Mutations as user-only commands, never
model-callable tools.**

Bigger option, deliberately deferred: llama-server **router mode** (start
without `-m`, add `--models-dir`) unlocks pi's built-in `/llama` UI for
load/unload **and Hugging Face search+download**. `/models/load` and
`/models/unload` already answer 200. Cost: nothing is loaded at boot, so forge's
first request fails until a model is loaded — a behaviour change for `up.sh` and
the smoke test.

## Hard-won facts that will save the next session hours

- **KV quantization is unusable here.** `-ctk f16 -ctv q8_0` takes prefill off
  the GPU: 26–140 tok/s and falling, vs **1764–2331 tok/s** on f16/f16. Cannot
  be worked around with `-fa off` (llama refuses: "V cache quantization requires
  flash_attn"). This is why `CTX_SIZE` is 32768.
- **mmap never finishes on this box.** `MODELS_DIR` is a Docker Desktop bind
  mount = 9p. Demand-paging the GGUF runs at ~0.05 MB/s. `--load-mode none` is
  mandatory.
- **Prefill collapsing while decode stays fine has TWO causes**: the KV quant
  above, and host memory pressure. `CACHE_RAM` is **host** RAM — at 8192 it was
  llama's entire 9 GB RSS and drove the box into swap (prefill fell to 2.83
  tok/s). Now 2048.
- **forge requires a tool call whenever the request carries tools.** A bare text
  reply is a validation failure; it nudges and retries. `FORGE_MAX_RETRIES=0`
  fixes it (0.8s answer turn vs 6.7s wrong / 5.1s with `--inject-respond-tool`).
- **The eval's speed suite was rewritten** to read llama's own `timings` (forge
  strips them) with a 4000-token prompt and a per-run nonce. The old one scored
  0.47 before *and* after a 65x prefill fix.
- **First start after a cold boot is ~20 minutes.** Not broken.
- `CACHE_REUSE` does nothing on this model (llama logs it disabled — hybrid
  Gated DeltaNet layers).

## Still open

- `THINK_LANG=zh` is ON and **never measured** on this hardware.
  `./scripts/ab-think-lang.sh --repeat 3 --save` settles it; a non-zero exit
  means set `THINK_LANG=off`.
- `SPEC_DRAFT_N_MAX=2` was adopted from a public rig; ThinkingCap's card
  suggests 4. Unmeasured here.
- forge 0.9.0 is available (we pin 0.8.2).
