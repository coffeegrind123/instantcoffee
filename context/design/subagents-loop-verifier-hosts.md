# Subagents, the loop, and the verifier — the host underneath, and the four calls that did not mean what they said

Tenth pass, 2026-08-18. A full read of the three components, the extension that
sits under all of them, and — for the first time — **every pi API the code
calls**, with pi's own implementation read for each one.

**Four findings (AA1–AA4), all four fixed** — and then, in the same pass, **every
open note in §9 that had a defensible fix**, plus **T5**, plus `prinny-channel`'s
W1 shape, which three passes had left as "wants a decision". Each finding carries
an executable probe; each fix carries a regression test that fails when the fix
is removed.

**421 tests, lint 77/77 and forty-three probes caught none of the four.** The
suite is now **786** across four packages, lint is 84/84, and there are
forty-seven probes. §11 has the full table of what shipped, including the
nineteen notes that stopped being notes.

This pass exists because the ninth one ended with an instruction:

> **For every pi API the module CALLS, read the implementation and write down
> where the value ends up.** §1 is that map for the calls checked so far;
> `session.abort()`, `ctx.compact()`, `pi.appendEntry()`, `pi.exec()` and
> `session.setActiveToolsByName()` have not been read.
> — `…-answers.md` §12, and the handoff's one-line brief

That reading is done. §7 is the ledger — thirty-one distinct host calls, what pi
does with each, and whether the call site's own comment survives contact with it.
Four did not.

```
   AA1  before_agent_start is emitted from ONE place, and the loop cannot
        reach it — so the handler that puts the loop's rules in the system
        prompt never ran on a loop turn; and what it returned when an
        OPERATOR typed outlived the run on agent.state.systemPrompt, so the
        block appeared on the first turn of the next iteration and vanished
        on its second.                                            HIGH · FIXED

   AA2  pi.exec never rejects. U3's "the check could not RUN" branch was
        wired to a catch that cannot fire — and a check killed on its own
        timeout comes back with exit code 0, so a deadlocked check reads as
        a check that PASSED and completes an --until-done run.     HIGH · FIXED

   AA3  ctx.hasPendingMessages() counts two arrays that only a human at a
        keyboard can fill. V4 built a branch for "a background subagent's
        result is queued" and Z4 repaired its delivery; neither state is
        reachable without an operator typing.                   MEDIUM · FIXED
                                                                  (as a claim)

   AA4  the background result's deliverAs is chosen by a ternary whose other
        arm pi never reads: the idle case lands on the branch that discards
        the value, so the mode is always "steer".                   LOW · FIXED
```

And then the notes. Nineteen of them had a fix that did not need a decision from
anyone, and were carrying nothing but their own age:

```
   the check harness    pi.exec's other two callers: the worktree validator's
                        GIT_NOT_FOUND and GIT_TIMEOUT were dead constants
   the operator         ctx.ui.notify is a no-op outside a TUI, so an unattended
                        run's whole narrative was discarded silently
   the ladders          the provider-error retry shared a counter with context
                        pressure and had NO terminal state — it retried forever
   the stuck rules      rule 6 was the one rule not gated on the current turn's
                        text, so it could re-charge the ladder for a turn that
                        had already been charged
   the tool surface     `hidden` kept __verifier out of the description and not
                        out of the tool; two params were read that the schema
                        forbids; a record claimed one finished turn before any
   the slot table       an unreadable `default` made the limit NaN, and NaN
                        bounds nothing; a per-model limit of 0 was applied and
                        then deleted by a falsy check
   the frontmatter      `exclude_tools: none` meant "exclude a tool called none"
   AgentStatus          listed every agent ever spawned, unbounded, into the
                        parent's context
   T5                   a verification was uninterruptible for up to 300 s with
                        the parent blocked behind it
   prinny-channel       W1's shape, resolved narrowly enough to keep the
                        incident that made it a decision
```

---

## 0. How this sits next to the other nine documents

Each pass found defects in a *place*, and each place was further from the code
than the last:

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
| ninth | `…-answers.md` (Z1–Z4) | between what an API call looks like it does and what the host does with it |

This one is the ninth's **completion rather than its successor**. The ninth found
three such calls by reading the three it happened to be looking at; this one read
all thirty-one, and the remaining four fell out. So the tenth place is not new
territory — it is the same territory, surveyed:

```
   Z4  "deliverAs: nextTurn" — a delivery mode with one drain site
   Z2  "session.steer()" — a call that restarts a loop that had stopped
   Z1  "session.messages[i]" — an index into a collection the host rebuilds
        ↳ found by reading three call sites out of thirty-one

   AA1 "before_agent_start" — an EVENT with one emit site, and the module
        cannot reach it
   AA2 "pi.exec()" — a promise that never rejects, and a kill that reports
        success
   AA3 "ctx.hasPendingMessages()" — a question about a queue the asker
        cannot put anything into
   AA4 "deliverAs" again — a parameter read on one branch out of four
        ↳ found by reading the other twenty-eight
```

The transferable part is at the bottom, in §14. The short version is that the
ninth pass's habit works, and the reason it works is that **an extension's
contract with its host has four surfaces, not two**: what we return from a
handler (X5), what we pass to a call (Z1–Z4), *which events reach us at all*
(AA1), and *what a host function's return value can and cannot say* (AA2). The
first two had been read. These are the other two.

Read the other nine documents for evidence, not orientation. Nothing they fixed
has come undone: all forty-three prior fixes are in the tree and their probes
still run clean.

---

## 1. The whole machine

One drawing. Everything below is a zoom into part of it.

```
 ┌────────────────┐   ┌────────────────────────────────┐   ┌───────────────────┐
 │   llama.cpp    │──▶│ forge — OpenAI-compatible proxy │──▶│        pi         │
 │  ONE slot      │   │ :8081                           │   │      0.84.2       │
 │  PARALLEL_     │   │ patches/forge_reasoning_        │   │                   │
 │   SLOTS=1      │   │   passthrough.py   (e81a7e5)    │   │ reasoning_content │
 │  32k window    │   │ emits reasoning_content beside  │   │   ──▶ {type:      │
 └────────────────┘   │ content, and a truthful         │   │    "thinking"}    │
        ▲             │ finish_reason                   │   └─────────┬─────────┘
        │             └────────────────────────────────┘             │
        │  every box below queues here, one at a time                │
        └────────────────────────────────────────────────────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  A.  THE TWO ENTRY POINTS — and only one of them is a "prompt"          [AA1]
 ══════════════════════════════════════════════════════════════════════════════

  ┌─ AgentSession.prompt(text)          :792 ────────────────────────────────┐
  │    a HUMAN typed · a subagent's own runner · sendUserMessage()           │
  │                                                                          │
  │    /command?  ──▶ _tryExecuteExtensionCommand ──▶ RETURNS. no turn.      │
  │    isStreaming? ─▶ _queueSteer / _queueFollowUp ──▶ the ONLY writers of  │
  │                     _steeringMessages / _followUpMessages         [AA3]  │
  │    idle:                                                                 │
  │      _checkCompaction(lastAssistant, false)                       :865   │
  │      messages = [ user(text), ..._pendingNextTurnMessages ]       :880   │
  │      ┏━━━ emitBeforeAgentStart(text, images, base, opts) ━━━┓     :885   │
  │      ┃  result.messages   → appended as role:"custom"       ┃     :889   │
  │      ┃  result.systemPrompt !== undefined                   ┃            │
  │      ┃      _systemPromptOverride       = it                ┃     :902   │
  │      ┃      agent.state.systemPrompt    = it                ┃     :903   │
  │      ┃  else                                                ┃            │
  │      ┃      _systemPromptOverride       = undefined         ┃     :907   │
  │      ┃      agent.state.systemPrompt    = _baseSystemPrompt ┃     :908   │
  │      ┗━━━ THE ONLY EMIT SITE IN THE WHOLE OF pi ━━━━━━━━━━━━┛            │
  │      _runAgentPrompt(messages)                                           │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌─ AgentSession.sendCustomMessage(msg, options)   :1068 ───────────────────┐
  │    pi.sendMessage() — the ONLY route an extension has                    │
  │                                                                          │
  │    deliverAs "nextTurn" ─▶ _pendingNextTurnMessages.push          :1079  │
  │                              drained ONLY by prompt() above  ← Z4        │
  │    isStreaming && triggerTurn !== false                          :1081  │
  │        deliverAs "followUp" ─▶ agent.followUp(msg)               :1083  │
  │        else                 ─▶ agent.steer(msg)                  :1086  │
  │                                ▲ Agent's OWN queues. Neither is the     │
  │                                  array hasPendingMessages() reads [AA3] │
  │    triggerTurn (idle)   ─▶ await _runAgentPrompt(msg)            :1090  │
  │                              ▲ NO emitBeforeAgentStart          [AA1]   │
  │                              ▲ NO _checkCompaction                      │
  │                              ▲ deliverAs is DISCARDED here      [AA4]   │
  │    else ────────────────▶ push to state.messages, message_start/_end     │
  └──────────────────────────────────────────────────────────────────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  B.  WHAT A "TURN" IS — three nested units, and the loop names the middle one
 ══════════════════════════════════════════════════════════════════════════════

  _runAgentPrompt(messages)                                            :744
    _isAgentRunActive = true         ── isStreaming === !isIdle
    │
    ├── agent RUN #1   runAgentLoop            pi-agent-core/agent-loop.js
    │     agent_start
    │     ┌── inner while (hasMoreToolCalls || pendingMessages.length)
    │     │     drain pendingMessages → message_start / message_end each
    │     │     streamAssistantResponse → message_start · message_update…
    │     │                                message_end   ← ONE assistant MESSAGE
    │     │     executeToolCalls        → tool_result each
    │     │     turn_end
    │     │     ┏━ prepareNextTurn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    │     │     ┃ systemPrompt: _systemPromptOverride ?? _baseSystemPrompt┃:286
    │     │     ┃ tools:        agent.state.tools.slice()                 ┃
    │     │     ┗━ turn 1 did NOT go through here — it took                ┃
    │     │        agent.state.systemPrompt from createContextSnapshot()  ┃ [AA1]
    │     │     pendingMessages = getSteeringMessages()
    │     └──
    │     outer while: getFollowUpMessages() → back into the inner loop
    │     agent_end   { messages: newMessages }   ← THE LOOP'S "ITERATION"
    │
    ├── _handlePostAgentRun()                                          :776
    │     _prepareRetry? _checkCompaction(msg)? agent.hasQueuedMessages()?
    │       any true ─▶ agent.continue()                        agent.js:234
    │                     lastMessage.role === "assistant"
    │                       ├─ steeringQueue.drain()  → runPromptMessages
    │                       ├─ followUpQueue.drain()  → runPromptMessages
    │                       └─ else throw
    │                     else ─▶ runContinuation()
    │                   ─▶ agent RUN #2 … (a fresh createContextSnapshot)
    │
    └── finally
          _systemPromptOverride = undefined        ← and NOTHING restores :753
          agent.state.systemPrompt                        [AA1]
          _emitAgentSettled()  → agent_settled · _isAgentRunActive = false :327

  MESSAGE  one assistant reply.
  TURN     one message plus its tool results (pi's `turn_end`).
  RUN      agent_start … agent_end. `pi-loop-mode` counts this as one iteration.
  PROMPT   one session.prompt() / sendCustomMessage(), possibly several RUNs.

 ══════════════════════════════════════════════════════════════════════════════
  C.  WHERE THE SYSTEM PROMPT COMES FROM, per turn                      [AA1]
 ══════════════════════════════════════════════════════════════════════════════

   _baseSystemPrompt   ← _rebuildSystemPrompt(activeToolNames)          :710
                          resourceLoader.getSystemPrompt() is `customPrompt`,
                          which is how a CHILD's own prompt survives a rebuild
                          written by  setActiveToolsByName()            :643
                                      resources_discover                :1778

   _systemPromptOverride ← before_agent_start's result                  :902
                           cleared in _runAgentPrompt's finally         :753

   agent.state.systemPrompt ← :903 / :908 (prompt()) · :644 · :1779
                              read by Agent.createContextSnapshot() for TURN 1

   ┌───────────────────────────────────────────────────────────────────────┐
   │  turn 1 of a run   agent.state.systemPrompt                           │
   │  turn 2+ of a run  _systemPromptOverride ?? _baseSystemPrompt         │
   │                                                                       │
   │  Equal for a run that came through prompt(). NOT equal for a run that │
   │  came through sendCustomMessage — the override is already cleared and │
   │  agent.state still holds the last prompt()'s value.            [AA1]  │
   └───────────────────────────────────────────────────────────────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  D.  WHEN pi COMPACTS — two call sites, both OUTSIDE the agent loop      [Z2]
 ══════════════════════════════════════════════════════════════════════════════

   _checkCompaction(assistantMessage, skipAbortedCheck)                :1510
        ▲                                    ▲
        │                                    └── prompt()              :865
        └── _handlePostAgentRun()  :776          before a new run starts
            AFTER agent_end

   AgentSession.compact(customInstructions)                            :1367
        await this.abort()          ← FIRST THING IT DOES
        _compactionAbortController = new AbortController()
          └─ while set, prompt() THROWS "Cannot submit a prompt while
             compaction is in progress"                                :805
        prepareCompaction(branch, settings)
          └─ branch's LAST entry is a compaction ─▶ undefined ─▶ "Already
             compacted"; nothing to summarize ─▶ "Nothing to compact"
        session_before_compact  → LAST truthy result wins, not threaded
        the model summary, unless an extension supplied one
        appendCompaction(…)  ·  agent.state.messages = sessionContext.messages
        session_compact  ·  compaction_end

   `prepareNextTurnWithContext` refreshes the system prompt, tools and model and
   nothing else. There is no third site: **pi never compacts between the turns
   of a run.**

 ══════════════════════════════════════════════════════════════════════════════
  E.  ONE assistant MESSAGE, and the one hook that rewrites it in place   [X5]
 ══════════════════════════════════════════════════════════════════════════════

   { role:"assistant",
     content:[ {type:"text",text} | {type:"thinking",thinking} | {type:"toolCall"} ],
     stopReason:"stop"|"length"|"error"|"aborted", errorMessage?, usage:{output} }

     ExtensionRunner.emitMessageEnd            runner.js:610
       threads each handler's returned message into the NEXT handler's event
       rejects a replacement whose `role` differs, and keeps going
     AgentSession._emitExtensionEvent          agent-session.js:481
       normalizes content == null to [], then
     AgentSession._replaceMessageInPlace       :425
       delete every key of the object agent-core holds, Object.assign over it

   "Mutating this object in place keeps agent state, LATER TURN/AGENT EVENTS,
    listeners, and the eventual appendMessage persistence in sync."  ← pi's own
    comment. `agent_end`'s `messages` are those same objects.

 ══════════════════════════════════════════════════════════════════════════════
  F.  THE FOUR PACKAGES + THE ONE DISCOVERED EXTENSION
 ══════════════════════════════════════════════════════════════════════════════

  loaded by scripts/pi-local.sh, IN THIS ORDER, and the order is load-bearing:

   1. .pi/extensions/stack.ts          /stack · stack_status · guards itself (U7)
   2. .pi/extensions/browser-guard.ts  rewrites a browser timeout
   3. vendor/pi-loop-mode              13 handlers · /loop · the loop tool
   4. .pi/extensions/compaction-guard  3 handlers · no tools · no commands
   5. vendor/pi-subagents-lite         4 handlers · Agent/StopAgent/AgentStatus
   6. vendor/prinny-channel            Matrix bridge
   7. vendor/rtk-pi                    bash rewriting

   handlers run in registration order, and results are threaded for
   `context`, `message_end`, `tool_result`, `before_provider_request`
   and `before_agent_start`. So:

     context      loop runs FIRST and appends `loop-context-budget`; the guard
                  sees the `-context-budget` suffix and stands down. Documented
                  in pi-local.sh, and correct.
     tool_result  loop runs FIRST and fingerprints the RAW tool output; the
                  guard's cap runs after. NOT documented, and the launcher's
                  comment says a different order "costs a duplicate line, not a
                  bug". It would also break detectStuck's rule 7 — §9.

  ┌─────────────────┐ ┌───────────────────┐ ┌─────────────────┐ ┌────────────┐
  │ prinny-channel  │ │ pi-loop-mode      │ │ compaction-guard│ │ subagents  │
  │ "said nothing"  │ │ 13 handlers       │ │ summary cap     │ │ 3 tools    │
  │ = no text and   │ │ 3 per-turn buffers│ │ tool-output cap │ │ widget     │
  │   no toolCall   │ │ the stuck ladder  │ │ context notice  │ │ /agents    │
  │ (W1's shape —   │ │ the context ladder│ │                 │ │ slot table │
  │  fixed §9.7)    │ │  ←AA1 AA2 AA3     │ │  never audited  │ │ watchdog   │
  │                 │ │  ←X1–X5 Z3 Z4     │ │  until now (§5) │ │  ←AA4 Y1   │
  │ uses sendUser-  │ │                   │ │                 │ │   Z1 Z2    │
  │ Message → the   │ │ uses sendMessage  │ │ mutates its     │ │ uses send- │
  │ prompt() path.  │ │ → the OTHER path. │ │ event in place. │ │ Message.   │
  │ Gets AA1 right  │ │ AA1 is here.      │ │                 │ │ AA4 here.  │
  │ by construction.│ │                   │ │                 │ │            │
  └─────────────────┘ └───────────────────┘ └─────────────────┘ └────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  G.  THE DELEGATION PATH
 ══════════════════════════════════════════════════════════════════════════════

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │   module-global state, shared by every session in this PROCESS:          │
   │     pi-loop-mode  state:LoopState · runToken · pendingTimer              │
   │                   turnAssistantTexts · turnAnswerTexts                   │
   │                   turnRepetitionTexts · turnToolCalls                    │
   │     pi-subagents  shell{pi,sessionCtx,manager,widget,store,coordinator}  │
   │     shell.ts      __PI_SUBAGENT_SPAWN_DEPTH__ on globalThis              │
   │     compaction-guard  spillDir (a mkdtemp, first use)                    │
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
                              │  │   setSessionName · bindExtensions          │
                              │  │   setActiveToolsByName  ← rebuilds the     │
                              │  │       system prompt from the loader (§7)   │
                              │  │ exitSubagentSpawn()                        │
                              │  └───────────────┬───────────────────────────┘
                              │                  ▼
   ┌──────────────────────────┼───────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, in-memory SessionManager         │
   │    own system prompt · own tools · own window · own event bus            │
   │    session.prompt(prompt)  ← so a CHILD DOES get before_agent_start      │
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
                                                               deliverAs:"steer",
                                                               triggerTurn:true)
                                                             └─ busy: lands INSIDE
                                                                the parent's turn
                                                                idle: a whole new
                                                                run, deliverAs
                                                                discarded  [AA4]
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, the parent's next call are four things in one queue. Every finding in
this pass costs a place in that queue, or a message that never reaches it, or a
sentence the model was supposed to be holding and was not.

---

## 2. The loop (`vendor/pi-loop-mode`)

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool. Its whole job is deciding what a turn's outcome *was*, and then getting one
sentence to the model about it.

### 2.1 The thirteen handlers, and which entry point each one sees

```
  handler                  fires on                       reachable in an
                                                          UNATTENDED run?
  ──────────────────────────────────────────────────────────────────────────────
  session_before_compact   pi is about to compact          yes
  session_compact          pi compacted                    yes
  session_start            session opens / restarts        yes  [X4]
  session_shutdown         session closes                  yes  [X4]
  agent_settled            a whole prompt finished         yes
  before_agent_start       AgentSession.prompt() ONLY      **NO**   ← AA1
  before_provider_request  every provider call             yes  [S4]
  context                  every provider call             yes  [Z3]
  message_start            each assistant message          yes
  message_update           each delta                      yes
  tool_result              each tool result                yes
  message_end              each assistant message          yes  [X1 X2 X3 Z3]
  agent_end                each agent RUN                  yes  ← THE LADDER
  ──────────────────────────────────────────────────────────────────────────────
