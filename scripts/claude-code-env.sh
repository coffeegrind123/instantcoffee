#!/usr/bin/env bash
#
# Point Claude Code at the local forge proxy. SOURCE this, don't execute it:
#
#   source scripts/claude-code-env.sh
#   claude
#
# To go back to the hosted Anthropic API, open a new shell (or unset the four
# ANTHROPIC_* variables below).
#
# Every variable set here was checked against the installed `claude` binary
# rather than taken from memory.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "This script must be sourced:  source ${BASH_SOURCE[0]}" >&2
  exit 1
fi

__qf_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

__qf_get() {
  local key="$1" val="" line
  for f in "$__qf_root/.env" "$__qf_root/.env.local"; do
    [[ -f "$f" ]] || continue
    line="$(grep -E "^[[:space:]]*${key}=" "$f" | tail -n1 || true)"
    [[ -n "$line" ]] && val="${line#*=}"
  done
  printf '%s' "$val"
}

__qf_port="$(__qf_get FORGE_PORT)"
__qf_alias="$(__qf_get MODEL_ALIAS)"

# Published ports bind to the host's loopback. Inside a container, the host is
# reachable as host.docker.internal instead.
if [[ -f /.dockerenv ]]; then
  __qf_host="host.docker.internal"
else
  __qf_host="localhost"
fi

export ANTHROPIC_BASE_URL="http://${__qf_host}:${__qf_port}"
# forge does not validate this; it just needs one credential to relocate. The
# backend is llama.cpp, which ignores it entirely.
export ANTHROPIC_AUTH_TOKEN="local"
export ANTHROPIC_MODEL="${__qf_alias}"
# Claude Code reaches for a small/fast model for background work. There is only
# one model here, so both point at it.
export ANTHROPIC_SMALL_FAST_MODEL="${__qf_alias}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${__qf_alias}"
# No point sending telemetry about a local model to a service this shell is no
# longer authenticated against.
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

echo "Claude Code -> ${ANTHROPIC_BASE_URL}  (model: ${ANTHROPIC_MODEL})"

unset __qf_root __qf_get __qf_port __qf_alias __qf_host
