# pi-subagents-lite — forge fork

Forked from [`pi-subagents-lite@1.11.0`](https://www.npmjs.com/package/pi-subagents-lite)
(AlexParamonov, MIT — `LICENSE` is upstream's, unchanged), taken from the
published npm tarball rather than git HEAD so the pin means something.

`scripts/pi-local.sh` loads it by absolute path:

```
-e vendor/pi-subagents-lite/src/index.ts
```

Nothing needs installing, and there is no `node_modules` under `vendor/` — see
"The typebox import" below for the one dependency that made that a real
question rather than an assumption.

**Off by default** (`SUBAGENTS_ENABLED=0` in `.env`). A registered tool costs its
schema on every turn whether or not the model ever calls it, so this is a charge
to opt into. What it costs is measured below rather than estimated.

**If the upstream npm package is ever installed** (`pi list`), remove it —
`pi uninstall npm:pi-subagents-lite`. pi dedupes extensions by path, so a second
copy at a different path registers a second `Agent` tool and doubles the schema
cost this fork exists to keep small.

Upstream's `test/` is not in the published tarball and is not vendored;
`tests/` here is this fork's own.

## Why this package, out of 341

`pi.dev/packages?name=subagent` returns 341 matches. The popular ones —
`pi-subagents` (244,797/mo, 3,182★) and `subagent-isolation` among them — run
each subagent as a child `pi --mode json -p` **process**. That is the wrong shape
for this stack, and specifically:

- llama.cpp runs here with `PARALLEL_SLOTS=1`. A child process buys no
  parallelism; it queues at the server.
- A child process carries its own system prompt and tool catalog, and a child
  that does real work displaces the parent's cached prefix — see "The prefix
  cache" below for what that costs, measured.

This package runs subagents **in process**, through pi's own
`createAgentSession` (`src/agents/agent-runner.ts:531`). The win that survives on
one slot is not wall-clock, it is context isolation: the child burns its own
window on the search and the parent gets back a bounded summary.

Three other things decided it over `@tintinweb/pi-subagents` (40,433/mo, 895★),
which is also in-process and was the other finalist:

- **The tool surface is already at the floor.** Upstream deletes the tool
  `description` outright (`// @ts-expect-error — description removed to save
  prompt tokens`) and lets `Agent`, `run_in_background` and `worktree_path` carry
  the meaning. tintinweb's *compact* description alone is 778 chars — larger than
  this package's entire three-tool schema.
- **Per-provider concurrency with a real queue** (`src/agents/agent-manager.ts`),
  whose own doc comment uses a local llama provider as the example.
- **Model precedence** — session override → agent frontmatter → config → parent
  model — which answers "a small fast model for search, the 27B for synthesis"
  in configuration rather than in code.

## What it costs, measured

Taken off the wire against the stub model in
`vendor/prinny-channel/tests/fixtures/stub-model.mjs`, the same way
`vendor/prinny-channel/tests/tool-budget.test.ts` measures prinny — the source
cannot tell you what pi decided to send, so it is not asked.

```
baseline (no extension)          2,900 chars   read 699 · bash 557 · edit 1,194 · write 445
with vendor/pi-subagents-lite    3,610 chars   + Agent 357 · StopAgent 193 · AgentStatus 157
delta                              710 chars   ~178 tokens, every turn
```

For scale: that is 0.54% of a 32k window, against the ~1,470 tokens the six
`prinny_*` tools cost before they were folded into one. The `Agent` tool as the
model actually receives it:

```json
{"type":"function","function":{"name":"Agent","parameters":{"type":"object",
 "required":["prompt"],"properties":{"prompt":{"type":"string"},
 "description":{"type":"string"},"agent":{"type":"string",
 "description":"general-purpose,Explore"},"run_in_background":{"type":"boolean"},
 "worktree_path":{"type":"string"}},"additionalProperties":false},"strict":false}}
```

No prose at all. Whether a 27B local model uses a tool this bare correctly is
**not** settled by this measurement — see "Not verified" at the end.

## What was changed, and why

### 1. The typebox import — without this it does not load at all

`src/registration.ts:1`. Upstream imports `@sinclair/typebox`, which is not
present anywhere in this pi install. pi 0.84.2 bundles **`typebox` 1.3.7**, the
successor package, and resolves the bare specifier for extensions;
`vendor/prinny-channel` imports it the same way. Checked rather than assumed:
`Type` and `TSchema` are both exported from the 1.x root, and
`Type.Object({...}, {additionalProperties:false})` emits byte-identical JSON
Schema under both. Upstream's `dependencies` entry for `@sinclair/typebox` was
dropped with the import, which is what keeps `vendor/` free of `node_modules`.

### 2. Default concurrency 4 → 1

`src/agents/agent-manager.ts`. With `PARALLEL_SLOTS=1` the queue forms either
way; the only question is where. Serialising here means at most one foreign
prefix competes with the parent's at a time, and one child holding context
instead of four. Per-provider overrides still work
(`concurrency.providers.forge`), so raising it alongside `PARALLEL_SLOTS` needs
no code change.

### 5. What a subagent may and may not load

`src/agents/subagent-denylist.ts` (new), wired into the child's resource loader.

**A child does not inherit the parent's `-e` flags.** It builds its own
`DefaultResourceLoader` and *discovers* extensions, so everything under
`.pi/extensions/` reaches it and everything this stack loads by absolute path
from `vendor/` does not. Measured: a subagent asked to inventory itself reported

```
TOOLS:  read bash edit write stack_status mcpScript mcp browser_×5
SKILLS: mcp-scripting
```

— no `prinny`, no `loop`, no `Agent` (so no recursive subagents), and a second
probe confirmed `rtk` was absent by running `git status --short` unrewritten.

Two consequences, pulling in opposite directions:

- **prinny must never be there**, and a layout accident is not a guarantee.
  Someone moves the channel under `.pi/extensions/` and a subagent — which the
  model spawns on its own initiative, with a prompt the operator never sees —
  can post to a Matrix room. The denial is unconditional and runs after the
  agent's own filter, so no agent `.md` can widen it back. The `prinny-access`
  and `prinny-configure` skills go with it, through `skillsOverride`, a loader
  hook upstream was not using.

  It has to key on **path**. `extractExtensionName()` reduces
  `vendor/prinny-channel/extensions/index.ts` to `index` — the same name loop
  and rtk get — and `resolvePackageShortName()` only returns a name when
  `pi.extensions` lists the entry *file*, while prinny's lists the directory. So
  `excludeExtensions: ["prinny"]` matches nothing and `["index"]` removes all
  three. The test suite pins that as a control.

- **loop and rtk should be there**, and are put back by default through
  `additionalExtensionPaths`. rtk because a child running `bash` uncompressed is
  the session that can least afford it — its whole value is coming back small.
  loop because a bounded, goal-shaped loop grinding in a window that is not the
  operator's is the best version of delegation on one slot.
  `SUBAGENT_EXTRA_EXTENSIONS` replaces the list; denied paths are filtered out
  of it too, so it cannot be used to smuggle the channel back in.

### 6. A subagent always has a turn ceiling

`DEFAULT_MAX_TURNS = 40` in `agent-runner.ts`. Upstream leaves `maxTurns`
undefined unless an agent file sets it, and undefined means unbounded — fine
when a subagent is a short search, not fine now that a child can loop.
`AgentSession.prompt()` defaults `expandPromptTemplates` to **true** and this
fork calls it bare, so a child handed `/loop …` starts a real one; an unbounded
loop on a one-slot server is not a runaway subagent, it is a stopped machine,
because the parent's next turn queues behind it forever.

Upstream's ladder does the rest well: at the ceiling it steers *"wrap up
immediately — provide your final answer now"* and only hard-aborts
`graceTurns` later, so hitting the limit produces an answer rather than a
severed run. An agent file can still raise it, and `max_turns: 0` still means
unbounded for anyone who wants that deliberately. The parent's kill switch is
`StopAgent`, which aborts running *and* queued agents.

## The prefix cache — measured, and not what was assumed

The assumption going in, inherited from the handoff, was that a subagent's own
system prompt evicts the parent's cached prefix from the single slot. **That is
false**, and it was worth measuring rather than repeating. Probed directly
against `/v1/chat/completions` with
`prompt_tokens_details.cached_tokens` (which `patches/forge_cached_tokens.py`
exposes), with a repeat of the same prefix as the control:

| child | parent's next call | |
| --- | --- | --- |
| six small turns (≤3.3k tokens) | 2,117 cached / 2,134 — **99.2%** | unaffected |
| four turns growing to 18k tokens | 0 cached / 2,134 — **full re-prefill** | evicted |

Same result on `:8080` and `:8081`, so it is llama.cpp's behaviour and not
something forge does. The eviction reproduced twice; the "small child" case
survived nine trials out of nine at 1–6 turns.

So the mechanism is **capacity, not identity**. A subagent that answers from its
own knowledge is nearly free to the parent's cache. A subagent that reads files
and runs searches — the reason to have one — pushes the parent out.

What that costs, timed on the same runs: the parent's next call went from
**442 ms to 2,949 ms**, a 2.5-second re-prefill of 2,133 tokens. A real parent
session carries far more than 2,133 tokens, so this is a floor rather than an
estimate of the worst case.

The practical consequence is that the standing schema charge (~178 tok/turn) is
**not** the main cost of delegating on this stack. The re-prefill on the turn
after a substantial subagent is.

### 3. A background subagent's result is bounded before it is injected

`src/spawn/result-cap.ts` (new) and its call site in
`src/spawn/spawn-coordinator.ts`. This is the substantive one.

A **foreground** subagent returns through the `Agent` tool, so its result is a
tool result, and `.pi/extensions/compaction-guard` already bounds it: that
extension hooks `pi.on("tool_result")` and keys off `toolName` rather than a list
of pi's builtin tools, so an extension-registered tool is covered for free.

A **background** subagent does not take that path. It is delivered with
`pi.sendMessage({customType: "subagent-result", ...}, {triggerTurn: true})`, and
pi's `sendCustomMessage` (`dist/core/agent-session.js:1068`, read rather than
guessed) builds a `role: "custom"` message and hands it straight to
`agent.steer()` / `agent.followUp()` / `_runAgentPrompt()`. That path emits no
`input` event, no `tool_result`, and on the triggerTurn branches no
`message_start`/`message_end` either. **There is no generic hook an extension
could have used**, which is why the bound lives in the fork instead of in the
guard where the rest of them are.

Uncapped, this is exactly the failure the guard was written for: on 2026-08-17 a
17,790-char payload arriving at 84.5% of a 32k window took the context to 100%
and the model produced nothing. A subagent that searched a large tree produces
payloads that size, and this one triggers a turn on arrival.

The cap **imports** the guard's `allowanceChars` / `planOutputCap` rather than
restating them: `REMAINING_FRACTION = 0.1`, the 1,500-char floor and the 20,000
ceiling were chosen against that failure — a fifth of the remainder would have
landed the run at 88.5%, above the 87% cliff, and a tenth lands it at 86.8%,
below it — and `compaction-guard/tests/output-cap.test.ts` pins that end state. A
second copy of those constants here would drift away from the test that
justifies them.

**The coupling this creates:** `vendor/pi-subagents-lite` imports
`.pi/extensions/compaction-guard/src/output-cap.ts` by relative path. If the
guard is missing the import cannot resolve and the extension fails to load, so
`scripts/pi-local.sh` checks for the guard and leaves subagents out with a
stated reason rather than letting that happen mid-launch.

`tests/result-cap.test.ts` covers it, including the two paths that matter more
than the arithmetic: a finished agent is still delivered when the context cannot
be read or the bounding throws.

### 4. `"type": "module"` and a lint that works

`package.json`. Upstream ships no `"type"` field, which is harmless under pi's
own loader but leaves plain-node tooling guessing. The house lint
(`node --check` over every `.ts`) still does not work on this package, and the
reason is in the header of `tests/lint.mjs`: `--check` picks CommonJS-or-ESM by
scanning for a top-level `import`/`export` and only strips TypeScript on the ESM
path, so two files that open with a bare `function` or `interface` are parsed as
CommonJS and fail on their own type annotations. `tests/lint.mjs` strips the
types with node's own `stripTypeScriptTypes` (in `transform` mode — five files
use constructor parameter properties) and checks the JavaScript that comes out.
55/55 files, no exclusions, and a deliberately broken file was used to confirm it
can still fail.

