# KVarN measured on this box, and refused

2026-08-30. beellama.cpp v0.4.4 (Anbeeld), `ghcr.io/anbeeld/beellama.cpp:server-cuda-v0.4.4`,
digest `sha256:a27a0c22…`, upstream base `6fdd0ac89` (2026-08-27, three days behind our
`b10689`). Prompted by a r/LocalLLaMA thread recommending `kvarn5/kvarn4` + `--kv-tail-tokens`
for a 16 GB card.

**Verdict: the memory claim is TRUE and reproduces here. It is refused anyway, on decode.**

## What was measured

Six arms, `scripts/capacity-probe.sh`, `--bench prefill --bench-args '--prompt-len 90000'`,
three repeats each. Model throughout: orcarouter `Qwen3.8-27B-Uncensored-Q4_K_M`.
Every figure below is the engine's own `memory breakdown [MiB]`, not a sampled
nvidia-smi number — see vram_note on why that distinction is load-bearing.

| arm                | ctx  | K/V    | self  | model | context | compute | prefill t/s      | decode t/s |
| ------------------ | ---- | ------ | ----- | ----- | ------- | ------- | ---------------- | ---------- |
| up-96k-q8 (prod)   | 96K  | q8_0   | 19911 | 15339 | 4012    | 560     | 1402/1558/1309   | 23/46/46   |
| bee-96k-q8         | 96K  | q8_0   | 19911 | 15339 | 4012    | 560     | 668/1700/1705    | 49/41/40   |
| bee-128k-q8        | 128K | q8_0   | 21159 | 15339 | 5100    | 720     | 1590/1758/1751   | 39/45/47   |
| bee-128k-kvarn5    | 128K | kvarn5 | 19179 | 15339 | 3588    | 251     | 1364/1451/1419   | 16/18/15   |
| bee-128k-kvarn6    | 128K | kvarn6 | 19691 | 15339 | 4100    | 251     | 1399/1391/1356   | 15/15/16   |

`bee-128k-q8` was run twice (its first bench was destroyed by operator error). The engine
breakdown came back **byte-identical** both times, 21159 = 15339 + 5100 + 720, at two
different idle floors. That is the reproducibility control for every number in the table.

## What is TRUE, and worth keeping

**KVarN engages correctly on this hybrid.** Not assumed — read out of the startup log:
`enabling structured KVarN cache type kvarn_k5v5_g128`, `layers = 16`, and all sixteen
attention layers (3, 7, 11 … 63) report `route=native body=kvarn/kvarn exact=f16/f16
supported=1`. The 48 GatedDeltaNet layers are correctly untouched. The 1024 tail resolved
`raw=1024 requested=1024 effective=1024 type=f16`. No CPU fallback, no descriptor-native
downgrade. Source path confirmed independently: `LLM_ARCH_QWEN35` takes the hybrid branch at
`llama-model.cpp:2490`, which builds `llama_kv_cache_kvarn` as `mem_attn`.

**llama.cpp#27109 does NOT reproduce with KVarN.** That was the stated go/no-go. Prefill
stays in the 1356-1451 band against q8_0's 1309-1758 — an ~18% cost, not the 10x collapse
q4_x produces on this architecture. So the #27109 refusal in .env is about q4_x specifically
and should not be generalised to all sub-8-bit KV.

**Their published memory ladder reproduces within ~3 points.** Subtracting the fixed 748 MiB
of non-KV context (recurrent state + MTP block, constant across windows — 4012-3264 at 96K
and 5100-4352 at 128K both give 748):

| K/V @128K | measured KV | vs q8_0 | their ladder |
| --------- | ----------- | ------- | ------------ |
| q8_0      | 4352        | 100%    | 100%         |
| kvarn5    | 2840        | 65.3%   | 68.4%        |
| kvarn6    | 3352        | 77.0%   | 80.1%        |

The measured q8_0 rows (3264 at 96K, 4352 at 128K) reproduce vram_note exactly, so the
instrument agrees with this repo's existing record. **Their memory claims are honest.**

