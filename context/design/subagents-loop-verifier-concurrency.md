# Subagents, the loop and the verifier — what happens while we are waiting

**Twenty-second pass, 2026-08-23.** Self-contained: it assumes none of the
twenty-one documents before it. §1 is the whole machine in seven drawings, §2 is
pi itself, §3 is the event bus, §4–§9 are the seven packages, §10 is what has to
stay true, §11 is the six findings, §12 the evidence, §13 what is open, §14 the
pattern across twenty-two passes, §15 where to look.

Everything here is measured against **pi 0.84.2**, the version installed at
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent`, and against the
tree as it stands in this repository. Where a line number is quoted it is from
that install.

---

## 0. The axis, and why it is a new one

Twenty-one passes have each taken one question and asked it of every surface in
the stack. The fifteen so far:

```
   1. what we RETURN from a handler          X5
   2. what we PASS to a call                 Z1–Z4, AA4
   3. which events REACH us at all           AA1
   4. what a host function's answer CAN say  AA2, AB1, AB3
   5. WHEN it can say it, and how long the   AB1–AB4
      answer stays true
   6. WHO RECEIVES IT, and what they see     AC1–AC5
      when nobody does
   7. WHO OBEYS IT — and does the code that  AD1–AD7
      obeys ever see the instruction
   8. WHAT WE BELIEVE ABOUT OURSELVES        AE1–AE7
   9. WHAT WE DECIDED NOT TO DO              AF1–AF6
  10. WHAT WE NAMED — then go and open it    AG1–AG6
  11. WHERE ELSE IT BELONGS — write the      AH1–AH6
      scan, not the third fix
  12. WHAT WE PROMISED — quote the sentence  AI1–AI5
      and find the path where it is false
  13. WHO IS ALLOWED TO ASK — name every     AJ1–AJ5
      actor that reaches the decision
  14. WHAT THE TEST IS A PROXY FOR — write   AK1–AK5
      the set down twice and enumerate the
      difference
  15. WHAT WE START AND NEVER FINISH — name  AL1–AL9
      the ONE place that ends it, then the
      paths that miss it
```

This pass is the sixteenth:

> **WHAT HAPPENS WHILE WE ARE WAITING.** For every `await` inside a handler, a
> settlement chain or a callback, name what ELSE can run at that point — and then
> name what the code assumes has not changed by the time it resumes.

It is the natural successor to the fifteenth. That pass asked where a construct's
lifetime *ends*; this one asks what happens when two lifetimes *overlap*. A leak
is one construct that outlives its scope. This is two constructs alive at once
that were each written as though they were alone.

### 0.1 Why it is not "look for race conditions"

There is one thread. Nothing here is preempted, no two statements interleave, and
every `Map` write is atomic. Searching for data races in this codebase would find
nothing, and that is exactly why the axis is worth a pass: **the absence of
preemption makes it feel as though ordering is free, and it is free only up to
the first `await`.**

So the axis is mechanical rather than intuitive. Open a function. Find every
`await`. For each one, ask three questions:

```
   1. HOW LONG can this suspend?            milliseconds, or two minutes?
   2. WHAT can run at this point?           a command handler, a timer, another
                                            tool call, a callback pi is holding
   3. WHAT did we read BEFORE it that we    a handle, a flag, a status, a token,
      ACT on AFTER it?                      the identity of the session itself
```

Question 1 is what makes the difference between a theoretical hazard and a
finding. Four of this pass's six are about an await measured in **seconds to
minutes** — a 120-second MCP handshake, a 120-second goal check, a 300-second
verification deadline, a summariser call on a 27B — and the fifth is about a
callback pi holds across a session teardown, which has no bound at all.

### 0.2 The four shapes

Every finding in §11 is one of these.

```
   ── 1. CHECK, THEN ACT, ACROSS AN AWAIT ─────────────────────────────────────
      A guard is read, something is awaited, and the guard's answer is acted on
      afterwards as though it were still true.
      AM1 (the stop that read `child`), AM4 (the token that did not move)

   ── 2. A HANDLE THAT ONLY EXISTS AFTER THE AWAIT ────────────────────────────
      The thing a teardown must reach is assigned on the line AFTER the await,
      so for the whole of the wait there is nothing to reach.
      AM1

   ── 3. TWO TEARDOWNS FOR ONE THING, IN DIFFERENT ORDERS ─────────────────────
      Two paths end the same construct; one of them ends a dependency first.
      AM3 (the session the verifier runs in), AM5 (the gate dispose cleared)

   ── 4. ONE SLOT, TWO DEADLINES ──────────────────────────────────────────────
      Two callers with different urgencies share one timer or one lock, and the
      first to arrive decides for both.
      AM2 (the lock that could not see pi), AM6 (the nudge batch)
```

Shape 3 is the one with the sharpest rule attached, and it is the rule this pass
would give anybody adding a teardown: **if a thing has two teardowns, they are
already drifting. Make it one function and name the order in it.** Both AM3 and
AM5 are two teardowns that had diverged, and in both cases the divergence was
invisible because each path was individually reasonable.

### 0.3 What is NOT this axis

- **Leaks.** "Nothing ends this" is the fifteenth pass (AL). "Two things end it
  in different orders" is this one.
- **Missing events.** "Which events reach us at all" is AA1.
- **Unbounded work.** A bound is a lifetime question. *Which* bound wins when two
  are armed is this one (AM6).
- **Actual parallelism.** There is none. `Promise.all` over tool calls is
  interleaving, not parallelism, and the distinction matters: it means the
  hazards are all at `await` boundaries and can be enumerated.

---

## 1. The machine

Seven packages run in **one node process**, inside **one pi session**, against
**one llama.cpp slot**. Nothing here is a service; everything is an extension of
the same process.

### 1.1 Panel A — the whole machine, and the four things that can be in flight

```
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  ONE NODE PROCESS · ONE pi SESSION · ONE llama.cpp SLOT · ONE THREAD       │
   │                                                                            │
   │   OPERATOR ──────► pi TUI ─────────────────────────────────┐               │
   │   (terminal)        │  /loop  /agents  /prinny  /stack     │               │
   │                     │  …and Esc, and typing mid-turn       │               │
   │   SENDER ─► Matrix ─┴─► prinny sidecar ──stdio(MCP)──► prinny ext          │
   │   (a phone)              (its own process)                 │               │
   │                                                            ▼               │
   │                                              ┌───────────────────────┐     │
   │                                              │   pi AgentSession     │     │
   │                                              │   (the PARENT)        │     │
   │                                              └───────────┬───────────┘     │
   │                                                          │                 │
   │   ┌── extensions bound to that session, in LOAD order ────┴────────┐        │
   │   │  stack   browser   loop   guard   subagents   prinny   rtk    │        │
   │   │    1        2       3       4         5         6       7     │        │
   │   └────────────────────────────────────────┼──────────────────────┘        │
   │                                            │  Agent tool                   │
   │                                            ▼                               │
   │                              ┌───────────────────────────┐                 │
   │                              │  AgentManager             │                 │
   │                              │    ├ SlotTable (1 slot)   │                 │
   │                              │    ├ Watchdog (5 s tick)  │                 │
   │                              │    └ SpawnCoordinator     │                 │
   │                              └─────────────┬─────────────┘                 │
   │                                            │  runAgent()                   │
   │                                            ▼                               │
   │                              ┌───────────────────────────┐                 │
   │                              │  CHILD AgentSession       │                 │
   │                              │  SessionManager.inMemory  │                 │
   │                              │  its own extensions/tools │                 │
   │                              └─────────────┬─────────────┘                 │
   │                                            │  the answer                   │
   │                                            ▼                               │
   │                              ┌───────────────────────────┐                 │
   │                              │  the VERIFIER             │                 │
   │                              │   judge  → a THIRD session│                 │
   │                              │   repair → the child's own│                 │
   │                              └─────────────┬─────────────┘                 │
   │                                            │                               │
   │                    ┌───────────────────────┴───────────────────┐           │
   │                    ▼                                           ▼           │
   │      foreground: the Agent tool's          background: a `subagent-result` │
   │      own result                            message, delivered as followUp  │
   └────────────────────────────────────────────────────────────────────────────┘
```

The nineteenth pass named the five ACTORS that can reach a decision — the
OPERATOR at the terminal, the parent MODEL, an allow-listed Matrix SENDER, a
CHILD session, and the MACHINERY itself. This pass needs a different list: the
four things that can be **in flight at the same moment**.

```
   1. a pi agent RUN            the parent's turn, or a child's, or the judge's
   2. a COMPACTION              pi's own (threshold/overflow/manual), or one an
                                extension asked for through ctx.compact()
   3. a COMMAND or a UI action  /loop stop, /prinny restart, Esc, an /agents menu
   4. a TIMER or a CALLBACK     the nudge batch, the loop's pendingTimer, the
                                widget's 80 ms poll, the watchdog's 5 s tick,
                                the delivery sweep, a ctx.compact() callback
