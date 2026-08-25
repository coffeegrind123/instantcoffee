# Subagents, the loop, and the verifier — the second instance

Seventeenth pass, 2026-08-19. A full read of the whole stack — pi's own agent
loop, `vendor/pi-loop-mode`, `vendor/pi-subagents-lite` and the answer verifier
inside it, `.pi/extensions/compaction-guard`, `vendor/prinny-channel` and
`vendor/rtk-pi` — written to be **self-contained**. §1 to §9 are a complete
account of the machine and do not assume any of the sixteen documents before
this one.

The sixteenth pass asked what the stack *names*, and its closing lesson was:

> **The thing you named is a file you can open.**

It also left a question in its own handoff, and this pass is that question
answered:

> **`compactionInFlight()` now has four readers, and there is no test that a
> fifth would be noticed** … "who else should be asking this" is exactly the
> question that produced AG2 and AG3, and it will produce another one the next
> time a sender is added.

There was no next time. **The fifth reader already existed**, in the third
package, on the one delivery path in this stack that gets no second attempt. And
once that question was asked of the other rules this stack has paid for, it
answered five more times.

> **THE AXIS: a rule that is right is applied where it was found. Name every
> other place it belongs — from the code that COULD need it, not from the code
> that already asks.**

Six findings. Every one of them is a rule that exists, is correct, is documented
at length, has a test behind it — and is applied to fewer places than need it.
Four of the six are in a file whose own header names the rule.

```
   AH1  `SpawnCoordinator.emitIndividualNudge` delivers a finished BACKGROUND
        subagent's answer with `pi.sendMessage(…, {triggerTurn:true})`, which is
        `sendCustomMessage`, whose `triggerTurn` branch is `_runAgentPrompt` and
        checks nothing. It is the THIRD sender through that branch and the last
        one that did not read the compaction lock — and the only one with
        nothing to fall back on: it runs once per record, on a record that has
        already settled, its slot released and its gate open. The loop defers and
        prinny holds; this one spent the answer.        MEDIUM · FIXED

   AH2  `parseJudgeVerdict` read `VERDICT: UNADDRESSED` as ADDRESSED — with
        `unparsed: false`, so the answer went back to the parent model as
        `passed`, with no note at all. Recorded and left open in the twelfth,
        thirteenth and fourteenth passes on a rationale that names one fix (a
        `\b`), correctly rejects it, and never asks whether it is the only fix —
        and that names a policy (fail-open) which does not reach this case.
                                                        MEDIUM · FIXED

   AH3  `killed` before `code`. `pi.exec` never rejects and resolves a child it
        killed on the timeout with `code: code ?? 0`, so a wedged command reads
        as a success returning nothing. That property has produced AA2, AB3 and
        `git-failure.ts`, whose header says it is "AA2 one package over" — and
        three further `pi.exec` sites in that same package still tested `code`
        first, one of them under a docstring naming the validator's strategy.
                                                        LOW/MEDIUM · FIXED

   AH4  `result-cap.ts` imports `compaction-guard`'s output-cap CONSTANTS on
        purpose, under the heading "Why it imports the guard rather than
        carrying its own numbers" — and had copied the guard's spill WRITER
        without its `MAX_SPILL_FILES` prune. Of the two spill directories in one
        process, the one whose docstring names the unattended `/loop` was
        bounded and the one an unattended run's background delegations fill was
        not.                                            LOW · FIXED

   AH5  `verificationNote("failed", 0)` — the verifier's only channel to the
        parent model — said "no attempt was made to correct it" and "kept
        because the corrections were no better" in one sentence. W5 made
        `describeAttempts` count-aware; the clause after it was not.
                                                        LOW · FIXED

   AH6  AG2's own deferral, on the one path that cannot afford it. A directive
        held back for somebody else's compaction was rescheduled through the
        loop's ONE `pendingTimer` slot — and `agent_end` clears that slot at its
        first line. `deliverLoopTurn` takes that path precisely when a turn is
        already coming, which guarantees the `agent_end` that clears it. So the
        deferral did not delay the directive; it deleted it, after the ladder had
        charged for it and told the operator it had been sent.
                                                        MEDIUM · FIXED
```

**All six are fixed**, each with a regression test that fails when the fix is
removed, and each probe written afterwards to print BEFORE and NOW so the probe
is its own control. §11 has the change and the control-run failing count for
each.

```
                                    before    after
   vendor/pi-loop-mode      tests     223       227
   vendor/pi-subagents-lite tests     346       365    lint 95/95 files
   vendor/prinny-channel    tests     382       382    lint clean
   .pi/extensions/compaction-guard     47        47
   vendor/rtk-pi            tests      20        20
                                     ─────     ─────
                                    1,018     1,041
   probes                              72        77
```

The gates were re-run **before** anything was written, so the *before* column is
a measurement of the tree as this pass found it rather than a claim about it.

---

## 0. How to read this, and what it is for

This document is written for somebody who has never seen the stack. It is long
because the machine is: five extensions, two entry points, one llama slot, three
nested units of a turn, and about 26,000 lines of source with a comment density
closer to a design document than to code.

The order is deliberate:

- **§1** is the whole machine in one drawing. Everything after it is a zoom into
  a part of that drawing, and every section says which part.
- **§2** is pi itself — the substrate the five extensions are bolted to. Read it
  even if you know pi: two of this pass's six findings and most of the previous
  sixteen passes' turn on details of it that are not documented anywhere else.
- **§3** is the event bus: who handles what, in what order, and which four of
  those orderings decide behaviour.
- **§4**–**§9** are the five packages, one at a time, in full.
- **§10** is the handful of invariants that hold across all of them, and **§10.5
  is this pass's own artefact — the second-instance graph**: every rule this
  stack has paid for, where it was written, and every other place it belongs.
- **§11** is the findings, each with its reproduction.
- **§12**–**§15** are the evidence, what is open, the pattern across seventeen
  passes, and where to look next.

Three conventions carried from the earlier documents and worth knowing:

- A **✋** marks a place the stack deliberately declines to act. There are
  forty-five of them; §2 of `…-omissions.md` is the full ledger and this
  document does not restate it.
- A **◆** marks module-global state — a variable shared by every session in the
  process, which on this stack includes a subagent's session, because a child
  binds the parent's extensions through node's module cache. That fact is
  responsible for more findings in this series than any other single property of
  the machine.
- A **✔** / **✘** in §10.5 marks whether a rule's instance reads the rule.

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
  │          THREE SENDERS reach this. All three now ask first (§10.5).        │
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
    │              This is why one run can owe TWO Matrix rooms.  [AF1]
    │     emit agent_end { messages: newMessages }
    │            ▲ pi-loop-mode counts THIS as one "iteration"
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
   │                     waitingForCompaction · deferredDirective  ← AH6      │
   │      pi-subagents   shell{pi,sessionCtx,manager,widget,store,coordinator}│
   │                     coordinator.heldForCompaction             ← AH1      │
   │      prinny         child · awaitingReply · typingRooms · deliveryTimer  │
   │                     pendingCompaction · agentRunning · lastAssistantText │
   │      compaction-gd  spillDir (a mkdtemp, first use, bounded at 50 files) │
   │      result-cap     spillDir (its own mkdtemp, NOW bounded too) ← AH4    │
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
   │  git probes: killed    │    │                                               │
   │  before code  ← AH3    │    │                                               │
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
   │              parseJudgeVerdict: NEGATIVE first, and NEGATIVE means           │
   │              NOT_ADDRESSED *or* UNADDRESSED            ← AH2                 │
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
   │        ▼               │    │           — all three REPORT (§11.1, 15th)   │
   │  formatResultContent   │    │        ✋ compactionInFlight() → HOLD, and   │
   │        │               │    │           re-ask in 5 s          ← AH1       │
   │        ▼               │    │        capBackgroundResult(ctx, …)           │
   │  the Agent TOOL RESULT │    │           spill file, bounded at 50 ← AH4    │
   │  → the guard's cap     │    │        pi.sendMessage({subagent-result},     │
   │  → THE PARENT MODEL    │    │                       followUp, trigger)     │
   └────────────────────────┘    │             │                                │
                                 │             ▼                                │
                                 │  ENTRY POINT 2, and a `void` return          │
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
        standAside(pendingCompaction, continuationStarted) ◀──────┘
        drainPendingCompaction() → startCompaction()
              ✋ compactionInFlight() → "already running"
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, a Matrix answer, a compaction summary and the parent's next call are
six things in one queue. Almost every design decision in the five packages is a
consequence — the concurrency default of 1, the verifier's round budget, the
structural gate that refuses to spend a model call on a run that was cut off, the
denial of the `loop` tool to children, the tool-schema folding in `prinny`.

The second constraint, and the one this pass is about, is written into the
drawing three times: **`__PI_COMPACTION_IN_FLIGHT__` appears in box A, box D and
box E**, because a compaction is the one event in this machine that three
different packages have to know about and none of them owns.

---

## 2. The substrate: what pi does, and the parts of it that matter

Everything in §4–§9 is an extension bolted to the object described here. Two of
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

Seven of the sixteen previous passes have a finding that reduces to one row of
this table. AA1 is the `before_agent_start` row. AA3 is the
`hasPendingMessages()` row. AA4 is the `deliverAs` row. Z4 is the
`_pendingNextTurnMessages` row. AB2/AC1/AE4 are the `void` row.

**The compaction row is the one this pass finishes.** AG2 (the loop) and AG3
(prinny) were its first two instances. AH1 is the third and last: there are
exactly three senders in this stack that reach `sendCustomMessage`'s
`triggerTurn` branch, and until this pass one of them still did not ask.

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
send, so it watches for the absence of the success instead. And it is why AH1
matters more than its blast radius suggests: a nudge refused by pi is refused
into that same silence, and nothing in `pi-subagents-lite` sweeps.

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
   that arrive while pi is busy are both answered inside one `agent_end` — which
   is how one run comes to owe two rooms an answer it cannot attribute (AF1).
4. **`agent_end` is not one event per prompt.** `_handlePostAgentRun()` restarts
   the loop for a retry, a compaction or a queued message, and each restart ends
   in another `agent_end`. **AH6 is that fact meeting `clearPendingTimer()`**:
   the loop's `agent_end` handler drops its one pending timer at its first line,
   and the very situation in which the loop defers a directive — a message is
   pending — is the situation that guarantees a second `agent_end` milliseconds
   later.

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

AG2, AG3 and AH1 all live here, so this is the sequence in full:

```
   AgentSession.compact(customInstructions)                          :1367
     await this.abort()                    ← abort(), then waitForIdle().
                                              THE SESSION IS IDLE FROM HERE.
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

**Three consequences, and the third is new in this pass.**

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
  `agent.steer()` nor `agent.followUp()` can be taken. That is why all three
  senders had to be fixed rather than two.

### 2.5 What a run started inside a compaction actually costs

This was argued in the sixteenth pass and is *measured out of the source* here,
because AH1's severity depends on it and "the messages are thrown away" turned
out to be only half true.

```
   Agent.prompt(input)                              pi-agent-core/agent.js:226
     runPromptMessages(messages)
       runAgentLoop(messages, this.createContextSnapshot(), …)
                    ▲                createContextSnapshot():
                    │                  { messages: this._state.messages.slice() }
                    │                                       ▲ A COPY.        :283
   runAgentLoop(prompts, context, …)                 agent-loop.js:43
     currentContext = { ...context, messages: [...context.messages, ...prompts] }
                                                ▲ ANOTHER COPY.
   processEvents(message_end)                       agent.js:390
     this._state.messages.push(event.message)   ← pushes onto WHATEVER array
                                                  `_state.messages` currently IS
```

So, precisely:

```
   the run's PROVIDER REQUESTS are built from a snapshot taken at its first
     instant — the PRE-compaction context, i.e. the oversized one the compaction
     exists to shrink. The compaction finishing does not change it. On a 32k
     window at 95% that is the exact condition that produces the empty turn.
   the run's MESSAGES are persisted incrementally at each message_end
     (`appendCustomMessageEntry` / `appendMessage`, agent-session.js:372/:378),
     and `buildContextEntries` keeps everything at or after `firstKeptEntryId`,
     so they DO survive into the rebuilt array. The transcript is not lost.
   two MODEL CALLS are in flight on a one-slot server, one of them the summariser
     the other is waiting behind.
   a whole agent_start … agent_end … agent_settled cycle runs INSIDE the
     compaction window, re-entering every handler in the stack — including the
     loop's iteration ladder and prinny's forwardResult.
```

The last line is the one that makes this a class rather than an inefficiency.
`agent_settled` is where the loop asks for an emergency compaction and where
prinny drains a deferred `/compact`; running that cycle *inside* a compaction is
the re-entrancy the whole design assumes cannot happen.

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
  are separate methods with their own merge rules. `emitToolResult` threads one
  shallow copy through every handler and merges `content` / `details` / `isError`
  / `usage` from each return, so the second handler sees the first's edit —
  which is exactly how `compaction-guard` caps a result the loop has already
  fingerprinted.

### 2.7 `pi.exec`, and the two facts it cannot tell you

This is the host function behind AA2, AB3, `git-failure.ts` and **AH3**, so it
gets its own section.

```js
  //  ExtensionAPI.exec  =  execCommand   (core/exec.js, via loader.js:287)
  return new Promise((resolve) => { … })      ← NO `reject` IN THE BODY
  …
  resolve({ code: code ?? 0, stdout, stderr, killed })
```

Two things follow, both measured against the real function rather than assumed:

```
   1  it NEVER rejects. A timeout kills the child and resolves; a spawn error is
      caught and resolves `code: 1`; a non-zero exit resolves. So a `catch`
      around it is unreachable, and for two passes `checkErrorStreak` never
      advanced. (AA2)

   2  a SIGNALLED child exits with a signal and NO code, and `code ?? 0` turns
      that into a ZERO. Measured:

        bash -lc 'exit 1'                 → { code: 1,   killed: false }
        git rev-parse … in /              → { code: 128, killed: false }
        a binary not on PATH              → { code: 1,   killed: false }
        bash -lc 'sleep 5'  (timeout 400) → { code: 0,   killed: TRUE  }
                                              ▲ the shape of a SUCCESS that
                                                printed nothing

   and `killed` is only pi's OWN kill: `killProcess()` has exactly two callers,
   the timeout timer and the caller's AbortSignal. An OOM kill, an operator's
   `pkill` or a container going down all come back { code: 0, killed: false }.
   (AB1 — open by decision, and unfixable from inside.)
```

**So `killed` is read before `code`, everywhere, or a wedged command reads as a
success returning the empty string.** That is the rule AH3 is the enumeration of.

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
passes it, and so do the six before it.

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
                  SECOND (it may continue an empty run, then compact). Both
                  halves are closed by the shared lock.                      ✔
```

**And a fifth thing that is not an ordering at all**, which is what this pass
adds: the background nudge is on a 200 ms `setTimeout`, not on the bus. It is
not ordered against `agent_settled`, against a compaction, or against anything
else. A handler ordering can be reasoned about; a timer can only be asked. That
is why AH1 could not have been found by reading the table above, and it is the
reason §10.5 enumerates *senders* rather than *handlers*.

A note that has survived five passes and still holds: **the `tool_call` row is
the only place a shell command can be reviewed.** `pi.exec` — which the loop's
goal check, rtk's version probe, the subagent git probes and `/stack` all use —
is `execCommand` directly and emits nothing on this bus. That is why `--check` is
refused from Matrix (AD6): one string, two doors, and only one of them is
watched.

---

## 4. `vendor/pi-loop-mode` — the unattended run

3,252 lines in `extensions/index.ts` plus seven modules under `src/`. A fork of
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
        ▲ AH6 lives on this line. It drops the loop's ONE timer slot, which is
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

Six of those exits carry a DIRECTIVE — `improve`, `unblock`, `check_failed`,
`regression`, `audit` and `stuck` — and go through `deliverLoopTurn()` /
`interveneStuck()`, which send the text onto the turn that is already coming when
a message is pending rather than dropping it. `continue` deliberately still
drops: any turn advances an endless loop, and injecting 1,200 characters of loop
rules onto a turn the operator typed for their own reasons is the other kind of
mistake. That asymmetry is AF3, and §11.5 of `…-omissions.md` is the decision.

**The six directive kinds are now a named set** — `DIRECTIVE_KINDS` — because
AH6 needed to distinguish "text the ladder has already been charged for" from "a
turn that merely has to happen". §11.6 is the account.

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
and §10.5 has the other four.

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

### 4.9 The two module-globals that are about waiting, not about the run

New in this pass, and worth stating together because both are cleared by
`resetContextRecovery()` and neither is run state:

```
   waitingForCompaction   AG2. Set on the first deferral, so the operator is
                          told ONCE rather than every five seconds.
   deferredDirective      AH6. The KIND whose text the ladder has already been
                          charged for and which has not been said yet. The next
                          turn the loop sends carries it; a fresher directive
                          supersedes it; a `continue` never becomes one.
```

Both are cleared by every lifecycle transition that drops a recovery marker —
start, resume, stop, session swap, shutdown — because a directive belongs to the
run it was decided for.

---

## 5. `vendor/pi-subagents-lite` — delegation

16,592 lines across `src/`, of which about half is UI. A fork of upstream
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
          terminal transition. It is never the run's own promise, so a run that
          rejects cannot leave a caller hanging.
    options.signal?.aborted ─▶ stopAgent(record,"user"); return id
    options.signal          ─▶ bind abort → this.abort(id,"user")
    queued ─▶ return id
    startAgent(id, record, args, slot)
        slots.reserve(record)   ◆ record.execution.holdsSlot = true
        status "running", started = true, watchdog.start(id)
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
        ▲ the bracket covers the BUILD, not the run.
    runTurnLoop:
      ✋ signal.aborted ─▶ throw ABORTED_BEFORE_START                   [AB4]
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
  seven readers of "is this record busy" all ask the same question. Four
  findings (Y1, T5, AD2, AE5) are one reader that did not.
- **The slot is held right through the verification window**, which is wider
  than `status === "running"`. `holdsSlot` is the authority, and
  `SlotTable.recount()` re-derives every count from the holders on any config
  change.

### 5.2 The background nudge, which is the one path with no second attempt

This is the path AH1 is about, and it is worth drawing on its own because it is
the only delivery in the stack that is neither a tool result nor a handler.

```
   .finally  tallyCompletion(record)
       └─▶ onComplete(record)                    wired at session_start
             └─▶ SpawnCoordinator.onAgentComplete(record)
                   backgroundAgentIds.delete(id) || settlementCount >= 2
                     └─▶ scheduleNudge(id)
                           pendingNudges.add(id)
                           if (nudgeTimer) return          ← BATCHED, 200 ms
                           nudgeTimer = setTimeout(drain, NUDGE_DELAY_MS)
                                        ▲ A TIMER. Not an event. Not ordered
                                          against anything.
   drain ─▶ for (id of batch) emitIndividualNudge(id)

   emitIndividualNudge(id)
     record = manager.getRecord(id)
     ✋ this.disposed          → reportDrop("session-replaced")     ── DROPPED
     ✋ !getPiInstance()       → reportDrop("no-runtime")           ── DROPPED
     ✋ !record                → reportDrop("record-gone")          ── DROPPED
     ✋ compactionInFlight()   → describeNudgeHold(holder)          ── HELD  ← AH1
                                 scheduleNudgeIn(id, 5 s); return
     heldForCompaction.delete(id)
     capBackgroundResult(formatResultContent(record), ctx, type, id)
       ▲ sized against ctx.getContextUsage(), which during a compaction still
         reports the PRE-compaction window — which is the second reason the
         lock is read ABOVE this line rather than below it
     pi.sendMessage({customType:"subagent-result", …},
                    {deliverAs:"followUp", triggerTurn:true})
       ▲ ENTRY POINT 2.  void return.  ONE ATTEMPT.
```

The three DROPPED guards are each correct — there is genuinely nothing to send
through, or nothing to send — and each says so out loud since the fifteenth pass
(§11.1 of `…-omissions.md`). The HELD one is different in kind and says so
differently: the answer is intact, the record is intact, and the notice reads
*"result held — pi-loop-mode is compacting; it will be delivered when that
finishes"* rather than *"result NOT delivered"*.

**Why this sender defers where prinny's holds and reports.** prinny's
continuation is one of two attempts at getting an answer out of a run that ended
empty, and a sender is waiting who can be told to ask again. Here there is
nobody to ask: the child is gone, the slot is released, the gate is open and the
record's `result` is the only copy of the answer. So the only correct behaviour
is to keep trying, bounded by the lock's own five-minute staleness.

### 5.3 The three surfaces an operator or a model acts through

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

**`AgentStatus` prints `id (type) status` and nothing else.** It is a "what is
still happening" tool, not a "what did it say" tool, and it is bounded
(`MAX_SETTLED_LISTED = 6` settled records plus every unfinished one, with the
elided count stated). AG6 is that four drop notices used to name it as the way to
read an answer; they now name `/agents` → **View result**, which is the surface
that can.

### 5.4 The concurrency slot, and why the default is 1

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
   2,949 ms.
