#!/usr/bin/env bash
# Run the end-to-end check against the running stack.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
compose --profile tools run --rm smoketest "$@"
