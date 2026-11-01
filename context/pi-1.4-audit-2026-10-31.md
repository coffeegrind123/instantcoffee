# pi 0.87.1 -> 1.4.0 extension audit — 2026-10-31

The probes and readers used are in `context/testing/pi-audit/`, with the recipes.

The plan from HANDOFF part 19, carried out. Every claim below was measured or
read from pi's own source; the method is named on each one. pi 1.4.0 and 0.87.1
were installed side by side (npm, `--ignore-scripts`) and the same launch
command run against both, against the live forge on `host.docker.internal:8081`.

## 1. What runs

- **There is no pi container to ask.** `pi-agent:latest` and
  `instantcoffee-pi` do not exist on this Docker; whatever removed the image
  (a prune is the likely candidate) left nothing to `pi --version`. What it
  WOULD run is npm `latest`, which is 1.4.0 (published 2026-10-21): both
  `PI_VERSION=latest` (Dockerfile.pi) and `PI_AUTO_UPDATE=1` (pi-local.sh, once
  per 24 h) resolve to it.
- **Every extension loads clean on 1.4.0**, with the control that makes "clean"
  mean something: a deliberately throwing extension fails the launch with
  `Failed to load extension … CONTROL-LOAD-THROW` (exit 1), and a throwing hook
  prints `Extension error (…): CONTROL-HOOK-THROW` on stderr. The real set
  printed neither.
- **No event we hook was removed** (diff of every `type: "…"` emitted under
  `dist/core`, 0.87.1 vs 1.4.0: nothing removed, two added —
  `mcp_servers_change`, `provider_stream_event`). Every `pi.on(…)` name in the
  tree exists in 1.4's `types.d.ts`.
- **Standing cost unchanged.** Request payload dumped from
  `before_provider_request`, same flags: tools identical (9, 4,519 bytes), system
  prompt +117 chars (the install path and one longer docs line). The built-in
  `mcp`/`codemode`/`tool-search`/`llama` extensions add nothing without config.
- **Harness trap, not a pi bug:** `pi -p` with an inherited non-TTY stdin waits
  for EOF. From a tool shell (stdin is a socket) every headless run hung until
  `</dev/null` was added. Any script that runs `pi -p` unattended needs it.

## 2. Release notes, 0.99.0 -> 1.4.0, against what we use

Read in full from the package's CHANGELOG.md (lines 1-506). Only rows that touch
this stack are listed; provider/model/OAuth/codemode/TUI-cosmetic entries do not.

| Release | Change | Effect here | Verdict |
| --- | --- | --- | --- |
| 1.2.0 BREAKING | `before_agent_start` fires for `sendMessage(…, {triggerTurn})` runs, `messageType: "custom"`, no `prompt`; handler messages are added to those runs too | **L1**, below. Persona and prinny return `systemPrompt`, which now also applies to loop/extension-driven turns: the prompt stops changing between operator and loop turns. Observe only reads it. | fixed (loop); keep (others) |
| 1.2.0 BREAKING | session busy from run START; `sendUserMessage()` needs `deliverAs` while busy | **P1** and **S4**, below. prinny's no-`deliverAs` call is an extension command, dispatched before the busy check (`prompt()`, `agent-session.js:1640`). | fixed |
| 0.99 / 1.x | `prompt()` / triggered `sendCustomMessage` during `agent_settled` are deferred until the handlers finish | loop, compaction-guard, persona settled handlers only send things; deferral is harmless | keep |
| 1.4.0 | summaries use the model's output limit; `reserveTokens` no longer caps them | 0.87: `min(0.8 x 16384, 8192)` = 8,192. 1.4: model `maxTokens` = 8,192. No behavioural change; the sentence "reserveTokens is also the summarizer's maxTokens" in docs/pi.md is now false | doc fixed |
| 0.99.0 | built-in MCP (`builtin:mcp`) | **M1** and **§6**, below | adopted |
| 1.1.0 | `agent_settled.aborted` | lets the loop tell an operator abort from a finished run without inferring it (AE1 territory) | adopt later |
| 1.1.0 | `durationMs` on `tool_execution_end` | observe could send real tool time | adopt later |
| 0.99.0 | `provider_stream_event` | observe / the forge-tool-call work could see raw provider events | adopt later |
| 1.3.0 | malformed final tool-call JSON fails validation instead of running with partial fields | good for a local model; nothing to do | — |
| 1.4.0 | whitespace-only tool output no longer 400s on `openai-completions` | our API; nothing to do | — |
| 1.4.0 | concurrent extension dialogs no longer orphan the first promise | `/stack` confirms, prinny permission prompts benefit | — |
| 1.0.1 | `npm-shrinkwrap.json` removed; 1.3.0 pins internal deps exactly | our npm installs are unpinned transitively | note |
| 1.0.0 | TUI fullscreen by default (`tuiMode: "regular"` restores scrollback) | operator-visible | operator's call |
| 0.99+ | **install telemetry on by default**: `pi.dev/api/report-install?version=` on each version change (`enableInstallTelemetry: true`), plus `pi.dev/api/latest-version` and catalog refreshes | turned off, §6 | done |