```

`before_agent_start` is the only row that is not "every time the thing happens",
and nothing said so until this pass. pi emits it from one place —
`AgentSession.prompt()`, `agent-session.js:885` — and the loop drives every turn
it owns through `sendCustomMessage`. So the handler ran on operator-typed turns
and on nothing else. That is AA1. It now returns a per-turn `message` instead of
a `systemPrompt`, for the second reason in AA1: what it returned outlived the run.

### 2.2 One turn, read ten ways

One turn, two messages, and what each consumer takes out of it. Unchanged from
the ninth pass except for the last row.

```
   msg A  [ {type:"text", text:"LOOP_DONE: the feature is shipped."} ]
   msg B  [ {type:"thinking", thinking:"…already said so, nothing to do"} ]
   toolCallsThisTurn = 0

   ──────────────────────────────────────────────────────────────────────────────
   reader                        derives from                    takes
   ──────────────────────────────────────────────────────────────────────────────
   message_end                   messageToText(m)
     ↳ turnAssistantTexts          || messageToRepetitionText(m)     A,B
       (the repetition WINDOW's     SANITIZED message
        feed — one entry/turn)

   message_end                   messageToText(m)                    A
     ↳ turnAnswerTexts             text only, SANITIZED   [W1]
       (did the turn ANSWER)

   message_end                   messageToRepetitionText(m)          A,B
     ↳ turnRepetitionTexts         text AND thinking, ORIGINAL  [X2][X5]
       (what the model produced)

   agent_end  committedText      commitTurnMemory(texts,calls,       A
     ↳ detectStuck rules 3–8       answers)                    [X1]
       and the WINDOWS              last ANSWER, else last tracked

   agent_end  turnAnswerText     last of turnAnswerTexts             A
     ↳ emptyResponse                ?? messageToText(last)      [W1]
     ↳ /LOOP_DONE:/ /LOOP_BLOCKED:/

   agent_end  turnEmittedTexts   turnRepetitionTexts                 A,B
     ↳ detectStuck rule 1           ?? [messageToRepetitionText [X2]
       (degenerate repetition)        (last)]
     ↳ reasoningOnlyResponse,
       and its char count

   agent_end  lastAssistantText  messageToText(lastAssistant)        ""
     ↳ the model-error reason line   the LAST MESSAGE only
     ↳ the fallback for the two buffers above

   agent_end  prepText           last of turnAnswerTexts             A
     ↳ /GOAL_READY:/                ?? messageToText(last)      [X3]

   subagents  runTurnLoop        collectResponseText: one entry      A
                                   per message, last non-empty [Z1]

   subagents  the fallback       the run's OWN messages, held        A
                                   by reference                 [Z1]
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
   ├─ checkCommand → runGoalCheck() → applyCheckOutcome()          ← AA2
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

   SEVEN of those exits end in `if (!ctx.hasPendingMessages()) scheduleLoopTurn(…)`.
   The guard is right for all of them — the loop only needs *a* turn, and a
   pending message will cause one. What is not right is the belief about WHEN it
   is true: in an unattended run it never is, because the only messages that
   register are typed ones. That is AA3.
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
   7  last three TURN tool signatures equal   recentToolResults        U2  ← §9
   8  same question repeated (ends in "?")    committedText + snippets V2  [X1]
   ──────────────────────────────────────────────────────────────────────────────
```

Rule 7's input is `fingerprint(text)` of each tool result, taken in the loop's own
`tool_result` handler. That handler runs **before** `compaction-guard`'s output
cap, so it fingerprints the raw output. If the two extensions were loaded the
other way round it would fingerprint the capped text, whose marker names a spill
file keyed by the tool-call id — unique per call, so the rule could never match.
§9.

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
      │              await switchModel → pi.setModel, which returns FALSE when
      │              the provider has no configured auth — checked (§7)
      │              → scheduleLoopTurn("rescue", 0, ctx)   ── UNCONDITIONAL
      │
      ├─ compact     saturated || (streak >= 5 && iterations since last
      │              compaction >= 5)
      │              ctx.compact({onComplete: scheduleLoopTurn("stuck", 0),
      │                           onError:    scheduleLoopTurn("stuck", delay)})
      │              ── UNCONDITIONAL. NOT wrapped in a try (§9), and it
      │                 ABORTS the session first: AgentSession.compact()'s
      │                 first statement is `await this.abort()` (§7)
      │
      └─ strategy    otherwise
                     delay := min(60, 2 ** min(streak, 6)) seconds
                     rotating STUCK_STRATEGIES[interventionCount % 5]
                     streak >= 3 adds the HARD RESET block
                     ctx.hasPendingMessages()          ← only a human can  AA3
                       ? sendLoopTurn(…, {queueOnly:true})   make this true
                       : scheduleLoopTurn("stuck", delay, ctx)

                       queueOnly: deliverAs "steer", triggerTurn true      Z4
                          → agent.steer() → _handlePostAgentRun →
                            continue() → the SAME turn as the pending message
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
       is ever written back.

  2. BOUND WHAT ARRIVES    compaction-guard's tool_result cap — §5
       a single tool result may spend 10% of the REMAINING window, floored at
       1,500 chars and ceilinged at 20,000, head 70% / tail 30%, the overflow
       written to a temp file the marker names

  3. DETECT PRESSURE       agent_end → isContextPressure()      ← V1 W1 [X4]

  4. RECOVER               deferred to agent_settled, because pi runs its own
                           overflow recovery after agent_end and wins the race
       attempt 1,2   → emergency compaction, tighter summary each time
       attempt 3     → cooldown 60s → 120s → 240s, tighter still
       cooldown 4    → pauseForContextFailure — the only place the loop gives up

  5. BOUND WHAT SURVIVES   compaction-guard's summary cap — §5
       5% of the window, section-aware, so the accumulator settles instead of
       growing with iteration count
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
  /loop finish (idle)      ✗         ✗         ✗          ✗            ✗   §9
  ────────────────────────────────────────────────────────────────────────────────

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
    │                      → setSessionName → bindExtensions
    │                      → resolveVisibleTools → setActiveToolsByName
    │                          ▲ rebuilds the system prompt from the resource
    │                            loader's override, so the child's own prompt
    │                            survives — verified this pass, §7
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

### 3.2 What a run says, and how the runner decides

```
   provider stream                     pi                       the runner
   ───────────────────────────────────────────────────────────────────────────
   text_delta ─────────▶ message_update {assistantMessageEvent} ─┐
                                                                 │ collectResponseText
   done ───────────────▶ message_end   {message: finalMessage}  ─┤ src/agents/
                                                                 │  run-answer.ts
   a drained steer ────▶ message_start {message: role "user"}   ─┘

   const answers: string[] = []
   message_start  → flush(): push text if it said anything
   text_delta     → text += delta
   message_end(assistant) → keep the message, BY REFERENCE
   getText()      → flush(); last non-empty of answers
   getLastMessageText() → walk the kept messages back to text

   runTurnLoop returns  collector.getText().trim() || collector.getLastMessageText()

   Both sides are scoped to THIS run by the collector's own buffers, so neither
   can surface an earlier run's text and neither depends on an index into an
   array pi replaces on every compaction (`agent-session.js:1435`, `:1673`). Z1.
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

`session.abort()` is `abortRetry(); agent.abort(); await waitForIdle()` — read
this pass (§7). Both call sites `void` it with a `.catch(() => {})`, which is
right: the `waitForIdle` inside it cannot resolve until the run this subscriber
is inside has finished, so awaiting it from a `turn_end` handler would deadlock.

### 3.4 `steer()` — three branches, one brief

