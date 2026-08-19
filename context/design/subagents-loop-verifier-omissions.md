# Subagents, the loop, and the verifier — the thing that was not done

Fifteenth pass, 2026-08-19. A full read of the whole stack — the loop, subagents,
the verifier, and the three extensions under and beside them — asking a question
the previous fourteen did not.

The fourteenth pass asked about the machine's account of **itself**: *name the
flag, name the fact it stands for, and name what can make the fact false without
the flag hearing about it.* That produced §2 of `…-claims.md`, the claim ledger,
and seven findings.

This one asks about the places the machine decides **not to act**:

> **Name the guard that declines. Then name what it was holding when it declined
> — an answer, a message, a steer, a directive, a record — and say who owns that
> thing afterwards.**

Every refusal in this stack is correct. `forwardToMatrix` must not guess which of
two people an answer belongs to; `AgentManager.clear()` must not dispose the
session a repair is running in; the loop must not schedule a second turn when one
is already coming; `AgentStatus` must not put fifty agents into a 32k window.
None of those decisions is wrong, and this pass does not reverse one of them.

What it found is that a refusal is only half a decision. The other half is what
happens to the thing that was refused, and six times the answer was: nothing, and
nobody was told.

```
   AF1  `forwardToMatrix` refuses to send when two rooms are live, because
        with two there is no way to tell whose answer it is. `forwardResult`
        then retires every live room — so both questions were deleted along
        with the evidence that they had ever been asked, neither sender was
        told, and the undelivered sweep could not report it because the
        entries were gone. Two people, two questions, zero
        answers.                                                HIGH · FIXED

   AF2  `abort()`, `clear()` and `steer()` each answer with a boolean, and
        each `false` is a deliberate refusal — Y1's, T5's, or a full
        concurrency slot. Five of the six call sites discarded it and
        reported the action as done: "Cleared 1a2b3c4d" about a record that
        is still there, "Cleared 7 finished agent(s)" counted from a
        snapshot taken before the menu opened, and the conversation viewer's
        steer, which said nothing at all.                     MEDIUM · FIXED

   AF3  Five exits of the loop's `agent_end` charge the whole ladder — the
        signal counts, the intervention count, the operator's notice, and
        for `audit` the reset of the window that lets it fire again — and
        then dropped the directive they were charged for, because
        `hasPendingMessages()` said a turn was already coming. V4 found
        exactly this on the sixth exit and fixed it there.    MEDIUM · FIXED

   AF4  `AgentStatus` keeps "the most recent few" settled agents with
        `settled.slice(-limit)`, under a comment saying the caller hands
        them over in spawn order. `AgentManager.listAgents()` sorts them
        NEWEST FIRST. So the tool listed the six oldest agents of the
        session and reported the batch the model had just launched as
        "(+N older, see /agents)".                            MEDIUM · FIXED

   AF5  The brief grows at the TAIL — `appendFollowUp` puts every steer
        there — and its two readers cut it at the HEAD. So on an original
        brief of 1,500 characters or more, the judge was shown a task the
        answer was not answering and said NOT_ADDRESSED, correctly, about
        the question it was given; and the compaction anchor restated the
        half the child still had.                             MEDIUM · FIXED

   AF6  `compaction-guard`'s output cap began `if (event.isError) return` —
        "an error is short and is the one thing worth reading in full". pi's
        bash tool throws the WHOLE formatted output on a non-zero exit, up
        to its own 50 KB bound, and that becomes the error result's only
        text block. So the cap exempted up to ~12,500 tokens of a 32,768
        token window, on the most common path there is: a `/loop` running a
        test suite that is still failing.                       HIGH · FIXED
```

Two of the six are a previous pass's own reasoning one step out (AF3 is V4's
argument at the five sites it named but did not visit; AF2 is the rule the
`/agents` menu's own Steer has always followed). Two are a bound that keeps the
wrong end (AF4, AF5). Two are a refusal with no second owner (AF1, AF6). §14 is
about why that keeps happening.

```
                                    before    after
vendor/pi-loop-mode        tests    199       218
vendor/pi-subagents-lite   tests    289       329     lint 91/91 files
vendor/prinny-channel      tests    357       377     lint clean
.pi/extensions/compaction-guard      41        47
vendor/rtk-pi              tests     20        20
                                   ─────     ─────
                                    906       991
probes                                62        67
```

