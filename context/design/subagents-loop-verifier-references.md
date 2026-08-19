# Subagents, the loop, and the verifier — the thing that was named

Sixteenth pass, 2026-08-19. A full read of the whole stack — pi's own agent
loop, `vendor/pi-loop-mode`, `vendor/pi-subagents-lite` and the answer verifier
inside it, `.pi/extensions/compaction-guard`, `vendor/prinny-channel` and
`vendor/rtk-pi` — written to be **self-contained**. §1 to §9 are a complete
account of the machine and do not assume any of the fifteen documents before
this one.

The fifteenth pass asked about the places the machine decides **not to act**, and
its closing lesson was:

> **"Something else will handle this" is a claim about another piece of code, and
> it costs one read of that code to check.**

This pass took that sentence as its axis and pointed it at everything the stack
*names*:

> **Name the thing a decision or a sentence points at — a flag, a tool, an entry
> point, a handler, a surface, a sibling function's rule — and then go and read
> it.**

Six findings. Five of the six are that lesson's own next instance, and they have
a shape the previous fifteen passes do not: in every one of them **the thing
that was named already exists and already works**. The compaction lock the
fifteenth pass built is read by two of its four possible callers. The
`/agents` menu really can print a subagent's answer, and the sentence that tells
an operator how to recover one names the tool that cannot. `stopReport` has the
correct sentence for a refused stop, and the bulk path uses the other one. The
rule `appendFollowUp` owns is quoted by `briefForCheck`'s docstring and not
implemented by its body.

```
   AG1  `briefForCheck` reserved half the judge's budget for the accumulated
        follow-ups and then never spent the other half on them, so on a SHORT
        original brief — the ordinary shape — the judge was shown one of four
        steers and 1,019 characters of a 1,500-character budget went unused. Its
        own docstring says it applies `appendFollowUp`'s split; that one gives
        the follow-ups everything the original does not use. Every AF5 test
        uses the one shape where the two agree.             MEDIUM · FIXED

   AG2  Every loop turn is delivered through `pi.sendMessage(…, {triggerTurn:
        true})`, which is `AgentSession.sendCustomMessage` — and its
        `triggerTurn` branch calls `_runAgentPrompt` directly. `prompt()`
        refuses while a compaction is in progress; `_runAgentPrompt` does not
        check. So the loop's next iteration started an agent run INSIDE somebody
        else's compaction, and pi's `compact()` ends by REPLACING
        `agent.state.messages`. The flag that would have said so —
        `compactionInFlight()` — is in this package, and `sendLoopTurn` did not
        read it.                                            MEDIUM · FIXED

   AG3  The same moment, from the other extension. `prinny-channel`'s empty-turn
        CONTINUATION is sent from `forwardResult()`, which runs on the
        `agent_settled` the loop has just requested an emergency compaction on —
        loop first, prinny second. The nudge was refused by pi, silently; one of
        the two retries was spent on a send that never happened; the answer the
        continuation exists to produce never came. `startCompaction` twelve
        lines away reads `compactionInFlight()` before it acts. This sender did
        not.                                                MEDIUM · FIXED

   AG4  §1.D of five documents — the event-bus table every ordering argument in
        this series is read off — drew `pi-subagents-lite` handling
        `agent_start`, `message_end` and `agent_end`, which it does not, and
        omitted `tool_call`, which it does, and `turn_start`, which had no row at
        all. Carried since the eleventh pass.                MEDIUM · FIXED

   AG5  `bulkReport`'s partial line said "N were still busy and were left alone"
        for BOTH verbs. A refused `clear` does mean still busy. A refused
        `stop` is reachable from exactly one `return false`, and it means the
        record had already FINISHED — the one thing the sentence ruled out. The
        same module's single-agent sentence gets it right.     LOW · FIXED

   AG6  All four notices about a background subagent result that was not
        delivered ended "Read it with AgentStatus", and `AgentStatus` prints
        `id (type) status` and nothing else. `/agents` → "View result" is the
        surface that can show it; `nudge-drop.ts`'s own header named both and
        shipped the half that does not work.                   LOW · FIXED
```

**All six are fixed**, each with a regression test that fails when the fix is
removed, and each probe rewritten afterwards to print BEFORE and NOW so it is its
own control. §11 has the change and the control-run failing count for each.

```
                                    before    after
   vendor/pi-loop-mode      tests     218       223
   vendor/pi-subagents-lite tests     329       346    lint 91/91 files
   vendor/prinny-channel    tests     377       382    lint clean
   .pi/extensions/compaction-guard     47        47
   vendor/rtk-pi            tests      20        20
                                     ─────     ─────
                                      991     1,018
   probes                               67        72
```

The gates were re-run **before** anything was written, so the *before* column is
a measurement of the tree as this pass found it rather than a claim about it.

---

## 0. How to read this, and what it is for

This document is written for somebody who has never seen the stack. It is long
because the machine is: five extensions, two entry points, one llama slot, three
nested units of a turn, and about 21,000 lines of source with a comment density
closer to a design document than to code.

The order is deliberate:

- **§1** is the whole machine in one drawing. Everything after it is a zoom into
  a part of that drawing, and every section says which part.
- **§2** is pi itself — the substrate the five extensions are bolted to. Read it
  even if you know pi, because three of this pass's six findings and most of the
  previous fifteen passes' turn on details of it that are not documented
  anywhere else.
- **§3** is the event bus: who handles what, in what order, and which four of
  those orderings decide behaviour.
- **§4**–**§9** are the five packages, one at a time, in full.
- **§10** is the handful of invariants that hold across all of them.
- **§11** is the findings, each with its reproduction.
- **§12**–**§15** are the evidence, what is open, the pattern across sixteen
  passes, and where to look next.

Two conventions carried from the earlier documents and worth knowing:

- A **✋** marks a place the stack deliberately declines to act. There are
  forty-five of them; §2 of `…-omissions.md` is the full ledger and this
  document does not restate it.
- A **◆** marks module-global state — a variable that is shared by every session
  in the process, which on this stack includes a subagent's session, because a
  child binds the parent's extensions through node's module cache. That fact is
  responsible for more findings in this series than any other single property of
  the machine.

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
  │                    a subagent's own runner (session.prompt)                     │
  │                    pi.sendUserMessage()  ← prinny-channel's ONLY route          │
  │                                                                                 │
  │   text starts "/" && expandPromptTemplates                            :800      │
  │        ─▶ _tryExecuteExtensionCommand ─▶ RETURN. no turn.                       │
  │           ▲ EXTENSION commands only (/loop /agents /prinny /stack).             │
  │             pi's BUILT-INS — /compact, /model, /new — are executed by the       │
  │             TUI's own input handler and are unreachable from here.              │
  │   _compactionAbortController !== undefined                            :807      │
  │        ─▶ THROW "Cannot submit a prompt while compaction is in progress" ✋     │
  │           ▲ THE REFUSAL AG2 IS ABOUT. It exists only on this path.              │
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
  │        ▲ AND NO COMPACTION CHECK                               ← AG2       │
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
    │              This is why one run can owe TWO Matrix rooms.  [AF1]
    │     emit agent_end { messages: newMessages }
    │            ▲ pi-loop-mode counts THIS as one "iteration"
    │
    ├── _handlePostAgentRun()                                              :757
    │     _prepareRetry(msg)?  _checkCompaction(msg)?  agent.hasQueuedMessages()?
    │        any true ─▶ await agent.continue()  → ANOTHER agent RUN
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
  C.  THE FIVE EXTENSIONS, in load order, with what each one is for
 ═════════════════════════════════════════════════════════════════════════════════

  scripts/pi-local.sh passes them as `-e` in THIS order, and the order is
  load-bearing in three separate places (§3):

    1. .pi/extensions/stack.ts           /stack · guards itself in a child
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

 ═════════════════════════════════════════════════════════════════════════════════
  D.  A DELEGATION — the Agent tool, end to end
 ═════════════════════════════════════════════════════════════════════════════════

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │  ◆ module-global state, shared by EVERY session in this PROCESS:         │
   │      pi-loop-mode   state:LoopState · runToken · pendingTimer · 4 buffers│
   │      pi-subagents   shell{pi,sessionCtx,manager,widget,store,coordinator}│
   │      prinny         child · awaitingReply · typingRooms · deliveryTimer  │
   │                     pendingCompaction · agentRunning · lastAssistantText │
   │      compaction-gd  spillDir (a mkdtemp, first use, bounded at 50 files) │
   │      rtk-pi         (none — the gate is a pure function)                 │
   │      globalThis     __PI_SUBAGENT_SPAWN_DEPTH__                          │
   │                     __PI_COMPACTION_IN_FLIGHT__   ← the fifteenth pass's │
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
   └───────────────────────┘    └────────────────┬───────────────────────────────┘
                                                 │ runAgent()
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  THE BUILD WINDOW — seconds, and the depth flag is up for all of it      ┃
   ┃    enterSubagentSpawn()   ◆ __PI_SUBAGENT_SPAWN_DEPTH__ = 1              ┃
   ┃    reloadAndMap()         EVERY extension factory runs AGAIN —           ┃
   ┃                           and rtk's shells out to `rtk --version`        ┃
   ┃    createAgentSession()   → onSessionCreated  (the only handle out)      ┃
   ┃    bindExtensions()       the child's session_start                      ┃
   ┃    resolveVisibleTools → setActiveToolsByName                            ┃
   ┃    exitSubagentSpawn()    ◆ depth = 0   ← the bracket ends HERE, not     ┃
   ┃                              at the end of the run                       ┃
   ┃    runTurnLoop: if (signal.aborted) throw ABORTED_BEFORE_START           ┃
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
   │    → repair  the CHILD's own session, 1 turn, the WHOLE brief                │
   │    → judge again → … up to `rounds`                                          │
   │    rewrites record.result IN PLACE, so every reader sees ONE answer          │
   └──────────────────────────┬───────────────────────────────────────────────────┘
                              │ .finally: settlementCount++, release slot,
                              │           tally, drainQueue, open the gate
              ┌───────────────┴────────────────┐
              ▼                                ▼
   ┌────────────────────────┐    ┌──────────────────────────────────────────────┐
   │ FOREGROUND             │    │ BACKGROUND / CONTINUATION                    │
   │  the completion gate   │    │  tallyCompletion → onComplete                │
   │  resolves the promise  │    │   → coordinator.onAgentComplete              │
   │  coordinator.spawn     │    │   → scheduleNudge (200 ms batch)             │
   │  has been awaiting     │    │   → emitIndividualNudge                      │
   │        │               │    │        ✋ disposed ✋ no pi ✋ no record     │
   │        ▼               │    │           — all three now REPORT (§11.1)     │
   │  formatResultContent   │    │        capBackgroundResult(ctx, …)           │
   │        │               │    │        pi.sendMessage({subagent-result},     │
   │        ▼               │    │                       followUp, trigger)     │
   │  the Agent TOOL RESULT │    │             │                                │
   │  → the guard's cap     │    │             ▼                                │
   │  → THE PARENT MODEL    │    │  ENTRY POINT 2, and a `void` return          │
   └────────────────────────┘    └──────────────────────────────────────────────┘

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
   │   awaitingReply.set(room, mergeAwaiting(previous, arrival))              │
   │        live      evidence about the ROOM, and never taken back down      │
   │                  except by the empty-turn stand-down                     │
   │        answered  something has been SENT for this message                │
   │        injected  exactly what pi was handed — markLive matches it        │
   │   armDeliverySweep()                                                     │
   │        ├─ refuse ✋▶ reply(reason)               answered = true         │
   │        ├─ local  ─▶ THIS extension performs it   answered = true         │
   │        │            /compact → planCompaction(hasSession, agentRunning)  │
   │        │              busy ✋▶ DEFER to agent_settled                    │
   │        │              idle → startCompaction(room)                       │
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
   agent_settled  (prinny runs SECOND — the loop has already run)
        ◆agentRunning = false · stopTyping()
        forwardResult()  ────────────────────────────────────┐
           forward:"result" → forwardToMatrix(lastAssistantText)
              ✋ nothing to send · ✋ no live room                │
              ✋ TWO live rooms → remembered, and both told       │
              ✋ already sent · ✋ channel down                   │
           empty ending → a bounded CONTINUATION, and the room    │
              stands DOWN until markLive fires for the nudge    │← AG3 is HERE
           ✋ retries spent → giveUp, which COUNTS as an answer  │
           tell every live room that got nothing                 │
           retire live rooms · alreadySent.clear()               │
           sweepUndelivered()                                    │
        standAside(pendingCompaction, continuationStarted) ◀─────┘
        drainPendingCompaction() → startCompaction()
              ✋ compactionInFlight() → "already running"   ← read HERE and
                                                              nowhere else
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, a Matrix answer, a compaction summary and the parent's next call are
six things in one queue. Almost every design decision in the five packages is a
consequence — the concurrency default of 1, the verifier's round budget, the
structural gate that refuses to spend a model call on a run that was cut off, the
denial of the `loop` tool to children, the tool-schema folding in `prinny`.

