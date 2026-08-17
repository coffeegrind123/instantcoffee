# Handoff — 2026-08-17

One session, three repositories, one theme: **the stack was losing information at
every boundary, and each loss looked like something else.** A proxy discarding
reasoning looked like a model refusing to answer. A tool reporting "too slow"
looked like a slow browser when the element simply was not there. A thinking
trace arriving on someone's phone looked like a leak in the forwarder when it was
a walk-back past an empty turn.

The measurements are in `design/decisions.md` in date order. This file is the map:
what was touched, what is live, and what the next session is for.

---

## Paths touched

### Repositories (all clean and pushed)

| Path | Remote | HEAD | What it is |
| --- | --- | --- | --- |
| `/opt/zendriver-mcp` | `coffeegrind123/Zendriver-MCP-fork` | `4599b1a` | The browser MCP server. Backs `scripts/browser.sh`, the `browser_*` tools in pi, and the `browser` MCP in Claude Code. |
| `~/qwen3.8-forge` | `coffeegrind123/qwen3.8-forge` | `213aee9` | This repo. |
| `~/.claude/skills/browser-automation` | `coffeegrind123/zendriver-mcp` | `b4757ab` | The Claude Code skill for the same browser server. |

### Inside `~/qwen3.8-forge`

| Path | Change |
| --- | --- |
| `.pi/extensions/compaction-guard/` | **New.** Summary cap, context notice, tool-output cap. 37 tests. |
| `vendor/prinny-channel/` | Token cost, correctness, typing, command routing, continuation. 296 tests. |
| `vendor/pi-loop-mode/extensions/index.ts` | One line: stands down when another extension has already posted a context-budget message. |
| `patches/forge_reasoning_passthrough.py` | **New.** Third build-time forge patch. |
| `Dockerfile.forge` | Applies the third patch. |
| `scripts/pi-local.sh` | Loads the compaction guard; sets `ZENDRIVER_MCP_TOOL_TIMEOUT`. |
| `.env` | `BROWSER_MCP_TOOL_TIMEOUT=25`; the `PRINNY_ENABLED` rationale corrected. |
| `README.md`, `context/design/decisions.md` | Documentation. |

### Live state that is not in any repository

- **`qwen38-forge` image rebuilt and container recreated** — the reasoning /
  `finish_reason` patch is running now, not waiting on anything.
- **Browser server restarted** on the new zendriver code.
- **prinny sidecar runtime rebuilt** under `~/.pi/agent/channels/prinny/runtime`.
- `~/.pi/agent/settings.json` — written by `pi-local.sh` on every launch.

### Touched by somebody else, deliberately left alone

`~/prinny-mono/prinny-desktop` has three uncommitted files (`cinny` submodule
pointer, `src-tauri/build.rs` +1, `src-tauri/src/lib.rs` +104), modified 13:31–13:34
on 2026-08-17. Not this session's work and not committed. `prinny-mono` is the
**Claude Code** variant of the channel; the pi fork is `vendor/prinny-channel`.

---

## What was done

### 1. Context management, for every session rather than `/loop`

`.pi/extensions/compaction-guard/` carries across the parts of the `/loop`
context work that were never loop-specific, and adds one thing `/loop` never had.

- **Summary cap.** pi merges each compaction summary into the previous one under
  a prompt that says "PRESERVE all existing information", so it is monotonic by
  construction: 456 → 4,029 → 11,054 chars across 42 real compaction points.
  Capped at 5% of the window, section-aware so `## Goal` and `## Next Steps`
  survive and the accumulating `### Done` list goes. Replayed over the 42 real
  summaries: 11 trimmed, none over the cap, none losing Goal or Next Steps, and
  the growth curve flattens to `6,458 → 6,538 → 6,550`.
- **Context notice.** The model is shown its own remaining budget above 60%.
- **Tool-output cap.** 10% of the *remaining* window, floor 1,500 chars, ceiling
  20,000; head and tail kept, overflow written to a file the marker names.

