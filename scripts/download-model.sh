#!/usr/bin/env bash
# Fetch the GGUF named in .env into MODELS_DIR. Resumable and idempotent.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
info "Downloading $(env_get GGUF_FILE) from $(env_get MODEL_REPO)"
compose --profile tools run --rm --user 0:0 downloader "$@"
