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
CUR_IK="$(env_get IK_RELEASE)"

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

NEW_IK="$(ik_latest_release || true)"
if [[ -z "$NEW_IK" ]]; then
  warn "could not read the latest ik_llama.cpp release — keeping $CUR_IK"
  NEW_IK="$CUR_IK"
fi

# --- QAT GGUF check (HN thread finding) --------------------------------------
# unsloth's QAT (Quantization-Aware Training) line holds bfloat16-level quality
# at Q4 memory. As of the HN thread (June 2026) it only covered Gemma 4, but if
# unsloth/Qwen3.6-27B-*qat* appears it likely beats UD-Q4_K_XL at the same size
# rung. This check flags it so the operator knows to evaluate.
QAT_HINT=""
if command -v huggingface-cli >/dev/null 2>&1; then
  QAT_HINT="$(huggingface-cli api list-models --author unsloth \
    --search "Qwen3.6-27B qat" --limit 3 2>/dev/null \
    | python3 -c "import sys,json; ds=[d['id'] for d in json.load(sys.stdin)]; print(ds[0] if ds else '')" \
    2>/dev/null || true)"
fi
# Fall back to a known pattern match against the model name in .env
if [[ -z "$QAT_HINT" ]] && [[ "$(env_get GGUF_FILE)" == *UD-Q4_K_XL* ]]; then
  QAT_HINT="(check huggingface.co/unsloth for Qwen3.6-27B-*-qat-GGUF)"
fi
if [[ -n "$QAT_HINT" ]]; then
  dim "QAT hint: consider a QAT quant if available — ${QAT_HINT}"
fi

printf '\n  %-22s %-22s %s\n' "component" "current" "latest"
printf '  %-22s %-22s %s\n' "----------------------" "----------------------" "----------------------"
printf '  %-22s %-22s %s\n' "llama.cpp (image)" "$CUR_LLAMA" "$NEW_LLAMA"
printf '  %-22s %-22s %s\n' "forge-guardrails" "$CUR_FORGE" "$NEW_FORGE"
printf '  %-22s %-22s %s\n\n' "ik_llama.cpp" "$CUR_IK" "$NEW_IK"

CHANGED=0
[[ "$NEW_LLAMA" != "$CUR_LLAMA" ]] && CHANGED=1
[[ "$NEW_FORGE" != "$CUR_FORGE" ]] && CHANGED=1
[[ "$NEW_IK"    != "$CUR_IK"    ]] && CHANGED=1

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
  warn "Rolling back to llama=$CUR_LLAMA forge=$CUR_FORGE ik=$CUR_IK"
  cp "$BACKUP" "$REPO_ROOT/.env"
  compose up -d --build 2>&1 | tail -5 || warn "rollback restart also failed — inspect manually"
  die "Update rolled back. The stack is running the previous pins."
}

env_set LLAMA_TAG "$NEW_LLAMA"
env_set FORGE_VERSION "$NEW_FORGE"
env_set IK_RELEASE "$NEW_IK"

# Only touch the backend that is actually active — pulling the mainline image
# or rebuilding the 1.3 GB ik image when it is not in use is pure waste.
ACTIVE="$(env_get COMPOSE_PROFILES)"
if [[ "$ACTIVE" == *mainline* ]]; then
  info "Pulling llama.cpp $NEW_LLAMA"
  compose pull llama || rollback
fi
if [[ "$ACTIVE" == *ik* ]]; then
  info "Building ik_llama.cpp $NEW_IK (downloads a ~1.3 GB release archive)"
  compose build ikllama || rollback
fi

info "Building forge $NEW_FORGE"
# --pull refreshes the python base image too, so security updates land here.
compose build --pull forge || rollback

info "Restarting the stack"
compose up -d --remove-orphans || rollback

# --- verify ------------------------------------------------------------------
if (( VERIFY )); then
  info "Verifying (model reload takes a few minutes on a cold start)"
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
active_profile      = $(env_get COMPOSE_PROFILES)
llama_image         = ghcr.io/ggml-org/llama.cpp:${NEW_LLAMA}
llama_image_digest  = ${DIGEST}
ik_release          = ${NEW_IK}
ik_variant          = $(env_get IK_VARIANT)
ik_recipe           = $(env_get IK_RECIPE)
forge_version       = ${NEW_FORGE}
model_repo          = $(env_get MODEL_REPO)
model_file          = $(env_get GGUF_FILE)
context_size        = $(env_get CTX_SIZE)
verified            = $( ((VERIFY)) && echo "smoke test passed" || echo "not verified" )
EOF

rm -f "$BACKUP"
ok "Updated to llama=$NEW_LLAMA forge=$NEW_FORGE ik=$NEW_IK"
dim "versions.lock rewritten — commit it to keep the setup reproducible:"
dim "  git -C $REPO_ROOT commit -am 'chore: update llama.cpp $NEW_LLAMA, forge $NEW_FORGE, ik $NEW_IK'"