```

Every finding in §11 is a pair from that list overlapping: (1,3) for AM1 and AM3,
(1,2) for AM2, (2,3) for AM4, (1,4) for AM5 and AM6.

### 1.2 Panel B — the await map

This is the new drawing, and it is what §10.2 tabulates. Each `╍╍` is a point at
which the single thread is given away, with what it costs. A **✘** is where this
pass found something read before it and acted on after it.

```
   OPERATOR TYPES / A MATRIX MESSAGE ARRIVES
     │
     ├─ AgentSession.prompt()
     │    ╍╍ _tryExecuteExtensionCommand      a command handler, in full
     │    ╍╍ emitInput                        extension handlers
     │    ╍╍ _checkCompaction  ← PRE-PROMPT: the session reads as IDLE  ✘ AM2
     │    ╍╍ emitBeforeAgentStart
     │
     ├─ _runAgentPrompt        _isAgentRunActive = true  ────────────┐
     │    ╍╍ agent.prompt()                                          │ everything
     │       ├─ turn_start / message_* / tool_execution_*            │ in here
     │       ├─ TOOL CALLS ── prepareToolCall  sequential            │ queues a
     │       │                execute         PARALLEL (Promise.all) │ sender's
     │       │                  ╍╍ Agent  ── a whole child run       │ message
     │       │                  ╍╍ bash   ── up to 600 s (/stack)    │ instead
     │       │                  ╍╍ loop   ── a command handler       │ of
     │       │                  ╍╍ prinny ── a sidecar round trip    │ starting
     │       └─ agent_end ── EXTENSION HANDLERS, awaited, in order   │ a run
     │            ╍╍ loop: runGoalCheck        up to 120 s           │
     │            ╍╍ loop: interveneStuck → pi.setModel              │
     │            ╍╍ prinny: (records only)                          │
     │    ╍╍ _handlePostAgentRun → _checkCompaction   ← POST-RUN     │
     │       (safe: the session still reads as BUSY)                 │
     │                                                    ──────────┘
     ├─ _emitAgentSettled       _isAgentRunActive = false  ← BEFORE the handlers
     │    ╍╍ loop:   requestEmergencyCompaction → ctx.compact()
     │    ╍╍ prinny: forwardResult → sidecar round trip, then a continuation
     │    ╍╍ guard:  release pi's compaction hold
     │
     └─ idle
          ╍╍ the nudge batch fires             200 ms / 5 s          ✘ AM6
          ╍╍ the loop's pendingTimer fires     delay / backoff / cooldown
          ╍╍ the watchdog ticks                5 s
          ╍╍ the delivery sweep ticks          30 s
          ╍╍ a ctx.compact() callback lands    NO BOUND              ✘ AM4

   AND, ORTHOGONAL TO ALL OF IT:

     the SETTLEMENT CHAIN of a delegation, which is not on any of pi's
     timelines at all:
       .then  ╍╍ runVerification        1 judge + up to 3 repairs,
              │                          300 s deadline EACH          ✘ AM3
       .finally  release the slot, tally, drain the queue, open the gate  ✘ AM5

     the prinny CHANNEL, which is a child process:
       ╍╍ startChannel → instance.start()      up to 120 s            ✘ AM1
       ╍╍ requestApproval                      up to 300 s
```

### 1.3 Panel C — what pi serialises for you, and what it does not

The single most useful fact in this document is that pi gives you **two
guarantees and no others**, and that both are about the AGENT LOOP rather than
about the session.

```
   GUARANTEED, measured out of pi 0.84.2's own source
   ────────────────────────────────────────────────────────────────────────────
   ▸ Event handlers are AWAITED, one at a time, in extension registration order.
       ExtensionRunner.emit                        extensions/runner.js:579
         for (const ext of this.extensions)
           for (const handler of handlers)
             await handler(event, ctx)
     So two extensions' handlers for the same event never interleave, and a
     slow handler delays every handler after it.

   ▸ Agent listeners are AWAITED, and the run is not idle until they settle.
       Agent.processEvents                     pi-agent-core/dist/agent.js:417
         for (const listener of this.listeners) await listener(event, signal)
       Agent.subscribe's docstring:              agent.js:143
         "`agent_end` is the final emitted event for a run, but the agent does
          not become idle until all awaited listeners for that event have
          settled."
     So the loop's 120-second goal check really does hold the run open, and
     `_isAgentRunActive` is still true throughout it.

   NOT GUARANTEED — and each of these is a finding or a near miss
   ────────────────────────────────────────────────────────────────────────────
   ▸ TOOL CALLS RUN IN PARALLEL.  agent.js:134  toolExecution ?? "parallel"
       executeToolCallsParallel                agent-loop.js:332
         … finalizedCalls.push(async () => { await executePreparedToolCall(…) })
         await Promise.all(finalizedCalls.map(…))
     The `tool_call` event (prepareToolCall) is emitted sequentially; the
     EXECUTION is not. Two `Agent` tool calls in one assistant message run
     `executeAgentTool` concurrently.

   ▸ COMMANDS ARE NOT ON THE AGENT'S TIMELINE. `/loop stop` reaches
     `prompt()` → `_tryExecuteExtensionCommand`, which runs "immediately, even
     during streaming" (agent-session.js:798). So a command handler can run
     inside any await above.

   ▸ ESC IS NOT EITHER. During a compaction the editor's Escape handler is
     rebound to `session.abortCompaction()`   interactive-mode.js:2703

   ▸ ctx.compact() IS FIRE-AND-FORGET and has no cancel:
       compact: (options) => { void (async () => {
           try { const r = await this.compact(…); options?.onComplete?.(r) }
           catch (e) { options?.onError?.(e) }
       })() }                                    agent-session.js:1911
     Nothing an extension holds can reach that IIFE. It outlives the session.

   ▸ A SESSION CAN BE REPLACED UNDER ANY OF IT. /new, /resume, /fork, a reload.
     `AgentSession.dispose()` then calls `_extensionRunner.invalidate(…)`
     (agent-session.js:567), after which every `pi.*` and `ctx.*` call throws.
```

### 1.4 Panel D — one delegation, with the awaits marked

```
   parent turn
     │
     ├─ model emits  Agent{prompt, agent?, run_in_background?, worktree_path?}
     │
     ├─ tool_call handlers, IN ORDER, awaited                    [sequential]
     │    prinny  needsApproval? ╍╍ up to 300 s waiting for a phone
     │    rtk     bash only
     │    subagents  toolCallListener injects model/thinking/_resolvedAgent
     │
     ├─ executeAgentTool                                          [PARALLEL with
     │    ╍╍ resolveWorktree          2 git subprocesses          any other tool
     │    ╍╍ resolveTypeWithDiscovery filesystem scan              in this batch]
     │    │
     │    └─ coordinator.spawn → manager.spawn                    [synchronous]
     │         id, record, gate, parent binding, slot or queue
     │         └─ startAgent                                      [synchronous]
     │              watchdog.start · outputLog · transcript · onStart
     │              └─ runAgent(…)                                [async]
     │                   ╍╍ detectEnv          2 git subprocesses
     │                   ╍╍ buildSubagentSession   ◄── SPAWN BRACKET
     │                   │     reloadAndMap()  every extension factory
     │                   │     createAgentSession · bindExtensions
     │                   │     ▲ depth > 0: loop, stack and subagents' own
     │                   │       factories return early
     │                   ╍╍ runSessionPrompt → session.prompt()   the child's run
     │
     ├─ foreground: ╍╍ await record.execution.promise    ← the completion GATE
     │   background: return at once; the answer arrives later as a message
     │
     └─ … the settlement chain, which is not on this timeline any more:
          .then    status ← classifyRun     ◄── TERMINAL from here
                   ╍╍ runVerification
                       ╍╍ judge   a THIRD session, 300 s deadline
                       ╍╍ repair  the CHILD's session, 300 s deadline
                   session, contextPercent, completedAt
          .catch   status ← "error", result ← undefined
          .finally settlementCount++ · undelivered steers · finalize transcript
                   · finalize output log · RELEASE SLOT · tally · drainQueue
                   · detach binding · OPEN GATE · settled = true
```

Two things on that drawing decide most of §11.

**The record is TERMINAL for the whole of the verification.** `classifyRun` runs
first and `runVerification` is awaited afterwards, so throughout a judge and up
to three repairs `lifecycle.status` reads `completed` while a model call is in
flight. Five readers know this and ask `isVerifyingRecord` instead
(`record-activity.ts`). `AgentManager.dispose()` was the sixth and did not — AM3.

**The gate opens LAST.** A foreground `Agent` call is blocked on
`record.execution.promise` from the moment it spawns until the `.finally`. Every
minute of the verification is a minute the parent's tool call is suspended, on
the one llama slot.

### 1.5 Panel E — one loop iteration, and where the operator gets in

```
   sendLoopTurn ─ pi.sendMessage({customType:"loop"}, {triggerTurn:true, …})
     │  ▲ AG2: refuses if compactionInFlight(), defers 5 s, remembers the
     │    DIRECTIVE (AH6) so an intervening agent_end cannot destroy the text
     │
     └─► sendCustomMessage                              agent-session.js:1068
           deliverAs "nextTurn"      → _pendingNextTurnMessages   (never drained
                                                                   by anything
                                                                   the loop does)
           isStreaming && triggerTurn → agent.steer()/followUp()  QUEUES
           else triggerTurn           → _runAgentPrompt()         RUNS  ← no
                                                                   compaction
                                                                   check at all
     │
     ▼
   the agent run … agent_end
     │
     ├─ 18 rungs, in order. The ones that AWAIT are marked.
     │   1  softStopRequested          → finalizeSoftStop            return
     │   2  context pressure           → contextRecoveryPending      return
     │   3  provider error   ╍╍ standDownRescue → pi.setModel        return
     │   4  degenerate abort ╍╍ interveneStuck                       return
     │   5  operator abort   ╍╍ standDownRescue                      return
     │   6  ── counters, buffers, penalties, commitTurnMemory ──
     │   7  rescue turn end  ╍╍ standDownRescue → pi.setModel        return
     │   8  detectStuck (computed here, consulted by 3 rungs below)
     │   9  goal check       ╍╍ runGoalCheck   UP TO 120 s
     │  10  --until-done + check passed                              return
     │  11  LOOP_DONE        ╍╍ interveneStuck (if stuck)            return
     │  12  LOOP_BLOCKED     ╍╍ interveneStuck (if stuck)            return
     │  13  iteration cap                                            return
     │  14  score regression                                         return
     │  15  stuck            ╍╍ interveneStuck                       return
     │  16  no-progress audit                                        return
     │  17  normal continue → scheduleLoopTurn(delay)
     │
     │   ▲ EVERY ONE of those awaits is a window in which the operator can type
     │     `/loop stop`. The handler captures `token = runToken` at the top and
     │     re-reads it after each await. That is the mechanism AM4 extends.
     │
     ▼
   agent_settled
     ├─ loop:   requestEmergencyCompaction → ctx.compact()   ◄── the two
     ├─ guard:  release pi's compaction hold                     callbacks pi
     └─ prinny: forwardResult, then a deferred /compact           holds forever
