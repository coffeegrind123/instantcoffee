#!/usr/bin/env bash
#
# Switch the stack between preset regimes and execution backends.
#
#   ./scripts/mode.sh                  show the active mode and what differs
#   ./scripts/mode.sh --list           list available modes
#   ./scripts/mode.sh prose            apply prose (edits .env, no restart)
#   ./scripts/mode.sh prose --restart llama
#                                      apply and recreate llama
#   ./scripts/mode.sh anthropic        apply the hosted Anthropic profile
#   ./scripts/mode.sh local            restore STACK_LAST_LOCAL_MODE
#
# A mode is a file of KEY=VALUE lines in modes/. Adding a mode means adding a
# file; nothing here needs editing. The pi extension's `/stack mode` shells out
# to this script rather than reimplementing it, so both agree by construction.
#
# Local modes rewrite .env and use CTX_SIZE, with optional llama recreation.
# Hosted modes rewrite .env and pi's provider config, but never touch Docker.
# llama-server answers 501 to POST /props, so a running local container keeps
# its old startup values until it is explicitly recreated.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODES_DIR="$REPO_ROOT/modes"
[[ -d "$MODES_DIR" ]] || die "no modes directory at $MODES_DIR"

list_mode_files() { find -L "$MODES_DIR" -maxdepth 1 -name '*.env' -printf '%f\n' 2>/dev/null | sed 's/\.env$//' | sort; }
list_modes() { { printf 'local\n'; list_mode_files; } | sort -u; }

# Keys a mode file sets, in file order.
mode_keys() { grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$1" | sed 's/=.*//' | tr -d ' \t'; }
mode_value() { grep -E "^[[:space:]]*$2=" "$1" | tail -n1 | cut -d= -f2-; }
mode_duplicate_keys() { mode_keys "$1" | sort | uniq -d; }

key_override_source() {
  local key="$1"
  if [[ -n "${!key+x}" ]]; then
    printf 'the environment'
    return 0
  fi
  if [[ -f "$REPO_ROOT/.env.local" ]] \
     && grep -Eq "^[[:space:]]*${key}=" "$REPO_ROOT/.env.local"; then
    printf '.env.local'
  fi
}

# The window key is backend-specific. Keeping this in one function prevents a
# hosted switch from comparing its 1M PI_CONTEXT_WINDOW against local CTX_SIZE.
backend_window() {
  case "$1" in
    anthropic) env_get PI_CONTEXT_WINDOW ;;
    *)         env_get CTX_SIZE ;;
  esac
}

current_backend() {
  local backend; backend="$(env_get STACK_BACKEND)"
  printf '%s' "${backend:-local}"
}

# A backend override is authoritative for every launcher in this checkout.
# Refuse a mode change that cannot change that effective value rather than
# rewriting .env and claiming a provider the nested launcher will not select.
backend_override_source() {
  if [[ -n "${STACK_BACKEND+x}" ]]; then
    printf 'the environment'
    return 0
  fi
  if [[ -f "$REPO_ROOT/.env.local" ]] \
     && grep -Eq '^[[:space:]]*STACK_BACKEND=' "$REPO_ROOT/.env.local"; then
    printf '.env.local'
  fi
}

# Which mode does the CURRENT .env match? A mode matches when every key it
# declares already holds that value. Reported rather than stored, so hand-edits
# can never leave a stale "current mode" marker lying about.
active_mode() {
  local backend f k want have matched target_backend
  backend="$(current_backend)"
  for f in $(list_mode_files); do
    target_backend="$(mode_value "$MODES_DIR/$f.env" STACK_BACKEND)"
    [[ "$target_backend" == "$backend" ]] || continue
    matched=1
    for k in $(mode_keys "$MODES_DIR/$f.env"); do
      want="$(mode_value "$MODES_DIR/$f.env" "$k")"
      have="$(env_get "$k")"
      [[ "$want" == "$have" ]] || { matched=0; break; }
    done
    (( matched )) && { printf '%s' "$f"; return 0; }
  done
  printf 'custom'
}

