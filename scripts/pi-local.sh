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
        # Both still False on 3.8, but the reason changed and is worth writing
        # down, because the obvious reading of the 3.8 release notes says
        # otherwise.
        #
        # The MODEL supports both: the unsloth 3.8 template adds developer-role
        # handling, and `reasoning_effort` is a real template variable with four
        # levels. The ENGINE is what does not. llama.cpp only began forwarding an
        # API-level `reasoning_effort` field to the template in commit 7e4c0a9
        # (2026-08-14, "chat: pass reasoning_effort to template"), and the newest
        # published CUDA server image at migration time was server-cuda-b10423,
        # cut 2026-08-13 — a day earlier. So a client that sends the field gets
        # it silently dropped.
        #
        # Until an image ships with that commit, effort is set server-side via
        # --chat-template-kwargs from REASONING_EFFORT in .env, which applies to
        # the whole server rather than per request. Flip these to True only after
        # checking that the running build actually honours them.
        "supportsDeveloperRole": False,
        "supportsReasoningEffort": False,
    },
    "models": [
        {
            "id": os.environ["MODEL"],
            "name": "Qwen3.8-27B local (forge)",
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

# /stack, loaded by absolute path for the same reason --skill is below.
#
# Auto-discovery of .pi/extensions/ is scoped to the project pi was STARTED in,
# and it also requires that project to be trusted. Both bite: started in another
# project the extension is simply absent, and started here without -a it is
# silently skipped — in which case `/stack` is not a command, so pi forwards the
# text to the model and you get an invented answer about stack files rather than
# an error. Verified both ways, 2026-08-13.
#
# -e is not additive to discovery in the harmful sense: loading the same path
# twice (once discovered here, once explicit) registers ONE `/stack`, not
# `/stack:1` and `/stack:2` — pi dedupes by path. Checked before relying on it.
STACK_EXT="$REPO_ROOT/.pi/extensions/stack.ts"
STACK_NOTE=""
if [[ -r "$STACK_EXT" ]]; then
  pi_flags+=(-e "$STACK_EXT")
  STACK_NOTE=", /stack"
else
  warn "$STACK_EXT is missing — /stack will not be available this session."
fi

# /loop comes from vendor/pi-loop-mode — a fork of pi-loop-mode@2.5.4 that this
# repo carries and edits (see vendor/pi-loop-mode/FORK.md). It is loaded by
# absolute path, like /stack above, so the same code runs whatever directory pi
# was started in, and so the fix travels with the checkout instead of living in
# a user-global npm install that the next `pi update` would quietly replace.
#
# The extension needs no node_modules: its only non-relative import is a
# `import type` of pi's own types, which is erased before the file ever runs.
LOOP_DIR="$REPO_ROOT/vendor/pi-loop-mode"
LOOP_NOTE=""
if [[ -r "$LOOP_DIR/extensions/index.ts" ]]; then
  pi_flags+=(-e "$LOOP_DIR/extensions/index.ts")
  # Skill and prompt templates ship in the same package; without them /loop works
  # but the model loses the guidance the loop skill exists to give it.
  [[ -d "$LOOP_DIR/skills/loop-skill" ]] && pi_flags+=(--skill "$LOOP_DIR/skills/loop-skill")
  [[ -d "$LOOP_DIR/prompts" ]] && pi_flags+=(--prompt-template "$LOOP_DIR/prompts")
  LOOP_NOTE=", /loop"
else
  warn "$LOOP_DIR is missing — /loop will not exist this session."
fi

# An npm install of the upstream package registers a SECOND /loop from a different
# path (pi only dedupes identical paths), and the two would fight over the same
# session state. Say so rather than letting the operator debug it live.
if pi list 2>/dev/null | grep -q "pi-loop-mode@"; then
  warn "The upstream pi-loop-mode npm package is still installed in pi's user settings."
  warn "It shadows vendor/pi-loop-mode and reintroduces the context-recovery bug it forks around."
  warn "Remove it with: pi uninstall npm:pi-loop-mode"
  LOOP_NOTE=", /loop (conflicting npm install)"
fi

# /prinny comes from vendor/prinny-channel — the Matrix channel, converted from
# the Claude Code plugin of the same name (see vendor/prinny-channel/FORK.md).
# Loaded by absolute path for the same reasons as /stack and /loop above.
#
# It needs no node_modules either: its only bare imports are typebox and pi's own
# packages, which pi resolves from its own module root. The Matrix layer is a
# CHILD process whose ~105MB of dependencies live outside this repo, under
# ~/.pi/agent/channels/prinny/runtime — built once by `/prinny prepare`.
#
# Opt-in, because it logs a bot into a homeserver and makes this session
# addressable from the internet. PRINNY_ENABLED=0 (the default) leaves it out
# entirely rather than loading it in a dormant state, so there is nothing to
# misconfigure until you ask for it.
PRINNY_DIR="$REPO_ROOT/vendor/prinny-channel"
PRINNY_NOTE=""
if [[ "$(env_get PRINNY_ENABLED)" == "1" ]]; then
  if [[ -r "$PRINNY_DIR/extensions/index.ts" ]]; then
    pi_flags+=(-e "$PRINNY_DIR/extensions/index.ts")
    # The skills explain which /prinny subcommand to run; without them the model
    # is left to invent an answer about a command it cannot see.
    for skill in prinny-access prinny-configure; do
      [[ -d "$PRINNY_DIR/skills/$skill" ]] && pi_flags+=(--skill "$PRINNY_DIR/skills/$skill")
    done
    PRINNY_NOTE=", /prinny"

    # Said now rather than mid-session. An unbuilt runtime means the channel
    # never comes up, and the only clue is a line in a log file the operator has
    # no reason to open.
    PRINNY_STATE="${PRINNY_STATE_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/channels/prinny}"
    if [[ ! -f "$PRINNY_STATE/runtime/dist/server.js" ]]; then
      dim "The prinny channel runtime is not built — run /prinny prepare once (~1 min)."
      PRINNY_NOTE=", /prinny (runtime not built)"
    elif [[ ! -f "$PRINNY_STATE/.env" ]]; then
      dim "The prinny channel has no credentials — run /prinny configure."
      PRINNY_NOTE=", /prinny (not configured)"
    fi
  else
    warn "$PRINNY_DIR is missing — /prinny will not exist this session."
  fi
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
#
# TWO probes, not one, because forge 0.9 split them and conflating them produces
# a lie. /forge/health is forge's own liveness. /health is the BACKEND's
# readiness, forwarded — it returns 502 for the whole ~25 minute cold load of a
# model that is loading perfectly normally. Probing only /health (which is what
# this did until 2026-08-15) reports "forge is not answering" when forge is up
# and healthy and the only thing happening is that the weights are still being
# read off disk.
curl -fsS -m 5 -o /dev/null "${BASE}/forge/health" 2>/dev/null \
  || die "forge is not answering at ${BASE} — start it with ./scripts/up.sh"

curl -fsS -m 5 -o /dev/null "${BASE}/health" 2>/dev/null \
  || die "forge is up but the model is not loaded yet at ${BASE} — llama-server is
still reading the GGUF. Watch it with ./scripts/logs.sh llama, or measure real
progress with:
  docker exec ${LLAMA_CONTAINER:-qwen38-llama} sh -c 'grep ^rchar /proc/7/io'
A cold load of a 17.9 GB quant takes ~25 minutes on this box."

echo "pi -> ${BASE}  (model: ${MODEL}, ${CTX_FILES_NOTE}${THINK_NOTE}${MCP_NOTE}${STACK_NOTE}${LOOP_NOTE}${PRINNY_NOTE})"
exec pi "${pi_flags[@]}" "${ARGS[@]}"
