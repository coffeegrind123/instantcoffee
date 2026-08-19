# Subagents, the loop, and the verifier — the flags that stopped being true

Fourteenth pass, 2026-08-18. A full read of the whole stack — the loop,
subagents, the verifier, and the three extensions under and beside them — asking
a question the previous thirteen kept walking past.

The thirteenth pass followed the **instructions inward**: *name the mechanism,
and say what happens to the instruction it was given.* That produced §2 of
`…-controls.md`, the control ledger, and seven findings.

This one asks about the machine's account of **itself**:

> **Name the flag. Name the fact it stands for. Then name everything that can
> make the fact false, and say whether the flag hears about it.**

A flag here is any value the machine keeps about its own state and then acts on:
`state.active`, `lifecycle.status`, `agentRunning`, `entry.live`, `retrying`,
`params.model`, `pendingCompaction`. Every one of them is a *claim*, written at
one moment by one piece of code, and read later — sometimes much later, usually
by somebody else — as though it were still true. All seven of this pass's
findings are one flag and one line that falsified it without telling it.

```
   AE1  `state.active` is what all thirteen of the loop's handlers test at
        their first line, and the operator-abort branch of `agent_end` set
        `status = "paused"` without clearing it. So "Loop paused (turn
        aborted). Use /loop resume to continue" was a sentence about a loop
        that still owned the session — and the next `agent_end` from ANY
        source ran the whole ladder, counted an iteration and scheduled the
        next one, silently. The likeliest such turn is the operator
        answering the notice they were just shown.            HIGH · FIXED

   AE2  AD3 deferred a Matrix `/compact` to `agent_settled` on one premise —
        "by then aborting costs nothing because the run is over". True of
        the run that ended; false of the one `forwardResult()` starts on the
        line above, which is the empty-turn continuation. pi's `compact()`
        begins `await this.abort()`.                        MEDIUM · FIXED

   AE3  `awaitingReply` is keyed by ROOM and holds one entry, and every
        inbound message `set()` a fresh one. So a `/compact` — or any
        command this extension answers itself — replaced the entry belonging
        to the question the model was still working on, with `live: false`
        and nothing able to set it again. The answer arrived, found no live
        room, and was dropped in silence.                      HIGH · FIXED

   AE4  `retrying` is set on the strength of having CALLED
        `api.sendUserMessage`, which returns void and whose rejection pi
        swallows into a listener set that is empty headless. `retrying` is
        what suppresses the retirement of every live room — so a
        continuation that never happened left a stranger's room live, and
        the operator's next answer, to a question typed in the terminal, was
        forwarded to it.                                       HIGH · FIXED

   AE5  `lifecycle.status` stands for "is this record doing work", and the
        verifier does work after it has gone terminal. `record-activity.ts`
        exists so that question has one answer; after AD2 three readers
        still had their own — the `AgentStatus` TOOL (which could elide the
        one agent holding the llama slot, under a bound whose comment says
        it never does), the conversation viewer's Stop action, and the
        reload warning.                                      MEDIUM · FIXED

   AE6  AD1 made `params.model` the value the spawn obeys, which made the
        KEY the listener resolved it against load-bearing. The listener uses
        the name the model typed, against the registry as it stands; the
        tool uses the canonical name, after a discovery scan. An operator's
        per-type pin was skipped for a case-different name, and an agent
        found only by the retry lost its own `model:` frontmatter — AD1's
        damage restored for one class of agent.              MEDIUM · FIXED

   AE7  `describeEmptyEnding` walked past a `user` message its sibling
        `finalAssistantText` stops at, so the two could disagree about which
        run answered. The sender's question was then retired with no answer,
        no continuation and no notice.                          LOW · FIXED
```

Three of the seven are the previous pass's own fixes one layer out (AE2 and AE6
directly; AE5 is AD2's predicate at its remaining callers). That is the same
pattern the thirteenth pass named, and §14 is about why it keeps happening.

```
                                    before    after
vendor/pi-loop-mode        tests    198       199
vendor/pi-subagents-lite   tests    283       289     lint 85/85 files
vendor/prinny-channel      tests    332       357     lint clean
.pi/extensions/compaction-guard      41        41
vendor/rtk-pi              tests     20        20
                                   ─────     ─────
                                    874       906
probes                                59        62
```

---

## 0. How this sits next to the other thirteen

Read `…-controls.md` first if you are new: its §1 is the machine and its §2 is
the control ledger. This document is a fourteenth pass over the same machine
along a different axis, and it is self-contained — §1 to §8 below are a full
account of the stack, not a diff against the thirteenth pass.

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
  14th   THIS ONE          AE1–AE7  the FLAG and the fact it stands for