`httpIdleTimeoutMs`, `compaction.{reserveTokens,keepRecentTokens}` and the
`compat` flags are still read: the generated `models.json` and `settings.json`
validate against 1.4's published schemas with 0 errors (jsonschema 2020-12), and
`main.js:711` still calls `getHttpIdleTimeoutMs()`.

## 3. Vendored forks against their upstreams

| Fork | Fork point | Upstream now | Verdict |
| --- | --- | --- | --- |
| pi-loop-mode | 2.5.4 | 2.5.4 | nothing to sync |
| pi-subagents-lite | 1.11.0 | 1.17.1 (59 files) | ported the fixes, skipped the features; table below |
| rtk-pi (`hooks/pi/rtk.ts`) | v0.45.0 | v1.1.0 | upstream replaced the `isToolCallEventType` value import (their 250 ms barrel cost) and added a status line when rtk is missing. Under pi's loader aliases the barrel costs nothing measurable here (rtk alone: 1 s for a whole headless turn). **skip**. The rtk BINARY pin (0.45.0 vs 1.1.0) is a separate decision with its own `--check`. |
| pi-mcp-adapter | 2.26.0 (pinned) | 7.0.0 | **retired** for pi's built-in MCP, §6 |
| pi-persona, prinny-channel | ports, no upstream | — | checked under §2 |

