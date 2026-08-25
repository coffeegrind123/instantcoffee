# Subagents, the loop, and the verifier — the turn as a unit, and the harness that could not see it

Eighth pass, 2026-08-18. A full read of the three components and the seams
between them, with **six findings (X1–X5, Y1) — all six fixed**, each with an
executable probe that prints BEFORE and NOW, and each with a regression test that
fails when the fix is removed.

**383 tests, lint 71/71 and thirty-three probes caught none of the six.** The
suite is now **404**, lint is 73/73, and there are thirty-nine probes. §9 has what
shipped and the control-run failing count for each fix.

One of the six — **X5** — was invisible for a stronger reason than the rest, and
it is the transferable finding of this pass: **the probe harness did not replay
something pi does, and the thing it did not replay was the thing under test.**
`_host.mjs` ignored what a `message_end` handler returned; pi writes it over the
message `agent_end` later reads. A whole rule of `detectStuck` had been dead in
every real session since the fork, and four passes of probes "proved" it working
against text that no longer existed by the time the rule looked.

---

## 0. How this sits next to the other seven documents

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
| seventh | `…-readers.md` (W1–W6) | between the site a rule was fixed at and its siblings |

This one found an eighth, and it is the first that is **about the evidence rather
than the code**: *between what the host does and what the harness that stands in
for it does.* Five of the six are still seventh-pass shape — siblings of W1, one
screen away — and the sixth is the reason none of them could have been found by
running the probes harder.

```
   W1  "the completion markers must read the TURN's answer, not the last message"
         ↳ fixed emptyResponse, LOOP_DONE, LOOP_BLOCKED.
           commitTurnMemory — the window the stuck rules compare — still took
           the last non-empty MESSAGE, so a trailing thought became
           "the turn's final answer".                                     X1

         ↳ detectStuck's degenerate rule still took the last MESSAGE, so an
           answer that degenerated and was followed by one more message was
           scanned by nobody.                                             X2

         ↳ GOAL_READY still took the last message — the one reader W1 could
           not move, because message_end was gated on state.active and
           /loop prepare runs with it false.                              X3

   T2  "the per-turn tool counter must not outlive its turn"
         ↳ fixed the reset in agent_end, above every early return IN THAT
           HANDLER. /loop stop makes agent_end return at its first line.   X4

   —   the probe harness ignored a message_end handler's return value.
       pi writes it over the object agent_end reads. detectStuck's rule 1
       had therefore never been reachable in a real session, and the
       probes could not show it.                                          X5

   fork "a verifying record is active work: the widget keeps its row running"
         ↳ /agents had its own isActive(), status-only, so the same record
           was listed as finished with a ✓ and Clear was the only action
           offered for it.                                                Y1
```

Read the other seven documents for evidence, not orientation. Nothing they fixed
has come undone: all thirty-three prior fixes are in the tree and their probes
still run clean.

---

## 1. The whole machine, and where these six live

```
 ┌──────────────┐   ┌───────────────────────────────────┐   ┌────────────────┐
 │  llama.cpp   │──▶│ forge — the OpenAI-compatible      │──▶│      pi        │
 │  ONE slot    │   │ proxy on :8081                     │   │                │
 │  PARALLEL_   │   │ patches/forge_reasoning_           │   │ maps           │
 │  SLOTS=1     │   │   passthrough.py  (e81a7e5)        │   │ reasoning_     │
 └──────────────┘   │ emits reasoning_content alongside  │   │ content onto a │
                    │ content, and a truthful            │   │ THINKING block │
                    │ finish_reason                      │   │ {type,thinking}│
                    └───────────────────────────────────┘   └───────┬────────┘
                                                                    │
   ┌────────────────────────────────────────────────────────────────▼───────┐
   │ ONE assistant MESSAGE                                                   │
   │ { role:"assistant",                                                     │
   │   content:[ {type:"text",text} | {type:"thinking",thinking}             │
   │           | {type:"toolCall",…} ],                                      │
   │   stopReason:"stop"|"length"|"error"|"aborted", errorMessage?,          │
   │   usage:{output} }                                                      │
   └───────┬─────────────────────────────────────────────────────────────────┘
           │
           │  …and pi lets an extension REWRITE it, in place:
           │
           │    ExtensionRunner.emitMessageEnd  runner.js:610
           │      threads each handler's returned message into the next
           │    AgentSession._emitExtensionEvent  agent-session.js:481
           │      _replaceMessageInPlace(event.message, normalized)
           │    AgentSession._replaceMessageInPlace  agent-session.js:425
           │      delete every key of the object agent-core holds, then
           │      Object.assign the replacement over it
           │
           │  "Mutating this object in place keeps agent state, LATER TURN/AGENT
           │   EVENTS, listeners, and the eventual appendMessage persistence in
           │   sync."  ← pi's own comment. agent_end is a later agent event, and
           │             its `messages` are those same objects.        ← X5
           ▼
  ┌─────────────────┐   ┌────────────────────┐   ┌──────────────────────────┐
  │ prinny-channel  │   │ pi-loop-mode       │   │ pi-subagents-lite        │
  │ "said nothing"  │   │ THREE per-turn     │   │ extractText() /          │
  │  = no text and  │   │ buffers, drained   │   │ getLastAssistantText     │
  │    no toolCall  │   │ in agent_end       │   │  walks BACK to text —    │
  │  (W1's shape,   │   │  ← X1 X2 X3 X4     │   │  correct by construction │
  │   left as a     │   └────────────────────┘   └──────────────────────────┘
  │   decision)     │
  └─────────────────┘

                        …and a TURN is not a message:

   pi emits, for ONE turn (agent-loop.js — while (hasMoreToolCalls ||
                                                  pendingMessages.length > 0))

     message_start ─┐
     message_end    │  msg A  [ text "LOOP_DONE: the feature is shipped." ]
                   ─┘         ↑ a handler may REPLACE this object here   X5
        ╌╌╌╌╌╌╌╌╌╌╌╌ a background subagent settles; SpawnCoordinator
                      .emitIndividualNudge sends its result with
                      deliverAs:"steer", triggerTurn:true — the parent is
                      busy, so it lands INSIDE this turn ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
     message_start ─┐
     message_end    │  msg B  [ thinking "…already said so, nothing to do" ]
     turn_end       │
     agent_end     ─┘

                        event.messages = [ …, A, B ]  — the same objects
                        lastAssistant  = B
                        the turn's ANSWER = A
```

