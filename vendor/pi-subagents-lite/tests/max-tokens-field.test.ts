/**
 * The output-limit field a subagent's max_tokens is written to.
 *
 * The hook wrote a literal `max_tokens` unless the model's compat named a
 * field. pi itself sends `max_completion_tokens` for most openai-completions
 * providers, this stack's `forge` among them (pi-ai openai-completions.js
 * detectCompat), so an agent with `max_tokens` set sent BOTH fields, and which
 * one the server honoured was the server's choice. Ported from upstream
 * pi-subagents-lite 1.17.1 (max-tokens-field.ts), whose detection list matches
 * pi 1.4.0's.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { applyOutputLimit, resolveMaxTokensField, resolveOutputLimit } from "../src/agents/max-tokens-field.ts";

const forge = { api: "openai-completions", provider: "forge", baseUrl: "http://host.docker.internal:8081/v1" };

describe("resolveOutputLimit", () => {
  it("forge gets max_completion_tokens, the field pi itself sends", () => {
    assert.deepEqual(resolveOutputLimit(forge, 512), { path: ["max_completion_tokens"], value: 512 });
  });

  it("the providers pi detects as max_tokens get max_tokens", () => {
    assert.equal(resolveMaxTokensField({ api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }), "max_tokens");
    assert.equal(resolveMaxTokensField({ api: "openai-completions", provider: "x", baseUrl: "https://llm.chutes.ai/v1" }), "max_tokens");
  });

  it("an explicit compat.maxTokensField wins over detection", () => {
    assert.equal(resolveMaxTokensField({ ...forge, compat: { maxTokensField: "max_tokens" } }), "max_tokens");
  });

  it("other APIs use their own location, and codex none", () => {
    assert.deepEqual(resolveOutputLimit({ api: "anthropic-messages", provider: "anthropic", baseUrl: "" }, 9).path, ["max_tokens"]);
    assert.deepEqual(resolveOutputLimit({ api: "google-vertex", provider: "g", baseUrl: "" }, 9).path, ["config", "maxOutputTokens"]);
    assert.equal(resolveOutputLimit({ api: "openai-codex-responses", provider: "c", baseUrl: "" }, 9), undefined);
    assert.equal(resolveOutputLimit({ api: "openai-responses", provider: "o", baseUrl: "" }, 9)?.value, 16, "Responses rejects < 16");
  });

  it("applyOutputLimit sets a nested path and keeps sibling keys", () => {
    const out = applyOutputLimit({ temperature: 0.2, config: { topP: 1 } }, { path: ["config", "maxOutputTokens"], value: 7 });
    assert.deepEqual(out, { temperature: 0.2, config: { topP: 1, maxOutputTokens: 7 } });
  });
});

describe("the agent-runner hook uses it", () => {
  it("no literal max_tokens default is left", () => {
    const code = readFileSync(new URL("../src/agents/agent-runner.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /maxTokensField \?\? "max_tokens"/);
    assert.match(code, /resolveOutputLimit\(model, maxTokens\)/);
  });
});
