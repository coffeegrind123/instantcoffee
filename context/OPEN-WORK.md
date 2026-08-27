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

## 1. The runner exits 1 and skips its own last two steps — UNEXPLAINED

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

---

## 2. What sets the misfire rate — the actual science left

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

## 3. The rotation asymmetry — unexplained, and it taints per-span numbers

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

---

## 4. One tooling loose end

`token_pass()` in `ppl-cliff-run.sh` still builds its waiter as an interpolated
`python -c "…"` string. Stage 1 used to do the same and a backtick in a COMMENT
became shell command substitution — `line 245: sl: command not found` — which
landed inside a comment and corrupted nothing, by luck. Stage 1 is now
`scripts/ppl_cliff_stage.py`, a file, and the shell parses only arguments. The
waiter should follow. It works today; it is a trap for whoever edits it.

---

## 5. Browser anti-injection — shipped, but one layer is untested in anger

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

Still unexamined: whether anything else on the tool surface returns web-derived
text without going through these two paths. `curl` output via bash is NOT
wrapped and arguably should be.

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
