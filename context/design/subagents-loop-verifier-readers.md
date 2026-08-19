# Subagents, the loop, and the verifier — the second reader, and where the last fix stopped

Seventh pass, 2026-08-18. A full read of the three components and the seams
between them, drawn from the angle the sixth pass's own repairs opened up, with
**six findings (W1–W6) — all six fixed**, each with an executable probe that
prints BEFORE and NOW, and each with a regression test that fails when the fix is
removed.

**359 tests passing and lint 70/70 caught none of the six.** The suite is now
**383** and 71/71; §10 has what shipped and the control-run failing count for
each fix.

---

## 0. How this sits next to the other six documents

Each earlier pass found defects in a *place*, and each place was further from the
code than the last:

| pass | document | where the defects were |
| --- | --- | --- |
| first | `…-anatomy.md` (B1–B8) | inside a module |
| second | `…-evaluation.md` (F1–F11) | in the wiring between two modules |
| third | `…-mechanics.md` (T1–T9) | between a module and pi's runtime |
| fourth | `…-surfaces.md` (S1–S10) | between a declaration and its implementation |
| fifth | `…-units.md` (U1–U9) | between the unit a rule is written in and the unit it is enforced in |
| sixth | `…-shapes.md` (V1–V8) | between a thing and the part of it a reader takes |

This one found a seventh, and it is the first that is **about the earlier passes
themselves**: *between the site a rule was fixed at, and the sites next to it
that read the same fact.*

Every one of W1–W6 is downstream of a numbered earlier finding. Not a regression
— none of the twenty-seven prior fixes has come undone, and their probes all
still run clean. Each one is the **second reader**: a place where a pass
established the right rule, applied it to the instance in front of it, and left a
sibling still governed by the old one.

```
   V2  "detectStuck must compare the string the window committed"
         ↳ fixed detectStuck.  emptyResponse, LOOP_DONE and LOOP_BLOCKED
           still read the last MESSAGE.                                   W1

   V2  the window and the rules that read it must be the same thing
         ↳ fixed WHICH string.  The window also has a LENGTH — 1,500 chars —
           and rule 5 compared a full answer against that prefix.          W2

   fork  "the brief has to grow with the task, or the continuation is checked
          against a question it was not asked"
         ↳ fixed continueSettledAgent.  steer()'s two RUNNING branches, which
           are the ones the conversation viewer calls "steer", did not.    W3

   V6  "reaching a one-turn ceiling IS finishing, not being cut short"
         ↳ fixed the turnLimited flag.  The graceTurns <= 0 branch one line
           above still severed the same run and called it aborted.        W4

   U4/S2  the judge's verdict and reason are parsed carefully because the
          parent model acts on them
         ↳ the NOTES the parent reads were left building their own counts:
           "the 2th attempt", a hardcoded "a third time".                 W5

   V7  "capture the judge's session at creation, so a rejection cannot drop
        the only reference to it"
         ↳ the capture was moved to onSessionCreated on the strength of a claim
           that it fires before bindExtensions. It fired after it.        W6
```

That is the transferable finding, and §13 makes the argument: **a fix has a blast
radius, and the sibling sites inside it are the cheapest defects there are to
find and the least likely to be looked for.** Five of these six were reachable by
grepping for the other callers of a thing the previous pass had just touched.

Read the other six documents for evidence, not orientation. Nothing they fixed
has come undone: all ten fourth-pass fixes, all nine fifth-pass fixes and all
eight sixth-pass fixes are in the tree, and their probes still run clean.

---

## 1. The whole machine, and where these six live

```
 ┌──────────────┐   ┌───────────────────────────────────┐   ┌────────────────┐
 │  llama.cpp   │──▶│ forge — the OpenAI-compatible      │──▶│      pi        │
 │  ONE slot    │   │ proxy on :8081                     │   │                │
 │  PARALLEL_   │   │ patches/forge_reasoning_           │   │ maps           │
 │  SLOTS=1     │   │   passthrough.py  (e1 e81a7e5)     │   │ reasoning_     │
 └──────────────┘   │ emits reasoning_content alongside  │   │ content onto a │
                    │ content, and a truthful            │   │ THINKING block │
                    │ finish_reason                      │   │ {type,thinking}│
                    └───────────────────────────────────┘   └───────┬────────┘
                                                                    │
                          one assistant MESSAGE                     │
   ┌────────────────────────────────────────────────────────────────▼───────┐
   │ { role: "assistant",                                                    │
   │   content: [ {type:"text",text} | {type:"thinking",thinking}            │
   │            | {type:"toolCall",…} ],                                     │
   │   stopReason: "stop"|"length"|"error"|"aborted", errorMessage?,         │
   │   usage:{output} }                                                      │
   └───────┬──────────────────────┬───────────────────────┬─────────────────┘
           │                      │                       │
  ┌────────▼────────┐   ┌─────────▼──────────┐   ┌────────▼─────────────────┐
  │ prinny-channel  │   │ pi-loop-mode       │   │ pi-subagents-lite        │
  │ "said nothing"  │   │ "empty response"   │   │ extractText()            │
  │  = no text and  │   │  = the TURN said   │   │  = the text blocks       │
  │    no toolCall  │   │    nothing    ← W1 │   │                          │
  └─────────────────┘   └────────────────────┘   └──────────────────────────┘

                        …but a TURN is not a message:

   pi emits, for ONE turn (agent-loop.js — while (hasMoreToolCalls ||
                                                  pendingMessages.length > 0))

     message_start ─┐
     message_end    │  msg A  [ text "LOOP_DONE: the feature is shipped." ]
                   ─┘
        ╌╌╌╌╌╌╌╌╌╌╌╌ a background subagent settles; SpawnCoordinator
                      .emitIndividualNudge sends its result with
                      deliverAs:"steer", triggerTurn:true — the parent is
                      busy, so it lands INSIDE this turn ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
     message_start ─┐
     message_end    │  msg B  [ thinking "…already said so, nothing to do" ]
     turn_end       │
     agent_end     ─┘

                        event.messages = [ …, A, B ]
                        lastAssistant  = B          ← what the markers read
                        the turn's ANSWER = A       ← what they meant     W1
```

