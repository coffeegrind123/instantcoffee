#!/usr/bin/env bash
#
# Manage the headroom compression proxy that sits in front of forge.
#
#   ./scripts/headroom.sh up          build if needed, start, wait for health
#   ./scripts/headroom.sh down        stop it (the rest of the stack stays up)
#   ./scripts/headroom.sh status      is it up, and what is it configured as
#   ./scripts/headroom.sh savings     token savings so far, from the proxy
#   ./scripts/headroom.sh dashboard   print the dashboard URL
#   ./scripts/headroom.sh logs        tail it
#
# headroom is behind a compose profile and OFF by default. Turning it on is two
# steps on purpose: bring the container up here, then set HEADROOM_ENABLED=1 in
# .env so pi-local.sh actually routes through it. Running the container without
# flipping the flag is a valid state — that is how the A/B harness measures it
# without changing what a normal session does.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd docker

PORT="$(env_get HEADROOM_PORT)"
: "${PORT:=8787}"
[[ -f /.dockerenv ]] && HOST="host.docker.internal" || HOST="localhost"
BASE="http://${HOST}:${PORT}"

hr_ready() { curl -fsS -m 5 -o /dev/null "${BASE}/health" 2>/dev/null; }

cmd="${1:-status}"
shift || true

case "$cmd" in
  up)
    info "Starting headroom $(env_get HEADROOM_VERSION) (recovery: $(env_get HEADROOM_RECOVERY))"
    compose --profile headroom up -d --build headroom

    # The image carries onnxruntime and transformers, so the first start is not
    # instant. Wait rather than hand back a prompt that is not ready yet.
    info "Waiting for it to answer on ${BASE}/health"
    for _ in $(seq 1 60); do
      if hr_ready; then
        ok "headroom is up at ${BASE}"
        if [[ "$(env_get HEADROOM_ENABLED)" != "1" ]]; then
          warn "HEADROOM_ENABLED is not 1 in .env — pi-local.sh still talks straight to forge."
          dim  "Measure it first:  ./scripts/ab-headroom.sh"
          dim  "Then adopt it:     set HEADROOM_ENABLED=1 in .env"
        fi
        exit 0
      fi
      sleep 2
    done
    compose --profile headroom logs --tail=40 headroom || true
    die "headroom did not become healthy within 120s"
    ;;

  down)
    info "Stopping headroom"
    compose --profile headroom stop headroom
    compose --profile headroom rm -f headroom
    if [[ "$(env_get HEADROOM_ENABLED)" == "1" ]]; then
      warn "HEADROOM_ENABLED=1 is still set in .env — pi-local.sh will refuse to start."
      dim  "Set it back to 0 to go straight to forge."
    fi
    ;;

  status)
    printf '  %-18s %s\n' "version" "$(env_get HEADROOM_VERSION)"
    printf '  %-18s %s\n' "recovery" "$(env_get HEADROOM_RECOVERY)"
    RATIO="$(env_get HEADROOM_TARGET_RATIO)"
    printf '  %-18s %s\n' "target ratio" "${RATIO:-auto (Kompress decides)}"
    printf '  %-18s %s\n' "pi routes via" \
      "$( [[ "$(env_get HEADROOM_ENABLED)" == "1" ]] && echo headroom || echo "forge (headroom bypassed)" )"
    printf '  %-18s %s\n' "url" "$BASE"
    if hr_ready; then
      ok "container is answering"
    else
      warn "container is not answering — ./scripts/headroom.sh up"
    fi
    ;;

  savings)
    hr_ready || die "headroom is not running"
    # /stats is the proxy's own accounting. Printed raw: a savings number that
    # has been reformatted by this script is a number nobody can check.
    curl -fsS -m 10 "${BASE}/stats" | json_eval 'import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))'
    ;;

  dashboard)
    dim "Open: ${BASE}/dashboard"
    ;;

  logs)
    compose --profile headroom logs -f --tail=120 headroom
    ;;

  -h|--help|help)
    sed -n '2,16p' "$0" | sed 's/^# \?//'
    ;;

  *)
    die "unknown command '$cmd' — try up | down | status | savings | dashboard | logs"
    ;;
esac