Below the message, the rest of the machine:

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
   │                   turnAssistantTexts · turnAnswerTexts                   │
   │                   turnRepetitionTexts · turnToolCalls          ← X1 X2   │
   │     pi-subagents  shell{pi,sessionCtx,manager,widget,store,coordinator}  │
   │     shell.ts      __PI_SUBAGENT_SPAWN_DEPTH__ on globalThis              │
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent tool call
   ┌──────────────▼────────┐    ┌─────────────────────────────────────────────┐
   │ SpawnCoordinator      │───▶│ AgentManager                                │
   │  live view · spawnCtx │    │  SlotTable (default 1) · queue              │
   │  awaits the gate (fg) │    │  Watchdog 45 min tool/idle                  │
   │  nudges (bg)          │    │  completion gate per record                 │
   └───────────────────────┘    │  steer() ─ running ─▶ session.steer         │
                                │           └ settled ▶ continueSettledAgent  │
                                │  clear()  ─▶ removeRecord            ← Y1   │
                                └────────────────┬────────────────────────────┘
                                                 │ runAgent()
                   ┌─────────────────────────────┴───────────────────┐
                   │ enterSubagentSpawn()   ← depth > 0 ONLY here    │
                   │   reloadAndMap()    → every extension factory   │
                   │   createAgentSession()                          │
                   │   onSessionCreated  ← the capture (W6)          │
                   │   bindExtensions()  → handlers, session_start   │
                   │ exitSubagentSpawn()                             │
                   └─────────────────────────────┬───────────────────┘
                                                 ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, in-memory SessionManager         │
   │    own system prompt · own tools · own window · own event bus            │
   │    ceiling maxTurns → wrap-up steer → hard abort graceTurns later        │
   └──────────────────────┬───────────────────────────────────────────────────┘
                          │ settles — status TERMINAL, SLOT STILL HELD
                          ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                       │
   │    structural gate (free) → judge (fresh __verifier session, 1 turn)     │
   │    → repair (the child's own session, 1 turn) → judge again → …          │
   │    → verificationNote(kind, attempts) — the parent's only view of it     │
   │                                                                          │
   │    throughout: status reads `completed`, completedAt is UNSET, and       │
   │    verifyPhase is the only field that says a model call is in flight ← Y1│
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

## 2. The loop (`vendor/pi-loop-mode`)

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool. Its whole job is deciding what a turn's outcome *was*.

### 2.1 The thirteen handlers

```
  session_before_compact  replace pi's model-written summary with a locally built
                          handoff on a small window, or with an emergency summary
                          during recovery
  session_compact         adopt a compaction pi did itself
  session_start           restore state from the branch; auto-resume after restart
                          ── drops the turn buffers AFTER the restore       [X4]
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
  message_end             sanitize; buffer the message THREE ways      [X1 X2 X3]
  agent_end               THE LADDER — §2.4
```

### 2.2 One turn, read nine ways

This is the drawing the pass exists for. **One turn, two messages, and what each
consumer takes out of it** — with the two columns that were wrong.

```
   msg A  [ {type:"text", text:"LOOP_DONE: the feature is shipped."} ]
   msg B  [ {type:"thinking", thinking:"…already said so, nothing to do"} ]
   toolCallsThisTurn = 0

   ──────────────────────────────────────────────────────────────────────────────
   reader                        derives from                    was      is
   ──────────────────────────────────────────────────────────────────────────────
   message_end                   messageToText(m)
     ↳ turnAssistantTexts          || messageToRepetitionText(m)  A,B      A,B
       (the repetition WINDOW's     SANITIZED message
        feed — one entry/turn)

   message_end                   messageToText(m)                 A        A
     ↳ turnAnswerTexts             text only, SANITIZED           [W1]
       (did the turn ANSWER)

   message_end                   messageToRepetitionText(m)       —        A,B
     ↳ turnRepetitionTexts         text AND thinking, ORIGINAL           ← NEW
       (what the model produced)                                       [X2][X5]

   agent_end  committedText      commitTurnMemory(texts,calls,     B  ✗    A  ✓
     ↳ detectStuck rules 3–8       answers)                       [X1]
       and the WINDOWS              last ANSWER, else last tracked

   agent_end  turnAnswerText     last of turnAnswerTexts           A       A
     ↳ emptyResponse                ?? messageToText(last)         [W1]
     ↳ /LOOP_DONE:/ /LOOP_BLOCKED:/

   agent_end  turnEmittedTexts   turnRepetitionTexts               B  ✗   A,B ✓
     ↳ detectStuck rule 1           ?? [messageToRepetitionText     [X2]
       (degenerate repetition)        (last)]                      [X5]
     ↳ reasoningOnlyResponse,
       and its char count

   agent_end  lastAssistantText  messageToText(lastAssistant)      ""      ""
     ↳ the model-error reason line   the LAST MESSAGE only
     ↳ the fallback for the two buffers above

   agent_end  prepText           last of turnAnswerTexts           ""  ✗   A  ✓
     ↳ /GOAL_READY:/                ?? messageToText(last)          [X3]

   subagents  runTurnLoop        collectResponseText(text_delta)   A       A
                                   || getLastAssistantText(…)
                                      which walks BACK to text

   prinny     describeEmptyEnding any block that is text or        A → not empty
                                  toolCall                        (decision, §7)
   ──────────────────────────────────────────────────────────────────────────────
```

### 2.3 The three buffers, and why there are three

Three different questions about one turn, and each needs a different unit. They
were not three until this pass; two of them shared one, and one did not exist.

```
                     per MESSAGE                        per TURN, in agent_end
   ┌──────────────────────────────────────┐   ┌──────────────────────────────────┐
   │ turnAssistantTexts                   │   │ committedText                    │
   │   messageToText(m)                   │──▶│   commitTurnMemory prefers the   │
   │     || messageToRepetitionText(m)    │   │   last ANSWER, falls back here   │
   │   the SANITIZED message              │   │   → the fingerprint / snippet /  │
   │   "the answer, or the reasoning      │   │     text WINDOWS                 │
   │    when there is no answer"          │   │   → detectStuck rules 3,4,5,6,8  │
   └──────────────────────────────────────┘   └──────────────────────────────────┘
   ┌──────────────────────────────────────┐   ┌──────────────────────────────────┐
   │ turnAnswerTexts                      │   │ turnAnswerText                   │
   │   messageToText(m) — text only       │──▶│   last non-empty, else            │
   │   the SANITIZED message              │   │   messageToText(lastAssistant)   │
   │   "did this message ANSWER"          │   │   → emptyResponse                │
   │                                      │   │   → LOOP_DONE / LOOP_BLOCKED     │
   │                                      │   │   → GOAL_READY (prepare)   [X3]  │
   └──────────────────────────────────────┘   └──────────────────────────────────┘
   ┌──────────────────────────────────────┐   ┌──────────────────────────────────┐
   │ turnRepetitionTexts            [NEW] │   │ turnEmittedTexts                 │
   │   messageToRepetitionText(m)         │──▶│   the list, else                 │
   │   text AND thinking                  │   │   [messageToRepetitionText(last)]│
   │   the ORIGINAL message         [X5]  │   │   → detectStuck rule 1, per entry│
   │   "what did the model produce"       │   │   → reasoningOnlyResponse + chars│
   └──────────────────────────────────────┘   └──────────────────────────────────┘

   Why the third one takes the ORIGINAL: `message_end` returns a SANITIZED
   replacement for a degenerate message, and pi writes it over the object
   `agent_end` reads. The sanitizer and rule 1 share DEGENERATE_REPEATS, so a
   detector run over the sanitized text finds nothing — by construction, every
   time. The first two want the sanitized text: it is what the model sees next
   turn, and it is what the repetition window should hold. [X5]
```

### 2.4 `agent_end` — the ladder, in full

Twenty-one `return;` statements and a fall-through. Every arrow leaving the column
is a `return`.

```
 agent_end(event, ctx)
   │
   ├─ !state.active
   │    └─ status === "preparing":
   │         prepText := last of turnAnswers ?? messageToText(last)     ← [X3]
   │         resetTurnBuffers()                                         ← [X3]
   │         /GOAL_READY:/ → preparedAt := now ─────────────────────────────▶ ✗
   │
   ├─ clearPendingTimer()
   ├─ toolCallsThisTurn := state.toolCallsThisTurn                       ← T2
   ├─ turnTexts   := turnAssistantTexts
   ├─ turnCalls   := turnToolCalls
   ├─ turnAnswers := turnAnswerTexts                                     ← W1
   ├─ turnEmitted := turnRepetitionTexts                                 ← [X2]
   ├─ resetTurnBuffers()   ── ALSO state.toolCallsThisTurn := 0          ← [X4]
   ├─ if penaltyTurnsRemaining > 0: penaltyTurnsRemaining--              ← S4
   │
   ├─ lastAssistantText           := messageToText(last)
   ├─ lastAssistantRepetitionText := messageToRepetitionText(last)
   ├─ turnEmittedTexts  := turnEmitted, else [lastAssistantRepetitionText] [X2]
   ├─ turnThinkingChars := Σ trimmed lengths of turnEmittedTexts          [X2]
   ├─ turnAnswerText    := last non-empty of turnAnswers ?? lastAssistantText W1
   │
   ├─ softStopRequested ──────────────────────────────────────────────────▶ ✗
   │
   ├─ emptyResponse := !turnAnswerText && tools === 0            ← V1 W1 [X4]
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
   ├─ committedText := commitTurnMemory(turnTexts, turnCalls, turnAnswers) [X1]
   │
   ├─ rescueActive ─▶ switch back to the loop model ──────────────────────▶ ✗
   │
   ├─ stuckReason := detectStuck(committedText, turnEmittedTexts) U1 V2 [X1][X2]
   ├─ if !stuckReason: consecutiveStuckCount := 0                        ← U1
   │
   ├─ checkCommand → runGoalCheck() → applyCheckOutcome()
   │     ├─ execFailed × MAX_CHECK_ERRORS ─▶ pauseForCheckFailure ────────▶ ✗
   │     └─ untilDone && passed && !execFailed ───────────────────────────▶ ✗ completed
   │
   ├─ /\bLOOP_DONE\s*:/i.test(turnAnswerText)                            ← W1
   │     ├─ untilDone && checkCommand && lastCheckPassed !== true    ← U3 V3
   │     │     ├─ stuckReason ─▶ interveneStuck ──────────────────────────▶ ✗
   │     │     └─ else check_failed directive ────────────────────────────▶ ✗
   │     ├─ untilDone ────────────────────────────────────────────────────▶ ✗ completed
   │     └─ endless: stuckReason ? interveneStuck : improve ───────────────▶ ✗
   ├─ /\bLOOP_BLOCKED\s*:/i.test(turnAnswerText)                         ← W1
   │     stuckReason ? interveneStuck : unblock ──────────────────────────▶ ✗
   ├─ maxIterations reached ──────────────────────────────────────────────▶ ✗
   ├─ scoreRegressed ─▶ regression directive ─────────────────────────────▶ ✗ V3
   ├─ stuckReason ─▶ interveneStuck ──────────────────────────────────────▶ ✗
   ├─ iterationCount - lastStateChangeIteration >= 8 ─▶ audit nudge ──────▶ ✗
   │
   └─ normal continue: schedule the next turn
```

### 2.5 `detectStuck` — eight rules, and what each one reads

The first that matches wins, and its text becomes both the operator's notice and
the model's directive.

```
   #  rule                                    reads                    fixed by
   ──────────────────────────────────────────────────────────────────────────────
   1  detectDegenerateRepetition(t, 4)        EVERY message of the     [X2][X5]
      sentence / word / phrase                turn, ORIGINAL text
   2  turnsWithoutTools >= 3                  a counter                    T2 [X4]
   3  last two fingerprints equal             committedText            V2  [X1]
      AND normalize(text).length > 80         (its length gates)
   4  last three fingerprints equal           committedText            V2  [X1]
      AND normalize(text).length > 0
   5  textSimilarity(text, previous) >= 0.80  committedText, cut to    V2 W2 [X1]
      AND normalize(text).length > 60         PERSISTED_WINDOW.textChars
   6  same fingerprint >= 3 in the 8-window   the window               V2  [X1]
   7  last three TURN tool signatures equal   recentToolResults        U2
   8  same question repeated (ends in "?")    committedText + snippets V2  [X1]
   ──────────────────────────────────────────────────────────────────────────────

   Rules 3–6 and 8 all reduce to "what did commitTurnMemory store", which is why
   X1 disables or inverts all five at once. Rule 1 is the only one that is about
   a single RESPONSE rather than about the turn's one committed entry, which is
   why it needs the third buffer rather than the first.
```

### 2.6 The escalation ladder, and its three rungs' guards

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
      │              ── UNCONDITIONAL, and not wrapped in a try (§7)
      │
      └─ strategy    otherwise
                     delay := min(60, 2 ** min(streak, 6)) seconds
                     rotating STUCK_STRATEGIES[interventionCount % 5]
                     streak >= 3 adds the HARD RESET block
                     ctx.hasPendingMessages()
                       ? sendLoopTurn(…, {queueOnly:true})   deliverAs:"nextTurn"
                       : scheduleLoopTurn("stuck", delay, ctx)          V4
```

Every rung is charged before any of them runs, which is what makes X1's false
positive expensive: four productive turns misread as repetition spend three turns
of sampling penalties and, at streak 3, a model swap.

### 2.7 The context ladder

```
  1. TELL THE MODEL        context handler, every provider call
       >= 60%  advisory line, appended last (cached prefix untouched)
       >= 80%  CRITICAL wording
       pi-loop-mode and compaction-guard both inject one; whichever runs second
       sees the other's `-context-budget` customType suffix and stands down.

  2. DETECT PRESSURE       agent_end → isContextPressure()      ← V1 W1 [X4]

  3. RECOVER               deferred to agent_settled, because pi runs its own
                           overflow recovery after agent_end and wins the race
       attempt 1,2   → emergency compaction, tighter summary each time
       attempt 3     → cooldown 60s → 120s → 240s, tighter still
       cooldown 4    → pauseForContextFailure — the only place the loop gives up
```

The measurement the starvation rung rests on: **below 87% of the window, 3 empty
assistant turns out of 196; at or above 87%, 33 out of 63.** A cliff, not a
gradient — and an empty turn still costs a full iteration.

### 2.8 What each lifecycle transition puts back

X4 is the row that was missing a column. The turn's state lives in four places
and only one transition reset all four.

```
                          turn      turn      turn      state.        degenerate
                          Assistant Answer    Repetition toolCalls    AbortPending
                          Texts     Texts     Texts      ThisTurn
  ────────────────────────────────────────────────────────────────────────────────
  agent_end (top)          ✓         ✓         ✓          ✓            ✗ (read
                           ─────── resetTurnBuffers() ───────           BELOW)
  runLoop                  ✓         ✓         ✓          ✓            ✓
  finalizeSoftStop         ✓         ✓         ✓          ✓            ✓
  /loop stop               ✓         ✓         ✓          ✓ ← [X4]     ✓
  /loop end                ✓         ✓         ✓          ✓ ← [X4]     ✓
  session_start            ✓         ✓         ✓          ✓ ← [X4]     ✗ (§7)
                           …now AFTER restoreState, which brings a
                              persisted mid-turn count back  ← [X4]
  session_shutdown         ✓         ✓         ✓          ✓ ← [X4]     ✗ (§7)
  /loop resume             ✗ (never filled while inactive)  via stop   ✗ (§7)
  ────────────────────────────────────────────────────────────────────────────────

  `degenerateAbortPending` is deliberately NOT in resetTurnBuffers: it is set by
  message_update mid-stream and consumed by a branch of agent_end that runs BELOW
  the drain, so clearing it with the buffers would delete the flag before the
  handler that reads it. That it survives one of agent_end's exits is a note, not
  a finding — §7.
```

---

## 3. Subagents (`vendor/pi-subagents-lite`)

62 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
`/agents` menu, a slot table, a watchdog, and a spawn coordinator that owns
delivery.

### 3.1 A record's life, and its two runs

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
    │                      → onSessionCreated  ← record.execution.session  W6
    │                      → bindExtensions → tool filtering
    │                    pendingSteers flushed
    ▼
  .then                  status ← classifyRun(result)     ← TERMINAL FROM HERE
    │                    result := responseText
    │                    ┌──────────────────────────────────────────────────┐
    │                    │ runVerification()      ← the record's SECOND run │
    │                    │   verifyPhase "judging" / "repairing"             │
    │                    │   status says completed · completedAt UNSET       │
    │                    │   stopAgent() returns false · watchdog drops state│
    │                    │   clear() used to ACCEPT                    ← Y1  │
    │                    └──────────────────────────────────────────────────┘
    │                    completedAt stamped AFTER the check
    ▼
  .finally               settlementCount++ · outputLog finalised
                         slot released · tallyCompletion · drainQueue
                         parent binding detached · gate opened · settled := true
```

The **completion gate** is the invariant worth knowing: every record carries a
promise from birth, opened exactly once, never assigned the run's own promise.
Seven paths open it — settlement, a queued stop, a start failure, an
already-aborted spawn, dispose, record removal, and a late-failing queue drain —
so a foreground `Agent` call can never hang on a record that will not settle. Y1
is the other side of that: a gate opened *early*, with `""`, while the answer it
was supposed to carry was still being checked.

### 3.2 Who may touch a record, and when

```
                       queued  running   VERIFYING   settled   stopped/error
  ──────────────────────────────────────────────────────────────────────────
  status reads         queued  running   completed   completed stopped/error
  verifyPhase          —       —         judging /   —         —
                                         repairing
  ──────────────────────────────────────────────────────────────────────────
  steer / continue     no      YES       no¹         YES       YES
  stop (Esc, tool)     YES     YES       no²         no        no
  watchdog             —       YES       no³         no        no
  clear                no      no        no ← Y1     YES       YES
  widget column        queued  running   running     finished  finished
  /agents list         ⏳      ▶         ▶ …checking ✓         ✗ / •
                                         ← Y1        ← Y1
  ──────────────────────────────────────────────────────────────────────────
  ¹ `continueSettledAgent` returns false: `execution.settled` is set in the
    `.finally`, which has not run.
  ² every stop path keys on `status === "running"`. That verification is
    therefore uninterruptible is T5, open by decision; the 300 s per-call
    deadline is the only thing that ends it.
  ³ `Watchdog.check()` does not merely skip a non-running record, it deletes its
    state — so a repair's tool calls feed a `touch()` that returns undefined.
```

### 3.3 `steer()` — three branches, one brief

```
   manager.steer(id, message)
     │
     ├── status === "running"
     │     ├── no session yet ─▶ pendingSteers.push(message)
     │     │                     growBrief(record, message)              W3
     │     │                     (flushed by onSessionCreated)
     │     │
     │     └── session ────────▶ await session.steer(message)
     │                           growBrief(record, message)              W3
     │                           (only AFTER it went)
     │
     └── terminal ────────────▶ continueSettledAgent(record, message)
                                 · re-reserve the slot
                                 · growBrief(record, message)
                                 · record.verification := undefined
                                 · restart the watchdog
                                 · re-attach the settlement chain

   record.execution.brief has three readers and all three are consequential:
       verifyAnswer(record, brief, deps)   what the answer is CHECKED against
       buildRepairPrompt(brief, why)       what the child is told to answer
       buildAnchorMessage(brief)           what is restated after a compaction
```

### 3.4 The turn ceiling, as a state machine

```
                       normalizeMaxTurns(n):  0 → unbounded
                                              absent → 40
                                              else max(1, n)
   turn_end, turnCount++
        ├── maxTurns == null ──────────────────────────────▶ nothing, ever
        ├── !ceilingReached && turnCount >= maxTurns
        │      ceilingReached := true
        │      ├── graceTurns <= 0
        │      │     ├── shouldSteerAtSoftLimit(maxTurns)   (maxTurns > 1)
        │      │     │      aborted := true ; session.abort()
        │      │     └── else  ─────────────────────────────▶ nothing      W4
        │      └── graceTurns > 0
        │            ├── shouldSteerAtSoftLimit(maxTurns)
        │            │      turnLimited := true                           V6
        │            │      session.steer(TURN_LIMIT_STEER)
        │            └── else  ─────────────────────────────▶ nothing      T1
        └── ceilingReached && turnCount >= maxTurns + graceTurns
               aborted := true ; session.abort()

   classifyRun(result)      aborted ▸ modelError ▸ turnLimited ▸ completed
```

### 3.5 Concurrency

`SlotTable` holds per-model and per-provider pools. Precedence is per-model ▸
per-provider ▸ default, and the default case **creates and caches** a per-model
slot — which is why `setLimits()` must delete slots the new config no longer
names, and why it must then `recount()` from the holders themselves.

> A `running` count is a fact about the world; a `limit` is configuration.

`recount()` keys on `execution.holdsSlot` rather than on `status === "running"`,
because the slot is held right through the verification window, where the status
has already gone terminal. That is the same fact Y1 is about, already correctly
handled in the one place where getting it wrong would have leaked a slot.

The default is **1**, in exactly one place (`config-io.ts`). The measurement
behind it: a child having its own system prompt does *not* by itself evict the
parent's cached prefix (99.2% hit across six small child turns); what evicts it is
*size* — a child that grew to 18k tokens took the parent's next call from 2,117
cached tokens to zero, and from 442 ms to 2,949 ms.

### 3.6 What a child inherits

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
   │    turn_limited / stopped ─▶ worthJudging:false skipped-cutoff    W4   │
   │  brief missing            ─▶                    skipped-nobrief   W3   │
   └────────────────────────────┬──────────────────────────────────────────┘
                                │ non-empty, clean run, brief present
                                ▼
   ┌──── the round loop, budget = SUBAGENT_VERIFY_ROUNDS (default 1) ──────┐
   │                                                                       │
   │   phase "judging"   ← verifyPhase set HERE, cleared in the finally Y1 │
   │   judge(buildJudgePrompt(brief, candidate))   ← fresh __verifier      │
   │        │                                        session, 1 turn, 300s │
   │        ▼                                                              │
   │   parseJudgeVerdict(reply)                                            │
   │        ├─ unparsed ─────────────▶ candidate + note(unparsed,attempts) │
   │        │                                                         W5   │
   │        ├─ addressed, 0 attempts ▶ candidate (bare)      passed        │
   │        ├─ addressed, n attempts ▶ candidate + note(repaired,n)   W5   │
   │        └─ not addressed                                               │
   │              ├─ attempts >= rounds ▶ ORIGINAL + note(failed,n)        │
   │              └─ phase "repairing"                                     │
   │                 repair(buildRepairPrompt(brief, why))    ← brief  W3  │
   │                      │            ← the CHILD's own session,          │
   │                      │              maxTurns 1, operator graceTurns   │
   │                      ├─ structuralVerdict(repaired, {status})    V5   │
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
   repaired          ✎ repaired       warning    "…the corrected one" /
                                                 "…the {second|third} attempt" W5
   failed            ✗ off-task       error      "…and {no attempt was made |
                                                  one attempt … | two attempts …}
                                                  … Treat it as unreliable."
   failed (stalled)  ✗ off-task       error      "…not asked a {third|fourth|
                                                  fifth} time"               W5
   unparsed          ? unreadable     warning    "the check could not be read" /
                     verdict                     "…the first answer did not
                                                  address the task…"         W5
   errored           ? check errored  warning    "the check did not complete"
   skipped-empty     ⊘ empty answer   warning    (REPLACES the answer)
   skipped-cutoff    ⊘ unchecked      dim        (the status note says why)  W4
                       (cut off)
   skipped-error     ⊘ unchecked      warning    (executeAgentTool returns
                       (failed)                   errorResult instead)
   skipped-nobrief   ⊘ unchecked      dim        (a fault in the spawn path)
                       (no task)
   (absent)          —                           the verifier never ran
