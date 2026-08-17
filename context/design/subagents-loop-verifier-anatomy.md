# Subagents, the loop, and the verifier — a complete anatomy

**Written 2026-08-17, against the tree as it stands.** Everything here was read
out of the source or measured against a running stack; where a claim is inferred
rather than observed it says so. Line references are to this checkout.

This is the document to read before changing any of it. It covers what the three
pieces are, how a delegated task actually flows through them, what each one
costs, where they touch each other, and eight defects found while writing it —
six fixed here, two left alone deliberately with the reasoning attached.

> **Corrected 2026-08-17 by a second audit.** Three claims below were wrong at
> runtime and are marked inline where they appear: the concurrency default (§5),
> the B5 fix (§9), and the completeness of the B4 fix (§9). Eleven further
> defects were found, ten of them since fixed. Read
> `context/design/subagents-loop-verifier-evaluation.md` alongside this — it has
> the reproductions, and this document was not rewritten around them because the
> design account here is still accurate and the disagreement is worth seeing.

Companion documents, not repeated here:

| For | Read |
| --- | --- |
| The second audit, its eleven findings, and the corrections to this document | `context/design/subagents-loop-verifier-evaluation.md` |
| Why this package out of 341, and the wire measurements | `vendor/pi-subagents-lite/FORK.md` |
| Why the loop was forked, and the three failures it fixes | `vendor/pi-loop-mode/FORK.md` |
| Decision-by-decision history | `context/design/decisions.md` (2026-08-17 entries) |
| How to exercise it by hand | `context/testing/subagents-loop-verifier.md` |

---

## 1. The three pieces, and why they exist on this stack

| Piece | Lives in | One sentence |
| --- | --- | --- |
| **Subagents** | `vendor/pi-subagents-lite/` (fork of `pi-subagents-lite@1.11.0`) | Lets the model hand a self-contained job to a child session with its own context window, and get one answer back. |
| **The loop** | `vendor/pi-loop-mode/` (fork of `pi-loop-mode@2.5.4`) | Drives a session toward a goal across many turns, with its own stuck-detection, context recovery and stopping rules. |
| **The verifier** | `vendor/pi-subagents-lite/src/agents/verify*.ts` (written here) | Checks a subagent's answer against the task it was given before the parent ever sees it, and repairs it if it does not. |

Everything about their design is downstream of one constraint: **one llama slot,
one 27B model, a 32,768-token window.** There is no parallelism to win, the
prompt cache is a shared resource, and every character of tool schema is charged
on every turn. That is why subagents run in-process rather than as child `pi -p`
processes, why concurrency defaults to 1, why the tools have no descriptions, and
why the verifier's cheapest layers run first.

---

## 2. The pipeline, end to end

