# ngram-mod measured, and the load confound that nearly sold it twice

2026-08-31. Source: five r/LocalLLaMA threads on Qwen3.8-27B (1vq881r, 1vr32vs,
1vtxj05, 1w2ljy7, 1vwowbu, 1w2pk15), read in full. Most of what they recommend
this repo had already measured and refused; the exception was `ngram-mod`, which
had zero mentions here and which this build supports.

**Verdict: `ngram-mod 12:64:32` is +23.3% on the repeat workload (p=0.0011),
replicated, and RECOMMENDED for the pin. `8:32:24@n3` is rejected.** The pin is
left unchanged in this commit because changing it is the operator's call, not a
side effect of a measurement; the change is one `.env` edit, at the bottom.

## What the threads already agreed with

Cited so nobody re-derives them:

| Their tip | Already settled here |
|---|---|
| `--fit off`, "fit wastes 1 GB" | `HANDOFF.md:1085` — `--fit on` is a no-op here, observed |
| `-b 256 -ub 64` to buy context | `.env:830` — `-b/-ub` unset deliberately, cost ~850 MiB |
| `-ctkd/-ctvd q4_0` for the draft cache | `vram-floor-and-the-shared-desktop.md:376` — do not set |
| beellama for better KV quants | `kvarn-measured-and-refused.md` — evaluated, refused |
| `--spec-draft-p-min 0.7` is fastest | Contradicted: p-min 0.75 is the SLOWEST arm here. `.env:382` has the mechanism — the p-min gate is tested before the n-max gate |

## The pin was resting on a different model

Every row of the pre-existing spec-sweep table was stamped `[DIFFERENT STACK]`:

```
ctx_size:   65536 -> 98304
gguf_file:  Qwen3.8-27B-UD-Q4_K_XL.gguf -> Qwen3.8-27B-Uncensored-Q4_K_M.gguf
model_repo: unsloth/... -> orcarouter/Qwen3.8-27B-Uncensored-GGUF
llama_tag:  server-cuda-b10573 -> server-cuda-b10689
```

`ngram-simple / n-max 4 / p-min 0.40` had never been checked against the model
we actually serve. It has now, and it holds up.

## The finding that dwarfs the knobs

On the repeat workload (the shape pi produces), every ngram arm runs **1.8-2.3x**
every pure-MTP arm: 157-210 tok/s against 77-103.

Read `ACCEPT` carefully, because it inverts. The MTP-only arms post 95-99%
acceptance and are the slowest rows on the board — acceptance bought by refusing
to draft, at `DRAFT/CYCLE` 2.0 against 24.5. This is `.env:378`'s warning with
numbers on the current stack.

## The load confound, which is the real lesson

Three measurement attempts, three different load regimes, and the first two are
void:

1. **16-arm sweep.** Host load fell 31 -> 3 during it. The ngram-mod arms are
   last in the grid, so they were measured on the quietest box of the run and
   "won" by up to 16%. Did not reproduce.
2. **Follow-up at `--repeat 7`.** Load climbed 1.4 -> 23.8 (other sessions
   started C++ builds), penalising the same arms in the same direction.

The control number: **the same config, unchanged, measured 181.4 then 202.3
tok/s.** A 12% swing with nothing different but the machine — wider than the gap
between most rows the sweep exists to rank.

This box is shared with eight working sessions. "Wait until it is quiet" is a
wish, not a method.

## What was built in response

- **Load stamping.** Every result records `load_before` / `load_after` /
  `load_warn`. A bench above threshold warns at measurement time and `--report`
  flags it under `==> load`. The first sweep's rows now correctly read "no load
  recorded — cannot be shown to have been measured on a quiet box."
- **`--rounds N` with rotation.** Configs run in a rotating order (`A B C` /
  `B C A` / `C A B`, verified a Latin square) so drift lands on all arms equally.
  Round 1 is discarded when a second round exists.

## The interleaved result

Three configs, three rounds, both workloads, `--repeat 4`. Load stamps per round:

```
round 1   pin 4.35->6.32   12:64:32 3.48->3.43   8:32:24@n3 2.88->3.19   even
round 2   pin 3.31->3.85   12:64:32 36.6->40.2   8:32:24@n3 13.6->11.5   SPLIT 10x
round 3   pin 2.81->3.41   12:64:32 3.55->3.83   8:32:24@n3 2.75->2.40   even
```