Upstream's `prettier`/`vitest`/`tsc` scripts and devDependencies went with it —
none of those are installed here, and a script that cannot run is worse than no
script.

### 7. Answer verification — LANDED BUT NOT WIRED

`src/agents/verify.ts` and `tests/verify.test.ts` (20 tests) exist and nothing
calls them yet. Said plainly here because a module that looks finished and is
never invoked is the worst kind of dead code: the next person reads the tests,
believes subagent answers are checked, and acts on an answer nothing checked.

**They are not. As of this commit every subagent answer goes back to the parent
unverified**, exactly as upstream does it.

What the module holds, for the wiring that follows:

- **`structuralVerdict`** — the checks that need no model call: an empty answer,
  and runs that ended aborted / turn-limited / stopped. It deliberately reports
  those as *not worth judging*, because `status-note.ts` already tells the
  parent they were cut off and paying a model to re-confirm it is waste.
- **`buildJudgePrompt` / `parseJudgeVerdict`** — a judge that sees **only** the
  brief and the answer. Not the child's session: a model reviewing its own work
  with its own justifications in front of it ratifies it, so the judge is made
  harder to fool by knowing less. The prompt asks for the verdict *before* the
  reasoning, because a local model allowed to reason first talks itself into
  agreement — there is a test on that ordering. The parse checks
  `NOT_ADDRESSED` before `ADDRESSED` (one contains the other; getting it
  backwards turns every failure into a silent pass) and fails **open** on an
  unreadable reply while flagging that it went unchecked.