```

`interveneStuck`'s ladder inside rung 15:

```
   streak 3  and --rescue-model set  → pi.setModel(rescue)  ╍╍ awaits
                                        ONE turn, then standDownRescue (AL2)
   saturated OR streak 5             → ctx.compact()  ← reads the lock first
   otherwise                         → the directive, with an escalating delay
```

### 1.6 Panel F — the compaction, and the three senders

This is AM2 in one drawing.

```
                    WHO COMPACTS THIS SESSION
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  pi, from _checkCompaction ──┬── _handlePostAgentRun   :776              │
   │                              │      _isAgentRunActive TRUE   → senders   │
   │                              │      QUEUE. Safe.                         │
   │                              └── prompt()               :865             │
   │                                     _isAgentRunActive FALSE  → senders   │
   │                                     RUN A TURN INSIDE IT.  ← THE WINDOW  │
   │                                                                          │
   │  pi-loop-mode,  ctx.compact()   requestEmergencyCompaction               │
   │                                 interveneStuck's rung                    │
   │  prinny-channel, ctx.compact()  a Matrix /compact                        │
   └──────────────────────────────────────────────────────────────────────────┘

                    WHO ASKS BEFORE SENDING
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  pi-subagents-lite  emitIndividualNudge      AH1, 17th pass              │
   │  pi-loop-mode       sendLoopTurn             AG2, 16th pass              │
   │  prinny-channel     the empty-turn nudge     AG3, 16th pass              │
   │                                                                          │
   │  All three read one global:  __PI_COMPACTION_IN_FLIGHT__                 │
   │    { owner: string, at: number }  ·  stale after 300 s                   │
   └──────────────────────────────────────────────────────────────────────────┘

   BEFORE this pass          the lock had two writers and pi was not one of
                             them, so all three readers were blind to the
                             compaction that happens most.

   NOW                       .pi/extensions/compaction-guard takes it for pi at
                             `session_before_compact` — which pi emits from BOTH
                             entry points, for every reason — and releases it at
                             session_compact, agent_start, agent_settled and
                             session_shutdown.

   What a turn inside a compaction costs, from pi's own source:
     · Agent.prompt() → createContextSnapshot() = messages.slice(): the run is
       built from a COPY of the PRE-compaction context, i.e. the oversized one
       the compaction exists to shrink, and the compaction finishing does not
       change it.
     · compact() ends `this.agent.state.messages = sessionContext.messages`
       (:1434) — it REPLACES the array the run is streaming into.
     · Two model calls on a one-slot llama server, one of them the summariser.
     · _runAgentPrompt's finally emits agent_settled, so a whole
       agent_start … agent_end … agent_settled cycle runs INSIDE the compaction
       window and re-enters every handler in the stack.
```

### 1.7 Panel G — the load order, and the four things that depend on it

`ExtensionRunner.emit` iterates `this.extensions` in order, so **registration
order is behaviour**. The order comes from a shell script, and pi's own merge
rule is what makes the script's assumption true:

```
   DefaultResourceLoader.reload           core/resource-loader.js:316
     extensionPaths = noExtensions ? cliEnabledExtensions
                                   : mergePaths(cliEnabledExtensions,
                                                enabledExtensions)
   mergePaths(primary, additional)                              :651
     for (const p of [...primary, ...additional]) …dedupe by canonical path

   → the `-e` flags come FIRST, in the order given, and a path that is ALSO
     discovered is deduped away rather than re-appended.
```

`scripts/pi-local.sh` therefore fixes the order:

```
   1 stack      2 browser-guard   3 loop   4 compaction-guard
   5 subagents  6 prinny          7 rtk
```

Four behaviours depend on it, and the script's comments say so for two:

```
   WHAT                            WHO MUST BE FIRST     WHY
   ──────────────────────────────  ────────────────────  ─────────────────────
   the `context` budget line       loop before guard     whichever runs second
                                                         stands down; the loop's
                                                         line is the better one
                                                         when a loop is running

   the `tool_call` approval stamp  prinny before rtk     the person approves the
                                                         command AS WRITTEN, and
                                                         rtk then declines to
                                                         rewrite it (AJ3)

   the `tool_result` output cap    loop before guard     `emitToolResult` THREADS
                                                         the content, so the loop
                                                         fingerprints the RAW
                                                         text and the guard caps
                                                         afterwards

   `session_before_compact`        loop before guard     the loop may return a
                                                         `{compaction}` handoff;
                                                         `emit` is last-truthy-
                                                         wins, so a later
                                                         extension returning one
                                                         would silently replace
                                                         it. The guard always
                                                         returns undefined.
```

The third row is worth a note. `stripShorteningMarkers` exists in
`pi-loop-mode/src/repetition.ts` to strip the guard's cap marker out of a tool
result before fingerprinting it — *"an unstripped fingerprint would be unique per
call and rule 7 could never match"*. At the shipped order the loop runs FIRST and
never sees a marker, so that defence is dormant. It is correct to keep: a
discovery-only session (no `-e` flags) orders these differently, and the cost is
one regex.

---

## 2. pi itself

### 2.1 What an extension is, and when its factory runs

An extension is a module with a default-exported factory. pi calls the factory
**once per session**, not once per process, and node's module cache means the
MODULE body runs once. So:

```
   src/events.ts

     const toolCallListener = …            ← MODULE scope: one per PROCESS
     export function setupEventListeners(pi) {
       let unregisterTerminalInput          ← FACTORY scope: one per SESSION
       pi.on("session_start", async … => {
         let x                              ← per session_start
       })
     }
```

Nothing in the type system says which you got, and the difference is one
indentation level. The fifteenth pass found its leaks there. This pass finds AM4
there too, in the other direction: `runToken` is at module scope, so it survives
a session swap — which is exactly why it has to be *moved* by one.

### 2.2 Handlers are awaited, and what that buys and costs

`ExtensionRunner.emit` awaits each handler in turn. That buys a great deal:

- Two extensions' handlers for the same event never interleave.
- A `tool_result` handler's returned content is threaded into the next handler's
  event (`emitToolResult`, `runner.js:649`).
- The `session_before_compact` result is last-truthy-wins, and a `{cancel: true}`
  short-circuits the rest.

And it costs one thing that matters here: **a slow handler delays every handler
after it, and holds the agent run open.** The loop's `agent_end` awaits
`runGoalCheck` for up to `checkTimeoutSeconds` (default 120), during which:

```
   the run is NOT settled            _isAgentRunActive stays true
   the TUI still says "Working…"
   a typed message QUEUES            _queueSteer/_queueFollowUp
   hasPendingMessages() → true       which is what deliverLoopTurn keys on
   a subagent nudge QUEUES           sendCustomMessage's isStreaming branch
   prinny's typing indicator stays up
```

Every one of those is correct behaviour, and `deliverLoopTurn`'s own comment
already names the goal check as the likeliest reason `hasPendingMessages()` is
true. It is worth writing down as a property rather than a coincidence.

### 2.3 Tool calls are parallel; `tool_call` events are not

```
   executeToolCalls                          agent-loop.js:287
     if (config.toolExecution === "sequential" || hasSequentialToolCall)
        → executeToolCallsSequential
     → executeToolCallsParallel

   agent.js:134   this.toolExecution = runtimeOptions.toolExecution ?? "parallel"
```

In `executeToolCallsParallel` the loop over tool calls does two things per call —
`await emit(tool_execution_start)` and `await prepareToolCall(…)`, which is where
the `tool_call` extension event fires — and then pushes a **thunk**. The thunks
are run under `Promise.all`.

So on this stack:

```
   tool_call handlers          strictly sequential, in load order, per call
   executeAgentTool            CONCURRENT with every other tool in the batch
   tool_result handlers        sequential again, in call order, after Promise.all
```

Two `Agent` tool calls in one assistant message therefore run `executeAgentTool`
concurrently. What that reaches:

```
   resolveWorktree             per-call locals; two git subprocesses each
   resolveTypeWithDiscovery    → discoverNewAgents → a module-level Map.
                               Two concurrent scans both `agents.set` names that
                               are missing. Idempotent; checked, not a finding.
   coordinator.spawn           synchronous through manager.spawn; the SlotTable
                               is read and reserved with no await between, so
                               two spawns cannot both take the last slot.
   enterSubagentSpawn()        a DEPTH counter, not a boolean — two overlapping
                               spawn brackets leave it >0 until both exit.
```

The concurrency limit is 1 by default, so the second `Agent` call usually
**queues** rather than running. It does not queue when the two resolve to
different model keys with different per-model or per-provider slots, which is
reachable through `/agents` → models.

### 2.4 The two compaction call sites, and why only one is dangerous

```
   _checkCompaction(assistantMessage, skipAbortedCheck)     :1510
     called from
       _handlePostAgentRun()   :776   inside _runAgentPrompt's while loop
       prompt()                :865   after the isStreaming branch returned
```

The difference is `_isAgentRunActive`:

```
   _runAgentPrompt(messages) {                              :744
       this._isAgentRunActive = true;
       try { await this.agent.prompt(messages);
             while (await this._handlePostAgentRun())  ← the compaction is HERE
                 await this.agent.continue(); }
       finally { … await this._emitAgentSettled(); }        ← cleared HERE
   }
