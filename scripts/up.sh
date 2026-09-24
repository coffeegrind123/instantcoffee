#!/usr/bin/env bash
# Start the stack: llama, forge and the observe dashboard (builds the forge and
# observe images if they are missing).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
ensure_observe_checkout
info "Starting"
compose up -d --remove-orphans "$@"
compose ps
dim "Follow the load with: ./scripts/logs.sh llama"
dim "Dashboard:           $(observe_url)"
