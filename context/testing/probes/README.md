# Probes — the reproductions behind the audits

These are diagnostics, not tests. They drive the **real modules** with stub hosts
and print what happens, so a claim in `context/design/*.md` can be checked rather
than believed. The regression tests that pin each fix live in the packages'
own `tests/` directories; these exist because a reproduction that shows the
*mechanism* is worth keeping next to the write-up that explains it.

They hardcode the repo path (`/home/claudeuser/qwen3.8-forge`) and pi's install
path. Adjust the constants at the top if either moves.

## How many there are, and what counts as one

Two different counts have been quoted in two different documents, and both were
right about different things. Settled here, once, so the next handoff can quote a
number that means something (`…-identity.md` §12.5):

```
   ls context/testing/probes/*.mjs                                  126
     minus the four shared helpers  _host  _register  _sidecar  _ts-hook
                                                                    123
     minus one un-lettered one-off  verify-prior-fixes.mjs
                                                                    122  ← probes
```

**A probe is a lettered file** — `<letter(s)><n>-<what-it-shows>.mjs` — and there
are **122** of them, up from 113 before the twenty-fourth pass (121 after it, and
`ab9` was added the session after — see the AO9 addendum at the end). The four `_`
files are shared fixtures, not probes; `verify-prior-fixes.mjs` is a one-off
re-check from the second audit, kept because it still runs.

Earlier numbers in `HANDOFF.md` and in the pass write-ups (111 → 118 → 126 → 127)
are the first column, all files; 114 → 122 → 123 is the second. Neither was wrong
and neither said which it was.

| Probe | Finding | Run with | What it shows now (post-fix) |
| --- | --- | --- | --- |
| `g1-judge-double-turn.mjs` | **T1** — a `maxTurns: 1` run took two provider calls and returned the second one's text | `node g1-judge-double-turn.mjs` | `model calls: 1`, and the judge's real `VERDICT:` line comes back. Before the fix: `2`, and the verdict was replaced by the reply to "wrap up immediately". |
| `g2-toolcalls-not-reset.mjs` | **T2** — the loop's per-turn tool counter outlived its turn, disabling starvation detection | `node --experimental-strip-types g2-toolcalls-not-reset.mjs control` then `… stale` | Both modes route the starved turn to context recovery. Before the fix, `stale` reported no notice at all and burned an iteration. Two processes because the loop's state is module-global. |
| `g3-verify-pretry.mjs` | **T3** — `verifyAnswer`'s prologue sat outside its own try, so a throw there discarded the child's answer | `node --experimental-strip-types g3-verify-pretry.mjs` | `prologue throw was contained`, status `errored`, answer intact. Before the fix the throw escaped. Also prints the verifier's real cost in provider calls. |
| `verify-prior-fixes.mjs` | Second audit **F2** and **F3** | `node verify-prior-fixes.mjs` | Effective concurrency slot `{limit:1}` through the real `ConfigStore` → `AgentManager` wiring; `declaredResources` returning `false/false` for `__verifier` where `getConfig` still returns `true/true`. |

## The fourth pass (S1–S10) — `h1`–`h6`

All six defects these were written for are **fixed**. Each probe was rewritten
afterwards to print BEFORE and NOW side by side, so it is its own control: run it
and the left column is the defect, the right column is the tree as it stands. The
regression tests that pin each fix live in the packages, with the failing count
recorded in `context/design/subagents-loop-verifier-surfaces.md` §11.

| Probe | Finding | Run with | What it shows now |
| --- | --- | --- | --- |
| `h1-loop-tool-flag-injection.mjs` | **S1** — the `loop` tool's `goal` parameter carried `--check`, `--model` and every other flag into `parseStartArgs` | `node --experimental-strip-types h1-…` | Both paths on the same four inputs. The old one turns a goal into a shell command run every iteration; the new one keeps it as the goal. The control input is unchanged by either. |
| `h2-judge-verdict-parse.mjs` | **S2** — `parseJudgeVerdict` read an echo of its own instruction line as NOT_ADDRESSED | `node --experimental-strip-types h2-…` | Eight realistic judge replies and how each is read. Four used to come back as failures, including one with an explicit `VERDICT: ADDRESSED` on its own line. |
| `h3-handoff-budget-overrun.mjs` | **S5** — the handoff summary's per-section budgets exceeded its own total | `node --experimental-strip-types h3-…` | All six sections at all three levels of both ladders, the arithmetic that used to make that impossible, and a walk of the boundary as the durable files grow. The emergency ladder is the control: its budgets always fitted. |
| `h4-penalty-turns-never-decay.mjs` | **S4** — `penaltyTurnsRemaining` decayed on 1 of 9 `agent_end` exits | `node --experimental-strip-types h4-… control` then `… done` then `… blocked` | All three modes now retire the sampling penalties after exactly PENALTY_TURNS turns. `done` and `blocked` never did. One process per mode, because the loop's state is module-global. |
| `h5-verifier-inherits-project-context.mjs` | **S3**, **S7** — `__verifier` inherited `includeContextFiles` and `systemPromptMode`, and paid for an environment block | `node h5-…` | The judge's whole system prompt, printed: 463 chars, its own instructions and nothing else, with three context files sitting on the path. Before: 6,543. |
| `h6-concurrency-slot-orphaned.mjs` | **S6** — a concurrency change orphaned the running subagent's slot | `node h6-…` | Four scenarios through the real `AgentManager` and its `SlotTable`: the running agent stays counted across the change and releases cleanly afterwards. Before, the first three lost it. |

`h5` and `h6` need pi's `jiti` (they load modules that import pi); `h1`–`h4`
import modules with no runtime pi imports, so plain node is enough.

`g1` and `verify-prior-fixes` load `.ts` sources through pi's own bundled `jiti`,
because the packages use `.js` specifiers for `.ts` files. `g2` and `g3` import
modules that have no runtime pi imports, so plain node with
`--experimental-strip-types` is enough.

## The fifth pass (U1–U9) — `i1`–`i9`

All nine defects these were written for are **fixed**. Each probe was rewritten
afterwards to print BEFORE and NOW, so it is its own control: run it and the left
column is the defect, the right column is the tree as it stands. The regression
tests that pin each fix live in the packages, with the failing count recorded in
`context/design/subagents-loop-verifier-units.md` §11.

| Probe | Finding | Run with | What it shows now |
| --- | --- | --- | --- |
| `i1-markers-bypass-the-stuck-ladder.mjs` | **U1** — `LOOP_DONE:` / `LOOP_BLOCKED:` returned from `agent_end` above every stuck check | `… i1-… plain` then `… done` then `… blocked` | All three modes now intervene from the second repeat and escalate identically. Before, `plain` gave seven interventions and the two marker modes gave **zero** — and a single turn with the marker removed then reported "no tool usage for 9 turns", the evidence that had been climbing unread. `plain` is the control in both directions. One process per mode. |
| `i2-repetition-window-counts-messages.mjs` | **U2** — the windows counted messages and tool results; the rules count turns | `… i2-… control` / `blind` / `noisy` / `quiet` | `blind` now matches `control` exactly (caught on turn 2, whether the turn is one message or five), and `noisy`/`quiet` are both quiet — the order the model worked in no longer decides the verdict. Before: `blind` never caught it, `noisy` called a productive turn stuck. |
| `i3-check-that-cannot-run.mjs` | **U3** — a check that could not run was recorded as one that failed | `… i3-… throws` / `fails` / `passes` | `throws` counts 1/3, 2/3, then PAUSES, says `LAST KNOWN` rather than "failing", and tells the model the check itself is the work. `fails` and `passes` are unchanged, and are the controls: before the fix, `throws` and `fails` were byte-for-byte identical everywhere except one operator-facing notify. |
| `i4-judge-reason-read-first-match.mjs` | **U4** — the judge's WHY was read first-match and unguarded, and it drives the repair | `node --experimental-strip-types i4-…` | Three judge replies through the real parser and the real repair builder; all three now read the reason the judge actually gave. Before, only the plain two-line reply did — the other two got the prompt's own instruction line and a thinking-aloud aside. The verdict was right in all three throughout, which is S2 holding and this probe's control. |
| `i5-loop-tool-start-replaces-a-running-loop.mjs` | **U5** — `loop(action:"start")` silently replaced a running loop | `… i5-… tool` then `… command` | The tool call comes back `isError: true` naming the running goal and iteration, and the 500-iteration loop is untouched. The slash command still replaces, deliberately — that asymmetry is the finding. Before, both paths reported success and left `Iterations: 0/∞` with a different goal. |
| `i6-tools-true-means-no-tools.mjs` | **U6** — `tools: true` in an agent .md gave the agent no tools | `node --experimental-strip-types i6-…` | Six frontmatter spellings through the real parser, merge and both resolvers, next to the same three words on the sibling `extensions:` / `skills:` keys. `true`/`all` now give tools, `false`/`none` give an empty registry gate rather than an allowlist of one tool that does not exist. |
| `i7-repair-turn-counter.mjs` | **U8** — the verifier's repair added a cumulative turn number every turn | `node --experimental-strip-types i7-…` | Four policies through the real `wireTurnTracking`, with the repair's BEFORE and NOW as separate rows: 5 → 20 against 5 → 10 for a five-turn repair. The first-run and continuation rows are the controls. |
| `i8-what-a-child-discovers.mjs` | **U7** — the denylist models `vendor/`; a child reads `.pi/extensions/` | `node --experimental-strip-types i8-…` | What each `.pi/extensions/` entry registers, **whether it guards itself**, and `stack_status`'s per-turn cost read out of `stack.ts`: 173 tokens, against the 177 that justified removing the `loop` tool from children. `stack` now guards. |
| `i9-explore-read-only-is-a-prompt.mjs` | **U9** — `Explore`'s read-only guarantee was a paragraph; it shipped a live `bash` | `node --experimental-strip-types i9-…` | `Explore`'s registry gate is now `["read","grep","find","ls"]` and its prompt describes the tool set instead of prohibiting. `__verifier` (nothing) and `general-purpose` (a shell) are the controls at either end. |

`_host.mjs` is the shared fake pi/ctx these drive the real loop extension with —
`vendor/pi-loop-mode/extensions/index.ts` has no runtime pi import, so the whole
extension loads under plain node and every handler, the command and the tool can
be called directly. Its `quit()` clears the scheduled iteration; without it a
probe that triggers an intervention holds the process open for up to 60 s.

`_ts-hook.mjs` (registered by `i6` and `i9`, and available as `_register.mjs`)
resolves the `.js` internal specifiers in `vendor/pi-subagents-lite/src` to the
`.ts` files that are actually on disk. That is what lets `agent-discovery.ts` and
`agent-types.ts` — the two modules U6 and U9 are about — be driven without pi's
loader. It only rewrites relative specifiers, and only when the `.ts` exists;
`pi-subagents-lite/tests/agent-frontmatter.test.ts` registers the same hook
inline, which is how a test in the suite reaches those modules at all.

## The sixth pass (V1–V8) — `j1`–`j8`

All eight defects these were written for are **fixed**. Each probe was rewritten
afterwards to print BEFORE and NOW side by side, so it is its own control: run it
and the left column is the defect, the right column is the tree as it stands. The
regression tests that pin each fix live in the packages, with the failing count
recorded in `context/design/subagents-loop-verifier-shapes.md` §10.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `j1-reasoning-only-turn-is-not-empty.mjs` | **V1** — the forge reasoning patch moved a reasoning-only turn from `content: []` to `content: [thinking]`, and the loop's starvation rung read "empty" as "no text AND no thinking" | `… j1-… before` then `… after` | Both shapes now route to context recovery, and the notice says which one it was (`reasoning-only response at 90% context (192 chars of thinking, no answer, no tool call)`). Before, `after` produced **no notice at all**, counted the turn as a successful iteration and reset the recovery ladder. `before` is the control — it was right throughout. |
| `j2-stuck-rules-read-text-only.mjs` | **V2** — the windows were filled from `text OR thinking`; four of `detectStuck`'s seven rules were gated on `text` | `… j2-… text` then `… thinking` | Four turns of the same paragraph rephrased, at exactly the 0.80 similarity threshold. The two columns are now identical — caught on turn 2 either way, because `detectStuck` compares the string `commitTurnMemory` committed. Before, `thinking` produced nothing at all across four turns. `text` is the control. |
| `j3-loop-run-keeps-the-old-check-state.mjs` | **V3** — `runLoop()` reset 25 fields and not the seven pieces of per-run state, six of them the goal check's | `… j3-… score` then `… done` | `score`: run 2 now starts at streak 1 with its own best score and no regression notice. `done`: the `--until-done` run 2 keeps going and asks for the broken check to be fixed instead of completing on the model's word. Run 1 and `/loop resume` are the controls. |
| `j4-stuck-intervention-dropped-when-pending.mjs` | **V4** — the stuck ladder's cheapest rung was the only one guarded by `hasPendingMessages()` | `… j4-… clear` then `… pending` | `pending` now queues the directive onto the turn that is already coming (`deliverAs: "nextTurn"`), so no second turn is scheduled and the text still arrives. Before, it sent nothing and scheduled nothing while charging the whole ladder. `clear` is the control — still a timer. Uses a `setTimeout` spy. |
| `j5-repair-runresult-discarded.mjs` | **V5** — the verifier's repair read one of its RunResult's five fields | `node --experimental-strip-types j5-…` | The real `wireTurnTracking` showing a hard-aborted repair, then the real `verifyAnswer` given that same text twice — once reporting `aborted`, once `completed`. The verdicts now differ (`failed` / `repaired`) on that one field. Before, both came back `repaired` and the fragment went to the parent as "the corrected one, and it was re-checked". `completed` is the control. |
| `j6-one-turn-budget-reads-as-turn-limited.mjs` | **V6** — `softLimitReached` was set for `maxTurns: 1`, which T1 established is a run that finished rather than one that was cut short | `node --experimental-strip-types j6-…` | Six scenarios through the real module. `turnLimited` is now set exactly where the wrap-up steer is sent, so the two `max_turns: 1` rows report `false` and stop being labelled partial and skipped by the verifier. The four other rows are the control, and the hard abort is unaffected. |
| `j7-judge-session-leaks-on-throw.mjs` | **V7** — the judge's session was disposed on the path where `runAgent` returns, and on no other | `node j7-…` | The block printed out of `agent-manager.ts`, the three ways `runAgent` can end, and a replay of BOTH shapes: the old one leaks when the judge throws, the new one (capture in `onSessionCreated`) disposes on every exit. Source-pinned — that file imports pi; the assertion lives in `turn-tracking.test.ts`. |
| `j8-prepared-spec-file-lost-on-restart.mjs` | **V8** — a re-issued goal kept `preparedAt` and reset `goalFile` | `node --experimental-strip-types j8-…` | `/loop goal --file SPEC.md` → `/loop prepare` → `/loop start <same goal>` now leaves `Goal file: SPEC.md (prepared)`, and both lines of the first turn point at the spec that exists. Before, both pointed at a GOAL.md nobody wrote. The two lines before the re-issue are the control. |