**Three open items were closed after the six findings** — §11.12 (the fourteenth
pass's own homework), §11.1 (the one refusal this pass found and recorded), and
the judge's raw reply, which had been #1 on the *still unwatched* list since the
fourth pass. §10.6–§10.8 are the accounts; the counts above include them.

---

## 0. How this sits next to the other fourteen

Read `…-claims.md` first if you are new: its §1 is the machine and its §2 is the
claim ledger. This document is a fifteenth pass over the same machine along a
different axis, and it is self-contained — §1 to §8 below are a full account of
the stack, not a diff against the fourteenth pass.

```
   1st   …-anatomy.md      B1–B8    what each piece is for, and why
   2nd   …-evaluation.md   F1–F11   two correct functions disagreeing at a seam
   3rd   …-mechanics.md    T1–T9    pi's own agent loop, still the best account
   4th   …-surfaces.md     S1–S10   the declaration and the code
   5th   …-units.md        U1–U9    the rule and the thing it governs
   6th   …-shapes.md       V1–V8    the whole and the part
   7th   …-readers.md      W1–W6    a fix and the sites next to it
   8th   …-turns.md        X1–X5,Y1 the harness as a claim about the host
   9th   …-answers.md      Z1–Z4    the call, the argument, and where it lands
  10th   …-hosts.md        AA1–AA4  which events reach us; what an answer CAN say
  11th   …-signals.md      AB1–AB4  when it can say it, and how long it stays true
  12th   …-deliveries.md   AC1–AC5  who receives it, and what they see when nobody does
  13th   …-controls.md     AD1–AD7  who OBEYS it, and what happens to the instruction
  14th   …-claims.md       AE1–AE7  the FLAG and the fact it stands for
  15th   THIS ONE          AF1–AF6  the thing that was NOT done, and who holds it
```

The twelfth pass (AC1–AC5) is the nearest neighbour and it is worth saying how
this differs, because at a glance they are the same question. **AC asked about a
send that HAPPENED**: something was produced for somebody, the call was made, and
nobody checked that anybody got it. This one is about the call that was
deliberately *not* made. AC1's background result was sent into a `ReferenceError`;
AF1's answer was never sent at all, for a good reason, and the good reason is
still in the code. The failure is not in the refusal — it is that a refusal ends
a code path, and the object it was about goes out of scope with it.

The seventh pass (W1–W6) is the other neighbour, for AF2 and AF3: *the rule was
established and applied to the instance in front of it.* Both of those findings
have a working counter-example sitting beside the broken sites — the menu's own
Steer reads the boolean, `interveneStuck` queues its directive — which is what
makes them findable at all.

---

## 1. The whole machine

Everything in this document is a zoom into this drawing. It is the fourteenth
pass's §1 with the refusal axis added: every place the stack **declines to act**
is marked `✋`, and every one that a finding here showed dropping what it declined
is marked `✋✘`. The two entry points, the three nested units of a turn, the five
extensions and the event bus are unchanged and still exact.

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
  A.  THE TWO ENTRY POINTS — and only one of them is a "prompt"
 ══════════════════════════════════════════════════════════════════════════════

  ┌─ AgentSession.prompt(text, opts)                    agent-session.js:792 ──┐
  │   reached by:  a HUMAN typing · a subagent's own runner ·                  │
  │                pi.sendUserMessage()  ← prinny-channel's ONLY route         │
  │                                                                            │
  │   /command? ─▶ _tryExecuteExtensionCommand ─▶ RETURN. no turn.     :800    │
  │       ▲ EXTENSION commands only. pi's BUILT-INS (/compact, /model, /new)   │
  │         are executed by the TUI's own input handler.               [AC5]   │
  │   compacting? ─▶ THROW "Cannot submit a prompt while…"        ✋     :808   │
  │       ▲ a refusal an extension cannot see: the rejection goes to pi's      │
  │         own `.catch` → emitError → no listeners headless.      [AB2][AE4]  │
  │   streaming?  ─▶ streamingBehavior ?? THROW                         :833   │
  │                  followUp ─▶ _queueFollowUp  → _followUpMessages           │
  │                  steer    ─▶ _queueSteer     → _steeringMessages           │
  │                  ◆ THE ONLY TWO ARRAYS hasPendingMessages() SEES    [AA3]  │
  │   idle:                                                                    │
  │       no model / no auth  ─▶ THROW                        ✋      :848/:855 │
  │       _checkCompaction(lastAssistant, false)                        :865   │
  │       messages = [ user(text), ..._pendingNextTurnMessages ]        :880   │
  │       ┏━ emitBeforeAgentStart(text, images, base, opts) ━━━━━━┓     :885   │
  │       ┃   result.messages   → appended as role:"custom"       ┃     :889   │
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
  │   triggerTurn (idle)   ─▶ await _runAgentPrompt(msg)                :1090 │
  │                             ▲ NO emitBeforeAgentStart            [AA1]    │
  │                             ▲ deliverAs DISCARDED                [AA4]    │
  │   RETURNS void. Every failure is pi's `.catch` → emitError → a listener   │
  │   set that is EMPTY outside a TUI.                    [AB2][AC1][AE4]     │
  └───────────────────────────────────────────────────────────────────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  B.  WHAT A "TURN" IS — three nested units, and the loop names the middle one
 ══════════════════════════════════════════════════════════════════════════════

  _runAgentPrompt(messages)                                           :744
    ◆ _isAgentRunActive = true      ── isStreaming === !isIdle
    │
    ├── agent RUN #1   runAgentLoop              pi-agent-core/agent-loop.js:43
    │     agent_start · turn_start
    │     for (prompt of prompts) message_start / message_end   :52  ← markLive
    │     ┌── INNER while (hasMoreToolCalls || pendingMessages.length)
    │     │     drain steering → message_start / message_end        :98
    │     │     streamAssistantResponse → message_update… message_end   :253
    │     │     executeToolCalls
    │     │       ┏━ prepareToolCall ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ :393
    │     │       ┃  validatedArgs = validateToolArguments(tool,call)┃
    │     │       ┃  beforeToolCall({ args: validatedArgs })         ┃ :405
    │     │       ┃    `event.input` IS validatedArgs, BY REFERENCE  ┃
    │     │       ┃    handlers MUTATE it; only `block` is read back ┃
    │     │       ┃  block:true ─▶ createErrorToolResult(reason) ✋   ┃ :419
    │     │       ┃  …then tool.execute(id, prepared.args, …)        ┃ :452
    │     │       ┗━ prinny's permission relay, then rtk's rewrite ━━┛
    │     │       execute THROWS ─▶ createErrorToolResult(err.message)  :472
    │     │            ▲ the whole thrown text becomes ONE text block,
    │     │              isError:true — which is AF6's premise
    │     │       → afterToolCall → emitToolResult                     :551
    │     │         ┗━ ONE shared event object; each returned field merged
    │     │            loop fingerprints RAW · guard caps after it   ✋✘ AF6
    │     │     turn_end
    │     └── pendingMessages = getSteeringMessages()
    │     OUTER while: getFollowUpMessages() → back into the inner loop
    │            ▲ so a message queued DURING a run is consumed BY that run,
    │              which is how one run comes to owe TWO rooms      ✋✘ AF1
    │     agent_end { messages: newMessages }   ← THE LOOP'S "ITERATION"
    │
    ├── _handlePostAgentRun()                                          :756
    │     _prepareRetry? _checkCompaction(msg)? agent.hasQueuedMessages()?
    │       any true ─▶ agent.continue()                       agent.js:234
    │
    └── finally
          _systemPromptOverride = undefined  ← and NOTHING restores    :753
          _flushPendingBashMessages()
          _emitAgentSettled()
            ◆ _isAgentRunActive = false   ← BEFORE the handlers run     :328
            emit agent_settled            ← so ctx.isIdle() is TRUE here

  MESSAGE  one assistant reply.
  TURN     one message plus its tool results (pi's `turn_end`).
  RUN      agent_start … agent_end.  `pi-loop-mode` counts this as one iteration.
  PROMPT   one prompt()/sendCustomMessage — possibly several RUNs.

 ══════════════════════════════════════════════════════════════════════════════
  C.  THE FIVE EXTENSIONS, in load order, and what each one declines to do
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
  │               │               │               │               │               │
  │ ✋ !active     │ ✋ isError ✘AF6│ ✋ clear() on  │ ✋ 2 live      │ ✋ not on the  │
  │   (13×)       │ ✋ fits the    │   a verifying │   rooms ✘ AF1 │   allow-list  │
  │ ✋ pending     │   allowance   │   record ✘AF2 │ ✋ not live    │ ✋ rtk absent  │
  │   messages ✘  │ ✋ a budget    │ ✋ abort() on  │ ✋ already     │ ✋ wedged      │
  │   AF3         │   line is     │   a settled   │   sent        │   (AB3)       │
  │ ✋ runToken    │   already     │   one ✘ AF2   │ ✋ a refused   │   — and every │
  │   moved       │   present     │ ✋ steer() no  │   /command    │   one FAILS   │
  │ ✋ soft stop   │               │   slot ✘ AF2  │ ✋ channel     │   OPEN        │
  │   pending     │               │ ✋ the bound   │   down        │               │
  │               │               │   ✘ AF4       │               │               │
  │ AA1 AA2 AA3   │ §6, spill     │ AA4 Y1 Z1 Z2  │ W1 AB2        │ §8, AB3       │
  │ X1–X5 Z3 Z4   │ bound         │ AB4 AC1       │ AC4 AC5       │               │
  │ AB1 AC2 AC3   │               │ AD1 AD2       │ AD3–AD5 AD7   │               │
  │ AD6 AE1       │               │ AE5 AE6       │ AE2–AE4 AE7   │               │
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

   FOUR orderings decide behaviour:

   context        loop FIRST, appends `loop-context-budget`; the guard sees the
                  `-context-budget` suffix and stands down. Both sides check.  ✔
   tool_result    loop FIRST, fingerprints the RAW output into the stuck
                  window; the guard's cap runs after — and until AF6 the cap
                  stood down for every `isError` result, which on this stack
                  is every failing command.                                  ✘→✔
   tool_call      prinny FIRST, rtk SECOND — NOT symmetric, because a
                  `{block:true}` returns from `emitToolCall` immediately.      ✔
   agent_settled  loop FIRST (it may request an emergency compaction), prinny
                  SECOND (it may forward, continue, and compact). Nothing
                  coordinates them, and both can call `ctx.compact()`. AE2 is
                  prinny's own half; the cross-extension half is §11.12.       ⚠

   NOTE, unchanged from AD6: the `tool_call` row is the ONLY place a shell
   command can be reviewed. `pi.exec` — which the loop's goal check and rtk's
   version probe both use — is `execCommand` directly and emits nothing here.

 ══════════════════════════════════════════════════════════════════════════════
  E.  A DELEGATION, WITH EVERY REFUSAL MARKED
 ══════════════════════════════════════════════════════════════════════════════

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │   module-global state, shared by every session in this PROCESS:          │
   │     pi-loop-mode   state:LoopState · runToken · pendingTimer · 3 buffers │
   │     pi-subagents   shell{pi,sessionCtx,manager,widget,store,coordinator} │
   │     prinny         child · awaitingReply · typingRooms · deliveryTimer   │
   │                    pendingCompaction · agentRunning · lastAssistantText  │
   │                    unattributableThisRun                        ← AF1    │
   │     rtk-pi         (none — the gate is pure)                             │
   │     compaction-gd  spillDir (a mkdtemp, first use, bounded at 50)        │
   │     shell.ts       __PI_SUBAGENT_SPAWN_DEPTH__ on globalThis             │
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent(prompt, agent:"Explore", run_in_background?)
                  │
   ┏━━━━━━━━━━━━━━▼━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  tool_call — where the instructions are attached                        ┃
   ┃    prinny  needsApproval(toolName, input, settings) → block? ✋ REPORTED ┃
   ┃    rtk     bash only; rewrites event.input.command in place             ┃
   ┃            ✋ not allow-listed · ✋ rtk missing · ✋ rewrite threw —      ┃
   ┃              all three FAIL OPEN, which is the whole design             ┃
   ┃    subag   toolCallListener:                                            ┃
   ┃              canonical = resolveType(input.agent)          ← AE6        ┃
   ┃              ✋ unresolvable → inject NOTHING, and say so with the      ┃
   ┃                absence of the stamp                                     ┃
   ┃              input._resolvedAgent = canonical                           ┃
   ┃              input.model    = resolveSpawnModel(canonical, ctx)         ┃
   ┃              input.thinking = resolveSpawnThinking(canonical)           ┃
   ┗━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                  │ the SAME object reaches execute()
   ┌──────────────▼────────┐    ┌─────────────────────────────────────────────┐
   │ executeAgentTool      │    │ AgentManager                                │
   │  worktree · type      │───▶│  SlotTable(1) · queue · Watchdog 45min      │
   │  ✋ ambiguous → error  │    │  parent signal: `.aborted` checked ✔ :328   │
   │  ✋ not found → error  │    │  ✋ slot full → QUEUED (not refused)         │
   │  ✋ hidden    → error  │    │  stopAgent(running)   = abortCtrl.abort()   │
   │     (all three are     │    │  stopAgent(verifying) = verifyAbort.abort() │
   │      MODEL-facing and  │    │  ✋ neither          = false ✘ AF2          │
   │      say so)           │    │  clear(verifying)    = false ✘ AF2          │
   └───────────────────────┘    └────────────────┬────────────────────────────┘
                                                 │ runAgent()
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  THE BUILD WINDOW — seconds, and until AB4 nothing was listening         ┃
   ┃    enterSubagentSpawn()   depth > 0                                      ┃
   ┃    reloadAndMap()         EVERY extension factory runs again —           ┃
   ┃                           and rtk's shells out to `rtk --version` [AB3]  ┃
   ┃    createAgentSession()   → onSessionCreated  (the capture, W6)          ┃
   ┃    bindExtensions()       child session_start                            ┃
   ┃    resolveVisibleTools → setActiveToolsByName                            ┃
   ┃    exitSubagentSpawn()                                                   ┃
   ┃    runTurnLoop: if (signal.aborted) throw ABORTED_BEFORE_START    [AB4]  ┃
   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                                 ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the CHILD's AgentSession — in-process, in-memory SessionManager         │
   │    own system prompt · own tools · own window · own event bus            │
   │    model := options.model ?? findModelInRegistry(agentConfig?.model,…)   │
   │    ceiling maxTurns → wrap-up steer → hard abort graceTurns later        │
   │    onCompaction ✋ only into a live run (Z2) — and the anchor it sends    │
   │      is the brief cut from the HEAD                             ✘ AF5    │
   └──────────────────────────┬───────────────────────────────────────────────┘
                              │ settles — status TERMINAL, SLOT STILL HELD
                              ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                       │
   │    SUBAGENT_VERIFY / _ROUNDS / _TIMEOUT_MS all read HERE, together       │
   │    ✋ SUBAGENT_VERIFY=0 · ✋ the record IS the verifier · ✋ empty answer  │
   │    ✋ cut off · ✋ no brief   — four free refusals, each with its own     │
   │       badge, and every one of them REPORTED in record.verification       │
   │    → judge (fresh __verifier session, 1 turn, shown briefForCheck())     │
   │    → repair (the child's own session, 1 turn, shown the WHOLE brief)     │
   │    → judge again → …                                            ✘ AF5    │
   │    rewrites record.result IN PLACE, so every reader sees one answer      │
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
   │        ▼               │    │        ✋ disposed · ✋ no pi · ✋ no      │
   │  formatResultContent   │    │           record  — §11.1                │
   │        │               │    │        capBackgroundResult(ctx …)   AC1  │
   │        ▼               │    │        pi.sendMessage({subagent-result}, │
   │  the Agent TOOL RESULT │    │                       followUp, trigger) │
   │  → compaction-guard's  │    │             │                            │
   │    tool_result cap     │    │             ▼                            │
   │  → THE PARENT MODEL    │    │  entry point 2 — and a `void` return, so │
   └────────────────────────┘    │  a failure here is a `catch` nobody reads │
                                 └──────────────────────────────────────────┘

 ══════════════════════════════════════════════════════════════════════════════
  F.  A MATRIX EXCHANGE — the only path with a second human on it
 ══════════════════════════════════════════════════════════════════════════════

    Matrix room                    sidecar (child proc, MCP over stdio)
        │  message                        │
        └────────────────────────────────▶│ notifications/claude/channel
                                          ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ prinny-channel · deliverInbound                                        │
   │   classifyMatrixCommand(body)  — a leading "/" is decided HERE, and    │
   │     FIRST, because the entry depends on the answer            ← AE3    │
   │   awaitingReply.set(room, mergeAwaiting(previous, arrival))            │
   │        live      evidence about the ROOM, never taken back down        │
   │        answered  something has been sent for this message              │
   │        injected  exactly what pi was handed — markLive matches it      │
   │   armDeliverySweep()                                             AB2   │
   │        ├─ refuse ✋▶ reply(reason)              answered = true   AC4   │
   │        ├─ local  ─▶ THIS extension performs it  answered = true  AC5   │
   │        │            /compact → planCompaction(hasSession, agentRunning)│
   │        │              busy ✋▶ DEFER to agent_settled          ← AD3    │
   │        │              idle → uiCtx.compact({onComplete,onError})       │
   │        ├─ run    ─▶ sendUserMessage(text, {expandPromptTemplates:true})│
   │        │            the receipt says HANDED, not RAN         ← AD4     │
   │        └─ text   ─▶ sendUserMessage(text, {deliverAs})                 │
   └────────────────────────────────────────────────────────────────────────┘
        │
        │ pi echoes the user message back
        ▼
   message_end{role:"user"} ─▶ markLive(text) ── matched on the whole injected
        │                       string. ✋ no match → NOTHING, and the sweep is
        │                       what owns that silence                  AB2
        ▼
   agent_start ─▶ agentRunning = true ─▶ typing, refreshed every 8s
        ▼
   message_end{assistant} ─▶ forward:"all" → each message as it finishes
   agent_end               ─▶ lastAssistantText · lastRunEmptyEnding   W1 AE7
        ▼
   agent_settled           ─▶ agentRunning = false · stopTyping
                              forwardResult()  ─────────────┐
                                 forwardToMatrix(text)      │
                                   ✋ nothing to send        │
                                   ✋ no live room           │
                                   ✋ TWO live rooms ✘ AF1 ──┼─▶ now REMEMBERED
                                   ✋ already sent           │   and both rooms
                                   ✋ channel down           │   are told
                                 empty ending → a bounded   │
                                   CONTINUATION, and the    │
                                   room stands DOWN  ← AE4  │
                                 ✋ retries spent → giveUp,  │
                                   and that COUNTS as an    │
                                   answer now       ← AF1   │
                                 tell every live room that  │
                                   got nothing      ← AF1   │
                                 retire live rooms          │
                                 alreadySent.clear()        │
                                 sweepUndelivered()   AB2 AC4
                                                             │
                              standAside(pendingCompaction, ─┘
                                         continuationStarted)   ← AE2
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, a Matrix answer and the parent's next call are five things in one
queue. Every finding in this pass is something that was *not* put into that
queue, for a good reason, and then not accounted for anywhere else.

---

## 2. The refusal ledger

This is the pass's mechanical contribution and the thing that found AF1, AF2 and
AF4. For every place this stack **declines to act**: what it was holding when it
declined, and who owns that thing afterwards.

Legend: ✔ somebody owns it · ⚠ owned, by decision, only by a log line ·
✘ nobody owns it.

```
 refusal                    what it was holding      who owns it after     ?
 ══════════════════════════════════════════════════════════════════════════════
 THE LOOP
 ──────────────────────────────────────────────────────────────────────────────
 !state.active (13×)        the whole event          nobody, and that is
                                                     the point — the loop
                                                     is not running        ✔
 hasPendingMessages()       the DIRECTIVE the        the pending turn —
   at 6 exits of agent_end  ladder was charged for   which carries no
                                                     directive at all   ✘ AF3
   V4 fixed the seventh (interveneStuck) in the sixth pass, with the argument
   that names the rule: the loop only needs A TURN for `continue`, and needs
   THIS TEXT for everything else.                                       → ✔
 softStopRequested          the scheduled turn       finalizeSoftStop at
   in sendLoopTurn                                   the next agent_end    ✔
 token !== runToken         a stale continuation     nothing, deliberately:
   in every timer/callback                           that is what the token
                                                     is for                ✔
 branchEndsInCompaction     the emergency compaction finishContextRecovery,
                                                     which adopts pi's     ✔
 !ctx.hasPendingMessages    the "continue" turn      the pending turn, and
   at the two `continue`                             any turn advances an
   exits                                             endless loop          ✔

 ──────────────────────────────────────────────────────────────────────────────
 SUBAGENTS
 ──────────────────────────────────────────────────────────────────────────────
 resolveType ambiguous      the spawn                the MODEL, by an
 resolveType not-found      the spawn                errorResult naming
 agentConfig.hidden         the spawn                the candidates        ✔
 canonicalAgentType         the model/thinking       executeAgentTool, which
   returns undefined        injection                re-resolves after the
                                                     discovery scan  ← AE6 ✔
 slot.running >= limit      the spawn                the QUEUE, and
   at spawn                                          drainQueue            ✔
 slot.running >= limit      the CONTINUATION         the caller's boolean
   in continueSettledAgent                           — discarded by the
                                                     viewer          ✘ AF2 → ✔
 !record.execution.settled  the continuation         the same boolean ✘ AF2 → ✔
 session.isStreaming        the continuation         the same boolean ✘ AF2 → ✔
 stopAgent → false          the operator's Stop      the same boolean ✘ AF2 → ✔
 clear → false (Y1)         the operator's Clear     the same boolean ✘ AF2 → ✔
 settled.slice(-limit)      the SIX NEWEST settled   nobody: they were
   in selectAgentsToList    records                  elided and called
                                                     "older"         ✘ AF4 → ✔
 MAX_SETTLED_LISTED         the older settled        `/agents`, and the
   (the bound itself)       records                  count says so         ✔
 emitIndividualNudge        the background result    nobody — §11.1        ⚠
   !record / !pi / disposed

 ──────────────────────────────────────────────────────────────────────────────
 THE VERIFIER
 ──────────────────────────────────────────────────────────────────────────────
 SUBAGENT_VERIFY = 0        the check                record.verification is
 record IS the verifier     the check                absent, which every
                                                     reader reads as
                                                     "never checked"       ✔
 structural gate: empty     the answer               the note REPLACES the
                                                     answer                ✔
 structural gate: cutoff    the judge call           the status note, and
 structural gate: error     the judge call           a distinct badge      ✔
 no brief                   the judge call           `skipped-nobrief`,
                                                     which exists to make a
                                                     spawn-path fault
                                                     visible               ✔
 truncate(brief, 1500)      the FOLLOW-UPS —         nobody: the judge is
   in buildJudgePrompt      every steer ever given   shown a task the
   and buildAnchorMessage   to the child             answer is not
                                                     answering       ✘ AF5 → ✔
 attempts >= rounds         the repair               the "failed" note, and
                                                     the ORIGINAL answer   ✔
 repaired === candidate     the next round           the "stalled" note    ✔

 ──────────────────────────────────────────────────────────────────────────────
 prinny-channel
 ──────────────────────────────────────────────────────────────────────────────
 rooms.length === 0         the answer               nothing is owed       ✔
 rooms.length > 1           THE ANSWER, and both     nobody: the refusal is
                            QUESTIONS                right and the
                                                     retirement deleted the
                                                     evidence        ✘ AF1 → ✔
 alreadySent.has            the duplicate            the first copy        ✔
 !child?.running            the answer               the log, and now the
                                                     retirement notice     ⚠
 !entry.live                the answer               the room is not owed
   (the markLive gate)                               one yet — and if pi
                                                     never takes it, the
                                                     sweep                 ✔
 blockMatches with no       the "is this live"       the sweep: a room that
   `injected`               decision                 never goes live is
                                                     reported              ✔
 planCompaction: busy       the /compact             agent_settled, and the
                                                     sender is told which  ✔
 standAside                 the /compact             the NEXT settlement,
                                                     bounded by
                                                     COMPACTION_DEFER_LIMIT ✔
 undeliveredRooms:          the report                nothing — it is not
   agentRunning                                       time yet             ✔
 forward: "off" and the     the answer               the operator (a
   model never called the                            notice), and now the
   tool                                              sender too      ⚠ → ✔

 ──────────────────────────────────────────────────────────────────────────────
 compaction-guard / rtk-pi
 ──────────────────────────────────────────────────────────────────────────────
 isError                    THE WHOLE OUTPUT of      nobody: it went
   in the tool_result cap   any failing command,     straight into the
                            up to bash's own 50 KB   window        ✘ AF6 → ✔
 total <= allowance         the cap                  it fits; nothing to do ✔
 hasBudgetMessage           the budget notice        pi-loop-mode's, which
                                                     is already there      ✔
 previousSummary absent     the summary cap          nothing to cap        ✔
 spill() threw              the overflow FILE        the marker, which says
                                                     the text is gone      ✔
 !shouldFilter(cmd)         the rewrite              the command runs as
 rtk missing / wedged       the rewrite              written — fail open   ✔
 ══════════════════════════════════════════════════════════════════════════════
```

**Forty-five refusals. Ten of the rows above are marked ✘ — six findings between
them — and one more (`emitIndividualNudge`) is recorded rather than closed.** The
pattern is not "somebody forgot an else branch": in every case the refusal is
right, was written deliberately, and is *documented*. What is missing is a
sentence about the object, and the object is always something a person or a model
is waiting for.

### 2.1 The refusals graph

The same ledger drawn as a graph, because what matters is not the refusal but the
distance between it and the thing it was holding. Read each row as: *who
declines → what it was holding → where that thing went.*

```
                                                        ┌─────────────────────┐
   REFUSAL                   HELD                       │ WHERE IT WENT       │
 ══════════════════════════════════════════════════════════════════════════════
  forwardToMatrix ─────▶ the run's answer, and    ─────▶│ forwardResult's     │
    rooms.length > 1     the two questions still        │ retirement loop,    │  AF1
        │                waiting for it                 │ 8 lines below, in   │
        │                                               │ the same function   │
        ▼                                               └─────────────────────┘
   both rooms are deleted, both senders
   get silence, and the sweep cannot see
   it because the entries are gone
 ──────────────────────────────────────────────────────────────────────────────
  AgentManager ────────▶ the operator's Stop,     ─────▶│ a boolean the       │
    .abort/.clear/.steer  Clear, or typed steer         │ caller did not read │  AF2
        │                                               │ — five call sites   │
        ▼                                               └─────────────────────┘
   "Cleared 1a2b3c4d" about a record that
   is still there; a bulk count from a
   snapshot taken before the menu opened
 ──────────────────────────────────────────────────────────────────────────────
  agent_end ───────────▶ the DIRECTIVE — improve, ────▶ │ the pending turn,   │
    hasPendingMessages()  unblock, check_failed,        │ which is a HUMAN's  │  AF3
        │                 regression, audit             │ message and carries │
        │                                               │ no directive at all │
        ▼                                               └─────────────────────┘
   the ladder is charged, the operator is
   told what the loop is about to say, and
   the model is never told it
 ──────────────────────────────────────────────────────────────────────────────
  selectAgentsToList ──▶ the six agents the       ─────▶│ nowhere. They were  │
    settled.slice(-N)    model just launched            │ counted as "(+N     │  AF4
        │                                               │ older)" and elided  │
        ▼                                               └─────────────────────┘
   the tool answers "what is still
   happening" with the six oldest records
   in the session
 ──────────────────────────────────────────────────────────────────────────────
  buildJudgePrompt ────▶ every follow-up the      ─────▶│ the tail of a       │
    truncate(brief, N)   child was ever steered         │ string cut from the │  AF5
        │                with                           │ head                │
        ▼                                               └─────────────────────┘
   NOT_ADDRESSED, correctly, about the
   question the judge was given — a repair
   round, a re-judge, and "stalled"
 ──────────────────────────────────────────────────────────────────────────────
  the output cap ──────▶ the whole output of any  ─────▶│ the context window, │
    if (isError) return  failing command                │ unbounded, at the   │  AF6
        │                                               │ percentage the cap  │
        ▼                                               │ exists for          │
   the incident the extension was built for  └─────────────────────┘
   again, on the path a /loop takes every
   single iteration
 ══════════════════════════════════════════════════════════════════════════════
```

Three shapes account for all six, and they need different habits:

```
   THE REFUSAL WITH NO         AF1  the answer is dropped and the evidence
   SECOND OWNER                     is deleted in the same function
                              AF6  the exemption is the common case

   THE REFUSAL THE CALLER      AF2  five call sites, one of which reads it
   NEVER HEARS                 AF3  a guard whose "somebody else will do it"
                                    is true of the turn and false of the text

   THE BOUND THAT KEEPS        AF4  slice(-N) over a newest-first array
   THE WRONG END               AF5  a head cut over a tail-grown string
```

### 2.2 The eight surfaces, plus the ninth this pass adds

The series has been accumulating a checklist. It reads, now:

```
   1. what we RETURN from a handler          X5
   2. what we PASS to a call                 Z1–Z4, AA4
   3. which events REACH us at all           AA1
   4. what a host function's answer CAN say  AA2, AB1, AB3
   5. WHEN it can say it, and how long the   AB1–AB4
      answer stays true
   6. WHO RECEIVES IT, and what they see     AC1–AC5
      when nobody does
   7. WHO OBEYS IT — and does the code that  AD1–AD7
      obeys ever see the instruction, and
      what else does obeying it do?
   8. WHAT WE BELIEVE ABOUT OURSELVES —      AE1–AE7
      name the flag, name the fact, and
      name what can make the fact false
      without the flag hearing about it
   9. WHAT WE DECIDED NOT TO DO —            AF1–AF6  ← this pass
      name the guard that declines, name
      what it was holding, and say who
      owns that thing afterwards
```

---

## 3. The loop (`vendor/pi-loop-mode`)

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool, ~3,070 lines. Its whole job is deciding what a turn's outcome *was* and then
getting one sentence to the model about it.

### 3.1 The thirteen handlers, and which entry point each one sees

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

All thirteen begin with `if (!state.active) return;` — the largest refusal in the
stack, and the one with the clearest owner: when the loop is not driving the
session, none of this is its business. AE1 (fourteenth pass) is what happens when
that flag is wrong; this pass is about the smaller refusals below it.

### 3.2 `agent_end` — the ladder, with the six pending-message guards on it

Twenty-one `return;` statements and a fall-through. Every arrow leaving the column
is a `return`. Six of them ended in the same three tokens — `if
(!ctx.hasPendingMessages())` — and that is AF3.

```
 agent_end(event, ctx)
   ├─ !state.active → (preparing? read GOAL_READY from the turn's ANSWER) ──▶ ✗
   ├─ clearPendingTimer() · token := runToken
   ├─ drain the three per-turn buffers into locals, then resetTurnBuffers()
   ├─ age penaltyTurnsRemaining        ← every exit ages it, not just the last
   ├─ read+clear degenerateAbortPending into a local
   ├─ softStopRequested ─▶ finalizeSoftStop  (active = false) ───────────────▶ ✗
   ├─ isContextPressure(...) ─▶ contextRecoveryPending, or a cooldown ───────▶ ✗
   ├─ !lastAssistant || stopReason === "error" ─▶ providerErrorStreak++ ─────▶ ✗
   │     …and at MAX_PROVIDER_ERRORS (10) ─▶ pauseForProviderFailure
   ├─ aborted && degenerateAbortThisTurn ─▶ interveneStuck ──────────────────▶ ✗
   ├─ aborted ─▶ runToken++ · active = FALSE · "paused"          ← AE1's rung ▶ ✗
   │  ─── the success path ───
   ├─ every ladder counter reset · iterationCount++ · turnsWithoutTools
   ├─ committedText := commitTurnMemory(texts, calls, answers)
   ├─ rescueActive ─▶ switch back ─▶ ✋ pending? DROP "continue"  ← still ────▶ ✗
   ├─ stuckReason := detectStuck(committedText, turnEmittedTexts)
   ├─ checkCommand → runGoalCheck → applyCheckOutcome         ← AB1 AC3 AD6
   │     │    ▲ this is the AWAIT that makes AF3 reachable: up to
   │     │      checkTimeoutSeconds (120 s) with the handler suspended and the
   │     │      operator free to type
   │     ├─ execFailed × 3 ─▶ pauseForCheckFailure ─────────────────────────▶ ✗
   │     └─ untilDone && passed ─▶ COMPLETED ──────────────────────────────▶ ✗
   ├─ /LOOP_DONE:/  untilDone && check disagrees
   │                  ─▶ ✋ pending? the `check_failed` directive     ✘ AF3 ─▶ ✗
   │                endless
   │                  ─▶ ✋ pending? the `improve` directive          ✘ AF3 ─▶ ✗
   ├─ /LOOP_BLOCKED:/ ─▶ ✋ pending? the `unblock` directive          ✘ AF3 ─▶ ✗
   ├─ maxIterations (active = false) ───────────────────────────────────────▶ ✗
   ├─ scoreRegressed  ─▶ ✋ pending? the `regression` directive       ✘ AF3 ─▶ ✗
   ├─ stuckReason     ─▶ interveneStuck ─▶ queueOnly when pending   ← V4 ✔ ─▶ ✗
   ├─ 8 iterations, no change
   │                  ─▶ ✋ pending? the `audit` directive            ✘ AF3 ─▶ ✗
   └─ normal continue: ✋ pending? DROP — and that one is right
```

**The five that carry a DIRECTIVE now queue it; the two that carry a "keep
going" still drop it.** That is V4's own distinction, applied where V4 said it
did not apply:

> The guard is right for every OTHER exit of `agent_end`, where the loop only
> needs *a* turn to happen and a pending message will cause one; here the loop
> needs THIS TEXT to reach the model.

The half of that sentence that is true of `continue` is false of `improve`,
`unblock`, `check_failed`, `regression` and `audit`: each of those is the loop's
whole answer to something it has just decided, and each is charged for above the
guard.

### 3.3 The goal check, in full, because AD6 is here and AC3 is one line above it

This is the only mechanism in the loop that consults something outside the model,
and the only place in the whole stack where a shell command runs without passing
a `tool_call`.

```
   agent_end, success path
     │
     └─ state.checkCommand?
          │
          ├─ runGoalCheck(pi)
          │    pi.exec("bash", ["-lc", wrapCheckCommand(cmd)],
          │            { timeout: checkTimeoutSeconds * 1000 })
          │      │        ▲ NOT a tool call. No `tool_call` event, so:
          │      │            · prinny's permission relay never sees it   AD6
          │      │            · rtk-pi's rewrite gate never sees it
          │      │            · compaction-guard's output cap never sees it
          │      │
          │      │   pi's execCommand — no `reject` ANYWHERE in the body
          │      │   spawn error   → resolve({ code: 1, killed })
          │      │   timeout       → SIGTERM → resolve({ code: 0, killed: TRUE })
          │      │   any exit      → resolve({ code: code ?? 0, killed })
          │      ▼
          │    wrapCheckCommand(cmd) =
          │        trap 'printf "\n<MARKER>:%d\n" "$?"' EXIT
          │        ( <the operator's command> )        ← the SUBSHELL is AC3
          │      ▼
          │    ┌─ result.killed        ─▶ execFailed  "did not finish within Ns"
          │    ├─ marker absent        ─▶ execFailed  "died before it finished"
          │    └─ else  ─▶ passed = (result.code === 0), score from /SCORE: n/
          │
          ├─ applyCheckOutcome(state, outcome)
          │     execFailed → checkErrorStreak++ , and the check state is LEFT AT
          │                  ITS LAST REAL VALUE ("passing — LAST KNOWN")
          │     else       → lastCheckPassed · checkFailStreak · score · best
          │
          ├─ execFailed && streak >= 3 ─▶ pauseForCheckFailure
          └─ untilDone && passed       ─▶ COMPLETED
```

The five sentences the mechanism can produce:

| what happened | `killed` | marker | verdict | what the operator is told |
| --- | --- | --- | --- | --- |
| exited 0 | false | present | passed | `Check status: passing` |
| exited non-zero | false | present | failed | `failing (streak N)` + the output, given to the model |
| pi's timeout | **true** | present | could-not-run | `did not finish within Ns and was killed` |
| SIGKILL / OOM | false | **absent** | could-not-run | `died before it finished — killed by a signal` |
| its own EXIT trap, or `exec` | false | present *(since AC3)* | its real answer | as if nothing had happened |
| SIGTERM from outside | false | present | *failed or passed* | **still not distinguishable — §11.7** |

### 3.4 `detectStuck` — eight rules

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

Rule 7 is worth remembering when writing a probe: three turns whose tool results
are byte-identical are "stuck", so a harness that returns the same stub output
every turn will get a stuck verdict instead of whatever it was testing. That cost
one iteration of `s4`.

### 3.5 The escalation ladder and the context ladder

```
  interveneStuck(reason)
    consecutiveStuckCount++ · interventionCount++ · turnsWithoutTools := 0
    penaltyTurnsRemaining := 3   → before_provider_request rewrites the payload
      ├─ rescue    !saturated && rescueModel && streak >= 3
      ├─ compact   saturated || (streak >= 5 && >= 5 iterations since the last)
      └─ strategy  delay = min(60, 2 ** min(streak, 6)) seconds, rotating
                   …and, with a message pending, `queueOnly` — V4, and now the
                   shape the other five exits use through `deliverLoopTurn`

  context ladder
    1. TELL      the `context` handler, >= 60% advisory, >= 80% CRITICAL
    2. BOUND IN  compaction-guard's tool_result cap    §6   ← and AF6 is here
    3. DETECT    agent_end → isContextPressure()
    4. RECOVER   deferred to agent_settled: 2 emergency compactions, then 3
                 cooldowns (60/120/240 s), then pauseForContextFailure
    5. BOUND OUT compaction-guard's summary cap        §6
```

The measurement the whole thing rests on: **below 87% of the window, 3 empty
assistant turns out of 196; at or above 87%, 33 out of 63.** A cliff, not a
gradient — and an empty turn still costs a full iteration. AF6 matters because
rung 2 is the only one that can act on an output nobody predicted, and it was
switched off for the outputs a loop produces most.

### 3.6 The four ways a run restarts

```
                          /loop start   /loop run    /loop resume   session_start
   ───────────────────────────────────────────────────────────────────────────────
   description/criteria    REPLACED     kept         kept           kept
   iterationCount          0            0            kept           kept
   the 3 repetition        cleared      cleared      KEPT           kept
     windows
   consecutiveStuckCount   0            0            0              kept
   providerErrorStreak     0            0            0        ←U    kept
   penaltyTurnsRemaining   0            0            0        ←U    kept
   contextCooldownCount    0            0            KEPT           kept
   lastCheckPassed         undefined    undefined ←V KEPT     ←AC2   kept
   checkErrorStreak        0            0         ←V 0        ←AC2   kept
   ───────────────────────────────────────────────────────────────────────────────
```

The rule the table makes visible: **`resume` may keep anything that describes the
run, and must not keep anything that describes a decision the run has already
acted on.**

---

## 4. Subagents (`vendor/pi-subagents-lite`)

67 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
`/agents` menu, a slot table, a watchdog, a spawn coordinator that owns delivery.

### 4.1 A record's life

```
  tool_call        toolCallListener resolves the CANONICAL type, stamps
    │              `_resolvedAgent`, and writes model + thinking onto the ARGS
    │              (the same object execute() receives — pi passes one)  ← AE6
    ▼
  executeAgentTool worktree · type (+ a DISCOVERY retry) · maxTurns ·
    │              thinking · MODEL — trusting the injection exactly while
    │              the stamp names the type it is about to spawn      ← AE6
    ▼
  spawn()          status queued|running · gate created · brief := prompt
    ▼
  startAgent()     slot reserved · watchdog started · started := true
    ▼
  runAgent()       build window (AB4) → runSessionPrompt → runTurnLoop
    ▼
  .then            status ← classifyRun(result)   TERMINAL FROM HERE
    │              result := responseText                            ← Z1
    │              runVerification()   ← the record's SECOND run
    │                 ▲ status says "completed" for all of it.  ← AD2, AE5
    ▼
  .finally         settlementCount++ · outputLog finalised · slot released
                   tallyCompletion ──▶ notifyComplete ──▶ onComplete
                   drainQueue · gate opened · settled := true
```

The **completion gate** is the invariant worth knowing: every record carries a
promise from birth, opened exactly once, never assigned the run's own promise.
Seven paths open it, so a foreground `Agent` call can never hang on a record that
will not settle. It is also the reason `clear()` must refuse a verifying record:
`removeRecord` opens the gate with `""`, and the parent is still waiting.

### 4.2 The three surfaces an operator acts through, and what each does with a no

This is AF2 drawn out. Every action ends in one of three `AgentManager` methods,
each of which answers with a boolean:

```
                       AgentManager.abort()   .clear()      .steer()
   ───────────────────────────────────────────────────────────────────────────
   returns false when  not running, not      still running  still settling ·
                       queued, not           or verifying   no session ·
                       verifying             (Y1)           streaming ·
                                                            SLOT FULL
   ───────────────────────────────────────────────────────────────────────────
   /agents · one agent  ✘ AF2 → ✔            ✘ AF2 → ✔      ✔ (always has)
   /agents · Stop all   ✘ AF2 → ✔            —              —
   /agents · Clear all  —                    ✘ AF2 → ✔      —
   /agents · Clear done —                    ✘ AF2 → ✔      —
   the conversation     ✔ (no report, but    —              ✘ AF2 → ✔
     VIEWER               Esc is its own)
   the StopAgent TOOL   ✔ AD2                —              —
   ───────────────────────────────────────────────────────────────────────────
```

The three bulk rows had a second defect on top of the first: they iterated
`running` / `finished` / `completed`, which are computed once in
`showRunningAgentsMenu` **before** `ctx.ui.custom` opens the overlay, and then
reported `array.length` as the number of agents acted on. `/agents` is open
exactly while agents are finishing, so that array describes a world several
seconds old. Both halves are closed: the target list is re-derived when the
action is chosen, and the count is of the manager's `true`s.

The sentences live in `src/ui/action-report.ts`, which imports nothing — the same
move as `record-activity.ts`, `status-listing.ts` and `concurrency-slots.ts`,
because `menu-running-agents.ts` and `conversation-viewer.ts` both import
`@earendil-works/pi-tui` and the suite cannot load them.

### 4.3 What a child inherits, in full

```
   the PARENT is started with seven -e flags. A CHILD inherits NONE of them.

   ┌───────────────────────────────────────────────────────────────────────────┐
   │  the child's DefaultResourceLoader                                        │
   │   route A — DISCOVERY               route B — additionalExtensionPaths    │
   │   ~/.pi/agent/extensions/**         subagentExtraExtensionPaths():        │
   │   <cwd>/.pi/extensions/**             vendor/rtk-pi/extensions/index.ts   │
   │     compaction-guard  ✓ wanted        suppressed when the agent declares  │
   │     browser-guard     – harmless      `extensions: false`                 │
   │     stack           ✗ guards itself                                       │
   │   ── withExtensionDenial() runs LAST over BOTH ──────────────────────     │
   │      any path segment matching (?:[a-z0-9._@-]*-)?prinny-channel/ is cut  │
   └───────────────────────────────────────────────────────────────────────────┘

   pi-loop-mode reaches a child by neither route, three times over:
     · not discovered (it lives in vendor/)
     · removed from route B, because its state is module-global
     · its factory returns early when __PI_SUBAGENT_SPAWN_DEPTH__ > 0
```

### 4.4 The concurrency slot, and why it is 1

```
   SlotTable
     precedence: models[key] → providers[provider] → default
     `running` is a FACT; `limit` is CONFIGURATION. setLimits() rebuilds the
     counts from the holders.

   the default is 1, and the reason is measured rather than assumed:
     a subagent having its OWN system prompt does NOT by itself evict the
     parent's cached prefix (99.2% hit across six small child turns).
     What evicts it is SIZE — a child that grew to 18k tokens took the
     parent's next call from 2,117 cached tokens to zero, 442 ms → 2,949 ms.
```

A limit of 1 is also why AF2's steer half matters more here than it would
upstream: `continueSettledAgent` refuses rather than queues, so **any** attempt
to continue a settled agent while another one is running is refused — and that is
the ordinary state of this stack, not a corner of it.

### 4.5 `AgentStatus`, and the bound that kept the wrong end

```
   listAgents()
     [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt)
                                              ▲ NEWEST FIRST
        │
        ▼
   selectAgentsToList(agents, 6)
     unfinished := agents.filter(isBusyRecord)      ← never elided (AE5)
     settled    := the rest
     BEFORE:  keptSettled = settled.slice(-6)       ← the LAST six of a
                                                      newest-first array
                                                      = the six OLDEST
     NOW:     sort by completedAt ?? startedAt, ascending, take the last six
        │
        ▼
   `a4 … a9 (+4 older, see /agents)`  and the elided ones really are older

   measured, ten settled agents a0 (oldest) … a9 (newest):
     BEFORE  a5, a4, a3, a2, a1, a0  (+4 older)
     NOW     a4, a5, a6, a7, a8, a9  (+4 older)
```

The module's own comment named the premise — *"order within each group is the
manager's own (spawn order)"* — which is what makes this a stated assumption
rather than an oversight, and what makes it checkable. It is also why the unit
test could not catch it: the test built its array oldest-first, which is the one
order the caller never uses.

---

## 5. The verifier

### 5.1 Three layers, cheapest first

```
   1. ANCHOR      no model call. After a compaction, restate the brief into the
                  child's freshly-summarised context. Prevention, not detection.
                  Fires only where it rides a turn that was already coming — Z2.
                  ✋ and the brief it restates was cut from the head    ← AF5

   2. STRUCTURAL  no model call. structuralVerdict(answer, lifecycle):
      GATE          "" → skipped-empty, and the note REPLACES the answer
                    status error → skipped-error   (the text is never shown)
                    aborted / turn_limited / stopped → skipped-cutoff
                  This is most of what actually goes wrong, and it is free.
                  Four refusals, four badges, all reported.

   3. JUDGE       one model call, in a fresh __verifier session — no tools, no
                  extensions, no skills, one turn — shown only the brief and the
                  answer. It is harder to fool because it knows less.
                    │
                    ├─ ADDRESSED, attempts 0        → the answer, undecorated
                    ├─ ADDRESSED, attempts > 0      → + "repaired" note
                    ├─ unparsed                     → + "unparsed" note (a PASS)
                    └─ NOT_ADDRESSED
                          attempts >= rounds        → ORIGINAL + "failed" note
                          else → REPAIR (the CHILD's own session, 1 turn)
                                   empty / cut off  → ORIGINAL + "failed"
                                   identical        → ORIGINAL + "stalled"
                                   else             → judge it again
```

### 5.2 The two asymmetries, and both are the design

```
   judge   knows LESS than the child — no transcript, no tools, no history.
   repair  knows MORE — it continues the child's own session, because that is
           the only place with the context to actually fix the answer.

   unparsed counts as ADDRESSED. A judge that answered in a shape nobody asked
   for is evidence about the JUDGE, not about the answer.
```

### 5.3 The brief, and the two ends it is cut at — AF5 drawn out

`brief` is the only thing the verifier checks against, and three readers take it.
It is written once at spawn and then **grown at the tail** on every steer:

```
   appendFollowUp(brief, steer)                              MAX_BRIEF_CHARS 6,000
     ┌──────────────────────────┬──────────────┬──────────────┐
     │ the ORIGINAL task        │ Follow-up: 1 │ Follow-up: 2 │  ← newest LAST
     └──────────────────────────┴──────────────┴──────────────┘
       never dropped              dropped oldest-first when the budget runs out

   its three readers:
     buildRepairPrompt   the WHOLE brief, untruncated — the child is being told
                         the task it may have lost, so nothing is cut
     buildJudgePrompt    truncate(brief, 1,500)   ← a HEAD cut          ✘ AF5
     buildAnchorMessage  truncate(brief, 1,500)   ← a HEAD cut          ✘ AF5

                  ┌──────────────────────────┬── — — — — — — ┬ — — — — — — ┐
   what the       │ the ORIGINAL task        │ … [900 more chars]         │
   judge saw      └──────────────────────────┴── — — — — — — ┴ — — — — — — ┘
                    every steer ever given to the child, gone

   so: the answer addresses follow-up 2, the judge is asked about the original,
   and NOT_ADDRESSED is the correct verdict about the question it was given.
   Then: a repair round (the child is shown the whole brief, answers the same
   thing), a re-judge, and `stalled` — the parent is handed the answer it
   already had, labelled "Treat it as unreliable".
```

`briefForCheck(brief, max)` now applies `appendFollowUp`'s own rule from the other
side: the newest follow-ups first, up to half the budget, the newest never
dropped (only truncated), and the original keeps the rest.

W3 (seventh pass) is the other end of this. It made `growBrief` run on every
branch of `steer()` *so that the judge would check against the accumulated task*.
The accumulation reached the field; the field's readers cut it off.

### 5.4 The flag it hangs on

The verifier has **no carrier of its own** — it rewrites `record.result` in place
— and **no status of its own** either. `lifecycle.status` describes the child's
run and went terminal before the first judge call; `verifyPhase` is the whole of
what says otherwise.

```
   readers of "is this busy" — nine, one question, one answer since AE5
     agent-widget · /agents list · AgentManager.clear · AgentManager.stopAgent ·
     StopAgent tool · formatRunningAgents · AgentStatus tool ·
     conversation viewer Stop · session_shutdown warning
```

### 5.5 What it cannot do

The judge is the same 27B that wrote the answer. It catches a different question
being answered, an empty or evasive summary, and a claim about work that was
plainly not done. It does not catch subtly wrong work.

---

## 6. `compaction-guard`

Three handlers, no tools, no commands, and the only extension a child inherits on
purpose.

```
  1. session_before_compact   cap the summary pi carries forward
       preparation.previousSummary is MUTATED IN PLACE
       returns undefined always — pi keeps ownership of the compaction
       ⚠ LAST TRUTHY WINS on this event: when pi-loop-mode returns a
         {compaction}, pi never reads previousSummary at all.

  2. tool_result              cap ONE tool result against what context is LEFT
       ✋ content not an array / empty        → nothing to cap
       ✋ isError                             → ✘ AF6, and it was the common case
       ✋ total <= allowance                  → it fits
       allowance = f(window - tokens), floor 1,500, ceiling 20,000
       head 70% + marker + tail 30%; overflow spilled to a file the marker
       names; 50 files kept
       ← this is also what bounds a FOREGROUND subagent's answer, for free

  3. context                  show the model its own budget above 60%
       ✋ a `-context-budget` message is already present → stand down
```

### 6.1 AF6 — what `isError` means on this stack

```
   the model runs:  bash "npm test"          (the suite is still red)
        │
        ▼
   pi's bash tool, dist/core/tools/bash.js
        const { text: outputText, details } = formatOutput(snapshot);
        if (exitCode !== 0 && exitCode !== null) {
            throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
        }
        ▲ outputText is the WHOLE captured output, under bash's own bound:
          DEFAULT_MAX_LINES 2,000 · DEFAULT_MAX_BYTES 50 * 1024
        │
        ▼
   pi-agent-core, executePreparedToolCall's catch
        return { result: createErrorToolResult(error.message), isError: true };
        function createErrorToolResult(message) {
            return { content: [{ type: "text", text: message }], details: {} };
        }
        │
        ▼
   the extension `tool_result` hook
        BEFORE:  if (event.isError) return undefined;   ← up to 50 KB, exempt
        NOW:     capped exactly like a success, head + tail, spilled

   measured (probe s3), a 17,738-character failing suite at 84.5% of a 32,768
   token window — within fifty characters of the 17,790-character curl result
   that produced the incident this extension was BUILT for:
        BEFORE  isError: true  → 17,738 chars, untouched
        NOW     isError: true  →  1,970 chars
                isError: false →  1,970 chars   (unchanged, and the control)
```

The old comment — *"an error is short and is the one thing worth reading in
full"* — is true of the errors this extension's author had in mind (`ENOENT`, a
validation message) and false of the one shape that actually dominates an
unattended run. The repair keeps the intent: a short error is still handed over
untouched, because it is under the allowance, and the head-plus-tail cut keeps
both the command's start and the `Command exited with code N` line at the end.

---

## 7. `prinny-channel`

Seven handlers, a `/prinny` command, a `prinny` tool, and a sidecar child process
speaking MCP over stdio. The only path in the stack with a **second human** on it
— and the place where a refusal costs the most, because the person it costs is
not at the keyboard.

### 7.1 The room entry

```
   awaitingReply : Map<roomId, {
        messageId          what to quote-reply
        injected           EXACTLY what pi was handed — markLive matches it
        question           what was asked, for a continuation to restate
        at                 when, for the delivery grace
        live               pi has taken something from this room
        answered           something has been sent for it
        emptyRetries       continuations spent on it
        undeliveredReported
   }>

   ONE entry per room, and that is the design: `forwardToMatrix` refuses to
   send when more than one room is live, because with two there is no way to
   tell whose answer this is. The price of that is TWO rules, and the second
   one is this pass:
     · a second message from the same room is FOLDED IN (mergeAwaiting, AE3)
     · a room retired with nothing sent for it is TOLD so       (AF1)
```

### 7.2 What happens to a message with a leading slash

```
   body
    ├ not a string                                   → text
    ├ does not start with "/"                        → text
    ├ contains a newline                             → text
    ├ /^\/([a-zA-Z][\w-]*)\s*(.*)$/ does not match   → text
    ├ name ∉ KNOWN_COMMANDS                          → text        ← AD5 was here
    ├ name ∈ MATRIX_LOCAL                            → local
    ├ name ∉ MATRIX_ALLOWED                          → refuse
    ├ rest contains a REFUSED_FLAG                   → refuse      ← AD6, AD7
    ├ MATRIX_ALLOWED[name] === null                  → run  (whole command)
    └ first arg ∈ MATRIX_ALLOWED[name]               → run  (else refuse)

   Every one of these is a refusal with an owner: `refuse` replies with the
   reason, `local` performs it and replies, `run` hands it over and says so.
   That is AC4 and AD4, and it is the shape AF1 was missing.
```

### 7.3 `agent_settled`, in order

```
   agent_settled
     │
     ├─ agentRunning = false
     ├─ stopTyping()
     │
     ├─ const started = await forwardResult()
     │    │
     │    ├─ forward:"result" && lastAssistantText → forwardToMatrix
     │    │     ✋ no live room        → nothing is owed
     │    │     ✋ TWO live rooms      → cannot attribute; REMEMBER it   ← AF1
     │    │     ✋ already sent        → the first copy stands
     │    │     ✋ channel down        → logged
     │    │
     │    ├─ lastRunEmptyEnding.empty?
     │    │    ├─ retries left → a CONTINUATION, and the room stands back
     │    │    │                 DOWN until markLive fires for the nudge ← AE4
     │    │    └─ spent        → giveUpMessage to each waiting room,
     │    │                      and that now COUNTS as answered         ← AF1
     │    │
     │    ├─ every LIVE room with nothing sent for it is TOLD           ← AF1
     │    │     ambiguous       "Someone else was being answered in the same
     │    │                      turn and I could not tell which reply was
     │    │                      yours, so I sent nothing rather than send you
     │    │                      theirs. Please ask again."
     │    │     nothing-to-send "That turn finished without anything I could
     │    │                      send you. Nothing is waiting on my side;
     │    │                      please ask again."
     │    │     …and the operator gets a notice, not just a log line
     │    │
     │    ├─ retire every LIVE room (unless a continuation was started)
     │    ├─ alreadySent.clear() · unattributableThisRun = false
     │    ├─ stopTyping() · sweepUndelivered()
     │    └─ return retrying
     │
     └─ standAside(pendingCompaction, started)                          ← AE2
```

### 7.4 The undelivered sweep, and how AF1 sits beside it

```
   an entry is REPORTED as undelivered when, and only when:
     · the session is IDLE                 (agentRunning === false)
     · and `answered` is false             ← AC4: was it ever pi's to take?
     · and `live` is false                 ← AB2: did pi echo it back?
     · and `undeliveredReported` is false
     · and it is older than DELIVERY_GRACE_MS (60 s)

   AF1 is the complement, and the two together cover the whole map:

        live?    answered?    who reports it
        ─────────────────────────────────────────────────────────────
        false    false        the SWEEP, after the grace       AB2
        false    true         nobody — this extension answered it   AC4
        true     true         nobody — the answer went out
        true     false        the RETIREMENT, now               ← AF1
        ─────────────────────────────────────────────────────────────
```

The fourth row was the hole, and it is the one row where pi definitely took the
message: the sender is not merely unanswered, they are unanswered *after the
model was given their question*.

### 7.5 The typing indicator

Matrix expires a typing indicator at 20 s. A 27B thinks for longer than that
between visible tokens, so the indicator is refreshed every 8 s while
`agentRunning` — and cleared in `agent_settled` *before* the answer is forwarded.

---

## 8. `rtk-pi`

One handler, no tools, no commands, 108 lines of coupling over a pure gate — and
the one package in the stack with nothing to find on this axis, because every one
of its refusals **fails open**.

```
   factory        pi.exec("rtk", ["--version"])  ← runs on EVERY spawn (AB3)
                    ✋ killed  → warn, register nothing
                    ✋ code≠0  → warn, register nothing
                    ✋ < 0.23  → warn, register nothing
   tool_call      bash only
                    ✋ RTK_DISABLED=1     → return
                    ✋ !shouldFilter(cmd) → return
                    ✋ rewrite threw      → warn, return
                  else event.input.command = rewritten
```

The thing it declines to do is *change* a command, and the command runs either
way. That is the whole reason it has no row in the ledger's failure column: a
refusal that leaves the world exactly as it found it has nothing to hand on.

Worth stating because it is the counter-example the axis needs: **not every
refusal needs an owner. A refusal needs an owner exactly when something was
already in flight and somebody is waiting for it.**

---

## 9. The findings

### 9.1 AF1 — the answer two rooms were both owed  ·  HIGH · fixed

**What it was.** `forwardToMatrix` refuses to send when more than one room is
live:

```js
   const rooms = [...awaitingReply.entries()].filter(([, e]) => e.live).map(([room]) => room);
   if (rooms.length === 0) return;
   if (rooms.length > 1) {
     log(`forward skipped (${why}): ${rooms.length} rooms are waiting and this text
          cannot be attributed to one of them (${rooms.join(', ')})`);
     return;
   }
```

That is right, and it is the only right answer: with two live rooms there is no
way to tell whose answer this is, and sending one person's conversation to
another is not undoable. The question is what happens next, and next is eight
lines further down the same handler:

```js
   if (!retrying) {
     for (const [room, entry] of awaitingReply) {
       if (entry.live) awaitingReply.delete(room);
     }
   }
```

Both rooms are retired. The entries that proved either question had ever been
asked go with them — which is also why `sweepUndelivered` could not report it:
`undeliveredRooms` reads a map that no longer contains them. **Two people, two
questions, zero answers, zero notices, and one line in `channel.log`.**

**Why it is the ordinary case.** One person in a DM and one in a room is enough.
`deliverInbound` hands each message to pi with `deliverAs: "followUp"`, and pi's
agent loop drains the follow-up queue **inside the same run**:

```js
   // Agent would stop here. Check for follow-up messages.
   const followUpMessages = (await config.getFollowUpMessages?.()) || [];
   if (followUpMessages.length > 0) { pendingMessages = followUpMessages; continue; }
                                        pi-agent-core/dist/agent-loop.js:162
```

so both are echoed back as user messages, `markLive` marks both, one answer
arrives, and it belongs to one of them.

**The tell.** The fourteenth pass looked straight at this behaviour. `r3`'s header
explains that a leftover live room from an earlier scenario suppresses the leak
the next scenario is about, which is why its four modes run one to a process.
That is true, it is the same mechanism, and it was read as a fact about the
probe.

**The fix.** Not a change to the refusal. `forwardToMatrix` records that it
could not attribute the answer (`unattributableThisRun`, cleared with
`alreadySent` at the end of the run), and the retirement — before it deletes
anything — tells every live room that has had nothing sent for it:

```
   unansweredRooms(entries)        live && !answered      ← src/delivery.ts
   unansweredMessage('ambiguous')  "Someone else was being answered in the same
                                    turn and I could not tell which reply was
                                    yours, so I sent nothing rather than send you
                                    theirs. Please ask again."
   unansweredMessage('nothing-to-send')
                                   "That turn finished without anything I could
                                    send you. Nothing is waiting on my side;
                                    please ask again."
```

and the operator gets a `notify`, not just a `log`. The `ambiguous` sentence says
that somebody else was being answered — it is the one thing that explains the
silence, it names nobody, and without it the message reads as a malfunction
rather than as the deliberate refusal it is.

Two smaller repairs fall out of the same rule, both of which make `answered`
mean what it says:

- the give-up message sent when the empty-turn retries are spent now sets
  `answered`, because it *is* something sent for that message — and without it
  the retirement would send a second sentence on top of it;
- the `forward: "off"` branch, which used to notify the operator and tell the
  sender nothing, now goes through the same path.

**The evidence.** `context/testing/probes/s1-the-answer-two-rooms-were-both-owed.mjs`,
three modes, driving the real extension over the real sidecar protocol. Mode
`two-rooms` prints what each sender receives; mode `one-room-nothing-to-send` is
the generic branch; mode `control` is one question and one answer, where nothing
extra may be sent. Nine tests in `vendor/prinny-channel/tests/delivery.test.ts`.

---

### 9.2 AF2 — the operator's action, and the answer nobody read  ·  MEDIUM · fixed

**What it was.** Three `AgentManager` methods answer with a boolean, and every
`false` is a refusal somebody installed on purpose:

```
   abort(id)   false  — not running, not queued, not verifying
   clear(id)   false  — still running, or the answer is still being checked (Y1:
                        removeRecord disposes the session a repair runs IN, and
                        opens the completion gate with "" under a waiting parent)
   steer(id)   false  — still settling · no session · streaming · SLOT FULL
```

Five of the six call sites discarded it:

```js
   } else if (item.value === "stop") {
     getManager()?.abort(record.id, "user");
     ctx.ui.notify(`Stopped ${shortId}`, "info");        // …whether or not it did
   } else if (item.value === "clear") {
     getManager()?.clear(record.id);
     ctx.ui.notify(`Cleared ${shortId}`, "info");        // …about a record still there
   }
```

and the three bulk actions had a second defect on top of the first: they iterated
`running` / `finished` / `completed`, snapshotted in `showRunningAgentsMenu`
*before* the overlay opened, and reported `array.length` as the number acted on.

The sixth call site — the menu's own single-agent Steer — has always read it, and
says "Steer failed for X". That is what makes this a `W`-shaped finding rather
than an oversight: the rule existed, next door.

**Why it is reachable.** `/agents` is open exactly while agents are running and
settling; that is what it is for. A record that finishes between the menu being
drawn and an action being chosen is the ordinary case. And the steer half is
worse than it looks on this fork: `continueSettledAgent` *refuses* rather than
queues when the slot is full, and the default limit is 1 — so any attempt to
continue a settled agent while another one runs is refused, and in the
conversation viewer the operator's typed follow-up simply vanished.

**The fix.** `src/ui/action-report.ts` — a module that imports nothing — turns
each boolean into a sentence, and every call site reads it:

```
   stopReport(false, id)      "1a2b3c4d was already finished — nothing to stop."
   clearReport(false, id, v)  "…is still having its answer checked — it will
                               clear once the check finishes."   (v = verifying)
                              "…is still running — stop it first."
   steerReport(false, id, v)  "Could not continue 1a2b3c4d — it is still
                               settling, or another agent holds the concurrency
                               slot. Nothing was sent; try again in a moment."
   bulkReport("Cleared", 6, 7)
                              "Cleared 6 of 7 agent(s); 1 were still busy and
                               were left alone."
```

The bulk actions re-derive their targets from the manager when the action is
chosen, and count the manager's `true`s. Both viewer callbacks are `async` and
catch their own errors — the viewer calls `this.onSteer?.(msg)` without awaiting
it, and node treats an unhandled rejection as fatal.

**The evidence.** `context/testing/probes/s2-the-six-oldest-agents.mjs`, second
half: the real manager is driven into the two states where each refusal happens
(a verifying record, a settled record) and the sentence is printed beside the
boolean. Nine tests in `vendor/pi-subagents-lite/tests/action-report.test.ts`.

---

### 9.3 AF3 — five directives the ladder was charged for  ·  MEDIUM · fixed

**What it was.** Six exits of `agent_end` ended in the same three tokens:

```js
   if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, KIND, state.delaySeconds * 1000, ctx);
   return;
```

and five of the six carry a DIRECTIVE — the loop's whole answer to something it
has just decided — all of which is charged **above** the guard:

```
   kind          charged before the guard                  what the model is told
   ─────────────────────────────────────────────────────────────────────────────
   improve       doneSignalCount++, status, notice, log    open IMPROVEMENTS.md,
                                                           take the TOP item
   unblock       blockedSignalCount++, notice, log         assume, record it in
                                                           ASSUMPTIONS.md
   check_failed  status, lastNotice, notice, log           the check disagrees
                                                           with your claim
   regression    interventionCount++, notice, log          the score dropped to
                                                           N (best M @ iter K)
   audit         interventionCount++, notice, log,         produce a tangible
                 lastStateChangeIteration := iteration     artefact this turn
                 ▲ which is what stops the same nudge
                   firing for another eight iterations
   ─────────────────────────────────────────────────────────────────────────────
   continue      status, lastNotice, log                   (nothing specific)
```

With a message pending, the operator was told what the loop was about to say, the
counters recorded that it had said it, and the model never heard it.

**Why it is reachable.** `hasPendingMessages()` is true only when a HUMAN typed
into a streaming session — AA3 established that the two arrays it counts are
written by `_queueSteer` / `_queueFollowUp`, which nothing an extension calls
ever reaches. At `agent_end` that means they typed after the agent loop's last
follow-up drain. The window is not narrow on this stack: **`agent_end` awaits the
goal check**, which may run for `checkTimeoutSeconds` — 120 seconds by default —
with the handler suspended and the operator free to type.

**The fix.** One helper, `deliverLoopTurn(pi, ctx, kind, delayMs)`, and the five
directive-carrying exits call it:

```js
   if (!ctx.hasPendingMessages()) { scheduleLoopTurn(pi, kind, delayMs, ctx); return; }
   sendLoopTurn(pi, kind, ctx, { queueOnly: true });   // triggerTurn + deliverAs "steer"
```

`queueOnly` is V4's own mechanism and `"steer"` is Z4's own correction (`nextTurn`
is drained only by `AgentSession.prompt()`, which an unattended loop never
calls): `agent_end` runs while `_isAgentRunActive` is still true, so the message
joins the Agent's steering queue and `Agent.continue()` drains the whole queue as
one prompt — the human's message and the directive on the same turn.

`continue` still drops, deliberately, at both of its exits. Any turn advances an
endless loop, and riding along would put 1,200 characters of loop rules onto a
turn the operator typed for their own reasons.

**The evidence.** `context/testing/probes/s4-the-directive-that-was-never-said.mjs`,
modes `pending` and `idle`, driving the shipped loop module through `_host.mjs`.
Seven tests in `vendor/pi-loop-mode/tests/pending-directives.test.ts`; five of
them fail with the fix removed.

---

### 9.4 AF4 — the six oldest agents  ·  MEDIUM · fixed

**What it was.** `AgentStatus` is bounded: everything unfinished, plus the most
recent few that are finished, with the rest counted as `(+N older, see /agents)`.
The bound was

```js
   const keptSettled = limit > 0 ? settled.slice(-limit) : [];
```

under a comment saying *"order within each group is the manager's own (spawn
order), so the newest settled agents come last, next to the nudge"*. The caller
is

```js
   listAgents(): AgentRecord[] {
     return [...this.agents.values()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt);
   }
```

— newest **first**. So `slice(-6)` kept the six oldest agents of the session and
elided the batch the model had just launched, calling them "older".

```
   ten settled agents, a0 (oldest) … a9 (newest), measured through the real
   manager and the real tool:

     BEFORE  a5 (T5) completed, a4 (T4) completed, a3 (T3) completed,
             a2 (T2) completed, a1 (T1) completed, a0 (T0) completed
             (+4 older, see /agents)
     NOW     a4 (T4) completed, a5 (T5) completed, a6 (T6) completed,
             a7 (T7) completed, a8 (T8) completed, a9 (T9) completed
             (+4 older, see /agents)
```

Both halves are wrong in the BEFORE column: the wrong six are listed, and the
sentence about the other four is false. The reply's own closing line is "Don't
poll — you'll receive notifications when agents complete", so the model has no
reason to look again.

**Why the test could not see it.** It built its array oldest-first, which is the
one order the caller never uses. That is the eighth pass's lesson (a harness is a
claim about the host) at an *internal* boundary: the host here is another method
of the same package.

