# Open work — written 2026-08-24 for whoever picks this up cold

`context/HANDOFF.md` is the record of what happened. This file is the opposite:
only what is NOT done, with enough detail to start without re-deriving anything.
Ranked by what I would do first.

**Before anything else, read "Running this stack without lagging the machine" at
the bottom.** Two sessions' worth of I/O lessons are in it and they are cheap to
re-learn expensively.

---

## 00. ninfer: gate cleared, pin is 6 of 6 — but upstream REJECTS the 4090 (2026-09-03)

`ngram-mod-and-the-load-confound.md` ("Also unevaluated") dismisses ninfer with
one factual claim: *"both would cost the uncensored fine-tune this stack serves
— ninfer loads only the official artifact."* **That claim is false**, and it is
the only thing standing between this stack and a documented 262,144-token window
at ~126 t/s decode on this card against our 98,304 at ~43.

Read out of `Neroued/ninfer` at `master` (2026-09-02), not inferred:

- `tools/convert/qwen3_8_27b/convert.py` exists and its canonical invocation is
  `--model /path/to/Qwen3.8-27B --out out/qwen3_8_27b.ninfer`. **An arbitrary
  local directory.** There is no download, no repo allow-list, no artifact
  allow-list.
- Weights are **not** hash-pinned. `tools/convert/qwen3_6/common/recipe.py`
  preflights *shape and dtype only* (`source shape != required`,
  `source dtype != required`), against a 1,118-tensor inventory.
- What IS pinned is six FRONTEND files, by sha256, in `OFFICIAL_RESOURCE_SHA256`:
  `tokenizer.json`, `tokenizer_config.json`, `chat_template.jinja`,
  `generation_config.json`, `preprocessor_config.json`,
  `video_preprocessor_config.json`. `load_resources()` reads them as raw bytes
  from the model dir and raises on any mismatch.

So the constraint is "official *tokenizer and frontend*", not "official
weights". Measured against that constraint, **with the control run first**:

| repo | files matching ninfer's pins |
| --- | --- |
| `Qwen/Qwen3.8-27B` (control) | **6 of 6**, by download-and-hash |
| `orcarouter/Qwen3.8-27B-Uncensored` | **5 of 6** — only `tokenizer.json` differs |

The five matches were established by comparing HF LFS object ids (which are
sha256 of content) against the control's, both sides LFS, so it is a real
content comparison and not a size coincidence. `tokenizer.json` is the same
LENGTH as official (12,809,320 B) with a different hash.

**Where it actually stops today, and it is not engineering:** the safetensors
repo `orcarouter/Qwen3.8-27B-Uncensored` and its `-NVFP4` sibling are **gated**
— 401 anonymous, **403 with the HF_TOKEN in `.env.local`**, i.e. the token is
valid and this account has not been granted access. The `-GGUF` repo the stack
downloads today is ungated, which is why nobody noticed. Accepting the gate on
the Hub is a click; until then the conversion cannot be attempted at all.

**What is still unknown, stated plainly:** whether that one differing
`tokenizer.json` is a semantic change or a re-serialisation. It could not be
read (gated). A neighbouring repo was readable and is NOT a substitute for the
answer, but is worth recording because it is a warning:
`orcarouter/…-Uncensored-MLX` ships a *third* tokenizer (19,989,325 B) with the
same 248,044-entry vocab and same 33 added_tokens, but a **pre_tokenizer regex
that drops `\p{M}` from its letter classes** — the old GPT-2 form, not
Qwen3.8's. That would retokenise any text carrying combining marks. It does NOT
affect the GGUF this stack serves: both the orcarouter and unsloth GGUFs stamp
`tokenizer.ggml.pre = qwen35` with identical 247,587 merges and identical token
counts, checked with a ranged header read. But it means orcarouter's repos do
not all carry the same tokenizer, so "the fine-tune keeps the stock tokenizer"
must be verified per repo rather than assumed.

### GATE ACCEPTED 2026-09-03 — and the tokenizer question does not exist: 6 of 6

Access verified the right way (`resolve/`, not the API): **302 -> 206** on both
`orcarouter/Qwen3.8-27B-Uncensored` and its `-NVFP4` sibling.

**Every one of ninfer's six pinned frontend files is BYTE-IDENTICAL between the
uncensored fine-tune and `Qwen/Qwen3.8-27B`**, and matches ninfer's own
`OFFICIAL_RESOURCE_SHA256` constants at full 64-hex length:

| file | sha256 (first 32) | vs ninfer pin |
| --- | --- | --- |
| `tokenizer.json` | `0997f410c57a1f4e53b09e4be8f4a172` | MATCH |
| `tokenizer_config.json` | `b11349aafa7cdc6a320767cf7ceb29ed` | MATCH |
| `chat_template.jinja` | `c3cf9e34abf4f9e36c2d72165aa9c132` | MATCH |
| `generation_config.json` | `e70c136c1b78ddc1fb0905bac8e733a4` | MATCH |
| `preprocessor_config.json` | `27225450ac9c6529872ee1924fcb0962` | MATCH |
| `video_preprocessor_config.json` | `7768af27c1fafa9cc9011c1dc20067e0` | MATCH |

**So no substitution is needed at all, and the stop condition never fires.** The
plan below says "if `pre_tokenizer` differs, STOP" — `pre_tokenizer` cannot
differ, because the entire file is the same bytes.

**THIS CORRECTS THE "5 of 6" ABOVE.** That reading came from comparing HF **LFS
object ids** while the repo was gated. Both repos' `tokenizer.json` carry the
*same* LFS oid `0997f410c57a1f4e...` **and** the same git blob oid
`9328ce9c41e8`. Checked three independent ways — sha256 of the downloaded bytes,
the LFS oid, and the git blob oid — plus a cache-busted re-download that hashed
identically. `chat_template.jinja` landing on `c3cf9e34...`, the sha this repo
recorded independently on 2026-09-02, is the control that the hashing is right.

**The NVFP4 shortcut is NOT available.** `recipe.py` sets
`SOURCE_DTYPE = "BF16"` and rejects any mismatch (`source dtype X != required`).
The `-NVFP4` repo is 23.0 GiB and `quant_method: compressed-tensors`, so it
would fail that preflight. The bf16 repo's shard-1 safetensors header reads
**BF16, 392 tensors** — read by ranged fetch, so the source dtype is confirmed
rather than assumed.

**Honest cost, measured:** 18 shards, **51.7 GiB**, plus the ~19 GB `.ninfer`
artifact. `//c/llm-models` has **154 GiB free** and `//d/llm-captures` has
**7.5 TiB** — stage on D, not C.

### BOTH FLAGS CLEARED — and a THIRD one stops the whole path (2026-09-03)

**Flag 1, the tensor count: FALSE ALARM, with the strongest possible control.**
`Qwen/Qwen3.8-27B` — the artifact ninfer is *built for* — ships **1199 tensors
too**. Name sets identical, shard placement identical, `total_size` identical to
the byte (51.75 GiB), and dtype+shape identical across sampled shards 1, 9 and
18. The 1,118 figure is ninfer's own object/recipe count, not an HF tensor
count, and `preflight_source_reader` only looks up the names it REQUIRES
(`reader.metadata(requirements)`) — extra tensors are never read and nothing
asserts a total. There is no count check to fail.

**Flag 2, the MTP head: PRESENT.** `qwen3_8_27b/inventory.py` builds
`TENSOR_SPECS = TEXT_CORE + DRAFT_HEAD_TENSOR_SPECS + MTP_TENSOR_SPECS +
VISION`. ninfer converts the MTP head.

**FLAG 3, WHICH IS FATAL FOR THIS BOX: ninfer will not build on a 4090.**
From its README: *"NInfer requires 64-bit Linux, an NVIDIA GeForce RTX 5090 ...
**The build rejects CUDA architectures other than `sm_120a`.**"* `sm_120a` is
Blackwell. This box is an **RTX 4090** (sm_89, Ada) — read off the engine's own
memory breakdown, not assumed.

**And the headline numbers are not from this card.** `docs/performance.md`:
GPU = **RTX 5090, 32 GiB** — a faster card with **8 GiB more VRAM**. So this
entry's framing, *"a documented 262,144-token window at ~126 t/s decode on this
card against our 98,304 at ~43"*, is wrong in the words **"on this card"**. It
is a different, larger GPU.

**The window claim also does not survive contact with speculative decoding.**
Same table: *"Maximum context 262,144 tokens; **131,072 for Qwen3.8 MTP3**"*.
262,144 is the **MTP0** figure — spec decoding OFF. With MTP3 the ceiling is
131,072 — the *same* 128K this repo measured on 2026-09-03 and refused because
it **halves decode** (50.2 -> 26.1 tok/s). And MTP is exactly what this stack's
live +38.7% pin depends on.

**So the honest status: the engineering blockers are all cleared and the path is
still not available here.** It needs one of the three community 4090 forks
(`UDPSendToFailed/ninfer-4090` at 90*, `sergiuszm/ninfer-4090`,
`ruwwww/ninfer-5060ti` for `sm_120a` Blackwell-small), and a fork's converter
pins and MTP support would have to be re-verified rather than inherited from
this check. **Do not download 51.7 GiB against upstream.** The next cheap step,
if anyone wants this, is to read a 4090 fork's build gate and its
`OFFICIAL_RESOURCE_SHA256` — same method as above, no bytes moved.

*(Historical: the two flags this section raised before that, now both cleared.)*

1. **Tensor count.** The index ships **1199** tensors — 850 `model.language_model`,
   333 `model.visual`, 15 `mtp`, 1 `lm_head` — against the **1,118**-tensor
   inventory this entry cites. The 81 difference is unexplained; `inventory.py`
   for `qwen3_8_27b` delegates to `qwen3_6`'s, and it was not chased further.
   A count mismatch is exactly what `preflight_sources` rejects, so resolve it
   against the real inventory before downloading 51.7 GiB.
2. **The MTP head, which is this stack's speed.** The repo carries 15 `mtp.*`
   tensors, and **this stack's live +38.7% depends on `draft-mtp`**. If ninfer's
   converter drops that head, "126 t/s against our 43" is not like-for-like and
   the comparison has to be re-read. `convert.py` does call
   `draft_head.compute_shortlist(...)`, so a draft head exists there — but that
   it is THIS MTP head is unverified.

**Order to do this in, cheapest first:**

1. Accept the gate on `orcarouter/Qwen3.8-27B-Uncensored`. One click — and
   **re-checked 2026-09-03: still not accepted, but the wait is zero.** The repo
   is `"gated": "auto"`, which is instant self-approval on accepting the terms,
   not a request queued for a human. So this is a click and a re-run of the
   check below, not a click and a wait.

   **Check it the right way — the API endpoint lies about this.**
   `api/models/<repo>` now returns **200** with the token for both gated repos,
   which reads like access and is not; the previous record's "403 with the
   HF_TOKEN" was taken against the file path. Only `resolve/` proves access:

   ```
   curl -sIL -H "Authorization: Bearer $HF_TOKEN" -H 'Range: bytes=0-99' \
     https://huggingface.co/<repo>/resolve/main/tokenizer.json | grep -iE '^HTTP|x-error-code'
   ```

   Today: `403` + `x-error-code: GatedRepo` on the orcarouter repo, against
   `302`->`206` on the `Qwen/Qwen3.8-27B` control run in the same command.
2. Fetch its `tokenizer.json` and diff it against `Qwen/Qwen3.8-27B`'s the way
   `scratchpad` did for MLX: vocab, added_tokens, merges, pre_tokenizer,
   decoder. If only `merges` serialisation differs, substituting the official
   file is defensible and the converter's pin is satisfied. If `pre_tokenizer`
   differs, **stop** — the artifact would tokenise differently from the GGUF and
   no speed number is worth that.
