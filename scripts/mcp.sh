#!/usr/bin/env bash
#
# Call an MCP server as a CLI, from a client that has no MCP.
#
#   ./scripts/mcp.sh --servers                    what is registered
#   ./scripts/mcp.sh <server> --list --compact    tool names only (~2 tokens each)
#   ./scripts/mcp.sh <server> --search <pattern>  find a tool by name or description
#   ./scripts/mcp.sh <server> <tool> --help       that one tool's arguments
#   ./scripts/mcp.sh <server> <tool> --arg value  call it
#   ./scripts/mcp.sh --install                    install/repair the pinned mcp2cli
#
# Everything after <server> is passed to mcp2cli verbatim, so any flag in
# `mcp2cli --help` works here too.
#
# Servers are declared in mcp/servers.json. The point of the indirection is that
# the model types `./scripts/mcp.sh linear --search issue` rather than a 60-
# character transport string it has to get exactly right, and that credentials
# stay in env: / file: references instead of in a committed file.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REGISTRY="$REPO_ROOT/mcp/servers.json"
VERSION="$(env_get MCP2CLI_VERSION)"; : "${VERSION:=3.3.1}"
MCP_SDK="$(env_get MCP_SDK_VERSION)"; : "${MCP_SDK:=1.29.0}"

# uv tool installs land here, and pi's shell does not necessarily have it on
# PATH — resolving it explicitly means the model never has to debug a PATH.
UV_BIN="${HOME}/.local/bin"
MCP2CLI="${UV_BIN}/mcp2cli"

# --- install -----------------------------------------------------------------
# The mcp SDK pin is load-bearing, not caution. mcp2cli 3.3.1 reads
# `Tool.inputSchema`; the MCP Python SDK renamed that field to `input_schema` in
# 2.0.0, so a plain `uv tool install mcp2cli` resolves 2.0.0 and every MCP call
# dies with AttributeError before it reaches the server. Measured 2026-08-12, on
# the reference server, both ways round. Drop the --with pin once mcp2cli
# supports SDK 2.x, not before.
install_mcp2cli() {
  command -v uv >/dev/null 2>&1 \
    || die "uv is required for mcp2cli — install it: curl -LsSf https://astral.sh/uv/install.sh | sh"
  info "Installing mcp2cli ${VERSION} (with mcp SDK pinned to ${MCP_SDK})"
  uv tool install --force "mcp2cli==${VERSION}" --with "mcp==${MCP_SDK}" \
    || die "uv tool install failed"
  [[ -x "$MCP2CLI" ]] || die "mcp2cli did not land at $MCP2CLI"
  ok "mcp2cli $("$MCP2CLI" --version 2>/dev/null || echo "$VERSION") ready"
}

ensure_mcp2cli() {
  [[ -x "$MCP2CLI" ]] && return 0
  command -v mcp2cli >/dev/null 2>&1 && { MCP2CLI="$(command -v mcp2cli)"; return 0; }
  install_mcp2cli
}

# --- registry ----------------------------------------------------------------
# Reads one server's entry and prints the mcp2cli transport flags for it, NUL
# separated so a command string with spaces survives.
server_flags() {
  local name="$1"
  [[ -f "$REGISTRY" ]] || die "no registry at $REGISTRY"
  REGISTRY="$REGISTRY" NAME="$name" json_eval '
import json, os, sys

reg = json.load(open(os.environ["REGISTRY"], encoding="utf-8"))
servers = reg.get("servers") or {}
name = os.environ["NAME"]
entry = servers.get(name)
if entry is None:
    known = ", ".join(sorted(k for k in servers if not k.startswith("_"))) or "(none)"
    sys.exit(f"unknown server {name!r}. Registered: {known}")

out = []
if entry.get("stdio") and entry.get("url"):
    sys.exit(f"server {name!r} declares both stdio and url — pick one")
if entry.get("stdio"):
    out += ["--mcp-stdio", entry["stdio"]]
    for k, v in (entry.get("env") or {}).items():
        out += ["--env", f"{k}={v}"]
elif entry.get("url"):
    out += ["--mcp", entry["url"]]
    if entry.get("transport"):
        out += ["--transport", entry["transport"]]
else:
    sys.exit(f"server {name!r} declares neither stdio nor url")

hdr = entry.get("auth_header")
for h in ([hdr] if isinstance(hdr, str) else (hdr or [])):
    out += ["--auth-header", h]

sys.stdout.write("\0".join(out))
'
}

list_servers() {
  [[ -f "$REGISTRY" ]] || die "no registry at $REGISTRY"
  REGISTRY="$REGISTRY" json_eval '
import json, os
reg = json.load(open(os.environ["REGISTRY"], encoding="utf-8"))
servers = {k: v for k, v in (reg.get("servers") or {}).items() if not k.startswith("_")}
if not servers:
    print("No servers registered. Add one to mcp/servers.json.")
else:
    for name, e in sorted(servers.items()):
        kind = "stdio" if e.get("stdio") else "url"
        target = e.get("stdio") or e.get("url") or "?"
        desc = e.get("description") or ""
        print(f"{name}\t{kind}\t{target}")
        if desc:
            print("  " + desc)
'
}

# --- dispatch ----------------------------------------------------------------
case "${1:-}" in
  --servers|-s)
    list_servers
    exit 0
    ;;
  --install)
    install_mcp2cli
    exit 0
    ;;
  -h|--help|"")
    sed -n '2,20p' "$0" | sed 's/^# \?//'
    echo
    list_servers
    exit 0
    ;;
esac

SERVER="$1"; shift
ensure_mcp2cli

# NUL-separated so a stdio command containing spaces stays one argument.
FLAGS=()
while IFS= read -r -d '' f; do FLAGS+=("$f"); done < <(server_flags "$SERVER"; printf '\0')
# server_flags exits non-zero with its own message on an unknown name; the
# subshell above cannot propagate that, so check for an empty result instead.
(( ${#FLAGS[@]} )) || die "could not resolve server '$SERVER' — ./scripts/mcp.sh --servers"

exec "$MCP2CLI" "${FLAGS[@]}" "$@"
