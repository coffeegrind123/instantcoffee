# Handoff — 2026-08-19 (seventeenth pass: the second instance)

The brief was to evaluate subagents, the loop and the verifier comprehensively
and write it up in detail, with a map — and then to fix what turned up. All of it
is done. The write-up is
`context/design/subagents-loop-verifier-instances.md`, self-contained in the same
way the sixteenth pass's was: §1 is the whole machine in one drawing, §2 is pi
itself, §3 is the event bus, §4–§9 are the five packages, assuming none of the
sixteen documents before it.

- **Six findings, AH1–AH6, all fixed**, each with a regression test that fails
  when the fix is removed and a probe that prints BEFORE and NOW so it is its own
  control. §11 has the change and the control-run failing count for each.
- **The gates were re-run BEFORE anything was written**, so the *before* column
  is a measurement of the tree as this pass found it: 1,018 tests, 72 probes,
  lint 91/91, nothing changed to obtain them.
- **The axis:** *a rule that is right is applied where it was found — name every
  other place it belongs, from the code that COULD need it rather than from the
  code that already asks.*
- **§10.5 of the write-up is the artefact:** the second-instance graph. Six
  rules, where each was written, and every place in the process it belongs, laid
  out by DISTANCE. Ten `✘` instances: three in the same function or sentence,
  three in the same package, four in a different package of the same process.
  **Not one of them required opening a file the author had not already opened.**

```
                                    before    after
   vendor/pi-loop-mode      tests    223       227
   vendor/pi-subagents-lite tests    346       365    lint 95/95 files
   vendor/prinny-channel    tests    382       382    lint clean
   .pi/extensions/compaction-guard    47        47
   vendor/rtk-pi            tests     20        20
                                    ─────     ─────
                                    1,018     1,041
   probes                              72        77
```

## The three that matter most

**AH1 — the fifth reader the sixteenth pass looked for in the future.** Its own
handoff said:

> `compactionInFlight()` now has four readers, and there is no test that a fifth
> would be noticed … it will produce another one **the next time a sender is
> added**.

No sender was added. `SpawnCoordinator.emitIndividualNudge` — the only route a
BACKGROUND subagent's answer has to the parent model — was already the third
sender through `sendCustomMessage`'s `triggerTurn` branch, and the only one of
the three with nothing to fall back on:

```
   sendLoopTurn        AG2   RESCHEDULES. The same iteration goes 5 s later.
   forwardResult       AG3   HOLDS, charges no retry, tells the sender to ask
                             again — there is a person who can.
   emitIndividualNudge AH1   runs ONCE per record, from a 200 ms batch TIMER
                             (so it is not ordered against anything on the bus),
                             on a record whose slot is already released and whose
                             completion gate is already open. `record.result` is
                             the only copy of the answer, and there is nobody to
                             ask. It DEFERS.
```

`vendor/pi-subagents-lite/src/spawn/compaction-lock.ts` is the third
implementation of the protocol, **read-only** — nothing in that package calls
`ctx.compact()`, and shipping begin/end would invite a caller to take a lock it
has no compaction to release. The three are asserted to agree by a test in each
package that imports the others' source.

**AH2 — §11.11 closed, after three passes on the open list.**
`parseJudgeVerdict("VERDICT: UNADDRESSED")` returned `{addressed: true,
unparsed: false}`. The second field is the finding: a verdict nobody can read
fails open *and says so* (`verificationNote("unparsed")`); this one was read,
confidently, as its own opposite, so `record.verification` became `passed` and
the answer reached the parent model **with no annotation of any kind**.

The reasoning that left it open three times (§11.5 of `…-controls.md`) had three
clauses. One true and irrelevant. One **true and load-bearing** — a `\b` really
would break `VERDICT: _ADDRESSED_`, because `_` is a word character, and probe
`u1` runs that control. And one that named the fail-open policy, which does not
reach a verdict that WAS parsed. What was missing was not rigour: it was the
question *is the fix I just rejected the only fix?* Widening the negative
alternation to `(?:NOT[_\s-]?|UN)ADDRESSED` costs nothing on the positive side.

**AH6 — AG2's own fix reopening the sixth pass's.** `deliverLoopTurn` and
`interveneStuck` send with `queueOnly` in exactly one situation: a message is
pending, i.e. **a turn is already coming**. AG2 taught that path to defer through
the loop's ONE `pendingTimer` slot — and `agent_end` clears that slot at its
first line, and "a turn is already coming" is precisely what guarantees a second
`agent_end` within milliseconds. So the deferral did not delay the directive; it
deleted it, after `blockedSignalCount` had been charged and the operator had been
told the model was "continuing with assumptions". Measured: the model received
`continue`. The fix remembers the KIND (`deferredDirective`, cleared by
`resetContextRecovery`) rather than re-timing the turn, so exactly one turn is
still sent and a fresher directive supersedes a remembered one.

