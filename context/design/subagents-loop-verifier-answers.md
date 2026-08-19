# Subagents, the loop, and the verifier — the answer, and the messages nobody delivers

Ninth pass, 2026-08-18. A full read of the three components and the seams between
them, with **four findings (Z1–Z4) — all four fixed**, each with an executable
probe that prints BEFORE and NOW, and each with a regression test that fails when
the fix is removed.

**404 tests, lint 73/73 and thirty-nine probes caught none of the four.** The
suite is now **421**, lint is 77/77, and there are forty-three probes. §9 has what
shipped and the control-run failing count for each fix.

Three of the four live in one place, and it is the place the eighth pass told the
next session to look:

> The check is cheap and nobody had run it: read what pi does with each handler's
> return value, one event at a time.
> — `…-turns.md` §12

That check came back clean for the events the harness fakes. The same *question*,
asked one layer out — **what does pi do with each message the extension SENDS,
and what does it do with each turn boundary the extension READS?** — is where
Z1, Z2 and Z4 were. All three are cases where a module wrote something correct
into a pi API and pi's own plumbing quietly did not do what the call site's
comment said it did. None of them is visible from inside the module, and none of
them is visible to a harness that stops at the API boundary, which is exactly
where `_host.mjs` stops and where V4's probe and V4's test both stop.

The fourth, Z3, is an ordinary defect in a pure function — with the wrinkle that
the previous pass had written down the property it does not have.

---

## 0. How this sits next to the other eight documents

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
| eighth | `…-turns.md` (X1–X5, Y1) | between what the host does and what the harness that stands in for it does |

This one found a ninth, and it is the eighth one's twin on the other side of the
call: **between what an API call looks like it does and what the host does with
it.** The eighth pass found a handler whose *return value* pi used in a way
nobody had modelled. This one found three calls whose *arguments* pi routed in a
way nobody had modelled — a delivery mode with one drain site, a steer that
restarts a finished agent loop, and an index into an array pi rebuilds.

```
   X5  "a message_end handler's return value is written over the object
        agent_end reads"                                    ← what pi does with
                                                              what we RETURN

         ↳ the same question about what pi does with what we SEND:

   V4  "the stuck directive has to arrive, so queue it onto the turn that is
        already coming"
         ↳ queued with deliverAs:"nextTurn". pi drains that array in exactly
           one place — AgentSession.prompt(), the operator-typed path — so in
           an unattended run it never arrived at all, while the whole ladder
           was charged for it.                                            Z4

   fork "after each compaction, restate the brief into the child's freshly
        summarised context"
         ↳ session.steer() does not add context, it asks a question, and pi
           restarts a finished agent loop to answer it. pi never compacts
           mid-run, so the anchor only ever fired after the child had already
           answered — manufacturing a turn whose reply replaced the answer. T1
           and V6's argument, for the other steer in the package.          Z2

   W1  "the completion markers must read the TURN's answer, not the last
        message"
         ↳ the subagent side reads the run's answer off the LAST MESSAGE it
           streamed, and its fallback indexes into an array pi replaces on
           every compaction. §2.2 of the eighth pass lists this reader as
           "correct by construction".                                     Z1

   X5  "sanitizeDegenerateText and rule 1 share DEGENERATE_REPEATS, so
        everything the rule could match was already truncated"
         ↳ …but only for a LONG repeated unit. The cut had a 200-character
           floor, and 200 characters of a 20-character sentence is ten of
           them, so the sanitizer's own output was still degenerate and it
           had a fixed point it could not leave. §7's note that it "is
           idempotent on its own output" was wrong.                       Z3
```

Read the other eight documents for evidence, not orientation. Nothing they fixed
has come undone: all thirty-nine prior fixes are in the tree and their probes
still run clean.

---

## 1. The whole machine

The first drawing is the one this pass exists for: **every route by which a
message reaches a model, and who drains each queue.** Everything else in this
document hangs off it.

```
 ┌──────────────┐   ┌───────────────────────────────────┐   ┌────────────────┐
 │  llama.cpp   │──▶│ forge — the OpenAI-compatible      │──▶│      pi        │
 │  ONE slot    │   │ proxy on :8081                     │   │  0.84.2        │
 │  PARALLEL_   │   │ patches/forge_reasoning_           │   │                │
 │  SLOTS=1     │   │   passthrough.py  (e81a7e5)        │   │ reasoning_     │
 └──────────────┘   │ emits reasoning_content alongside  │   │ content ──▶    │
                    │ content, and a truthful            │   │ {type:         │
                    │ finish_reason                      │   │  "thinking"}   │
                    └───────────────────────────────────┘   └───────┬────────┘
                                                                    │
  ═══════════════════════════════════════════════════════════════════▼═══════════
   HOW ANYTHING REACHES THE MODEL — four routes, four drains, and only one of
   them is reachable without a human at a keyboard.                      [Z4]
  ══════════════════════════════════════════════════════════════════════════════

   pi.sendMessage(msg, options)                    AgentSession.sendCustomMessage
        │                                                   agent-session.js:1068
        ├─ deliverAs:"nextTurn" ──▶ _pendingNextTurnMessages
        │                             drained by   AgentSession.prompt()   :880
        │                             ▲ the OPERATOR-TYPED path, and nothing
        │                               else in the file touches this array
        │                                                              ← Z4
        ├─ isStreaming && triggerTurn !== false
        │     ├─ deliverAs:"followUp" ─▶ agent.followUp()  → _followUpMessages
        │     │                            drained by the agent loop's OUTER
        │     │                            while: getFollowUpMessages()
        │     └─ (default / "steer")  ─▶ agent.steer()     → _steeringMessages
        │                                  drained by the agent loop's INNER
        │                                  while: getSteeringMessages(), and by
        │                                  Agent.continue()'s assistant-last
        │                                  branch                agent.js:236
        ├─ triggerTurn (not streaming) ─▶ _runAgentPrompt(msg)    :744
        │                                  ▲ a whole new agent run
        └─ else ───────────────────────▶ push to agent.state.messages, emit
                                           message_start/message_end, no turn

   AgentSession.prompt(text)  ← what a HUMAN types, and what a subagent's own
        │                       runner calls once per run
        ├─ isStreaming ─▶ _queueSteer / _queueFollowUp  (the two queues above)
        └─ idle ───────▶ _checkCompaction(lastAssistant, false)          :865
                         messages = [user(text), ..._pendingNextTurnMessages]
                         emitBeforeAgentStart(...)  ← systemPrompt threaded
                         _runAgentPrompt(messages)

  ══════════════════════════════════════════════════════════════════════════════
   WHAT A "TURN" IS — three nested units, and the loop names the middle one
  ══════════════════════════════════════════════════════════════════════════════

   session.prompt()  ──▶  _runAgentPrompt                            :744
     │                      _isAgentRunActive = true
     │                      await agent.prompt(messages)
     │                      while (await _handlePostAgentRun())      :776
     │                          await agent.continue()
     │                      finally: _emitAgentSettled()  → agent_settled :327
     │                                _isAgentRunActive = false
     │
     ├── agent RUN #1   runAgentLoop        pi-agent-core/agent-loop.js
     │     agent_start
     │     turn_start
     │     ┌── inner while (hasMoreToolCalls || pendingMessages.length > 0)
     │     │     drain pendingMessages → message_start / message_end each
     │     │     streamAssistantResponse → message_start, message_update…,
     │     │                                message_end   ← ONE assistant MESSAGE
     │     │     executeToolCalls        → tool_result each
     │     │     turn_end
     │     │     pendingMessages = getSteeringMessages()
     │     └──
     │     outer while: getFollowUpMessages() → back into the inner loop
     │     agent_end   { messages: newMessages }   ← THE LOOP'S "TURN"
     │
     ├── _handlePostAgentRun:  _prepareRetry? _checkCompaction? queued msgs?
     │       └─ any of them true ─▶ agent.continue() ─▶ agent RUN #2 …
     │
     └── agent_settled                    ← the loop's deferred context recovery

   So: a MESSAGE is one assistant reply. A pi TURN is one message plus its tool
   results. An agent RUN is everything between agent_start and agent_end, and it
   is what `pi-loop-mode` counts as one iteration. A session.prompt() may contain
   SEVERAL agent runs, and that is where pi compacts.                    ← Z2

  ══════════════════════════════════════════════════════════════════════════════
   WHEN pi COMPACTS — two call sites, both OUTSIDE the agent loop            [Z2]
  ══════════════════════════════════════════════════════════════════════════════

   _checkCompaction(assistantMessage, skipAbortedCheck)   agent-session.js:1510
        ▲                                    ▲
        │                                    └── AgentSession.prompt()      :865
        │                                        before a new run starts
        └── _handlePostAgentRun()             :776
            AFTER agent_end, when the loop has already finished

   There is no third site. `prepareNextTurnWithContext` only refreshes the system
   prompt, tools and model. **pi never compacts between the turns of a run**, so
   the task anchor — which fires from `compaction_end` — could never land in the
   middle of a child's work. From `:865` it rides on the prompt that is about to
   run. From `:776` a steer RESTARTS the finished loop, because
   `_handlePostAgentRun` returns `agent.hasQueuedMessages()`.

  ══════════════════════════════════════════════════════════════════════════════
   ONE assistant MESSAGE, and the one hook that rewrites it in place       [X5]
  ══════════════════════════════════════════════════════════════════════════════

   { role:"assistant",
     content:[ {type:"text",text} | {type:"thinking",thinking} | {type:"toolCall"} ],
     stopReason:"stop"|"length"|"error"|"aborted", errorMessage?, usage:{output} }

     ExtensionRunner.emitMessageEnd     runner.js:610
       threads each handler's returned message into the NEXT handler's event
       rejects a replacement whose `role` differs, and keeps going
     AgentSession._emitExtensionEvent   agent-session.js:481
       normalizes content == null to [], then
     AgentSession._replaceMessageInPlace  :425
       delete every key of the object agent-core holds, Object.assign over it

   "Mutating this object in place keeps agent state, LATER TURN/AGENT EVENTS,
    listeners, and the eventual appendMessage persistence in sync."  ← pi's own
    comment. `agent_end`'s `messages` are those same objects.

  ══════════════════════════════════════════════════════════════════════════════
   THE THREE PACKAGES
  ══════════════════════════════════════════════════════════════════════════════

  ┌─────────────────┐   ┌────────────────────┐   ┌──────────────────────────┐
  │ prinny-channel  │   │ pi-loop-mode       │   │ pi-subagents-lite        │
  │ "said nothing"  │   │ 13 handlers        │   │ 3 tools, a widget, an    │
  │  = no text and  │   │ THREE per-turn     │   │ /agents menu, a slot     │
  │    no toolCall  │   │ buffers, drained    │   │ table, a watchdog, a     │
  │  (W1's shape,   │   │ in agent_end        │   │ spawn coordinator        │
  │   left as a     │   │  ← X1 X2 X3 X4 Z3   │   │  ← Y1 Z1 Z2              │
  │   decision)     │   │  ← Z4 (sendLoopTurn)│   │                          │
  └─────────────────┘   └────────────────────┘   └──────────────────────────┘
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
   │                   turnRepetitionTexts · turnToolCalls                    │
   │     pi-subagents  shell{pi,sessionCtx,manager,widget,store,coordinator}  │
   │     shell.ts      __PI_SUBAGENT_SPAWN_DEPTH__ on globalThis              │
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent tool call
   ┌──────────────▼────────┐    ┌─────────────────────────────────────────────┐
   │ SpawnCoordinator      │───▶│ AgentManager                                │
   │  live view · spawnCtx │    │  SlotTable (default 1) · queue              │
   │  awaits the gate (fg) │    │  Watchdog 45 min tool/idle                  │
   │  nudges (bg) ─────────┼──┐ │  completion gate per record                 │
   └───────────────────────┘  │ │  steer() ─ running ─▶ session.steer         │
                              │ │           └ settled ▶ continueSettledAgent  │
                              │ │  clear()  ─▶ removeRecord   (refuses ← Y1)  │
                              │ └────────────────┬────────────────────────────┘
                              │                  │ runAgent()
                              │  ┌───────────────┴───────────────────────────┐
                              │  │ enterSubagentSpawn()  ← depth > 0 ONLY here│
                              │  │   reloadAndMap()   → every ext factory     │
                              │  │   createAgentSession()                     │
                              │  │   onSessionCreated ← the capture (W6)      │
                              │  │   bindExtensions() → handlers, session_start│
                              │  │ exitSubagentSpawn()                        │
                              │  └───────────────┬───────────────────────────┘
                              │                  ▼
   ┌──────────────────────────┼───────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, in-memory SessionManager         │
   │    own system prompt · own tools · own window · own event bus            │
   │    ceiling maxTurns → wrap-up steer → hard abort graceTurns later        │
   │    runTurnLoop reads the RUN's answer, per message      ← Z1             │
   │    onCompaction steers the anchor only into a live run  ← Z2             │
   └──────────────────────────┼───────────────────────────────────────────────┘
                              │ settles — status TERMINAL, SLOT STILL HELD
                              ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                       │
   │    structural gate (free) → judge (fresh __verifier session, 1 turn)     │
   │    → repair (the child's own session, 1 turn) → judge again → …          │
   │    → verificationNote(kind, attempts) — the parent's only view of it     │
   │    throughout: status reads `completed`, completedAt is UNSET, and       │
   │    verifyPhase is the only field that says a model call is in flight     │
   └──────────────────────────┬───────────────────────────────────────────────┘
                              │ .finally: release slot, tally, drain queue, gate
                              ▼
        foreground ─→ Agent tool result       background ─→ capBackgroundResult()
                                                          ─→ pi.sendMessage(
                                                               deliverAs: parent
                                                               idle ? followUp
                                                                    : steer,
                                                               triggerTurn:true)
                                                             └─ lands INSIDE the
                                                                parent's running
                                                                turn. That is the
                                                                two-message turn
                                                                W1/X1/X2/X3 are
                                                                about, and the
                                                                pending message
                                                                Z4 is about.
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, the anchor's manufactured turn, and the parent's next call are five
things in one queue. Every finding in this pass costs a place in that queue or a
message that never reaches it.

---

## 2. The loop (`vendor/pi-loop-mode`)

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool. Its whole job is deciding what a turn's outcome *was*, and then getting one
sentence to the model about it.

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
  message_end             sanitize; buffer the message THREE ways  [X1 X2 X3][Z3]
  agent_end               THE LADDER — §2.4
```

