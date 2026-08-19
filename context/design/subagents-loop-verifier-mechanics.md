# Subagents, the loop, and the verifier — the machine, end to end

**Written 2026-08-17 against `72ab4aa` plus the changes this pass made.** Third
pass over the same three pieces. Everything below was read out of this checkout
or out of pi 0.84.2's own `dist/`, and where a claim was proved by running code
the reproduction is named and its output quoted.

It does three things:

1. **Explains the whole machine in one place** — every stage a delegated task
   passes through, what each stage owns, and what it hands on. That is §1–§8.
2. **Reports nine findings (T1–T9)**, three of them proved by executable
   reproductions against the real modules. Four are fixed here. That is §9–§11.
3. **Says what is verified, what is inferred, and what has still never been
   watched running.** That is §12–§13.

## How this sits next to the other two documents

| Document | What it is for | Status |
| --- | --- | --- |
| `subagents-loop-verifier-anatomy.md` | The **design account** — why each piece is shaped the way it is. First audit, defects B1–B8. | Still the right place for *why*. Carries five inline corrections from the second audit; §6's cost table is corrected again here (T1). |
| `subagents-loop-verifier-evaluation.md` | The **second audit** — the seam between the pieces, defects F1–F11, ten fixed. | Findings and reproductions still stand. Re-verified here (§12). |
| **this document** | The **mechanics**, plus a third pass. Findings T1–T9. | Current. |
| `vendor/pi-subagents-lite/FORK.md`, `vendor/pi-loop-mode/FORK.md` | Divergence from upstream, line by line. | — |
| `context/testing/subagents-loop-verifier.md` | How to exercise it by hand. | Section I still never run. |

The one-line version of this pass: **the second audit fixed the seams between
the three packages; the defects left were inside them, and two of the three were
in code that had a comment explaining the correct behaviour above an
implementation that did something else.**

---

## 1. The whole machine, on one page

```
 OPERATOR SESSION ── one llama slot ── 32,768-token window ── PARALLEL_SLOTS=1
 ══════════════════════════════════════════════════════════════════════════════════

  ┌─ the operator's extension graph (loaded by -e) ────────────────────────────┐
  │  vendor/pi-subagents-lite   Agent · StopAgent · AgentStatus · /agents      │
  │  vendor/pi-loop-mode        /loop · loop tool · 13 event handlers          │
  │  vendor/rtk-pi              bash rewriting                                 │
  │  vendor/prinny-channel      Matrix                                         │
  │  .pi/extensions/compaction-guard   summary cap · output cap · budget line  │
  └────────────────────────────────────────────────────────────────────────────┘
                                    │
   the model emits a tool call      │
   ┌────────────────────────────────▼───────────────────────────────────────┐
   │ Agent { prompt, description?, agent?, run_in_background?,              │
   │         worktree_path? }                        281 chars of param JSON│
   └────────────────────────────────┬───────────────────────────────────────┘
                                    │
   pi validates the args ───────────┤  validateToolArguments (agent-loop.js:404)
                                    │  ── BEFORE the hook, which is what makes
   tool_call listener ──────────────┤     the next line legal under
   injects model + thinking         │     additionalProperties:false  (T8)
   into the SAME args object        │
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ executeAgentTool            tool-execution.ts                          │
   │   · validate worktree_path, gate cross-repo trust      (T6)            │
   │   · resolve the agent type, rescanning .pi/agents on a miss            │
   │   · maxTurns = params ?? frontmatter ?? store default                  │
   │   · foreground gets the parent's abort signal; background does not     │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ SpawnCoordinator.spawn      spawn/spawn-coordinator.ts                 │
   │   · build the live view (the widget's activity feed)                   │
   │   · record.execution.spawnCtx = ctx   ← kept for later continuations   │
   │   · foreground: await record.execution.promise (the completion gate)   │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ AgentManager.spawn          agents/agent-manager.ts                    │
   │   slot = concurrency for "provider/model"     (default 1)              │
   │   ├── slot free  → status "running", start now                         │
   │   └── slot full  → status "queued", push to this.queue                 │
   │   record.execution.promise = the completion gate, opened exactly once  │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
 ╔═══════════ CHILD SESSION — same node process, its own 32k window ═════════════╗
 ║                                                                               ║
 ║  buildSubagentSession()   ← enterSubagentSpawn() … exitSubagentSpawn()        ║
 ║    the bracket covers extension LOADING and BINDING only, not the run         ║
 ║    ┌───────────────────────────────────────────────────────────────────┐      ║
 ║    │ reloadAndMap()  → every extension factory runs                    │      ║
 ║    │ bindExtensions()→ handlers registered, session_start emitted      │      ║
 ║    └───────────────────────────────────────────────────────────────────┘      ║
 ║                                                                               ║
 ║  system prompt = agent frontmatter (default: replace, not inherit)            ║
 ║  tools         = resolveSessionAllowedTools(...)                              ║
 ║  extensions    = DISCOVERED, never inherited, plus a put-back list  (§5)      ║
 ║  turn ceiling  = 40, then a wrap-up steer, then a hard abort at +6            ║
 ║  watchdog      = idle / stuck-tool timers, manager-driven, 45 min             ║
 ║                                                                               ║
 ║   ┌── turn ─┬── turn ─┬── compact ─┬ … ┬─ turn 40 ─┬─ turn 41 ─┐              ║
 ║   │ tools   │ tools   │            │   │ "wrap up" │ final     │              ║
 ║   └─────────┴─────────┴─────┬──────┴───┴───────────┴───────────┘              ║
 ║                             │ compaction_end                                  ║
 ║                             ▼                                                 ║
 ║                     ANCHOR: restate the brief into the fresh context          ║
 ╚═════════════════════════════╤═════════════════════════════════════════════════╝
                               │  the run promise settles
                               ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ settlement chain    .then → .catch → .finally                          │
   │   1. status  = stopped | aborted | error | turn_limited | completed    │
   │   2. result  = responseText                                            │
   │   3. VERIFY  ◄── structural gate, judge, repair, re-judge      (§6)    │
   │   4. completedAt = now                                                 │
   │   … .finally: settlementCount++, release the slot, drain the queue,    │
   │               tally cost, detach the interrupt binding, open the gate  │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    │
                ┌───────────────────┴───────────────────┐
                ▼                                       ▼
        FOREGROUND                              BACKGROUND
        an ordinary tool result                 pi.sendMessage(
        │                                         {customType:"subagent-result"},
        │                                         {deliverAs, triggerTurn:true})
        │                                       │
        │                                       └── capBackgroundResult() bounds
        ▼                                           it against the parent's
   compaction-guard bounds it via                   REMAINING window and spills
   pi.on("tool_result") — it keys off               the rest to /tmp/…
   toolName, so an extension tool is
   covered for free                             (no tool_result hook exists on
        │                                        this path — that is why the cap
        └───────────────────┬────────────────────┘ lives in the fork)
                            ▼
                   the parent's context
```

---

## 2. The three pieces, and the constraint that shapes all of them

