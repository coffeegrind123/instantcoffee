#!/usr/bin/env bash
#
# Does a sampler override stop the model returning empty answers?
#
#   ./scripts/empty-turn-ab.sh --arm base: --arm fp03:frequency_penalty=0.3
#   ./scripts/empty-turn-ab.sh --arm base: --arm fp03:frequency_penalty=0.3 --rounds 60 --items 900
#   ./scripts/empty-turn-ab.sh --workload tape --tape /captures/<tape>.jsonl --min-prompt-tokens 85000 ...
#   ./scripts/empty-turn-ab.sh --self-test
#
# The first --arm is the baseline; `name:` with nothing after it is the server's
# own launch settings. Arms are paired per round on identical content, in a
# shuffled order. The method, and why it skips forge, is the docstring of
# scripts/empty_turn_ab.py.
#
# Runs INSIDE the compose network against llama directly. The stack must be up.
# --build for the same reason bench-literal.sh passes it: the probe is COPIED
# into the image, so without a rebuild you run the version from the last build.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
compose --profile tools run --rm --build emptyturn "$@"
