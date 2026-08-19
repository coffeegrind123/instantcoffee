# Subagents, the loop, and the verifier — the units, and what is counted in them

Fifth pass, 2026-08-18. A full read of the three components and the seams between
them, with the machine drawn out, and nine findings (**U1–U9**) — **all nine
fixed**, each with a regression test that fails when the fix is removed, and each
with a probe that prints BEFORE and NOW side by side.

The four earlier passes each found a different *place* a defect can live:

| pass | document | where the defects were |
| --- | --- | --- |
| first | `…-anatomy.md` (B1–B8) | inside a module |
| second | `…-evaluation.md` (F1–F11) | in the wiring between two modules |
| third | `…-mechanics.md` (T1–T9) | between a module and pi's runtime |
| fourth | `…-surfaces.md` (S1–S10) | between a declaration and its implementation |

This one found a fifth: **between the unit a rule is written in and the unit it is
enforced in.**

- A stuck detector whose thresholds are written in *turns* and whose windows are
  filled per *assistant message* and per *tool call* (**U2**).
- A ladder whose escalations are written as "in a row" and whose guard is *which
  branch the handler returned from* (**U1**).
- A check whose two failure modes — *ran and failed* / *could not run* — are
  distinguished in one function and collapsed everywhere after it (**U3**).
- A judge whose verdict is read newest-first and whose reason is read
  first-match, from the same reply (**U4**).
- A word — `true` — that means "all of them" on two lines of a frontmatter block
  and "a tool called true" on the third (**U6**).
- A denylist that reasons about the directory a child *cannot* see and is silent
  about the one it *reads on its own* (**U7**).
- A turn counter that adds a running total on every turn (**U8**).
- An agent whose read-only guarantee is a paragraph and whose tool set is a shell
  (**U9**).
- And a tool action that means "start" to the model and "replace" to the loop
  (**U5**).

None of them is a threshold that wants tuning, and none of them showed up in a
test: **281 passing tests and 69/69 lint caught none of the nine**, for the same
reason the fourth pass gave — the rule and the thing it governs are each correct
in isolation, and the mismatch only exists where they meet. The suite is now 329
and 70/70; §11 has what shipped and the control-run failing count for each.

---

## How this sits next to the other four documents

Read this one for the machine as it stands today and for U1–U9. Read the others
for evidence, not for orientation:

- **`…-surfaces.md`** (1,923 lines) — the fourth pass. Its §1 map, §3–§8 detail
  and §9 findings all still hold; §12 was re-checked this pass and is unchanged.
  Everything it fixed is still fixed — the probes it ships are their own controls
  and all ten still run clean.
- **`…-mechanics.md`** (1,275) — the third pass, and still the best account of
  pi's own agent loop and its steering-drain order. T1's mechanism (a `maxTurns:
  1` run taking a second provider call) is load-bearing for U8 here.
- **`…-evaluation.md`** (977) — the second audit. Nothing overturned.
- **`…-anatomy.md`** (796) — the first audit and the design rationale. Carries
  inline corrections from later passes; check each before trusting a passage.

Nothing in those four is restated here except where a finding depends on it.

---

## 1. The whole machine, on one page

```
                      ┌───────────────────────────────────────────────────────┐
                      │  llama.cpp  ·  ONE slot  (PARALLEL_SLOTS=1)           │
                      │  every box below queues here, one at a time           │
                      └───────────────────────────▲───────────────────────────┘
                                                  │ provider calls
   ┌──────────────────────────────────────────────┴───────────────────────────────────────┐
   │  the OPERATOR's pi session                                                           │
   │                                                                                      │
   │   extensions bound to this session's event bus  (all by -e, scripts/pi-local.sh):    │
   │     vendor/pi-subagents-lite   4 handlers   Agent · StopAgent · AgentStatus          │
   │                                             /agents   (gated on SUBAGENTS_ENABLED=1) │
   │     vendor/pi-loop-mode       13 handlers   loop tool · /loop                        │
   │     .pi/extensions/compaction-guard  3      (no tools)     ⎫ also DISCOVERABLE, and  │
   │     .pi/extensions/browser-guard     1      (no tools)     ⎬ that is the route a     │
   │     .pi/extensions/stack             1 tool  stack_status   ⎭ child takes — see §7   │
   │       — and now guards its own factory, so a child gets none of it (U7)              │
   │     vendor/rtk-pi, vendor/prinny-channel                                             │
   │                                                                                      │
   │   module-global state, shared by every session in this PROCESS:                      │
   │     pi-loop-mode   `state: LoopState`, `runToken`, `pendingTimer`  ── one loop       │
   │     pi-subagents   `shell` { manager, widget, store, coordinator }                   │
   │     shell.ts       `__PI_SUBAGENT_SPAWN_DEPTH__`  (published on globalThis)          │
   └───────────────┬──────────────────────────────────────────────────────────────────────┘
                   │ Agent tool call
                   ▼
   ┌───────────────────────────────┐        ┌──────────────────────────────────────┐
   │ SpawnCoordinator.spawn()      │        │ AgentManager                         │
   │  · live view                  │───────▶│  · SlotTable   limit 1 by default    │
   │  · records spawnCtx on record │        │  · queue                             │
   │  · awaits the gate (fg)       │        │  · Watchdog    45 min tool / idle    │
   │  · nudges (bg)                │        │  · completion gate per record        │
   └───────────────────────────────┘        └───────────────┬──────────────────────┘
                                                            │ runAgent()
                        ┌───────────────────────────────────┴───────────────────┐
                        │  enterSubagentSpawn()   ← depth > 0 ONLY here         │
                        │    reloadAndMap()  → each extension factory runs      │
                        │    bindExtensions() → handlers, session_start         │
                        │  exitSubagentSpawn()                                  │
                        └───────────────────────────┬───────────────────────────┘
                                                    ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  the CHILD's AgentSession   (in-process, in-memory SessionManager)           │
   │    own system prompt · own tools · own window · own event bus                │
   │    extensions: DISCOVERED (.pi/extensions/*) + subagentExtraExtensionPaths() │
   │    pi-loop-mode and pi-subagents-lite are inert here (factory guard)         │
   │    ceiling: 40 turns, then a wrap-up steer, then a hard abort 6 turns later  │
   └──────────────────────────────────┬───────────────────────────────────────────┘
                                      │ run settles — status goes terminal,
                                      │ THE SLOT IS STILL HELD
                                      ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  the VERIFIER, inside the settlement chain's .then                           │
   │                                                                              │
   │    structural gate  (free)  empty? cut off? errored? no brief?               │
   │            │ worth judging                                                   │
   │            ▼                                                                 │
   │    judge   a fresh `__verifier` session: no tools, no extensions, no skills, │
   │            no context files, no environment block, 1 turn, 300 s deadline    │
   │            │ NOT_ADDRESSED                                                   │
   │            ▼                                                                 │
   │    repair  CONTINUE the child's own session with the brief restated          │
   │            │  → re-judge → … up to SUBAGENT_VERIFY_ROUNDS (default 1)        │
   │            ▼                                                                 │
   │    verdict written to record.verification; record.result rewritten           │
   └──────────────────────────────────┬───────────────────────────────────────────┘
                                      │ .finally: release slot, tally, drain queue,
                                      │           open the completion gate
                                      ▼
              foreground ─→ Agent tool result ─→ the parent's turn resumes
              background ─→ capBackgroundResult() ─→ pi.sendMessage(subagent-result)
```

The single constraint that shapes all of it is at the top of the drawing. One
llama slot means nothing here is concurrent with anything else: a child's turn,
the judge's turn, a repair, and the parent's next call are four things in one
queue. Every design decision below that looks over-careful about cost is
over-careful about that queue.

---

## 2. The three components, and what each one is for

### The loop (`vendor/pi-loop-mode`)

Drives an unattended run: it sends a turn, watches what comes back, and decides
whether to send another. Thirteen handlers, one module-global `LoopState`, one
`/loop` command and one `loop` tool. Its whole job is deciding what a turn's
outcome *was*, and every finding here that touches it is about that decision.

### Subagents (`vendor/pi-subagents-lite`)

Runs a child agent session inside the parent's process: its own system prompt,
its own tools, its own window, its own event bus. Three tools (`Agent`,
`StopAgent`, `AgentStatus`), a widget, a `/agents` menu, a concurrency table, a
watchdog, and a spawn coordinator that owns delivery.

### The verifier (`verify.ts` + `verify-runner.ts`, forge-only)

Checks a settled subagent answer against the task it was given. Three layers,
cheapest first: an **anchor** (no model call — restate the brief after each
compaction), a **structural gate** (no model call — empty, cut off, errored, no
brief), and a **judge** (one model call, and only for the case where drift is
invisible). It is a drift check, not a correctness proof, and the code says so.

### The guard (`.pi/extensions/compaction-guard`)

Not one of the three, but in every session and in every child: it bounds the
carried-over compaction summary, caps a single tool result against the remaining
window, and shows the model its context budget.

---

## 3. A delegation, on a timeline

The interesting part is not the sequence but **who holds the slot and for how
long**, because the slot is what the parent's next turn is waiting behind.

```
  parent turn N                                                       parent turn N+1
  ────────────┐                                                       ┌──────────────
              │  Agent(prompt, agent: "Explore")                      │
              ▼                                                       ▲
      ┌──────────────────────────────────────────────────────┐        │
      │ resolveWorktree · type resolution · model resolution │        │
      │ coordinator.spawn → manager.spawn                    │        │
      └───────┬──────────────────────────────────────────────┘        │
              │ slot free? ── no ─▶ queued; the gate stays shut       │
              │ yes                                                   │
   ┌──────────▼──────────────────────────────────────────────┐        │
   │ SLOT HELD ═════════════════════════════════════════════ │        │
   │                                                         │        │
   │  build   detectEnv (2× git, ~100 ms) · buildAgentPrompt │        │
   │          reloadAndMap (every extension factory)         │        │
   │          bindExtensions (child session_start)           │        │
   │                                                         │        │
   │  run     turn 1 … turn k        ← llama, one at a time  │        │
   │            each compaction fires the anchor steer       │        │
   │            turn 40 → "wrap up immediately"              │        │
   │            turn 46 → hard abort                         │        │
   │                                                         │        │
   │  settle  status ← completed | turn_limited | aborted    │        │
   │                   | error | stopped                     │        │
   │                                                         │        │
   │  verify  judge   ← a WHOLE extra session build + 1 turn │        │
   │          repair  ← 1+ turns in the child's session      │        │
   │          judge   ← again                                │        │
   │            ── unstoppable: status is already terminal,  │        │
   │               so Esc, StopAgent and the watchdog all    │        │
   │               decline. Only the 300 s deadline ends it. │        │
   │                                                         │        │
   │ ═══════════════════════════════════════ SLOT RELEASED ═ │        │
   └──────────┬──────────────────────────────────────────────┘        │
              │ tally · drainQueue · openGate ──────────────────────▶ │
```