`j1`–`j4` and `j8` drive the real loop extension through `_host.mjs`. `j5` and
`j6` import `verify-runner.ts`, `verify.ts` and `turn-tracking.ts`, none of which
has a runtime pi import. `j7` reads `agent-manager.ts` as text.

`_host.mjs` gained one line for `j4`: `sendMessage` records the options it was
called with, attached to the message so every existing probe's
`sent.find(m => m.details.kind === …)` keeps working. A loop turn can be sent,
scheduled, or queued onto a turn that is already coming, and only the options say
which.

## The seventh pass (W1–W6) — `k1`–`k6`

All six defects these were written for are **fixed**. Each probe prints BEFORE and
NOW, so it is its own control: run it and the left column is the defect, the right
column is the tree as it stands. The regression tests that pin each fix live in the
packages, with the failing count recorded in
`context/design/subagents-loop-verifier-readers.md` §10.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `k1-the-turns-answer-read-three-ways.mjs` | **W1** — `agent_end` derives "what the model said this turn" three times; V2 moved `detectStuck` onto the turn's committed answer and left `emptyResponse`, `LOOP_DONE` and `LOOP_BLOCKED` on the last MESSAGE | `… k1-… low` then `… saturated` | A turn that said `LOOP_DONE:` and then thought out loud now completes an `--until-done` run, and is no longer read as starved at 90%. Before, `low` produced no notice at all and `saturated` charged a turn that answered to the context-recovery ladder. The one-message turn and the answered-nothing turn are the controls, one on each side. |
| `k2-near-duplicate-rule-vs-stored-window.mjs` | **W2** — the window stores 1,500 chars of each answer; rule 5 compared the current answer in full against that prefix | `… k2-… short` then `… long` | The same rephrasing at 1.1k and 2.8k characters. Both are now caught on turn 2. Before, `long` produced four turns and `Interventions: 0` — the Jaccard score cannot reach 0.80 against a prefix, however identical the turns were. `short` is the control; it was never affected. |
| `k3-steering-a-running-agent-does-not-grow-the-brief.mjs` | **W3** — `steer()` has two branches and only the settled one grew `record.execution.brief` | `node --experimental-strip-types k3-…` | `steer()` out of the file, the count of branches that grow the brief (2 of 2, was 0), and what each brief leaves the three readers: the judge, `buildRepairPrompt`, and the post-compaction anchor. The BEFORE column is the repair prompt handing the child the original task under "Answer it now". |
| `k4-grace-zero-reports-a-finished-run-as-aborted.mjs` | **W4** — with `graceTurns: 0` a one-turn run that ANSWERED was severed and reported `aborted` | `node --experimental-strip-types k4-…` | The same one-turn answer at grace 6 and grace 0, through the real `wireTurnTracking`, `structuralVerdict` and the shipped `STATUS_NOTES`. The two rows now agree on `completed` and verified. Six control rows below show the ceiling is not lost with the label — including `maxTurns: 1, graceTurns: 0` still severing on turn 2. |
| `k5-verification-notes-the-parent-reads.mjs` | **W5** — `repaired` built `${attempts}th`, `stalled` hardcoded "a third time", `unparsed` dropped the fact that a repair had happened | `node --experimental-strip-types k5-…` | Every note at every budget the round loop can reach. "the second attempt" and "the third attempt" where it read "the 2th"/"the 3th"; `stalled` counting asks rather than a constant; `unparsed` naming the failed first answer when one exists. |
| `k6-onsessioncreated-fires-after-bindextensions.mjs` | **W6** — V7 captured the judge's session in `onSessionCreated` on the strength of a claim that it fires before `bindExtensions`; it was the LAST line of `createAndConfigureSession` | `node k6-…` | The function out of `agent-runner.ts`, the line numbers in order, and a replay of the three ways a spawn can end under both placements. The bindExtensions exit leaked before and does not now. Source-pinned — that file imports pi; the assertion lives in `tests/turn-tracking.test.ts` and pins the ORDER, which V7's own pin could not see. |

`k1` and `k2` drive the real loop extension through `_host.mjs`. `k4` and `k5`
import `turn-tracking.ts` and `verify.ts`, neither of which has a runtime pi
import; `k4` reads `STATUS_NOTES` out of `status-note.ts` as text rather than
importing it, because that module pulls in a `.js` specifier for a `.ts` file.
`k3` and `k6` read `agent-manager.ts` and `agent-runner.ts` as text.

## The stub in `g1` is doing real work — read it before trusting it

It replays pi's agent loop (`pi-agent-core/dist/agent-loop.js:83-170`) in the
same shape: drain steering at the top, `while (hasMoreToolCalls ||
pendingMessages.length > 0)`, emit `message_start`/`message_end` for each
injected message, emit `turn_end`, then drain steering again at line 160. The
two facts that make that faithful are checked separately in pi's source:
`AgentSession._emit` calls subscribers synchronously (`agent-session.js:298`),
and pi never sets `shouldStopAfterTurn`, so the drain always happens. If either
changes in a future pi, this probe stops being evidence — check them first.

## The eighth pass (X1–X5, Y1) — `l1`–`l6`

All six defects these were written for are **fixed**. Each probe prints BEFORE
and NOW, so it is its own control. The regression tests that pin each fix live in
the packages, with the failing count recorded in
`context/design/subagents-loop-verifier-turns.md` §9.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `l1-window-commits-the-trailing-thought.mjs` | **X1** — `commitTurnMemory` took the last non-empty MESSAGE, so a trailing reasoning-only message became "the turn's final answer" and five of `detectStuck`'s eight rules compared it | `node --experimental-strip-types l1-…` | Both directions, with a control on each side. Four byte-identical answers with distinct trailing thoughts: no intervention at all before, caught on turn 2 now, matching the one-message control. Four genuinely different answers with the same trailing thought: "assistant repeated the same response" from turn 2 before, silent now. The reasoning-only turn still commits its reasoning (V1/V2). |
| `l2-degenerate-rule-reads-one-message.mjs` | **X2** — `detectStuck`'s degenerate rule is about ONE response and was handed the turn's LAST message | `node --experimental-strip-types l2-…` | An answer repeating one sentence 9× is caught alone and missed with one thought appended. The rule now scans every message of the turn; a clean answer plus a thought is the control. |
| `l3-degenerate-text-is-gone-before-the-rule-looks.mjs` | **X5** — …and it read that message AFTER the loop's own sanitizer had rewritten it in place, so it could not fire in a real session at all | `node --experimental-strip-types l3-…` | The arithmetic first — 467 chars of 9 identical sentences becomes 357 chars and a marker, and `detectDegenerateRepetition` over the result is `null` — then the shipped module with the replacement applied. The sanitizer and the rule share `DEGENERATE_REPEATS`, so this was total rather than intermittent. |
| `l4-goal-ready-read-off-the-last-message.mjs` | **X3** — `GOAL_READY:` was read off the last message; the one reader W1 could not move | `node --experimental-strip-types l4-…` | A prepare turn whose marker is followed by a reasoning-only message left `Goal file: GOAL.md (not prepared)` and `Status: preparing` for the rest of the session. Two controls: the one-message prepare turn, and a prepare turn with no marker, which must stay unprepared. |
| `l5-tool-counter-survives-a-stop.mjs` | **X4** — `state.toolCallsThisTurn` was reset only in `agent_end`, and `/loop stop` makes `agent_end` return at its first line | `node --experimental-strip-types l5-…` | A starved turn at 90% context after a stop/resume that interrupted a two-call turn: no notice and a counted iteration before, "context pressure detected (1/3)" now. The controls are a fresh counter and a turn that really did call a tool. |
| `l6-clearing-an-agent-mid-verification.mjs` | **Y1** — `/agents` offered Clear on a record whose verifier was still running | `node l6-…` | The real `AgentManager`, the real completion gate, the real `removeRecord`: BEFORE the repair's session is disposed and the gate opens with `""`; NOW `clear()` refuses. The control is the same record with the phase cleared, where Clear works exactly as before. |

`l1`, `l2`, `l4` and `l5` drive the real loop extension through `_host.mjs` and
reset it with `/loop stop` between scenarios, so one process is enough. `l3` is
half arithmetic over `repetition.ts` and half the module. `l6` loads
`agent-manager.ts` and `record-activity.ts` through pi's `jiti`, the same way
`h6` does.

## The ninth pass (Z1–Z4) — `m1`–`m4`

All four defects these were written for are **fixed**. Each probe prints BEFORE
and NOW. The regression tests are named in
`context/design/subagents-loop-verifier-answers.md` §9.

Three of the four are the same shape and it is the shape this pass is about:
**the module called a pi API correctly and pi did something with the value that
nobody had read.** No probe could have caught them, because every probe stops at
the API boundary — which is exactly where `_host.mjs` stops. `m2` and `m4` are
therefore harness work as much as reproductions: they model pi's compaction
schedule and pi's three delivery queues, which is what makes the defect visible.

| Probe | Finding | Run with | What it shows now |
| --- | --- | --- | --- |
| `m1-the-childs-answer-read-off-the-last-message.mjs` | **Z1** — a subagent hands back the LAST MESSAGE it streamed, not the run's answer, and the fallback indexes into an array pi replaces on every compaction | `node m1-…` | Five rows through the shipped `continueAgentSession`. A settled child whose final message is reasoning-only used to come back as `""` — reported to the parent as "The agent returned no answer at all" — and now returns the answer. Controls: the same turn without a compaction, and a first run where the index was 0 and the defect could not bite. The acknowledgement row is deliberately still wrong: no reader can tell an acknowledgement from an answer, and it is fixed at the writer (`m2`). |
| `m2-the-anchor-manufactures-a-turn.mjs` | **Z2** — the task anchor is steered into a run that has already ended, which restarts the agent loop for a turn whose reply becomes the child's answer | `node m2-…` | The real `AgentManager.runTrackingCallbacks` through the real `subscribeToSessionEvents`. Before, every compaction steered the anchor; now only the ones where a turn was going to happen anyway. Three controls: a compaction on the way into a prompt, an overflow compaction with `willRetry`, and a second agent loop already running. `compactionCount` increments in every row, before and after. |
| `m3-the-sanitizer-leaves-the-repetition-in.mjs` | **Z3** — `sanitizeDegenerateText` had a 200-character floor, so for a short repeated unit its own output was still degenerate | `node --experimental-strip-types m3-…` | BEFORE is computed from the old formula rather than remembered. 20 × a 20-character sentence used to be stored with **nine copies still in it**, and sanitizing that returned the same text — a fixed point it could not leave. Also the other direction: a real answer followed by a stutter used to have the answer cut off at 200 characters. The control is the eighth pass's own example, which was already clean. |
| `m4-the-queued-directive-nobody-drains.mjs` | **Z4** — V4's stuck directive is queued `deliverAs: "nextTurn"`, and pi drains that queue only in `AgentSession.prompt()` — the operator-typed path | `node --experimental-strip-types m4-…` | The loop driven through a model of pi's three delivery queues and their drain sites. Before: two "Loop stuck (Nx)" notices, two intervention counts, three turns of sampling penalties — and `everything the model ever received : start`. Now the directive arrives on the same turn as the pending message. |

`m1` and `m2` load `agent-runner.ts` / `agent-manager.ts` through pi's bundled
`jiti`, the same way `h6` and `l6` do. `m3` and `m4` import modules with no
runtime pi imports, so plain node is enough.

**Read `m4`'s `deliveryModel()` before adding a probe that asserts on
`host.sent`.** `_host.mjs` records the options a message was sent with and
interprets none of them; four different `deliverAs` values reach four different
queues with four different drain sites, and only one of those sites is reachable
without a human at a keyboard. `context/design/subagents-loop-verifier-answers.md`
§1 has the map.

## `_host.mjs` now replays pi's in-place message replacement — and that is X5

**It did not, and that is what hid a dead rule for four passes.** A `message_end`
handler may return a message; pi threads it through the remaining handlers
(`ExtensionRunner.emitMessageEnd`, `runner.js:610`) and then **writes it over the
object agent-core is holding** (`AgentSession._emitExtensionEvent`,
`agent-session.js:481` → `_replaceMessageInPlace`, `:425` — delete every key,
`Object.assign` the replacement). pi's own comment says the mutation is what keeps
"agent state, **later turn/agent events**, listeners, and the eventual
`SessionManager.appendMessage` persistence in sync", and `agent_end` is one of
those later events: its `messages` are the same objects.

`pi-loop-mode` uses that hook to truncate degenerate repetition, and
`detectStuck`'s first rule then looked for degenerate repetition in the result.
Same threshold on both sides (`DEGENERATE_REPEATS`), so the rule was unreachable —
and every probe showed it firing, because the host ignored the return value **and**
built fresh message objects for `agent_end`.

Both are fixed: `applyMessageEndReplacement` applies the replacement in place, and
`turn()` builds one object per message and hands the same ones to `agent_end`.
**The control for the change is the rest of this directory** — `g2`, `h4`, `i1`,
`i2`, `j1`, `j2`, `k1` and `k2` print exactly what they printed before it, because
none of them uses text the sanitizer touches.

The general lesson is worth more than the fix: **a harness is a claim about the
host.** For every event one fakes, read what the host does with the handler's
return value, and either replay it or write down why not.

**Ninth-pass addendum — and the other half of that lesson.** The check above was
run to completion for every event the host fakes, and it came back clean
(`…-answers.md` §8.1 has the table). The defects were on the **call** side
instead: three of the ninth pass's four are a module calling a pi API correctly
and pi routing the value somewhere the call site's own comment did not describe —
`deliverAs: "nextTurn"` into a queue only a human drains, `session.steer()` into a
loop that had already stopped and restarts to answer it, and an index into an
array pi rebuilds on every compaction. So: **for every pi API a module CALLS, read
the implementation and write down where the value ends up**, the same way. A probe
that asserts what a module passed to `pi.sendMessage` is a test of the module's
intent, and in a passing run that is indistinguishable from a test of the system.

## The tenth pass (AA1–AA4) — `n1`–`n4`

All four are fixed, and so is every note in the same document's §9 that had a fix
needing no decision from anyone — nineteen of them, plus **T5** (a verification
was uninterruptible) and **`prinny-channel`'s W1 shape**, both of which had been
"open by decision" for three passes. The regression tests are named in
`context/design/subagents-loop-verifier-hosts.md` §11.