```

The eleventh pass (AB1–AB4) is the nearest neighbour and it is worth saying how
this differs, because at a glance they are the same question. AB asked **how
long an ANSWER stays true** — a value a host function handed back, and a reader
who arrives after the moment it described. This one asks about a value the stack
writes about **itself**, keeps, and treats as a standing fact. AB1's `killed` was
never wrong; it answered a narrower question than its reader thought. AE1's
`state.active` is wrong — the loop is not active, and nothing said so.

---

## 1. The whole machine

Everything in this document is a zoom into this drawing. It is the thirteenth
pass's §1 with the claim axis added: every **flag** — a value the stack keeps
about its own state and later acts on — is marked `◆`, and every one that a
finding here showed going stale is marked `◆✘`. The two entry points, the three
nested units of a turn, the five extensions and the event bus are unchanged and
still exact.

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
  │         extension error, and reported to prompt() as `return true`. [AD4]  │
  │   compacting? ─▶ THROW "Cannot submit a prompt while…"              :808   │
  │       ◆ _compactionAbortController — set for the WHOLE of a compaction,    │
  │         and this is the throw AE2's race lands on. The rejection goes to   │
  │         pi's own `.catch` → emitError → no listeners headless.             │
  │   streaming?  ─▶ streamingBehavior ?? THROW                         :833   │
  │                  followUp ─▶ _queueFollowUp  → _followUpMessages           │
  │                  steer    ─▶ _queueSteer     → _steeringMessages           │
  │                  ◆ THE ONLY TWO ARRAYS hasPendingMessages() SEES    [AA3]  │
  │   idle:                                                                    │
  │       no model / no auth  ─▶ THROW                               :848/:855 │
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
  │   triggerTurn (idle)   ─▶ await _runAgentPrompt(msg)                :1090 │
  │                             ▲ NO emitBeforeAgentStart            [AA1]    │
  │                             ▲ deliverAs DISCARDED                [AA4]    │
  │   RETURNS void. Every failure is pi's `.catch` → emitError → a listener   │
  │   set that is EMPTY outside a TUI.                    [AB2][AC1] ◆✘ AE4   │
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
    │     │       ┗━ message_end is THREADED and written OVER the object
    │     │          agent-core holds (_replaceMessageInPlace)         [X5]
    │     │     executeToolCalls
    │     │       ┏━ prepareToolCall ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ :393
    │     │       ┃  validatedArgs = validateToolArguments(tool,call)┃
    │     │       ┃  beforeToolCall({ args: validatedArgs })         ┃ :405
    │     │       ┃    `event.input` IS validatedArgs, BY REFERENCE  ┃
    │     │       ┃    handlers MUTATE it; only `block` is read back ┃
    │     │       ┃  …then tool.execute(id, prepared.args, …)        ┃ :452
    │     │       ┃         ▲ THE SAME OBJECT — the channel rtk      ┃
    │     │       ┃           rewrites a command on, and the one the ┃
    │     │       ┃           Agent tool's model override rides ◆✘AE6┃
    │     │       ┗━ prinny's permission relay, then rtk's rewrite ━━┛
    │     │       execute → afterToolCall → emitToolResult              :551
    │     │         ┗━ ONE shared event object; each returned field merged
    │     │            loop fingerprints RAW · guard caps after it
    │     │     turn_end
    │     │     ┏━ prepareNextTurn: systemPrompt: _systemPromptOverride ?? _base
    │     │     ┗━ turn 1 did NOT come through here                    [AA1]
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
            ◆ _isAgentRunActive = false   ← BEFORE the handlers run     :328
            emit agent_settled            ← so ctx.isIdle() is TRUE here
                                          ← and prinny STARTS A RUN from
                                            here, which is AE2      ◆✘

  MESSAGE  one assistant reply.
  TURN     one message plus its tool results (pi's `turn_end`).
  RUN      agent_start … agent_end.  `pi-loop-mode` counts this as one iteration.
  PROMPT   one prompt()/sendCustomMessage — possibly several RUNs.

 ══════════════════════════════════════════════════════════════════════════════
  C.  THE FIVE EXTENSIONS, in load order, and the flag each one keeps
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
  │ ◆ state.      │ ◆ spillDir    │ ◆ lifecycle.  │ ◆ agentRunning│ (stateless —  │
  │   active ✘AE1 │   (a mkdtemp) │   status ✘AE5 │ ◆ entry.live  │  the gate is  │
  │ ◆ runToken    │               │ ◆ verifyPhase │   ✘ AE3 AE4   │  pure)        │
  │ ◆ softStop-   │               │ ◆ settled     │ ◆ answered    │               │
  │   Requested   │               │ ◆ started     │ ◆ retrying ✘  │               │
  │ ◆ rescueActive│               │ ◆ modelKey    │ ◆ pending-    │               │
  │ ◆ 3 per-turn  │               │ ◆ params.     │   Compaction  │               │
  │   buffers     │               │   model ✘AE6  │   ✘ AE2       │               │
  │ ◆ penalty-    │               │ ◆ background- │ ◆ lastRun-    │               │
  │   Turns       │               │   AgentIds    │   EmptyEnding │               │
  │               │               │               │   ✘ AE7       │               │
  │ AA1 AA2 AA3   │ §6, spill     │ AA4 Y1 Z1 Z2  │ W1 AB2        │ §8, AB3       │
  │ X1–X5 Z3 Z4   │ bound         │ AB4 AC1       │ AC4 AC5       │               │
  │ AB1 AC2 AC3   │               │ AD1 AD2       │ AD3–AD5 AD7   │               │
  │ AD6           │               │               │               │               │
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

   THREE orderings decide behaviour, and a FOURTH now matters:

   context        loop FIRST, appends `loop-context-budget`; the guard sees the
                  `-context-budget` suffix and stands down. Both sides check.  ✔
   tool_result    loop FIRST, fingerprints the RAW output into the stuck
                  window; the guard's cap runs after.                          ✔
   tool_call      prinny FIRST, rtk SECOND — NOT symmetric, because a
                  `{block:true}` returns from `emitToolCall` immediately.      ✔
   agent_settled  loop FIRST (it may request an emergency compaction), prinny
                  SECOND (it may forward, continue, and compact). Nothing
                  coordinates them, and both can call `ctx.compact()` — whose
                  first statement is `await this.abort()`. AE2 is prinny's own
                  half of this; the cross-extension half is §11.7.          ⚠

   NOTE, unchanged from AD6: the `tool_call` row is the ONLY place a shell
   command can be reviewed. `pi.exec` — which the loop's goal check and rtk's
   version probe both use — is `execCommand` directly and emits nothing here.

 ══════════════════════════════════════════════════════════════════════════════
  E.  A DELEGATION, WITH EVERY FLAG MARKED
 ══════════════════════════════════════════════════════════════════════════════

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the OPERATOR's pi session                                               │
   │   module-global state, shared by every session in this PROCESS:          │
   │     pi-loop-mode   ◆state:LoopState ◆runToken ◆pendingTimer ◆3 buffers   │
   │     pi-subagents   shell{pi,sessionCtx,manager,widget,store,coordinator} │
   │     prinny         ◆child ◆awaitingReply ◆typingRooms ◆deliveryTimer     │
   │                    ◆pendingCompaction ◆agentRunning ◆lastAssistantText   │
   │     rtk-pi         (none — the gate is pure)                             │
   │     compaction-gd  ◆spillDir (a mkdtemp, first use, bounded at 50)       │
   │     shell.ts       ◆__PI_SUBAGENT_SPAWN_DEPTH__ on globalThis            │
   └──────────────┬───────────────────────────────────────────────────────────┘
                  │ Agent(prompt, agent:"Explore", run_in_background?)
                  │
   ┏━━━━━━━━━━━━━━▼━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  tool_call — where the instructions are attached                        ┃
   ┃    prinny  needsApproval(toolName, input, settings) → block?            ┃
   ┃    rtk     bash only; rewrites event.input.command in place             ┃
   ┃    subag   toolCallListener:                                           ┃
   ┃              canonical = resolveType(input.agent)          ← AE6       ┃
   ┃              input._resolvedAgent = canonical  ◆ the STAMP             ┃
   ┃              input.model    = resolveSpawnModel(canonical, ctx)  ◆     ┃
   ┃              input._modelOverride = <shown in the TUI>                 ┃
   ┃              input.thinking = resolveSpawnThinking(canonical)    ◆     ┃
   ┗━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                  │ the SAME object reaches execute()
   ┌──────────────▼────────┐    ┌─────────────────────────────────────────────┐
   │ executeAgentTool      │    │ AgentManager                                │
   │  worktree · type      │───▶│  SlotTable(1) · queue · Watchdog 45min      │
   │  ── resolveTypeWith-  │    │  parent signal: `.aborted` checked ✔ :328   │
   │     Discovery: the    │    │  stopAgent(running)   = abortCtrl.abort()   │
   │     registry can have │    │  stopAgent(verifying) = verifyAbort.abort() │
   │     GROWN since the   │    │        ▲ reachable from Esc ✔ /agents ✔     │
   │     listener ran ←AE6 │    │          StopAgent ✔ · the VIEWER ✘ AE5     │
   │  params._resolvedAgent│    └────────────────┬────────────────────────────┘
   │    === resolvedType ? │                     │ runAgent()
   │      trust the inject │                     │
   │      : resolve again  │                     │
   └───────────────────────┘                     │
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃  THE BUILD WINDOW — seconds, and until AB4 nothing was listening         ┃
   ┃    enterSubagentSpawn()   ◆ depth > 0                                    ┃
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
   │    forwardAbortSignal(session, signal)  ← listener; `.aborted` above     │
   │    ceiling maxTurns → wrap-up steer → hard abort graceTurns later        │
   │    runTurnLoop reads the RUN's answer, per message                ← Z1   │
   │    onCompaction steers the anchor only into a live run            ← Z2   │
   └──────────────────────────┬───────────────────────────────────────────────┘
                              │ settles — ◆status TERMINAL, SLOT STILL HELD
                              ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                       │
   │    SUBAGENT_VERIFY / _ROUNDS / _TIMEOUT_MS all read HERE, together       │
   │    structural gate (free) → judge (fresh __verifier session, 1 turn)     │
   │    → repair (the child's own session, 1 turn) → judge again → …          │
   │    rewrites record.result IN PLACE, so every reader sees one answer      │
   │    ◆ verifyPhase is the ONLY field that says work is in flight, and      │
   │      `lifecycle.status` says the opposite for all of it       ← AE5      │
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
   │        ▼               │    │             │                            │
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
   │   classifyMatrixCommand(body)  — a leading "/" is decided HERE         │
   │     …and it is decided FIRST now, because the entry depends on it ←AE3 │
   │   awaitingReply.set(room, mergeAwaiting(previous, arrival))            │
   │        ◆ live      evidence about the ROOM, never taken back down      │
   │        ◆ answered  something has been sent for this message            │
   │        ◆ injected  exactly what pi was handed — markLive matches it    │
   │   armDeliverySweep()                                             AB2   │
   │        ├─ refuse ─▶ reply(reason)              answered = true   AC4   │
   │        ├─ local  ─▶ THIS extension performs it  answered = true  AC5   │
   │        │            /compact → planCompaction(hasSession, agentRunning)│
   │        │              busy → DEFER to agent_settled           ← AD3    │
   │        │              idle → uiCtx.compact({onComplete,onError})       │
   │        ├─ run    ─▶ sendUserMessage(text, {expandPromptTemplates:true})│
   │        │            the receipt says HANDED, not RAN         ← AD4     │
   │        └─ text   ─▶ sendUserMessage(text, {deliverAs})                 │
   │                       └─▶ AgentSession.prompt(…)                       │
   │                             THROWS → pi `.catch`es → NO LISTENERS AB2  │
   └────────────────────────────────────────────────────────────────────────┘
        │
        │ pi echoes the user message back
        ▼
   message_end{role:"user"} ─▶ markLive(text) ── matched on the whole injected
        │                       string. THE ROOM IS NOW ANSWERABLE, and not
        │                       one moment sooner
        ▼
   agent_start ─▶ ◆agentRunning = true ─▶ typing, refreshed every 8s
        ▼
   message_end{assistant} ─▶ forward:"all" → each message as it finishes
   agent_end               ─▶ ◆lastAssistantText · ◆lastRunEmptyEnding   W1
        │                        ▲ describeEmptyEnding stops at a `user`
        │                          message now, like its sibling    ← AE7
        ▼
   agent_settled           ─▶ ◆agentRunning = false
                              stopTyping
                              forwardResult()  ─────────────┐
                                 forward:"result" → the closing text
                                 empty ending → a bounded CONTINUATION,
                                   and the room stands back DOWN until
                                   markLive fires for the nudge   ← AE4
                                 retire live rooms · alreadySent.clear()
                                 sweepUndelivered()          AB2 AC4
                                                             │
                              standAside(pendingCompaction, ─┘
                                         continuationStarted)   ← AE2
                                 wait  → keep it for the next settle
                                 else  → drainPendingCompaction()
```

The single constraint shaping all of it is the slot at the top. One llama slot
means nothing is concurrent with anything else: a child's turn, the judge's turn,
a repair, a Matrix answer and the parent's next call are five things in one
queue. Every finding in this pass costs a place in that queue, or an answer that
went nowhere, or a machine acting on a claim about itself that had stopped being
true.

---

## 2. The claim ledger

This is the pass's mechanical contribution and the thing that found AE1, AE4 and
AE5. For every **flag** in this stack — a value it keeps about its own state and
later acts on — what fact it stands for, who may falsify that fact, and whether
the flag is told.

Legend: ✔ every falsifier writes it · ⚠ a falsifier writes it late or partially,
by decision · ✘ a falsifier does not write it at all.

