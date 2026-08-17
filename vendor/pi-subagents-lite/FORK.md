# pi-subagents-lite — forge fork

Forked from [`pi-subagents-lite@1.11.0`](https://www.npmjs.com/package/pi-subagents-lite)
(AlexParamonov, MIT — `LICENSE` is upstream's, unchanged), taken from the
published npm tarball rather than git HEAD so the pin means something.

`scripts/pi-local.sh` loads it by absolute path:

```
-e vendor/pi-subagents-lite/src/index.ts
```

Nothing needs installing, and there is no `node_modules` under `vendor/` — see
"The typebox import" below for the one dependency that made that a real
question rather than an assumption.

**On by default** (`SUBAGENTS_ENABLED=1` in `.env`). A registered tool costs its
schema on every turn whether or not the model ever calls it, so the charge is
real — but it is measured below rather than estimated, and at ~178 tokens for
all three tools it is small enough to carry standing.

**If the upstream npm package is ever installed** (`pi list`), remove it —
`pi uninstall npm:pi-subagents-lite`. pi dedupes extensions by path, so a second
copy at a different path registers a second `Agent` tool and doubles the schema
cost this fork exists to keep small.

Upstream's `test/` is not in the published tarball and is not vendored;
`tests/` here is this fork's own.

## Why this package, out of 341

`pi.dev/packages?name=subagent` returns 341 matches. The popular ones —
`pi-subagents` (244,797/mo, 3,182★) and `subagent-isolation` among them — run
each subagent as a child `pi --mode json -p` **process**. That is the wrong shape
for this stack, and specifically:

- llama.cpp runs here with `PARALLEL_SLOTS=1`. A child process buys no
  parallelism; it queues at the server.
- A child process carries its own system prompt and tool catalog, and a child
  that does real work displaces the parent's cached prefix — see "The prefix
  cache" below for what that costs, measured.

This package runs subagents **in process**, through pi's own
`createAgentSession` (`src/agents/agent-runner.ts:531`). The win that survives on
one slot is not wall-clock, it is context isolation: the child burns its own
window on the search and the parent gets back a bounded summary.

Three other things decided it over `@tintinweb/pi-subagents` (40,433/mo, 895★),
which is also in-process and was the other finalist:

- **The tool surface is already at the floor.** Upstream deletes the tool
  `description` outright (`// @ts-expect-error — description removed to save
  prompt tokens`) and lets `Agent`, `run_in_background` and `worktree_path` carry
  the meaning. tintinweb's *compact* description alone is 778 chars — larger than
  this package's entire three-tool schema.
- **Per-provider concurrency with a real queue** (`src/agents/agent-manager.ts`),
  whose own doc comment uses a local llama provider as the example.
- **Model precedence** — session override → agent frontmatter → config → parent
  model — which answers "a small fast model for search, the 27B for synthesis"
  in configuration rather than in code.

## What it costs, measured

Taken off the wire against the stub model in
`vendor/prinny-channel/tests/fixtures/stub-model.mjs`, the same way
`vendor/prinny-channel/tests/tool-budget.test.ts` measures prinny — the source
cannot tell you what pi decided to send, so it is not asked.

```
baseline (no extension)          2,900 chars   read 699 · bash 557 · edit 1,194 · write 445
with vendor/pi-subagents-lite    3,610 chars   + Agent 357 · StopAgent 193 · AgentStatus 157
delta                              710 chars   ~178 tokens, every turn
```

For scale: that is 0.54% of a 32k window, against the ~1,470 tokens the six
`prinny_*` tools cost before they were folded into one. The `Agent` tool as the
model actually receives it:

```json
{"type":"function","function":{"name":"Agent","parameters":{"type":"object",
 "required":["prompt"],"properties":{"prompt":{"type":"string"},
 "description":{"type":"string"},"agent":{"type":"string",
 "description":"general-purpose,Explore"},"run_in_background":{"type":"boolean"},
 "worktree_path":{"type":"string"}},"additionalProperties":false},"strict":false}}
```

No prose at all. Whether a 27B local model uses a tool this bare correctly is
**not** settled by this measurement — see "Not verified" at the end.

## What was changed, and why

### 1. The typebox import — without this it does not load at all

`src/registration.ts:1`. Upstream imports `@sinclair/typebox`, which is not
present anywhere in this pi install. pi 0.84.2 bundles **`typebox` 1.3.7**, the
successor package, and resolves the bare specifier for extensions;
`vendor/prinny-channel` imports it the same way. Checked rather than assumed:
`Type` and `TSchema` are both exported from the 1.x root, and
`Type.Object({...}, {additionalProperties:false})` emits byte-identical JSON
Schema under both. Upstream's `dependencies` entry for `@sinclair/typebox` was
dropped with the import, which is what keeps `vendor/` free of `node_modules`.

### 2. Default concurrency 4 → 1

`src/config/config-io.ts` (`DEFAULT_CONCURRENCY`), with the reasoning in
`src/agents/agent-manager.ts`. With `PARALLEL_SLOTS=1` the queue forms either
way; the only question is where. Serialising here means at most one foreign
prefix competes with the parent's at a time, and one child holding context
instead of four. Per-provider overrides still work
(`concurrency.providers.forge`), so raising it alongside `PARALLEL_SLOTS` needs
no code change.

**This was changed in the wrong file first, and did nothing for a release**
(evaluation F3). `agent-manager.ts` reads
`concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT`, and the config store always
supplies a `default` — so the manager's constant was unreachable, and every
session ran at 4 while both this document and the code comment said 1. Measured
through the real wiring (`ConfigStore` → `AgentManager`): `{ limit: 4 }`. The
number now lives only in `config-io.ts` and the manager reads it from there, so
there is nothing left to diverge.

### 3. A background subagent's result is bounded before it is injected

`src/spawn/result-cap.ts` (new) and its call site in
`src/spawn/spawn-coordinator.ts`. This is the substantive one.

A **foreground** subagent returns through the `Agent` tool, so its result is a
tool result, and `.pi/extensions/compaction-guard` already bounds it: that
extension hooks `pi.on("tool_result")` and keys off `toolName` rather than a list
of pi's builtin tools, so an extension-registered tool is covered for free.

A **background** subagent does not take that path. It is delivered with
`pi.sendMessage({customType: "subagent-result", ...}, {triggerTurn: true})`, and
pi's `sendCustomMessage` (`dist/core/agent-session.js:1068`, read rather than
guessed) builds a `role: "custom"` message and hands it straight to
`agent.steer()` / `agent.followUp()` / `_runAgentPrompt()`. That path emits no
`input` event, no `tool_result`, and on the triggerTurn branches no
`message_start`/`message_end` either. **There is no generic hook an extension
could have used**, which is why the bound lives in the fork instead of in the
guard where the rest of them are.

Uncapped, this is exactly the failure the guard was written for: on 2026-08-17 a
17,790-char payload arriving at 84.5% of a 32k window took the context to 100%
and the model produced nothing. A subagent that searched a large tree produces
payloads that size, and this one triggers a turn on arrival.

The cap **imports** the guard's `allowanceChars` / `planOutputCap` rather than
restating them: `REMAINING_FRACTION = 0.1`, the 1,500-char floor and the 20,000
ceiling were chosen against that failure — a fifth of the remainder would have
landed the run at 88.5%, above the 87% cliff, and a tenth lands it at 86.8%,
below it — and `compaction-guard/tests/output-cap.test.ts` pins that end state. A
second copy of those constants here would drift away from the test that
justifies them.

**The coupling this creates:** `vendor/pi-subagents-lite` imports
`.pi/extensions/compaction-guard/src/output-cap.ts` by relative path. If the
guard is missing the import cannot resolve and the extension fails to load, so
`scripts/pi-local.sh` checks for the guard and leaves subagents out with a
stated reason rather than letting that happen mid-launch.

The path is `../../../../.pi/extensions/…`, four levels up from a vendored
package, so **the two directories move together**: relocating `vendor/`, or
installing this package with `pi install`, breaks it at load with a
module-resolution error rather than degrading. The launcher's check covers the
launcher's path and nothing else. Left as-is deliberately: the alternative is a
second copy of constants that were measured against a test living in the other
directory, and a copy drifting away from its justification is the worse failure.

`tests/result-cap.test.ts` covers it, including the two paths that matter more
than the arithmetic: a finished agent is still delivered when the context cannot
be read or the bounding throws.

### 4. `"type": "module"` and a lint that works

`package.json`. Upstream ships no `"type"` field, which is harmless under pi's
own loader but leaves plain-node tooling guessing. The house lint
(`node --check` over every `.ts`) still does not work on this package, and the
reason is in the header of `tests/lint.mjs`: `--check` picks CommonJS-or-ESM by
scanning for a top-level `import`/`export` and only strips TypeScript on the ESM
path, so two files that open with a bare `function` or `interface` are parsed as
CommonJS and fail on their own type annotations. `tests/lint.mjs` strips the
types with node's own `stripTypeScriptTypes` (in `transform` mode — five files
use constructor parameter properties) and checks the JavaScript that comes out.
55/55 files, no exclusions, and a deliberately broken file was used to confirm it
can still fail.