This pass is the ninth's instruction carried out: **for every pi API the module
CALLS, read the implementation and write down where the value ends up.** All four
findings came out of that reading, and none of them is visible from inside the
module — which is why three of these four probes read pi's shipped `dist/` as
evidence rather than driving a stub. A stub is a claim about the host; these
print the host.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `n1-the-system-prompt-no-loop-turn-ever-sees.mjs` | **AA1** — pi emits `before_agent_start` from one call site, `AgentSession.prompt()`, and the loop drives every one of its turns through the other entry point | `node --experimental-strip-types n1-…` | The emit sites counted out of pi's `dist` (one), `_runAgentPrompt` printed whole, and then the shipped loop driven through a model of pi's two entry points: an unattended run whose every turn is `base prompt only`, and an attended one where the block leaks onto the first turn of the next loop-driven run and is gone by its second. |
| `n2-the-check-that-cannot-run-still-reads-as-failing.mjs` | **AA2** — `pi.exec` never rejects, so `execFailed` was unreachable; and a timed-out check comes back `code: 0`, i.e. as a PASS | `node --experimental-strip-types n2-…` | pi's **real** `execCommand` called on the three failures `goal-check.ts` names — all resolve, and the timeout resolves `{code: 0, killed: true}`. Then the shipped loop with `--check "sleep 5" --check-timeout 1 --until-done`, which used to complete on iteration 1 with `Check status: passing`. The controls are a check that really failed and one that really passed. |
| `n3-the-pending-messages-nobody-can-see.mjs` | **AA3** — `ctx.hasPendingMessages()` counts two arrays that only an operator's keyboard can fill | `node --experimental-strip-types n3-…` | Every writer of `_steeringMessages`/`_followUpMessages` out of pi's `dist`, `sendCustomMessage` printed whole, the loop's nine call sites, and a truth table: four ways a message can really be waiting, and the one that answers `true`. |
| `n4-the-delivery-mode-that-is-never-read.mjs` | **AA4** — the background result's `deliverAs` was picked by a ternary whose other arm pi never reads | `node --experimental-strip-types n4-…` | `isStreaming` and `isIdle` out of pi (both `_isAgentRunActive`), the coordinator's own line, and a BEFORE/NOW routing table. The idle row is identical in both columns, because `_runAgentPrompt` discards the value either way; the busy row moves from the steering queue to the follow-up queue. It also says what the change does NOT do — both queues drain inside the same agent run and the same `agent_end`, so W1, X1, X2 and X3 stay load-bearing. |

`n1` and `n2` drive the shipped loop extension; `n2` hands it pi's real
`execCommand` as `pi.exec`, which is the point. `n3` and `n4` are source pins
over pi's `dist` and the tree, because the fact under test is pi's routing and a
stub of it would be the thing being questioned.

**`_host.mjs`'s `exec` stub had no `killed` field, and no completion marker.**
That was AA2's blind spot in one line and then AB1's in the same line, and the
eleventh pass fixed it rather than documenting it again. The default is now
`execResult()`, which puts the marker bash's `EXIT` trap prints where bash would
put it — so a stub for "a check that passed" and a stub for "a check the OOM
killer reaped" are finally different objects. `i3`'s `throws` mode should still be
read as "if pi ever rejected", which it does not.


## The eleventh pass (AB1–AB4) — `o1`–`o4`

All four are fixed. This pass is the tenth's homework — the host-call ledger run
over the two packages nobody had read, `vendor/prinny-channel` and
`vendor/rtk-pi` — plus one more question asked of every value the host hands
back: **how long is this true, and who is listening when it becomes true?** The
regression tests are named in
`context/design/subagents-loop-verifier-signals.md` §12.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `o1-the-check-that-was-killed-by-something-else.mjs` | **AB1** — `result.killed` is pi's OWN kill; a check reaped by a signal pi did not send comes back exit code 0, i.e. as a PASS | `node --experimental-strip-types o1-…` | pi's **real** `execCommand` on six cases, each run twice — bare, and wrapped in the `EXIT` trap `runGoalCheck` now uses — with a BEFORE/NOW verdict column. Three signal deaths read as `PASSED` before and `could-not-run` now. Then the shipped loop with `--check "kill -9 $$" --until-done` and one `LOOP_DONE:`, which used to complete. The controls are a real failure, a real pass, and pi's own timeout (which `killed` already caught). |
| `o2-the-matrix-message-pi-refused.mjs` | **AB2** — `pi.sendUserMessage` returns void and pi `.catch`es the rejection into `emitError`, whose listener set is empty outside a TUI | `node --experimental-strip-types o2-…` | The binding that catches it, out of pi's `dist`; the count of `onError` registrations (one) and the conditional guarding it; the absence of any error member of `ExtensionEvent`; every line at which `prompt()` throws; and then prinny's replacement evidence as a five-row truth table. The control is a message queued behind a running turn, which must never be reported. |
| `o3-the-rtk-probe-that-cannot-see-a-hang.mjs` | **AB3** — rtk's load-time version probe reads `code` and never `killed` | `node --experimental-strip-types o3-…` | pi's real `execCommand` on four rtk states, with the probe's verdict computed both ways. The two states the probe was written for are answered correctly in both columns; only the wedged one differs. Then a source pin on the ORDER at both `pi.exec` call sites, because `rewriteCommand` forty lines away was already right. |
| `o4-the-abort-that-arrived-too-early.mjs` | **AB4** — `addEventListener("abort")` on an already-aborted signal never fires, and `forwardAbortSignal` had no `.aborted` test | `node --experimental-strip-types o4-…` | The JS semantics executed both ways round; then the *wrong* fix executed — `session.abort()` before `session.prompt()`, which still prompts — which is why the repair is a refusal rather than an abort; then every `addEventListener("abort")` in the package with its `.aborted` pair, so a fourth one cannot appear unclassified. |

`o1` and `o3` drive pi's real `execCommand`; `o2` and `o4` are source pins over
pi's `dist` and the tree. All four exit non-zero if an expectation fails, so the
`for f in …` sweep at the top of this file is a real check for them and not only
a smoke test.

**Eleventh-pass addendum, and it is about this directory rather than about pi.**
The eighth pass's lesson was *a harness is a claim about the host*, and it was
applied to events. AB1 is the same lesson applied to a **return value**: every
`exec` stub in `vendor/pi-loop-mode/tests` and `_host.mjs`'s own default returned
`{ code: 0, stdout: "", stderr: "" }`, which is a faithful shape for a check that
passed silently and an equally faithful shape for a check that was SIGKILLed. Six
suites and every probe were built on a stub that could not tell the two apart,
which is precisely why nothing failed when the module could not either. So the
check is not only "does the harness replay what the host DOES with my value" but
also **"can the harness produce every distinct value the host can return?"** —
and if it cannot, the case it cannot produce is the one nobody is testing.

## The twelfth pass (AC1–AC5) — `p1`–`p4`

All five are fixed. This pass asked one question of everything that produces an
answer — **name the reader, and say what the reader sees when the delivery
fails** — and §8 of
`context/design/subagents-loop-verifier-deliveries.md` is the ledger it produced.
The regression tests are named in that document's §12.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `p1-the-background-result-that-never-arrived.mjs` | **AC1** — AA4's edit deleted `const ctx = getSessionCtx()` along with the ternary that used it, leaving three readers below it, so every background subagent's answer and every continuation's threw `ReferenceError` three lines before `pi.sendMessage` | `node p1-…` | The real `SpawnCoordinator`, loaded through pi's bundled jiti. BEFORE is a copy of the shipped file with the binding taken back out, loaded and run and then deleted: 0 messages injected, and the operator told "Result available". NOW: one `followUp` message carrying the child's text, and a 60k answer capped to 1.5k at 90% context — the other thing the binding switched off. Controls: a missing record, and an absent session ctx. |
| `p2-a-check-verdict-that-outlived-its-run.mjs` | **AC2** — `/loop resume` carries `lastCheckPassed` and `checkErrorStreak` across from the run that ended | `… p2-… verdict` / `streak` / `control` | `verdict`: a completed `--until-done` run, resumed with a check the OOM killer now reaps, used to print `Status: completed` four lines above `the check has not run for 1/3 turns`. `streak`: a resume after `pauseForCheckFailure` used to report "(4/3)" and re-pause at once. `control` is the same scenario through `/loop run`, which resets the state outright (V3) and was always right. One process per mode. |
| `p3-the-exit-trap-a-check-can-take.mjs` | **AC3** — a bash `EXIT` trap is a slot, not a stack, so a check that sets its own or `exec`s removes AB1's completion marker | `node --experimental-strip-types p3-…` | Nine checks through pi's **real** `execCommand`, each built twice — under the eleventh pass's wrapper and under this one's subshell — with the loop's verdict for each. Three ordinary checks moved from `COULD-NOT-RUN` to their real answer. The controls are the OOM kill the marker exists for, a `SCORE:` line, a multi-line check, a syntax error, and pi's own timeout. |
| `p4-the-message-prinny-answered-itself.mjs` | **AC4** — AB2's sweep reported messages prinny had answered itself · **AC5** — `/compact` was allow-listed, advertised, and undispatchable | `node --experimental-strip-types p4-…` | pi's command dispatch out of `dist/` (extension registry only), the four extension commands this stack registers, `compact` in `BUILTIN_SLASH_COMMANDS` and its one executor in `interactive-mode.js`; then the sweep's verdict on every kind of entry, BEFORE and NOW. The controls are a plain undelivered message, which must still be reported, and a busy session, which must never be. |

`p1` loads a pi-importing module through pi's own bundled `jiti`, the way `h6`,
`l6`, `m1` and `m2` do. `p2` drives the shipped loop through `_host.mjs`. `p3`
drives pi's real `execCommand` and real bash. `p4` is half a source pin over pi's
`dist/` and half the real rule. All four exit non-zero if an expectation fails.

**Twelfth-pass addendum, and it is about the tests rather than about pi.** The
eighth pass's lesson was *a harness is a claim about the host*; the eleventh
added *a harness must be able to PRODUCE every distinct value the host can
return*. AC1 is the next one out, and it is uncomfortable because the instrument
that missed it is a test rather than a stub: **a fix whose test cannot EXECUTE the
function it changed is pinned against editing, not against breaking.** The test
guarding AA4 reads `spawn-coordinator.ts` as text and asserts a regex; both of its
assertions are true of the broken tree. Its header explains that the module
imports pi and so cannot be loaded by the suite — which was never re-examined,
even though four probes in this directory already load pi-importing modules
through pi's jiti. A source pin catches a revert; it cannot catch a deletion three
lines away.

## The thirteenth pass (AD1–AD7) — `q1`–`q4`

All seven are fixed. This pass asked the mirror of the twelfth's question —
**name the mechanism, and say what happens to the instruction it was given** —
and §2 of `context/design/subagents-loop-verifier-controls.md` is the control
ledger it produced: twenty-eight instructions, where each is set, where it is
resolved, which mechanism is supposed to obey it, and whether that mechanism ever
sees it. The regression tests are named in that document's §12.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `q1-the-model-override-nobody-applies.mjs` | **AD1** — the six-level subagent model precedence was resolved, injected onto the tool-call arguments, rendered next to the call, listed in `/agents` → models, and then dropped by one `undefined` in `executeAgentTool` | `node q1-…` | The real `toolCallListener` and `executeAgentTool` through pi's bundled jiti. The listener writes `input.model = forge/qwen3-4b` and `renderAgentToolCall` prints `▸ Explore (qwen3-4b)`; BEFORE, the spawn ran on `forge/qwen3.8-27b` and held the parent's concurrency slot. The control is `params.thinking`, written by the same handler onto the same object one line away, which IS read — so a handler's write demonstrably reaches `params`. |
| `q2-the-stop-the-tool-cannot-reach.mjs` | **AD2** — T5 made a verifying record stoppable in `AgentManager.stopAgent()`; the `StopAgent` TOOL's own precondition, keyed on `lifecycle.status`, returned before the manager was asked | `node q2-…` | A record in exactly the state `attachSettlementChain` leaves it in during a verification — status `completed`, `verifyPhase: "judging"` — driven through the real manager. The `/agents` path aborts the check; the tool used to answer "already completed. Running agents: none" with the signal untouched. Controls: the menu path, and an ordinary running agent. |
| `q3-the-compact-that-aborts-someone-elses-turn.mjs` | **AD3** — AC5 made `/compact` from Matrix real, and pi's `compact()` begins `await this.abort()`, so a remote command cancelled the turn in flight and paused an unattended loop as `Turn aborted by operator` | `node --experimental-strip-types q3-…` | pi's `compact()` pinned at its first statement; `planCompaction` executed in all three states (BEFORE: `compact() → abort()` in two of them); then the shipped loop module driven through an ordinary iteration and an aborted one, printing `Status: paused` and the operator's name. The control is the same run with no abort. |
| `q4-what-a-leading-slash-from-matrix-can-do.mjs` | **AD4** the command receipt · **AD5** `/agents` in no table · **AD6** `--check` skipping every gate · **AD7** `--rescue-model` | `node --experimental-strip-types q4-…` | The four registration sites vs `KNOWN_COMMANDS`; `--check` through `parseStartArgs` and `wrapCheckCommand`; the same string through `needsApproval` as a `bash` tool call (`gate=true`) against `runGoalCheck`'s `pi.exec` (no `tool_call` at all); pi's `_tryExecuteExtensionCommand` catch that emits an error and returns `true`; and the sweep's verdict per entry kind. Controls: a plain undelivered message, `/loop start` without flags, and `--checkout`, which is prose. |

`q1` and `q2` load pi-importing modules through pi's own bundled `jiti`, the way
`h6`, `l6`, `m1`, `m2` and `p1` do. `q3` drives the shipped loop through
`_host.mjs` and pins pi's `dist/`. `q4` is half a source pin and half the real
rules. All four exit non-zero if an expectation fails.

**Thirteenth-pass addendum, and it is about a test rather than a probe.** The
twelfth pass's lesson was that *a fix whose test cannot EXECUTE the function it
changed is pinned against editing, not against breaking*. AD1 is the next one
out, and it is worse: the test that pinned AA4's edit asserted an **absence** —
`assert.doesNotMatch(execution, /params\.model\b/)` — and an assertion about an
absence cannot be wrong about whether the text is there. It can only be wrong
about *why it should not be*, and it carries that reason nowhere. So it made the
defect the protected state: the first thing that happened when this pass restored
the read was that the suite went red.

**A test that asserts something is NOT read must also assert what supplies the
value instead.** The replacement does: it pins the two reads the tool_call
listener's writes are for, and pins the listener that writes them, so the pair
cannot drift apart silently in either direction.

## The fourteenth pass (AE1–AE7) — `r1`–`r3`, and `_sidecar.mjs`

