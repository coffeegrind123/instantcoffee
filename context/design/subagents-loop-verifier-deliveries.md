# Subagents, the loop, and the verifier — the deliveries that never arrived

Twelfth pass, 2026-08-18. A full read of the whole stack — the loop, subagents,
the verifier, and the two extensions under and beside them — asking one question
the first eleven passes never asked of anything: **this thing produces an answer;
name the reader, and say what the reader sees when the delivery fails.**

Five findings, all five fixed, and the first of them had been live since the
tenth pass:

```
   AC1  Every BACKGROUND subagent's answer, and every continuation's, stopped
        reaching the parent model. AA4's edit deleted the `ctx` binding along
        with the ternary that used it and left three readers below it, so
        `emitIndividualNudge` threw `ReferenceError: ctx is not defined` three
        lines before `pi.sendMessage`. The catch around it was written for a
        different failure and reported "Result available" — through a UI method
        that is `() => {}` outside a TUI.                         HIGH · FIXED

   AC2  `/loop resume` carries the check's verdict and its error streak across
        from the run that ended. A completed `--until-done` run that is resumed
        completes again on the model's first `LOOP_DONE:` — while its own status
        line says the check has not run — and a resume after `pauseForCheck-
        Failure` re-pauses on the first hiccup, printing "(4/3)".
                                                                MEDIUM · FIXED

   AC3  A bash `EXIT` trap is a slot, not a stack. AB1's completion marker is
        removed by a check that sets its own trap (`trap 'cleanup' EXIT; make
        test`) or `exec`s — so a check that ran perfectly reads as one the OOM
        killer reaped, and three of those pause an unattended run.
                                                                MEDIUM · FIXED

   AC4  AB2's undelivered sweep reported messages `prinny-channel` had answered
        itself. A refused Matrix command and an executed one both leave an entry
        that is not live, past the grace, on an idle session — so the sender was
        told "I could not hand that to the session … please send it again" about
        a message that had been answered.                        MEDIUM · FIXED

   AC5  `/compact` was on the Matrix allow-list and in the advertised command
        menu, and pi cannot dispatch it: `prompt()` executes EXTENSION commands
        only, and `/compact` is a built-in the TUI's own input handler runs. From
        Matrix it became a model turn on the literal text "/compact", while the
        sender was told it had run.                              MEDIUM · FIXED
```

**853 tests across five packages, lint 85/85, and fifty-five probes.** The suite
was 832 and the probes 51; none of them caught any of these five, and §9 says of
each one exactly why not.

And the shape they share, which is §14 and the reason this pass is not the
eleventh pass again:

```
   surface 1   what we RETURN from a handler          eighth pass    (X5)
   surface 2   what we PASS to a call                 ninth pass     (Z1–Z4)
   surface 3   which events REACH us at all           tenth pass     (AA1)
   surface 4   what a host function's answer CAN say  tenth pass     (AA2)
   surface 5   WHEN it can say it, and how long       eleventh pass  (AB1–AB4)
               the answer stays true
   ─────────────────────────────────────────────────────────────────────────
   surface 6   WHO RECEIVES IT — and what they see when nobody does
                                                      this pass  (AC1–AC5)
```

Surfaces 1–5 are all about a value: its shape, its route, its lifetime. This one
is about the **other end**. Every finding here is a delivery: an answer that was
produced and never handed over (AC1), a verdict handed to a run that did not earn
it (AC2), a receipt the payload can forge (AC3), a delivery report about a
non-delivery (AC4), and a parcel accepted for an address that does not exist
(AC5). Four of the five are silent by construction, because the thing that would
have complained is a `catch`, a `void` return, or a UI that is a no-op.

---

## 0. How this sits next to the other eleven documents

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
| eleventh | `…-signals.md` (AB1–AB4) | between a fact and the moment it stops being available |
| **twelfth** | **this** | **between a thing being sent and a thing being received** |

Three things make this pass different in kind from the eleventh.

**One of its findings was introduced by an earlier pass.** AC1 is AA4's edit, and
AA4 is correct — the reasoning in it is right, the test that pins it passes, and
the behaviour it chose is the behaviour that ships. What went wrong is one line
of collateral: the deleted ternary took a `const` with it that three later lines
still read. That is not a reasoning failure, it is a mechanical one, and the only
instrument that finds it is **execution**. Which brings the second thing.

**It is the first pass to distrust the tests rather than the code.** The eighth
pass's lesson was *a harness is a claim about the host*; the eleventh extended it
to *a harness must be able to produce every value the host can return*. This one
is the next step and it is uncomfortable: **a fix whose test cannot execute the
function it changed is pinned against editing, not against breaking.** The test
that guards AA4 reads `spawn-coordinator.ts` as a string and asserts a regular
expression over it. Its own header explains why — the module imports pi, so the
suite cannot load it — and that is true and was never re-examined, even though
four probes in this repo already load pi-importing modules through pi's own
bundled `jiti`. §9's AC1 has the whole account; §12 has the new test, which loads
the module and runs the function.

**It reads the stack as a delivery network rather than as three components.**
§8 is the ledger: every answer this stack produces, the carrier that moves it,
the reader at the far end, and what that reader sees when the carrier drops it.
Eleven of the fourteen carriers are `void`, fire-and-forget, or a `catch`. That
is not a defect in itself — it is pi's design and mostly the right one — but it
means **"it was sent" and "it arrived" are different claims everywhere in this
tree**, and only one of the fourteen distinguishes them without help.

---

## 1. The whole machine