### 2.2 One turn, read nine ways

One turn, two messages, and what each consumer takes out of it. Unchanged from
the eighth pass except for the last two rows, which are what Z1 corrects.

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

   message_end                   messageToRepetitionText(m)       A,B      A,B
     ↳ turnRepetitionTexts         text AND thinking, ORIGINAL   [X2][X5]
       (what the model produced)

   agent_end  committedText      commitTurnMemory(texts,calls,     A        A
     ↳ detectStuck rules 3–8       answers)                       [X1]
       and the WINDOWS              last ANSWER, else last tracked

   agent_end  turnAnswerText     last of turnAnswerTexts           A        A
     ↳ emptyResponse                ?? messageToText(last)         [W1]
     ↳ /LOOP_DONE:/ /LOOP_BLOCKED:/

   agent_end  turnEmittedTexts   turnRepetitionTexts              A,B      A,B
     ↳ detectStuck rule 1           ?? [messageToRepetitionText     [X2]
       (degenerate repetition)        (last)]
     ↳ reasoningOnlyResponse,
       and its char count

   agent_end  lastAssistantText  messageToText(lastAssistant)      ""       ""
     ↳ the model-error reason line   the LAST MESSAGE only
     ↳ the fallback for the two buffers above

   agent_end  prepText           last of turnAnswerTexts           A        A
     ↳ /GOAL_READY:/                ?? messageToText(last)         [X3]

   subagents  runTurnLoop        collectResponseText              B  ✗    A  ✓
                                   reset on EVERY message_start   [Z1]
                                   ↳ now one entry per message,
                                     last non-empty wins

   subagents  the fallback       getLastAssistantText(session,     "" ✗    A  ✓
                                   messageStart)                  [Z1]
                                   ↳ now the run's OWN messages,
                                     held by reference
   ──────────────────────────────────────────────────────────────────────────────
```

### 2.3 The three buffers, and why there are three

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
   │ turnRepetitionTexts                  │   │ turnEmittedTexts                 │
   │   messageToRepetitionText(m)         │──▶│   the list, else                 │
   │   text AND thinking                  │   │   [messageToRepetitionText(last)]│
   │   the ORIGINAL message         [X5]  │   │   → detectStuck rule 1, per entry│
   │   "what did the model produce"       │   │   → reasoningOnlyResponse + chars│
   └──────────────────────────────────────┘   └──────────────────────────────────┘

   The third takes the ORIGINAL because `message_end` returns a SANITIZED
   replacement and pi writes it over the object `agent_end` reads. The first two
   want the sanitized text: it is what the model sees next turn, and it is what
   the repetition window should hold.

   Z3 is about the OTHER side of that: what the sanitizer actually leaves behind.
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

   TEN of those exits end in `if (!ctx.hasPendingMessages()) scheduleLoopTurn(…)`.
   The guard is right for all of them — the loop only needs *a* turn, and a
   pending message will cause one, which §8 re-verifies against pi. The ONE exit
   that needs its own TEXT delivered is `interveneStuck`'s strategy rung, and
   that is Z4.
```

### 2.5 `detectStuck` — eight rules, and what each one reads

The first that matches wins, and its text becomes both the operator's notice and
the model's directive.

```
   #  rule                                    reads                    fixed by
   ──────────────────────────────────────────────────────────────────────────────
   1  detectDegenerateRepetition(t, 4)        EVERY message of the     [X2][X5]
      sentence / word / phrase                turn, ORIGINAL text      [Z3]
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

   Rule 1 is the only one about a single RESPONSE rather than about the turn's one
   committed entry, which is why it reads the third buffer. Z3 is about what that
   buffer's SANITIZED twin leaves in the transcript afterwards — the rule fires
   correctly and the repetition stays in the context anyway.
```

### 2.6 The escalation ladder, and where its directive goes

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
                       ? sendLoopTurn(…, {queueOnly:true})               V4
                       :                                                 ← Z4
                         scheduleLoopTurn("stuck", delay, ctx)

                       queueOnly BEFORE: deliverAs "nextTurn"
                                          → _pendingNextTurnMessages
                                          → drained ONLY by prompt()
                                          → an unattended loop never types
                       queueOnly NOW:    deliverAs "steer", triggerTurn true
                                          → agent.steer()
                                          → _handlePostAgentRun → continue()
                                          → the SAME turn as the pending message
