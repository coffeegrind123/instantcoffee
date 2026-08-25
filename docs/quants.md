# Choosing a quant for 24 GiB

What fits on a 4090 alongside a KV cache, and what each step down costs.

The 4090 has 24.0 GiB. Qwen3.8-27B is a hybrid: only **16 of its 64 layers** use full
attention (the other 48 are Gated DeltaNet, whose recurrent state does not grow with
context). That makes its KV cache far smaller than a normal 27B. Unchanged from 3.6 —
the GGUF still declares `full_attention_interval=4`, `head_count_kv=4` and 256-wide
K/V heads, and every quant is within 10 MB of its 3.6 counterpart, so the table below
carries over byte for byte.

**The KV cache must be a MATCHED pair, and that is what sets the context size.**
Measured on this machine on 2026-08-12, not inherited from a guide:

| KV cache | Prompt processing | 12K-token request |
| --- | --- | --- |
| `-ctk f16 -ctv q8_0` | 26–140 tok/s, **falling** as the prompt grows (GPU at 0%) | never finished inside forge's 600s timeout |
| f16 / f16 | **1806 tok/s** | **6.9 s**, correct answer |
| `q8_0 / q8_0` (what this repo now uses) | see `versions.lock` — being re-measured | — |

**Corrected 2026-08-22.** That measurement is real, but the conclusion drawn from
it — "a quantized V cache takes prefill off the GPU" — was one step too broad, and
it is what held `CTX_SIZE` at 32768 for ten days. A stock CUDA build compiles only
**matched** flash-attention KV pairs (`f16/f16`, `q4_0/q4_0`, `q8_0/q8_0`,
`bf16/bf16`); mixing types returns `BEST_FATTN_KERNEL_NONE` and attention falls to
the CPU. The failing row above mixes `f16` K with `q8_0` V. It was the *mismatch*.
Upstream confirms it: llama.cpp#20866, where the fix is a rebuild with
`-DGGML_CUDA_FA_ALL_QUANTS=ON` and another reporter measures the same collapse
(96 → 2361 tok/s across that flag). Disabling flash attention is still not an
escape — llama.cpp refuses to start with `V cache quantization requires flash_attn`.

So a matched `q8_0/q8_0` was available the whole time. Only **16 of 64 layers** hold
a KV cache on this hybrid architecture (`16 × (3 × GatedDeltaNet → 1 × Gated
Attention)`), so with the MTP block counted the cache is ~68 KiB/token at `f16` and
~34 KiB/token at `q8_0` (measured from llama's own `-lv 5` table, 16 layers).
`CTX_SIZE` is now **98304**, which costs about 1,360 MiB more
than the 32K `f16` window it replaced.

**4-bit KV is not an option here**, whatever the public 4090 recipes say: llama.cpp
\#27109 (open) reports `q4_x` collapsing prefill to 34–106 tok/s on this exact
`qwen35` hybrid architecture against 991–1276 tok/s at `q8_0`, with generation
unaffected — so a decode-only benchmark will not catch it.

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

---

[← back to the README](../README.md)
