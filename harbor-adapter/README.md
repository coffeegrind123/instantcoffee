# forge → Harbor agent adapter

Lets [Harbor](https://github.com/harbor-framework/harbor) evaluate the local
qwen3.6-forge stack with both Claude Code and pi.dev harnesses.

## Files

| File | Purpose |
|---|---|
| `forge_claude.py` | Claude Code adapter — preserves Bearer auth for forge |
| `install-into-harbor.sh` | Registers `forge-claude` agent in a Harbor checkout |
| `run-local.sh` | Local eval runner (replaces the GitHub Actions workflow) |

## Install

```bash
# One-time: register the forge-claude agent in Harbor
./harbor-eval/adapter/install-into-harbor.sh ./harbor-eval
```

This patches two files in the Harbor checkout:
1. `src/harbor/models/agent/name.py` — adds `FORGE_CLAUDE = "forge-claude"` to the `AgentName` enum
2. `src/harbor/agents/factory.py` — registers the class in `AgentFactory._AGENT_MAP`

## forge-claude vs stock claude-code

The forge proxy authenticates with `Authorization: Bearer <token>`. Stock Harbor's
`ClaudeCode` agent collapses all tokens into `ANTHROPIC_API_KEY`, which becomes an
`x-api-key` header — forge rejects that. The `forge-claude` adapter preserves
`ANTHROPIC_AUTH_TOKEN` as a Bearer token.

| Thing | stock claude-code | forge-claude |
|---|---|---|
| Auth header | `x-api-key` | `Authorization: Bearer` |
| Model name | `provider/model` sent verbatim | `provider/` prefix stripped |
| Model aliases | Only mirrored with custom base URL | Always mirrored |
| MCP install | Allowed | Skipped by default |

## pi.dev — no adapter needed

pi talks OpenAI-completions to forge's `/v1` endpoint. Harbor's stock `pi` agent
supports the `openai` provider natively — just set `OPENAI_BASE_URL` and
`OPENAI_API_KEY`:

```bash
OPENAI_BASE_URL=http://host.docker.internal:8081/v1 \
OPENAI_API_KEY=local \
harbor run --agent pi --model openai/qwen3.6-27b --dataset terminal-bench@2.0
```

## Quick test

```bash
# Dry-run to verify everything is wired correctly
./harbor-eval/adapter/run-local.sh --dry-run --agent both

# Smoke test (5 tasks, Claude Code)
./harbor-eval/adapter/run-local.sh

# Compare harnesses
./harbor-eval/adapter/run-local.sh --agent both --tasks 20
```

## Network

Harbor spawns Docker containers for each task. Inside those containers, forge is
reached at `host.docker.internal:8081`. The runner script detects whether it's
running inside a container and sets the host accordingly.

Override: `FORGE_HOST=192.168.1.50 ./harbor-eval/adapter/run-local.sh`
