# Subagents, the loop, and the verifier — the shapes, and the readers that model them

Sixth pass, 2026-08-18. A full read of the three components and the seams
between them, with the machine drawn out from a different angle than the fifth
pass took, and **eight findings (V1–V8) — all eight fixed**, each with an
executable probe that prints BEFORE and NOW, and each with a regression test that
fails when the fix is removed.

**329 tests passing and lint 70/70 caught none of the eight.** The suite is now
**359** and 70/70; §10 has what shipped and the control-run failing count for
each fix.

---

## 0. How this sits next to the other five documents

Each earlier pass found defects in a *place*, and each place was further from
the code than the last:

| pass | document | where the defects were |
| --- | --- | --- |
| first | `…-anatomy.md` (B1–B8) | inside a module |
| second | `…-evaluation.md` (F1–F11) | in the wiring between two modules |
| third | `…-mechanics.md` (T1–T9) | between a module and pi's runtime |
| fourth | `…-surfaces.md` (S1–S10) | between a declaration and its implementation |
| fifth | `…-units.md` (U1–U9) | between the unit a rule is written in and the unit it is enforced in |

This one found a sixth: **between a thing and the part of it a reader takes.**

Every one of V1–V8 is a place where something has more than one part — a
message's content blocks, a run's result object, a state's fields, a ladder's
rungs, a function's two exits, a `(flag, target)` pair — and a reader takes a
subset that *used to be* the whole thing, or that is the whole thing only in the
common case.

- A message used to be empty or not. Now it can be `[thinking]`, and "empty"
  reads three different ways in three modules that all consume it (**V1**, **V2**).
- A run's result has five fields. The settlement chain reads all five; the
  verifier's repair reads one (**V5**).
- `turnLimited` used to mean "cut short". With a one-turn budget it also means
  "finished", and the two are reported identically (**V6**).
- `LoopState` has forty-five fields. `runLoop()` resets twenty-five, thirteen
  more are configuration that must survive, and the remaining seven are per-run
  state it forgets (**V3**).
- The stuck ladder has three rungs. Two are unconditional and the cheapest one
  is guarded (**V4**).
- A judge's teardown covers the exit where its run returns, not the exit where
  it throws (**V7**).
- `preparedAt` and `goalFile` are a flag and its target. One is preserved across
  a re-issued goal and one is reset (**V8**).

Read the other five for evidence, not orientation. Nothing they fixed has come
undone: all ten fourth-pass fixes and all nine fifth-pass fixes are in the tree,
and their probes still run clean.

---

## 1. The whole machine, by the shapes that move through it

The fifth pass's §1 drew the machine as control flow. This draws the same
machine as **data**, because that is where this pass's findings live.

```
   llama.cpp  ──▶  forge (the OpenAI-compatible proxy, :8081)  ──▶  pi
   ═════════       ═════════════════════════════════════════       ═══
   ONE slot        patches/forge_reasoning_passthrough.py           maps
   PARALLEL_       emits `reasoning_content` alongside `content`    reasoning_content
   SLOTS=1         (commit e81a7e5 — before it, reasoning that      onto a THINKING
                    had no accompanying text was DISCARDED)         content block

                                        │
                                        │  one assistant message
                                        ▼
        ┌────────────────────────────────────────────────────────────────┐
        │  { role: "assistant",                                          │
        │    content: [ {type:"text",…} | {type:"thinking",…}            │
        │             | {type:"toolCall",…} ],                           │
        │    stopReason: "stop"|"length"|"error"|"aborted",              │
        │    errorMessage?, usage:{output} }                             │
        └───────────┬──────────────┬───────────────────┬────────────────┘
                    │              │                   │
     ┌──────────────▼──┐    ┌──────▼───────────┐   ┌───▼──────────────────┐
     │ prinny-channel  │    │ pi-loop-mode     │   │ pi-subagents-lite    │
     │ forwarding.ts   │    │ index.ts         │   │ prompt/context.ts    │
     │                 │    │                  │   │                      │
     │ "said nothing"  │    │ "empty response" │   │ extractText()        │
     │  = no TEXT and  │    │  = no text AND   │   │  = the TEXT blocks,  │
     │    no TOOLCALL  │    │    no thinking   │   │    joined            │
     │    block        │    │    AND no tool   │   │                      │
     │                 │    │    call          │   │                      │
     │ UPDATED in the  │    │ NOT UPDATED      │   │ correct by           │
     │ same commit ✓   │    │            ✗ V1  │   │ construction ✓       │
     └─────────────────┘    └──────────────────┘   └──────────────────────┘
```

Three consumers of one shape. The commit that changed the shape carried an
explicit note about the hazard — in `prinny-channel/src/forwarding.ts`:

> `"Said nothing" is not the same as "has no blocks", and the difference arrived
> with the forge patch. Before it, a reasoning-only turn reached pi as
> `content: []` because forge destroyed the reasoning; now it arrives as
> `content: [thinking]`. … a check for an empty array would stop noticing.`

`pi-subagents-lite` never had the problem: `extractText` filters for text blocks
and a thinking-only turn is correctly no answer. `pi-loop-mode` has the problem
in the opposite direction — it is not testing for an empty *array*, it is asking
whether the model produced any characters *at all*, and it counts thinking
characters. That is V1, and V2 is the same fact one branch further down.

