#!/usr/bin/env bash
#
# Run Harbor evaluation against the local qwen3.6-forge stack, with pi.
#
#   ./harbor-adapter/run-local.sh                 # smoke run (5 tasks, 1 attempt)
#   ./harbor-adapter/run-local.sh --full          # every task, 3 attempts
#   ./harbor-adapter/run-local.sh --tasks 10      # run N tasks
#   ./harbor-adapter/run-local.sh --dataset terminal-bench@2.0
#   ./harbor-adapter/run-local.sh --dry-run       # print the command, run nothing
#
# Prerequisites:
#   1. The forge stack must be running (./scripts/up.sh)
#   2. Harbor must be cloned:
#        git clone https://github.com/harbor-framework/harbor.git harbor-eval
#
# No adapter is installed into Harbor. pi speaks OpenAI-completions to forge and
# Harbor's stock `pi` agent already supports the `openai` provider.
#
# Set FORGE_PORT=8787 to run the same sweep through headroom instead. The output
# file does not record which path was used, so keep those numbers apart.
#
# Results land in:
#   harbor-eval/jobs/               Harbor job output
#   results/harbor-pi-latest.json   Extracted summary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARBOR_DIR="$REPO_ROOT/harbor-eval"

# ---- defaults ----
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
    -h|--help)     sed -n '3,25p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# Full sweep overrides. n-concurrent stays at 1: one GPU, one slot.
if (( FULL_SWEEP )); then
  N_TASKS=""
  N_ATTEMPTS="3"
  N_CONCURRENT="1"
fi

# ---- preflight ----
if [ ! -f "$HARBOR_DIR/src/harbor/agents/factory.py" ]; then
  echo "ERROR: Harbor not found at $HARBOR_DIR" >&2
  echo "Clone it:  git clone https://github.com/harbor-framework/harbor.git $HARBOR_DIR" >&2
  exit 1
fi

# Harbor runs each trial in its own container, so the stack is always reachable
# as the Docker host rather than as localhost.
FORGE_HOST="${FORGE_HOST:-host.docker.internal}"
FORGE_PORT="${FORGE_PORT:-8081}"
MODEL_ID="${MODEL_ID:-qwen3.6-27b}"
BASE_URL="http://${FORGE_HOST}:${FORGE_PORT}/v1"

echo "base URL:   $BASE_URL"
echo "Harbor dir: $HARBOR_DIR"
[ "$FORGE_PORT" != "8081" ] && echo "NOTE: not the default forge port — is this a headroom run?"
echo ""
echo "============================================================"
echo "  Harbor eval: pi -> forge"
echo "  model=openai/${MODEL_ID}  dataset=$DATASET"
echo "  tasks=${N_TASKS:-all}  concurrent=$N_CONCURRENT  attempts=$N_ATTEMPTS"
echo "============================================================"
echo ""

ARGS=(
  run
  --dataset "$DATASET"
  --agent pi
  --model "openai/${MODEL_ID}"
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

if (( DRY_RUN )); then
  echo "[DRY RUN] would execute:"
  echo "  cd $HARBOR_DIR && \\"
  echo "    OPENAI_BASE_URL=$BASE_URL OPENAI_API_KEY=local \\"
  echo "    uv run harbor ${ARGS[*]}"
  exit 0
fi

cd "$HARBOR_DIR"
OPENAI_BASE_URL="$BASE_URL" OPENAI_API_KEY=local uv run harbor "${ARGS[@]}"

# ---- extract ----
latest="$(ls -1dt "$HARBOR_DIR/jobs"/*/ 2>/dev/null | head -1 || true)"
if [ -z "$latest" ]; then
  echo "WARNING: no job directory found" >&2
  exit 0
fi

RESULTS_FILE="$REPO_ROOT/results/harbor-pi-latest.json"
JOB_DIR="$latest" OUT_FILE="$RESULTS_FILE" python3 - <<'PY'
import json, os
from pathlib import Path

job_dir = Path(os.environ["JOB_DIR"])
out_file = Path(os.environ["OUT_FILE"])
results = {"label": "pi", "job_dir": str(job_dir), "tasks": []}

for trial_dir in sorted(job_dir.glob("*/")):
    result_file = trial_dir / "result.json"
    if not result_file.exists():
        continue
    try:
        data = json.loads(result_file.read_text())
    except (json.JSONDecodeError, OSError):
        continue
    results["tasks"].append({
        "task": trial_dir.name,
        "reward": data.get("reward"),
        "score": data.get("score"),
        "passed": data.get("passed"),
        "duration_s": data.get("duration_s"),
    })

tasks = results["tasks"]
rewards = [t["reward"] for t in tasks if t["reward"] is not None]
results["summary"] = {
    "tasks_completed": len(tasks),
    "mean_reward": (sum(rewards) / len(rewards)) if rewards else 0,
    "passed": sum(1 for t in tasks if t.get("passed")),
}

out_file.parent.mkdir(parents=True, exist_ok=True)
out_file.write_text(json.dumps(results, indent=2))
s = results["summary"]
print(f"Results saved to {out_file}")
print(f"Tasks: {s['tasks_completed']}, mean reward: {s['mean_reward']:.3f}, "
      f"passed: {s['passed']}")
PY

echo ""
echo "done. jobs at: $HARBOR_DIR/jobs/"
