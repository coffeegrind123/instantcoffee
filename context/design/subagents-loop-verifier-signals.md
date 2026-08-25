# Subagents, the loop, and the verifier — the facts that expire, and the readers that arrive late

Eleventh pass, 2026-08-18. A full read of the whole stack — the three components,
the extension underneath them, and **the two packages the first ten passes never
opened**: `vendor/prinny-channel` and `vendor/rtk-pi`. §1 is the machine drawn
whole for the first time, with all five extensions on it. §7 is the host-call
ledger for the two new ones, which is the homework the tenth pass left. §8 is
four findings, all four fixed.

**832 tests across five packages, lint 85/85, and fifty-one probes.** The suite
was 802 and the probes 47; none of them caught any of these four.

```
   AB1  `result.killed` is pi's OWN kill and nothing else, so a goal check
        reaped by the OOM killer — or by any signal pi did not send — comes
        back exit code 0 and reads as a check that PASSED. The tenth pass
        fixed the timeout; this is every other way a process can die.
                                                                  HIGH · FIXED

   AB2  `pi.sendUserMessage` returns void, pi `.catch`es the rejection into
        `emitError`, and `emitError`'s listener set is empty outside a TUI.
        A Matrix message arriving while pi is compacting — or with the
        llama-server down — was dropped, and nobody, on either side, was
        ever told.                                              MEDIUM · FIXED

   AB3  rtk's load-time version probe reads `code` and never `killed`, so a
        WEDGED rtk passes the "is it there?" test, skips the version guard,
        and taxes every allow-listed command 2 seconds. AA2's shape, in the
        package nobody had read.                                   LOW · FIXED

   AB4  `addEventListener("abort")` on a signal that has ALREADY fired never
        runs. `forwardAbortSignal` had no `.aborted` test, so a stop landing
        during a child's build window did not stop it — and the tenth pass's
        T5 fix lost the same race during the judge's.           MEDIUM · FIXED
```

And one shape they share, which is §14 and the reason this pass is not the tenth
pass again:

```
   surface 1   what we RETURN from a handler          eighth pass    (X5)
   surface 2   what we PASS to a call                 ninth pass     (Z1–Z4)
   surface 3   which events REACH us at all           tenth pass     (AA1)
   surface 4   what a host function's answer CAN say  tenth pass     (AA2)
   ────────────────────────────────────────────────────────────────────────
   surface 5   WHEN it can say it, and how long the answer stays true
                                                      this pass  (AB1–AB4)
```

Every finding here is a fact that was true for an instant and a reader that
arrived after it. A child's death signal, discarded before the promise resolves.
A rejection, consumed before an extension could subscribe. A hang, flattened into
the same integer as success. An abort event, dispatched before its listener
existed. Surfaces 1–4 ask what the contract *says*; this one asks *when*.

---

## 0. How this sits next to the other ten documents

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
| ninth | `…-answers.md` (Z1–Z4) | between what a call looks like it does and what the host does with it |
| tenth | `…-hosts.md` (AA1–AA4) | between the contract's four surfaces, two of which had never been read |
| **eleventh** | **this** | **between a fact and the moment it stops being available** |

Two things make this pass different in kind from the tenth.

**It covers the whole stack for the first time.** Ten passes audited three
packages. `prinny-channel` was touched once, from the outside (W1's shape, fixed
in the tenth pass because a `subagent-result` message tripped it), and `rtk-pi`
had never been read at all. Both are now in §1's drawing, §6's event table and
§7's ledger. That is where AB2 and AB3 came from, and neither is exotic: one is
the only user-visible failure in the tree, and the other is the tenth pass's own
finding sitting untouched forty lines from a correct version of itself.

**Its findings are about time rather than shape.** The tenth pass's habit — read
the host's implementation for every call — is what found AA1 and AA2, and it is
what found these too. What it needed was one more question, asked of every value
the host hands back: *how long is this true, and who is watching when it becomes
true?* That question is mechanical, it is in §14, and it is the transferable part.

---

## 1. The whole machine

Everything in this document is a zoom into this drawing. It is the tenth pass's
§1 extended: the two entry points and the three nested units of a turn are
unchanged and still exact, and what is added is the two packages that were
missing, the event bus that joins all five, and the four places a fact expires.