Below that, the rest of the machine is unchanged from the fifth pass's account:

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │                                                                          │
   │   extensions bound by -e (scripts/pi-local.sh):                          │
   │     vendor/pi-subagents-lite     4 handlers   Agent·StopAgent·AgentStatus │
   │     vendor/pi-loop-mode         13 handlers   loop tool · /loop          │
   │     vendor/rtk-pi, vendor/prinny-channel                                 │
   │   extensions DISCOVERED under .pi/extensions/ (a child gets these too):  │
   │     compaction-guard  3 handlers, no tools                               │
   │     browser-guard     1 handler,  no tools                               │
   │     stack             1 tool — and guards its own factory (U7)           │
   │                                                                          │
   │   module-global state shared by every session in this PROCESS:           │
   │     pi-loop-mode   state: LoopState · runToken · pendingTimer            │
   │                    turnAssistantTexts · turnToolCalls                    │
   │     pi-subagents   shell { pi, sessionCtx, manager, widget, store,       │
   │                            coordinator }                                 │
   │     shell.ts       __PI_SUBAGENT_SPAWN_DEPTH__  (on globalThis)          │
   └────────────────┬─────────────────────────────────────────────────────────┘
                    │ Agent tool call
                    ▼
   ┌───────────────────────┐      ┌──────────────────────────────────────────┐
   │ SpawnCoordinator      │─────▶│ AgentManager                             │
   │  live view · spawnCtx │      │  SlotTable (default 1) · queue           │
   │  awaits the gate (fg) │      │  Watchdog 45 min tool/idle               │
   │  nudges (bg)          │      │  completion gate per record              │
   └───────────────────────┘      └──────────────┬───────────────────────────┘
                                                 │ runAgent()
                      ┌──────────────────────────┴────────────────────┐
                      │ enterSubagentSpawn()  ← depth > 0 ONLY here   │
                      │   reloadAndMap()   → every factory runs       │
                      │   bindExtensions() → handlers, session_start  │
                      │ exitSubagentSpawn()                           │
                      └──────────────────────────┬────────────────────┘
                                                 ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, in-memory SessionManager         │
   │    own system prompt · own tools · own window · own event bus            │
   │    ceiling 40 turns → wrap-up steer → hard abort 6 turns later           │
   └──────────────────────┬───────────────────────────────────────────────────┘
                          │ settles — status terminal, SLOT STILL HELD
                          ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                       │
   │    structural gate (free) → judge (fresh __verifier session, 1 turn)     │
   │    → repair (the child's own session, 1 turn) → judge again → …          │
   └──────────────────────┬───────────────────────────────────────────────────┘
                          │ .finally: release slot, tally, drain queue, open gate
                          ▼
        foreground ─→ Agent tool result       background ─→ capBackgroundResult()
                                                          ─→ pi.sendMessage()
```

The single constraint that shapes all of it is the slot at the top. One llama
slot means nothing is concurrent with anything else: a child's turn, the judge's
turn, a repair, and the parent's next call are four things in one queue.

---

## 2. One assistant turn, and what each consumer takes out of it

This is the drawing this pass exists for. **One turn, and the last message in it
read seven ways.**

```
   pi emits, for ONE turn:

     message_start ─┐
     message_end    │  msg A: content [ {text:"I'll read the entry point."} ]
     tool_use       │
     tool_result   ─┘
     message_start ─┐
     message_end    │  msg B: content [ {text:"Now the reader package."} ]
     tool_use       │
     tool_result   ─┘
     message_start ─┐
     message_end    │  msg C: content [ {thinking:"the parser looks fine, so
     turn_end       │                             there is nothing to change"} ]
     agent_end     ─┘           ← NO text block, NO tool call. This shape is
                                  new: before e81a7e5 forge dropped the
                                  reasoning and pi got content: []

                        event.messages = [ …, A, B, C ]
                        lastAssistant  = C

   ──────────────────────────────────────────────────────────────────────────
   consumer                       reads                        msg C counts as
   ──────────────────────────────────────────────────────────────────────────
   loop  message_end              messageToText(m)                the THINKING
                                  || messageToRepetitionText(m)   (fallback hits)
     ↳ turnAssistantTexts.push(…)  → committed to the repetition windows
                                     by commitTurnMemory at agent_end

   loop  agent_end                messageToText(last)             ""
     ↳ lastAssistantText           → the LOOP_DONE / LOOP_BLOCKED tests,
                                     and four of detectStuck's seven rules

   loop  agent_end                messageToRepetitionText(last)   the THINKING
     ↳ lastAssistantRepetitionText → the degenerate-repetition scan

   loop  agent_end                !text && !repetition
                                  && toolCallsThisTurn === 0      NOT empty
     ↳ emptyResponse               → isContextPressure's starvation rung

   loop  context handler          sanitizeDegenerateMessage       text + thinking
   loop  message_update           messageToRepetitionText         text + thinking

   subagents  runTurnLoop         collectResponseText (text_delta) ""
                                  || extractText(content)          ""
     ↳ responseText                → record.result → the verifier, the parent

   prinny  describeEmptyEnding    any block that is text or a
                                  toolCall                        not an answer
   ──────────────────────────────────────────────────────────────────────────
```

The turn as a whole made two tool calls, so `toolCallsThisTurn` is 2 and the
starvation rung would not fire here anyway. Strip A and B — the shape that
matters, and the one `j1` drives — and the turn is msg C alone: two tool calls
become zero, and `emptyResponse` is still false, because the thinking is
counted.

Two rows in that table are the same module disagreeing with itself:

```
      message_end   pushes    messageToText(m) || messageToRepetitionText(m)
                              ╰──────────────── the value that lands in the
                                                fingerprint / snippet / text
                                                windows

      agent_end     guards    normalizeText( messageToText(last) ).length > 80
                              ╰──────────────── the value four of the seven
                                                comparison rules are gated on
```

The window is filled from a string that can be the thinking; the guards measure
a string that never is. That is V2. And one row above it, `emptyResponse` asks
whether the model produced *any* characters and counts the thinking as
characters, which is V1.

---

## 3. The loop (`vendor/pi-loop-mode`), in full

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one
`loop` tool. Its whole job is deciding what a turn's outcome *was*.

### 3.1 The thirteen handlers, and what each one is for

```
  session_before_compact  replace pi's model-written summary with a locally
                          built handoff on a small window, or with an emergency
                          summary during recovery                    (§3.5)
  session_compact         adopt a compaction pi did itself, rather than asking
                          for a second one it can only refuse
  session_start           restore state from the branch, auto-resume an active
                          loop after a restart
  session_shutdown        drop the pending timer and the turn buffers
  agent_settled           deferred context recovery — pi runs its own overflow
                          recovery after agent_end and wins that race
  before_agent_start      append the loop's goal + rules to the system prompt
  before_provider_request anti-repetition sampling penalties, for
                          PENALTY_TURNS turns after a stuck intervention
  context                 sanitize degenerate assistant messages; append the
                          context-budget line (standing down if compaction-guard
                          already added one)
  message_start           reset the mid-stream degeneracy throttle
  message_update          mid-stream kill switch for runaway repetition
  tool_result             buffer the call into turnToolCalls; count it
  message_end             buffer the message's text into turnAssistantTexts
  agent_end               THE LADDER — §3.3
```

### 3.2 `LoopState`, and which transition resets which field

Forty-five fields. Four lifecycle transitions write them, and they do not agree.

```
                         applyGoalConfig   runLoop()    /loop resume   /loop end
                         (/loop start,     (/loop run)                 (clear)
                          /loop goal)
  ───────────────────── ───────────────── ──────────── ─────────────  ─────────
  description·criteria   set from args     kept         kept           default
  maxIterations·until     set from args    kept         --max only     default
  Done·delay·check
  Command·checkTimeout
  goalFile               args || GOAL.md   kept         kept           default
  loopModel·rescueModel  set from args     kept         args           default
  preparedAt             KEPT if the       kept         kept           default
                         description is
                         unchanged  ← V8
  ───────────────────── ───────────────── ──────────── ─────────────  ─────────
  iterationCount         0                 0            kept           0
  interventionCount      0                 0            kept           0
  consecutiveStuckCount  0                 0            0              0
  consecutiveErrorCount  0                 0            0              0
  totalErrorCount        0                 0            kept           0
  doneSignalCount        0                 0            kept           0
  blockedSignalCount     0                 0            kept           0
  the four repetition    []                []           kept           []
    windows
  turnsWithoutTools      0                 0            kept           0
  toolCallsThisTurn      0                 0            kept           0
  penaltyTurnsRemaining  0                 0            kept           0
  lastCompactIteration   0                 0            kept           0
  rescueActive           false             false        false          false
  checkErrorStreak       0                 0     ← U3   kept           0
  lastCheckError         ""                ""    ← U3   kept           ""
  ───────────────────── ───────────────── ──────────── ─────────────  ─────────
  lastCheckPassed        undefined         KEPT ← V3    kept           undefined
  checkFailStreak        0                 KEPT ← V3    kept           0
  lastCheckOutput        ""                KEPT ← V3    kept           ""
  lastCheckScore         undefined         KEPT ← V3    kept           undefined
  bestCheckScore         undefined         KEPT ← V3    kept           undefined
  bestScoreIteration     0                 KEPT ← V3    kept           0
  contextCooldownCount   0                 KEPT ← V3    kept           0
  contextCompressionLevel 0                KEPT ← V3    kept           0
  contextRecoveryCount   0                 KEPT ← V3    kept           0
```

Twenty-five assignments in `runLoop()`. Thirteen of the remaining twenty fields
are configuration and must survive — `description`, `completionCriteria`,
`maxIterations`, `untilDone`, `delaySeconds`, `checkCommand`,
`checkTimeoutSeconds`, `goalFile`, `loopModel`, `rescueModel`, `preparedAt`, and
the two that carry them. **The other seven are per-run state**, and they are the
last block of the table.

`/loop resume` keeping everything is correct — a resumed run *is* the same run.
`/loop start` resetting everything is correct — `applyGoalConfig` spreads
`defaultState()`. The middle column is the finding: `runLoop()` is what `/loop
run` calls, it means "start it again", it enumerates twenty-five fields, and the
six the goal check owns are not among them. U3 added two fields to that
enumeration (`checkErrorStreak`, `lastCheckError`) and left the older six — so
the reset list and the thing it resets now disagree *within the check's own
state*.

### 3.3 `agent_end` — the ladder, in full

Twenty-one `return;` statements and a fall-through. Every arrow that leaves the
column is a `return`.

```
 agent_end(event, ctx)
   │
   ├─ !state.active ─────────────────▶ (prepare-mode GOAL_READY watch) ─────▶ ✗
   │
   ├─ clearPendingTimer()
   ├─ toolCallsThisTurn := state.toolCallsThisTurn ; state.… := 0      ← T2
   ├─ turnTexts := turnAssistantTexts ; turnCalls := turnToolCalls
   ├─ resetTurnBuffers()                                              ← U2
   ├─ if penaltyTurnsRemaining > 0: penaltyTurnsRemaining--           ← S4
   │
   ├─ lastAssistantText           := messageToText(last)          ─┐
   ├─ lastAssistantRepetitionText := messageToRepetitionText(last) ─┴─ [V1][V2]
   │
   ├─ softStopRequested ──────────────────────────────────────────────────▶ ✗
   │
   ├─ emptyResponse := !text && !repetitionText && tools === 0     ← [V1]
   ├─ isContextPressure({stopReason, errorMessage, outputTokens,
   │                     contextPercent, emptyResponse}) ─────────────────▶ ✗
   │     · "length" with <= 32 output tokens
   │     · "length" at >= 85%
   │     · "error" matching /400|context|token|length|max output/ at >= 85%
   │     · "error" naming an overflow outright, at any percent
   │     · "stop" with an EMPTY response at >= 80%   ← the starvation rung
   │
   ├─ !lastAssistant || stopReason === "error" ───────────────────────────▶ ✗
   ├─ aborted && degenerateAbortPending ─▶ interveneStuck ────────────────▶ ✗
   ├─ aborted ────────────────────────────────────────────────────────────▶ ✗
   │
   │  ─── the success path ───
   ├─ consecutiveErrorCount := 0 ; contextCooldownCount := 0
   ├─ contextCompressionLevel := 0 ; contextRecoveryPending := undefined
   ├─ iterationCount++
   ├─ turnsWithoutTools := toolCallsThisTurn === 0 ? +1 : 0
   ├─ commitTurnMemory(turnTexts, turnCalls)      ← ONE entry per turn   [U2]
   │
   ├─ rescueActive ─▶ switch back to the loop model ──────────────────────▶ ✗
   │
   ├─ stuckReason := detectStuck(lastAssistantText, repetitionText)  ← [U1][V2]
   ├─ if !stuckReason: consecutiveStuckCount := 0                    ← [U1]
   │
   ├─ checkCommand → runGoalCheck() → applyCheckOutcome()
   │     ├─ execFailed × MAX_CHECK_ERRORS ─▶ pauseForCheckFailure ────────▶ ✗
   │     └─ untilDone && passed && !execFailed ───────────────────────────▶ ✗ completed
   │
   ├─ /\bLOOP_DONE\s*:/i
   │     ├─ untilDone && checkCommand && lastCheckPassed !== true    ← [U3][V3]
   │     │     ├─ stuckReason ─▶ interveneStuck ──────────────────────────▶ ✗
   │     │     └─ else check_failed directive ────────────────────────────▶ ✗
   │     ├─ untilDone ────────────────────────────────────────────────────▶ ✗ completed
   │     └─ endless: stuckReason ? interveneStuck : improve ───────────────▶ ✗
   ├─ /\bLOOP_BLOCKED\s*:/i  stuckReason ? interveneStuck : unblock ──────▶ ✗
   ├─ maxIterations reached ──────────────────────────────────────────────▶ ✗
   ├─ scoreRegressed ─▶ regression directive ─────────────────────────────▶ ✗ [V3]
   ├─ stuckReason ─▶ interveneStuck ──────────────────────────────────────▶ ✗
   ├─ iterationCount - lastStateChangeIteration >= 8 ─▶ audit nudge ──────▶ ✗
   │
   └─ normal continue: schedule the next turn
```

### 3.4 `detectStuck`, and the escalation ladder that hangs off it

Seven rules, in order. The first that matches wins and its text becomes the
notice the operator sees and the directive the model gets.

```
  1  detectDegenerateRepetition(repetitionText, 4)     sentence / word / phrase
  2  turnsWithoutTools >= 3                            "narration only"
  3  last two fingerprints equal   AND text.length>80  "repeated the same response"
  4  last three fingerprints equal AND text.length>0   "… three times"
  5  textSimilarity(text, previous) >= 0.8
        AND text.length > 60                           "~N% similar to previous"
  6  same fingerprint >= 3 in the 8-turn window        "repeated 3+ times"
  7  last three TURN tool signatures identical         "the same <tool> calls
                                                        returned the same thing"
  8  same question repeated (text ends in "?")
```

Rules 3, 4, 5 and 8 are gated on `lastAssistantText`. Rules 1 and 6 are not.
That split is V2, and the drawing in §2 is the whole of the argument.

The escalation ladder, and its three rungs' guards:

```
  interveneStuck(reason)
    consecutiveStuckCount++ ; interventionCount++ ; turnsWithoutTools := 0
    penaltyTurnsRemaining := PENALTY_TURNS (3)
      → before_provider_request rewrites the payload for 3 turns:
        frequency_penalty 0.5, presence_penalty 0.5, temperature +0.2
        (openai-completions only — which llama.cpp is)
      │
      │  saturated := contextUsage.percent >= CONTEXT_STARVATION_PERCENT (80)
      │
      ├─ rescue      !saturated && rescueModel && !rescueActive && streak >= 3
      │              switchModel → scheduleLoopTurn("rescue", 0, ctx)
      │              ── UNCONDITIONAL
      │
      ├─ compact     saturated  ||  (streak >= 5 && iterations since last
      │              compaction >= 5)
      │              ctx.compact({onComplete: scheduleLoopTurn("stuck", 0)})
      │              ── UNCONDITIONAL
      │
      └─ strategy    otherwise
                     delay := min(60, 2 ** min(streak, 6)) seconds
                     rotating STUCK_STRATEGIES[interventionCount % 5]
                     streak >= 3 also adds the HARD RESET block with
                       banned openings taken from lastAssistantSnippets
                     if (!ctx.hasPendingMessages())                    ← [V4]
                         scheduleLoopTurn("stuck", delay, ctx)
```

The bottom rung is the only one that is guarded, and it is the only one that
runs at streaks 1 and 2 — so with pending messages the ladder climbs to a model
switch and a compaction having never once delivered the cheap intervention it
charged for three times. That is V4.

### 3.5 The context ladder

Three separate mechanisms; keeping them apart matters.

```
  1. TELL THE MODEL        context handler, every provider call
       >= 60%  advisory line, appended last (cached prefix untouched)
       >= 80%  CRITICAL wording
       pi-loop-mode and compaction-guard both inject one; whichever runs
       second sees the other's `-context-budget` customType and stands down.

  2. DETECT PRESSURE       agent_end → isContextPressure()      ← [V1]

  3. RECOVER               deferred to agent_settled, because pi runs its own
                           overflow recovery after agent_end and wins the race
       attempt 1,2   → emergency compaction, tighter summary each time
       attempt 3     → cooldown 60s → 120s → 240s, tighter still
       cooldown 4    → pauseForContextFailure — the only place the loop
                       gives up
```

The measurement that justifies the starvation rung, and therefore V1's severity:
**below 87% of the window, 3 empty assistant turns out of 196; at or above 87%,
33 out of 63.** It is a cliff, not a gradient, and an empty turn still costs a
full iteration.

### 3.6 The handoff summary

On a window of 65,536 tokens or less, *every* compaction the loop owns becomes a
locally built handoff rather than pi's model-written summary. Allocation order
(S5's fix) is the load-bearing part:

```
   READ order   goal · criteria · state · durable · files
   CLAIM order  goal · state · criteria · files · durable
                                                 └─ takes whatever is left
   each section holds back MIN_SECTION_CHARS (150) × the sections after it
```

`durable` claims last because it is the only section also sitting on disk.

---

## 4. Subagents (`vendor/pi-subagents-lite`), in full

61 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
`/agents` menu, a slot table, a watchdog, and a spawn coordinator that owns
delivery.

### 4.1 A record's life

```
  spawn()                status queued | running        started: false
    │                    gate created (createCompletionGate)
    │                    parent signal bound (foreground only)
    │                    brief := prompt                        ← forge fork
    │                    stats.turnCount := 1
    ▼
  startAgent()           slot reserved · watchdog started · started := true
    │                    outputLog opened if configured
    ▼
  runAgent()             session created → record.execution.session
    │                    pendingSteers flushed
    ▼
  .then                  status ← aborted | error | turn_limited | completed
    │                    result := responseText
    │                    runVerification()                      ← forge fork
    │                    completedAt stamped AFTER the check
    ▼
  .finally               settlementCount++ · outputLog finalised
                         slot released · tallyCompletion · drainQueue
                         parent binding detached · gate opened · settled := true
```

The **completion gate** is the invariant worth knowing: every record carries a
promise from birth, opened exactly once, never assigned the run's own promise.
Six paths open it — settlement, a queued stop, a start failure, an
already-aborted spawn, dispose, and record removal — so a foreground `Agent`
call can never hang on a record that will not settle.

A settled record with a live session can be **continued** (`steer` on a terminal
record). That path re-reserves the slot, appends to `brief` (`appendFollowUp`,
capped at 6,000 chars, oldest follow-ups dropped first), clears `verification` —
a verdict describes one answer — restarts the watchdog, and re-attaches the same
settlement chain.

### 4.2 `RunResult`, and who reads which field

```
   runSessionPrompt() returns, for EVERY run — first, steer, judge, repair:

     ┌────────────────────────────────────────────────────────────┐
     │  responseText   collector.getText().trim()                 │
     │                 || getLastAssistantText(session, from)      │
     │  session        the AgentSession                            │
     │  aborted        wireTurnTracking: hard abort fired          │
     │  turnLimited    wireTurnTracking: softLimitReached    ← V6  │
     │  modelError     getFinalModelError(session)                 │
     └────────────────────────────────────────────────────────────┘

   caller                          reads                       drops
   ────────────────────────────── ─────────────────────────── ──────────────
   startAgent                     all five                     —
     → attachSettlementChain      status = aborted ? … :
                                    modelError ? … :
                                    turnLimited ? … : completed

   continueSettledAgent (steer)   all five                     —
     → attachSettlementChain      same

   buildVerifyDeps.judge          responseText                 aborted,
     → parseJudgeVerdict          (+ session, for dispose)     turnLimited,
                                                               modelError

   buildVerifyDeps.repair         responseText            ← V5  session,
     → the next judge round                                     aborted,
                                                                turnLimited,
                                                                modelError
   ────────────────────────────── ─────────────────────────── ──────────────
```

For the judge, dropping three fields is defensible: the reply is either readable
or it is not, and `parseJudgeVerdict`'s fail-open policy covers the rest. For the
repair it is not, because the repair's text becomes the **candidate the next
judge sees and, if it passes, the answer the parent is handed**. That is V5.

### 4.3 The turn ceiling

```
  normalizeMaxTurns(n)   0 → unbounded · absent → 40 · else max(1, n)

  turn_end #maxTurns          softLimitReached := true          ← V6
      graceTurns <= 0    ──▶  abort NOW, aborted := true        ← S10-era fix
      maxTurns > 1       ──▶  steer "wrap up immediately"
      maxTurns === 1     ──▶  send nothing                      ← T1's fix
  turn_end #maxTurns+grace ─▶ abort, aborted := true
```

`shouldSteerAtSoftLimit(maxTurns)` is `maxTurns > 1`, and the reasoning (T1) is
that a one-turn budget has no wrap-up to ask for — asking manufactures a second
provider call and `collectResponseText` resets on the injected message, so the
text handed back is the reply to "wrap up". The flag on the line above was not
given the same treatment, and that is V6.

`max_turns` reaches a spawn from three places, in this precedence:

```
  params.max_turns             (declared nowhere in the Agent tool's schema
                                and injected by nothing — dead, see §8)
  ?? getAgentConfig(type).maxTurns          an agent .md's `max_turns:`
  ?? getStore().agent.defaultMaxTurns       the model-family config, editable
                                            in /agents
```

plus the `/agents` spawn wizard's own "Max turns" field, which writes
`SpawnConfig.maxTurns` directly and accepts any number.

### 4.4 Concurrency

`SlotTable` holds per-model and per-provider pools. Precedence is per-model ▸
per-provider ▸ default, and the default case **creates and caches** a per-model
slot, which is why `setLimits()` must delete slots the new config no longer
names — and why it must then `recount()` from the holders themselves.

> A `running` count is a fact about the world; a `limit` is configuration.

`recount()` keys on `execution.holdsSlot` rather than on `status === "running"`,
because the slot is held right through the verification window, where the status
has already gone terminal.

The default is **1**, in exactly one place (`config-io.ts`). The measurement
behind it: a child having its own system prompt does *not* by itself evict the
parent's cached prefix (99.2% hit across six small child turns); what evicts it
is *size* — a child that grew to 18k tokens took the parent's next call from
2,117 cached tokens to zero, and from 442 ms to 2,949 ms.

### 4.5 What a child inherits, and by which route

```
   the PARENT is started with  -e vendor/rtk-pi  -e vendor/pi-loop-mode
                               -e vendor/pi-subagents-lite  -e vendor/prinny-channel
                                 │  a child does NOT inherit -e flags
                                 ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the child's DefaultResourceLoader                                       │
   │                                                                          │
   │   route A — DISCOVERY               route B — additionalExtensionPaths   │
   │   ─────────────────────             ─────────────────────────────────    │
   │   ~/.pi/agent/extensions/**         subagentExtraExtensionPaths():       │
   │   <cwd>/.pi/extensions/**             vendor/rtk-pi/extensions/index.ts  │
   │     compaction-guard  ✓ wanted        (or $SUBAGENT_EXTRA_EXTENSIONS)    │
   │     browser-guard     – harmless                                         │
   │     stack           ✗ guards itself  suppressed entirely when the agent  │
   │                        (U7)          declares extensions: false          │
   │                                                                          │
   │   ── withExtensionDenial() runs LAST over both ────────────────────      │
   │      any path segment matching (?:[a-z0-9._@-]*-)?prinny-channel/ cut    │
   └──────────────────────────────────────────────────────────────────────────┘

   `vendor/pi-loop-mode` reaches a child by neither route, deliberately:
     · not discovered (it lives in vendor/)
     · removed from route B, because its state is module-global
     · and its factory returns early when __PI_SUBAGENT_SPAWN_DEPTH__ > 0
```

Three independent stops, because the failure it caused was silent — the loop's
own `agent_end` ran on the operator's state with the child's ctx, cancelled the
operator's scheduled iteration, and delivered the operator's next loop turn into
the child.

### 4.6 Which declaration governs a spawn

`getConfig(type)` routes any `hidden` agent through **general-purpose**
(`findActiveConfig`), which is why S3/S9 had to move three resolutions to the
agent's own frontmatter. The current split, verified this pass:

```
  read from getAgentConfig(type)        — the agent's OWN frontmatter
    tools                  → resolveSessionAllowedTools, resolveVisibleTools
    registeredTools        → getToolNamesForType (via declaredRegisteredTools)
    excludeTools/Extensions, model, thinkingLevel, maxTokens, maxTurns,
    preloadSkills, name

  read from declaredResources(agentConfig, getConfig(type))
    extensions, skills     — own declaration wins, resolved fills undefined

  read from declaredPromptSources(agentConfig, store.agent)
    includeContextFiles, systemPromptMode, includeEnvironment

  read from getConfig(type) alone
    (nothing that affects behaviour — only as declaredResources' fallback)
```

That is now consistent. `__verifier`'s five switches all arrive as declared, and
its whole system prompt is 463 chars.

---

## 5. The verifier, in full

### 5.1 Three layers, cheapest first

```
   record settles ─▶ record.result = responseText
                        │
                        ▼
   ┌──── structuralVerdict(answer, lifecycle) ─────────────────────────────┐
   │  answer trims to ""      ─▶ ok:false            skipped-empty          │
   │                              (the note REPLACES the answer)            │
   │  status "error"          ─▶ worthJudging:false  skipped-error          │
   │  status aborted /                                                      │
   │    turn_limited / stopped ─▶ worthJudging:false skipped-cutoff  ← V6   │
   │  brief missing            ─▶                    skipped-nobrief        │
   └────────────────────────────┬──────────────────────────────────────────┘
                                │ non-empty, clean run, brief present
                                ▼
   ┌──── the round loop, budget = SUBAGENT_VERIFY_ROUNDS (default 1) ──────┐
   │                                                                       │
   │   phase "judging"                                                     │
   │   judge(buildJudgePrompt(brief, candidate))   ← fresh __verifier      │
   │        │                                        session, 300 s        │
   │        ▼                                                              │
   │   parseJudgeVerdict(reply)                                            │
   │        ├─ unparsed ─────────────▶ candidate + note      unparsed      │
   │        ├─ addressed, 0 attempts ▶ candidate (bare)      passed        │
   │        ├─ addressed, n attempts ▶ candidate + note      repaired      │
   │        └─ not addressed                                               │
   │              ├─ attempts >= rounds ▶ ORIGINAL + note    failed        │
   │              └─ phase "repairing"                                     │
   │                 repair(buildRepairPrompt(brief, why))                 │
   │                      │            ← the CHILD's own session,          │
   │                      │              maxTurns 1, grace 6, 300 s        │
   │                      │              THE GATE ABOVE NEVER SEES  ← V5   │
   │                      │              WHAT THIS RUN DID                 │
   │                      ├─ "" ──────────▶ ORIGINAL + note  failed        │
   │                      ├─ == candidate ▶ ORIGINAL + note  failed(stalled)│
   │                      └─ candidate := repaired ─▶ round again          │
   └───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
              record.verification := status   → badge, /agents, tool details
              record.result       := answer   → every reader sees one text
```

### 5.2 The two asymmetries, and both are the design

- **The judge knows less on purpose.** A model shown its own reasoning ratifies
  it, so the judge is shown two quoted blocks and a question. Tools, extensions,
  skills, project context files, the parent's system prompt and the environment
  block are all declared off.
- **The repair knows more on purpose.** It continues the child's own session,
  because that is the only place with the context to fix the answer.

`why` is the one value that crosses from the first into the second, and U4
repaired how it is read: line-anchored, taken relative to the line that decided
the verdict, never the prompt's own `WHY_INSTRUCTION`.

### 5.3 The judge's session, and the one teardown it has

```
   the judge calls runAgent DIRECTLY, not this.spawn():

     spawn()  would  create a record → dispose()/clear() can reach the session
     runAgent does not → the `finally` in buildVerifyDeps.judge IS the teardown

   try {
     result = await runAgent(ctx, "__verifier", prompt, {…});   ← creates the
     deadline.assertNotExpired();                                 session inside
     return result.responseText;
   } finally {
     deadline.cancel();
     try { result?.session?.dispose(); } catch {}    ← reads `result`
   }                                                            ← V7
```

`result` is only assigned when the await **resolves**. A rejection after
`createAgentSession()` has returned — `bindExtensions` throwing,
`session.prompt()` rejecting on a provider fault — drops the only reference to a
live session. That is V7. A *timeout* does not leak: the deadline aborts the
signal, `prompt()` resolves, `result` is assigned, and `assertNotExpired()`
throws afterwards.

### 5.4 The deadline, and why it exists

Verification runs inside the settlement chain, **after** the status has gone
terminal, and every stop path keys off `status === "running"`. So during a judge
or a repair the record is unstoppable: the operator's Esc reaches `stopAgent()`,
which returns false; `StopAgent` the same; and the watchdog's `check()` does not
merely skip the record, it deletes its state. Meanwhile the parent's `Agent` call
is blocked on the completion gate. Nothing else can end that wait, so a 300 s
per-call deadline does. (That is T5, still open by decision.)

---

## 6. A delegation, on a timeline

The interesting part is **who holds the slot and for how long**, because the
slot is what the parent's next turn is waiting behind.

```
  parent turn N                                                  parent turn N+1
  ────────────┐                                                  ┌──────────────
              │  Agent(prompt, agent: "Explore")                 │
              ▼                                                  ▲
      ┌──────────────────────────────────────────────────┐       │
      │ resolveWorktree · type resolution · model        │       │
      │ coordinator.spawn → manager.spawn                │       │
      └───────┬──────────────────────────────────────────┘       │
              │ slot free? ── no ─▶ queued; the gate stays shut  │
              │ yes                                              │
   ┌──────────▼─────────────────────────────────────────┐        │
   │ SLOT HELD ════════════════════════════════════════ │        │
   │                                                    │        │
   │  build   detectEnv (2× git, ~100 ms)               │        │
   │          buildAgentPrompt                          │        │
   │          reloadAndMap  (every extension factory)   │        │
   │          bindExtensions (child session_start)      │        │
   │                                                    │        │
   │  run     turn 1 … turn k    ← llama, one at a time │        │
   │            each compaction fires the anchor steer  │        │
   │            turn 40 → "wrap up immediately"         │        │
   │            turn 46 → hard abort                    │        │
   │                                                    │        │
   │  settle  status ← completed | turn_limited         │        │
   │                   | aborted | error | stopped      │        │
   │                                                    │        │
   │  verify  judge   ← a WHOLE extra session + 1 turn  │        │
   │          repair  ← 1+ turns in the CHILD's session │        │
   │          judge   ← again                           │        │
   │            ── unstoppable: status is terminal, so  │        │
   │               Esc, StopAgent and the watchdog all  │        │
   │               decline. Only the 300 s deadline     │        │
   │               ends it.                             │        │
   │                                                    │        │
   │ ══════════════════════════ SLOT RELEASED ═════════ │        │
   └──────────┬─────────────────────────────────────────┘        │
              │ tally · drainQueue · openGate ─────────────────▶ │
```

The parent's wait is `child + judge + repair + judge`, all serialised on one
llama slot. Every design decision that looks over-careful about cost is
over-careful about that queue.

---

## 7. Findings

Severity is about what it costs a real run. Evidence is **PROVEN** (an
executable probe drives the shipped module), **MEASURED** (a number taken from
the tree), or **SOURCE** (read, with the reasoning in the finding).

| # | Finding | Sev | Evidence | Probe | Fixed |
| --- | --- | --- | --- | --- | --- |
| V1 | a reasoning-only turn stopped being "empty", and the loop's starvation rung reads "empty" | **HIGH** | PROVEN | `j1` | ✔ |
| V2 | four of `detectStuck`'s seven rules are gated on text; the windows are filled from text-or-thinking | **HIGH** | PROVEN | `j2` | ✔ |
| V3 | `/loop run` starts a new run holding the previous run's goal-check verdict, streak and best score | **MEDIUM** | PROVEN | `j3` | ✔ |
| V4 | a stuck intervention charges the whole ladder and delivers nothing when messages are pending | **MEDIUM** | PROVEN | `j4` | ✔ |
| V5 | the verifier's repair reads one of its RunResult's five fields, so the structural gate never sees it | **MEDIUM** | PROVEN | `j5` | ✔ |
| V6 | a one-turn budget reports `turn_limited`, which means "cut off" to the note and to the verifier | **MEDIUM** | PROVEN | `j6` | ✔ |
| V7 | the judge's session is disposed on the path where its run returns, and on no other | **LOW** | SOURCE | `j7` | ✔ |
| V8 | a re-issued goal keeps `preparedAt` and resets `goalFile` | **LOW** | PROVEN | `j8` | ✔ |

---

### V1 — a reasoning-only turn stopped being "empty", and the loop's starvation rung reads "empty" · **HIGH** · PROVEN · **FIXED**

**Where.** `emptyResponse` at `vendor/pi-loop-mode/extensions/index.ts:1895`,
against `isContextPressure` in `src/context-recovery.ts` and
`messageToRepetitionText` in `src/repetition.ts`.

**What.** On 2026-08-17, commit `e81a7e5` shipped
`patches/forge_reasoning_passthrough.py`. Its own summary:

> `llama-server :8080  ->  finish_reason "length", reasoning_content 490 chars, content 0`
> `forge        :8081  ->  finish_reason "stop", no reasoning_content key at all, content 0`
> llama.cpp parsed the `<think>` block correctly, reported the truncation
> honestly, and put the reasoning on the wire. **forge threw it away.**

The patch restored it. The commit message states the consequence in one line:

> with the reasoning restored, **a thinking-only turn reaches pi as
> `content:[thinking]` rather than `content:[]`**, so `describeEmptyEnding` would
> have stopped noticing it.

`vendor/prinny-channel` was changed in that same commit to keep noticing.
`vendor/pi-loop-mode` was not, and it consumes the same shape:

```js
const emptyResponse =
  Boolean(lastAssistant) &&
  !lastAssistantText.trim() &&            // messageToText — text blocks only
  !lastAssistantRepetitionText.trim() &&  // messageToRepetitionText — text OR THINKING
  toolCallsThisTurn === 0;
```

`messageToRepetitionText` exists so the *degenerate-repetition* scan can see a
model looping inside its own reasoning. Borrowing it for "did the model produce
anything" is what makes a thinking-only turn non-empty — and `emptyResponse` is
the sole input to `isContextPressure`'s starvation rung:

```
  stopReason "stop" with an EMPTY response at >= CONTEXT_STARVATION_PERCENT (80)
```

**Proved.** `j1`, driving the real module. The same provider turn — 126 output
tokens, all reasoning — at 90% of a 32k window, in the two shapes it has had:

```
  BEFORE the forge patch — pi gets content: []
    Loop: context pressure detected (1/3) — recovering.
    Status: retrying          Iterations: 0/∞      Errors: 1 total, 1 consecutive
    Last notice: Context pressure 1/3: empty response at 90% context
                 (no text, no thinking, no tool call).

  AFTER the forge patch — pi gets content: [thinking]
    (no notice at all)
    Status: running           Iterations: 1/∞      Errors: 0 total, 0 consecutive
    Last notice: -
```

**What it costs.** The rung exists because of a measured cliff: **below 87% of
the window, 3 empty assistant turns out of 196; at or above 87%, 33 out of 63.**
A starved turn is now counted as a *successful iteration*, the recovery ladder
(`consecutiveErrorCount`, `contextCooldownCount`, `contextCompressionLevel`) is
*reset* by the success path rather than advanced, and the loop schedules another
turn into the same saturated window. On a 32k run that is the failure mode the
whole context ladder was built for, restored by a patch written to fix a
different symptom.

It is worse than "the rung stopped firing", because the success path actively
undoes the ladder's memory: `state.consecutiveErrorCount = 0;
state.contextCooldownCount = 0; state.contextCompressionLevel = 0;`. A run that
alternates a starved reasoning-only turn with a real one can never accumulate
the three consecutive failures `CONTEXT_RECOVERY_ATTEMPTS` needs.

**Why no test caught it.** `pi-loop-mode/tests/` constructs no assistant message
with a `thinking` content block — the word appears twice in that directory, both
times as prose. Every assistant message the suite and the probe host build is
`[{type:"text"}]` or `[]`, which are exactly the two shapes that behave
correctly. The forge patch lives in a different directory, has no test of its
own in this repo, and its consumer-facing consequence was written down in the
commit message and in one consumer's source comment — neither of which any test
reads.

**The fix.** The two questions the one string was answering are split.
`emptyResponse` asks "did the model produce an ANSWER", which is text or a tool
call; the degenerate scan asks "is there any generated text to scan", which is
text or thinking.

```js
// what the model said, for the purposes of "was this turn empty"
const lastAssistantText = messageToText(lastAssistant);
// everything it generated, for the repetition scans
const lastAssistantRepetitionText = messageToRepetitionText(lastAssistant);

const emptyResponse =
  Boolean(lastAssistant) && !lastAssistantText.trim() && toolCallsThisTurn === 0;
```

The thinking-only case gets a distinct reason string, because a turn that spent
126 tokens on reasoning and answered nothing is not the same operator-facing
event as a turn that produced nothing at all:

```
  "reasoning-only response at 90% context (490 chars of thinking, no answer,
   no tool call)"
```

One thing changed for the better outside the rung: a thinking-only turn also
stops incrementing `iterationCount` and stops resetting the recovery counters,
because it no longer reaches the success path.

*Tests:* `vendor/pi-loop-mode/tests/reasoning-turns.test.ts`, first describe.
Four cases, one of which fails without the fix; `content: []` at 90%, an answered
turn at 90%, and a reasoning turn that made a tool call are the three controls —
the last of these is the one that says a tool call counts as an answer.

---

### V2 — four of `detectStuck`'s seven rules are gated on text; the windows are filled from text-or-thinking · **HIGH** · PROVEN · **FIXED**

**Where.** `message_end` at `index.ts:1787`, `commitTurnMemory` at `:238`,
`detectStuck` at `:720`.

**What.** The same divergence as V1, one branch further down. The value that
goes *into* the repetition memory and the value the comparison rules are *gated
on* are two different strings:

```js
  // message_end — what is remembered
  const tracked = messageToText(trackedMessage) || messageToRepetitionText(trackedMessage);
  if (!tracked.trim()) return;
  turnAssistantTexts.push(tracked);

  // agent_end — what the rules measure
  const stuckReason = detectStuck(lastAssistantText, lastAssistantRepetitionText);
                               //  ^ messageToText only
```

Inside `detectStuck`:

| rule | gate | sees a thinking-only turn? |
| --- | --- | --- |
| degenerate repetition | `repetitionText` | yes |
| narration only (`turnsWithoutTools >= 3`) | counter | yes |
| identical response ×2 | `normalizeText(lastAssistantText).length > 80` | **no** |
| identical response ×3 | `normalizeText(lastAssistantText).length > 0` | **no** |
| near-duplicate (`>= 0.8` similar) | `normalizeText(lastAssistantText).length > 60` | **no** |
| same fingerprint 3+ in the window | window only | yes |
| same tool signature 3 turns running | tool window only | n/a |
| same question repeated | `/\?\s*$/.test(lastAssistantText.trim())` | **no** |

So the fingerprint, snippet and text windows are filled with the model's
thinking, and then compared under guards that measure the empty string.

**Proved.** `j2`, driving the real module. Four turns of the same paragraph,
rephrased each time — consecutive answers at `textSimilarity` **0.80**, exactly
`SIMILARITY_THRESHOLD` — each with a distinct tool result so the tool rule cannot
be what fires:

```
   delivered as TEXT                              delivered as THINKING
   ───────────────────────────────────────────    ─────────────────────
   turn 1  (no notice)                            turn 1  (no notice)
   turn 2  Loop stuck (1x): assistant response    turn 2  (no notice)
           ~80% similar to previous               turn 3  (no notice)
   turn 3  Loop stuck (2x): ~82% similar          turn 4  (no notice)
   turn 4  Loop stuck (3x): ~82% similar
                                                  Interventions: 0
   Interventions: 3  (stuck streak: 3)            (stuck streak: 0)
```

With byte-identical repeats rather than rephrasings, the thinking column is not
silent but is late and mislabelled: the `3+ in the recent window` rule (which
reads only the window) fires on turn 3 instead of `repeated the same response`
firing on turn 2, and the notice names the wrong rule.

**What it costs.** A model that has settled into restating its reasoning and
producing no answer is the precise failure `detectStuck` exists for, and it is
also — per V1 — the shape this stack deliberately started delivering two days
ago. Nothing intervenes: no sampling penalties, no rotating strategy, no rescue
model, no compaction. The loop runs at full speed, one provider call per turn,
with `/loop status` reporting `Interventions: 0`.

**The fix.** The comparison subject is now what was *committed*, not what the
event's last message happens to say. `commitTurnMemory` returns the text it put
in the windows, and `agent_end` passes that string to `detectStuck`:

```js
const committedText = commitTurnMemory(turnTexts, turnCalls);
…
const stuckReason = detectStuck(committedText ?? "", lastAssistantRepetitionText);
```

**The other direction was considered and rejected.** Filling the window with
`messageToText` only — so a thinking-only message contributes nothing — also
makes the two units agree, and it is the smaller edit. It *loses* detection:
today's broken code does catch byte-identical thinking, late and under the wrong
rule's name, via the one ungated rule, and that would have gone too. A model
repeating its reasoning verbatim is stuck, and the loop should say so.

Passing the committed string gets both directions instead:

- a turn that **committed nothing** compares nothing — every gated rule is
  skipped by its own length test, rather than run against a window entry from an
  earlier turn;
- a turn whose **only output was reasoning** is compared on the reasoning, which
  is what is in the window and what the model is repeating.

The false-positive risk this carries is real and narrow: reasoning about the same
task can legitimately resemble itself. It only applies to a turn with no answer
at all, below the 80% starvation threshold (above it, V1's fix routes the turn to
recovery before `detectStuck` runs), and the cost of a wrong verdict there is one
injected strategy and three turns of sampling penalties.

*Tests:* `reasoning-turns.test.ts`, second describe. Four cases, two of which
fail without the fix; the `text` column is the control in both, and "does not
compare a turn that committed nothing" pins the other direction.

---

### V3 — `/loop run` starts a new run holding the previous run's goal-check state · **MEDIUM** · PROVEN · **FIXED**

**Where.** `runLoop()` at `index.ts:986`, against `defaultState()` in
`src/loop-state.ts` and `applyCheckOutcome` in `src/goal-check.ts`.

**What.** `runLoop()` enumerates twenty-five fields to reset. Seven pieces of
per-run state are not among them — six the goal check owns, and one the context
ladder does:

```
  lastCheckPassed   checkFailStreak   lastCheckOutput
  lastCheckScore    bestCheckScore    bestScoreIteration
  contextCooldownCount   contextCompressionLevel   contextRecoveryCount
```

`/loop start` is unaffected — it goes through `applyGoalConfig`, which spreads
`defaultState()`. `/loop resume` is deliberately unaffected — a resumed run *is*
the same run. `/loop run` is the path that means "start it again", and it is the
one that carries the old verdict across.

The reset list has been extended since it was written: U3 added `checkErrorStreak`
and `lastCheckError` to it. So the check's *new* counters are reset and its
*older* six are not, which means the check's own state is now internally
inconsistent across a restart.

**Proved.** `j3`, two modes.

*A regression that never happened.* Run 1 scores 90 and is stopped; `/loop run`
starts run 2, whose first check scores 70:

```
  run 1, iteration 1   Check status: failing (streak 1), score 90 (best 90 @ iter 1)

  --- /loop stop, then /loop run ---

  run 2, iteration 1   Loop: goal check score regressed to 70 — requesting fix.
                       Check status: failing (streak 2), score 70 (best 90 @ iter 1)
                       Last notice: Score regression: 70 (best 90).
```

Nothing regressed. The score is lower than a *different run's* last score. The
streak counts one failure from each run. The directive the model is sent names an
iteration number from the previous run:

> Goal check regression: the score dropped to 70 (best so far 90 at iteration 1).
> A recent change made things worse. Inspect recent changes (git diff / git log),
> find and fix the regression **before doing anything else**.

That is iteration 1 of a fresh run spent hunting a regression that does not exist.

*A completion the check never authorised.* Run 1 passes its check and completes,
leaving `lastCheckPassed = true`. The check script is then broken. `/loop run`:

```
  run 2, iteration 1
    Loop: goal check could not run (1/3): Error: Command timed out after 120000ms
    Loop completed: ship the feature
    Active: false   Status: completed
    Check status: passing — LAST KNOWN; the check has not run for 1/3 turns
```

U3 made the guard `state.lastCheckPassed !== true` rather than `=== false`
precisely so that *"the check decides" cannot mean "the model decides when the
check is broken"*. It holds inside a run. Across `/loop run` it is satisfied by a
verdict from a run that has already ended — and the status line says so in the
same breath.

**Why it survived.** `runLoop()` is a wall of assignments and reads as
exhaustive. The six missing fields are not visibly grouped: they sit among
sixty-one others in `LoopState`, and the two the fifth pass added sit two lines
apart from where the six should have gone.

**The fix.** The check's whole state is reset in `runLoop()`, through one named
helper in `src/goal-check.ts` so the next field added to the check cannot be
missed:

```js
// src/goal-check.ts
export function resetCheckState(state: LoopState): void {
  state.lastCheckPassed = undefined;
  state.lastCheckScore = undefined;
  state.bestCheckScore = undefined;
  state.bestScoreIteration = 0;
  state.checkFailStreak = 0;
  state.lastCheckOutput = "";
  state.checkErrorStreak = 0;
  state.lastCheckError = "";
}
```

`CHECK_STATE_KEYS` is exported alongside it, and the test compares each key
against `defaultState()` rather than restating the list a third time — so a field
added to the check and forgotten here fails.
`contextCooldownCount`, `contextCompressionLevel` and `contextRecoveryCount` are
reset next to it for the same reason, and the first is not cosmetic:
`enterContextCooldown` increments it and pauses the loop when it exceeds
`MAX_CONTEXT_COOLDOWNS` (3). A run that was paused *by* context exhaustion
leaves it at 3, and `/loop run` does not clear the session's context either — so
run 2's first three consecutive pressure turns reach `enterContextCooldown`,
which takes it to 4 and pauses immediately. The new run gets one recovery
attempt where a fresh one gets three cooldowns and up to nine. Any successful
turn resets it, which is why this is the narrower half of V3 rather than its
own finding.

*Tests:* `vendor/pi-loop-mode/tests/run-restart.test.ts`, the first two describes.
Five cases, two of which fail without the fix. `resetCheckState` is asserted
against `defaultState()`; a check that passes in the new run still completing it,
and `/loop resume` still keeping everything, are the two controls — the second is
the one that says the fix did not simply reset more.

---

### V4 — a stuck intervention charges the whole ladder and delivers nothing when messages are pending · **MEDIUM** · PROVEN · **FIXED**

**Where.** `interveneStuck()` at `index.ts:903`, last line.

**What.** `interveneStuck` does seven things unconditionally — increments
`consecutiveStuckCount` and `interventionCount`, sets `status`, sets
`lastNotice`, zeroes `turnsWithoutTools`, arms `penaltyTurnsRemaining = 3`, and
notifies the operator — and then delivers its directive under a guard:

```js
  if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "stuck", delayMs, ctx);
```

The two rungs above it carry no such guard:

```js
  scheduleLoopTurn(pi, "rescue", 0, ctx);                 // streak >= 3
  ctx.compact({ onComplete: () => scheduleLoopTurn(pi, "stuck", 0) });  // streak >= 5
```

So the bottom rung — the rotating `STUCK_STRATEGIES` entry, which *is* the whole
intervention at streaks 1 and 2 — is the only one that can be skipped, and it is
the one that is skipped.

**Proved.** `j4`, driving the real module with `hasPendingMessages()` forced to
each value:

```
   hasPendingMessages() === false                 hasPendingMessages() === true
   ─────────────────────────────────────────      ─────────────────────────────
   turn 1  (no notice)      → "continue" sent     turn 1  (no notice)   → NOTHING
   turn 2  Loop stuck (1x)  → timer "stuck" 2s    turn 2  Loop stuck (1x) → NOTHING
   turn 3  Loop stuck (2x)  → timer "stuck" 4s    turn 3  Loop stuck (2x) → NOTHING
   turn 4  Loop stuck (3x)  → timer "stuck" 8s    turn 4  Loop stuck (3x) → NOTHING

   Interventions: 3 (streak: 3)                   Interventions: 3 (streak: 3)
```

The operator sees the same three notices and the same counters in both columns.
Only the left one ever sends the strategy the notice says it is injecting.

**When `hasPendingMessages()` is true.** It is the ordinary state during a
delegation: a background subagent's result is delivered with
`pi.sendMessage(…, { deliverAs: "steer" | "followUp", triggerTurn: true })` from
`SpawnCoordinator.emitIndividualNudge`, and a queued follow-up is a pending
message. The operator typing while a loop runs does the same. So "a loop is
running and a background subagent reported back" — the exact combination §11 of
the fifth pass lists as never having been watched — is the combination in which
the loop's cheapest fixation rung goes silent.

**What it costs.** Three interventions' worth of escalation with nothing
delivered, and then a rescue-model switch at streak 3 (a whole model swap on the
one llama slot) or a compaction at streak 5 (a whole context rebuild) — both
sent, both unconditional — as the *first* thing the model is actually told.
Meanwhile `penaltyTurnsRemaining = 3` is armed each time, so the sampling
penalties are on permanently while the pattern lasts, and `turnsWithoutTools` is
zeroed each time, which suppresses the narration-only rule as well.

**Why it is written that way.** The guard is copied from the other exits of
`agent_end` — `if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "continue", …)`
— where it is right: a pending message will trigger a turn anyway, so scheduling
a second one would double-run the iteration. For those exits the loop only needs
*a* turn to happen. For a stuck intervention the loop needs *this particular
text* to reach the model, and the guard treats the two cases as one.

**The fix.** The directive is queued onto the turn that is already coming, with
pi's third delivery mode:

```js
  if (!ctx.hasPendingMessages()) {
    scheduleLoopTurn(pi, "stuck", delayMs, ctx);
    return;
  }
  sendLoopTurn(pi, "stuck", ctx, { queueOnly: true });   // deliverAs: "nextTurn"
```

`deliverAs: "nextTurn"` pushes onto pi's `_pendingNextTurnMessages`, which
`_runAgentPrompt` drains and injects as context alongside the next user message
(pi 0.84.2, `agent-session.js:880`). So the text lands on the turn the pending
message triggers rather than on a second turn of our own — the iteration is still
not double-run, which is what the guard was protecting. And
`pendingMessageCount` (`:1151`) counts only steering and follow-up messages, not
these, so queueing one cannot make `hasPendingMessages()` true and cascade.

The escalating delay is given up on this path, deliberately: its job is to space
out turns the loop schedules, and this one is not the loop's to space.

`deliverAs: "followUp"` was the other candidate and is worse here — it *is*
counted by `pendingMessageCount`, and with `triggerTurn` it would run the
iteration twice.

*Tests:* `stuck-ladder.test.ts`, last describe. Two cases, one of which fails
without the fix; the not-pending case is the control, and it asserts that nothing
is sent synchronously — the timer path must stay a timer.

---

### V5 — the verifier's repair reads one of its RunResult's five fields · **MEDIUM** · PROVEN · **FIXED**

**Where.** `buildVerifyDeps.repair` at `agent-manager.ts:372`, against
`structuralVerdict` in `verify.ts:81` and `attachSettlementChain` at
`agent-manager.ts:539`.

**What.** `runSessionPrompt` returns the same five-field object for every run in
this package — the child's first run, an operator steer, the judge, and the
repair. The settlement chain reads four of them to decide a status:

```js
record.lifecycle.status = aborted ? "aborted"
                        : modelError ? "error"
                        : turnLimited ? "turn_limited"
                        : "completed";
```

The repair reads one:

```js
const result = await continueAgentSession(session, prompt, { maxTurns: 1, graceTurns: 6, … });
deadline.assertNotExpired();
return result.responseText;
```

So the repair's own lifecycle is written nowhere, and the structural gate — whose
entire job is *"a run that ended at the turn ceiling / by watchdog / by a stop is
objectively suspect and needs no judgement"* — is applied to the child's first
run and to nothing else.

A repair is not a small run. It goes into the child's own session with the
child's own tools, at `maxTurns: 1` and `graceTurns: DEFAULT_GRACE_TURNS`, so
pi's loop keeps going while there are tool results and the hard abort lands at
turn **7**. T1's fix means no wrap-up steer is sent, so the abort is the first
thing that ends it: whatever had streamed is what comes back, cut wherever the
abort landed.

**Proved.** `j5`. The real `wireTurnTracking` at `maxTurns: 1, graceTurns: 6`,
driven for seven turns — a repair that read two files before answering:

```
  aborted      : true      <- hard abort at maxTurns + graceTurns
  turnLimited  : true
  modelError   : whatever getFinalModelError(session) found
  responseText : …" tokenize(line)\nsrc/lint"     <- the only field read
```

That text through the real `verifyAnswer`, with a judge that reads it as an
answer:

```
  notify: Subagent answer did not address the task (it describes the function
          instead of listing its callers.) — asking again (attempt 1 of 1).

  status : repaired
  answer : "src/parser.ts:14 — tokenize(input)
            src/repl.ts:88 — tokenize(line)
            src/lint

            [verification: the first answer did not address the task; this is the
             corrected one, and it was re-checked.]"
```

And the same text, judged as the run it actually was:

```
  status completed     -> worthJudging: true   skip: -
  status aborted       -> worthJudging: false  skip: cutoff
  status turn_limited  -> worthJudging: false  skip: cutoff
  status error         -> worthJudging: false  skip: error
```

**What it costs.** The parent is handed a truncated answer with a note that says
it was corrected and re-checked, and a `✎ repaired` badge whose tone is
"warning" but whose label reads as an improvement. The `record.verification`
field says `repaired`. Nothing anywhere records that the run producing that text
was hard-aborted mid-token — the manager did not classify it, the widget's
finished line describes the child's original run, and `record.lifecycle.status`
is still `completed` from before verification began.

A repair that ends in a **provider error** is the same shape: `modelError` is
dropped, and `responseText` falls back to
`getLastAssistantText(session, messageStart)`, which returns the last assistant
message that had any text. On a failed turn that is usually empty (→ the verifier
correctly returns `failed`), but it is not guaranteed to be.

**The fix.** The repair reports what happened, and the same gate the first run
gets is applied to it. `structuralVerdict` already takes `(answer, {status})` and
needs nothing else, so the change is in what crosses back:

```ts
export interface RepairResult {
  text: string;
  status: AgentStatus;   // the same classification the child's own run gets
}
```

and in the round loop, in place of the separate empty check:

```ts
const outcome = await deps.repair(buildRepairPrompt(brief, verdict.why));
const repaired = typeof outcome?.text === "string" ? outcome.text.trim() : "";
const repairGate = structuralVerdict(repaired, { status: outcome?.status ?? "completed" });
if (!repairGate.ok || !repairGate.worthJudging) {
  return { answer: answer + verificationNote("failed", attempts), status: "failed" };
}
```

One gate now covers both cheap rejections: an empty repair (`ok: false`) and a
cut-off one (`worthJudging: false`). The stall check stays *after* it, because
"the agent repeated itself when asked again" is a different sentence from "the
corrections were no better" and the order decides which the parent is told.
`?? "completed"` is the permissive default: a caller that reports no status must
not have a good repair turned into a failure.

In `agent-manager.ts` the classification came out of `attachSettlementChain` into
`classifyRun(result)`, which both callers now use — so a caller taking a subset
of a `RunResult` has to say so. That extraction is also what made V6 a one-line
change rather than a three-module one.

`graceTurns: DEFAULT_GRACE_TURNS` became `getStore().agent.graceTurns ??
DEFAULT_GRACE_TURNS` in the same edit: the repair was the one run in the file that
ignored the operator's setting (§8).

*Tests:* eight cases in `vendor/pi-subagents-lite/tests/verify-runner.test.ts`,
four of which fail without the gate. The `completed` case — byte-identical text,
one field different — is the control that the gate did not simply make the
verifier refuse repairs, and the stalled and empty cases pin the ordering.

---

### V6 — a one-turn budget reports `turn_limited`, which means "cut off" to two readers · **MEDIUM** · PROVEN · **FIXED**

**Where.** `wireTurnTracking` in `turn-tracking.ts:107`, against
`STATUS_NOTES` in `status-note.ts:4` and `structuralVerdict` in `verify.ts:108`.

**What.** T1's fix established that a one-turn budget is a different shape from a
long one:

> the soft-limit steer is skipped when the budget is one turn. A one-turn run
> that made tool calls still continues … and is still bounded by the hard abort,
> so nothing loses its ceiling; **it is simply not asked to wrap up a turn it has
> already finished.**

`shouldSteerAtSoftLimit(1)` is `false` and that is right. The line above it was
not given the same treatment:

```js
if (!softLimitReached && turnCount >= maxTurns) {
  softLimitReached = true;                       // ← set for maxTurns === 1 too
  …
  if (shouldSteerAtSoftLimit(maxTurns)) session.steer(TURN_LIMIT_STEER);
}
…
return { …, getTurnLimited: () => softLimitReached };
```

**Proved.** `j6`, through the real module:

```
  scenario                                  turnLimited  aborted  wrap-up asked for?
  ------------------------------------------------------------------------------------
  max_turns: 1  agent answers in one turn   true         false    no
  max_turns: 1  agent read a file first     true         false    no
  max_turns: 3  agent answers on turn 2     false        false    no
  max_turns: 3  agent reaches turn 3        true         false    steer("You have reached y…")
  max_turns: 40 agent answers on turn 5     false        false    no
  max_turns: 40 agent reaches turn 40       true         false    steer("You have reached y…")
```

Every other row that reports `turnLimited` was *asked to wrap up* — the flag and
the steer agree that the run was cut short of what it was doing. The two
`max_turns: 1` rows are the only ones where the run reached its ceiling by
finishing, and they are reported identically.

**What that status then means.** Two readers, both consequential:

```
  status-note.ts   turn_limited -> " (wrapped up at the turn limit — output may
                                     be partial)"     appended to the text the
                                                      PARENT MODEL reads
  verify.ts        turn_limited -> worthJudging:false, skip:"cutoff"
                                -> the answer is NEVER CHECKED
                                -> badge "⊘ unchecked (cut off)"
```

**Reachability.** Three routes, all supported:

- `max_turns: 1` in an agent `.md` — parsed by `parseNumber`, no lower bound
  beyond `normalizeMaxTurns`' `max(1, n)`;
- the `/agents` spawn wizard's **Max turns** field, a free numeric input;
- `defaultMaxTurns` in the model-family config, which applies to *every* spawn
  that does not override it.

`__verifier` declares `maxTurns: 1` and is unaffected only because the judge goes
through `runAgent` directly and its `RunResult` is never classified.

**What it costs.** For a deliberately one-turn agent — a classifier, a
summariser, a "answer this from what you already know" helper, which is exactly
what a one-turn budget is *for* — every answer arrives at the parent labelled
possibly-partial and with verification silently switched off. The verifier's
whole purpose is to draw one distinction, *checked and fine* against *nobody
checked*, and this puts an entire class of agent permanently in the second
bucket without saying so.

**The fix.** The one variable became two, in the module that already made the
distinction:

```js
let ceilingReached = false;   // arms the grace-turn abort, and nothing else
let turnLimited = false;      // "the run was cut short of what it was doing"
…
if (!ceilingReached && turnCount >= maxTurns) {
  ceilingReached = true;
  if (graceTurns <= 0) { aborted = true; … return; }
  if (shouldSteerAtSoftLimit(maxTurns)) {
    turnLimited = true;
    void session.steer(TURN_LIMIT_STEER).catch(() => {});
  }
} else if (ceilingReached && turnCount >= maxTurns + graceTurns) { … }
```

The flag is set exactly where the steer is sent, because "this run was cut short"
and "this run is being asked to stop early" are the same fact under the same
condition. Splitting it rather than reusing `shouldSteerAtSoftLimit` inline is
what keeps the hard abort: `ceilingReached` still arms it, so a one-turn run that
keeps calling tools is still severed at `maxTurns + graceTurns` and reports
`aborted` — which is true, and which the gate refuses to judge for the right
reason. `graceTurns <= 0` is unaffected either way, because `aborted` outranks
`turnLimited` in `classifyRun`.

The alternative — leave the flag and teach the two readers about `maxTurns === 1`
— spreads one fact across three modules and was rejected for that reason.

*Tests:* `tests/turn-tracking.test.ts`. Three cases, two of which fail without
the fix; the new "DOES report turnLimited for a budget with somewhere left to go"
case is the control, and the hard-abort case pins that the ceiling was not lost
with the flag.

---

### V7 — the judge's session is disposed on the path where its run returns, and on no other · **LOW** · SOURCE · **FIXED**

**Where.** `buildVerifyDeps.judge` at `agent-manager.ts:326`.

**What.** The judge deliberately calls `runAgent` directly rather than
`this.spawn()`, and the comment above it states exactly what that costs and how
it is paid for:

> Going around `spawn()` also means going around every teardown `spawn()` would
> have arranged: no record, so nothing in `dispose()` or `clear()` ever reaches
> this session. **Disposing it here is the whole cleanup** — without it every
> judged answer leaks one `AgentSession`, its message history and its bound
> extensions, for the life of the process.

The teardown reads `result`:

```js
let result: RunResult | undefined;
try {
  result = await runAgent(ctx, VERIFIER_AGENT_TYPE, prompt, {…});
  deadline.assertNotExpired();
  return result.responseText;
} finally {
  deadline.cancel();
  try { result?.session?.dispose(); } catch {}
}
```

`result` is assigned only when the await **resolves**. `runAgentImpl` creates the
session with `createAgentSession()`, binds its extensions, and only then prompts,
so every rejection after that point — `bindExtensions` throwing, `session.prompt()`
rejecting on a provider fault — loses the only reference to a live session.

The timeout path does *not* leak, and the distinction is worth keeping straight:
the deadline aborts the signal, `forwardAbortSignal` calls `session.abort()`,
`prompt()` **resolves**, `result` is assigned, and `assertNotExpired()` throws
afterwards — inside the try, with the `finally` still to run.

**Proved.** `j7` prints the block out of the source and replays the shape:

```
  after a judge that answered      : sessions disposed = 1
  after a judge that threw         : sessions disposed = 1   <- unchanged
```

**What it costs.** One `AgentSession` per throwing judge call, with its message
history (the brief + the answer + the reply) and its bound extensions, held for
the life of the process. Small per occurrence; unbounded across a long unattended
run against a provider that intermittently rejects — which is the provider this
stack runs on, and the reason the 300 s deadline exists at all.

**The fix.** The session is captured where it is created rather than where it is
returned. `runAgent`'s options already carry `onSessionCreated`, and the manager
uses it for exactly this purpose on the spawn path:

```js
let judgeSession: AgentSession | undefined;
try {
  const result = await runAgent(ctx, VERIFIER_AGENT_TYPE, prompt, {
    …,
    onSessionCreated: (session) => { judgeSession = session; },
  });
  deadline.assertNotExpired();
  return result.responseText;
} finally {
  deadline.cancel();
  try { judgeSession?.dispose(); } catch {}
}
```

`onSessionCreated` fires inside `createAndConfigureSession`, before
`bindExtensions` returns, so it covers every failure the old form missed.

*Test:* a source pin in `tests/turn-tracking.test.ts`, next to U8's and by the
same argument — `agent-manager.ts` imports pi and the suite cannot load it. It
asserts that `result?.session?.dispose()` is absent and that the
`onSessionCreated` capture and the `judgeSession?.dispose()` are present, so it
cannot pass by the teardown having been deleted. Comments are stripped first: the
fix's own comment quotes the defective form. One case, and it fails without the
fix.

---

### V8 — a re-issued goal keeps `preparedAt` and resets `goalFile` · **LOW** · PROVEN · **FIXED**

**Where.** `applyGoalConfig()` at `index.ts:853`.

**What.** `preparedAt` is a flag; `goalFile` is what it points at. The function
preserves the flag and resets the target:

```js
// Re-issuing the same goal (e.g. to tweak flags after /loop prepare) keeps the prepared spec.
const preservedPreparedAt = state.description === parsed.description ? state.preparedAt : 0;
state = {
  ...defaultState(),
  …
  goalFile: parsed.goalFile || "GOAL.md",
  preparedAt: preservedPreparedAt,
};
```

The comment names the intent exactly — *keeps the prepared spec* — and the line
below it discards the only record of where that spec is, whenever the re-issue
omits `--file`.

**Proved.** `j8`:

```
  /loop goal port the renderer to the new API --file SPEC.md
      Goal file: SPEC.md (not prepared)
  /loop prepare   → GOAL_READY
      Goal file: SPEC.md (prepared)

  /loop start port the renderer to the new API      ← same goal, no --file
      Goal file: GOAL.md (prepared)

  the first turn the loop sends:
      Start loop mode. First read GOAL.md to load the full specification, …
      Specification: GOAL.md — read it whenever you lose track of the plan.
```

Both of those lines exist *only because* `preparedAt` was preserved, and both
point at a file that was never written.

**What it costs.** The model is told to read a file that does not exist, twice,
on the first turn of an unattended run, and the actual specification — which a
strong model was spent producing — is never mentioned. The likely outcome is a
turn spent discovering the absence and then working without the spec.

**The fix.** The pair is preserved together. `goalFile` is part of what
"prepared" means:

```js
const sameGoal = state.description === parsed.description;
const preservedPreparedAt = sameGoal ? state.preparedAt : 0;
const preservedGoalFile = sameGoal && preservedPreparedAt > 0 ? state.goalFile : "";
…
goalFile: parsed.goalFile || preservedGoalFile || "GOAL.md",
```

so an explicit `--file` still wins, an unprepared re-issue still defaults to
`GOAL.md`, and a prepared one keeps pointing at the spec that exists.

*Tests:* `run-restart.test.ts`, last describe. Four cases, one of which fails
without the fix; the other three are the controls for each of those three
sentences.

---

## 8. Smaller things, and things that are not findings

Recorded so the next pass does not re-derive them. None of these is proposed for
a change; each carries the reason.

- **The repair ignores the operator's `graceTurns`.** `buildVerifyDeps.repair`
  passes `graceTurns: DEFAULT_GRACE_TURNS` (6), while the child's first run uses
  `getStore().agent.graceTurns` and `continueSettledAgent` uses
  `getStore().agent.graceTurns ?? DEFAULT_GRACE_TURNS`. An operator who sets
  grace turns to 0 in `/agents` gets 0 everywhere except inside the verifier.
  Consistent with V5's picture — the repair is the one run whose wiring was
  written separately — and it becomes a one-word change if V5 is fixed. SOURCE.
- **`exclude_tools` is U6's sibling, one field over.** `tools` now goes through
  `parseExtensions` (`true`/`all` → `true`, `false`/`none` → `false`), but
  `exclude_tools` still goes through `parseStringArray`, which treats any
  non-empty scalar as a comma list — so `exclude_tools: all` becomes the
  one-element denylist `["all"]` and excludes nothing. Unlike `tools: true` the
  spelling is not one anybody has a reason to write, and both readings are
  "exclude nothing"; recorded because it is the same shape and would be the same
  one-line fix. SOURCE.
- **`hasStateChange()` matches its keyword list against any tool output**, so
  reading a file containing the word "successfully" resets
  `lastStateChangeIteration` and postpones the no-progress audit. Carried
  forward from the fifth pass.
- **`hasStateChange()` also writes `state.iterationCount + 1`** from
  `tool_result`, which fires during turns that never reach the success path (an
  aborted or errored turn). The marker then sits one iteration ahead of a
  counter that did not advance, which postpones the audit by one more window.
  Trivial, and it errs toward not nagging. SOURCE.
- **A provider-error streak has no terminal state.** The context ladder escalates
  to `pauseForContextFailure` after `MAX_CONTEXT_COOLDOWNS`; the provider-error
  branch retries forever with a backoff capped at 300 s, and never increments
  `iterationCount`, so `--max N` cannot end it either. Defensible for an
  unattended run; the asymmetry between the two ladders is not written down.
  Carried forward.
- **`consecutiveErrorCount` is shared between context pressure and provider
  errors**, and `backoffSeconds()` reads it, so a run that saw two
  context-pressure turns and then a provider error backs off as if it had failed
  three times. Carried forward.
- **`getFinalModelError()` returns undefined when the final assistant message has
  `stopReason: "error"` but an empty `errorMessage`.** The run is then classified
  `completed`, so the structural gate judges it and the parent is handed whatever
  text arrived as a successful answer. One `??` away from impossible; whether a
  provider produces that shape is still unknown. Carried forward.
- **The `Agent` tool's `execute` reads `params.max_turns`, which its schema does
  not declare and nothing injects.** Dead: the value always comes from the agent
  file or the store. Harmless, and misleading to a reader — it is the one line
  that makes the tool look as if it exposes a turn budget. Carried forward, and
  now load-bearing for V6's reachability argument in the negative sense: the
  *model* cannot set `max_turns: 1`, only an operator or an agent file can.
- **`__verifier` is hidden from the `Agent` tool's type list but not from
  `resolveType`.** The list is a description string, not a schema `enum`, so a
  model that guesses `agent: "__verifier"` gets a real spawn — one turn, no
  tools, verification skipped for it by `buildVerifyDeps`. Harmless. Carried
  forward.
- **`SlotTable.setLimits()` reads `config.default` with no fallback** (the
  constructor uses `?? fallbackDefault`), and `Math.max(1, undefined)` is `NaN`,
  which reads as unlimited rather than as a crash. Every real caller passes a
  merged config. Carried forward.
- **A `providers` or `models` entry of `0` is applied as 1 and then deleted** —
  `applyEntry` clamps with `Math.max(1, limit)` and the cleanup loop's `if
  (!config.models[key])` treats `0` as absent. Consistent outcome, inconsistent
  route. Carried forward.
- **`record.stats.turnCount` is initialised to 1 at spawn**, before any turn has
  run, so a record that never got a turn reports one and `previousTurns` for a
  repair on such a record starts at 1. Cosmetic. SOURCE.
- **A background subagent result delivered while a loop is running triggers a
  turn the loop counts as an iteration** — `agent_end` increments
  `iterationCount`, runs the goal check, and evaluates the reply for LOOP_DONE
  and for repetition. Carried forward, and now also the situation V4 is about.
- **The spawn bracket is still a process-global counter.** Narrowed to extension
  loading and binding only, so the window is milliseconds; it is still a window.
  Carried forward.
- **`detectDegenerateRepetition` runs over every assistant message on every
  `context` event**, and again every 500 streamed characters. Carried forward.
- **`AgentStatus` lists every agent ever spawned this session**, unbounded.
  Carried forward.

---

## 9. What was re-verified this pass, and holds

Read out of the tree, not assumed.

- **All nine fifth-pass fixes are in place**, and all nine `i` probes still run
  clean. `commitTurnMemory` fills the windows once per turn; the stuck verdict is
  computed above the marker branches; `applyCheckOutcome` returns early on
  `execFailed`; `readWhy` is line-anchored and relative to the deciding verdict;
  `loop(action:"start")` refuses while active; `tools` goes through
  `parseExtensions`; `stack.ts` guards its own factory; `previousTurns` is
  captured once; `Explore` has no `bash`.
- **All ten fourth-pass fixes are in place**, and `h1`–`h6`, `g1`–`g3` and
  `verify-prior-fixes` still run clean.
- **The gates are unchanged:** `pi-subagents-lite` 182 tests + lint 70/70,
  `pi-loop-mode` 108, `compaction-guard` 39 — **329 passing**. None of V1–V8 is
  caught by any of them.
- **Which declaration governs a spawn is now consistent** (§4.6). Every read of
  `tools`, `registeredTools`, `excludeTools`, `model`, `thinkingLevel`,
  `maxTokens`, `maxTurns` and `preloadSkills` goes through `getAgentConfig`;
  `extensions`/`skills` through `declaredResources`; the three prompt switches
  through `declaredPromptSources`. `getConfig`'s hidden-type substitution can no
  longer reach anything that changes behaviour.
- **The judge's prompt is still 463 chars**, with no project context, no parent
  system prompt and no environment block.
- **The loop is inert in a child**, by three independent stops.
- **`pi-subagents-lite` is inert in a child** by the factory guard, so a child
  cannot spawn a grandchild.
- **The prinny denial is keyed on a path segment with an optional package
  prefix**, so it survives `npm i` and a drop into `~/.pi/agent/extensions/`.
- **The two budget-line injectors still do not double up**, by the shared
  `/-context-budget$/` customType suffix, in either registration order.
- **The slot is still held across verification**, and `recount()` still keys on
  `holdsSlot`.
- **`verifyAnswer` still never throws** — its prologue is inside its own try, and
  `runVerification` catches anything the prologue could still raise. The repair
  gate added for V5 is inside that try too.
- **The three earlier probe series still run clean after these eight changes**,
  including the ones that read the same windows V1 and V2 touched: `i1` (the
  marker branches), `i2` (the per-turn windows), `g2` (the per-turn tool
  counter) and `h4` (the sampling penalties).

---

## 10. What shipped

All eight, in the order §10 of the research draft put them. Every fix carries a
regression test that fails when the fix is removed; where a case passes either
way it is a control and is labelled as one.

| # | Fixed by | Where | Tests | Fail without it |
| --- | --- | --- | --- | --- |
| V1 | `emptyResponse` asks whether the model produced an ANSWER — text or a tool call — and a reasoning-only turn gets its own reason string | `pi-loop-mode/extensions/index.ts`, `src/context-recovery.ts` | `reasoning-turns.test.ts` ×4 | 1 |
| V2 | `commitTurnMemory` returns what it committed, and `detectStuck` compares that string | same | `reasoning-turns.test.ts` ×4 | 2 |
| V3 | `resetCheckState()` + `CHECK_STATE_KEYS`, called from `runLoop()`, with the three context counters beside it | `src/goal-check.ts`, `extensions/index.ts` | `run-restart.test.ts` ×5 | 2 |
| V4 | the directive is queued with `deliverAs: "nextTurn"` when a turn is already coming | `extensions/index.ts` | `stuck-ladder.test.ts` ×2 | 1 |
| V5 | `repair` returns `{ text, status }`; `classifyRun()` extracted; the round loop gates the repair | `pi-subagents-lite/src/agents/verify-runner.ts`, `agent-manager.ts` | `verify-runner.test.ts` ×8 | 4 |
| V6 | `ceilingReached` and `turnLimited` split; the flag follows the steer | `src/agents/turn-tracking.ts` | `turn-tracking.test.ts` ×3 | 2 |
| V7 | the judge's session captured in `onSessionCreated` | `src/agents/agent-manager.ts` | `turn-tracking.test.ts` ×1 (source pin) | 1 |
| V8 | `goalFile` preserved with `preparedAt` | `pi-loop-mode/extensions/index.ts` | `run-restart.test.ts` ×4 | 1 |
| §8 | the repair honours the operator's `graceTurns` | `agent-manager.ts` | (in V5's eight) | — |

### The gates

```
                                    before    after
vendor/pi-subagents-lite   tests    182       193     lint 70/70 files
vendor/pi-loop-mode        tests    108       127
.pi/extensions/compaction-guard      39        39     (untouched)
                                   ─────     ─────
                                    329       359
```

All twenty-seven probes run clean — `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`,
`i1`–`i9` and `j1`–`j8` — and the eight `j` probes were rewritten afterwards to
print BEFORE and NOW, so each is now its own control.

### Four things worth keeping from how these went

- **The smaller edit for V2 was the wrong one.** Filling the window with
  `messageToText` only also makes the two units agree, and it is one line. It
  loses detection: the broken code *does* catch byte-identical thinking, late and
  under the wrong rule's name, and that would have gone with it. Passing the
  committed string keeps both directions. Two ways to make a mismatch go away are
  not equivalent just because both make it go away.
- **Two fixes changed behaviour they were not aimed at, and both were wanted.**
  `message_end` used to return its sanitized replacement below an early return
  keyed on the tracked text, so a degenerate message with no text block never got
  truncated — a shape that did not exist before the forge patch and does now. And
  `classifyRun`, extracted for V5, is what made V6 a one-line change instead of a
  three-module one.
- **A control has to be able to fail, and one nearly could not.** V6's control —
  a longer budget still reporting `turnLimited` — passes either way, which is the
  point; but the *hard-abort* case had to assert `getTurnLimited() === false`
  after the abort as well, or reverting the fix would have left it green.
- **V7 is pinned at the source, not behaviourally**, because `agent-manager.ts`
  imports pi and the suite cannot load it. Same standing problem the fourth pass
  named, same answer: when the rule cannot be moved somewhere testable, test the
  file — stripping comments first, because the fix's own comment quotes the
  defective form.

---

## 11. Running the evidence

```sh
cd ~/instantcoffee

# the gates
( cd vendor/pi-subagents-lite && npm test && node tests/lint.mjs )   # 193 + 70/70
( cd vendor/pi-loop-mode       && npm test )                         # 127
( cd .pi/extensions/compaction-guard && npm test )                   #  39

# just this pass's regression tests
( cd vendor/pi-loop-mode && node --experimental-strip-types --test \
    tests/reasoning-turns.test.ts tests/run-restart.test.ts tests/stuck-ladder.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/verify-runner.test.ts tests/turn-tracking.test.ts )

# this pass's probes  (the loop's state is module-global — one mode per process)
P=context/testing/probes
node --experimental-strip-types $P/j1-reasoning-only-turn-is-not-empty.mjs before
node --experimental-strip-types $P/j1-reasoning-only-turn-is-not-empty.mjs after
node --experimental-strip-types $P/j2-stuck-rules-read-text-only.mjs text
node --experimental-strip-types $P/j2-stuck-rules-read-text-only.mjs thinking
node --experimental-strip-types $P/j3-loop-run-keeps-the-old-check-state.mjs score
node --experimental-strip-types $P/j3-loop-run-keeps-the-old-check-state.mjs done
node --experimental-strip-types $P/j4-stuck-intervention-dropped-when-pending.mjs clear
node --experimental-strip-types $P/j4-stuck-intervention-dropped-when-pending.mjs pending
node --experimental-strip-types $P/j5-repair-runresult-discarded.mjs
node --experimental-strip-types $P/j6-one-turn-budget-reads-as-turn-limited.mjs
node                            $P/j7-judge-session-leaks-on-throw.mjs
node --experimental-strip-types $P/j8-prepared-spec-file-lost-on-restart.mjs
```

Each `j` probe now prints **BEFORE** and **NOW**, like the `h` and `i` series, so
running one is enough to see both the defect and the repair. Each one that takes a
mode argument also ships its own control:

| probe | what it showed | the control |
| --- | --- | --- |
| `j1` | `after` — no notice, iteration counted, ladder reset | `before` — the `content: []` shape, which always routed to recovery |
| `j2` | `thinking` — four turns, no notice | `text` — caught on turn 2, unchanged |
| `j3` | `score`, `done` — run 1's state decided run 2 | run 1 itself, and `/loop resume`, both correct throughout |
| `j4` | `pending` — nothing sent, nothing scheduled | `clear` — the strategy still goes on a timer |
| `j5` | a hard-aborted repair returned as `repaired` | the same text with `status: "completed"`, still accepted |
| `j6` | the two `max_turns: 1` rows | the four rows above and below them |
| `j8` | `Goal file: GOAL.md (prepared)` | the two lines before the re-issue |

`j7` is source-pinned rather than driven: `agent-manager.ts` imports pi, which
does not resolve under the plain node the probes run on. It prints the block out
of the real file and replays both shapes side by side.

`_host.mjs` gained one line for `j4`: `sendMessage` now records the options it was
called with, attached to the message so every existing probe's
`sent.find(m => m.details.kind === …)` keeps working. A loop turn can be sent,
scheduled, or queued onto a turn that is already coming, and only the options say
which.

---

## 12. Still unwatched

Unchanged from the fifth pass, and now longer by one. Eight defects were fixed
this pass against probes and tests, and none against a running model — which is
the seventeenth in a row.

1. **A real verification.** Still the highest-value unwatched thing, and it is
   now the most informative it has ever been: one foreground delegation with
   `SUBAGENT_VERIFY_ROUNDS=1` and a deliberately off-task brief exercises a judge
   whose verdict parser (S2) and reason parser (U4) have both been repaired, a
   repair whose outcome now crosses back (V5), a turn counter that no longer
   accumulates (U8), and a session that no longer leaks when the provider drops
   the call (V7). Five fixed defects on one code path, none of them watched.
2. **The judge's raw reply is still not logged.** Top of the list since the
   fourth pass. It is now load-bearing for three fixed defects and one new one:
   S2, U4, and V5's "was the text the judge passed actually a whole answer".
3. **A delegation with a loop running.** Fixed at the module level twice, never
   watched — and it is now the exact situation V4 is about, because a background
   subagent's nudge is a pending message.
4. **Section I of `context/testing/subagents-loop-verifier.md`**, still never
   run, now six passes old.
5. **A reasoning-only turn, in the wild, with the loop running.** New, and the
   one item on this list where the *rate* is the unknown rather than the
   behaviour. The forge patch has been in the image since 2026-08-17. `j1` and
   `j2` say what the module does with the shape, and both are now fixed; only a
   run says how often the shape arrives — which is the difference between a
   defect that cost a run and one that never fired.
6. **A child that fills its own 32k and compacts**, so the anchor can be watched
   landing.
7. **The 40-turn ceiling and the steer-then-abort ladder** against a real model.
8. **`stats.verifyUsage` and the 300 s deadline** against a real model.

---

## 13. The pattern across six audits

```
   inside a module            B1–B8    a function does not do what it says
   between two modules        F1–F11   two correct functions disagree at the seam
   module ↔ pi's runtime      T1–T9    correct code, wrong assumption about the host
   declaration ↔ code         S1–S10   the artefact a reader checks is not what runs
   unit ↔ unit                U1–U9    the rule and the thing it governs are each
                                       right, and are counted in different things
   whole ↔ part               V1–V8    a reader takes a subset that used to be the
                                       whole thing, or is the whole thing only in
                                       the common case
```

Three habits fall out of the sixth, and they are the transferable part:

- **When a shape on the wire changes, grep for every consumer of it — including
  the ones in other vendor packages.** The forge patch's commit message names the
  hazard, in a sentence, and then names one consumer. There were three. The two
  that were fine were fine by accident of how they were written, not by anyone
  having checked them.
- **A test fixture set is a claim about which shapes exist.** `pi-loop-mode`'s
  suite contained no `thinking` content block, which is a claim that an assistant
  message is text or nothing. That claim was true until 2026-08-17. 108 tests
  could not fail on a shape none of them constructs, and no amount of adding more
  tests of the same shape would have helped. The fix for that is one fixture, not
  one assertion: `reasoning-turns.test.ts` builds the shape and eight cases use
  it.
- **A five-field result read one field at a time is a decision, and it should
  read like one.** V5 and V6 are both `RunResult` — one caller taking a subset,
  one field meaning two things. The settlement chain's classification expression
  was the only place in the package that read all five together, and it was
  written out inline; `classifyRun(result)` now makes every other caller's subset
  visible as a choice rather than as an omission, and pulling it out is what made
  V6 a one-line change.

---

## 14. Where to look

- `context/testing/probes/j1`–`j8` — the reproductions, one per finding, each
  printing BEFORE and NOW.
- The regression tests: `vendor/pi-loop-mode/tests/reasoning-turns.test.ts` (V1,
  V2), `run-restart.test.ts` (V3, V8), `stuck-ladder.test.ts`' last describe (V4);
  `vendor/pi-subagents-lite/tests/verify-runner.test.ts` (V5) and
  `turn-tracking.test.ts` (V6, V7).
- `context/design/subagents-loop-verifier-units.md` — the fifth pass (U1–U9, all
  fixed). Its §9 reference sections are not restated here.
- `context/design/subagents-loop-verifier-surfaces.md` — the fourth pass
  (S1–S10, all fixed).
- `context/design/subagents-loop-verifier-mechanics.md` — the third pass
  (T1–T9), still the best account of pi's own agent loop. T1 is load-bearing for
  V6.
- `context/design/subagents-loop-verifier-evaluation.md` — the second audit
  (F1–F11).
- `context/design/subagents-loop-verifier-anatomy.md` — the first audit and the
  design rationale; carries inline corrections from later passes.
- `patches/forge_reasoning_passthrough.py` and commit `e81a7e5` — the change V1
  and V2 are about.
- `vendor/prinny-channel/src/forwarding.ts`, `describeEmptyEnding` — the one
  consumer that was updated, with the comment that names the hazard.