Upstream's `prettier`/`vitest`/`tsc` scripts and devDependencies went with it —
none of those are installed here, and a script that cannot run is worse than no
script.

### 5. What a subagent may and may not load

`src/agents/subagent-denylist.ts` (new), wired into the child's resource loader.

**A child does not inherit the parent's `-e` flags.** It builds its own
`DefaultResourceLoader` and *discovers* extensions, so everything under
`.pi/extensions/` reaches it and everything this stack loads by absolute path
from `vendor/` does not. Measured: a subagent asked to inventory itself reported

```
TOOLS:  read bash edit write stack_status mcpScript mcp browser_×5
SKILLS: mcp-scripting
```

— no `prinny`, no `loop`, no `Agent` (so no recursive subagents), and a second
probe confirmed `rtk` was absent by running `git status --short` unrewritten.

Two consequences, pulling in opposite directions:

- **prinny must never be there**, and a layout accident is not a guarantee.
  Someone moves the channel under `.pi/extensions/` and a subagent — which the
  model spawns on its own initiative, with a prompt the operator never sees —
  can post to a Matrix room. The denial is unconditional and runs after the
  agent's own filter, so no agent `.md` can widen it back. The `prinny-access`
  and `prinny-configure` skills go with it, through `skillsOverride`, a loader
  hook upstream was not using.

  It has to key on **path**. `extractExtensionName()` reduces
  `vendor/prinny-channel/extensions/index.ts` to `index` — the same name loop
  and rtk get — and `resolvePackageShortName()` only returns a name when
  `pi.extensions` lists the entry *file*, while prinny's lists the directory. So
  `excludeExtensions: ["prinny"]` matches nothing and `["index"]` removes all
  three. The test suite pins that as a control.

