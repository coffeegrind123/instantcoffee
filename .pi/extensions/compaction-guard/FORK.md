# compaction-guard — what it is, and what it has become

Not a fork of anything: written for this stack, from the half of
`vendor/pi-loop-mode`'s context work that turned out not to be loop-specific.
This file exists because the twenty-first pass's handoff recorded its absence —
*"`.pi/extensions/compaction-guard/`, `browser-guard.ts` and `stack.ts` still
have no FORK.md"* — and because the twenty-second pass gave this extension a
fourth job whose reasoning does not fit in a code comment.

## What it does, and why each part is here

Four jobs. The first three were measured over **42 real compaction points and
259 assistant turns** under `~/.pi/agent/sessions`; the fourth is AM2.

```
   1  BOUND THE CARRIED-OVER SUMMARY      session_before_compact
      pi merges each summary into the last under a "PRESERVE all existing
      information" prompt, so it grows monotonically: 456 → 4,029 → 11,054 chars
      within one session. Sizing `keepRecentTokens` does nothing about it — this
      is the one defect the global settings fix leaves standing.

   2  SHOW THE MODEL ITS BUDGET           context
      Above 87% of the window, 52% of turns come back empty against 1.5% below
      it. The notice is appended LAST, so the cached prefix is untouched and
      llama.cpp re-prefills only the notice.

   3  CAP ONE TOOL RESULT                 tool_result
      Telling it does not stop it. On 2026-08-17 the CRITICAL notice was in
      context at 84.5% — "do not run commands with large output this turn" — and
      the model ran a curl loop that returned 17,790 characters, taking the
      window to 100% and the run to an empty turn. A single tool result is now
      bounded to a share of what context is LEFT, spill file and all. AF6 removed
      the `isError` exemption, which covered up to 50 KB on the most common path
      an unattended `/loop` has: a test suite that is still red.

   4  SAY WHEN pi IS COMPACTING           session_before_compact  ← AM2, and see
                                          session_compact         below
                                          agent_start
                                          agent_settled
                                          session_shutdown
```

What is deliberately NOT ported from the loop: its **handoff**, which replaces
pi's model summary with a locally-built one and cuts to the last turn. That is
right for a loop, where the conversation is not the state; in an ordinary session
the conversation IS the state, and building that summary from an inactive
`LoopState` yields *"No saved loop goal / Iteration: 0"* — 792 characters of form
in place of what the user asked for.

## Failure mode by construction

Jobs 1–3 only ever ADD a bounded line or SHRINK a string pi was about to send to
the summariser. `session_before_compact` returns `undefined`, so pi keeps
ownership of the compaction and this extension can never replace, cancel or
truncate one. Every handler swallows its own errors: pi reports a throwing
handler to the user as an extension error, and a guard is not worth a visible
error.

Job 4 is the same shape: `beginCompaction` is re-entrant for the same owner and
refuses when somebody else holds the lock, `endCompaction` only releases its own,
and both calls are wrapped so a lock that cannot be taken leaves the stack
exactly as it was before this pass.

## The load order matters, and it is set by a shell script

`ExtensionRunner.emit` iterates extensions in registration order, and
`DefaultResourceLoader` puts `-e` paths first (`mergePaths(cliEnabled,
discovered)`, `resource-loader.js:651`). `scripts/pi-local.sh` therefore fixes it:

```
   1 stack   2 browser-guard   3 loop   4 compaction-guard
   5 subagents   6 prinny   7 rtk
```

Three of this extension's four jobs depend on running **after** `pi-loop-mode`:

- **`context`** — both can append a budget line; whichever runs second stands
  down, and the loop's loop-flavoured line is the better one when a loop is
  running. (Both sides check, so a different order costs a duplicate line, not a
  bug.)
- **`session_before_compact`** — `emit` is last-truthy-wins for the
  `session_before_*` events, and the loop may return a `{compaction}` handoff.
  This extension always returns `undefined`, so it can never override one. If
  that ever changes, the order stops being a preference and becomes a
  requirement.
- **`tool_result`** — `emitToolResult` THREADS the content through handlers in
  order, so the loop fingerprints the RAW text and the cap applies afterwards.
  `pi-loop-mode`'s `stripShorteningMarkers` is the defence for the other order
  and is dormant at this one; it is kept because a discovery-only session (no
  `-e` flags) orders these differently.