3. Only then consider the conversion, and cost it honestly: it needs the bf16
   safetensors on disk (tens of GB) on top of the GGUF already there, and the
   ~19 GB `.ninfer` artifact after it.

**Everything else in that dismissal still stands** and should not be
re-litigated: it is an engine change, not a knob; the vLLM-beats-ninfer-above-8k
comment is unaddressed; and the `sergiuszm/ninfer-4090` fork named there is now
one of three (`UDPSendToFailed/ninfer-4090` at 90★ carries the 2.1k t/s prefill
and DirectStorage disk-cache claim, `ruwwww/ninfer-5060ti` the Blackwell
`sm_120a` fix). A disk cache is the interesting one for THIS stack for a reason
that has nothing to do with tok/s: cold load here is 9-20 minutes.

---

## 00b. 128K — CLOSED 2026-09-03: it fits, and it halves decode

`kvarn-measured-and-refused.md` ends by naming the next cheap measurement:
*"re-run bee-128k-q8 on a quiet box and read `free` off the engine's exit
table. If it is comfortably positive at the 1501 floor, 128K is available on the
current model with no fork, no quality question, and no decode cost."*

**It was run, and the box is not quiet — but not for the reason anyone was
watching for.** `./scripts/vram-floor.sh --samples 48 --interval 15`, llama
untouched and flat to 0.0 MiB across the whole capture:

| | min | median | max |
| --- | --- | --- | --- |
| host floor, 2026-08-23 (90 samples) | 1477.9 | **1500.8** | 1517.5 |
| host floor, 2026-09-02 (48 samples) | 2528.1 | **2741.3** | 2823.6 |
| free at 128K, today | -371 | **-584** | -667 |
| free at 96K, today | 1037 | **824** | 741 |

Both inputs to `ctx_128k_verdict` moved, in opposite directions:

- **The model shrank by 678.3 MiB** — llama via vmwp reads 20999.1 against the
  21677.4 that was constant across all 137 samples in August. That is orcarouter
  `Q4_K_M` replacing unsloth `UD-Q4_K_XL` on 2026-08-25, and it is the thing the
  kvarn note spotted. On the old floor it alone would have turned the -22 MiB
  refusal into **+656 and opened 128K**.
- **The floor grew by 1240 MiB**, which is more, so the answer is still no.

The floor moved only 295.5 MiB *within* the capture, so this is a new steady
state, not the GPU-heavy foreground August left unmeasured. Per-pid
`\GPU Process Memory(*)\Dedicated Usage` names it rather than guessing:
**NVIDIA Broadcast, 920.1 MiB**, which does not appear in the August list at any
size. brave (390.3 vs 138) and chrome (294.4 vs 169) account for most of the
rest.

**So 128K is one process away from fitting, and that is a different situation
from the one closed "permanently" in August** — that refusal was against an
ordinary desktop, this one is against an ordinary desktop plus a camera/mic
effects daemon.

**It is still not a recommendation to switch**, and the reasons are worth
keeping: +336 MiB with Broadcast closed is thinner than the ~824 MiB that 96K
keeps free today, it depends on a process staying shut, and nothing here
re-measured prefill or decode at 128K on the current model.

**The re-open condition, so nobody has to re-derive it:** close NVIDIA
Broadcast, re-run `vram-floor.sh`, and if the median lands near 1821 run ONE
`capacity-probe.sh` arm at `CTX_SIZE=131072` and read `free` off the engine's
own exit table rather than off this arithmetic — a sampled cross-run delta got
this same comparison wrong by 1163 MiB once (`vram_note`).

### RE-MEASURED 2026-09-03 — the condition was met without doing the thing it asked

`./scripts/vram-floor.sh --samples 44 --interval 15 --label 0903`, llama again
flat to **0.0 MiB** across the capture:

| | min | median | max |
| --- | --- | --- | --- |
| host floor, 2026-08-23 (90 samples) | 1477.9 | **1500.8** | 1517.5 |
| host floor, 2026-09-02 (48 samples) | 2528.1 | **2741.3** | 2823.6 |
| host floor, 2026-09-03 (44 samples) | 1045.1 | **1460.9** | 1810.9 |
| free at 128K, 09-03 | 1112 | **696** | 346 |
| free at 96K, 09-03 | 2520 | **2104** | 1754 |

**Nobody closed anything.** `NVIDIA Broadcast` has been running continuously
since **2026-08-25 20:01** — through the 09-02 capture AND this one — at 70.4
CPU-seconds total across nine days, i.e. near-idle in both. Its dedicated usage
read **920.1 MiB on 09-02 and 0.1 MiB today** with its run state never changing.
So "close NVIDIA Broadcast" was an action that was never available and was never
needed: the 1280 MiB came back on its own.

**What that does to the 09-02 reasoning above, precisely.** The floor number
(adapter total minus vmwp) is sound in both captures — it is the additive
counter, and llama was flat in both. What does NOT survive is the *attribution*:
naming Broadcast as "the single biggest line" implied a tenancy that could be
evicted, and a process at a fixed run state does not explain a 1280 MiB swing in
either direction. Treat the per-pid column as a weak hint about WHAT moved and
never as the measurement — it is the same column whose header in
`vram-floor.sh` says **DO NOT SUM THESE** (dwm maps every other window's surface
and alone reads ~4 GB; the column sums to ~27 GB on a 24.5 GB card).

### The probe was run, and 128K LOADS

`./scripts/capacity-probe.sh --config 'ctx-128k-0903|CTX_SIZE=131072'` on the
current stack (`b10689` + orcarouter `Q4_K_M`). `.env` restored and verified,
llama back up healthy at `-c 98304`. Off the engine's **settled** exit table:

```
CUDA0 24563 = 921 free
            + 21159 self (15339 model + 5100 context + 720 compute)
            + 2481 unaccounted  <- everything else on the device
```

**Read the 2481 before the 921.** That is the desktop *during the probe* —
close to 09-02's 2741 median and ~1000 MiB above the median measured half an
hour earlier. So this is not "it fit because the box was quiet": it fit with
the desktop at roughly the level that produced the `-584` refusal.

**Quote the third breakdown block only.** llama.cpp prints three; blocks one and
two read `free` before other allocations are visible and report `-18838` and
`-14476` unaccounted. Only block three has a positive unaccounted and sums to
the device (`921 + 21159 + 2481 = 24561`).

**Why the arithmetic was wrong by ~1500 MiB.** It computed
`24564 - (device total at 96K + 1408)`, where `+1408` is an engine delta
measured on the **old** stack (unsloth `UD-Q4_K_XL`, b10573). It implied a 128K
footprint of 22407; the engine says **21159**. A carried-over delta measured on
different weights is not a measurement — the same lesson, in the same direction,
as the 1163 MiB error `vram_note` already records.

### The cost was measured too, and it CLOSES the item: 128K halves decode

Both arms in ONE run, same 90,029-token prompt, `--repeat 3`:

| | 96K | 128K | change |
|---|---:|---:|---:|
| prefill tok/s (median) | 1797.8 | 1200.7 | **-33%** |
| decode tok/s (median) | 50.2 | 26.1 | **-48%** |
| draft acceptance | 0.53-0.68 | 0.52-0.54 | flat |
| free, engine table | 2116 | 702 | -1414 |

**Decode is decisive and it is not noise.** The three 128K runs are
26.1 / 25.3 / 26.3 — a 4% spread — against 96K's 44.4 / 53.7 / 50.2. No 128K
round comes near any 96K round. Draft acceptance barely moves, so this is not
spec-decoding collapsing; it is the window.

The arms saw near-identical desktops (2535 / 2701 unaccounted), which is what
makes this like-for-like — quoting the historical `ctx-96k` row instead would
have compared across four different stacks, which is what the script's
"re-measure the baseline in the same run" rule exists to prevent.

**VERDICT: 128K fits and is not worth taking.** Halving interactive decode to
buy 32K of window is a bad trade for an agent workload. 96K stays the pin — now
on a cost measurement rather than on arithmetic about headroom. **This item is
closed**; re-open it only if the workload changes to something prefill-bound
that genuinely needs >96K in one prompt.

**The +1408 constant is retired**: measured on this stack it is **1248**
(context 4012 -> 5100, compute 560 -> 720). `vram-floor.sh`'s `report()` still
hardcodes 1408, so its "free at 128K" column reads ~160 MiB pessimistic. Left
alone on purpose — that column is a screening estimate and the engine table is
the authority, which is this entry's whole lesson.

**And the volatility is the finding, not the headroom.** The floor moved
**765.8 MiB within this 11-minute capture**, against 295.5 on 09-02. So 09-02's
"this is a new steady state" does not hold today: the desktop is drifting during
the measurement, the worst sample here (1810.9) is close to 09-02's *best*
(2528.1) only in the sense that neither is stable, and the whole 09-02 → 09-03
delta is inside the range this box wanders on its own. **A floor is a snapshot
with a shelf life of hours, not days.**

**The transferable part, and it is the reason this entry is not just a number:**
the floor is not a property of the hardware, it is a property of what happens to
be open, and it drifted 1.2 GiB in ten days with nobody noticing. `versions.lock`
called 1501 "the ORDINARY state of the machine" and 2027 "the worst ever
observed"; 2027 is now below the *best* sample of an ordinary capture. Any
decision that spends VRAM headroom needs the floor measured **on the day**.
Both records are updated in place — `vram_note` and `ctx_128k_verdict`.

---

## 0. Re-run a real unattended `/loop` — the 2026-08-27 fixes are unproven END TO END

**Cheapest item here and the only one blocking a claim.** Four defects were
found and fixed on 2026-08-27 (two silent forge exits, two in the loop's stuck
ladder — `context/HANDOFF.md` §1-§4). Each is verified at its own boundary, with
a control run in both directions, and the causal chain between them is measured.
**What has NOT happened is the thing the operator saw: a wedged run reproduced
and then not reproduced.**

It costs one unattended run. Start a `/loop` on a real goal, leave it, and check
three things afterwards:

- `.pi-loop-log.jsonl` — does `stuckStreak` ever exceed 1? Before the fix it
  could not, in any run. A run that never gets stuck proves nothing here; a run
  that does and climbs is the evidence.
- `docker logs instantcoffee-llama | grep "eval time"` — a generation landing on
  the 8,192-token cap every turn is the wedge, not a model thinking hard.
- `docker logs instantcoffee-forge | grep "EMPTY RESPONSE"` — patch 8 makes both
  of forge's empty exits loud. Silence here is now meaningful; it was not before.

**Known-unchanged and deliberate, so they are not findings if you see them:** a
loop that reaches rung 5 keeps going with a 60 s backoff (endless mode is what
`/loop` promises, and a terminal rung is a policy change), and forge's
empty-tool-call-list exit still returns an empty response — it cannot invent one
— but now logs at ERROR.

---

## 0b. `ngram-mod 12:64:32` — SUPERSEDED by ngram-map-k on 2026-09-01

*(Kept as the record of how it was measured, and because its 12/64/32 values
are still in `.env`, inert, as the one-line revert path. Its "synthetic side
settled" claim below is CORRECTED in 0e: that instrument could not resolve a
6% effect, so read it as "no LARGE cost".)*

**The pin was changed on 2026-08-31 and the change is live.** `.env` carries
`SPEC_TYPE=ngram-mod,draft-mtp` with `12/64/32`. Full story in
`context/design/ngram-mod-and-the-load-confound.md`.