pi-subagents-lite, 1.11.0 -> 1.17.1 (read by a subagent; every claim acted on
below was re-checked against pi's source first):

| Upstream change | Here | Verdict |
| --- | --- | --- |
| Error mark from the render context | ours read `result.isError`; pi passes `{content, details}` only (`tool-execution.js`, 0.87.1:267 and 1.4.0:243) | **S1, ported** |
| Child teardown emits `session_shutdown` | `AgentSession.dispose()` emits none (both versions); `observe` forgets a child only on it | **S2, ported** |
| `dispose()` aborts in-flight runs; late session torn down | ours left a setup-phase child running on the slot with no owner | **S3, ported in our form** |
| `write` summary reads `path` | pi's write schema is `path` (both versions) | **S5, ported** |
| `getContextUsage()` over `getSessionStats()` | stats walks every entry per widget frame | **S6, ported** |
| Tool map merged across same-named extensions | latent: only stack.ts registers a tool, guarded in children | skip (recorded) |
| Per-API max-tokens field | latent: no agent sets `max_tokens`; would send both fields | skip (recorded) |
| Thinking order / `parent` choice, viewer stream refresh | optional | skip (recorded) |
| MessageAgent tool, `exposeDescriptions`, built-in extensions in children, `loadToolsImplicitly` | tokens on every turn, or loosen what a child may load | **refuse** |
| `onSessionCreated` after `bindExtensions`; `parentIdle ? "followUp" : "steer"`; concurrency 4 | would undo W6, AA4, our 1-slot default | **refuse** |

## 4. Findings and fixes

Each fix has a test that fails without it (control run noted).

- **L1 — loop-driven runs carried the rules twice.** pi 1.2 fires
  `before_agent_start` on loop-driven runs; the loop's handler, written on the
  premise that it never does (AA1), added its rules message to each one, on top
  of `loopInstructions()`, persisted as a `custom_message` entry each time.
  Measured live in the rebuilt container (§7): a 2-iteration `/loop` wrote 0
  `loop-rules` entries with the fix and 1 with it reverted (an iteration can
  arrive as a follow-up inside the same run, so it is per run, not per
  iteration). Measured on
  real pi with a probe extension: 0.87.1 fires once (`messageType: null`), 1.4.0
  fires again for the triggered run (`messageType: "custom"`, no prompt). Fix:
  skip `"custom"` only (pre-1.2 events have no `messageType` and are always
  typed prompts). `vendor/pi-loop-mode/extensions/index.ts`,
  `tests/system-prompt-leak.test.ts` (fails 1 before). 297/297.
- **P1 — `/persona` mid-turn switched the persona off and extracted nothing.**
  Commands run while a turn streams; the extraction's `sendUserMessage()` has no
  `deliverAs` and rejects on a busy session — after `retireActive` already
  removed the active persona. Pre-existing; pi 1.2 widened "busy" to the run's
  start. `followUp` is not a fix: it joins the run in flight, whose system prompt
  carries the outgoing persona — the bleed this package's suite exists to
  prevent. Fix: refuse while busy, before anything is staged or retired.
  `vendor/pi-persona` (submodule), `tests/switching.test.ts`. 150/150.
- **M1 — pi's built-in MCP collided with the adapter.** Both register `/mcp`;
  pi skipped the built-in and warned on every launch. First fixed with a
  version-gated `--no-mcp`; **superseded the same day by §6**, which retires the
  adapter. The version gate (`installed_pi_version`, `version_ge` in lib.sh,
  `scripts/test_pi_version_gate.py`) stayed and now gates the native browser.
- **S1 — every failed delegation was drawn ✓.** Pre-existing (pi has never
  passed `isError` in the result). `registration.ts` folds the render context's
  `isError` in. Test drives the registered `renderResult` through pi's jiti.
- **S2 — child sessions never heard `session_shutdown`.** Pre-existing. New
  `endChildSession()` in `record-teardown.ts` emits it on the child's runner and
  disposes after it settles (dispose invalidates the handlers' ctx); stays
  synchronous when there is no runner. Used by `teardownRecord` and the judge.
- **S3 — a reload during a child's setup left an ownerless run on the slot.**
  `dispose()` aborts every record's controller (`runTurnLoop` throws before
  `prompt()` on an aborted signal, AB4) and a session created after dispose is
  ended, not attached. The window is a child's whole setup, including binding
  its extensions; how long that takes on the pi container's mount is unmeasured
  (see §5).
- **S4–S6** — the debug briefing's `sendUserMessage` gets `deliverAs:
  "followUp"` (source pin: the function is module-private and only reachable
  through a TUI list); `write` summary reads `path`; context percent reads
  `getContextUsage()`.
- **T1 — two suites were never in CI, and both had gone red unseen.**
  `pi-subagents-lite` (571 tests) and `pi-toolresult-guard` (30) had no CI step.
  subagents-lite: a control pinned 0.87's `sendCustomMessage` text
  (`_runAgentPrompt`; 1.x calls `_startRun({messageType:"custom"})` — the AA4
  argument still holds, the pin now accepts both), and the exec-verdict scan read
  `RegExp.exec` in `observe/src/git.ts` as `pi.exec` (flagged regex literals and
  constant-named receivers now excluded, with a test of the matcher itself).
  toolresult-guard: 5 of 6 contract pins failed because the search read only the
  bundle chunk holding `getTextOutput` and pi 1.4 split the path over two;
  needles 2 and 6 also changed spelling. **The contract itself holds on 1.4** —
  pin 1 (`getTextOutput` still unguarded) passes, so the guard is still needed —
  and the old spellings still pass against 0.87.1 (control). Both suites added
  to CI.

## 5. Open, measured or decided elsewhere

- **pi startup on a bind mount — measured (§7): 77-89 s to the first TUI frame
  in the pi container**, against 1 s for pi with no extensions. The extension
  set loads from the Windows bind mount; `pi-subagents-lite` alone took 85-100 s
  from this container's 9p mount and 2-4 s from local disk. Not a pi 1.4
  regression (0.87.1 the same). Not fixed here. Children bind extensions too (`agent-runner.ts`
  `bindExtensions`); which ones, and what that costs per spawn, is unmeasured.
- **Adopt** `agent_settled.aborted` (loop), `durationMs` and
  `provider_stream_event` (observe).
- `./scripts/pi-local.sh --print-only` starts the browser server in native mode
  (`BROWSER_MCP_AUTOUP`); a print-only mode with a side effect.
- prinny-channel's suite was not run locally (its CI step builds the sidecar);
  CI covers it.

## 6. Follow-up the same day: telemetry off, and the browser on pi's built-in MCP

### Telemetry and pi's own network calls

Every outbound call in pi 1.4.0's `dist/` (grep for `fetch(` and `https://`),
and what gates it:

| Call | When | Gate |
| --- | --- | --- |
| `pi.dev/api/report-install?version=` + pi User-Agent | interactive start after a version change | `PI_OFFLINE`, or install telemetry off (`PI_TELEMETRY=0` / `enableInstallTelemetry: false`; default **true**) |
| provider attribution `{name: "pi", url: "https://pi.dev"}` | provider requests (OpenRouter, NVIDIA, OpenCode hosts; not forge) | install telemetry off |
| `pi.dev` model-catalog refresh (15 s budget) | interactive start | `PI_OFFLINE` |
| `pi.dev/api/latest-version` | start | `PI_OFFLINE` or `PI_SKIP_VERSION_CHECK` |
| package update checks, missing-package installs | start | `PI_OFFLINE` |
| fd / rg download from GitHub releases | first use when not on PATH | `PI_OFFLINE` (then skipped with a warning) |
| `/share`, bug-report upload, `/login`, MCP OAuth | only when asked | — |

Done: `PI_TELEMETRY=0` and `PI_OFFLINE=1` as image `ENV` (Dockerfile.pi, beside
`RTK_TELEMETRY_DISABLED=1`), in `.env`, exported by `pi-local.sh` (where
`PI_OFFLINE=0` *unsets* the variable: several call sites test it for presence,
so `"0"` would read as offline), and `enableInstallTelemetry: false` written to
pi's settings so a bare `pi` is covered too. `fd-find` added to the image (pi
accepts `fdfind`); `docs/container.md` had listed `fd` as installed when it was
not. Unaffected: `PI_AUTO_UPDATE` (plain npm, run by pi-local.sh) and the model
requests to forge.

### The browser: pi-mcp-adapter -> pi's built-in MCP

`.pi/extensions/browser-mcp.ts` registers the server with `pi.registerMcpServer`
(mcp.json interpolates variables only in `env`/`headers`, not `url`). Measured,
bytes of tool schemas per request, same flags, live server:

| Surface | Bytes | Notes |
| --- | --- | --- |
| adapter (5 + `mcp` + `mcpScript`) | 14,394 | |
| built-in, rest `deferred` (5 + `tool_search`) | 11,087 | no batching; **tool list changes** |
| built-in, rest `codemode` (5 + `codemode`) | **13,273** | **chosen** |
| built-in, `deferred` + `codemode` | 13,920 | |

Findings on the way, each measured:

- **`deferred` is wrong for this template.** `tool_search` declares what it
  loads, so each search changes the tool list at the top of the prompt. A child
  using it: declared browser tools 0 -> 20 -> 41, and llama prefills of 5,623 /
  6,694 / 10,397 tokens against a few hundred per steady turn. With `codemode`
  exposure the declared list was identical across every request (3 of 3 parent,
  5 of 5 child).
- **pi's codemode throws on a tool with no description** (`tool.description.trim()`,
  `extensions/codemode/tool.js:195`). Our `Agent`/`StopAgent`/`AgentStatus` had
  none, to save tokens; they now carry `""` (17 bytes each).