```
 OPERATOR SESSION ── one llama slot ── 32,768-token window
 ═══════════════════════════════════════════════════════════════════════════════

   model emits a tool call
   ┌──────────────────────────────────────────────────────────────┐
   │ Agent { prompt, description?, agent?, run_in_background?,    │  357 chars
   │         worktree_path? }                                      │  of schema
   └───────────────┬──────────────────────────────────────────────┘
                   │
                   │  tool_call listener (tool-execution.ts:321)
                   │  injects model + thinking level into the args
                   │  — never sent to the model, only used locally
                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ executeAgentTool                                              │
   │   · validate worktree_path, gate cross-repo trust             │
   │   · resolve agent type (rescan .pi/agents on a miss)          │
   │   · maxTurns = param ?? frontmatter ?? store default (40)     │
   └───────────────┬──────────────────────────────────────────────┘
                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ SpawnCoordinator.spawn                                        │
   │   · build the live view (widget's activity feed)              │
   │   · record.execution.spawnCtx = ctx   ← kept for later        │
   └───────────────┬──────────────────────────────────────────────┘
                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ AgentManager.spawn                                            │
   │   slot = concurrency for "provider/model"   (default 1)       │
   │   ├── slot free  → status "running", start now                │
   │   └── slot full  → status "queued", push to this.queue        │
   │   record.execution.promise = completion gate (opened once)    │
   └───────────────┬──────────────────────────────────────────────┘
                   ▼
 ╔═══════════════════ CHILD SESSION (in the same process) ═══════════════════╗
 ║  createAgentSession — its own 32k window, its own message history         ║
 ║                                                                           ║
 ║   system prompt   = agent frontmatter (default: replace, not inherit)     ║
 ║   tools           = resolveSessionAllowedTools(...)                       ║
 ║   extensions      = DISCOVERED, not inherited (see §4)                    ║
 ║   turn ceiling    = 40, then a steer, then a hard abort                   ║
 ║   watchdog        = idle / stuck-tool timers, manager-driven              ║
 ║                                                                           ║
 ║   ┌── turn ─┬── turn ─┬── turn ─┬ … ┬── turn 40 ──┐                       ║
 ║   │ tools   │ tools   │ compact │   │ "wrap up"   │                       ║
 ║   └─────────┴─────────┴────┬────┴───┴──────┬──────┘                       ║
 ║                            │               │                              ║
 ║              compaction_end│               │+ graceTurns → session.abort() ║
 ║                            ▼                                              ║
 ║                    ANCHOR: restate the brief into the fresh context       ║
 ╚═══════════════════════════════╤═══════════════════════════════════════════╝
                                 │  run promise settles
                                 ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ settlement chain  (.then → .catch → .finally)                 │
   │   1. status  = aborted|error|turn_limited|completed           │
   │   2. result  = responseText                                   │
   │   3. VERIFY  ◄── judge, repair, re-judge   (§6)               │
   │   4. completedAt = now                                        │
   │   … .finally: settlementCount++, release slot, drain queue,   │
   │               tally, open the gate                            │
   └───────────────┬──────────────────────────────────────────────┘
                   │
        ┌──────────┴───────────┐
        ▼                      ▼
  FOREGROUND              BACKGROUND
  tool result             pi.sendMessage({customType:"subagent-result"},
  │                                      {deliverAs, triggerTurn:true})
  │                       │
  │                       └── capBackgroundResult() bounds it against the
  │                           parent's REMAINING window, spills the rest
  │                           to /tmp/pi-subagent-result-*/…
  ▼                       ▼
  compaction-guard        (no tool_result hook exists on this path —
  bounds it via              that is why the cap lives in the fork)
  pi.on("tool_result")
        │                      │
        └──────────┬───────────┘
                   ▼
          the parent's context
```

### The two delivery paths are not symmetric, and that asymmetry is the point

A **foreground** subagent blocks the parent's tool call. Its result is an
ordinary tool result, so `.pi/extensions/compaction-guard` bounds it like every
other tool result — that extension keys off `toolName`, not a list of builtins,
so an extension-registered tool is covered for free.

A **background** subagent is delivered with `pi.sendMessage(...)`, which pi turns
into a `role: "custom"` message handed straight to `agent.steer()` /
`followUp()`. Verified against pi 0.84.2's own source: that path emits no
`input` event, no `tool_result`, and on the `triggerTurn` branches no
`message_start`/`message_end` either. **There is no generic hook an extension
could have used**, which is why `src/spawn/result-cap.ts` exists and bounds the
payload at the source instead.

---

## 3. The record's life

Every subagent is one `AgentRecord`. The states are not decoration — the widget,
the watchdog, the queue and the verifier all key off them.

```
                    spawn()
                       │
          slot full ┌──┴──┐ slot free
                    ▼     ▼
                ┌────────┐   ┌─────────┐
                │ queued │──▶│ running │◀── continueSettledAgent()
                └───┬────┘   └────┬────┘        (steer a settled agent)
                    │             │
       stopAgent()  │             │ run promise settles
       (never       │             │
        started)    │             ▼
                    │   ┌────────────────────────────────┐
                    │   │ status set: completed |         │
                    │   │   turn_limited | aborted |      │
                    │   │   error   (stopped wins if the  │
                    │   │   agent was stopped externally) │
                    │   └────────────┬───────────────────┘
                    │                │
                    │                ▼
                    │   ┌────────────────────────────────┐
                    │   │  ★ VERIFICATION WINDOW ★       │
                    │   │  status: already terminal       │
                    │   │  completedAt: NOT YET SET       │
                    │   │  verifyPhase: judging|repairing │
                    │   └────────────┬───────────────────┘
                    │                │
                    ▼                ▼
                ┌──────────────────────────┐
                │ completedAt = now        │  ← the widget's "finished" test
                └──────────┬───────────────┘
                           ▼
                     .finally: slot released, queue drained,
                     cost tallied, completion gate opened
```

**The starred window is load-bearing and was invisible until this session.**
`AgentWidget.categorizeAgents()` sorts on exactly two fields — `status` and
`completedAt` — so for the whole length of a judge call (and a repair, which is
a full child turn) a record matched *none* of running, queued or finished, and
its row was removed from the widget and then re-added. The `verifyPhase` field
now keeps it in the active set. Confirmed by rendering the real
`agent-widget.ts` against a fabricated record in that state: before the fix it
returned zero lines.

