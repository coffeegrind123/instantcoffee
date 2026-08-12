#!/bin/sh
# Entrypoint for the headroom image.
#
# Translates HEADROOM_RECOVERY (one enum in .env) into the two environment
# variables headroom's CLI already reads for itself, then execs the proxy.
#
# Why a wrapper instead of putting the flags in docker-compose.yml: compose has
# no conditionals, so a three-way choice would have to become two independent
# booleans that can contradict each other. Doing it here means the value is
# validated on every start, whatever launched the container — including a bare
# `docker compose --profile headroom up` that never went through scripts/.

set -eu

RECOVERY="${HEADROOM_RECOVERY:-lossless}"

case "$RECOVERY" in
  lossless)
    # Format-native lossless compaction, marker-free SmartCrusher, no injected
    # headroom_retrieve tool. Nothing the model sees becomes unrecoverable.
    HEADROOM_LOSSLESS=1
    export HEADROOM_LOSSLESS
    ;;
  ccr)
    # Lossy, with the retrieval tool injected. Recovery depends on the model
    # choosing to call it — which is a claim about this model, not a guarantee.
    :
    ;;
  lossy)
    # Lossy with no recovery path at all.
    HEADROOM_NO_CCR=1
    export HEADROOM_NO_CCR
    ;;
  *)
    echo "headroom: HEADROOM_RECOVERY must be lossless|ccr|lossy, got '$RECOVERY'" >&2
    exit 2
    ;;
esac

# click reads HEADROOM_TARGET_RATIO as a float. An empty string is not "unset"
# to click — it parses it and fails — so an empty value has to disappear here.
if [ -z "${HEADROOM_TARGET_RATIO:-}" ]; then
  unset HEADROOM_TARGET_RATIO || true
fi

echo "headroom: recovery=$RECOVERY target_ratio=${HEADROOM_TARGET_RATIO:-auto}" >&2

exec headroom proxy --host 0.0.0.0 --port 8787 "$@"
