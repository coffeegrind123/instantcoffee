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
  # Drop only the marker lines that no longer sit above a key of ours — a marker
  # is written per key, so removing them all would orphan the ones still in use.
  python3 - "$LOCAL_ENV" <<'PYCLEAN'
import sys
path = sys.argv[1]
lines = open(path).read().split("\n")
out = []
for i, line in enumerate(lines):
    if line.startswith("# --- set by scripts/capture.sh"):
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if not nxt.startswith(("FORGE_BACKEND_URL=", "CAPTURE_POSITION=", "CAPTURE_UPSTREAM=")):
            # local_env_set writes a blank separator before each marker. Drop
            # that one line and no others: stripping every trailing blank
            # instead would eat the blank line the user's own file ends with,
            # and the round trip has to be byte-identical or it is not a round
            # trip.
            if out and not out[-1].strip():
                out.pop()
            continue
    out.append(line)
open(path, "w").write("\n".join(out))
PYCLEAN
}

capture_url() { printf 'http://capture:8082'; }

cmd_on() {
  # The first cut of this took "$@" and ignored it, so `capture.sh on --position
  # client-forge` started a model-facing tape and said nothing. An argument that
  # is accepted and discarded is worse than one that is refused.
  local position="" upstream=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --position) position="${2:-}"; shift 2 || die "--position needs a value" ;;
      --position=*) position="${1#*=}"; shift ;;
      --upstream) upstream="${2:-}"; shift 2 || die "--upstream needs a value" ;;
      --upstream=*) upstream="${1#*=}"; shift ;;
      *) die "capture.sh on: unknown argument '$1' (expected --position or --upstream)" ;;
    esac
  done
  [[ -z "$position" ]] && position="$(env_get CAPTURE_POSITION)"
  : "${position:=forge-llama}"

  # The position decides the upstream AND which end moves. Getting these two out
  # of step produces a tape labelled as one thing and holding the other, which is
  # the one failure the whole design is built to prevent.
  case "$position" in
    forge-llama)
      : "${upstream:=$(env_get CAPTURE_UPSTREAM)}"; : "${upstream:=http://llama:8080}" ;;
    client-forge)
      : "${upstream:=http://forge:8081}" ;;
    *)
      [[ -n "$upstream" ]] || die \
        "position '$position' is not one this script knows how to wire (forge-llama, client-forge) — pass --upstream too" ;;
  esac

  echo "==> starting the recorder   position=${position}  upstream=${upstream}"
  echo "    tape -> $(env_get CAPTURES_DIR) on the host, /captures in the container"
  local_env_set CAPTURE_POSITION "$position"
  local_env_set CAPTURE_UPSTREAM "$upstream"
  compose --profile capture up -d --build capture || die "capture container failed to start"

  if [[ "$position" == "client-forge" ]]; then
    # The CLIENT moves here, not the backend. Repointing forge as well would put
    # the recorder on both sides of itself.
    local port; port="$(env_get CAPTURE_PORT)"; : "${port:=8082}"
    echo
    cmd_status
    cat <<NOTE

Recording the CLIENT side. forge is untouched and still talks to llama directly.
Point pi at the recorder instead of at forge:

    PI_BASE=http://localhost:${port}      (pi reads \$(agent_dir)/models.json —
                                           see scripts/pi-local.sh)

This tape is what the agent ASKED FOR. It does NOT show forge's rewrites, so it
cannot feed a fidelity measurement on its own; take it alongside a forge-llama
tape when you want the pair.
Turn it off with:  ./scripts/capture.sh off
NOTE
    return 0
  fi

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
  local_env_unset CAPTURE_POSITION
  local_env_unset CAPTURE_UPSTREAM
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
  running="$(docker ps --filter name=instantcoffee-capture --format '{{.Status}}' 2>/dev/null)"
  printf 'capture container  %s\n' "${running:-not running}"
  if [[ -n "$running" ]]; then
    # /capture/health is answered by the recorder itself and never forwarded, so
    # this says nothing about whether llama is up — deliberately.
    docker exec instantcoffee-capture python -c "
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
  import-pi)  shift; [[ $# -ge 1 ]] || die "usage: capture.sh import-pi <transcript.jsonl>..."
              # The transcripts live on the host; the container sees them at
              # /pi-sessions. Rewrite here so the command in the README is the
              # command that works — before this, the documented invocation
              # failed with FileNotFoundError on a path that plainly exists.
              HOST_SESSIONS="$(agent_dir)/sessions"
              MAPPED=()
              for a in "$@"; do
                case "$a" in
                  "${HOST_SESSIONS}"/*) MAPPED+=("/pi-sessions/${a#"${HOST_SESSIONS}/"}") ;;
                  /pi-sessions/*)       MAPPED+=("$a") ;;
                  *) die "capture.sh import-pi: '$a' is not under ${HOST_SESSIONS}, which is the only directory mounted into the container (see PI_SESSIONS_DIR in .env)" ;;
                esac
              done
              sessions_run --import-pi "${MAPPED[@]}" ;;
  self-test)  shift
              python3 "${REPO_ROOT}/scripts/test_capture_proxy.py" || exit 1
              python3 "${REPO_ROOT}/scripts/capture_sessions.py" --self-test ;;
  ""|-h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)          die "unknown subcommand '${1}' — run without arguments for usage" ;;
esac
