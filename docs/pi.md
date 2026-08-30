# Using it with pi

Starting sessions, the `/stack` `/loop` `/prinny` commands, subagents, how
the provider config is generated, and why this stack targets pi at all.

## Starting a session in a project

pi works on your **current directory**, so scope it by `cd`-ing there first and
calling the launcher by its absolute path. Everything the launcher needs
(prompt fragments, the MCP skill) is resolved absolutely, so it runs correctly
from anywhere:

```bash
cd ~/my-project
~/instantcoffee/scripts/pi-local.sh
```

pi then reads and edits files under `~/my-project`. Worth adding to your shell
so you stop typing the path:

```bash
echo "alias qpi='~/instantcoffee/scripts/pi-local.sh'" >> ~/.bashrc && . ~/.bashrc
cd ~/my-project && qpi
```

(`~/.zshrc` if you use zsh. The alias points at the script, not at `pi` itself,
so it keeps working when the launcher changes.)

Common variants — any pi flag passes straight through:

```bash
qpi                                  # interactive session
qpi -c                               # continue the previous session here
qpi -p "what does src/auth.py do?"   # one-shot, non-interactive, prints and exits
qpi --print-only                     # show the exact command, run nothing
qpi --install-only                   # just refresh ~/.pi/agent/models.json
```

## Changing settings for one session

Any `.env` key can be overridden for a single launch by setting it in front of
the command — the same way `docker compose` treats the shell environment:

```bash
PI_CONTEXT_FILES=0 qpi     # skip this project's AGENTS.md / CLAUDE.md
THINK_LANG=off qpi         # no Chinese-reasoning fragment this session
MCP2CLI_ENABLED=0 qpi      # drop the MCP skill for this session
```

Your project's `AGENTS.md`/`CLAUDE.md` **is** loaded by default — pi walks
parent directories to find it. `PI_CONTEXT_FILES=0` turns that off for a session
where the window matters more than the conventions: a long single-file refactor,
or a project whose conventions file is enormous.

For a permanent change, edit `.env`; for a permanent *machine-local* change that
should not be committed, put it in `.env.local`.

## Controlling the stack from inside pi: `/stack`

`.pi/extensions/stack.ts` ships with the repo, and `pi-local.sh` loads it by
absolute path — so `/stack` is there in **every** session the launcher starts,
including sessions in a completely unrelated directory. The launch banner ends
with `, /stack` when it is active.

> Do not rely on pi's own `.pi/extensions/` auto-discovery for this. That is
> scoped to the project pi was *started in* and needs that project trusted, so
> starting anywhere else means no `/stack` — and because an unregistered
> `/stack` is forwarded to the model as plain text, you get a confident,
> invented answer instead of an error. If you launch `pi` directly rather than
> through `pi-local.sh`, pass
> `-e ~/instantcoffee/.pi/extensions/stack.ts` yourself.

```
/stack                     model, context, slots, throughput, GPU, forge, settings
/stack mode                which preset .env matches, and what differs
/stack mode coding|prose   switch regime, then offer the restart it needs
/stack env [FILTER]        every effective setting (.env + .env.local + exported)
/stack set KEY=VALUE       edit .env, and say exactly what must restart
/stack up | down           start / stop via scripts/
/stack restart [llama|forge]
/stack smoke | bench
/stack logs [llama|forge]
/stack slots save|restore|erase [id]
```

**Observation is model-callable; mutation is not.** The `stack_status` tool lets
the model check throughput or KV usage before blaming itself for slow output.
Every command that changes something is user-only, so a model cannot restart
llama in the middle of your task.

**Nothing here reconfigures a running server, because nothing can.**
llama-server answers **501 to `POST /props`** on this build — context size,
sampling, reasoning budget and MTP are startup flags, full stop — and forge has
no admin API either. 0.9.0 added `/forge/health` and `/forge/usage` and started
forwarding `/health`, `/v1/models`, `/v1/health`, `/models` and `/props` to the
backend, but every management mutation stays closed. So `/stack set` edits
`.env` and then tells you precisely what to recreate, reading the key→service
mapping out of `docker-compose.yml` so it cannot drift. It distinguishes keys
that only `pi-local.sh` reads — those just need pi restarted — from keys that
need a container recreate and, for llama, a ~20 minute cold load.

`/stack` also detects one failure mode that ordinary health checks miss: if
`/props` answers while `/slots` and `/metrics` time out, llama's **task queue is
wedged** and inference is down even though the container looks healthy and
`/health` passes. The status output says so, and names the recovery.

> **`/stack slots` is sharp.** Measured on this box: saving one 32k slot wrote
> 315 MB in 180 s without finishing, and **aborting a save wedged the server** as
> above, costing a container recreate and a cold load. The command therefore has
> no client-side timeout — interrupting is the thing that breaks it — and it
> re-probes the queue afterwards. Read the confirmation before saying yes.

## Unattended loops: `/loop`

`vendor/pi-loop-mode` — a fork of `pi-loop-mode@2.5.4`, carried in this repo —
iterates the agent until you stop it. Nothing to install: `pi-local.sh` loads the
extension, its skill and its prompt templates from the checkout by absolute path,
so `/loop` behaves the same in whatever directory you started pi in.

If the upstream npm package is still in pi's user settings from before the fork,
remove it — two copies register two `/loop` commands that fight over one
session's state, and the launcher warns when it sees one:

```bash
pi uninstall npm:pi-loop-mode
```

Then, in the project you want worked on:

```
/loop start read @PLAN.md and implement it
/loop start <goal> --check "python3 -m pytest -q"   # objective done-ness
/loop start <goal> --max 20                          # cap the iterations
/loop stop | /loop resume | /loop finish | /loop stats
```

**Why this one.** Three properties matter on a stack like this, and they were
checked rather than taken from the README:

- **It survives compaction, which is the whole point on a local window.**
  Loop state is persisted as pi session entries and restored with
  `restoreLoopState(ctx.sessionManager.getBranch())`, so a compaction does not
  end the run. On context pressure it builds a *local* summary from loop state
  and touched files instead of making another model call — which matters here,
  because a summarization request against an already-saturated context is
  exactly what fails under `--no-context-shift`.
