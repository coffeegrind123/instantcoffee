# Subagents, the loop and the verifier — what we wrote down, and who reads it back

**Twenty-third pass, 2026-08-23.** Self-contained: it assumes none of the
twenty-two documents before it. §1 is the whole machine in seven drawings, §2 is
pi itself, §3 is the event bus, §4–§9 are the seven packages, §10 is what has to
stay true, §11 is the seven findings, §12 the evidence, §13 what is open, §14 the
pattern across twenty-three passes, §15 where to look.

Everything here is measured against **pi 0.84.2**, the version installed at
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent`, and against the
tree as it stands in this repository. Where a line number is quoted it is from
that install. Where a number is quoted about this box — a session file's size, a
fingerprint, a share of duplicates — it was read off the disk while this was
written, and the probe that reads it again is named.

---

## 0. The axis, and why it is a new one

Twenty-two passes have each taken one question and asked it of every surface in
the stack. The sixteen so far:

```
   1. what we RETURN from a handler          X5
   2. what we PASS to a call                 Z1–Z4, AA4
   3. which events REACH us at all           AA1
   4. what a host function's answer CAN say  AA2, AB1, AB3
   5. WHEN it can say it, and how long the   AB1–AB4
      answer stays true
   6. WHO RECEIVES IT, and what they see     AC1–AC5
      when nobody does
   7. WHO OBEYS IT — and does the code that  AD1–AD7
      obeys ever see the instruction
   8. WHAT WE BELIEVE ABOUT OURSELVES        AE1–AE7
   9. WHAT WE DECIDED NOT TO DO              AF1–AF6
  10. WHAT WE NAMED — then go and open it    AG1–AG6
  11. WHERE ELSE IT BELONGS — write the      AH1–AH6
      scan, not the third fix
  12. WHAT WE PROMISED — quote the sentence  AI1–AI5
      and find the path where it is false
  13. WHO IS ALLOWED TO ASK — name every     AJ1–AJ5
      actor that reaches the decision
  14. WHAT THE TEST IS A PROXY FOR — write   AK1–AK5
      the set down twice and enumerate the
      difference
  15. WHAT WE START AND NEVER FINISH — name  AL1–AL9
      the ONE place that ends it, then the
      paths that miss it
  16. WHAT HAPPENS WHILE WE ARE WAITING —    AM1–AM6
      name what else runs at this await
```

This pass is the seventeenth:

> **WHAT WE WROTE DOWN, AND WHO READS IT BACK.** For every value this stack puts
> outside its own heap — a file, a child process's stdio, another session's
> context, another process's environment, a buffer held for later — name the
> writer, the reader, and the moment in between. Then ask what the reader does
> when the bytes are **absent, malformed, stale, or from a different world than
> the writer's**.

It is the natural successor to the sixteenth. That pass asked what happens
between two statements in one process. This one asks what happens between two
statements in two *different* processes, or two different sessions, or the same
process on two different days — where the only thing that survives the gap is
what somebody wrote down.

### 0.1 Why it is not "check your error handling"

Every read in this stack is already inside a `try`. That is exactly why the axis
is worth a pass: **a `catch` is where two different facts go to become one.**

```
   try { return JSON.parse(readFileSync(file)) }
   catch { return {} }                     ← "there is no file"
                                           ← "there is a file and nobody could
                                              read it"
```

Both leave by the same door and arrive as the same value, and the *next* thing
the code does is decide whether it may overwrite that file. AN1 is that sentence
twice, in two packages, and the second instance turns off the Matrix permission
relay.

So the axis is mechanical rather than intuitive. Open every read of something
outside the heap and ask three questions:

```
   1. WHO WROTE IT?              this process, a minute ago? another process?
                                 a person with an editor? a previous version of
                                 this code?
   2. WHAT ARE THE WAYS IT       absent · malformed · truncated · STALE ·
      CAN BE OTHER THAN          written by a newer version · written by another
      EXPECTED?                  writer entirely
   3. WHAT DOES THE READER DO    and in particular: is the reader about to
      WITH EACH?                 REPLACE it?
```

Question 3 is what separates a nuisance from a finding. A misread config that
falls back to defaults is a nuisance. A misread config that falls back to
defaults **and is then written back** is the destruction of the only copy.

### 0.2 The four shapes

Every finding in §11 is one of these.

```
   ── 1. TWO FACTS, ONE CATCH ─────────────────────────────────────────────────
      Absent and unreadable arrive as the same value, and the caller acts on
      the wrong one.
      AN1 (both instances)

   ── 2. TWO READERS, TWO QUESTIONS ───────────────────────────────────────────
      One artefact, one writer, and readers that disagree about what "ready"
      means — with the weaker question in the reader that talks to a person.
      AN2, AN7

   ── 3. THE VALUE THAT OUTLIVED ITS MEANING ──────────────────────────────────
      Written down when it was true, read back after the thing it described was
      replaced.
      AN3 (a device id for a token that is gone)

   ── 4. WRITTEN FOR A READER THAT NEVER ARRIVES ──────────────────────────────
      Recorded, forwarded or buffered, and then read by nobody — or by nobody on
      the path that mattered.
      AN4 (a knob that never reaches the process), AN5 (thirty-three writes and
      one read), AN6 (a buffer a throwing run discards)
```

Shape 2 has the sharpest rule attached, and it is the rule this pass would give
anybody adding a second reader: **if two pieces of code answer the same question
about the same artefact, one of them is going to be wrong, and it will be the one
that is easier to write.** `existsSync(entry)` is easier to write than
"fingerprint the source and compare it to the stamp", and it is what three
readers wrote.

### 0.3 What is NOT this axis

- **Leaks.** "Nothing ends this" is the fifteenth pass (AL).
- **Interleaving.** "What else runs at this await" is the sixteenth (AM).
- **Missing events.** "Which events reach us at all" is AA1.
- **Serialisation bugs in the narrow sense.** Nothing here writes a `Date` and
  reads back a string. The state that crosses these boundaries is deliberately
  plain, and §13.2 records that as a measured negative rather than assuming it.
- **Prompt content.** What the model is told is AD and AJ. This pass is about
  what a *reader* is told, and the model is only one of the readers.

---

## 1. The machine

Seven packages run in **one node process**, inside **one pi session**, against
**one llama.cpp slot** — plus **one child process** (the Matrix sidecar) and
**one staged runtime directory** outside the repository. Nothing here is a
service; everything is an extension of the same process, except the two things
that are not, and both of those are on this pass's axis.

### 1.1 Panel A — the whole machine, and the five places state comes to rest

```
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  ONE NODE PROCESS · ONE pi SESSION · ONE llama.cpp SLOT · ONE THREAD       │
   │                                                                            │
   │   OPERATOR ──────► pi TUI ─────────────────────────────────┐               │
   │   (terminal)        │  /loop  /agents  /prinny  /stack     │               │
   │                     │                                      │               │
   │   SENDER ─► Matrix ─┴─► prinny sidecar ──stdio(MCP)──► prinny ext          │
   │   (a phone)              (its own PROCESS, from a STAGED   │               │
   │                           RUNTIME outside the repo)        │               │
   │                                                            ▼               │
   │                                              ┌───────────────────────┐     │
   │                                              │   pi AgentSession     │     │
   │                                              │   (the PARENT)        │     │
   │                                              └───────────┬───────────┘     │
   │                                                          │                 │
   │   ┌── extensions bound to that session, in LOAD order ────┴────────┐        │
   │   │  stack   browser   loop   guard   subagents   prinny   rtk    │        │
   │   │    1        2       3       4         5         6       7     │        │
   │   └────────────────────────────────────────┼──────────────────────┘        │
   │                                            │  Agent tool                   │
   │                                            ▼                               │
   │                              ┌───────────────────────────┐                 │
   │                              │  AgentManager             │                 │
   │                              │    ├ SlotTable (1 slot)   │                 │
   │                              │    ├ Watchdog (5 s tick)  │                 │
   │                              │    └ SpawnCoordinator     │                 │
   │                              └─────────────┬─────────────┘                 │
   │                                            │  runAgent()                   │
   │                                            ▼                               │
   │                              ┌───────────────────────────┐                 │
   │                              │  CHILD AgentSession       │                 │
   │                              │  SessionManager.inMemory  │ ← never written │
   │                              │  its own extensions/tools │   anywhere      │
   │                              └─────────────┬─────────────┘                 │
   │                                            │  the answer                   │
   │                                            ▼                               │
   │                              ┌───────────────────────────┐                 │
   │                              │  the VERIFIER             │                 │
   │                              │   judge  → a THIRD session│                 │
   │                              │   repair → the child's own│                 │
   │                              └─────────────┬─────────────┘                 │
   │                                            │                               │
   │                    ┌───────────────────────┴───────────────────┐           │
   │                    ▼                                           ▼           │
   │      foreground: the Agent tool's          background: a `subagent-result` │
   │      own result                            message, delivered as followUp  │
   └────────────────────────────────────────────────────────────────────────────┘

   AND FIVE PLACES STATE COMES TO REST, OUTSIDE ALL OF IT:

     ~/.pi/agent/                 the session file · the subagents config ·
                                  the verifier's log · pi's own settings
     ~/.pi/agent/channels/prinny/ .env · access.json · pi.json · queue.json ·
                                  watermark.json · the inbox · the crypto store ·
                                  runtime/ (a compiled copy of server/src)
     <project>/.pi/               a project's subagents config, a project's agents
     <project>/                   .pi-loop-log.jsonl · GOAL.md and its siblings
     /tmp/                        the output logs · the two spill directories
```

The sixteenth pass named the four things that can be **in flight at the same
moment**. This pass needs a different list: the five **kinds of gap** a value
crosses, and what each one loses.

```
   1. PROCESS → DISK → PROCESS     everything above. Loses: the writer's context.
                                   Gains: a person with an editor.
   2. PROCESS → PROCESS            the sidecar's stdio, `pi.exec`'s bash, git,
                                   rtk. Loses: types, and every guarantee that
                                   is not in the bytes.
   3. SESSION → SESSION            the loop's state entry, the subagent
                                   transcript. Loses: every module-scoped
                                   variable, because they are per PROCESS.
   4. SHELL → PROCESS              .env → `pi-local.sh` → `process.env`.
                                   Loses: anything the script does not forward.
   5. NOW → LATER, IN MEMORY       a buffer, a memo, a pending queue. Loses:
                                   whatever an early return skipped.