**The tool-output cap exists because the notice was watched failing.** At 84.5%
of the window, with the CRITICAL notice in context saying "do not run commands
with large output this turn", the model ran a curl loop that returned 17,790
characters and took the context to 100%. A soft instruction does not bind, and
the model could not have complied anyway — nobody knows how many bytes a pipeline
prints until it has printed them.

Note its real audience is **pi's own tools**. MCP results are already truncated
by `pi-mcp-adapter` before they reach the context.

### 2. Prinny: token cost

- Six `prinny_*` tools → one `prinny` dispatching on `action`. Measured off the
  wire: **~5,900 chars → 1,333**, ~1,470 tokens → ~333.
- The `<channel …>` block → `[matrix] <text>`. On real traffic: **249 chars → 38**,
  and 279 → 25 for a queued two-character message.
- Together: **~1,137 tokens back on every turn**, 3.5% of a 32k window, plus ~55
  per message.

`room_id` left the schema entirely — the extension holds it in `lastInbound`.

### 3. Prinny: correctness

- **A thinking trace reached Matrix.** Not a leak in the allowlist — a 17,790-char
  tool result emptied the model's turn, pi settled the run, and
  `finalAssistantText` walked *back* past the empty turn to the previous
  deliberation and forwarded that. It now stops at an empty turn.
- **Empty turns have three causes**, and the first version of the warning
  asserted one. `describeEmptyEnding` reports which, from evidence.
- **The run continues instead of dead-ending.** Two attempts, wording per cause,
  and the question is restated in the nudge so a compaction cannot lose it.
- **Typing indicator.** The refresh was correct and still invisible: re-asserting
  `typing: true` while already typing produces **no `m.typing` EDU at all** —
  Synapse only broadcasts when the set changes. Each assertion now clears first.
  Driven from `agent_start`→`agent_settled`, which is exactly when pi shows
  "Working…". The sidecar no longer signals typing on *arrival*, which was
  claiming work 89 seconds before pi had the message.
- **Matrix can run a named few pi commands.** `sendUserMessage` passes
  `expandPromptTemplates: false`, so `/` had never executed anything. Allowlist:
  `/compact`, `/stack`, `/loop` (whole lifecycle). Refused: `/prinny`, `/trust`,
  `/login`, `/settings`, `/share`, `/export`, `/copy`, `/new`, `/fork`,
  `/resume`, `/session`, `/tree`, `/quit`, `/model`, `/name`, plus the
  `--model` flag on anything permitted.

### 4. The browser server

- `navigate` waits for `readyState` **then** network idle. Idle alone cannot tell
  "finished" from "not started" — both are a request count that is not moving.
- `wait_for_network` counted a list capped at 100 entries, so a busy page reported
  idle after one `idle_time`. The failing session's `(100 requests captured)` was
  the cap, not a measurement.
- A hung `page.evaluate()` was silence; now a bounded, named error.
- **"Not found" was reported as "the tool was too slow".** zendriver signals a
  miss as `asyncio.TimeoutError`, and `_register` relabelled it as the tool's own
  budget — a click that returned in 10.4s reported exceeding a 25s budget. Now
  separated by elapsed time. This affected every find-based tool.
- `BROWSER_MCP_TOOL_TIMEOUT=25`, below the adapter's 30s, so the server answers
  first with a real sentence instead of losing the race.
- `get_interaction_tree(links=true)` returns link targets. Off by default: it
  grew a 125-link page by 116%, and by 82% after same-origin targets were
  shortened to paths. With it off the output is byte-identical to before.

### 5. Forge — the root cause of the empty turns

`patches/forge_reasoning_passthrough.py`. The control:

```
llama-server :8080  ->  finish_reason "length",  reasoning_content 490 chars
forge        :8081  ->  finish_reason "stop",    no reasoning_content key
```

llama.cpp was blameless throughout. `TextResponse` carried `content` and nothing
else, so a reasoning-only turn arrived as `TextResponse(content="")` and
everything the model generated was destroyed before the response was assembled.
`finish_reason` was hardcoded `"stop"`, so a truncated **answer** was
indistinguishable from a finished one.

