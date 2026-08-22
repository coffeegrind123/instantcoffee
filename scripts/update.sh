#!/usr/bin/env bash
#
# Update everything: llama-server (pinned llama.cpp build) and forge.
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
  warn "    REDOWNLOAD_STALE=1 ./scripts/download-model.sh"
  warn "  (download_model.py size-checks against the Hub and moves the old file"
  warn "   aside as *.superseded rather than deleting it, so this is reversible.)"
else
  dim "GGUF: ${GGUF_NAME} matches versions.lock (${GGUF_SHA:0:12})"
fi

printf '\n  %-22s %-22s %s\n' "component" "current" "latest"
printf '  %-22s %-22s %s\n' "----------------------" "----------------------" "----------------------"
printf '  %-22s %-22s %s\n' "llama.cpp (image)" "$CUR_LLAMA" "$NEW_LLAMA"
printf '  %-22s %-22s %s\n\n' "forge-guardrails" "$CUR_FORGE" "$NEW_FORGE"

CHANGED=0
[[ "$NEW_LLAMA" != "$CUR_LLAMA" ]] && CHANGED=1
[[ "$NEW_FORGE" != "$CUR_FORGE" ]] && CHANGED=1

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

rollback() {
  warn "Rolling back to llama=$CUR_LLAMA forge=$CUR_FORGE"
  # Guarded, because every caller is the right-hand side of `||`, which disables
  # `set -e` for this whole function body. Without the guard a missing backup
  # would let `cp` fail, print to stderr, and fall straight through to a restart
  # that brings the stack up on the NEW pins — while the line below announces
  # that it is running the previous ones. Same family as the .env hazard that
  # spec-sweep.sh carried until the 2026-08-22 provenance pass: a restore path
  # that cannot restore must say so, not carry on and claim success.
  if [[ -s "$BACKUP" ]]; then
    cp "$BACKUP" "$REPO_ROOT/.env"
  else
    warn "the .env backup ($BACKUP) is missing or empty — .env still holds the NEW pins:"
    warn "    LLAMA_TAG=$(env_get LLAMA_TAG)  FORGE_VERSION=$(env_get FORGE_VERSION)"
    warn "    put back LLAMA_TAG=$CUR_LLAMA FORGE_VERSION=$CUR_FORGE by hand before restarting"
    die "Update FAILED and could not be rolled back."
  fi
  compose up -d --build 2>&1 | tail -5 || warn "rollback restart also failed — inspect manually"
  die "Update rolled back. The stack is running the previous pins."
}

env_set LLAMA_TAG "$NEW_LLAMA"
env_set FORGE_VERSION "$NEW_FORGE"

info "Pulling llama.cpp $NEW_LLAMA"
compose pull llama || rollback

info "Building forge $NEW_FORGE"
# --pull refreshes the python base image too, so security updates land here.
compose build --pull forge || rollback

info "Restarting the stack"
compose up -d --remove-orphans || rollback

# --- verify ------------------------------------------------------------------
RTK_STATE="off"
if (( VERIFY )); then
  info "Verifying (model reload takes a few minutes on a cold start)"
  if ! compose --profile tools run --rm smoketest; then
    rollback
  fi

  # rtk is client-side, so a smoke test against the stack cannot see it. Its
  # filters are what vendor/rtk-pi's allow-list is trusting, and they change
  # without anything here noticing — so verify them in the same pass that
  # verifies everything else, and record the answer below.
  #
  # NOT a rollback trigger. rtk failing means bash output stops being compressed;
  # it does not mean the model or the proxy regressed, and tearing down a
  # verified llama/forge update over it would be the wrong trade.
  if [[ "$(env_get RTK_ENABLED)" == "1" ]]; then
    if "$REPO_ROOT/scripts/rtk.sh" --check >/dev/null 2>&1; then
      RTK_STATE="allow-list verified"
      ok "rtk $(env_get RTK_VERSION) filters match vendor/rtk-pi"
    else
      RTK_STATE="MISMATCH — re-measure"
      warn "rtk's filters no longer match the allow-list in vendor/rtk-pi."
      warn "Bash output is still correct; it is just no longer being compressed"
      warn "the way that was measured. Details: ./scripts/rtk.sh --check"
    fi
  fi
else
  warn "Skipped verification (--no-verify)"
  [[ "$(env_get RTK_ENABLED)" == "1" ]] && RTK_STATE="not verified"
fi

# --- record ------------------------------------------------------------------
DIGEST="$(llama_tag_digest "$NEW_LLAMA" || echo unknown)"
cat > "$REPO_ROOT/versions.lock" <<EOF
# Generated by scripts/update.sh.
#
# This template is the WHOLE file: anything hand-added to versions.lock between
# runs — measured throughput, VRAM, spec-config notes — is discarded here. That
# has bitten this repo twice (the file was hand-rewritten on 2026-08-15 and
# again on 2026-08-17). Durable prose belongs in context/design/decisions.md;
# this file is the machine-checkable pin set plus whatever the template emits.
#
# Commit it: it is the record of what was actually verified working.
updated_utc         = $(date -u +%Y-%m-%dT%H:%M:%SZ)
llama_image         = ghcr.io/ggml-org/llama.cpp:${NEW_LLAMA}
llama_image_digest  = ${DIGEST}
forge_version       = ${NEW_FORGE}
model_repo          = $(env_get MODEL_REPO)
model_file          = $(env_get GGUF_FILE)
model_file_sha256   = ${GGUF_SHA:-unknown}
model_repo_modified = ${GGUF_MODIFIED:-unknown}
context_size        = $(env_get CTX_SIZE)
kv_cache            = $(env_get CACHE_TYPE_K)/$(env_get CACHE_TYPE_V)
rtk_version         = $( [[ "$(env_get RTK_ENABLED)" == "1" ]] && env_get RTK_VERSION || echo "disabled" )
rtk_filters         = ${RTK_STATE}
verified            = $( ((VERIFY)) && echo "smoke test passed" || echo "not verified" )
EOF

rm -f "$BACKUP"
ok "Updated to llama=$NEW_LLAMA forge=$NEW_FORGE"
dim "versions.lock rewritten — commit it to keep the setup reproducible:"
dim "  git -C $REPO_ROOT commit -am 'chore: update llama.cpp $NEW_LLAMA, forge $NEW_FORGE'"