- **It is built for weak models.** Repetition and near-duplicate detection,
  a degenerate-output kill switch, and an escalation ladder that injects
  recovery strategies. A 27B local model does get stuck in ways a frontier
  model does not.
- **Done-ness can be objective.** `--check "CMD"` runs a shell command after
  every iteration and believes the exit code, not the model's claim.

**The no-progress nudge now fires on the runs it was written for.** After eight
iterations with no concrete change the loop stops asking for the next batch and
demands a tangible artifact instead. What counted as "a change" used to be a
word list — including `passed`, `fixed` and `successfully` — matched against the
output of *any* tool, so a `--check "cargo test"` run that prints `42 passed`
every iteration pinned the counter and the nudge could never fire; so did a
`read` of a CHANGELOG and a `grep` that matched `updated`. Now a `write` or an
`edit` counts by definition, `bash` and `Agent` are the only tools whose output
is read at all, and the verdict words are gone. See AK5 in
`context/design/subagents-loop-verifier-proxies.md`.

**One thing to know about `--check`, because it is the sharpest edge here.** The
command runs with `bash -lc` once per iteration, for the life of the run and
across `/loop resume`, through `pi.exec` — which emits no `tool_call`, so nothing
in this stack reviews it: not the Matrix permission relay, not `rtk-pi`'s gate,
not the compaction guard's output cap. Typed by you in the terminal that is
exactly right, and unchanged. Two other routes to the same field are narrower:

```
   from Matrix        --check is REFUSED outright, with its own reason, along
                      with --model and --rescue-model  (AD6)
   from the MODEL     the `loop` tool declares `check`. You are told the model
                      asked, and asked to confirm it; with nobody to ask the
                      check is not armed and the LOOP STARTS ANYWAY, without one.
                      LOOP_TOOL_CHECK=1 in .env is the standing yes.   (AJ2)
```

`--until-done` without a check still terminates on the model's `LOOP_DONE:`
marker, which is what that mode does whenever no check is configured — so
declining costs the run its objective done-ness, not the run.

Verified end to end on Qwen3.6-27B: given a `PLAN.md`, a two-iteration run
produced a working module and a passing test, and `python3 test_calc.py` exited
0 — the plan's own acceptance criterion.

**Why it is forked.** A longer unattended run died on the one thing it is
supposed to survive:

```
Error: "Backend returned 400"
[compaction] Compacted from 33,719 tokens
Error: Compaction failed: Already compacted
Loop paused — context recovery required
```

The context overflowed, **the recovery worked**, and the loop stopped anyway —
waiting for a human to type `/compact` and `/loop resume`, which is the one thing
an unattended loop cannot ask for. pi runs its own overflow recovery *after* the
`agent_end` event that upstream compacts from, so the two race; pi's lands first,
and pi refuses a second compaction of a branch that already ends in one. Upstream
treated that refusal — someone else's success — as a fatal error.

The fork defers its compaction to `agent_settled` (nothing left to race), adopts
pi's recovery when pi wins, treats `Already compacted` as "no work to do" rather
than a failure, and replaces the terminal pause with a cooldown ladder that
retries with a progressively tighter summary.

**Then it stopped overflowing and still went nowhere.** Eight real sessions under
`~/.pi/agent/sessions` show the sequel: 24 compactions, not one error, and from
the fourth compaction onward the session pinned at **94–96% of the 32k window**,
compacting nearly every iteration and freeing nothing. pi's compaction defaults
are sized for a 200k window and do three separate harmful things on 32k — they
no-op silently between 50% and 66% full, they always keep 20,000 tokens (61% of
this window), and the summary is merged into the previous one every time, so it
grows (measured: 1,666 → 11,054 chars) until it is what fills the window.

That matters because of a cliff. Above ~87% full, **33 of 63 assistant turns came
back completely empty** (`content: []`, `stopReason: "stop"`); below it, 3 of 196.
And the loop's own guards read those empty turns as fixation and answered them by
injecting more prompt text into the context that caused them.

So the fork now **hands off instead of compacting** on any window ≤ 64k: a
bounded summary that does not grow, cut at the last turn instead of at pi's
20,000-token tail, built locally with no model call. An empty turn above 80% is
classified as context pressure rather than stuck-ness, the stuck ladder skips
straight to compaction when the context is full instead of scolding the model,
and the model is shown its own remaining budget once past 60% so it can finish
and write state to `PROGRESS.md` before the handoff. `pi-local.sh` also sizes
pi's own `reserveTokens`/`keepRecentTokens` from `CTX_SIZE`, which alone drops
the post-compaction floor from 20,000 tokens to 7,000.

`vendor/pi-loop-mode/FORK.md` has the full list and the measurements;
`cd vendor/pi-loop-mode && npm test` runs the 39 tests that drive the real
handlers through both failures.

> **Third-party code runs with full system access.** Both this and the
> alternative were reviewed before running: no install-time lifecycle scripts,
> no network calls, no filesystem writes outside pi's own API. `pi-loop-mode`'s
> single `pi.exec` is the documented `--check` command you supply yourself.
> Re-review anything pulled from upstream into `vendor/` — the fork is now the
> only copy that runs, so nothing changes under it without a commit here.

## Delegating to a subagent: `Agent`

`vendor/pi-subagents-lite` gives the model a way to hand a job to a focused child
session that burns **its own** window and returns a summary. pi ships no
subagents deliberately ("ask pi to build what you want or install a third party
pi package"), so this is a vendored fork of `pi-subagents-lite@1.11.0`;
`vendor/pi-subagents-lite/FORK.md` is the full account, including why this
package out of the 341 the catalog matches on "subagent".

**On by default** (`SUBAGENTS_ENABLED=1`). It is not free — a registered tool is
charged on every turn whether or not it is called — but the bill was measured:
710 chars, ~178 tokens, 0.54% of a 32k window for all three tools. Set
`SUBAGENTS_ENABLED=0` to get those back.

Be clear about what it buys here, because most of what is written about
subagents does not apply to one llama slot. It is **not** parallelism:
`PARALLEL_SLOTS=1` means concurrent children queue no matter where the queue
forms, and the fork therefore defaults concurrency to 1 so at most one foreign
prefix competes with the parent's at a time. (That default lived in the wrong
file for a release and every session actually ran at 4 — the manager's constant
was unreachable behind a config store that always supplies one. It is one number
now, in `config/config-io.ts`, and a probe through the real wiring reports
`{ limit: 1 }`.) What it buys is **context isolation** — the noisy search happens
in a window that is not this one.