---

## 4. What a child inherits, and what it does not

This is the part most often assumed wrong. A child does **not** inherit the
parent's `-e` flags: it builds its own `DefaultResourceLoader`, which
*discovers* extensions.

```
   parent loads by -e:            child discovers:
   ┌───────────────────────┐      ┌───────────────────────────┐
   │ vendor/pi-subagents…  │      │ .pi/extensions/*          │ ✔ compaction-guard
   │ vendor/pi-loop-mode   │  ✘   │ ~/.pi/agent/extensions/*  │ ✔
   │ vendor/rtk-pi         │  ✘   │ <project>/.pi/extensions  │ ✔ (if trusted)
   │ vendor/prinny-channel │  ✘   └───────────────────────────┘
   └───────────────────────┘                  +
                                   additionalExtensionPaths:
                                   ┌───────────────────────────┐
                                   │ vendor/pi-loop-mode       │ ← put back
                                   │ vendor/rtk-pi             │ ← put back
                                   └───────────────────────────┘
                                   minus the unconditional denial:
                                   ┌───────────────────────────┐
                                   │ */vendor/prinny-channel/* │ ✘ always
                                   │ skills prinny-access,     │ ✘ always
                                   │        prinny-configure   │
                                   └───────────────────────────┘
```

| Thing | In a child? | Why |
| --- | --- | --- |
| `compaction-guard` | **yes**, by discovery | A child that blows its own window returns nothing. Observed capping a child's own `read` at 9,778 → 8,176 chars. |
| forge's proxy patches | **yes** | Same provider, same base URL — the reasoning passthrough and real `finish_reason` apply to child turns too. |
| `rtk` | **put back** deliberately | A child running `bash` uncompressed is the session that can least afford it. |
| `/loop` | **put back** deliberately | A bounded loop belongs in a window that is not the operator's. |
| `prinny` + its skills | **denied, unconditionally** | The model spawns subagents on its own initiative; they do not get to post to Matrix. Denial is keyed on **path**, because `extractExtensionName()` returns `index` for all three vendor packages and the package-name resolver returns undefined for prinny's manifest shape. |
| the `Agent` tool itself | **no** | The extension factory returns early inside a spawn (`isInsideSubagentSpawn()`), so no recursive subagents. |

**The denial composes rather than replaces**: an agent file can still narrow its
own extensions, it just cannot widen them back to include a denied one.
`SUBAGENT_EXTRA_EXTENSIONS` replaces the put-back list entirely and is filtered
by the same denial.

### The sharp edge underneath all of this

Children run **in the parent's process**. Node's module cache means an extension
loaded by both parent and child is *the same module object*, with the same
module-level state. That is not a theory — it is the mechanism
`isInsideSubagentSpawn()` relies on, and it is why bug **B4** below was possible.

```
                 ONE NODE PROCESS
   ┌──────────────────────────────────────────────────────┐
   │  module cache: vendor/pi-loop-mode/extensions/index  │
   │  ┌────────────────────────────────────────────────┐  │
   │  │  let state       ← ONE object                  │  │
   │  │  let pendingTimer← ONE timer handle            │  │
   │  │  let runToken    ← ONE counter                 │  │
   │  └───────▲───────────────────────▲────────────────┘  │
   │          │                       │                   │
   │   parent's pi                child's pi              │
   │   (handlers on the           (handlers on the        │
   │    operator session)          subagent session)      │
   └──────────────────────────────────────────────────────┘
```

`compaction-guard` is safe here — its only module state is a temp-dir path.
`rtk-pi` is safe — it has none. `pi-loop-mode` keeps an entire state machine in
module scope.

---

## 5. Concurrency, the queue, and why the default is 1

```
  spawn("forge/qwen3.8-27b")
        │
        ▼
  getSlot(modelKey)  ── per-model slot ─▶ per-provider slot ─▶ default
        │
   running >= limit ?
        ├── yes → queue.push(...)   status "queued"
        └── no  → slot.running++    status "running"
                                        │
                         settlement .finally: slot.running--
                                        │
                                   drainQueue() → start the next queued agent
```

> **Correction (evaluation F3).** "Here it is 1" was false when this was written.
> The constant lived in `agent-manager.ts` behind a `??` that never fired,
> because the config store always supplies a `default` — so every session ran at
> **4**, measured through the real wiring. The number now lives only in
> `config/config-io.ts` and the manager reads it from there.

