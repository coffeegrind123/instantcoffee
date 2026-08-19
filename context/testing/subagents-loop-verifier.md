# Testing subagents, the loop tool, and the verifier

Hand-testing script for the work landed on 2026-08-17 (`db78545`, `11d7ec4`).
Each item is a prompt to paste into a session, plus what counts as evidence that
the thing under test actually happened. Where the evidence is invisible in the
TUI, the `--mode json` recipe is given instead.

Start a session normally — `SUBAGENTS_ENABLED` and `SUBAGENT_VERIFY` are both on
by default:

```
~/qwen3.8-forge/scripts/pi-local.sh
```

**Two things to know before starting, so normal behaviour is not read as a bug:**

- Every subagent shares the one llama slot (`PARALLEL_SLOTS=1`). The parent
  visibly waits while a child runs. That is the design, not a hang.
- A verified answer now carries a **marker**, not a note: dim `✓ checked` on the
  finished line and on the tool result, `✎ repaired` in warning, `✗ off-task` in
  error, `⊘ …` for a skip. **No marker means the verifier did not run** — that
  absence is meaningful and is not a rendering failure. The answer text itself is
  still only annotated when something went wrong, because a note there is text
  the parent model reads and quotes.

---

## A. Does the model drive the description-free schema

The `Agent` tool reaches the model as a name and five parameters with no prose
(see `vendor/pi-subagents-lite/FORK.md`). This is the question that decides
whether the package is usable here at all.

```
Use a subagent to report which file defines REMAINING_FRACTION and what its value is. Don't search yourself.
```

**Evidence:** an `Agent` call whose `prompt` is self-contained (the child has not
seen the conversation) and a 3–5 word `description`. It must not grep itself.

```
Use a subagent to find every file under vendor/ that imports typebox, and report the paths.
```

**Evidence:** the same, without the tool being named — tests whether it reaches
for delegation on its own rather than only when told.

---

## B. The background path, and the cap on a result

**Run this one first.** It is the test that would have caught AC1, and AC1 was
live from the tenth pass to the twelfth: `emitIndividualNudge` threw
`ReferenceError: ctx is not defined` three lines before `pi.sendMessage`, so
**every** background subagent's result — and every continuation's — stopped
reaching the parent model, while a `catch` reported "Result available" through a
UI method that is `() => {}` headless. Everything else in this file is a
foreground test, and the foreground path was never affected.

The whole check fits in one question: *did the result come back into the
conversation at all?* Evidence step 3 below is that question; if the marker (or
any injected result) is missing, nothing else here matters.

A foreground subagent returns as a tool result and `compaction-guard` bounds it.
A **background** one is injected as a message that no hook can see, which is why
the fork bounds it at the source (`src/spawn/result-cap.ts`).

```
Spawn a subagent with run_in_background true. Tell it to run: head -c 40000 ~/qwen3.8-forge/README.md — and return the complete raw output verbatim, no summary. Then poll AgentStatus until it's done and tell me how many characters you got.
```

**Evidence, in order:**

1. `run_in_background: true` — an undescribed boolean, set correctly.
2. `AgentStatus` polling (and usually a `sleep` between polls, uninstructed).
3. In the injected result, a marker of the shape
   `[output capped at N% context: 14218 chars, kept about 10495. Full output: /tmp/pi-subagent-result-…]`
4. `ls /tmp/pi-subagent-result-*/` — the full text is on disk, recoverable.
5. Often the parent then reads the spill file for the exact size, unprompted.
   That is the recovery bargain working.

---

## C. What a subagent may and may not load

Run this one with `PRINNY_ENABLED=1`, or the denial proves nothing.

```
Delegate to a subagent. Its whole task: list every tool name it has, one per line, then every skill it can see. Report its answer verbatim.
```

**Expected:** `read bash edit write stack_status mcpScript mcp` + five `browser_*`,
and the `mcp-scripting` skill.

**Must NOT contain:** `prinny`, `prinny-access`, `prinny-configure` (denied
unconditionally), `Agent` (no recursive subagents), or **`loop`**. The last one
changed: `pi-loop-mode` used to be handed to every child and no longer is,
because it keeps its loop in module scope and a child binds the same module —
see section F. Its absence is worth ~177 tokens/turn back in the child's window.

```
Delegate to a subagent: run `git status --short` and report the exact command string that was executed.
```

**Expected:** `rtk git status --short`. Before this work it came back
unrewritten, because rtk lives in `vendor/` and a child discovers its own
extensions rather than inheriting the parent's `-e` flags.

---

## D. The parent's kill switch

```
Start a background subagent that counts slowly from 1 to 500, one number per turn. Then immediately stop it and confirm it's stopped.
```

**Evidence:** a `StopAgent` call, and a result ending
*"STOPPED BY YOU before completion — output is partial; the task was NOT finished"*.

---

## E. The loop, as a tool the model calls itself

`/loop` was command-only, so only a human could start one. The `loop` tool is
the same code path.

```
Use the loop tool to iterate until `cd ~/qwen3.8-forge/vendor/pi-subagents-lite && npm run --silent test` passes. Set a check command and a max of 5.
```

**Evidence:** a `loop` **tool call**, not `/loop`, with `action: "start"`, a goal
containing "Done when:", and `check` set.

```
Check the loop status, then stop it.
```

**Evidence:** two more tool calls. `/loop status` typed by hand should agree —
both entrances drive the same state.

---

## F. Delegating while a loop is running — the scenario that was broken

This is the one to run first if you only run one. It is the scenario the second
audit found (`context/design/subagents-loop-verifier-evaluation.md` F1), and it
has only ever been tested at the module level.

```
/loop start tidy the comments in vendor/rtk-pi/src/gate.ts. Done when: node --check passes --max 5
```

Then, while it is running, get the model to delegate — any unrelated job:

```
Delegate to a subagent: read vendor/pi-subagents-lite/src/agents/watchdog.ts and summarise what it tracks.
```

**Four things to check, and each was a real failure before the fix:**

1. **The subagent answers the question it was asked** — about the watchdog, not
   about tidying comments. Its system prompt used to gain *"Loop mode is active.
   Goal: tidy the comments … keep every response under 1,200 characters … never
   stop on your own"*.
2. **`/loop status` still shows the goal**, and `Iterations:` has **not** moved
   because of the delegation. The child's `agent_end` used to run the operator's
   whole iteration ladder.