## The other three

| # | What | Fix |
| --- | --- | --- |
| AH3 | `killed` before `code`. `pi.exec` resolves a child it killed on the timeout with `code: code ?? 0`, so a wedged command reads as a success returning nothing. `git-failure.ts` states the rule with a measured table and says it is "AA2 one package over" — and three more `pi.exec` sites in that package tested `code` first, one under a docstring naming the validator's strategy. Plus `stack.ts`'s `docker ps`, where a wedged daemon reported **every container "not running"** | all five classify now, and the durable half is `tests/exec-verdicts.test.ts` — a **standing scan** that greps every `.exec(` in `src/` (comments stripped) and fails on the next one, not the last one |
| AH4 | `result-cap.ts` imports `compaction-guard`'s output-cap CONSTANTS on purpose — "a second copy would drift away from the test that justifies them" — and had copied its spill WRITER without the `MAX_SPILL_FILES` prune. Of two spill directories in one process, the one whose docstring names the unattended `/loop` was bounded and the one an unattended run's background delegations fill was not | one module: `.pi/extensions/compaction-guard/src/spill.ts`. Both caps import it; each keeps its own directory so the counts stay independent |
| AH5 | `verificationNote("failed", 0)` said "no attempt was made to correct it" and "kept because the corrections were no better" in one sentence. W5 made `describeAttempts` count-aware; the clause after it was not, and `SUBAGENT_VERIFY_ROUNDS=0` is a value `clampRounds` accepts | the trailing clause is conditional |

## Three things worth reading before the next change

- **W1–W6 is not a stage this series passed through; it is the steady state.**
  The seventh pass named it — *the rule was established and applied to the
  instance in front of it* — and it has recurred in every pass since, because a
  fix is written while looking at a failure and a failure is one shape. What is
  different here is the remedy. AF5's answer was a better fix; AG1's was a better
  fix. **A better fix covers the instance in front of you. Only a LIST covers the
  ones behind you.**
- **Two of the six fixes are standing scans, and a scan that matches nothing
  passes.** `tests/exec-verdicts.test.ts` (new) and
  `tests/subagent-denylist.test.ts` (fifth pass) assert that a RULE is applied
  everywhere its shape appears. Both carry a control assertion that the scan
  matched anything at all, because that is the one way this kind of test rots
  silently.
- **A decision to leave something open is a claim, and it ages.** When you write
  down why you are leaving something, **write down which fix you considered.**
  AH2's rationale was better than most and still cost three passes, because
  nobody could check whether the rejected fix was the only one.

And one about the evidence, which is X1 pointed at the scaffolding: **a fake
whose handles cannot be cancelled cannot fail where the module does.** AH6's
first regression test passed with the fix removed, because the loop's test host
replaced `setTimeout` and not `clearTimeout` — and AH6 is entirely about a timer
being cleared. When you write a fake, list what the code under test DOES to the
thing you are faking, not only what it asks of it.

## The homework this pass leaves

The checklist is now eleven surfaces:

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
   8. WHAT WE BELIEVE ABOUT OURSELVES —      AE1–AE7
      name the flag, name the fact, and name
      what can make the fact false
   9. WHAT WE DECIDED NOT TO DO — name the   AF1–AF6
      guard, name what it was holding, say
      who owns that thing afterwards
  10. WHAT WE NAMED — the flag, the tool,    AG1–AG6
      the entry point, the surface, the
      sibling rule a sentence points at.
      Then go and open it.
  11. WHERE ELSE IT BELONGS — the rule is    AH1–AH6  ← this pass
      right and is written down. Enumerate
      every instance of its SHAPE, from the
      code that could need it. Then write
      the scan, not the third fix.
```

Surface 11 is not cheap to run — it is the first one that cannot be answered by
reading, only by searching — and the tree still has candidates. The obvious
next ones, none of them started:

```
   · every `catch {}` that swallows: which of them has a sibling that reports?
   · every timer: which unref, and which of the ones that do not are cleared on
     every path out?  (two were checked this pass; §13.2 has the results and
     both were negative)
   · every place a bound is enforced: is there a second producer feeding the
     same consumer?  AH4 is one instance of that shape and the spill directories
     were the pair; `verify-log.ts`'s own 2,000-line bound is a third producer
     with no pair, so far.
   · every `?? default`: does a sibling reader use a different default for the
     same field?