Two things fall out of the drawing that are easy to miss in the source:

- **The verification window is inside the slot.** That is deliberate —
  `SlotTable.recount()` keys on `holdsSlot` rather than on `status === "running"`
  precisely so a queued sibling cannot start while a judge is on the provider —
  and it means the parent's wait is `child + judge + repair + judge`, all
  serialised.
- **It is also the window in which the record cannot be stopped.** Every stop
  path in `agent-manager.ts` tests `status === "running"`, and by the time the
  judge runs the status is terminal. `startDeadline()` exists because nothing
  else can end that wait. That is T5, still open by decision.

---

## 4. The loop's `agent_end` ladder, in full

This is the single most important diagram in this document, because U1 is a
statement about it. Every arrow that leaves the column is a `return`.

```
 agent_end(event, ctx)
   │
   ├─ !state.active ──────────────────────────────▶ (prepare-mode GOAL_READY watch) ─▶ ✗
   │
   ├─ clearPendingTimer()
   ├─ toolCallsThisTurn := state.toolCallsThisTurn ; state.toolCallsThisTurn := 0   ← T2's fix
   ├─ if penaltyTurnsRemaining > 0: penaltyTurnsRemaining--                          ← S4's fix
   │
   ├─ softStopRequested ─────────────────────────────────────────────────────────▶ ✗
   ├─ isContextPressure(...) ────────────────────────────────────────────────────▶ ✗
   ├─ !lastAssistant || stopReason === "error" ──────────────────────────────────▶ ✗
   ├─ aborted && degenerateAbortPending ──▶ interveneStuck ──────────────────────▶ ✗
   ├─ aborted ───────────────────────────────────────────────────────────────────▶ ✗
   │
   │  ─── the success path ───
   ├─ consecutiveErrorCount := 0 ; contextCooldownCount := 0 ; compressionLevel := 0
   ├─ iterationCount++
   ├─ turnsWithoutTools := toolCallsThisTurn === 0 ? +1 : 0
   │
   ├─ commitTurnMemory(turnTexts, turnCalls)          ← ONE entry per turn  [U2]
   │
   ├─ rescueActive ──────────────────────────────────────────────────────────▶ ✗
   │
   ├─ stuckReason := detectStuck(lastAssistantText, repetitionText)      ← [U1]
   │     ├─ detectDegenerateRepetition(...)         sentence/word/phrase
   │     ├─ turnsWithoutTools >= 3                  narration only
   │     ├─ last two fingerprints equal             "repeated the same response"
   │     ├─ last three fingerprints equal           "… three times"
   │     ├─ textSimilarity(last, previous) >= 0.8   "~N% similar to previous"
   │     ├─ same fingerprint >= 3 in the window     "repeated 3+ times"
   │     ├─ last three TURN signatures identical    "the same <tool> calls
   │     │                                           returned the same thing"
   │     └─ same question repeated
   ├─ if !stuckReason: consecutiveStuckCount := 0                        ← [U1]
   │
   ├─ checkCommand → runGoalCheck() → applyCheckOutcome()
   │     ├─ execFailed × MAX_CHECK_ERRORS ─▶ pauseForCheckFailure ───────▶ ✗ [U3]
   │     └─ untilDone && passed && !execFailed ──────────────────────────▶ ✗ completed
   │
   ├─ /\bLOOP_DONE\s*:/i
   │     ├─ untilDone && lastCheckPassed !== true                          [U3]
   │     │     ├─ stuckReason ─▶ interveneStuck ────────────────────────▶ ✗ [U1]
   │     │     └─ else check_failed ────────────────────────────────────▶ ✗
   │     ├─ untilDone ───────────────────────────────────────────────────▶ ✗ completed
   │     └─ endless: stuckReason ? interveneStuck : improve ─────────────▶ ✗ [U1]
   ├─ /\bLOOP_BLOCKED\s*:/i  stuckReason ? interveneStuck : unblock ─────▶ ✗ [U1]
   ├─ maxIterations reached ─────────────────────────────────────────────▶ ✗
   ├─ scoreRegressed ────────────────────────────────────────────────────▶ ✗
   ├─ stuckReason ─▶ interveneStuck ─────────────────────────────────────▶ ✗
   ├─ iterationCount - lastStateChangeIteration >= 8 ─▶ audit nudge ─────▶ ✗
   │
   └─ normal continue: schedule the next turn
```

`detectStuck` **was** the seventh guard on the success path, and the two marker
branches were the third and fourth — both `return`, so no response carrying a
marker could reach it. The verdict is now computed once, above them, and the
branches consult it: completion still wins, *continuing* with a marker does not.
That is U1, and the drawing is the whole of the argument, before and after.

The `interveneStuck` escalation ladder that hangs off it:

```
  interveneStuck(reason)
    consecutiveStuckCount++ ; interventionCount++ ; turnsWithoutTools := 0
    penaltyTurnsRemaining := 3        → before_provider_request rewrites the payload:
                                        frequency_penalty 0.5, presence_penalty 0.5,
                                        temperature +0.2   (openai-completions only)
      │
      ├─ context saturated (>= 80%) ──────────────────▶ compact, then a "stuck" turn
      ├─ rescueModel && streak >= 3 ──────────────────▶ switch model, one rescue turn
      ├─ streak >= 5 && 5 since last compaction ──────▶ compact, then a "stuck" turn
      └─ otherwise ──▶ rotating strategy + escalating delay  min(60, 2^streak) s
                       streak >= 3 also adds the HARD RESET block with banned openings
```

Everything on that ladder is spent on the word "in a row", and
`consecutiveStuckCount` used to be reset in exactly two places: the
normal-continue exit and the end of a rescue turn. The other sixteen left it
standing, so "3 in a row" could span an arbitrary number of healthy turns. It is
now cleared wherever the verdict comes back empty — every exit that represents a
turn which was not repeating itself.

---

## 5. The repetition windows, drawn in the unit they are actually filled in

```
   ONE TURN, as pi emits it        BEFORE — straight into      NOW — buffered, then
                                   the rolling windows         ONE entry per turn
   ─────────────────────────────   ─────────────────────────   ────────────────────
   message_start   ─┐
   "I'll read the entry point."  ─▶ fingerprints[0] texts[0]   turnAssistantTexts[0]
   tool_use read    ─┘
   tool_result                   ─▶ recentToolResults[0]       turnToolCalls[0]
   message_start   ─┐
   "Now the reader package."     ─▶ fingerprints[1] texts[1]   turnAssistantTexts[1]
   tool_use grep    ─┘
   tool_result                   ─▶ recentToolResults[1]       turnToolCalls[1]
   message_start   ─┐
   "Nothing to change here."     ─▶ fingerprints[2] texts[2]   turnAssistantTexts[2]
   (no tool call)   ─┘
   turn_end
   agent_end                      ─ detectStuck() reads ────▶  commitTurnMemory():
                                    the windows ONCE            · the LAST answer
                                                                · ONE tool signature
                                                                then detectStuck()

   window sizes (PERSISTED_WINDOW):
     fingerprints  8   ── BEFORE: three turns like the one above overflowed it.
     snippets      5      NOW: eight turns.
     texts         4   ── BEFORE: "the previous response" was texts[len-2], i.e.
                          the SAME turn's second message. NOW: the previous turn.
     toolResults  10   ── BEFORE: "the last three tool results" could all be from
                          this turn. NOW: ten turns of tool signatures.
```

Every notice built on those windows is phrased in turns: *"assistant repeated the
same response"*, *"the same grep calls returned the same thing 3 turns running"*,
*"stuck intervention #3 in a row"*. Now so are the windows. That is U2.

---

## 6. The verifier, drawn

```
   record settles ─▶ record.result = responseText
                        │
                        ▼
   ┌──── structuralVerdict(answer, lifecycle) ──────────────────────────────────┐
   │  answer is ""              ─▶ ok:false             skipped-empty           │
   │  status "error"            ─▶ worthJudging:false   skipped-error           │
   │  status aborted / turn_limited / stopped                                   │
   │                            ─▶ worthJudging:false   skipped-cutoff          │
   │  brief missing             ─▶                      skipped-nobrief         │
   └────────────────────────────┬───────────────────────────────────────────────┘
                                │ non-empty, clean run, brief present
                                ▼
   ┌──── the round loop ────────────────────────────────────────────────────────┐
   │                                                                            │
   │   phase "judging"                                                          │
   │   judge(buildJudgePrompt(brief, candidate))    ← fresh __verifier session  │
   │        │                                         300 s deadline            │
   │        ▼                                                                   │
   │   parseJudgeVerdict(reply)                                                 │
   │        ├─ unparsed ─────────────▶ candidate + note      unparsed           │
   │        ├─ addressed, 0 attempts ▶ candidate (bare)      passed             │
   │        ├─ addressed, n attempts ▶ candidate + note      repaired           │
   │        └─ not addressed                                                    │
   │              ├─ attempts >= rounds ▶ ORIGINAL + note    failed             │
   │              └─ phase "repairing"                                          │
   │                 repair(buildRepairPrompt(brief, why))                      │
   │                      │              ← the CHILD's own session              │
   │                      ├─ "" ──────────▶ ORIGINAL + note  failed             │
   │                      ├─ == candidate ▶ ORIGINAL + note  failed (stalled)   │
   │                      └─ candidate := repaired ─▶ round again               │
   └────────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
              record.verification := status      → badge, /agents, details
              record.result       := answer      → every reader sees the same text
```

Two asymmetries in that picture are the design, and both are right:

- **The judge knows less on purpose.** Its whole argument is that a model shown
  its own reasoning ratifies it, so the judge is shown two quoted blocks and a
  question. Everything that would give it more — tools, extensions, skills,
  project context files, the parent's system prompt, an environment block — is
  declared off, and the fourth pass had to move that resolution into
  `declaredPromptSources()` to make the declarations true. Its prompt is 463
  chars.
- **The repair knows more on purpose.** It continues the child's own session,
  because that is the only place with the context to fix the answer.

`why` is the one thing that crosses from the first into the second. That is U4.

---

## 7. What a child inherits, and by which route

