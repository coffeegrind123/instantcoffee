# forge → Harbor agent adapter

Lets [Harbor](https://github.com/harbor-framework/harbor) evaluate the local
qwen3.6-forge stack with the pi.dev harness.

## No adapter needed

pi talks OpenAI-completions to forge's `/v1` endpoint, and Harbor's stock `pi`
agent supports the `openai` provider natively. There is nothing to subclass and
nothing to patch into a Harbor checkout — set two environment variables:

```bash
OPENAI_BASE_URL=http://host.docker.internal:8081/v1 \
OPENAI_API_KEY=local \
harbor run --agent pi --model openai/qwen3.6-27b --dataset terminal-bench@2.0
```

`run-local.sh` wraps that with this repo's defaults and extracts a summary.

> There used to be a `forge-claude` adapter here, subclassing Harbor's
> `ClaudeCode` agent to keep `ANTHROPIC_AUTH_TOKEN` as a Bearer token (stock
> Harbor collapses every token into `x-api-key`, which forge rejects) and to
> force `--strict-mcp-config`. It went with the rest of the Claude Code support
> — the stack targets pi only, and pi needs none of it.

## Usage

```bash
# Dry-run: print the harbor command without executing it
./harbor-adapter/run-local.sh --dry-run

# Smoke run: 5 tasks, 1 attempt
./harbor-adapter/run-local.sh

# Full sweep: every task, 3 attempts
./harbor-adapter/run-local.sh --full
```

Prerequisites:

1. The stack is running — `./scripts/up.sh`
2. Harbor is cloned at `harbor-eval/`:
   `git clone https://github.com/harbor-framework/harbor.git harbor-eval`

Results land in:

| Path | What |
|---|---|
| `harbor-eval/jobs/` | Harbor's own job output |
| `results/harbor-pi-latest.json` | Extracted summary |