```
   manager.steer(id, message)
     │
     ├── status === "running"
     │     ├── no session yet ─▶ pendingSteers.push(message)
     │     │                     growBrief(record, message)              W3
     │     └── session ────────▶ await session.steer(message)
     │                           growBrief(record, message)              W3
     │
     └── terminal ────────────▶ continueSettledAgent(record, message)
                                 · re-reserve the slot · growBrief
                                 · record.verification := undefined
                                 · restart the watchdog
                                 · re-attach the settlement chain
                                 · runSessionPrompt again        ← Z1 applies here

   record.execution.brief has three readers and all three are consequential:
       verifyAnswer(record, brief, deps)   what the answer is CHECKED against
       buildRepairPrompt(brief, why)       what the child is told to answer
       buildAnchorMessage(brief)           what is restated after a compaction
```

`session.steer(text)` — the AgentSession method, not `pi.sendMessage` — DOES fill
`_steeringMessages` (`agent-session.js:994`), so a steer into a child is visible
to that child's own `hasPendingMessages()`. The parent's is not. §7, AA3.

### 3.5 The task anchor

```
  AgentManager.runTrackingCallbacks.onCompaction
     record.stats.compactionCount++
     if (brief && session && anchorReachesATurn(info))          ← Z2
         session.steer(buildAnchorMessage(brief))

  anchorReachesATurn(info) = info.afterRun !== true || info.willRetry === true

     subscribeToSessionEvents
        agent_start → afterRun = false
        agent_end   → afterRun = true
        compaction_end → onCompaction({reason, tokensBefore, afterRun, willRetry})
```

pi's two compaction call sites and what a steer does at each:

```
   prompt()               :865   idle, a run is about to start
      steer → _steeringMessages → the new run's first getSteeringMessages
      → injected alongside the prompt, no extra turn.        ✔ the design

   _handlePostAgentRun()  :776   the agent loop has emitted agent_end
      steer → hasQueuedMessages() true → agent.continue() → assistant-last
        branch drains the queue and runs it as a prompt → a WHOLE EXTRA RUN
      → and its reply is the run's last message              ✘ Z2
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

**That measurement is why AA1's second half matters.** A system prompt that
changes between turn 1 and turn 2 of the same run evicts the prefix at offset 0,
which is strictly worse than what the concurrency default was set to avoid.

### 3.7 What a child inherits

```
   the PARENT is started with  -e .pi/extensions/stack.ts
                               -e .pi/extensions/browser-guard.ts
                               -e vendor/pi-loop-mode
                               -e .pi/extensions/compaction-guard
                               -e vendor/pi-subagents-lite
                               -e vendor/prinny-channel  -e vendor/rtk-pi
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

   `compaction-guard` DOES reach a child, and is wanted there: the tool-output
   cap and the context notice are exactly as useful in a child's 32k window as in
   the parent's. Its `spillDir` is module-global and therefore shared with the
   parent, which is harmless — the files are keyed by tool-call id.
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
or a repair the record used to be unstoppable: the operator's Esc reached
`stopAgent()`, which returned false; `StopAgent` the same. Meanwhile the parent's
`Agent` call is blocked on the completion gate, which does not open until
verification returns, so a 300 s per-call deadline was the only exit.

That was T5, and this pass closed it (§9.7). `runVerification` arms
`record.execution.verifyAbort`; `stopAgent()` recognises a verifying record and
aborts it **before** the `status === "running"` test that would return false; and
`startDeadline` composes that signal with its timer, so the call ends on whichever
comes first, with a different sentence for each. The abort routes through
`verifyAnswer`'s catch, which is already the "the check did not happen" path — the
child's answer is preserved and annotated.

The deadline stays, because nobody presses Esc in a cron job. Clear is still
refused (Y1): `removeRecord` disposes the session a repair runs in. `/agents`
offers a verifying record exactly one action, **"Stop the answer check"**, named
that way because the child's own run has already finished and a bare "Stop" would
be a claim about the wrong run. The watchdog still deletes a verifying record's
state rather than skipping it, and that is harmless: the per-call deadline is
minutes where the watchdog is 45 of them, and `continueSettledAgent` restarts it.

---

## 5. `compaction-guard` — the extension nine passes never opened

It is not in `vendor/`, it registers no tools and no commands, and every prior
document has listed it as "untouched, 39 tests". It is also the only extension a
CHILD inherits by discovery that does substantive work there — `browser-guard` is
harmless and `stack` guards itself (U7) — and it shares two events with the loop.
So it is documented here, in full, for the first time.

```
 ┌─ .pi/extensions/compaction-guard ────────────────────────────────────────────┐
 │  three handlers, all of which only ADD a bounded line or SHRINK a string     │
 │  pi was about to send. Each swallows its own errors.                         │
 │                                                                              │
 │  1. session_before_compact ── bound the ACCUMULATOR                          │
 │     preparation.previousSummary, MUTATED IN PLACE, returns undefined         │
 │       cap = 5% of the window × 4 chars/token, clamped [2k, 20k]              │
 │       section-aware: split on `##`, drop whole sections by SECTION_PRIORITY   │
 │         ## Goal ▸ ## Next Steps ▸ ## Constraints ▸ ## Key Decisions           │
 │         ▸ ## Critical Context ▸ ## Progress                                  │
 │       reassembled in ORIGINAL order + a fixed TRIM_MARKER                    │
 │                                                                              │
 │     Why: pi's UPDATE_SUMMARIZATION_PROMPT says "PRESERVE all existing        │
 │     information from the previous summary", so the summary is monotonic by   │
 │     construction. Measured over 42 real compaction points: 456 / 4,029 /     │
 │     11,054 chars, and within one session only ever up (1,666 → 11,054).      │
 │     The summarizer's own maxTokens is min(0.8 × reserveTokens, model max) =   │
 │     13,107 here, i.e. not a limit. Capping the INPUT makes each summary       │
 │     settle at ~cap + one round of new material.                              │
 │                                                                              │
 │     Mutating in place is checked, not assumed: ExtensionRunner.emit()        │
 │     (runner.js) passes the event by reference with no structuredClone, and   │
 │     agent-session.js then calls compact(preparation, …) with that same       │
 │     object on both the manual and the auto path. If a future pi clones it,   │
 │     the mutation stops having an effect and pi's behaviour returns.          │
 │                                                                              │
 │  2. tool_result ────────── bound what ARRIVES                                │
 │     allowance = 10% of the REMAINING window × 4, clamped [1.5k, 20k]         │
 │       (remaining unknown — right after a compaction — → the 20k ceiling)     │
 │     head 70% / tail 30%, cut at a line boundary when one is close            │
 │     overflow written to mkdtemp()/pi-tool-output-*/<tool>-<callId>.txt       │
 │     marker names the file, the % context, and what to do instead             │
 │     errors and image blocks are never capped                                 │
 │                                                                              │
 │     Why an advisory was not enough — reconstructed from a real session,      │
 │     2026-08-17:                                                              │
 │        entry 46   26,989 tok  82.4%   CRITICAL notice in context             │
 │        entry 48   27,684 tok  84.5%   CRITICAL notice in context             │
 │                                       → the model ran a 3-URL curl loop      │
 │        entry 49   tool result 17,790 chars (~4,447 tokens)                   │
 │        entry 50   32,766 tok 100.0%   empty turn                             │
 │        entry 51   compaction                                                 │
 │     Nobody knows how many bytes a pipeline will print until it has printed   │
 │     them, so the bound has to be applied to the output, not requested of     │
 │     the caller. 0.10 rather than 0.20 because a fifth of the remainder at    │
 │     that moment lands the run at 88.5% — above the 87% cliff, i.e. theatre.  │
 │     A tenth lands it at 86.8%.                                               │
 │                                                                              │
 │  3. context ───────────── tell the MODEL                                     │
 │     >= 60% advisory, >= 80% CRITICAL, customType                             │
 │     "compaction-guard-context-budget"; stands down when any message already  │
 │     carries a customType matching /-context-budget$/                         │
 └──────────────────────────────────────────────────────────────────────────────┘
```

**Where it meets the loop**, and both orderings matter:

```
   event                     loop (registered 3rd)     guard (registered 4th)
   ───────────────────────────────────────────────────────────────────────────
   session_before_compact    may return {compaction}   mutates previousSummary,
                             — a locally built          returns undefined
                             handoff on a small
                             window
                             ↳ LAST TRUTHY WINS and results are NOT threaded
                               (runner.js emit()), so the loop's handoff
                               survives. And buildHandoffCompaction never reads
                               previousSummary, so the guard's trim cannot
                               change it. Re-verified. §10.
                             ↳ but the guard still TRIMS and still NOTIFIES on
                               a compaction whose summary pi will not write. §9.

   tool_result               fingerprints the RAW      caps the text
                             text into turnToolCalls
                             ↳ order decides which text detectStuck rule 7
                               fingerprints. Correct today; the launcher's
                               comment says a different order "costs a
                               duplicate line, not a bug". §9.

   context                   appends                   stands down on seeing
                             `loop-context-budget`     the `-context-budget`
                                                       suffix
                             ↳ threaded (runner.js:747), both sides check,
                               correct in either order. Documented.
```

---

## 6. A delegation, on a timeline

```
  parent turn N                                                  parent turn N+1
  ────────────┐                                                  ┌──────────────
              │  Agent(prompt, agent: "Explore")                 │
              ▼                                                  ▲
   ┌──────────────────────────────────────────────────┐          │
   │ SLOT HELD ════════════════════════════════════   │          │
   │                                                  │          │
   │  build   detectEnv (2× git via pi.exec, ~100 ms) │          │
   │            ↳ execGit's catch is unreachable —    │          │
   │              pi.exec never rejects. Harmless      │          │
   │              here: code !== 0 → null anyway. The  │          │
   │              control for AA2.                     │          │
   │          buildAgentPrompt                        │          │
   │          reloadAndMap  (every extension factory) │          │
   │          createAgentSession → onSessionCreated   │          │
   │          bindExtensions (child session_start)    │          │
   │          setActiveToolsByName → rebuilds the     │          │
   │            child's system prompt from the loader │          │
   │                                                  │          │
   │  run     session.prompt(prompt)                  │          │
   │            ↳ THIS path emits before_agent_start, │          │
   │              so a child gets it and the parent's │          │
   │              loop turns do not.          [AA1]   │          │
   │          agent RUN #1: turn 1 … turn k           │          │
   │            ← llama, one at a time                │          │
   │            an operator steer lands mid-run       │          │
   │            turn maxTurns → wrap-up steer         │          │
   │          agent_end                               │          │
   │                                                  │          │
   │  ── _handlePostAgentRun ──────────────────────── │          │
   │     retry?  compaction?  queued messages?        │          │
   │       compaction at >= the threshold             │          │
   │         → counted; the anchor is NOT sent   Z2   │          │
   │                                                  │          │
   │  settle  status ← classifyRun(result)            │          │
   │          result ← the RUN's answer         ← Z1  │          │
   │                                                  │          │
   │  verify  judge   ← a WHOLE extra session + 1 turn│          │
   │          repair  ← 1+ turns in the CHILD's       │          │
   │          judge   ← again                         │          │
   │            ── stoppable (T5, closed) but not     │          │
   │               clearable from /agents (Y1)        │          │
   │                                                  │          │
   │ ══════════════════════ SLOT RELEASED ══════════  │          │
   └──────────┬───────────────────────────────────────┘          │
              │ tally · drainQueue · openGate ─────────────────▶ │
              │                                                  │
              │ (background instead: capBackgroundResult →        │
              │  pi.sendMessage deliverAs:"steer", triggerTurn.   │
              │  BUSY  → agent.steer → inside the running turn.   │
              │  IDLE  → _runAgentPrompt, deliverAs discarded,    │
              │          and NO before_agent_start.   [AA1][AA4]) │
```

---

## 7. The host-call ledger

This is what the pass was for. **Every distinct pi API the four packages call**,
pi's implementation read out of `dist/` (0.84.2, the version installed in this
image), and what happens to the value. The verdict column is about the *call
site's own belief*, not about whether the code compiles.

Legend: ✔ the call site's comment survives reading pi · ⚠ true, with a
consequence nobody had written down (§9) · ✘ a finding.

### 7.1 `ExtensionAPI` — the object an extension is handed

```
 call                    pi implementation                     where it ends up
 ══════════════════════════════════════════════════════════════════════════════
 pi.on(event, fn)        loader.js:209                         extension.handlers
   ⚠ assertActive() first. A `pi` captured across ctx.reload() / newSession()
     THROWS here, with a long message dispose() installs. The subagent shell
     re-reads `pi` at call time for exactly this reason.

 pi.registerTool(t)      loader.js:215                         extension.tools
   ⚠ then calls runtime.refreshTools() → _refreshToolRegistry() →
     setActiveToolsByName() → _rebuildSystemPrompt(). Registering a tool
     rebuilds the system prompt. Harmless: registration happens at factory
     time, before the session's first prompt.

 pi.registerCommand      loader.js:223                         extension.commands
   ✔ a name→handler map. `AgentSession.prompt()` dispatches to it BEFORE any
     turn machinery (:800), and returns — so a slash command never emits
     before_agent_start, never compacts, and never runs a turn. That is why
     `/loop start` can leave a session whose agent.state.systemPrompt has never
     seen the loop.                                                     [AA1]

 pi.registerMessageRenderer                                    extension.messageRenderers
   ✔ keyed by customType. `loop` and `subagent-result` both register one.

 pi.sendMessage(msg,opt) agent-session.js:1846 → sendCustomMessage :1068
   ✘ FOUR destinations, chosen by (deliverAs, isStreaming, triggerTurn) — §1.A.
     · deliverAs "nextTurn"  → _pendingNextTurnMessages, drained ONLY by
       prompt(). An unattended loop cannot reach that drain.              Z4
     · streaming             → agent.steer() / agent.followUp(). Agent's own
       queues, invisible to pendingMessageCount.                         AA3
     · idle + triggerTurn    → _runAgentPrompt: a whole run, with NO
       before_agent_start and NO _checkCompaction, and deliverAs discarded.
                                                                    AA1 · AA4
     The wrapper `.catch`es and turns a rejection into an extension error, so
     the call is void and a failure is a notice, not a throw.

 pi.appendEntry(t, data) agent-session.js:1864
   ✔ sessionManager.appendCustomEntry(type, data) → a `{type:"custom"}` entry,
     appended as a child of the leaf, **advancing the leaf**, persisted, then
     `_emit({type:"entry_appended"})`. Returns nothing.
   ⚠ Three consequences the loop's ~33 persistState() sites live with:
     · the branch grows by one entry per persist. `findHandoffCutEntryId`
       ignores them (`entryChars` returns 0 for a non-message entry, and they
       are neither turn-starts nor standalone) — checked this pass.
     · they do NOT enter the LLM context. `appendCustomEntry` is not
       `appendCustomMessageEntry`, which is the one that "participates in LLM
       context".
     · after a compaction the loop's `session_compact` handler persists, so the
       branch no longer ENDS in a compaction entry and `branchEndsInCompaction`
       reads false. Degrades to pi's own refusal, whose message
       ("Nothing to compact") the loop's benign-error regex also matches. §9.

 pi.exec(cmd,args,opts)  loader.js:287 → core/exec.js execCommand
   ✘ `new Promise((resolve) => …)` with **no reject in the body**. Timeout →
     kill → resolve; spawn error → waitForChildProcess rejects → `.catch` →
     resolve `{code:1}`; non-zero exit → resolve. And a SIGTERM'd child exits
     with a signal and no code, so `code: code ?? 0` makes a **timeout look
     like success**.                                                     AA2
     Three call sites believed otherwise: `runGoalCheck` (fixed),
     `worktree-validator.getGitCommonDir` (GIT_NOT_FOUND / GIT_TIMEOUT are
     dead constants — §9), and `agent-runner.execGit` (the control: its catch
     is unreachable and harmless, because `code !== 0 → null` anyway).
     `runtime.assertActive()` runs first, so the catch is not dead in general —
     a stale runtime still throws.

 pi.setModel(model)      agent-session.js:1885
   ✔ returns **false** without switching when the provider has no configured
     auth; otherwise awaits setModel and returns true. `switchModel()` reads
     the boolean and `interveneStuck` acts on it. Correct.
 ══════════════════════════════════════════════════════════════════════════════
