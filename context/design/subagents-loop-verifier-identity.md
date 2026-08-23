# Subagents, the loop and the verifier — what counts as the same thing

**Twenty-fourth pass, 2026-08-23.** Self-contained: it assumes none of the
twenty-three documents before it. §1 is the whole machine in seven drawings, §2
is pi itself, §3 is the event bus, §4–§9 are the seven packages, §10 is what has
to stay true, §11 is the findings — seven, plus an eighth closed after the
first draft — §12 the evidence, §13 what is open, §14
the pattern across twenty-four passes, §15 where to look.

Everything here is measured against **pi 0.84.2**, the version installed at
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent`, and against the
tree as it stands in this repository. Where a line number is quoted it is from
that install or from this tree. Where a number is quoted about this box — a
fingerprint, a resolution rate, a count of publishing sites — it was read off
the disk while this was written, and the probe that reads it again is named.

---

## 0. The axis, and why it is a new one

Twenty-three passes have each taken one question and asked it of every surface in
the stack. The seventeen so far:

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
  17. WHAT WE WROTE DOWN, AND WHO READS IT   AN1–AN7
      BACK — the writer, the reader, and the
      gap in between
```

This pass is the eighteenth:

> **WHAT COUNTS AS THE SAME THING.** For every place this stack decides two
> values are the same — a key lookup, a set membership, a string compare, a
> path, a name, an id — name the two values, name the function that decides,
> and find the pair that is **equal-but-different** or **different-but-equal**.

It is the natural successor to the seventeenth. That pass asked what a reader
does when the bytes are not what the writer meant. This one asks a narrower and
harder question about the same boundary: the bytes ARE what the writer meant,
and the reader still gets the wrong answer, because the writer and the reader do
not agree on what makes two of them the same value.

### 0.1 Why it is not "check your comparisons"

Every comparison in this stack is already correct in the ordinary case. That is
exactly why the axis is worth a pass: **an identity function is only ever
exercised on the pairs it gets right.**

```
   getRecord(id)  →  this.agents.get(id)          ← correct for every caller
                                                     that was handed an id by
                                                     this package
                                                   ← and there is exactly one
                                                     caller that was not
```

Eight findings, and in seven of them the defective comparison had been running
for months against inputs it answered correctly. `permissionTools` gates fine if you
type `bash`. Two rooms collide only if two people say the same word at the same
time. A watermark by timestamp is right until two homeservers disagree. The
common case agrees, and the common case is the whole test surface.

So the axis is mechanical rather than intuitive. Open every comparison and ask
three questions, in this order:

```
   1. WHAT ARE THE TWO VALUES,      not "an id and an id" — WHOSE id, minted
      really?                       where, and printed by whom in between
   2. WHO SUPPLIED EACH SIDE?       this package? pi? a person with an editor?
                                    a MODEL that read a message we wrote?
                                    another homeserver?
   3. NAME A PAIR THAT IS           equal-but-different: the same thing, spelled
      EQUAL-BUT-DIFFERENT, OR       two ways, and the compare says no.
      DIFFERENT-BUT-EQUAL.          different-but-equal: two things, one
                                    spelling, and the compare says yes.
```

Question 2 is what separates a nuisance from a finding, and it is the one that
sorts this pass's findings from its measured negatives. **A comparison whose two
sides are both minted by the same package is nearly always right. A comparison
with a boundary in the middle of it is where six of the eight findings live** —
and the
sharpest cases are the ones where the boundary is invisible because *we wrote
both sides*: we print an id, the model reads it, the model hands it back, and by
then it has been through a mind that only ever saw the eight characters we chose
to show.

### 0.2 The four shapes

Every finding in §11 is one of these.

```
   ── 1. A LOOKUP THAT ANSWERS FOR A KEY NOBODY STORED ────────────────────────
      `obj[k]` and `k in obj` reach the prototype. Over `JSON.parse` output
      that is eight names, all present and all truthy.
      AO6

   ── 2. TWO SPELLINGS OF ONE PATH ────────────────────────────────────────────
      One directory, five readers, and they do not agree what the value of
      PI_CODING_AGENT_DIR means — nor whether it has one.
      AO7

   ── 3. TWO NAMES FOR ONE THING ──────────────────────────────────────────────
      What is PUBLISHED is not what the lookup ACCEPTS: an id truncated for
      display, a tool name in a case pi does not use, a rendering that two
      rooms produce.
      AO1, AO2, AO3

   ── 4. IDENTITY BY A DIGEST OF PART OF THE THING ────────────────────────────
      A timestamp standing in for a message; a compiled artefact standing in
      for the source it was compiled from.
      AO4, AO5
```

Shape 3 is the one with the rule attached, and it is the rule this pass would
give anybody adding a display form to anything: **the moment you print a
shortened, folded or prettified version of an identifier, you have created a
second spelling, and something is going to hand it back to you.** Four of this
pass's seven are that sentence. The fix is never at the printer — see §10.2.1.

### 0.3 What is NOT this axis

- **Parse failures.** "What the reader does when it cannot read the bytes" is
  the seventeenth pass (AN1). This pass is about bytes that parsed perfectly.
- **Authorisation.** "Who is allowed to ask" is AJ. AO6 touches a gate, but the
  finding is that the gate answered for a key nobody stored, not that the wrong
  actor reached it.
- **Naming as documentation.** "What we named — then go and open it" is AG.
  That axis is about a name that lies to a reader; this one is about a name that
  lies to a `===`.
- **Staleness in the ordinary sense.** AN3 was a device id outliving its token.
  AO5 looks similar and is not: the staged runtime is not stale-as-in-old, it is
  a *different program wearing the name of this one*, and the only reader that
  could tell was not asking.
- **Hash collisions, unicode normalisation, locale-sensitive compare.** Checked
  and recorded as measured negatives (§13.2). Nothing in this stack compares
  user-supplied unicode for identity except `SentRegistry`, which folds
  deliberately and says so.

---

## 1. The machine

Seven packages run in **one node process**, inside **one pi session**, against
**one llama.cpp slot** — plus **one child process** (the Matrix sidecar) and
**one staged runtime directory** outside the repository. Nothing here is a
service; everything is an extension of the same process, except the two things
that are not.

### 1.1 Panel A — the whole machine, and the ten places an identity is decided

```
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  ONE NODE PROCESS · ONE pi SESSION · ONE llama.cpp SLOT · ONE THREAD       │
   │                                                                            │
   │   OPERATOR ──────► pi TUI ─────────────────────────────────┐               │
   │   (terminal)        │  /loop  /agents  /prinny  /stack     │               │
   │                     │                                      │               │
   │   SENDER ─► Matrix ─┴─► prinny sidecar ──stdio(MCP)──► prinny ext          │
   │   (a phone)         ②      (its own PROCESS, from a  ⑦     │               │
   │                             STAGED RUNTIME outside the repo)               │
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
   │                        ③ the tool NAME     │  Agent tool                   │
   │                           every handler    ▼                               │
   │                           compares       ┌───────────────────────────┐     │
   │                                          │  AgentManager             │     │
   │                            ④ the agent   │    ├ SlotTable (1 slot) ⑤ │     │
   │                               TYPE       │    ├ Watchdog (5 s tick)  │     │
   │                            ⑥ the agent   │    └ SpawnCoordinator     │     │
   │                               ID         └─────────────┬─────────────┘     │
   │                                                        │  runAgent()       │
   │                                                        ▼                   │
   │                                          ┌───────────────────────────┐     │
   │                                          │  CHILD AgentSession       │     │
   │                                          │  its own tools, skills,   │     │
   │                                          │  extensions — each named  │     │
   │                                          └─────────────┬─────────────┘     │
   │                                                        │  the answer       │
   │                                                        ▼                   │
   │                                          ┌───────────────────────────┐     │
   │                                          │  the VERIFIER             │     │
   │                                          │   ① does this answer the  │     │
   │                                          │      brief it was given   │     │
   │                                          └───────────────────────────┘     │
   └────────────────────────────────────────────────────────────────────────────┘

   SEVEN PLACES THIS STACK DECIDES TWO VALUES ARE THE SAME THING:

     ①  an ANSWER and a BRIEF          verify.ts — the only one that is
                                       deliberately fuzzy, and the only one
                                       with a model in the middle
     ②  a MESSAGE and one already      queue.ts — by event id, and by
        delivered                      timestamp                        ✘ AO4
     ③  a TOOL NAME and a list         four packages, four lists        ✘ AO2
     ④  an AGENT TYPE and the registry agent-types.ts `resolveType`
     ⑤  a MODEL KEY and a slot limit   concurrency-slots.ts
     ⑥  an AGENT ID and a record       agent-manager.ts                 ✘ AO1
     ⑦  a RENDERING and the room it    forwarding.ts `blockMatches`     ✘ AO3
        came from

   AND FOUR MORE THAT ARE NOT IN THE DRAWING, BECAUSE THEY ARE ABOUT FILES,
   DIRECTORIES AND BUILDS RATHER THAN ABOUT A MESSAGE IN FLIGHT:

     ⑧  a KEY and a table read from    access-store.ts, server/src/access.ts
        JSON                                                            ✘ AO6
     ⑨  a DIRECTORY and the directory  agent-dir.ts × 2, five readers   ✘ AO7
        pi actually uses
     ⑩  a COMPILED ARTEFACT and the    tests/harness.ts                 ✘ AO5
        source it claims to be
     ⑪  a WORKTREE and the parent's    worktree-validator.ts            ✘ AO8
        repository
```

Eleven identity decisions, eight of them defective. That ratio is not a
statement about this codebase's quality; it is a statement about the axis. Every
one of the eleven is correct for the inputs it usually gets — which is why the
eleventh was recorded as a latent and nearly left (§11.9).

### 1.2 Panel B — every name this stack carries, and who spells it which way

This is the new drawing, and it is what §10.2 tabulates. Each row is a value
that is compared for identity somewhere, with the spellings it exists in.

```
   AN AGENT ID
     minted    randomUUID().slice(0, 17)          agent-manager.ts:49, :297
     stored    the Map key, all 17
     published id.slice(0, 8)     ELEVEN sites, FOUR of them model-facing ✘ AO1
     accepted  the full 17, exact — until this pass

   AN AGENT TYPE
     minted    a frontmatter `name:`, or a default-agents key
     stored    the registry Map key, exactly as written
     published the name, unchanged
     accepted  exact ▸ unique case-fold ▸ ambiguous ▸ not-found          ✔

   A TOOL NAME
     minted    pi's registry: `bash` `edit` `write` `read` `grep` `find` `ls`
               this repo's: `Agent` `StopAgent` `AgentStatus` `prinny` `loop`
     compared  loop        WRITER_TOOLS.has(name)                        ✔
               subagents   EXCLUDED_TOOL_NAMES.includes(t)               ✔
               rtk         toolName !== "bash" → return                  ✔
               prinny      settings.permissionTools.includes(name)  ✘ AO2

   A ROOM
     minted    the homeserver: `!abc:example.org`
     compared  awaitingReply Map key, access.rooms lookup           ✘ AO6
     ALSO      by the RENDERING of a message from it               ✘ AO3

   A MATRIX EVENT
     minted    the sender's homeserver
     identity  `event_id`, unique by protocol
     ALSO      `origin_server_ts` — the sender's CLOCK              ✘ AO4

   A DIRECTORY
     pi        getAgentDir() = env ? expandTildePath(env) : ~/.pi/agent
     five      env ?? join(homedir(), '.pi', 'agent')     — four of them ✘ AO7
     readers   join(homedir(), '.pi', 'agent')            — one of them  ✘ AO7

   A PROGRAM
     source    vendor/prinny-channel/server/src/*.ts
     staged    ~/.pi/agent/channels/prinny/runtime/dist/*.js
     identity  sha256(path + content) in .source-stamp
     asked by  the bootstrap ✔ · the extension ✔ (AN2) · the SUITE ✘ AO5

   A SETTINGS KEY
     enum keys  checked against their enum                              ✔
     the tool   stored unvalidated, compared exactly                ✘ AO2
     list

   A SENT MESSAGE
     compared   whitespace- and case-folded, per room, per run          ✔
                SentRegistry.normalize — the fold is the point
```

### 1.3 Panel C — the four ways two values come apart

The single most useful fact in this document is that "the same" has four
different failure modes, and a comparison written against one of them is wrong
about the others.

```
   ┌─ 1. WE SHORTENED IT ON THE WAY OUT ───────────────────────────────────────┐
   │  A 17-character id printed as 8. A full path shown as a basename. A       │
   │  message rendered without its metadata.                                   │
   │  THE QUESTION: does anything hand the short form BACK to us? If a model    │
   │  can read it, the answer is yes.                                   AO1 AO3│
   └───────────────────────────────────────────────────────────────────────────┘
   ┌─ 2. SOMEBODY ELSE CHOSE THE SPELLING ─────────────────────────────────────┐
   │  An operator typed `Bash`. A shell profile has `~/pi-work`. A homeserver   │
   │  stamped a clock we do not run.                                           │
   │  THE QUESTION: whose keyboard, whose clock, whose filesystem? Anything     │
   │  that is not ours needs a normalising step BEFORE the compare.     AO2 AO7│
   └───────────────────────────────────────────────────────────────────────────┘
   ┌─ 3. WE ASKED THE LANGUAGE, NOT THE DATA ──────────────────────────────────┐
   │  `k in obj` and `obj[k]` answer about the PROTOTYPE. `.includes` on an    │
   │  array of unvalidated strings answers about whatever got stored.          │
   │  THE QUESTION: is this object one we built, or one JSON.parse built?      │
   │  For every state file in this stack the answer is the second.        AO6 │
   └───────────────────────────────────────────────────────────────────────────┘
   ┌─ 4. WE COMPARED A PROXY FOR THE THING ────────────────────────────────────┐
   │  A timestamp for a message. A dist directory's existence for the program  │
   │  it contains. `existsSync` for "ready".                                   │
   │  THE QUESTION: is the proxy a FUNCTION of the thing, or merely correlated  │
   │  with it? A timestamp is not a function of a message.              AO4 AO5│
   └───────────────────────────────────────────────────────────────────────────┘

   The fourth is the one this stack keeps rediscovering. AN2 was `existsSync`
   standing in for "compiled from this source"; AO5 is the same substitution,
   in the fifth reader, and the only one whose wrong answer is a PASSING TEST.
```

### 1.4 Panel D — one delegation, with every comparison marked

