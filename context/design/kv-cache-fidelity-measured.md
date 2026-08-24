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
- **The depth anomaly is real, and it is not a partition artefact.** §3e:
  scoring the SAME tokens at two history lengths — by rotating the corpus behind
  a filler prefix rather than by placing a region in it — gives 6.35 at n_ctx
  2048 and 12.24 at 4096. x1.93 in perplexity for x2 in history, with the
  instrument's own alignment control passing at 0.72x its printing floor.
- **And the degradation is a CLIFF, not a slope — so quote the distribution,
  not the mean.** On a 161,254-token corpus with 64/32/16 chunks per rotation
  and a control passing at 0.8x its floor, the aggregate goes 13.32 / 28.54 /
  86.14 — but across thirty spans the 8192/2048 ratio has a **median of 1.74**,
  sixteen of thirty move less than 2x, nine move more than 10x, and one moves
  149,597x. Dropping that one span takes the 8192 aggregate from 86.14 to
  59.32.
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

**Read §3e first if you only want the answer.** The confound this section could
not remove — that changing `n_ctx` changes WHICH tokens are scored — was removed
on 2026-08-24 by a different instrument, and the effect survives it: on an
identical token set, doubling the history roughly doubles perplexity. What
follows is the observation as it stood, and the list of things already refused,
which is still what stops anyone re-walking them.

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

### The direct test was attempted on 2026-08-24, and the route is closed

The test is: score the **same tokens** at two different history lengths.
perplexity's default chunking cannot do it — position in the chunk and amount of
history move together — but `perplexity_v2`, selected by `--ppl-stride`, can, and
it is present at the pinned tag. Its scoring rule was read out of
`perplexity.cpp:296-441` before anything was run:

```
   chunk i covers tokens [i*stride, i*stride + n_ctx)
   llama_memory_clear() at the top of every chunk
   scored: j = n_ctx-stride-1 .. n_ctx-2   -> the LAST `stride` tokens

   so chunk i of a window W scores [i*S + W - S, i*S + W - 1],
   every scored token carries W-S..W-1 tokens of history,
   and W2's chunk k IS W1's chunk k + (W2-W1)/S, token for token.
```

That arithmetic is right, and it was confirmed against a real run: `-c 1792`
with `--ppl-stride 512` produced `Calculation chunk = 2048`, `n_seq=1`, 133
chunks — the `params.n_ctx += params.ppl_stride/2` at perplexity.cpp:2043
behaving exactly as read. **Two arms at different windows would have scored
identical token sets. The instrument is correct.**

**It is unusable on this stack for two independent reasons, and the second one
cost the operator their machine.**

- **It is ~20x slower per token.** perplexity_v2 took **144.35 s to decode one
  2048-token chunk** — 14 tok/s — against 558 tok/s for the default mode's
  4096-token chunk in the same image, same weights, same f16 KV
  (`.kld-logs/20260823T210410Z/base-f16-4096.log`, 7.34 s/pass). The timer
  closes before the scoring loop, so this is decode, not softmax. At that rate
  the shallowest arm alone is 5 h 20 m and the intended 2048/4096/8192 ladder is
  over two days. **The cause was NOT isolated**: two things differ from the
  default mode at once — `-b 512` against `-b 2048`, and v2's unconditional
  `common_batch_add(..., /*logits=*/true)` requesting output for every position
  rather than only for `pos >= n_ctx/2`. Either could be the 20x.
- **It deadlocked the Windows host, twice.** v2 accumulates the whole chunk's
  logits into one `std::vector<float>` with no `reserve()` — `n_ctx * n_vocab`
  floats, and n_vocab is 248,320 here:

  ```
     W = 2048   ->  2.0 GiB final,   3.1 GiB peak across the last realloc
     W = 4096   ->  4.1 GiB final,   6.1 GiB peak
     W = 8192   ->  8.1 GiB final,  12.2 GiB peak
  ```

  on top of the 17.9 GB of weights `--load-mode none` reads into RAM, on a
  22 GiB Docker VM shared with every other container on the box. Not an OOM
  kill and not a slow run: **the host stopped and had to be recovered by hand.**
  Once on the run itself, and once more on a four-config timing probe that would
  have isolated the 20x — which is why it is still not isolated.

**The guard computed the danger correctly and then waved it through.** The
preflight in `scripts/ppl-stride-run.sh` printed `peak ~12125 MiB` before the
run that killed the box. It classified that as `TIGHT` — a warning — because
free plus swap covered it on paper. *Swap covering a 12 GiB spike is not the
same as the machine surviving it.* There is no safe verdict between "ok" and
"refused" for an allocation of this shape, and `TIGHT` is now a refusal.

The script is **disarmed**: it exits 1 without `--i-have-read-the-deadlock-note`
and prints why. `--dry-run` still works and allocates nothing, which is the
reason it was kept rather than deleted.

**What survived, and is worth having:**

- `scripts/ppl_stride_analyse.py` and its 19 tests. It recovers per-chunk NLL
  from v2's running series by differencing (`nll_cum(i) = i*S*ln(printed_i)`),
  maps chunks to absolute token ranges, and aligns arms across windows. The
  load-bearing test synthesises logs from an NLL that depends only on absolute
  token index — correctly aligned arms must then agree exactly — and there is a
  control for that control: a deliberate one-chunk offset must break the
  agreement, and does. If v2 numbers ever arrive by another route, this aligns
  them.
- **perplexity's own token count for this corpus is 70,053.** v2 prints it
  unconditionally (`have %zu tokens`) where the default mode prints it only on
  the error path — so this run closes limit (3)'s bracket of [69,632, 73,727] to
  an exact number. Against llama's own `/tokenize` count of 69,440 with control
  tokens parsed, `parse_special = false` costs **+613 tokens, +0.88%**.

**If the depth question is picked up again, it needs a different instrument.** A
corpus prefixed with filler to shift a region's position, scored by the DEFAULT
mode, does the same job with the default mode's memory profile and speed. That
route was never tried and is not known to be dangerous.

### What has not been tested yet

