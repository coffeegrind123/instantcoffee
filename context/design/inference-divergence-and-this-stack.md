# The Level1Techs divergence experiments, read against this stack

*2026-08-23. Source: `thr3e`, "Why your local LLM feels dumber than it is",
forum.level1techs.com/t/253917, parts 1, 2, 3.11 and the side-quest post, plus
the Hacker News thread on it. Pulled through the Discourse JSON API
(`.../253917.json?include_raw=true`) rather than a summariser, so the numbers
below are the author's own.*

This is an assessment, not a decision. It changes nothing in `.env` and adds
nothing to `versions.lock`. Its purpose is to say which of the article's
hazards this stack is actually exposed to, which it has already closed and on
what evidence, and which of its two real gaps is worth measuring — with the
instrument that turns out to already be inside the pinned image.

## 1. What the article actually measured

Not opinion, and not benchmarks. The author captured **full-vocabulary logits
under teacher forcing** — the token history is held fixed, so every arm is
scored against the same prefix — and reports **top-1 disagreement**: the
fraction of evaluated positions where an arm's argmax token differs from the
BF16 reference's. Where an arm disagrees, the alternate continuation is then
*allowed to play out* and inspected for whether it recovers or produces a
malformed tool call.

The control that makes the whole thing worth reading: **same backend, same
GPU, repeated runs produced bit-identical logits at every hidden state.** So
every divergence reported below is arithmetic, not sampling noise. That is the
control this repo's own method notes keep insisting on, run properly.

Four results, in the order they matter here:

- **Test 1 — attention backend.** vLLM, Qwen3.6-27B BF16, BF16 KV, one GPU, the
  *only* change being FlashAttention-2 vs FlashInfer vs Triton. Agreement is
  perfect for the first several thousand tokens, then disagreement appears in
  **clusters tied to prompt content**, not smoothly with depth. Part 2 shows a
  single FA2 top-1 flip retargeting a Cisco tool call from
  `GigabitEthernet0/0/1.201` to `GigabitEthernet0/1/4`, then failing to recover
  across two further tool calls. Repeatable, bit-identical.
- **Test 2 — KV-cache quantisation only.** BF16 weights, BF16 activations,
  Triton, the *only* change being the KV cache. int8 KV diverges from BF16 and
  eventually recovers; **int4 KV diverges and does not** — a reproducible
  tool-calling failure. This is the "IQ drops after 40k tokens" headline.
- **Test 3 — weight quantisation, KV forced BF16.** INT8 W8A16 beats first-party
  FP8; NVFP4 comes last at ~50% top-1 flips by 88k. **Both 4-bit arms (NVFP4 and
  AWQ W4A16) failed to close their tool calls** and issued the wrong Cisco
  command. Note the asymmetry the author flags himself: the INT8 and AWQ arms
  leave the GDN/linear-attention projections and `lm_head` unquantised, which is
  most of why W8A16 does so well.
- **Part 3.11 — derivative tunes.** Four popular Qwen3.8-27B abliterated/
  "uncensored" BF16 tunes against stock. Heretic-ARA (0.72%/1.34% flips) and
  Huihui (0.91%/1.41%) are conservative and produced **zero** structurally
  invalid branches. Blackfrost (3.84%/4.98%) and AEON (3.00%/5.83%) are not:
  AEON turned PostgreSQL's `5432` into `543ql` at 42,950 tokens — stock chose
  the final `2` at p=0.9991 — then failed to close the tool envelope, and
  separately corrupted a hostname and a `page_size=` kwarg. **High-confidence
  literal-copy failures in operational commands**, which is a much more specific
  claim than "abliteration makes it worse".

The author's own caveats, which should travel with any citation of this: part 1
sampled only ~3% of positions and he says so; BF16 is a fidelity reference, not
an oracle; a top-1 flip is a counterfactual root, not automatically a different
answer; and disagreement is **highly prompt-dependent** — some workstreams sit
under 1% across every config, others spike.

## 2. The failure mode, named