- **rtk should be there**, and is put back by default through
  `additionalExtensionPaths`, because a child running `bash` uncompressed is
  the session that can least afford it — its whole value is coming back small.
  It has no module-level state, so a second instance in a child is genuinely
  independent. `SUBAGENT_EXTRA_EXTENSIONS` replaces the list; denied paths are
  filtered out of it too, so it cannot be used to smuggle the channel back in.

- **loop was there too, and was removed.** The intent was right — a bounded,
  goal-shaped loop grinding in a window that is not the operator's is the best
  version of delegation on one slot — but `vendor/pi-loop-mode` keeps its entire
  loop in module scope, and a child binds *the same module* with its own event
  bus. All thirteen of its handlers therefore ran a second time per delegation
  against the operator's single `LoopState`. Measured, with a loop running:

  ```
  child before_agent_start → "<<CHILD PROMPT>>\n\nLoop mode is active.
     Goal: refactor the parser. … keep every response under 1,200 characters …
     never stop on your own"
  child agent_end          → operator's iteration count 0 → 1, operator's next
     loop turn sent into the CHILD's session, operator's pending timer cancelled
  child compaction         → replaced by the operator's loop handoff summary:
     "the conversation above was dropped … Do not try to recall it"
  ```

  See that package's FORK.md for the full table. It goes back when its state is
  keyed by session; until then its own factory guard makes it inert in a child,
  so naming it in `SUBAGENT_EXTRA_EXTENSIONS` is safe and simply does nothing.
  Removing it also gives the child back ~177 tokens/turn of `loop` tool schema,
  in the window that can least afford it.

### 6. A subagent always has a turn ceiling