| Piece | Lives in | One sentence |
| --- | --- | --- |
| **Subagents** | `vendor/pi-subagents-lite/` (fork of `pi-subagents-lite@1.11.0`) | Hands a self-contained job to a child session with its own context window, and returns one answer. |
| **The loop** | `vendor/pi-loop-mode/` (fork of `pi-loop-mode@2.5.4`) | Drives a session toward a goal across many turns, with its own stuck detection, context recovery and stopping rules. |
| **The verifier** | `vendor/pi-subagents-lite/src/agents/verify*.ts` (written here) | Checks a child's answer against the task it was given before the parent sees it, and repairs it if it does not. |

Every design decision below is downstream of one thing: **one llama slot, one
27B model, a 32,768-token window.** There is no parallelism to win, the prompt
cache is a single shared resource, and every character of tool schema is charged
on every turn of every session. That is why subagents run in-process rather than
as child `pi -p` processes, why concurrency defaults to 1, why the tools carry no
descriptions, why the verifier's free checks run before its paid ones, and why a
defect that costs one extra model call per delegation (T1) is worth a fix rather
than a note.

---

## 3. A delegation, stage by stage

### 3.1 The tool call, and the two fields the model never sees

The registered schema has five properties. `model`, `thinking` and
`_modelOverride` are **not** in it — they are injected into the arguments object
by `toolCallListener` on the `tool_call` event, so the model is never offered a
model picker and never pays for one in schema.

That works because of an ordering fact in pi that the fork depends on without
saying so (**T8**): `prepareToolCall` calls `validateToolArguments` **first**
and only then hands the *same object* to `beforeToolCall`
(`pi-agent-core/dist/agent-loop.js:404-409`), and `prepared.args` is that same
object. So the injected keys are added after validation and survive
`additionalProperties: false`. If a future pi validated after the hook, or
cloned the args, every `Agent` call would fail validation or silently lose its
model override.

`max_turns` is readable by `executeAgentTool` and is likewise absent from the
schema, so only agent frontmatter or the store default can set it. That is
deliberate: it costs schema, and it means the model cannot widen its own child's
ceiling.

### 3.2 Worktree validation and the trust gate

`validateWorktreePath` requires the target to exist, be a directory, and sit
inside **any** git repository on disk. `resolveSubagentTrust` then decides
whether the target's *project resources* (`.pi/` settings, extensions, skills,
prompts, themes, `.agents/skills`) load.

Read that carefully, because it is easy to mistake for a sandbox (**T6**): the
trust gate governs what the child **loads**, not where it can **write**. An
untrusted cross-repo target still spawns, with the child's `cwd` set to that
directory and its ordinary tool set — `read`, `bash`, `edit`, `write` for
`general-purpose`. The operator gets a warning; the spawn proceeds.

### 3.3 Type resolution

`resolveType` is case-insensitive and refuses an ambiguous match rather than
picking one. A miss triggers `discoverNewAgents()` — a rescan of the agent
directories, including the worktree's `.pi/agents` when the target is trusted —
and one retry. So an agent file dropped in mid-session becomes usable without a
reload.

### 3.4 The concurrency slot

```
  spawn("forge/qwen3.8-27b")
        │
        ▼
  getSlot(modelKey)  ── per-model slot ─▶ per-provider slot ─▶ default
        │
   running >= limit ?
        ├── yes → queue.push(...)    status "queued"
        └── no  → slot.running++     status "running"
                                        │
                     settlement .finally: slot.running--
                                        │
                                  drainQueue() → start the next queued agent
```

The default is **1**, and the number lives in exactly one place
(`config/config-io.ts` `DEFAULT_CONCURRENCY`); `agent-manager.ts` reads it from
there. That single-source-of-truth is not tidiness — while the two were separate
they diverged, the manager's fallback never fired because `ConfigStore` always
supplies a `default`, and every session ran at 4 (second audit, F3). Re-verified
through the real wiring in this pass: `{ limit: 1, running: 0 }`.

The reasoning for 1 is measured rather than assumed. A child having its own
system prompt does **not** by itself evict the parent's cached prefix — the
parent held a 99.2% cache hit across six small child turns. What evicts it is
**size**: a child that grew to 18k tokens took the parent's next call from 2,117
cached tokens to zero, and from 442 ms to 2,949 ms. Serialising children means at
most one foreign prefix competes at a time.

### 3.5 Building the child's session — and the spawn bracket

```
   buildSubagentSession()
   ┌──────────────────────────────────────────────────────────────┐
   │ enterSubagentSpawn()      depth 0 → 1                        │
   │   published on globalThis.__PI_SUBAGENT_SPAWN_DEPTH__        │
   │                                                              │
   │   reloadAndMap()   ── every extension factory runs here      │
   │                       (rtk's factory shells out to           │
   │                        `rtk --version` on load)              │
   │   createAndConfigureSession()                                │
   │     initSession()        model, tools, resource loader       │
   │     bindExtensions()  ── handlers registered,                │
   │                          session_start emitted               │
   │     resolveVisibleTools() → setActiveToolsByName()           │
   │ exitSubagentSpawn()       depth 1 → 0                        │
   └──────────────────────────────────────────────────────────────┘
                              │
                              ▼           ← the run happens OUTSIDE the bracket
                        runSessionPrompt()
```

The bracket exists so that an extension factory re-run for a child can tell it
is being loaded into a subagent. Two packages read it:
`pi-subagents-lite/src/index.ts` (`if (isInsideSubagentSpawn()) return`) so a
child gets no `Agent` tool and cannot clobber the parent-owned shell, and
`pi-loop-mode` (`bornInsideSubagentSpawn()`) so a child's instance registers
nothing at all.

It used to wrap the **whole child run**, which for a background agent is
minutes, and anything that loaded an extension in that window was misread as a
subagent — an operator `/reload` stripped the parent's own subagent tools and
permanently mis-branded the loop instance (second audit, F9). It is now the
build only, which is the thing the flag actually describes.

A residual, small and worth knowing: `rtk-pi`'s factory is `async` and awaits a
subprocess, so the depth is above zero across that await. A reload that lands
exactly there still mis-reads. The window is milliseconds rather than minutes.

### 3.6 The child's turn loop, the ceiling, and the anchor

pi's agent loop, in the shape that matters here
(`pi-agent-core/dist/agent-loop.js:83-170`):

```
   pendingMessages = drainSteering()                       :83
   while (hasMoreToolCalls || pendingMessages.length) {    :88
     inject pendingMessages as user messages               :95-102
       → emits message_start / message_end for each        ← resets the text collector
     stream the assistant response                         :105
     execute tool calls, if any                            :113-128
     emit turn_end                                         :131   ← wireTurnTracking runs HERE
     pendingMessages = drainSteering()                     :160   ← and picks up what it queued
   }
   followUp queue → if non-empty, loop again               :163-168
```

Two properties of that loop are load-bearing and neither is obvious:

