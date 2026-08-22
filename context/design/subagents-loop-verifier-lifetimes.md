# Subagents, the loop and the verifier — what we start and never finish

*Twenty-first pass over the delegation stack. 2026-08-22.*

This document is **self-contained**. It assumes none of the twenty before it:
§1 draws the whole machine, §2 is pi itself, §3 is the event bus, §4–§9 are the
seven packages, and only then does it get to this pass's own axis. If you have
read one of the earlier ones you can skip to §10.5, which is the artefact, and
§11, which is the findings.

The brief was the same as every pass: **evaluate subagents, the loop and the
verifier comprehensively, write it up in detail with an ASCII graph, and fix
what turns up along the way.**

Nine findings, AL1–AL9. All fixed, each with a regression test that fails when
the fix is removed and a probe that prints BEFORE and NOW so it is its own
control. Two more things that are corrections rather than findings, §11.10 and
§11.11.

```
                                     before    after
   vendor/pi-subagents-lite  tests    405       411     lint 99/99 files
   vendor/pi-loop-mode       tests    258       264
   vendor/prinny-channel     tests    436       463     lint clean, and now
                                                        covers server/src too
   .pi/extensions/compaction-guard     47        56
   vendor/rtk-pi             tests     28        28
                                     ─────     ─────
                                     1,174     1,222
   probes                               97       106
```

The *before* column is a measurement of the tree as this pass found it, taken
before anything was written.

---

## 0. The axis, and why it is a new one

> **For every construct with a beginning and an end, name the ONE place that
> ends it. Then enumerate the paths that reach the end of the WORK without
> reaching the end of the THING.**

Twenty passes have asked what a thing *does*. This one asks how long it lasts.
The question is deliberately mechanical, and that is its whole value: you do not
have to understand what a timer is for in order to ask who clears it.

The method is three columns and no cleverness:

```
   the THING            the START                       the END
   ───────────────────  ──────────────────────────────  ─────────────────────────
   an interval          armDeliverySweep()              sweepUndelivered's disarm
   a Matrix client      buildBot() in the retry loop    …?
   a model switch       interveneStuck's rescue turn    rung 7 of agent_end
   a subscription       ctx.ui.onTerminalInput(…)       …?
   a spill directory    mkdtempSync on first use        …?
```

Every row whose third column has a question mark is a finding or a ledger note.
Every row whose third column has exactly one entry is then asked the second
question: **how many ways are there to finish the work, and does each of them
pass through that one place?** AL2 is the whole of that question in one row: the
end exists, is correct, and sits on rung 7 of an eighteen-rung ladder that five
rungs return above.

### 0.1 The four shapes

Every finding in this pass is one of exactly four shapes, and the shape tells you
what the fix has to be.

```
   ┌───────────────────────────────────────────────────────────────────────────┐
   │  SHAPE 1 — ONE ENDING, MANY EXITS                                         │
   │    The end is written, correct, and reachable by one path out of N.       │
   │    AL2 (rescue model), AL6 (typing indicator), AL8 (the footer pill)      │
   │                                                                           │
   │    FIX: one named function, called from every exit. Never "handle the     │
   │    other case too" — that is the same bug with a larger N.                │
   ├───────────────────────────────────────────────────────────────────────────┤
   │  SHAPE 2 — NO ENDING AT ALL                                               │
   │    Nothing anywhere calls it. Often the value is right there, captured.   │
   │    AL3 (the retry loop's clients), AL5 (the widget poll), AL7 (the        │
   │    unregister), AL9 (the spill directory)                                 │
   │                                                                           │
   │    FIX: write the end, and make it reachable from the path that already   │
   │    exists. If there is no such path, that is a second finding (AL5's      │
   │    `onStart` had no setter).                                              │
   ├───────────────────────────────────────────────────────────────────────────┤
   │  SHAPE 3 — AN ENDING THAT CANNOT BE REACHED                               │
   │    The end is written and called, and its condition can never be true     │
   │    again once the work is done.                                           │
   │    AL4 (the delivery sweep's disarm)                                      │
   │                                                                           │
   │    FIX: make the disarm test the SAME predicate as the arm test, in one   │
   │    function. Two questions that must agree cannot be written twice.       │
   ├───────────────────────────────────────────────────────────────────────────┤
   │  SHAPE 4 — A BEGINNING THAT ASSUMES IT IS THE FIRST                       │
   │    Not a leak. A start whose initial value was measured once, correctly,  │
   │    for the only caller it had — and a second caller arrived.              │
   │    AL1 (the continuation transcript's anchor)                             │
   │                                                                           │
   │    FIX: make the anchor a parameter, and make each caller state its own.  │
   │    The default that was right stays right, and says which caller it is    │
   │    for.                                                                   │
   └───────────────────────────────────────────────────────────────────────────┘
```

### 0.2 What is NOT this axis

- **Anything about correctness of the work itself.** Whether the judge's verdict
  is right is the fourteenth pass. Whether the sweep reports the right rooms is
  the eleventh. This pass only asks when they stop.
- **Garbage collection.** Node reclaims unreachable objects. Everything here is
  about things that are *reachable* — a timer in the loop's queue, a process
  holding a file, a subscription in somebody else's set, a directory on disk —
  or about state that is reachable and stale.
- **"It is unref'd, so it does not matter."** Four of the intervals in this stack
  are unref'd and none of them holds the process open. AL4 is still a finding,
  because a wake-up a second over a map that only grows is a cost, and because an
  ending whose condition can never be true is not an ending whatever it costs.

---

## 1. The machine

Seven packages run in **one node process**, inside **one pi session**, against
**one llama.cpp slot**. Nothing here is a service; everything is an extension of
the same process, and every table in this document is about that one process.

### 1.1 Panel A — the whole machine

```
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  ONE NODE PROCESS · ONE pi SESSION · ONE llama.cpp SLOT                    │
   │                                                                            │
   │   OPERATOR ──────► pi TUI ─────────────────────────────────┐               │
   │   (terminal)        │  /loop  /agents  /prinny  /stack     │               │
   │                     │                                      │               │
   │   SENDER ─► Matrix ─┴─► prinny sidecar ──stdio(MCP)──► prinny ext          │
   │   (a phone)              (its own process)                 │               │
   │                                                            ▼               │
   │                                              ┌───────────────────────┐     │
   │                                              │   pi AgentSession     │     │
   │                                              │   (the PARENT)        │     │
   │                                              └───────────┬───────────┘     │
   │                                                          │                 │
   │   ┌───── extensions bound to that session, in load order ┴────────┐        │
   │   │  stack   browser   loop   guard   subagents   prinny   rtk    │        │
   │   │    ·        ·        ·      ·         │         ·        ·    │        │
   │   └────────────────────────────────────────┼──────────────────────┘        │
   │                                            │  Agent tool                   │
   │                                            ▼                               │
   │                              ┌───────────────────────────┐                 │
   │                              │  AgentManager             │                 │
   │                              │    ├ SlotTable (1 slot)   │                 │
   │                              │    ├ Watchdog             │                 │
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

Five actors can reach a decision in that picture — the **OPERATOR** at the
terminal, the parent **MODEL**, an allow-listed Matrix **SENDER**, a **CHILD**
session in this process, and the **MACHINERY** itself (a timer, a watchdog, a
sweep). That was the nineteenth pass's artefact and it is still the right five.

This pass adds a sixth thing to the picture that is not an actor: **the clock**.
Four of the nine findings are about something the machinery started and only the
clock could have ended.

### 1.2 Panel B — the lifetime map

This is the new drawing, and it is what §10.5 tabulates. Every box is something
with a beginning and an end. The arrow into a box is its start; the arrow out is
its end; a **✘** is where this pass found the arrow out missing.

```
                       ┌──── process ────────────────────────────────────────┐
   node starts ───────►│                                                     │
                       │  ┌── pi session (replaceable: /new /resume /fork) ─┐│
   session_start ─────►│  │                                                 ││
                       │  │  ┌── extension factory ──────────────────────┐  ││
                       │  │  │                                           │  ││
                       │  │  │  ┌─ a delegation ───────────────────────┐ │  ││
   Agent tool ────────►│  │  │  │  record · session · slot · watchdog  │ │  ││
                       │  │  │  │  transcript · output log · gate      │ │  ││
   settlement ────────►│  │  │  │  ─── status goes terminal ───────────│ │  ││
                       │  │  │  │  ┌─ verification ──────────────────┐ │ │  ││
                       │  │  │  │  │ judge session · verifyAbort ·   │ │ │  ││
                       │  │  │  │  │ deadline · repair turn          │ │ │  ││
                       │  │  │  │  └─────────────────────────────────┘ │ │  ││
                       │  │  │  │  the RECORD outlives all of it   ✘AL5│ │  ││
                       │  │  │  └──────────────────────────────────────┘ │  ││
                       │  │  │                                           │  ││
                       │  │  │  ┌─ a loop run ─────────────────────────┐ │  ││
   /loop start ───────►│  │  │  │  state · runToken · pendingTimer     │ │  ││
                       │  │  │  │  ┌─ a rescue turn ────────────────┐  │ │  ││
   3× stuck ──────────►│  │  │  │  │ the SESSION's model     ✘AL2   │  │ │  ││
                       │  │  │  │  └────────────────────────────────┘  │ │  ││
   /loop end ─────────►│  │  │  │  state destroyed; the footer ✘AL8    │ │  ││
                       │  │  │  └──────────────────────────────────────┘ │  ││
                       │  │  │                                           │  ││
                       │  │  │  ┌─ the Matrix channel ─────────────────┐ │  ││
   /prinny start ─────►│  │  │  │  sidecar process · stdio · handshake │ │  ││
                       │  │  │  │  ┌─ per inbound message ──────────┐  │ │  ││
   a message ─────────►│  │  │  │  │ awaitingReply entry            │  │ │  ││
                       │  │  │  │  │ delivery sweep       ✘AL4      │  │ │  ││
                       │  │  │  │  │ typing indicator     ✘AL6      │  │ │  ││
                       │  │  │  │  └────────────────────────────────┘  │ │  ││
                       │  │  │  │  ┌─ inside the SIDECAR ───────────┐  │ │  ││
                       │  │  │  │  │ Matrix client per attempt ✘AL3 │  │ │  ││
                       │  │  │  │  └────────────────────────────────┘  │ │  ││
                       │  │  │  └──────────────────────────────────────┘ │  ││
                       │  │  │                                           │  ││
                       │  │  │  terminal-input subscription       ✘AL7   │  ││
                       │  │  └───────────────────────────────────────────┘  ││
                       │  └─────────────────────────────────────────────────┘│
                       │                                                     │
                       │  spill directory (survives the session)      ✘AL9   │
                       └─────────────────────────────────────────────────────┘
```

AL1 is not on this drawing, because it is not a leak: it is a *second* start
inside the delegation box, anchored as though it were the first.

### 1.3 Panel C — the four scopes, and who ends each

The single most useful fact in this document is that there are exactly four
scopes in this process, they nest, and **each one has a different owner for its
teardown**.

```
   SCOPE            LASTS FROM              ENDED BY                     WHO OWNS IT
   ───────────────  ──────────────────────  ───────────────────────────  ──────────
   PROCESS          node starts             process exit                 the OS
   SESSION          session_start           session_shutdown, then pi's  pi, then us
                                            beforeSessionInvalidate
   RUN / TURN       turn_start              agent_end → agent_settled    us
   ONE DELEGATION   the Agent tool call     settlement chain's .finally  us

   and one that is NOT nested inside any of them:

   MODULE           first import            never                        nobody