```

Every finding in §11 is one of those five: AN1 is (1), AN2 is (1) and (2), AN3
is (1), AN4 is (4), AN5 is (3), AN6 is (5), AN7 is (1).

### 1.2 Panel B — everything that leaves the heap

This is the new drawing, and it is what §10.2 tabulates. Each `▸` is a value that
is written somewhere this process does not own, and each `◂` is a read of one.

```
   THE SESSION FILE  ~/.pi/agent/sessions/--<cwd>--/<id>.jsonl
     ▸ pi            every message, every tool call, every compaction
     ▸ loop          `loop-state` custom entry, ~6.6 KB, on 33 paths     ✘ AN5
     ▸ subagents     `subagent-turn` custom entries, ≤60 per delegation
     ▸ prinny        `prinny-output` custom entries
     ▸ stack         `stack-report` custom entries
     ◂ loop          `restoreLoopState(getBranch())` — the LAST one, at
                     session_start
     ◂ the TUI       every renderer, on load and after a compaction
     ▪ never the MODEL: `sessionEntryToContextMessages` returns [] for a
       `type: "custom"` entry (§2.3)

   THE SUBAGENTS CONFIG  ~/.pi/agent/subagents-lite.json
     ▸ /agents       every menu mutation, whole-file                     ✘ AN1
     ◂ ConfigStore   at every session_start
     …and its project twin  <project>/.pi/subagents-lite.json
     ▸ /agents       model keys and concurrency only (ADR-0008)
     ◂ ConfigStore   merged over the global layer

   THE VERIFIER'S LOG  ~/.pi/agent/subagent-verify.jsonl
     ▸ verify-log    one JSONL line per judge/repair call                ✘ AN4
     ◂ a person      and nothing else, by design

   pi's OWN SETTINGS  ~/.pi/agent/settings.json
     ▸ pi            /config, and `scripts/pi-local.sh` at install
     ◂ pi-settings   `hideThinkingBlock`, for the viewer                 ✘ AN7

   THE CHANNEL STATE  ~/.pi/agent/channels/prinny/
     ▸ ext + sidecar .env — credentials, and the device the sidecar mints ✘ AN3
     ▸ ext + sidecar access.json — the allowlist, two processes, one file
     ▸ ext           pi.json — delivery, forwarding, the PERMISSION MODE  ✘ AN1
     ▸ sidecar       queue.json + watermark.json — the durable inbox
     ▸ sidecar       inbox/<event>-<name> — inbound attachments
     ▸ sidecar       crypto/ — the Olm store, "never shared between two bots"
     ▸ bootstrap     runtime/ + runtime/.source-stamp                    ✘ AN2
     ◂ ext           RUNTIME_ENTRY, and until this pass nothing read the stamp

   THE LOOP LOG  <cwd>/.pi-loop-log.jsonl
     ▸ loop          one line per iteration event, 5 MB then rotate
     ◂ /loop stats   `readLogEntries` — the tail of `.1` then of the file

   THE SPILLS  /tmp/pi-tool-output-<pid>-…/  ·  /tmp/pi-subagent-result-<pid>-…/
     ▸ guard         a capped tool result's full text
     ▸ result-cap    a capped background answer's full text
     ◂ the MODEL     by path, from the marker — and capped again on the way back

   THE OUTPUT LOGS  /tmp/pi-agent-outputs/<agentId>.log
     ▸ output-file   off by default (`outputTranscript`)
     ◂ a person, with `tail -f`

   THE ENVIRONMENT  .env → scripts/pi-local.sh → process.env
     ▸ the operator  SUBAGENT_*, LOOP_TOOL_CHECK, PRINNY_*, RTK_*
     ◂ the packages  at the moment each one asks                        ✘ AN4

   THE PIPES
     ▸◂ prinny ext ⇄ sidecar   newline-delimited JSON-RPC 2.0 over stdio
     ▸◂ loop → bash            `pi.exec` + an EXIT-trap marker (AB1)
     ▸◂ rtk → rtk binary       a rewritten command, 2 s budget
     ▸◂ subagents → git        `detectEnv`, `resolveWorktree`

   IN MEMORY, FOR LATER
     ▸◂ NoticeBuffer           setup warnings, released after the run    ✘ AN6
     ▸◂ NudgeSchedule          who is owed an answer, and when
     ▸◂ pendingSteers          a steer for a session that does not exist yet
     ▸◂ globalThis             the spawn depth, the compaction lock
```

Nine surfaces carry a **✘**. Seven of them are §11.

### 1.3 Panel C — the four kinds of round trip, and what each one can lose

The single most useful fact in this document is that the four gaps lose
different things, and a reader written for one of them is wrong about the others.

```
   ┌─ 1. DISK, SAME PROCESS, SECONDS LATER ────────────────────────────────────┐
   │  `writeSettings` then `readSettings`. Loses nothing — unless somebody      │
   │  edited the file in between, which is the whole reason it is a file.       │
   │  THE QUESTION: can a person have touched it? For every file in this stack  │
   │  the answer is yes, and three of them are documented as hand-editable.     │
   └───────────────────────────────────────────────────────────────────────────┘
   ┌─ 2. DISK, ANOTHER PROCESS, CONCURRENTLY ──────────────────────────────────┐
   │  `access.json` has two writers — the extension's `/prinny allow` and the   │
   │  sidecar's pairing gate — and `.env` has two: the extension's `configure`  │
   │  and the sidecar's `onCredentials`. Both sides read-modify-write.          │
   │  THE QUESTION: is the merge a merge, or a replace? (§8.2 — and the         │
   │  sidecar's `readAccessFile` rebuilds from a fixed key list, which is why   │
   │  `pi.json` exists as a separate file rather than as keys in `access.json`.)│
   └───────────────────────────────────────────────────────────────────────────┘
   ┌─ 3. DISK, ANOTHER VERSION OF THIS CODE ───────────────────────────────────┐
   │  The staged runtime is a COMPILED COPY of `server/src`, and the checkout   │
   │  moves. `.source-stamp` is the only thing that can tell them apart.  AN2   │
   │  THE QUESTION: what does "built" mean, and does every reader mean it?      │
   └───────────────────────────────────────────────────────────────────────────┘
   ┌─ 4. A NEW SESSION, THE SAME PROCESS ──────────────────────────────────────┐
   │  `/new`, `/resume`, `/fork`, a reload. `state` is replaced from the        │
   │  branch; every OTHER module-scoped variable is not.                  AN5   │
   │  THE QUESTION: which of my variables is per session, and which is per      │
   │  process? They look identical — the difference is one indentation level.   │
   └───────────────────────────────────────────────────────────────────────────┘