**The real cost is the prefix cache, not the schema.** Measured against
`cached_tokens` on both ports, with a repeat of the same prefix as the control:
a subagent's own system prompt does *not* evict the parent — six small child
turns left the parent at a 99.2% cache hit. A child that grows to ~18k tokens
does: the parent's next call dropped from 2,117 cached tokens to zero and from
**442 ms to 2,949 ms**, a full re-prefill. A real session carries far more than
the 2,133 tokens that was measured on, so treat that as a floor. Delegate work
that is worth a re-prefill; do not delegate a lookup.

The popular packages (`pi-subagents` at 244,797/mo, `subagent-isolation`) all run
each subagent as a child `pi --mode json -p` process, which on this stack costs a
second system prompt that evicts the parent's cached prefix and buys no
concurrency in exchange. This one runs in process, through pi's own
`createAgentSession`.

**What it costs, measured on the wire** rather than estimated — the same stub
model `vendor/prinny-channel/tests/tool-budget.test.ts` uses:

```
baseline (no extension)          2,900 chars   read · bash · edit · write
with vendor/pi-subagents-lite    3,610 chars   + Agent 357 · StopAgent 193 · AgentStatus 157
delta                              710 chars   ~178 tokens, every turn
```

That is 0.54% of a 32k window, and it is that small because upstream ships the
tools with **no description at all** — `Agent`, `run_in_background` and
`worktree_path` are the documentation. Whether a 27B local model drives a schema
that bare is the open question about this package, not its cost.

**What a subagent inherits, measured rather than assumed.** A child does not get
the parent's `-e` flags — it discovers its own extensions. So everything under
`.pi/extensions/` reaches it (the compaction guard included: a live run shows it
capping the *child's own* `read` result at 9,778 → 8,176 chars inside the child
session) and everything under `vendor/` does not. forge is in the path either
way, because the child resolves the same provider, so the reasoning passthrough
and the real `finish_reason` apply to subagent turns too.

That default is wrong in one direction and right in the other, so the fork does
both:

| | in a subagent | why |
| --- | --- | --- |
| compaction guard | yes, by discovery | a child that blows its own window returns nothing |
| forge patches | yes, server-side | same provider, same proxy |
| `rtk` | **put back** | a child running `bash` uncompressed is the session that can least afford it |
| `/loop` | **not given** | it keeps its loop in module scope, and a child binds the same module — see below |
| `prinny` + its skills | **denied outright** | the model spawns subagents on its own initiative; they do not get to post to Matrix |

The denial is unconditional and runs after the agent's own filter, so no agent
file can widen it back, and `SUBAGENT_EXTRA_EXTENSIONS` cannot be used to smuggle
it in. Every subagent also has a turn ceiling — `DEFAULT_MAX_TURNS = 40`, which
steers "wrap up immediately" at the limit and hard-aborts only after the grace
turns, so hitting it produces an answer rather than a severed run. `StopAgent` is
the parent's kill switch, and it takes the **short** id — the eight characters
`AgentStatus`, the background result and its own messages all print. Until the
twenty-fourth pass it resolved that with an exact lookup on the full
seventeen-character id, so it refused every identifier the model had ever been
shown; see AO1 in `context/design/subagents-loop-verifier-identity.md`.

**A subagent's own turns are in the session transcript.** Twentieth pass, and it
is the answer to *"a delegation just ran; where is the record of what it did?"*.
Before it, one delegation put exactly two things in the parent's session file —
the `Agent` tool call and its result, or the `subagent-result` message — and the
child's own turns lived in an in-memory session that is thrown away, a `/tmp`
log that is off by default, and the verifier's JSONL. Now every child turn, the
brief, each verifier call and the outcome are written into the operator's own
transcript as `subagent-turn` entries, headed with the short id `/agents` uses:

```
   ┌ subagent  a3f9c2  Explore  · turn 1 ──────────────────────────────────┐
   │   …[TOOL] bash(grep -rn 'foo(' src)                                   │
   │   …[ASSISTANT] Three: src/a.ts:12, src/b.ts:40, src/c.ts:7.           │
   └───────────────────────────────────────────────────────────────────────┘
```

It costs the model nothing, ever: pi's `sessionEntryToContextMessages` returns
`[]` for a `type: "custom"` entry, so it persists and renders and is never
context — measured against pi's own `SessionManager`, across two compactions and
a re-open from disk, before the code was written. Bounded at 60 entries per
delegation and 4,000 characters each; `SUBAGENT_TRANSCRIPT=0` in `.env` turns it
off — and it reaches the process from there since the twenty-third pass, which is
also when it started to. See
§5.7 of `context/design/subagents-loop-verifier-proxies.md`.

**`/loop` was put back, and then taken out again**, which is worth a paragraph
because the reason is the sharpest edge in this whole design. Subagents run **in
the parent's process**, so a child session binds the *same module object* — and
`vendor/pi-loop-mode` keeps its entire loop in module scope while getting its own
event bus per session. All thirteen of its handlers therefore ran a second time
per delegation, against the operator's one loop. Reproduced, with a loop running
and a subagent doing something unrelated: the child's system prompt gained
*"Loop mode is active. Goal: `<the operator's goal>` … keep every response under
1,200 characters … never stop on your own"*; the child's `agent_end` drove the
operator's iteration ladder and had the operator's **next loop turn delivered
into the child**; and a child that compacted had its whole conversation replaced
by the operator's loop handoff summary. An earlier fix had guarded two of the
thirteen. The package is now inert inside a spawn and is no longer handed to a
child at all, which also returns ~177 tokens/turn of `loop` tool schema to the
child's window. It goes back when its state is keyed by session rather than by
module. `context/design/subagents-loop-verifier-evaluation.md` has the
reproductions.

