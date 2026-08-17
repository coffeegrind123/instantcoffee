# pi-loop-mode — forge fork

Forked from [`pi-loop-mode@2.5.4`](https://www.npmjs.com/package/pi-loop-mode)
(Robert Ressl, AGPL-3.0-only — `LICENSE` is upstream's, unchanged). Vendored here
rather than installed from npm because the changes below are edits to the
package's own source: an npm install would be replaced by the next `pi update`,
and a patch applied on top of one would be silently lost with it.

`scripts/pi-local.sh` loads it by absolute path:

```
-e vendor/pi-loop-mode/extensions/index.ts
--skill vendor/pi-loop-mode/skills/loop-skill
--prompt-template vendor/pi-loop-mode/prompts
```

Nothing needs installing. The extension's only non-relative import is an
`import type` of pi's own types, which is erased before the file runs, so there
is no `node_modules` under `vendor/`.

**If the upstream npm package is still installed** (`pi list`), remove it —
`pi uninstall npm:pi-loop-mode`. pi dedupes extensions by path, so a second copy
at a different path registers a second `/loop` and the two fight over one
session's loop state. `pi-local.sh` warns when it sees one.

Upstream's `assets/`, `GALLERY.md` and `DOCUMENTATION_de.md` are not vendored;
everything the loop actually loads is.

## What was changed, and why

### The failure

An unattended `/loop` run on the 32k local model died like this:

```
Error: "Backend returned 400"
[compaction] Compacted from 33,719 tokens
Error: Compaction failed: Already compacted
Error: Emergency context compaction failed: Already compacted.
Loop paused — context recovery required
```

The context overflowed, **the recovery worked**, and the loop stopped anyway —
needing a human to type `/compact` and `/loop resume`, which is the one thing an
unattended loop cannot ask for.

The cause is a race with pi's own recovery, not a broken context. pi runs its
overflow handling in `_handlePostAgentRun()` — **after** the `agent_end`
extension event and **before** the run settles (`core/agent-session.js`:
`_runAgentPrompt` → `while (await this._handlePostAgentRun())` → `finally
_emitAgentSettled()`). Upstream compacts from `agent_end`, so both compactions
are in flight at once; pi's lands first, and `prepareCompaction()` refuses a
branch that already ends in a compaction entry:

```js
if (pathEntries[pathEntries.length - 1].type === "compaction") return undefined;
// → "Already compacted"
```

The loser of that race got that error, and upstream's `onError` treats any
compaction error as terminal.

### The fix

1. **Compaction is deferred from `agent_end` to `agent_settled`.** "Settled" is
   documented as no retry, compaction, or queued continuation left to run, so pi
   has had its turn and there is nothing left to race.
2. **`session_compact` adopts pi's recovery as the loop's own.** When pi says it
   will re-run the overflowed turn itself (`willRetry`), the loop does not send a
   turn on top of it — with a watchdog that resumes anyway if that retry never
   materializes, since an unattended loop must not hang on another component's
   promise.
3. **`Already compacted` / `Nothing to compact` are no longer failures.** They
   mean the context is already as small as this session can make it. The loop
   continues instead of pausing.
4. **The branch is read before a compaction is requested**, so the loop does not
   ask pi for something its own guard will refuse.
5. **The circuit breaker cools down instead of stopping.** Three failed
   recoveries now wait out an escalating cooldown (60s, 120s, 240s) and retry;
   only a run that spends the whole ladder without one successful turn pauses for
   a human. Each escalation also builds a **tighter emergency summary** (24k →
   8k → 3k chars, dropping durable-file excerpts at the tightest level), because
   a recovery that did not free enough room will not free more by repeating the
   same summary.
6. **Overflow compactions are built locally, not by the model.** pi summarizes
   with the LLM; after an overflow that is the same LLM that just refused this
   context, so it is the request least likely to succeed exactly when it is
   needed. Routine threshold compactions still get pi's better model summary —
   they have room to spare.
7. **A named context overflow counts as context pressure whatever the local
   token estimate says.** That estimate is `null` right after a compaction and 0
   before the first usage report, and a real overflow routed to the generic
   backoff path retries forever against a context that can never fit.

`/loop status` gained a `Context recoveries:` line (recoveries, current cooldown,
current summary level), and `.pi-loop-log.jsonl` gained the `context_pressure`,
`context_recovered` and `context_cooldown` events.

Files touched: `extensions/index.ts`, `src/context-recovery.ts`,
`src/loop-state.ts` (three new persisted counters; `restoreLoopState()` merges
over defaults, so older session state loads unchanged).

## The second failure: the loop never overflowed again, and still went nowhere

The fix above kept the loop alive through an overflow. It did not stop the loop
reaching one. Eight real sessions under `~/.pi/agent/sessions` say what happened
next — the largest is 24 compactions long and never errors once:

```
i    kind          ctxTok  sumChars   next assistant turn
 48  COMPACTION     28816      1666  ->  21204
102  COMPACTION     29252      3183  ->  30530   (went UP)
135  COMPACTION     29643      5891  ->  31081   (went UP)
157  COMPACTION     30286      9411  ->  30612
172  COMPACTION     31274     11054  ->  31164
```

The first compaction lands at **88% of a 32,768-token window**, and from the
fourth onward the session is pinned at **94–96% full permanently**, compacting on
nearly every iteration and freeing nothing. Three separate defects in pi's
defaults produce that, all verified against `dist/core/compaction/compaction.js`
by driving it directly:

- `shouldCompact()` turns true at 50% of the window (`contextWindow -
  reserveTokens`), but `prepareCompaction()` returns `undefined` while the whole
  context is smaller than `keepRecentTokens` (20,000). Between 50% and ~66% pi
  therefore decides to compact on every turn and **silently does nothing** — it
  returns before `compaction_start` is emitted, so there is no log, no error and
  no UI for it.
- When a compaction does fire it keeps `keepRecentTokens` — 61% of this window —
  so the floor after a compaction is *higher* than the point at which the model
  stops working.
- `reserveTokens` doubles as the summarizer's own `maxTokens`
  (`min(0.8 * reserve, model.maxTokens)` = 8,192 here), and each summary is
  merged into the previous one. Hence 1,666 → 11,054 chars: the summary grows
  until it is the thing filling the window.

And the reason "94% full" matters at all, from the same sessions:

| context | empty assistant turns | turns with output |
|---|---|---|
| below 87% of the window | 3 | 193 |
| at or above 87% | 33 | 30 |

Above the cliff a turn is a coin flip — `content: []`, `stopReason: "stop"`, one
output token — and an empty turn still burns an iteration. Worse, the loop's own
guards misread it. Entries 118–138 of that session:

```
121,124,127  assistant out=1, content: []
128          loop: "no tool usage for 3 turns (narration only)"
129          loop: "Stuck intervention. You are repeating yourself…"   (+800 chars)
130,133      assistant out=1, content: []
132          loop: "No concrete changes for 8 iterations…"             (+600 chars)
135          COMPACTION
138          assistant out=884, tool calls, real work
```

The model was not repeating itself; it had no room. Every rung of the stuck
ladder works by adding prompt text, so the ladder was force-feeding the thing
that caused the problem. The compaction at 135 is what fixed it.

### The fix

8. **Handoff instead of compaction, on any window ≤ 64k.** A threshold or manual
   compaction on a small window returns a locally-built summary bounded at 4,000
   chars (~1k tokens, and the *same* size on iteration 400 as on iteration 4),
   plus its own cut point: `findHandoffCutEntryId()` cuts at the start of the
   last turn rather than at pi's 20,000-token tail. If that final turn is itself
   oversized — the runaway tool result is usually what filled the context — it
   keeps a single message instead of carrying the flood into the next context.
   Costs no model call. Falls back to pi's own cut point when there is nothing
   safe to cut at, and to pi's model-written summary on a roomy window, where it
   is better and there is room to pay for it.

   Run against the first six real compaction points of the session above —
   context-visible content only, since `custom` state entries never reach the
   model:

   | compaction | pi kept | handoff keeps |
   | --- | --- | --- |
   | @48 | 68,778 chars | 374 chars (single message: the final turn was oversized) |
   | @102 | 123,083 chars | 1,560 chars |
   | @109 | 110,155 chars | 5,853 chars |
   | @135 | 121,320 chars | 1,707 chars |
   | @143 | 113,246 chars | 6,133 chars |
   | @150 | 102,697 chars | 2,754 chars |

9. **An empty turn on a saturated context is context pressure, not fixation.**
   `isContextPressure()` gained a `starvedTurn` clause: `stopReason: "stop"` with
   no text, no thinking and no tool call, at ≥80% full. It routes to the existing
   recovery machinery instead of to the stuck ladder.
10. **The stuck ladder skips its prompt rungs when the context is full.** Above
    80% it goes straight to compaction — no rescue-model switch, no strategy
    injection, no waiting for the fifth consecutive intervention.
11. **The model is shown its own context budget.** Above 60% full, the `context`
    handler appends one ephemeral line (`[context budget] 11.8k of 32.8k tokens
    left (64% used)…`) telling it to finish the unit of work and write state to
    `PROGRESS.md`; above 80% the same line forbids large reads outright. It is
    aimed *below* the cliff on purpose — a warning delivered at 90% arrives in
    the regime where the model most often says nothing at all. pi clones the
    message array before this event (`emitContext()` → `structuredClone`), so it
    never reaches the session, and appending it last leaves the cached prefix
    intact so llama.cpp re-prefills only the notice (~40 tokens/turn).

`/loop status` gained a `Context:` line, the status bar gained `ctx NN%`, and
`.pi-loop-log.jsonl` gained the `context_handoff` event. `logIteration("compact")`
now records whether the compaction was forced by saturation.

Files touched: `extensions/index.ts`, `src/context-recovery.ts`, and a new
`src/context-budget.ts`. No new persisted state.

### The other half of the fix is not in this package

`scripts/pi-local.sh` now sizes pi's compaction settings from `CTX_SIZE` when it
writes `~/.pi/agent/models.json`, for the same reason it generates that file:
so the numbers cannot drift from the window the stack is actually serving.

```
reserveTokens    = min(16384, CTX_SIZE // 2)        # trigger at 50% of the window
keepRecentTokens = max(2000, min(20000, CTX * 0.2)) # cut back to ~20% of it
```

On 32,768 that is 16,384 / 6,554. Measured against pi's real
`prepareCompaction()`, it removes the silent no-op window entirely and drops the
post-compaction floor from 20,000 tokens to 7,000. It is written to pi's *global*
settings, not to a `.pi/settings.json` here, because the loop runs in whatever
project you point it at — and project settings are trust-gated besides.

## The third change: the model can start and stop a loop itself

Upstream exposes loop control only as `/loop`. A model cannot type a slash
command — it can only call tools — so upstream's loop is something a human
starts and a human stops. On this stack that is the wrong shape twice over: the
model is the one that knows it has a goal and a way to check it, and a subagent
running a bounded loop in its own window is the best version of delegation when
there is one llama slot and no parallelism to win.

So the command body was lifted into `loopCommand(args, ctx, opts)` and a `loop`
tool now drives the same code path. The command is unchanged and still there;
this is an addition, and `tests/loop-tool.test.ts` asserts both are registered.

Three things this needed that are not obvious:

- **The tool has to hand back what the command only showed the operator.**
  Everything `/loop` reports goes through `ctx.ui.notify`, which the model never
  sees. The notices are captured on the way past and returned as the tool
  result. A `Proxy` rather than a spread: the context is a live object whose
  methods expect their own `this`, and a shallow copy loses them.
- **`stop` must not abort the turn that called it.** The command aborts the
  in-flight turn to drop queued loop follow-ups. Called from a tool, the
  in-flight turn *is* the one executing the tool — aborting it throws away the
  tool's own result and leaves the model unable to tell whether the stop took.
  `suppressAbort` skips it on the tool path only; the state change and the
  `runToken` bump are what actually stop the loop.
- **Registration is guarded.** `if (typeof pi.registerTool === "function")`.
  Found the hard way: the existing suite's fake `pi` implements
  `registerCommand` and not `registerTool`, so an unguarded call threw during
  the factory and cancelled all 39 tests. A host without tool registration now
  keeps the command instead of losing the extension.

The schema is written as literal JSON Schema rather than built with typebox,
because typebox is a **runtime** import and this package deliberately has none —
that property is what keeps `vendor/` free of `node_modules` and lets `tests/`
load the extension under plain node. Adding the import broke the suite
immediately with `ERR_MODULE_NOT_FOUND`; the object pi puts on the wire is the
same either way.

**What it costs:** 709 chars, ~177 tokens on every turn, measured off the wire
against a stub model. It was 912 before trimming the descriptions to the parts
that change behaviour — what it does, that `start` needs a finish line, and when
not to reach for it.

**One thing the tool broke on the way through, fixed later** (evaluation F10).
The tool builds a `/loop` argument string and hands it to the same parser the
slash command uses, quoting the check command with `JSON.stringify`. The parser's
`--check "([^"]*)"` stopped at the first backslash-quote, so
`grep -q "all tests passed" out.log` was configured as `grep \` — a command that
runs, fails, and is reported as a *failing goal check* rather than as a broken
configuration. The pattern now consumes escape pairs
(`"((?:[^"\\]|\\.)*)"`) and unescapes only `\"` and `\\`, so a Windows path in a
check command (`C:\bin\test.exe`, where `\b` is not an escape) still means what
it says. `action`'s description also gained `stats`, which `TOOL_ACTIONS` had
always accepted.