Upstream's default is 4. Here it is **1**, and the reasoning was measured rather
than assumed: a child having its own system prompt does *not* by itself evict the
parent's cached prefix — the parent held a 99.2% cache hit across six small child
turns. What evicts it is **size**: a child that grew to 18k tokens took the
parent's next call from 2,117 cached tokens to zero, and from 442 ms to 2,949 ms.
Serialising children means at most one foreign prefix competes at a time.

---

## 6. The verifier

### The problem it exists for

A child gets a brief it cannot see the context for, works in its own window, and
when that window fills pi compacts it and it carries on from a summary. pi merges
each summary into the previous one under a *"PRESERVE all existing information"*
prompt, so summaries **grow** — 456 → 4,029 → 11,054 chars across 42 real
compactions — and what they erode first is the oldest thing in the transcript,
which is the brief. Nothing downstream notices: the parent sees only the final
text.

### Three layers, cheapest first

```
  answer settles
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │ LAYER 1 — the anchor          (no model call)           │
  │ fires on every compaction_end, not at the end:          │
  │ steer the brief back into the freshly-summarised context │
  │ ~50 tokens. Prevention, not detection.                   │
  └─────────────────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │ LAYER 2 — the structural gate (no model call)           │
  │   empty answer          → skipped-empty   (replace text)│
  │   aborted/turn_limited/ → skipped-cutoff  (status note  │
  │   stopped                                  already says)│
  │   no brief recorded     → skipped-nobrief (our own bug) │
  └─────────────────────────────────────────────────────────┘
        │  non-empty answer from a clean run — the only case
        │  where drift is invisible
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │ LAYER 3 — the judge, then a bounded repair loop          │
  └─────────────────────────────────────────────────────────┘
```

### The ladder, with the round budget

```
   candidate := the child's answer          attempts := 0
        │
        ├──────────────────────────────────────────────┐
        ▼                                              │
   ┌─────────────────────────────────────┐             │
   │ JUDGE   (fresh __verifier agent,    │             │
   │          no tools, no history,      │             │
   │          one turn, sees only TASK   │             │
   │          and ANSWER)                │             │
   └────┬─────────────┬──────────────┬───┘             │
        │             │              │                 │
   unparsed      ADDRESSED     NOT_ADDRESSED           │
        │             │              │                 │
        ▼             ▼              ▼                 │
   fail OPEN     attempts==0 ?   attempts >= rounds ?  │
   "unchecked"   ├ yes → passed  ├ yes → failed        │
                 └ no  → repaired│       (return the   │
                                 │        ORIGINAL)    │
                                 └ no ────┐            │
                                          ▼            │
                              ┌───────────────────────┐│
                              │ REPAIR                ││
                              │ continue the CHILD's  ││
                              │ own session, brief    ││
                              │ restated in full      ││
                              └───┬───────┬───────┬───┘│
                                  │       │       │    │
                              empty   same as   new    │
                                  │   before    text   │
                                  ▼       ▼       └────┘
                              failed   failed
                                     (stalled)
```

**Cost:** `1 + 2 × attempts` model calls, all on the slot the parent is blocked
on. Default `SUBAGENT_VERIFY_ROUNDS=1`, clamped to `[0, 3]`. A passing answer
costs exactly one call.

**Why the judge is not the child.** Asking the child to review its own work is
the weakest check available: every step that led it astray is in its context with
a justification attached, and a model handed its own reasoning ratifies it. The
judge is a fresh agent that knows *less* — only the task and the answer. The
repair goes the other way and continues the child's session, because that is the
only place with the context to fix anything.

**Why the verdict is asked for before the reasoning.** `VERDICT:` then `WHY:`. A
local model allowed to reason first argues itself into agreement by the time it
reaches the verdict.

**Why the parse checks `NOT_ADDRESSED` first.** One string contains the other.
The wrong order turns every failure into a silent pass, forever.

**Why the original answer wins when everything fails.** It is what the parent
would have received with the verifier switched off. The alternative ships text
written by a child that has just been told twice it was wrong — in practice
shorter, more apologetic, and no better addressed.

**What it cannot do:** catch subtly wrong work. The judge is the same 27B that
wrote the answer. It is a drift check, not a correctness proof.

### What the operator sees