```

So during the post-run compaction the session is BUSY and any
`sendCustomMessage(triggerTurn)` takes the steer/followUp branch and queues. Safe
by construction.

During `prompt()`'s pre-run compaction the session is IDLE, `isIdle()` returns
true, and `sendCustomMessage` takes `await this._runAgentPrompt(appMessage)` at
`:1088` — which checks nothing. `prompt()` itself refuses (`:807`), but nothing
this stack sends goes through `prompt()` except `prinny`'s `sendUserMessage`.

That asymmetry is the whole of AM2's reachability argument, and it is why the fix
is worth the four release rungs: the dangerous window is the one an operator's
typed message and a Matrix message both open.

### 2.5 `session_before_compact` is emitted for every compaction; `session_compact` is not

```
   compact()                                    _runAutoCompaction()
     :1389  emit session_before_compact           :1613  emit session_before_compact
     …                                            …
     :1441  emit session_compact   ── SUCCESS ──  :1679  emit session_compact
     catch: emits NOTHING to extensions           catch: emits NOTHING
```

Both are gated on `this._extensionRunner.hasHandlers("session_before_compact")`,
and two extensions in this stack register one, so the START of every compaction
is observable. The END is observable only when it succeeds.

`compaction_start` / `compaction_end` are `_emit` — the **listener** channel,
which `AgentSession.subscribe` reaches and an extension does not. That is what
the handoff's standing item was about, and it named the wrong event: the fact
that `compaction_start` is unavailable does not mean the compaction is
unobservable, because `session_before_compact` is.

`AgentSession.isCompacting` exists (`:647`, covering auto, manual and branch
summarisation) and is **not** on `ExtensionContext` — `createContext` at
`runner.js:456` lists what is, and it is not there. So an extension cannot ask
pi; it has to observe.

### 2.6 What a session swap does to everything an extension is holding

```
   AgentSession.dispose()                                     :556
     abortRetry() · abortCompaction() · abortBranchSummary() · abortBash()
     this.agent.abort()
     this._extensionRunner.invalidate("This extension ctx is stale after …")
     this._disconnectFromAgent()
     this._eventListeners = []
```

Three consequences this pass depends on:

1. **`abortCompaction()` means a swap CANCELS an in-flight compaction**, and pi's
   `compact()` turns that into `throw new Error("Compaction cancelled")` — which
   `isBenignCompactionError` correctly does not swallow. So a swap does not merely
   leave a callback dangling; it is what FIRES it. (AM4.)
2. **`invalidate()` makes every later `pi.*`/`ctx.*` call throw.**
   `assertActive()` is `if (this.staleMessage) throw new Error(this.staleMessage)`
   (`runner.js:358`), and `appendEntry` is
   `runtime.assertActive(); runtime.appendEntry(…)` (`loader.js:271`).
3. **`_disconnectFromAgent()` means a disposed session still accepts `prompt()`
   and simply reports nothing.** It is not subscribed to its agent any more, so
   `message_end` never reaches `collectResponseText` and the run returns `""`.
   That is the mechanism behind AM3's damage, and it is why the symptom is a
   *wrong verdict* rather than a crash.

---

## 3. The event bus

### 3.1 The table, with the question this pass asks of each

`can a run start here?` is "is `_isAgentRunActive` false at this point, so that a
`sendCustomMessage(triggerTurn:true)` would take `_runAgentPrompt` rather than
queueing?"

```
   EVENT                    EMITTED FROM                 RUN ACTIVE?  RESULT?
   ───────────────────────  ───────────────────────────  ───────────  ────────
   session_start            bindExtensions               no           no
   session_shutdown         teardownCurrent              no           no
   before_agent_start       prompt() only                no→yes       messages
   agent_start              agent.prompt                 yes          no
   turn_start / turn_end    the agent loop               yes          no
   message_start/_update    the agent loop               yes          message_end
   message_end                                                        threads
   tool_call                prepareToolCall              yes          block/allow
   tool_result              after Promise.all            yes          threads
   context                  before each provider call    yes          messages
   before_provider_request  before each provider call    yes          payload
   agent_end                the agent loop               YES          no
   agent_settled            _emitAgentSettled            NO ← note    no
   session_before_compact   compact / _runAutoCompaction depends      compaction
   session_compact          both, on SUCCESS only        depends      no
```

**`agent_settled` is the interesting row.** `_emitAgentSettled` sets
`_isAgentRunActive = false` and *then* emits, so every `agent_settled` handler
runs on a session that reads as idle. Three of them do real work there:

```
   loop     requestEmergencyCompaction → ctx.compact()   ← starts a compaction
   guard    releases pi's hold                            ← AM2
   prinny   forwardResult → a sidecar round trip, and possibly
            api.sendUserMessage(nudge) — which is prompt(), i.e. it STARTS A RUN
            while the handlers after it are still executing
```

prinny's is deliberate and bounded: `standAside` (AE2) exists precisely because
`forwardResult` may have started a run that a deferred `/compact` would abort. It
is worth naming as the one place in the stack where a handler starts a run inside
its own event.

### 3.2 Which emitters thread a result

```
   emit()                generic. session_before_* only; LAST TRUTHY WINS,
                         `cancel` short-circuits.       runner.js:579
   emitMessageEnd()      threads `message` through handlers in order.  :610
   emitToolResult()      threads content/details/isError/usage.        :649
   emitToolCall()        first block wins.                             :701
   emitContext()         threads `messages`.                           :747
   emitBeforeProviderRequest()  threads `payload`.                     :776
   emitBeforeAgentStart()       COLLECTS messages from all handlers.   :837
```

For this axis the relevant one is `emit()`'s last-truthy-wins on
`session_before_compact`: a handler that returns `{compaction}` can be silently
overridden by a later one. Only the loop returns one, and the guard — which runs
after it — always returns `undefined`. That is load-bearing and is asserted by
the guard's own tests.

---

## 4. The loop — `vendor/pi-loop-mode`

A fork of pi-loop-mode 2.5.4. Registers `/loop`, a `loop` tool, and thirteen
event handlers. All of its state is module-scoped:

```
   state: LoopState        the run: goal, counters, streaks, check verdict
   runToken                a monotonic counter; every transition moves it
   pendingTimer            ONE slot: the delay, the backoff, the cooldown, the
                           watchdog re-arm, and AG2's compaction deferral
   degenerateAbortPending  set mid-stream, consumed in agent_end
   emergencyCompactionPending / ownCompactionInFlight / waitingForCompaction
   deferredDirective       AH6: the TEXT of a directive held for a compaction
   contextRecoveryPending  { reason, token }
   4 per-turn buffers      assistant texts, answers, repetition texts, tool calls
```

**Inert inside a subagent spawn.** The factory returns early when
`__PI_SUBAGENT_SPAWN_DEPTH__ > 0`, because a child binds this same module and
would run all thirteen handlers against the operator's loop.

### 4.1 `runToken` — the mechanism this pass extends

Its own docstring:

> Monotonic run token. Incremented on every start/resume/stop/end. All async
> continuations (timers, `agent_end` tails after awaits, compaction callbacks)
> capture it and bail out when it changed, so a `/loop stop` issued mid-await can
> never be overridden by stale code paths.

Who moved it before this pass:

```
   runLoop            /loop start, /loop run
   resume             /loop resume
   stop / end         /loop stop, /loop end, /loop clear
   finalizeSoftStop   /loop finish, and the three places that finalize one
   pauseForContextFailure · pauseForCheckFailure · pauseForProviderFailure
   the operator-abort rung in agent_end            (AE1, fourteenth pass)
   ──────────────────────────────────────────────────────────────────────
   session_start      ✘                                          AM4
   session_shutdown   ✘                                          AM4
```

Who READS it:

```
   scheduleLoopTurn's timer          token !== runToken → return
   scheduleWatchdogTurn's timer      same
   agent_end's tail after every await
   interveneStuck after switchModel
   requestEmergencyCompaction's onComplete / onError / catch
   interveneStuck's ctx.compact onComplete / onError / catch
   agent_settled's contextRecoveryPending.token
   session_compact's contextRecoveryPending.token
```

The last four are the ones a session swap can reach, and §11.4 is why.

### 4.2 The single timer slot

`pendingTimer` is one variable and five things write it. `clearPendingTimer()` is
called at the top of `scheduleLoopTurn`, `scheduleWatchdogTurn`, `agent_end`,
`session_start`, `session_shutdown` and every stop path. That is deliberate — a
loop has one next turn — and AH6 is the finding that came out of it: the DIRECTIVE
text was carried by the timer, so an intervening `agent_end` clearing the timer
destroyed a decision the ladder had already been charged for. The repair was to
remember the kind (`deferredDirective`) rather than the timer.

The same shape, one package over, is AM6: one timer, two deadlines.

### 4.3 The goal check holds the run open

`runGoalCheck` is `pi.exec("bash", ["-lc", wrapCheckCommand(cmd)], { timeout })`
inside `agent_end`. Three properties measured rather than assumed:

- `pi.exec` **never rejects** — `execCommand` is `new Promise((resolve) => …)`
  with no `reject` in it. A timeout kills the child and resolves; a spawn error
  resolves `code: 1`.
- A signalled child resolves `{ code: 0, killed: false }` — the shape of a check
  that PASSED. So the wrapper prints a completion marker from a bash `EXIT` trap
  and its absence is the evidence (AB1).
- The whole thing runs inside an awaited `agent_end` handler, so it holds the
  agent run open for up to `checkTimeoutSeconds`.

---

## 5. Subagents — `vendor/pi-subagents-lite`

A fork of pi-subagents-lite 1.11.0. Registers `Agent`, `StopAgent`,
`AgentStatus`, `/agents`, a widget, and eight event handlers.

### 5.1 The record, and the five things that can reach it

```
   AgentRecord
     lifecycle   status · startedAt · completedAt · stoppedBy · started
     display     type · description · outputFile · invocation · worktree
     execution   session · brief · abortController · verifyAbort · promise(GATE)
                 pendingSteers · outputLog · transcript · modelKey · holdsSlot
                 settled · settlementCount · spawnCtx · talliedCost · liveView
     stats       lifetimeUsage · verifyUsage · toolUses · turnCount · maxTurns
                 compactionCount · contextPercent

   REACHED BY
     the settlement chain       .then / .catch / .finally
     the operator               /agents menus, the viewer, Esc
     the model                  StopAgent, AgentStatus
     the machinery              the watchdog tick, the widget's 80 ms poll,
                                the nudge batch
     the teardowns              clear() → removeRecord, dispose()
