/**
 * Backend selection and command gating for `/stack`.
 *
 * The extension cannot be imported here without pi installed, so these drive
 * the exported decisions directly. They cover the whole local-only command set:
 * a new one added to the dispatcher must also be classified here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
	BACKEND_INDEPENDENT_STACK_COMMANDS,
	LOCAL_ONLY_STACK_COMMANDS,
	STACK_COMMAND_ARITY,
	STACK_MODE_ALIASES,
	STACK_SUBCOMMANDS,
	envDisplayValue,
	isStackSubcommand,
	localCommandUnavailable,
	modeBackend,
	modeBackendProblem,
	modeNames,
	restartCommand,
	splitStackArgs,
	stackArgumentProblem,
	stackBackend,
	stackBackendProblem,
	valueLooksSecret,
} from "../stack-backend.ts";

describe("stack backend selection", () => {
	test("anthropic is explicit; local is the compatibility default", () => {
		assert.equal(stackBackend("anthropic"), "anthropic");
		assert.equal(stackBackend("local"), "local");
		assert.equal(stackBackend(""), "local");
		assert.equal(stackBackend("typo"), "local");
		assert.match(stackBackendProblem("typo") ?? "", /must be 'local' or 'anthropic'/);
		assert.equal(stackBackendProblem(""), null);
		assert.equal(stackBackendProblem("local"), null);
		assert.equal(stackBackendProblem("anthropic"), null);
	});

	test("mode files select their backend and malformed declarations are named", () => {
		assert.equal(modeBackend("STACK_BACKEND=anthropic\nPI_CONTEXT_WINDOW=1000000\n"), "anthropic");
		assert.equal(modeBackend("STACK_BACKEND='local'\n"), "local");
		assert.equal(modeBackend("MODEL_REPO=unsloth/model\n"), "local");
		assert.equal(modeBackend("STACK_BACKEND=local\nSTACK_BACKEND=anthropic\n"), "anthropic");
		assert.match(
			modeBackendProblem("STACK_BACKEND=local\nSTACK_BACKEND=anthropic\n") ?? "",
			/Duplicate mode keys: STACK_BACKEND/,
		);
		assert.match(modeBackendProblem("STACK_BACKEND=typo\n") ?? "", /must be 'local' or 'anthropic'/);
		assert.equal(modeBackendProblem("STACK_BACKEND=local\n"), null);
		assert.match(modeBackendProblem("MODEL_REPO=unsloth/model\n") ?? "", /STACK_BACKEND is missing/);
	});

	test("the shell's local alias is visible without pretending to be a mode file", () => {
		assert.deepEqual(STACK_MODE_ALIASES, ["local"]);
		assert.deepEqual(modeNames(["prose", "anthropic"]), ["anthropic", "local", "prose"]);
		assert.deepEqual(modeNames(["local", "coding"]), ["coding", "local"]);
	});

	test("command arguments keep quoted whitespace and report unfinished quotes", () => {
		assert.deepEqual(splitStackArgs(`bench --name "two words" 'three  spaces'`), {
			args: ["bench", "--name", "two words", "three  spaces"],
		});
		assert.deepEqual(splitStackArgs(`set KEY="value with spaces"`), {
			args: ["set", "KEY=value with spaces"],
		});
		assert.deepEqual(splitStackArgs(`set EMPTY=""`), { args: ["set", "EMPTY="] });
		const unfinished = splitStackArgs(`env "unfinished`);
		assert.ok("error" in unfinished);
		assert.match(unfinished.error, /unfinished double quote/);
	});
});

describe("local-only /stack commands", () => {
	const commands = ["up", "down", "restart", "smoke", "bench", "logs", "slots"];

	test("the command catalog matches the dispatcher", () => {
		const source = readFileSync(new URL("../stack.ts", import.meta.url), "utf8");
		const dispatched = [...source.matchAll(/^\s*case "([^"]+)":/gm)].map((match) => match[1]);
		assert.deepEqual([...STACK_SUBCOMMANDS].sort(), dispatched.sort());
		assert.deepEqual(Object.keys(STACK_COMMAND_ARITY).sort(), [...STACK_SUBCOMMANDS].sort());
		for (const command of STACK_SUBCOMMANDS) {
			assert.equal(isStackSubcommand(command), true, command);
		}
		assert.equal(isStackSubcommand("toString"), false);
		for (const command of LOCAL_ONLY_STACK_COMMANDS) {
			assert.ok(STACK_SUBCOMMANDS.includes(command), `${command} is not in the command catalog`);
		}
	});

	test("every llama/forge control is blocked on the hosted backend", () => {
		assert.deepEqual([...LOCAL_ONLY_STACK_COMMANDS].sort(), [...commands].sort());
		for (const command of commands) {
			const lines = localCommandUnavailable("anthropic", command);
			assert.ok(lines, `${command} was not blocked`);
			assert.match(lines.join("\n"), /pi talks directly to api\.anthropic\.com/);
			assert.match(lines.join("\n"), /\/stack mode coding/);
		}
	});

	test("the same commands remain available locally", () => {
		for (const command of commands) {
			assert.equal(localCommandUnavailable("local", command), null);
		}
	});

	test("inspection and configuration survive the backend switch", () => {
		for (const command of ["status", "mode", "env", "set", "help"]) {
			assert.equal(localCommandUnavailable("anthropic", command), null);
		}
		assert.deepEqual([...BACKEND_INDEPENDENT_STACK_COMMANDS].sort(), ["env", "help", "mode", "set"]);
	});

	test("whole-stack commands reject service arguments instead of ignoring them", () => {
		for (const command of ["up", "down"]) {
			assert.equal(stackArgumentProblem(command, []), null);
			assert.match(stackArgumentProblem(command, ["forge"])?.join("\n") ?? "", /takes no service argument/);
		}
		assert.equal(stackArgumentProblem("restart", ["forge"]), null);
		assert.equal(restartCommand([]), null);
		assert.equal(restartCommand(["llama"]), "/stack restart llama");
		assert.equal(restartCommand(["llama", "forge"]), "/stack restart");
	});

	test("every command rejects arguments outside its documented contract", () => {
		assert.match(stackArgumentProblem("status", ["extra"])?.join("\n") ?? "", /takes 0 arguments/);
		assert.match(stackArgumentProblem("mode", ["coding", "extra"])?.join("\n") ?? "", /takes 0-1 argument/);
		assert.match(stackArgumentProblem("env", ["A", "B"])?.join("\n") ?? "", /takes 0-1 argument/);
		assert.match(stackArgumentProblem("set", [])?.join("\n") ?? "", /takes at least 1/);
		assert.match(stackArgumentProblem("restart", ["llama", "forge"])?.join("\n") ?? "", /takes 0-1 argument/);
		assert.match(stackArgumentProblem("smoke", ["extra"])?.join("\n") ?? "", /takes 0 arguments/);
		assert.match(stackArgumentProblem("logs", ["llama", "forge"])?.join("\n") ?? "", /takes 0-1 argument/);
		assert.match(stackArgumentProblem("slots", [])?.join("\n") ?? "", /takes 1-2 arguments/);
		assert.match(stackArgumentProblem("help", ["extra"])?.join("\n") ?? "", /takes 0 arguments/);
		assert.equal(stackArgumentProblem("bench", ["--suite", "all"]), null);
		assert.equal(stackArgumentProblem("toString", ["extra"]), null);
	});
});

describe("long-running stack operations", () => {
	test("the llama recreate timeout covers the measured cold load", () => {
		const source = readFileSync(new URL("../stack.ts", import.meta.url), "utf8");
		const match = /const LLAMA_RECREATE_TIMEOUT_MS = ([\d_]+);/.exec(source);
		assert.ok(match, "the llama recreate timeout constant is missing");
		assert.ok(Number(match[1].replaceAll("_", "")) >= 30 * 60_000);
		assert.equal((source.match(/execVerdict\(r, 600_000\)/g) ?? []).length, 0);

		const smoke = /const SMOKE_TIMEOUT_MS = ([\d_]+);/.exec(source);
		assert.ok(smoke, "the smoke timeout constant is missing");
		assert.ok(Number(smoke[1].replaceAll("_", "")) > 2_700_000);
	});
});

describe("stack environment display", () => {
	test("credentials are redacted but their presence is visible", () => {
		assert.equal(envDisplayValue("ANTHROPIC_API_KEY", "sk-ant-secret"), "[redacted]");
		assert.equal(envDisplayValue("DEEPSEEK_API_KEY", "secret"), "[redacted]");
		assert.equal(envDisplayValue("GITHUB_PAT", "secret"), "[redacted]");
		assert.equal(envDisplayValue("AWS_SECRET_ACCESS_KEY", "secret"), "[redacted]");
		assert.equal(envDisplayValue("CHUB_API_KEY", ""), "");
		assert.equal(envDisplayValue("ANTHROPIC_MODEL", "claude-opus-5-5"), "claude-opus-5-5");
		assert.equal(envDisplayValue("DATABASE_URL", "postgres://user:pass@host/db"), "[redacted]");
		assert.equal(envDisplayValue("PI_EXTRA_ARGS", "--api-key=secret"), "[redacted]");
		assert.equal(valueLooksSecret("ghp_abcdefghijklmnopqrstuvwxyz"), true);
		assert.equal(valueLooksSecret("ordinary value"), false);
	});
});
