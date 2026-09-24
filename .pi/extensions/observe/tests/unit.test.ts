/**
 * Unit tests for the observe extension's pure parts.
 *
 *   node --experimental-strip-types --no-warnings --test .pi/extensions/observe/tests/*.test.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	backgroundAgentId,
	clip,
	clipDeep,
	contentText,
	llmGeneration,
	parseChildName,
	postToolUse,
	type Identity,
} from "../src/mapper.ts";
import { SpawnRegistry } from "../src/linker.ts";
import { Sender } from "../src/sender.ts";

const ROOT: Identity = {
	sessionId: "root-1",
	transcriptPath: "/home/u/.pi/agent/sessions/x.jsonl",
	cwd: "/work",
	sessionName: null,
	agent: null,
};

describe("mapper", () => {
	test("clip reports what it cut", () => {
		assert.equal(clip("short", 10), "short");
		const out = clip("abcdefghij", 4);
		assert.ok(out.startsWith("abcd"));
		assert.match(out, /truncated 6 of 10 chars/);
	});

	test("clipDeep bounds nested strings without touching other types", () => {
		const out = clipDeep({ a: "xxxxxxxx", b: [1, "yyyyyyyy"], c: null, d: true }, 3) as Record<string, unknown>;
		assert.match(out.a as string, /^xxx\n…\[truncated/);
		assert.equal((out.b as unknown[])[0], 1);
		assert.equal(out.c, null);
		assert.equal(out.d, true);
	});

	test("contentText joins text blocks and marks images", () => {
		assert.equal(contentText([{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }, { type: "text", text: "b" }]), "a\n[image image/png]\nb");
		assert.equal(contentText("plain"), "plain");
		assert.equal(contentText(undefined), "");
	});

	test("llmGeneration maps pi usage and derives timing", () => {
		const env = llmGeneration(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "hello" },
					{ type: "toolCall", id: "call_1", name: "read" },
				],
				provider: "forge",
				model: "qwen3.8-27b",
				responseId: "chatcmpl-1",
				stopReason: "toolUse",
				usage: { input: 196, output: 106, cacheRead: 5615, cacheWrite: 0, reasoning: 0, totalTokens: 5917, cost: { total: 0 } },
			},
			ROOT,
			1500,
			{ requestAt: 1000, firstTokenAt: 1200, status: 200, turnIndex: 3 },
			{ tokens: 5917, contextWindow: 98304, percent: 6 },
			1000,
		);

		assert.equal(env.hook_event_name, "LLMGeneration");
		assert.equal(env.agent_class, "pi");
		assert.equal(env.model, "qwen3.8-27b");
		assert.equal(env.provider, "forge");
		assert.equal(env.input_tokens, 196);
		assert.equal(env.output_tokens, 106);
		assert.equal(env.cache_read_tokens, 5615);
		assert.equal(env.ttft_ms, 200);
		assert.equal(env.duration_ms, 500);
		assert.equal(env.turn_index, 3);
		assert.equal(env.text, "hello");
		assert.equal(env.thinking, "plan");
		assert.deepEqual(env.tool_calls, [{ id: "call_1", name: "read" }]);
		assert.equal(env.context_window, 98304);
		assert.equal(env.transcript_path, ROOT.transcriptPath);
	});

	test("llmGeneration without a request timestamp omits timing rather than inventing it", () => {
		const env = llmGeneration({ role: "assistant" }, ROOT, 1500, { requestAt: null, firstTokenAt: null, status: null, turnIndex: null }, null, 1000);
		assert.equal("duration_ms" in env, false);
		assert.equal("ttft_ms" in env, false);
	});

	test("postToolUse marks failures and measures duration from the paired start", () => {
		const env = postToolUse(
			{ toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "boom" }] }, isError: true },
			{ toolCallId: "c1", toolName: "bash", input: { command: "false" }, startedAt: 100 },
			ROOT,
			350,
			null,
			1000,
		);
		assert.equal(env.hook_event_name, "PostToolUseFailure");
		assert.equal(env.error, "boom");
		assert.equal(env.duration_ms, 250);
		assert.deepEqual(env.tool_input, { command: "false" });
	});

	test("child naming and background ids", () => {
		assert.deepEqual(parseChildName("general-purpose#e8181b66"), { type: "general-purpose", shortId: "e8181b66" });
		assert.equal(parseChildName("my session"), null);
		assert.equal(backgroundAgentId("Started.\nAgent ID: e8181b66a1b2c3d4\n"), "e8181b66a1b2c3d4");
		assert.equal(backgroundAgentId("2"), null);
	});
});

describe("SpawnRegistry", () => {
	test("claims the pending Agent call of the child's type", () => {
		const r = new SpawnRegistry();
		r.onAgentCall("call_a", "root", { _resolvedAgent: "explorer", description: "look" }, 1);
		r.onAgentCall("call_b", "root", { _resolvedAgent: "general-purpose", description: "count" }, 2);

		const child = r.claim("child-1", "general-purpose#e8181b66");
		assert.equal(child.parentToolUseId, "call_b");
		assert.equal(child.agentType, "general-purpose");
		assert.equal(child.description, "count");
		assert.equal(r.pendingCount(), 1);
	});

	test("same type is first-in-first-out", () => {
		const r = new SpawnRegistry();
		r.onAgentCall("call_1", "root", { _resolvedAgent: "worker" }, 1);
		r.onAgentCall("call_2", "root", { _resolvedAgent: "worker" }, 2);
		assert.equal(r.claim("c1", "worker#aaaaaaaa").parentToolUseId, "call_1");
		assert.equal(r.claim("c2", "worker#bbbbbbbb").parentToolUseId, "call_2");
	});

	test("an unnamed first sighting claims FIFO and is refined when the name arrives", () => {
		const r = new SpawnRegistry();
		r.onAgentCall("call_1", "root", {}, 1);
		const first = r.claim("c1", null);
		assert.equal(first.parentToolUseId, "call_1");
		const again = r.claim("c1", "general-purpose#12345678");
		assert.equal(again, first);
		assert.equal(again.agentName, "general-purpose#12345678");
	});

	test("an in-memory session nobody spawned still gets an identity, unlinked", () => {
		const r = new SpawnRegistry();
		const judge = r.claim("j1", null);
		assert.equal(judge.parentToolUseId, null);
		assert.equal(judge.agentType, "session");
	});

	test("a background result re-points the child at its true call", () => {
		const r = new SpawnRegistry();
		r.onAgentCall("call_x", "root", { _resolvedAgent: "worker", run_in_background: true }, 1);
		r.onAgentCall("call_y", "root", { _resolvedAgent: "worker", run_in_background: true }, 2);
		// Spawn order and child start order disagree: FIFO guesses wrong...
		const c = r.claim("c1", "worker#bbbbbbbb");
		assert.equal(c.parentToolUseId, "call_x");
		// ...and the exact id in call_y's result corrects it.
		assert.equal(r.onBackgroundId("call_y", "bbbbbbbb-0000-0000"), c);
		assert.equal(c.parentToolUseId, "call_y");
		assert.equal(c.background, true);
	});

	test("a grandchild links to the child whose SubAgent call spawned it", () => {
		const r = new SpawnRegistry();
		r.onAgentCall("call_top", "root", { _resolvedAgent: "worker" }, 1);
		const child = r.claim("child", "worker#aaaaaaaa");
		assert.equal(child.parentAgentId, null);

		r.onAgentCall("call_nested", "root", { agent: "explorer", description: "dig" }, 2, "child");
		const grandchild = r.claim("grand", "explorer#bbbbbbbb");
		assert.equal(grandchild.parentToolUseId, "call_nested");
		assert.equal(grandchild.parentAgentId, "child");
	});

	test("an Agent call that never produced a child stops being pending", () => {
		const r = new SpawnRegistry();
		r.onAgentCall("call_1", "root", {}, 1);
		r.onAgentEnd("call_1");
		assert.equal(r.pendingCount(), 0);
	});
});

describe("Sender", () => {
	function fakeFetch(plan: Array<number | Error>) {
		const calls: Array<{ url: string; body: unknown }> = [];
		let i = 0;
		const fn = (async (url: string, init: { body: string }) => {
			calls.push({ url, body: JSON.parse(init.body) });
			const step = plan[Math.min(i++, plan.length - 1)];
			if (step instanceof Error) {
				throw step;
			}
			return new Response("nope", { status: step });
		}) as unknown as typeof fetch;
		return { fn, calls };
	}

	test("delivers in order with the project slug in meta", async () => {
		const { fn, calls } = fakeFetch([201]);
		const s = new Sender({ url: "http://obs", projectSlug: "proj", timeoutMs: 100, maxQueue: 10, backoffMs: 1000, fetchFn: fn });
		s.send({ n: 1 });
		s.send({ n: 2 });
		await s.flush(1000);

		assert.deepEqual(calls.map((c) => (c.body as { hook_payload: { n: number } }).hook_payload.n), [1, 2]);
		assert.equal(calls[0].url, "http://obs/api/events");
		assert.deepEqual((calls[0].body as { meta: unknown }).meta, { env: { INSTANTCOFFEE_OBSERVE_PROJECT_SLUG: "proj" } });
		assert.equal(s.snapshot().sent, 2);
	});

	test("an outage costs one request per backoff window, not one per event", async () => {
		let t = 0;
		const { fn, calls } = fakeFetch([new Error("fetch failed")]);
		const s = new Sender({ url: "http://obs", projectSlug: null, timeoutMs: 100, maxQueue: 10, backoffMs: 1000, fetchFn: fn, now: () => t });
		for (let i = 0; i < 5; i++) {
			s.send({ i });
		}
		await s.flush(1000);
		assert.equal(calls.length, 1);
		assert.equal(s.snapshot().dropped, 5);
		assert.equal(s.snapshot().lastError, "fetch failed");

		t = 2000;
		s.send({ i: 99 });
		await s.flush(1000);
		assert.equal(calls.length, 2, "retries once the window has passed");
	});

	test("a 4xx drops that event but does not back off the rest", async () => {
		const { fn, calls } = fakeFetch([400, 201]);
		const s = new Sender({ url: "http://obs", projectSlug: null, timeoutMs: 100, maxQueue: 10, backoffMs: 1000, fetchFn: fn });
		s.send({ bad: true });
		s.send({ good: true });
		await s.flush(1000);
		assert.equal(calls.length, 2);
		assert.equal(s.snapshot().sent, 1);
		assert.equal(s.snapshot().dropped, 1);
		assert.match(s.snapshot().lastError ?? "", /HTTP 400 nope/);
	});

	test("the queue is bounded", () => {
		const never = (() => new Promise(() => {})) as unknown as typeof fetch;
		const s = new Sender({ url: "http://obs", projectSlug: null, timeoutMs: 100, maxQueue: 3, backoffMs: 1000, fetchFn: never });
		for (let i = 0; i < 10; i++) {
			s.send({ i });
		}
		// One is in flight; the rest are capped at maxQueue.
		assert.ok(s.snapshot().queued <= 3);
		assert.ok(s.snapshot().dropped >= 6);
	});
});