None of this changes the q8_0 result in §3a, which stands at 4096 and 8192 with
an exact null control under it — both arms are the same architecture at the same
depth. It does mean **cross-depth comparison of absolute PPL on this stack
should not be trusted**, and that the article's "divergence grows past ~40k"
cannot be tested here by this route.

## 3e. The depth question, answered on a matched token set

Measured 2026-08-24 with `scripts/ppl-depth-run.sh`. §3d's one surviving
confound was that default-mode perplexity scores a DIFFERENT SET OF TOKENS at
every depth, so its ladder compared 17 chunks of one partition against 8 chunks
of another. This removes exactly that and changes nothing else.

### The instrument, and why the obvious version of it does not work

From `perplexity.cpp:542-600` at the pinned tag, read before anything ran:

```
   first = n_ctx/2
   tokens_data = tokens + start + first
   process_logits(..., tokens_data, n_ctx - 1 - first, ...)   scores [i+1]
```

so chunk `j` scores absolute offsets `[N/2+1, N-1]` — **the whole top half,
never a subrange** — and a scored token's history is exactly its offset.

The plan carried in the 2026-08-24c handoff was to place a 1024-token region at
offset `N/2` in a 2048 arm and an 8192 arm and call them "the same tokens". They
are not: the 8192 arm's chunk also scores the 3071 corpus tokens that follow the
region and emits ONE number for all 4095 of them. R's contribution is not
separable, and no filler placement makes it so, because the scored set is always
the top half.

**Rotation works where placement cannot.** Prefix the corpus with exactly `N/2`
tokens of filler and every corpus token moves half a chunk, so the pass scores
the exact COMPLEMENT of the unprefixed pass:

```
   F = 0      chunk j scores corpus [jN + N/2 + 1,  jN + N - 1]
   F = N/2    chunk j scores corpus [jN + 1,        jN + N/2 - 1]
```

Two passes per depth. Their union is every corpus token in the window, each
scored exactly once, each with history in `[N/2+1, N-1]` — **the same token set
at 2048, 4096 and 8192**, which is the comparison §3d could not make.

Chunks whose scored range is not wholly inside the analysis window are dropped,
and that is not cosmetic: in the `F = N/2` pass, chunk 0's scored corpus tokens
carry `N/2` tokens of FILLER as their history, and there is more of it at larger
`N`. Keeping them would charge the deeper arm more filler-context than the
shallow one — the exact shape of confound this exists to remove.

### The result

Corpus `deep-s26b5bb`, analysis window corpus `[8192, 65536)`, f16 KV, `-b 2048`,
`-fa on`, no `--kl-divergence-base` anywhere:

```
   n_ctx    PPL        tokens scored    history       rotation spread
    2048     6.3521       57,288        1025..2047          9.0 %
    4096    12.2366       57,316        2049..4095         22.1 %
    8192    57.9907       57,330        4097..8191       1441 %   <- see below
```

**2048 -> 4096 is the clean result: x1.93 in perplexity for x2 in history, on a
token set that is 99.93 % identical.** §3d's partition confound is refuted as the
explanation — the effect is not an artefact of which tokens each depth happened
to score.

`rotation spread` is the free yardstick, and it is worth more than any argument.
The two rotations at one depth score **complementary halves** of the corpus —
50 % disjoint, the largest token-set difference this design can produce — at an
IDENTICAL history distribution. Whatever they differ by is pure corpus
heterogeneity with no depth in it. At 2048 and 4096 that is 9 % and 22 %, while
the cross-depth difference is 93 %, and the two arms are 0.073 % disjoint rather
than 50 %.

### Why the token sets are not exactly identical, and by how much

Each arm's union misses the multiples of its own `N/2`: 55 tokens at 2048, 27 at
4096, 13 at 8192, out of a 57,343-position window. The misses are **nested** —
multiples of 4096 are multiples of 2048 are multiples of 1024 — so the whole
discrepancy between the shallowest and deepest arm is the 42 tokens the deep arm
scores and the shallow one does not, 0.073 %. Charging those 42 tokens a
deliberately absurd 12 nats each moves the deep arm's perplexity by 0.583 %.

### The controls, all four of which ran before any number was read

- **The filler's length under PERPLEXITY'S OWN tokenizer**, read off its error
  path (`tokenizes to only %zu tokens`), which is the only place default mode
  ever prints a token count. `llama-server`'s `/tokenize` does NOT agree with it
  — it parses control tokens and perplexity does not — so the builder's count is
  a prediction until this confirms it:

  ```
     corpus alone   70,053
     + f1024        71,077   delta 1024   exact
     + f2048        72,101   delta 2048   exact
     + f4096        74,149   delta 4096   exact
  ```

  70,053 is also an independent reproduction of the count `perplexity_v2` printed
  on 2026-08-24 before that route was closed.

- **The whole-chunk alignment control**, run at 2048 and again at 8192. The same
  corpus behind a filler of a WHOLE chunk must reproduce every per-chunk NLL,
  shifted by one chunk index —
  `llama_memory_clear` at the top of every chunk (perplexity.cpp:558) means its
  later chunks are bit-identical work. 32 chunk pairs at n_ctx 2048: worst
  per-chunk difference **4.75e-4 relative, 0.72x the log's own four-decimal
  printing floor; 8 pairs at n_ctx 8192, 1.36e-5 relative, 0.5x. Both PASS.** The verdict is a ratio against a floor derived from
  the log rather than a threshold someone picked; on synthetic logs the same
  test reads 0.5x for an exact match, 22x for a filler off by ONE token and
  2338x for an offset off by one chunk.

- **Reproduction of the number being explained.** The `F = 0` pass at n_ctx 8192
  returns `Final estimate: PPL = 16.0634` — §3d's own figure for that depth, to
  four decimals, from a different run on a different day.

- **The batching is identical across arms.** All five passes report
  `batch_size=2048, n_seq=1`; §3d's C1/C2 already refused batch count as a cause
  in both directions.

### The 8192 arm is not a measurement, and the reason is the corpus rather than the instrument