```

Every rung is charged before any of them runs, which is what makes both X1's false
positive and Z4's undelivered directive expensive: the streak advances, three
turns of sampling penalties are armed, `turnsWithoutTools` is reset, and the
operator is told "injecting new strategy".

### 2.7 The context ladder

```
  1. TELL THE MODEL        context handler, every provider call
       >= 60%  advisory line, appended last (cached prefix untouched)
       >= 80%  CRITICAL wording
       pi-loop-mode and compaction-guard both inject one; whichever runs second
       sees the other's `-context-budget` customType suffix and stands down.
       pi hands the handler a structuredClone (runner.js:747), so nothing here
       is ever written back — §8.

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

```
                          turn      turn      turn      state.        context
                          Assistant Answer    Repetition toolCalls    Recovery
                          Texts     Texts     Texts      ThisTurn     markers
  ────────────────────────────────────────────────────────────────────────────────
  agent_end (top)          ✓         ✓         ✓          ✓            ✗
                           ─────── resetTurnBuffers() ───────
  runLoop                  ✓         ✓         ✓          ✓            ✓
  finalizeSoftStop         ✓         ✓         ✓          ✓            ✓
  /loop stop               ✓         ✓         ✓          ✓ ← [X4]     ✓
  /loop end                ✓         ✓         ✓          ✓ ← [X4]     ✓
  session_start            ✓         ✓         ✓          ✓ ← [X4]     ✓
                           …AFTER restoreState, which brings a
                              persisted mid-turn count back  ← [X4]
  session_shutdown         ✓         ✓         ✓          ✓ ← [X4]     ✓
  /loop resume             ✗ (never filled while inactive)  via stop   ✓
  /loop finish (idle)      ✗         ✗         ✗          ✗            ✗   §7
  ────────────────────────────────────────────────────────────────────────────────

  `/loop finish` while `ctx.isIdle()` is the tenth transition and the second one
  missing from this table — the eighth pass found `/loop resume` was missing and
  this pass found its neighbour. Neither is a defect today: idle means `agent_end`
  has already drained the buffers, and every path that can leave a recovery marker
  set clears it in its own callback. Recorded because the next person to add
  per-turn state will read this table. §7.

  `degenerateAbortPending` is deliberately NOT in resetTurnBuffers: it is set by
  message_update mid-stream and consumed by a branch of agent_end that runs BELOW
  the drain, so clearing it with the buffers would delete the flag before the
  handler that reads it.
```

---

## 3. Subagents (`vendor/pi-subagents-lite`)

64 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
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
    │                    runSessionPrompt → wireTurnTracking + runTurnLoop  ← Z1
    ▼
  .then                  status ← classifyRun(result)     ← TERMINAL FROM HERE
    │                    result := responseText                          ← Z1
    │                    ┌──────────────────────────────────────────────────┐
    │                    │ runVerification()      ← the record's SECOND run │
    │                    │   verifyPhase "judging" / "repairing"             │
    │                    │   status says completed · completedAt UNSET       │
    │                    │   stopAgent() returns false · watchdog drops state│
    │                    │   clear() REFUSES                           ← Y1  │
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
so a foreground `Agent` call can never hang on a record that will not settle.

**Z1 is what flows through that gate.** `record.result` is `responseText`, and
`responseText` is whatever `runTurnLoop` decided the run said. Everything
downstream — the tool result the parent model reads, the background nudge, the
judge's candidate, the repair's baseline, `/agents`' "View result", the output
log — is that one string.

### 3.2 What a run says, and how the runner decides

This is the section Z1 rewrites. The chain from a token on the wire to
`record.result`:

```
   provider stream                     pi                       the runner
   ───────────────────────────────────────────────────────────────────────────
   text_delta ─────────▶ message_update {assistantMessageEvent} ─┐
                                                                 │ collectResponseText
   done ───────────────▶ message_end   {message: finalMessage}  ─┤ src/agents/
                                                                 │  run-answer.ts
   a drained steer ────▶ message_start {message: role "user"}   ─┘
                                     ▲
                                     └── this is the one that matters

   BEFORE                                  NOW
   ──────────────────────────────────      ──────────────────────────────────
   let text = ""                           const answers: string[] = []
   message_start  → text = ""              message_start  → flush(): push text
                                                            if it said anything
   text_delta     → text += delta          text_delta     → text += delta
                                           message_end(assistant)
                                                          → keep the message
   getText() → text                        getText() → flush(); last of answers
                                           getLastMessageText() → walk the
                                             kept messages back to text

   runTurnLoop returns
      collector.getText().trim() || <the fallback>

   BEFORE the fallback was getLastAssistantText(session, messageStart), with
   messageStart = session.messages.length taken before the prompt. pi REPLACES
   that array on a compaction (agent-session.js:1435, :1673), so the index
   pointed past the end of a shorter array and the fallback returned "".
```

Two injected user messages exist inside a child's own run, and they are not the
same kind of thing:

```
   TURN_LIMIT_STEER   "You have reached your turn limit. Wrap up immediately —
                       provide your final answer now."
                      the reply to this IS the answer.        ✔ last non-empty
                                                                still picks it

   the task ANCHOR    "[task anchor — the context was just compacted, so this
                       restates the task you are working on. Nothing here is new
                       work.]"
                      the reply to this is NOT the answer.    ✘ no reader can
                                                                tell — fixed at
                                                                the writer, Z2
```

### 3.3 The turn ceiling, as a state machine

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

`shouldSteerAtSoftLimit` is T1's and V6's rule — *"there is no wrap-up to ask for,
and asking manufactures a turn"* — and Z2 is that rule finally being applied to
the other steer in the package. §3.5.

### 3.4 `steer()` — three branches, one brief

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
     │
     └── terminal ────────────▶ continueSettledAgent(record, message)
                                 · re-reserve the slot
                                 · growBrief(record, message)
                                 · record.verification := undefined
                                 · restart the watchdog
                                 · re-attach the settlement chain
                                 · runSessionPrompt again        ← Z1 applies
                                   here too, and this is the path where
                                   `messageStart` was never 0

   record.execution.brief has three readers and all three are consequential:
       verifyAnswer(record, brief, deps)   what the answer is CHECKED against
       buildRepairPrompt(brief, why)       what the child is told to answer
       buildAnchorMessage(brief)           what is restated after a compaction
```

### 3.5 The task anchor, and the turn it used to manufacture

```
  AgentManager.runTrackingCallbacks.onCompaction
     record.stats.compactionCount++
     if (brief && session && anchorReachesATurn(info))          ← Z2
         session.steer(buildAnchorMessage(brief))

  src/agents/compaction-anchor.ts
     anchorReachesATurn(info) = info.afterRun !== true || info.willRetry === true

  and `afterRun` is reported by the runner, from pi's own events:

     subscribeToSessionEvents
        agent_start → afterRun = false
        agent_end   → afterRun = true
        compaction_end → onCompaction({reason, tokensBefore, afterRun, willRetry})

  ┌── why the flag exists ───────────────────────────────────────────────────┐
  │                                                                          │
  │  pi's TWO compaction call sites (§1) and what a steer does at each:      │
  │                                                                          │
  │   prompt()               :865   idle, a run is about to start            │
  │      steer → _steeringMessages → the new run's first getSteeringMessages │
  │      → injected alongside the prompt, no extra turn.        ✔ the design  │
  │                                                                          │
  │   _handlePostAgentRun()  :776   the agent loop has emitted agent_end     │
  │      steer → _steeringMessages → hasQueuedMessages() is now TRUE         │
  │      → agent.continue() → assistant-last branch drains the queue and     │
  │        runs it as a prompt → a WHOLE EXTRA AGENT RUN                     │
  │      → and its reply is the run's last message, so (before Z1) it was    │
  │        `responseText`, and (after Z1) it is still the last NON-EMPTY     │
  │        answer, because "Understood — nothing further to add." is not     │
  │        empty.                                            ✘ Z2            │
  │                                                                          │
  │  `willRetry` is the one case where :776 still gets the anchor: pi has    │
  │  already decided to re-run the interrupted turn, so the continuation     │
  │  happens whether or not the anchor is queued.                            │
  └──────────────────────────────────────────────────────────────────────────┘
