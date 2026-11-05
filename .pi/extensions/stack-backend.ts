/**
 * Backend-selection rules for `/stack`, kept free of pi imports so they can be
 * tested without a live pi installation.
 */

export type StackBackend = "local" | "anthropic";

/** The one switch that decides which provider and operational surface is live. */
export function stackBackend(value: string): StackBackend {
	return value === "anthropic" ? "anthropic" : "local";
}

/** A typo must not silently grant the local lifecycle commands. */
export function stackBackendProblem(value: string): string | null {
	if (value === "" || value === "local" || value === "anthropic") return null;
	return `STACK_BACKEND must be 'local' or 'anthropic', got '${value}'.`;
}

/** Every `/stack` subcommand the extension dispatches. */
export const STACK_SUBCOMMANDS = [
	"status",
	"mode",
	"env",
	"set",
	"up",
	"down",
	"restart",
	"smoke",
	"bench",
	"logs",
	"slots",
	"help",
] as const;

export type StackSubcommand = (typeof STACK_SUBCOMMANDS)[number];

export function isStackSubcommand(value: string): value is StackSubcommand {
	return Object.prototype.hasOwnProperty.call(STACK_COMMAND_ARITY, value);
}

export function splitStackArgs(input: string): { args: string[] } | { error: string } {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	let started = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			started = true;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			started = true;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else if (char === "\\") escaped = true;
			else current += char;
			started = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) {
				args.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}

	if (escaped) return { error: "The command ends with an unfinished escape." };
	if (quote) return { error: `The command has an unfinished ${quote === "'" ? "single" : "double"} quote.` };
	if (started) args.push(current);
	return { args };
}

interface CommandArity {
	min: number;
	max: number;
}

/**
 * Argument contract for every command in STACK_SUBCOMMANDS.
 *
 * Keeping this exhaustive means a new dispatcher case cannot silently accept
 * arbitrary trailing words. `set` is the one open-ended command because values
 * may contain spaces; `bench` forwards its arguments to scripts/bench.sh.
 */
export const STACK_COMMAND_ARITY: Record<StackSubcommand, CommandArity> = {
	status: { min: 0, max: 0 },
	mode: { min: 0, max: 1 },
	env: { min: 0, max: 1 },
	set: { min: 1, max: Number.POSITIVE_INFINITY },
	up: { min: 0, max: 0 },
	down: { min: 0, max: 0 },
	restart: { min: 0, max: 1 },
	smoke: { min: 0, max: 0 },
	bench: { min: 0, max: Number.POSITIVE_INFINITY },
	logs: { min: 0, max: 1 },
	slots: { min: 1, max: 2 },
	help: { min: 0, max: 0 },
};

/** `local` is a mode.sh alias for STACK_LAST_LOCAL_MODE, not modes/local.env. */
export const STACK_MODE_ALIASES = ["local"] as const;

export function modeNames(files: string[]): string[] {
	return [...new Set([...STACK_MODE_ALIASES, ...files])].sort();
}

/** Display/legacy parser. Mode files still require an explicit backend. */
export function modeBackend(text: string): StackBackend {
	let found: StackBackend | undefined;
	for (const line of text.split("\n")) {
		const match = /^\s*STACK_BACKEND\s*=\s*(.*?)\s*$/.exec(line);
		if (match) {
			const value = match[1].replace(/^['"]|['"]$/g, "");
			if (value === "local" || value === "anthropic") found = value;
		}
	}
	return found ?? "local";
}

export function modeBackendProblem(text: string): string | null {
	const values: string[] = [];
	const counts = new Map<string, number>();
	for (const line of text.split("\n")) {
		const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
		if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
		const backend = /^\s*STACK_BACKEND\s*=\s*(.*?)\s*$/.exec(line);
		if (backend) values.push(backend[1].replace(/^['"]|['"]$/g, ""));
	}
	const duplicates = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
	if (duplicates.length) return `Duplicate mode keys: ${duplicates.join(", ")}. Keep one declaration per key.`;
	if (!values.length) return "STACK_BACKEND is missing; every mode file must declare it.";
	const problem = stackBackendProblem(values[0]);
	return problem ? `Invalid mode file: ${problem}` : null;
}

/** Commands that mutate or inspect llama/forge and therefore require local mode. */
export const LOCAL_ONLY_STACK_COMMANDS = new Set<StackSubcommand>([
	"up",
	"down",
	"restart",
	"smoke",
	"bench",
	"logs",
	"slots",
]);

/** These still work when STACK_BACKEND is invalid, so it can be repaired. */
export const BACKEND_INDEPENDENT_STACK_COMMANDS = new Set<StackSubcommand>(["mode", "env", "set", "help"]);

export function localCommandUnavailable(backend: StackBackend, subcommand: string): string[] | null {
	if (backend === "local" || !LOCAL_ONLY_STACK_COMMANDS.has(subcommand)) return null;
	return [
		`/stack ${subcommand} controls llama.cpp, forge, or their Docker containers.`,
		"",
		"The active backend is Anthropic: pi talks directly to api.anthropic.com.",
		"Switch to a local mode with /stack mode coding (or /anthropic off) to use it.",
	];
}

export function stackArgumentProblem(subcommand: string, args: string[]): string[] | null {
	if (!Object.prototype.hasOwnProperty.call(STACK_COMMAND_ARITY, subcommand)) return null;
	const arity = STACK_COMMAND_ARITY[subcommand as StackSubcommand];

	if ((subcommand === "up" || subcommand === "down") && args.length > 0) {
		return [
			`/stack ${subcommand} controls the whole local stack and takes no service argument.`,
			"Use /stack restart llama|forge to recreate one service.",
		];
	}

	if (args.length >= arity.min && args.length <= arity.max) return null;

	const expected =
		arity.max === Number.POSITIVE_INFINITY
			? `at least ${arity.min}`
			: arity.min === arity.max
				? `${arity.min}`
				: `${arity.min}-${arity.max}`;
	return [
		`/stack ${subcommand} takes ${expected} argument${expected === "1" ? "" : "s"}, got ${args.length}.`,
		"Run /stack help for the command list.",
	];
}

export function restartCommand(runtime: string[]): string | null {
	if (!runtime.length) return null;
	return runtime.length === 1 ? `/stack restart ${runtime[0]}` : "/stack restart";
}

const SECRET_KEY =
	/(?:^|_)(?:API_KEY|ACCESS_KEY|AUTH_KEY|CLIENT_KEY|PRIVATE_KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?|PAT)(?:$|_)/i;
const SECRET_VALUE = [
	/--?(?:api[-_]?key|access[-_]?key|auth[-_]?token|token|password|passwd|secret)(?:=|\s+)\S+/i,
	/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
	/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function isSecretKey(key: string): boolean {
	return SECRET_KEY.test(key);
}

export function valueLooksSecret(value: string): boolean {
	return SECRET_VALUE.some((pattern) => pattern.test(value));
}

export function envDisplayValue(key: string, value: string): string {
	return isSecretKey(key) || valueLooksSecret(value) ? (value ? "[redacted]" : "") : value;
}