```

The residue this pass leaves is the same shape as the one it answered, so it is
worth stating in the tense that would have helped:
**`__PI_COMPACTION_IN_FLIGHT__` now has five readers in three packages, and the
protocol has three implementations. The next package to send into pi will not
know the protocol exists.** There is no scan for that one — a grep for
`sendMessage`/`sendUserMessage` across `vendor/` and `.pi/extensions/` is the
whole of it, and it takes about ten seconds. §10.5's R1 row is the list as it
stands.

## Next session

1. **Everything under "still unwatched" is unchanged, and is now the whole of
   what is left.** §13.3 of the write-up is the list in cheapest-first order.
   Two entries changed rank this pass:
   - **item 9, reading one line of `~/.pi/agent/subagent-verify.jsonl`, is now
     the highest-value one on the list by some distance.** AH2 is exactly the
     kind of thing that file exists to make visible — a reply and the parse the
     stack acted on, side by side — and three passes of *reading* could not
     settle it. Do item 8 (a real verification with a deliberately off-task
     brief), then read the `parsed` field beside the `reply` field.
   - **item 6 gains a second question.** Start a background delegation, then type
     `/compact` while the child is still working. The result must arrive LATE
     rather than not at all, and the notice must name the holder. That is AH1
     from the terminal, and it needs no Matrix account.
2. **§AA.1 is still the cheapest run** — `/loop --delay 20`, type `/compact` in
   the gap. It is AG2 in one minute, and it is now also the cheapest way to see
   AH6: make the turn in that gap a `LOOP_BLOCKED:` or a `LOOP_DONE:` one, and
   the directive is the thing that used to be lost.
3. **§U is still the cheapest run needing no setup at all** — Esc on a loop turn,
   then type a question. One keypress.
4. **One bound, not a defect, and now wider than it was:** the compaction lock
   can only be read for compactions an *extension* asked for. pi's own threshold
   and overflow compactions mark nothing, so AG2's deferral, AG3's hold, **AH1's
   hold** and §11.12's mutual exclusion all stop at the same edge. pi emits
   `compaction_start` internally (`agent-session.js:1370`) but not as an
   `ExtensionEvent`; marking those would be an upstream change.

**The working tree still carries the fourth through seventeenth passes
uncommitted.**

---

# Handoff — 2026-08-19 (sixteenth pass: the thing that was named)

The brief was to evaluate subagents, the loop and the verifier comprehensively
and write it up in detail, with a map — and then to fix what turned up. All of it
is done. The write-up is
`context/design/subagents-loop-verifier-references.md`, **the first document in
the series written to be read on its own**: §1 is the whole machine in one
drawing, §2 is pi itself, §3 is the event bus rebuilt from the source, and §4–§9
are the five packages in full, assuming none of the fifteen documents before it.

- **Six findings, AG1–AG6, all fixed**, each with a regression test that fails
  when the fix is removed and a probe rewritten afterwards to print BEFORE and
  NOW so it is its own control. §11 has the change and the control-run failing
  count for each; §12.1.1 is the table of what each one cost.
- **The gates were re-run BEFORE anything was written**, so the *before* column
  is a measurement of the tree as this pass found it: 991 tests, 67 probes, lint
  clean, nothing changed to obtain them.
- **The axis:** *name the flag, the tool, the entry point, the surface or the
  sibling rule that a decision or a sentence points at — then go and read it.*
  Five of the six are a pointer that was never followed, and in every one **the
  thing pointed at already existed and already worked.**

```
                                    before    after
   vendor/pi-loop-mode      tests     218       223
   vendor/pi-subagents-lite tests     329       346    lint 91/91 files
   vendor/prinny-channel    tests     377       382    lint clean
   .pi/extensions/compaction-guard     47        47
   vendor/rtk-pi            tests      20        20
                                     ─────     ─────
                                      991     1,018
   probes                               67        72
```

## The three that matter most

**AG2 and AG3 — the same moment, from two extensions.** pi's refusal *"Cannot
submit a prompt while compaction is in progress"* lives on
`AgentSession.prompt()` and nowhere else. `sendCustomMessage`'s `triggerTurn`
branch calls `_runAgentPrompt` directly, and `_runAgentPrompt` checks nothing —
so:

```
   AG2  the loop's next iteration, on its delay timer, started an agent run
        INSIDE a compaction somebody else began. pi's compact() ends with
        `this.agent.state.messages = sessionContext.messages`.
   AG3  prinny's empty-turn CONTINUATION was sent from forwardResult(), on the
        agent_settled the loop has just requested an emergency compaction on —
        loop first, prinny second. The nudge was refused silently, one of the two
        retries was spent on a send that never happened, and the answer the
        continuation exists to produce never came.
