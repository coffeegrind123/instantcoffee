"""Unit tests for the forge-claude Harbor adapter — auth wiring, model routing,
Bearer token preservation, and MCP-skip default.

Run from the harbor-eval directory:
    cd harbor-eval && uv run pytest ../adapter/test_forge_claude.py -q
"""

from unittest.mock import AsyncMock

import pytest

from harbor.agents.installed.forge_claude import ForgeClaude
from harbor.models.agent.name import AgentName


def _mock_env():
    env = AsyncMock()
    env.default_user = "agent"
    env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
    return env


def _exec_calls(mock_env):
    return mock_env.exec.call_args_list


def _run_call(mock_env):
    for call in _exec_calls(mock_env):
        cmd = call.kwargs.get("command", "")
        if "--output-format=stream-json" in cmd and "--print" in cmd:
            return call
    raise AssertionError("no forge-claude run command found")


def _clear_env(monkeypatch):
    for var in (
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MAX_THINKING_TOKENS",
    ):
        monkeypatch.delenv(var, raising=False)


def test_name():
    assert ForgeClaude.name() == AgentName.FORGE_CLAUDE.value == "forge-claude"


class TestAuth:
    @pytest.mark.asyncio
    async def test_bearer_token_preserved(self, monkeypatch, temp_dir):
        """forge authenticates via Bearer — the token must stay in
        ANTHROPIC_AUTH_TOKEN, NOT be collapsed to ANTHROPIC_API_KEY."""
        _clear_env(monkeypatch)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "local")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://host.docker.internal:8081")
        agent = ForgeClaude(logs_dir=temp_dir, model_name="forge/qwen3.6-27b")
        mock_env = _mock_env()
        await agent.run("do something", mock_env, AsyncMock())
        env = _run_call(mock_env).kwargs["env"]
        assert env["ANTHROPIC_AUTH_TOKEN"] == "local"
        assert "ANTHROPIC_API_KEY" not in env
        assert env["ANTHROPIC_BASE_URL"] == "http://host.docker.internal:8081"

    @pytest.mark.asyncio
    async def test_no_credentials_raises(self, monkeypatch, temp_dir):
        _clear_env(monkeypatch)
        agent = ForgeClaude(logs_dir=temp_dir, model_name="forge/qwen3.6-27b")
        mock_env = _mock_env()
        with pytest.raises(RuntimeError, match="ANTHROPIC_AUTH_TOKEN"):
            await agent.run("do something", mock_env, AsyncMock())


class TestModelRouting:
    @pytest.mark.asyncio
    async def test_forge_prefix_stripped(self, monkeypatch, temp_dir):
        _clear_env(monkeypatch)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "local")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://host.docker.internal:8081")
        agent = ForgeClaude(logs_dir=temp_dir, model_name="forge/qwen3.6-27b")
        mock_env = _mock_env()
        await agent.run("x", mock_env, AsyncMock())
        env = _run_call(mock_env).kwargs["env"]
        assert env["ANTHROPIC_MODEL"] == "qwen3.6-27b"

    @pytest.mark.asyncio
    async def test_aliases_mirrored_with_custom_base_url(self, monkeypatch, temp_dir):
        _clear_env(monkeypatch)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "local")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://host.docker.internal:8081")
        agent = ForgeClaude(logs_dir=temp_dir, model_name="forge/qwen3.6-27b")
        mock_env = _mock_env()
        await agent.run("x", mock_env, AsyncMock())
        env = _run_call(mock_env).kwargs["env"]
        for alias in (
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
        ):
            assert env[alias] == "qwen3.6-27b", f"missing alias {alias}"

    @pytest.mark.asyncio
    async def test_explicit_env_model_wins(self, monkeypatch, temp_dir):
        _clear_env(monkeypatch)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "local")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://host.docker.internal:8081")
        monkeypatch.setenv("ANTHROPIC_MODEL", "my-custom-model")
        agent = ForgeClaude(logs_dir=temp_dir, model_name="forge/qwen3.6-27b")
        mock_env = _mock_env()
        await agent.run("x", mock_env, AsyncMock())
        env = _run_call(mock_env).kwargs["env"]
        assert env["ANTHROPIC_MODEL"] == "my-custom-model"


class TestDefaults:
    @pytest.mark.asyncio
    async def test_sandbox_and_telemetry_defaults(self, monkeypatch, temp_dir):
        _clear_env(monkeypatch)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "local")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://host.docker.internal:8081")
        agent = ForgeClaude(logs_dir=temp_dir, model_name="forge/qwen3.6-27b")
        mock_env = _mock_env()
        await agent.run("x", mock_env, AsyncMock())
        env = _run_call(mock_env).kwargs["env"]
        assert env["IS_SANDBOX"] == "1"
        assert env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"

    @pytest.mark.asyncio
    async def test_run_command_shape(self, monkeypatch, temp_dir):
        _clear_env(monkeypatch)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "local")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://host.docker.internal:8081")
        agent = ForgeClaude(logs_dir=temp_dir, model_name="forge/qwen3.6-27b")
        mock_env = _mock_env()
        await agent.run("solve it", mock_env, AsyncMock())
        cmd = _run_call(mock_env).kwargs["command"]
        assert "claude --verbose --output-format=stream-json" in cmd
        assert "--print --" in cmd
        assert "tee /logs/agent/claude-code.txt" in cmd