`57.9907` is the union of a rotation that returned 14.77 and one that returned
227.67. At 2048 and 4096 the rotations agree to 9 % and 22 %; at 8192 they do not
agree at all. **Four rotations were then run at that one depth** — `F` = 0, 2048,
4096, 6144 — because `F` and `F + N/2` are complements, so `{0, 4096}` and
`{2048, 6144}` are two INDEPENDENT PARTITIONS OF THE SAME TOKENS differing only
in where the chunk boundaries fall. Agreement means the effect is a property of
the content; disagreement means it is a property of where the boundary fell.

**The instrument is exact at this depth**, so none of what follows is a
mechanical artefact. The whole-chunk alignment control was run again AT 8192 —
a filler of a full chunk must reproduce every per-chunk NLL shifted by one chunk
index — and passed at **1.36e-5 relative, 0.5x the log's own printing floor**,
tighter than the 2048 control's 0.72x. And every number below is deterministic:
`F = 0` and `F = 4096` were re-run from scratch in the second run and reproduced
the first run's eight per-chunk running values **byte for byte**.

```
   per-chunk PPL at n_ctx 8192, in corpus order, window [8192, 65536)

     F=0        18.25     6.24    10.92    22.13    21.66     6.19    41.60
     F=2048    371.96   162.05    10.92    17.38    44.02     2.54    68.42
     F=4096   1065.10   275.45   792.45    60.99   143.66   523.79    29.71
     F=6144     26.42    71.04   108.85    59.93    76.86    14.67
```

**The answer is neither reading: the sample is too small and too heavy-tailed
for an arm figure to exist at this depth on this corpus.** Per-chunk perplexity
spans 2.54 to 1065.10 — 2.6 orders of magnitude — over six or seven chunks per
rotation, and the two partitions disagree by a factor that depends on the window
and **reverses direction between the mean and the median**:

```
   partition        aggregate PPL                     median chunk PPL
                win [10241,63488)   [14337,59392)
   {0, 4096}          46.78             53.78                35.66
   {2048, 6144}       41.85             32.81                59.93
```

A mean and a median that disagree about which of two samples is the larger is
the signature of too few draws from a heavy tail, not of a resolved effect.
Against that, the 1.1x-1.7x spread between partitions is not evidence of a
boundary-placement effect and the 15x spread between individual rotations is not
evidence of a content effect. **Neither is separable here.**

**The limit is structural and it belongs to the corpus, not the instrument.**
§2's limit (1) says a captured workstream can never exceed the server's own
context window, so `deep-s26b5bb`'s 70,053 tokens give 34 chunks at n_ctx 2048,
17 at 4096 and **8 at 8192** — and the arms' stability tracks exactly that:
rotation spread 9 %, 22 %, 1441 %. There is not enough document.

**What survives at 8192, and it is not nothing:** all four rotations exceed the
4096 arm's 12.24 (medians 18.3, 44.0, 275.5, 59.9). The trend continues past
4096. Its size is not determined.

### The longer corpus, first attempt: the control failed, and it was right to

2026-08-24, same day. §3e's own recommendation was a longer corpus, so
`deep-s26b5bb` and `pi-150turn` were concatenated — 161,254 tokens under
perplexity's own tokenizer — giving **64 / 32 / 16 chunks** per rotation at
2048 / 4096 / 8192, double this section's sample at every depth. All three
fillers came back exact off the error path, and the first eight chunks of the
8192 pass reproduced the `deep-s26b5bb` run **byte for byte**, which they must:
that corpus is the concatenation's first 65,536 tokens.

**And then the whole-chunk alignment control failed, at 871.8x the printing
floor.** It was right to: the corpus builder had been rewriting the corpus. The
numbers below are NOT READABLE and are kept only so the failure is on the
record next to the fix; the section after this one is the corrected run.

```
   n_ctx    PPL        tokens scored    rotation spread    <- NOT READABLE
    2048    13.1588      122,760              6.0 %
    4096    27.6989      122,820             98.2 %
    8192    85.0210      122,850            204.2 %
```

**The failure is informative and is not a wrong filler.** A filler off by even
one token shifts every chunk boundary, so every one of the 64 pairs would
disagree. Only **four** do — and they are the extreme ones (10.3, 8.3 and 4.9
nats per token), while the other sixty agree at 0.1-0.8x the floor:

```
   pair            a_nll      b_nll     relative    x floor
   a36 / b37      10577.40    9703.35    8.3e-2      871.8
   a42 / b43       8515.44    7745.74    9.0e-2      740.2
   a62 / b63       5019.95    4795.91    4.5e-2      206.7
   a45 / b46       5928.32    5956.44    4.7e-3       25.7
   …sixty others   …          …          <1e-3       <1
```

**Diagnosed, and it was a bug in the corpus builder rather than anything about
the model.** Three measurements, in order:

1. **The engine is exactly deterministic.** The 64-chunk pass was re-run
   identically: all 64 running estimates matched to the printed digit, worst
   relative difference **0**. So identical input cannot give different output,
   and one of the two passes was not seeing what it was assumed to see.
2. **Every disagreement is in the `pi-150turn` half.** All 34 pairs below
   corpus token 70,053 agree; all four failures are above it.
3. **`ppl_depth_build.py` read and wrote the corpus in TEXT MODE.** Python's
   universal-newline translation turns `\r\n` into `\n` and a bare `\r` into
   `\n` on the way in, and writing it back does not undo it. `pi-150turn.txt`
   holds **414 carriage returns**, ten of them in `\r\n` pairs;
   `deep-s26b5bb.txt` holds **none**. So the arm file's corpus half was ten
   bytes shorter than the corpus and differed from it in 414 places — the
   control's "same tokens, shifted by a whole chunk" premise was simply false,
   and it fired on precisely the four chunks that contained changed bytes.

The builder now reads and writes corpora as bytes; the rebuilt arm file is
`prefix + corpus` byte for byte with all 414 CRs intact, and
`tests/../test_ppl_depth_build.py` pins it with a corpus containing every shape
of carriage return — plus the control that proves text mode would have changed
it, because otherwise the test passes for no reason.

