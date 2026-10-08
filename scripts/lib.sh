#!/usr/bin/env bash
# Shared helpers. Sourced by every script in this directory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

# --- output ------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m';  C_OFF=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_DIM=""; C_OFF=""
fi

info()  { printf '%s==>%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()    { printf '%s  ok%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn()  { printf '%swarn%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()   { printf '%serr %s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
dim()   { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "'$c' is required but not on PATH"
  done
}

# --- compose -----------------------------------------------------------------
# Always run compose from the repo root with .env, plus .env.local when present
# so machine-specific overrides never have to be committed.
compose() {
  local env_files=".env"
  [[ -f "$REPO_ROOT/.env.local" ]] && env_files=".env,.env.local"
  ( cd "$REPO_ROOT" && COMPOSE_ENV_FILES="$env_files" OBSERVE_GIT_HASH="$(observe_git_hash)" \
      docker compose "$@" )
}

# --- observe -------------------------------------------------------------------
# The dashboard is built from the vendor/instantcoffee-observe submodule. Its
# short hash tags the image (instantcoffee/observe:<hash>) and is baked in as
# the build's GIT_HASH, so moving the submodule is what triggers a rebuild.
OBSERVE_DIR="$REPO_ROOT/vendor/instantcoffee-observe"

observe_git_hash() {
  git -C "$OBSERVE_DIR" rev-parse --short HEAD 2>/dev/null || echo local
}

# Where the dashboard answers from this machine. 0.0.0.0 is a bind address,
# not one to browse to.
observe_url() {
  local host port
  host="$(env_get BIND_ADDR)"; [[ -z "$host" || "$host" == 0.0.0.0 ]] && host=127.0.0.1
  port="$(env_get OBSERVE_PORT)"
  printf 'http://%s:%s' "$host" "${port:-4981}"
}

# A clone made without --recurse-submodules has an empty directory here, and
# compose would fail on a build context with no Dockerfile.
ensure_observe_checkout() {
  [[ -f "$OBSERVE_DIR/Dockerfile" ]] && return 0
  info "Fetching the observe dashboard (vendor/instantcoffee-observe)"
  git -C "$REPO_ROOT" submodule update --init vendor/instantcoffee-observe \
    || die "could not check out vendor/instantcoffee-observe"
}

# Read one key out of the merged env, honouring .env.local overrides.
#
# An exported variable wins over both files, so a per-invocation override works
# the way anyone would expect it to:
#     PI_CONTEXT_FILES=1 ./scripts/pi-local.sh
# It previously did not — the value was read from .env only and the override was
# ignored in silence, which is the worst way for a knob to not work. This also
# matches how docker compose already resolves the same names.
env_get() {
  local key="$1" val=""
  if [[ -n "${!key+x}" ]]; then printf '%s' "${!key}"; return 0; fi
  for f in "$REPO_ROOT/.env" "$REPO_ROOT/.env.local"; do
    [[ -f "$f" ]] || continue
    local line
    line="$(grep -E "^[[:space:]]*${key}=" "$f" | tail -n1 || true)"
    [[ -n "$line" ]] && val="${line#*=}"
  done
  # Strip surrounding quotes and trailing comment/whitespace.
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

# `docker exec -e NAME` arguments, one per line, for every stack key exported in
# the caller — so env_get's per-invocation override survives a hop into the pi
# container (scripts/test_container_env.py). Keys are whatever .env, .env.local
# and .env.local.example name, commented or not. `-e NAME` with no value makes
# docker copy it from its own environment: a secret is never on a command line.
env_forward_args() {
  local f key
  local -A seen=()
  for f in "$REPO_ROOT/.env" "$REPO_ROOT/.env.local" "$REPO_ROOT/.env.local.example"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r key; do
      [[ -n "${seen[$key]:-}" ]] && continue
      seen[$key]=1
      printenv "$key" >/dev/null || continue
      printf -- '-e\n%s\n' "$key"
    done < <(sed -nE 's/^[[:space:]]*#?[[:space:]]*([A-Z][A-Z0-9_]*)=.*/\1/p' "$f")
  done
}

# Rewrite a key in .env in place, preserving comments and ordering.
env_set() {
  local key="$1" value="$2" file="$REPO_ROOT/.env"
  grep -qE "^[[:space:]]*${key}=" "$file" \
    || die "key '$key' not found in .env — refusing to append blindly"
  # '|' as the sed delimiter: values here are versions and tags, never paths.
  sed -i -E "s|^([[:space:]]*${key}=).*$|\1${value}|" "$file"
}

# --- pi's agent directory ----------------------------------------------------
# AO10, twenty-fifth pass. Where pi keeps models.json, settings.json, sessions/
# and channels/. `pi-local.sh` asked this question in FOUR places and answered it
# two ways: `PI_DIR` at the top ignored the override while the prinny state path
# and the MCP adapter path honoured it. On a relocated install the launcher then
# wrote `models.json` and `settings.json` into a directory pi does not read, so
# pi started with **no `forge` provider at all** — the local model unreachable,
# which is the one thing this script exists to arrange.
#
# The rule is pi's own `getAgentDir()` (`dist/config.js`), and it is the same
# rule `vendor/pi-subagents-lite/src/agent-dir.ts` writes for the TypeScript
# side, kept in step deliberately — see AN7 and AO7. Note the guard is a bare
# truthiness test, not `-n` after trimming: a value of "  " is a relative
# directory to pi, and where the two disagree pi is right by definition, because
# pi is the one that writes the files.
agent_dir() {
  local override="${PI_CODING_AGENT_DIR:-}"
  if [[ -n "$override" ]]; then
    # pi runs the value through `expandTildePath`, so a value that works for pi
    # has to work here. `~` and `~/…` only; anything else is left alone.
    if [[ "$override" == "~" ]]; then
      printf '%s' "$HOME"
    elif [[ "$override" == "~/"* ]]; then
      printf '%s/%s' "$HOME" "${override#\~/}"
    else
      printf '%s' "$override"
    fi
    return 0
  fi
  printf '%s/.pi/agent' "$HOME"
}

# --- json --------------------------------------------------------------------
# Prefer host python3; fall back to a throwaway container so the scripts work on
# a machine that has Docker but no Python.
json_eval() {
  local code="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "$code"
  else
    docker run --rm -i python:3.13-slim python -c "$code"
  fi
}

# --- container age -----------------------------------------------------------
# Seconds since a container last started, or empty if it is not running.
#
# WHY IT IS RECORDED ON EVERY ARM. On 2026-09-04 three llama arms on IDENTICAL
# weights at effectively identical load gave wall-clock prefill 1567.8, 1686.8
# and 1923.8 t/s. The variable was how long the container had been up: ~6 min,
# 8.75 min, ~40 min. The engine's own counter moved ~10% and the server path
# another ~90 t/s on top, and inside a fresh run the per-round trend RISES --
# which is precisely what the bench's single discarded warm-up round cannot fix.
# A throughput number whose container age is unknown is not comparable to one
# with a different age, so the age stops being an assumption and becomes a field.
container_age_s() {
  local name="$1" started
  started="$(docker inspect -f '{{.State.StartedAt}}' "$name" 2>/dev/null)" || return 0
  [[ -n "$started" ]] || return 0
  local epoch
  epoch="$(date -d "$started" +%s 2>/dev/null)" || return 0
  echo $(( $(date +%s) - epoch ))
}

# Hold until a container has been up at least N seconds. Returns 0 immediately
# when N is 0 or the container is not running -- an arm that cannot find its
# container is a different failure, and this is not the place to raise it.
wait_container_age() {
  local name="$1" want="${2:-0}" label="${3:-arm}" meta="${4:-}"
  if [[ "$want" -le 0 ]]; then return 0; fi
  local age
  age="$(container_age_s "$name")"
  if [[ -z "$age" ]]; then return 0; fi
  if [[ "$age" -ge "$want" ]]; then
    return 0
  fi
  info "warm-up hold [$label]: $name is ${age}s old, waiting for ${want}s"
  while [[ -n "$age" && "$age" -lt "$want" ]]; do
    sleep $(( want - age < 15 ? want - age : 15 ))
    age="$(container_age_s "$name")"
  done
  ok "warm-up hold [$label]: $name now ${age}s old"
  if [[ -n "$meta" ]]; then
    echo "warmup_hold_$label=waited_to=${age}s want=${want}s" >> "$meta"
  fi
  return 0
}