- **The adapter left most browser output unfenced.** `browser-guard.ts` matched
  `browser_*`/`mcp__browser__*`; the adapter's `mcp` and `mcpScript` proxy tools
  matched neither, so the 93 non-direct tools' output and every script result
  reached the model without the untrusted-content envelope. Now: nested calls go
  through `_beforeToolCall`/`_afterToolCall` (pi `agent-session.js`
  `_executeNestedToolCall`), so each is fenced, and the guard also fences a
  `codemode` result whose script called a browser tool (`parentToolCallId` on
  `tool_execution_start`). Children never had the guard at all; now they do.
- **Children.** They had the browser only because the adapter is a pi package
  they discover. Now `subagent-denylist.ts` adds `browser-mcp.ts` +
  `browser-guard.ts`, `child-builtins.ts` hands pi's `mcp` + `codemode`
  factories, and the five direct tools plus `codemode` join the child's session
  allowlist, which is fixed before MCP tools register (measured: without that,
  a child's first request declared only `tool_search`). All gated on
  `BROWSER_MCP_NATIVE=1`, exported by pi-local.sh. An agent with its own `tools`
  list keeps exactly that; the orchestrator's explorer excludes both files.
- **Lost:** the adapter's 8 KiB output cap (pi truncates MCP text at 20 KB and
  `compaction-guard` caps every result against the remaining window) and its
  lazy connect (the built-in connects at session start; the first prompt waits
  up to 10 s for a server with direct tools, which pi-local.sh starts first).