```

### 7.2 `ExtensionContext` — the object each handler is handed

```
 call                    pi implementation                     where it ends up
 ══════════════════════════════════════════════════════════════════════════════
 ctx.isIdle()            runner.js:500 → () => this.isIdle     !_isAgentRunActive
   ✔ and it is the exact complement of `isStreaming` (:588/:592), which is what
     makes AA4's ternary a ternary with one live arm.

 ctx.hasPendingMessages() runner.js:516 → pendingMessageCount  :1151
   ✘ `_steeringMessages.length + _followUpMessages.length`. Those two arrays
     are written ONLY by `_queueSteer`/`_queueFollowUp` (:1017/:1033), reachable
     only from `prompt()` while streaming, `steer()`, `followUp()` and
     `sendUserMessage()`. `sendCustomMessage` bypasses them. So the answer is
     about the OPERATOR's keyboard.                                     AA3
   ⚠ entries are removed by matching the message TEXT on `message_start`
     (:348), so two identical queued texts remove one entry each, in order.

 ctx.getContextUsage()   runner.js:524 → getContextUsage()
   ✔ `{tokens, contextWindow, percent}`, or `{tokens:null, …}` when the branch
     has a compaction with no assistant usage after it, or `undefined` when
     there is no model or no window. Both the loop and compaction-guard handle
     all three. `tokens` is `estimateContextTokens(this.messages)` — an
     ESTIMATE over `agent.state.messages`, not the provider's reported usage.

 ctx.compact(options)    runner.js:528 → agent-session.js:1911
   ✘ nothing is returned and nothing is awaited: it fires an async IIFE that
     awaits `this.compact(options?.customInstructions)` and then calls
     `options.onComplete(result)` — or `options.onError(err)`. **With no
     onError, a failed compaction is swallowed entirely** (unlike sendMessage,
     which reports an extension error). Both loop call sites pass one; that is
     the control.
   ⚠ `AgentSession.compact()`'s FIRST statement is `await this.abort()`, and it
     sets `_compactionAbortController`, while which `prompt()` throws
     "Cannot submit a prompt while compaction is in progress" (:805). The loop
     never hits that because it delivers turns through `sendCustomMessage`, not
     `prompt()` — the same fact as AA1, benign here. §9.

 ctx.abort()             runner.js:512 → :1899
   ✔ `if (_extensionAbortHandler) { it(); return; } void this.abort();` — the
     mode installs a handler in a TUI, so `ctx.abort()` usually reaches the
     app's abort path rather than the session's. Void either way; nothing can
     await it.

 ctx.getSystemPrompt()   runner.js:532 → :1923 → :596        agent.state.systemPrompt
   ✘ NOT `_baseSystemPrompt`. It returns whatever the last `prompt()` left on
     `agent.state`, so with `systemPromptMode: "inherit"` a child would inherit
     the parent's stale before_agent_start block. Not reachable today — the
     default is "replace" (`config-io.ts:69`) — and now not producible either,
     because after AA1 nothing in this stack returns a systemPrompt. §9.
   ⚠ inside `emitBeforeAgentStart` the ctx's `getSystemPrompt` is SHADOWED
     (runner.js:840–:843) to return the value threaded so far, which is the correct
     thing for a handler to read and a different value from the one above.

 ctx.isProjectTrusted()  runner.js:504                        settingsManager
   ✔ read-only.

 ctx.ui.notify(msg,kind) the mode's UI                        the transcript
   ⚠ **`noOpUIContext.notify` is `() => {}`** (runner.js:92). Outside a TUI
     every operator-facing line the loop and the guard emit is discarded
     silently. `ctx.hasUI` says so and neither module checks it. The loop's
     `.pi-loop-log.jsonl` is the only trace of an unattended run's decisions,
     which is an argument for keeping `logIteration` complete. §9.

 ctx.sessionManager.getBranch()                               readonly entries
   ✔ walks parent links from the leaf and reverses; includes `custom` entries.
     `branchEndsInCompaction` and `buildHandoffCompaction` both read it.

 ctx.model / ctx.cwd / ctx.modelRegistry
   ✔ lazy getters behind assertActive(); `ctx.model` is the live model, so it
     changes under a rescue switch, which is what `switchModel` relies on.
 ══════════════════════════════════════════════════════════════════════════════
```

### 7.3 `AgentSession` — what the subagent runner calls on a CHILD

```
 call                    pi implementation                     where it ends up
 ══════════════════════════════════════════════════════════════════════════════
 createAgentSession(opts)                                     a whole session
   ✔ the child gets its own SessionManager (in-memory), settings, model,
     resource loader and ExtensionRunner. `resourceLoader.systemPromptOverride`
     is how the child's prompt is carried — see setActiveToolsByName.

 session.subscribe(fn)   :535                                 _eventListeners
   ✔ returns an unsubscribe closure that splices THIS listener. `_emit` calls
     listeners **synchronously** (:298), which is what makes `wireTurnTracking`'s
     `turn_end` handling land before the agent loop's next steering drain — the
     fact T1 and the `g1` stub both rest on.

 session.prompt(text)    :792
   ✔ the full entry point: compaction check, nextTurn drain,
     before_agent_start, then `_runAgentPrompt`. So a CHILD does receive
     before_agent_start; the parent's loop turns do not.               [AA1]
   ⚠ `expandPromptTemplates` defaults to TRUE and this fork calls it bare, so a
     child prompt beginning with `/` is dispatched as a command. That is the
     reason `normalizeMaxTurns` gives every child a ceiling (turn-tracking.ts).

 session.steer(text)     :986 → _queueSteer :1016
   ✔ expands skill/template first, THEN pushes to `_steeringMessages` and
     `agent.steer()`. So a steer into a child IS visible to the child's own
     `hasPendingMessages()` — unlike `pi.sendMessage`.                  AA3
   ✘ it does not add context, it asks a question, and `_handlePostAgentRun`
     restarts a finished loop to answer it.                              Z2

 session.abort()         :1168
   ✔ `abortRetry(); agent.abort(); await waitForIdle();`. Both turn-ceiling
     call sites `void` it with a `.catch(() => {})`, which is REQUIRED, not
     sloppy: they run inside a synchronous `turn_end` subscriber, so the
     `waitForIdle` inside cannot resolve until the run they are inside has
     ended. Awaiting it there would deadlock.

 session.setSessionName(n) :…                                 a session_info entry
   ✔ sanitises newlines, appends an entry.

 session.bindExtensions(opts)
   ✔ loads and binds the child's extensions, fires the child's `session_start`.
     Can reject — which is the exit W6 moved `onSessionCreated` above.

 session.getActiveToolNames()                                 string[]
   ✔ read-only.

 session.setActiveToolsByName(names) :631
   ⚠ **silently drops any name not in `_toolRegistry`** — no error, no warning.
     A `tools:` frontmatter entry naming a tool that does not exist yields a
     smaller tool set and says nothing. (U6 fixed the `true`/`false` spellings;
     this is the unknown-NAME case, one level down.) §9.
   ✔ then rebuilds `_baseSystemPrompt` via `_rebuildSystemPrompt(validNames)`,
     which takes `customPrompt` from `resourceLoader.getSystemPrompt()` — the
     child's own override. So the rebuild PRESERVES the child's system prompt.
     Verified this pass; it is the one thing that could have silently thrown the
     child's brief away and does not.

 session.getSessionStats() :…                                 counts + usage + ctx
   ✔ walks every entry each call. `usage.ts` reads only `contextUsage.percent`.

 session.dispose()       :556
   ✔ aborts retry/compaction/branch-summary/bash and the agent, then
     `_extensionRunner.invalidate(<stale message>)` — after which every
     `assertActive()` on THAT runner throws — then clears listeners. Per-child,
     so it cannot invalidate the parent's runner.
 ══════════════════════════════════════════════════════════════════════════════
```

### 7.4 Handler return values — the eighth pass's half, re-verified

Carried forward from `…-answers.md` §8.1 and re-read against the same `dist/`.
Unchanged.

```
   event                     pi's use of the return value              faithful?
   ───────────────────────────────────────────────────────────────────────────
   message_end               THREADED into the next handler's event,   ✔
                             then _replaceMessageInPlace over the
                             object agent_end reads     runner.js:610
   context                   THREADED; operates on a structuredClone   ✔
                             of the message array      runner.js:747
   before_provider_request   THREADED; the last payload wins           ✔
                                                       runner.js:776
   before_agent_start        systemPrompt THREADED via a SHADOWED      ✔ now
                             ctx.getSystemPrompt(); `message` results    (AA1)
                             collected                 runner.js:837
   tool_result               content/details/isError/usage merged      ✔
                             into ONE shared currentEvent, later
                             handlers see the merge     runner.js:649
   tool_call                 last non-undefined wins; `block` returns  n/a
                             immediately               runner.js:701
   user_bash                 FIRST truthy result wins  runner.js:720   n/a
   before_provider_headers   IGNORED — handlers mutate `headers` in    n/a
                             place                     runner.js:808
   session_before_compact    LAST truthy result wins, NOT threaded;    ✔
                             `cancel` returns immediately runner.js:589
   everything else           IGNORED — the generic emit() keeps a      ✔
                             result only for isSessionBeforeEvent
                                                       runner.js:579
```

### 7.5 The four surfaces, as a checklist

The ledger above is long because the contract has four sides, and a defect can
sit on any of them. For the next module, or the next pi upgrade:

```
   ┌─ 1. what we RETURN from a handler ────────────────────────────────────┐
   │    threaded? last-wins? first-wins? ignored? written back in place?   │
   │    X5 lived here.                                          §7.4       │
   ├─ 2. what we PASS to a call ──────────────────────────────────────────┤
   │    which branch does each argument select, and who drains the queue   │
   │    it lands in? Z1, Z2, Z4, AA4 live here.               §7.1–§7.3    │
   ├─ 3. which events REACH us at all ────────────────────────────────────┤
   │    how many emit sites does the host have, and can our own code path  │
   │    reach one? AA1 lives here.                              §2.1       │
   └─ 4. what a host function's return value CAN say ─────────────────────┘
        can it fail? does it distinguish the failures we branch on? does a
        rejection exist? AA2 lives here.                        §7.1

   Nine passes read surface 1 and then surface 2. Surfaces 3 and 4 had never
   been asked about, and they are where the two HIGH findings were.
```

---

## 8. Findings

Severity is about what it costs a real run. Evidence is **PROVEN** (an executable
probe drives the shipped module), **MEASURED** (a number taken from the tree or
from pi), or **SOURCE** (read, with the reasoning in the finding).

| # | Finding | Sev | Evidence | Probe | Sibling of | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AA1 | pi emits `before_agent_start` from one call site — `AgentSession.prompt()` — and the loop drives every turn it owns through the other entry point, so the handler that puts the loop's rules in the system prompt never ran on a loop turn; and what it returned on an operator-typed turn outlived the run on `agent.state.systemPrompt`, appearing on turn 1 of the next iteration and vanishing on turn 2 | **HIGH** | PROVEN·SOURCE | `n1` | Z4, S3 | ✔ fixed |
| AA2 | `pi.exec` never rejects, so U3's `execFailed` branch was unreachable — and a check killed on its own timeout resolves with exit code **0**, so a deadlocked check reads as a check that PASSED and completes an `--until-done` run | **HIGH** | PROVEN·MEASURED | `n2` | U3, S1 | ✔ fixed |
| AA3 | `ctx.hasPendingMessages()` counts two arrays only an operator's keyboard can fill, so V4's branch and Z4's repair of it are both about a state an unattended run cannot enter | **MEDIUM** | PROVEN·SOURCE | `n3` | V4, Z4 | ✔ fixed as a claim |
| AA4 | the background result's `deliverAs` is chosen by a ternary whose other arm pi never reads: the idle case lands on the branch that discards the value | **LOW** | PROVEN·SOURCE | `n4` | W1, X1–X3 | ✔ fixed |

---

### AA1 — the event the loop cannot reach, and the prompt that would not leave · **HIGH** · PROVEN·SOURCE · **FIXED**

**Where.** `extensions/index.ts`'s `before_agent_start` handler, against pi's
`agent-session.js:885`, `:902`/`:903`, `:753`, `:274`/`:286` and `:1090`.

**What, part one — it never ran.** The handler's job is to append the loop's goal
and rules to the system prompt:

```js
  pi.on("before_agent_start", async (event) => {
    if (!state.active) return;
    return { systemPrompt: `${event.systemPrompt}\n\nLoop mode is active. Goal: …` };
  });
