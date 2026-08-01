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

SLOT_SAVE_PATH="${SLOT_SAVE_PATH:-/slots}"
LLAMA_PORT="${LLAMA_PORT:-8080}"

save_slots() {
  local max_slots="${1:-4}"
  for s in $(seq 0 $((max_slots - 1))); do
    curl -sf -X POST "http://127.0.0.1:${LLAMA_PORT}/slots?action=save&id_slot=${s}" \
      -H "Content-Type: application/json" \
      -d "{\"filename\":\"slot_${s}.session\"}" 2>/dev/null || true
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
      curl -sf -X POST "http://127.0.0.1:${LLAMA_PORT}/slots?action=restore&id_slot=${s}" \
        -H "Content-Type: application/json" \
        -d "{\"filename\":\"slot_${s}.session\"}" 2>/dev/null || true
    fi
  done
}