Everything in this document is a zoom into this drawing. It is the eleventh
pass's §1 with the delivery axis added: every arrow that carries an ANSWER is
marked `▶`, and every one of those that cannot report its own failure is marked
`▶?`. The two entry points, the three nested units of a turn, the five extensions
and the event bus are unchanged and still exact.

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
  │   /command? ─▶ _tryExecuteExtensionCommand ─▶ RETURN. no turn.     :800    │
  │       ▲ EXTENSION commands only — getCommand(name) is the extension        │
  │         registry. pi's BUILT-INS (/compact, /model, /new …) are executed   │
  │         by the TUI's own input handler and are unreachable here.   [AC5]   │
  │   compacting?         ─▶ THROW "Cannot submit a prompt while…"      :808   │
  │   streaming?          ─▶ streamingBehavior ?? THROW                 :833   │
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
  │   RETURNS void. Every failure is pi's `.catch` → emitError → a listener   │
  │   set that is EMPTY outside a TUI.                        [AB2] [AC1]     │
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
    │     │     drain steering → message_start / message_end        :98
    │     │     streamAssistantResponse → message_update… message_end   :253
    │     │       ┗━ message_end is THREADED and the result is written  [X5]
    │     │          OVER the object agent-core holds (_replaceMessageInPlace:
    │     │          delete every key, Object.assign the replacement)
    │     │     executeToolCalls
    │     │       ┏━ beforeToolCall ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ :405
    │     │       ┃  emitToolCall(event)  — ONE emit site in all of pi ┃
    │     │       ┃  `event.input` IS the validated args, BY REFERENCE ┃
    │     │       ┃  handlers mutate it in place; only `block` is read ┃
    │     │       ┃  NO try/catch: a throwing handler BLOCKS the tool  ┃
    │     │       ┗━ prinny's permission relay, then rtk's rewrite ━━━━┛
    │     │       execute → afterToolCall → emitToolResult              :551
    │     │         ┗━ ONE shared event object for every handler; each
    │     │            returned field is merged into it in order
    │     │            loop fingerprints RAW · guard caps after it
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
  │ X1–X5 Z3 Z4   │ §5, spill     │ AB4           │               │ §7.2, AB3     │
  │ AB1 ← AC2 AC3 │ bound         │ ← AC1         │ W1 AB2        │               │
  │               │               │               │ ← AC4 AC5     │               │
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
   context                   ✓      ✓                          structuredClone,
                                                                 then threaded
   turn_start                              ✓                   ignored
   message_start             ✓                                 ignored
   message_update            ✓                                 ignored
   message_end               ✓                    ✓            THREADED + written
                                                                 back IN PLACE
   tool_call                               ✓      ✓       ✓    block-only; the
                                                                 EVENT IS MUTATED
   tool_result               ✓      ✓                          ONE shared object,
                                                                 fields merged
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

   THREE orderings decide behaviour:

   context        loop FIRST, appends `loop-context-budget`; the guard sees the
                  `-context-budget` suffix and stands down. Both sides check, so
                  either order works. Documented in pi-local.sh.       ✔
   tool_result    loop FIRST, fingerprints the RAW output into the stuck
                  window; the guard's cap runs after. `stripShorteningMarkers`
                  makes rule 7 order-independent.                      ✔
   tool_call      prinny FIRST, rtk SECOND — and this one is NOT symmetric,
                  because a `{block:true}` returns from `emitToolCall`
                  IMMEDIATELY. With prinny first, the command a human approves
                  is the command the model wrote. Documented since the
                  eleventh pass.                                       ✔

 ══════════════════════════════════════════════════════════════════════════════
  E.  A DELEGATION, WITH EVERY DELIVERY MARKED
 ══════════════════════════════════════════════════════════════════════════════

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │   module-global state, shared by every session in this PROCESS:          │
   │     pi-loop-mode   state:LoopState · runToken · pendingTimer · 3 buffers │
   │     pi-subagents   shell{pi,sessionCtx,manager,widget,store,coordinator} │
   │     prinny         child · awaitingReply · typingRooms · deliveryTimer   │
   │     rtk-pi         (none — the gate is pure)                             │
   │     compaction-gd  spillDir (a mkdtemp, first use, bounded at 50)        │
   │     shell.ts       __PI_SUBAGENT_SPAWN_DEPTH__ on globalThis             │
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent(prompt, agent:"Explore", run_in_background?)
   ┌──────────────▼────────┐    ┌─────────────────────────────────────────────┐
   │ SpawnCoordinator      │───▶│ AgentManager                                │
   │  live view · spawnCtx │    │  SlotTable(1) · queue · Watchdog 45min      │
   │  FOREGROUND: awaits   │    │  parent signal: `.aborted` checked ✔ :328   │
   │    the completion gate│    │  stopAgent(running) = abortCtrl.abort()     │
   │  BACKGROUND: returns  │    └────────────────┬────────────────────────────┘
   │    now, nudges later  │                     │ runAgent()
   └───────────────────────┘                     │
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  THE BUILD WINDOW — seconds, and until AB4 nothing was listening         ┃
   ┃    enterSubagentSpawn()   depth > 0                                      ┃
   ┃    reloadAndMap()         EVERY extension factory runs again —           ┃
   ┃                           and rtk's shells out to `rtk --version` [AB3]  ┃
   ┃    createAgentSession()   → onSessionCreated  (the capture, W6)          ┃
   ┃    bindExtensions()       child session_start                            ┃
   ┃    resolveVisibleTools → setActiveToolsByName → rebuilds the child's     ┃
   ┃                           system prompt from the loader's override       ┃
   ┃    exitSubagentSpawn()                                                   ┃
   ┃    runTurnLoop: if (signal.aborted) throw ABORTED_BEFORE_START    [AB4]  ┃
   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                                 ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, in-memory SessionManager         │
   │    own system prompt · own tools · own window · own event bus            │
   │    forwardAbortSignal(session, signal)  ← listener; `.aborted` above     │
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
   │    rewrites record.result IN PLACE, so every reader sees one answer      │
   │    startDeadline composes verifyAbort with the timer            T5 AB4   │
   └──────────────────────────┬───────────────────────────────────────────────┘
                              │ .finally: release slot, tally, drain, open gate
              ┌───────────────┴────────────────┐
              ▼                                ▼
   ┌────────────────────────┐    ┌──────────────────────────────────────────┐
   │ FOREGROUND             │    │ BACKGROUND / CONTINUATION                │
   │  the completion gate   │    │  tallyCompletion → onComplete            │
   │  resolves the awaited  │    │   → coordinator.onAgentComplete          │
   │  promise               │    │   → scheduleNudge (200 ms batch)         │
   │        │               │    │   → emitIndividualNudge                  │
   │        ▼               │    │        capBackgroundResult(ctx …)  ← AC1 │
   │  formatResultContent   │    │        pi.sendMessage({subagent-result}, │
   │        │               │    │                       followUp, trigger) │
   │        ▼ ▶             │    │             │ ▶?                         │
   │  the Agent TOOL RESULT │    │             ▼                            │
   │  → compaction-guard's  │    │  entry point 2 — and a `void` return, so │
   │    tool_result cap     │    │  a failure here is a `catch` nobody reads │
   │  → THE PARENT MODEL    │    │  → THE PARENT MODEL                      │
   └────────────────────────┘    └──────────────────────────────────────────┘
        ▲ the ONE carrier in           ▲ AC1 lived here for two passes: the
          this stack that cannot         throw happened three lines before the
          silently drop an answer        send, and the catch said "Result
                                         available" to a no-op UI.

 ══════════════════════════════════════════════════════════════════════════════
  F.  A MATRIX EXCHANGE — the only path with a second human on it
 ══════════════════════════════════════════════════════════════════════════════

    Matrix room                    sidecar (child proc, MCP over stdio)
        │  message                        │
        └────────────────────────────────▶│ notifications/claude/channel
                                          ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ prinny-channel · deliverInbound                                        │
   │   awaitingReply.set(room, {at, live:false, answered:false, injected})  │
   │   armDeliverySweep()                                             AB2   │
   │   classifyMatrixCommand(body)  — a leading "/" is decided HERE         │
   │        ├─ refuse ─▶ reply(reason)              answered = true   AC4   │
   │        ├─ local  ─▶ THIS extension performs it  answered = true   AC5  │
   │        │            (/compact → uiCtx.compact({onComplete,onError}))   │
   │        ├─ run    ─▶ sendUserMessage(text, {expandPromptTemplates:true})│
   │        │            pi dispatches an EXTENSION command and RETURNS —   │
   │        │            no turn, no user message, so no markLive    answered│
   │        └─ text   ─▶ sendUserMessage(text, {deliverAs})           ▶?    │
   │                       └─▶ AgentSession.prompt(…)                       │
   │                             busy → _queueFollowUp (same run)           │
   │                             idle → a whole run                         │
   │                             THROWS → pi `.catch`es → emitError → NO    │
   │                             LISTENERS                          [AB2]   │
   └────────────────────────────────────────────────────────────────────────┘
        │
        │ pi echoes the user message back
        ▼
   message_end{role:"user"} ─▶ markLive(text) ── matched on the Matrix event
        │                       id. THE ROOM IS NOW ANSWERABLE, and not one
        │                       moment sooner, or the turn already in flight —
        │                       the operator's own work — is forwarded to
        │                       whoever just messaged.
        ▼
   agent_start ─▶ agentRunning = true ─▶ typing indicator, refreshed every 8s
        │          because Matrix expires it at 20 and a 27B thinks longer
        ▼
   message_end{assistant} ─▶ forward:"all" → each message as it finishes   ▶
   agent_end               ─▶ lastAssistantText · describeEmptyEnding      W1
   agent_settled           ─▶ stopTyping · forwardResult                   ▶
                                 forward:"result" → the closing text
                                 empty ending → a bounded continuation, then
                                                a giveUpMessage
                                 retire live rooms · alreadySent.clear()
                                 sweepUndelivered()                  AB2 AC4
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, a Matrix answer and the parent's next call are five things in one
queue. Every finding in this pass costs a place in that queue, or an answer that
never reaches it, or a sentence sent to somebody about neither.

---

## 2. The loop (`vendor/pi-loop-mode`)

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool, 2,969 lines. Its whole job is deciding what a turn's outcome *was* and then
getting one sentence to the model about it.

### 2.1 The thirteen handlers, and which entry point each one sees

`before_agent_start` is the one row that is not "every time the thing happens",
and that is AA1:

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

### 2.2 The goal check, in full, because AC3 is here and AC2 is one line below it

This is the only mechanism in the loop that consults something outside the model.
In `--until-done` mode `lastCheckPassed === true` is the **single** terminating
condition, and V3 added the `lastCheckPassed !== true` guard on `LOOP_DONE:`
precisely so that "the check decides" cannot degrade into "the model decides when
the check is broken".

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
          │      │        │                                 has NO code. The
          │      │        │                                 death is discarded
          │      │        │                                 here.        [AB1]
          │      │        └─ set ONLY inside killProcess(), whose two callers
          │      │           are options.timeout and options.signal. It means
          │      │           "pi killed this", not "this was killed".   [AB1]
          │      ▼
          │    wrapCheckCommand(cmd) =
          │        trap 'printf "\n<MARKER>:%d\n" "$?"' EXIT
          │        (
          │        <the operator's command>
          │        )
          │        ▲ the SUBSHELL is AC3. A bash EXIT trap is a slot, not a
          │          stack: a `trap … EXIT` inside the command REPLACES ours,
          │          and `exec` discards it. Inside `( … )` neither can reach
          │          the shell that prints the marker, and the exit status
          │          still propagates.
          │      ▼
          │    ┌─ result.killed              ─▶ execFailed  "did not finish
          │    │                                 within Ns and was killed"
          │    ├─ !readCheckCompletion(out).completed
          │    │                            ─▶ execFailed  "died before it
          │    │                                 finished — killed by a signal"
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

The five sentences the mechanism can produce, and which is which:

| what happened | `killed` | marker | verdict | what the operator is told |
| --- | --- | --- | --- | --- |
| exited 0 | false | present | passed | `Check status: passing` |
| exited non-zero | false | present | failed | `failing (streak N)` + the output, given to the model |
| pi's timeout | **true** | present | could-not-run | `did not finish within Ns and was killed` |
| SIGKILL / OOM | false | **absent** | could-not-run | `died before it finished — killed by a signal` |
| its own EXIT trap, or `exec` | false | present *(since AC3)* | its real answer | as if nothing had happened |
| SIGTERM from outside | false | present | *failed or passed* | **still not distinguishable — §10.4** |

The last row is the residue and it is stated rather than guarded: bash runs its
`EXIT` trap when SIGTERMed, so the marker is present and `$?` is whatever the last
command left. The marker is proof of *completion*, not of *intent*.

### 2.3 `agent_end` — the ladder

Twenty-one `return;` statements and a fall-through. Every arrow leaving the column
is a `return`.

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
   ├─ checkCommand → runGoalCheck → applyCheckOutcome         ← AB1 AC3
   │     ├─ execFailed × 3 ─▶ pauseForCheckFailure ────────────────────────▶ ✗
   │     └─ untilDone && passed && !execFailed ────────────────────────────▶ ✗
   ├─ /LOOP_DONE:/                                            ← AC2
   │     guarded by (lastCheckPassed !== true || checkErrorStreak > 0) ────▶ ✗
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
      ├─ compact   saturated || (streak >= 5 && >= 5 iterations since the last)
      │            ctx.compact({onComplete, onError})  ← both passed
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

### 2.6 The four ways a run restarts, side by side — which is AC2's whole subject

This table did not exist before this pass, and drawing it is what found AC2.
Every column is a way the loop goes from "not running" to "running", and the rows
are what each one does with the state the previous run left.

```
                          /loop start   /loop run    /loop resume   session_start
                          (applyGoal-   (runLoop)    (the resume    auto-resume
                           Config)                    branch)       (a restart)
   ───────────────────────────────────────────────────────────────────────────────
   description/criteria    REPLACED     kept         kept           kept
   iterationCount          0            0            kept           kept
   the 3 repetition        cleared      cleared      KEPT           kept
     windows
   consecutiveStuckCount   0            0            0              kept
   consecutiveErrorCount   0            0            0              kept
   providerErrorStreak     0            0            0        ←U    kept
   penaltyTurnsRemaining   0            0            0        ←U    kept
   contextCooldownCount    0            0            KEPT           kept
   ───────────────────────────────────────────────────────────────────────────────
   lastCheckPassed         undefined    undefined ←V KEPT     ←AC2   kept
   lastCheckScore/best     undefined    undefined ←V KEPT           kept
   checkFailStreak         0            0         ←V KEPT           kept
   checkErrorStreak        0            0         ←V 0        ←AC2   kept
   lastCheckError          ""           ""        ←V ""       ←AC2   kept
   ───────────────────────────────────────────────────────────────────────────────
     ←V  added by V3 (sixth pass)      ←U  added by the eighth pass
     ←AC2 this pass
```

