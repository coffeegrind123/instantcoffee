#!/usr/bin/env bash
#
# Warm-start helper: save all active slot caches on shutdown and restore them
# on the next start so agentic sessions resume instantly with no re-prefill.
#
# Pattern from loops-and-spells/pi-setup and sasasin/dotfiles.
# Documented in context/design/decisions.md under "GitHub research".
#
# Usage (inside a container where llama-server runs on port 8080):
#   source slot-cache.sh
#   trap save_slots EXIT
#   # ... start llama-server ...
#   restore_slots
#   wait $SERVER_PID
#
# ---------------------------------------------------------------------------
# READ THIS BEFORE WIRING IT UP. Measured on b10200, 2026-08-13, not inferred.
#
#   * The route is POST /slots/{id}?action=...  The query-string form this file
#     used to send — POST /slots?action=save&id_slot=N — returns 404 on this
#     build. Both curl flags below hid it: -f swallows the body and `|| true`
#     swallows the exit code, so every "save" was a silent no-op for months.
#
#   * A save is not cheap. One 32k slot wrote 315 MB in 180 s and had not
#     finished. At PARALLEL_SLOTS=1 that is one file; the max_slots=4 default
#     here would attempt four.
#
#   * Aborting a save mid-write WEDGES THE SERVER. The task queue stops
#     draining: /slots, /metrics and all inference hang while /props keeps
#     answering, so health checks still pass. Recovery is a container recreate
#     plus a ~20 minute cold load.
#
# Consequence: do NOT use save_slots as an EXIT trap. Container shutdown sends
# SIGTERM and then SIGKILLs on a timeout — which is exactly the abort that
# wedges the server, and it would fire on every single `docker compose down`.
# Nothing in this repo calls these functions today. Keep it that way unless you
# have re-measured on your own build.
# ---------------------------------------------------------------------------

SLOT_SAVE_PATH="${SLOT_SAVE_PATH:-/slots}"
LLAMA_PORT="${LLAMA_PORT:-8080}"

# Errors are reported rather than discarded: -f is dropped so the body is
# visible, and the HTTP status is checked explicitly.
_slot_post() {
  local slot="$1" action="$2" code
  code=$(curl -s -o /tmp/slot-cache.$$ -w '%{http_code}' \
    -X POST "http://127.0.0.1:${LLAMA_PORT}/slots/${slot}?action=${action}" \
    -H "Content-Type: application/json" \
    -d "{\"filename\":\"slot_${slot}.session\"}" 2>/dev/null) || code=000
  if [ "$code" != "200" ]; then
    echo "[slot-cache] slot ${slot} ${action} failed: HTTP ${code} $(head -c 200 /tmp/slot-cache.$$ 2>/dev/null)" >&2
    rm -f /tmp/slot-cache.$$
    return 1
  fi
  rm -f /tmp/slot-cache.$$
}

save_slots() {
  local max_slots="${1:-4}"
  for s in $(seq 0 $((max_slots - 1))); do
    _slot_post "$s" save || true
  done
}

restore_slots() {
  local max_attempts="${1:-60}"
  local max_slots="${2:-4}"

  # Wait for server to become healthy
  local ready=0
  for i in $(seq 1 "$max_attempts"); do
    if curl -sf "http://127.0.0.1:${LLAMA_PORT}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done

  if [ "$ready" -eq 0 ]; then
    echo "[slot-cache] server not ready after ${max_attempts}s, skipping slot restore" >&2
    return
  fi

  for s in $(seq 0 $((max_slots - 1))); do
    local slot_file="${SLOT_SAVE_PATH}/slot_${s}.session"
    if [ -f "$slot_file" ]; then
      echo "[slot-cache] restoring slot ${s} from ${slot_file}" >&2
      _slot_post "$s" restore || true
    fi
  done
}