```

The fourth is the one this stack keeps rediscovering. AM4 was `runToken` not
moving at a session swap; AN5 is a memo that has to be dropped at the same two
events, for the same reason, one field over.

### 1.4 Panel D — one delegation, with the writes marked

```
   parent turn
     │
     ├─ model emits  Agent{prompt, agent?, run_in_background?, worktree_path?}
     │
     ├─ tool_call handlers, IN ORDER, awaited                    [sequential]
     │    prinny  needsApproval? ── up to 300 s waiting for a phone
     │    rtk     bash only
     │    subagents  toolCallListener injects model/thinking/_resolvedAgent
     │               ▪ onto a structuredClone (§2.4) — so NOT into the session
     │
     ├─ executeAgentTool
     │    ◂ the agent registry, from ~/.pi/agent/agents/*.md and .pi/agents/*.md
     │    ◂ the merged config (global ⊕ project ⊕ session)                 AN1
     │    │
     │    └─ coordinator.spawn → manager.spawn
     │         ▸ AgentTranscript.brief  →  a `subagent-turn` session entry
     │         └─ runAgent(…)
     │              ◂ ~/.pi/agent/subagents-lite-prompt.md   (systemPromptMode)
     │              ◂ AGENTS.md / CLAUDE.md                  (includeContextFiles)
     │              ◂ skills, extensions — through the denylist
     │              ▸ NoticeBuffer, for everything above that went wrong   AN6
     │              └─ the child's run
     │                   ▸ a `subagent-turn` entry per TURN
     │                   ▸ /tmp/pi-agent-outputs/<id>.log   (off by default)
     │
     ├─ the settlement chain
     │    the verifier
     │      ▸ ~/.pi/agent/subagent-verify.jsonl — prompt, reply, and the parse
     │      ▸ a `subagent-turn` entry, phase `verify` / `repair`
     │    ▸ AgentTranscript.finalize — one line, how it ended
     │
     └─ the answer
          foreground → a tool result → capped by the guard → SPILLED to /tmp
          background → `subagent-result` → capped by result-cap → SPILLED
                       ▸ and the marker names the file, which is the model's
                         only route back to the rest of it
```

Two things on that drawing decide two of §11.

**The `NoticeBuffer` is the only thing that survives a setup failure.** Every
sentence about a misconfigured agent file is held in it until the run is over,
and until this pass a run that threw took the buffer with it — AN6.

**A `type: "custom"` entry is written, rendered, and never sent to the model.**
That is what makes a subagent's whole reasoning affordable on a 32k window, and
it is what makes the loop's 6.6 KB state entry invisible to everything except the
disk — AN5.

### 1.5 Panel E — one loop iteration, with the writes marked

```
   sendLoopTurn ─ pi.sendMessage({customType:"loop"}, {triggerTurn:true, …})
     │  ▲ refuses if compactionInFlight(), defers 5 s, remembers the DIRECTIVE
     ▼
   the agent run … agent_end
     │
     ├─ 18 rungs, in order. Every one of them ends in
     │      state.lastNotice = …
     │      persistState(pi)      ▸ a `loop-state` entry, ~6.6 KB        AN5
     │      logIteration(event)   ▸ a line in .pi-loop-log.jsonl
     │      notify(ctx, …)        → the TUI, or the log when hasUI is false
     │
     │   ▸ 33 call sites of `persistState` in the file
     │   ◂ ONE read: `restoreLoopState(getBranch())`, at session_start
     │
     ├─ the goal check
     │      ▸ bash -lc "trap 'printf …__PI_LOOP_CHECK_COMPLETED__:%d…' EXIT
     │                  ( <the operator's command> )"
     │      ◂ the marker's PRESENCE — never its value (AB1)
     │
     └─ agent_settled
          ▸ ctx.compact() — and pi rebuilds `agent.state.messages` from the
            branch, which is the one place a session entry becomes context
```

`persistState` is the loop's whole memory of itself, and the shape of the
finding is in the two arrows: thirty-three writes, one read, and until this pass
no test that the write said anything new.

### 1.6 Panel F — the config layers, and who may write them

This is AN1 in one drawing. Four files with the same shape and four different
answers to "what if I cannot parse it".

```
                                    READ FAILS            NEXT WRITE
   ┌──────────────────────────────┬─────────────────────┬───────────────────────┐
   │ ~/.pi/agent/                 │ absent = malformed  │ REPLACES IT           │
   │   subagents-lite.json        │ = `{}`, silently    │                  ✘AN1 │
   ├──────────────────────────────┼─────────────────────┼───────────────────────┤
   │ <project>/.pi/               │ "malformed", with   │ REFUSES, with a       │
   │   subagents-lite.json        │ a console warning   │ warning        ✔ADR-8 │
   ├──────────────────────────────┼─────────────────────┼───────────────────────┤
   │ channels/prinny/pi.json      │ absent = malformed  │ REPLACES IT           │
   │   (the permission mode)      │ = defaults          │                  ✘AN1 │
   ├──────────────────────────────┼─────────────────────┼───────────────────────┤
   │ channels/prinny/access.json  │ QUARANTINED to      │ writes a fresh one    │
   │   (the allowlist)            │ .corrupt-<ts>, log  │                     ✔ │
   └──────────────────────────────┴─────────────────────┴───────────────────────┘

   The two that were right are the two somebody had written a sentence about:

     ADR-0008 / config-io.ts   "a malformed project file is never overwritten"
     server/src/access.ts      "Quarantine rather than delete: it may be a
                                hand-edit the user wants back, and starting from
                                defaults beats refusing to run."

   The two that were wrong are the two whose failure path had no sentence at all.
```

### 1.7 Panel G — the staged runtime, and the three readers

AN2 in one drawing.

```
   THE CHECKOUT                          THE STAGED RUNTIME
   vendor/prinny-channel/server/         ~/.pi/agent/channels/prinny/runtime/
     package.json            ─┐            package.json
     tsconfig*.json           ├─ copy ──►  tsconfig*.json
     src/*.ts                ─┘            src/*.ts
        │                                  node_modules/     (~105 MB)
        │  sha256(path+content)             dist/server.js   ← the ENTRY
        └──────────────────────────────►   .source-stamp     ← the FINGERPRINT

   WHO ASKS "IS IT READY?"                       BEFORE          NOW
   ────────────────────────────────────────  ──────────────  ──────────────
   server/bin/prinny-channel.mjs  bootstrap  entry + stamp   entry + stamp
   extensions/index.ts  startupBlocker()     entry only  ✘   stagedState()
   extensions/index.ts  /prinny status       entry only  ✘   stagedState()
   extensions/index.ts  configure            entry only  ✘   stagedState()
   scripts/pi-local.sh  the launch line      entry only  ✘   --staged

   MEASURED ON THIS BOX, 2026-08-23, while this was written:

     .source-stamp                f297f2b6…      staged 2026-08-22 14:43
     fingerprint of the source    53371dab…
     the staged src/ is MISSING   connect.ts     — the twenty-first pass's fix
                                                   for a connect loop that
                                                   builds one matrix-js-sdk
                                                   client per failed attempt

     so: `built` from three readers, and a sidecar running code from before AL3.
```

---

## 2. pi itself

### 2.1 What an extension is, and when its factory runs

An extension is a module with a default-exported factory. pi calls the factory
**once per session**, not once per process, and node's module cache means the
MODULE body runs once. So:

```
   src/events.ts
     const toolCallListener = …            ← MODULE scope: one per PROCESS
     export function setupEventListeners(pi) {
       let unregisterTerminalInput          ← FACTORY scope: one per SESSION
       pi.on("session_start", async … => {
         let x                              ← per session_start
       })
     }
```

Nothing in the type system says which you got, and the difference is one
indentation level. The fifteenth pass found its leaks there. The sixteenth found
AM4 there. This pass finds AN5 there: a memo at module scope that answers a
question about a session.

### 2.2 The session file is the only thing that survives

`SessionManager` appends one JSON line per entry to
`~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` and keeps the whole
list in memory. Two properties matter for this axis, both read out of pi's own
source rather than assumed:

```
   _appendEntry(entry)                              session-manager.js:754
     this.fileEntries.push(entry)
     this.byId.set(entry.id, entry)
     this.leafId = entry.id            ← EVERY append MOVES THE LEAF
     this._persist(entry)              ← appendFileSync, one line

   getBranch(fromId)                                              :943
     walk parentId from the leaf to the root, reverse, return
```

So `pi.appendEntry` is not a side channel: it is a node in the conversation
tree, and the loop's thirty-three writes per run are thirty-three nodes on the
chain every later `getBranch()` walks.

### 2.3 A `custom` entry is written, rendered, and never sent to the model

```
   sessionEntryToContextMessages(entry)             session-manager.js:166
     "message" | "custom_message" | "branch_summary" | "compaction"
                                          →  a context message
     "custom"                              →  []      ← NOTHING. ever.
```

That is the property the subagent transcript is built on (§5.6) and the property
that makes the loop's state entry invisible to everything but the disk. It is
also why `restoreLoopState` can walk them back out: they are still on the branch
after a compaction, because compaction rewrites what is CONTEXT, not what is
recorded.

The renderer side is `getEntryRenderer(customType)` →
`CustomEntryComponent.rebuild()`, which wraps the call in a `try` and draws
`[<type>] renderer failed: <message>` if it throws
(`modes/interactive/components/custom-entry.js:35`). So a renderer that cannot
read an entry written by an older version is a line in the transcript, not a
crash — checked, not assumed.

### 2.4 The tool arguments an extension mutates are a `structuredClone`

`pi-subagents-lite` writes `model`, `thinking` and `_resolvedAgent` onto the
`Agent` tool's arguments from a `tool_call` handler, and the tool then reads
them. The obvious worry on this axis is that those injected keys are persisted
into the assistant message and replayed to the model on every later turn. They
are not:

```
   validateToolArguments(tool, toolCall)      pi-ai/utils/validation.js:280
     const args = structuredClone(toolCall.arguments)
     …
     return args                     ← a COPY; `beforeToolCall` gets this
   prepareToolCall(…)                         pi-agent-core/agent-loop.js:393
     return { kind: "prepared", toolCall, tool, args: validatedArgs }
                                     ↑ the ORIGINAL, and this is what is
                                       persisted with the assistant message
```

§13.2 records it as a measured negative, because "the listener mutates the
arguments" is exactly the sentence that sounds like a context leak.

### 2.5 What a session swap does to everything an extension is holding

```
   AgentSession.dispose()                                     :556
     abortRetry() · abortCompaction() · abortBranchSummary() · abortBash()
     this.agent.abort()
     this._extensionRunner.invalidate("This extension ctx is stale after …")
     this._disconnectFromAgent()
     this._eventListeners = []
```

Two consequences this pass depends on:

1. **`invalidate()` makes every later `pi.*`/`ctx.*` call throw.**
   `appendEntry` is `runtime.assertActive(); runtime.appendEntry(…)`
   (`loader.js:271`), so a persist on a stale handle is an exception, not a
   silent no-op. AN5's memo is therefore set *after* the append, never before.
2. **The new session's branch is a different branch.** `restoreState` reads it
   and gets `defaultState()` for a fresh one — which is exactly the payload
   `/loop end` writes, and the reason the memo has to be dropped at both session
   transitions.

---

## 3. The event bus

### 3.1 Handlers are awaited, in registration order

`ExtensionRunner.emit` awaits each handler in turn (`extensions/runner.js:579`),
so two extensions' handlers for the same event never interleave and a slow
handler delays every handler after it. The load order comes from
`scripts/pi-local.sh` and is behaviour, not decoration (§1.7 of the twenty-second
pass's write-up; unchanged this pass).

### 3.2 Which emitters thread a result

```
   emit()                generic. session_before_* only; LAST TRUTHY WINS,
                         `cancel` short-circuits.       runner.js:579
   emitMessageEnd()      threads `message`.                       :610
   emitToolResult()      threads content/details/isError/usage.   :649
   emitToolCall()        first block wins.                        :701
   emitContext()         threads `messages`.                      :747
   emitBeforeProviderRequest()  threads `payload`.                :776
   emitBeforeAgentStart()       COLLECTS messages from all handlers. :837
```

For this axis the relevant row is `emitToolResult`: the guard's output cap
REPLACES the text block a tool produced, and writes the original to a spill file.
So the tool result the session records is the capped one, and the only copy of
the rest is in `/tmp`, under a directory named for this process's pid (§7.2).

### 3.3 The events that decide a session's boundaries

```
   session_start      the factory has run; `restoreState` reads the branch;
                      the config is re-read from disk; AN5's memo is dropped
   session_shutdown   the earlier of the two on a swap; AN5's memo is dropped
                      here too, so nothing can be built between them
```

Every module-scoped variable that answers a per-session question has to appear in
both handlers. §10.1's seventh invariant is that sentence.

---

## 4. The loop — `vendor/pi-loop-mode`

A fork of pi-loop-mode 2.5.4. Registers `/loop`, a `loop` tool, and thirteen
event handlers. All of its state is module-scoped, and it writes to exactly two
places outside the heap.

### 4.1 `persistState` — thirty-three writes and one read

```
   ▸ persistState(pi)   →  pi.appendEntry("loop-state", persistedLoopState(state))
       33 call sites
       ~6.6 KB per entry, dominated by `lastAssistantTexts` (4 × 1,500 chars)
   ◂ restoreLoopState(ctx.sessionManager.getBranch())
       ONE call site: `session_start`
       takes the LAST matching entry, spread over `defaultState()`
```

`PERSISTED_WINDOW` is the bound on what goes in, and its docstring is worth
reading before changing any of it: the in-memory window and the persisted one
have to be the same size, or a restored loop runs with a shorter memory than the
one that was saved (W2).

What was missing is on the other side of the arrow. Measured on a real session
file on this box:

```
   session file                                   948,959 bytes
   loop-state entries                          59
   bytes they account for                     392,245   41.3% of the file
   mean entry                                   6,648
   byte-identical to the entry before it           24   41% of the entries
```

§11.5 is the fix, and `aa5 session` re-runs the measurement.

### 4.2 The loop log — the other file, and the only one anybody reads

`.pi-loop-log.jsonl` in the working directory, one JSON line per iteration event,
rotated to `.1` at 5 MB. `readBoundedTail` reads the last `maxBytes` and drops
the partial first line; `/loop stats` reads `.1` then the live file and scopes to
`Date.parse(entry.ts) >= state.startTime`.

The vocabulary on this box, from the live file (2,690 entries):

```
   continue 913 · stuck 856 · done 266 · check_error 186 · check_failed 111
   blocked 88 · context_pressure 87 · completed 70 · check_unrunnable 44
   compact 35 · operator_abort 14 · regression 7 · audit 6 · context_compact 3
   turn_deferred 2 · error 1 · context_recovered 1
```

`formatLoopStats` counts `stuck + audit + regression + rescue_start + compact` as
interventions and `continue` as productive iterations. Both are definitions
rather than defects, and both are recorded here because a reader of that summary
should know that `continue` is 913 of ~2,300 iterations rather than all of them.

### 4.3 The goal check — a marker across a process boundary

`runGoalCheck` is `pi.exec("bash", ["-lc", wrapCheckCommand(cmd)], { timeout })`.
The round trip is a bash `EXIT` trap printing
`__PI_LOOP_CHECK_COMPLETED__:<status>` and the loop reading its **presence**:

```
   marker present  → bash reached its own exit, and `result.code` is the answer
   marker absent   → the check died without finishing. Not a failing check; an
                     absent one.
```

The marker's VALUE is deliberately not used — reading an exit code out of a
child's stdout would let a check that prints attacker-controlled text choose its
own verdict. That is AB1 and AC3; unchanged this pass, and it is the model this
pass would copy for any new process boundary.

---

## 5. Subagents — `vendor/pi-subagents-lite`

A fork of pi-subagents-lite 1.11.0. Registers `Agent`, `StopAgent`,
`AgentStatus`, `/agents`, a widget, and eight event handlers.

### 5.1 The config, in three layers and two files

```
   session overrides   in memory only, dropped at every reload
   project layer       <project>/.pi/subagents-lite.json  — model keys and
                       concurrency only, and only in a TRUSTED project
   global layer        ~/.pi/agent/subagents-lite.json    — everything
   built-in defaults   config-io.ts
```

Each file stores only its own keys; the merged config is never written back.
`ConfigStore.reload()` re-reads both at `session_start`. §11.1 is what the global
layer did when it could not be read.

### 5.2 The agent registry, from four directories

```
   default agents                       default-agents.ts
   ~/.pi/agent/agents/*.md              user
   <project>/.agents/agents/*.md        shared    ⎫ trusted projects only
   <project>/.pi/agents/*.md            project   ⎭
```

Frontmatter is parsed by a hand-written splitter (`parseFrontmatter`): flat
`key: value` pairs and `- item` lists, no nesting. `tools`, `extensions`,
`skills` and the two `exclude_*` keys each accept `true|all|false|none` or a
list, and U6 and the exclude-list fix exist because two of them did not.

### 5.3 Concurrency, and why the slot table is exact

`SlotTable` counts by `holdsSlot`, not by `status === "running"`, because the
slot is held right through the verification window where the status is already
terminal. The default limit is **1** — measured: a child that grew to 18k tokens
took the parent's next call from 2,117 cached tokens to zero and from 442 ms to
2,949 ms.

### 5.4 The spawn bracket

`enterSubagentSpawn()` / `exitSubagentSpawn()` wrap `reloadAndMap()` +
`createAndConfigureSession` only — not the child's run. It is a DEPTH counter
published on `globalThis.__PI_SUBAGENT_SPAWN_DEPTH__` so packages that must not
import each other can read it. Three factories read it: `pi-loop-mode` and
`.pi/extensions/stack.ts` return early; `.pi/extensions/compaction-guard` gates
only its lock-taking on it.

### 5.5 The setup warnings, and the buffer that holds them

Five checks during a spawn write into a buffer rather than notifying, because a
notification between `tool_use` and `tool_result` in the session tree is a 400:

```
   agent "X": both tools and exclude_tools set — tools (whitelist) wins
   agent "X": both extensions and exclude_extensions set
   Custom prompt file not found: … Falling back to replace mode.
   extension "Y" not found in loaded extensions
   tool "Z" not found …
```

Every one is a sentence about the agent file the operator just edited, and §11.6
is where they went.

### 5.6 The transcript — a child's turns, in the parent's session

`AgentTranscript` writes one `subagent-turn` custom entry per child TURN, bounded
at 60 entries, 4,000 characters and 120 lines each, and finalised with one line
saying how the run ended. It costs the model nothing on any turn (§2.3) and it is
switched off with `SUBAGENT_TRANSCRIPT=0` — which, until §11.4, could not be set
from `.env`.

---

## 6. The verifier

Three layers, cheapest first: the **anchor** (no model call — restate the brief
after a compaction, into a run that was going to happen anyway), the
**structural gate** (no model call — empty answers and cut-off runs), and the
**judge** (one small model call, in a session of its own with no tools and one
turn), with up to `SUBAGENT_VERIFY_ROUNDS` repairs, each re-judged.

For this axis, three properties matter.

**It writes its own evidence.** `verify-log.ts` appends one JSONL line per model
call — the prompt, the raw reply, and the parse the stack acted on. The parse is
the point: a reply and a verdict side by side is the only thing that can show the
parser was wrong, and four findings in this series (S2, U4, V5, W5) each needed
exactly that. The file is `~/.pi/agent/subagent-verify.jsonl`, bounded at 2,000
lines with 4,000 characters per field, and switched off with
`SUBAGENT_VERIFY_LOG=0` — which, until §11.4, could not be set from `.env`
either.

**Its three switches are read at one moment.** `SUBAGENT_VERIFY`,
`SUBAGENT_VERIFY_ROUNDS` and `SUBAGENT_VERIFY_TIMEOUT_MS` are all read in
`runVerification`, when the child SETTLES. One of them used to be read in
`buildVerifyDeps`, when the child STARTED, so an operator turning verification
off during a long delegation still got a verification.

**`verifyAnswer` never throws.** Its catch is this layer's "the check did not
happen" path: the child's answer is preserved and annotated `errored`. That is
the contract every other failure mode in this file is measured against.

---

## 7. The guard — `.pi/extensions/compaction-guard`

Three jobs, all measured over 42 real compaction points and 259 assistant turns:
cap the summary pi carries forward, show the model its context budget above 60%,
and cap a single tool result to a share of what context is LEFT. Plus a fourth
since AM2: take the compaction lock on pi's behalf.

### 7.1 It is NOT inert in a child

`.pi/extensions/**` is on a child's discovery route, deliberately — capping a
child's own tool output is one of the things it is for. Only the lock-taking is
gated on `bornInsideSubagentSpawn()`, because the lock is process-global and the
question is per-session.

### 7.2 The spill files, and the one round trip the model makes

A capped result is replaced by head + marker + tail, and the marker names a file:

```
   [output capped at 84% context: 17790 chars, kept about 2034.
    Full output: /tmp/pi-tool-output-4127-Xy9/bash-call_17.txt.
    Prefer a narrower command — grep, a line range, --max-count — over
    reading it all back]
```

Two facts about that round trip, both stated rather than guarded:

- **The recovery path is capped by the same rule.** A `cat` of the spill file is
  a tool result, so it is capped again, at the same allowance, to the same head
  and tail — and a new spill file is written. The advice line exists because of
  this: the way back in is `grep` or a line range, not the whole file.
- **A marker can outlive its file.** `pruneSpills` keeps the newest 50 per
  directory, and `pruneDeadSpillDirs` removes whole directories whose owning
  process is gone (AL9). A marker from 51 results ago names a file that is not
  there — which the guard's own header argues is fine, because a marker that old
  left the context several compactions ago.

---

## 8. prinny — `vendor/prinny-channel`

```
   Matrix  ⇄  sidecar (child PROCESS, MCP over stdio)  ⇄  extension  ⇄  pi
                  ▲
                  └─ runs from a STAGED, COMPILED COPY of server/src
```

The sidecar is a separate process because `@prinny/bot` pulls in matrix-js-sdk
and its Rust crypto WASM: loading it is ~15 s of *synchronous* work in-process,
and the library writes to stdout while it loads. `src/config.ts` measures the
import of the built sidecar at **27.5 s in this container**, and
`connectTimeoutSeconds` is **120** because of it.

### 8.1 The staged runtime

`server/bin/prinny-channel.mjs` stages `server/src` plus three build files into
`~/.pi/agent/channels/prinny/runtime`, runs `npm install` and `tsc`, and records
`sha256(path + content)` over the source in `.source-stamp`. Content rather than
mtime, deliberately: a clone, a branch switch and a checkout all rewrite mtimes,
and each would otherwise cost a minute of installing for a byte-identical tree.

§11.2 is what the other readers of that directory thought "built" meant.

### 8.2 Four state files and how many writers each has

```
   FILE            WRITERS                        READ-MODIFY-WRITE?
   ──────────────  ─────────────────────────────  ─────────────────────────────
   .env            extension `updateEnv`,         yes, both sides. The merge is
                   sidecar `updateEnvFile`        deliberate: the sidecar mints
                                                  the token and device the
                                                  extension must not lose  AN3
   access.json     extension `updateAccess`,      yes, both sides. The sidecar
                   sidecar `saveAccess`           rebuilds from a FIXED key
                                                  list, which is why settings
                                                  live in pi.json instead
   pi.json         extension only                 yes — and §11.1
   queue.json      sidecar only                   yes, re-read per operation
   watermark.json  sidecar only                   monotonic, never decreases
```

The `access.json` note is worth keeping: `readAccessFile` enumerates the keys it
knows and `saveAccess` writes that object back, so a key it does not know is
dropped on the next pairing. `src/config.ts` says so where `SETTINGS_FILE` is
declared, and that sentence is why `pi.json` exists at all — *"Settings kept
there would vanish the first time a stranger messaged the bot, which is about the
worst possible time to lose the delivery configuration."*

### 8.3 The transport

Newline-delimited JSON-RPC 2.0 over the child's stdio. `McpChild` carries a
partial line between chunks, dispatches on `method` FIRST (AK3 — a
server-initiated *request* has both an id and a method, and reading it as a reply
resolved the client's own outstanding call with nothing), and answers an
unimplemented server request with `-32601` rather than silence.

---

## 9. rtk and stack

`vendor/rtk-pi` registers one `tool_call` handler, for `bash` only, and awaits
`rtk rewrite` with a 2-second timeout inside it. It runs AFTER prinny and
declines to rewrite a command a person approved as written (AJ3).

`.pi/extensions/stack.ts` registers `/stack` and a read-only `stack_status` tool,
and is inert in a child. It reads `.env` and `docker-compose.yml` from the repo
root — the one place in the stack that reads the operator's `.env` directly
rather than through `process.env`, and therefore the one reader §11.4 does not
apply to.

---

## 10. What has to stay true

### 10.1 The invariants, and the seventh this pass adds

```
   1  The completion gate is opened exactly once, and never with the run's own
      promise.
   2  A record's concurrency slot is held for as long as `holdsSlot`, which is
      wider than `status === "running"` — it covers the verification.
   3  `verifyAnswer` never throws. An unverified answer beats no answer.
   4  A delivery that did not happen is the loudest thing this stack can report.
   5  Vendor packages do not import each other. Shared facts are `globalThis`
      keys or duplicated modules with a stated protocol and a cross-package test.
   6  A construct with two teardowns has one ORDER, written in one function.
   ──────────────────────────────────────────────────────────────────────────
   7  A file this stack could not parse is never silently replaced, and a
      value it wrote down is never read back by a question weaker than the one
      that wrote it.
      (AN1, AN2 — and §10.2 is the ledger it is enforced against.)
```

### 10.2 The round-trip ledger — this pass's artefact

Every value that leaves this process's heap. **GAP** is which of §1.1's five it
crosses. **IF IT IS NOT WHAT THE WRITER MEANT** is the question this pass asks.

```
   #   WHAT / WHERE                          GAP  WRITER → READER        VERDICT
   ──  ────────────────────────────────────  ───  ─────────────────────  ───────
   THE SESSION FILE
    1  `loop-state` custom entry              3   loop → loop            ✘ AN5
       absent → defaultState, which is correct for a new session
       stale  → a rewind reads an older one, which is what a rewind means
       33 writes, 1 read, 41% of one real session file, 41% of those
       byte-identical to the entry before them
    2  `subagent-turn` custom entry           3   subagents → the TUI    ✔
       absent → nothing drawn. malformed → the renderer defaults every
       field (`renderer.ts:240`) and pi catches a throw anyway
    3  `prinny-output`, `stack-report`        3   ext → the TUI          ✔
    4  every message pi writes                3   pi → pi                ✔
       `sessionEntryToContextMessages` tolerates null content explicitly:
       "old versions, forks, or hand-edited files"

   CONFIG AND SETTINGS
    5  ~/.pi/agent/subagents-lite.json        1   /agents → session_start ✘ AN1
       malformed → read as `{}`, then REPLACED by the next menu toggle
    6  <project>/.pi/subagents-lite.json      1   /agents → session_start ✔
       malformed → warned, and never written (ADR-0008)
    7  channels/prinny/pi.json                1   /prinny set → readSettings ✘ AN1
       malformed → all defaults, permissionMode `all`→`off`, then REPLACED
    8  channels/prinny/access.json            2   ext + sidecar          ✔
       malformed → quarantined by the sidecar, with a log line
    9  ~/.pi/agent/settings.json              1   pi → pi-settings       ✘ AN7
       read from a path that ignored PI_CODING_AGENT_DIR
   10  ~/.pi/agent/subagents-lite-prompt.md   1   /agents menu → runner  ✔
       absent or empty → notify + fall back to `replace` mode
   11  ~/.pi/agent/agents/*.md and friends    1   a person → discovery   ✔
       unparseable frontmatter → the file is skipped (no `name`)

   CREDENTIALS AND THE CHANNEL
   12  channels/prinny/.env                   2   ext + sidecar          ✘ AN3
       the device id outlives the token it belonged to
   13  runtime/ + .source-stamp               3   bootstrap → 4 readers  ✘ AN2
       stale → three readers said "built"
   14  queue.json / watermark.json            1   sidecar → sidecar      ✔
       unreadable → logged, starts fresh; the watermark only ever advances
   15  inbox/<event>-<name>                   1   sidecar → the model    ✔
       name sanitised, event id makes it stable across a re-download
   16  crypto/ (the Olm store)                1   sidecar → sidecar      ✔ (AM1)
       "must never be shared between two running bots" — which is what the
       channel lifecycle exists to guarantee
   17  bot.pid                                1   sidecar → sidecar      ✔
   18  approved/<mxid>                        2   ext → sidecar          ✔
       a file drop; an empty one is removed rather than acted on

   LOGS AND SPILLS
   19  <cwd>/.pi-loop-log.jsonl               1   loop → /loop stats     ✔
       unparseable lines are skipped one by one; rotation keeps a tail
   20  ~/.pi/agent/subagent-verify.jsonl      1   verifier → a person    ✔
       pruned by line count every 50 writes, through a tmp + rename
   21  /tmp/pi-tool-output-<pid>-…            1   guard → the MODEL      ✔*
       *the recovery path is capped by the same rule (§7.2); stated
   22  /tmp/pi-subagent-result-<pid>-…        1   result-cap → the MODEL ✔*
   23  /tmp/pi-agent-outputs/<id>.log         1   subagents → a person   ✔

   PROCESSES
   24  the sidecar's stdio                    2   ext ⇄ sidecar          ✔ (AK3)
       an unparseable line is logged verbatim, not summarised
   25  the goal check's stdout                2   bash → loop            ✔ (AB1)
       presence of a trap marker; the value is deliberately not read
   26  `rtk rewrite`                          2   rtk → the bash tool    ✔
       2 s budget, fail-open
   27  git, in detectEnv / resolveWorktree    2   git → subagents        ✔

   THE ENVIRONMENT
   28  SUBAGENT_VERIFY / _ROUNDS / _TIMEOUT   4   .env → the packages    ✔
   29  SUBAGENT_EXTRA_EXTENSIONS              4   .env → the denylist    ✔
   30  SUBAGENT_TRANSCRIPT                    4   .env → transcript      ✘ AN4
   31  SUBAGENT_VERIFY_LOG / _LOG_FILE        4   .env → verify-log      ✘ AN4
   32  LOOP_TOOL_CHECK                        4   .env → the loop tool   ✔
   33  RTK_DISABLED                           4   inline only, by design ✔

   IN MEMORY, FOR LATER
   34  NoticeBuffer (setup warnings)          5   spawn → the operator   ✘ AN6
       a throwing run discarded it; headless nobody heard it either way
   35  NudgeSchedule (who is owed an answer)  5   settlement → the model ✔ (AM5)
   36  pendingSteers                          5   steer → onSessionCreated ✔ (AI3)
   37  __PI_SUBAGENT_SPAWN_DEPTH__            5   subagents → 3 factories ✔
   38  __PI_COMPACTION_IN_FLIGHT__            5   4 writers → 4 readers   ✔ (AM2)
```

Thirty-eight rows; nine carry a ✘ and seven of those are §11. (Rows 5 and 7 are
one finding, and rows 30 and 31 are one finding.)

### 10.2.1 The findings by DISTANCE

The fifteenth pass's most useful statistic was that seven of nine findings were
"distance zero" — the correct version of the same construct visible on screen.
The sixteenth's was the opposite. This axis has a third distribution, and it says
where to look:

```
   AN1  the two right answers are in the SAME FILE and in a sibling
        package: `readProjectRaw` is nine lines below `readGlobalRaw`. distance 0
   AN2  the right answer is in a file that cannot be imported,
        because it boots on load.                                    distance 1
   AN3  the right answer is 40 lines below, in the other arm of the
        same command.                                                distance 0
   AN4  the rule is in the comment DIRECTLY ABOVE the block that
        breaks it.                                                   distance 0
   AN5  one function, one call site, and thirty-three writers.       distance 0
   AN6  the right answer is `reportDrop`, thirty lines away in the
        same package.                                                distance 0
   AN7  the right answer is the sibling module that answers the same
        question.                                                    distance 0
```

**Six of seven are distance zero, and in five of those the correct version is
literally adjacent to the defective one.** That is not a coincidence and it is
the practical lesson of the axis: this class of defect is not found by looking
harder at one place. It is found by putting the two places side by side and
noticing they disagree — which is why five of the seven fixes are an
**extraction** and two of the extractions are *deliberate duplicates with a
cross-package test*.

### 10.3 The bounds, all of them

```
   WHAT                              BOUND        WHERE
   ────────────────────────────────  ───────────  ──────────────────────────────
   a subagent's turns                40           turn-tracking.ts
   grace turns after the soft limit  6            config-io.ts
   verification rounds               1 (max 3)    verify-runner.ts
   one verification model call       300 s        DEFAULT_VERIFY_TIMEOUT_MS
   the accumulated brief             6,000 ch     MAX_BRIEF_CHARS
   the judge's view of it            1,500 ch     JUDGE_BRIEF_CHARS
   the judge's view of the answer    4,000 ch     JUDGE_ANSWER_CHARS
   transcript entries per agent      60           transcript-entry.ts
   chars / lines per entry           4,000 / 120  ditto
   verify-log lines                  2,000        verify-log.ts
   spill files per directory         50           spill.ts
   spill directories                 dead pids    spill.ts (AL9)
   the loop log                      5 MB + a .1  loop-log.ts
   the persisted loop windows        8/5/4/10     PERSISTED_WINDOW
   one persisted assistant text      1,500 ch     PERSISTED_WINDOW.textChars
   the compaction lock               300 s        compaction-lock.ts ×4
   provider errors before a pause    10           MAX_PROVIDER_ERRORS
   context cooldowns before a pause  3            MAX_CONTEXT_COOLDOWNS
   goal-check errors before a pause  3            MAX_CHECK_ERRORS
   the MCP handshake                 120 s        connectTimeoutSeconds
   a permission request              300 s        permissionTimeoutSeconds
   the queued Matrix backlog         50 / 7 days  server/src/queue.ts
   an attachment, either way         50 MB        server/src/inbox.ts
   ────────────────────────────────  ───────────  ──────────────────────────────
   the SESSION FILE                  NONE         and 41% of one real file was
                                                  loop state — §11.5 removes the
                                                  duplicates, not the bound
```

### 10.4 The globals

```
   __PI_SUBAGENT_SPAWN_DEPTH__   a NUMBER (a depth, not a flag).
                                 written by pi-subagents-lite/src/shell.ts
                                 read by pi-loop-mode, stack.ts, compaction-guard
   __PI_COMPACTION_IN_FLIGHT__   { owner, at }, stale after 300 s.
                                 four implementations; one cross-check test
```

Re-checked this pass: the four copies of the lock still agree on the key, the
bound, the stale rule and the owner check, and `beginCompaction` still refuses
when another owner holds it — which is what makes the guard's `beginCompaction`
a no-op while `pi-loop-mode` holds the lock for a compaction it asked for.

### 10.5 The switches, and where each one has to be named

New this pass, because §11.4 is a scan rather than two fixes.

```
   SWITCH                      READ IN                      .env → process?
   ──────────────────────────  ───────────────────────────  ───────────────
   SUBAGENTS_ENABLED           scripts/pi-local.sh          n/a (a flag)
   SUBAGENT_VERIFY             agents/agent-manager.ts      ✔
   SUBAGENT_VERIFY_ROUNDS      agents/agent-manager.ts      ✔
   SUBAGENT_VERIFY_TIMEOUT_MS  agents/agent-manager.ts      ✔
   SUBAGENT_EXTRA_EXTENSIONS   agents/subagent-denylist.ts  ✔
   SUBAGENT_TRANSCRIPT         agents/transcript-entry.ts   ✔  new
   SUBAGENT_VERIFY_LOG         agents/verify-log.ts         ✔  new
   SUBAGENT_VERIFY_LOG_FILE    agents/verify-log.ts         ✔  new
   LOOP_TOOL_CHECK             pi-loop-mode/extensions      ✔
   PRINNY_ENABLED              scripts/pi-local.sh          n/a (a flag)
   RTK_ENABLED                 scripts/pi-local.sh          n/a (a flag)
   RTK_DISABLED                rtk-pi/extensions            inline, by design
```

`tests/env-switches.test.ts` scans the package's own sources for every
`env.SUBAGENT_*` and fails when one of them is not exported by the launcher, so
the ninth switch cannot arrive the way the seventh and eighth did.

---

## 11. The findings

Seven, AN1–AN7, all fixed, each with a regression test that fails when the fix is
removed and a probe that prints BEFORE and NOW so it is its own control.

### 11.1 AN1 — the read that could not parse, and the write that finished it off

**Shape 1.** `vendor/pi-subagents-lite/src/config/config-io.ts` and
`vendor/prinny-channel/src/config.ts`

Two files, one shape:

```js
   // subagents
   function readGlobalRaw() {
     try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
     catch { return {}; }
   }

   // prinny
   let raw = {};
   try { const parsed = JSON.parse(readFileSync(file, 'utf8'));
         if (parsed && typeof parsed === 'object') raw = parsed; }
   catch { /* Absent or unreadable: defaults */ }