**The fix.** The module stops trusting an order and reads the field the rule is
about. `ListableAgent` now carries `startedAt` / `completedAt`, and the bound
sorts by `completedAt ?? startedAt` ascending and keeps the tail — so the six
newest survive, oldest-first, with the newest last, next to the nudge.
`completedAt` rather than `startedAt` because the question the tool answers is
"what came back", and a long delegation started first can settle last.

**The evidence.** `context/testing/probes/s2-the-six-oldest-agents.mjs`, first
half. Three new tests in `vendor/pi-subagents-lite/tests/status-listing.test.ts`,
one of which hands the records over in the manager's real order.

---

### 9.5 AF5 — the brief, cut at the end it grows from  ·  MEDIUM · fixed

**What it was.** `brief` is the only thing the verifier checks an answer against.
It is written once at spawn and grown at the tail by `appendFollowUp` on every
steer, up to `MAX_BRIEF_CHARS` (6,000). Its two model-facing readers cut it at
the head, at `JUDGE_BRIEF_CHARS` (1,500):

```js
   buildJudgePrompt:   truncate(brief, JUDGE_BRIEF_CHARS)
   buildAnchorMessage: truncate(brief, JUDGE_BRIEF_CHARS)
```

So with an original brief of 1,500 characters or more, every follow-up ever given
to the child was the first thing dropped — from the check that decides whether
the answer addresses the task, and from the reminder injected after a compaction.

