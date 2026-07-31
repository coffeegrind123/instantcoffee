#!/usr/bin/env bash
# Fetch the Thireus recipe model (852 shards) for the ik backend.
# Resumable — already-correct shards are verified and skipped.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
info "Recipe: $(basename "$(env_get IK_RECIPE)")"
info "This is ~15 GB across 852 shards; re-run any time to resume."
compose --profile tools run --rm --user 0:0 ik-downloader "$@"
