#!/usr/bin/env bash
#
# rtk — compress bash output before it reaches a 32K context window.
#
#   ./scripts/rtk.sh --install    install/repair the pinned rtk binary
#   ./scripts/rtk.sh --status     what is installed, and whether pi will use it
#   ./scripts/rtk.sh --check      verify rtk still behaves the way the allow-list assumes
#   ./scripts/rtk.sh <args...>    run the pinned rtk directly
#
# The extension that wires this into pi lives in vendor/rtk-pi; --check is the
# gate that keeps the two honest about each other. Read vendor/rtk-pi/FORK.md
# before widening anything.
#
# Why a pinned binary rather than `brew install rtk` or the upstream installer:
# rtk shipped 45 minor versions in its first seven months and its filters are
# what this stack is trusting. An unpinned filter set can change what a command
# reports between two sessions with nothing in the checkout to show for it.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VERSION="$(env_get RTK_VERSION)"; : "${VERSION:=0.45.0}"
EXT="$REPO_ROOT/vendor/rtk-pi/extensions/index.ts"
# The allow-list lives in the pi-free half so it can be unit tested; --check
# reads it from there rather than restating it, so there is one source of truth
# for what is filtered.
GATE="$REPO_ROOT/vendor/rtk-pi/src/gate.ts"

# Installed beside mcp2cli, for the same reason: pi's shell does not reliably
# have ~/.local/bin on PATH, so everything here resolves it explicitly.
BIN_DIR="${HOME}/.local/bin"
RTK="${BIN_DIR}/rtk"

# rtk's own telemetry is opt-in and off by default, but this stack is meant to
# run with the network unplugged, so it is pinned off here too rather than left
# to a config file outside the checkout.
export RTK_TELEMETRY_DISABLED=1

# One cleanup for the whole script rather than a RETURN trap per function: a
# RETURN trap does not fire when die() exits, so a failed install or a failed
# check would leave its scratch directory behind every time.
_TMP=""
cleanup() { [[ -n "$_TMP" ]] && rm -rf "$_TMP"; return 0; }
trap cleanup EXIT

# --- install -----------------------------------------------------------------
asset_name() {
  case "$(uname -m)" in
    x86_64|amd64)  printf 'rtk-x86_64-unknown-linux-musl.tar.gz' ;;
    aarch64|arm64) printf 'rtk-aarch64-unknown-linux-gnu.tar.gz' ;;
    *) die "no rtk release build for $(uname -m)" ;;
  esac
}

install_rtk() {
  require_cmd curl tar
  local asset url tmp
  asset="$(asset_name)"
  url="https://github.com/rtk-ai/rtk/releases/download/v${VERSION}/${asset}"
  tmp="$(mktemp -d)"; _TMP="$tmp"

  info "Installing rtk ${VERSION} (${asset})"
  curl -fsSL --max-time 120 -o "$tmp/$asset" "$url" \
    || die "could not download $url"

  # The release ships checksums.txt; a filter set is exactly the kind of thing
  # that should not arrive unverified over a redirect chain.
  if curl -fsSL --max-time 30 -o "$tmp/checksums.txt" \
       "https://github.com/rtk-ai/rtk/releases/download/v${VERSION}/checksums.txt" 2>/dev/null; then
    local want got
    want="$(awk -v a="$asset" '$2 == a || $2 == "*"a {print $1; exit}' "$tmp/checksums.txt")"
    got="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
    if [[ -n "$want" && "$want" != "$got" ]]; then
      die "checksum mismatch for $asset: expected $want, got $got"
    fi
    [[ -n "$want" ]] && ok "sha256 verified"
  else
    warn "checksums.txt was not available — installing an unverified download"
  fi

  tar xzf "$tmp/$asset" -C "$tmp" || die "could not unpack $asset"
  local found
  # No -perm test: the mode inside the archive is upstream's to change, it says
  # nothing about whether the file is the binary, and `install -m 0755` below
  # sets the bit regardless. Requiring it here would turn a repackaging into
  # "no rtk binary inside", which is a misleading way to fail.
  found="$(find "$tmp" -type f -name rtk | head -n1)"
  [[ -n "$found" ]] || die "no rtk binary inside $asset"

  mkdir -p "$BIN_DIR"
  install -m 0755 "$found" "$RTK" || die "could not install to $RTK"
  ok "$("$RTK" --version 2>/dev/null | tr -d '\n') at $RTK"

  command -v rtk >/dev/null 2>&1 \
    || warn "$BIN_DIR is not on PATH — pi will not find rtk. Add it to your shell rc."
}