`DEFAULT_MAX_TURNS = 40` in `agent-runner.ts`. Upstream leaves `maxTurns`
undefined unless an agent file sets it, and undefined means unbounded — fine
when a subagent is a short search, not fine now that a child can loop.
`AgentSession.prompt()` defaults `expandPromptTemplates` to **true** and this
fork calls it bare, so a child handed `/loop …` starts a real one; an unbounded
loop on a one-slot server is not a runaway subagent, it is a stopped machine,
because the parent's next turn queues behind it forever.

Upstream's ladder does the rest well: at the ceiling it steers *"wrap up
immediately — provide your final answer now"* and only hard-aborts
`graceTurns` later, so hitting the limit produces an answer rather than a
severed run. An agent file can still raise it, and `max_turns: 0` still means
unbounded for anyone who wants that deliberately. The parent's kill switch is
`StopAgent`, which aborts running *and* queued agents.

### 7. Answer verification

`src/agents/verify.ts` (the judgement), `src/agents/verify-runner.ts` (the
control flow), the hidden `__verifier` agent type, and two wiring points in
`agent-manager.ts`. 35 tests. `SUBAGENT_VERIFY=0` turns it off.

**The problem is drift, not correctness.** A child gets a brief it has no
context for, compacts its window as it fills, and continues from a summary. pi
merges each summary into the last under a *"PRESERVE all existing information"*
prompt, so summaries grow — 456 → 4,029 → 11,054 chars across 42 real
compactions before the guard capped them — and what they erode first is the
oldest thing in the transcript, which is the brief. After three compactions the
child is answering a question that has quietly moved, and nothing notices: the
parent sees only the final text.

Three layers, cheapest first, so most runs pay nothing:

1. **The anchor.** On every `compaction_end`, the brief is steered back into the
   child's freshly-summarised context. ~50 tokens, no model call, and it stops
   the drift rather than detecting it. `execution.brief` holds the prompt
   verbatim, outside the session, because the session is exactly where it stops
   being reliable.
2. **The structural gate.** An empty answer, or a run that ended aborted /
   turn-limited / stopped. No model call. It reports those as *not worth
   judging* — `status-note.ts` already tells the parent they were cut off, and
   paying a model to confirm it is waste. An empty answer is **replaced** by an
   explanation rather than appended to, because an empty string reads to the
   parent as a lookup that found nothing.
3. **The judge, then a bounded repair loop.** Only for a non-empty answer from a
   clean run, because that is the only case where drift is invisible.

**The repair is re-judged, and the loop has a ceiling.** The first cut of this
shipped the retry unverified — which meant the one answer nobody checked was the
one already known to have come from a confused child. A repair is now judged in
its turn, up to `SUBAGENT_VERIFY_ROUNDS` attempts (default 1, clamped to 3), so
"was the fix any good?" is answered rather than assumed. The bound is the same
argument as the child's own turn ceiling: a round costs two model calls on the
one llama slot the parent is blocked on, plus two more turns in a child window
that is already the most likely culprit — re-asking a child whose context is
nearly full pushes it toward the compaction that causes the drift. Three
conditions end the loop, not just the counter: the budget, an empty repair, and
a repair identical to the answer just rejected. When everything fails, the
child's **original** answer goes back annotated, because that is what the parent
would have had with the verifier off; returning the last attempt was considered
and rejected.

**The judge does not run in the child's session, and that is the whole design.**
Asking the child to review its own work is the weakest check available: every
step that led it astray is in its context with a justification attached, and a
model handed its own reasoning ratifies it. The judge is a fresh `__verifier`
agent — no tools, no extensions, no skills, one turn — shown only the task and
the answer. Harder to fool because it knows less. The **repair** goes the other
way and continues the child's own session, which is the only place with the
context to fix anything.

Details that are easy to get wrong and impossible to notice afterwards, each
with a test:

- The verdict is asked for **before** the reasoning (`VERDICT:` then `WHY:`). A
  local model allowed to reason first argues itself into agreement.
- The parse checks `NOT_ADDRESSED` **before** `ADDRESSED`. One contains the
  other; the wrong order turns every failure into a silent pass, forever.
- An unreadable verdict **fails open** — a chatty 27B must not discard good work
   — but the answer is annotated as having gone out unchecked rather than
  reported as verified.
