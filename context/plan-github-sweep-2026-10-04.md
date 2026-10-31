# Plan: the 2026-10-04 GitHub sweep

A sweep of GitHub for active Qwen3.8-27B work (repos, llama.cpp / QwenLM / vLLM /
SGLang issues and PRs), checked against this repo. This file is the work plan
that came out of it: what each finding means here, what is already handled, and
what gets done about the rest, in order.

Status column values: `todo`, `doing`, `done`, `blocked (<why>)`, `refused (<why>)`.

## 1. Findings, and what each one is worth here

| # | Source | Finding | Bearing on this stack |
| --- | --- | --- | --- |
| F1 | llama.cpp#28194 (open) | `/slots/{id}?action=restore` reports success (`n_restored == n_saved`, HTTP 200) but reuses **0** tokens on hybrid models: the save file omits `prompt.checkpoints`, and the hybrid reuse gate needs one. Measured on Qwen3.8-27B. A 4-commit patch (`--slot-save-checkpoints N`) is in the thread, 2026-10-03. | `docs/context-budget.md:66` says `--slot-save-path` gives "warm restarts skip re-prefill". False twice: nothing calls save/restore (`scripts/slot-cache.sh` is deliberately unwired — a save aborted mid-write wedges the server), and a restore would reuse nothing anyway. **Doc is wrong.** |
| F2 | llama.cpp#25618 (open, 28 comments) | Greedy output with `draft-mtp`/`draft-dflash` diverges from vanilla on quantized targets; ngram arms stay identical. Reproduced on Qwen3.8-27B (IQ3_XXS, Q8_0, BF16 with DFlash). One commenter reproduces the flip with **no drafter**, by batch-scoring the same prefix: batched-vs-sequential numerics, not a quality loss. hugosmoreira's 4090 study: prose changed with MTP on, code byte-identical. | `SPEC_TYPE=ngram-map-k,draft-mtp`. Harmless at temp 1.0. It makes "speculation does not change the output" false here, so nothing may compare output text across spec arms. Needs a rule written down and a check that no tool does it. |
| F3 | QwenLM/Qwen3.8#216 | Empty answer (HTTP 200, `finish_reason: stop`, `content: ""`, thousands of reasoning tokens) — `xhigh` 38%, `low`/`medium` **8%**. Best mitigation: `frequency_penalty: 0.3`, 0 of 12. tryingET's logprobs: `<|im_end|>` sits in the top-2 inside `<think>` for thousands of steps, then gets sampled — a per-token hazard. | All modes run `medium` with `FREQUENCY_PENALTY=0.0`. `docs/pi.md:1045` already measured the local form of this: **52% empty above 87% fill (33/63) vs 1.5% below (3/196)**. A per-token hazard that grows with length fits that cliff. 12 calls prove nothing — needs our own A/B, at high fill where the rate is large enough to measure. |
| F4 | llama.cpp#29172 (open) | CUDA decode ~5.5x and prefill ~21x slower at 155K deep on the qwen35 16+48 layout. One comment's FLOPs arithmetic expects only ~0.8x at 32K. | **Already answered by our own data.** `context/bench/capacity/ctx-96k.json` (2026-08-22): 90K-token prompt, prefill **1,770–1,786 tok/s**, decode **36–47 tok/s** against ~46–53 at 60K (`ctx-64k-ctl.json`). No collapse inside the 96K window. Older pin (pre-b11118), so worth one re-run on the current pin. |
| F5 | ironblock/discipline#334 (2026-10-03) | First published KLD ladder for Qwen3.8-27B vs a Q8_0 reference (`unsloth/Qwen3.8-27B-GGUF` Q8_0, rev `4ca72078`), 12 × 4,096-token chunks of C++ and wikitext-2, second half scored. GSQ-RCO IQ3_S (12.12 GB): code 0.0542 / 95.43%, prose 0.0860 / 89.76%. EXL3 4.0 bpw: 0.0172 / 0.0223. | **No KLD exists for either GGUF we run** — `coding`'s `UD-Q4_K_XL` (stock weights) or `uc-coding`/`prose`'s orcarouter `Q4_K_M` (fine-tune, so its KLD vs stock Q8_0 is distance-from-stock, not quant damage). `scripts/kld-run.sh` exists but only varies KV type, not weights. |
| F6 | IST-DASLab/GSQ, ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF | Mixed-precision GGUF from stock weights, runs on mainline llama.cpp, MTP head included (`-mtp` files). IQ3_S is 12.1 GB vs `UD-Q4_K_XL`'s 16.4 GB. Pipeline not public (GSQ#9), so no GSQ build of the uncensored fine-tune. | A candidate for **`coding` mode only** (stock weights). ~4.3 GB of VRAM back would reopen the 128K question that `docs/changelog.md` says is now blocked by the desktop's VRAM floor. Only worth it if its KLD against `UD-Q4_K_XL` is close — F5's measurement decides. |
| F7 | llama.cpp#29143 (open, review required) | FastMTP: `d2t` draft-vocabulary trim (248K -> 32K) for the qwen35 MTP head. Claimed ~2.3x at 83% acceptance on RTX PRO 6000s (Unsloth fork). HauhauCS ships a sidecar and a patch. | Cannot run on the `ghcr` image until merged, and local native builds are off the table. **Watch.** |
| F8 | IronLLM Labs Qwen3.6-27B family report (pasted 2026-10-04) | Fable-Fusion-711 decodes 49.6 vs 57.0 tok/s for base at conc 1, **at bf16 on vLLM** — ~13%. | Independent corroboration of the 2026-08-13 entry (45.6 vs 51.2, ~11%, IQ4_XS on llama.cpp). Present without quantization and on another engine, so it is the fine-tune, not the quant. Record it; nothing to change. |
| F9 | PascalAI2024/qwen38-27b-quant-bench | ngram arms ≈ no gain on a headless 16 GB card; `draft-mtp` +35–52%; a desktop holding ~2 GB flipped MTP to **-40%** (one GDN layer evicted to CPU). Hand-protecting GDN tensors only beats the stock mixture at IQ1. Published imatrix files do not cover `blk.64` (the MTP head). | Same mechanism as `vram-floor-and-the-shared-desktop.md`, from an independent rig. Record it. |
| F10 | already handled | QwenLM/Qwen3.8#244 (mid-conversation system message raises) — in `the-template-is-part-of-the-model.md` and `troubleshooting.md`. llama.cpp#21831 (reasoning-resend busts prefix reuse) — forge's reasoning-replay policy. llama.cpp#29324 (`--cache-ram -1` unbounded on hybrids) — we run `2048`, bounded. | Nothing to do. |
| F11 | stale doc found on the way | `docs/modes.md` §prose says the model "since 2026-08-25" is `mradermacher/Qwen3.8-27B-OBLITERATED` `i1-Q4_K_M`. `modes/prose.env` runs `orcarouter/Qwen3.8-27B-Uncensored-GGUF` `Q4_K_M`, and `docs/changelog.md` records the pin moving to orcarouter on 2026-08-25. | **Doc is wrong.** |