```

The module scope is where every one of this pass's leaks lives, and it is not an
accident. `spillDir`, the loop's `state`, the manager singleton, the widget
singleton, `awaitingReply`, `typingRooms` — all module-global, all outliving the
session they were created for unless something explicitly resets them. Node's
module cache means "the extension was loaded again" does **not** mean "the module
ran again". `pi` re-invokes the extension *factory* per session, so a `let`
inside the factory is per-session and a `const` at module top level is per
process. Which one a piece of state is in is decided by an indentation level, and
nothing in the type system says which you got.

```
   src/events.ts

     const toolCallListener = …            ← MODULE scope: one per process
     export function setupEventListeners(pi) {
       let unregisterTerminalInput          ← FACTORY scope: one per session
       pi.on("session_start", async … => {
         let x                              ← per session_start
       })
     }
```

AL7 is exactly one indentation level: had `unregisterTerminalInput` been at
module scope rather than inside the factory, the guard that reads it as "already
subscribed" would have silently killed the widget's keyboard after the first
`/new`. It is inside the factory, so it does not. **Nothing in the code says
so**, and that is the finding.

### 1.4 Panel D — one delegation, and what it starts

```
   parent turn
     │
     ├─ model emits  Agent{prompt, agent?, run_in_background?, worktree_path?}
     │
     ├─ tool_call listener writes _resolvedAgent / model / thinking onto the input
     │
     ├─ SpawnCoordinator.spawn ─► AgentManager.spawn
     │      ▸ starts  the RECORD                     agents.set(id, …)
     │      ▸ starts  the COMPLETION GATE            gateResolvers.set(id, resolve)
     │      ▸ starts  the PARENT BINDING             signal.addEventListener("abort")
     │      ▸ starts  a CONCURRENCY SLOT             slots.reserve(record)
     │      ▸ starts  the WATCHDOG's clock           watchdog.start(id)
     │      ▸ starts  the OUTPUT LOG                 /tmp/pi-agent-outputs/<id>.log
     │      ▸ starts  the TRANSCRIPT                 pi.appendEntry("subagent-turn")
     │      ▸ starts  the WIDGET POLL                widget.ensureTimer()      ← AL5
     │      ▸ starts  a CHILD AgentSession           createAgentSession()
     │      ▸ starts  an ABORT CONTROLLER            new AbortController()
     │
     ├─ … the child runs …
     │
     ├─ settlement chain .then
     │      ▸ status goes terminal   ← the record now READS as finished
     │      ▸ starts  a VERIFY ABORT                 new AbortController()
     │      ▸ starts  a JUDGE SESSION                a THIRD AgentSession
     │      ▸ starts  a DEADLINE                     setTimeout, unref'd
     │
     └─ settlement chain .finally
            ▸ ends the output log        finalize()
            ▸ ends the transcript        finalize() → record.transcript = undefined
            ▸ ends the slot              slots.release(record)
            ▸ ends the parent binding    detachParentBinding(record)
            ▸ ends the gate              openGate(id, result)
            ▸ ends… the record?          NO. It stays for a continuation.
            ▸ ends… the child session?   NO. It stays for a continuation.
```

The last two lines are the design, not a defect: a settled delegation can be
steered — `continueSettledAgent` prompts the same session again — so the record
and its session are deliberately kept. What follows from that is AL5: the record
map only grows, and anything that walks it per tick gets more expensive for the
life of the session.

### 1.5 Panel E — one loop iteration, and the rescue turn inside it

```
     ┌──────────────────────────────────────────────────────────────────────┐
     │  /loop start "goal" [--check CMD] [--model M] [--rescue-model R]     │
     └───────────────────────────────┬──────────────────────────────────────┘
                                     ▼
      sendLoopTurn ──► pi.sendMessage(directive, {triggerTurn:true})
                                     │
                            the model works
                                     │
        message_end ×N ──► sanitise degenerate repetition (in place)
        tool_result ×M ──► recordToolResult → lastStateChangeIteration
                                     ▼
                       ┌──────── agent_end ────────┐
                       │  the EIGHTEEN-RUNG LADDER │
                       └──────────┬────────────────┘
                                  ▼
        1  softStopRequested        → finalizeSoftStop            return
        2  context pressure         → recovery / pause            return
        3  provider error           → backoff & retry, or pause   return
        4  degenerate abort         → interveneStuck              return
        5  operator abort (Esc)     → paused                      return
        6  (bookkeeping: counters, iterationCount++, commitTurnMemory)
        7  state.rescueActive       → standDownRescue → continue  return   ← AL2
        8  goal check               → pass / fail / cannot-run
        9  LOOP_DONE marker         → improve, or finish
       10  LOOP_BLOCKED marker      → unblock
       11  iteration cap            → pause
       12  score regression         → regression
       13  detectStuck              → interveneStuck              return
       14  no-progress audit        → audit
       15  normal continue          → scheduleLoopTurn(delay)

     and interveneStuck, at 3 consecutive stuck turns, does this:

       ┌─────────────────────────────────────────────────────────────────┐
       │  pi.setModel(rescueModel)      ← the WHOLE SESSION's model       │
       │  state.rescueActive = true                                       │
       │  state.rescueReturnModel = ctx.model                             │
       └─────────────────────────────────────────────────────────────────┘

     …and rung 7 was the only place that ever put it back.
```

### 1.6 Panel F — the channel, and the two intervals in it

```
   a Matrix message arrives
     │
     ├─ awaitingReply.set(room, mergeAwaiting(previous, arrival))
     ├─ armDeliverySweep()          ← INTERVAL A, every 30 s
     │
     ├─ api.sendUserMessage(text)   ← returns void; failures are unobservable
     │
     ├─ pi echoes the message back as a user message
     │     └─ markLive(room)        ← the ONLY evidence pi took it
     │
     ├─ turn_start → agentRunning = true
     │     └─ applyTyping(planTyping(roomsAwaitingAnswer(), typingRooms))
     │           └─ INTERVAL B, every 8 s, re-asserting typing: true
     │
     └─ agent_settled
           ├─ agentRunning = false
           ├─ stopTyping()          ← INTERVAL B disarms: typingRooms.size === 0
           ├─ forwardResult()       ← the answer goes to the live room
           │     └─ retire LIVE entries:  if (entry.live) awaitingReply.delete(room)
           └─ sweepUndelivered()    ← INTERVAL A: report, then… ✘AL4

   INTERVAL A   arm:    a message arrived                     (no exceptions)
                disarm: nothing reportable AND no !live entry (a WEAKER question)
   INTERVAL B   arm:    typingRooms.size > 0
                disarm: typingRooms.size === 0                (the SAME question)
```

Two intervals, thirty lines apart, in one file. One of them is written as a
reconciliation against a single predicate and cannot get stuck. The other asks
one question to start and a different question to stop.

### 1.7 Panel G — where the evidence goes

Worth having in front of you, because five of the nine findings are about
something that writes to one of these and never stops.

```
   ~/.pi/agent/sessions/<id>.jsonl     the session transcript. Subagent turns go
                                       here as `custom` entries; pi renders them
                                       and never sends them to a model.
   ~/.pi/agent/subagent-verify.jsonl   the judge's prompt and reply, capped at
                                       2,000 lines with a rotate.
   ./.pi-loop-log.jsonl                one line per loop decision, 5 MB with a
                                       rotate to `.1`.
   /tmp/pi-agent-outputs/<agentId>.log the per-delegation human-readable log.
   /tmp/pi-tool-output-<pid>-XXXXXX/   the guard's spill: what a capped tool
                                       result actually said.              ← AL9
   /tmp/pi-subagent-result-<pid>-XXX/  the same, for a background delegation's
                                       result.                            ← AL9
   ~/.pi/agent/channels/prinny/        access.json, queue.json, watermark.json,
                                       bot.pid, crypto/store               ← AL3
```

---

## 2. pi itself

Everything below rests on what pi does and does not do for an extension. All of
it is measured against pi **0.84.2**'s installed `dist`, not read from a
changelog.

### 2.1 What an extension is, and when its factory runs

An extension is a module with a default export taking `pi: ExtensionAPI`. pi
loads it through `jiti` (`core/extensions/loader.js:368`) and calls the factory
once per **session**, not once per process:

```
   loadExtensionModule(path, cacheToken)
     if the cache token is current → the cached FACTORY is returned
     otherwise → jiti.import(path), and the factory is cached
   …
   await factory(api)                              loader.js:409, :425
```

The cache token is `{cwd, generation}` and the generation is bumped by `/reload`.
So on `/new`, `/resume` and `/fork`, **the module is not re-evaluated and the
factory is called again**. That is the split Panel C draws, and it is why a `let`
inside the factory resets per session while a module-level `const` does not.

### 2.2 What pi ends for you, and what it does not

This table is the reason AL7 is a note rather than a disaster, and it is the
first thing to re-check when pi is upgraded.

| you started | pi ends it? | where |
| --- | --- | --- |
| `pi.on(...)` handlers | **yes** — the whole runner is replaced with the session | `agent-session.js`, per-session `ExtensionRunner` |
| a registered tool / command | **yes** — same registry lifetime | `_refreshToolRegistry` |
| `ctx.ui.setWidget(key, …)` | **yes** | `clearExtensionWidgets()` in `resetExtensionUI` |
| `ctx.ui.setStatus(key, text)` | **yes**, at session teardown | `footerDataProvider.clearExtensionStatuses()` |
| `ctx.ui.onTerminalInput(h)` | **yes** | `clearExtensionTerminalInputListeners()`, `interactive-mode.js:1848` |
| an `AgentSession` you created | **no** | you call `.dispose()` |
| a `setInterval` / `setTimeout` | **no** | you clear it |
| a child process you spawned | **no** | you stop it |
| a file or directory you wrote | **no** | nothing, ever |
| module-global state | **no** | there is no hook that runs on module teardown |

The teardown chain for the "yes" rows, in full, because AL7 depends on it:

```
   AgentSessionRuntime.teardownCurrent(reason)     agent-session-runtime.js:102
     await this.session.abort()
     emitSessionShutdownEvent(...)                 ← OUR session_shutdown handler
     this.beforeSessionInvalidate?.()              agent-session-runtime.js:111
        └─ InteractiveMode.resetExtensionUI()      interactive-mode.js:1715
             ├─ hideExtensionSelector / Input / Editor
             ├─ ui.hideOverlay()
             ├─ clearExtensionTerminalInputListeners()          :1726
             ├─ setExtensionFooter(undefined) / setExtensionHeader(undefined)
             ├─ clearExtensionWidgets()
             └─ footerDataProvider.clearExtensionStatuses()
     this.session.dispose()

   called from:  switchSession (/resume), and the /new, /fork and import flows
   and also:     AgentSessionRuntime.dispose() on quit             :293
                 InteractiveMode.stop()                            :5425
