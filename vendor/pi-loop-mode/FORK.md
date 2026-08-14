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

## Tests

```
cd vendor/pi-loop-mode && node --experimental-strip-types --test tests/*.test.ts
```

23 tests. They drive the extension's real handlers through the failure above —
including pi winning the race, the retry promise, an unrecoverable context, and
the full cooldown ladder — rather than asserting against a description of it.