```
   the PARENT is started with  -e vendor/rtk-pi  -e vendor/pi-loop-mode
                               -e vendor/pi-subagents-lite  -e vendor/prinny-channel
                                 │
                                 │  a child does NOT inherit -e flags
                                 ▼
   ┌────────────────────────────────────────────────────────────────────────────────────┐
   │  the child's DefaultResourceLoader                                                 │
   │                                                                                    │
   │   route A — DISCOVERY                    route B — additionalExtensionPaths        │
   │   ──────────────────────                 ─────────────────────────────────         │
   │   ~/.pi/agent/extensions/**              subagentExtraExtensionPaths():            │
   │   <cwd>/.pi/extensions/**                  vendor/rtk-pi/extensions/index.ts       │
   │     · compaction-guard  ✓ wanted           (or $SUBAGENT_EXTRA_EXTENSIONS)         │
   │     · browser-guard     – harmless                                                 │
   │     · stack           ✗ GUARDS ITSELF     suppressed entirely when the agent       │
   │       (was stack_status, 173 tok/turn)     declares extensions: false              │
   │                                            (that is why the judge has none)        │
   │                                                                                    │
   │   ── withExtensionDenial() runs LAST over both ─────────────────────────────       │
   │      any path segment matching  (?:[a-z0-9._@-]*-)?prinny-channel/  is cut         │
   └────────────────────────────────────────────────────────────────────────────────────┘

   `vendor/pi-loop-mode` reaches a child by neither route, deliberately:
     · it is not discovered (it lives in vendor/)
     · it was removed from route B, because its state is module-global
     · and its factory returns early when __PI_SUBAGENT_SPAWN_DEPTH__ > 0
   Three independent stops, because the failure it caused was silent.

   `.pi/extensions/stack.ts` cannot be stopped from ARRIVING — route A is
   discovery, and nothing in the denylist runs before it — so it uses the third
   of those stops: the same factory guard, at the source.
```

`subagent-denylist.ts` was a careful, well-argued file about route B that never
mentioned route A except to say compaction-guard arrives that way and is welcome.
That is U7. Its header now documents both routes, `stack.ts` guards its own
factory, and a standing check in that package's tests fails if anything else in
`.pi/extensions/` ever registers a model-visible tool without doing the same.

---

## 8. Findings

Severity is about what it costs a real run, not about how surprising it is.
Evidence is **PROVEN** (an executable probe drives the shipped module),
**MEASURED** (a number taken from the tree), or **SOURCE** (read, and the
reasoning is in the finding).

| # | Finding | Sev | Evidence | Probe | Fixed |
| --- | --- | --- | --- | --- | --- |
| U1 | `LOOP_DONE:` / `LOOP_BLOCKED:` left `agent_end` above every stuck check | **HIGH** | PROVEN | `i1` | ✔ |
| U2 | the repetition windows counted messages and tool results; the rules count turns | **HIGH** | PROVEN | `i2` | ✔ |
| U3 | a goal check that cannot run was recorded and acted on as one that failed | **MEDIUM** | PROVEN | `i3` | ✔ |
| U4 | the judge's reason was read first-match and unguarded, and it drives the repair | **MEDIUM** | PROVEN | `i4` | ✔ |
| U5 | `loop(action:"start")` silently replaced a running loop, endlessly | **MEDIUM** | PROVEN | `i5` | ✔ |
| U6 | `tools: true` in an agent file gave the agent no tools | **MEDIUM** | PROVEN | `i6` | ✔ |
| U7 | the subagent denylist models `vendor/`; a child reads `.pi/extensions/` | **LOW** | MEASURED | `i8` | ✔ |
| U8 | the verifier's repair added a cumulative turn number on every turn | **LOW** | PROVEN | `i7` | ✔ |
| U9 | `Explore`'s read-only guarantee was a prompt; it shipped a live `bash` | **MEDIUM** | PROVEN | `i9` | ✔ |

---

### U1 — `LOOP_DONE:` and `LOOP_BLOCKED:` left `agent_end` above every stuck check · **HIGH** · PROVEN · **FIXED**

**Where.** `vendor/pi-loop-mode/extensions/index.ts:1864` and `:1897`, against
`detectStuck` at `:1935`.

**What.** The two completion markers are the third and fourth guard on the
success path — after `rescueActive` and the goal check, before the iteration cap,
the score-regression check, `detectStuck()` (seventh) and the no-progress audit.
Both marker branches `return`.

So for any response containing `LOOP_DONE:` or `LOOP_BLOCKED:`, none of the
following runs: the degenerate-repetition scan, the narration-only counter, the
two identical-response tests, the near-duplicate test, the alternating-repetition
test, the repeated-tool-result test, the repeated-question test. The whole
fixation ladder — sampling penalties, escalating delay, rescue model, compaction
— is unreachable.

**Why it is not an edge case.** This is *endless* mode, the default, and the
loop's own `loopInstructions()` puts the marker in the model's mouth:

> Endless mode: if the core goal appears complete, say `"LOOP_DONE: <one-line
> summary>"` — the loop will then continue with improvement work (features,
> tests, bug fixes, refactoring, docs). Never stop on your own.

and then answers every one of them with the `improve` directive, which is a
standing invitation to say it again. The loop hands the model the exact token
that switches off the loop's own fixation detector, and asks for it by name.

**Proved.** `i1`, driving the real module. The same byte-identical, tool-free
response eight times:

```
  plain                                     LOOP_DONE: prefix
  ────────────────────────────────────────  ─────────────────────────────────────
  turn 1  (no notice)                       turn 1  goal reported done (#1)
  turn 2  Loop stuck (1x): assistant        turn 2  goal reported done (#2)
          repeated the same response        …
  turn 3  Loop stuck (2x)                   turn 8  goal reported done (#8)
  turn 4  Loop stuck (3x)
  turn 5  Loop stuck (4x)                   Interventions: 0  (stuck streak: 0)
  turn 6  stuck 5x — compacting context     Done signals: 8
  turn 7  Loop stuck (6x)
  turn 8  Loop stuck (7x)

  Interventions: 7  (stuck streak: 7)
```

`LOOP_BLOCKED:` is identical, at `blocked signals: 8`.

The sharpest line in the probe is the one after those eight turns. Send **one**
turn with the marker removed and the same text, and the loop says:

```
  Loop stuck (1x): no tool usage for 9 turns (narration only) — injecting new strategy.
```

`state.turnsWithoutTools` had been counting the whole time. It is incremented on
the success path *above* the marker branches and only ever read inside
`detectStuck`, *below* them. Nine turns of accumulated evidence, retrievable the
instant the marker came off.

**What it costs.** A run whose model has settled into "LOOP_DONE: still looks
good" plus no tool call executes forever at full speed, burning an iteration and
a provider call per turn, with `/loop status` reporting `Interventions: 0` and a
healthy `Done signals` count. Every mechanism built to catch exactly that is
present, armed, and never consulted. The same applies to `LOOP_BLOCKED:`, which
in this loop's design is *also* a normal outcome — the `unblock` directive says
"the loop will still continue with assumptions".

**The fix.** `detectStuck` is now computed once, above the marker branches, and
the branches consult it. The line that decides the shape is which things a stuck
verdict is allowed to outrank:

```
  completion   still wins, always
                 · untilDone && the goal check passed        -> completed
                 · untilDone && LOOP_DONE with no check      -> completed
  continuing   loses to a stuck verdict
                 · endless   LOOP_DONE  -> improve directive   ← now intervenes
                 · LOOP_BLOCKED         -> unblock directive   ← now intervenes
                 · untilDone LOOP_DONE with a failing check
                            -> check_failed directive          ← now intervenes
```

A loop that is genuinely finished must be allowed to finish, so the completion
paths return before the verdict is consulted. What loses is *continuing* with a
marker — and re-sending `check_failed` to a model that has already been sent it
and repeated itself is the fixation this ladder exists for.

The signal is still counted (`doneSignalCount`, `blockedSignalCount`) and still
logged, with the stuck reason attached, so nothing is hidden by the change.

`consecutiveStuckCount` is fixed in the same place and for the same reason: it is
cleared whenever the verdict is empty, rather than on two of this handler's
eighteen exits. It is the number every rung of the ladder spends — the rescue
model at 3, the compaction at 5, the HARD RESET block at 3 — and it is documented
as "in a row".

*Tests:* `vendor/pi-loop-mode/tests/stuck-ladder.test.ts`, first describe. Five
cases, three of which fail without the fix; `plain` and the non-repeating marker
turn are the controls, and they pass either way.

---

### U2 — the repetition windows counted messages and tool results; every rule on top of them counts turns · **HIGH** · PROVEN · **FIXED**

**Where.** `message_end` at `index.ts:1623`, `tool_result` at `:1615`,
`detectStuck` at `:598`, `PERSISTED_WINDOW` in `src/loop-state.ts:127`.

**What.** `pi.on("message_end")` fires once per assistant *message*. A turn that
uses tools produces several: one that announces a tool call, another after the
results come back, and a final answer. Each one that carries text is pushed into
`lastAssistantFingerprints` (8), `lastAssistantSnippets` (5) and
`lastAssistantTexts` (4). `pi.on("tool_result")` likewise pushes one entry per
call into `recentToolResults` (10).

`detectStuck()` then reads those windows once per *turn*, at `agent_end`, and
every verdict it can return is phrased in turns.

That the two units differ is visible in the loop's own source: `message_start`
resets `lastDegenerateCheckLength` per message, and `toolCallsThisTurn` is reset
per turn, in the same file, forty lines apart.

**The mismatch cuts both ways, and both were reproduced.**

*Blind.* Four consecutive turns whose **final answer is byte-identical**, each
also emitting four intermediate messages and four distinct tool results:

```
  turn 1 (5 assistant messages): (no notice)
  turn 2 (5 assistant messages): (no notice)
  turn 3 (5 assistant messages): (no notice)
  turn 4 (5 assistant messages): (no notice)
```

The control — the same four turns, one message each:

```
  turn 1 (1 assistant message): (no notice)
  turn 2 (1 assistant message): Loop stuck (1x): assistant repeated the same response
  turn 3 (1 assistant message): Loop stuck (2x)
  turn 4 (1 assistant message): Loop stuck (3x)
```

Five messages per turn against an 8-slot window means the previous turn's answer
is five places back by the time the next one arrives, so the "last two" and "last
three" tests never see two answers adjacent. `lastAssistantTexts` is 4 deep, so
the near-duplicate test compares a turn's final answer against **its own second
message**. A model repeating itself turn after turn — the precise failure this
detector exists for — is invisible as soon as the model uses tools, which is the
normal case and which the loop's own rules *require* ("every turn must include at
least one tool call").

*False positive.* One productive turn — edit a file, then run three greps
confirming nothing references the removed symbol:

```
  tool results in order: edit, grep, grep, grep
  turn 1: Loop stuck (1x): same grep result repeated — injecting new strategy.
```

The same turn with the greps first and the edit last:

```
  tool results in order: grep, grep, grep, edit
  turn 1: (no notice)
```

Three empty greps for three different patterns are three identical results, and
`recentToolResults.slice(-3)` does not know they came from one turn or that a
file was edited between them. The verdict depends on the order the model happened
to work in. The intervention is not free: it arms the sampling penalties for
three turns, adds an escalating delay, injects "You are repeating yourself. Do
NOT repeat the previous answer" into a turn that did real work, and counts toward
the rescue and compaction rungs.

**Proved.** `i2`, four modes.

**Why it survived four audits.** Because every individual rule is right. Nothing
in `detectStuck` is wrong about what it compares; the windows simply do not
contain what the comments say they contain — `SIMILARITY_THRESHOLD` is documented
as a "near-duplicate threshold for consecutive assistant **responses**", and the
values it compares are consecutive assistant *messages*.

