#!/usr/bin/env bash
#
# Ovis in the pi container: a web and phone client for pi sessions that run in
# herdr panes (github.com/devswha/ovis, bundled at /opt/ovis by Dockerfile.pi).
#
#   ./scripts/ovis.sh start      start herdr and the Ovis server (idempotent)
#   ./scripts/ovis.sh stop       stop the Ovis server; herdr and its panes stay
#   ./scripts/ovis.sh status     what is running, and where
#   ./scripts/ovis.sh token      print the access token (creating it if needed)
#   ./scripts/ovis.sh enabled    exit 0 when OVIS_ENABLED is on
#   ./scripts/ovis.sh run [-w DIR] [-- <pi-local.sh args>]
#                                pi in a new herdr pane, attached to this terminal
#
# Runs INSIDE the container. On the host, use `./scripts/pi-container.sh --ovis`,
# which execs `run` in there, and `--status`, which reports this script's status.
#
# OVIS_ENABLED (default 1) decides whether `start` does anything; the container
# start script calls `start` on every boot. Ovis only sees pi when pi runs in a
# herdr pane, which is what `run` arranges. Detach from a pane with Ctrl+B then
# Q: pi keeps running, and Ovis keeps showing it.
#
# Access: Ovis listens on 127.0.0.1:7318 inside the container, behind a relay
# on 0.0.0.0:7317 (scripts/ovis_forward.py), because Docker delivers a published
# port to the container's own address and Ovis shows a "reachable on your
# network" banner for any non-loopback bind. pi-container.sh publishes 7317 on
# the host's 127.0.0.1 only. Every request except
# /api/health and the page itself needs the token (measured 2026-11-01: 401
# without it or with a wrong one). Telemetry and self-update are always off.
#
# OVIS_TOKEN=off runs it with no token, so the page opens without a sign-in.
# Then anything that reaches the port gets in and can type into pi, until a
# device is paired: every program on the host, every container (through
# host.docker.internal), and a web page that rebinds its own name to
# 127.0.0.1. This container mounts the docker socket, so that is the Docker VM.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OVIS_DIR="${OVIS_DIR:-/opt/ovis}"
HERDR="$OVIS_DIR/bin/herdr"
BUN="$OVIS_DIR/bin/bun"
RUN_DIR="${OVIS_RUN_DIR:-/tmp/ovis}"
LOG="$RUN_DIR/ovis.log"
SUPERVISOR_PID="$RUN_DIR/supervisor.pid"
SERVER_PID="$RUN_DIR/server.pid"
FORWARD_PID="$RUN_DIR/forward.pid"
# Where Ovis itself listens; the relay owns OVIS_CONTAINER_PORT.
OVIS_INTERNAL_PORT=7318
TOKEN_FILE="${OVIS_TOKEN_FILE:-$HOME/.config/ovis/token}"
# `pi` on the herdr server's PATH, so a pi started in a pane, or by Ovis, goes
# through pi-local.sh. See scripts/ovis-shims/pi.
SHIM_DIR="$REPO_ROOT/scripts/ovis-shims"
# What a pane runs. Overridable so scripts/test_ovis.py can run a launch script.
PI_LOCAL="${OVIS_PI_LOCAL:-$REPO_ROOT/scripts/pi-local.sh}"
LOG_MAX_BYTES=$(( 10 * 1024 * 1024 ))
HEALTH_URL="http://127.0.0.1:${OVIS_CONTAINER_PORT}/api/health"
# herdr's server only starts behind a client with a sized terminal; headless,
# that client runs under `script`. Measured 2026-11-01.
HERDR_COLS=200
HERDR_ROWS=50

usage() { sed -n '3,26p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; }

in_container() {
  [[ "${PI_AGENT_CONTAINER:-}" == "1" ]] \
    || die "ovis.sh runs inside the pi container — on the host use ./scripts/pi-container.sh --ovis"
}

have_bundle() { [[ -x "$HERDR" && -x "$BUN" && -f "$OVIS_DIR/server/index.ts" ]]; }

alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null; }

# --- the token ---------------------------------------------------------------
# OVIS_TOKEN from the env files wins. Otherwise one is generated once and kept
# on the home mount, mode 0600, so it survives --recreate and never sits in a
# tracked file or on a command line.
# OVIS_TOKEN=off (any case): no token at all, and none is generated.
auth_off() { [[ "$(env_get OVIS_TOKEN | tr '[:upper:]' '[:lower:]')" == off ]]; }