**The fork costs nothing at a standard cache type.** `bee-96k-q8` and `up-96k-q8` have
identical `self`, model, context and compute to the MiB. No hidden overhead.

## Why it is refused: DECODE

**16 t/s against 43.** The control settles the attribution: `bee-128k-q8` decodes at
39/45/47 — indistinguishable from 96K — so the loss is the cache type, not the window.

- Identical at kvarn5 and kvarn6 (16-18 vs 15-16) though kvarn6 gives back 512 MiB.
  **There is no bit-width that buys memory without paying this.**
- Not speculative decoding failing: DRAFT/CYC is 3.88-4.18 across every arm against
  `SPEC_DRAFT_N_MAX=4`, and draft acceptance is 0.50-0.64 under KVarN.
- Not noise: the tightest-measured arm in the sweep is `bee-128k-kvarn6` at **5.6% spread**,
  and it is one of the slow ones. By contrast `up-96k-q8`'s 38.5 mean sits at 60.1% spread
  (a cold first run) and is NOT quotable — see capacity-probe.sh's own warning.

1980 MiB and 32K of context is not worth two thirds of decode on a stack whose stated
purpose is a model that types fast enough to wait for. This corroborates the one substantive
comment in the source thread (u/Fancy-Snow7: "kvarn quants run significantly slower on my
hardware"), which was the only part of it carrying a measurement.

## The finding that outlived the experiment

**128K at q8_0 loads and decodes at FULL SPEED** — 39/45/47 t/s, `self` 21159, only 1248 MiB
above production's 96K. `ctx_128k_verdict` records 128K as refused by 22 MiB.

The verdict is not wrong; its inputs moved. It was computed when `model` read **16053**
(unsloth `UD-Q4_K_XL`, the `coding` quant). `.env` now runs orcarouter `Q4_K_M` at **15339**
— **714 MiB smaller**, with `context` (4012) and `compute` (560) identical at 96K. The
verdict was closed on the terms "if the ACTIVE floor is ~1.5 GiB rather than 2027, 128K is
worth one more look", and it got that look; **nobody contemplated the model itself shrinking.**

NOT CONFIRMED HERE, and this is why 128K is not being adopted in this note: tonight's device
carried ~1000 MiB more foreign tenancy than the reference measurement (`unaccounted` 3374-3403
against vram_note's 2376), and the idle floor read 2535 then 2298 against the documented 1501
median. Normalising 128K q8_0 to the reference tenancy gives `24563 - 21159 - 2376 = 1028 MiB`
free — a real margin, but a normalised one. Do NOT compare the two probe runs by nvidia-smi to
check it: sampled cross-run deltas gave 96K->128K as +380 MiB where the engine says +1248,
which is the same trap vram_note already documents (+245 vs +1408).

**The next measurement, and it is cheap:** re-run `bee-128k-q8` on a quiet box and read
`free` off the engine's exit table. If it is comfortably positive at the 1501 floor, 128K is
available on the current model with no fork, no quality question, and no decode cost.

## Plumbing left behind (inert)

`LLAMA_IMAGE` (empty = upstream `ghcr.io/ggml-org/llama.cpp:$LLAMA_TAG`) and `KV_TAIL_TOKENS`
(empty = flag never passed; it does not exist upstream and passing it there exits at argv
parse). `lib.sh:llama_image()` centralises a repository name that was written out three times.

**One of those three was a bug worth naming:** `capture_stack_pins()` built the image name
from a hardcoded ggml-org repo, so a fork arm would have looked up the UPSTREAM image's digest
and stamped it into the results — a provenance field positively asserting the wrong engine.
Fixed so `llama_tag` carries the full image reference when `LLAMA_IMAGE` is set; the key set
is unchanged, so every result file written before this still compares as the same stack.
`capacity-probe.sh`'s `gpu_mem_idle()` had a sibling hole: a failed pull returned an empty
string that landed in the JSON as an empty `vram_idle_mib`, silently invalidating every delta
in that run. It now warns.

---

[back to context/README.md](../README.md)
