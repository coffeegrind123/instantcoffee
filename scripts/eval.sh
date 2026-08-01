#!/usr/bin/env bash
#
# Run the coding evaluation harness inside the compose network.
# Usage: ./scripts/eval.sh [--help]
#
# The harness tests edit precision, tool calling, code generation, bug fixing,
# multi-turn coherence, reasoning, code review, and refactoring.
#
# An exit code of 0 means every test passed (score ≥ EVAL_SCORE_FLOOR).
# Set EVAL_SCORE_FLOOR=0.0 to always return 0.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

info "Running coding evaluation harness..."
echo ""

compose --profile tools run --rm eval

exit $?
