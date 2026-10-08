# Repository layout

Every file and directory, and what it is for.

```
.gitignore              .env.local, caches
.env                    committed config + the three seat ids (no secrets)
.env.local.example      machine-local override template (copy to .env.local)
versions.lock           what the stack is pinned to — the observe submodule, rtk
docker-compose.yml      the observe dashboard service, and nothing else
Dockerfile.pi           optional: pi + the browser stack in a container of its own
.github/workflows/ci.yml  CI pipeline (lint, syntax, the no-model suites)
badges/ci.json          shield.io endpoint JSON for the CI badge
README.md               what this is, how to run it, and where to read more
docs/                   public documentation
  pi.md                 /loop, subagents, /prinny, /persona, provider config
  orchestrator.md       ORCHESTRATOR=1: opus, haiku children, the fable advisor
  context-budget.md     MCP-without-MCP, filtered bash output, the browser
  reasoning.md          thinking on the Anthropic path; what replaced
                        REASONING_EFFORT and THINK_LANG
  benchmarking.md       what verifies this branch; every suite CI runs
  troubleshooting.md    symptoms, in the order you are likely to hit them
  container.md          running pi in a container; mount rules; moving a home
  layout.md             this file
  changelog.md          what changed, and when
prompts/
  delegate.md           the standing nudge to use subagents
  web-untrusted.md      how web-derived text is fenced as data, not instructions
  orchestrator/         orchestrator-mode prompt (main.md) and its agent types:
                        worker.md, explorer.md, advisor.md
  README.md             why this is applied client-side and not in the engine
scripts/
  lib.sh                shared helpers, sourced by every script here
  pi-local.sh           launch pi against the hosted Anthropic API (the only client)
  pi-container.sh       the same, in the Dockerfile.pi container; creates it on
                        first use, reuses it after, delegates to pi-local.sh
                        inside. A no-op wrapper when already in one
  browser.sh            drive Chrome as a CLI (resolves .env, runs browser_cli.py)
  browser_cli.py        the client: server lifecycle, tool discovery, tool calls
  mcp.sh                call an MCP server as a CLI (wraps mcp2cli)
  rtk.sh                install/pin rtk, and --check its filters against the
                        allow-list they are trusted to match
  untrusted_content.py  the untrusted-content envelope, Python side
  test_browser_cli.py   standalone unit tests for the browser CLI's arg parsing
  test_container_env.py unit tests for the container's env forwarding
  test_untrusted_content.py  the envelope's tests, including the two-sided
                        contract that keeps the Python and TypeScript copies honest
.pi/extensions/
  browser-guard.ts      turns a browser-tool timeout into an instruction
  compaction-guard/     bounds pi's carried-over summary, caps oversized tool
                        results, and shows the model its context budget — in
                        every session, not just /loop
    src/                pure modules — the cap, the notice (no pi import)
    tests/              node --test suite
  observe/              streams sessions to instantcoffee-observe (OBSERVE_*);
                        no tools, zero tokens
    src/                mapper (pi event → observe event), linker (subagent →
                        spawning call), sender (ordered, bounded, never blocks)
    tests/              node --test suite incl. a replay of a real session
vendor/pi-toolresult-guard/  keeps a malformed tool result from EXITING pi.
                        Loaded FIRST, so every other tool_result handler reads a
                        content array that is already safe. No tool, no command,
                        zero tokens
  src/normalize.ts      what pi can render, and what to send instead (no pi import)
  extensions/index.ts   the tool_result handler, and why that hook is the one
                        place a result can still be corrected
  tests/                the repair cases, each with its crashing control
vendor/pi-loop-mode/    /loop — fork of pi-loop-mode@2.5.4, loaded from here
  FORK.md               what was changed and why (context-recovery race)
  tests/                node --test suite for the fork's recovery ladder
vendor/pi-subagents-lite/  Agent — fork of pi-subagents-lite@1.11.0, in-process
  FORK.md               why this package of 341, the wire cost, what was changed
  src/models/model-precedence.ts  the ladder a child's model is resolved
                        through, and where a per-agent-type override sits
  src/spawn/result-cap.ts  bounds a BACKGROUND result — the one path the guard
                        cannot see, because pi injects it without a tool_result
  tests/                the fork's suite, incl. the mode seed and agent types
vendor/instantcoffee-observe/  the dashboard, run as the `observe` service.
                        A GIT SUBMODULE: github.com/coffeegrind123/openclaude-observe
                        (to be renamed instantcoffee-observe). Its commit is the
                        pin, so the observe extension and the server it posts to
                        move together
vendor/prinny-channel/  /prinny — Matrix channel, converted from a Claude plugin.
                        A GIT SUBMODULE: github.com/coffeegrind123/pi-prinny-channel
  FORK.md               what the conversion changed, and why forwarding exists
  extensions/index.ts   the pi extension: tools, /prinny, forwarding, lifecycle
  src/                  pure modules — client, gate, block renderer, access
  server/               the Matrix sidecar, run as a child process
  tests/                the unit and e2e suites, no node_modules
vendor/rtk-pi/          bash output filtering — fork of rtk's own pi extension
  FORK.md               the measurements, and why it filters an allow-list
  src/gate.ts           what is filtered and what is accepted back (no pi import)
  extensions/index.ts   the pi coupling, and nothing else
  tests/                node --test suite for the gate
vendor/pi-persona/      /persona — a character voice over invariant engineering.
                        A GIT SUBMODULE: github.com/coffeegrind123/pi-persona,
                        pinned here by commit. `git submodule update --init`
                        after a plain clone, or the directory is empty
  FORK.md               provenance, the six departures, the wire measurements
  src/prompt.ts         the <active_persona> block; names only tools pi says are
                        selected this turn (no pi import)
  src/processor.ts      the extraction turn — inline vs jq walk, sized to the window
  src/immersion.ts      the first-message thinking-mode marker
  extensions/index.ts   the pi coupling: /persona, before_agent_start, status line
  src/switch.ts         retiring the outgoing persona — the half of a switch a
                        file delete cannot do, and how it survives a resume
  tests/                the suite, incl. the factory against a real pi import
mcp/servers.json        registry of MCP servers reachable via scripts/mcp.sh
mcp/adapter.json        pi-mcp-adapter config: how pi reaches the browser server
skills/mcp-tools/       pi skill teaching the model to use scripts/mcp.sh
skills/browser/         pi skill for CLI mode (scripts/browser.sh)
skills/browser-tools/   pi skill for adapter mode (native browser_* tools)
context/                why things are the way they are
  README.md             index of the above, and the conventions it follows
  design/decisions.md   all design decisions, flags, seat choices
```

Two things this branch deleted, so that a reader looking for them knows they are
not misplaced: the local-model layer (`modes/`, `patches/`, `Dockerfile.forge`,
the `/stack` extension, and the ~74 scripts that only made sense on a GPU) and
the `modes.md` and `quants.md` pages that described it. The history of what
those did is in `docs/changelog.md` and `context/`.

---

[← back to the README](../README.md)