The rule the table makes visible: **`resume` may keep anything that describes the
run, and must not keep anything that describes a decision the run has already
acted on.** `providerErrorStreak` and `penaltyTurnsRemaining` were moved across
that line by an earlier pass with the reason written next to them; the check's two
equivalents were not, and §9's AC2 is what that cost.

---

## 3. Subagents (`vendor/pi-subagents-lite`)

64 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
`/agents` menu, a slot table, a watchdog, a spawn coordinator that owns delivery.

### 3.1 A record's life, with the delivery points marked

```
  spawn()          status queued|running · gate created · brief := prompt
    │              parent signal: `.aborted` tested FIRST, then a listener  ✔
    ▼
  startAgent()     slot reserved · watchdog started · started := true
    │              record.execution.abortController created
    ▼
  runAgent()       build window (AB4) → runSessionPrompt → runTurnLoop
    │                forwardAbortSignal(session, signal)
    │                if (signal.aborted) throw ABORTED_BEFORE_START   ← AB4
    ▼
  .then            status ← classifyRun(result)   TERMINAL FROM HERE
    │              …unless it is already "stopped", which is preserved
    │              result := responseText                            ← Z1
    │              runVerification()   ← the record's SECOND run
    ▼
  .finally         settlementCount++ · outputLog finalised · slot released
                   tallyCompletion ──▶ notifyComplete ──▶ onComplete
                   │                                        │
                   │                                        ▼
                   │                     SpawnCoordinator.onAgentComplete
                   │                       background first settlement? nudge
                   │                       settlementCount >= 2?        nudge
                   │                         └─▶ scheduleNudge (200 ms batch)
                   │                               └─▶ emitIndividualNudge  AC1
                   drainQueue · gate opened · settled := true
                                  │
                                  ▼
                    the FOREGROUND Agent tool call unblocks here
```

The **completion gate** is the invariant worth knowing: every record carries a
promise from birth, opened exactly once, never assigned the run's own promise.
Seven paths open it, so a foreground `Agent` call can never hang on a record that
will not settle. Note what that means for AC1, and it is the reason AC1 survived
two passes: the gate is a *different mechanism* from the nudge. The foreground
path was never broken.

### 3.2 The turn ceiling, and what `stopAgent` can actually reach

```
   normalizeMaxTurns(n): 0 → unbounded · absent → 40 · else max(1, n)

   turn_end, turnCount++
        ├── maxTurns == null ─────────────────────────────▶ nothing, ever
        ├── !ceilingReached && turnCount >= maxTurns
        │      graceTurns <= 0 → abort   ·  > 0 → wrap-up steer      V6 W4 T1
        │      …and NEITHER for maxTurns === 1, which reaches its ceiling by
        │      FINISHING — `shouldSteerAtSoftLimit(1)` is false, and
        │      `turnLimited` follows the steer rather than the ceiling
        └── ceilingReached && turnCount >= maxTurns + graceTurns → abort

   stopAgent(record)
        verifying?  → verifyAbort.abort()        the T5 path
        queued?     → spliced out of the queue
        running?    → record.execution.abortController.abort()   ← and NOTHING
                      else, which is why AB4 was a stop that did not stop
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

### 4.3 What the verifier delivers, and to whom

Worth stating in this pass's terms, because the verifier is the one component
whose entire output is a *modification of somebody else's delivery*:

```
   record.result  ← rewritten IN PLACE, deliberately. There is no second copy
                    of the original: two answers in the tree is how a parent
                    ends up quoting the one that failed.
   record.verification  ← the badge (`✓ checked`, `✎ repaired`, `✗ off-task`,
                    `⊘ skipped`, `? errored`). UI ONLY — the model never sees it.
   the note       ← appended to the answer text only when something went wrong,
                    because a note there is text the parent model reads and
                    quotes.

   So: the verifier has no carrier of its own. It edits the payload of whichever
   carrier is already taking the answer home — the Agent tool result, or the
   coordinator's nudge. When that carrier drops the parcel (AC1), a verified,
   repaired, re-judged answer is dropped with it, and the verifier's own model
   calls were spent for nothing.
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
 │     Why: pi's own update prompt says "PRESERVE all existing information",    │
 │     so the summary is monotonic by construction. Measured over 42 real       │
 │     compaction points: 456 / 4,029 / 11,054 chars, only ever up.             │
 │     NOTE: when `pi-loop-mode` returns a `{compaction}` for the same event    │
 │     (last truthy wins, and the loop is the only one that returns one), pi    │
 │     never reads `previousSummary` at all — the loop's handoff builds its     │
 │     summary from LoopState instead. The guard's notify says what it DID,     │
 │     not what pi will do with it.                                             │
 │                                                                              │
 │  2. tool_result ────────── bound what ARRIVES                                │
 │     allowance = 10% of the REMAINING window × 4, clamped [1.5k, 20k]         │
 │     head 70% / tail 30%, cut at a line boundary when one is close            │
 │     overflow → mkdtemp()/pi-tool-output-*/<tool>-<callId>.txt                │
 │     …bounded at 50 files, oldest first, pruned AFTER the write so the        │
 │     newest can never be the one removed (a count, not a teardown: spillDir   │
 │     is module-global and a CHILD shares it)                                  │
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

## 6. `prinny-channel`

Seven handlers, one command with seventeen subcommands, one tool with six
actions, and a child process. It is the only part of this stack whose failures
are visible to somebody who is not the operator. AC4 and AC5 are here.

### 6.1 The shape, and why the sidecar is a process

```
   Matrix  ⇄  sidecar (child process, MCP over stdio)  ⇄  this extension  ⇄  pi
```

`@prinny/bot` pulls in matrix-js-sdk and its Rust crypto WASM: loading it is ~15
seconds of **synchronous** work, which in-process would freeze pi's TUI solid, and
the same library writes to stdout while it loads, which in-process would scribble
over the interface pi is drawing. Out of process, both are the child's problem —
its stdout is a pipe carrying JSON-RPC and its stderr goes to a log file.

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
which no retry, compaction or queued continuation is still to come.

**`message_end` with `role: "user"` is what makes a room answerable.** Not
arrival. A Matrix message can land while pi is mid-turn on something the operator
asked for in the terminal; it is queued, correctly, as a follow-up — but the room
went into `awaitingReply` the moment it arrived, so the *current* turn's answer,
about the operator's private local work, would be forwarded to whoever just
messaged. So eligibility is tied to evidence: the room goes live when its own
block comes back as a user message, matched on the Matrix event id.

That evidence is what AB2 reads backwards, and reading it backwards is what AC4
is about: **an absence of evidence is only evidence of absence for a message that
was actually handed over.**

### 6.3 What happens to a message with a leading slash — the whole decision

```
   classifyMatrixCommand(body)                          src/command-routing.ts
     not a string / no leading "/" / multi-line          ─▶ text
     not in KNOWN_COMMANDS                               ─▶ text
        ▲ "/usr/bin/foo is broken" is a sentence, and refusing it would be noise
     in MATRIX_LOCAL                                     ─▶ local     ← AC5
        ▲ commands pi CANNOT dispatch, performed by this extension:
          today exactly one, /compact
     not in MATRIX_ALLOWED                               ─▶ refuse
     a REFUSED_FLAG in the arguments (--model)           ─▶ refuse
     an argument outside the allowed set                 ─▶ refuse
     else                                                ─▶ run
        ▲ handed to pi with expandPromptTemplates: true, which is the ONE call
          in the file that turns Matrix input into harness control

   and what each kind does to the awaitingReply entry:

     text     sendUserMessage(…, {deliverAs})   live ← when pi echoes it back
     run      sendUserMessage(…, {expand:true}) answered := true, NEVER live
                ▲ pi dispatches the command and RETURNS before any turn, so
                  there is no user message to echo. AC4.
     local    performed here                    answered := true, NEVER live
     refuse   reply(reason)                     answered := true, NEVER live
                ▲ deliberately not delivered to the model either: "a refused
                  command must not arrive as text for the model to be talked
                  into running some other way"
```

### 6.4 Forwarding, and the five ways it declines

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

   forwardResult()  at agent_settled
     ├─ forward:"result" → forwardToMatrix(lastAssistantText)
     ├─ lastRunEmptyEnding.empty
     │     ├─ shouldRetryEmptyTurn → ONE bounded continuation
     │     └─ else giveUpMessage(detail) to every waiting room
     ├─ unanswered && forward:"off" → tell the operator
     ├─ retire every LIVE room (never a queued one — its answer is still coming)
     └─ sweepUndelivered()                                        AB2 · AC4
```

### 6.5 The undelivered sweep, which is AB2's fix and AC4's subject

```
   undeliveredRooms(entries, now, agentRunning, grace = 60s)
     agentRunning                    ─▶ [] — a queued message drains inside the
                                       same run, so idleness removes the whole
                                       "it was just busy" class
     entry.answered                  ─▶ skip  ← AC4: this extension already
                                       dealt with it; pi was never asked
     entry.live                      ─▶ skip  — pi took it
     entry.undeliveredReported       ─▶ skip  — said once, not every 30 s
     now - entry.at < grace          ─▶ skip  — prompt() awaits _checkCompaction
                                       BEFORE starting a run, so an idle session
                                       can hold a message with nothing running
     else                            ─▶ REPORT, and leave the entry in place, so
                                       a late delivery still reaches markLive
