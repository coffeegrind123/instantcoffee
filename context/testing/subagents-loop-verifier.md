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

## AC. Two people at once — the AI4/AI2 run

The eighteenth pass's two Matrix findings, and they share a setup: **two rooms
live in the same turn**, which is the ordinary case for a channel with two people
on it rather than a race. pi drains its follow-up queue inside one run, so two
messages that arrive while the bot is busy are consumed by ONE run and both rooms
are marked live.

Needs a Matrix account and two rooms — a DM and a room is enough, and they can
both be you if you have a second client. Nothing else: no loop, no subagent, no
verifier, no saturated context.

### AC.1 A tool reply with two rooms waiting — AI4

**This is the most serious thing on the unrun list**, because the failure sends
one person's answer to another and is not undoable.

1. Give pi something slow to do in the terminal — `/loop start …`, or just a
   question that takes a while.
2. **While it is working**, message the bot from room A, then a few seconds later
   from room B. Ask two clearly different questions, e.g.
   *"did the nightly build finish?"* and *"can you summarise the incident?"*
3. Ask something that makes the model reach for the `prinny` tool rather than
   just writing an answer. The tool description says it is for attachments,
   quote-replies, reactions, edits, history and search — so a good prompt is
   *"react to that with 👍"* or *"reply to that with the last 5 lines of the log
   as a file"*.

**What to look for.**

1. **The tool call comes back refused**, with a sentence the model can act on:
   `2 Matrix conversations are waiting in this turn, so I cannot tell which one
   this is for — nothing was done. Each of them is told at the end of the turn
   that an answer could not be attributed and to ask again, so do not retry this
   call.`
2. **Neither room receives anything from the tool.** Before the fix, whichever
   room messaged LAST received it — `lastInbound` is one slot, written on every
   arrival — regardless of which question the model was answering.
3. **At the end of the turn both rooms get AF1's retirement notice**:
   *"Someone else was being answered in the same turn and I could not tell which
   reply was yours, so I sent nothing rather than send you theirs. Please ask
   again."* That is the outcome the refusal restores: the tool and the forwarder
   now agree.
4. **The control, and it is the one that matters most**: do the same thing with
   only ONE room messaging. The tool call must work exactly as it always did.
   Then do it again with two rooms and an explicit `room_id` in the call — the
   model will not produce one on its own, so drive it from the terminal if you
   can — and it must still be honoured, because `history` and `search` on some
   other room have to stay possible.

`v4` reproduces the whole thing against the real extension and the real
registered tool, including printing which room `lastInbound` was pointing at:

```
   for m in two-rooms one-room explicit; do
     node context/testing/probes/v4-the-room-the-tool-guessed.mjs $m
   done
```

What only a live run can show is the thing the probe cannot model: whether a 27B,
handed that refusal, stops rather than retrying the call in a loop.

### AC.2 Two `/compact`s in one turn, and one that never runs — AI2

Same setup, no tool call needed.

1. Give pi something slow to do in the terminal.
2. **While it is working**, send `/compact` from room A and then `/compact` from
   room B.

**What to look for.**

1. **Both rooms get the receipt**: *"The session is mid-turn — I will compact as
   soon as it finishes rather than cutting it off."*
2. **When the turn ends, exactly ONE compaction runs** — that was never the
   defect and must not change. `Compaction guard: capped the summary…` appears
   once, and the terminal shows one compaction.
3. **BOTH rooms are told it happened**: *"Compacted the conversation context."*
   Before the fix only the second sender heard again; the first was told
   something would happen and then nothing, and because `deliverInbound` marks
   the entry `answered` the undelivered sweep could not report it either.

And the other half, which is one command:

4. Send `/compact` from one room while the bot is mid-turn, and then, **before
   the turn ends**, run `/prinny restart` in the terminal.
5. The room must be told: *"I said I would compact once the turn finished, and
   the channel is stopping before that happened, so it will not run. Nothing is
   waiting on my side; ask again once I am back."* Before the fix the request was
   dropped in silence, a few lines below the loop that denies every pending
   permission because *"the channel going away is not consent"*.

```
   for m in two-rooms stopping control; do
     node context/testing/probes/v2-the-compaction-two-people-asked-for.mjs $m
   done
```

### AC.3 A background answer, and then quitting — AI1

A third variant of §AB.1, and it is one keystroke more.

1. Start a background delegation, as in §AB.1.
2. Type `/compact` while the child is still working, and wait for the
   *"result held — … is compacting"* notice.
3. **Quit pi while it is still held.**

**What to look for.** One line, on the way out:

```
   [Subagent "Explore" <id>] result NOT delivered to the model — the session
   ended while the result was still queued for delivery. The answer is gone
   with it.
```

Before the fix the id was cleared out of the batch set and nothing was said at
all — not to the model, not to the operator, not to the log. Note what the
sentence does NOT say: it does not tell you to open `/agents`, because the
session that owns `/agents` is the thing that is ending. If the record had a
transcript (`outputTranscript`), the path is named instead.

Do this headless as well. `ctx.ui.notify` is `() => {}` outside a TUI, so the
`console.warn` beside it is the whole of what you get — and it is the reason
this is worth one line rather than none.

---

## AD. Who is allowed to ask — the nineteenth pass (AJ1–AJ5)

Two of these need a Matrix account and nothing else. Both are about a REFUSAL
that a person has to see, which is a shape nothing earlier in this script tests:
every other item asks whether the machine did something, and these ask whether it
declined and said so to the right person.

### AD.1 `/stack restart llama`, from a phone — AJ1

**Setup.** A configured channel (`/prinny status` says `connected`), and an
allow-listed account. Nothing else — no loop, no subagent, no verifier.

1. From the Matrix client, type `/stack` (the client's own `/` menu offers it,
   described as *"Show local model stack status"*).
2. Then type `/stack restart llama`.

**What to look for.**

```
   /stack                 → handed to the session; the terminal shows a
                            `stack-report` entry with the model, the slots and
                            the throughput. This is the form the menu advertises
                            and it still works.
   /stack restart llama   → the SENDER is told:
                            "/stack restart cannot be run from Matrix. Allowed
                             here: /stack status, /stack help. Ask me in ordinary
                             words instead: I can do read-only things with tools
                             and tell you the answer."
```

