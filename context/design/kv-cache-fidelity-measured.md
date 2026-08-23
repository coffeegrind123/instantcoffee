# The q8_0-vs-f16 KV cache, measured — and what the measurement needed first

Written 2026-08-24. Closes §7 item 4 of
`context/design/inference-divergence-and-this-stack.md`, which had stood open
since the divergence read: *this stack adopted q8_0 KV on throughput and VRAM
and never on fidelity.*

The short version, and it is not the one §4 expected:

- **The null control is exact.** f16 against f16, two separate processes, same
  corpus, same flags: **KL divergence 0.00000, same-top-1 100.000%, Δp RMS
  0.000%** on every chunk, and the test arm's per-chunk PPL reproduces the base
  arm's own to four decimal places. The instrument has no floor to subtract.
- **q8_0 KV costs almost nothing in perplexity and a real amount in the tail.**
  At n_ctx 4096 the model's perplexity is essentially unchanged, while 4.7% of
  tokens change their top-1 and the 99th-percentile KLD is 3.2.
- **The headline `Mean PPL(Q)/PPL(base) = 1.165` from the first run is an
  artefact and must not be quoted.** It is a property of how `llama-perplexity`
  stores its base log-probs, it appears identically in the null control, and
  §"The 16.5-nat floor" below is the source line that causes it.
- **Three limits, read out of the tool's source, retire the plan §6 had
  priced.** The deepest arm a real workstream can support here is CTX_SIZE/2;
  the ceiling is host RAM sized on `n_ctx * n_vocab`, not VRAM; and perplexity
  does not parse control tokens.
- **And one fact that scopes all of it, which was not written down anywhere:
  `qwen35` is a hybrid, and only 16 of its 64 layers have a KV cache.** Every
  fourth layer is attention; the other 48 are state-space with a fixed-size
  recurrent state that `-ctk/-ctv` cannot touch. So this measures the cost of
  quantising a quarter of the model's state. §3c.

## 1. The corpus, and why nothing could run without it

`/captures/corpus/deep-s26b5bb.txt` — 259,616 chars, **69,440 tokens**, 62
messages, 16 tool schemas, rendered from a real 29-turn `pi` workstream through
llama's own `/apply-template`.

```
   CONTROL: server reported 69440, the corpus tokenizes to 69440 (delta +0) -> OK
```

Delta +0, tool block intact, no declared gaps. The transcript-import route fires
the same control at **−5,979** (6.3%, and the missing 6.3% is the tool block),
which is why `kld-run.sh` refuses an unpinned corpus by default. Full account of
how it was driven in `context/design/workstream-capture.md` and the 2026-08-23
handoff.

## 2. Three limits, read from the source rather than inferred

All three are in `tools/perplexity/perplexity.cpp` at the pinned tag
(`LLAMA_TAG=server-cuda-b10573`). Each invalidates part of §6 of the divergence
document, which had priced this run on VRAM.

```
   (1)  if (int(tokens.size()) < 2*n_ctx) { error; return; }

        Only the SECOND half of each chunk is scored (`const int first =
        n_ctx/2`); the first half is context. So a corpus must hold 2*n_ctx
        tokens. CONSEQUENCE, and it is structural: a server with a CTX_SIZE
        window can only ever emit a captured prompt of CTX_SIZE tokens, so the
        deepest arm a REAL workstream can support is CTX_SIZE/2 — 49,152 here.
        The 64K §6 asks for is not reachable from real traffic at all; it would
        need a corpus twice this server's own context window.

   (2)  logits.reserve(size_t(n_ctx) * n_vocab)      4 B per entry
        log_probs.resize(size_t(n_ctx) * nv)         2 B per entry
        nv = 2*((n_vocab + 1)/2) + 4

        HOST RAM IS THE CEILING, AND IT IS SIZED ON n_vocab. `reserve` commits
        address space; the resident cost is the rows actually inserted — only
        positions >= n_ctx/2 produce output — plus the whole of `log_probs`,
        which `resize` zeroes and therefore faults in completely:

            (n_ctx/2) * n_vocab * 4  +  n_ctx * nv * 2

        This model's n_vocab is 248,320, so per 1,024 tokens of n_ctx that is
        ~1.42 GiB of address space and ~0.95 GiB actually resident. Measured
        against this box's 22 GiB:

            n_ctx   4096    reserve   5.68 GiB   resident   3.79 GiB
            n_ctx   8192    reserve  11.37 GiB   resident   7.58 GiB
            n_ctx  16384    reserve  22.73 GiB   resident  15.16 GiB
            n_ctx  65536    reserve  90.94 GiB   resident  60.63 GiB

        The card is irrelevant to any of it, and §6's careful "~20.8 GiB at 64K
        fits" is true and never binds.

   (3)  common_tokenize(ctx, params.prompt, true)    parse_special defaults false

        perplexity tokenizes `<|im_start|>` as ORDINARY TEXT. There is no flag —
        the whole argument list was checked. Both arms see the identical
        sequence so the COMPARISON is unaffected, but the sequence is not the
        one the model saw at serve time. Bracketed by the chunk counts: llama's
        own /tokenize says 69,440; perplexity's count is between 69,632 and
        73,727. Not narrowed further, because perplexity prints its token count
        only on the error path.
```