```
 flag                    stands for               falsified by            told?
 ══════════════════════════════════════════════════════════════════════════════
 THE LOOP
 ──────────────────────────────────────────────────────────────────────────────
 state.active            "this loop is driving    /loop stop · end        ✔
                          this session"           pauseForContext/Check/
                                                  ProviderFailure         ✔
                                                  the iteration cap       ✔
                                                  --until-done completion ✔
                                                  the OPERATOR's Esc   ✘ AE1 → ✔
   Thirteen handlers test it at their first line. The abort branch set
   `status = "paused"` and left this true, so the loop went on owning a session
   it had told the operator it had stopped driving.

 state.status            "what to show a human"   every branch above      ✔
   Cosmetic, and that is exactly why AE1 hid: `paused` was written, read by
   `/loop status`, and gated NOTHING.

 runToken                "this async continuation every start/stop/resume,
                          belongs to the CURRENT   and now the abort too   ✔
                          run"
 softStopRequested       "finish this iteration,   finalizeSoftStop        ✔
                          then stop"
 rescueActive            "the current turn is on   agent_end's rescue rung ✔
                          the rescue model"        session_start restore   ✔
 penaltyTurnsRemaining   "sampling is altered"     aged at the TOP of
                                                   agent_end, every exit   ✔
 toolCallsThisTurn       "this TURN called N       drained at the top of
                          tools"                   agent_end, every exit   ✔
 the 3 per-turn buffers  "what THIS turn said"     resetTurnBuffers, from
                                                   every transition        ✔
 lastCheckPassed         "the check's verdict"     applyCheckOutcome       ⚠
   Deliberately NOT cleared when a check could not RUN: "last known" is the
   honest reading, and `checkErrorStreak` is the flag that says so. AC2 is what
   happens when a reader takes the first without the second.

 ──────────────────────────────────────────────────────────────────────────────
 SUBAGENTS
 ──────────────────────────────────────────────────────────────────────────────
 lifecycle.status        "is this record doing     classifyRun             ✔
                          work"                    the VERIFIER         ✘ AE5
   Terminal from the settlement chain's `.then`, and `runVerification` is
   awaited after it. `record-activity.ts` exists to be the single answer;
   AD2 moved `StopAgent` and `formatRunningAgents` onto it, and left the
   `AgentStatus` TOOL, the conversation viewer's Stop, and the reload warning.
                                                                        → ✔

 verifyPhase             "a judge or a repair is   verifyAnswer's finally,
                          in flight"               on every path          ✔
 execution.settled       "the run chain is done;   attachSettlementChain's
                          a continuation may       .finally                ✔
                          re-prompt"
 execution.started       "there was a run whose    startAgent, synchronously
                          .finally will open the   before the run          ✔
                          gate"
 the completion gate     "the parent may stop      seven paths, opened
                          waiting"                 exactly once            ✔
 modelKey                "which concurrency slot   set at spawn from the
                          this record holds"       resolved model       ✘ AE6 → ✔
   It follows the model, so AD1 collapsed every child onto the parent's slot
   and AE6 did the same for two narrower classes of spawn.

 params.model            "the model this spawn     resolveSpawnModel, at the
                          runs on"                 tool_call              ✘ AE6
   Resolved against the name the MODEL typed and the registry as it stood;      → ✔
   `executeAgentTool` resolves the CANONICAL name after a discovery scan.
   Two keys, one precedence. The stamp `_resolvedAgent` is what makes the
   difference askable.

 backgroundAgentIds      "this record has not      onAgentComplete, once   ✔
                          nudged yet"
 __PI_SUBAGENT_SPAWN_    "an extension factory is  exitSubagentSpawn, and
   DEPTH__                loading INTO a child"    the bracket is the
                                                   BUILD only, not the run ✔

 ──────────────────────────────────────────────────────────────────────────────
 prinny-channel
 ──────────────────────────────────────────────────────────────────────────────
 entry.live              "pi has taken something   markLive, on the echoed
                          from this room and       user message           ✔
                          owes it an answer"       a SECOND message from
                                                   the same room       ✘ AE3 → ✔
   It was a Map `set()`, so any later inbound — including one this extension
   answers ITSELF, which can never be marked live — cleared the evidence for
   the question the model was still working on. The answer was then dropped.

 retrying                "a continuation is        api.sendUserMessage's
                          coming, so do not        REJECTION            ✘ AE4
                          retire the live rooms"                          → ✔
   The call returns void and pi swallows its own rejection into a listener set
   that is empty headless. The repair is not a better flag: the room now waits
   for the same EVIDENCE the first delivery waited for.

 answered                "something has been sent  every send path         ✔
                          for this message"        refuse/local/run        ⚠
   The three command branches set it on the strength of having ACTED, which is
   AD4's residue and is stated rather than guarded.

 agentRunning            "pi is running a turn"    agent_start/agent_settled ⚠
   True between `agent_end` and `agent_settled`, which is right. Not true for
   the window between `prompt()` being called and `agent_start` firing — one
   `await` chain wide, and the only reader that would care is `planCompaction`.
   Recorded in §11.5.

 pendingCompaction       "a sender is waiting for  drainPendingCompaction  ✔
                          a compaction"            …but the run it would
                                                   abort is started by the
                                                   same handler         ✘ AE2 → ✔
 lastRunEmptyEnding      "the run said nothing"    describeEmptyEnding,
                                                   at agent_end            ✔
                                                   …which disagreed with
                                                   finalAssistantText   ✘ AE7 → ✔
 lastAssistantText       "the run's closing text"  agent_end               ✔
 typingRooms             "these rooms think the    applyTyping reconciles
                          bot is typing"           rather than toggles     ✔

 ──────────────────────────────────────────────────────────────────────────────
 rtk-pi / compaction-guard
 ──────────────────────────────────────────────────────────────────────────────
 (rtk keeps none — the gate is a pure function of the command string)      ✔
 spillDir                "where capped output      created on first use,
                          goes"                    bounded at 50 files     ✔
 ══════════════════════════════════════════════════════════════════════════════
```

**Twenty-four flags. Five of them had a falsifier that never wrote them, and one
more was falsified by the very handler that read it.** The pattern is not
"somebody forgot to reset a variable": in every case the flag is set correctly
at least once, by careful code, and the thing that makes it false is somewhere
else entirely — a different branch, a different extension, a later scan of the
filesystem, a call that cannot report failure.

### 2.1 The claims graph

The same ledger drawn as a graph, because what matters is not the flag but the
distance between its writer and its falsifier. Read each row as: *who writes it →
what it gates → what makes it false without saying so.*

```
                                                        ┌─────────────────────┐
   WRITER                    FLAG          GATES        │ FALSIFIER           │
 ══════════════════════════════════════════════════════════════════════════════
  runLoop() ──────────▶ ◆ state.active ──▶ 13 handlers  │ agent_end's abort   │
  /loop resume ───────▶      │              of the loop │ branch — same file, │  AE1
  pauseFor*() ────────▶      │                          │ 900 lines away      │
                             ▼                          └─────────────────────┘
                       before_agent_start injects
                       "Loop mode is active" into an
                       operator's own typed turn
 ──────────────────────────────────────────────────────────────────────────────
  classifyRun() ──────▶ ◆ lifecycle.   ──▶ AgentStatus  │ runVerification(),  │
                          status           the viewer's │ awaited AFTER the   │  AE5
                             │             Stop, the    │ status is written,  │
                             │             reload count │ in the same .then   │
                             ▼                          └─────────────────────┘
                       the tool can ELIDE the one
                       agent holding the llama slot,
                       and says "Don't poll"
 ──────────────────────────────────────────────────────────────────────────────
  markLive() ─────────▶ ◆ entry.live ───▶ forwardTo-    │ deliverInbound()'s  │
                             │            Matrix, the   │ own Map.set(), for  │  AE3
                             │            typing        │ a message it        │
                             │            indicator,    │ answers ITSELF      │
                             ▼            the sweep     └─────────────────────┘
                       the answer arrives, finds no
                       live room, and is discarded
 ──────────────────────────────────────────────────────────────────────────────
  forwardResult() ────▶ ◆ retrying ─────▶ whether the   │ pi's own `.catch`   │
                             │            live rooms    │ around sendUser-    │  AE4
                             │            are retired   │ Message — invisible │
                             ▼                          └─────────────────────┘
                       a stranger's room stays live,
                       and the OPERATOR's next answer
                       is forwarded to it
 ──────────────────────────────────────────────────────────────────────────────
  runLocalCommand() ──▶ ◆ pendingCom- ──▶ drainPending- │ forwardResult(),    │
                          paction          Compaction   │ one line above the  │  AE2
                             │             at settle    │ drain, in the same  │
                             ▼                          │ handler             │
                       pi's compact() aborts the run    └─────────────────────┘
                       this handler started
 ──────────────────────────────────────────────────────────────────────────────
  toolCallListener() ─▶ ◆ params.model ─▶ the spawn,    │ resolveTypeWith-    │
                             │            the slot key  │ Discovery(), which  │  AE6
                             │                          │ re-scans the disk   │
                             ▼                          │ AND canonicalises   │
                       the child runs on the parent's   │ the name            │
                       model, holding the parent's slot └─────────────────────┘
 ──────────────────────────────────────────────────────────────────────────────
  agent_end ──────────▶ ◆ lastRunEmpty- ▶ the continu-  │ finalAssistantText  │
                          Ending          ation, the    │ stopping at a       │  AE7
                             │            give-up       │ boundary this walk  │
                             ▼            message       │ crossed             │
                       the sender's question is retired └─────────────────────┘
                       with no answer and no notice
 ══════════════════════════════════════════════════════════════════════════════
```

Two shapes account for all seven, and they are worth naming separately because
they need different habits:

```
   THE FAR FALSIFIER            AE1  a branch 900 lines from the writer
                                AE5  a call one `await` after the writer
                                AE3  the writer's own function, a later call
                                AE6  a scan the writer cannot see

   THE FALSIFIER THAT CANNOT    AE4  a promise pi catches for you
   REPORT ITSELF                AE2  a handler that starts work after
                                     deciding nothing is running
                                AE7  a sibling function with a different
                                     stopping rule
```

### 2.2 The seven surfaces, plus the eighth this pass adds

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
   8. WHAT WE BELIEVE ABOUT OURSELVES —      AE1–AE7  ← this pass
      name the flag, name the fact, and
      name what can make the fact false
      without the flag hearing about it