3. **The operator's loop keeps advancing** after the subagent finishes. It used
   to have its pending timer cancelled and its next turn delivered into the
   child, which then worked on the operator's goal until its 40-turn ceiling.
4. **If the child compacts** (give it a big enough job — several large files),
   its answer is still about its own task. A compacting child used to have its
   entire conversation replaced by the operator's loop handoff summary; only the
   task anchor saved it.

The turn ceiling still applies to any child: `DEFAULT_MAX_TURNS = 40`, steered
*"wrap up immediately — provide your final answer now"* at the limit and
hard-aborted only `graceTurns` later, so hitting it produces an answer rather
than a severed run.

**A loop inside a subagent is currently not possible**, and that is deliberate.
`pi-loop-mode` is inert in a spawn and is not loaded into a child, because its
state is module-global. If someone re-enables it via `SUBAGENT_EXTRA_EXTENSIONS`
it will load and do nothing — the factory guard holds independently.

---

## G. The verifier

### Pass path — visible in the TUI now, and still checkable headless

```sh
~/qwen3.8-forge/scripts/pi-local.sh --mode json \
  -p 'Use a subagent to report the value of DEFAULT_CONCURRENCY_LIMIT.' \
  | grep -o '"verification":"[a-z-]*"'
```

**Expected:** `"verification":"passed"`, and the answer text itself untouched.

In an interactive session the same run should end with a dim `✓ checked` at the
end of the Agent result line, and **while the judge runs** the agent's row must
stay in the widget with the activity line reading *"checking the answer against
the task…"*. Both are new; before this the row was removed from the widget for
the whole length of the check and a pass rendered nothing at all.

### Control — proves the judge is really in the loop

```sh
SUBAGENT_VERIFY=0 ~/qwen3.8-forge/scripts/pi-local.sh --mode json \
  -p 'Use a subagent to report the value of DEFAULT_CONCURRENCY_LIMIT.' \
  | grep -c verification
```

**Expected:** `0`, and a visibly faster run. The difference between this and the
previous command *is* the judge. Without this control, "passed" only proves a
field exists.

### Forced failure — probabilistic, not guaranteed

```
Use a subagent with this exact task: "List every .ts file under vendor/pi-subagents-lite/src with its line count. All 53 of them, no truncation, no summary."
```

A 27B usually summarises or truncates, which is a real drift the judge should
catch.

**Evidence:** a notify line — *"Subagent answer did not address the task (…) —
asking again (attempt 1 of 1)"* — and then **one of two** endings, which is the
point of the round budget:

- the retry passes its own re-check → `✎ repaired` and
  `[verification: … this is the corrected one, and it was re-checked.]`
- the retry is also off-task → `✗ off-task`, and the answer handed back is the
  child's **original**, ending `[verification: … one attempt to correct it did
  not fix it. This is the agent's original answer …]`

To watch the loop run longer, raise the budget for one session:

```sh
SUBAGENT_VERIFY_ROUNDS=3 ~/qwen3.8-forge/scripts/pi-local.sh
```

Worst case is `1 + 2×rounds` model calls on the one slot, so at 3 the parent can
wait through seven. `SUBAGENT_VERIFY_ROUNDS=0` checks and reports without ever
repairing, which is the cheapest way to sample the judge's verdicts on real
answers without paying for the fixes.

**This path has never fired live.** It is covered by unit tests only
(`tests/verify-runner.test.ts`), so the judge's real false-positive rate is
unknown. Treat a surprising verdict here as data worth writing down — and note
the two early exits that are easy to mistake for a broken budget: the loop stops
as soon as a repair comes back empty, and as soon as one repeats the answer that
was just rejected.

### The anchor — also never seen fire live

Needs a child that fills its own 32k window and compacts.

```
Use a subagent to read every .ts file in vendor/pi-subagents-lite/src/agents and give me a one-line summary of each.
```

**Evidence:** the child compacts (`compactionCount` > 0 in the agent details) and
still answers the original question rather than a drifted one.

---

## H. Concurrency

```
Spawn two background subagents at once: one to count the .ts files in vendor/, one to count them in .pi/. Then report both counts.
```

**Expected:** they **queue**, not overlap — the widget shows one `running` and
one `queued`. The fork defaults concurrency to 1 because there is one llama slot;
two children would only compete for the same prompt cache.

**This is the check that would have caught F3.** The default lived in
`agent-manager.ts` behind a `??` that never fired, so every session actually ran
at 4 and this test would have shown both children running at once. If you want it
without a model: `new AgentManager(undefined, new ConfigStore().concurrency)` and
read the slot for `forge/<model>` — it must say `{ limit: 1 }`.

---

## I. The agent taskbar, and hopping into a running child

All of this is keyboard work in a real session — none of it shows up headless,
and none of it costs anything on the wire.