**Before the fix**, the second one was handed to pi and a modal appeared **in the
operator's terminal** reading *"Restart llama? … Expect roughly 20 minutes before
it answers again. Any in-flight request will fail."* — with nothing in it saying
a Matrix sender had asked. Answering yes recreates the container and takes the
model away for the length of a cold load. Answering the same question in a
headless session (`pi -p`) refused it silently, because pi's `noOpUIContext`
answers `confirm` with `false`.

**Then check the sentence that made it worth refusing**, in the terminal:

```
   /stack help
   → "The model can call stack_status to read the stack. It cannot change it:
      every mutation above is a user-only command on purpose."
```

That is still true, and it is now true of the third actor as well.

**And the half that must not have broken**: ask the bot, in ordinary words,
*"is the model up?"*. The model should call `stack_status` and answer on Matrix —
which is the route that actually reaches the sender, where a `/stack status`
writes a terminal entry the sender never sees.

```
   node --experimental-strip-types \
     context/testing/probes/w2-the-command-that-was-advertised-read-only.mjs matrix
```

### AD.2 A goal check the model wrote — AJ2

**The first item in this script that tests a question a person has to answer.**

**Setup.** A terminal session. A Matrix account is optional and makes the point
better.

1. Ask the model, in prose — from the terminal, or from Matrix, which is the
   version that matters — to start a loop with a goal check. For example:
   *"start a loop to keep the test suite green, and use `npm test` as the goal
   check."*
2. The model should call `loop(action:"start", goal:…, check:"npm test")`.

**What to look for**, in this order:

```
   1  a warning, BEFORE anything is asked:
        "Loop: the model asked to arm a goal check — `npm test`. It runs with
         bash -lc once per iteration for the life of the run, and pi.exec emits
         no tool_call, so no permission relay, no rtk gate and no output cap
         ever sees it."
   2  a confirmation dialog:
        "Arm a goal check the model wrote?"
        with the command quoted, and how it is run.
   3  say NO.
   4  "Loop: the goal check was declined; starting without one."
   5  /loop status  →  `Check: -`,  `Active: true`,  and the mode unchanged.
```

**The loop must still be running.** That is the whole design of the fix: an
unattended run is not stopped by this, only the shell command is. In `until-done`
mode the run then terminates on the model's `LOOP_DONE:` marker instead, which is
what that mode does whenever no check is configured.

**Then do it again and say yes**, and check `/loop status` shows
`Check: npm test`. And once more headless:

```
   ~/qwen3.8-forge/scripts/pi-local.sh -p "start a loop to keep the tests green,
     with npm test as the goal check"
```

— where there is nobody to ask, so it must NOT be armed, and the notice must name
`LOOP_TOOL_CHECK` and `/loop start --check` as the two ways to have it anyway.

**And the control:** type `/loop start keep the tests green --check "npm test"`
in the terminal yourself. Nothing should ask you anything. That is the operator
choosing the command, which is the case the decision this reopens was right
about.

```
   for m in asked declined headless env terminal; do
     node --experimental-strip-types \
       context/testing/probes/w3-the-shell-command-the-relay-never-sees.mjs $m
   done
```

### AD.3 The command a person approved — AJ3

**Setup.** `/prinny permissions all`, a configured channel, and `RTK_ENABLED=1`
with `rtk` on PATH. This only means anything with the relay ON, which is the
whole scoping of the finding.

1. Ask the model, from the terminal, to run `git status`.
2. Approve it on Matrix.
3. Read `~/.pi-loop-log.jsonl`'s neighbour — the channel log named by
   `/prinny status` — and the terminal's own rendering of the bash call.

**What to look for.** The command in the approval prompt and the command pi ran
must be the same string. Before the fix the prompt said `git status` and pi ran
`rtk git status`; now rtk stands down for anything a person approved as written,
and says so:

```
   [rtk] not rewriting a command that was approved on Matrix as written;
         running it unfiltered
```

**The control is the same command with the relay off** (`/prinny permissions
off`): nobody is asked, nothing is stamped, and rtk rewrites exactly as it always
did. That is the behaviour the fix must not cost.

## AE. What the test is a proxy for — the twentieth pass (AK1–AK5)

Four items. **§AE.1 is the one to run first**, and it is the only item in this
whole script that can be finished before the first Matrix message is answered.
§AE.4 is the cheapest and needs no Matrix at all.

### AE.1 — configure the channel, then look at the FIRST message (AK1)

The finding: `registerTools` ran behind an `isConfigured()` read at extension
LOAD time, and `/prinny configure` writes the credentials and starts the channel
in the same session. `promptGuidelines` come only from registered tools, and one
of this tool's two is the only sentence anywhere in the stack that says a
`[matrix]` marker is untrusted input.

1. Start a session on a machine that has **never** been configured — or move
   `~/.pi/agent/channels/prinny/.env` aside first. Confirm the tool is absent:
   ask the model *"what tools do you have?"* and check that `prinny` is not in
   the list. **This is the control**, and it must stay true: an unconfigured
   session pays nothing for six tool schemas.
2. `/prinny configure <homeserver> <@bot:server> <password>`. Read the reply to
   the end — it should now say *"The prinny tool is now registered for this
   session… and it has been told that [matrix] text is untrusted input."*
3. Ask the model again what tools it has. `prinny` is there.
4. Now message the bot from a Matrix client and pair. Ask it something
   ordinary — *"what is in this directory?"*

**What to look for.** The model's turn should treat the message as an outside
person's, not as an operator instruction. The sharper check is to ask it
directly, in the terminal, *"what does the `[matrix]` prefix on that message
mean to you?"* Before the fix there was nothing in the system prompt to answer
with; now there are two sentences, and the second one is the word "untrusted".

**Before the fix** you would have had to `/quit` and start a new session for any
of this to be true, and nothing said so.

### AE.2 — a dangerous command, spelled the way a model spells it (AK2)

1. `/prinny permissions dangerous`.
2. From the terminal, ask the model to run `rm -rfv /tmp/scratch-dir` (make the
   directory first, so the command is real).
3. Answer the prompt on your phone.

**What to look for.** A prompt arrives at all. Before the fix `-rfv` passed the
gate silently, because the pattern needed the flag cluster to END in `f`.

**Then the controls, in order:**