---

## 2. The substrate: what pi does, and the parts of it that matter

Everything in §4–§9 is an extension bolted to the object described here. Three of
this pass's six findings are properties of it, so it comes first.

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

Six of the fifteen previous passes have a finding that reduces to one row of this
table. AA1 is the `before_agent_start` row (the loop's system-prompt block never
reached a loop turn). AA3 is the `hasPendingMessages()` row (the guard the loop
thought was about background results is only ever about a human typing). AA4 is
the `deliverAs` row. Z4 is the `_pendingNextTurnMessages` row (the loop queued a
directive into the one array nothing it can do will drain). AB2/AC1/AE4 are the
`void` row. **AG2 is the compaction row**, and it is the only row in the table
that had never been read.

The `void` row deserves one more sentence because it recurs. pi's binding is:

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

That is why `prinny-channel` has a *delivery sweep* — it cannot observe a failed
send, so it watches for the absence of the success instead.

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

Three things follow, and each cost a finding:

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
   that arrive while pi is busy are both answered inside one `agent_end` — which
   is how one run comes to owe two rooms an answer it cannot attribute (AF1).

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
not empty. Fired from the first call site the anchor rode on a turn that was
already coming; fired from the second it *manufactured* one, whose reply became
the child's answer. `compaction-anchor.ts` is the predicate that tells them apart.

### 2.4 `compact()`, in the order it does things

AG2 and AG3 both live here, so this is the sequence in full:

```
   AgentSession.compact(customInstructions)                          :1367
     await this.abort()                    ← cancels whatever was running
     this._compactionAbortController = new AbortController()
                                           ← from HERE prompt() refuses
     emit compaction_start
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
backstop for a future pi that changes it.

Two consequences neither package reads:

- The window between `await this.abort()` and the controller being assigned is
  a real one. It is a microtask, not a scheduling risk in practice, but it means
  "a compaction is running" and "`prompt()` will refuse" are not the same
  instant.
- **`agent.state.messages` is REPLACED at the end.** A run started during a
  compaction is streaming into an array that is about to be thrown away. That is
  the damage behind AG2.

### 2.5 What the extension runner guarantees

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
  are separate methods with their own merge rules. `emitToolResult` threads one
  shallow copy through every handler and merges `content` / `details` / `isError`
  / `usage` from each return, so the second handler sees the first's edit —
  which is exactly how `compaction-guard` caps a result the loop has already
  fingerprinted.

---

## 3. The event bus, corrected

This is §1.D of the previous five documents, **rebuilt from the source**. AG4 is
that the table below is not what those documents draw.

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

The five differences this pass found in the table as it stood in
`…-omissions.md`, `…-claims.md`, `…-controls.md`, `…-deliveries.md` and
`…-signals.md`:

```
   subag  agent_start    drawn ✓   NOT REGISTERED
   subag  message_end    drawn ✓   NOT REGISTERED
   subag  agent_end      drawn ✓   NOT REGISTERED
   subag  tool_call      drawn —   REGISTERED  (events.ts:227, toolCallListener)
   subag  turn_start     no row    REGISTERED  (events.ts:229)
```

`vendor/pi-subagents-lite` registers four handlers, all of them in
`src/events.ts`, and nothing anywhere else in the package calls `pi.on`. The
same documents' §1.C table already says "4 handlers" for that column, so the two
tables in one document disagreed with each other, and the correct one was the
summary.

**All five are now corrected in place**, each with a note under it recording what
it drew and for how long — the log is a record of what was believed and why, so
the correction is stated rather than made silently.
`context/testing/probes/t5-the-event-bus-the-map-draws.mjs` re-derives this table
from the source and diffs it against any document given as an argument; all six
now pass it. §11.4 is the account.

### 3.1 The four orderings that decide behaviour

```
   context        loop FIRST. It appends `loop-context-budget`; the guard sees
                  the shared `-context-budget` suffix and stands down. BOTH
                  sides check, so neither ordering can produce two notices.  ✔

   tool_result    loop FIRST. It fingerprints the RAW output into the stuck
                  window; the guard's cap runs after. The loop also strips any
                  shortening marker before fingerprinting, so the ordering is
                  belt-and-braces rather than load-bearing.                  ✔

   tool_call      prinny FIRST, then rtk, then subagents. NOT symmetric,
                  because `{block:true}` returns from `emitToolCall`
                  immediately — so a blocked call never reaches rtk's rewrite
                  or the subagent model injection.                           ✔

   agent_settled  loop FIRST (it may request an emergency compaction), prinny
                  SECOND (it may continue an empty run, then compact). The
                  compaction↔compaction half of this was closed in the
                  fifteenth pass by a shared lock; the compaction↔CONTINUATION
                  half is AG3 and is closed by the same lock, read by its
                  second caller in that file. What no lock can cover is pi's
                  OWN threshold and overflow compactions, which no extension
                  requests and therefore none can mark.                      ✔
```

A note that has survived four passes and still holds: **the `tool_call` row is
the only place a shell command can be reviewed.** `pi.exec` — which the loop's
goal check and rtk's own version probe both use — is `execCommand` directly and
emits nothing on this bus. That is why `--check` is refused from Matrix (AD6):
one string, two doors, and only one of them is watched.

---

## 4. `vendor/pi-loop-mode` — the unattended run

3,107 lines in `extensions/index.ts` plus seven modules under `src/`. A fork of
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

— because `state`, `runToken`, `pendingTimer` and the four buffers are ◆
module-global, and a child session binds *this same module* with its own event
bus. Without the guard every handler ran twice per delegation against one
`LoopState`: the child's `agent_end` drove the operator's iteration ladder,
delivered the operator's next loop turn *into the child*, and persisted the
operator's state into the child's throwaway branch. `subagent-denylist.ts` also
stops the package being handed to a child at all, which additionally saves the
child ~177 tokens/turn of `loop` tool schema.

### 4.2 `agent_end` — the ladder

This is the heart of the package. Eighteen exits, in order, and the order is the
design: the guards that mean "this turn was not a real turn" come first, so the
counters below them are only ever charged for turns that happened.

```
   agent_end
     ✋ !state.active → (unless status "preparing": watch for GOAL_READY) return
     clearPendingTimer()                 token = runToken   ← captured for the awaits
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
                                       else contextRecoveryPending      RETURN
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

Five of those exits carry a DIRECTIVE — `improve`, `unblock`, `check_failed`,
`regression`, `audit` — and go through `deliverLoopTurn()`, which sends the text
onto the turn that is already coming when a message is pending rather than
dropping it. `continue` deliberately still drops: any turn advances an endless
loop, and injecting 1,200 characters of loop rules onto a turn the operator typed
for their own reasons is the other kind of mistake. That asymmetry is AF3, and
§11.5 of `…-omissions.md` is the decision.

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

### 4.5 The three escalation ladders, and where each one stops

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

   CONTEXT (isContextPressure → contextRecoveryPending → agent_settled)
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
     unattended run should ride out a restarted llama-server. Ten against that
     backoff is about half an hour of nothing working.

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

`ExecResult` is `{ code, stdout, stderr, killed }`, and two facts are missing
from it. Both cost a finding:

```
   measured against pi 0.84.2's real execCommand
     bash -lc 'kill -9 $$'      → { code: 0, killed: false }   an OOM kill
     bash -lc 'kill -TERM $$'   → { code: 0, killed: false }   an external stop
     bash -lc 'exit 1'          → { code: 1, killed: false }   a real failure
     bash -lc 'sleep 5' (t=0.3) → { code: 0, killed: TRUE  }   pi's own timeout
```

- `execCommand` never rejects — it is `new Promise((resolve) => …)` with no
  `reject` in the body — so a `catch` around it is unreachable, and for two
  passes `checkErrorStreak` never advanced. `result.killed` is the field that
  actually reports pi's own timeout. **(AA2)**
- `killed` is only pi's *own* kill: `killProcess()` has exactly two callers, the
  timeout timer and the caller's `AbortSignal`. Everything else that can end a
  check — the OOM killer, an operator's `pkill`, a container going down — comes
  back `{ code: 0, killed: false }`, which is the shape of a check that PASSED,
  which in `--until-done` is the only condition that ends a run. **(AB1)**

The answer had to come from inside the child, so the command runs under a bash
`EXIT` trap that prints a marker:

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
its own verdict. Presence is the only signal taken. A check whose own output
contains the token can still fake completion; that residue is stated rather than
guarded, and the token is long and namespaced.

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
     oversized (the runaway tool result is usually what saturated the context)
     and finally to pi's own cut, which is always valid
     and NO MODEL CALL AT ALL — which matters because after an overflow the
     summariser is the same model that just refused this context
```

The section ORDER being different from the section PRIORITY is the repair: the
per-section budgets do not fit inside the total (level 0 has room for 3,531
characters of body while its sections may claim 7,500), and before the fix the
body was assembled and then cut with a blind `slice()` from the front — so what
fell off the end was `## File Operations` first and `## Durable Project Context`
next, which are the two sections that carry the work forward, at exactly the
compression levels reached only after a recovery that did not free enough room.

### 4.8 The `loop` tool, and the one place the fork widened the surface

Upstream exposes loop control only as `/loop`, which means only a human can start
one — the model cannot type a slash command. The fork registers a `loop` tool as
well, and the interesting part is what it refuses:

```
   TOOL_ACTIONS = { start, stop, status, finish, resume, end, stats }
     ✋ anything else → isError, naming the valid set.
        The command's LAST branch treats an unrecognised word as a GOAL and
        starts an endless loop on it, which is right for a human and a live
        grenade for a model that invents a verb: loop(action:"pause") used to
        start an endless loop whose goal was the word "pause".
   ✋ start with a loop already running → isError, naming the running goal.
        `/loop start` from a human still replaces, deliberately — the stop
        notice advertises it. A tool call cannot be asked whether it meant to.
   ✋ the `goal` parameter is NEVER handed to the flag parser.
        parseStartArgs scans the WHOLE line for flags, so a goal containing
        `--check "<shell>"` used to become a command run every iteration for
        the life of the run — and won over the tool's own `check` parameter,
        because extractCheckCommand takes the FIRST match and the goal is
        spliced in first. The tool now builds a StartArgs literal.
        A goal that contains flag-like text is kept as text AND said out loud.
```

---

## 5. `vendor/pi-subagents-lite` — delegation

~21,000 lines across `src/`, of which about half is UI. A fork of upstream
1.11.0.

**What it is for.** The model calls `Agent(prompt, agent, run_in_background?)`
and a *whole second pi session* is built inside this process — its own system
prompt, its own tool set, its own 32k window, its own event bus — runs to an
answer, has that answer checked, and hands it back. `StopAgent` and
`AgentStatus` are the model's two other handles on it; `/agents` is the
operator's.

### 5.1 A record's life

```
  spawn(pi, ctx, type, prompt, options)                    agent-manager.ts:257
    id = randomUUID().slice(0,17)
    modelKey? → slot = slotFor(modelKey)
                slot.running >= slot.limit ─▶ QUEUED (not refused)
    record = { lifecycle{status, startedAt, started:false}
               display{type, description, invocation, worktree…}
               execution{abortController, modelKey, settled:false,
                         settlementCount:0, brief: prompt}
               stats{lifetimeUsage, toolUses, turnCount:0, compactionCount:0} }
    record.execution.promise = createCompletionGate(id)
        ▲ EVERY record carries a gate from BIRTH, opened exactly ONCE at its
          terminal transition — settlement, a queued stop, a start failure, an
          already-aborted spawn, dispose, removal. It is never the run's own
          promise, so a run that rejects cannot leave a caller hanging.
    options.signal?.aborted ─▶ stopAgent(record,"user"); return id
    options.signal          ─▶ bind abort → this.abort(id,"user")
    queued ─▶ return id
    startAgent(id, record, args, slot)
        slots.reserve(record)   ◆ record.execution.holdsSlot = true
        status "running", started = true, watchdog.start(id)
        outputTranscript? → AgentOutputLog
        promise = runAgent(ctx, type, prompt, {…callbacks…})
        attachSettlementChain(record, promise, buildVerifyDeps(pi, ctx, record))

  ── runAgent, inside the spawn bracket ─────────────────────────────────────
    enterSubagentSpawn()          ◆ __PI_SUBAGENT_SPAWN_DEPTH__ = 1
      loader.reload()               every extension factory runs AGAIN
      createAgentSession(...)       → onSessionCreated  ← FIRES HERE, before
                                       bindExtensions, so the ONE handle out
                                       exists before anything can throw   [W6]
      session.bindExtensions()      the child's session_start
      resolveVisibleTools → setActiveToolsByName
    exitSubagentSpawn()           ◆ depth = 0
        ▲ the bracket covers the BUILD, not the run. It used to wrap the whole
          of runAgentImpl, so a `/reload` during a background delegation made
          THIS extension's factory return early and the operator lost the
          Agent/StopAgent/AgentStatus tools and the widget.
    runTurnLoop:
      ✋ signal.aborted ─▶ throw ABORTED_BEFORE_START
          — because addEventListener("abort") on an already-aborted signal
            never fires, and everything above it is seconds of work on a 9p
            mount. Throwing, not aborting: session.abort() before prompt()
            is consumed by nothing and the prompt would run anyway.    [AB4]
      await session.prompt(prompt)
      return collector.getText().trim() || collector.getLastMessageText()

  ── attachSettlementChain ──────────────────────────────────────────────────
    .then:   status = classifyRun({aborted, modelError, turnLimited})
             record.result = responseText
             await runVerification(record, verifyDeps)      ← §6, MINUTES
             modelError → record.error = formatModelError(...)
             completedAt ??= now
    .catch:  status = "error" (unless "stopped"), result = undefined
    .finally:++settlementCount
             outputLog.finalize()
             slots.release(record)     ◆ holdsSlot = false
             tallyCompletion(record) → onComplete → coordinator
             drainQueue()
             detachParentBinding(record)
             openGate(record.id, record.result ?? "")
             record.execution.settled = true
```