**What it costs.** The judge says NOT_ADDRESSED, correctly, about the question it
was given. That spends a repair round and a re-judge on the one llama slot the
parent is queued behind. `buildRepairPrompt` restates the brief in FULL, so the
child answers the same thing again, `verifyAnswer` sees an identical repair and
returns `stalled` — and the parent is handed the answer it already had, with
"Treat it as unreliable" attached to it.

**The fix.** `briefForCheck(brief, max)` applies `appendFollowUp`'s own rule from
the other side: the newest follow-ups first, up to half the budget, the newest
never dropped (only truncated), and the original keeps whatever is left. A brief
with no follow-ups is cut exactly as it was before, which is the control.

```
   BEFORE   [ original … 1,500 chars ] … [900 more chars]
   NOW      [ original … 750 chars ] … [N more chars]  Follow-up: <the newest>
```

**Why it was invisible.** `MAX_BRIEF_CHARS` is four times `JUDGE_BRIEF_CHARS` and
the comment above it says so — *"generous next to JUDGE_BRIEF_CHARS, because the
judge sees a truncation of this and the repair sees all of it"*. The fact was
known. The unexamined part was **which** truncation, in a string whose newest
content is at the far end from where the cut lands.

**The evidence.** Seven tests in `vendor/pi-subagents-lite/tests/verify.test.ts`;
two fail with the fix removed. It is a pure function on both sides, so there is no
probe: the judge prompt and the anchor message are the whole observable.