- **`AgentSession._emit` calls subscribers synchronously**
  (`agent-session.js:298`), and `session.steer()` reaches
  `agent.steer()` synchronously too. So a steer queued from a `turn_end`
  subscriber is in the queue before line 160 reads it.
- **pi never sets `shouldStopAfterTurn`** (grepped across the whole `dist/`), so
  the drain at line 160 always happens.

Together they mean: **a steer sent at `turn_end` always buys another turn.** For
the 40-turn ceiling that is the design — the wrap-up steer turns a severed run
into a final answer. For a one-turn budget it is a bug, and that is T1 (§9).

The **anchor** rides the same mechanism deliberately. `onCompaction` fires on
`compaction_end` and steers the brief back in, so the freshly-summarised context
begins with a restatement of the task. It costs ~50 tokens and it is prevention
rather than detection: pi merges each summary into the previous one under a
*"PRESERVE all existing information"* prompt, so summaries **grow** — 456 →
4,029 → 11,054 chars across 42 real compactions — and the first thing they erode
is the oldest thing in the transcript, which is the brief.

### 3.7 Settlement

```
  run promise settles
        │
        ├─ status precedence, in this order:
        │     already "stopped" (external abort) wins outright
        │     else aborted → "aborted"          (hard abort after maxTurns+grace)
        │     else modelError → "error"
        │     else turnLimited → "turn_limited"
        │     else "completed"
        ├─ record.result = responseText
        ├─ ★ VERIFICATION ★    (status terminal, completedAt NOT yet set)
        ├─ record.error, contextPercent
        └─ completedAt = now
             │
             └─ .finally: settlementCount++, finalize the transcript log,
                          release the slot, tally cost, drain the queue,
                          detach the parent-interrupt binding, open the gate
```

### 3.8 Delivery — and why the two paths are not symmetric

A **foreground** subagent blocks the parent's tool call. Its result is an
ordinary tool result, so `.pi/extensions/compaction-guard` bounds it like any
other: that extension keys off `toolName`, not a list of pi's builtins, so an
extension-registered tool is covered for free.

A **background** subagent is delivered with `pi.sendMessage(...)`, which pi turns
into a `role: "custom"` message handed straight to `agent.steer()` /
`followUp()`. Checked against pi 0.84.2's own source: that path emits no `input`
event, no `tool_result`, and on the `triggerTurn` branches no
`message_start`/`message_end` either. **There is no generic hook an extension
could have used**, which is why `src/spawn/result-cap.ts` exists and bounds the
payload at the source instead — measured live at 14,218 → 10,495 chars, with the
parent then reading the spill file unprompted.

---

## 4. The record's life

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
                      │   │                                 │
                      │   │  stopAgent() → false            │
                      │   │  StopAgent tool → false         │  ← T5
                      │   │  watchdog → drops the state     │
                      │   │  bounded only by the deadline   │
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

The starred window is why `verifyPhase` exists. `AgentWidget.categorizeAgents()`
sorts on exactly two fields — `status` and `completedAt` — so for the whole
length of a judge call a record matched *none* of running, queued or finished,
and its row was removed and then re-added. `verifyPhase` now keeps it in the
active set, and `verifyPhaseActivity()` says which call is in flight.

---

## 5. What a child inherits, and what it does not

A child does **not** inherit the parent's `-e` flags. It builds its own
`DefaultResourceLoader`, which *discovers* extensions.

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
| `compaction-guard` | **yes**, by discovery | A child that blows its own window returns nothing. Observed capping a child's own `read` at 9,778 → 8,176 chars. Its only module state is a temp-dir path, so a second instance is safe. |
| forge's proxy patches | **yes** | Same provider, same base URL — the reasoning passthrough and the real `finish_reason` apply to child turns too. |
| `rtk` | **put back** deliberately | A child running `bash` uncompressed is the session that can least afford it. No module state; one `tool_call` handler. |
| `pi-loop-mode` | **no, removed** | Its whole state machine is module-global, and a child binds *the same module*. See §7.4. Removing it also returns ~177 tokens/turn of `loop` tool schema to the child's window. |
| `prinny` + its skills | **denied, unconditionally** | The model spawns subagents on its own initiative; they do not get to post to Matrix. Keyed on **path**, because `extractExtensionName()` returns `index` for all three vendor packages and `resolvePackageShortName()` returns undefined for any package whose `pi.extensions` manifest names a directory rather than a file — which is prinny's shape *and* pi-loop-mode's. |
| the `Agent` tool itself | **no** | The extension factory returns early inside a spawn, so no recursive subagents. |

The denial **composes** rather than replaces: an agent file can still narrow its
own extensions, it just cannot widen them back to include a denied one.
`SUBAGENT_EXTRA_EXTENSIONS` replaces the put-back list entirely and is filtered
by the same denial.

### The sharp edge underneath all of this

Children run **in the parent's process**. Node's module cache means an extension
loaded by both parent and child is *the same module object*, with the same
module-level state.

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