token() {
  auth_off && return 0
  local t; t="$(env_get OVIS_TOKEN)"
  if [[ -n "$t" ]]; then printf '%s' "$t"; return 0; fi
  if [[ ! -s "$TOKEN_FILE" ]]; then
    ( umask 077
      mkdir -p "$(dirname "$TOKEN_FILE")"
      od -An -tx1 -N24 /dev/urandom | tr -d ' \n' > "$TOKEN_FILE" )
  fi
  tr -d '[:space:]' < "$TOKEN_FILE"
}

# --- herdr -------------------------------------------------------------------
herdr_up() {
  "$HERDR" status 2>/dev/null | awk '/^server:/{s=1; next} s && /status:/{print $2; exit}' | grep -qx running
}

start_herdr() {
  herdr_up && return 0
  # PATH is the herdr SERVER's, and every pane inherits it. `9>&-`: herdr
  # outlives the supervisor by design, and with the supervisor's lock open it
  # held that lock forever, so every later supervisor's flock failed in silence
  # and Ovis never came back after a stop (2026-11-01).
  # SHELL: unset in this container, and herdr then gives every pane /bin/sh,
  # which has no bracketed paste, so text pasted from Ovis arrived as
  # `^[[200~...` and ran as a command (2026-11-01).
  SHELL=/bin/bash PATH="$SHIM_DIR:$PATH" setsid script -qfc \
    "stty cols $HERDR_COLS rows $HERDR_ROWS; exec '$HERDR'" /dev/null </dev/null >/dev/null 2>&1 9>&- &
  local i
  for i in $(seq 1 30); do
    herdr_up && return 0
    sleep 0.5
  done
  return 1
}

# --- the supervisor ----------------------------------------------------------
# One per container (flock). Restarts the server when it exits, with a backoff
# that resets after a run longer than a minute, and re-reads OVIS_ENABLED each
# time so `OVIS_ENABLED=0` plus `stop` is final.
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