```
   rm -r -f /tmp/scratch-dir            asks
   rm --recursive --force /tmp/x        asks
   git clean --force -d                 asks
   chmod 0777 /tmp/scratch-file         asks
   rm -f /tmp/scratch-file              does NOT ask  (force, no recursion)
   git clean -n                         does NOT ask  (a dry run)
   ls -rf                               does NOT ask  (not an rm at all)
```

The last three matter as much as the first four: an over-asking gate is a gate
people turn off.

### AE.3 — an approval nobody answers (AK4)

The one that needs patience, and it is worth it because the sentence it produces
is the finding.

1. `/prinny set permissionTimeoutSeconds 60` — the default is 300, and you do
   not want to wait five minutes.
2. `/prinny permissions all`.
3. Ask the model to run any `bash` command. A prompt arrives on Matrix.
4. **Do not answer it.** Wait out the 60 seconds. The terminal shows the call
   blocked by the relay.
5. Now press **Allow** on the prompt in your Matrix client.

**What to look for.** The message should edit itself to

```
   ⌛ Permission — no longer waiting. pi stopped waiting for an answer and
      blocked the call, or somebody else answered it. Nothing was run.
```

**Before the fix it said `✅ Allowed`** — for a command that had already been
blocked, in the only lasting record of the decision anyone would ever read.

Set `permissionTimeoutSeconds` back afterwards.

### AE.4 — the audit nudge, on a project with a passing suite (AK5)

No Matrix needed, and it is the one that is most likely to change how a real run
behaves.

1. In a project with a test suite that passes, start
   `/loop start tidy up the docs. Done when: nothing is left --check "npm test"`
   — or whatever the suite command is.
2. Let it run at least nine iterations while it is doing analysis rather than
   editing (asking it for a plan first is a reliable way to get that).

**What to look for.** On the ninth iteration:

```
   Loop: no concrete progress for 8 iterations — requesting tangible output.
```

**Before the fix that could not happen on this project at all**, because
`npm test` prints `42 passed` and the word `passed` counted as a change to the
project — every iteration, forever.

**The control** is the same loop while it is genuinely editing files: the nudge
must not fire, and `/loop status` should show the iteration count climbing with
no interventions.

### AE.5 — and while you are there: watch the transcript

Not a finding — the change §5.7 of the write-up describes, which has never been
seen in a live TUI.

1. In any session, ask the model to delegate something small: *"use a subagent
   to find every call site of X"*.
2. Watch the transcript as the child runs.

**What to look for.** Entries headed `subagent <shortId> <type> · turn N`,
dimmed, between your own turns — the brief first, then a turn per child turn,
then the verifier's prompt and reply, then a closing line with the status and
the counts. `ctrl+o` expands them.

**Then the two checks that matter.** `/agents` → the agent → the short id in the
header is the same one the entries carry. And ask the model, right afterwards,
something that depends on the child's *reasoning* rather than its answer — it
should not know, because a `type: "custom"` entry is never sent to the model.
That is the property the whole design rests on, and it is the one thing here a
person can check that a probe cannot.

---

## AF. What we start and never finish — the twenty-first pass (AL1–AL9)

Six items. Four of them can be done with nothing but a terminal; two need a
Matrix account. They are ordered cheapest first, and every one of them is
something a probe cannot reach: what a person actually SEES.

### AF.1 — the follow-up that replayed the run before it (AL1)

The cheapest unrun item in the whole script, and it doubles as §AE.5's rerun.

1. Ask the model to delegate something small: *"use a subagent to find every call
   site of X"*. Let it settle.
2. `/agents` → the record → **Steer**, and ask a follow-up:
   *"now list only the three that pass a relative path"*.
3. Read the transcript entry the follow-up produces.

**What to look for.** The entry headed `subagent <shortId> … · turn 1` for the
follow-up must open with the follow-up's own work. **Before the fix it opened
with the first line of the run that had already finished**, and the answer to the
follow-up was in the `dropped` count at the bottom.

**Why a person is needed.** The symptom is indistinguishable from a long answer
that was truncated, which is exactly why nothing about it looked like a replay.
A test can assert the anchor; only a reader notices that the text is from the
wrong run.

### AF.2 — the footer after `/loop end` (AL8)

Ten seconds, and it needs no model at all.

1. `/loop start improve the parser` — let one iteration run, or don't.
2. Look at pi's footer. There is a `loop` pill.
3. `/loop end`.
4. Look at the footer again, and then run `/loop status`.

**What to look for.** The pill should be **gone**. Before the fix it said
*"Loop ended"* for the rest of the session while `/loop status` said
`Active: false · Goal: -` — the two disagreeing, with the footer being the one
nobody has to ask.

**The control**, in the same minute: `/loop start …` then `/loop stop`. The pill
must STAY, saying "Loop stopped", because that loop still exists and
`/loop resume` acts on it. Twenty-nine of the thirty pills are like that; `end`
is the only one that had to go.

### AF.3 — the widget stops polling (AL5)

Needs nothing but patience and, ideally, a `top`.

1. Delegate something. Watch the widget appear.
2. Let it finish, and leave the session idle past the finished-row retention
   window (`/agents` → settings shows it; the default is minutes).
3. Watch the widget's rows disappear.

**What to look for.** Nothing visible — which is the point. What changed is that
an 80 ms interval, sorting every record the manager has ever held, **stops** when
the last row goes. Before the fix it ran for the rest of the session and got
slower every delegation.

**The check that matters is the re-arm**, and it is the half of the fix that can
break silently: after the widget has gone, **delegate again**. The widget must
come back. And then the harder one — `/agents` → a settled record → **Steer**.
That is a continuation, not a spawn, and it is the one route back into "there is
something to draw" that does not go through `spawn()`. The widget must come back
for that too.

### AF.4 — the rescue turn on a model that is not loaded (AL2)

The most interesting item in this section, and the one nobody has run.

1. `/stack` — note which models are actually loaded in llama-server.
2. Start a loop with a rescue model that is **not** one of them:
   `/loop start <a goal the model will fixate on> --rescue-model <not-loaded>`
3. Let it go stuck three times in a row. The notice reads
   *"Loop: stuck 3x — rescue turn with <model>"*, and `/loop status` shows the
   model has changed.
4. Watch what happens next.