**Replicated by an independent run the same evening:** +22.3% (p=0.0002) on the
repeat workload, against the first run's +23.3% (p=0.0011) — different rounds,
different load regime, agreeing to within one point, and positive in all eight
round subsets. In three of the rounds the candidate benched at 2-5x the pin's
load and still won, so the estimate is conservative.

**CORRECTED 2026-09-01 (see 0e): read this as NO LARGE COST, not no cost.** The
run below could only detect effects above roughly 10%, so "no measurable cost"
is a statement about the instrument as much as about the config. The
synthetic-only run (8 rounds, ~13 min each because one workload halves round
duration) gave five usable rounds at a balanced n=20/20:
medians 59.8 vs 59.6, **-0.3%**, p=0.4866. The -3.5% on MEANS is one 23.7 tok/s
transient inside round 5 whose siblings were 39.6/64.1/52.0.

It excludes an effect larger than about +-7% (SE on the difference ~1.9 tok/s),
not a small one — "no cost detectable at this power", not "exactly zero".

So the pin is done: +22.3% and +23.3% on repeat across two independent runs, no
detectable synthetic cost across five more rounds. The revert, if ever needed,
is one `.env` edit back to `ngram-simple,draft-mtp` with the three MOD keys
blank.

The 5-round run (2026-08-31, 30 results, zero failures) gives **+23.3% on the
repeat workload, p=0.0011**, replicated across the two rounds that survived
load-splitting, with the load advantage running OPPOSITE ways in those two
rounds and a sensitivity band of 13.6-27.3% that never changes sign. `--report`
and `spec_sweep_compare.py` agree independently (+23.6% / +23.3%).

`8:32:24@n3` is REJECTED — its sensitivity changes sign across subsets.

**To adopt** (one `.env` edit, then `./scripts/up.sh && ./scripts/smoke-test.sh`):

```
SPEC_TYPE=ngram-mod,draft-mtp
SPEC_NGRAM_MOD_N_MIN=12
SPEC_NGRAM_MOD_N_MAX=64
SPEC_NGRAM_MOD_N_MATCH=32
```

**The one thing this did NOT establish:** the synthetic (novel-text) side had
only one usable round, measuring -2.1% (p=0.80) with a band straddling zero. No
cost was detected there, but the measurement is underpowered. If the pin is
changed and prose or novel-code generation feels worse, that is the regression
to look for, and the fix is to re-run the synthetic workload with more rounds.

---

## 0c. Three ngram modes MEASURED 2026-09-01 — one is an upgrade

`ngram-map-k`, `ngram-map-k4v` and `ngram-cache` had never run here. They have
now, against the LIVE pin (`ngram-mod 12:64:32`), repeat workload only, 7 rounds,
`--repeat 4`. 28 results, zero failures, and **every round came back `even`** —
the first fully clean run of the day, because repeat-only rounds are short
(~26 min for four configs) and the box stayed quiet.

Six usable rounds, n=24 a side:

| mode | vs the live pin | p | per-round |
|---|---:|---:|---|
| `ngram-map-k` | **+8.7%** | 0.0147 | positive in all 7 (3.9-20.1%) |
| `ngram-map-k4v` | -6.5% | 0.0514 | mostly negative (-11.4 to +2.3) |
| `ngram-cache` | **-58.4%** | 0.0000 | -55.6 to -60.5, every round |

**`ngram-map-k` is a real, small upgrade — ADOPTED 2026-09-01, and it is the
LIVE pin.** It runs at ENGINE DEFAULTS (`size-n 12, size-m 48, min-hits 1`); its
knob family is deliberately not plumbed.

```
SPEC_TYPE=ngram-map-k,draft-mtp     # n-max 4 / p-min 0.40 unchanged
```

**Confirm it with the three-way in 0d before trusting it.** Its win was measured
against `ngram-mod`, which was itself measured against `ngram-simple`, in
separate runs — chained, never composed.

Tuning it afterwards WOULD need plumbing, mirroring `SPEC_NGRAM_MOD_*` in
`.env` and `docker-compose.yml`. Worth doing only if the default already earns
its place, which it does.

**`ngram-cache` is rejected decisively** — 58% below the pin, p=0.0000, and the
per-round figures barely move. **`ngram-map-k4v` is not an improvement** and may
be a small regression.

### The mid-run scare, and what it was

The delta appeared to DECAY across rounds (20.1 -> 12.0 -> 5.5 -> 3.9), which
looked like a result evaporating. It was not: the PIN had an anomalously low
round 2 (187.4 against its usual ~210) which inflated the early deltas, while
`map-k` itself sat steady at 222-235 from round 2 on. Dropping the pin's dip:

```
rounds 2-7 (all usable)              map-k +8.7%
rounds 3-7 (excluding the pin dip)   map-k ~+7%
```

That correction WEAKENS map-k and STRENGTHENS both rejections, so it is not
cherry-picked in a convenient direction.

### A methodological note worth keeping

This item was twice argued here to be low value, on the grounds that these modes
"draft short" (`DRAFT/CYCLE` 5.7-9.7 against the pin's 34.2) and so looked
unpromising. That reading came from a LOAD-SPLIT round — exactly the kind this
repo's own tooling refuses to read — and it was believed because it agreed with
a plausible mechanism. The draft-length observation was even true; it simply did
not predict throughput. **A plausible mechanism is not a measurement.**

---

## 0d. The direct three-way — DONE 2026-09-01. Total gain is +38.7%.

All three pins measured against each other in ONE run: repeat workload, 8 rounds,
`--repeat 4`, 24 results, zero failures. The box was hostile — only rounds 5 and
7 survived the load-split test — so this rests on n=8 a side, not the n=24 that
0c managed.

```
ngram-simple n4 p0.40    180.5 tok/s      —
ngram-mod 12:64:32       233.0         +29.1%   p=0.0014
ngram-map-k              250.4         +38.7%   p=0.0002     <- LIVE
map-k vs mod                            +7.5%   (p=0.26 at this n)
```

**The ordering never inverts.** `map-k > mod > simple` holds in all EIGHT rounds
including the six that were dropped; only the magnitudes swing (map-k 27.5-64.0%
against simple). Direction unanimous, size uncertain.

### The composition question, answered

The chained estimate before this run was `1.223 x 1.087 = +33%`, and the direct
measurement is **+38.7%**. But the chain is not the problem — computed with THIS
run's own links it is nearly exact:

```
within one run:   1.291 x 1.075 = 1.388  ->  +38.8%
measured direct:                             +38.7%
```

The whole 5-point gap comes from the FIRST link: `mod` vs `simple` measured
+22.3%/+23.3% on earlier days and **+29.1%** here. So the sharp version of the
rule is not "never multiply percentages" — it is:

> **Deltas compose when every link is measured under the same conditions, and
> do not when they are not.**

That is worth more than the number it produced. Any future chained claim on this
box should be treated as unreliable in MAGNITUDE (though not in direction) unless
the links share a run.

### map-k vs mod is now measured four times

`+8.7%` (0c, n=24, p=0.015), `+8.6%` (this run's split rounds), `+9.3%` (round 5
alone), `+7.5%` (rounds 5+7 pooled). Four estimates across three runs and three
load regimes, spread 1.8 points. Note the p=0.26 here is POWER, not a
contradiction: two rounds at n=8 cannot resolve a 7% gap, and 0c needed six
rounds to reach p=0.015. Absence of significance at low n is not evidence of
absence.

### A second reason to prefer map-k: it is the STEADIEST config

Within-round spread (max-min as a share of the mean), averaged over all 8 rounds
— a property of the config, so the dropped rounds count here too:

```
ngram-simple   39.3%      ngram-mod   33.4%      ngram-map-k   25.7%
```

map-k has ~two thirds the run-to-run variance of the original pin and no
blow-out rounds (simple has two at 62% and 119%). For an interactive agent
predictable latency is worth something on its own.

**It also explains why the total-gain number was unstable all along:** every
delta against `simple` is measured against the noisiest config on the board, so
those deltas swing, while `map-k`-vs-`mod` — two well-behaved configs — replicates
to within a point across three runs.

### map-k on synthetic: MEASURED 2026-09-01, and UNDERPOWERED

Run: 2 configs, synthetic only, 8 rounds, `--repeat 4`. Six usable rounds
(round 1 cold; round 6 dropped PARTIAL after a llama health-check timeout cost
one arm). Balanced n=24 a side.

```
ngrammapk-n4   mean 57.1  median 58.7      -6.6%   p=0.2256
ngrammod       mean 61.2  median 63.2
```

**The answer is "cannot tell", and the arithmetic says why:**

```
difference                              -6.6%
SE of the difference                     5.3%
smallest effect this run could DETECT   10.6%   (2 SE)
```

A 6.6% effect sits BELOW the detection threshold. The 95% interval runs about
-17% to +4% — consistent with a real cost, with nothing, or with a small gain.
The sensitivity row spans **+18.7% to -17.1%** across rounds, which is the same
verdict said another way.

**Do not read this as "map-k costs 6% on novel text."** The point estimate leans
negative and that is all. During the run the successive rounds (-6.3, -11.6,
-9.8) looked like a firming trend and were called as one here; the pooled
analysis does not support it. Reading a trend off successive rounds is the
mistake the sensitivity row exists to catch.

**What would settle it:** SE scales as 1/sqrt(n), so detecting a 6% effect needs
SE ~3%, i.e. about 3.1x the samples — roughly **19 synthetic rounds** (~4h at
this shape) rather than 8. Worth doing only if novel-text throughput is
something this stack actually cares about; the repeat workload is what pi
produces, and there map-k's +8.7% is measured four times over.

**For the record, the same question for `ngram-mod` was equally underpowered** —
it returned -0.2%/p=0.97 over five rounds, which was reported as "no measurable
cost". That reading was right in its conclusion but got there with the same
instrument that cannot resolve 6%, so it should be understood as "no LARGE cost",
not "no cost".

---

## 0e. Settle the novel-text cost of the pin — 19 rounds, ~4h

**The one axis of the live pin that is genuinely unresolved.** map-k measured
-6.6% against ngram-mod on synthetic (2026-09-01, n=24 a side), but:

```
difference                              -6.6%
SE of the difference                     5.3%
smallest effect that run could DETECT   10.6%   (2 SE)
```

The effect is BELOW the detection threshold. The 95% interval spans about -17%
to +4% — a real cost, nothing, or a small gain are all consistent. Do not read
the -6.6% as a measurement of anything.

**The same caveat applies to `ngram-mod`'s synthetic result** (-0.2%, p=0.97),
which was reported as "no measurable cost". Same instrument, same inability to
resolve 6%. Both should be read as "no LARGE cost".

### The run

SE scales as `1/sqrt(n)`, so resolving a 6% effect needs SE ~3%, i.e. about
3.1x the samples — **19 rounds** rather than 8:

```bash
./scripts/spec-sweep.sh --workload synthetic --rounds 19 --repeat 4 \
  --results-dir context/bench/spec-sweep-synth19 \
  --only ngrammod-12-64-32-n4,ngrammapk-n4

python3 scripts/spec_sweep_compare.py \
  --results-dir context/bench/spec-sweep-synth19 --baseline ngrammod-12-64-32-n4
```

~13 min a round at 2 configs synthetic-only, so **~4h**, and expect to lose a
few rounds to load splits — 19 is chosen so ~14 survive, not so all 19 do.

### Is it worth 4 hours?

**Probably not, and that is a real answer.** The repeat workload is what pi
actually produces, and map-k's +8.7% there is measured four times over. Novel
text is the minority shape for this stack. Run this only if:

- prose or novel-code generation subjectively feels slower since 2026-09-01, or
- someone wants the pin's tradeoff stated with a number rather than a bound, or
- the box is idle overnight and the GPU would otherwise sit unused.

**If it comes back at -6%,** the pin is a genuine tradeoff (+8.7% agent work for
-6% novel text) and still probably right for this stack — but say so in
`versions.lock` instead of the current "unresolved".
**If it comes back at 0,** the pin is free and the caveat can be deleted.

### Reading it

Same rules as everywhere else: `round health` first, `sensitivity` second, and
the p-value last. A synthetic delta that swings +18.7% to -17.1% across rounds —
which is what the 8-round run did — is noise however small the p.

---

## 0f. The CUDA abort: four reproductions that did not crash, and where that leaves it

**The event, 2026-09-01 18:38 UTC.** Six hours into the boot that adopted
`ngram-map-k` (the pin from 0c/0d, adopted the same day):

```
348.34  selected slot by LRU, t_last = 81473493103
348.38  W srv alloc: - prompt state size 8485.588 MiB exceeds cache size
                       limit 2048.000 MiB, skipping
354.13  common_ngram_map_begin: shrink cleanup begin: 61573 -> 12161
354.15  common_ngram_map_begin: refresh map: idx_last_draft=62362,
                       new begin=12221, #keys_checked=165, #keys_del=162,
                       #values_del=0, #hashes_upd=30834
/app/ggml/src/ggml-cuda/ggml-cuda.cu:2651: GGML_ASSERT(stat == cudaSuccess) failed
  ggml_abort <- ggml_backend_sched_graph_compute_async <- llama_context::decode
```

Line 2651 in b10689 is the `else` of `ggml_cuda_graph_update_executable`:
`cudaGraphExecUpdate` returned something that is neither `cudaSuccess` nor
`cudaErrorGraphExecUpdateFailure` (which that function handles by
re-instantiating). A sticky error latched by an earlier async failure lands
there, so **the assert is where it surfaced, not where it happened.**

### What the source says the log means

`common_ngram_map_begin` (`common/ngram-map.cpp` at b10689) is **pure CPU** — it
edits `map.keys` and `map.key_map` and touches no CUDA. It did not crash. It is
the last thing logged before the decode that did, and its counters describe the
state that decode inherited:

```
#keys_checked = map.keys.size() on entry      (live keys)
#keys_del     = keys erased
a key is erased when key.key_idx >= size_begin - size_key - size_value
```

165 keys down to 3 means the map stopped being able to draft, so the very next
decode changed batch shape — and a changed graph pushed into an existing graph
exec is exactly what `ggml_cuda_graph_update_executable` is for. That was the
working hypothesis for all four attempts below.

### Attempt log — every attempt matched more of the crash, and none crashed

| | context before | shrink to | keys | deleted | % | hashes_upd | result |
|---|---:|---:|---:|---:|---:|---:|---|
| **the crash** | 62,366 | 12,221 | 165 | 162 | 98% | 30,834 | **abort** |
| attempt 1 | 60,088 | 10,086 | 3 | 1 | 33% | 43,243 | survived |
| attempt 2 | 58,290 | 10,079 | 20 | 11 | 55% | 41,660 | survived |
| attempt 3 | 58,097 | 10,079 | 21 | 16 | 76% | 42,929 | survived |
| **attempt 4** | **93,123** | 10,076 | 59 | 55 | **93%** | **65,133** | survived |

Attempt 1 already reproduced every *line* the crash logged — `selected slot by
LRU`, `prompt state size 7258 MiB exceeds cache size limit 2048 MiB, skipping`,
the shrink, the refresh — and survived. So the shrink is not sufficient on its
own.

Attempts 2 and 3 tried to raise the key count and could not, and the log said
why: **any request whose prompt is shorter than the last one culls keys.**
Attempt 3's "deep" prompts branched off a shared history, so each arrived ~2000
tokens shorter than the reply before it and culled the keys it was meant to be
planting, five times per cycle. Attempt 4 fixed that with one strictly
monotonic conversation — every reply appended, every prompt longer than the
last — and reached 59 keys at 93K tokens, a **larger** context and a **larger**
rehash than the crash, at 93% deletion. It survived too.

**Four attempts, progressively closer on every axis and larger on most, all
negative. The abort is not a deterministic consequence of the shrink.**

### The leak hypothesis is dead

llama.cpp#23154 (same 4090, same `--spec-type ngram-*,draft-mtp`, same
function, closed 2026-07-31 as stale) claims the ngram map grows VRAM until it
OOMs. `vram-floor.sh`'s method answers that here: the Windows
`\GPU Process Memory(*)\Dedicated Usage` counter for `vmwp` IS llama, because it
is the only GPU-enabled container on this box.