resolve_rtk() {
  [[ -x "$RTK" ]] && return 0
  command -v rtk >/dev/null 2>&1 && { RTK="$(command -v rtk)"; return 0; }
  return 1
}

# --- status ------------------------------------------------------------------
allow_list() {
  # Single source of truth is the gate. Pulling the entries out of it means
  # --check cannot drift from what pi actually applies.
  [[ -r "$GATE" ]] || die "missing $GATE"
  # Only the quotes are stripped, never the spaces — "git status" is two tokens
  # and a tr that ate them would silently turn the allow-list into gibberish
  # that matches nothing and reports 23 healthy entries while doing so.
  sed -n '/^export const ALLOW/,/^]/p' "$GATE" \
    | sed -n 's/^[[:space:]]*"\([^"]\+\)".*/\1/p'
}

show_status() {
  local enabled; enabled="$(env_get RTK_ENABLED)"
  printf 'RTK_ENABLED=%s (pinned %s)\n' "${enabled:-0}" "$VERSION"
  if resolve_rtk; then
    printf 'binary       %s (%s)\n' "$RTK" "$("$RTK" --version 2>/dev/null | tr -d '\n')"
    local have; have="$("$RTK" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
    [[ -n "$have" && "$have" != "$VERSION" ]] \
      && warn "installed rtk $have does not match the pinned $VERSION — ./scripts/rtk.sh --install"
  else
    printf 'binary       not installed — ./scripts/rtk.sh --install\n'
  fi
  printf 'extension    %s\n' "$([[ -r "$EXT" ]] && echo "$EXT" || echo 'MISSING')"
  printf 'filtering    %s commands: %s\n' \
    "$(allow_list | wc -l)" "$(allow_list | awk 'NR>1{printf ", "}{printf "%s", $0}')"
  printf 'everything else runs unfiltered. RTK_DISABLED=1 turns the rest off.\n'
}

# --- check -------------------------------------------------------------------
# The regression gate. rtk's filters are upstream's to change, and a filter that
# starts summarising, or stops rewriting, does it silently. These are the
# invariants vendor/rtk-pi assumes; if one breaks, the allow-list is wrong until
# someone re-measures it.
run_check() {
  resolve_rtk || die "rtk is not installed — ./scripts/rtk.sh --install"
  local bad=0 tmp
  tmp="$(mktemp -d)"; _TMP="$tmp"

  info "Every allow-listed command still rewrites"
  while IFS= read -r cmd; do
    [[ -z "$cmd" ]] && continue
    # A few filters only match a complete invocation — bare `find` is not a
    # command rtk (or find) can do anything with, so probing the prefix alone
    # would report a healthy entry as broken. Args are added only where the
    # prefix is not itself runnable.
    local probe="$cmd"
    case "$cmd" in
      find) probe="find . -name '*.rs'" ;;
    esac
    local out
    # `|| true` because pipefail plus a grep that matches nothing is exactly the
    # shape of "rtk stopped rewriting this" — the case this check exists to
    # report, not to die on.
    out="$("$RTK" rewrite "$probe" 2>/dev/null | grep -v '^\[rtk\]' | grep -v '^$' | tail -n1 || true)"
    if [[ "$out" == rtk\ * ]]; then
      printf '  %-18s -> %s\n' "$cmd" "$out"
    else
      warn "  $cmd is allow-listed but rtk no longer rewrites it (probed: $probe, got: ${out:-<nothing>})"
      bad=1
    fi
  done < <(allow_list)

  # The one that matters most. `cat` is rewritten to `rtk read`, and rtk's README
  # describes read as returning "signatures and structure over full bodies". On
  # 0.45.0 it returns the file, byte for byte, at every size tried — which is why
  # cat is only kept off the allow-list as insurance rather than as a fix. If
  # this ever fails, that insurance became load-bearing: say so loudly.
  info "rtk read is still byte-identical to cat"
  python3 - "$tmp/fixture.rs" <<'PY'
import sys
with open(sys.argv[1], "w") as f:
    for i in range(400):
        f.write("fn f%d(a: u32) -> u32 {\n    let v = a * %d;\n    v + 1\n}\n\n" % (i, i))
