# HANDOFF — 2026-08-13

State at the end of a long session. Everything below was measured on this box,
not inferred. Delete this file once the open items are closed.

## Stack state right now

- `qwen36-llama` and `qwen36-forge` **up and healthy**, serving
  `Qwen3.6-27B-UD-Q4_K_XL.gguf` at `CTX_SIZE=32768`.
- Last committed scorecard: **0.91, 27/27** (`results/latest.json`).
- Last commit pushed: see `git log`. Working tree should be clean except the
  in-flight item below.
- pi is installed (0.84.1), configured, and verified end to end:
  `cd <project> && ~/qwen3.6-forge/scripts/pi-local.sh`.

## IN FLIGHT — Fable-Fusion download (unfinished)

A `downloader` container is (or was) fetching:

```
repo: DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF
file: Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-MTP-IQ4_XS.gguf  (17.0 GB)
```

**`.env` was NOT modified** — it was started with per-invocation overrides, so
the running stack is untouched and the original GGUF is intact on D:.

Progress when the session ended: **~9.0 GB of 17.0 GB** written to
`D:\llm-models\.hf-cache\models--DavidAU--…\blobs\9072cb8b….incomplete`.

> **Trap I fell into — do not repeat it.** `du -sh /models/.hf-cache` reports
> the sum of **two** `.incomplete` files: ours, plus a ~7.3 GB leftover from the
> original unsloth download in early August. I reported ETAs off that sum for
> half an hour and they were all wrong. Measure the specific blob file, or the
> downloader's `wchar` in `/proc/1/io`.

To resume (the downloader is resumable, it will continue from the partial):

```bash
cd ~/qwen3.6-forge
MODEL_REPO='DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF' \
GGUF_FILE='Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-MTP-IQ4_XS.gguf' \
MMPROJ_FILE='' \
docker compose --profile tools run --rm --user 0:0 downloader
```

Then to test it:

1. `results/latest.json`, `badges/`, `README.md` are **committed** — restore the
   baseline afterwards with `git checkout results/ badges/ README.md` if you do
   not adopt the model.
2. Set `MODEL_REPO` and `GGUF_FILE` in `.env` to the values above.
3. `docker compose up -d --force-recreate llama` — expect a **~20 min cold load**.
4. `./scripts/smoke-test.sh` — **the `get_weather` assertion is the real test.**
   This is an abliterated merge; nothing in its model card says the ablation
   preserved tool calling. If tool calls break, stop there.
5. `./scripts/run-eval.sh --history` and compare against 0.91 / 27/27.
6. Revert `.env` to `unsloth/Qwen3.6-27B-MTP-GGUF` +
   `Qwen3.6-27B-UD-Q4_K_XL.gguf` if it loses.

Cleanup worth doing either way: `D:\llm-models\.hf-cache` holds ~15 GB of
partials and blobs. The final model file is placed at `/models/<GGUF_FILE>`, so
the cache is disposable once a download completes.

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

## pi → forge/llama control (researched, not built)

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
