# The ninfer 4090 forks, read end to end — and the cost is 16.96 GiB, not 51.7

2026-09-03. Picking up `HANDOFF.md` §10 item 4: *"read `UDPSendToFailed/ninfer-4090`'s
build gate and `OFFICIAL_RESOURCE_SHA256` the same way — no bytes moved."*

**Nothing was downloaded, built or run. Nothing in the stack was touched.** Every
figure below is either read out of a repository with `gh`, read off this box's
own hardware, or read off this repo's own running llama.cpp.

**Verdict: the path this repo closed on 2026-09-03 as "not available here" is
available here, and it costs an order of magnitude less than the record says.**
Two independent things were wrong in the record, and neither was a small
correction:

| the record said | measured |
| --- | --- |
| upstream "rejects CUDA architectures other than `sm_120a`" — fatal for this box | true of upstream, and **both 4090 forks open the gate to `sm_89`** with real kernels behind it |
| "Honest cost, measured: 18 shards, **51.7 GiB**, plus the ~19 GB `.ninfer` artifact" | that is the cost of converting *the uncensored fine-tune*. The official artifact is **published pre-converted, ungated, 16.96 GiB, one file** |

What has NOT changed: no throughput claim here has been reproduced on this box,
and doing that costs a download, a container build and GPU time. This document
is the case for spending that, not evidence that it pays.

---

## 1. The build gate, both forks, against upstream as the control

Upstream `Neroued/ninfer`, `CMakeLists.txt:6-13`:

```cmake
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
  set(CMAKE_CUDA_ARCHITECTURES 120a CACHE STRING "CUDA architectures to build")
endif()
if(NOT CMAKE_CUDA_ARCHITECTURES STREQUAL "120a")
  message(FATAL_ERROR "NInfer supports only CMAKE_CUDA_ARCHITECTURES=120a; got ...")
```

That is the control, and it confirms the record's reading of the README: upstream
is Blackwell-only, by a hard `FATAL_ERROR`.

| repo | branch | default | accepts |
| --- | --- | --- | --- |
| `Neroued/ninfer` (control) | `master` | `120a` | `120a` only |
| `UDPSendToFailed/ninfer-4090` | `feat/rtx-4090-sm89-native` | **`86`** | `86` or `89` |
| `sergiuszm/ninfer-4090` | `rtx4090-port` | **`89`** | `89` only |

**This box is `sm_89`.** Read off the card, not assumed:

```
$ docker exec instantcoffee-llama nvidia-smi \
    --query-gpu=name,driver_version,memory.total,compute_cap --format=csv
NVIDIA GeForce RTX 4090, 596.36, 24564 MiB, 8.9
```

### A trap in the UDP fork, and the fork that does not have it

`UDPSendToFailed/ninfer-4090`'s README build command is

```powershell
cmake -B build-ninja -G Ninja -DNINFER_BUILD_BENCHMARKS=ON
```

with no architecture flag — so it takes the CMake default, which is **86**. Its
own `docs/rtx-4090-early.md` says the opposite in as many words: *"Keep
`CMAKE_CUDA_ARCHITECTURES=89`; a combined 86/89 fat binary is not part of this
early package."* **Following that fork's README verbatim on a 4090 builds the
3090 target.** `sergiuszm/ninfer-4090` cannot make this mistake: its default is
89 and its gate accepts nothing else.

---

## 2. The converter is byte-identical in both forks, so the 6-of-6 pin check carries

The previous session established that ninfer pins six *frontend* files by
sha256, that all six are byte-identical between `orcarouter/…-Uncensored` and
`Qwen/Qwen3.8-27B`, and that the MTP head is converted. The question for a fork
is whether any of that survives the fork.

All of it does, and not by inspection — by hash:

| file | upstream sha256 | UDP fork | sergiuszm fork |
| --- | --- | --- | --- |
| `tools/convert/qwen3_8_27b/convert.py` | `71511a875a2cf8dd…` | **same** | **same** |
| `tools/convert/qwen3_8_27b/inventory.py` | `915a4fb911ef65b3…` | **same** | **same** |
| `tools/convert/qwen3_6/common/official_resources.py` | `6c256ef01a2175c7…` | **same** | — |