`scripts/kld-run.sh` refuses on (1) and (2) in preflight and reports (3), with
the source lines in comments.

### A wrong constant in a guard is worse than no guard

The preflight for (2) originally hardcoded `n_vocab = 151936` — Qwen3-8B's, not
this stack's. Against the model actually pinned here it under-predicted host
memory by 63%, and it printed `n_ctx 16384  ok: ~14244 MiB` for a pass that
wanted ~15.2 GiB resident on a box with 13.9 GiB free. It answered
confidently and it answered wrong.

`gguf_n_vocab()` now reads `tokenizer.ggml.tokens`' array count straight out of
the GGUF metadata block — under 2 KB of I/O, no server needed — and if it cannot,
the memory verdicts are **not printed at all** rather than computed from a
guess. It is cross-checked for free: `llama_vocab_n_tokens()` is the same
number perplexity writes into the logits file's header, which `verify_logits()`
reads back from an independent source after every base pass.

## 3. The null control, which is what makes the rest quotable

`--null-control` prepends the base arm's own KV type to the list of test arms,
so f16-vs-f16 runs first, against the **same** logits file the q8_0 arm will
read. Two independent processes, same weights, same corpus, same flags.

```
   chunk        PPL      ln(PPL(Q)/PPL(base))   KL Divergence     Δp RMS     Same top p
      1      3.0414          0.00279            0.00000 ± 0.0    0.001 %    100.000 %
      2     17.3035          0.33411            0.00000 ± 0.0    0.000 %    100.000 %
      3      8.2723          0.22274            0.00000 ± 0.0    0.000 %    100.000 %
      4      8.6474          0.20601            0.00000 ± 0.0    0.000 %    100.000 %
      5      6.3832          0.16481            0.00000 ± 0.0    0.000 %    100.000 %
     ...
```

**KL divergence 0.00000 and same-top-1 100.000% at every chunk**, and the
`PPL` column reproduces the base arm's own running estimate
(`[1]3.0414,[2]17.3035,[3]8.2723,[4]8.6474,[5]6.3832,…`) digit for digit. The
totals:

```
   ====== Perplexity statistics ======          ====== KL divergence ======
   Mean PPL(Q)      :  11.605510               Mean    KLD:   0.000000
   Mean PPL(base)   :   9.916506               Maximum KLD:   0.000067
   Mean PPL(Q)/PPL(base): 1.170322             99.0%   KLD:   0.000037
                                               Median  KLD:   0.000000
   ====== Token probability ======             Minimum KLD:  -0.000070
   Mean    Δp: -0.000 %
   Maximum Δp:  0.006%                         RMS Δp    :  0.001 %
                                               Same top p: 100.000 ± 0.000 %
```

`Mean PPL(Q) = 11.605510` is the base arm's `Final estimate: PPL = 11.6055`,
recomputed in a different process by a different function, to six figures. The
residual KLD of ±7e-5 is the size of the uint16 log-prob quantisation step
(at most 16/65535 = 2.4e-4 in log-prob units), not a difference in output.
**The comparison is exact and the CUDA path is reproducible across processes**,
so the q8_0 numbers below are divergence rather than instrument noise — which is
precisely what the first run of this experiment could not say.