```

### 6.6 The typing indicator, the command surface, and the relay

Matrix expires a typing indicator on its own timeout — 20 seconds by default —
and a local 27B routinely thinks for longer, so it is refreshed every 8 s from an
unref'd interval, driven by the turn lifecycle and *reconciled* rather than
toggled: `roomsAwaitingAnswer()` is `agentRunning && entry.live`, and `planTyping`
diffs that against the rooms currently told.

`/prinny` has seventeen subcommands and the tool has six actions behind one
`action` string. Both shapes are measurements: six separate `prinny_*` tools cost
4,574 chars (~1,144 tokens) of schema on **every turn**; folding them behind one
action string spends ~200. Access management is a command rather than a skill
because a mis-edited allowlist is a security failure and a 27B should not be the
thing standing between a public Matrix ID and a shell.

The permission relay is off by default and **fails closed**: channel down, not
logged in, notify threw, or nobody answered in 300 s all return
`{approved:false}`. `requestApproval` cannot throw — every path returns a
decision — which matters because `emitToolCall` has **no try/catch around
handlers** and pi rethrows a handler's error as "Extension failed, blocking
execution".

---

## 7. `rtk-pi`

108 lines of coupling, 146 lines of gate, one handler, no tools, no commands.

`CTX_SIZE=32768`. Bash output is not billed on this stack, it is **rented** —
every byte of `pytest` chatter is a byte that is not the file the model was asked
to read. `rtk` rewrites a command into a shorter-output equivalent, and the fork's
entire content is a refusal to trust it by default.

```
  measured in this repo, 2026-08-16, against rtk 0.45.0
  ────────────────────────────────────────────────────────────────────
  git status              275 B →   49 B    82%   ALLOWED
  pytest -q (43 tests)  1,312 B →  476 B    64%   ALLOWED
  find vendor -name…    1,718 B →  773 B    55%   ALLOWED
  git diff HEAD~1       2,384 B → 2,213 B    7%   ALLOWED (verified faithful)
  ls -la                1,125 B →  348 B    69%   denied — see below
  ls -1                   123 B →  242 B   -97%   denied — it grows
  cat README.md        67,652 B → 67,652 B   0%   denied — on principle
  ────────────────────────────────────────────────────────────────────

   shouldFilter(cmd)                                       src/gate.ts
     ├─ "" · starts with "rtk " ─▶ false
     ├─ COMPOUND  /[|<>;&`\n]|\$\(/  ─▶ false
     │     a pipe or a redirect means the output is going to a parser or a
     │     file, where being shorter is being WRONG
     ├─ PREFIXED  ^(VAR=|sudo|env|time|timeout|nohup|xargs|nice|uv|npx|pnpm|
     │            yarn|poetry|pdm|hatch|bundle|rye)\b   ─▶ false
     │     rtk strips these before matching its own rules, so the thing that
     │     gets rewritten is not the thing that was measured
     └─ isAllowed(trimmed) — token-boundary prefix match against 23 entries

   the handler: fail open, always. `event.input.command = rewritten` is the
   sanctioned mechanism — pi's own `ToolCallEventResult` documents it, and the
   reference chain (`args` → `event.input` → `prepared.args`) supports it.
   Both `pi.exec` call sites test `result.killed` before `result.code`   AB3
```

---

## 8. The delivery ledger

This is the pass's mechanical contribution and the thing that found AC1, AC4 and
AC5. For every ANSWER this stack produces — anything a reader is waiting for —
the carrier, the reader, and **what the reader sees when the carrier drops it**.

Legend: ✔ the failure is visible to somebody · ⚠ visible only to the operator, and
only in a TUI · ✘ invisible to everyone.

```
 what is delivered            carrier                       reader        failure
 ══════════════════════════════════════════════════════════════════════════════════
 a foreground subagent's      the Agent TOOL RESULT          the parent    ✔
 answer                       (formatResultContent →         model
                              executeAgentTool → pi)
   The only carrier here that cannot silently drop an answer: the tool call is
   awaited, and the completion gate has seven openers so it cannot hang. Even the
   pathological case (Y1: clear a record mid-verification) delivers "" rather
   than nothing.

 a BACKGROUND subagent's      pi.sendMessage({subagent-       the parent    ✘ AC1
 answer, and every            result}, followUp,              model
 continuation's               triggerTurn) — via the
                              coordinator's nudge
   `sendMessage` returns void; the nudge body is wrapped in a try/catch whose
   fallback is `ctx.ui.notify`, and `noOpUIContext.notify` is `() => {}`. So a
   throw anywhere in that body loses the answer AND the report. This is where a
   ReferenceError sat for two passes.

 the verifier's verdict       (none — it rewrites            whoever is    ✘
                              record.result in place)        carrying the
                                                             answer
   No carrier of its own, so it inherits the failure mode of whichever one is
   taking the answer home. §4.3.

 a loop TURN                  pi.sendMessage({loop-turn},    the model     ⚠
                              triggerTurn / deliverAs)
   Void return. A failure would be `emitError` → an empty listener set. What
   makes this survivable is that the loop re-derives its own state every
   `agent_end`, so a lost turn shows up as a run that stopped advancing rather
   than as a wrong answer — which is exactly the symptom F1 was reported as.

 a loop NOTICE                ctx.ui.notify + (hasUI ===     the operator  ✔
                              false) .pi-loop-log.jsonl
   The tenth pass's fix: `noOpUIContext.notify` is a no-op, so an unattended
   run's entire narrative went nowhere. Now the log is the complete account.

 the loop's RULES for an      before_agent_start → a         the model     ✔
 operator-typed turn          role:"custom" message
   AA1. Reaches exactly one entry point, which is the one it is for.

 the check's VERDICT          LoopState, across turns and    the loop's    ✘ AC2
                              across RUNS                    own ladder
   Nothing carries this anywhere; it simply persists. The question surface 6
   asks of it is therefore "who reads it NEXT, and is that still the run that
   earned it" — which is AC2.

 the check's COMPLETION       a marker printed by the        runGoalCheck  ✘ AC3
                              child, through stdout
   The one delivery in this stack whose carrier is the payload itself. Which is
   why the payload can take it: a `trap … EXIT` in the check command replaces
   the one printing the marker.

 an inbound Matrix message    api.sendUserMessage →          the model     ✘ AB2
                              AgentSession.prompt()                        → ✔
   Void return, pi `.catch`es the rejection into `emitError`, and no error event
   exists for an extension to subscribe to. The sweep reconstructs the receipt
   from `markLive`'s absence — and AC4 is that reconstruction being wrong for
   the messages that were never handed over.

 an outbound Matrix answer    child.callTool('reply')        the sender    ✔
   A real request/response over MCP; a rejection is caught and logged.

 a Matrix COMMAND             classifyMatrixCommand →        the sender    ✘ AC5
                              sendUserMessage(expand:true)   and pi
   "Ran `X`" was sent on the strength of having CALLED the function, not of
   anything having happened. pi dispatches extension commands only.

 a tool result's SIZE         return {content} from          the model     ✔
                              tool_result
   Threaded and merged by pi into one shared event object; the guard's cap is
   the last writer and pi applies it.

 a bash command's REWRITE     event.input.command mutated    the tool      ✔
                              in place
   pi documents the mutation as the mechanism, and `prepareToolCall` executes
   the same object.

 the model's own CONTEXT      return {messages} from         the provider  ✔
 budget notice                the `context` event
   pi `structuredClone`s the array before the event, so nothing added here can
   reach the session; the return value is what counts.
 ══════════════════════════════════════════════════════════════════════════════════
```

**Fourteen carriers. Eleven of them are `void`, fire-and-forget, or a `catch`.**
That is pi's design and it is mostly right — an extension that could break a turn
by failing to send a status line would be worse. But it means the sentence "the
answer was sent" is true in eleven places where "the answer arrived" is unknown,
and the four findings in this pass that are about deliveries all live in that gap.

### 8.1 The six surfaces, run over the two carriers this pass changed

```
   ┌─ 1. what we RETURN from a handler ─────────────────────────────────────┐
   │    coordinator: nothing — it is not a handler, it is a callback from   │
   │      the settlement chain. Its return value is discarded by design. ✔  │
   │    prinny inbound: nothing. `deliverInbound` is called from a          │
   │      notification handler on the sidecar's stdio pipe.              ✔  │
   ├─ 2. what we PASS to a call ────────────────────────────────────────────┤
   │    coordinator: `deliverAs:"followUp"`, honoured on the streaming      │
   │      branch and discarded on the idle one — AA4, and correct.       ✔  │
   │    prinny: `expandPromptTemplates:true` on the command branch only. ✔  │
   ├─ 3. which events REACH us at all ──────────────────────────────────────┤
   │    coordinator: `onComplete` fires from `tallyCompletion`, which is in │
   │      the settlement chain's `.finally` — every settlement, always.  ✔  │
   │    prinny: seven handlers, seven unconditional emit sites.          ✔  │
   ├─ 4. what a host function's answer CAN say ─────────────────────────────┤
   │    both: `sendMessage`/`sendUserMessage` return void and CANNOT say    │
   │      they failed.                                                 ✘ AB2│
   ├─ 5. WHEN it can say it ────────────────────────────────────────────────┤
   │    both: never — the rejection is consumed by pi's own `.catch`.  ✘ AB2│
   ├─ 6. WHO RECEIVES IT, and what they see when nobody does ───────────────┤
   │    coordinator: the parent model receives nothing and is told nothing; │
   │      the operator gets one UI line that says the wrong thing, in a     │
   │      method that is a no-op headless.                             ✘ AC1│
   │    prinny: the sender receives a correction about a message that was   │
   │      never in trouble.                                            ✘ AC4│
   └────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Findings

Severity is about what it costs a real run. Evidence is **PROVEN** (an executable
probe drives the shipped module or pi's real implementation), **MEASURED** (a
number taken from the tree or from pi), or **SOURCE** (read, with the reasoning in
the finding).

| # | Finding | Sev | Evidence | Probe | Sibling of | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AC1 | AA4's edit deleted `const ctx = getSessionCtx()` with the ternary that used it and left three readers below it, so `emitIndividualNudge` throws `ReferenceError` before `pi.sendMessage`. Every background subagent's answer, and every continuation's, stopped reaching the parent model — reported through a `catch` written for another failure, into a UI method that is a no-op headless | **HIGH** | PROVEN·SOURCE | `p1` | W1, AA4 | ✔ fixed |
| AC2 | `/loop resume` carries `lastCheckPassed` and `checkErrorStreak` from the run that ended, so a resumed `--until-done` run completes on the first `LOOP_DONE:` without the check passing, and a resume after `pauseForCheckFailure` re-pauses at "(4/3)" | **MEDIUM** | PROVEN·MEASURED | `p2` | V3, AB1, AA2 | ✔ fixed |
| AC3 | A bash `EXIT` trap is a slot: a check that sets its own, or `exec`s, removes AB1's completion marker — so a check that ran perfectly reads as one a signal killed, and three pause an unattended run | **MEDIUM** | PROVEN·MEASURED | `p3` | AB1 | ✔ fixed |
| AC4 | AB2's sweep reports an entry that is not live, and a refused or executed Matrix command is never live by construction — so the sender was told a message that had been answered could not be delivered | **MEDIUM** | PROVEN | `p4` | AB2 | ✔ fixed |
| AC5 | `/compact` was allow-listed and advertised, and `AgentSession.prompt()` dispatches EXTENSION commands only; from Matrix it became a model turn on the literal text `/compact` while the sender was told it had run | **MEDIUM** | PROVEN·SOURCE | `p4` | AA1 | ✔ fixed |

---

### AC1 — the answer that was produced and never left the building · **HIGH** · PROVEN·SOURCE · **FIXED**

**Where.** `emitIndividualNudge` in
`vendor/pi-subagents-lite/src/spawn/spawn-coordinator.ts`.

**What.** The tenth pass (AA4) established that the background result's delivery
mode was not a choice pi could honour, and replaced this:

```js
      const ctx = getSessionCtx();
      const parentIdle = ctx?.isIdle?.() ?? true;
      const deliverAs = parentIdle ? "followUp" : "steer";
```

with this:

```js
      const deliverAs = "followUp" as const;
```

That reasoning is correct, the behaviour it chose is the right one, and the test
that pins it passes. But three lines further down, in code AA4 was not about,
`ctx` is still read — twice by a `notify` and once as an argument:

```js
      const capped = capBackgroundResult(formatResultContent(record), ctx, …);
      if (capped.applied && ctx?.ui?.notify) { ctx.ui.notify(…) }
```

`ctx` is now a free variable. **Nothing in this stack would say so.** The package's
`npm run lint` is `for file in …; do node --check "$file"; done` — a syntax check.
pi loads `.ts` through `jiti`, which strips types without checking them. There is
no `tsc` in the tree and no `typescript` in pi's dependencies. So it shipped, and
the very first use throws:

```
   ReferenceError: ctx is not defined
```

thrown at the `capBackgroundResult` line — **three lines before `pi.sendMessage`**
— inside the `try` that wraps the whole body. And the `catch`:

```js
    } catch (error) {
      // sendMessage failed (shared runtime overwritten by subagent bindCore).
      const spawnCtx = record.execution.spawnCtx;
      if (spawnCtx?.ui?.notify) {
        spawnCtx.ui.notify(`[Subagent "…" completed] Result available`, "info");
      }
    }
