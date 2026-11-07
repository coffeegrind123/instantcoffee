# Anthropic mode

Anthropic mode keeps the instantcoffee pi workflow and switches the inference
backend from local llama.cpp/forge to the hosted Anthropic Messages API.

## What changes

| | local | Anthropic |
| --- | --- | --- |
| pi provider | `forge` | `anthropic` |
| session model | selected Qwen GGUF | `claude-opus-5-5` |
| subagent model | `deepseek/deepseek-flash` in orchestrator mode | `anthropic/claude-haiku-5-5` |
| advisor | inherits the child model | `anthropic/claude-fable-5-1` |
| window | 96K / 128K / 192K by local mode | 1,000,000 |
| compaction | context-derived | fires around 280K, keeps around 150K |
| prompt cache | llama KV/prefix cache | Anthropic ephemeral cache, 300 s / 3600 s tiers |
| reasoning-language prompt | mode-specific | off |
| local containers | llama, forge, observe | observe only, if enabled |
| team solve | unavailable | `/team-solve`, durable roles checked by a command or a judge |

Everything pi-side remains: `/stack`, `/anthropic`, `/loop`, `/prinny`,
`/persona`, browser tools, Ovis, the observe dashboard, subagents, and the
orchestrator.

## Configure the key

The key belongs in gitignored `.env.local`, never tracked `.env`:

```bash
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' >> .env.local
```

The launcher exports it only to the pi process. Generated `models.json` names
`$ANTHROPIC_API_KEY`; it never contains the secret.

## Switch to hosted mode

From a shell:

```bash
cd /path/to/the/instantcoffee-checkout
./scripts/mode.sh anthropic
```

From a running pi session:

```text
/anthropic on
```

or:

```text
/stack mode anthropic
```

The switch rewrites the hosted keys in `.env` and regenerates pi's provider and
cache/compaction settings. It never starts, stops, or recreates llama or forge.

Provider selection happens when pi starts. Quit and relaunch pi after the
switch:

```bash
cd ~/my-project
/path/to/the/instantcoffee-checkout/scripts/pi-local.sh
```

Do not pin mode keys in `.env.local` unless every launch should use those
values. They win over `.env`; `mode.sh` refuses a switch it cannot make fully
effective and names every conflicting override.

## Inspect it

```text
/anthropic status
/stack status
/stack env ANTHROPIC
/stack env PI_CACHE
```

`/anthropic enable`, `/anthropic disable`, and `/anthropic local` are aliases
for `on`, `off`, and `off`.

`/stack env` redacts API keys, tokens, passwords, and secrets.
`stack_status` is also available to the model as a read-only tool.

## Durable team solve

Anthropic mode loads `/team-solve`, a pi-native port of the GVS5H/Memdoor
method. It runs a direct attempt, then fresh planner, ideator, implementation,
review, judge, manager, and audit processes against the current workspace. A
verification command decides when there is one; the planner settles one when
none is given, and with nothing to run the review and a fresh judge decide:

```text
/team-solve run "Implement the missing feature" --check "pytest -q"
/team-solve run "Write the migration guide" --until "every breaking change has a before/after example"
/team-solve status
/team-solve logs --role solve
/team-solve check
/team-solve resume
/team-solve stop
```

The command returns after starting a detached run. The default budget is 72
hours, so it can survive several hours between model calls or a long test
suite. Set `TEAM_SOLVE_ENABLED=0` in `.env.local` to omit the command.

The coding profile uses Fable for planning, management, and final audit; Opus
for implementation and repair; Sonnet for independent proposals and review;
and Haiku for routing, failure triage, and token-limit cutoff summaries. The
manager persists a curated task list, and resume cache keys include the
check/diff evidence each role read. An `everyday` profile routes routine coding
to Sonnet, while multi-day runs promote planning, management, and audit to
Fable. Research, writing, general, and high-volume profiles move the other
seats to match their workload. See
**[team-solve.md](team-solve.md)** for the full contract, budgets, artifacts,
and model overrides.

The launcher refreshes pi's model catalog before checking the main model. A
failed refresh is non-fatal. The main model is always probed; when
`ORCHESTRATOR=1`, the resolved child and advisor seats are probed too. Any
missing model stops the launch with its id and the refresh command.

## The local-only commands

In Anthropic mode these commands report that they apply only to the local
backend and do not invoke Docker:

```text
/stack up
/stack down
/stack restart [llama|forge]
/stack smoke
/stack bench
/stack logs [service]  (defaults to llama; local compose services only)
/stack slots save|restore|erase [id]
```

This is deliberate. There is no local model process behind the hosted provider,
so probing or mutating Docker would test the wrong system.

`/stack mode`, `/stack env`, `/stack set`, `/stack help`, `/anthropic`, and
`/stack status` remain active for configuration and inspection. `/stack set`
refuses to put credentials in `.env` and refuses to change `STACK_BACKEND`
without applying the rest of a mode.

## Return to local mode

The mode switch records the last local profile in `STACK_LAST_LOCAL_MODE`.

```bash
./scripts/mode.sh local
```

or:

```text
/anthropic off
```

This restores that local mode, the local team settings snapshot, and the forge
provider. It removes Anthropic cache-warming and model-override state from
pi's settings, but does not start or recreate llama. Relaunch pi, then inspect
or start the local stack:

```text
/stack
/stack up
```

To restore a different local profile, choose it explicitly:

```bash
./scripts/mode.sh coding
./scripts/mode.sh prose --restart llama
```

## Container sessions

`scripts/pi-container.sh` forwards `ANTHROPIC_API_KEY` when the host exports it
or places it in `.env.local`. `--status` reports whether the host has it and
whether the next hosted launch will forward it; docker exec environments are
per-process, so a separate status exec cannot inspect a live session's secret.
No value is printed. In hosted mode it reports the backend, resolved models, and
cache policy instead of treating forge being absent as a failure. The host
checkout's `STACK_BACKEND` is forwarded as authoritative, so a drifted container
checkout cannot silently launch the other backend.