**Nothing above §3e is affected, and that was CHECKED rather than reasoned.**
`deep-s26b5bb` has zero carriage returns, so text mode and binary mode agree on
it byte for byte — which is exactly why this survived every earlier run and
appeared the moment a second corpus arrived. All five arm files built for §3e
by the OLD builder were compared against `filler-<K>.txt + deep-s26b5bb.txt`
after the fix:

```
   deep-s26b5bb-f1024 / f2048 / f4096 / f6144 / f8192   all EXACT
```

The 2048-vs-4096 result stands on files that are byte-identical to what the
fixed builder would have produced.

### The longer corpus, with the control passing: it is a cliff, not a slope

> **Corrected by §3f, twice.** The span ratios below are ratios of
> exponentials: the 149,597x span moves **4.54x in NLL** (delta 11.92
> nats/token), the median span moves 1.18 rather than 1.74, and the corpus-wide
> cost is a **1.72x total NLL** rather than 6.47x. And at n_ctx 8192 each cell
> of this map is fed by exactly ONE rotation, so "nine of thirty spans move more
> than 10x" is nine spans from one rotation: F=4096 has a median delta-NLL of
> 2.597 against F=0's 0.365. Read §3f before quoting any number in this
> subsection.


Re-run 2026-08-24 after the builder fix. `deep-s26b5bb` + `pi-150turn`, 161,254
tokens under perplexity's own tokenizer, window corpus `[8192, 131072)` —
**64 / 32 / 16 chunks** per rotation, double §3e's sample at every depth. All
three fillers exact off the error path, and **the alignment control passes at
1.80e-3 relative, 0.8x the printing floor, over 64 chunk pairs.**

```
   n_ctx    PPL        tokens scored    missed    rotation spread
    2048    13.3188      122,760         119          8.6 %
    4096    28.5385      122,820          59        110.4 %
    8192    86.1443      122,850          29        212.3 %
```

**x2.14 from 2048 to 4096 replicates §3e's x1.93 on a different, larger corpus
with its own passing control**, and the ladder now extends: x3.02 again from
4096 to 8192.

**But the aggregate is the wrong summary, and the per-span map says why.** Over
thirty 4096-token spans, the 8192/2048 ratio has a **median of 1.74** and an
upper quartile of 18.9. Sixteen of thirty spans move less than 2x; **nine move
more than 10x**, and one moves 149,597x:

```
   span                  2048        4096          8192      8192/2048
   86016..90111         28.83     2812.23   4,313,018.09      149597x
   24576..28671          3.08        7.39         792.45         258x
   8192..12287           4.63       15.41        1065.10         230x
   49152..53247          3.34        3.29         523.79         157x
   …                                                                 
   77824..81919          2.87        3.13           3.18           1.1x
   118784..122879        3.54        3.84           3.85           1.1x
   126976..131071       14.03       14.75          13.51           1.0x
```

Dropping that single worst span moves the 8192 aggregate from **86.14 to
59.32** while barely touching 2048 (13.32 to 12.97). One span of thirty is
worth a third of the headline.

**So the model does not degrade smoothly with context; it falls off a cliff on
particular content, and the cliffs dominate any average.** At 15.3 nats per
token that worst span is the model assigning ~2e-7 to the tokens that actually
occurred — a collapse, not a drift. It is fully deterministic: the engine
reproduced a 64-chunk pass with a worst relative difference of exactly **0**.

This also retires §3e's "too few chunks" reading of the 8192 problem as
incomplete. More chunks did tame the rotation disagreement — 1441 % on eight
chunks, 212 % on sixteen — but the heavy tail is a property of the CONTENT, not
of the sample size, and no corpus length makes a mean over cliff-prone spans
into a stable number. **Quote the median span ratio and the distribution, not
the aggregate.**

### What makes a span a cliff: one hypothesis, measured and refuted

> **Answered in §3f**, and the blocker named at the end of this subsection —
> exact token offsets — turned out to be one flag rather than a missing
> instrument. The refutation below stands and is strengthened: on exact offsets,
> five content features fail to separate the high-delta spans from the low ones.


The obvious guess, from reading the worst span, is repetitive low-entropy text.
It is git progress output — `Updating files:  81% (512/631)<CR>Updating files:
82% (518/631)<CR>` for thousands of tokens — and a fixed-size recurrent state
(§3c) saturating on exactly that is a tidy story. The 49x span is repeated tool
schemas, which fits too.

**It does not survive being measured.** Compressing each span with zlib as an
objective stand-in for repetitiveness, over all thirty:

```
   spans under 2x   (n=16)    median zlib ratio  0.345
   spans over 10x   (n= 9)    median zlib ratio  0.364
```

Indistinguishable, and very slightly the WRONG way. The 149,597x span is
genuinely compressible (0.218) — and it is not even the most compressible span
present: `106496..110591` compresses to 0.208 and moves 1.7x. **Repetitiveness
does not predict the cliff.**

Two things a better attempt would need. First, exact token offsets: the mapping
used here is `llama`'s `/tokenize` scaled by the ratio of the two tokenizers'
totals (157,626 against 161,254), which drifts by up to ~2,000 tokens across the
file, so span boundaries are approximate and per-span content analysis inherits
that. `--kl-divergence-base` writes perplexity's exact token array into its
header, so one small base pass would give the true offsets. Second, a candidate
that is not a guess: what these spans have in common is still unknown, and
"repetitive" was the first idea rather than the best one.

### The two controls catch different things, and neither substitutes for the other

Worth stating because this run proved it the hard way. The corrupted build and
the correct one produced **identical token counts** — 162,278 / 163,302 /
165,350, deltas exactly 1024 / 2048 / 4096 in both — because the 414 rewritten
bytes happened not to change how many tokens the corpus makes.

So the error-path probe, which is the control for the filler's LENGTH, passed
on a corpus that had been silently altered in 414 places. Only the alignment
control, which is the control for the corpus being the SAME TOKENS shifted by a
whole chunk, could see it. A run with just one of them is a run with a hole in
it.