```

says nothing about the error, describes a *different* failure so exactly that a
reader stops there, and reports through `ctx.ui.notify` — which is
`noOpUIContext.notify`, `() => {}`, in every non-TUI mode (`runner.js:88`).

**What it costs.** `onAgentComplete` nudges on two conditions:

```js
    if (this.backgroundAgentIds.delete(record.id) || record.execution.settlementCount >= 2)
```

so the broken path is **every background delegation's first settlement** and
**every continuation's settlement for any agent** — steering a settled subagent
from the conversation viewer, and the `/agents` "continue" action. In each case:

- the parent model receives nothing at all — no result, no error, no mention;
- the verifier's judge and up to three repair rounds were spent on an answer
  nobody reads;
- `capBackgroundResult` never runs, so the 25k-character bound on a background
  result has been dead for the same two passes;
- in a TUI the operator sees one dim line saying the result is "available";
- headless — `pi -p`, a cron run, an unattended `/loop` — there is **nothing**.

The foreground path is untouched, which is the whole reason it survived: a
foreground `Agent` call awaits the completion gate, which is a different
mechanism, and returns the answer as a tool result. Every hand test in
`context/testing/subagents-loop-verifier.md` except §B is a foreground test.

**Proved.** `p1`, which writes a copy of the shipped file with the binding taken
back out, loads it through pi's own bundled `jiti`, and runs the function:

```
   BEFORE   messages injected : 0
            operator told     : [Subagent "general-purpose" completed] Result available
   NOW      messages injected : 1
            delivery options  : {"deliverAs":"followUp","triggerTurn":true}
            content           : [Subagent "general-purpose" agent-01 completed]
                                src/parser.ts exports parse() and tokenize().
   NOW      a 60,000-char answer at 90% context arrives as 1,549 chars, and the
            cap says so — the other thing the binding switched off
```

**The fix.** Restore the binding, at call time rather than at spawn time, for the
same reason `getPiInstance()` is read at call time (a reload replaces both). And
make the catch say what happened: the reason is interpolated into the message, the
level is `warning` rather than `info`, the sentence now says the result was **not**
delivered and names `AgentStatus` as the way to read it, and a `console.warn` runs
whether or not there is a UI, because a delivery that did not happen is the
loudest thing this class can report and it must not also be the quietest.

**Why 832 tests and 51 probes missed it, which is the part worth keeping.** The
test that guards AA4 is `tests/background-delivery.test.ts`, and it reads the file
as **text**:

```js
    const code = codeOf(fileURLToPath(new URL("../src/spawn/spawn-coordinator.ts", …)));
    const ternary = /deliverAs\s*=\s*[^;]*\bisIdle\b|deliverAs\s*=\s*parentIdle\s*\?/;
    assert.equal(ternary.test(code), false, …);
    assert.match(code, /const deliverAs = "followUp"/, …);
```

Both assertions are true of the broken tree. Its own header explains the choice —
*"`spawn-coordinator.ts` imports `../shell.js`, which imports pi, so this suite
cannot load it"* — and that sentence is true and was never re-examined, even
though `h6`, `l6`, `m1` and `m2` all load pi-importing modules through pi's
bundled `jiti`, and one of them (`l6`) drives the real `AgentManager` through the
real completion gate. The instrument existed; the test took the cheaper form.

So the rule this pass adds to the series, and it is §14's headline: **a fix whose
test cannot execute the function it changed is pinned against editing, not against
breaking.** A source pin catches a revert. It cannot catch a deletion three lines
away, a rename, a typo, or a refactor that keeps the matched text.

A file-level check would not have found it either, and it is worth saying why: the
name `ctx` IS bound in that file — it is the second parameter of `spawn()`, forty
lines up. Only a *scope-aware* reader can see the difference, which is a
typechecker or an execution. This pass tried the cheap version (a free-variable
sweep over all five packages, in the scratch, with a whitelist of globals) and it
reported this file as clean, for exactly that reason.

*Tests:* `vendor/pi-subagents-lite/tests/background-delivery.test.ts`, a new `AC1`
describe with four cases that construct the real coordinator through `jiti` and
call the real method, **three of which fail without the fix**.

---

### AC2 — a verdict that outlived the run that earned it · **MEDIUM** · PROVEN·MEASURED · **FIXED**

**Where.** the `resume` branch of `loopCommand`, and the `LOOP_DONE` branch of
`agent_end`, both in `vendor/pi-loop-mode/extensions/index.ts`.

**What.** V3 (sixth pass) gave `/loop run` a `resetCheckState()` because a verdict
from a finished run was deciding things in a new one, and deliberately left
`/loop resume` alone on a reason that is right as far as it goes: **a resumed run
IS the same run.** §2.6's table is what happens when that rule is applied to five
fields at once, and two of them are not "state of this run" at all.

**Half one — the verdict.** In `--until-done`, `lastCheckPassed = true` can exist
for as long as it takes `agent_end` to reach the next branch, because the
completion branch fires on the same condition:

```js
      if (state.untilDone && outcome.passed && !outcome.execFailed) { …COMPLETED }
```

So the only way to observe a stale `true` is to resume a run that already
finished — and `/loop resume` neither refuses that nor resets anything. Then, if
the check is now unrunnable (AB1's case: an OOM kill, a container restart, a
missing binary), `applyCheckOutcome` leaves the verdict at its last real value,
which is `true`, and the guard:

```js
      if (state.checkCommand && state.lastCheckPassed !== true) { …keep going… }
```

— the guard added precisely so that *"the check decides" cannot mean "the model
decides when the check is broken"* — lets the very first `LOOP_DONE:` through.

Measured against the shipped module (`p2 verdict`), the whole thing in one
status readout:

```
   BEFORE  Loop: goal check could not run (1/3): the check process died before it
           finished — killed by a signal …
           Loop completed: ship it
             Active: false
             Status: completed
             Check status: passing — LAST KNOWN; the check has not run for 1/3 turns

   NOW     Loop: LOOP_DONE claimed, but the goal check could not be run —
           continuing, and asking for the check to be fixed.
             Active: true
             Status: running
```

`Status: completed` and `the check has not run` are printed by the same command,
four lines apart.

**Half two — the streak.** `pauseForCheckFailure` stops the run at
`MAX_CHECK_ERRORS` and its notice ends *"Fix or change the check, then /loop
resume."* The count that stopped the operator was handed straight back, so the
next check that failed to run was the **fourth** in a row and re-paused the run at
once:

```
   BEFORE  turn 4: Loop: goal check could not run (4/3): …
             Status: paused
   NOW     turn 4: Loop: goal check could not run (1/3): …
             Status: running
```

"(4/3)" — a counter past its own maximum — is the tell, and it is printed to the
operator. The resume branch already clears `providerErrorStreak` for exactly this
reason, with the reason written next to it (*"a resume after
`pauseForProviderFailure` re-pauses on the very first error — the operator's 'I
fixed the server, carry on' would be answered by the count that stopped it"*).
The check's equivalent was left out of that fix.

**The fix, in two lines and one condition.** `resume` clears `checkErrorStreak`
and `lastCheckError` — and **not** the verdict fields, because "LAST KNOWN" is the
honest reading for a run that is genuinely continuing. And the `LOOP_DONE` guard
gains the second half of its own sentence:

```js
      if (state.checkCommand && (state.lastCheckPassed !== true || state.checkErrorStreak > 0))