**The fix.** The windows are filled once per turn, from `agent_end`.

```
  message_end   ──▶ turnAssistantTexts.push(tracked)      ⎫ module-local buffers,
  tool_result   ──▶ turnToolCalls.push({tool, fingerprint})⎬ drained at the top of
                                                           ⎭ agent_end with
                                                             toolCallsThisTurn
  agent_end     ──▶ commitTurnMemory(texts, calls)
                      · the turn's LAST non-empty answer  ──▶ fingerprints,
                                                              snippets, texts
                      · ONE signature for everything it   ──▶ recentToolResults
                        called: the ordered (tool, result)
                        pairs, hashed
```

Three properties fall out of it, and all three were the point:

- **The windows now hold what their names say.** 8 turns of fingerprints, 4 turns
  of texts, 10 turns of tool activity — the memory the detector was designed with.
- **The buffers are drained by every exit**, in the same place and by the same
  argument as `toolCallsThisTurn` (T2) and `penaltyTurnsRemaining` (S4), so a turn
  that ends in an error or an abort contributes nothing rather than leaking into
  the next comparison.
- **The tool rule got stronger, not weaker.** "Three identical results in a row"
  became "the same calls returned the same thing three turns running", which is
  what the notice always claimed and cannot be tripped by one turn that searched
  three times.

*Tests:* `stuck-ladder.test.ts`, second describe. Three cases, two of which fail
without the fix; the third — three turns making the same calls and getting the
same answers — is the control that the rule still catches what it is for.

---

### U3 — a goal check that cannot run was recorded and acted on as one that failed · **MEDIUM** · PROVEN · **FIXED**

**Where.** `runGoalCheck()` at `index.ts:586`, `applyCheckOutcome()` in
`src/goal-check.ts:11`, the consumer at `index.ts:1842`.

**What.** `runGoalCheck` is careful about the distinction:

```js
} catch (error) {
  return { passed: false, score: undefined, output: snippet(String(error), 200), execFailed: true };
}
```

`execFailed` is true when `pi.exec` *rejects* — a timeout against
`checkTimeoutSeconds` (120 s by default), a missing interpreter, a spawn failure,
a `bash` that is not there. Exactly one line consumes it:

```js
if (outcome.execFailed) ctx.ui.notify(`Loop: goal check could not run: ${outcome.output}`, "warning");
```

an operator-facing warning. `applyCheckOutcome` is then called unconditionally,
with `passed: false`, and from there the two cases are the same object:
`lastCheckPassed = false`, `checkFailStreak++`, `lastCheckOutput = <the exec
error>`.

**Proved.** `i3`. `--until-done --check ./check.sh`, the model reporting
LOOP_DONE each turn:

```
  exec THROWS ("Command timed out after 120000ms")
    turn 1  goal check could not run … | LOOP_DONE claimed, but the goal check fails
      -> next turn is told : You reported LOOP_DONE, but the goal check command still fails (streak 1)…
      -> "what the check reports" is: "Error: Command timed out after 120000ms"
    …
    Check status: failing (streak 3)      Active: true

  exec RETURNS EXIT 1
    turn 1  LOOP_DONE claimed, but the goal check fails
      -> "what the check reports" is: "2 tests failed"
    …
    Check status: failing (streak 3)      Active: true      ← byte-for-byte identical

  exec RETURNS EXIT 0   (control)
    turn 1  Loop completed — goal check passed
    Active: false       Status: completed
```

**What it costs.** Three things, in increasing order of seriousness.

1. The model is shown a spawn error as the thing to fix. `check_failed`'s
   directive is *"Completion is decided by the check, not by your claim. Fix
   exactly what the check reports. Check output: Error: Command timed out after
   120000ms"*. There is nothing in the working tree to fix.
2. `/loop status` says `failing (streak 3)`, which is a claim about the project.
   It is a claim about the check harness.
3. In `--until-done` mode the loop's terminating condition is the check, and a
   check that has started timing out removes it. The one mode that can finish
   becomes one that cannot, silently, and the loop is designed never to stop on
   its own.

**Why the notify is not enough.** It goes to `ctx.ui`, which the operator sees
and the model does not — the same asymmetry the `loop` tool's
`withCapturedNotices` proxy exists to fix for a different caller. An unattended
run has no operator watching, which is the point of an unattended run.

**The fix.** All three of the available policies, in the order they apply.

1. **The check state is untouched.** `applyCheckOutcome` returns early on
   `execFailed`: `lastCheckPassed`, `checkFailStreak`, `lastCheckScore` and
   `lastCheckOutput` stay exactly as the last real run left them — "last known",
   which is the honest reading — and the failure is counted separately in
   `checkErrorStreak` / `lastCheckError`.
2. **The model is told the truth, and it is actionable.** The `check_failed`
   directive branches: *"the goal check could not be RUN (2 attempts in a row):
   <error>. Completion is decided by the check, so the check itself is the work:
   fix or replace `./check.sh` so it runs and exits 0 when the goal is met."* The
   status line says `LAST KNOWN` rather than `failing (streak N)`.
3. **Completion still requires a check that ran.** The `untilDone` guard is now
   `lastCheckPassed !== true` rather than `=== false`, because "the check decides"
   cannot mean "the model decides when the check is broken".
4. **And it terminates.** `MAX_CHECK_ERRORS` (3, matching
   `CONTEXT_RECOVERY_ATTEMPTS`) pauses the loop with the command and the error in
   the notice — the same shape of answer the context ladder gives to the same
   shape of question, and the one place where carrying on is worse than stopping.

*Tests:* `vendor/pi-loop-mode/tests/goal-check-errors.test.ts`. Nine cases, five
of which fail without the fix; a check that ran and failed, and one that passed,
are the controls on either side.

---

### U4 — the judge's reason was read first-match and unguarded, and it is what drives the repair · **MEDIUM** · PROVEN · **FIXED**

**Where.** `parseJudgeVerdict()` in `vendor/pi-subagents-lite/src/agents/verify.ts:218`.

**What.** The function opens

```js
const why = (text.match(/WHY:\s*(.+)/i)?.[1] ?? "").trim();
```

and only *then* walks the lines backwards looking for a `VERDICT:` line, skipping
any whose value is the menu. So the two halves of one reply are read by opposite
rules:

| | direction | menu-guarded? |
| --- | --- | --- |
| `VERDICT` | newest-first, line-anchored | yes (`VERDICT_MENU`) |
| `WHY` | first match anywhere, unanchored | no |

**Why that matters here specifically.** `buildJudgePrompt()` ends with

```
Reply with exactly two lines:
VERDICT: ADDRESSED or NOT_ADDRESSED
WHY: one sentence, and if NOT_ADDRESSED say what the task asked for that the answer does not give.
```

S2 was the *first* of those two lines being echoed and read as a verdict. This is
the *second* being echoed and read as a reason — the same reply shape, five lines
apart, and only one of them was repaired.

And the reason is not decoration. It is the entire content of the repair prompt's
`Reason:` line, and the repair is the expensive half of a round: one model call
in the child's own session, on the single slot the parent is blocked on, in a
window that is already the thing most likely to be wrong.

**Proved.** `i4`, against the real parser and the real prompt builder:

```
--- control — the two lines it was asked for ---
  verdict read as : NOT_ADDRESSED
  reason read as  : "the answer describes the function instead of listing its callers."
  the child is then sent:
      Your answer did not address the task you were given. Reason:
      the answer describes the function instead of listing its callers.

--- echoes the instruction block, then answers correctly ---
  verdict read as : NOT_ADDRESSED
  reason read as  : "one sentence, and if NOT_ADDRESSED say what the task asked for that the answer does not give."
  the child is then sent:
      Your answer did not address the task you were given. Reason:
      one sentence, and if NOT_ADDRESSED say what the task asked for that the answer does not give.

--- thinks out loud, commits last ---
  verdict read as : NOT_ADDRESSED
  reason read as  : "I first need to check whether call sites appear at all."
```

The verdict is right in all three — that is S2's fix holding, and it is this
probe's control. The reason is wrong in two, in the two shapes a 27B actually
produces.

**What it costs.** A repair round spent telling a child its answer was wrong
because *"one sentence, and if NOT_ADDRESSED say what the task asked for…"*. The
child cannot act on that, so the repair is likely to come back either unchanged
(→ `stalled`) or differently-wrong, and the round is spent either way. The same
string is also what the operator is shown: *"Subagent answer did not address the
task (one sentence, and if NOT_ADDRESSED …) — asking again (attempt 1 of 1)."*

**The fix.** `readWhy(lines, afterIndex)` reads the reason the same way the
verdict is read:

- **line-anchored** (`^[\s>*_#-]*why[\s*_]*:`), so prose that happens to contain
  "WHY:" mid-sentence is not a reason — that alone fixes the thinking-aloud case;
- **relative to the line that decided** — the first usable `WHY:` *after* the
  `VERDICT:` line that was acted on, which is what separates a real reason from an
  echo: a reply that repeats the instruction block and then answers has the echoed
  WHY before its verdict and the real one after it;
- **never the prompt's own instruction**, checked against an exported
  `WHY_INSTRUCTION` constant that `buildJudgePrompt` also interpolates, so a
  reword of the prompt cannot silently reopen this. `VERDICT_MENU_TEXT` was
  extracted at the same time and for the same reason;
- and **last-usable-wins** when nothing decided (the prose pass), by the same
  argument the newest-first verdict scan makes.

`**WHY:** …` closes its emphasis *after* the colon, so the value arrives with a
`**` on the front; that is stripped, because unlike the verdict this string is
quoted verbatim into the repair prompt.

*Tests:* seven cases in `vendor/pi-subagents-lite/tests/verify.test.ts`, six of
which fail without the fix. The plain two-line reply is the control.

This does not remove the reason the fourth pass put **log the judge's raw reply**
at the top of the next-session list. Neither S2 nor U4 was visible from outside,
and neither will be until the reply is in the transcript — a fix removes the
common case, it does not make the result checkable.

---

### U5 — `loop(action: "start")` silently replaced a running loop, and the replacement was endless · **MEDIUM** · PROVEN · **FIXED**

**Where.** `TOOL_ACTIONS` at `index.ts:1329`, `startFromArgs` at `:1050`,
`applyGoalConfig` at `:724`.

**What.** The tool's action set is closed on purpose, and the comment says why:

> A closed set on purpose: the command's final branch treats anything it does not
> recognise as a goal to start looping on, which is a sensible convenience for a
> person and a live grenade for a model that invents a verb.

The same argument applies to `start` when a loop is already running, and it was
not carried across. `/loop run` refuses while active ("Loop is already running");
`/loop goal` refuses ("Use /loop stop first"); `start` does not — because for a
human typing `/loop start`, replacement *is* the intent, and the stop notice
advertises it: *"/loop start to replace"*.