Across all four tests the damage is the same shape and it is not "worse prose".
It is **corruption of exact literals inside structured output**: an interface
name, a port number, a hostname, a keyword argument, a tool-call envelope that
never closes. These are positions where the reference model is *maximally
confident* — p=0.9991, p=0.99996 — and the flip therefore signals real
arithmetic drift rather than a coin-flip between two plausible tokens.

That matters here because it is precisely the class of error that this stack's
existing gates do not look for. `smoke-test.sh` runs a real tool call, but at
shallow depth. `bench_quality.py` executes generated code against assertions —
a semantic gate, which a subtly wrong literal usually trips, but only for the
five-plus-three synthetic tasks and only near the top of the window.

## 3. What this stack already does right, verified rather than assumed

Two controls, run against the live `qwen38-llama` (up 4 h, healthy) before this
was written — neither required touching the server:

**The chat template is the real one, not a ChatML fallback.** The single
most-upvoted practical claim in the HN thread is that GGUF repacks often drop
the template, the runtime silently falls back to ChatML, and the model gets
quietly dumber. Checked via `/props`:

```
   chat_template length            9,993 chars
   occurrences of reasoning_effort         8
   occurrences of tool_call               29
   occurrences of preserve_thinking        2
   chat_template_caps              supports_tool_calls, supports_reasoning_effort,
                                   supports_parallel_tool_calls, supports_preserve_reasoning
   build_info                      b10573-d775b8967
```

That is Qwen3.8's own template, live, with the tool-call and reasoning-effort
branches present. The repo had already checked `preserve_thinking` against the
GGUF's embedded template when it declined the `--reasoning-preserve` hint; this
confirms the same template survived into the running server.

**The sampler matches the model card.** The article's aside — "setting temp too
low is why your qwen is sitting there looping unable to escape its THINK output"
— is a hazard this stack is not exposed to. From the same `/props`:

```
   temperature 1.0   top_k 20   top_p 0.95   min_p 0.0
   everything else at llama.cpp's disabled value: dynatemp 0.0, xtc_probability 0.0,
   dry_multiplier 0.0, repeat_penalty 1.0, presence 0.0, frequency 0.0,
   top_n_sigma -1.0, typical_p 1.0, mirostat 0
```

Those are Qwen3.8's published values exactly, with no creative sampler armed.

**Four more, from the record rather than from a live probe:**

- **4-bit KV is already refused**, and now for a second, independent reason.
  `kv_cache` in `versions.lock` refuses q4_0/q4_1 on llama.cpp#27109 — a prefill
  collapse to 34-106 t/s on this exact qwen35-hybrid architecture. The article
  adds that int4 KV is the one arm in Test 2 that **never recovers** from its
  tool-calling failure. A decision taken on throughput turns out to be right on
  fidelity too. That is luck, not foresight, and it is worth writing down as
  such.
- **The build is pinned to an immutable per-build tag**, not `:server-cuda`.
  The article's whole thesis is that your path through the stack is unique and
  unstable; a floating tag makes it unique *and unrepeatable*.
- **`REASONING_EFFORT=medium`** is measured here (xhigh at 36/40 on the harder
  set while every other level is 40/40) and independently corroborated across
  the HN thread, where several users report xhigh looping or over-engineering
  and one notes the template defaults it to xhigh.
- **Not ollama.** The thread's specific complaints — a 4K default context
  window on <24 GB cards, an opaque default quant, no CLI passthrough for engine
  parameters — are all things this stack sets explicitly and records.

## 4. Gap 1 — q8_0 KV was adopted on throughput and VRAM, never on fidelity

This is the one that matters.

`versions.lock:kv_cache` records the f16 -> q8_0 change with prefill numbers
(four digits and rising with depth), the matched-kernel explanation, and the
4-bit refusal. `vram_note` records what it buys: main KV at 34.0 KiB/token, so
96K costs 3,264 MiB quantised and would cost ~6,528 MiB at f16. **There is no
entry anywhere recording a quality comparison between the two.** The change was
correct on every axis that was examined; fidelity was not one of them.