```
 ┌──────────────┐   ┌─────────────────────────────┐   ┌────────────────────────┐
 │  llama.cpp   │──▶│ forge — OpenAI-compatible   │──▶│           pi           │
 │  ONE slot    │   │ proxy :8081                 │   │        0.84.2          │
 │  32k window  │   │ forge_reasoning_passthrough │   │  reasoning_content ──▶ │
 │  27B, Q4     │   │   emits reasoning_content   │   │   {type:"thinking"}    │
 └──────────────┘   │   beside content, and a     │   └──────────┬─────────────┘
        ▲           │   truthful finish_reason    │              │
        │           └─────────────────────────────┘              │
        │  EVERY box below queues here, one at a time            │
        └───────────────────────────────────────────────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  A.  THE TWO ENTRY POINTS — and only one of them is a "prompt"        [AA1]
 ══════════════════════════════════════════════════════════════════════════════

  ┌─ AgentSession.prompt(text, opts)                    agent-session.js:792 ──┐
  │   reached by:  a HUMAN typing · a subagent's own runner ·                  │
  │                pi.sendUserMessage()  ← prinny-channel's ONLY route         │
  │                                                                            │
  │   /command?           ─▶ _tryExecuteExtensionCommand ─▶ RETURN. no turn.   │
  │   compacting?         ─▶ THROW "Cannot submit a prompt while…"      :805   │
  │   streaming?          ─▶ streamingBehavior ?? THROW                 :830   │
  │                          followUp ─▶ _queueFollowUp  → _followUpMessages   │
  │                          steer    ─▶ _queueSteer     → _steeringMessages   │
  │                          ▲ THE ONLY TWO ARRAYS hasPendingMessages() SEES   │
  │   idle:                                                             [AA3]  │
  │       no model / no auth   ─▶ THROW                              :848/:855 │
  │       _checkCompaction(lastAssistant, false)                        :865   │
  │       messages = [ user(text), ..._pendingNextTurnMessages ]        :880   │
  │       ┏━ emitBeforeAgentStart(text, images, base, opts) ━━━━━━┓     :885   │
  │       ┃   result.messages   → appended as role:"custom"       ┃     :889   │
  │       ┃   result.systemPrompt !== undefined                   ┃            │
  │       ┃       _systemPromptOverride    = it                   ┃     :902   │
  │       ┃       agent.state.systemPrompt = it   ← nothing unsets┃     :903   │
  │       ┗━ THE ONLY EMIT SITE IN THE WHOLE OF pi ━━━━━━━━━━━━━━━┛            │
  │       _runAgentPrompt(messages)                                            │
  └────────────────────────────────────────────────────────────────────────────┘

  ┌─ AgentSession.sendCustomMessage(msg, options)             :1068 ──────────┐
  │   reached by:  pi.sendMessage() — the ONLY route an extension has         │
  │                pi-loop-mode (every loop turn) · pi-subagents-lite (a      │
  │                background result)                                         │
  │                                                                           │
  │   deliverAs "nextTurn"  ─▶ _pendingNextTurnMessages   drained ONLY  :1079 │
  │                             by prompt() above                    ← Z4     │
  │   isStreaming && triggerTurn !== false                             :1081  │
  │       "followUp" ─▶ agent.followUp(msg)   Agent's OWN queue         :1083 │
  │       else       ─▶ agent.steer(msg)      Agent's OWN queue         :1086 │
  │                     ▲ NEITHER is an array hasPendingMessages() sees [AA3] │
  │   triggerTurn (idle)   ─▶ await _runAgentPrompt(msg)                :1090 │
  │                             ▲ NO emitBeforeAgentStart            [AA1]    │
  │                             ▲ NO _checkCompaction                         │
  │                             ▲ deliverAs DISCARDED                [AA4]    │
  └───────────────────────────────────────────────────────────────────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  B.  WHAT A "TURN" IS — three nested units, and the loop names the middle one
 ══════════════════════════════════════════════════════════════════════════════

  _runAgentPrompt(messages)                                           :744
    _isAgentRunActive = true      ── isStreaming === !isIdle
    │
    ├── agent RUN #1   runAgentLoop              pi-agent-core/agent-loop.js:43
    │     agent_start · turn_start
    │     for (prompt of prompts) message_start / message_end   :52  ← markLive
    │     ┌── INNER while (hasMoreToolCalls || pendingMessages.length)
    │     │     drain steering → message_start / message_end each        :98
    │     │     streamAssistantResponse → message_update… message_end   :253
    │     │     executeToolCalls
    │     │       ┏━ beforeToolCall ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ :405
    │     │       ┃  emitToolCall(event)  — ONE emit site in all of pi ┃
    │     │       ┃  `event.input` IS the validated args, BY REFERENCE ┃
    │     │       ┃  handlers mutate it in place; only `block` is read ┃
    │     │       ┗━ prinny's permission relay, then rtk's rewrite ━━━━┛
    │     │       execute → afterToolCall → emitToolResult              :551
    │     │         ┗━ loop fingerprints RAW · guard caps · merged event
    │     │     turn_end
    │     │     ┏━ prepareNextTurn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  :286
    │     │     ┃ systemPrompt: _systemPromptOverride ?? _base       ┃
    │     │     ┃ turn 1 did NOT come through here — it read         ┃  [AA1]
    │     │     ┃ agent.state.systemPrompt via createContextSnapshot ┃
    │     │     ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
    │     └── pendingMessages = getSteeringMessages()
    │     OUTER while: getFollowUpMessages() → back into the inner loop
    │     agent_end { messages: newMessages }   ← THE LOOP'S "ITERATION"
    │
    ├── _handlePostAgentRun()                                          :756
    │     _prepareRetry? _checkCompaction(msg)? agent.hasQueuedMessages()?
    │       any true ─▶ agent.continue()                       agent.js:234
    │                     lastMessage.role === "assistant"
    │                       ├─ steeringQueue.drain() → runPromptMessages :243
    │                       ├─ followUpQueue.drain() → runPromptMessages :248
    │                       └─ else throw
    │                     else ─▶ runContinuation()
    │
    └── finally
          _systemPromptOverride = undefined  ← and NOTHING restores    :753
          agent.state.systemPrompt                             [AA1]
          _flushPendingBashMessages()
          _emitAgentSettled()
            _isAgentRunActive = false   ← BEFORE the handlers run       :328
            emit agent_settled          ← so ctx.isIdle() is TRUE here

  MESSAGE  one assistant reply.
  TURN     one message plus its tool results (pi's `turn_end`).
  RUN      agent_start … agent_end.  `pi-loop-mode` counts this as one iteration.
  PROMPT   one prompt()/sendCustomMessage — possibly several RUNs.

 ══════════════════════════════════════════════════════════════════════════════
  C.  THE FIVE EXTENSIONS, in load order, and what each one touches
 ══════════════════════════════════════════════════════════════════════════════

  scripts/pi-local.sh loads them in THIS order, and the order is load-bearing in
  three separate places:

   1. .pi/extensions/stack.ts          /stack · guards itself in a child   (U7)
   2. .pi/extensions/browser-guard.ts  rewrites a browser timeout
   3. vendor/pi-loop-mode              13 handlers · /loop · the loop tool
   4. .pi/extensions/compaction-guard   3 handlers · no tools · no commands
   5. vendor/pi-subagents-lite          4 handlers · Agent/StopAgent/AgentStatus
   6. vendor/prinny-channel             7 handlers · /prinny · the prinny tool
   7. vendor/rtk-pi                     1 handler  · no tools · no commands

  ┌───────────────┬───────────────┬───────────────┬───────────────┬───────────────┐
  │ pi-loop-mode  │ compaction-   │ pi-subagents- │ prinny-       │ rtk-pi        │
  │               │ guard         │ lite          │ channel       │               │
  ├───────────────┼───────────────┼───────────────┼───────────────┼───────────────┤
  │ 13 handlers   │ 3 handlers    │ 4 handlers    │ 7 handlers    │ 1 handler     │
  │ 3 per-turn    │ summary cap   │ slot table    │ Matrix ⇄ pi   │ bash rewrite  │
  │   buffers     │ tool-out cap  │ watchdog      │ via a         │ allow-list    │
  │ stuck ladder  │ ctx notice    │ verifier      │ sidecar       │ of 23         │
  │ context       │               │ widget        │ typing        │ commands      │
  │   ladder      │ mutates its   │ /agents       │ forwarding    │               │
  │ goal check    │ event IN      │               │ permission    │ mutates       │
  │               │ PLACE         │ deliverAs     │   relay       │ event.input   │
  │ sendMessage   │               │ sendMessage   │               │ IN PLACE      │
  │ → entry 2     │ no host calls │ → entry 2     │ sendUser-     │               │
  │               │ but ctx.*     │               │ Message       │ pi.exec ×2    │
  │ AA1 AA2 AA3   │               │ AA4 Y1 Z1 Z2  │ → entry 1     │               │
  │ X1–X5 Z3 Z4   │ §5, spill     │               │               │ §7.2, and     │
  │ ← AB1         │ bound ← §9    │ ← AB4         │ W1 ← AB2      │ ← AB3         │
  ├───────────────┼───────────────┼───────────────┼───────────────┼───────────────┤
  │ inert in a    │ INHERITED by  │ inert in a    │ DENIED to a   │ INHERITED by  │
  │ child, three  │ a child, and  │ child by its  │ child, by a   │ a child via   │
  │ ways over     │ wanted there  │ factory guard │ path regex    │ route B       │
  └───────────────┴───────────────┴───────────────┴───────────────┴───────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  D.  THE EVENT BUS — who handles what, and what each ordering decides
 ══════════════════════════════════════════════════════════════════════════════

   event                    loop   guard  subag  prinny  rtk   threaded?
   ─────────────────────────────────────────────────────────────────────────────
   session_start             ✓             ✓      ✓            ignored
   session_shutdown          ✓             ✓      ✓            ignored
   session_before_compact    ✓      ✓                          LAST TRUTHY WINS
   session_compact           ✓                                 ignored
   agent_start                                    ✓            ignored
   before_agent_start        ✓                                 threaded  [AA1]
   before_provider_request   ✓                                 threaded
   context                   ✓      ✓                          threaded
   turn_start                              ✓                   ignored
   message_start             ✓                                 ignored
   message_update            ✓                                 ignored
   message_end               ✓                    ✓            THREADED + written
   tool_call                               ✓      ✓       ✓    block-only; the
                                                                 EVENT IS MUTATED
   tool_result               ✓      ✓                          merged into ONE
   agent_end                 ✓                    ✓            ignored
   agent_settled             ✓                    ✓            ignored
   ─────────────────────────────────────────────────────────────────────────────

   CORRECTED in the sixteenth pass (AG4). Between the eleventh and the fifteenth
   this table drew `pi-subagents-lite` handling `agent_start`, `message_end` and
   `agent_end` — it registers none of the three — omitted `tool_call`, which it
   does (`src/events.ts:227`, `toolCallListener`, the row AD6 is about), and had
   no `turn_start` row at all. It registers exactly four handlers, all in
   `src/events.ts`, which is what the "4 handlers" line in the table above it
   always said. `context/testing/probes/t5-the-event-bus-the-map-draws.mjs`
   re-derives this table from the source and diffs it against any document given
   as an argument, so it cannot drift again.

   THREE orderings decide behaviour, and only one of them was written down:

   context        loop FIRST, appends `loop-context-budget`; the guard sees the
                  `-context-budget` suffix and stands down. Both sides check, so
                  either order works. Documented in pi-local.sh.       ✔

   tool_result    loop FIRST, fingerprints the RAW output into the stuck
                  window; the guard's cap runs after. Since the tenth pass
                  `stripShorteningMarkers` makes rule 7 order-independent, so
                  the launcher's "a different order costs a duplicate line,
                  not a bug" is now true.                              ✔

   tool_call      prinny FIRST, rtk SECOND — and this one is NOT symmetric.
                  prinny's permission relay shows a human
                  `describeCall(toolName, event.input)` and blocks with
                  `{block:true}`, which makes `emitToolCall` return
                  IMMEDIATELY. So with prinny first, the command a person
                  approves is the command the model wrote, and a blocked
                  command never reaches rtk at all. The other way round, the
                  relay would quote `rtk git status` for a model that asked
                  for `git status` — an approval for a command nobody typed.
                  UNDOCUMENTED until this pass.                        §9

 ══════════════════════════════════════════════════════════════════════════════
  E.  A DELEGATION, WITH EVERY EXPIRING FACT MARKED
 ══════════════════════════════════════════════════════════════════════════════

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │   module-global state, shared by every session in this PROCESS:          │
   │     pi-loop-mode   state:LoopState · runToken · pendingTimer · 3 buffers │
   │     pi-subagents   shell{pi,sessionCtx,manager,widget,store,coordinator} │
   │     prinny         child · awaitingReply · typingRooms · deliveryTimer   │
   │     rtk-pi         (none — the gate is pure)                             │
   │     compaction-gd  spillDir (a mkdtemp, first use)          ← bounded §9 │
   │     shell.ts       __PI_SUBAGENT_SPAWN_DEPTH__ on globalThis             │
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent(prompt, agent:"Explore")
   ┌──────────────▼────────┐    ┌─────────────────────────────────────────────┐
   │ SpawnCoordinator      │───▶│ AgentManager                                │
   │  live view · spawnCtx │    │  SlotTable(1) · queue · Watchdog 45min      │
   │  awaits the gate (fg) │    │  parent signal: `.aborted` checked ✔ :328   │
   │  nudges (bg)          │    │  stopAgent(running) = abortCtrl.abort()     │
   └───────────────────────┘    └────────────────┬────────────────────────────┘
                                                 │ runAgent()
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  THE BUILD WINDOW — seconds, and nothing was listening        [AB4]      ┃
   ┃    enterSubagentSpawn()   depth > 0                                      ┃
   ┃    reloadAndMap()         EVERY extension factory runs again —           ┃
   ┃                           and rtk's shells out to `rtk --version` [AB3]  ┃
   ┃    createAgentSession()   → onSessionCreated  (the capture, W6)          ┃
   ┃    bindExtensions()       child session_start                            ┃
   ┃    resolveVisibleTools → setActiveToolsByName → rebuilds the child's     ┃
   ┃                           system prompt from the loader's override       ┃
   ┃    exitSubagentSpawn()                                                   ┃
   ┃    ────────────────────────────────────────────────────────────────      ┃
   ┃    an abort raised ANYWHERE above used to be lost: forwardAbortSignal    ┃
   ┃    is only reached below, and addEventListener on an already-aborted     ┃
   ┃    signal never fires.  NOW: runTurnLoop refuses to prompt.       [AB4]  ┃
   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                                 ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, in-memory SessionManager         │
   │    own system prompt · own tools · own window · own event bus            │
   │    forwardAbortSignal(session, signal)  ← from HERE ON only       [AB4]  │
   │    session.prompt(prompt) ← so a CHILD does get before_agent_start       │
   │    ceiling maxTurns → wrap-up steer → hard abort graceTurns later        │
   │    runTurnLoop reads the RUN's answer, per message                ← Z1   │
   │    onCompaction steers the anchor only into a live run            ← Z2   │
   └──────────────────────────┬───────────────────────────────────────────────┘
                              │ settles — status TERMINAL, SLOT STILL HELD
                              ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                       │
   │    structural gate (free) → judge (fresh __verifier session, 1 turn)     │
   │    → repair (the child's own session, 1 turn) → judge again → …          │
   │    startDeadline composes verifyAbort with the timer — correctly   T5    │
   │    …and then hands the composed signal to runAgent, which until this     │
   │       pass could not see it if it had already fired             [AB4]    │
   └──────────────────────────┬───────────────────────────────────────────────┘
                              │ .finally: release slot, tally, drain, open gate
                              ▼
        foreground ─→ Agent tool result    background ─→ capBackgroundResult()
                                                      ─→ pi.sendMessage(
                                                           deliverAs:"followUp",
                                                           triggerTurn:true) AA4

 ══════════════════════════════════════════════════════════════════════════════
  F.  A MATRIX EXCHANGE — the only path with a second human on it
 ══════════════════════════════════════════════════════════════════════════════

    Matrix room                    sidecar (child proc, MCP over stdio)
        │  message                        │
        └────────────────────────────────▶│ notifications/claude/channel
                                          ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ prinny-channel                                                         │
   │   classifyMatrixCommand()   a leading "/" is decided HERE, not by the  │
   │                             model — refuse / run / plain text          │
   │   awaitingReply.set(room, {at, live:false, injected, question})        │
   │   armDeliverySweep()                                              AB2  │
   │   api.sendUserMessage(text, {deliverAs:"followUp"})                    │
   │        └─▶ AgentSession.prompt(…, {streamingBehavior})                 │
   │              busy → _queueFollowUp   (drains inside the SAME run)      │
   │              idle → a whole run                                        │
   │              THROWS → pi `.catch`es → emitError → NO LISTENERS   [AB2] │
   └────────────────────────────────────────────────────────────────────────┘
        │
        │ pi echoes the user message back
        ▼
   message_end{role:"user"} ─▶ markLive(text)  ── blockMatches on the Matrix
        │                       event id. THE ROOM IS NOW ANSWERABLE, and not
        │                       one moment sooner, or the turn already in
        │                       flight — the operator's own work — is forwarded
        │                       to whoever just messaged.
        ▼
   agent_start ─▶ agentRunning = true ─▶ typing indicator, refreshed every 8s
        │          because Matrix expires it at 20 and a 27B model thinks longer
        ▼
   message_end{assistant} ─▶ forward:"all" → each message as it finishes
   agent_end               ─▶ lastAssistantText · describeEmptyEnding      W1
   agent_settled           ─▶ stopTyping · forwardResult
                                 forward:"result" → the closing text
                                 empty ending → a bounded continuation, then
                                                a giveUpMessage
                                 retire live rooms · alreadySent.clear()
                                 sweepUndelivered()                     [AB2]
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, a Matrix answer and the parent's next call are five things in one
queue. Every finding in this pass costs a place in that queue, or a message that
never reaches it, or a stop that does not free it.

---

## 2. The loop (`vendor/pi-loop-mode`)

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool, 2,904 lines. Its whole job is deciding what a turn's outcome *was* and then
getting one sentence to the model about it.

### 2.1 The thirteen handlers, and which entry point each one sees

Unchanged from the tenth pass, and still the table to read first, because
`before_agent_start` is the one row that is not "every time the thing happens":

```
  handler                  fires on                       unattended run?
  ──────────────────────────────────────────────────────────────────────────
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
  ──────────────────────────────────────────────────────────────────────────
```

### 2.2 The goal check, in full, because AB1 is here

This is the mechanism the loop uses to decide that a run is over, and it is the
only one that consults something outside the model. In `--until-done` mode
`lastCheckPassed === true` is the **single** terminating condition, and V3 added
the `lastCheckPassed !== true` guard on `LOOP_DONE:` precisely so that "the check
decides" cannot degrade into "the model decides when the check is broken".

```
   agent_end, success path
     │
     └─ state.checkCommand?
          │
          ├─ runGoalCheck(pi)
          │    pi.exec("bash", ["-lc", wrapCheckCommand(cmd)],
          │            { timeout: checkTimeoutSeconds * 1000 })
          │      │
          │      │   pi's execCommand — no `reject` ANYWHERE in the body
          │      │   ────────────────────────────────────────────────────
          │      │   spawn error   → waitForChildProcess rejects → .catch
          │      │                   → resolve({ code: 1, killed })
          │      │   timeout       → killProcess() → SIGTERM → exit(null)
          │      │                   → resolve({ code: null ?? 0, killed:TRUE })
          │      │   any exit      → resolve({ code: code ?? 0, killed })
          │      │        ▲                              ▲
          │      │        │                              └─ a SIGNALLED child
          │      │        │                                 has NO code. This
          │      │        │                                 is where the death
          │      │        │                                 is discarded. [AB1]
          │      │        └─ set ONLY inside killProcess(), whose two callers
          │      │           are options.timeout and options.signal. It means
          │      │           "pi killed this", not "this was killed".   [AB1]
          │      ▼
          │    ┌─ result.killed              ─▶ execFailed  "did not finish
          │    │                                 within Ns and was killed"
          │    ├─ !readCheckCompletion(out).completed
          │    │                            ─▶ execFailed  "died before it
          │    │        ▲                        finished — killed by a signal"
          │    │        └─ THE FIX: the check runs under a bash EXIT trap, and
          │    │           the marker's ABSENCE is the evidence pi cannot give.
          │    └─ else  ─▶ passed = (result.code === 0), score from /SCORE: n/
          │
          ├─ applyCheckOutcome(state, outcome)
          │     execFailed → checkErrorStreak++ , lastCheckError,
          │                  and the check state is LEFT AT ITS LAST REAL VALUE
          │                  ("passing — LAST KNOWN", which is the honest read)
          │     else       → lastCheckPassed · checkFailStreak · score · best
          │
          ├─ execFailed && streak >= MAX_CHECK_ERRORS (3) ─▶ pauseForCheckFailure
          └─ untilDone && passed && !execFailed          ─▶ COMPLETED