PY
  if cmp -s <("$RTK" read "$tmp/fixture.rs" 2>/dev/null) "$tmp/fixture.rs"; then
    ok "  $(wc -c < "$tmp/fixture.rs") bytes in, identical out"
  else
    warn "  rtk read now differs from cat — re-check that cat/head/tail stay denied"
    bad=1
  fi

  # find IS allow-listed, and it is the one filter here that reformats rather
  # than trims — above a certain tree size it stops printing paths and starts
  # grouping filenames under their directory, so "did it drop any" is not
  # answerable by eye. Compare the file SETS, not the line counts: counting lines
  # is how the grouping first got mistaken for 32 missing files. Basenames on
  # both sides, because which of the two shapes comes back depends on the tree.
  info "rtk find still returns every file"
  mkdir -p "$tmp/tree/a/b" "$tmp/tree/c"
  touch "$tmp/tree/one.rs" "$tmp/tree/a/two.rs" "$tmp/tree/a/b/three.rs" "$tmp/tree/c/four.rs"
  if diff -q \
       <(find "$tmp/tree" -name '*.rs' -printf '%f\n' | sort -u) \
       <("$RTK" find "$tmp/tree" -name '*.rs' 2>/dev/null \
           | tr ' ' '\n' | grep '\.rs$' | sed 's#.*/##' | sort -u) \
       >/dev/null; then
    ok "  same file set as find"
  else
    warn "  rtk find no longer returns the same file set — drop it from the allow-list"
    bad=1
  fi

  # The worst thing an allow-listed filter could do: turn a hard failure into a
  # benign-looking summary. Upstream #2317 reports exactly that for pytest
  # ("collection error -> No tests collected"); it does not reproduce on 0.45.0,
  # which is why pytest is allow-listed at all. Pinned here so that stays true.
  # A masked failure on this stack means the model reports a green run and moves
  # on, which is worse than no filtering at all.
  info "A hard pytest failure is still reported as one"
  mkdir -p "$tmp/collerr"
  printf 'import nonexistent_module_xyz\n\ndef test_a():\n    assert True\n' \
    > "$tmp/collerr/test_bad.py"
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import pytest' 2>/dev/null; then
    local pyout
    local pycode=0
    # `|| pycode=$?` rather than a bare `; pycode=$?`: this command is EXPECTED
    # to fail, and under `set -e` the assignment aborts the function before the
    # next line ever runs — so the check would die instead of reporting.
    pyout="$(cd "$tmp/collerr" && "$RTK" pytest -q 2>&1)" || pycode=$?
    if (( pycode == 0 )); then
      warn "  rtk pytest exited 0 on a collection error — pytest must leave the allow-list"
      bad=1
    elif ! grep -qi 'nonexistent_module_xyz\|ModuleNotFoundError\|error' <<<"$pyout"; then
      warn "  rtk pytest hid what failed (exit $pycode but no error named)"
      bad=1
    else
      ok "  exit $pycode, and the failing import is named"
    fi
  else
    dim "  skipped: pytest is not installed"
  fi

  info "The rewrites the extension refuses still deserve it"
  # Not assertions that rtk is broken — a record of why FORK.md says what it
  # says, re-run against the binary that is actually installed. Informational:
  # these are reported, never fatal, because upstream fixing one of them is good
  # news that should not fail a check.
  for c in "npm run lint" "uv run pytest"; do
    dim "  $c -> $("$RTK" rewrite "$c" 2>/dev/null | grep -v '^\[rtk\]' | tail -n1)"
  done

  (( bad )) && die "rtk no longer behaves the way vendor/rtk-pi assumes — re-measure before shipping"
  ok "rtk ${VERSION} matches the assumptions in vendor/rtk-pi"
}

# --- dispatch ----------------------------------------------------------------
case "${1:-}" in
  --install) install_rtk; exit 0 ;;
  --status)  show_status; exit 0 ;;
  --check)   run_check;   exit 0 ;;
  -h|--help|"")
    sed -n '2,18p' "$0" | sed 's/^# \?//'
    echo
    show_status
    exit 0
    ;;
esac

resolve_rtk || die "rtk is not installed — ./scripts/rtk.sh --install"
exec "$RTK" "$@"