```

Three consequences worth holding on to:

- `continueSettledAgent` **refuses rather than queues** when the slot is full.
- The judge goes around `spawn()` entirely and calls `runAgent` directly,
  because the child's slot is only released in the `.finally` that follows the
  verification — a judge that asked for a slot would wait for a slot that is
  waiting for the judge. At a limit of 1 that is a deadlock, not a slowdown.
- Going around `spawn()` means going around every teardown `spawn()` arranges,
  so the judge's session is disposed in its own `finally`, from a handle
  captured in `onSessionCreated` rather than read off the result.

### 5.5 What a child inherits, and what it must not

```
   route A — DISCOVERY.  ~/.pi/agent/extensions/** and <cwd>/.pi/extensions/**
             when the project is trusted. Everything in this repo's own
             .pi/extensions/ reaches a subagent FOR FREE.
   route B — additionalExtensionPaths, i.e. subagentExtraExtensionPaths().
             Everything under vendor/ is invisible to a child unless named.

   kept:     compaction-guard  (route A) — measured capping a CHILD's own read
                                result at 9,778 → 8,176 chars.
             browser-guard     (route A) — registers no tools
             rtk-pi            (route B, deliberately put back)
   denied:   prinny-channel    — by PATH, not by name, because
                                extractExtensionName() derives "index" for all
                                three vendor packages. Unconditional, and the
                                denial also filters SUBAGENT_EXTRA_EXTENSIONS.
             prinny-access, prinny-configure  (skills)
   inert:    pi-loop-mode      — its own factory guard, plus removal from route B
             .pi/extensions/stack.ts — guards ITSELF, with the same global
```

`tests/subagent-denylist.test.ts` carries the standing rule: **every entry point
under `.pi/extensions/` that registers a model-visible tool must guard itself.**
That is a *standing scan*, and this pass adds a second one of the same shape —
`tests/exec-verdicts.test.ts` (§11.3) — for the same reason: the next instance
will be written by somebody reading a neighbour.

### 5.6 The turn ceiling, and the one-turn exception

A subagent always has a ceiling, even when nothing set one — `DEFAULT_MAX_TURNS
= 40`. Upstream leaves it undefined, which means unbounded, and that is not
defensible here: `AgentSession.prompt()` defaults `expandPromptTemplates` to
true and this fork calls it bare, so a prompt beginning `/loop …` starts a real
loop *inside the child*.

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

   Both of the verifier's model calls run with maxTurns: 1. Measured: a judge
   that replied `VERDICT: NOT_ADDRESSED` had that verdict replaced by "I have
   already given my final answer above", which parseJudgeVerdict reads as
   unreadable and therefore — by the fail-open policy — as a PASS.
```

So the wrap-up steer is skipped at a budget of one turn, and `turnLimited`
follows the *steer* rather than the ceiling.

### 5.7 What a run actually said

`collectResponseText` keeps one entry per MESSAGE and returns the last non-empty
one, with the finalized messages as a fallback. Both halves were paid for:

- Keeping one string reset on every `message_start` returned the last MESSAGE of
  the run, not its ANSWER — and `message_start` fires for injected user messages
  too, of which this package injects two. Measured: a child that answered and
  was then compacted handed its parent *"Understood — nothing further to add."*
- The fallback used to index into `session.messages` from a position captured
  before the prompt. pi does not splice that array on a compaction, it
  **replaces** it with a shorter one, so after a compaction the index pointed
  past the end and the fallback returned `""`.

### 5.8 The git probes, and the rule they now all read

Five `pi.exec` call sites, all of them `git`, and all five decide something:

```
   worktree-validator  getGitCommonDir       is the TARGET in a repo at all
   worktree-validator  getGitCommonDir       is the PARENT in the same repo
                                             (→ the cross-repo trust gate)
   worktree-validator  rev-parse --show-toplevel   the worktree root label
   agent-runner        execGit               the CHILD's environment block:
                                             isGitRepo, and the branch
   menu-spawn-wizard   worktree list         what the operator is offered
   menu-spawn-wizard   rev-parse --git-common-dir  whether a typed path is a repo
```

All five now classify the result through `git-failure.ts`, which reads `killed`
before `code` for the reason in §2.7. Three of them did not, until this pass;
§11.3 is the account and `tests/exec-verdicts.test.ts` is the standing scan that
keeps it true.

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
nothing else in the pipeline notices.

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
  │    aborted | turn_limited | stopped → skip:"cutoff"                         │
  │    otherwise       → worthJudging:true                                      │
  │  and one more in the runner: no brief → skipped-nobrief                     │
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

### 6.4 Reading the judge — and the two paths that had different rules

The judge is the same 27B that wrote the answer, and a small local model echoing
its own instructions is one of the most common reply shapes there is. Five
findings in this series (S2, U4, V5, W5, **AH2**) are each a statement about a
string that existed for a few milliseconds inside `verifyAnswer`.

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
        the NEGATIVE is tested FIRST, because both spellings of "no" CONTAIN
           the token for "yes", and the wrong order turns every failure into a
           silent pass
             NEGATIVE_VERDICT       /(?:NOT[_\s-]?|UN)ADDRESSED/i    unanchored
        the WHY is read from BELOW the deciding line, then from the last usable
        line — an echo puts its WHY before the verdict, a real answer after it
     2. only if no line decided: a bare token anywhere, with the menu removed
             NEGATIVE_VERDICT_PROSE /\b(?:NOT[_\s-]|UN)ADDRESSED\b/i  anchored
     3. otherwise unparsed → ADDRESSED, with the flag kept
        Fail-open on purpose: a judge that answered in a shape nobody asked for
        is evidence about the JUDGE, not about the answer.
```

**The two paths having different anchoring is deliberate and is the whole of
AH2.** The prose pass is anchored, so `\bADDRESSED\b` cannot match inside
`unaddressed` in a sentence. The VERDICT-line pass is NOT anchored, because the
value arrives with its markdown attached — `** ADDRESSED`, `_ADDRESSED_` — and
`_` is a word character, so anchoring it would stop reading an italicised
verdict, which is a shape S2 was widened to accept.

That difference was correct on the positive side and left a hole on the negative
one: `UNADDRESSED` has no "NOT", so the old negative test missed it, and the
unanchored positive test matched it as a substring. `VERDICT: UNADDRESSED` came
back `addressed: true, unparsed: false` — **a false PASS, reported as a check
that succeeded.** §11.2 is the account; probe `u1` is the table.

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
     budget = max(floor(1_500 * 0.5), 1_500 - original.length)
                                 ▲ a FLOOR, not a ceiling  (AG1, sixteenth pass)
```

The three readers of `record.execution.brief`, and what each of them is:

```
   buildJudgePrompt   what the answer is CHECKED against   briefForCheck(·,1500)
   buildRepairPrompt  what the child is told to answer     the WHOLE brief
   buildAnchorMessage what is restated after a compaction  briefForCheck(·,1500)
```

`growBrief()` runs on **every** branch of `steer()` — the running branch, the
pending-steer branch, and the settled continuation — which is W3.

### 6.6 The switches, and where they are read

```
   SUBAGENT_VERIFY=0            off entirely
   SUBAGENT_VERIFY_ROUNDS       repairs allowed, clamped to [0, 3], default 1
   SUBAGENT_VERIFY_TIMEOUT_MS   per model call, clamped to [10s, 1h], default 5m
   SUBAGENT_VERIFY_LOG=0        write no JSONL
   SUBAGENT_VERIFY_LOG_FILE     where, default ~/.pi/agent/subagent-verify.jsonl
```

All three of the first three are read in `runVerification`, at the same instant,
when the child SETTLES.

**`ROUNDS=0` is a real setting**, not a degenerate one: it means "judge, do not
repair", which on a one-slot server is a defensible trade. AH5 is that the
`failed` note did not know that — it said "no attempt was made to correct it"
and "kept because the corrections were no better" in the same sentence. §11.5.

An unreadable value falls back to the DEFAULT rather than to zero or to "no
timeout", for the same reason in both cases: a typo in `.env` must not silently
disable the thing.

### 6.7 What it cannot do

The judge is the same 27B that wrote the answer. It catches **a different
question being answered**, **an empty or evasive summary**, and **a claim about
work that was plainly not done**. It does not catch subtly wrong work. It is a
drift check, not a correctness proof, and calling it verification in the stronger
sense would be a lie the parent would act on.

### 6.8 The log

`~/.pi/agent/subagent-verify.jsonl` — one line per model call the verifier makes,
carrying the prompt, the raw reply, **and the parse the stack acted on**. The
parse is the point: a reply and a verdict side by side is the only thing that can
show the parser was wrong, and neither alone can.

Bounded (4,000 chars a field, 2,000 lines newest-kept, pruned every fiftieth
write), injected as `deps.log` rather than imported, and swallowing on every
path — because it runs inside the one function whose entire contract is *never
throw; an unverified answer is worth more than no answer*.

**Nothing real has ever written to it.** It was created in the fifteenth pass and
the stack has not been run against a live model since. That is still the single
highest-value unrun thing in this repo — and AH2 raises its value again, because
`UNADDRESSED` is exactly the kind of thing that file exists to make visible and
exactly the kind of thing three passes of reading could not settle.

---

## 7. `.pi/extensions/compaction-guard` — three bounds every session needs

266 lines plus four `src/` modules — 823 in all. No tools, no commands, three
handlers, and a failure mode by construction: **both hooks only ever ADD a
bounded line or SHRINK a string pi was about to send.** `session_before_compact` returns
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
        IDEMPOTENT: anything within the cap is returned byte-for-byte.
        The mutation is IN PLACE on event.preparation, checked against pi 0.84.2
        rather than assumed.

   2  context                  SHOW THE MODEL ITS OWN BUDGET
        Measured over 259 real assistant turns:
            context <  87% of the window →  3 empty turns of 196   (1.5%)
            context >= 87% of the window → 33 empty turns of  63   (52%)
        So the notice starts at 60%, while there is still room to act on it,
        and hardens at 80%. Appended LAST, so llama.cpp's cached prefix is
        untouched; pi structuredClones the message array before this event, so
        it can never reach the session.
        ✋ if any message already carries a `-context-budget` customType, stand
           down — that is pi-loop-mode's own line. BOTH sides check.

   3  tool_result              BOUND ONE RESULT AGAINST WHAT IS LEFT
        Because the advisory does not bind. On 2026-08-17 the CRITICAL notice
        was in context at 84.5% — "do not run commands with large output this
        turn" — and the model ran a curl loop that returned 17,790 characters,
        taking the window to 100% and the run to an empty turn.
        allowance = clamp(remaining_tokens * 0.10 * 4, 1_500, 20_000)
        head 70% / tail 30%, cut at line boundaries when one is close
        the overflow is written to a SPILL FILE the marker names
        ✋ image blocks are never capped
        AND ERROR RESULTS ARE NOT EXEMPT  ← AF6, fifteenth pass
```

### 7.1 The spill directory, and why its bound is a COUNT

New in this pass as its own module — `src/spill.ts` — because there are two
callers.

```
   every file here is by construction a payload that did NOT fit a context
   window: at least MIN_ALLOWANCE_CHARS, often tens of kilobytes, and nothing
   else ever removes one.

   MAX_SPILL_FILES = 50, and the bound is a COUNT rather than a shutdown sweep
   because `spillDir` is module-global and a CHILD inherits this extension by
   discovery — parent and child share one directory, so a teardown hook on
   either would delete files the other's markers still name. Pruning the oldest
   has no such coupling: a marker that old left the context several compactions
   ago.

   pruneSpills runs AFTER the write, so the file just named can never be the
   one pruned.
```

The second caller is `vendor/pi-subagents-lite/src/spawn/result-cap.ts`, which
had copied the writer without the prune. §11.4 is the account; probe `u3` counts
the files that really appear on disk.

### 7.2 What is deliberately NOT ported from `pi-loop-mode`

The handoff. Replacing pi's model summary with a locally-built one and cutting at
the last turn is correct FOR A LOOP, where the conversation is not the state —
the goal is in `GOAL.md`, progress in `PROGRESS.md`, and each iteration
re-derives its bearings from the working tree. In an ordinary session the
conversation IS the state, and building that summary from an inactive `LoopState`
yields *"No saved loop goal / Iteration: 0 / No durable loop files were
readable"* — 792 characters of form in place of what the user asked for.

---

## 8. `vendor/prinny-channel` — a second human

2,035 lines in `extensions/index.ts`, 2,697 in `src/`, 2,313 in the sidecar.
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
problem. It also keeps ~105 MB of `node_modules` out of the repository.

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
                     string
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
private local work, would be forwarded to whoever just messaged.

So eligibility is tied to **evidence**: the room is marked live when its own
injected text comes back as a `message_end{role:"user"}`, which is pi saying it
has consumed it. `mergeAwaiting` then enforces two rules, both about not throwing
evidence away:

- **`live` only ever goes up.** A second message from the same room cannot
  un-take the first. (AE3.)
- **A message that was never pi's to take does not become the room's marker.**

### 8.3 A leading slash from Matrix

`sendUserMessage` passes `expandPromptTemplates: false`, so a Matrix message
beginning with `/` has never executed anything — it reached the model as literal
text. `command-routing.ts` opens that door for a short **allow-list**, because
the failure modes are not symmetric: forgetting to allow something costs a
message saying "run that in the terminal", and forgetting to deny something hands
an allow-listed Matrix account the harness.

```
   KNOWN_COMMANDS   every command this stack registers, so a refused command can
                    be told from prose.
   MATRIX_LOCAL     compact   — performed by THIS extension, because pi's
                    prompt() dispatches EXTENSION commands only and /compact is
                    a pi BUILT-IN executed by the TUI's own input handler.
   MATRIX_ALLOWED   stack, loop  — both in full, INCLUDING /loop start and run.
   REFUSED_FLAGS    --model         changes the session model
                    --rescue-model  switches it at the third stuck turn
                    --check         run as `pi.exec("bash", ["-lc", …])` once
                                    per iteration for the life of the run.
                                    pi.exec emits NO tool_call, so this
                                    extension's own permission relay never sees
                                    it, rtk's gate never sees it, and the
                                    output cap never sees it. One string, two
                                    doors.
   everything else  refused, with a sentence naming why
```

Only the FIRST LINE is a command candidate: a message whose second paragraph
starts with a slash is prose, and running it would be a surprise.

### 8.4 `agent_settled`, in order

```
   agent_settled  (prinny is SECOND — pi-loop-mode has already run)
     ◆agentRunning = false
     stopTyping()
     continuationStarted = await forwardResult()
     ├─ forward:"result" && lastAssistantText → forwardToMatrix(...)
     ├─ lastRunEmptyEnding.empty?
     │    waiting = live rooms
     │    ✋ compactionInFlight() → heldForCompaction = true            ← AG3
     │       (no nudge, NO RETRY CHARGED, and the retirement notice below
     │        carries the reason `compacting`, whose sentence is TRUE NOW
     │        where the delivery sweep's could only hedge a minute later)
     │    every one under MAX_EMPTY_RETRIES?
     │      ++emptyRetries on each · nudge = nudgeForEmptyEnding(reason, question)
     │      stand every waiting room DOWN (live=false, injected=nudge…)  ← AE4
     │      api.sendUserMessage(nudge, {deliverAs:'followUp'})
     │      retrying = true
     │    else → tell each room giveUpMessage(detail), answered = true
     ├─ !retrying:
     │    unanswered = live && !answered
     │      → tell each one unansweredMessage(ambiguous | compacting |
     │        nothing-to-send), answered = true                          ← AF1
     │    retire every live room
     ├─ alreadySent.clear() · unattributableThisRun = false
     ├─ stopTyping()
     └─ sweepUndelivered()
     held = standAside(pendingCompaction, continuationStarted)          ← AE2
       wait  → keep the /compact for up to COMPACTION_DEFER_LIMIT settlements
       else  → drainPendingCompaction() → startCompaction(room)
                 ✋ compactionInFlight() → "already running"
```

Two of prinny's three lock reads are on this handler, and they answer different
questions with the same flag: `startCompaction` asks *may I compact*, and
`forwardResult` asks *may I prompt*. That is the shape §10.5 is about.

### 8.5 The two things prinny cannot observe, and what it does instead

```
   "the send succeeded"     sendUserMessage returns void; pi swallows the
                            rejection into an empty listener set. So the
                            evidence is the ABSENCE of markLive:
                            undeliveredRooms(entries, now, agentRunning)
                              ✋ agentRunning → report nothing at all
                              ✋ answered | live | already reported → skip
                              ✋ within DELIVERY_GRACE_MS (60 s) → skip
                            Idleness is the load-bearing half, not the clock.
                            The clock covers the one thing idleness cannot:
                            prompt() awaits _checkCompaction BEFORE it starts a
                            run, so a message delivered to an idle session can
                            sit for as long as an auto-compaction takes.
                            It REPORTS rather than retries or retires.

   "the command ran"        a dispatched extension command produces no user
                            message, and pi's own _tryExecuteExtensionCommand
                            wraps the handler in a try/catch that emits the
                            error and `return true`s. There is no observable.
                            The receipt therefore says what THIS EXTENSION did —
                            "Handed `X` to the session" — which it knows.
```

### 8.6 The empty-turn continuation

`describeEmptyEnding` walks back from the end of the run and names the cause,
because an earlier version asserted one cause for all of them and was watched
being wrong two times in three:

```
   truncated           stopReason "length" — the backend hit the token cap
                       mid-output.
   error               stopReason "error" — a transport failure.
   produced-no-answer  output > 1 token, no text and no toolCall. Measured at
                       43% of the window. Nothing to do with room.
   context             ≥87% of the window. The documented cliff.
   unknown             everything else.
```

Two boundaries in that walk were each paid for: it steps over an injected
`subagent-result` and the reasoning-only assistant message pi runs in reply to
it, and it **stops at a `user` message**, because that is the sender's own
question and anything above it belongs to an earlier exchange.

### 8.7 The rest of the surface, briefly

```
   forward: off | result | all   how much of the answer goes to Matrix by itself
        "all" forwards each assistant MESSAGE as it finishes; awaited, because
        pi runs message handlers in order and racing sends would reorder
        somebody's conversation.
        ▲ the ALLOWLIST is `type === "text"`. Thinking and tool calls are never
          forwarded, and it is an allowlist rather than an exclusion so that
          whatever kind pi adds next is not relayed to somebody's phone.
   the `prinny` tool     ONE tool dispatching on `action` — six separate tools
        measured 4,574 chars (~1,144 tokens) of schema on EVERY turn.
   the permission relay  off by default. Fails CLOSED: channel down, or nobody
        answers in time, and the call is blocked. Never gates prinny's own
        tools, which would be a deadlock with extra steps.
   typing                driven from the turn lifecycle, reconciled rather than
        toggled, refreshed every 8 s against a 20 s timeout, and gated on
        `entry.live`.
   the injected text     `[matrix] <what they said>`, with annotations only for
        what changes the ANSWER. Display names are reduced to [\w.@:-] and
        capped at 32, because `Bob] image=/etc/shadow [` would otherwise smuggle
        a forged annotation.
```

---

## 9. `vendor/rtk-pi` — bash output compression, on a leash

254 lines across `extensions/index.ts` and `src/gate.ts`. One handler, no
tools, no commands, no module state.

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
                                  model's eyes.
   PREFIXED  VAR=, sudo, env, time, timeout, nohup, xargs, nice, uv, npx,
             pnpm, yarn, poetry, pdm, hatch, bundle, rye
                                  rtk strips these before matching its own
                                  rules, so a command can be rewritten under a
                                  prefix that changes what the rewrite means.
```

And one on the way back: `extractRewrite` requires the last non-empty stdout line
to start with `"rtk "`.

**Every refusal in this package FAILS OPEN.** Not allow-listed, rtk missing, the
probe wedged, the rewrite threw, `RTK_DISABLED=1` — all five run the command
unfiltered. It is the only extension in the stack with that property.

It is also the package that gets §2.7 right in both of its `pi.exec` call sites,
and the comment on the second one is the reason:

```ts
  // `killed` before `code`, for the same reason `rewriteCommand` does it: pi's
  // `execCommand` resolves a child it killed on the timeout with `code: code ?? 0`
  // — a signalled child exits with no code — so a WEDGED rtk arrives here looking
  // exactly like a healthy one that printed nothing.  … Same shape as AA2, one
  // call site over; see AB3 …
```

**"Same shape as AA2, one call site over" is the sentence AH3 is the enumeration
of.** Two packages wrote it down. A third had it in a module header. Three call
sites in that third package did not read it. §10.5.

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

Every one of these design decisions is that queue: the concurrency default of 1
and `continueSettledAgent` refusing rather than queuing; the verifier's
structural gate; `DEFAULT_VERIFY_ROUNDS = 1`, because a round is two calls;
`__verifier`'s five declarations; the judge going around `spawn()` so it cannot
deadlock on the slot; folding six prinny tools into one; denying the `loop` tool
to a child; the whole of `compaction-guard`.

**And one more, new here:** AH1's deferral is cheap *because* of the queue. A
background result held for five seconds costs nothing an operator can feel, since
the slot was busy with a compaction anyway.

### 10.2 Module-global state, and the two globals on `globalThis`

A subagent's session is created **in the parent's process** and binds the
parent's extensions, which through node's module cache is *the same module
object*. Every extension in the stack keeps state at module scope:

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
   result-cap.ts       its own spillDir, in a module a child never runs
   rtk-pi              no module state; a second instance is genuinely
                       independent
```

Two keys live on `globalThis`, and both exist for the same reason — a fact two or
more packages need and none of them may own:

```
   __PI_SUBAGENT_SPAWN_DEPTH__   "a subagent session is being BUILT right now".
       Published by pi-subagents-lite's shell.ts, read by pi-loop-mode and
       stack.ts. Covers the build, not the run.

   __PI_COMPACTION_IN_FLIGHT__   { owner, at } | undefined.
       THREE implementations of one protocol, now:
         vendor/pi-loop-mode/src/compaction-lock.ts        take · release · read
         vendor/prinny-channel/src/compaction-lock.ts      take · release · read
         vendor/pi-subagents-lite/src/spawn/compaction-lock.ts   READ ONLY
       asserted to agree by a test in each package that imports the others'
       source. The third is read-only on purpose: nothing in that package calls
       ctx.compact(), and shipping begin/end would invite a caller to take a lock
       it has no compaction to release.
         beginCompaction(owner)   false when somebody else holds it;
                                  re-entrant for the SAME owner
         endCompaction(owner)     releases, and only if this owner holds it
         compactionInFlight()     the holder, or undefined
       STALE_MS = 300_000, because a latched lock is worse than the collision it
       prevents.
```

### 10.3 A refusal is half a decision

The fifteenth pass's ledger counted forty-five places this stack declines to act
and found six that dropped what they were holding. The habit that came out of it:
**at every `return` inside a guard, ask what you were holding when you decided
not to, and who has it now.**

AH1 is that question asked of a guard that did not exist yet, and the answer is
why it defers rather than reports: the thing being held is a finished
delegation's only answer, and there is nobody left to hand it to.

### 10.4 Testability is a design constraint here

Ten modules exist only because their parent file imports pi and therefore cannot
be loaded by `node --experimental-strip-types --test`:

```
   turn-tracking.ts      the turn ceiling            (from agent-runner.ts)
   run-answer.ts         what a run SAID             (from agent-runner.ts)
   record-activity.ts    is this record busy         (from seven call sites)
   status-listing.ts     which agents AgentStatus prints  (from agent-status.ts)
   concurrency-slots.ts  the slot arithmetic         (from agent-manager.ts)
   action-report.ts      what the operator is told   (from two TUI files)
   nudge-drop.ts         what a dropped — or HELD — result says
   compaction-anchor.ts  may the anchor be steered   (from agent-manager.ts)
   declared-resources.ts which declaration governs   (from agent-runner.ts)
   git-failure.ts        which of three git failures a result is
   plus, in prinny:  delivery.ts · forwarding.ts · command-routing.ts ·
                     compaction-request.ts · continuation.ts · typing.ts ·
                     permission-gate.ts · inbound.ts
   and in the loop:  goal-check.ts · context-recovery.ts · repetition.ts ·
                     loop-state.ts · context-budget.ts · arguments.ts ·
                     compaction-lock.ts
   and now:          .pi/extensions/compaction-guard/src/spill.ts
                     vendor/pi-subagents-lite/src/spawn/compaction-lock.ts
```

Each of them imports nothing and duck-types its input.

**Two of this pass's six findings are in modules created by that discipline**
(`git-failure.ts`'s rule, `nudge-drop.ts`'s sentences), which is the discipline
working — the sentence is in a place a test can reach — and the test that would
have caught it was not written. That is the same closing note as the sixteenth
pass, and it is why two of this pass's fixes are *standing scans* rather than
assertions about one case.

### 10.5 The second-instance graph

**This is the artefact this pass exists to leave behind.** Every row is a rule
this stack has already paid for — measured, written down at length, and usually
lifted into its own module so it could be tested. The bar to the right is every
place in the process that the rule belongs. `●` is where it was written, `✔` an
instance that read it, `✘` an instance that did not until this pass.

The columns are DISTANCE, and the point of the drawing is that the distance is
never large:

```
   │ SAME FN  │ same function or the one below it
   │ SAME FILE│ same file
   │ SAME PKG │ same package, a different directory
   │ SAME PROC│ a different package in the same node process
```

```
 ══════════════════════════════════════════════════════════════════════════════════
  R1   READ THE COMPACTION LOCK BEFORE YOU START A TURN
       written 15th pass, ×2 · pi-loop-mode & prinny-channel /src/compaction-lock.ts
       "the honest fix is a flag NEITHER PACKAGE OWNS"
 ══════════════════════════════════════════════════════════════════════════════════
                                              SAME FN  SAME FILE  SAME PKG  SAME PROC
   ● beginCompaction / endCompaction / read     ●
   ✔ requestEmergencyCompaction   (loop)                            ✔
   ✔ interveneStuck's rung        (loop)                            ✔
   ✔ startCompaction              (prinny)                 ✔
   ✔ sendLoopTurn         AG2 16th (loop)                           ✔
   ✔ forwardResult        AG3 16th (prinny)                ✔
   ✘ emitIndividualNudge  AH1 17th (subagents)                                ✘
        ▲ the THIRD package, and the ONLY sender with no second attempt.
          The 16th pass's own handoff asked for exactly this and looked for it
          in the future: "there is no test that a FIFTH would be noticed …
          it will produce another one the next time a sender is ADDED."
          It did not need to be added. It was already there.

 ══════════════════════════════════════════════════════════════════════════════════
  R2   TEST THE NEGATIVE VERDICT FIRST, AND TEST FOR EVERY SPELLING OF IT
       written 4th pass (S2) · verify.ts · "the wrong order turns every failure
       into a silent pass, forever"
 ══════════════════════════════════════════════════════════════════════════════════
                                              SAME FN  SAME FILE  SAME PKG  SAME PROC
   ● readVerdictValue — NOT_ADDRESSED first     ●
   ✔ the prose pass — ANCHORED, so `unaddressed`
     inside a sentence is not a verdict                   ✔
   ✘ the VERDICT-line pass — UNANCHORED, on
     purpose (`_ADDRESSED_` is a real shape),
     and the negative alternation never grew
     the second spelling            AH2 17th     ✘
        ▲ ONE PARSER, TWO PASSES, and they disagreed about what "no" looks
          like. Recorded as open in the 12th, 13th and 14th passes.

 ══════════════════════════════════════════════════════════════════════════════════
  R3   `killed` BEFORE `code` — pi.exec resolves a child it KILLED with code 0
       written 10th pass (AA2) · goal-check · re-written 11th (AB3) · rtk ·
       re-written again as a module · git-failure.ts, "this is AA2 one package over"
 ══════════════════════════════════════════════════════════════════════════════════
                                              SAME FN  SAME FILE  SAME PKG  SAME PROC
   ● runGoalCheck                 AA2 (loop)     ●
   ✔ rtk `rewrite`                    (rtk)                                   ✔
   ✔ rtk `--version`              AB3 (rtk)                                   ✔
   ✔ getGitCommonDir           (subagents)                                    ✔
   ✔ rev-parse --show-toplevel (subagents)                                    ✔
   ✘ execGit                   AH3 (subagents)                      ✘
   ✘ listWorktrees             AH3 (subagents)                      ✘
   ✘ isInGitRepo               AH3 (subagents)                      ✘
        ▲ under a docstring reading "the same strategy as the worktree validator"
   ✘ docker ps                 AH3 (stack.ts)                                 ✘
        ▲ a wedged daemon reported EVERY container "not running"
   ✘ dockerVram                AH3 (stack.ts)                                 ✘
   ~ seven more in stack.ts — script runners whose output is reported verbatim,
     where a wedge shows as empty output rather than as a wrong verdict. Stated,
     not changed.

 ══════════════════════════════════════════════════════════════════════════════════
  R4   BOUND THE SPILL DIRECTORY — every file in it did not fit a context window
       written 11th pass · compaction-guard/index.ts · "an unattended /loop run is
       exactly the shape that fills a disk with them"
 ══════════════════════════════════════════════════════════════════════════════════
                                              SAME FN  SAME FILE  SAME PKG  SAME PROC
   ● spill() + pruneSpills + MAX_SPILL_FILES    ●
   ✔ the cap's own numbers, IMPORTED by
     result-cap.ts, deliberately, under
     "Why it imports the guard rather than
      carrying its own numbers"                                              ✔
   ✘ result-cap.ts's own spill()  AH4 17th                                    ✘
        ▲ the same file that imports the numbers copied the WRITER, minus the
          prune. Both spill directories are in one process; one was bounded.

 ══════════════════════════════════════════════════════════════════════════════════
  R5   COUNT-AWARE SENTENCES — the PARENT MODEL reads these and repeats them
       written 7th pass (W5) · verify.ts · describeAttempts / describeOrdinal
 ══════════════════════════════════════════════════════════════════════════════════
                                              SAME FN  SAME FILE  SAME PKG  SAME PROC
   ● describeAttempts(0|1|2|n)                  ●
   ✔ describeOrdinal — "2th" and "a third time" ✔
   ✔ the `repaired` note                                  ✔
   ✔ the `unparsed` note                                  ✔
   ✘ the `failed` note's SECOND CLAUSE AH5 17th ✘
        ▲ ONE SENTENCE. "…and no attempt was made to correct it. This is the
          agent's original answer, kept because the corrections were no better."

 ══════════════════════════════════════════════════════════════════════════════════
  R6   A DIRECTIVE THE LADDER HAS CHARGED FOR MUST REACH THE MODEL
       written 6th pass (V4), widened 15th (AF3) · pi-loop-mode
       "here the loop needs THIS TEXT to reach the model"
 ══════════════════════════════════════════════════════════════════════════════════
                                              SAME FN  SAME FILE  SAME PKG  SAME PROC
   ● interveneStuck's queueOnly path  V4        ●
   ✔ improve · unblock · check_failed ·
     regression · audit               AF3                 ✔
   ✘ …all six of them, once AG2 taught
     sendLoopTurn to DEFER            AH6 17th   ✘
        ▲ the deferral parks the turn in the loop's ONE `pendingTimer` slot, and
          `agent_end` clears that slot at its first line — and the queueOnly path
          is taken precisely when a second `agent_end` is guaranteed within
          milliseconds. A fix from the 16th pass reopening a fix from the 6th.
```

**Read the columns.** Ten `✘` instances across six rules:

```
   SAME FN    3    AH2 (one parser, two passes, opposite rules)
                   AH5 (one sentence, two clauses)
                   AH6 (one function, and the option it was handed)
   SAME PKG   3    AH3 ×3 — three git probes in the package that owns the module
                   stating the rule, one of them under a docstring naming it
   SAME PROC  4    AH1 (the lock's third package)
                   AH3 ×2 (stack.ts's docker probes)
                   AH4 (the second spill directory)
```

Not one of them required opening a file the author had not already opened.
Three of them did not require leaving the function. **The rule was never far
away; what was missing was the enumeration.**

**And read R1's own history.** The sixteenth pass wrote its residue down
correctly, in the right words, and still looked in the wrong direction:

> it will produce another one **the next time a sender is added**.

The next sender was not added. It was already in the tree, in the package that
now owns the lock's third copy, on the one path in the machine that gets a single
attempt — and it had been there through AA4 (which rewrote its `deliverAs`), AC1
(which fixed its `catch`) and AG6 (which fixed its drop sentence), three passes
that each read that exact function for something else. **"Who else should be
asking this" is a question about the code that EXISTS, not about the code that is
coming.**

---

## 11. The findings

**All six are fixed.** Every one carries a regression test that fails when the
fix is removed — the *control run* below is that measurement — and a probe that
prints BEFORE and NOW, so the probe is its own control: run it and the left
column is the defect, the right column is the tree as it stands.

### 11.1 AH1 — the answer with no second attempt

**MEDIUM · FIXED**

`SpawnCoordinator.emitIndividualNudge` is the only route a BACKGROUND subagent's
answer has to the parent model. It delivers with:

```ts
  pi.sendMessage(
    { customType: "subagent-result", content: `[Subagent …]\n\n${capped.text}`, … },
    { deliverAs, triggerTurn: true },
  );
```

which is `AgentSession.sendCustomMessage`. During a compaction the session is
idle — `compact()` begins `await this.abort()`, which ends in `waitForIdle()` —
so `isStreaming` is false and the **only** branch available is:

```js
  else if (options?.triggerTurn) { await this._runAgentPrompt(appMessage); }   :1090
```

`_runAgentPrompt` checks nothing. pi's one compaction refusal is on `prompt()`
(`:807`), which this path does not touch.

**What that costs**, measured out of pi's source in §2.5: the run's provider
requests are built from a snapshot of the PRE-compaction message list (`Agent`'s
`createContextSnapshot()` is `_state.messages.slice()`), so the run works from
the oversized context the compaction exists to shrink and finishing the
compaction does not change it; two model calls are in flight on a one-slot
server; and a whole `agent_start … agent_end … agent_settled` cycle runs inside
the compaction window, re-entering every handler in the stack — including the
loop's ladder and prinny's `forwardResult`.

**Why this sender is the worst of the three.** All three senders through that
branch now read the lock. The other two have somewhere to put what they are
holding:

```
   sendLoopTurn      AG2   RESCHEDULES.  The same iteration goes 5 s later, and
                           an unattended run has more iterations anyway.
   forwardResult     AG3   HOLDS, charges no retry, and tells the sender the
                           true reason NOW. A person can ask again.
   emitIndividualNudge AH1  had NOTHING. It is called once per record, from a
                           200 ms batch timer, on a record whose slot is already
                           released, whose completion gate is already open and
                           whose `result` is the only copy of the answer. There
                           is no second attempt and nobody to ask.
```

**The change.** A third, READ-ONLY implementation of the lock protocol at
`src/spawn/compaction-lock.ts` — read-only because nothing in this package calls
`ctx.compact()`, and shipping `begin`/`end` would invite a caller to take a lock
it has no compaction to release. `emitIndividualNudge` reads it after the three
drop guards and **before the cap**:

```ts
  const holder = compactionInFlight();
  if (holder) {
    if (!this.heldForCompaction.has(agentId)) {
      this.heldForCompaction.add(agentId);
      const hold = describeNudgeHold(holder.owner, agentId.slice(0, SHORT_ID_LENGTH), record.display.type);
      console.warn(`[pi-subagents-lite] ${hold.log}`);
      try { (record.execution.spawnCtx ?? ctx)?.ui?.notify?.(hold.notice, "info"); } catch {}
    }
    this.scheduleNudgeIn(agentId, COMPACTION_WAIT_MS);
    return;
  }
  this.heldForCompaction.delete(agentId);
```

Three details that are not incidental:

- **Above the cap, not below it.** `capBackgroundResult` sizes the result against
  `ctx.getContextUsage()`, which during a compaction still reports the
  pre-compaction window. Waiting first also measures the context the result will
  actually land in.
- **`describeNudgeHold` is a new sentence, not a reuse of the drop sentences.**
  A held result is not a dropped one: the answer is intact, and the notice says
  *"result held — pi-loop-mode is compacting; it will be delivered when that
  finishes"*, at `info`. It lives in `nudge-drop.ts` with the other four, so the
  five cannot drift. It names the holder, because that is the whole value of the
  lock over a boolean.
- **`heldForCompaction` bounds the notice, not the retry.** The operator is told
  once per record; the re-ask is every `COMPACTION_WAIT_MS`, bounded by the
  lock's own `STALE_MS`.

`scheduleNudge` became `scheduleNudgeIn(agentId, delayMs)` with the old signature
kept as a one-line wrapper, so the batch window and the re-ask share one timer.

**Control run:** remove the read and 3 of `tests/compaction-lock.test.ts`'s 13
assertions fail.
**Probe:** `u5-the-answer-delivered-into-a-compaction.mjs` — pins pi's six facts
out of `agent-session.js` and `agent.js`, then drives the SHIPPED coordinator
with the lock held by `pi-loop-mode`, waits out two re-asks, releases, and shows
the same answer arriving.

### 11.2 AH2 — the verdict that was read as its own opposite

**MEDIUM · FIXED · open since the twelfth pass**

```
   parseJudgeVerdict("VERDICT: UNADDRESSED")
     BEFORE   { addressed: true,  unparsed: false }
     NOW      { addressed: false, unparsed: false }
```

`readVerdictValue` tested `/NOT[_\s-]?ADDRESSED/i` and then `/ADDRESSED/i`,
neither anchored. `UNADDRESSED` has no "NOT", so the first missed it; the second
matched it as a substring. Same for `Unaddressed`, `**VERDICT:** UNADDRESSED` and
`> verdict : unaddressed`.

**`unparsed: false` is the finding.** A reply nobody can read fails OPEN *and
says so* — `verificationNote("unparsed")` tells the parent model *"the check
could not be read, so this answer went out unchecked"*. This one is not
unreadable. It is read, confidently, as its own opposite: `record.verification`
becomes `passed`, the answer goes back **with no annotation of any kind**, and
the repair round it should have triggered is never spent. The module's own
comment is the sentence it violates — *"the wrong order turns every failure into
a silent pass, forever."*

**Why three passes left it.** §11.5 of `…-controls.md`, restated in the
fourteenth and sixteenth:

> Left alone: the prompt asks for one of two exact tokens, adding a `\b` risks
> the tolerant forms the parser was widened to accept (S2, U4), and the
> fail-open policy already makes an unreadable verdict a pass.

Taking those in order:

- *the prompt asks for one of two exact tokens* — true, and the entire file
  exists because a 27B does not comply. `VERDICT_LINE` tolerates `**VERDICT:**`,
  `> verdict :` and `VERDICT:x` for exactly that reason.
- *adding a `\b` risks the tolerant forms* — **RIGHT, and this is why the fix is
  not a `\b`.** The VERDICT-line value arrives with its markdown attached, and
  `_` is a word character, so `\bADDRESSED\b` does not match inside
  `_ADDRESSED_`. Probe `u1`'s control block runs that case both ways. The
  decision weighed the one fix it named and declined it correctly — and never
  asked whether that was the only fix.
- *the fail-open policy already makes an unreadable verdict a pass* — **this
  names a policy that does not reach the case.** Fail-open covers `unparsed`,
  and `unparsed` is reported. This is a parsed, unreported, inverted verdict.

**The change.** Widen the NEGATIVE alternation, which touches nothing on the
positive side because no verdict meaning "yes" contains the substring
`UNADDRESSED`:

```ts
  const NEGATIVE_VERDICT       = /(?:NOT[_\s-]?|UN)ADDRESSED/i;       // VERDICT: line
  const NEGATIVE_VERDICT_PROSE = /\b(?:NOT[_\s-]|UN)ADDRESSED\b/i;    // prose pass
```

Both are named constants now, so the two passes of one parser are visibly
different by design (one anchored, one not) rather than accidentally different.

**Control run:** revert the widening and 1 test fails — the block asserting all
four negative shapes. The second block, the three tolerant positives, passes
either way, which is what makes it a control rather than a second assertion.
**Probe:** `u1-the-verdict-that-was-its-own-opposite.mjs`.

### 11.3 AH3 — `killed` before `code`, at the sites the module did not reach

**LOW/MEDIUM · FIXED**

`git-failure.ts` exists because `worktree-validator.ts` read `result.code` first.
Its header carries the measured table (§2.7) and this sentence:

> This is AA2 one package over — the loop's goal check had the same assumption
> about the same function.

It fixed the two call sites it was lifted out of. Three more in the same package
tested `code` first:

```
   agent-runner.ts     execGit          `result.code === 0 ? result.stdout.trim() : null`
        a wedged git returns "" rather than null, so `detectEnv` tells the CHILD
        it is not in a git repository and gives it no branch. GIT_EXEC_TIMEOUT_MS
        against a 9p mount is not a hypothetical.

   menu-spawn-wizard   listWorktrees    `if (result.code !== 0) return null`
        a wedged git parses as an EMPTY LIST, so the operator is shown "no
        worktrees" for a probe that never answered — under a docstring saying it
        returns null "if git is unavailable or the command fails".

   menu-spawn-wizard   isInGitRepo      `result.code === 0 && stdout.trim() !== ""`
        under a docstring reading "the same strategy as the worktree validator".
        The strategy that docstring names IS `classifyGitFailure`.
```

And two outside the package, in `.pi/extensions/stack.ts`:

```
   docker ps    `psR.value.code === 0` with an empty stdout builds an empty
                `running` map, so EVERY container in the compose file is reported
                "not running". On this box the documented way docker wedges is
                memory pressure — which is also exactly when an operator runs
                `/stack status`, and the obvious next action on that report is to
                recreate containers that are fine.
   dockerVram   returns "" rather than null for a wedged `nvidia-smi`.
```

**The change.** All five now classify. `stack.ts`'s two read `!killed && code === 0`
in place with the reasoning in a comment; the three in `pi-subagents-lite` go
through `classifyGitFailure`, which is the module that owns the rule.

**And a standing scan, which is the half that lasts.**
`tests/exec-verdicts.test.ts` walks every `.ts` under `src/`, strips comments —
for the reason the sixteenth pass's `t5` learned, that every module here quotes
its own wiring and a scan for wiring must not read the prose about it — and fails
on any `.exec(` whose next twelve lines mention neither `classifyGitFailure` nor
`killed`. It carries a control assertion that the scan found call sites at all,
so a broken scan cannot pass by finding nothing.

The seven remaining `pi.exec` sites in `stack.ts` are script runners whose output
is reported verbatim; a wedge shows there as empty output rather than as a wrong
verdict. Stated rather than changed.

**Control run:** revert any one of the three and the standing scan fails, naming
the file and line.
**Probe:** `u2-the-probe-that-did-not-answer.mjs` — pins `execCommand`'s shape
out of pi's source, tabulates the three `git` outcomes under both readings, and
prints the scan's own output.

### 11.4 AH4 — the second spill directory

**LOW · FIXED**

`compaction-guard`'s output cap writes what it cuts to a `mkdtemp` and prunes it
to `MAX_SPILL_FILES = 50`. `result-cap.ts` — the second cap, which exists because
a background subagent's result never passes through `tool_result` — copied the
writer without the prune.

The file already knew the rule. Its own header, about the guard's NUMBERS:

> A second copy of those constants here would drift away from the test that
> justifies them, so this imports them instead.

And the bound's own docstring names the shape it exists for:

> An unattended `/loop` run is exactly the shape that fills a disk with them:
> days of iterations, each capping the test-runner output it just produced.

A `/loop` that delegates in the background produces exactly that: one file per
capped subagent answer, keyed by a record id that is unique per delegation, and
nothing ever removed one.

**The change.** `.pi/extensions/compaction-guard/src/spill.ts` — a new module
holding `MAX_SPILL_FILES`, `pruneSpills` and `createSpillWriter(prefix)`. The
guard and `result-cap.ts` both use it, each keeping its own directory so the two
counts stay independent and the guard's parent/child sharing argument is
untouched. The reasoning for the bound being a COUNT rather than a teardown sweep
moved into the module with the code.

**Control run:** raise `result-cap.ts`'s bound and
`tests/result-cap-spill.test.ts` fails with *"62 capped results left 62 files
in /tmp/pi-subagent-result-…; the bound is 50"*.
**Probe:** `u3-the-two-spill-directories.mjs` — drives both SHIPPED caps 62 times
and counts the files that really appear on disk, including the control that the
prune drops the OLDEST (a prune that took the wrong end would satisfy the count
and lose the answer the newest marker names).

### 11.5 AH5 — the note that named corrections nobody made

**LOW · FIXED**

```
   SUBAGENT_VERIFY_ROUNDS=0, and the judge says NOT_ADDRESSED:

   BEFORE  [verification: this answer was checked against the task and did not
            address it, and no attempt was made to correct it. This is the
            agent's original answer, kept because the corrections were no
            better. Treat it as unreliable.]

   NOW     [verification: this answer was checked against the task and did not
            address it, and no attempt was made to correct it. This is the
            agent's original answer. Treat it as unreliable.]
```

`describeAttempts` was made count-aware by W5 — that is why it spells small
counts out in words at all, because *"the PARENT MODEL reads this and copies it
into its own answer"*. The clause immediately after it was not. `ROUNDS=0` is a
value `clampRounds` accepts and `resolveVerifyRounds` documents; on a one-slot
server "judge, do not repair" is a defensible setting.

**Control run:** revert and 1 of `tests/verify.test.ts`'s assertions fails.
**Probe:** the AH5 block of `u1`.

### 11.6 AH6 — the directive AG2's deferral deleted

**MEDIUM · FIXED**

`deliverLoopTurn` and `interveneStuck` send with `queueOnly` in exactly one
situation: `ctx.hasPendingMessages()` is true. AA3 established what that means —
a HUMAN typed into a session that was already streaming — and V4/AF3 established
what it obliges: six exits of `agent_end` carry a DIRECTIVE, everything above
them has already been charged, and the text has to arrive.

AG2 then made every send read the compaction lock and, when it is held,
reschedule through `scheduleLoopTurn`, which writes the loop's ONE `pendingTimer`
slot. `agent_end`'s first act is `clearPendingTimer()`.

**The two conditions are not independent.** `queueOnly` MEANS a turn is already
coming, so `_handlePostAgentRun()` returns true and `agent.continue()` produces
another `agent_end` within milliseconds — well inside `COMPACTION_WAIT_MS`. The
deferral did not delay the directive on that path. It deleted it.

Measured against the shipped module (probe `u4`), with a compaction held:

```
   iteration N   the model says "LOOP_BLOCKED: no credentials for the staging
                 registry."
                 ✔ ++blockedSignalCount
                 ✔ operator told: "blocked reported … continuing with assumptions"
                 ✔ AG2 holds the turn, and says so
   the turn that was already coming ends
                 ✘ agent_end → clearPendingTimer() → the unblock directive is gone
   the compaction finishes
                 BEFORE   the model receives `continue`
                 NOW      the model receives `unblock`
```

So the operator was told the model had been instructed to make an assumption and
carry on; the model was told to keep going. In an unattended run there is nobody
to notice, and `LOOP_BLOCKED` means the run is waiting for a human who is not
there.

**The change**, in three parts:

```ts
  const DIRECTIVE_KINDS: ReadonlySet<TurnKind> =
    new Set(["improve", "unblock", "check_failed", "regression", "audit", "stuck"]);
  let deferredDirective: TurnKind | undefined;
```

- the deferral records the kind when it is one of the six;
- the next send uses `DIRECTIVE_KINDS.has(kind) ? kind : (deferredDirective ?? kind)`
  — so a fresher directive supersedes a remembered one, because that is a newer
  reading of the same run, and exactly one turn is still sent;
- `resetContextRecovery()` clears it, alongside `waitingForCompaction`, because
  a directive belongs to the run it was decided for.

`scheduleLoopTurn` also carries `opts` through now. It is the one path that
reaches it with `queueOnly` or `noticeCtx` set, and the re-ask is the same call
five seconds later.

**A note on the test harness.** The first version of the regression test passed
with the fix removed, because `turn-into-a-compaction.test.ts`'s fake replaced
`setTimeout` and not `clearTimeout` — so its handles could not be cancelled, and
AH6 is *entirely about a handle being cancelled*. That is X1 pointed at the
scaffolding: **the evidence models the host, and the model omitted the one thing
under test.** The fake now models both.

**Control run:** remove either half of the fix and 1 of the AH6 block's 4
assertions fails.
**Probe:** `u4-the-directive-that-was-charged-and-dropped.mjs`, with real timers.

---

## 12. The evidence

### 12.1 The gates

```
                                    before    after    suites
   vendor/pi-loop-mode      tests     223       227       54
   vendor/pi-subagents-lite tests     346       365       79
   vendor/prinny-channel    tests     382       382       87
   .pi/extensions/compaction-guard     47        47       10
   vendor/rtk-pi            tests      20        20        4
                                     ─────     ─────
                                    1,018     1,041
   probes                              72        77
   lint                          91/91 +     95/95   (pi-subagents-lite;
                                                      `node --check` clean in
                                                      the other three)
```

The *before* column was measured on the tree as this pass found it, before
anything was written.

New test files:

```
   vendor/pi-subagents-lite/tests/compaction-lock.test.ts     AH1   13 tests
        the three-way protocol agreement + the wiring assertions
   vendor/pi-subagents-lite/tests/exec-verdicts.test.ts       AH3    2 tests
        the STANDING SCAN, plus its own control
   vendor/pi-subagents-lite/tests/result-cap-spill.test.ts    AH4    1 test
   vendor/pi-loop-mode/tests/turn-into-a-compaction.test.ts   AH6   +4 tests
        appended to AG2's own file, and its fake host taught to model clearTimeout
   vendor/pi-subagents-lite/tests/verify.test.ts              AH2, AH5  +3 tests
```

### 12.2 The five probes

Every probe drives the **shipped** modules. `u5` loads the real coordinator
through pi's own bundled jiti, exactly as node's module cache puts it there in a
real session.

```
   u1-the-verdict-that-was-its-own-opposite.mjs             AH2, AH5
        The shipped `parseJudgeVerdict` with the old `readVerdictValue` modelled
        beside it. Five ways a judge writes "no" — PASS in every one BEFORE,
        fail in every one NOW — then NINE controls, including
        `VERDICT: _ADDRESSED_`, which is the shape the thirteenth pass's
        reasoning was protecting and which a `\b` really would have broken.
        Then AH5's three notes at 0, 1 and 2 rounds.
        node --experimental-strip-types u1-the-verdict-that-was-its-own-opposite.mjs

   u2-the-probe-that-did-not-answer.mjs                     AH3
        pi's `execCommand` pinned out of source (never rejects; `code ?? 0`),
        the three `git` outcomes under both readings, and then the STANDING
        SCAN's own output: every `pi.exec` verdict in the package, one line each.
        node --experimental-strip-types u2-the-probe-that-did-not-answer.mjs

   u3-the-two-spill-directories.mjs                         AH4
        Drives BOTH shipped caps 62 times with a 40,000-char payload and counts
        the files on disk: guard 50/50, result-cap 62 BEFORE and 50 NOW. Then
        the control that the prune drops the OLDEST and the newest marker still
        resolves to a whole file.
        node --experimental-strip-types u3-the-two-spill-directories.mjs

   u4-the-directive-that-was-charged-and-dropped.mjs        AH6
        The shipped loop, real timers. A LOOP_BLOCKED turn under a held lock,
        then the turn that was already coming ending — and what the model is
        eventually sent: `continue` BEFORE, `unblock` NOW.
        node --experimental-strip-types u4-the-directive-that-was-charged-and-dropped.mjs

   u5-the-answer-delivered-into-a-compaction.mjs            AH1
        Seven of pi's own facts pinned first — the refusal, the branch,
        `_runAgentPrompt`, `abort()`+`waitForIdle()`, the message-array
        replacement, and `createContextSnapshot`'s `.slice()`. Then the real
        `SpawnCoordinator` with the lock held by `pi-loop-mode`: nothing sent,
        one notice naming the holder, still nothing after a second re-ask, and
        the same answer delivered once the lock frees.
        node u5-the-answer-delivered-into-a-compaction.mjs
```

### 12.3 Re-running everything

```bash
cd ~/instantcoffee
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
lower total. The five numbers in §12.1 are the ones to compare against.

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
        ▲ AH1 narrows this: a result held for a COMPACTION is now delivered, so
          the remaining gap is a session that has genuinely gone away.
   §11.2  a channel-down apology cannot arrive.
   §11.3  a room-less inbound message falls through to the model as text.
   §11.4  the /agents spawn wizard is the one spawn path that can hold no
        concurrency slot. Unreachable, stated.
   §11.5  `continue` still drops when a message is pending. The line AF3 draws,
        and AH6 deliberately does not move it.
   §11.6  `answered` is set by the act of replying, not by evidence it arrived.
   §11.7  a SIGTERM from outside on a goal check runs bash's EXIT trap, so the
        marker proves COMPLETION, not INTENT.
   §11.8  the watchdog skips a verifying record and deletes its state.
   §11.9  a --check is a shell channel no tool_call handler can see, from the
        tool and the terminal. Closed from Matrix (AD6).
   §11.10 agentRunning is false for the width of one await chain.
   §11.11 CLOSED by AH2 — see §11.2. This entry has been on the open list since
        the twelfth pass and comes off it here.
   §11.12 pi's OWN threshold and overflow compactions mark nothing, so no
        extension can stand aside for them. UNCHANGED, and now the bound on
        three fixes rather than two — see §13.2.
   plus  the Matrix command sweep's blind spot, the brief-before-session window,
        hasStateChange's keyword list, T6, per-session loop state, T1's general
        case, and resuming a completed run.
```

Also carried, and re-derived this pass rather than assumed:

```
   AB1  `killed` is only pi's OWN kill. An OOM kill, an operator's `pkill` or a
        container going down all resolve { code: 0, killed: false } — the shape
        of a check that PASSED. AH3 fixes the readings; it cannot fix this,
        because the information does not leave `waitForChildProcess`.
```

### 13.2 This pass's residue

AH1–AH6 are fixed; §11 has the change, the numbers and the control run for each.

**One bound, unchanged and now wider.** The compaction lock can only be read for
compactions an *extension* asked for. pi's own threshold and overflow compactions
mark nothing, so **all three** senders' guards stop at the same edge:

```
   AG2  sendLoopTurn's deferral
   AG3  forwardResult's hold
   AH1  emitIndividualNudge's hold          ← new, same edge
   and §11.12's mutual exclusion
```

Marking pi's own compactions would need a hook pi does not have. `compaction_start`
is emitted (`agent-session.js:1370`) but not as an `ExtensionEvent` an extension
can subscribe to; adding one is an upstream change, not a fork change.

**And one negative result, reported because a control was run for it.**
`contextBudgetText` (the loop) has no `Number.isFinite(percent)` guard where its
sibling `contextNoticeText` (the guard) does — a textbook second-instance shape.
It is **not a finding**: pi's `getContextUsage()` returns `undefined` when
`contextWindow <= 0` (`agent-session.js:2546`), so `percent` is finite whenever
it exists. Recorded so the next reader does not re-derive it.

Similarly: `AgentWidget.ensureTimer()` arms an 80 ms `setInterval` and does not
`unref()` it, where every other long-lived timer in the stack does. Not a
finding: print mode's `disposeRuntime()` emits `session_shutdown`, which reaches
`getWidget()?.dispose()`, which clears it. Checked in `modes/print-mode.js:29`
rather than assumed.

### 13.3 Still unwatched — none of this has been run against a live model

**This is the whole of what is left, and it has been true for fourteen passes.**
Everything in seventeen documents is verified against probes, tests and pi's own
source, and none of it against a 27B actually answering. The list, cheapest
first:

```
   1  §U   Esc on a loop turn, then type a question.
           ONE KEYPRESS and one sentence. No subagent, no verifier, no Matrix
           account. It is AE1 end to end.
   2  §AA.1  /loop --delay 20, type /compact in the gap. AG2 from the terminal
           in one minute, no Matrix account and no saturated context — and now
           also the cheapest way to see AH6, because a LOOP_BLOCKED or a
           LOOP_DONE turn in that gap is the shape that used to lose its
           directive.
   3  §X   Two rooms, one turn. Both must hear something. (AF1)
   4  §Y   A /loop against a genuinely failing suite. `Compaction guard: capped
           bash output N -> M` should appear once per iteration.
   5  §Z   Type something while the goal check is running.
   6  §B/§P One background delegation, and the only question is whether the
           result appears in the conversation at all. Do it headless too.
           ▲ AH1 adds a second question to this run: start it, then type
             /compact while the child is still working. The result must arrive
             LATE rather than not at all, and the notice must name the holder.
   7  §M/§M.2/§M.3  three /loop starts with different --checks.
   8  §R   A real verification, foreground, SUBAGENT_VERIFY_ROUNDS=1, a
           deliberately off-task brief, with a STEER in it (AF5 and AG1).
   9  READ ONE LINE OF ~/.pi/agent/subagent-verify.jsonl written by a real
           judge. It has existed since the fifteenth pass and nothing real has
           ever written to it.
           ▲ AH2 raises this to the top of the list on value. `UNADDRESSED` is
             precisely the kind of thing that file exists to make visible, and
             three passes of reading could not settle it. Do 8, then read the
             `parsed` field beside the `reply` field.
  10  §I, §J, §K/§K.2, §L, §N, §O — never run.
```

---

## 14. The pattern across seventeen passes

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
```

Four things transfer out of this one.

**W1–W6 is not a stage this series passed through; it is the steady state.** The
seventh pass named it — *"the rule was established and applied to the instance in
front of it"* — and it has recurred in some form in every pass since, because a
fix is written while looking at a failure and a failure is one shape. The
difference here is the remedy. AF5's answer was a better fix; AG1's was a better
fix; this pass's answer is **an enumeration and, twice, a scan**. A better fix
covers the instance in front of you. Only a list covers the ones behind you.

**Two of the six fixes are standing scans, and that is the shape to copy.**
`tests/exec-verdicts.test.ts` and `tests/subagent-denylist.test.ts` do not assert
anything about a case; they assert that a RULE is applied everywhere its shape
appears, and they fail on the next instance rather than on the last one. The cost
is one grep over `src/`; the thing they buy is that the next author does not have
to know the rule exists. Both carry a control assertion that the scan found
anything at all, because a scan that matches nothing passes.

**"Something else will handle this" and "the thing you named is a file you can
open" both have a third instalment, and it is a plural.** The fifteenth pass
asked you to read the code you were relying on. The sixteenth asked you to open
the thing your sentence named. This one asks: *and where else does that thing
belong?* All three are the same discipline at increasing radius, and the radius
is what makes them progressively harder — the first two are answerable by
reading; this one is only answerable by SEARCHING.

**A decision to leave something open is a claim, and it ages.** AH2 sat open for
three passes under a rationale with three clauses: one true and irrelevant, one
true and load-bearing (it correctly rejected a `\b`), and one that named a policy
which does not cover the case. What was missing was not rigour — that reasoning
is better than most — but the next question: *is the fix I just rejected the only
fix?* **When you write down why you are leaving something, write down which fix
you considered. The next reader can then check whether it was the only one.**

---

## 15. Where to look

- **This document** — §1 is the whole machine; §2 is pi, and is the thing most
  worth reading before changing anything; §2.5 is what a run started inside a
  compaction actually costs, measured; §2.7 is `pi.exec`'s two missing facts;
  §3 is the event bus; §4–§9 are the five packages; **§10.5 is this pass's
  artefact, the second-instance graph**; §11 is the findings.
- `context/design/subagents-loop-verifier-references.md` — the sixteenth pass
  (AG1–AG6), and the previous self-contained account. Its §1.D is the corrected
  event bus and its §10.2 is the lock's first table of readers.
- `context/design/subagents-loop-verifier-omissions.md` — the fifteenth pass
  (AF1–AF6). Its **§2 is the refusal ledger**: every place this stack declines to
  act, what it was holding, and who owns that afterwards. That artefact is not
  restated here and is the best single thing to read next.
- `…-claims.md` (fourteenth, AE1–AE7, and its §2 claim ledger) ·
  `…-controls.md` (thirteenth, AD1–AD7 — and its §11.5 is the decision AH2
  overturns) · `…-deliveries.md` (twelfth, AC1–AC5) · `…-signals.md` (eleventh,
  AB1–AB4) · `…-hosts.md` (tenth, AA1–AA4) · `…-answers.md` (ninth, Z1–Z4) ·
  `…-turns.md` (eighth, X1–X5, Y1) · `…-readers.md` (seventh, W1–W6) ·
  `…-shapes.md` (sixth, V1–V8) · `…-units.md` (fifth, U1–U9, whose §9 reference
  sections no later document restates) · `…-surfaces.md` (fourth, S1–S10) ·
  `…-mechanics.md` (third, T1–T9, still the best account of pi's own agent loop)
  · `…-evaluation.md` (second, F1–F11) · `…-anatomy.md` (first, and the design
  rationale).
- `context/testing/subagents-loop-verifier.md` — the hand-testing script. §13.3
  above is its index in cheapest-first order.
- `context/testing/probes/README.md` — what each of the seventy-seven probes
  prints. Read its last six paragraphs before trusting or writing one.
- The four `FORK.md` files — `vendor/pi-loop-mode`, `vendor/pi-subagents-lite`,
  `vendor/prinny-channel`, `vendor/rtk-pi`. `.pi/extensions/compaction-guard`
  has none; §7 above and its own header comments are its only account.
- pi's own source, for this pass:
  `core/agent-session.js:792` (`prompt`, and the compaction refusal at `:807`),
  `:1068` (`sendCustomMessage`, and `_runAgentPrompt` at `:1090`),
  `:744` (`_runAgentPrompt`, which checks nothing),
  `:1168` (`abort`, which ends in `waitForIdle` — why the session is idle for the
  whole of a compaction),
  `:1367` (`compact`, and the message-array replacement at `:1434`),
  `:1911` (the `ctx.compact` wrapper and its callback guarantee),
  `:2542` (`getContextUsage`, which returns undefined on a zero window),
  `:372`/`:378` (where a message is persisted — at `message_end`),
  `core/session-manager.js:198` (`buildContextEntries` — what survives a
  compaction),
  `core/exec.js` (`execCommand`, which never rejects and does `code ?? 0`),
  `core/extensions/runner.js:579` (`emit` — load order, sequential, awaited),
  `:649` (`emitToolResult` — one object, fields merged),
  `pi-agent-core/dist/agent.js:226` (`Agent.prompt`) and `:283`
  (`createContextSnapshot` — the `.slice()` that makes a run immune to the
  compaction it is running inside),
  `pi-agent-core/dist/agent-loop.js:43` (`runAgentLoop`, and the inner/outer
  while at `:76`/`:160`),
  `modes/print-mode.js:29` (`disposeRuntime` — why an un-unref'd widget timer
  does not hang a headless run).