```

Both are reproduced with **both shipped extensions in one process**, in
`scripts/pi-local.sh`'s order, with pi's own facts pinned out of its source
first. In both, `compactionInFlight()` — the lock the fifteenth pass built — said
who was compacting at the exact moment of the send. **Four call sites could read
that lock; two did**, and the two that did not are these.

The fixes are one lock read each, in opposite idioms because the objects differ.
`sendLoopTurn` **reschedules** — an unattended run must not lose an iteration, so
it waits `COMPACTION_WAIT_MS` and goes when the lock frees, bounded by the lock's
own five-minute staleness. `forwardResult` **holds and reports** — a continuation
deferred forever is worse than one that never happens, so it charges no retry and
hands the room to AF1's retirement notice with a third reason, `compacting`,
whose sentence is the true one *now* where the delivery sweep's could only hedge
a minute later.

**AG1 — half the judge's budget, reserved and then not spent.** `briefForCheck`,
AF5's own fix, says in its docstring that it applies `appendFollowUp`'s split.
`appendFollowUp` gives the follow-ups everything the original does not use;
`briefForCheck` gave them a flat `floor(max * 0.5)` and returned the remainder
unspent.

```
   t3, the shipped verify.ts, a one-line brief steered four times:
                                 BEFORE      NOW
     chars of a 1,500 budget     481       1,301
     follow-ups the judge sees   1 of 4      3 of 4
   the AF5 shape (a 1,400-char original) is unchanged in every column, which is
   why all seven AF5 assertions pass either way — and why the shape that broke
   had no test.
```

## The other three

| # | What | Fix |
| --- | --- | --- |
| AG4 | §1.D of **five documents** — the event-bus table every ordering argument in this series is read off — drew `pi-subagents-lite` handling `agent_start`, `message_end` and `agent_end`, which it does not; omitted `tool_call`, which it does; and had no row for `turn_start`. The same document's §1.C summary said "4 handlers" and was right | all five corrected in place, each with a note recording what it drew and for how long. `t5` re-derives the table from the source and diffs it against any document, so it cannot drift again |
| AG5 | `bulkReport`'s partial line said "N were still busy and were left alone" for both verbs. `stopAgent()` has one reachable `return false` and it means the record had already **finished** | one sentence per verb, agreeing with the single-agent ones the module already had, and a pluralised count |
| AG6 | All four notices about an undelivered background result ended "Read it with AgentStatus", and `AgentStatus` prints `id (type) status` | `/agents` → **View result** named instead, exported so the coordinator's own catch shares it; `record-gone` says the answer is gone, because there both surfaces read the same map |

## Three things worth reading before the next change

- **The thing you named is a file you can open.** `briefForCheck` names
  `appendFollowUp`, one screen away. `sendLoopTurn` and `forwardResult` are two
  of four callers of a lock their own packages wrote three days earlier. A drop
  notice names `AgentStatus`, whose entire implementation is fifty lines. The
  cost of checking was one file open in every case, and the reason none of them
  was opened is that **the sentence sounded true**.
- **A fix has a shape, and the shape has more than one instance.** AG1 is AF5 at
  the other end of the same distribution; AG5 is AF2's own module at the one call
  site whose two verbs have opposite refusal causes; AG3 is AE2's rule with the
  parties swapped. When a fix lands, write down what shape it was and find the
  other instances before writing the test.
- **A reserve is not a cap.** AG1's `floor(max * 0.5)` is a floor in intent and a
  ceiling in code. When you reserve room for something, say what happens to the
  room nobody used.

And one about the tooling, which is the same lesson pointed inward: **a scan for
wiring must not read the prose about the wiring.** `t5`'s first draft reported a
`tool_result` handler that does not exist, because `result-cap.ts`'s header
comment contains the literal string `pi.on("tool_result")`. Every module here
quotes its own wiring at length, which is a virtue everywhere except in a tool
that greps for it.

## The homework this pass leaves

The checklist is now ten surfaces:

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
   8. WHAT WE BELIEVE ABOUT OURSELVES —      AE1–AE7
      name the flag, name the fact, and name
      what can make the fact false
   9. WHAT WE DECIDED NOT TO DO — name the   AF1–AF6
      guard, name what it was holding, say
      who owns that thing afterwards
  10. WHAT WE NAMED — the flag, the tool,    AG1–AG6  ← this pass
      the entry point, the surface, the
      sibling rule a sentence points at.
      Then go and open it.
```

Surface 10 is cheap to run and the tree is dense with candidates: every
"see X", every "as Y does", every recovery instruction, every docstring that
says it applies somebody else's rule. Five of this pass's six came from reading
one of those out loud and then opening the file.

The residue it leaves is a question rather than a defect: **`compactionInFlight()`
now has four readers, and there is no test that a fifth would be noticed.** The
lock is process-global state shared by two packages, which `r3`'s discipline
already covers for the probes and `context-recovery.test.ts`'s `reset()` covers
one scope out — but "who else should be asking this" is exactly the question that
produced AG2 and AG3, and it will produce another one the next time a sender is
added.