```

### 3.6 Concurrency

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

### 3.7 What a child inherits

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
   record settles ─▶ record.result = responseText          ← Z1 decides this
                        │
                        ▼
   ┌──── structuralVerdict(answer, lifecycle) ─────────────────────────────┐
   │  answer trims to ""      ─▶ ok:false            skipped-empty          │
   │                              (the note REPLACES the answer)     ← Z1   │
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
   │                      │              …and runTurnLoop again      ← Z1  │
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

**Why Z1 and Z2 land hardest here.** The verifier's whole subject is
`record.result`. A child that compacted at the end of its run handed it
"Understood — nothing further to add." — a non-empty answer from a clean run, so
the structural gate passes it straight to the judge, which correctly rules
NOT_ADDRESSED, which spends a repair round (two more model calls on the one slot),
which runs in the child's own session, which may itself end above the compaction
threshold. And the answer the parent finally receives is the ORIGINAL —
"Understood — nothing further to add." — annotated *"this answer was checked
against the task and did not address it … Treat it as unreliable."*

Every one of those steps is working exactly as designed. The input was wrong.

### 4.2 The note vocabulary, which is the parent's only view of any of this

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
   skipped-empty     ⊘ empty answer   warning    (REPLACES the answer)   ← Z1
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
per-call deadline does. (That is T5, still open by decision, and Y1 is what it
costs at the UI layer: `/agents` now offers a verifying agent no action at all.)

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
   │  run     agent RUN #1: turn 1 … turn k           │          │
   │            ← llama, one at a time                │          │
   │            an operator steer lands mid-run       │          │
   │            turn maxTurns → wrap-up steer         │          │
   │          agent_end                               │          │
   │                                                  │          │
   │  ── _handlePostAgentRun ──────────────────────── │          │
   │     retry?  compaction?  queued messages?        │          │
   │       compaction at >= the threshold             │          │
   │         BEFORE: → anchor steered → agent RUN #2, │          │
   │                  one whole model call, and its   │          │
   │                  reply became the answer   ← Z2  │          │
   │         NOW:    → the compaction is counted, the │          │
   │                  anchor is not sent, RUN #1's    │          │
   │                  answer stands                   │          │
   │                                                  │          │
   │  settle  status ← classifyRun(result)            │          │
   │          result ← the RUN's answer         ← Z1  │          │
   │                                                  │          │
   │  verify  judge   ← a WHOLE extra session + 1 turn│          │
   │          repair  ← 1+ turns in the CHILD's       │          │
   │          judge   ← again                         │          │
   │            ── unstoppable (T5), and not          │          │
   │               clearable from /agents (Y1)        │          │
   │                                                  │          │
   │ ══════════════════════ SLOT RELEASED ══════════  │          │
   └──────────┬───────────────────────────────────────┘          │
              │ tally · drainQueue · openGate ─────────────────▶ │
              │                                                  │
              │ (background instead: capBackgroundResult →        │
              │  pi.sendMessage deliverAs steer|followUp,         │
              │  triggerTurn:true — and if the parent is BUSY     │
              │  that lands inside the running turn. That turn    │
              │  is X1/X2/X3's two-message turn AND the pending   │
              │  message that sends interveneStuck down Z4's      │
              │  branch.)                                         │
```

---

## 6. Findings

Severity is about what it costs a real run. Evidence is **PROVEN** (an executable
probe drives the shipped module), **MEASURED** (a number taken from the tree), or
**SOURCE** (read, with the reasoning in the finding).

| # | Finding | Sev | Evidence | Probe | Sibling of | Fixed |
| --- | --- | --- | --- | --- | --- | --- |
| Z1 | a subagent hands back the LAST MESSAGE it streamed, not the run's answer — and the fallback that was supposed to save it indexes into an array pi replaces on every compaction, so it returns `""` | **HIGH** | PROVEN | `m1` | W1, X1 | ✔ |
| Z2 | the task anchor is steered into a run that has already ended, which manufactures a whole extra turn on the one llama slot — and its reply becomes the child's answer | **HIGH** | PROVEN·SOURCE | `m2` | T1, V6 | ✔ |
| Z3 | `sanitizeDegenerateText` had a 200-character floor, so for a short repeated unit its own output was still degenerate — a fixed point it could not leave, re-sent to the model every turn | **MEDIUM** | PROVEN | `m3` | X5 | ✔ |
| Z4 | the stuck directive V4 queues is sent `deliverAs: "nextTurn"`, and pi drains that queue only in `AgentSession.prompt()` — the operator-typed path. An unattended loop never delivers it, while the whole ladder is charged | **HIGH** | PROVEN·SOURCE | `m4` | V4, X5 | ✔ |

---

### Z1 — the child's answer is the last message it streamed · **HIGH** · PROVEN · **FIXED**

**Where.** `runTurnLoop` at `agent-runner.ts:652` and `collectResponseText` at
`:151`, now `src/agents/run-answer.ts`.

**What.** `runTurnLoop` ends:

```js
  return collector.getText().trim() || getLastAssistantText(session, messageStart);
```

and `collectResponseText` kept ONE string, reset on every `message_start`:

```js
  if (event.type === "message_start") { text = ""; }
  if (event.type === "message_update" && …type === "text_delta") { text += delta; }
```

`message_start` is not "a new assistant reply". pi emits one for **every message
it drains out of the steering or follow-up queue** as well
(pi-agent-core `agent-loop.js`, inside the inner `while`), and it emits one for
the prompt itself. So the buffer holds the text of the LAST message of the run,
whatever that message was a reply to.

This package injects two such messages into a child's own run. One of them — the
turn-limit steer — asks for the answer, so the reply to it *is* the answer. The
other — the task anchor — says *"Nothing here is new work"*, and the reply to it
is an acknowledgement. Nothing in the reader can tell them apart.

**And the fallback could not save it.** `messageStart` is
`session.messages.length` taken before `session.prompt()`, with a comment
explaining that it must not surface an earlier run's text. pi does not splice that
array on a compaction — it **replaces** it:

```
   AgentSession.compact()          agent-session.js:1435
   AgentSession._runAutoCompaction         :1673
       this.agent.state.messages = sessionContext.messages;
```

`sessionContext` is rebuilt from the compacted branch, so it is a new, shorter
array. `getLastAssistantText(session, messageStart)` then loops
`for (i = messages.length - 1; i >= messageStart; i--)` over an array whose length
is *below* `messageStart`, does not execute once, and returns `""`.

An empty answer is not a small thing on the way out: `structuralVerdict("")`
returns `ok: false` and the note **replaces** it, so the parent is told *"The
agent returned no answer at all. This is usually a saturated context, not a hard
task — re-task it with a narrower question rather than repeating this one."*

**The eighth pass's own drawing says otherwise.** `…-turns.md` §2.2 lists this
reader as `collectResponseText(text_delta) || getLastAssistantText(…) which walks
BACK to text`, taking `A` — the answer — and calls it *correct by construction*.
The fallback does walk back to text. It is only reached when the collector came
back empty, and the collector comes back empty only in the case where the index
is also broken.

**Proved.** `m1`, driving the shipped `continueAgentSession` — the real
`runSessionPrompt` and `runTurnLoop` — with a session stub that emits the event
sequence pi emits:

```
   control — the child answers and stops                        the ANSWER

   an injected message and a reply to it
     the child acknowledges the anchor                          NOT the answer

   the same turn with a reasoning-only reply (the FALLBACK runs)
     BEFORE  compaction shrank session.messages                 NOTHING  ""
     NOW                                                        the ANSWER
     control — same turn, no compaction                         the ANSWER
     control — first run (messageStart = 0)                     the ANSWER
```

**What it costs.** Two shapes, and the second is worse because it is silent.

- **Wrong answer:** the parent, the judge, the repair's baseline, `/agents`' View
  result and the output log all receive an acknowledgement instead of the work.
  The judge then correctly rules it off-task, a repair round is spent, and the
  parent ends up holding the acknowledgement labelled *unreliable*.
- **No answer:** a settled, successful child is reported to its parent as having
  "returned no answer at all", with advice to re-task it. The work was done and
  is still in the session; nothing reads it.

Both need a compaction, and the population that compacts is exactly the population
the verifier exists for.

**The fix.** One entry per message, last non-empty wins — the same repair
`turnAnswerTexts` is in `pi-loop-mode`:

```js
  const answers: string[] = [];
  const flush = () => { if (text.trim()) answers.push(text); text = ""; };
  …
  getText: () => { flush(); return answers.length > 0 ? answers[answers.length - 1] : ""; },
```

and the fallback holds the run's own assistant messages by reference, collected
from `message_end`, instead of an index into a list pi rebuilds:

```js
  getLastMessageText: () => { for (let i = messages.length - 1; i >= 0; i--) { … } }
```

Scoping by identity rather than by arithmetic is what makes the comment true
again: the collector only ever saw THIS run's events, so it cannot resurrect an
earlier run's text however pi reshapes `session.messages`.

The module moved to `src/agents/run-answer.ts` so it can be tested at all —
`agent-runner.ts` imports `@earendil-works/pi-coding-agent`, which does not
resolve under the plain `node --experimental-strip-types --test` the suite runs
on. That is the same move `turn-tracking.ts`, `record-activity.ts` and `verify.ts`
made, for the same reason.

*Tests:* `vendor/pi-subagents-lite/tests/run-answer.test.ts`. Seven cases, three
of which fail without the fix; the controls are the turn-limit steer (where the
reply to the injected message IS the answer and must still win), a run that said
nothing at all, and the live view's per-message `onTextDelta`.

---

### Z2 — the anchor is steered into a run that has already ended · **HIGH** · PROVEN·SOURCE · **FIXED**

**Where.** `AgentManager.runTrackingCallbacks.onCompaction` at
`agent-manager.ts:747`, against pi's `agent-session.js:776/865` and
`agent.js:236`.

**What.** `session.steer()` is not a way to put text in a context. It is a way to
put text in a context **and get an answer to it** — and when the agent loop has
already finished, it restarts it:

```
  AgentSession._handlePostAgentRun   agent-session.js:781
      // The agent loop drains both queues before emitting agent_end. Any messages
      // here were queued by agent_end extension handlers and need a continuation.
      return this.agent.hasQueuedMessages();
  AgentSession._runAgentPrompt              :744
      while (await this._handlePostAgentRun()) await this.agent.continue();
  Agent.continue                       agent.js:236
      if (lastMessage.role === "assistant") {
        const queuedSteering = this.steeringQueue.drain();
        if (queuedSteering.length > 0) { await this.runPromptMessages(queuedSteering, …); return; }
```

