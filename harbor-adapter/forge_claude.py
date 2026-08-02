"""Harbor agent adapter for Claude Code -> local forge proxy (qwen3.6-forge).

Subclass of Harbor's ``ClaudeCode`` agent tuned for the local forge stack.

Differences from stock ``ClaudeCode``:

* **Auth**: preserves ``ANTHROPIC_AUTH_TOKEN`` as Bearer (stock collapses to
  x-api-key; forge rejects that).
* **MCP disabled**: ``--strict-mcp-config --mcp-config '{"mcpServers":{}}'``.
  The single biggest context win — the parent would register every configured
  MCP server (ghidra alone is 245 tool schemas) and blow the 64K window.
* **Prompt caching off**: ``DISABLE_PROMPT_CACHING=1`` — cache_control is
  dropped in Anthropic->OpenAI translation; asking for it only adds blocks
  that go nowhere.
* **Subagent depth 1**: ``CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`` — each
  level is another full context on one GPU serving one slot.
* **Model aliases mirrored**: all roles (Sonnet/Opus/Haiku/subagent) pinned
  to the single local model so nothing silently falls back to a hosted API.

Mirrors the exact flags from ``scripts/claude-local.sh``.
"""

import json
import shlex
import uuid
from typing import override

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.agent.name import AgentName
from harbor.models.trial.paths import EnvironmentPaths


class ForgeClaude(ClaudeCode):
    """Claude Code pointed at a local forge proxy (llama.cpp + Qwen)."""

    SUPPORTS_ATIF: bool = True
    SUPPORTS_RESUME: bool = True

    @staticmethod
    @override
    def name() -> str:
        return AgentName.FORGE_CLAUDE.value

    def _resolve_model(self) -> str | None:
        """Strip ``forge/`` routing prefix; keep bare model id for the backend."""
        explicit = self._get_env("ANTHROPIC_MODEL")
        if explicit:
            return explicit
        if not self.model_name:
            return None
        if "/" in self.model_name:
            return self.model_name.split("/", 1)[1]
        return self.model_name

    @override
    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        escaped_instruction = shlex.quote(instruction)

        # ── auth (Bearer-first — forge needs it) ──────────────────────────
        base_url = self._get_env("ANTHROPIC_BASE_URL") or ""
        auth_token = (self._get_env("ANTHROPIC_AUTH_TOKEN") or "").strip()
        api_key = (self._get_env("ANTHROPIC_API_KEY") or "").strip()

        if not auth_token and not api_key:
            raise RuntimeError(
                "forge-claude needs credentials. Set ANTHROPIC_AUTH_TOKEN "
                "(Bearer, for forge) or ANTHROPIC_API_KEY (direct Anthropic)."
            )

        env: dict[str, str] = {}
        if auth_token:
            env["ANTHROPIC_AUTH_TOKEN"] = auth_token
        if api_key:
            env["ANTHROPIC_API_KEY"] = api_key
        if base_url:
            env["ANTHROPIC_BASE_URL"] = base_url

        # ── model ─────────────────────────────────────────────────────────
        model = self._resolve_model()
        if model:
            env["ANTHROPIC_MODEL"] = model
            if base_url:
                for alias in (
                    "ANTHROPIC_DEFAULT_SONNET_MODEL",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                    "CLAUDE_CODE_SUBAGENT_MODEL",
                ):
                    env[alias] = model

        # ── tuned knobs (from claude-local.sh) ────────────────────────────
        # cache_control is dropped in Anthropic→OpenAI translation; stop building blocks
        env["DISABLE_PROMPT_CACHING"] = "1"
        # subagents default to nesting 3 deep — one GPU, one slot per level
        env["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"] = "1"
        # must outlast forge's --backend-timeout (600 s)
        env["API_TIMEOUT_MS"] = "1800000"

        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        env["IS_SANDBOX"] = "1"
        env["FORCE_AUTO_BACKGROUND_TASKS"] = "1"
        env["ENABLE_BACKGROUND_TASKS"] = "1"

        # Forward optional env knobs
        for key in ("CLAUDE_CODE_MAX_OUTPUT_TOKENS",):
            val = self._get_env(key)
            if val:
                env[key] = val

        env.update(self._resolved_env_vars)
        env["CLAUDE_CONFIG_DIR"] = (EnvironmentPaths.agent_dir / "sessions").as_posix()
        env = {k: v for k, v in env.items() if v}

        # ── setup (MCP intentionally skipped — see class docstring) ───────
        setup_command = (
            "mkdir -p $CLAUDE_CONFIG_DIR/debug $CLAUDE_CONFIG_DIR/projects/-app "
            "$CLAUDE_CONFIG_DIR/shell-snapshots $CLAUDE_CONFIG_DIR/statsig "
            "$CLAUDE_CONFIG_DIR/todos $CLAUDE_CONFIG_DIR/skills && "
            "if [ -d ~/.claude/skills ]; then "
            "cp -r ~/.claude/skills/. $CLAUDE_CONFIG_DIR/skills/ 2>/dev/null || true; "
            "fi"
        )
        skills_command = self._build_register_skills_command()
        if skills_command:
            setup_command += f" && {skills_command}"
        memory_command = self._build_register_memory_command()
        if memory_command:
            setup_command += f" && {memory_command}"
        # NOTE: no MCP registration — the run command below passes
        # --strict-mcp-config with an empty config instead.

        # ── CLI flags ─────────────────────────────────────────────────────
        base_flags = self.build_cli_flags()  # e.g. --permission-mode=bypassPermissions
        extra_flags = (base_flags + " ") if base_flags else ""
        resume_flag = "--continue " if self._resume else ""

        # Most important flag: kill every configured MCP server for this
        # session.  Without it the ghidra MCP server alone publishes ~245
        # tool schemas that would eat the 64K context window before the
        # first message.  See scripts/claude-local.sh.
        mcp_flag = f"--strict-mcp-config --mcp-config {shlex.quote(json.dumps({'mcpServers': {}}))} "

        await self.exec_as_agent(environment, command=setup_command, env=env)

        # ── run (pipe instruction via stdin, identical to parent) ─────────
        instruction_shell_var = f"harbor_claude_code_instruction_{uuid.uuid4().hex}"
        instruction_env_var = instruction_shell_var.upper()
        run_env = {**env, instruction_env_var: instruction}

        await self.exec_as_agent(
            environment,
            command=(
                'export PATH="$HOME/.local/bin:$PATH"; '
                f'{instruction_shell_var}="${instruction_env_var}"; '
                f"unset {instruction_env_var}; "
                f'printf "%s" "${instruction_shell_var}" | '
                f"claude --verbose --output-format=stream-json "
                f"{mcp_flag}"
                f"{extra_flags}"
                f"{resume_flag}"
                f"--print 2>&1 | tee "
                f"/logs/agent/claude-code.txt"
            ),
            env=run_env,
        )