```

**Our `session_shutdown` handler runs BEFORE `beforeSessionInvalidate`.** That
ordering is load-bearing twice over: it is why the manager's records are still
readable when the coordinator reports an undelivered nudge, and it is why calling
the terminal-input unregister ourselves (AL7) is safe — pi has not yet cleared
its own list, and the handle it returned is idempotent.

### 2.3 `appendEntry` — a write with no reader on the model's side

`pi.appendEntry(customType, data)` writes a `type: "custom"` entry to the session
file. `sessionEntryToContextMessages` returns `[]` for it, so it is rendered in
the transcript and **never sent to a model**, before or after a compaction, in
memory or re-opened from disk. That property was measured (probe `x2`) rather
than read, and the subagent transcript rests entirely on it.

For this pass what matters is the other half: **an entry is a write to a file
that grows.** `AgentTranscript` bounds itself — 60 entries per agent, 4,000
characters and 120 lines per entry — and says so when it stops. That is the
model every other writer in the stack is measured against in §10.3.

### 2.4 `pi.exec` never rejects, and what that means for a teardown

`ExtensionAPI.exec` is `execCommand` (`core/exec.js`), whose body is a
`new Promise((resolve) => …)` with **no reject path**. A missing binary, a
timeout and a signalled death all *resolve*, with `code: code ?? 0`. Anything
written as `try { await pi.exec(…) } finally { cleanup() }` therefore always
reaches its `finally` — which is convenient — and anything written as
`.catch(cleanup)` never does.

### 2.5 `ctx.compact()` is fire-and-forget, and guarantees a callback

```js
   compact: (options) => { void (async () => {
       try { const result = await this.compact(options?.customInstructions);
             options?.onComplete?.(result); }
       catch (error) { options?.onError?.(err); }
   })(); },                                   agent-session.js:1911
```

Exactly one of the two fires on every path, which is what makes the compaction
lock's release safe to put in each of them (§10.4). The synchronous throw that
*can* reach the caller is `runner.assertActive()` on a stale runtime, and both
call sites wrap for it.

---

## 3. The event bus

### 3.1 The whole table

| event | when | this stack's handlers |
| --- | --- | --- |
| `session_start` | a session begins, including a CHILD's | loop (restore + auto-resume), subagents (config, agent discovery, terminal input), prinny (ensure tools, start channel), guard, stack |
| `turn_start` | a turn begins | subagents (UI ctx), prinny (typing on) |
| `message_end` | one assistant message finished | loop (degenerate sanitiser, replaced IN PLACE) |
| `tool_call` | before a tool runs | subagents (inject model), prinny (permission relay), rtk (rewrite), browser-guard |
| `tool_result` | after a tool runs | loop (`recordToolResult`), guard (output cap) |
| `agent_end` | the agent loop finished a run | loop (the eighteen rungs), prinny (capture last text) |
| `agent_settled` | no retry, compaction or queued continuation left | loop (safety net), prinny (forward, typing off, deferred `/compact`) |
| `session_before_compact` | pi is about to compact | loop (handoff), guard (summary cap) |
| `session_compact` | a compaction finished | loop (adopt) |
| `session_shutdown` | the session is going away | subagents (dispose everything), loop (clear timers), prinny (stop the channel) |

### 3.2 The four teardown events, and what each is good for

This is the part of the bus this pass cares about.

```
   agent_end        the run finished. NOT the end of anything the operator
                    started: a retry, a compaction or a queued follow-up may
                    still be coming. Ending a lifetime here is premature.

   agent_settled    the end of the WORK. This is where prinny stops typing and
                    sweeps, and where the loop's safety net runs.

   session_shutdown the end of the SESSION. Everything module-global that
                    belongs to a session must be ended here, because pi's own
                    teardown a moment later will not touch it.

   (nothing)        the end of the PROCESS. There is no event. `process.on(
                    "exit")` exists but cannot await anything, so nothing that
                    needs I/O can be ended there. Anything on disk is therefore
                    ended by the NEXT process or by nobody — which is AL9.
```

### 3.3 Which emitters thread a result

`message_end` threads: each handler's returned message is passed to the next, and
pi then calls `_replaceMessageInPlace(event.message, normalized)`, which deletes
every key of the object agent-core holds and copies the replacement over it. So
`agent_end`'s `messages` are the *sanitised* objects. `session_before_compact` is
last-truthy-wins and NOT threaded. Everything else discards handler results.

---

## 4. The loop — `vendor/pi-loop-mode`

An unattended run: a goal, a directive per iteration, and eleven ladders that
decide what the next directive is. Its entire state is module-global
(`let state: LoopState`), persisted after every decision as a `custom` session
entry and restored from the session branch on `session_start`. Its factory begins
with a `bornInsideSubagentSpawn()` guard, because a child binding the same module
would drive the operator's loop.

### 4.1 What it registers

| surface | what |
| --- | --- |
| `/loop` command | `goal · prepare · run · start · resume · finish · stop · end · status · stats · help`, and an unrecognised subcommand falls through to `start <goal>` |
| `loop` tool | `action` ∈ `start stop status stats finish resume end` — the model's route |
| 13 handlers | see §3.1 |

### 4.2 What a loop run STARTS, and what ends each

This is §10.5's row set for this package, spelled out because AL2 and AL8 both
live here.

```
   state.active = true          /loop start        /loop stop, /loop end,
                                                   five pauses, the cap
   runToken                     every transition   monotonic; nothing ends it,
                                                   and that is the design — a
                                                   stale callback compares
   pendingTimer                 scheduleLoopTurn   clearPendingTimer(), called
                                                   from 13 places
   the session's MODEL          interveneStuck     standDownRescue(), from 10
                                                   places                ← AL2
   the footer pill              30 setStatus calls nothing               ← AL8
   the compaction lock          beginCompaction    endCompaction, 3 exits each
   contextRecoveryPending       saturation         resetContextRecovery()
   deferredDirective            AG2's deferral     resetContextRecovery()
   degenerateAbortPending       the sanitiser      consumed in agent_end
   .pi-loop-log.jsonl           every decision     rotates at 5 MB
```

`pendingTimer` is the one ref'd timer in the stack, and deliberately: between
iterations that timer *is* the loop. Unref'ing it would be a behaviour change.
See §11.11.

### 4.3 The stuck detector, in the units it actually uses

Three per-turn buffers exist because the same question has three right units:

```
   turnAssistantTexts    text || thinking, one entry per MESSAGE
                         → the repetition WINDOW's feed (one per turn)
   turnAnswerTexts       text only
                         → "did the turn ANSWER" (LOOP_DONE, LOOP_BLOCKED)
   turnRepetitionTexts   text and thinking together, per message
                         → "did any ONE message degenerate", and whether the
                           turn thought at all
```

`commitTurnMemory` writes ONE entry per turn into each rolling window, and
`detectStuck` runs eight rules over them: degenerate repetition, no tool use for
N turns, two identical fingerprints, three identical fingerprints, near-duplicate
text (Jaccard over word trigrams, ≥ 0.80), the same fingerprint ≥ 3 times in the
window, three identical tool signatures in a row, and the same question repeated.

Three consecutive interventions is `RESCUE_AFTER`, and that is the door into the
rescue turn.

### 4.4 The goal check

```
   wrapCheckCommand(cmd)
       trap 'printf "\n__PI_LOOP_CHECK_COMPLETED__:%d\n" "$?"' EXIT
       (
       <cmd>
       )

   pi.exec("bash", ["-lc", wrapped], { timeout: checkTimeoutSeconds*1000 })
       result.killed          → execFailed: pi's own timeout
       marker absent          → execFailed: the process died without finishing
       otherwise              → passed = (code === 0), SCORE: n from the output
```

The subshell is the twelfth pass's repair: a bash `EXIT` trap is one slot, not a
stack, so a check that sets its own — `trap 'docker compose down' EXIT` —
replaced the wrapper's and the marker went missing on a check that had run
perfectly.

---

## 5. Subagents — `vendor/pi-subagents-lite`

### 5.1 The record, and who can reach it

```
   AgentRecord
     id, display{type, description}
     lifecycle{status, startedAt, completedAt, started, stoppedBy, stopDetail}
     execution{session, abortController, transcript, outputLog, promise,
               modelKey, holdsSlot, settled, settlementCount, verifyAbort,
               verifyPhase, spawnCtx, talliedCost, liveViewCallbacks}
     stats{lifetimeUsage, verifyUsage, turnCount, toolUses, maxTurns, …}
     result, error, verification
```

Five readers, and the lifetime question is different for each:

```
   AgentManager      owns it; the only writer of lifecycle.status
   SpawnCoordinator  reads settlementCount to decide whether to nudge
   AgentWidget       sorts EVERY record it has ever held, every 80 ms   ← AL5
   the verifier      writes verifyPhase and verification onto it
   the /agents menu  reads it to draw rows and to offer Clear
```

### 5.2 The completion gate

Every record carries a promise from birth, opened exactly once at its terminal
transition: settlement, a queued stop, a start failure, an already-aborted spawn,
`dispose()`, or `removeRecord`. `openGate` deletes the resolver on first open, so
a second call is a no-op and a `.finally` that arrives after a `Clear` cannot
dangle. This is the cleanest lifetime in the stack and it is worth copying: **one
resolver, deleted on use, six named callers.**

### 5.3 Concurrency

`SlotTable` keys on `provider/modelId`, with per-model ▸ per-provider ▸ default
precedence. `reserve` sets `holdsSlot`; `release` clears it and decrements
*whatever slot serves the key now* — deliberately not the object captured at
reservation, because a `setLimits()` in between may have replaced it.
`setLimits` rebuilds every running count from the holders themselves, which is
what makes a reconfiguration non-destructive.

The slot is held **through the verification window**, where the child's status is
already terminal. Counting by status rather than by `holdsSlot` would free it
early and let a queued delegation start while the previous one's judge is still
on the single llama slot.

### 5.4 What a child gets

A child is a real `AgentSession` on `SessionManager.inMemory()`, with its own
extensions bound, its own tool registry, and `__PI_SUBAGENT_SPAWN_DEPTH__` on
`globalThis` so that every extension in this stack can refuse to run inside it.
It gets no session file. Its transcript reaches the operator by two routes: the
`/tmp` output log, and — since the twentieth pass — `pi.appendEntry` entries in
the *parent's* session file.

### 5.5 The turn bound

`maxTurns` plus `graceTurns`: the child is told to wrap up at `maxTurns` and hard
aborted at `maxTurns + graceTurns`. `classifyRun` turns the outcome into
`aborted` / `turnLimited` / `modelError`, and the verifier's structural gate
refuses to judge a run that was cut off.

### 5.6 Delivery

```
   foreground   the Agent tool awaits record.execution.promise; the answer is
                the tool result.
   background   the tool returns immediately; when the record settles,
                SpawnCoordinator batches a nudge (200 ms) and sends a
                `subagent-result` message with triggerTurn.