---

### 9.6 AF6 — the cap that exempted what it was built for  ·  HIGH · fixed

**What it was.** The output cap's handler began:

```js
   // An error is short and is the one thing worth reading in full.
   if ((event as { isError?: boolean }).isError) return undefined;
```

That is a claim about the host. pi's bash tool formats the whole captured output
— its own bound is 2,000 lines or 50 KB — and then, for a non-zero exit, throws
it:

```js
   const { text: outputText, details } = formatOutput(snapshot);
   if (exitCode !== 0 && exitCode !== null) {
       throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
   }                                              dist/core/tools/bash.js:346-349
```

`executePreparedToolCall` catches that and builds
`createErrorToolResult(error.message)` — one text block, `isError: true`. So on
this stack `isError` does not mean "a short message"; it means "the command
failed", and up to 50 KB (~12,500 tokens, 38% of a 32,768-token window) arrived
exempt from the one mechanism that bounds a tool result.

**Why it is the common case.** The runs this extension exists for are unattended
`/loop`s, and the shape of an unattended loop is: run the suite, read the
failures, fix one, run the suite again. **Every** run of that suite while it is
still failing is an error result. The incident in `src/output-cap.ts`'s own
header — 17,790 characters taking the window from 84.5% to 100% and the next turn
to nothing — would not have been capped had the command exited non-zero.