- The repair prompt restates the brief **in full** rather than referring to it.
  Pointing at "the original task" points at the thing that may have gone
  missing.
- A repair that returns empty keeps the *first* answer. Something beats nothing.
- `verifyAnswer` never throws. A broken verifier must not turn a finished
  subagent into a failed one.

**Cost: zero standing schema.** Measured — the `__verifier` type is `hidden`, so
it stays out of the `Agent` tool's enum. Without that flag the tool grows 357 →
368 chars and the model is offered an internal type it has no reason to call.
What a judged answer does cost is one small model call on the same single slot
the parent is waiting on.

**What it cannot do:** catch subtly wrong work. The judge is the same 27B that
wrote the answer. It is a drift check, not a correctness proof, and calling it
verification in the stronger sense would be a lie the parent would act on.

### 8. The verifier is visible — in flight, and in its verdict

`src/ui/verification-badge.ts` (new, pure), plus four call sites and one new
field on the record. 15 tests. Nothing here touches the wire.

**Two defects, both of them invisibility.**

*A passing check looked exactly like no check at all.* `record.verification` was
set on every checked answer and carried into `details.verification` by
`buildAgentDetails` — and read by nothing. A pass is deliberately undecorated in
the answer text (a note there is text the parent model will quote), so with the
renderer ignoring the field there was no surface anywhere that distinguished
"checked and fine" from "never checked", which is the one distinction the
verifier exists to draw. It now renders as a marker on the finished line, the
tool result, the subagent-result card, the viewer header and the `/agents` list:
dim `✓ checked` for a pass, `✎ repaired` in warning, `✗ off-task` in error, and
a distinct `⊘` label per skip. Absence still means unchecked — no badge is
invented for it, because that would restore the ambiguity.

*A verifying agent disappeared from the widget entirely.* Measured, not
inferred: verification runs inside the settlement chain's `.then`, after
`lifecycle.status` has been set to its terminal value and **before**
`completedAt` is stamped. `categorizeAgents()` sorts on exactly those two
fields — running, queued, or completed-within-the-retention-window — so for the
whole length of a judge call (and a repair, which is a full child turn) the
record matched none of them and its row vanished, then reappeared. On a stack
where every subagent already pauses the session because there is one llama slot,
that is the worst possible moment to remove the only thing on screen explaining
the wait. A `verifyPhase` field now keeps the row in the active set and the
activity line says which call is in flight — *"checking the answer against the
task…"* or *"answer was off-task — asking once more…"*.

The phase is reported by `verify-runner` through an `onPhase` dep rather than
set around the call in `agent-manager`, so the free structural checks — which
return before any model call — never flash a "verifying" row for a skip. Both
directions are tested: the transitions on the four paths that make a call, the
clear on every exit including the two throwing ones, and that a **throwing**
phase hook cannot change a verdict. That last one is not hypothetical bookkeeping:
without the guard the exception lands in `verifyAnswer`'s own catch and a passing
answer is reported as `errored`, which is a display concern rewriting a result.

One split came with it: `skipped-cutoff` used to cover both "the run was cut
off" and "no brief was recorded to check against". They are now separate values
(`skipped-nobrief`), because the first explains itself in the status note and
the second is a fault in our own spawn path that one shared label would hide.

### 9. `←` opens the agent list, not only `↓`

`src/events.ts`, one predicate. The keyboard hop this fork already had —
`↓` on an empty editor to enter the widget, `↑↓` to move, enter to open the
child's live transcript, esc back — is the same affordance Claude Code
advertises as *"← for agents"*, and both packages that have built it
independently (nicobailon's `fleet-status.ts`, tintinweb's `fleet-list.ts`)
accept `←` as well as `↓`. Adding it costs one predicate on a path that only
fires when the editor is empty, where `←` has nothing to move over.

### 10. Four defects found by an audit of the whole path

Written up in full — symptom, root cause, evidence, reproduction — in
`context/design/subagents-loop-verifier-anatomy.md` §9. In brief:

- **`continueSettledAgent` threw `ReferenceError: pi is not defined`.** The
  verifier wiring added `this.buildVerifyDeps(pi, ctx, record)` to the
  continuation call site, where neither identifier exists — the first-run site
  looks the same but destructures them from `SpawnArgs`. Continuing or steering
  a *settled* agent rejected. The lint gate is `node --check` over stripped
  types, which is syntax only, and nothing type-checks this tree, so a free
  identifier passed everything.
- **Every verified answer leaked an `AgentSession`.** The judge calls `runAgent`
  directly (it must — a judge that asked for a concurrency slot would deadlock
  against the child still holding one), which means no record, which means no
  teardown ever reaches it. Disposed explicitly now.
- **`extensions: false` did not suppress `additionalExtensionPaths`.** pi's
  loader reads `noExtensions ? cliEnabledExtensions : merge(...)` and the extra
  paths *are* the cli set, so the deliberately-empty `__verifier` was loading
  `pi-loop-mode` and `rtk-pi` — the latter spawning `rtk --version` on every
  judge call. The tool schema was never affected (`tools: false` empties it
  regardless), so this cost process spawns and handlers, not context.
  **The first fix for this did not work** — see §11.
- **A background spawn rendered with a success tick.** The renderer decided
  "background" by looking for `"running in background"` in the result text; the
  message says `[Agent running] Success! You delegated…`. `details.background`
  now carries it.

### 11. Six more, from a second audit

Written up in full — evidence class, reproduction, and the fix considered and
rejected — in `context/design/subagents-loop-verifier-evaluation.md`. The two
corrections to §10 and §2 are above; these are the rest.

- **`extensions: false` still did not reach the loader** (`declared-resources.ts`,
  new). §10's fix reads `config.extensions`, and `config` is `getConfig()`'s
  output, which resolves through `findActiveConfig()` — that substitutes
  **general-purpose** for any agent marked `hidden`. `__verifier` is hidden
  precisely so it stays out of the `Agent` tool's enum (11 chars of schema), so
  `getConfig("__verifier").extensions` came back `true` where the agent says
  `false`, and the guard was unreachable code. Nothing noticed because
  `tools: false` is read from `getAgentConfig` directly and *did* take effect —
  the judge really had no tools, which is the property everyone checked. The
  agent's own declaration now wins for `extensions` and `skills`, which for a
  non-hidden agent is exactly what `getConfig` already returned.
- **The spawn bracket covered the whole child run, not just the build.**
  `enterSubagentSpawn()` wrapped all of `runAgentImpl`, so for a background
  subagent the depth stayed above zero for minutes. An operator `/reload` in that
  window made *this* extension's factory return early — losing the Agent,
  StopAgent and AgentStatus tools and the widget — and made `pi-loop-mode`
  capture the subagent flag **permanently**, so the operator's loop never did its
  session housekeeping again. The bracket now covers `reloadAndMap()` (where
  factories run) through `bindExtensions()`, and nothing more.
- **Nothing could stop a verification.** It runs in the settlement chain, after
  the status has gone terminal, and every stop path keys off
  `status === "running"`: the operator's Esc reaches `stopAgent()` and gets
  `false`, the `StopAgent` tool likewise, and the watchdog's `check()` *deletes*
  the record's state rather than skipping it. Meanwhile the parent's tool call is
  blocked on a gate that only verification opens. Each verifier model call now
  carries a deadline (`SUBAGENT_VERIFY_TIMEOUT_MS`, default 300s), surfacing
  through the existing `errored` verdict so the answer still goes out, annotated.
- **A steered continuation was judged against the original brief.**
  `execution.brief` was written once at spawn. Steering a settled agent produced
  an answer to the steer, judged against the original prompt — NOT_ADDRESSED,
  correctly — and the repair then told the child to answer the original instead,
  discarding the operator's instruction and labelling the result `✎ repaired`.
  `appendFollowUp()` now extends the brief, bounded, keeping the original when it
  has to drop something.
- **A stale verdict survived an unverified continuation**, so a `✓ checked` badge
  and `verification: "passed"` appeared against text nothing had looked at.
  Cleared with the result.