```

The three sentences the mechanism can produce, and which is which:

| what happened | `killed` | marker | verdict | what the operator is told |
| --- | --- | --- | --- | --- |
| exited 0 | false | present | passed | `Check status: passing` |
| exited non-zero | false | present | failed | `failing (streak N)` + the output, given to the model |
| pi's timeout | **true** | present | could-not-run | `did not finish within Ns and was killed` |
| SIGKILL / OOM | false | **absent** | could-not-run | `died before it finished — killed by a signal` |
| SIGTERM from outside | false | present | *failed or passed* | **still not distinguishable — §9** |

The last row is the residue and it is stated rather than guarded: bash runs its
`EXIT` trap when SIGTERMed, so the marker is present and `$?` is whatever the last
command left. The marker is proof of *completion*, not of *intent*, and inventing
a rule for "the exit status after a signal" would be the same guess the tenth pass
declined to make about exit code 127.

### 2.3 `agent_end` — the ladder

Twenty-one `return;` statements and a fall-through. Every arrow leaving the column
is a `return`. Unchanged this pass except that the check branch now has a second
way to reach `execFailed`.

```
 agent_end(event, ctx)
   ├─ !state.active → (preparing? read GOAL_READY) ───────────────────────▶ ✗
   ├─ drain the three per-turn buffers into locals, then resetTurnBuffers()
   ├─ softStopRequested ──────────────────────────────────────────────────▶ ✗
   ├─ isContextPressure(...) ─────────────────────────────────────────────▶ ✗
   ├─ !lastAssistant || stopReason === "error" ─▶ providerErrorStreak++ ───▶ ✗
   │     …and at MAX_PROVIDER_ERRORS (10) ─▶ pauseForProviderFailure
   ├─ aborted && degenerateAbortThisTurn ─▶ interveneStuck ────────────────▶ ✗
   ├─ aborted ────────────────────────────────────────────────────────────▶ ✗
   │  ─── the success path ───
   ├─ every ladder counter reset · iterationCount++ · turnsWithoutTools
   ├─ committedText := commitTurnMemory(texts, calls, answers)
   ├─ rescueActive ─▶ switch back to the loop model ───────────────────────▶ ✗
   ├─ stuckReason := detectStuck(committedText, turnEmittedTexts)
   ├─ checkCommand → runGoalCheck → applyCheckOutcome              ← AB1
   │     ├─ execFailed × 3 ─▶ pauseForCheckFailure ────────────────────────▶ ✗
   │     └─ untilDone && passed && !execFailed ────────────────────────────▶ ✗
   ├─ /LOOP_DONE:/  (guarded by lastCheckPassed !== true)  ────────────────▶ ✗
   ├─ /LOOP_BLOCKED:/ ────────────────────────────────────────────────────▶ ✗
   ├─ maxIterations · scoreRegressed · stuckReason · the 8-iteration nudge ▶ ✗
   └─ normal continue: scheduleLoopTurn
```

### 2.4 `detectStuck` — eight rules

```
   #  rule                                    reads                    fixed by
   ──────────────────────────────────────────────────────────────────────────────
   1  detectDegenerateRepetition(t, 4)        EVERY message of the     [X2][X5]
      sentence / word / phrase                turn, ORIGINAL text      [Z3]
   2  turnsWithoutTools >= 3                  a counter                    T2 [X4]
   3  last two fingerprints equal             committedText            V2  [X1]
   4  last three fingerprints equal           committedText            V2  [X1]
   5  textSimilarity >= 0.80                  committedText, cut       V2 W2 [X1]
   6  same fingerprint >= 3 in the 8-window   the window, GATED on     V2  [X1]
                                              this turn's text          (10th)
   7  last three TURN tool signatures equal   recentToolResults,       U2, 10th
                                              markers stripped
   8  same question repeated (ends in "?")    committedText+snippets   V2  [X1]
   ──────────────────────────────────────────────────────────────────────────────
```

### 2.5 The escalation ladder and the context ladder

```
  interveneStuck(reason)
    consecutiveStuckCount++ · interventionCount++ · turnsWithoutTools := 0
    penaltyTurnsRemaining := 3   → before_provider_request rewrites the payload
                                   (frequency 0.5, presence 0.5, temp +0.2)
      ├─ rescue    !saturated && rescueModel && streak >= 3
      │            pi.setModel returns FALSE with no configured auth — checked
      ├─ compact   saturated || (streak >= 5 && >= 5 iterations since the last)
      │            ctx.compact({onComplete, onError})  ← both passed; with no
      │            onError a failed compaction is swallowed entirely
      └─ strategy  delay = min(60, 2 ** min(streak, 6)) seconds, rotating
                   STUCK_STRATEGIES[interventionCount % 5]

  context ladder
    1. TELL      the `context` handler, >= 60% advisory, >= 80% CRITICAL
    2. BOUND IN  compaction-guard's tool_result cap                  §5
    3. DETECT    agent_end → isContextPressure()
    4. RECOVER   deferred to agent_settled (pi's own overflow recovery wins the
                 race otherwise): 2 emergency compactions, then 3 cooldowns
                 (60/120/240 s), then pauseForContextFailure
    5. BOUND OUT compaction-guard's summary cap                      §5
```

The measurement the whole thing rests on: **below 87% of the window, 3 empty
assistant turns out of 196; at or above 87%, 33 out of 63.** A cliff, not a
gradient — and an empty turn still costs a full iteration.

---

## 3. Subagents (`vendor/pi-subagents-lite`)

64 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
`/agents` menu, a slot table, a watchdog, a spawn coordinator that owns delivery.

### 3.1 A record's life, with the stop paths marked

```
  spawn()          status queued|running · gate created · brief := prompt
    │              parent signal: `.aborted` tested FIRST, then a listener  ✔
    ▼
  startAgent()     slot reserved · watchdog started · started := true
    │              record.execution.abortController created
    ▼
  runAgent()       ┌─ THE BUILD WINDOW ───────────────────────────────┐
    │              │ reloadAndMap → createAgentSession →              │
    │              │ onSessionCreated → bindExtensions →              │
    │              │ setActiveToolsByName                             │
    │              │ stopAgent() here aborts a controller NOBODY is   │
    │              │ listening to yet.  AB4.                          │
    │              └──────────────────────────────────────────────────┘
    │              runSessionPrompt → wireTurnTracking + runTurnLoop
    │                forwardAbortSignal(session, signal)  ← listener attached
    │                if (signal.aborted) throw ABORTED_BEFORE_START   ← AB4 fix
    ▼
  .then            status ← classifyRun(result)   TERMINAL FROM HERE
    │              …unless it is already "stopped", which is preserved
    │              result := responseText                        ← Z1
    │              runVerification()   ← the record's SECOND run
    ▼
  .finally         settlementCount++ · outputLog finalised · slot released
                   tallyCompletion · drainQueue · gate opened · settled := true
```

The **completion gate** is the invariant worth knowing: every record carries a
promise from birth, opened exactly once, never assigned the run's own promise.
Seven paths open it, so a foreground `Agent` call can never hang on a record that
will not settle.

### 3.2 The turn ceiling, and what `stopAgent` can actually reach

```
   normalizeMaxTurns(n): 0 → unbounded · absent → 40 · else max(1, n)

   turn_end, turnCount++
        ├── maxTurns == null ─────────────────────────────▶ nothing, ever
        ├── !ceilingReached && turnCount >= maxTurns
        │      graceTurns <= 0 → abort   ·  > 0 → wrap-up steer      V6 W4 T1
        └── ceilingReached && turnCount >= maxTurns + graceTurns → abort

   stopAgent(record)
        verifying?  → verifyAbort.abort()        the T5 path
        queued?     → spliced out of the queue
        running?    → record.execution.abortController.abort()   ← and NOTHING
                      else. Which is why AB4 is a stop that does not stop.
        else        → false
```

### 3.3 What a child inherits, in full

```
   the PARENT is started with seven -e flags. A CHILD inherits NONE of them.

   ┌───────────────────────────────────────────────────────────────────────────┐
   │  the child's DefaultResourceLoader                                        │
   │   route A — DISCOVERY               route B — additionalExtensionPaths    │
   │   ~/.pi/agent/extensions/**         subagentExtraExtensionPaths():        │
   │   <cwd>/.pi/extensions/**             vendor/rtk-pi/extensions/index.ts   │
   │     compaction-guard  ✓ wanted        (or $SUBAGENT_EXTRA_EXTENSIONS)     │
   │     browser-guard     – harmless      suppressed when the agent declares  │
   │     stack           ✗ guards itself   `extensions: false`                 │
   │   ── withExtensionDenial() runs LAST over BOTH ──────────────────────     │
   │      any path segment matching (?:[a-z0-9._@-]*-)?prinny-channel/ is cut  │
   └───────────────────────────────────────────────────────────────────────────┘

   pi-loop-mode reaches a child by neither route, three times over:
     · not discovered (it lives in vendor/)
     · removed from route B, because its state is module-global
     · its factory returns early when __PI_SUBAGENT_SPAWN_DEPTH__ > 0

   rtk-pi DOES reach a child, deliberately — a child's bash output rents the
   same 32k window — and that is why its factory's `pi.exec("rtk","--version")`
   runs once per spawn, inside the build window AB4 is about.
```

---

## 4. The verifier

### 4.1 Three layers, cheapest first

```
   record settles ─▶ record.result = responseText          ← Z1 decides this
                        │
                        ▼
   ┌──── structuralVerdict(answer, lifecycle) ─────────────────────────────┐
   │  answer trims to ""       ─▶ ok:false          skipped-empty    ← Z1  │
   │  status "error"           ─▶ worthJudging:false skipped-error         │
   │  aborted/turn_limited/                                                │
   │    stopped                ─▶ worthJudging:false skipped-cutoff   W4   │
   │  brief missing            ─▶                    skipped-nobrief  W3   │
   └────────────────────────────┬──────────────────────────────────────────┘
                                │
   ┌──── the round loop, budget = SUBAGENT_VERIFY_ROUNDS (default 1) ──────┐
   │   phase "judging"   ← verifyPhase set HERE, cleared in the finally  Y1│
   │   judge(buildJudgePrompt(brief, candidate))  ← fresh __verifier       │
   │        │                                       session, 1 turn, 300 s │
   │        ▼   parseJudgeVerdict(reply)                                   │
   │        ├─ unparsed ──────────────▶ candidate + note(unparsed)     W5  │
   │        ├─ addressed, 0 attempts ─▶ candidate (bare)         passed    │
   │        ├─ addressed, n attempts ─▶ candidate + note(repaired,n)   W5  │
   │        └─ not addressed                                               │
   │              ├─ attempts >= rounds ▶ ORIGINAL + note(failed,n)        │
   │              └─ phase "repairing" ▶ repair in the CHILD's session     │
   │                    ├─ structuralVerdict(repaired)                 V5  │
   │                    ├─ == candidate ▶ ORIGINAL + note(stalled)     W5  │
   │                    └─ candidate := repaired ─▶ round again            │
   └───────────────────────────────────────────────────────────────────────┘
```

### 4.2 The two asymmetries, and both are the design

- **The judge knows less on purpose.** A model shown its own reasoning ratifies
  it, so the judge sees two quoted blocks and a question. Tools, extensions,
  skills, project context, the parent's system prompt and the environment block
  are all off. Its whole system prompt is 463 chars.
- **The repair knows more on purpose.** It continues the child's own session,
  because that is the only place with the context to fix the answer.

### 4.3 The deadline, T5, and where AB4 lands on it

Verification runs inside the settlement chain, *after* the status has gone
terminal, and every stop path used to key off `status === "running"`. The tenth
pass closed that (T5): `runVerification` arms `record.execution.verifyAbort`,
`stopAgent()` recognises a verifying record and aborts it *before* the
`status === "running"` test, and `startDeadline` composes that signal with its
timer so the call ends on whichever comes first.

`startDeadline` gets the composition right — `if (stopSignal.aborted)
controller.abort()` is there, and it is the reason AB4 is narrow rather than
general. What it then does is hand the composed signal to `runAgent`, and until
this pass `runAgent` could not see a signal that had already fired. So:

```
   Esc during the JUDGE'S MODEL CALL       → forwardAbortSignal's listener is
                                             attached, fires, session.abort(),
                                             prompt() resolves, assertNotExpired
                                             throws.                    ✔ T5
   Esc during the JUDGE'S BUILD WINDOW     → deliberately composed, correctly
                                             composed, and then dropped —
                                             one full model call on the single
                                             llama slot before it took effect.
                                                                     ✘ AB4
```

---

## 5. `compaction-guard`

Three handlers, no tools, no commands. Every one of them only ever ADDS a bounded
line or SHRINKS a string pi was about to send, and each swallows its own errors.

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  1. session_before_compact ── bound the ACCUMULATOR                          │
 │     preparation.previousSummary, MUTATED IN PLACE, returns undefined         │
 │       cap = 5% of the window × 4 chars/token, clamped [2k, 20k]              │
 │       section-aware, dropped by SECTION_PRIORITY, reassembled in order       │
 │     Why: pi's own update prompt says "PRESERVE all existing information",    │
 │     so the summary is monotonic by construction. Measured over 42 real       │
 │     compaction points: 456 / 4,029 / 11,054 chars, only ever up.             │
 │                                                                              │
 │  2. tool_result ────────── bound what ARRIVES                                │
 │     allowance = 10% of the REMAINING window × 4, clamped [1.5k, 20k]         │
 │     head 70% / tail 30%, cut at a line boundary when one is close            │
 │     overflow → mkdtemp()/pi-tool-output-*/<tool>-<callId>.txt                │
 │     …and since this pass, the directory is BOUNDED at 50 files, oldest       │
 │     first, pruned after each write so the newest can never be the one        │
 │     removed. A count rather than a teardown, because `spillDir` is           │
 │     module-global and a CHILD shares it.                              §9     │
 │                                                                              │
 │  3. context ───────────── tell the MODEL                                     │
 │     >= 60% advisory, >= 80% CRITICAL, customType                             │
 │     "compaction-guard-context-budget"; stands down when any message already  │
 │     carries a customType matching /-context-budget$/                         │
 └──────────────────────────────────────────────────────────────────────────────┘