```
124 samples / 41 min, spanning 24 seed conversations, three 58K context
builds, five 2000-token deep generations and a 93K-token conversation:
    llama   20993.0 -> 20999.1 MiB     span 6.1 MiB
    device  22939.2 -> 23323.1 MiB     span 383.9 MiB   (all desktop)

69 samples / 17 min, quiet, vram-floor.sh's own report:
    llama moved 0.0 MiB across the whole capture (i.e. not at all)
```

**It does not leak.** Not over 15,000 generated tokens, not over a 93K context,
not at all.

### What is left, and it is not an ngram bug

llama does not need to grow for the DEVICE to run out. At the busiest moment
measured today the device held 23,323 of 24,564 MiB — **1,241 MiB free** — and
that number is set by the Windows desktop, which nobody here controls.

```
desktop floor, 2026-08-23 (vram-floor.sh's header):  1405 1536 1881 1905 1961 2027
desktop floor, 2026-09-01 (69 samples):              min 2007.5  median 2033.5  max 2050.4
```

**Today's median floor is above the entire August range.** The desktop is
holding ~500 MiB more than it did when the 96K window was chosen, and the
August spread alone is 622 MiB. A CUDA allocation failing at a moment of
desktop pressure — and a re-instantiated graph on the shrink path is an
allocation — latches a sticky error that surfaces at exactly the assert that
fired. That is consistent with everything above, including the four failed
reproductions: it would need the desktop to spike at the same second, which is
not something a reproduction script can arrange.

**So the honest state is: not an ngram-map leak, not reproducible on demand,
and consistent with device-level headroom that has quietly shrunk under the
window this stack is configured for.**

### What to do, in order

1. **Nothing to the pin.** Four negative reproductions do not justify reverting
   a measured +38.7%, and the leak it was suspected of does not exist.
2. **Re-price the window against the CURRENT floor.** `capacity-probe.sh` exists
   for this and `vram-floor.sh` has just been run; the August decision was made
   against a floor ~500 MiB lower than today's. Dropping CTX_SIZE is the one
   lever that returns VRAM in GiB rather than MiB, and it is an operator choice
   with a real cost — the 96K claim is a headline feature — so it is written
   here rather than taken.
3. **If it happens again, get the real failure site.** `CUDA_LAUNCH_BLOCKING=1`
   in the llama service's `environment:` makes every launch synchronous, so the
   abort names the failing kernel instead of the next CUDA call after it. Slow,
   and correct for one diagnostic run. If the answer is `out of memory`, item 2
   is the whole fix and this section closes.
4. **A recurrence now costs a reload, not an outage** — §0g. Worth knowing that
   the reload is ~16 minutes warm, which is a real cost and a separate question
   (`--load-mode none` is in `LLAMA_EXTRA_FLAGS`; nobody has priced the
   alternatives).

**Not worth doing on present evidence:** `GGML_CUDA_DISABLE_GRAPHS=1`. It
removes the code path the assert lives in, costs throughput (`graphs reused =
7997` in the crashing boot), and if the cause is an allocation failure it moves
the failure rather than fixing it.

---

## 0g. Restart-on-unhealthy — DONE 2026-09-01, and it needed no Docker socket

**Shipped.** The llama healthcheck in `docker-compose.yml` now ends the
container itself when the server has been up and has stopped answering, and
`restart: unless-stopped` — already in the file — does the rest.

The alternative was an `autoheal` sidecar with `/var/run/docker.sock` mounted,
which is root on the host granted to a container for one service's benefit.
It was not needed: `init: true` was already there, so tini is PID 1 and
llama-server is an ordinary child, and an ordinary child IS killable from
inside the PID namespace. (PID 1 is not — a namespace init is immune to signals
it has no handler for, which is why "just `kill -9 1`" does not work and is not
what this does.)

Three guards, each one a way the naive version breaks a working stack, and the
middle one was confirmed live during the reload that shipped it:

- **Nothing is counted until the server has answered once.** A ~24 minute cold
  load must never look like a wedge, and this tests the condition instead of
  assuming when the port binds.
- **curl exit 22 does not count.** Measured, not reasoned: every probe of the
  2026-09-01 load window came back `curl: (22) The requested URL returned error:
  503`. A server answering 503 is a server. Only 7 (refused) and 28 (timeout)
  count.
- **`--max-time 4` under Docker's `timeout: 5s`,** so the probe always finishes
  and records its own result. The wedged container's probes were being killed at
  Docker's timeout, which is exactly why nothing ever accumulated.

Two details that are not decoration. The counter lives in a **tmpfs**, because
the writable layer survives `docker restart` — a counter in `/tmp` would survive
the restart it just caused and the next failed probe would kill again, forever.
And the reason is written to `/proc/1/fd/2`, so it lands in `docker logs`
immediately above the reload rather than only in `State.Health.Log[].Output`,
which nobody reads and which the restart discards.

`scripts/test_llama_watchdog.sh` is **15/15**. It reads the probe out of the
created container with `docker inspect` rather than carrying a copy, so the test
and the shipped text cannot drift; it costs no GPU (the throwaway container's
"llama-server" is a renamed `sleep`); and the tmpfs case has a control — a file
outside the tmpfs must survive the same restart, or "the file is gone" would
only mean the container was replaced.

**What is still open here:** forge and the capture proxy have no equivalent.
Neither has ever wedged — both are Python servers that would crash and exit,
which the restart policy already handles — so this is a note, not a task. If one
ever does, the generalisation is the sidecar, and it should be argued for on its
own evidence rather than added pre-emptively.

---

## 1. The runner exits 1 and skips its own last two steps — SOLVED 2026-09-03 (lib.sh re-enables errexit)

**Highest value because it will cost you an hour of confusion otherwise.**

`scripts/ppl-cliff-run.sh` finished four runs on 2026-08-24. Every one of them
ended with `instantcoffee-llama` STOPPED, and the last two also skipped the analysis.
The final run exited **1** having printed neither `==> restarting instantcoffee-llama`
nor `==> analysis`, with no error anywhere in its log.

What is known, so you do not re-check it:

- The code path is correct and unconditional. `main_run` ends
  `... done` → comment → `restore` → `analyse "$LOCAL_LOGDIR"` → `return $failed`,
  and `restore` is defined earlier in the same function. `bash -n` is clean.
- It is not the trap. `trap restore EXIT INT TERM` is set and ALSO did not fire.
- It is not `set -e` (never set) and not `die` (its message would be in the log).
- Moving `restore` earlier did not fix it. It was after `analyse`, then before
  it; neither printed.
- A real bug WAS found on that path and fixed — `print_spec` dereferenced
  `ceiling_hit` before the guard that skips the `--no-logits` case, so the
  analyser crashed with a KeyError. **That crash happens after the restart line
  that never printed, so it does not explain this.**

**Best remaining hypothesis, untested:** the script's stdout fd is closed out
from under it, so every `echo` fails silently and the exit status is left at 1.
That fits the silence, the exit code, and llama staying down. It would also mean
the earlier `nohup … &` launches were being reaped — which is separately true:
one run left an orphaned pass container wedged for 25 minutes holding 17.5 GB of
VRAM after its `docker run` client died.