**What to look for.** The rescue turn will produce nothing, because the model is
not there. The loop should say *"model error, retrying"* — and `/loop status`
must show the session back on the loop's own model **before that retry
happens**. Before the fix all ten retries, and the pause at the end of them, ran
on the model that could not answer, and the session stayed on it afterwards.

**Then the one that cannot be undone.** Get back into a rescue turn, and this
time type `/loop end`. The session must be back on the loop's model. That command
runs `state = defaultState()`, which destroys the only record of what to go back
to, so if the stand-down does not happen above that line it can never happen.

**Cost of getting it wrong**: every subsequent turn the operator types is on the
rescue model, silently, for the rest of the session.

### AF.5 — the typing indicator when the channel stops (AL6) — needs Matrix

1. From Matrix, ask something that will take a while. The bot shows *typing…*.
2. In the terminal, while it is still typing: `/prinny stop`.

**What to look for.** The indicator in the room should stop **immediately**.
Before the fix nobody was sent `typing: false`, so it kept showing for up to
another 20 seconds — Matrix's own timeout — and the last thing you saw of a
session that had ended was a bot that appeared to still be writing.

**The other half**, which is quieter: `/prinny log` afterwards should not be full
of failed `typing` calls. The 8 s refresh used to keep firing at a sidecar that
was gone.

### AF.6 — the undelivered sweep stops sweeping (AL4) — needs Matrix

Hard to see directly, so this is the indirect version.

1. From Matrix, send `/loop status`. You get *"Handed `/loop status` to the
   session…"* — a command this extension answers itself.
2. Do nothing else for a few minutes.

**What to look for.** Nothing. Specifically: you must **not** get, a minute
later, *"I could not hand that to the session … please send it again"* — that is
AC4, fixed long ago and still holding.

What AL4 changed is invisible from the room: before it, that one command armed a
30 second interval that ran for the rest of the session with nothing to do, over
a map that only grows. The place to see it is `/prinny log` — there should be no
periodic activity after the message is answered.

**The real test of the sweep is still §O**, and it is unchanged: send a message
while pi is compacting, and check you are told it could not be handed over. AL4
must not have broken that, and the suite says it has not.

---

## §AG — the twenty-second pass (AM1–AM6): what happens while we are waiting

Six items. **Three need only a terminal**, one needs Matrix, one needs a
saturated context, and one is ten seconds with no model at all.

The axis is "what else can run at this `await`", so every item here is a matter of
doing two things at once on purpose — which is what makes them hand-testable and
what makes them the ones a suite cannot reach.

### AG.1 — `/prinny restart` while the channel is still starting (AM1) — terminal only

This is the cheapest of the six and the one most likely to have bitten somebody
already.

1. Start a session with prinny configured, so `session_start` fires
   `void startChannel()`.
2. **Within the first ~30 seconds**, before `/prinny status` says `connected`,
   run `/prinny restart`.

**What to look for.**

- `/prinny status` during step 2 should say **`starting (sidecar handshake in
  progress)`**. Before AM1 it said `not running`, which is the honest-looking
  answer at exactly the moment you are most likely to ask.
- `/prinny log` after the restart should contain **`stopping a sidecar that was
  still starting`**, and then a *second* `sidecar handshake complete`. Before
  AM1 the stop did nothing and the restart was handed the first start's promise,
  so it reported that one's outcome as its own and no second sidecar was ever
  built.

**Cost of getting it wrong.** Two sidecars on one Olm crypto store, which
`server/src/state.ts` says must never happen — and a `/prinny configure` in that
window that reports success while the channel keeps using the old credentials.

The same shape with `/prinny stop`: run it during the handshake, then
`/prinny status`. It must stay stopped.

### AG.2 — the compaction lock covers pi now (AM2) — needs a saturated context

The most interesting unrun item in this section, and the one nobody has watched.

1. Get a session over pi's compaction threshold — an hour of real work, or
   `/stack set CTX_SIZE …` down and a few large `read`s.
2. Start a background delegation:
   `Agent(prompt: "…", run_in_background: true)`.
3. While it is running, **type something into the terminal** — anything. That is
   `prompt()`, which runs `_checkCompaction` BEFORE the run, with the session
   reading as idle.

**What to look for.** If the delegation settles inside that window you should see
one of:

```
   [subagents] holding <id> (<type>) — pi is compacting
   Loop: pi is compacting — holding iteration N until it finishes
```

Before AM2 neither could happen: the lock had two writers and pi was not one of
them, so the nudge went into the compaction and started a whole agent run built
from a copy of the pre-compaction context.

**The control, and it matters more than the finding**: a `/loop` running while a
SUBAGENT compacts must NOT defer. A child's compaction is not the parent's
business, and the lock is process-global — that is the one thing AM2 had to get
right. Watch a long delegation compact (its record's `compactions` count in
`/agents`) and check the loop keeps iterating.

### AG.3 — a session swap during a compaction (AM4) — terminal only

1. Start a loop on a saturated context, so it enters its context ladder:
   `/loop start <goal> --until-done`.
2. Wait for *"Loop: pi did not recover the context itself — running emergency
   compaction."*
3. **While the compaction is running**, press `Esc` — or run `/new`.

**What to look for.** Nothing at all from the loop afterwards. Specifically, no

```
   Loop: context recovery stalled (…) — cooling down 60s
```

for a run that has been replaced. Before AM4 the callback fired — a session swap
CANCELS the compaction, which is what makes pi throw — and it charged the newly
restored run's cooldown ladder before throwing `assertActive` out of a callback
pi invokes from a `void`ed async IIFE.

**How you would know it went wrong**: an unhandled rejection in the terminal, or
a fresh loop that reports `cooldown 1/3` on its first iteration.

### AG.4 — a delegation's answer at `session_shutdown` (AM5) — terminal only

1. `Agent(prompt: "sleep for a bit then answer", run_in_background: true)`.
2. Before it settles, `/new`.

**What to look for.** A warning naming the agent:

```
   [Subagent "<type>" completed] result NOT delivered to the model (…)
```

Before AM5 you got **silence**: `dispose()` cleared the one-shot that says the
answer is owed, one statement before `AgentManager.dispose()` ended the run that
would have reported it.

### AG.5 — the verifier at `session_shutdown` (AM3) — needs a model, ~1 minute