Verified live on pi 1.4.0 through the real launch command: a parent opened a
page and reached `list_tabs` from a script, every browser result fenced; a
child opened a page through codemode with the five direct tools declared from
its first request. Leftovers: pi-local.sh removes `pi-mcp-adapter` from pi's
settings `packages` (installed, it would register `/mcp` and replace the
built-in; pi would then report each registration as an extension error).

## 7. Live checks in the rebuilt pi container (2026-11-01)

`pi-agent:latest` rebuilt from `Dockerfile.pi` (stdin, no build context: the
file copies nothing, and the repo has no `.dockerignore`). Nothing in it
compiles: apt, a prebuilt rtk, `npm --ignore-scripts`, and pip/uv wheels —
checked first with `pip download --only-binary`; the one sdist, `grapheme`, has
`.c` files but no `ext_modules`. Image: pi 1.4.0, rtk 0.45.0, `fdfind`, `rg`,
`PI_TELEMETRY=0`, `PI_OFFLINE=1`.

Run as a separate container (`instantcoffee-pi-audit`, since removed) with the
operator's `data2` home and this checkout mounted over the repo path, driven
through tmux. The launcher pruned `pi-mcp-adapter` from the real settings in
`data2` on its first start, as designed.

| Check | Result |
| --- | --- |
| Startup, first TUI frame | 88.7 s, 87.8 s (repo cwd), 77.2 s (`/tmp` cwd) |
| Browser task in the TUI | direct tools + codemode; script result rendered fenced (`[codemode (browser)]`); cache hit 96.5% |
| Delegation | **found S7**, fixed, re-run passes: the child reached `execute_js` from codemode |
| `/loop`, 2 iterations | 0 `loop-rules` entries with L1; control with L1 reverted: 1 |