Start any background subagent that will run for a minute (section B's works),
then, **with the prompt empty**:

| Do | Expect |
| --- | --- |
| Look at the status line | `◈ Agents: 1 active` alongside the MCP indicator |
| Look above the editor | `◈ Agents  ↓/← to navigate`, then a spinner row per agent with its description, stats and current activity |
| Press `↓` — or `←` | The heading becomes `↑↓ navigate · enter view · esc back` and the first row gets a `→` |
| Press `↑` / `↓` | The highlight moves; the roster order freezes for 2 s so a finishing agent cannot move the row under your fingers |
| Press enter | The child's live transcript opens as an overlay — you can watch it work, steer it, stop it |
| Press esc twice | Back to the transcript, then back to the prompt |

**The gate is an empty editor.** With any text typed, `↓`/`←` do what they
normally do; the widget is not reachable and that is deliberate.

**A finished agent leaves the widget after one minute** (`finishedRetentionMinutes`),
so the keyboard hop cannot reach it after that — `/agents` still can, for the
whole session. If a test seems to show the hop "breaking", check how long ago
the agent finished before suspecting the handler.

### The verifier's row, which is the one that used to vanish

```
Use a subagent to report the value of DEFAULT_CONCURRENCY_LIMIT in vendor/pi-subagents-lite.
```

Watch the widget across the moment the child stops working. The row must **not**
disappear and come back: it stays, spinner running, activity line
*"checking the answer against the task…"*, and only then moves to a finished line
carrying `✓ checked`. If it blinks out instead, `verifyPhase` is not being set —
that is the exact regression this was built to prevent.

## J. Steering a RUNNING subagent — W3's path, never exercised

Added by the seventh pass. Everything in §G checks a subagent that was left alone;
this is the one where the operator changes the task **while it is working**, which
is the affordance the conversation viewer names by calling its verb "steer"
(against "continue" for a settled agent).

```
Use a subagent to list every caller of getStore() in vendor/pi-subagents-lite/src.
```

While the child is still running, open the taskbar (`↓` or `←` on an empty
editor), `Enter` into the viewer, press `Enter` again to open the composer — the
prompt must read **`✎ steer`**, not `✎ continue`; if it says continue the agent
has already settled and this is §G's path instead — and send:

```
Now also list the callers of getManager(), same format.
```

Three things to check, in this order, and the first is the one that used to be
wrong:

1. **The answer covers both questions.** If it covers only the second, the steer
   replaced rather than extended — a different bug from this one.
2. **The verdict is not `✎ repaired`.** Before the fix the judge was shown the
   spawn prompt only, so a two-part answer was correctly read as NOT_ADDRESSED,
   and the repair then told the child *"This is the task, in full, as it was given
   to you: <the original>. Answer it now … Do not restate the task"* — the steer
   undone by the layer that exists to catch drift. `✓ checked` is the pass.
3. **Headless, the brief itself.** `--mode json` and grep the tool result's
   details for `verification`; a `passed` there against a two-part answer is the
   evidence, because the brief is not printed anywhere.

If the child compacts during the steered run, the anchor is the third reader and
the same fix covers it: the reminder injected after the compaction must contain
the follow-up, not just the original task.

## K. A record while its verifier is running — Y1's path, never exercised

The window is real and it is not short: after a subagent's own run settles, the
judge is a whole extra session and one turn, and a repair is one or more turns in
the child's session. Throughout, `record.lifecycle.status` reads `completed`.

**Setup.** `SUBAGENT_VERIFY_ROUNDS=1`, a deliberately off-task brief (so a repair
round actually happens), and a BACKGROUND delegation, so the operator's session is
free to open `/agents` while it runs.

```
Agent(agent: "general-purpose", run_in_background: true,
      prompt: "List every caller of tokenize() in src/, with file:line.")
```

Then, as soon as the widget's row stops streaming tool activity:

**What to look for.**

1. **The widget row stays**, in the running block, and its activity line reads
   `checking the answer against the task…` or `answer was off-task — asking
   again…`. If the row vanishes for a while and comes back, `verifyPhase` is not
   being set — that is the bug this row was added for.
2. **`/agents` agrees with it.** The row reads `▶ … completed · checking`, not
   `✓ completed`. Before Y1 the two views disagreed, and the menu's was the one
   with the buttons on it.
3. **No Clear is offered.** Open the agent's action list: while the check is
   running it should have viewing actions only — no Clear, and no Steer or Stop
   either, because both would silently return false. "Clear all" and "Clear done"
   must not count it.
4. **After the verdict lands**, the same agent offers Clear again and clearing it
   behaves exactly as it always did.

**Why it matters more than it looks.** `clear()` used to accept, and
`removeRecord` disposes `execution.session` — the session a repair runs in — and
opens the completion gate with `""`. For a FOREGROUND delegation that is the
parent's `Agent` call returning an empty answer while the real one is still being
judged. Reproduce that half in the probe (`l6`) rather than by hand; by hand,
watch the three readers agree.

## K.2 Stopping a verification — new (T5, closed)

Bolt onto §K rather than a run of its own. While a record is showing `checking`
in `/agents`:

1. **The action list must now offer "Stop the answer check"**, and no Clear. It
   used to offer nothing at all: every stop path keyed off `status === "running"`
   and the status is already terminal by then, so a button would have failed
   silently and Y1 chose to show none.
2. **Choosing it must end the check within a second or two**, not at the 300 s
   deadline. The answer should go to the parent annotated as unchecked (the
   `errored` verdict, `? check errored`), NOT lost — that is the whole failure
   policy of the layer.
3. **The parent's `Agent` call must unblock.** The completion gate opens in the
   settlement chain's `.finally`; before T5 it could not open until the deadline.
4. **Then Clear must work**, because the record is no longer verifying.
5. **Esc should do the same thing**, through the same path.

## L. A child that compacts — never run (Z1, Z2)

This is the highest-value single run available after the ninth pass, and it needs
no special setup beyond a task big enough to fill a child's window.

```
Agent(agent: "general-purpose",
      prompt: "Read every file under src/ and list, for each one, the exported
               symbols and which other files import them. Then answer in one
               paragraph: which module has the most inbound dependencies?")
```

**What to look for.**

1. **Did it compact at all?** `/agents` → the agent → the record's stats, or
   `--mode json`: `record.stats.compactionCount` must be ≥ 1. If it is 0 the run
   did not exercise this path and the rest of the checks mean nothing. Make the
   task bigger and try again.
2. **The answer is the ANSWER.** The tool result should be the paragraph that was
   asked for. Before Z1 and Z2, a compaction at the end of the run produced a
   whole extra turn answering the task anchor, and its reply — "Understood —
   nothing further to add", or similar — was what the parent received.
3. **The answer is not empty.** Before Z1, a compaction plus a reasoning-only
   final message produced `""`, which the verifier's structural gate replaces
   with "The agent returned no answer at all. This is usually a saturated
   context, not a hard task — re-task it with a narrower question rather than
   repeating this one." A settled, successful child reported as having said
   nothing is the symptom.
4. **Count the model calls.** Before Z2, every compaction bought one extra turn
   on the single llama slot. There is no counter for this; the honest check is
   the child's turn count against what the task plausibly needed, or the
   provider-side request count if forge's log is being watched.
5. **The verdict.** With `SUBAGENT_VERIFY=1`, the badge should be `✓ checked`.
   Before the fixes the judge would rule an acknowledgement off-task — correctly
   — and spend a repair round on it, so `✎ repaired` or `✗ off-task` on a task the
   child plainly did was the tell.

**Why by hand rather than by probe.** `m1` and `m2` drive the shipped functions
with a session stub that emits the events pi emits; what neither can show is how
often a real 27B on a 32k window actually crosses pi's compaction threshold before
finishing. That number decides whether these were rare or routine, and nothing in
the tree can answer it.

## M. One loop turn, watched — never run (AA1, AA2)

The cheapest run on the list and the one with the most riding on it. No subagent,
no verifier, one `/loop start` and one `/loop status`. Both of the tenth pass's
HIGH findings are on this path, and neither has ever been seen against a model.

**Setup.** Something slow to check, and something to look at afterwards:

```sh
cat > /tmp/slow-check.sh <<'EOF'
#!/usr/bin/env bash
sleep 300        # longer than --check-timeout, on purpose
echo "SCORE: 100"
EOF
chmod +x /tmp/slow-check.sh
```

```
/loop start Add a docstring to every exported function in src/. Done when: every
export has one. --check "/tmp/slow-check.sh" --check-timeout 5 --until-done --max 4
```

**What to look for.**

1. **AA2 — the check must not read as passing.** After the first iteration,
   `/loop status`:
   - `Check status:` must say the check could not run, **not** `passing`.
   - `Active:` must still be `true`. Before the fix, the first `LOOP_DONE:` after
     a killed check completed the run, because `waitForChildProcess` resolves
     `null` for a signalled child and `execCommand` does `code: code ?? 0`.
   - After three iterations the run should PAUSE with a notice naming the check.
     That is `MAX_CHECK_ERRORS`, which had never once fired in a real session
     because `execFailed` was unreachable.
2. **AA1 — the loop's rules must reach the model.** There is no UI for the system
   prompt, so this is read from the wire. With forge's request log on, take one
   loop-driven turn and check that the `Loop mode is active. Goal: …` block is
   present **once**, in the message list rather than in `system`. Before the fix
   it was in neither: the handler that produces it never ran on a loop turn.
3. **AA1's second half — type something, then watch the next two turns.** With
   the loop running, type an ordinary question (`what have you changed so far?`)
   and let it answer. Then let the loop take one more iteration and compare the
   `system` field of that iteration's **first** and **second** provider calls.
   They must be identical. Before the fix the first carried a stale copy of the
   loop block and the second did not — a system-prompt change at offset 0 of the
   cached prefix, mid-iteration.
4. **The prefix cache, which is the cost of (3).** `slot-cache.sh`, or forge's
   own timing: turn 2 of an iteration should be a cache hit. A full re-prefill
   there is what AA1's second half costs, and §3.6's comparable measurement is
   2,117 cached tokens → 0 and 442 ms → 2,949 ms.
5. **The provider ladder, if the server can be spared.** Stop llama-server mid-run
   and watch `/loop status`: the retries should count `1/10`, `2/10`, … with the
   escalating backoff, and after ten the run should PAUSE naming the provider
   rather than retrying forever. Then start the server and `/loop resume` — the
   streak must be back at zero, or the resume re-pauses on the first error. Before
   this pass there was no terminal state at all and no separate counter: a
   provider error advanced the CONTEXT-recovery ladder toward its cooldown, and
   vice versa.
6. **Headless, if there is time.** Run the same thing under `pi -p` and read
   `.pi-loop-log.jsonl` afterwards. Every notice above should be in it as an
   `event: "notice"` line. pi's `noOpUIContext.notify` is `() => {}`, so before
   this pass an unattended run's whole narrative went nowhere.
7. **Then clean up.** `/loop end`, and delete `/tmp/slow-check.sh`.

**Why by hand rather than by probe.** `n1` models pi's two entry points and `n2`
calls pi's real `execCommand`, so both are evidence about the host. What neither
can show is the wire: whether the block really is in the message list where it is
supposed to be, and whether llama.cpp really does re-prefill when the system
prompt changes between turns of one run. Only a running model answers those.

## What none of this covers

- **Subtly wrong work.** The judge is the same 27B that wrote the answer. It
  catches a different question being answered, an empty or evasive summary, and a
  claim about work plainly not done. It is a drift check, not a correctness
  proof.
- **Whether the verifier's repair helps.** The repair path is unit-tested and
  unobserved; whether a second attempt from a drifted child is actually better
  than the first is an open question.

## N. A Matrix exchange with a background subagent running — never run (prinny W1)

The only fix in the tenth pass whose failure mode is visible to somebody other
than the operator, and the only one that needs two machines.

**Setup.** A working prinny channel (`/prinny status` green), and a task that
takes long enough to still be running when the answer is ready.

**The run.**

1. From Matrix, ask something the model can answer immediately and briefly:
   *"what does src/parser.ts export?"*
2. While it is answering, from the terminal, launch a background subagent:
   `Agent(prompt: "count the files under src/", run_in_background: true)`.
3. Let the subagent finish while the parent is still in the same run.

**What to look for.**

1. **The sender gets the answer.** Before the fix, the subagent's result was
   injected mid-run, pi ran another assistant message for it, the model replied
   with reasoning only (nothing to add), and `describeEmptyEnding` judged THAT
   message — so the sender was told the model said nothing, about a turn that had
   already answered them.
2. **The answer is the right one**, not an earlier turn's. That is the boundary
   the 2026-08-17 incident bought: only an empty assistant message whose immediate
   predecessor is a `subagent-result` is stepped over. A `user` message still
   stops the walk.
3. **The control, and it matters more than the case:** ask a second question,
   let the context be nearly full, and let the model return a genuinely empty
   turn. The sender must be told the run said nothing — NOT handed the previous
   answer. If that regresses, the fix has gone too far.
4. **`/prinny status`** should show no queued-forever room; the delivery either
   happened or was refused, never both.

## M.2 A goal check that is KILLED rather than slow — never run (AB1)

§M covers pi's own timeout, which is the half the tenth pass fixed. This is the
other half, and it is one command longer.

**Why it is separate.** `result.killed` is set only inside `execCommand`'s own
`killProcess()`, whose two callers are the `options.timeout` timer and the
`options.signal` listener — so it means "pi killed this". A check killed by
anything else exits with a signal and no code, `waitForChildProcess` resolves
`null`, and `execCommand` does `code: code ?? 0`. The run then reads exit code 0,
which is a check that PASSED, which in `--until-done` is the only condition that
ends the run.

**The run, in one line:**

```
/loop start Tidy the imports in src/. Done when: the check passes.
  --check "kill -9 $$" --until-done --max 3
```

`kill -9 $$` is what an OOM kill looks like from the outside: the shell dies
without running its `EXIT` trap. Nothing about it is contrived — on this box a
`--check "cargo test"` under memory pressure is the same event with more steps.

**What to look for.**

1. **`/loop status` must NOT say `Check status: passing`.** Before the fix it did,
   immediately, on iteration 1. It should now read
   `- — LAST KNOWN; the check has not run for 1/3 turns: the check process died
   before it finished — killed by a signal rather than by its own exit (an
   out-of-memory kill looks like this).`
2. **The first `LOOP_DONE:` must not end the run.** `Active: true`, and the model
   is told the CHECK is the work: *"Completion is decided by the check, so the
   check itself is the work: fix or replace `kill -9 $$`…"*
3. **Three in a row pause it.** `Status: paused`, and the notice names the check
   rather than the project.
4. **Nothing anywhere contains `__PI_LOOP_CHECK_COMPLETED__`.** Not the status,
   not the directive the model is given, not `.pi-loop-log.jsonl`. The marker is
   an implementation detail of the harness and the model must never see it — if
   it does, the model will start writing it.
5. **The control, in the same session:** `/loop end`, then start again with
   `--check "true"`. That must complete on the first `LOOP_DONE:`, exactly as
   before. If it does not, the wrapper has broken an ordinary check.
6. **The second control:** `--check "exit 127"` must still read as a **failing**
   check, not an unrunnable one. That distinction is deliberate (see
   `runGoalCheck`'s header) and it is the thing most likely to be lost by a
   careless change here.

**Where to look afterwards.** `.pi-loop-log.jsonl`: every `check_error` entry
carries the streak and the message, and in a headless run it is the only trace.

---

## O. A Matrix message sent while pi is compacting — never run (AB2)

The only fix in this pass whose failure mode is visible to somebody other than the
operator, and the only one that needs two people or two windows.

**Why it exists.** `api.sendUserMessage` returns `void`; pi's binding `.catch`es
the rejection into `emitError`; `emitError`'s listener set is registered only when
a UI bound one, and there is no error event an extension can subscribe to. So when
`AgentSession.prompt()` throws — and it throws while a compaction is in progress
(`agent-session.js:808`) — the message is gone and the extension is not told.
Before this pass the sender was not told either: the room sat in `awaitingReply`
un-live forever, which from Matrix is indistinguishable from being ignored.

**Setup.** A working prinny channel (`/prinny status` green) and a session with
enough history that a compaction takes a noticeable moment.

**The run.**

1. In the terminal, force a compaction: `/compact`, or let the loop's stuck ladder
   reach its compaction rung.
2. **While it is compacting**, send a message from Matrix.
3. Wait a minute without touching anything.

**What to look for.**

1. **The sender is told, once**, within about a minute:
   *"I could not hand that to the session — it would not accept a new message just
   then… please send it again."*
2. **Once, not repeatedly.** The sweep runs every 30 s; `undeliveredReported`
   must stop it after the first.
3. **The operator sees a warning too**, and `/prinny log` has
   `pi never took the message from !room — reporting it as undelivered`.
4. **The control, and it is the important one:** send a message while pi is
   plainly BUSY on a normal turn (not compacting). It must be queued, answered
   normally, and **never** produce the undelivered sentence. A false positive here
   is worse than the bug — it tells somebody their message was lost when it was
   about to be answered.
5. **The second control:** if the message does arrive late — a compaction
   finishing just after the sweep fired — the answer must still reach the room.
   The entry is deliberately not retired, so `markLive` still works and the sender
   gets both the apology and the answer. That is the intended worst case.

**The other way to reach it**, if forcing a compaction is awkward: stop
llama-server, send a Matrix message, wait a minute. `prompt()` throws on the auth
check (`:859`) and the same path runs.

---

## M.3 A goal check that cleans up after itself — never run (AC3)

One command, bolted onto §M. §M covers pi's own timeout and §M.2 covers a check
the OOM killer reaps; this is the third way the completion marker can go missing,
and it is the only one where the check is **fine**.

**Why it exists.** A bash `EXIT` trap is a slot, not a stack. `trap … EXIT` inside
the check command replaces the one `wrapCheckCommand` installs, and `exec`
discards traps altogether — so before this pass a check that ran perfectly came
back with no marker, which the loop reads as "the check process died before it
finished — killed by a signal (an out-of-memory kill looks like this)". Three of
those in a row PAUSE an unattended run.

```
/loop start Tidy the imports in src/. Done when: the check passes.
  --check "trap 'echo cleaning up' EXIT; true" --until-done --max 3
```

**What to look for.**

1. **It must complete on iteration 1.** `Check status: passing`, `Status:
   completed`. Before the fix: `could not run (1/3)`, and a pause at three.
2. **The check's own cleanup still runs** — `cleaning up` appears in the check
   output the loop reports, so the subshell has not swallowed it.
3. **The failing variant is still a FAILING check, not an absent one:**
   `--check "trap 'echo bye' EXIT; exit 1"` must read as `failing (streak 1)`.
4. **The control, and it is the one that must not regress:** `--check "kill -9 $$"`
   (§M.2) must still read as a check that could not run. If the subshell has made
   a signalled death look complete, AB1 is undone and that is far worse than what
   AC3 cost.

---

## P. A background subagent's result, end to end — the AC1 run

§B checks the cap and the polling; this checks the one thing §B assumes. It is
listed separately because it needs no cap, no spill file and no big output — just
a background delegation and a look at the conversation.

```
Spawn a background subagent to report which file defines REMAINING_FRACTION. Then wait, and tell me its answer.
```

**What to look for, in order.**

1. **The result appears in the conversation** as a `subagent-result` block, on its
   own, without the parent having called `AgentStatus` to fetch it. That is
   `emitIndividualNudge` working. Before the fix there was nothing: the parent sat
   waiting, and the only trace was a dim `Result available` line in the TUI.
2. **The parent answers from it.** If the parent instead polls `AgentStatus` and
   reads the answer that way, the delivery still failed — `AgentStatus` is the
   recovery path, not the delivery path, and a model that has learned to poll will
   hide this bug from you.
3. **Headless is the real test.** `pi -p` with the same prompt: `noOpUIContext.notify`
   is `() => {}`, so a broken delivery is completely silent there, and a working
   one is the only reason the parent can say anything about the child's work.
4. **Then steer a settled agent** (the conversation viewer's `✎ continue`), and
   watch for the same thing: continuation settlements go through the identical
   path (`settlementCount >= 2`), and were identically broken.

---

## Q. The subagent model override — the AD1 run

**Cheap, and it needs one config change and one delegation.** Until this pass the
override was resolved by four components and applied by none, so the answer to
"which model did the child run on?" was always "the parent's". Nothing said so;
the TUI said the opposite.

Set a per-type override for something you can tell apart from the session model —
`/agents` → models → per-type overrides → `Explore` — then:

```
Use the Explore agent to find where REMAINING_FRACTION is defined.
```

**What to look for.**

1. **The call line** reads `▸ Explore (<the override>)`. It read that before the
   fix too — `_modelOverride` is a display copy the listener writes, and it was
   always right. It is here as the thing the next two must agree with.
2. **The result's details** — expand the tool result, or read `/agents` → the
   record — report `modelName` / `modelId` as the override. Before the fix they
   reported the session model, and that is the tell.
3. **The concurrency slot.** With `default: 1` and an override set, a second
   delegation to a DIFFERENT type should start immediately rather than queue:
   the two now sit in different slots because `modelKey` follows the model.
   Before the fix every child shared the parent's slot.
4. **The frontmatter case, which is the one nobody sets deliberately.** Clear the
   session override and give an agent `.md` a `model:` line instead. It reaches
   the child through `agent-runner`'s own `options.model ?? …` fallback, which was
   unreachable while the tool always supplied the left side.

## R. `StopAgent` on a record whose answer is being checked — the AD2 run

**Needs a verification in flight, so pair it with §G.** Give a subagent a
deliberately off-task brief with `SUBAGENT_VERIFY_ROUNDS=1`, and while the widget
shows the record as `checking the answer`, have the model stop it:

```
Stop that agent — I have what I need.
```

**What to look for.**

1. **The tool answers "Stopped the answer check on agent …"**, not "is already
   completed". The second sentence is the pre-fix behaviour and it was wrong twice
   over: the agent is not finished, and the "Running agents:" list beside it
   omitted the one agent that was running.
2. **The check really stops** — the widget's `checking the answer` row clears
   within a turn, and the answer comes back with `[verification: the check did not
   complete, so this answer went out unchecked.]`
3. **The child's own answer survives.** That is the whole failure policy of the
   layer: an unverified answer beats no answer.
4. **`/agents` → Clear on the same record must still refuse** while the check is
   running. Stop and Clear are different questions, and Y1 is why.

## S. A Matrix `/compact` while the machine is busy — the AD3 run

**Two messages, and the second is the one that matters.** Needs the Matrix channel
up and a loop running (`§M` will do).

```
   from Matrix, while the operator's turn (or a loop iteration) is streaming:
      /compact
```

**What to look for.**

1. **The reply is "The session is mid-turn — I will compact as soon as it finishes
   rather than cutting it off."** Not "Compacted the conversation context."
2. **The turn finishes.** Before the fix it did not: pi's `compact()` begins
   `await this.abort()`, so the turn was cancelled mid-stream.
3. **The loop does not pause.** This is the reason the finding was HIGH. Before the
   fix, `/loop status` afterwards read `Status: paused` with
   `Last notice: Turn aborted by operator` — an unattended run stopped by a remote
   message and blamed on somebody who was not there.
4. **The compaction happens after**, and the sender is told when it finishes.
   Watch the order: `agent_settled` forwards the answer first, then drains the
   pending compaction, so the person waiting for a reply is not queued behind a
   summariser call on the one slot.
5. **The idle case still works.** Send `/compact` with nothing running: it must
   compact immediately and answer from `onComplete`.

## T. A refused flag from Matrix — the AD6/AD7 run

One message each, and the reply is the whole test.

```
   /loop start keep the tests green --check "make test"
   /loop start keep the tests green --rescue-model forge/big
   /loop start keep the tests green
   /agents
```

**What to look for.** The first two are refused, and each refusal **names its own
flag and its own reason** — `--check`'s reason mentions the permission relay, not
the model. The third is accepted and starts a run. The fourth is refused with
"Run it in the terminal" rather than being spent as a model turn, which is what it
used to be.

## U. Esc on a loop turn, then type anything — the AE1 run

**The cheapest run on the whole list. One keypress and one sentence, no subagent,
no verifier, no Matrix account, and nothing to configure.** It is also the one
that has been reachable by accident since the loop existed.

```
   /loop start keep the tests green. Done when: never
   …wait for a turn to start streaming, then press Esc
   /loop status
   why did you stop?              ← an ordinary question, typed normally
   /loop status
```

**What to look for.**

1. **The notice says paused**: `Loop paused (turn aborted). Use /loop resume to
   continue.`
2. **The first `/loop status` says `Active: false`.** Before the fix it said
   `Active: true` beside `Status: paused` — a contradiction nobody was looking at,
   because `status` is a display field and `active` is the one that decides.
3. **The question is answered as a question.** Before the fix,
   `before_agent_start` prepended "Loop mode is active. Goal: … Keep every
   assistant response under 1,200 characters, do one progress batch per turn, …
   never wait for a human (make documented assumptions instead)" to it. A short,
   clipped, oddly task-shaped answer to a plain question is the visible symptom.
4. **The second `/loop status` still says `Active: false`, `Iterations` unchanged.**
   This is the finding. Before the fix, answering the question ran the whole
   `agent_end` ladder, counted the operator's turn as an iteration, and scheduled
   the next one — so the run the operator had just stopped by hand carried on, in
   silence, from a turn they typed themselves.
5. **`/loop resume` still works**, and is now the only way back.

**The variant worth doing once**, because it needs no human at all: press Esc,
then delegate something in the background (`§B`) and walk away. The subagent's
result arrives through `pi.sendMessage({triggerTurn: true})`, which is an
`agent_end` like any other — so before the fix a paused loop resumed itself with
nobody at the keyboard.

## V. A `/compact` from the room that is waiting for an answer — the AE3 run

**One person, one room, two messages, and the second is an ordinary thing to
send.** This is §S's sequence with the two messages coming from the SAME room,
which is the common case rather than the exotic one — a person messages the bot,
it goes quiet, and they ask it to compact.

```
   from Matrix:
      what is the status of the build?
   …while the model is answering:
      /compact
```

**What to look for.**

1. **The answer to the first message still arrives.** Before the fix it did not,
   and there was nothing at all to see: `awaitingReply` is keyed by room and held
   one entry, so the `/compact` replaced the entry for the question, with
   `live: false`. `forwardToMatrix` filters on `live`, found no room, and dropped
   the answer.
2. **And no apology arrives either.** The `/compact` set `answered: true` on the
   way past, which is what suppresses the undelivered sweep — so the sender got
   silence and no explanation, having done nothing wrong.
3. **The deferred compaction still happens**, after the answer.
4. **The control, and it is worth sending:** two ordinary questions in a row from
   the same room. That case self-corrected before the fix, because pi echoes the
   second message and `markLive` fires again — which is why this was invisible
   for a `text` message and permanent for a command.

## W. An empty turn with a `/compact` waiting — the AE2/AE4 run

**Needs the two together, and they arrive together for a reason:** a sender asks
for a compaction *because* the bot has gone quiet, and an empty turn is what quiet
looks like from inside.

Easiest to set up by filling the window first — a long session, or a subagent that
returns a large result — then, from Matrix:

```
   ask something that will take a turn
   …while it is streaming, from ANOTHER room or another account:
      /compact
```

**What to look for.**

1. **The continuation runs.** The log line is `continuing the run to get an answer
   (attempt 1)`, and the model answers the outstanding question. Before the fix the
   compaction ran in the same `agent_settled` handler, and pi's `compact()` begins
   `await this.abort()` — so the continuation was killed by the thing that had
   just been told to wait.
2. **The compaction happens on the settlement AFTER that**, and the sender who
   asked for it is told when it finishes.
3. **The room is answered by the continuation**, not by the next unrelated turn.
   This is AE4 and it is the one worth being careful about: if the continuation
   does not happen — because the provider is down, or a compaction was already in
   progress — the room must be told `I could not hand that to the session … please
   send it again` within a minute, and it must **not** receive the answer to
   whatever the operator asks next in the terminal.
4. **The control:** do the same thing with the llama-server stopped, so the
   continuation cannot be taken. The sweep's sentence must arrive, and nothing
   else must.

## X. Two rooms, one turn — the AF1 run

**The cheapest Matrix run on the list, and the only one that needs two rooms.**
It needs no loop, no subagent and no verifier — just the bot, and two
conversations that overlap by a few seconds.

```
   from room A:   did the nightly build finish?
   …before it answers, from room B (a DM, or a second account):
      can you summarise the incident?
```

Both messages are queued as follow-ups and pi's agent loop drains the queue
inside the same run, so both rooms are live when the answer arrives.

**What to look for.**

1. **Neither room is sent the answer.** That is correct and unchanged:
   `forwardToMatrix` refuses to guess whose answer it is, because sending one
   person's conversation to another is not undoable.
2. **Both rooms are told something.** *"Someone else was being answered in the
   same turn and I could not tell which reply was yours, so I sent nothing rather
   than send you theirs. Please ask again."* Before the fix, both rooms were
   retired in silence — and the undelivered sweep could not report it either,
   because the entries were deleted along with the answer.
3. **The operator sees a notice**, not just a line in `channel.log`.
4. **The next turn goes nowhere near either room.** Ask something in the terminal
   afterwards; neither room may receive it.
5. **The control, and it is one message:** ask from ONE room, alone. The answer
   arrives, and nothing else does — an answered room is never apologised to.

A second control worth doing once, because it exercises the other sentence: ask
something that the model answers entirely with tool calls and no closing text
(*"run the test suite"* on a quiet session sometimes does it). The room should
get *"That turn finished without anything I could send you."* rather than
silence.

## Y. A `/loop` against a failing suite, with the model running it too — the AF6 run

**The shape an unattended loop actually has**, and the one the output cap was
switched off for.

```
   /loop start make the test suite pass --until-done --check "npm test"
```

with the suite genuinely red, in a package whose failure output is long (a few
hundred failing assertions is enough — 15,000 characters or so).

**What to look for.**

1. **`Compaction guard: capped bash output N -> M chars.`** appears in the
   terminal on the iterations where the model runs the suite itself. Before the
   fix it never did: a non-zero exit makes the whole output an `isError` result,
   and the cap returned at its first line for every one of them.
2. **The capped text still ends in `Command exited with code 1`**, with the head
   of the run above it and a `Full output: /tmp/pi-tool-output-…` marker between.
   The cap keeps a head AND a tail precisely so an error's ending survives.
3. **The context percentage in the status bar stops climbing** at the rate it
   used to on those iterations. This is the whole point: at 84.5% a
   17,000-character result takes the window to 100% and the next turn comes back
   empty.
4. **The control:** the same command with the suite GREEN. The result is short,
   it is under the allowance, and nothing is capped — the notice must not appear.

## Z. Five directives with something typed mid-turn — the AF3 run

**Needs a `--check` to be comfortable**, because the goal check is what holds
`agent_end` open long enough to type into it.

```
   /loop start tidy the README --check "sleep 20; false"
```

Then, while the loop is running and the status bar says the check is running,
**type a question into the terminal and press enter**. It will be queued as a
follow-up rather than starting a turn.

**What to look for.**

1. **The loop's directive still reaches the model.** The next turn carries both
   your message and a `loop` message — `check_failed` in this case, because the
   check fails. Before the fix the loop said "LOOP_DONE claimed, but the goal
   check fails — continuing" to the operator, charged the ladder, and sent
   nothing.
2. **Only ONE turn runs**, not two: the directive is queued onto the turn that
   was already coming rather than scheduling a second one.
3. **The control:** do nothing at all during the check. The directive still
   arrives, in its own turn, exactly as before.
4. The same test works for `improve` (an endless loop and a `LOOP_DONE:`),
   `unblock` (`LOOP_BLOCKED:`), `regression` (a `--check` printing a `SCORE:`
   that drops) and `audit` (eight iterations with no file change) — but
   `check_failed` is the one you can set up in a single command.

## AA. A compaction racing something else — the AG2/AG3 run

**The cheapest run this pass added, and the only one of the three that needs no
Matrix account at all.** Both findings are the same moment: a compaction is
running, and something else wants to prompt the session. pi's refusal for that
lives on `AgentSession.prompt()` and neither of the two senders goes through it.

### AA.1 The loop's next iteration — AG2, terminal only

```
   /loop start tidy the README --delay 20
```

Let one iteration finish, and while the status bar is counting down the delay —
i.e. while the session is idle between iterations — type:

```
   /compact
```

**What to look for.**

1. **A notice, once:** `Loop: <owner> is compacting — holding iteration N until
   it finishes.` Before the fix there was no notice, because there was no wait.
2. **The next iteration does not start until the compaction has finished.**
   Watch the footer: "Working…" must not come back while the compaction is
   running. Before the fix the turn went straight into it, on the entry point
   that does not refuse, and pi's `compact()` ends by REPLACING
   `agent.state.messages` — so the run was streaming into an array that was
   about to be thrown away.
3. **The iteration is not lost.** Once the compaction completes, the same
   `continue` turn goes. It is deferred, never dropped — an unattended run must
   not lose an iteration to a compaction it did not ask for.
4. **The control:** the same `/loop start ... --delay 20` with no `/compact` at
   all. Every iteration goes on time and no notice appears.

Note the notice names the *holder*, so it also tells you which extension asked —
`prinny-channel` for a Matrix `/compact`, `pi-loop-mode` for the loop's own
emergency recovery. The loop never waits for its own: both of its compaction call
sites release the lock in their callbacks before they schedule the next turn.

### AA.2 The empty-turn continuation — AG3, needs Matrix

The other half, and the one that costs an answer rather than a turn. It needs a
saturated context, because the two conditions are the same event: the loop's
starvation rung fires on a clean `stop` with no answer at ≥80% of the window, and
`describeEmptyEnding` names `context` at ≥87%. **One empty turn on a nearly full
context produces both.**

```
   /loop start <something long-running>          # let it fill the window,
                                                 # or resume a session already
                                                 # above 87%
```

Then message the bot from Matrix and wait for a turn to come back empty.

**What to look for.**

1. **No continuation nudge is sent.** Before the fix one went, pi refused it
   silently (the rejection goes to `emitError`, whose listener set is empty
   outside a TUI), and one of the message's two rescue attempts was charged for
   a send that never happened.
2. **The sender is told on that settlement**, not sixty seconds later by the
   delivery sweep: *"That turn ended without an answer, and the session was
   already compacting its context, so I could not ask it again just then."*
3. **The operator sees** `no answer, and <owner> is compacting — the sender is
   being told to ask again`.
4. **The control:** the same empty turn with no compaction in flight. The
   continuation goes as before, the room stays live, and the answer to the nudge
   is forwarded normally — that is §W's path.

If you cannot get the context saturated on demand, `t1` reproduces the whole
sequence with both real extensions in one process:

```
   node context/testing/probes/t1-the-nudge-and-the-compaction-already-running.mjs
```

What it cannot show is the one thing a live run would: whether a 27B, asked
again after a compaction, actually answers.

## AB. A compaction racing the third sender — the AH1/AH6 run

**§AA's own next instance**, and the reason this section exists at all: the
seventeenth pass found that `compactionInFlight()` had a fifth reader that
already existed, in a third package, on the one delivery path in the machine
that gets a single attempt. Both runs below need no Matrix account.

### AB.1 A background subagent's answer, into a compaction — AH1

The cheapest run on this list that exercises a subagent at all.

```
   Agent(prompt: "list every file under vendor/ that mentions compactionInFlight,
                  with line numbers",
         agent: "Explore",
         run_in_background: true)
```

Then, **while the child is still working** — the widget will show it running —
type:

```
   /compact
```

The child settles while pi is compacting. Its result is delivered from a 200 ms
batch timer that is not ordered against anything.

**What to look for.**

1. **A notice, once, at `info`:** `[Subagent "Explore" <id>] result held —
   prinny-channel is compacting; it will be delivered when that finishes.`
   Note the wording: **held**, not *NOT delivered*. Three other notices in this
   package use the second phrasing and they mean the answer is gone; this one
   means it is intact and late. If you see "NOT delivered" here, the wrong
   sentence is being used.
2. **The result does not appear in the conversation while the compaction runs.**
   Before the fix it did, and it started a whole agent run inside the compaction
   — built from a snapshot of the pre-compaction message list, which is the
   oversized context the compaction exists to shrink.
3. **The result DOES appear once the compaction finishes**, as
   `[Subagent "Explore" <id> completed]` followed by the answer, and the parent
   model takes a turn on it. This is the assertion that matters: the answer must
   be late, never lost. `emitIndividualNudge` runs once per record and the record
   is already settled — there is no second attempt and nobody to ask.
4. **The notice is not repeated every five seconds.** The re-ask is; the notice
   is not.
5. **The control:** the same delegation with no `/compact`. The result arrives
   within ~200 ms of the child settling, with no notice at all.

Do this headless too (`pi -p …`), because the notice goes through
`ctx.ui.notify`, which is `() => {}` outside a TUI — the `console.warn` beside it
is what you are checking there, and it is deliberately unconditional.

### AB.2 A charged directive, into a compaction — AH6

`§AA.1` with one change: make the turn in the gap a decision rather than an
ordinary one.

```
   /loop start tidy the README --delay 20 --endless
```

Wait for a turn that ends with `LOOP_DONE:` or `LOOP_BLOCKED:` — in endless mode
`LOOP_DONE` is a routine every-iteration outcome, so this usually takes two or
three iterations — and while the delay is counting down, type `/compact`, and
then **type an ordinary question into the terminal too**, so that a turn is
already coming. (`hasPendingMessages()` is true only when a human typed into a
session that was already streaming; that is the whole premise of the path.)

**What to look for.**

1. **The ladder charges and announces first:** `Loop: goal reported done (#N);
   continuing with improvement work.` or `Loop: blocked reported … continuing
   with assumptions.`
2. **Then the deferral notice**, naming the holder, as in §AA.1.
3. **What the model is eventually sent must be the DIRECTIVE**, not `continue`.
   The injected loop message is displayed, so read it: an `improve` turn begins
   *"open IMPROVEMENTS.md … take the TOP open item"*; an `unblock` turn tells the
   model to document an assumption and carry on; a `continue` turn is the generic
   one. Before the fix, the deferred directive was parked in the loop's one timer
   slot and the next `agent_end` — which the pending message guaranteed within
   milliseconds — cleared it, so the operator was told the model had been given
   an instruction it never received.
4. **The control:** the same sequence with no `/compact`. The directive goes
   immediately, as a steer onto the turn that is already coming.

`u4` reproduces the whole sequence against the shipped module with real timers,
if the timing is hard to hit by hand:

```
   node --experimental-strip-types \
     context/testing/probes/u4-the-directive-that-was-charged-and-dropped.mjs
```

What neither probe can show is the one thing a live run would: whether the 27B,
handed the `unblock` directive after a compaction, actually documents an
assumption and carries on rather than asking again.