| Verdict | Marker | Tone |
| --- | --- | --- |
| `passed` | `✓ checked` | dim — the common case must not train the eye to skip the column |
| `repaired` | `✎ repaired` | warning |
| `failed` | `✗ off-task` | error |
| `unparsed` | `? unreadable verdict` | warning |
| `errored` | `? check errored` | warning |
| `skipped-empty` | `⊘ empty answer` | warning |
| `skipped-cutoff` | `⊘ unchecked (cut off)` | dim |
| `skipped-nobrief` | `⊘ unchecked (no task)` | dim |
| never ran | *nothing* | absence is the signal |

Painted in five places from one table (`src/ui/verification-badge.ts`): the
widget's finished line, the foreground tool result, the background
subagent-result card, the conversation viewer's header, and the `/agents` list.

---

## 7. The loop

### The iteration cycle

```
   /loop start "<goal>. Done when: <criteria>"   —or—   loop tool {action:"start"}
        │
        ▼
   runLoop() ──▶ sendLoopTurn("start")
        │
        ▼
   ╔═══════════════════ one iteration ═══════════════════╗
   ║  before_agent_start: append the goal + the rules     ║
   ║      (≤1,200 chars/response, one batch per turn,     ║
   ║       never wait for a human, never dump logs)       ║
   ║                                                      ║
   ║  … the model works: tools, edits, output …           ║
   ║                                                      ║
   ║  context handler: above 60% full, append an          ║
   ║      ephemeral budget line (cloned away before it    ║
   ║      reaches the session — ~40 tokens/turn)          ║
   ╚══════════════════════════╤═══════════════════════════╝
                              ▼
                        agent_end ladder
     ┌────────────────────────┴──────────────────────────────┐
     │ 1. soft stop requested?      → finalize, stop          │
     │ 2. context pressure?         → defer to agent_settled  │
     │      (empty turn ≥80% full counts as pressure,         │
     │       NOT as fixation)                                 │
     │ 3. model/provider error?     → exponential backoff     │
     │ 4. degenerate repetition?    → stuck intervention      │
     │ 5. operator abort (Esc)?     → pause, keep state       │
     │ 6. goal check / LOOP_DONE?   → maybe finish            │
     │ 7. stuck (no tools, repeats,                           │
     │    no state change)?         → the stuck ladder        │
     │ 8. otherwise                 → schedule the next turn  │
     └────────────────────────┬──────────────────────────────┘
                              ▼
                    scheduleLoopTurn(delay)  ──▶ back to the top
```

### Context recovery — the part that was broken upstream

pi runs its own overflow handling in `_handlePostAgentRun()`, **after** the
`agent_end` extension event and **before** the run settles. Upstream compacted
from `agent_end`, so both compactions were in flight at once; pi's landed first,
and `prepareCompaction()` refuses a branch that already ends in a compaction
entry — *"Already compacted"* — which upstream treated as terminal. An
unattended loop then needed a human to type `/compact`, which is the one thing an
unattended loop cannot ask for.

The fork defers compaction to `agent_settled`, adopts pi's recovery when pi says
it will retry (with a 45 s watchdog in case that retry never materialises), and
treats *"Already compacted"* / *"Nothing to compact"* as success. Three failed
recoveries now cool down (60 s → 120 s → 240 s) instead of stopping.

### Handoff instead of compaction on a small window

On any window ≤ 64k the loop builds its **own** summary, bounded at 4,000 chars —
the same size on iteration 400 as on iteration 4 — and cuts at the start of the
last turn rather than at pi's 20,000-token tail. Measured against six real
compaction points of one 24-compaction session:

| compaction | pi kept | handoff keeps |
| --- | --- | --- |
| @48 | 68,778 chars | 374 |
| @102 | 123,083 chars | 1,560 |
| @135 | 121,320 chars | 1,707 |
| @150 | 102,697 chars | 2,754 |

### The 87% cliff, which is why all of this matters

From eight real sessions: below 87% of the window, 3 assistant turns out of 196
came back empty. At or above 87%, **33 of 63** did — `content: []`,
`stopReason: "stop"`, one output token. An empty turn still burns an iteration,
and the loop's own stuck ladder used to answer it by *adding prompt text*, which
is the thing that caused the problem. `isContextPressure()` now routes a starved
turn to recovery instead, and the stuck ladder skips its prompt rungs above 80%.

### The loop as a tool

Upstream exposes loop control only as `/loop`; a model cannot type a slash
command. The fork lifts the command body into `loopCommand(args, ctx, opts)` and
registers a `loop` tool over the same code path — **709 chars, ~177 tokens per
turn**, measured on the wire. Three non-obvious requirements: the tool must hand
back the text the command only `notify()`d to the operator (captured through a
`Proxy`, not a spread — the context is a live object whose methods need their own
`this`); `stop` must not abort the turn that is executing the tool
(`suppressAbort`); and registration must be guarded, because a host without
`registerTool` would otherwise lose the whole extension.