```

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

   createAndConfigureSession
     ├─ initSession() ─▶ createAgentSession()   THE SESSION EXISTS
     ├─ onSessionCreated(session)   ← the capture, the line after     W6
     ├─ setSessionName()
     ├─ await bindExtensions()      ── could reject here
     ├─ resolveVisibleTools()
     └─ setActiveToolsByName()      ── and here
   runSessionPrompt(session, prompt) ── and here (the common one)
```

### 4.5 The deadline, and why it exists

Verification runs inside the settlement chain, **after** the status has gone
terminal, and every stop path keys off `status === "running"`. So during a judge
or a repair the record is unstoppable: the operator's Esc reaches `stopAgent()`,
which returns false; `StopAgent` the same; and the watchdog's `check()` does not
merely skip the record, it deletes its state. Meanwhile the parent's `Agent` call
is blocked on the completion gate. Nothing else can end that wait, so a 300 s
per-call deadline does. (That is T5, still open by decision.)

**Y1 is what that costs at the UI layer.** Because nothing can stop it, the only
button `/agents` had left for a verifying agent was Clear — and Clear worked.

---

## 5. A delegation, on a timeline

```
  parent turn N                                                  parent turn N+1
  ────────────┐                                                  ┌──────────────
              │  Agent(prompt, agent: "Explore")                 │
              ▼                                                  ▲
   ┌──────────────────────────────────────────────────┐          │
   │ SLOT HELD ════════════════════════════════════   │          │
   │                                                  │          │
   │  build   detectEnv (2× git, ~100 ms)             │          │
   │          buildAgentPrompt                        │          │
   │          reloadAndMap  (every extension factory) │          │
   │          createAgentSession → onSessionCreated   │          │
   │          bindExtensions (child session_start)    │          │
   │                                                  │          │
   │  run     turn 1 … turn k    ← llama, one at a    │          │
   │            time. each compaction fires the       │          │
   │            anchor steer; an operator steer grows │          │
   │            the brief; turn maxTurns → wrap-up    │          │
   │                                                  │          │
   │  settle  status ← classifyRun(result)            │          │
   │                                                  │          │
   │  verify  judge   ← a WHOLE extra session + 1 turn│          │
   │          repair  ← 1+ turns in the CHILD's       │          │
   │          judge   ← again                         │          │
   │            ── unstoppable (T5) …and, until this  │          │
   │               pass, CLEARABLE from /agents,      │          │
   │               which opened the gate below with   │          │
   │               "" and disposed the repair's       │          │
   │               session.                     ← Y1  │          │
   │                                                  │          │
   │ ══════════════════════ SLOT RELEASED ══════════  │          │
   └──────────┬───────────────────────────────────────┘          │
              │ tally · drainQueue · openGate ─────────────────▶ │
              │                                                  │
              │ (background instead: capBackgroundResult →        │
              │  pi.sendMessage deliverAs steer|followUp,         │
              │  triggerTurn:true — and if the parent is BUSY     │
              │  that lands inside the running turn, which is     │
              │  the two-message turn X1, X2 and X3 are about)    │
```

