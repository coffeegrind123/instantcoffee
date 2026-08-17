# Handoff — 2026-08-17 (second audit: the seam, not the pieces)

The brief was to evaluate subagents, the loop and the verifier comprehensively
and write it up. The evaluation found **eleven defects**, four of them proven by
running code against the real modules rather than by reading, and **two of the
first audit's conclusions were wrong at runtime**. Ten are now fixed. One is left
open on purpose, and it is a scope call rather than a repair — see below.

The write-up is `context/design/subagents-loop-verifier-evaluation.md`: findings,
reproductions, ASCII diagrams of the runtime shape, and §10 for what shipped.
The first audit's `subagents-loop-verifier-anatomy.md` is still the document to
read for *design*; it now carries five inline corrections pointing here. Decision
history is the new `## 2026-08-17 (second audit)` entry in
`context/design/decisions.md`.

---

## The one-line version

Each of the three pieces is well built. **Every defect was in the wiring between
two of them**, which is also why 133 passing tests caught none: every test in
both packages exercises one module in isolation.

## The big one — the loop was running inside every subagent

`vendor/pi-loop-mode` keeps its whole state machine in module scope. A subagent
binds *the same module object* but gets its own `pi` and its own event bus, so
all **thirteen** of its handlers ran a second time per delegation against the
operator's one `LoopState`. The previous session's B4 fix guarded two of them.

Reproduced, with a loop running and a subagent doing something unrelated:

```
child before_agent_start → "<<CHILD PROMPT>>\n\nLoop mode is active.
   Goal: refactor the parser. … keep every response under 1,200 characters …
   never stop on your own"
child agent_end          → operator's iteration count 0 → 1, operator's pending
   timer cancelled, operator's next loop turn SENT INTO THE CHILD
child compaction         → replaced by the operator's loop handoff summary:
   "the conversation above was dropped … Do not try to recall it"
```

Per foreground verified delegation that fired **three** times — the child's run,
the judge's run (the judge is itself a subagent session), and a repair.

Two things worth carrying forward beyond the fix:

- **The anchor is load-bearing in a way nobody intended.** It was written as
  prevention against pi's summaries gradually eroding the brief. It turns out to
  have been the *sole survivor* of a total context substitution whenever a child
  compacted under an active loop. Do not let anyone retire it as redundant.
- **A subagent given the operator's goal and "never stop on your own" is a drift
  cause**, injected by the stack, into precisely the mechanism the verifier
  exists to detect drift in.

**Fixed by making the package inert in a spawn** — the factory returns early, so
no command, no tool, no handler — and by `subagent-denylist.ts` no longer handing
`pi-loop-mode` to a child at all, which also returns ~177 tokens/turn of `loop`
tool schema to the child's window.

## The pattern behind the two wrong conclusions

Both were fixes applied in a file whose value never reaches the code that reads
it. Worth remembering as a class:

- **Concurrency was 4, not 1.** `agent-manager.ts` reads
  `concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT`, and `ConfigStore` always
  supplies a `default` — from `config-io.ts`, which still said 4. So the `??`
  never fired, and every session ran four children against `PARALLEL_SLOTS=1`:
  the exact state the long measured comment argues against. The number now lives
  in one place.
- **`extensions: false` still did not reach the loader.** B5's fix reads
  `config.extensions`, and `getConfig()` routes any `hidden` agent through
  general-purpose. `__verifier` is hidden for an unrelated reason (11 chars of
  tool schema), so its `false` became `true` and the guard was unreachable code.
  It went unnoticed because `tools: false` is read from `getAgentConfig` directly
  and *did* work — the property everyone checked was not the property the fix was
  about.

**The lesson: when a fix is a predicate on a value, test the predicate, not the
value's neighbour.** One assertion on what the loader/manager actually decides
would have caught both. Both now have one.

## The rest