### What this does and does not settle

- **It settles that the depth effect is real** rather than a partition artefact,
  between 2048 and 4096, and that is the step §3d could not defend. **It does
  not put a number on 8192** — see above; that needs a longer corpus, not a
  better instrument.
- **It does not identify the mechanism.** In default mode history and
  position-in-chunk are the same number, so "more history" and "further into the
  window" cannot be told apart by this instrument at all.
- **It is one corpus.** `pi-150turn` degrades in the same direction under §3d's
  confounded ladder and has never been through this one. `--reuse-filler` exists
  so that replication costs one run rather than two.
- **It matters for the server**, which runs a 98,304-token window — four times
  the deepest arm here, on the arm of the curve that is getting worse.

## 3f. What makes a span a cliff: a per-token misfire rate

`scripts/ppl-cliff-run.sh`, `scripts/ppl_tokens.py`, `scripts/ppl_cliff_analyse.py`.

### The blocker in §3e was never real: it was one flag

§3e closed with "exact token offsets" as the thing standing between it and an
answer, because the token->byte map was llama-server's `/tokenize` **scaled** by
the ratio of two totals (157,626 against 161,254) and drifted up to ~2,000
tokens across the file. The two totals are not two tokenizers. They are one
tokenizer and one flag:

```
   perplexity.cpp:473   common_tokenize(ctx, params.prompt, true)
                        -> add_special = true, parse_special = FALSE
                           (the default 4th argument of common_tokenize)

   llama-server /tokenize   parse_special defaults to TRUE
```

Measured on `deep-plus-pi.txt`, 571,603 bytes:

```
   /tokenize  defaults                       157,626 tokens
   /tokenize  parse_special = true           157,626
   /tokenize  parse_special = FALSE          161,254   <- perplexity's count
   perplexity's own probe                    161,254
```

`add_special` is a no-op here: Qwen3 sets `add_bos = false`, and true and false
both return 157,626.

**A matching count is not a matching array, and this document already knows
why** — the corpus altered in 414 places produced identical token counts
(§3e). So the arrays were compared element by element.
`--kl-divergence-base` writes perplexity's token array to disk **before the
first `llama_decode`** (perplexity.cpp:525), so a pass at `-c 256` killed the
moment the file reaches `20 + n_chunk*n_ctx*4` bytes costs one model load and no
inference at all:

```
   n_ctx 256, n_vocab 248320, n_chunk 629 -> 161,024 tokens written
   compared 161,024 against the /tokenize map, mismatches 0  ->  IDENTICAL
```

The 230 tokens not compared are the corpus's final partial chunk, which
perplexity drops. The scaling is retired; every offset below is exact.

### The instrument: any chunk is reproducible on its own, and it is controlled

`perplexity.cpp:547` clears the memory before every batch of chunks, so a
chunk's result depends on nothing but its own `n_ctx` tokens at positions
`0..n_ctx-1`. Chunk 10 of a 16-chunk arm is therefore chunk 0 of a file that
starts at that chunk's first token — one model load and one chunk of decode
instead of a whole arm, and the arm's own per-chunk number is the control.

Every chunk isolated on 2026-08-24 reproduced its arm; the table is under "the
answer" below, because the numbers it contains are the result and not only the
control.

### The answer: chunk perplexity is a misfire-rate readout

Thirteen chunks were isolated across three runs, and every one reproduced its
arm (the 86017..90111 chunk was run twice, in different runs, and returned
4,312,987.9359 both times):

```
   n_ctx  scored corpus      isolated PPL      arm PPL          rel diff
    2048  86017..87039     506,623.5305    506,630.8692        1.45e-05
    2048  87041..88063           1.1283          1.1281        1.94e-04
    2048  88065..89087           1.0986          1.0985        1.03e-04
    2048  89089..90111           1.1005          1.1005        5.66e-06
    2048  90113..91135           1.8897          1.8901        1.95e-04
    8192   8193..12287       1,065.0920      1,065.0981        5.72e-06
    8192  12289..16383          18.2526         18.2527        5.82e-06
    8192  16385..20479         275.4538        275.4542        1.58e-06
    8192  20481..24575           6.2353          6.2352        1.38e-05
    8192  24577..28671         792.4512        792.4501        1.43e-06
    8192  28673..32767          10.9237         10.9240        2.60e-05
    8192  86017..90111   4,312,987.9359  4,313,018.0902        6.99e-06
```

Those differences are the arm's own four-decimal running-estimate rounding, not
a discrepancy. **The isolation is exact**, and each staged slice's token array
matched the corpus map with zero mismatches.

THE FAILURE IS A PER-TOKEN MISFIRE, AND IT IS EVERYWHERE. Split each chunk's
per-token NLL at 10 nats. Above that line the model is not uncertain: it has put
its mass on an unrelated token, typically at ~1.5-2 nats (p ~ 0.15-0.2) while the
token that is actually there costs ~17 (p ~ 4e-8). Below it, ordinary text.

```
   scored corpus        arm PPL   mean NLL   misfire %   of total NLL   the rest
   20481..24575            6.24      1.746       5.54        44.6 %       1.024
   28673..32767           10.92      2.315       7.16        42.3 %       1.439
   12289..16383           18.25      2.622      11.77        67.0 %       0.980
   16385..20479          275.45      4.911      23.81        73.1 %       1.736
   24577..28671          792.45      5.769      29.52        77.6 %       1.831
    8193..12287        1,065.10      5.992      31.23        79.2 %       1.816
   86017..90111    4,313,018.09     13.285      82.27        93.4 %       4.917
```

**Perplexity orders perfectly with the misfire rate, over six orders of
magnitude of PPL and a 15x range of rate.** A "cliff" chunk and a "healthy" one
are not two phenomena. They are the same per-token failure at five times the
rate, and between 42 % and 93 % of every chunk's entire NLL comes from that
minority of tokens. The tokens that do NOT misfire differ by less than 2x across
the first six rows while their perplexities differ by 170x.