---

## 6. Findings

Severity is about what it costs a real run. Evidence is **PROVEN** (an executable
probe drives the shipped module), **MEASURED** (a number taken from the tree), or
**SOURCE** (read, with the reasoning in the finding).

| # | Finding | Sev | Evidence | Probe | Sibling of | Fixed |
| --- | --- | --- | --- | --- | --- | --- |
| X1 | `commitTurnMemory` commits the turn's last MESSAGE, so a trailing reasoning-only message becomes "the turn's final answer" and five of `detectStuck`'s rules compare the wrong string — in both directions | **HIGH** | PROVEN | `l1` | W1, V2 | ✔ |
| X2 | `detectStuck`'s degenerate rule is about ONE response and was handed the turn's LAST message | **MEDIUM** | PROVEN | `l2` | W1, V2 | ✔ |
| X5 | …and it was handed that message *after* the loop's own sanitizer had rewritten it in place, so the rule could not fire in a real session at all. The probe harness did not replay the replacement | **HIGH** | PROVEN·SOURCE | `l3` | the harness itself | ✔ |
| X3 | `GOAL_READY:` is read off the last message; the one reader W1 could not move, because the buffer was gated on `state.active` | **MEDIUM** | PROVEN | `l4` | W1, V8 | ✔ |
| X4 | `state.toolCallsThisTurn` is per-turn state that only `agent_end` reset, and `/loop stop` makes `agent_end` return at its first line | **MEDIUM** | PROVEN | `l5` | T2 | ✔ |
| Y1 | `/agents` offered Clear on a record whose verifier was still running — disposing the repair's session and opening the parent's completion gate with `""` | **MEDIUM** | PROVEN·SOURCE | `l6` | the widget's own fix | ✔ |

---

### X1 — the window commits the turn's last message, not its answer · **HIGH** · PROVEN · **FIXED**

**Where.** `commitTurnMemory` at `extensions/index.ts:337`, called from
`agent_end:2319`, against `message_end:2033`.

**What.** `message_end` buffers one string per assistant message:

```js
  const tracked = messageToText(m) || messageToRepetitionText(m);   // answer, else thinking
  if (tracked.trim()) turnAssistantTexts.push(tracked);
```

and `commitTurnMemory` took the last non-empty of that buffer and called it the
turn's final answer:

```js
  const finalText = [...texts].reverse().find((text) => text.trim());
```