```

pi emits that event from **exactly one place**, and the probe counts it out of
the shipped `dist/` rather than asserting it:

```
   agent-session.js:885   const result = await this._extensionRunner
                            .emitBeforeAgentStart(expandedText, currentImages,
                              this._baseSystemPrompt, this._baseSystemPromptOptions);

   total call sites: 1     (and it is inside AgentSession.prompt())
```

The loop never calls `prompt()`. Every turn it drives goes
`scheduleLoopTurn` → `sendLoopTurn` → `pi.sendMessage(msg, {triggerTurn: true})`
→ `sendCustomMessage` (`:1068`) → `_runAgentPrompt(appMessage)` (`:1090`), and
`_runAgentPrompt` (`:744`) is nine lines with no `emitBeforeAgentStart` in them.
Nor can the loop get there another way: `/loop start` is an extension command,
and `prompt()` dispatches those at `:800` and **returns before any turn
machinery**.

So in an unattended run — the mode this package exists for — the handler ran zero
times.

**What, part two — and when it DID run, it did not stop.** `prompt()` writes the
returned text to two places:

```js
  if (result?.systemPrompt !== undefined) {
      this._systemPromptOverride    = result.systemPrompt;   // :902
      this.agent.state.systemPrompt = result.systemPrompt;   // :903
  } else {
      this._systemPromptOverride    = undefined;             // :907
      this.agent.state.systemPrompt = this._baseSystemPrompt;// :908
  }
```

and `_runAgentPrompt`'s `finally` clears **only the first**:

```js
  finally {
      this._systemPromptOverride = undefined;                // :753
      this._flushPendingBashMessages();
      await this._emitAgentSettled();
  }
```

Meanwhile `_installAgentNextTurnRefresh` (`:274`) rebuilds the context after every
`turn_end`:

```js
  this.agent.prepareNextTurnWithContext = async (turn, signal) => ({
      …, context: { …, systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
                       tools: this.agent.state.tools.slice() }, … });   // :286
```

and turn 1 of a run does **not** go through it — `Agent.runPromptMessages` builds
its context from `createContextSnapshot()`, which reads `this._state.systemPrompt`.

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │  a run that came through prompt()                                    │
   │    turn 1   agent.state.systemPrompt   = base + loop block           │
   │    turn 2+  override ?? base           = base + loop block   ✔ same  │
   │                                                                      │
   │  the NEXT run, driven by sendCustomMessage                           │
   │    turn 1   agent.state.systemPrompt   = base + loop block  ← stale  │
   │    turn 2+  override ?? base           = base               ✘ change │
   └──────────────────────────────────────────────────────────────────────┘
```

**Proved.** `n1`, which prints the emit sites and `_runAgentPrompt` out of pi's
`dist/`, then drives the shipped loop through a model of pi's two entry points
(every line of which is one of the citations above):

```
   an unattended loop: /loop start, then loop turns
     sendMessage()      turn 1   base prompt only
     sendMessage()      turn 2   base prompt only
     sendMessage()      turn 1   base prompt only
     sendMessage()      turn 2   base prompt only

   the operator types once, then the loop carries on
     prompt()           turn 1   WITH the loop block
     sendMessage()      turn 1   WITH the loop block     ← stale, nothing put it back
     sendMessage()      turn 2   base prompt only        ← changed mid-run
```

**What it costs.**

- **The unattended case:** the loop's system-prompt half was inert. The model was
  never told, at the system level, that a loop was running, what the goal was, or
  that it must not wait for a human. Not fatal — `loopInstructions()` carries all
  of it as a per-turn message — but one of thirteen handlers was doing nothing,
  and every document in this series listed it as active.
- **The attended case, which is worse:** after a single typed turn, the block is
  pinned to `agent.state.systemPrompt` **for the rest of the session**. It shows
  up on turn 1 of every later loop iteration and disappears at turn 2. A system
  prompt is at offset 0 of the cached prefix, so a change there re-prefills the
  **entire** context. §3.6's own measurement of a comparable eviction: 2,117
  cached tokens → 0, and 442 ms → 2,949 ms. And if the loop is restarted with a
  different goal, `state.description` in the pinned copy is the OLD one — two
  goals in one context, the per-turn message naming one and the system prompt the
  other.
- **And it does not end with the loop.** Nothing restores
  `agent.state.systemPrompt`, so a turn driven by *anything* that uses
  `sendCustomMessage` — a background subagent's result delivered to an idle
  parent — runs under "Loop mode is active … never wait for a human … max 1,200
  characters" after `/loop stop`.

**The fix.** Return a per-turn `message` instead of a `systemPrompt`.
`emitBeforeAgentStart` collects `result.message` (`runner.js:863`) and `prompt()`
appends it as one `role:"custom"` message for that turn only (`:889`):

```js
  return {
    message: {
      customType: LOOP_RULES_MESSAGE_TYPE,          // "loop-rules"
      content: `Loop mode is active. Goal: ${state.description}. …`,
      display: false,
    },
  };
```

Nothing is written to `agent.state`, nothing survives the run, and it lands at the
END of the message list — the cheapest position in the prefix. Nothing is lost by
not being in the system prompt either: every turn the loop itself drives already
carries the goal, the criteria and the full rule list in `loopInstructions()`.
This handler's only job is the turn that carries none of that, which is the one a
human typed — and that is the only turn it was ever reaching.

*Tests:* `vendor/pi-loop-mode/tests/system-prompt-leak.test.ts`. Four cases, two
of which fail without the fix; the controls are an inactive loop (which must say
nothing) and the mode hint, which is asserted through a helper that reads either
carrier so it stays a control. `tests/subagent-isolation.test.ts`'s
"does not put the operator's goal into the child's system prompt" was updated to
assert the new shape — its subject, that a CHILD's handler never fires, is
unchanged.

---

### AA2 — the check that could not run, and the timeout that reported success · **HIGH** · PROVEN·MEASURED · **FIXED**

**Where.** `runGoalCheck` at `extensions/index.ts`, against pi's
`core/exec.js` and `utils/child-process.js`.

**What.** U3 (fifth pass) established that a check which could not RUN must not be
recorded as a check that ran and FAILED, and put the distinction in
`CheckOutcome.execFailed`:

```js
  async function runGoalCheck(pi) {
    try   { const result = await pi.exec("bash", ["-lc", state.checkCommand], {…});
            return { passed: result.code === 0, …, execFailed: false }; }
    catch { return { passed: false, …, execFailed: true }; }
  }
```

with `goal-check.ts` naming the trigger: *"`execFailed` is true when `pi.exec`
rejects, i.e. a timeout against `checkTimeoutSeconds`, a missing interpreter, a
spawn failure"*.

`pi.exec` does none of those things. It is `execCommand` (`core/exec.js`), whose
body is a `new Promise((resolve) => …)` **with no `reject` in it at all**:

```js
   timeout        → killProcess() → SIGTERM
   spawn error    → waitForChildProcess rejects → .catch(…) → resolve({…, code: 1})
   exit           → waitForChildProcess resolves(code) → resolve({…, code: code ?? 0, killed})
```

So `execFailed` was unreachable, `checkErrorStreak` never advanced, and
`MAX_CHECK_ERRORS` never fired.

**And the timeout case is worse than unreachable.** A process killed by SIGTERM
exits with a **signal and no code**. `waitForChildProcess`'s `onExit(code)` stores
`null`, `finalize(null)` resolves `null`, and `execCommand` does
`code: code ?? 0`. `runGoalCheck` reads `passed: result.code === 0`.

> **A goal check that hung until it was killed is recorded as a check that
> PASSED.**

In `--until-done` mode `lastCheckPassed === true` is the run's only terminating
condition — and it is the guard V3 added precisely so that *"the check decides"*
cannot mean *"the model decides when the check is broken"*.

**Proved.** `n2`, which calls pi's **real** `execCommand` on the three failures
the docstring names:

```
  case                                   settled   code  killed  → execFailed?
  --------------------------------------------------------------------------
  a binary that does not exist           RESOLVED  1     false   false
  a command that outlives its timeout    RESOLVED  0     true    false
  a check script that is missing         RESOLVED  127   false   false
  control — a check that genuinely fails RESOLVED  1     false   false
  control — a check that passes          RESOLVED  0     false   false
```

and then drives the shipped loop with `--check "sleep 5" --check-timeout 1
--until-done`, three iterations:

```
   BEFORE   Active: false · Status: completed · Check status: passing
            Last notice: Goal check passed: sleep 5

   NOW      Active: true  · the check is reported as unrunnable, the streak
            escalates, and three of them pause the run
```

**What it costs.** Two shapes, and one of them ends the run:

- **`--until-done` completes on a lie.** A check command that deadlocks — a test
  runner waiting on a port, a build that stalls, anything on a loaded one-slot
  box — makes the very next `LOOP_DONE:` terminal. The operator is told the goal
  was met.
- **Everything else is misattributed.** `/loop status` says `failing (streak N)`,
  which is a claim about the project, when the claim belongs to the harness; and
  the `check_failed` directive tells the model *"Fix exactly what the check
  reports"* with a shell diagnostic in place of what the check reports. That is
  U3's original damage, restored by the layer underneath it.

**The fix.** Read the field pi actually provides:

```js
  if (result.killed) {
    return { passed: false, score: undefined,
             output: `the check did not finish within ${state.checkTimeoutSeconds}s and was killed.…`,
             execFailed: true };
  }
```

The `catch` is kept — `pi.exec` still throws synchronously when the extension
runtime has gone stale (`runtime.assertActive()` is the first line of
`loader.js:287`), and that is genuinely "the check could not run".

**Deliberately not fixed: exit code 127.** It is the shell saying "command not
found", which usually *is* a broken check — but a check script may exit 127 for
its own reasons, and misreading a real failure as a broken harness would pause a
run that should have kept working. `killed` is unambiguous; 127 is a guess. It is
a control in the test file, and a note in §9.

*Tests:* `vendor/pi-loop-mode/tests/check-that-cannot-run.test.ts`. Six cases,
three of which fail without the fix; the three controls are a check that really
failed, one that really passed (which must still complete an `--until-done` run),
and the 127 case, which must stay a failing check. The exec shapes in the file
are pi's real ones, taken from `n2`.

---

### AA3 — the pending messages nobody can see · **MEDIUM** · PROVEN·SOURCE · **FIXED AS A CLAIM**

**Where.** Nine `ctx.hasPendingMessages()` call sites in `extensions/index.ts`,
against pi's `agent-session.js:1151`, `:1017`/`:1033` and `:1081`–`:1086`.

**What.** pi answers the question from two arrays:

```js
  get pendingMessageCount() {                                        // :1151
      return this._steeringMessages.length + this._followUpMessages.length;
  }
```

and the probe enumerates every writer of those arrays out of the shipped `dist/`:

```
    agent-session.js:1017  this._steeringMessages.push(text);
    agent-session.js:1033  this._followUpMessages.push(text);

  and every call to the two functions that do those pushes:
    agent-session.js:836   await this._queueFollowUp(expandedText, currentImages);
    agent-session.js:839   await this._queueSteer(expandedText, currentImages);
    agent-session.js:994   await this._queueSteer(expandedText, images);
    agent-session.js:1011  await this._queueFollowUp(expandedText, images);
```

`:836`/`:839` are inside `AgentSession.prompt()`'s streaming branch — a human
typing, or `sendUserMessage()`. `:994`/`:1011` are the public `steer(text)` /
`followUp(text)`. That is all of them.

`sendCustomMessage` — the only route `pi.sendMessage` has — goes straight past
them to the **Agent's** queues:

```js
  else if (this.isStreaming && options?.triggerTurn !== false) {      // :1081
      if (options?.deliverAs === "followUp") this.agent.followUp(appMessage);  // :1083
      else                                   this.agent.steer(appMessage);    // :1086
  }
```

So:

```
  a message is queued by…                          agent queue  hasPendingMessages()
  ----------------------------------------------------------------------------
  a human types while the agent is streaming       true         true
  a background subagent's result is delivered      true         false
  the loop queues its stuck directive (Z4's fix)   true         false
  the loop delivers a turn while the parent is busy true        false
```

**What it costs.** Nothing, in the unattended case — and that is the point worth
being precise about. With the answer always false the loop schedules its own turn,
which is exactly what an unattended run needs. What is wrong is the *belief*, and
the belief has been load-bearing twice:

- **V4** built the `queueOnly` branch for what its comment calls *"the ordinary
  state while a background subagent's result is queued"*. That delivery is
  `pi.sendMessage`, which cannot produce the state.
- **Z4** then found that the branch's chosen delivery mode (`deliverAs:
  "nextTurn"`) had no drain an unattended loop could reach, and repaired it. The
  repair is correct and worth keeping — but it repaired a branch reachable only
  when a human is typing.

Two passes' worth of reasoning about the unattended case was actually about the
attended one. Both probes and both tests stipulated the pending state rather than
producing it, which is the same shape as Z4 itself: `j4` asserted what
`pi.sendMessage` was called with; `m4` modelled the queues; neither asked what
could put something in them.

**The fix is the claim, not the code.** The branch stays: it is right when a human
is typing, and `triggerTurn: true` is its backstop when nothing else runs a turn.
What changed is that the call site now says what the question can see, in the one
place someone reasoning about the ladder will read it, with the citations to check
it against. Removing the branch would be worse — it would delete correct
attended-mode behaviour to tidy up a comment.

*Test:* the existing V4 describe in `tests/stuck-ladder.test.ts` already pins both
sides (`hasPendingMessages()` true → queued as a steer; false → the escalating
timer). `n3` is the evidence for which of them an unattended run takes.

---

### AA4 — the delivery mode that is never read · **LOW** · PROVEN·SOURCE · **FIXED**

**Where.** `SpawnCoordinator.emitIndividualNudge` in
`src/spawn/spawn-coordinator.ts`, against `agent-session.js:588`, `:592` and
`:1078`–`:1091`.

**What.** The coordinator chose the mode like this:

```js
  // - steer: queues while running, delivers before next LLM call
  // - followUp: waits for agent to finish, then delivers
  const parentIdle = ctx?.isIdle?.() ?? true;
  const deliverAs  = parentIdle ? "followUp" : "steer";
  pi.sendMessage({…}, { deliverAs, triggerTurn: true });
