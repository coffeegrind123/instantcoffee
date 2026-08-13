#!/usr/bin/env bash
#
# Switch the stack between preset regimes — coding and prose.
#
#   ./scripts/mode.sh                  show the active mode and what differs
#   ./scripts/mode.sh --list           list available modes
#   ./scripts/mode.sh prose            apply prose (edits .env, no restart)
#   ./scripts/mode.sh prose --restart  apply and recreate llama
#
# A mode is a file of KEY=VALUE lines in modes/. Adding a mode means adding a
# file; nothing here needs editing. The pi extension's `/stack mode` shells out
# to this script rather than reimplementing it, so both agree by construction.
#
# Applying a mode only rewrites .env. llama-server answers 501 to POST /props,
# so every value here is read at startup and nothing takes effect until the
# container is recreated — which is a ~9-20 minute cold load on this box.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODES_DIR="$REPO_ROOT/modes"
[[ -d "$MODES_DIR" ]] || die "no modes directory at $MODES_DIR"

list_modes() { find "$MODES_DIR" -maxdepth 1 -name '*.env' -printf '%f\n' 2>/dev/null | sed 's/\.env$//' | sort; }

# Keys a mode file sets, in file order.
mode_keys() { grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$1" | sed 's/=.*//' | tr -d ' \t'; }
mode_value() { grep -E "^[[:space:]]*$2=" "$1" | tail -n1 | cut -d= -f2-; }

# Which mode does the CURRENT .env match? A mode matches when every key it
# declares already holds that value. Reported rather than stored, so hand-edits
# can never leave a stale "current mode" marker lying about.
active_mode() {
  local m f k want have matched
  for f in $(list_modes); do
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
  for f in $(list_modes); do
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

TARGET=""; DO_RESTART=0
for a in "$@"; do
  case "$a" in
    --list)    list_modes; exit 0 ;;
    --restart) DO_RESTART=1 ;;
    -*)        die "unknown flag: $a" ;;
    *)         TARGET="$a" ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  show_status
  exit 0
fi

MODE_FILE="$MODES_DIR/$TARGET.env"
[[ -f "$MODE_FILE" ]] || die "no such mode '$TARGET' — have: $(list_modes | tr '\n' ' ')"

info "applying mode: $TARGET"
CHANGED=0
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

if (( CHANGED == 0 )); then
  ok "already in $TARGET mode — nothing to do"
  exit 0
fi

# A model swap is the expensive case and worth naming separately: recreating
# llama for a sampler change costs the same cold load as changing the weights.
warn "$CHANGED key(s) changed. Nothing is live until llama is recreated."
if (( DO_RESTART )); then
  info "recreating llama (expect a ~9-20 minute cold load)"
  compose up -d --force-recreate llama
  ok "llama recreated — watch it come up with: ./scripts/logs.sh llama"
else
  dim "apply it with:  ./scripts/mode.sh $TARGET --restart"
  dim "            or: docker compose up -d --force-recreate llama"
fi