## Next session

1. **Everything under "still unwatched" is unchanged, and is now the whole of
   what is left.** §13.3 of the write-up is the list in cheapest-first order. It
   has ten entries; the tenth is **§AA of the hand-testing script**, new in this
   pass. `§AA.1` needs no Matrix account and no saturated context — start a
   `/loop --delay 20`, type `/compact` in the gap, and watch the next iteration
   WAIT rather than start. That is AG2 from the terminal in one minute, and the
   notice now names who is compacting. `§AA.2` is AG3 and needs both.
2. **§U is still the cheapest run on the list** — Esc on a loop turn, then type a
   question. One keypress, no subagent, no verifier, no Matrix account.
3. **Item 8 remains the highest-value one.**
   `~/.pi/agent/subagent-verify.jsonl` has existed since the fifteenth pass and
   nothing real has ever written to it. Run a real verification — now with a
   STEER in it, which is AF5 *and* AG1 — then read one line. If
   `parseJudgeVerdict` is wrong about anything, that file is where it becomes
   visible for the first time.
4. **One bound, not a defect, worth carrying:** the compaction lock can only be
   read for compactions an *extension* asked for. pi's own threshold and overflow
   compactions mark nothing, so AG2's deferral, AG3's hold and §11.12's mutual
   exclusion all stop at the same edge. Marking those would need a hook pi does
   not have.

**The working tree still carries the fourth through sixteenth passes
uncommitted.**

---

# Handoff — 2026-08-19 (fifteenth pass: the thing that was not done)

The brief was to evaluate subagents, the loop and the verifier comprehensively,
write it up with a map, and fix what turned up. All three are done. The write-up
is `context/design/subagents-loop-verifier-omissions.md`.

- **The write-up:** the machine drawn whole again with every REFUSAL marked (§1),
  full accounts of all five extensions (§3–§8), **the refusal ledger** (§2 —
  every place this stack decides not to act, what it was holding when it
  decided, and who owns that thing afterwards) and **the refusals graph** (§2.1,
  which draws the distance between a refusal and the object it dropped), six
  findings (AF1–AF6), and for each the fix and the control-run failing count.