```

The incident the cap exists for, reconstructed from a real session on 2026-08-17:
a CRITICAL notice was in context at 84.5% saying "do not run commands with large
output this turn"; the model ran a 3-URL curl loop; the 17,790-character result
took the window to 100% and the run to an empty turn. **A soft instruction does
not bind, and the model could not have complied in good faith anyway** — nobody
knows how many bytes a pipeline will print until it has printed them.

---

## 6. `prinny-channel` — the first full account

Seven handlers, one command with seventeen subcommands, one tool with six
actions, and a child process. It is the only part of this stack whose failures
are visible to somebody who is not the operator, and until this pass no audit had
read it from the inside. AB2 is here.

### 6.1 The shape, and why the sidecar is a process

```
   Matrix  ⇄  sidecar (child process, MCP over stdio)  ⇄  this extension  ⇄  pi
```

`@prinny/bot` pulls in matrix-js-sdk and its Rust crypto WASM: loading it is ~15
seconds of **synchronous** work, which in-process would freeze pi's TUI solid, and
the same library writes to stdout while it loads, which in-process would scribble
over the interface pi is drawing. Out of process, both are the child's problem —
its stdout is a pipe carrying JSON-RPC and its stderr goes to a log file. It also
keeps ~105 MB of `node_modules` out of the repository: the sidecar stages and
compiles its own runtime under `~/.pi/agent/channels/prinny`, which is why
`/prinny prepare` takes about a minute and why the connect timeout is 30 s on a
9p mount.

### 6.2 The seven handlers

```
  handler          what it does                                          why there
  ─────────────────────────────────────────────────────────────────────────────────
  session_start    uiCtx := ctx · readSettings() · void startChannel()    a session
                   idempotent: `if (child?.running) return`               must not
                                                                          wait on a
                                                                          homeserver
  session_shutdown await stopChannel()                                    one bot
  agent_start      uiCtx := ctx · agentRunning := true · refreshTyping()  typing up
  message_end      role "user"  → markLive(text)          ← the safety property
                   role assistant, forward:"all" → forwardToMatrix        progress
  agent_end        lastAssistantText := finalAssistantText(messages)
                   lastRunEmptyEnding := describeEmptyEnding(…)      ← W1's shape
  agent_settled    agentRunning := false · stopTyping() · forwardResult() the answer
  tool_call        the permission relay; `{block:true}` when refused      off by
                                                                          default
  ─────────────────────────────────────────────────────────────────────────────────
```

Two of those choices are load-bearing and both were paid for:

**`agent_settled`, not `agent_end`, for the answer.** Settled is the point at
which no retry, compaction or queued continuation is still to come, so the text in
hand is the run's actual answer rather than an intermediate one a retry is about
to replace.

**`message_end` with `role: "user"` is what makes a room answerable.** Not
arrival. A Matrix message can land while pi is mid-turn on something the operator
asked for in the terminal; it is queued, correctly, as a follow-up — but the room
went into `awaitingReply` the moment it arrived, so the *current* turn's answer,
about the operator's private local work, would be forwarded to whoever just
messaged, and nobody would see that happen from this side. So eligibility is tied
to evidence: the room goes live when its own block comes back as a user message,
which is pi saying it has consumed it, matched on the Matrix event id.

That evidence is what AB2 reads backwards.

### 6.3 Forwarding, and the four ways it declines

```
   forwardToMatrix(text, why)
     ├─ text trims to ""              ─▶ nothing
     ├─ no LIVE room                  ─▶ nothing
     ├─ more than one live room       ─▶ nothing, and say so in the log
     │      ▲ with two, there is no way to tell whose answer this is, and
     │        guessing would send one person's conversation to another —
     │        worse than silence, and not undoable
     ├─ alreadySent.has(room, text)   ─▶ nothing (forward:"all" then "result")
     └─ the channel is not running    ─▶ nothing
     else  child.callTool('reply', { room_id, text, reply_to? })
             quote-reply only on the FIRST thing sent, because five replies all
             quoting the same question reads as a malfunction in most clients

   forwardResult()  at agent_settled
     ├─ forward:"result" → forwardToMatrix(lastAssistantText)
     ├─ lastRunEmptyEnding.empty
     │     ├─ shouldRetryEmptyTurn → ONE bounded continuation:
     │     │     api.sendUserMessage(nudgeForEmptyEnding(reason, question),
     │     │                         { deliverAs: "followUp" })
     │     │     ▲ at agent_settled `_isAgentRunActive` is ALREADY false
     │     │       (agent-session.js:328 sets it before emitting), so this is
     │     │       the IDLE branch and `deliverAs` is not read at all — it
     │     │       starts a whole new run. The comment is right about the
     │     │       outcome and the mechanism is a different one.        §9
     │     └─ else giveUpMessage(detail) to every waiting room
     ├─ unanswered && forward:"off" → tell the operator
     ├─ retire every LIVE room (never a queued one — its answer is still coming)
     └─ sweepUndelivered()                                            ← AB2
```

`describeEmptyEnding` is W1's shape and the tenth pass's last fix: it judges the
LAST assistant message, so a turn that answered and then produced a trailing
reasoning-only message read as `produced-no-answer`. The walk now steps over
exactly one pair — an empty assistant message whose immediate predecessor is a
`subagent-result` custom message, which is what `pi-subagents-lite` injects — and
nothing else. A `user` message still stops it, and so does a `custom` message of
any other type. The incident that made it a decision (a 17,790-char tool result
filled the window, the model returned `content: []`, and walking back delivered
the previous turn's mid-investigation deliberation to Matrix as the answer) is a
control in the test file.

### 6.4 The typing indicator, which is a whole mechanism

Matrix expires a typing indicator on its own timeout — 20 seconds by default —
and a local 27B model routinely thinks for longer than that, so the indicator
lapsed mid-thought and the sender saw a bot that had gone quiet, which is
precisely the moment the signal exists for. It is therefore refreshed every 8 s
from an unref'd interval, driven by the turn lifecycle rather than by the model,
and reconciled rather than toggled: `roomsAwaitingAnswer()` is `agentRunning &&
entry.live`, and `planTyping` diffs that against the rooms currently told. So a
room answered mid-turn stops while others carry on, and a stuck indicator cannot
outlive the state that justified it.

`entry.live` is in there for the same reason it is in `forwardToMatrix`: without
it, a turn the operator started in the terminal would show somebody on Matrix
that the bot is busy with something of theirs, which is both untrue and a small
leak of when the operator is at the keyboard.

### 6.5 The command surface, and why it is a command

`/prinny` has seventeen subcommands (`status help start stop restart prepare log
pair deny allow remove policy room set forward permissions configure`) and the
tool has six actions (`reply react edit download history search`) behind one
`action` string.

Both shapes are deliberate and both are measurements. Six separate `prinny_*`
tools cost 4,574 chars (~1,144 tokens) of schema on **every turn**, which a
channel most turns never touch cannot justify; folding them behind one action
string spends ~200. And access management was a skill telling the model to
hand-edit JSON — it is a command now, because a mis-edited allowlist is a
security failure and a 27B model should not be the thing standing between a
public Matrix ID and a shell.

The same reasoning runs through `classifyMatrixCommand`: a leading `/` in an
inbound Matrix message is decided by the extension, not by the model, and
`sendUserMessage` is called with `expandPromptTemplates: false` for ordinary text
so a command has never executed from Matrix — it arrives as literal text. The
`run` branch, which passes `true`, is the one call in the file that turns Matrix
input into harness control, and it is restricted to a named list.

### 6.6 The permission relay

Off by default (`permissionMode: 'off'`), because a gate the operator forgets they
enabled looks exactly like a hung agent. When on:

```
   mode "all"        MUTATING_TOOLS = {bash, edit, write}
   mode "dangerous"  14 named patterns, each with what it is guarding:
                     rm -rf · sudo/doas · curl|sh · dd of=/dev/ ·
                     mkfs · git push --force · git reset --hard · npm publish ·
                     shutdown · chmod 777 · docker system prune · kubectl delete ·
                     history -c / shred · > /dev/sd*
   permissionTools   an explicitly named tool is gated even when the mode is off,
                     because naming a tool is a more specific instruction than
                     choosing a mode
```

It **fails closed**: channel down, not logged in, notify threw, or nobody answered
in 300 s all return `{approved:false}`. Enabling the gate is an explicit statement
that these calls should not happen unwatched, and "the approver was unreachable"
is not the same as "the approver said yes". `requestApproval` cannot throw — every
path returns a decision — which matters because `emitToolCall` has **no try/catch
around handlers** and pi rethrows a handler's error as "Extension failed, blocking
execution".

---

## 7. `rtk-pi` — the first account of any kind

108 lines of coupling, 146 lines of gate, one handler, no tools, no commands. Ten
passes had never opened it. AB3 is here, and it is AA2's shape forty lines from a
correct version of itself.

### 7.1 What it is for

`CTX_SIZE=32768`. Bash output is not billed on this stack, it is **rented** —
every byte of `pytest` chatter is a byte that is not the file the model was asked
to read. `rtk` is a filter that rewrites a command into a shorter-output
equivalent, and the fork's entire content is a refusal to trust it by default.

```
  measured in this repo, 2026-08-16, against rtk 0.45.0
  ────────────────────────────────────────────────────────────────────
  git status              275 B →   49 B    82%   ALLOWED
  pytest -q (43 tests)  1,312 B →  476 B    64%   ALLOWED
  find vendor -name…    1,718 B →  773 B    55%   ALLOWED
  git diff HEAD~1       2,384 B → 2,213 B    7%   ALLOWED (verified faithful)
  git log --oneline     1,570 B → 1,570 B    0%   ALLOWED (harmless)
  ls -la                1,125 B →  348 B    69%   denied — see below
  ls -1                   123 B →  242 B   -97%   denied — it grows
  grep -rn …            3,286 B → 3,286 B    0%   denied — nothing to bank
  cat README.md        67,652 B → 67,652 B   0%   denied — on principle
  ────────────────────────────────────────────────────────────────────
