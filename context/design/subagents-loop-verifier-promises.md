# Subagents, the loop, and the verifier — what was promised

Eighteenth pass, 2026-08-19. A full read of the whole stack — pi's own agent
loop, `vendor/pi-loop-mode`, `vendor/pi-subagents-lite` and the answer verifier
inside it, `.pi/extensions/compaction-guard`, `vendor/prinny-channel`,
`vendor/rtk-pi` and `.pi/extensions/stack.ts` — written to be **self-contained**.
§1 to §9 are a complete account of the machine and assume none of the seventeen
documents before this one.

The seventeenth pass asked where else a rule belongs. Its closing lesson was:

> **A decision to leave something open is a claim, and it ages. When you write
> down why you are leaving something, write down which fix you considered.**

This pass is that lesson widened, because a decision is not the only thing this
stack writes down. It writes down sentences it says to people: to a Matrix
sender, to the operator, to the parent model, and to the next person who opens
the file.

> **THE AXIS: quote the sentence this stack has already said — to a person, to a
> model, or to the next reader — and then find the path on which it is not
> true.**

Five findings. Every one of them is a promise that exists, is deliberate, is
written down in the source, and is false on a path nobody walked.

```
   AI1  A finished BACKGROUND subagent's answer, still sitting in the
        coordinator's batch set when the session ends. `dispose()` cleared the
        set and cancelled the one timer that drains it, so the answer went
        nowhere and nothing was said — while the `session-replaced` drop report,
        whose own docstring says it is for "`session_shutdown`, or a session
        replaced under it", could only ever fire for a record that settles
        AFTER the dispose. The report existed and the path to it did not.
        AH1 widened the window it can be lost in from 200 ms to five minutes.
                                                        MEDIUM · FIXED

   AI2  A Matrix `/compact` that arrives mid-turn is answered *"The session is
        mid-turn — I will compact as soon as it finishes rather than cutting it
        off."* It was parked in ONE slot, last-write-wins, so with two senders in
        one turn every one but the last was told that and never heard again —
        and `deliverInbound` marks the entry `answered` on the way past, so the
        undelivered sweep could not report it either. The same module answers
        two senders correctly on the path that acts IMMEDIATELY.
        And `stopChannel` dropped the whole request in silence, a few lines
        above a loop that denies every pending permission with a stated reason.
                                                        MEDIUM · FIXED

   AI3  `AgentManager.steer()` answers `true` for a steer it parks in
        `pendingSteers`, under *"Queued, so it WILL reach the model —
        onSessionCreated flushes it."* The operator reads that as "Steer sent to
        X…". `onSessionCreated` is the one thing a run that dies during setup
        never reaches, and the setup window is seconds long — a settings
        manager, the system-prompt sources, two git subprocesses, and every
        extension factory re-run for the child. Nothing said so. Worse,
        `growBrief` had already recorded the steer, so the brief the JUDGE
        checks the answer against contained an instruction the child never got.
                                                        MEDIUM · FIXED

   AI4  `forwardToMatrix` refuses to send when two rooms are live, because
        "guessing would send one person's conversation to another — worse than
        silence, and not undoable". The `prinny` TOOL is the second route into
        the same `reply` and it guessed: `room_id` comes from `lastInbound`, a
        one-slot last-write-wins variable, under *"neither in the schema nor
        something the model can get wrong"*. With two rooms live — AF1's own
        ordinary case — the model answering the FIRST sender sent that answer to
        the SECOND, and could not name the right room because
        `renderInboundMessage` drops `room_id` from what the model sees.
                                                        MEDIUM/HIGH · FIXED

   AI5  The seventeenth pass fixed two of `.pi/extensions/stack.ts`'s nine
        `pi.exec` sites and wrote the other seven down as safe: *"script runners
        whose output is reported verbatim, where a wedge shows up as empty
        output rather than as a wrong verdict."* Five of them choose a verdict
        from `r.code` and say a sentence about it. Two recreate llama on a
        600-second timeout in a file whose own confirmation prompt says the cold
        load is "roughly 20 minutes", and reported "llama recreated" for a
        compose command pi had killed. The standing scan that keeps the rule
        applied did not cover the file the rule had just been applied to.
                                                        LOW/MEDIUM · FIXED
```

**All five are fixed**, each with a regression test that fails when the fix is
removed, and each probe written afterwards to print BEFORE and NOW so the probe
is its own control. §11 has the change and the control-run failing count for
each.

```
                                    before    after
   vendor/pi-loop-mode      tests     227       227
   vendor/pi-subagents-lite tests     365       378    lint 95/95 files
   vendor/prinny-channel    tests     382       399    lint clean
   .pi/extensions/compaction-guard     47        47
   vendor/rtk-pi            tests      20        20
                                     ─────     ─────
                                    1,041     1,071
   probes                              77        82
```

The gates were re-run **before** anything was written, so the *before* column is
a measurement of the tree as this pass found it rather than a claim about it.

**pi-loop-mode has no finding this pass, and that is a result rather than an
omission.** §13.2 is the list of promises the loop makes, each one followed to
the path that would falsify it, and each one kept. It is the most worked-over
package in the stack — V4, AF3, AG2 and AH6 are all about the same three
sentences — and the axis finds nothing left in it.

---

## 0. How to read this, and what it is for

This document is written for somebody who has never seen the stack. It is long
because the machine is: six extensions, two entry points, one llama slot, three
nested units of a turn, and about 27,000 lines of source with a comment density
closer to a design document than to code.

The order is deliberate:

- **§1** is the whole machine in one drawing. Everything after it is a zoom into
  a part of that drawing, and every section says which part.
- **§2** is pi itself — the substrate the extensions are bolted to. Read it even
  if you know pi: most of the eighteen passes' findings turn on details of it
  that are not documented anywhere else.
- **§3** is the event bus: who handles what, in what order, and which four of
  those orderings decide behaviour.
- **§4**–**§9** are the six packages, one at a time, in full.
- **§10** is the handful of invariants that hold across all of them, and
  **§10.5 is this pass's own artefact — the promise ledger**: every sentence
  this stack says to somebody, who hears it, and what makes it false.
- **§11** is the findings, each with its reproduction.
- **§12**–**§15** are the evidence, what is open, the pattern across eighteen
  passes, and where to look next.

Four conventions carried from the earlier documents and worth knowing:

- A **✋** marks a place the stack deliberately declines to act. There are
  forty-five of them; §2 of `…-omissions.md` is the full ledger and this
  document does not restate it.
- A **◆** marks module-global state — a variable shared by every session in the
  process, which on this stack includes a subagent's session, because a child
  binds the parent's extensions through node's module cache. That fact is
  responsible for more findings in this series than any other single property of
  the machine.
- A **▣** marks a ONE-SLOT queue: a single variable holding something that was
  deferred. Four of this pass's five findings are one of these, and §10.5's
  second table draws them.
- A **“…”** in §10.5 is a sentence this stack really says, quoted from the
  source.

---

## 1. The whole machine

One answer, from the model that produces it to the person or the parent model
that reads it. Everything else in this document is a zoom into this.

