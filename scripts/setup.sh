#!/usr/bin/env bash
#
# One-shot bring-up: check prerequisites, fetch the model, build, start, verify.
# Safe to re-run — every step is idempotent.
#
#   ./scripts/setup.sh              full setup
#   ./scripts/setup.sh --skip-model don't touch the model download

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SKIP_MODEL=0
for arg in "$@"; do
  case "$arg" in
    --skip-model) SKIP_MODEL=1 ;;
    -h|--help)    sed -n '2,8p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)            die "unknown option: $arg" ;;
  esac
done

require_cmd docker curl

# --- prerequisites -----------------------------------------------------------
info "Checking prerequisites"

docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable"
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"
ok "compose $(docker compose version --short 2>/dev/null)"

# The nvidia runtime is what makes -ngl 999 mean anything. Without it llama.cpp
# quietly falls back to CPU and a 27B model becomes unusably slow — better to
# stop here than to debug "why is it 0.4 tokens/sec" later.
if docker info 2>/dev/null | grep -qi 'runtimes:.*nvidia'; then
  ok "nvidia container runtime present"
else
  warn "the nvidia runtime was not found in 'docker info'."
  warn "Without GPU passthrough this stack will run on CPU and be unusably slow."
  warn "On Docker Desktop: Settings > Resources > enable GPU support."
fi

MODELS_DIR="$(env_get MODELS_DIR)"
GGUF_FILE="$(env_get GGUF_FILE)"
[[ -n "$MODELS_DIR" && -n "$GGUF_FILE" ]] || die "MODELS_DIR / GGUF_FILE missing from .env"
ok "models dir $MODELS_DIR"

# --- image -------------------------------------------------------------------
info "Building the forge image (forge $(env_get FORGE_VERSION))"
compose build forge

# --- model -------------------------------------------------------------------
if (( SKIP_MODEL )); then
  warn "Skipping the model download (--skip-model)"
else
  info "Fetching $GGUF_FILE — this is ~18 GB and only happens once"
  compose --profile tools run --rm --user 0:0 downloader
fi

# --- start -------------------------------------------------------------------
info "Pulling llama.cpp $(env_get LLAMA_TAG)"
compose pull llama

info "Starting the stack"
compose up -d --remove-orphans

info "Verifying — the first load reads ~18 GB off disk into VRAM, so give it a few minutes"
if compose --profile tools run --rm smoketest; then
  echo
  ok "Ready."
  dim "  llama-server  http://$(env_get BIND_ADDR):$(env_get LLAMA_PORT)"
  dim "  forge proxy   http://$(env_get BIND_ADDR):$(env_get FORGE_PORT)"
  echo
  dim "Start a session with:  ./scripts/pi-local.sh"
  dim "Optional compression:  ./scripts/headroom.sh up && ./scripts/ab-headroom.sh"
else
  echo
  die "Smoke test failed. Logs:  ./scripts/logs.sh"
fi
