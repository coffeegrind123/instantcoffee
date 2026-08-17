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

export ZENDRIVER_MCP_DIR="$DIR"
export BROWSER_MCP_HOST="$HOST"
export BROWSER_MCP_PORT="$PORT"
export BROWSER_MCP_DISPLAY="$DISP"
export BROWSER_MCP_AUTOSTART="$AUTO"
export BROWSER_MCP_TIMEOUT="$TMO"
export ZENDRIVER_MCP_TOOL_TIMEOUT="$TOOLTMO"

exec python3 "$REPO_ROOT/scripts/browser_cli.py" "$@"