```
 ┌──────────────┐   ┌──────────────────────────────┐   ┌────────────────────────┐
 │  llama.cpp   │──▶│ forge — OpenAI-compatible    │──▶│           pi           │
 │  ONE slot    │   │ proxy on :8081               │   │        0.84.2          │
 │  32k window  │   │ forge_reasoning_passthrough  │   │  reasoning_content ──▶ │
 │  Qwen3.8-27B │   │  emits reasoning_content     │   │   {type:"thinking"}    │
 │  Q4          │   │  beside content, and a       │   └──────────┬─────────────┘
 └──────┬───────┘   │  truthful finish_reason      │              │
        ▲           └──────────────────────────────┘              │
        │                                                         │
        │   ONE SLOT.  Every box below is in ONE QUEUE: the       │
        │   operator's turn, a subagent's turn, the judge's       │
        │   turn, a repair, a compaction summary, a Matrix        │
        │   answer.  Nothing here is concurrent with anything     │
        │   else, and that single fact shapes every design        │
        │   decision below.                                       │
        └─────────────────────────────────────────────────────────┘

 ═════════════════════════════════════════════════════════════════════════════════
  A.  THE TWO ENTRY POINTS — and only one of them is a "prompt"
 ═════════════════════════════════════════════════════════════════════════════════

  ┌─ AgentSession.prompt(text, opts)                   agent-session.js:792 ────────┐
  │   who reaches it:  a HUMAN typing in the terminal                               │
  │                    a subagent's own runner (session.prompt)                      │
  │                    pi.sendUserMessage()  ← prinny-channel's ONLY route           │
  │                                                                                 │
  │   text starts "/" && expandPromptTemplates                            :800      │
  │        ─▶ _tryExecuteExtensionCommand ─▶ RETURN. no turn.                       │
  │           ▲ EXTENSION commands only (/loop /agents /prinny /stack).             │
  │             pi's BUILT-INS — /compact, /model, /new — are executed by the       │
  │             TUI's own input handler and are unreachable from here.              │
  │   _compactionAbortController !== undefined                            :807      │
  │        ─▶ THROW "Cannot submit a prompt while compaction is in progress" ✋     │
  │           ▲ THE ONLY COMPACTION REFUSAL IN ALL OF pi.                           │
  │   isStreaming                                                         :830      │
  │        no streamingBehavior ─▶ THROW                                    ✋      │
  │        "followUp" ─▶ _queueFollowUp → ◆_followUpMessages                        │
  │        "steer"    ─▶ _queueSteer    → ◆_steeringMessages                        │
  │        ▲ THE ONLY TWO ARRAYS hasPendingMessages() COUNTS.                       │
  │   idle:                                                                         │
  │        no model / no auth ─▶ THROW                              ✋  :846/:852   │
  │        _checkCompaction(lastAssistant, false)                          :865     │
  │        messages = [ user(text), ..._pendingNextTurnMessages ]           :880    │
  │        ┏━ emitBeforeAgentStart(...) ━━━━━━━━━━━━━━━━━━━━━━━━━┓          :885    │
  │        ┃  returned messages appended as role:"custom"          ┃                │
  │        ┃  THE ONLY EMIT SITE FOR before_agent_start IN ALL OF pi┃               │
  │        ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛                  │
  │        _runAgentPrompt(messages)                                                │
  └─────────────────────────────────────────────────────────────────────────────────┘

  ┌─ AgentSession.sendCustomMessage(msg, options)             :1068 ───────────┐
  │   who reaches it:  pi.sendMessage() — the ONLY route an EXTENSION has      │
  │                    pi-loop-mode, for EVERY loop turn it drives             │
  │                    pi-subagents-lite, for every background result          │
  │                                                                            │
  │   deliverAs "nextTurn" ─▶ ◆_pendingNextTurnMessages                :1079   │
  │        ▲ drained by prompt() ALONE. Nothing an extension can do drains     │
  │          it, which is why the loop no longer uses it (Z4).                 │
  │   isStreaming && triggerTurn !== false                              :1081  │
  │        "followUp" ─▶ agent.followUp(msg)   the AGENT's own queue           │
  │        else       ─▶ agent.steer(msg)      the AGENT's own queue           │
  │        ▲ NOT the two arrays above, so this never makes                     │
  │          hasPendingMessages() true.                            [AA3]       │
  │   triggerTurn (idle) ─▶ await _runAgentPrompt(msg)                 :1090   │
  │        ▲ NO emitBeforeAgentStart                               [AA1]       │
  │        ▲ deliverAs DISCARDED                                   [AA4]       │
  │        ▲ AND NO COMPACTION CHECK                     ← AG2 · AG3 · AH1     │
  │          THREE SENDERS reach this. All three ask first (§10.4).            │
  │   RETURNS void. Every failure is pi's own `.catch` → emitError → a         │
  │   listener set that is EMPTY outside a TUI.              [AB2][AC1][AE4]   │
  └────────────────────────────────────────────────────────────────────────────┘

 ═════════════════════════════════════════════════════════════════════════════════
  B.  ONE RUN, and the three nested units inside it
 ═════════════════════════════════════════════════════════════════════════════════

  _runAgentPrompt(messages)                                    agent-session.js:744
    ◆ _isAgentRunActive = true      ── isStreaming === !isIdle, one bit for both
    │
    ├── agent RUN #1   runAgentLoop            pi-agent-core/agent-loop.js:43
    │     currentContext.messages = [...context.messages, ...prompts]
    │        ▲ A COPY, taken here. Agent.prompt() has already taken another
    │          (createContextSnapshot → _state.messages.slice()). The whole run
    │          works from the message list AS IT WAS AT ITS FIRST INSTANT — which
    │          is why a run started inside a compaction never sees the compaction.
    │     emit agent_start
    │     emit turn_start
    │     for (prompt of prompts) message_start / message_end        :52
    │            ▲ prinny's markLive() matches HERE
    │     ┌── INNER while (hasMoreToolCalls || pendingMessages.length)
    │     │     drain STEERING → message_start / message_end          :96
    │     │     streamAssistantResponse                               :106
    │     │        message_start · message_update… · message_end
    │     │     stopReason error|aborted ─▶ turn_end, agent_end, RETURN
    │     │     executeToolCalls
    │     │       ┏━ prepareToolCall ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    │     │       ┃  validatedArgs = validateToolArguments(tool,call) ┃
    │     │       ┃  emitToolCall({ input: validatedArgs })           ┃
    │     │       ┃    the event.input IS validatedArgs, BY REFERENCE ┃
    │     │       ┃    handlers MUTATE it; only `block` is read back  ┃
    │     │       ┃  block:true ─▶ createErrorToolResult(reason)  ✋  ┃
    │     │       ┃  …then tool.execute(id, prepared.args, …)         ┃
    │     │       ┗━ prinny's permission relay, then rtk's rewrite ━━━┛
    │     │       execute THROWS ─▶ createErrorToolResult(err.message)
    │     │            ▲ the WHOLE thrown text becomes ONE text block with
    │     │              isError:true — which is what AF6 is about
    │     │       → emitToolResult   ← ONE object threaded through handlers,
    │     │              loop FIRST (fingerprints the RAW text),
    │     │              guard SECOND (caps it, error results included)
    │     │     emit turn_end { message, toolResults }
    │     │     pendingMessages = getSteeringMessages()
    │     └── OUTER while: getFollowUpMessages() → back into the inner loop
    │            ▲ a message queued DURING a run is consumed BY that run.
    │              This is why one run can owe TWO Matrix rooms.  [AF1][AI2][AI4]
    │     emit agent_end { messages: newMessages }
    │            ▲ pi-loop-mode counts THIS as one "iteration"
    │            ▲ and pi AWAITS every handler: the agent does not become idle
    │              until they settle, so the loop's 120-second goal check really
    │              does hold the whole session.        (agent.js:143, :417)
    │
    ├── _handlePostAgentRun()                                              :757
    │     _prepareRetry(msg)?  _checkCompaction(msg)?  agent.hasQueuedMessages()?
    │        any true ─▶ await agent.continue()  → ANOTHER agent RUN
    │        ▲ so ONE prompt is one-or-more agent_end events, and the second one
    │          is milliseconds after the first.  That is what AH6 is about.
    │
    └── finally
          ◆ _systemPromptOverride = undefined   ← and NOTHING restores it
          _flushPendingBashMessages()
          _emitAgentSettled()
            ◆ _isAgentRunActive = false   ← BEFORE the handlers run
            emit agent_settled            ← so ctx.isIdle() is TRUE inside it

  MESSAGE  one assistant reply.
  TURN     one assistant message plus its tool results  (pi's `turn_end`).
  RUN      agent_start … agent_end.  ONE loop iteration.
  PROMPT   one prompt()/sendCustomMessage — possibly SEVERAL runs.

 ═════════════════════════════════════════════════════════════════════════════════
  C.  THE SIX EXTENSIONS, in load order, with what each one is for
 ═════════════════════════════════════════════════════════════════════════════════

  scripts/pi-local.sh passes them as `-e` in THIS order, and the order is
  load-bearing in three separate places (§3):

    1. .pi/extensions/stack.ts           /stack · guards itself in a child  ← AI5
    2. .pi/extensions/browser-guard.ts   rewrites a browser timeout
    3. vendor/pi-loop-mode               13 handlers · /loop · the `loop` tool
    4. .pi/extensions/compaction-guard    3 handlers · no tools · no commands
    5. vendor/pi-subagents-lite           4 handlers · Agent/StopAgent/AgentStatus
    6. vendor/prinny-channel              7 handlers · /prinny · the `prinny` tool
    7. vendor/rtk-pi                      1 handler  · no tools · no commands

  ┌───────────────┬───────────────┬───────────────┬───────────────┬──────────────┐
  │ pi-loop-mode  │ compaction-   │ pi-subagents- │ prinny-       │ rtk-pi       │
  │               │ guard         │ lite          │ channel       │              │
  ├───────────────┼───────────────┼───────────────┼───────────────┼──────────────┤
  │ drives an     │ bounds what   │ spawns child  │ a second      │ compresses   │
  │ unattended    │ a compaction  │ sessions in   │ HUMAN, over   │ bash output  │
  │ run: one turn │ carries, and  │ THIS process, │ Matrix, and   │ for a        │
  │ after another │ what one tool │ verifies      │ the only      │ measured     │
  │ toward a goal │ result may    │ their answers │ path with     │ allow-list   │
  │               │ spend         │               │ one on it     │              │
  ├───────────────┼───────────────┼───────────────┼───────────────┼──────────────┤
  │ 13 handlers   │ 3 handlers    │ 4 handlers    │ 7 handlers    │ 1 handler    │
  │ INERT in a    │ INHERITED by  │ INERT in a    │ DENIED to a   │ INHERITED    │
  │ child (three  │ a child, and  │ child by its  │ child, by a   │ by a child   │
  │ ways over)    │ wanted there  │ factory guard │ path regex    │ on purpose   │
  └───────────────┴───────────────┴───────────────┴───────────────┴──────────────┘

  `.pi/extensions/stack.ts` is the sixth and is not in that table because it is
  not part of the answer path: it is `/stack`, the operator's window onto llama
  and forge, plus one model-callable `stack_status` tool. It is in this document
  because AH3 reached into it and AI5 finishes the job.

 ═════════════════════════════════════════════════════════════════════════════════
  D.  A DELEGATION — the Agent tool, end to end
 ═════════════════════════════════════════════════════════════════════════════════

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │  ◆ module-global state, shared by EVERY session in this PROCESS:         │
   │      pi-loop-mode   state:LoopState · runToken · ▣pendingTimer · 4 bufs  │
   │                     waitingForCompaction · ▣deferredDirective            │
   │                     ▣contextRecoveryPending                              │
   │      pi-subagents   shell{pi,sessionCtx,manager,widget,store,coordinator}│
   │                     ▣pendingNudges + nudgeTimer   ← AI1                  │
   │                     coordinator.heldForCompaction                        │
   │                     record.execution.▣pendingSteers  ← AI3               │
   │      prinny         child · awaitingReply · typingRooms · deliveryTimer  │
   │                     ▣pendingCompaction  ← AI2 · ▣lastInbound  ← AI4      │
   │                     agentRunning · lastAssistantText                     │
   │      compaction-gd  spillDir (a mkdtemp, first use, bounded at 50 files) │
   │      result-cap     spillDir (its own mkdtemp, bounded too)              │
   │      rtk-pi         (none — the gate is a pure function)                 │
   │      globalThis     __PI_SUBAGENT_SPAWN_DEPTH__                          │
   │                     __PI_COMPACTION_IN_FLIGHT__   ← 5 readers, 3 packages│
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent(prompt, agent:"Explore", run_in_background?)
                  ▼
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  tool_call — three handlers, in load order, on ONE mutable input object     ┃
   ┃    prinny  needsApproval(tool, input, settings) → {block, reason}?    ✋    ┃
   ┃    rtk     bash only; rewrites event.input.command IN PLACE                 ┃
   ┃            ✋ not allow-listed · ✋ rtk absent · ✋ rewrite threw           ┃
   ┃              — all three FAIL OPEN, which is the whole design               ┃
   ┃    subag   toolCallListener:                                                ┃
   ┃              canonical = resolveType(input.agent)                           ┃
   ┃              ✋ unresolvable → inject NOTHING, and say so by the            ┃
   ┃                 ABSENCE of the stamp                                        ┃
   ┃              input._resolvedAgent = canonical                               ┃
   ┃              input.model    = resolveSpawnModel(canonical, ctx)             ┃
   ┃              input.thinking = resolveSpawnThinking(canonical)               ┃
   ┗━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                  │ the SAME object reaches execute()
   ┌──────────────▼────────┐    ┌────────────────────────────────────────────────┐
   │ executeAgentTool      │    │ AgentManager                                   │
   │  worktree · trust     │───▶│  SlotTable(default 1) · queue · Watchdog 45m   │
   │  resolveTypeWithDisc. │    │  parent signal bound, `.aborted` checked       │
   │  ✋ ambiguous → error  │    │  ✋ slot full → QUEUED (not refused)          │
   │  ✋ not found → error  │    │  stopAgent(running)   = abortCtrl.abort()     │
   │  ✋ hidden    → error  │    │  stopAgent(verifying) = verifyAbort.abort()   │
   │     (all three are     │    │  ✋ neither          = false                  │
   │      MODEL-facing)     │    │  clear(verifying)    = false                  │
   │  git probes: killed    │    │  dispose(): queued records FAIL LOUDLY (US-9) │
   │  before code           │    │            ← the control AI1 is measured on   │
   └───────────────────────┘    └────────────────┬───────────────────────────────┘
                                                 │ runAgent()
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  THE BUILD WINDOW — SECONDS, and there is no session for any of it       ┃
   ┃    SettingsManager.create · resolveSystemPromptSources                   ┃
   ┃    detectEnv()            two git subprocesses on a 9p mount             ┃
   ┃    enterSubagentSpawn()   ◆ __PI_SUBAGENT_SPAWN_DEPTH__ = 1              ┃
   ┃    reloadAndMap()         EVERY extension factory runs AGAIN —           ┃
   ┃                           and rtk's shells out to `rtk --version`        ┃
   ┃    createAgentSession()   → onSessionCreated  ← ▣pendingSteers FLUSH     ┃
   ┃    bindExtensions()       the child's session_start                      ┃
   ┃    resolveVisibleTools → setActiveToolsByName                            ┃
   ┃    exitSubagentSpawn()    ◆ depth = 0   ← the bracket ends HERE, not     ┃
   ┃                              at the end of the run                       ┃
   ┃    runTurnLoop: if (signal.aborted) throw ABORTED_BEFORE_START           ┃
   ┃                                                                          ┃
   ┃    MEASURED on this box: the record reads `running` with no session for  ┃
   ┃    the whole of it, and a spawn that failed reached settlement at        ┃
   ┃    ~16.5 s. A steer accepted in this window is AI3.                      ┃
   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                                 ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, SessionManager.inMemory            │
   │    own system prompt · own tool set · own window · own event bus           │
   │    model := options.model ?? findModelInRegistry(agentConfig?.model, …)    │
   │    ceiling maxTurns (40) → wrap-up steer → hard abort graceTurns later     │
   │    onCompaction ✋ anchors only into a run that is still going             │
   │    NO Agent tool — there are no sub-subagents (EXCLUDED_TOOL_NAMES)        │
   └──────────────────────────┬─────────────────────────────────────────────────┘
                              │ the run settles — status TERMINAL,
                              │ SLOT STILL HELD, `settled` still false
                              ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  THE VERIFIER, inside the settlement chain's .then  (§6)                     │
   │    SUBAGENT_VERIFY / _ROUNDS / _TIMEOUT_MS all read HERE, together           │
   │    ✋ VERIFY=0 · ✋ the record IS the verifier · ✋ empty answer             │
   │    ✋ cut off · ✋ died on the provider · ✋ no brief                        │
   │       — six free refusals, each with its own badge, all REPORTED             │
   │    → judge   a fresh __verifier session, 1 turn, no tools, no history        │
   │              parseJudgeVerdict: NEGATIVE first, and NEGATIVE means           │
   │              NOT_ADDRESSED *or* UNADDRESSED                                  │
   │    → repair  the CHILD's own session, 1 turn, the WHOLE brief                │
   │    → judge again → … up to `rounds`                                          │
   │    rewrites record.result IN PLACE, so every reader sees ONE answer          │
   └──────────────────────────┬───────────────────────────────────────────────────┘
                              │ .finally: settlementCount++, ▣pendingSteers
                              │           REPORTED (AI3), release slot, tally,
                              │           drainQueue, open the gate
              ┌───────────────┴────────────────┐
              ▼                                ▼
   ┌────────────────────────┐    ┌──────────────────────────────────────────────┐
   │ FOREGROUND             │    │ BACKGROUND / CONTINUATION                    │
   │  the completion gate   │    │  tallyCompletion → onComplete                │
   │  resolves the promise  │    │   → coordinator.onAgentComplete              │
   │  coordinator.spawn     │    │   → scheduleNudge → ▣pendingNudges (200 ms)  │
   │  has been awaiting     │    │   → emitIndividualNudge                      │
   │        │               │    │        ✋ disposed ✋ no pi ✋ no record     │
   │        ▼               │    │           — all three REPORT (§11.1, 15th)   │
   │  formatResultContent   │    │        ✋ compactionInFlight() → HOLD, and   │
   │        │               │    │           re-ask in 5 s  → back into ▣       │
   │        ▼               │    │        capBackgroundResult(ctx, …)           │
   │  the Agent TOOL RESULT │    │           spill file, bounded at 50          │
   │  → the guard's cap     │    │        pi.sendMessage({subagent-result},     │
   │  → THE PARENT MODEL    │    │                       followUp, trigger)     │
   └────────────────────────┘    │             │                                │
                                 │             ▼                                │
                                 │  ENTRY POINT 2, and a `void` return          │
                                 │                                              │
                                 │  …and if the SESSION ENDS while an id is     │
                                 │  still in ▣pendingNudges: dispose() now      │
                                 │  reports it. That is AI1.                    │
                                 └──────────────────────────────────────────────┘

 ═════════════════════════════════════════════════════════════════════════════════
  E.  A MATRIX EXCHANGE — the only path with a second human on it
 ═════════════════════════════════════════════════════════════════════════════════

    Matrix room                    sidecar (child process, MCP over stdio)
        │  message                        │
        └────────────────────────────────▶│ notifications/claude/channel
                                          ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ prinny-channel · deliverInbound                                          │
   │   classifyMatrixCommand(body) — a leading "/" is decided HERE, FIRST,    │
   │     because the awaitingReply entry depends on the answer                │
   │   ▣lastInbound = { room, messageId }      ← last-write-wins      AI4     │
   │   awaitingReply.set(room, mergeAwaiting(previous, arrival))              │
   │        live      evidence about the ROOM, and never taken back down      │
   │                  except by the empty-turn stand-down                     │
   │        answered  something has been SENT for this message                │
   │        injected  exactly what pi was handed — markLive matches it        │
   │   armDeliverySweep()                                                     │
   │        ├─ refuse ✋▶ reply(reason)               answered = true         │
   │        ├─ local  ─▶ THIS extension performs it   answered = true         │
   │        │            /compact → planCompaction(hasSession, agentRunning)  │
   │        │              busy ✋▶ DEFER → ▣pendingCompaction        AI2     │
   │        │              idle → startCompaction([room])                     │
   │        ├─ run    ─▶ sendUserMessage(text, {expandPromptTemplates:true})  │
   │        │            the receipt says HANDED, not RAN                     │
   │        └─ text   ─▶ sendUserMessage(text, {deliverAs})                   │
   └──────────────────────────────────────────────────────────────────────────┘
                                                                              │
        │  pi echoes the user message back
        ▼
   message_end{role:"user"} ─▶ markLive(text) ── matched on the WHOLE injected
        │                       string. ✋ no match → NOTHING, and the delivery
        │                       sweep is what owns that silence
        ▼
   agent_start ─▶ ◆agentRunning = true ─▶ typing, refreshed every 8 s
        ▼
   message_end{assistant} ─▶ forward:"all" → each message as it finishes
   agent_end               ─▶ ◆lastAssistantText · ◆lastRunEmptyEnding
        ▼
   the model may call the `prinny` TOOL at any point in the run
        ─▶ resolveActionRoom(explicit, ▣lastInbound, liveRooms())
              ✋ TWO live rooms and no explicit room → REFUSE   ← AI4
              one live room → that one · none → ▣lastInbound
        ▼
   agent_settled  (prinny runs SECOND — the loop has already run)
        ◆agentRunning = false · stopTyping()
        forwardResult() ─────────────────────────────────────┐
           forward:"result" → forwardToMatrix(lastAssistantText)
              ✋ nothing to send · ✋ no live room                │
              ✋ TWO live rooms → remembered, and both told       │
              ✋ already sent · ✋ channel down                   │
           empty ending → ✋ compactionInFlight() → HOLD, tell    │
              the room the true reason NOW (AG3)                 │
              else a bounded CONTINUATION, and the room stands    │
              DOWN until markLive fires for the nudge            │
           ✋ retries spent → giveUp, which COUNTS as an answer   │
           tell every live room that got nothing                  │
           retire live rooms · alreadySent.clear()                │
           sweepUndelivered()                                     │
        standAside(▣pendingCompaction, continuationStarted) ◀─────┘
        drainPendingCompaction() → startCompaction(pending.rooms)   ← AI2
              ✋ compactionInFlight() → "already running"

   …and if the CHANNEL STOPS with a request still in ▣pendingCompaction,
   stopChannel() now tells every room in it, before `child = null`.  ← AI2
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, a Matrix answer, a compaction summary and the parent's next call are
six things in one queue. Almost every design decision in the packages is a
consequence — the concurrency default of 1, the verifier's round budget, the
structural gate that refuses to spend a model call on a run that was cut off, the
denial of the `loop` tool to children, the tool-schema folding in `prinny`.

The second constraint, and the one this pass is about, is drawn as **▣** six
times: **when this machine cannot do a thing now, it parks the thing in a single
variable and says a sentence about it.** Four of the five findings are the gap
between that sentence and what happens to the variable.

---

## 2. The substrate: what pi does, and the parts of it that matter

Everything in §4–§9 is an extension bolted to the object described here. Two of
this pass's five findings are properties of it, so it comes first.

### 2.1 The two entry points, and why the difference is not cosmetic

pi has exactly two ways to make the model produce a turn.

| | `AgentSession.prompt()` | `AgentSession.sendCustomMessage()` |
| --- | --- | --- |
| reached by | a human typing · `pi.sendUserMessage()` · a subagent's runner | `pi.sendMessage()` — the only route an extension has |
| slash commands | executes EXTENSION commands, returns without a turn | never |
| **refuses during a compaction** | **yes** — throws (`:807`) | **no** |
| no model / no auth | throws | never checked |
| emits `before_agent_start` | **yes**, and it is the only site in pi | no |
| honours `deliverAs` | via `streamingBehavior` | only on the streaming branch |
| drains `_pendingNextTurnMessages` | **yes**, and it is the only drain | no |
| makes `hasPendingMessages()` true | yes (`_queueSteer`/`_queueFollowUp`) | **no** — it uses the Agent's own queues |
| failure is visible to the caller | throws / rejects | **returns `void`** |

Eight of the seventeen previous passes have a finding that reduces to one row of
this table. AA1 is the `before_agent_start` row. AA3 is the
`hasPendingMessages()` row. AA4 is the `deliverAs` row. Z4 is the
`_pendingNextTurnMessages` row. AB2/AC1/AE4 are the `void` row. AG2, AG3 and AH1
are the compaction row — all three senders through the `triggerTurn` branch now
read the lock, which is where the seventeenth pass left it.

The `void` row is the one that matters most for this pass, because **a promise
made by a `void` function is unverifiable by the promiser**. pi's binding is:

```js
  sendUserMessage: (content, options) => {
    this.sendUserMessage(content, options).catch((err) => {
      runner.emitError({ extensionPath: "<runtime>", event: "send_user_message", … });
    });
  },                                                    agent-session.js:1855
```

and `emitError` fans out to `runner.errorListeners`, a set with exactly one
possible member, registered only when a UI has bound one. **Outside a TUI there
is nobody in it.** There is no error event in `ExtensionEvent` for an extension
to subscribe to. So every asynchronous failure of either entry point is invisible
to the extension that caused it, and the only `try`/`catch` that can ever fire
around one is for a synchronous `runtime.assertActive()` throw on a stale
extension runtime.

That is why `prinny-channel` has a *delivery sweep*: it cannot observe a failed
send, so it watches for the absence of the success instead. AB2 built it, AE4
extended it to the empty-turn continuation, and it is the one mechanism in this
stack that treats a promise as something to be checked rather than assumed.
**`pi-subagents-lite` has no equivalent**, which is why AC1, §11.1 and now AI1
are all the same shape: the coordinator's only tool is to say something at the
moment it decides, because nothing later will notice.

### 2.2 The three nested units

Getting these wrong is responsible for eight findings across five passes
(W1, X1, X2, X3, V1, V2, Z1, Z3), so they are worth stating flatly.

```
   ┌─ PROMPT ─ one prompt() or sendCustomMessage(triggerTurn) ─────────────────┐
   │  ┌─ RUN ─ agent_start … agent_end.  pi-loop-mode's "iteration". ───────┐  │
   │  │  ┌─ TURN ─ one assistant message + its tool results. `turn_end`. ─┐ │  │
   │  │  │  ┌─ MESSAGE ─ one assistant reply. `message_end`. ──────────┐  │ │  │
   │  │  │  │  content: [ {text} | {thinking} | {toolCall} ]           │  │ │  │
   │  │  │  └──────────────────────────────────────────────────────────┘  │ │  │
   │  │  └────────────────────────────────────────────────────────────────┘ │  │
   │  └──────────────────────────────────────────────────────────────────────┘ │
   │  _handlePostAgentRun() may start ANOTHER RUN: a retry, a compaction,      │
   │  or a queued continuation.  So one PROMPT is one-or-more RUNs.            │
   └───────────────────────────────────────────────────────────────────────────┘