```

`checkErrorStreak > 0` means "the verdict you are about to trust is LAST KNOWN,
not current". That covers the resume case and every other route to a stale `true`
at once, including any future one, which a `resetCheckState()` on resume would not
have — and it leaves `/loop resume` meaning what it says.

*Tests:* `vendor/pi-loop-mode/tests/check-that-cannot-run.test.ts`, a new `AC2`
describe with five cases, **three of which fail without the fix**; the other two
are controls (a check that really passes still completes a resumed run, and
`/loop run` still resets the whole state, which is V3).

---

### AC3 — the receipt the payload can take · **MEDIUM** · PROVEN·MEASURED · **FIXED**

**Where.** `wrapCheckCommand` in `vendor/pi-loop-mode/src/goal-check.ts`.

**What.** AB1's mechanism is the only one in this stack whose carrier is the
payload itself: pi cannot say whether a check process finished, so the check is
run under a bash `EXIT` trap that prints a marker, and the marker's absence is
read as "it died". The eleventh pass wrote it as:

```
   trap 'printf "\n<MARKER>:%d\n" "$?"' EXIT
   <the operator's command>
```

A bash `EXIT` trap is a **slot, not a stack**. `trap … EXIT` inside the command
replaces the one printing the marker, and `exec` discards traps altogether. Both
are ordinary things a check does, and both produce a marker-less run that had
finished perfectly — which the loop reads as:

> the check process died before it finished — killed by a signal rather than by
> its own exit (an out-of-memory kill looks like this)

`trap 'docker compose down' EXIT; docker compose run tests` is the shape of every
cleanup one-liner. And `/loop prepare` exists to have a strong model **write the
check script**.

**What it costs.** The opposite direction from AB1, and not obviously better: AB1
completed a run that should have continued; this pauses a run that should have
continued. `execFailed` × 3 is `pauseForCheckFailure`, so an unattended run with a
perfectly good check stops after three iterations, blaming the OOM killer. And in
between, `--until-done` has no terminating condition at all, because the check
never registers a pass.

**Proved.** `p3`, against pi's real `execCommand`, with both wrappers built and
run for each case:

```
  case                                   BEFORE          NOW             expected
  ------------------------------------------------------------------------------
  a check that passes                    passed          passed          passed
  a check that fails                     failed          failed          failed
  a check with its OWN EXIT trap         COULD-NOT-RUN   passed          passed  ←
  …and one that fails under its trap     COULD-NOT-RUN   failed          failed  ←
  a check that execs                     COULD-NOT-RUN   passed          passed  ←
  an OOM kill — the case AB1 is FOR      COULD-NOT-RUN   COULD-NOT-RUN   ok
  a check that prints a SCORE            passed          passed          passed
  a multi-line check                     passed          passed          passed
  a syntax error                         failed          failed          failed
```

**The fix.** The operator's command runs in a subshell:

```
   trap 'printf "\n<MARKER>:%d\n" "$?"' EXIT
   (
   <the operator's command>
   )
```

A trap set inside `( … )` belongs to the subshell; `exec` replaces the subshell
rather than the shell holding the marker; and the subshell's exit status
propagates, so `result.code` is still the check's answer, the `SCORE:` line is
still parsed, multi-line commands are unchanged, and a SIGKILL still leaves no
marker. The one observable difference is the line number in a syntax error
message (2 → 3); the message is identical and a broken check is still broken.

**What is deliberately still not distinguished:** SIGTERM from outside. bash runs
its `EXIT` trap when SIGTERMed, so the marker is present and `$?` is whatever the
last command left. Trapping `TERM`/`HUP`/`INT` and exiting `128+n` would catch it
and would then misread a check that genuinely exits 143 — the same guess this
stack declined to make about exit code 127. SIGKILL is the case that matters (it
is what the OOM killer sends) and it is caught unambiguously.

*Tests:* the same file, a new `AC3` describe with six cases run through **real
bash** rather than a stub — the fact under test is bash's trap semantics, and a
stub of it would be the thing being questioned — **four of which fail without the
fix** (three new, plus the existing assertion on the wrapper's shape).

---

### AC4 — a delivery report about something that was never a delivery · **MEDIUM** · PROVEN · **FIXED**

**Where.** `undeliveredRooms` in `vendor/prinny-channel/src/delivery.ts`, against
`deliverInbound`'s command branches.

**What.** AB2's rule is an inference: `markLive` fires when pi echoes a message
back as a user message, so an entry that is still not live once the session is
idle and past a minute's grace was one pi never took. Sound — for a message that
was **handed to pi**. Two paths never hand one over:

```
   refuse   /model gpt from Matrix. The sender is sent the refusal, and the text
            is deliberately NOT delivered to the model either ("a refused command
            must not arrive as text for the model to be talked into running some
            other way"). `answered = true`, `live` false forever.

   run      /loop status from Matrix. It IS executed — by pi's own command
            dispatch, which returns at `agent-session.js:800` before any turn. No
            user message, so nothing to echo, so `markLive` can never fire.
            `answered = true`, `live` false forever.
```

Both leave an entry that is identical, in every field the sweep reads, to a
message pi refused. So a minute later the sender got:

> I could not hand that to the session — it would not accept a new message just
> then (it may have been compacting, or the model may be unavailable). Nothing
> was lost on my side; please send it again.

about a message that had already been answered — and, for the `run` case,
immediately after being told "Ran `/loop status`. Its output stays in the
terminal." Re-sending, as invited, produces the same pair of messages again.

§O of the hand-testing script names this exact risk in its fourth control: *"A
false positive here is worse than the bug — it tells somebody their message was
lost when it was about to be answered."* Silence is ambiguous; a wrong apology is
a claim.

**Proved.** `p4`, over the real rule:

```
   entry                                BEFORE     NOW
   ----------------------------------------------------------
   a refused command (/model)          REPORTED   quiet      ←
   an allowed command (/loop status)   REPORTED   quiet      ←
   a local command (/compact)          REPORTED   quiet      ←
   a plain message pi never took       REPORTED   REPORTED
   control — still inside the grace    quiet      quiet
   control — pi took it                quiet      quiet
   control — already reported once     quiet      quiet
```

**The fix.** `DeliveryEntry` gains `answered`, and the sweep asks that question
first, because it is the one that makes the others meaningful: *an entry this
extension resolved itself was never handed to pi, so pi not having taken it is not
evidence of anything.* The flag already existed and was already set on all three
branches; it simply was not one of the questions the rule asked.

*Tests:* `vendor/prinny-channel/tests/delivery.test.ts`, a new `AC4` describe with
four cases, **two of which fail without the fix**; one control (an ordinary
undelivered message is still reported) and one that pins the three branches which
set the flag.

---

### AC5 — a parcel accepted for an address that does not exist · **MEDIUM** · PROVEN·SOURCE · **FIXED**

**Where.** `MATRIX_ALLOWED` in `vendor/prinny-channel/src/command-routing.ts`.

**What.** The allow-list is the security boundary for Matrix→harness control, and
it was reviewed as one — every entry has a paragraph about what it grants. What
nobody asked is a different question: **can pi execute this at all through the
route we are using?**

```js
    // AgentSession.prompt(), agent-session.js:800
    if (expandPromptTemplates && text.startsWith("/")) {
        const handled = await this._tryExecuteExtensionCommand(text);
        if (handled) return;
    }
    // …and _tryExecuteExtensionCommand is:
    const command = this._extensionRunner.getCommand(commandName);
    if (!command) return false;
```

`getCommand` is the **extension** registry. In this stack that is four names —
`/stack`, `/loop`, `/agents`, `/prinny` — one per `pi.registerCommand` call.
`/compact` is one of pi's BUILT-IN slash commands (`core/slash-commands.js`:
`{ name: "compact", description: "Manually compact the session context" }`) and
the only thing that executes one is the TUI's own input handler
(`modes/interactive/interactive-mode.js`, the `text === "/compact"` branch).
Nothing reachable from an extension.

So a Matrix `/compact`:

1. was classified `run`, because it is in `MATRIX_ALLOWED`;
2. reached `prompt()`, found no extension command, and **fell through**;
3. was expanded as a prompt template and delivered as an ordinary user turn on the
   literal text `/compact` — a whole model call on the single llama slot, spent on
   a message the model can do nothing with;
4. left the room un-live (the echoed text is the command, not the `<channel>`
   block `markLive` matches), so whatever the model said in reply was never
   forwarded;
5. and the sender was told **"Ran `/compact`. Its output stays in the terminal."**
   — a sentence sent on the strength of having called the function;
6. and then, a minute later and before AC4, was told the message could not be
   delivered.

`/compact` is in `advertisedCommands()`, so it appears in the Matrix client's
`/` menu. It is also the single most likely command for somebody to reach for
when the bot has gone slow, which is when the context is full, which is when a
wasted turn costs the most.

**The fix, and why it is a third table rather than a deletion.** Withdrawing the
command would be honest and would lose a feature that is genuinely wanted from a
phone. `ExtensionContext.compact(options)` exists, is exactly this operation, and
works headless. So the routing gains a `local` kind and a second table:

```
   MATRIX_ALLOWED   commands pi dispatches   — a promise PI keeps
   MATRIX_LOCAL     commands prinny performs — a promise THIS FILE keeps
```

and `/compact` moves to the second, where `runLocalCommand` calls
`uiCtx.compact({ onComplete, onError })` and replies from the callbacks rather
than from the call — a sender who asked for a compaction because the bot had gone
slow is exactly the person who should not be told "done" before it is done.

The durable part is the split, not the entry: putting a built-in in the wrong
table is the mistake that was made, and a test now asserts that every name in
`MATRIX_ALLOWED` is one something calls `pi.registerCommand` for.

*Tests:* `vendor/prinny-channel/tests/command-routing.test.ts`, two new cases plus
three updated ones, **three of which fail without the fix**. The invariant case is
the one that matters: it enumerates the four registered extension commands and
requires every allow-listed name to be among them, and every local name not to be.

---

## 10. The notes

### 10.1 Fixed alongside AC1 — a catch that described the wrong failure

The `catch` in `emitIndividualNudge` did three things wrong at once and each is
worth naming separately, because the shape is general:

- **It named a cause it could not know.** `// sendMessage failed (shared runtime
  overwritten by subagent bindCore)` is a comment about one specific failure,
  attached to a `catch` that receives every failure in a 40-line block.
- **Its message described the outcome it wanted, not the one it had.** "Result
  available" is what a *successful* fallback would say.
- **It reported through a channel that is a no-op in the mode this failure
  matters most.** `noOpUIContext.notify` is `() => {}`; the background path is the
  one an unattended run uses.

Now: the error message is interpolated, the level is `warning`, the sentence says
the result was **not** delivered and names `AgentStatus` as the way to read it,
and a `console.warn` runs unconditionally so a headless run leaves a trace.

### 10.2 Observed, environmental — the loop suite can bail a whole FILE under memory pressure

Twice during this pass, `vendor/pi-loop-mode`'s suite reported `# tests 175 # pass
174 # fail 1` and `# tests 179 # pass 178 # fail 1` while three other suites ran
concurrently. Both counts are exactly "187 minus one file's tests, plus one
failure entry" — i.e. a test FILE that produced no subtests at all, which is how
`node --test` reports a child process that died before reporting. Different files
each time (a 13-test one, then a 9-test one). Not reproducible afterwards in
twenty attempts under deliberate CPU load, with 3 GiB free.