Not relevant: the q27/Quasar and NInfer engines (other engines; NInfer already in
`ninfer-4090-forks-read-not-run.md`), DFlash2 (refused twice in `decisions.md`),
SGLang/vLLM/DGX Spark/ROCm/Vulkan repos, Qwen3.8-Flash-Next (different model).

## 1b. What Phase B found (2026-10-04)

- **The empty-turn cliff on the 96K window is small.** `docs/pi.md`'s 33/63
  was measured on the old 32K window. The one tape on the 96K window
  (`imported-pi-2026-08-23…jsonl`, 256 turns) has **1 of 14** empty at 87%+
  fill and **0 of 242** below. That import also declares
  `gaps: [system_prompt, tool_schemas]`, so it cannot be replayed faithfully.
  The A/B therefore leads with a synthetic trigger. tryingET in #216 reports
  that long near-identical enumeration in the reasoning stops it "at close to
  100% even at `medium`" on upstream llama.cpp Q8_0.
- **llama.cpp does not guard the stop.** At b11118 `common_reasoning_budget_apply`
  is a passthrough until the budget is exhausted, so an EOS inside `<think>`
  below `REASONING_BUDGET=4096` is not masked. The 4096 cap bounds how long the
  hazard runs, which plausibly explains the low rate on real traffic. No engine
  has a fix: vllm#55420 (mask EOS inside `<think>`, force the end tag) is an
  open feature request, not a merged change, and llama.cpp has no equivalent.
