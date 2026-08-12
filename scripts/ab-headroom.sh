#!/usr/bin/env bash
#
# Measure headroom compression before routing pi through it.
#
#   ./scripts/ab-headroom.sh                 2 passes per arm (default)
#   ./scripts/ab-headroom.sh --repeat 4      more passes, less noise
#   ./scripts/ab-headroom.sh --recall-only   only the compressible tasks
#   ./scripts/ab-headroom.sh --save          write results/headroom-ab.json
#
# Runs the same tasks twice through the same proxy — once compressed, once with
# x-headroom-bypass — and reports prompt tokens saved, quality, and recall of
# facts buried in large tool outputs. Exit code is non-zero when headroom should
# NOT be adopted on this model.
#
# The stack must be up (./scripts/up.sh) and headroom must be running
# (./scripts/headroom.sh up). HEADROOM_ENABLED does not have to be 1 — measuring
# it does not require adopting it first, which is the whole point.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SAVE=0
PASSTHRU=()
while (( $# )); do
  case "$1" in
    --save)    SAVE=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)         PASSTHRU+=("$1"); shift ;;
  esac
done

require_cmd docker

PORT="$(env_get HEADROOM_PORT)"; : "${PORT:=8787}"
[[ -f /.dockerenv ]] && HOST="host.docker.internal" || HOST="localhost"
curl -fsS -m 5 -o /dev/null "http://${HOST}:${PORT}/health" 2>/dev/null \
  || die "headroom is not answering on ${PORT} — start it with ./scripts/headroom.sh up"

RATIO="$(env_get HEADROOM_TARGET_RATIO)"
info "A/B: headroom compression vs the same stack bypassed"
dim  "recovery mode: $(env_get HEADROOM_RECOVERY)   target ratio: ${RATIO:-auto}"
dim  "a run measures the mode headroom is CURRENTLY running — restart it after changing .env"

# headroom's semantic cache has to be OFF for the duration, or this measures
# nothing. Learned the hard way on the first real run: the bypass arm populates
# the cache, the compressed arm then gets hits, every task returns in 0.0s with
# an identical score, and compression never executes — the verdict came back
# INCONCLUSIVE with "prompt tokens 4599 -> 4599". A cached response also carries
# no x-headroom-tokens-* headers, which is what the guard keys on.
#
# So the proxy is restarted with --no-cache for the run and restored afterwards.
# It is a small container (~10s), unlike llama, so this is cheap. Normal
# sessions keep caching, which is a real win there and only a hazard here.
restore_headroom() {
  info "Restoring headroom to its configured flags"
  HEADROOM_EXTRA_FLAGS="$(env_get HEADROOM_EXTRA_FLAGS)" \
    compose up -d --force-recreate headroom >/dev/null 2>&1 \
    || warn "could not restore headroom — ./scripts/headroom.sh up"
}
trap restore_headroom EXIT

info "Restarting headroom with --no-cache for the run"
HEADROOM_EXTRA_FLAGS="$(env_get HEADROOM_EXTRA_FLAGS) --no-cache" \
  compose up -d --force-recreate headroom >/dev/null 2>&1 \
  || die "could not restart headroom with --no-cache"
for _ in $(seq 1 30); do
  curl -fsS -m 5 -o /dev/null "http://${HOST}:${PORT}/health" 2>/dev/null && break
  sleep 2
done
curl -fsS -m 5 -o /dev/null "http://${HOST}:${PORT}/health" 2>/dev/null \
  || die "headroom did not come back up with --no-cache"

(( SAVE )) && mkdir -p "$REPO_ROOT/results"

set +e
compose --profile tools run --rm ab-headroom "${PASSTHRU[@]}" 2>&1 \
  | tee /tmp/qwen36-ab-headroom.txt
STATUS="${PIPESTATUS[0]}"
set -e

if (( SAVE )); then
  # The container cannot write to the repo, so the JSON block is lifted out of
  # the captured output rather than mounted back — same as ab-think-lang.sh.
  python3 - "$REPO_ROOT/results/headroom-ab.json" <<'PY' || warn "could not extract JSON — see /tmp/qwen36-ab-headroom.txt"
import json, re, sys
text = open("/tmp/qwen36-ab-headroom.txt", encoding="utf-8", errors="replace").read()
m = re.search(r"```json\s*\n(.*?)\n```", text, re.S)
if not m:
    raise SystemExit("no JSON block in output")
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(json.loads(m.group(1)), fh, indent=2, ensure_ascii=False)
print(f"saved {sys.argv[1]}")
PY
fi

echo
if (( STATUS == 0 )); then
  ok "See the VERDICT line for whether it is worth the hop."
  dim "To adopt it:  set HEADROOM_ENABLED=1 in .env"
else
  warn "Do not route pi through headroom as configured — see the VERDICT line above."
fi
exit "$STATUS"