1. `Agent(prompt: "answer in one sentence: what does decodeFrame do?")` in the
   FOREGROUND, with `SUBAGENT_VERIFY_ROUNDS=1`.
2. The moment the child finishes and the widget row says **`checking`**, run
   `/new`.

**What to look for.** The tool result, if you can still see it, or the transcript
entry. It should carry

```
   [verification: the check did not complete, so this answer went out unchecked.]
```

and **not**

```
   [verification: this answer was checked against the task and did not address
    it … Treat it as unreliable.]
```

That second sentence is what a torn-down check used to produce, and it is a claim
about the CHILD rather than about the check. A disposed `AgentSession` still
accepts `prompt()`; it is simply no longer subscribed to its agent, so the repair
spent a model call and came back with nothing.

Timing is tight. `z3 answer` prints both sentences without a model if you only
want to see the difference.

### AG.6 — ten seconds, no model, no Matrix

```
   cd context/testing/probes
   for m in stop restart clean fail;        do node --experimental-strip-types z1-… $m; done
   for m in parent child extension release; do node --experimental-strip-types z2-… $m; done
   for m in order answer clear;             do node --experimental-strip-types z3-… $m; done
   for m in swap shutdown live;             do node --experimental-strip-types z4-… $m; done
   for m in gate deadlines oneshot;         do node --experimental-strip-types z5-… $m; done
```

Seventeen runs, all under a second each. `z3 answer` and `z5 deadlines` are the
two worth reading even if you run nothing else: the first prints the two
sentences a parent model receives, the second prints 4,900 ms against 200 ms.

---

## §AH — the twenty-third pass (AN1–AN7)

Seven items. Four need only a terminal; two need a model; one needs a Matrix
account and is the most interesting unrun thing on this list.

### AH.1 — break a config on purpose (AN1) — terminal only, 2 minutes

The one to do first, because it is the finding with the widest blast radius and
the operator-facing half has only been read, never seen.

```
   cp ~/.pi/agent/subagents-lite.json /tmp/keep.json     # you will want this
   # delete ONE comma with an editor, or:
   python3 - <<'P'
   import io; p="/home/claudeuser/.pi/agent/subagents-lite.json"
   s=io.open(p).read(); io.open(p,"w").write(s.replace('",\n', '"\n', 1))
   P
   ./scripts/pi-local.sh
```

**What to look for, in order.**

1. At startup, a **warning notice**:
   `[subagents] The global config could not be read (…) — running on defaults.
   Fix it before changing anything in /agents: the next save keeps the old file
   as <name>.corrupt-<time> and starts fresh.`
2. `/agents` → any toggle. Then, in another terminal:
   `ls ~/.pi/agent/subagents-lite.json*` — there must be a
   `.corrupt-<timestamp>` sibling, and `diff` it against `/tmp/keep.json`: it is
   the broken file, byte for byte.
3. The live file now holds the defaults plus the one key you toggled. That is
   correct and is why the quarantine exists.

Before AN1 step 1 printed nothing and step 2 left no sibling: the only copy of
your settings was gone.

**The prinny half**, if the channel is configured: break
`~/.pi/agent/channels/prinny/pi.json` the same way and run `/prinny status`. The
line to look for is

```
   settings:     UNREADABLE (…) — running on DEFAULTS, permissionMode off. …
```

and the thing to notice is that `permissionMode off` means the Matrix approval
relay is not running, whatever the file says.

### AH.2 — `/prinny prepare`, which is now a blocker (AN2) — needs a working npm

This is the item that changed state this pass. Before it, a stale runtime was
invisible; now it refuses.

```
   node vendor/prinny-channel/server/bin/prinny-channel.mjs --staged ; echo "exit=$?"
```

On this box, today, that prints `stale` and exits 1. Then:

1. `/prinny status` → `runtime:      STALE — built from different sources; run
   /prinny prepare`.
2. `/prinny start` → refuses, with *"the channel runtime was built from a
   different version of the sources"* rather than starting and timing out.
3. `/prinny prepare` → about a minute. **It has not been run since AL3 and this
   box has no answer from `npm ping`, so it may fail** — and if it does, the
   error and how far it got are the useful part.
4. `--staged` again → `current`, exit 0. `/prinny status` → `built, current`.

**What this is really testing** is the thing nobody has seen: the sidecar
running AL3's `connect.ts`, i.e. a connect loop that discards the client it
built when an attempt fails. To see it, stop the homeserver (or point
`PRINNY_HOMESERVER` at a dead host) and watch `/prinny log`: the retries should
say `could not stop the client from attempt N` or nothing at all, and the
process should not grow one Matrix client per attempt.

### AH.3 — rotate a token by hand (AN3) — needs a Matrix account

The only item here that touches a real homeserver, and the one that would have
caught AN3 in the wild.

1. `/prinny status` — note the device the bot is on (or read `PRINNY_DEVICE_ID`
   in `~/.pi/agent/channels/prinny/.env`).
2. Mint a **new** access token for the same account from a Matrix client, on a
   NEW device.
3. `/prinny configure token <the new token>`.
4. `grep PRINNY_DEVICE_ID ~/.pi/agent/channels/prinny/.env` — **there must be no
   line**. That is the fix.
5. `/prinny restart`, then `/prinny log`: look for
   `resolved device <ID> from the access token`, and check the ID is the new
   device rather than the one from step 1.
6. Message the bot from an encrypted room. It should answer.

Before AN3, step 4 left the old device id, step 5 printed nothing (the lookup was
skipped), and step 6 was where it went wrong — with nothing in the log, which is
the symptom `server/src/state.ts` warns about in its own words.

### AH.4 — a switch that now works (AN4) — terminal only

```
   echo 'SUBAGENT_TRANSCRIPT=0' >> .env
   ./scripts/pi-local.sh
```

Delegate anything, then scroll the transcript: there should be **no**
`subagent <id> <type> · turn N` entries. Remove the line, restart, delegate
again: they come back.

Before AN4 the line in `.env` did nothing at all, and the only spelling that
worked was `SUBAGENT_TRANSCRIPT=0 ./scripts/pi-local.sh` — which works because
`env_get` reads an exported variable before it reads the file, not because
anything forwarded it.

The same check for `SUBAGENT_VERIFY_LOG=0`: `wc -l
~/.pi/agent/subagent-verify.jsonl` before and after a verified delegation.