Through the tool it is a different act, done by a different party, and it takes
everything with it. `applyGoalConfig()` spreads `defaultState()`, so the goal, the
criteria, the iteration count, the error counters, the check command, the goal
file and the **iteration cap** are all discarded — and
`startArgsFromToolParams()` supplies `maxIterations: 0` for any call that omits
`max`, which is endless, the mode whose own rule is "Never stop on your own."

**Proved.** `i5`:

```
=== the operator's loop, five iterations in ===
  Active: true
  Goal: migrate every callsite of the legacy importer to the new API, in small commits
  Criteria: the build is green and no callsite remains
  Mode: endless
  Iterations: 5/500

=== the model now runs loop start (via: tool) ===
  isError      : false
  tool returned: "Loop active [endless (stop with /loop stop)]: summarise the file I just read"

=== the operator's loop, afterwards ===
  Active: true
  Goal: summarise the file I just read
  Criteria: there is a summary
  Mode: endless
  Iterations: 0/∞
```

**What it costs.** `Active` never goes false, so anything watching for a stop
sees a loop still running — a different one. The 500-iteration cap is gone. The
tool's own result text cannot say a loop was replaced, because by the time it is
built the previous goal no longer exists.

The realistic route to this is not malice: it is a model that has been told, in
its own system prompt, that "Loop mode is active. Goal: <the operator's goal>",
reaching for the `loop` tool because it now has a sub-goal of its own. The tool
description — *"Iterate toward a goal across turns until it is met"* — does not
say that starting one ends the one already running.

**The fix.** `start` returns `isError: true` when `state.active`, naming the loop
it protected:

```
loop start refused: a loop is already running (migrate every callsite of the
legacy importer to the new API, in small commits), iteration 5/500. Call loop
with action "stop" first if it should be replaced, or "status" to see it.
```

The slash command is deliberately unchanged. For a human typing `/loop start`
replacement *is* the intent, and the stop notice advertises it. The asymmetry is
the whole point: the guard is for the caller that cannot be asked whether it meant
to. `stop` then `start` still works, deliberately.

*Tests:* three cases in `vendor/pi-loop-mode/tests/loop-tool.test.ts`, one of
which fails without the fix; the other two are the controls that `start` after a
`stop` still works and that the slash command still replaces.

---

### U6 — `tools: true` in an agent file gave the agent no tools · **MEDIUM** · PROVEN · **FIXED**

**Where.** `parseAgentFile()` in
`vendor/pi-subagents-lite/src/agents/agent-discovery.ts:231`, and the two
resolvers in `agent-types.ts`.

**What.** The frontmatter parser reads scalars as strings, and the three
resource keys are then read by two different functions:

```
   extensions / skills  ->  parseExtensions()    "false" | "none"  -> false
                                                 "true"  | "all"   -> true
                                                 "a, b"            -> ["a","b"]

   tools                ->  parseStringArray()   ANY non-empty string is a comma list
```

So `tools: true` becomes the one-element allowlist `["true"]`, and that value is
used for **both** halves of tool resolution: `resolveSessionAllowedTools()` gates
the session registry to a tool named `true`, and `resolveVisibleTools()` shows
the model the intersection of that allowlist with the active set, which is empty.

**Proved.** `i6`, through the real parser, the real merge and both real
resolvers:

```
  written in the .md    | what the author means       | registry gate                   | visible to the model
  ----------------------+-----------------------------+---------------------------------+---------------------
  tools: true           | the model gets everything   | ["true"]                        | []
  tools: all            | the model gets everything   | ["all"]                         | []
  tools: false          | the model gets nothing      | ["false"]                       | []
  tools: none           | the model gets nothing      | ["none"]                        | []
  tools: [read, grep]   | the model gets read and grep| ["read","grep"]                 | ["read","grep"]
  (nothing)             | (no tools: key at all)      | ["read","bash","edit","write"]  | all of them (no filter)

  The same three words, on the sibling keys:
    extensions: true     -> extensions = true
    extensions: all      -> extensions = true
    extensions: false    -> extensions = false
    skills: none         -> skills = false
    skills: all          -> skills = true
```

**Why it stays quiet.** Three of the four spellings look like they work.
`tools: false` and `tools: none` are *accidentally* correct — an allowlist
containing one tool that does not exist is also no tools — so the only spellings
that misbehave are the two that mean "everything", and an agent that silently has
no tools reads as a model that would not use them.

The one signal is a buffered warning, `tool "true" not found in any loaded
extension`, naming a tool the author never wrote.

**This is S9 one field over.** There, `registeredTools: []` read as "not
declared" and quietly became the default four; the declaration a reader takes as
load-bearing was inert. Here the word that means "all of them" on two lines of a
frontmatter block means "a tool called true" on the third, and nothing in the
file, the README or the `AgentConfig` type says the third key is different.

**The fix.** `tools` goes through `parseExtensions`, like its two siblings, and a
boolean no longer leaks into `registeredTools` — which is a list of names, while
`true`/`false` are statements about visibility and belong only on `tools`, where
both resolvers already honour them.

```
  written in the .md     registry gate                    visible to the model
  ---------------------  -------------------------------  --------------------
  tools: true / all      ["read","bash","edit","write"]   all of them (no filter)
  tools: false / none    []                               []
  tools: [read, grep]    ["read","grep"]                  ["read","grep"]
  (no tools: key)        ["read","bash","edit","write"]   all of them (no filter)
```

The `false`/`none` route changed too, and deliberately: it used to reach "no
tools" through an allowlist of one tool that happens not to exist, and now reaches
it through `resolveSessionAllowedTools`' `tools === false` branch, which returns
`[]` immediately. Same outcome, and now for the stated reason — the difference
shows in the registry gate, which is what the test asserts on.

*Tests:* `vendor/pi-subagents-lite/tests/agent-frontmatter.test.ts`, eight cases,
four of which fail without the fix. The list form, the no-key form, the sibling
keys and the boolean-leak check are the controls.

---

### U7 — the denylist models `vendor/`; a child reads `.pi/extensions/` · **LOW** · MEASURED · **FIXED**

**Where.** `subagent-denylist.ts`, against `createResourceLoader`'s
`additionalExtensionPaths` in `agent-runner.ts:520`.

**What.** A child inherits no `-e` flags. It builds its own
`DefaultResourceLoader`, which **discovers** extensions — so everything under
`.pi/extensions/` reaches a subagent for free, and everything under `vendor/`
does not unless `subagentExtraExtensionPaths()` names it.

`subagent-denylist.ts` knows this and says so, citing a live run: compaction-guard
was watched capping the **child's** own `read` result at 9,778 → 8,176 chars
inside the child session. That is the measurement the whole finding rests on —
the directory is *known* to reach a child, because one of its members was
observed working there.

Two conditions on that route, both checked rather than assumed:

- **Discovery of `.pi/extensions/` requires the project to be trusted**
  (`scripts/pi-local.sh:200`, verified both ways on 2026-08-13). A child inherits
  the parent's cwd unless `worktree_path` says otherwise, and
  `createResourceLoader` builds its `SettingsManager` with `projectTrusted:
  options.projectTrusted !== false` — so the normal case is trusted and
  discovery happens, and the one case it does not is an untrusted cross-repo
  target, where the trust gate is already switching the target's resources off
  on purpose.
- **An agent that declares `extensions: false` gets none of it.**
  `noExtensions: true` drops the discovered set, so `__verifier` — the judge —
  does not carry `stack_status`. That is S3/S9's fix doing its job, and it is why
  this is a LOW finding rather than a per-judge-call cost.

The file's entire ledger is then about route B: prinny denied, rtk added back,
`pi-loop-mode` added back and then removed — and the removal is *priced*: "the
`loop` tool costs a child ~177 tokens of schema on every turn, which is the
child's window".

Nothing prices route A.

**Measured.** `i8`, reading the literals out of `stack.ts` rather than restating
them:

```
  extension         | registers a model-visible tool? | wanted in a child?
  ------------------+---------------------------------+-------------------
  browser-guard     | no — hooks only                 | harmless
  compaction-guard  | no — hooks only                 | yes: bounds the CHILD's own tool output
  stack             | YES — stack_status              | never asked for

  What stack_status costs a child, per turn:
    tool JSON on the wire  :   335 chars
    promptSnippet          :    85 chars
    promptGuidelines       :   272 chars
                           -----------
    total                  :   692 chars  ≈ 173 tokens

    the `loop` tool, removed from children for this exact reason: ~177 tokens
```

173 against 177. The tool that was removed from children for costing too much and
the tool nobody noticed arriving cost the same.

**What it costs.** Not much, and that is the honest report: `stack_status` is
read-only, it cannot restart anything (that split is deliberate and documented in
`stack.ts`), and 173 tokens a turn is a small tax on a child's window. What is
worth recording is the *route*, because the next extension dropped into
`.pi/extensions/` inherits the same free pass, and the file that exists to decide
what a subagent may load does not model that direction at all.

`stack.ts` and `browser-guard.ts` also have no subagent guard of their own. Both
vendored packages open their factory with one; the two written in this repo's own
`.pi/` do not, because when they were written the question had not come up.

**The fix, in two parts.**

1. **`stack.ts` guards its own factory**, with the same
   `__PI_SUBAGENT_SPAWN_DEPTH__ > 0 → return` check `pi-subagents-lite` and
   `pi-loop-mode` open with. A child's instance registers nothing — not
   `stack_status`, not `/stack`, not the entry renderer. A guard at the source
   cannot be defeated by a path that moves, which is exactly the failure the
   prinny pattern was rewritten to stop making (S8).
2. **A standing check for the class**, in
   `pi-subagents-lite/tests/subagent-denylist.test.ts`: every entry point under
   `.pi/extensions/` that calls `pi.registerTool(` must contain
   `__PI_SUBAGENT_SPAWN_DEPTH__`. It skips silently when the directory is not
   there, so the package still works outside this repo, and it is paired with a
   control that fails if nothing in that directory registers a tool any more —
   i.e. if the assertion has quietly stopped testing anything.

`subagent-denylist.ts`'s header now documents both routes, so the next reader
looking for "what does a subagent load" finds route A described in the file whose
job that is.

*Tests:* two cases, one of which fails without the guard.

---

### U8 — the verifier's repair added a cumulative turn number on every turn · **LOW** · PROVEN · **FIXED**

**Where.** `buildVerifyDeps.repair` in `agent-manager.ts:390`, against
`runTrackingCallbacks`' contract at `:674`.

**What.** `runTrackingCallbacks(record, forward, writeTurnCount)` documents
`writeTurnCount` as "the per-path policy — the first run records the absolute
count, a continuation adds to the previous total", and the two paths that existed
when that was written do exactly that:

```js
startAgent            (turnCount) => record.stats.turnCount = turnCount;
continueSettledAgent  (turnCount) => record.stats.turnCount = previousTurns + turnCount;
                                     // previousTurns captured ONCE, before the run
```

