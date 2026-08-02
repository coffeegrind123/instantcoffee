#!/usr/bin/env bash
#
# Run Harbor evaluation against the local qwen3.6-forge stack.
#
#   ./harbor-eval/adapter/run-local.sh                 # quick smoke (5 tasks, 1 attempt)
#   ./harbor-eval/adapter/run-local.sh --full          # full terminal-bench sweep
#   ./harbor-eval/adapter/run-local.sh --agent pi      # use pi.dev harness instead of Claude Code
#   ./harbor-eval/adapter/run-local.sh --agent both    # run both harnesses, compare
#   ./harbor-eval/adapter/run-local.sh --tasks 10      # run N tasks
#   ./harbor-eval/adapter/run-local.sh --dataset terminal-bench@2.0
#
# Prerequisites:
#   1. The forge stack must be running (./scripts/up.sh)
#   2. Harbor must be cloned and the forge adapter installed:
#        ./harbor-eval/adapter/install-into-harbor.sh ./harbor-eval
#
# Results land in:
#   harbor-eval/jobs/           Harbor job output
#   results/harbor-latest.json  Extracted summary
#   results/harbor-history.jsonl Append-only log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HARBOR_DIR="$REPO_ROOT/harbor-eval"
ADAPTER_DIR="$SCRIPT_DIR"

# ---- defaults ----
AGENT="claude"          # claude | pi | both
DATASET="terminal-bench@2.0"
N_TASKS="5"
N_CONCURRENT="1"
N_ATTEMPTS="1"
TIMEOUT_MULTIPLIER="3.0"
MAX_RETRIES="3"
INCLUDE_TASK=""
FULL_SWEEP=0
DRY_RUN=0

# ---- parse args ----
while [ $# -gt 0 ]; do
  case "$1" in
    --agent=*)     AGENT="${1#*=}" ;;
    --agent)       AGENT="$2"; shift ;;
    --dataset=*)   DATASET="${1#*=}" ;;
    --dataset)     DATASET="$2"; shift ;;
    --tasks=*)     N_TASKS="${1#*=}" ;;
    --tasks)       N_TASKS="$2"; shift ;;
    --concurrent=*) N_CONCURRENT="${1#*=}" ;;
    --concurrent)  N_CONCURRENT="$2"; shift ;;
    --attempts=*)  N_ATTEMPTS="${1#*=}" ;;
    --attempts)    N_ATTEMPTS="$2"; shift ;;
    --timeout=*)   TIMEOUT_MULTIPLIER="${1#*=}" ;;
    --timeout)     TIMEOUT_MULTIPLIER="$2"; shift ;;
    --include=*)   INCLUDE_TASK="${1#*=}" ;;
    --include)     INCLUDE_TASK="$2"; shift ;;
    --full)        FULL_SWEEP=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    -h|--help)
      sed -n '3,20p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
  shift
done

# Full sweep overrides
if (( FULL_SWEEP )); then
  N_TASKS=""                    # all tasks
  N_ATTEMPTS="3"
  N_CONCURRENT="1"              # keep low — one GPU, one slot
fi

# ---- preflight ----
if [ ! -f "$HARBOR_DIR/src/harbor/agents/factory.py" ]; then
  echo "ERROR: Harbor not found at $HARBOR_DIR" >&2
  echo "Clone it:  git clone https://github.com/harbor-framework/harbor.git $HARBOR_DIR" >&2
  exit 1
fi

# Ensure adapter is installed
if ! grep -q "FORGE_CLAUDE" "$HARBOR_DIR/src/harbor/models/agent/name.py" 2>/dev/null; then
  echo "--- Installing forge adapter into Harbor ---"
  bash "$SCRIPT_DIR/install-into-harbor.sh" "$HARBOR_DIR"
fi

# Resolve forge URL: prefer host.docker.internal when running inside Docker,
# localhost otherwise.
if [ -f /.dockerenv ] || grep -q docker /proc/1/cgroup 2>/dev/null; then
  FORGE_HOST="${FORGE_HOST:-host.docker.internal}"
else
  FORGE_HOST="${FORGE_HOST:-host.docker.internal}"
fi
FORGE_URL="${FORGE_URL:-http://${FORGE_HOST}:8081}"
FORGE_OPENAI_URL="${FORGE_OPENAI_URL:-http://${FORGE_HOST}:8081/v1}"