### The 16.5-nat floor: why `Mean PPL(base)` is not the base model's perplexity

Look at the third column above. The null control — f16 against **itself** —
reports `ln(PPL(Q)/PPL(base))` up to 0.334. It cannot be a KV-type effect;
there is only one KV type in the run.

The cause is the storage format, and both halves are in `perplexity.cpp`:

```
   writer, log_softmax(n_vocab, logits, log_prob, tok):
       min_logit = std::max(min_logit, max_logit - 16);
       const float min_log_prob = min_logit - max_logit - log_sum_exp;
       const float scale = (max_logit - min_logit)/65535.f;
       log_prob[i] = logits[i] > min_logit ? nearest_int(inv_scale*(...)) : 0;

   reader, log_softmax(..., base_log_prob, tok, kld):
       const float nll_base = -(scale*base_log_prob[tok] + min_log_prob);
```

The base log-probs are stored as uint16 over a window **clamped 16 nats below
the maximum logit**. Any token whose true negative log-likelihood exceeds
`16 + log_sum_exp` — call it ~16.5 nats, p < 1e-7 — is recorded as exactly that
value. `Mean PPL(base)` is therefore biased **low**, by an amount that grows
with how many genuinely surprising tokens a chunk holds. That is exactly the
observed shape: after chunk 1 (PPL 3.0) the running gap is 0.003; after chunk 2,
which on its own scores around PPL 98, it is 0.334.

Two consequences.

- **`Mean PPL(Q)/PPL(base)` is not a quantisation penalty.** The null control
  reports **1.170322** for f16 against itself; the q8_0 run reported
  **1.164857**. The ratio is *larger* when there is no quantisation at all. The
  right comparison is the test arm's `Mean PPL(Q)` against the base arm's own
  `Final estimate`, or against the null control's `Mean PPL(Q)` — all three are
  computed live from real logits, by the same code, over the same tokens.
- **The KLD statistics are not affected the same way.** The reader excludes
  base terms below the floor from the KL sum outright (`if (p_log_base >
  -16.f)`) rather than valuing them wrongly, and the null control returns
  0.00000 — which is the direct evidence, not the argument.

**Correction to the 2026-08-23 handoff**, which attributed this gap to
`perplexity()` scoring from `first = min(512, n_ctx/2)` while `kl_divergence()`
scores from `first = n_ctx/2`. At this tag **both are `n_ctx/2`** —
perplexity.cpp:542 and perplexity.cpp:1792. The windows are identical; the
storage is not. Nobody should re-derive the wrong explanation.

## 3a. The result: q8_0 KV against f16 KV

Same corpus, same base logits file, the only difference `-ctk/-ctv`.

**The 4096 column was produced twice** — 2026-08-23 without a null control, and
2026-08-24 with one, against a base logits file written from scratch in a
different process — and every printed digit matched: `Mean PPL(Q) 11.551316`,
`Mean KLD 0.136965`, `Same top p 95.284 ± 0.114 %`. Teacher-forced perplexity on
this stack is reproducible run to run, not merely within a run.

```
                                     n_ctx 4096      n_ctx 8192
   chunks scored                         17               8
   tokens scored                     34,799          32,760

   PPL, f16 KV      (base arm)      11.6055         16.0634
   PPL, q8_0 KV     (test arm)      11.5513         16.0893
   q8_0 / f16                        0.9953          1.0016

   Mean    KLD                       0.13697         0.21802
   Median  KLD                       0.00101         0.00108
   90.0%   KLD                       0.02592         0.04745
   95.0%   KLD                       0.10826         0.23770
   99.0%   KLD                       3.2328          7.1081
   99.9%   KLD                      19.9186         22.6297
   Maximum KLD                      31.7209         33.7666

   Mean    Δp                        -0.014 %        +0.008 %
   RMS     Δp                         5.148 %         5.746 %
   Same top-1                        95.284 %        94.087 %

   NULL CONTROL (f16 vs f16)         KLD 0.000000, same top-1 100.000 %
```

**Perplexity is not where the cost is.** 0.9953 and 1.0016 — under half a
percent, in opposite directions. On this corpus, at these depths, q8_0 KV has no
systematic perplexity penalty at all. (Use these ratios and not
`Mean PPL(Q)/PPL(base)`, for the reason in §3.)

