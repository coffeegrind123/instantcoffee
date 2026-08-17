# Subagents, the loop, and the verifier — an independent evaluation

**Written 2026-08-17, against the working tree** (`1de8361` + the uncommitted
changes listed in `git status`). This is the *second* pass over the same three
pieces. The first is `context/design/subagents-loop-verifier-anatomy.md`, which
describes the design and lists eight defects (B1–B8). This document does not
repeat that one. It does three different things:

1. **Re-derives the runtime picture from pi 0.84.2's own source** rather than
   from the fork's comments, because two of the anatomy doc's load-bearing
   claims turn out to be false at runtime.
2. **Reports eleven further defects (F1–F11)**, five of them proven by
   executable reproduction against the real modules, not by reading.
3. **Corrects the record** on B4 and B5, which are documented as fixed and are
   not — B5 not at all, B4 for two handlers out of thirteen.

**Status: ten of the eleven are fixed; §10 lists what shipped and the one thing
that deliberately did not.** The finding text below is left in the tense it was
written in, because the reproduction is the evidence — rewriting it into "was
fixed" would leave nothing to check the fix against.

| Evidence class | Meaning |
| --- | --- |
| **PROVEN** | A script was run against the real modules and its output is quoted. |
| **SOURCE** | Read out of this checkout or pi 0.84.2's `dist/`, with line refs. |
| **REASONED** | Follows from SOURCE facts, but the path was not executed. |

---

## 0. The one-paragraph version

The three pieces are individually well built. The problem is the seam between
them, and it is worse than the anatomy doc says. `vendor/pi-loop-mode` keeps its
entire state machine in module scope; a subagent session binds the *same module
object* and gets its **own copy of all thirteen event handlers**. B4 guarded two
of them. The remaining eleven mean that **while `/loop` is running, every
subagent is told the operator's goal in its system prompt, drives the operator's
loop ladder from its own `agent_end`, receives the operator's next loop turn,
and — if it compacts — has its entire conversation replaced by the operator's
loop handoff summary.** All four of those are proven below. On top of that, the
one agent that was supposed to be immune (`__verifier`) is not, because the
`extensions: false` that would have made it immune never reaches the loader; and
the concurrency limit of 1 that the fork argues for at length is not the limit
the manager actually runs with — it runs with 4.

---

## 1. The runtime shape, corrected

The anatomy doc's pipeline diagram is accurate for the subagent package in
isolation. What it omits is the second extension graph that comes up inside
every child. This is the picture that matters:

```
  ONE NODE PROCESS ─ ONE llama slot ─ 32,768-token window ─ PARALLEL_SLOTS=1
  ═══════════════════════════════════════════════════════════════════════════════

  ┌─ MODULE CACHE (loaded once, ever) ──────────────────────────────────────────┐
  │                                                                              │
  │   vendor/pi-loop-mode/extensions/index.ts                                    │
  │   ┌──────────────────────────────────────────────────────────────────────┐   │
  │   │  let state: LoopState        ← ONE object. goal, iteration, stuck     │   │
  │   │  let pendingTimer            ← ONE timer handle                       │   │
  │   │  let runToken                ← ONE counter                            │   │
  │   │  let degenerateAbortPending  ← ONE flag                               │   │
  │   │  let contextRecoveryPending  ← ONE marker                             │   │
  │   │  let ownCompactionInFlight / emergencyCompactionPending               │   │
  │   └──────────────────────────────────────────────────────────────────────┘   │
  │            ▲                                              ▲                  │
  │            │  read+write                                  │  read+write      │
  └────────────┼──────────────────────────────────────────────┼──────────────────┘
               │                                              │
   ┌───────────┴────────────────┐              ┌──────────────┴─────────────────┐
   │ OPERATOR INSTANCE          │              │ CHILD INSTANCE                 │
   │ factory(pi_operator)       │              │ factory(pi_child)              │
   │ isSubagentInstance = false │              │ isSubagentInstance = TRUE      │
   │                            │              │                                │
   │ 13 handlers on the         │              │ 13 handlers on the             │
   │ operator's event bus       │              │ CHILD's event bus              │
   │                            │              │   · 2 skipped by the B4 guard  │
   │                            │              │   · 11 RUN, against `state`    │
   └────────────────────────────┘              └────────────────────────────────┘
```

Everything about that picture is SOURCE-verified:

- **The factory runs once per session bind.** `core/extensions/loader.js:368-376`
  caches the *module*, then `:409` calls `await factory(api)` with a fresh
  `ExtensionAPI` per load. So handlers are per-session; `state` is not.
- **A subagent binds extensions.** `agent-runner.ts:607` calls
  `session.bindExtensions(...)`, inside the `enterSubagentSpawn()` bracket
  (`agent-runner.ts:731-736`), which is why `bornInsideSubagentSpawn()` reads
  true for the child instance.
- **A subagent gets `pi-loop-mode` deliberately.**
  `subagent-denylist.ts:146-153` puts `vendor/pi-loop-mode/extensions/index.ts`
  and `vendor/rtk-pi/extensions/index.ts` back via `additionalExtensionPaths`,
  and `core/resource-loader.js:276,311,315-317` shows those become the
  `cliEnabled` set, which survives `noExtensions`.
- **Every session emits the full event set.** `agent-session.js:1761`
  (`session_start` at the end of `bindExtensions`), `:445-446` (`agent_end`,
  unconditional), `:884` (`before_agent_start`), `:246-248` (`tool_result`,
  from the generic `afterToolCall`, so it covers extension-registered tools —
  which is what makes `compaction-guard` bound a foreground `Agent` result).

The B4 guard, in full:

```
   pi-loop-mode's 13 handlers, and what the B4 guard covers
   ─────────────────────────────────────────────────────────────────────────
   session_before_compact   :899   ✗ unguarded   ← F1a  hijacks child compaction
   session_compact          :954   ✗ unguarded   ← F1b  consumes parent's marker
   session_start           :1349   ✓ GUARDED (B4)
   session_shutdown        :1396   ✓ GUARDED (B4)
   agent_settled           :1405   ✗ unguarded   ← F1c
   before_agent_start      :1422   ✗ unguarded   ← F1d  PROVEN: prompt leak
   before_provider_request :1438   ✗ unguarded   ← F1e  PROVEN: sampling leak
   context                 :1458   ✗ unguarded   ← F1f
   message_start           :1487   ✗ unguarded
   message_update          :1491   ✗ unguarded   ← F1g  shared abort flag
   tool_result             :1505   ✗ unguarded   ← F1h  poisons stuck detection
   message_end             :1513   ✗ unguarded   ← F1i  poisons repetition state
   agent_end               :1527   ✗ unguarded   ← F1j  PROVEN: the big one
   ─────────────────────────────────────────────────────────────────────────
   guarded 2 / 13
```

Compare `vendor/pi-subagents-lite/src/index.ts:19`, which handles the same
hazard correctly with one line:

```ts
if (isInsideSubagentSpawn()) return;   // ← the whole extension stays inert
```

`pi-loop-mode` could not do exactly that (a loop started *inside* a child is a
deliberate feature — `subagent-denylist.ts:129-145`), which is why the fork
chose per-handler guards. It then guarded the two handlers the symptom had been
traced to, and stopped.

---

## 2. F1 — the operator's loop runs inside every subagent · **CRITICAL**

### 2.1 What was proven

A probe loads `extensions/index.ts` twice, exactly as the process does (the
second load with `__PI_SUBAGENT_SPAWN_DEPTH__ = 1`, which is how
`pi-subagents-lite` announces a spawn), starts a loop on the operator instance,
and then fires the child's handlers. Reproduction recipe in §9.

**F1d — the child's system prompt is rewritten.** PROVEN.

Operator runs `/loop start refactor the parser. Done when: tests pass`. Then a
subagent — asked to do something else entirely — starts a turn:

```
=== child before_agent_start returned ===
[
  {
    "systemPrompt": "<<CHILD SYSTEM PROMPT>>\n\nLoop mode is active. Goal:
     refactor the parser. Completion criteria: tests pass. Keep every assistant
     response under 1,200 characters, do one progress batch per turn, endless
     mode: after LOOP_DONE the loop continues with improvements, never stop on
     your own, never wait for a human (make documented assumptions instead),
     and never dump full logs/diffs/context."
  }
]
```

Read what that does to a subagent. It is told (a) its goal is the operator's
goal, (b) to cap every response at 1,200 characters — a subagent whose entire
value is returning a complete answer, (c) to do one progress batch per turn
rather than finish the task, (d) **never to stop on its own**, on a session
whose only exit is the 40-turn ceiling. This is a drift *cause*, injected by the
stack, into the exact mechanism the verifier exists to detect drift in.

**F1j — the child drives the operator's loop, and receives its next turn.**
PROVEN. Firing the child's `agent_end`:

```
messages sent by CHILD's pi:  [{ customType:"loop", content:"Keep going — pick
  the next step from your plan and do it now.\n\nGoal: refactor the parser\n
  Completion criteria: tests pass\nIteration: 2/∞\n\nRules: …" }]
messages sent by OPERATOR's pi: []

--- operator status after the child's turn ---
Active: true   Iterations: 1/∞          ← was 0/∞; the child burned it
```

Every consequence there is a separate failure:

| What happened | Consequence |
| --- | --- |
| `clearPendingTimer()` at `:1543` | the operator's already-scheduled iteration is cancelled |
| `state.iterationCount++` at `:1653` | the child consumes the operator's `--max N` budget |
| `persistState(pi_child)` | the loop state is written to the **child's** in-memory branch and discarded; the operator's branch never gets it |
| `scheduleLoopTurn(pi_child, …)` at `:1805` | **the operator's next loop turn is delivered into the child's session** |

The last one is the serious one. `agent-session.js:779-780` notes that "the
agent loop drains both queues before emitting `agent_end`. Any messages here
were queued by `agent_end` extension handlers and need a continuation" — so the
loop turn queued from the child's `agent_end` does not evaporate, it continues
the child. The child then works on the operator's goal until it hits
`DEFAULT_MAX_TURNS` (40) or the 45-minute watchdog, and the operator's loop has
no pending timer at all: it is not paused, not stopped, just silently no longer
advancing.

**F1a — the child's compaction is replaced by the operator's loop handoff.**
PROVEN. Firing the child's `session_before_compact` with `reason: "threshold"`:

```
firstKeptEntryId: child-entry-42
summary:
## Goal
refactor the parser
## Completion Criteria
tests pass
## Loop State
- Iteration: 0
…
## Next Step
This is a handoff: the conversation above was dropped, and everything that
survived it is written down here or in the files named above. Do not try to
recall it. Re-establish bearings from the working tree (git status, git log,
the durable files), then perform exactly one concrete next progress batch and
write what you did to PROGRESS.md before the next handoff.
```

The gate that lets this through:

```
   loopOwnsThisSession = state.active && Boolean(state.description)    ← OPERATOR's
   windowNeedsHandoff  = contextWindow <= 65_536                       ← child is 32k → true
   needsHandoff        = loopOwnsThisSession && windowNeedsHandoff     ← true
```

So *every* subagent compaction on this stack, while a loop is active, discards
the child's conversation and substitutes the operator's goal. The anatomy doc's
premise for the verifier — "pi compacts it and it carries on from a summary…
what they erode first is the brief" — understates what actually happens here:
the brief is not eroded, it is deleted and replaced with someone else's task.

The only thing standing between that and a totally lost subagent is the
**anchor** (`agent-manager.ts:639-645`), which fires on `compaction_end` and
steers the brief back in. That was designed as prevention against gradual
erosion; it is in fact the sole survivor of a total context substitution. Worth
knowing when someone proposes removing it as redundant.

**F1e — sampling penalties leak.** PROVEN. After a stuck intervention on the
operator, the child's provider payload comes back mutated:

```
{ "temperature": 0.899…, "frequency_penalty": 0.5, "presence_penalty": 0.5 }
```

The remaining unguarded handlers, SOURCE/REASONED:

- **F1b `session_compact`** (`:954-975`) — consumes the operator's
  `contextRecoveryPending` when the *child* compacts, and calls
  `finishContextRecovery(pi, ctx_child, …)`. Even with no marker pending it
  resets the operator's `contextCompressionLevel` to 0, undoing a tightening
  that was applied because the last summary did not free enough room.
- **F1c `agent_settled`** (`:1405-1420`) — a child settling can finalize the
  operator's soft stop, or fire `requestEmergencyCompaction(pi, ctx_child, …)`,
  compacting the child instead of the operator.
- **F1f `context`** (`:1458`) — the child above 60% gets the *loop-flavoured*
  budget line: "the loop will compact to a fresh context shortly… record state
  in PROGRESS.md". Wrong advice for a subagent, and it suppresses
  `compaction-guard`'s neutral line via the shared `-context-budget` suffix
  check.
- **F1g `message_update`** (`:1491-1503`) — the child's degenerate-repetition
  abort sets the shared `degenerateAbortPending`, which the operator's next
  `agent_end` consumes at `:1631` and mis-reads as its own turn degenerating.
- **F1h `tool_result`** (`:1505-1511`) — every child tool call increments the
  operator's `state.toolCallsThisTurn` and pushes into `state.recentToolResults`
  (10-deep). A delegating operator turn therefore never looks narration-only,
  and the "same tool result repeated" stuck rule fires on the child's reads.
- **F1i `message_end`** (`:1513-1525`) — the child's assistant text is pushed
  into `lastAssistantFingerprints` / `Snippets` / `Texts`, the entire input to
  `detectStuck()`. Two similar child answers can trip
  `SIMILARITY_THRESHOLD` and make the operator's loop declare *itself* stuck.
- **Goal check** — if the operator's loop has `--check "<cmd>"`,
  `runGoalCheck(pi_child)` executes that shell command once per child turn
  (`:1683`). Real side effects (a test suite, a build) fired by delegation.

### 2.2 How often this fires

Per **foreground, verified** delegation the child's `agent_end` fires **three
times** — once for the child's run, once for the judge's run (see F2: the judge
loads `pi-loop-mode` too), and once more for a repair. Each is a full pass down
the ladder in §6 against the operator's state.

### 2.3 The fix

Two shapes, and the choice is a policy call:

- **Narrow.** Guard the eleven remaining handlers on `isSubagentInstance`,
  matching what the two guarded ones already do. Cheap, mechanical,
  test-coverable by extending `tests/subagent-isolation.test.ts` (which already
  has the right two-instance harness). Cost: a loop started *inside* a child
  stops working, because it would need those handlers too.