That is not a theory — it is the mechanism `isInsideSubagentSpawn()` relies on
(the child's factory reads a counter the parent incremented), and it is why the
loop had to be taken out of children entirely.

### Which declaration actually governs a spawn

`runAgentImpl` holds two views of an agent and they are not interchangeable:

```
   __verifier's declared config              what getConfig() resolves to
   ┌──────────────────────────┐              ┌──────────────────────────────────┐
   │ tools:      false        │──────────────▶│ tools: (general-purpose's)      │
   │ extensions: false        │──── hidden ──▶│ extensions: true                │
   │ skills:     false        │     routes    │ skills: true                    │
   │ maxTurns:   1            │     around it │                                 │
   └──────────────────────────┘              └──────────────────────────────────┘
        via getAgentConfig()                      via getConfig()
                    │                                      │
                    └──────────────► declaredResources() ◄──┘
                                     the agent's own wins;
                                     the resolved one supplies
                                     only what it left undeclared
```

`hidden: true` was added to keep `__verifier` out of the `Agent` tool's enum
(worth exactly 11 chars — `,__verifier`). `findActiveConfig()` treats `hidden` as
"not a real agent" and substitutes general-purpose, so the judge was built with
general-purpose's declarations and loaded two extensions it was documented not to
have. `declaredResources()` is the repair (second audit, F2). Re-verified this
pass: `declaredResources` reports `false / false`, so `noExtensions: true` and
`additionalExtensionPaths: []`.

---

## 6. The verifier

### 6.1 The problem it exists for

A child gets a brief it cannot see the context for, works in its own window, and
when that window fills pi compacts it and it carries on from a summary. The
summary grows and erodes the brief first. Nothing downstream notices: the parent
sees only the final text, and has no view of the child's reasoning to judge it
by.

### 6.2 Three layers, cheapest first

```
  answer settles
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │ LAYER 1 — the anchor          (no model call)           │
  │ fires on every compaction_end, not at the end:          │
  │ steer the brief back into the freshly-summarised context│
  │ ~50 tokens. Prevention, not detection.                  │
  └─────────────────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │ LAYER 2 — the structural gate (no model call)           │
  │   empty answer          → skipped-empty   (replace text)│
  │   aborted / turn_limited/→ skipped-cutoff (status note  │
  │   stopped / error                          already says)│
  │   no brief recorded     → skipped-nobrief (our own bug) │
  └─────────────────────────────────────────────────────────┘
        │  non-empty answer from a clean run — the only case
        │  where drift is invisible
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │ LAYER 3 — the judge, then a bounded repair loop          │
  └─────────────────────────────────────────────────────────┘
```

### 6.3 The ladder

```
   candidate := the child's answer          attempts := 0
        │
        ├──────────────────────────────────────────────┐
        ▼                                              │
   ┌─────────────────────────────────────┐             │
   │ JUDGE   (fresh __verifier agent,    │             │
   │          no tools, no extensions,   │             │
   │          no skills, ONE turn,       │             │
   │          sees only TASK and ANSWER) │             │
   │          deadline: 300s             │             │
   └────┬─────────────┬──────────────┬───┘             │
        │             │              │                 │
   unparsed      ADDRESSED     NOT_ADDRESSED           │
        │             │              │                 │
        ▼             ▼              ▼                 │
   fail OPEN     attempts==0 ?   attempts >= rounds ?  │
   "unparsed"    ├ yes → passed  ├ yes → failed        │
                 └ no  → repaired│       (return the   │
                                 │        ORIGINAL)    │
                                 └─ no ───┐            │
                                          ▼            │
                              ┌───────────────────────┐│
                              │ REPAIR                ││
                              │ continue the CHILD's  ││
                              │ own session, brief    ││
                              │ restated in full      ││
                              │ deadline: 300s        ││
                              └───┬───────┬───────┬───┘│
                                  │       │       │    │
                              empty   same as   new    │
                                  │   before    text   │
                                  ▼       ▼       └────┘
                              failed   failed
                                     (stalled)
```

**Cost.** `1 + 2 × attempts` model calls, all on the slot the parent is blocked
on. Default `SUBAGENT_VERIFY_ROUNDS=1`, clamped to `[0, 3]`. A passing answer
costs exactly one call.

> That sentence is the one the anatomy doc has always carried, and until this
> pass it was **wrong by a factor of two**: every `maxTurns: 1` run took two
> provider calls, so a passing answer cost 2 and one repair round cost 6. See
> T1. It is true again as of this pass.

### 6.4 The design decisions, and why each one is the way round it is

- **The judge is not the child.** Asking a child to review its own work is the
  weakest check available: every step that led it astray is in its context with a
  justification attached, and a model handed its own reasoning ratifies it. The
  judge is a fresh agent that knows *less* — only the task and the answer.
- **The repair *is* the child**, because that is the only session with the
  context to fix anything.
- **The verdict is asked for before the reasoning.** `VERDICT:` then `WHY:`. A
  local model allowed to reason first argues itself into agreement by the time it
  reaches the verdict.
- **The parse checks `NOT_ADDRESSED` first.** One string contains the other; the
  wrong order turns every failure into a silent pass, forever.
- **Unparsed fails open.** A judge that answered in a shape nobody asked for is
  evidence about the judge, not about the answer.
- **The original wins when everything fails.** It is what the parent would have
  received with the verifier off. The alternative ships text written by a child
  that has just been told twice it was wrong — in practice shorter, more
  apologetic, and no better addressed.
- **It never throws.** A verifier that fails must not take the answer with it.
  As of this pass that promise covers the whole function rather than the part
  inside the try (T3).

**What it cannot do:** catch subtly wrong work. The judge is the same 27B that
wrote the answer. It is a drift check, not a correctness proof.

### 6.5 What the operator sees

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

### 6.6 The brief, and how it grows

`record.execution.brief` is written at spawn and **appended to** by
`appendFollowUp()` on every steered continuation. Both the judge and the anchor
read it. Appending rather than replacing is the point: a follow-up almost always
presupposes the original ("now also list the callers of X"), and replacing would
leave half the answer looking unaddressed. The accumulation is capped at 6,000
chars, and when it overflows the **original** survives and the oldest follow-ups
are dropped — the original is the part everything else refers back to, and the
part a drifting child has most likely lost.

---

## 7. The loop

### 7.1 The iteration cycle

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
   ║      tool_result  → toolCallsThisTurn++              ║
   ║      message_end  → repetition fingerprints          ║
   ║      message_update → mid-stream degeneracy abort    ║
   ║                                                      ║
   ║  context handler: above 60% full, append an          ║
   ║      ephemeral budget line (cloned away before it    ║
   ║      reaches the session — ~40 tokens/turn)          ║
   ╚══════════════════════════╤═══════════════════════════╝
                              ▼
                        agent_end ladder
```

### 7.2 The `agent_end` ladder, in full

```
   agent_end (state.active)
   │
   ├─ 0. clearPendingTimer(); capture and CLEAR toolCallsThisTurn   ← T2
   ├─ 1. softStopRequested?          → finalizeSoftStop, stop
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
   ├─ 6. rescueActive?               → switch back to the loop model, continue
   ├─ 7. checkCommand?               → runGoalCheck; untilDone && passed → completed
   ├─ 8. LOOP_DONE marker            → untilDone ? completed : continue-with-improvements
   ├─ 9. LOOP_BLOCKED marker         → continue with documented assumptions
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

Constants: pressure 85%, starvation/critical 80%, notice 60%, handoff window
≤65,536, recovery attempts 3, cooldowns 3 × (60→120→240 s), rescue after 3,
compact after 5, penalty turns 3, no-progress window 8, similarity 0.8,
degenerate 4 (6 mid-stream), backoff 5→300 s, will-retry watchdog 45 s,
max toolless turns 3.

### 7.3 Context recovery — the part that was broken upstream

pi runs its own overflow handling in `_handlePostAgentRun()`, **after** the
`agent_end` extension event and **before** the run settles. Upstream compacted
from `agent_end`, so both compactions were in flight at once; pi's landed first,
and `prepareCompaction()` refuses a branch that already ends in a compaction
entry — *"Already compacted"* — which upstream treated as terminal. An unattended
loop then needed a human to type `/compact`, which is the one thing an unattended
loop cannot ask for.

The fork defers compaction to `agent_settled`, adopts pi's recovery when pi says
it will retry (with a 45 s watchdog in case that retry never materialises), and
treats *"Already compacted"* / *"Nothing to compact"* as success. Three failed
recoveries cool down instead of stopping.

**Handoff instead of compaction on a small window.** On any window ≤ 64k the loop
builds its **own** summary, bounded at 4,000 chars — the same size on iteration
400 as on iteration 4 — and cuts at the start of the last turn rather than at
pi's 20,000-token tail:

| compaction | pi kept | handoff keeps |
| --- | --- | --- |
| @48 | 68,778 chars | 374 |
| @102 | 123,083 chars | 1,560 |
| @135 | 121,320 chars | 1,707 |
| @150 | 102,697 chars | 2,754 |

**The 87% cliff.** From eight real sessions: below 87% of the window, 3 assistant
turns out of 196 came back empty. At or above 87%, **33 of 63** did —
`content: []`, `stopReason: "stop"`, one output token. An empty turn still burns
an iteration, and the loop's stuck ladder used to answer it by *adding prompt
text*, which is the thing that caused the problem. `isContextPressure()` routes a
starved turn to recovery instead, and the stuck ladder skips its prompt rungs
above 80%. **T2 is a defect in exactly that mechanism.**

### 7.4 Why the loop is not in subagents any more

`vendor/pi-loop-mode` keeps its entire state machine in module scope, and a child
binds the same module object with its own event bus. All thirteen handlers ran a
second time per delegation against the operator's one `LoopState`. The second
audit proved four of the consequences by running them:

```
child before_agent_start → "<<CHILD PROMPT>>\n\nLoop mode is active.
   Goal: refactor the parser. … keep every response under 1,200 characters …
   never stop on your own"
child agent_end          → operator's iteration count 0 → 1, operator's pending
   timer cancelled, operator's next loop turn SENT INTO THE CHILD
child compaction         → replaced by the operator's loop handoff summary
child before_provider_request → temperature/frequency/presence penalties leaked
```

Fixed two ways, belt and braces: the factory returns early for an instance born
inside a spawn (so the package registers nothing — no command, no tool, no
handler), and `subagent-denylist.ts` no longer hands the package to a child at
all. Control-run this pass: with the factory guard disabled, **8 of the 10
assertions in `tests/subagent-isolation.test.ts` fail**; restored, all 10 pass.

Two things from that episode are worth carrying forward:

- **The anchor is load-bearing in a way nobody intended.** It was written as
  prevention against pi's summaries eroding the brief. It turns out to have been
  the *sole survivor* of a total context substitution whenever a child compacted
  under an active loop. Do not let anyone retire it as redundant.
- **A subagent given the operator's goal and "never stop on your own" is a drift
  cause**, injected by the stack, into precisely the mechanism the verifier
  exists to detect drift in.

Still open, deliberately: the module-global state itself. Keying it by session is
~450 references across 1,846 lines plus 18 helper signatures, and there is no
live bug left either way — what the refactor buys is a *feature* (a bounded loop
inside a subagent) that has never actually worked.

### 7.5 The loop as a tool

Upstream exposes loop control only as `/loop`; a model cannot type a slash
command. The fork lifts the command body into `loopCommand(args, ctx, opts)` and
registers a `loop` tool over the same code path. Three non-obvious requirements:

- the tool must hand back the text the command only `notify()`d to the operator
  (captured through a `Proxy`, not a spread — the context is a live object whose
  methods need their own `this`);
- `stop` must not abort the turn that is executing the tool (`suppressAbort`) —
  aborting it would throw away the tool's own result;
- registration must be guarded, because a host without `registerTool` would
  otherwise take the whole extension down;
- and the action set is **closed**. `loopCommand`'s final branch is the
  `/loop <goal>` convenience: anything unrecognised becomes a goal. Correct for a
  human, a live grenade for a model that guesses a verb —
  `loop(action: "pause")` used to start an endless loop whose goal was the word
  *"pause"*.

---

## 8. The seams — every place two pieces touch

This is the map the second audit's findings came out of, and it is worth keeping
current, because every defect in two of the three audits lived here.

```
  ┌──────────────────┐        module cache        ┌──────────────────┐
  │  pi-subagents    │◄──────────────────────────►│  pi-loop-mode    │
  │  -lite           │  __PI_SUBAGENT_SPAWN_DEPTH │                  │
  └──────┬───────────┘  (a global, not an import: └──────┬───────────┘
         │               vendored packages must          │
         │               not depend on each other)       │
         │                                               │
         │  SEAM 1: the child binds the parent's         │  SEVERED
         │          modules                              │  (factory guard +
         │                                               │   not in the
         │                                               │   put-back list)
         │
         │  SEAM 2: result-cap imports the guard's       ┌──────────────────┐
         ├─────────────────────────────────────────────►│ compaction-guard │
         │          measured constants across four      │                  │
         │          directory levels (T-info, F11)      └──────────────────┘
         │                                               ▲
         │  SEAM 3: the child DISCOVERS the guard        │
         └───────────────────────────────────────────────┘
                    and is bounded by it

  ┌──────────────────┐                            ┌──────────────────┐
  │  pi-loop-mode    │  SEAM 4: both inject a     │ compaction-guard │
  │  context handler │◄──── budget line; both ───►│ context handler  │
  └──────────────────┘  check for a customType    └──────────────────┘
                        matching /-context-budget$/
                        so whichever runs second stands down

  ┌──────────────────┐  SEAM 5: turn accounting   ┌──────────────────┐
  │  the verifier    │◄───── maxTurns: 1 ────────►│  agent-runner    │  ← T1
  │  (judge, repair) │        on both calls       │  wireTurnTracking│
  └──────────────────┘                            └──────────────────┘

  ┌──────────────────┐  SEAM 6: verification runs ┌──────────────────┐
  │  the verifier    │◄─── after the status has ─►│  AgentManager    │  ← T5
  │                  │     gone terminal, so       │  stop paths      │
  └──────────────────┘     every stop path no-ops  └──────────────────┘
```

Seams 1–4 were the second audit's territory and are closed or contracted. Seams 5
and 6 are this pass's.

---

## 9. Findings

Nine. Four fixed here, five reported. Evidence classes as in the second audit:
**PROVEN** = a script was run against the real modules and its output is quoted;
**SOURCE** = read out of this checkout or pi's `dist/` with references;
**REASONED** = follows from SOURCE facts, path not executed.

### T1 — a one-turn budget takes two model calls and returns the wrong one · **HIGH** · PROVEN · **FIXED**

The verifier's judge and its repair both run with `maxTurns: 1`. Both took two
provider calls, and both returned the second one's text.

The chain, every link SOURCE-verified:

1. `wireTurnTracking` subscribes to `turn_end`. On reaching `maxTurns` it steers
   *"You have reached your turn limit. Wrap up immediately — provide your final
   answer now."*
2. `AgentSession._emit` (`agent-session.js:298`) calls subscribers
   **synchronously**, and `session.steer()` reaches `agent.steer()` synchronously
   too (its only `await` is after the enqueue). So the message is in the steering
   queue before the emit returns.
3. pi's agent loop drains the steering queue immediately after `turn_end`
   (`agent-loop.js:160`), inside `while (hasMoreToolCalls ||
   pendingMessages.length > 0)`. pi never sets `shouldStopAfterTurn` — grepped
   across the whole `dist/` — so that drain always happens.
4. A non-empty drain re-enters the loop. The injected user message emits
   `message_start`, and `collectResponseText` **resets its buffer** on every
   `message_start`. So the run's `responseText` is the reply to the wrap-up, not
   the answer.

For a 40-turn child that is the design: the ceiling fires on a run that was going
to continue, and the extra turn is the graceful final answer. For a one-turn
budget the soft limit fires on the turn that was supposed to *be* the whole run,
so the steer does not shorten anything — it manufactures a second call and
throws away the first's output.

**Reproduction** (`scratchpad/probes/g1-judge-double-turn.mjs`, real
`continueAgentSession` against a stub that mirrors `agent-loop.js:83-170`):

```
model calls made by a maxTurns:1 run : 2
responseText handed back            : "I have already given my final answer above."
the steer pi injected               : ["…judge prompt…",
                                       "You have reached your turn limit. Wrap up immediately…"]
parseJudgeVerdict(responseText)     : {"addressed":true,"why":"…could not be read…","unparsed":true}
parseJudgeVerdict(turn 1, the real one): {"addressed":false,"why":"the answer summarises a different file."}

CONTROL (maxTurns:0, no soft-limit steer):
  model calls  : 1
  responseText : "VERDICT: NOT_ADDRESSED\nWHY: the answer summarises a different file."
```

Three separate consequences:

| | |
| --- | --- |
| **Cost** | Every verification cost double. A passing answer was 2 calls, not 1; one repair round was 6, not 3; `SUBAGENT_VERIFY_ROUNDS=3` was up to 14, not 7. All of it on the single slot the parent's `Agent` call is blocked on. The number in the anatomy doc and in `verify-runner.ts`'s own header was wrong by a factor of two. |
| **Correctness of the check** | The judge's actual verdict was discarded. Whether the replacement still parses is up to a 27B being asked to restate itself — and when it does not, `unparsed` fails open, so a `NOT_ADDRESSED` answer is delivered as merely unchecked. |
| **Correctness of the repair** | Worse than the judge, because the repair's *content* is the product. The text the parent receives as the repaired answer is the child's reply to "wrap up immediately", not the repair. It also defeats the `repaired === candidate` stall check, which is one of the three conditions that terminate the repair loop. |

**Why nothing caught it.** The anatomy doc looked straight at it and concluded
the opposite: *"The judge always reports `turnLimited` internally… The field is
never read on that path, so it is cosmetic."* That is true of the field and false
of the steer. And nothing could test it: `wireTurnTracking` lived inside
`agent-runner.ts`, which imports pi and therefore cannot be loaded under the
plain `node --experimental-strip-types --test` the suite runs on.

**Fix.** `src/agents/turn-tracking.ts` (new): the soft-limit steer is skipped
when the budget is one turn. A one-turn run that *did* call a tool still
continues on pi's side and is still bounded by the hard abort at
`maxTurns + graceTurns`, so nothing loses its ceiling — it is simply not asked to
wrap up a turn it has already finished. The module imports nothing, which is what
makes it testable; `agent-runner.ts` passes the resolved `graceTurns` in.

**Deliberately not changed.** The same mechanism wastes a turn in a second case:
a run that reaches its *real* ceiling on a turn with no tool calls would have
stopped there anyway, so the wrap-up steer buys a call and replaces a final
answer that already existed. The general fix is to steer only when the turn ended
with tool results (`event.toolResults.length > 0`), which is available on the
event. It is not made here because the 40-turn path is live-observed behaviour
and this is not the change that should alter it. Flagged for whoever owns that
decision.

### T2 — the loop's per-turn tool counter outlives its turn · **HIGH** · PROVEN · **FIXED**

`state.toolCallsThisTurn` is incremented by the `tool_result` handler and was
reset near the *bottom* of the `agent_end` ladder — below every early return.
Soft stop, context pressure, model error, degenerate abort and operator abort all
returned above it, handing that turn's count to the next turn.

Two things read the counter, and both are load-bearing:

- `emptyResponse` requires it to be zero, and `isContextPressure`'s `starvedTurn`
  rung requires `emptyResponse`. That rung **is** the 87%-cliff fix: a clean
  `stop` with no text, no thinking and no tool call on a nearly-full window is an
  out-of-room model, and it has to go to context recovery rather than to the
  stuck ladder, which answers it by adding more prompt text.
- `turnsWithoutTools`, which feeds the narration-only stuck rule.

So a stale count switched the starvation rung off for exactly the turn most
likely to be starved: **the retry of a turn that had already failed.**

**Reproduction** (`scratchpad/probes/g2-toolcalls-not-reset.mjs`, the real module
at 90% context, one process per scenario because the state is module-global):

```
--- MODE=control ---   (the starved turn, nothing before it)
notices after the starved turn : Loop: context pressure detected (1/3) — recovering.
routed to context recovery     : true
loop status line               : Status: retrying

--- MODE=stale ---     (same turn, preceded by a two-tool turn that died on a provider error)
notices after the starved turn : (none)
routed to context recovery     : false
loop status line               : Status: running
iterations                     : Iterations: 1/∞      ← the empty turn burned one
```

In the stale case the loop silently accepts an empty turn as an iteration and
schedules another one into the same saturated context. That is the exact loop the
87%-cliff work was written to break.

**Fix.** The counter is read into a local and cleared at the **top** of
`agent_end`, so every exit path clears it. Both readers use the local.

**Test.** `vendor/pi-loop-mode/tests/turn-counters.test.ts`, 6 assertions, 4 of
them controls that pass either way (an honest note: only 2 discriminate, and
those 2 fail when the reset is moved back).

### T3 — `verifyAnswer`'s prologue was outside its own guarantee · **MEDIUM** · PROVEN · **FIXED**

`verifyAnswer` is documented "Never throws. A verifier that fails takes the
answer with it otherwise." Its `try` began **after** the structural gate, the
brief check and `clampRounds`. And `runVerification` wrapped the call in
`try { … } finally { … }` with **no catch**.

`runVerification` runs inside `attachSettlementChain`'s `.then`, so anything
escaping it lands in that chain's `.catch`:

```ts
.catch((err) => {
  if (record.lifecycle.status !== "stopped") record.lifecycle.status = "error";
  record.result = undefined;          // ← the child's finished answer, gone
  record.error = errorMessage(err);
  ...
})
```

and for a foreground spawn `executeAgentTool` then returns
`errorResult("Agent failed: …")`. So a throw in the *check* would discard the
child's completed work and report a successful run to the parent as a failure —
the exact inversion the layer exists to prevent.

**Reproduction** (`scratchpad/probes/g3-verify-pretry.mjs`):

```
prologue throw ESCAPED verifyAnswer: prologue boom
  -> reaches attachSettlementChain's .catch: record.result = undefined, status = 'error'
control, throw from the judge : "errored" answer kept: true
```

Nothing in the prologue throws today. The point is that the guarantee should not
depend on that staying true as the gate grows — and the gate has already grown
once this year (`error` joined the not-worth-judging list in the second audit).

**Fix, two layers.** The prologue moved inside the try, so the promise now covers
the whole function; the notifier call in the catch is itself guarded; and
`runVerification` gained a real `catch` that records `errored` and leaves
`record.result` exactly as the run produced it. A `phaseReported` flag keeps the
structural skips from reporting a phase clear they never set, which is the
property the existing phase test pins.

**Test.** Four cases in `tests/verify-runner.test.ts`; two fail when the prologue
is moved back above the try.

### T4 — the `errored` verdict borrowed `unparsed`'s wording · **LOW** · SOURCE · **FIXED**

A check that timed out against the 300 s deadline, or failed for any other
reason, appended *"[verification: the check could not be read, so this answer
went out unchecked.]"* — describing a judgement that was never made. This is text
the **parent model** reads and acts on, and the two facts are different:
`unparsed` means the judge answered in a shape nobody could read, `errored` means
the check never completed. `errored` now has its own note ("the check did not
complete"), and the badge table already distinguished them.

### T5 — verification is bounded, but still uninterruptible · **MEDIUM** · SOURCE · **OPEN, by decision**

The second audit's F4 gave each verification model call a 300 s deadline
(`SUBAGENT_VERIFY_TIMEOUT_MS`), which fixed the *hang*. It did not restore
*control*. Inside the verification window the record's status is already
terminal, and every stop path keys off `status === "running"`:

- `stopAgent()` returns false → the operator's Esc reaches `abort(id, "user")`
  (the parent-interrupt binding is still attached; it is detached in `.finally`,
  after verification) and does nothing.
- the `StopAgent` tool takes the same path.
- `checkWatchdogs()` passes `isRunning = status === "running"`, and
  `Watchdog.check()` does not merely skip a non-running record — it **deletes**
  its state.

So the worst case is now a bounded 300 s wait per call rather than a hang, but
the operator cannot shorten it. On a wedged llama-server with
`SUBAGENT_VERIFY_ROUNDS=1` that is up to 900 s of unstoppable wait on a
foreground delegation.

Left open because the fix is a policy choice, not a repair: either the stop paths
learn a fourth state (verifying) and abort the deadline controller, or the
deadline is shortened, or the verification window is made cancellable by holding
the controller on the record. All three change behaviour under load. Naming it is
better than picking one blind.

### T6 — `worktree_path` is a filesystem grant, not a sandbox · **MEDIUM** · SOURCE · **OPEN, by design**

`validateWorktreePath` accepts any existing directory inside **any** git
repository on the host. `resolveSubagentTrust` gates only whether the target's
*project resources* load. An untrusted cross-repo target still spawns, with the
child's `cwd` there and its full tool set — `read`, `bash`, `edit`, `write` for
`general-purpose`. The operator gets one warning line; the spawn proceeds.

This is documented in the anatomy doc as "a real surface", and it is worth
stating precisely, because the presence of a trust gate reads like containment
and is not: the model can direct a subagent to modify any git repo on the box.
The mitigations that exist are the turn ceiling, the watchdog and `StopAgent` —
all of which bound *duration*, not *reach*.

### T7 — the standing `Agent` schema grows with every agent file on disk · INFO · MEASURED

The agent-type list is carried as the `description` of the `agent` property:
`Type.String({ description: types.join(",") })`. Measured against pi's own
typebox with the two default types registered:

```
  Agent       parameter JSON   281 chars     ← + 1 char per char of every agent name
  StopAgent   parameter JSON   114 chars
  AgentStatus parameter JSON    62 chars
  loop        parameter JSON   468 chars  +  114 chars of description
```

(Those are `JSON.stringify` of the parameter schema only; the anatomy doc's 710
and 709 are the full wire framing measured against a stub model, and are the
numbers to quote for total cost.)

Two consequences worth knowing. First, `hidden: true` on `__verifier` saves
exactly 11 chars — `,__verifier` — which is the whole reason it exists, and which
is what set off the `getConfig` substitution bug the second audit found. Second,
ten project agent files add roughly 150 chars to **every turn of every session**,
forever. Agent files are not free.

### T8 — the model/thinking injection depends on pi's validation order · INFO · SOURCE

Covered in §3.1. `validateToolArguments` runs before `beforeToolCall`, and the
object the hook mutates is the object `execute` receives. The `Agent` schema
declares `additionalProperties: false` and does not declare `model`, `thinking`
or `_modelOverride`. The injection is legal only because validation has already
happened. Nothing in the fork records this dependency; a pi release that
validated after the hook, or that cloned the args, would break subagent model
routing with a validation error that names a property the fork put there. Worth a
line in `FORK.md`.

### T9 — a background subagent's verification holds the only slot · INFO · SOURCE

Verification runs inside the settlement chain, and the concurrency slot is
released in the `.finally` *after* it. With `concurrency.default = 1` that means a
queued second subagent waits not only for the first child's run but for its judge
and any repair — up to three model calls, or up to 900 s against the deadline.
This is a consequence of two correct decisions (release the slot last; verify
before anyone reads the answer) rather than a defect, but it is not written down
anywhere and it makes queue latency hard to predict from the widget, which shows
the first agent as finished-but-verifying.

---

## 10. What shipped in this pass

| # | Fix | Where | Test |
| --- | --- | --- | --- |
| T1 | The soft-limit steer is skipped for a one-turn budget; the ceiling logic moved to a pi-free module so it can be tested at all | `agents/turn-tracking.ts` (new), `agents/agent-runner.ts`, `agents/subagent-denylist.ts` (comment) | `tests/turn-tracking.test.ts` — 11 cases, 2 fail under the control |
| T2 | The per-turn tool counter is read and cleared at the top of `agent_end`, so every exit clears it | `pi-loop-mode/extensions/index.ts` | `tests/turn-counters.test.ts` — 6 cases, 2 discriminate |
| T3 | `verifyAnswer`'s prologue moved inside its try; guarded notifier; a real `catch` in `runVerification` that keeps the answer | `agents/verify-runner.ts`, `agents/agent-manager.ts` | 4 cases in `tests/verify-runner.test.ts`, 2 fail under the control |
| T4 | `errored` gets its own note instead of borrowing `unparsed`'s | `agents/verify.ts`, `agents/verify-runner.ts` | 2 cases, 1 fails under the control |

Gates after:

```
vendor/pi-subagents-lite   lint 67/67 files   tests 117/117   (was 65 / 100)
vendor/pi-loop-mode        lint clean         tests  69/69    (was 63)
.pi/extensions/compaction-guard                tests  39/39    (unchanged)
```

Every new guard was **control-run with the fix disabled** and the failing count
recorded above. Where a case passes either way it is called out as a control
rather than counted as evidence — the standing example of why is the first
audit's B3, a test named *"survives an unknown action"* that passed **because** of
the bug.

---

## 11. Reproducing the three proofs

All three are plain node against the real modules. No stack, no model, no running
pi. They are kept in **`context/testing/probes/`**, with a README that says what
each one prints now that the fixes are in and what it printed before. They are
diagnostics rather than tests — the regression tests live in the packages — but a
reproduction that shows the *mechanism* belongs next to the write-up that
explains it.

**T1** — `node g1-judge-double-turn.mjs`. Loads the real
`continueAgentSession` through pi's own `jiti` (the package uses `.js`
specifiers for `.ts` files) and drives it with a stub session that mirrors
`agent-loop.js:83-170`: drain steering after each `turn_end`, re-enter the inner
loop while `pendingMessages.length > 0`, emit `message_start`/`message_end` for
each injected message. Assert on the number of scripted replies consumed and on
which one comes back. The control is the same run with `maxTurns: 0`.