---

## 8. What all of it costs on the wire

```
  baseline (no extensions)                    2,900 chars
  + Agent 357 · StopAgent 193 · AgentStatus 157  710 chars   ~178 tok/turn
  + loop                                         709 chars   ~177 tok/turn
                                              ─────────────
  total standing tool schema                   ~1,419 chars  ~355 tok/turn
                                                = ~1.1% of a 32k window
```

Everything else is pay-per-use: a judged answer costs one small model call, a
repair costs two, an anchor costs ~50 tokens per compaction, and the loop's
budget notice costs ~40 tokens per turn above 60% full. The `__verifier` agent
type is `hidden`, so it stays out of the `Agent` tool's enum — without that flag
the tool grows 357 → 368 chars and the model is offered an internal type it has
no reason to call.

---

## 9. Defects found while writing this

Six fixed in this pass, two left with reasoning. Every one was found by reading,
and each is reproducible.

### B1 — `ReferenceError` on continuing a settled agent · **FIXED**

`agent-manager.ts`, `continueSettledAgent()`. The line

```ts
this.attachSettlementChain(record, promise, concurrencySlot, this.buildVerifyDeps(pi, ctx, record));
```

references `pi` and `ctx`, which **do not exist in that scope** — there is no
parameter, no class field, no import of either name. The first-run call site
looks identical but sits inside `startAgent`, which destructures them from
`SpawnArgs`.

*Symptom:* steering or continuing an already-finished agent — the `/agents`
menu's steer action, or the conversation viewer's steer box after the child
finishes — throws `ReferenceError: pi is not defined`. `steer()` is `async`, so
it surfaces as a rejected promise rather than a visible error.

*Why nothing caught it:* the lint gate is `node --check` over type-stripped
source, which is a **syntax** check; there is no `tsc` anywhere in the toolchain,
and no test constructs an `AgentManager`. A free identifier is perfectly valid
syntax.

*Fix:* `getPiInstance()` (a shell singleton) and `record.execution.spawnCtx`
(kept on the record at spawn precisely for later use); when either is missing the
continuation still runs, just unverified.

### B2 — every verified answer leaked an `AgentSession` · **FIXED**

`buildVerifyDeps().judge` calls `runAgent()` directly rather than `spawn()` — it
has to, because verification runs inside the settlement chain while the child's
concurrency slot is still held, and a judge that asked for a slot would deadlock
at `concurrency = 1`. But going around `spawn()` also goes around every teardown
`spawn()` arranges: no `AgentRecord`, so `dispose()` and `clear()` never see the
judge's session. `result.session` was simply dropped.

*Symptom:* one `AgentSession` — with its message history and any bound
extensions — retained per verified answer, for the life of the process. Slow leak;
invisible until a long session.

*Fix:* dispose it in a `finally` once the text is extracted.

### B3 — an unknown `loop` action started an endless loop · **FIXED**

`loopCommand`'s final branch is the `/loop <goal>` convenience: anything it does
not recognise becomes a **goal**. Correct for a human typing a command; a trap
for a model guessing a verb. `loop(action: "pause")` started an endless loop
whose goal was the word *"pause"* — and endless is the default mode.

*Why nothing caught it:* there was a test named *"survives an unknown action
rather than throwing into the turn"* which asserted only that a string came
back. It passed **because** of the bug.

*Fix:* a closed action set checked before `loopCommand` is reached; the test now
asserts nothing was started.

### B4 — spawning a subagent silently killed the operator's loop · **FIXED**

The one that matters most. Chain of facts, each verified:

1. Subagents run **in the parent's process**, and a child session binds the
   parent's extensions.
2. Node's module cache makes the child's copy of an extension *the same module
   object* — proven by `isInsideSubagentSpawn()` working at all (the child's
   factory reads a counter the parent incremented) and observed live as "the
   child has no `Agent` tool".
3. `pi`'s `bindExtensions()` ends with
   `await this._extensionRunner.emit(this._sessionStartEvent)`
   (`core/agent-session.js:1761`) — so **every subagent session emits
   `session_start`**.
