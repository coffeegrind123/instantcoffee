#!/usr/bin/env bash
#
# Run the pi coding agent (pi.dev) against the local model.
#
#   ./scripts/pi-local.sh                 start a session
#   ./scripts/pi-local.sh -p "summarize"  any pi flag passes through
#   ./scripts/pi-local.sh --install-only  write ~/.pi/agent/models.json and stop
#   ./scripts/pi-local.sh --print-only    show the command without running it
#
# pi has no built-in notion of "an OpenAI-compatible proxy" as a flag — custom
# providers are declared in ~/.pi/agent/models.json. This script generates that
# file from .env so the model id, context window and port cannot drift apart
# from what the stack is actually serving.
#
# Deliberately NOT using pi's own /llama integration: that makes pi manage its
# own llama.cpp router and models, which would bypass forge entirely and lose
# every guardrail this repo exists to provide.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

INSTALL_ONLY=0; PRINT_ONLY=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --install-only) INSTALL_ONLY=1 ;;
    --print-only)   PRINT_ONLY=1 ;;
    *)              ARGS+=("$a") ;;
  esac
done

MODEL="$(env_get MODEL_ALIAS)"
PORT="$(env_get FORGE_PORT)"
CTX="$(env_get CTX_SIZE)"

# Published ports bind to the host's loopback; inside a container the host is
# reachable as host.docker.internal instead.
[[ -f /.dockerenv ]] && HOST="host.docker.internal" || HOST="localhost"
BASE="http://${HOST}:${PORT}"

PI_DIR="${HOME}/.pi/agent"
MODELS_JSON="${PI_DIR}/models.json"

# --- generate models.json ----------------------------------------------------
# Merges into any existing file rather than overwriting it — pi keeps other
# providers here too, and clobbering someone's whole model config to add one
# local entry would be rude.
mkdir -p "$PI_DIR"
MODEL="$MODEL" BASE_URL="${BASE}/v1" CTX="$CTX" MODELS_JSON="$MODELS_JSON" \
python3 - <<'PY'
import json, os, pathlib

path = pathlib.Path(os.environ["MODELS_JSON"])
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text() or "{}")
    except json.JSONDecodeError:
        raise SystemExit(f"{path} exists but is not valid JSON — refusing to overwrite it")

providers = data.setdefault("providers", {})
providers["forge"] = {
    "baseUrl": os.environ["BASE_URL"],
    # forge's OpenAI endpoint is the short path: pi -> forge -> llama.cpp.
    # Going via anthropic-messages would add a translation hop that drops
    # cache_control and thinking for no benefit here.
    "api": "openai-completions",
    # pi hides models it considers unauthenticated, so a keyless local server
    # still needs a placeholder. forge relocates exactly one credential and
    # llama.cpp ignores it.
    "apiKey": "local",
    "compat": {
        # llama.cpp's chat templates do not know the `developer` role, and
        # `reasoning_effort` is an OpenAI-ism it does not implement. pi's docs
        # call this out for exactly this class of server.
        "supportsDeveloperRole": False,
        "supportsReasoningEffort": False,
    },
    "models": [
        {
            "id": os.environ["MODEL"],
            "name": "Qwen3.6-27B local (forge)",
            "contextWindow": int(os.environ["CTX"]),
            # Well under contextWindow on purpose: with --no-context-shift a
            # request that would overflow fails loudly, and an agentic loop's
            # prompt grows every turn.
            "maxTokens": 16384,
            "input": ["text"],
            # Left false deliberately. Qwen reasons server-side under
            # --reasoning-budget and forge keeps it out of history, so there is
            # nothing for pi to drive. Set true only if you want pi's thinking
            # UI and have checked it round-trips.
            "reasoning": False,
        }
    ],
}
path.write_text(json.dumps(data, indent=2) + "\n")
path.chmod(0o600)
print(f"wrote {path}")
PY

if (( INSTALL_ONLY )); then
  dim "Provider 'forge' installed. Check with: pi --list-models"
  exit 0
fi

# --- launch ------------------------------------------------------------------
# -nc skips AGENTS.md/CLAUDE.md discovery. On a 64K local window those files are
# a real fraction of the budget, and pi walks parent directories to find them.
# Drop the flag when you want the project's conventions loaded.
pi_flags=(--provider forge --model "$MODEL" -nc)

# THINK_LANG fragment, if one is selected. pi's --help documents
# --append-system-prompt as taking "text or file contents" and as repeatable,
# but the file is read here anyway so the same bytes reach both clients.
THINK_FILE="$(think_prompt_path)"
THINK_NOTE=""
if [[ -n "$THINK_FILE" ]]; then
  pi_flags+=(--append-system-prompt "$(cat "$THINK_FILE")")
  THINK_NOTE=", thinking in $(env_get THINK_LANG)"
fi

if (( PRINT_ONLY )); then
  printf 'pi'; printf ' %q' "${pi_flags[@]}"; printf '\n'
  exit 0
fi

command -v pi >/dev/null 2>&1 \
  || die "pi is not installed — npm install -g --ignore-scripts @earendil-works/pi-coding-agent"

curl -fsS -m 5 -o /dev/null "${BASE}/health" 2>/dev/null \
  || die "forge is not answering at ${BASE} — start it with ./scripts/up.sh"

echo "pi -> ${BASE}  (model: ${MODEL}, context files off${THINK_NOTE})"
exec pi "${pi_flags[@]}" "${ARGS[@]}"
