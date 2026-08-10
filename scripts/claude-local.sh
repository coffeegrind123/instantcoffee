#!/usr/bin/env bash
#
# Launch Claude Code against the local model, primed for it.
#
#   ./scripts/claude-local.sh                 start a session
#   ./scripts/claude-local.sh -c              any claude flag passes through
#   ./scripts/claude-local.sh --print-only    show the command instead of running it
#
# Unlike scripts/claude-code-env.sh (which only redirects the API), this also
# trims the request Claude Code builds, because on a 64K local window the
# context is the scarce resource — not the tokens/sec.
#
# Every flag and variable here was checked against the installed claude binary.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PRINT_ONLY=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--print-only" ]]; then PRINT_ONLY=1; else ARGS+=("$a"); fi
done

MODEL="$(env_get MODEL_ALIAS)"
PORT="$(env_get FORGE_PORT)"
[[ -f /.dockerenv ]] && HOST="host.docker.internal" || HOST="localhost"
BASE="http://${HOST}:${PORT}"

# --print-only is for inspecting the command, so it must work with nothing
# running. Only a real launch needs the CLI and a live proxy.
if (( ! PRINT_ONLY )); then
  command -v claude >/dev/null 2>&1 || die "the 'claude' CLI is not on PATH"
  # Refuse to launch against a proxy that is not up — otherwise the first failure
  # shows up as an opaque API error inside the TUI.
  if ! curl -fsS -m 5 -o /dev/null "${BASE}/health" 2>/dev/null; then
    die "forge is not answering at ${BASE} — start it with ./scripts/up.sh"
  fi
fi

# --- why each of these ------------------------------------------------------
# ANTHROPIC_BASE_URL      point the Anthropic Messages client at forge
# ANTHROPIC_AUTH_TOKEN    forge needs exactly one credential; the value is ignored
# ANTHROPIC_*_MODEL       one model serves every role; the name is cosmetic
# DISABLE_PROMPT_CACHING  cache_control is dropped translating to OpenAI anyway,
#                         so asking for it only adds blocks that go nowhere
# MAX_THINKING_TOKENS=0   Near-cosmetic here, and worth being precise about:
#                         forge's Anthropic->OpenAI converter forwards an
#                         allow-list (model, max_tokens, temperature, top_p,
#                         top_k, stop_sequences, tool_choice), so the `thinking`
#                         field is dropped and never reaches llama-server. It
#                         does NOT consume model context. Set to 0 only so the
#                         client stops requesting a feature the backend cannot
#                         honor. Qwen's actual thinking is controlled solely by
#                         REASONING_BUDGET in .env.
# API_TIMEOUT_MS          must outlast forge's own --backend-timeout (600s), or
#                         the client gives up on a request the server is still
#                         working on
# ..._SPAWN_DEPTH=1       subagents default to nesting 3 deep; each level is
#                         another full context on one GPU serving one slot
env_vars=(
  "ANTHROPIC_BASE_URL=${BASE}"
  "ANTHROPIC_AUTH_TOKEN=local"
  "ANTHROPIC_MODEL=${MODEL}"
  "ANTHROPIC_SMALL_FAST_MODEL=${MODEL}"
  "ANTHROPIC_DEFAULT_HAIKU_MODEL=${MODEL}"
  "DISABLE_PROMPT_CACHING=1"
  "MAX_THINKING_TOKENS=0"
  "API_TIMEOUT_MS=1800000"
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1"
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
)

claude_flags=(--model "${MODEL}")

# --strict-mcp-config with an empty config is the single biggest context win:
# it ignores every configured MCP server for this session. The ghidra server
# alone publishes ~245 tool schemas, which would eat the window before the
# first message.
if [[ "$(env_get CLAUDE_DISABLE_MCP)" == "1" ]]; then
  claude_flags+=(--strict-mcp-config --mcp-config '{"mcpServers":{}}')
  MCP_NOTE="MCP servers off"
else
  MCP_NOTE="MCP servers as configured"
fi

# Bash expands aliases only in interactive shells, so a `claude` alias in
# .bash_aliases has no effect from inside this script. Whatever it normally adds
# has to be replayed from .env, or the session would quietly start without it.
read -ra extra_args <<< "$(env_get CLAUDE_EXTRA_ARGS)"
(( ${#extra_args[@]} )) && claude_flags+=("${extra_args[@]}")

# Two things can want to append to the system prompt: the user's own file, and
# the THINK_LANG fragment. `claude --help` documents --append-system-prompt as
# taking one prompt and says nothing about repeating it, so they are joined into
# a single argument rather than passed twice and hoping the last one does not win.
appended=()

PROMPT_FILE="$(env_get CLAUDE_SYSTEM_PROMPT_FILE)"
PROMPT_FILE="${PROMPT_FILE/#\~/$HOME}"
if [[ -n "$PROMPT_FILE" ]]; then
  if [[ -r "$PROMPT_FILE" ]]; then
    appended+=("$(cat "$PROMPT_FILE")")
  else
    # Loud, because a silently missing system prompt changes how the agent
    # behaves without changing anything you can see.
    warn "CLAUDE_SYSTEM_PROMPT_FILE=$PROMPT_FILE is not readable — starting without it"
  fi
fi

# THINK_LANG goes last so its "answer in the user's language" rule is the most
# recent instruction in the prompt, not something an earlier file can override.
THINK_FILE="$(think_prompt_path)"
if [[ -n "$THINK_FILE" ]]; then
  appended+=("$(cat "$THINK_FILE")")
  THINK_NOTE=", thinking in $(env_get THINK_LANG)"
else
  THINK_NOTE=""
fi

if (( ${#appended[@]} )); then
  joined=""
  for chunk in "${appended[@]}"; do
    [[ -n "$joined" ]] && joined+=$'\n\n'
    joined+="$chunk"
  done
  claude_flags+=(--append-system-prompt "$joined")
fi

if (( PRINT_ONLY )); then
  printf 'env'
  printf ' %q' "${env_vars[@]}"
  printf ' claude'
  printf ' %q' "${claude_flags[@]}"
  printf '\n'
  exit 0
fi

echo "Claude Code -> ${BASE}  (model: ${MODEL}, ${MCP_NOTE}${THINK_NOTE})"
# ANTHROPIC_API_KEY is cleared rather than overridden: forge rejects a request
# carrying two credentials instead of choosing one.
exec env -u ANTHROPIC_API_KEY "${env_vars[@]}" claude "${claude_flags[@]}" "${ARGS[@]}"