For a one-message turn those are the same string. For the two-message turn W1 is
about — an answer, then a reasoning-only message delivered by a background
subagent's mid-turn steer — the buffer is `[answer, thought]` and the last
non-empty is the **thought**. That thought then goes into all three windows
(`lastAssistantFingerprints`, `lastAssistantSnippets`, `lastAssistantTexts`) as
the turn's answer, and is returned as `committedText`, which since V2 is what
`detectStuck` compares.

Five of the eight rules read it. §2.5 has the table.

**The seventh pass's own drawing says otherwise.** `…-readers.md` §2.2 lists
`committedText` as taking `A` for exactly this turn. It takes `B`. The row was
written from the intent of `commitTurnMemory`'s comment ("the turn's final
answer") rather than from its code, and nothing in the suite or the probes could
contradict it, because every turn in both was one message.

**Proved.** `l1`, driving the real module, in both directions with a control on
each side:

```
   A — four BYTE-IDENTICAL answers, each followed by a DIFFERENT thought
       BEFORE   turn 1–4  (no notice)                       ← the detector blind
       control  turn 2    "assistant repeated the same response", escalating to
                          a streak of 3 by turn 4           ← one message/turn
       NOW      identical to the control

   B — four GENUINELY DIFFERENT answers, each followed by the SAME thought
       BEFORE   turn 2    "assistant repeated the same response"
                turn 3,4  streak 2, streak 3                ← the detector firing
                                                              on a productive run
       NOW      turn 1–4  (no notice)

   control — a turn whose ONLY output is reasoning still commits the reasoning
       NOW      turn 2    "assistant repeated the same response"   ← V1/V2 intact
```

**What it costs.** Both directions are expensive and they are expensive in
opposite ways.

- **Blind:** the loop's whole fixation detector switches off for any run in which
  a background subagent settles mid-turn. That is not a rare shape — it is the
  ordinary one for a loop that delegates, and `interveneStuck` is the only thing
  standing between a fixated 27B and an unattended overnight run.
- **Loud:** four turns that each edited a different file were charged three stuck
  interventions, which is `PENALTY_TURNS` of altered sampling on every one of
  them and, at streak 3, a switch to the rescue model — a slower, more expensive
  model called in to rescue a run that was working.

**The fix.** `commitTurnMemory` takes the turn's answers and prefers them:

```js
  function commitTurnMemory(texts, calls, answers = []) {
    const lastNonEmpty = (items) => [...items].reverse().find((t) => t.trim());
    const finalText = lastNonEmpty(answers) ?? lastNonEmpty(texts);
```

The fallback is what keeps V1 and V2 intact: a turn whose only output was
reasoning has no answers, commits the reasoning, and is compared on the
reasoning — which is what is in the window and what the model is repeating.

*Tests:* `vendor/pi-loop-mode/tests/turn-material.test.ts`, first describe. Four
cases, two of which fail without the fix; the controls are the one-message turn
and the reasoning-only turn, one on each side.

---

### X2 — the degenerate rule is about one response, and read one message · **MEDIUM** · PROVEN · **FIXED**

**Where.** `detectStuck` at `index.ts:859`, called from `agent_end:2388`.

**What.** Rule 1 is `detectDegenerateRepetition(text, DEGENERATE_REPEATS)`, and
its helper is explicitly about a single response: "one sentence, word, or short
phrase repeated many times **within a single response**". It was handed
`messageToRepetitionText(lastAssistant)` — one message, and the one least likely
to be the answer, because a turn only has a second message when something was
injected into it.

**Proved.** `l2`:

```
   the answer repeats one sentence 9× (467 chars); DEGENERATE_REPEATS is 4

   BEFORE   one-message turn   detectDegenerateRepetition(answer)  -> "sentence"
            two-message turn   detectDegenerateRepetition(thought) -> null

   NOW      degenerate answer alone            "response degenerated: same
                                                sentence repeated 9×"
            the same answer + a trailing thought   the same
            control — a clean answer + a thought   (no notice)
```

**What it costs.** Rule 1 is the loop's only *after the fact* degeneracy check.
The mid-stream kill switch (`message_update`) uses `DEGENERATE_STREAM_REPEATS`,
which is 6, and only fires while tokens are arriving; the 4-and-5 repeat band is
entirely rule 1's job.

**The fix.** A third per-message buffer, and `detectStuck` scans each entry:

```js
  function detectStuck(lastAssistantText, repetitionTexts = lastAssistantText) {
    for (const text of typeof repetitionTexts === "string" ? [repetitionTexts] : repetitionTexts) {
      const degenerate = detectDegenerateRepetition(text, DEGENERATE_REPEATS);
      if (degenerate) return `response degenerated: …`;
    }
```

Scanning each message rather than the concatenation keeps the unit the rule is
written in. A caller passing one string gets exactly the old behaviour, which is
what makes every existing test a control.

The same buffer fixes the other reader of the same value: `reasoningOnlyResponse`
and the `N chars of thinking` in the starvation notice now count the turn's
thinking rather than the last message's.

*Tests:* `turn-material.test.ts`, second describe (shared with X5). Three cases,
two of which fail without the fix.

---

### X5 — the rule read the message *after* the loop rewrote it · **HIGH** · PROVEN·SOURCE · **FIXED**

**Where.** `message_end` at `index.ts:2041`, against pi's
`agent-session.js:425/481` and `runner.js:610`.

**What.** `message_end` sanitizes a degenerate assistant message and returns the
replacement. pi does not treat that as advice:

```
  ExtensionRunner.emitMessageEnd      runner.js:610
      threads each handler's returned message into the next, returns the last
  AgentSession._emitExtensionEvent    agent-session.js:481
      _replaceMessageInPlace(event.message, normalized)
  AgentSession._replaceMessageInPlace agent-session.js:425
      for (const key of Object.keys(targetRecord)) delete targetRecord[key];
      Object.assign(targetRecord, replacement);
```

with pi's own comment on the mutation:

> Mutating this object in place keeps agent state, **later turn/agent events**,
> listeners, and the eventual `SessionManager.appendMessage(event.message)`
> persistence in sync.

`agent_end` is a later agent event and its `messages` are those same objects. So
by the time rule 1 looked, the repetition had been cut out and replaced by a
one-line marker.

**And the thresholds are the same constant.** `sanitizeDegenerateText` calls
`detectDegenerateRepetition(text, DEGENERATE_REPEATS)`; so does rule 1. Anything
the rule could have matched had already been truncated by the sanitizer, one
handler earlier, every time. Rule 1 was not flaky — it was **unreachable**.

**Proved.** `l3`, arithmetic first and then the module:

```
   what the model produced          467 chars, 9 identical sentences
   what message_end returned        357 chars, truncated + a marker

   detectDegenerateRepetition(…, DEGENERATE_REPEATS = 4):
     BEFORE  over the message agent_end holds   null
     NOW     over what the model produced       {repeats: 9, kind: "sentence"}

   driving the shipped module, with the replacement applied:
     the object agent_end saw : "…repeated 9×. Do not continue this pattern.]"
     notice                   : Loop stuck (1x): response degenerated: same
                                sentence repeated 9× (…)
```

**Why nothing caught it — and this is the finding.** `_host.mjs` ignored what a
`message_end` handler returned, and built a *fresh* message object for
`agent_end`. Both halves had to be wrong for the defect to hide, and both were.
Every probe that showed rule 1 firing was showing it firing on text that, in a
real session, no longer existed. The same is true of the two test hosts.

The harness is now faithful — `applyMessageEndReplacement` in `_host.mjs`, and the
same replay inside `turn-material.test.ts`'s host — and the **control for that
change is the rest of the probe suite**: `g2`, `h4`, `i1`, `i2`, `j1`, `j2`, `k1`
and `k2` all print exactly what they printed before it, because none of them uses
text the sanitizer touches. That is the shape of the problem: a harness
divergence is invisible until an input exists that can see it.

**What it costs.** One of the loop's eight stuck rules, entirely, since the fork.
Its practical weight is bounded by the mid-stream kill switch above it (6 repeats,
during streaming) and by the sanitizer itself, which does remove the repetition
from the context — but the *ladder* was never charged: no intervention, no
sampling penalties, no strategy directive, no operator notice, and the streak that
drives the rescue model and the compaction never advanced.

**The fix.** The third buffer takes the ORIGINAL message:

```js
  const emitted = messageToRepetitionText(event.message);   // not trackedMessage
  if (emitted.trim()) turnRepetitionTexts.push(emitted);
```

The two buffers beside it still take the sanitized message, deliberately: they
feed the repetition windows, and the sanitized text is what the model will see
next turn. Three questions, three units, one message. That is §2.3.

*Tests:* `turn-material.test.ts`, second describe. The second case asserts the
sanitized text really did land on the object `agent_end` was handed, so the test
fails if the *host* stops replaying pi rather than only if the module regresses.

---

### X3 — `GOAL_READY:` is read off the last message · **MEDIUM** · PROVEN · **FIXED**

**Where.** `agent_end`'s inactive branch at `index.ts:2071`.

