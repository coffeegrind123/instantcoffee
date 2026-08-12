#!/usr/bin/env bash
# Tail logs.  ./scripts/logs.sh [llama|forge]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
compose logs -f --tail=120 "$@"