```

One `catch`, two facts. **Absent** is the ordinary state of a fresh install and
reads correctly. **Malformed** is a file with content in it, and reading it as
empty says the operator has no settings when what is true is that nobody could
read them.

That much is survivable. What is not is the next paragraph of the same story:
both stores then WRITE. `ConfigStore` holds the `{}` as its global layer and the
first `/agents` toggle calls `saveGlobal(this.globalRaw)`; prinny's `/prinny set`
does `settings = { ...settings, [key]: value }` and `writeSettings(settings)`.
Each writes the defaults plus the one key that changed, through a tmp file and a
rename, over the only copy.

**Driven through the real store, with one comma removed:**

```
   on disk BEFORE                       277 bytes, 6 agent keys, 2 concurrency
   effective default model after load   null            (was forge/qwen3.8-27b)
   effective concurrency after load     {"default":1}   (was 2, providers too)
   on disk AFTER one widget toggle      { "agent": { "showCompletionCards": false } }
```

**The prinny instance is the one with teeth.** `readSettings`' own docstring
makes the promise its catch cannot keep:

> Anything malformed falls back to the default for that key alone; a typo in one
> setting must not silently reset the rest, **because the rest includes the
> permission mode**.

True of a bad VALUE — `asEnum` and `asPositiveInt` are per key. False of a bad
FILE, which is the likelier typo in hand-edited JSON. `permissionMode` goes from
`all` to `off`, and the Matrix approval relay — the thing that shows a person
every tool call before it runs — is off, silently, because of a missing comma.

**Both controls are in this tree.** The same package's PROJECT layer refuses to
write a malformed file, deliberately, and `config-io.ts`'s header says so:
*"a malformed project file is never overwritten."* And
`prinny-channel/server/src/access.ts` quarantines the allowlist, with the
reasoning attached: *"Quarantine rather than delete: it may be a hand-edit the
user wants back, and starting from defaults beats refusing to run."*

**Which of the two, and why.** Quarantine, not refusal. Refusing is right for the
project layer, where the file is shared, checked in and somebody else's to fix;
it is wrong for a file that exists only to hold what the operator just typed into
a menu, because the menu would then silently stop working — a toggle that flips
back is a worse mystery than a file that moved.

**The fix.** Two modules, one rule:

```
   vendor/pi-subagents-lite/src/config/json-store.ts
   vendor/prinny-channel/src/json-store.ts
     readJsonObject(file)   → absent | loaded | malformed, with the parser's
                              own words
     quarantine(file, now)  → <file>.corrupt-<ISO, colons dashed>
     writeJsonAtomic(file)  → tmp + rename, and it REPORTS rather than throws