**And pi never compacts mid-run.** `_checkCompaction()` has exactly two call
sites, and both are outside the agent loop:

```
   _handlePostAgentRun()   :776   AFTER agent_end — the run has finished
   prompt()                :865   BEFORE the next run starts
```

`prepareNextTurnWithContext` only refreshes the system prompt, tools and model.
There is no third site. So the anchor — which fires from `compaction_end`, which
only ever fires from those two — could **never** land in the middle of a child's
work, which is what the layer's own header describes it as doing.

From `prompt()` it rides on the prompt about to run: correct, and that is the
continuation case (a repair, or an operator steering a settled agent). From
`_handlePostAgentRun()` it buys a whole extra agent run — one more model call on
the single llama slot the parent is blocked behind — and the reply to it becomes
the child's answer, by Z1.

**This is T1's and V6's argument, for the other steer in the package.**
`turn-tracking.ts`'s header already says it, about `TURN_LIMIT_STEER`:

> With `maxTurns: 1` it does not [work], and the difference is not cosmetic. …
> A single-turn run therefore takes a SECOND provider call, and
> `collectResponseText` resets on the injected user message's `message_start`, so
> the text handed back is the reply to "wrap up" rather than the answer.

Every clause of that paragraph is true of the anchor. It was written about one
steer and applied to one steer.

**Proved.** `m2`, driving the real `AgentManager.runTrackingCallbacks` through the
real `subscribeToSessionEvents`:

```
   BEFORE   every row steered the anchor.

   NOW
     the child answered, then pi compacted            anchor steered: no
     control — a continuation, compacted on the way in   anchor steered: YES
     control — overflow compaction with willRetry        anchor steered: YES
     control — agent_end, then agent_start, then a compaction  anchor steered: YES

   the compaction is counted on the record in every row, before and after.
```

**What it costs.** For every child that finishes above pi's compaction
threshold — which for a 27B on a 32k window is any child that read more than a
handful of files:

- one extra model call on the one slot, serialized ahead of the judge, the
  repair, and the parent's next turn;
- the child's answer replaced by whatever it said to *"Nothing here is new work"*;
- and then, downstream, a judge that rules that off-task and a repair round spent
  on it — three more calls, all correct, all about the wrong text.

**The fix.** The runner reports which call site the compaction came from, and the
manager only steers when a turn was going to happen anyway:

```js
  // src/agents/compaction-anchor.ts — imports nothing, three readers cannot drift
  export function anchorReachesATurn(info) {
    return info.afterRun !== true || info.willRetry === true;
  }
```

`afterRun` is not inferred, it is observed: `subscribeToSessionEvents` sets it
`false` on `agent_start` and `true` on `agent_end`, so if pi ever *does* compact
mid-run the anchor fires exactly as before. `willRetry` is the one exception and
it is the same rule rather than a carve-out — pi has already decided to re-run the
interrupted turn, so the continuation is not the anchor's doing.

The predicate lives in its own module for Y1's reason: *the second reader of a
fact is a design smell.* The manager cannot be loaded under plain node, so a
predicate inline in it is a predicate nothing can test.

**What this gives up, and it is worth stating.** After the fix a single-run child
never receives an anchor at all — because there was never a moment in a
single-run child's life when one could help. The layer keeps working where it
always worked: continuations, which are prompts into a session that has already
been summarised. `verify.ts`'s header carries this correction inline.

*Tests:* `vendor/pi-subagents-lite/tests/compaction-anchor.test.ts`. Four cases,
one of which fails without the fix; the controls are the two call sites that must
keep the anchor and a caller that supplies neither flag, which must read as
reachable so the layer cannot be switched off by an omission.

---

### Z3 — the sanitizer left the repetition in · **MEDIUM** · PROVEN · **FIXED**

**Where.** `sanitizeDegenerateText` at `src/repetition.ts:113`.

**What.** The cut was:

```js
  const keepLength = Math.max(200, Math.min(text.length, Math.ceil((text.length / info.repeats) * 2)));
```

— *"about two copies of the repeated unit, but never less than 200 characters"*.
The floor is the defect. Two hundred characters of a twenty-character sentence is
ten of them, and `DEGENERATE_REPEATS` is 4, so for any repeated unit shorter than
about fifty characters the **output was itself degenerate**. Running the function
on its own output cut it again to the same 200-character floor and returned the
same text: a fixed point it could not leave, still repeating, under a marker
announcing that the repetition had been truncated.

Short units are not the unusual case. They are the ordinary shape of a model that
has fallen into a loop: *"Still working on it."*, *"Let me try again."*, *"I will
now check the file again."*

**And X5's mechanism carries it into the transcript.** `message_end` returns the
sanitized message and pi writes it over the object it holds
(`_replaceMessageInPlace`), so what stays in the child's — or the operator's —
history, and is re-sent on every turn afterwards, is still a run of the repeated
sentence. That is the one thing this function exists to prevent; its own header
says *"Repeated text or thinking would otherwise reinforce the pattern each
turn."*

**The eighth pass wrote down the property it does not have.** `…-turns.md` §7:

> **The `context` handler's sanitizer can therefore truncate the same text
> twice** … but `sanitizeDegenerateText` is idempotent on its own output (the
> marker is one line and the repetition is gone), so the second pass is a no-op.

It is idempotent for the example that pass was working with — a 52-character
sentence repeated nine times, where `2 × unit` clears the floor — and for nothing
shorter.

**Proved.** `m3`, which computes BEFORE from the old formula rather than
remembering it:

```
  20 × a 20-char sentence
     the model produced       419 chars   20× "still working on it."
     BEFORE  what was stored  328 chars    9× "still working on it."
     NOW     what is stored   206 chars   clean

  12 × a 32-char sentence
     the model produced       395 chars   12× "i will now check the file ag"
     BEFORE  what was stored  339 chars    6× "i will now check the file ag"
     NOW     what is stored   262 chars   clean

  control — 9 × a 52-char sentence (the eighth pass's own example)
     BEFORE  what was stored  367 chars   clean
     NOW     what is stored   406 chars   clean

  the other direction — a real answer, then the model falls into a loop
     the model produced       754 chars   20× "let me check again."
     BEFORE  what was stored  327 chars   clean   the answer is CUT
     NOW     what is stored   574 chars   clean   the answer SURVIVES
```

The last row is the other half. The old formula assumed the repetition was the
whole message — `text.length / repeats` is only the unit length if it is — so a
real answer followed by a short run of junk had the answer cut off with it at 200
characters.

**What it costs.** The repetition the detector correctly found stays in the
context and is re-sent on every subsequent turn, on a stack whose context budget
is the thing everything else in this document is arranged around. It also
degrades the *other* direction of the same handler: a genuine answer that ends in
a stutter loses the answer.

**The fix.** Search for the longest prefix whose sanitized form is not itself
degenerate:

```js
  function cleanPrefixLength(text, marker) {
    const clean = (n) => !detectDegenerateRepetition(`${text.slice(0, n).trimEnd()}\n\n${marker}`, DEGENERATE_REPEATS);
    let low = 0, high = text.length;
    if (clean(high)) return high;
    while (high - low > 16) { const mid = (low + high) >> 1; if (clean(mid)) low = mid; else high = mid; }
    return low;
  }
```

That computes the same intent the old arithmetic was approximating — *keep the
text up to where the repetition takes over* — without assuming the repetition
starts at character 0 or spans the whole message. `low = 0` is clean by
construction, because `detectDegenerateRepetition` returns undefined below 150
normalized characters and the marker alone is shorter than that; the marker is
inside the predicate because it quotes the unit once and a prefix one repeat below
the threshold plus the marker can cross it. Eight detector runs on a 4 kB message.

*Tests:* `vendor/pi-loop-mode/tests/degenerate-sanitizer.test.ts`. Six cases, four
of which fail without the fix; the controls are the eighth pass's own example
(already clean, must stay clean and must still report the count the model
produced, not the count kept) and a message with no repetition (untouched).

---

### Z4 — the queued directive nobody drains · **HIGH** · PROVEN·SOURCE · **FIXED**

**Where.** `sendLoopTurn` at `extensions/index.ts:562`, against pi's
`agent-session.js:880`, `:1079` and `:1089`.