All seven are fixed. This pass asked about the machine's account of **itself** —
*name the flag, name the fact it stands for, and name what can make the fact
false without the flag hearing about it* — and §2 of
`context/design/subagents-loop-verifier-claims.md` is the claim ledger it
produced: twenty-four flags, what each stands for, who may falsify it, and
whether it is told. The regression tests are named in that document's §16.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `r1-the-pause-that-keeps-running.mjs` | **AE1** — `agent_end`'s operator-abort rung set `status = "paused"` and left `state.active` true, which is what all thirteen handlers test at their first line | `… --experimental-strip-types r1-… aborted` then `… control` | The shipped loop module through `_host.mjs`. NOW: `Active: false`, nothing scheduled, and `before_agent_start` injects nothing. BEFORE: `Active: true`, the next `agent_end` from any source ran the whole ladder, counted an iteration and scheduled `loop/continue` — with no notice. `control` is the same run without the abort, which must still schedule, still count, and still inject the loop rules. |
| `r2-the-name-the-override-is-keyed-on.mjs` | **AE6** — AD1 made `params.model` the value the spawn obeys, which made the KEY the listener resolved it against load-bearing; the listener uses the name the model typed against the registry as it stands, the tool uses the canonical name after a discovery scan | `node r2-…` | The real `toolCallListener` and `executeAgentTool` through pi's bundled jiti, over both halves: an operator's per-type pin skipped for a case-different name (with `renderAgentToolCall` printing the *unpinned* model beside the call), and an agent found only by the discovery retry losing its own `model:` frontmatter to the parent's. Controls: the same delegation by its exact registered name, byte-identical in both columns, and AD1's own control that a stamped injection is still what the spawn uses. |
| `r3-the-compaction-that-cancels-its-own-continuation.mjs` | **AE2** the deferred `/compact` vs the continuation · **AE3** the room entry a second message destroyed · **AE4** `retrying` claimed on a call that cannot fail | `for m in same-room settling-together never-taken control; do node r3-… $m; done` (and `PROBE_SLOW=1 … never-taken`) | The whole `prinny-channel` extension, in-process, over the real MCP sidecar protocol — so `deliverInbound`, `classifyMatrixCommand`, `planCompaction`, `markLive`, `forwardResult` and `drainPendingCompaction` are all the shipped ones. `same-room`: the answer to the question is delivered (BEFORE: the room received nothing, ever). `settling-together`: the compaction stands aside and runs on the settlement after the continuation (BEFORE: it aborted the run the same handler had started two lines earlier). `never-taken`: the operator's own terminal answer is NOT forwarded to Matrix (BEFORE: it was), and with `PROBE_SLOW=1` the sweep reports the nudge as undelivered. `control`: one question, one answer, and the turn after it goes nowhere near Matrix. |

`_sidecar.mjs` is not a probe. It is a stand-in for the prinny sidecar that a
probe can DRIVE: it speaks the same MCP handshake as
`vendor/prinny-channel/tests/fixtures/fake-sidecar.mjs`, but takes its inbound
messages from a JSONL file the probe appends to and records every `tools/call`
to another. The fixture sends one message, at a moment it chooses, and throws its
tool calls away — which is exactly why AE2, AE3 and AE4 could not have been
executed against the real extension before this existed. The fixture is
unchanged and is still the right thing for its own suite.

**One process per scenario, in `r1` and `r3` alike, and in `r3` it is not
cosmetic.** `awaitingReply` is module state and `forwardToMatrix` refuses to send
when more than one room is live — correctly, because with two there is no way to
tell whose answer this is. So a leftover live room from an earlier scenario
SUPPRESSES the leak the next one is about, and a single-process probe reports it
fixed. That was observed while writing this probe, not reasoned about: the
`never-taken` block passed for the wrong reason until the scenarios were split.

**Fourteenth-pass addendum, and it is about probes rather than tests.** The
twelfth pass's lesson was that a fix whose test cannot EXECUTE the function it
changed is pinned against editing, not against breaking; the thirteenth added
that a test asserting an ABSENCE is a test of a premise. This one is narrower and
comes out of `r3`: **a probe that shares module-global state between its own
scenarios is a probe whose later scenarios have an unstated precondition.** Each
of `r3`'s four blocks is a claim about a machine in a particular state, and three
of them were quietly being run against a machine an earlier block had left
differently. Split them, or assert the precondition.

## The fifteenth pass (AF1–AF6) — `s1`–`s4`