**The distribution is where the cost is, and it is all in the tail.** The median
token moves by KLD 0.001 — nothing. The 90th percentile is still 0.026. Then it
climbs hard: 3.2 at the 99th percentile and 31.7 at the maximum. Mean Δp is
−0.014%, i.e. **unbiased**, while RMS Δp is 5.1% and the extremes reach ±99.999%
— a small number of tokens whose probability is essentially replaced.

**4.7% of tokens change their top-1 at 4096, and 5.9% at 8192**, against a null
control of exactly 0.000%. That is the number to carry: it is not instrument
noise, it is not a broken comparison, and it is what "diverges, then recovers"
looks like when you measure it token by token rather than by reading the output.

### What this does and does not settle

- It is **two depths on one corpus, at 4096 and 8192**. Limits (1) and (2) above
  are why it is not 64K: the corpus would have to be twice this server's own
  context window, and the base arm would want ~61 GiB resident on a 22 GiB box.
- Both depths are **far below where this stack actually runs** (96K), and the
  article's own claim is that divergence grows past ~40k. Two points with the
  aggregate moving the wrong way between them is not a trend — see §5.
- It says nothing about whether a 4.7% top-1 flip rate is *visible* in output.
  `literal_fidelity` says the opposite on the one failure surface it covers: 224
  literal comparisons into tool-call arguments at up to 90k, zero corrupted. A
  teacher-forced distribution shift and an observable behaviour change are
  different measurements, and this stack now has both.

## 3b. A silent short write, and the guard that now catches it

`perplexity.cpp` writes the base logits with four unchecked calls:

```
   logits_stream.write("_logits_", 8);
   logits_stream.write((const char *)&n_ctx,   sizeof(n_ctx));
   logits_stream.write((const char *)&n_vocab, sizeof(n_vocab));
   logits_stream.write((const char *)tokens.data(), n_chunk*n_ctx*sizeof(tokens[0]));
   out.write((const char *)log_probs.data(), size_t(n_token)*nv*sizeof(uint16_t));
```

There is no `if (!logits_stream)` anywhere in the file. So when a write comes up
short, `ofstream` latches `badbit`, **every subsequent write becomes a no-op**,
and the process still exits 0. The failure only surfaces one process later as

```
   kl_divergence: failed reading log-probs for chunk 0
```

which reads like a corrupt file of unknown provenance — and the test arm exits 0
too.

**Observed twice at n_ctx 16384 on this box**, 2026-08-23 and again 2026-08-24:

```
   header    n_ctx=16384 n_vocab=248320 n_chunk=4 nv=248324
   per chunk 4,068,043,768 bytes of log-probs
   expected  16,272,437,236
   actual       594,062,932
   verdict   TRUNCATED, short by 15,678,374,304 bytes (3.854 chunks)
             0 of 4 chunks are complete; the test arm will
             fail reading log-probs for chunk 0
```

593,800,768 of chunk 0's 4,068,043,768 bytes landed and then nothing else did —
the signature of `badbit` latching on the first failure.

**What it is not.** Three explanations were tested and refused:

- **Not disk.** 7.7 TB free on the tape throughout.
- **Not the kernel's single-write cap.** Linux `write(2)` does cap at
  `0x7ffff000` (2,147,479,552) — measured directly, `os.write()` of 2.49 GB
  returns exactly that — but libstdc++'s `xwrite()` loops until the request is
  satisfied. A compiled probe issuing the identical 4,068,043,768-byte
  `ostream::write` **to the same 9p directory** returns `good=1`,
  `tellp=4068043768`, a complete file, and reads back with `gcount` intact.
- **Not the 9p mount as such**, for the same reason: the probe writes there
  successfully. It also succeeds under `--memory=8g`.

**What it is, on the balance of the evidence.** Memory pressure. The 16384
base arm runs at ~15.2 GiB resident on a 22 GiB box shared with other
containers; the same probe completes in seconds under `--memory=8g` and does not
finish within two minutes under `--memory=5g`. That is the correlation, not a
captured errno — nobody has yet read what the failing `write(2)` actually
returned. The preflight now says so in
those terms rather than calling it "tight", and `verify_logits()` sizes the file
against its own header after every base pass — so a short write is named at the
producing end, by the arm that caused it, instead of being discovered as a read
failure in the next process.