**T2** — `node --experimental-strip-types g2-toolcalls-not-reset.mjs control`
then `… stale`. Loads `pi-loop-mode/extensions/index.ts` directly with a stub
`pi`/`ctx` whose `getContextUsage()` reports 90%, starts a loop through the
registered command, then fires `tool_result` / `agent_end` by hand. Two
processes, because the loop's state is module-global.

**T3** — `node --experimental-strip-types g3-verify-pretry.mjs`. Calls
`verifyAnswer` with a `lifecycle` whose `status` getter throws, standing in for
any future throw in the structural gate. The control is a throw from the judge,
which is contained.

The second audit's two config probes (F2, F3) were re-run unchanged and are
quoted in §12.

---

## 12. What holds

Re-checked this pass, not taken on trust.

| Claim | How it stands |
| --- | --- |
| Concurrency is 1 through the real wiring | **PROVEN, re-run.** `DEFAULT_CONCURRENCY {default:1}` → `store.concurrency {default:1,…}` → `getSlot("forge/qwen3.8-27b") = {limit:1,running:0}`. A manager constructed with no config also reports 1. |
| `__verifier` loads what it declared | **PROVEN, re-run.** `getAgentConfig` says `false/false`; `getConfig` still says `true/true` (the `hidden` substitution is untouched); `declaredResources` — what the loader reads — says `false/false`. Session allowed tools `[]`. Control: a visible agent is unaffected. |
| `__verifier` is out of the `Agent` enum | **PROVEN.** `getAvailableTypes()` = `general-purpose,Explore`. |
| `pi-loop-mode` is not handed to a child | **PROVEN.** `subagentExtraExtensionPaths()` = `["…/vendor/rtk-pi/extensions/index.ts"]`. |
| A subagent instance of `pi-loop-mode` registers nothing | **PROVEN, control-run.** Guard disabled → 8 of 10 isolation assertions fail; restored → 10/10. |
| `compaction-guard` is safe inside a child | **Holds.** Three handlers, no `session_start`/`session_shutdown`, one module-level variable (a temp-dir path). |
| `rtk-pi` is safe inside a child | **Holds.** One `tool_call` handler, no module-level mutable state. Its factory does shell out on load. |
| The two budget-line injectors do not double up | **Holds.** Both check `customType` against `/-context-budget$/`; either registration order works. |
| A foreground `Agent` result is bounded by `compaction-guard` | **Holds.** `tool_result` is emitted from the generic `afterToolCall`, so extension tools are covered. |
| There is no generic hook on the background delivery path | **Holds.** `sendCustomMessage` → `steer()`/`followUp()` emits no `tool_result`. |
| `verifyPhase` keeps a verifying row visible | **Holds.** `agent-widget.ts` `categorizeAgents()`. |
| The verdict badge is painted in five places from one table | **Holds.** Widget, foreground renderer, background card, viewer header, `/agents` list. |
| The verifier's parse order and fail-open policy | **Holds.** `NOT_ADDRESSED` tested before `ADDRESSED`; unparsed returns `addressed: true` with the flag set. |
| The `--check` round-trip survives a quoted command | **Holds.** Escape-pair-aware pattern, `\"`/`\\` only, Windows paths left alone. |
| The `loop` tool's action set is closed | **Holds.** `TOOL_ACTIONS` checked before `loopCommand` is reached. |
| `max_turns` is unreachable from the model | **Holds.** Not in the registered schema. |
| The verifier's cost is `1 + 2 × attempts` | **True again as of this pass.** It was `2 + 4 × attempts` (T1). |