## The fourth change: a subagent's session must not be able to kill the loop

Found by auditing the whole subagent path (`context/design/subagents-loop-verifier-anatomy.md`
§9, B3 and B4). Two defects, both from this package meeting subagents:

**A subagent spawn silently killed a running loop.** `pi-subagents-lite` runs its
children *in this process*, a child session binds this extension, and node's
module cache means the child's copy is the **same module** — the `state`,
`pendingTimer` and `runToken` at the top of `extensions/index.ts` are shared with
the operator's session. pi's `bindExtensions()` ends by emitting `session_start`
(`core/agent-session.js:1761`), so every spawn ran, against the operator's live
loop: `clearPendingTimer()` (cancelling the next iteration, already scheduled),
`resetContextRecovery()`, and `restoreState(ctx)` — replacing the loop with the
child's in-memory branch, which is empty. The symptom is not an error: the loop
stops advancing the first time the model delegates anything, and `/loop status`
reports no loop at all. The verifier doubles it, because the judge is itself a
subagent session.

`pi-subagents-lite` now publishes its spawn depth on
`globalThis.__PI_SUBAGENT_SPAWN_DEPTH__`; this package reads it at factory time.
A global rather than an import, because vendored packages must not depend on each
other.

**That first fix guarded two handlers out of thirteen, and the other eleven were
worse.** Found by a second audit
(`context/design/subagents-loop-verifier-evaluation.md`, F1), and every item below
was reproduced against the real module before it was fixed. With the operator's
loop running and a subagent doing something unrelated:

| Handler | What it did to the child, or to the operator |
| --- | --- |
| `before_agent_start` | appended `Loop mode is active. Goal: <the operator's goal> … keep every response under 1,200 characters … never stop on your own` to the **child's** system prompt. Every clause is wrong for a subagent, and it is injected into exactly the mechanism the answer verifier exists to detect drift in. |
| `agent_end` | ran the whole iteration ladder on the operator's state with the child's ctx — cancelled the operator's scheduled iteration, incremented its iteration count, persisted its state into the child's throwaway in-memory branch, and **delivered the operator's next loop turn into the child**. `agent-session.js:779` continues a session for messages queued by an `agent_end` handler, so the child then worked on the operator's goal until its 40-turn ceiling. |
| `session_before_compact` | replaced the child's compaction with a handoff built from the operator's loop state: on a 32k window `windowNeedsHandoff` is always true, so a child that compacted lost its entire conversation and was told *"the conversation above was dropped … perform exactly one concrete next progress batch"*. |
| `session_compact` | consumed the operator's pending context-recovery marker, and reset its compression level. |
| `agent_settled` | could finalize the operator's soft stop, or run its emergency compaction against the child's context. |
| `before_provider_request` | applied the operator's anti-repetition sampling penalties to the child's requests. |
| `message_end` / `tool_result` | fed the child's assistant text and tool results into the operator's repetition fingerprints and tool counters — the entire input to `detectStuck()`. |
| `message_update` | the child's degenerate-repetition abort set the shared `degenerateAbortPending`, which the operator's next `agent_end` consumed as its own. |
| goal check | with `--check` configured, ran the operator's shell command once per child turn. |