Reasoning is emitted as `reasoning_content`, never merged into `content` — pi maps
it to a *thinking* block and prinny allowlists *text*, so the harness sees it and
Matrix does not. `--reasoning-format none` would have recovered the same tokens
by putting them in `content`, and leaked them.

---

## Verified, and not

**Verified live:** the forge patch on both ports; `pi -p` end to end; the browser
fixes against the pages that produced the failures; the typing EDU behaviour
against the real homeserver; every tool surface measured off the wire.

**Not verified live** — needs a real session, not more code:

- The prinny **continuation** firing on a real empty turn.
- The **tool-output cap** on a real native `bash` result.
- **Matrix command routing** (`/compact` from a phone).
- A **real compaction** with the summary cap in place, which needs a session long
  enough to compact twice.

---

## Next session: subagents on a local model

### The starting fact

pi ships none, deliberately. From its own README:

> Pi ships with powerful defaults but skips features like sub agents and plan
> mode. Instead, you can ask pi to build what you want or install a third party
> pi package that matches your workflow.

So this is a build-or-adopt decision, not a configuration one.

### What pi already gives you

Exported from the package root: `AgentSession`, `createAgentSession`,
`createAgentSessionRuntime`, `SessionManager`, `buildSessionContext` — a second
session is constructible in-process.

On `ExtensionAPI`: `registerTool`, `sendMessage`, `sendUserMessage`, `exec`,
`getAllTools`, `getActiveTools`, `setActiveTools`, `setModel`. Enough to expose a
`subagent` tool, give it a restricted tool set, and run it.

### What this stack makes hard, and why it is the interesting part

1. **There is no concurrency to win.** `PARALLEL_SLOTS=1` — one llama slot. Two
   subagents do not run in parallel; they queue. The usual argument for subagents
   (fan out, wall-clock) does not apply here. The argument that *does* survive is
   **context isolation**: a subagent burns its own window on a big search and
   returns a summary, so the parent's 32k stays clean.
2. **Every tool schema is charged on every turn.** This session spent most of its
   effort on exactly that: 1,470 tokens for six prinny tools, 2,233 for link
   targets, 1,144 recovered by folding six tools into one. A subagent tool must
   be measured the same way, on the wire, before it is kept.
3. **Prefix caching is the performance story.** `CACHE_PROMPT`, `CACHE_REUSE`,
   `--slot-save-path`, and a deliberately frozen tool surface. A subagent with a
   *different* system prompt evicts the parent's prefix from the shared slot.
   Measure `cached_tokens` before and after — the counter now works, courtesy of
   `patches/forge_cached_tokens.py`.
4. **The window is 32k and the cliff is at 87%.** A subagent that returns a large
   result recreates the failure this session spent its day on. It should return a
   *bounded* summary; `.pi/extensions/compaction-guard/src/output-cap.ts` already
   has the shape and the numbers.
5. **forge is a guardrail proxy in the path.** It rewrites responses. Anything
   built here must be checked against **both ports** — `:8080` direct and `:8081`
   through forge. That control is what finally located the empty turns, after two
   wrong conclusions from testing through forge alone.

### Questions worth answering first

- Does a third-party pi subagent package exist, and does it survive the wire test?
- Is the win context isolation only, or is there a real use for a *different
  model* per subagent — a small fast one for search, the 27B for synthesis?
  `setModel` exists; `switchModel` in `vendor/pi-loop-mode` is a worked example.
- What does a subagent tool cost in schema, and what does it save in parent
  context? Both measured, not argued.
- How does it interact with the compaction guard, `/loop`, and prinny's
  forwarding — does a subagent's output become an "answer" that reaches Matrix?

### Where to look

- `vendor/pi-loop-mode/extensions/index.ts` — the most complete extension in this
  tree: its own state, model switching, the `session_before_compact` hook.
- `.pi/extensions/compaction-guard/` — the token-budget patterns, and
  `tests/tool-budget.test.ts` in `vendor/prinny-channel` for how to measure a
  tool surface **against the wire** rather than against the source.
- `context/design/decisions.md`, 2026-08-16 and 2026-08-17 entries.
