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
- **A passing verification is invisible in the TUI.** `src/ui/renderer.ts` does
  not read `details.verification`, so a pass shows nothing at all — by design
  the answer is returned undecorated. Only failures surface, as a notify line
  and an appended note. Use the `--mode json` recipes in section G to see a pass.

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

**Expected:** `read bash edit write stack_status mcpScript mcp` + five `browser_*`
+ **`loop`**, and the `mcp-scripting` skill.

**Must NOT contain:** `prinny`, `prinny-access`, `prinny-configure` (denied
unconditionally), or `Agent` (no recursive subagents).

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

## F. A loop inside a subagent, bounded

```
Spawn a subagent whose prompt begins with: /loop start tidy the comments in vendor/rtk-pi/src/gate.ts. Done when: node --check passes --max 3
```

`AgentSession.prompt()` expands commands, so a child handed `/loop …` starts a
real one. This is also the test that loop reaches children at all.

**Evidence:** the child loops and **stops**. The ceiling is `DEFAULT_MAX_TURNS =
40`: at the limit it is steered *"wrap up immediately — provide your final answer
now"*, and only hard-aborts `graceTurns` later, so the result should be an answer
rather than a severed run.

---

## G. The verifier

### Pass path — needs `--mode json`, a pass is silent in the TUI

```sh
~/qwen3.8-forge/scripts/pi-local.sh --mode json \
  -p 'Use a subagent to report the value of DEFAULT_CONCURRENCY_LIMIT.' \
  | grep -o '"verification":"[a-z-]*"'
```

**Expected:** `"verification":"passed"`, and the answer text itself untouched.

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
asking it once more"* — and a returned answer ending
`[verification: the first answer did not address the task; this is the corrected one.]`

**This path has never fired live.** It is covered by unit tests only
(`tests/verify-runner.test.ts`), so the judge's real false-positive rate is
unknown. Treat a surprising verdict here as data worth writing down.

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

**Expected:** they **queue**, not overlap. The fork defaults concurrency to 1
because there is one llama slot; two children would only compete for the same
prompt cache.

---

## What none of this covers

- **Subtly wrong work.** The judge is the same 27B that wrote the answer. It
  catches a different question being answered, an empty or evasive summary, and a
  claim about work plainly not done. It is a drift check, not a correctness
  proof.
- **Whether the verifier's repair helps.** The repair path is unit-tested and
  unobserved; whether a second attempt from a drifted child is actually better
  than the first is an open question.