The article's Test 2 is exactly that missing experiment, and its answer for int8
is "diverges, then recovers" — not a disaster, but not free either, and its
headline is that the effect grows past ~40k. This stack runs a **96K** window.

**Update, 2026-08-24: this section is now measured, and it needs one scoping
fact it was written without.** See `context/design/kv-cache-fidelity-measured.md`
for the run and `versions.lock:kv_cache_fidelity` for the summary. The result:
q8_0 KV costs **no measurable perplexity** (0.9953 at n_ctx 4096, 1.0016 at
8192, against an f16-vs-f16 null control returning KLD 0.000000 and same-top-1
100.000%) and moves **4.7% of tokens' top-1** with a violent tail (99th
percentile KLD 3.2, median 0.001). The scoping fact: **qwen35 is a hybrid and
only 16 of its 64 layers have a KV cache** — `full_attention_interval = 4`, the
other 48 layers are state-space — so `-ctk/-ctv` quantise a quarter of this
model's state, not all of it. The article measured dense transformers.

Three things keep this from being an alarm:

- **llama.cpp's q8_0 KV is not vLLM's int8/FP8 KV.** q8_0 is blockwise — 32
  values per block with an f16 scale — which is a materially better-conditioned
  quantisation than a per-tensor or per-head FP8 scheme. A commenter in the HN
  thread makes the same point from the other direction, arguing q8_0 from
  llama.cpp should behave better than vLLM's FP8 and linking vLLM's own issue.
  The article does not measure llama.cpp at all.
- **Deep literal-copy fidelity is now measured directly, and it is clean.**
  `ctx_needle.py` already plants nonce facts at both ends and requires both back
  verbatim — 90,055 tokens, 105,025-token control refused by name — but that is
  one nonce per end per run, in prose, outside any tool envelope. So
  `scripts/bench_literal.py` was written to close exactly that gap: eight
  literal shapes, one per failure surface the article observed, copied from
  depth into a tool-call **argument**. Result, on this stack as configured:

  ```
     run  depths (tok)            calls  literals  non-exact
     A    2000 control, 4000          4        32          0
     B    2000 control, 16k/48k/90k   14      112          0
     C    90000 x3, TEMP 1.0           6       48          0
     D    2000 control, 8000           4        32          0
  ```

  224 field comparisons, zero corrupted, greedy and at the production sampler
  alike. Details and limits in `versions.lock:literal_fidelity`. This does not
  make q8_0 KV free — it says the exposure is not manifesting on the failure
  mode the article named, at the depths this stack runs at.
- **The alternative may not exist on this box.** f16 KV at 96K is +3,264 MiB
  against a measured in-use floor of 1,500.8 MiB (§5a of
  `vram-floor-and-the-shared-desktop.md`). It does not fit, and it is not close.
  So the real question is never "q8_0 or f16 at 96K"; it is **"96K at q8_0 or
  ~48-64K at f16"** — and nobody has priced the two against each other.

**That trade is currently decided by default, in one direction, without a
fidelity measurement on the axis that would settle it.** What exists now is a
strong result on one failure mode (literals into tool arguments) and nothing on
the others (prose, reasoning, long-horizon coherence). It should not be
re-decided without a measurement either. See §6.

## 5. Gap 2 — "output is unchanged" is true of the distribution and false of the arithmetic

`versions.lock:spec_config` says of the MTP/ngram configuration:

> Output is unchanged: every draft is verified against the target model, so
> this is decode speed only.

That is correct *as a statement about the sampling distribution*. llama.cpp
emits the target model's own sampled token at every position and uses the draft
only as a prediction to check against, so the distribution is the target's.

But `.env`'s own justification for the b10573 bump documents the mechanism that
makes it false at the arithmetic level, three hundred lines away:

> `2b562109` (#26079) CUDA: per-HW/per-quant MMVQ->MMQ decode crossover. […]
> b10573 adds a table explicitly "tuned on RTX 4090": Q4_K/Q5_K cross to MMQ at
> `ne11 > 7` […] The verify batch is 1+n_max […] When ngram-simple fires it
> drafts far past 8 (draft/cycle 26.8 on the repetition bench) and both builds
> are on MMQ there too.

So **which CUDA GEMM kernel computes the logits depends on how many tokens the
drafter happened to propose.** Two lines of this repo hold both halves of that
and no document connects them. This is structurally the same miss as §7 of the
VRAM document — a number read one line deep — and the same miss as the article's
own subject matter, which is that the kernel *is* the variable.

What the live server says about how often it actually happens:

```
   docker logs qwen38-llama | grep 'draft acceptance'
   mean len = 3.70 … 4.75 across every task sampled     -> verify batch 5-6, MMVQ
   bench_repeat.py, the file-rewrite shape pi produces: draft/cycle ~21-25 -> MMQ
```

**Ordinary generation stays on MMVQ; long verbatim rewrites cross to MMQ.** The
kernel switches precisely when the model is emitting long exact copies — which
is the article's identified failure surface. That is a hypothesis with a
mechanism, not a finding: MMQ and MMVQ both do integer dot products with
per-block f16 scales and differ mainly in accumulation order, so the divergence
should be far smaller than the fp16-GEMM reordering the article measured. It has
not been measured here either way.

The honest fix costs nothing and is now applied: `versions.lock:spec_config`
says what it means — the sampling distribution is unchanged; bit-identical
logits across draft lengths are not claimed and have not been tested.

## 6. The instrument is already in the pinned image

The article's method needs full-vocabulary logit capture and a top-1 comparison.
That is `llama-perplexity`'s KL-divergence mode, and it is in the image this
stack already runs — reachable through the unified `llama` binary:

```sh
docker run --rm --entrypoint /app/llama ghcr.io/ggml-org/llama.cpp:server-cuda-b10573 help all
    …  perplexity   Compute model perplexity and KL divergence  …

--save-all-logits, --kl-divergence-base FNAME    set logits file
--kl-divergence                                  computes KL-divergence to logits
                                                 provided via --kl-divergence-base
```

It reports mean/median KLD, the KLD quantiles, **and same-top-token agreement** —
the article's top-1 metric, deterministically, with no sampler noise and no
pass/fail scoring. It would also sidestep the problem the bench ran into this
session, where the new task set turned out to be non-deterministic and one grid
cell is one sample: teacher-forced logits are reproducible bit-for-bit, which is
the author's own control.

**Feasibility, honestly:**

- It loads its own copy of the model, so `qwen38-llama` must be **stopped** for
  the run — one ~20-minute cold reload afterwards, over the 9p mount. Both arms
  should therefore run back-to-back inside one stop.
- VRAM bounds the depth. Model 16,053 MiB + f16 main KV at 34.0/2 KiB/token
  puts the f16 baseline arm at ~20.8 GiB at 64K, which fits under the measured
  in-use floor; **96K at f16 does not fit** (~23.2 GiB against ~23.0 available).
  So the comparison is possible up to ~64K — which does cover the ">40k" region
  the article's headline is about.
- The logits file is full-vocab per token. Qwen3.8's vocab is ~151k, so a 64K
  chunk is on the order of tens of GB. The author hit this too and it is why his
  own methodology changed. Check free space on `//d/` first and consider a
  shorter corpus for a first pass, accepting that it probes shallower depth.
- Corpus choice is the whole experiment. A synthetic filler file will
  understate the effect, because the article's own strongest finding is that
  disagreement is **prompt-dependent** and clusters on content. The right input
  is a real captured pi workstream containing tool calls and file rewrites —
  which this repo does not currently keep, and which is the cheapest thing to
  start doing.

**The second, cheaper probe does not exist. RETRACTED, same day, by
measurement.** The first draft of this document proposed using per-request
`n_probs` / `logprobs` against the live server to see whether a flip lands on a
high-confidence literal — the article's part-2 move — with no downtime. That was
reasoned from `/props` advertising `n_probs: 0` as a default. It was then tested,
and it is false.

Four arms against the running server:

```
   OpenAI /v1/chat/completions, tool call, temp 0.0     1 of 26 tokens
   OpenAI /v1/chat/completions, plain text, temp 0.0    1 of 19 tokens
   OpenAI /v1/chat/completions, plain text, temp 1.0    1 of  9 tokens
   native /completion, n_probs 3, temp 0.0              1 of 12 tokens
```

Exactly **one** token per response carries `top_logprobs` — the first. Every
other token comes back as `logprob: 0.0` with an empty list.

The cause is confirmed in the source at the pinned tag rather than inferred from
the symptom. `tools/server/server-context.cpp` @ `b10573`: the non-speculative
path calls `populate_token_probs()`; the speculative accept branch builds each
emitted token as

```c
   result.prob = 1.0f;   // set later
   // TODO: set result.probs
```

and never calls it. The first token of a response is emitted before the first
draft exists, which is why exactly one survives.

**This is worse than a missing feature, and it is the article's own thesis
turned on the measuring instrument.** `logprob: 0.0` is p = 1.0. The API does not
say "not computed"; it says "the model was certain" — for every token after the
first. A confidence analysis run against this stack would conclude the model is
maximally confident about everything and would look entirely valid while doing
it. Compare the `dwm` trap in §3 of the VRAM document: a plausible counter
measuring something else.

It cannot be worked around per request: `slot.can_speculate()` is
`return !!spec;`, a server-level object, and sending `"speculative.types":
"none"` in the request body changed nothing when tried. Any logprob-based
measurement on this stack requires a restart with `SPEC_TYPE` empty — the same
~20-minute cold load the KLD run needs, which means the two should share one
stop if both are ever wanted.

Recorded as `spec_logprobs_note` in `versions.lock`.

## 7. What is worth doing, in order

1. **Amend `spec_config`'s "output is unchanged" to scope it to the sampling
   distribution.** Free, correct, and it stops a future session from citing the
   line as evidence that the kernel path is irrelevant.
2. ~~**Start keeping real workstream captures.**~~ **DONE, 2026-08-23.**
   `scripts/capture_proxy.py`, `scripts/capture_sessions.py`,
   `scripts/capture.sh`, the `capture` and `sessions` compose services, 98 unit
   checks. Full account in `context/design/workstream-capture.md`; the entry is
   `versions.lock:workstream_capture`.

   Three things about it matter more than the fact that it exists.
   **The premise was partly wrong**: pi already keeps client-side transcripts —
   706 recoverable turns on this box, one of them 150 turns and 162 tool calls
   at 93,876 prompt tokens — and `--import-pi` reads them. What they lack is the
   system prompt and the tool schemas, which is most of the prompt and all of
   the surface this document is about, so they are labelled `gaps` and refused
   for a KLD corpus without an explicit override.
   **The corpus builder needed a control**, and it caught a real defect in
   itself: the obvious render drops a final assistant turn's tool call
   entirely (measured: 833 tokens against the server's own 905), and the
   sentinel-cut render reproduces the token stream exactly (905, delta +0).
   **And the tape immediately found something it was not looking for** — see
   `context/design/forge-on-the-tool-call-path.md`, which is the first thing a
   model-facing tape is good for and is not about quantisation at all.
3. ~~**Add a deep literal-copy-into-tool-call task to the bench.**~~ **DONE,
   2026-08-23.** `scripts/bench_literal.py`, the `literal` compose service and
   `./scripts/bench-literal.sh`. Eight literal shapes at both ends of the
   document, scored per field with a classifier whose buckets are the article's
   own observed failures. 224 comparisons across four runs, zero corrupted —
   see §4 and `versions.lock:literal_fidelity`.

   Two things about it are worth carrying forward more than the result is.
   **The classifier's first cut was wrong** and was caught by testing it against
   the article's four real examples rather than against its own design: it had a
   `len_same` bucket described as "the article's failure", but three of the four
   real cases change length. The signature of a flipped token is a shared prefix
   then divergence, whatever that does to the length. **And a clean negative
   needed a control that the shallow one does not provide** — every field passed
   there too, so the scoring path for a *wrong* field never executed. The probe
   now re-scores its own real response against deliberately wrong expectations
   and requires all four corruption classes to be flagged. A probe that returned
   `exact` unconditionally would have produced identical output up to that point.
4. ~~**Still open, and still the one that needs a reload: the q8_0-vs-f16 KLD
   run at 64K.**~~ **DONE 2026-08-24 at 4096 and 8192, with an exact null
   control — and 64K turns out to be unreachable, for reasons read out of
   perplexity.cpp rather than inferred.** See
   `context/design/kv-cache-fidelity-measured.md`. The corpus must hold 2*n_ctx
   tokens, so the deepest arm a real session can support is CTX_SIZE/2 = 49,152;
   and the ceiling is host RAM sized on n_ctx*n_vocab (~61 GiB resident at 64K
   on a 22 GiB box), not the VRAM §6 priced. The original text, for the record: It answers §4 properly, and its result would price the real trade —
   96K at q8_0 against ~64K at f16 — which is currently settled by default.
   **The corpus it was waiting for is now buildable in one command**
   (`./scripts/capture.sh export <id> --out /captures/corpus/deep.txt`), and the
   corpus that comes out is pinned to the server's own token counter. What is
   still needed is a real captured session to point it at — capture has to be
   ON for a working session first, which is a decision for whoever is next at
   the keyboard, not something to leave running by default.

5. ~~**New, and cheap, because the tape carries it already: does forge's history
   rewriting cost a re-prefill at depth?**~~ **DONE, 2026-08-24, and the answer
   is no.** Read off `s26b5bb`, the 29-turn workstream captured for item 4's
   corpus: `cache_n` grows monotonically 0 -> 66,750 across the session, never
   plateaus and never resets. 1,078,947 prompt tokens presented, **67,149
   actually prefilled** — 93.8% reused overall and 96.0% over the second half,
   with the largest single prefill 6,301 tokens against a 28,648-token prompt.
   The §4 pinning is real and is what `patches/forge_merge_across_tools.py`
   fixed: `s26b5bb` ran with that patch live and `FORGE_MERGE_ACROSS_TOOLS=0`.
   Without any reuse this session would have cost 16.1x the prefill it paid.
   No `=1` arm was run at this depth, so the counterfactual is the patch's
   mechanism plus §4's synthetic result, not a measurement. The three `rewrite` joins are pi's own ephemeral
   `[context budget]` notice, not forge. Full account in §4a of
   `forge-on-the-tool-call-path.md`. Cost: no GPU time — the tape already had
   it.

## 8. What this does NOT change

- **128K stays refused.** Nothing here bears on it; it is refused on measured
  VRAM at the in-use floor and this document adds no VRAM.
- **q8_0/q8_0 stays.** There is no measurement against it, only an untested
  exposure, and the alternative costs a third of the context window.
- **`REASONING_EFFORT=medium` stays**, now with outside corroboration.
- **Weights stay at UD-Q4_K_XL.** The article's 4-bit arms failing tool calls is
  the most uncomfortable line in it for this stack, and it should be read with
  its limits: NVFP4 ran as weight-only FP4 through Marlin rather than native FP4
  and came dead last; AWQ INT4 is group-32 asymmetric with an unrelated
  calibration set. Neither is a GGUF, neither is unsloth's mixed-precision UD
  scheme, and the article measures no llama.cpp quant at all. It is a reason to
  test this stack's own weights, not a reason to distrust them on someone else's
  numbers — and on 24 GiB there is no 8-bit alternative that leaves room for a
  96K window anyway.
- **No derivative/abliterated tune is in play here**, but if one is ever
  proposed for this stack, §1's part-3.11 numbers are the relevant prior:
  Heretic-ARA and Huihui preserved stock behaviour on long-context technical
  work; Blackfrost and AEON produced reproducible operational damage.