All six are fixed. This pass asked about the places the stack decides **not to
act** — *name the guard that declines, name what it was holding, and say who owns
that thing afterwards* — and §2 of
`context/design/subagents-loop-verifier-omissions.md` is the refusal ledger it
produced: forty-five refusals, what each was holding, and where that thing
went. The regression tests are named in that document's §16.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `s1-the-answer-two-rooms-were-both-owed.mjs` | **AF1** — `forwardToMatrix` refuses to send when two rooms are live, correctly, and `forwardResult` then retires both of them: two questions deleted along with the evidence that they were ever asked | `for m in two-rooms one-room-nothing-to-send control; do node s1-… $m; done` | The whole `prinny-channel` extension over the real MCP sidecar protocol. pi's own follow-up drain is pinned first, because it is the premise: two messages delivered while pi is busy are consumed by ONE run, so both rooms are live when its answer arrives. `two-rooms`: neither room gets the answer (right) and both are told why (new). `one-room-nothing-to-send`: a tool-call-only turn, the other sentence. `control`: one question, one answer, and nothing else — an answered room is never apologised to. |
| `s2-the-six-oldest-agents.mjs` | **AF4** — `settled.slice(-limit)` over `listAgents()`, which sorts newest-first · **AF2** — `clear()` and `abort()` refusing while the caller reported success | `node s2-…` | The real `AgentManager` and the real `AgentStatus` tool through pi's bundled jiti, with ten settled records written straight into the manager so the ordering under test is the shipped one: BEFORE `a5…a0 (+4 older)`, NOW `a4…a9 (+4 older)`. Then the manager is driven into the two states where an action is refused — a verifying record (Y1) and a settled one — and the sentence the operator now gets is printed beside the boolean. Controls: the same records handed over oldest-first, and both calls on records that DO accept them. |
| `s3-the-output-that-was-an-error.mjs` | **AF6** — the output cap's `if (isError) return`, over pi's bash tool, which throws the WHOLE formatted output on a non-zero exit | `node s3-…` | pi's `bash.js:346-349`, `truncate.js`'s 2,000-line / 50 KB bound and `createErrorToolResult` all pinned, then the SHIPPED handler driven with a 17,738-character failing test suite at 84.5% of a 32,768-token window — within fifty characters of the 17,790-character curl result the extension was built for. BEFORE: untouched. NOW: 1,970 chars, head and tail kept, spilled to a file the marker names. Controls: the identical text as a SUCCESS (same length), and a short error (not rewritten at all). |
| `s4-the-directive-that-was-never-said.mjs` | **AF3** — five exits of `agent_end` that charged the ladder and dropped the directive when `hasPendingMessages()` was true | `for m in pending idle; do node --experimental-strip-types s4-… $m; done` | The shipped loop module through `_host.mjs`, driven to each of the five outcomes in turn: `improve`, `unblock`, `check_failed`, `regression`, `audit`. BEFORE, every row read `(nothing)`. NOW each is `KIND/steer` — queued onto the turn that is already coming, in the mode Z4 established pi actually drains. `continue` still reads `(nothing)`, which is the line the fix draws. Mode `idle` is the control: all six start a turn of their own. |
| `s5-two-extensions-one-compaction.mjs` | **§11.12** — `pi-loop-mode` and `prinny-channel` both calling `ctx.compact()` on one `agent_settled`, which pi does not refuse: its first statement is `await this.abort()` | `node s5-…` | **The first probe in the series that drives TWO extensions against each other**, and it has to be — the collision only exists in one process, because node's module cache is why both extensions share a session at all. Both shipped modules, loaded through pi's jiti, registered and fired in `scripts/pi-local.sh`'s order. A Matrix `/compact` is deferred mid-turn (AD3) while an empty turn at 95% arms the loop's context recovery, and then `agent_settled` fires: BEFORE, two `ctx.compact()` calls, the second aborting the first; NOW one, and the sender is told theirs is already running. Controls: the interlock at the module level (one takes it, the other is refused, a non-owner's release does nothing), the reverse order — where the loop must ADOPT rather than abort — and a fresh run with the lock free, which must compact exactly as before. |

`s1` uses `_sidecar.mjs`, the driveable stand-in the fourteenth pass added, and
runs **one process per mode** for the reason `r3` does. `s2`, `s3` and `s5` load
pi-importing modules through pi's own bundled `jiti`. `s4` drives the loop
through `_host.mjs`. All five exit non-zero if an expectation fails.

`s5` needed one thing none of the others did: its `ctx.compact` **deliberately
never calls back**, because a compaction that is still running is the only state
the collision happens in. That is faithful to the moment and it is also why the
loop's own suite had to start clearing the lock between tests — see the note in
`tests/context-recovery.test.ts`'s `reset()`. Process-global state shared by two
packages needs the same discipline `r3` established for one.

**Fifteenth-pass addendum: a stub that repeats itself is an input the module has
an opinion about.** `s4`'s audit block reported `stuck/steer` where it wanted
`audit/steer`, because the harness returned the same stub tool result every turn
and `detectStuck`'s rule 7 is *"the same TURN tool signature three turns
running"*. The probe was not wrong about the loop; it had accidentally driven the
loop into a different, correct verdict. That is X1's lesson one layer down: a
harness models the host, and **a harness that returns a constant is modelling a
host that repeats itself** — which several rules in this stack are specifically
looking for. Vary what the stub returns unless the repetition is the point.

## The sixteenth pass (AG1–AG6) — `t1`–`t5`

All six defects these were written for are **fixed**. Each probe was rewritten
afterwards to print BEFORE and NOW side by side, so it is its own control: run it
and the left column is the defect, the right column is the tree as it stands.
`t5` is the exception and is a standing check rather than a reproduction.

This pass asked what the stack *names*: **name the flag, the tool, the entry
point, the surface or the sibling rule that a decision or a sentence points at,
and then go and read it.** Five of the six findings are a pointer that was never
followed, and in every one the thing pointed at already existed and already
worked. `context/design/subagents-loop-verifier-references.md` is the write-up;
§11 has the fix and the control-run failing count for each, and §12.1.1 is the
table of what each one cost.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `t1-the-nudge-and-the-compaction-already-running.mjs` | **AG3** — `prinny-channel`'s empty-turn continuation was sent from `forwardResult()`, on the `agent_settled` the loop has just requested an emergency compaction on. `startCompaction` twelve lines away reads `compactionInFlight()`; this sender did not | `node t1-…` | Both shipped extensions in one process through pi's jiti, in `scripts/pi-local.sh`'s order, fired the way `ExtensionRunner` fires them — the `s5` harness, pointed at the other collision. pi's three facts are pinned from source first (`compact()` aborts then takes the controller; `prompt()` refuses while it is set; pi swallows the rejection into an empty listener set). Then one Matrix question goes live and the run ends empty at 95% of a 32k window. BEFORE: one nudge sent, **zero that pi would have taken**, one of the two retries charged for it, and nothing said to the sender until the sweep guessed a minute later. NOW: no nudge, no retry charged, and the room is retired on that settlement with the true reason — "the session was already compacting its context". |
| `t2-the-turn-that-does-not-have-to-ask.mjs` | **AG2** — every loop turn is delivered through `pi.sendMessage(…, {triggerTurn:true})`, i.e. `sendCustomMessage`, whose `triggerTurn` branch calls `_runAgentPrompt` directly — and pi's compaction refusal is on `prompt()` alone | `node t2-…` | The same harness, the other direction. pi's two entry points are pinned from source, together with the fact that `compact()` ends by **replacing** `agent.state.messages`. Then a `--delay 1` loop finishes an ordinary productive turn, a Matrix `/compact` arrives in the idle gap (so `planCompaction` says "now"), and the delay timer fires. BEFORE: one turn delivered `duringCompaction=true`, on the route that starts a run, with nothing said. NOW: none, one notice naming the holder — and the last block releases the lock and shows the same iteration going, because the fix defers and never drops. |
| `t3-the-half-of-the-task-the-judge-is-shown.mjs` | **AG1** — `briefForCheck` reserved `floor(max * 0.5)` for the accumulated follow-ups and never spent the remainder on them, though its docstring says it applies `appendFollowUp`'s split, which gives them everything the original does not use | `node --experimental-strip-types t3-…` | The shipped `verify.ts`, with the old ceiling modelled beside it. A one-line brief steered four times: BEFORE 481 characters of a 1,500-character budget and one follow-up of four; NOW 1,301 and three of four. The AF5 shape — a 1,400-character original — is the control and every column is unchanged there, which is why all seven AF5 assertions pass either way. Then the boundary walked as the original grows: the two diverge for every original below ~750 characters, which is the ordinary shape. |
| `t4-the-two-sentences-and-what-they-name.mjs` | **AG5** — `bulkReport`'s partial line said "still busy" for a refused *stop*, which is reachable from one `return false` that means the record had already finished · **AG6** — four drop notices named `AgentStatus` as the recovery, and `AgentStatus` prints `id (type) status` | `node --experimental-strip-types t4-…` | Both shipped modules printed BEFORE/NOW next to the source of the thing each sentence names: `stopAgent`'s only `return false`, `AgentStatus`'s per-agent template, `/agents`' `View result` action, and the coordinator's own catch, which now shares the sentence instead of keeping a fourth copy. Also asserts that `tests/action-report.test.ts` now exercises the partial case for both verbs, where it used to do so only for `Cleared`. |
| `t5-the-event-bus-the-map-draws.mjs` | **AG4** — §1.D of five documents drew `pi-subagents-lite` handling `agent_start`, `message_end` and `agent_end`, which it does not, omitted `tool_call`, which it does, and had no row for `turn_start` at all | `node t5-…`, and `node t5-… <any document>` | **A standing check, not a reproduction**, and the only assertion AG4 has — the artefact under test is prose. It derives the table from every `.ts` in the five packages and diffs it against the table in a document given as an argument, defaulting to the sixteenth pass's. All six documents now pass it; before the correction each of the five older ones reported the same five differences. |

`t1`, `t2` and `t5` run under plain node; `t3` and `t4` need
`--experimental-strip-types`. `t1` and `t2` share `s5`'s state-directory and
`_sidecar.mjs` setup and are safe to run in any order.

**Sixteenth-pass addendum: a scan for wiring must not read the prose about the
wiring.** `t5`'s first draft reported a `tool_result` handler in
`pi-subagents-lite` that does not exist — `src/spawn/result-cap.ts`'s header
comment contains the literal string `pi.on("tool_result")` while the module
registers nothing at all. Every module in this stack quotes its own wiring in
prose, at length, and that is a virtue everywhere except in a tool that greps for
wiring. Strip comments first; the probe does, and says so where it does it.

## The seventeenth pass (AH1–AH6) — `u1`–`u5`

All six defects these were written for are **fixed**. Each probe prints BEFORE
and NOW side by side, so it is its own control: run it and the left column is the
defect, the right column is the tree as it stands.

This pass asked the question the sixteenth left in its handoff, and then asked it
of every other rule this stack has paid for: **a rule that is right is applied
where it was found — name every other place it belongs, from the code that COULD
need it rather than from the code that already asks.**
`context/design/subagents-loop-verifier-instances.md` is the write-up; **§10.5 is
the second-instance graph**, which is what this pass exists to leave behind, and
§11 has the fix and the control-run failing count for each finding.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `u1-the-verdict-that-was-its-own-opposite.mjs` | **AH2** — `parseJudgeVerdict` read `VERDICT: UNADDRESSED` as ADDRESSED, with `unparsed: false`, so the answer went back to the parent model as `passed` with no note at all. Open since the twelfth pass · **AH5** — `verificationNote("failed", 0)` said "no attempt was made to correct it" and "kept because the corrections were no better" in one sentence | `node --experimental-strip-types u1-…` | The shipped parser with the old `readVerdictValue` modelled beside it. Five ways a 27B writes "no" — PASS in every one BEFORE, fail in every one NOW — and the second column is the finding: four of the five were `unparsed: false`, i.e. **parsed, confidently, as their own opposite**, where the fail-open path is at least reported. Then NINE controls, including `VERDICT: _ADDRESSED_`, which is the shape the thirteenth pass's reasoning was protecting and which a `\b` — the fix that reasoning named and correctly rejected — really would have broken. Then AH5's note at 0, 1 and 2 rounds. |
| `u2-the-probe-that-did-not-answer.mjs` | **AH3** — `pi.exec` resolves a child it killed on the timeout with `code: code ?? 0`, so a wedged command reads as a success returning nothing. The rule is stated with a measured table in `git-failure.ts`, whose header says it is "AA2 one package over"; three further `pi.exec` sites in that same package tested `code` first, and two in `stack.ts` | `node --experimental-strip-types u2-…` | pi's `execCommand` pinned out of source first (no `reject` in the promise body; `code ?? 0`), then the three `git` outcomes read both ways — a wedged probe is `"" — SUCCESS` code-first and `GIT_TIMEOUT` through `classifyGitFailure`. Then the **standing scan's own output**: every `pi.exec` verdict in `vendor/pi-subagents-lite/src`, one line each, all five now classified. Comments are stripped before the scan, for the reason `t5` learned. |
| `u3-the-two-spill-directories.mjs` | **AH4** — `result-cap.ts` imports `compaction-guard`'s output-cap CONSTANTS on purpose, and had copied its spill WRITER without the `MAX_SPILL_FILES` prune | `node --experimental-strip-types u3-…` | Drives **both shipped caps** 62 times with a 40,000-character payload and counts the files that really appear on disk: the guard 50/50, `result-cap` 62 BEFORE and 50 NOW. The BEFORE column is produced by writing the files, not by modelling them. Then the control that matters — the prune must drop the OLDEST, because a prune that took the wrong end would satisfy the count and lose the answer the newest marker names — plus a check that the surviving newest file still holds the whole payload. |
| `u4-the-directive-that-was-charged-and-dropped.mjs` | **AH6** — AG2 taught `sendLoopTurn` to defer through the loop's ONE `pendingTimer` slot, and `agent_end` clears that slot at its first line. The `queueOnly` path is taken precisely when a second `agent_end` is guaranteed within milliseconds | `node --experimental-strip-types u4-…` | The shipped loop through `_host.mjs`, with **real timers**, so the five-second wait is the real one. A `LOOP_BLOCKED` turn under a held lock: the ladder charges `blockedSignalCount` and tells the operator "continuing with assumptions", AG2 holds the turn and says so, then the turn that was already coming ends and clears the timer. What the model is eventually sent: `continue` BEFORE, `unblock` NOW. |
| `u5-the-answer-delivered-into-a-compaction.mjs` | **AH1** — `SpawnCoordinator.emitIndividualNudge` is the third sender through `sendCustomMessage`'s `triggerTurn` branch and the last one that did not read the compaction lock — and the only one with no second attempt | `node u5-…` | **Seven** of pi's own facts pinned out of source before anything is driven: the refusal on `prompt()` alone, `sendCustomMessage`'s branch, that `_runAgentPrompt` checks nothing, that `compact()` begins `await this.abort()` (so the session is IDLE and that branch is the ONLY one available), that it ends by replacing `agent.state.messages`, and that `Agent.prompt()` snapshots the message array with `.slice()` — which is why a run started inside a compaction never sees it. Then the **real `SpawnCoordinator`** through pi's jiti, with the lock held by `pi-loop-mode`: nothing sent, one notice naming the holder, still nothing after a second re-ask, and the same answer delivered once the lock frees. |

`u1`–`u4` run under `--experimental-strip-types`; `u5` runs under plain node and
loads pi-importing modules through pi's own bundled `jiti`, as `s2`, `s3`, `s5`,
`t1` and `t2` do. `u4` and `u5` sleep through real five-second waits and take
about six and eleven seconds respectively. All five exit non-zero if an
expectation fails.

**Seventeenth-pass addendum: a fake whose handles cannot be cancelled cannot
fail where the module does.** AH6's regression test passed with the fix removed,
because `pi-loop-mode/tests/turn-into-a-compaction.test.ts` replaced
`globalThis.setTimeout` and not `globalThis.clearTimeout` — and AH6 is *entirely*
about a timer being cleared. The fake now returns identified handles and models
cancellation. That is X1 pointed at the scaffolding rather than at the host: when
you write a fake, list what the code under test DOES to the thing you are faking,
not only what it asks of it.

**And the shape worth copying out of this pass: two of the six fixes are STANDING
SCANS rather than assertions about a case.** `tests/exec-verdicts.test.ts` (AH3)
greps every `.exec(` in `vendor/pi-subagents-lite/src` and fails on any whose
verdict is read from `code` alone; `tests/subagent-denylist.test.ts` has done the
same for self-guarding extensions since the fifth pass. A scan fails on the NEXT
instance rather than on the last one, which is the only kind of test that covers
a rule instead of a bug. Both carry a control assertion that the scan matched
anything at all — **a scan that finds nothing passes**, and that is the one way
this kind of test rots silently.

## The eighteenth pass (AI1–AI5) — `v1`–`v5`

All five defects these were written for are **fixed**. Each probe prints BEFORE
and NOW side by side, so it is its own control: run it and the left column is the
defect, the right column is the tree as it stands.

This pass asked what the stack has already SAID: **quote the sentence — to a
person, to a model, or to the next reader — and then find the path on which it is
not true.** Four of the five findings are a one-slot queue whose promise is
per-person and whose slot is per-session.
`context/design/subagents-loop-verifier-promises.md` is the write-up; **§10.5 is
the promise ledger**, which is what this pass exists to leave behind, and §11 has
the fix and the control-run failing count for each finding.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `v1-the-answer-that-was-still-queued.mjs` | **AI1** — `SpawnCoordinator.dispose()` cleared `pendingNudges` and cancelled the one timer that drains it, so a finished background subagent's answer queued at `session_shutdown` was discarded in silence — while the `session-replaced` drop report, whose own docstring names `session_shutdown`, could only fire for a record that settles AFTER the dispose | `node v1-…` | The real `SpawnCoordinator` through pi's jiti, with `pi-loop-mode` holding the compaction lock so the nudge is HELD (AH1) and still sitting in the batch set. Then the session ends. BEFORE: the id is cleared and nothing is said to the model, the operator or the log. NOW: one notice and one `console.warn` naming the agent. Controls: the sentence does NOT name `/agents` — AG6's rule applied to the one reason it did not exist for, because `events.ts` disposes the manager two statements later — it DOES name the transcript when `outputTranscript` gave the record one, a second dispose reports nothing, and a dispose with an empty queue says nothing at all. The premise is read out of the source first, including that `events.ts` disposes the coordinator BEFORE the manager, which is why the notice can still name the agent. |
| `v2-the-compaction-two-people-asked-for.mjs` | **AI2** — a deferred Matrix `/compact` was parked in one slot, last-write-wins, so every sender but the last was told "I will compact as soon as it finishes" and never heard again; and `stopChannel` dropped the whole request four lines below a loop that denies every pending permission with a stated reason | `for m in two-rooms stopping control; do node v2-… $m; done` | The whole `prinny-channel` extension over the real MCP sidecar protocol. `two-rooms`: two `/compact`s during one turn, both told it will happen — BEFORE one compaction and one room told, NOW one compaction and two rooms told, which was always the right shape. `stopping`: the channel stops with a request waiting; BEFORE nothing at all, NOW one message saying it will not run and to ask again. `control`: one person, one compaction, one reply, unchanged. One process per mode, for the reason `r3` established: `pendingCompaction` and `awaitingReply` are module state and this probe is about what is in them. |
| `v3-the-steer-that-never-reached-a-session.mjs` | **AI3** — `AgentManager.steer()` answers `true` for a steer it queues in `pendingSteers`, under "Queued, so it WILL reach the model — onSessionCreated flushes it", and a run that dies during setup never reaches `onSessionCreated` | `node v3-…` | Two blocks. The first spawns a REAL subagent and samples it one second later: `running`, no session — the window, measured, and the same spawn reached settlement at ~16.5 s. The second drives the real `steer()` (which returns `true`, queues, and grows the brief the JUDGE checks against) and then the real settlement chain on a run that rejects. BEFORE: the queue survives and nothing is said, with "Steer sent to…" standing. NOW: one notice and one log line saying the answer was not written with them. Controls: the count is pluralised, the queue is cleared so a continuation cannot report it twice, and a record whose session DID open reports nothing — which is every ordinary spawn. |
| `v4-the-room-the-tool-guessed.mjs` | **AI4** — `forwardToMatrix` refuses to send with two rooms live because "guessing would send one person's conversation to another"; the `prinny` TOOL is the second route into the same `reply` and filled `room_id` from `lastInbound`, a one-slot last-write-wins variable | `for m in two-rooms one-room explicit; do node v4-… $m; done` | The real extension AND the real registered tool. `two-rooms`: the two `[matrix]` blocks the model is handed carry no room id at all — `renderInboundMessage` drops it deliberately — so the model cannot correct the guess. The call is refused, and then, once the run settles and both rooms retire, the same call falls through to `lastInbound` and the probe PRINTS which room that is: Bob's, for an answer about Alice's question. `one-room` and `explicit` are the two controls the refusal must not break. |
| `v5-the-verdict-the-residue-note-allowed.mjs` | **AI5** — the seventeenth pass fixed two of `stack.ts`'s nine `pi.exec` sites and wrote the other seven down as "script runners whose output is reported verbatim"; five of them choose a verdict from `r.code`, two of those on a 600-second timeout over an operation the same file calls "roughly 20 minutes" | `node v5-…` | pi's `execCommand` **measured** four ways at probe time rather than pinned — timeout, external SIGKILL, real failure, success — then the SHIPPED `execVerdict` driven against a wedged result for each of the six sites, with what each one used to say. Then the standing scan's own output over both roots: fourteen call sites, all classified. Loads `stack.ts` through pi's jiti with a `typebox` alias. |

`v1`, `v3` and `v5` load pi-importing modules through pi's own bundled `jiti`, as
`s2`, `s3`, `s5`, `t1`, `t2` and `u5` do; `v2` and `v4` use `_sidecar.mjs` and run
one process per mode. All five exit non-zero if an expectation fails, and none of
them sleeps for more than about a second and a half.

**Eighteenth-pass addendum, and it is about the scans rather than the probes.**
The seventeenth pass's closing note was *a scan that finds nothing passes*, and
both standing scans carry a control that they matched something. This pass found
the other half by measuring it: **a scan that is no longer ASKED also passes.**
Deleting the second root from `exec-verdicts.test.ts`'s `ROOTS` list took the
suite from 377 tests to 375 with nothing failing at all — no assertion covers a
row that is gone. The roots are now asserted BY NAME as well as by content, which
is the same discipline one level up.

And one about writing a probe, learned twice while writing these five: **guard
every index you read out of a filtered array, or the probe crashes on the first
failure instead of reporting all of them.** `v1` and `v3` both did
`drops[0].includes(…)`, which throws when the control run makes `drops` empty —
so the control reported ONE failure where the fix actually breaks six and seven
respectively. A probe is a measuring instrument, and an instrument that stops at
the first fault under-reports the fault.

## The nineteenth pass (AJ1–AJ5) — `w1`–`w5`

All five defects these were written for are **fixed**. Each probe prints BEFORE
and NOW side by side, so it is its own control.

This pass asked **who is allowed to ask**: name every actor that can reach a
decision, not just the one the guard was written against. There are five — the
OPERATOR at the terminal, the parent MODEL, an allow-listed Matrix SENDER, a
CHILD session in this process, and the MACHINERY itself — and every finding is a
guard that is correct about the actor it names and silent about a different one
that arrives at the same place.
`context/design/subagents-loop-verifier-authority.md` is the write-up; **§10.5 is
the authority ledger**, §10.5.1 draws the five findings by the actor each guard
names, and §11 has the fix and the control-run failing count for each.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `w1-the-order-the-map-draws.mjs` | **AJ5** — §3.1 of three documents said `tool_call` runs "prinny FIRST, then rtk, then subagents"; it runs subagents, prinny, rtk, so the safety property beside it is false. And `browser-guard.ts` registers the FIRST `tool_result` handler in the process and had no column in any table | `node w1-…`, and `node w1-… <any document>` | **A standing scan, not a reproduction**, and the second one whose artefact is prose. It reads the `-e` order out of `scripts/pi-local.sh`, pi's two ordering rules out of pi 0.84.2's own source (`mergePaths(cliEnabled, enabled)` and the sequential awaited `loadExtension` loop, which is why rtk's ASYNC factory keeps position 7), derives the real per-event handler order, and diffs it against a document's ordering section — the fenced block ONLY, because the event-bus table a few lines above has rows that start the same way. This document passes; `…-promises.md` reports `tool_call` backwards, `tool_result` missing `browser`, and five orderings it does not state at all. |
| `w2-the-command-that-was-advertised-read-only.mjs` | **AJ1** — `/stack` is advertised to a Matrix client as "Show local model stack status" and `MATRIX_ALLOWED` had `stack: null`, i.e. the whole command; its own help says "every mutation above is a user-only command on purpose" | `node --experimental-strip-types w2-… matrix` then `… exec` | `matrix`: every subcommand through the real classifier, BEFORE (`run`) beside NOW, with what each one reaches and whether anything gated it — four had no confirmation at all, five had `ctx.ui.confirm`, which is a modal in the OPERATOR's terminal that does not say who asked and answers `false` headless. `exec`: the nine `pi.exec` sites read out of `stack.ts`, the assertion that nothing there emits a `tool_call`, and the two sentences still in the source. Controls: the advertised form still runs, and `/loop` is untouched. |
| `w3-the-shell-command-the-relay-never-sees.mjs` | **AJ2** — the `loop` tool's `check` parameter is run as `pi.exec("bash", ["-lc", …])` once per iteration for the life of the run, and §11.4 of `…-controls.md` left it open because "the caller is already inside the trust boundary" — which names the terminal and silently includes the model | `for m in asked declined headless env terminal; do node --experimental-strip-types w3-… $m; done` | The REAL loop extension and its REAL registered tool. `asked`: the operator is told the model asked, then asked, and a yes arms it. `declined`: not armed, the command never reaches `LoopState`, the loop still starts, until-done survives on the marker, and the MODEL is told in the tool result. `headless`: nobody was asked because there was nobody to ask, and the way to allow it anyway is named. `env`: `LOOP_TOOL_CHECK=1` is the standing yes and skips the question. `terminal`: `/loop start --check` is untouched — the operator is not asked to confirm their own command. One process per mode; the loop's state is module-global. |
| `w4-the-command-that-was-approved-and-the-one-that-ran.mjs` | **AJ3** — the permission relay shows a person the command "as the model wrote it", and `rtk-pi`'s handler runs one position later on the same mutable `event.input` and rewrites it | `for m in approved denied ungated; do node w4-… $m; done` | Both REAL `tool_call` handlers, registered in load order, driven over ONE input object, with a real sidecar stand-in answering the permission request. `approved`: BEFORE the approver read `git status` and pi ran `rtk git status`; NOW what runs is what was approved, and rtk never spent a subprocess on it. `denied`: the call is blocked, with a reason naming the relay, and a blocked call never reaches rtk — which is the half of the launcher's reasoning that was always right. `ungated`: the relay off, nobody asked, nothing stamped, and rtk rewrites exactly as before. It **waits for the sidecar's Matrix login** rather than sleeping on it — see the addendum. |
| `w5-the-fence-the-answer-could-close.mjs` | **AJ4** — `buildJudgePrompt` quotes the child's ANSWER inside a triple-backtick fence and asks its question underneath, so an answer containing a fence continued in INSTRUCTION position above the two lines the judge is meant to obey | `for m in inject code brief; do node --experimental-strip-types w5-… $m; done` | The REAL builder against a reconstruction of the old one. `inject`: BEFORE the ANSWER block holds one line and the prompt carries FOUR bare `VERDICT:`/`WHY:` lines where the builder wrote two; NOW everything the child wrote is still inside the block and exactly two instruction lines remain, both the builder's own. Both prompts are printed in full from `ANSWER:` down. `code` is the control that decides whether the fix is worth having — an ordinary answer with a fenced code block survives byte for byte. `brief` covers the TASK block and the REPAIR prompt, which goes into the child's own session, which has tools. |

`w2`, `w3` and `w5` import modules with no runtime pi imports, so plain node with
`--experimental-strip-types` is enough; `w1` reads sources and pi's dist as text;
`w4` loads both extensions through pi's own bundled `jiti` and starts
`_sidecar.mjs`.

**`_sidecar.mjs` gained one thing this pass, additively**: it answers
`notifications/claude/channel/permission_request`, recording the exact
description a person would have been shown to the outbox and replying with
`PROBE_PERMISSION` (`allow` by default, `deny`, or `ignore` to let it time out).
Nothing that did not send one behaves differently, so `v2` and `v4` are unchanged.

**Nineteenth-pass addendum, and it is about waiting.** `w4` was flaky one run in
three with a fixed `await sleep(1500)` after `session_start`. The reason is worth
keeping: `requestApproval` **fails closed** — "the approver was unreachable is not
the same as the approver said yes" — so a probe that starts asking before the
sidecar has reported its Matrix login measures the relay's own timeout and
reports a DENY the code under test had nothing to do with. It now polls the
notices for `connected as` with a 30-second ceiling and asserts it saw one.
**An instrument that does not wait for its own preconditions reports a failure
that belongs to the instrument**, and on a fail-closed path that failure looks
exactly like the behaviour you are trying to measure.

And one about the other kind of instrument. `t5` — the standing scan that keeps
the event-bus table honest, written for AG4 because five documents drew the bus
wrong — passed for four passes while the table was missing a package, because its
`PACKAGES` list was **the map's own list**. It now derives seven columns rather
than five and fails when a package that registers something has no column at all.
**When you write a scan to keep a document honest, seed it from the thing the
document is ABOUT, not from the document.** `w1` reads
`scripts/pi-local.sh`; that is the whole difference between the two.

## The twentieth pass (AK1–AK5) — `x1`–`x6`

All five defects these were written for are **fixed**. Each probe prints BEFORE
and NOW side by side, so it is its own control.

This pass asked **what the test is a proxy for**: take a predicate, write down
the PROPERTY it is named for and the TEST it actually runs, and enumerate the
set where the two differ. Every finding is a predicate that is right about the
case in front of it and wrong about a set.
`context/design/subagents-loop-verifier-proxies.md` is the write-up; **§10.5 is
the proxy ledger**, §10.5.1 draws the five by the DISTANCE between the two
halves, §10.5.2 names the three shapes a proxy fails in, and §11 has the fix and
the control-run failing count for each.

`x2` is the odd one out: it is not a reproduction and not a scan but a
**measurement taken before the code it justifies was written** — the nineteenth
pass's handoff asked for exactly that, in those words, and §5.7 of the write-up
is what was built on the answer.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `x1-the-guideline-that-was-not-there-yet.mjs` | **AK1** — `registerTools` ran behind `if (isConfigured())` at FACTORY time, and `/prinny configure` writes the credentials and starts the channel in the same session. `promptGuidelines` come only from registered tools, and one of this tool's two is the only sentence in the stack that says a `[matrix]` marker is untrusted input | `node x1-…` | The REAL extension, through pi's own jiti with a stub `pi`. Unconfigured: no tool, BEFORE and NOW alike — the control that an unconfigured session still pays nothing for six tool schemas. Then the credentials are written, `session_start` fires, and the tool arrives with both guidelines printed in full. It then calls the real `renderInboundMessage` to show that the marker named in the guideline is the marker on the wire, and fires `session_start` twice to show the gate is idempotent. |
| `x2-the-entry-the-model-never-sees.mjs` | §5.7 — the transcript | `node --experimental-strip-types x2-…` | pi 0.84.2's own `SessionManager`: a real session file, three `subagent-turn` entries between the operator's own turns, two compactions, then the file re-opened from disk with nothing in memory. Reports three things separately — what the model is SENT (`buildSessionContext`), what the transcript HOLDS (`getEntries`), and what survived on DISK (the JSONL, re-parsed). The interesting failure is the first being non-empty: that would mean every delegation's reasoning is charged to the parent's window. |
| `x3-the-spelling-the-guard-knew.mjs` | **AK2** — `DANGEROUS_PATTERNS` tested one spelling of `rm -rf`, in a mode whose help promises "and similar" | `node --experimental-strip-types x3-…` | The shipped regex list, reconstructed verbatim, run beside the real module over 34 commands in four groups, every row printing BEFORE and NOW: the seven spellings of one `rm` (five of which passed), the same shape at `git clean`/`git reset`/`chmod`, the control that nothing the old list caught was let go, and the control that ten ordinary commands still gate nothing. Ends by printing the `reason` an approver would read, because the fix must not change the sentence. |
| `x4-the-request-read-as-a-reply.mjs` | **AK3** — `dispatch` branched on `id` before `method`, so a server-initiated request resolved the client's own outstanding call with `undefined` | `node --experimental-strip-types x4-…` | The real `McpChild` against a real child process, in BOTH branch orders — the probe writes a copy of the module with the two blocks swapped and imports it, so BEFORE is a measurement rather than a reconstruction. BEFORE: *the call RESOLVED after 0ms with `{"content":[]}`*, and the server's request was never answered. NOW: it times out, and the request gets the `-32601` the file always meant to send. Uses a new `serverrequest` mode in `tests/fixtures/fake-sidecar.mjs`, which echoes whatever the client replies to stderr. |
| `x5-the-approval-nobody-was-waiting-for.mjs` | **AK4** — `requestApproval` fails closed on a timeout and tells the sidecar nothing, so the Allow button stayed live forever and pressing it wrote `✅ Allowed` into the room for a call that had already been blocked | `node x5-…` | A plain `Map` beside the real `PermissionRegistry` over the same sequence: the press an hour later (BEFORE it still had the prompt; NOW it does not, and prints the sentence the room is given instead), the exact expiry boundary at 299 999 / 300 000 / 300 001 ms, and a day of an unattended run — 24 prompts held versus 1, with the bytes of `input_preview` each was holding. |
| `x6-the-word-that-counted-as-progress.mjs` | **AK5** — `hasStateChange` is named for a change to the project and tested a word list, including `passed`, over the output of ANY tool. The audit rung reads what it writes, and could not fire on a `--check "cargo test"` run | `for m in cargo jest changelog grep control-edit control-bash; do node --experimental-strip-types x6-… $m; done` | The REAL loop module, eight iterations per mode, with the shipped predicate reconstructed for the BEFORE line. Four modes where the audit rung must now fire (`cargo`, `jest`, `changelog`, `grep`) and two controls where it must not (`control-edit`, `control-bash`). The tool output differs per turn on purpose — three identical results in a row are the stuck ladder's rule 7, which would fire first and make every case pass for the wrong reason. |

`x1`, `x2` and `x5` load real modules with no runtime pi imports (or pi's dist
directly); `x3`, `x4` and `x6` need `--experimental-strip-types`; `x1` loads
`prinny-channel/extensions/index.ts` through pi's own bundled `jiti` with the
same alias map `w4` uses.

**Twentieth-pass addendum, and it is about what a probe is allowed to assume.**
`x6`'s first draft used the same tool output every turn and every case passed —
for the wrong reason. Three identical tool results in a row are `detectStuck`'s
rule 7, which fires several rungs above the audit rung, so the probe was
measuring the stuck ladder and reporting it as the audit ladder. **A probe that
drives a real ladder has to get PAST every rung above the one it is about**, and
the way to know it did is to print the sentence the loop actually said rather
than to assert a boolean. `x6` prints it; that is the only reason the mistake
was visible.

And one about the other direction. `x4` reverts the fix by rewriting the module
into a temp file and importing both copies in one process. That is worth more
than a reconstruction of the old behaviour, because a reconstruction is a claim
about what the old code did and a re-import is the old code. The cost is one
brittle string match on the source; when it stops finding the two branches it
throws with *"has dispatch moved?"* rather than silently measuring one order
twice.

## The twenty-first pass (AL1–AL9) — `y1`–`y9`

All nine defects these were written for are **fixed**. Each prints BEFORE and
NOW, so running one is its own control. The write-up is
`context/design/subagents-loop-verifier-lifetimes.md`: **§10.5 is the lifetime
ledger** — every construct in the stack with a beginning and an end, the one
place that ends it, and the count of ways the work can finish — §10.5.1 draws the
nine by DISTANCE (seven of nine are distance zero, and in five of those the
correct version of the same construct is on screen at the same time as the
defective one), §10.5.2 names the four shapes a lifetime fails in, and §11 has
the fix and the control-run failing count for each.

The axis: **for every construct with a beginning and an end, name the ONE place
that ends it, then enumerate the paths that reach the end of the WORK without
reaching the end of the THING.**

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `y1-the-follow-up-that-replayed-the-run-before-it.mjs` | **AL1** — a continuation's transcript subscribed at message 1 of a session that already held a settled run, and `MAX_LINES` then dropped the answer the follow-up was about | `for m in followup first compaction; do node --experimental-strip-types y1-… $m; done` | The real `streamAgentOutput` and the real `AgentTranscript` over a 142-message session, at both anchors, printing the entry the operator reads. BEFORE it opens with `step 0:` of the settled run and drops 92 lines; NOW it holds the follow-up's answer and drops none. `first` and `compaction` are the two controls the fix must not move: the FIRST attach still skips the prompt it already wrote, and the compaction re-anchor still resets to 1 because pi rebuilds the array. |
| `y2-the-rescue-turn-that-never-ended.mjs` | **AL2** — `interveneStuck` switches the whole SESSION's model for a "rescue turn", and rung 7 of an eighteen-rung `agent_end` ladder was the only stand-down | `for m in rung3 rung3-ten rung5 rung1 stop end control; do node --experimental-strip-types y2-… $m; done` | The REAL loop module, driven with four turns of fixated output to a genuine rescue turn — and it asserts it arrived before testing anything, which is x6's lesson. Then it ends that turn each of seven ways and prints the sentence the loop actually said next to the model the session was left on. `rung3` is the shape that costs most: an unloaded rescue model answers with an empty turn, and the provider-error rung answers an empty turn by retrying — ten times, BEFORE on the model that could not answer. `control` is rung 7, the path that always worked. |
| `y3-the-client-every-failed-attempt-built.mjs` | **AL3** — the sidecar's connect loop retries forever and built a Matrix client per attempt, on one Olm crypto store, with no path anywhere that stopped one | `for m in outage recovered shutdown; do node --experimental-strip-types y3-… $m; done` | The real `connectWithRetry` against a fake client that records whether anybody stopped it, with the shipped loop reconstructed for the BEFORE column. `outage`: a hundred failures leave a hundred unreachable clients BEFORE and none NOW. `recovered` is the control — the retry does its job in both columns, and the published client is never the one stopped. `shutdown` covers the client of the attempt that was in flight when pi quit, which the old `if (shuttingDown) return` abandoned. |
| `y4-the-sweep-that-could-not-stop.mjs` | **AL4** — the delivery sweep armed on "a message arrived" and disarmed on a strictly weaker question, so one reported message armed a 30 s interval for the rest of the session | `for m in undelivered command answered; do node --experimental-strip-types y4-… $m; done` | An hour of 30 s ticks through the real `undeliveredRooms`, with the shipped disarm test beside the new one. The verdict is identical in both columns — the report still happens, once — and the difference is 120 sweeps versus 2. `command` is the cheaper reproduction that needs no failure at all: a Matrix `/loop status` arms it and is `answered`, which is `live: false` forever. `answered` is the mode where the shipped disarm worked, which is exactly why the defect was invisible. |
| `y5-the-eighty-millisecond-poll-nobody-stopped.mjs` | **AL5** — `ensureTimer` armed an 80 ms poll on the first delegation, `update()` returned instead of stopping, and each tick sorted every record the manager had ever held | `node y5-… idle` / `active` / `continuation` | The real `AgentWidget` over the real `AgentManager` with fifty aged-out records. `idle`: armed by the spawn, stopped by `update()`. `active` is the control — a running delegation keeps it armed. `continuation` is the half of the fix that is not a `stopTimer`: `AgentManager.onStart` had **no setter and was constructed with `undefined`**, so the hook `startAgent` has always called was wired to nothing; this mode shows it firing and the poll coming back. Needs pi's bundled `jiti` (the widget imports `@earendil-works/pi-tui`). |
| `y6-the-indicator-a-stopped-channel-left-up.mjs` | **AL6** — `stopChannel` cleared the delivery interval and not the typing one, so nobody was ever sent `typing: false` and every room kept the indicator up for Matrix's own 20 s timeout | `node --experimental-strip-types y6-…` | Two halves, and it says which is which. The plan is EXECUTED through the real `src/typing.ts` — three rooms, BEFORE told nothing, NOW told to stop. The ordering is READ out of `extensions/index.ts`, because that file imports pi and typebox: it prints `stopChannel`'s six steps in source order and asserts the clear happens while `child` is still non-null, since `stopTyping`'s whole body is outbound calls. |
| `y7-the-unregister-that-was-never-called.mjs` | **AL7** — the terminal-input unregister was captured, guarded on, and never called; the reason nothing broke belongs to pi | `node --experimental-strip-types y7-…` | Mostly a MEASUREMENT rather than a reproduction, and deliberately: it walks pi's own dist and prints the chain — `teardownCurrent` → `beforeSessionInvalidate` → `resetExtensionUI` → `clearExtensionTerminalInputListeners`, with the line number of each — to establish that pi drops the subscription on every `/new`, `/resume`, `/fork`, import and quit. Then the extension's end of it. The finding is that this was a dependency on somebody else's teardown with nothing saying so. |
| `y8-the-footer-that-outlived-the-loop.mjs` | **AL8** — `setStatus("loop", …)` appears thirty times and `setStatus("loop", undefined)` appeared none, so `/loop end` deleted the loop and left its pill in the footer | `for m in end clear stop finish; do node --experimental-strip-types y8-… $m; done` | The REAL loop module through a run and each way of ending one, printing the footer and `/loop status` **side by side**. After `/loop end` the footer said *"Loop ended"* while status said `Active: false · Goal: -` — the two disagreeing is the finding, and the footer is the one nobody has to ask. `stop` and `finish` are the controls for the twenty-nine pills that stay, because those loops still exist and are resumable. |
| `y9-the-spill-directory-per-process.mjs` | **AL9** — the spill bound is fifty files per DIRECTORY and the directory is one per PROCESS, so nothing bounded the directories | `for m in week live legacy; do node --experimental-strip-types y9-… $m; done` | Thirty finished sessions' directories, at the file bound, in a temporary root, then the real sweep. Measured on this box before the fix: **247 directories, 230 MB, over four days**, from two prefixes. `live` is the whole risk of a sweep — a `/loop` running for days shares `/tmp` with whatever starts next and its markers still name those files — and its directory survives intact. `legacy` covers the 247 untagged ones: no evidence either way, so they are left. |

`y5` needs pi's bundled `jiti`; the rest run under plain
`node --experimental-strip-types`.

**Twenty-first-pass addendum, and it is about a probe that could not reach the
rung it named.** `_host.mjs`'s `turn()` built every assistant message with
`stopReason: "stop"`. `agent_end`'s ladder has a rung for an ABORTED turn — rung
5, the operator pressing Esc — and a helper that can only build `"stop"` cannot
reach it. `y2`'s `rung5` mode therefore drove rung 7 while printing "rung5" as
its label, and passed. `stopReason` is a parameter now, defaulting to `"stop"` so
every existing probe is byte-identical.

That is the twentieth pass's own axis one layer out: **the label is a claim about
which code ran, and the only thing that checks it is printing the sentence the
module actually produced.** `y2` prints it, which is the only reason the mistake
was visible — the same reason `x6` printed it a pass earlier.

And one about what a teardown in a probe or a test is allowed to compute. The
first draft of `spill-dirs.test.ts` derived a cleanup path with
`file.split(PREFIX)[0]`, got `/tmp`, and handed it to a recursive `rmSync` in
`after()`. **It deleted `/tmp`.** The rule that came out of it is the same one
the module under test follows: a teardown that takes a path from a computation
has to prove the path is its own — under `tmpdir()`, one segment, with a known
prefix — immediately above the destructive call, not merely where the path was
queued. `y9` and that suite both do it twice, once at queue time and once at
delete time.

## The twenty-second pass (AM1–AM6) — `z1`–`z5`

All six defects these were written for are **fixed**. Each prints BEFORE and NOW,
so running one is its own control. The write-up is
`context/design/subagents-loop-verifier-concurrency.md`: **§10.2 is the
interleaving ledger** — every `await` in the stack a handler, a settlement chain
or a callback can be suspended at, with how long it can suspend for and what
re-reads the world afterwards — §10.2.1 draws the six by DISTANCE, and §11 has the
fix and the control-run failing count for each.

The axis: **for every `await` inside a handler, a settlement chain or a callback,
name what ELSE can run at that point — and then name what the code assumes has
not changed by the time it resumes.**

Three questions per await, and the first is what separates a finding from a
hazard: **how long can this suspend?** Four of the six are about an await measured
in seconds to minutes — a 120 s MCP handshake, a 120 s goal check, a 300 s
verification deadline, a summariser call on a 27B — and the fifth is about a
callback pi holds across a session teardown, which has no bound at all.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `z1-the-stop-that-could-not-see-the-start.mjs` | **AM1** — `stopChannel` read `child`, which is null for the whole of a start's handshake, so a stop that landed in that window did nothing and the sidecar it could not see published itself afterwards | `for m in stop restart clean fail; do node --experimental-strip-types z1-… $m; done` | The real `ChannelLifecycle` with a fake sidecar that records whether it was stopped and whether it went on to log into Matrix. The window is 27.5 s of matrix-js-sdk import with a 120 s budget, not microseconds. `stop`: BEFORE the stopped channel came up anyway and logged in. `restart` is the one worth reading — BEFORE the stop did nothing AND the start was handed the first start's promise, so `/prinny restart` reported that one's outcome as its own; NOW two sidecars are built and only the second holds the Olm store. `clean` and `fail` are the controls. |
| `z2-the-compaction-the-lock-could-not-see.mjs` | **AM2** — three senders ask "is somebody compacting this session right now?" and all three could only see the two EXTENSIONS that compact; the third compactor is pi | `for m in parent child extension release; do node --experimental-strip-types z2-… $m; done` | The real `compaction-guard`, read through the real `pi-subagents-lite`, `pi-loop-mode` and `prinny-channel` copies — i.e. through the three actual readers, not the writer's view of itself. `parent` prints what each sender would decide: BEFORE all three would have sent into it, NOW all three defer. `child` is the control that had to be got right — the lock is process-global and the question is per-session, so a subagent's compaction takes nothing and a child's turn ending does not release the parent's. `extension` shows the guard leaving `pi-loop-mode`'s own hold alone. `release` walks all four rungs, because `session_compact` fires only on the success path. |
| `z3-the-teardown-that-ended-the-verifier-s-session.mjs` | **AM3** — `AgentManager.dispose()` disposed `execution.session`, which is the session a REPAIR runs in, and left the verifier running with a handle to it | `for m in order answer clear; do node --experimental-strip-types z3-… $m; done` | `order` prints what each teardown ends and in what sequence. `answer` is the one to read: it drives the real `verifyAnswer` for both orders and prints **the sentence the parent model receives**. BEFORE — *"this answer was checked against the task and did not address it … Treat it as unreliable"*, about a child that was right. NOW — *"the check did not complete, so this answer went out unchecked"*. A disposed `AgentSession` still accepts `prompt()`; it is simply no longer subscribed to its agent, so the repair spends a model call and returns `""`, which the structural gate reads as a failure. |
| `z4-the-callback-that-outlived-its-session.mjs` | **AM4** — `runToken` is bumped by every LOOP transition and by neither SESSION transition, and a `ctx.compact()` callback is the one continuation that survives a swap | `for m in swap shutdown live; do node --experimental-strip-types z4-… $m; done` | The real loop extension through a real context-pressure cycle, holding the callbacks pi holds and firing them after a swap. Its BEFORE column is the real module loaded from a copy with the two `runToken++` lines patched out, so both columns are the shipped code. The swap is what MAKES the callback fire — `AgentSession.dispose()` calls `abortCompaction()` and pi throws "Compaction cancelled", which is not benign — and BEFORE it charged the newly restored run's cooldown ladder and then **threw out of a callback pi invokes from a `void`ed async IIFE**. The probe has to catch that to be able to print anything. `live` is the control. |
| `z5-the-nudge-gate-dispose-cleared.mjs` | **AM5** — `dispose()` cleared the one-shot that says a background delegation's answer is owed, one statement before the settlements that needed it; **AM6** — one nudge timer served two deadlines and the first to arrive decided for both | `for m in gate deadlines oneshot; do node --experimental-strip-types z5-… $m; done` | `gate`: the coordinator retires before the manager ends the runs, so BEFORE two finished delegations' answers were dropped with nothing said — which is what AI1's `session-replaced` guard was written for and could not reach. `deadlines` prints the arithmetic: a delegation that settles 100 ms into somebody else's 5 s compaction hold waited 4,900 ms BEFORE and 200 ms NOW, 24.5× less, and the other direction is deliberately unchanged. `oneshot` is the control — it is still a one-shot, and a foreground record's first settlement still owes nothing. |

All five run under plain `node --experimental-strip-types`.

**Twenty-second-pass addendum, on what a BEFORE column is allowed to be.** `z4`
does what `x4` did: it writes a copy of the real module with the fix patched out
and imports both in one process, so the BEFORE column is the old code rather than
a reconstruction of it. `z1`, `z3` and `z5` cannot — their fixes are new modules,
so there is no old module to import — and each therefore reproduces the old rule
in a named function next to the new one (`teardownBefore`, `retireBefore`, and
z1's `disown` flag) rather than inline, so a reader can see the two rules side by
side and check that the BEFORE one is what shipped.

And one about a probe that would have been a re-implementation. The first draft of
`z1`'s BEFORE column awaited the in-flight start before restarting, which is what
the FIXED code does — so it built two sidecars in both columns and the "restart
did nothing" assertion failed. The shipped behaviour is that the stop returns
*immediately* and the restart runs *while the first start is still handshaking*,
and the probe only reproduced it once the fake sidecar's `stop()` was made to fail
the pending handshake the way `McpChild.stop()`'s `failPending` does. **A BEFORE
column that awaits something the old code did not await is measuring the fix.**

## The twenty-third pass (AN1–AN7) — `aa1`–`aa7`

All seven defects these were written for are **fixed**. Each prints BEFORE and
NOW, so running one is its own control. The write-up is
`context/design/subagents-loop-verifier-round-trips.md`: **§10.2 is the
round-trip ledger** — thirty-eight rows, every value this stack puts outside its
own heap, with which of five gaps it crosses and what the reader does when the
bytes are not what the writer meant — §10.2.1 draws the seven by DISTANCE, and
§11 has the fix and the control-run failing count for each.

The axis: **for every value this stack writes outside its own heap, name the
writer, the reader, and what the reader does when the bytes are absent,
malformed, stale, or from a different world than the writer's.**

The question that separates a nuisance from a finding is the third one: **what
does the caller do with the default the `catch` just returned?** A misread config
that falls back to defaults is a nuisance. A misread config that falls back to
defaults *and is then written back* is the destruction of the only copy, and that
is two of the seven.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `aa1-the-config-the-reader-could-not-parse.mjs` | **AN1** — one `catch` returning `{}` for both "there is no file" and "there is a file and nobody could read it", in two packages, where the next write REPLACES the file | `for m in subagents prinny absent; do node --experimental-strip-types aa1-… $m; done` | `subagents` drives the REAL `ConfigStore` against a temp agent dir, one process per column (`config-io.ts` resolves `CONFIG_PATH` at module load and jiti caches it — two columns in one process both read the first column's directory, which is how the first draft managed to show the fix failing). BEFORE: a 277-byte config with one comma missing loads as nothing, and one widget toggle leaves `{ "agent": { "showCompletionCards": false } }` on disk. NOW: the bytes are kept as `.corrupt-<time>`, unchanged, and the toggle still saves. `prinny` is the second instance and the one with teeth — both columns read `permissionMode` as `off` when the file says `all`, and only NOW keeps the file. `absent` is the control: a fresh install is not a corrupt one, and nothing is quarantined. |
| `aa2-the-runtime-three-readers-called-built.mjs` | **AN2** — the staged sidecar runtime is keyed on a content fingerprint, and three readers plus the launch script asked `existsSync(dist/server.js)` instead | `for m in staged live absent; do node aa2-… $m; done` | `live` is the finding rather than an illustration of it: it runs both questions against THIS BOX's runtime directory and prints the stamp (`f297f2b6…`), the source's fingerprint (`53371dab…`), the verdicts (`built` / `stale`) and **the files in the checkout the staged tree has never seen** — `connect.ts`, which is AL3's fix for a connect loop that builds one matrix-js-sdk client per failed attempt. `staged` builds a fixture, stages it, adds one source file and shows the two answers diverge. `absent` is the control, and it is the one state the weaker question got right. |
| `aa3-the-device-id-a-new-token-inherited.mjs` | **AN3** — `/prinny configure token` wrote the token and left `PRINNY_DEVICE_ID` behind, and `resolveDeviceId` reads the stored one first | `for m in rotate first switch; do node --experimental-strip-types aa3-… $m; done` | The real `credentialUpdatesForToken`, with `updateEnv`'s merge and `resolveDeviceId`'s precedence quoted from source (both pinned by `tests/token-device-id.test.ts`, so the probe and the code cannot drift). `rotate` is the case: BEFORE the new token keeps `OLDDEVICE` and the whoami lookup — which is also where a token belonging to another account is caught — never runs. `first` is the control (no stored device, both columns ask). `switch` is where the fix came from: the three-argument arm has always cleared both. |
| `aa4-the-switches-the-launcher-never-forwarded.mjs` | **AN4** — `scripts/pi-local.sh` forwarded four of the seven `SUBAGENT_*` variables the package reads, and two of the three it missed are documented as the way to turn a feature off | `node --experimental-strip-types aa4-… table` then `… effect` | `table` scans the real sources and the real launcher and prints all seven with a ✔ or ✘ per column; the BEFORE column is the same launcher with this pass's three lines filtered out, so both columns are the shipped file. `effect` drives the real modules to print what each switch turns off and what it costs when it cannot be reached: up to 60 session entries of 4,000 characters per delegation, and one JSONL line per verifier model call. |
| `aa5-the-state-written-thirty-three-times.mjs` | **AN5** — `persistState` appends a ~6.6 KB entry from thirty-three places and `restoreLoopState` reads exactly one back | `for m in live session swap; do node --experimental-strip-types aa5-… $m; done` | `session` is the measurement the finding came from: every session file under `~/.pi/agent/sessions`, how many loop-state entries each carries, what share of the file they are, and how many are byte-identical to the entry before them (59 / 41.3% / 24 on the largest). `live` drives the real extension — BEFORE from a copy with the memo patched out — and three `/loop end`s write three entries or one. `swap` has a **third** column, the memo kept and its reset removed, which prints `the NEW session wrote: 0` — the trap the two reset lines exist for. |
| `aa6-the-warnings-a-failed-spawn-threw-away.mjs` | **AN6** — the setup-warning buffer was flushed after the `await` with no `finally`, and on a channel that does not exist headless | `for m in abort headless clean; do node --experimental-strip-types aa6-… $m; done` | The real `NoticeBuffer` in the real shape of `runAgentImpl`'s try/finally, against the six lines it replaced. `abort` is the case: a run that throws said **nothing at all** BEFORE, and every warning lands NOW without swallowing the throw. `headless` is the other half — pi's `noOpUIContext.notify` is a real `() => {}`, so the `else console.warn` arm was unreachable and an unattended run heard nothing. `clean` is the control: a successful run in a TUI reported them before and still does. |
| `aa7-the-settings-path-that-ignored-the-override.mjs` | **AN7** — `pi-settings.ts` read `~/.pi/agent/settings.json` with a hardcoded join, ignoring `PI_CODING_AGENT_DIR` | `for m in relocated default live; do node --experimental-strip-types aa7-… $m; done` | `relocated` writes a settings file where pi would actually put it and prints what each reader answers: BEFORE `hideThinkingBlock: false` against a file that says `true`, NOW `true`. `verify-log.ts` is the control in every mode — it has always honoured the variable, which is what made the two readers' disagreement the finding rather than the value. `default` is why this went twenty-two passes unnoticed: with the override unset, both answers are the same string. |

All seven run under plain node; `aa1 subagents` and `aa5 live`/`swap` need
`--experimental-strip-types` because they load `.ts` modules directly, and
`aa1 subagents` additionally uses pi's own jiti to reach `ConfigStore`.

**Twenty-third-pass addendum, on measuring the box rather than a fixture.**
Three of these read real state: `aa2 live` reads the staged runtime,
`aa5 session` reads every session file, `aa7 live` reads the current
environment. Each is a probe whose output changes when the box changes, which is
the point — `aa2 live` is how AN2 was found, and it will say `current` again the
moment somebody runs `/prinny prepare`. When it does, that is not the probe
breaking; it is the probe reporting.

And one on a BEFORE column that could not be the old module. `aa1`'s BEFORE is a
hand-written `ConfigIO` — the eight lines the fix replaced, quoted in the probe's
header — driving the REAL `ConfigStore`. That is defensible only because
`ConfigIO` is an injectable port and the STORE is what does the damage: the
merge, the defaults, the mutation and the save are all shipped code, and only the
read and the write are the old ones. Where a fix is a new module with no
predecessor (`json-store.ts`, `runtime-stamp.mjs`, `notice-buffer.ts`), the
BEFORE column is the old EXPRESSION next to the new one, named and quoted, so a
reader can check that what is being called BEFORE is what actually shipped.

## The twenty-fourth pass (AO1–AO9) — `ab1`–`ab9`

All seven defects these were written for are **fixed**. Each prints BEFORE and
NOW, so running one is its own control. The write-up is
`context/design/subagents-loop-verifier-identity.md`: **§10.2 is the identity
ledger** — fifty-three rows, every place this stack decides two values are the
same, with the two values, the function that decides and who supplied each side —
§10.2.1 sorts them by **who minted the value**, and §11 has the fix and the
control-run failing count for each.

The axis: **for every place this stack decides two values are the same — a key
lookup, a set membership, a string compare, a path, a name, an id — name the two
values, name the function that decides, and find the pair that is
equal-but-different or different-but-equal.**

The question that separates a nuisance from a finding is **who supplied each
side**. A comparison whose two sides were both minted by this process is nearly
always right — twelve of the thirteen such rows in the ledger are — and every
finding is at a boundary: a person's keyboard, a model's reply, another
homeserver's clock, another build of ourselves.

| Probe | Finding | Run with | What it shows |
| --- | --- | --- | --- |
| `ab1-the-id-the-model-was-shown.mjs` | **AO1** — an agent id is 17 characters, eleven surfaces publish the first 8 and four of those are read by the model, and `StopAgent` resolved it with an exact `Map.get` | `for m in published ambiguous full; do node --experimental-strip-types ab1-… $m; done` | `published` is the finding in one number: 200 freshly minted ids, asked with the form that was printed — **BEFORE 0/200, NOW 200/200**, and to the *right* record rather than merely to one. It also prints the refusal verbatim (`"Agent a0c4f005 not found. Running agents: 47a76eed (explore), 7c3385c6 (general-purpose)"` — three ids in one sentence, none of which the next call would have accepted). `ambiguous` shows the ladder refusing to pick and naming both candidates at a length that tells them apart. `full` is the control and the reason this survived twenty-three passes: the one path that carried the whole id — `run_in_background`'s `Agent ID: <id>` — always worked. |
| `ab2-the-tool-the-gate-never-recognised.mjs` | **AO2** — `permissionTools`, the one branch of `needsApproval` that fires in *every* mode including `off`, matched case-sensitively against a list stored unvalidated | `for m in off all store; do node --experimental-strip-types ab2-… $m; done` | Both columns run the **shipped** `needsApproval`; they differ in one operator, `.includes` against `namesTool`. Tool names are read off the sources rather than remembered (pi's built-ins are lower, this repo's are not). `off` is the case with teeth — the mode is `off`, so the named tool is the *only* gate in force, and `Bash` gated nothing. `store` shows `parseSetting` de-duplicating `bash, Bash` to one entry while keeping the operator's own spelling. Every mode also checks that folding widens the case, not the set: a name that is not a registered tool still matches nothing. |
| `ab3-two-rooms-one-sentence.mjs` | **AO3** — `markLive` matches on the whole rendered string, and `renderInboundMessage` drops the room, the event and (in a DM) the sender | `for m in collision distinct silenced; do node --experimental-strip-types ab3-… $m; done` | `collision` is the mechanism: two DMs saying `hi` render as **one** string BEFORE (`distinct injected texts: 1 of 2`) and two NOW (`[matrix] hi` / `[matrix from=bob] hi`). `silenced` is the cost, and it is the mode to read — BEFORE, one echo marks *both* rooms live, `forwardToMatrix` refuses at two, **Bob asked and was taken and gets no answer while Alice is told somebody else was being answered**; NOW exactly the room pi consumed is live. `distinct` is the control: two rooms whose words differ cost nothing extra, before or after. `markLive` and `liveRooms` are eight lines between them and are reproduced verbatim and marked, because `extensions/index.ts` imports pi and cannot be loaded here. |
| `ab4-the-instant-that-stood-for-the-message.mjs` | **AO4** — the outbox watermark answered "have I delivered this?" with "is this from an instant I have passed?" | `for m in skew twin ancient redelivery; do node --experimental-strip-types ab4-… $m; done` | Both columns run the **staged sidecar's** `queue.js` against a real temporary state directory, so the queue file, the watermark file and the ageing rule are the shipped ones; the BEFORE column is `message.ts <= watermark.ts` against the same watermark. `skew` is the case — a message *nobody had ever seen*, stamped 1 s below the mark by another homeserver's clock, dropped BEFORE and queued NOW (and checked in the queue *file*, not merely accepted). `twin` is two events in one millisecond. `ancient` is the control that matters most: a genuinely old message is still refused, so the catch-up bound is intact. `redelivery` shows the same id refused twice. |
| `ab5-the-program-the-suite-was-testing.mjs` | **AO5** — `loadServerModule` imports the staged *compiled* sidecar, and nothing asked whether the stage was this checkout | `for m in live stale absent; do node --experimental-strip-types ab5-… $m; done` | `live` is a **reading of this box**, not a reconstruction: it prints `.source-stamp`, the fingerprint of `server/src`, `stagedState()`'s verdict and the contents of `dist/`. When the finding was written it said `stale`, stamp `f297f2b6…` against source `94b4a2f9…`, **no `connect.js` at all**, and the suite was green — 511 tests about a program not in the tree. It now says `current`, and `connect.js` is staged, so AL3's fix is compiled in for the first time. `stale` and `absent` build fixtures and check the harness refuses with a sentence naming `--prepare`, and with a *different* sentence for each. |
| `ab6-the-key-nobody-stored.mjs` | **AO6** — four lookups over `JSON.parse` output that answer for eight names nobody stored | `for m in pair rooms control; do node --experimental-strip-types ab6-… $m; done` | `pair` is the one with an effect: `/prinny pair constructor` replied **"paired undefined. They can now reach this session."** and left `["@real:example.org", null]` in the allowlist; NOW it refuses and the allowlist is untouched. It also runs `deny` and `removeRoom` over all eight inherited names — **BEFORE 8/8 reported success, NOW 0/8**. `rooms` is the gate whose docstring names prompt injection as the actor it exists for: ALLOW for all eight BEFORE, and the room that really is enabled still passes NOW. `control` is `hasEntry` answering the question that was meant. Not exploitable — none of the eight is a room ID and the homeserver rejects them — which is why the probe says so rather than implying otherwise. |
| `ab7-the-directory-two-packages-disagreed-about.mjs` | **AO7** — `skill-loader.ts` hardcoded the agent directory (the third instance of AN7), and four readers in `prinny-channel` did not expand `~` | `for m in skills tilde agree live; do node --experimental-strip-types ab7-… $m; done` | `skills` is the half that decides what a SUBAGENT gets: on a relocated install the parent reads `$PI_CODING_AGENT_DIR/skills` and every child read a directory pi does not use — **and with the override unset the two agree, which is why it went unnoticed**. `tilde` is the other half: `PI_CODING_AGENT_DIR=~/pi-work` put the allowlist, the credentials and the Olm store in a directory literally named `~`, relative to the cwd; and a tilde that is not a home reference (`/tmp/~backup`) is still left alone. `agree` drives **both packages' copies** over six values and asserts one answer each. `live` prints what the two answer on this box. |

| `ab8-the-worktree-that-was-its-own-repo.mjs` | **AO8** — `sameRepo` compared a realpath'd target against a parent cwd that was not, and `git rev-parse --git-common-dir` answers RELATIVE in a main worktree and ABSOLUTE in a linked one | `for m in shapes logical physical foreign; do node --experimental-strip-types ab8-… $m; done` | The fixture is **real git** — a repository, a symlink to it, a linked worktree and a second repository, built in a temp directory and removed at the end — because the finding is about what git actually prints. `shapes` prints the git version and all three answers rather than asserting them from memory. `logical` is the finding: with a symlinked parent cwd the parent side resolves to `…/link/.git` against the target's `…/real/.git`, **BEFORE `sameRepo → false`** for a worktree of the parent's own repository, NOW true. `physical` is the control and the reason this is latent — with a physical parent cwd both columns were already right, and the fix changes nothing on this platform. `foreign` checks the gate still gates: a genuinely different repository is still not the same repo, through the symlink as well as through the real path. |
| `ab9-the-wiring-no-probe-drove.mjs` | **AO9** — AO1's fix was held by nothing: `agent-id.test.ts` and `ab1` both drive the extracted rule, and neither touches `tool-execution.ts:450`, the call that uses it | `for m in published ambiguous refusal full; do node ab9-… $m; done` | The **shipped** `executeStopAgentTool`, loaded through pi's own jiti the way `q2` does, over a real `AgentManager`. BEFORE swaps `resolveId` on the instance for the exact `getRecord` lookup the tool used to make; nothing else differs. `published`: 50 minted ids asked with the eight every surface prints — **BEFORE 0/50 stopped, NOW 50/50**, and the child's `abortController` really aborted rather than merely reported. `ambiguous`: two records sharing the published eight, and the tool names both candidates at a length that tells them apart instead of stopping one. `refusal` is the one to read — the refusal sentence is *identical* in both columns (`Agent 5e3ae827 not found. Running agents: e14e3787 (general-purpose), 06aae107 (explore)`), and each offered id is retried **through the tool**: **0 of 2 accepted BEFORE, 2 of 2 NOW.** That is the loop with no exit, executable. No `--experimental-strip-types`: jiti compiles the TypeScript. |

`ab1`–`ab8` need `--experimental-strip-types`: they load `.ts` modules directly.
**`ab9` does not** — it goes through pi's own jiti, which compiles the TypeScript
itself, and that is the whole reason it can drive a file the others could not.
`ab4` and `ab6` additionally load the **staged** sidecar from
`~/.pi/agent/channels/prinny/runtime/dist`, so they report honestly if it has not
been prepared. `ab8` shells out to `git` and needs it on the PATH; it creates and
removes its own `mkdtemp` root and touches nothing else.

**Twenty-fourth-pass addendum, on the strongest form a BEFORE column can take.**
Three of these — `ab2`, `ab4`, `ab6` — run the **shipped module with one operator
swapped**. The NOW column is the real exported function, unchanged; the BEFORE
column is the single expression that function used to hold, evaluated against the
*same* inputs and the *same* state. Nothing else differs, so the two columns
cannot disagree for any reason except the finding. That is worth reaching for
whenever the fix is one operator (`.includes` → a folded compare, `[k]` →
`hasOwnProperty.call`, `ts <=` → an id check) rather than a new module.

Where it is not possible, the reason is always the same and is stated in the
probe's own header: **`extensions/index.ts`, `agent-manager.ts` and
`tool-execution.ts` all import pi, and nothing that imports pi can be loaded by
`node --experimental-strip-types`.** `ab1` and `ab3` therefore quote the exact
lines they stand in for — eight lines for `markLive` and `liveRooms`, one lookup
for `getRecord` — and mark them, so what is being called BEFORE can be checked
against what actually shipped. A probe that paraphrases the old code is a probe
about the paraphrase.

**And the sentence that addendum stops one step short of — AO9, 2026-08-23.**
A quoted BEFORE column proves the two expressions differ. It does **not** prove
the shipped file still evaluates the NOW one. Measured: `tool-execution.ts:450`
was put back to `getRecord(requestedId)` — AO1's whole defect, restored — and
**1,434 tests and all 121 probes stayed green.** `ab1` passed. A single live
delegation caught it on the first `StopAgent` call
(`context/testing/subagents-loop-verifier.md` §AI.1).

**The reason `ab1` quoted instead of driving does not survive being looked at.**
Its header says `tool-execution.ts` and `agent-manager.ts` import pi, so neither
loads under `node --experimental-strip-types`. That is true, and it is **the
constraint the SUITE runs under**. A probe is not the suite. `q2` has driven the
real `executeStopAgentTool` through **pi's own jiti** since the thirteenth pass —
a probe about this same function, eight files up this directory listing. The
constraint was inherited from the wrong place and the technique was already here.

So `ab9` drives the shipped function. Both columns are the real
`executeStopAgentTool` over a real `AgentManager`; the BEFORE column replaces
`resolveId` **on the instance** with the exact lookup the tool used to make, and
nothing else differs — the "one operator swapped" form, extended from a module to
a call site. **Control run: all four modes exit 1 with the defect restored, all
four exit 0 with it fixed.** Its `refusal` mode is the one to read: the sentence
is *identical* in both columns, and the difference is whether the ids inside it
are ones the same call would accept — **0 of 2 BEFORE, 2 of 2 NOW.**

The suite gets a source pin too (`tests/agent-id.test.ts`, `describe("AO9 —
StopAgent's resolution call site")`), for a different reason: it costs nothing per
run and fails on the edit rather than on the next probe sweep.

```
   a probe through jiti        ab9-the-wiring-no-probe-drove.mjs      executes it
   a source pin in the suite   tests/agent-id.test.ts  AO9            free per run
   a live hand test            …/subagents-loop-verifier.md §AI.1     the operator's
                                                                     own sentence
```

**And one thing this probe got wrong first, kept because it is the finding
repeating inside the fix for it.** `ab9`'s `refusal` mode originally fed each
offered id back through `manager.resolveId` — and with the defect restored in the
source, that mode **passed**, because asking the manager tests the ladder and says
nothing about which lookup the call site makes. It now retries through the *tool*.
The rule to carry: **when a probe's header says "this module cannot be loaded
here", check whether that is a fact about the module or a habit borrowed from the
suite — and when a check feeds a value back, make sure it goes back in through the
door it came out of.**