Sample misfires, one per chunk, actual token then what the model wanted:

```
   11896  17.72  '.verbose'    -> 'arg'          (1.72)     from the 1065 chunk
   27404  18.09  '.stdin'      -> <id 11078>     (2.09)     from the 792 chunk
   24390  17.48  ' printf'     -> <id 2173>      (1.48)     from the 6.24 chunk
   89888  17.78  ' '           -> ' decision'    (1.90)     from the 4.3M chunk
```

The signature is identical in the healthy chunk and the catastrophic one. Only
the rate differs.

### The rate is a property of the chunk, and it is CONSTANT across it

The obvious story — the model meets something it cannot handle, collapses, and
stays collapsed — is refuted by its own measurement. Mean NLL in sixteen
successive slices of the scored range, **in position order**, for the worst
chunk in the corpus:

```
   86017..90111   12.84 13.16 12.68 13.34 13.55 11.98 13.81 13.99
                  13.89 13.23 13.53 13.20 13.06 13.71 13.73 12.86
   % misfiring    38.0  39.5  35.2  43.8  47.7  39.8  49.2  45.7
                  48.0  40.6  48.4  46.1  41.8  46.5  48.0  43.8
```

Flat. It is already at 12.8 nats and 38 % misfires in the FIRST bin — the first
256 tokens it scores — and never gets meaningfully worse or better. The same is
true of the other two high-rate chunks, which open at 5.51 and 4.03 nats. There
is no entry point to find, because whatever determines the rate has already
happened before the first scored token: a chunk scores its top half, so its
entire first half is history.

Misfires are also close to INDEPENDENT rather than bursty. Counting maximal runs
of consecutive misfires against what independence predicts at the same rate:

```
   chunk            misfire %   runs observed   expected   longest run
    8193..12287        31.23         759          879.8         9
   16385..20479        23.81         620          743.1        12
   12289..16383        11.77         289          425.4        10
   20481..24575         5.54         182          214.5         6
   28673..32767         7.16         233          272.1         6
   86017..90111        82.27        2018         2314.6        39
```

1.15x to 1.47x more clustered than chance, longest run 6 to 39 tokens out of
4095. That is a mild tendency to arrive together, not a state the model enters
and sits in.

### The same tokens, two chunk boundaries, two answers

What the rate DOES depend on is the chunk, and the clearest case is the
progress-bar region, where the same text is scored at two depths:

- **corpus 87041..88063 at n_ctx 2048** — in-chunk history is corpus
  86016..87040, which is 1023 tokens of nothing but the repeating progress bar.
  Mean NLL **0.121**, zero misfires, eight of eleven deciles exactly 0.0. The
  model knows the next line before it starts.
- **the same tokens inside the 8192 chunk 86017..90111** — in-chunk history is
  corpus 81920..86016, which is ~290 tokens of prose about a Maven artifact
  followed by ~730 tokens of progress bar. Bins 4 and 5, which cover those same
  tokens, read **13.55 and 11.98**.
- **corpus 86017..87039 at n_ctx 2048** — history is that same mixed prefix,
  cut at 2048. Mean NLL **11.98**, 26.5 % misfires.

So the chunk whose history is homogeneous predicts perfectly, and the two whose
history spans a boundary between kinds of text misfire on ~30-45 % of tokens —
including tokens the first chunk gets for free. **What is in the history sets
the rate for the whole chunk.** That is one region measured three ways, not a
law; §3f's earlier draft called it a collapse that is "entered and persists",
which the positional profile above refutes.

### Two corrections to §3e, both from data that was already on disk

**"149,597x" is a ratio of exponentials and should not be quoted.** Perplexity
is `exp(mean NLL)`, so a span ratio is `exp(mean8 - mean2)` and is exponentially
sensitive to a difference in the additive quantity. In NLL, over the same tokens:

```
                          PPL ratio     NLL ratio    delta nats/token
   the 149,597x span      149,597.4          4.54              11.92
   median of 30 spans           1.74          1.18
   maximum of 30 spans    149,597.4          5.94
   corpus-wide             6.4679       1.7223               1.867
      total NLL   2048: 317,848 over 122,760 tokens (mean 2.5892)
                  8192: 547,423 over 122,850 tokens (mean 4.4560)
```

The corpus-wide depth cost is **1.72x the total NLL**, not 6.47x, and the span
distribution has a median of 1.18 and a maximum of 5.94 — skewed, but nothing
like five orders of magnitude. **The standing rule becomes: quote the median
span ratio IN NLL, and give the delta in nats.**

**The span map at grid 4096 is rotation-confounded at n_ctx 8192.** The rotation
design's guarantee is that the UNION of the two rotations covers every token
once — true of the ARM aggregate, and false of a per-span map at grid 4096,
where an 8192-deep chunk scores 4095 tokens and each cell is therefore fed by
**exactly one** rotation. Splitting the thirty cells by which rotation fed them:

```
   8192 rotation F=4096   n=15   median delta-NLL  2.597
   8192 rotation F=0      n=15   median delta-NLL  0.365
```

Nine of the ten highest-delta spans come from F=4096 (hypergeometric p ~ 0.003
one-sided). The tenth is the collapsed progress-bar span, which is F=0. The
alternation is visible as a period-2 component in the lag-1 autocorrelation, and
the rotation-BALANCED instruments do not have it:

```
   nll/tok @2048  (both rotations per cell)   lag-1 autocorr  +0.085
   nll/tok @4096  (both rotations per cell)                   +0.013
   nll/tok @8192  (ONE rotation per cell)                     -0.278
   delta-NLL 8192-2048                                        -0.338
```

Document difficulty is positively autocorrelated between adjacent blocks; an
alternating sign is not something content does. The same asymmetry is present in
the arm aggregates, same direction at every depth, growing with the filler:

```
   n_ctx   F=0 arm PPL   F=N/2 arm PPL   spread
    2048        12.78          13.88      8.6 %
    4096        19.67          41.40    110.4 %
    8192        48.75         152.23    212.3 %
```

