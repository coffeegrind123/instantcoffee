# Open work — written 2026-08-24 for whoever picks this up cold

`context/HANDOFF.md` is the record of what happened. This file is the opposite:
only what is NOT done, with enough detail to start without re-deriving anything.
Ranked by what I would do first.

**Before anything else, read "Running this stack without lagging the machine" at
the bottom.** Two sessions' worth of I/O lessons are in it and they are cheap to
re-learn expensively.

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

## 0f. llama-server ABORTED on a CUDA assert, on the ngram-map path — 2026-09-01

**This happened; it is not a hypothesis.** Six hours into the boot that adopted
`ngram-map-k` (the pin from 0c/0d, adopted the same day), at 18:38 UTC:

```
348.38  W srv alloc: - prompt state size 8485.588 MiB exceeds cache size
                       limit 2048.000 MiB, skipping
354.13  I common_ngram_map_begin: shrink cleanup begin: 61573 -> 12161
354.15  I common_ngram_map_begin: refresh map: idx_last_draft=62362,
                       new begin=12221, #keys_checked=165, #keys_del=162,
                       #values_del=0, #hashes_upd=30834
/app/ggml/src/ggml-cuda/ggml-cuda.cu:2651: GGML_ASSERT(stat == cudaSuccess) failed
  ggml_abort -> ggml_backend_sched_graph_compute_async -> llama_context::decode
```

Line 2651 in b10689 is the `else` of `ggml_cuda_graph_update_executable`:
`cudaGraphExecUpdate` returned something that is neither `cudaSuccess` nor
`cudaErrorGraphExecUpdateFailure`. A sticky error latched by an earlier async
failure returns there, so **the assert is where it surfaced, not where it
happened.**

**The upstream match, found with `gh` and read rather than remembered:**
[ggml-org/llama.cpp#23154](https://github.com/ggml-org/llama.cpp/issues/23154),
"CUDA ERROR crash when using MTP ngram-mod" — same RTX 4090, same
`--spec-type ngram-*,draft-mtp`, same `ggml_cuda_graph_update_executable`, with
the reporter's own before/after: VRAM flat at 76% WITHOUT `ngram-mod`, climbing
to 100% and crashing WITH it. **Closed 2026-07-31 as stale, never fixed.**

**What is measured here, and what is not.**

- Measured: 1 abort in ~6 h of that boot. No CUDA crash is recorded anywhere
  else in this repo's history — `grep -ri "GGML_ASSERT\|CUDA error" docs/
  context/` finds only the changelog entry written for this one.
- Measured: VRAM steady state after the restart is **22809 / 24564 MiB, 1334 MiB
  free**, on a GPU shared with the Windows desktop and 16 other compute clients
  (`nvidia-smi` via the host bridge; it is not available inside the container).
  That is the entire headroom a growing spec map has to grow into.
- NOT measured: whether `ngram-map-k` is any worse than `ngram-mod` here. Both
  are in the family #23154 names, and this stack ran `ngram-mod` for a day
  without a recorded crash — which is an absence of evidence, not evidence.
  0c/0d's benchmark rounds are short repeat workloads; they never reach the
  60K-token context, the LRU slot eviction, or the 8.5 GiB prompt-state shrink
  that preceded this abort.

### MEASURED 2026-09-01, after the restart: llama's VRAM does not move

The first of the three steps below has been done, and it comes back negative.

`vram-floor.sh`'s method — the Windows `\GPU Process Memory(*)\Dedicated Usage`
counter for the `vmwp` process, which that script established IS llama and
nothing else on this box — sampled every 15 s across six back-to-back
2,500-token heavy-thinking generations (15,000 tokens):

```
samples=29   llama first=20995.0  last=20995.1  min=20995.0  max=20995.1
             span = 0.1 MB
```

The device total moved by ~200 MiB over the same window; all of it was the
desktop. **#23154's shape — VRAM climbing while the model thinks — does not
reproduce here at small context.** That is not proof the abort was not an
allocation failure, but it removes the leading hypothesis, and it moves the
suspicion from "ran out" to "read out of range": `cudaGraphExecUpdate` returning
a STICKY error latched by an earlier async failure would land on exactly the
assert that fired, and an index that just moved backwards by 49,000 positions is
the obvious candidate for producing one.

If a reproduction is obtained, the instrument that names the real failure site is
`CUDA_LAUNCH_BLOCKING=1` in the llama service's `environment:` — it makes every
launch synchronous, so the abort points at the failing kernel instead of at the
next CUDA call after it. Slow, and correct for one diagnostic run.

**So do not revert the +38.7% pin on this.** One crash does not indict a
measured result, and the honest next step is instrumentation, not a rollback:

1. **Log VRAM across a long agentic session.** `nvidia-smi --query-gpu=memory.used
   --format=csv --loop=30` through the host bridge, alongside a real pi session
   that grows past 50K tokens. #23154's whole claim is a climb; either it climbs
   here or it does not, and that is one afternoon of watching, not a rebuild.
2. If it climbs, the same session with `SPEC_TYPE=draft-mtp` alone is the
   control that separates the ngram map from everything else.
3. `GGML_CUDA_DISABLE_GRAPHS=1` in the llama service's `environment:` removes
   the code path the assert lives in. It costs throughput and does NOT fix a
   leak — it moves where a leak lands — so it is a diagnostic, not a fix.
4. More headroom is the other lever: `--cache-ram 2048` and 16 context
   checkpoints are both VRAM-adjacent, and `capacity-probe.sh` exists to say
   what they cost.

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

## 1. The runner exits 1 and skips its own last two steps — NARROWED to the launch shape

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

**Corroborating evidence from the same day, unplanned:** the crash also killed a
`spec-sweep.sh` run that had been launched with `setsid nohup` — and that one
did NOT survive, because the crash took the whole container's process tree, not
just a session. Worth knowing which failures `setsid` does and does not cover.

Both environment hypotheses in this section are now closed. Do not re-open them
without new evidence; both tests are recorded above and both were negative.

---

## 2. What sets the misfire rate — NARROWED 2026-08-31 to the boundary offset

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

## 3. The rotation asymmetry — NARROWED 2026-08-31, mechanism still open

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

## 5. Browser anti-injection — shipped and AUDITED 2026-08-31; two unwrapped paths remain

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

   **The trigger to watch for:** this becomes a real hole the moment a
   web-facing server is registered — a fetch/search/scrape server, or the kind
   of custom reddit/searxng extension other setups in this space add. If that
   happens, `scripts/mcp.sh` needs the same `wrap_if_needed` treatment
   `browser_cli.py` already has; the function is importable and the rule is one
   line.

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
  foreground VRAM floor (every "does it fit" verdict is priced against a floor
  measured on an idle desktop).

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