```

A nudge held for somebody else's compaction is put back with `COMPACTION_WAIT_MS`
(5 s), repeatedly, for as long as the lock is held — up to `STALE_MS`, five
minutes. `dispose()` reports every id still in the batch rather than dropping it,
which is the eighteenth pass's AI1 and is the model §11.2 follows.

### 5.7 The transcript

```
   AgentTranscript              src/agents/transcript-entry.ts
     pi.appendEntry("subagent-turn", {agentId, shortId, agentType, phase,
                                      turn?, description?, lines, dropped?})
     one entry per child TURN, plus the brief, each verifier call, and the end
     bounded: 60 entries per agent, 4,000 chars and 120 lines per entry
     SUBAGENT_TRANSCRIPT=0 turns it off, as SUBAGENT_VERIFY_LOG=0 does
   renderSubagentEntry          src/ui/renderer.ts — dimmed, collapsed to 8 lines
   streamAgentOutput            src/agents/output-file.ts — ONE formatter, two
                                sinks; the /tmp log is this function with a file
                                for a sink
```

It has three moments, the same three `AgentOutputLog` has, because it is the same
lifecycle and a second one would drift: **construct** (write the brief),
**attach** (subscribe to the session), **finalize** (write the closing entry and
unsubscribe). `dispose()` is the fourth: drop the subscription without writing
anything, for a record being cleared.

`attach` is where AL1 lives, and §11.1 is the account.

---

## 6. The verifier

### 6.1 The two sessions, and why they are different

```
   the JUDGE     a THIRD AgentSession, agent type `__verifier`, maxTurns 1,
                 created by runAgent() directly — NOT this.spawn().
   the REPAIR    the CHILD's own session, prompted again.
```

The judge goes around `spawn()` on purpose: verification happens inside the
settlement chain's `.then`, and the child's slot is released in the `.finally`
that follows it, so a judge that asked for a slot would wait for a slot that is
waiting for the judge — with the fork's default of 1, a deadlock rather than a
slowdown.

Going around `spawn()` also means going around every teardown `spawn()` would
have arranged. **There is no record, so nothing in `dispose()` or `clear()` ever
reaches that session.** Disposing it in the judge's own `finally` is the whole
cleanup, and the session is captured at CREATION rather than read off the result
— because `result` is only assigned when the await resolves, so every rejection
after `createAgentSession()` returned would otherwise drop the only reference to
a live session. That is finding V7 of the ninth pass, and it is the closest
earlier relative of this pass's axis.

### 6.2 The gate before the judge

`buildVerifyDeps` returns `undefined` for a `__verifier` record — the judge is
never judged. `runVerification` reads the three settings (`verify`, the timeout,
the repair budget) at one moment rather than at three, and the structural gate
refuses to judge an aborted, turn-limited or model-errored run.

### 6.3 The bound

`DEFAULT_VERIFY_TIMEOUT_MS` is 300 s per call, composed with the operator's stop:

```
   startDeadline(label, timeoutMs, stopSignal)
     controller = new AbortController()
     timer = setTimeout(() => { expired = true; controller.abort() }, timeoutMs)
     timer.unref()
     stopSignal?.addEventListener("abort", onStop, {once: true})
     return { signal, assertNotExpired, cancel }

   cancel(): clearTimeout(timer); stopSignal?.removeEventListener("abort", onStop)
```

Both halves of the teardown, in one `cancel`, called from one `finally`. This is
the exemplar the ledger measures the rest of the stack against.

---

## 7. The guard — `.pi/extensions/compaction-guard`

Three jobs, all of them bounds:

1. **The carried-over summary grows without bound.** Measured over 42 real
   compaction points: 456 → 4,029 → 11,054 characters, monotonic within a
   session, because pi's own update prompt tells the model to PRESERVE what it
   already contains. `capSummary` sizes a cap from the context window.
2. **The model cannot see its own context budget.** Above 87% of the window, 52%
   of turns come back empty against 1.5% below it. A bounded notice is injected.
3. **Telling it does not stop it.** On 2026-08-17 the CRITICAL notice was in
   context at 84.5% and the model ran a curl loop returning 17,790 characters,
   taking the window to 100%. A single tool result is now capped to a share of
   what context is LEFT, with the overflow written to a spill file the marker
   names — and that cap applies to a FAILING command too, which is where up to
   ~12,500 tokens of a 32,768-token window used to be exempt.

The spill writer is shared with `vendor/pi-subagents-lite/src/spawn/result-cap.ts`
so the bound and the reason for it are one thing. It is where AL9 lives.

### 7.1 browser-guard

166 lines. It classifies a browser-tool error string with a `TRANSPORT_FAILURE`
regex and turns a transport death into an explicit message rather than a silent
empty result. It starts nothing and ends nothing; it has no row in the ledger.

---

## 8. prinny — `vendor/prinny-channel`

### 8.1 The shape

```
   extensions/index.ts   the pi extension: 13 handlers, /prinny, 2 tools
        │  stdio, MCP framing (src/mcp-stdio.ts)
        ▼
   server/bin/prinny-channel.mjs   stages and compiles a runtime out of tree,
                                   keyed on a content fingerprint of src/
        │
        ▼
   server/src/server.ts    the sidecar: an MCP server on fd 1, a Matrix client
                           behind it, ~1,300 lines
```

The sidecar is a **separate process**. That is the only process boundary in the
whole stack, and it is the reason AL3 is worth more than the memory it costs: the
extension cannot see what the sidecar is holding.

### 8.2 What the extension starts

```
   the sidecar process       startChannel()      stopChannel() → instance.stop()
   the MCP handshake         McpChild.start()    McpChild.stop()
   per-request timers        request()           cleared on reply or timeout
   awaitingReply entries     every inbound msg   only LIVE ones are retired
   the delivery sweep        armDeliverySweep()  sweepUndelivered's disarm ← AL4
   the typing interval       applyTyping()       applyTyping()
   the typing INDICATOR      sendTyping(true)    stopTyping()             ← AL6
   pendingPermissions        requestApproval()   the reply, or the timeout
   the compaction lock       beginCompaction()   endCompaction(), 3 exits
   a deferred /compact       AD3's deferral      abandonPendingCompaction()
```

### 8.3 What the sidecar starts

```
   the Matrix client         buildBot() per attempt   nothing                ← AL3
   the Olm crypto store      inside that client       bot.stop() on shutdown
   the approvals interval    module scope, unref'd    never (by design)
   the orphan watchdog       module scope, unref'd    never (by design)
   the PID file              at boot                  shutdown(), if it is ours
   the bootstrap lock dir    stageRuntime()           a finally, plus a
                                                      liveness check on the owner
```

The bootstrap lock is worth reading before writing anything else in this stack:
it is the only place that already answers "is the process that made this still
alive?", and it is the precedent AL9's fix follows.

### 8.4 The outbound gate

`forwardToMatrix` sends only to a room that is **live** — pi took a message from
it and owes it an answer. With more than one live room it refuses to guess and
sends nothing, and `unansweredRooms` then tells each of them why. Silence is
ambiguous; a wrong apology is a claim.

---

## 9. rtk and stack

`vendor/rtk-pi` rewrites an approved command to run under `rtk`, on the same
mutable `event.input` prinny's relay already read. `.pi/extensions/stack.ts` is
1,321 lines of local-model stack control, every mutation of which is a user-only
command, and every branch of which ends in `pi.exec` — which emits no `tool_call`
and is therefore invisible to the permission relay, rtk's gate and the guard's
output cap alike.

Neither starts anything with a lifetime. Neither has a row in the ledger.

---

## 10. What has to stay true

### 10.1 The five invariants that have never changed

1. **One llama slot.** Concurrency defaults to 1. Anything that waits for a model
   call while holding the slot is a deadlock, not a slowdown.
2. **A child must not drive the parent.** Every extension in this stack refuses
   to act inside a subagent spawn, and the guard is at the factory, not per
   handler.
3. **A delivery that did not happen is the loudest thing to report.** It must
   never be the quietest.
4. **A refused Matrix command must not arrive as text.** Otherwise the model can
   be talked into running it some other way.
5. **The operator is the trust boundary; the model is not.** `permissionMode` is
   an operator saying exactly that.

### 10.2 …and the sixth, which this pass adds

6. **A construct with a beginning has exactly one ending, and every path that
   finishes the work goes through it.** Where the ending is the host's rather
   than ours, that fact is written down next to the beginning.

The second sentence is the part that costs something. AL7 is harmless *because
of a property of pi* and there was no way to know that from this repository; the
fix is half a call and half a paragraph naming `interactive-mode.js:1726`, so
that the next pi upgrade has one thing to re-check instead of a silent regression
in the widget's keyboard.

### 10.3 The bounds, all of them

Every writer in this stack is bounded, and this is the list. A pass on this axis
should read it as "and what removes the last one?".

| what | bound | what happens at the bound | who removes it |
| --- | --- | --- | --- |
| a subagent's transcript | 60 entries; 4,000 chars, 120 lines each | a `dropped` count, and the closing entry is forced | the record's disposal |
| the verify log | 2,000 lines | rotated in place | never |
| the loop log | 5 MB | rotated to `.1` | never |
| a capped tool result | a share of the context that is LEFT | spilled to a file the marker names | the spill's own count bound |
| the spill directory | 50 files | oldest pruned, newest never | the process's death — **and, since AL9, the next process** |
| the carried-over summary | sized from the window | truncated with a marker | the next compaction |
| a delegation | `maxTurns + graceTurns` | hard abort, classified | — |
| a verifier call | 300 s, composed with Esc | `assertNotExpired` throws | `deadline.cancel()` |
| a repair | 3 rounds | the answer goes out annotated | — |
| the delivery grace | 60 s of idle | the sender is told | the sweep's disarm |
| the connect retry | none, deliberately | it retries forever | `shuttingDown` |
| the compaction lock | 5 minutes | read as absent | the owner's release |
| provider errors | 10 in a row | the loop pauses | a successful turn |
| the record map | **none** | — | the operator's Clear, or the session |

The last row is the one this pass leaves open on purpose; §13.1 says why.

### 10.4 The three globals

```
   __PI_SUBAGENT_SPAWN_DEPTH__     shell.ts       "am I inside a child?"
   __PI_COMPACTION_IN_FLIGHT__     two copies,    "is somebody compacting?"
                                   asserted equal
   the module scope itself         everywhere     survives a session
```

The compaction lock is the best-shaped lifetime in the stack and is worth
reading as a template: `{owner, at}`, taken by `beginCompaction(owner)`, released
by `endCompaction(owner)` **only if that owner holds it**, and read as absent
past `STALE_MS`. Three properties in one small object: an owner check so a late
release cannot free somebody else's lock, a timestamp so a lost release costs one
wait rather than the session, and a protocol written down in both copies so the
two cannot drift.

### 10.5 The lifetime ledger — this pass's artefact

Every construct in the stack with a beginning and an end. **START** is where it
begins; **END** is the one place that ends it; **PATHS** counts the ways of
finishing the work, and **⚑** marks a row where they do not all pass through the
END.

```
 ── vendor/pi-subagents-lite ────────────────────────────────────────────────────
 #  THING                  START                      END                    PATHS
 1  the record             manager.spawn              removeRecord / dispose   2  ⚑
 2  the completion gate    createCompletionGate       openGate (deletes)       6
 3  the parent binding     signal.addEventListener    detachParentBinding      5
 4  the concurrency slot   slots.reserve              slots.release            3
 5  the watchdog's clock   watchdog.start             check()'s self-heal      1
 6  the child session      createAgentSession         removeRecord / dispose   2  ⚑
 7  the judge session      runAgent(onSessionCreated) the judge's finally      1
 8  the verify deadline    startDeadline              deadline.cancel          1
 9  the verifyAbort        runVerification            settlement / stopAgent   2