```

Two copies rather than an import, because vendor packages in this tree do not
import each other (§10.1's fifth invariant) — and, like the compaction lock's
four copies, a cross-package test drives both and asserts they agree on every
case. `saveGlobal` and `writeSettings` each quarantine before their first write
over a file they could not read, once, and say the new name. `ConfigStore`
exposes `globalConfigUnreadable` and `events.ts` says it at `session_start`;
`/prinny status` prints a `settings: UNREADABLE` line naming the mode it fell
back to.

An empty file is deliberately `absent` rather than `malformed`: a truncated write
leaves nothing to keep, and quarantining zero bytes only makes a second file for
the operator to delete.

**Tests.** `vendor/pi-subagents-lite/tests/json-store.test.ts`, 16 tests;
`vendor/prinny-channel/tests/json-store.test.ts`, 12 tests, four of which drive
both copies. **Control runs: with the read's distinction removed, 3 of 16 fail
here and 1 of 12 across the package boundary; with the quarantine removed, 1 of
16 and 1 of 12.** **Probe** `aa1`, three modes.

### 11.2 AN2 — the runtime three readers called "built"

**Shape 2.** `vendor/prinny-channel/server/bin/prinny-channel.mjs`,
`extensions/index.ts`, `scripts/pi-local.sh`

The sidecar runs from a staged, compiled runtime outside the repository, keyed on
a content fingerprint of `server/src` plus three build files. The bootstrap
decides "prepared" as

```js
   existsSync(ENTRY) && stampMatches(sourceFingerprint())