Per foreground verified delegation that fired **three** times — the child's run,
the judge's run, and a repair — because the judge is itself a subagent session.

**The fix is the whole factory: an instance born inside a spawn registers
nothing.** Not the command, not the tool, not one handler. A per-handler guard
would have stopped the damage without making a child loop work, because
`runLoop()` writes the same shared state — so the honest narrow fix is to be
inert, and `pi-subagents-lite` correspondingly no longer hands this package to a
subagent at all (`subagent-denylist.ts`), which also saves the child ~177
tokens/turn of `loop` tool schema.

**The underlying exposure is still not gone**, and this is the one thing left
open: `state` is module-global, so nothing but the guard separates two sessions.
Per-session state would re-enable a loop inside a subagent, which is what the
extension list wanted in the first place. It is ~450 references across 1,846
lines and 18 helper signatures, and it is deliberately not done here: it enables
a feature that has never actually worked, and either shape of it (a closure
around the whole file, or threading `pi` into every helper) costs the ability to
diff this fork against upstream 2.5.4. Both changes revert together when someone
decides that trade is worth making.

**An unknown tool action started an endless loop.** `loopCommand`'s last branch
is the `/loop <goal>` convenience — anything unrecognised becomes a goal. Right
for a person, a trap for a model guessing a verb: `loop(action: "pause")` started
an endless loop whose goal was the word "pause". The tool now checks a closed
action set first. The existing test *"survives an unknown action"* asserted only
that a string came back, so it had been passing **because** of the bug; it now
asserts nothing was started.

## Tests

```
cd vendor/pi-loop-mode && node --experimental-strip-types --test tests/*.test.ts
```

63 tests — 39 for the two failures above, 14 for the loop tool and its argument
round-trip, 10 for subagent isolation. The isolation suite loads the extension
twice, exactly as the process does, and was **control-run with the guard
disabled**: 8 of its 9 new assertions fail without the fix, so it is testing the
guard and not the weather. The `--check` round-trip test was control-run the same
way against the old `"([^"]*)"` pattern. They drive the extension's real handlers through both failures above —
pi winning the compaction race, the retry promise, an unrecoverable context, the
full cooldown ladder, an empty turn at 92% versus the same turn at 30%, a stuck
verdict on a saturated context versus one with room to spare, and the budget
notice appearing only above its threshold — rather than asserting against a
description of them.