Recorded rather than chased, and with a reason: this box's own operating notes
have a section about `docker build` dying with `cannot allocate memory`, the test
runner spawns one child per file (16 at a time here), and three concurrent suites
is ~48 node processes. **The number to distrust is the test COUNT, not just the
failure count** — a green `# fail 0` with fewer tests than usual is the same
event, silently. Anyone re-running the gates should check `# tests 198` as well as
`# fail 0`.

### 10.3 Not a defect, but the reason AC1 was invisible — `console.warn` in a TUI

`rtk-pi`'s factory writes to `console.warn` when the binary is missing or wedged,
and that factory runs **once per subagent spawn** (`reloadAndMap` re-runs every
extension factory). pi owns the terminal, so those lines land in a TUI's stderr
mid-session. This pass's AC1 fix adds one more `console.warn` on the same
principle, and the trade is deliberate: a scribbled line the operator can see
beats a silence they cannot. If the TUI ever grows a proper extension-error
channel, both should move to it.

### 10.4 Still open, and why — decisions, not omissions

Carried forward, each with its reason:

- **T6 — `worktree_path` is a filesystem grant, not a sandbox.** The available
  tightenings would each break the feature's main use. A product decision.
- **Per-session loop state** (the `WeakMap<ExtensionAPI, LoopState>` refactor). A
  capability change with a working three-stop mitigation and no observed symptom.
- **T1's general case** — needs a pi-side "add context without asking a question",
  which does not exist.
- **`hasStateChange()`'s keyword list** — a heuristic feeding one advisory nudge.
- **The brief-before-session window** — milliseconds, and the alternative puts the
  write on a path with no error handling.
- **A check killed by SIGTERM from outside** is still not distinguishable from one
  that ran. See AC3; SIGKILL is the case that matters and it is unambiguous.
- **A `/loop resume` of a COMPLETED run is still allowed**, and after AC2 it is
  safe: the check decides again from scratch. Refusing it outright was considered
  and rejected — "carry on improving from where that finished" is a real thing to
  want, and it is what endless mode is for.

---

## 11. What was re-verified this pass, and holds

Read out of pi's shipped `dist/` (0.84.2) and out of the tree, not assumed.

- **All fifty-one prior probes run clean**, and all fifty-one prior fixes are in
  the tree.
- **`execCommand` still has no `reject` in its body**, `killProcess` still has
  exactly two callers (`options.timeout`, `options.signal`), and it still resolves
  `{ code: code ?? 0, killed }`. Re-read for AC3. `waitForChildProcess`'s `onExit`
  still takes only the code and drops the signal.
- **`execCommand` checks `signal.aborted` before adding its listener**
  (`if (options.signal.aborted) killProcess()`), which is the pattern AB4 added to
  `runTurnLoop` — pi got it right in this file and the fork now matches.
- **`AgentSession.prompt()` dispatches EXTENSION commands only**, at `:800`,
  before the compaction check — which is why a `/prinny` subcommand can run while
  the loop is mid-iteration, and why `/compact` cannot (AC5).
- **`_emitAgentSettled` sets `_isAgentRunActive = false` BEFORE emitting**
  (`:328`), so `ctx.isIdle()` is true inside an `agent_settled` handler.
- **`emitMessageEnd` threads the handler's returned message into the next
  handler** and `_replaceMessageInPlace` then deletes every key of the object
  agent-core holds and `Object.assign`s the replacement — so `agent_end`'s
  `messages` are the same objects, and a later `message_end` handler sees an
  earlier one's replacement. Re-read as part of surface 6's sweep over the events;
  the three handlers in this stack that read a message all extract STRINGS
  synchronously, so none of them holds an object across the replacement.
- **`emitToolResult` builds ONE event object (`{...event}`) and passes it to every
  handler**, merging each returned field into it in order. So the loop's
  fingerprint of the RAW output (it runs first) and the guard's cap (second) are
  both correct, and neither can be undone by the other.
- **`emitContext` `structuredClone`s the message array before the first handler**,
  so nothing either handler adds can reach the session, and only the returned
  array counts.
- **`emitToolCall` has ONE emit site in all of pi**, passes the event by reference
  with no clone, and has **no try/catch around handlers** — so a throwing
  `tool_call` handler blocks the tool. Both handlers in this stack are total.
- **`noOpUIContext` implements every `ui.*` method this stack calls**, and
  `notify` is `() => {}`. That is the fact AC1's fallback rested on.
- **`ExtensionContext.compact(options)` takes `{customInstructions, onComplete,
  onError}` and returns void**, calling `runner.compactFn(options)`. That is what
  AC5's local `/compact` uses, and it is the same call `/loop`'s stuck ladder
  makes.
- **`tallyCompletion` → `notifyComplete` → `onComplete` runs in the settlement
  chain's `.finally`**, for every settlement of every record — which is why AC1's
  blast radius is "every background result and every continuation" rather than
  something narrower.
- **The loop is inert in a child** by three independent stops, `pi-subagents-lite`
  is inert in a child by its factory guard, `prinny-channel` is denied to one by
  `withExtensionDenial()`'s path regex, and `rtk-pi` reaches one deliberately.

---

## 12. What shipped

Every fix carries a regression test that fails when the fix is removed; where a
case passes either way it is a control and is labelled as one.

### The five findings

| # | Fixed by | Where | Tests | Fail without it |
| --- | --- | --- | --- | --- |
| AC1 | the `ctx` binding restored, at call time; and a catch that names the failure, warns rather than informs, and writes to the console as well as the UI | `pi-subagents-lite/src/spawn/spawn-coordinator.ts` | `background-delivery.test.ts` +4 | 3 |
| AC2 | `resume` clears the check's ERROR streak (not its verdict); the `LOOP_DONE` guard also refuses a LAST-KNOWN verdict | `pi-loop-mode/extensions/index.ts` (the resume branch, the `LOOP_DONE` branch) | `check-that-cannot-run.test.ts` +5 | 3 |
| AC3 | the operator's command runs in a subshell, so its own `EXIT` trap and its `exec` cannot reach the shell that prints the marker | `pi-loop-mode/src/goal-check.ts` (`wrapCheckCommand`) | `check-that-cannot-run.test.ts` +6 | 4 |
| AC4 | the sweep asks `answered` first — an entry this extension resolved was never pi's to take | `prinny-channel/src/delivery.ts` | `delivery.test.ts` +4 | 2 |
| AC5 | a `MATRIX_LOCAL` table and a `local` kind; `/compact` performed through `ctx.compact()` and answered from its callbacks | `prinny-channel/src/command-routing.ts`, `extensions/index.ts` (`runLocalCommand`) | `command-routing.test.ts` +2, 3 updated | 3 |

### The gates

```
                                      before    after
vendor/pi-loop-mode         tests     187       198
vendor/pi-subagents-lite    tests     273       277     lint 85/85 files
vendor/prinny-channel       tests     311       317     lint clean
.pi/extensions/compaction-guard        41        41
vendor/rtk-pi               tests      20        20
                                      ─────     ─────
                                       832       853
probes                                  51        55
```

### The harness change, which is the widest thing in this pass

```
   background-delivery.test.ts   was: three assertions over the file as TEXT
                                 now: text pins KEPT, plus four cases that load
                                      the module through pi's own bundled jiti
                                      and CALL emitIndividualNudge

   check-that-cannot-run.test.ts was: every case through an exec stub
                                 now: plus six cases through REAL bash, because
                                      AC3 is a fact about bash's trap semantics
                                      and a stub of it would be the thing being
                                      questioned
```

Both are the same correction: **the test has to be able to observe the failure.**
A text pin cannot see a deleted binding; an exec stub cannot see a trap being
replaced. The eleventh pass said a harness must be able to *produce* every value
the host can return; this pass adds that it must also be able to *reach* the code
it claims to protect.

### The no-import modules

Unchanged in count; listed because the pattern is what makes any of this testable
at all. Each exists because the file it came from imports pi and therefore cannot
be loaded by a suite:

```
   turn-tracking.ts        T1   the turn ceiling
   record-activity.ts      Y1   is this record still busy
   run-answer.ts           Z1   what a run said
   compaction-anchor.ts    Z2   does this compaction reach a turn
   git-failure.ts          AA2  which git failure is this
   status-listing.ts       —    which agents to print
   goal-check.ts           AB1  did the check finish              ← AC3 grew it
   delivery.ts             AB2  did pi ever take this message     ← AC4 grew it
   command-routing.ts      —    what a leading slash means         ← AC5 grew it
```