```
   parent turn
     │
     ├─ model emits  Agent{prompt, agent?, run_in_background?, worktree_path?}
     │
     ├─ tool_call handlers, IN ORDER, awaited                    [sequential]
     │    prinny   needsApproval(toolName, …)
     │               ▸ permissionTools.includes(toolName)   ← EXACT      ✘ AO2
     │               ▸ mode enum, checked against its list              ✔
     │    rtk      toolName !== "bash" → decline                        ✔
     │    subagents  resolveType(args.agent)
     │               ▸ exact ▸ unique case-fold ▸ ambiguous ▸ not-found ✔
     │
     ├─ executeAgentTool
     │    ▸ the registry, keyed by the EXACT frontmatter `name:`        ✔
     │      (four directories merged; a later `name:` overrides an earlier
     │       one only if it is spelled identically — deliberate, §5.2)
     │    ▸ the tool allowlist: EXCLUDED_TOOL_NAMES, extToolMap,
     │      allBuiltinSet — every name on both sides comes from pi      ✔
     │    ▸ the skill denylist: name.trim().toLowerCase()               ✔
     │    ▸ the extension denylist: by PATH basename OR package name    ✔
     │    │
     │    └─ coordinator.spawn → manager.spawn
     │         ▸ id = randomUUID().slice(0, 17)      ← the SEVENTEEN
     │         ▸ slot key = the model key; provider = key.split("/")[0] ✔
     │         └─ runAgent(…)
     │              ▸ skills from four roots, deduped by REALPATH and by
     │                NAME — and root 3 is the agent dir            ✘ AO7
     │              ▸ worktree: git-common-dir parent vs target
     │                            ← parent NOT realpath'd, target IS  LATENT
     │
     ├─ the settlement chain
     │    ▸ the verifier: does this ANSWER match this BRIEF (a model call)
     │    ▸ the anchor: normalized.startsWith(instruction) || the reverse ✔
     │
     └─ the model is told the run finished
          ▸ `[Subagent "type" ${id.slice(0,8)} completed]`   ← the EIGHT
                                                                        ✘ AO1
          and later:
          ▸ StopAgent{agent_id: "70acbd91"} → getRecord("70acbd91")
                                            → this.agents.get(…)  0/200 hit
```

**Every comparison on that path but one has both sides minted inside this
process.** The exception is the last: the model supplies `agent_id`, and the
only spelling it has ever been shown is eight characters long.

### 1.5 Panel E — one inbound Matrix message, with every comparison marked

```
   a phone ──► homeserver ──► the sidecar's sync
     │
     ├─ isMentioned(signals, config)                       server/src/mentions.ts
     │    ▸ m.mentions contains botUserId          exact                ✔
     │    ▸ reply-to sender === botUserId          exact                ✔
     │    ▸ html contains matrix.to/#/<botUserId>  substring            ✔
     │    ▸ text contains botUserId                substring            ✔
     │    ▸ a bare-word match on the LOCALPART     case-insensitive     ✔
     │    ▸ a bare-word match on the DISPLAY NAME  case-insensitive     ✔
     │    ▸ the operator's own regex                                    ✔
     │      (seven spellings of "this is addressed to me"; the direction
     │       is deliberately toward YES — §8.1)
     │
     ├─ gate(inbound)                                       server/src/access.ts
     │    ▸ allowFrom.includes(senderId)           exact, MXID_RE'd     ✔
     │    ▸ access.rooms[roomId]                   PROTOTYPE-REACHABLE ✘ AO6
     │
     ├─ enqueue(message)                                     server/src/queue.ts
     │    ▸ queue.some(entry.id === message.id)    by EVENT ID          ✔
     │    ▸ alreadyDelivered(message, watermark)   by TIMESTAMP    ✘ AO4
     │
     ├─ the sidecar hands it over MCP; the extension renders it
     │    ▸ injected = renderInboundMessage(message)
     │         drops room_id, message_id, user_id, and in a DM `from=`
     │      → two DMs saying `hi` are one string                   ✘ AO3
     │
     ├─ pi echoes the user message; markLive(text)
     │    ▸ blockMatches: userMessageText.trim() === entry.injected.trim()
     │      → marks EVERY matching entry; the loop has no break     ✘ AO3
     │
     └─ the turn ends; forwardToMatrix(answer)
          ▸ liveRooms().length === 1  → send
          ▸ liveRooms().length  > 1  → refuse, and tell both rooms
                                        somebody else was being answered
```

Two identity decisions on that path decide whether a person gets an answer, and
both of them were wrong. AO4 is the one that reacts and then goes silent; AO3 is
the one that answers the wrong person.

### 1.6 Panel F — the three resolution ladders, side by side

This stack resolves a name to a thing in three places. Until this pass there
were two, and they disagreed about everything except being right.

```
                    resolveType          resolveAgentId       resolveModel
                    agent-types.ts       agent-id.ts (NEW)    loop/index.ts
   ────────────────  ──────────────────   ──────────────────   ─────────────────
   exact             ✔ Map.has            ✔ includes           ✔ provider/id
   unique case-fold  ✔                    ✔                    ✔ id, then
                                                                 provider/id
   unique PREFIX     —                    ✔ (the published      —
                                             eight)
   SUBSTRING         —                    —                    ✔ id, then
                                                                 provider/id
   two or more       ambiguous,           ambiguous,           FIRST MATCH,
                     candidates named     candidates named     silently
   none              not-found            not-found            not-found
   ────────────────  ──────────────────   ──────────────────   ─────────────────
   who asks?         the MODEL            the MODEL            the OPERATOR
   who sees the      a tool result        a tool result        a TUI notice
   answer?           it must act on       it must act on       naming the pick

   `resolveType`'s rule is written down as "Never a silent pick (US-2)", and
   `resolveAgentId` is that rule one field over. `resolveModel` breaks it and is
   CORRECT to: `switchModel` immediately notifies `Loop: model set to
   <provider>/<id>`, so the operator sees which of the candidates was taken, on
   the same line, in the same second. A model calling a tool gets no such line.

   THE RULE THIS PASS WOULD WRITE DOWN: report ambiguity when the caller cannot
   see what you picked. That is the whole difference between the two columns on
   the left and the one on the right — not taste, and not consistency.
```

### 1.7 Panel G — the published form and the accepted form

AO1 in one drawing. Eleven sites publish `id.slice(0, SHORT_ID_LENGTH)`, and
`SHORT_ID_LENGTH` is 8 (`src/types.ts:134`). Four of the eleven are read by the
model.

```
   THE ID                     randomUUID().slice(0, 17)
                              agent-manager.ts:49 (AGENT_ID_PREFIX_LENGTH), :297

   PUBLISHED, MODEL-FACING                              PUBLISHED, OPERATOR-FACING
   ─────────────────────────────────────────────────    ─────────────────────────
   agent-status.ts:33      AgentStatus — the tool       events.ts:153, :158
                           whose whole job is             the steer notices
                           "which agents exist"        spawn-coordinator.ts:326
   spawn-coordinator.ts:493  the background result       :406  nudge drop / hold
                           the model actually reads    agent-manager.ts:850
   tool-execution.ts:426   the "Running agents:" list     undelivered steers
                           INSIDE StopAgent's own      agent-runner.ts:675
                           REFUSAL                        the child session name
   tool-execution.ts:484   StopAgent's own success     transcript-entry.ts:196
                           lines                          the transcript label

   ACCEPTED, BEFORE THIS PASS
   ─────────────────────────────────────────────────────────────────────────────
   executeStopAgentTool → manager.getRecord(agentId) → this.agents.get(id)
                                                       an EXACT Map lookup on 17

   MEASURED (probe ab1, mode `published`): 200 freshly minted ids, each looked
   up by the eight characters every surface prints.   0 / 200 resolved.

   THE ONE PATH THAT WORKED
   ─────────────────────────────────────────────────────────────────────────────
   run_in_background's own success message is `Agent ID: ${agentId}` — the full
   seventeen. It is the only surface that ever carried it, and it is why this
   survived twenty-three passes: the single path with a good identifier was fine.

   ACCEPTED, NOW
   ─────────────────────────────────────────────────────────────────────────────
   executeStopAgentTool → manager.resolveId(requested) → resolveAgentId(…)
     exact ▸ unique case-fold ▸ unique prefix ▸ ambiguous ▸ not-found
```

---

## 2. pi itself

### 2.1 What an extension is, and when its factory runs

An extension is a module with a default-exported factory. pi calls the factory
**once per session**, not once per process, and node's module cache means the
MODULE body runs once. Every registry in this document — the agent registry, the
slot table, `awaitingReply`, `SentRegistry` — is one of those two scopes, and
which one it is decides what an identity means:

```
   MODULE scope    the key space is the PROCESS.   e.g. the agent registry,
                                                   packageNameCache
   FACTORY scope   the key space is the SESSION.   e.g. awaitingReply, the
                                                   loop's per-turn buffers
```

Nothing in the type system says which you got, and the difference is one
indentation level.

### 2.2 Tool names, and where they come from

There is **no tool registry on `ExtensionContext`.** pi exposes `ui`, `mode`,
`cwd`, `sessionManager`, `modelRegistry`, `model`, `scopedModels`,
`thinkingLevel` and the lifecycle calls, and nothing that lists tools. This is
load-bearing for AO2: an extension that wants to validate an operator's tool
name against the set of real tools has nowhere to ask, so the repair has to be at
the comparison rather than at the write.

The names themselves come from two places and are not one case:

```
   pi's built-ins       bash  edit  write  read  grep  find  ls      lower
   this repo's own      Agent  StopAgent  AgentStatus                Capitalised
                        prinny  loop  stack_status                   lower/snake
```

`tool_call` and `tool_result` events carry `toolName` exactly as registered, so
any comparison whose OTHER side also comes from pi is safe by construction. The
one comparison whose other side comes from a person is AO2.

### 2.3 What `JSON.parse` hands you

Every state file in this stack is read with `JSON.parse`, and the object it
returns has `Object.prototype` on its chain. Eight inherited names are therefore
both `in` it and truthy on it:

```
   constructor   toString   valueOf   hasOwnProperty
   __proto__     isPrototypeOf   propertyIsEnumerable   toLocaleString
```

`Object.create(null)` is not used anywhere in this stack, and a reviver that
strips the prototype is not used either. So `obj[k]` and `k in obj` over parsed
state are **presence tests that answer for eight keys nobody stored**, and the
only correct forms are `Object.prototype.hasOwnProperty.call(obj, k)` (the
spelling this stack uses, so a grep finds all of them), `Object.hasOwn`, or
`Object.entries`/`Object.keys`, which are own-keys-only.

This is AO6, and it is worth stating as a property of the platform rather than
as a bug in one file: **there is no state file in this stack over which `in` is
the right operator.**

### 2.4 Session entries, and the two id spaces

`SessionManager` appends one JSON line per entry to
`~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` and keeps the list in
memory, keyed `byId`. Those ids are pi's, minted and consumed inside pi, and no
identity question in this document touches them.

The ids this document is about are the subagents package's own — seventeen
characters of a v4 UUID — and they never enter a session entry as a key. They
appear only in TEXT: in a transcript label, in a result message, in a notice. A
value that exists only inside prose is a value whose spelling is decided by
whoever wrote the prose, which is exactly how AO1 happened.

### 2.5 `getAgentDir`, the one environment variable, and the tilde

pi's own answer, read out of `dist/config.js` rather than remembered:

```js
   const envDir = process.env[ENV_AGENT_DIR];      // PI_CODING_AGENT_DIR
   if (envDir) return expandTildePath(envDir);
   return join(homedir(), CONFIG_DIR_NAME, "agent");   // ~/.pi/agent
```

`ENV_AGENT_DIR` is built as `` `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR` ``
and `CONFIG_DIR_NAME` as `pkg.piConfig?.configDir || ".pi"`, both of which
`tests/agent-dir.test.ts` reads out of the install so a rename upstream is a
failing test rather than a silent divergence.

Two details in that four-line function are the whole of AO7:

- **`if (envDir)`** — not `envDir?.trim()`. A value of `"   "` is a relative
  directory to pi, and anything that answers "unset" to it has diverged.
- **`expandTildePath`** — pi's `normalizePath`, which expands `~` and `~/…` (and
  `~\` on win32 only). A `PI_CODING_AGENT_DIR=~/pi-work` in a shell profile or
  an `.env` is not expanded by any shell, so a reader without this step keeps
  its files in a directory literally named `~`, relative to whatever the cwd was.

---

## 3. The event bus

### 3.1 Handlers are awaited, in registration order

`ExtensionRunner.emit` awaits each handler in turn (`extensions/runner.js:579`),
so two extensions' handlers for the same event never interleave. The load order
comes from `scripts/pi-local.sh` and is behaviour, not decoration.

For this axis the relevant consequence is narrow and sharp: **three packages
compare the same `toolName` string in the same event, one after another, against
three different lists** — and they disagree about what a match means.

```
   prinny    needsApproval(toolName, input, settings)
               permissionTools — a list a PERSON typed              ✘ AO2
               "dangerous" — regexes and predicates over the command
   rtk       if (toolName !== "bash") return
   subagents toolCallListener — only its own `Agent` tool
```

Two of the three compare against a set they built themselves. The third compares
against a set an operator typed into `/prinny set`, and it is the only one of the
three that gates in **every** permission mode, including `off`.

### 3.2 Which emitters thread a result

```
   emit()                generic. session_before_* only; LAST TRUTHY WINS.
   emitToolCall()        FIRST BLOCK WINS — so the first handler to refuse a
                         call decides it, and the ones after it never run.
   emitToolResult()      threads content/details/isError/usage.
   emitBeforeAgentStart() COLLECTS messages from all handlers.
```

`emitToolCall`'s first-block-wins is why the order of the two gates matters:
prinny is loaded before rtk, so a call prinny blocks is never seen by rtk, and
`rtk` declines to rewrite a command a person approved as written (AJ3).

### 3.3 The events that decide a session's boundaries

```
   session_start      the factory has run; state is restored from the branch;
                      configs are re-read from disk
   session_shutdown   the earlier of the two on a swap
```

Every module-scoped registry that answers a per-session question has to be
cleared in both. This pass adds no new one; AN5's memo is the standing example.

---

## 4. The loop — `vendor/pi-loop-mode`

A fork of pi-loop-mode 2.5.4. Registers `/loop`, a `loop` tool, and thirteen
event handlers. It makes four identity decisions and gets all four right, for
four different reasons — which is why it is the useful chapter to read before
§11 rather than after.

### 4.1 A tool name, against a set the package wrote

```js
   const WRITER_TOOLS     = new Set(["write", "edit"]);          // :367
   const CAN_CHANGE_TOOLS = new Set(["bash", "Agent"]);          // :378

   function hasStateChange(toolName, text, isError) {
     if (WRITER_TOOLS.has(toolName)) return true;
     if (!CAN_CHANGE_TOOLS.has(toolName)) return false;
     return CHANGE_WORDS.test(text);
   }
```

Two lower-case names and one capitalised one in the same set, compared exactly,
and it is correct: **both sides of that compare are pi's own spelling.** The
`toolName` comes off a `tool_result` event exactly as registered, and the set was
written by reading the registry. Nobody types into it.

Put this next to AO2 — the identical shape, a tool name against a set — and the
difference is entirely in where the other side came from. That is §0.1's second
question doing all the work.

### 4.2 A model spec, against the registry

`resolveModel` (`:632`) is the third resolution ladder (§1.6) and the only one
that ends in a silent pick:

```js
   all.find((m) => m.id.toLowerCase() === lower) ??
   all.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower) ??
   all.find((m) => m.id.toLowerCase().includes(lower)) ??
   all.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(lower))