**What.** V4 established that `interveneStuck`'s strategy rung charges the whole
ladder unconditionally and used to deliver its directive only
`if (!ctx.hasPendingMessages())`, with no else — so with a message pending (the
ordinary state while a background subagent's result is queued) the ladder climbed
to a rescue-model switch at streak 3 and a compaction at streak 5 having never
once sent the cheap rung. Its fix queues the directive instead:

```js
  const options = opts.queueOnly ? { deliverAs: "nextTurn" as const } : …
```

pi has **exactly one** drain for `_pendingNextTurnMessages`, and it is inside
`AgentSession.prompt()`:

```js
  // agent-session.js:868  — AgentSession.prompt(text, options)
  messages = [];
  messages.push({ role: "user", content: userContent, timestamp: Date.now() });
  // Inject any pending "nextTurn" messages as context alongside the user message
  for (const msg of this._pendingNextTurnMessages) messages.push(msg);
  this._pendingNextTurnMessages = [];
```

That is the operator-typed path. Nothing the loop can do reaches it:

| what the loop does | where it goes | drains nextTurn? |
| --- | --- | --- |
| `sendMessage(…, {deliverAs:"nextTurn"})` | `_pendingNextTurnMessages.push` `:1079` | no |
| `sendMessage(…, {triggerTurn:true})` while idle | `_runAgentPrompt(msg)` `:1089` | **no** |
| `sendMessage(…, {deliverAs:"followUp"})` while busy | `agent.followUp()` | no |
| a pending message causing a turn | `_handlePostAgentRun` → `agent.continue()` | no |
| `Agent.continue()`'s assistant-last branch | `runPromptMessages(queuedSteering)` | no |
| **a human typing** | `AgentSession.prompt()` `:880` | **yes** |

So the directive was queued and never delivered, in exactly the mode of operation
the loop exists for. It was not visible to the operator either: a queued message
is not appended to the transcript until it is drained, so the only trace was the
notice claiming a strategy had been injected.

**Why the probe and the test could not see it.** `j4` asserts what
`pi.sendMessage` was *called with*; `stuck-ladder.test.ts` asserted
`{ deliverAs: "nextTurn" }` exactly. Both stop at the API boundary. That is the
eighth pass's finding in its other form: X5 was the harness not replaying what pi
does with a handler's **return value**; this is the harness not modelling what pi
does with a call's **arguments**. `_host.mjs` records `__options` on the message
and nothing interprets them.

**Proved.** `m4`, which models pi's three queues and their drain sites and drives
the shipped loop through them:

```
   a repeating model, with a message already pending on every turn

   turn  notice                                          the model received
   ------------------------------------------------------------------------
   BEFORE
   1     (no notice)                                     NOTHING
   2     Loop stuck (1x): assistant repeated the same…   NOTHING
   3     Loop stuck (2x): assistant repeated the same…   NOTHING
         still queued for an operator prompt : 2
         everything the model ever received  : start

   NOW
   1     (no notice)                                     NOTHING
   2     Loop stuck (1x): assistant repeated the same…   stuck
   3     Loop stuck (2x): assistant repeated the same…   stuck
         still queued for an operator prompt : 0
         everything the model ever received  : start, stuck, stuck
```

**What it costs.** V4's cost, restored: the streak advances, `interventionCount`
advances, `PENALTY_TURNS` of altered sampling are armed, `turnsWithoutTools` is
reset to zero, the operator is told a strategy was injected — and the model is
told nothing, so it repeats itself, so the streak advances again. At streak 3 the
rescue model is called in; at 5 the context is compacted. Both of those rungs
schedule unconditionally, so the ladder still climbs — it just climbs having never
once said the sentence that was supposed to break the fixation.

**The fix.**

```js
  const options = opts.queueOnly
    ? { triggerTurn: true as const, deliverAs: "steer" as const }
    : …
```

`agent_end` runs while `_isAgentRunActive` is still true — it is cleared in
`_emitAgentSettled` (`:327`) — so `sendCustomMessage` takes the streaming branch
and the message joins `_steeringMessages`. `_handlePostAgentRun` then returns
`hasQueuedMessages()`, and `Agent.continue()`'s assistant-last branch drains the
**whole** steering queue and runs it as one prompt: the pending message and this
directive land on the same turn, which is precisely what "queue the directive onto
the turn that is already coming" meant. `triggerTurn: true` is the backstop for
the case where the premise is false — if nothing is going to run a turn after all,
the loop runs its own rather than queueing text nobody will read.

*Tests:* `vendor/pi-loop-mode/tests/stuck-ladder.test.ts`, the V4 describe, now
also asserting that the mode is *not* `nextTurn` and saying why. One case fails
without the fix; the control is the `hasPendingMessages() === false` case, where
delivery must still be deferred to the escalating delay.

---

## 7. Smaller things, and things that are not findings

Recorded so the next pass does not re-derive them. None is proposed for a change;
each carries the reason. The first six are new this pass.

- **`DEGENERATE_REPEATS` is declared twice, and nothing keeps the two equal.**
  `extensions/index.ts:58` and `src/repetition.ts:4`, both `4`. The eighth pass's
  X5 argument rests on them being "the same constant" — they are the same
  *number*, in two files, and X5's fix removed the dependency (rule 1 now reads
  the original text) so the divergence would no longer be a correctness bug.
  Recorded because the sentence in `…-turns.md` is stronger than the code, and
  because it is exactly Y1's shape one level down. SOURCE.
- **`/loop finish` while idle is the tenth lifecycle transition and resets
  nothing.** It sets `active = false` and `status = "stopped"` without
  `resetTurnBuffers()` or `resetContextRecovery()`. Not reachable as a defect
  today: idle means `agent_end` has already drained the buffers, and every path
  that can leave a recovery marker set clears it in its own callback. It belongs
  in §2.8's table, which is the only reason it is written down — the eighth pass
  found `/loop resume` missing from that table and this is its neighbour. SOURCE.
- **`detectStuck`'s rule 6 is the one rule not gated on the current turn's
  text.** Rules 3, 4, 5 and 8 all measure `committedText` and skip themselves when
  it is empty; rule 6 counts the window's last fingerprint, which on a turn that
  committed nothing is the PREVIOUS turn's. So a turn with no text and no thinking
  at all — a pure tool-call turn — can re-fire a verdict about a turn that has
  already been charged. Reachability is narrow (with reasoning passthrough on,
  almost every turn commits *something*), and the HARD RESET directive asking for
  "a tool call with zero preamble text" is the one thing that deliberately
  produces the shape. Left alone because the fix is a judgement call — either gate
  rule 6 on `committedText` like its neighbours, or accept that it is a fact about
  the window rather than about the turn — and neither has been observed costing a
  run. SOURCE.
- **`parseStartArgs` accepts `--goal-file X` but not `--goal-file=X`.** `--file`
  has both forms; its alias has only the space form. Cosmetic. SOURCE.
- **`penaltyTurnsRemaining` survives `/loop stop` and is not reset by
  `/loop resume`.** It is only decremented in `agent_end`, below the
  `!state.active` return, and only applied in `before_provider_request`, which is
  also gated on `state.active`. So a loop stopped with penalties armed resumes
  with up to three turns of them. Arguably right — the fixation the penalties were
  armed against is still in the window — and recorded because it is the one
  per-run counter `resume` neither clears nor deliberately keeps. SOURCE.
- **`AgentSession.prompt()`'s `_checkCompaction` call can fire the anchor before
  a repair's own prompt, and that is the case Z2 keeps.** Worth stating plainly
  because it is the only remaining path on which the anchor does anything: the
  repair prompt already restates the brief in full, so the anchor's contribution
  there is redundancy rather than the prevention its header claims. Nothing is
  proposed; the layer is cheap and the redundancy is harmless. SOURCE.