Round 2 is excluded on load evidence — a 10x load difference *between configs
inside one round*, systematically favouring the incumbent. Pooling the two clean
rounds (n=8 per config, two-sided permutation test):

| workload | config | delta | p |
|---|---|---:|---:|
| repeat | `ngrammod-12-64-32-n4` | **+22.8%** | 0.0014 |
| repeat | `ngrammod-8-32-24-n3` | +8.8% | 0.074 |
| synthetic | `ngrammod-12-64-32-n4` | -3.1% | 0.52 |
| synthetic | `ngrammod-8-32-24-n3` | +5.0% | 0.28 |

**And the sensitivity analysis, which is why this is not being adopted:**

| rounds used | delta for `12:64:32` | p |
|---|---:|---:|
| 1+3 (clean) | +22.8% | 0.0014 |
| all three | +10.5% | — |
| 2+3 (the script's own default) | **+2.1%** | **0.797** |
| 3 only | +17.3% | 0.143 |
| 1 only | +28.2% | 0.029 |

Every subset is positive, so the *direction* is robust. The *magnitude* ranges
over an order of magnitude depending on a defensible analysis choice, and the
script's default analysis finds nothing at all. A 22.8% headline that becomes
2.1% under a different-but-reasonable exclusion rule is not a basis for changing
a production pin.

Note also that round 1's rotation puts the pin FIRST, so it pays the coldest
cache — round 1 is mildly biased against the incumbent, in the opposite
direction to round 2. Neither clean round is perfectly neutral.

## The run that settled it (5 rounds, 2026-08-31)

`--rounds 5 --repeat 4`, both workloads, three configs. 30 results, zero
failures, 110 minutes. Round health, decided by
`scripts/spec_sweep_compare.py` from the recorded load stamps:

```
round 1  DROP  LOAD-SPLIT 2.6x  [12:64:32 4.2, pin 4.4, 8:32:24@n3 10.1]
round 2  DROP  LOAD-SPLIT 4.1x  [8:32:24@n3 3.9, pin 4.1, 12:64:32 13.3]
round 3  USE   even 2.3-6.8     [12:64:32 2.3, pin 4.0, 8:32:24@n3 6.5]
round 4  USE   busy but even    [8:32:24@n3 3.7, pin 7.6, 12:64:32 8.2]
round 5  DROP  LOAD-SPLIT 3.9x  [12:64:32 12.9, 8:32:24@n3 34.0]
```

Three of five rounds were load-split by other sessions' C++ builds. Two
survived, which is replication.

**repeat workload, pooled over rounds 3 and 4 (n=8 per config):**

| config | mean | delta | p |
|---|---:|---:|---:|
| `ngram-pmin-040-n4` (pin) | 184.8 | — | — |
| `ngrammod-12-64-32-n4` | **227.9** | **+23.3%** | **0.0011** |
| `ngrammod-8-32-24-n3` | 195.4 | +5.7% | 0.112 |

**Why this one is believable where the earlier ones were not.** Three
independent checks, all of which the morning's attempts failed:

1. **The load advantage runs OPPOSITE ways in the two scored rounds.** In round
   3 the candidate was quieter than the pin (2.3 vs 4.0); in round 4 it was
   busier (8.2 vs 7.6). The effect is the same size in both, so it is not load.
2. **The sensitivity barely moves.** Across every round subset:
   `usable 23.3%, all 23.2%, r1 27.3%, r2 13.6%, r3 24.2%, r4 22.2%` — always
   positive, tight band, and the two headline analyses agree to a tenth of a
   percent. Contrast the morning's interleaved run, where the same config
   ranged +2.1% to +28.2% depending on which rounds were kept. THAT is what an
   unsettled result looks like.
3. **`--report` and `spec_sweep_compare.py` agree independently**, +23.6% and
   +23.3%, by different round-selection rules.

**`8:32:24@n3` is rejected on the same evidence.** Its sensitivity row changes
SIGN across subsets (-5.1% to +10.6% on repeat, -13.1% to +4.2% on synthetic).
By the criterion above that is not a finding.

**The synthetic side is weak and must not be over-read.** Only one round
survived, and `12:64:32` measures -2.1% (p=0.80) with a band straddling zero
(-10.6% to +11.2%). The honest statement is *no cost detected on novel text, on
an underpowered measurement* — not *no cost*.

## Independently replicated (2026-08-31 evening, after the pin was applied)

A second run, `--rounds 6 --repeat 4`, two configs only — because the failed
five-config run established that round DURATION drives split probability, and
two configs give ~26 min rounds instead of ~65. 24 results, zero failures.

Four of six rounds were load-split by other sessions; rounds 2 and 6 survived,
n=8 each, balanced:

| config | mean | delta | p |
|---|---:|---:|---:|
| `ngram-pmin-040-n4` | 175.9 | — | — |
| `ngrammod-12-64-32-n4` | **215.1** | **+22.3%** | **0.0002** |

Sensitivity across all eight subsets: `22.3, 19.1, 21.9, 20.3, 10.1, 19.6,
18.9, 24.3` — every one positive, band 10-24%.

**This is an independent replication of the +23.3% above**: different rounds,
different hours, a different load regime, agreeing to within one point.

**And the load ran AGAINST the candidate.** In rounds 3, 4 and 5 `12:64:32`
benched at 2-5x the pin's load and still won by 10-19.6%. Those are conservative
measurements. The one bias worth naming is round 2, where the candidate was the
quieter arm (5.2 vs 9.8) — but round 6 was even (4.8 vs 5.8) and reads +24.3%,
the highest of the two scored rounds, so the result does not depend on it.

### The synthetic side is STILL not settled, after twelve rounds across two runs

Only round 6 survived here (`+4.0%, p=0.46`), and its sensitivity CHANGES SIGN:
`-12.9%` to `+4.0%`. By the criterion applied everywhere else in this document
that is not a finding in either direction.

What can honestly be said after six more rounds: the synthetic delta stayed
within +-13% and centred near zero, with no subset showing a large or consistent
penalty. That is **bounded reassurance, not proof of no cost**. It was checked
whether the negative readings track the candidate's load disadvantage — they do
not cleanly (round 2 had the candidate ADVANTAGED and still read -3.4%), so it
reads as noise around zero rather than a suppressed real effect.

**Status of the live pin: its primary-workload benefit is established twice,
independently. Its novel-text cost remains unmeasured, bounded loosely at
"nothing large or consistent across twelve rounds."**

## Applying it

One edit, and the ngram arm changes from `ngram-simple` to `ngram-mod`:

```
SPEC_TYPE=ngram-mod,draft-mtp
SPEC_DRAFT_N_MAX=4
SPEC_DRAFT_P_MIN=0.40
SPEC_NGRAM_MOD_N_MIN=12
SPEC_NGRAM_MOD_N_MAX=64
SPEC_NGRAM_MOD_N_MATCH=32
```

Then `./scripts/up.sh` and `./scripts/smoke-test.sh`. If it is ever reverted,
the reason to record is a synthetic-workload regression, which is the one thing
this run could not rule out.

## Superseded: the run that was going to settle it

One overnight `--rounds 5` on the three configs, started when no other session is
building. That yields four scored rounds with no exclusions needed, which either
confirms +20% (adopt it) or collapses it toward +2% (close the question).

```
./scripts/spec-sweep.sh --workload synthetic,repeat --rounds 5 --repeat 4 \
  --results-dir context/bench/spec-sweep-overnight \
  --only ngram-pmin-040-n4,ngrammod-12-64-32-n4,ngrammod-8-32-24-n3
```

Check `==> load` in the report before believing the table.

## Also unevaluated

`ngram-map-k`, `ngram-map-k4v`, `ngram-cache` are in this build's `--spec-type`
list and have never run here. Adding them is four `CONFIGS` rows now that the
grid carries ngram knobs.

ninfer (`sergiuszm/ninfer-4090`, an independent 4090 port whose author also runs
pi) documents 262,144 context at 126.6 t/s decode on this card against our
98,304; syv-ai/qwen38-27b-rtx3090 documents 121-133 tok/s on a *3090* under vLLM.
Both are engine changes, not knobs, and both would cost the uncensored fine-tune
this stack serves — ninfer loads only the official artifact. Contrary evidence
exists too: one commenter benchmarked vLLM beating ninfer on real agentic
workloads above ~8k context.