4. `pi-loop-mode`'s `session_start` handler ran, against shared state:
   `clearPendingTimer()` → the operator's next iteration, already scheduled,
   cancelled; `resetContextRecovery()` → its pending recovery marker dropped;
   `restoreState(ctx)` → its loop replaced by the child's branch state, which for
   a subagent (`SessionManager.inMemory`) is empty.

*Symptom:* not an error. A loop that stops advancing the first time the model
delegates anything, with `/loop status` reporting no loop at all — the state was
not paused, it was overwritten. And the verifier makes it worse: the judge is
itself a subagent session, so a *foreground* delegation with verification on
fires the same clobber twice.

*Fix:* `pi-subagents-lite` publishes its spawn depth on
`globalThis.__PI_SUBAGENT_SPAWN_DEPTH__`; `pi-loop-mode` captures it at factory
time and skips `session_start`/`session_shutdown` for an instance born inside a
spawn. A global rather than an import, because vendored packages must not depend
on each other. A child has no persisted loop state to restore anyway, and a loop
started *inside* a child still works — that path goes through the command and
`runLoop()`, not through these handlers.

*Regression test:* `vendor/pi-loop-mode/tests/subagent-isolation.test.ts` loads
the extension twice, exactly as the process does. **Control run performed:** with
the guard disabled the test fails on the assertion that matters and passes on the
other two, so it is testing the fix and not the weather.

*Not fixed, and worth knowing:* the underlying exposure remains — the loop's
state is still module-global, so a loop started inside a subagent writes the same
state the operator's loop uses. The real repair is per-session state, which is a
refactor of every reference in a 1,700-line file. This fix removes the
destructive path, not the sharing.

> **Correction (evaluation F1).** "This fix removes the destructive path" is the
> largest error in this document. `session_start`/`session_shutdown` are 2 of
> **13** handlers; the other 11 were left, and they are worse. Reproduced against
> the real module: `before_agent_start` put the operator's goal and "never stop
> on your own" into the *child's* system prompt; `agent_end` ran the whole
> iteration ladder on the operator's state and delivered its next loop turn
> *into the child*; `session_before_compact` replaced a compacting child's entire
> conversation with the operator's loop handoff summary. The guard is now the
> whole factory — a subagent instance registers nothing — and
> `subagent-denylist.ts` no longer hands `pi-loop-mode` to a child at all. The
> module-global state itself remains, and is the one item deliberately left open.

### B5 — `extensions: false` did not mean no extensions · **FIXED**

The `__verifier` agent is documented as *"no tools, no extensions, no skills,
one turn"*. It had two extensions. pi's loader reads

```js
const extensionPaths = this.noExtensions ? cliEnabledExtensions : this.mergePaths(...)
```

(`core/resource-loader.js:315`) — and `additionalExtensionPaths` **is** the
`cliEnabled` set, so `noExtensions` only suppresses *discovered* paths. The
fork's put-back list (`pi-loop-mode`, `rtk-pi`) was therefore loaded and bound
into every judge session.

*Cost:* `rtk`'s factory runs `rtk --version` as a subprocess on load, so every
judged answer — one per verified delegation, on the slot the parent is waiting on
— paid for a process spawn plus a dozen event-handler registrations it could
never use, and (before B4) triggered the loop clobber.

*Not affected:* the tool schema. `tools: false` makes
`resolveSessionAllowedTools()` return `[]`, so the judge genuinely has no tools
on the wire regardless.

*Fix:* pass `[]` when the agent declares `extensions: false`.

> **Correction (evaluation F2).** The diagnosis above is right and the fix did
> not work. It reads `config.extensions`, and `config` is `getConfig()`'s output
> — which resolves through `findActiveConfig()`, substituting **general-purpose**
> for any agent marked `hidden`. `__verifier` is hidden (for the 11 chars of tool
> schema in §8), so `getConfig("__verifier").extensions` is `true` where the
> agent says `false`, and the `extensions === false` branch was unreachable code.
> Nothing noticed because the *Not affected* paragraph above is exactly right:
> `tools: false` is read from `getAgentConfig` directly and did take effect, so
> the judge really had no tools — the property everyone checked. The agent's own
> declaration now wins (`src/agents/declared-resources.ts`), with a test.

### B6 — a background spawn rendered as a completed one · **FIXED**

`renderer.ts` decided "is this a background spawn?" by looking for the strings
`"running in background"` or `"queued"` in the result text. The message actually
reads `[Agent running] Success! You delegated…`, which contains neither. So the
placeholder branch never fired for a running background agent and the line drew
`✓ <description>` — a green success tick — at the moment the agent *started*,
with no result behind it.