10  the output log         new AgentOutputLog         finalize                 1
11  the transcript         new AgentTranscript        finalize / dispose       2
12  the transcript's sub.  attachTranscript           setCleanup → cleanup     1   AL1
13  the widget poll        ensureTimer                update()'s stopTimer     1   AL5
14  the widget itself      setWidget                  clearWidget / pi         2
15  the nudge batch        scheduleNudgeIn            the timer, or dispose    2
16  the terminal input     ctx.ui.onTerminalInput     session_shutdown         1   AL7
17  the spill directory    createSpillWriter          the next process         1   AL9
18  the abort controller   spawn / continueSettled    GC (nothing to release)  —

 ── vendor/pi-loop-mode ─────────────────────────────────────────────────────────
19  the run                /loop start                stop/end/5 pauses/cap    8
20  the pending timer      scheduleLoopTurn           clearPendingTimer       13
21  the session's model    interveneStuck             standDownRescue         10   AL2
22  the footer pill        30 × setStatus             /loop end, then pi       2   AL8
23  the compaction lock    beginCompaction            endCompaction            3
24  the context recovery   saturation                 resetContextRecovery     4
25  the loop log           appendLogEntry             rotates at 5 MB          1

 ── vendor/prinny-channel (extension) ───────────────────────────────────────────
26  the sidecar process    startChannel               stopChannel              4
27  the MCP handshake      McpChild.start             McpChild.stop            1
28  a request              McpChild.request           reply, or its timer      2
29  an awaitingReply entry deliverInbound             forwardResult (live only) 1 ⚑
30  the delivery sweep     armDeliverySweep           sweepUndelivered         1   AL4
31  the typing interval    applyTyping                applyTyping              1
32  the typing INDICATOR   sendTyping(true)           stopTyping               3   AL6
33  a permission prompt    requestApproval            reply / timeout / stop   3
34  the compaction lock    beginCompaction            endCompaction            3
35  a deferred /compact    AD3's deferral             drain / abandon          2

 ── vendor/prinny-channel (sidecar) ─────────────────────────────────────────────
36  the Matrix client      buildBot, per attempt      discardBot / shutdown    2   AL3
37  the Olm crypto store   inside the client          the client's stop        1
38  the PID file           boot                       shutdown, if it is ours  1
39  the bootstrap lock     stageRuntime               a finally + liveness     2
40  the approvals tick     module scope, unref'd      never — by design        0
41  the orphan watchdog    module scope, unref'd      never — by design        0

 ── .pi/extensions/compaction-guard ─────────────────────────────────────────────
42  the spill directory    createSpillWriter          the next process         1   AL9
43  a spill file           spillFile()                pruneSpills, at 50       1
```

Nine rows carry a finding. Four rows carry a **⚑** that is *not* a finding, and
each one is a deliberate decision with a reason recorded in §13.1: the record and
the child session are kept so a settled delegation can be continued; an
`awaitingReply` entry is kept so a late `markLive` can still deliver the answer.

#### 10.5.1 The findings by DISTANCE

The twentieth pass drew its findings by how far the two halves of a predicate
were from each other. The same drawing for this axis measures the distance from
the START to the nearest correct END of the same kind:

```
   AL2   the rescue model      ── 0 files ──  the stand-down is in the same file,
                                              on rung 7, 2,600 lines away
   AL4   the delivery sweep    ── 0 files ──  the typing interval, 30 lines up,
                                              arms and disarms on one predicate
   AL6   the typing indicator  ── 0 files ──  the delivery timer, 12 lines down
                                              in the SAME FUNCTION, is cleared
   AL8   the footer pill       ── 0 files ──  prinny's setStatus(undefined), one
                                              package over, does exactly this
   AL3   the sidecar's client  ── 1 file  ──  the extension's startChannel catch
                                              is `await instance.stop()`
   AL5   the widget poll       ── 1 file  ──  the manager's watchdog interval is
                                              unref'd and cleared in dispose
   AL7   the unregister        ── 0 files ──  four other things are disposed in
                                              the very handler it is missing from
   AL9   the spill directory   ── 1 file  ──  the bootstrap lock's liveness check
   AL1   the anchor            ── 0 files ──  the compaction re-anchor, 20 lines
                                              below, states its own reason

   SEVEN OF NINE are distance zero. In five of those the correct version of the
   same construct is visible on screen at the same time as the defective one.
```

That is not a coincidence and it is the practical finding of this pass. A
teardown is written next to the thing it tears down, so a *missing* teardown is
almost always adjacent to a *present* one for a sibling construct. **The cheapest
way to run this axis is not to search for leaks; it is to open every file that
contains a `clearInterval`, a `.dispose()`, a `.stop()` or a `removeEventListener`
and ask what ELSE that function should be ending.**

#### 10.5.2 The four shapes, and what each one's fix must be

§0.1 states them; here is the operational form, with the row each belongs to.

```
   SHAPE 1  ONE ENDING, MANY EXITS          rows 21, 32, 22    AL2, AL6, AL8
     The fix is ALWAYS a named function called from every exit, never an
     additional case. AL2's repair is not "also stand down on /loop end"; it is
     `standDownRescue`, nine callers. If the fix reads as "handle X too", the
     next X is already written.
     TEST: enumerate the exits from the source and assert the count.

   SHAPE 2  NO ENDING AT ALL                rows 36, 13, 16, 17, 42  AL3,5,7,9
     The end has to be written. Two sub-cases, and they need different work:
       (a) the value exists and nobody calls it   → call it            (AL7)
       (b) there is no path back to the start     → the missing path is a
           SECOND finding                                             (AL5)
     TEST: drive the construct N times and count what is left.

   SHAPE 3  AN ENDING THAT CANNOT BE REACHED   row 30              AL4
     The disarm must be the SAME predicate as the arm, in one function, with the
     difference between them named. `sweepHasWork` is `undeliveredRooms` with
     the clock removed, and both call `awaitsVerdict`.
     TEST: for every state, assert that "is there work" and "should it report"
     agree wherever the clock does not separate them.

   SHAPE 4  A BEGINNING THAT ASSUMES IT IS THE FIRST   row 12       AL1
     The default that was right stays right and says which caller it is for; the
     new caller states its own. Never make the default "clever" — a computed
     anchor would be wrong for both.
     TEST: the first attach and the new attach, both, plus the third case that
     resets it (the compaction re-anchor).
```

---

## 11. The findings

Each section gives the defect, the mechanism, the fix, the regression test and
its **control run** — the number of new tests that fail when the fix is reverted
and nothing else is touched.

### 11.1 AL1 — the follow-up that replayed the run before it

**Shape 4.** `vendor/pi-subagents-lite/src/agents/output-file.ts`

`streamAgentOutput(session, sink, stats, bufferSize, onTurnFlush, startIndex = 1)`
subscribes to a session and writes each new message to a sink. The default of 1
is the FIRST attach — `onSessionCreated`, where index 0 is the prompt the caller
has already written as its own opening line. `AgentOutputLog` only ever attaches
there, so for the life of the file the constant was right.

The twentieth pass added a second attach. `continueSettledAgent` builds a fresh
`AgentTranscript` for a follow-up — deliberately, so the follow-up is recorded
rather than silently absent — and subscribes it to the child's **existing**
session, which by then holds every message of the run that has already settled.

```
   the child's session, when a follow-up is steered into it:

     [0]  user       "map every call site of resolveWorktree"
     [1]  assistant  step 0: read a file and grep for the symbol
      …                                                        ← 140 messages
     [141] assistant "ANSWER: eleven call sites, listed by file."
     [142] user      "now list the three that pass a relative path"   ← the ask
     [143] assistant "Three of them: parseArgs, loadConfig, resolveMain."

   BEFORE  anchor = 1     the entry labelled "turn 1" of the follow-up held
                          messages 1…N of the SETTLED run, `dropped: 92`
   NOW     anchor = 142   the entry holds the follow-up
```

**The bound is what hid it.** `MAX_ENTRY_CHARS` (4,000) and `MAX_LINES` (120)
keep the head of what an entry is handed and count the rest as `dropped`. So what
fell off the end was the answer the follow-up was about, and on screen that is
indistinguishable from a long answer that was truncated. Nothing about the
symptom points at a replay.

**Fix.** `startIndex` is a parameter. `AgentOutputLog` keeps 1 and the docstring
now says which attach that is for. `continueSettledAgent` passes
`session.messages.length`. The compaction re-anchor inside `streamAgentOutput`
still resets to 1 and is still right — pi REBUILDS the array, so index 0 is the
new summary.

**Tests.** `vendor/pi-subagents-lite/tests/continuation-transcript.test.ts`, 5
tests, including one that asserts the *defect* is still what the default would
produce, so the suite fails if the anchor default ever moves silently.
**Probe** `y1`, three modes: `followup`, `first`, `compaction`.

### 11.2 AL2 — the rescue turn that never ended

**Shape 1.** `vendor/pi-loop-mode/extensions/index.ts`

After `RESCUE_AFTER` (3) consecutive stuck interventions, `interveneStuck` calls
`pi.setModel(rescueModel)`. There is no narrower scope than the session, so the
switch is a global fact about the operator's own next turn — for what the notice
calls a *rescue TURN*, singular.

The undo lived in exactly one place: the `state.rescueActive` block in
`agent_end`. That is rung 7 of eighteen.

```
   rung 1  softStopRequested   → finalizeSoftStop                       return
   rung 2  context pressure    → recovery, or pauseForContextFailure    return
   rung 3  provider error      → backoff & retry; at 10, pause          return
   rung 4  degenerate abort    → interveneStuck                         return
   rung 5  operator abort      → paused                                 return
   rung 6  (bookkeeping — counters, iterationCount++, commitTurnMemory)
   ─────── rung 7 — the ONLY stand-down ───────────────────────────────────────
   /loop stop      never reaches agent_end
   /loop end       never reaches agent_end, AND destroys the return address
   /loop finish    (idle branch) never reaches agent_end
