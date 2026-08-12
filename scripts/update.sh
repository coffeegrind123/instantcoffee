#!/usr/bin/env bash
#
# Update everything: llama-server (pinned llama.cpp build), forge, and headroom
# when this machine has built it.
#
#   ./scripts/update.sh            check, apply, restart, verify
#   ./scripts/update.sh --check    report what is available, change nothing
#   ./scripts/update.sh --yes      skip the confirmation prompt
#   ./scripts/update.sh --force    rebuild/restart even when already current
#   ./scripts/update.sh --no-verify  skip the post-update smoke test
#
# If the smoke test fails after an update, the previous pins are restored and
# the stack is brought back up on them. An update that breaks inference does not
# get to stay.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CHECK_ONLY=0; ASSUME_YES=0; FORCE=0; VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --check)     CHECK_ONLY=1 ;;
    --yes|-y)    ASSUME_YES=1 ;;
    --force)     FORCE=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help)   sed -n '2,16p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)           die "unknown option: $arg" ;;
  esac
done

require_cmd docker curl

CUR_LLAMA="$(env_get LLAMA_TAG)"
CUR_FORGE="$(env_get FORGE_VERSION)"
CUR_HEADROOM="$(env_get HEADROOM_VERSION)"

info "Resolving upstream versions"

LATEST_BUILD="$(llama_latest_build || true)"
[[ -n "$LATEST_BUILD" ]] || die "could not read the latest llama.cpp build from ghcr.io"
NEW_LLAMA="server-cuda-${LATEST_BUILD}"

# The floating tag can be ahead of the immutable per-build tag for a few minutes
# while the CI matrix finishes pushing. Pinning to a tag that does not exist yet
# would break the next `up`, so keep the current pin if it is not there.
if ! llama_tag_exists "$NEW_LLAMA"; then
  warn "$NEW_LLAMA is not published yet — keeping $CUR_LLAMA"
  NEW_LLAMA="$CUR_LLAMA"
fi

NEW_FORGE="$(forge_latest_version || true)"
[[ -n "$NEW_FORGE" ]] || die "could not read the latest forge-guardrails release from PyPI"

# headroom is optional and behind a compose profile, so a PyPI hiccup here is a
# notice rather than a failure — it must not be able to block a forge update.
NEW_HEADROOM="$(headroom_latest_version || true)"
if [[ -z "$NEW_HEADROOM" ]]; then
  warn "could not read the latest headroom-ai release from PyPI — keeping $CUR_HEADROOM"
  NEW_HEADROOM="$CUR_HEADROOM"
fi

# --- GGUF drift check (2026-08-11 HN thread, Aurornis) -----------------------
# "The quantized releases often change in the weeks following release as new
# improvements are discovered." Nothing else in this repo would notice: GGUF_FILE
# pins a *name*, and unsloth reuses the name when it reuploads better bytes. So
# compare the Hub's LFS sha256 against what versions.lock recorded.
#
# REPORT ONLY, deliberately. It never re-downloads: the model on disk is 18 GB,
# scripts/download_model.py returns early when the file already exists, and
# replacing a working quant mid-update is a decision for a human. A drifted
# quant is a notice, never an action, and never a reason to fail the update.
MODEL_REPO_ID="$(env_get MODEL_REPO)"
GGUF_NAME="$(env_get GGUF_FILE)"
GGUF_REMOTE="$(hf_file_revision "$MODEL_REPO_ID" "$GGUF_NAME")"
GGUF_SHA="${GGUF_REMOTE%% *}"
GGUF_MODIFIED="${GGUF_REMOTE#* }"
GGUF_KNOWN="$(lock_get model_file_sha256)"

if [[ -z "$GGUF_SHA" ]]; then
  dim "GGUF: could not reach the Hub — skipping the drift check"
elif [[ -z "$GGUF_KNOWN" || "$GGUF_KNOWN" == "unknown" ]]; then
  dim "GGUF: recording baseline ${GGUF_SHA:0:12} (repo modified ${GGUF_MODIFIED})"
elif [[ "$GGUF_KNOWN" != "$GGUF_SHA" ]]; then
  warn "GGUF DRIFT: ${GGUF_NAME} on the Hub no longer matches versions.lock."
  warn "  locked ${GGUF_KNOWN:0:12}  ->  hub ${GGUF_SHA:0:12}  (modified ${GGUF_MODIFIED})"
  warn "  unsloth reuploads quants under the same filename. Your local copy is"
  warn "  untouched and this update will not refetch it. To take the new one:"
  warn "    rm \"\$MODELS_DIR/${GGUF_NAME}\" && ./scripts/download-model.sh"
else
  dim "GGUF: ${GGUF_NAME} matches versions.lock (${GGUF_SHA:0:12})"
fi

