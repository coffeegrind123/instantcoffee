# Handoff — 2026-08-17 (subagents)

The previous handoff's brief was "subagents on a local model". That is done: a
fork is vendored, measured, wired and pushed. This one carries what changed, what
is verified against a real run and what is not, and two jobs for the next
session — both of them about **seeing** what the subagents are doing.

Detail lives in `design/decisions.md` under the four 2026-08-17 entries. This
file is the map.

---

## What landed

| Commit | What |
| --- | --- |
| `db78545` | Vendor `pi-subagents-lite@1.11.0`, deny prinny, bound the loop, add the `loop` tool |
| `11d7ec4` | Wire the answer verifier; subagents on by default |

### Paths

| Path | Change |
| --- | --- |
| `vendor/pi-subagents-lite/` | **New.** The fork. 55 tests. `FORK.md` is the full account. |
| `vendor/pi-loop-mode/extensions/index.ts` | `loop` registered as a **tool**, not only a command. 48 tests (39 + 9 new). |
| `.pi/extensions/compaction-guard/src/output-cap.ts` | `planOutputCap` takes its advice from the caller. 39 tests. |
| `scripts/pi-local.sh` | Loads the fork; exports `SUBAGENT_VERIFY` and `SUBAGENT_EXTRA_EXTENSIONS`. |
| `.env` | `SUBAGENTS_ENABLED=1`, `SUBAGENT_VERIFY=1`, `SUBAGENT_EXTRA_EXTENSIONS` documented. |
| `context/testing/subagents-loop-verifier.md` | **New.** Hand-testing script for all of it. |

### The shape of it, in one paragraph

Subagents run **in process** via pi's own `createAgentSession` — on one llama
slot a child `pi -p` process buys no parallelism, it queues, while costing a
second system prompt. The three tools cost **710 chars / ~178 tokens** a turn,
measured on the wire. A child does **not** inherit the parent's `-e` flags: it
discovers its own extensions, so `.pi/extensions/` reaches it and `vendor/` does
not. prinny is denied unconditionally on top of that; loop and rtk are put back
deliberately. Every subagent has a 40-turn ceiling. Answers are checked against
the task by a judge that sees only the task and the answer.

---

## Verified live, and not

**Verified against the real model:** the 27B drives the description-free schema
(it set `run_in_background` on an undescribed boolean and polled `AgentStatus`
uninstructed); the background result cap firing at 14,218 → 10,495 chars with the
parent then reading the spill file on its own; `"verification":"passed"` on a
real delegation; the tool surface at 710 chars on the wire; a subagent's own
inventory showing no prinny and no `Agent`; `git status --short` unrewritten
before rtk was put back.

**Not verified live, and worth attacking first:**

- **The verifier's failure path.** Judge says NOT_ADDRESSED → repair → still
  fails. Unit-tested only. The judge's real false-positive rate is unknown, and
  whether a second attempt from a drifted child beats the first is an open
  question.
- **The anchor.** Needs a child that fills its own 32k window and compacts.
- **The turn ceiling** at 40, and the steer-then-abort ladder.
- **prinny forwarding of a background subagent result.** Answered from source
  only: `forwardToMatrix` returns early unless a room has a *live*
  `awaitingReply` entry, and `forwardResult` deletes every live entry when a run
  settles. So a subagent that finishes **after** the run settled answers into
  the void — the Matrix user who asked never sees it. Failure mode is silence,
  not a leak, but it is a real gap.

---

## Next session — two jobs, both about visibility

### 1. Find who has already built the Claude-Code-style agent taskbar

Claude Code shows a status line entry like

```
· 2 shells ·  ← for agents  ↓ to manage
```

alongside the MCP indicator (`🔌 MCP: 1 server enabled · prinny: connected`), and
the arrow keys **hop into a running agent's shell** — you can watch it work and
come back. That is the ability to reproduce here.

**Check what we already have before building anything.** The vendored fork ships
more of this than it looks:

- `src/ui/agent-widget.ts` — a live widget with `setStatus(key, text)`, and a
  `statusBarFormat: "full" | "compact"` setting already plumbed through config.