```

Five of those can run during the settlement chain's `await runVerification`, and
`isVerifyingRecord` is the predicate that tells them so. `record-activity.ts`
exists because the question had three answers in three files; it now has five
readers and one definition — six, since AM3 added the teardown.

### 5.2 The completion gate

Created at spawn, opened exactly once at the terminal transition, never assigned
the run's own promise. Opened by: the settlement `.finally`, a queued stop, a
start failure, an already-aborted spawn, `removeRecord`, and `dispose()` for
queued records. `openGate` is idempotent — the resolver is dropped on first open —
so a continuation's second settlement is a no-op.

The gate is what makes a foreground delegation a *blocking* call, and therefore
what makes every await inside the verification a suspension of the parent's turn.

### 5.3 Concurrency, and why the slot table is exact

`SlotTable` counts by `holdsSlot`, not by `status === "running"`, because the
slot is held right through the verification window where the status is already
terminal. Counting by status would free the slot early and let a queued subagent
start while the previous one's judge is still on the provider.

The default limit is **1** — measured: a child that grew to 18k tokens took the
parent's next call from 2,117 cached tokens to zero and from 442 ms to 2,949 ms.

### 5.4 The spawn bracket

`enterSubagentSpawn()` / `exitSubagentSpawn()` wrap `reloadAndMap()` +
`createAndConfigureSession` only — not the child's run. It is a DEPTH counter and
is published on `globalThis.__PI_SUBAGENT_SPAWN_DEPTH__` so packages that must
not import each other can read it. Three factories read it: `pi-loop-mode` and
`.pi/extensions/stack.ts` return early; `.pi/extensions/compaction-guard` now
reads it too, and gates only its lock-taking on it (§7).

Concurrency note: two overlapping spawns leave the depth above zero for the union
of their brackets. That is correct — both are spawning — and it is why the flag is
a counter rather than a boolean.

---

## 6. The verifier

Three layers, cheapest first: the **anchor** (no model call — restate the brief
after a compaction, but only into a run that was going to happen anyway), the
**structural gate** (no model call — empty answers and cut-off runs), and the
**judge** (one small model call, in a session of its own with no tools and one
turn), with up to `SUBAGENT_VERIFY_ROUNDS` repairs, each re-judged.

For this axis, four properties matter:

```
   1. It runs INSIDE the settlement chain's .then, after the status has gone
      terminal. So the record reads `completed` for the whole of it.
   2. It holds the concurrency SLOT and keeps the completion GATE shut.
   3. Every call is bounded by `startDeadline`, which composes the timer with
      `record.execution.verifyAbort` — so an operator's Esc and a 300 s deadline
      end the same call, whichever comes first.
   4. `verifyAnswer` NEVER THROWS. Its catch is this layer's "the check did not
      happen" path: the child's answer is preserved and annotated `errored`.
```

Property 4 is what AM3 turns on. There are two ways for a verification to end
badly, and they produce opposite sentences to the parent model:

```
   the repair RETURNS NOTHING     → structuralVerdict("") → ok:false
                                  → "[verification: this answer was checked
                                     against the task and did not address it…
                                     Treat it as unreliable.]"

   the repair THROWS              → verifyAnswer's catch
                                  → "[verification: the check did not complete,
                                     so this answer went out unchecked.]"