**The next diagnostic, which is nearly free:** on the next real run, add
`exec 3>&2` at the top and have `restore` write to fd 3 as well as stdout, or
run under `bash -x` with `BASH_XTRACEFD` pointed at a separate file. If the
trace shows `restore` executing while nothing appears on stdout, the hypothesis
is confirmed and the fix is to stop relying on stdout for anything load-bearing.

**Until then: check `docker ps` after every run.** That is the mitigation and it
is fragile.

**One environment fact, and one hypothesis TESTED AND REJECTED (2026-08-31).**

The fact: **`tail -f` does not work on this 9p mount.** Following a log under
`context/bench/` dies with `tail: error reading '<file>': No data available`,
while a polling reader over the same file is fine. Anything here that follows a
log while a long job runs must poll.

The rejected hypothesis — recorded so nobody spends an afternoon on it again.
It looked like backgrounded work on this box gets reaped and loses its stdout,
which would explain this section exactly. **It does not reproduce.** Control run
2026-08-31: three writers launched from a tool call, each emitting 15 lines over
30 s, checked from a LATER tool call so the test spans the boundary that was
suspected:

| variant | destination | result |
|---|---|---|
| `nohup … &` | container fs | 16/16 lines, clean exit |
| `nohup … &` | **9p mount** | 16/16 lines, clean exit |
| `setsid nohup … &` | container fs | 16/16 lines, clean exit |

Plain `nohup &` survives the tool call and writes fine to the 9p mount. The
observation that seeded the idea — several background tasks dying mid-run — was
**harness-managed** background tasks being killed by the harness, which is a
different mechanism from a `nohup &` inside a script. They were conflated.

**THE LONG TEST IS NOW DONE, AND THE ENVIRONMENT HYPOTHESIS IS DEAD.** The short
control above only covered 30 s, and the real failure follows runs of hours — so
a detached writer was held open appending one line per minute to a log under
`context/bench/`, the same 9p mount `ppl-cliff-run.sh` writes to:

```
180 / 180 writes,  seq contiguous 1..180,  0 errors,  span 3:00:38
context/bench/fdtest/longrun-9p.log
```

Three hours, every write landed, no gap in the sequence, nothing reaped. It also
survived something the design did not anticipate: **the Claude Code session
itself crashed partway through and the writer carried on**, because it was
`setsid`-detached. A properly detached process here does not lose its stdout over
hours and does not get reaped.

**So the suspicion moves to the LAUNCH SHAPE, not the environment.**
`ppl-cliff-run.sh` backgrounds its passes with a plain `nohup … &` from inside
the script; what survived all of the above was `setsid nohup … &`. The
difference is the process group and controlling terminal — a plain `&` job stays
in the session's process group and dies with it; a `setsid` one does not. That
is a one-word change to test, and it is the next thing to try rather than
another environment probe.

### SOLVED 2026-09-03. It was `set -e`, re-enabled by `lib.sh` one line after the script turns it off.

**Reproduced on the first real run with the instrument in place**, and the file
named the line:

```
23:30:34  restore entered (caller rc=0)
23:30:34  restore entered (caller rc=1)
```

Restore WAS reached — twice, the explicit call and then the EXIT trap — and both
times execution stopped between the first `rlog` and the next statement. The
only thing in between is `docker kill "$RUNNER_CT"`.

**The mechanism, start to finish:**

1. `ppl-cliff-run.sh:59` runs `set -uo pipefail` — deliberately WITHOUT `-e`.
2. Line 60 sources `lib.sh`, whose line 4 is **`set -euo pipefail`**. Errexit
   comes back on, one line after the script chose not to have it.
3. `restore()` opens with `docker kill "$RUNNER_CT"`. The runner is `--rm` and
   has already exited on the normal path, so **that command always returns 1**
   (verified: rc=1).
4. Under errexit the script dies there — before restarting llama, with stderr
   already redirected to `/dev/null`, so in silence.
5. The EXIT trap fires `restore` again, which dies at the same line. Exit 1.

Every recorded symptom falls out of that and none needed a second cause: llama
left stopped, neither restore message printed, exit 1, "the trap also did not
fire" (it fired and died identically), "moving restore earlier did not fix it"
(the same line fails wherever it sits), and no error anywhere.

**"It is not `set -e` (never set)" was checked at the wrong line.** Line 59 is
exactly what it says; the override is on line 60.

**THE SECOND TRAP, which made the first fix a no-op.** `set -uo pipefail` does
**not** undo `set -e` — `-u` and `-o pipefail` only ENABLE those options.
Reordering the line so it runs after the source therefore changes nothing;
turning errexit off takes an explicit **`set +e`**. Caught by running the check
rather than reading it.

**FIVE scripts had the identical shape**, all long-running runners:
`kld-run.sh`, `ppl-cliff-run.sh`, `ppl-depth-run.sh`, `ppl-stride-run.sh`,
`test_llama_watchdog.sh` — the last of which carries a comment saying `set -e`
"turned the whole suite into one silent early exit", and then sources `lib.sh`
one line later. All five now source first and `set +e` after, with the reason
written at the top of each.

`restore()` is additionally hardened so the restart never depends on that fix
holding: both `docker kill` call sites are guarded, and `docker start` runs
inside an `if`. `scripts/test_runner_errexit.py` (7 tests) pins errexit-off for
all five, pins that `set -uo pipefail` does not disable `-e`, and carries two
controls — that `lib.sh` really does set `-e`, and that the detector reports ON
for a prologue that leaves it on. Its first version failed by matching
`token_pass()`'s `docker kill` instead of `restore()`'s, which found a second
unguarded call site.

### The earlier reasoning, kept because it narrowed the search (2026-09-03)