**This does not overturn §3e's headline** — the depth effect survives as a total
NLL ratio of 1.72 corpus-wide, and both rotations contribute to that. It does
mean the per-span map at 8192 was reporting a rotation as if it were a property
of the span, and that "nine spans move more than 10x" was nine spans from one
rotation.

### Repetitiveness is refuted a second time, now on exact offsets

§3e's zlib test is repeated on exact span boundaries and with four more
features, splitting the thirty spans at delta-NLL >= 2:

```
                       delta >= 2 (n=10)   delta < 2 (n=20)
   bytes per token             3.684              3.607
   zlib ratio                  0.361              0.340
   carriage returns            0.000 %            0.000 %
   digits                      1.08  %            1.61  %
   distinct-token ratio        0.244              0.214
```

Indistinguishable on all five. The one span that IS extreme on every one of them
(86016: 1.69 bytes/token, zlib 0.145, 3.1 % CR, 28 % digits, and only 0.6 %
distinct tokens) is the collapsed one — but it is one span, and the other nine
high-delta spans are ordinary prose and code that no content feature separates
from the twenty low ones. **What predicted a "cliff" better than any content
feature was which rotation the cell came from.**

### What this settles and what it opens

- **Settled: the token map.** Exact, verified element by element against
  perplexity's own array, and cheap to redo for any corpus — one killed pass.
- **Settled: chunk isolation.** Any chunk at any depth costs one model load, and
  the arm's number is the control. Thirteen for thirteen, including one chunk
  measured twice in different runs to the same 4,312,987.9359.
- **Settled: what a cliff IS.** A per-token misfire rate. Perplexity orders
  monotonically with it across seven chunks and six orders of magnitude, the
  rate is flat across a chunk's scored range, and misfires are near-independent.
  There is no cliff in the underlying quantity — the rate runs 5.5 % to 82 % —
  and `exp(mean NLL)` manufactures one.
- **Refuted, by its own measurement: "the model collapses and stays collapsed".**
  The worst chunk in the corpus is already at 12.8 nats and 38 % misfires in its
  first 256 scored tokens. Whatever sets the rate has happened before the first
  scored token.
- **Open: what sets the rate.** "The chunk's history spans a boundary between
  kinds of text" fits the one region measured three ways, and nothing else has
  been tested. Five content features do not separate high-rate spans from
  low-rate ones (below), and neither does perplexity at 2048 — Pearson -0.30
  over thirty spans.
- **Open, and now sharper: the rotation.** The F=4096 chunks reproduce their arm
  numbers exactly under isolation, so their higher rates are real inference
  behaviour on those tokens and not an artefact of the arm files or the
  indexing. Why that tiling lands on higher-rate content, at every depth, with
  the same sign and a magnitude that grows with the filler, is unexplained.

### What a depth ladder does NOT measure, and it matters for reading all of §3d-§3f

Every number in §3d, §3e and §3f is about **window size**, not about position in
a conversation. perplexity clears the memory before every chunk
(`perplexity.cpp:547`), so a token scored "at n_ctx 8192" sits at in-chunk
position 4097-8191 with an empty cache behind position 0. The server does not
work like that: one conversation occupies positions 0..98303 continuously, and a
token at position 90,000 has 90,000 tokens of real attention history.

So "the misfire rate rises with n_ctx" is a statement about how the model does
when its whole world is an 8192-token window, and it does NOT license "the
server misfires more at position 90,000". The one direct evidence about the
server at real depth points the other way: `scripts/ctx_needle.py` planted a
distinct nonce at each end of a 90,055-token document and the server retrieved
both, which is what promoted CTX_SIZE to 98,304 in the first place.

What DOES transfer is anything the two configurations share. The rope is
identical — the GGUF reports `n_ctx_train = 262144`, `rope scaling = linear`,
`freq_scale_train = 1`, so no YaRN is engaged at either 8192 or 98,304 and there
is no scaling difference to account for. The KV cache type is NOT shared unless
the passes are told to match it, which is what `--kv` is for: the server runs
`-ctk q8_0 -ctv q8_0` and this instrument defaults to f16.

### Three defects in this instrument, all found by running it

Recorded because two of the three fail silently, which is the class this
document keeps paying for.

- **A slice that ends in a newline loses its last token, and perplexity does not
  complain.** `arg.cpp:1791-1800` pops one trailing `\n` from a `-f` file;
  `n_chunk` is `min(--chunks, tokens/n_ctx)`, so the run scores K-1 chunks and
  exits 0. The `8192:4096:3` slice ended in a newline, announced two chunks, and
  the third was simply absent from the analysis. Fixed by appending a newline
  unconditionally so the pop always takes that byte, plus a hard error when the
  logits header's chunk count is not K.
- **A backtick in the staged Python was shell command substitution.** The block
  was interpolated into a double-quoted `python -c "..."`, so the word `sl` in
  backticks ran as a command (`line 245: sl: command not found`) and the empty
  result was spliced into the source. It landed in a comment, so nothing was
  corrupted — luck, not design. Fixed structurally: the stage is now
  `scripts/ppl_cliff_stage.py`, a file, and the shell parses only arguments.
- **The EXIT trap did not restart llama, three runs out of three.** The last
  line of output was always the log-prob cleanup and `restore` printed neither
  of its messages; the third run had an explicit `restore` call *after* the
  cleanup and it still did not run, which places the kill inside that step — a
  `docker run` deleting several GiB across the 9p mount. The restart now happens
  BEFORE the analysis, which is where it belonged anyway: the passes are done,
  the card is free, and the analysis needs no GPU (it can also then reach a
  server to detokenize ids the corpus lacks). The trap stays for the abnormal
  path.

## 3g. q8_0 KV at depth: measured, and it costs under 1 %

**Why this needed doing.** §3a priced q8_0 against f16 by KL divergence at
**n_ctx 4096** and found it acceptable. Everything since — §3d, §3e, §3f — says
4096 is the shallow end of the only axis that matters. Meanwhile §2's retraction
removed q8_0's throughput justification entirely, leaving 1.7 GiB of VRAM as the
sole surviving benefit. And §3f's failure signature, the model putting ~0.2
probability on an unrelated token, is exactly what a degraded cache produces.

