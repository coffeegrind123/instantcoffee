#!/usr/bin/env bash
# Tail logs.  ./scripts/logs.sh [llama|forge]
#
# headroom lives behind its own compose profile, so it is not in the default
# set: use ./scripts/headroom.sh logs for that one.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
compose logs -f --tail=120 "$@"