```

`isStreaming` and `isIdle` are the same bit:

```js
  get isStreaming() { return  this._isAgentRunActive; }   // :588
  get isIdle()      { return !this._isAgentRunActive; }   // :592
```

and `sendCustomMessage` reads `deliverAs` on exactly one branch:

```
  parent     deliverAs chosen   where it lands                          read?
  ----------------------------------------------------------------------------
  idle       followUp           _runAgentPrompt  (a whole new run)       NO
  busy       steer              agent.steeringQueue (INSIDE the turn)    yes
```

`parentIdle === true` is precisely the case that falls to `:1089`, where the value
is discarded. So the `followUp` arm existed only for the state in which pi does
not look at it, and the mode is always `steer`.

**The decision, and one correction to make first.** It would be neat to say that
choosing `followUp` retires the two-message turn W1, X1, X2 and X3 were each
written to repair. It does not, and the reason is worth pinning: **both queues
drain inside the same agent run and end in the same `agent_end`.**
`pi-agent-core`'s `runLoop` has an inner while that drains steering and an outer
while that drains follow-ups and feeds them back into the inner one — so a
follow-up produces another assistant message in the same run, exactly as a steer
does. All four of those findings stay load-bearing either way.

What the choice really controls is **where in the run the result lands**:

```
   steer     drained by the INNER while, injected before the next assistant
             response — i.e. possibly in the middle of a tool chain the parent
             is halfway through (read → edit → test).
   followUp  drained by the OUTER while, only once the model has stopped calling
             tools — i.e. at the natural end of what it was doing.