So `OFFICIAL_RESOURCE_SHA256` and `TENSOR_SPECS = TEXT_CORE + DRAFT_HEAD +
MTP + VISION` are inherited verbatim. **The 6/6 result and the MTP-head result
both transfer to both forks with nothing to re-verify.**

### A false alarm worth recording, because the next reader will hit it

`tools/convert/qwen3_6/common/official_resources.py` also defines a constant
named `OFFICIAL_RESOURCE_SHA256`, and **three of its six hashes do not match the
ones this repo verified**:

| file | the qwen3_6 module | verified against Qwen3.8-27B |
| --- | --- | --- |
| `tokenizer.json` | `5f9e4d4901a92b99…` | `0997f410c57a1f4e…` |
| `tokenizer_config.json` | `5186f0defcd7f232…` | `b11349aafa7cdc6a…` |
| `chat_template.jinja` | `e84f32a23fdda276…` | `c3cf9e34abf4f9e3…` |
| `generation_config.json` | `e70c136c1b78ddc1…` | `e70c136c1b78ddc1…` — same |
| `preprocessor_config.json` | `27225450ac9c6529…` | `27225450ac9c6529…` — same |
| `video_preprocessor_config.json` | `7768af27c1fafa9c…` | `7768af27c1fafa9c…` — same |

That is **Qwen3.6's** frontend profile, not Qwen3.8's, and it is a different
model family with a shared vision/generation frontend — which is exactly why
three of six collide and make it look like a near-miss on the same file set. The
Qwen3.8 converter carries **its own** pin block, at `convert.py:32-51`, and that
block matches this repo's verification at all six files and full 64-hex length.
Reading the wrong module would produce a confident, wrong "the pins have
drifted, 3 of 6 now fail".

---

## 3. The forks are not a relaxed gate. They are an attention rewrite

A gate that accepts `sm_89` proves nothing if the kernels behind it emit
Blackwell-only instructions — the build would fail, or worse, silently pick a
fallback. So the kernels were read.

`UDPSendToFailed/ninfer-4090` adds 209 files that upstream does not have,
including an entire GQA attention path written from scratch:
`gqa_attention_prefill_bf16.cuh`, `gqa_attention_prefill_i8.cuh`,
`gqa_attention_decode_{bf16,i8}.cuh`, `gqa_attention_kv_quant.cuh`,
`e8_lattice.cuh`, `e8_root_codec.cuh`, `paged_kv_cache.cu`, plus launchers.

Its prefill kernel's own header states the schedule, and every instruction in it
is `sm_80`-and-later:

> * Br = 64 query rows and Bc = 64 key columns per CTA tile.
> * 4 warps / 128 threads; each warp owns 16 query rows of the tile.
> * Q, K, V staged in 96 KiB of dynamic shared memory (single-buffered), with the
>   `cp.async` of the next K/V tile overlapped against the current QK / PV
>   tensor-core work (exactly FA's single-buffer overlap pattern).
> * **`m16n8k16` bf16 MMA** for both S = Q Kᵀ and O += P V, online softmax in exp2.

`m16n8k16` bf16 `mma.sync`, `cp.async` and `ldmatrix` are all available on Ada,
and 96 KiB of dynamic shared memory fits `sm_89`'s 99 KiB per-block opt-in limit
— which is also why the same source builds for `sm_86`, and why the UDP fork can
offer both. Grepping the same files for `wgmma` and `tcgen05` returns nothing.

**Linux is supported, contrary to the UDP fork's own "OS: Windows 11"
prerequisite.** Its `CMakeLists.txt` carries a complete non-`WIN32` branch
(pkg-config FFmpeg and libcurl, shared `CUDA::cudart`), DirectStorage and D3D12
are inside `if(WIN32)`, and a comment in the shared section reports a
measurement the author could only have taken on Linux:

> The fast-math device flags above stay MSVC-gated — on **sm_89/Linux** they
> measured as no gain (<0.25%, within run-to-run noise) and they alter
> floating-point results.

`sergiuszm/ninfer-4090` says it outright — *"This fork targets `sm_89` and
Linux"* — and ships an ordinary two-stage `Dockerfile` on
`nvidia/cuda:13.1.2-devel-ubuntu24.04`, no vcpkg, building `ninfer` and
`ninfer-serve` with Ninja. It even documents the GeForce forward-compatibility
trap (`cudaErrorCompatNotSupportedOnDevice` from the `compat/` libs in the CUDA
runtime image), which is a real trap and a credibility signal.

The CMake floor is **CUDA 12.8**. This box's driver is 596.36 and
`instantcoffee-llama` already ships CUDA 12.8, so the toolchain requirement is
met by an image the stack already builds.

---

## 4. The context ceilings are arithmetically validated against our own engine

`UDPSendToFailed/ninfer-4090` publishes a "Verified Context Ceilings Matrix" with
figures like **433,000 tokens** and **567,000 tokens** on a 24 GB card. Those
read as fantasy against this stack's 98,304 — so they were checked, with
`scripts/kv_ceiling_check.py`.

**Why they are not fantasy: Qwen3.8-27B is a hybrid, and only 16 of its 64 layers
cache KV at all.** The other 48 are gated-delta-net layers with constant-size
recurrent state. ninfer states this as `FULL_ATTENTION_LAYERS = tuple(range(3,
64, 4))`. **Our own llama.cpp says the same thing, independently**, in two
places at once:

```
llama_kv_cache: size = 3264.00 MiB ( 98304 cells,  16 layers,  1/1 seqs),
                K (q8_0): 1632.00 MiB, V (q8_0): 1632.00 MiB
llama_memory_recurrent: layer   3: skipped
llama_memory_recurrent: layer   7: skipped
llama_memory_recurrent: layer  11: skipped
print_info: n_head_kv = 4
print_info: n_embd_head_k = 256
```

Sixteen KV layers, and the layers the *recurrent* memory skips are 3, 7, 11, … —
`range(3, 64, 4)` exactly. ninfer's constant is confirmed against a running
engine, not accepted from a source file.

**The control.** 98,304 × 16 layers × 4 heads × 256 dim × (34/32 B for q8_0) =
**1632.00 MiB**, against the engine's printed 1632.00. Exact. That fixes
32,768 cached elements per token (K and V, all layers) — 32 KiB/token at 1
byte/element. `--control` reproduces this and `test_control_fails_on_wrong_layer_count`
is the negative control: using all 64 layers, the mistake that makes every large
claim look fabricated, gives 4× and fails.

Applying that to the published ceilings, against the 16.96 GiB artifact and this
card's 24564 MiB:

| claim | K/V | B/token | ceiling | KV GiB | + artifact | slack GiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `rk2v4-e8` | 2-bit / 4-bit | 12288 | 567,000 | 6.49 | 23.45 | 0.54 |
| `rk4v4-e8` | 4-bit / 4-bit | 16384 | 433,000 | 6.61 | 23.57 | 0.42 |
| `rk4v4` | 4-bit / 4-bit | 16384 | 433,000 | 6.61 | 23.57 | 0.42 |
| `rk8v4` | 8-bit / 4-bit | 24576 | 294,000 | 6.73 | 23.69 | 0.30 |
| `int8` | 8-bit / 8-bit | 32768 | 223,000 | 6.81 | 23.77 | 0.22 |

**All five land inside a 0.32 GiB band of residual slack on a 23.99 GiB card.**
No single row proves anything; the *mutual* agreement is the evidence. Five
numbers produced by one binary search against one wall must leave the same slack,
and the slack is even monotone in bytes/token — coarser granularity at higher
precision leaves less. That is the fingerprint of measurement. Numbers written
down without a card in the loop do not do this, which is what
`test_a_scattered_claim_set_is_caught` asserts.

**What this does and does not establish.** It establishes that the ceilings are
physically consistent and that nobody has to download 17 GiB to find out they
were impossible. It says nothing about whether the model is any *good* at 433K
with 4-bit keys — the fork cites cosine similarity against FP32 (98.7% at
`rk4v4-e8`, 96.2% at `rk2v4-e8`) and exact needle retrieval through 260K, and
this repo has refused a 4-bit KV scheme before (`kvarn-measured-and-refused.md`)
on decode cost rather than on quality. Different implementation, unanswered
question.

For scale, at this stack's *current* 3264 MiB KV budget:

| KV format | tokens held |
| --- | ---: |
| `q8_0` (the live pin) | 98,304 |
| `int8` | 104,448 |
| 4-bit / 4-bit | 208,896 |
| 2-bit / 4-bit | 278,528 |

---

## 5. The cost is 16.96 GiB and one file, not 51.7 GiB and a conversion

`sergiuszm/ninfer-4090`'s `scripts/download-qwen38.sh` is fifteen lines and does
not convert anything:

```bash
curl -L -C - --fail --output "$model" \
  'https://huggingface.co/neroued/Qwen3.8-27B-NInfer/resolve/main/qwen3_8_27b.ninfer'
```

Verified **anonymously**, no token, by ranged HEAD — 302 → 200:

```
x-linked-size: 18210531328
content-length: 18210531328
```

18,210,531,328 B = **16.96 GiB exactly**, matching the size both forks quote for
the artifact. Ungated.

**So OPEN-WORK §00's cost line applies to one path and not the other:**

| path | cost | gets you |
| --- | --- | --- |
| **official artifact** | **16.96 GiB, one file, no conversion, no gate** | the stock `Qwen/Qwen3.8-27B` |
| uncensored fine-tune | 51.7 GiB of bf16 safetensors + conversion + ~17 GiB artifact | what `uc-coding` and `prose` actually serve |

The cheap path does **not** give a drop-in replacement for the live modes — two
of the three serve `orcarouter/…-Uncensored`. But it is the right experiment
anyway, because the open question is *the engine*, and the `coding` mode already
runs the official-lineage `unsloth/Qwen3.8-27B-GGUF UD-Q4_K_XL` on llama.cpp.
**The engine can be measured against a control this stack already has on disk,
for 16.96 GiB and no conversion.** Only if it wins does anyone spend the 51.7.

Disk is not a constraint: C: has 154 GiB free, D: has 7,666 GiB.

---

## 6. An outside measurement of llama.cpp on this card agrees with ours

`sergiuszm/ninfer-4090` publishes a depth sweep against llama.cpp on the same
card — build 10358, `UD-Q4_K_XL`, q8_0 KV, flash attention, `-ub 1024 -b 4096`,
2026-08-15 — and states its caveats without being asked (the artifacts differ by
~2% in size; `llama bench` is a bare kernel loop while the ninfer figures include
the full server path).

| depth | llama.cpp pp2048 | llama.cpp tg32 | ninfer decode, no spec |
| ---: | ---: | ---: | ---: |
| 0 | 3,024 tok/s | 45.9 | 50.4 |
| 32K | 2,327 | 42.0 | — |
| 64K | 1,866 | 38.6 | — |
| 128K | 1,336 | 33.1 | 42.1 |
| 256K | — | — | 36.6 |

Their integrated wall-clock puts llama.cpp's 128K prefill at 1,862 tok/s
bare-loop and ~1,788 tok/s server-measured. **This repo measured 1,797.8 tok/s on
a 90,029-token prompt on 2026-09-03**, on a different GGUF (orcarouter `Q4_K_M`)
through the full server path. An independent party, on the same card, lands on
our number.

That matters more than any ninfer figure in their tables: it is the only column
where their instrument and ours overlap, and it agrees. It does not verify their
ninfer column — but a source whose checkable column checks out is worth more than
one whose does not.

Their MTP comparison, in the units this stack cares about:

| workload | llama.cpp `draft-mtp` | ninfer MTP3 (E8) |
| --- | ---: | ---: |
| code, shallow | 118.8 tok/s @ 85.9% acceptance | 142.9 @ 78.0% |
| prose, 64K | 55.5 @ 45.3% | 86.1 @ 42.3% |
| prose, 128K | 42.3 @ 45.4% | 77.5 @ 41.6% |
| prose, 256K | no entry | 65.4 @ 41.1% |

Acceptance matches per content type, which is their argument that the gap is
engine time rather than draft quality. They also note their llama.cpp MTP rows
needed the context cut to 131,584 because the draft buffers push VRAM to 23.8 of
24 GiB — the same wall this repo hit on 2026-09-03 measuring 128K.

---

## 7. What does NOT port: the entire cliff instrument

This is the finding that would otherwise have cost a 17 GiB download and a
container build to discover.

`ninfer-serve` registers exactly these routes — read out of
`src/serve/http_server.cpp`, not out of the docs:

```
/  /health  /metrics  /slots
/v1/models  /v1/chat/completions  /v1/messages  /v1/messages/count_tokens
/v1/responses  /v1/responses/compact  /v1/responses/input_tokens
```

**There is no `/tokenize`, no `/completion`, and no logits export.** (The control
that this method finds what is there: it found `/health`, `/metrics` and
`/slots`, all three of which the README advertises.)

- `ppl_history_build.py` is built on `/tokenize` with `parse_special=False` —
  the handoff calls that parameter load-bearing, because the default re-tokenised
  a contiguous 8192-token slice to 8114.
- Every misfire-rate result in `HANDOFF.md` §3 is a **per-token** NLL threshold
  (`nll > 10` nats) with McNemar over token-matched pairs. That needs per-token
  logprobs.

ninfer ships its own `apps/perplexity` instead, and `docs/perplexity.md` rules it
out in its own first paragraph:

> It is an offline evaluator, **not a serving endpoint or a logits-export API**.

Its `report.json` carries "unrounded NLL/PPL values for every **window**, stream,
domain, and the token-weighted overall" — window-level, not token-level.

**So the cliff/misfire research line (`HANDOFF.md` §3, §4, and OPEN-WORK's whole
`ppl-*` family) is llama.cpp-only.** Moving the serving path to ninfer would
strand it unless someone patches a logits export into that engine. That is not a
reason to refuse ninfer — it is a reason not to *replace* llama.cpp with it, and
to keep the measurement stack where it is.

---

## 8. What is still unverified, stated plainly

1. **Every throughput number above is theirs, not ours.** Reading cannot verify
   2,093 tok/s prefill or 148.6 tok/s MTP3 decode. Only a run can.
2. **The UDP fork contradicts itself on its own card.** Its README headline
   matrix (MTP7, `rk4v4-e8`, 218–230 tok/s decode) sits above a `docs/rtx-4090-early.md`
   that says *"This is compatibility-qualified, not Ada-optimized. Treat the
   numbers below as an early baseline"* and reports 103.35 tok/s single-request
   decode at MTP3 on 2026-08-15. The dates differ and the README never says the
   early doc is superseded. Its C-cohort table is also **concurrency aggregate**
   (C8 = 8 concurrent requests at 315 tok/s total), which is not comparable to a
   single-stream figure and is easy to quote as if it were.
3. **The UDP fork's own disclaimer**: *"a fork of NInfer I am developing for fun
   … Things might break or regress with updates, I offer no guarantees"*, and
   *"Co-developed with Gemini 3.7 Flash."* `sergiuszm`'s fork carries no such
   note and its numbers are the more conservative of the two — 148.6 against
   218–230 for broadly the same configuration.
4. **KV quality at 2 and 4 bits is unmeasured here.** Cosine similarity against
   FP32 and needle retrieval are their evidence. This repo's own standard for
   this question is `kv-cache-fidelity-measured.md`, and it is a higher bar.
5. **The published artifact is the official model**, not the fine-tune two of
   three modes serve.

---

## 9. What to do with this

**The cheap decisive experiment**, in order:

1. `docker build` `sergiuszm/ninfer-4090`'s Dockerfile — it is 89-only by
   default, Linux-native, and CUDA 12.8+ which this stack already has.
2. Download the 16.96 GiB official `.ninfer` artifact. Stage on D:.
3. Measure it against **llama.cpp on `unsloth/Qwen3.8-27B-GGUF UD-Q4_K_XL`** —
   the GGUF the `coding` mode already runs, and the same one their comparison
   used. Same card, same weights lineage, same prompts, `capacity-probe.sh`'s
   existing arms so the units match everything else in this repo.
4. Only if the engine wins by a margin worth the disruption does anyone spend
   the 51.7 GiB to convert the uncensored fine-tune.

**Costs the operator has to agree to:** ~17 GiB of download, one CUDA container
build, and GPU time with llama stopped. Per `HANDOFF.md` §10, GPU spend gets
asked for, not assumed.

**Do not** follow `UDPSendToFailed/ninfer-4090`'s README build line on this card
(§1). **Do not** replace llama.cpp on the strength of §6's table alone; §7 means
the measurement stack has to stay regardless.

---

## 10. UPDATE — it builds, on this box, and the binary is native sm_89

Everything above was read-only. This section is the first part that was RUN.
`sergiuszm/ninfer-4090` at `rtx4090-port` (`914e050`), built with its own
`Dockerfile`, unmodified:

    docker build --tag ninfer-4090:sm89 .

**It builds clean.** 290 objects, zero errors, `nvidia/cuda:13.1.2-devel-ubuntu24.04`
-> a 5.13 GB runtime image, `ninfer` and `ninfer-serve` both linking and running.
No patches, no flags, no vcpkg, no Windows. The clone's own gate confirms locally
what the API read said: default `89`, and `89` only.

**The binary contains native Ada code, verified rather than assumed:**

    ELF file 1: ninfer-serve.1.sm_89.cubin
    ELF file 2: ninfer-serve.2.sm_89.cubin
          2 sm_89     ELF cubins
         (none)       PTX

Two `sm_89` cubins and **zero PTX**, so there is no JIT fallback: the open gate
is not cosmetic, and this build targets this card specifically.

**That check needed its control, and the first run of it was wrong.** The first
`cuobjdump` invocation returned empty for cubins AND for PTX — which reads as
"no device code" and is a perfectly plausible wrong answer. The control (running
`cuobjdump` against a binary known not to contain device code, and printing the
raw first lines) showed the real cause: `cuobjdump fatal: Could not open input
file`. The binary had been staged in `/tmp/claude-0/...`, which exists inside
this container and **not on the host**, so Docker Desktop mounted an empty
directory over it. Re-staged under the 9p mount and referenced by its `//c/...`
path, the file opened and the cubins appeared. An empty grep result and a file
that was never opened are indistinguishable without the control.

**`O_DIRECT` on the 9p mount: NOT a blocker.** `src/artifact/reader.cpp:255`
opens the artifact `O_RDONLY | O_CLOEXEC | O_DIRECT` and mmaps it. `O_DIRECT` is
unsupported on many filesystems and fails `open()` with `EINVAL`, and the models
volume is 9p — a prime candidate. Tested against a GGUF already on that mount,
with plain `O_RDONLY` as the control:

    mount: /models type=9p
    O_RDONLY           -> OK
    O_RDONLY|O_DIRECT  -> OK

It opens. The second-order consequence still stands: `O_DIRECT` bypasses the
page cache, so a re-load gets no help from it and cold load is genuinely a cold
read of 16.96 GiB over 9p. That is why `ninfer-compare.sh` polls `/health` for
up to 1800 s instead of sleeping a guess.

**A third README-vs-code divergence in this family.** `ninfer-serve --help`:
*"`--turn-checkpoints` is RETIRED and has no effect ... the value is accepted and
ignored so existing command lines keep starting"* — while the fork's own quick
start still recommends `--turn-checkpoints 32` and links a doc for it. Harmless,
because it is accepted and ignored, but it is the same pattern as the UDP fork's
`sm_86` default: **in this fork family the READMEs run ahead of the code, so
check a flag against `--help` or the source before relying on it.** All thirteen
flags `ninfer-compare.sh` passes were checked that way.

**What is still not measured:** anything about speed. The artifact was still
downloading when this was written.

---

## Method note

Everything here was read with `gh api -H "Accept: application/vnd.github.raw"`,
which returns literal bytes, or with `gh api repos/<r>/git/trees/<ref>?recursive=1`
for tree listings. Hashes are `sha256sum` over those bytes. The one network call
that touched Hugging Face was a `curl -sIL` HEAD, anonymous, which transfers no
payload. The arithmetic in §4 is `scripts/kv_ceiling_check.py`, whose control
reproduces a number this repo's own engine printed, and whose test suite includes
three negative controls.