- **S7 — a child's codemode could not reach 92 of the browser tools.** Listing
  the five direct tools by name in the child's allowlist turned on pi's MCP
  filtering (any entry starting with `mcp__` sets `_allowlistFiltersMcp`), so
  `tools.mcp__browser__execute_js does not exist`. The allowlist now carries
  `mcp__browser__*`; the test drives pi's own `createToolNameMatcher`.
- Not observed directly: whether `browser-guard` fenced a child's results. The
  child transcript records result sizes only; covered by the path test and the
  parent's observed fencing.
- Harness traps, both mine: piping the launcher through `tee` gave pi pipes
  instead of a TTY and it waited on stdin (the same `-p` trap as §1).

## 8. Follow-ups, 2026-11-01

- **#26004 confirmed on b12019, and the handoff's instrument for it was blind.**
  Both "restored context checkpoint" and "forcing full prompt re-processing"
  are `SLT_TRC` (trace) in b12019 (`tools/server/server-context.cpp` 4289/4293),
  so a default-verbosity log can never show either; zero of both proved
  nothing. Measured instead with two requests straight to llama (45,218-token
  prompt, `max_tokens` 1): changing only the last question prefilled **16**
  tokens and reused 45,201 (0.7 s against 43.9 s cold); the control, changing
  only the system prompt, prefilled all 45,218. Ordinary tool turns in the
  overnight loop prefilled 0.1-1.3 % of a 23-29K context.
- **Strata stranded tool calls: 0** on 198 completions, all with reasoning, none
  with `<tool_call>` markup inside the reasoning. No forge patch needed. (The
  overnight loop was stopped early at the operator's request; these two answers
  came from better instruments rather than from a longer run.)
- **A child's browser output is fenced** in what its model is sent
  (`context/testing/pi-audit/extensions/probe-fencing.ts`, hooked on `context`):
  4 of 4 results fenced; control with `browser-guard` left out of the child: 3
  of 3 unfenced.
- **pi container start: 77-89 s -> ~12 s to the first frame.** vendor/ loads
  from a per-launch copy on the container's disk (`mirror_extensions` in
  lib.sh; 111-113 s from the bind mount against 3-5 s local, copy ~4 s).
  First attempt also loaded `.pi/extensions` from the copy and **failed every
  launch inside the repo**: pi discovers the repo's own `.pi/extensions`, so a
  second path registered "browser" and `stack_status` twice. `.pi/extensions`
  now load from the repo (one path, deduplicated); children take their
  `.pi/extensions` paths from `PI_STACK_REPO_ROOT`. Verified in a container from
  the repo and from a scratch directory: 12.3 s, no load errors, `/stack status`
  finds the repo.
- **`/loop` pauses on `agent_settled.aborted`** (pi >= 1.1): Esc during a
  provider-error retry left the last message at `error`, and the loop counted a
  provider failure and went on. Its own degenerate-repetition abort is
  excluded. `tests/settled-aborted.test.ts`.
- **observe** sends pi's `durationMs` as `duration_ms` (the paired-start clock
  also counted every extension's hooks). `provider_stream_event` **not
  adopted**: on this stack the first provider event and the first
  `message_update` coincide (gap 0 ms on 3 of 3 requests; forge re-streams in
  ~3 chunks), so it would add a per-chunk handler for nothing.
- **pi-subagents-lite**, the rest of the upstream review: tools of same-named
  extensions merged (source pin; the function stays private), the per-API
  output-limit field (forge gets `max_completion_tokens`, which pi sends, not a
  second `max_tokens`), thinking precedence explicit > frontmatter > pi
  per-model > `defaultThinking` > pi default with a `parent` choice (the judge
  now also gets `defaultThinking` when its frontmatter is silent; unset here),
  and the viewer keeping finished blocks while a message streams (real in pi
  1.4, but not by upstream's mechanism: pi adds the streaming message to
  `state.messages` only at `message_end`).
- `pi-local.sh --print-only` no longer starts the browser server; `kld-run.sh`
  preflight credits the memory of the llama it is about to stop.