```

---

## 3. The loop (`vendor/pi-loop-mode`)

Thirteen handlers, one module-global `LoopState`, one `/loop` command, one `loop`
tool, ~3,000 lines. Its whole job is deciding what a turn's outcome *was* and
then getting one sentence to the model about it.

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

**All thirteen begin with `if (!state.active) return;`** (the two `session_*`
handlers do their housekeeping first and then test it; `message_end` also admits
`status === "preparing"`). That single line is why AE1 is a whole-extension
finding rather than a cosmetic one: the flag is not one branch's business, it is
the extension's answer to "is any of this mine".

### 3.2 `agent_end` — the ladder

Twenty-one `return;` statements and a fall-through. Every arrow leaving the column
is a `return`. This is the single most important diagram in the loop, because
every counter in `LoopState` is charged or cleared somewhere on it, and because
AE1 lives on one of its rungs.

```
 agent_end(event, ctx)
   ├─ !state.active → (preparing? read GOAL_READY from the turn's ANSWER) ──▶ ✗
   ├─ clearPendingTimer() · token := runToken
   ├─ drain the three per-turn buffers into locals, then resetTurnBuffers()
   ├─ age penaltyTurnsRemaining        ← every exit ages it, not just the last
   ├─ read+clear degenerateAbortPending into a local
   ├─ softStopRequested ─▶ finalizeSoftStop  (active = false) ───────────────▶ ✗
   ├─ isContextPressure(...) ─▶ contextRecoveryPending, or a cooldown ───────▶ ✗
   │     lowOutputLength · saturatedLength · contextLikeError ·
   │     explicitOverflow · starvedTurn (empty answer at >= 87%)
   ├─ !lastAssistant || stopReason === "error" ─▶ providerErrorStreak++ ─────▶ ✗
   │     …and at MAX_PROVIDER_ERRORS (10) ─▶ pauseForProviderFailure
   │                                          (active = false)
   ├─ aborted && degenerateAbortThisTurn ─▶ interveneStuck ──────────────────▶ ✗
   ├─ aborted ─▶ runToken++ · active = FALSE · "paused"        ← AE1's rung ─▶ ✗
   │  ─── the success path ───
   ├─ every ladder counter reset · iterationCount++ · turnsWithoutTools
   ├─ committedText := commitTurnMemory(texts, calls, answers)
   ├─ rescueActive ─▶ switch back to the loop model ────────────────────────▶ ✗
   ├─ stuckReason := detectStuck(committedText, turnEmittedTexts)
   ├─ checkCommand → runGoalCheck → applyCheckOutcome         ← AB1 AC3 AD6
   │     ├─ execFailed × 3 ─▶ pauseForCheckFailure (active = false) ────────▶ ✗
   │     └─ untilDone && passed && !execFailed ─▶ COMPLETED (active = false)▶ ✗
   ├─ /LOOP_DONE:/                                            ← AC2
   │     guarded by (lastCheckPassed !== true || checkErrorStreak > 0) ─────▶ ✗
   ├─ /LOOP_BLOCKED:/ ─────────────────────────────────────────────────────▶ ✗
   ├─ maxIterations (active = false) · scoreRegressed · stuckReason ·
   │  the 8-iteration nudge ──────────────────────────────────────────────▶ ✗
   └─ normal continue: scheduleLoopTurn
```

**Every rung that ends the run now clears `state.active`.** Before this pass,
five of the six did — which is exactly the shape that makes the sixth invisible:
a reader checking the pauses one at a time finds five correct ones and stops.

The `aborted` rung is also where AD3's damage landed, and the two findings
compose: a Matrix `/compact` aborted the turn (AD3), the abort branch recorded it
as the operator's (AD3), and the loop then went on running anyway (AE1). Both
are closed.

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
          │      │   ────────────────────────────────────────────────────
          │      │   spawn error   → resolve({ code: 1, killed })
          │      │   timeout       → killProcess() → SIGTERM → exit(null)
          │      │                   → resolve({ code: null ?? 0, killed:TRUE })
          │      │   any exit      → resolve({ code: code ?? 0, killed })
          │      │        ▲ `killed` means "PI killed this", not "this was
          │      │          killed" — the eleventh pass's AB1
          │      ▼
          │    wrapCheckCommand(cmd) =
          │        trap 'printf "\n<MARKER>:%d\n" "$?"' EXIT
          │        (
          │        <the operator's command>
          │        )
          │        ▲ the SUBSHELL is AC3. A bash EXIT trap is a slot, not a
          │          stack: a `trap … EXIT` inside the command REPLACES ours,
          │          and `exec` discards it.
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
| SIGTERM from outside | false | present | *failed or passed* | **still not distinguishable — §11.2** |

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

### 3.6 The four ways a run restarts, and the fifth that is not one

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

The fifth column that used to exist and no longer does is **"the operator's Esc,
then anything at all"**. Before AE1 that was a restart path — an undocumented
one, with no reset of anything, no notice, and nobody choosing it. It is now
simply a pause, and `/loop resume` is the only way back.

---

## 4. Subagents (`vendor/pi-subagents-lite`)

64 source files. Three tools (`Agent`, `StopAgent`, `AgentStatus`), a widget, an
`/agents` menu, a slot table, a watchdog, a spawn coordinator that owns delivery.

### 4.1 A record's life, with the flags marked

```
  tool_call        toolCallListener resolves the CANONICAL type, stamps
    │              `_resolvedAgent`, and writes model + thinking onto the ARGS
    │              (the same object execute() receives — pi passes one)  ← AE6
    ▼
  executeAgentTool worktree · type (+ a DISCOVERY retry) · maxTurns ·
    │              thinking · MODEL — trusting the injection exactly while
    │              the stamp names the type it is about to spawn      ← AE6
    ▼
  spawn()          ◆status queued|running · gate created · brief := prompt
    │              parent signal: `.aborted` tested FIRST, then a listener  ✔
    ▼
  startAgent()     slot reserved · watchdog started · ◆started := true
    │              record.execution.abortController created
    ▼
  runAgent()       build window (AB4) → runSessionPrompt → runTurnLoop
    │                model := options.model ?? frontmatter ?? ctx.model
    │                forwardAbortSignal(session, signal)
    │                if (signal.aborted) throw ABORTED_BEFORE_START   ← AB4
    ▼
  .then            ◆status ← classifyRun(result)   TERMINAL FROM HERE
    │              …unless it is already "stopped", which is preserved
    │              result := responseText                            ← Z1
    │              runVerification()   ← the record's SECOND run
    │                 ▲ ◆status says "completed" for all of it.  ← AD2, AE5
    │                 ▲ ◆verifyPhase is the only field that disagrees
    ▼
  .finally         settlementCount++ · outputLog finalised · slot released
                   tallyCompletion ──▶ notifyComplete ──▶ onComplete
                   drainQueue · gate opened · ◆settled := true
                                  │
                                  ▼
                    the FOREGROUND Agent tool call unblocks here
```

The **completion gate** is the invariant worth knowing: every record carries a
promise from birth, opened exactly once, never assigned the run's own promise.
Seven paths open it, so a foreground `Agent` call can never hang on a record that
will not settle.

### 4.2 The turn ceiling, and who can reach a stop

```
   normalizeMaxTurns(n): 0 → unbounded · absent → 40 · else max(1, n)

   turn_end, turnCount++
        ├── maxTurns == null ─────────────────────────────▶ nothing, ever
        ├── !ceilingReached && turnCount >= maxTurns
        │      graceTurns <= 0 → abort   ·  > 0 → wrap-up steer      V6 W4 T1
        │      …and NEITHER for maxTurns === 1, which reaches its ceiling by
        │      FINISHING
        └── ceilingReached && turnCount >= maxTurns + graceTurns → abort

   stopAgent(record)                who can reach it
        verifying? → verifyAbort     Esc ✔ · /agents ✔ · StopAgent ✔(AD2)
                                     · the conversation VIEWER ✘ AE5 → ✔
        queued?    → spliced out     all four ✔
        running?   → abortController all four ✔
        else       → false
```

The `stopAgent` half of that table has been right since the eleventh pass. The
*"who can reach it"* column is what AD2 added, and AE5 is its fourth entry: the
viewer is where an operator watching a delegation actually is, and it was the one
surface still hiding the action.

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
     counts from the holders.

   the default is 1, and the reason is measured rather than assumed:
     a subagent having its OWN system prompt does NOT by itself evict the
     parent's cached prefix (99.2% hit across six small child turns).
     What evicts it is SIZE — a child that grew to 18k tokens took the
     parent's next call from 2,117 cached tokens to zero, 442 ms → 2,949 ms.

   the key a slot is looked up by is `${model.provider}/${model.id}` —
   which is why AD1 collapsed per-model slots onto one, and why AE6 did the
   same for a case-different name and for any agent the discovery retry found.
```

### 4.5 The model precedence, and the two keys it was resolved against

This is AE6 drawn out, because the precedence itself is fine and the defect is
entirely about *which name* it is applied to.

```
   resolveModel(), six rungs, highest first
     1. sessionOverrides[type]        ← /agents → models, session layer
     2. sessionOverrides["default"]
     3. config.agent[type]            ← /agents → models, global/project layer
     4. config.agent["default"]
     5. agentConfig?.model            ← the agent .md's frontmatter
     6. parentModelId                 ← always a valid string, so 1–5 can be
                                        silently skipped without any signal

           ┌───────────────────────────────┬──────────────────────────────┐
           │ toolCallListener              │ executeAgentTool             │
           ├───────────────────────────────┼──────────────────────────────┤
   name    │ input.agent, VERBATIM         │ resolveTypeWithDiscovery()   │
           │ — the string the model wrote  │ — the canonical registered   │
           │                               │   name, case-folded          │
   when    │ at the tool_call event        │ after a filesystem RE-SCAN   │
           │                               │   that can add agents        │
           ├───────────────────────────────┴──────────────────────────────┤
           │ rungs 1 and 3 are keyed by NAME, and `/agents` writes those   │
           │ keys from getAllTypes() — the canonical ones. So `explore`    │
           │ missed a pin written for `Explore`. Rung 5 needs a config     │
           │ the listener does not have yet for a worktree-local agent,    │
           │ so it fell through to rung 6 — the parent's model.            │
           └──────────────────────────────────────────────────────────────┘

   NOW: one resolver, `resolveSpawnModel(canonicalType, ctx)`, called from both
   ends; the listener canonicalises what it can and STAMPS the key it used;
   the tool trusts the injection exactly while the stamp names the type it is
   spawning, and re-resolves otherwise.
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
   repair  knows MORE — it continues the child's own session, because that is
           the only place with the context to actually fix the answer.

   unparsed counts as ADDRESSED. A judge that answered in a shape nobody asked
   for is evidence about the JUDGE, not about the answer.
```

### 5.3 The flag it hangs on, and what AE5 is about

The verifier has **no carrier of its own** — it rewrites `record.result` in place
— and it has **no status of its own** either. `lifecycle.status` describes the
child's run and went terminal before the first judge call; `verifyPhase` is the
whole of what says otherwise, and it is a display field by origin.

```
   the moment a record is doing work and does not say so
   ─────────────────────────────────────────────────────────────────────
     .then   status := classifyRun(result)          ← "completed"
             ├── runVerification()
             │     verifyAbort = new AbortController()
             │     ├─ structural gate  (free)       ← no phase yet
             │     ├─ verifyPhase = "judging"       ← NOW it says so
             │     ├─ verifyPhase = "repairing"
             │     └─ finally: verifyPhase = undefined
             └── slot released, gate opened
   ─────────────────────────────────────────────────────────────────────
   readers of "is this busy", and what each one used to ask
     agent-widget                isBusyRecord    ✔ (first, and the reason
                                                    the module exists)
     /agents running-agents      isBusyRecord    ✔ (Y1)
     AgentManager.clear          isVerifying     ✔ (Y1)
     AgentManager.stopAgent      isVerifying     ✔ (T5)
     StopAgent tool              isBusyRecord    ✔ (AD2)
     formatRunningAgents         isBusyRecord    ✔ (AD2)
     AgentStatus TOOL            status pair     ✘ AE5 → ✔
     conversation viewer Stop    status pair     ✘ AE5 → ✔
     session_shutdown warning    status pair     ✘ AE5 → ✔
```

Nine readers, one question. Three passes have now moved a group of them, which
is the tell §14 is about.

### 5.4 What it cannot do

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
         {compaction}, pi never reads previousSummary at all. The notice says
         what was DONE, not what pi will do with it.

  2. tool_result              cap ONE tool result against what context is LEFT
       allowance = f(window - tokens), floor 1,500, ceiling 20,000
       overflow spilled to a file the marker names; 50 files kept
       ← this is what bounds a FOREGROUND subagent's answer, for free

  3. context                  show the model its own budget above 60%
       stands down when a `-context-budget` message is already present
```

The measurement it exists for: the carried-over summary grew 456 → 4,029 →
11,054 chars across 42 real compactions, monotonically, because pi's own update
prompt says PRESERVE. And on 2026-08-17 the CRITICAL notice was in context at
84.5% — "do not run commands with large output this turn" — and the model ran a
curl loop that returned 17,790 characters, taking the window to 100%. Telling it
does not stop it, which is why cap 2 exists.

It keeps exactly one flag, `spillDir`, and it is the only one in the stack with
no falsifier at all: created on first use, bounded by count rather than by a
teardown, precisely because a parent and a child share it.

---

## 7. `prinny-channel`

Seven handlers, a `/prinny` command, a `prinny` tool, and a sidecar child process
speaking MCP over stdio. The only path in the stack with a **second human** on it
— and, not coincidentally, four of this pass's seven findings.

### 7.1 The room entry, which is the flag three of them are about

```
   awaitingReply : Map<roomId, {
        messageId          what to quote-reply
        injected           EXACTLY what pi was handed — markLive matches it
        question           what was asked, for a continuation to restate
        at                 when, for the delivery grace
        live       ◆       pi has taken something from this room
        answered   ◆       something has been sent for it
        emptyRetries       continuations spent on it
        undeliveredReported
   }>

   ONE entry per room, and that is the design: `forwardToMatrix` refuses to
   send when more than one room is live, because with two there is no way to
   tell whose answer this is. The price is that a second message from the same
   room has to be FOLDED IN rather than replacing what is there —
   `mergeAwaiting`, and AE3 is what it was like before.

   the rules, and each is a "never throw evidence away":
     live       only ever goes UP. A second message cannot un-take the first.
     injected   only a message pi was GIVEN becomes the room's marker. A
     messageId  `/compact` is not one, and overwriting them would leave
     question   markLive matching a string pi will never emit.
     answered   reset only when a new question was actually handed over.
```

### 7.2 What happens to a message with a leading slash — the whole decision

```
   body
    ├ not a string                                   → text
    ├ does not start with "/"                        → text
    ├ contains a newline                             → text
    ├ /^\/([a-zA-Z][\w-]*)\s*(.*)$/ does not match   → text
    ├ name ∉ KNOWN_COMMANDS                          → text        ← AD5 was here
    ├ name ∈ MATRIX_LOCAL                            → local
    │   the one entry is `compact`; this file performs it
    ├ name ∉ MATRIX_ALLOWED                          → refuse
    ├ rest contains a REFUSED_FLAG                   → refuse      ← AD6, AD7
    │   --model · --rescue-model · --check
    ├ MATRIX_ALLOWED[name] === null                  → run  (whole command)
    └ first arg ∈ MATRIX_ALLOWED[name]               → run  (else refuse)

   …and the answer is now computed BEFORE the room entry is written, because
   `local` and `refuse` are exactly the kinds that must not become the room's
   marker. That is AE3's other half.
```

### 7.3 `agent_settled`, in order, because AE2 and AE4 are both here

```
   agent_settled
     │
     ├─ agentRunning = false          ◆ the typing gate, and planCompaction's
     ├─ stopTyping()                    "is a turn in flight" answer
     │
     ├─ const started = await forwardResult()
     │    │
     │    ├─ forward:"result" && lastAssistantText → forwardToMatrix
     │    │
     │    ├─ lastRunEmptyEnding.empty?
     │    │    waiting := live rooms
     │    │    canRetry (each < MAX_EMPTY_RETRIES)?
     │    │      ├─ YES  emptyRetries++
     │    │      │       ┌──────────────────────────────────────────────┐
     │    │      │       │ AE4: the room stands back DOWN               │
     │    │      │       │   entry.live = false                         │
     │    │      │       │   entry.injected = nudge                     │
     │    │      │       │   entry.at = now                             │
     │    │      │       │ so markLive is the evidence again, and a     │
     │    │      │       │ nudge pi never takes is reported by the      │
     │    │      │       │ sweep instead of leaking somebody else's     │
     │    │      │       │ answer into the room                         │
     │    │      │       └──────────────────────────────────────────────┘
     │    │      │       api.sendUserMessage(nudge, {followUp})  ← STARTS A RUN
     │    │      └─ NO   giveUpMessage(detail) to each waiting room
     │    │
     │    ├─ retire every LIVE room (unless a continuation was started)
     │    ├─ alreadySent.clear() · stopTyping() · sweepUndelivered()
     │    └─ return retrying
     │
     └─ standAside(pendingCompaction, started)
          ├─ wait  → keep it; the continuation's own settle will drain it
          │          bounded by MAX_EMPTY_RETRIES, so a continuation that
          │          never starts cannot starve the sender's request  ← AE2
          └─ else  → drainPendingCompaction() → ctx.compact()
                                                 └─ pi: `await this.abort()`
```

### 7.4 The undelivered sweep

```
   an entry is REPORTED as undelivered when, and only when:
     · the session is IDLE                 (agentRunning === false)
     · and `answered` is false             ← AC4: was it ever pi's to take?
     · and `live` is false                 ← AB2: did pi echo it back?
     · and `undeliveredReported` is false
     · and it is older than DELIVERY_GRACE_MS (60 s)

   idleness is the load-bearing half, not the clock: a message delivered while
   pi is streaming drains inside that same run.
```

AE4's repair is worth noting here rather than only in §9: it did not add a
mechanism. It put the retry back into the one that already existed, and the
sweep — written for a message pi refused — now covers a *continuation* pi refused
with the same sentence, because it is the same failure.

### 7.5 The typing indicator, and why 8 seconds

Matrix expires a typing indicator at 20 s. A 27B thinks for longer than that
between visible tokens, so the indicator is refreshed every 8 s while
`agentRunning` — and cleared in `agent_settled` *before* the answer is forwarded.

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

The allow-list is 23 commands and **every entry is a measurement**. It is also
the only extension in the stack that keeps no state at all, which is why it has
no row in §2 and no finding in this pass.

---

## 9. Findings

Every finding below is PROVEN by an execution, fixed, and carries a regression
test that fails when the fix is removed.

### AE1 — the pause that kept running · **HIGH** · PROVEN · **FIXED**

**What it was.** `agent_end`'s operator-abort rung:

```js
   if (stopReason === "aborted") {
     state.status = "paused";
     state.lastNotice = "Turn aborted by operator. Use /loop resume to continue.";
     persistState(pi);
     logIteration("operator_abort");
     notify(ctx, "Loop paused (turn aborted). Use /loop resume to continue.", "warning");
     ctx.ui.setStatus("loop", "Loop paused (aborted)");
     return;
   }
```

`state.status` is a display field. `state.active` is the one every handler tests,
and it was left `true`. So the loop had told the operator it was paused and had
not paused: the next `agent_end` from any source ran the whole ladder,
incremented `iterationCount`, and fell through to `scheduleLoopTurn` — no notice,
no record, and the operator's `/loop resume` never involved.

The other four ways a run stops short all clear it:

```
   pauseForContextFailure    runToken++ · state.active = false
   pauseForCheckFailure      runToken++ · state.active = false
   pauseForProviderFailure   runToken++ · state.active = false
   the iteration cap                     state.active = false
   the operator's Esc                                            ← nothing
```

**What produces the next turn.** Not an exotic event. `/loop status` is a slash
command and produces none, but:

- a question typed into the terminal — the likeliest, because the operator has
  just been shown a notice inviting a reply;
- a Matrix message (`prinny-channel` → `sendUserMessage` → `prompt()`);
- a background subagent settling (`SpawnCoordinator.emitIndividualNudge` →
  `sendMessage({triggerTurn: true})`), which needs no human at all.

**The second half.** `before_agent_start` is gated on the same flag, so every
operator-typed turn during the "pause" carried *"Loop mode is active. Goal: … Keep
every assistant response under 1,200 characters, do one progress batch per turn,
… never wait for a human"* — an instruction set that is wrong in every clause for
a person asking a question.

```
   r1, the shipped loop module through _host.mjs:
                                            BEFORE            NOW
     /loop status after the Esc         : Active: true     Active: false
     the next turn scheduled            : loop/continue    (nothing)
     that turn counted as an iteration  : 1/∞              0/∞
     before_agent_start injected        : "Loop mode is    (nothing)
                                           active. Goal…"
```

**The fix.** `runToken++` and `state.active = false`, matching the other four,
with the reason in the comment. Nothing is lost for the resume — `/loop resume`
needs only `state.description` — and `session_start`'s auto-resume has always
ignored `paused`.

**Control.** `r1 control`: an ordinary turn must still schedule the next
iteration, still count it, and still tell an operator-typed turn that a loop is
running.

---

### AE2 — the compaction that cancelled its own continuation · **MEDIUM** · PROVEN · **FIXED**

**What it was.** AD3 deferred a mid-turn Matrix `/compact` to `agent_settled`,
and its module header gives the reason in one sentence: *"by then aborting costs
nothing because the run is over."* The handler:

```js
   agentRunning = false;
   stopTyping();
   await forwardResult();       // ← the empty-turn continuation is sent from here
   drainPendingCompaction();    // ← ctx.compact() → pi: `await this.abort()`
```

`forwardResult` is where `continuation.ts` lives, and its own comment states the
same premise from the other side: *"a follow-up, not a steer: nothing is in
flight at agent_settled."* Two modules agreeing about a moment, and the first
falsifying it for the second.

**Why the two conditions arrive together.** They are correlated rather than
independent. A sender asks for a compaction *because* the bot has gone slow or
quiet; an empty ending is what quiet looks like from inside; and
`describeEmptyEnding`'s `context` reason is a window at 87% or more — which is
the state a compaction is for.

**Both interleavings are bad.** If `prompt()` has reached `_runAgentPrompt`, the
abort kills the continuation. If it has not, `compact()` sets
`_compactionAbortController` and `prompt()` either starts a run *during* a
compaction or hits the `:808` throw — a rejection pi `.catch`es into `emitError`,
which has no listeners headless. Silent either way.

```
   r3 [settling-together], the real extension over the real sidecar protocol:

     what agent_settled did, BEFORE          what it does NOW
     ────────────────────────────────        ────────────────────────────────
     1. notify "asking again"                1. notify "asking again"
     2. sendUserMessage(nudge)               2. sendUserMessage(nudge)
     3. notify "compacting"                  (the request stands aside)
     4. ctx.compact() → abort                ── the continuation runs ──
                                             3. notify "compacting"
                                             4. ctx.compact() → abort
                                                …and now there is nothing
                                                to abort
```

**The fix.** `forwardResult()` returns whether it started a continuation, and
`standAside(pendingCompaction, continuationStarted)` in
`src/compaction-request.ts` decides. Bounded by `COMPACTION_DEFER_LIMIT`, which
is `MAX_EMPTY_RETRIES` read from the module that owns it — because the thing it
stands aside for is exactly that mechanism, and a continuation that never starts
(AE4) must not starve a request the sender was told would happen "as soon as it
finishes".

---

### AE3 — the room entry a second message destroyed · **HIGH** · PROVEN · **FIXED**

**What it was.** `awaitingReply` is a `Map` keyed by room, holding one entry, and
`deliverInbound` wrote a fresh one for every inbound message:

```js
   awaitingReply.set(room, { messageId, at: Date.now(), answered: false,
                             injected: text, question, live: false });
```

`live` is not a property of a message. It is evidence about the **room** — pi has
taken something from it and owes it an answer — and `forwardToMatrix` filters on
it precisely so that an answer only ever goes to a room that is owed one.

So a second message reset the evidence for the first. For two ordinary questions
that self-corrects within the same run: pi echoes the second, `markLive` fires
again, and the answer goes out (attributed to the newer message). For a message
this extension answers **itself** it does not, and cannot: a refused command, an
allowed one, and `/compact` all produce no user message, so `markLive` has
nothing to match, forever.

The sequence is one person, one room, two messages:

```
   $a1  "what is the status of the build?"   → handed to pi, echoed, LIVE
   $a2  "/compact"                           → deferred (AD3), and the entry
                                               is replaced: live=false,
                                               answered=true
   …the model finishes answering $a1
   agent_settled → forwardResult → forwardToMatrix(text)
                 → rooms = live rooms = []  → return
```

The answer was discarded. And `answered: true`, set by the local branch on the
way past, kept the undelivered sweep quiet about it too — so the sender got
nothing at all and no explanation, having done nothing wrong.

```
   r3 [same-room]:
                            BEFORE                    NOW
     what the room received  []                       ["The build is green — …"]
```

**The fix.** `mergeAwaiting(previous, arrival)` in `src/delivery.ts`, and the
classification moved above the write because the entry depends on it. Two rules,
both "never throw evidence away": `live` only goes up, and a message pi was never
given does not become the room's marker, question or reply target.

---

### AE4 — the continuation that was claimed, not evidenced · **HIGH** · PROVEN · **FIXED**

**What it was.**

```js
   retrying = true;
   for (const [, entry] of waiting) entry.emptyRetries = (entry.emptyRetries ?? 0) + 1;
   try {
     api.sendUserMessage(nudgeForEmptyEnding(reason, question), { deliverAs: 'followUp' });
   } catch (err) {
     log(`could not continue the run: ${err}`);
     retrying = false;
   }
```

The `catch` sees exactly one thing: a synchronous `assertActive()` throw on a
stale extension runtime. Everything else — `prompt()` refusing during a
compaction, no model selected, no provider auth, which on this stack means the
llama-server is down — rejects a promise **pi itself** `.catch`es into
`emitError`, whose listener set is empty outside a TUI. This is the fact
`delivery.ts`'s own header is about, one direction over: it is why the inbound
sweep exists, and the retry was written as though it did not apply.

`retrying` is what suppresses the retirement of every live room at the bottom of
`forwardResult`. So a continuation that never happened left the sender's room
`live: true, answered: false` — and the next unrelated turn's answer was
forwarded to it.

That last step is the whole severity. `markLive` exists, in its own words, so
that *"the answer to the operator's private local work"* is not *"forwarded to
whoever just messaged"*. AE4 reaches that state from the other side, and there is
no window in which it self-corrects: the room stays live until some turn's answer
goes to it.

```
   r3 [never-taken]:
     the operator asks, in the terminal : "what is in ~/.ssh/config?"
     what the Matrix room received      BEFORE  ["Host prod / HostName 10.0.0.4 / …"]
                                        NOW     []
     and, after the 60 s grace          NOW     ["I could not hand that to the
                                                  session … please send it again"]
```

**The fix.** Not a better flag — the same evidence the first delivery uses. Before
the nudge is sent the room stands back **down**: `live = false`, `injected =
nudge`, `at = now`, `undeliveredReported = false`. Then:

- pi takes it → echoes it → `markLive` matches the nudge → the room is
  answerable again and the continuation's answer reaches it;
- pi refuses it → the entry is not live, not answered, past the grace on an idle
  session — which is precisely `undeliveredRooms`, and the sender is told the one
  true thing.

The failure stopped being invisible without anything new being built to see it.

---

### AE5 — three readers of a status that describes a different run · **MEDIUM** · PROVEN · **FIXED**

**What it was.** `attachSettlementChain` writes `lifecycle.status` from
`classifyRun` and *then* awaits `runVerification`, so throughout a judge and up to
three repairs the record reads `completed` while a model call is in flight on the
one llama slot the parent is queued behind. `record-activity.ts` exists to be the
single answer to "is this record busy". After AD2, three readers still had their
own copy:

**`AgentStatus`**, and this is the one that matters, because it is the tool the
parent model reaches for to ask *"what is still happening"*:

```js
   export function isUnfinished(record) {
     return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
   }
```

A verifying record therefore fell into the **settled** bucket — so it was not
merely mislabelled `completed`, it became eligible for `MAX_SETTLED_LISTED`, whose
own comment says *"A running or queued agent is actionable and is never dropped,
however many there are"*. With seven or more finished agents behind it, the one
agent holding the slot was elided from a reply that ends `Don't poll — you'll
receive notifications when agents complete.`

**The conversation viewer's Stop.** `isActive()` gates `isStoppable()`. T5 made a
verifying record stoppable in the manager, `/agents` could reach it, AD2 gave the
`StopAgent` tool the same reach — and the viewer, which is where an operator
watching a delegation actually is, still hid the action.

**The reload warning.** `session_shutdown` counts "N agent(s) killed by reload"
with the same status pair, two lines above `mgr.dispose()`, which disposes the
session a repair is running in. The one agent the reload was about to cut off was
the one the count left out.

**The fix.** All three ask `isBusyRecord`, and `AgentStatus` prints
`completed (answer being checked)` — the child's own verdict kept, because it is
also true, with the fact that decides whether to wait added to it.

---

### AE6 — the model override, and the two names it was keyed on · **MEDIUM** · PROVEN · **FIXED**

**What it was.** AD1 (thirteenth pass) made `executeAgentTool` read the model
`toolCallListener` injects, closing a six-level precedence that had been resolved
and discarded. That fix is correct, and it is also a **new mechanism**: the
listener's answer became the one the spawn obeys, so the key the listener
resolved it against became the key the whole precedence hangs on.

```
   toolCallListener   getAgentConfig(input.agent)   ← the string the MODEL wrote
                      modelFor(input.agent, …)      ← and the registry AS IT STANDS

   executeAgentTool   resolveTypeWithDiscovery()    ← the CANONICAL name, after
                                                      a filesystem RE-SCAN
```

Two differences, both reachable:

1. **Case.** `resolveType` is deliberately case-insensitive — it exists so a
   spawn by a slightly-wrong name still works, and `getAgentConfig` folds case
   too. `resolveModel` does not: it reads `sessionOverrides[type]` and
   `config.agent[type]`, and `/agents` → models writes those keys from
   `getAllTypes()`, i.e. under the canonical name. So an operator's pin on
   `Explore` was silently skipped for `agent: "explore"` — and
   `renderAgentToolCall` printed the *unpinned* model beside the call, so the
   display agreed with the miss.

2. **Time.** An agent that only becomes resolvable on the **discovery retry** —
   one added to the filesystem after startup, or living in a worktree's
   `.pi/agents/`, which is the case the retry exists for — has no config at
   listener time. `resolveModel` falls past its frontmatter rung to
   `parentModelId`, the tool honours that, and `agent-runner`'s own
   `options.model ?? findModelInRegistry(agentConfig?.model, …)` cannot rescue it
   because the tool always supplies the left side. **That is AD1's damage
   exactly** — the child on the parent's model, holding the parent's concurrency
   slot — restored for one class of agent.

```
   r2, the real listener and the real tool through pi's own jiti:

     an operator pin on `Explore`         BEFORE              NOW
       agent:'Explore' runs on        : forge/qwen3.8-27b  forge/qwen3.8-27b  (control)
       agent:'explore' runs on        : forge/qwen3-4b     forge/qwen3.8-27b
       …and the TUI printed           : ▸ Explore (qwen3-4b)  ▸ Explore (qwen3.8-27b)

     an agent only discovery can find     BEFORE              NOW
       the child runs on              : forge/qwen3.8-27b  forge/qwen3-4b
       …and holds the slot            : forge/qwen3.8-27b  forge/qwen3-4b
```

**The fix.** One resolver — `resolveSpawnModel(canonicalType, ctx)` and
`resolveSpawnThinking(canonicalType)` — called from both ends. The listener
canonicalises the name with `resolveType` before resolving anything, injects
nothing when the name resolves to nothing, and **stamps** the key it used as
`input._resolvedAgent`. The tool trusts the injection exactly while the stamp
names the type it is about to spawn, and re-derives otherwise.

AD1's read survives, and is now conditioned rather than unconditional — which is
what makes the difference between the two ends askable at all.

---

### AE7 — the boundary one walk crossed and its sibling stopped at · **LOW** · PROVEN · **FIXED**

**What it was.** `describeEmptyEnding` and `finalAssistantText` are a pair: the
first decides whether the run answered, the second produces what it said. They
walk the same array backwards, and `finalAssistantText`'s header explains why it
stops at a `user` message — a 2026-08-17 incident in which walking past one
delivered the previous turn's deliberation to Matrix as an answer.

`describeEmptyEnding` did not stop there. Its loop was:

```js
   if (isBackgroundSubagentResult(value)) continue;
   if (!value || value.role !== 'assistant') continue;   // ← crosses a user message
```

So a walk that had already stepped over an injected `subagent-result` pair could
leave the run's own tail and find an answer from **before** the message being
answered — and report `empty: false` for a run that had answered nobody. The
comment above that step-over says the boundary "is never crossed", and it was
true of `finalAssistantText` and false of the function it is written in.

The reachable shape is one pi produces without contrivance:

```
   assistant  "Here is the answer to what YOU asked in the terminal."
   user       "[matrix] and what about the watermarking?"      ← drained as a
   custom     subagent-result                                     follow-up, with
   assistant  [thinking]  — reasoning-only, since 2026-08-17      a settled agent
```

`describeEmptyEnding` → `empty: false`; `finalAssistantText` → `""`. Nothing
forwarded, no empty ending, no continuation, and the room retired. The sender got
silence and no notice.

**The fix.** The walk stops at a `user` message, like its sibling, and reports
`empty: true` when it has already passed an empty assistant tail. `sawEmptyTail`
keeps it narrow: a run with no assistant message at all is still `empty: false`,
which is what it has always been and what the suite pins.

---

## 10. Fixed alongside, and worth naming

**`deliverInbound` classifies before it records.** The reordering is AE3's
mechanism, and it is worth its own sentence: the entry now depends on the answer
("was this pi's to take"), so computing the answer afterwards was not a style
question.

**`forwardResult` returns something.** It used to return `void`, which is why
AE2's ordering was invisible — the handler could not have asked. A function whose
side effect is starting a run should say that it did.

**The live view's tool map was keyed on a millisecond.**
`SpawnCoordinator.createLiveViewCallbacks` did
`view.activeTools.set(`${activity.toolName}_${Date.now()}`, …)` under a type
comment that said `keyed by toolName_timestamp`. Two calls to the same tool
starting in the same millisecond collapse to one entry, the second `end` finds
nothing to delete, and the widget shows a tool still running after it finished —
for the rest of the child's run, because nothing else clears the map. pi
dispatches a turn's tool calls together, so that is the ordinary case for a
parallel batch. `Watchdog.recordActivity` has keyed on `toolCallId` since it was
written and carries the note this needed: a *synthetic* end event
(`extension-error:…`) has no id, so the by-name fallback is kept for exactly that
case. Cosmetic — it is the widget's activity line — and listed here because it is
the same shape as the ledger's rows: a key that claims to identify a call and
identifies a moment.

**The probes gained a driveable sidecar.** `context/testing/probes/_sidecar.mjs`
speaks the real MCP protocol and is driven by two files, so a probe can deliver a
second inbound message at a moment it chooses and read back exactly what the
extension said to Matrix. `tests/fixtures/fake-sidecar.mjs` is unchanged and
still right for its own suite; it sends one message, at a moment it chooses, and
throws its tool calls away — which is why AE2, AE3 and AE4 could not have been
executed without this.

---

## 11. Still open, and why — decisions, not omissions

**11.1 `answered` is still set on three branches by the act of replying**, not by
evidence that the reply arrived. That is AD4's residue and is unchanged: there is
no observable, and the claim was narrowed instead.

**11.2 SIGTERM-from-outside on a goal check.** Unchanged from the eleventh pass:
bash runs its `EXIT` trap when SIGTERMed, so the marker is present and `$?` is
whatever the last command left. The marker is proof of *completion*, not of
*intent*.

**11.3 The watchdog still skips a verifying record**, and `Watchdog.check()`
deletes its state rather than merely skipping it. Harmless and deliberate: the
per-call deadline is minutes where the watchdog is 45 of them, and
`continueSettledAgent` calls `watchdog.start()` again for any later run. Note
that this is a *fourth* reader of `lifecycle.status` and was deliberately left
alone — AE5 moved the three where the answer was wrong, not the one where it is
right.

**11.4 A `--check` is a shell channel no `tool_call` handler can see**, from the
loop tool as well as from `/loop`. Closed from Matrix (AD6); left open from the
tool and the terminal, where the caller is already inside the trust boundary.

**11.5 `agentRunning` is false for the width of one `await` chain** — between
`sendUserMessage` being called and `agent_start` firing. The only reader that
would care is `planCompaction`, and the worst case is a `/compact` that aborts a
run which has not started streaming. Left alone: closing it means inventing a
second "a turn is coming" flag with no event to clear it, which is a worse
version of the same problem.

**11.6 `parseJudgeVerdict` reads `UNADDRESSED` as ADDRESSED** on the
`VERDICT:`-line path (the prose path is anchored and does not). Left alone,
recorded in the twelfth and thirteenth passes, and re-derived here so the next
reader does not have to.

**11.7 Two extensions can call `ctx.compact()` on the same `agent_settled`.**
`pi-loop-mode`'s handler runs first and may request an emergency compaction;
`prinny-channel`'s runs second and may drain a deferred one. Nothing coordinates
them, and pi's `compact()` does not refuse a second call — it aborts, overwrites
`_compactionAbortController`, and proceeds. AE2 closed prinny's half (it no longer
compacts into a run it started); the cross-extension half is untouched, because
the two conditions require a Matrix `/compact` and a loop context recovery in the
same settlement, and the honest fix is a shared "a compaction is in flight" flag
that neither package owns. Recorded rather than guessed at.

**11.8 Still open by decision from earlier passes**, each with a reason in §11 of
`…-controls.md` and §10.4 of `…-deliveries.md`: the Matrix command sweep's blind
spot, the brief-before-session window, `hasStateChange`'s keyword list, T6,
per-session loop state, T1's general case, and resuming a completed run.

---

## 12. What shipped

### The seven findings

| # | file | the change | control run |
| --- | --- | --- | --- |
| AE1 | `pi-loop-mode/extensions/index.ts` | `runToken++; state.active = false` on the abort rung | `r1 aborted` shows `Active: true` + a scheduled `loop/continue` in the BEFORE column; 1 test fails with the fix removed |
| AE2 | `prinny-channel/src/compaction-request.ts`, `extensions/index.ts` | `standAside()`, and `forwardResult()` returns whether it started a run | `r3 settling-together`; 1 test fails |
| AE3 | `prinny-channel/src/delivery.ts`, `extensions/index.ts` | `mergeAwaiting()`, and classification moved above the write | `r3 same-room` receives nothing in the BEFORE column; 1 test fails |
| AE4 | `prinny-channel/extensions/index.ts` | the room stands down until `markLive` fires for the nudge | `r3 never-taken` forwards the operator's answer to Matrix in the BEFORE column; 3 tests fail |
| AE5 | `pi-subagents-lite/src/agents/status-listing.ts`, `ui/conversation-viewer.ts`, `src/events.ts` | `isBusyRecord` at the three remaining readers; `listedStatus()` | `r2` is AE6's, but the AE5 suite drops 4 tests with the fix removed |
| AE6 | `pi-subagents-lite/src/agents/tool-execution.ts` | one resolver, the canonical name, and the `_resolvedAgent` stamp | `r2` prints both columns for both halves; 2 tests fail |
| AE7 | `prinny-channel/src/forwarding.ts` | the walk stops at a `user` message, like its sibling | 1 test fails |

### The gates

```
   ( cd vendor/pi-loop-mode       && npm test && npm run lint )          # 199
   ( cd vendor/pi-subagents-lite  && npm test && node tests/lint.mjs )   # 289 + 85/85
   ( cd vendor/prinny-channel     && npm test && npm run lint )          # 357
   ( cd .pi/extensions/compaction-guard && npm test )                    #  41
   ( cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts )  # 20
                                                                          ─────
                                                                           906
```

### The test that had to be reworded rather than replaced

`vendor/pi-subagents-lite/tests/tool-surface.test.ts` pinned AD1 as
`assert.match(execution, /findModelInRegistry\(\s*params\.model as string \| undefined/)`
— a *text* pin over one expression. AE6 conditioned that read, which would have
broken the pin while leaving AD1's fact intact.

It was widened rather than deleted, and a second pin added beside it: the tool
reads `params.model` **and** asks whether the stamp names the type it is
spawning; the listener canonicalises the name **and** writes the stamp. The
thirteenth pass's lesson about absence assertions has a sibling here: **a text
pin over one expression cannot tell a change in the expression from a change in
the behaviour.** The executed evidence is `r2`, which is where it belongs.

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
( cd vendor/pi-loop-mode && node --experimental-strip-types --test tests/turn-counters.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/status-listing.test.ts tests/tool-surface.test.ts )
( cd vendor/prinny-channel && node --experimental-strip-types --test \
    tests/delivery.test.ts tests/compaction-request.test.ts tests/forwarding.test.ts )

# this pass's probes — one process per mode, because the state is module-global
P=context/testing/probes
for m in aborted control;   do node --experimental-strip-types $P/r1-the-pause-that-keeps-running.mjs $m; done
node $P/r2-the-name-the-override-is-keyed-on.mjs
for m in same-room settling-together never-taken control; do
  node $P/r3-the-compaction-that-cancels-its-own-continuation.mjs $m
done
# …and the slow one, which waits out DELIVERY_GRACE_MS to watch the sweep report
PROBE_SLOW=1 node $P/r3-the-compaction-that-cancels-its-own-continuation.mjs never-taken

# every probe, exit code only
for f in context/testing/probes/[a-z]*.mjs; do
  timeout 240 node --experimental-strip-types "$f" >/dev/null 2>&1 || echo "FAIL $f"
done
```

| probe | what it shows | the control |
| --- | --- | --- |
| `r1` | the shipped loop module driven through an aborted turn and then one more `agent_end`: `Active: false`, nothing scheduled, nothing injected into the operator's turn. BEFORE, the same three events restarted the run | mode `control`, an identical run whose turn was not aborted, which must still schedule, still count, and still inject the loop rules |
| `r2` | the real `toolCallListener` and `executeAgentTool` through pi's own jiti, over both halves — an operator pin missed by a case-different name, and an agent's frontmatter lost to the discovery retry — with the TUI's rendered value beside each | a delegation by the exact registered name, byte-identical in both columns; and AD1's own control, that the stamped injection is still what the spawn uses |
| `r3` | the real `prinny-channel` over the real sidecar protocol: a `/compact` from the room that is waiting (`same-room`), an empty turn and a deferred compaction settling together (`settling-together`), and a continuation pi never took (`never-taken`, plus `PROBE_SLOW=1` for the sweep) | mode `control`: one question, one answer, and the turn after it, which must go nowhere near Matrix |

---

## 14. The pattern across fourteen audits

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
```

Three things transfer out of this one.

**A flag is a cache, and every cache has an invalidation problem.** That is the
whole of §2 said in one line, and it is why the ledger is organised by
*falsifier* rather than by writer. `state.active` is a cached answer to "is this
loop driving the session"; `entry.live` caches "does this room have an answer
coming"; `lifecycle.status` caches "is this record working"; `params.model`
caches a six-level resolution. Every one of the seven findings is a write that
should have invalidated a cache and did not. The habit that follows is not "reset
more things" — it is: **when you write a flag, go and find everything that can
make it false, and check that each of those places knows the flag exists.** The
five that failed all had a falsifier that was somewhere else: a different branch,
a different extension, a later scan, a promise somebody else catches.

**"Nothing is in flight here" is a claim about the future, and the code below it
is what makes it false.** AD3 wrote that claim about `agent_settled`; three lines
later the same handler starts a run. `continuation.ts` wrote the same claim from
the other side. Neither was careless — the claim was true when each was written,
and each was made false by the other. So: **when a comment says what is or is not
happening at a moment, list what runs at that moment, including the rest of the
function you are in.** It costs one read of the enclosing handler.

**A fix is a new mechanism, and the pass that ships it is the last one to look at
it with fresh eyes.** This is the thirteenth pass's lesson, and it repeated: AE2
and AE6 are AD3's and AD1's own fixes one layer out, and AE5 is AD2's predicate
at the callers AD2 did not visit. It repeated with the *same shape* both times —
a fix that is correct in the thing it was aimed at, and that becomes the load
path for something the aim did not include. The second question stands and is
worth a third phrasing: **this fix is now a mechanism; what does the rest of the
machine now believe because of it, and who could make that false?**

---

## 15. Still unwatched

Everything above is fixed against probes and tests, and none of it against a
running model. That has been true for eleven passes now, and the list has barely
moved. `r3` is the first probe in the series that drives a whole extension over
its real transport, which narrows what "unwatched" means for `prinny-channel` —
but it is still a stub host, and the model is still the thing nobody has run.

1. **§B and §P of `context/testing/subagents-loop-verifier.md`** — one background
   delegation, and the only question is whether the result appears in the
   conversation at all. Still the cheapest run on the list.
2. **§Q — the model override, end to end**, which is now the run that would show
   AE6 as well as AD1: with a per-type override configured, spawn the SAME agent
   twice, once by its exact name and once in the wrong case.
3. **§M, §M.2, §M.3** — three `/loop start`s with different `--check`s and
   `/loop status` after each. Five findings across four passes sit there.
4. **A new one, and it is one keypress: press Esc on a loop turn, then type a
   question.** That is AE1 end to end and it needs no subagent, no verifier and
   no Matrix account. `/loop status` must still say `Active: false` afterwards.
5. **§S and §O** — a Matrix `/compact` while a loop is running, and now the
   variant AE2 and AE3 are about: send `/compact` from the room that is waiting
   for an answer, and check that the answer still arrives.
6. **A real verification**, foreground, `SUBAGENT_VERIFY_ROUNDS=1`, deliberately
   off-task brief — S2, U4, U8, V5, V7/W6, W5, Y1, Z1, T5, AB4, AD2 and now AE5:
   `AgentStatus` during the check must list the agent, not elide it.
7. **Log the judge's raw reply.** Still #1 by age — eleven passes — and
   load-bearing for S2, U4, V5 and W5.
8. **A child that compacts** (§L), **a delegation with a loop running** (§I),
   **§J**, **§K/§K.2**, **§N** — none ever run.
9. **The remaining text-pinned fixes.** §15 of `…-deliveries.md` listed them;
   AD1's was rewritten this pass and is now conditioned rather than pinned. The
   ones left are V7/W6 (`j7`, `k6`), AA3 and AA4 (`n3`, `n4`), AB2's routing half
   (`o2`), AB4's enumeration (`o4`).

---

## 16. Where to look

- `context/testing/probes/r1`–`r3` and `_sidecar.mjs` — the reproductions. `r1`
  drives the shipped loop through `_host.mjs`; `r2` drives real pi-importing
  modules through pi's bundled jiti; `r3` drives the whole `prinny-channel`
  extension in-process over the real MCP sidecar protocol.
- The regression tests:
  `vendor/pi-loop-mode/tests/turn-counters.test.ts` (AE1),
  `vendor/prinny-channel/tests/compaction-request.test.ts` (AE2),
  `vendor/prinny-channel/tests/delivery.test.ts` (AE3, AE4),
  `vendor/pi-subagents-lite/tests/status-listing.test.ts` (AE5),
  `vendor/pi-subagents-lite/tests/tool-surface.test.ts` (AE6),
  `vendor/prinny-channel/tests/forwarding.test.ts` (AE7).
- **§1** of this document — the machine, with every flag marked; **§2** — the
  claim ledger and the claims graph, which is the artefact this pass exists to
  leave behind; **§7.3** — `agent_settled` in order, which is where two of the
  four prinny findings live.
- `context/design/subagents-loop-verifier-controls.md` — the thirteenth pass
  (AD1–AD7) and its §2 control ledger, which this document's §2 is the successor
  of. Read that one first if you are new to the stack.
- `…-deliveries.md` (twelfth, AC1–AC5) · `…-signals.md` (eleventh, AB1–AB4, and
  the nearest neighbour to this axis) · `…-hosts.md` (tenth, AA1–AA4) ·
  `…-answers.md` (ninth, Z1–Z4) · `…-turns.md` (eighth, X1–X5, Y1) ·
  `…-readers.md` (seventh, W1–W6) · `…-shapes.md` (sixth, V1–V8) · `…-units.md`
  (fifth, U1–U9, whose §9 reference sections no later document restates) ·
  `…-surfaces.md` (fourth, S1–S10) · `…-mechanics.md` (third, T1–T9, still the
  best account of pi's own agent loop) · `…-evaluation.md` (second, F1–F11) ·
  `…-anatomy.md` (first, and the design rationale).
- pi's own source, for this pass:
  `dist/core/agent-session.js:1367` (`compact()` and its `await this.abort()` —
  AE2), `:808` (the compaction throw the same race lands on), `:1107-1135`
  (`sendUserMessage`, and the `.catch` at `:1855` that makes AE4 invisible),
  `:328` (`_emitAgentSettled` clearing `_isAgentRunActive` BEFORE the handlers
  run, which is why prinny can start a run from there),
  `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:393-452`
  (`prepareToolCall` — the one object AE6 rides on).