```

Put that way it is not close. A background subagent's result is by construction
not urgent: the parent chose not to block on it. Interrupting a tool sequence
with an unrelated answer costs a context switch to save at most one turn, and on
a one-slot llama server that turn is not a queue wait — the parent already owns
the slot either way. **`followUp`**, stated rather than computed, with the
routing and this argument written next to it.

*Tests:* `vendor/pi-subagents-lite/tests/background-delivery.test.ts`. Three
cases, one of which fails without the fix. The first pins the source —
`spawn-coordinator.ts` imports `../shell.js`, which imports pi, so the suite
cannot load it. The other two are controls that pin the pi facts the source pin
rests on: that `isIdle` and `isStreaming` are still the same bit, and that
`sendCustomMessage` still reads `deliverAs` only while streaming. If a future pi
separates them, the argument above stops holding and those two are where it
surfaces.

---

## 9. The notes, and what became of them

Every prior pass ended with a list of things it had decided not to do. Ten passes
of that is a backlog, and a backlog of "we looked at this and left it" is the
shape a defect hides in — X5 sat in one for four passes. So this pass emptied it:
each note was re-read, and each one either got a fix or got a reason that is
about the work rather than about the hour.

Nineteen got a fix. They are grouped by the question they were about.

### 9.1 Fixed — the same host call, two more callers

- **`pi.exec` never rejects, in the worktree validator too.** `GIT_NOT_FOUND` and
  `GIT_TIMEOUT` were produced by sniffing a REJECTION's message for `ENOENT` /
  `timed out`, so both constants were dead and all three failures — git absent,
  git wedged, a target genuinely outside a repo — were reported as
  `NOT_IN_GIT_REPO`, which is a claim about the operator's path when two of the
  three are claims about the host. The three shapes were **measured** against the
  real `execCommand` rather than assumed:

  ```
    git missing   { code: 1,   stdout: "", stderr: "",                killed: false }
    not a repo    { code: 128, stdout: "", stderr: "fatal: not a git repository…" }
    timed out     { code: 0,   stdout: "", stderr: "",                killed: TRUE  }
  ```

  `killed` is tested FIRST, because a signalled child exits with no code and
  `execCommand` does `code: code ?? 0` — a wedged git checked code-first reads as
  a SUCCESS returning "". Now in `src/spawn/git-failure.ts`, a module that imports
  nothing, with `classifyGitFailure` shared by both call sites.
  *Tests:* `git-failures.test.ts` ×7.

- **`execGit` in `agent-runner` is the control**, and it stays as it is: its catch
  is unreachable for the same reason, and harmless, because `code !== 0 → null`
  is already the answer it wants.

### 9.2 Fixed — the operator could not hear an unattended run

- **`ctx.ui.notify` is a no-op outside a TUI.** `noOpUIContext.notify` is
  `() => {}` (`runner.js:92`), and the loop called it 56 times. So in `pi -p`, in
  a cron run, in anything headless, the entire operator-facing narrative of an
  unattended loop was discarded silently — "Loop stuck (2x)", "goal check could
  not run (1/3)", "handing off to a fresh context", every pause. `ctx.hasUI` says
  so and nothing read it. All 56 sites now go through a `notify()` helper that
  writes the sentence to `.pi-loop-log.jsonl` when there is no UI, and changes
  nothing when there is.

### 9.3 Fixed — a ladder with no bottom, and a counter shared by two of them

- **The provider-error retry had no terminal state.** The context ladder escalates
  to `pauseForContextFailure` after `MAX_CONTEXT_COOLDOWNS`, the goal check to
  `pauseForCheckFailure` after `MAX_CHECK_ERRORS` — and a provider error retried
  forever with the backoff pinned at 300 s, so an unattended run against a dead
  llama-server looked alive in `/loop status` and had made no progress since the
  outage. Now `pauseForProviderFailure` at `MAX_PROVIDER_ERRORS`.

  **Ten, not three**, and the asymmetry is the point: the other two ladders
  escalate at three because their failures are structural — a context that will
  not fit, a check that will not run — and more attempts do not change the
  answer. A provider error is usually transient, and an unattended run should ride
  out a restarted server rather than give up on it. Against `backoffSeconds()`
  (5, 10, 20, 40, 80, 160, then 300 capped), ten consecutive failures is roughly
  half an hour of nothing working.

- **`consecutiveErrorCount` was shared** between context pressure and provider
  errors, so one context event lengthened the next provider backoff and one
  provider error advanced the context ladder toward its cooldown. Two mechanisms,
  two questions, two counters: `providerErrorStreak` is the new one, and
  `/loop resume` clears it — otherwise a resume after the pause re-pauses on the
  very first error, answering the operator's "I fixed the server" with the count
  that stopped it.

- **`penaltyTurnsRemaining` survived a stop and was not cleared by `resume`.**
  Now cleared there, for consistency with the line above it: `resume` already
  zeroes `consecutiveStuckCount`, so leaving up to `PENALTY_TURNS` of altered
  sampling armed applies a punishment for a streak that no longer exists.

### 9.4 Fixed — per-turn state that outlived its turn

- **`detectStuck`'s rule 6 was the one rule not gated on the current turn's
  text.** Rules 3, 4, 5 and 8 skip themselves when `committedText` is empty; rule
  6 counted the window's last fingerprint, which on a turn that committed nothing
  is the PREVIOUS turn's. So a pure tool-call turn could re-fire a verdict about a
  turn already charged for it — and charge the ladder again: a fresh streak
  increment, three more turns of sampling penalties, `turnsWithoutTools` reset.
  The HARD RESET directive asks the model for "a tool call with zero preamble
  text", which is exactly the shape that produces it, so the escalation could
  punish the model for doing what it had just been told to do. Now gated like its
  four neighbours.

- **`degenerateAbortPending` survived every `agent_end` exit above the branch that
  reads it.** It is set mid-stream by `message_update` and consumed near the
  bottom of the handler, so it could not go into `resetTurnBuffers()` — and every
  exit in between (a provider error, a context-pressure route) left it set, after
  which the operator's next Esc was read as a degenerate abort and answered with
  `interveneStuck` instead of a pause. Now read into a local at the drain and
  cleared there: T2's and X4's repair, applied to the one piece of per-turn state
  that could not use their fix directly.

- **`/loop finish` while idle** — the tenth lifecycle transition, and the second
  found missing from §2.8's table — now resets the turn buffers and the recovery
  markers like every other stop path.

### 9.5 Fixed — declarations that did not match the code

- **`hidden` kept `__verifier` out of the `Agent` tool's description and not out
  of the tool.** The `agent` parameter is a plain `Type.String()`, not an enum, so
  a parent model could spawn the verifier by name: one wasted call on the single
  llama slot, and a record labelled "verify" in `/agents` doing something that is
  not a verification. `executeAgentTool` now refuses a hidden type, while
  `resolveType` stays open for the internal callers — the judge reaches
  `__verifier` through `getAgentConfig`, the wizard through the coordinator.

- **`params.max_turns` and `params.model` were read** and the schema declares
  neither, with `additionalProperties: false`. Both reads were always undefined.
  Removed rather than declared: `max_turns` is the ceiling that stops an unbounded
  child stalling the one-slot machine, and it belongs to the agent's own `.md` or
  the operator's config, not to the caller that is about to be blocked on it.

- **`exclude_tools` / `exclude_extensions` are U6 one field over.** They went
  through `parseStringArray`, so `exclude_tools: none` became the one-element
  exclusion `["none"]` — a phantom tool nobody has — and `exclude_tools: all`
  became `["all"]`, which excludes nothing, i.e. the exact opposite of the word.
  `parseExcludeList` now reads the same four words `tools:`, `extensions:` and
  `skills:` accept, and `true` is representable end to end (`resolveVisibleTools`
  returns `[]`, `buildExtOverride` returns an empty allowlist).

- **`record.stats.turnCount` started at 1.** `onTurnEnd` writes the RUNNING total,
  so the initial value is only ever read before the first `turn_end`, where "1"
  claims a turn finished when none has — and a record that fails during setup
  settles with it. Now 0.

- **`--goal-file=X` was not accepted**, only `--goal-file X`; the `=` form fell
  through and became part of the GOAL text. V8's shape, one flag over.

- **`DEGENERATE_REPEATS` was declared in two files.** X5's argument rests on the
  sanitizer and rule 1 sharing *the* constant, not the same number twice. Now
  exported from `repetition.ts` and imported.

- **`getFinalModelError()` returned undefined for `stopReason: "error"` with an
  empty `errorMessage`** — which `classifyRun` reads as "no model error", so a run
  that died on the provider was classified `completed` and its empty text went to
  the parent and to the verifier as an answer, past the structural gate that
  exists to refuse exactly that. The stopReason is the fact and the text is
  decoration, so the fallback is now a stated sentence.

### 9.6 Fixed — a bound that stopped being a bound

- **`SlotTable.setLimits()` read `config.default` with no fallback.** A partial
  config leaves it undefined, `slotFor()` does `Math.max(1, undefined)` = NaN, and
  `running >= NaN` is false for every count — so an unreadable limit does not
  become large, it **stops existing**, and every spawn starts immediately on a
  one-slot server. An unreadable limit now keeps the one already in force.

- **…and the deletion loop tested truthiness.** `!config.models[key]` is also true
  for `0`, so a per-model limit of 0 — which `applyEntry` clamps to 1
  deliberately, because a zero limit would stall every spawn forever — was applied
  and then immediately deleted, dropping the entry back to the default. An
  operator writing `0` to mean "stop this model spawning" got the default instead,
  silently. It now tests key presence.

- **`AgentStatus` listed every agent ever spawned**, unbounded, in one line, into
  the parent's context. `AgentManager` never evicts a settled record — `/agents`
  needs them, and so does a continuation — so on a long session the tool's own
  result becomes the thing filling the window it exists to report on. The bound is
  "everything unfinished, plus the most recent six that are finished", with the
  elided count stated; a `running` or `queued` agent is never dropped, however
  many there are. `src/agents/status-listing.ts`, another module that imports
  nothing.

- **`buildVerifyDeps` read `SUBAGENT_VERIFY` at spawn time** while the other two
  switches were read at settlement — so of three switches over one feature, one
  was captured minutes earlier, and an operator turning verification off during a
  long delegation still got one. All three now read in `runVerification`.

### 9.7 Fixed — the two that had been "open by decision"

- **T5 — a verification was uninterruptible.** Verification runs inside the
  settlement chain, after the status has gone terminal, and every stop path keys
  off `status === "running"` — so the operator's Esc reached `stopAgent()`, which
  returned false, while a judge or a repair held the one llama slot and the
  parent's `Agent` call sat on the completion gate. A 300 s per-call deadline was
  the only exit.

  Closed: `runVerification` arms `record.execution.verifyAbort`, `stopAgent()`
  recognises a verifying record and aborts it, and `startDeadline` composes that
  signal with the timer so the call ends on whichever comes first. Aborting routes
  through `verifyAnswer`'s catch — already this layer's "the check did not happen"
  path — so the child's answer is preserved and annotated rather than lost.
  `/agents` now offers **"Stop the answer check"** on a verifying record, and
  still refuses Clear, because `removeRecord` disposes the session a repair runs
  in (Y1, unchanged). The deadline stays: nobody presses Esc in a cron job.

- **`prinny-channel` carried W1's shape, and it had wanted "a Matrix-side
  decision" for three passes.** `describeEmptyEnding` judges the LAST assistant
  message, so a turn that answered and then produced a trailing reasoning-only
  message read as `produced-no-answer` and the sender was told the model had said
  nothing.

  The decision was blocked on a real incident: on 2026-08-17 a 17,790-character
  tool result filled the window, the model returned `content: []`, and walking
  back past the empty tail delivered the PREVIOUS turn's mid-investigation
  deliberation to Matrix as the answer. Walking back is dangerous.

  Once the mechanism is named, the two cases separate cleanly. The trailing
  message exists because pi's agent loop runs another assistant message when
  something is injected mid-run, and `pi-subagents-lite` injects a finished
  background agent as `role: "custom"`, `customType: "subagent-result"`. So the
  walk steps over **exactly that pair** — an empty assistant message whose
  immediate predecessor is a `subagent-result` — and nothing else. A `user`
  message, which is the sender's own question or an operator steer that changed
  the subject, still stops it, and a `custom` message of any other type (a loop
  turn, a context-budget line) is not stepped over either. The incident's shape is
  untouched, and is a control in the test file.
  *Tests:* `forwarding.test.ts`, five new cases, two of which fail without the fix.

### 9.8 Corrected rather than fixed — a note this pass got wrong

- **`setActiveToolsByName` silently drops unknown tool names, and it does not
  matter.** §7.3 records the drop, and the note originally proposed warning about
  it. Re-reading the call site says otherwise: the only argument it is ever given
  comes from `resolveVisibleTools`, which builds its result by filtering
  `activeTools` — so every name is already in the registry and the drop is
  unreachable. `resolveVisibleTools` already warns about a DECLARED name that
  resolves to nothing, which is the reachable half. Left alone, with the reasoning
  written down, because "add a defensive warning that can never fire" is how a
  note becomes a permanent note.

### 9.9 Still open, and why — these are decisions, not omissions

Each of these has a fix. None of them has a fix that is mine to choose.

- **T6 — `worktree_path` is a filesystem grant, not a sandbox.**
  `validateWorktreePath` accepts any existing directory inside any git repo on the
  host, and the trust gate only decides whether the target's *project resources*
  load; an untrusted cross-repo target still spawns with a full tool set. The
  available tightenings — refuse without confirmation, or force a read-only child
  — would each break the feature's main use, which is working in another checkout
  on purpose. That is a product decision about what `worktree_path` is for. It
  stays open, stated precisely so the trust gate is not mistaken for containment.

- **Per-session loop state (the `WeakMap<ExtensionAPI, LoopState>` refactor).**
  The loop's `state`, `runToken`, `pendingTimer`, four turn buffers and five flags
  are module-global, which is why it must be inert in a child. This is a
  capability change, not a defect: the mitigation is three independent stops with
  ten tests on it, and nothing has been observed going wrong. Threading a context
  object through ~100 functions in a 2,600-line file at the end of a long session
  would put every other fix here at risk for no symptom. It is a session of its
  own, with its own audit.

- **T1's general case** — a steer into a run that is finishing manufactures a
  turn. Handled at both call sites that exist (`turn-tracking.ts` for the
  turn-limit steer, `compaction-anchor.ts` for the anchor); the general rule needs
  a pi-side affordance for "add context without asking a question", which does not
  exist.

- **The spawn bracket is a process-global counter — and it is fine.** Re-read this
  pass: `enterSubagentSpawn()`/`exitSubagentSpawn()` are a matched pair in a
  `try`/`finally`, so it cannot leak on a throw, and overlapping spawns nest
  correctly because it is a depth rather than a flag. The only way to observe the
  globalness is reloading the parent's extensions *during* a spawn, which is
  operator-driven and rare. Downgraded from a note to a verified fact.

- **`hasStateChange()` matches its keyword list against any tool output**, so a
  tool that prints the word "updated" advances `lastStateChangeIteration`. It is a
  heuristic feeding one advisory nudge at eight iterations without progress, and a
  better one needs a definition of progress this stack does not have.

- **A steer queued before the session exists grows the brief before it has gone.**
  The window is milliseconds and the alternative puts the write on a path with no
  error handling.

- **`/loop finish`, `saturatedManualCompaction` and the compaction rung's `try`**
  are fixed above; what remains of that group is `interveneStuck`'s general
  robustness, which is now bounded by the same `try` its sibling had.

### 9.10 Carried forward unchanged

- **`AgentSession.compact()` aborts the session before it does anything else**
  (`await this.abort()`), and holds `_compactionAbortController` for the duration,
  during which `prompt()` throws. The loop never meets that because it delivers
  turns through `sendCustomMessage`; an operator typing during the loop's
  compaction rung will. SOURCE.

- **`ctx.compact()` swallows a failure when no `onError` is passed** — the IIFE
  catches and calls `options?.onError?.(err)`, with no `emitError` fallback. Both
  loop call sites pass one, which is the control. SOURCE.

- **`ctx.getSystemPrompt()` returns `agent.state.systemPrompt`, not the base
  prompt**, so `systemPromptMode: "inherit"` would carry whatever the last
  `prompt()` left there. Not reachable: the default is `"replace"`, and after AA1
  nothing in this stack returns a systemPrompt at all. SOURCE.

- **Exit code 127 is left as a failing check** (AA2's fix). `killed` is
  unambiguous; a shell's "command not found" is usually a broken harness and
  sometimes a real failure, and misreading the second as the first pauses a run
  that should keep working. A control in `check-that-cannot-run.test.ts`.

- **Extension load order silently decides which text `detectStuck` rule 7
  fingerprints** — and the fingerprint no longer cares. `stripShorteningMarkers`
  removes a context layer's cap or truncation marker before hashing, so the rule
  asks about the tool's OUTPUT rather than about how the context layer chose to
  shorten it. That matters because `compaction-guard`'s marker names a spill file
  keyed by the **tool-call id**, unique per call, so an unstripped fingerprint
  could never match — on exactly the saturated contexts where the cap fires and
  the model is most likely to be stuck. The launcher's comment ("a different order
  costs a duplicate line, not a bug") is now true.

- **`compaction-guard` trims and notifies on compactions whose summary pi will not
  write.** It cannot see the loop's `{compaction}` result — `session_before_compact`
  is last-truthy-wins and not threaded — so the notice now says what was *done*
  ("capped the summary it would carry forward") rather than claiming an outcome it
  does not control.

- **`sanitizeDegenerateMessage` runs in two handlers, and only one matters.**
  Both correct, and the second pass really is a no-op now that Z3 made the
  sanitizer idempotent.

- **`branchEndsInCompaction` now skips the loop's own bookkeeping entries.** It
  tested the literal last entry, and the loop appends a `custom` state entry on
  ~33 paths — including `session_compact`'s own handler, which persists
  immediately after pi finishes compacting. So the branch stopped ending in a
  compaction the moment the loop recorded that one had happened, and the short
  circuit was lost on exactly the path it was written for. pi agrees with the new
  reading: a `custom` entry carries no message, so `prepareCompaction` finds
  nothing to summarize and returns undefined anyway.

- **A provider-error streak, `consecutiveErrorCount`, `AgentStatus`,
  `turnCount`, `SlotTable`, `exclude_tools`, `max_turns`, `__verifier`,
  `DEGENERATE_REPEATS`, `--goal-file=`, `penaltyTurnsRemaining`,
  `degenerateAbortPending`, rule 6, `/loop finish`, `getFinalModelError`,
  `saturatedManualCompaction`** — all fixed above; listed here so a reader of an
  older pass's note list can find where each one went.


## 10. What was re-verified this pass, and holds

Read out of pi's shipped `dist/` (0.84.2) and out of the tree, not assumed.

- **All forty-three prior fixes are in place**, and all forty-three prior probes
  run clean: `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`, `i1`–`i9`, `j1`–`j8`,
  `k1`–`k6`, `l1`–`l6`, `m1`–`m4`.
- **`Agent.continue()` drains BOTH queues, not just steering.** The ninth pass's
  §1 drawing shows only the steering branch. `agent.js:234`–`:252` drains
  steering first (`:243`), and if that is empty drains follow-ups (`:248`), and
  only then throws. So the
  loop's `deliverAs: "followUp"` from `agent_end` — the busy branch of
  `sendLoopTurn` — is delivered, which nothing had checked. Corrected in §1.B.
- **`_emit` calls subscribers synchronously** (`agent-session.js:298`). This is
  what `wireTurnTracking` and `g1`'s stub both rest on, and it is unchanged.
- **`setActiveToolsByName` preserves a child's own system prompt.** It rebuilds
  `_baseSystemPrompt`, and `_rebuildSystemPrompt` takes `customPrompt` from
  `this._resourceLoader.getSystemPrompt()` — which for a child is the
  `systemPromptOverride: () => systemPrompt` closure `createResourceLoader`
  installs. This was the one plausible way for the tool filter to throw the
  child's brief away, and it does not.
- **`session_before_compact` is last-truthy-wins and not threaded**
  (`runner.js:589` via the generic `emit()`), and the event is passed **by
  reference with no `structuredClone`** — which is what makes
  `compaction-guard`'s in-place mutation of `preparation.previousSummary` work,
  and what makes the loop's `{compaction}` survive the guard running after it.
  Both re-read this pass.
- **`buildHandoffCompaction` never reads `previousSummary`**, so the guard's trim
  cannot change the loop's handoff. Checked again.
- **`findHandoffCutEntryId` ignores the loop's own `custom` entries** — they are
  neither `isTurnStart` nor `standsAlone`, and `entryChars` returns 0 for them —
  so ~33 `persistState()` call sites cannot move a handoff's cut point.
- **pi never auto-compacts between the turns of a run** — two call sites, both
  outside the agent loop. Z2's foundation, unchanged.
- **`pendingMessageCount` counts steering + follow-ups only**, so `deliverAs:
  "steer"` from `agent_end` cannot make `hasPendingMessages()` true for a decision
  already taken this turn. Checked for Z4's fix, and now understood as the general
  case — AA3.
- **pi replaces `agent.state.messages` in THREE places, not two.** `:1435`
  (`compact`), `:1673` (`_runAutoCompaction`) and `:2451` (tree navigation). Z1's
  fix removed the index into that array entirely, so the third site is moot — but
  it is one more way an index into `session.messages` goes stale, and no document
  had listed it.
- **`agent_end`'s `messages` are `newMessages`** — everything this agent run
  produced — and not the session's history.
- **The loop is inert in a child**, by three independent stops, and
  `pi-subagents-lite` is inert in a child by its factory guard.
- **`verifyAnswer` still never throws**, its prologue is inside its own try, and
  `runVerification` catches anything the prologue could still raise.
- **The slot is still held across verification**, and `recount()` still keys on
  `holdsSlot`.

---

## 11. What shipped

Every fix carries a regression test that fails when the fix is removed; where a
case passes either way it is a control and is labelled as one.

### The four findings

| # | Fixed by | Where | Tests | Fail without it |
| --- | --- | --- | --- | --- |
| AA1 | `before_agent_start` returns a per-turn `message`, not a `systemPrompt` | `pi-loop-mode/extensions/index.ts` (+ `LOOP_RULES_MESSAGE_TYPE`) | `system-prompt-leak.test.ts` ×4, `subagent-isolation.test.ts` (updated) | 2 |
| AA2 | `execFailed` is set from `result.killed`, the field pi actually reports | `pi-loop-mode/extensions/index.ts` `runGoalCheck` (+ `src/goal-check.ts` docs) | `check-that-cannot-run.test.ts` ×6 | 3 |
| AA3 | the claim at the call site, with the citations to check it against | `pi-loop-mode/extensions/index.ts` `interveneStuck` | the existing V4 describe in `stuck-ladder.test.ts` | — (a claim) |
| AA4 | `followUp`, stated rather than computed — the injection point moves from mid-tool-chain to the end of the run | `pi-subagents-lite/src/spawn/spawn-coordinator.ts` | `background-delivery.test.ts` ×3 | 1 |

### The nineteen notes

| what | Where | Tests |
| --- | --- | --- |
| `pi.exec`'s other two callers: git-missing / git-timeout told apart from not-a-repo, measured against the real `execCommand` | `pi-subagents-lite/src/spawn/git-failure.ts` (new) | `git-failures.test.ts` ×7 |
| an unattended run's notices reach `.pi-loop-log.jsonl` when there is no UI | `pi-loop-mode/extensions/index.ts` `notify()`, 56 call sites | — (behavioural, headless) |
| the provider-error ladder gets its own counter and a terminal state at 10 | `extensions/index.ts`, `src/loop-state.ts` | `tenth-pass-notes.test.ts` ×4 |
| `detectStuck` rule 6 gated on the current turn's text, like its four neighbours | `extensions/index.ts` | `tenth-pass-notes.test.ts` ×2 |
| `degenerateAbortPending` read into a local at the drain (T2/X4's repair) | `extensions/index.ts` | covered by the ladder cases |
| `/loop finish` while idle resets the turn buffers and recovery markers | `extensions/index.ts` | — |
| `penaltyTurnsRemaining` and `providerErrorStreak` cleared by `/loop resume` | `extensions/index.ts` | `tenth-pass-notes.test.ts` ×1 |
| `--goal-file=X` accepted | `src/arguments.ts` | `tenth-pass-notes.test.ts` ×2 |
| `DEGENERATE_REPEATS` has one declaration | `src/repetition.ts`, `extensions/index.ts` | `tenth-pass-notes.test.ts` ×1 |
| a shortening marker is stripped before the tool fingerprint | `src/repetition.ts` `stripShorteningMarkers` | `tenth-pass-notes.test.ts` ×4 |
| `branchEndsInCompaction` skips the loop's own state entries | `src/context-recovery.ts` | `context-recovery.test.ts` ×2 |
| `saturatedManualCompaction` keys on `loopOwnsThisSession` | `extensions/index.ts` | — |
| the stuck ladder's compaction rung is wrapped, like its sibling | `extensions/index.ts` | — |
| `hidden` types are refused by the model-facing tool; the two undeclared param reads removed; `turnCount` starts at 0 | `src/agents/tool-execution.ts`, `agent-manager.ts` | `tool-surface.test.ts` ×5 |
| `exclude_tools` / `exclude_extensions` read the same four words as their twins | `src/agents/agent-discovery.ts`, `agent-types.ts`, `agent-runner.ts` | `exclude-lists.test.ts` ×8 |
| `SlotTable` limits cannot become NaN, and a limit of `0` is kept | `src/agents/concurrency-slots.ts` | `concurrency-slots.test.ts` ×5 |
| `AgentStatus` is bounded, and never elides live work | `src/agents/status-listing.ts` (new) | `status-listing.test.ts` ×7 |
| `getFinalModelError` reports an error with no message | `src/agents/agent-runner.ts` | — |
| `SUBAGENT_VERIFY` read at the same moment as its two siblings | `src/agents/agent-manager.ts` | — |

### The two that had been open by decision

| # | Fixed by | Where | Tests | Fail without it |
| --- | --- | --- | --- | --- |
| T5 | `record.execution.verifyAbort`, aborted by `stopAgent()` and composed into `startDeadline`; `/agents` offers "Stop the answer check" | `agent-manager.ts`, `types.ts`, `menu-running-agents.ts` | `tool-surface.test.ts` ×5, `record-activity.test.ts` (updated) | source-pinned |
| W1 (prinny) | the walk steps over an empty assistant message whose immediate predecessor is a `subagent-result`, and nothing else | `prinny-channel/src/forwarding.ts` | `forwarding.test.ts` ×5 | 2 |

### The gates

```
                                    before    after