**What.** `/loop prepare` spends a turn — usually on the strongest model
available — writing the specification the unattended run is then steered by. The
marker on the way back is what sets `preparedAt`, and it was read with
`messageToText(prepAssistant)`: the last assistant **message**.

This is the fourth reader of W1's question, and the one W1 could not move:
`message_end` was gated on `state.active`, and preparation runs with it false, so
there was no buffer to read.

**Proved.** `l4`:

```
   control — the marker on a one-message prepare turn
       notice : Goal preparation complete…      Goal file: GOAL.md (prepared)

   BEFORE — the marker, then a reasoning-only message in the same turn
       notice : (no notice)
       Status: preparing        Goal file: GOAL.md (not prepared)

   NOW    — the same turn
       notice : Goal preparation complete…      Goal file: GOAL.md (prepared)

   control — a prepare turn that did NOT finish must stay unprepared
       notice : (no notice)                     Goal file: GOAL.md (not prepared)
```

**What it costs.** V8's failure, by another route. With `preparedAt` at 0:

- `kindDirective("start")` gives the generic "Begin with a short plan" instead of
  "First read `GOAL.md` to load the full specification";
- `loopInstructions` omits the "Specification: `GOAL.md` — read it whenever you
  lose track of the plan" line from **every** turn of the run;
- `/loop status` says "not prepared" for the rest of the session, and nothing
  else ever sets the flag.

So an unattended run starts, and keeps going, having never been told that the
specification a strong model was just spent producing exists.

**The fix.** `message_end` buffers while `state.status === "preparing"` too, and
the branch reads the turn's last answer with the old value as its fallback. It
also drops the buffers on the way out — that branch returns above the drain.

*Tests:* `turn-material.test.ts`, third describe. Three cases, one of which fails
without the fix; the third control pins that the fix did not make the marker
easier to satisfy.

---

### X4 — the per-turn tool counter outlives a `/loop stop` · **MEDIUM** · PROVEN · **FIXED**

**Where.** `resetTurnBuffers` at `index.ts:216`, against `agent_end`'s first line
and the `/loop stop` branch.

**What.** T2 established that `state.toolCallsThisTurn` outliving its turn
switches off the starvation rung — `emptyResponse` requires the count to be zero,
and `isContextPressure`'s starvation rung requires `emptyResponse`. Its fix moved
the reset to the **top of `agent_end`**, above every early return *in that
handler*.

`/loop stop` sets `state.active = false`. `agent_end`'s first line is
`if (!state.active) … return;`. So a loop stopped in the middle of a tool-using
turn keeps the count, and `/loop resume` does not clear it either.

The three module-global buffers next to the counter were already dropped by
`/loop stop`, `/loop end`, `runLoop`, `finalizeSoftStop`, `session_start` and
`session_shutdown`, all through `resetTurnBuffers()`. The counter is the same
per-turn state, and it was not in it. §2.8 is that table.

**Reachability.** `/loop stop` is the advertised operator action — the stop
notice itself says "Use `/loop resume` to continue" — and the `loop` tool gives
the model the same verb, with `suppressAbort` so that a stop issued from inside a
turn does not throw the turn away. Both leave a turn's calls counted.

**Proved.** `l5`:

```
   control — a starved turn on a fresh counter, at 90% context
       Loop: context pressure detected (1/3) — recovering.
       Iterations: 0/∞   Status: retrying

   BEFORE — the same turn after a stop/resume that interrupted a two-call turn
       (no notice)
       Iterations: 1/∞   Status: running

   NOW    — the same
       Loop: context pressure detected (1/3) — recovering.
       Iterations: 0/∞   Status: retrying

   control — a turn that really did call a tool is not starved
       (no notice)
```

**What it costs.** T2's cost, restored on a different path: the first turn after
a resume cannot be seen as starved, so it counts as a successful iteration —
which also resets `consecutiveErrorCount`, `contextCooldownCount` and
`contextCompressionLevel`, retiring the whole recovery ladder — and another turn
is scheduled into the same saturated context.

**The fix.** The counter lives in `resetTurnBuffers()` with the buffers it belongs
to, so there is one call site to find. `session_start` now calls that **after**
`restoreState`, because `/loop stop` persists the state it leaves behind and a
mid-turn count would otherwise come back with it.

`degenerateAbortPending` is deliberately *not* folded in: it is set mid-stream and
consumed by a branch of `agent_end` that runs **below** the drain, so clearing it
with the buffers would delete the flag before the handler that reads it. That it
survives one of `agent_end`'s exits stays a note (§7) rather than becoming a
second fix in the same edit.

*Tests:* `turn-material.test.ts`, fourth describe. Three cases, one of which fails
without the fix; the third control is the one that could have failed — the fix
must not make every turn look toolless.

---

### Y1 — `/agents` offered Clear on an agent the verifier still held · **MEDIUM** · PROVEN·SOURCE · **FIXED**

**Where.** `AgentManager.clear()` at `agent-manager.ts:990`, against
`agent-widget.ts:509` and `menu-running-agents.ts:206/266`.

**What.** `attachSettlementChain` sets `record.lifecycle.status` from
`classifyRun` and *then* awaits `runVerification`. For the whole of a judge and up
to three repairs the record therefore reads `completed`, `completedAt` is unset,
and `verifyPhase` is the only field that says a model call is in flight.

`agent-widget.ts` knew. `categorizeAgents` has carried this since the phase field
existed:

> the verifier runs after the child's run has settled — its status is already
> terminal and completedAt is not stamped until the check returns — so a
> verifying record matches none of the tests here and its row would vanish for the
> length of a model call … **It is active work the user is waiting on: it stays
> running.**

`menu-running-agents.ts` had its own copy of the question:

```js
  function isActive(record) {
    return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
  }
```

So one record, drawn as **running** by the widget and listed as **finished with a
✓** by `/agents` — where `isActive` also decides which actions it gets:

```js
  if (isRunning) { steer; stop } else { clear }     // ← the only action offered
```

and where `finished`/`completed` feed "Clear all" and "Clear done".
`AgentManager.clear()` accepted, because `isTerminalStatus` cannot see a phase
either.

**What clearing it does.** `removeRecord`, in order:

```js
  record.execution.session?.dispose();   // the session a REPAIR runs in
  this.openGate(id, "");                 // the parent's foreground Agent call
  this.agents.delete(id);                // the record the verdict is written to
```

**Proved.** `l6`, driving the real `AgentManager`, the real completion gate and
the real `removeRecord`:

```
   BEFORE — clear() reached removeRecord
     clear accepted                 true
     repair's session disposed      true
     completion gate opened         true, with ""
     record still tracked           false

   NOW — clear() refuses
     clear accepted                 false
     repair's session disposed      false
     completion gate opened         false
     record still tracked           true

   control — the check has finished, so Clear works exactly as before
     clear accepted                 true          … gate opened with ""
```

**What it costs.** The gate is the part that reaches the model: a foreground
delegation is blocked on `record.execution.promise`, and opening it with `""`
hands the parent an empty answer while the real one is still being judged. The
child's answer, the judge's verdict and any repair are all discarded, the slot
stays held until the verifier finishes anyway, and the parent is told nothing.

It is also the *only* action the menu offered on a verifying agent, and the row it
was offered from said `✓ completed` — so the operator's reasonable reading of the
screen is "this one is done, tidy it away".

**The fix.** The predicate moved to `src/agents/record-activity.ts`, which imports
nothing and is therefore testable, and the three readers import it:

```js
  export function isActiveRecord(r)    { return r.lifecycle.status === "running"
                                             || r.lifecycle.status === "queued"; }
  export function isVerifyingRecord(r) { return Boolean(r.verifyPhase); }
  export function isBusyRecord(r)      { return isActiveRecord(r) || isVerifyingRecord(r); }
```

- `AgentManager.clear()` refuses when `isVerifyingRecord(record)`.
- The menu offers no Clear while verifying, and neither bulk clear reaches it.
  Steer and Stop are still not offered, because both key off `status ===
  "running"` and would silently return false — a verifying agent deliberately has
  no action but viewing, which is T5 showing through rather than being papered
  over.
- The row says `▶ …  completed · checking`, so the two views agree.
- The widget uses `isBusyRecord` instead of its own inline test, which is the part
  that stops this recurring.

*Tests:* `vendor/pi-subagents-lite/tests/record-activity.test.ts`. Eight cases,
three of which fail when any one of the three readers is reverted. The last case
is the one that matters for the next pass: it asserts that **no** reader keeps a
private copy of the question.

---

## 7. Smaller things, and things that are not findings

Recorded so the next pass does not re-derive them. None is proposed for a change;
each carries the reason. The first four are new this pass.

