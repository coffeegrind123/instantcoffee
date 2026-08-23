#!/usr/bin/env bash
#
# Record real workstreams, and read the tape back.
#
#   ./scripts/capture.sh on            start the recorder and repoint forge at it
#   ./scripts/capture.sh status        what is recording, where, and how much
#   ./scripts/capture.sh off           repoint forge back at llama, stop recording
#
#   ./scripts/capture.sh index                       what workstreams are on the tape
#   ./scripts/capture.sh show s7f3a91                one workstream, turn by turn
#   ./scripts/capture.sh export s7f3a91 --out /captures/corpus/deep.txt
#   ./scripts/capture.sh import-pi <transcript.jsonl>
#
# WHY. context/design/inference-divergence-and-this-stack.md §7 item 2: every
# remaining fidelity experiment on this stack — the q8_0-vs-f16 KLD run above
# all — is gated on having a REAL captured workstream, because the article's own
# strongest secondary finding is that top-1 disagreement is prompt-dependent and
# synthetic filler will understate it.
#
# `on` and `off` recreate the forge container. That is seconds, and it costs
# nothing warm: the KV cache lives in llama, which does not move. Any request in
# flight through forge at that moment IS dropped, so do not flip it mid-turn.
#
# The override lives in .env.local (gitignored, machine-local, and read by
# `compose` here through COMPOSE_ENV_FILES) rather than in the committed .env,
# so a capture session cannot be committed by accident.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker

LOCAL_ENV="${REPO_ROOT}/.env.local"
MARKER="# --- set by scripts/capture.sh; remove with 'capture.sh off' ---"

local_env_set() {
  local key="$1" value="$2"
  local_env_unset "$key"
  { [[ -s "$LOCAL_ENV" ]] && printf '\n'; printf '%s\n%s=%s\n' "$MARKER" "$key" "$value"; } >> "$LOCAL_ENV"
}

local_env_unset() {
  local key="$1"
  [[ -f "$LOCAL_ENV" ]] || return 0
  # Drop the marker line and the key line, leave everything else byte-identical.
  # .env.local holds the HF token on this machine; a blunt rewrite is not on.
  sed -i -E "/^${key}=/d" "$LOCAL_ENV"
  sed -i -E "\|^# --- set by scripts/capture\.sh|d" "$LOCAL_ENV"
}

capture_url() { printf 'http://capture:8082'; }

cmd_on() {
  local upstream position
  upstream="$(env_get CAPTURE_UPSTREAM)"; : "${upstream:=http://llama:8080}"
  position="$(env_get CAPTURE_POSITION)"; : "${position:=forge-llama}"
  echo "==> starting the recorder   position=${position}  upstream=${upstream}"
  echo "    tape -> $(env_get CAPTURES_DIR) on the host, /captures in the container"
  compose --profile capture up -d --build capture || die "capture container failed to start"

  echo "==> repointing forge at the recorder (this recreates the forge container)"
  local_env_set FORGE_BACKEND_URL "$(capture_url)"
  compose up -d forge || die "forge failed to come back up; run 'capture.sh off' to restore"

  echo
  cmd_status
  cat <<'NOTE'

Recording. Everything pi sends through forge from now on lands on the tape.
Turn it off with:  ./scripts/capture.sh off
NOTE
}

cmd_off() {
  echo "==> repointing forge back at llama (this recreates the forge container)"
  local_env_unset FORGE_BACKEND_URL
  compose up -d forge || die "forge failed to come back up"
  echo "==> stopping the recorder (the tape is kept)"
  compose --profile capture stop capture >/dev/null 2>&1 || true
  echo
  cmd_status
}

cmd_status() {
  local backend running
  backend="$(env_get FORGE_BACKEND_URL)"; : "${backend:=http://llama:8080}"
  printf 'forge backend      %s' "$backend"
  if [[ "$backend" == "$(capture_url)" ]]; then printf '   <- RECORDING\n'; else printf '   (recorder not in the path)\n'; fi
  printf 'tape directory     %s\n' "$(env_get CAPTURES_DIR)"
  running="$(docker ps --filter name=qwen38-capture --format '{{.Status}}' 2>/dev/null)"
  printf 'capture container  %s\n' "${running:-not running}"
  if [[ -n "$running" ]]; then
    # /capture/health is answered by the recorder itself and never forwarded, so
    # this says nothing about whether llama is up — deliberately.
    docker exec qwen38-capture python -c "
import json,urllib.request
d=json.load(urllib.request.urlopen('http://127.0.0.1:8082/capture/health',timeout=4))
print(f\"  tape           {d['tape']}\")
print(f\"  recorded       {d['counts'].get('recorded',0)} lines, {d['bytes_written']} bytes\")
print(f\"  stopped?       {d['recording_stopped']}\")
print(f\"  traffic        {d['traffic']}\")
" 2>/dev/null || echo "  (health endpoint did not answer)"
  fi
}

sessions_run() { compose --profile tools run --rm --build sessions "$@"; }

case "${1:-}" in
  on)         shift; cmd_on "$@" ;;
  off)        shift; cmd_off "$@" ;;
  status)     shift; cmd_status "$@" ;;
  index)      shift; sessions_run --index "$@" ;;
  show)       shift; [[ $# -ge 1 ]] || die "usage: capture.sh show <session-id>"; sessions_run --show "$@" ;;
  export)     shift; [[ $# -ge 1 ]] || die "usage: capture.sh export <session-id> --out FILE"; sessions_run --export "$@" ;;
  import-pi)  shift; [[ $# -ge 1 ]] || die "usage: capture.sh import-pi <transcript.jsonl>..."; sessions_run --import-pi "$@" ;;
  self-test)  shift
              python3 "${REPO_ROOT}/scripts/test_capture_proxy.py" || exit 1
              python3 "${REPO_ROOT}/scripts/capture_sessions.py" --self-test ;;
  ""|-h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)          die "unknown subcommand '${1}' — run without arguments for usage" ;;
esac