```

`cat` is the one entry denied on principle rather than arithmetic: `rtk read` is
byte-for-byte `cat` at every size tried up to 180 KB, so denying it costs nothing
today — but the README advertises "signatures and structure over full bodies", so
the current losslessness is undocumented and could turn off in a point release.
**This stack's known failure mode is an edit whose `old_string` does not match the
file, and a summarised read is precisely how that starts.**

### 7.2 The gate, in four refusals

```
   shouldFilter(cmd)                                       src/gate.ts
     trimmed := cmd.trim().replace(/[ \t]+/g, " ")   ← for the DECISION only;
                                                       the original is what runs
     ├─ ""                     ─▶ false
     ├─ starts with "rtk "     ─▶ false
     ├─ COMPOUND  /[|<>;&`\n]|\$\(/                 ─▶ false
     │     rtk declines most of these itself, but accepted `git status && git
     │     log` and `echo hi; git status`. A pipe or a redirect means the output
     │     is going to a parser or a file, where being shorter is being WRONG.
     ├─ PREFIXED  ^(VAR=|sudo|env|time|timeout|nohup|xargs|nice|uv|npx|pnpm|
     │            yarn|poetry|pdm|hatch|bundle|rye)\b   ─▶ false
     │     rtk strips these before matching its own rules, so the thing that
     │     gets rewritten is not the thing that was measured. `uv run pytest`
     │     becomes `uv run rtk pytest`, which resolves a different pytest than
     │     the venv's.
     └─ isAllowed(trimmed)  — a token-boundary prefix match against 23 entries,
                              so "git status" covers "git status -s" and never
                              "git stash"

   extractRewrite(stdout)
     the LAST non-empty line, and it must start with "rtk " and contain no
     COMPOUND character. Defence in depth, not a fix: on 0.45.0 rtk's advisories
     go to stderr (verified with the streams separated and the rate-limit stamp
     cleared — an earlier reading that said "stdout" was an artefact of probing
     with 2>&1). It is kept because the cost is a string comparison and the thing
     it guards is handed to a shell.
```

The two rewrites that made the fork invert upstream's default:

| rewrite | what happens |
| --- | --- |
| `npm run lint` → `rtk lint` | the `npm run` indirection is discarded — whatever the package's lint script actually runs, flags and all, is replaced by a bare eslint |
| `uv run pytest` → `uv run rtk pytest` | resolves a different pytest than the venv's |

Both are invisible from inside a session: the command runs, exits, and reports
something. A 27B model at `REASONING_EFFORT=medium` cannot smell that.

### 7.3 The handler, and how it changes a command

```
   pi.on("tool_call", async (event, ctx) => {
     try {
       isToolCallEventType("bash", event)?          else return
       RTK_DISABLED=1?                              else return
       shouldFilter(cmd)?                           else return
       rewritten := await rewriteCommand(pi, cmd, ctx.signal)
       if (rewritten && rewritten !== cmd) event.input.command = rewritten
     } catch { console.warn(…); return }    ← FAIL OPEN, ALWAYS
   })
```

**Mutation in place is the sanctioned mechanism, not a trick.** pi's own type
says so — `ToolCallEventResult` is documented as *"Block tool execution. To modify
arguments, mutate `event.input` in place instead."* — and the chain holds:
`beforeToolCall({toolCall, args: validatedArgs})` passes `args` into
`emitToolCall` as `event.input` **by reference**, `emitToolCall` passes the event
to each handler with no clone, and `prepareToolCall` then returns
`{kind:"prepared", args: validatedArgs}` — the same object. Arguments are
validated *before* the hook, so a rewrite is never re-validated; for a string
`command` that is fine and it is worth knowing.

`ctx.signal` is `this.agent.signal` (`agent-session.js:1898`), so an operator's
Esc kills the `rtk rewrite` subprocess. That is the correct use, and it is also
the second place in this file that reads `killed` — `rewriteCommand` tests
`result.killed` before `result.code`, and is right. The load-time probe forty
lines below did not, and that is AB3.

---

## 8. The host-call ledger for the two remaining packages

This is the homework the tenth pass left: it read all thirty-one host calls made
by `pi-loop-mode`, `pi-subagents-lite` and `compaction-guard`, and said the sweep
had not been run for `prinny-channel` or `rtk-pi`. It has now.

Legend: ✔ the call site's belief survives reading pi · ⚠ true, with a consequence
nobody had written down · ✘ a finding.

### 8.1 `prinny-channel` — eleven distinct calls

```
 call                     pi implementation                    where it ends up
 ══════════════════════════════════════════════════════════════════════════════
 pi.sendUserMessage(t,o)  loader.js:267 → runtime.sendUserMessage
                          → agent-session.js:1855 → :1107 → prompt()
   ✘ Returns **void**, and pi's binding is
     `this.sendUserMessage(...).catch(err => runner.emitError(...))`. Every
     ASYNCHRONOUS failure is consumed by pi and turned into an extension error;
     `emitError` walks `runner.errorListeners`, whose one possible member is
     registered at `agent-session.js:1809` **only when a UI bound one**, and
     there is no error member of `ExtensionEvent` for an extension to subscribe
     to. So the `try`/`catch` at the call site can see exactly one thing: a
     synchronous `runtime.assertActive()` throw.
     `prompt()` throws for: a compaction in progress (:808), no model (:848),
     no provider auth (:859, inside the same try), and streaming with no
     `streamingBehavior` (:833). The first is reachable whenever `/loop` runs
     its compaction rung; the third is "llama-server is down".      AB2
   ✔ `deliverAs` becomes `streamingBehavior`, which is read only on the
     streaming branch. Idle is a whole run, which is what is wanted.
   ✔ `expandPromptTemplates` really is in the ExtensionAPI type; the
     `as Parameters<…>[1]` cast that used to be here asserted a type onto
     itself and could only have hidden a signature change.               §9

 pi.registerTool(t)       loader.js:215                        extension.tools
   ⚠ calls runtime.refreshTools() → setActiveToolsByName → _rebuildSystemPrompt.
     Harmless: registration is at factory time, before the first prompt.

 pi.registerCommand       loader.js:223                     extension.commands
   ✔ `prompt()` dispatches these at :800 and RETURNS — before the compaction
     guard, before `before_agent_start`, before any turn. Which is why a
     `/prinny` subcommand can run while the loop is mid-iteration.

 pi.registerEntryRenderer loader.js:…                extension.entryRenderers
   ✔ keyed by customType; renders in the transcript only.

 pi.appendEntry(t, data)  agent-session.js:1864
   ✔ `appendCustomEntry` → a `{type:"custom"}` entry, appended as a child of the
     leaf, ADVANCING THE LEAF, persisted, then `entry_appended`. It is NOT
     `appendCustomMessageEntry`, so it does not enter the LLM context — which is
     what makes `/prinny status` safe to append: a readout listing every Matrix
     ID on the allowlist is context the model has no use for and a prompt
     injection would love.
   ⚠ it advances the branch, so it interacts with the loop's
     `branchEndsInCompaction`. Checked: that helper skips `custom` generically,
     not just the loop's own customType, so a `prinny-output` entry cannot
     defeat it.                                                          §10

 pi.on(event, fn) × 7     loader.js:209                    extension.handlers
   ✔ every one of the seven has a single unconditional emit site — the
     AA1 question, asked of prinny, and answered "yes" for all seven. The one
     worth stating is `message_end` for a `role:"user"` message: pi emits it
     from `runAgentLoop`'s prompt loop (`agent-loop.js:52`) and from the
     steering drain (`:98`), so BOTH delivery routes reach `markLive`.

 ctx.ui.notify(msg, kind) the mode's UI                        the transcript
   ⚠ `noOpUIContext.notify` is `() => {}` (runner.js:92), so outside a TUI every
     operator-facing line is discarded. prinny writes its own log file
     unconditionally, so unlike the loop before the tenth pass, nothing is lost
     — but the operator-facing half is silent, and `/prinny log` is the answer.

 ctx.ui.setStatus(key,…)  the mode's UI                          the footer
   ✔ present on `noOpUIContext`; a no-op headless.

 ctx.getContextUsage()    runner.js:524                   {tokens,window,percent}
   ✔ used only for `contextPercent()`, which tells an out-of-room empty turn
     from the other kinds. All three shapes (`undefined`, `tokens:null`, full)
     are handled by the `typeof … === "number" && isFinite` test.

 ctx.signal               runner.js:510 → agent-session.js:1898  agent.signal
   ✔ not used by prinny; listed because the tool_call ctx carries it.

 event.input (tool_call)  agent-loop.js:406, by reference
   ✔ read-only here — `previewCall(input)`/`describeCall` — and read BEFORE
     rtk-pi mutates it, because prinny is registered first. That ordering is
     what makes the approval an approval of the command the model wrote. §9
 ══════════════════════════════════════════════════════════════════════════════
```

### 8.2 `rtk-pi` — three distinct calls

```
 call                     pi implementation                    where it ends up
 ══════════════════════════════════════════════════════════════════════════════
 pi.exec("rtk",["--version"])   loader.js:287 → core/exec.js execCommand
   ✘ read `ver.code !== 0` and never `ver.killed`. `execCommand` resolves a
     child it killed on the timeout with `code: code ?? 0`, so a WEDGED rtk
     arrives as `{code:0, stdout:"", killed:true}` — which passes the "is it
     on PATH" test, makes `parseSemver("")` return null so the `>= 0.23.0`
     guard is skipped entirely, registers the handler, and taxes every
     allow-listed command 2 s before failing open. Nothing is said.     AB3
   ⚠ it is called at FACTORY time, so it runs once per session AND once per
     subagent spawn (`reloadAndMap` re-runs every factory) — inside the build
     window AB4 is about.

 pi.exec("rtk",["rewrite",cmd], {timeout, signal})   same
   ✔ `if (result.killed) return null` FIRST, then the exit-code contract
     (0 and 3 both mean "a rewrite was found", 1 means "no rtk equivalent"),
     then `extractRewrite`. This call site was already right, which is exactly
     what makes AB3 a finding rather than an oversight in general.
   ✔ `signal: ctx.signal` is `agent.signal`, so Esc kills the subprocess.

 pi.on("tool_call", fn)   loader.js:209                    extension.handlers
   ✔ ONE emit site in all of pi (`_installAgentToolHooks`'s `beforeToolCall`,
     agent-session.js:230), and it is inside the Agent, so it fires for every
     tool call in every run through either entry point. The AA1 question,
     answered.
   ⚠ `emitToolCall` has **no try/catch around handlers** (runner.js:701, unlike
     `emitUserBash` at :719), and agent-session rethrows as "Extension failed,
     blocking execution", which `prepareToolCall` turns into an error result.
     So a throwing tool_call handler BLOCKS the tool. rtk wraps its whole body
     and fails open, which is not defensive — it is the only correct shape.
   ✔ the return value is read for `block` and `terminate` only; arguments are
     changed by mutating `event.input`, which pi's own type documents and which
     the reference chain (`args` → `event.input` → `prepared.args`) supports.
 ══════════════════════════════════════════════════════════════════════════════
```

### 8.3 The five surfaces, run over the two new packages

```
   ┌─ 1. what we RETURN from a handler ─────────────────────────────────────┐
   │    prinny: `{block, reason}` from tool_call — first-blocker-wins, and  │
   │            `emitToolCall` RETURNS IMMEDIATELY, so rtk never sees a     │
   │            blocked command.                                     ✔      │
   │    rtk:    nothing, ever. It mutates. Correct, and documented by pi.✔  │
   ├─ 2. what we PASS to a call ────────────────────────────────────────────┤
   │    prinny: `deliverAs` → `streamingBehavior`, read on one branch;      │
   │            `expandPromptTemplates:false` is what keeps a Matrix `/`    │
   │            from being a command.                                 ✔     │
   │    rtk:    `{timeout, signal}` — both honoured by execCommand.   ✔     │
   ├─ 3. which events REACH us at all ──────────────────────────────────────┤
   │    prinny: seven handlers, seven unconditional emit sites.       ✔     │
   │    rtk:    one handler, one emit site, inside the Agent.         ✔     │
   ├─ 4. what a host function's answer CAN say ─────────────────────────────┤
   │    prinny: `sendUserMessage` returns void and CANNOT say it failed.✘AB2│
   │    rtk:    `exec` can say `killed`, and the probe did not ask.   ✘ AB3 │
   └─ 5. WHEN it can say it ────────────────────────────────────────────────┘
        prinny: the rejection is disposed of before any extension could hear
                it; the evidence has to be reconstructed from markLive's
                silence.                                              AB2
        rtk:    a hang is flattened into the same integer as success at the
                moment `waitForChildProcess` resolves.                AB3
```

---

## 9. Findings

Severity is about what it costs a real run. Evidence is **PROVEN** (an executable
probe drives the shipped module or pi's real implementation), **MEASURED** (a
number taken from the tree or from pi), or **SOURCE** (read, with the reasoning in
the finding).

| # | Finding | Sev | Evidence | Probe | Sibling of | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AB1 | `result.killed` is set only inside `execCommand`'s own `killProcess()`, so it means "pi killed this", not "this was killed". A goal check reaped by the OOM killer — or any signal pi did not send — resolves `{code: 0, killed: false}` and reads as a check that **PASSED**, which is the single terminating condition an `--until-done` run has | **HIGH** | PROVEN·MEASURED | `o1` | AA2, U3, V3 | ✔ fixed |
| AB2 | `pi.sendUserMessage` returns void; pi `.catch`es the rejection into `emitError`, whose listener set is empty outside a TUI, and no error event exists for an extension to subscribe to. A Matrix message pi refused — compaction in progress, no model, no provider auth — was dropped with neither the sender nor the operator told | **MEDIUM** | PROVEN·SOURCE | `o2` | W1, AA1 | ✔ fixed |
| AB3 | rtk's load-time version probe reads `code` and never `killed`, so a wedged binary passes the presence test, skips the version guard, and taxes every allow-listed command 2 s | **LOW** | PROVEN·MEASURED | `o3` | AA2 | ✔ fixed |
| AB4 | `addEventListener("abort")` on an already-aborted signal never fires, and `forwardAbortSignal` had no `.aborted` test. A stop during a child's build window did not stop it, and the tenth pass's T5 fix lost the same race during the judge's | **MEDIUM** | PROVEN·SOURCE | `o4` | T5, V7/W6 | ✔ fixed |

---

### AB1 — the death that was discarded before anyone could read it · **HIGH** · PROVEN·MEASURED · **FIXED**

**Where.** `runGoalCheck` in `vendor/pi-loop-mode/extensions/index.ts`, against
pi's `core/exec.js` and `utils/child-process.js`.

**What.** The tenth pass (AA2) found that `pi.exec` never rejects, that U3's
`execFailed` branch was therefore unreachable, and that a check killed on its own
timeout came back with exit code 0 — i.e. as a check that passed. The fix was to
read `result.killed`, which is the field pi actually provides.

It is the right field. It is not the whole question, and the reason is one level
down, in who writes it:

```js
   const killProcess = () => {                            // core/exec.js
     if (!killed) { killed = true; proc.kill("SIGTERM"); … }
   };
   if (options?.signal) { … options.signal.addEventListener("abort", killProcess) }
   if (options?.timeout) { timeoutId = setTimeout(killProcess, options.timeout) }
```

Two callers, both of them pi's own. **`killed` answers "did pi stop this", not
"did this finish".** And the other half of the question has no field at all,
because the signal is thrown away one layer further down:

```js
   const onExit = (code) => { exited = true; exitCode = code; … }  // child-process.js
   //  Node gives (code=null, signal="SIGKILL") for a signalled child
   finalize(exitCode)  →  resolve(null)
   resolve({ stdout, stderr, code: code ?? 0, killed })            // core/exec.js
                                       ▲
                                       └── the death becomes a zero here
```

`runGoalCheck` reads `passed: result.code === 0`.

**Proved.** `o1`, against pi's real `execCommand`:

```
  case                                       code  killed  marker   BEFORE  NOW
  ---------------------------------------------------------------------------------
  self-SIGKILL — an OOM kill looks like this 0     false   ABSENT   PASSED  could-not-run
  self-SIGTERM — an external stop            0     false   yes      PASSED  PASSED
  output, then SIGKILL                       0     false   ABSENT   PASSED  could-not-run
  control — a real failure                   1     false   yes      failed  failed
  control — a real pass                      0     false   yes      PASSED  PASSED
  control — pi's own timeout                 0     true    yes      c-n-run c-n-run
```

and then the shipped loop, `--check "kill -9 $$" --until-done`, one `LOOP_DONE:`:

```
   BEFORE   Active: false · Status: completed · Check status: passing
   NOW      Active: true  · "the check process died before it finished —
            killed by a signal rather than by its own exit" · 3 in a row pause it
```

**What it costs.** On this box specifically. The stack is a 27B model at Q4 in a
32k window on one llama slot, in a container, on a machine whose own operating
notes have a section about `docker build` dying with ENOMEM. A `--check "cargo
test"` or `--check "npm test"` reaped by the OOM killer is not a hypothetical, and
the damage is the same as AA2's: `--until-done` completes on the very next
`LOOP_DONE:`, and the operator is told the goal was met.

The second shape is the `check_failed` directive. A check that died is reported to
the model as a project that is failing, with "Fix exactly what the check reports"
and nothing to report — U3's original damage, restored one layer further down for
the second time.

**The fix, and why it is shaped this way.** pi cannot answer the question — the
signal is gone before `execCommand` resolves — so the evidence has to come from
inside the child. The check runs under a bash `EXIT` trap that prints a marker:

```js
   export function wrapCheckCommand(command: string): string {
     return `trap 'printf "\\n${CHECK_COMPLETION_MARKER}:%d\\n" "$?"' EXIT\n${command}`;
   }
```

bash runs an `EXIT` trap on a normal exit, on `exit N` from anywhere in the
script, and on a SIGTERM it is given — and **cannot run one at all when it is
SIGKILLed**. So the marker's presence means "bash reached its own exit", and its
absence means the process died. The trap goes on its own line, so a command with
an unterminated quote breaks exactly the way it broke before.

Three deliberate restrictions:

- **The marker's VALUE is not used.** `result.code` already agrees with it on
  every measured case, and reading an exit code out of the child's own stdout
  would let a check that prints attacker-controlled text choose its own verdict.
  Presence is the only signal taken.
- **`killed` is still tested FIRST.** A SIGTERM'd bash does run its trap, so a
  timeout satisfies both branches; the timeout has a number to quote and the
  better sentence.
- **SIGTERM from outside is left undecided**, and said so in §2.2's table. The
  marker proves completion, not intent, and `$?` after a signal is whatever the
  last command left. Inventing a rule there would be the same guess the tenth pass
  declined to make about exit code 127.

**One residue, stated:** a check whose own output contains the marker string can
make a killed run look complete. The token is long and namespaced; it cannot be
produced by accident.

*Tests:* `vendor/pi-loop-mode/tests/check-that-cannot-run.test.ts`, a new
`AB1` describe with seven cases, **four of which fail without the fix**.
`tests/exec-shapes.ts` is new and is the other half — see §11.

---

### AB2 — the message pi refused, and the failure nobody could subscribe to · **MEDIUM** · PROVEN·SOURCE · **FIXED**

**Where.** `deliverInbound` in `vendor/prinny-channel/extensions/index.ts`,
against `agent-session.js:1855`, `:1809`, `:808`/`:848`/`:859`, and
`runner.js:363`–`:371`.

**What.** The call looks defended:

```js
  try {
    api.sendUserMessage(text, { deliverAs: settings.deliverAs });
  } catch (err) {
    log(`could not deliver an inbound message into the session: ${err}`);
    notify('a Matrix message could not be delivered into this session', 'error');
  }
```

It is not. `ExtensionAPI.sendUserMessage` returns `void`, and pi's binding is:

```js
  sendUserMessage: (content, options) => {                  // agent-session.js:1855
    this.sendUserMessage(content, options).catch((err) => {
      runner.emitError({ extensionPath: "<runtime>", event: "send_user_message", … });
    });
  },
```

so every **asynchronous** failure is caught by pi. `emitError` walks
`runner.errorListeners` (`runner.js:367`), a set whose one possible member is
registered at `agent-session.js:1809` — and conditionally:

```js
  this._extensionErrorUnsubscriber = this._extensionErrorListener
      ? runner.onError(this._extensionErrorListener)
      : undefined;
```

Outside a TUI there is nobody in it. And there is no error member of
`ExtensionEvent` for an extension to subscribe to instead — the probe enumerates
the union and finds none. So the `catch` above can see exactly one thing: a
synchronous `runtime.assertActive()` throw from a stale runtime.

`AgentSession.prompt()` throws for four reasons, and three of them happen here:

```
   a compaction is in progress          agent-session.js:808
   no model is selected                 agent-session.js:848
   the provider has no usable auth      agent-session.js:859 (and :856 for OAuth)
   streaming with no delivery mode      agent-session.js:833   ← prinny always
                                                                 passes one
```

The first is reachable **every time `/loop` runs its compaction rung or its
context recovery**, because `ctx.compact()` reaches `AgentSession.compact()`,
whose first statement is `await this.abort()` and which holds
`_compactionAbortController` for the whole duration. The third is "the
llama-server is down", which is a state a Matrix user has no way to see.

**What it costs.** Silence, which is the worst outcome this extension has. The
room went into `awaitingReply` on arrival, was never marked live because pi never
consumed anything, and every later stage is gated on `live`: never answered, never
retired, never reported, no typing indicator, no give-up message. From Matrix it
is indistinguishable from being ignored — the exact failure the empty-turn
continuation was built to prevent, one layer further out.

**The fix.** The evidence has to be reconstructed, and prinny already has it:
`markLive` fires when pi echoes the message back as a `user` message, which is pi
saying it has taken it. So an entry that is still not live **once the session is
idle** and enough time has passed was not taken.

```js
  export function undeliveredRooms(entries, now, agentRunning, graceMs = 60_000) {
    if (agentRunning) return [];
    …entry.live || entry.undeliveredReported → skip
    …now - entry.at < graceMs               → skip
  }
```

Idleness is the load-bearing half, not the clock. A message delivered while pi is
streaming is queued and **drains inside that same run** — `runLoop`'s inner while
takes steering, the outer while takes follow-ups, and `_handlePostAgentRun` runs
`agent.continue()` for anything queued after `agent_end` — so it is live before
`agent_settled` fires. Waiting for idle costs nothing in the normal case and
removes the whole "it was just busy" class of false positives. The clock covers
the one thing idleness cannot: `prompt()` awaits `_checkCompaction` **before** it
starts a run, so a message handed to an idle session can sit with nothing running
and nothing consumed for as long as an auto-compaction takes.

Two design choices worth stating:

- **It reports and does not retire.** The entry is left in place, so a late
  delivery still reaches `markLive` and the answer still goes out. The worst case
  of a wrong verdict is one extra sentence; it can never be a lost answer.
- **It does not re-send.** Asking the model the same question twice is worse than
  saying "I could not hand that over".

The sweep runs from two places, and the second one exists because the failure
removes the first: `agent_settled` (the moment the answer should have existed) and
an unref'd 30-second interval, armed when a message arrives and cleared when
nothing is waiting — because a message that was refused never starts a run, so
there may be no `agent_settled` at all.

*Tests:* `vendor/prinny-channel/tests/delivery.test.ts`, ten cases, **two of which
fail without the wiring**. The rule itself lives in `src/delivery.ts`, which
imports nothing.

---

### AB3 — the probe that could not see a hang · **LOW** · PROVEN·MEASURED · **FIXED**

**Where.** the factory in `vendor/rtk-pi/extensions/index.ts`.

**What.** The load-time probe answers one question — is there a usable rtk on
PATH? — and asked it with `ver.code !== 0`. Which is the AA2 shape exactly:

```
  state                    code  killed  stdout          BEFORE           NOW
  ----------------------------------------------------------------------------
  rtk is healthy           0     false   "rtk 0.45.0"    FILTERING        FILTERING
  rtk is not installed     127   false   ""              not on PATH      not on PATH
  rtk is WEDGED (hangs)    0     true    ""              FILTERING        wedged
  rtk is old               0     false   "rtk 0.19.3"    too old          too old
```

Both states the probe was *written* for are answered correctly. Only the state
nobody thought about reads as healthy — and the consequences compound:

- the "not on PATH" warning does not fire, so nothing is said;
- `parseSemver("")` returns null, so the `>= 0.23.0` guard is **skipped
  entirely** — the one place this extension decides not to filter;
- the handler registers, and every allow-listed command then spends the full
  2,000 ms waiting for the same wedged binary before `rewriteCommand`'s own
  `killed` check fails it open.

Forty lines below the probe, `rewriteCommand` tests `result.killed` first and is
right. That is what makes this a finding and not an oversight in general: the
package knows the rule and applied it at one of its two `pi.exec` call sites —
the seventh pass's shape (a rule fixed at the instance in front of it, with its
sibling left alone), in a package the seventh pass never opened.