rotate_log() {
  [[ -f "$LOG" ]] || return 0
  (( $(stat -c %s "$LOG") > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
  return 0
}

supervise() {
  exec 9>"$RUN_DIR/supervisor.lock"
  flock -n 9 || exit 0
  echo $$ > "$SUPERVISOR_PID"
  local child="" backoff=2 started ran rc tok
  trap '[[ -n "$child" ]] && kill "$child" 2>/dev/null; alive "$FORWARD_PID" && kill "$(cat "$FORWARD_PID" 2>/dev/null)" 2>/dev/null; rm -f "$SUPERVISOR_PID" "$SERVER_PID" "$FORWARD_PID"; exit 0' TERM INT

  while ovis_enabled; do
    rotate_log
    if ! start_herdr; then
      log "herdr did not start; retrying in ${backoff}s"
      sleep "$backoff"; backoff=$(( backoff * 2 > 60 ? 60 : backoff * 2 ))
      continue
    fi
    if ! alive "$FORWARD_PID"; then
      python3 "$REPO_ROOT/scripts/ovis_forward.py" 0.0.0.0 "$OVIS_CONTAINER_PORT" \
        127.0.0.1 "$OVIS_INTERNAL_PORT" >> "$LOG" 2>&1 9>&- &
      echo $! > "$FORWARD_PID"
    fi
    tok="$(token)"
    started=$(date +%s)
    log "starting Ovis ($(cat "$OVIS_DIR/bundle.json" 2>/dev/null))"
    # Ovis reads its token from OVIS_TOKEN alone, and empty or unset means
    # none (server/index.ts:209), so OVIS_TOKEN=off is an unset variable here.
    ( cd "$OVIS_DIR" && \
      if [[ -n "$tok" ]]; then export OVIS_TOKEN="$tok"; else unset OVIS_TOKEN; fi && \
      HOST=127.0.0.1 PORT="$OVIS_INTERNAL_PORT" \
      OVIS_TELEMETRY=0 OVIS_AUTO_UPDATE=0 NO_OPEN_BROWSER=1 OVIS_NO_OPEN=1 \
      OVIS_HERDR_BIN="$HERDR" PATH="$SHIM_DIR:$PATH" \
      exec "$BUN" server/index.ts ) >> "$LOG" 2>&1 9>&- &
    child=$!
    echo "$child" > "$SERVER_PID"
    rc=0; wait "$child" || rc=$?
    child=""
    ran=$(( $(date +%s) - started ))
    if (( ran > 60 )); then backoff=2; else backoff=$(( backoff * 2 > 60 ? 60 : backoff * 2 )); fi
    log "Ovis exited rc=$rc after ${ran}s; restarting in ${backoff}s"
    sleep "$backoff"
  done
  log "OVIS_ENABLED is off; supervisor exiting"
  alive "$FORWARD_PID" && kill "$(cat "$FORWARD_PID" 2>/dev/null)" 2>/dev/null
  rm -f "$SUPERVISOR_PID" "$SERVER_PID" "$FORWARD_PID"
}

healthy() { curl -fsS -m 2 -o /dev/null "$HEALTH_URL" 2>/dev/null; }

# The HOST side of the published port, which is the address a browser uses.
url() {
  local port; port="$(env_get OVIS_PORT)"
  printf 'http://127.0.0.1:%s/' "${port:-$OVIS_CONTAINER_PORT}"
}

start() {
  local quiet=0; [[ "${1:-}" == "--quiet" ]] && quiet=1
  in_container
  if ! ovis_enabled; then
    (( quiet )) || dim "Ovis:    off (OVIS_ENABLED=0)"
    return 0
  fi
  if ! have_bundle; then
    # Soft: an image from before Ovis must still start and run pi.
    warn "Ovis is enabled but not in this image (${OVIS_DIR}) — rebuild pi-agent and --recreate"
    return 0
  fi
  mkdir -p "$RUN_DIR"
  token >/dev/null
  if ! alive "$SUPERVISOR_PID"; then
    setsid "$REPO_ROOT/scripts/ovis.sh" supervise </dev/null >/dev/null 2>&1 &
  fi
  local i
  for i in $(seq 1 60); do
    healthy && break
    sleep 0.5
  done
  if ! healthy; then
    warn "Ovis did not answer within 30 s — see ${LOG}"
    return 0
  fi
  if (( ! quiet )); then
    if auth_off; then
      echo "Ovis:    $(url)  (no token: OVIS_TOKEN=off; sessions: pi-container.sh --ovis)"
    else
      echo "Ovis:    $(url)  (token: ./scripts/ovis.sh token; sessions: pi-container.sh --ovis)"
    fi
  fi
}

# The supervisor's TERM trap removes both pid files, which can race this loop,
# so a vanished file is not an error. It then waits for the supervisor to be
# gone, so a `start` right after it cannot find the old one still holding the lock.
stop() {
  in_container
  local p pid sup="" i
  [[ -f "$SUPERVISOR_PID" ]] && sup="$(cat "$SUPERVISOR_PID" 2>/dev/null || true)"
  for p in "$SUPERVISOR_PID" "$SERVER_PID" "$FORWARD_PID"; do
    pid="$(cat "$p" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  if [[ -n "$sup" ]]; then
    for i in $(seq 1 20); do
      kill -0 "$sup" 2>/dev/null || break
      sleep 0.25
    done
  fi
  rm -f "$SUPERVISOR_PID" "$SERVER_PID" "$FORWARD_PID"
  ok "Ovis stopped; herdr and its panes are still running (${HERDR} server stop ends them)"
}

status() {
  local brief=0; [[ "${1:-}" == "--brief" ]] && brief=1
  local state
  if ! ovis_enabled; then state="off (OVIS_ENABLED=0)"
  elif ! have_bundle; then state="enabled, but not in this image — rebuild pi-agent"
  elif healthy; then state="up at $(url)"; auth_off && state+=" (no token: OVIS_TOKEN=off)"
  elif alive "$SUPERVISOR_PID"; then state="starting or restarting — see ${LOG}"
  else state="enabled, not running — ./scripts/ovis.sh start"
  fi
  if (( brief )); then printf '%s\n' "$state"; return 0; fi
  printf 'ovis         %s\n' "$state"
  have_bundle || return 0
  printf 'bundle       %s\n' "$(cat "$OVIS_DIR/bundle.json" 2>/dev/null)"
  if herdr_up; then
    printf 'herdr        running, %s pi pane(s)\n' \
      "$("$HERDR" agent list 2>/dev/null | grep -o '"agent":"pi"' | wc -l)"
  else
    printf 'herdr        not running\n'
  fi
  if auth_off; then
    printf 'access       no token (OVIS_TOKEN=off): open to anything that reaches the port\n'
  else
    printf 'access       token required (%s)\n' "$TOKEN_FILE"
  fi
  printf 'log          %s\n' "$LOG"
}

# --- run: pi in a herdr pane -------------------------------------------------
# herdr starts the pane's process from the SERVER's environment, not from this
# shell's, so a per-launch override (ORCHESTRATOR=1 pi-container.sh --ovis) would
# be lost. The stack keys exported here are written into a launch script, mode
# 0600 on the container's own disk, which deletes itself before it execs
# pi-local.sh. Its PATH drops the shim, or pi-local.sh's own `exec pi` would
# run the launcher a second time.
write_launch() {
  local dir="$1"; shift
  local f key
  f="$(mktemp "$RUN_DIR/launch.XXXXXX")"
  chmod 600 "$f"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'rm -f -- %q\n' "$f"
    printf 'cd -- %q || exit 1\n' "$dir"
    while IFS= read -r key; do
      [[ "$key" == "-e" || -z "$key" ]] && continue
      printf 'export %s=%q\n' "$key" "${!key}"
    done < <(env_forward_args)
    printf 'PATH=%q\n' "$(strip_path "$PATH" "$SHIM_DIR")"
    printf 'export PATH\n'
    printf 'exec %q' "$PI_LOCAL"
    (( $# )) && printf ' %q' "$@"
    printf '\n'
  } > "$f"
  printf '%s' "$f"
}

strip_path() {
  local p=":$1:" drop="$2"
  p="${p//:$drop:/:}"; p="${p#:}"; p="${p%:}"
  printf '%s' "$p"
}

run() {
  in_container
  local dir="$PWD"
  while (( $# )); do
    case "$1" in
      -w) dir="${2:-}"; shift 2 ;;
      --) shift; break ;;
      *)  break ;;
    esac
  done
  [[ -d "$dir" ]] || die "'$dir' is not a directory in the container"
  ovis_enabled || die "Ovis is off (OVIS_ENABLED=0) — run pi without --ovis, or turn it on and --recreate"
  have_bundle || die "Ovis is not in this image — rebuild pi-agent (Dockerfile.pi) and --recreate"
  start --quiet
  herdr_up || die "herdr is not running — see ${LOG}"

  local created pane term launch
  created="$("$HERDR" workspace create --cwd "$dir" --label "pi $(basename "$dir")" --no-focus)" \
    || die "herdr could not create a workspace: $created"
  read -r pane term < <(python3 -c '
import json, sys
p = json.load(sys.stdin)["result"]["root_pane"]
print(p["pane_id"], p["terminal_id"])' <<< "$created") \
    || die "unrecognised reply from herdr workspace create: ${created:0:300}"

  launch="$(write_launch "$dir" "$@")"
  "$HERDR" pane run "$pane" "bash $(printf '%q' "$launch")" >/dev/null \
    || die "herdr could not start pi in pane $pane"

  if [[ ! -t 0 || ! -t 1 ]]; then
    ok "pi started in herdr pane ${pane}; follow it in Ovis at $(url)"
    return 0
  fi
  dim "pi in herdr pane ${pane} — Ctrl+B then Q detaches; pi keeps running in Ovis ($(url))"
  exec "$HERDR" terminal attach "$term"
}

# Sourced (scripts/test_ovis.py), it only defines the functions.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

case "${1:-}" in
  start)     shift; start "$@" ;;
  stop)      stop ;;
  status)    shift; status "$@" ;;
  token)     if auth_off; then echo "no token: OVIS_TOKEN=off" >&2; else token; echo; fi ;;
  enabled)   ovis_enabled ;;
  run)       shift; run "$@" ;;
  supervise) in_container; mkdir -p "$RUN_DIR"; supervise ;;
  -h|--help|"") usage ;;
  *)         die "unknown command '$1' — ./scripts/ovis.sh --help" ;;
esac
