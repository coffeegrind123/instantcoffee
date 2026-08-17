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

## What none of this covers

- **Subtly wrong work.** The judge is the same 27B that wrote the answer. It
  catches a different question being answered, an empty or evasive summary, and a
  claim about work plainly not done. It is a drift check, not a correctness
  proof.
- **Whether the verifier's repair helps.** The repair path is unit-tested and
  unobserved; whether a second attempt from a drifted child is actually better
  than the first is an open question.