---

## 13. Still open, and still unwatched

**Open by decision, not oversight:**

1. **Per-session loop state** (second audit). ~450 references across 1,846 lines.
   No live bug — the package is inert in a child and is not loaded there. What
   the refactor buys is a bounded loop *inside* a subagent, which is a feature
   that has never worked. If it is not wanted, delete the intent from
   `subagent-denylist.ts`'s comment and the guard becomes permanent.
2. **T5** — verification cannot be interrupted, only waited out.
3. **T6** — `worktree_path` reach.
4. **T1's general case** — a wasted wrap-up turn when the real ceiling is reached
   on a turn with no tool calls.

**Never watched running.** This is the same list as the last handoff, minus
nothing, and it is the honest weak point of all three audits:

- **Section I of `context/testing/subagents-loop-verifier.md`** on a quiet box.
  The claim to falsify is that an agent's row stays put with the spinner running
  while the judge works.
- **A delegation with a loop running.** Fixed at the module level twice now,
  never watched. Start `/loop`, delegate, check that `/loop status` still shows
  the goal, that the iteration count has not moved, and that the subagent's
  answer is about the subagent's task.
- **The verifier's failure path.** Judge says no → repair → re-judge has never
  fired live, and the judge's false-positive rate on a 27B is unknown. T1 makes
  this more urgent than it was: until this pass, every live judge verdict was
  read from the wrong turn, so *no* live verification result in this project's
  history is evidence of anything.
