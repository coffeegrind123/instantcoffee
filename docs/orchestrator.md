# Orchestrator mode

opus coordinates; haiku executes; fable plans. One pi session on
`claude-opus-5-5` splits the work, writes briefs, dispatches up to 15 subagents
on `claude-haiku-5-5` in parallel, re-runs every check they claim, reads their
diffs, and keeps the state on a board that survives compaction and new sessions.
Before the briefs are written, the planning seat — `claude-fable-5-1` — turns
the goal into an ordered plan.

```
 you ─► pi (claude-opus-5-5, the session)                the orchestrator
         │  briefs: .pi/orchestrator/briefs/<id>.md
         │  board:  .pi/orchestrator/board.md
         │
         ├─► advisor   claude-fable-5-1   plans, read-only, one entry above the default
         ├─► worker   ┐  anthropic/claude-haiku-5-5, up to SUBAGENT_MAX_CONCURRENT
         │    └─► helper (SubAgent)   at once per level; extra spawns queue;
         ├─► explorer │  each has its own window on the same provider
         │    └─► explorer helper      helpers cannot spawn further
         └─► ...      ┘
```

The Anthropic API serves requests concurrently, so the parallel fan-out is real
here in a way it never was on the local model, where one llama slot made every
child queue no matter where the queue formed. That is the whole difference the
seats buy: the orchestrator fans out because the provider can hold the load, and
the seats mean the fan-out costs what it should rather than what the orchestrator
costs.

## The three seats

| seat | model | configured by | what it does |
| --- | --- | --- | --- |
| the session | `claude-opus-5-5` | `ANTHROPIC_MODEL` | plans, briefs, verifies, keeps the board |
| every subagent | `claude-haiku-5-5` | `SUBAGENT_MODEL` | reads, implements, runs acceptance commands |
| the advisor | `claude-fable-5-1` | `ADVISOR_MODEL` | turns one goal into one ordered, briefable plan |

**Why the advisor is a per-agent-type override and not just another worker.**
The advisor is the same `Agent` tool, told to plan; on a single-model stack
nothing would stop it inheriting whatever the session runs. A separate seat is
only real if the value is *read* at spawn time, and the fork resolves a model
through a ladder in `vendor/pi-subagents-lite/src/models/model-precedence.ts`:

```
  1. sessionOverrides[subagentType]   ← the advisor          (what the seed writes)
  2. sessionOverrides["default"]      ← every other child     (what the seed writes)
  3. config, per type
  4. config, default
  5. agent frontmatter
  6. parent model
```

The launcher writes `{"model": "anthropic/claude-haiku-5-5",
"overrides": {"advisor": "anthropic/claude-fable-5-1"}}` into the seed. The
`model` field is the session default every child inherits; `overrides` is keyed
by agent type and sits **above** it. That ordering is the only reason one role
can hold a different model from its siblings without the frontmatter or a config
file silently winning, and it is why the advisor is not just a fourth worker with
a different prompt.

## Turning it on

1. `ANTHROPIC_API_KEY=...` in `.env.local` (gitignored). For pi in a container,
   the container checkout's `.env.local`, or an exported variable — the
   container forwards it by name.
2. In `.env`: `ORCHESTRATOR=1`. `SUBAGENTS_ENABLED=1` must stay on.
3. Start pi as usual (`./scripts/pi-local.sh` or `./scripts/pi-container.sh`).
   The launch line ends `orchestrator (15x anthropic/claude-haiku-5-5, advisor
   anthropic/claude-fable-5-1, depth 2)`.

It is pi-side only. There is no llama to restart and no regime to switch: the
three models are values the launcher writes and the fork reads.

| key | default | |
|---|---|---|
| `ORCHESTRATOR` | `0` | the switch |
| `SUBAGENT_MODEL` | `anthropic/claude-haiku-5-5` | `provider/model-id` as `pi --list-models` shows it |
| `ADVISOR_MODEL` | `anthropic/claude-fable-5-1` | the per-agent-type override |
| `SUBAGENT_MAX_CONCURRENT` | `15` | 1-15, per level |
| `SUBAGENT_MAX_DEPTH` | empty = `2` here | `1` = only the orchestrator spawns; `2` = its subagents may spawn helpers |
| `ANTHROPIC_API_KEY` | — | `.env.local` only |

The launcher refuses to start rather than degrade: no key, a seat's model pi does
not list, a cap out of range, or the subagent extension not loaded.

**A seat the catalog does not know is refused, by name.** pi hides a provider
whose models have no usable credentials, and the catalog bundled with an
installed pi lags the published one — pi 0.85.1 ships none of the three seats'
models. So the launcher runs `pi update --models` at start
(`PI_UPDATE_MODELS_ON_LAUNCH`, fails soft) and probes **both** the child model
and the advisor against `pi --list-models`. The advisor especially: an id the
catalog does not know is how a seat silently ends up on the parent's model,
which is the one failure this branch exists to prevent. The refusal names the
fix — `Refresh the catalog with: pi update --models`.

## What the launcher sets up

