#!/usr/bin/env bash
# Install the forge agent adapters into a Harbor checkout.
#
# Usage:
#   ./install-into-harbor.sh /path/to/harbor
#   HARBOR_DIR=/path/to/harbor ./install-into-harbor.sh
#
# Idempotent: copies forge_claude.py and registers the agent in
# AgentName (name.py) and AgentFactory._AGENT_MAP (factory.py).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARBOR_DIR="${1:-${HARBOR_DIR:-}}"

if [ -z "$HARBOR_DIR" ]; then
  echo "usage: $0 /path/to/harbor   (or set HARBOR_DIR)" >&2
  exit 2
fi
if [ ! -f "$HARBOR_DIR/src/harbor/agents/factory.py" ]; then
  echo "error: '$HARBOR_DIR' does not look like a harbor checkout" \
       "(missing src/harbor/agents/factory.py)" >&2
  exit 1
fi

# --- copy adapter files ---
cp "$HERE/forge_claude.py" "$HARBOR_DIR/src/harbor/agents/installed/forge_claude.py"
echo "copied -> src/harbor/agents/installed/forge_claude.py"

# --- register in AgentName and factory ---
python3 - "$HARBOR_DIR" <<'PY'
import re, sys
from pathlib import Path

harbor = Path(sys.argv[1])

# 1) Register the enum member in AgentName.
name_py = harbor / "src/harbor/models/agent/name.py"
text = name_py.read_text()
if 'FORGE_CLAUDE = "forge-claude"' not in text:
    text, n = re.subn(
        r'(\n([ \t]*)CLAUDE_CODE = "claude-code"\n)',
        r'\1\2FORGE_CLAUDE = "forge-claude"\n',
        text,
        count=1,
    )
    if n != 1:
        sys.exit("could not locate CLAUDE_CODE member in name.py")
    name_py.write_text(text)
    print("patched name.py: + FORGE_CLAUDE")
else:
    print("name.py already has FORGE_CLAUDE")

# 2) Register the class in AgentFactory._AGENT_MAP.
factory_py = harbor / "src/harbor/agents/factory.py"
text = factory_py.read_text()
if "AgentName.FORGE_CLAUDE:" not in text:
    text, n = re.subn(
        r'(\n([ \t]*)AgentName\.CLAUDE_CODE: "harbor\.agents\.installed\.claude_code:ClaudeCode",\n)',
        r'\1\2AgentName.FORGE_CLAUDE: "harbor.agents.installed.forge_claude:ForgeClaude",\n',
        text,
        count=1,
    )
    if n != 1:
        sys.exit("could not locate CLAUDE_CODE entry in factory._AGENT_MAP")
    factory_py.write_text(text)
    print("patched factory.py: + AgentName.FORGE_CLAUDE")
else:
    print("factory.py already has AgentName.FORGE_CLAUDE")
PY

echo ""
echo "done. verify with:"
echo "  cd '$HARBOR_DIR' && uv run python -c \"from harbor.agents.factory import AgentFactory; from harbor.models.agent.name import AgentName; print(AgentFactory.get_agent_class(AgentName.FORGE_CLAUDE))\""