show_status() {
  local cur; cur="$(active_mode)"
  info "active mode: ${cur}"
  local f k want have
  for f in $(list_mode_files); do
    printf '\n%s%s%s\n' "$C_BLU" "  [$f]" "$C_OFF"
    for k in $(mode_keys "$MODES_DIR/$f.env"); do
      want="$(mode_value "$MODES_DIR/$f.env" "$k")"
      have="$(env_get "$k")"
      if [[ "$want" == "$have" ]]; then
        printf '    %-18s %s\n' "$k" "$want"
      else
        printf '    %-18s %s%s%s  (now: %s)\n' "$k" "$C_YEL" "$want" "$C_OFF" "${have:-unset}"
      fi
    done
  done
}

TARGET=""; DO_RESTART=0; RESTART_SERVICE=llama; EXPECT_RESTART_SERVICE=0
for a in "$@"; do
  case "$a" in
    --list)    list_modes; exit 0 ;;
    --restart) DO_RESTART=1; EXPECT_RESTART_SERVICE=1 ;;
    --restart=*) DO_RESTART=1; RESTART_SERVICE="${a#*=}" ;;
    -*)        die "unknown flag: $a" ;;
    *)
      if (( EXPECT_RESTART_SERVICE )); then
        RESTART_SERVICE="$a"; EXPECT_RESTART_SERVICE=0
      else
        [[ -z "$TARGET" ]] || die "only one mode can be applied at a time, got '$TARGET' and '$a'"
        TARGET="$a"
      fi
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  show_status
  exit 0
fi

if [[ "$RESTART_SERVICE" != "llama" ]]; then
  die "only '--restart llama' is supported, got '--restart $RESTART_SERVICE'"
fi

# `local` is an alias for whatever local profile was last applied. Keeping the
# target name in .env means a hosted session can return without guessing from
# partially restored keys.
REQUESTED_TARGET="$TARGET"
BACKEND_BEFORE="$(current_backend)"
if [[ "$TARGET" == "local" ]]; then
  TARGET="$(env_get STACK_LAST_LOCAL_MODE)"
  [[ -n "$TARGET" ]] || die "STACK_LAST_LOCAL_MODE is unset; choose a local mode explicitly"
  [[ -f "$MODES_DIR/$TARGET.env" ]] \
    || die "STACK_LAST_LOCAL_MODE names no mode: '$TARGET'"
  [[ "$(mode_value "$MODES_DIR/$TARGET.env" STACK_BACKEND)" == "local" ]] \
    || die "STACK_LAST_LOCAL_MODE must name a local mode, got '$TARGET'"
  info "restoring last local mode: $TARGET"
fi

MODE_FILE="$MODES_DIR/$TARGET.env"
[[ -f "$MODE_FILE" ]] || die "no such mode '$REQUESTED_TARGET' — have: $(list_modes | tr '\n' ' ')"
DUPLICATES="$(mode_duplicate_keys "$MODE_FILE" | paste -sd', ' -)"
[[ -z "$DUPLICATES" ]] || die "mode '$TARGET' declares duplicate keys: $DUPLICATES. Keep one declaration per key."
TARGET_BACKEND="$(mode_value "$MODE_FILE" STACK_BACKEND)"
case "$TARGET_BACKEND" in
  local|anthropic) ;;
  *) die "mode '$TARGET' has invalid or missing STACK_BACKEND='$TARGET_BACKEND'" ;;
esac

OVERRIDE_SOURCE="$(backend_override_source)"
if [[ -n "$OVERRIDE_SOURCE" && "$BACKEND_BEFORE" != "$TARGET_BACKEND" ]]; then
  die "STACK_BACKEND is overridden by ${OVERRIDE_SOURCE} as '${BACKEND_BEFORE}', so mode '$TARGET' cannot become effective.