- **The verifier's own cost was tallied nowhere.** Neither the judge's `runAgent`
  nor the repair's `continueAgentSession` was given the tracking callbacks, so a
  verified delegation under-reported itself by one to three model calls, and
  `getTotalAgentCost()` never saw the judge at all. Worse, `onCompaction` is what
  fires the task anchor — so the repair, the turn most likely to compact, was the
  one turn with the anchor switched off. `stats.verifyUsage` now holds what the
  verifier spent in its **own** sessions; the repair is a turn in the child's
  session and lands in `lifetimeUsage`. Nothing is in both, and `tallyCompletion`
  adds them.
- **An errored run was judged, and the result thrown away.** `structuralVerdict`
  did not list `error` as unworthy of a judge, while `executeAgentTool`
  intercepts error status and returns `errorResult(record.error)` without ever
  reading `record.result`. Now skipped.

## The prefix cache — measured, and not what was assumed

The assumption going in, inherited from the handoff, was that a subagent's own
system prompt evicts the parent's cached prefix from the single slot. **That is
false**, and it was worth measuring rather than repeating. Probed directly
against `/v1/chat/completions` with
`prompt_tokens_details.cached_tokens` (which `patches/forge_cached_tokens.py`
exposes), with a repeat of the same prefix as the control:

| child | parent's next call | |
| --- | --- | --- |
| six small turns (≤3.3k tokens) | 2,117 cached / 2,134 — **99.2%** | unaffected |
| four turns growing to 18k tokens | 0 cached / 2,134 — **full re-prefill** | evicted |

Same result on `:8080` and `:8081`, so it is llama.cpp's behaviour and not
something forge does. The eviction reproduced twice; the "small child" case
survived nine trials out of nine at 1–6 turns.

So the mechanism is **capacity, not identity**. A subagent that answers from its
own knowledge is nearly free to the parent's cache. A subagent that reads files
and runs searches — the reason to have one — pushes the parent out.

What that costs, timed on the same runs: the parent's next call went from
**442 ms to 2,949 ms**, a 2.5-second re-prefill of 2,133 tokens. A real parent
session carries far more than 2,133 tokens, so this is a floor rather than an
estimate of the worst case.

The practical consequence is that the standing schema charge (~178 tok/turn) is
**not** the main cost of delegating on this stack. The re-prefill on the turn
after a substantial subagent is.

## Verified live, against the real model

Run 2026-08-17 against Qwen3.8-27B through forge, not against a stub.

**The 27B model drives the description-free schema.** Asked to delegate, it
emitted a well-formed `Agent` call with a self-contained prompt and a sensible
`description`, did not search itself, and got a correct answer back. Asked for a
background run it set `run_in_background: true` — an undescribed boolean — then
polled with `AgentStatus` and slept between polls, all inferred from parameter
names. This was the question that decided whether the package was usable here at
all, and it is answered.

**The background cap fires on the real path.** From the injected message:

```
role: custom, customType: "subagent-result"
[output capped at 20% context: 14218 chars, kept about 10495.
 Full output: /tmp/pi-subagent-result-qGLIYT/general-purpose-b78d6c07-0332-438.txt. …]
```

The spill file is on disk at 14,348 bytes. Better than that: the parent then read
the marker, went to the file for the exact size, and reported it. The recovery
bargain is not theoretical — the model took it unprompted, first time.

That run also settled the marker's wording. The advice inherited from the guard
was "prefer a narrower command", which the model **followed** — it went looking
for a command to narrow that had never been run. `planOutputCap` now takes the
advice from its caller, and this one says to read the file or re-task the agent.

**Extensions load in the in-process child too**, which was not obvious and is
worth knowing: the same run shows compaction-guard capping the *child's* own
`read` result at 9,778 → 8,176 chars inside the child session. Subagents are
bounded in their own windows, not just on the way back.

## Not verified

- **prinny forwarding is answered from source, not from Matrix**, because
  testing it live means logging a bot into a homeserver. `forwardToMatrix`
  returns early unless a room has a *live* `awaitingReply` entry, and
  `forwardResult` deletes every live entry when a run settles. So: a subagent
  that finishes while the parent is still streaming is delivered as a `steer`,
  folds into that run, and is forwarded normally. One that finishes after the
  run settled starts a *new* turn against a room that has already been retired,
  and its answer **stays local** — the Matrix user who asked never sees it. The
  failure mode is silence, not a leak, which is the safe direction, but a long
  background job started from Matrix currently answers into the void.