The verifier's repair is a third caller and reads differently:

```js
buildVerifyDeps.repair (turnCount) => record.stats.turnCount = (record.stats.turnCount ?? 0) + turnCount;
                                      // re-reads the field it is writing
```

`onTurnEnd` fires once per turn with the *running total* (1, then 2, then 3), so
adding it each time accumulates 1+2+3+… rather than counting turns.

**Proved.** `i7`, driving the real `wireTurnTracking` with each of the three
policies, on a record already showing 5 turns:

```
  policy                        |  1 turn |  2 turns |  3 turns |  5 turns
  ------------------------------+---------+----------+----------+---------
  startAgent (first run)        |       1 |       2 |       3 |       5
  continueSettledAgent (steer)  |       6 |       7 |       8 |      10
  buildVerifyDeps.repair        |       6 |       8 |      11 |      20

  what it should read           |       6 |       7 |       8 |      10
```

**Why a repair is ever more than one turn.** It runs with `maxTurns: 1`, and
`shouldSteerAtSoftLimit(1)` is false — T1's fix, which stopped a one-turn budget
manufacturing a second provider call by steering "wrap up immediately". But pi's
loop keeps going while there are tool results, and the child still has its tools:
a repair that reads two files before answering is three turns and reports six.
The hard abort at `maxTurns + graceTurns` is what bounds it, at 7.

**What it costs.** The number only. It surfaces in the widget's finished line, in
the `turnCount` of the Agent tool's result details, and in the output
transcript's footer — three readers of one field. Nothing in control flow reads
it: the ceiling is enforced by `wireTurnTracking`'s own private counter.

**The fix.** Capture `previousTurns` once, before the run, exactly as
`continueSettledAgent` does.

*Tests:* `vendor/pi-subagents-lite/tests/turn-tracking.test.ts`. The behavioural
table runs a copy of the three policies, because `agent-manager.ts` imports pi and
the suite cannot load it — so it documents the arithmetic, and a seventh case pins
the **source**: no turn-count callback in `agent-manager.ts` may re-read the field
it writes. Comments are stripped first, because the fix's own comment quotes the
defective form, which is the right thing for a comment to do and the wrong thing
for the assertion to match. That case is the one that fails when the fix is
removed.

---

### U9 — `Explore`'s read-only guarantee was a paragraph; it shipped a live `bash` · **MEDIUM** · PROVEN · **FIXED**

**Where.** `default-agents.ts:194`.

**What.** `Explore` declares `registeredTools: ["read", "bash", "grep", "find"]`
and opens its system prompt with

```
# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
… You do NOT have access to file editing tools.
You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state
```

The first sentence is true: `edit` and `write` really are absent. Everything
after it is enforced by nothing at all — a shell is a superset of both, and eight
of the nine prohibitions describe things `bash` does in one token.

**Proved.** `i9`, through the real registry gate and the real visibility filter:

```
  Explore
    registry gate : ["read","bash","grep","find"]
    visible       : ["read","bash","grep","find"]
    has bash      : YES
  __verifier
    registry gate : []
    visible       : []
    has bash      : no
```

`__verifier` is in the table as the control: an agent in this same file that
really does have no tools, because it declares `tools: false` and that is honoured
by both resolvers.

**Why this repo in particular should not accept a prompt as a mechanism.** It has
already measured this exact failure, on this exact model, on this exact subject.
`.pi/extensions/compaction-guard/src/output-cap.ts` exists because of it:

> The notice was in front of the model, saying "Do not read whole files or run
> commands with large output this turn", at 84.5% of the window. It ran the
> command regardless. That is not a bug in the notice and not a threshold that
> needs tuning: a soft instruction does not bind.

That paragraph is the argument for this finding, written in this repo, about a
prompt-level prohibition on tool use. `Explore` rests on a longer and louder
version of the notice that was watched failing.

**What it costs.** `Explore` is one of the two types the `Agent` tool advertises
in its schema description, which makes it the agent a model reaches for when it
wants a safe look around — including at a dirty working tree, or a worktree
belonging to another repo reached through `worktree_path`. The guarantee a reader
takes from the name and the header is not there.

**The fix, and it was a choice between two different products.**

- *Take `bash` away.* The agent then **is** what it says. It loses `git log`,
  `git diff` and shell pipelines, which its own prompt recommended by name.
- *Keep `bash` and stop promising.* Reword the header to what is true, so nobody
  chooses this agent on a guarantee that is not there.

**The first was taken.** `registeredTools` is now `["read", "grep", "find", "ls"]`
— `ls` added so directory listing survives the loss of the shell — and the prompt
was rewritten to describe the tool set rather than to prohibit:

> `# READ-ONLY MODE — ENFORCED BY YOUR TOOL SET` … You have four tools: read,
> grep, find, ls. There is no edit, no write, and no shell, so you cannot change
> anything on disk even by accident. This is not a rule you are being asked to
> follow — it is the whole of what you can do. … You cannot run git. If the task
> needs history, a diff, or a build, say so plainly and stop: it wants a
> general-purpose agent, not this one.

The reasoning for preferring the guarantee: this agent is spawned by the model on
its own initiative, with a prompt the operator never sees, and it is the type a
model reaches for when it wants a *safe* look around — at a dirty tree, or at
another repo through `worktree_path`. That is the one situation where an
unenforced boundary is worth least. And the alternative rests on exactly the thing
`output-cap.ts` measured failing.

The cost is real and is stated in the prompt rather than hidden: `Explore` cannot
run git. `general-purpose` can. Reverting is one line in `default-agents.ts`, and
the trade-off is recorded there.

*Tests:* four cases in `vendor/pi-subagents-lite/tests/declared-resources.test.ts`,
two of which fail without the fix. `general-purpose` still having its shell is the
control.

---

## 9. Reference — the parts no finding touches

Everything above is either the map or a defect. This section is the rest of the
machine, at the level of detail needed to change it safely.

### 9.1 The record's life

One `AgentRecord` per spawn, in `AgentManager.agents`, decomposed into four
sub-objects (`lifecycle`, `display`, `execution`, `stats`) so each reader takes
only what it needs.

```
  spawn()                      status queued | running        started: false
    │                          gate created (createCompletionGate)
    │                          parent signal bound (foreground only)
    │                          brief := prompt                    ← forge fork
    ▼
  startAgent()                 slot reserved · watchdog started · started := true
    │                          outputLog opened if configured
    ▼
  runAgent()                   session created → record.execution.session
    │                          pendingSteers flushed
    ▼
  .then                        status ← aborted | error | turn_limited | completed
    │                          result := responseText
    │                          runVerification()                  ← forge fork
    │                          completedAt stamped AFTER the check
    ▼
  .finally                     settlementCount++ · outputLog finalised
                               slot released · tallyCompletion · drainQueue
                               parent binding detached · gate opened
                               settled := true
```

The **completion gate** is the invariant worth knowing: every record carries a
promise from birth, opened exactly once, and never assigned the run's own promise.
Six paths open it — settlement, a queued stop, a start failure, an
already-aborted spawn, dispose, and record removal — so a foreground `Agent` call
can never hang on a record that will not settle.

A settled record with a live session can be **continued** (`steer` on a terminal
record, from the `/agents` menu or the viewer). That path re-reserves the slot,
appends the new instruction to `brief` (`appendFollowUp`, capped at 6,000 chars,
oldest follow-ups dropped first), clears `verification` — a verdict describes one
answer — and re-attaches the same settlement chain.

### 9.2 Concurrency

`SlotTable` (extracted so it can be tested without pi) holds per-model and
per-provider pools. Precedence is per-model ▸ per-provider ▸ default, and the
default case **creates and caches** a per-model slot, which is why `setLimits()`
must delete slots the new config no longer names.

The rule the fourth pass added, and the reason it matters:

> A `running` count is a fact about the world; a `limit` is configuration.

`setLimits()` therefore rebuilds every count from the holders themselves
(`recount()`), keyed on `execution.holdsSlot` rather than on `status ===
"running"` — because the slot is held right through the verification window,
where the status has already gone terminal.

The default is **1**, and it lives in exactly one place (`config-io.ts`), read
from there by the manager. The measurement behind it is worth keeping: a child
having its own system prompt does **not** by itself evict the parent's cached
prefix — the parent held a 99.2% cache hit across six small child turns. What
evicts it is *size*: a child that grew to 18k tokens took the parent's next call
from 2,117 cached tokens to zero, and from 442 ms to 2,949 ms.

### 9.3 The child's turn ceiling

```
  normalizeMaxTurns(n)   0 → unbounded · absent → 40 · else max(1, n)

  turn_end #maxTurns          softLimitReached := true
      graceTurns <= 0    ──▶  abort NOW, aborted := true          ← S10-era fix
      maxTurns > 1       ──▶  steer "wrap up immediately"
      maxTurns === 1     ──▶  send nothing                        ← T1's fix
  turn_end #maxTurns+grace ─▶ abort, aborted := true
```

The ceiling exists because `AgentSession.prompt()` defaults
`expandPromptTemplates` to true and this fork calls it bare, so a delegated
prompt beginning `/loop …` starts a real loop inside the child. On a one-slot
server an unbounded child is not a runaway agent, it is a stopped machine.

`maxTurns: 1` skipping the steer is T1: pi drains the steering queue immediately
after `turn_end`, so a steer queued from a `turn_end` handler is picked up before
the loop can decide to stop — a one-turn run took a second provider call and
`collectResponseText` reset on the injected message, so the text handed back was
the reply to "wrap up". Both of the verifier's model calls run with `maxTurns: 1`.

### 9.4 The loop's context ladder

Three separate mechanisms, and it is worth keeping them apart.

```
  1. TELL THE MODEL        context handler, every provider call
       >= 60%  advisory line, appended last (cached prefix untouched)
       >= 80%  CRITICAL wording
       pi-loop-mode and compaction-guard both inject one; whichever runs second
       sees the other's `-context-budget` customType and stands down.

  2. DETECT PRESSURE       agent_end → isContextPressure()
       stopReason "length" with <= 32 output tokens
       stopReason "length" at >= 85%
       stopReason "error" matching /400|context|token|length|maximum output/ at >= 85%
       stopReason "error" naming an overflow outright, at any percent
       stopReason "stop" with an EMPTY response at >= 80%        ← the starvation rung
         (empty means: no text, no thinking, AND toolCallsThisTurn === 0)

  3. RECOVER               deferred to agent_settled, because pi runs its own
                           overflow recovery after agent_end and wins the race
       attempt 1,2   → emergency compaction, tighter summary each time
       attempt 3     → cooldown 60s → 120s → 240s, tighter still
       cooldown 4    → pause for a human   ← the only place the loop gives up
```

The measurement that justifies all of it: below 87% of the window, 3 empty
assistant turns out of 196; at or above 87%, 33 out of 63. It is a cliff, not a
gradient, and an empty turn still costs a full iteration.

### 9.5 The handoff summary