**The fix.** Delete the exemption. Nothing else changes: `planOutputCap` keeps a
head and a tail, so the failing assertion and the `Command exited with code N`
line both survive, and the full text goes to the spill file the marker names. A
short error is still handed over untouched, because it is under the allowance —
which is what the original comment was actually reaching for.

**The evidence.** `context/testing/probes/s3-the-output-that-was-an-error.mjs`
pins pi's bash source and `createErrorToolResult`, then drives the shipped
handler with a 17,738-character failing suite at 84.5% — within fifty characters
of the original incident — and prints 17,738 → 1,970. Six tests in
`.pi/extensions/compaction-guard/tests/error-output.test.ts`; five fail with the
exemption restored.

---

## 10. Fixed alongside

Five smaller things, each of which is the same rule applied where it was not
load-bearing enough to be a finding on its own.

**10.1 `answered` now means what it says on the give-up path.** When the
empty-turn retries are spent, `forwardResult` sends `giveUpMessage(detail)` to
each waiting room and did not mark the entry. That was harmless while nothing
else read it at that moment; AF1's retirement sweep reads it, and without the
mark it would have sent a second sentence on top of the first.

**10.2 `forward: "off"` tells the sender, not only the operator.** The branch
used to log and `notify` — both operator-facing — about a room that pi had taken
a message from and that got no reply because the model never called the tool.
The sender saw nothing. It now goes through the same retirement notice as
everything else, and the `off`-specific line stays in the log because it names
the cause.