**The model can start and stop a loop itself.** `/loop` was command-only, which
meant only a human could start one — a model calls tools, it cannot type a slash
command. `vendor/pi-loop-mode` now registers a `loop` tool alongside the command
(709 chars, ~177 tokens/turn on the wire) so the model can run its own bounded
goal loop and stop it, in the main session or inside a subagent.

**Answers are checked against the task before you see them.** A subagent gets a
brief it has no context for and compacts its window as it fills — and what a
monotonic summary erodes first is the oldest thing in it, which is the brief. So
three layers, cheapest first: the task is restated into the child's context
after every compaction (free, and the layer that matters most, because it stops
the drift instead of catching it); an empty answer or a run that hit the turn
ceiling is handled with no model call at all; and only a non-empty answer from a
clean run is worth asking a judge about.

The judge is a fresh one-turn agent with no tools that sees **only** the task and
the answer — not the child's session. A model shown its own reasoning ratifies
its own answer, so the judge is made harder to fool by knowing less. It knows
less about the *work*, not about the *text*: both the task and the answer are
quoted into its prompt inside fences, and a subagent's answer is model output
shaped by whatever the subagent read — so an answer containing a fence used to
end the quoted region early and continue in instruction position, above the two
lines the judge is meant to obey. Both blocks are now defused the way
`prinny-channel` has always defused a Matrix sender's `</channel>` and `[matrix]`
(a zero-width space, and nothing else touched: an answer is expected to contain
code). See AJ4 in `context/design/subagents-loop-verifier-authority.md`. A failed
verdict continues the *child* once, since that is where the context to fix it
lives — and that fix is then judged in its turn, because the answer least worth
trusting unchecked is the one produced by a child already known to have drifted.
That check→repair pair is a loop with a ceiling, exactly like the child's own
turn limit: `SUBAGENT_VERIFY_ROUNDS` repairs (default 1, clamped to 3), stopping
early on an empty retry or one identical to the answer just rejected. Worst
case is `1 + 2×rounds` model calls for one subagent answer. If every attempt
fails, the child's **original** answer goes back, flagged — it is what the
parent would have received with the verifier off, and a retry from a child
that has just been told twice it is wrong is not an upgrade.
`SUBAGENT_VERIFY=0` turns the whole thing off.

Every model call the verifier makes is written to
`~/.pi/agent/subagent-verify.jsonl` — the prompt, the raw reply, and the parse
the stack acted on, because a reply and a verdict side by side is the only thing
that can show the parser was wrong, and four findings in this series each needed
exactly that. Bounded at 2,000 lines with 4,000 characters per field;
`SUBAGENT_VERIFY_LOG=0` in `.env` turns it off and `SUBAGENT_VERIFY_LOG_FILE`
moves it. Both reach the process from `.env` since the twenty-third pass.

The answer **text** is only annotated when something went wrong — a note there
is text the parent model reads and quotes, so a pass must not carry one. The
verdict instead shows as a marker on the result line and in the agent list: dim
`✓ checked` for a pass, `✎ repaired`, `✗ off-task`, and a `⊘` label naming the
kind of skip. **No marker means it was never checked**, which is the distinction
the whole layer exists to draw and which was previously impossible to see. While
the judge is working the agent keeps its row in the widget and says so, because
that call holds the one llama slot the session is waiting on.

It costs nothing in schema — the verifier agent is hidden from the `Agent` tool's
type list, and that was measured, not assumed. It does not catch subtly wrong
work: the judge is the same 27B. It is a drift check, not a correctness proof.

One thing was fixed rather than inherited. A **foreground** subagent returns as a
tool result, so the compaction guard bounds it like everything else. A
**background** one is injected with `pi.sendMessage(..., {triggerTurn: true})`,
which pi delivers straight to the agent without emitting `tool_result`, `input`,
or anything else an extension can hook — so an unbounded result would arrive in
the context and trigger a turn, which is precisely the 17,790-character failure
the guard exists to prevent. The fork bounds it at the source, reusing the
guard's measured constants rather than restating them.

## Talking to it from Matrix: `/prinny`

`vendor/prinny-channel` puts a pi session on Matrix. A message from an
allowlisted sender becomes a turn; the answer comes back to the room by itself.
It is a conversion of the Claude Code plugin of the same name — the Matrix half
is upstream's and unmodified, everything that touched Claude Code was rewritten
for pi. `vendor/prinny-channel/FORK.md` is the full account.

**Off by default** (`PRINNY_ENABLED=0`). It is the only part of this stack that
logs into a remote service and makes the session addressable from the internet,
which is a decision to take on purpose. Set it to `1` and:

```
/prinny prepare                                     once, ~1 min
/prinny configure https://matrix.example.org @bot:matrix.example.org <password>
# message the bot from your Matrix client — it replies with a code
/prinny pair <code>
/prinny policy allowlist                            stop handing out codes
```

`/prinny` on its own prints connection state, policy, allowlist, pending
pairings and settings. `/prinny log` tails the channel's own log — the channel
never writes to the terminal, because in pi stdout and stderr are the TUI.

The Matrix layer runs as a **child process**, not inside pi. Loading
matrix-js-sdk plus its Rust crypto blocks the event loop for ~15 seconds and
writes to stdout on the way up; in-process that is a frozen TUI drawn over with
library chatter. Its ~105MB of dependencies are installed outside the repo, at
`~/.pi/agent/channels/prinny/runtime`, by `/prinny prepare`.

That runtime is a **compiled copy** of `vendor/prinny-channel/server/src`, keyed
on a content fingerprint of the source. So it can be out of date, and since the
twenty-third pass everything that asks says which of three states it is in:

```
   node vendor/prinny-channel/server/bin/prinny-channel.mjs --staged
     current   exit 0    the build matches the source
     stale     exit 1    it does not — run /prinny prepare
     absent    exit 2    nothing compiled — run /prinny prepare
```

`/prinny status` prints the same three, the launch banner says
`/prinny (runtime stale)`, and `/prinny start` **refuses** on `stale` rather than
starting. That refusal is the point: a stale runtime re-stages on the next start,
inside a 120-second connect budget that already spends a measured 27.5 seconds
importing the Matrix stack, and it fails as `initialize timed out` — which reads
as a broken channel rather than a rebuild. Before this, three readers and the
banner all said "built" for a runtime whose source had moved on.

