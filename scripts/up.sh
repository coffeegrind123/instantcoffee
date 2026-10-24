#!/usr/bin/env bash
# Start the stack: llama, forge and the observe dashboard (builds the forge and
# observe images if they are missing).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
ensure_observe_checkout

# A host port another project already publishes does not fail the start. Docker
# starts the container anyway with NO network attached, its healthcheck (run
# inside the container) still passes, and forge cannot resolve `llama` at all.
# Seen 2026-10-04: tf2pro-voice-gateway-1 held 0.0.0.0:8080. So check first,
# and name the holder.
for key in LLAMA_PORT FORGE_PORT OBSERVE_PORT; do
  port="$(env_get "$key")"
  [[ -n "$port" ]] || continue
  holders="$(docker ps --filter "publish=${port}" --format '{{.Names}}' | grep -v '^instantcoffee-' || true)"
  [[ -z "$holders" ]] || die "host port ${port} (${key}) is already published by: ${holders//$'\n'/, }. Stop that container, or override ${key} for this start (e.g. ${key}=$((port + 10)) ./scripts/up.sh)."
done

info "Starting"
compose up -d --remove-orphans "$@"
compose ps

# The same failure from the other side, for any cause the preflight missed.
for ct in instantcoffee-llama instantcoffee-forge instantcoffee-observe; do
  nets="$(docker inspect -f '{{len .NetworkSettings.Networks}}' "$ct" 2>/dev/null || echo missing)"
  [[ "$nets" == "missing" || "$nets" != "0" ]] \
    || warn "${ct} is running with NO network attached; nothing can reach it. Recreate it: docker compose up -d --force-recreate ${ct#instantcoffee-}"
done
dim "Follow the load with: ./scripts/logs.sh llama"
dim "Dashboard:           $(observe_url)"