**Proved.** `o3`, against pi's real `execCommand`, plus a source pin on the order.

**The fix.** `if (ver.killed) { warn "rtk --version did not answer within 2000ms";
return }` before the `code` test, with the reason next to it.

*Tests:* `vendor/rtk-pi/tests/version-probe.test.ts`, four cases, **one of which
fails without the fix**; the first drives pi's real `execCommand` to establish the
premise and the last is the control that pins `rewriteCommand`'s already-correct
order.

---

### AB4 — the abort that arrived before its listener · **MEDIUM** · PROVEN·SOURCE · **FIXED**

**Where.** `forwardAbortSignal` / `runTurnLoop` in
`vendor/pi-subagents-lite/src/agents/agent-runner.ts`.

**What.** `AbortSignal` dispatches `abort` exactly once, at abort time. A listener
added afterwards never runs; `signal.aborted` is the only evidence left. Every
consumer therefore has two cases, and only one of them looks like work:

```js
   if (signal.aborted) …                    // the abort that has already happened
   signal.addEventListener("abort", …)      // the abort that has not
```

`forwardAbortSignal` had only the second. And it is called at the **top of
`runTurnLoop`** — after everything in `runAgentImpl` that builds the child:

```
   reloadAndMap()            every extension factory runs again, and rtk's
                             shells out to `rtk --version` (up to 2 s)
   createAgentSession()
   onSessionCreated()
   bindExtensions()          the child's session_start
   resolveVisibleTools() → setActiveToolsByName()
   ──────────────────────────────────────────────────────────────────
   runSessionPrompt → runTurnLoop → forwardAbortSignal   ← only from HERE
```