On a window of 65,536 tokens or less, *every* compaction the loop owns becomes a
locally-built handoff rather than pi's model-written summary: a bounded summary
that does not grow, a cut at the last complete turn, and no model call at all on
a context the model has already refused.

The allocation order is the fourth pass's fix (S5) and is the load-bearing part:

```
   READ order   goal · criteria · state · durable · files
   CLAIM order  goal · state · criteria · files · durable
                                                  └─ takes whatever is left
   each section holds back MIN_SECTION_CHARS (150) × the sections after it
```

The reason `durable` claims last is that it is the only section also sitting on
disk — the Next Step block already tells the model to read those files — so it is
the one to shrink. Before the fix the body was assembled and then cut with a
blind `slice()` from the front, so `## File Operations` fell off first and
`## Durable Project Context` next, at exactly the compression levels reached only
after a recovery that did not free enough room.

### 9.6 The compaction guard

Three caps, in every session and in every child:

| what | where | number |
| --- | --- | --- |
| the carried-over summary pi feeds itself | `session_before_compact` | 5% of the window, floor 2,000, ceiling 20,000 chars |
| a single tool result | `tool_result` | 10% of the REMAINING window, floor 1,500, ceiling 20,000; head 70% / tail 30%, overflow spilled to a file the marker names |
| the model's blindness to its own budget | `context` | a line above 60%, hardened above 80% |

The tool-result cap exists because the advisory was watched failing: at 84.5% the
CRITICAL notice was in context, the model ran a 3-URL curl loop, 17,790 chars
arrived, the window hit 100% and the next turn was empty. `REMAINING_FRACTION`
is 0.1 rather than 0.2 because a fifth of the remainder would have landed that
run at 88.5% — still above the cliff — and a tenth lands it at 86.8%.

A **background** subagent result does not pass through `tool_result` at all
(pi's `sendCustomMessage` emits no `input`, no `tool_result`, and on the
triggerTurn branches no `message_start`/`message_end`), so `result-cap.ts` applies
the same bound at the source and imports the guard's constants rather than
restating them.

### 9.7 What it costs on the wire

| item | per | cost |
| --- | --- | --- |
| `Agent` + `StopAgent` + `AgentStatus` schemas | parent turn | ~357 chars of schema, no descriptions (stealth registration) |
| everything under `.pi/extensions/` a child discovers | **child** turn | nothing now: the two guards register no tools, and `stack` stands down (U7) |
| `loop` tool schema | parent turn | ~177 tokens |
| `stack_status` schema + snippet + guidelines | **parent** turn | ~173 tokens — it was on every CHILD turn too until U7 |
| the judge's whole system prompt | verified answer | 463 chars |
| a judge call | verified answer | one session build + one turn |
| a repair round | failed verdict | one child turn + one more judge |
| the task anchor | child compaction | ~50 tokens |
| the context budget line | provider call above 60% | ~40 tokens |

---

## 10. Smaller things, and things that are not findings

Recorded so the next pass does not re-derive them. The first is **FIXED**, with
U1; the rest are notes.

- **`consecutiveStuckCount` was reset on two of eighteen `agent_end` exits.**
  **FIXED.** `agent_end` has seventeen `return;` statements and a fall-through end;
  the streak was cleared at the fall-through and at the rescue-turn exit only.
  Exactly the shape of S4 (`penaltyTurnsRemaining`) and T2 (`toolCallsThisTurn`,
  cleared below the early returns), one counter over. In endless mode, where
  LOOP_DONE is a routine outcome, "stuck 3 times in a row" could span an
  arbitrary number of healthy turns — and it is the number the rescue model, the
  compaction rung and the HARD RESET prompt all key on. It is now cleared
  wherever the stuck verdict comes back empty, which is one line and covers every
  exit. Listed separately from U1 because it is a distinct defect: it would have
  survived a fix that only reordered the checks. *Test:* "clears the stuck streak
  on a healthy marker turn" in `stuck-ladder.test.ts`, asserting on
  `/loop status`.
- **A provider-error streak has no terminal state.** The context ladder escalates
  to `pauseForContextFailure` after `MAX_CONTEXT_COOLDOWNS`; the provider-error
  branch retries forever with a backoff capped at 300 s, and never increments
  `iterationCount`, so `--max N` cannot end it either. Defensible for an
  unattended run — the loop is explicitly designed never to die — but the
  asymmetry between the two ladders is not written down anywhere. SOURCE.
- **`consecutiveErrorCount` is shared between context pressure and provider
  errors**, and `backoffSeconds()` reads it, so a run that saw two
  context-pressure turns and then a provider error backs off as if it had failed
  three times. Carried forward from the fourth pass's §10; still true.
- **`getFinalModelError()` returns undefined when the final assistant message has
  `stopReason: "error"` but an empty `errorMessage`.** The run is then classified
  `completed` rather than `error`, so the structural gate judges it and the parent
  is handed whatever text arrived as a successful answer. Whether a provider ever
  produces that shape is unknown; it is one `??` away from being impossible.
  SOURCE.
- **The `Agent` tool's `execute` reads three parameters its schema does not
  declare.** `params.model` and `params.thinking` are injected after validation by
  `toolCallListener`, which is deliberate and works. `params.max_turns` is neither
  declared nor injected, so it is dead: the value always comes from the agent
  file or the store. Harmless, and misleading to a reader — the reverse direction
  of S1. SOURCE.
- **`__verifier` is hidden from the `Agent` tool's type list but not from
  `resolveType`.** The type list is a description string, not a schema `enum`, so
  a model that guesses `agent: "__verifier"` gets a real spawn — one turn, no
  tools, and verification skipped for it by
  `buildVerifyDeps`. Harmless; recorded because "hidden" is doing less than it
  looks like it does. SOURCE.
- **`SlotTable.setLimits()` reads `config.default` with no fallback** (the
  constructor uses `?? fallbackDefault`). Every real caller passes
  `ConfigStore.concurrency`, which merges `DEFAULT_CONCURRENCY`, so it cannot
  currently be undefined — but `Math.max(1, undefined)` is `NaN`, and
  `running >= NaN` is false, which is unlimited concurrency rather than a crash.
  SOURCE.
- **A `providers` or `models` entry of `0` is applied as 1 and then deleted** —
  `applyEntry` clamps with `Math.max(1, limit)` and the cleanup loop treats `0` as
  absent. Consistent outcome (the entry disappears), inconsistent route. SOURCE.
- **`hasStateChange()` matches its keyword list against any tool output**, so
  reading a file containing the word "successfully" resets
  `lastStateChangeIteration` and postpones the no-progress audit. SOURCE.
- **A background subagent result delivered while a loop is running triggers a
  turn that the loop counts as an iteration** — `agent_end` increments
  `iterationCount`, runs the goal check, and evaluates the reply for LOOP_DONE and
  for repetition. The reply to a subagent's report is not a loop iteration. Small,
  and it self-corrects (the loop schedules the next turn normally), but it is one
  more place where "a turn" and "an iteration" are assumed to be the same thing.
  SOURCE.
- **The spawn bracket is still a process-global counter.** Narrowing it to cover
  only extension loading and binding (rather than the whole child run) removed the
  long window in which an operator `/reload` was misread as a subagent. The
  remaining window is milliseconds, and it is still a window. SOURCE, carried
  forward.
- **`detectDegenerateRepetition` runs over every assistant message on every
  `context` event**, and again every 500 streamed characters. Tens of milliseconds
  at 30k tokens, per provider call, growing with the session. Carried forward.
- **`AgentStatus` lists every agent ever spawned this session**, unbounded.
  Carried forward.

---

## 11. What shipped

All nine, plus the `consecutiveStuckCount` note from §10. Every fix carries a
regression test that fails when the fix is removed; where a case passes either
way it is a control and is labelled as one.