### AH.5 — the session file stops growing as fast (AN5) — needs a loop

```
   wc -c ~/.pi/agent/sessions/--$(pwd | sed 's|^/||; s|[/:]|-|g')--/*.jsonl
```

Run a short `/loop start … --max 5`, then measure again, then:

```
   node --experimental-strip-types context/testing/probes/aa5-…mjs session
```

The `identical` column for the session you just ran should be **0**. Before AN5
it was two of every five entries on a real run, and each is ~6.6 KB.

### AH.6 — a spawn that fails, and says why (AN6) — needs a model, 1 minute

1. Write `~/.pi/agent/agents/broken.md` with frontmatter that names an extension
   that does not exist:

   ```
   ---
   name: broken
   description: for testing
   extensions: not-a-real-extension
   ---
   Answer in one word.
   ```
2. `Agent(agent: "broken", prompt: "hello")`, and press **Esc** while it is
   still setting up (or set a parent turn to abort).

**What to look for.** The warning still arrives:
`[pi-subagents-lite] extension "not-a-real-extension" not found in loaded
extensions`, on the console and in the TUI. Before AN6 a spawn that ended in a
throw discarded it, which is the run most likely to have been caused by the
thing the warning is about.

Headless is the other half: `pi -p` the same delegation and look at stderr.
Before AN6 there was nothing there either, because pi's headless `notify` is a
real function and the `console.warn` arm was unreachable.

### AH.7 — twenty-one runs, no model, no Matrix

```
   cd context/testing/probes
   for m in subagents prinny absent;  do node --experimental-strip-types aa1-… $m; done
   for m in staged live absent;       do node aa2-… $m; done
   for m in rotate first switch;      do node --experimental-strip-types aa3-… $m; done
   for m in table effect;             do node --experimental-strip-types aa4-… $m; done
   for m in live session swap;        do node --experimental-strip-types aa5-… $m; done
   for m in abort headless clean;     do node --experimental-strip-types aa6-… $m; done
   for m in relocated default live;   do node --experimental-strip-types aa7-… $m; done
```

Twenty runs, all under a second except `aa1 subagents` (three node processes).
`aa2 live` and `aa5 session` are the two worth reading even if you run nothing
else: the first tells you whether this box's sidecar is running the code in this
checkout, and the second tells you how much of your session files is loop state
that said nothing.

---

## §AI — the twenty-fourth pass (AO1–AO9)

Nine items. **Four need only a terminal**, one needs a live model turn, one needs
a phone, one needs a second Matrix account, and two are the operator-facing
halves of findings whose sentence only exists in the TUI.

Written 2026-08-23, after the fact: §13.3 of
`design/subagents-loop-verifier-identity.md` and `HANDOFF.md` — two documents, in
three places — referenced "§AI of the hand-testing script" as though it existed,
and it did not. **That is this series' own shape one level up**: three readers of
a fact, and the fact was never written. The items below carry what was
actually run rather than what was planned, and each says which.

The axis is sameness: two values in one function, and an operator that has to say
whether they are the same thing. So every item here is *say the same thing twice,
in two spellings, and see whether the stack agrees with itself.*

### AI.1 — the id `AgentStatus` printed, handed to `StopAgent` (AO1) — needs a live model turn

**RUN 2026-08-23**, headless, against the local model on the one llama slot, with
a real control run. This is the item the twenty-fourth pass called the cheapest
of its three unseen ones and it is the one that mattered most, because AO1 is on
the tool that stops a run holding the slot the parent's own next call is queued
behind.

```
   ./scripts/pi-local.sh -p "$(cat <<'P'
   Do these four steps in order, using tools. Do not skip any.

   1. Call the Agent tool with run_in_background set to true, description
      "slow counter", and prompt: "Run exactly this one bash command and report
      its output: for i in $(seq 1 400); do echo $i; sleep 1; done"
   2. Call AgentStatus. It prints one line per running agent, and each line
      starts with a short agent id.
   3. Call StopAgent with agent_id set to EXACTLY the short id that AgentStatus
      printed in step 2. Use that short string verbatim. Do NOT use the longer
      id that the Agent tool returned in step 1.
   4. In your final answer report, on separate lines: the exact agent_id string
      you passed to StopAgent, its character count, and the first line of the
      text StopAgent returned.
   P
   )"
```

The child spends its whole life inside one `bash` call, so it does **not** hold
the model slot and the parent's `AgentStatus` and `StopAgent` turns run
immediately. A child that counted in the model would make this a ten-minute test
instead of a ninety-second one.

**NOW — what happened**, from the session transcript
(`~/.pi/agent/sessions/--home-claudeuser-qwen3.8-forge--/*.jsonl`, which records
every tool call with its arguments and is the evidence here, not the final text):

```
   Agent          → "Agent ID: 3ced427a-8a6c-41b"      ← the full seventeen,
                                                          the one surface that
                                                          always carried it
   AgentStatus    → "3ced427a (general-purpose) running"
   StopAgent {agent_id: "3ced427a"}
                  → "Stopped agent 3ced427a"
```

Eight characters in, resolved, and the answer names the agent in the same eight
it accepts. One `StopAgent` call, no retry.

**BEFORE — the control run, on the same box, same prompt.**
`executeStopAgentTool`'s one resolution line was put back to its pre-AO1 form
(`getRecord(requestedId)`, an exact `Map` lookup on the seventeen) and the
delegation was run again:

```
   AgentStatus    → "cbc6575f (general-purpose) running"
   StopAgent {agent_id: "cbc6575f"}
                  → "Agent cbc6575f not found. Running agents: cbc6575f (general-purpose)"
   StopAgent {agent_id: "cbc6575f"}      ← the model retried the identical id
                  → "Agent cbc6575f not found. Running agents: cbc6575f (general-purpose)"
   StopAgent {agent_id: "cbc6575f-2265-4d7"}
                  → "Stopped agent cbc6575f"
```

**Read the refusal twice.** It rejects `cbc6575f` and then lists `cbc6575f` as a
running agent, in the same sentence. The model's own recorded reasoning was *"the
short ID is not being accepted… maybe I'll retry the short ID once more — it
might be temporary"*, and it retried before falling back. It escaped only because
pi's `Agent` result had carried the full seventeen **in the same conversation** —
which is exactly why every hand test of `StopAgent` before this one passed, and
why a model that is handed a session, or reads the id off `AgentStatus` after a
compaction, has no way out at all.