```

Three other readers, and the launch script, asked
`existsSync(dist/server.js)` alone — and those four are the ones that talk to
the operator.

**Measured on this box while this was written:**

```
   .source-stamp                     f297f2b6…   staged 2026-08-22 14:43
   fingerprint of server/src now     53371dab…
   staged src/ vs the checkout       connect.ts MISSING, server.ts differs
   `prinny-channel.mjs --staged`     stale (exit 1)
```

`connect.ts` is the twenty-first pass's fix (AL3) for a connect loop that builds
one matrix-js-sdk client per failed attempt and stops none of them. It has never
run. Every reader said "built".

**Why "the next start restages it" is the problem rather than the answer.** It
does restage — inside the connect budget. `npm install` plus `tsc` is about a
minute, `connectTimeoutSeconds` is 120, and importing the built sidecar alone
costs a measured 27.5 s. The bootstrap's own header names the failure:

> The first start has to install dependencies and compile, which takes about a
> minute — comfortably past the connect budget the pi extension gives the child
> before it declares it dead. That turns setup into a confusing loop of timeouts.
> `/prinny prepare` runs this instead, at a point in the flow where waiting is
> expected and the output is visible.

`--prepare` exists for exactly this, and the guard that routes an operator to it
could not see the case that reaches it after the first install. On a box with no
registry access — this one, today — the restage does not slow the start down, it
fails it.

**Why the weaker question was written three times.** Because the right one was
unreachable. `prinny-channel.mjs` bootstraps at import: it stages, compiles and
then `await import`s the server. Nothing can ask it a question, so every other
reader invented one it could ask.

**The fix.** `server/bin/runtime-stamp.mjs` — node built-ins only, exports only,
runs nothing:

```
   sourceFingerprint(payloadRoot)          unchanged, down to the localeCompare
                                           sort, so existing stamps keep meaning
                                           what they meant
   readStamp(runtimeDir)
   stagedState(runtimeDir, payloadRoot)  → absent | stale | current
```

The bootstrap imports it and deletes its own copies. The extension imports it and
uses it in all three places; a `stale` runtime is now a start-up blocker with its
own sentence, and `/prinny configure` runs its automatic prepare for it.
`scripts/pi-local.sh` asks `prinny-channel.mjs --staged`, which prints one word
and exits 0 / 1 / 2. A build with **no stamp at all** reads as `stale`, not
`current`: there is no evidence it matches, and guessing that it does is the
failure.

One thing changed with it that is not about the stamp. `startChannel`'s blocker
branch set the status pill to `prinny: not configured` for every reason it
refused, and there are now three — so an operator reading the pill while the
credentials are perfectly fine went looking in the wrong place. That is this
pass's own axis one layer up: a reader answering a question it was not asked. The
pill now says which of the three it is.

**Tests.** `vendor/prinny-channel/tests/runtime-stamp.test.ts`, 18 tests.
**Control run: 2 of 18 fail with the extension reverted to `existsSync`.**
**Probe** `aa2`, three modes — and its `live` mode is the finding rather than an
illustration of it.

### 11.3 AN3 — the device id a new token inherited

**Shape 3.** `vendor/prinny-channel/extensions/index.ts`

A Matrix access token belongs to a DEVICE. `PRINNY_DEVICE_ID` is written by
whoever minted the last one — a password login through `onCredentials`, or
`resolveDeviceId`'s `/account/whoami` lookup — and `/prinny configure token`
wrote the new token beside it:

```js
   updateEnv({ PRINNY_ACCESS_TOKEN: token });
