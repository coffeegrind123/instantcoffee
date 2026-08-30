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

# The recorded hash describes the model_file recorded beside it, which is the
# coding regime's. If mode.sh has switched .env to another regime, comparing the
# ACTIVE model's Hub hash against it compares two different files and reports
# "DRIFT" every time — a false alarm that trains the reader to ignore a real one.
LOCK_MODEL_FILE_FOR_DRIFT="$(lock_get model_file)"

if [[ -n "$LOCK_MODEL_FILE_FOR_DRIFT" && "$LOCK_MODEL_FILE_FOR_DRIFT" != "$GGUF_NAME" ]]; then
  dim "GGUF: active model (${GGUF_NAME}) is not the one recorded in versions.lock"
  dim "     (${LOCK_MODEL_FILE_FOR_DRIFT}) — skipping the drift check, which would"
  dim "     otherwise compare two different files and always say DRIFT."
elif [[ -z "$GGUF_SHA" ]]; then
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
# versions.lock is UPDATED FIELD BY FIELD, never rewritten.
#
# It used to be rewritten from a here-doc template that was the whole file, so
# every hand-recorded block in it — spec_verdict, depth_ppl, tool_grammar,
# kv_alt, the model rollback hashes, the better part of a thousand lines of
# measurement that cost days of GPU time — was destroyed by any update. The
# file's own header admitted this had already happened twice. That made the
# documented "just run update.sh" path the most destructive command in the repo,
# and made hand-editing .env the safer route, which is exactly backwards.
#
# Now each machine-owned field is written in place with lock_set (see lib.sh)
# and everything else in the file is left alone. Hand-written continuation prose
# under an owned key is PRESERVED rather than rewritten, which means it can now
# describe a value that just changed — so the keys carrying prose are listed
# below for a human to re-read. Preserving something stale and saying so beats
# deleting something irreplaceable and not.
DIGEST="$(llama_tag_digest "$NEW_LLAMA" || echo unknown)"

LOCK_BACKUP="$REPO_ROOT/.versions.lock.bak"
cp "$REPO_ROOT/versions.lock" "$LOCK_BACKUP" 2>/dev/null || true

# Only record a previous-image line when the image actually moved, so an
# unrelated --force run does not overwrite the rollback pointer with itself.
if [[ "$NEW_LLAMA" != "$CUR_LLAMA" ]]; then
  PREV_DIGEST="$(lock_get llama_image_digest)"
  lock_set llama_image_prev "${CUR_LLAMA} @ ${PREV_DIGEST:-unknown}"
fi

lock_set updated_utc         "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
lock_set llama_image         "ghcr.io/ggml-org/llama.cpp:${NEW_LLAMA}"
lock_set llama_image_digest  "${DIGEST}"
lock_set forge_version       "${NEW_FORGE}"
# The model fields describe ONE regime — the coding/default one — while .env's
# MODEL_REPO/GGUF_FILE follow whichever mode is active (mode.sh; the other
# regimes have their own keys, e.g. prose_model_sha256). So writing the active
# model here unconditionally would stamp uc-coding's or prose's weights over the
# coding regime's recorded pin, and leave the hand-written prose underneath
# describing weights that are no longer named above it.
#
# That is the same clobber this rewrite exists to stop, so it is refused rather
# than done quietly. When the active model is the recorded one, the fields are
# refreshed as before.
LOCK_MODEL_REPO="$(lock_get model_repo)"
LOCK_MODEL_FILE="$(lock_get model_file)"
if [[ "$LOCK_MODEL_REPO" == "$MODEL_REPO_ID" && "$LOCK_MODEL_FILE" == "$GGUF_NAME" ]]; then
  lock_set model_file_sha256   "${GGUF_SHA:-unknown}"
  lock_set model_repo_modified "${GGUF_MODIFIED:-unknown}"
else
  warn "versions.lock model_* left alone: the active model is not the one recorded."
  warn "    active   ${MODEL_REPO_ID} / ${GGUF_NAME}"
  warn "    recorded ${LOCK_MODEL_REPO:-none} / ${LOCK_MODEL_FILE:-none}"
  warn "  Those fields pin the coding regime; mode.sh has switched .env to another."
  warn "  Record the active model by hand if that is what you want pinned."
fi
lock_set context_size        "$(env_get CTX_SIZE)"
lock_set kv_cache            "$(env_get CACHE_TYPE_K)/$(env_get CACHE_TYPE_V)"
lock_set rtk_version         "$( [[ "$(env_get RTK_ENABLED)" == "1" ]] && env_get RTK_VERSION || echo "disabled" )"
lock_set rtk_filters         "${RTK_STATE}"
lock_set verified            "$( ((VERIFY)) && echo "smoke test passed" || echo "not verified" )"

STALE_PROSE=()
for k in llama_image llama_image_digest llama_image_prev forge_version \
         model_repo model_file model_file_sha256 context_size kv_cache verified; do
  lock_has_prose "$k" && STALE_PROSE+=("$k")
done
if (( ${#STALE_PROSE[@]} )); then
  warn "versions.lock: these keys carry hand-written notes that were PRESERVED"
  warn "and may now describe the previous value — re-read them:"
  for k in "${STALE_PROSE[@]}"; do warn "    $k"; done
  dim  "  previous file kept at $LOCK_BACKUP"
fi

rm -f "$BACKUP"
ok "Updated to llama=$NEW_LLAMA forge=$NEW_FORGE"
dim "versions.lock rewritten — commit it to keep the setup reproducible:"
dim "  git -C $REPO_ROOT commit -am 'chore: update llama.cpp $NEW_LLAMA, forge $NEW_FORGE'"
