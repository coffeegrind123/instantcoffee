#!/usr/bin/env bash
# Run the end-to-end check against the running stack.
#
# --build is not optional. Dockerfile.forge COPYs smoke_test.py into the image
# at build time and nothing bind-mounts scripts/ over it, so without this an
# edited check silently runs the version baked in at the last build — passing
# or failing on code that is no longer in the repo. A fully cached build costs
# ~3s; discovering you have been reading stale results costs a great deal more.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
compose --profile tools run --rm --build smoketest "$@"