- `src/ui/conversation-viewer.ts` — a viewer for a child's transcript.
- `src/ui/menu/menu-running-agents.ts` — view / steer / continue / stop / clear.
- `src/ui/viewer-keys.ts`, `src/ui/searchable-select.ts` — key handling.

So the question is probably not "build a fleet view" but "what is missing between
the `/agents` menu and a one-keystroke hop from the status line", and whether
someone upstream has solved the keyboard affordance better.

**Candidates already spotted while choosing the package** (all read, none
adopted):

| Package | What it has | Why it is interesting |
| --- | --- | --- |
| `pi-subagents` (nicobailon, 244k/mo, 3182★) | `src/tui/fleet.ts`, `src/tui/render.ts` (103KB), `test/unit/fleet.test.ts`, `render-fork-badge.test.ts` | The most developed TUI of the three. Its agent registry even names "FleetView's default when no agent name is typed", so the fleet concept is first-class. |
| `@tintinweb/pi-subagents` (40k/mo, 895★) | `src/ui/fleet-list.ts`, `src/ui/agent-widget.ts`, `src/ui/conversation-viewer.ts`, a `fleetView` setting, `test/fleet-list.test.ts` | In-process like ours, so its widget code is directly portable. Also has mid-run steering. |
| `@quintinshaw/pi-dynamic-workflows` (27k/mo, 419★) | an interactive `/workflows` TUI | Different shape — workflow-centric rather than agent-centric — but the live-progress problem is the same. |

The catalog is `pi.dev/packages?name=subagent` — 341 matches, server-rendered, so
one `curl` gets the whole top-50 by downloads. `context/design/decisions.md`
(2026-08-17, "subagents: picked in-process") has the parse and the ranking.

**What the answer has to respect here**, and it is why the popular one may still
be the wrong donor: everything is charged against a 32k window and one slot. A
fleet view that costs nothing in the model's context is free; one that adds tool
schema is not. Measure any adoption on the wire, the same way the rest of this
was measured.

### 2. A visual indicator for verifier work and its verdict

Right now **a passing verification is completely invisible**, and that is a real
defect rather than a nicety. Measured: `src/ui/renderer.ts` does not read
`details.verification` at all. The field is set on every checked answer
(`passed` / `repaired` / `failed` / `unparsed` / `errored` / `skipped-*`) and
surfaced in the tool result's details, but the only things a person sees are:

- a `ui.notify` line, and only on failure or an unreadable verdict;
- an appended note in the answer text, and only when something went wrong.

So "checked and fine" and "never checked at all" look identical, which is
exactly the distinction the verifier exists to make. Worse, there is no
indication while the judge is *running* — the session simply appears to pause,
on a stack where pauses are already common because of the single slot.

Two things to build:

- **In-flight:** the widget should show that verification is happening, the same
  way it shows an agent running. It is a real model call on the shared slot and
  the user is waiting on it.
- **Verdict:** a compact marker on the finished agent line. `passed` should be
  quiet but present (a tick), `repaired` and `failed` should be loud, and
  `skipped-*` should say which kind of skip, because "empty answer" and "the run
  was cut off" are different problems with different fixes.

`src/ui/renderer.ts` (`renderAgentToolResult`, `renderSubagentResult`) and
`src/ui/agent-widget.ts` are where this goes. `record.verification` is already
populated and already in `buildAgentDetails` — the data exists, nothing reads it.

---

## Where to look

- `vendor/pi-subagents-lite/FORK.md` — why this package out of 341, what was
  changed, the wire measurements, and the prefix-cache correction.
- `vendor/pi-loop-mode/FORK.md` — the loop tool, and the three non-obvious
  things it needed.
- `context/design/decisions.md`, the four 2026-08-17 entries.
- `context/testing/subagents-loop-verifier.md` — how to exercise all of it by
  hand, including the two paths that have never fired live.

## One environment note

The box was at 911 MiB free with 4.5 GiB swapped during this session, and a
`browser_navigate` timed out at exactly its 25s budget because Chrome's CDP
endpoint stopped answering under that pressure — the supervisor logged the
strike and the recovery. The navigation itself had succeeded. `/free --idle 8`
reclaimed two 11h-idle sessions (~500 MB RSS, 700 MB swap); the dev-tool caches
were already empty. If the browser stalls again, check `free -h` before
suspecting the tool.