vendor/pi-subagents-lite   tests    226       266     lint 84/84 files
vendor/pi-loop-mode        tests    156       180
vendor/prinny-channel      tests    296       301     lint clean
.pi/extensions/compaction-guard      39        39
                                   ─────     ─────
                                    717       786
```

All forty-seven probes run clean — `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`,
`i1`–`i9`, `j1`–`j8`, `k1`–`k6`, `l1`–`l6`, `m1`–`m4` and `n1`–`n4`.

Four source comments were corrected rather than added:

- `i3`'s header now says its `throws` mode drives a shape pi cannot produce, and
  points at `n2` for what pi really returns;
- `goal-check.ts`'s `applyCheckOutcome` docstring carried the sentence AA2
  disproves;
- `resetTurnBuffers`'s header said `degenerateAbortPending` could not be handled
  there, which was true of the reset and not of the read;
- `startDeadline`'s header said a verification is unstoppable, which T5 changed.

### Five new no-import modules

The count is the pattern, not the number. Every one of these exists because the
file it came from imports pi and therefore cannot be loaded by the suite, so the
rule inside it could not be tested at all:

```
   turn-tracking.ts        T1   the turn ceiling
   record-activity.ts      Y1   is this record still busy
   run-answer.ts           Z1   what a run said
   compaction-anchor.ts    Z2   does this compaction reach a turn
   git-failure.ts          AA2  which git failure is this          ← new
   status-listing.ts       —    which agents to print              ← new
```


## 12. Running the evidence

```sh
cd ~/instantcoffee

# the gates
( cd vendor/pi-subagents-lite && npm test && node tests/lint.mjs )   # 266 + 84/84
( cd vendor/pi-loop-mode       && npm test )                         # 180
( cd vendor/prinny-channel     && npm test && npm run lint )         # 301
( cd .pi/extensions/compaction-guard && npm test )                   #  39

# just this pass's regression tests
( cd vendor/pi-loop-mode && node --experimental-strip-types --test \
    tests/system-prompt-leak.test.ts tests/check-that-cannot-run.test.ts \
    tests/tenth-pass-notes.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/background-delivery.test.ts tests/git-failures.test.ts \
    tests/status-listing.test.ts tests/exclude-lists.test.ts \
    tests/tool-surface.test.ts )
( cd vendor/prinny-channel && node --experimental-strip-types --test \
    --test-timeout=90000 tests/forwarding.test.ts )

# this pass's probes
P=context/testing/probes
node --experimental-strip-types $P/n1-the-system-prompt-no-loop-turn-ever-sees.mjs
node --experimental-strip-types $P/n2-the-check-that-cannot-run-still-reads-as-failing.mjs
node --experimental-strip-types $P/n3-the-pending-messages-nobody-can-see.mjs
node --experimental-strip-types $P/n4-the-delivery-mode-that-is-never-read.mjs

# every probe, exit code only
for f in context/testing/probes/[a-z]*.mjs; do
  timeout 90 node --experimental-strip-types "$f" >/dev/null 2>&1 || echo "FAIL $f"
done
```

| probe | what it showed | the control |
| --- | --- | --- |
| `n1` | four loop turns whose system prompt never mentioned the loop, then the block pinned onto turn 1 of the next iteration and gone by turn 2 | the operator-typed turn, which is the one it was always reaching |
| `n2` | pi's real `execCommand` resolving on every failure, a timeout coming back `code: 0`, and `--until-done` completing on iteration 1 with `Check status: passing` | a check that really failed, and one that really passed |
| `n3` | four ways a message can be waiting and the one that answers `true` | the human-typed row |
| `n4` | the idle arm landing on the branch that discards the value, and the busy arm moving from the steering queue to the follow-up queue | the idle row, unchanged in both columns because pi discards the value there either way |

`n1` and `n2` drive the shipped loop extension — `n2` hands it pi's real
`execCommand` as `pi.exec`, which is the point. `n3` and `n4` read pi's `dist/`
and the tree, because the fact under test is pi's own routing and a stub of it
would be the thing being questioned.

---

## 13. Still unwatched

Everything above is fixed against probes and tests, and none of it against a
running model — which is now true of every fix in the last seven passes. That is
the one thing this pass did not change, and it is the biggest thing left.

1. **§M of `context/testing/subagents-loop-verifier.md`** — new, and the cheapest
   run on the list: one `/loop start` with a deliberately slow `--check`, and
   `/loop status`. Both HIGH findings are on that path. It needs no subagent and
   no verifier, and it now also exercises the provider ladder's terminal state if
   the server is stopped mid-run.
2. **A real verification**, foreground, `SUBAGENT_VERIFY_ROUNDS=1`, deliberately
   off-task brief — S2, U4, U8, V5, V7/W6, W5, Y1, Z1, and now T5: pressing Esc
   during the judge should end it and annotate the answer rather than doing
   nothing.
3. **The judge's raw reply is still not logged.** Top of the list since the fourth
   pass, untouched by this one, and load-bearing for S2, U4, V5 and W5.
4. **A child that compacts.** Z1 and Z2 are both on that path, and
   `record.stats.compactionCount ≥ 1` is the gate on whether the run counts.
5. **A delegation with a loop running.** Fixed at the module level eight times now
   — the loop's factory guard, V4, W1, X1, X2, Z4, AA1 and AA4 — and never
   watched. AA4 changed where the result lands, so this run now also answers
   whether a follow-up really does arrive at the end of the parent's tool chain
   rather than in the middle of it.
6. **A degenerate turn in the wild.** Rule 1 has never fired in a real session.
7. **`/loop prepare` followed by a delegation** — X3's path end to end.
8. **A Matrix exchange with a background subagent running** — prinny's W1 fix, and
   the only one of this pass's fixes whose failure mode is visible to somebody
   other than the operator.
9. **§J** (steering a RUNNING subagent, W3), **§K** (a verifying record in
   `/agents`, Y1 — now with a Stop button), **§L** (a child that compacts), none
   ever run; and **Section I**, still never run, now ten passes old.
10. **Still open by decision, and each with a reason in §9.9:** T6
    (`worktree_path` reach), per-session loop state, T1's general case,
    `hasStateChange`'s keyword list, and the brief-before-session window.


## 14. The pattern across ten audits

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
              with it                  and the value ends up somewhere nobody looked
   the rest of the contract   AA1–AA4  …and the other two surfaces of the same
                                       contract: which events reach us at all, and
                                       what a host function's answer is able to say
```

The ninth pass's lesson was **read the implementation of every host API the module
CALLS**. Carrying it out is what produced this pass, and the four findings are the
four ways that reading pays:

```
   AA1  an event with ONE emit site, and our own delivery path cannot reach it
          → a handler that has never run, and a value that never leaves
   AA2  a function that cannot fail the way we branch on, and reports a kill
        as a success
          → a whole escalation ladder that cannot fire, and a run that ends
            on a lie
   AA3  a question about a queue we are unable to put anything into
          → two passes of correct work about an unreachable state
   AA4  a parameter read on one branch out of four, and never the one we take
          → a choice that was never a choice
```

**And one habit that is not about reading at all.** This pass also emptied the
note list — ten passes of "we looked at this and left it", nineteen of which had
a fix that needed no decision from anyone. X5 sat in that list for four passes
before somebody asked it a question it could not answer. A backlog of deliberate
non-decisions is not neutral: it is the shape a defect hides in, because every
entry has already been read and dismissed once, which is the strongest reason not
to read it again. The two that had been "open by decision" for three passes each
(T5, and `prinny-channel`'s W1) both turned out to have a fix once the mechanism
underneath them was named — T5 needed an AbortController, and W1 needed to know
that the message it was tripping over has a `customType`. Neither needed the
decision they were waiting for.

Three habits fall out of the reading itself, and they are the transferable part.

**Count the emit sites before trusting a handler.** An extension API presents
every event as a fact about the world — "this fires when a turn is about to
start" — and pi's are not all like that. `before_agent_start` has one emit site
and it is on the operator's path; `session_before_compact` has two; `tool_result`
and `message_end` are per-object and unconditional. `grep -c` in the host's `dist/`
answers it in a second, and nothing else does: a handler that never fires is
indistinguishable, from inside the module, from one that fires and does nothing
useful. Both are silence.

**Ask what a host function's return value is ABLE to say before branching on it.**
`runGoalCheck` branched on a rejection from a function with no `reject` in its
body, and read `code === 0` from a call that reports a SIGTERM as zero. The check
is mechanical — read the function's happy path and its error path and list the
distinct values a caller can observe — and it is the one that catches a whole
class of "the fallback never runs" defects before they need a probe.

**A value the host writes for you is one the host must also take back.** AA1's
second half is `agent.state.systemPrompt`: pi writes it from a handler's return
value and clears only its own copy afterwards. Anything an extension hands a host
to *store* rather than to *use* needs the question "and who unsets it?" — and if
the answer is nobody, the right shape is usually the per-turn one the same API
already offers.

---

## 15. Where to look

- `context/testing/probes/n1`–`n4` — the reproductions, one per finding. `n1` and
  `n2` drive the shipped modules; `n3` and `n4` read pi's `dist/`, which is what
  the finding is about.
- The regression tests: `vendor/pi-loop-mode/tests/system-prompt-leak.test.ts`
  (AA1), `tests/check-that-cannot-run.test.ts` (AA2), the V4 describe in
  `tests/stuck-ladder.test.ts` (AA3),
  `vendor/pi-subagents-lite/tests/background-delivery.test.ts` (AA4), and for the
  notes: `tests/tenth-pass-notes.test.ts`, `tests/git-failures.test.ts`,
  `tests/status-listing.test.ts`, `tests/exclude-lists.test.ts`,
  `tests/tool-surface.test.ts` (which also pins T5), and the new describe in
  `vendor/prinny-channel/tests/forwarding.test.ts`.
- §7 of this document — the host-call ledger. It is the artefact the pass exists
  to leave behind, and §7.5 is the four-line checklist version of it.
- §5 — `compaction-guard`, documented for the first time.
- `context/design/subagents-loop-verifier-answers.md` — the ninth pass (Z1–Z4,
  all fixed), whose §1 delivery map this document's §1 extends with the two entry
  points and the system-prompt provenance, and whose §12 instruction this pass
  carried out.
- `…-turns.md` — the eighth (X1–X5, Y1); `…-readers.md` — the seventh (W1–W6);
  `…-shapes.md` — the sixth (V1–V8); `…-units.md` — the fifth (U1–U9), whose §9
  reference sections no later document restates; `…-surfaces.md` — the fourth
  (S1–S10); `…-mechanics.md` — the third (T1–T9), still the best account of pi's
  own agent loop; `…-evaluation.md` — the second (F1–F11); `…-anatomy.md` — the
  first, and the design rationale.
- `context/design/decisions.md` — decision history in date order.
- pi's own source, for this pass:
  `dist/core/agent-session.js:274`/`:286` (`_installAgentNextTurnRefresh`),
  `:556` (`dispose`), `:588`/`:592` (`isStreaming` / `isIdle`), `:631`
  (`setActiveToolsByName`), `:744` (`_runAgentPrompt`), `:753` (the finally),
  `:776` (`_handlePostAgentRun`), `:792` (`prompt`), `:805` (the compaction
  guard), `:836`/`:839`/`:994`/`:1011` (the four `_queue*` callers), `:865`/`:880`
  (compaction check and the nextTurn drain), `:885` (the ONLY
  `emitBeforeAgentStart`), `:902`/`:903`/`:907`/`:908` (the system-prompt write),
  `:1016`/`:1032` (`_queueSteer` / `_queueFollowUp`), `:1068`–`:1091`
  (`sendCustomMessage`), `:1151` (`pendingMessageCount`), `:1168` (`abort`),
  `:1367` (`compact`), `:1845`–`:1935` (`bindCore` — every `pi.*` and `ctx.*`
  implementation in one block);
  `dist/core/exec.js` (`execCommand` — no `reject`),
  `dist/utils/child-process.js` (`waitForChildProcess` — `code ?? 0`);
  `dist/core/extensions/loader.js:209`–`:290` (the `ExtensionAPI` surface),
  `dist/core/extensions/runner.js:92` (`noOpUIContext`), `:358` (`assertActive`),
  `:458`–`:535` (`createContext`), `:579`–`:891` (every `emit*`);
  `node_modules/@earendil-works/pi-agent-core/dist/agent.js:234` (`continue`, with
  the two drains at `:243`/`:248`), `:280` (`createContextSnapshot`), `agent-loop.js` (the inner while and
  `prepareNextTurn`).
- `patches/forge_reasoning_passthrough.py` and commit `e81a7e5` — the wire change
  V1, V2, W1, X1–X3 and Z1's reasoning-only tail are all downstream of.