```

Four things follow, and each cost a finding:

1. **A turn can contain more than one assistant message.** pi's inner
   `while (hasMoreToolCalls || pendingMessages.length > 0)` runs another
   assistant message whenever a steer or follow-up arrives mid-turn — and
   `pi-subagents-lite` delivers every background result exactly that way. So
   "what the model said this turn" is not `messages[messages.length - 1]`.
2. **Since 2026-08-17 a message can be reasoning-only.**
   `patches/forge_reasoning_passthrough.py` stopped forge discarding
   `reasoning_content` when there was no accompanying text, so a turn that
   thought and did not answer arrives as `content: [thinking]` rather than
   `content: []`. Every predicate that meant "said nothing" and was written as
   "has no content blocks" silently changed meaning on that date.
3. **A message queued during a run is consumed BY that run.** The outer
   `while` feeds follow-ups back into the inner loop, so two Matrix messages
   that arrive while pi is busy are both answered inside one `agent_end`. That
   single fact is the premise of AF1, of **AI2** and of **AI4** — it is what
   makes "two rooms at once" the ordinary case rather than a race.
4. **`agent_end` is not one event per prompt.** `_handlePostAgentRun()` restarts
   the loop for a retry, a compaction or a queued message, and each restart ends
   in another `agent_end`. AH6 is that fact meeting `clearPendingTimer()`.

And one thing that is easy to assume and is false: **pi awaits every `agent_end`
handler before the run settles.** `Agent.subscribe`'s own docstring says so —
*"Listener promises are awaited in subscription order and are included in the
current run's settlement… the agent does not become idle until all awaited
listeners for that event have settled"* — and `_handleAgentEvent` does
`await this._emitExtensionEvent(event)` before anything else. So the loop's goal
check, which may run for `checkTimeoutSeconds` (120 s by default), holds the
whole session open for its duration. That is not a defect; it is the window AF3
is about, and it is why an operator can type into it.

### 2.3 What `_checkCompaction` does, and where

pi auto-compacts from exactly two places, and both are **outside** the agent
loop:

```
   AgentSession._handlePostAgentRun()   :776   after agent.prompt() resolved
   AgentSession.prompt()                :865   before the next run starts
```

Nothing compacts *between the turns of a run*. That single fact is the whole of
Z2: `pi-subagents-lite` anchors a child's task after a compaction with
`session.steer()`, and a steer is not a way to put text in a context — it is a
way to put text in a context **and get an answer to it**, because
`_handlePostAgentRun()` restarts the loop precisely when the steering queue is
not empty. `compaction-anchor.ts` is the predicate that tells the two call sites
apart.

### 2.4 `compact()`, in the order it does things

AG2, AG3, AH1, and this pass's AI1 and AI2 all live here, so this is the sequence
in full:

```
   AgentSession.compact(customInstructions)                          :1367
     await this.abort()                    ← abort(), then waitForIdle().
                                              THE SESSION IS IDLE FROM HERE.
     this._compactionAbortController = new AbortController()
                                           ← from HERE prompt() refuses
     emit compaction_start                 ← INTERNAL. Not an ExtensionEvent.
     …auth, prepareCompaction(pathEntries, settings)
        ✋ no preparation → "Already compacted" / "Nothing to compact"
     emit session_before_compact  { preparation, branchEntries, … }
        ✋ result.cancel  → throw "Compaction cancelled"
        result.compaction → use it and skip the model entirely
     …else a real summarisation MODEL CALL on the one llama slot
     sessionManager.appendCompaction(summary, firstKeptEntryId, …)
     this.agent.state.messages = sessionContext.messages     ← REPLACED
     emit session_compact
     this._compactionAbortController = undefined
     emit compaction_end
```

And the wrapper an extension actually calls:

```js
  compact: (options) => { void (async () => {
      try { const result = await this.compact(options?.customInstructions);
            options?.onComplete?.(result); }
      catch (error) { options?.onError?.(err); }
  })(); },                                                        :1911
```

Fire-and-forget, with exactly one of the two callbacks guaranteed on every path.
That guarantee is what lets the compaction lock (§10.2) use a plain
take/release rather than a queue — and the five-minute staleness bound is the
backstop for a future pi that changes it. **It is also the reason AI2's fix is
safe**: `startCompaction` can hand the same `onComplete` a list of rooms and know
it will run once.

Three consequences worth keeping:

- The window between `await this.abort()` and the controller being assigned is
  a real one. It is a microtask, not a scheduling risk in practice, but it means
  "a compaction is running" and "`prompt()` will refuse" are not the same
  instant.
- **`agent.state.messages` is REPLACED at the end.** A run started during a
  compaction is streaming into an array that is about to be thrown away.
- **The session is IDLE for the whole compaction**, because `abort()` ends with
  `waitForIdle()`. So for a sender through `sendCustomMessage`, the
  `_runAgentPrompt` branch is not merely *reachable* during a compaction — it is
  **the only branch available**. `isStreaming` is false, so neither
  `agent.steer()` nor `agent.followUp()` can be taken.

### 2.5 How long a compaction lasts, and why that is AI1's severity

A compaction on this stack is a summarisation **model call** on a 27B behind one
llama slot, over a context that is by construction near the window ceiling. The
lock's own `STALE_MS` is five minutes, chosen as the bound past which a holder is
read as absent — that number is the stack's own estimate of the worst case.

`SpawnCoordinator.emitIndividualNudge` re-asks every `COMPACTION_WAIT_MS`
(5 seconds) while the lock is held, putting the agent id back into
`pendingNudges` each time. So **the interval during which a finished
delegation's answer is sitting in a one-slot batch set went from 200 ms to as
much as five minutes when AH1 landed**, and AI1 is what happens if the session
ends inside it.

That is worth stating as a general shape rather than as a fact about one field:
**a fix that converts a drop into a wait converts a narrow window into a wide
one, and every teardown path that crosses that window inherits the question.**

### 2.6 What the extension runner guarantees

```js
  async emit(event) {
    const ctx = this.createContext();
    for (const ext of this.extensions)            ← LOAD ORDER
      for (const handler of ext.handlers.get(event.type) ?? [])
        try { await handler(event, ctx); }        ← SEQUENTIAL, AWAITED
        catch (err) { this.emitError({…}); }      ← a throwing handler is
  }                                                  reported, not fatal
```

Three things this settles:

- **Handlers run in load order, one at a time, each awaited.** So "the loop's
  `agent_settled` runs to completion before prinny's begins" is a fact, not a
  hope — and it is the premise AG3 rests on.
- **A throwing handler cannot break the event.** Every extension in this stack
  relies on that and most also swallow their own errors anyway.
- `emitMessageEnd`, `emitToolResult`, `emitContext` and `emitBeforeAgentStart`
  are separate methods with their own merge rules. `emitContext` does
  `structuredClone(messages)` once and then **threads** each handler's returned
  array into the next, which is what makes the loop/guard budget-notice
  stand-down work in either order. `emitToolResult` threads one shallow copy and
  merges `content` / `details` / `isError` / `usage` per handler, which is how
  `compaction-guard` caps a result the loop has already fingerprinted.
- `session_before_compact` is the odd one out: it goes through the generic
  `emit()`, so results are **last truthy wins and are not threaded**. When
  `pi-loop-mode` returns a `{compaction}` — which it does on a small window — pi
  uses that and never reads `preparation.previousSummary` at all, which is why
  the guard's notice says what it DID rather than what pi will do with it.

### 2.7 `pi.exec`, and the two facts it cannot tell you

This is the host function behind AA2, AB3, `git-failure.ts`, AH3 and **AI5**, so
it gets its own section.

```js
  //  ExtensionAPI.exec  =  execCommand   (core/exec.js, via loader.js:287)
  return new Promise((resolve) => { … })      ← NO `reject` IN THE BODY
  …
  resolve({ code: code ?? 0, stdout, stderr, killed })
```

Two things follow, both **measured against the real function** by
`context/testing/probes/v5-…` rather than assumed:

```
   1  it NEVER rejects. A timeout kills the child and resolves; a spawn error is
      caught and resolves `code: 1`; a non-zero exit resolves. So a `catch`
      around it is unreachable, and for two passes `checkErrorStreak` never
      advanced. (AA2)

   2  a SIGNALLED child exits with a signal and NO code, and `code ?? 0` turns
      that into a ZERO. Measured, this pass, against pi 0.84.2:

        bash -lc 'echo hi'                → { code: 0, killed: false }  success
        bash -lc 'exit 3'                 → { code: 3, killed: false }  failure
        bash -lc 'kill -9 $$'             → { code: 0, killed: false }  ← OOM
        bash -lc 'sleep 5'  (timeout 300) → { code: 0, killed: TRUE  }  ← timeout
                                              ▲ the shape of a SUCCESS that
                                                printed nothing

   and `killed` is only pi's OWN kill: `killProcess()` has exactly two callers,
   the timeout timer and the caller's AbortSignal. An OOM kill, an operator's
   `pkill` or a container going down all come back { code: 0, killed: false }.
   (AB1 — open by decision, and unfixable from inside `ExecResult`.)
```

**So `killed` is read before `code`, everywhere, or a wedged command reads as a
success returning the empty string.** AH3 enumerated that rule across
`vendor/pi-subagents-lite`; **AI5 is the same enumeration for the file AH3
reached into by hand and did not put behind the gate.**

---

## 3. The event bus

Rebuilt from the source in the sixteenth pass (AG4 was that five documents drew
it wrong); re-derived here and unchanged.

```
   event                    loop   guard  subag  prinny  rtk    threading
   ─────────────────────────────────────────────────────────────────────────────
   session_start             ✓             ✓      ✓             ignored
   session_shutdown          ✓             ✓      ✓             ignored
   session_before_compact    ✓      ✓                           LAST TRUTHY WINS
   session_compact           ✓                                  ignored
   before_agent_start        ✓                                  threaded
   before_provider_request   ✓                                  threaded
   context                   ✓      ✓                           structuredClone,
                                                                 then threaded
   message_start             ✓                                  ignored
   message_update            ✓                                  ignored
   message_end               ✓                    ✓             THREADED, written
                                                                 back IN PLACE
   turn_start                              ✓                    ignored
   tool_call                               ✓      ✓      ✓      block-only; the
                                                                 EVENT IS MUTATED
   tool_result               ✓      ✓                           one object, fields
                                                                 merged per handler
   agent_start                                    ✓             ignored
   agent_end                 ✓                    ✓             ignored
   agent_settled             ✓                    ✓             ignored
   ─────────────────────────────────────────────────────────────────────────────
   handler count            13      3      4      7      1
```

`context/testing/probes/t5-the-event-bus-the-map-draws.mjs` re-derives this table
from the source and diffs it against any document given as an argument; this one
passes it, and so do the seven before it.

### 3.1 The four orderings that decide behaviour

```
   context        loop FIRST. It appends `loop-context-budget`; the guard sees
                  the shared `-context-budget` suffix and stands down. BOTH
                  sides check, and emitContext THREADS the returned array, so
                  neither ordering can produce two notices.                 ✔

   tool_result    loop FIRST. It fingerprints the RAW output into the stuck
                  window; the guard's cap runs after. The loop also strips any
                  shortening marker before fingerprinting, so the ordering is
                  belt-and-braces rather than load-bearing.                 ✔

   tool_call      prinny FIRST, then rtk, then subagents. NOT symmetric,
                  because `{block:true}` returns from `emitToolCall`
                  immediately — so a blocked call never reaches rtk's rewrite
                  or the subagent model injection.                          ✔

   agent_settled  loop FIRST (it may request an emergency compaction), prinny
                  SECOND (it may continue an empty run, then compact). Both
                  halves are closed by the shared lock.                     ✔
```

**And two things that are not on the bus at all**, which is what this pass turns
on:

- **the background nudge** is on a `setTimeout`, not on the bus. It is not
  ordered against `agent_settled`, against a compaction, or against anything
  else. AH1 could not have been found by reading the table above, and AI1 could
  not have been found by reading AH1's fix — the id is in a set, and the only
  question worth asking about a set is *who empties it*.
- **the `prinny` tool** runs inside `executeToolCalls`, i.e. in the MIDDLE of a
  turn, while `awaitingReply` holds whatever `deliverInbound` last put there.
  Every other write to Matrix in that package happens at `message_end` or
  `agent_settled`, where the room set is stable. AI4 is the one write that
  happens while the model is still mid-thought.

A note that has survived six passes and still holds: **the `tool_call` row is
the only place a shell command can be reviewed.** `pi.exec` — which the loop's
goal check, rtk's version probe, the subagent git probes and `/stack` all use —
is `execCommand` directly and emits nothing on this bus. That is why `--check` is
refused from Matrix (AD6): one string, two doors, and only one of them is
watched.

---

## 4. `vendor/pi-loop-mode` — the unattended run

3,252 lines in `extensions/index.ts` plus nine modules under `src/`. A fork of
upstream 2.5.4; `FORK.md` has the full diff rationale.

**What it is for.** An operator sets a goal and walks away. The extension then
sends one turn after another into the same session, watches what comes back, and
answers each outcome with a different directive — for hours or days, without a
human. Everything else in the package exists because that run must never stop on
its own and must never silently stop advancing either.

### 4.1 The thirteen handlers, and what each one is watching

```
   session_start           restore ◆state from the branch; auto-resume a run
                           that was active when pi exited
   session_shutdown        clear the pending timer and the per-turn buffers
   session_before_compact  replace pi's model summary with a locally-built
                           HANDOFF when the window is small or the context is
                           saturated  (LAST TRUTHY WINS, and the guard also
                           answers this event — see §3.1)
   session_compact         adopt a compaction pi did itself, rather than asking
                           for a second one it can only answer "Already
                           compacted"
   before_agent_start      tell an OPERATOR-TYPED turn that a loop is running —
                           as a `message`, never a systemPrompt (AA1)
   before_provider_request frequency/presence penalties + temperature, for
                           PENALTY_TURNS turns after a stuck intervention
   context                 sanitize degenerate assistant messages; append the
                           context-budget line
   message_start           reset the mid-stream degeneration check position
   message_update          MID-STREAM KILL SWITCH: abort a response that has
                           repeated one sentence six times
   message_end             fill the THREE per-turn buffers (see §4.3), and
                           write back a sanitized message
   tool_result             fingerprint the RAW result into the turn's tool
                           buffer; ++toolCallsThisTurn
   agent_end               THE LADDER — everything below
   agent_settled           finalize a soft stop; run the emergency compaction
                           pi declined to do itself
```

Every one of the thirteen begins with `if (!state.active) return` or an
equivalent, and the whole factory begins with:

```ts
  if (bornInsideSubagentSpawn()) return;