Seconds, on a 9p mount where discovery stats thousands of small files. Two things
ride on that signal and both lost the same race:

- **`stopAgent()` on a running record does nothing else.** Its entire effect on a
  started run is `record.execution.abortController?.abort()`. So stopping a
  subagent during its build did not stop it: the child ran its whole prompt on the
  single llama slot, and `attachSettlementChain` handed the answer to the parent
  through the completion gate — while `record.lifecycle.status` said `stopped`,
  because the `.then` correctly declines to overwrite it.
- **T5 lost it too.** `startDeadline` composes `verifyAbort` with the timer and
  gets the already-aborted case right (`if (stopSignal.aborted)
  controller.abort()`), and then hands the composed signal to `runAgent`. Esc
  during the judge's build bought one full model call before `assertNotExpired()`
  threw. The tenth pass closed T5 at its own layer and the layer below undid part
  of it.

**Proved.** `o4`: the JS semantics executed (listener attached after `abort()`
never fires; the control, attached first, does), the wrong fix executed (see
below), and an enumeration of every `addEventListener("abort")` in the package
with its `.aborted` pair.

**The fix, and why it is a refusal rather than an abort.** The obvious repair —
have `forwardAbortSignal` call `onAbort()` when it finds `.aborted` — is worse
than nothing, and `o4` runs it to show why: `session.abort()` before
`session.prompt()` is consumed by nothing. pi's abort tears down what is running
*now*; the prompt issued afterwards is a new run. The operator's stop would be
spent and the run would go ahead **looking handled**.

So `runTurnLoop` refuses to start:

```js
   if (options.signal?.aborted) throw new Error(ABORTED_BEFORE_START);
   await session.prompt(prompt);
```

and the throw lands on paths that already handle a stop:
`attachSettlementChain`'s `.catch` leaves a `"stopped"` status alone, and
`verifyAnswer`'s catch is already this layer's "the check did not happen" path,
which preserves the child's answer and annotates it.

*Tests:* `vendor/pi-subagents-lite/tests/abort-before-start.test.ts`, seven cases,
**one of which fails without the fix**. The last one is the invariant rather than
the instance: it enumerates every abort listener in `src/` and requires each to be
paired with an `.aborted` test, so a fourth one cannot be added without saying
which of the two cases it covers.

---

## 10. The notes

The tenth pass emptied the note list and said so, and the reason it gave was that
a backlog of deliberate non-decisions is the shape a defect hides in. Three new
ones arrived this pass. All three have a fix, all three got it, and the list is
empty again.

### 10.1 Fixed — an unbounded resource in an unattended stack

- **`compaction-guard`'s spill directory was never pruned.** Every file it writes
  is by construction a tool result that did not fit the context — at least 1,500
  chars and often tens of kilobytes — and nothing ever removed one. The whole
  point of that extension is unattended runs: a `/loop` going for days, capping a
  test runner's output every iteration and forgetting it. On this box the
  `mkdtemp` lands in the container's writable layer, which is the same disk as
  everything else, and the repo has a whole `/free` skill about disk pressure.

  Bounded at **50 files**, oldest first, pruned *after* the write so the file the
  marker just named can never be the one removed. A count rather than a teardown
  hook, deliberately: `spillDir` is module-global and a CHILD inherits this
  extension by discovery, so parent and child share one directory and a
  `session_shutdown` sweep on either side would delete files the other's markers
  still name. A count has no such coupling.
  *Tests:* `spill-bound.test.ts` ×2, one of which fails without it.

### 10.2 Fixed — an ordering that decided something, and said nothing

- **`prinny-channel` must load before `rtk-pi`, and nothing said so.** Both
  register `tool_call`; pi runs them in registration order; prinny's is the
  permission relay and rtk's rewrites `event.input.command` in place. With prinny
  first, the command a human is asked to approve is the command the model wrote,
  and a blocked command never reaches rtk at all — `emitToolCall` returns
  immediately on `{block:true}`. The other way round, the relay would quote `rtk
  git status` for a model that asked for `git status`: an approval for a command
  nobody typed.

  This is the third ordering in the launcher that decides behaviour and the first
  that is asymmetric — `context` and `tool_result` are both fine either way, and
  both were documented. Now written down where the flags are, with the mechanism
  rather than the conclusion. `permissionMode` is `off` by default, so it only
  bites a session that has turned the relay on — which is exactly the session that
  cares.

### 10.3 Fixed — a cast that asserted a type onto itself

- **`as Parameters<typeof api.sendUserMessage>[1]`** in prinny's command branch.
  The ExtensionAPI type really does declare `{ deliverAs, expandPromptTemplates }`,
  so the cast was a no-op that could only ever have hidden a real signature
  change. Removed, with the citation in its place.

### 10.4 Corrected rather than fixed — a comment that is right about the outcome

- **prinny's empty-turn continuation says "a follow-up, not a steer: nothing is in
  flight at `agent_settled`".** The outcome is right and the mechanism is a
  different one: `_emitAgentSettled` sets `_isAgentRunActive = false` **before**
  emitting (`agent-session.js:328`), so `prompt()` takes the *idle* branch and
  `deliverAs` is not read at all — it starts a whole new run. Left as it is,
  because the code does what the comment says it does; noted here so a future
  reader who checks does not conclude the queueing is broken.

### 10.5 Still open, and why — decisions, not omissions

Carried forward unchanged from the tenth pass, each with its reason:

- **T6 — `worktree_path` is a filesystem grant, not a sandbox.** The available
  tightenings would each break the feature's main use. A product decision.
- **Per-session loop state** (the `WeakMap<ExtensionAPI, LoopState>` refactor). A
  capability change with a working three-stop mitigation and no observed symptom.
- **T1's general case** — needs a pi-side "add context without asking a question",
  which does not exist.
- **`hasStateChange()`'s keyword list** — a heuristic feeding one advisory nudge.
- **The brief-before-session window** — milliseconds, and the alternative puts the
  write on a path with no error handling.

And one new one, which belongs on this list rather than in §10.1:

- **A check killed by SIGTERM from outside is still not distinguishable from one
  that ran.** bash runs its `EXIT` trap when SIGTERMed, so the marker is present
  and `$?` is whatever the last command left. Trapping `TERM`/`HUP`/`INT`
  explicitly and exiting `128+n` would catch it — and would then misread a check
  that genuinely exits 143 as a signal death, which is the same guess this stack
  declined to make about exit code 127. SIGKILL is the case that matters here
  (it is what the OOM killer sends) and it is caught unambiguously.

---

## 11. What was re-verified this pass, and holds

Read out of pi's shipped `dist/` (0.84.2) and out of the tree, not assumed.

- **All forty-seven prior probes run clean**, and all forty-seven prior fixes are
  in the tree.
- **`pi.exec` still never rejects**, and `execCommand`'s `killProcess` still has
  exactly two callers. Re-read for AB1 and AB3.
- **`_emitAgentSettled` sets `_isAgentRunActive = false` BEFORE emitting**
  (`agent-session.js:328`), so `ctx.isIdle()` is true inside an `agent_settled`
  handler. This is what makes prinny's continuation an idle-branch prompt, and it
  is the complement of AA4's fact about `isStreaming`.
- **`runAgentLoop` emits `message_start`/`message_end` for each prompt message**
  (`agent-loop.js:52`) *and* for each drained steering message (`:98`). Both of
  prinny's delivery routes therefore reach `markLive`; a reading in which only the
  streaming route did would have made the idle case unanswerable, and it is not
  the case.
- **`emitToolCall` has ONE emit site in all of pi** (`agent-session.js:230`,
  inside `_installAgentToolHooks`), it passes the event **by reference with no
  clone**, and `prepareToolCall` then executes with the same `validatedArgs`
  object — so rtk's in-place mutation reaches the tool. pi's own
  `ToolCallEventResult` documents this as the intended mechanism.
- **`emitToolCall` has no try/catch around handlers**, unlike `emitUserBash`, and
  agent-session rethrows as "Extension failed, blocking execution" — so a throwing
  `tool_call` handler blocks the tool. Both handlers in this stack are total
  (rtk wraps its body; prinny's `requestApproval` returns a decision on every
  path).
- **`branchEndsInCompaction` skips `custom` entries generically**, not just the
  loop's own customType, so prinny's `prinny-output` entries cannot defeat it.
- **`noOpUIContext` implements every `ui.*` method this stack calls** — `notify`,
  `setStatus`, `custom`, `setWorkingMessage`, `confirm`, `select`,
  `onTerminalInput`, `getToolsExpanded`, `setToolsExpanded`. So a headless run
  cannot crash on the UI; it can only be ignored by it. `confirm` answering
  `false` and `select`/`custom` answering `undefined` headless is safe at all
  eleven call sites (they are all in `/stack`'s interactive commands).
- **`spawn()`'s parent-signal binding tests `.aborted` first** (`agent-manager.ts`
  :328), and `startDeadline` does too (:130). Those are the two abort listeners
  AB4 is *not* about, and checking them is what made the finding narrow.
- **The loop is inert in a child** by three independent stops, and
  `pi-subagents-lite` is inert in a child by its factory guard.
- **`prinny-channel` is denied to a child** by `withExtensionDenial()`'s path
  regex, and `rtk-pi` reaches one deliberately by route B.

---

## 12. What shipped

Every fix carries a regression test that fails when the fix is removed; where a
case passes either way it is a control and is labelled as one.

### The four findings

| # | Fixed by | Where | Tests | Fail without it |
| --- | --- | --- | --- | --- |
| AB1 | the check runs under a bash `EXIT` trap; the marker's absence is "it did not finish" | `pi-loop-mode/src/goal-check.ts` (`CHECK_COMPLETION_MARKER`, `wrapCheckCommand`, `readCheckCompletion`), `extensions/index.ts` `runGoalCheck` | `check-that-cannot-run.test.ts` +7 | 4 |
| AB2 | an evidence-based delivery sweep: not live + idle + past the grace ⇒ pi never took it | `prinny-channel/src/delivery.ts` (new), `extensions/index.ts` (`sweepUndelivered`, `armDeliverySweep`) | `delivery.test.ts` ×10 | 2 |
| AB3 | `ver.killed` tested before `ver.code` | `rtk-pi/extensions/index.ts` | `version-probe.test.ts` ×4 | 1 |
| AB4 | `runTurnLoop` refuses to prompt a run whose signal has already fired | `pi-subagents-lite/src/agents/agent-runner.ts` (`ABORTED_BEFORE_START`) | `abort-before-start.test.ts` ×7 | 1 |