- **`sanitizeDegenerateMessage` runs in two handlers, and only one of them
  matters.** `message_end` rewrites the stored message (X5's mechanism);
  `context` rewrites a *clone* pi makes for the provider call
  (`emitContext` → `structuredClone`, `runner.js:747`), so nothing there is
  written back. Both are correct. Carried forward, and re-verified against pi this
  pass — §8.
- **The `context` handler's sanitizer therefore truncates the same text twice.**
  Carried forward with a correction: the eighth pass said the second pass is a
  no-op "because `sanitizeDegenerateText` is idempotent on its own output". It was
  not, and Z3 is that; it is now, and the second pass really is a no-op.
- **A steer queued before the session exists grows the brief before it has
  gone.** `steer()`'s live-session branch calls `growBrief` only after
  `session.steer()` resolves; the `pendingSteers` branch grows it at queue time,
  and the flush in `onSessionCreated` swallows failures. The window is
  milliseconds and the alternative puts the write on a path with no error
  handling. Carried forward. SOURCE.
- **`interveneStuck`'s compaction rung is not wrapped in a try.** `agent_end` has
  already called `clearPendingTimer()` and the intervention has already been
  charged, so a synchronous throw would leave the loop with `status: "stuck"` and
  no timer. Nothing has been observed throwing. Carried forward. SOURCE.
- **V4's queued directive gives up the loop's own timer entirely**, deliberately,
  because the pending message will trigger the turn. §8 re-verifies that pi really
  does guarantee that turn, which the eighth pass recorded as an assumption.
  Carried forward, now with evidence.
- **`degenerateAbortPending` is cleared on one of `agent_end`'s exits.** If the
  abort lands on a turn whose final message reports `error`, the flag survives and
  the operator's next Esc is read as a degenerate abort. Carried forward. SOURCE.
- **`saturatedManualCompaction` keys on `state.description`, not on
  `state.active`.** Carried forward. SOURCE.
- **`buildVerifyDeps` reads `SUBAGENT_VERIFY` at spawn time** while
  `runVerification` reads `SUBAGENT_VERIFY_ROUNDS` and
  `SUBAGENT_VERIFY_TIMEOUT_MS` per call. Three switches, two policies. Carried
  forward.
- **The repair runs with the watchdog's state already deleted.** Bounded by the
  300 s deadline instead, which is T5's territory. Carried forward.
- **`prinny-channel` has W1's shape too, and the fix there is not the same one.**
  `describeEmptyEnding` scans back to the first assistant message it finds, so a
  turn that answered and then produced a trailing reasoning-only message reads as
  `produced-no-answer`. **Not fixed, deliberately** — `forwarding.ts` is handed a
  message list with no turn boundaries, so the loop's per-turn-buffer repair does
  not transfer, and the trade-off between sending a stale answer and sending
  nothing was paid for by a real incident. A Matrix-side decision. Carried
  forward, unchanged, for the third pass running.
- **`exclude_tools` is U6's sibling, one field over.** Carried forward.
- **`hasStateChange()` matches its keyword list against any tool output.**
  Carried forward.
- **A provider-error streak has no terminal state**, while the context ladder
  escalates to `pauseForContextFailure`. Carried forward.
- **`consecutiveErrorCount` is shared between context pressure and provider
  errors.** Carried forward.
- **`getFinalModelError()` returns undefined for `stopReason: "error"` with an
  empty `errorMessage`.** Carried forward.
- **The `Agent` tool's `execute` reads `params.max_turns`, which its schema does
  not declare and nothing injects.** Carried forward.
- **`__verifier` is hidden from the `Agent` tool's type list but not from
  `resolveType`.** Carried forward.
- **`SlotTable.setLimits()` reads `config.default` with no fallback.** Carried
  forward.
- **`record.stats.turnCount` is initialised to 1 at spawn.** Carried forward.
- **A background subagent result delivered while a loop is running triggers a turn
  the loop counts as an iteration.** Carried forward — and the mechanism behind
  W1, X1, X2, X3 and Z4.
- **The spawn bracket is still a process-global counter.** Carried forward.
- **`AgentStatus` lists every agent ever spawned this session**, unbounded.
  Carried forward.

---

## 8. What was re-verified this pass, and holds

Read out of pi's shipped `dist/` (0.84.2, the version installed in this image) and
out of the tree, not assumed.

### 8.1 The eighth pass's homework: what pi does with every handler return value

This is the mechanical check `…-turns.md` §12 asked the next session to run. It is
complete, and it came back clean — every event `_host.mjs` fakes behaves the way
the harness assumes, and the one that did not was X5's, already fixed.

```
   event                     pi's use of the return value              faithful?
   ───────────────────────────────────────────────────────────────────────────
   message_end               THREADED into the next handler's event,   ✔ replayed
                             then _replaceMessageInPlace over the        by X5's
                             object agent_end reads     runner.js:610    fix
   context                   THREADED; operates on a structuredClone   ✔ nothing
                             of the message array, returned to the       is written
                             provider call only         runner.js:747    back
   before_provider_request   THREADED; the last payload wins           ✔ loop only
                                                        runner.js:776    reads it
   before_agent_start        systemPrompt THREADED via ctx.getSystem-  ✔ loop
                             Prompt(); `message` results collected      appends to
                             into extra custom messages runner.js:837   event.systemPrompt
   tool_result               content/details/isError/usage merged      ✔ loop
                             into ONE shared currentEvent, all         returns
                             handlers see the merge      runner.js:649   nothing
   tool_call                 last non-undefined wins; `block` returns  n/a
                             immediately                runner.js:701
   user_bash                 FIRST truthy result wins and returns      n/a
                                                        runner.js:720
   before_provider_headers   IGNORED — handlers mutate `headers` in    n/a
                             place, and pi's own comment says so
                                                        runner.js:808
   session_before_compact    LAST truthy result wins, NOT threaded;    ✔ only one
                             `cancel` returns immediately runner.js:589  writer today
   agent_end, agent_start,   IGNORED for every other event type — the  ✔
   turn_*, message_start,    generic emit() keeps a result only for
   message_update,           isSessionBeforeEvent(event)
   session_start/shutdown,                              runner.js:579
   session_compact,
   agent_settled
```

Two things fall out that are worth carrying forward:

- **`session_before_compact` is last-writer-wins and not threaded.** Two
  extensions returning a `{compaction}` would silently pick one by registration
  order. Today only `pi-loop-mode` returns one; `compaction-guard` mutates
  `event.preparation.previousSummary` in place and returns `undefined`, so the two
  do not collide. They *do* interact by order — whether the loop's handoff sees
  the capped or the uncapped previous summary — and it does not matter, because
  `buildHandoffCompaction` never reads `previousSummary`; it builds its summary
  locally from `state` and the branch entries. Checked, holds.
- **`emitMessageEnd` builds a fresh event object per handler** (`{...event,
  message: currentMessage}`) and **rejects a replacement whose `role` differs**,
  and `_emitExtensionEvent` normalizes `content == null` to `[]` before writing it
  back. `_host.mjs` does none of those three. None is reachable with one handler
  that preserves `role` and always returns an array, which is what the loop's
  sanitizer does — so the harness is faithful for the module under test and not in
  general. Recorded rather than fixed.

### 8.2 pi's own guarantees the loop depends on

- **A message queued during `agent_end` really does get a turn.** §7 of the eighth
  pass recorded V4's `queueOnly` branch as depending on this and did not check it.
  It holds, explicitly: `_handlePostAgentRun()` ends
  `return this.agent.hasQueuedMessages();` with the comment *"The agent loop
  drains both queues before emitting agent_end. Any messages here were queued by
  agent_end extension handlers and need a continuation."* `_runAgentPrompt` loops
  on it, and `Agent.continue()` handles the assistant-last state by draining the
  steering queue and running it as a prompt. So every `if
  (!ctx.hasPendingMessages()) scheduleLoopTurn(…)` exit of `agent_end` is safe —
  and Z4 is not about that guarantee failing, it is about the loop having queued
  its message somewhere the guarantee does not reach.
- **`pendingMessageCount` counts steering + follow-ups only** (`:1151`), so
  `deliverAs: "steer"` from `agent_end` cannot make `hasPendingMessages()` true
  for a decision that has already been taken this turn. Checked for Z4's fix.
- **`agent_end`'s `messages` are `newMessages`** — everything this agent run
  produced, including the prompt, injected steers and tool-result messages, and
  *not* the session's history. The loop's `[...event.messages].reverse().find(role
  === "assistant")` is therefore scoped to the run by construction.
- **`agent_end` fires once per agent RUN, not per turn**, and a single
  `session.prompt()` can contain several runs (retry, compaction, queued
  messages). The loop's "iteration" is an agent run. Checked; it is what makes
  §1's three-unit drawing necessary.
- **pi never auto-compacts between the turns of a run** — two call sites, both
  outside the agent loop. This is Z2's foundation and it is also a correction to
  the anchor layer's own header, which is now annotated in `verify.ts`.

### 8.3 The tree

- **All six eighth-pass fixes are in place** and all six `l` probes still run
  clean. `commitTurnMemory` prefers the turn's answers; `detectStuck` scans each
  entry of the third buffer; that buffer takes the original message;
  `message_end` buffers during preparation; `state.toolCallsThisTurn` lives in
  `resetTurnBuffers()`; `clear()` refuses a verifying record.
- **All six seventh-, all eight sixth-, all nine fifth- and all ten fourth-pass
  fixes are in place**, and `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`, `i1`–`i9`,
  `j1`–`j8` and `k1`–`k6` all still run clean.
- **Z1's fix does not change the live view.** `onTextDelta` still reports the
  message being streamed, one message at a time, which is what the widget renders;
  only the value read once at the end of the run changed. Pinned by a test.
- **Z2's fix does not stop the compaction being counted.** `record.stats.
  compactionCount` increments on every compaction, before the predicate. Pinned by
  the probe.
- **The slot is still held across verification**, and `recount()` still keys on
  `holdsSlot`.
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
| Z1 | one entry per message, last non-empty wins; the fallback holds the run's own messages instead of an index | `pi-subagents-lite/src/agents/run-answer.ts` (new) + `agent-runner.ts` | `run-answer.test.ts` ×7 | 3 |
| Z2 | the runner reports `afterRun`/`willRetry`; `anchorReachesATurn()` decides; the manager imports it | `src/agents/compaction-anchor.ts` (new) + `agent-runner.ts`, `agent-manager.ts`, `types.ts` | `compaction-anchor.test.ts` ×4 | 1 |
| Z3 | the cut is the longest prefix whose sanitized form is not itself degenerate | `pi-loop-mode/src/repetition.ts` | `degenerate-sanitizer.test.ts` ×6 | 4 |
| Z4 | the queued directive is a steer, which `_handlePostAgentRun` drains | `pi-loop-mode/extensions/index.ts` | `stuck-ladder.test.ts` (V4 describe) ×2 | 1 |

### The gates

```
                                    before    after
vendor/pi-subagents-lite   tests    215       226     lint 77/77 files
vendor/pi-loop-mode        tests    150       156
.pi/extensions/compaction-guard      39        39     (untouched)
                                   ─────     ─────
                                    404       421
```

All forty-three probes run clean — `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`,
`i1`–`i9`, `j1`–`j8`, `k1`–`k6`, `l1`–`l6` and `m1`–`m4`.

Two probes and one source comment were corrected rather than added:

- `j4` no longer claims `nextTurn` delivers, and says where to read the truth;
- `l3` no longer says the two `DEGENERATE_REPEATS` are "the same constant";
- `verify.ts`'s "Anchor (prevention)" bullet carries the correction from §8.2.

### Four things worth keeping from how these went

- **The API boundary is where a harness stops being evidence.** X5 was the
  harness not replaying what pi does with a handler's return value. Z4 is the
  harness not modelling what pi does with a call's arguments, and Z1 and Z2 are
  the same thing about `session.messages` and `session.steer()`. A probe that
  asserts *"we called `sendMessage` with these options"* is a test of the module's
  intent, not of the system's behaviour, and the two look identical in a passing
  run. The habit that follows: **for every pi API the module CALLS, read the
  implementation and write down where the value ends up.** §8.1 and §1 are that,
  done once.
- **A comment that names a mechanism is a claim, and the mechanism may not exist.**
  `sendLoopTurn`'s comment cited `agent-session.js:880` — the right line — and
  then described it as *"the next user message"*, which is exactly what it says.
  The word `user` was doing the work and nobody read it. Likewise the anchor's
  header says *"after each compaction, restate the brief into the child's
  freshly-summarised context"*, and pi's compaction schedule makes the phrase
  "after each compaction" mean something the sentence does not survive.
- **When one rule is written down for one call site, grep for the verb.** T1 and
  V6 established that a steer into a run that is finishing manufactures a turn,
  and wrote it into `turn-tracking.ts` with a measurement. There are two
  `session.steer()` call sites in the package. The rule was applied to one of
  them for two passes. `record-activity.ts` (Y1) and now `compaction-anchor.ts`
  are the same repair: a rule that lives in a module cannot be applied to one
  caller.
- **A pure function's stated property is worth one test.** Z3 was findable in
  three lines of a REPL, in a function two passes had both read closely, because
  neither asked it the question its own header answers ("would running this twice
  change anything?"). It cost nothing to check and it had been wrong since the
  fork.

---

## 10. Running the evidence

```sh
cd ~/qwen3.8-forge

# the gates
( cd vendor/pi-subagents-lite && npm test && node tests/lint.mjs )   # 226 + 77/77
( cd vendor/pi-loop-mode       && npm test )                         # 156
( cd .pi/extensions/compaction-guard && npm test )                   #  39

# just this pass's regression tests
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/run-answer.test.ts tests/compaction-anchor.test.ts )
( cd vendor/pi-loop-mode && node --experimental-strip-types --test \
    tests/degenerate-sanitizer.test.ts tests/stuck-ladder.test.ts )

