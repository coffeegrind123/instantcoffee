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
  ( cd "$REPO_ROOT" && COMPOSE_ENV_FILES="$env_files" docker compose "$@" )
}

# Read one key out of the merged env, honouring .env.local overrides.
env_get() {
  local key="$1" val=""
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

# Rewrite a key in .env in place, preserving comments and ordering.
env_set() {
  local key="$1" value="$2" file="$REPO_ROOT/.env"
  grep -qE "^[[:space:]]*${key}=" "$file" \
    || die "key '$key' not found in .env — refusing to append blindly"
  # '|' as the sed delimiter: values here are versions and tags, never paths.
  sed -i -E "s|^([[:space:]]*${key}=).*$|\1${value}|" "$file"
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

# --- registry ----------------------------------------------------------------
# Anonymous pull token for a public ghcr repository.
ghcr_token() {
  curl -fsSL "https://ghcr.io/token?scope=repository:$1:pull&service=ghcr.io" \
    | json_eval 'import sys,json; print(json.load(sys.stdin)["token"])'
}

GHCR_ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'

# Latest llama.cpp build number behind the floating :server-cuda tag.
# ggml-org stamps the build (e.g. b10200) into the index annotations, which is
# both cheaper and more reliable than paging the tag list.
llama_latest_build() {
  local repo="ggml-org/llama.cpp" tok
  tok="$(ghcr_token "$repo")"
  curl -fsSL -H "Authorization: Bearer $tok" -H "Accept: $GHCR_ACCEPT" \
    "https://ghcr.io/v2/$repo/manifests/server-cuda" \
    | json_eval 'import sys,json; print(json.load(sys.stdin).get("annotations",{}).get("org.opencontainers.image.version",""))'
}

# Digest of a given tag, for the lock file.
llama_tag_digest() {
  local repo="ggml-org/llama.cpp" tok
  tok="$(ghcr_token "$repo")"
  curl -fsSI -H "Authorization: Bearer $tok" -H "Accept: $GHCR_ACCEPT" \
    "https://ghcr.io/v2/$repo/manifests/$1" \
    | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:"{print $2}'
}

# Does this tag exist?
llama_tag_exists() {
  local repo="ggml-org/llama.cpp" tok code
  tok="$(ghcr_token "$repo")"
  code="$(curl -fsS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $tok" -H "Accept: $GHCR_ACCEPT" \
    "https://ghcr.io/v2/$repo/manifests/$1" 2>/dev/null || true)"
  [[ "$code" == "200" ]]
}

forge_latest_version() {
  curl -fsSL "https://pypi.org/pypi/forge-guardrails/json" \
    | json_eval 'import sys,json; print(json.load(sys.stdin)["info"]["version"])'
}

# Latest ik_llama.cpp release tag from the Thireus fork.
ik_latest_release() {
  curl -fsSL "https://api.github.com/repos/Thireus/ik_llama.cpp/releases/latest" \
    | json_eval 'import sys,json; print(json.load(sys.stdin).get("tag_name",""))'
}