```

**Rung 3 is the one that costs most, and it is the likeliest of the set.** A
rescue model is named on the command line and unused until the third consecutive
stuck intervention, so the first time anybody discovers it is not loaded in
llama-server is the turn it takes over. `switchModel` has already returned true
by then — it only fails on "no API key" — so the failure arrives as an empty
turn, rung 3 catches it, and the loop retries **on the rescue model**, ten times,
against an escalating backoff, before pausing on it.

**`/loop end` is the one that cannot be repaired afterwards.** Its body is
`state = defaultState()`, which destroys `rescueReturnModel` — the only record of
what the session was on before.

**Fix.** One `standDownRescue(pi, ctx)`, called from ten places:
`finalizeSoftStop`, the three `pauseFor…` functions, `/loop finish`, `/loop stop`,
`/loop end`, and three points in `agent_end` — rung 3 (the provider-error rung,
above the retry rather than below it, so the retry and the nine after it do not
run on the model most likely to be the reason there was no assistant message),
rung 5 (the operator abort), and rung 7 itself. It clears
`rescueActive` and `rescueReturnModel` **synchronously** and returns the switch as
a promise, so a synchronous caller can `void` it and still persist a clean state
on the next line, and a second caller on the same tick cannot ask for the restore
twice. When there is nothing to switch back to it says so rather than leaving the
operator to notice the model change on their own.

**Tests.** `vendor/pi-loop-mode/tests/rescue-stand-down.test.ts`, 14 tests, each
paired with the control that has to keep holding. **Control run: 10 of 14 fail
with the fix reverted.** **Probe** `y2`, seven modes, which climbs the real
ladder with four turns of fixated output and asserts it arrived before testing
anything.

### 11.3 AL3 — the client every failed attempt built

**Shape 2(a).** `vendor/prinny-channel/server/src/server.ts`

`startMatrix` retries the homeserver **forever**, deliberately, and says why: *"a
homeserver that comes back should not need the user to restart pi."* The loop it
was written as constructed a client per attempt and stopped none of them:

```js
   for (let attempt = 1; ; attempt += 1) {
     try {
       const next = buildBot(await resolveDeviceId());   // ← a NEW client
       registerHandlers(next);
       await next.setMyCommands(COMMANDS);
       await next.start();                               // ← throws HERE
       bot = next;                                       // ← the only handle
       return;
     } catch (err) {
       if (shuttingDown) return;                         // ← and abandons it here
       await sleep(Math.min(1000 * attempt, 30_000));
     }
   }
```

`bot` is assigned only on the success path, and `shutdown()` stops `bot`. Every
failed attempt's client was therefore unreachable and running.

It is not only memory. `buildBot` hands each one `storePath: CRYPTO_STORE_PATH`,
and the header of `server/src/state.ts` — the file that defines that constant —
opens with the sentence this loop makes false:

> Everything lives under one directory so a second bot on the same machine is a
> matter of pointing `PRINNY_STATE_DIR` somewhere else — **including the crypto
> store, which must never be shared between two running bots.**

`start()` is where the login happens, so a wrong password, an expired token, a
502 from a reverse proxy and an unreachable host all arrive *after* construction
— which is the only point at which there is something to leak. The backoff caps
at 30 s, so an overnight outage is of the order of a thousand clients.

**The control is one package away and gets it right.** The extension's
`startChannel` wraps the same shape:

```js
   } catch (err) {
     …
     await instance.stop().catch(() => undefined);
     child = null;
   }
```

Same repository, same week. The difference is that `startChannel` runs once and
this loop runs forever — exactly backwards from where the care was needed.

**Fix, in two parts.**

`server/src/connect.ts` is new, imports **nothing**, and holds the loop:

```js
   export async function connectWithRetry(hooks) {
     for (let attempt = 1; ; attempt += 1) {
       if (hooks.stopping()) return undefined;
       let candidate;
       try {
         candidate = await hooks.build(attempt);
         await hooks.start(candidate, attempt);
         const connected = candidate;
         candidate = undefined;          // ownership passes to the caller
         return connected;
       } catch (err) {
         if (candidate !== undefined) { try { await hooks.discard(candidate, attempt) } catch {} }
         if (hooks.stopping()) return undefined;
         const delay = hooks.delayMs(attempt);
         hooks.onError(attempt, err, delay);
         await hooks.sleep(delay);
       }
     }
   }
```

The split between `build` and `start` is the whole fix: after `build` resolves
there is a client holding the crypto store, and every exit from that point on
goes through `discard`. `resolveDeviceId()` stays inside `build` and *before*
construction, so a whoami that fails leaves nothing to stop.

Three smaller things that fall out of it and are each worth a line:

- **The discard runs before the `stopping()` test**, not after. A client built
  during a shutdown still holds the crypto store, and `shutdown()`'s whole reason
  for waiting on `stop()` is that losing the last minutes of Olm state forces
  every peer to re-key.
- **`stopping()` is also tested at the top of the loop.** The backoff caps at
  thirty seconds; a shutdown landing inside one used to be answered by building
  one more client and attempting a login with it.
- **`discardBot` is capped** at `DISCARD_STOP_MS` (5 s, the same figure
  `shutdown()` uses) with `Promise.race`. A `stop()` that never settles on the
  retry path would turn "retry forever" into "retry never" — the failure the loop
  exists to prevent, reached through its own repair.

**Why a module with no imports.** `server/src/server.ts` boots a sidecar at
import — it reads credentials, opens an MCP transport on fd 1 and installs signal
handlers — so a test cannot load it, and every assertion ever made about
`startMatrix` was an assertion about its source TEXT. Node does **not** resolve a
`./state.js` specifier to `state.ts` (measured), so a module in `server/src` is
reachable from a test only if it stands alone. `connect.ts` does.

**Tests.** `vendor/prinny-channel/tests/connect.test.ts`, 12 tests, including one
that drives a hundred failed attempts and asserts that exactly one client is
alive and it is the one returned, and one that asserts the ORDER — the old client
is stopped before the next is built, because "two running bots" is the state the
crypto store cannot be in. **Control run: 6 of 12 fail with the fix reverted.**
**Probe** `y3`, three modes: `outage`, `recovered`, `shutdown`.

**Also**: `prinny-channel`'s `lint` script covered `extensions/`, `src/` and
`tests/` but not `server/src/` — the entire sidecar payload except its bin. It
does now, and passes.

### 11.4 AL4 — the sweep that could not stop

**Shape 3.** `vendor/prinny-channel/extensions/index.ts` and `src/delivery.ts`

`armDeliverySweep()` starts a 30 s interval on the arrival of ANY inbound
message. Stopping it was `sweepUndelivered`'s own job:

```js
   const rooms = undeliveredRooms(awaitingReply.entries(), Date.now(), agentRunning);
   if (rooms.length === 0) {
     if (deliveryTimer && ![...awaitingReply.values()].some((e) => !e.live)) {
       clearInterval(deliveryTimer);
       deliveryTimer = undefined;
     }
     return;
   }
```

Two questions, and they are not the same question:

```
   arm     a message arrived                                (no exceptions)
   disarm  nothing is reportable right now
           AND no entry has `live === false`                (STRICTLY WEAKER)
```

Nothing retires a dead entry. `forwardResult` deletes only the LIVE ones —
`if (entry.live) awaitingReply.delete(room)` — and the sweep deliberately leaves
a reported entry in place so that a late `markLive` can still deliver the answer.
So the moment the sweep reported one message, that entry sat in the map with
`live: false, undeliveredReported: true` for good: the first half of the disarm
passed forever (it is reported, so it is not reportable again) and the second half
could never pass again.

**It needs no failure at all to reproduce.** A Matrix `/loop status` is a
local/run command: it arms the sweep on arrival and is marked `answered`, which is
also `live: false` forever. One command is enough.

Measured over an hour of session (probe `y4`): 120 wake-ups, over a map that only
grows, with nothing to do. A day is 2,880. The interval is `unref`'d, so it never
held a process open — the cost is small and the shape is the point.

**Fix.** One predicate, `awaitsVerdict(entry)`, used by both readers:

```js
   function awaitsVerdict(entry) {
     return !entry.answered && !entry.live && !entry.undeliveredReported;
   }
   // undeliveredRooms: awaitsVerdict(entry) AND the grace has passed
   // sweepHasWork:     awaitsVerdict(entry)              ← the same, no clock
```

`sweepHasWork` is `undeliveredRooms` with the clock removed, which is exactly the
right relation: an entry inside its grace is not reportable *yet* and must keep
the timer; one that is answered, live or already reported can never be reportable
again and holds nothing. `agentRunning` is deliberately **not** a parameter — a
running agent suppresses the verdict, not the work.

The disarm also moved out from behind the `if (rooms.length === 0) { … return; }`
to the end of the function, unconditional, so the tick that reports the last
message is also the tick that stops.

**The control is thirty lines up in the same file.** `applyTyping` reconciles
against one predicate, `typingRooms.size`, and arms and disarms in one place:

```js
   if (typingRooms.size === 0 && typingTimer) { clearInterval(typingTimer); typingTimer = undefined }
   else if (typingRooms.size > 0 && !typingTimer) { typingTimer = setInterval(refreshTyping, …) }
```

**Tests.** 11 added to `vendor/prinny-channel/tests/delivery.test.ts`, including
one that asserts, for every entry state past its grace, that "does it hold the
timer" and "is it reportable" agree — the property that keeps the two from
drifting again. **Control run: 5 of 11 fail with the fix reverted.**
**Probe** `y4`, three modes: `undelivered`, `command`, `answered`.

### 11.5 AL5 — the eighty-millisecond poll nobody stopped

**Shape 2(b).** `vendor/pi-subagents-lite/src/ui/agent-widget.ts`

`ensureTimer()` armed a `setInterval` at `WIDGET_REFRESH_INTERVAL` — **80 ms**.
`SpawnCoordinator.spawn` and the menu wizard call it on every spawn. `dispose()`
at `session_shutdown` was the only clear.

`update()` had the right test and did the wrong thing with it:

```js
   if (!hasActive && !hasFinished) {
     if (this.widgetRegistered || this.lastStatusText !== undefined) this.clearWidget();
     return;                       // ← returning is not stopping
   }
```

so the interval kept firing after the last finished row aged out of the retention
window. Each tick calls `categorizeAgents()` → `listAgents()`, which **copies and
sorts every record the manager has ever held**, and nothing prunes that map: a
settled record stays until the operator Clears it or the session ends (ledger row
1). An unattended `/loop` that delegates each iteration therefore made the tick
more expensive the longer it ran — forever, to draw nothing.

It was also the one long-lived **interval** in this stack not `unref`'d. The
other three say so out loud: *"never hold the process open for a deadline that
has outlived its session"*, *"never hold the process open for a typing
indicator"*, *"never hold the process open to complain about a message."*

**Fix, and the second finding inside it.** `update()` now calls `stopTimer()`
where it used to return. That is only safe if something is guaranteed to start it
again — and the hook that does, `AgentManager.onStart`, which `startAgent` has
called since the package was written, **was a constructor parameter with no
setter, constructed with `undefined`**. It was wired to nothing. Stopping the
timer is what made that visible.

```
   AgentManager.setOnStart(cb)          new
   events.ts                            newManager.setOnStart(() => {
                                          getWidget()?.ensureTimer();
                                          getWidget()?.update();
                                        })
   continueSettledAgent                 this.onStart?.(record)     new — the one
                                        route back into "there is something to
                                        show" that is not a spawn