```

A disposed session produces the first. An aborted verifier produces the second.
Probe `z3 answer` prints both.

---

## 7. The guard — `.pi/extensions/compaction-guard`

Three jobs, all measured over 42 real compaction points and 259 assistant turns:
cap the summary pi carries forward, show the model its context budget above 60%,
and cap a single tool result to a share of what context is LEFT.

It is loaded in **every** session — and, unlike the loop and stack, it is NOT
inert in a child. `.pi/extensions/**` is on a child's discovery route and that is
deliberate: capping a child's own tool output is one of the things it is for.

This pass gives it a fourth job — taking the compaction lock on pi's behalf
(§11.2) — and that fourth job is the one thing that must **not** happen in a
child, because the lock is process-global and the question is per-session. So the
factory captures `bornInsideSubagentSpawn()` once and gates only the lock on it.

One consequence, stated rather than guarded: an operator `/reload` that lands
inside a child's session BUILD would make the parent's own instance read as a
child's and never take the lock for that session. That is a return to the
behaviour of every pass before this one, not a new failure.

---

## 8. prinny — `vendor/prinny-channel`

```
   Matrix  ⇄  sidecar (child process, MCP over stdio)  ⇄  extension  ⇄  pi
```

The sidecar is a separate process because `@prinny/bot` pulls in matrix-js-sdk
and its Rust crypto WASM: loading it is ~15 s of *synchronous* work in-process,
and the library writes to stdout while it loads.

For this axis the sidecar's cost is the finding. `src/config.ts` measures the
import at **27.5 s in this container**, and `connectTimeoutSeconds` is **120**
because of it. So `startChannel`'s single `await instance.start()` is the longest
await in the stack, and until this pass `child` — the only handle any stop had —
was assigned on the line after it (§11.1).

The extension's other long awaits:

```
   requestApproval        permissionTimeoutSeconds, default 300 s
   forwardToMatrix        requestTimeoutSeconds, default 120 s
   runPrepare             an npm install, about a minute
   stopChannel            McpChild.stop: SIGTERM, SIGKILL after 5 s
```

---

## 9. rtk and stack

`vendor/rtk-pi` registers one `tool_call` handler, for `bash` only, and awaits
`rtk rewrite` with a 2-second timeout inside it. It runs AFTER prinny and
declines to rewrite a command a person approved as written (AJ3) — an ordering
dependency the launch script states out loud.

`.pi/extensions/stack.ts` registers `/stack` and a read-only `stack_status` tool,
and is inert in a child. Its command handler awaits `pi.exec` for up to 600
seconds (`/stack up`) and `ctx.ui.confirm` for as long as a person takes. Both are
inside a command handler, which pi runs on the TUI's timeline rather than the
agent's — so they suspend the operator, not the run.

---

## 10. What has to stay true

### 10.1 The invariants, and the sixth this pass adds

```
   1  The completion gate is opened exactly once, and never with the run's own
      promise.
   2  A record's concurrency slot is held for as long as `holdsSlot`, which is
      wider than `status === "running"` — it covers the verification.
   3  `verifyAnswer` never throws. An unverified answer beats no answer.
   4  A delivery that did not happen is the loudest thing this stack can report.
   5  Vendor packages do not import each other. Shared facts are `globalThis`
      keys with a stated protocol and a cross-package test.
   ──────────────────────────────────────────────────────────────────────────
   6  A construct with two teardowns has one ORDER, written in one function.
      (AM3, AM5 — and it is the rule §0.2 shape 3 asks for.)
```

### 10.2 The interleaving ledger — this pass's artefact

Every `await` in the stack that a handler, a settlement chain or a callback can
be suspended at. **HOW LONG** is the realistic upper bound. **GUARDED** says
whether something re-reads the world afterwards.

```
   #   WHERE                                      HOW LONG      GUARDED BY
   ──  ─────────────────────────────────────────  ────────────  ─────────────────
   SUBAGENTS
    1  executeAgentTool → resolveWorktree          ~100 ms       n/a, locals only
    2  executeAgentTool → resolveTypeWithDiscovery  fs scan      n/a, idempotent
    3  coordinator.spawn → await the GATE           the run      the gate itself
    4  runAgentImpl → detectEnv                    ~100 ms       n/a
    5  runAgentImpl → buildSubagentSession          seconds      spawn DEPTH
    6  runTurnLoop → session.prompt                 the run      abort signal
    7  settlement .then → runVerification           4 × 300 s    verifyAbort ✘AM3
    8  verifyAnswer → deps.judge / deps.repair      300 s each   startDeadline
    9  steer() → session.steer                      ms           status re-read
   10  session_start → loadConfigAndRegisterAgents  fs scan      n/a
   11  openViewer → ctx.ui.custom                   a person     viewerOpen flag
   12  session_shutdown → mgr.dispose               sync         —
   13  the nudge batch timer                        200 ms/5 s   disposed ✘AM6
   14  the widget poll                              80 ms        uiCtx/manager
   15  the watchdog tick                            5 s          isRunning fn

   LOOP
   16  agent_end → runGoalCheck                     120 s        runToken ✔
   17  agent_end → interveneStuck → pi.setModel     seconds      runToken ✔
   18  agent_end → standDownRescue → pi.setModel    seconds      runToken ✔
   19  loopCommand → switchModel                    seconds      —
   20  allowModelCheck → ctx.ui.confirm             a person     —
   21  ctx.compact() onComplete / onError           NO BOUND     runToken ✘AM4
   22  pendingTimer (delay/backoff/cooldown)        up to 300 s  runToken ✔

   PRINNY
   23  startChannel → instance.start()              120 s        `child` ✘AM1
   24  stopChannel → instance.stop()                5 s          shuttingDown
   25  requestApproval                              300 s        pendingPermissions
   26  forwardToMatrix → child.callTool             120 s        child?.running
   27  runPrepare → an npm install                  ~60 s        —
   28  startCompaction → ctx.compact callbacks      NO BOUND     the lock owner

   GUARD / RTK / STACK
   29  tool_result → spill write                    ms           —
   30  rtk tool_call → rewriteCommand               2 s          fail-open
   31  rtk factory → rtk --version                  2 s          killed check
   32  /stack up|down|restart → pi.exec             600 s        a command handler
   33  /stack → ctx.ui.confirm                      a person     —

   PI ITSELF, for completeness
   34  _checkCompaction from prompt()               summariser   NOTHING  ✘AM2
   35  _checkCompaction from _handlePostAgentRun    summariser   isStreaming ✔
```

Six of the thirty-five carried a **✘**. Three of the six are rows 7, 21 and 28 —
the three places where something is suspended for an **unbounded** or
**many-minute** period and the world it will resume into is a different one.

### 10.2.1 The findings by DISTANCE

The fifteenth pass's most useful statistic was that seven of nine of its findings
were "distance zero" — the correct version of the same construct visible on
screen. This axis has a different distribution, and it says something about where
to look:

```
   AM1  the two functions are 90 lines apart, in one file.       distance 1
   AM2  the writer and the reader are in FOUR packages.          distance 4
   AM3  the two teardowns are 45 lines apart, in one class.      distance 0
   AM4  the eleven bumps and the two gaps are one file.          distance 0
   AM5  the clear and the settlement are two files, one event.   distance 2
   AM6  one function.                                            distance 0
```

**Three of six are distance zero and all three are "two paths, one construct".**
The other three are distance ≥1 and all three are "a producer and a consumer that
never look at each other's timeline". So the two searches are different:

```
   for shape 3  open every function that ends something and ask what ELSE ends
                the same thing. If there are two, they have already drifted.
   for shape 1  open every `await` and ask what was read above it.
   for shape 4  find every construct with ONE slot and TWO writers with
                different urgencies.
```

### 10.3 The bounds, all of them

```
   WHAT                              BOUND        WHERE
   ────────────────────────────────  ───────────  ──────────────────────────────
   a subagent's turns                40           turn-tracking.ts
   grace turns after the soft limit  6            config-io.ts
   verification rounds               1 (max 3)    verify-runner.ts
   one verification model call       300 s        DEFAULT_VERIFY_TIMEOUT_MS
   the accumulated brief             6,000 ch     MAX_BRIEF_CHARS
   the judge's view of it            1,500 ch     JUDGE_BRIEF_CHARS
   the judge's view of the answer    4,000 ch     JUDGE_ANSWER_CHARS
   transcript entries per agent      60           transcript-entry.ts
   chars / lines per entry           4,000 / 120  ditto
   verify-log lines                  2,000        verify-log.ts
   spill files per directory         50           spill.ts
   spill directories                 dead pids    spill.ts (AL9)
   the loop log                      5 MB         loop-log.ts
   the compaction lock               300 s        compaction-lock.ts ×4
   provider errors before a pause    10           MAX_PROVIDER_ERRORS
   context cooldowns before a pause  3            MAX_CONTEXT_COOLDOWNS
   goal-check errors before a pause  3            MAX_CHECK_ERRORS
   the MCP handshake                 120 s        connectTimeoutSeconds
   a permission request              300 s        permissionTimeoutSeconds
   a compaction deferral (AH1/AG2)   the lock's 300 s
   a Matrix /compact standing aside  COMPACTION_DEFER_LIMIT
   ────────────────────────────────  ───────────  ──────────────────────────────
   a ctx.compact() callback          NONE         §11.4 is what to do instead
```

The last row is the one this pass adds to the table. There is no way to bound it —
pi holds it and offers no handle — so the only defence is that everything it
touches re-reads a token first.

### 10.4 The globals

Three keys on `globalThis`, all of them because vendor packages must not import
each other:

```
   __PI_SUBAGENT_SPAWN_DEPTH__   a NUMBER (a depth, not a flag).
                                 written by pi-subagents-lite/src/shell.ts
                                 read by pi-loop-mode, stack.ts, and — new this
                                 pass — compaction-guard
   __PI_COMPACTION_IN_FLIGHT__   { owner, at }, stale after 300 s.
                                 written by pi-loop-mode, prinny-channel, and —
                                 new this pass — compaction-guard, on pi's behalf
                                 read by all three plus pi-subagents-lite
   (pi's own)                    nothing else in this stack writes a global
```

Four implementations of the compaction protocol now. The cross-check test in
`vendor/pi-loop-mode/tests/compaction-lock.test.ts` imports all four and asserts
they agree on the key, the bound, and that the owner names are distinct — because
a protocol with four implementations is worth exactly as much as the assertion
that they agree.

---

## 11. The findings

Six, AM1–AM6, all fixed, each with a regression test that fails when the fix is
removed and a probe that prints BEFORE and NOW so it is its own control.

### 11.1 AM1 — the stop that could not see the start

**Shape 1 and 2.** `vendor/prinny-channel/extensions/index.ts`

`startChannel` built the sidecar, awaited its MCP handshake, and assigned the
module-level `child` on the line after:

```js
   starting = (async () => {
     try {
       await instance.start();      // ← everything below is a different turn
       child = instance;            // ← the FIRST moment a stop can see it
```

Every line of `stopChannel` reads `child`. So a stop that arrived during the
handshake found nothing to stop, ran its teardown against an empty channel,
returned — and the sidecar it could not see published itself afterwards.

**The window is not microseconds.** `src/config.ts`'s own note measures importing
the built sidecar at **27.5 s in this container**, and sets
`connectTimeoutSeconds` to **120** because of it. Four callers land in it:

```
   /prinny stop        answered "channel stopped."   the channel came up anyway
   /prinny restart     stop + start. The stop did nothing, and the start hit
                       `if (starting) return starting` — so it was handed the
                       FIRST start's promise, reported that one's outcome as its
                       own, and never restarted anything.
   /prinny configure   the same shape, and this is the command whose whole job is
                       to REPLACE the credentials the in-flight start is using —
                       run, typically, in the session that just started it.
   session_shutdown    `await stopChannel()` returned in milliseconds and left a
                       sidecar logging into Matrix for a session that had ended.
```

**A disowned sidecar is not inert.** It goes on to log in and open the Olm crypto
store, and `server/src/state.ts` — the file that hands `buildBot` that path — says

> Everything lives under one directory so a second bot on the same machine is a
> matter of pointing `PRINNY_STATE_DIR` somewhere else — **including the crypto
> store, which must never be shared between two running bots.**

So the version of `/prinny restart` that appeared to do nothing was in fact the
one that produced two.

**The control is one directory away, and it is the same author in the same week.**
`server/src/connect.ts` was extracted in the twenty-first pass (AL3) for exactly
this class of problem on the *sidecar's* side, and its header states the rule:

> Nothing is owned until this RESOLVES: if it throws there is nothing to discard,
> which is why the device-ID lookup belongs in here and the login does not.

The extension side had the same split and no handle on the middle of it.

**The fix.** `src/channel-lifecycle.ts`, a module with no imports:

- a **token** the start captures and the stop moves, re-read after every await —
  the same mechanism `pi-loop-mode` calls `runToken`, written down rather than
  left implicit in two functions ninety lines apart;
- the in-flight **instance**, held so a stop can END it rather than wait for it.

Ending rather than waiting is the load-bearing choice: the handshake's own budget
is two minutes, and a `session_shutdown` that blocked for two minutes would be a
worse bug. `McpChild.stop()` is bounded (SIGTERM, SIGKILL after a 5 s grace) and
it calls `failPending`, which rejects the in-flight `initialize` — so the start's
own `catch` runs at once and the awaited promise returns immediately instead of
sitting out its timeout.

Extracted rather than kept as three `let`s, for the reason `connect.ts` was:
`extensions/index.ts` imports `@earendil-works/pi-tui`, `@earendil-works/pi-ai`
and `typebox` at runtime, none of which resolve under the bare
`node --experimental-strip-types --test` the suite runs on — which is why six
suites in `tests/` assert on that file's SOURCE TEXT. The twentieth pass is about
exactly that gap.

`/prinny status` gained a third state on the way: a start in flight used to draw
as "not running", which is the honest-looking answer at exactly the moment the
operator is most likely to ask.

**Tests.** `vendor/prinny-channel/tests/channel-lifecycle.test.ts`, 10 tests.
**Control run: 6 of 10 fail with the fix reverted**, and the four that pass are
the controls. **Probe** `z1`, four modes.

### 11.2 AM2 — the compaction the lock could not see

**Shape 4.** `.pi/extensions/compaction-guard/`

Three senders in this stack ask "is somebody compacting this session right now?"
before they start a turn:

```
   pi-subagents-lite  SpawnCoordinator.emitIndividualNudge      AH1, 17th pass
   pi-loop-mode       sendLoopTurn                              AG2, 16th pass
   prinny-channel     the empty-turn continuation               AG3, 16th pass
```

All three could only ever see the two EXTENSIONS that compact. The third
compactor is **pi**, and it is the one that compacts most.

The handoff has carried this as open for seven passes, in these words:

> **One bound, unchanged for seven passes:** the compaction lock can only be read
> for compactions an *extension* asked for. pi emits `compaction_start`
> internally (`agent-session.js:1370`) but not as an `ExtensionEvent`.

That sentence is true about `compaction_start`, and it names the wrong event.
`session_before_compact` **is** an `ExtensionEvent`, and pi emits it from both of
its compaction entry points — `compact()` at `:1389` and `_runAutoCompaction()`
at `:1613` — for every reason there is, whenever any extension has a handler for
it. Two in this stack do. **The start of every pi compaction has been observable
all along.**

**Which window is actually dangerous.** Not both of pi's call sites:

```
   _handlePostAgentRun()  :776   _isAgentRunActive TRUE  → sendCustomMessage
                                 takes the isStreaming branch and QUEUES. Safe.
   prompt()               :865   _isAgentRunActive FALSE → sendCustomMessage
                                 takes `await this._runAgentPrompt(appMessage)`
                                 at :1088, which checks NOTHING.
```

`prompt()` is what an operator's typed message reaches, and what
`prinny-channel`'s `sendUserMessage` reaches. So a Matrix message arriving on a
session over the compaction threshold opens a multi-second window in which the
session reads as idle, the lock reads as free, and any of the three senders will
start a whole agent run inside the compaction — built from a `messages.slice()`
of the PRE-compaction context, into an array `compact()` is about to replace.

**The fix.** `.pi/extensions/compaction-guard/src/compaction-lock.ts`, the fourth
copy of the protocol, with one new owner name: `PI_OWNER = "pi"`. Deliberately the
host's name and not the extension's — every reader's sentence is
`${holder.owner} is compacting`, and "compaction-guard is compacting" would name
the wrong actor to an operator reading a notice.

Taken at `session_before_compact`, released at **four** events. One is not enough:
`session_compact` fires only on the SUCCESS path, so a compaction the operator
cancelled with Esc (`interactive-mode.js:2703` → `session.abortCompaction()`) or
one whose summariser failed has no closing extension event at all. Left at that,
the hold would fall through to `STALE_MS` — five minutes of an unattended loop
deferring every turn because one compaction was cancelled, which is worse than
the collision. `agent_start` and `agent_settled` are both strictly after any
compaction pi can run; `session_shutdown` is there because the lock is
process-global and the session is not.

**The one thing that had to be got right.** The lock is process-global and the
question it answers is per-SESSION. That has never mattered, because the two
packages that take it are inert inside a subagent's session — and **this
extension is not**. A subagent's session compacts, and a child's compaction must
not hold back the parent's loop turns and delegation results. So the take is
gated on the factory-time answer to `bornInsideSubagentSpawn()`, the same
question, asked the same way, that `pi-loop-mode` and `stack.ts` already ask
before registering anything at all.

**Tests.** `.pi/extensions/compaction-guard/tests/pi-compaction-lock.test.ts`, 19
tests, reading the lock through `vendor/pi-subagents-lite`'s own read-only copy —
i.e. through one of the three actual readers, not through the writer's view of
itself. Plus 2 more in the cross-check suite, now covering all four
implementations. **Control runs: removing the take fails 4 of 19; removing one
release rung fails 2 of 19.** **Probe** `z2`, four modes.

### 11.3 AM3 — the teardown that ended the session the verifier was running in

**Shape 3.** `vendor/pi-subagents-lite/src/agents/agent-manager.ts`

A record owns three things that have to be ended. `dispose()` ended two:

```js
   record.execution.transcript?.dispose();
   record.execution.transcript = undefined;
   record.execution.session?.dispose();      // ← the session a REPAIR runs in
   this.detachParentBinding(record);
```

`stopAgent()` has known how to end a record whose verifier is still working since
T5, and its comment says the abort is for

> the operator's Esc, for `StopAgent`, and for anything else that asked.

`session_shutdown` is something else that asked, and it did not.

**The consequence is not a crash, which is why it is worth writing down.**
`AgentSession.dispose()` aborts the agent and calls `_disconnectFromAgent()`, so
a `prompt()` afterwards still reaches the provider and its events reach nobody:

```
   dispose() disposes the session
   → the repair's continueAgentSession() prompts it anyway
   → one model call on the one llama slot, during a session teardown
   → collectResponseText sees no message_end at all           → ""
   → structuralVerdict("")                                    → ok: false
   → verifyAnswer returns verificationNote("failed", …)
   → the child's perfectly good ORIGINAL answer goes back annotated
     "this answer was checked against the task and did not address it …
      Treat it as unreliable."
```

The check being torn down is reported to the parent model as the **child** having
failed. That is the exact inversion `verifyAnswer`'s "never throws" contract
exists to prevent, arriving from the outside.

Probe `z3 answer` prints the two sentences:

```
   BEFORE  errored?  no — status `failed`
           "[verification: this answer was checked against the task and did not
             address it, and one attempt to correct it did not fix it. This is
             the agent's original answer, kept because the corrections were no
             better. Treat it as unreliable.]"

   NOW     status `errored`
           "[verification: the check did not complete, so this answer went out
             unchecked.]"
```

**And the two teardowns had already drifted.** `removeRecord` cleared
`execution.session` and `dispose()` did not; neither ended the verifier. Two
teardowns for one record is how that happens, and it is invisible because each is
individually reasonable.

**The fix.** `src/agents/record-teardown.ts` — one function, one order,
`transcript → verifier → session`, with every step guarded on its own so that a
transcript that throws on the way out is not the reason a session is left
running. Both call sites use it. `verifyAbort` is deliberately NOT cleared there:
`runVerification`'s own `finally` owns that field, and clearing it here would race
that and could leave `isVerifyingRecord` reading a record as idle while its catch
is still running.

**Tests.** `vendor/pi-subagents-lite/tests/record-teardown.test.ts`, 9 tests — 7
on the order, 2 driving the real `verifyAnswer` for both outcomes. **Control run:
5 of 9 fail with the fix reverted.** **Probe** `z3`, three modes.

### 11.4 AM4 — the callback that outlived its session

**Shape 1.** `vendor/pi-loop-mode/extensions/index.ts`

`runToken` exists for exactly this and says so — *"incremented on every
start/resume/stop/end"*, so that *"all async continuations (timers, `agent_end`
tails after awaits, compaction callbacks) capture it and bail out when it
changed"*. Eleven places move it. **The two SESSION transitions did not.**

A session swap is the transition that invalidates the most: it replaces `state`
wholesale via `restoreState`, and it makes the `pi` and `ctx` every surviving
continuation captured stale, because pi calls `_extensionRunner.invalidate()` on
the old one.

**Exactly one continuation survives a swap**, and that is why this took
twenty-two passes to notice. `session_start` clears `pendingTimer` and drops the
turn buffers, so timers and per-turn state are already handled. A `ctx.compact()`
callback is not reachable from the extension at all — pi holds it:

```js
   compact: (options) => { void (async () => {
       try { const result = await this.compact(…); options?.onComplete?.(result) }
       catch (error) { options?.onError?.(err) }
   })(); },                                          agent-session.js:1911
```

and there are two: `requestEmergencyCompaction`, and `interveneStuck`'s compaction
rung.

**And the swap is what MAKES it fire.** `AgentSession.dispose()` calls
`abortCompaction()`, so replacing the session aborts an in-flight compaction and
pi throws `"Compaction cancelled"` — which `isBenignCompactionError` correctly
does not swallow. So the callback runs, on the ordinary path, at the exact moment
everything it captured has gone stale. What it then did:

```
   1. charged the NEWLY RESTORED run's context-cooldown ladder for a compaction
      that belonged to the previous one — `state.contextCooldownCount++` and
      `tightenEmergencySummary()` both run before anything else;
   2. called `persistState(pi)` on the previous session's `pi`, whose
      `appendEntry` is `runtime.assertActive(); runtime.appendEntry(…)`.
```

That throw leaves through pi's `catch (error) { options?.onError?.(err) }`, i.e.
out of a `void`ed async IIFE: **an unhandled rejection, not a caught error.**
Probe `z4` demonstrates it live — the BEFORE column's `onError` really does throw,
and the probe has to catch it to be able to print anything.

**The fix.** `runToken++` in `session_start` and `session_shutdown`, next to the
`clearPendingTimer()` that is already there. Two lines, and they make every
surviving continuation bail at the check that already exists.

**Tests.** `vendor/pi-loop-mode/tests/session-swap-token.test.ts`, 6 tests.
**Control run: 3 of 6 fail with the fix reverted**, and the three that pass are
the controls. **Probe** `z4`, three modes — and its BEFORE column is the real
extension, loaded from a copy with the two lines patched back out, so it is a
measurement rather than a re-implementation.

### 11.5 AM5 — the one-shot `dispose()` cleared

**Shape 3.** `vendor/pi-subagents-lite/src/spawn/spawn-coordinator.ts`

`session_shutdown` runs the coordinator's teardown BEFORE the manager's, and the
manager's is what actually ends the runs:

```
   getCoordinator()?.dispose();      ← cleared backgroundAgentIds
   getStore().dispose();
   getWidget()?.dispose();
   await mgr.dispose();              ← disposes every child session
     → each run's .finally → tallyCompletion → onAgentComplete
       → `this.backgroundAgentIds.delete(record.id)` is FALSE (cleared)
         and settlementCount is 1
       → nothing scheduled, and therefore nothing REPORTED either
```

The eighteenth pass (AI1) fixed the other half of this and named the half that
was left. Its own note says the `session-replaced` guard inside
`emitIndividualNudge`

> was written for this very case — its own docstring says "`session_shutdown`, or
> a session replaced under it" — but it can only fire for a record that settles
> AFTER the dispose

and then fixed the ids that were already queued. **The records that settle after
the dispose are the ones that guard is for**, and the line one statement above
removed their only route to it. Every one is a finished delegation whose answer
went nowhere, reported to nobody — the one thing AC1 established this class of
failure must never be.

The set costs three short strings and the coordinator is dropped whole at
`setCoordinator(null)`, so the clear was never reclaiming anything.

**The fix.** `src/spawn/nudge-schedule.ts` owns the one-shot and the batch, and
its `retire()` drops only the batch. `dispose()` calls it, reads the ids it hands
back, and reports them — which is AI1's half, unchanged.

### 11.6 AM6 — one timer, two deadlines

**Shape 4.** The same file, and the same extraction.

The nudge batch has exactly one timer, and the FIRST caller's delay decided when
it fires for everyone in it:

```js
   this.pendingNudges.add(agentId);
   if (this.nudgeTimer) return;          // ← whoever armed it wins
   this.nudgeTimer = setTimeout(…, delayMs);
```

Since the seventeenth pass there are two delays:

```
   NUDGE_DELAY_MS       200 ms    coalesce rapid completions
   COMPACTION_WAIT_MS   5,000 ms  re-ask after AH1 deferred a nudge for a
                                  compaction, and again every 5 s until the
                                  lock's own 300 s staleness
```

A held record re-arms at five seconds. Any delegation that settles inside that
window — a continuation, or a second agent on another model's slot — was then held
for the remainder of somebody else's wait, at up to twenty-five times its own
delay, for no reason: nothing is holding IT back. A batch window should widen
because more work arrived, not because unrelated work is blocked.

**The fix.** The schedule keeps the earliest due time and re-arms when a shorter
delay arrives. The other direction is deliberately left alone: a re-ask that fires
early because a fresh completion armed a 200 ms timer simply asks the lock again
and defers again, which costs one map read.

**Tests for AM5 and AM6.** `vendor/pi-subagents-lite/tests/nudge-schedule.test.ts`,
13 tests. **Control run: 3 of 13 fail with the fixes reverted.** **Probe** `z5`,
three modes.

### 11.7 Off the axis — a test that pinned the wrong thing

AI1's regression test asserted the ORDER of two source-text fragments:

```js
   const read = end.indexOf("[...this.pendingNudges]");
   const cleared = end.indexOf("this.pendingNudges.clear()");
   assert.ok(read >= 0 && read < cleared, "read the queue before clearing it");
```

The invariant is right and the pin was to an expression. AM5's extraction moved
the set into a module, and the test failed — correctly, in the sense that
something it was watching had moved, and uselessly, in the sense that the
invariant was now *better* enforced. It is rewritten to assert the half that
stayed in the coordinator (dispose reads what `retire()` hands back, and reports
it), with the ordering itself asserted in the new module's own suite, where it can
be driven rather than read.

---

## 12. The evidence

### 12.1 The gates

Run before anything was written, so the *before* column is a measurement of the
tree as this pass found it.

```
                                       before    after
   vendor/pi-subagents-lite  tests      411       433    lint 103/103 files
   vendor/pi-loop-mode       tests      264       272    lint clean
   vendor/prinny-channel     tests      463       473    lint clean
   .pi/extensions/compaction-guard       56        75    lint clean
   vendor/rtk-pi             tests       28        28
                                       ─────     ─────
                                       1,222     1,281
   probes                                106       111
```

### 12.2 The control runs

Each fix removed, its own suite re-run:

```
   AM1  6 of 10 fail   the 4 that pass are the controls
   AM2  4 of 19 fail   (take removed)
        2 of 19 fail   (one release rung removed)
   AM3  5 of  9 fail
   AM4  3 of  6 fail   the 3 that pass are the controls
   AM5  3 of 13 fail   (with AM6)
```

### 12.3 The five new probes

```
   z1  the stop that could not see the start        stop · restart · clean · fail
   z2  the compaction the lock could not see        parent · child · extension ·
                                                    release
   z3  the teardown that ended the verifier's       order · answer · clear
       session
   z4  the callback that outlived its session       swap · shutdown · live
   z5  the nudge gate dispose() cleared             gate · deadlines · oneshot
```

`z4`'s BEFORE column is produced by writing a copy of the real extension with the
two `runToken++` lines patched out and importing that, so both columns are the
shipped module rather than a re-implementation of it. `z3 answer` and `z5
deadlines` are the two worth reading first: each prints the exact thing a reader
would have received.

### 12.4 The standing scans, still green

```
   the four compaction-lock copies agree on the key, the bound and the owners
   `verifyAnswer` still never throws — every path returns a VerifyOutcome
   `isVerifyingRecord` still has one definition and six readers
   the load order in scripts/pi-local.sh still matches the four behaviours §1.7
     names, and `mergePaths` still puts `-e` first
```

---

## 13. What is open, and what was checked

### 13.1 Open by decision

- **`ctx.compact()` callbacks cannot be cancelled.** pi holds them in a `void`ed
  IIFE and offers no handle. The token check is the whole defence and it is
  enough: everything the callbacks touch reads it first. If pi ever grows a
  cancel, the two call sites should take it.
- **A `/reload` inside a child's session build** makes the guard's parent instance
  read as a child's and stop taking the compaction lock for that session. It is a
  return to the pre-AM2 behaviour rather than a new failure, and closing it would
  need a per-session identity the extension API does not offer.
- **The record map has no bound**, and the child SESSION goes with it. Open since
  the twenty-first pass, on the same reasoning: retiring a settled record silently
  removes the operator's ability to steer a delegation they are reading.
- **Two `Agent` tool calls with different model keys really do run concurrently.**
  Checked and left: the SlotTable is exact, the spawn depth is a counter, and the
  registry writes are idempotent. It is worth a probe if a per-provider limit is
  ever raised above one.
- **`heldForCompaction` keeps the id of a record that was cleared while held.** A
  Set of short strings on a per-session object; the AL axis, not this one.

### 13.2 The measured negatives

Things this axis looked at and found already correct. Each is worth recording,
because "we checked and it holds" is what stops the next pass re-deriving it.

```
   ▸ Y1's window is not real.  `runVerification` sets `verifyAbort` and reaches
     `phase("judging")` with no await between them, so there is no moment at
     which a record is terminal, verifying, and `isVerifyingRecord`-false. Every
     statement between them is synchronous.

   ▸ Two concurrent `steer()` calls cannot both continue a settled record.
     `continueSettledAgent` is synchronous and sets `settled = false` before it
     returns, so the second call sees a running record and steers it instead.

   ▸ `drainQueue` cannot be re-entered mid-iteration. Its one reachable callback
     (`notifyComplete` on a failed start) does not call back into it.

   ▸ A nudge batch of two does not start two runs. `sendCustomMessage` is async
     but its body runs synchronously to the first await, and `_runAgentPrompt`
     sets `_isAgentRunActive = true` before ITS first await — so the second
     `pi.sendMessage` in the same loop iteration already sees a busy session.

   ▸ The `spawn()` → `record.execution.spawnCtx` assignment happens after
     `manager.spawn()` returns, and `manager.spawn()` can settle a record
     synchronously (an already-aborted parent signal). Unreachable for a
     background spawn, which is the only class that reads the field late:
     `signal` is `undefined` for those by construction.

   ▸ The loop's `agent_end` cannot be re-entered. pi awaits agent listeners and
     the run is not idle until they settle, so the 120 s goal check holds the run
     rather than opening a second one.
```

### 13.3 Still unwatched

1. **`renderSubagentEntry` has still never been drawn in a live TUI.** Unchanged
   from the last two passes and still the cheapest unrun thing on the list.
2. **AM2 has never met a real threshold compaction with a real Matrix message
   arriving during it.** The probe drives the real guard and the real readers, and
   the window is derived from pi's source; nobody has watched the deferral happen
   on the box.
3. **`/prinny prepare` has not been re-run since AL3 or AM1.** The sidecar runs
   from a staged runtime keyed on a content fingerprint of `server/src`, so the
   next start restages automatically — but that restage does an `npm install` and
   has not been exercised.
4. **The rescue turn has still never met a real llama-server with an unloaded
   rescue model** (AL2's rung 3).

---

## 14. The pattern across twenty-two passes

Sixteen axes, and the shape of what each found:

```
   S  T  U  V  W  X  Y  Z    the artefact and what it says
   AA AB AC AD AE AF AG AH   the actor and what it can see
   AI AJ AK AL               the promise, the caller, the proxy, the lifetime
   AM                        the moment                            ← this pass
```

What is different about this one, and worth carrying forward: **the previous
fifteen axes are all questions about a single point in the code.** "What does this
return", "who reads this", "what does this name". They can be answered by reading
one function carefully.

This one cannot. Every finding is a statement about two points and the time
between them, and the only way to see it is to write the two points down next to
each other — which is why four of the six fixes are an **extraction**:
`channel-lifecycle.ts`, `record-teardown.ts`, `nudge-schedule.ts`, and the
guard's `compaction-lock.ts`. In each case the code was already correct at each
point and wrong about the pair, and the extraction is what makes the pair a thing
a reader can see and a test can drive.

The residue, in the tense that would have helped: **the next await added to a
handler will be added by somebody who has just decided what to wait for. The
question to ask is not "did I handle the error?" — everyone answers yes — but
"what did I read above this line, and is it still true below it?" Where the answer
is "the host guarantees it", write down which guarantee, with the file and line,
because that is the sentence that will be wrong first.**

---

## 15. Where to look

```
   THE MACHINE                §1, seven panels. §1.3 is the one to read first.
   THE AWAIT LEDGER           §10.2, thirty-five rows. The artefact.
   THE FINDINGS               §11.1 AM1 · §11.2 AM2 · §11.3 AM3 · §11.4 AM4 ·
                              §11.5 AM5 · §11.6 AM6
   THE EVIDENCE               §12
   WHAT IS OPEN               §13.1, and §13.2 for what was checked and holds

   CODE
     vendor/prinny-channel/src/channel-lifecycle.ts        AM1
     .pi/extensions/compaction-guard/src/compaction-lock.ts AM2
     .pi/extensions/compaction-guard/index.ts               AM2 wiring
     vendor/pi-subagents-lite/src/agents/record-teardown.ts AM3
     vendor/pi-loop-mode/extensions/index.ts                AM4 (two lines)
     vendor/pi-subagents-lite/src/spawn/nudge-schedule.ts   AM5, AM6

   TESTS
     vendor/prinny-channel/tests/channel-lifecycle.test.ts
     .pi/extensions/compaction-guard/tests/pi-compaction-lock.test.ts
     vendor/pi-loop-mode/tests/compaction-lock.test.ts      (four copies now)
     vendor/pi-subagents-lite/tests/record-teardown.test.ts
     vendor/pi-loop-mode/tests/session-swap-token.test.ts
     vendor/pi-subagents-lite/tests/nudge-schedule.test.ts

   PROBES
     context/testing/probes/z1-…  z2-…  z3-…  z4-…  z5-…
```