# this pass's probes
P=context/testing/probes
node                            $P/m1-the-childs-answer-read-off-the-last-message.mjs
node                            $P/m2-the-anchor-manufactures-a-turn.mjs
node --experimental-strip-types $P/m3-the-sanitizer-leaves-the-repetition-in.mjs
node --experimental-strip-types $P/m4-the-queued-directive-nobody-drains.mjs
```

| probe | what it showed | the control |
| --- | --- | --- |
| `m1` | a settled child reported as "no answer at all", and an acknowledgement returned as the answer | the same turn without a compaction, and a first run |
| `m2` | the anchor steered into a run that had already ended | the two call sites that must keep it, and a live second run |
| `m3` | nine copies of the repeated sentence still in the stored message, and a real answer cut off | the eighth pass's own example, already clean |
| `m4` | two stuck directives queued and delivered to nobody | the same run with nothing pending |

`m1` and `m2` drive the shipped `continueAgentSession` / `AgentManager` through
`jiti`, the way `l6` does; `m3` and `m4` load the loop module directly.

---

## 11. Still unwatched

Four more defects fixed against probes and tests, and none against a running
model — which is now true of every fix in the last six passes.

1. **A real verification.** Still the highest-value unwatched thing, and Z1 and Z2
   make it more so: they are both about the string the verifier is handed. One
   foreground delegation with `SUBAGENT_VERIFY_ROUNDS=1` and a deliberately
   off-task brief exercises S2, U4, U8, V5, V7/W6, W5, Y1 — and now Z1, if the
   child compacts.
2. **The judge's raw reply is still not logged.** Top of the list since the fourth
   pass. Load-bearing for S2, U4, V5 and W5.
3. **A child that compacts.** New, and the most informative single run available:
   Z1 and Z2 are both on that path, and `record.stats.compactionCount` on a
   settled record is the one-glance check that it happened.
4. **A delegation with a loop running.** Fixed at the module level six times now
   — the loop's factory guard, V4, W1, X1, X2 and Z4 — and never watched. The
   mid-turn steer that produces a two-message turn IS a background subagent's
   result, and it is also the pending message that sends `interveneStuck` down
   Z4's branch, so one run exercises five of those on the same turn.
5. **A degenerate turn in the wild.** Rule 1 has never fired in a real session, so
   nobody has seen what the loop does after it does — and Z3 changed what the
   model is left holding afterwards.
6. **`/loop prepare` followed by a delegation** — X3's path end to end.
7. **An operator steer to a RUNNING subagent**, which is W3's path — §J of the
   hand-testing script, still never run.
8. **Section I of `context/testing/subagents-loop-verifier.md`**, still never run,
   now nine passes old.
9. **Still open by decision, unchanged:** T5 (verification bounded at 300 s but
   uninterruptible), T6 (`worktree_path` reach), T1's general case, per-session
   loop state, U9 (`Explore` has no shell).

---

## 12. The pattern across nine audits

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
   host ↔ harness             X1–X5    the evidence models the host, and the model
                              Y1       omits the one thing under test
   call ↔ what the host does  Z1–Z4    the call is correct, the argument is correct,
              with it                  the comment cites the right line — and the
                                       value ends up somewhere nobody looked
```

The eighth pass's lesson was about the **return** side of the extension contract:
what pi does with what a handler gives back. This one is the **call** side, and
the four findings are four different ways for it to go wrong:

```
   Z4   a delivery mode with one drain site, and it is not on any path the
        caller can reach                              → the message never arrives
   Z2   a call that does more than its name — steer() asks a question, and
        asking restarts a loop that had stopped       → an extra turn, and its
                                                        answer wins
   Z1   an index into a collection the host rebuilds  → the read silently
                                                        returns nothing
   Z3   a pure function whose documented property it
        does not have                                 → the work it claims to
                                                        do is half done
```

Three habits fall out, and they are the transferable part.

**Read the implementation of every host API the module CALLS, not just of every
event it HANDLES.** The eighth pass did the second half of that and said so. The
first half is the same amount of work and it was where three of these four were.
The artefact is §1's delivery map and §8.1's table; neither existed before this
pass and both are a morning's reading.

**A cited line number is not a citation of behaviour.** Two of these findings sit
under comments that name exactly the right file and line, and then paraphrase it
slightly wrong — "the next user message" became "the turn the pending message
triggers"; "after each compaction" became "during the child's work". The check is
to read the cited line and ask what would have to be true for the paraphrase to
hold.

**When a rule gets a module, move every caller into it.** `record-activity.ts`
was Y1's lesson and it worked: nothing in this pass touched that question.
`compaction-anchor.ts` and `run-answer.ts` are the same move for two more, and
`turn-tracking.ts` is the counter-example — it had the rule, in a module, with a
measurement, and the second call site never learned about it because nothing made
it ask.

---

## 13. Where to look

- `context/testing/probes/m1`–`m4` — the reproductions, one per finding, each
  printing BEFORE and NOW.
- The regression tests: `vendor/pi-subagents-lite/tests/run-answer.test.ts` (Z1),
  `tests/compaction-anchor.test.ts` (Z2),
  `vendor/pi-loop-mode/tests/degenerate-sanitizer.test.ts` (Z3) and the V4 describe
  in `tests/stuck-ladder.test.ts` (Z4).
- `vendor/pi-subagents-lite/src/agents/run-answer.ts` and
  `src/agents/compaction-anchor.ts` — the two new no-import modules, each with the
  argument for why it is a module.
- `context/design/subagents-loop-verifier-turns.md` — the eighth pass (X1–X5, Y1,
  all fixed). Its §2.2 table is what Z1 corrects — the `runTurnLoop` row was
  written from the fallback's behaviour rather than from the order of the `||`.
  Its §7 note on the sanitizer's idempotence is what Z3 corrects.
- `context/design/subagents-loop-verifier-readers.md` — the seventh (W1–W6);
  `…-shapes.md` — the sixth (V1–V8), whose §4.3 turn-ceiling table and T1/V6
  argument are what Z2 extends; `…-units.md` — the fifth (U1–U9), whose §9
  reference sections are the detail no later document restates; `…-surfaces.md` —
  the fourth (S1–S10); `…-mechanics.md` — the third (T1–T9), still the best
  account of pi's own agent loop; `…-evaluation.md` — the second (F1–F11);
  `…-anatomy.md` — the first, and the design rationale.
- pi's own source, for this pass:
  `dist/core/agent-session.js:744` (`_runAgentPrompt`), `:776`
  (`_handlePostAgentRun`), `:792` (`prompt`), `:880` (the only `nextTurn` drain),
  `:1068` (`sendCustomMessage`), `:1435`/`:1673` (`agent.state.messages =
  sessionContext.messages`), `:1510` (`_checkCompaction`);
  `node_modules/@earendil-works/pi-agent-core/dist/agent.js:236`
  (`Agent.continue`), `agent-loop.js:79` (`runLoop`);
  `dist/core/extensions/runner.js:579`–`:891` (every `emit*`).
- `patches/forge_reasoning_passthrough.py` and commit `e81a7e5` — the wire change
  V1, V2, W1, X1–X3 and Z1's reasoning-only tail are all downstream of.