```

**Probe** `y5`, three modes: `idle` (the poll stops), `active` (a running
delegation keeps it armed — the control), `continuation` (a settled record goes
back to running, `onStart` fires, the poll comes back).

### 11.6 AL6 — the indicator a stopped channel left up

**Shape 1.** `vendor/prinny-channel/extensions/index.ts`

`planStopAll`'s own docstring names its callers:

> Every active room, for the end of a turn **or a shutdown** — state-independent
> on purpose.

Two of `stopTyping`'s three callers were the end of a turn. The shutdown was not
one of them.

`stopChannel` runs on `session_shutdown`, on `/prinny stop`, and on both arms of
a restart. It clears the delivery sweep's interval, with a reason:

> Nothing can be reported to a room once the sidecar is gone, and the sweep's
> only action is a reply. Cleared here so a stopped channel does not keep an
> interval alive to discover that.

Every word of that is true of the typing interval as well, thirty lines up in the
same file, and it was not cleared. Two consequences, and the second is the one a
person sees:

- the 8 s refresh kept firing `typing` calls at a sidecar that was gone, each one
  rejecting into `sendTyping`'s empty catch;
- **nobody was ever sent `typing: false`**, so every room the bot was composing in
  kept the indicator up until Matrix's own 20 s timeout expired it. The last thing
  a Matrix user sees of a session that has ended is a bot that appears to still be
  writing.

**Fix.** `stopTyping()` in `stopChannel`, immediately after
`abandonPendingCompaction()` and **before `child = null`** — because
`stopTyping`'s whole body is outbound calls and `callSidecar` goes through
`requireChannel()`, which reads `child`. That is exactly the argument AI2 wrote
one line above it, for exactly the same reason.

**Tests.** 4 added to `vendor/prinny-channel/tests/typing.test.ts`.
**Control run: 3 of 4 fail with the fix reverted.** **Probe** `y6`.

### 11.7 AL7 — the unregister that was never called

**Shape 2(a), latent.** `vendor/pi-subagents-lite/src/events.ts`

```js
   let unregisterTerminalInput: (() => void) | undefined;

   pi.on("session_start", async (_event, ctx) => {
     …
     if (ctx.hasUI && !unregisterTerminalInput) {
       unregisterTerminalInput = ctx.ui.onTerminalInput(createNavInputHandler(ctx));
     }
   });
```

Two references in the whole package: the assignment, and the guard that reads it
as "already done". The one value in the file whose only purpose is to END
something had no caller — four lines above a `session_shutdown` handler that
disposes the coordinator, the store, the widget and the manager by name.

**The question that decides how bad this is is not answerable from this
repository**, and that is the point. Measured against pi 0.84.2 (probe `y7`):

```
   onTerminalInput → addExtensionTerminalInputListener   interactive-mode.js:1834
   clearExtensionTerminalInputListeners                  interactive-mode.js:1848
     …called by resetExtensionUI                                            :1715
     …and by stop()                                                         :5425
   resetExtensionUI IS the beforeSessionInvalidate hook                     :345
   teardownCurrent (/new, /resume, /fork, import) runs it   agent-session-runtime.js:111
   dispose (quit) runs it                                                   :293
```

So pi drops the subscription every time, and pi re-invokes the extension factory
for the new session, which gives the guard a fresh `undefined` and lets it
subscribe again. **Nothing was ever wrong for a user, and this is reported as
latent.**

What makes it worth closing is the failure it *would* have. The guard is
`!unregisterTerminalInput`. A stale handle reads as "still subscribed", so if pi
stopped clearing, the widget's arrows, Enter into the viewer and Escape would go
dead after the first `/new` — silently, with nothing anywhere to report it. And a
teardown that depends on somebody else's teardown, with nothing saying so, is
what this pass is about.

**Fix.** Call it at `session_shutdown`, before the four things it already
disposes (so no key can arrive for a widget that is gone), inside a `try`, and
clear the handle so the guard lets the next session subscribe. Plus a paragraph
naming the pi call chain above, so a pi upgrade has one place to be re-checked.

**Tests.** `vendor/pi-subagents-lite/tests/session-teardown.test.ts`, 6 tests,
one of which asserts the *documentation* names `clearExtensionTerminalInputListeners`
— because half this fix is the sentence. **Control run: 4 of 6 fail with the fix
reverted.** **Probe** `y7`.

### 11.8 AL8 — the footer that outlived the loop

**Shape 1.** `vendor/pi-loop-mode/extensions/index.ts`

`ctx.ui.setStatus("loop", …)` appears **thirty** times in that file.
`setStatus("loop", undefined)` — the call that takes a pill out of pi's footer —
appeared **none**. So nothing the extension does has ever removed one; the only
thing that ever did was the host, at `resetExtensionUI()`, when the session is
replaced.

Twenty-nine of the thirty are right as they stand. "Loop paused (max
iterations)", "Loop stopped", "Loop completed (check passed)", "Loop context
cooldown 30s" all describe a loop that still **exists**: it is in
`.pi-loop-state.json`, `/loop status` reports it, and `/loop resume` acts on it.
A footer that keeps saying so is telling the truth, and is the point of a footer.

`end` is the exception, and it is the only one. Its body is:

```js
   await standDownRescue(pi, ctx);
   runToken++;  clearPendingTimer();  resetTurnBuffers();  resetContextRecovery();
   state = defaultState();                       // ← there is no loop any more
   persistState(pi);
   notify(ctx, "Loop ended and state cleared.", "info");
   ctx.ui.setStatus("loop", "Loop ended");       // ← naming one anyway
```

so the pill named something that had been deleted one line earlier, for the rest
of the session. The footer and `/loop status` then disagreed — probe `y8` prints
both, and after `/loop end` the footer said *"Loop ended"* while status said
`Active: false · Goal: -` — and the footer is the one nobody has to ask.

**Fix.** `ctx.ui.setStatus("loop", undefined)` at `end`/`clear`, and only there.
The notify carries the confirmation; the pill was the only part that had to
outlive it.

**Tests.** `vendor/pi-loop-mode/tests/status-pill.test.ts`, 6 tests, three of
which are the controls for the twenty-nine that stay. **Control run: 3 of 6 fail
with the fix reverted.** **Probe** `y8`, four modes.

### 11.9 AL9 — the bound was per directory, and the directory was per process

**Shape 2(a).** `.pi/extensions/compaction-guard/src/spill.ts`

The file bounds the FILES in a spill directory to fifty, with a careful argument
for why it is a count and not a teardown sweep — a parent and its child share one
directory (the child inherits the guard by discovery), so either one clearing it
at `session_shutdown` would break the other's markers. Every word of that
argument is about the files.

The DIRECTORY is created by `mkdtempSync` on first use, and nothing has ever
removed one. So the real bound was **fifty files per process**, and the number of
processes was bounded by nothing.

Measured on the box before the fix, rather than argued about:

```
   /tmp/pi-tool-output-*        116 directories
   /tmp/pi-subagent-result-*    131 directories
                                ─── 247 directories, 230 MB, over four days
   date spread                  5 on the 17th, 19 on the 18th, 172 on the 19th,
                                51 on the 22nd