- **Correct.** Key the state by session instead of by module —
  `const state = stateFor(pi)` behind a `WeakMap<ExtensionAPI, LoopState>`.
  That is the repair the anatomy doc names and defers ("a refactor of every
  reference in a 1,700-line file"). It is the only version under which a
  subagent loop and an operator loop can coexist, which the stack explicitly
  wants.

A middle path exists and is probably right for now: guard the eleven, and make
the guard read `isSubagentInstance && !childHasItsOwnLoop`, where the child's
own `runLoop()` sets a per-instance flag. That preserves the child-loop feature
without sharing state until someone does the WeakMap refactor.

---

## 3. F2 — `extensions: false` never reaches the loader · **HIGH**

The anatomy doc records B5 as fixed. It is not. The fix is in the right file and
never executes.

`agent-runner.ts:534` reads:

```ts
additionalExtensionPaths: extensions === false ? [] : subagentExtraExtensionPaths(),
```

where `extensions` is `config.extensions`, and `config` came from
`getConfig(type, …)` at `:746`. `getConfig` calls `findActiveConfig`
(`agent-types.ts:346-350`):

```ts
function findActiveConfig(type: string): AgentConfig | undefined {
  const config = getAgentConfig(type);
  if (config?.hidden !== true) return config;
  return agents.get("general-purpose");     // ← __verifier is hidden
}
```

`__verifier` is declared `hidden: true` (`default-agents.ts:86`) precisely so it
stays out of the `Agent` tool's enum. That flag also makes `getConfig` hand back
**general-purpose's** config. PROVEN:

```
getAgentConfig('__verifier').extensions = false
getAgentConfig('__verifier').tools      = false
getAgentConfig('__verifier').skills     = false

getConfig('__verifier') = {
  "displayName": "Agent",
  "description": "General-purpose agent for complex, multi-step tasks",
  "registeredTools": ["read","bash","edit","write"],
  "skills": true,
  "extensions": true          ← not false. B5's guard never fires.
}

--- what createResourceLoader would decide ---
noExtensions (config.extensions === false): false
additionalExtensionPaths = [] ?          : false
noSkills                                : false

session allowed tools: []                ← this part IS correct

non-hidden agent with extensions:false -> getConfig().extensions = false
```

The last line is the control: the mechanism works for a visible agent. It is the
`hidden` flag, added for a completely unrelated reason (11 chars of tool
schema), that silently disables it.

```
   __verifier's declared config              what actually reaches the session
   ┌──────────────────────────┐              ┌──────────────────────────────────┐
   │ tools:      false        │──────────────▶│ tools: []            ✔ correct  │
   │ extensions: false        │──── hidden ──▶│ extensions: true     ✘ WRONG    │
   │ skills:     false        │     routes    │ skills: true         ✘ WRONG    │
   │ maxTurns:   1            │     around it │ maxTurns: 1          ✔ correct  │
   │ systemPrompt: "judge…"   │              │ systemPrompt: judge  ✔ correct   │
   └──────────────────────────┘              └──────────────────────────────────┘
        via getAgentConfig()                      via getConfig()
```

Consequences, in order of how much they cost:

1. **`pi-loop-mode` is bound into every judge session**, so F1 fires again, per
   verified answer. This is the one the anatomy doc explicitly worried about
   ("a *foreground* delegation with verification on fires the same clobber
   twice") and believed B5 had closed.
2. **`rtk-pi` is bound**, and its factory runs `rtk --version` as a subprocess
   on load — a process spawn per judge call, on the one llama slot the parent
   is blocked on. This is verbatim the cost B5 was written to remove.
3. **Skills are discovered** for a one-turn agent that reads a task and an
   answer and replies with two lines.
4. The judge is *also* subject to the denylist and the `.pi/extensions/*`
   discovery, so it binds `compaction-guard` too. Harmless, but it means the
   "emptiest agent in the file" comment in `default-agents.ts:71` is not
   describing the thing that runs.

**Fix.** Read the agent's own config for these three fields rather than the
resolved one. `createResourceLoader` (`agent-runner.ts:492`) already receives
`agentConfig`; the minimal change is:

```ts
// agentConfig is the agent's OWN frontmatter; config is the resolved one, and
// getConfig() routes a hidden type to general-purpose (agent-types.ts:346).
const declaredExtensions = agentConfig?.extensions ?? config.extensions;
const declaredSkills     = agentConfig?.skills     ?? config.skills;
```

and use `declaredExtensions` for `noExtensions`, `buildExtOverride` and
`additionalExtensionPaths`, `declaredSkills` for `noSkills`. Alternatively fix
`findActiveConfig` to stop conflating "not spawnable by the model" with "not a
real agent" — but that is a wider blast radius, since the fallback exists for
the case where a *user* names a hidden type.

Either way it needs a test. `tests/` has none that constructs the loader
options, which is why this went unnoticed: the B5 change is unreachable code and
nothing asserts on it.

---

## 4. F3 — the concurrency limit is 4, not 1 · **HIGH**

`agent-manager.ts:41-56` carries the longest single comment in the package,
arguing from measurement that the default must be 1 on a one-slot server:

> a child that grew to 18k tokens took the parent's next call from 2,117 cached
> tokens to zero, and from 442 ms to 2,949 ms.

`FORK.md` §2 is titled "Default concurrency 4 → 1". The anatomy doc §5 repeats
it. The manager does not run with 1.

```
   AgentManager constructor
   ───────────────────────────────────────────────────────────────────
   this.defaultConcurrency = concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT
                             ─────────┬─────────     ──────────┬───────────
                                      │                        │
                        always supplied by the           the fork's 1 —
                        ConfigStore, never undefined     dead code
                                      │
   events.ts:34-38 → new AgentManager(undefined, getStore().concurrency, …)
                                      │
   config-store.ts:209-215 → { default: session.default ?? base.default, … }
                                      │
   config-io.ts:220-223 → { ...DEFAULT_CONCURRENCY, ...(raw.concurrency ?? {}) }
                                      │
   config-io.ts:37 → export const DEFAULT_CONCURRENCY = { default: 4 }
                                      ▼
                                    limit 4
```

PROVEN, with no config files present on this box (neither
`~/.pi/agent/subagents-lite.json` nor `.pi/subagents-lite.json` exists):

```
DEFAULT_CONCURRENCY (config-io): { default: 4 }
store.concurrency (what ensureManagerAndWidget passes): { default: 4, providers: {}, models: {} }
effective slot for forge/qwen3.8-27b: { limit: 4, running: 0 }
with NO config at all: { limit: 1, running: 0 }
```

The last line shows the fork's constant is correct and simply never consulted.
Live effect: up to four subagents run concurrently against `PARALLEL_SLOTS=1`,
four foreign prefixes compete for one prompt cache, and four children hold
context alive — the exact state the comment says was measured and rejected.

**Fix.** One line: `config-io.ts:37` → `{ default: 1 }`, with the reasoning
moved or cross-referenced from `agent-manager.ts`. Do *not* fix it by deleting
`DEFAULT_CONCURRENCY_LIMIT`; it is the correct value for a caller that passes no
config, and the menu's reset path reads `DEFAULT_CONCURRENCY`.

Worth a regression test that asserts the manager's effective slot limit through
the real wiring (`ConfigStore` → `AgentManager`), because the bug is precisely
that the two halves each look right on their own.

---

## 5. The verifier, re-examined

The ladder itself is sound and I found no logic error in `verify.ts` /
`verify-runner.ts`. The parse order (`NOT_ADDRESSED` before `ADDRESSED`), the
verdict-before-reasoning prompt, fail-open on an unparsed reply, and returning
the *original* on total failure are all defensible and correctly implemented.
The defects are all at the boundary — in what the runner is wired to, not in
what it decides.

```
   the verification window, and what is switched off inside it
   ═══════════════════════════════════════════════════════════════════════════
   run promise settles
        │
        ├─ status := completed | turn_limited | aborted | error
        ├─ record.result := responseText
        │
        ▼   ┌──────────────────────────────────────────────────────────────┐
   ┌────────┤  status is TERMINAL, completedAt is NOT set                  │
   │        │                                                              │
   │        │   stopAgent()      → returns false  (status !== "running")   │  F4
   │        │   Esc / parent sig → abort(id) → stopAgent → false           │  F4
   │        │   StopAgent tool   → same                                    │  F4
   │        │   watchdog.check() → isRunning(id) false → STATE DELETED     │  B7
   │        │   judge's runAgent → no AbortSignal passed at all            │  F4
   │        │                                                              │
   │        │   widget          → verifyPhase keeps the row visible ✔      │
   │        └──────────────────────────────────────────────────────────────┘
   │             │
   │             │  judge (1 call)  →  repair (1 call)  →  judge (1 call)
   │             │  every one of them on the slot the parent is blocked on
   │             ▼
   └──────▶ completedAt := now  →  .finally: slot released, gate opened
```

### F4 — the verification window is uninterruptible · **HIGH**, extends B7

B7 records that the watchdog does not cover verification. It is broader than
that: **nothing** covers it.

- `checkWatchdogs()` passes `isRunning = status === "running"`
  (`agent-manager.ts:851`), and `Watchdog.check()` *deletes* the record's state
  for anything not running (`watchdog.ts:92-95`). So the watchdog does not just
  skip the record, it forgets it.
- `stopAgent()` returns false for a terminal record (`agent-manager.ts:814`).
  The parent's interrupt binding is still attached at this point — it is
  detached in `.finally`, after verification — so pressing Esc *does* reach
  `abort(id, "user")`, which *does* call `stopAgent`, which does nothing.
- The judge is started as `runAgent(ctx, VERIFIER_AGENT_TYPE, prompt, { pi,
  maxTurns: 1 })` — `RunOptions.signal` is not passed, so
  `forwardAbortSignal()` wires nothing.

The anatomy doc notes this is not hypothetical here: llama-server has wedged on
this stack badly enough that an 8-token completion timed out at 60 s while
`/health` answered instantly. In that state a verified foreground delegation
hangs the parent's `Agent` tool call with no operator-reachable exit.

**Fix.** The cheapest correct version is a deadline on the judge, not a fourth
watchdog state: give `buildVerifyDeps.judge` an `AbortController` with a
`setTimeout`, forward it as `RunOptions.signal`, and let `verifyAnswer`'s own
`catch` turn the timeout into `status: "errored"` — which it already handles,
including the operator notice. That keeps the behaviour change contained to
"verification can give up", which is what the verifier is designed to do
everywhere else.

### F5 — a continuation is judged against the original brief · **MEDIUM**

`record.execution.brief` is written once, at spawn (`agent-manager.ts:254`).
`continueSettledAgent()` re-attaches the settlement chain **with verification
enabled** (`:770-775`) but never updates the brief. So:

```
   spawn   brief := "summarise the auth flow"
   answer  → judged against the brief → passed
   operator steers: "now also list the callers of validateToken"
   continuation answers about callers
        │
        ▼  verifyAnswer(record, brief = "summarise the auth flow", …)
   judge: does this ANSWER address the TASK?  →  NOT_ADDRESSED
        │
        ▼  buildRepairPrompt(brief, why)
   "This is the task, in full, as it was given to you: summarise the auth flow.
    Answer it now."                       ← the steer is discarded
```

The steer path is reachable from the `/agents` menu and the conversation
viewer's steer box (`events.ts:111`). The repair actively undoes the operator's
instruction, and the answer that comes back is annotated `✎ repaired`, which
reads as an improvement.

**Fix.** Update `record.execution.brief` in `continueSettledAgent` — either
replace it with the steer message, or append it (`brief + "\n\nFollow-up: " +
message`). Appending is the better default: a follow-up usually presupposes the
original task, and the anchor also reads this field.

### F6 — a stale verdict survives an unverified continuation · **LOW**

`runVerification` returns immediately when `deps` is undefined
(`agent-manager.ts:386`). B1's repair makes that reachable by design: when
`getPiInstance()` or `record.execution.spawnCtx` is missing, "the continuation
still runs, just unverified". But `record.result` has been overwritten and
`record.verification` has not, so the widget, the `/agents` list, the viewer
header and `details.verification` all report the *previous* run's verdict
against the *new* answer. Same happens if `SUBAGENT_VERIFY` is flipped to `0`
between a run and a continuation.

**Fix.** `record.verification = undefined` at the top of `runVerification` (or
in `continueSettledAgent`, next to `record.result = undefined`). Absence is
already the "never checked" signal the badge module is built around
(`verification-badge.ts:65-75`), so this costs nothing to express.

### F7 — the verifier's own token cost is invisible · **MEDIUM**

Neither model call the verifier makes is tracked:

| Call | Callbacks passed | Effect |
| --- | --- | --- |
| judge — `runAgent(ctx, "__verifier", …, { pi, maxTurns: 1 })` | none | no `onAssistantUsage`, no record, no `agentId` |
| repair — `continueAgentSession(session, …, { maxTurns, graceTurns })` | none | usage not added to `record.stats.lifetimeUsage` |

Compare `startAgent`, which spreads `this.runTrackingCallbacks(...)` into the
run options (`agent-manager.ts:441`). So a delegation whose widget line reads
`⟳2 · 1.2k in · 300 out` actually spent **three** model calls and an unknown
extra input/output, and `getTotalAgentCost()` — the session-level tally — never
sees any of it. On a stack where the whole argument for subagents is context and
slot economics, the accounting hides the thing being economised.

It also means the repair's turn does not increment `record.stats.turnCount`, its
compaction (if any) does not increment `compactionCount` **and does not fire the
anchor**, because `onCompaction` is what carries the anchor
(`agent-manager.ts:630-647`). A repair is the turn most likely to compact — the
child is already near the end of its window — and it is the one turn with the
anchor switched off.

**Fix.** Pass `this.runTrackingCallbacks(record, undefined, () => {})` into the
repair call, and give the judge a minimal `onAssistantUsage` that adds into a
separate `record.stats.verifyUsage`. Keeping them separate is better than
merging: the operator wants to know what the check cost, not to have it hidden
inside the child's number.

### F8 — an errored run is judged, and the judged text is then discarded · **LOW**, extends B8

B8 records that `structuralVerdict()` does not skip `status === "error"`. The
second half is worse: for a **foreground** spawn, `executeAgentTool` intercepts
error status *before* it formats the result:

```ts
// tool-execution.ts:262-264
if (record.lifecycle.status === "error") {
  return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
}
```

`record.result` — including whatever the judge/repair produced, at up to three
model calls — is never read. The money is spent and the output thrown away.

**Fix.** Add `"error"` to the `worthJudging: false` list in
`structuralVerdict()` (`verify.ts:89`). That is the change B8 declined to make
"under cover of a documentation pass"; this evaluation is the change that owns
the semantics, and the semantics are clear: a run that ended in a provider error
already explains itself, and its partial text is not worth a judge.

---

## 6. The loop, re-examined

The loop's own logic is the strongest of the three. The context-recovery race
fix (defer to `agent_settled`, adopt pi's recovery, treat *"Already
compacted"* as success), the handoff-instead-of-compaction decision on a ≤64k
window, and routing an empty turn at ≥80% to recovery instead of to the stuck
ladder are all correct and well argued. The full agent_end ladder:

```
   agent_end (state.active)
   │
   ├─ 0. clearPendingTimer()                          ← unconditional
   ├─ 1. softStopRequested?          → finalizeSoftStop, return
   ├─ 2. isContextPressure(...)?     → consecutiveErrorCount++
   │        ├─ >= 3 attempts         → enterContextCooldown (60→120→240s)
   │        └─ else                  → contextRecoveryPending, defer to agent_settled
   │      (an empty turn at >=80% counts here, NOT as fixation — the 87% cliff)
   ├─ 3. no assistant | stopReason error → exponential backoff 5→300s
   ├─ 4. aborted + degenerateAbortPending → interveneStuck
   ├─ 5. aborted (operator Esc)      → pause, keep state for /loop resume
   │
   │  ─── from here the turn counted: iterationCount++, error counters reset ───
   │
   ├─ 6. rescueActive?               → switch back to loop model, continue
   ├─ 7. checkCommand?               → runGoalCheck; untilDone && passed → completed
   ├─ 8. LOOP_DONE marker            → untilDone ? completed : continue-with-improvements
   ├─ 9. LOOP_BLOCKED marker         → continue with assumptions
   ├─10. maxIterations reached       → pause
   ├─11. score regressed             → request a fix
   ├─12. detectStuck(...)            → interveneStuck ladder:
   │        saturated?               → straight to ctx.compact()
   │        >=3 stuck + rescueModel  → one turn on the rescue model
   │        >=5 stuck                → ctx.compact() to break fixation
   │        else                     → rotating strategy + 2^n s backoff (cap 60)
   ├─13. 8 iterations w/o a state change → audit nudge
   └─14. otherwise                   → scheduleLoopTurn(continue, delaySeconds)
```

Constants, for reference: pressure 85%, starvation/critical 80%, notice 60%,
handoff window ≤65,536, recovery attempts 3, cooldowns 3 × (60→120→240 s),
rescue after 3, compact after 5, penalty turns 3, no-progress window 8,
similarity 0.8, degenerate 4 (6 mid-stream), backoff 5→300 s, will-retry
watchdog 45 s.

### F10 — the `loop` tool's `--check` round-trip is lossy · **LOW**

`argsForLoopTool` (`:1263`) builds the command as
`--check ${JSON.stringify(params.check.trim())}`, and `extractCheckCommand`
(`arguments.ts:15`) reads it back with `--check(?:=|\s+)(?:"([^"]*)"|…)`. A
command containing a double quote — `grep "foo" bar` — is stringified to
`"grep \"foo\" bar"`, and `[^"]*` stops at the backslash, so the loop is
configured with the truncated command `grep \`. It will run, fail, and be
reported as a failing goal check.

Two smaller things in the same area: the goal string is interpolated raw, so a
goal containing `--max` or `Done when` is re-parsed as flags (correct for the
slash command, surprising through a tool); and the schema's `action` description
says `start|stop|status|finish|resume|end` while `TOOL_ACTIONS` also accepts
`stats`.

**Fix.** Either single-quote in `argsForLoopTool` and add `'([^']*)'` handling
consistently, or — better — stop round-tripping through a string: give
`loopCommand` a structured overload the tool calls directly, and keep string
parsing for the slash command only.

### F9 — a reload during any in-flight subagent mis-brands the operator · **MEDIUM**, REASONED

`runAgent` brackets `enterSubagentSpawn()` / `exitSubagentSpawn()` around the
**entire child lifecycle**, not just session construction
(`agent-runner.ts:731-736`). For a background subagent that is minutes. If the
operator's extensions reload in that window — `/reload`, a settings change, any
`session_start` with reason `reload` — then:

- `pi-subagents-lite`'s factory sees `isInsideSubagentSpawn()` true and returns
  early (`index.ts:19`): the operator loses the `Agent`, `StopAgent` and
  `AgentStatus` tools, the widget, and the manager wiring.
- `pi-loop-mode`'s new instance captures `isSubagentInstance = true`
  (`:897`), so **the operator's own `session_start`/`session_shutdown`
  housekeeping is skipped for the rest of the process** — no state restore, no
  auto-resume, no pending-timer cleanup.

The second is the nastier one because it is permanent and silent: the guard is
captured once, at factory time, and there is no path that re-evaluates it.

**Fix.** Narrow the bracket to session construction (`enterSubagentSpawn()`
around `createAndConfigureSession`, `exitSubagentSpawn()` immediately after
`bindExtensions` returns, before `runSessionPrompt`). The counter exists to mark
"a subagent session is being built", and the build is over once the extensions
are bound. Nothing in either consumer needs it to stay set for the run.

### F11 — the cross-package import is a layering hazard · **INFO**

`src/spawn/result-cap.ts:44` imports
`../../../../.pi/extensions/compaction-guard/src/output-cap.ts`. The reasoning
(don't duplicate measured constants away from the test that justifies them) is
right; the mechanism hard-codes the repo layout four levels up from a vendored
package. `scripts/pi-local.sh:311-313` guards it by refusing to load subagents
when the guard is missing, which covers the launcher path and nothing else — a
`pi install` of `vendor/pi-subagents-lite`, or moving `vendor/`, breaks the
extension at load with a module-resolution error rather than a degraded mode.

Not worth fixing today. Worth a line in `FORK.md` next to the existing coupling
note saying the two directories move together.

---

## 7. What holds up

Not everything is a finding. These were checked and are correct as documented:

| Claim | Verdict |
| --- | --- |
| A foreground `Agent` result is bounded by `compaction-guard` | **Holds.** `agent-session.js:243-248` emits `tool_result` from the generic `afterToolCall`, so extension tools are covered. |
| There is no generic hook on the background delivery path | **Holds.** `sendCustomMessage` → `steer()`/`followUp()` emits no `tool_result`; `result-cap.ts` is the right place. |
| The judge has no tools on the wire | **Holds.** PROVEN: `resolveSessionAllowedTools` returns `[]` because `tools: false` comes from `getAgentConfig`, not `getConfig`. |
| `verifyPhase` keeps a verifying row visible | **Holds.** `agent-widget.ts:506`. |
| `details.background = true` fixes the false success tick | **Holds.** `tool-execution.ts:255`, `renderer.ts:115-116`. |
| B1's `ReferenceError` repair | **Holds.** `getPiInstance()` is set at factory time; `spawnCtx` is set by the coordinator at `spawn-coordinator.ts:92` for both the tool path and the menu wizard. |
| `compaction-guard` is safe inside a child | **Holds.** Its only module state is `spillDir`. |
| `rtk-pi` is safe inside a child | **Holds.** No module state. |
| `max_turns` is unreachable from the model | **Holds.** Not in the registered schema (`registration.ts:38-52`); `model`/`thinking` are injected by the `tool_call` listener instead. |
| The prinny denial is keyed on path for the stated reason | **Holds.** All three vendor entries reduce to the name `index`. |
| The verifier's parse order and fail-open policy | **Holds.** `verify.ts:145-157`. |

Both test suites pass on the current tree: `vendor/pi-loop-mode` 52/52,
`vendor/pi-subagents-lite` 81/81. That is worth stating plainly next to the
findings above: **none of F1–F11 is caught by any existing test**, and three of
them (F1, F2, F3) are in code paths that a test could reach cheaply. The gap is
not test *quality*, it is that every test in both packages exercises one module
in isolation, and all three of those bugs live in the wiring between two.

---

## 8. Findings, ranked

| # | Finding | Sev | Evidence | Status |
| --- | --- | --- | --- | --- |
| **F1** | The operator's loop runs inside every subagent (11 of 13 handlers unguarded): system-prompt injection, agent_end ladder, loop turn delivered to the child, compaction hijack, shared repetition/abort/tool state, goal-check execution | **critical** | PROVEN ×4, SOURCE ×7 | **fixed** (guards); per-session state left open — §10 |
| **F2** | `extensions: false` / `skills: false` never reach the loader for the hidden `__verifier`; B5 is unfixed and F1 fires on the judge | **high** | PROVEN | **fixed** |
| **F3** | Effective concurrency is 4, not the 1 the fork argues for; `DEFAULT_CONCURRENCY_LIMIT` is dead code | **high** | PROVEN | **fixed** |
| **F4** | The verification window is uninterruptible by Esc, `StopAgent` and the watchdog alike; the judge gets no abort signal | **high** | SOURCE | **fixed** |
| **F9** | A reload while any subagent is in flight permanently mis-brands the operator's loop instance and strips the parent's subagent tools | **medium** | REASONED | **fixed** |
| **F5** | A steered continuation is judged against the original brief, and the repair discards the steer | **medium** | SOURCE | **fixed** |
| **F7** | Judge and repair tokens/cost are tallied nowhere; the repair turn also runs with the anchor off | **medium** | SOURCE | **fixed** |
| **F6** | A stale verdict badge survives an unverified continuation | **low** | SOURCE | **fixed** |
| **F8** | An errored run is judged (B8) and the judged text is then discarded by the foreground handler | **low** | SOURCE | **fixed** |
| **F10** | The `loop` tool truncates a `--check` command containing a double quote | **low** | SOURCE | **fixed** |
| **F11** | `result-cap.ts` hard-codes a four-level relative path into `.pi/extensions/` | info | SOURCE | **documented** |

### Corrections to `subagents-loop-verifier-anatomy.md`

- **§5 and `FORK.md` §2** — "Here it is **1**" is false at runtime. It is 4.
- **§9 B5** — recorded as **FIXED**; it is not fixed, and the specific cost it
  claims to have removed (rtk's subprocess per judge call) is still being paid.
- **§9 B4** — recorded as fixed with the exposure "not the sharing" remaining.
  The framing understates it: the destructive path was *not* removed, it was
  narrowed from thirteen handlers to eleven, and `agent_end` is a more
  destructive path than `session_start` was.
- **§11 verification table** — the row "Extensions reach the child; `vendor/`
  does not" is right about discovery and wrong as a safety claim: `vendor/` is
  put back explicitly, which is how F1 reaches the child.

---

## 9. Reproducing this

Both probes are plain node against the real modules. No stack, no model, no
running pi.

**F1 — the loop leaks into a subagent.** Save as `leak-probe.ts`, run with
`node --experimental-strip-types leak-probe.ts` from `vendor/pi-loop-mode`.

```ts
import ext from "<repo>/vendor/pi-loop-mode/extensions/index.ts";
const DEPTH = "__PI_SUBAGENT_SPAWN_DEPTH__";

function makeHost(label) {
  const h = new Map(), notices = [], sent = []; let cmd;
  const pi = {
    on: (n, f) => h.set(n, [...(h.get(n) ?? []), f]),
    registerCommand: (_n, c) => { cmd = c.handler; },
    registerTool() {}, appendEntry() {},
    sendMessage: (m) => sent.push(m),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    setModel: async () => true,
  };
  const ctx = {
    cwd: process.cwd(), mode: "tui", hasUI: true,
    ui: { notify: (m) => notices.push(`[${label}] ${m}`), setStatus() {} },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32768 },
    isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 4000, contextWindow: 32768, percent: 12 }),
    compact() {}, abort() {}, waitForIdle: async () => {},
  };
  return { pi, ctx, notices, sent,
    fire: async (n, e = {}) => { const o = []; for (const f of h.get(n) ?? []) o.push(await f(e, ctx)); return o; },
    run: async (a) => { notices.length = 0; await cmd(a, ctx); return notices.join("\n"); } };
}

const operator = makeHost("operator"); ext(operator.pi);
const child = makeHost("child");
globalThis[DEPTH] = 1; try { ext(child.pi); } finally { globalThis[DEPTH] = 0; }

await operator.run("start refactor the parser. Done when: tests pass");

// 1. system-prompt injection
console.log(await child.fire("before_agent_start", { systemPrompt: "<<CHILD>>" }));

// 2. the child drives the operator's ladder and receives its loop turn
await child.fire("agent_end", { messages: [{ role: "assistant",
  content: [{ type: "text", text: "child answer" }], stopReason: "stop", usage: { output: 12 } }] });
console.log(child.sent, operator.sent, await operator.run("status"));

// 3. the child's compaction is replaced by the operator's handoff
console.log(await child.fire("session_before_compact", { reason: "threshold",
  preparation: { firstKeptEntryId: "child-42", tokensBefore: 26000,
                 fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
  branchEntries: [] }));
```

**F2 and F3 — the config probes.** These need pi's own `jiti` because the
packages use `.js` specifiers for `.ts` files. Run with plain `node`:

```js
import { createJiti } from
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti(
  "file:///usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
  { interopDefault: true, alias: { "@earendil-works/pi-coding-agent":
      "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js" } });

// F2
const t = await jiti.import("<repo>/vendor/pi-subagents-lite/src/agents/agent-types.ts");
t.registerAgents(new Map(), {});
console.log(t.getAgentConfig("__verifier").extensions);   // false
console.log(t.getConfig("__verifier", true, true).extensions);  // true  ← the bug

// F3
const io = await jiti.import("<repo>/vendor/pi-subagents-lite/src/config/config-io.ts");
const s  = await jiti.import("<repo>/vendor/pi-subagents-lite/src/config/config-store.ts");
const store = new s.ConfigStore(); store.reload();
const m = await jiti.import("<repo>/vendor/pi-subagents-lite/src/agents/agent-manager.ts");
console.log(new m.AgentManager(undefined, store.concurrency)["getSlot"]("forge/qwen3.8-27b"));
// { limit: 4, running: 0 }   ← not 1
```

---

## 10. What shipped, and the one thing that did not

Applied in the order below, each with lint + both suites green after it, and each
guard control-run with the fix disabled to confirm the tests fail without it.

| # | Fix | Where | Test |
| --- | --- | --- | --- |
| F3 | The number lives once, in `config-io.ts`; the manager reads it | `config/config-io.ts`, `agents/agent-manager.ts` | probe through the real wiring now reports `{ limit: 1 }` |
| F2 | The agent's own `extensions`/`skills` declaration wins over `getConfig()`'s | `agents/declared-resources.ts` (new), `agent-runner.ts` | `tests/declared-resources.test.ts`, 5 cases incl. the visible-agent no-op control |
| F9 | Spawn bracket narrowed to `reloadAndMap()` → `bindExtensions()` | `agent-runner.ts` (`buildSubagentSession`) | covered indirectly; no test constructs a reload |
| F1 | A subagent instance registers nothing; `pi-loop-mode` no longer handed to a child | `pi-loop-mode/extensions/index.ts`, `subagent-denylist.ts` | `tests/subagent-isolation.test.ts` rewritten — 9 assertions, 8 fail under the control |
| F4 | Per-call deadline on judge and repair, surfacing as `errored` | `verify-runner.ts`, `agent-manager.ts` (`startDeadline`) | `resolveVerifyTimeoutMs` + two "never answers" cases |
| F7 | `stats.verifyUsage` for the judge; tracking callbacks on the repair; `tallyCompletion` adds both | `agent-manager.ts`, `types.ts`, `usage.ts` | — |
| F5 | `appendFollowUp()` extends the brief on a continuation, bounded, original preserved | `verify.ts`, `agent-manager.ts` | 7 cases incl. 500 steers staying under budget |
| F6 | `record.verification` cleared with `record.result` | `agent-manager.ts` | — |
| F8 | `error` joins the statuses not worth a judge | `verify.ts` | 1 case |
| F10 | `--check` consumes escape pairs; `\"`/`\\` unescaped, other backslashes left alone | `pi-loop-mode/src/arguments.ts` | 4 cases, control-run against the old pattern |
| F11 | Documented as a two-directories-move-together coupling | `FORK.md` | — |

Suites after: `pi-subagents-lite` 100 (was 81), `pi-loop-mode` 63 (was 52),
`compaction-guard` 39 (unchanged), lint clean in all three.

### Not done: per-session loop state

The deep half of F1 — `state` keyed by session instead of by module — is
deliberately still open, and this is the decision, not an oversight.

It is **~450 references to the shared state across 1,846 lines**, plus 18 helper
functions (`clearPendingTimer`, `detectStuck`, `logIteration`, `applyGoalConfig`,
`loopInstructions`, …) that currently take neither `pi` nor `ctx` and would need
one threaded in. Both available shapes cost something real:

- **A closure around the whole file** (move the state and its ~31 dependent
  helpers inside `export default function (pi)`) is the smallest logical change
  and an ~800-line reindentation. This is a *fork* of `pi-loop-mode@2.5.4` and
  `FORK.md` tracks divergence line by line; a reindent of that size ends the
  ability to diff against upstream.
- **Threading a session handle** (`stateFor(pi)`) preserves diffability but
  touches every one of those 450 references and 18 signatures.

Against that: **there is no live bug left**. The guard makes the package inert in
a child and `subagent-denylist.ts` no longer loads it there, so nothing shares
the state today. What the refactor buys is a *feature* — a bounded loop running
inside a subagent, in a window that is not the operator's — which is what the
extension list originally wanted and which has never actually worked, because
every version of it destroyed the operator's loop.

So it is a scope call rather than a repair, and it is yours: if the child-loop
feature is wanted, the threading shape is the one to take and it is a day of
careful mechanical work with the isolation suite as the safety net. If it is not
wanted, delete the intent from `subagent-denylist.ts`'s comment and the guard
becomes permanent.

## 11. Suggested order of work

*(This was the plan; §10 records what was actually done against it.)*

Ordered by (damage prevented) ÷ (risk of the change), not by severity alone.

1. **F3** — one line in `config-io.ts`, no behaviour to reason about, restores a
   property the rest of the stack's tuning assumes. Do it first.
2. **F2** — read `agentConfig` for `extensions`/`skills` in
   `createResourceLoader`. Small, and it removes one of the three per-delegation
   firings of F1 for free.
3. **F1, narrow** — guard the eleven handlers. Extend
   `tests/subagent-isolation.test.ts`, which already has the two-instance
   harness; assert on `before_agent_start` returning an unmodified prompt and on
   `agent_end` sending nothing through the child's `pi`. Run the control (guard
   disabled → test fails) as that file's existing tests already do.
4. **F4** — a deadline on the judge, surfacing as the existing `errored` verdict.
5. **F9** — narrow the `enterSubagentSpawn()` bracket to session construction.
6. **F5, F6, F7, F8** — the four small verifier-boundary repairs, together, with
   one test each.
7. **F1, correct** — per-session loop state behind a `WeakMap<ExtensionAPI,
   LoopState>`. This is the only item that is a real refactor, and it is the
   only one that makes a subagent-hosted loop safe rather than merely inert.
8. **F10, F11** — cleanup.

Do not do 7 before 3–6. Every one of those is independently valuable and none of
them depends on it.
