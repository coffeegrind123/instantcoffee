/**
 * Command construction for `/team-solve`.
 *
 * No pi runtime is needed: these pin the argv boundary that keeps goal text,
 * quoted check commands, and workspace selection from becoming shell syntax.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
	TEAM_SOLVE_ACTIONS,
	buildTeamSolveInvocation,
	isTeamSolveAction,
	tailLines,
	teamSolveCompletionItems,
} from "../team-solve-backend.ts";

describe("team-solve argv", () => {
	test("no arguments opens help", () => {
		assert.deepEqual(buildTeamSolveInvocation([], "/work/task"), {
			action: "help",
			args: ["help"],
		});
	});

	test("unknown actions fail instead of becoming a goal", () => {
		const result = buildTeamSolveInvocation(["sovle", "--check", "true"], "/work/task");
		assert.ok("error" in result);
		assert.match(result.error, /Unknown team-solve command/);
		assert.equal(isTeamSolveAction("solve"), false);
	});

	test("run keeps goal and check text as separate argv entries", () => {
		const result = buildTeamSolveInvocation(
			["run", "fix the parser", "--check", "pytest -q tests/test_parser.py"],
			"/work/task",
		);
		assert.deepEqual(result, {
			action: "run",
			args: [
				"run",
				"--dir",
				"/work/task",
				"fix the parser",
				"--check",
				"pytest -q tests/test_parser.py",
			],
		});
	});

	test("run requires its ground-truth command", () => {
		const result = buildTeamSolveInvocation(["run", "do the thing"], "/work/task");
		assert.ok("error" in result);
		assert.match(result.error, /requires an explicit verification command/);
	});

	test("workspace ownership cannot be overridden", () => {
		for (const option of ["--dir", "--dir=/tmp/elsewhere"]) {
			const result = buildTeamSolveInvocation(
				["run", "goal", "--check=true", option, "/tmp/elsewhere"],
				"/work/task",
			);
			assert.ok("error" in result);
			assert.match(result.error, /always operates on pi's current workspace/);
		}
	});

	test("workspace-bound commands receive the current cwd", () => {
		const goal = "/workspace with spaces";
		for (const action of ["resume", "status", "logs", "check", "stop"] as const) {
			const result = buildTeamSolveInvocation([action], goal);
			assert.deepEqual(result, {
				action,
				args: [action, "--dir", goal],
			});
		}
	});

	test("inspection commands do not invent a --dir option", () => {
		assert.deepEqual(buildTeamSolveInvocation(["preview", "--profile", "research"], "/work/task"), {
			action: "preview",
			args: ["preview", "--profile", "research"],
		});
		assert.deepEqual(buildTeamSolveInvocation(["help"], "/work/task"), {
			action: "help",
			args: ["help"],
		});
	});

	test("the public action list is exhaustive and completable", () => {
		assert.deepEqual(
			[...TEAM_SOLVE_ACTIONS],
			["run", "resume", "status", "logs", "check", "stop", "preview", "help"],
		);
		assert.deepEqual(
			teamSolveCompletionItems("re").map((item) => item.value),
			["resume"],
		);
		assert.deepEqual(
			teamSolveCompletionItems("").map((item) => item.value),
			[...TEAM_SOLVE_ACTIONS],
		);
		assert.deepEqual(
			teamSolveCompletionItems("run --ch").map((item) => item.value),
			["run --check", "run --check-timeout"],
		);
		assert.deepEqual(
			teamSolveCompletionItems("run --multi").map((item) => item.value),
			["run --multi-day"],
		);
		assert.deepEqual(
			teamSolveCompletionItems("preview --p").map((item) => item.value),
			["preview --profile"],
		);
		assert.deepEqual(
			teamSolveCompletionItems("run fix parser --ci").map((item) => item.value),
			[],
		);
	});

	test("tails preserve recent lines and collapse trailing whitespace", () => {
		assert.deepEqual(tailLines("a\nb\nc\n\n", 2), ["b", "c"]);
		assert.deepEqual(tailLines("only", 2), ["only"]);
	});
});

describe("extension boundary", () => {
	test("uses argv execution rather than a shell", () => {
		const source = readFileSync(new URL("../team-solve.ts", import.meta.url), "utf8");
		assert.match(source, /spawn\("python3", \[script, \.\.\.args\]/);
		assert.doesNotMatch(source, /shell:\s*true/);
		assert.match(source, /splitStackArgs/);
		assert.match(source, /detached:\s*true/);
		assert.match(source, /PI_TEAM_SOLVE_ACTIVE !== "1"/);
	});
});