Below the message, the rest of the machine is unchanged from the fifth and sixth
passes' accounts:

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │   -e vendor/pi-subagents-lite   4 handlers  Agent·StopAgent·AgentStatus  │
   │   -e vendor/pi-loop-mode       13 handlers  loop tool · /loop            │
   │   -e vendor/rtk-pi, vendor/prinny-channel                                │
   │   discovered under .pi/extensions/: compaction-guard, browser-guard,     │
   │                                     stack (guards its own factory)       │
   │                                                                          │
   │   module-global state, shared by every session in this PROCESS:          │
   │     pi-loop-mode  state:LoopState · runToken · pendingTimer              │
   │                   turnAssistantTexts · turnToolCalls · turnAnswerTexts   │
   │     pi-subagents  shell{pi,sessionCtx,manager,widget,store,coordinator}  │
   │     shell.ts      __PI_SUBAGENT_SPAWN_DEPTH__ on globalThis              │
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent tool call
   ┌──────────────▼────────┐    ┌─────────────────────────────────────────────┐
   │ SpawnCoordinator      │───▶│ AgentManager                                │
   │  live view · spawnCtx │    │  SlotTable (default 1) · queue              │
   │  awaits the gate (fg) │    │  Watchdog 45 min tool/idle                  │
   │  nudges (bg)          │    │  completion gate per record                 │
   └───────────────────────┘    │  steer() ─ running ─▶ session.steer   ← W3  │
                                │           └ settled ▶ continueSettledAgent  │
                                └────────────────┬────────────────────────────┘
                                                 │ runAgent()
                   ┌─────────────────────────────┴───────────────────┐
                   │ enterSubagentSpawn()   ← depth > 0 ONLY here    │
                   │   reloadAndMap()    → every extension factory   │
                   │   createAgentSession()                          │
                   │   onSessionCreated  ← the capture         ← W6  │
                   │   bindExtensions()  → handlers, session_start   │
                   │ exitSubagentSpawn()                             │
                   └─────────────────────────────┬───────────────────┘
                                                 ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, in-memory SessionManager         │
   │    own system prompt · own tools · own window · own event bus            │
   │    ceiling maxTurns → wrap-up steer → hard abort graceTurns later  ← W4  │
   └──────────────────────┬───────────────────────────────────────────────────┘
                          │ settles — status terminal, SLOT STILL HELD
                          ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                       │
   │    structural gate (free) → judge (fresh __verifier session, 1 turn)     │
   │    → repair (the child's own session, 1 turn) → judge again → …          │
   │    → verificationNote(kind, attempts) — the parent's only view of it W5  │
   └──────────────────────┬───────────────────────────────────────────────────┘
                          │ .finally: release slot, tally, drain queue, open gate
                          ▼
        foreground ─→ Agent tool result       background ─→ capBackgroundResult()
                                                          ─→ pi.sendMessage()
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, and the parent's next call are four things in one queue.

---

## 2. The loop (`vendor/pi-loop-mode`) — one turn, and everyone who reads it

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool. Its whole job is deciding what a turn's outcome *was*.

### 2.1 The thirteen handlers

```
  session_before_compact  replace pi's model-written summary with a locally built
                          handoff on a small window, or with an emergency summary
                          during recovery
  session_compact         adopt a compaction pi did itself
  session_start           restore state from the branch; auto-resume after restart
  session_shutdown        drop the pending timer and the turn buffers
  agent_settled           deferred context recovery — pi runs its own overflow
                          recovery after agent_end and wins that race
  before_agent_start      append the loop's goal + rules to the system prompt
  before_provider_request anti-repetition sampling penalties for PENALTY_TURNS
  context                 sanitize degenerate assistant messages; append the
                          context-budget line (standing down if compaction-guard
                          already added one)
  message_start           reset the mid-stream degeneracy throttle
  message_update          mid-stream kill switch for runaway repetition
  tool_result             buffer the call into turnToolCalls; count it
  message_end             buffer the message into turnAssistantTexts  ← and now
                          into turnAnswerTexts                          [W1]
  agent_end               THE LADDER — §2.3
```

### 2.2 One turn, read six ways

This is the drawing W1 exists for. **One turn, two messages, and what each
consumer takes out of it.**

```
   msg A  [ {type:"text", text:"LOOP_DONE: the feature is shipped."} ]
   msg B  [ {type:"thinking", thinking:"…already said so, nothing to do"} ]
   toolCallsThisTurn = 0

   ────────────────────────────────────────────────────────────────────────────
   reader                          derives from                    sees
   ────────────────────────────────────────────────────────────────────────────
   message_end                     messageToText(m)
     ↳ turnAssistantTexts            || messageToRepetitionText(m)   A, then B
       (the repetition windows)

   message_end                     messageToText(m)                  A only
     ↳ turnAnswerTexts               text blocks only                    ← NEW
       (the turn's answer)

   agent_end  committedText        commitTurnMemory(turnTexts,…)     A
     ↳ detectStuck's 7 rules         the last NON-EMPTY of the turn   [V2 fixed]

   agent_end  turnAnswerText       last of turnAnswerTexts           A
     ↳ emptyResponse                 → isContextPressure's                ← NEW
     ↳ /LOOP_DONE:/  /LOOP_BLOCKED:/   starvation rung               [W1 fixed]

   agent_end  lastAssistantText    messageToText(lastAssistant)      ""
     ↳ the model-error reason line     the LAST MESSAGE only         ← was ALL
                                                                       of the
                                                                       above

   agent_end  lastAssistant-       messageToRepetitionText(last)     B
              RepetitionText         the LAST MESSAGE, text OR thinking
     ↳ the degenerate scan, and the "which kind of empty" reason string

   subagents  runTurnLoop          collectResponseText(text_delta)   A
                                     || getLastAssistantText(…)      (the
                                        which walks BACK to text      fallback
                                        — correct by construction)    saves it)

   prinny     describeEmptyEnding  any block that is text or toolCall  A → not
                                                                       empty
   ────────────────────────────────────────────────────────────────────────────
```

The rows that used to disagree:

```
      message_end   pushes    messageToText(m) || messageToRepetitionText(m)
                              ╰── the value that lands in the fingerprint /
                                  snippet / text windows                  [V2]

      agent_end     asks      messageToText( LAST MESSAGE )
                              ╰── whether the turn was empty, and whether it
                                  said LOOP_DONE                          [W1]
```

`pi-subagents-lite` gets this right without meaning to: `getLastAssistantText`
walks *backwards* through the session's messages for the last one with text, so a
trailing reasoning-only message never becomes the answer. The loop had the same
walk — `commitTurnMemory`'s `[...texts].reverse().find(t => t.trim())` — and only
`detectStuck` used it.

### 2.3 `agent_end` — the ladder, in full

Twenty-one `return;` statements and a fall-through. Every arrow leaving the column
is a `return`.

```
 agent_end(event, ctx)
   │
   ├─ !state.active ─────────────────▶ (prepare-mode GOAL_READY watch) ─────▶ ✗
   │
   ├─ clearPendingTimer()
   ├─ toolCallsThisTurn := state.toolCallsThisTurn ; state.… := 0      ← T2
   ├─ turnTexts   := turnAssistantTexts
   ├─ turnCalls   := turnToolCalls
   ├─ turnAnswers := turnAnswerTexts                                   ← [W1]
   ├─ resetTurnBuffers()                                               ← U2
   ├─ if penaltyTurnsRemaining > 0: penaltyTurnsRemaining--            ← S4
   │
   ├─ lastAssistantText           := messageToText(last)
   ├─ lastAssistantRepetitionText := messageToRepetitionText(last)
   ├─ turnAnswerText := last non-empty of turnAnswers ?? lastAssistantText [W1]
   │
   ├─ softStopRequested ──────────────────────────────────────────────────▶ ✗
   │
   ├─ emptyResponse := !turnAnswerText && tools === 0          ← [V1][W1]
   ├─ isContextPressure({stopReason, errorMessage, outputTokens,
   │                     contextPercent, emptyResponse}) ─────────────────▶ ✗
   │     · "length" with <= 32 output tokens
   │     · "length" at >= 85%
   │     · "error" matching /400|context|token|length|maximum output/ at >= 85%
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
   ├─ committedText := commitTurnMemory(turnTexts, turnCalls)  ← ONE entry [U2]
   │
   ├─ rescueActive ─▶ switch back to the loop model ──────────────────────▶ ✗
   │
   ├─ stuckReason := detectStuck(committedText, repetitionText)  ← [U1][V2]
   ├─ if !stuckReason: consecutiveStuckCount := 0                ← [U1]
   │
   ├─ checkCommand → runGoalCheck() → applyCheckOutcome()
   │     ├─ execFailed × MAX_CHECK_ERRORS ─▶ pauseForCheckFailure ────────▶ ✗
   │     └─ untilDone && passed && !execFailed ───────────────────────────▶ ✗ completed
   │
   ├─ /\bLOOP_DONE\s*:/i.test(turnAnswerText)                    ← [W1]
   │     ├─ untilDone && checkCommand && lastCheckPassed !== true ← [U3][V3]
   │     │     ├─ stuckReason ─▶ interveneStuck ──────────────────────────▶ ✗
   │     │     └─ else check_failed directive ────────────────────────────▶ ✗
   │     ├─ untilDone ────────────────────────────────────────────────────▶ ✗ completed
   │     └─ endless: stuckReason ? interveneStuck : improve ───────────────▶ ✗
   ├─ /\bLOOP_BLOCKED\s*:/i.test(turnAnswerText)  ← [W1]
   │     stuckReason ? interveneStuck : unblock ──────────────────────────▶ ✗
   ├─ maxIterations reached ──────────────────────────────────────────────▶ ✗
   ├─ scoreRegressed ─▶ regression directive ─────────────────────────────▶ ✗ [V3]
   ├─ stuckReason ─▶ interveneStuck ──────────────────────────────────────▶ ✗
   ├─ iterationCount - lastStateChangeIteration >= 8 ─▶ audit nudge ──────▶ ✗
   │
   └─ normal continue: schedule the next turn
```

### 2.4 `detectStuck`, and the two dimensions of its window

Seven rules, in order; the first that matches wins, and its text becomes both the
operator's notice and the model's directive.

```
  1  detectDegenerateRepetition(repetitionText, 4)     sentence / word / phrase
  2  turnsWithoutTools >= 3                            "narration only"
  3  last two fingerprints equal   AND text.length>80  "repeated the same response"
  4  last three fingerprints equal AND text.length>0   "… three times"
  5  textSimilarity(text, previous) >= 0.80
        AND text.length > 60                           "~N% similar to previous"
  6  same fingerprint >= 3 in the 8-turn window        "repeated 3+ times"
  7  last three TURN tool signatures identical         "the same <tool> calls
                                                        returned the same thing"
  8  same question repeated (text ends in "?")
```

V2 settled *which string* those rules compare. W2 is the other dimension of the
same window — *how much of it is kept*:

```
   commitTurnMemory                        detectStuck rule 5
   ───────────────────────────             ────────────────────────────────
   lastAssistantFingerprints               prints.slice(-2), .slice(-3)
     fingerprint(finalText)      full        exact equality — length-blind ✓
     bounded at 8 entries

   lastAssistantSnippets                   lastSnippets.slice(-2)
     snippet(finalText)          280 ch      exact equality ✓
     bounded at 5 entries

   lastAssistantTexts                      texts[texts.length - 2]
     finalText.slice(0, 1500)  ← 1,500 ch    textSimilarity(FULL current,
     bounded at 4 entries                                   1500-char stored)
                                                                          ✗ W2
```

`textSimilarity` is Jaccard over word trigrams. When the stored string is a
**prefix** of the current one, the intersection is the whole of the prefix's
shingle set and the union is the whole of the current one, so the score is
approximately `1500 / length` — regardless of how identical the two turns were.
Measured, on text with distinct trigrams:

```
   answer chars   similarity(current, stored previous)   rule 5 fires at >= 0.80
   ────────────   ───────────────────────────────────   ──────────────────────
        1200                    1.000                            yes
        1500                    1.000                            yes
        1875                    0.790                            no
        2500                    0.590                            no
        3000                    0.493                            no
        4000                    0.370                            no
        6000                    0.246                            no
```

The 1,500 was the one bound in `commitTurnMemory` that did **not** come from
`PERSISTED_WINDOW`, whose own comment says the bounds live there so the in-memory
window and the persisted one cannot drift apart.

### 2.5 The escalation ladder, and its three rungs' guards

```
  interveneStuck(reason)
    consecutiveStuckCount++ ; interventionCount++ ; turnsWithoutTools := 0
    penaltyTurnsRemaining := PENALTY_TURNS (3)
      → before_provider_request rewrites the payload for 3 turns:
        frequency_penalty 0.5, presence_penalty 0.5, temperature +0.2
      │
      │  saturated := contextUsage.percent >= CONTEXT_STARVATION_PERCENT (80)
      │
      ├─ rescue      !saturated && rescueModel && !rescueActive && streak >= 3
      │              switchModel → scheduleLoopTurn("rescue", 0, ctx)
      │              ── UNCONDITIONAL
      │
      ├─ compact     saturated || (streak >= 5 && iterations since last
      │              compaction >= 5)
      │              ctx.compact({onComplete: scheduleLoopTurn("stuck", 0)})
      │              ── UNCONDITIONAL, and not wrapped in a try (§8)
      │
      └─ strategy    otherwise
                     delay := min(60, 2 ** min(streak, 6)) seconds
                     rotating STUCK_STRATEGIES[interventionCount % 5]
                     streak >= 3 adds the HARD RESET block
                     ctx.hasPendingMessages()
                       ? sendLoopTurn(…, {queueOnly:true})   deliverAs:"nextTurn"
                       : scheduleLoopTurn("stuck", delay, ctx)        [V4 fixed]
```

### 2.6 The context ladder

```
  1. TELL THE MODEL        context handler, every provider call
       >= 60%  advisory line, appended last (cached prefix untouched)
       >= 80%  CRITICAL wording
       pi-loop-mode and compaction-guard both inject one; whichever runs second
       sees the other's `-context-budget` customType suffix and stands down.

  2. DETECT PRESSURE       agent_end → isContextPressure()      ← [V1][W1]

  3. RECOVER               deferred to agent_settled, because pi runs its own
                           overflow recovery after agent_end and wins the race
       attempt 1,2   → emergency compaction, tighter summary each time
       attempt 3     → cooldown 60s → 120s → 240s, tighter still
       cooldown 4    → pauseForContextFailure — the only place the loop gives up
```

The measurement the starvation rung rests on, and therefore W1's severity:
**below 87% of the window, 3 empty assistant turns out of 196; at or above 87%,
33 out of 63.** A cliff, not a gradient — and an empty turn still costs a full
iteration.

---

## 3. Subagents (`vendor/pi-subagents-lite`)

61 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
`/agents` menu, a slot table, a watchdog, and a spawn coordinator that owns
delivery.

### 3.1 A record's life

```
  spawn()                status queued | running        started: false
    │                    gate created (createCompletionGate)
    │                    parent signal bound (foreground only)
    │                    brief := prompt                        ← forge fork
    ▼
  startAgent()           slot reserved · watchdog started · started := true
    │                    outputLog opened if configured
    ▼
  runAgent()             reloadAndMap → createAgentSession
    │                      → onSessionCreated  ← record.execution.session  [W6]
    │                      → bindExtensions → tool filtering
    │                    pendingSteers flushed
    ▼
  .then                  status ← classifyRun(result)
    │                    result := responseText
    │                    runVerification()                      ← forge fork
    │                    completedAt stamped AFTER the check
    ▼
  .finally               settlementCount++ · outputLog finalised
                         slot released · tallyCompletion · drainQueue
                         parent binding detached · gate opened · settled := true
```

The **completion gate** is the invariant worth knowing: every record carries a
promise from birth, opened exactly once, never assigned the run's own promise. Six
paths open it — settlement, a queued stop, a start failure, an already-aborted
spawn, dispose, and record removal — so a foreground `Agent` call can never hang
on a record that will not settle.

### 3.2 `steer()` — two branches, three readers, one brief

```
   manager.steer(id, message)
     │
     ├── status === "running"
     │     ├── no session yet ─▶ pendingSteers.push(message)
     │     │                     growBrief(record, message)          ← W3 fixed
     │     │                     (flushed by onSessionCreated)
     │     │
     │     └── session ────────▶ await session.steer(message)
     │                           growBrief(record, message)          ← W3 fixed
     │                           (only AFTER it went — a steer that
     │                            threw never reached the model)
     │
     └── terminal ────────────▶ continueSettledAgent(record, message)
                                 · re-reserve the slot
                                 · growBrief(record, message)   ← already did
                                 · record.verification := undefined
                                 · restart the watchdog
                                 · re-attach the settlement chain

   record.execution.brief has exactly three readers, and all three are
   consequential:

       verifyAnswer(record, brief, deps)        what the answer is CHECKED against
         └─ buildJudgePrompt(brief, candidate)

       buildRepairPrompt(brief, why)            what the child is told to answer
         └─ "This is the task, in full, as it was given to you: <brief>.
             Answer it now. … Do not restate the task."

       buildAnchorMessage(brief)                what is restated into a context
         └─ fired from onCompaction — the one   that was just compacted
            place a drifting child's task has
            most likely gone missing
```

The forge fork fixed the settled branch and wrote down exactly why:

> `brief` was written once, at spawn, and never updated. So steering a settled
> agent … produced an answer to the STEER, judged against the ORIGINAL prompt.
> The judge said NOT_ADDRESSED, correctly, and the repair then told the child
> "This is the task, in full, as it was given to you: <the original>. Answer it
> now" — actively undoing the operator's instruction, and labelling the result
> `✎ repaired`, which reads as an improvement.

Every word of that was also true for a **running** agent, which is the branch the
UI calls "steer" by name: `conversation-viewer.ts` chooses its verb with
`this.isActive() ? "steer" : "continue"`.

### 3.3 The turn ceiling, as a state machine

```
                       normalizeMaxTurns(n):  0 → unbounded
                                              absent → 40
                                              else max(1, n)

   turn_end, turnCount++
        │
        ├── maxTurns == null ──────────────────────────────▶ nothing, ever
        │
        ├── !ceilingReached && turnCount >= maxTurns
        │      ceilingReached := true
        │      │
        │      ├── graceTurns <= 0
        │      │     ├── shouldSteerAtSoftLimit(maxTurns)      (maxTurns > 1)
        │      │     │      aborted := true ; session.abort()
        │      │     └── else  ─────────────────────────────▶ nothing  ← W4 fixed
        │      │            (a ONE-turn ceiling is reached by FINISHING; the
        │      │             `else if` below still severs it on the next turn)
        │      │
        │      └── graceTurns > 0
        │            ├── shouldSteerAtSoftLimit(maxTurns)
        │            │      turnLimited := true               ← V6
        │            │      session.steer(TURN_LIMIT_STEER)
        │            └── else  ─────────────────────────────▶ nothing  ← T1
        │
        └── ceilingReached && turnCount >= maxTurns + graceTurns
               aborted := true ; session.abort()

   classifyRun(result)      aborted ▸ modelError ▸ turnLimited ▸ completed

   and the two readers of what comes out:

     status-note.ts   aborted      → " (hit the turn limit before completion;
                                       output may be incomplete)"
                      turn_limited → " (wrapped up at the turn limit — output
                                       may be partial)"
                                    ── appended to the text the PARENT MODEL reads

     verify.ts        aborted / turn_limited / stopped
                                  → worthJudging:false, skip:"cutoff"
                                  → the answer is NEVER CHECKED
                                  → badge "⊘ unchecked (cut off)"
```

The full matrix, driven through the real module (`k4`):

```
   grace  maxTurns  turns reached   status         wrap-up asked?
   ─────  ────────  ─────────────   ────────────   ──────────────
     6        1           1         completed      no          ← the shape V6
     0        1           1         completed      no          ← rescued …
     0        1           2         aborted        no             …and W4
     6        3           2         completed      no
     0        3           2         completed      no
     6        3           3         turn_limited   yes
     0        3           3         aborted        no
     6        3           9         aborted        yes
```

### 3.4 Concurrency

`SlotTable` holds per-model and per-provider pools. Precedence is per-model ▸
per-provider ▸ default, and the default case **creates and caches** a per-model
slot — which is why `setLimits()` must delete slots the new config no longer
names, and why it must then `recount()` from the holders themselves.

> A `running` count is a fact about the world; a `limit` is configuration.

`recount()` keys on `execution.holdsSlot` rather than on `status === "running"`,
because the slot is held right through the verification window, where the status
has already gone terminal.

The default is **1**, in exactly one place (`config-io.ts`). The measurement
behind it: a child having its own system prompt does *not* by itself evict the
parent's cached prefix (99.2% hit across six small child turns); what evicts it is
*size* — a child that grew to 18k tokens took the parent's next call from 2,117
cached tokens to zero, and from 442 ms to 2,949 ms.

### 3.5 What a child inherits

```
   the PARENT is started with  -e vendor/rtk-pi  -e vendor/pi-loop-mode
                               -e vendor/pi-subagents-lite  -e vendor/prinny-channel
                                 │  a child does NOT inherit -e flags
                                 ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the child's DefaultResourceLoader                                       │
   │   route A — DISCOVERY               route B — additionalExtensionPaths   │
   │   ~/.pi/agent/extensions/**         subagentExtraExtensionPaths():       │
   │   <cwd>/.pi/extensions/**             vendor/rtk-pi/extensions/index.ts  │
   │     compaction-guard  ✓ wanted        (or $SUBAGENT_EXTRA_EXTENSIONS)    │
   │     browser-guard     – harmless                                         │
   │     stack           ✗ guards itself  suppressed entirely when the agent  │
   │                        (U7)          declares extensions: false          │
   │   ── withExtensionDenial() runs LAST over both ────────────────────      │
   │      any path segment matching (?:[a-z0-9._@-]*-)?prinny-channel/ cut    │
   └──────────────────────────────────────────────────────────────────────────┘

   `vendor/pi-loop-mode` reaches a child by neither route, deliberately:
     · not discovered (it lives in vendor/)
     · removed from route B, because its state is module-global
     · and its factory returns early when __PI_SUBAGENT_SPAWN_DEPTH__ > 0
```

---

## 4. The verifier

### 4.1 Three layers, cheapest first

```
   record settles ─▶ record.result = responseText
                        │
                        ▼
   ┌──── structuralVerdict(answer, lifecycle) ─────────────────────────────┐
   │  answer trims to ""      ─▶ ok:false            skipped-empty          │
   │                              (the note REPLACES the answer)            │
   │  status "error"          ─▶ worthJudging:false  skipped-error          │
   │  status aborted /                                                      │
   │    turn_limited / stopped ─▶ worthJudging:false skipped-cutoff  ← W4   │
   │  brief missing            ─▶                    skipped-nobrief  ← W3  │
   └────────────────────────────┬──────────────────────────────────────────┘
                                │ non-empty, clean run, brief present
                                ▼
   ┌──── the round loop, budget = SUBAGENT_VERIFY_ROUNDS (default 1) ──────┐
   │                                                                       │
   │   phase "judging"                                                     │
   │   judge(buildJudgePrompt(brief, candidate))   ← fresh __verifier      │
   │        │                                        session, 1 turn, 300s │
   │        ▼                                                              │
   │   parseJudgeVerdict(reply)                                            │
   │        ├─ unparsed ─────────────▶ candidate + note(unparsed,attempts) │
   │        │                                                        ← W5  │
   │        ├─ addressed, 0 attempts ▶ candidate (bare)      passed        │
   │        ├─ addressed, n attempts ▶ candidate + note(repaired,n)  ← W5  │
   │        └─ not addressed                                               │
   │              ├─ attempts >= rounds ▶ ORIGINAL + note(failed,n)        │
   │              └─ phase "repairing"                                     │
   │                 repair(buildRepairPrompt(brief, why))   ← brief  W3   │
   │                      │            ← the CHILD's own session,          │
   │                      │              maxTurns 1, operator graceTurns   │
   │                      ├─ structuralVerdict(repaired, {status})   ← V5  │
   │                      │     !ok || !worthJudging ▶ ORIGINAL + failed   │
   │                      ├─ == candidate ▶ ORIGINAL + note(stalled,n) W5  │
   │                      └─ candidate := repaired ─▶ round again          │
   └───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
              record.verification := status   → badge, /agents, tool details
              record.result       := answer   → every reader sees one text
```

### 4.2 The note vocabulary, which is the parent's only view of any of this

A passing answer is returned **undecorated** — deliberately, so the parent does
not quote a verdict into its own answer. Everything else appends one sentence,
and that sentence is the whole of what the parent model learns:

```
   verdict           badge                       note (abridged)
   ───────────────   ─────────────────────────   ────────────────────────────────
   passed            ✓ checked        dim        (none)
   repaired          ✎ repaired       warning    "…this is the corrected one" /
                                                 "…this is the {second|third}
                                                  attempt"                 ← W5
   failed            ✗ off-task       error      "…and {no attempt was made |
                                                  one attempt … | two attempts …}
                                                  … Treat it as unreliable."
   failed (stalled)  ✗ off-task       error      "…so it was not asked a
                                                  {third|fourth|fifth} time" ← W5
   unparsed          ? unreadable     warning    "the check could not be read" /
                     verdict                     "…the first answer did not
                                                  address the task; this is a
                                                  corrected one…"           ← W5
   errored           ? check errored  warning    "the check did not complete"
   skipped-empty     ⊘ empty answer   warning    (REPLACES the answer)
   skipped-cutoff    ⊘ unchecked      dim        (the status note says why) ← W4
                       (cut off)
   skipped-error     ⊘ unchecked      warning    (executeAgentTool returns
                       (failed)                   errorResult instead)
   skipped-nobrief   ⊘ unchecked      dim        (a fault in the spawn path)
                       (no task)
   (absent)          —                           the verifier never ran
```

`verify.ts`'s own comment on `describeAttempts` states the rule these have to
follow, and it is the reason W5 is a finding rather than a typo:

> English for a small count, so the note reads like a sentence rather than a log
> line. **The parent model reads this text, and "1 attempts" is the kind of thing
> it copies into its own answer.**

### 4.3 The two asymmetries, and both are the design

- **The judge knows less on purpose.** A model shown its own reasoning ratifies
  it, so the judge is shown two quoted blocks and a question. Tools, extensions,
  skills, project context files, the parent's system prompt and the environment
  block are all declared off. Its whole system prompt is 463 chars.
- **The repair knows more on purpose.** It continues the child's own session,
  because that is the only place with the context to fix the answer.

`why` is the one value that crosses from the first into the second, and U4
repaired how it is read: line-anchored, taken relative to the line that decided
the verdict, never the prompt's own `WHY_INSTRUCTION`.

### 4.4 The judge's session, and the one teardown it has

```
   the judge calls runAgent DIRECTLY, not this.spawn():

     spawn()  would  create a record → dispose()/clear() can reach the session
     runAgent does not → the `finally` in buildVerifyDeps.judge IS the teardown

   runAgentImpl
     ├─ getConfig / getAgentConfig / declaredPromptSources
     ├─ SettingsManager.create
     ├─ detectEnv                       (skipped: includeEnvironment: false)
     ├─ buildPrompt / createResourceLoader
     └─ buildSubagentSession
          enterSubagentSpawn()
          ├─ reloadAndMap()             every extension factory runs
          └─ createAndConfigureSession
               ├─ initSession() ─▶ createAgentSession()   THE SESSION EXISTS
               ├─ onSessionCreated(session)   ← the capture           [W6 fixed]
               ├─ setSessionName()
               ├─ await bindExtensions()      ── could reject here
               ├─ resolveVisibleTools()
               └─ setActiveToolsByName()      ── and here
          exitSubagentSpawn()
     └─ runSessionPrompt(session, prompt)     ── and here (the common one)

   try {
     const result = await runAgent(ctx, "__verifier", prompt, {
       …, onSessionCreated: (session) => { judgeSession = session; },
     });
     deadline.assertNotExpired();
     return result.responseText;
   } finally {
     deadline.cancel();
     try { judgeSession?.dispose(); } catch {}
   }
```

V7 moved the capture off `result?.session` because `result` is only assigned when
the await **resolves**. The capture was placed in `onSessionCreated` — and
`onSessionCreated` was the **last** line of `createAndConfigureSession`, below the
bind and below the tool filtering. That is W6.

### 4.5 The deadline, and why it exists

Verification runs inside the settlement chain, **after** the status has gone
terminal, and every stop path keys off `status === "running"`. So during a judge
or a repair the record is unstoppable: the operator's Esc reaches `stopAgent()`,
which returns false; `StopAgent` the same; and the watchdog's `check()` does not
merely skip the record, it deletes its state. Meanwhile the parent's `Agent` call
is blocked on the completion gate. Nothing else can end that wait, so a 300 s
per-call deadline does. (That is T5, still open by decision.)

---

## 5. A delegation, on a timeline

The interesting part is **who holds the slot and for how long**, because the slot
is what the parent's next turn is waiting behind.

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
   │          createAgentSession → onSessionCreated ← W6│        │
   │          bindExtensions (child session_start)      │        │
   │                                                    │        │
   │  run     turn 1 … turn k    ← llama, one at a time │        │
   │            each compaction fires the anchor steer  │        │
   │            an operator steer here grows the        │        │
   │              brief the anchor restates       ← W3  │        │
   │            turn maxTurns → wrap-up (or not)  ← W4  │        │
   │            + graceTurns  → hard abort              │        │
   │                                                    │        │
   │  settle  status ← classifyRun(result)              │        │
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
              │                                                  │
              │ (background instead: capBackgroundResult →        │
              │  pi.sendMessage deliverAs steer|followUp,         │
              │  triggerTurn:true — and if the parent is BUSY     │
              │  that lands inside the running turn)      ← W1    │
```

The parent's wait is `child + judge + repair + judge`, all serialised on one llama
slot. Every design decision that looks over-careful about cost is over-careful
about that queue.

---

## 6. Findings

Severity is about what it costs a real run. Evidence is **PROVEN** (an executable
probe drives the shipped module), **MEASURED** (a number taken from the tree), or
**SOURCE** (read, with the reasoning in the finding).

| # | Finding | Sev | Evidence | Probe | Sibling of | Fixed |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | `agent_end` derives "what the model said this turn" three ways; V2 fixed one of them, and the completion markers still read the last MESSAGE | **HIGH** | PROVEN | `k1` | V1, V2 | ✔ |
| W2 | the repetition window stores 1,500 chars of an answer; the near-duplicate rule compares the current answer in full against that prefix | **MEDIUM** | PROVEN·MEASURED | `k2` | V2, U2 | ✔ |
| W3 | `steer()` has three branches and only the settled one grew `record.execution.brief` | **MEDIUM** | PROVEN | `k3` | the fork's own steer fix | ✔ |
| W4 | with `graceTurns: 0` a one-turn run that ANSWERED was severed and reported `aborted` | **MEDIUM** | PROVEN | `k4` | T1, V6 | ✔ |
| W5 | three of the verifier's five notes built their own counts, and two of them read wrong at every budget that reaches them | **LOW** | PROVEN | `k5` | S2, U4 | ✔ |
| W6 | V7's capture was placed on a claim about ordering that the code did not satisfy | **LOW** | PROVEN·SOURCE | `k6` | V7 | ✔ |

---

### W1 — the turn's answer is read three ways in one handler · **HIGH** · PROVEN · **FIXED**

**Where.** `agent_end` at `vendor/pi-loop-mode/extensions/index.ts:2006–2026`,
against `commitTurnMemory` at `:267` and `message_end` at `:1903`.

**What.** `agent_end` asks "what did the model say this turn" three times and used
to get three different answers:

```js
  const committedText = commitTurnMemory(turnTexts, turnCalls);  // last NON-EMPTY
                                                                 // message of the turn
  const lastAssistantText = messageToText(lastAssistant);        // the LAST message
  const lastAssistantRepetitionText = messageToRepetitionText(lastAssistant);
```

V2 moved `detectStuck` onto the first, and wrote down the rule:

> the window and the rules that read it have to be about the same thing, and they
> were not.

Three other readers were left on `lastAssistantText`:

```js
  const emptyResponse = … && !lastAssistantText.trim() && toolCallsThisTurn === 0;
  if (/\bLOOP_DONE\s*:/i.test(lastAssistantText))    { … }
  if (/\bLOOP_BLOCKED\s*:/i.test(lastAssistantText)) { … }
```

That is a distinction without a difference for a one-message turn — which is
every turn in `pi-loop-mode`'s suite and every turn in every probe before this
one. It stops being one when a turn ends on a message that is not its answer.

**How a turn gets one.** pi's agent loop is
`while (hasMoreToolCalls || pendingMessages.length > 0)`, so a message injected
mid-turn produces another assistant message *inside the same turn*. The stack
injects one on purpose: `SpawnCoordinator.emitIndividualNudge` delivers a settled
background subagent's result with

```js
  pi.sendMessage({ customType: "subagent-result", … },
                 { deliverAs: parentIdle ? "followUp" : "steer", triggerTurn: true });
```

and `deliverAs: "steer"` while the parent is **busy** is exactly the mid-turn
case. Since 2026-08-17 that extra message can also be reasoning-only —
`patches/forge_reasoning_passthrough.py` stopped forge discarding
`reasoning_content`, so a thinking-only turn reaches pi as `content: [thinking]`
rather than `content: []`, which is what V1 and V2 were about.

**Proved.** `k1`, driving the real module. One turn: an answer carrying the
completion marker, then a reasoning-only message.

```
  what each reader takes out of that turn:
    committedText  (detectStuck, since V2) : "LOOP_DONE: the feature is shipped …"
    messageToText(last message)            : ""                        <- BEFORE
    turnAnswerText (the turn's answer)     : "LOOP_DONE: the feature is shipped …"

  BEFORE, at 20% context — an --until-done run that has finished does not stop:
    notice  : (no notice)
    Active: true   Status: running   Iterations: 1/∞

  BEFORE, at 90% context — the same turn is read as starved instead:
    notice  : Loop: context pressure detected (1/3) — recovering.

  NOW, both:
    notice  : Loop completed: ship the feature
    Active: false  Status: completed
```

**What it costs.** Two things, and they are on opposite sides of the same line:

- In `--until-done` mode the goal check and the marker are the *only* terminating
  conditions. A run that has finished and said so keeps going, and the loop's own
  design rule is "never stop on your own".
- At or above `CONTEXT_STARVATION_PERCENT` the turn is instead routed to context
  recovery: `consecutiveErrorCount` is incremented, the turn does not count as an
  iteration, an emergency compaction is queued for `agent_settled`, and the goal
  check does not run. A turn that *answered* is charged to the ladder built for
  turns that could not.

Both need a subagent result arriving mid-turn, which is the combination §12 has
listed as never watched since the fifth pass — and which V4 is also about.

**Why no test caught it.** Every assistant turn in `pi-loop-mode/tests/` is one
message. That is not a gap in coverage, it is a *claim*: that a turn and its last
message are the same thing. The claim was true for as long as nothing injected a
message mid-turn, and `reasoning-turns.test.ts` — added by the sixth pass for
exactly this class — builds the new content shape but still one message per turn.

**The fix.** `message_end` buffers the turn's answers separately from its
repetition feed, and `agent_end` reads that:

```js
  // message_end
  const tracked = messageToText(trackedMessage) || messageToRepetitionText(trackedMessage);
  if (tracked.trim()) turnAssistantTexts.push(tracked);      // the windows
  const answered = messageToText(trackedMessage);
  if (answered.trim()) turnAnswerTexts.push(answered);       // the answer

  // agent_end
  const turnAnswerText =
    [...turnAnswers].reverse().find((text) => text.trim()) ?? lastAssistantText;
```

Two properties matter more than the shape:

- **It is the turn's own material**, not a scan of `event.messages`, so it cannot
  reach back into an earlier turn and complete a run on a marker from three turns
  ago.
- **`lastAssistantText` is the fallback**, so a turn whose messages never reached
  `message_end` — the loop became active mid-turn, `stopReason` was `error` or
  `aborted` — behaves exactly as it did before. Nothing gets *more* generous;
  only the case where the buffer positively says the turn answered changes.

*Tests:* `vendor/pi-loop-mode/tests/turn-answer.test.ts`, first describe. Six
cases, two of which fail without the fix. The controls are the one-message turn,
the turn that answered nothing (V1's case, which must stay starved), the turn
that made a tool call, and — in the other direction — a marker that appears only
inside the model's thinking, which must still not complete a run.

---

### W2 — the near-duplicate rule compares a full answer against a stored prefix · **MEDIUM** · PROVEN·MEASURED · **FIXED**

**Where.** `commitTurnMemory` at `index.ts:274` against `detectStuck` rule 5 at
`:809`, and `PERSISTED_WINDOW` in `src/loop-state.ts`.

**What.** The window keeps a bounded amount of each answer:

```js
  pushLimited(state.lastAssistantTexts, finalText.slice(0, 1_500), PERSISTED_WINDOW.texts);
```

and rule 5 compares the current answer, **in full**, against it:

```js
  const previousText = texts[texts.length - 2];
  if (previousText && normalizeText(lastAssistantText).length > 60) {
    const similarity = textSimilarity(lastAssistantText, previousText);
```

`textSimilarity` is Jaccard over word trigrams. When the stored string is a
prefix, `|A ∩ B| = |shingles(prefix)|` and `|A ∪ B| = |shingles(full)|`, so the
score collapses toward `1500 / length` whatever the two turns actually were.

**Proved and measured.** `k2`, four turns of the same paragraph with one word in
forty swapped — a rephrasing, which is the only thing rule 5 exists for, because
rules 3 and 4 catch byte-identical repeats by fingerprint:

```
   answer length                           2822 chars  (textChars = 1500)
   similarity, both full                   0.817
   BEFORE  full current vs stored previous 0.450
   NOW     both cut to textChars           0.813
   SIMILARITY_THRESHOLD                    0.800

   BEFORE           NOW
   turn 1  —        turn 1  —
   turn 2  —        turn 2  Loop stuck (1x): ~81% similar to previous
   turn 3  —        turn 3  Loop stuck (2x)
   turn 4  —        turn 4  Loop stuck (3x)
   Interventions 0  Interventions 3
```

The threshold crossing is at about **1,875 characters**, and above it the rule
could not fire even for a byte-identical repeat:

```
   1200 → 1.000    1875 → 0.790    3000 → 0.493    6000 → 0.246
   1500 → 1.000    2500 → 0.590    4000 → 0.370
```

**What it costs.** The narrower half of `detectStuck`. Rules 3, 4 and 6 still
catch exact repetition, so a model that says the same long thing verbatim is
still caught. What is lost is a model that keeps saying *almost* the same long
thing — and a long answer is itself a symptom, because `loopInstructions` sets a
"Hard output budget: max 1,200 characters" that a fixated model is exactly the one
ignoring.

**Why it survived.** The 1,500 was written inline. `commitTurnMemory`'s own
comment says the bounds come from `PERSISTED_WINDOW` "so the in-memory window and
the one that survives a restart cannot drift apart", and lists three of them; the
fourth was a bare literal, so nothing on the reading side could know what it was.

**The fix.** The bound is named, and rule 5 cuts the current answer to it:

```js
  // loop-state.ts
  export const PERSISTED_WINDOW = { fingerprints: 8, snippets: 5, texts: 4,
                                    textChars: 1_500, toolResults: 10 } as const;

  // detectStuck
  const similarity = textSimilarity(
    lastAssistantText.slice(0, PERSISTED_WINDOW.textChars), previousText);
```

**The other direction was considered and rejected.** Storing the whole answer
also makes the units agree, and it is the smaller edit. It is unbounded: the
window is persisted into the session branch on every `persistState`, four entries
deep, and an unbounded entry is exactly the growth the handoff summary exists to
prevent. Cutting the comparison costs nothing that was ever measured — the first
1,500 characters of two answers are as good a similarity sample as the whole of
them, and it is the sample the persisted window can afford.

*Tests:* `turn-answer.test.ts`, second describe. Four cases, one of which fails
without the fix. The controls are the same rephrasing under the bound (unchanged
by the fix), two genuinely different long answers (which must stay quiet), and a
pin that `textChars` lives with the other bounds.

---

### W3 — `steer()` has three branches and only one grew the brief · **MEDIUM** · PROVEN · **FIXED**

**Where.** `AgentManager.steer()` at `agent-manager.ts:807`, against
`continueSettledAgent` at `:866`.

**What.** `record.execution.brief` is what the subagent layer checks work
against, and it has three readers: the judge, `buildRepairPrompt`, and
`buildAnchorMessage`. The fork already fixed one path and its comment is the whole
argument:

> `brief` was written once, at spawn, and never updated. So steering a settled
> agent … produced an answer to the STEER, judged against the ORIGINAL prompt.
> The judge said NOT_ADDRESSED, correctly, and the repair then told the child
> "This is the task, in full, as it was given to you: <the original>. Answer it
> now" — actively undoing the operator's instruction, and labelling the result
> `✎ repaired`, which reads as an improvement.

`steer()` reaches `continueSettledAgent` only when the record is **not** running.
Its two other branches — `session.steer(message)`, and the queue-until-the-session-
exists branch above it — never touched the field.

**Reachability.** Steering a running agent is the *advertised* affordance, not the
obscure one:

```
  conversation-viewer.ts:333   const steerVerb = this.isActive() ? "steer" : "continue";
  events.ts:111                (msg) => manager?.steer(record.id, msg)      the viewer
  menu-running-agents.ts:55    (msg) => manager?.steer(record.id, msg)      the menu
  menu-running-agents.ts:223   await getManager()!.steer(record.id, trimmed)
```

**Proved.** `k3` prints `steer()` out of the file, counts the branches that grow
the brief, and shows what each brief leaves the three readers:

```
   BEFORE — a running agent, steered
     brief the verifier checks against:
       "List every caller of tokenize() in src/, with file:line."
     what the repair tells the child:
       This is the task, in full, as it was given to you:
       ```
       List every caller of tokenize() in src/, with file:line.
       ```
       Answer it now. … Do not restate the task.
     what the anchor restates after a compaction:
       List every caller of tokenize() in src/, with file:line.

   NOW — the follow-up is in all three
       … Follow-up: Now also list the callers of lex(), same format.
```

**What it costs.** Three things, in escalating order of harm:

1. the judge checks a two-part answer against a one-part task and can correctly
   return NOT_ADDRESSED;
2. the repair then spends a model call, in the child's own session on the slot the
   parent is blocked on, telling the child to answer the *original* task and not
   to restate anything — undoing the operator's instruction;
3. and if the child compacts while running, the anchor restates the original task
   into the fresh context, which is the one moment the steer is most likely to be
   summarised away.

**The fix.** One helper, called from every branch that reaches the model:

```js
  private growBrief(record: AgentRecord, message: string): void {
    record.execution.brief = appendFollowUp(record.execution.brief, message);
  }
```

`continueSettledAgent` now goes through it too, so there is one call site to find.
On the live-session branch it is called **after** `await session.steer(message)`
resolves: a steer that threw never reached the model, and a brief that records an
instruction the model never saw is the same defect pointing the other way — the
judge would then fail an answer for not addressing something nobody asked.

*Tests:* `vendor/pi-subagents-lite/tests/steer-brief.test.ts`. Six cases, three of
which fail without the fix. `agent-manager.ts` imports pi and the suite cannot
load it, so the four structural cases are source pins (comments stripped first,
because the fix's own comment describes the defective form); the two behavioural
cases drive the real `appendFollowUp`, `buildRepairPrompt` and
`buildAnchorMessage`, and the second of those is the control that shows what the
defect handed all three readers.

---

### W4 — with no grace turns, a one-turn run that answered is reported `aborted` · **MEDIUM** · PROVEN · **FIXED**

**Where.** `wireTurnTracking` in `turn-tracking.ts:146`, against
`shouldSteerAtSoftLimit` on the line below it.

**What.** T1 established, and V6 restated, that a one-turn budget is a different
shape from a long one:

> Reaching a one-turn ceiling IS finishing, and the two readers of this flag both
> take it to mean the opposite.

V6 acted on that for `turnLimited`. The branch immediately above it did not:

```js
  if (!ceilingReached && turnCount >= maxTurns) {
    ceilingReached = true;
    if (graceTurns <= 0) {
      aborted = true;                       // ← for maxTurns === 1 too
      void session.abort().catch(() => {});
      return;
    }
    if (shouldSteerAtSoftLimit(maxTurns)) { turnLimited = true; session.steer(…); }
  }
```

and `aborted` is the *stronger* of the two labels: it outranks `turnLimited` in
`classifyRun`, its status note is "hit the turn limit before completion; output
may be incomplete" rather than "may be partial", and `structuralVerdict` refuses
to judge it for the same reason.

**Reachability.** `graceTurns: 0` is a supported operator setting —
`menu-spawn-options.ts` builds its input with `createNumericSubmenu(ctx, { min: 0,
default: DEFAULT_GRACE_TURNS }, …)` — and the comment beside the branch says so.
One-turn agents reach it through `max_turns:` in an agent `.md`, the `/agents`
spawn wizard's **Max turns** field, and `defaultMaxTurns` in the model-family
config.

**Proved.** `k4`, through the real `wireTurnTracking`, the real
`structuralVerdict` and the shipped `STATUS_NOTES`:

```
  grace  turns  wrap-up asked?  status      what the PARENT reads          verified?
  ─────────────────────────────────────────────────────────────────────────────────
  BEFORE
    6      1      no            completed   "src/parser.t…"                yes
    0      1      no            aborted     "…" (hit the turn limit        NO (cutoff)
                                             before completion; output
                                             may be incomplete)
  NOW
    6      1      no            completed   "src/parser.t…"                yes
    0      1      no            completed   "src/parser.t…"                yes
```

**What it costs.** Exactly what V6 costed, restored by a setting: for a
deliberately one-turn agent — a classifier, a summariser, an answer-from-what-you-
know helper, which is what a one-turn budget is *for* — every answer arrives
labelled possibly-incomplete and with verification silently switched off. Since
the setting is global (`store.agent.graceTurns`), one operator change puts an
entire class of agent permanently in that bucket.

**The fix.** The sever is gated on the same predicate V6 used:

```js
      if (graceTurns <= 0) {
        if (shouldSteerAtSoftLimit(maxTurns)) {
          aborted = true;
          void session.abort().catch(() => {});
        }
        return;
      }
```

**Nothing loses its ceiling**, and that is the load-bearing part.
`ceilingReached` is still set on that turn, so the `else if
(ceilingReached && turnCount >= maxTurns + graceTurns)` below fires on the very
next `turn_end` — at `maxTurns + 0` — and reports `aborted`, which is then true.
A one-turn run that keeps calling tools is bounded at turn 2 rather than turn 1,
and a one-turn run that finished is bounded by having finished.

*Tests:* `turn-tracking.test.ts`, a new describe. Three cases, two of which fail
without the fix; the control is a longer budget with no grace, which must keep
severing at its ceiling, and the second case pins that a one-turn run that keeps
going is still severed on its next turn.

---

### W5 — three of the verifier's notes build their own counts · **LOW** · PROVEN · **FIXED**

**Where.** `verificationNote` in `verify.ts:468`, and its `unparsed` call site in
`verify-runner.ts:259`.

**What.** These notes are the verifier's only channel to the parent model. Two of
the five built an ordinal by hand and one dropped a fact:

```js
  case "repaired":
    return attempts <= 1
      ? "…this is the corrected one, and it was re-checked.]"
      : `…this is the ${attempts}th attempt, and it was re-checked.]`;
```

`${attempts}th` is correct from four upwards. `MAX_VERIFY_ROUNDS` is **3**, so
every value that branch can be handed reads wrong: "the 2th attempt", "the 3th
attempt".

```js
  case "stalled":
    return "…the agent repeated itself when asked again, so it was not asked a third time.…";
```

That counts *asks*, not attempts: the task is the first ask and each repair is one
more, so the ask not made is `attempts + 2`. At the default budget of one round it
is the third — which is why a hardcoded "third" was invisible — and it is wrong at
every larger budget.

```js
  if (verdict.unparsed) return { answer: candidate + verificationNote("unparsed"), … };
```

`candidate` is the *repaired* text from the second round on, so the parent is
handed a corrected answer under a note that mentions only the unreadable check,
with no record that the original failed — the one fact a `repaired` note exists to
carry. And `verificationNote`'s `attempts` defaulted to **1**, i.e. to asserting a
repair that may not have happened.

**Reachability.** `SUBAGENT_VERIFY_ROUNDS=2` or `3`; `resolveVerifyRounds` clamps
to `[0, 3]`, so both are ordinary configurations.

**Proved.** `k5` prints every note at every budget the round loop can reach.

**What it costs.** Small per occurrence and not silent — but this file already
argues that the wording is not decoration, on the line above the function W5 is
about:

> English for a small count, so the note reads like a sentence rather than a log
> line. The parent model reads this text, and "1 attempts" is the kind of thing it
> copies into its own answer.

**The fix.** One `describeOrdinal` helper, used by both counting notes; `unparsed`
takes `attempts` and names the failed first answer when there was one; and the
parameter defaults to `0` — no repair — rather than to claiming one.

*Tests:* `verify.test.ts`, four new cases, all four failing without the fix.
`verify-runner.test.ts`'s existing "counts the attempts it actually spent" case
was pinning `/2th attempt/` and now pins `/second attempt/` plus
`assert.doesNotMatch(out.answer, /\dth attempt/)`.

---

### W6 — V7's capture rests on an ordering the code did not have · **LOW** · PROVEN·SOURCE · **FIXED**

**Where.** `createAndConfigureSession` in `agent-runner.ts:579`, against the
comment in `agent-manager.ts:365` and §5.3 of the sixth-pass document.

**What.** V7 moved the judge's session capture off `result?.session` — correct,
because `result` is only assigned when the await resolves — and into
`onSessionCreated`. Both the code comment and the write-up say what that buys:

> every rejection after `createAgentSession()` had returned (**bindExtensions
> throwing**, session.prompt() rejecting on a provider fault) dropped the only
> reference to a live session … That is exactly the leak the paragraph above is
> about, on the one exit it did not cover.

> `onSessionCreated` fires inside `createAndConfigureSession`, **before
> `bindExtensions` returns**, so it covers every failure the old form missed.

It did not. It was the last line of the function:

```
   agent-runner.ts:590   initSession(...)   — the session now EXISTS
   agent-runner.ts:592   session.setSessionName(...)
   agent-runner.ts:593   await session.bindExtensions({ … })
   agent-runner.ts:601   resolveVisibleTools(...)
   agent-runner.ts:608   session.setActiveToolsByName(...)
   agent-runner.ts:609   options.onSessionCreated?.(session)      <- the capture
```

So the `session.prompt()` half of the claim was real — and it is the common case,
which is why V7 was worth doing — and the `bindExtensions` half was not.

**Proved.** `k6` prints the function out of the file, the line numbers in order,
and replays the three ways a spawn can end under both placements:

```
   BEFORE — the capture sat below the bind:
     judge answered                      sessions disposed = 1
     session.prompt() rejected           sessions disposed = 1
     bindExtensions rejected             sessions disposed = 0   <-- LEAKED

   NOW — the capture sits above it:
     all three                           sessions disposed = 1
```

**What it costs.** Narrow, and this finding is honest about that: pi's
`ExtensionRunner.emit()` catches a handler throw (`runner.js:596`), so
`bindExtensions` rejects only through `extendResourcesFromExtensions`,
`_applyExtensionBindings`, or the `_rebuildSystemPrompt` inside
`setActiveToolsByName` — which was also below the old capture. The leak is one
`AgentSession` with its history and bound extensions per occurrence.

It is not only the judge. On the spawn path the same callback is what assigns
`record.execution.session`, so a throw in that window left the record without a
session too — and `dispose()` and `removeRecord()` dispose
`record.execution.session`, which was still `undefined`.

**Why V7's own test could not catch it.** It is a source pin, and it asserts that
the capture is *present*:

```js
  assert.match(code, /onSessionCreated:\s*\(session\)\s*=>\s*\{\s*judgeSession = session;/);
```

A pin on the existence of a line cannot see where the line is, and the fact it
depends on lives in a different file.

**The fix.** The hand-over is the line after `initSession`, which is what the
comment always claimed. Nothing downstream of the callback reads the session's
tools or name; the manager's callback assigns the record's session, flushes
`pendingSteers` (which queue, and are drained by the run that follows), and
attaches the output log — attaching it earlier only means it captures more.

*Test:* a new source pin in `turn-tracking.test.ts`, on `agent-runner.ts` this
time, asserting the **order** rather than the presence:

```js
  assert.ok(capture > created, "nothing can be handed over before the session exists");
  assert.ok(capture < bind,    "…");
  assert.ok(capture < filter,  "…");
```

One case, and it fails without the fix.

---

## 7. Smaller things, and things that are not findings

Recorded so the next pass does not re-derive them. None is proposed for a change;
each carries the reason. The first seven are new this pass.

- **`interveneStuck`'s compaction rung is not wrapped in a try.**
  `requestEmergencyCompaction` is, and its comment says why — "a `ctx.compact()`
  that throws synchronously would leave them set for the rest of the session". The
  stuck rung has no flags to leave set, but it has a worse failure: `agent_end`
  has already called `clearPendingTimer()` and the intervention has already been
  charged, so a synchronous throw propagates out of the awaited `interveneStuck`
  and the loop silently stops advancing with `status: "stuck"` and no timer.
  Nothing has been observed throwing. SOURCE.
- **V4's queued directive gives up the loop's own timer entirely.** With a message
  pending the strategy is queued with `deliverAs: "nextTurn"` and nothing is
  scheduled — deliberately, because the pending message will trigger the turn. If
  that turn never happens (the operator aborts, the message is dropped), the loop
  is left with `status: "stuck"`, no timer and a directive in
  `_pendingNextTurnMessages`. `scheduleWatchdogTurn` exists for exactly this shape
  ("a watchdog for work another component promised to do") and is not used here.
  Strictly better than the pre-V4 behaviour, which sent nothing at all. SOURCE.
- **`degenerateAbortPending` is cleared on one of `agent_end`'s exits.** It is set
  by `message_update`'s mid-stream kill switch and consumed in the
  `aborted && degenerateAbortPending` branch. If the abort lands on a turn whose
  final message reports `error` — or on no assistant message at all — the flag
  survives, and the operator's next Esc is then read as a degenerate abort and
  answered with a stuck intervention instead of "Loop paused (turn aborted)".
  `/loop stop`, `/loop end`, `runLoop` and `finalizeSoftStop` all clear it, so it
  cannot persist across a restart. SOURCE.
- **`saturatedManualCompaction` keys on `state.description`, not on
  `state.active`.** So `/compact` at ≥85% in a session whose loop has been stopped
  but not cleared replaces pi's model-written summary with the loop's emergency
  one, built from stale state — including a Next Step block telling the model to
  "perform exactly one concrete next progress batch". Arguably intended (the goal
  is still the session's goal); recorded because the two neighbouring predicates
  use `loopOwnsThisSession` and this one does not. SOURCE.
- **`buildVerifyDeps` reads `SUBAGENT_VERIFY` at spawn time** while
  `runVerification` reads `SUBAGENT_VERIFY_ROUNDS` and
  `SUBAGENT_VERIFY_TIMEOUT_MS` per call, with a comment explaining that an
  operator should not have to reason about when a value was captured. Three
  switches, two policies. SOURCE.
- **The repair runs with the watchdog's state already deleted.**
  `Watchdog.check()` drops the state of any record whose status is not `running`,
  and verification runs after the status has gone terminal — so the repair's tool
  calls feed a `touch()` that returns `undefined`. Bounded by the 300 s deadline
  instead, which is T5's territory. SOURCE.
- **`prinny-channel` has W1's shape too, and the fix there is not the same one.**
  `describeEmptyEnding` scans back to the first assistant message it finds and
  returns on it, so a turn that answered and then produced a trailing
  reasoning-only message reads as `produced-no-answer` — and `finalAssistantText`
  returns `''`, so nothing is sent to Matrix and the sender is told the model
  generated tokens that were not an answer. It is the same two-message turn W1 is
  about, in a third consumer of the same shape.
  **Not fixed here, deliberately.** Stopping at an empty final turn was paid for
  by a real incident and the source says so — a 17,790-character tool result
  filled the window, the model returned `content: []`, and walking further back
  delivered mid-investigation deliberation to somebody's phone as the answer. The
  loop could fix its version with a per-turn buffer because it owns `message_end`;
  `forwarding.ts` is handed a message list with no turn boundaries in it, so the
  equivalent repair needs a turn marker it does not currently have, and the
  trade-off between "send a stale answer" and "send nothing" is a Matrix-side
  call. Recorded so it is a decision rather than an oversight. SOURCE.
- **`exclude_tools` is U6's sibling, one field over.** `tools` now goes through
  `parseExtensions`; `exclude_tools` still goes through `parseStringArray`, so
  `exclude_tools: all` becomes the one-element denylist `["all"]`. Both readings
  are "exclude nothing". Carried forward.
- **`hasStateChange()` matches its keyword list against any tool output**, so
  reading a file containing "successfully" postpones the no-progress audit; and it
  writes `state.iterationCount + 1` from `tool_result`, which can fire on a turn
  that never reaches the success path. Carried forward.
- **A provider-error streak has no terminal state**, while the context ladder
  escalates to `pauseForContextFailure`. The asymmetry is defensible for an
  unattended run and is not written down anywhere else. Carried forward.
- **`consecutiveErrorCount` is shared between context pressure and provider
  errors**, and `backoffSeconds()` reads it. Carried forward.
- **`getFinalModelError()` returns undefined for `stopReason: "error"` with an
  empty `errorMessage`**, so the run classifies as `completed` and the parent is
  handed whatever text arrived. One `??` away from impossible. Carried forward.
- **The `Agent` tool's `execute` reads `params.max_turns`, which its schema does
  not declare and nothing injects.** Dead, and load-bearing in the negative sense
  for W4's reachability argument: the *model* cannot set `max_turns: 1`, only an
  operator or an agent file can. Carried forward.
- **`__verifier` is hidden from the `Agent` tool's type list but not from
  `resolveType`.** Harmless. Carried forward.
- **`SlotTable.setLimits()` reads `config.default` with no fallback**, and
  `Math.max(1, undefined)` is `NaN`, which reads as unlimited. Every real caller
  passes a merged config. Carried forward.
- **`record.stats.turnCount` is initialised to 1 at spawn**, before any turn has
  run. Cosmetic. Carried forward.
- **A background subagent result delivered while a loop is running triggers a turn
  the loop counts as an iteration.** Carried forward — and now also the mechanism
  behind W1.
- **The spawn bracket is still a process-global counter**, narrowed to extension
  loading and binding. Carried forward.
- **`AgentStatus` lists every agent ever spawned this session**, unbounded.
  Carried forward.

---

## 8. What was re-verified this pass, and holds

Read out of the tree, not assumed.

- **All eight sixth-pass fixes are in place**, and all eight `j` probes still run
  clean. `emptyResponse` no longer counts thinking as an answer; `detectStuck`
  compares the committed string; `resetCheckState` covers the whole of the check's
  state; the stuck directive is queued rather than dropped; the repair's status
  crosses back; `turnLimited` follows the steer; the judge's session is captured
  at creation; `goalFile` is preserved with `preparedAt`.
- **All nine fifth-pass and all ten fourth-pass fixes are in place**, and `h1`–`h6`,
  `i1`–`i9`, `g1`–`g3` and `verify-prior-fixes` still run clean.
- **`runLoop()` now accounts for every one of `LoopState`'s forty-five fields.**
  Counted field by field against `defaultState()`: **eleven** are configuration
  and must survive (`description`, `completionCriteria`, `maxIterations`,
  `untilDone`, `delaySeconds`, `checkCommand`, `checkTimeoutSeconds`, `goalFile`,
  `loopModel`, `rescueModel`, `preparedAt`) and the other **thirty-four** are
  reset — twenty inline, eight by `resetCheckState()`, three context counters,
  plus `status`, `lastNotice` and `softStopRequested`. V3's repair, complete.
- **The two `-context-budget` injectors still do not double up**, in either
  registration order: `pi-loop-mode` tests `/-context-budget$/` and
  `compaction-guard` exports `ANY_BUDGET_TYPE` with the same suffix.
- **The verification note survives the background result cap.** `planOutputCap`
  keeps a head and a tail (`HEAD_SHARE` 0.7), and the note is at the end of
  `record.result` — at the 1,500-char floor the tail budget is ~390 characters
  against a ~230-character `failed` note. Checked because a cap that kept only the
  head would have silently removed the "treat it as unreliable" line from exactly
  the answers that need it.
- **pi's thinking block really is `{type:"thinking", thinking}`**, from
  `pi-ai/dist/types.d.ts:233`. `requiresThinkingAsText` exists but is applied on
  the *request* path (`openai-completions.js:901`), so it cannot turn a stored
  thinking block into text — which is what V1 and V2, and now W1, all depend on.
- **The slot is still held across verification**, and `recount()` still keys on
  `holdsSlot`.
- **The loop is inert in a child**, by three independent stops, and
  `pi-subagents-lite` is inert in a child by its factory guard, so a child cannot
  spawn a grandchild.
- **`verifyAnswer` still never throws** — its prologue is inside its own try, and
  `runVerification` catches anything the prologue could still raise.

---

## 9. What shipped

Every fix carries a regression test that fails when the fix is removed; where a
case passes either way it is a control and is labelled as one.

| # | Fixed by | Where | Tests | Fail without it |
| --- | --- | --- | --- | --- |
| W1 | `message_end` buffers the turn's answers separately; `agent_end` reads `turnAnswerText`, falling back to the old value | `pi-loop-mode/extensions/index.ts` | `turn-answer.test.ts` ×6 | 2 |
| W2 | `PERSISTED_WINDOW.textChars`, and rule 5 cuts the current answer to it | `src/loop-state.ts`, `extensions/index.ts` | `turn-answer.test.ts` ×4 | 1 |
| W3 | `growBrief()`, called from every branch of `steer()` that reaches the model | `pi-subagents-lite/src/agents/agent-manager.ts` | `steer-brief.test.ts` ×6 | 3 |
| W4 | the `graceTurns <= 0` sever is gated on `shouldSteerAtSoftLimit(maxTurns)` | `src/agents/turn-tracking.ts` | `turn-tracking.test.ts` ×3 | 2 |
| W5 | one `describeOrdinal`; `unparsed` takes `attempts`; the default is 0 | `src/agents/verify.ts`, `verify-runner.ts` | `verify.test.ts` ×4 | 4 |
| W6 | the capture is the line after `initSession` | `src/agents/agent-runner.ts` | `turn-tracking.test.ts` ×1 (order pin) | 1 |

### The gates

```
                                    before    after
vendor/pi-subagents-lite   tests    193       207     lint 71/71 files
vendor/pi-loop-mode        tests    127       137
.pi/extensions/compaction-guard      39        39     (untouched)
                                   ─────     ─────
                                    359       383
```

All thirty-three probes run clean — `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`,
`i1`–`i9`, `j1`–`j8` and `k1`–`k6` — and the six `k` probes print BEFORE and NOW,
so each is its own control.

### Four things worth keeping from how these went

- **The smaller edit for W2 was the wrong one, for the opposite reason V2's was.**
  Storing the whole answer also makes the units agree and is one line; it makes a
  persisted window unbounded. V2 rejected the smaller edit because it *lost*
  detection; W2 rejected it because it *costs* something the window cannot afford.
  Both times the question was which of the two things being reconciled is the one
  that has a reason to be the size it is.
- **The fallback is what made W1 safe to ship.** `turnAnswerText` falls back to
  `lastAssistantText` when the buffer is empty, so every path where the buffer
  cannot be trusted — a turn that errored, a loop that became active mid-turn —
  behaves exactly as before. A fix to a reader should only ever change the case it
  was written for, and here that is checkable by inspection.
- **A control has to be able to fail, and W1's needed two directions.** The
  answered-nothing turn (V1's case) pins that the fix did not simply make
  `emptyResponse` harder to satisfy; the marker-inside-thinking case pins that it
  did not make `LOOP_DONE` easier to satisfy. Without the second, moving the
  markers onto a text-or-thinking string would have passed.
- **W6's test is the shape the pass argues for.** V7's pin asserted a line was
  present; the fact it depended on lived in another file and nobody pinned it. The
  new pin asserts the *order*, in that other file. When a fix rests on a claim
  about somewhere else, the assertion belongs where the claim is.

---

## 10. Running the evidence

```sh
cd ~/qwen3.8-forge

# the gates
( cd vendor/pi-subagents-lite && npm test && node tests/lint.mjs )   # 207 + 71/71
( cd vendor/pi-loop-mode       && npm test )                         # 137
( cd .pi/extensions/compaction-guard && npm test )                   #  39

# just this pass's regression tests
( cd vendor/pi-loop-mode && node --experimental-strip-types --test tests/turn-answer.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/steer-brief.test.ts tests/turn-tracking.test.ts tests/verify.test.ts )

# this pass's probes  (the loop's state is module-global — one mode per process)
P=context/testing/probes
node --experimental-strip-types $P/k1-the-turns-answer-read-three-ways.mjs low
node --experimental-strip-types $P/k1-the-turns-answer-read-three-ways.mjs saturated
node --experimental-strip-types $P/k2-near-duplicate-rule-vs-stored-window.mjs short
node --experimental-strip-types $P/k2-near-duplicate-rule-vs-stored-window.mjs long
node --experimental-strip-types $P/k3-steering-a-running-agent-does-not-grow-the-brief.mjs
node --experimental-strip-types $P/k4-grace-zero-reports-a-finished-run-as-aborted.mjs
node --experimental-strip-types $P/k5-verification-notes-the-parent-reads.mjs
node                            $P/k6-onsessioncreated-fires-after-bindextensions.mjs
```

| probe | what it showed | the control |
| --- | --- | --- |
| `k1` | `low` — the marker unseen, the run not completed; `saturated` — the same turn read as starved | the one-message turn, the answered-nothing turn, and a marker inside thinking |
| `k2` | `long` — four rephrased turns, `Interventions: 0` | `short` — the same rephrasing under the bound, caught on turn 2 throughout |
| `k3` | the running branch's brief, and what it hands the judge, the repair and the anchor | the settled branch, which has been right since the fork |
| `k4` | `grace 0, maxTurns 1` — `aborted`, unchecked | six rows where the label was already right, including grace 0 at maxTurns 3 |
| `k5` | "the 2th attempt", a hardcoded "third time", an `unparsed` note over a repair | the `failed` note, which has used `describeAttempts` throughout |
| `k6` | the capture below the bind, and the exit that leaked | the two exits that were already covered |

---

## 11. Still unwatched

Unchanged from the sixth pass, and now longer by one. Six defects were fixed this
pass against probes and tests, and none against a running model — which is the
twenty-third in a row.

1. **A real verification.** Still the highest-value unwatched thing. One
   foreground delegation with `SUBAGENT_VERIFY_ROUNDS=1` and a deliberately
   off-task brief now exercises a judge whose verdict parser (S2) and reason
   parser (U4) have both been repaired, a repair whose outcome crosses back (V5),
   a turn counter that no longer accumulates (U8), a session that no longer leaks
   when the provider drops the call (V7, W6), and the note the parent reads (W5).
   Six fixed defects on one code path, none of them watched.
2. **The judge's raw reply is still not logged.** Top of the list since the fourth
   pass. Load-bearing for S2, U4, V5 and now W5 — "was the text the judge passed
   actually a whole answer, and did the note the parent got describe it?"
3. **A delegation with a loop running.** Fixed at the module level three times now
   — the loop's factory guard, V4, and W1 — and never watched. W1 makes it the
   most informative it has been: the mid-turn steer that produces a two-message
   turn is a *background subagent's result*, so this one run exercises V4 and W1
   on the same turn.
4. **A reasoning-only turn, in the wild, with the loop running.** The forge patch
   has been in the image since 2026-08-17. `j1`, `j2` and now `k1` say what the
   module does with the shape; only a run says how often it arrives.
5. **Section I of `context/testing/subagents-loop-verifier.md`**, still never run,
   now seven passes old.
6. **An operator steer to a RUNNING subagent**, which is W3's path and has never
   been exercised end to end — the brief, the judge's verdict against it, and the
   anchor after a compaction.
7. **Still open by decision, unchanged:** T5 (verification bounded at 300 s but
   uninterruptible), T6 (`worktree_path` reach), T1's general case, per-session
   loop state, U9 (`Explore` has no shell).
8. **A child that fills its own 32k and compacts**, so the anchor can be watched
   landing; the 40-turn ceiling against a real model; `stats.verifyUsage` and the
   300 s deadline against a real model.

---

## 12. The pattern across seven audits

```
   inside a module            B1–B8    a function does not do what it says
   between two modules        F1–F11   two correct functions disagree at the seam
   module ↔ pi's runtime      T1–T9    correct code, wrong assumption about the host
   declaration ↔ code         S1–S10   the artefact a reader checks is not what runs
   unit ↔ unit                U1–U9    the rule and the thing it governs are each
                                       right, and are counted in different things
   whole ↔ part               V1–V8    a reader takes a subset that used to be the
                                       whole thing
   fix ↔ its siblings         W1–W6    the rule was established and applied to the
                                       instance in front of it; the sites next to
                                       it kept the old behaviour
```

Three habits fall out of the seventh, and they are the transferable part.

**When a pass fixes a reader, grep for the other readers of the same fact — in the
same function first.** W1 and W4 are both one screen away from the fix that
established their rule. V2 changed `detectStuck`'s argument and left two regex
tests four hundred lines below reading the old variable; V6 changed a flag and
left the branch three lines above it. Neither needed a new insight, only the
question "what else reads this?" asked once more before closing the pass. The
mechanical version is cheap: after a fix, grep the identifier the fix *replaced*
and read every remaining hit.

**A fix that rests on a fact in another file has to pin that fact in the other
file.** W6 is the whole argument. V7's reasoning was correct, its code was
correct, and its regression test asserted the wrong half — the presence of a line,
in the file the line is in, when the load-bearing claim was about ordering in a
file the test never opened. A source pin is a good tool and it points at whatever
you point it at.

**"Both branches" is a coverage question, and the branch that got the fix is
usually the one that was in front of you.** W3 and W4 are the same shape: a method
with a running case and a settled case, a ceiling with a grace case and a
no-grace case. In both, the fixed branch is the one the failing report came from,
and the other one is reachable through a supported setting or an advertised UI
affordance. The test that would have caught either is not clever; it is the same
assertion, run against the other branch.

---

## 13. Where to look

- `context/testing/probes/k1`–`k6` — the reproductions, one per finding, each
  printing BEFORE and NOW.
- The regression tests: `vendor/pi-loop-mode/tests/turn-answer.test.ts` (W1, W2);
  `vendor/pi-subagents-lite/tests/steer-brief.test.ts` (W3),
  `turn-tracking.test.ts` (W4, W6) and `verify.test.ts` (W5).
- `context/design/subagents-loop-verifier-shapes.md` — the sixth pass (V1–V8, all
  fixed). Its §2 drawing is what W1 extends, and its §4.3 turn-ceiling table is
  what W4 completes.
- `context/design/subagents-loop-verifier-units.md` — the fifth pass (U1–U9). Its
  §9 reference sections — the record's life, concurrency, the turn ceiling, the
  context ladder, the handoff summary, the compaction guard, what it costs on the
  wire — are the detail neither this document nor the sixth-pass one restates.
- `context/design/subagents-loop-verifier-surfaces.md` — the fourth pass (S1–S10).
- `context/design/subagents-loop-verifier-mechanics.md` — the third pass (T1–T9),
  still the best account of pi's own agent loop. T1 is load-bearing for W4.
- `context/design/subagents-loop-verifier-evaluation.md` — the second audit
  (F1–F11); `…-anatomy.md` — the first, and the design rationale.
- `patches/forge_reasoning_passthrough.py` and commit `e81a7e5` — the wire change
  V1, V2 and W1 are all downstream of.
- `vendor/pi-subagents-lite/src/spawn/spawn-coordinator.ts`,
  `emitIndividualNudge` — the `deliverAs: "steer", triggerTurn: true` that makes
  W1's two-message turn an ordinary event rather than a hypothetical.