**The launch-shape step is aimed at code that does not exist.** There is no
`nohup` anywhere in `ppl-cliff-run.sh` (the only `nohup` in `scripts/*.sh` is
`browser.sh`'s Xvfb). The chunk passes in `pass()` are **synchronous**
`docker run` — no `&` at all. The single `&` in the file is in `token_pass()`,
and it is `wait`ed and `docker kill`ed a few lines later, runs FIRST, and is
skipped entirely under `--skip-tokens`. So nothing is backgrounded at the point
where the failure happens, and changing a launch shape there cannot affect it.

**The stdout hypothesis cannot explain the symptom on its own.** `restore` calls
`docker start` **unconditionally**; a failing `echo` returns non-zero into
nothing and `set -e` is not in force. A closed stdout would therefore still have
restarted llama. For llama to stay STOPPED you need *either* restore never
reached *or* `docker start` itself failing — two different bugs, and stdout
cannot tell them apart because the evidence for both is an echo that does not
appear.

**So restore now writes a FILE, and the file is the evidence.**
`${LOCAL_LOGDIR}/restore.log`, each line appended with its own redirection (the
fd is opened and closed per write, so nothing depends on an inherited fd), and
`docker start`'s exit status is *recorded* rather than inferred from which echo
ran — with docker's own stderr captured into the same file. Exercised in
isolation against a nonexistent container; it correctly reported the caller's
rc, `start rc=1`, docker's reason, and the post-state.

Read it after any run that ends with llama down:

| restore.log says | what it means |
| --- | --- |
| file absent | restore never reached — the EXIT trap did not run either, which means **SIGKILL** |
| `restore entered`, no `start` line | killed INSIDE restore, between kill and start |
| `start rc=0` and llama down | docker reported success and it stopped anyway — look at docker, not this script |
| `start rc=` non-zero | `docker start` failed, and the reason is on the line above it |

### The SIGKILL row was exercised for real, 2026-09-03, and it reads correctly

A cliff run was killed from outside mid-pass (a harness task stop, not the bug).
The aftermath matched the table exactly and is worth keeping as the worked
example:

- **`restore.log` ABSENT** -> "restore never reached ... which means SIGKILL".
  Correct: the script was killed, so its EXIT trap could not run.
- **`instantcoffee-llama` left `Exited (0)`** — nothing restarted it.
- **An orphaned `ppl-cliff-pass-*` container still RUNNING and holding the GPU.**
  This is the wedge the section 1 preamble mentions ("one run left an orphaned
  pass container wedged for 25 minutes holding 17.5 GB of VRAM").

**What the trap fix does and does not cover, stated plainly.** The `set +e` fix
covers every path where the script keeps running — which is what the four
2026-08-24 wedges actually were. It cannot cover SIGKILL, because no trap can.
So the wedge is still reachable from outside, and the recovery is manual:

```sh
docker ps --format '{{.Names}}' | grep ppl-cliff-pass   # the orphan
docker rm -f <that container>                            # frees the VRAM
docker start instantcoffee-llama                         # cold reload
```

**An orphaned pass is readable ONLY WHILE IT RUNS, and that window is easy to
miss.** `docker run`'s client dies with the script, so the redirect into
`<label>.log` stops — but the container keeps going and `docker logs <name>`
still returns its chunk lines. **The pass is `--rm`, so the moment it exits
Docker deletes the container and the logs go with it.** Measured the hard way on
2026-09-03: the control chunk had already been written to its log file before
the kill and survived, while the three-chunk spec was still running, was watched
for its results, exited, and took every line with it. Nothing reached
`result.json` and nothing was recoverable afterwards.

So on a killed run: **capture `docker logs <pass-container>` FIRST**, before
restarting anything or waiting for it to finish. Then `docker rm -f` it and
restart llama.

**The SIGKILL row is the one to expect.** The trap not firing is the strongest
signal in the whole section: `trap … EXIT` runs on a normal return, on `exit`,
and on a caught signal, and the only common thing it does NOT survive is
SIGKILL. On this box the routine source of SIGKILL is the OOM killer, and the
comment in `main_run` already notes the failure sits at "a docker run that
deletes several GiB across the 9p mount" — memory pressure is documented here as
the standing hazard. That is a hypothesis, NOT a measurement: the next run's
`restore.log` (absent vs present) discriminates it in one look.

**How to check the kernel for it, because the obvious command does not work
here.** `dmesg` from this container is `Operation not permitted`. The Docker
VM's ring buffer is reachable the same way the global notes drop its page cache:

```
docker run --rm --privileged alpine sh -c \
  'dmesg | grep -iE "killed process|oom-kill|out of memory"'
```

Run 2026-09-03: the command works (the buffer reads fine) and returns **0 hits**
— but that is **not** evidence about the 08-24 runs, because the buffer only
spans the Docker VM's uptime, which was 2.2 days. So it is a live check to run
*right after* a failing run, not an archaeology tool. Check it while the run is
still fresh or it tells you nothing.

**Corroborating evidence from the same day, unplanned:** the crash also killed a
`spec-sweep.sh` run that had been launched with `setsid nohup` — and that one
did NOT survive, because the crash took the whole container's process tree, not
just a session. Worth knowing which failures `setsid` does and does not cover.

Both environment hypotheses in this section are now closed. Do not re-open them
without new evidence; both tests are recorded above and both were negative.

---

## 2. What sets the misfire rate — CONTENT does, 3.96x (2026-09-03); the 1.44x depth claim is RETRACTED

§3f of `context/design/kv-cache-fidelity-measured.md` established WHAT a cliff
is: a per-token misfire rate. The model puts ~0.2 probability on an unrelated
token while the token actually present costs ~17 nats. Chunk perplexity orders
monotonically with that rate across seven chunks and six orders of magnitude.
The rate is flat across a chunk's scored range and misfires are near-independent
(1.15-1.47x clustered).

**What is ruled out:**

- Repetitiveness — refuted twice, the second time on exact offsets with five
  features (bytes/token, zlib, CR fraction, digit fraction, distinct-token
  ratio). None separate high-rate spans from low-rate ones.
- Perplexity at 2048 — Pearson -0.30 over thirty spans.
- KV quantisation — §3g. q8_0 against f16 over seven chunks is +0.0093
  nats/token, four worse and three better, |max| 0.055. Not the mechanism.

**The one hypothesis standing**, tested on exactly one region three ways: the
rate is set by what the chunk's HISTORY contains. Same progress-bar tokens cost
0.121 nats with 1023 tokens of homogeneous history and ~13 nats when the history
spans a prose/progress boundary.

### 2026-08-31: the rate is moved 3.4x by the CHUNK BOUNDARY OFFSET. No GPU.

`scripts/rotation_asymmetry_analyse.py` (its `cliff_cross_check`) reads
`nll_series` out of `.ppl-cliff-logs/20260824T164959Z/result.json` — one NLL per
scored token, which is what the misfire rate is defined on. That run carries two
n_ctx-8192 specs whose `corpus_start` differs by 4096, i.e. section 3's
boundary-offset variable, recorded for an unrelated purpose:

| boundary offset | chunks | mean misfire (>10 nats) |
|---|---|---:|
| 0 | 3 | **8.2%** |
| 4096 | 2 | **27.5%** |

**3.4x, per token.** Section 3 moved a per-span PERPLEXITY; this moves THE RATE
ITSELF, on a different instrument, in the same direction. **Sections 2 and 3 are
one phenomenon**, demonstrated rather than conjectured.

**But the claim is narrow, and the wider version is FALSE.** That comparison is
valid only because it is REGION-MATCHED: every chunk in it sits in corpus 8k-32k
as interleaved 4096-blocks, so offset is the only thing that differs. Pool in the
other cliff run and the effect disappears —

```
164959Z alone (region-matched)  off=0  8.2% | off=4096 27.5%   3.37x
all cliff runs pooled           off=0 26.7% | off=4096 28.2%   1.06x
```

— because that run contributes `86017..90111`, an **off=0 chunk at an 82.3%
rate**: the progress-bar region 3f calls the worst in the corpus. Across regions,
**region difficulty dwarfs offset**.

So: within a matched region, offset moves the rate ~3.4x. Offset is NOT a global
determinant of the rate, and **any sweep that mixes corpus regions will measure
difficulty instead of offset.** (Recorded because the wider claim was made here
first and walked back within the hour.)

### 2026-09-03: the 3.4x is ALIASED with block identity, and no data on disk can separate them

The numbers above reproduce exactly from the raw `nll_series` (8.2 / 27.5
region-matched, 26.7 / 28.2 pooled — recomputed independently, not re-read).
But laying every scored chunk out in CORPUS ORDER shows what "region-matched"
actually bought:

| scored block | filler | misfire |
|---|---:|---:|
| 8193..12287 | 4096 | 31.2% |
| 12289..16383 | 0 | 11.8% |
| 16385..20479 | 4096 | 23.8% |
| 20481..24575 | 0 | 5.5% |
| 24577..28671 | 4096 | 29.5% |
| 28673..32767 | 0 | 7.2% |

The offsets **alternate in lockstep with which 4096-block is being scored**:
every `f4096` chunk is an odd block, every `f0` chunk is an even one. So
"offset = 4096" and "this particular block" are the same variable in this
design, and the 3.4x is equally consistent with *offset matters* and with
*those three blocks are harder*.

**And nothing on disk can break the tie: every scored range is disjoint.** Across
all six cliff runs no corpus token is scored twice, so no token has ever been
seen under two offsets. `--chunk N:A:K` scores `[A+N/2+1, A+N-1]`, and every A
used so far is a multiple of 4096, which makes the windows tile rather than
overlap.

**What supports the offset reading anyway** (and it is support, not proof): the
corpus is a plain concatenation — `deep-s26b5bb` + `"\n\n"` + pi — not
interleaved blocks, and 8k-32k sits inside the first document. So "odd blocks
are harder" has no mechanism to point at, and a clean six-block alternation is
~3% likely under exchangeable block difficulty.

**THE PROPOSED SWEEP DOES NOT FIX THIS.** Sweeping `A` over
`{0, 2048, 4096, 6144}` moves the scored window with every step, so each arm
scores a *different* set of tokens and the comparison is back to region
difficulty. The fix is not more offsets, it is **overlap**:

| new arm | scores | overlaps | shared tokens |
|---|---|---|---|
| `8192:10240:1` (f2048) | 14337..18431 | 12289..16383 (**f0**) | 14337..16383 |
| | | 16385..20479 (**f4096**) | 16385..18431 |
| `8192:6144:1` (f6144) | 10241..14335 | 8193..12287 (**f4096**) | 10241..12287 |
| | | 12289..16383 (**f0**) | 12289..14335 |

Because `A` is no longer a multiple of 4096, these windows straddle the existing
ones, and the rate can be compared **on the same corpus tokens under two
different offsets**. If offset drives the rate, the shared tokens change rate
with offset; if block identity drives it, they do not. That is the experiment,
and it is two arms rather than a corpus build.

### ANSWERED 2026-09-03: history CONTENT sets the rate. 3.96x, amount held fixed.

`scripts/ppl_history_build.py` builds the degree of freedom no offset sweep has:
the same 4095 scored tokens (corpus `12289..16383`) behind three different
4097-token histories. **Amount is identical by construction; only content
differs.** All three ran as three chunks of ONE pass on ONE model, so this
comparison is internally valid in the way the retracted one below is not.

| arm | history (corpus tokens) | isolated PPL |
|---|---|---:|
| `early-doc` | 1024..5120 | **11.77** |
| `natural` | 8192..12288 (the real preceding text) | **15.44** |
| `pi-progress` | 81920..86016 (the worst region in the corpus) | **46.64** |

**3.96x between best and worst, on identical scored tokens with identical
history length.** The standing hypothesis — *"the rate is set by what the
chunk's HISTORY contains"* — is confirmed, and the size is large: prefixing the
same text with progress-bar log output triples its perplexity against its own
natural predecessor, and quadruples it against a different passage of the same
document.

Read the engine's chunk line correctly: llama-perplexity prints a RUNNING
average (`[1]15.4423 [2]26.8383 [3]20.3877`), and the per-chunk values above are
the analyser's de-cumulation — checked by hand
(`exp((ln 15.4423 + ln 46.6442)/2) = 26.84`, matching `[2]`).

**THE CONSTRUCTION IS VALIDATED (2026-09-03).** The missing same-model control
was run: `--chunk 8192:8192:1` on the ORIGINAL corpus, which scores the same
source tokens `12289..16383` by the normal slicing path rather than by
concatenation. It returned **15.4423** — identical to the `natural` arm to four
decimals. So a constructed chunk and a normally-sliced chunk of the same tokens
are the same measurement, the join introduces nothing, and the 3.96x above rests
on a verified build rather than on the token-identity check alone.

**Caveats, stated rather than buried.** This is chunk PPL, not the per-token
misfire rate — the run used `--no-logits` because a log-prob pass needs ~8536
MiB resident and the Docker VM had 7039 MiB free with nine live sessions on the
box, none of them abandoned. PPL and misfire rate track each other across seven
chunks (§3f) but they are not the same instrument. And `natural` here is a
one-arm control of the CONSTRUCTION only; the same-model PPL control still wants
`--chunk 8192:8192:1` on the original corpus, which must return 15.4423.

**Next, and now worth the memory:** re-run these three arms WITH log-probs for
the misfire rate, and add the same-model control chunk. Then the amount-vs-
content question is fully closed on one stack.

### RETRACTED 2026-09-03 (same day): that comparison straddled a MODEL CHANGE

**The 1.44x below is not a depth measurement and must not be quoted as one.**
Every one of its four pairs compared a chunk measured on **2026-08-24** against
one measured **today**, and the weights changed in between: `.env` at commit
`895c17c` (the last one on or before 2026-08-24) reads
`unsloth/Qwen3.8-27B-GGUF` / `UD-Q4_K_XL`, and the pin moved to `orcarouter`
`Q4_K_M` on 2026-08-25.

**How it surfaced:** a later construction reproduced the *identical text* of the
`12289..16383` chunk and returned PPL **15.4423** where two independent
2026-08-24 runs both recorded **18.2527**. The construction was verified token
for token, so the ~15% gap is the model, not the build.

**Why it is not simply "all model":** the deeper arm is the OLD model in pairs 1
and 3 and the NEW one in pairs 2 and 4. A pure model effect predicts
deeper-worse in 1,3 and deeper-BETTER in 2,4; a pure depth effect predicts
deeper-worse in all four. Observed is worse in 1,2,3 and better in 4 — pair 2
refutes pure-model, pair 4 refutes pure-depth. With four pairs and the two
crossed, **neither is separable**, and the McNemar figure is meaningless because
the pairing is not within-model.

**What it would take to settle it:** re-measure the three 2026-08-24 windows on
the CURRENT model — `--chunk 8192:4096:2` plus `--chunk 8192:8192:1`, with
log-probs — and redo the overlap analysis entirely within one stack. Add
`--chunk 8192:8192:1` on the ORIGINAL corpus as a same-model control: it must
equal the `natural` arm's 15.4423 exactly.

**The cause was a tooling gap, now closed.** `capacity-probe.sh` stamps the
engine and weights on every result and refuses to compare across them; the cliff
logs stamped nothing. `run.meta` now records `GGUF_FILE`, `MODEL_REPO`,
`LLAMA_IMAGE` and a UTC stamp, and every existing run directory has been
backfilled from git. **A run that cannot say which weights produced it will
eventually be compared with one that used different ones.**

*(The original entry follows, kept because the DESIGN — token-matched overlaps —
is right and is what the re-measurement should use.)*

### MEASURED 2026-09-03: the effect is REAL on identical tokens, and the variable is DEPTH

Two arms run (`8192:10240:1`, `8192:6144:1`), giving four windows that straddle
the existing ones. Every comparison below is **the same corpus tokens scored
twice**, so block difficulty is held exactly fixed and cancels:

| shared tokens | n | depth 6145 | depth 4097 | fillers |
|---|---:|---:|---:|---|
| 10241..12287 | 2047 | **33.8%** | 22.5% | 4096 / 6144 |
| 12289..14335 | 2047 | **26.9%** | 12.8% | 6144 / 0 |
| 14337..16383 | 2047 | **10.8%** | 8.2% | 0 / 2048 |
| 16385..18431 | 2047 | 14.3% | **16.3%** | 2048 / 4096 |

**Pooled, each token its own control (8188 paired comparisons): 21.4% vs 14.9%,
ratio 1.44x. McNemar chi2 = 358.7 on 665 vs 130 discordant pairs** — p far below
anything that matters.

**So the aliasing question is settled in favour of a real effect: it is not
block identity.** The same tokens change rate when the chunk start moves.

**But the ordering variable is NOT boundary phase.** Read the filler column: the
worse arm is filler 4096, then 6144, then 0, then (against the trend) 4096. No
phase ordering survives. What is constant is DEPTH — overlapping windows differ
by 2048 in start, so every pair contrasts a scored token sitting at **6145 vs
4097 tokens into its chunk**, and the deeper arm is worse in three of four and
overwhelmingly in the pooled test. **1.50x more history buys 1.44x the misfire
rate.** Section 2 and section 3 being "one phenomenon" holds; the phenomenon is
the DEPTH effect sections 3d/3e already measure, and boundary offset was only
ever a way of moving depth.

**And the 3.4x shrinks to 1.44x once blocks are controlled**, which is what the
aliasing predicted: the region-matched figure was carrying block difficulty as
well as depth.

**WHAT THIS STILL DOES NOT SEPARATE, and the record already said so:** history
AMOUNT from history CONTENT. Moving `s` moves both — a deeper token has more
history *and* different, earlier history — and with contiguous history there is
no third degree of freedom. **So corpus construction is still the only route to
the standing hypothesis**, and this result raises its value rather than
replacing it: there is now a measured 1.44x to explain, on identical tokens,
with a known 1.50x amount contrast.

**A memory note that matters more than it looks.** Preflight REFUSED both arms
at first: a `--kl-divergence-base` pass needs **~8536 MiB resident** (3880 logits
+ 3880 log_probs +10%) and the Docker VM had **5325 MiB** free. Dropping the
Docker VM page cache freed 4.8 GiB (5363 -> 10121) and both passed. **This is
direct support for section 1's SIGKILL hypothesis**: these passes run with a
~1.6 GiB margin against a VM whose cache fills during the run, which is exactly
the shape that gets a process killed without its EXIT trap firing. Drop the
cache before any cliff run, and read `restore.log` after.

### And an offset sweep CANNOT replace the corpus construction. Here is why.

Earlier this session it was written here that varying `A` "may answer 2 without
building any new corpora". That is wrong, and the reason is structural rather
than practical.

A token `t` is scored when its in-chunk position `p = t - s` falls in
`[N/2+1, N-1]`, so the chunk starts that score it are

```
s in [t - N + 1, t - N/2 - 1]        N=8192, t=12000 -> s in [3809, 7903]
```

4095 different starts score the same token — verified against the specs already
on disk (`start 4096 -> scored 8193..12287`, `start 8192 -> scored
12289..16383`, both matching the formula exactly). So the same token CAN be
re-scored under many histories, which is the lever section 2 wants.

**But moving `s` moves two things at once.** History CONTENT is `corpus[s, t)`
and history AMOUNT is `t - s`; across that window the amount runs 4832..7904, a
1.6x range. With CONTIGUOUS history the two cannot be separated: fix the token
and fix the amount, and `s` is determined, and so is the content. There is no
third degree of freedom.

**That is exactly why section 2 proposed corpus construction**, and the proposal
should be read as deliberate rather than as the expensive option. Changing what
is INSIDE `corpus[s, t)` — homogeneous versus mixed — varies content while
holding the token AND the amount fixed. Nothing else does.

**What an offset sweep is still worth**, and it is cheap: it varies content and
amount TOGETHER over a known 1.6x amount range, and 3d/3e already characterise
what amount alone buys. If the offset-induced swing greatly exceeds what depth
predicts over that range, content is implicated without building anything. Treat
it as a bound that decides whether the corpus work is warranted, not as a
substitute for it.

**This makes the experiment below far cheaper.** The standing hypothesis is that
the rate is set by what the history CONTAINS. Boundary offset changes exactly
that — the same scored tokens keep the same COUNT of history while its content
shifts by 4096 tokens — and `--chunk N:A:K` already varies it. So the corpus
construction described below is not the only route, and probably not the first
one: sweep A over `{0, 2048, 4096, 6144}` on ONE corpus and read the rate.

**§3f's flatness: checked, upheld where claimed, and refined.** It looked at
first like a contradiction — binning `nll_series` showed rates running 0.2% to
10.9% within one chunk. That comparison was invalid: §3f's claim is explicitly
about HIGH-rate chunks ("the worst chunk in the corpus", "the other two
high-rate chunks"), and the 0.2-10.9% case is a 5.5%-rate chunk where a bin
holds ~14 misfires and the ratio is small-count noise.

Applying §3f's own test (16 position-ordered bins, first quarter vs last) to
every chunk with an `nll_series` on disk:

| chunk (scored) | rate | Q4/Q1 | |
|---|---:|---:|---|
| 86017..90111 | 82.3% | **1.03** | §3f's own chunk — dead flat, as claimed |
| 24577..28671 | 29.5% | **0.99** | flat |
| 8193..12287 | 31.2% | 1.58 | rises |
| 16385..20479 | 23.8% | 2.54 | rises clearly |
| 12289..16383 | 11.8% | 0.48 | too sparse to read |
| 28673..32767 | 7.2% | 1.32 | too sparse |
| 20481..24575 | 5.5% | 55.72 | ~14 misfires per bin; noise |

So flatness REPRODUCES on the chunk it was measured on, and on one more — but it
is **not universal among high-rate chunks**: two of the four ramp by 1.6x and
2.5x. Both ramping chunks sit in the deep-s26b5bb half and one of them
(8193..12287) is the first scored chunk of the corpus, so an edge effect is not
excluded. Nothing here blocks the experiment below; it means "the rate is
constant across a chunk" should be read as "it can be, and is in the worst
chunks", not as a law.

**The experiment to run.** This is corpus construction, not GPU time. Build
slices whose history is deliberately homogeneous versus deliberately mixed, over
the SAME scored tokens, and see whether the rate follows. The instrument is
cheap now: one model load per pass, and with `--no-logits` zero bytes written.
You need per-token data to get the rate, so use log-probs only for the final
comparison and chunk PPL for the search.

```sh
   ./scripts/ppl-cliff-run.sh --corpus /captures/corpus/deep-plus-pi.txt \
       --from-run .ppl-depth-logs/20260824T142049Z \
       --skip-tokens --chunk 8192:<A>:1
```

`--chunk N:A:K` isolates K chunks of `n_ctx` N starting at corpus token A;
`perplexity.cpp:547` clears the memory per batch, so a chunk's result depends on
nothing but its own N tokens. The arm's per-chunk number is the control and
`--from-run` reads it rather than having it typed in. Thirteen for thirteen so
far.

`result.json` carries the whole rounded per-token NLL series, so anything you
have already measured can be re-analysed with no GPU at all.

---

## 3. The rotation asymmetry — NARROWED; 2026-09-03 rules OUT depth and retracts the "one phenomenon" inference

*(It still taints per-span numbers: an 8192 per-span figure must carry its
rotation. What changed is that two explanations are now dead and the effect
has a dose-response curve — see the 2026-08-31 section below.)*

At `n_ctx` 8192 the F=4096 rotation has a median delta-NLL of 2.597 against
F=0's 0.365, and nine of the ten highest-delta spans come from F=4096
(hypergeometric p ~ 0.003). It shows as a period-2 lag-1 autocorrelation of
-0.34 that the rotation-BALANCED 2048 and 4096 series (+0.09, +0.01) do not
have, and document difficulty does not alternate. The arm aggregates carry the
same asymmetry at every depth, same sign, growing with the filler: 8.6 %, 110 %,
212 %.

**It reproduces under isolation**, so it is real inference behaviour on those
tokens — not indexing, not a corrupt arm file (all three were verified
byte-exact as `filler + corpus`).

**Why it is strange:** both rotations score in-chunk positions `N/2+1 .. N-1`
with the same distribution of true history. There is no structural difference to
point at. Either there is one nobody has found, or the corpus really does
alternate in difficulty at an 8192-token period, which the rotation-balanced
instruments say it does not.

**Until it is explained, an 8192 per-span number must carry its rotation.** The
span map at grid 4096 feeds each cell from exactly ONE rotation, which is how
this hid in §3e.

### 2026-08-31: narrowed, with no GPU. `scripts/rotation_asymmetry_analyse.py`

Two tests the original pass could not run, because both need depth 2048 as a
control. Re-derives the 2.597 / 0.365 figures first, so it is anchored.

**1. It is NOT span selection, and the control runs the OTHER WAY.** At depth
8192 each span is fed by exactly one rotation, so "rotation 4096 is worse" and
"its spans are harder" are confounded by construction. Depth 2048 IS
rotation-balanced, so it prices a span's intrinsic difficulty independently.
Comparing amplification `log(ppl@8192 / ppl@2048)` — replicated over three runs:

| run | rot 0 med ppl@2048 | rot 4096 med ppl@2048 | rot 0 log-amp | rot 4096 log-amp | p (median) |
|---|---:|---:|---:|---:|---:|
| 110429Z | 10.55 | 3.34 | 0.365 | 4.071 | 0.011 |
| 132817Z | 13.66 | 8.31 | 0.365 | 2.586 | 0.007 |
| 142049Z | 13.66 | 8.31 | 0.365 | 2.597 | 0.007 |

Rotation-4096's spans are **easier** at the balanced depth in all three, and
still amplify 13x against 1.4x. Coverage/selection is dead as an explanation.

**2. It is a DOSE-RESPONSE, not a two-arm oddity.** `20260824T114717Z` carries
FOUR rotations at n_ctx 8192. A chunk boundary lands at corpus index `-F (mod
8192)`, giving each arm a circular distance from the F=0 alignment:

```
distance 0     -> ppl  14.77      (F=0)
distance 2048  -> ppl  36.58      (F=2048)
distance 2048  -> ppl  48.98      (F=6144)
distance 4096  -> ppl 227.67      (F=4096)
```

Monotone, and the two arms at EQUAL distance agree within 1.34x while the
extremes differ 15x. (Caveat the script prints: F=6144 has `kept=[3,8]` against
the others' `[2,8]`, so it scores fewer tokens.) A binary asymmetry has become a
curve, which is a much stronger constraint on any mechanism.

**3. The document junction is NOT the cause.** `deep-plus-pi.txt` is
`deep-s26b5bb + "\n\n" + pi-150turn` — ONE junction, at ~65-73k tokens (its
README: deep-s26b5bb alone gives 8 chunks at n_ctx 8192). The four-rotation run
windows `[8192, 65536]`, ending at or before that junction, so the monotone
ordering above is produced with **no junction inside the scored range**.

### 2026-09-03: per-token data now exists for ALL FOUR rotations, and depth does NOT explain it

**First, a trap that will misalign anyone cross-referencing the two scripts.**
`ppl-depth-run.sh`'s `filler` F is the number of tokens PREPENDED, so its chunks
start at corpus index `-F (mod 8192)`. A cliff chunk's natural label is
`start mod 8192`. **They are negatives of each other:**

```
my_filler = (8192 - F) mod 8192      F=0 <-> 0, F=2048 <-> 6144,
                                     F=4096 <-> 4096, F=6144 <-> 2048
```

Only 0 and 4096 are fixed points, which is exactly why this can go unnoticed —
the two arms people quote most are the two that agree.

**The two arms run for section 2 landed on the two rotations that had no
per-token data**, so the first chunk of every rotation now has an `nll_series`:

| F | scored | chunk ppl | misfire | arm ppl (7 chunks) |
|---:|---|---:|---:|---:|
| 0 | 12289..16383 | 13.8 | 11.8% | 14.77 |
| 2048 | 10241..14335 | 114.6 | 24.7% | 36.58 |
| 4096 | 8193..12287 | 400.0 | 31.2% | 227.67 |
| 6144 | 14337..18431 | 16.7 | 11.2% | 48.98 |

**All four score in-chunk depths 4097..8191 — depth is matched by construction —
and the rates still differ nearly 3x.** So the rotation asymmetry is NOT the
depth effect. Per-depth profiles say the same: they do not share a shape
(F=0 is hump-shaped, F=6144 U-shaped, F=2048/4096 high throughout), so there is
no common depth curve being shifted.

**This RETRACTS the section's closing inference.** It ends "§2's standing
hypothesis is that the misfire rate is set by what the history CONTAINS ... §2
and §3 are probably one phenomenon". Section 2 has since been measured
token-matched and the variable there is **depth**, not content — and depth is
precisely what this section holds fixed. The two are therefore **not** obviously
one phenomenon, and the inference should not be carried forward as though they
are.

**And the size does not work either.** The 4-rotation grid scores almost every
token **twice** (8188 of 8192 per period, at two depths 4096 apart) — verified,
not assumed. Those token-matched contrasts are exactly what section 2's overlap
arms measured, and they came to **1.44x**. The arm spread here is **15x**. A
1.44x per-token depth effect cannot produce it.

**So what is left is narrower than before:** the rotations differ in WHICH
tokens each scores at depth, and section 3's own test 1 already killed intrinsic
span difficulty (rotation 4096's spans are EASIER at the balanced depth). What
survives is an INTERACTION — hard content systematically landing deep in one
rotation and shallow in another — which the grid cannot separate because
rotation sets depth. Testing it needs the per-token series for whole arms, not
first chunks: score one rotation's full window with `--kl-divergence-base` and
compare the rate of the SAME tokens against the other rotation that scores them.
That is a real GPU cost (7 chunks x 2 rotations) and is the honest next step.

**What is left, and why it now points at §2.** The only thing that differs
between rotations is where each scored token's HISTORY BEGINS: F=0's chunks
start at corpus indices congruent to 0 (mod 8192), F=4096's at 4096. Both give
the same COUNT of real history (4097..8191 tokens). §2's standing hypothesis is
that the misfire rate is set by what the history CONTAINS, not how much of it
there is — and a dose-response in boundary offset is exactly the shape that
predicts. **§2 and §3 are probably one phenomenon**, and §2's corpus-construction
experiment is the way to test it: it already varies history composition over the
same scored tokens, which is this effect with the confound removed.

---

## 4. One tooling loose end — DONE 2026-08-31

`token_pass()` in `ppl-cliff-run.sh` built its waiter as an interpolated
`python -c "…"` string. Stage 1 used to do the same and a backtick in a COMMENT
became shell command substitution — `line 245: sl: command not found` — which
landed inside a comment and corrupted nothing, by luck.

The waiter is now `scripts/ppl_cliff_wait.py`, staged with `stage_script` like
`ppl_cliff_stage.py`, invoked with `--path` / `--timeout`. The shell parses
arguments and nothing else.

Verified against synthetic fixtures rather than a GPU pass (four cases, all
green): a complete array exits 0; a wrong magic exits 1 AND prints the actual
header bytes, so "flag dropped" and "stale file" can be told apart; a header
with a short array times out at 1; and the real sequence — file absent, then
appearing mid-wait — is detected and exits 0. Log output is byte-identical to
the inline version, so pass logs do not change shape.

---

## 5. Browser anti-injection — shipped, AUDITED 2026-08-31, mcp.sh CLOSED 2026-09-03; one path remains

Three layers went in on 2026-08-24:

- `prompts/web-untrusted.md` → appended to the SYSTEM PROMPT by
  `scripts/pi-local.sh` whenever `BROWSER_MCP_ENABLED=1`. ~460 tokens, once.
- **The envelope**, which is the part that actually helps: every browser result
  is wrapped in nonce-delimited `BEGIN/END UNTRUSTED WEB CONTENT` markers, so
  the disclaimer sits next to the injection attempt rather than 40,000 tokens
  upstream, and a page cannot close a fence whose tag it cannot guess.
  `scripts/untrusted_content.py` (CLI path) and `.pi/extensions/browser-guard.ts`
  (native-tool path); 14 tests, including one asserting the two BANNER copies
  are byte-identical.
- A section in both `skills/browser/SKILL.md` and `skills/browser-tools/SKILL.md`.

**Verified end to end on a live page** for the CLI path: content wrapped with a
fresh nonce, `start_browser` not wrapped, `--json` not wrapped, errors not
wrapped.

**The native-tool path is now verified, and verifying it found a bug.** A live pi
session on 2026-08-24 wrapped `browser_navigate` and `browser_get_text_content`
correctly — and also wrapped an ERROR, which it should not have.

The cause is that **`isError` does not mean what it looks like**. From pi's
`executePreparedToolCall`:

```
   try   { let result = await prepared.tool.execute(...); return { result, isError: !1 } }
   catch { return { result: createErrorToolResult(...), isError: !0 } }
```

`isError` is true ONLY when a tool throws. The browser MCP server RETURNS its
failures, so every one of them arrives with `isError: false`. Two consequences,
both now fixed: browser errors were being fenced as though a page wrote them,
and the extension's original timeout-advice branch — which gated on `isError` —
had been **unreachable for the exact failure it was written for** since it was
written. Failure is now detected from the text (`TOOL_FAILURE`), and
`.pi/extensions/tests/browser-guard.test.ts` pins both directions.

### 2026-08-31: the tool-surface audit, done. No GPU, no live browser needed.

**Two paths are covered, and both are DENY-lists — wrap everything except a
short control set.** That is the safe shape, and it is why the audit came back
mostly clean:

| path | mechanism | rule |
|---|---|---|
| browser MCP (native + adapter) | `.pi/extensions/browser-guard.ts` | admits any `browser_` / `mcp__browser__` tool, wraps all success output except `CONTROL_TOOLS` |
| browser CLI | `scripts/browser_cli.py` -> `untrusted_content.wrap_if_needed` | `needs_wrapping = tool not in CONTROL_TOOLS` |

**A false alarm, recorded so nobody re-raises it.** `BROWSER_TOOL` lists only the
five natively-registered tools, so `browser_call_tool` — the gateway that
reaches ~98 underlying tools and, per its schema, "returns exactly what the
underlying tool returns" — looks unfenced. It is not. That regex is consulted
only in the ERROR-ADVICE branch; the wrapping decision upstream keys on the
`browser_`/`mcp__browser__` PREFIX. A test written to prove the hole passed
against unmodified code, which is how the reading was caught.

Two characterization tests now pin it (`browser-guard.test.ts`, 13 tests green):
`browser_call_tool` and `mcp__browser__call_tool` results must carry the
envelope. They pass today and would fail the moment anyone converts that gate
from a prefix deny-list to a name allow-list — which is the plausible regression.

**Still uncovered, and now enumerated:**

1. **`bash` -> `curl` / `wget`.** As previously noted. Web-derived text straight
   into the transcript with no envelope.
2. **`bash` -> `./scripts/mcp.sh <server> <tool>` — NEW.** A generic
   MCP-over-CLI gateway (mcp2cli) whose output arrives as ordinary bash output;
   `scripts/mcp.sh` contains no wrapping of any kind. **Latent, not live:** the
   only registered server today is the reference `everything` server (13 demo
   tools, nothing web-facing), so nothing web-derived currently flows through
   it.

   **CLOSED 2026-09-03 — done before the trigger, not after.** Waiting for a
   web-facing server to be registered meant relying on whoever registers it
   having read this file, which is exactly the person who will not have. So the
   default is now to wrap, and inertness must be *claimed*:

   - `mcp/servers.json` gains an **`inert`** key. **Absent means untrusted.**
     Only `everything` (the reference demo) declares it, and a test asserts no
     other entry may claim it without a reader confirming it.
   - `scripts/mcp.sh` no longer `exec`s mcp2cli — it cannot, because something
     has to outlive the call to close the envelope. It pipes stdout through
     `untrusted_content.py`, with `pipefail` so a server failure still
     propagates its exit status instead of being masked as 0 by the envelope.
   - **stderr is deliberately not piped.** A transport or usage error is the
     tool's own voice, not server-controlled content — fencing it is the same
     bug `browser-guard.ts` already had to fix once.
   - **Discovery is not wrapped** (`--list`, `--search`, `--version`, and
     `<tool> --help`): those describe the server's own surface, and burying
     every tool lookup in a banner teaches that the envelope is noise.
   - `untrusted_content.py` grew a stdin-filter CLI so the shell path reuses
     the one banner. It is **not** re-implemented in bash — there are already
     two copies (py and ts) held byte-identical by a test, and a third would be
     the one that drifts.

   Eight tests added (`test_untrusted_content.py`, **22 total**, was 14) and
   **controlled in both directions**: with `WRAP=1` forced to 0, three fail;
   with the gate loosened from `is True` to a truthy check, exactly the test
   written for that regression fails. Verified end to end against a stub that
   emits an injection payload on stdout, an error on stderr, and exit 7.

The general principle both covered paths follow, and which any third should:
**wrap unless the tool is known-inert.** An allow-list of content tools is the
shape that fails, because the surface grows and the list does not.

---

## 6. Pre-existing backlog, untouched

- **Tighten the acceptance null.** One depth (64K, 32K prompt), one workload,
  detection floor 6.9 % relative. `--workload repeat` (`bench_repeat.py` reports
  ECHO, so "the drafter did nothing" is distinguishable from "the model did not
  repeat anything") and `--bench-args '--prompt-len 60000'`. Cheap.
- **`eval_expr` at `--repeat 20`, two levels.** The task set is not
  deterministic, so one grid cell is one sample; existing evidence is medium 6/5
  clean and xhigh 5/3 clean — directionally what the bench detects, not
  separable at n=5.
- **Yours rather than mine.** `FORGE_MERGE_ACROSS_TOOLS=1` at real depth (needs
  capture ON for a working session); the four `s735f17` records on the tape
  (real session data — do not use or delete without asking); a GPU-heavy
  foreground VRAM floor. **PARTLY OBSOLETE 2026-09-03.** The premise was that
  every "does it fit" verdict is priced against an idle desktop. The 128K probe
  that day ran with the desktop at **2481 MiB** — near the 09-02 *median*, not
  idle — and 128K is no longer decided by fit at all: it is refused on **cost**
  (decode 50.2 -> 26.1 tok/s). What survives, and is worth more than the
  original item, is that the floor moved **765.8 MiB inside one 11-minute
  capture** and ~1.2 GiB across a day in each direction. A GPU-heavy foreground
  is one point on a distribution nobody should be sampling once. See
  `vram_note` / `ctx_128k_verdict`.

---

## Running this stack without lagging the machine

Learned expensively on 2026-08-24. `//d/llm-models` and `//d/llm-captures` are
9p binds of Windows drives, served by a process on the HOST against the same
physical disk Windows runs on. Heavy traffic there lags the host in a way
container CPU does not, and **none of it appears in `/proc/diskstats`** because
the mount is not a block device in here.

- **Use `--no-logits` unless per-token data will actually be read.**
  `--kl-divergence-base` writes `2*((n_vocab+1)/2)+4` uint16 per scored token —
  on this model's 248,320 vocabulary that is 496,648 bytes A TOKEN, or 2.0 GiB
  per 8192 chunk. §3d's D1 established that omitting it is byte-identical in the
  printed perplexity and ~10x faster.
- **Batch chunks into one pass.** Each pass re-reads the whole 17.5 GB GGUF
  (`--load-mode none` disables mmap, and it is not optional — without it
  demand-paging runs at 6.4 MB/s and is indistinguishable from a hang).
  `--skip-tokens` saves another load.
- **Do not drop the page cache.** I did it four times to make room for buffers
  that were never the binding constraint, and every subsequent model read came
  off the physical disk again.
- **Do not touch llama while a pass holds the card.** Restarting it mid-pass put
  two 17.5 GB reads in contention.
- **Do not launch long runs with `nohup … &` from a tool call.** They get reaped
  mid-run and leave an attached `docker run` orphaned — its stdout buffer fills
  with no reader and the container wedges holding VRAM.
- **Container load average is a bad proxy.** The box has 16 cores. During the
  one complaint, the CPU was a `cc1plus` build, an `eslint` run and a node test
  suite in OTHER sessions.

The three f16 runs cost ~11 model loads (~280 GB read) and ~25 GB written. The
q8_0 run, after these lessons, cost 2 loads, ~35 GB, and zero bytes written.