- **The fixes:** all six, each with a regression test that fails when it is
  removed. §12 has the tables. **Three open items were closed after them** —
  §11.12 (the fourteenth pass's homework), the judge's raw reply (#1 by age,
  twelve passes) and §11.1 (the one refusal this pass found and recorded);
  §10.6–§10.8 are the accounts.
- **The probes:** `context/testing/probes/s1`–`s5`. `s1` drives the whole
  `prinny-channel` extension over the real sidecar protocol with two rooms; `s2`
  drives the real `AgentManager` and the real `AgentStatus` tool; `s3` pins pi's
  bash source and drives the shipped output cap; `s4` drives the shipped loop; and
  **`s5` drives BOTH extensions against each other in one process**, which is the
  first probe in the series to do that and the only way the §11.12 collision can
  be seen at all.
- **The hand-tests:** **§X** (two rooms, one turn — the AF1 run, and the cheapest
  Matrix run on the list), **§Y** (a `/loop` against a failing suite — the AF6
  run) and **§Z** (type something while the goal check is running — the AF3 run)
  are new in `context/testing/subagents-loop-verifier.md`.

```
                                    before    after
vendor/pi-loop-mode        tests    199       218
vendor/pi-subagents-lite   tests    289       329     lint 91/91 files
vendor/prinny-channel      tests    357       377     lint clean
.pi/extensions/compaction-guard      41        47
vendor/rtk-pi              tests     20        20
                                   ─────     ─────
                                    906       991
probes                                62        67
```

All sixty-seven probes run clean (`g1`–`g3`, `verify-prior-fixes`, `h1`–`h6`,
`i1`–`i9`, `j1`–`j8`, `k1`–`k6`, `l1`–`l6`, `m1`–`m4`, `n1`–`n4`, `o1`–`o4`,
`p1`–`p4`, `q1`–`q4`, `r1`–`r3`, `s1`–`s5`).

**The working tree still carries the fourth through fifteenth passes
uncommitted.**

---

## The one-line version

The fourteenth pass asked about the machine's account of **itself** — *name the
flag, name the fact it stands for, and name what can make the fact false.* This
one asks about the places it decides **not to act**: *name the guard that
declines, name what it was holding, and say who owns that thing afterwards.*

Forty-five refusals. Every one of them is correct — this pass reverses none of
them. Six were holding something a person or a model was waiting for, and had
nowhere to put it down.

## The three that matter most

**AF1 — the answer two rooms were both owed.** `forwardToMatrix` refuses to send
when more than one room is live, because with two there is no way to tell whose
answer this is. Eight lines later, in the same handler:

```
   if (!retrying) {
     for (const [room, entry] of awaitingReply) {
       if (entry.live) awaitingReply.delete(room);
     }
   }
```

Both rooms are retired — and the entries that proved either question had ever
been asked go with them, which is also why `sweepUndelivered` could not report
it. **Two people, two questions, zero answers, zero notices, one line in a log
file.** It is the ordinary case for a channel with two people on it: pi's agent
loop drains its follow-up queue inside the same run, so two messages that arrive
while it is busy are consumed by one run and both rooms go live.

The fourteenth pass looked straight at this. `r3`'s header explains that a
leftover live room from an earlier scenario suppresses the leak the next one is
about — true, same mechanism, read as a fact about the probe.

```
   s1 [two-rooms], the real extension over the real sidecar protocol:
                                     BEFORE            NOW
     the answer                    : (not sent)      (not sent)   ← unchanged
     what room A receives          : (nothing)       "Someone else was being
     what room B receives          : (nothing)        answered in the same turn…"
     what the operator sees        : a log line      a notice
     what the sweep can report     : nothing — the entries are gone
```

**AF6 — the cap that exempted what it was built for.** `compaction-guard`'s
output cap began `if (event.isError) return undefined;` — *"an error is short and
is the one thing worth reading in full"*. That is a claim about pi's bash tool,
and pi's bash tool says otherwise: a non-zero exit **throws the whole formatted
output** (its own bound is 2,000 lines or 50 KB) and `createErrorToolResult`
makes that the result's only text block. So the exemption covered up to ~12,500
tokens of a 32,768-token window — on the most common path an unattended `/loop`
has, because every run of a still-failing test suite is an error result.

```
   s3, the shipped handler, a 17,738-char failing suite at 84.5% context
   (within fifty characters of the 17,790-char curl result the extension
    was BUILT for):
     BEFORE  isError: true  → 17,738 chars, untouched
     NOW     isError: true  →  1,970 chars, head + tail, spilled to a file
             isError: false →  1,970 chars   (unchanged, and the control)
```

**AF3 — five directives the ladder was charged for.** Six exits of `agent_end`
ended in `if (!ctx.hasPendingMessages()) scheduleLoopTurn(…)`, and five of them
carry a DIRECTIVE that is the loop's whole answer to what it has just decided —
`improve`, `unblock`, `check_failed`, `regression`, `audit` — all charged for
above the guard. V4 found exactly this on the seventh exit and fixed it there,
with the sentence that names the rule: *"the guard is right for every OTHER exit,
where the loop only needs A turn"*. It is right for `continue` and wrong for the
other five. `audit` is the worst: it resets the window that lets it fire again,
so dropping the text costs eight more iterations of silence.

The window is not narrow — `agent_end` **awaits the goal check**, up to
`checkTimeoutSeconds` (120 s), with the operator free to type into it.

## The other three

| # | Was | Now |
| --- | --- | --- |
| AF2 | `abort()`, `clear()` and `steer()` each answer with a boolean, and each `false` is a refusal somebody installed on purpose — Y1's, T5's, a full concurrency slot. Five of the six call sites discarded it: "Cleared 1a2b3c4d" about a record that is still there, three bulk counts taken from a snapshot made before the menu opened, and the conversation viewer's steer, which said nothing at all — while `continueSettledAgent` refuses rather than queues, so at this fork's `default: 1` every continuation attempted during another agent's run is refused | one module that imports nothing (`src/ui/action-report.ts`) turns each boolean into a sentence; every call site reads it; the bulk actions re-derive their targets when the action is chosen and count the manager's `true`s |
| AF4 | `AgentStatus` keeps the most recent settled agents with `settled.slice(-limit)`, under a comment saying the caller hands them over in spawn order. `listAgents()` sorts them NEWEST FIRST — so the tool listed the six OLDEST agents of the session and reported the batch the model had just launched as "(+N older, see /agents)", in a reply whose own closing line is "Don't poll". The unit test could not see it: it built its array oldest-first, the one order the caller never uses | the bound reads the field the rule is about — `completedAt ?? startedAt` — instead of trusting an order, and `ListableAgent` carries it |
| AF5 | `brief` grows at the TAIL (`appendFollowUp` puts every steer there, up to 6,000 chars) and its two model-facing readers cut it at the HEAD (`truncate(brief, 1_500)`). So on an original brief of 1,500 characters or more, every follow-up was the first thing dropped — the judge said NOT_ADDRESSED, correctly, about the question it was given, and the round trip that follows ends at `stalled` with the parent holding the answer it already had. W3 made `growBrief` run on every branch of `steer()` so the judge would check the accumulated task; the accumulation reached the field and the field's readers cut it off | `briefForCheck()` applies `appendFollowUp`'s own rule from the other side: newest follow-ups first, the newest never dropped, the original keeps the rest |

## And three open items closed after them

Not findings — three things that were on the open list, two of them for more than
one pass. §10.6–§10.8 of the write-up are the accounts.

**§11.12 — two extensions can compact the same session. This was the fourteenth
pass's homework.** `pi-loop-mode`'s `agent_settled` handler runs first and may ask
for an emergency compaction; `prinny-channel`'s runs second and may drain a
deferred `/compact`; pi's `compact()` does not refuse the second call — it aborts,
overwrites `_compactionAbortController` and proceeds. Both passes stopped at the
same place: *the fix is a flag neither package owns.* It is, and `shell.ts` had
already established how this stack does that — `__PI_SUBAGENT_SPAWN_DEPTH__` is on
`globalThis` for exactly this reason. So: one key, two implementations (one per
package, asserted to agree by a test in each that imports the other), and neither
caller queues — the loop **adopts** another extension's compaction or **waits**
for it, and prinny tells the sender *"A compaction is already running — I will let
that one finish rather than cutting it off."* The holder expires after five
minutes, because a latched lock is worse than the collision it prevents.

```
   s5, both real extensions in one process, fired in pi-local.sh's order:
     BEFORE   2 ctx.compact() calls on one agent_settled, the second aborting
              the first
     NOW      1, and the sender is told theirs is the one that is running
```

**The judge's raw reply, kept. This was #1 by age — twelve passes.** Never a
defect, and the reason four findings needed a probe before anyone could believe
them: S2, U4, V5 and W5 are each a claim about a string that lived for a few
milliseconds inside `verifyAnswer` and was then dropped. One JSONL line per
verifier model call now carries the prompt, the raw reply, **and the parse the
stack acted on** — neither the reply nor the verdict alone can show the parse was
wrong. `~/.pi/agent/subagent-verify.jsonl`, 4,000 chars a field, 2,000 lines
newest-kept, `SUBAGENT_VERIFY_LOG=0` to disable, injected as `deps.log` so a
logger that throws costs a log line rather than a verdict.

**§11.1 — the three silent drops of a background result, now spoken.** All three
of `emitIndividualNudge`'s guards are correct and all three dropped a finished
delegation's answer without telling anybody, which is what AC1 established this
class of failure must never be. They now report on a channel that exists headless,
naming the agent, the cause, and the one recovery that always works. The delivery
QUEUE that would let the send actually happen across a session swap is still a
design decision — but the drop is no longer invisible.

## Three things worth reading before the next change

- **A refusal is half a decision.** The other half is the object. Every finding
  here is a branch that answers "should I do this?" correctly and never answers
  "then what happens to it?" — and in three of the six the code that deletes the
  object is in the same function as the refusal. The habit is one question at
  every `return` inside a guard: **what was I holding when I decided not to, and
  who has it now?**
- **A bound is a refusal with a rule in it, and the rule has to be checked
  against what the caller actually hands over.** AF4 and AF5 are the same defect
  in two packages — `slice(-N)` over a newest-first array, and a head cut over a
  tail-grown string. Both had a comment stating the premise, and in both cases
  the premise was the thing to check. **Write down which end your bound keeps,
  then go and look at what the caller's end actually is.**
- **"Something else will handle this" is a claim about another piece of code.**
  AF3's guard says a turn is already coming, which is true; what is false is that
  the turn carries the loop's directive. AF1's refusal says the answer cannot be
  attributed, which is true; what is false is that anything downstream notices
  the two rooms it left behind. It costs one read of that other code to check.

One smaller one, about probes. **A stub that repeats itself is an input the
module has an opinion about**: `s4`'s audit block reported `stuck/steer` instead
of `audit/steer` because the harness returned the same tool result every turn,
and `detectStuck`'s rule 7 is "the same TURN tool signature three turns running".
The probe had driven the loop into a different, correct verdict. Vary what a stub
returns unless the repetition is the point.

## Next session

Everything above is fixed against probes and tests, and none of it against a
running model. That is the whole of what is left, and it has been true for twelve
passes.

1. **§X — two rooms, one turn.** New, and the cheapest Matrix run on the list:
   message the bot from two rooms a few seconds apart while it is busy. No loop,
   no subagent, no verifier. Both rooms must hear something.
2. **§U — Esc on a loop turn, then type a question.** Still one keypress and one
   sentence, and still not run. It is AE1 end to end.
3. **§Y — a `/loop` against a genuinely failing suite**, with the model running
   the suite itself. `Compaction guard: capped bash output N -> M` should appear
   once per iteration; before this pass it never did.
4. **§Z — type something while the goal check is running.** That is AF3's window,
   and `--check "sleep 20; false"` makes it twenty seconds wide.
5. **§B and §P** — one background delegation, and the only question is whether
   the result appears in the conversation at all. Do it headless too (`pi -p`).
6. **§M, §M.2, §M.3** — three `/loop start`s with different `--check`s and
   `/loop status` after each. Six findings across five passes sit on that path.
7. **§R and a real verification**, foreground, `SUBAGENT_VERIFY_ROUNDS=1`,
   deliberately off-task brief — and now with a STEER in it, which is AF5.
8. **Read a line of the verification log written by a real judge.** The log
   exists now (§10.7) and nothing has ever been written into it by a 27B judging
   a real answer, which is the whole point of having it. Do item 7, then read
   `~/.pi/agent/subagent-verify.jsonl`. If `parseJudgeVerdict` is wrong about
   anything, that file is where it will be visible for the first time.
9. **Still open by decision, each with a reason in §11 of the write-up:** the
   delivery queue behind §11.1, the channel-down apology that cannot arrive, a
   room-less inbound message, the wizard's slot-less spawn, `continue` still
   dropping, and the eight carried from earlier passes. **§11.12 — the fourteenth
   pass's homework — is closed** (§10.6); what is left open there is pi's own
   threshold and overflow compactions, which no extension requests and therefore
   none can mark.

## The homework this pass leaves

The checklist is now nine surfaces:

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
      obeys ever see the instruction, and
      what else does obeying it do?
   8. WHAT WE BELIEVE ABOUT OURSELVES —      AE1–AE7
      name the flag, name the fact, and
      name what can make the fact false
      without the flag hearing about it
   9. WHAT WE DECIDED NOT TO DO —            AF1–AF6  ← this pass
      name the guard that declines, name
      what it was holding, and say who
      owns that thing afterwards
```

What this pass leaves behind is smaller than usual, because the three items above
were closed after the findings. The residue is **the delivery queue behind
§11.1**: reporting a dropped background result is not the same as delivering it,
and a result produced for a session that has gone away still has nowhere to go. The
honest fix is a queue that survives a session swap, which is a capability change
rather than a repair — and the drop is now loud, so the next person to want it will
have seen it happen.

The other residue is not a defect but a habit worth keeping: **the compaction lock
is process-global state shared by two packages**, which is a new kind of thing in
this stack. `r3` established that a probe sharing module-global state between
scenarios has an unstated precondition; the loop's own `tests/context-recovery.test.ts`
now has to clear the lock in `reset()` for the same reason, one scope out. Anything
that adds a second global of this kind inherits that discipline.

One more, carried forward unchanged because it is still right: **when re-running
the gates, check the test COUNT and not only the failure count.** A whole test
FILE can bail under memory pressure, which `node --test` reports as one failure
and a silently lower total.

## Where to look

- `context/design/subagents-loop-verifier-omissions.md` — this pass. §1 the
  machine with every refusal marked, **§2 the refusal ledger** and **§2.1 the
  refusals graph**, §3 the loop (§3.2 is the ladder with the six guards on it),
  §4 subagents (§4.2 is the three surfaces an operator acts through, §4.5 is AF4
  drawn out), §5 the verifier (§5.3 is AF5), §6 `compaction-guard` (§6.1 is
  AF6), §7 `prinny-channel` (§7.3 is `agent_settled` in order, §7.4 is the
  four-row table AF1 completes), §8 `rtk-pi` and why it has nothing to find here,
  §9 the findings, §10 what was fixed alongside, §11 what is open by decision,
  §12 what shipped, §13 running the evidence, §14 the pattern across fifteen
  audits, §15 still unwatched.
- `context/design/subagents-loop-verifier-claims.md` — the fourteenth pass
  (AE1–AE7). Its §2 is the claim ledger and its §1 is the drawing this one's §1
  extends. Read it first if you are new to the stack.
- `…-controls.md` (thirteenth, AD1–AD7) · `…-deliveries.md` (twelfth, AC1–AC5,
  the nearest neighbour to this axis) · `…-signals.md` (eleventh, AB1–AB4) ·
  `…-hosts.md` (tenth, AA1–AA4) · `…-answers.md` (ninth, Z1–Z4) · `…-turns.md`
  (eighth, X1–X5, Y1) · `…-readers.md` (seventh, W1–W6, the other neighbour) ·
  `…-shapes.md` (sixth, V1–V8, where V4 is) · `…-units.md` (fifth, U1–U9, whose
  §9 reference sections no later document restates) · `…-surfaces.md` (fourth,
  S1–S10) · `…-mechanics.md` (third, T1–T9, still the best account of pi's own
  agent loop) · `…-evaluation.md` (second) · `…-anatomy.md` (first, and the
  design rationale).
- `context/design/decisions.md` — decision history in date order.
