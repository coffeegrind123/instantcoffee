#!/usr/bin/env bash
#
# Do exact literals survive from deep context into a TOOL-CALL ARGUMENT?
#
#   ./scripts/bench-literal.sh                              # 90k, both records
#   ./scripts/bench-literal.sh --tokens 48000 --repeat 3
#   ./scripts/bench-literal.sh --sweep 2000,16000,48000,90000
#   ./scripts/bench-literal.sh --via llama                  # skip the proxy
#   ./scripts/bench-literal.sh --temp 1.0                   # the PRODUCTION sampler
#
# Every run also does the identical request at ~2k tokens first. That control is
# the difference between "literals corrupt at depth" and "this probe never
# worked"; --no-control turns it off and says loudly why you should not.
#
# Runs INSIDE the compose network. The stack must be up.
#
# --build is not optional, for the same reason bench.sh passes it:
# Dockerfile.forge COPYs the probe into the image and nothing bind-mounts over
# it, so without a rebuild you measure the version baked in at the last build.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
compose --profile tools run --rm --build literal "$@"