Two properties of that chain are load-bearing and easy to miss:

- **The status goes terminal BEFORE the verifier runs.** For the whole of a
  judge and up to three repairs the record reads `completed` while a model call
  is in flight on the one llama slot the parent is queued behind. `verifyPhase`
  is the only field that says so, and `record-activity.ts` exists so that the
  five readers of "is this record busy" all ask the same question. Four findings
  (Y1, T5, AD2, AE5) are one reader that did not.
- **The slot is held right through the verification window**, which is wider
  than `status === "running"`. `holdsSlot` is the authority, and
  `SlotTable.recount()` re-derives every count from the holders on any config
  change — because a `setLimits()` that dropped the auto-created per-model slot
  used to take the running agent's count with it, letting a second child start
  against `PARALLEL_SLOTS=1`.

### 5.2 The three surfaces an operator or a model acts through

```
                      MODEL                      OPERATOR
   spawn              Agent tool                 /agents → spawn wizard
   stop               StopAgent tool             /agents → Stop · Esc in the
                                                 conversation viewer
   inspect            AgentStatus tool           /agents · the widget
   steer / continue   (none)                     /agents → Steer · the viewer's
                                                 composer
   read the answer    the tool result, or the    /agents → View result
                      background nudge
```

The row that matters for AG6 is the last one: **`AgentStatus` prints
`id (type) status` and nothing else.** It is a "what is still happening" tool,
not a "what did it say" tool, and it is bounded (`MAX_SETTLED_LISTED = 6`
settled records plus every unfinished one, with the elided count stated) because
`AgentManager` never evicts a settled record and a fifty-delegation session
otherwise puts a 2 kB line into the window the tool exists to report on.

### 5.3 The concurrency slot, and why the default is 1

Upstream's default is 4. This fork's is 1, and the reasoning is measured rather
than assumed:

```
   llama.cpp here runs PARALLEL_SLOTS=1, so four in-flight subagents do not
   execute concurrently — they queue at the server, and the queue that forms
   there is the worse of the two: four live sessions each hold their own
   context alive and four growing prefixes compete for one prompt cache.

   Measured, because the obvious version of that claim turned out to be WRONG:
   a subagent having its own system prompt does NOT by itself evict the
   parent's cached prefix — the parent held a 99.2% cache hit across six small
   child turns. What evicts it is SIZE. A child that grew to 18k tokens took
   the parent's next call from 2,117 cached tokens to zero, and from 442 ms to
   2,949 ms. Serialising children means at most one foreign prefix competes at
   a time, and that is the difference the default actually buys.
```

Three consequences worth holding on to:

- `continueSettledAgent` **refuses rather than queues** when the slot is full —
  so at a limit of 1, every continuation attempted while another agent runs is
  refused. That is the likeliest reason an operator's typed follow-up does
  nothing, which is why `steerReport` names it.
- The judge goes around `spawn()` entirely and calls `runAgent` directly,
  because the child's slot is only released in the `.finally` that follows the
  verification — a judge that asked for a slot would wait for a slot that is
  waiting for the judge. At a limit of 1 that is a deadlock, not a slowdown.
- Going around `spawn()` means going around every teardown `spawn()` arranges,
  so the judge's session is disposed in its own `finally`, from a handle
  captured in `onSessionCreated` rather than read off the result — because
  `result` is only assigned when the await *resolves*, and every rejection after
  `createAgentSession()` returned would otherwise drop the only reference to a
  live session.

### 5.4 What a child inherits, and what it must not

```
   route A — DISCOVERY.  ~/.pi/agent/extensions/** and <cwd>/.pi/extensions/**
             when the project is trusted. Everything in this repo's own
             .pi/extensions/ reaches a subagent FOR FREE.
   route B — additionalExtensionPaths, i.e. subagentExtraExtensionPaths().
             Everything under vendor/ is invisible to a child unless named.

   kept:     compaction-guard  (route A) — measured capping a CHILD's own read
                                result at 9,778 → 8,176 chars. A child that
                                blows its own window returns nothing.
             browser-guard     (route A) — registers no tools
             rtk-pi            (route B, deliberately put back) — a child handed
                                bash ran `git status --short` unrewritten, and
                                the child is the session that can least afford
                                the bytes
   denied:   prinny-channel    — by PATH, not by name, because
                                extractExtensionName() derives "index" for all
                                three vendor packages and resolvePackageShortName
                                fails on prinny's manifest. Unconditional, and
                                the denial also filters SUBAGENT_EXTRA_EXTENSIONS,
                                so it cannot be added back.
                                "A subagent can post to a Matrix room" is not a
                                per-agent preference to get wrong once.
             prinny-access, prinny-configure  (skills)
   inert:    pi-loop-mode      — its own factory guard, plus removal from route
                                B. Its state is module-global; a child's copy
                                drove the operator's loop.
             .pi/extensions/stack.ts — guards ITSELF, with the same global,
                                because a path fragment naming this checkout's
                                layout is exactly the mistake the prinny
                                pattern was rewritten to stop making.
```

`tests/subagent-denylist.test.ts` carries the standing rule: **every entry point
under `.pi/extensions/` that registers a model-visible tool must guard itself.**

### 5.5 The turn ceiling, and the one-turn exception

A subagent always has a ceiling, even when nothing set one — `DEFAULT_MAX_TURNS
= 40`. Upstream leaves it undefined, which means unbounded, and that is not
defensible here: `AgentSession.prompt()` defaults `expandPromptTemplates` to
true and this fork calls it bare, so a prompt beginning `/loop …` starts a real
loop *inside the child*. An unbounded loop on a one-slot server is not a runaway
subagent, it is a stopped machine.

On reaching the ceiling the run is steered "wrap up immediately" and hard
aborted `graceTurns` later, so hitting it produces a final answer rather than a
severed run. **Except at `maxTurns: 1`**, and the exception is not cosmetic:

```
   pi drains the steering queue immediately after turn_end, inside
   `while (hasMoreToolCalls || pendingMessages.length > 0)`, and _emit calls
   subscribers synchronously — so a steer queued from a turn_end handler is
   picked up before the loop can decide to stop.

   A one-turn run therefore takes a SECOND provider call, and
   collectResponseText resets on the injected message's message_start, so the
   text handed back is the reply to "wrap up" rather than the answer.

   Both of the verifier's model calls run with maxTurns: 1. Measured against a
   loop-faithful stub with the real runSessionPrompt: a judge that replied
   `VERDICT: NOT_ADDRESSED` had that verdict replaced by "I have already given
   my final answer above", which parseJudgeVerdict reads as unreadable and
   therefore — by the fail-open policy — as a PASS.
```