**The answer is forwarded, not requested.** Upstream made a `reply` tool the
only way out, which holds at frontier scale and does not at 27B: the model
writes a good answer into the transcript, never calls the tool, and the person
on Matrix sees nothing while the operator sees a complete reply. So the
extension sends the assistant's text itself — `text` content only, never
thinking blocks and never tool calls, filtered by allowlist so a new content
kind is excluded rather than leaked. `/prinny forward all` sends each message as
it completes instead of one message at the end; `/prinny forward off` restores
upstream's behaviour.

**It sends the whole turn, not its last word** — changed 2026-08-30, on a
reported incident. `result` used to forward the last assistant message that had
text, which is right for a run that answers once and stops and drops the answer
for every run that does not. pi starts a new assistant message after every tool
call, so a turn that reacts, replies or greps mid-answer ends with its real answer
*above* the last text. Measured: one inbound `haiii` produced a greeting, a
planning note, a `prinny(react)` call, a meta remark and a trailing
`*boops head, waits patiently* 🦊` — and the sender got the boop, alone. `result`
now forwards every text-bearing message of the run in order, as one message;
`/prinny forward last` is the old behaviour, kept because it is the narrowest
thing that can reach a stranger.

The cost is length, not leakage. That was checked against the session file after
first being got wrong from a terminal paste: the planning note and the "I've
already sent my reply" line in that run are **`thinking` blocks**, and the
forwarder's allowlist is `type === "text"`, so neither was ever forwardable. What
widening actually sends is every in-character line the model writes between tool
calls — "Page loaded, *ears perk* — let me see what's in there", "404, huh…
*tilts head*". On a long agentic run that is the point if you want to follow
along, and noise if you just want the answer; `forward last` is still there for
the second case. `vendor/prinny-channel/FORK.md` §AQ1 has the whole account,
including the correction.

**To follow a long run live, `/prinny forward all`.** `result` batches the whole
turn into one message when it settles, which on a ten-tool-call browse is a wall
of text after several minutes of silence. `all` sends each line as it completes,
so the sender sees "404, huh…" while it is still happening. Pair it with
`/prinny set deliverAs steer` if you want to redirect mid-run: the default,
`followUp`, holds an inbound message until the agent has finished every tool
call, so a correction typed halfway through a browse does not land until the
browse is over.

**A Matrix message reads as one line, and there is one tool.** Both were paid for
on every turn. Upstream's `<channel …>` block carried up to fourteen attributes
so the model could hand `room_id` back to a tool — 249 chars of wrapper around a
29-char message on this stack's own traffic, 279 around 2. The extension already
knows which room a turn came from, so it keeps that itself and the model sees
`[matrix] <what they said>`, annotated only when it changes the answer
(`image=`, `attachment=`, `from=` in rooms, `delayed=`). Same two messages: 38
chars and 25.

The six `prinny_*` tools became one `prinny`, dispatching on `action` —
`reply`, `react`, `edit`, `download`, `history`, `search`. Measured off the wire
with the same harness that measured the six: **1,333 chars against ~5,900**,
~333 tokens against ~1,470. Nothing was lost, because the common path never
needed a tool — an ordinary written answer is forwarded already.

The `[matrix]` marker stays, at about a token, because it is the boundary
between "the operator typed this" and "a stranger sent this" that every
untrusted-input guideline depends on.

## A persona for the voice: `/persona`

`vendor/pi-persona` gives the assistant a character to be, without giving that
character any say over the engineering. It is a port of openclaude's `/identity`
system; `vendor/pi-persona/FORK.md` is the full account, including the six
places it departs from upstream and why.

**On by default**, because with no persona active it costs nothing at all: the
`before_agent_start` handler returns `undefined` and the package registers no
tool, so there is no schema to pay for on a turn that never uses it. The cost
arrives with the persona, and then it is the largest single thing in the request.

```
/persona                    pick a source: local library, chub.ai, search, random
/persona local              browse the library; activate a cached one for free
/persona chub trending      browse chub.ai by sort mode
/persona search <query>     free-text search
/persona show               read the active persona file
/persona status             what is active, and what it costs per request
/persona clear              back to the neutral voice
/persona prompt full|lean   how much of the persona contract to send
```

### How one is made