| # | Fixed by | Where | Tests | Fail without it |
| --- | --- | --- | --- | --- |
| U1 | the stuck verdict is computed above the marker branches and consulted by them; completion still wins | `pi-loop-mode/extensions/index.ts` | `stuck-ladder.test.ts` ×5 | 3 |
| U2 | `commitTurnMemory()` — the windows are filled once per turn, from buffers every exit drains | same | `stuck-ladder.test.ts` ×3 | 2 |
| U3 | `execFailed` no longer moves the check state; `checkErrorStreak`/`lastCheckError`; its own directive; `lastCheckPassed !== true`; `pauseForCheckFailure` at `MAX_CHECK_ERRORS` | `src/goal-check.ts`, `src/loop-state.ts`, `extensions/index.ts` | `goal-check-errors.test.ts` ×9 | 5 |
| U4 | `readWhy()` — line-anchored, relative to the deciding verdict, never the prompt's own instruction | `pi-subagents-lite/src/agents/verify.ts` | `verify.test.ts` ×7 | 6 |
| U5 | `start` refuses while `state.active`, naming the loop it protected | `pi-loop-mode/extensions/index.ts` | `loop-tool.test.ts` ×3 | 1 |
| U6 | `tools` parsed by `parseExtensions`; no boolean in `registeredTools` | `pi-subagents-lite/src/agents/agent-discovery.ts` | `agent-frontmatter.test.ts` ×8 | 4 |
| U7 | `stack.ts` guards its own factory; the denylist header documents route A; a standing check for the class | `.pi/extensions/stack.ts`, `src/agents/subagent-denylist.ts` | `subagent-denylist.test.ts` ×2 | 1 |
| U8 | `previousTurns` captured once, before the run | `pi-subagents-lite/src/agents/agent-manager.ts` | `turn-tracking.test.ts` ×7 | 1 |
| U9 | `Explore` loses `bash`, gains `ls`; the prompt describes the tool set instead of prohibiting | `pi-subagents-lite/src/agents/default-agents.ts` | `declared-resources.test.ts` ×4 | 2 |
| §10 | `consecutiveStuckCount` cleared wherever the verdict is empty | `pi-loop-mode/extensions/index.ts` | (in U1's five) | — |

### The gates

```
                                    before    after
vendor/pi-subagents-lite   tests    154       182     lint 70/70 files
vendor/pi-loop-mode        tests     88       108
.pi/extensions/compaction-guard      39        39     (untouched)
                                   ─────     ─────
                                    281       329
```

All nineteen probes run clean — `g1`–`g3`, `verify-prior-fixes`, `h1`–`h6` and
`i1`–`i9` — and the nine `i` probes were rewritten afterwards to print BEFORE and
NOW side by side, so each is now its own control.

### Three things worth keeping from how these went

- **Two of the nine changed behaviour the fix was not aimed at, and both were
  wanted.** U2's tool rule went from "three identical results in a row" to "the
  same calls returned the same thing three turns running" — which is what the
  notice always claimed — and U6's `tools: false` went from reaching "no tools"
  through an allowlist of one nonexistent tool to reaching it through the
  `tools === false` branch. Same outcome, now for the stated reason. Both are
  asserted on the registry gate rather than on the outcome, so the difference is
  visible in the test.
- **A control has to be able to fail.** The first version of U1's streak test
  asserted on the next intervention's counter and passed with the fix removed,
  because an ordinary turn in between reset the streak anyway. Asserting on
  `/loop status` immediately after the marker turn isolates it. A control that
  cannot fail is not a control.
- **Two fixes are pinned at the source rather than behaviourally**, because the
  module that holds them imports pi and the suite cannot load it: U8 (no
  turn-count callback may re-read the field it writes) and U7 (nothing in
  `.pi/extensions/` may register a tool without guarding itself). Both strip
  comments first — the fix's own comment quotes the defective form, which is the
  right thing for a comment to do and the wrong thing for an assertion to match.

---


## 12. What was re-verified this pass, and holds

Read out of the tree, not assumed.

- **All ten fourth-pass fixes are in place**, and all six `h` probes plus `g1`–`g3`
  and `verify-prior-fixes` still run clean after this pass's nine changes. The
  gates were `pi-subagents-lite` 154 tests, `pi-loop-mode` 88,
  `compaction-guard` 39 — **281 passing**, lint **69/69** — and are now **329**
  and **70/70** (§11).
- **The judge's prompt is still 463 chars** and still carries no project context,
  no parent system prompt and no environment block. `declaredPromptSources()` is
  the single resolution point and `default-agents.ts` declares all five switches.
- **`registeredTools: []` still resolves to `[]`.** `getConfig` uses `??` and
  `declaredRegisteredTools` uses `Array.isArray`; `i9` shows `__verifier` with an
  empty registry gate and an empty visible set.
- **The loop is inert in a child.** The factory returns before registering any of
  its thirteen handlers when `__PI_SUBAGENT_SPAWN_DEPTH__ > 0`, and
  `defaultExtraExtensionPaths()` no longer names it. Three independent stops.
- **`pi-subagents-lite` is inert in a child** by the same mechanism, so a child
  cannot spawn a grandchild.
- **The prinny denial is keyed on a path segment with an optional package
  prefix**, so it survives `npm i` (`node_modules/pi-prinny-channel/`) and a drop
  into `~/.pi/agent/extensions/`, and it filters the extras list too.
- **The two budget-line injectors still do not double up**, by the shared
  `/-context-budget$/` customType suffix, in either registration order.
- **A verifying record still cannot vanish from the widget.** `categorizeAgents`
  tests `verifyPhase` before the retention test, and `completedAt` is not stamped
  until the check returns.
- **The slot is still held across verification**, and `recount()` still keys on
  `holdsSlot`.

---

## 13. Still unwatched

Unchanged from the fourth pass. Nine defects were fixed against probes and tests
this pass and none of them against a running model, so the list is exactly as
long as it was — and item 1 is now more informative than it has ever been.

1. **A real verification.** Still the highest-value unwatched thing. One
   foreground delegation with `SUBAGENT_VERIFY_ROUNDS=1` and a deliberately
   off-task brief exercises the judge, the repair and the re-judge in one go.
   U4 makes it more informative than it was: the reason line the repair carries
   is now known to be wrong in two common reply shapes, and watching one is how
   that gets confirmed in the field rather than in a probe.
2. **Section I of `context/testing/subagents-loop-verifier.md`** — the hand-testing
   script, never run, now five passes old. The claim to falsify is that an agent's
   row stays put, spinner running, while the judge works.
3. **A delegation with a loop running.** Fixed at the module level twice, never
   watched.
4. **The judge's raw reply is still not logged.** This has been the top
   next-session item since the fourth pass and it is now load-bearing for two
   findings rather than one: a false NOT_ADDRESSED and a true one still produce
   the same badge, the same note and the same `record.verification`, and U4's
   repair prompt is built from text nobody can see either. Both defects are
   fixed; neither result is checkable from outside until the reply is in the
   transcript. **This is the one thing on this list that a fix could remove, and
   it was not attempted here** — it is a question about the transcript format
   rather than about the verifier, and it wants an answer to "where does an
   operator read this".
5. **A child that fills its own 32k and compacts**, so the anchor can be watched
   landing.
6. **The 40-turn ceiling and the steer-then-abort ladder** against a real model.
7. **`stats.verifyUsage` and the 300 s deadline** against a real model.

---

## 14. The pattern across five audits

Each pass found defects in a *place*, and the places have been getting further
from the code:

```
   inside a module            B1–B8    a function does not do what it says
   between two modules        F1–F11   two correct functions disagree at the seam
   module ↔ pi's runtime      T1–T9    correct code, wrong assumption about the host
   declaration ↔ code         S1–S10   the artefact a reader checks is not what runs
   unit ↔ unit                U1–U9    the rule and the thing it governs are each
                                       right, and are counted in different things
```

The fifth is the hardest to test for, because there is nothing to assert against.
A test for U2 would have to know that a turn contains several messages — which is
a fact about pi, not about the loop — and then decide that the loop's window
*should* have been per turn. Nothing in the loop's own source says so; it is only
visible when the comment ("consecutive assistant **responses**") is read against
the handler that fills the array.

Three habits fall out of it, and they are the transferable part:

- **When a comment names a unit, check the handler that fills the array.** Every
  one of U1, U2, U3 and U8 is a comment or a notice that names one unit and a line
  of code that counts another.
- **A branch that returns early is a scope decision, not a shortcut.** `agent_end`
  has seventeen `return;` statements and a fall-through end; U1 is four of them
  skipping a check nobody knew they skipped, and §10's `consecutiveStuckCount`
  note is the same handler again. The
  third pass fixed one counter in that handler (T2) and the fourth fixed its
  sibling three lines away (S4); this pass found the *checks* below them have the
  same problem, which suggests the handler wants restructuring rather than a fifth
  patch.
- **The two directions of a wrong unit look nothing alike.** U2's false positive
  is loud (an intervention on a good turn) and its blindness is silent (no
  intervention on a bad run). Only the loud half would ever be reported by an
  operator, and it is the quieter half that costs a run.

---

## 15. Running the evidence

```sh
cd ~/qwen3.8-forge

# the gates
( cd vendor/pi-subagents-lite && npm test && node tests/lint.mjs )   # 182 + 70/70
( cd vendor/pi-loop-mode       && npm test )                         # 108
( cd .pi/extensions/compaction-guard && npm test )                   #  39

# just this pass's regression tests
( cd vendor/pi-loop-mode && node --experimental-strip-types --test \
    tests/stuck-ladder.test.ts tests/goal-check-errors.test.ts tests/loop-tool.test.ts )
( cd vendor/pi-subagents-lite && node --experimental-strip-types --test \
    tests/verify.test.ts tests/agent-frontmatter.test.ts \
    tests/turn-tracking.test.ts tests/declared-resources.test.ts \
    tests/subagent-denylist.test.ts )

# this pass's probes  (the loop's state is module-global — one mode per process)
P=context/testing/probes
node --experimental-strip-types $P/i1-markers-bypass-the-stuck-ladder.mjs plain
node --experimental-strip-types $P/i1-markers-bypass-the-stuck-ladder.mjs done
node --experimental-strip-types $P/i1-markers-bypass-the-stuck-ladder.mjs blocked
node --experimental-strip-types $P/i2-repetition-window-counts-messages.mjs control
node --experimental-strip-types $P/i2-repetition-window-counts-messages.mjs blind
node --experimental-strip-types $P/i2-repetition-window-counts-messages.mjs noisy
node --experimental-strip-types $P/i2-repetition-window-counts-messages.mjs quiet
node --experimental-strip-types $P/i3-check-that-cannot-run.mjs throws
node --experimental-strip-types $P/i3-check-that-cannot-run.mjs fails
node --experimental-strip-types $P/i3-check-that-cannot-run.mjs passes
node --experimental-strip-types $P/i4-judge-reason-read-first-match.mjs
node --experimental-strip-types $P/i5-loop-tool-start-replaces-a-running-loop.mjs tool
node --experimental-strip-types $P/i5-loop-tool-start-replaces-a-running-loop.mjs command
node --experimental-strip-types $P/i6-tools-true-means-no-tools.mjs
node --experimental-strip-types $P/i7-repair-turn-counter.mjs
node --experimental-strip-types $P/i8-what-a-child-discovers.mjs
node --experimental-strip-types $P/i9-explore-read-only-is-a-prompt.mjs
```

`i6` and `i9` register `_ts-hook.mjs`, which resolves the `.js` specifiers in
`vendor/pi-subagents-lite/src` to the `.ts` files that are actually on disk. That
is what lets `agent-discovery.ts` and `agent-types.ts` be driven under plain node
without pi's loader — the two modules that carry the resolution rules U6 and U9
are about. It only rewrites relative specifiers, and only when the `.ts` file
exists. `tests/agent-frontmatter.test.ts` registers the same hook inline, which is
how a test in the suite reaches those two modules at all.

Each `i` probe now prints **BEFORE** and **NOW**, so running one is enough to see
both the defect and the repair. The loop probes end with `host.quit()`; without it
the process waits out the escalating delay a stuck intervention schedules, which
is up to 60 s.

---

## 16. What is left

Nothing from U1–U9. What remains is what was already there, plus one decision this
pass made that is worth re-opening deliberately rather than by accident.

1. **Log the judge's raw reply.** Still #1, and unchanged by any of this. It has
   been the top item since the fourth pass, it is now load-bearing for two fixed
   defects rather than one, and it is the only thing on the list that would make
   a live verification result checkable by anyone. It was not attempted here
   because it is a question about the transcript format, not about the verifier:
   *where does an operator read this?*
2. **`Explore` lost its shell (U9), and that is a product decision.** It can no
   longer run `git log`, `git diff` or any pipeline, and its own prompt used to
   recommend those by name. The reasoning for preferring the guarantee is in U9;
   reverting is one line in `default-agents.ts`. If it turns out that most real
   `Explore` tasks wanted git, the honest alternative is the other fix — keep
   `bash` and reword the header — and not a third state where it has a shell and
   claims not to.
3. **Watch one of these run.** Nine defects were fixed against probes and tests
   and none against a running model. §13 is the list, and its first item — one
   foreground delegation with `SUBAGENT_VERIFY_ROUNDS=1` and a deliberately
   off-task brief — now exercises a judge whose verdict parser and whose reason
   parser have both been repaired, which is the first time that has been true.
4. **Still open by decision, unchanged:** T5 (verification bounded at 300 s per
   call but uninterruptible), T6 (`worktree_path` reach), T1's general case,
   per-session loop state.
5. **The notes in §10 are still notes**, each with its reason: the shared
   `consecutiveErrorCount`, the provider-error ladder with no terminal state, the
   `Agent` tool's undeclared parameters, `getFinalModelError`'s empty-message
   case, `SlotTable.setLimits`' missing fallback, the degeneracy-scan cost, the
   unbounded `AgentStatus` list, and the subagent-result turn that the loop counts
   as an iteration.