`verify_logits()`'s four paths (complete, truncated, bad header, missing) were
each exercised against fabricated files before this run, because a guard whose
failure path has never executed is not a guard.

## 3c. What `-ctk/-ctv q8_0` actually quantises here: 16 layers out of 64

Read out of the GGUF, then confirmed against the tensor table, because this
changes how every number above should be read and it was not written down
anywhere.

```
   general.architecture          = qwen35
   qwen35.block_count            = 65          (64 layers + one MTP head at blk.64)
   qwen35.context_length         = 262144
   qwen35.full_attention_interval = 4
   qwen35.ssm.conv_kernel        = 4
   qwen35.ssm.state_size         = 128
   qwen35.ssm.group_count        = 16
   qwen35.ssm.inner_size         = 6144
```

```
   blocks carrying attn_q/attn_k tensors (17): 3 7 11 15 19 23 27 31 35 39
                                               43 47 51 55 59 63  + 64 (MTP)
   blocks carrying ssm_* tensors        (48): 0 1 2 4 5 6 8 9 10 12 ...
```

**This is a hybrid: every fourth layer is real attention, the other three are
state-space.** So a KV cache exists in **16 of 64 layers**, and `-ctk/-ctv q8_0`
quantises those and nothing else. The 48 SSM layers carry a fixed-size recurrent
state (conv state plus SSM state) that the flag does not touch and cannot.

Three consequences, and the first is the one that matters:

- **The q8_0 result in §3a is a result about a quarter of this model's state.**
  0.5% perplexity and a 4.7% top-1 flip rate are what quantising 16 layers'
  K and V buys. The same flag on a dense model of the same size would touch four
  times as much. `versions.lock:kv_cache` and §4 of the divergence document both
  read as though "the KV cache" were the whole story; on this architecture it is
  not, and the article this stack is comparing itself against measured dense
  transformers.
- **It gives §3d a mechanism.** 48 layers compress all history into a state of
  fixed size, so a token's loss depends on how much history it is carrying, and
  more history means more of it has been squeezed out. perplexity scores tokens
  at positions `n_ctx/2 .. n_ctx-1`, so raising n_ctx *directly raises how much
  history every scored token has*: 2,048–4,095 tokens at n_ctx 4096 against
  8,192–16,383 at 16384. A pure-attention model would not care. This one is
  measured getting worse on **both** corpora, which is the direction a
  fixed-size state predicts.

  This is a hypothesis consistent with the evidence, not a proof — it does not
  by itself explain why the two corpora degrade at different rates (×1.8 and
  ×3.9), though "how much of the content depends on distant history" plausibly
  would. What would settle it is scoring the *same* tokens at two different
  history lengths.
- **`context_length = 262144`**, so nothing here is context-length overflow, and
  perplexity's `model was trained on only …` warning was right not to fire.

## 3d. The open one: perplexity climbs steeply with n_ctx

This is not a KV-cache question — both arms see it, and the base arm sees it with
no test arm in the run at all — but it is the reason the depth sweep stops at
8192, so it belongs here.

Two corpora, f16 KV, no logits file in the run, everything else identical. The
last column drops chunk 1, because chunk 1's scored window starts at `n_ctx/2` —
a different point in the document at every depth — and on a corpus that opens
with a ~5,700-token block of tool schemas that one chunk dominates the average:

```
   corpus            n_ctx    chunks    PPL      chunk 1    PPL ex-chunk 1
   deep-s26b5bb       4096      17     11.61        3.04         12.62
   deep-s26b5bb       8192       8     16.06       28.89         14.77
   deep-s26b5bb      12288       5     72.16      497.63         44.53
   deep-s26b5bb      16384       4     94.00      653.52         49.25
   pi-150turn         4096      22     23.99    49158.45         16.69
   pi-150turn        16384       5     32.90       47.48         30.02
```

