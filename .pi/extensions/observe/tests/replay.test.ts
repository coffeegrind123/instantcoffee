/**
 * Replays a real pi 0.85.1 session through the extension and checks what
 * observe would receive.
 *
 *   node --experimental-strip-types --no-warnings --test .pi/extensions/observe/tests/*.test.ts
 *
 * fixtures/pi-0.85.1-session.jsonl is a capture from the live stack (paths
 * anonymised, bulky payloads the extension never reads dropped): one prompt
 * that reads a file, runs `echo hi`, runs a failing `cat`, and delegates a line
 * count to a subagent — all four as parallel tool calls in one turn.
 *
 * pi gives the parent and each subagent their OWN event bus but the SAME module
 * instance, so the replay does too: one fake `pi` per binding, the factory
 * called again when the child first appears. That is the arrangement the
 * linker depends on, and the reason this test exists.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

interface Rec {
	name: string;
	t: number;
	sess: { id: string; file: string | null; name: string | null };
	cwd: string;
	mode: string;
	model: string | null;
	provider: string | null;
	usage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	event: Record<string, unknown>;
}

const here = dirname(fileURLToPath(import.meta.url));
const records: Rec[] = readFileSync(join(here, "fixtures", "pi-0.85.1-session.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	return {
		handlers,
		on(name: string, fn: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerCommand() {},
	};
}

function ctxOf(r: Rec) {
	return {
		cwd: r.cwd,
		mode: r.mode,
		model: r.model ? { id: r.model, provider: r.provider ?? undefined, contextWindow: r.usage?.contextWindow } : undefined,
		sessionManager: {
			getSessionId: () => r.sess.id,
			getSessionFile: () => r.sess.file ?? undefined,
			getSessionName: () => r.sess.name ?? undefined,
		},
		getContextUsage: () => r.usage ?? undefined,
	};
}

test("a real session replays into the envelopes observe expects", async () => {
	const posted: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_url: string, init: { body: string }) => {
		posted.push(JSON.parse(init.body).hook_payload);
		return new Response("{}", { status: 201 });
	}) as unknown as typeof fetch;
	process.env.OBSERVE_URL = "http://observe.test";

	const { default: observe } = await import("../index.ts");
	const { setClock } = await import("../src/clock.ts");
	let t = records[0].t;
	setClock(() => t);

	const buses = new Map<string, ReturnType<typeof fakePi>>();
	const rootId = records.find((r) => r.sess.file)!.sess.id;
	for (const r of records) {
		let bus = buses.get(r.sess.id);
		if (!bus) {
			bus = fakePi();
			observe(bus);
			buses.set(r.sess.id, bus);
		}
		t = r.t;
		for (const h of bus.handlers.get(r.name) ?? []) {
			await h({ type: r.name, ...r.event }, ctxOf(r));
		}
	}
	// Let the sender's drain loop finish.
	await new Promise((resolve) => setTimeout(resolve, 50));

	const names = posted.map((e) => e.hook_event_name);
	assert.equal(buses.size, 2, "fixture should contain the parent and one subagent");

	// Everything, child included, is grouped under the top-level session.
	assert.ok(posted.every((e) => e.session_id === rootId));
	assert.ok(posted.every((e) => e.agent_class === "pi"));
	assert.equal(names[0], "SessionStart");
	assert.equal(names[names.length - 1], "SessionEnd");

	// Four parallel tool calls: each gets exactly one Pre and one Post.
	const topPre = posted.filter((e) => e.hook_event_name === "PreToolUse" && !e.agent_id);
	assert.deepEqual(topPre.map((e) => e.tool_name).sort(), ["Agent", "bash", "bash", "read"]);
	for (const pre of topPre) {
		const post = posted.filter(
			(e) => (e.hook_event_name === "PostToolUse" || e.hook_event_name === "PostToolUseFailure") && e.tool_use_id === pre.tool_use_id,
		);
		assert.equal(post.length, 1, `one result for ${pre.tool_name} ${pre.tool_use_id}`);
		assert.ok(typeof post[0].duration_ms === "number");
	}

	// pi reports a non-zero exit as isError.
	const failed = posted.filter((e) => e.hook_event_name === "PostToolUseFailure");
	assert.equal(failed.length, 1);
	assert.match(String(failed[0].error), /No such file/);

	// The Agent call's input is the post-mutation one, with the resolved type.
	const agentPre = topPre.find((e) => e.tool_name === "Agent")!;
	assert.equal((agentPre.tool_input as Record<string, unknown>)._resolvedAgent, "general-purpose");

	// The subagent: started and stopped, linked to that exact call, and every
	// one of its events says so.
	const childEvents = posted.filter((e) => e.agent_id);
	assert.ok(childEvents.length > 0);
	assert.ok(childEvents.every((e) => e.parent_tool_use_id === agentPre.tool_use_id));
	assert.ok(childEvents.every((e) => e.agent_type === "general-purpose"));
	assert.ok(childEvents.every((e) => String(e.agent_name).startsWith("general-purpose#")));
	const childNames = childEvents.map((e) => e.hook_event_name);
	assert.equal(childNames[0], "SubagentStart");
	assert.ok(childNames.includes("SubagentStop"));
	assert.ok(childNames.includes("LLMGeneration"));
	assert.ok(!childNames.includes("SessionStart"), "a subagent must not look like a new session");

	// The subagent finished before its parent's Agent call returned.
	const stop = posted.findIndex((e) => e.hook_event_name === "SubagentStop");
	const agentPost = posted.findIndex((e) => e.hook_event_name === "PostToolUse" && e.tool_use_id === agentPre.tool_use_id);
	assert.ok(stop < agentPost);

	// LLM generations carry real usage and derived timing.
	const gens = posted.filter((e) => e.hook_event_name === "LLMGeneration");
	assert.ok(gens.length >= 4);
	for (const g of gens) {
		assert.equal(g.provider, "forge");
		assert.ok((g.input_tokens as number) > 0 || (g.cache_read_tokens as number) > 0);
		assert.ok(typeof g.duration_ms === "number" && (g.duration_ms as number) > 0);
	}
	// The capture kept only the first few streaming updates per session, so
	// only the first generation of each has a first-token time; it must be
	// inside the request, and a generation without one must not invent it.
	const withTtft = gens.filter((g) => typeof g.ttft_ms === "number");
	assert.equal(withTtft.length, 2);
	for (const g of withTtft) {
		assert.ok((g.ttft_ms as number) > 0 && (g.ttft_ms as number) < (g.duration_ms as number));
	}

	// The prompt and the one-off system prompt are both there.
	assert.match(String(posted.find((e) => e.hook_event_name === "UserPromptSubmit" && !e.agent_id)?.prompt), /notes\.txt/);
	assert.ok(names.includes("SystemPrompt"));
	assert.ok(names.includes("Stop"));

	// Git context rides on the top-level SessionStart and Stop only. The
	// capture's cwd is not a checkout here, so both fields are present and null.
	for (const name of ["SessionStart", "Stop"]) {
		const e = posted.find((x) => x.hook_event_name === name && !x.agent_id)!;
		assert.ok("git_branch" in e && "git_repository_url" in e, `${name} carries git context`);
	}
	assert.ok(childEvents.every((e) => !("git_branch" in e)), "subagent events carry no git context");
});