```

Every file in them is by construction a payload that did not fit a context
window — at least `MIN_ALLOWANCE_CHARS`, often tens of kilobytes. `npm test` on
the guard contributes one directory per run, deliberately: the suite next door
drives the shipped handler so that its assertion is about a real directory.
`/tmp` here is the container's writable layer.

**Fix.** The file bound is untouched; the missing one is added.

```
   the directory       mkdtemp(`${prefix}${process.pid}-`)      ← names its owner
   the sweep           pruneDeadSpillDirs(root, prefix)         ← once, on the
                                                                  first spill
   who is removed      a directory whose pid is not running
   who is not          a live pid; EPERM (exists, not ours); a directory with no
                       pid in its name (a pre-AL9 build — no evidence either way,
                       and deleting on no evidence is how a sweep eats a live
                       session's spills); any other prefix
```

**Pid rather than age**, because age cannot tell a finished session from a
`/loop` that has been running for a week and last spilled on Monday. The
precedent is in this tree twice already: `server/bin/prinny-channel.mjs`'s
`lockOwnerAlive()` and the sidecar's `bot.pid`. A recycled pid reads as alive and
its directory is kept — the safe direction.

A child session is in the same process, so it still shares the parent's
directory. The sharing argument the header rests on is untouched.

**Tests.** `.pi/extensions/compaction-guard/tests/spill-dirs.test.ts`, 9 tests.
**Control: the whole function is new, so with AL9 reverted the suite does not
load; reverting only the writer half (the pid tag and the sweep call) fails 2 of
9.** **Probe** `y9`, three modes: `week`, `live`, `legacy`.

### 11.10 Off the axis — `boundLines` broke where it should have truncated

Found while reading `transcript-entry.ts` for AL1. `boundLines` walked the lines
of an entry accumulating a character budget and **`break`ed on the line that
crossed it** instead of truncating that line. So a brief written as one long
paragraph — which is the ordinary shape of a delegation brief — became
`lines: [], dropped: 1`.

The existing test *"caps the characters in one entry"* passed on that empty
entry: it asserted the total was under the cap, which an empty entry satisfies
perfectly. **A bound asserted on the wrong side, one pass after the axis about
exactly that.** The line is now truncated with `TRUNCATION_MARK`, and the test
asserts there is something left.

### 11.11 A claim corrected

The first draft of AL5's comment said the widget's poll was *"the one timer in
this stack not `unref`'d"*. That is false, and this pass checked it after writing
it, which is the wrong order.

```
   unref'd    startDeadline's timer · the manager's watchdog interval ·
              mcp-stdio's kill timer and per-request timers · prinny's
              CONNECT_REPORT timer, typing interval, delivery interval and
              permission timers · the sidecar's four
   NOT        SpawnCoordinator's nudge batch (200 ms–5 s)
              ConversationViewer's render debounce (~50 ms)
              events.ts's ctrl+o read-back (0 ms)
              pi-loop-mode's pendingTimer (up to `--delay` seconds)
```

The true claim is narrower: of the four long-lived **intervals** in the stack,
the widget's was the only one not unref'd. The three ref'd one-shots are
milliseconds. `pendingTimer` is ref'd for as long as `--delay` says, and
deliberately — **between iterations that timer IS the loop**, and unref'ing it
would be a behaviour change, not a tidy-up. It stays; the claim moved.

### 11.12 A probe that could not reach the rung it named

`_host.mjs`'s `turn()` built every assistant message with `stopReason: "stop"`.
`agent_end`'s ladder has a rung for an **aborted** turn — rung 5, the operator
pressing Esc — and a helper that can only build `"stop"` cannot reach it. The
first version of `y2`'s `rung5` mode therefore drove rung 7 while printing
"rung5" as its label, and passed.

`stopReason` is a parameter now, defaulting to `"stop"` so every existing probe
is byte-identical. **A probe whose label names a rung it silently never climbed
is the twentieth pass's own finding, one layer out.**

---

## 12. The evidence

### 12.1 The gates

Re-run **before** anything was written, so the *before* column is a measurement
of the tree as this pass found it.

```
                                      before    after
   vendor/pi-subagents-lite  tests     405       411
                             lint       98/98     99/99 files
   vendor/pi-loop-mode       tests     258       264
                             lint      clean     clean
   vendor/prinny-channel     tests     436       463
                             lint      clean     clean, and now covering
                                                 server/src/*.ts
   .pi/extensions/compaction-guard      47        56
                             lint      clean     clean
   vendor/rtk-pi             tests      28        28
                                      ─────     ─────
                                      1,174     1,222
   probes                                97       106
```

### 12.2 The control runs

Each is the new suite with the fix — and nothing else — reverted.

| finding | new tests | fail with the fix reverted |
| --- | --- | --- |
| AL1 | 5 | (the suite includes a live assertion on the defect itself, so it fails if the anchor default ever moves silently) |
| AL2 | 14 | **10** |
| AL3 | 12 | **6** |
| AL4 | 11 | **5** |
| AL5 | — (probe `y5` is the control) | — |
| AL6 | 4 | **3** |
| AL7 | 6 | **4** |
| AL8 | 6 | **3** |
| AL9 | 9 | **2** with only the writer half reverted; the whole suite fails to load with the function removed |

### 12.3 The nine new probes

Each prints BEFORE and NOW, so running it is its own control.

| probe | modes | what it shows |
| --- | --- | --- |
| `y1-the-follow-up-that-replayed-the-run-before-it` | `followup` `first` `compaction` | the entry the operator reads, at both anchors: BEFORE it opens with `step 0:` of the settled run and drops 92 lines; NOW it holds the follow-up's answer and drops none |
| `y2-the-rescue-turn-that-never-ended` | `rung3` `rung3-ten` `rung5` `rung1` `stop` `end` `control` | climbs the real ladder with four turns of fixated output, asserts it reached the rescue turn, then ends that turn each way and prints the sentence the loop actually said and the model it left the session on |
| `y3-the-client-every-failed-attempt-built` | `outage` `recovered` `shutdown` | 100 failed attempts: BEFORE 100 unreachable clients on one crypto store, NOW 0; `recovered` shows the retry doing its job in both columns |
| `y4-the-sweep-that-could-not-stop` | `undelivered` `command` `answered` | an hour of 30 s ticks: BEFORE 120 sweeps and still armed, NOW stops on the tick that finishes the work; `answered` is the mode where the shipped disarm worked, which is why the defect was invisible |
| `y5-the-eighty-millisecond-poll-nobody-stopped` | `idle` `active` `continuation` | drives the real widget and manager; `continuation` shows `onStart` firing and the poll re-arming, which is the half of the fix that is not a `stopTimer` |
| `y6-the-indicator-a-stopped-channel-left-up` | — | what three rooms are told when the channel stops, plus `stopChannel`'s real ordering read out of the source |
| `y7-the-unregister-that-was-never-called` | — | pi's own teardown chain, measured out of `interactive-mode.js` and `agent-session-runtime.js`, then the extension's end of it |
| `y8-the-footer-that-outlived-the-loop` | `end` `clear` `stop` `finish` | the footer and `/loop status` side by side after each; `stop` and `finish` are the controls |
| `y9-the-spill-directory-per-process` | `week` `live` `legacy` | 30 finished sessions' directories swept, the running one kept intact, the untagged ones left |

`y5` needs pi's bundled `jiti` (the widget imports `@earendil-works/pi-tui`);
the rest run under plain `node --experimental-strip-types`.

### 12.4 The standing scans, still green

- Every `beginCompaction` has an `endCompaction` on all three of its exits, in
  both call sites, in both packages.
- Every `slots.reserve` has a `slots.release`, on all three exits.
- Every `addEventListener` in the stack has a matching `removeEventListener` on
  the path that ends the thing it was added for.
- The two `compaction-lock.ts` copies still agree; each package asserts it by
  reading the other's source.
- `stateDir()` in `prinny-channel/src/config.ts` and `server/src/state.ts` still
  agree, by the same arrangement.

---

## 13. What is open, and what was checked

### 13.1 Open by decision

**The record map has no bound (ledger row 1), and the child session with it.** A
settled delegation can be steered — `continueSettledAgent` prompts the same
session again — so the record and its `AgentSession` are deliberately kept until
the operator Clears the row or the session ends. The costs are real: N
delegations in a long session is N live `AgentSession` objects with their message
histories and bound extensions. Three things make it survivable rather than
urgent, and they should be re-read before anyone changes it:

1. the widget no longer walks the map when there is nothing to draw (AL5), which
   was the only per-tick reader;
2. `listAgents()` is otherwise called on demand, by the menu and by
   `session_shutdown`;
3. the alternative — retiring a settled record after a timeout — silently removes
   the operator's ability to steer a delegation they were reading, which is worse
   than the memory.

If it is ever bounded, the bound must be **explicit and announced**, in the way
`AgentTranscript` announces its own: a row that says "retired, N older
delegations dropped", never a row that quietly is not there.

**An `awaitingReply` entry is never deleted unless it goes live** (row 29). Same
argument: the entry is what lets a late `markLive` deliver an answer, and it is
what `mergeAwaiting` folds a second message into. AL4 removes the consequence
that mattered (the interval), and the map itself grows by one small object per
room, not per message.

**The connect retry has no attempt cap** (row 36). That is the whole point of it,
and now that a failed attempt leaves nothing behind, the cost of the thousandth
attempt is the same as the cost of the first.

**`runToken` is monotonic and nothing ends it** (row 19). That is the design: a
stale callback compares rather than being unregistered, which is the one pattern
in this stack that cannot leak.

### 13.2 The measured negatives

Things this pass looked for on its own axis and did not find. A negative is only
worth as much as its control, so each row says how it was checked.

| looked at | verdict | how |
| --- | --- | --- |
| `SpawnCoordinator.dispose` | correct | it reports every queued nudge rather than dropping it (AI1), clears the timer, and sets `disposed` *after* the report so the reason is right |
| `AgentManager.dispose` | correct | fails QUEUED records honestly, disposes each transcript and session, detaches every binding, keeps running records' resolvers so a late `.finally` cannot dangle |
| `startDeadline` | correct | `cancel()` does both halves — `clearTimeout` and `removeEventListener` — from one `finally` |
| the judge session | correct | captured at CREATION, not read off the result, disposed in a `finally` (V7, and W6 which found V7's claim was not yet true) |
| `Watchdog` | correct, and self-healing | `check()` deletes state for anything no longer running, so a missed `stop` costs one tick; its docstring says so |
| the compaction lock, both copies | correct | three exits each, all releasing; owner-checked; stale-bounded |
| `McpChild.stop` | correct | SIGTERM then SIGKILL at `graceMs`, `failPending`, `child = null` |
| `startChannel`'s catch | correct — and the control for AL3 | `await instance.stop().catch(() => undefined)` |
| `applyTyping` | correct — and the control for AL4 | one predicate, arm and disarm in one place |
| `loop-log`'s `readBoundedTail` | correct | `openSync` in the `try`, `closeSync` in the `finally`, and the `catch`'s early return still runs it |
| `pruneSpills` | correct | prunes after the write, so the file just named to the model can never be the one removed |
| `SlotTable.setLimits` | correct | rebuilds every count from the holders, so a precedence change is not destructive |
| `rtk-pi`, `browser-guard`, `stack.ts` | nothing to end | they start nothing with a lifetime |
| `AgentTranscript.setCleanup` | correct | if the transcript is already closed it runs the cleanup immediately rather than storing it |
| `continueSettledAgent`'s transcript | correct | `finalize` sets `record.execution.transcript = undefined`, so a continuation builds a fresh one rather than appending to a closed one |

### 13.3 Still unwatched

1. **`renderSubagentEntry` has never been drawn in a live TUI.** The session-file
   half is measured (probe `x2`) and the bounds are tested; nobody has watched
   the entries appear. AL1 changes what that test should show: spawn one
   delegation, steer it after it settles, and check the follow-up's entry does
   not open with the first run.
2. **The rescue turn has never been driven against a real llama-server with an
   unloaded rescue model.** AL2's whole account of rung 3 is derived from the
   ladder plus `switchModel`'s failure mode, and the probe drives the real
   module — but nobody has watched a real 27B refuse.
3. **The typing indicator on a real Matrix client at channel stop** (AL6). The
   plan is executed and the ordering is source-pinned; the 20 s window is
   Matrix's documented default, not something measured here.
4. **`/prinny prepare` has not been re-run since AL3.** The sidecar runs from a
   staged, compiled runtime keyed on a content fingerprint of `server/src`, so
   the next sidecar start will restage automatically — but that restage does an
   `npm install`, and it has not been exercised in this session.
5. **One bound, unchanged for seven passes:** the compaction lock can only be read
   for compactions an *extension* asked for. pi emits `compaction_start`
   internally (`agent-session.js:1370`) but not as an `ExtensionEvent`.

---

## 14. The pattern across twenty-one passes

The checklist is now fifteen surfaces. Each is a question you can ask of any line
of this stack, and each was found by asking it and getting a wrong answer.

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
  15. WHAT WE START AND NEVER FINISH — name  AL1–AL9  ← this pass
      the ONE place that ends it, then the
      paths that miss it
```

Three of the fifteen turn out to be the same question asked at different
distances, and this pass makes that visible:

- **#12 (what we promised)** found AL3 as much as #15 did. `state.ts`'s header
  says the crypto store must never be shared between two running bots, and
  `startMatrix` is the path where that is false.
- **#8 (what we believe about ourselves)** is §11.11: a claim about unref'd timers
  written before it was checked.
- **#14 (what the test is a proxy for)** is §11.12: a probe whose mode name said
  "rung5" and whose code could not build an aborted turn.

**The residue, in the tense that would have helped.** The next construct with a
lifetime will be written by somebody who has just decided what it is FOR. The
question to ask is not "did I clean this up?" — everyone answers yes — but:
**name the one line that ends it, and then count the ways this function can
return.** Where the answer is "the host ends it", write that down next to the
start, with the file and line, because that is the sentence that will be wrong
first.

---

## 15. Where to look

| you want | read |
| --- | --- |
| the whole machine, one drawing | §1.1 |
| what has a lifetime, and who ends it | §1.2, then §10.5 |
| the four scopes and why module scope is where the leaks are | §1.3 |
| the loop's eighteen rungs | §1.5 |
| the channel's two intervals | §1.6 |
| what pi ends for you | §2.2 |
| the four teardown events | §3.2 |
| every bound in the stack | §10.3 |
| the ledger | §10.5 |
| the four shapes and what each fix must be | §0.1, §10.5.2 |
| a finding | §11.1 – §11.9 |
| the corrections | §11.10 – §11.12 |
| what is open on purpose | §13.1 |
| what was checked and found correct | §13.2 |

**The files this pass touched.**

```
   vendor/pi-subagents-lite/src/agents/output-file.ts        AL1
   vendor/pi-subagents-lite/src/agents/agent-manager.ts      AL1, AL5
   vendor/pi-subagents-lite/src/agents/transcript-entry.ts   §11.10
   vendor/pi-subagents-lite/src/ui/agent-widget.ts           AL5, §11.11
   vendor/pi-subagents-lite/src/events.ts                    AL5, AL7
   vendor/pi-loop-mode/extensions/index.ts                   AL2, AL8
   vendor/prinny-channel/server/src/connect.ts               AL3   (new)
   vendor/prinny-channel/server/src/server.ts                AL3
   vendor/prinny-channel/src/delivery.ts                     AL4
   vendor/prinny-channel/extensions/index.ts                 AL4, AL6
   vendor/prinny-channel/package.json                        the lint gate
   .pi/extensions/compaction-guard/src/spill.ts              AL9
   context/testing/probes/_host.mjs                          §11.12
```