**10.3 The conversation viewer's `onSteer` may be async, and says so.** The type
was `(message: string) => void` and the viewer calls it without awaiting. Both
callers now return a promise, so the type is `void | Promise<void>` and both
bodies are wrapped — an unhandled rejection out of a UI callback is fatal in
node, and this is a callback that now does work.

**10.4 The `status-listing` test's record gained the fields the rule depends
on.** Its helper built `{ id, lifecycle: { status } }`, so every test in the file
expressed recency as array position — which is exactly the assumption the shipped
code made and the one that was false. The helper now carries `startedAt` /
`completedAt` from a rising clock, so tests that build records in order still mean
what they meant, and the tests that are *about* recency say so out loud.

**10.5 A probe lesson, paid for in `s4`.** `detectStuck`'s rule 7 is "the same
TURN tool signature three turns running", so a harness that returns one stub tool
result every turn gets a stuck verdict instead of whatever it was testing —
`s4`'s audit block reported `stuck/steer` where it wanted `audit/steer`. The
probes README carries the note; the shape is X1's, one layer down: **a stub that
repeats itself is an input the module has an opinion about.**

### 10.6 §11.12, closed — two extensions cannot compact the same session at once

The fourteenth pass recorded it (§11.7 of `…-claims.md`), this pass re-recorded it
(§11.12 below), and both stopped at the same place: the fix is *a flag neither
package owns*. It is, and that is not a reason to leave it — `shell.ts` already
publishes `__PI_SUBAGENT_SPAWN_DEPTH__` on `globalThis` for exactly this shape of
problem, with the reasoning written out: **a global read is a smaller wound than a
cross-vendor import**, and node's module cache is why both extensions share a
session in the first place.

```
   globalThis.__PI_COMPACTION_IN_FLIGHT__ = { owner, at } | undefined

   beginCompaction(owner)    false when somebody else holds it
   endCompaction(owner)      releases it, and ONLY if this owner holds it
   compactionInFlight()      the holder, or undefined

   two implementations, one per package, asserted to agree by a test in each
   that imports the other — the arrangement `stateDir()` already has between
   `prinny-channel/src/config.ts` and `server/src/state.ts`
```

What each caller does with a refusal is the part that matters, and neither of them
queues:

```
   pi-loop-mode  requestEmergencyCompaction  ADOPTS it — the same answer it
                   already gives when pi has compacted the branch itself, with
                   `freedRoom: false` so the error streak still escalates
                 interveneStuck's rung       WAITS for it — that rung wants the
                   WINDOW cleared to break a fixation, and somebody else's
                   compaction clears the same window, so the rung is spent and
                   the turn is still scheduled
   prinny        startCompaction             TELLS THE SENDER: "A compaction is
                   already running — I will let that one finish rather than
                   cutting it off." Their request is satisfied by the compaction
                   that is happening; a second one moments later earns only pi's
                   own "Already compacted"
```

The holder carries a timestamp and expires after five minutes. pi's `ctx.compact`
wrapper does guarantee a callback — checked, not assumed:
`try { … onComplete } catch { onError }` at `agent-session.js:1911` — so the bound
is a backstop for the process outliving the session, a future pi that changes that
wrapper, and a caller that forgets to release. A plain boolean would latch for the
rest of the process in each of those, and **a latched lock is worse than the
collision it prevents**: the loop would stand aside for a compaction that is not
happening, forever.

Measured: `context/testing/probes/s5-two-extensions-one-compaction.mjs`, which is
the first probe in the series to drive **two extensions against each other** — it
has to be, because the collision only exists in one process.

### 10.7 The judge's raw reply, kept — #1 on the unwatched list since the fourth pass

Not a defect, and it never produced a symptom. It is the reason four findings
needed a probe before anyone could believe them, and every one of the four is a
statement about a string that lived for a few milliseconds inside `verifyAnswer`
and was then dropped:

```
   S2  a judge that echoed the prompt's own `VERDICT: ADDRESSED or NOT_ADDRESSED`
       menu was read as having CHOSEN NOT_ADDRESSED
   U4  a judge that echoed the `WHY:` instruction had that instruction quoted
       back to the child as the reason its answer was wrong
   V5  a repair hard-aborted mid-token reached the judge as an ordinary answer
   W5  the note the parent reads said "the 2th attempt"
```

`parseJudgeVerdict` is careful and heavily tested — against replies somebody
*imagined* a 27B writing. One JSONL line per model call the verifier makes now
carries the prompt, the raw reply, and **the parse the stack acted on**, because
neither the reply nor the verdict alone can show that the parse was wrong.

```
   ~/.pi/agent/subagent-verify.jsonl      (SUBAGENT_VERIFY_LOG_FILE overrides)
     { ts, phase: "judge"|"repair", agentId, agentType, attempt,
       prompt, reply, parsed: {addressed, unparsed, why}, runStatus, ms }

   bounded    4,000 chars a field · 2,000 lines, newest kept
   off        SUBAGENT_VERIFY_LOG=0
   injected   as `deps.log`, so `verify-runner.ts` still imports nothing and a
              logger that throws costs a log line rather than a verdict
```

It is under the agent directory rather than the working directory, because a
verification is a fact about this install and not about whatever repository the
parent happened to be looping on.

### 10.8 §11.1, closed — the three silent drops of a background result

`emitIndividualNudge`'s three guards — `this.disposed`, `!pi`, `!record` — are
each correct, and each dropped a finished delegation's answer with nothing said
anywhere. The full fix is still a delivery queue that survives a session swap, and
that is still a design decision; **this is not that.** The answer is on the record
either way, so the whole of what was missing was a sentence naming it — which AC1
had already settled the shape of for the `catch` around the send:

> A delivery that did not happen is the loudest thing this class can report; it
> must not be the quietest.

All three guards now report through `console.warn` (which runs headless, where
`noOpUIContext.notify` is `() => {}`) and through the spawning session's own
context, naming the agent, the cause, and the one recovery that always works —
`AgentStatus`. The record is looked up *before* the guards so the notice can say
which agent it was, and the sentences live in `src/spawn/nudge-drop.ts`, which
imports nothing, because `spawn-coordinator.ts` imports pi and the suite cannot
load it.

---

## 11. Still open, and why — decisions, not omissions

**11.1 `emitIndividualNudge`'s three refusals now report — the delivery queue does
not exist. CLOSED IN PART; see §10.8.** The three guards (`this.disposed`, `!pi`,
`!record`) each dropped a background result in silence, and each now says so on a
channel that exists headless. What is still open is the thing that would make the
delivery *happen*: a queue that survives a session swap, so a result produced for
a session that has gone away reaches the next one. That remains a design decision
— and it is now the only part of this that is invisible, because the drop itself
is not.

**11.2 `forwardToMatrix`'s "the channel is not running" refusal** now falls into
AF1's retirement notice — which is also sent over the sidecar. If the channel is
down, neither the answer nor the apology arrives. There is no third route to a
Matrix room, and inventing one (a queue on disk, replayed at reconnect) would
mean answering a question minutes or hours later without knowing whether it still
matters. The entry is retired, and the sender's next message starts a fresh one.

**11.3 A room-less inbound message falls through to the model as text.** Every
command branch in `deliverInbound` is guarded by `&& room`, so a notification with
neither `room_id` nor `chat_id` skips the refuse/local branches and is delivered
as ordinary text — which is exactly what the `refuse` branch exists to prevent.
The sidecar always sets `room_id`; this is a defensive branch reached only by a
protocol change, and the honest response to that would be to refuse the message
outright rather than to route it.

**11.4 The `/agents` spawn wizard is the one spawn path that can hold no
concurrency slot.** `modelKey` is set only when `currentModelStr` is non-empty,
and `resolveModel`'s final fallback is `parentModelId`, which the wizard computes
as `""` when the session has no model at all. A session with no model cannot run
anything, so the path is unreachable; it is stated because "no model key" means
"no slot, no queue, no serialisation" and that is the one property this fork's
`default: 1` exists to guarantee.

**11.5 `continue` still drops when a message is pending**, at both of its exits.
That is the line AF3 draws rather than an oversight: any turn advances an endless
loop, and injecting 1,200 characters of loop rules onto a turn the operator typed
for their own reasons is the other kind of mistake.

**11.6 `answered` is still set on three branches by the act of replying**, not by
evidence that the reply arrived. AD4's residue, unchanged: there is no
observable, and the claim was narrowed instead of guarded.

**11.7 SIGTERM-from-outside on a goal check.** Unchanged from the eleventh pass:
bash runs its `EXIT` trap when SIGTERMed, so the marker is present and `$?` is
whatever the last command left. The marker is proof of *completion*, not of
*intent*.

**11.8 The watchdog still skips a verifying record**, and `Watchdog.check()`
deletes its state rather than merely skipping it. Harmless and deliberate: the
per-call deadline is minutes where the watchdog is 45 of them.

**11.9 A `--check` is a shell channel no `tool_call` handler can see**, from the
loop tool as well as from `/loop`. Closed from Matrix (AD6); left open from the
tool and the terminal, where the caller is already inside the trust boundary.

**11.10 `agentRunning` is false for the width of one `await` chain** — between
`sendUserMessage` being called and `agent_start` firing. The only reader that
would care is `planCompaction`.

**11.11 `parseJudgeVerdict` reads `UNADDRESSED` as ADDRESSED** on the
`VERDICT:`-line path (the prose path is anchored and does not). Recorded in the
twelfth, thirteenth and fourteenth passes.

**11.12 Two extensions calling `ctx.compact()` on the same `agent_settled` —
CLOSED; see §10.6.** `pi-loop-mode`'s handler runs first and may request an
emergency compaction; `prinny-channel`'s runs second and may drain a deferred
one; pi's `compact()` does not refuse a second call — it aborts, overwrites
`_compactionAbortController`, and proceeds. AE2 closed prinny's half in the
fourteenth pass and recorded the cross-extension half as needing "a shared flag
that neither package owns". It needed exactly that, and `shell.ts`'s
`__PI_SUBAGENT_SPAWN_DEPTH__` was already the precedent for how this stack does
it. What is left open, deliberately, is pi's own threshold and overflow
compactions, which no extension requests and therefore none can mark.

**11.13 Still open by decision from earlier passes**, each with a reason in §11 of
`…-controls.md` and §10.4 of `…-deliveries.md`: the Matrix command sweep's blind
spot, the brief-before-session window, `hasStateChange`'s keyword list, T6,
per-session loop state, T1's general case, and resuming a completed run.

---

## 12. What shipped

### The six findings