- **The prose corpus is ironblock's prose corpus.** `wiki.test.raw` hashes to
  `173c87a5…`, the same prefix #334 posted, so prose KLD rows compare directly.
  The code corpus differs (`a23ee696…` vs ours `ca07cc55…`), and the GSQ IQ3_S
  arm stays the code-side calibration.
- **Disk is not the constraint.** D: (`CAPTURES_DIR`) has ~7.7 TB free. The Q8_0
  reference goes on D: through `--models2`, and C:'s 40 GB is not touched.
- **Host port 8080 is taken** by another project's `tf2pro-voice-gateway-1`, so llama came up with NO network and forge could not reach it. `up.sh` now refuses on a held port and warns on a network-less container. Until that container moves, start with `LLAMA_PORT=18080 ./scripts/up.sh`, and export the same for any script that recreates llama.
- **Downloads to D:\llm-models.** The Q8_0 reference is on disk at the Hub's exact size (29,047,086,048 B), but `download_model.py`'s sha256 pass died with ENOMEM, so it is **not yet hash-verified**. Verify it before C1 trusts it. The GSQ IQ3_S-mtp download was **paused deliberately** at ~160 MB (resumable) so that read-heavy steps run on a quieter box.
- **ENOMEM on 9p reads is the recurring blocker.** The Docker VM is 22 GB shared by every project. A llama load and the sha256 pass both failed with `Cannot allocate memory` while a download ran. Dropping the Docker VM page cache took free memory from 530 MB to 6.1 GB. `/free` found no abandoned sessions; the largest single consumer is a 4.8 GB Chrome renderer owned by a live session.
- **Host RAM is.** Dry run at `--base-ngl 44` with a Q4 base: 5,329 MiB of CPU
  blocks + 3,880 MiB of logits buffers = 9,209 MiB against 7,176 MiB free, so it
  was refused. The Q8_0 base at whatever -ngl fits the card will want more:
  ~0.43 GB per block, 65 blocks, plus `token_embd`.

## 2. Work, in order

### Phase A — correct and record (no GPU, no stack)