- **`buildRepairPrompt`** — one attempt, sent into the child's own session,
  which does have the context to fix things. It restates the brief in full
  rather than referring to it: pointing at "the original task" points at
  precisely the thing compaction may have removed.
- **`buildAnchorMessage`** — the cheapest layer and the one that matters most.
  Re-injected after each compaction so the brief cannot be summarised away.
  Prevention, not detection.

What it will not do, once wired: catch subtly wrong work. The judge is the same
27B that wrote the answer. It is a drift check, not a correctness proof.

## Verified live, against the real model

Run 2026-08-17 against Qwen3.8-27B through forge, not against a stub.

**The 27B model drives the description-free schema.** Asked to delegate, it
emitted a well-formed `Agent` call with a self-contained prompt and a sensible
`description`, did not search itself, and got a correct answer back. Asked for a
background run it set `run_in_background: true` — an undescribed boolean — then
polled with `AgentStatus` and slept between polls, all inferred from parameter
names. This was the question that decided whether the package was usable here at
all, and it is answered.

**The background cap fires on the real path.** From the injected message:

```
role: custom, customType: "subagent-result"
[output capped at 20% context: 14218 chars, kept about 10495.
 Full output: /tmp/pi-subagent-result-qGLIYT/general-purpose-b78d6c07-0332-438.txt. …]
```