- **The three models and the cap** go into the seed file named by
  `SUBAGENT_MODE_CONFIG` (pi's agent directory, `orchestrator-mode.json`). The
  subagent extension reads it as its SESSION layer — above every config file —
  and every reset in `/agents` returns to it, so clearing an override cannot put
  children back on the orchestrator's model and its price. The operator's
  `subagents-lite.json` is never written. Concurrency:
  `anthropic: SUBAGENT_MAX_CONCURRENT`.
- **Agent types** `worker`, `explorer` and `advisor` from
  `prompts/orchestrator/agents/`, through `SUBAGENT_MODE_AGENTS_DIR`: above the
  operator's global agents, below a project's own `.pi/agents/`.
- **The orchestrator prompt**, `prompts/orchestrator/main.md`, appended to the
  system prompt with the cap, the child model and the advisor model filled in.
  The delegation nudge (`prompts/delegate.md`) is left out: it says agents share
  one slot, which is the opposite of this mode.
- **No answer judge.** `SUBAGENT_VERIFY` is forced to 0: the orchestrator
  re-runs every claimed check itself, which a one-turn judge reading the answer
  cannot match. (Where the judge does run, it runs on the child's model.)
- **Two levels of delegation** (`SUBAGENT_MAX_DEPTH=2`). A worker or explorer
  gets a `SubAgent` tool and may split its item among helpers; helpers get no
  spawn tool at all. `SubAgent` waits for its helper — pi runs one turn's tool
  calls in parallel, so several calls in one turn still fan out — because a
  background result would be delivered to the orchestrator instead of the
  caller. An explorer may only spawn read-only helpers. Helpers show up in
  every listing as `↳ [<caller id>] …`. Each level has its own concurrency pool
  of `SUBAGENT_MAX_CONCURRENT`: a caller holds its slot while it waits, so one
  shared pool would deadlock as soon as every caller delegated at once. The
  cost of that is up to 2 × the cap in live calls.

## Prompt caching, which a long session depends on

Every turn the orchestrator takes re-sends its system prompt, the board, the
briefs it is carrying and the results it has already read. On the Anthropic wire
that prefix is cacheable, and the launcher turns caching on as a first-class
feature rather than a pile of flags:

- `models.json` declares `promptCache = {short: 300, long: 3600}` for each of
  the three seats. pi only *warms* an idle cache for a model that declares a
  lifetime, so this is the switch.
- `settings.json` carries `cacheWarming` (`PI_CACHE_WARMING`, default `idle`) and
  `showCacheMissNotices`. `idle` also warms between runs, which is what a
  session with long gaps between turns needs.
- `PI_CACHE_RETENTION=long` is exported, which is what makes pi emit
  `cache_control: {type: "ephemeral", ttl: "1h"}` instead of the 5-minute
  default.

Why the long tier matters here and not on a chat session: the orchestrator's
turn *rate* is low. It reads a diff, decides, and dispatches — minutes can pass
between turns while children run, and a 5-minute cache would be cold every time
the orchestrator picked the thread back up, re-paying for the whole prefix.
The dashboard and `/session` report `cacheRead` / `cacheWrite` / `cacheWrite1h`,
so the hit rate is visible rather than a figure you find on the bill.

## What the orchestrator does

The prompt is the operator's standing agent prompt with an Orchestration
section built on the orchestrator-worker / coordinator-implementor-verifier
pattern:

- It does not implement; workers do. It verifies by re-running each worker's
  acceptance commands and reading the diff. Exit codes decide.
- Before writing a brief it sends the `advisor` the goal, the constraints and
  the evidence, and asks for a plan — the ordered items, the files each owns,
  the acceptance command that proves each one, the risks, and what to cut first.
  The advisor is read-only and planned to stay that way: it never implements what
  it planned, and a file read an explorer can answer never goes to it.
- State lives on `.pi/orchestrator/board.md` in the project (added to
  `.git/info/exclude`), briefs in `.pi/orchestrator/briefs/`, surprises in
  `.pi/orchestrator/lessons.md`. A new session starts by reading them.
- Briefs carry goal, owned files, acceptance commands, a red gate, non-goals
  and the report format. Two concurrent workers never own the same file;
  otherwise one gets a git worktree.
- Workers never commit. Commits happen only when the user authorizes them, one
  per verified item, `git commit -- <paths>`.

The workers' prompt (`agents/worker.md`) holds them to the brief's scope and to
an evidence-only report: files changed, each acceptance command with its exit
code and output, the red-gate run, and what was not done.

## Costs and limits

- **Anthropic usage is billed, and every seat is a real model.** The child model
  and the advisor exist so that the two most common calls — read this, and plan
  this — do not run at the orchestrator's price. A seat that fails to resolve
  and falls back to the parent is a bill nobody chose, which is why the launcher
  refuses an unknown model rather than defaulting.
- **Children do not get the orchestrator's extensions.** A child discovers its
  own extensions under `.pi/extensions/` (the compaction guard included) and
  never sees the parent's `-e` flags, so nothing smuggles the Matrix channel or
  the loop into a spawn.
- **Everything a child reads goes to its provider.** The prompts forbid
  briefing a child to read credentials, and the extension denies children the
  Matrix channel.
- **The orchestrator's window is the bottleneck**, not the children's. Up to 15
  results arrive per wave, each capped on the way in (the compaction guard's cap
  and the fork's `result-cap.ts`), and the prompt tells the orchestrator to read
  diffs rather than files. Two levels of delegation mean up to 2 × the cap calls
  can be live at once — real concurrency, and a real bill.
- **The planner is expensive and is called deliberately.** The advisor runs on
  the strongest reasoner; consulting it on a question an explorer can answer is
  the way to pay planning prices for lookup work, so the orchestrator's prompt
  reserves it for planning and re-planning.

---

[← back to the README](../README.md)