| ID | Work | Status |
| --- | --- | --- |
| A1 | `docs/context-budget.md:66`: replace the warm-restart claim with what is true — `--slot-save-path` only enables the endpoint; nothing saves; `slot-cache.sh` says why; and llama.cpp#28194 means a restore would reuse nothing on this hybrid model anyway. | done |
| A2 | `docs/modes.md` §prose: correct the model to orcarouter `Q4_K_M`, keeping the OBLITERATED evaluation as history rather than deleting it. Read the 2026-08-25 changelog/decisions entries first so the reason for the move is stated, not guessed. | done |
| A3 | `context/design/decisions.md`: a dated **2026-10-04 — GitHub sweep** entry holding F1–F11 with verdicts, sources, and the numbers. | done |
| A4 | F2 rule: write "speculation is not output-identical on a quantized target" where the spec-sweep method is documented (`docs/benchmarking.md`), and grep every script for any comparison of generated text across spec arms. If one exists, fix it. | done |
| A5 | `context/OPEN-WORK.md`: a watch list (llama.cpp#29143, #28194 + its patch, #25618, #29172) and the Phase C measurements as open items. | done |
| A6 | `context/README.md`: index row for this file. `docs/changelog.md`: one entry for the doc corrections. | done |

### Phase B — tooling (no GPU)

| ID | Work | Status |
| --- | --- | --- |
| B1 | `scripts/kld-run.sh`: add a **weights** axis — `--base-gguf` / `--test-gguf` (default: `GGUF_FILE`, unchanged behaviour), so the same runner measures quant damage. Base arm must support partial offload (`--base-ngl`), because a 28.6 GB Q8_0 does not fit 24 GiB. Preflight must account the CPU-resident share of the base weights in its host-RAM verdict, alongside the existing logits/log-prob buffers. Null control stays first-class (Q8_0 vs itself). | done |
| B2 | Corpora matching F5's shape: 12 × 4,096 tokens of C++ source and of wikitext-2 test, plain text, `--unpinned` by design (they are not captured sessions). ironblock's own files are not public, so the numbers will not be byte-comparable — **B1's GSQ-RCO IQ3_S arm is the calibration**: if our harness reproduces their 0.054 / 0.086 within a standard error, the other rows are comparable to theirs. | done |
| B3 | Unit tests for B1's argument handling and RAM accounting, in the style of `test_kv_ceiling_check.py` / `test_runner_errexit.py`, plus `--dry-run` output checked. | done |
| B4 | Empty-turn A/B harness for F3. First check what already exists (`capture_sessions.py`, the captures under `CAPTURES_DIR`, whatever produced the 33/63 figure). Replay captured requests at **>87% fill** — where the base rate is ~50%, so a modest N separates arms — with `frequency_penalty` 0.0 vs 0.3, N repeats each, and count `content` empty / `finish_reason`. Interleave arms, record seeds, report counts with a binomial interval. | done |

### Phase C — measurements (GPU; stack up; each behind its script's preflight)

Each of these stops or loads llama, so each runs only after preflight shows no
live traffic and enough VRAM, host RAM and disk. Constraints found while planning:

- **Disk.** `MODELS_DIR` is `C:\llm-models` and C: is **98% full, 40.4 GB free**.
  The Q8_0 reference is ~28.6 GB, leaving ~12 GB. GSQ IQ3_S adds 12.1 GB — it
  does not fit after Q8_0. Either the Q8_0 goes on D: (`CAPTURES_DIR` is `//d/`)
  or arms are run sequentially, deleting each file after its pass.
- **Host RAM.** The Docker VM has 22 GB, **6.4 GB available** right now, with
  other projects' containers up (tf2-aim ×8, cs16, shattered-pixel-dungeon). A
  partially offloaded Q8_0 base arm needs ~4–8 GB of weights resident on the
  host plus ~3.9 GB of logits buffers at n_ctx 4096. `kld-run.sh` refuses to
  swap for good reason (two host deadlocks). If preflight refuses, freeing RAM
  means stopping other projects' containers — **that is the user's call, asked
  at that point, not assumed.**
- **Time.** Every llama reload is ~20 minutes over the 9p mount.

| ID | Work | Status |
| --- | --- | --- |
| C1 | KLD vs unsloth Q8_0 (rev `4ca72078`, sha256 `a680f44a…`), 12 x 4,096 tokens, second half scored, f16 KV, logits on the `instantcoffee-kld-logits` volume (a first attempt wrote them over 9p and truncated silently; see decisions). **Code corpus, done 2026-10-24** (raw logs were in `.kld-logs/20261024T101713Z/`, deleted in error 2026-10-25 by a too-broad cleanup; the numbers below are the record, regenerable only by re-running): null control (Q8_0 vs itself) KLD 0.000000, max 0.000058. UD-Q4_K_XL **0.0059 / 98.04%** top-1 (PPL ratio 1.0016). orcarouter Q4_K_M **0.0170 / 96.84%** (1.0093; fine-tune plus quant, against stock). GSQ-RCO IQ3_S-mtp **0.0332 / 95.60%** (1.0149). ironblock's IQ3_S on their (different) code corpus: 0.0542 / 95.43%, so top-1 agrees within 0.2 and KLD differs with the corpus. **Prose corpus** (same file as ironblock's), **done 2026-10-31** (`.kld-logs/20261031T113454Z/`, base PPL 6.3465): null control (Q8_0 vs itself) KLD 0.000000 / 99.996% top-1. UD-Q4_K_XL **0.0187 / 96.26%** (PPL ratio 0.9919, RMS Δp 3.30%). orcarouter Q4_K_M **0.0462 / 92.78%** (0.9782, 5.49%). GSQ-RCO IQ3_S-mtp **0.0846 / 89.68%** (0.9676, 7.26%). ironblock's IQ3_S prose: 0.0860 / 89.76% — ours matches to within 0.0014 KLD and 0.08 pt top-1 on the same corpus, a clean cross-rig check. Prose KLD is 2.7–4.5× the code KLD per arm, as ironblock found. | done |
| C2 | Empty-turn A/B (split into C2a/C2b below): `./scripts/empty-turn-ab.sh --arm base: --arm fp03:frequency_penalty=0.3`, `enum` workload first. If the baseline arm produces no empties, the workload did not trigger the failure; raise `--items` until it does, and say so if nothing does. Only then is a comparison meaningful. Adopt 0.3 only if Fisher p < 0.05 **and** a coding control shows no regression (`bench_quality.py` / smoke). | done (see C2a, C2b) |
| C2a | **Done 2026-10-04, shipped config.** Pilot, 4 paired rounds, `enum` at 600 items (20,501 prompt tokens), `medium`, budget 4096: **0/4 empty in both arms**, and every one of the 8 turns ended its reasoning on llama's "Reasoning budget reached" message at 4,136–4,238 completion tokens, mid-enumeration (~node 180 of 600), then answered. The budget closes `<think>` before the hazard can fire, so in this config there is nothing for `frequency_penalty` to fix and no A/B can rank it. Raw: `/captures/empty-turn-ab/pilot-20261004.jsonl`. | done |
| C2b | `xhigh` + `REASONING_BUDGET=16384` (the `.env` escape hatch, #216's worst regime), llama recreated with shell overrides (`.env` untouched); the control is +42 prompt tokens from the `xhigh` instruction. **Done 2026-10-04: 0/16 empty.** 600 items (20,543 prompt tokens): 0/8, reasoning ended on its own at 7K-16K tokens. 1,000 items (34,144 prompt tokens, tryingET's scale): 0/8, with 4 of 8 turns force-closed by the 16K budget. At #216's 50% rate 0/16 has p≈0.00002; at TT-Dev1's 19% vLLM rate, p≈0.034. The trigger does not reproduce on this stack (Q4_K_M, llama.cpp b11118). Raw: `/captures/empty-turn-ab/pilot-xhigh-*.jsonl`. llama restored to medium/4096. | done |
| C3 | Re-run the 96K check on the current pin. **Done 2026-10-04.** `ctx-96k-b11118-90k`: 90,029-token prompt, prefill **1,896-1,903 tok/s** and decode **44.4-55.0 tok/s** (3 runs), VRAM 22,684/24,564 MiB against a 1,805 MiB idle floor. The 2026-08-22 baseline on b10573 was 1,770-1,786 and 36-47. No deep-context collapse inside the window, and b11118 is faster at depth. (A first attempt died with ENOMEM during a download and is kept as `ctx-96k-b11118-INVALID-enomem`; `ctx-96k-b11118` is the same config benched at the default 1K prompt.) | done |

### Phase D — decisions

| ID | Decision | Inputs |
| --- | --- | --- |
| D1 | GSQ-RCO IQ3_S for `coding`: adopt, refuse, or adopt only as a 128K variant. **Refused as the default 2026-10-31.** vs `UD-Q4_K_XL`: code 5.6× the KLD (0.0332 vs 0.0059) and −2.4 pt top-1; prose 4.5× (0.0846 vs 0.0187) and −6.6 pt top-1 (89.68% means ~1 token in 10 disagrees with Q8_0). It buys ~4.3 GB VRAM. Not worth it for the 96K default. Open only as a deliberate 128K "long" variant of `coding`, and only after a `capacity-probe` fit run at 128K and a spec-sweep arm — never a silent swap. See decisions.md 2026-10-31. | refused as default; 128K variant open |
| D2 | `FREQUENCY_PENALTY=0.3`. **Refused 2026-10-04.** Neither shipped settings (0/8) nor the escape hatch (0/16) produced an empty answer, so there is nothing for the penalty to fix, and a sampler change would perturb every turn for no measured gain. Re-open only if a real session shows the #216 signature (empty `content`, reasoning spent, `finish_reason: stop`, below budget); the harness is `./scripts/empty-turn-ab.sh`. | C2a, C2b. |
| D3 | Each decision lands as a `decisions.md` entry plus the mode/doc edits it implies. | — |

## 3. Out of scope, and why

- **Adopting the llama.cpp#28194 patch.** Nothing here calls slot restore, and
  `slot-cache.sh` documents why it must not be wired as an EXIT trap. The patch
  fixes a feature this stack refuses to use. It would also need a custom
  llama.cpp build, and local native builds are banned; CI would be the route if
  it ever mattered.
- **FastMTP (llama.cpp#29143).** Pin bump when merged, then a spec-sweep arm.
- **EXL3 / ExLlamaV3.** Better KLD per byte in F5, but a different engine, and
  the stack is llama.cpp end to end.