- **`sanitizeDegenerateMessage` runs in two handlers, and only one of them
  matters.** `message_end` rewrites the stored message (X5's mechanism);
  `context` rewrites a *clone* pi makes for the provider call, so nothing there
  is written back. Both are correct, and the difference is worth knowing before
  changing either. SOURCE.
- **The `context` handler's sanitizer can therefore truncate the same text
  twice** — once in the stored message and again in the request copy built from
  it — but `sanitizeDegenerateText` is idempotent on its own output (the marker
  is one line and the repetition is gone), so the second pass is a no-op. SOURCE.
- **A steer queued before the session exists grows the brief before it has
  gone.** `steer()`'s live-session branch calls `growBrief` only after
  `session.steer()` resolves, and W3's own argument says why; the
  `pendingSteers` branch above it grows the brief at queue time, and the flush in
  `onSessionCreated` swallows failures with `.catch(() => {})`. The window is
  small (the session is milliseconds away) and the alternative — growing it inside
  the flush — puts the write on a path with no error handling at all. SOURCE.
- **`/loop resume` clears neither `degenerateAbortPending` nor the turn
  buffers.** It does not need to: everything that can leave them set also goes
  through `/loop stop`, `finalizeSoftStop` or `agent_end`, all of which drop them.
  Recorded because `resume` is the one lifecycle transition missing from §2.8's
  table, and the next person to add per-turn state will look at that table.
  SOURCE.
- **`interveneStuck`'s compaction rung is not wrapped in a try.**
  `requestEmergencyCompaction` is, and its comment says why. The stuck rung has no
  flags to leave set, but it has a worse failure: `agent_end` has already called
  `clearPendingTimer()` and the intervention has already been charged, so a
  synchronous throw propagates out of the awaited `interveneStuck` and the loop
  silently stops advancing with `status: "stuck"` and no timer. Nothing has been
  observed throwing. SOURCE.
- **V4's queued directive gives up the loop's own timer entirely.** With a message
  pending the strategy is queued with `deliverAs: "nextTurn"` and nothing is
  scheduled — deliberately, because the pending message will trigger the turn. If
  that turn never happens the loop is left with `status: "stuck"`, no timer and a
  directive in `_pendingNextTurnMessages`. `scheduleWatchdogTurn` exists for
  exactly this shape and is not used here. Strictly better than the pre-V4
  behaviour, which sent nothing at all. SOURCE.
- **`degenerateAbortPending` is cleared on one of `agent_end`'s exits.** If the
  abort lands on a turn whose final message reports `error` — or on no assistant
  message at all — the flag survives, and the operator's next Esc is then read as
  a degenerate abort and answered with a stuck intervention instead of "Loop
  paused (turn aborted)". SOURCE.
- **`saturatedManualCompaction` keys on `state.description`, not on
  `state.active`.** So `/compact` at ≥85% in a session whose loop has been stopped
  but not cleared replaces pi's model-written summary with the loop's emergency
  one, built from stale state. Arguably intended; recorded because the two
  neighbouring predicates use `loopOwnsThisSession` and this one does not. SOURCE.
- **`buildVerifyDeps` reads `SUBAGENT_VERIFY` at spawn time** while
  `runVerification` reads `SUBAGENT_VERIFY_ROUNDS` and
  `SUBAGENT_VERIFY_TIMEOUT_MS` per call. Three switches, two policies. SOURCE.
- **The repair runs with the watchdog's state already deleted.**
  `Watchdog.check()` drops the state of any record whose status is not `running`,
  and verification runs after the status has gone terminal. Bounded by the 300 s
  deadline instead, which is T5's territory. SOURCE.
- **`prinny-channel` has W1's shape too, and the fix there is not the same one.**
  `describeEmptyEnding` scans back to the first assistant message it finds and
  returns on it, so a turn that answered and then produced a trailing
  reasoning-only message reads as `produced-no-answer`. **Not fixed, deliberately.**
  Stopping at an empty final turn was paid for by a real incident and the source
  says so; `forwarding.ts` is handed a message list with no turn boundaries, so
  the loop's per-turn-buffer repair does not transfer, and the trade-off between
  sending a stale answer and sending nothing is a Matrix-side call. Carried
  forward from the seventh pass, unchanged.
- **`exclude_tools` is U6's sibling, one field over.** `tools` now goes through
  `parseExtensions`; `exclude_tools` still goes through `parseStringArray`. Both
  readings are "exclude nothing". Carried forward.
- **`hasStateChange()` matches its keyword list against any tool output**, so
  reading a file containing "successfully" postpones the no-progress audit; and it
  writes `state.iterationCount + 1` from `tool_result`. Carried forward.
- **A provider-error streak has no terminal state**, while the context ladder
  escalates to `pauseForContextFailure`. Carried forward.
- **`consecutiveErrorCount` is shared between context pressure and provider
  errors**, and `backoffSeconds()` reads it. Carried forward.
- **`getFinalModelError()` returns undefined for `stopReason: "error"` with an
  empty `errorMessage`**, so the run classifies as `completed`. Carried forward.
- **The `Agent` tool's `execute` reads `params.max_turns`, which its schema does
  not declare and nothing injects.** Dead, and load-bearing in the negative sense
  for W4's reachability argument. Carried forward.
- **`__verifier` is hidden from the `Agent` tool's type list but not from
  `resolveType`.** Harmless. Carried forward.
- **`SlotTable.setLimits()` reads `config.default` with no fallback**, and
  `Math.max(1, undefined)` is `NaN`. Every real caller passes a merged config.
  Carried forward.
- **`record.stats.turnCount` is initialised to 1 at spawn**, before any turn has
  run. Cosmetic. Carried forward.
- **A background subagent result delivered while a loop is running triggers a turn
  the loop counts as an iteration.** Carried forward — and the mechanism behind
  W1, X1, X2 and X3.
- **The spawn bracket is still a process-global counter**, narrowed to extension
  loading and binding. Carried forward.
- **`AgentStatus` lists every agent ever spawned this session**, unbounded.
  Carried forward.

---

## 8. What was re-verified this pass, and holds

Read out of the tree, not assumed.

- **All six seventh-pass fixes are in place**, and all six `k` probes still run
  clean under the *new, faithful* host. `turnAnswerText` is what the markers read;
  rule 5 cuts both sides to `PERSISTED_WINDOW.textChars`; `growBrief` is called
  from every branch of `steer()`; the `graceTurns <= 0` sever is gated on
  `shouldSteerAtSoftLimit`; `describeOrdinal` is used by both counting notes; the
  judge's session is captured on the line after `initSession`.
- **All eight sixth-pass, all nine fifth-pass and all ten fourth-pass fixes are in
  place**, and `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`, `i1`–`i9` and `j1`–`j8`
  all still run clean.
- **The harness change did not move any earlier verdict.** `g2`, `h4`, `i1`, `i2`,
  `j1`, `j2`, `k1` and `k2` print what they printed before it. That is the control
  for X5's fix to `_host.mjs`, and it is the reason the divergence survived four
  passes: nothing in the suite used text the sanitizer touches.
- **`messageToRepetitionText` really does join text AND thinking**, so the new
  buffer is a superset of the old value for every message, and the fallback path
  is byte-identical to the old behaviour.
- **pi really does call `message_end` handlers in registration order and thread
  the replacement through them** (`runner.js:610`), so the loop's sanitizer sees
  whatever an earlier extension returned — which is why the new buffer reads
  `event.message` rather than re-deriving from the handler's own input.
- **The slot is still held across verification**, and `recount()` still keys on
  `holdsSlot` — the one place where "a verifying record is still busy" was already
  right, and the model for Y1's fix.
- **`verifyAnswer` still never throws**, its prologue is inside its own try, and
  `runVerification` catches anything the prologue could still raise.
- **The loop is inert in a child**, by three independent stops, and
  `pi-subagents-lite` is inert in a child by its factory guard.

---

## 9. What shipped

Every fix carries a regression test that fails when the fix is removed; where a
case passes either way it is a control and is labelled as one.

| # | Fixed by | Where | Tests | Fail without it |
| --- | --- | --- | --- | --- |
| X1 | `commitTurnMemory` prefers the turn's last ANSWER, falling back to the tracked buffer | `pi-loop-mode/extensions/index.ts` | `turn-material.test.ts` ×4 | 2 |
| X2 | a third per-message buffer; `detectStuck` scans each entry | `extensions/index.ts` | `turn-material.test.ts` ×3 | 2 |
| X5 | that buffer takes the ORIGINAL message; `_host.mjs` and the test host replay pi's in-place replacement | `extensions/index.ts`, `context/testing/probes/_host.mjs` | `turn-material.test.ts` ×3 | 2 |
| X3 | `message_end` buffers during preparation; the branch reads the turn's answer and drops the buffers | `extensions/index.ts` | `turn-material.test.ts` ×3 | 1 |
| X4 | `state.toolCallsThisTurn` moves into `resetTurnBuffers()`; `session_start` calls it after `restoreState` | `extensions/index.ts` | `turn-material.test.ts` ×3 | 1 |
| Y1 | `record-activity.ts`; `clear()` refuses; the menu stops offering it; the widget imports the same predicate | `pi-subagents-lite/src/agents/record-activity.ts` + 3 readers | `record-activity.test.ts` ×8 | 3 |

### The gates

```
                                    before    after
vendor/pi-subagents-lite   tests    207       215     lint 73/73 files
vendor/pi-loop-mode        tests    137       150
.pi/extensions/compaction-guard      39        39     (untouched)
                                   ─────     ─────
                                    383       404
```

All thirty-nine probes run clean — `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`,
`i1`–`i9`, `j1`–`j8`, `k1`–`k6` and `l1`–`l6`.

### Four things worth keeping from how these went

- **The first form of X2's fix broke the control, and that is how X5 was found.**
  Buffering `messageToRepetitionText(trackedMessage)` — the sanitized message,
  matching the two buffers beside it — made the *control* stop firing: the
  degenerate answer on a one-message turn was no longer detected. Chasing why led
  to `_replaceMessageInPlace` and to the fact that the rule had never been
  reachable. A control that fails on a fix is worth more than a control that
  passes; this one paid for the whole finding.
- **A harness is a claim about the host, and it should be checked like one.**
  `_host.mjs` is described in its own header as the thing that makes the probes
  "evidence about the shipped code rather than about a model of it". It was, for
  everything except the one hook the module under test uses to *change* what a
  later hook sees. The check is cheap and nobody had run it: read what pi does
  with each handler's return value, one event at a time.
- **Three questions about one message need three buffers, not two and a
  reinterpretation.** W1 added the second buffer because two questions had been
  sharing one string. X2 and X5 are the third question doing the same thing to the
  second. The unit test for whether a buffer is missing is whether any reader has
  to *reinterpret* what it was handed — `detectStuck` scanning "the answer, or the
  reasoning when there is no answer" for degeneracy is a reinterpretation.
- **Y1 is the same shape as the seventh pass, at the UI layer.** The widget's
  comment was right, in the right place, three months before the menu needed it —
  and the menu had its own copy of the predicate, so the comment could not reach
  it. Moving the predicate into a module both import is the only fix that stops
  the third reader appearing.

---

## 10. Running the evidence

```sh
cd ~/instantcoffee

# the gates
( cd vendor/pi-subagents-lite && npm test && node tests/lint.mjs )   # 215 + 73/73
( cd vendor/pi-loop-mode       && npm test )                         # 150
( cd .pi/extensions/compaction-guard && npm test )                   #  39

# just this pass's regression tests
( cd vendor/pi-loop-mode && node --experimental-strip-types --test tests/turn-material.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test tests/record-activity.test.ts )

# this pass's probes  (the loop's state is module-global — l1/l2/l4/l5 each
# reset it with /loop stop between scenarios, so one process is enough)
P=context/testing/probes
node --experimental-strip-types $P/l1-window-commits-the-trailing-thought.mjs
node --experimental-strip-types $P/l2-degenerate-rule-reads-one-message.mjs
node --experimental-strip-types $P/l3-degenerate-text-is-gone-before-the-rule-looks.mjs
node --experimental-strip-types $P/l4-goal-ready-read-off-the-last-message.mjs
node --experimental-strip-types $P/l5-tool-counter-survives-a-stop.mjs
node                            $P/l6-clearing-an-agent-mid-verification.mjs
```

| probe | what it showed | the control |
| --- | --- | --- |
| `l1` | four identical answers uncaught, and four different ones reported as repeated | the one-message turn, and the reasoning-only turn (V1/V2) |
| `l2` | a degenerate answer missed when one thought follows it | the same answer alone, and a clean answer with a thought |
| `l3` | the sanitized text the rule was reading, and the same thresholds on both sides | the other eight loop probes, unchanged by the harness fix |
| `l4` | a prepared spec left "(not prepared)" for the session | the one-message prepare turn, and a turn with no marker |
| `l5` | a starved turn at 90% counted as a successful iteration after a stop/resume | a fresh counter, and a turn that really called a tool |
| `l6` | the gate opened with `""` and the repair's session disposed | the same record with the phase cleared |

---

## 11. Still unwatched

Six more defects fixed against probes and tests, and none against a running
model — which is now true of every fix in the last five passes.

1. **A real verification.** Still the highest-value unwatched thing. One
   foreground delegation with `SUBAGENT_VERIFY_ROUNDS=1` and a deliberately
   off-task brief exercises a judge whose verdict parser (S2) and reason parser
   (U4) have both been repaired, a repair whose outcome crosses back (V5), a turn
   counter that no longer accumulates (U8), a session that no longer leaks when
   the provider drops the call (V7, W6), the note the parent reads (W5), and now
   the record's own clearability while it runs (Y1).
2. **The judge's raw reply is still not logged.** Top of the list since the fourth
   pass. Load-bearing for S2, U4, V5 and W5.
3. **A delegation with a loop running.** Fixed at the module level five times now
   — the loop's factory guard, V4, W1, and this pass's X1 and X2 — and never
   watched. It is the most informative it has ever been: the mid-turn steer that
   produces a two-message turn is a background subagent's result, so one run
   exercises V4, W1, X1 and X2 on the same turn.
4. **A reasoning-only turn in the wild, with the loop running.** The forge patch
   has been in the image since 2026-08-17. `j1`, `j2`, `k1` and now `l1` say what
   the module does with the shape; only a run says how often it arrives.
5. **A degenerate turn in the wild.** New, and now worth watching for the first
   time: rule 1 has never fired in a real session, so nobody has seen what the
   loop does after it does. The mid-stream kill switch (6 repeats) is the only
   part of that path with any live evidence behind it.
6. **`/loop prepare` followed by a delegation.** X3's path end to end.
7. **An operator steer to a RUNNING subagent**, which is W3's path — §J of the
   hand-testing script, still never run.
8. **Section I of `context/testing/subagents-loop-verifier.md`**, still never run,
   now eight passes old.
9. **Still open by decision, unchanged:** T5 (verification bounded at 300 s but
   uninterruptible — and now visibly so in `/agents`, which offers a verifying
   agent no action at all), T6 (`worktree_path` reach), T1's general case,
   per-session loop state, U9 (`Explore` has no shell).

---

## 12. The pattern across eight audits

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
   host ↔ harness             X5, Y1   the evidence models the host, and the model
                                       omits the one thing under test — or two
                                       readers model the same fact and only one
                                       was told
```

Three habits fall out of the eighth, and they are the transferable part.

**A harness is a claim, and the claim is testable.** `_host.mjs` says, in its own
header, that it makes the probes evidence about the shipped code. That was true of
every event it serves but one, and the one it omitted — that a `message_end`
handler's return value is written over the message `agent_end` later reads — is
precisely the mechanism the module under test uses, so the omission was perfectly
targeted at hiding a defect. The check is an hour's work and it is
mechanical: for each event the harness fakes, read what the host does with the
handler's return value, and replay it or write down why not.

**When a fix makes a control fail, the control is right.** X2's first form was the
obvious one — buffer the same message the two neighbouring buffers take — and it
made the degenerate answer stop being detected on a one-message turn. That is X5,
and it would have shipped as a silent regression of a rule that was already dead,
under a fix that claimed to widen it.

**The second reader of a fact is a design smell, not just a defect.** W1's lesson
was to grep for the other readers after a fix. Y1's is one step earlier: two
readers of "is this record still busy" existed because the question was answered
inline in two files. Fixing the second one keeps them agreeing until the third is
written. Moving the question into a module both files import is the only version
that ends.

---

## 13. Where to look

- `context/testing/probes/l1`–`l6` — the reproductions, one per finding, each
  printing BEFORE and NOW; and `_host.mjs`'s `applyMessageEndReplacement`, which
  is X5's other half.
- The regression tests: `vendor/pi-loop-mode/tests/turn-material.test.ts` (X1–X5)
  and `vendor/pi-subagents-lite/tests/record-activity.test.ts` (Y1).
- `vendor/pi-subagents-lite/src/agents/record-activity.ts` — the predicate, and
  the argument for why it is a module.
- `context/design/subagents-loop-verifier-readers.md` — the seventh pass (W1–W6,
  all fixed). Its §2.2 table is what X1 corrects: the `committedText` row was
  written from the intent of the function's comment rather than from its code.
- `context/design/subagents-loop-verifier-shapes.md` — the sixth pass (V1–V8). Its
  §2 drawing is what §2.2 here extends to nine readers.
- `context/design/subagents-loop-verifier-units.md` — the fifth pass (U1–U9). Its
  §9 reference sections are the detail this document does not restate.
- `context/design/subagents-loop-verifier-surfaces.md` — the fourth pass (S1–S10);
  `…-mechanics.md` — the third (T1–T9), still the best account of pi's own agent
  loop, and T2 is what X4 completes; `…-evaluation.md` — the second (F1–F11);
  `…-anatomy.md` — the first, and the design rationale.
- pi's own source, for X5: `dist/core/extensions/runner.js:610`
  (`emitMessageEnd`), `dist/core/agent-session.js:481` (the call) and `:425`
  (`_replaceMessageInPlace`, with the comment that names `agent_end` without
  naming it).
- `patches/forge_reasoning_passthrough.py` and commit `e81a7e5` — the wire change
  V1, V2, W1 and X1–X3 are all downstream of.
