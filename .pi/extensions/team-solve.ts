/**
 * /team-solve — durable, command-checked multi-model work in Anthropic mode.
 *
 * The slash command is only the control surface. A detached Python
 * orchestrator owns the run, starts a fresh pi process for every role, and
 * writes the ledger under <workspace>/.team-solve. Leaving or replacing the
 * interactive pi session therefore does not stop the run.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStackArgs } from "./stack-backend.ts";
import {
	buildTeamSolveInvocation,
	teamSolveCompletionItems,
	tailLines,
	type TeamSolveAction,
} from "./team-solve-backend.ts";

interface TeamSolveReport {
	title: string;
	lines: string[];
	tone: "info" | "warn" | "error";
}

function findRepoRoot(): string | null {
	const starts: string[] = [];
	if (process.env.PI_STACK_REPO_ROOT) starts.push(process.env.PI_STACK_REPO_ROOT);
	try {
		starts.push(dirname(fileURLToPath(import.meta.url)));
	} catch {
		// cwd remains the final lead.
	}
	starts.push(process.cwd());

	for (const start of starts) {
		let dir = resolve(start);
		for (let i = 0; i < 10; i++) {
			if (
				existsSync(join(dir, "scripts", "team-solve", "team_solve.py")) &&
				existsSync(join(dir, ".env"))
			) {
				return dir;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

function execVerdict(result: { code: number | null; killed: boolean }, timeout: number): string | null {
	if (result.killed) return `was killed after ${timeout}ms or at the output limit`;
	if (result.code !== 0) return `exited ${result.code ?? "without a status"}`;
	return null;
}

export default function teamSolveExtension(pi: ExtensionAPI) {
	// Project auto-discovery can load this file outside pi-local.sh, and direct
	// pi launches can add it through PI_EXTRA_ARGS. The launcher marker keeps the
	// hosted-only contract positive instead of trying to infer it from files that
	// a running session may have changed underneath itself.
	if (process.env.PI_TEAM_SOLVE_ACTIVE !== "1") return;

	const root = findRepoRoot();

	pi.registerEntryRenderer<TeamSolveReport>("team-solve-report", (entry, { expanded }, theme) => {
		const data = entry.data ?? { title: "team-solve", lines: [], tone: "info" as const };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const tint = data.tone === "error" ? "error" : data.tone === "warn" ? "warning" : "accent";
		box.addChild(new Text(theme.fg(tint, `[${data.title}]`), 0, 0));
		const lines = expanded || data.lines.length <= 24 ? data.lines : data.lines.slice(0, 24);
		for (const line of lines) box.addChild(new Text(line, 0, 0));
		if (lines.length < data.lines.length) {
			box.addChild(new Text(theme.fg("dim", `… ${data.lines.length - lines.length} more (expand)`), 0, 0));
		}
		return box;
	});

	const report = (title: string, lines: string[], tone: TeamSolveReport["tone"] = "info") =>
		pi.appendEntry<TeamSolveReport>("team-solve-report", { title, lines, tone });

	if (!root) {
		pi.registerCommand("team-solve", {
			description: "Run durable Anthropic team-solve workflows (unavailable: repo not found)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					"team-solve repository not found — expected scripts/team-solve/team_solve.py and .env.",
					"error",
				);
			},
		});
		return;
	}

	const script = join(root, "scripts", "team-solve", "team_solve.py");
	const stateDir = ".team-solve";

	async function runSync(
		action: TeamSolveAction,
		args: string[],
		workspace: string,
		timeout: number,
		ctx: ExtensionCommandContext,
	) {
		ctx.ui.setWorkingMessage?.(`team-solve ${action}…`);
		try {
			const result = await pi.exec("python3", [script, ...args], {
				cwd: workspace,
				timeout,
				maxBuffer: 16 * 1024 * 1024,
			});
			const bad = execVerdict(result, timeout);
			const output = [...tailLines(result.stdout, 160)];
			if (result.stderr.trim()) output.push("", "stderr:", ...tailLines(result.stderr, 80));
			report(
				`team-solve ${action}`,
				[
					`${action} -> ${bad ?? `exit ${result.code}`}`,
					"",
					...(output.length ? output : ["(no output)"]),
				],
				bad ? (result.killed ? "warn" : "error") : "info",
			);
		} catch (error) {
			report("team-solve", [`failed to run ${script}: ${String(error)}`], "error");
		} finally {
			ctx.ui.setWorkingMessage?.(undefined);
		}
	}

	function startDetached(args: string[], workspace: string, ctx: ExtensionCommandContext) {
		const home = join(workspace, stateDir);
		const launcherLog = join(home, "launcher.log");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		chmodSync(home, 0o700);
		appendFileSync(
			launcherLog,
			`\n[${new Date().toISOString()}] /team-solve ${args.join(" ")}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		chmodSync(launcherLog, 0o600);
		const fd = openSync(launcherLog, "a", 0o600);
		try {
			const child = spawn("python3", [script, ...args], {
				cwd: workspace,
				env: {
					...process.env,
					PI_TELEMETRY: "0",
				},
				detached: true,
				stdio: ["ignore", fd, fd],
			});
			child.once("error", (error) => {
				report("team-solve run", [`detached process failed to start: ${String(error)}`], "error");
			});
			child.unref();
			ctx.ui.setStatus?.("team-solve", `run started · pid ${child.pid ?? "unknown"}`);
			report(
				"team-solve run",
				[
					`started detached process ${child.pid ?? "(pid unavailable)"}`,
					`workspace  ${workspace}`,
					`launcher   ${launcherLog}`,
					"",
					"Use /team-solve status, logs, resume, check, or stop.",
					"The verification command alone decides whether the run is solved.",
				],
				"info",
			);
		} catch (error) {
			report("team-solve run", [`could not start ${script}: ${String(error)}`], "error");
		} finally {
			closeSync(fd);
		}
	}

	pi.registerCommand("team-solve", {
		description: "Run a durable, command-checked team of Claude models",
		getArgumentCompletions: (prefix) => {
			const items = teamSolveCompletionItems(prefix);
			return items.length ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const parsed = splitStackArgs(rawArgs);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			const workspace = resolve(ctx.cwd);
			const invocation = buildTeamSolveInvocation(parsed.args, workspace);
			if ("error" in invocation) {
				report("team-solve", invocation.error.split("\n"), "warn");
				return;
			}

			if (invocation.action === "run") {
				if (!process.env.ANTHROPIC_API_KEY?.trim()) {
					report(
						"team-solve run",
						[
							"ANTHROPIC_API_KEY is not present in this pi process.",
							"",
							"Add it to gitignored .env.local and relaunch through scripts/pi-local.sh.",
						],
						"error",
					);
					return;
				}
				startDetached(invocation.args, workspace, ctx);
				return;
			}
			if (invocation.action === "stop") {
				await runSync("stop", invocation.args, workspace, 20_000, ctx);
				ctx.ui.setStatus?.("team-solve", undefined);
				return;
			}
			if (invocation.action === "status") {
				await runSync("status", invocation.args, workspace, 20_000, ctx);
				return;
			}
			if (invocation.action === "check") {
				await runSync("check", invocation.args, workspace, 60 * 60_000, ctx);
				return;
			}
			if (invocation.action === "resume") {
				if (!process.env.ANTHROPIC_API_KEY?.trim()) {
					report(
						"team-solve resume",
						["ANTHROPIC_API_KEY is not present; relaunch pi after adding it to .env.local."],
						"error",
					);
					return;
				}
				startDetached(invocation.args, workspace, ctx);
				return;
			}
			await runSync(invocation.action, invocation.args, workspace, 30_000, ctx);
		},
	});
}