**Both corpora get worse with depth, and dropping chunk 1 does not rescue it**
— ×3.9 on `deep-s26b5bb` from 4096 to 16384, ×1.8 on `pi-150turn`. So this is
not one corpus's partition artefact, though the corpus clearly modulates the
size of it. On `deep-s26b5bb` there is a **step between 8192 and 12288** —
14.77 to 44.53, a factor of 3 for a factor of 1.5 in depth — that a smooth
degradation does not explain.

It is **reproducible and deterministic** — `[1]653.5247,[2]226.9466,[3]153.0130`
to four decimal places on 2026-08-23, on 2026-08-24, and again with no logits
file in the run.

§3c gives this a candidate mechanism that is a property of the model rather than
a defect: 48 of its 64 layers are state-space, with a fixed-size state, and
raising `n_ctx` directly raises how much history every scored token carries.

### What has been refused, so nobody re-walks it

- **Not the logits file, and not memory.** D1: the same pass with
  `--kl-divergence-base` omitted entirely — no 7.6 GiB `log_probs` buffer, no
  writes, 21.75 s/pass instead of 249.95 with no swapping — returns
  `[1]653.5247 … Final estimate: PPL = 94.0001`. Byte-identical.
- **Not the batch count**, tested in both directions. Only positions
  `>= n_ctx/2` request logits, so n_ctx changes how many logits-bearing batches
  a chunk splits into (1 at 4096, 2 at 8192, 4 at 16384) — a plausible-looking
  confound, and false:

  ```
     C1   -c 4096  -b 512    4 logits batches   PPL 11.6055   (= -b 2048)
     C2   -c 8192  -b 8192   1 logits batch     PPL 16.0634   (= -b 2048)
  ```

  Every per-chunk figure matched too. Perplexity depends on `n_ctx` and not on
  how the chunk is batched.
- **Not the model's trained context.** perplexity.cpp:2065 warns
  `model was trained on only %d context tokens (%d specified)` when
  `params.n_ctx > n_ctx_train`. It did not fire at 16384, and the same log
  carries 15 other W-level lines — so the warning path works. The GGUF says
  `qwen35.context_length = 262144`, which is why.
- **Not one corpus.** `pi-150turn`, a different capture entirely, degrades in
  the same direction (×1.8 rather than ×3.9).
- **Not flash attention, and not the physical ubatch.** Both move the number by
  a percent or two, in the same direction at both depths, which is kernel
  numerics rather than a depth effect:

  ```
     C5   -c 16384 -fa off               93.0580   (-fa on: 94.0000)   -1.0 %
     C6   -c 16384 -fa on   -ub 2048     91.7255   (-ub 512: 94.0000)  -2.4 %
     C7   -c  4096 -fa off               11.5284   (-fa on: 11.6055)   -0.7 %
  ```

  C7 is what makes C5 readable: `-fa off` is worth about the same 1% at 4096 as
  at 16384, so it is not selectively rescuing or breaking anything at depth. On
  this architecture flash attention only touches the 16 attention layers anyway
  (§3c).

### What has not been tested yet

The direct test of §3c's mechanism: score the **same tokens** at two different
history lengths. perplexity's chunking cannot do that on its own — position in
the chunk and amount of history move together — so it needs either a corpus
prefixed with filler to shift a region's position, or `perplexity_v2`'s
`--ppl-stride` mode, which scores with a fixed history window.

None of this changes the q8_0 result in §3a, which stands at 4096 and 8192 with
an exact null control under it — both arms are the same architecture at the same
depth. It does mean **cross-depth comparison of absolute PPL on this stack
should not be trusted**, and that the article's "divergence grows past ~40k"
cannot be tested here by this route.

## 4. Reproducing any of it

```
   ./scripts/kld-run.sh --corpus /captures/corpus/deep-s26b5bb.txt \
       --depths 4096 --null-control
```

One base pass writes the logits; the null control and the q8_0 arm both read
that same file. `--keep-logits` keeps it (17.3 GB at 4096 for this model) so it
can be sized and inspected. `--dry-run` prints every command and stops nothing.

`llama-perplexity` loads its own copy of the weights, so `qwen38-llama` must be
stopped for the run; the script does that itself and restarts it on any exit
path. **`--load-mode none` is not optional** for any direct `docker run` of the
llama image here — without it, demand-paging the GGUF through the 9p bind mount
runs at 6.4 MB/s of resident growth and is indistinguishable from a hang.