Restore the line afterwards and check the hash, not the diff:
`sha256sum src/agents/tool-execution.ts`.

### AI.2 — a named tool, a mode that is off, and the wrong case (AO2) — needs a phone

**Unseen.** The one branch of `needsApproval` that can be the only gate in force.

```
   /prinny set permissionMode off
   /prinny set permissionTools bash,Read
```

then make the model run a `bash` call. The relay must fire on the phone even
though the mode is `off`, because naming a tool is the more specific instruction.

The case is the finding: pi's built-ins are lower-case and this repo's own tools
are not, and `permissionTools` was matched with an exact `includes`. So the
second half is the test — set it to `BASH,read` (or `Bash`), and the relay must
still fire. Before AO2 an operator who typed the tool name the way the README
prints it got silence and no way to tell silence from *approved*.

**The half that needs no phone**, in a TUI (a `-p` run prints no slash-command
result at all — see AI.6):

```
   /prinny set permissionTools bash,Bash,BASH
```

must echo **one** entry, plus the sentence *"Matched ignoring case, so `Bash`
and `bash` are the same tool."* The de-duplication is `parseSetting` asking the
same question the gate asks; without it the operator is shown a list whose
length is a false claim about how many tools are gated, and without the sentence
there is no way to see the matching rule from outside.

### AI.3 — two allowlisted senders, one turn, one word (AO3) — needs a second Matrix account

**Unseen**, and it is the finding the ledger calls the instructive one: both sides
of the compare are ours, and the CONTENT is chosen by a stranger.

Two allowlisted senders DM the bot the same short word — `hi` — inside one turn.
**Both must be answered.** `markLive` matches pi's echo against
`entry.injected.trim()`, the whole rendered string, and `renderInboundMessage`
drops `room_id`, `message_id` and `user_id`; in a DM it drops `from=` too. So two
people who type the same word render to the same string, and the first entry in
`awaitingReply` is marked live for a message it did not send.

The proxy is not injective. Nothing fails; one person is simply answered twice
and the other never.

### AI.4 — two messages in one millisecond (AO4) — needs a second sender or a clock

**Unseen live.** The outbox watermark answered *"have I delivered this?"* with
*"is this from an instant I have already passed?"*, and `origin_server_ts` is set
by the **sender's** homeserver. Two events in the same millisecond, or a room on a
homeserver whose clock is behind ours, and the second one is dropped with no
error anywhere.

Probe `ab4` drives all three shapes with no Matrix at all, and it is the honest
substitute — the live form needs two federated homeservers with disagreeing
clocks, which this box does not have.

### AI.5 — hand-edit the sidecar's sources and run its suite (AO5) — terminal only

**RUN 2026-08-23.** The first time AO5's guard was seen firing against a real
hand-edit rather than a fixture.

```
   edit          MAX_REMEMBERED_IDS 200 → 300 in server/src/queue.ts
   fingerprint   d4ba6997… → 51bf8894…, stamp unchanged   → `stale`
   npm test      exit 1 · 508 tests · 432 pass · 76 FAIL
   revert        the same bytes back → `current`, WITHOUT a --prepare
   npm test      550 · 550 pass · 0 fail
```

**76 of 508, not all of them** — only the suites that call `loadServerModule`,
which is the honest blast radius. And an edit plus its revert costs no
`--prepare`: the stamp is a content hash, so putting the bytes back restores
`current`. That is the difference between this and an mtime, and it is why an
experiment in the sidecar is cheap as long as it ends where it started.

### AI.6 — pair a code that is a property of every object (AO6) — terminal only, TUI for the sentence

**Half-run 2026-08-23.** With `PRINNY_ENABLED=1`:

```
   /prinny pair constructor
```

**What to look for, and where.** The sentence is a notice, and pi's notice sink
is `() => {}` headless — a `-p` run prints nothing and writes no session file, so
the sentence itself needs a TUI. What *is* observable from a terminal is the
effect, and it is the half with teeth:

```
   cat ~/.pi/agent/channels/prinny/access.json
```

`allowFrom` must be **unchanged**. Measured here: unchanged. Before AO6, `pair`
found an "entry" on the prototype, read `undefined` off it for `senderId`, found
`undefined < now` false so not expired, pushed `undefined` onto the allowlist —
where it serialises as a JSON `null` — deleted nothing, and reported *"paired
undefined. They can now reach this session."*

The same shape for `/prinny deny toString`, which reported removing a pairing
that never existed. Probe `ab6` drives all five sites through the real store.

### AI.7 — a relocated agent directory and a subagent's skills (AO7) — needs a model

**Attempted 2026-08-23, and the first recipe was wrong. Still unverified — but
the reason is now known, and it corrected the finding.**

The recipe this section shipped with was:

```
   PI_CODING_AGENT_DIR=<dir> ./scripts/pi-local.sh
   # a skill in <dir>/skills, none in ~/.pi/agent/skills
   # delegate, ask the child to list its skills
```

**It does not test anything.** Run for real, with `skill-loader.ts` reverted to
its pre-AO7 hardcoded path, the child answered `relocated-marker` — *the same as
the fixed column*. A control that cannot fail, again, and this time in the recipe
rather than in the suite.

**Why**, measured rather than guessed: a child's ordinary skill discovery is pi's
`DefaultResourceLoader`, built at `agents/agent-runner.ts:544` with
`agentDir: getAgentDir()` — **pi's own function, which honours the override**.
`skill-loader.ts` is only reached by `preloadSkills` and `loadSkillMeta`, which
run only for an agent whose frontmatter *names* its skills. A default
`general-purpose` child cannot reach the code AO7 fixed.

**The recipe that does reach it.** In the relocated directory, an agent that
names the skill:

```
   <dir>/skills/relocated-marker/SKILL.md      name: relocated-marker
   <dir>/agents/skill-lister.md                skills: relocated-marker
```

```
   ---
   name: skill-lister
   description: Lists the skills it was given by name.
   skills: relocated-marker
   ---
   List every skill you can see, one skill name per line, and nothing else.
   If you can see none, answer exactly: NONE
   ```

