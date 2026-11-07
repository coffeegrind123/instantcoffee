/**
 * Pure command construction for the Anthropic team-solve extension.
 *
 * Kept free of pi imports so argument handling and model-facing failures can
 * be tested without a live TUI session.
 */

export const TEAM_SOLVE_ACTIONS = [
	"run",
	"resume",
	"status",
	"logs",
	"check",
	"stop",
	"preview",
	"help",
] as const;

export type TeamSolveAction = (typeof TEAM_SOLVE_ACTIONS)[number];

export function isTeamSolveAction(value: string): value is TeamSolveAction {
	return (TEAM_SOLVE_ACTIONS as readonly string[]).includes(value);
}

export interface TeamSolveInvocation {
	action: TeamSolveAction;
	args: string[];
}

const DIRECTORY_ACTIONS = new Set<TeamSolveAction>([
	"run",
	"resume",
	"status",
	"logs",
	"check",
	"stop",
]);

function takesDirectory(action: TeamSolveAction): boolean {
	return DIRECTORY_ACTIONS.has(action);
}

const OPTIONS_WITH_VALUES = new Set([
	"--task-file",
	"--check",
	"--until",
	"--profile",
	"--rounds",
	"--max-hours",
	"--role-timeout",
	"--check-timeout",
	"--role-retries",
	"--role",
	"--lines",
]);

function hasValue(args: string[], option: string): boolean {
	const inline = `${option}=`;
	return args.some((arg) => arg === option || arg.startsWith(inline));
}

/**
 * Build the argv for scripts/team-solve/team_solve.py.
 *
 * The extension always targets pi's current working directory. Rejecting an
 * explicit --dir avoids a command that looks local while writing a run ledger
 * somewhere else.
 */
export function buildTeamSolveInvocation(
	words: string[],
	workspace: string,
): TeamSolveInvocation | { error: string } {
	if (!words.length) return { action: "help", args: ["help"] };

	const [first, ...rest] = words;
	if (!isTeamSolveAction(first)) {
		return {
			error:
				`Unknown team-solve command '${first}'. ` +
				`Use /team-solve ${TEAM_SOLVE_ACTIONS.join("|")}.`,
		};
	}

	if (takesDirectory(first) && hasValue(rest, "--dir")) {
		return {
			error:
				"/team-solve always operates on pi's current workspace. " +
				"Start pi in the target directory instead of passing --dir.",
		};
	}

	// A run needs something to do: words, a task file, or a check to make pass.
	// --check is optional: without it the planner settles one, or the judge decides.
	const hasGoal = rest.some((arg, index) => !arg.startsWith("--") && !OPTIONS_WITH_VALUES.has(rest[index - 1] ?? ""));
	if (first === "run" && !hasGoal && !hasValue(rest, "--task-file") && !hasValue(rest, "--check")) {
		return {
			error:
				"/team-solve run needs a task:\n" +
				'/team-solve run "describe the goal" [--until "end condition"] [--check "pytest -q"]',
		};
	}

	if (takesDirectory(first)) {
		return { action: first, args: [first, "--dir", workspace, ...rest] };
	}
	return { action: first, args: [first, ...rest] };
}

export function teamSolveCompletionItems(prefix: string): Array<{ value: string; label: string }> {
	const lastWhitespace = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\t"));
	if (lastWhitespace < 0) {
		return TEAM_SOLVE_ACTIONS.filter((action) => action.startsWith(prefix)).map((action) => ({
			value: action,
			label: action,
		}));
	}
	const argsBeforeCurrent = prefix.slice(0, lastWhitespace + 1);
	const current = prefix.slice(lastWhitespace + 1);
	const first = prefix.slice(0, lastWhitespace).trimStart().split(/\s+/, 1)[0] ?? "";
	if (!isTeamSolveAction(first)) return [];

	const options: Partial<Record<TeamSolveAction, string[]>> = {
		run: [
			"--task-file",
			"--check",
			"--until",
			"--profile",
			"--rounds",
			"--max-hours",
			"--role-timeout",
			"--check-timeout",
			"--role-retries",
			"--multi-day",
			"--no-multi-day",
			"--improve",
			"--fresh",
		],
		resume: ["--max-hours"],
		logs: ["--role", "--lines"],
		check: ["--check", "--lines"],
		preview: ["--profile", "--check", "--multi-day", "--no-multi-day"],
	};
	return (options[first] ?? [])
		.filter((option) => option.startsWith(current))
		.map((option) => ({ value: `${argsBeforeCurrent}${option}`, label: option }));
}

export function tailLines(text: string, limit: number): string[] {
	const lines = text.replace(/\s+$/, "").split("\n");
	return lines.length <= limit ? lines : lines.slice(-limit);
}
