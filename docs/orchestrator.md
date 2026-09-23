# Orchestrator mode

The local model coordinates; remote subagents execute. One pi session on the
27B plans the work, writes briefs, dispatches up to 15 subagents on DeepSeek
Flash in parallel, re-runs every check they claim, reads their diffs and keeps
the state on a board that survives compaction and new sessions.

```
 you ─► pi (Qwen3.8-27B, local, 1 llama slot)          the orchestrator
         │  briefs: .pi/orchestrator/briefs/<id>.md
         │  board:  .pi/orchestrator/board.md
         ├─► worker   ┐  deepseek/deepseek-flash, up to SUBAGENT_MAX_CONCURRENT
         │    └─► helper (SubAgent)   at once per level; extra spawns queue;
         ├─► explorer │  each has its own window
         │    └─► explorer helper      helpers cannot spawn further
         └─► ...      ┘
```

Same shape as the `~/codex` setup (GLM orchestrator, DeepSeek subagents), with
the local model as the orchestrator.

## Turning it on

1. `DEEPSEEK_API_KEY=...` in `.env.local` (gitignored). For pi in a container,
   the container checkout's `.env.local`.
2. In `.env`: `ORCHESTRATOR=1`. `SUBAGENTS_ENABLED=1` must stay on.
3. Start pi as usual (`./scripts/pi-local.sh` or `./scripts/pi-container.sh`).
   The launch line ends `orchestrator (15x deepseek/deepseek-flash, depth 2)`.

It is pi-side only: llama is untouched, so no restart and nothing in
`modes/`, which switches the llama regime and is orthogonal to this.

| key | default | |
|---|---|---|
| `ORCHESTRATOR` | `0` | the switch |
| `SUBAGENT_MODEL` | `deepseek/deepseek-flash` | `provider/model-id` as `pi --list-models` shows it |
| `SUBAGENT_MAX_CONCURRENT` | `15` | 1-15, per level |
| `SUBAGENT_MAX_DEPTH` | empty = `2` here | `1` = only the orchestrator spawns; `2` = its subagents may spawn helpers |
| `DEEPSEEK_API_KEY` | — | `.env.local` only |

The launcher refuses to start rather than degrade: no key, a model pi does not
list (pi's built-in `deepseek-flash` needs pi >= 0.87), a cap out of range, or
the subagent extension not loaded.

## What the launcher sets up

- **The model and the cap** go into `~/.pi/agent/orchestrator-mode.json`,
  named by `SUBAGENT_MODE_CONFIG`. The subagent extension reads it as its
  SESSION layer — above every config file — and every reset in `/agents`
  returns to it, so clearing an override cannot put children back on the llama
  slot. The operator's `subagents-lite.json` is never written.
  Concurrency: `deepseek: N`, `forge: 1`.
- **Agent types** `worker` and `explorer` from `prompts/orchestrator/agents/`,
  through `SUBAGENT_MODE_AGENTS_DIR`: above the operator's global agents, below
  a project's own `.pi/agents/`.
- **The orchestrator prompt**, `prompts/orchestrator/main.md`, appended to the
  system prompt with the cap and model filled in. The delegation nudge
  (`prompts/delegate.md`) is left out: it says agents share one slot, which is
  the opposite of this mode.
- **No answer judge.** `SUBAGENT_VERIFY` is forced to 0: the orchestrator
  re-runs every claimed check itself, which a one-turn judge reading the answer
  cannot match. (Where the judge does run, it now runs on the child's model.)
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

## What the orchestrator does

The prompt is the operator's standing agent prompt with an Orchestration
section built on the orchestrator-worker / coordinator-implementor-verifier
pattern:

- It does not implement; workers do. It verifies by re-running each worker's
  acceptance commands and reading the diff. Exit codes decide.
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

- **Data leaves the machine.** Every file a child reads goes to DeepSeek. The
  prompts forbid briefing a child to read credentials; the subagent extension
  already denies children the Matrix channel.
- **DeepSeek usage is billed**; `/agents` shows per-agent cost when enabled.
  At depth 2, up to 30 calls can be live at once.
- **Children bypass forge.** Forge fronts llama only, so its guardrails apply
  to the orchestrator's turns, not the children's.
- **The orchestrator's window is the bottleneck**, not the children's.
  Measured: 15 explorer results (median ~5.9k characters) cost 26k tokens and
  13 s of prefill — a quarter of the 98k window per full-width wave. A
  finished background result is capped on the way in (the compaction guard's
  cap, `vendor/pi-subagents-lite/src/spawn/result-cap.ts`); the prompt tells it
  to read diffs rather than files.
