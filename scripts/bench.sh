#!/usr/bin/env bash
#
# Benchmark the engine: prefill, decode, and MTP draft acceptance.
#
#   ./scripts/bench.sh                    # one run at ~1024 prompt tokens
#   ./scripts/bench.sh --prompt-len 4096  # custom prompt length
#   ./scripts/bench.sh --repeat 3         # repeat each length (nonce keeps it honest)
#   ./scripts/bench.sh --full             # sweep 256..16384
#
# Runs INSIDE the compose network, like the smoke test, because llama-server is
# not published under a hostname the host can reach and because the numbers come
# from llama directly rather than through forge. The stack must be up.
#
# --build is not optional, for the same reason smoke-test.sh passes it:
# Dockerfile.forge COPYs bench.py into the image and nothing bind-mounts over
# it, so without a rebuild you measure the version baked in at the last build.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
compose --profile tools run --rm --build bench "$@"