So the wrap-up steer is skipped at a budget of one turn, and `turnLimited`
follows the *steer* rather than the ceiling — because both readers of that flag
(the status note the parent reads, and the verifier's structural gate) take it to
mean "cut short", and reaching a one-turn ceiling IS finishing. `ceilingReached`
is kept separate and still arms the grace-turn abort, so a one-turn run that
keeps calling tools is still severed and *then* reports `aborted`, which is true.

### 5.6 What a run actually said

`collectResponseText` keeps one entry per MESSAGE and returns the last non-empty
one, with the finalized messages as a fallback. Both halves were paid for:

- Keeping one string reset on every `message_start` returned the last MESSAGE of
  the run, not its ANSWER — and `message_start` fires for injected user messages
  too, of which this package injects two (the turn-limit steer, whose reply IS
  the answer, and the task anchor, whose reply is not). Measured: a child that
  answered and was then compacted handed its parent *"Understood — nothing
  further to add."*
- The fallback used to index into `session.messages` from a position captured
  before the prompt. pi does not splice that array on a compaction, it
  **replaces** it with a shorter one, so after a compaction the index pointed
  past the end and the fallback returned `""` — reported to the parent as *"The
  agent returned no answer at all."*

---

## 6. The verifier — is the answer an answer to the question that was asked?

Three files: `verify.ts` (what the verdict is), `verify-runner.ts` (when to spend
a model call on one), `verify-log.ts` (what was actually said). It runs inside
`attachSettlementChain`'s `.then`, before anybody reads the answer.

### 6.1 The failure it exists for

A subagent gets a brief it cannot see the context for, works in its own window,
and when that window fills pi compacts it and it carries on from a summary. pi's
summaries grow monotonically, and what they erode first is the oldest thing in
the transcript — **which is the brief**. A child that has compacted three times
is answering a question that has quietly drifted from the one it was given, and
nothing else in the pipeline notices: `formatResultContent()` hands the parent
whatever the child said last, and the parent has no view of the child's reasoning
to judge it by.

### 6.2 Three layers, cheapest first

```
  ┌─ 1. ANCHOR — no model call ─────────────────────────────────────────────────┐
  │  After each compaction, restate the brief into the freshly-summarised       │
  │  context. Prevention beats detection.                                       │
  │  ✋ only into a run that is still going — anchorReachesATurn(info):         │
  │       info.afterRun !== true || info.willRetry === true                     │
  │     because session.steer() into a FINISHED run manufactures a whole        │
  │     extra turn whose reply becomes the child's answer.            [Z2]      │
  └─────────────────────────────────────────────────────────────────────────────┘
  ┌─ 2. STRUCTURAL GATE — no model call ────────────────────────────────────────┐
  │  structuralVerdict(answer, lifecycle)                                       │
  │    ""              → ok:false          skipped-empty                        │
  │                       (the note REPLACES the answer — an empty string       │
  │                        reads to the parent as a successful lookup that      │
  │                        found nothing)                                       │
  │    status "error"  → worthJudging:false, skip:"error"                       │
  │                       — executeAgentTool intercepts error status and        │
  │                         returns errorResult(record.error), so record.result │
  │                         is read by NOBODY. Judging it spends calls on       │
  │                         text that is discarded.                             │
  │    aborted | turn_limited | stopped → skip:"cutoff"                         │
  │    otherwise       → worthJudging:true                                      │
  │  and one more in the runner: no brief → skipped-nobrief                     │
  │                       — reported separately because it is a fault in US     │
  └─────────────────────────────────────────────────────────────────────────────┘
  ┌─ 3. JUDGE + REPAIR — one to seven model calls ──────────────────────────────┐
  │  for (;;)                                                                   │
  │    phase "judging"                                                          │
  │    reply   = judge(buildJudgePrompt(brief, candidate))                      │
  │    log{ phase:"judge", prompt, reply, parsed, ms }                          │
  │    verdict = parseJudgeVerdict(reply)                                       │
  │    ✋ unparsed        → candidate + note("unparsed", attempts)   RETURN     │
  │    ✋ addressed       → attempts===0 ? candidate                            │
  │                         : candidate + note("repaired", attempts) RETURN     │
  │    ✋ attempts>=rounds→ ORIGINAL + note("failed", attempts)      RETURN     │
  │    ++attempts; phase "repairing"                                            │
  │    outcome = repair(buildRepairPrompt(brief, verdict.why))                  │
  │    log{ phase:"repair", prompt, reply, runStatus, ms }                      │
  │    ✋ the repair's OWN structural gate fails → ORIGINAL + "failed"          │
  │    ✋ repaired === candidate.trim() → ORIGINAL + "stalled"                  │
  │    candidate = repaired                                                     │
  └─────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 The two asymmetries, and both are the design

```
   JUDGE                                  REPAIR
   a FRESH __verifier session             the CHILD's own session
   no tools, no extensions, no skills     all of the child's
   no history                             all of the child's
   1 turn                                 1 turn + graceTurns
   shown briefForCheck(brief, 1500)       shown the WHOLE brief
   and truncate(answer, 4000)
```

The judge is harder to fool **because it knows less**. The obvious
implementation — ask the child "does that answer the question?" — is the weakest
one available: every step that led it astray is in its context with a
justification attached, and a model handed its own reasoning ratifies it. The
repair goes the other way, because the child is the only thing with the context
to actually fix the answer.

`buildRepairPrompt` restates the brief **in full** rather than referring to it,
because the reason the child is being asked again is that its context may no
longer contain it — pointing at "the original task" would point at the thing that
went missing.

### 6.4 Reading the judge — and why the parser is this careful

The judge is the same 27B that wrote the answer, and a small local model echoing
its own instructions is one of the most common reply shapes there is. Four
findings in this series (S2, U4, V5, W5) are each a statement about a string
that existed for a few milliseconds inside `verifyAnswer` and was then dropped.

```
   the prompt ends with, LITERALLY:
       VERDICT: ADDRESSED or NOT_ADDRESSED
       WHY: one sentence, and if NOT_ADDRESSED say what the task asked for
            that the answer does not give.
   — and both constants are exported and used by the PARSER, so a reword of the
     prompt cannot silently reopen S2 or U4.

   parseJudgeVerdict, in order:
     1. scan lines NEWEST-FIRST for /^[\s>*_#-]*verdict[\s*_]*:\s*(.*)$/
        ✋ VERDICT_MENU — "ADDRESSED or NOT_ADDRESSED" — is not a choice; fall
           through to the next line rather than reading the MENU as a verdict
        NOT_ADDRESSED tested FIRST, because "NOT_ADDRESSED" contains
        "ADDRESSED" and the wrong order turns every failure into a silent pass
        the WHY is read from BELOW the deciding line, then from the last usable
        line — an echo puts its WHY before the verdict, a real answer after it
     2. only if no line decided: a bare token anywhere, with the menu removed
     3. otherwise unparsed → ADDRESSED, with the flag kept
        Fail-open on purpose: a judge that answered in a shape nobody asked for
        is evidence about the JUDGE, not about the answer, and failing a good
        result because a 27B was chatty makes the layer worse than not having it.
```

**Known, recorded three times, still open: `UNADDRESSED` reads as ADDRESSED on
the `VERDICT:`-line path** — `/NOT[_\s-]?ADDRESSED/` does not match it and
`/ADDRESSED/` does. The prose path is anchored (`\bADDRESSED\b`) and does not.
§11.11 of `…-omissions.md`.

### 6.5 The brief, and the two ends it is cut at

```
   appendFollowUp(brief, steer)                       MAX_BRIEF_CHARS = 6,000
     original ──▶ "\n\nFollow-up: " ──▶ steer1 ──▶ … ──▶ steerN
                                                          ▲ grows at the TAIL
     when it overflows: the OLDEST follow-ups go; the original always survives;
     the newest follow-up is never dropped, only truncated
     budget for the follow-ups = MAX_BRIEF_CHARS - original.length
                                 ▲ EVERYTHING THE ORIGINAL DOES NOT USE

   briefForCheck(brief, 1_500)         ← the judge, and the compaction anchor
     budget for the follow-ups = floor(1_500 * 0.5) = 750
                                 ▲ A FLAT SHARE, AND THE REMAINDER IS NOT SPENT
```

That difference is **AG1** (§11.1). Before AF5 both readers used
`truncate(brief, 1_500)` — a HEAD cut over a string that grows at the tail — so
on an original of 1,500 characters or more every follow-up was the first thing
dropped. AF5 fixed the direction and introduced the flat share; the shape it did
not cover is the *short* original, which is the ordinary one.

The three readers of `record.execution.brief`, and what each of them is:

```
   buildJudgePrompt   what the answer is CHECKED against   briefForCheck(·,1500)
   buildRepairPrompt  what the child is told to answer     the WHOLE brief
   buildAnchorMessage what is restated after a compaction  briefForCheck(·,1500)
```

`growBrief()` runs on **every** branch of `steer()` — the running branch, the
pending-steer branch, and the settled continuation — which is W3. Before that
only the settled branch grew it, so steering a running agent produced an answer
to the steer judged against the original, `NOT_ADDRESSED` correctly, and a repair
that told the child *"This is the task, in full, as it was given to you: <the
original>. Answer it now"* — the operator's instruction actively undone by the
layer that exists to catch drift, and labelled `✎ repaired`.

### 6.6 The switches, and where they are read

```
   SUBAGENT_VERIFY=0            off entirely
   SUBAGENT_VERIFY_ROUNDS       repairs allowed, clamped to [0, 3], default 1
   SUBAGENT_VERIFY_TIMEOUT_MS   per model call, clamped to [10s, 1h], default 5m
   SUBAGENT_VERIFY_LOG=0        write no JSONL
   SUBAGENT_VERIFY_LOG_FILE     where, default ~/.pi/agent/subagent-verify.jsonl
```

All three of the first three are read in `runVerification`, at the same instant,
when the child SETTLES. `SUBAGENT_VERIFY` used to be read in `buildVerifyDeps`,
which runs when the child STARTS — so of three switches over one feature, one was
captured minutes earlier than the other two, and an operator turning verification
off during a long delegation still got a verification.

An unreadable value falls back to the DEFAULT rather than to zero or to "no
timeout", for the same reason in both cases: a typo in `.env` must not silently
disable the thing, because the failure would look exactly like a verifier that
judged everything correct, or like the hang the deadline exists to prevent.

### 6.7 What it cannot do

The judge is the same 27B that wrote the answer. It catches **a different
question being answered**, **an empty or evasive summary**, and **a claim about
work that was plainly not done**. It does not catch subtly wrong work. It is a
drift check, not a correctness proof, and calling it verification in the stronger
sense would be a lie the parent would act on.

### 6.8 The log, and why it took twelve passes

`~/.pi/agent/subagent-verify.jsonl` — one line per model call the verifier makes,
carrying the prompt, the raw reply, **and the parse the stack acted on**. The
parse is the point: a reply and a verdict side by side is the only thing that can
show the parser was wrong, and neither alone can.

Bounded (4,000 chars a field, 2,000 lines newest-kept, pruned every fiftieth
write and only when the file is big enough to be worth reading), injected as
`deps.log` rather than imported, and swallowing on every path — because it runs
inside the one function whose entire contract is *never throw; an unverified
answer is worth more than no answer*.

**Nothing real has ever written to it.** It was created in the fifteenth pass and
the stack has not been run against a live model since. That is still the single
highest-value unrun thing in this repo: do a real verification and read one line.

---

## 7. `.pi/extensions/compaction-guard` — three bounds every session needs

309 lines plus three `src/` modules. No tools, no commands, three handlers, and
a failure mode by construction: **both hooks only ever ADD a bounded line or
SHRINK a string pi was about to send.** `session_before_compact` returns
`undefined` on every path, so this extension can never replace, cancel or
truncate a compaction.

```
   1  session_before_compact   BOUND THE ACCUMULATOR
        preparation.previousSummary is what pi feeds back into itself under a
        prompt saying "PRESERVE all existing information", so it is monotonic
        by construction — 456 / 4,029 / 11,054 chars at the low, median and
        high of 42 real compaction points.
        cap = 5% of the window (min 2,000, max 20,000 chars)
        capSummary() drops WHOLE SECTIONS by usefulness and reassembles them in
        their original order:
            ## Goal ▸ ## Next Steps ▸ ## Constraints ▸ ## Key Decisions ▸
            ## Critical Context ▸ ## Progress
        — `## Progress` last because its `### Done` list is the part that
          accumulates and the update prompt forbids removing from it. A blind
          slice() keeps `## Goal` and cuts exactly the two sections that carry
          the work forward, because they are last.
        IDEMPOTENT: anything within the cap is returned byte-for-byte, marker
        and all, and the marker is only stripped on a summary that genuinely
        has to shrink — so re-capping cannot quietly shorten it every pass.
        The mutation is IN PLACE on event.preparation, checked against pi 0.84.2
        rather than assumed: emit() passes the event by reference with no clone,
        and compact() then uses that same object. If a future pi clones it, the
        mutation stops having an effect and pi's behaviour returns.

   2  context                  SHOW THE MODEL ITS OWN BUDGET
        Measured over 259 real assistant turns:
            context <  87% of the window →  3 empty turns of 196   (1.5%)
            context >= 87% of the window → 33 empty turns of  63   (52%)
        An empty turn is `content: []`, stopReason "stop", one output token — a
        clean success as far as pi is concerned, and a wasted round trip.
        So the notice starts at 60%, while there is still room to act on it,
        and hardens at 80%. Appended LAST, so llama.cpp's cached prefix is
        untouched and only the notice is re-prefilled; and pi structuredClones
        the message array before this event, so it can never reach the session.
        ✋ if any message already carries a `-context-budget` customType, stand
           down — that is pi-loop-mode's own line. BOTH sides check.

   3  tool_result              BOUND ONE RESULT AGAINST WHAT IS LEFT
        Because the advisory does not bind. On 2026-08-17 the CRITICAL notice
        was in context at 84.5% — "do not run commands with large output this
        turn" — and the model ran a curl loop that returned 17,790 characters,
        taking the window to 100% and the run to an empty turn.
        That is not a threshold that needs tuning: the model could not have
        complied even in good faith, because nobody knows how many bytes a
        pipeline prints until it has printed them.
        allowance = clamp(remaining_tokens * 0.10 * 4, 1_500, 20_000)
          — a TENTH, not a fifth: at the moment that run broke, a fifth would
            have landed it at 88.5%, still above the cliff. A tenth lands it at
            86.8%, under it, with room to write a conclusion.
        head 70% / tail 30%, cut at line boundaries when one is close
        the overflow is written to a spill file the marker names, in a mkdtemp
        bounded at MAX_SPILL_FILES = 50 (a COUNT bound, not a shutdown sweep,
        because a child inherits this extension and shares the directory)
        ✋ image blocks are never capped — truncating one produces something
           that is not an image
        AND ERROR RESULTS ARE NOT EXEMPT  ← AF6, fifteenth pass
```

AF6 is worth restating because it is the most recently paid-for line in the
package. The cap used to begin `if (event.isError) return undefined;` under *"an
error is short and is the one thing worth reading in full"*. That is a claim
about pi's bash tool, and pi's bash tool says otherwise:

```js
  const { text: outputText, details } = formatOutput(snapshot);
  if (exitCode !== 0 && exitCode !== null) {
      throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
  }                                       dist/core/tools/bash.js:346-349
```

The throw carries the **whole** captured output — bash's own bound is 2,000
lines or 50 KB — and `executePreparedToolCall` turns it into
`createErrorToolResult(error.message)`, i.e. one text block with `isError: true`.
So the exemption covered up to ~12,500 tokens of a 32,768-token window, on the
single most common path an unattended `/loop` has: **running a test suite that is
still red.**

What is deliberately NOT ported from `pi-loop-mode`: the handoff. Replacing pi's
model summary with a locally-built one and cutting at the last turn is correct
FOR A LOOP, where the conversation is not the state — the goal is in `GOAL.md`,
progress in `PROGRESS.md`, and each iteration re-derives its bearings from the
working tree. In an ordinary session the conversation IS the state, and building
that summary from an inactive `LoopState` yields *"No saved loop goal / Iteration:
0 / No durable loop files were readable"* — 792 characters of form in place of
what the user asked for.

---

## 8. `vendor/prinny-channel` — a second human

1,972 lines in `extensions/index.ts`, ~2,000 in `src/`, ~2,000 in the sidecar.
Converted from a Claude Code plugin.

**What it is for.** Talk to a pi session, and through it the local model, from
any Matrix client. It is the only path in the stack with a second person on it,
and almost every decision in it follows from that.

### 8.1 The shape, and why the sidecar is a separate process

```
   Matrix  ⇄  sidecar (child process, MCP over stdio)  ⇄  extension  ⇄  pi
```

`@prinny/bot` pulls in matrix-js-sdk and its Rust crypto WASM: loading it is ~15
seconds of **synchronous** work, which in-process would freeze pi's TUI solid,
and the same library writes to stdout while it loads, which in-process would
scribble over the interface pi is drawing. Out of process, both are the child's
problem — its stdout is a pipe carrying newline-delimited JSON-RPC and its stderr
goes to a log file. It also keeps ~105 MB of `node_modules` out of the repository.

The MCP client is hand-rolled (402 lines) rather than the SDK, for the same
reason: a dependency here means a `node_modules` tree under `vendor/`, and the
subset actually used is four methods of a stable versioned protocol.

### 8.2 The room entry — what `awaitingReply` holds and why

```
   awaitingReply: Map<roomId, {
     messageId?      the Matrix event, for a quote-reply on the FIRST send only
     at              arrival time — the delivery sweep's clock
     answered        something has been SENT for this message, whatever it said
     live            PI HAS ACTUALLY TAKEN THIS MESSAGE AS INPUT
     injected        exactly what pi was handed — markLive matches the WHOLE
                     string, because an identifier can be written by a sender
                     into their own message body and there is nothing to forge
                     in reproducing the harness's own rendering of your own text
     emptyRetries    continuations spent on this message (max 2)
     question        what was actually asked, so a continuation survives a
                     compaction that ate the question
     undeliveredReported
   }>
```

`live` is the load-bearing one. Without it there is a real leak and a quiet one:
a Matrix message can arrive while pi is mid-turn on something the operator asked
for in the terminal — it is queued, correctly, as a follow-up — but the room went
into the map on arrival, so the *current* turn's answer, about the operator's
private local work, would be forwarded to whoever just messaged. Nobody would see
that happen from this side.

So eligibility is tied to **evidence**: the room is marked live when its own
injected text comes back as a `message_end{role:"user"}`, which is pi saying it
has consumed it. `mergeAwaiting` then enforces two rules, both about not throwing
evidence away:

- **`live` only ever goes up.** A second message from the same room cannot
  un-take the first. (Before AE3 a `/compact` from the same room replaced the
  entry belonging to the question the model was still working on, and the answer
  arrived at `agent_settled`, found no live room, and was dropped in silence.)
- **A message that was never pi's to take does not become the room's marker.** A
  locally-performed `/compact` produces no user message, so `markLive` could
  never fire for it, and overwriting `injected` would leave the matcher waiting
  for a string pi will never emit.

### 8.3 A leading slash from Matrix

`sendUserMessage` passes `expandPromptTemplates: false`, so a Matrix message
beginning with `/` has never executed anything — it reached the model as literal
text. `command-routing.ts` opens that door for a short **allow-list**, because
the failure modes are not symmetric: forgetting to allow something costs a
message saying "run that in the terminal", and forgetting to deny something hands
an allow-listed Matrix account the harness.

```
   KNOWN_COMMANDS   every command this stack registers, so a refused command can
                    be told from prose. "/usr/bin/foo is broken" is a sentence.
   MATRIX_LOCAL     compact   — performed by THIS extension, because pi's
                    prompt() dispatches EXTENSION commands only and /compact is
                    a pi BUILT-IN executed by the TUI's own input handler. It
                    used to be on the allow-list, be advertised in the client's
                    menu, and reach the model as the literal text "/compact".
   MATRIX_ALLOWED   stack, loop  — both in full, INCLUDING /loop start and run.
                    An earlier version refused those as "handing over the
                    machine", which does not survive inspection: an allow-listed
                    sender can already direct arbitrary work in prose.
   REFUSED_FLAGS    --model         changes the session model
                    --rescue-model  switches it at the third stuck turn — the
                                    --model guard could not catch it, because
                                    its pattern needs whitespace before the flag
                    --check         run as `pi.exec("bash", ["-lc", …])` once
                                    per iteration for the life of the run.
                                    pi.exec emits NO tool_call, so this
                                    extension's own permission relay never sees
                                    it, rtk's gate never sees it, and the
                                    output cap never sees it. The identical
                                    string sent as PROSE becomes a bash tool
                                    call and IS gated. One string, two doors.
   everything else  refused, with a sentence naming why
```

Only the FIRST LINE is a command candidate: a message whose second paragraph
starts with a slash is prose, and running it would be a surprise.

### 8.4 `agent_settled`, in order

This is where AG3 lives.

```
   agent_settled  (prinny is SECOND — pi-loop-mode has already run)
     ◆agentRunning = false
     stopTyping()
     continuationStarted = await forwardResult()
     ├─ forward:"result" && lastAssistantText → forwardToMatrix(...)
     ├─ lastRunEmptyEnding.empty?
     │    waiting = live rooms
     │    every one under MAX_EMPTY_RETRIES?
     │      ++emptyRetries on each · nudge = nudgeForEmptyEnding(reason, question)
     │      stand every waiting room DOWN (live=false, injected=nudge,
     │        at=now, undeliveredReported=false)                       ← AE4
     │      api.sendUserMessage(nudge, {deliverAs:'followUp'})         ← AG3
     │      retrying = true
     │    else → tell each room giveUpMessage(detail), answered = true
     ├─ !retrying:
     │    unanswered = live && !answered
     │      → tell each one unansweredMessage(ambiguous | nothing-to-send)
     │        answered = true                                          ← AF1
     │    retire every live room
     ├─ alreadySent.clear() · unattributableThisRun = false
     ├─ stopTyping()
     └─ sweepUndelivered()
     held = standAside(pendingCompaction, continuationStarted)         ← AE2
       wait  → keep the /compact for up to COMPACTION_DEFER_LIMIT settlements
       else  → drainPendingCompaction() → startCompaction(room)
                 ✋ compactionInFlight() → "already running"            ← §11.12
```

`standAside` is the fourteenth pass's repair for exactly the collision AG3 is the
other half of. AD3's argument for deferring a Matrix `/compact` to `agent_settled`
is one sentence — *"by then aborting costs nothing because the run is over"* —
and it is true of the run that just ended and false of the one the same handler
starts one line earlier. AE2 made the compaction stand aside for the
continuation. **Nothing makes the continuation stand aside for a compaction the
loop started on the same settlement**, and the loop runs first.

### 8.5 The two things prinny cannot observe, and what it does instead

```
   "the send succeeded"     sendUserMessage returns void; pi swallows the
                            rejection into an empty listener set. So the
                            evidence is the ABSENCE of markLive:
                            undeliveredRooms(entries, now, agentRunning)
                              ✋ agentRunning → report nothing at all
                              ✋ answered | live | already reported → skip
                              ✋ within DELIVERY_GRACE_MS (60 s) → skip
                            Idleness is the load-bearing half, not the clock: a
                            message delivered while pi is streaming is queued and
                            drains inside that same run, so waiting for idle
                            removes the whole class of "it was just busy" false
                            positives. The clock covers the one thing idleness
                            cannot: prompt() awaits _checkCompaction BEFORE it
                            starts a run.
                            It REPORTS rather than retries or retires — if pi
                            takes the message after all, markLive still fires and
                            the answer still reaches the room, so the worst case
                            of a wrong verdict is one extra sentence.

   "the command ran"        a dispatched extension command produces no user
                            message, and pi's own _tryExecuteExtensionCommand
                            wraps the handler in a try/catch that emits the
                            error and `return true`s — so a handler that THREW is
                            reported to prompt() as handled. There is no
                            observable. The receipt therefore says what THIS
                            EXTENSION did — "Handed `X` to the session" — which
                            it knows, instead of what pi did, which it does not.
```

### 8.6 The empty-turn continuation

`describeEmptyEnding` walks back from the end of the run and names the cause,
because an earlier version asserted one cause for all of them and was watched
being wrong two times in three:

```
   truncated           stopReason "length" — the backend hit the token cap
                       mid-output. Only distinguishable since the forge patch
                       stopped hardcoding finish_reason to "stop".
   error               stopReason "error" — a transport failure; it never got
                       to think.
   produced-no-answer  output > 1 token, no text and no toolCall. Measured at
                       43% of the window: it generated 126 tokens and none of
                       them were an answer. Nothing to do with room.
   context             ≥87% of the window. The documented cliff.
   unknown             everything else.
```

Two boundaries in that walk were each paid for:

- It steps over an injected `subagent-result` and the reasoning-only assistant
  message that pi runs in reply to it — otherwise a turn that had already
  answered read as `produced-no-answer` and the sender was told the model said
  nothing.
- It **stops at a `user` message**, because that is the sender's own question and
  anything above it belongs to an earlier exchange. `finalAssistantText` stops
  there too, and the pair have to agree: when they disagreed, one said "there is
  an answer" and the other returned `""`, and the room was retired with no
  answer, no continuation and no notice.

### 8.7 The rest of the surface, briefly

```
   forward: off | result | all   how much of the answer goes to Matrix by itself
        "all" forwards each assistant MESSAGE as it finishes, so a long task
        shows progress instead of going quiet for two minutes; awaited, because
        pi runs message handlers in order and racing sends would reorder
        somebody's conversation.
        ▲ the ALLOWLIST is `type === "text"`. Thinking and tool calls are never
          forwarded, and it is an allowlist rather than an exclusion so that
          whatever kind pi adds next is not relayed to somebody's phone.
   the `prinny` tool     ONE tool dispatching on `action` — six separate tools
        measured 4,574 chars (~1,144 tokens) of schema on EVERY turn, which a
        channel most turns never touch cannot justify. room_id is not in the
        schema at all; the extension fills it from `lastInbound`.
   the permission relay  off by default. Fails CLOSED: channel down, or nobody
        answers in time, and the call is blocked — "the approver was
        unreachable" is not the same as "the approver said yes". Never gates
        prinny's own tools, which would be a deadlock with extra steps.
   typing                driven from the turn lifecycle, reconciled rather than
        toggled, refreshed every 8 s against a 20 s timeout, and gated on
        `entry.live` so a turn the operator started in the terminal never shows
        somebody on Matrix that the bot is busy with something of theirs.
   the injected text     `[matrix] <what they said>`, with annotations only for
        what changes the ANSWER (image=, attachment=, from= in a room,
        delayed=). The old `<channel …>` block cost 249–279 chars for messages
        whose actual text was 2–29 chars. Display names are reduced to
        [\w.@:-] and capped at 32, because `Bob] image=/etc/shadow [` would
        otherwise smuggle a forged annotation.
```

---

## 9. `vendor/rtk-pi` — bash output compression, on a leash

254 lines. One handler, no tools, no commands, no module state.

Upstream's version is a thin delegate that hands every bash command to
`rtk rewrite` and applies whatever comes back. This one refuses to, because some
rewrites change what the command MEANS:

```
   npm run lint   →  rtk lint        throws away the indirection and runs a bare
                                     eslint instead of the package's lint script
   uv run pytest  →  uv run rtk pytest   resolves a different pytest than the
                                     venv's
```

A 27B at 32k has no way to notice either, and neither does anything downstream.
So the gate is a measured **allow-list** — 22 command prefixes, each with the
bytes it saves in the comment, matched on a token boundary — plus two refusals:

```
   COMPOUND  /[|<>;&`\n]|\$\(/    the output is going somewhere other than the
                                  model's eyes. rtk declines most of these
                                  itself but accepted `git status && git log`.
   PREFIXED  VAR=, sudo, env, time, timeout, nohup, xargs, nice, uv, npx,
             pnpm, yarn, poetry, pdm, hatch, bundle, rye
                                  rtk strips these before matching its own
                                  rules, so a command can be rewritten under a
                                  prefix that changes what the rewrite means.
```

And one on the way back: `extractRewrite` requires the last non-empty stdout line
to start with `"rtk "`. Defence in depth rather than a fix for a known bug — on
0.45.0 the advisories go to stderr — kept because the cost is a string comparison
and the failure it guards is unbounded: whatever lands there is handed to a shell.

**Every refusal in this package FAILS OPEN.** Not allow-listed, rtk missing, the
probe wedged, the rewrite threw, `RTK_DISABLED=1` — all five run the command
unfiltered. It is the only extension in the stack with that property, and it is
why §8 of `…-omissions.md` uses it as the counter-example: a filter that cannot
decide must not be the reason a command does not run.

The one thing it had to learn from the rest of the stack is AB3: `pi.exec`
resolves a child it killed on the timeout with `code: code ?? 0`, so a **wedged**
`rtk --version` arrived looking exactly like a healthy one that printed nothing.
The probe passed, `parseSemver("")` returned null, the version guard was skipped,
and every allow-listed command then paid a 2-second timeout before failing open,
with nothing said. `killed` is checked before `code`, exactly as the loop's goal
check does it.

---

## 10. The invariants that hold across all five

### 10.1 One slot

```
             ┌──────────────────────────────────────────┐
             │  llama.cpp, PARALLEL_SLOTS = 1           │
             └───────────────────┬──────────────────────┘
                                 │  ONE QUEUE
   ┌──────────┬──────────┬───────┴───────┬──────────┬───────────┐
   the        a child's  the judge's     a repair   a Matrix    a compaction
   parent's   turn       turn                       answer      summary
   turn
```

Every one of these design decisions is that queue:

- the concurrency default of 1, and `continueSettledAgent` refusing rather than
  queuing;
- the verifier's structural gate — *not worth a model call* is a statement about
  the queue;
- `DEFAULT_VERIFY_ROUNDS = 1`, because a round is two calls;
- `__verifier`'s five declarations (no tools, no extensions, no skills, no
  context files, no environment block) — the environment block alone costs two
  git subprocesses, ~100 ms on this box's 9p mount;
- the judge going around `spawn()` so it cannot deadlock on the slot;
- folding six prinny tools into one, and dropping fourteen `<channel>`
  attributes;
- denying the `loop` tool to a child, worth ~177 tokens/turn of its window;
- the whole of `compaction-guard`.

### 10.2 Module-global state, and the two globals on `globalThis`

A subagent's session is created **in the parent's process** and binds the
parent's extensions, which through node's module cache is *the same module
object*. Every extension in the stack keeps state at module scope, so every one
of them is exposed to this, and each has a different answer:

```
   pi-subagents-lite   isInsideSubagentSpawn() — its own counter, and the
                       factory returns early
   pi-loop-mode        bornInsideSubagentSpawn() — reads the counter
                       pi-subagents PUBLISHES, because vendor packages must not
                       import each other
   .pi/extensions/stack.ts   the same read, in its own factory
   prinny-channel      never loaded in a child at all (path denial)
   compaction-guard    deliberately shared — spillDir is one directory for
                       parent and child, which is why the bound is a COUNT and
                       not a teardown sweep
   rtk-pi              no module state; a second instance is genuinely
                       independent
```

Two keys live on `globalThis`, and both exist for the same reason — a fact two
packages need and neither may own:

```
   __PI_SUBAGENT_SPAWN_DEPTH__   "a subagent session is being BUILT right now".
       Published by pi-subagents-lite's shell.ts, read by pi-loop-mode and
       stack.ts. Covers the build, not the run: it used to wrap the whole of
       runAgentImpl, so an operator /reload during a background delegation made
       pi-subagents' own factory return early.

   __PI_COMPACTION_IN_FLIGHT__   { owner, at } | undefined.  The fifteenth
       pass's lock. TWO implementations of one protocol —
       pi-loop-mode/src/compaction-lock.ts and
       prinny-channel/src/compaction-lock.ts — asserted to agree by a test in
       each package that reads the other's source.
         beginCompaction(owner)   false when somebody else holds it;
                                  re-entrant for the SAME owner
         endCompaction(owner)     releases, and only if this owner holds it
         compactionInFlight()     the holder, or undefined
       STALE_MS = 300_000, because a latched lock is worse than the collision it
       prevents: the loop would stand aside for a compaction that is not
       happening, forever.
```

**Four places could read that lock. Two do.**

```
                                        reads compactionInFlight()?
   pi-loop-mode  requestEmergencyCompaction        ✓   adopts, does not retry
   pi-loop-mode  interveneStuck's compaction rung  ✓   spends the rung, waits
   pi-loop-mode  sendLoopTurn / scheduleLoopTurn   ✘   ← AG2
   prinny        startCompaction                   ✓   tells the sender
   prinny        forwardResult's continuation      ✘   ← AG3
```

> **Corrected by the seventeenth pass (AH1).** This table is not four places, it
> is five, and the fifth was in a third package: `pi-subagents-lite`'s
> `SpawnCoordinator.emitIndividualNudge`, which delivers a finished BACKGROUND
> subagent's answer through the same `sendCustomMessage` → `_runAgentPrompt`
> branch AG2 is about. The residue this pass recorded below — *"there is no test
> that a fifth would be noticed … it will produce another one the next time a
> sender is ADDED"* — was right about the risk and wrong about the tense: the
> fifth sender was already in the tree, and it is the only one of the three with
> no second attempt. There are now THREE implementations of the protocol, the
> third read-only, and §10.5 of `…-instances.md` is the graph. Corrected in
> place, and stated rather than silently redrawn.

### 10.3 A refusal is half a decision

The fifteenth pass's ledger counted forty-five places this stack declines to act
and found six that dropped what they were holding. All six are fixed. The habit
that came out of it is worth restating because this pass is its direct
continuation: **at every `return` inside a guard, ask what you were holding when
you decided not to, and who has it now.**

### 10.4 Testability is a design constraint here

Nine modules exist only because their parent file imports pi and therefore cannot
be loaded by `node --experimental-strip-types --test`:

```
   turn-tracking.ts      the turn ceiling            (from agent-runner.ts)
   run-answer.ts         what a run SAID             (from agent-runner.ts)
   record-activity.ts    is this record busy         (from three call sites)
   status-listing.ts     which agents AgentStatus prints  (from agent-status.ts)
   concurrency-slots.ts  the slot arithmetic         (from agent-manager.ts)
   action-report.ts      what the operator is told   (from two TUI files)
   nudge-drop.ts         what a dropped result says  (from spawn-coordinator.ts)
   compaction-anchor.ts  may the anchor be steered   (from agent-manager.ts)
   declared-resources.ts which declaration governs   (from agent-runner.ts)
   plus, in prinny:  delivery.ts · forwarding.ts · command-routing.ts ·
                     compaction-request.ts · continuation.ts · typing.ts ·
                     permission-gate.ts · inbound.ts
   and in the loop:  goal-check.ts · context-recovery.ts · repetition.ts ·
                     loop-state.ts · context-budget.ts · arguments.ts ·
                     compaction-lock.ts
```

Each of them imports nothing and duck-types its input. This is not tidiness: the
defect that prompted every one of those extractions was invisible precisely
because the code could not be run. **AG5 and AG6 are both in modules created by
that discipline** — which is the discipline working, in the sense that the
sentence is now in a place where a test could reach it, and the test that would
have caught it was not written.

---

## 11. The findings

**All six are fixed.** Every one carries a regression test that fails when the
fix is removed — the *control run* below is that measurement — and a probe that
prints BEFORE and NOW, so the probe is its own control: run it and the left
column is the defect, the right column is the tree as it stands.

Every probe drives the **shipped** modules; two of the five load both real
extensions into one process through pi's own bundled jiti, in
`scripts/pi-local.sh`'s order, exactly as node's module cache puts them there in
a real session.

### 11.1 AG1 — half the judge's budget, reserved and then not spent · MEDIUM · FIXED

**Where.** `vendor/pi-subagents-lite/src/agents/verify.ts:451`, `briefForCheck`.

**What.** `appendFollowUp` gives the accumulated follow-ups **everything the
original does not use**: `budget = MAX_BRIEF_CHARS - original.length`.
`briefForCheck` — whose docstring says *"The split is the one `appendFollowUp`
already owns, so the two cannot drift"* — gives them a flat
`floor(max * FOLLOW_UP_CHECK_SHARE)` and **returns the remainder unspent**. On a
short original that throws away follow-ups the budget had ample room for.

```
   t3, the shipped verify.ts, JUDGE_BRIEF_CHARS = 1,500:

     a one-line brief (71 chars), steered four times, 400 chars each
       brief                       1,711 chars
       briefForCheck returned        481 chars   ← 1,019 of the budget unused
       follow-ups the judge sees       1 of 4
       with the share as a FLOOR       3 of 4, on a 1,429-char budget

     the AF5 shape — a 1,400-char original, three 200-char steers
       follow-ups the judge sees       3 of 3      ← the control: they agree

     the boundary, as the original grows (four 400-char steers):
        original   kept   would keep
              50      1       3   ←
             200      1       3   ←
             400      1       2   ←
             700      1       1
           1,400      1       1
```

**Why it matters.** The two readers are `buildJudgePrompt` — what the answer is
CHECKED against — and `buildAnchorMessage` — what is restated into a context that
was just compacted. A judge shown a quarter of the task says `NOT_ADDRESSED`,
correctly, about the question it was given. That spends a repair round and a
re-judge on the one llama slot the parent is queued behind; `buildRepairPrompt`
restates the brief in FULL, so the child answers the same thing again; and
`verifyAnswer` ends at `stalled`, handing the parent the answer it already had
under *"Treat it as unreliable"*. **That chain is AF5's own docstring, for the
shape AF5 did not cover.**

**Why it was not caught.** Every AF5 test uses `LONG_ORIGINAL` (>1,500 chars) —
the one shape where a flat half and the remainder happen to agree — except one,
which uses a 15-character original with a single 5,000-character steer, where the
share binds for a different reason.

**The fix.** The share is a FLOOR — the least the follow-ups may have — not a
ceiling, which is the same subtraction `appendFollowUp` already uses:

```ts
  const followUpBudget = Math.max(0, Math.floor(max * FOLLOW_UP_CHECK_SHARE), max - original.length);
```

```
   the one-line brief, steered four times:
                                   BEFORE      NOW
     chars of a 1,500 budget       481       1,301
     follow-ups the judge sees     1 of 4      3 of 4
     follow-up budget              750       1,429
   the AF5 shape (a 1,400-char original) is unchanged in every column.
```

**Control run:** `tests/verify.test.ts`, the AG1 block — six assertions over the
short-original shape and the two controls. **4 fail** when the `Math.max` is
removed. All seven AF5 assertions still pass with the fix in, which is the other
half of the check: the new rule cannot have moved the old one.

**Reproduction.** `node --experimental-strip-types
context/testing/probes/t3-the-half-of-the-task-the-judge-is-shown.mjs`

---

### 11.2 AG2 — the loop turn that does not have to ask · MEDIUM · FIXED

**Where.** `vendor/pi-loop-mode/extensions/index.ts:625` `sendLoopTurn` and
`:650` `scheduleLoopTurn`; pi `agent-session.js:807` and `:1090`.

**What.** pi has one refusal for "you cannot prompt during a compaction", and it
is on `prompt()`. The loop delivers **every** turn it drives through
`pi.sendMessage(…, {triggerTurn: true})` — which is `sendCustomMessage`, whose
`triggerTurn` branch calls `_runAgentPrompt` directly. `_runAgentPrompt` does not
check. So a loop turn on a delay timer starts an agent run inside somebody else's
compaction, and pi's `compact()` ends with
`this.agent.state.messages = sessionContext.messages`.

```
   t2, both shipped extensions in one process, in pi-local.sh's order:

     pi's two entry points, pinned from source:
       prompt()             refuses while _compactionAbortController is set  ✓
       sendCustomMessage    triggerTurn → await this._runAgentPrompt(...)    ✓
                            …and makes no compaction check of its own        ✓
       _runAgentPrompt      makes none either                                ✓
       compact()            ends by REPLACING agent.state.messages           ✓

     the run:
       an ordinary productive loop turn → next iteration scheduled, --delay 1
       agent_settled → the session is idle between iterations
       a Matrix /compact arrives → planCompaction says "now" → ctx.compact()
       …the delay timer fires

       loop turns sent while the compaction was in flight : 1
         kind=continue  route=_runAgentPrompt — A RUN STARTS  duringCompaction=true

       compactionInFlight() at the moment of the send : "prinny-channel"
```

**Why it matters.** Two model calls to a one-slot server, the summariser and the
loop turn, queued behind each other; the loop turn is built from the
pre-compaction context, which is the thing that was too big; and when the
compaction finishes it replaces the array the run is streaming into. The failure
is not loud — pi will not throw and the operator is told nothing — which is
exactly the shape this series keeps finding.

**How reachable.** Any window in which the session is idle and a compaction is
running: a Matrix `/compact` between iterations (`--delay N`), pi's own threshold
compaction after `_handlePostAgentRun`, or the loop's own adoption branch —
`requestEmergencyCompaction` sees a holder and calls
`finishContextRecovery(..., resumeTurn = true)`, which schedules a `recover` turn
with **delay 0**, into the compaction it has just decided not to duplicate.

**The fix.** `sendLoopTurn` — the single funnel every loop turn goes through —
reads the flag this package already reads twice, and **reschedules rather than
drops**:

```ts
  const holder = compactionInFlight();
  if (holder) {
    if (!waitingForCompaction) { …log it, and tell the operator once… }
    scheduleLoopTurn(pi, kind, COMPACTION_WAIT_MS, ctx);   // 5 s
    return;
  }
  waitingForCompaction = false;
```

The wait cannot become a stall: `compaction-lock.ts` reads a holder older than
`STALE_MS` (five minutes) as absent, which is the same bound the loop's own two
compaction call sites already rely on. `scheduleLoopTurn`'s timer now carries the
ctx as `opts.noticeCtx` — for the NOTICE only, never for the delivery, because a
captured ctx may be stale and `followUp + triggerTurn` is the safe choice either
way — so the `--delay N` path, which is the ordinary one, can still say what it
is doing.

```
                                                       BEFORE   NOW
     loop turns delivered into a running compaction :   1        0
     what the operator was told                     :   nothing  once, naming
                                                                 the holder
     once the lock is released                      :   —        the same
                                                                 iteration goes
```

**Control run:** `tests/turn-into-a-compaction.test.ts` — five tests, driving the
shipped module with a stubbed `setTimeout` so the wait is fired deterministically
rather than slept through. **3 fail** when the guard is removed.

This covers only compactions an extension asked for; pi's own threshold and
overflow compactions mark nothing, which is the residue §11.12 of
`…-omissions.md` already records.

**Reproduction.** `node
context/testing/probes/t2-the-turn-that-does-not-have-to-ask.mjs`

---

### 11.3 AG3 — the continuation and the compaction already running · MEDIUM · FIXED

**Where.** `vendor/prinny-channel/extensions/index.ts:990`, inside
`forwardResult`.

**What.** The same moment as AG2, from the other extension, and this one has a
sibling twelve lines away that gets it right. `agent_settled` fires the loop's
handler first — which may call `requestEmergencyCompaction` — and prinny's
second, which may send an empty-turn **continuation** into the session pi is now
compacting. `startCompaction` reads `compactionInFlight()` before it acts. This
sender does not.

```
   t1, both shipped extensions in one process:

     pi's three facts, pinned from source:
       compact() aborts, then takes _compactionAbortController               ✓
       prompt() refuses while that controller is set                         ✓
       pi swallows the rejection into emitError                              ✓

     the run:
       Alice asks a question; pi echoes it; markLive fires
       the run ends EMPTY at 95% of a 32k window
       agent_end  → the loop routes it to context recovery                   ✓
       agent_settled:
         ctx.compact() calls          : 1   (pi-loop-mode's emergency recovery)
         continuation nudges sent     : 1
         …that pi would have TAKEN    : 0   ← THE FINDING
         the sender was told          : nothing, at this point

       compactionInFlight() at the moment of the send : "pi-loop-mode"
```

**Why the two conditions are correlated rather than independent.** They are the
same event seen twice. The loop's starvation rung fires on `stopReason "stop"`
with no answer at ≥80% of the window; `describeEmptyEnding` names `context` at
≥87%. **One empty turn on a saturated context produces both**, which is the
ordinary way a 32k run goes wrong, and it is the case a Matrix sender is most
likely to be waiting through.

**What actually happens next.** AE4's stand-down means the room is left
not-live, not-answered and stamped `at = now`, so `sweepUndelivered` reports it
60 seconds later with a sentence that is, by luck, exactly right: *"I could not
hand that to the session — it would not accept a new message just then (it may
have been compacting…)"*. So the sender is not left in silence. What is lost is
the **answer** the continuation exists to produce, one of the two retries is
spent on a send that never happened, the sender waits a minute to be told to ask
again, and the extension guesses "it may have been compacting" when it knew.

**The fix.** `forwardResult` asks before it sends, spends no retry on a send it
knows will be refused, and hands the room to AF1's own retirement notice with a
third reason:

```ts
  const compactionHolder = waiting.length > 0 ? compactionInFlight() : undefined;
  if (compactionHolder) { heldForCompaction = true; …log, notify… }
  if (waiting.length > 0 && !heldForCompaction) { …the existing continuation… }
  …
  const reason: UnansweredReason = unattributableThisRun ? "ambiguous"
    : heldForCompaction ? "compacting" : "nothing-to-send";
```

`heldForCompaction` is deliberately NOT `retrying`: that one is returned as
`continuationStarted` and decides whether a waiting `/compact` stands aside
(AE2), and nothing started here.

The room is **retired with a sentence** rather than left live, and that is the
load-bearing half. An entry that is live and unanswered is invisible to
`undeliveredRooms`, so leaving it would have traded a wasted retry for silence.
The new `unansweredMessage("compacting")` says the true reason *now* — "the
session was already compacting its context, so I could not ask it again just
then" — where the sweep's sentence a minute later can only hedge ("it *may* have
been compacting"), because the sweep has no observable and this branch has the
lock in hand.

```
   t1, both shipped extensions in one process:
                                                 BEFORE    NOW
     continuation nudges sent                  :  1         0
     …that pi would have TAKEN                 :  0         0
     retries charged to the sender's message   :  1         0
     what the sender was told, and when        :  nothing;  immediately, and
                                                  the sweep the true reason
                                                  60 s later,
                                                  guessing
```

**Control run:** `tests/delivery.test.ts`, the AG3 block — five tests over the
wiring and the sentence. **3 fail** when the guard, the reason and the lock read
are removed together; **1** when only the guard is.

**Reproduction.** `node
context/testing/probes/t1-the-nudge-and-the-compaction-already-running.mjs`

---

### 11.4 AG4 — the map draws three handlers that are not there · MEDIUM · FIXED

**Where.** §1.D of `…-omissions.md`, `…-claims.md`, `…-controls.md`,
`…-deliveries.md` and `…-signals.md`.

**What.**

```
   t5, the table diffed against the source:

     package   event                 document   source
     subag     agent_start           ✓          —
     subag     message_end           ✓          —
     subag     agent_end             ✓          —
     subag     tool_call             —          ✓   events.ts:227
     subag     turn_start            (no row)   ✓   events.ts:229
```

`vendor/pi-subagents-lite` registers exactly four handlers, all in
`src/events.ts`: `tool_call`, `turn_start`, `session_start`, `session_shutdown`.
Nothing else in the package calls `pi.on`.

**Why it matters more than a typo.** That table is the artefact every ordering
argument in this series is read off. Four findings across three passes turn on
one of its rows: AD6 is *"the `tool_call` row is the only place a shell command
can be reviewed"* — a row this table does not even show `pi-subagents-lite` on,
while §1.E of the same document draws `toolCallListener` in the `tool_call` box.
Worse, the same document's §1.C table says "4 handlers" for that column while
§1.D marks five, none of them the four that exist: **the two tables in one
document disagree, and the correct one is the summary.**

It has been carried since the eleventh pass. `session_shutdown` was corrected for
that column somewhere between the twelfth and the fourteenth, which is evidence
the table has been edited without being re-derived.

**The fix.** All five tables are corrected in place, each with a note under it
saying what it drew, when, and where the standing check lives. The note rather
than a silent edit, because this directory's convention is that the log records
what was believed and why — and "the map was wrong for five passes" is a fact a
future reader needs more than a clean table.

`t5-the-event-bus-the-map-draws.mjs` is the standing check: it re-derives the
table from every `.ts` in the five packages and diffs it against the table in a
document given as an argument, defaulting to this one. All six documents now
pass it.

**Control run:** the probe itself. It reported five differences per document
before the edit and none after, and it is the assertion — there is no unit test,
because the artefact under test is prose.

One thing it had to learn first, and it is this pass's own lesson pointed at the
tooling: **a scan for wiring must not read the prose about the wiring.** The
first draft reported a `tool_result` handler in `pi-subagents-lite` that does not
exist, because `src/spawn/result-cap.ts`'s header comment contains the literal
string `pi.on("tool_result")` while the module registers nothing at all. Every
module in this stack quotes its own wiring at length, which is a virtue
everywhere except in a tool that greps for wiring. The probe strips comments
first and says so where it does it.

---

### 11.5 AG5 — "still busy" is the one thing a refused stop cannot mean · LOW · FIXED

**Where.** `vendor/pi-subagents-lite/src/ui/action-report.ts:113`.

**What.** `bulkReport`'s partial line is shared by both verbs:

```
   Cleared 6/7 : "Cleared 6 of 7 agent(s); 1 were still busy and were left alone."
   Stopped 2/3 : "Stopped 2 of 3 agent(s); 1 were still busy and were left alone."

   …and the same module's sentence for the identical refusal, one at a time:
     stop  : "1a2b3c4d was already finished — nothing to stop."
     clear : "1a2b3c4d is still running — stop it first."
```

`AgentManager.stopAgent()` has exactly one reachable `return false`:

```ts
  } else if (record.lifecycle.status !== "running") {
    return false;
  }
```

reached only when the record is not queued, not running, and not verifying — i.e.
when it has **finished**. (The verifying case is intercepted above it and returns
`true`.) So a refused *stop* means the opposite of what the sentence says, and an
operator told *"1 was still busy and was left alone"* goes looking for a busy
agent that does not exist.

For `clear` the sentence is correct — `clear()` refuses exactly a running or
verifying record — which is why it reads naturally and why nobody noticed it was
doing double duty. AF2 introduced this module three days ago; the bulk path is
the one call site whose two verbs have opposite refusal causes.

Two smaller things in the same line: the count is not pluralised (*"1 were still
busy"*), and `tests/action-report.test.ts` exercises the partial case for
`Cleared` and never for `Stopped`.

**The fix.** One sentence per verb, agreeing with the two the module already had
for the single-agent case, and a pluralised count:

```
   BEFORE   Stopped 2 of 3 agent(s); 1 were still busy and were left alone.
            Cleared 6 of 7 agent(s); 1 were still busy and were left alone.
   NOW      Stopped 2 of 3 agent(s); 1 had already finished.
            Cleared 6 of 7 agent(s); 1 was still busy and was left alone.
            Cleared 5 of 7 agent(s); 2 were still busy and were left alone.
```

**Control run:** `tests/action-report.test.ts`, the AG5 block — five tests,
including one that reads `stopAgent`'s source and asserts it still has exactly
one reachable `return false`, because *that* is the claim the sentence rests on
and the thing that would silently stop being true. **2 fail** when the split is
removed.

**Reproduction.** `node --experimental-strip-types
context/testing/probes/t4-the-two-sentences-and-what-they-name.mjs`

---

### 11.6 AG6 — the recovery that names the one surface that cannot do it · LOW · FIXED

**Where.** `vendor/pi-subagents-lite/src/spawn/nudge-drop.ts:80` and
`src/spawn/spawn-coordinator.ts:371`.

**What.** Four notices about a background subagent result that was not delivered,
and all four end the same way:

```
   session-replaced  "…result NOT delivered to the model — the session was
                      replaced before the result could be delivered.
                      Read it with AgentStatus."
   no-runtime        "…there is no live extension runtime to deliver it
                      through. Read it with AgentStatus."
   record-gone       "…its record was removed before the result could be
                      delivered (cleared from /agents?). Read it with
                      AgentStatus."
   the AC1 catch     "…result NOT delivered to the model (<reason>) — read it
                      with AgentStatus"
```

and `executeAgentStatusTool` prints, per agent:

```ts
  return `${shortId} (${record.display.type}) ${listedStatus(record)}`;
```

The id, the type, the status. Not the result, not the error, not the output file
— and the whole module never touches `record.result`. The surface that **can**
show it is `/agents` → the agent → **"View result"**
(`menu-running-agents.ts:217`, `:252`).

For `record-gone` the sentence is self-refuting: the record was removed from
`this.agents`, and `AgentStatus` lists exactly that map, so neither surface can
show it and the notice recommends one anyway.

`nudge-drop.ts`'s own header already knows — *"the answer is still on the record,
and `AgentStatus` (or `/agents`) will show it"* — and the sentence it ships
carries the half that does not work.

**Which of the four is reachable.** The `catch` is: AC1 established it by
shipping a `ReferenceError` through it for two passes. `record-gone` is reachable
by clearing an agent from `/agents` inside the 200 ms nudge batch window. The
other two are defensive — `dispose()` clears the nudge timer, and `shell.pi` is
never unset — but they are the notices an operator would be reading at exactly
the moment they most need the sentence to be true.

**The fix.** Name the surface that works, say the honest thing when neither does,
and export the sentence so the coordinator's own `catch` — the reachable drop —
uses it rather than a fourth copy:

```
   BEFORE  all four   …Read it with AgentStatus.
   NOW     recoverable …Open /agents, select it, and choose "View result" to read it.
           record-gone …The answer is gone with it.
```

**Control run:** `tests/nudge-drop.test.ts`, the AG6 block — six tests, of which
three read source rather than output: that `AgentStatus` still never touches
`record.result`, that `/agents` still has the `View result` action, and that the
coordinator uses the shared constant. **6 fail** when the recovery reverts.

**Reproduction.** the same probe as AG5,
`t4-the-two-sentences-and-what-they-name.mjs`.

---

## 12. The evidence, and how to run it

### 12.1 What was measured

The gates were run **before** anything was written, so the *before* column is a
measurement of the tree as this pass found it rather than a claim about it.

```
                                                    before     after
     vendor/pi-loop-mode         npm test             218        223   lint ok
     vendor/pi-subagents-lite    npm test             329        346   lint 91/91
     vendor/prinny-channel       npm test             377        382   lint ok
     .pi/extensions/compaction-guard                   47         47   lint ok
     vendor/rtk-pi               node --test           20         20
                                                    ─────      ─────
                                                      991      1,018   0 failures
     probes                                             67         72   0 failures
       g1–g3 · verify-prior-fixes · h1–h6 · i1–i9 · j1–j8 · k1–k6 ·
       l1–l6 · m1–m4 · n1–n4 · o1–o4 · p1–p4 · q1–q4 · r1–r3 · s1–s5 · t1–t5
```

### 12.1.1 What each fix cost, and what it is pinned by

```
   #    file(s) changed                            test                  control
   AG1  pi-subagents-lite/src/agents/verify.ts     verify.test.ts        4 fail
   AG2  pi-loop-mode/extensions/index.ts           turn-into-a-           3 fail
                                                   compaction.test.ts
   AG3  prinny-channel/extensions/index.ts         delivery.test.ts      3 fail
        prinny-channel/src/delivery.ts
   AG4  the §1.D table in five documents           t5, as a standing     5 rows
                                                   check                 per doc
   AG5  pi-subagents-lite/src/ui/action-report.ts  action-report.test.ts 2 fail
   AG6  pi-subagents-lite/src/spawn/nudge-drop.ts  nudge-drop.test.ts    6 fail
        pi-subagents-lite/src/spawn/spawn-coordinator.ts
```

A *control run* is the fix removed and the suite re-run: it is the measurement
that the test is pinned to the behaviour rather than to the diff, which is the
twelfth pass's rule (`…-deliveries.md` §14).

### 12.2 The five new probes

Each one prints BEFORE and NOW side by side, so it is its own control: run it and
the left column is the defect, the right column is the tree as it stands.

```
   t1-the-nudge-and-the-compaction-already-running.mjs      AG3
        Both shipped extensions in one process through pi's jiti, in
        scripts/pi-local.sh's order, fired the way ExtensionRunner fires them.
        Pins three facts out of pi's own source first, then drives one
        saturated empty turn with a live Matrix room. BEFORE: one nudge, zero
        that pi would have taken, one retry charged, nothing said to the
        sender. NOW: no nudge, no retry, and the room told on that settlement.
        node t1-the-nudge-and-the-compaction-already-running.mjs

   t2-the-turn-that-does-not-have-to-ask.mjs                AG2
        The same harness, the other collision. Pins pi's two entry points and
        the message-array replacement out of source, then drives a --delay 1
        loop, a Matrix /compact into the idle gap, and the delay timer firing.
        BEFORE: one turn delivered duringCompaction=true, nothing said. NOW:
        none, one notice naming the holder — and the last block releases the
        lock and shows the SAME iteration going, because it defers, never drops.
        node t2-the-turn-that-does-not-have-to-ask.mjs

   t3-the-half-of-the-task-the-judge-is-shown.mjs           AG1
        The shipped verify.ts with the old ceiling modelled beside it. A
        one-line brief steered four times: 481 chars and 1 follow-up of 4
        BEFORE, 1,301 and 3 of 4 NOW. The AF5 shape is the control and is
        unchanged in every column. Then the boundary as the original grows.
        node --experimental-strip-types t3-the-half-of-the-task-the-judge-is-shown.mjs

   t4-the-two-sentences-and-what-they-name.mjs              AG5, AG6
        The shipped action-report.ts and nudge-drop.ts, BEFORE and NOW, next
        to the source of the thing each sentence names: stopAgent's only
        `return false`, AgentStatus's per-agent line, /agents' View result
        action, and the coordinator's catch, which now shares the sentence.
        node --experimental-strip-types t4-the-two-sentences-and-what-they-name.mjs

   t5-the-event-bus-the-map-draws.mjs                       AG4
        A STANDING CHECK rather than a reproduction: derives the event-bus
        table from every .ts in the five packages (with comments stripped —
        result-cap.ts's header contains the literal string
        `pi.on("tool_result")` and registers nothing) and diffs it against the
        table in a document given as an argument. Defaults to this one, and
        all six documents now pass it — before the correction each of the five
        older ones reported the same five differences.
        node t5-the-event-bus-the-map-draws.mjs
        node t5-the-event-bus-the-map-draws.mjs \
             ../../design/subagents-loop-verifier-omissions.md
```

### 12.3 Re-running everything

```bash
cd ~/qwen3.8-forge
for d in vendor/pi-loop-mode vendor/pi-subagents-lite vendor/prinny-channel \
         .pi/extensions/compaction-guard; do (cd $d && npm test && npm run lint); done
(cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts)

cd context/testing/probes
for p in *.mjs; do case "$p" in _*) continue;; esac
  timeout 180 node --experimental-strip-types "$p" >/dev/null 2>&1 \
    && echo "ok   $p" || echo "FAIL $p"; done
```

**Check the test COUNT, not only the failure count.** A whole test FILE can bail
under memory pressure, which `node --test` reports as one failure and a silently
lower total. The five numbers in §12.1 are the ones to compare against — and this
pass hit exactly that: a stray newline inside a regex literal made
`action-report.test.ts` unparseable, which `node --test` reported as **one**
failure while the total quietly fell by thirteen.

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
   §11.2  a channel-down apology cannot arrive. There is no third route to a
        Matrix room, and answering hours later without knowing whether it still
        matters is worse.
   §11.3  a room-less inbound message falls through to the model as text.
        Defensive; the sidecar always sets room_id.
   §11.4  the /agents spawn wizard is the one spawn path that can hold no
        concurrency slot. Unreachable, stated because "no slot" means "no
        serialisation" and that is what default:1 exists to guarantee.
   §11.5  `continue` still drops when a message is pending. The line AF3 draws.
   §11.6  `answered` is set by the act of replying, not by evidence it arrived.
        There is no observable; the claim was narrowed instead of guarded.
   §11.7  a SIGTERM from outside on a goal check runs bash's EXIT trap, so the
        marker proves COMPLETION, not INTENT.
   §11.8  the watchdog skips a verifying record and deletes its state. The
        per-call deadline is minutes where the watchdog is 45 of them.
   §11.9  a --check is a shell channel no tool_call handler can see, from the
        tool and the terminal. Closed from Matrix (AD6).
   §11.10 agentRunning is false for the width of one await chain.
   §11.11 parseJudgeVerdict reads UNADDRESSED as ADDRESSED on the VERDICT: line.
        Recorded in the twelfth, thirteenth and fourteenth passes.
        ▲ CLOSED by the seventeenth pass (AH2). The fix is not the `\b` the
          thirteenth pass weighed and correctly rejected — that one really would
          break `VERDICT: _ADDRESSED_` — but a widening of the NEGATIVE
          alternation, which touches nothing on the positive side.
   §11.12 pi's OWN threshold and overflow compactions mark nothing, so no
        extension can stand aside for them. The extension-requested half is
        closed by the lock.
   plus  the Matrix command sweep's blind spot, the brief-before-session window,
        hasStateChange's keyword list, T6, per-session loop state, T1's general
        case, and resuming a completed run.
```

### 13.2 This pass's

AG1–AG6 are fixed; §11 has the change, the numbers and the control run for each.
Nothing is left open from this pass.

One residue worth stating, because it is a *bound* rather than a defect and the
next person to touch either lock reader should know it: **the compaction lock can
only be read for compactions an extension asked for.** pi's own threshold and
overflow compactions mark nothing, so AG2's deferral and AG3's hold do not see
them, and neither does §11.12's mutual exclusion. That is the same residue the
fifteenth pass recorded when it built the lock, unchanged and still correct —
marking pi's own compactions would need a hook pi does not have.

### 13.3 Still unwatched — none of this has been run against a live model

**This is the whole of what is left, and it has been true for thirteen passes.**
Everything in sixteen documents is verified against probes, tests and pi's own
source, and none of it against a 27B actually answering. The list, cheapest
first:

```
   1  §U   Esc on a loop turn, then type a question.
           ONE KEYPRESS and one sentence. No subagent, no verifier, no Matrix
           account. It is AE1 end to end and it is still the cheapest run on the
           list.
   2  §X   Two rooms, one turn. Message the bot from two rooms a few seconds
           apart while it is busy. Both must hear something. (AF1)
   3  §Y   A /loop against a genuinely failing suite, with the model running the
           suite itself. `Compaction guard: capped bash output N -> M` should
           appear once per iteration; before AF6 it never did.
   4  §Z   Type something while the goal check is running. `--check "sleep 20;
           false"` makes AF3's window twenty seconds wide.
   5  §B/§P One background delegation, and the only question is whether the
           result appears in the conversation at all. Do it headless too.
   6  §M/§M.2/§M.3  three /loop starts with different --checks. Six findings
           across five passes sit on that path.
   7  §R   A real verification, foreground, SUBAGENT_VERIFY_ROUNDS=1, a
           deliberately off-task brief — and now with a STEER in it, which is
           AF5 and AG1.
   8  READ ONE LINE OF ~/.pi/agent/subagent-verify.jsonl written by a real
           judge. The log has existed since the fifteenth pass and nothing real
           has ever written to it, which is the whole point of having it. Do 7,
           then read it. If parseJudgeVerdict is wrong about anything, that file
           is where it becomes visible for the first time.
   9  §I, §J, §K/§K.2, §L, §N, §O — never run.
```

**And now a tenth, which this pass adds — §AA of the hand-testing script.**
`§AA.1` is AG2 and needs no Matrix account and no saturated context: start a
`/loop --delay 20`, type `/compact` in the gap between iterations, and watch the
next iteration WAIT rather than start. It belongs at position 2 on this list by
cost. `§AA.2` is AG3, needs Matrix and a context above 87%, and is the one that
costs an answer rather than a turn.

---

## 14. The pattern across sixteen passes

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
```

Three things transfer out of this one.

**The thing you named is a file you can open.** Five of the six findings here are
a pointer that was never followed. `briefForCheck` says it applies
`appendFollowUp`'s split — one screen away, and it does not. `sendLoopTurn` and
`forwardResult` are two of the four callers of a lock the same two packages
wrote three days ago, and they are the two that do not read it. A drop notice
names `AgentStatus`, whose whole implementation is fifty lines. The map draws
three handlers for a package whose four handlers are in one file. **The cost of
checking, in every case, was one file open — and the reason none of them was
opened is that the sentence sounded true.**

**A fix has a shape, and the shape has more than one instance.** AG1 is AF5 at
the other end of the same distribution; AG5 is AF2's own module with one call
site that has two refusal causes instead of one; AG3 is AE2's rule with the two
parties swapped. This is the seventh pass's lesson (W1–W6, *the rule was
established and applied to the instance in front of it*) recurring, and it keeps
recurring because a fix is written while looking at a failure, and the failure is
one shape. **When a fix lands, write down what shape it was, then go and find the
other instances of that shape before writing the test.** AF5's tests are seven
assertions about one shape; the eighth would have caught AG1.

**A reserve is not a cap, and a share is not a budget.** AG1's `floor(max * 0.5)`
is a *floor* in intent — "the follow-ups must not be crowded out entirely" — and
a *ceiling* in code, with no second pass to spend what the other party left. The
sibling function got it right by expressing the same intent as a subtraction
rather than a fraction. **When you reserve room for something, say what happens
to the room nobody used.**

---

## 15. Where to look

- **This document** — §1 is the whole machine; §2 is pi, and is the thing most
  worth reading before changing anything; §3 is the corrected event bus; §4–§9
  are the five packages; §11 is the findings.
- `context/design/subagents-loop-verifier-omissions.md` — the fifteenth pass
  (AF1–AF6). Its **§2 is the refusal ledger**: every place this stack declines to
  act, what it was holding, and who owns that afterwards. That artefact is not
  restated here and is the best single thing to read next.
- `…-claims.md` (fourteenth, AE1–AE7, and its §2 claim ledger) ·
  `…-controls.md` (thirteenth, AD1–AD7) · `…-deliveries.md` (twelfth, AC1–AC5) ·
  `…-signals.md` (eleventh, AB1–AB4) · `…-hosts.md` (tenth, AA1–AA4) ·
  `…-answers.md` (ninth, Z1–Z4) · `…-turns.md` (eighth, X1–X5, Y1) ·
  `…-readers.md` (seventh, W1–W6) · `…-shapes.md` (sixth, V1–V8) ·
  `…-units.md` (fifth, U1–U9, whose §9 reference sections no later document
  restates) · `…-surfaces.md` (fourth, S1–S10) · `…-mechanics.md` (third,
  T1–T9, still the best account of pi's own agent loop) · `…-evaluation.md`
  (second, F1–F11) · `…-anatomy.md` (first, and the design rationale).
- `context/testing/subagents-loop-verifier.md` — the hand-testing script. §13.3
  above is its index in cheapest-first order.
- `context/testing/probes/README.md` — what each of the seventy-two probes
  prints. Read its last five paragraphs before trusting or writing one.
- The four `FORK.md` files — `vendor/pi-loop-mode`, `vendor/pi-subagents-lite`,
  `vendor/prinny-channel`, `vendor/rtk-pi`. `.pi/extensions/compaction-guard`
  has none; §7 above and its own header comments are its only account.
- pi's own source, for this pass:
  `core/agent-session.js:792` (`prompt`, and the compaction refusal at `:807`),
  `:1068` (`sendCustomMessage`, and `_runAgentPrompt` at `:1090`),
  `:744` (`_runAgentPrompt`, which checks nothing),
  `:1367` (`compact`, and the message-array replacement),
  `:1911` (the `ctx.compact` wrapper and its callback guarantee),
  `core/extensions/runner.js:579` (`emit` — load order, sequential, awaited),
  `:649` (`emitToolResult` — one object, fields merged),
  `pi-agent-core/dist/agent-loop.js:43` (`runAgentLoop`, and the inner/outer
  while at `:76`/`:160`).