| # | file | the change | control run |
| --- | --- | --- | --- |
| AF1 | `prinny-channel/src/delivery.ts`, `extensions/index.ts` | `unansweredRooms()` / `unansweredMessage()`, and the retirement tells every live room it sent nothing to | `s1 two-rooms` — BEFORE, neither sender receives anything; 9 tests |
| AF2 | `pi-subagents-lite/src/ui/action-report.ts`, `ui/menu/menu-running-agents.ts`, `src/events.ts` | every call site reads the manager's boolean; the bulk actions re-derive their targets and count the `true`s | `s2`, second half; 9 tests |
| AF3 | `pi-loop-mode/extensions/index.ts` | `deliverLoopTurn()` at the five directive-carrying exits | `s4 pending` — BEFORE, every row reads `(nothing)`; 7 tests, 5 fail without it |
| AF4 | `pi-subagents-lite/src/agents/status-listing.ts` | the bound sorts by `completedAt ?? startedAt` instead of trusting the caller's order | `s2`, first half; 3 tests |
| AF5 | `pi-subagents-lite/src/agents/verify.ts` | `briefForCheck()`, used by the judge prompt and the anchor | 7 tests, 2 fail without it |
| AF6 | `.pi/extensions/compaction-guard/index.ts` | the `isError` exemption is gone | `s3` — 17,738 → 1,970 chars; 6 tests, 5 fail without it |

### The gates

```
   ( cd vendor/pi-loop-mode       && npm test && npm run lint )          # 218
   ( cd vendor/pi-subagents-lite  && npm test && node tests/lint.mjs )   # 329 + 91/91
   ( cd vendor/prinny-channel     && npm test && npm run lint )          # 377
   ( cd .pi/extensions/compaction-guard && npm test )                    #  47
   ( cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts )  # 20
                                                                          ─────
                                                                           991
```

### The three closures after the findings

| # | file | the change | control run |
| --- | --- | --- | --- |
| §11.12 | `pi-loop-mode/src/compaction-lock.ts`, `prinny-channel/src/compaction-lock.ts`, both `extensions/index.ts` | one `globalThis` key, two implementations asserted to agree; the loop adopts or waits, prinny tells the sender | `s5` — BEFORE, two `ctx.compact()` calls on one `agent_settled`; 12 + 11 tests |
| §10.7 | `pi-subagents-lite/src/agents/verify-log.ts`, `verify-runner.ts`, `agent-manager.ts` | one JSONL line per verifier model call: prompt, raw reply, and the parse | 15 tests, including that a throwing logger costs no verdict |
| §11.1 | `pi-subagents-lite/src/spawn/nudge-drop.ts`, `spawn/spawn-coordinator.ts` | all three guards report, on a channel that exists headless | 7 tests |

### The new modules

Two, both in the house style — a rule lifted out of a file the suite cannot load,
into one that imports nothing:

```
   pi-subagents-lite/src/ui/action-report.ts       what the operator is told when
                                                   the manager says no      (AF2)
   prinny-channel/src/delivery.ts                  +unansweredRooms/Message (AF1)
   pi-subagents-lite/src/agents/verify.ts          +briefForCheck           (AF5)
   pi-loop-mode/src/compaction-lock.ts             the interlock, one of two
   prinny-channel/src/compaction-lock.ts           …and the other        (§11.12)
   pi-subagents-lite/src/agents/verify-log.ts      the judge's raw reply    (§10.7)
   pi-subagents-lite/src/spawn/nudge-drop.ts       an undelivered result,
                                                   said out loud            (§11.1)
```

---

## 13. Running the evidence

```sh
cd ~/qwen3.8-forge

# the gates — check the TEST COUNT as well as the failure count
( cd vendor/pi-loop-mode       && npm test && npm run lint )
( cd vendor/pi-subagents-lite  && npm test && node tests/lint.mjs )
( cd vendor/prinny-channel     && npm test && npm run lint )
( cd .pi/extensions/compaction-guard && npm test )
( cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts )

# just this pass's regression tests
( cd vendor/pi-loop-mode && node --experimental-strip-types --test tests/pending-directives.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/action-report.test.ts tests/status-listing.test.ts tests/verify.test.ts )
( cd vendor/prinny-channel && node --experimental-strip-types --test tests/delivery.test.ts )
( cd .pi/extensions/compaction-guard && node --experimental-strip-types --test tests/error-output.test.ts )

# the three closures
( cd vendor/pi-loop-mode && node --experimental-strip-types --test tests/compaction-lock.test.ts )
( cd vendor/prinny-channel && node --experimental-strip-types --test tests/compaction-lock.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/verify-log.test.ts tests/nudge-drop.test.ts )

# this pass's probes — one process per mode, because the state is module-global
P=context/testing/probes
for m in two-rooms one-room-nothing-to-send control; do
  node $P/s1-the-answer-two-rooms-were-both-owed.mjs $m
done
node $P/s2-the-six-oldest-agents.mjs
node $P/s3-the-output-that-was-an-error.mjs
for m in pending idle; do node --experimental-strip-types $P/s4-the-directive-that-was-never-said.mjs $m; done
node $P/s5-two-extensions-one-compaction.mjs

# every probe, exit code only (r1/r3/s1/s4 take a mode argument)
for f in context/testing/probes/[a-z]*.mjs; do
  timeout 240 node --experimental-strip-types "$f" >/dev/null 2>&1 || echo "check $f"
done
```

| probe | what it shows | the control |
| --- | --- | --- |
| `s1` | the real `prinny-channel` over the real sidecar protocol: two people, one run, one answer that belongs to one of them (`two-rooms`), and a turn with nothing to forward (`one-room-nothing-to-send`) | mode `control`: one question, one answer, and nothing else sent — an answered room is never apologised to |
| `s2` | the real `AgentManager` and the real `AgentStatus` tool through pi's jiti: which six of ten settled agents are printed, and what `clear()` / `abort()` return in the two states where they refuse | the same ten records handed over oldest-first must produce the same six; and both calls on records that DO accept them |
| `s3` | pi's own bash source pinned, then the shipped cap driven with a 17,738-character failing suite at 84.5% | the identical text as a SUCCESS, capped to the same length; and a short error, which is not rewritten at all |
| `s4` | the shipped loop module through `_host.mjs`: all five directives queued onto the pending turn as `steer` | mode `idle`, where all six start a turn of their own; and `continue`, which still drops |
| `s5` | **both** extensions in one process, registered and fired in `pi-local.sh`'s order: one `ctx.compact()` reaches pi where two used to, and the sender is told their compaction is running | the interlock at the module level (one takes it, the other is refused, a non-owner's release does nothing); the reverse order, where the loop must ADOPT rather than abort; and a fresh run with the lock free, which must compact exactly as before |

---

## 14. The pattern across fifteen audits

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
   instructing ↔ obeying      AD1–AD7  something was decided for a mechanism, and
                                       nobody checked that the mechanism ever saw it
   believing ↔ being          AE1–AE7  the machine keeps a fact about itself, and
                                       something else stops it being true
   deciding ↔ what was        AF1–AF6  the code declines to act, correctly, and the
     decided about                     thing it was holding has no second owner
```

Three things transfer out of this one.

**A refusal is half a decision.** The other half is the object. Every finding here
is a branch that answers "should I do this?" correctly and never answers "then
what happens to it?" — and the object is always something somebody is waiting
for: an answer to a question, a typed follow-up, a directive the ladder has
already been charged for, the six agents the model just launched. The habit that
follows is one question at every `return` inside a guard: **what was I holding
when I decided not to, and who has it now?** In four of the six the honest answer
was "nobody, and it is gone" — and in three of those the code that deletes it was
in the same function as the refusal.

**A bound is a refusal with a rule in it, and the rule has to be checked against
what the caller actually hands over.** AF4 and AF5 are the same defect in two
packages: `slice(-N)` over an array whose newest element is first, and a head cut
over a string whose newest content is last. Both had a comment stating the
premise — "the manager's own (spawn order)", "the judge sees a truncation of
this" — and in both cases the premise was the thing to check. **When you write a
bound, write down which end it keeps, then go and look at what the caller's end
actually is.**

**A "somebody else will do it" is a claim about somebody else.** AF3's guard says
a turn is already coming, which is true; what is false is that the turn carries
the loop's directive. AF1's refusal says the answer cannot be attributed, which
is true; what is false is that anything downstream will notice the two rooms it
left behind. The fourteenth pass's version of this was *"nothing is in flight
here" is a claim about the future*; this is its sibling: **"something else will
handle this" is a claim about another piece of code, and it costs one read of
that code to check.**

---

## 15. Still unwatched

Everything above is fixed against probes and tests, and none of it against a
running model. That has been true for twelve passes now.

1. **§U of `context/testing/subagents-loop-verifier.md`** — Esc on a loop turn,
   then type a question. One keypress, no subagent, no verifier, no Matrix
   account; it is AE1 end to end and it is still the cheapest run on the list.
2. **§B and §P** — one background delegation, and the only question is whether
   the result appears in the conversation at all. Do it headless too (`pi -p`).
3. **§Q — the model override, end to end** (AD1 and AE6): spawn the SAME agent
   twice, once by its exact name and once in the wrong case.
4. **§M, §M.2, §M.3** — three `/loop start`s with different `--check`s and
   `/loop status` after each. Six findings across five passes sit on that path,
   AF3 included: with `--check` set, the goal check is the await that makes AF3's
   window minutes wide.
5. **§V and §W** — a `/compact` from the room that is waiting, and an empty turn
   with a `/compact` waiting. **And now a third: two people, two rooms, one
   turn** — the AF1 run. Message the bot from two rooms while it is busy, and
   check that both of them hear something.
6. **A real verification**, foreground, `SUBAGENT_VERIFY_ROUNDS=1`, deliberately
   off-task brief — and now with a STEER in it, which is AF5: steer the agent
   once, let it answer the steer, and check that the judge is not asked about the
   original alone.
7. ~~**Log the judge's raw reply.**~~ **CLOSED** — §10.7. It was #1 by age for
   twelve passes. What is still unwatched is the log's own content: nobody has yet
   read a line of it written by a real 27B judging a real answer, which is the
   whole point of having it. Run item 6 and then read
   `~/.pi/agent/subagent-verify.jsonl`.
8. **A child that compacts** (§L), **a delegation with a loop running** (§I),
   **§J**, **§K/§K.2**, **§N**, **§O** — none ever run.
9. **A `/loop` against a genuinely failing test suite**, which is AF6's own
   shape: `--check "npm test"` with the suite red, and the model running `npm
   test` itself every iteration. The cap's notice should appear in the terminal
   once per iteration; before this pass it never did.

---

## 16. Where to look

- `context/testing/probes/s1`–`s4` — the reproductions. `s1` drives the whole
  `prinny-channel` extension in-process over the real MCP sidecar protocol; `s2`
  drives the real `AgentManager` and `AgentStatus` through pi's bundled jiti;
  `s3` pins pi's bash source and drives the shipped cap; `s4` drives the shipped
  loop module through `_host.mjs`.
- The regression tests:
  `vendor/prinny-channel/tests/delivery.test.ts` (AF1),
  `vendor/pi-subagents-lite/tests/action-report.test.ts` (AF2),
  `vendor/pi-loop-mode/tests/pending-directives.test.ts` (AF3),
  `vendor/pi-subagents-lite/tests/status-listing.test.ts` (AF4),
  `vendor/pi-subagents-lite/tests/verify.test.ts` (AF5),
  `.pi/extensions/compaction-guard/tests/error-output.test.ts` (AF6).
- **§1** of this document — the machine, with every refusal marked; **§2** — the
  refusal ledger and the refusals graph, which is the artefact this pass exists
  to leave behind; **§7.4** — the four-row table that says who reports an
  unanswered Matrix message, which is where AF1 fits beside AB2 and AC4.
- `context/design/subagents-loop-verifier-claims.md` — the fourteenth pass
  (AE1–AE7) and its §2 claim ledger. Read that one first if you are new to the
  stack; its §1 is the drawing this document's §1 extends.
- `…-controls.md` (thirteenth, AD1–AD7) · `…-deliveries.md` (twelfth, AC1–AC5,
  and the nearest neighbour to this axis) · `…-signals.md` (eleventh, AB1–AB4) ·
  `…-hosts.md` (tenth, AA1–AA4) · `…-answers.md` (ninth, Z1–Z4) · `…-turns.md`
  (eighth, X1–X5, Y1) · `…-readers.md` (seventh, W1–W6, the other neighbour) ·
  `…-shapes.md` (sixth, V1–V8, where V4 is) · `…-units.md` (fifth, U1–U9, whose
  §9 reference sections no later document restates) · `…-surfaces.md` (fourth,
  S1–S10) · `…-mechanics.md` (third, T1–T9, still the best account of pi's own
  agent loop) · `…-evaluation.md` (second, F1–F11) · `…-anatomy.md` (first, and
  the design rationale).
- pi's own source, for this pass:
  `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:162` (the
  follow-up drain that puts two rooms in one run — AF1), `:472` and `:519`
  (`executePreparedToolCall`'s catch and `createErrorToolResult` — AF6),
  `dist/core/tools/bash.js:346-349` (the throw that carries the whole output),
  `dist/core/tools/truncate.js:10-11` (2,000 lines / 50 KB, bash's own bound),
  `dist/core/agent-session.js:1151` (`pendingMessageCount`, which is what
  `hasPendingMessages()` answers from — AF3).