### The notes

| what | Where | Tests |
| --- | --- | --- |
| the spill directory is bounded at 50 files, oldest pruned after the write | `.pi/extensions/compaction-guard/index.ts` | `spill-bound.test.ts` ×2 (1 fails without it) |
| the `tool_call` load order prinny→rtk is documented where the flags are | `scripts/pi-local.sh` | — |
| a cast that asserted a type onto itself, removed | `prinny-channel/extensions/index.ts` | — |

### The harness

The change with the widest reach is not a fix at all, and it is the eighth pass's
lesson arriving one field lower down:

```
   tests/exec-shapes.ts     NEW.  completedCheck / signalledCheck / timedOutCheck
   _host.mjs                its default exec stub was
                              { code: 0, stdout: "", stderr: "" }
                            which is a faithful shape for a check that passed
                            silently AND for a check the OOM killer reaped.
                            Six suites and every probe were built on it.
```

A stub that cannot tell two cases apart cannot fail when the module cannot either.
Every exec stub in `vendor/pi-loop-mode/tests` and `_host.mjs`'s default now
build their results through a helper that puts the completion marker where bash
would, so the distinction exists in the harness before it is asserted anywhere.
`package.json`'s lint glob widened from `tests/*.test.ts` to `tests/*.ts` so the
helper is checked too.

### The gates

```
                                      before    after
vendor/pi-loop-mode         tests     180       187
vendor/pi-subagents-lite    tests     266       273     lint 85/85 files
vendor/prinny-channel       tests     301       311     lint clean
.pi/extensions/compaction-guard        39        41
vendor/rtk-pi               tests      16        20     ← never counted before
                                      ─────     ─────
                                       802       832
probes                                  47        51
```

### Two new no-import modules

The count is the pattern, not the number. Each exists because the file it came
from imports pi and therefore cannot be loaded by a suite, so the rule inside it
could not be tested at all:

```
   turn-tracking.ts        T1   the turn ceiling
   record-activity.ts      Y1   is this record still busy
   run-answer.ts           Z1   what a run said
   compaction-anchor.ts    Z2   does this compaction reach a turn
   git-failure.ts          AA2  which git failure is this
   status-listing.ts       —    which agents to print
   goal-check.ts (grown)   AB1  did the check finish                  ← this pass
   delivery.ts             AB2  did pi ever take this message         ← this pass
```

---

## 13. Running the evidence

```sh
cd ~/instantcoffee

# the gates
( cd vendor/pi-loop-mode       && npm test && npm run lint )          # 187
( cd vendor/pi-subagents-lite  && npm test && node tests/lint.mjs )   # 273 + 85/85
( cd vendor/prinny-channel     && npm test && npm run lint )          # 311
( cd .pi/extensions/compaction-guard && npm test )                    #  41
( cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts )  # 20

# just this pass's regression tests
( cd vendor/pi-loop-mode && node --experimental-strip-types --test \
    tests/check-that-cannot-run.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/abort-before-start.test.ts )
( cd vendor/prinny-channel && node --experimental-strip-types --test \
    --test-timeout=90000 tests/delivery.test.ts )
( cd .pi/extensions/compaction-guard && node --experimental-strip-types --test \
    tests/spill-bound.test.ts )
( cd vendor/rtk-pi && node --experimental-strip-types --test tests/version-probe.test.ts )

# this pass's probes
P=context/testing/probes
node --experimental-strip-types $P/o1-the-check-that-was-killed-by-something-else.mjs
node --experimental-strip-types $P/o2-the-matrix-message-pi-refused.mjs
node --experimental-strip-types $P/o3-the-rtk-probe-that-cannot-see-a-hang.mjs
node --experimental-strip-types $P/o4-the-abort-that-arrived-too-early.mjs

# every probe, exit code only
for f in context/testing/probes/[a-z]*.mjs; do
  timeout 120 node --experimental-strip-types "$f" >/dev/null 2>&1 || echo "FAIL $f"
done
```

| probe | what it showed | the control |
| --- | --- | --- |
| `o1` | pi's real `execCommand` calling three different signal deaths exit code 0, and the shipped loop completing an `--until-done` run on one of them | a real failure, a real pass, and pi's own timeout — which `killed` already caught |
| `o2` | pi catching the rejection itself, one conditional error listener, and no error event in `ExtensionEvent`; then the sweep's five states | a message queued behind a running turn, which must never be reported |
| `o3` | a wedged `rtk --version` reading as healthy, and the version guard being skipped because `parseSemver("")` is null | the two states the probe was written for, both answered correctly, and `rewriteCommand`'s already-correct order |
| `o4` | a listener attached after `abort()` never firing, and `session.abort()` before `prompt()` being consumed by nothing | the same listener attached first, which does fire |

`o1` and `o3` drive pi's real `execCommand`; `o2` and `o4` read pi's `dist/` and
the tree, because the fact under test is pi's own routing and a stub of it would
be the thing being questioned.

---

## 14. The pattern across eleven audits

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
   the rest of the contract   AA1–AA4  which events reach us at all, and what a host
                                       function's answer is able to say
   the contract IN TIME       AB1–AB4  the answer was available for an instant, and
                                       the reader arrives after it
```

The tenth pass's lesson was **read the implementation of every host API the module
calls**, and it produced a checklist with four surfaces. Carrying that checklist
over two packages nobody had read produced these four, and every one of them
needed one more question than the checklist asks.

**Ask who WRITES the field, not what it is called.** `killed` is not "was this
killed" — it is `killed = true` inside `killProcess()`, whose two callers are both
pi's own. `code` is not "the exit code" — it is `code ?? 0`, where `null` means a
signal. A field name is a summary written by somebody who was thinking about a
different case than you are; the assignment is the specification. AB1 and AB3 are
both that question, asked of the same function, in two packages.

**Ask how long the answer stays true, and who is listening when it becomes true.**
An `AbortSignal` is a fact with a dispatch: the boolean persists and the event does
not, so a consumer that only listens has covered half of it (AB4). A rejected
promise is a fact with one consumer: if the host `.catch`es it before you can, it
never existed as far as you are concerned (AB2). Both are "the value was there,
and then it was not", and neither shows up in a signature.

**A one-shot event needs its `.aborted` sibling; a `void` return needs an
out-of-band witness.** Those are the two repairs in this pass, and they generalise:
when the host's answer is transient, look for a *durable* thing that only becomes
true on the same path, and read that instead. For AB4 the durable thing was
`signal.aborted`. For AB2 it was `markLive` — the room going live is pi saying, in
its own words and on its own schedule, that it took the message; the absence of
that, once nothing else can explain it, is the failure the API would not report.
For AB1 it was a marker printed by the child itself, because pi keeps nothing at
all.

**And one about coverage, which is the reason two of these existed.** Ten passes
audited three packages out of five, and the two that were skipped were skipped for
good reasons: `prinny-channel` is opt-in and off by default, and `rtk-pi` is a hundred
lines that "only rewrite a command". Both reasons are about how *important* the
package looked, and neither is about how likely it is to be wrong. The two of them
held one finding each, at the same rate as the three that had been read ten times
— and prinny's is the only user-visible failure in the whole tree, because it is
the only component with a second person on the far side of it.

---

## 15. Still unwatched

Everything above is fixed against probes and tests, and none of it against a
running model. That has been true for eight passes now and it is the whole of what
is left.

1. **§M of `context/testing/subagents-loop-verifier.md`** — still the cheapest run
   on the list: one `/loop start` with a deliberately slow `--check`, and
   `/loop status`. Both tenth-pass HIGH findings sit on it and so does AB1. It
   needs no subagent and no verifier. **§M.2 is new**: the same run with a check
   that kills itself (`--check "kill -9 $$"`), which is AB1's whole path in one
   command.
2. **§O is new** — a Matrix message sent while the loop is compacting, which is
   AB2 end to end and the only fix in this pass whose failure mode is visible to
   somebody other than the operator.
3. **A real verification**, foreground, `SUBAGENT_VERIFY_ROUNDS=1`, deliberately
   off-task brief — S2, U4, U8, V5, V7/W6, W5, Y1, Z1, T5, and now AB4: Esc during
   the judge's *setup* should end it, where before it bought a full model call.
4. **Log the judge's raw reply.** Still #1 by age, untouched by this pass, and
   load-bearing for S2, U4, V5 and W5.
5. **A child that compacts** (§L) — Z1 and Z2 both live there.
6. **A delegation with a loop running** (§I) — fixed at the module level nine times
   now and never watched. Section I is eleven passes old.
7. **§J** (steering a running subagent, W3), **§K/§K.2** (a verifying record in
   `/agents`, Y1 and T5), **§N** (a Matrix exchange with a background subagent
   running, prinny's W1) — none ever run.
8. **A degenerate turn in the wild.** Rule 1 has never fired in a real session.
9. **Still open by decision, each with a reason in §10.5:** T6, per-session loop
   state, T1's general case, `hasStateChange`'s keyword list, the brief-before-
   session window, and now SIGTERM-from-outside on a goal check.

---

## 16. Where to look

- `context/testing/probes/o1`–`o4` — the reproductions, one per finding.
- The regression tests: `vendor/pi-loop-mode/tests/check-that-cannot-run.test.ts`
  (AB1) and `tests/exec-shapes.ts` (the harness half of it),
  `vendor/prinny-channel/tests/delivery.test.ts` (AB2),
  `vendor/rtk-pi/tests/version-probe.test.ts` (AB3),
  `vendor/pi-subagents-lite/tests/abort-before-start.test.ts` (AB4),
  `.pi/extensions/compaction-guard/tests/spill-bound.test.ts` (§10.1).
- **§1** of this document — the machine, all five extensions, for the first time.
  **§6** and **§7** — `prinny-channel` and `rtk-pi`, first accounts. **§8** — the
  ledger for both, which completes the tenth pass's homework. **§8.3** — the five
  surfaces run over them.
- `context/design/subagents-loop-verifier-hosts.md` — the tenth pass. Its §7 is
  the ledger for the other three packages and §7.5 is the four-surface checklist
  this document adds a fifth to. Its §1 is what this document's §1 extends.
- `…-answers.md` (ninth, Z1–Z4) · `…-turns.md` (eighth, X1–X5, Y1) ·
  `…-readers.md` (seventh, W1–W6) · `…-shapes.md` (sixth, V1–V8) · `…-units.md`
  (fifth, U1–U9, whose §9 reference sections no later document restates) ·
  `…-surfaces.md` (fourth, S1–S10) · `…-mechanics.md` (third, T1–T9, still the
  best account of pi's own agent loop) · `…-evaluation.md` (second, F1–F11) ·
  `…-anatomy.md` (first, and the design rationale).
- `vendor/rtk-pi/FORK.md` — the measurements behind the allow-list, and
  `./scripts/rtk.sh --check`, which re-runs them against the installed binary.
- `vendor/prinny-channel/FORK.md` — what changed from the Claude Code plugin.
- pi's own source, for this pass:
  `dist/core/exec.js` (`execCommand` — `killProcess`'s two callers, and
  `code: code ?? 0`),
  `dist/utils/child-process.js` (`waitForChildProcess` — `onExit(code)`, where the
  signal is dropped),
  `dist/core/agent-session.js:808`/`:833`/`:848`/`:859` (every way `prompt()`
  throws), `:230` (`_installAgentToolHooks`, the only `emitToolCall`), `:328`
  (`_isAgentRunActive = false` before the settled emit), `:1107` (`sendUserMessage`
  → `prompt`), `:1809` (the one conditional error listener), `:1855` (the binding
  that `.catch`es), `:1898` (`getSignal` → `agent.signal`),
  `dist/core/extensions/loader.js:267`/`:287` (`sendUserMessage`, `exec`),
  `dist/core/extensions/runner.js:92` (`noOpUIContext`), `:363`–`:371` (`onError`
  / `emitError`), `:701` (`emitToolCall`, and its missing try/catch),
  `dist/core/extensions/types.d.ts` (`ExtensionEvent`, and
  `ToolCallEventResult`'s "mutate `event.input` in place instead"),
  `pi-agent-core/dist/agent-loop.js:52`/`:98` (both `message_end` sites for a user
  message), `:405` (`beforeToolCall`, and `args` by reference).