The spill file is on disk at 14,348 bytes. Better than that: the parent then read
the marker, went to the file for the exact size, and reported it. The recovery
bargain is not theoretical — the model took it unprompted, first time.

That run also settled the marker's wording. The advice inherited from the guard
was "prefer a narrower command", which the model **followed** — it went looking
for a command to narrow that had never been run. `planOutputCap` now takes the
advice from its caller, and this one says to read the file or re-task the agent.

**Extensions load in the in-process child too**, which was not obvious and is
worth knowing: the same run shows compaction-guard capping the *child's* own
`read` result at 9,778 → 8,176 chars inside the child session. Subagents are
bounded in their own windows, not just on the way back.

## Not verified

- **prinny forwarding is answered from source, not from Matrix**, because
  testing it live means logging a bot into a homeserver. `forwardToMatrix`
  returns early unless a room has a *live* `awaitingReply` entry, and
  `forwardResult` deletes every live entry when a run settles. So: a subagent
  that finishes while the parent is still streaming is delivered as a `steer`,
  folds into that run, and is forwarded normally. One that finishes after the
  run settled starts a *new* turn against a room that has already been retired,
  and its answer **stays local** — the Matrix user who asked never sees it. The
  failure mode is silence, not a leak, which is the safe direction, but a long
  background job started from Matrix currently answers into the void.