```

A substring that matches two models takes the first. That would be a finding if
the caller could not see the outcome — and it can: `switchModel` answers with
`Loop: model set to ${model.provider}/${model.id}`, in the operator's own
terminal, immediately. The pick is announced, so the ambiguity is visible at the
only moment it matters. Recorded in §13.2 as checked, with the reasoning, so the
next pass does not open it as AO-something.

### 4.3 The goal check — identity by the presence of a marker

`runGoalCheck` is `pi.exec("bash", ["-lc", wrapCheckCommand(cmd)], { timeout })`,
and the round trip is a bash `EXIT` trap printing
`__PI_LOOP_CHECK_COMPLETED__:<status>`. The loop reads the marker's **presence**
and deliberately not its value: reading a status out of a child's stdout would
let a check that prints attacker-controlled text choose its own verdict (AB1,
AC3). "Is this the marker" is a fixed-string compare against a constant this
package wrote, on both sides — §4.1's property again, across a process boundary.

### 4.4 A turn, identified by a digest of itself

`recordToolResult` collapses a turn into one **signature** (`MIXED_TOOLS` when a
turn used more than one distinct tool) and the repetition detector compares
recent assistant texts. This is the stack's one deliberate use of shape 4 —
identity by a digest of part of the thing — and it is correct because nothing
downstream treats two equal signatures as *the same turn*. It treats them as
*evidence of a loop*, which is exactly what a digest can support.

Contrast AO4, where the same construction — a partial digest, here a timestamp —
was used to answer "is this the same message", and the answer was acted on as
identity.

---

## 5. Subagents — `vendor/pi-subagents-lite`

A fork of pi-subagents-lite 1.11.0. Registers `Agent`, `StopAgent`,
`AgentStatus`, `/agents`, a widget, and eight event handlers. It carries **three
different identifier spaces**, and knowing which is which is most of §11.1.

### 5.1 The three identifiers

```
   AGENT TYPE   a name a person wrote          "explore", "general-purpose"
                resolved by  resolveType        exact ▸ fold ▸ ambiguous
                supplied by  the MODEL (the `agent` argument)

   AGENT ID     randomUUID().slice(0, 17)      "70acbd91-2f3e-4c1"
                resolved by  resolveAgentId     exact ▸ fold ▸ prefix ▸ ambiguous
                supplied by  the MODEL — from a string WE printed at 8   ✘ AO1

   MODEL KEY    "provider/id"                  "forge/qwen3.8-27b"
                resolved by  SlotTable          exact; provider = split("/")[0]
                supplied by  the config, and the registry