**And every §3f number was measured at f16**, while the server runs
`-ctk q8_0 -ctv q8_0`. So the instrument was describing a configuration this
stack does not serve. `--kv` fixes that; `--no-logits` makes it cheap.

Seven chunks, spanning misfire rates from 5.5 % to 82 % and perplexities from
6.2 to 4.3 million:

```
   scored corpus   misfire %        f16 PPL       q8_0 PPL     ratio   d nats/token
    8193..12287       31.23      1,065.0920     1,097.1268   1.0301x       +0.02963
   16385..20479       23.81        275.4538       267.3355   0.9705x       -0.02992
   24577..28671       29.52        792.4512       823.1713   1.0388x       +0.03803
   12289..16383       11.77         18.2526        17.7177   0.9707x       -0.02974
   20481..24575        5.54          6.2353         6.2914   1.0090x       +0.00896
   28673..32767        7.16         10.9237        10.8455   0.9928x       -0.00718
   86017..90111       82.27  4,312,987.9359 4,559,069.1634   1.0571x       +0.05549

   n = 7    mean +0.00932 nats/token    four worse, three better
            largest |delta| 0.055, against a between-chunk spread of
            1.75 to 13.29 nats/token
            pooled effect on perplexity: 1.0094x
```

**Under 1 %, and the sign is not consistent.** Three of seven chunks are BETTER
under q8_0. There is no relationship with the misfire rate either: the two
largest positive deltas sit at 29.5 % and 82.3 %, but a -0.030 sits at 23.8 %
and another at 11.8 %.

**This is not "no difference detected".** The instrument reproduces to seven
significant figures across processes — the same isolated chunk returned
4,312,987.9359 in two different runs — so 0.03 nats is about a thousand times
its noise floor. These are real, measured differences. They are simply tiny and
bidirectional, which is the shape of a rounding perturbation rather than a
systematic loss of information.

**Two conclusions.**

- **q8_0 KV stays, and now for a tested reason.** Its throughput claim is
  retracted and its fidelity is measured at the depth where this model actually
  misbehaves, not only at 4096. The 1.7 GiB of VRAM is free.
- **The cache is not what drives the misfire rate.** Whatever makes the model
  put 0.2 probability on an unrelated token 31 % of the time in one 8192-token
  window and 5.5 % in another, KV quantisation is not it. §3f's open question
  survives intact and is now one candidate narrower.

**The comparison is labelled in the tool, not just here.** `--from-run` points
at f16 arm logs, so a q8_0 run's arm comparison is the EXPERIMENT rather than a
control; `ppl_cliff_analyse.py` prints it as `q8_0 vs f16: +0.05548 nats/token —
a MEASUREMENT, not a control` instead of reporting a failed control, because
that is precisely the misreading a future session would otherwise make.

### What this run cost, and what the previous ones cost needlessly

`--no-logits` exists because of what the earlier runs did to the machine.
`--kl-divergence-base` writes one log-prob record per scored token, and a record
is `2*((n_vocab+1)/2)+4` uint16 — on this model's 248,320-token vocabulary that
is **496,648 bytes per token**, or 2.0 GiB per 8192 chunk, across the 9p bind of
a Windows drive. §3d's D1 already established that omitting it is byte-identical
in the printed perplexity and ~10x faster, so a comparison that reads only chunk
numbers should never pay for it.

```
   the f16 runs (three of them)    ~11 model loads, ~280 GB read
                                   ~25 GB of log-probs written
   this run                        2 model loads, ~35 GB read, ZERO written
```

Three things made the earlier runs worse than they had to be, all avoidable and
all mine: dropping the page cache four times, so every subsequent 17.5 GB model
read came off the physical disk again; restarting llama while a pass was
loading, putting two of those reads in contention; and leaving an orphaned pass
container holding 17.5 GB of VRAM for 25 minutes after its `docker run` client
died. **None of this is visible in `/proc/diskstats`** — the 9p mount is not a
block device in the container, it is served host-side, which is exactly why it
surfaces as lag on the Windows machine rather than as load in here.

## 4. Reproducing any of it

```
   ./scripts/kld-run.sh --corpus /captures/corpus/deep-s26b5bb.txt \
       --depths 4096 --null-control
```

One base pass writes the logits; the null control and the q8_0 arm both read
that same file. `--keep-logits` keeps it (17.3 GB at 4096 for this model) so it
can be sized and inspected. `--dry-run` prints every command and stops nothing.


The §3f instrument, which needs llama UP for stage 1 (it owns the tokenizer) and
stops it for the passes:

```
   ./scripts/ppl-cliff-run.sh --corpus /captures/corpus/deep-plus-pi.txt \
       --from-run .ppl-depth-logs/20260824T142049Z \
       --chunk 2048:84992:3 --chunk 2048:86016:2 --chunk 8192:81920:1
```

`--chunk N:A:K` isolates K chunks of n_ctx N starting at corpus token A;
`--from-run` supplies the arm logs the isolated numbers are checked against, so
the control is read rather than typed. `--dry-run` prints every command and
stops nothing. The log-probs are deleted after the analysis unless
`--keep-logits` is given: 1.9 GiB for one 8192 chunk of this model, because
`n_vocab` is 248,320 and the record is `2*((n_vocab+1)/2)+4` uint16 per scored
token.

**The restart happens before the analysis, not from the EXIT trap**, because on
2026-08-24 the trap did not fire three runs out of three and left
`qwen38-llama` stopped each time; see §3f's defect list. Checking `docker ps`
after a run is still worth the two seconds.

`llama-perplexity` loads its own copy of the weights, so `qwen38-llama` must be
stopped for the run; the script does that itself and restarts it on any exit
path. **`--load-mode none` is not optional** for any direct `docker run` of the
llama image here — without it, demand-paging the GGUF through the 9p bind mount
runs at 6.4 MB/s of resident growth and is indistinguishable from a hang.
