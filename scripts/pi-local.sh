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
CTX="$(env_get CTX_SIZE)"
MAX_TOKENS="$(env_get PI_MAX_TOKENS)"
: "${MAX_TOKENS:=8192}"

PORT="$(env_get FORGE_PORT)"

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
MODEL="$MODEL" BASE_URL="${BASE}/v1" CTX="$CTX" MAX_TOKENS="$MAX_TOKENS" \
MODELS_JSON="$MODELS_JSON" \
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
            # prompt grows every turn. Comes from PI_MAX_TOKENS so it cannot
            # drift from the -n backstop in LLAMA_EXTRA_FLAGS.
            "maxTokens": int(os.environ["MAX_TOKENS"]),
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
pi_flags=(--provider forge --model "$MODEL")

# pi discovers AGENTS.md / CLAUDE.md by walking parent directories. Loaded by
# default: an agent that ignores the conventions file in the repo it is editing
# costs more in rework than the tokens save. PI_CONTEXT_FILES=0 passes -nc.
CTX_FILES_NOTE="context files off"
if [[ "$(env_get PI_CONTEXT_FILES)" == "1" ]]; then
  CTX_FILES_NOTE="context files on"
else
  pi_flags+=(-nc)
fi

# MCP servers, reached as a CLI rather than as MCP. --skill is additive and takes
# an absolute path, so the skill travels with the repo instead of being installed
# into ~/.pi — nothing outside this checkout is touched, and it still applies when
# pi is started in another project's directory.
MCP_NOTE=""
if [[ "$(env_get MCP2CLI_ENABLED)" == "1" ]]; then
  SKILL_DIR="$REPO_ROOT/skills/mcp-tools"
  [[ -r "$SKILL_DIR/SKILL.md" ]] \
    || die "MCP2CLI_ENABLED=1 but $SKILL_DIR/SKILL.md is missing"
  pi_flags+=(--skill "$SKILL_DIR")
  MCP_NOTE=", mcp via cli"
  # Both of these are said now rather than mid-session, where the model would
  # read a slow or failing install as "the tool does not work" and quietly stop
  # reaching for it.
  if ! command -v uv >/dev/null 2>&1; then
    warn "uv is not on PATH — ./scripts/mcp.sh cannot install mcp2cli when the model reaches for it."
    warn "Install uv, or set MCP2CLI_ENABLED=0 to stop offering the skill."
  elif [[ ! -x "${HOME}/.local/bin/mcp2cli" ]] && ! command -v mcp2cli >/dev/null 2>&1; then
    dim "mcp2cli is not installed yet — the first MCP call will install it (~30s)."
    dim "Do it now instead with: ./scripts/mcp.sh --install"
  fi
fi

# Replayed from .env because bash does not expand aliases inside scripts.
EXTRA_ARGS="$(env_get PI_EXTRA_ARGS)"
if [[ -n "$EXTRA_ARGS" ]]; then
  read -r -a extra <<< "$EXTRA_ARGS"
  pi_flags+=("${extra[@]}")
fi

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

# --- keep pi current ---------------------------------------------------------
# pi ships often and the stack is only ever tested against the current release.
# Checked at most once per PI_UPDATE_INTERVAL_H hours (a stamp file), because a
# registry round trip on every launch is latency you would feel and a network
# dependency a local-model stack should not have.
#
# Fails SOFT, always: no npm, no network, a registry hiccup — warn and launch on
# what is installed. An agent session must never be blocked by an update check.
if [[ "$(env_get PI_AUTO_UPDATE)" == "1" ]]; then
  STAMP="${HOME}/.pi/.last-update-check"
  INTERVAL_H="$(env_get PI_UPDATE_INTERVAL_H)"; : "${INTERVAL_H:=24}"
  AGE_H=$(( INTERVAL_H + 1 ))
  [[ -f "$STAMP" ]] && AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$STAMP" 2>/dev/null || echo 0) ) / 3600 ))
  if (( AGE_H >= INTERVAL_H )); then
    if command -v npm >/dev/null 2>&1; then
      CUR="$(pi --version 2>/dev/null | tr -d ' ')"
      LATEST="$(timeout 20 npm view @earendil-works/pi-coding-agent version 2>/dev/null | tr -d ' ')"
      mkdir -p "$(dirname "$STAMP")" && touch "$STAMP"
      if [[ -n "$LATEST" && "$LATEST" != "$CUR" ]]; then
        info "Updating pi ${CUR:-?} -> ${LATEST}"
        if timeout 300 npm install -g --ignore-scripts @earendil-works/pi-coding-agent >/dev/null 2>&1; then
          ok "pi $(pi --version 2>/dev/null)"
        else
          warn "pi update failed — continuing on ${CUR:-the installed version}"
        fi
      fi
    else
      warn "PI_AUTO_UPDATE=1 but npm is not on PATH — skipping the update check"
    fi
  fi
fi

# forge has to answer before pi starts, or the first request fails inside pi's
# UI where the cause is much harder to see.
curl -fsS -m 5 -o /dev/null "${BASE}/health" 2>/dev/null \
  || die "forge is not answering at ${BASE} — start it with ./scripts/up.sh"

echo "pi -> ${BASE}  (model: ${MODEL}, ${CTX_FILES_NOTE}${THINK_NOTE}${MCP_NOTE})"
exec pi "${pi_flags[@]}" "${ARGS[@]}"