printf '\n  %-22s %-22s %s\n' "component" "current" "latest"
printf '  %-22s %-22s %s\n' "----------------------" "----------------------" "----------------------"
printf '  %-22s %-22s %s\n' "llama.cpp (image)" "$CUR_LLAMA" "$NEW_LLAMA"
printf '  %-22s %-22s %s\n' "forge-guardrails" "$CUR_FORGE" "$NEW_FORGE"
printf '  %-22s %-22s %s\n\n' "headroom-ai" "$CUR_HEADROOM" "$NEW_HEADROOM"

CHANGED=0
[[ "$NEW_LLAMA" != "$CUR_LLAMA" ]] && CHANGED=1
[[ "$NEW_FORGE" != "$CUR_FORGE" ]] && CHANGED=1
[[ "$NEW_HEADROOM" != "$CUR_HEADROOM" ]] && CHANGED=1

if (( CHECK_ONLY )); then
  (( CHANGED )) && info "Updates available. Run without --check to apply." \
                || ok "Everything is current."
  exit 0
fi

if (( ! CHANGED && ! FORCE )); then
  ok "Everything is current. Use --force to rebuild and restart anyway."
  exit 0
fi

if (( ! ASSUME_YES )); then
  read -r -p "Apply these updates and restart the stack? [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]] || { info "Aborted."; exit 0; }
fi

# --- apply -------------------------------------------------------------------
BACKUP="$REPO_ROOT/.env.bak"
cp "$REPO_ROOT/.env" "$BACKUP"

# Only rebuild headroom if this machine has actually built it before. It is an
# optional profile; forcing a build here would make an opt-in component's
# dependencies a mandatory cost of every update.
HEADROOM_BUILT=0
docker image inspect "qwen36-forge/headroom:${CUR_HEADROOM}" >/dev/null 2>&1 && HEADROOM_BUILT=1

rollback() {
  warn "Rolling back to llama=$CUR_LLAMA forge=$CUR_FORGE headroom=$CUR_HEADROOM"
  cp "$BACKUP" "$REPO_ROOT/.env"
  compose up -d --build 2>&1 | tail -5 || warn "rollback restart also failed — inspect manually"
  die "Update rolled back. The stack is running the previous pins."
}

env_set LLAMA_TAG "$NEW_LLAMA"
env_set FORGE_VERSION "$NEW_FORGE"
env_set HEADROOM_VERSION "$NEW_HEADROOM"

info "Pulling llama.cpp $NEW_LLAMA"
compose pull llama || rollback

info "Building forge $NEW_FORGE"
# --pull refreshes the python base image too, so security updates land here.
compose build --pull forge || rollback

if (( HEADROOM_BUILT )); then
  info "Building headroom $NEW_HEADROOM"
  compose --profile headroom build --pull headroom || rollback
else
  dim "headroom image has never been built here — skipping it (./scripts/headroom.sh up builds it)"
fi

info "Restarting the stack"
compose up -d --remove-orphans || rollback
if (( HEADROOM_BUILT )); then
  compose --profile headroom up -d headroom || rollback
fi

# --- verify ------------------------------------------------------------------
if (( VERIFY )); then
  info "Verifying (model reload takes a few minutes on a cold start)"
  # When pi is routed through headroom, an update that leaves headroom broken is
  # an update that broke inference — so the check has to cover that hop too.
  if (( HEADROOM_BUILT )) && [[ "$(env_get HEADROOM_ENABLED)" == "1" ]]; then
    export HEADROOM_SMOKE_URL="http://headroom:8787"
  fi
  if ! compose --profile tools run --rm smoketest; then
    rollback
  fi
else
  warn "Skipped verification (--no-verify)"
fi

# --- record ------------------------------------------------------------------
DIGEST="$(llama_tag_digest "$NEW_LLAMA" || echo unknown)"
cat > "$REPO_ROOT/versions.lock" <<EOF
# Generated by scripts/update.sh — do not edit by hand.
# Commit this file: it is the record of what was actually verified working.
updated_utc         = $(date -u +%Y-%m-%dT%H:%M:%SZ)
llama_image         = ghcr.io/ggml-org/llama.cpp:${NEW_LLAMA}
llama_image_digest  = ${DIGEST}
forge_version       = ${NEW_FORGE}
headroom_version    = ${NEW_HEADROOM}
headroom_built      = $( ((HEADROOM_BUILT)) && echo yes || echo "no (profile never used here)" )
model_repo          = $(env_get MODEL_REPO)
model_file          = $(env_get GGUF_FILE)
model_file_sha256   = ${GGUF_SHA:-unknown}
model_repo_modified = ${GGUF_MODIFIED:-unknown}
context_size        = $(env_get CTX_SIZE)
verified            = $( ((VERIFY)) && echo "smoke test passed" || echo "not verified" )
EOF

rm -f "$BACKUP"
ok "Updated to llama=$NEW_LLAMA forge=$NEW_FORGE headroom=$NEW_HEADROOM"
dim "versions.lock rewritten — commit it to keep the setup reproducible:"
dim "  git -C $REPO_ROOT commit -am 'chore: update llama.cpp $NEW_LLAMA, forge $NEW_FORGE'"
