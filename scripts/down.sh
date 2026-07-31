#!/usr/bin/env bash
# Stop the stack. Pass --volumes to also drop anonymous volumes (the model lives
# on a bind mount, so it is never touched by this).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
info "Stopping"
compose down --remove-orphans "$@"