AC1 is the counter-example and the reason the list is here: `spawn-coordinator.ts`
**cannot** be one of these — it is coupling, its whole job is to call pi — so the
only way to test it is to load it the way pi does. That option existed the whole
time.

---

## 13. Running the evidence

```sh
cd ~/qwen3.8-forge

# the gates — check the TEST COUNT as well as the failure count (see §10.2)
( cd vendor/pi-loop-mode       && npm test && npm run lint )          # 198
( cd vendor/pi-subagents-lite  && npm test && node tests/lint.mjs )   # 277 + 85/85
( cd vendor/prinny-channel     && npm test && npm run lint )          # 317
( cd .pi/extensions/compaction-guard && npm test )                    #  41
( cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts )  # 20

# just this pass's regression tests
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/background-delivery.test.ts )
( cd vendor/pi-loop-mode && node --experimental-strip-types --test \
    tests/check-that-cannot-run.test.ts )
( cd vendor/prinny-channel && node --experimental-strip-types --test \
    --test-timeout=90000 tests/delivery.test.ts tests/command-routing.test.ts )

# this pass's probes
P=context/testing/probes
node                            $P/p1-the-background-result-that-never-arrived.mjs
node --experimental-strip-types $P/p2-a-check-verdict-that-outlived-its-run.mjs verdict
node --experimental-strip-types $P/p2-a-check-verdict-that-outlived-its-run.mjs streak
node --experimental-strip-types $P/p2-a-check-verdict-that-outlived-its-run.mjs control
node --experimental-strip-types $P/p3-the-exit-trap-a-check-can-take.mjs
node --experimental-strip-types $P/p4-the-message-prinny-answered-itself.mjs

# every probe, exit code only
for f in context/testing/probes/[a-z]*.mjs; do
  timeout 180 node --experimental-strip-types "$f" >/dev/null 2>&1 || echo "FAIL $f"
done
```

| probe | what it showed | the control |
| --- | --- | --- |
| `p1` | the real coordinator, with the binding taken back out, delivering nothing and reporting "Result available"; then delivering, with the cap applied | a missing record (no message either way) and an absent session ctx (which must bound nothing and lose nothing) |
| `p2` | the shipped loop completing a resumed `--until-done` run on a stale verdict, and counting a check error to 4/3 after a resume | `/loop run`, which resets the state outright (V3), and a check that really passes, which must still complete |
| `p3` | pi's real `execCommand` calling three ordinary checks dead, under the eleventh pass's wrapper and under this one's | the OOM kill the marker exists for, a SCORE line, a multi-line check, a syntax error, and pi's own timeout |
| `p4` | pi's command dispatch out of `dist/`, the four extension commands this stack registers, and the sweep's verdict on each kind of entry | a plain undelivered message, which must still be reported, and a busy session, which must never be |

`p1` loads the module through pi's `jiti`; `p3` drives pi's real `execCommand`;
`p2` drives the shipped loop through `_host.mjs`; `p4` is half a source pin over
pi's `dist/` and half the real rule.

---

## 14. The pattern across twelve audits

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
   sending ↔ receiving        AC1–AC5  something was produced for somebody, and
                                       nobody checked that anybody got it
```

Three things transfer out of this one.

**Name the reader.** Every finding here answers the same question badly: *who
receives this, and what do they see when it does not arrive?* The parent model
(AC1) receives nothing and is told nothing. The next run (AC2) receives a verdict
the previous run earned. `runGoalCheck` (AC3) receives a receipt the payload could
have forged. The Matrix sender (AC4) receives a correction about a message that
was fine, and (AC5) a confirmation of something that did not happen. None of those
is visible from the sending side, and every one of them is obvious from the
receiving side — which is why the ledger in §8 is a table with a *reader* column
and not a list of calls.

**A catch-all `catch` around a delivery must name the failure it caught.** AC1
lived for two passes inside four lines of error handling that were written with
care, for a real failure, and then caught a different one. The rule that would
have surfaced it in a day: *the fallback message must contain the reason, and must
go somewhere that exists in the mode the failure matters most.* The second half is
this stack's specific hazard — `ctx.ui.notify` is a no-op headless, and headless
is where unattended runs live — and the tenth pass already fixed exactly this for
`pi-loop-mode`'s notices, one package over.

**A test that cannot execute the code it protects is a test of the diff.** The
source-text pin is a legitimate instrument, and this repo has good ones — `j7`
and `k6` pin an ORDER that no runtime assertion could see. What it cannot do is
notice a change nobody made on purpose. The distinction to keep:

```
   a source pin answers    "is the fix still written here?"
   an execution answers    "does the function still do the thing?"

   a REVERT is caught by either.
   a DELETION three lines away, a rename, or a refactor that keeps the matched
   text — only by the second.
```

Every fix in this series that is pinned only by text should be re-read against
that. §15 has the list.

---

## 15. Still unwatched

Everything above is fixed against probes and tests, and none of it against a
running model. That has been true for nine passes now.

1. **§B of `context/testing/subagents-loop-verifier.md`** is promoted to the top
   of this list, because it is the one hand test that would have caught AC1 and it
   has not been run since the tenth pass changed the path it exercises. One
   background delegation, and the question is only "did the result come back into
   the conversation at all".
2. **§M and §M.2** — one `/loop start` with a slow `--check`, then one with
   `--check "kill -9 $$"`, and `/loop status` after each. Four HIGH/MEDIUM
   findings across three passes now sit on that path, and AC3 adds a third case
   worth one command: `--check "trap 'echo bye' EXIT; true"` must read as a check
   that PASSED.
3. **§O** — a Matrix message sent while pi is compacting, plus, now, `/compact`
   sent FROM Matrix: it must actually compact, the sender must be told when it
   finishes rather than when it starts, and no undelivered notice must follow.
4. **A real verification**, foreground, `SUBAGENT_VERIFY_ROUNDS=1`, deliberately
   off-task brief — S2, U4, U8, V5, V7/W6, W5, Y1, Z1, T5, AB4.
5. **Log the judge's raw reply.** Still #1 by age, untouched by this pass too, and
   load-bearing for S2, U4, V5 and W5.
6. **A child that compacts** (§L) — Z1 and Z2 both live there.
7. **A delegation with a loop running** (§I) — fixed at the module level ten times
   now and never watched.
8. **§J** (W3), **§K/§K.2** (Y1, T5), **§N** (prinny's W1) — none ever run.
9. **A degenerate turn in the wild.** Rule 1 has never fired in a real session.
10. **The text-pinned fixes, re-read against §14's distinction.** The ones that
    rest wholly on a source pin today are V7/W6 (`j7`, `k6` — an ORDER, which is
    the legitimate case), AA3 and AA4 (`n3`, `n4`), AB2's routing half (`o2`) and
    AB4's enumeration (`o4`). AA4's is the one that failed; the others should each
    be asked whether an execution is available, the way `p1` found one.

---

## 16. Where to look

- `context/testing/probes/p1`–`p4` — the reproductions, one per finding (`p4`
  carries both AC4 and AC5).
- The regression tests:
  `vendor/pi-subagents-lite/tests/background-delivery.test.ts` (AC1),
  `vendor/pi-loop-mode/tests/check-that-cannot-run.test.ts` (AC2 and AC3),
  `vendor/prinny-channel/tests/delivery.test.ts` (AC4),
  `vendor/prinny-channel/tests/command-routing.test.ts` (AC5).
- **§1** of this document — the machine, with every delivery marked; **§8** — the
  ledger, which is the artefact this pass exists to leave behind; **§2.6** — the
  four ways a loop run restarts, side by side, which is what found AC2.
- `context/design/subagents-loop-verifier-signals.md` — the eleventh pass
  (AB1–AB4). Its §1 is what this document's §1 extends, its §8.3 is the
  five-surface checklist this one adds a sixth to, and its §6 and §7 are the first
  full accounts of `prinny-channel` and `rtk-pi`.
- `…-hosts.md` (tenth, AA1–AA4, and the host-call ledger for the other three
  packages) · `…-answers.md` (ninth, Z1–Z4) · `…-turns.md` (eighth, X1–X5, Y1) ·
  `…-readers.md` (seventh, W1–W6) · `…-shapes.md` (sixth, V1–V8) · `…-units.md`
  (fifth, U1–U9, whose §9 reference sections no later document restates) ·
  `…-surfaces.md` (fourth, S1–S10) · `…-mechanics.md` (third, T1–T9, still the
  best account of pi's own agent loop) · `…-evaluation.md` (second, F1–F11) ·
  `…-anatomy.md` (first, and the design rationale).
- pi's own source, for this pass:
  `dist/core/agent-session.js:800` (`_tryExecuteExtensionCommand`, and that it is
  the EXTENSION registry), `:808`/`:833`/`:848`/`:859` (every way `prompt()`
  throws), `:328` (`_isAgentRunActive = false` before the settled emit), `:425`
  (`_replaceMessageInPlace`), `:486` (the `message_end` write-back), `:1068`
  (`sendCustomMessage`'s three branches), `:1855` (the binding that `.catch`es),
  `dist/core/slash-commands.js` (`BUILTIN_SLASH_COMMANDS`, and `compact` in it),
  `dist/modes/interactive/interactive-mode.js` (`text === "/compact"` — the only
  place a built-in is executed),
  `dist/core/exec.js` (`execCommand`: `killProcess`'s two callers, the
  `signal.aborted` check, and `code: code ?? 0`),
  `dist/utils/child-process.js` (`waitForChildProcess` — `onExit(code)`, where the
  signal is dropped),
  `dist/core/extensions/runner.js:88` (`noOpUIContext`), `:528` (`ctx.compact` →
  `compactFn`), `:579` (the generic `emit`, and last-truthy-wins for
  `session_before_*`), `:610` (`emitMessageEnd`, threaded), `:649`
  (`emitToolResult`, one shared object), `:701` (`emitToolCall`, and its missing
  try/catch), `:747` (`emitContext`, and its `structuredClone`).