| Finding | Fix |
| --- | --- |
| Nothing could stop a verification — Esc, `StopAgent` and the watchdog all no-op once the status is terminal, while the parent's tool call is blocked on a gate only verification opens | per-call deadline, `SUBAGENT_VERIFY_TIMEOUT_MS` (default 300s), surfacing as the existing `errored` verdict |
| A steered continuation was judged against the *original* brief, so the repair actively undid the operator's instruction and called it `✎ repaired` | `appendFollowUp()`, bounded, original preserved |
| A stale `✓ checked` badge survived an unverified continuation | verdict cleared with the result |
| The verifier's own tokens were tallied nowhere; the repair ran without `onCompaction`, i.e. with the anchor off on the turn most likely to compact | `stats.verifyUsage` + tracking callbacks on the repair |
| An errored run was judged and its text then discarded unread by `executeAgentTool` | `error` added to the statuses not worth a judge |
| The spawn bracket covered the whole child run, so an operator `/reload` mid-background-agent stripped the parent's subagent tools and permanently mis-branded the loop instance | bracket narrowed to `reloadAndMap()` → `bindExtensions()` |
| The `loop` tool truncated any `--check` command containing a double quote, reporting it as a *failing goal check* | escape-pair aware pattern, `\"`/`\\` only |

## Deliberately not done: per-session loop state

The deep half of the loop problem — `state` keyed by session instead of by module
— is **~450 references across 1,846 lines** plus 18 helper signatures. A closure
around the whole file is the smallest logical change and an ~800-line reindent
that ends the ability to diff this fork against upstream 2.5.4; threading a
session handle preserves that but touches every reference.

There is **no live bug left** either way: the guard makes the package inert in a
child and it is no longer loaded there. What the refactor buys is a *feature* — a
bounded loop inside a subagent — which is what the extension list originally
wanted and which has never actually worked, because every version of it destroyed
the operator's loop.

So it is your call, not a task. If the feature is wanted, take the threading
shape with the isolation suite as the safety net. If it is not, delete the intent
from `subagent-denylist.ts`'s comment and the guard becomes permanent.

## Gates

```
vendor/pi-subagents-lite   lint 65/65 files   tests 100/100   (was 81)
vendor/pi-loop-mode        lint clean         tests  63/63    (was 52)
.pi/extensions/compaction-guard                tests  39/39    (unchanged)
```

Every guard added was **control-run with the fix disabled**: 8 of the 9 new
subagent-isolation assertions fail without it, and the `--check` test fails
against the old pattern. The one assertion that passes either way is the
pre-existing weak one, kept for continuity. A test that has not been watched
failing is not evidence — the standing example is the first audit's B3, a test
named *"survives an unknown action"* that passed **because** of the bug.

## Next session

1. **Run section I of `context/testing/subagents-loop-verifier.md`** on a quiet
   box. Still the one thing this work has never had: eyes on the real TUI. The
   claim to falsify is that the agent's row stays put, spinner running, while the
   judge works.
2. **Watch a delegation with a loop running.** That is the scenario this session
   fixed and only tested at the module level. Start `/loop`, delegate, and check
   that `/loop status` still shows the goal and the iteration count has not moved
   — and that the subagent's answer is about the subagent's task.
3. **Check the new accounting live.** `stats.verifyUsage` and the deadline have
   never been exercised against a real model; the deadline in particular is a
   behaviour change under load.
4. **Still open from before, unchanged:** the verifier's failure path (judge says
   no → repair) has never fired live and the judge's false-positive rate is
   unknown; the anchor needs a child that fills its own 32k window; the 40-turn
   ceiling and steer-then-abort ladder are untested live; a background subagent
   that settles after its Matrix run has retired answers into the void
   (`forwardToMatrix` returns early without a live `awaitingReply` entry); and
   finished widget rows still leave after `finishedRetentionMinutes` (default 1),
   so the keyboard hop cannot reach an agent that finished a few minutes ago —
   `/agents` can, all session.
5. **If the stall recurs:** `srv stop: cancel task` with no timing line means
   llama accepted the task and dropped it; correlate with `prompt state size …
   exceeds cache size limit 2048 MiB, skipping`, which appeared immediately
   before both cancels last session.

## Where to look

- `context/design/subagents-loop-verifier-evaluation.md` — the audit, the
  reproductions, §10 for what shipped and what did not.
- `context/design/subagents-loop-verifier-anatomy.md` — the design account, now
  with five inline corrections.
- `context/design/decisions.md`, the `## 2026-08-17 (second audit)` entry.
- `vendor/pi-subagents-lite/FORK.md` §2 (corrected), §5 (loop removed) and §11
  (the six new fixes); `vendor/pi-loop-mode/FORK.md`, the fourth-change section.