## It is NOT inert in a subagent's session — except for the lock

`.pi/extensions/**` is on a child's discovery route, so a subagent binds this
extension. That is deliberate and is one of the things it is for: a child's own
`read` and `bash` results are capped by the same handler, in the child's own
window. `vendor/pi-loop-mode` and `.pi/extensions/stack.ts` both return early
from their factories when `__PI_SUBAGENT_SPAWN_DEPTH__ > 0`; this one must not.

The compaction lock is the one exception, and the reason is that it is a
**process-global answering a per-session question**. A subagent's session
compacts — `AgentRecord.stats.compactionCount` counts it and the task anchor
fires on it — and a child's compaction must not hold back the PARENT's loop turns
and delegation results. So the take, and only the take, is gated on the
factory-time answer to `bornInsideSubagentSpawn()`.

One consequence, stated rather than guarded: an operator `/reload` that lands
inside a child's session BUILD would make the parent's own instance read as a
child's and never take the lock again for that session. That is a return to the
behaviour of every pass before AM2, not a new failure.

## AM2 — why this extension is the one that takes the lock for pi

Three senders in this stack ask *"is somebody compacting this session right
now?"* before they start a turn:

```
   pi-subagents-lite  SpawnCoordinator.emitIndividualNudge      AH1, 17th pass
   pi-loop-mode       sendLoopTurn                              AG2, 16th pass
   prinny-channel     the empty-turn continuation               AG3, 16th pass
```

All three could only ever see the two EXTENSIONS that compact. The third
compactor is pi, and it compacts more than both of them together. The handoff
carried it as open for seven passes on a sentence about `compaction_start`, which
is the wrong event: `session_before_compact` IS an `ExtensionEvent`, and pi emits
it from `compact()` (`agent-session.js:1389`) and `_runAutoCompaction()`
(`:1613`), for every reason, whenever any extension has a handler for it.

This extension is the one that takes it because it is the only one loaded in
**every** session regardless of what else is enabled, and because compaction is
the whole of what it is for.

The owner name is `"pi"` — the host's, not this extension's. Every reader prints
`${holder.owner} is compacting`, and "compaction-guard is compacting" would name
the wrong actor to an operator reading a notice.

**Four release rungs, not one.** `session_compact` fires only on the SUCCESS
path; a compaction the operator cancelled with Esc (`interactive-mode.js:2703` →
`session.abortCompaction()`) or one whose summariser failed emits nothing to
extensions at all. Left at that, the hold would run to `STALE_MS` — five minutes
of an unattended loop deferring every turn because one compaction was cancelled,
which is worse than the collision the lock prevents. `agent_start` and
`agent_settled` are both strictly after any compaction pi can run; the post-run
one completes inside `_runAgentPrompt`'s `while` before `_emitAgentSettled`, and
the pre-prompt one before `agent.prompt()` emits `agent_start`.
`session_shutdown` is there because the lock is process-global and the session is
not.

## The couplings, so a change here does not surprise somebody else

```
   vendor/pi-subagents-lite/src/spawn/result-cap.ts
     imports allowanceChars + planOutputCap + createSpillWriter from src/.
     A background subagent's result never passes through `tool_result` —
     `sendCustomMessage` emits no such event — so it caps itself, with THESE
     numbers and THIS spill writer rather than a second copy of either.

   vendor/pi-loop-mode/src/context-budget.ts
     the other half of the `-context-budget` customType handshake.

   vendor/pi-loop-mode/tests/compaction-lock.test.ts
     imports all FOUR copies of the lock protocol and asserts they agree on the
     key, the bound and the distinctness of the owner names.
```

## The tests

**75.** `npm test` in this directory; `npm run lint` is `node --check`.

```
   context-notice · output-cap · error-output · spill-bound · spill-dirs ·
   summary-budget · pi-compaction-lock
```

`tests/spill-dirs.test.ts` carries a warning in its own header that is worth
repeating: the first draft of it computed a cleanup path with
`file.split(PREFIX)[0]`, got `/tmp`, and handed it to a recursive `rmSync` in
`after()`. **It deleted `/tmp`.** A teardown that takes a path from a computation
has to prove the path is its own — under `tmpdir()`, one segment, with a known
prefix — immediately above the destructive call, not merely where the path was
queued.