Then `Agent(agent: "skill-lister", prompt: "list them")`.

**What to look for.** NOW: `relocated-marker`. BEFORE (root 3 of `loadAllSkills`
put back to `join(homedir(), ".pi", "agent")`): the child is handed
*"(Skill "relocated-marker" not found in .pi/skills/, .agents/skills/, or global
skill locations)"* for a skill sitting in the operator's real skills directory.

**Note this needs AO10's fix to run at all** — before it, the launcher wrote
`models.json` into `~/.pi/agent` while pi read the relocated directory, so a
relocated session had no model provider. See §AI.10.

### AI.10 — a relocated install has a model at all (AO10) — terminal only

**RUN 2026-08-23**, and it is the finding AI.7 walked into.

```
   pi --list-models | grep forge                                    # the control
   PI_CODING_AGENT_DIR=<dir> ./scripts/pi-local.sh --install-only
   PI_CODING_AGENT_DIR=<dir> pi --list-models | grep forge
```

**Run the control first and in the same minute.** "No `forge`" is worth nothing
until the same command with the override unset has been seen finding it —
otherwise a typo in the invocation reads as the finding.

```
   BEFORE   wrote ~/.pi/agent/models.json          ← pi does not read this
            PI_CODING_AGENT_DIR=… pi --list-models → nothing
   NOW      wrote <dir>/models.json
            PI_CODING_AGENT_DIR=… pi --list-models → forge  qwen3.8-27b
```

`scripts/pi-local.sh` asked where pi's agent directory is in four places and
answered two ways: `PI_DIR` — which receives `models.json` **and**
`settings.json` — ignored the override, while the prinny state path and the MCP
adapter path honoured it. Worse than the AN7/AO7 instances, which made a
relocated install read an empty directory and fall back to a default: this one
left pi with no provider for the local model, which is the single thing the
launcher exists to arrange.

The rule now lives once per language — `agent_dir()` in `scripts/lib.sh`,
`agentDir()` in `vendor/pi-subagents-lite/src/agent-dir.ts` — and probe `ab10`'s
`rule` mode compares them value for value, including the `"  "` case where pi
means *a relative directory* and not *unset*.

### AI.8 — a worktree of your own repository, reached through a symlink (AO8) — terminal only

**RUN 2026-08-23**, on real git (2.39.5, this container). The load-bearing fact
is what git actually prints, so the fixture is a real repository and not a fake:

```
   mkdir gitfix && cd gitfix
   mkdir real && cd real && git init -q . && echo x > f && git add f && git commit -qm init
   cd .. && ln -s real link
   cd real && git worktree add -q ../wt -b wtbranch

   for d in real link wt; do printf '%-6s ' "$d"; (cd ../$d && git rev-parse --git-common-dir); done
```

```
   main worktree      .git                          ← RELATIVE
   through a symlink  .git                          ← RELATIVE
   linked worktree    /abs/…/gitfix/real/.git       ← ABSOLUTE
```

The relative answer is resolved against the directory it was asked in. Driving
the shipped `isSameRepo` over that fixture, with `canonicalise` swapped for the
identity function to get the BEFORE column:

```
   parentCwd (symlink)     …/gitfix/link   --git-common-dir ".git"
   target    (realpath'd)  …/gitfix/wt     --git-common-dir "…/gitfix/real/.git"

   BEFORE  identity canonicalise : false     ← own repo reads as cross-repo
   NOW     real canonicalise     : true
```

`resolveSubagentTrust` gates on that answer, so before AO8 a worktree of the
parent's own repository got the cross-repo trust gate.

**Still latent in production on this box, and that is the point of the
`physical` mode of probe `ab8`** — Linux `process.cwd()` is physical, so the two
sides agree today. One `--cwd`-style option, one platform with a logical cwd, or
one caller passing a path a person typed, and it is live.

### AI.9 — the probes, no model, no Matrix

```
   cd context/testing/probes
   for m in published ambiguous full;            do node --experimental-strip-types ab1-… $m; done
   for m in off all store;                       do node --experimental-strip-types ab2-… $m; done
   for m in collision distinct silenced;         do node --experimental-strip-types ab3-… $m; done
   for m in skew twin ancient redelivery;        do node --experimental-strip-types ab4-… $m; done
   for m in live stale absent;                   do node --experimental-strip-types ab5-… $m; done
   for m in pair rooms control;                  do node --experimental-strip-types ab6-… $m; done
   for m in skills tilde agree live;             do node --experimental-strip-types ab7-… $m; done
   for m in logical physical foreign shapes;     do node --experimental-strip-types ab8-… $m; done
   for m in published ambiguous refusal full;    do node ab9-… $m; done
```

`ab9` is the odd one out and deliberately so: **no `--experimental-strip-types`**,
because it loads the shipped `executeStopAgentTool` through pi's own jiti, which
compiles the TypeScript itself.

`ab8 physical` is the one to read even if you run nothing else: it is the control
that shows AO8's fix changes nothing on this box, which is the same sentence as
*"this is why nobody noticed for twenty-four passes."*

**What the probes did not reach, and AI.1 did.** `ab1` drives `resolveAgentId`
beside a *quoted* copy of the old `Map.get`, on the grounds that
`tool-execution.ts` imports pi and will not load under
`--experimental-strip-types`. So nothing anywhere touched the one line that makes
AO1's fix reach a caller: putting it back left **1,434 tests and all 121 probes
green**, and AI.1 caught it on the first `StopAgent` call. That gap is **AO9**.

The reason `ab1` gave was the *suite's* constraint, and a probe is not the suite —
`q2` has driven this same function through pi's jiti since the thirteenth pass. So
AO9 got two instruments:

```
   ab9-the-wiring-no-probe-drove.mjs   the shipped executeStopAgentTool through
                                       jiti; all four modes exit 1 with the
                                       defect restored
   tests/agent-id.test.ts              describe("AO9 — StopAgent's resolution
                                       call site"), 7 tests; control runs 2 of 19
                                       for the lookup, 1 of 19 for the reply
```

**Run `ab9 refusal` if you run one thing.** The refusal sentence is identical in
both columns, and the difference is whether the ids inside it are ones the same
call would accept — **0 of 2 BEFORE, 2 of 2 NOW**. That is what AI.1's live model
walked into, made executable and free.