```

The reply told the operator what would happen next:

> token saved. The channel resolves the matching device ID from /account/whoami
> on its next start.

That sentence is false in the normal case, and `resolveDeviceId` says why:

```js
   async function resolveDeviceId() {
     if (creds.deviceId) return creds.deviceId;      // ← never asks
     if (!creds.accessToken) return undefined;
     …/_matrix/client/v3/account/whoami…
```

A channel that has run before HAS a stored device id. So the next start builds a
Rust-crypto client claiming to be the OLD device while the homeserver considers
the token to be a new one — which is the failure `server/src/state.ts` warns
about in its own words: a bot that *"will appear to ignore people in encrypted
rooms"*, with nothing in the log.

**And the lookup it skipped is also the identity check.** `resolveDeviceId`'s
whoami call is where a token belonging to a *different account* is caught:

```js
   if (body.user_id && body.user_id !== creds.userId)
     throw new Error(`the access token belongs to ${body.user_id}, not …`)
```

Short-circuited by a stale device id, that check does not run either.

**The control is forty lines below, in the other arm of the same command.** The
three-argument `configure` clears both keys when the user id changes, under the
comment *"Replacing the account: the stored token and device belong to the old
one and would be used in preference to this password."* The sentence existed; the
token-only arm did not say it.

**The fix.** `credentialUpdatesForToken(token)` in `src/config.ts` — a pure
function returning `{ PRINNY_ACCESS_TOKEN: token, PRINNY_DEVICE_ID: null }`,
where `null` is `updateEnv`'s delete — with the reasoning above in its docstring,
and the reply rewritten to say what actually happens.

**Tests.** `vendor/prinny-channel/tests/token-device-id.test.ts`, 8 tests,
including two that pin `resolveDeviceId`'s precedence in `server/src` so the
coupling that makes the clear load-bearing is written down. **Control run: 2 of 8
fail with the device id left behind.** **Probe** `aa3`, three modes.

### 11.4 AN4 — the switches the launcher never forwarded

**Shape 4.** `scripts/pi-local.sh`

The launcher states the rule in the comment directly above the block that broke
it:

> Exported, not passed as a flag: the fork reads both from `process.env`, and
> **a value that only ever lives in .env is a knob that silently does nothing.**

It forwarded four of the seven `SUBAGENT_*` variables the package reads. The
three it did not:

```
   SUBAGENT_TRANSCRIPT       agents/transcript-entry.ts   README.md:811
   SUBAGENT_VERIFY_LOG       agents/verify-log.ts         handoff, 20th pass
   SUBAGENT_VERIFY_LOG_FILE  agents/verify-log.ts
```

The first two are documented as the way to turn each feature off, in a file whose
four siblings all live in `.env`. `env_get` reads an already-exported variable
first, so `SUBAGENT_TRANSCRIPT=0 ./scripts/pi-local.sh` worked and the documented
spelling did not.

Both default to ON and both write per delegation — up to sixty session entries of
four thousand characters, and one JSONL line per verifier model call. **The
operator who goes looking for the switch is the operator who had a reason to.**

**The fix, and it is a scan rather than three exports.** The three lines are
added, `.env` gains both keys with the reasoning, and
`vendor/pi-subagents-lite/tests/env-switches.test.ts` walks the package's own
sources for every `env.SUBAGENT_*` and fails when one of them is not both
`env_get`-read and `export`ed by the launcher. An `INLINE_ONLY` map is there for
a switch that is deliberately not forwarded; it is empty, and that is the point —
a name in it is a decision somebody has to write down.

The test carries its own control (`assert.ok(read.has("SUBAGENT_VERIFY"))`),
because a negative result is only as good as its control: if the regex stopped
matching, every other assertion in the file would pass by finding nothing.

**Tests.** 4 tests. **Control run: 3 of 4 fail with one export removed.**
**Probe** `aa4`, two modes — the `table` mode prints all seven switches with a ✔
or ✘ per column.

### 11.5 AN5 — the state written thirty-three times and read once

**Shape 4.** `vendor/pi-loop-mode/extensions/index.ts`

`persistState` appends a `loop-state` custom entry through `pi.appendEntry`, from
thirty-three places. `restoreLoopState` reads exactly ONE of them back: the last
on the branch. Every other entry is carried for its own sake, which is the design
and is fine. What was not fine is how many of them said nothing.

**Measured on a real session file under `~/.pi/agent/sessions`:**

```
   session file                                   948,959 bytes
   loop-state entries                          59
   bytes they account for                     392,245   41.3% of the file
   mean entry                                   6,648
   byte-identical to the entry before it           24   41% of the entries
```

Twenty-four of fifty-nine carried no information at all. They come from the
ordinary shape of the file: several rungs of `agent_end` set a field and persist
next to a rung that just did, `session_compact`'s handler persists straight after
pi finishes compacting (with `contextCompressionLevel = 0` that was already 0),
and `/loop end` writes `defaultState()` however many times it is run.

They are not free. Each is ~6.6 KB appended to the session file, one more node on
the chain `getBranch()` walks and `restoreLoopState` reverses a copy of, and one
more `custom` entry for `branchEndsInCompaction` to step over — a function that
exists *because* this module appends on thirty-three paths.

**The fix.** A memo: the payload of the last entry this session actually wrote,
and a string compare per persist. Set AFTER the append, never before —
`appendEntry` is `runtime.assertActive(); runtime.appendEntry(…)` and throws on a
stale ctx, and a memo set for a write that did not happen would suppress the
retry.

**The trap, which is the whole reason this is a finding and not a tidy-up.** The
memo is per SESSION and the module is per PROCESS — the same split AM4 fell into
one field over. A new session starts with an empty branch, so `restoreState`
hands back `defaultState()`; if the previous session's last write was also
`defaultState()` — `/loop end` does exactly that — the first write in the NEW
session would match the memo, be skipped, and leave that session's file with no
loop-state entry at all. A later restore would then find nothing.

So `resetPersistMemo()` sits in `session_start` and `session_shutdown`, next to
the `clearPendingTimer()` and the `runToken++` that are already there for the
same reason. `aa5 swap` has a third column — the memo kept, its reset removed —
which prints `the NEW session wrote: 0`.

**Tests.** `vendor/pi-loop-mode/tests/persist-dedupe.test.ts`, 6 tests.
**Control runs: 1 of 6 fail with the dedupe removed; 3 of 6 with the memo reset
removed.** **Probe** `aa5`, three modes, one of which re-runs the measurement
above against this box.

### 11.6 AN6 — the warnings a failed spawn threw away

**Shape 4.** `vendor/pi-subagents-lite/src/agents/agent-runner.ts`

`runAgentImpl` buffers five kinds of setup warning rather than notifying, and its
own comment says why: a notification between `tool_use` and `tool_result` in the
session tree is a 400. Every one of them is a sentence about the agent file the
operator just edited (§5.5).

They were lost two ways.

**The run threw.** The flush was a bare loop after the `await`, with no
`finally`:

```js
   const result = await runSessionPrompt(session, prompt, {…});
   for (const msg of warnings) { … }
   return result;
```

`runTurnLoop` throws `ABORTED_BEFORE_START` when a parent signal is already
aborted; `session.prompt()` rejects on a provider fault; `bindExtensions` can
throw during the build. **The run most likely to have been caused by a
misconfiguration is exactly the run whose misconfiguration warning was dropped.**

**There was no UI.** The flush read

```js
   if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
   else console.warn(`[pi-subagents-lite] ${msg}`);
```

and pi's `noOpUIContext.notify` is `() => {}` (`extensions/runner.js:92`) — a
real function. So the `else` was unreachable and the warnings went nowhere at all
under `pi -p`, a cron run or an unattended `/loop`. That is AC1's rule, and the
answer to it is thirty lines away in the same package: `reportDrop` does
`console.warn` unconditionally and *then* tries the UI.

**The fix.** `src/agents/notice-buffer.ts` — a module with no imports, so the
suite can drive it — with `add` bound (all five writers take it as a bare
function), a `flush(target, log)` that speaks on both channels and empties
itself, and every path guarded so a throwing UI cannot cost a console line or the
notices after it. `runAgentImpl`'s `try` opens ABOVE the setup, not just around
the run, because four of the five writers are setup checks; releasing there
cannot reopen the ordering problem the buffer exists for, since `ui.notify`
renders into the TUI's chat container and appends no session entry
(`interactive-mode.js` → `showExtensionNotify` → `showWarning`).

**Tests.** `vendor/pi-subagents-lite/tests/notice-buffer.test.ts`, 8 tests, and
`tests/agent-runner-flush.test.ts`, 5 source pins. **Control run: 1 of 13 fails
with the flush moved out of the `finally`** — and the first version of that pin
did *not* fail, because it asserted "the flush appears after `} finally {`"
rather than "inside it". §11.8.

**Probe** `aa6`, three modes.

### 11.7 AN7 — the settings path that ignored the override

**Shape 2.** `vendor/pi-subagents-lite/src/pi-settings.ts`

```js
   function getPiSettingsPath(): string {
     return path.join(os.homedir(), ".pi", "agent", "settings.json");
   }
```

`PI_CODING_AGENT_DIR` is pi's own `ENV_AGENT_DIR`, built as
`` `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR` `` (`dist/config.js:397`).
Everything in this stack honours it — pi's `getAgentDir()`,
`scripts/pi-local.sh` in two places, `prinny-channel/src/config.ts`,
`server/src/state.ts` (with a comment saying why), and this package's own
`verify-log.ts`. One reader did not, and it is the one whose whole job is to read
a file pi wrote.

The consequence is small and exact: on a relocated install `getHideThinkingBlock`
reads a path pi never writes, finds nothing, and returns `false` — so
`conversation-viewer.ts` opens with thinking blocks shown to an operator who
turned them off.

**Why it is a finding rather than a typo.** It is row 9 of the ledger and it is
the same shape as AN2 one size down: two readers of one fact, one of them from a
different place, and the wrong one is the one that was easier to write. The fix
is not "add the env var" but "there is one answer to this question":
`src/agent-dir.ts`, with the tilde rule read out of pi's `normalizePath` rather
than guessed, used by both readers — and a test that reads pi's installed
`dist/config.js` so a rename upstream is a failing test rather than a silent
divergence.

**Tests.** `vendor/pi-subagents-lite/tests/agent-dir.test.ts`, 11 tests.
**Control run: 2 of 11 fail with the hardcoded path restored.** **Probe** `aa7`,
three modes.

### 11.8 Off the axis — two tests that pinned the wrong thing

Both were found by this pass's own control runs, and both are the twenty-second
pass's §11.7 arriving again.

**`tests/tool-registration.test.ts` (AK1).** It asserted that
`ensureToolsRegistered(api)` appears before `await startChannel()` *within 400
characters of the first marker*. AN2 added five lines of comment between the two
statements, `await startChannel()` fell off the end of the window, and a test of
an invariant that still held reported it broken. It is now an order over the
whole file: find both, assert both exist, assert one is before the other. The
invariant is "in this order", and a byte distance is not that.

**`tests/agent-runner-flush.test.ts` (this pass's own).** Its first form asserted
`flushAt > finallyAt` — which a control run satisfied by putting the flush one
line *below* an empty `finally {}`. It now brace-matches the `finally` block and
asserts the flush is inside it. A pin written in the same hour as the fix can
still pin the wrong thing.

---

## 12. The evidence

### 12.1 The gates

Run before anything was written, so the *before* column is a measurement of the
tree as this pass found it.

```
                                       before    after
   vendor/pi-subagents-lite  tests      433       477    lint 111/111 files
   vendor/pi-loop-mode       tests      272       278    lint clean
   vendor/prinny-channel     tests      473       511    lint clean
   .pi/extensions/compaction-guard       75        75    lint clean
   vendor/rtk-pi             tests       28        28
                                       ─────     ─────
                                       1,281     1,369
   probes                               111       118
```

### 12.2 The control runs

Each fix removed, its own suite re-run:

```
   AN1  3 of 16 fail   (the read no longer distinguishes; subagents)
        1 of 12 fail   (…and across the package boundary, in prinny's suite)
        1 of 16 fail   (the quarantine removed; subagents)
        1 of 12 fail   (the quarantine removed; prinny)
   AN2  2 of 18 fail   (the extension asks existsSync again)
   AN3  2 of  8 fail
   AN4  3 of  4 fail   (one export removed from the launcher)
   AN5  1 of  6 fail   (the dedupe removed)
        3 of  6 fail   (the memo reset removed — the trap)
   AN6  1 of 13 fail   (the flush moved out of the finally)
   AN7  2 of 11 fail
```

### 12.3 The seven new probes

```
   aa1  the config the reader could not parse    subagents · prinny · absent
   aa2  the runtime three readers called "built" staged · live · absent
   aa3  the device id a new token inherited      rotate · first · switch
   aa4  the switches the launcher never          table · effect
        forwarded
   aa5  the state written thirty-three times     live · session · swap
   aa6  the warnings a failed spawn threw away   abort · headless · clean
   aa7  the settings path that ignored the       relocated · default · live
        override
```

Three of them are measurements of this box rather than reconstructions:
`aa2 live` prints the stale stamp and names the file the staged tree has never
seen, `aa5 session` counts the duplicate entries in every session file under
`~/.pi/agent/sessions`, and `aa7 live` prints what the two readers answer here.

`aa1 subagents` runs **one process per column**, because `config-io.ts` resolves
`CONFIG_PATH` at module load and jiti caches the module — two columns in one
process both read the first column's directory, which is how the first draft of
that probe managed to show the fix failing. `aa5` patches the real extension on
disk and imports the copy, which is `z4`'s method: a probe that reproduces a
fix's absence by re-implementing it is a probe about the re-implementation.

### 12.4 The standing scans, still green

```
   the four compaction-lock copies agree on the key, the bound and the owners
   the two json-store copies agree on every case, both directions
   `verifyAnswer` still never throws — every path returns a VerifyOutcome
   `isVerifyingRecord` still has one definition and six readers
   the load order in scripts/pi-local.sh still matches the four behaviours
     §1.7 of the concurrency write-up names
   every `env.SUBAGENT_*` the package reads is forwarded by the launcher (new)
```

---

## 13. What is open, and what was checked

### 13.1 Open by decision

- **`access.json` and `.env` each have two writers in two processes.** Both sides
  read-modify-write, and both windows are microseconds inside a synchronous
  function — but they are windows. The sidecar writes `.env` once, shortly after
  login; the extension writes it from a command. Closing it would need a lock
  file, and the file is small enough that the honest repair is to notice a lost
  token rather than to prevent it. Recorded, not fixed.
- **The sidecar's `readAccessFile` drops keys it does not know**, on the next
  pairing. That is why `pi.json` exists as a separate file, and the note is in
  `src/config.ts` where `SETTINGS_FILE` is declared. Adding a key to the
  extension's `Access` type without adding it to the sidecar's would lose it
  silently; both type declarations currently match, checked this pass.
- **A spill marker can outlive its file** (§7.2), and the recovery path is capped
  by the same rule that spilled it. Both are stated in the guard's own header and
  in the marker's advice line.
- **The session file has no bound.** §11.5 removes the duplicate entries; it does
  not bound the file, and nothing does. An unattended `/loop` running for a week
  writes a large one, and pi loads it whole at `/resume`.
- **`/loop resume` does not clear the turn buffers**, where the other eight
  lifecycle transitions do. Not reachable as a defect today — every path that
  can leave a buffer filled goes through `agent_end`'s drain or through a stop
  that clears them — and it is the same argument the `finish` idle branch already
  carries in a comment. Left, and written down here so the next per-turn field
  added is added to nine places rather than eight.
- **The two `.corrupt-<time>` files nothing removes.** A quarantine is a
  deliberate keep; a directory that accumulates them is an operator's to clean.
  If that changes, the bound belongs next to `MAX_SPILL_FILES`.

### 13.2 The measured negatives

Things this axis looked at and found already correct. Each is recorded because
"we checked and it holds" is what stops the next pass re-deriving it.

```
   ▸ The tool arguments the subagent listener mutates are a structuredClone.
     `validateToolArguments` deep-copies before `beforeToolCall` sees them, and
     `prepared.toolCall` — the ORIGINAL — is what pi persists with the assistant
     message. So `model`, `thinking` and `_resolvedAgent` never reach the session
     file and are never replayed to the model. (§2.4)

   ▸ A `custom` entry never becomes context, after a compaction or a reload.
     `sessionEntryToContextMessages` returns `[]` for it, and `getBranch()` —
     which `restoreLoopState` walks — is the RAW path, not the compaction-aware
     one. So the loop's state survives a compaction and the model never sees it.

   ▸ Nothing in this stack serialises a value JSON cannot round-trip. Every
     persisted shape is plain scalars, arrays and objects: `LoopState`,
     `SubagentEntry`, `RawConfig`, `PiSettings`, `Access`, `QueuedMessage`. No
     Date, no Map, no undefined that matters — `lastCheckPassed` is optional and
     `{...defaultState(), ...data}` restores it correctly either way.

   ▸ A shared `g` regex used with `.replace()` is safe. `stripShorteningMarkers`
     holds `SHORTENING_MARKER` at module scope with the `g` flag, and
     `String.prototype.replace` resets `lastIndex` at both ends — unlike `.test()`
     and `.exec()`, which is why `completionMarkerRe()` in `goal-check.ts` is
     built per call. Both are correct, for different reasons, and the difference
     is worth knowing.

   ▸ The four compaction-lock copies still agree, and `beginCompaction` still
     refuses a second owner. So the guard taking the lock for pi is a no-op while
     `pi-loop-mode` holds it for a compaction it asked for — which is the case
     `session_before_compact` also fires for.

   ▸ `pi.exec` never rejects, and a killed check is `{ code: 0, killed: false }`
     unless pi did the killing. The EXIT-trap marker is the round trip that
     answers "did bash finish", and its VALUE is deliberately not read. Re-checked
     against `wrapCheckCommand`'s subshell form.

   ▸ The custom-entry renderer cannot take the TUI down. `CustomEntryComponent`
     wraps the call and draws `renderer failed: <message>` instead, so an entry
     written by an older version of this code is a line in the transcript.

   ▸ `readSettings`' per-KEY fallback really is per key. A bad VALUE leaves every
     other setting intact — that half of the docstring is true, and the test that
     proves it is the control for §11.1's other half.
```

### 13.3 Still unwatched

1. **`/prinny prepare` has still not been re-run**, and this pass is why it now
   matters more: the runtime on this box is `stale`, `--staged` says so, and the
   next start will refuse rather than time out. The restage itself — an
   `npm install` on a box with no registry access — has never been exercised.
2. **`renderSubagentEntry` has still never been drawn in a live TUI.** Unchanged
   for three passes and still the cheapest unrun thing on the list.
3. **AM2 has never met a real threshold compaction with a real Matrix message
   arriving during it.**
4. **The rescue turn has still never met a real llama-server with an unloaded
   rescue model** (AL2's rung 3).
5. **New:** nobody has watched a quarantine happen on a real hand-edited config.
   `aa1` drives the real store and the real writer, and the operator-facing half
   — the `session_start` notice and the `/prinny status` line — has only been
   read, not seen.

---

## 14. The pattern across twenty-three passes

Seventeen axes, and the shape of what each found:

```
   S  T  U  V  W  X  Y  Z    the artefact and what it says
   AA AB AC AD AE AF AG AH   the actor and what it can see
   AI AJ AK AL               the promise, the caller, the proxy, the lifetime
   AM                        the moment
   AN                        the gap                             ← this pass
```

What is different about this one, and worth carrying forward.

**The previous sixteen axes are about code that runs.** They ask what a function
returns, who reads it, when it is true, who obeys it. Every one of them can be
answered by reading the program.

This one cannot, because half of each answer is not in the program. It is in a
file somebody edited, a directory somebody staged last week, an environment
variable a shell script did or did not export, a buffer that was dropped on the
way out. **The defect is never in the reader or in the writer; it is in the
assumption each of them makes about the other, and that assumption is written
down nowhere by default.**

Which is why six of the seven findings are distance zero (§10.2.1). The correct
version is usually right there — nine lines below, forty lines below, in the
sibling module, in the comment immediately above. Nobody wrote the wrong thing;
somebody wrote the right thing twice and only one of the copies got the hard
case.

The residue, in the tense that would have helped: **the next file this stack
reads will be read inside a `try`, and the `catch` will return a default. Before
writing it, ask what the caller does with that default — and if the answer
includes "writes it back", the catch has just been handed the power to delete
the file. Where two pieces of code answer the same question about the same
artefact, write the harder answer once and make both ask it; where they cannot
import each other, write it twice and add the test that says they agree.**

---

## 15. Where to look

```
   THE MACHINE                §1, seven panels. §1.2 and §1.3 are the new ones.
   THE ROUND-TRIP LEDGER      §10.2, thirty-eight rows. The artefact.
   THE SWITCH TABLE           §10.5
   THE FINDINGS               §11.1 AN1 · §11.2 AN2 · §11.3 AN3 · §11.4 AN4 ·
                              §11.5 AN5 · §11.6 AN6 · §11.7 AN7 ·
                              §11.8 the two tests that pinned the wrong thing
   THE EVIDENCE               §12
   WHAT IS OPEN               §13.1, and §13.2 for what was checked and holds

   CODE
     vendor/pi-subagents-lite/src/config/json-store.ts      AN1
     vendor/prinny-channel/src/json-store.ts                AN1 (the second copy)
     vendor/prinny-channel/server/bin/runtime-stamp.mjs     AN2
     vendor/prinny-channel/src/config.ts                    AN1, AN3
     scripts/pi-local.sh                                    AN2, AN4
     vendor/pi-loop-mode/extensions/index.ts                AN5
     vendor/pi-subagents-lite/src/agents/notice-buffer.ts   AN6
     vendor/pi-subagents-lite/src/agent-dir.ts              AN7

   TESTS
     vendor/pi-subagents-lite/tests/json-store.test.ts
     vendor/prinny-channel/tests/json-store.test.ts
     vendor/prinny-channel/tests/runtime-stamp.test.ts
     vendor/prinny-channel/tests/token-device-id.test.ts
     vendor/pi-subagents-lite/tests/env-switches.test.ts
     vendor/pi-loop-mode/tests/persist-dedupe.test.ts
     vendor/pi-subagents-lite/tests/notice-buffer.test.ts
     vendor/pi-subagents-lite/tests/agent-runner-flush.test.ts
     vendor/pi-subagents-lite/tests/agent-dir.test.ts

   PROBES
     context/testing/probes/aa1-…  aa2-…  aa3-…  aa4-…  aa5-…  aa6-…  aa7-…
```
