#!/usr/bin/env bash
# Start the stack (builds the forge image if it is missing).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
info "Starting"
compose up -d --remove-orphans "$@"
compose ps
dim "Follow the load with: ./scripts/logs.sh llama"