```

The middle one is the finding. The other two were both already right, and both
for a reason worth keeping: the type is resolved through a ladder that reports
ambiguity, and the model key is never shortened for display.

### 5.2 The registry, keyed by the exact frontmatter name

Agents come from four directories:

```
   default agents                       default-agents.ts
   ~/.pi/agent/agents/*.md              user
   <project>/.agents/agents/*.md        shared    ⎫ trusted projects only
   <project>/.pi/agents/*.md            project   ⎭
```

`mergeAgentOverrides` keys on `md.name` **exactly**:

```js
   const existing = result.get(md.name);
   result.set(md.name, existing ? { ...existing, ...fromMd(md) } : { ...BASE_DEFAULTS, ...fromMd(md) });
```

So a project file called `Explore` does not override a user file called
`explore`; it registers a second agent. That is deliberate and was re-checked
this pass rather than assumed: `resolveType` answers the case question
separately, at lookup time, and reports `ambiguous` when two registered names
differ only by case. Folding at merge time would silently pick one file's
contents over another's, which is the failure `resolveType` exists to refuse.

**Two questions, two places, one deliberate asymmetry** — and this is the pattern
the whole pass converges on (§10.2.1): the fold belongs at the LOOKUP, not at the
store.

### 5.3 The slot table's keys are its own

```js
   for (const [provider, limit] of Object.entries(providerConfig)) this.applyEntry(…);
   for (const key of [...this.providers.keys()]) if (!(key in providerConfig)) this.providers.delete(key);
```

`key in providerConfig` is the operator §2.3 says is never right over parsed
JSON — and here it is right, because the keys being tested are the ones
`Object.entries` just produced from that same object. `Object.entries` is
own-keys-only, so `this.providers` can only ever hold own keys, and `in` can only
ever be asked about one. Checked this pass and left exactly as it is.

The reason it is worth writing down: **a `in` over JSON is not automatically a
defect. It is a defect when the key could have come from anywhere else** — a
person, a model, another process. Here it came from four lines above.

### 5.4 An extension name, folded on both sides

`filterExtensions` is AO2's shape — an operator-written list of names, matched
against things pi loaded — and it is the correct version:

```js
   const pathName = extractExtensionName(ext.path).toLowerCase();
   const pkgName  = extensionPackageName(ext.path);    // documented: lowercased
   const hit = names.has(pathName) || (pkgName !== undefined && names.has(pkgName));
```

and `names` is built folded, in both branches (`:514`, `:524`). Two spellings of
each extension are deliberately accepted — the install-path name and the npm
short name — and every one of the four strings in that compare is lower case by
construction. An unmatched name is reported (`extension "Y" not found in loaded
extensions`), which is the other half AO2 lacked.

### 5.5 Skills, deduped by realpath AND by name

`loadAllSkills` walks four roots in precedence order and skips a skill when
either its canonical path or its name has been seen:

```js
   if (realPathSet.has(realPath) || nameSet.has(skill.name)) continue;
```

Two identity questions about one object, deliberately: the path catches the same
file reached twice through a symlink, the name catches two different files
claiming the same skill. Root 3 of those four is `<agent dir>/skills`, and until
this pass it was a hardcoded `~/.pi/agent` — AO7.

### 5.6 The denylist, folded and trimmed

```js
   DENIED_SKILL_NAMES.has(name.trim().toLowerCase())
```

A skill name comes from a file a person wrote, and the set is this package's. One
side folded, the other written folded. The correct shape, three files from the
one that had it wrong.

---

## 6. The verifier

Three layers, cheapest first: the **anchor** (no model call), the **structural
gate** (no model call), and the **judge** (one small model call in a session of
its own), with up to `SUBAGENT_VERIFY_ROUNDS` repairs.

For this axis it is the odd chapter, because it is the one place in the stack
where "the same thing" is *supposed* to be fuzzy: the question is whether an
ANSWER addresses a BRIEF, and no string compare can decide it. What the pass
looked at is the identity decisions **around** that judgement, and they are all
narrow:

- **`isWhyInstruction`** — is the judge's `WHY:` line the prompt's own
  instruction echoed back? Normalised for case and whitespace on both sides, and
  compared with `startsWith` in **both directions**, because a model that echoes
  the line and then keeps going on the same line is still echoing. A rare
  deliberate use of a prefix compare where neither side is authoritative.
- **`VERDICT_LINE` / `WHY_LINE`** — the shapes a 27B actually writes a verdict
  in, matched case-insensitively with the decoration a small model adds
  (`**VERDICT:**`, `> verdict :`). Identity by REGEX over a model's prose, which
  is the honest description of what it is.
- **`VERDICT_MENU`** — the guard against reading the prompt's own menu line
  (`ADDRESSED or NOT_ADDRESSED`) as a verdict. A different-but-equal defence:
  two strings that both look like a verdict line, one of which is ours.

None of the three changed this pass. They are here because they are the stack's
only identity decisions made over text a model wrote, and because they show what
the alternative to a ladder looks like when there is no canonical spelling to
resolve to.

---

## 7. The guard — `.pi/extensions/compaction-guard`

Four jobs: cap the summary pi carries forward, show the model its context budget
above 60%, cap a single tool result to a share of what context is LEFT, and take
the compaction lock on pi's behalf.

Two identity decisions, both about processes rather than names:

- **`__PI_COMPACTION_IN_FLIGHT__`** is `{ owner, at }`, stale after 300 s, with
  **four implementations** across packages that may not import each other. The
  identity that matters is the OWNER string: `beginCompaction` refuses when
  another owner holds it. Re-checked this pass — the four copies still agree on
  the key, the bound, the stale rule and the owner check.
- **A spill directory's owner** is a pid parsed out of its own name
  (`/tmp/pi-tool-output-<pid>-…`), and `pruneDeadSpillDirs` removes directories
  whose owner is gone. Identity by pid is identity by a value the OS recycles —
  and it is safe here only because the consequence of a false positive is
  deleting a directory the guard itself wrote. The sidecar makes the same
  decision with a real check attached; see §8.4.

---

## 8. prinny — `vendor/prinny-channel`

```
   Matrix  ⇄  sidecar (child PROCESS, MCP over stdio)  ⇄  extension  ⇄  pi
                  ▲
                  └─ runs from a STAGED, COMPILED COPY of server/src
```

Five of the eight findings are in this package, and it is not because it is worse
code. It is because **every value it handles was minted somewhere else** — a
homeserver, a phone, an operator's thumb, a model. §0.1's second question has a
different answer here than anywhere else in the stack.

### 8.1 The four identities a Matrix message carries

```
   WHO SENT IT     an MXID, `@name:server`. Validated by MXID_RE, compared
                   exactly, and the comment says why: "A bare localpart in the
                   allowlist silently matches nobody."                      ✔
   WHERE           a room ID, `!abc:server`. Validated by ROOM_ID_RE, and the
                   comment says why: "an alias moves between rooms, an ID does
                   not."                                             ✘ AO6
   WHICH EVENT     `event_id`, unique by protocol — and `origin_server_ts`,
                   which is not.                                     ✘ AO4
   IS IT FOR ME    seven spellings, §1.5. The direction is deliberately toward
                   YES, because a bot that answers something not addressed to
                   it is a nuisance and a bot that ignores you is broken.  ✔
```

The first and the second are the same kind of value, validated by the same kind
of regex, with the reasoning written next to each — and the second was still
looked up with an operator that answers for `constructor`.

### 8.2 The allowlists, and which of them are validated

```
   LIST                WHERE            VALIDATED?          COMPARED
   ──────────────────  ───────────────  ──────────────────  ──────────────────
   access.allowFrom    access-store.ts  MXID_RE, with the   .includes, exact ✔
                                        reason written
   access.rooms        access-store.ts  ROOM_ID_RE, ditto   [k] / k in    ✘ AO6
   permissionTools     config.ts        NOTHING             .includes     ✘ AO2
   KNOWN_COMMANDS      command-routing  a fixed list        .includes, folded ✔
   MATRIX_LOCAL        command-routing  ours                hasOwnProperty ✔
   MATRIX_ALLOWED      command-routing  ours                hasOwnProperty ✔
```

The bottom three are in one file, nine files from `access-store.ts`, and two of
them use `Object.prototype.hasOwnProperty.call` **for exactly the reason AO6
exists** — the name comes out of a Matrix message. The same package, the same
author's care, the same question, two answers.

### 8.3 The staged runtime as an identity

`server/bin/prinny-channel.mjs` stages `server/src` plus three build files into
`~/.pi/agent/channels/prinny/runtime`, runs `npm install` and `tsc`, and records
`sha256(path + content)` over the source in `.source-stamp`. Content rather than
mtime, deliberately: a clone, a branch switch and a checkout all rewrite mtimes.

`stagedState(runtime, payloadRoot, fingerprint)` answers `current | stale |
absent`. It was written by the twenty-third pass (AN2) because four readers were
answering "is it built?" with `existsSync(dist/server.js)`. The fifth reader —
the test harness — is AO5.

**Measured on this box while this was written** (probe `ab5`, mode `live`):

```
   .source-stamp        d4ba699711f4b6f75c620dfcd509b0718cdf7e60a666e52cfd923d8dbda2d5fe
   server/src hashes    d4ba699711f4b6f75c620dfcd509b0718cdf7e60a666e52cfd923d8dbda2d5fe
   dist/                access connect history inbox mentions permissions queue
                        server state stdout-guard
   stagedState()        current
```

`connect.js` is present, which it was not when the finding was written — AL3's
fix for a connect loop that builds one matrix-js-sdk client per failed attempt is
compiled into the runtime for the first time.

### 8.4 A pid, and the check that makes it an identity

The sidecar replaces a stale poller, because two bots sharing one Olm store is
the failure the channel lifecycle exists to prevent. A pid file alone is not an
identity — the OS recycles pids — so the sidecar asks a second question before
signalling:

```js
   const cmd = execFileSync('ps', ['-p', String(stale), '-o', 'args='], …);
   if (cmd.includes('prinny-channel') || cmd.includes('dist/server.js')) {
     log(`replacing stale poller pid=${stale}`);
     process.kill(stale, 'SIGTERM');
   }
```

with the reason in a comment: *"a recycled PID could be this session's own node
wrapper, and killing that takes the channel down with it."* This is the stack's
best example of the axis handled correctly in advance — a proxy identity
(§1.3's shape 4) with a confirming question attached, chosen because the cost of
a false positive was named before the code was written.

### 8.5 A file path, and the directory it must be inside

```js
   if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) throw …
```

Both sides `realpathSync`'d before the compare, and the separator appended so
`/state-backup` is not inside `/state`. Identity by path prefix, done correctly,
and worth naming because §11.7's latent sibling in `worktree-validator.ts` is the
same compare with the realpath on **one side only**.

---

## 9. rtk and stack

`vendor/rtk-pi` registers one `tool_call` handler, for `bash` only, and awaits
`rtk rewrite` with a 2-second timeout inside it. Its identity decisions are a
command-prefix test done carefully — `cmd === prefix`, or `cmd.startsWith(prefix)`
**and the next character is whitespace**, so `gitk` is not `git` — and a refusal
to rewrite a command a person approved as written (AJ3).

`.pi/extensions/stack.ts` registers `/stack` and a read-only `stack_status` tool,
and is inert in a child.

---

## 10. What has to stay true

### 10.1 The invariants, and the eighth this pass adds

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
   7  A file this stack could not parse is never silently replaced, and a value
      it wrote down is never read back by a question weaker than the one that
      wrote it.
   ──────────────────────────────────────────────────────────────────────────
   8  An identifier is ACCEPTED in every spelling it is PUBLISHED in, and a
      lookup over parsed JSON asks about own keys only.
      (AO1, AO2, AO6 — and §10.2 is the ledger it is enforced against.)
```

The eighth is deliberately two clauses, because the two halves fail differently.
The first is about a boundary this stack creates for itself every time it
shortens something for display; the second is about a property of the language
that no amount of care at the boundary will fix.

### 10.2 The identity ledger — this pass's artefact

Every place this stack decides two values are the same. **DECIDES** is the
function. **SUPPLIED BY** is where each side comes from, which is the column that
predicts the verdict.

```
   #   THE TWO VALUES                    DECIDES              SUPPLIED BY  VERDICT
   ──  ────────────────────────────────  ───────────────────  ───────────  ───────
   AGENTS AND TYPES
    1  agent TYPE ⇄ the registry         resolveType          model / us      ✔
       exact ▸ unique case-fold ▸ ambiguous ▸ not-found. "Never a silent
       pick (US-2)" — the rule the whole pass converges on
    2  frontmatter name ⇄ a registered   mergeAgentOverrides  person / us     ✔
       agent                             Map.get, EXACT
       deliberate: folding here would silently pick one file over another;
       `resolveType` answers the case question at lookup instead
    3  agent ID ⇄ a record               getRecord → Map.get  MODEL / us  ✘ AO1
       published at 8 in eleven places, accepted at 17. 0/200 resolved
    4  agent ID ⇄ a record, now          resolveAgentId       MODEL / us      ✔
    5  model key ⇄ a slot limit          SlotTable Map.get    config / us     ✔
    6  provider ⇄ a slot limit           modelKey.split("/")[0]               ✔
    7  a configured key ⇄ still present  `key in providerConfig`  us / us     ✔
       the keys under test came from Object.entries of that same object
    8  extension name ⇄ a loaded ext     filterExtensions     person / pi     ✔
       folded on both sides; TWO spellings deliberately accepted (path name,
       npm short name); an unmatched name is reported
    9  skill name ⇄ the denylist         name.trim().toLowerCase()  person/us ✔
   10  skill ⇄ one already loaded        realpath OR name     fs / person     ✔
       two identity questions about one object, deliberately
   11  agent dir ⇄ the dir pi uses       join(homedir(),…)    env / pi    ✘ AO7
       skill-loader root 3: which skills a SUBAGENT gets

   TOOLS
   12  tool name ⇄ WRITER_TOOLS          Set.has, EXACT       pi / us         ✔
   13  tool name ⇄ CAN_CHANGE_TOOLS      Set.has, EXACT       pi / us         ✔
       mixed case in one set — correct, both sides are pi's spelling
   14  tool name ⇄ "bash" (rtk)          !==                  pi / us         ✔
   15  tool name ⇄ EXCLUDED_TOOL_NAMES   .includes            pi / us         ✔
   16  tool name ⇄ permissionTools       .includes, EXACT     pi / PERSON ✘ AO2
       the ONE branch of needsApproval that fires in mode `off`
   17  tool name ⇄ permissionTools, now  namesTool (folded)   pi / person     ✔

   THE LOOP
   18  model spec ⇄ the registry         resolveModel         person / pi     ✔
       ends in a silent first-match — correct because switchModel NAMES the
       pick in the operator's terminal on the next line (§4.2)
   19  a bash run ⇄ "it finished"        marker PRESENCE      bash / us       ✔
       the marker's VALUE is deliberately never read (AB1, AC3)
   20  this turn ⇄ the last turn         a signature digest   us / us         ✔
       a digest used as EVIDENCE, never as identity (§4.4)
   21  directive kind ⇄ DIRECTIVE_KINDS  Set.has              us / us         ✔
   22  tool action ⇄ TOOL_ACTIONS        Set.has, folded      model / us      ✔

   THE VERIFIER
   23  a WHY line ⇄ the prompt's own     startsWith, BOTH     model / us      ✔
       instruction                       directions, folded
   24  a line ⇄ "this is a verdict"      VERDICT_LINE regex   model / us      ✔
   25  a verdict ⇄ the menu we printed   VERDICT_MENU regex   model / us      ✔
   26  an ANSWER ⇄ its BRIEF             a model call         child / us      ✔
       the one identity question in the stack that cannot be a compare

   THE CHANNEL — THE EXTENSION
   27  a rendering ⇄ the room it came    blockMatches, whole  pi / us     ✘ AO3
       from                              string, EXACT
       two DMs saying `hi` both render `[matrix] hi`; the loop has no break
   28  a rendering ⇄ the room, now       uniqueInjection      pi / us         ✔
   29  a room ⇄ awaitingReply            Map.get, EXACT       sidecar / us    ✔
   30  text ⇄ something already sent     SentRegistry —       model / model   ✔
                                         whitespace and case folded
       the fold IS the point: a model rarely reproduces its own wording
   31  a command name ⇄ KNOWN_COMMANDS   .includes, folded    matrix / us     ✔
   32  a command ⇄ MATRIX_LOCAL          hasOwnProperty.call  matrix / us     ✔
   33  a command ⇄ MATRIX_ALLOWED        hasOwnProperty.call  matrix / us     ✔
   34  a setting key ⇄ its enum          .includes on a       person / us     ✔
                                         fixed list
   35  a pending code ⇄ access.pending   access.pending[code] person/JSON ✘ AO6
   36  a room ⇄ access.rooms (remove)    access.rooms[id]     model/JSON  ✘ AO6
   37  an inflight token ⇄ this one      ===                  us / us         ✔

   THE CHANNEL — THE SIDECAR
   38  an event ⇄ one already queued     entry.id === id      hs / hs         ✔
   39  an event ⇄ one already delivered  ts <= watermark      hs / hs     ✘ AO4
       a claim about IDENTITY made out of a claim about TIME
   40  an event ⇄ one already delivered, alreadyDelivered:    hs / hs         ✔
       now                               id above the horizon, ts below it
   41  a sender ⇄ access.allowFrom       .includes, MXID_RE'd matrix / person ✔
   42  a room ⇄ access.rooms (the gate)  `roomId in rooms`    MODEL/JSON ✘ AO6
       the docstring names prompt injection as the actor it exists for
   43  a message ⇄ "addressed to me"     seven spellings      matrix / us     ✔
       fails deliberately toward YES
   44  a file ⇄ "inside the state dir"   realpath BOTH sides  model / us      ✔
       + separator
   45  a pid ⇄ "one of ours"             pid file + `ps args` os / us         ✔
       a proxy identity with a confirming question attached
   46  an extension ⇄ ".mjs kind"        extname().toLowerCase()  fs / us     ✔

   ARTEFACTS AND DIRECTORIES
   47  the staged runtime ⇄ this source  sha256(path+content) fs / fs     ✘ AO5
       the SUITE was the fifth reader, and the only silent one
   48  the staged runtime ⇄ this source, stagedState()         fs / fs        ✔
       now (the harness)
   49  PI_CODING_AGENT_DIR ⇄ pi's dir    env ?? join(…)       env / pi   ✘ AO7
       four readers in prinny-channel, none of them expanding `~`
   50  a spill dir ⇄ a live process      pid parsed from name os / us         ✔
   51  the compaction lock ⇄ its owner   owner string, ===    4 copies        ✔
   52  a worktree ⇄ the parent's repo    git-common-dir,      git / git  ✘ AO8
                                         ONE side realpath'd
       `--git-common-dir` answers RELATIVE in a main worktree and ABSOLUTE in
       a linked one, so the relative answer is resolved against a cwd that was
       never canonicalised. Recorded as latent, then closed — §11.9
   53  a JSON-RPC reply ⇄ its request    `typeof id === 'number'`  server/us LATENT
```

Fifty-three rows; **eleven carry a ✘, and those eleven are the eight findings**
— rows 35, 36 and 42 are AO6, rows 11 and 49 are AO7. One more is latent and
recorded rather than fixed (§13.1). The remaining forty-one are correct, and
§13.2 says why for the dozen where "correct" is not obvious.

Row 52 was itself recorded as latent when this document was first written, and
closed a few hours later (§11.9). It is left in the table as a finding rather
than quietly upgraded, because the interesting part is not the fix — it is that
the reason given for leaving it (*"the case that would prove it is not reachable
on this box"*) was wrong, and took four minutes with real git to disprove.

### 10.2.1 The findings by WHERE THE VALUE CAME FROM

The seventeenth pass's most useful statistic was that six of seven findings were
"distance zero" — the correct version visible on screen. This axis has a
different and more actionable one. Sort the fifty-three rows by the far side of
the comparison: who minted the value being looked up.

```
   WHERE THE LOOKED-UP VALUE CAME FROM        ROWS   FINDINGS
   ─────────────────────────────────────────  ─────  ──────────────────────────
   this process, both sides                      7   0
   pi (the host's own registry or echo)          6   1   AO3, and see below
   a person (an operator, a file author,        11   2   AO2, AO7
     an environment variable)
   a MODEL                                      12   2   AO1, AO6
   another machine (a homeserver, a phone)       8   1   AO4
   a child process, the OS, the filesystem       7   1   AO8 (+1 latent)
   another BUILD of ourselves                    2   1   AO5
   ─────────────────────────────────────────  ─────  ──────────────────────────
                                                53   8
```

**Thirteen of the fifty-three rows have both sides minted inside this process or
by pi, and twelve of those are correct.** Exact `===` and `Set.has` over our own
strings, including two that look alarming out of context — a mixed-case tool set
(§4.1) and an `in` over a parsed object (§5.3) — and every one of them holds.

**The thirteenth is AO3, and it is the most instructive row in the table.** Its
compare is ours against ours: `blockMatches` tests pi's echo of our own injected
string against the string we stored. Both sides are ours, and it is still a
finding — because the VALUE is a rendering of a sentence **a stranger chose**.
`renderInboundMessage` drops the room, the event and the sender, so what is left
is the sender's own words, and two senders can pick the same ones. The compare
never fails; the proxy is simply not injective, and nobody owns the input.

**AO8 is the second exception, and a different one.** Both of its values are
produced by the same program — `git rev-parse --git-common-dir`, asked twice —
and it is still a finding, because git answers that question in **two shapes**:
relative in a main worktree, absolute in a linked one. One supplier is not one
spelling. That is the failure mode the supplier column cannot see, and it is why
§1.2 lists the SPELLINGS of each name rather than only its source.

So the rule the table produces is not "audit comparisons across boundaries",
which would have missed AO3 and AO8. It is:

> **Name the two values, then ask who could have chosen them.** A comparison is
> safe when both sides are values this process minted *and* nothing outside it
> decided their content. The moment either half is chosen elsewhere — by a
> person, by a model, by a homeserver, by a stranger typing a word — the
> comparison is an identity claim about someone else's data.

The second-order observation, and the one worth carrying: **the model boundary
is the least visible of the six, because we are on both sides of it.** We print
the string and we parse it back, so it does not look like a boundary at all.
AO1, AO3 and AO6 all have the shape *"we told the model something, and then
failed to accept what we told it"* — and in AO1 the publishing site and the
rejecting lookup are in the same function, twenty lines apart.

### 10.3 The three ladders, and the rule that separates them

§1.6 draws them. The rule, written once:

```
   REPORT AMBIGUITY WHEN THE CALLER CANNOT SEE WHAT YOU PICKED.

   resolveType      → a tool result the MODEL acts on         report
   resolveAgentId   → a tool result the MODEL acts on         report
   resolveModel     → a TUI notice naming the pick            pick, and say so
```

And the corollary that cost this pass an afternoon, in
`ambiguousAgentIdMessage`: **the candidates of an ambiguity are by construction
identical at the length that was asked.** Printing them at that length says
`abcdefgh, abcdefgh. Use more of the id.` — the same defect as AO1 with the
volume turned up. `distinguishingLength` widens the display to the shortest
prefix at which the candidates differ.

### 10.4 The folds, and what each one is for

```
   WHERE                     FOLDS                      BECAUSE
   ────────────────────────  ─────────────────────────  ────────────────────────
   resolveType               case                       a model upper-cases
   resolveAgentId            case, then prefix          we published a prefix
   namesTool (AO2)           case, whitespace           an operator typed it
   parseSetting (AO2)        case, for DE-DUPING only   `bash, Bash` is one
                                                        instruction; the
                                                        operator's spelling is
                                                        what gets stored
   DENIED_SKILL_NAMES        case, whitespace           a person wrote the file
   filterExtensions          case, both sides           a person wrote the list
   SentRegistry              case, ALL whitespace       a model rarely repeats
                                                        itself byte for byte
   command-routing           case                       a phone keyboard
   inbox kind                case, on the extension     a filesystem
   isMentioned (word match)  case, unicode-aware        a display name
   ────────────────────────  ─────────────────────────  ────────────────────────
   mergeAgentOverrides       NOTHING — deliberately     folding at the STORE
                                                        picks a winner silently
   allowFrom / access.rooms  NOTHING — deliberately     an MXID and a room ID
                                                        are case-significant
                                                        protocol values
```

Every fold in the stack is on a value a human or a model produced. Every refusal
to fold is on a value a machine produced. There is no exception in either
direction, and that is a better rule than "fold everything" or "fold nothing".

### 10.5 The prototype-reachable lookups, all of them

Written down because §10.1's second clause is enforced against this list, and
because a tenth would otherwise be a tenth finding rather than a failing test.

```
   OVER PARSED JSON — must be hasOwnProperty.call / Object.hasOwn / entries
     access.pending[code]        access-store.ts  pair()            fixed AO6
     access.pending[code]        access-store.ts  deny()            fixed AO6
     access.rooms[roomId]        access-store.ts  removeRoom()      fixed AO6
     roomId in access.rooms      server access.ts assertAllowedRoom fixed AO6
     access.rooms[roomId]        server access.ts gate()            fixed AO6
     the pairing loop            server access.ts  Object.entries — always right

   OVER OBJECTS WE BUILT — `in` is fine, and stays
     key in providerConfig       concurrency-slots.ts  (§5.3)
     key in modelConfig          concurrency-slots.ts
     hasOwnProperty.call ×2      command-routing.ts — already correct, and the
                                 model this pass copied
```

---

## 11. The findings

Seven, AO1–AO7, all fixed, each with a regression test that fails when the fix is
removed and a probe that prints BEFORE and NOW so it is its own control — plus
**AO8 (§11.9)**, which this document first recorded as an open latent and which
was closed a few hours later, once it became clear the reason for leaving it did
not survive four minutes with real git, and **AO9 (§11.10)**, added the session
after, which is not a defect in the stack but in this document: AO1's fix could
be reverted with 1,434 tests and 121 probes staying green, and a single live
delegation caught it on the first call.

Two of the nine were found by checking something this document had already
written down — AO8 a decision, AO9 a control run. **Both reasons were sentences
nobody had tested.**

### 11.1 AO1 — the id the model is shown is not the id `StopAgent` accepts

**Shape 3.** `vendor/pi-subagents-lite/src/agents/agent-id.ts` (new),
`agent-manager.ts`, `tool-execution.ts`

An agent id is minted as `randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH)` with
`AGENT_ID_PREFIX_LENGTH = 17`. Eleven places print `id.slice(0,
SHORT_ID_LENGTH)`, and `SHORT_ID_LENGTH` is **8**. Four of the eleven are read by
the model:

```
   agent-status.ts:33        AgentStatus — the tool whose whole job is
                             "which agents exist"
   spawn-coordinator.ts:493  the `subagent-result` message, i.e. the background
                             completion the model actually reads
   tool-execution.ts:426     the "Running agents:" list INSIDE StopAgent's own
                             refusal
   tool-execution.ts:484     StopAgent's own success lines
```

and `executeStopAgentTool` resolved `params.agent_id` with

```js
   const record = getManager()!.getRecord(requestedId);   // this.agents.get(id)
```

an exact `Map` lookup on the seventeen.

**Measured** (probe `ab1`, mode `published`): 200 freshly minted ids, each looked
up by the eight characters every surface prints — **0 of 200 resolved.**

**The refusal is the part with teeth.** A model that calls `StopAgent` with what
`AgentStatus` printed is told:

```
   Agent 70acbd91 not found. Running agents: aa5d3df1 (explore), 2ab84098 (general-purpose)
```

It retries with one of those and gets the identical answer, forever. The helper
that builds that list carries the docstring *"one line, easy for LLM to parse"* —
and it is easy to parse and impossible to use. This is on the one tool whose
purpose is stopping a run that holds the single llama slot the parent's own next
call is queued behind.

**Why it survived twenty-three passes.** `run_in_background`'s own success
message is `Agent ID: ${agentId}` — the full seventeen, and the only surface that
ever carried it. The one path with a good identifier worked, so every hand test
of `StopAgent` that started from a backgrounded run passed.

**Why the LOOKUP moved and not the printers.** Printing seventeen characters
everywhere would fix it and spend the tokens the short form exists to save, on
every listing, forever, in eleven places — and any future printer would have to
remember. Eight hex characters of a v4 UUID are unique within any session this
manager will hold. So the published form stays and the lookup learns it.

**The fix.** `src/agents/agent-id.ts`, which imports nothing — the same
constraint `record-activity.ts`, `status-listing.ts`, `turn-tracking.ts` and
`git-failure.ts` are written under, because `agent-manager.ts` and
`tool-execution.ts` both import pi and neither can be loaded by `node
--experimental-strip-types --test`. A rule that cannot be driven by the suite is
a rule with no control run.

```
   resolveAgentId(requested, known)
     exact                    → resolved      a full id is never ambiguous
     one case-insensitive hit → resolved      a model that upper-cased the hex
     one prefix hit           → resolved      the eight characters it was shown
     two or more              → ambiguous     say which, never choose
     none                     → not-found
```

which is `resolveType`'s ladder one field over, including its rule that
ambiguity is reported and never picked (§10.3). **Exact before prefix** matters
and is not theoretical: an id is a prefix of itself, and a truncated id could in
principle be a prefix of two records, so the full id has to resolve to its own
record even then.

`AgentManager.resolveId(requested)` is `resolveAgentId(requested,
this.agents.keys())`. `getRecord` is untouched and still exact — every caller in
the package but one hands it an id the package produced, and that is the right
lookup for them. `executeStopAgentTool` asks `resolveId`, and every sentence it
writes now names the agent in the **short** form, so a reply never identifies a
record in a spelling the next call rejects.

`ambiguousAgentIdMessage` widens the candidates to `distinguishingLength`, for
the reason in §10.3: candidates of an ambiguity are identical at the length that
was asked, and printing them there would say `abcdefgh, abcdefgh. Use more of
the id.`

**Tests.** `vendor/pi-subagents-lite/tests/agent-id.test.ts`, 12 tests. **Control
run: with the ladder replaced by `Map.get`, 5 of 12 fail.** **Probe** `ab1`,
three modes — `published`, `ambiguous`, `full`.

### 11.2 AO2 — the always-ask list that names a tool the gate does not know

**Shape 3.** `vendor/prinny-channel/src/permission-gate.ts`, `src/config.ts`,
`extensions/index.ts`

`permissionTools` is the list of tool names that are gated **whatever the
permission mode says**, and the module's own docstring says why: *"An explicitly
listed tool is gated whatever the mode says — including when the mode is `off`,
because naming a tool is a more specific instruction than choosing a mode."* It
is therefore the one branch of `needsApproval` that can be the **only** gate in
force, for an operator who set the mode to `off` and named two tools.

It was matched with `settings.permissionTools.includes(toolName)` — an exact
string compare — against a list `parseSetting` stores unvalidated: split on
commas, trim, keep whatever is left.

**Tool names in this stack are not one case** (§2.2). pi's built-ins are lower;
this repo's own are not. So:

```
   /prinny set permissionTools Bash        stored, echoed back, gates NOTHING
   /prinny set permissionTools agent       stored, echoed back, gates NOTHING
```

and it fails silently in both directions: nothing refuses the name, and a gate
that never fires looks exactly like a gate the operator configured correctly and
a model that never did anything risky.

**What makes it a finding rather than a typo.** Every other setting in that
`switch` is checked against its enum (`DELIVER_AS`, `FORWARD_MODES`,
`PERMISSION_MODES`), and every other allowlist in the package validates its
entries **with a sentence saying why**:

```
   MXID_RE      "A bare localpart in the allowlist silently matches nobody"
   ROOM_ID_RE   "an alias moves between rooms, an ID does not"
```

The list of TOOL names had neither the enum nor the sentence, and it is the one
whose failure is invisible.

**Why the repair is at the comparison.** There is no tool registry on
`ExtensionContext` (§2.2) — pi exposes `ui`, `mode`, `cwd`, `sessionManager`,
`modelRegistry`, `model`, `scopedModels`, `thinkingLevel` and the lifecycle calls
and nothing that lists tools — so `parseSetting` cannot check a name against the
set of real tools at the moment it is typed.

**The fix.**

```js
   export function namesTool(toolName: string, list: readonly string[]): boolean {
     const wanted = toolName.trim().toLowerCase();
     return list.some((name) => name.trim().toLowerCase() === wanted);
   }
```

Folding is the `ask` direction, which is this module's stated rule — *"The
direction of every judgement call below is ask, never skip"*. The only way
folding changes an outcome is by gating a call the operator had already named;
two tools differing only by case would both gate, which is the same direction
again. Whitespace is folded for the same reason `parseSetting` trims: `bash ,
write` is one operator writing two names, not three.

`parseSetting` de-duplicates by **the same question the gate asks**, keeping the
operator's own spelling for the first occurrence — so `bash, Bash` stores one
entry, and the list's length stays a true claim about how many tools are gated.
`/prinny set`'s help line says the matching ignores case.

**The correct version of this shape is in the sibling package** (§5.4):
`filterExtensions` folds an operator-written list on both sides, accepts two
spellings per extension deliberately, and reports a name that matched nothing.

**Tests.** `vendor/prinny-channel/tests/permission-gate.test.ts`, 40 tests.
**Control run: with `namesTool` reverted to `.includes`, 3 of 40 fail.**
**Probe** `ab2`, three modes — `off`, `all`, `store`.

### 11.3 AO3 — the room pi consumed, identified by a string two rooms can produce

**Shape 3.** `vendor/prinny-channel/src/inbound.ts`, `extensions/index.ts`

A room becomes eligible for an answer when pi echoes its message back as a
`user` message. `markLive` walks `awaitingReply` and marks the first entry
`blockMatches` accepts:

```js
   if (entry.injected) return userMessageText.trim() === entry.injected.trim();
```

— the whole rendered string. `markLive`'s own docstring said *"Matching is on the
Matrix event ID, which is unique and appears in the block as an attribute"*, and
that stopped being true when the `<channel …>` block was replaced by the one-line
`[matrix]` marker. `renderInboundMessage` deliberately drops `room_id`,
`message_id`, `user_id` and — in a DM — `from=` as well, because there is one
possible sender and naming them every time is noise.

```
   two DMs, two senders, one word        both render as   "[matrix] hi"
```

**Why that is a leak and not a nuisance.** `liveRooms()` is read by
`forwardToMatrix` and by `resolveActionRoom`, and the answer is sent when exactly
one room is live. If two rooms are outstanding with the same rendering and only
one was actually taken by pi — a delivery that threw because a compaction was in
flight is the ordinary way that happens, and `delivery.ts` exists because it
cannot be observed — the single echo marks whichever entry the Map yields first.
**The loop has no `break`**, so in fact it marks BOTH: `liveRooms().length === 2`,
and `forwardToMatrix` refuses. The person pi actually took a message from gets no
answer, and both rooms are told somebody else was being answered.

`markLive` is the function whose own docstring names what is at stake: *"the
current turn's answer, about the operator's private local work, would be
forwarded to whoever just messaged. Nobody would see that happen from this
side."*

**The fix.** `uniqueInjection(message, outstanding)` in `inbound.ts` — a
rendering no other OUTSTANDING message could have produced:

```
   plain                          → if no other entry has it, use it
   nameSender  (from=…)           → the first widening
   nameSender + #n, n = 2…64      → the second
```

Zero tokens unless a collision was about to happen: one outstanding room, or two
whose words differ, renders exactly as before. The first widening is `from=`,
which is information the model can use rather than a disambiguator it cannot —
and `is_direct` is the sidecar's own flag, so a sender cannot suppress their own
name by choosing a display name that looks like one.

`deliverInbound` passes `outstandingInjections(room)`: every other pending
entry's `injected` text, excluding entries already marked live and excluding the
room's own previous entry, which `mergeAwaiting` replaces. The exclusion list is
exactly `markLive`'s, so the two cannot disagree about what is outstanding.

`markLive`'s docstring now says what it matches on.

**Tests.** `vendor/prinny-channel/tests/inbound.test.ts`, 33 tests. **Control
run: with `uniqueInjection` reduced to `renderInboundMessage`, 4 of 33 fail.**
**Probe** `ab3`, three modes — `collision`, `distinct`, `silenced`.

### 11.4 AO4 — the instant that stood in for the message

**Shape 4.** `vendor/prinny-channel/server/src/queue.ts`, `server/src/server.ts`

The outbox watermark answered *"have I delivered this?"* with *"is this from an
instant I have already passed?"*:

```js
   if (message.ts <= readWatermark()) return false;   // enqueue
```

under a docstring reading *"Everything at or below this has been seen"* — a claim
about IDENTITY made out of a claim about TIME.

`origin_server_ts` is set by the **sender's** homeserver. The two come apart in
three ordinary ways:

```
   two events in the same millisecond      `ts <= watermark` drops the second
   two rooms, two homeservers, two clocks  a live message stamped below ours
   federation delivering out of order      the same, without any clock being wrong
```

**What that costs.** `handleInbound` reads `enqueue`'s `false` as *"Already
delivered on an earlier run"* and returns — **after** the acknowledging reaction
has already been sent. From the sender's side the bot reacted and then never
answered, which is the exact failure the outbox exists to prevent, reached
through the outbox.

**The fix.** Identity above a clock-skew horizon, time below it.

```
   CLOCK_SKEW_MS       5 * 60 * 1000    the ordinary sanity bound for skew
   MAX_REMEMBERED_IDS  200              far more than five minutes of one
                                        conversation, a few kB in the file

   Watermark = { ts: number; ids: string[] }

   alreadyDelivered(message, watermark)
     watermark.ids.includes(message.id)            → true    (identity)
     message.ts < watermark.ts - CLOCK_SKEW_MS     → true    (time)
     otherwise                                     → false
```

The timestamp still bounds the catch-up, which is the job it was written for:
re-offering a week of history is not something a session should have to
re-answer. Inside the horizon the question is asked of the **event id**, which is
what Matrix guarantees unique and what the queue's own de-duplication has always
used one line above.

`writeWatermark(ts, id)` only ever moves the timestamp forward and prunes the id
set to the horizon around whichever timestamp is newer, so a late-but-fresh
message is remembered even though it did not advance the mark.

**And one layer up.** `buildBot` used to pass `catchUpFrom: watermark.ts`. An
event below that floor never reaches `enqueue` at all, so the id check that would
have recognised it never runs. The floor is now `watermark.ts - CLOCK_SKEW_MS`,
and everything it lets back in is decided by event id.

**A file written before this pass** is `{ ts }` with no `ids`. It reads as a
watermark with an empty id set — which is exactly the old behaviour for
everything below the horizon and the new behaviour for everything above it.

**Tests.** `vendor/prinny-channel/tests/queue.test.ts`, 22 tests, four of them
rewritten (§11.8). **Control run: with `alreadyDelivered` reduced to `ts <=
watermark.ts`, 2 of 22 fail.** **Probe** `ab4`, four modes — `skew`, `twin`,
`ancient`, `redelivery`.

### 11.5 AO5 — the program the suite was testing

**Shape 4.** `vendor/prinny-channel/tests/harness.ts`

`loadServerModule` imports the sidecar's **compiled** output and calls that a
benefit, in its own docstring:

> the tests run against the compiled output, which has the side benefit of
> testing the artifact that actually ships rather than a re-compile of it.

That sentence is true exactly while the staged artifact IS this checkout's
source, and nothing in the harness ever asked whether it was.

The twenty-third pass built `stagedState()` — `current | stale | absent` — for
precisely this question, because four readers were each answering it with
`existsSync(dist/server.js)` alone, and converted all four. **The harness is the
fifth, and it is the only one whose wrong answer is silent: a stale runtime does
not fail a suite, it passes one.**

**Measured live, while the finding was written:**

```
   .source-stamp                     f297f2b6f673ac38…
   fingerprint of server/src         94b4a2f9753bd76c…
   stagedState()                     stale
   dist/                             access history inbox mentions permissions
                                     queue server state stdout-guard
                                     — no connect.js at all
   vendor/prinny-channel  npm test   511 tests, 511 pass
```

116 suites green against a build of sources that no longer exist in the tree, and
without AL3's fix for a connect loop that builds one matrix-js-sdk client per
failed attempt and stops none of them.

**The fix.** `assertRuntimeMatchesSource()` in `harness.ts`, called from **every**
`loadServerModule` rather than once at load — a `--prepare` in another terminal
is exactly the thing that changes the answer mid-run. A `stale` or `absent`
runtime is a hard failure naming the command that fixes it, with a different
sentence for each:

```
   stale   "it was compiled from different sources than this checkout"
   absent  "it has a dist directory but no compiled entry, so it was never
            finished"
```

**Refusing is the only honest option.** Skipping would report a suite as passing
that never ran; compiling from the harness would need the staged `node_modules`
and would turn a test run into a build.

**The consequence for anybody editing the sidecar.** Any change under
`vendor/prinny-channel/server/src/` now needs a `--prepare` before its tests
mean anything. That was always true; since this pass the suite says so instead of
passing quietly. Budget ~45 s per edit-test cycle.

**Tests.** `vendor/prinny-channel/tests/runtime-stamp.test.ts`, 23 tests.
**Control run: with the assertion removed, 1 of 23 fails.** **Probe** `ab5`,
three modes — `live`, `stale`, `absent`. The `live` mode is a reading of this box
rather than a reconstruction.

### 11.6 AO6 — the four lookups that answered for a key nobody stored

**Shape 1.** `vendor/prinny-channel/src/access-store.ts`,
`server/src/access.ts`

Four lookups over `JSON.parse` output:

```js
   const entry = access.pending[code]              access-store.ts  pair()
   if (!access.pending[code]) return false         access-store.ts  deny()
   if (!access.rooms[roomId]) return false         access-store.ts  removeRoom()
   if (roomId in access.rooms) return              server/access.ts assertAllowedRoom()
```

Eight inherited names are reachable on every one of them and all eight are
truthy (§2.3).

**What each one did, driven through the real store:**

```
   /prinny pair constructor    → "paired undefined. They can now reach this
                                  session." — and `null` pushed into allowFrom,
                                  where it is serialised as JSON null
   /prinny deny toString       → reported removing a pairing that never existed
   removeRoom valueOf          → reported removing a room that never existed
   assertAllowedRoom(x)        → ALLOW, for all eight
```

`pair` is the one with an effect: it found an "entry", read `undefined` off it
for `senderId` and `roomId`, compared `undefined < now` (false, so not expired),
pushed `undefined` onto the allowlist, deleted nothing, and said it had worked.

**The gate is the one with the actor named.** `assertAllowedRoom`'s docstring
says what it exists for: *"Without this, a prompt injection landing in the
session could name any room on the homeserver and have the bot post there."* The
`roomId` it tests is whatever the MODEL passed to the tool. Nothing was ever
posted through it — none of the eight is a room ID and the homeserver rejects
them — so it is a gate that answered a question it was never asked. That is worth
being precise about: **not exploitable, and still a gate whose answer did not
mean what it said.**

**The control was already in the package.** `command-routing.ts`, nine files
over, writes

```js
   if (Object.prototype.hasOwnProperty.call(MATRIX_LOCAL, name)) …
   if (!Object.prototype.hasOwnProperty.call(MATRIX_ALLOWED, name)) …
```

over two tables its own authors wrote, against a `name` that arrives in a Matrix
message. The tables in `access-store.ts` are read against a code an operator
types and a room id a model supplies, and they had the other form.

The second control is in the sidecar's own pairing loop, which uses
`Object.entries` — own-keys-only, always correct — and is why the symptom only
ever showed on the extension side.

**The fix.** `hasEntry(record, key)` in `access-store.ts`, used by `pair`, `deny`
and `removeRoom`; `Object.prototype.hasOwnProperty.call` in the sidecar's
`assertAllowedRoom` **and** in `gate()`'s room lookup, so the inbound gate and
the outbound gate cannot disagree about which rooms exist. `Object.hasOwn` is the
modern spelling and is available on the Node this runs on; the `.call` form is
kept so both halves of the package say it the same way and one grep finds all of
them.

§10.5 lists all five sites, and it is the list §10.1's second clause is enforced
against.

**Tests.** `vendor/prinny-channel/tests/access-store.test.ts`, 35 tests.
**Control run: with `hasEntry` reduced to truthiness, 5 of 35 fail.** **Probe**
`ab6`, three modes — `pair`, `rooms`, `control`.

### 11.7 AO7 — the third reader AN7's fix did not reach, and four spellings of one variable

**Shape 2.** `vendor/pi-subagents-lite/src/prompt/skill-loader.ts`,
`src/agent-dir.ts`, `vendor/prinny-channel/server/bin/agent-dir.mjs` (new)

Two halves.

**The third reader.** `skill-loader.ts` passed

```js
   loadSkills({ agentDir: join(homedir(), ".pi", "agent") })
```

as root 3 of four. AN7 found two readers that hardcoded that path, wrote
`src/agent-dir.ts` so the question has one answer, converted both, and did not
scan for a third. This was the third.

**Corrected 2026-08-23, by trying to hand-test it (§AI.7).** This paragraph used
to say it is *"the reader that decides which skills a SUBAGENT is given"*, full
stop. That is an overstatement, and the correction is worth more than the
original claim. Measured: a child's ordinary skill discovery goes through pi's
`DefaultResourceLoader` at `agents/agent-runner.ts:544`, built with
`agentDir: getAgentDir()` — **pi's own function, which honours the override**.
`skill-loader.ts` is reached only by `preloadSkills` and `loadSkillMeta`, i.e.
only for an agent whose frontmatter *names* its skills (`skills:` or
`preload_skills:`).

So the blast radius is narrower and more specific than recorded: on a relocated
install, an agent that names its skills looked them up in a
`~/.pi/agent/skills` that pi does not use — which for a fresh relocation is not
there at all — and was handed *"(Skill "x" not found in .pi/skills/,
.agents/skills/, or global skill locations)"* for a skill sitting in the
operator's real skills directory. A default `general-purpose` child was never
affected, which is why nothing noticed.

**How the overstatement survived**: the hand test was written but never run, and
the recipe it was written with (a default subagent) cannot reach the path. The
first BEFORE column produced the same answer as NOW — see §AI.7, which now
carries the recipe that does reach it.

**Measured 2026-08-23**, both columns, headless against the local model, with a
relocated agent directory holding the skill and an agent whose frontmatter
preloads it:

```
   NOW     MARKER-TOKEN-9F42-RELOCATED
   BEFORE  (Skill "relocated-marker" not found in .pi/skills/, …)
```

**And the "not found" above is the mild case.** It is what a *fresh* relocation
looks like, where the old directory is empty. Probe `ab11`'s `preload` mode puts
a skill in each directory and shows the other half: with a skill of the same name
still sitting in `~/.pi/agent/skills`, BEFORE does not report a miss — it loads
the OLD file and hands the child its content, silently, with no surface anywhere
saying which directory answered. A relocation that left the old skills behind was
therefore not "skills missing"; it was **skills quietly out of date**, which is
the harder of the two to notice and the one nobody would have gone looking for.

**Four spellings of one variable.** All four readers of `PI_CODING_AGENT_DIR` in
`prinny-channel` — `src/config.ts`, `server/src/state.ts`,
`server/bin/prinny-channel.mjs` and `tests/harness.ts` — wrote

```js
   env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
```

and pi's own `getAgentDir()` runs the value through `expandTildePath` first
(§2.5). `PI_CODING_AGENT_DIR=~/pi-work` is an ordinary thing to write in a shell
profile or an `.env`, and it is not expanded by any shell when it is quoted or
read out of a file. pi then keeps its files in `$HOME/pi-work` and this package
keeps **the allowlist, the credentials and the Olm store** in a directory
literally named `~`, relative to whatever the cwd was — so a second session
started somewhere else gets a second empty one. Everything works, and the bot has
no allowlist and no keys.

**And one more spelling, in the module written to end this.** `agent-dir.ts`'s
guard was `override && override.trim() !== ""`, which is a **better** rule than
pi's `if (envDir)` and a **different** one: a value of `"   "` is a relative
directory to pi and "unset" here. It now matches pi character for character.
Where the two disagree, pi is right by definition — pi is the one that writes the
files.

**The fix.**

```
   skill-loader.ts                    asks agentDir()
   src/agent-dir.ts                   guard matches pi's exactly; expandTilde
                                      read out of pi's normalizePath, down to
                                      the backslash form being win32-only
   server/bin/agent-dir.mjs   NEW     agentDir() + stateDir(), used by
                                      src/config.ts, the bootstrap and harness.ts
   server/src/state.ts                keeps a DELIBERATE duplicate — it is
                                      compiled with `rootDir: src` into a
                                      runtime outside the repo and cannot reach
                                      the helper — with an agreement test
```

**Two scans, one per package**, so a fourth reader is a failing test rather than
a fourth finding:

- `tests/agent-dir.test.ts` — no source but `agent-dir.ts` builds
  `join(homedir(), ".pi", …)` itself, and no source but `agent-dir.ts` names
  `PI_CODING_AGENT_DIR`. Comments are stripped first, because several files
  describe the path in prose and prose is not a reader. The match is deliberately
  **not** on the string `.pi/agent`: `<cwd>/.pi/agents` is the project agents
  directory, a different thing, correctly built in four files.
- `tests/config.test.ts` — the same scan over `prinny-channel`, with
  `server/bin/agent-dir.mjs` and `server/src/state.ts` allowlisted and the reason
  written down; plus a test that drives **both packages' copies** over
  `['~/pi-work', '~', '/opt/pi', '/tmp/~backup', '', 'relative/dir']` and asserts
  they agree, which is the arrangement the compaction lock and `json-store.ts`
  already use.

**Tests.** `vendor/pi-subagents-lite/tests/agent-dir.test.ts`, 15 tests, one of
them rewritten (§11.8); `vendor/prinny-channel/tests/config.test.ts`. **Control
run: with the tilde expansion removed, 2 of 15 fail.** **Probe** `ab7`, four
modes — `skills`, `tilde`, `agree`, `live`.

### 11.8 Off the axis — two tests that pinned the wrong thing

Both were found by this pass's own control runs, and both are the same lesson the
twenty-second and twenty-third passes each recorded once.

**`tests/queue.test.ts` (AO4's own).** A test named *"refuses anything already
delivered, which is what stops a re-answer"* asserted that a message **nobody had
ever delivered** is refused — because it carried an earlier timestamp than one
that was. It passed for exactly the reason the code was wrong. Split into four
tests that name the RULE (identity above the horizon, time below it, the horizon
itself, and a re-delivery of the same id) rather than its consequence.

**`tests/agent-dir.test.ts` (AO7's own).** A test named *"treats an empty
override as absent"* asserted `agentDir({ PI_CODING_AGENT_DIR: "   " }) ===
DEFAULT`, pinning a `.trim()` guard **pi does not have**. Rewritten to say which
rule it holds and why pi is right by definition.

The shared shape is worth naming once: **a test that asserts the current
behaviour of a rule, rather than the rule, will pin the defect if the rule is
wrong** — and it will look like coverage while it does it. Both of these were
written by the same hands as the code they were pinning, in the same hour.

### 11.9 AO8 — the worktree that was its own repository, and a decision that did not survive contact

**Shape 2.** `vendor/pi-subagents-lite/src/spawn/same-repo.ts` (new),
`src/spawn/worktree-validator.ts`

This one was recorded in §13.1 of this document as a latent, left unfixed, with
the reason written down: *"the fix is one call, and the case that would prove it
is not reachable on this box."* That reason was wrong, and it is worth reading
why before the finding itself, because the mistake is more transferable than the
bug.

`sameRepo` decides whether a `worktree_path` is a worktree of the PARENT's
repository or of a different one, and the caller applies the cross-repo trust
gate when it is different. It was

```js
   normalizeGitPath(parentResult.commonDir, parentCwd) ===
   normalizeGitPath(targetResult.commonDir, realPath)
```

with `realPath` through `realpathSync` and `parentCwd` not. **The comparison asks
"are these the same repository?" and answers "are these the same string?"**,
which is a different question the moment one side has been canonicalised and the
other has not.

**Why the asymmetry bites — measured with real git, not argued.** The premise
nobody had checked is that `git rev-parse --git-common-dir` answers in one shape.
It does not:

```
   in the MAIN worktree     ".git"                  ← RELATIVE
   through a SYMLINK to it  ".git"                  ← RELATIVE
   in a LINKED worktree     "/abs/…/real/.git"      ← ABSOLUTE
                                                      (git 2.39.5, this container)
```

The relative answer is resolved against the directory it was asked in. So with a
logical parent cwd:

```
   parentCwd (a symlink)     /tmp/ab8-GI92lL/link
   parent  --git-common-dir  ".git"
   target  (realpath'd)      /tmp/ab8-GI92lL/wt
   target  --git-common-dir  "/tmp/ab8-GI92lL/real/.git"

   BEFORE  parent side  /tmp/ab8-GI92lL/link/.git
   NOW     parent side  /tmp/ab8-GI92lL/real/.git
           target side  /tmp/ab8-GI92lL/real/.git

   BEFORE  sameRepo → false          NOW  sameRepo → true
```

A worktree of the parent's **own** repository reads as cross-repo, and
`resolveSubagentTrust` gates a repository the operator already trusts.

**It is still latent in production, and that part of the record was right.**
`parentCwd` is `getSessionCtx()?.cwd ?? ctx.cwd`; pi builds that from
`process.cwd()` (`dist/cli/startup-ui.js:47`) through `resolvePath`, which
normalises and absolutises but does **not** canonicalise
(`dist/utils/paths.js:82`); and on Linux `process.cwd()` is physical. Checked,
not assumed. What the measurement changes is the distance to live: **one
`--cwd`-style option, one platform, or one caller passing a path a person typed**,
with nothing in between to catch it.

**What the wrong reason actually was.** "Not reachable on this box" conflated two
things: the CASE (a logical parent cwd) and the ABILITY TO DRIVE IT. The case is
a parameter — `validateWorktreePath` takes `parentCwd` as an argument, so
reaching it costs one `symlinkSync`. What was genuinely blocked was loading the
module at all: `worktree-validator.ts` uses a `.js` specifier for `../utils.ts`,
which plain node will not resolve, and its own header says so. That is the
condition this package has answered five times — `git-failure.ts`,
`record-activity.ts`, `status-listing.ts`, `turn-tracking.ts`, `agent-id.ts` —
by lifting the rule into a module that imports nothing awkward.

**The fix.** `src/spawn/same-repo.ts`, the sixth such extraction. It holds
`normalizeGitPath` (moved unchanged, win32 folding and all) and

```ts
   isSameRepo(parent: RepoSide | undefined, target: RepoSide,
              canonicalise: Canonicalise = canonicaliseWithFs): boolean
```

which canonicalises **both** cwds before resolving either side. Three properties
were chosen deliberately:

- **Both sides, in one place.** The caller no longer does the comparison, so it
  cannot get it half-right again. Canonicalising an already-canonical path
  returns it unchanged, so the target side — which the validator has already
  realpath'd — is unaffected.
- **`canonicalise` is a parameter.** A test can drive a platform whose
  `process.cwd()` is logical without running on one, and the dependence is
  visible in the signature rather than buried in an import.
- **An unresolvable path falls back to itself.** A cwd deleted under a running
  session then compares as the string it was given, which is exactly what this
  code did before the fix and is never worse than it.

**Tests.** `tests/same-repo.test.ts`, 10 tests, on a fixture of **real git** — a
repository, a symlink to it, a linked worktree, and a second repository — because
the whole finding is about what git actually prints in two situations, and a fake
would be a test of the fake. One of the ten pins those two shapes, so a change
upstream is a failing test rather than a rule resting on a stale observation.
**Control run: 2 of 10 fail with the canonicalisation removed.** **Probe** `ab8`,
four modes — `shapes`, `logical`, `physical`, `foreign`.

The `physical` mode is the one to read second: it is the control that shows the
fix changes nothing on this platform, which is the same sentence as "this is why
it was latent" and is why it went twenty-four passes unnoticed.

### 11.10 AO9 — the fix that could be reverted quietly

**Added 2026-08-23, the session after this document was written.** Not a defect in
the stack: a defect in this pass's own evidence, found by finally running the
hand test the pass had left unrun.

**Shape 3, one level up.** `vendor/pi-subagents-lite/tests/agent-id.test.ts`

§11.1 ends with *"Tests. 12 tests. Control run: with the ladder replaced by
`Map.get`, 5 of 12 fail"*, and §12.3 records probe `ab1`. Both are true and
neither is about the wiring. `agent-id.test.ts` drives `resolveAgentId` directly;
`ab1` drives the same module beside a quoted copy of the old expression, and says
so in its own header. **Nothing anywhere touched the one line that makes the fix
reach a caller:**

```js
   const resolution = getManager()!.resolveId(requestedId);   // tool-execution.ts:450
```

**Measured.** That line was put back to its pre-AO1 form — `getRecord(requestedId)`,
the exact `Map` lookup — and the gates were re-run:

```
   1,434 tests   0 failed        the suites did not notice
     121 probes  all exit 0      the probes did not notice
     115/115     lint clean
   one live delegation           caught it on the FIRST StopAgent call
```

Probe `ab9` was then written, and it catches the same revert in every one of its
four modes — so the gap was not that the code was undrivable, which is the part
worth reading twice.

The live run is §AI.1 of the hand-testing script, and its refusal is the sentence
§11.1 predicted, printed by the real stack for the first time:

```
   Agent cbc6575f not found. Running agents: cbc6575f (general-purpose)
```

**Why the existing "control" test did not hold it.** The last test in
`agent-id.test.ts` is named *"control — the exact lookup StopAgent used to make
still misses the short form"* and asserts that `new Map(ids…).get(short)` is
`undefined`. That is a true statement about `Map`, and it is true whether or not
this package still evaluates it. **A control has to be able to fail.** Its comment
said *"stated as a test so the fix cannot be reverted quietly"*, and the fix was
then reverted quietly, in this container, in one edit.

**Why `ab1` quoted instead of driving, and why that reason does not survive being
looked at.** `ab1`'s header says `tool-execution.ts` and `agent-manager.ts` import
pi, so neither loads under `node --experimental-strip-types`. That is true, and it
is **the constraint the SUITE runs under**. A probe is not the suite. `q2` has
driven the real `executeStopAgentTool` through **pi's own jiti** since the
thirteenth pass — a probe about this same function, in the same directory — and
its own header says why in a sentence this pass should have read:

> *"a fix whose test cannot execute the function it changed is pinned against
> editing, not against breaking (the twelfth pass's own lesson, AC1)."*

**AO1 shipped pinned against neither.** The constraint was inherited from the
wrong place and the technique was already in the directory.

**The fix is two instruments, because they fail at different times.**

**Probe `ab9`**, four modes, driving the shipped function through jiti over a real
`AgentManager`. The BEFORE column replaces `resolveId` **on the instance** with
the exact lookup the tool used to make, and nothing else differs — the "one
operator swapped" form of §12.3's addendum, extended from a module to a call
site. **Control run: all four modes exit 1 with the defect restored, all four exit
0 with it fixed.**

```
   published  50 minted ids, asked with the eight every surface prints
              BEFORE 0/50 stopped     NOW 50/50, and abortController really aborted
   ambiguous  two records sharing the eight — named, not picked
   refusal    the sentence is IDENTICAL in both columns; each id it offers is
              retried THROUGH THE TOOL — 0 of 2 accepted BEFORE, 2 of 2 NOW
```

`refusal` is the artefact: *"Agent 5e3ae827 not found. Running agents: e14e3787
(general-purpose), 06aae107 (explore)"*, printed the same either way, and the only
difference is whether following its advice does anything. That is the loop with
no exit, executable.

**And a source pin in the suite** — `describe("AO9 — StopAgent's resolution call
site")`, seven tests, in the AO1 file so the rule and its wiring are read together
— for the different reason that it costs nothing per run and fails on the edit
rather than on the next probe sweep. The package already had two of these
(`action-report.test.ts`'s `describe("AF2 — the wiring")`,
`background-delivery.test.ts`) and twenty-one of its test files already read
`src/` as text. It slices `executeStopAgentTool`'s body out of a comment-stripped
source — the defect is quoted verbatim in the fix's own comment there, which would
make a naive search pass on the comment — and asserts the slice bounds **first**,
as the control for the absence assertion that follows.

**Control runs — two, because the finding has two halves:**

```
   the lookup put back to getRecord(requestedId)   2 of 19 fail
   the reply changed to `Stopped agent ${agentId}` 1 of 19 fail
```

The absence assertion never fires alone: the positive assertion beside it fails
in the same run, which is the thirteenth pass's rule about absence assertions
applied to a source pin.

**`ab9`'s own first draft made this pass's mistake inside the fix for it**, and it
is recorded because that is the most useful thing here. Its `refusal` mode
originally fed each offered id back through `manager.resolveId` — and with the
defect restored in the source, **that mode passed**. Asking the manager tests the
ladder; it says nothing about which lookup the call site makes. **When a check
feeds a value back, it has to go back in through the door it came out of.**

**The transferable part, and it is the same shape as AO8 one level up.** AO8 was
this pass's recorded *decision* not surviving contact. AO9 is this pass's recorded
*evidence* not surviving contact. Both were caught by doing the cheap thing the
document said was not worth doing — and in both cases the document's reason was a
sentence nobody had tested. **When a pass reports a control run, ask what the
control was over.** `5 of 12` was a control over the ladder. It was never a
control over the package using it.

---

## 12. The evidence

### 12.1 The gates

The *before* column was measured before anything was written, so it is a
reading of the tree as this pass found it. The *after* column was **re-run from
scratch while this document was being written**, so it is a reading of the tree
as it stands now rather than a note from the session that changed it.

```
                                        before    after    +AO8    +AO9
   vendor/pi-subagents-lite  tests       477       493      503     510
   vendor/pi-loop-mode       tests       278       278      278     278
   vendor/prinny-channel     tests       511       550      550     550
   .pi/extensions/compaction-guard        75        75       75      75
   vendor/rtk-pi             tests        28        28       28      28
                                        ─────     ─────    ─────   ─────
                                        1,369     1,424    1,434   1,441
```

The third column is §11.9, added after this document's first draft; the fourth is
§11.10, added the session after it. Lint went 113 → 115 with `same-repo.ts` and
its test, and stays 115 for AO9 — a source pin adds no file to `src/`.

All five suites green, 0 failed, 0 skipped. Two of those numbers say something
beyond their own arithmetic:

- **`vendor/prinny-channel` 550 passing means the staged runtime is current.**
  Since AO5 the suite refuses to run against a build that is not this checkout,
  so a green prinny suite is now also a statement about `~/.pi/agent/channels/
  prinny/runtime`. It was not, on the day the finding was written (§11.5).
- **`lint 115/115` includes `agent-id.ts`**, which is the file the fix lives in
  and the reason it can be driven by the suite at all (§11.1). Corrected
  2026-08-23: this bullet said `113/113` while the table two paragraphs up said
  115 and the sentence between them said the count had moved — three readers of
  one number in one section, which is the finding this document is about.

### 12.2 The control runs

Each fix removed, its own suite re-run. The denominator is the whole file, so
these also say how much of each suite is about the finding.

```
   AO1  5 of 12 fail   (the ladder replaced by an exact Map.get)
   AO2  3 of 40 fail   (namesTool reverted to .includes)
   AO3  4 of 33 fail   (uniqueInjection reduced to renderInboundMessage)
   AO4  2 of 22 fail   (alreadyDelivered reduced to ts <= watermark.ts)
   AO5  1 of 23 fail   (the runtime assertion removed)
   AO6  5 of 35 fail   (hasEntry reduced to truthiness)
   AO7  2 of 15 fail   (the tilde expansion removed)
   AO8  2 of 10 fail   (the canonicalisation removed)
   AO9  2 of 19 fail   (the lookup put back to getRecord(requestedId))
        1 of 19 fail   (the reply changed to name the resolved seventeen)
        4 of 4 probe modes exit 1 with the lookup put back — `ab9`, which
        executes the shipped function rather than pinning its text
```

**AO9's denominator is `agent-id.test.ts` after it grew the wiring block**, 12 +
7. Its two control runs are listed separately because the finding has two halves
and one of them is a message rather than a lookup — and because a source pin is
worth exactly what its control run is worth, which is the whole point of §11.10.

AO5's `1 of 23` is the honest number and worth reading rather than dismissing:
there is exactly one thing to assert — that a stale runtime refuses — and the
other twenty-two tests in that file are about `stagedState()` itself, which AN2
wrote.

### 12.3 The eight new probes

**Nine, from 2026-08-23** — `ab9` was added the session after this document was
written, for §11.10, and it is the only one of them that loads a pi-importing
module (through jiti, the way `q2` does).

Each prints a BEFORE and a NOW column, so it is its own control. **All seven were
re-run in every mode while this was written — 23 modes, all green, every one
exiting 0** — and `ab8` adds four more, also green.

```
   ab1  the id the model was shown          published · ambiguous · full
   ab2  the tool the gate never recognised  off · all · store
   ab3  two rooms, one sentence             collision · distinct · silenced
   ab4  the instant that stood for the      skew · twin · ancient · redelivery
        message
   ab5  the program the suite was testing   live · stale · absent
   ab6  the key nobody stored               pair · rooms · control
   ab7  the directory two packages          skills · tilde · agree · live
        disagreed about
   ab8  the worktree that was its own       shapes · logical · physical · foreign
        repository                          (§11.9)
```

**Three of them run the shipped module with one operator swapped**, which is the
strongest form a BEFORE column can take — the two columns differ in exactly the
expression the finding was about, and nothing else:

```
   ab2   NOW    needsApproval from src/permission-gate.ts, unchanged except that
                its first branch asks namesTool
         BEFORE settings.permissionTools.includes(toolName), evaluated against
                the same settings object
   ab4   NOW    enqueue from the STAGED sidecar's queue.js, against a real
                temporary state directory
         BEFORE message.ts <= watermark.ts, against the same watermark
   ab6   NOW    the shipped access-store.ts and the staged access.js
         BEFORE the two expressions those files used to hold, over the same
                parsed object
```

**Two of them are readings of this box rather than reconstructions:**

```
   ab5 live   .source-stamp      d4ba699711f4b6f75c620dfcd509b0718cdf7e60a666e52cfd923d8dbda2d5fe
              server/src hashes  d4ba699711f4b6f75c620dfcd509b0718cdf7e60a666e52cfd923d8dbda2d5fe
              stagedState()      current — and connect.js is in dist/ for the
                                 first time, so AL3's fix is compiled in
   ab7 live   what the two packages answer for the agent directory here, with
              the override as this box actually has it
```

`ab1` cannot import `tool-execution.ts` or `agent-manager.ts` — both import pi —
so it drives the two expressions those files contain, quoted in its header, plus
the **real** resolution module and the **real** `SHORT_ID_LENGTH`, with ids
minted exactly as `AgentManager.spawn` mints them. `ab3` does the same for
`markLive` and `liveRooms`, which are eight lines between them and are reproduced
verbatim and marked, so what the probe drives is the rule rather than a
paraphrase of it.

### 12.4 The standing scans, still green

```
   the four compaction-lock copies agree on the key, the bound and the owners
   the two json-store copies agree on every case, both directions
   the two agent-dir copies agree on every case, both packages          (new)
   no source but agent-dir.ts builds pi's agent directory itself        (new)
   no source but agent-dir.ts names PI_CODING_AGENT_DIR                 (new)
   `verifyAnswer` still never throws — every path returns a VerifyOutcome
   `isVerifyingRecord` still has one definition and six readers
   every `env.SUBAGENT_*` the package reads is forwarded by the launcher
   the load order in scripts/pi-local.sh still matches the four behaviours
     that depend on it
```

### 12.5 The probe count, reconciled

Two numbers have been carried in two documents and they disagree. Both are
right; they count different things, and this is the reconciliation.

```
   ls context/testing/probes/*.mjs                                  126
     minus the four shared helpers  _host  _register  _sidecar  _ts-hook
                                                                    122
     minus one un-lettered one-off  verify-prior-fixes.mjs
                                                                    121  ← probes
```

So:

```
   THE NUMBER      WHAT IT COUNTS                       BEFORE   AFTER
   ──────────────  ───────────────────────────────────  ───────  ───────
   126             every .mjs in the directory            118      126
   122             …minus the four `_` helpers            114      122
   121             …minus verify-prior-fixes.mjs too      113      121
                   i.e. LETTERED PROBES — the number
                   worth quoting
```

The twenty-third pass's write-up says "probes 111 → 118" and the twenty-third
handoff says 118; those are the all-files column, and they are consistent with
this pass's 118 → 126. The twenty-fourth handoff's 114 → 122 is the
minus-helpers column. **Neither was wrong; they were unlabelled.** The number to
quote from here on is **121 lettered probes**, and `context/testing/probes/
README.md` is where that definition belongs.

**Update, 2026-08-23.** The definition held; the number moved and one row of it
did not. `ab9`, `ab10` and `ab11` bring it to **124 lettered probes / 129 files**.
The all-files row in `probes/README.md` was left at `126` while the two derived
rows were updated by hand — which is the failure mode this table was written to
prevent. Recounted against `ls` and noted there. Quote the lettered number, and
**recount it rather than incrementing it.**


### 12.6 Done on this box for the first time

**`--prepare` works here.** The twenty-third handoff carried it as blocking,
never exercised, and possibly broken, because `npm ping` does not answer in this
container. It ran four times during this pass, **~45 s each**, including the
local `@prinny/bot` link from `~/prinny-mono/prinny-bot`.

Two things follow, and both are load-bearing for anybody working on the sidecar:

- **The staged runtime is current**, and `connect.js` — AL3's fix for a connect
  loop that builds one matrix-js-sdk client per failed attempt and stops none of
  them — is compiled into it for the first time. §12.3 has the fingerprints.
- **Any edit under `vendor/prinny-channel/server/src/` now needs a `--prepare`
  before its tests mean anything.** That was always true; since AO5 the suite
  refuses instead of passing quietly (§11.5). Budget ~45 s per edit-test cycle,
  and do not debug a phantom when the refusal appears.

```
   node vendor/prinny-channel/server/bin/prinny-channel.mjs --prepare
   (or `/prinny prepare` in a session)
```

**Added 2026-08-23 — AO1 has been seen on the real stack, with a real control
run.** The pass's cheapest unrun hand test was run headless against the local
model (§AI.1 of the hand-testing script). `AgentStatus` printed `3ced427a`,
`StopAgent` was called with `3ced427a`, and the answer was `Stopped agent
3ced427a` — one call, no retry. The same prompt with the resolution line put back
to its pre-AO1 form produced the refusal this document predicted:

```
   Agent cbc6575f not found. Running agents: cbc6575f (general-purpose)
```

and the model **retried the identical id once** before falling back to the
seventeen it still had from the `Agent` tool's own result. It only had that
because the delegation was in the same conversation — which is precisely why
every hand test of `StopAgent` before this one passed (§11.1).

That control run is also what found §11.10.

**AO8 has been re-measured from a terminal**, on a real git fixture built for the
purpose (§AI.8): `git rev-parse --git-common-dir` prints `.git` in the main
worktree and through a symlink to it, and an absolute path in a linked worktree,
on git 2.39.5 in this container. Driving the shipped `isSameRepo` over it with
`canonicalise` swapped for the identity function gives `false`; with the real one,
`true`.

---

## 13. What is open, and what was checked

### 13.1 Open by decision, and the one latent left

- ~~**`worktree-validator.ts` compares one realpath'd path with one that is
  not.**~~ **Closed — §11.9 (AO8).** It was recorded here as latent and left,
  with the reason *"the case that would prove it is not reachable on this box"*.
  The reason was wrong and took four minutes with real git to disprove:
  `parentCwd` is a parameter, so reaching the case costs one `symlinkSync`. What
  was actually blocked was loading the module, which this package has answered
  five times by extracting the rule — and now six. **This entry is kept rather
  than deleted, because the mistake is the transferable part: "I cannot reach
  this" and "I cannot drive this" are different sentences, and only the second
  one was true.**
- **`mcp-stdio.ts`'s reply path is `typeof id === 'number'`.** A server that
  echoes a JSON-RPC id as a string drops the reply and the call times out. Latent:
  this stack's sidecar always echoes numbers. Same shape as AK3 — dispatch on the
  wrong field of a message that carries both — and recorded here because the
  identity being decided is "which of my outstanding calls is this the answer
  to", which is squarely on this axis.
- **`access.json` and `.env` each have two writers in two processes**, both
  read-modify-write. Carried from AN, unchanged; the repair is a lock file.
- **`/loop resume` is the one lifecycle transition of nine that does not clear
  the turn buffers.** Carried, unchanged.
- **The `.corrupt-<time>` files nothing removes.** A quarantine is a deliberate
  keep; a directory that accumulates them is an operator's to clean.

### 13.2 The measured negatives

Things this axis looked at and found already correct. Each is recorded because
"we checked and it holds" is what stops the next pass re-deriving it.

```
   ▸ `resolveType`'s ladder, and its refusal to pick. Exact, then a unique
     case-fold, then `ambiguous` with the candidates named. Its rule — "Never a
     silent pick (US-2)" — is the rule AO1's fix is built on, and it was already
     written down.

   ▸ `mergeAgents` keying on the EXACT frontmatter name. Deliberate: folding at
     the store would silently pick one file's contents over another's, and
     `resolveType` answers the case question separately, at lookup, where it can
     report ambiguity instead. Two questions, two places, one asymmetry. (§5.2)

   ▸ `resolveModel`'s silent first match. Correct because `switchModel`
     immediately notifies `Loop: model set to <provider>/<id>` in the operator's
     own terminal — the pick is visible at the moment it is made. This is the
     row that turns "always report ambiguity" into the sharper rule in §10.3.
     (§4.2)

   ▸ `concurrency-slots`' two `key in config` tests. The keys under test came
     from `Object.entries` of that same object four lines above, so they are
     own keys by construction. An `in` over parsed JSON is not automatically a
     defect. (§5.3)

   ▸ `command-routing.ts`'s two `Object.prototype.hasOwnProperty.call`s, over
     tables read against a name that arrives in a Matrix message. The control
     for AO6, in the same package, written by the same hands, with the same
     reasoning — and nine files away.

   ▸ `Object.entries` in the sidecar's own pairing loop. Own-keys-only, always
     correct, and the reason AO6's symptom only ever showed on the extension
     side.

   ▸ `SentRegistry`'s whitespace-and-case fold, and the sentence that justifies
     it: "a model rarely reproduces its own wording byte for byte". A fold on a
     value a model produced, which is exactly where §10.4 says folds belong.

   ▸ `filterExtensions` — an operator-written list of extension names, folded on
     BOTH sides, with two spellings per extension deliberately accepted and an
     unmatched name reported. AO2's shape, done correctly, in the sibling
     package. (§5.4)

   ▸ The four copies of `__PI_COMPACTION_IN_FLIGHT__` still agree on the key,
     the bound, the stale rule and the owner check.

   ▸ `isMentioned`'s seven spellings of "this is addressed to me", and the
     deliberate direction: a bot that answers something not addressed to it is a
     nuisance; a bot that ignores you is broken. The MXID is compared exactly,
     the localpart and display name by a unicode-aware bare-word match. (§8.1)

   ▸ The sidecar's stale-poller replacement asks `ps -p <pid> -o args=` before
     signalling, because the OS recycles pids. A proxy identity with a
     confirming question attached, and the reason named in a comment before the
     code was written. (§8.4)

   ▸ `assertSendable`'s path containment — both sides realpath'd, separator
     appended. The correct version of §13.1's first latent. (§8.5)

   ▸ Nothing in this stack compares user-supplied unicode for identity except
     `SentRegistry`, which folds deliberately. No `localeCompare`, no
     `normalize()`, no case-folding of a protocol value. Checked, because
     "two strings that look the same" is the obvious next question on this axis
     and the answer is that the situation does not arise.

   ▸ The goal check's marker is compared as a fixed string this package wrote,
     on both sides, and its VALUE is deliberately never read. (§4.3)

   ▸ pi's `resolvePath` normalises and absolutises but does NOT canonicalise
     (`dist/utils/paths.js:82`), and pi builds `ctx.cwd` from `process.cwd()`
     (`dist/cli/startup-ui.js:47`), which is physical on Linux. So every path
     comparison in this stack that starts from `ctx.cwd` is comparing a physical
     path TODAY, on THIS platform, by luck of the host rather than by anything
     the code does. Read out of the install, not remembered — it is what makes
     AO8 latent rather than live, and it is one option away from not holding.
```

### 13.3 Still unwatched

1. **§AI of the hand-testing script — the operator-facing halves of this pass.**
   **Written 2026-08-23**, and it did not exist when this list was first drafted:
   this section and `HANDOFF.md` — two documents, three places — referenced "§AI
   of the hand-testing script" as a place to go, and the script stopped at §AH. Nine items now, four of them terminal-only. Three are still unseen and
   need a phone, a second Matrix sender, or two homeservers with disagreeing
   clocks.
   - `/prinny set permissionTools Bash`, then make the model run a `bash` call
     with `permissionMode off`, and watch the phone. **Unseen** — but the
     de-duplication and the *"matched ignoring case"* sentence are visible in a
     TUI with no phone at all (§AI.2).
   - Two allowlisted senders DM `hi` within one turn; both must be answered.
     **Unseen** (§AI.3).
   - Two messages stamped in the same millisecond by two homeservers.
     **Unseen live**; probe `ab4` is the honest substitute (§AI.4).
   - ~~`AgentStatus`, then `StopAgent` with the eight characters it printed.~~
     **Done**, 2026-08-23, with a live control run (§AI.1, §12.6) — and it is what
     found AO9 (§11.10). One `StopAgent` call, resolved; the pre-AO1 form refused
     the id it was listing in the same sentence, and the model retried it once
     before falling back.
   - ~~A worktree of your own repository, through a symlink.~~ **Re-measured**
     from a terminal on a real git fixture (§AI.8).
   - `PI_CODING_AGENT_DIR` relocated, and a subagent asked which skills it can
     see. **Unseen** (§AI.7) — needs a model, and is the cheapest of the three
     that remain.
   - `/prinny pair constructor`. **Half-run**: the effect is measurable from a
     terminal (`access.json` unchanged, and it was), the *sentence* is a notice
     and pi's notice sink is `() => {}` headless, so it needs a TUI (§AI.6).
     Worth recording as a general fact: **a `pi -p` run prints no slash-command
     result and writes no session file**, so no slash command's operator-facing
     text can be hand-tested headlessly.
   - ~~Hand-edit `server/src/queue.ts` and read the refusal.~~ **Done**, and it
     is the first time AO5's guard has been seen firing against a real hand-edit
     rather than a fixture. `MAX_REMEMBERED_IDS` 200 → 300 moved the fingerprint
     `d4ba6997…` → `51bf8894…` against an unchanged stamp; `npm test` exited 1
     with **76 of 508 failing** — only the suites that call `loadServerModule`,
     which is the honest blast radius — each naming `--prepare`. Putting the same
     bytes back restored `current` **without a re-stage**, and the suite returned
     to 550/550. That last part is the practical fact: the stamp is a content
     hash, so an experiment in the sidecar costs nothing as long as it ends where
     it started.
2. **`renderSubagentEntry` has still never been drawn in a live TUI.** Unchanged
   for four passes and still the cheapest unrun thing on the list.
3. **AM2 has never met a real threshold compaction with a real Matrix message
   arriving during it.**
4. **The rescue turn has still never met a real llama-server with an unloaded
   rescue model** (AL2's rung 3).

---

## 14. The pattern across twenty-four passes

Eighteen axes, and the shape of what each found:

```
   S  T  U  V  W  X  Y  Z    the artefact and what it says
   AA AB AC AD AE AF AG AH   the actor and what it can see
   AI AJ AK AL               the promise, the caller, the proxy, the lifetime
   AM                        the moment
   AN                        the gap
   AO                        the SAMENESS                        ← this pass
```

What is different about this one, and worth carrying forward.

**The seventeen axes before it are about a value's journey.** What we return,
what we pass, who receives it, who obeys it, when it stops being true, what
happens while we wait, what survives the gap. Every one of them follows a value
from one place to another and asks what it loses.

This one is about the moment of arrival: two values are in the same function at
the same time, and something has to say whether they are the same thing. There is
no journey left to inspect. **The whole defect is in one operator**, and in six
of the eight findings the operator is correct for every input anybody had tried.

Which is why the ledger's most useful column is not the function but the
**supplier** (§10.2.1). A comparison cannot be audited by looking at it. It has to
be audited by asking who chose each side, and there are only six answers in this
stack: us, pi, a person, a model, another machine, another build of ourselves.
Thirty-three of the fifty-three rows have their far side chosen by one of the
last four, and six of the eight findings are among those thirty-three. The other
two are the instructive ones. **AO3**: both sides ours, and the CONTENT chosen by
a stranger. **AO8**: both sides produced by the same program, which answers the
same question in two different SHAPES. Together they turn the rule from "audit
your boundaries" into "name the two values, then ask who could have chosen them —
and in how many spellings they could have said it".

The three sentences worth keeping, in the tense that would have helped:

> **The moment you shorten, fold or prettify an identifier for display, you have
> created a second spelling, and something will hand it back to you.** Fix that
> at the LOOKUP: one function, one ladder, and every printer left alone. Changing
> eleven printers would have cost tokens on every listing forever, and the
> twelfth would still have got it wrong.

> **A lookup over parsed JSON asks about eight keys nobody stored.** There is no
> state file in this stack over which `in` is the right operator, and the correct
> form was already written nine files away, for exactly this reason.

> **A proxy is an identity only if it is a function of the thing.** A timestamp
> is not a function of a message; a `dist/` directory is not a function of the
> source it was compiled from. Where a proxy is all you have — a pid, a
> fingerprint — attach the confirming question, the way the sidecar does before
> it kills a process.

And the one that is really about this series rather than this axis: **a test that
runs the wrong program is worse than a missing test.** AO5 is that sentence
measured — 511 green tests about a build nobody could produce from this
checkout — and §11.8 is its smaller sibling, two tests that passed for exactly
the reason the code was wrong.

---

## 15. Where to look

```
   THE MACHINE                §1, seven panels. §1.2, §1.6 and §1.7 are the new
                              ones. §1.6 is the one to read first.
   THE IDENTITY LEDGER        §10.2, fifty-three rows. The artefact.
   WHO SUPPLIED THE VALUE     §10.2.1 — the statistic this axis produces
   THE THREE LADDERS          §10.3
   THE FOLDS                  §10.4
   THE PROTOTYPE LOOKUPS      §10.5 — the list §10.1's second clause is
                              enforced against
   THE FINDINGS               §11.1 AO1 · §11.2 AO2 · §11.3 AO3 · §11.4 AO4 ·
                              §11.5 AO5 · §11.6 AO6 · §11.7 AO7 ·
                              §11.8 the two tests that pinned the wrong thing ·
                              §11.9 AO8, the latent this document recorded and
                              then closed ·
                              §11.10 AO9, the control run this document reported
                              that was never a control over the wiring — and the
                              probe technique that was available all along
   THE EVIDENCE               §12, and §12.5 for the probe count reconciled
   WHAT IS OPEN               §13.1, and §13.2 for what was checked and holds
   BY HAND                    §AI of `context/testing/subagents-loop-verifier.md`
                              — nine items, four terminal-only, and §AI.1 is the
                              live run that found §11.10

   CODE
     vendor/pi-subagents-lite/src/agents/agent-id.ts              AO1  NEW
     vendor/pi-subagents-lite/src/agents/agent-manager.ts         AO1  resolveId
     vendor/pi-subagents-lite/src/agents/tool-execution.ts        AO1  StopAgent
     vendor/pi-subagents-lite/src/agent-dir.ts                    AO7
     vendor/pi-subagents-lite/src/prompt/skill-loader.ts          AO7
     vendor/prinny-channel/src/permission-gate.ts                 AO2  namesTool
     vendor/prinny-channel/src/config.ts                          AO2  AO7
     vendor/prinny-channel/src/inbound.ts                         AO3  uniqueInjection
     vendor/prinny-channel/extensions/index.ts                    AO3  markLive
     vendor/prinny-channel/src/access-store.ts                    AO6  hasEntry
     vendor/prinny-channel/server/src/queue.ts                    AO4  Watermark
     vendor/prinny-channel/server/src/server.ts                   AO4  catchUpFloor
     vendor/prinny-channel/server/src/access.ts                   AO6
     vendor/prinny-channel/server/src/state.ts                    AO7  expandTilde
     vendor/prinny-channel/server/bin/agent-dir.mjs               AO7  NEW
     vendor/prinny-channel/tests/harness.ts                       AO5  the guard
     vendor/pi-subagents-lite/src/spawn/same-repo.ts              AO8  NEW
     vendor/pi-subagents-lite/src/spawn/worktree-validator.ts     AO8

   TESTS
     vendor/pi-subagents-lite/tests/agent-id.test.ts              AO1  NEW
     vendor/pi-subagents-lite/tests/agent-dir.test.ts             AO7  + the scan
     vendor/prinny-channel/tests/permission-gate.test.ts          AO2
     vendor/prinny-channel/tests/inbound.test.ts                  AO3
     vendor/prinny-channel/tests/queue.test.ts                    AO4  + §11.8
     vendor/prinny-channel/tests/runtime-stamp.test.ts            AO5
     vendor/prinny-channel/tests/access-store.test.ts             AO6
     vendor/prinny-channel/tests/access.test.ts                   AO6
     vendor/prinny-channel/tests/config.test.ts                   AO7  + the scan
     vendor/pi-subagents-lite/tests/same-repo.test.ts             AO8  NEW
     vendor/pi-subagents-lite/tests/agent-id.test.ts              AO9  the wiring
                                                                       block

   PROBES
     context/testing/probes/ab1-the-id-the-model-was-shown.mjs
     context/testing/probes/ab2-the-tool-the-gate-never-recognised.mjs
     context/testing/probes/ab3-two-rooms-one-sentence.mjs
     context/testing/probes/ab4-the-instant-that-stood-for-the-message.mjs
     context/testing/probes/ab5-the-program-the-suite-was-testing.mjs
     context/testing/probes/ab6-the-key-nobody-stored.mjs
     context/testing/probes/ab7-the-directory-two-packages-disagreed-about.mjs
     context/testing/probes/ab8-the-worktree-that-was-its-own-repo.mjs
     context/testing/probes/ab9-the-wiring-no-probe-drove.mjs      AO9, through
                                                                   pi's own jiti
```
