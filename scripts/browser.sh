#!/usr/bin/env bash
#
# A real browser, from the shell.
#
#   ./scripts/browser.sh up                       start the long-lived server
#   ./scripts/browser.sh status                   is it up, and is a page open
#   ./scripts/browser.sh --list --compact         every tool name (~2 tokens each)
#   ./scripts/browser.sh --search cookie          find a tool
#   ./scripts/browser.sh <tool> --help            that one tool's parameters
#   ./scripts/browser.sh navigate --url https://example.com
#   ./scripts/browser.sh down                     stop Chrome and the server
#
# This drives the Zendriver MCP server (CDP, not WebDriver, so it is not
# detected as automation) over HTTP. Unlike ./scripts/mcp.sh, the server is
# started ONCE and left running: a browser is stateful, and mcp2cli spawns a
# fresh server per call — the page you opened would be gone by the next
# command. See scripts/browser_cli.py for the measurements behind that.
#
# Knobs live in .env under "Browser". The checkout it runs is
# ZENDRIVER_MCP_DIR; nothing here is vendored, because Chrome and zendriver are
# a 400 MB dependency that has no business inside this repo.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd python3

# ZENDRIVER_MCP_DIR may be unset in an older .env — fall back to the places the
# checkout normally lives rather than failing on a knob nobody added yet.
#
# A candidate has to SUPPORT --transport, not merely exist. A stale clone from
# before the HTTP transport landed satisfies `-f run.py` perfectly well, and then
# every knob here points at a server that speaks only stdio and is missing 63
# tools — a wrong answer that looks like a working one. (One such clone sat in
# $HOME until 2026-08-16.)
DIR="$(env_get ZENDRIVER_MCP_DIR)"
if [[ -z "$DIR" ]]; then
  for cand in /opt/zendriver-mcp "$HOME/Zendriver-MCP" "$HOME/zendriver-mcp"; do
    [[ -f "$cand/run.py" ]] && grep -q -- "--transport" "$cand/run.py" && { DIR="$cand"; break; }
  done
fi
if [[ -n "$DIR" && -f "$DIR/run.py" ]] && ! grep -q -- "--transport" "$DIR/run.py"; then
  die "the Zendriver MCP checkout at $DIR predates the HTTP transport.
     This stack needs 'run.py --transport streamable-http'. Update it:
       git -C '$DIR' pull"
fi

PORT="$(env_get BROWSER_MCP_PORT)";      : "${PORT:=8931}"
HOST="$(env_get BROWSER_MCP_HOST)";      : "${HOST:=127.0.0.1}"
# Chrome needs an X display. The container already runs Xvfb on :99; a desktop
# machine wants the session's own DISPLAY, which is why this is a knob and not a
# constant. Empty means "whatever the environment already has".
DISP="$(env_get BROWSER_MCP_DISPLAY)";   : "${DISP:=${DISPLAY:-}}"
AUTO="$(env_get BROWSER_MCP_AUTOSTART)"; : "${AUTO:=1}"
TMO="$(env_get BROWSER_MCP_TIMEOUT)";    : "${TMO:=180}"
# The server's own per-tool budget, which is NOT the same number as the CLI's.
# It has to sit below whatever client is waiting (pi's adapter: 30s) or the
# client times out first and the model gets a transport error instead of the
# server's own "exceeded its Ns time budget".
TOOLTMO="$(env_get BROWSER_MCP_TOOL_TIMEOUT)"; : "${TOOLTMO:=25}"

# ---------------------------------------------------------------------------
# An X display that is actually there.
#
# The comment above used to assert "the container already runs Xvfb on :99". It
# does not, and the failure is invisible: /tmp/.X11-unix/X99 SURVIVES the
# process that created it, so the socket file exists, $DISPLAY looks valid, and
# nothing says otherwise until Chrome refuses to launch with
#
#     Chrome cannot start headed: no X server is reachable ($DISPLAY=':99' is
#     set but nothing is listening on it)
#
# — at which point the browser runs headless, and headless is what Bing and most
# news sites block or stall. Measured 2026-08-24: a session burned minutes on
# 404s and navigate calls timing out past the server's 25s budget, and every one
# of them was this. Chrome opens in 2s and Bing settles in 3.6s once an X server
# is genuinely listening.
#
# So: probe the display rather than trust it, and start Xvfb when it is absent.
# A stale socket is removed first — Xvfb refuses to bind over one.
ensure_display() {
  [[ -n "$DISP" ]] || return 0
  if command -v xdpyinfo >/dev/null 2>&1; then
    DISPLAY="$DISP" xdpyinfo >/dev/null 2>&1 && return 0
  elif pgrep -f "Xvfb ${DISP} " >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v Xvfb >/dev/null 2>&1; then
    warn "no X server on ${DISP} and Xvfb is not installed — Chrome will fall back to headless,"
    warn "which many sites block. Install Xvfb, or point BROWSER_MCP_DISPLAY at a real display."
    return 0
  fi
  local num="${DISP#:}"; num="${num%%.*}"
  rm -f "/tmp/.X11-unix/X${num}" 2>/dev/null || true
  echo "  starting Xvfb on ${DISP} (nothing was listening)"
  nohup Xvfb "$DISP" -screen 0 1920x1080x24 -nolisten tcp \
    >"${TMPDIR:-/tmp}/xvfb${num}.log" 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    if command -v xdpyinfo >/dev/null 2>&1; then
      DISPLAY="$DISP" xdpyinfo >/dev/null 2>&1 && return 0
    elif [[ -S "/tmp/.X11-unix/X${num}" ]]; then
      return 0
    fi
  done
  warn "Xvfb did not come up on ${DISP}; see ${TMPDIR:-/tmp}/xvfb${num}.log"
}
case "${1:-}" in
  up|restart|navigate|start_browser) ensure_display ;;
  *) [[ -n "${BROWSER_MCP_AUTOSTART:-1}" ]] && ensure_display ;;
esac

export ZENDRIVER_MCP_DIR="$DIR"
export BROWSER_MCP_HOST="$HOST"
export BROWSER_MCP_PORT="$PORT"
export BROWSER_MCP_DISPLAY="$DISP"
export BROWSER_MCP_AUTOSTART="$AUTO"
export BROWSER_MCP_TIMEOUT="$TMO"
export ZENDRIVER_MCP_TOOL_TIMEOUT="$TOOLTMO"

exec python3 "$REPO_ROOT/scripts/browser_cli.py" "$@"