- **The anchor**, which needs a child that fills its own 32k window and compacts.
- **The 40-turn ceiling and the steer-then-abort ladder.**
- **`stats.verifyUsage` and the deadline**, neither exercised against a real
  model.
- **A background subagent that settles after its Matrix run has retired** answers
  into the void (`forwardToMatrix` returns early without a live `awaitingReply`
  entry). Silence, not a leak.
- **Finished widget rows leave after `finishedRetentionMinutes` (default 1)**, so
  the keyboard hop cannot reach an agent that finished a few minutes ago;
  `/agents` can, all session.

**If the stall recurs:** `srv stop: cancel task` with no timing line means llama
accepted the task and dropped it; correlate with `prompt state size … exceeds
cache size limit 2048 MiB, skipping`, which appeared immediately before both
cancels.

---

## 14. The pattern across three audits

Worth recording, because it has now repeated three times with different symptoms.

- **Audit 1** found defects *inside* one module (a free identifier, a leaked
  session, an open-ended action set).
- **Audit 2** found that every one of its own defects lived in the *wiring
  between two modules*, and that 133 passing tests caught none of them because
  every test exercised one module in isolation.
- **Audit 3** (this one) found defects that live in a module but depend on a fact
  about **someone else's runtime** — pi's steering-drain order (T1), and the
  interaction between a counter's reset point and a control-flow ladder that grew
  early returns after the counter was written (T2).

The common thread is not "test more". It is that **each of these had a correct
comment above an implementation that did something else**, and in two of the
three the comment was confident enough to stop the reader looking. The anatomy
doc says the judge's turn limit is "cosmetic"; the loop's reset line sits under a
comment describing a per-turn counter. The cheapest defence found so far is the
one all three audits used in the end: **make the claim executable**. Every fix
above ships with a test that fails when the fix is removed, and the failing count
is recorded, because a test that has never been watched failing is not evidence.