# ---- helpers ----
run_harbor() {
  local agent="$1"
  local model="$2"
  local label="$3"
  local extra_env="${4:-}"

  echo ""
  echo "============================================================"
  echo "  Harbor eval: $label"
  echo "  agent=$agent  model=$model  dataset=$DATASET"
  echo "  tasks=${N_TASKS:-all}  concurrent=$N_CONCURRENT  attempts=$N_ATTEMPTS"
  echo "  forge: $FORGE_URL"
  echo "============================================================"
  echo ""

  if (( DRY_RUN )); then
    echo "[DRY RUN] would execute:"
    echo "  cd $HARBOR_DIR && $extra_env uv run harbor run \\"
    echo "    --dataset $DATASET \\"
    echo "    --agent $agent \\"
    echo "    --model $model \\"
    echo "    --n-concurrent $N_CONCURRENT \\"
    echo "    --n-attempts $N_ATTEMPTS \\"
    echo "    --agent-timeout-multiplier $TIMEOUT_MULTIPLIER \\"
    echo "    --jobs-dir $HARBOR_DIR/jobs \\"
    echo "    ${N_TASKS:+--n-tasks $N_TASKS} \\"
    echo "    ${MAX_RETRIES:+--max-retries $MAX_RETRIES --retry-include ApiRateLimitError} \\"
    echo "    ${INCLUDE_TASK:+--include-task-name $INCLUDE_TASK}"
    return
  fi

  cd "$HARBOR_DIR"

  # Build args array
  ARGS=(
    run
    --dataset "$DATASET"
    --agent "$agent"
    --model "$model"
    --n-concurrent "$N_CONCURRENT"
    --n-attempts "$N_ATTEMPTS"
    --agent-timeout-multiplier "$TIMEOUT_MULTIPLIER"
    --jobs-dir "$HARBOR_DIR/jobs"
  )
  [ -n "$N_TASKS" ] && ARGS+=(--n-tasks "$N_TASKS")
  if [ -n "$MAX_RETRIES" ] && [ "$MAX_RETRIES" != "0" ]; then
    ARGS+=(--max-retries "$MAX_RETRIES" --retry-include ApiRateLimitError)
  fi
  [ -n "$INCLUDE_TASK" ] && ARGS+=(--include-task-name "$INCLUDE_TASK")

  # shellcheck disable=SC2086
  env $extra_env uv run harbor "${ARGS[@]}"
}

extract_results() {
  local label="$1"
  local results_file="$REPO_ROOT/results/harbor-${label}-latest.json"

  latest=$(ls -1dt "$HARBOR_DIR/jobs"/*/ 2>/dev/null | head -1 || true)
  if [ -z "$latest" ]; then
    echo "WARNING: no job directory found"
    return
  fi

  python3 -c "
import json, sys, os
from pathlib import Path

job_dir = Path('$latest')
results = {'label': '$label', 'job_dir': str(job_dir), 'tasks': []}

# Walk trials
for trial_dir in sorted(job_dir.glob('*/')):
    result_file = trial_dir / 'result.json'
    if not result_file.exists():
        continue
    try:
        data = json.loads(result_file.read_text())
        results['tasks'].append({
            'task': trial_dir.name,
            'reward': data.get('reward'),
            'score': data.get('score'),
            'passed': data.get('passed'),
            'duration_s': data.get('duration_s'),
        })
    except (json.JSONDecodeError, OSError):
        continue

# Summary stats
tasks = results['tasks']
if tasks:
    rewards = [t['reward'] for t in tasks if t['reward'] is not None]
    results['summary'] = {
        'tasks_completed': len(tasks),
        'mean_reward': sum(rewards) / len(rewards) if rewards else 0,
        'passed': sum(1 for t in tasks if t.get('passed')),
    }

os.makedirs('$REPO_ROOT/results', exist_ok=True)
with open('$results_file', 'w') as f:
    json.dump(results, f, indent=2)
print(f'Results saved to $results_file')
print(f'Tasks: {len(tasks)}, Mean reward: {results[\"summary\"][\"mean_reward\"]:.3f}, Passed: {results[\"summary\"][\"passed\"]}')
"
}

# ---- main ----
echo "forge URL:  $FORGE_URL"
echo "Harbor dir: $HARBOR_DIR"
echo ""

case "$AGENT" in
  claude)
    run_harbor "forge-claude" "forge/qwen3.6-27b" \
      "Claude Code → forge" \
      "ANTHROPIC_BASE_URL=$FORGE_URL ANTHROPIC_AUTH_TOKEN=local"
    extract_results "claude"
    ;;

  pi)
    # pi uses the OpenAI-compatible endpoint on forge.
    # Stock pi agent with openai provider — env vars forward automatically.
    run_harbor "pi" "openai/qwen3.6-27b" \
      "pi.dev → forge (OpenAI compat)" \
      "OPENAI_BASE_URL=$FORGE_OPENAI_URL OPENAI_API_KEY=local"
    extract_results "pi"
    ;;

  both)
    echo "=== Phase 1/2: Claude Code harness ==="
    run_harbor "forge-claude" "forge/qwen3.6-27b" \
      "Claude Code → forge" \
      "ANTHROPIC_BASE_URL=$FORGE_URL ANTHROPIC_AUTH_TOKEN=local"
    extract_results "claude"

    echo ""
    echo "=== Phase 2/2: pi.dev harness ==="
    run_harbor "pi" "openai/qwen3.6-27b" \
      "pi.dev → forge (OpenAI compat)" \
      "OPENAI_BASE_URL=$FORGE_OPENAI_URL OPENAI_API_KEY=local"
    extract_results "pi"

    # Side-by-side summary
    echo ""
    echo "=== Comparison ==="
    for label in claude pi; do
      f="$REPO_ROOT/results/harbor-${label}-latest.json"
      if [ -f "$f" ]; then
        python3 -c "
import json
d = json.load(open('$f'))
s = d.get('summary', {})
print(f\"  {d['label']:10s}  tasks={s.get('tasks_completed',0):>3}  reward={s.get('mean_reward',0):.3f}  passed={s.get('passed',0)}\")
"
      fi
    done
    ;;

  *)
    echo "ERROR: unknown agent '$AGENT'. Use 'claude', 'pi', or 'both'." >&2
    exit 1
    ;;
esac

echo ""
echo "done. jobs at: $HARBOR_DIR/jobs/"