*Fix:* `details.background = true` at the source; the text tests stay as a
fallback for older results.

### B7 — the verifier is outside the watchdog · ~~REPORTED, NOT FIXED~~ **FIXED (see F4)**

`checkWatchdogs()` only considers records whose status is `running`
(`agent-manager.ts:851`), and verification runs *after* the status has gone
terminal. The watchdog's own `check()` then drops the record's state entirely.
So neither the judge nor the repair is covered by any timeout: a hung judge hangs
the parent's `Agent` tool call with nothing to stop it.

This is not hypothetical on this stack — during this session llama-server wedged
badly enough that a direct 8-token completion timed out at 60 s while `/health`
answered instantly.

*Left alone* because the fix is a policy decision, not a repair: either the
watchdog learns about a fourth state, or the judge gets its own deadline. Both
change behaviour under load, and picking one blind is worse than naming it.

### B8 — a model-errored run still pays for a judge · ~~REPORTED, NOT FIXED~~ **FIXED (see F8)**

`structuralVerdict()` marks `aborted`, `turn_limited` and `stopped` as *not worth
judging* — the status note already tells the parent they were cut off — but not
`error`. A run that failed with a provider error and produced partial text is
therefore sent to the judge, spending a model call to be told what
`status-note.ts` already says.

*Left alone* for the same reason as B7: it is a change to what the verifier
means, made under cover of a documentation pass. It belongs in a change that owns
the semantics.

---

## 10. Sharp edges that are not bugs

- **`max_turns` is unreachable from the model.** `executeAgentTool` reads
  `params.max_turns`, but it is not in the registered schema — only agent
  frontmatter and the store default can set it. Deliberate (schema size), and it
  means the model cannot widen its own child's ceiling.
- **`worktree_path` lets the model spawn into another repo.** Validated and
  trust-gated (an untrusted cross-repo target still spawns, with its project
  resources ignored and a warning surfaced), but it is a real surface.
- **`AgentStatus` lists every agent ever spawned this session**, unbounded. Fine
  for a session's worth; it grows.
- **Finished rows leave the widget after `finishedRetentionMinutes` (default 1)**,
  so the keyboard hop cannot reach an agent that finished a few minutes ago.
  `/agents` still can, all session.
- **The judge always reports `turnLimited` internally.** `maxTurns: 1` means
  `wireTurnTracking` fires its soft-limit steer on the judge's only turn. The
  field is never read on that path, so it is cosmetic — but a future reader
  should not conclude the judge ran out of room.
- **The anchor is advisory.** It is a `session.steer()` with a `.catch(() => {})`:
  a session already tearing down is not a reason to fail the run.
- **`aborted` means the turn ceiling, not the user.** A parent interrupt produces
  `stopped`; `aborted` is only the hard abort after `maxTurns + graceTurns`.

---

## 11. Verification status

| Claim | How it stands |
| --- | --- |
| 27B drives the description-free `Agent` schema | **Live.** Sets `run_in_background` on an undescribed boolean, polls `AgentStatus` uninstructed. |
| Tool surface is 710 chars | **Measured** on the wire against a stub model. |
| Background result cap fires and spills | **Live.** 14,218 → 10,495 chars; the parent then read the spill file unprompted. |
| Extensions reach the child; `vendor/` does not | **Live.** Child inventory showed 12 tools, one skill, no prinny, no `Agent`. **Correct about discovery, wrong as a safety claim** (evaluation F1): `vendor/` was put back explicitly, which is how the loop reached the child. |
| `"verification":"passed"` on a real delegation | **Live**, twice — most recently 2026-08-17 with the badge/phase code loaded. |
| The verifier's failure path (judge says no → repair) | **Unit-tested only.** Never fired live; the judge's false-positive rate is unknown. |
| The anchor | **Unit-tested only.** Needs a child that fills 32k and compacts. |
| The 40-turn ceiling and the steer-then-abort ladder | **Untested live.** |
| B1–B6 fixes | **Unit-tested where testable** (B3, B4 with a control run); B1, B2, B5, B6 are read-and-reasoned repairs with no live exercise yet. **B5 did not work** — see the correction in §9 and evaluation F2. |
| Widget/renderer rendering, including the verdict badges | **Rendered** from the real modules under a scratchpad loader; not yet seen in a live TUI. |
| prinny forwarding of a late background result | **Answered from source only:** `forwardToMatrix` returns early without a live `awaitingReply` entry, so a subagent that settles after its Matrix run retired answers into the void. Silence, not a leak. |