A chara_card_v2 card — from [chub.ai](https://chub.ai) or a `card.json` dropped
into `~/.pi/agent/personas/` — is staged, and then handed to **the model** as an
ordinary turn with instructions to write a 200-500 word voice profile:
cadence, vocabulary tier, verbal tics, mannerisms, emotional defaults, one sample
line. That is upstream's design and it is the right one. A card's persona signal
is scattered — cadence hides in `mes_example`, register hides in `scenario`, the
intended voice is often only in `creator_notes` — and no field-picker recovers
it.

It is also where the card's **operating directives** are thrown away. Cards carry
jailbreaks, mandatory output blocks, and in-character refusal instructions; the
extraction prompt's IGNORE list drops all of it, so what reaches the system
prompt is a voice rather than somebody else's policy.

The profile lands at `~/.pi/agent/PERSONA.md` and in the library entry, and takes
effect on the next turn. Re-selecting a card you have already extracted activates
the cached profile with **no model turn at all** — upstream re-extracts every
time; the library's copy is the finished artefact.

Cards larger than 15% of the window are never inlined. The model walks them
field-by-field with `jq`, one Bash call per field, guided by a shape summary that
reports each field's length so it can skip the empty ones. On a 32k window that
threshold is 19,660 bytes; upstream's flat 50 KB would be 40% of the window spent
before the model had read the instruction.

### What it costs

Measured on pi 0.84.4 by capturing a real `POST /v1/chat/completions` off the
wire — a stub OpenAI-compatible provider in `models.json`, `pi -p "hi"`, and the
request body written to disk.

| | bytes | ~tokens | share of a 32,768-token window |
| --- | --- | --- | --- |
| pi's own system prompt (4 tools) | 2,590 | 648 | 2.0% |
| `<active_persona>`, `full` | 14,729 | 3,683 | 11.2% |
| `<active_persona>`, `lean` | 9,243 | 2,311 | 7.1% |
| no persona active | 0 | 0 | 0% |

The block is byte-stable across turns, so it costs one prefix re-prefill at
activation and nothing after. `/persona status` prints the live number, and the
launch banner names the persona when one is already active — a persona is global
to the agent home and survives restarts, so a session can otherwise inherit one
adopted days ago and pay for it with nothing in the transcript saying so.

`PERSONA_PROMPT_MODE=lean` drops the four roleplay-specific enumerations and
keeps every rule that fires on ordinary engineering work.

### The persona has no authority over the work

This is the part that makes it usable on a coding stack rather than a novelty.
The block says so explicitly, and the tests assert the sentence survives in both
prompt modes:

> **The persona is voice-acting over invariant engineering.** Personality traits
> ("lazy", "frugal", "drowsy", "perfectionist", "anxious") NEVER affect:
> thoroughness, investigation depth, tool/library choice, code quality, test
> coverage, or honesty about results.

Two more that matter here. The block forbids **simulated tool output** — a URL, a
file path or a command result that did not come from a call actually made this
turn — under any persona. And it names only tools pi says are on the surface
**this turn**, read from `event.systemPromptOptions.selectedTools`. Upstream
hardcodes `WebSearch` / `WebFetch`, which pi does not have; ported verbatim that
instructs a model with no fetch tool to produce a link, and the only way to obey
is to invent one.

### The immersion marker is off

openclaude appends a Chinese instruction block to the first user message. It is
not decoration — it is a documented DeepSeek-V4 training artefact that re-routes
that model's `<think>` from "deliberate about whether to comply" to "think in
character". `auto` resolves to **off** on anything that does not look like
DeepSeek, which is this whole stack: the markers are exact strings one model
family was trained on, and injected elsewhere they are just tokens.

`PERSONA_IMMERSION=immersion` turns it on by hand. It is **unmeasured** on Qwen.
`THINK_LANG=zh` is already on here, so the model is being asked to reason in
Chinese anyway — which makes the markers less alien than on a generic setup, and
is a reason to try it and record what happens rather than a result.

## The proxy was destroying the model's reasoning

`patches/forge_reasoning_passthrough.py`. Empty assistant turns on this stack —
`content: []`, `stopReason: "stop"`, a clean successful turn with no answer in it
— were forge's doing, not llama.cpp's. The control, same request to both ports:

```
llama-server :8080  ->  finish_reason "length",  reasoning_content 490 chars
forge        :8081  ->  finish_reason "stop",    no reasoning_content key at all
```

forge's `TextResponse` carried `content` and nothing else. `ToolCall` has always
carried `reasoning`, and the llama client said so outright — "reasoning is only
useful on ToolCall, TextResponse just gets clean content" — which holds right up
until the model produces reasoning and *nothing else*. Then `accumulated_content`
is empty, the reasoning has nowhere to live, and everything generated is gone
before the response is assembled.

`finish_reason` was hardcoded `"stop"` in the same place, so a **truncated
answer** was indistinguishable from a finished one: the model writes past
`PI_MAX_TOKENS`, gets cut mid-sentence, and the half-finished sentence is
recorded as the answer.

Reasoning is emitted as `reasoning_content` and **never merged into `content`**,
which is the whole safety argument: pi maps it to a *thinking* block, and
`vendor/prinny-channel` allowlists *text* blocks, so the harness sees the
reasoning and a Matrix sender does not. Setting `--reasoning-format none` on
llama-server would recover the same tokens by putting them in `content`, and
would leak them.

Verified against pristine PyPI source before the build, not against the running
container — which is already patched and reports the pre-patch blocks as missing,
loudly, which is what the source-text verification is for.

**A Matrix sender can run a named few pi commands.** `sendUserMessage` passes
`expandPromptTemplates: false`, so a `/` message had never executed anything — it
reached the model as literal text. Allowed now: `/compact` (which this extension
performs itself, because pi's `prompt()` dispatches extension commands only), the
whole `/loop` lifecycle, and **`/stack status` and `/stack help` — not the rest of
`/stack`**. Refused, each on its own grounds: `/prinny` (it edits the allowlist
itself), `/trust` (loads a project's extensions — arbitrary code), `/login`,
`/logout`, `/settings`, `/share`, `/export`, `/copy`, `/new`, `/fork`, `/resume`,
`/session`, `/tree`, `/quit`, `/model`, `/name`, plus `--model`, `--rescue-model`
and `--check` on anything permitted, which would route around a refusal made
elsewhere. A refused command is answered on Matrix and **not** delivered to the
model, so it cannot be talked into running it another way. Anything unrecognised
stays prose — `/usr/bin/foo is broken` is a sentence. See
`src/command-routing.ts`.

`/stack` was allowed in full until 2026-08-19, and it should not have been: every
one of its twelve subcommands ends in `pi.exec`, which emits no `tool_call`, so
none of them passes the permission relay — and `/stack up`, `/stack smoke`,
`/stack bench <args>`, `/stack logs` and `/stack slots erase` had no confirmation
of any kind. The five that did have one used `ctx.ui.confirm`, which is a modal
in **your** terminal that said nothing about a Matrix sender having asked for it.
The two forms that remain are exactly what the sidecar advertises the command as.
If the sender's real question is "is the model up?", ask in ordinary words: the
model calls the read-only `stack_status` tool and answers on Matrix, which is a
route that actually reaches them — a `/stack status` writes a terminal entry
they never see. See AJ1 in
`context/design/subagents-loop-verifier-authority.md`.

**The typing indicator follows "Working…".** Up between `agent_start` and
`agent_settled`, refreshed every 8s against Matrix's 20s expiry. Two subtleties
were paid for: re-asserting `typing: true` while already typing produces **no
`m.typing` EDU at all** (Synapse only broadcasts when the set changes), so each
assertion clears first; and the sidecar no longer signals typing on *arrival*,
which was claiming work up to 89 seconds before pi had the message.

**A run that ends without an answer is continued, not abandoned.** Empty turns
have three observed causes — a truncated response, a turn that generated tokens
but no answer, and a transport failure — and the diagnosis names which. Two
retries, wording per cause, with the question restated so a compaction cannot
lose it. Nothing is ever forwarded in place of an answer: an empty final turn
used to make the forwarder walk *back* to the previous turn's deliberation and
send that.

`/prinny permissions dangerous` relays a Matrix approval prompt before `rm -rf`,
`sudo`, force pushes and similar. pi has no approval system of its own, so this
is the extension's own gate rather than a relay of one; it **fails closed**, so
a dead channel blocks rather than allows.

"And similar" is now a property rather than a spelling. The three guards that
name one — a recursive force delete, discarding working-tree changes, making
something world-writable — read the command's tokens instead of matching a
regex, so `rm -rfv`, `rm -r -f`, `rm --recursive --force`, `rm /path -rf`,
`git clean --force -d` and `chmod 0777` all ask, and `rm -- -rf` (a file with
that name) still does not. See AK2 in
`context/design/subagents-loop-verifier-proxies.md`.

**A prompt nobody answers now says so.** The relay stops waiting after
`permissionTimeoutSeconds` and blocks the call. It tells the sidecar how long it
will wait, so an Allow pressed after that is answered *"no longer waiting … pi
blocked the call. Nothing was run"* rather than `✅ Allowed` — which is what the
room used to be told about a command that never ran.

> **One Matrix account per channel.** Two bots signed into the same account
> duplicate every delivery and fight over the crypto store, which ends with a
> bot that cannot decrypt its own rooms.

## The launch banner

Every session prints what it is actually doing, so nothing is on silently:

```
pi -> http://localhost:8081  (model: qwen3.8-27b, context files off, thinking in zh, mcp via cli, browser (native tools), /stack)
```

Read it. `thinking in zh` means the Chinese-reasoning fragment is active;
`mcp via cli` means the MCP skill is loaded; `browser (native tools)` means the
adapter registered the `browser_*` tools, against `browser (cli)` for the shell
path, `browser (server down)` when the server would not start, and
`browser (no checkout)` when there is no Zendriver-MCP to run;
`context files off` means `-nc`;
`/loop` means the vendored loop-mode fork loaded (and that no upstream npm copy
is shadowing it);
`/stack` means the stack extension loaded. If `/stack` is absent from the
banner, the command will not exist in that session. `/prinny` means the Matrix
channel loaded — and it says so with a qualifier when it will not work yet:
`/prinny (runtime not built)`, `/prinny (runtime stale)` or
`/prinny (not configured)`.
`/persona` means the persona extension loaded, and it names the persona when one
is already active — `/persona (Nadia)` — because a persona is global to the agent
home and survives restarts, so a session can otherwise inherit one adopted days
ago and spend 11% of its window on it with nothing in the transcript saying so.

## Keeping pi current

`PI_AUTO_UPDATE=1` (the default) has the launcher check npm and upgrade pi in
place. The check is rate-limited to once every `PI_UPDATE_INTERVAL_H` hours (24)
via a stamp file, so you are not paying a registry round trip every session, and
it **fails soft** in every direction — no npm, no network, or a failed install
all warn and launch on the version already there. `PI_AUTO_UPDATE=0` pins it.

## If it will not start

`pi-local.sh` refuses to launch rather than dropping you into a session that
cannot reach the model:

```
err  forge is not answering at http://localhost:8081 — start it with ./scripts/up.sh
```

`./scripts/up.sh` starts the stack. The **first** start after a cold boot takes
~20 minutes: the model is 17.9 GB read over a Docker Desktop bind mount that
measures 10–38 MB/s. `./scripts/logs.sh llama` shows real progress; the health
status will say `starting` the whole time.

## How the provider config is generated

pi has no "point at a proxy" flag — custom providers live in
`~/.pi/agent/models.json`. The script generates that entry from `.env`, so the
model id, context window and port cannot drift from what the stack serves. It
*merges* into the file rather than overwriting, since pi keeps other providers
there too.

What it writes, and why each field:

```json
{
  "providers": {
    "forge": {
      "baseUrl": "http://localhost:8081/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen3.8-27b", "contextWindow": 98304, "maxTokens": 8192 }
      ]
    }
  }
}
```

`contextWindow` above is illustrative. The real one is GENERATED from
`CTX_SIZE` by `scripts/pi-local.sh:100`, so it tracks `.env` automatically and
this block cannot drift the running system — only a reader who hand-copies it.

- **`openai-completions`, not `anthropic-messages`.** forge speaks both, but the
  OpenAI endpoint is the short path (pi → forge → llama.cpp). Routing via
  Anthropic would add a translation hop that drops `cache_control` and
  `thinking` for no gain. It is also the only path anything here is measured on.
- **`apiKey: "local"`** — pi hides models it considers unauthenticated, so even a
  keyless local server needs a placeholder.
- **`compat` both false — and on 3.8 the reason is the engine, not the model.**
  Qwen3.8's template supports the `developer` role and takes a real
  `reasoning_effort` variable. llama.cpp only started forwarding an API-level
  `reasoning_effort` to the template in commit `7e4c0a9` (2026-08-14), and the
  newest published CUDA image at migration time was `server-cuda-b10423`, cut a
  day earlier — so a client that sends the field has it silently dropped. Effort
  is set server-side instead; see below.
- **`maxTokens` well under `contextWindow`** — with `--no-context-shift` an
  overflowing request fails loudly, and an agent loop's prompt grows every turn.
  It comes from `PI_MAX_TOKENS`, and `LLAMA_EXTRA_FLAGS` carries the same number
  as `-n` so the server enforces it even if a client forgets to ask.
- **`baseUrl` host** — the script uses `host.docker.internal` when it detects it
  is running inside a container, `localhost` otherwise.

**Not using pi's `/llama` integration.** pi can manage its own llama.cpp router
and models. That would bypass forge completely and lose every guardrail this
repo exists to provide, so the model is registered as a plain custom provider
instead.

**It sizes compaction from `CTX_SIZE` too**, into `~/.pi/agent/settings.json`
(merged, not overwritten — pi keeps its theme and packages there):

```json
{ "compaction": { "reserveTokens": 16384, "keepRecentTokens": 6554 } }
```

pi's defaults are `16384` / `20000`, sized for a 200k window. On 32k the second
one is 61% of the whole window, so a compaction cannot free more than the
remainder, and `prepareCompaction()` silently returns nothing at all until the
context exceeds it — which is why compaction in the measured sessions first fired
at 88% full rather than at the 50% the setting implies. `reserveTokens =
min(16384, CTX_SIZE // 2)` keeps the trigger at 50% of whatever window is
actually served; `keepRecentTokens = max(2000, min(20000, CTX_SIZE * 0.2))` cuts
back to ~20% of it. Measured against pi's own `prepareCompaction()`, that drops
the post-compaction floor from 20,000 tokens to 7,000. Global rather than a
`.pi/settings.json` here, because `/loop` runs in whatever project you point it
at — and project settings only load for a *trusted* project.

**What that sizing cannot fix, and `.pi/extensions/compaction-guard/` does.**
Two knobs are not enough, because `reserveTokens` is also the summarizer's own
`maxTokens` and nothing bounds the summary pi carries from one compaction into
the next. pi's `UPDATE_SUMMARIZATION_PROMPT` tells the model to *"PRESERVE all
existing information from the previous summary"* and to include *"previously
done items AND newly completed items"*, so the summary is monotonic by
construction. Across the 42 real compaction points under `~/.pi/agent/sessions`
it runs 456 → 4,029 → 11,054 chars, and inside one session it only ever went up:
1,666 → 3,183 → 5,891 → 9,411 → 11,054.

The guard caps what pi is allowed to feed back — 5% of the window (6,554 chars
on 32k), trimmed section-aware so `## Goal` and `## Next Steps` survive and the
accumulating `### Done` list is what goes. Replayed over those same 42 real
summaries: 11 are trimmed, none exceed the cap, no `## Goal` or `## Next Steps`
is lost, and that growth curve flattens to `6,458 → 6,538 → 6,550 → 6,516`.

**And it caps a single tool result to a share of what context is left**, because
the advisory below is not enough on its own. Watched failing on 2026-08-17: the
CRITICAL notice was in context at 84.5% of the window, saying "do not run
commands with large output this turn", and the model ran a three-URL curl loop
that returned 17,790 characters — 100% of the window, an empty assistant turn,
and a dead run. It could not have complied even in good faith, because nobody
knows how many bytes a pipeline prints until it has printed them.

The allowance is 10% of the REMAINING window (floor 1,500 chars, ceiling
20,000), so a 20k result at 15% used is untouched and the same result at 85% is
cut to ~2,000. Head and tail are kept — the head says what ran, the tail says
whether it worked — and the full output goes to a file the marker names, so
nothing is lost. On the failing run that lands the context at 86.8% instead of
99%, below the empty-turn cliff, with room to write a conclusion.

It also shows the model its own remaining budget above 60% of the window, which
is the generic half of the `/loop` context work: above 87% of the window 52% of
assistant turns came back empty (33 of 63) against 1.5% below it (3 of 196), and
that cliff is a property of the model and the window, not of `/loop`.

Both hooks only ever *add* a bounded line or *shrink* a string pi was about to
send to the summarizer — `session_before_compact` returns `undefined`, so pi
still writes its own model summary and the guard can never replace or cancel a
compaction. What is deliberately **not** ported is `/loop`'s handoff, which
throws the conversation away and rebuilds from `GOAL.md`/`PROGRESS.md`: that is
right for a loop and wrong for a session where the conversation *is* the state.

**`BROWSER_MCP_TOOL_TIMEOUT` sizes the browser server's own budget below the
client's.** `ToolBase._register` has always guarded each tool with a time budget,
but at 120s against pi's `requestTimeoutMs` of 30s the server lost that race
every time: it kept working on a tab the client had abandoned, the model fired
the next call at the same tab, and the CDP session corrupted. That is what
wedges the browser — not the page. On a fresh browser the exact URL that "hung"
loads in 7.6s. At 25s the server answers first, with a sentence naming the tool
and the number.

**And `httpIdleTimeoutMs`, for the same reason.** pi's default is 300,000 ms —
how long a request may go without producing a single byte. Prefill produces no
bytes while it runs. Measured 2026-08-16 in a real session: the first two
requests both died with `Error: terminated` at **exactly 301 s**, ten minutes
before the first token, because this box had collapsed to 20–37 tok/s of prefill
under memory pressure (the healthy figure is 1,175 — see `changelog.md`).
6.5k tokens of prompt at 35 tok/s is 187 s of silence, and a prompt-cache
eviction pushed it past 300. The value is sized so a *full* window still prefills
inside the budget at 36 tok/s — the degraded floor, not the healthy rate — then
clamped to `[300 s, 15 min]`: 900,000 ms on a 32k window.

That is a seatbelt, not a fix. If you are seeing it engage, the box is swapping;
see the note on `CACHE_RAM` above and run `/free`.

## Why pi, and what that costs

pi is minimal by design: **no MCP** (its README says so outright — "build CLI
tools with READMEs, or build an extension that adds MCP support"), no
sub-agents. On a local window that is the feature, not the limitation. A
single MCP server can publish hundreds of tool schemas that load before your
first message, and that budget is gone before the model has read anything.
(This section was written against a 32K window. `CTX_SIZE` has been **98304**
since 2026-08-23, so the pressure is a third of what it was — the argument is
weaker than it reads, but it points the same way: standing cost you never chose
is the expensive kind.)

What you give up is real and worth stating: no MCP servers, no sub-agent
fan-out, and no ecosystem of Claude Code plugins. What you get back is nearly
the whole window for the actual session.

Your project's conventions still load: pi walks parent directories for
`AGENTS.md`/`CLAUDE.md` and `PI_CONTEXT_FILES` is `1` by default. That is a
deliberate exception to the window-frugality above — an agent that ignores the
conventions file in the repo it is editing costs more in rework than the tokens
save. `PI_CONTEXT_FILES=0` passes `-nc` and skips the discovery.

---

[← back to the README](../README.md)