Remove that override, or change it to '${TARGET_BACKEND}' and rerun."
fi

# A mode switch writes .env, but env_get gives an exported value or .env.local
# higher precedence. Refuse now rather than writing a file and reporting a mode
# whose effective window, model, or backend is still the old one.
MODE_OVERRIDE_ERRORS=()
while IFS= read -r k; do
  [[ -n "$k" ]] || continue
  source="$(key_override_source "$k")"
  [[ -n "$source" ]] || continue
  want="$(mode_value "$MODE_FILE" "$k")"
  have="$(env_get "$k")"
  [[ "$want" == "$have" ]] \
    || MODE_OVERRIDE_ERRORS+=("${k}=${have:-empty} from ${source}; mode wants ${want:-empty}")
done < <(mode_keys "$MODE_FILE" | sort -u)
if (( ${#MODE_OVERRIDE_ERRORS[@]} )); then
  die "mode '$TARGET' cannot become fully effective because these values are overridden:
$(printf '  %s\n' "${MODE_OVERRIDE_ERRORS[@]}")
Remove the overrides, or set them to the mode's values and rerun."
fi

# A mode switch changes three files: .env, pi's provider config, and pi's
# settings. Keep a rollback copy until every step succeeds so a failed provider
# rewrite cannot leave the effective backend and provider configuration split.
ENV_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/instantcoffee-env.XXXXXX")"
PI_DIR="$(agent_dir)"
MODELS_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/instantcoffee-models.XXXXXX")"
SETTINGS_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/instantcoffee-settings.XXXXXX")"
cp -p "$REPO_ROOT/.env" "$ENV_SNAPSHOT"
MODELS_EXISTED=0; [[ -f "$PI_DIR/models.json" ]] && { cp -p "$PI_DIR/models.json" "$MODELS_SNAPSHOT"; MODELS_EXISTED=1; }
SETTINGS_EXISTED=0; [[ -f "$PI_DIR/settings.json" ]] && { cp -p "$PI_DIR/settings.json" "$SETTINGS_SNAPSHOT"; SETTINGS_EXISTED=1; }
MODE_COMMITTED=0
rollback_mode_switch() {
  local status=$?
  if (( status != 0 && MODE_COMMITTED == 0 )); then
    cp -p "$ENV_SNAPSHOT" "$REPO_ROOT/.env" \
      && warn "mode switch failed — restored .env"
    if (( MODELS_EXISTED )); then
      cp -p "$MODELS_SNAPSHOT" "$PI_DIR/models.json" \
        && warn "restored pi provider config"
    else
      rm -f "$PI_DIR/models.json"
    fi
    if (( SETTINGS_EXISTED )); then
      cp -p "$SETTINGS_SNAPSHOT" "$PI_DIR/settings.json" \
        && warn "restored pi settings"
    else
      rm -f "$PI_DIR/settings.json"
    fi
  fi
  rm -f "$ENV_SNAPSHOT" "$MODELS_SNAPSHOT" "$SETTINGS_SNAPSHOT"
}
trap rollback_mode_switch EXIT

info "applying mode: $TARGET ($TARGET_BACKEND backend)"
WINDOW_BEFORE="$(backend_window "$BACKEND_BEFORE")"
CHANGED=0

# The local team settings are independent of the local model profile. Preserve
# them as a snapshot before the hosted profile overwrites the shared keys, then
# restore them when leaving hosted mode.
LOCAL_STATE_KEYS=(PI_OFFLINE ORCHESTRATOR SUBAGENTS_ENABLED SUBAGENT_MODEL ADVISOR_MODEL)

if [[ "$TARGET_BACKEND" == "local" && "$BACKEND_BEFORE" == "anthropic" ]]; then
  RESTORE_OVERRIDE_ERRORS=()
  for k in "${LOCAL_STATE_KEYS[@]}"; do
    source="$(key_override_source "$k")"
    [[ -n "$source" ]] || continue
    saved_value="$(mode_value "$REPO_ROOT/.env" "STACK_LAST_LOCAL_${k}")"
    have="$(env_get "$k")"
    [[ "$saved_value" == "$have" ]] \
      || RESTORE_OVERRIDE_ERRORS+=("${k}=${have:-empty} from ${source}; saved local value is ${saved_value:-empty}")
  done
  source="$(key_override_source STACK_LAST_LOCAL_MODE)"
  if [[ -n "$source" && "$(env_get STACK_LAST_LOCAL_MODE)" != "$TARGET" ]]; then
    RESTORE_OVERRIDE_ERRORS+=(
      "STACK_LAST_LOCAL_MODE=$(env_get STACK_LAST_LOCAL_MODE) from ${source}; selected local mode is ${TARGET}"
    )
  fi
  if (( ${#RESTORE_OVERRIDE_ERRORS[@]} )); then
    die "local mode '$TARGET' cannot become fully effective because these values are overridden:
$(printf '  %s\n' "${RESTORE_OVERRIDE_ERRORS[@]}")
Remove the overrides, or set them to the saved local values and rerun."
  fi
fi

# Record the exact local profile before hosted keys obscure it. A hand-edited
# .env that matches no profile is safer to reject than to restore approximately.
if [[ "$TARGET_BACKEND" == "anthropic" && "$BACKEND_BEFORE" == "local" ]]; then
  CURRENT_LOCAL="$(active_mode)"
  if [[ "$CURRENT_LOCAL" == "custom" ]]; then
    SAVED_LOCAL="$(env_get STACK_LAST_LOCAL_MODE)"
    if [[ -n "$SAVED_LOCAL" && -f "$MODES_DIR/$SAVED_LOCAL.env" \
          && "$(mode_value "$MODES_DIR/$SAVED_LOCAL.env" STACK_BACKEND)" == "local" ]]; then
      warn "current .env matches no local mode; preserving existing restore target '$SAVED_LOCAL'"
    else
      die "current .env matches no local mode; apply a named local mode before switching to Anthropic"
    fi
  elif [[ "$(env_get STACK_LAST_LOCAL_MODE)" != "$CURRENT_LOCAL" ]]; then
    env_set STACK_LAST_LOCAL_MODE "$CURRENT_LOCAL"
    ok "  STACK_LAST_LOCAL_MODE -> $CURRENT_LOCAL"
    CHANGED=$(( CHANGED + 1 ))
  fi
  for k in "${LOCAL_STATE_KEYS[@]}"; do
    saved_key="STACK_LAST_LOCAL_${k}"
    saved_value="$(mode_value "$REPO_ROOT/.env" "$k")"
    if [[ "$(mode_value "$REPO_ROOT/.env" "$saved_key")" != "$saved_value" ]]; then
      env_set "$saved_key" "$saved_value"
      ok "  ${saved_key} -> ${saved_value}"
      CHANGED=$(( CHANGED + 1 ))
    fi
  done
fi

for k in $(mode_keys "$MODE_FILE"); do
  want="$(mode_value "$MODE_FILE" "$k")"
  have="$(env_get "$k")"
  if [[ "$want" == "$have" ]]; then
    dim "  $k=$want (unchanged)"
  else
    env_set "$k" "$want"
    ok "  $k: ${have:-unset} -> $want"
    CHANGED=$(( CHANGED + 1 ))
  fi
done

if [[ "$TARGET_BACKEND" == "local" && "$BACKEND_BEFORE" == "anthropic" ]]; then
  for k in "${LOCAL_STATE_KEYS[@]}"; do
    saved_key="STACK_LAST_LOCAL_${k}"
    saved_value="$(mode_value "$REPO_ROOT/.env" "$saved_key")"
    current_value="$(mode_value "$REPO_ROOT/.env" "$k")"
    if [[ "$current_value" != "$saved_value" ]]; then
      env_set "$k" "$saved_value"
      ok "  ${k}: ${current_value:-unset} -> ${saved_value}"
      CHANGED=$(( CHANGED + 1 ))
    fi
  done
fi

if [[ "$TARGET_BACKEND" == "local" && "$(env_get STACK_LAST_LOCAL_MODE)" != "$TARGET" ]]; then
  env_set STACK_LAST_LOCAL_MODE "$TARGET"
  ok "  STACK_LAST_LOCAL_MODE -> $TARGET"
  CHANGED=$(( CHANGED + 1 ))
fi

if (( CHANGED == 0 )); then
  ok "already in $TARGET mode — no .env changes needed"
fi

# pi reads its provider and context at launch. Local modes size the provider
# from CTX_SIZE; Anthropic sizes it from PI_CONTEXT_WINDOW. Rewrite whenever the
# backend or the backend's window changes. A hosted mode also refreshes on every
# apply so its provider catalog follows the hosted backend immediately.
WINDOW_AFTER="$(backend_window "$TARGET_BACKEND")"
NEED_PI_INSTALL=0
[[ "$TARGET_BACKEND" != "$BACKEND_BEFORE" ]] && NEED_PI_INSTALL=1
[[ "$WINDOW_AFTER" != "$WINDOW_BEFORE" ]] && NEED_PI_INSTALL=1
[[ "$TARGET_BACKEND" == "anthropic" ]] && NEED_PI_INSTALL=1

if (( NEED_PI_INSTALL )); then
  if "$REPO_ROOT/scripts/pi-local.sh" --install-only >/dev/null; then
    if [[ "$TARGET_BACKEND" == "anthropic" ]]; then
      ok "  pi config rewritten for the hosted Anthropic backend (${WINDOW_AFTER}-token window)"
    else
      ok "  pi config rewritten for the local ${TARGET_BACKEND} backend (${WINDOW_AFTER}-token window)"
    fi
  else
    die "pi config was not rewritten. The .env switch is incomplete; run ./scripts/pi-local.sh --install-only to repair it."
  fi
fi
MODE_COMMITTED=1

if [[ "$TARGET_BACKEND" == "anthropic" ]]; then
  if (( DO_RESTART )); then
    warn "--restart is a no-op in Anthropic mode; never starting or recreating llama or forge"
  fi
  ok "Anthropic mode selected; llama and forge were not started or recreated"
  if [[ -z "$(env_get ANTHROPIC_API_KEY)" ]]; then
    warn "ANTHROPIC_API_KEY is not set — add it to .env.local before launching pi"
  fi
  warn "relaunch any running pi session; it keeps the provider and context window it read at launch"
  dim "restore the last local mode with: ./scripts/mode.sh local"
  dim "restart local llama separately only when you choose to: ./scripts/mode.sh local --restart llama"
  exit 0
fi

if [[ "$TARGET_BACKEND" != "$BACKEND_BEFORE" ]]; then
  warn "backend ${BACKEND_BEFORE} -> ${TARGET_BACKEND}: relaunch any running pi session to use the restored local provider"
elif [[ "$WINDOW_AFTER" != "$WINDOW_BEFORE" ]]; then
  warn "window ${WINDOW_BEFORE:-unset} -> ${WINDOW_AFTER}: restart any running pi session; it read the old window at launch."
fi

# A model swap is the expensive case and worth naming separately: recreating
# llama for a sampler change costs the same cold load as changing the weights.
if (( CHANGED > 0 )); then
  warn "$CHANGED key(s) changed. Nothing is live until llama is recreated."
fi
if (( DO_RESTART )); then
  info "recreating llama (expect a ~9-20 minute cold load)"
  compose up -d --force-recreate llama
  ok "llama recreated — watch it come up with: ./scripts/logs.sh llama"
else
  dim "apply it with:  ./scripts/mode.sh $TARGET --restart llama"
  dim "            or: docker compose up -d --force-recreate llama"
fi