```

— because `state`, `runToken`, `pendingTimer`, the four buffers,
`waitingForCompaction` and `deferredDirective` are ◆ module-global, and a child
session binds *this same module* with its own event bus. Without the guard every
handler ran twice per delegation against one `LoopState`: the child's `agent_end`
drove the operator's iteration ladder, delivered the operator's next loop turn
*into the child*, and persisted the operator's state into the child's throwaway
branch. `subagent-denylist.ts` also stops the package being handed to a child at
all, which additionally saves the child ~177 tokens/turn of `loop` tool schema.

### 4.2 `agent_end` — the ladder

This is the heart of the package. Eighteen exits, in order, and the order is the
design: the guards that mean "this turn was not a real turn" come first, so the
counters below them are only ever charged for turns that happened.

```
   agent_end
     ✋ !state.active → (unless status "preparing": watch for GOAL_READY) return
     clearPendingTimer()                 token = runToken   ← captured for the awaits
        ▲ AH6 lives on this line. It drops the loop's ONE ▣ timer slot, which is
          also where an AG2 deferral parks a directive that has already been
          charged four lines further down.
     ── drain the per-turn state, ONCE, into locals ──────────────────────────
        toolCallsThisTurn      state.toolCallsThisTurn → 0
        turnTexts/Calls/Answers/Emitted   the four buffers → []
        penaltyTurnsRemaining--            ← aged HERE, not on the happy path
        degenerateAbortThisTurn            ← read into a local, flag cleared
     ── derive the three questions a turn can be asked ──────────────────────
        turnAnswerText   the last message that ANSWERED   (text only)
        turnEmittedTexts every message, text AND thinking (for the degenerate
                         rule, which is about ONE response)
        committedText    what commitTurnMemory actually put in the window
     ─────────────────────────────────────────────────────────────────────────
      1  softStopRequested          → finalizeSoftStop                  RETURN
      2  isContextPressure(...)     → ++consecutiveErrorCount
                                       ≥3 → enterContextCooldown        RETURN
                                       else ▣contextRecoveryPending     RETURN
      3  !lastAssistant | error     → ++providerErrorStreak
                                       ≥10 → pauseForProviderFailure    RETURN
                                       else backoff 5,10,…,300 s        RETURN
      4  aborted && degenerateAbort → interveneStuck                    RETURN
      5  aborted (operator's Esc)   → active=false, status "paused"     RETURN
     ── from here the turn COUNTED ──────────────────────────────────────────
        consecutiveErrorCount = 0 · providerErrorStreak = 0
        contextCooldownCount = 0 · contextCompressionLevel = 0
        ++iterationCount   turnsWithoutTools±   commitTurnMemory()
      6  rescueActive               → switch back to the loop model
                                       → `continue`, guarded              RETURN
        stuckReason = detectStuck(committedText, turnEmittedTexts)
        if (!stuckReason) consecutiveStuckCount = 0
      7  checkCommand               → await runGoalCheck()      ← up to 120 s
                                       execFailed ≥3 → pauseForCheckFailure
                                       untilDone && passed → COMPLETED   RETURN
      8  LOOP_DONE                  → ++doneSignalCount
                                       untilDone && check disagrees
                                            → stuck? interveneStuck      RETURN
                                            → `check_failed`             RETURN
                                       untilDone → COMPLETED             RETURN
                                       endless  → stuck? interveneStuck  RETURN
                                                → `improve`              RETURN
      9  LOOP_BLOCKED               → stuck? interveneStuck              RETURN
                                       → `unblock`                       RETURN
     10  maxIterations reached      → paused                             RETURN
     11  scoreRegressed             → `regression`                       RETURN
     12  stuckReason                → interveneStuck                     RETURN
     13  no state change in 8 iters → `audit`                            RETURN
     14  ── Normal continue ──      → `continue`
```

Six of those exits carry a DIRECTIVE — `improve`, `unblock`, `check_failed`,
`regression`, `audit` and `stuck` — and go through `deliverLoopTurn()` /
`interveneStuck()`, which send the text onto the turn that is already coming when
a message is pending rather than dropping it. `continue` deliberately still
drops: any turn advances an endless loop, and injecting 1,200 characters of loop
rules onto a turn the operator typed for their own reasons is the other kind of
mistake. That asymmetry is AF3.

The six directive kinds are a named set — `DIRECTIVE_KINDS` — because AH6 needed
to distinguish "text the ladder has already been charged for" from "a turn that
merely has to happen".

### 4.3 Why there are three per-turn text buffers

A turn is asked three different questions and they need three different units.
Getting this wrong cost four findings (W1, X1, X2, V2):

```
   turnAssistantTexts  text || thinking, one entry per MESSAGE
                       → the repetition WINDOW's feed. commitTurnMemory
                         collapses the turn to ONE entry.
   turnAnswerTexts     text only
                       → "did this turn ANSWER?" — LOOP_DONE, LOOP_BLOCKED,
                         and the starvation rung all read this.
   turnRepetitionTexts text AND thinking, per message, UNSANITIZED
                       → the degenerate-repetition rule, which is about a
                         SINGLE response, and "did the turn think at all".
```

The third is unsanitized on purpose: `sanitizeDegenerateText` cuts the repetition
out and replaces it with a marker, so a detector run over the sanitized text
finds nothing and the turn that degenerated is never charged. The first two want
the sanitized text, because that is what the model sees next turn.

### 4.4 `detectStuck` — eight rules

All eight are gated on the CURRENT turn's committed text, which is what makes
them facts about the turn rather than about the window.

```
   1  a sentence/word/phrase repeated ≥4× inside ONE message   (degenerate)
   2  turnsWithoutTools ≥ 3                                    (narration only)
   3  the last two fingerprints identical, answer > 80 chars
   4  the last three fingerprints identical, answer > 0 chars
   5  Jaccard(trigrams) ≥ 0.80 vs the previous answer          (near-duplicate)
      — BOTH sides cut to PERSISTED_WINDOW.textChars, or a long answer can
        never reach the threshold against a stored prefix                  [W2]
   6  the same fingerprint ≥3× in the 8-slot window            (A-B-A-B)
   7  the same TURN tool signature 3 turns running
      — one entry per TURN, so three greps inside one turn cannot trip it
   8  the same question repeated, when the answer ends in "?"
```

### 4.5 The four escalation ladders, and where each one stops

```
   FIXATION (interveneStuck)               ── never pauses the run ──
     every call:  ++consecutiveStuckCount, ++interventionCount,
                  penaltyTurnsRemaining = 3, turnsWithoutTools = 0
     saturated context (≥80%)? ─────────────▶ skip to the compaction rung
     streak ≥3 && rescueModel  ─────────────▶ switch model, one `rescue` turn
     streak ≥5 (or saturated)  ─────────────▶ ctx.compact()
                                              ✋ compactionInFlight() → wait
     otherwise                 ─────────────▶ a rotating STUCK_STRATEGY,
                                              delivered even when a message
                                              is pending                 [V4]
     streak ≥3 also adds a HARD RESET block: banned openings, "your FIRST
     action must be a tool call, zero preamble"

   CONTEXT (isContextPressure → ▣contextRecoveryPending → agent_settled)
     rungs:  stopReason "length" with ≤32 output tokens
             stopReason "length" at ≥85%
             stopReason "error" matching /400|context|token|length/ at ≥85%
             an explicit overflow message at ANY percent
             a clean "stop" with NO ANSWER at ≥80%         ← the starvation rung
     3 consecutive  ─▶ enterContextCooldown, 60 s doubling, summary tightened
     3 cooldowns    ─▶ pauseForContextFailure  ── the run STOPS ──

   PROVIDER
     ++providerErrorStreak, backoff 5·2ⁿ capped at 300 s
     10 consecutive ─▶ pauseForProviderFailure  ── the run STOPS ──
     Ten, not three, deliberately: a provider error is usually transient and an
     unattended run should ride out a restarted llama-server.

   GOAL CHECK
     3 consecutive checks that COULD NOT RUN ─▶ pauseForCheckFailure
     — the one place carrying on is worse than stopping, because in
       `--until-done` the check IS the terminating condition.
```

### 4.6 The goal check, and the two things pi cannot tell you

`--check "CMD"` runs once per iteration:

```ts
  pi.exec("bash", ["-lc", wrapCheckCommand(state.checkCommand)],
          { timeout: state.checkTimeoutSeconds * 1000 })
```

`ExecResult` is `{ code, stdout, stderr, killed }`, and §2.7 has the two facts
missing from it. Both cost a finding (AA2, AB1). The answer had to come from
inside the child, so the command runs under a bash `EXIT` trap that prints a
marker:

```ts
  trap 'printf "\n__PI_LOOP_CHECK_COMPLETED__:%d\n" "$?"' EXIT
  (
  <the check command>
  )
```

Marker present → bash reached its own exit and `result.code` is the real answer.
Marker absent → the process died without finishing; not a failing check, an
absent one. The **subshell** is AC3's repair: a bash `EXIT` trap is one slot, not
a stack, so `trap 'docker compose down' EXIT; docker compose run tests` — the
shape of every cleanup one-liner, and `/loop prepare` asks a model to *write* the
check — replaced the wrapper's trap and made a perfectly good check read as one
that died. `exec` discards traps entirely, and had the same effect.

The marker's VALUE is deliberately not used: reading an exit code out of the
child's own stdout would let a check that prints attacker-controlled text choose
its own verdict. Presence is the only signal taken.

**This is the first instance of the `killed`-before-`code` rule in the stack**,
and §10.4 has the other sixteen.

### 4.7 The compaction work, which is most of the fork

pi's own compaction is wrong for a 32k window in three separate ways, all
measured over 42 real compaction points under `~/.pi/agent/sessions`:

```
   1  shouldCompact() turns true at 50% of the window, but prepareCompaction()
      returns undefined until the context exceeds keepRecentTokens — so from
      50% to ~66% pi decides to compact every turn and silently does nothing.
   2  When it does fire it keeps keepRecentTokens (20,000 = 61% of a 32k
      window) plus the new summary, so the FLOOR after a compaction is higher
      than the cliff at which the model starts failing.
   3  The summary is merged into the previous one under a prompt that says
      "PRESERVE all existing information", so it grows monotonically:
      1,666 → 3,183 → 5,891 → 9,411 → 11,054 chars in one run, after which
      compaction freed nothing at all and the session sat at 94–96% full.
```

`scripts/pi-local.sh` fixes (1) and (2) globally by sizing `reserveTokens` and
`keepRecentTokens` from `CTX_SIZE`. `compaction-guard` fixes (3) for every
session (§7). `pi-loop-mode` additionally replaces the whole compaction with a
**handoff** whenever the window is ≤64k or the context is ≥80% full:

```
   buildHandoffCompaction
     a bounded summary that does not grow — level 0 is ~4,000 chars, the same
     on iteration 400 as on iteration 4
     sections allocated by WHAT CANNOT BE RECOVERED ANY OTHER WAY, not by
     position:   goal ▸ state ▸ criteria ▸ files ▸ durable excerpts
     each section holds MIN_SECTION_CHARS back for the ones after it
     the cut point is findHandoffCutEntryId — the start of the LAST TURN,
     falling back to the newest stand-alone message when that turn is itself
     oversized, and finally to pi's own cut, which is always valid
     and NO MODEL CALL AT ALL — which matters because after an overflow the
     summariser is the same model that just refused this context
```

### 4.8 The `loop` tool, and the one place the fork widened the surface

Upstream exposes loop control only as `/loop`, which means only a human can start
one — the model cannot type a slash command. The fork registers a `loop` tool as
well, and the interesting part is what it refuses:

```
   TOOL_ACTIONS = { start, stop, status, finish, resume, end, stats }
     ✋ anything else → isError, naming the valid set.
        The command's LAST branch treats an unrecognised word as a GOAL and
        starts an endless loop on it, which is right for a human and a live
        grenade for a model that invents a verb.
   ✋ start with a loop already running → isError, naming the running goal.
   ✋ the `goal` parameter is NEVER handed to the flag parser.
        parseStartArgs scans the WHOLE line for flags, so a goal containing
        `--check "<shell>"` used to become a command run every iteration for
        the life of the run. The tool now builds a StartArgs literal.
```

### 4.9 The loop's three one-slot queues, and what empties each

This is the section this pass exists to write for every package, and the loop is
the one where all three answers are already right. §13.2 is the working.

```
   ▣ pendingTimer          the next iteration, or a watchdog re-arm.
     written by            scheduleLoopTurn · scheduleWatchdogTurn
     emptied by            the timer firing · clearPendingTimer(), from
                           agent_end's first line and from ten lifecycle
                           transitions
     what is said          nothing — and for a `continue` nothing needs to be,
                           because the agent_end that cleared it schedules
                           another. For the six DIRECTIVE kinds AH6 remembers
                           the KIND in ▣deferredDirective instead, so the text
                           the ladder was charged for rides the next turn.  ✔

   ▣ deferredDirective     the KIND of a directive held back for somebody
                           else's compaction.
     written by            sendLoopTurn, on the deferral branch, for
                           DIRECTIVE_KINDS only
     emptied by            the next sendLoopTurn (which sends it) ·
                           resetContextRecovery(), i.e. start, resume, stop,
                           end, soft stop, session start and session shutdown
     what is said          the deferral notice names the holder and the
                           iteration. A session swap drops it deliberately —
                           "a directive belongs to the run it was decided
                           for" — and `session_start`'s auto-resume sends a
                           `resume` turn, which is the honest replacement.   ✔

   ▣ contextRecoveryPending  a compaction the loop wants, deferred from
                           agent_end to agent_settled so pi's own overflow
                           recovery goes first.
     written by            agent_end's context-pressure rung
     emptied by            agent_settled (which acts on it) · session_compact
                           (which adopts pi's own) · a successful turn
                           (which proves the context fits) ·
                           enterContextCooldown · resetContextRecovery
     what is said          every one of those paths notifies. The only exit
                           that consumes it silently is a token mismatch, and
                           §13.2 shows that combination is unreachable.      ✔
```

---

## 5. `vendor/pi-subagents-lite` — delegation

16,600 lines across `src/`, of which about half is UI. A fork of upstream 1.11.0.

**What it is for.** The model calls `Agent(prompt, agent, run_in_background?)`
and a *whole second pi session* is built inside this process — its own system
prompt, its own tool set, its own 32k window, its own event bus — runs to an
answer, has that answer checked, and hands it back. `StopAgent` and `AgentStatus`
are the model's two other handles on it; `/agents` is the operator's.

### 5.1 A record's life

```
   spawn(pi, ctx, type, prompt, options)
     id = randomUUID().slice(0, 8)
     ✋ slot full            → QUEUED (this.queue), not refused
     ✋ parent signal ALREADY aborted → stopAgent("user"), never started
     record.execution.promise = createCompletionGate(id)
        ▲ ONE gate per record, from birth, opened exactly once
   startAgent
     slots.reserve · status "running" · started = true · watchdog.start
     ┌── runAgent(...) ── THE BUILD WINDOW, and it is SECONDS  ────────────┐
     │   SettingsManager.create · resolveSystemPromptSources               │
     │   detectEnv()  two git subprocesses on a 9p mount                   │
     │   enterSubagentSpawn() → reloadAndMap() → every extension factory   │
     │   createAndConfigureSession → onSessionCreated(session)             │
     │        ▲ record.execution.session is set HERE, and                  │
     │          ▣pendingSteers is flushed HERE — see AI3                   │
     │   bindExtensions → the child's session_start                        │
     │   exitSubagentSpawn()                                               │
     │   runTurnLoop: if (signal.aborted) throw ABORTED_BEFORE_START       │
     └─────────────────────────────────────────────────────────────────────┘
   attachSettlementChain(record, runPromise, verifyDeps)
     .then    status = classifyRun(...)  ← aborted > modelError > turnLimited
              record.result = responseText
              await runVerification(record, deps)          ← §6, and it is
                                                             SLOW: model calls
              record.error = formatModelError(...) if any
              record.stats.contextPercent · completedAt ??= now
     .catch   status = "error" unless already "stopped"
              record.result = undefined     ← a failed continuation must not
                                              leave the prior answer visible
     .finally ++settlementCount
              reportUndeliveredSteers(record)      ← AI3
              outputLog.finalize() · slots.release()
              tallyCompletion() → onComplete → coordinator
              drainQueue() · detachParentBinding()
              openGate(record.id, record.result ?? "")
              record.execution.settled = true
```

Two properties of that chain are load-bearing and non-obvious:

- **the status goes terminal BEFORE the verifier runs.** Every stop path keys
  off `status === "running"`, so a record whose answer is being checked was
  unstoppable until T5 added `record.execution.verifyAbort` and
  `isVerifyingRecord`. Four separate readers now ask "is this record busy?"
  through `record-activity.ts` rather than through the status.
- **the slot is released in the `.finally`, after the verifier.** A judge that
  asked for a slot would wait for a slot that is waiting for the judge, which at
  this fork's default of 1 is a deadlock rather than a slowdown — which is why
  `buildVerifyDeps.judge` calls `runAgent` directly and disposes the session
  itself.

### 5.2 The background nudge, which is the one path with no second attempt

```
   onAgentComplete(record)
     backgroundAgentIds.delete(id) || settlementCount >= 2
        → scheduleNudge(id) → scheduleNudgeIn(id, 200 ms)
                                 ▣pendingNudges.add(id)
                                 if (nudgeTimer) return      ← ONE timer
                                 nudgeTimer = setTimeout(drain, delayMs)
   drain:  nudgeTimer = null; batch = [...pendingNudges]; pendingNudges.clear()
           for (id of batch) emitIndividualNudge(id)

   emitIndividualNudge(id)
     record = manager.getRecord(id)         ← FIRST, so a drop can name it
     ✋ disposed        → reportDrop("session-replaced")
     ✋ !getPiInstance  → reportDrop("no-runtime")
     ✋ !record         → reportDrop("record-gone")
     ✋ compactionInFlight() → describeNudgeHold, then scheduleNudgeIn(id, 5 s)
                              ← AH1. Back into ▣pendingNudges, over and over,
                                for as long as the lock is held (≤ 5 minutes)
     capBackgroundResult(text, ctx, type, id)     ← §7's numbers, its own spill
     pi.sendMessage({customType:"subagent-result"}, {deliverAs:"followUp",
                                                     triggerTurn:true})
     catch → console.warn + the spawning session's notify

   dispose()   ← session_shutdown
     clearTimeout(nudgeTimer)
     undelivered = [...pendingNudges];  pendingNudges.clear()
     …
     for (id of undelivered) reportDrop("session-ending", id, getRecord(id))
        ▲ AI1. This loop is the finding. Without it the ids were cleared and
          nothing was said — and the `session-replaced` guard above, whose own
          docstring names `session_shutdown`, can only fire for a record that
          settles AFTER this point.
```

Why this path gets no second attempt, spelled out because it is the reason AH1
and AI1 are both MEDIUM rather than LOW:

```
   sendLoopTurn        AG2   RESCHEDULES. The same iteration goes 5 s later.
   forwardResult       AG3   HOLDS, charges no retry, tells the sender to ask
                             again — there is a person who can.
   emitIndividualNudge AH1   runs ONCE per record, from a 200 ms batch TIMER
                             (so it is not ordered against anything on the bus),
                             on a record whose slot is already released and whose
                             completion gate is already open. `record.result` is
                             the only copy of the answer, and there is nobody to
                             ask.
```

### 5.3 The three surfaces an operator or a model acts through

```
   the model     Agent · StopAgent · AgentStatus
                 — AgentStatus prints `id (type) status` and NEVER the result
   the operator  /agents → the widget → per-agent actions, including
                 "View result", which is the ONLY surface that shows
                 `record.result`                                        [AG6]
   the harness   the watchdog (45 min tool / idle), the per-call verify
                 deadline (5 min), and the parent run's AbortSignal
```

Every manager method that an operator can reach answers with a boolean, and each
`false` is a deliberate refusal. `ui/action-report.ts` turns those booleans into
sentences (AF2), and since this pass it also owns the sentence for a steer that
was accepted and never delivered (AI3) — the same module, because it is the same
question: *what does the operator get told about an action they were told
succeeded?*

### 5.4 The concurrency slot, and why the default is 1

`SlotTable` keys by model, with a per-model limit and a default. The fork's
default is **1**, because there is one llama slot: two children would not run
twice as fast, they would interleave on the same queue and double every window's
occupancy. The consequences show up everywhere:

```
   a second Agent() is QUEUED, not refused — the tool call blocks on the gate
   continueSettledAgent REFUSES when the slot is full, so at default 1 every
     continuation attempted during another agent's run is refused   [AF2]
   the judge goes AROUND spawn(), because it would deadlock on the slot the
     record it is judging still holds
```

### 5.5 What a child inherits, and what it must not

```
   inherited   .pi/extensions/**   (compaction-guard, browser-guard, stack)
               project skills and prompts, when the project is TRUSTED
   denied      vendor/pi-loop-mode      by subagent-denylist.ts (path regex)
               vendor/prinny-channel    by the same list
               the Agent tool itself    EXCLUDED_TOOL_NAMES — no sub-subagents
   guarded     .pi/extensions/stack.ts  guards ITSELF, by reading
                                        __PI_SUBAGENT_SPAWN_DEPTH__
```

`tests/subagent-denylist.test.ts` is a **standing scan** rather than a list: it
walks `.pi/extensions/` and fails when an extension that registers a tool does
not guard itself. That is the shape AI5 gives `exec-verdicts.test.ts`.

### 5.6 The turn ceiling, and the one-turn exception

A child runs to `maxTurns` (40 by default), then gets a wrap-up steer, then a
hard abort `graceTurns` later. At `maxTurns: 1` — the judge and the repair — no
wrap-up steer is sent at all, because T1 measured that it manufactures a second
provider call whose reply *replaces the verdict*.

### 5.7 The git probes, and the rule they now all read

Five `pi.exec` sites in this package, all git, all reading `classifyGitFailure`:

```
   agent-runner.ts execGit            is-inside-work-tree · branch --show-current
   worktree-validator.ts × 2          rev-parse --git-common-dir · --show-toplevel
   menu-spawn-wizard.ts × 2           worktree list --porcelain · --git-common-dir
```

`git-failure.ts` is the module that states the rule, with the measured table in
its header, and `tests/exec-verdicts.test.ts` is the scan that keeps it applied.
AH3 was the enumeration; **AI5 widens the scan to the other directory the rule
had been applied to by hand.**

---

## 6. The verifier — is the answer an answer to the question that was asked?

`src/agents/verify.ts` (what the verdict is) and `src/agents/verify-runner.ts`
(when to spend a model call on one), plus `verify-log.ts`.

### 6.1 The failure it exists for

A subagent gets a brief it cannot see the context for, works in its own window,
and when that window fills pi compacts it and it carries on from a summary. pi's
summaries are merged under a "PRESERVE all existing information" prompt, so they
grow monotonically — and what they erode first is the oldest thing in the
transcript, which is the brief. A child that has compacted three times is
answering a question that has quietly drifted from the one it was given, and
nothing else in the pipeline notices: `formatResultContent()` hands the parent
whatever the child said last.

### 6.2 Three layers, cheapest first

```
   1  ANCHOR            no model call. After a compaction, restate the brief
                        into the child's freshly-summarised context.
                        ✋ only into a run that is still going — a steer is a
                          way to put text in a context AND GET AN ANSWER TO IT
                          (Z2), so `anchorReachesATurn(info)` gates it.
   2  STRUCTURAL GATE   no model call. Six refusals, each with its own badge:
                        empty answer · the record IS the verifier · aborted ·
                        turn_limited · stopped · died on the provider ·
                        no brief recorded
   3  JUDGE             one model call, in a FRESH __verifier session: no
                        tools, no extensions, no skills, no history, one turn,
                        shown only the brief and the answer.
   →  REPAIR            the CHILD's own session, one turn, the WHOLE brief.
   →  judge again, up to `rounds` (default 1, ceiling 3)
```

Termination is three conditions, not one: the budget, an empty repair, and a
repair identical to the answer just rejected. When every attempt fails the
child's **original** answer goes back, annotated.

### 6.3 The two asymmetries, and both are the design

```
   the JUDGE knows LESS than the child   — asking a model to review its own work
                                           with its own justifications in front
                                           of it gets a ratification
   the REPAIR knows MORE than the judge  — it is the only session with the
                                           context to actually fix the answer
```

### 6.4 Reading the judge

The prompt asks for the verdict FIRST, on its own line, because a local model
allowed to reason first talks itself into agreement by the time it reaches the
verdict. The parser has two passes and the order is the fix:

```
   1  a `VERDICT:` line outranks a bare token anywhere else, scanned
      NEWEST-FIRST (a model that thinks out loud commits last)
        VERDICT_MENU   ✋ "ADDRESSED or NOT_ADDRESSED" is the prompt's own
                          menu echoed back — not a choice. Fall through.
        NEGATIVE first: /(?:NOT[_\s-]?|UN)ADDRESSED/i    ← AH2 widened this
        then /ADDRESSED/i
   2  only if no line decided: the same test over the whole reply, with the
      menu removed and the negative ANCHORED
   unparsed ⇒ ADDRESSED, and the flag is kept so the note can say so
```

Three findings live in those eight lines: S2 (the menu read as a choice), U4 (the
`WHY:` instruction read as a reason) and AH2 (`UNADDRESSED` read as its own
opposite, with `unparsed: false`, so the answer went back as `passed` with no
note at all).

### 6.5 The brief, and the two ends it is cut at

`appendFollowUp` grows the brief at the TAIL, up to 6,000 chars, newest kept.
`briefForCheck` cuts it for the judge and the anchor at 1,500 — and it applies
`appendFollowUp`'s own split rather than a fraction, because AF5 was a head cut
over a tail-grown string and AG1 was a reserve that behaved as a cap.

**AI3 is the third finding on this field, from the other end**: `growBrief` runs
when a steer is *accepted*, and `steer()` accepts a steer it has only queued. So
the brief could contain a follow-up the child was never given, and the judge
would check the answer against it. The fix does not un-grow the brief — that
would silently change what the verifier checks against on a record whose run is
over — it says the sentence.

### 6.6 The switches, and where they are read

```
   SUBAGENT_VERIFY=0          off entirely
   SUBAGENT_VERIFY_ROUNDS     0..3, default 1        ← 0 is accepted, and AH5
                                                       is the note that assumed
                                                       it could not be
   SUBAGENT_VERIFY_TIMEOUT_MS 10 s..1 h, default 5 min
   SUBAGENT_VERIFY_LOG=0      write nothing to the JSONL
```

All three of the first group are read **at settlement**, in `runVerification`,
rather than at spawn — so an operator who turns verification off during a long
delegation gets what they asked for.

### 6.7 What it cannot do

The judge is the same 27B that wrote the answer. It catches a different question
being answered, an empty or evasive summary, and a claim about work that was
plainly not done. It does not catch subtly wrong work. Calling it verification in
the stronger sense would be a lie the parent would act on, and the note the
parent reads is worded accordingly.

### 6.8 The log

`~/.pi/agent/subagent-verify.jsonl`, one line per verifier model call: the
prompt, the raw reply, **and the parse the stack acted on**. Four findings (S2,
U4, V5, W5) were each a claim about a string that lived for a few milliseconds
inside `verifyAnswer` and was then dropped; a reply without the parse beside it
cannot show that the parser was wrong. 4,000 chars a field, 2,000 lines
newest-kept, pruned every fiftieth write.

**Nothing real has ever been written into it.** It is item 9 of §13.3 and it is
still the highest-value unrun thing in the repo.

---

## 7. `.pi/extensions/compaction-guard` — three bounds every session needs

266 lines plus four modules. No commands, no tools, three handlers, and it is
inherited by a child on purpose.

```
   session_before_compact   cap the summary pi carries INTO the next compaction
                            — the monotonic-growth defect, for every session
   tool_result              cap ONE tool result to a share of what context is
                            LEFT, error results included (AF6)
   context                  append the model's own context budget above 60%
```

The output cap is the one worth stating in numbers, because they were chosen
against a real failure rather than by taste:

```
   entry 46   26,989 tok   82.4%   CRITICAL notice in context
   entry 48   27,684 tok   84.5%   CRITICAL notice in context
                                   → the model ran a 3-URL curl loop anyway
   entry 49   tool result 17,790 chars (~4,447 tokens)
   entry 50   32,766 tok  100.0%   empty turn — the model produced nothing
   entry 51   compaction

   allowance = clamp(remaining × 0.10 × 4 chars/tok, 1_500, 20_000)
     a fifth of the remainder → 88.5%, still above the 87% cliff: theatre
     a tenth                  → 86.8%, under it, with room to write a conclusion
```

### 7.1 The spill directory, and why its bound is a COUNT

Both caps keep what they cut: head, tail, and a marker naming a file. `spill.ts`
is one writer with one bound (`MAX_SPILL_FILES = 50`), imported by both, and the
bound is a count rather than a teardown sweep because `spillDir` is module-global
and a CHILD inherits this extension — a `session_shutdown` sweep on either side
would delete files the other's markers still name. AH4 was the second cap having
copied the writer without the prune.

### 7.2 What is deliberately NOT ported from `pi-loop-mode`

The handoff. It replaces pi's model summary with a locally-built one and cuts to
the last turn — correct FOR A LOOP, where the conversation is not the state, and
wrong in an ordinary session, where it is. Building that summary from an inactive
`LoopState` yields "No saved loop goal / Iteration: 0", 792 characters of form.

---

## 8. `vendor/prinny-channel` — a second human

2,035 lines in `extensions/index.ts`, thirteen modules under `src/`, and a
sidecar that is a separate process.

**What it is for.** Somebody who is not at the terminal can talk to this pi
session from a Matrix client. It is the only path in the stack with a second
person on it, and almost every rule in it exists because of that: an answer sent
to the wrong room is not undoable.

### 8.1 The shape, and why the sidecar is a separate process

```
   pi process                          sidecar (child, MCP over stdio)
     extensions/index.ts    ◀────────▶   matrix-js-sdk, Olm crypto, 105 MB
     McpChild (mcp-stdio.ts)             one poller per device
```

matrix-js-sdk plus the crypto stack is far too much to load into pi, and a second
poller on the same device is how a bot ends up unable to decrypt its own rooms.
`McpChild.stop()` is a model of what this pass is about: it SIGTERMs, waits, and
then `failPending(new Error("channel stopped"))` — every in-flight request is
rejected rather than left hanging.

### 8.2 The room entry — what `awaitingReply` holds and why

```
   awaitingReply: Map<roomId, AwaitingEntry>
     live        pi has ECHOED this room's message back as a user message, so
                 it has taken it. Evidence about the ROOM, and it only ever
                 goes UP (AE3) — a second message cannot un-take the first.
     answered    something has been sent for it: a reply, a refusal, a receipt,
                 a give-up message
     injected    exactly what pi was handed; markLive matches the WHOLE string
     question    what was actually asked, for a continuation that has to
                 survive a compaction
     emptyRetries  bounded at 2
     undeliveredReported
```

`markLive` is the load-bearing one. Without it a Matrix message arriving while pi
is mid-turn on the operator's private work would make that room eligible for the
*current* turn's answer. So eligibility waits for evidence.

### 8.3 A leading slash from Matrix

```
   classifyMatrixCommand(body)
     refuse   an allow-list miss, and the sender is told
     local    /compact — pi's built-ins are executed by the TUI's own input
              handler and are unreachable from prompt(), so this extension
              performs it (AC5)
     run      a named extension command, handed to pi with
              expandPromptTemplates: true — the receipt says HANDED, not RAN
     text     everything else
   ✋ --check is refused outright: one string, two doors, and pi.exec is not
     on the tool_call bus (AD6)
```

### 8.4 `agent_settled`, in order

```
   agentRunning = false ; stopTyping()
   continuationStarted = await forwardResult()
        forward:"result" → forwardToMatrix(lastAssistantText)
           ✋ nothing to send
           ✋ no live room
           ✋ TWO live rooms  → unattributableThisRun = true, and BOTH are
                                told at the retirement below            [AF1]
           ✋ already sent (SentRegistry, normalised)
           ✋ channel down
        empty ending?
           ✋ compactionInFlight() → hold, charge no retry, tell the room the
              true reason NOW                                           [AG3]
           else a bounded CONTINUATION: the room stands DOWN until markLive
              fires for the nudge                                       [AE4]
           ✋ retries spent → giveUp, which COUNTS as an answer
        tell every live room that got nothing; retire live rooms
        alreadySent.clear(); sweepUndelivered()
   standAside(▣pendingCompaction, continuationStarted)                   [AE2]
        wait? put it back, bounded at 2 : drainPendingCompaction()
   drainPendingCompaction() → startCompaction(pending.rooms)             [AI2]
```

### 8.5 The two things prinny cannot observe, and what it does instead

```
   "did pi take my message?"      sendUserMessage returns void; the rejection
                                  goes to a listener set that is empty headless
     → the DELIVERY SWEEP: an entry that is not live, not answered, past the
       grace, on an IDLE session, was not taken. Reported, not retried.
   "did my reply reach Matrix?"   callSidecar throws on an isError result, so
                                  this one IS observable — and it is the reason
                                  every reply in the file is `void … .catch(log)`
```

### 8.6 The three one-slot queues, and what empties each

```
   ▣ pendingCompaction   a /compact asked for while the session was mid-turn.
     written by          runLocalCommand's defer branch
     emptied by          drainPendingCompaction at agent_settled ·
                         standAside putting it back (bounded at 2) ·
                         stopChannel  ← AI2, and it said NOTHING
     BEFORE              one slot, last-write-wins: a second sender in the same
                         turn REPLACED the first, who had been told "I will
                         compact as soon as it finishes" and never heard again
     NOW                 `rooms: string[]`, merged by mergePendingCompaction,
                         and every room in it is answered from the callbacks.
                         stopChannel tells them all it will not run, BEFORE
                         `child = null`, because callSidecar reads `child`.

   ▣ lastInbound         { room, messageId } of the most recent arrival.
     written by          deliverInbound, unconditionally
     read by             the `prinny` tool, for every action with no explicit
                         room_id
     BEFORE              with two rooms live the tool sent one person's answer
                         to the other — the exact outcome forwardToMatrix
                         refuses, through the other door             ← AI4
     NOW                 resolveActionRoom: an explicit room wins; ONE live
                         room wins over lastInbound; TWO live rooms refuse.

   ▣ deliveryTimer       the undelivered sweep's interval, armed on arrival and
                         cleared by stopChannel with a stated reason.        ✔
```

And the one that was already right, and is the control both halves of AI2 are
measured against:

```
   pendingPermissions    every in-flight tool-approval request.
     stopChannel resolves each one 'deny', because "the operator asked to be
     consulted, and the channel going away is not consent."                  ✔
```

---

## 9. `vendor/rtk-pi` — bash output compression, on a leash

254 lines. One `tool_call` handler, no tools, no commands, and it is the smallest
and most conservative package in the stack.

```
   at load    pi.exec("rtk", ["--version"])
                ✋ killed  → warn and RETURN, filtering off        ← AB3
                ✋ code    → warn and RETURN
                ✋ < 0.23  → warn and RETURN
   per call   isToolCallEventType("bash", event)
                ✋ RTK_DISABLED=1
                ✋ !shouldFilter(cmd) — a MEASURED allow-list, not a denylist
                rewriteCommand → pi.exec("rtk", ["rewrite", cmd], 2 s)
                  ✋ killed → null   ✋ code not 0/3 → null
                event.input.command = rewritten
   catch      fail OPEN, always. "A filter that cannot decide must not be the
              reason a command does not run."
```

Upstream hands every bash command to `rtk rewrite`. This fork refuses, because
two rewrites change what the command MEANS: `npm run lint` becomes `rtk lint`
(which runs a bare eslint rather than the package's own script) and
`uv run pytest` becomes `uv run rtk pytest` (a different pytest). A 27B at 32k
has no way to notice either.

**It is also the control for this pass's AI5**, and was the control for AH3
before it: it is the only package that reads `killed` before `code` at every call
site, and it has done since it was written.

---

## 10. The invariants that hold across all six

### 10.1 One slot

Everything queues behind one llama slot: the operator's turn, a subagent's turn,
the judge's turn, a repair, a compaction summary, a Matrix answer. This is not a
performance note; it is the reason for the concurrency default of 1, the
verifier's round budget, the structural gate that refuses to spend a model call
on a run that was cut off, the denial of the `loop` tool to children, and the
tool-schema folding in `prinny`. **A design that spends a model call to be
careful is spending the thing the user is waiting for.**

### 10.2 Module-global state, and the two globals on `globalThis`

Every extension in this stack keeps state at module scope, and a subagent's
session binds *the same modules* through node's module cache. That single fact is
responsible for more findings in this series than any other property of the
machine, and it is why two flags live on `globalThis`:

```
   __PI_SUBAGENT_SPAWN_DEPTH__     published by pi-subagents-lite/src/shell.ts
     read by  pi-loop-mode (the whole factory) and .pi/extensions/stack.ts
     means    "a subagent session is being BUILT right now" — the bracket ends
              at bindExtensions, not at the end of the run, because an operator
              /reload during a long background delegation used to be misread as
              a spawn and cost the operator their own tools

   __PI_COMPACTION_IN_FLIGHT__     { owner, at } | undefined
     THREE implementations of one protocol, one per package that needs it:
       vendor/pi-loop-mode/src/compaction-lock.ts       take · release · read
       vendor/prinny-channel/src/compaction-lock.ts     take · release · read
       vendor/pi-subagents-lite/src/spawn/compaction-lock.ts   READ ONLY,
              deliberately — nothing in that package calls ctx.compact(), and
              shipping begin/end would invite a caller to take a lock it has no
              compaction to release
     FIVE readers, in three packages, and each does something different:
       sendLoopTurn (AG2)               DEFERS, 5 s, remembering the kind (AH6)
       requestEmergencyCompaction       ADOPTS somebody else's as its own
       interveneStuck's compact rung    spends the rung and waits
       forwardResult (AG3)              HOLDS, charges no retry, tells the room
       emitIndividualNudge (AH1)        HOLDS, 5 s, and re-asks → ▣pendingNudges
     the entry carries a TIMESTAMP and STALE_MS is five minutes, because a
     latched lock is worse than the collision it prevents
```

Vendor packages must not import each other, which is why the protocol is a
global rather than a module; a test in each package reads the others' source and
asserts the three agree.

**One bound, unchanged and still open:** the lock can only be read for
compactions an *extension* asked for. pi's own threshold and overflow compactions
emit `compaction_start` internally (`agent-session.js:1370`) but not as an
`ExtensionEvent`, so nothing can mark them. Every one of the five readers stops
at that edge.

### 10.3 A refusal is half a decision

The fifteenth pass's rule, and it is the direct ancestor of this pass's axis:
**at every `return` inside a guard, ask what you were holding when you decided
not to, and who has it now.** Forty-five refusals; §2 of `…-omissions.md` is the
ledger.

This pass narrows it by one turn of the screw. A refusal that says something —
"I will do it in a moment", "it will be delivered when that finishes", "Steer
sent" — has not put the object down. It has made a **promise**, and a promise has
a second half nobody was asked about: *what happens to the object if the thing
that would keep the promise never runs?*

### 10.4 Testability is a design constraint here

`extensions/index.ts` in three of the packages imports pi and `typebox`, which
the suite cannot load. So every rule worth testing has been lifted into a module
that imports nothing:

```
   pi-loop-mode      arguments · context-budget · context-recovery · goal-check
                     loop-log · loop-state · repetition · compaction-lock
   pi-subagents-lite concurrency-slots · record-activity · status-listing
                     action-report · nudge-drop · git-failure · declared-resources
                     compaction-anchor · verify · verify-runner · verify-log
                     result-cap · spill · compaction-lock
   prinny-channel    forwarding · delivery · continuation · command-routing
                     compaction-request · permission-gate · typing · config
                     compaction-lock
   compaction-guard  output-cap · summary-budget · context-notice · spill
   rtk-pi            gate
```

Every one of this pass's five sentences lives in one of those modules, which is
why `describeNudgeDrop("session-ending", …)`, `undeliveredSteersReport(2, …)`,
`abandonedCompactionMessage()`, `resolveActionRoom(…)` and `execVerdict(…)` are
all unit-testable, and the wiring is pinned separately by a source read.

Where a rule is a rule rather than a case, the test is a **standing scan**:

```
   tests/subagent-denylist.test.ts   fifth pass  — every .pi/extensions/* that
                                     registers a tool must guard itself
   tests/exec-verdicts.test.ts       AH3, widened by AI5 — every host `.exec(`
                                     in TWO roots must classify `killed`
```

Both carry a control assertion that the scan matched anything at all, because a
scan that finds nothing passes. **AI5 adds the other half of that discipline: a
scan that is no longer ASKED also passes.** Deleting the second root from `ROOTS`
took the suite from 377 tests to 375 with nothing failing, so the roots are now
asserted by name too.

### 10.5 The promise ledger — this pass's artefact

Every sentence this stack says to somebody, quoted from the source. The columns
are: who hears it, what keeps it, and what makes it false. A **✘** is a finding.

```
 ══ TO A MATRIX SENDER ═══════════════════════════════════════════════════════════

 ✘ "The session is mid-turn — I will compact as soon as it finishes rather
    than cutting it off."                              planCompaction, defer
      kept by      drainPendingCompaction at agent_settled → startCompaction
      falsified by (a) a SECOND sender in the same turn: ▣pendingCompaction was
                       one slot, last-write-wins, and the callbacks answer the
                       room in the slot
                   (b) the channel stopping first: stopChannel dropped it
      NOW          rooms: string[], merged; and stopChannel says so     ← AI2

 ✔ "A compaction is already running — I will let that one finish rather than
    cutting it off."                                   startCompaction, holder
      kept by      the lock, read at the moment of the decision         [AG3]

 ✔ "Compacted the conversation context." / "I could not compact the context: X"
      kept by      pi's compact() wrapper, which guarantees exactly one of
                   onComplete/onError on every path                     [§2.4]

 ✔ "Handed `X` to the session. Its output stays in the terminal — I cannot see
    whether it succeeded, so check with the operator if it matters."
      kept by      saying what THIS extension did, which it knows, instead of
                   what pi did, which it does not                       [AD4]

 ✔ "I could not hand that to the session — it would not accept a new message
    just then … please send it again."
      kept by      the delivery sweep, which watches for the absence of the
                   success because the failure is unobservable          [AB2]

 ✔ "Someone else was being answered in the same turn and I could not tell which
    reply was yours, so I sent nothing rather than send you theirs."
      kept by      the retirement notice, which now runs BEFORE the entries
                   that prove either question was asked are deleted     [AF1]
 ✘   …and was walked around entirely by the `prinny` TOOL, which is the second
      route into the same sidecar `reply` and guessed the room  ← AI4

 ✔ "That turn ended without an answer, and the session was already compacting
    its context, so I could not ask it again just then."
      kept by      the lock, read before the continuation is sent       [AG3]

 ✔ "I could not answer that — X. I tried again and still could not."
      kept by      MAX_EMPTY_RETRIES, and `answered` so the sweep stays quiet

 ══ TO THE OPERATOR ══════════════════════════════════════════════════════════════

 ✘ "Steer sent to 1a2b3c4d…"                           steerReport(true, …)
      kept by      onSessionCreated flushing ▣pendingSteers
      falsified by a run that dies in the BUILD WINDOW — seconds long, and
                   `runAgentImpl` does a settings manager, the system-prompt
                   sources, two git subprocesses and every extension factory
                   before the session exists
      NOW          the settlement chain says so, and says the answer was not
                   written with them                                   ← AI3

 ✘ "[Subagent "Explore" 1a2b3c4d] result held — pi-loop-mode is compacting;
    it will be delivered when that finishes."          describeNudgeHold
      kept by      the re-ask every COMPACTION_WAIT_MS
      falsified by session_shutdown inside the hold, which cleared
                   ▣pendingNudges and cancelled the timer
      NOW          dispose() drains the set through reportDrop         ← AI1

 ✔ "[Subagent X] result NOT delivered to the model — <cause>. Open /agents,
    select it, and choose "View result" to read it."
      kept by      /agents reading the same map the record is in        [AG6]
 ✔   …and for `record-gone` and (new) `session-ending`, the sentence says there
      is NO recovery, because both surfaces read a map that is going away

 ✔ "Loop: pi-loop-mode is compacting — holding iteration 12 until it
    finishes."
      kept by      the 5 s re-ask AND ▣deferredDirective, because the timer
                   the re-ask lives in is cleared by agent_end     [AG2][AH6]

 ✔ "Loop paused (turn aborted). Use /loop resume to continue."
      kept by      `state.active = false` — which the sentence did not have
                   until AE1, when the loop went on owning the session while
                   claiming to be paused

 ✔ "Cleared 4 of 7 agent(s); 3 were still busy and were left alone."
      kept by      counting the manager's `true`s rather than a snapshot taken
                   when the menu opened, and one sentence per verb  [AF2][AG5]

 ✔ "Compaction guard: capped the summary it would carry forward, N → M chars."
      kept by      saying what was DONE. `session_before_compact` is
                   last-truthy-wins and not threaded, so this handler cannot
                   know whether pi will use its edit

 ✘ "llama recreated. It now spends ~9-20 min reading the GGUF…"    /stack mode
 ✘ "docker compose up -d --force-recreate llama (exit 0) … llama is loading."
                                                                  /stack restart
 ✘ "CTX_SIZE: 32768 -> 65536"                                     /stack set
      kept by      nothing. All three read `r.code === 0`, and pi resolves a
                   child it killed with `code: code ?? 0` — on a 600-second
                   timeout over an operation the same file calls "roughly 20
                   minutes"
      NOW          execVerdict, at all nine sites, and the scan covers the
                   directory                                           ← AI5

 ══ TO THE PARENT MODEL ══════════════════════════════════════════════════════════

 ✔ "[verification: the first answer did not address the task; this is the
    corrected one, and it was re-checked.]"
      kept by      the repair being judged in turn, not returned unverified

 ✔ "[verification: this answer was checked against the task and did not address
    it, and no attempt was made to correct it. This is the agent's original
    answer. Treat it as unreliable.]"
      kept by      the trailing clause being conditional, because
                   SUBAGENT_VERIFY_ROUNDS=0 is a value clampRounds accepts [AH5]

 ✔ "[output capped at 84% context: 17738 chars, kept about 1970.
    Full output: /tmp/pi-tool-output-…/bash-call_1.txt]"
      kept by      the file being written BEFORE the marker names it, and the
                   prune dropping the OLDEST so the newest marker is valid [AH4]

 ✔ "loop start refused: a loop is already running (…), iteration 12."
      kept by      the tool refusing where the slash command replaces, because
                   a model cannot be asked whether it meant to

 ✔ "VERDICT: ADDRESSED or NOT_ADDRESSED"        the judge prompt's own last line
      kept by      the parser recognising its own instruction rather than
                   reading it as a choice                        [S2][U4][AH2]

 ══ TO THE NEXT READER ═══════════════════════════════════════════════════════════

 ✘ "// Queued, so it WILL reach the model — onSessionCreated flushes it."
      falsified by the build window                                    ← AI3

 ✘ "// `room_id` is omitted from every entry on purpose: the extension fills it
    from `lastInbound`, so it is neither in the schema nor something the model
    can get wrong."
      falsified by two live rooms — and the model cannot correct it, because
                   renderInboundMessage drops room_id on purpose        ← AI4

 ✘ "/** The coordinator was disposed — `session_shutdown`, or a session replaced
    under it. */"                                    NudgeDropReason
      falsified by dispose() clearing the set the guard would have fired from,
                   so the reason could only ever describe the other half ← AI1

 ✘ "// One slot, last-write-wins: two senders asking during the same turn want
    one compaction, and the second is the one whose room is still expecting an
    answer soonest."
      falsified by the first sender, who was told the same sentence     ← AI2

 ✘ "The remaining seven are script runners whose output is reported verbatim,
    where a wedge shows up as empty output rather than as a wrong verdict."
      falsified by five of the seven, which choose a verdict from r.code ← AI5

 ✔ "// `live` only ever goes up. A second message cannot un-take the first."
      kept by      mergeAwaiting, and a test per clause                 [AE3]

 ✔ "// Deny rather than allow: the operator asked to be consulted, and the
    channel going away is not consent."
      kept by      stopChannel's pendingPermissions loop — the control both
                   halves of AI2 are measured against

 ✔ "// Queued subagents never start: fail them honestly so the waiting tool
    call resumes with an explicit error instead of hanging (US-9)."
      kept by      AgentManager.dispose — the control AI1 is measured against
```

### 10.5.1 The one-slot graph

The same five findings, drawn by the DISTANCE between the sentence and the code
that empties the slot. That distance is the whole story: in four of the five the
promise and its undoing are in the same file, and in two of those they are in the
same function.

```
   ▣ SLOT                     PROMISE MADE AT            SLOT EMPTIED AT                 DISTANCE
   ─────────────────────────────────────────────────────────────────────────────────────────────
   pendingCompaction          runLocalCommand            runLocalCommand,                SAME
     (prinny)                 "…as soon as it              the very next call            FUNCTION ✘ AI2
                              finishes"                    (last-write-wins)

   pendingCompaction          runLocalCommand            stopChannel                     SAME
     (prinny)                                              (dropped in silence,          FILE,
                                                           4 lines below a loop          88 lines ✘ AI2
                                                           that does it right)

   lastInbound                the tool's own comment     deliverInbound,                 SAME
     (prinny)                 "…nothing the model          on every arrival              FILE   ✘ AI4
                              can get wrong"

   pendingSteers              AgentManager.steer         onSessionCreated —              SAME
     (subagents)              "it WILL reach the           which a run that dies         FILE,
                              model"                       in setup never reaches        180 lines ✘ AI3

   pendingNudges              describeNudgeHold          SpawnCoordinator.dispose        SAME
     (subagents)              "it will be delivered        (four clear() calls)          FILE,
                              when that finishes"                                        130 lines ✘ AI1

   ─────────────────────────────────────────────────────────────────────────────────────────────
   pendingTimer               sendLoopTurn's notice      agent_end's first line          SAME
     (loop)                   "holding iteration N"        AND ten other places          FILE   ✔ AH6
                                                           — remembered in
                                                           ▣deferredDirective

   pendingPermissions         requestApproval            stopChannel                     SAME
     (prinny)                 (an operator waiting)        — resolved 'deny'             FUNCTION ✔

   AgentManager.queue         Agent() blocks on the      AgentManager.dispose            SAME
     (subagents)              completion gate              — failed with an              FILE   ✔ US-9
                                                           explicit message

   McpChild.pending           callSidecar awaits         McpChild.stop                   SAME
     (prinny)                 the reply                    — failPending(…)              FILE   ✔
```

**Not one of the five ✘ rows required opening a file the author had not already
opened.** Three of them are in the same function or a few lines away, and in two
of those the correct treatment of a *different* slot is visible on the screen at
the same time. That is the same shape as the seventeenth pass's second-instance
graph, one axis over: the rule was not missing and the reader was not missing —
**the question was.**

### 10.5.2 The four shapes a promise breaks in

Reading the ledger back, the ✘ rows fall into four kinds, and it is worth naming
them because the next instance will be one of them:

```
   1  THE SECOND ASKER          a one-slot queue that is written unconditionally.
                                The promise is per-person; the slot is per-
                                session.                          AI2 · AI4

   2  THE TEARDOWN              the code that would keep the promise is on a
                                path teardown never runs, and teardown clears
                                the evidence that anything was owed.
                                                                  AI1 · AI2(b)

   3  THE WINDOW BEFORE THE     the promise names a callback ("onSessionCreated
      MECHANISM EXISTS          flushes it") that a failure before that callback
                                never reaches.                          AI3

   4  THE NOTE THAT AGED        a sentence written about the code, in a file
                                next to the code, that stopped being true — or
                                was never true — and that nothing reads.  AI5
```

Kinds 1 and 2 have a mechanical test: **for every module-level `let x:
Something | undefined`, list every assignment and every clear, and say what is
said on each.** That is a grep, and §13.2 is the result of running it over the
whole tree. Kind 3 is a question about a callback: *what reaches this callback,
and what does not?* Kind 4 is the seventeenth pass's own closing lesson, and it
is the only one of the four that a test can never catch — which is why AI5's fix
is a scan rather than an assertion.

---

## 11. The findings

Five, in the order they matter. Each one is a sentence this stack says, the path
on which it is not true, the change, and the control-run failing count.

### 11.1 AI4 — the room the tool guessed, where the forwarder refuses to

**The promise.** `forwardToMatrix` will not send when more than one room is live,
and the comment says exactly why:

> Only when exactly one room is waiting. With two, there is no way to tell whose
> answer this is, and guessing would send one person's conversation to another —
> **worse than silence, and not undoable.**

**The other door.** The `prinny` tool reaches the same sidecar `reply`, and its
own comment makes a second promise about the same identifier:

> `room_id` is omitted from every entry on purpose: the extension fills it from
> `lastInbound`, so it is **neither in the schema nor something the model can get
> wrong**.

`lastInbound` is one slot, written by `deliverInbound` on every arrival:

```ts
  lastInbound = { room, messageId: message.meta?.message_id };
```

under *"Last-write-wins is the right rule: actions with no explicit room are
about the message being answered now, and that is the most recent one
delivered."* That premise is true for one sender and false for two.

**Why two is ordinary rather than exotic.** It is AF1's own argument. pi's agent
loop drains its follow-up queue inside the SAME run, so two Matrix messages that
arrive while pi is busy are consumed by one run, both echoed back as user
messages, and both marked live. One person in a DM and one in a room is enough.
The model then sees two `[matrix]` blocks in its context, answers the first, and
calls `prinny(action:"reply")` — and the second sender receives it.

**And the model cannot fix it.** `renderInboundMessage` DROPS `room_id` from what
the model sees, deliberately and for a good reason:

> Dropped, because the extension knows them and the model does not need to:
> room_id, message_id, ts, is_direct, …

So the one parameter that would disambiguate is the one thing the model was never
given. `history` and `search` leak the other way: a stranger's conversation read
INTO the context.

**Measured** — `context/testing/probes/v4-the-room-the-tool-guessed.mjs`, the
real extension over the real sidecar protocol, with the real registered tool:

```
   two people, one run, and a tool reply that belongs to one of them

      what the model sees   : "[matrix] did the nightly build finish?"   ← no room id

      BEFORE                                     NOW
      ────────────────────────────────────────   ────────────────────────────────────────
      sent to !bob:example.org (lastInbound)     nothing sent; the call is refused
      — Bob receives Alice's answer              "2 Matrix conversations are waiting…"

      lastInbound points at : !bob:example.org
        ← the sender who asked SECOND, not the one being answered
```

**The change.** `resolveActionRoom` in `src/forwarding.ts` — the same file, and
the same rule, as the refusal it restates:

```ts
  explicit room_id                    → that one     (history/search stay possible)
  liveRooms.length > 1 && no explicit → REFUSE, and say what happens next
  liveRooms.length === 1              → that one
  otherwise                           → lastInbound  (nobody is waiting)
```

The refusal is worded for a reader that cannot pass a room id: it says nothing
was done, that both senders will be told at the end of the turn (AF1's
retirement notice), and not to retry. `forwardToMatrix` and the tool now read one
`liveRooms()` helper, so the two cannot drift on what "waiting" means.

**Control run:** 2 tests fail in `prinny-channel/tests/forwarding.test.ts`
("AI4 — the wiring"), and 4 expectations in `v4`.

### 11.2 AI1 — the answer that was still queued when the session ended

**The promise.** AH1 turned a drop into a wait, and the operator is told so:

> `[Subagent "Explore" 1a2b3c4d] result held — pi-loop-mode is compacting; it
> will be delivered when that finishes.`

**Where it is not true.** The hold works by putting the agent id back into
`▣pendingNudges` every `COMPACTION_WAIT_MS`. `dispose()`, which runs at
`session_shutdown`, was four `clear()` calls:

```ts
  dispose(): void {
    if (this.nudgeTimer) { clearTimeout(this.nudgeTimer); this.nudgeTimer = null; }
    this.pendingNudges.clear();
    this.backgroundAgentIds.clear();
    this.heldForCompaction.clear();
    this.disposed = true;
  }
```

So an id sitting in that set when the session ends is discarded, and nothing is
said — not to the model, not to the operator, not to the log. That is exactly
what §11.1 of `…-omissions.md` closed for the three guards INSIDE
`emitIndividualNudge`, on AC1's rule that *a delivery that did not happen is the
loudest thing this class can report; it must not be the quietest.*

**And the report for this case already existed.** `NudgeDropReason`'s first
member is `session-replaced`, and its docstring says what it is for:

> The coordinator was disposed — `session_shutdown`, or a session replaced under
> it.

It can only fire for a record that settles **after** the dispose, because the ids
already queued are cleared here and their timer is cancelled. The reason existed
and the path to it did not.

**AH1 made the window large.** Before the seventeenth pass an id sat in that set
for `NUDGE_DELAY_MS` — 200 ms. Since AH1 it can sit there for as long as somebody
holds the compaction lock, which the lock bounds at five minutes. A `/loop` that
delegates in the background and is stopped while a compaction is running is the
ordinary shape of that.

**The control is thirty lines away.** `AgentManager.dispose()` fails its QUEUED
records honestly rather than dropping them, "so the waiting tool call resumes
with an explicit error instead of hanging (US-9)". Same teardown, same kind of
pending work, opposite treatment — and `events.ts` calls them one after the
other.

**Measured** — `v1-the-answer-that-was-still-queued.mjs`, the real coordinator:

```
      BEFORE                                     NOW
      ────────────────────────────────────────   ────────────────────────────────────────
      the id is cleared, nothing is said         1 notice, 1 log line
      (not to the model, operator or log)        "[Subagent "Explore" bg-agent] result
                                                  NOT delivered to the model — the session
                                                  ended while the result was still queued
                                                  for delivery. The answer is gone with it."
```

**The change.** `dispose()` reads the set before clearing it and reports each id
through `reportDrop`, with a new reason `session-ending`. The reason is separate
from `session-replaced` because they are different facts — never fired, versus
fired too late — and because the RECOVERY differs: `/agents` reads the manager's
map, and `events.ts` disposes the manager two statements later, so naming that
surface here would be AG6's defect restored. The sentence says the answer is gone
with the session, and names the transcript file when `outputTranscript` gave the
record one.

**Control run:** 1 test fails in `pi-subagents-lite/tests/nudge-drop.test.ts`
("AI1 — a queued nudge at session_shutdown"), and 6 expectations in `v1`.

### 11.3 AI2 — the compaction two people asked for

**The promise.** A Matrix `/compact` that arrives mid-turn is deferred rather
than refused, because "no" is the wrong answer when "in a moment" is available
(AD3), and the sender is told:

> The session is mid-turn — I will compact as soon as it finishes rather than
> cutting it off.

**Where it is not true, twice.**

*(a) The second asker.* `runLocalCommand` parked that promise in one slot:

```ts
  pendingCompaction = { room, at: Date.now() };
```

under *"One slot, last-write-wins: two senders asking during the same turn want
one compaction, and the second is the one whose room is still expecting an answer
soonest."* One compaction is right, and was never the defect. One REPLY is not:
`startCompaction` answers the room in the slot from `onComplete`/`onError`, so
every sender but the last was told something would happen and never heard again.
`deliverInbound` sets `answered = true` on the way past, so the undelivered sweep
could not report it either.

The two senders are correlated rather than independent, which is what makes this
ordinary: a person asks for a compaction BECAUSE the bot has gone slow, and both
of them can see that.

**And the same module gets it right on the other path.** When the request is
served IMMEDIATELY, `startCompaction` reads the lock, finds a holder, and tells
the second asker *"A compaction is already running — I will let that one finish
rather than cutting it off."* Two senders answered correctly on the path that
acts, and one lost on the path that defers.

*(b) The teardown.* `stopChannel()` — `/prinny stop`, `/prinny restart`, and
`session_shutdown` — dropped the whole request in silence, four lines below a
loop that exists because a pending decision must not evaporate:

```ts
  for (const [id, pending] of pendingPermissions) {
    clearTimeout(pending.timer);
    pendingPermissions.delete(id);
    // Deny rather than allow: the operator asked to be consulted, and the
    // channel going away is not consent.
    pending.resolve('deny');
  }
```

**Measured** — `v2-the-compaction-two-people-asked-for.mjs`:

```
   mode two-rooms
      BEFORE                                  NOW
      ─────────────────────────────────────   ─────────────────────────────────────
      1 compaction, 1 room told (Bob)         1 compaction, 2 rooms told
                                                !alice  "Compacted the conversation…"
                                                !bob    "Compacted the conversation…"

   mode stopping
      nothing — the slot is dropped           1 message
                                                !alice  "I said I would compact once
                                                         the turn finished, and the
                                                         channel is stopping…"
```

**The change.** `PendingCompaction.rooms: string[]`, folded by
`mergePendingCompaction` — which is `mergeAwaiting`'s rule (AE3) one map over: *a
second message cannot un-ask the first*. `stoodAside` is carried rather than
reset, because the stand-aside budget belongs to the request and resetting it on
every new ask would let a busy channel starve a continuation. `stopChannel` calls
`abandonPendingCompaction()` **as its first statement**, because `callSidecar`
goes through `requireChannel()`, which reads `child` — a reply attempted after
`child = null` throws into a `.catch` and the sender hears nothing, which is the
defect with an extra step.

**Control run:** 2 tests fail in
`prinny-channel/tests/compaction-request.test.ts` ("AI2 — the wiring"), and 2
expectations in each of `v2`'s `two-rooms` and `stopping` modes.

### 11.4 AI3 — the steer that was accepted for a session that never opened

**The promise.** `AgentManager.steer()` has a branch for a record that is
`running` and has no session yet:

```ts
  if (!record.execution.session) {
    if (!record.execution.pendingSteers) record.execution.pendingSteers = [];
    record.execution.pendingSteers.push(message);
    // Queued, so it WILL reach the model — onSessionCreated flushes it.
    this.growBrief(record, message);
    return true;
  }
```

`true` is what `steerReport` turns into *"Steer sent to 1a2b3c4d…"* for the
operator (AF2), and the comment is the promise it rests on.

**Where it is not true.** `onSessionCreated` fires from
`createAndConfigureSession`, and everything `runAgentImpl` does before that is a
window in which the record is already `running` and there is no session:

```
   SettingsManager.create              a trust decision and a settings read
   resolveSystemPromptSources          project files, when the project is trusted
   detectEnv()                         TWO git subprocesses, on a 9p mount
   createResourceLoader / reloadAndMap EVERY extension factory, re-run for the
                                       child — including rtk's shell-out to
                                       `rtk --version` on a 2 s timeout
```

A run that dies anywhere in it never flushes. Measured on this box: one second
after `spawn()` the record reads `running` with no session, and the same spawn
reached settlement at **~16.5 seconds** — essentially all of it in that window.

**Two things were untrue at once, and the second is worse.** The operator had
been told the steer was sent; and `growBrief` had already recorded it, so the
accumulated brief — which the ANCHOR restates after a compaction and which the
JUDGE checks the answer against — contained an instruction the child was never
given.

**Measured** — `v3-the-steer-that-never-reached-a-session.mjs`, the real
manager, the real `steer()`, the real `growBrief` and the real settlement chain:

```
      steer() answered  : true   → "Steer sent to steer-wi…"
      pendingSteers     : ["also list the callers of decodeFrame()"]
      brief now ends    : "low-up: also list the callers of decodeFrame()"

      BEFORE                                     NOW
      ────────────────────────────────────────   ────────────────────────────────────────
      pendingSteers: ["also list the …"]         pendingSteers: undefined
      nothing said, anywhere                     1 notice, 1 log line
      "Steer sent to steer-wi…" stands           "steer-wi never opened a session, so the
                                                  steer queued for it was never delivered
                                                  — its answer was not written with them.
                                                  Re-send them to a new agent."
```

**The change.** `undeliveredSteersReport(count, shortId)` in
`src/ui/action-report.ts` — the module that already owns *what the operator is
told when the manager says no* — and `reportUndeliveredSteers(record)` called
from the settlement chain's `.finally`, the one place every settlement passes
through. The queue is cleared so a continuation cannot report it twice.

**The brief is deliberately left alone.** Un-growing it would silently change
what the verifier checks against on a record whose run is already over; the
sentence says the answer was not written with them, which is the fact the parent
acts on.

**Control run:** 1 test fails in `pi-subagents-lite/tests/action-report.test.ts`
("AI3 — a queued steer that never reached a session"), and 7 expectations in
`v3`.

### 11.5 AI5 — the seven call sites a residue note said were safe

**The promise, and it was made to the next reader.** The seventeenth pass applied
`killed`-before-`code` to every `pi.exec` in `vendor/pi-subagents-lite`, wrote
the standing scan that keeps it applied there, then looked at
`.pi/extensions/stack.ts`, fixed two of its nine sites, and wrote this:

> Out of this package and stated rather than fixed silently:
> `.pi/extensions/stack.ts` has nine exec sites and read `killed` in none of
> them. Two are now fixed … **The remaining seven are script runners whose output
> is reported verbatim, where a wedge shows up as empty output rather than as a
> wrong verdict.**

**Where it is not true.** Five of the seven choose a verdict from `r.code` and
say a sentence about it:

```
   site                          timeout   what a WEDGED command produced
   ───────────────────────────   ───────   ─────────────────────────────────────────
   /stack restart <svc>            600 s   "(exit 0) … llama is loading."   at warn
   /stack mode <target> recreate   600 s   "llama recreated. It now spends ~9-20 min
                                            reading the GGUF…"             at warn
   /stack mode <target> mode.sh    120 s   the confirmation to recreate is offered
   /stack set KEY=VALUE             20 s   "KEY: old -> new" — an .env write
   /stack up | /stack down         900 s   severity "info", with "(timed out)"
                                            printed INSIDE the green result
   /stack logs <service>            30 s   severity "info", empty body
```

The two 600-second rows are the pair worth reading twice: `/stack restart`'s own
confirmation prompt says *"Expect roughly 20 minutes before it answers again"*
and `/stack mode`'s says *"~9-20 minute cold load"* — against a **ten-minute
timeout on the compose command itself**. The wedge is not the exotic case there;
it is what a slow bind mount produces on an ordinary day, and the operator was
told the container had been recreated.

`/stack up | /stack down` is the tell for the whole finding: it already READ
`killed` — it prints "(timed out)" in the body — and then took the severity from
`code` alone. The field was read for the sentence and not for the verdict.

**And the scan did not cover the file the fix had been applied to.**
`tests/exec-verdicts.test.ts` scans `vendor/pi-subagents-lite/src` and nothing
else, so the two hand-applied fixes in `stack.ts` had no gate and the other seven
had no test.

**Measured** — `v5-the-verdict-the-residue-note-allowed.mjs`, against pi's real
`execCommand` run four ways at probe time:

```
      timed out (pi's own kill)       { code: 0, killed: true  }   code-first: SUCCESS
      SIGKILLed by something else     { code: 0, killed: false }   code-first: SUCCESS
      a real non-zero exit            { code: 3, killed: false }   code-first: failed
      an ordinary success             { code: 0, killed: false }   code-first: SUCCESS
```

**The change.** One `execVerdict(result, timeoutMs)` helper in `stack.ts`, read
by all nine sites — `docker ps` lifted out of `collectStatus`'s
`Promise.allSettled` array into a `dockerPs()` function so its verdict sits next
to its call, and `dockerVram` switched over so there is one implementation of the
rule in the file rather than a copy per site. `tests/exec-verdicts.test.ts` gains
`.pi/extensions` as a second root, with:

- an `existsSync` guard, so the package stays vendorable;
- a per-root control that the scan matched at least N call sites;
- **a control that the ROOTS list still names both roots**, because deleting the
  row took the suite from 377 tests to 375 with nothing failing;
- a regex-literal exclusion by SHAPE rather than by receiver name, because
  `stack.ts` parses `.env` and `docker-compose.yml` with four `RegExp.exec`
  calls, and an allow-list of receivers would have dropped
  `getPiInstance().exec(` — two real call sites — silently.

**What is NOT fixed, and is stated rather than guarded:** `killed` answers "did
pi stop this", not "did this finish" (AB1). `/stack`'s commands are docker and
compose, and there is nothing to wrap them in the way the loop's goal check wraps
a check script, so an externally-killed compose is still indistinguishable from
one that printed nothing and exited 0. What changed is that pi's OWN timeout — a
number this file chooses, and chooses smaller than the operation it bounds — is
no longer read as a success.

`context/testing/probes/u2-…` carries a **correction note** recording what its
own sentence said and for how long.

**Control run:** 1 test fails in `pi-subagents-lite/tests/exec-verdicts.test.ts`
when any one site is reverted, and 6 expectations in `v5`; 1 more fails when the
second root is deleted.

---

## 12. The evidence

### 12.1 The gates

Re-run **before** anything was written, so the *before* column measures the tree
as this pass found it:

```
                                        before   after   delta
   vendor/pi-loop-mode        tests       227     227      —
   vendor/pi-subagents-lite   tests       365     378     +13
   vendor/prinny-channel      tests       382     399     +17
   .pi/extensions/compaction-guard         47      47      —
   vendor/rtk-pi              tests        20      20      —
                                        ─────   ─────
                                        1,041   1,071     +30
   probes                                  77      82      +5
   lint   pi-subagents-lite  95/95 files parsed
          the other three     node --check, clean
```

Where the thirty tests went:

```
   +5   nudge-drop.test.ts          "AI1 — a queued nudge at session_shutdown"
   +5   action-report.test.ts       "AI3 — a queued steer that never reached a
                                     session"
   +3   exec-verdicts.test.ts       the second root, its control, and the
                                     roots-by-name assertion                AI5
   +5   compaction-request.test.ts  "AI2 — mergePendingCompaction"
   +4   compaction-request.test.ts  "AI2 — the wiring"
   +6   forwarding.test.ts          "AI4 — which room a prinny(…) call is about"
   +2   forwarding.test.ts          "AI4 — the wiring"
```

**When re-running the gates, check the test COUNT and not only the failure
count.** A whole test FILE can bail under memory pressure, which `node --test`
reports as one failure and a silently lower total. (Carried from the fifteenth
pass, and still right.)

One quirk worth knowing so it is not mistaken for a regression: `prinny-channel`'s
`npm run test:unit` — the `--test-skip-pattern` variant — can end with one
CANCELLED subtest at the 90-second timeout. `npm test`, which is the gate this
series uses, runs the same 399 tests clean in about eight seconds.

### 12.2 The five probes

Each prints BEFORE and NOW, so it is its own control.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `v1-the-answer-that-was-still-queued.mjs` | **AI1** | `node v1-…` | The real `SpawnCoordinator` with `pi-loop-mode` holding the lock: the nudge is held (AH1), it is still in `pendingNudges`, and then the session ends. BEFORE the id is cleared and nothing is said anywhere; NOW one notice and one `console.warn`, naming the agent and saying the answer is gone with the session. Controls: the sentence does NOT name `/agents` (AG6's rule for the one reason it did not exist for), the transcript IS named when there is one, a second dispose reports nothing, and a dispose with an empty queue says nothing at all. |
| `v2-the-compaction-two-people-asked-for.mjs` | **AI2** | `for m in two-rooms stopping control; do node v2-… $m; done` | The real extension over the real sidecar protocol. `two-rooms`: two `/compact`s in one turn, both told it will happen, and BEFORE only Bob heard again. `stopping`: the channel stops with a request waiting — BEFORE nothing, NOW one message saying it will not run. `control`: one person, one compaction, one reply. One process per mode, because `pendingCompaction` is module state. |
| `v3-the-steer-that-never-reached-a-session.mjs` | **AI3** | `node v3-…` | Block 1 spawns a REAL subagent and samples it one second in: `running`, no session. Block 2 uses the real `steer()` (which returns `true` and grows the brief) and then the real settlement chain on a run that dies before `onSessionCreated`. Controls: the count is pluralised, the queue is cleared so a continuation cannot report twice, and a record whose session DID open reports nothing. |
| `v4-the-room-the-tool-guessed.mjs` | **AI4** | `for m in two-rooms one-room explicit; do node v4-… $m; done` | The real extension AND the real registered `prinny` tool. `two-rooms`: the model is shown no room id, the tool is refused, and then — once the run settles and both rooms retire — the same call falls back to `lastInbound`, which the probe PRINTS: Bob's room, for an answer about Alice's question. `one-room` and `explicit` are the two controls the refusal must not break. |
| `v5-the-verdict-the-residue-note-allowed.mjs` | **AI5** | `node v5-…` | pi's `execCommand` MEASURED four ways at probe time, the shipped `execVerdict` driven against a wedged result for each of the six sites, and then the standing scan's own output over both roots — fourteen call sites, all classified. |

`v1`, `v3`, `v5` and the two prinny probes load pi-importing modules through pi's
own bundled `jiti`; `v5` additionally aliases `typebox`, which `stack.ts`
imports. `v2` and `v4` run one process per mode and use `_sidecar.mjs`. All five
exit non-zero if an expectation fails.

### 12.3 Re-running everything

```sh
   cd ~/instantcoffee
   for d in vendor/pi-loop-mode vendor/pi-subagents-lite vendor/prinny-channel \
            .pi/extensions/compaction-guard; do (cd $d && npm test && npm run lint); done
   (cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts)

   cd context/testing/probes
   for f in $(ls *.mjs | grep -v '^_'); do
     node --experimental-strip-types "$f" >/dev/null 2>&1 || echo "FAILED $f"
   done
```

Eighty-two probes, all silent. The multi-mode probes are run above with their
default mode; `README.md` in that directory lists the modes that matter.

---

## 13. What is open, and what has still never been run

### 13.1 Open by decision, carried from earlier passes

Each of these was found, understood, and deliberately left; §11 of
`…-omissions.md` has the full reasoning and this is the index.

```
   the delivery QUEUE behind §11.1   reporting a dropped background result is not
        delivering it, and a result produced for a session that has gone away
        still has nowhere to go. A queue that survives a session swap is a
        capability change rather than a repair.
        ▲ AH1 narrowed this to "a session that has genuinely gone away".
          AI1 makes that case LOUD. It does not deliver it, and the honest
          statement is now: the answer is on the record until the manager is
          disposed, and the operator is told in the same breath as the session
          ending. A queue is still the only thing that would deliver it.
   §11.2  a channel-down apology cannot arrive.
   §11.3  a room-less inbound message falls through to the model as text.
   §11.4  the /agents spawn wizard is the one spawn path that can hold no
        concurrency slot. Unreachable, stated.
   §11.5  `continue` still drops when a message is pending. The line AF3 draws,
        and AH6 and this pass both deliberately leave it there.
   §11.6  `answered` is set by the act of replying, not by evidence it arrived.
   §11.7  a SIGTERM from outside on a goal check runs bash's EXIT trap, so the
        marker proves COMPLETION, not INTENT.
   §11.8  the watchdog skips a verifying record and deletes its state.
   §11.9  a --check is a shell channel no tool_call handler can see, from the
        tool and the terminal. Closed from Matrix (AD6).
   §11.10 agentRunning is false for the width of one await chain.
   §11.12 pi's OWN threshold and overflow compactions mark nothing, so no
        extension can stand aside for them. UNCHANGED, and the bound on four
        fixes now.
   plus  the Matrix command sweep's blind spot, the brief-before-session window,
        hasStateChange's keyword list, T6, per-session loop state, T1's general
        case, and resuming a completed run.
```

Also carried, and re-derived this pass rather than assumed:

```
   AB1  `killed` is only pi's OWN kill. An OOM kill, an operator's `pkill` or a
        container going down all resolve { code: 0, killed: false } — the shape
        of a command that SUCCEEDED and printed nothing. AH3 and AI5 fix the
        readings; neither can fix this, because the information does not leave
        `waitForChildProcess`. The loop answers it for its goal check with a bash
        EXIT trap; `/stack` cannot, because its commands are docker and compose.
```

One entry is **narrowed** by AI3 and worth restating in its new form: *"the
brief-before-session window"* used to mean "a steer can be accepted before the
session exists". It still can — that is the right behaviour, and the queue works
whenever the session does open. What is fixed is the silence when it does not.

### 13.2 This pass's residue, and the negatives that were measured

AI1–AI5 are fixed; §11 has the change, the numbers and the control run for each.

**The scan behind the axis, and its result.** Every module-level mutable slot in
the stack, classified by whether it holds something somebody is owed:

```
   pi-loop-mode      state · runToken · degenerateAbortPending ·
                     emergencyCompactionPending · ownCompactionInFlight ·
                     waitingForCompaction · lastDegenerateCheckLength ·
                     four turn buffers                       — not a promise
                     ▣ pendingTimer · ▣ deferredDirective ·
                     ▣ contextRecoveryPending                — ALL THREE KEPT ✔
   prinny-channel    child · settings · starting · connected · lastError ·
                     uiCtx · api · awaitingReply · lastAssistantText ·
                     lastRunEmptyEnding · shuttingDown · unattributableThisRun ·
                     typingTimer · typingRooms · agentRunning
                                                             — not a promise
                     ▣ pendingPermissions · ▣ deliveryTimer   — KEPT ✔
                     ▣ pendingCompaction                      — BROKEN, twice ✘
                     ▣ lastInbound                            — BROKEN ✘
   pi-subagents-lite subagentSpawnDepth · packageNameCache · the agent-type
                     registry and its three dirs · writesSincePrune
                                                             — not a promise
   …and the instance-level ones, which the grep above does NOT reach and which
   is where two of the four are:
                     ▣ AgentManager.queue                     — KEPT ✔ (US-9)
                     ▣ AgentManager.gateResolvers             — KEPT ✔
                     ▣ McpChild.pending                       — KEPT ✔
                     ▣ SpawnCoordinator.pendingNudges         — BROKEN ✘ (AI1)
                     ▣ record.execution.pendingSteers         — BROKEN ✘ (AI3)
```

**Eleven slots hold something somebody is owed. Seven were right. Four were
not, and all four are this pass.** The lesson for the next reader is in the
last paragraph of that list: *a grep for module-level `let` finds two thirds of
them.* The other third are fields on a class or on a record, and both of the
ones this pass found are there.

**One bound, unchanged and now wider still.** The compaction lock can only be
read for compactions an *extension* asked for. pi's own threshold and overflow
compactions mark nothing, so four guards stop at the same edge:

```
   AG2  sendLoopTurn's deferral
   AG3  forwardResult's hold
   AH1  emitIndividualNudge's hold
   and §11.12's mutual exclusion
```

Marking pi's own compactions would need a hook pi does not have.
`compaction_start` is emitted (`agent-session.js:1370`) but not as an
`ExtensionEvent`; adding one is an upstream change, not a fork change.

**pi-loop-mode: nothing found, and here is the working.** Every sentence the loop
says was followed to the path that would falsify it:

```
   "holding iteration N until it finishes"   the timer is cleared by agent_end —
        and AH6's ▣deferredDirective is what carries the text onto the next turn.
        For a `continue`, the agent_end that cleared it schedules another itself.
        CHECKED, KEPT.
   "Loop paused … /loop resume to continue"  resume needs only state.description,
        which no pause path touches; and `resume` resets the four counters that
        would otherwise re-pause on the first event (providerErrorStreak,
        penaltyTurnsRemaining, checkErrorStreak, consecutiveStuckCount).
        CHECKED, KEPT.
   "finishing the current iteration, then stopping"  agent_settled is the final
        safety net for a soft stop requested while agent_end was awaiting a goal
        check, and session_start finalizes one that never ran. CHECKED, KEPT.
   "cooling down Ns, then retrying with a tighter summary"  an unrelated
        agent_end clears the cooldown timer, and then runs the ladder itself and
        schedules a turn. The tightening IS discarded — by the rule that a turn
        which completed proves the context fits, which is the same rule stated
        four lines above it. CHECKED, KEPT (and stated here so it is not
        re-derived).
   "waiting for that instead of asking again"  interveneStuck's compaction rung
        under a holder schedules a `stuck` turn, and `sendLoopTurn` reads the
        lock itself and defers if it is still held. CHECKED, KEPT.
   "rescue turn with <model>"  a stop during the model switch leaves the session
        on the rescue model — and `switchModel` says so, `state.rescueReturnModel`
        survives, and both `/loop resume` and `session_start` restore it.
        CHECKED, KEPT.
```

**Two negatives worth recording so they are not re-derived.**

`pauseForCheckFailure` and `pauseForProviderFailure` do not call
`resetContextRecovery()`, where `pauseForContextFailure` — the third function in
the same block, with the same eight statements — does. It is **not a finding**:
the three fields that would survive are `waitingForCompaction`,
`deferredDirective` and `contextRecoveryPending`, all of them gated by
`state.active`, and every path that sets `active` back to true (`runLoop`,
`/loop resume`) calls `resetContextRecovery()` first. Reachability needs a
runToken bump that leaves `active` true without a reset, and there is none.

`agent_settled` consumes `▣contextRecoveryPending` *after* its token check while
`session_compact` consumes it *before* — two readers of one slot with opposite
clear-order, which is a textbook second-instance shape. Also **not a finding**,
for the same reason: the stuck-marker case needs `active === true` with a
mismatched token, which the previous paragraph shows is unreachable.

### 13.3 Still unwatched — none of this has been run against a live model

**This is the whole of what is left, and it has been true for fifteen passes.**
Everything in eighteen documents is verified against probes, tests and pi's own
source, and none of it against a 27B actually answering. The list, cheapest
first:

```
   1  §U   Esc on a loop turn, then type a question.
           ONE KEYPRESS and one sentence. No subagent, no verifier, no Matrix
           account. It is AE1 end to end.
   2  §AA.1  /loop --delay 20, type /compact in the gap. AG2 from the terminal
           in one minute, no Matrix account and no saturated context — and the
           cheapest way to see AH6 too, if the turn in that gap is a
           LOOP_BLOCKED one.
   3  §AC.1  NEW — two rooms, and the model calls prinny(reply). One person in a
           DM and one in a room, both messaging while the bot is busy, then a
           question that makes the model reach for the tool. BEFORE, one of them
           received the other's answer. It needs a Matrix account and nothing
           else. That is AI4 end to end.
   4  §X   Two rooms, one turn, no tool call. Both must hear something. (AF1)
   5  §AC.2  NEW — two rooms both send /compact while the bot is mid-turn. Both
           must be told when it finishes; before this pass only the second was.
           Then, for the other half: send one /compact mid-turn and run
           `/prinny restart` before the turn ends. That is AI2.
   6  §Y   A /loop against a genuinely failing suite. `Compaction guard: capped
           bash output N -> M` should appear once per iteration.
   7  §Z   Type something while the goal check is running.
   8  §B/§P One background delegation, and the only question is whether the
           result appears in the conversation at all. Do it headless too.
           ▲ §AB.1 is the cheap version: start it, then /compact while the child
             is still working. The result must arrive LATE rather than not at
             all. AI1 adds the third variant: do that, and then quit pi while it
             is still held. One line must say the answer went with the session.
   9  §M/§M.2/§M.3  three /loop starts with different --checks.
  10  §R   A real verification, foreground, SUBAGENT_VERIFY_ROUNDS=1, a
           deliberately off-task brief, with a STEER in it (AF5 and AG1).
  11  READ ONE LINE OF ~/.pi/agent/subagent-verify.jsonl written by a real
           judge. It has existed since the fifteenth pass and nothing real has
           ever written to it.
           ▲ Still the highest-value item on the list. AH2 is exactly what that
             file exists to make visible, and three passes of READING could not
             settle it. Do 10, then read the `parsed` field beside the `reply`
             field.
  12  §I, §J, §K/§K.2, §L, §N, §O — never run.
```

---

## 14. The pattern across eighteen passes

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
                                       instance in front of it
   host ↔ harness             X1–X5,Y1 the evidence models the host, and the model
                                       omits the one thing under test
   call ↔ what the host does  Z1–Z4    the call is correct, the argument is correct,
              with it                  and the value ends up somewhere nobody looked
   the rest of the contract   AA1–AA4  which events reach us at all, and what a host
                                       function's answer is able to say
   the contract IN TIME       AB1–AB4  the answer was available for an instant, and
                                       the reader arrives after it
   sending ↔ receiving        AC1–AC5  something was produced for somebody, and
                                       nobody checked that anybody got it
   instructing ↔ obeying      AD1–AD7  something was decided for a mechanism, and
                                       nobody checked the mechanism ever saw it
   believing ↔ being          AE1–AE7  the machine keeps a fact about itself, and
                                       something else stops it being true
   deciding ↔ what was        AF1–AF6  the code declines to act, correctly, and the
     decided about                     thing it was holding has no second owner
   naming ↔ the thing named   AG1–AG6  a decision or a sentence points at something
                                       — a flag, a tool, an entry point, a sibling
                                       rule — and nobody read it
   the rule ↔ its instances   AH1–AH6  the rule is right, is written down, and is
                                       applied to fewer places than need it
   saying ↔ doing             AI1–AI5  a sentence was said to a person, a model or
                                       the next reader, and there is a path on
                                       which it is not true
```

Four things transfer out of this one.

**A deferral is a promise, and a promise has a second half.** AF1 established
that a refusal is half a decision — the other half being the object it dropped.
This pass is the same shape for the case where the code does not refuse but
DELAYS: the object is not dropped, it is parked, and the second half is *what
happens to the parked thing when the mechanism that would deliver it never
runs.* Four of the five findings are that question, asked of a one-slot queue.

**A fix that converts a drop into a wait converts a narrow window into a wide
one.** AH1 turned a lost answer into a held one and, in doing so, took the
interval an answer can sit in a batch set from 200 milliseconds to five minutes.
That is strictly better and it is also new exposure: every teardown path that
crosses the window inherits the question. **When you widen a window, list what
crosses it.**

**The best control is usually in the same file.** `stopChannel` denies its
pending permissions and dropped its pending compaction, four lines apart.
`AgentManager.dispose` fails its queued records and `SpawnCoordinator.dispose`
cleared its queued nudges, in two files that `session_shutdown` calls one after
the other. `forwardToMatrix` refuses to guess a room and the tool in the same
file guessed. In every case the right treatment of the SAME KIND of thing was
visible without opening anything — which means the search that finds these is not
"read more code", it is **"read this code twice, asking a different question the
second time."**

**A note about the code is a claim about the code, and it can be checked in the
file it is about.** AI5's sentence was written by a careful pass, in a probe, one
directory from the code it described, and was wrong about five of seven call
sites — and the check was a grep. The seventeenth pass's lesson was to write down
which fix you considered; this pass adds: **write down what you checked, so the
next reader knows what to re-check rather than having to re-read.**

---

## 15. Where to look

- **This document** — §1 is the whole machine; §2 is pi, and is the thing most
  worth reading before changing anything; §2.5 is why AH1's fix widened AI1's
  window; §2.7 is `pi.exec`'s two missing facts; §3 is the event bus and §3.1
  the two things that are not on it; §4–§9 are the six packages, each ending in
  its one-slot queues; **§10.5 is this pass's artefact, the promise ledger**, and
  §10.5.1 draws it by distance; §11 is the findings.
- `context/design/subagents-loop-verifier-instances.md` — the seventeenth pass
  (AH1–AH6), and the previous self-contained account. **§10.5 is the
  second-instance graph**, which this document does not restate, and §2.5 is what
  a run started inside a compaction costs, measured out of `agent.js`.
- `context/design/subagents-loop-verifier-references.md` — the sixteenth pass
  (AG1–AG6). Its §1.D is the corrected event bus and its §10.2 is the lock's
  first table of readers.
- `context/design/subagents-loop-verifier-omissions.md` — the fifteenth pass
  (AF1–AF6). Its **§2 is the refusal ledger** and §2.1 the refusals graph: every
  place this stack declines to act, what it was holding, and who owns that
  afterwards. This pass's ledger is its successor and does not replace it.
- `…-claims.md` (fourteenth, AE1–AE7, and its §2 claim ledger) ·
  `…-controls.md` (thirteenth, AD1–AD7) · `…-deliveries.md` (twelfth, AC1–AC5 —
  the nearest neighbour to this axis) · `…-signals.md` (eleventh, AB1–AB4) ·
  `…-hosts.md` (tenth, AA1–AA4) · `…-answers.md` (ninth, Z1–Z4, whose §1 is every
  route by which a message reaches a model) · `…-turns.md` (eighth, X1–X5, Y1) ·
  `…-readers.md` (seventh, W1–W6) · `…-shapes.md` (sixth, V1–V8) · `…-units.md`
  (fifth, U1–U9, whose §9 reference sections no later document restates) ·
  `…-surfaces.md` (fourth, S1–S10) · `…-mechanics.md` (third, T1–T9, still the
  best account of pi's own agent loop) · `…-evaluation.md` (second, F1–F11) ·
  `…-anatomy.md` (first, and the design rationale).
- `context/testing/subagents-loop-verifier.md` — the hand-testing script. §13.3
  above is its index in cheapest-first order, and **§AC is new in this pass**.
- `context/testing/probes/README.md` — what each of the eighty-two probes prints.
  Read its last eight paragraphs before trusting or writing one.
- The four `FORK.md` files — `vendor/pi-loop-mode`, `vendor/pi-subagents-lite`,
  `vendor/prinny-channel`, `vendor/rtk-pi`. `.pi/extensions/compaction-guard` has
  none; §7 above and its own header comments are its only account, and
  `.pi/extensions/stack.ts` is in the same position — §11.5 and its own
  `execVerdict` docstring are what there is.
- pi's own source, for this pass:
  `core/agent-session.js:792` (`prompt`, and the compaction refusal at `:807`),
  `:1068` (`sendCustomMessage`, and `_runAgentPrompt` at `:1090`),
  `:340` (`_handleAgentEvent`, which AWAITS the extension emit before anything
  else — why a 120-second goal check holds the session),
  `:744` (`_runAgentPrompt`),
  `:1367` (`compact`, and the message-array replacement at `:1434`),
  `:1911` (the `ctx.compact` wrapper and its callback guarantee),
  `core/exec.js` (`execCommand`, which never rejects and does `code ?? 0`),
  `core/extensions/runner.js:579` (`emit` — load order, sequential, awaited),
  `:747` (`emitContext` — one `structuredClone`, then THREADED, which is what
  makes the two budget-notice handlers safe in either order),
  `core/session-manager.js:943` (`getBranch` — a walk to the root, so a
  compaction never hides an earlier custom entry from `restoreLoopState`),
  `pi-agent-core/dist/agent.js:143` (`subscribe`'s contract: listener promises
  are awaited and included in the run's settlement) and `:283`
  (`createContextSnapshot` — the `.slice()` that makes a run immune to the
  compaction it is running inside),
  `pi-agent-core/dist/agent-loop.js:43` (`runAgentLoop`, and the inner/outer
  while).
