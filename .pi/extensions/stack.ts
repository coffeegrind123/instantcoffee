/**
 * /stack — inspect and control the forge + llama.cpp stack from inside pi.
 *
 * Everything here was written against endpoints probed on the running build
 * (llama-server b10200, forge 0.8.2), not against upstream docs. Two of those
 * probes contradicted the docs, and the contradictions shape this file:
 *
 *   1. `POST /props` answers 501 on this build. Nothing that llama-server takes
 *      as a startup flag — context, temperature, reasoning budget, MTP — can be
 *      changed at runtime. So `set` edits .env and tells you what to recreate;
 *      it never pretends to have tuned a live server.
 *
 *   2. forge 0.8.2 serves `/health`, `/v1/models`, `/v1/messages` and
 *      `/v1/chat/completions`. The `/forge/health` and `/forge/usage` routes
 *      belong to forge 0.9.0 and 404 here. Probe before you believe a route.
 *
 * The split that matters: observation is a model-callable tool (`stack_status`),
 * every mutation is a user-only command. The model should be able to see that
 * prefill collapsed; it should not be able to restart llama mid-task.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// --- repo discovery ---------------------------------------------------------
// pi may be started from a subdirectory, so walk up looking for the markers
// that identify this repo specifically rather than trusting cwd.

function findRepoRoot(): string | null {
	const starts: string[] = [];
	try {
		starts.push(dirname(fileURLToPath(import.meta.url)));
	} catch {
		// Not ESM or no import.meta — cwd is the only lead.
	}
	starts.push(process.cwd());

	for (const start of starts) {
		let dir = resolve(start);
		for (let i = 0; i < 10; i++) {
			if (
				existsSync(join(dir, "docker-compose.yml")) &&
				existsSync(join(dir, ".env")) &&
				existsSync(join(dir, "scripts", "lib.sh"))
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

// --- env ---------------------------------------------------------------------
// Mirrors env_get() in scripts/lib.sh: an exported variable wins, then .env,
// then .env.local. Reimplemented rather than shelled out to because /stack reads
// a dozen keys per invocation and a dozen bash round trips is visible latency.

function parseEnvFile(path: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!existsSync(path)) return out;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return out;
	}
	for (const raw of text.split("\n")) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
		if (!m) continue;
		let v = m[2];
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		out.set(m[1], v);
	}
	return out;
}

class StackEnv {
	private merged = new Map<string, string>();
	readonly keysInEnvFile = new Set<string>();
	readonly root: string;

	// Written out longhand rather than as a parameter property: those are a
	// TypeScript-only construct that strip-only transpilers reject outright.
	constructor(root: string) {
		this.root = root;
		const base = parseEnvFile(join(root, ".env"));
		for (const k of base.keys()) this.keysInEnvFile.add(k);
		for (const [k, v] of base) this.merged.set(k, v);
		for (const [k, v] of parseEnvFile(join(root, ".env.local"))) this.merged.set(k, v);
	}

	get(key: string, fallback = ""): string {
		const exported = process.env[key];
		if (exported !== undefined && exported !== "") return exported;
		return this.merged.get(key) ?? fallback;
	}

	entries(): Array<[string, string]> {
		return [...this.merged.keys()].sort().map((k) => [k, this.get(k)] as [string, string]);
	}
}

// --- compose introspection ---------------------------------------------------
// Which service a key belongs to is derived from docker-compose.yml rather than
// hardcoded, so `set` cannot start naming the wrong container when the compose
// file grows a knob.

interface ComposeInfo {
	/** service -> container_name */
	containers: Map<string, string>;
	/** env key -> services that interpolate it */
	keyOwners: Map<string, string[]>;
}

function readCompose(root: string): ComposeInfo {
	const containers = new Map<string, string>();
	const keyOwners = new Map<string, string[]>();
	let text: string;
	try {
		text = readFileSync(join(root, "docker-compose.yml"), "utf8");
	} catch {
		return { containers, keyOwners };
	}

	// Service blocks are top-level two-space keys. Good enough for this file and
	// far cheaper than pulling in a YAML parser for two facts.
	const lines = text.split("\n");
	let current: string | null = null;
	const owned = new Map<string, Set<string>>();

	for (const line of lines) {
		const svc = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
		if (svc) {
			current = svc[1];
			owned.set(current, new Set());
			continue;
		}
		if (/^\S/.test(line)) current = null;
		if (!current) continue;

		const cn = /^\s*container_name:\s*(\S+)/.exec(line);
		if (cn) containers.set(current, cn[1]);

		for (const m of line.matchAll(/\$\{([A-Z0-9_]+)/g)) {
			owned.get(current)?.add(m[1]);
		}
	}

	for (const [svc, keys] of owned) {
		for (const k of keys) {
			const list = keyOwners.get(k) ?? [];
			list.push(svc);
			keyOwners.set(k, list);
		}
	}
	return { containers, keyOwners };
}

/**
 * Keys consumed by scripts/pi-local.sh when it launches pi, not by any
 * container. Changing one needs a pi restart, not a 20-minute model reload —
 * a distinction worth making before someone recreates llama for nothing.
 */
const CLIENT_ONLY_KEYS = new Set([
	"PI_MAX_TOKENS",
	"PI_CONTEXT_FILES",
	"PI_EXTRA_ARGS",
	"PI_AUTO_UPDATE",
	"PI_UPDATE_INTERVAL_H",
	"MCP2CLI_ENABLED",
	"THINK_LANG",
]);

// --- http --------------------------------------------------------------------

/**
 * llama-server splits its endpoints in two, and the split is the whole basis of
 * the wedge diagnosis below: `/props` and `/models` are answered directly, while
 * `/slots`, `/metrics`, `/lora-adapters` and every inference route are dispatched
 * through the task queue. If the queue stops draining, the first pair keeps
 * answering and the second pair hangs — so the server looks alive and is not.
 */
const QUEUE_BACKED_TIMEOUT_MS = 8000;
const DIRECT_TIMEOUT_MS = 8000;

async function getJson<T>(url: string, timeoutMs = DIRECT_TIMEOUT_MS): Promise<T> {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as T;
}

async function getText(url: string, timeoutMs = DIRECT_TIMEOUT_MS): Promise<string> {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.text();
}

function isTimeout(reason: unknown): boolean {
	const msg = String((reason as any)?.message ?? reason);
	return /timeout|aborted|TimeoutError/i.test(msg);
}

function parsePrometheus(text: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("#")) continue;
		const sp = line.lastIndexOf(" ");
		if (sp < 0) continue;
		const value = Number(line.slice(sp + 1));
		if (Number.isFinite(value)) out.set(line.slice(0, sp).trim(), value);
	}
	return out;
}

// --- status ------------------------------------------------------------------

interface SlotView {
	id: number;
	nCtx: number | null;
	processing: boolean;
	cachedTokens: number | null;
	speculative: boolean | null;
}

interface StackStatus {
	root: string;
	llamaUrl: string;
	forgeUrl: string;
	llama:
		| {
				ok: true;
				modelPath: string;
				modelAlias: string;
				build: string;
				nCtx: number | null;
				sleeping: boolean;
				totalSlots: number | null;
				toolCalls: boolean | null;
				slots: SlotView[] | null;
				slotsError: string | null;
				metrics: Map<string, number> | null;
				metricsError: string | null;
				loraCount: number | null;
				queueWedged: boolean;
		  }
		| { ok: false; error: string };
	forge: { ok: true; health: string; models: string[] } | { ok: false; error: string };
	containers: Array<{ service: string; name: string; state: string }>;
	vram: string | null;
	settings: Array<[string, string]>;
	generatedAt: number;
}

/** Settings worth showing without being asked. Everything else via `/stack env`. */
const HEADLINE_KEYS = [
	"MODEL_REPO",
	"GGUF_FILE",
	"MODEL_ALIAS",
	"CTX_SIZE",
	"PARALLEL_SLOTS",
	"NGL",
	"CACHE_RAM",
	"SPEC_TYPE",
	"SPEC_DRAFT_N_MAX",
	"TEMPERATURE",
	"TOP_P",
	"TOP_K",
	"MIN_P",
	"REASONING_BUDGET",
	"THINK_LANG",
	"FORGE_CAPABILITY",
	"FORGE_MAX_RETRIES",
	"FORGE_VERSION",
	"LLAMA_TAG",
];

async function collectStatus(pi: ExtensionAPI, env: StackEnv, compose: ComposeInfo): Promise<StackStatus> {
	const inDocker = existsSync("/.dockerenv");
	const host = inDocker ? "host.docker.internal" : env.get("BIND_ADDR", "127.0.0.1") || "127.0.0.1";
	const llamaUrl = `http://${host}:${env.get("LLAMA_PORT", "8080")}`;
	const forgeUrl = `http://${host}:${env.get("FORGE_PORT", "8081")}`;

	const [propsR, slotsR, metricsR, healthR, modelsR, loraR, psR, vramR] = await Promise.allSettled([
		getJson<any>(`${llamaUrl}/props`, DIRECT_TIMEOUT_MS),
		getJson<any[]>(`${llamaUrl}/slots`, QUEUE_BACKED_TIMEOUT_MS),
		getText(`${llamaUrl}/metrics`, QUEUE_BACKED_TIMEOUT_MS),
		getJson<any>(`${forgeUrl}/health`, DIRECT_TIMEOUT_MS),
		getJson<any>(`${forgeUrl}/v1/models`, DIRECT_TIMEOUT_MS),
		getJson<any[]>(`${llamaUrl}/lora-adapters`, QUEUE_BACKED_TIMEOUT_MS),
		pi.exec("docker", ["ps", "--format", "{{.Names}}\t{{.State}}"], { timeout: 10_000 }),
		dockerVram(pi, compose),
	]);

	let llama: StackStatus["llama"];
	if (propsR.status === "fulfilled") {
		const p = propsR.value;
		// props.n_ctx is null on this build; the real value lives on
		// default_generation_settings and on each slot. Reading the top-level
		// field would silently report "unknown context" forever.
		const nCtx = p?.default_generation_settings?.n_ctx ?? p?.n_ctx ?? null;
		llama = {
			ok: true,
			modelPath: p?.model_path ?? "?",
			modelAlias: p?.model_alias ?? "?",
			build: p?.build_info ?? "?",
			nCtx: typeof nCtx === "number" ? nCtx : null,
			sleeping: Boolean(p?.is_sleeping),
			totalSlots: typeof p?.total_slots === "number" ? p.total_slots : null,
			toolCalls: p?.chat_template_caps?.supports_tool_calls ?? null,
			slots:
				slotsR.status === "fulfilled" && Array.isArray(slotsR.value)
					? slotsR.value.map((s: any) => ({
							id: s?.id ?? -1,
							nCtx: typeof s?.n_ctx === "number" ? s.n_ctx : null,
							processing: Boolean(s?.is_processing),
							cachedTokens: typeof s?.n_prompt_tokens_cache === "number" ? s.n_prompt_tokens_cache : null,
							speculative: typeof s?.speculative === "boolean" ? s.speculative : null,
						}))
					: null,
			slotsError: slotsR.status === "rejected" ? String(slotsR.reason?.message ?? slotsR.reason) : null,
			metrics: metricsR.status === "fulfilled" ? parsePrometheus(metricsR.value) : null,
			metricsError: metricsR.status === "rejected" ? String(metricsR.reason?.message ?? metricsR.reason) : null,
			loraCount: loraR.status === "fulfilled" && Array.isArray(loraR.value) ? loraR.value.length : null,
			// /props answered while every queue-backed endpoint timed out: the
			// server is listening and its task queue is not draining. Inference
			// is down too, though a plain health check still passes.
			queueWedged:
				slotsR.status === "rejected" &&
				isTimeout(slotsR.reason) &&
				metricsR.status === "rejected" &&
				isTimeout(metricsR.reason),
		};
	} else {
		llama = { ok: false, error: String(propsR.reason?.message ?? propsR.reason) };
	}

	let forge: StackStatus["forge"];
	if (healthR.status === "fulfilled") {
		forge = {
			ok: true,
			health: healthR.value?.status ?? "ok",
			models:
				modelsR.status === "fulfilled" && Array.isArray(modelsR.value?.data)
					? modelsR.value.data.map((m: any) => String(m?.id ?? "?"))
					: [],
		};
	} else {
		forge = { ok: false, error: String(healthR.reason?.message ?? healthR.reason) };
	}

	const containers: StackStatus["containers"] = [];
	if (psR.status === "fulfilled" && psR.value.code === 0) {
		const running = new Map<string, string>();
		for (const line of psR.value.stdout.split("\n")) {
			const [name, state] = line.split("\t");
			if (name) running.set(name.trim(), (state ?? "").trim());
		}
		for (const [service, name] of compose.containers) {
			containers.push({ service, name, state: running.get(name) ?? "not running" });
		}
	}

	return {
		root: env.root,
		llamaUrl,
		forgeUrl,
		llama,
		forge,
		containers,
		vram: vramR.status === "fulfilled" ? vramR.value : null,
		settings: HEADLINE_KEYS.filter((k) => env.get(k) !== "").map((k) => [k, env.get(k)] as [string, string]),
		generatedAt: Date.now(),
	};
}

/**
 * VRAM has to be read from inside the llama container: nvidia-smi is not on
 * PATH in the pi container, and asking the host for it would report the whole
 * GPU rather than what this stack is holding.
 */
async function dockerVram(pi: ExtensionAPI, compose: ComposeInfo): Promise<string | null> {
	const name = compose.containers.get("llama");
	if (!name) return null;
	try {
		const r = await pi.exec(
			"docker",
			["exec", name, "nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader"],
			{ timeout: 15_000 },
		);
		if (r.code !== 0) return null;
		return r.stdout.trim().split("\n")[0] ?? null;
	} catch {
		return null;
	}
}

// --- formatting --------------------------------------------------------------

function fmtInt(n: number): string {
	return n.toLocaleString("en-US");
}

function statusLines(s: StackStatus): string[] {
	const out: string[] = [];

	if (s.llama.ok) {
		const l = s.llama;
		out.push(`llama    ${l.modelAlias}  build ${l.build}${l.sleeping ? "  [SLEEPING]" : ""}`);
		out.push(`         ${l.modelPath}`);
		if (l.queueWedged) {
			out.push("");
			out.push("         *** TASK QUEUE WEDGED ***");
			out.push("         /props answers, but /slots and /metrics time out. Those go");
			out.push("         through the same queue as inference, so requests are hanging");
			out.push("         too — a plain health check will not show this.");
			out.push("         Recover with: /stack restart llama   (~20 min cold load)");
			out.push("");
		}
		out.push(
			`         n_ctx ${l.nCtx !== null ? fmtInt(l.nCtx) : "?"}` +
				`   slots ${l.totalSlots ?? "?"}` +
				`   tool calls ${l.toolCalls === null ? "?" : l.toolCalls ? "yes" : "NO"}` +
				`   lora ${l.loraCount ?? "?"}`,
		);
		if (l.slots) {
			for (const sl of l.slots) {
				// n_prompt_tokens_cache is absent from /slots until the slot has
				// served a request, so "not reported yet" is the normal state on a
				// freshly loaded server rather than a read failure.
				out.push(
					`         slot ${sl.id}: ${sl.processing ? "busy" : "idle"}` +
						`  cached ${sl.cachedTokens !== null ? `${fmtInt(sl.cachedTokens)} tok` : "(unused)"}` +
						`  mtp ${sl.speculative === null ? "?" : sl.speculative ? "on" : "off"}`,
				);
			}
		} else if (l.slotsError) {
			out.push(`         slots unreadable: ${l.slotsError}`);
		}
		if (l.metrics) {
			const pp = l.metrics.get("llamacpp:prompt_tokens_seconds");
			const tg = l.metrics.get("llamacpp:predicted_tokens_seconds");
			const proc = l.metrics.get("llamacpp:requests_processing");
			const defer = l.metrics.get("llamacpp:requests_deferred");
			const kv = l.metrics.get("llamacpp:kv_cache_usage_ratio");
			const parts: string[] = [];
			if (pp !== undefined) parts.push(`prefill ${pp.toFixed(0)} tok/s`);
			if (tg !== undefined) parts.push(`decode ${tg.toFixed(1)} tok/s`);
			if (kv !== undefined) parts.push(`kv ${(kv * 100).toFixed(0)}%`);
			if (proc !== undefined) parts.push(`processing ${proc}`);
			if (defer !== undefined && defer > 0) parts.push(`deferred ${defer}`);
			if (parts.length) out.push(`         ${parts.join("   ")}`);
		} else if (l.metricsError) {
			out.push(`         metrics unreadable: ${l.metricsError}`);
		}
	} else {
		out.push(`llama    UNREACHABLE at ${s.llamaUrl} — ${s.llama.error}`);
	}

	if (s.forge.ok) {
		out.push(`forge    ${s.forge.health}   models: ${s.forge.models.join(", ") || "(none listed)"}`);
	} else {
		out.push(`forge    UNREACHABLE at ${s.forgeUrl} — ${s.forge.error}`);
	}

	if (s.vram) out.push(`gpu      ${s.vram}`);

	if (s.containers.length) {
		out.push(`docker   ${s.containers.map((c) => `${c.service}=${c.state}`).join("   ")}`);
	}

	if (s.settings.length) {
		out.push("");
		out.push("settings (.env, .env.local, exported)");
		const width = Math.max(...s.settings.map(([k]) => k.length));
		for (const [k, v] of s.settings) out.push(`  ${k.padEnd(width)}  ${v}`);
	}

	return out;
}

// --- extension ---------------------------------------------------------------

interface StatusEntry {
	title: string;
	lines: string[];
	tone: "info" | "warn" | "error";
}

const SUBCOMMANDS = [
	"status",
	"env",
	"set",
	"up",
	"down",
	"restart",
	"smoke",
	"eval",
	"bench",
	"logs",
	"slots",
	"help",
];

export default function stackExtension(pi: ExtensionAPI) {
	const root = findRepoRoot();

	pi.registerEntryRenderer<StatusEntry>("stack-report", (entry, { expanded }, theme) => {
		const data = entry.data ?? { title: "stack", lines: [], tone: "info" as const };
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

	const report = (title: string, lines: string[], tone: StatusEntry["tone"] = "info") =>
		pi.appendEntry<StatusEntry>("stack-report", { title, lines, tone });

	// The repo is the unit of control here. Without it there is nothing to point
	// at, and a half-working /stack that silently targets the wrong directory is
	// worse than one that refuses.
	if (!root) {
		pi.registerCommand("stack", {
			description: "Control the forge + llama.cpp stack (unavailable: repo not found)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					"qwen3.6-forge repo not found from this directory — /stack needs docker-compose.yml, .env and scripts/lib.sh.",
					"error",
				);
			},
		});
		return;
	}

	const env = new StackEnv(root);
	const compose = readCompose(root);

	// --- read-only observation, exposed to the model -------------------------
	pi.registerTool({
		name: "stack_status",
		label: "Stack status",
		description:
			"Read the live state of the local inference stack: loaded model, context size, slot cache, " +
			"speculative decoding, prefill/decode throughput, GPU memory, forge health and the effective " +
			".env settings. Read-only — it cannot change or restart anything.",
		promptSnippet: "Inspect the local forge + llama.cpp stack (model, context, throughput, GPU, settings)",
		promptGuidelines: [
			"Use stack_status before blaming the model for slow or truncated output — it reports prefill/decode throughput, KV usage and whether a slot is busy.",
			"stack_status is read-only. Restarting or reconfiguring the stack is a user action via /stack; do not ask to run it as a tool.",
		],
		parameters: Type.Object({}),
		async execute() {
			const s = await collectStatus(pi, env, compose);
			return {
				content: [{ type: "text", text: statusLines(s).join("\n") }],
				details: { llamaUrl: s.llamaUrl, forgeUrl: s.forgeUrl },
			};
		},
	});

	// --- user-only control ----------------------------------------------------
	pi.registerCommand("stack", {
		description: "Inspect and control the forge + llama.cpp stack",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const hits = SUBCOMMANDS.filter((c) => c.startsWith(parts[0] ?? ""));
				return hits.length ? hits.map((c) => ({ value: c, label: c })) : null;
			}
			if (parts[0] === "set" && parts.length === 2) {
				const hits = [...env.keysInEnvFile].filter((k) => k.startsWith(parts[1])).sort();
				return hits.length ? hits.slice(0, 40).map((k) => ({ value: `set ${k}=`, label: k })) : null;
			}
			if (parts[0] === "slots" && parts.length === 2) {
				const hits = ["save", "restore", "erase"].filter((a) => a.startsWith(parts[1]));
				return hits.length ? hits.map((a) => ({ value: `slots ${a}`, label: a })) : null;
			}
			if ((parts[0] === "restart" || parts[0] === "logs") && parts.length === 2) {
				const hits = ["llama", "forge"].filter((a) => a.startsWith(parts[1]));
				return hits.length ? hits.map((a) => ({ value: `${parts[0]} ${a}`, label: a })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = (argv[0] ?? "status").toLowerCase();
			const rest = argv.slice(1);

			switch (sub) {
				case "status":
					return showStatus(ctx);
				case "env":
					return showEnv(rest[0]);
				case "set":
					return setKey(ctx, rest.join(" "));
				case "up":
				case "down":
				case "restart":
					return lifecycle(ctx, sub, rest[0]);
				case "smoke":
					return runScript(ctx, "smoke-test.sh", [], 900_000, "smoke");
				case "eval":
					return runScript(ctx, "run-eval.sh", rest, 5_400_000, "eval");
				case "bench":
					return runScript(ctx, "bench.sh", rest, 3_600_000, "bench");
				case "logs":
					return showLogs(rest[0]);
				case "slots":
					return slots(ctx, rest);
				case "help":
					return showHelp();
				default:
					ctx.ui.notify(`Unknown subcommand '${sub}'. Try /stack help`, "warning");
			}
		},
	});

	async function showStatus(ctx: ExtensionCommandContext) {
		ctx.ui.setWorkingMessage?.("Reading stack status…");
		try {
			const s = await collectStatus(pi, env, compose);
			const bad = !s.llama.ok || !s.forge.ok;
			report("stack", statusLines(s), bad ? "error" : "info");
		} finally {
			ctx.ui.setWorkingMessage?.(undefined);
		}
	}

	function showEnv(filter?: string) {
		const needle = filter?.toUpperCase();
		const rows = env.entries().filter(([k]) => !needle || k.includes(needle));
		if (!rows.length) {
			report("stack env", [`no keys matching '${filter}'`], "warn");
			return;
		}
		const width = Math.max(...rows.map(([k]) => k.length));
		report(
			`stack env${filter ? ` ~ ${filter}` : ""}`,
			rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`),
		);
	}

	async function setKey(ctx: ExtensionCommandContext, expr: string) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(expr.trim());
		if (!m) {
			ctx.ui.notify("Usage: /stack set KEY=VALUE", "warning");
			return;
		}
		const [, key, value] = m;

		// env_set() in lib.sh refuses to append a key that is not already there,
		// on the grounds that a typo'd key would otherwise sit in .env doing
		// nothing. Fail here too, where the message can be more useful.
		if (!env.keysInEnvFile.has(key)) {
			report("stack set", [`'${key}' is not in .env — refusing to append it blindly.`, "", "Add it to .env by hand if it is genuinely new."], "error");
			return;
		}

		// env_set() rewrites the line with `sed -E "s|...|\1VALUE|"`. In that
		// replacement `&` expands to the whole match, `\` starts an escape and
		// `|` ends the expression — so those three do not fail, they silently
		// write something else into .env. Refuse them here rather than corrupt
		// the file. No key this stack has ever needed contains one.
		const sedHostile = /[|&\\]/.exec(value);
		if (sedHostile || /[\x00-\x1f]/.test(value)) {
			report(
				"stack set",
				[
					`Refusing to write ${key}: the value contains ${sedHostile ? `'${sedHostile[0]}'` : "a control character"}.`,
					"",
					"env_set() in scripts/lib.sh rewrites the line with sed, where | & and \\",
					"are metacharacters — the write would succeed and store the wrong text.",
					"Edit .env by hand if you genuinely need that value.",
				],
				"error",
			);
			return;
		}

		const current = env.get(key);
		if (current === value) {
			report("stack set", [`${key} is already ${value || "(empty)"} — nothing to do.`], "warn");
			return;
		}

		const owners = compose.keyOwners.get(key) ?? [];
		const runtime = owners.filter((o) => o === "llama" || o === "forge");
		const clientOnly = CLIENT_ONLY_KEYS.has(key);

		// Each service gets its own reason for why this cannot be applied live —
		// they are genuinely different, and "restart it" is easier to accept when
		// it says which wall you are up against.
		const why = runtime.includes("llama")
			? "llama-server answers 501 to POST /props"
			: "forge 0.8.2 has no admin API and is CLI-flag driven";

		const consequence = clientOnly
			? "Read by scripts/pi-local.sh at launch — restart pi to pick it up. No container restart needed."
			: runtime.length
				? `Read by ${runtime.join(" and ")} at startup. ${why}, so this only takes effect after: ` +
					`/stack restart ${runtime.join(" ")}` +
					(runtime.includes("llama") ? "  (llama is a ~20 minute cold load on this box)" : "")
				: owners.length
					? `Used by ${owners.join(", ")} — one-shot tooling, picked up on their next run.`
					: "Not referenced by docker-compose.yml — it may be read by a script at run time.";

		const ok = await ctx.ui.confirm(
			`Set ${key}?`,
			`${key}\n  from: ${current || "(empty)"}\n  to:   ${value || "(empty)"}\n\n${consequence}\n\nEdits ${join(root!, ".env")}.`,
		);
		if (!ok) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		// Delegated to lib.sh rather than reimplemented: env_set() already
		// preserves comments and ordering, and two writers with different rules
		// on the same file is how .env files get mangled.
		//
		// key/value/path go in as positional parameters, never interpolated into
		// the script text. JSON.stringify would have looked like escaping while
		// leaving `$(...)`, backticks and `${...}` live inside bash double
		// quotes — /stack set FOO=$(rm -rf ~) would have run.
		const script = 'set -euo pipefail\nsource "$1"\nenv_set "$2" "$3"\n';
		const r = await pi.exec("bash", ["-c", script, "stack-set", join(root!, "scripts", "lib.sh"), key, value], {
			cwd: root!,
			timeout: 20_000,
		});
		if (r.code !== 0) {
			report("stack set", [`env_set failed (exit ${r.code})`, r.stderr.trim() || r.stdout.trim()], "error");
			return;
		}
		report("stack set", [`${key}: ${current || "(empty)"} -> ${value || "(empty)"}`, "", consequence], "warn");
	}

	async function lifecycle(ctx: ExtensionCommandContext, action: string, target?: string) {
		if (target && target !== "llama" && target !== "forge") {
			ctx.ui.notify(`Unknown service '${target}' — use llama or forge`, "warning");
			return;
		}

		if (action === "restart") {
			const what = target ?? "the whole stack";
			const cold = !target || target === "llama";
			const ok = await ctx.ui.confirm(
				`Restart ${what}?`,
				cold
					? "llama reloads the GGUF from a 9p bind mount with --load-mode none.\nExpect roughly 20 minutes before it answers again.\n\nAny in-flight request will fail."
					: "forge restarts in seconds. In-flight requests will fail.",
			);
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			const services = target ? [target] : ["llama", "forge"];
			ctx.ui.setWorkingMessage?.(`Recreating ${services.join(", ")}…`);
			try {
				const script =
					`set -euo pipefail\n` +
					`source "${join(root!, "scripts", "lib.sh")}"\n` +
					`compose up -d --force-recreate ${services.join(" ")}\n`;
				const r = await pi.exec("bash", ["-c", script], { cwd: root!, timeout: 600_000 });
				report(
					"stack restart",
					[
						`docker compose up -d --force-recreate ${services.join(" ")} (exit ${r.code})`,
						...tail(r.stdout + r.stderr, 20),
						"",
						cold ? "llama is loading. /stack status will show it once /props answers." : "",
					].filter(Boolean),
					r.code === 0 ? "warn" : "error",
				);
			} finally {
				ctx.ui.setWorkingMessage?.(undefined);
			}
			return;
		}

		if (action === "down") {
			const ok = await ctx.ui.confirm("Stop the stack?", "pi is talking to forge — this will end the session's model access.");
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
		}
		await runScript(ctx, action === "up" ? "up.sh" : "down.sh", [], 900_000, `stack ${action}`);
	}

	async function runScript(
		ctx: ExtensionCommandContext,
		script: string,
		scriptArgs: string[],
		timeout: number,
		title: string,
	) {
		const path = join(root!, "scripts", script);
		if (!existsSync(path)) {
			report(title, [`missing script: ${path}`], "error");
			return;
		}
		ctx.ui.setWorkingMessage?.(`Running ${script}…`);
		const started = Date.now();
		try {
			const r = await pi.exec("bash", [path, ...scriptArgs], { cwd: root!, timeout });
			const secs = ((Date.now() - started) / 1000).toFixed(0);
			report(
				title,
				[
					`${script} ${scriptArgs.join(" ")}`.trim() + `  ->  exit ${r.code}${r.killed ? " (timed out)" : ""} in ${secs}s`,
					"",
					...tail(r.stdout, 60),
					...(r.stderr.trim() ? ["", "stderr:", ...tail(r.stderr, 20)] : []),
				],
				r.code === 0 ? "info" : "error",
			);
		} catch (e: any) {
			report(title, [`failed to run ${script}: ${e?.message ?? e}`], "error");
		} finally {
			ctx.ui.setWorkingMessage?.(undefined);
		}
	}

	async function showLogs(service?: string) {
		const name = compose.containers.get(service ?? "llama");
		if (!name) {
			report("stack logs", [`no container_name for service '${service ?? "llama"}'`], "error");
			return;
		}
		const r = await pi.exec("docker", ["logs", "--tail", "60", name], { timeout: 30_000 });
		report(`stack logs ${service ?? "llama"}`, tail(r.stdout + r.stderr, 60), r.code === 0 ? "info" : "error");
	}

	/**
	 * Slot KV save/restore is the only live control llama-server offers on this
	 * build, and it is far more dangerous here than its reputation suggests.
	 *
	 * Measured on this box, b10200, one 32k slot: a save wrote 315 MB in 180 s
	 * and had not finished. Worse, aborting one mid-write wedged the server's
	 * task queue — /slots, /metrics and every inference request hung from then
	 * on, while /props kept answering, and recovery took a container recreate
	 * and a 20-minute cold load.
	 *
	 * Two consequences are baked in below. There is no client-side timeout, so
	 * pi can never be the thing that aborts a save; and the queue is re-probed
	 * afterwards so a wedge is reported immediately rather than discovered later
	 * as "the model has gone quiet".
	 *
	 * The route is POST /slots/{id}?action=... . The query-string form
	 * (POST /slots?action=..&id_slot=..) returns 404 on b10200 — which is what
	 * scripts/slot-cache.sh used to send, silently, into `|| true`.
	 */
	async function slots(ctx: ExtensionCommandContext, rest: string[]) {
		const action = (rest[0] ?? "").toLowerCase();
		if (!["save", "restore", "erase"].includes(action)) {
			report("stack slots", ["Usage: /stack slots save|restore|erase [slot-id]"], "warn");
			return;
		}
		const id = rest[1] ? Number(rest[1]) : 0;
		if (!Number.isInteger(id) || id < 0) {
			ctx.ui.notify(`Bad slot id '${rest[1]}'`, "warning");
			return;
		}

		if (action !== "erase") {
			const ok = await ctx.ui.confirm(
				`${action} slot ${id}?`,
				`Measured here: a 32k slot save wrote 315 MB in 180s without finishing,\n` +
					`and aborting one wedged llama's task queue — inference included —\n` +
					`until the container was recreated (~20 min cold load).\n\n` +
					`This cannot be cancelled once started, by design: interrupting it is\n` +
					`what causes the wedge. The slot is blocked meanwhile, so this session's\n` +
					`own requests will queue behind it.\n\nProceed?`,
			);
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
		}

		const inDocker = existsSync("/.dockerenv");
		const host = inDocker ? "host.docker.internal" : env.get("BIND_ADDR", "127.0.0.1") || "127.0.0.1";
		const llamaBase = `http://${host}:${env.get("LLAMA_PORT", "8080")}`;
		const url = `${llamaBase}/slots/${id}?action=${action}`;
		const body = action === "erase" ? "{}" : JSON.stringify({ filename: `slot_${id}.session` });

		ctx.ui.setWorkingMessage?.(`slot ${id}: ${action} (do not interrupt)…`);
		const started = Date.now();
		const lines: string[] = [];
		let tone: StatusEntry["tone"] = "info";
		try {
			// Deliberately no AbortSignal: see the note above.
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			const text = await res.text();
			lines.push(`slot ${id}: HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
			if (text.trim()) lines.push(...tail(text, 10));
			if (!res.ok) tone = "error";
		} catch (e: any) {
			lines.push(`slot ${id}: request failed after ${((Date.now() - started) / 1000).toFixed(0)}s — ${e?.message ?? e}`);
			lines.push("llama may still be writing server-side; it does not stop when the client does.");
			lines.push(`Check: docker exec ${compose.containers.get("llama") ?? "llama"} ls -l /slots`);
			tone = "error";
		}

		// Whatever happened above, establish whether the queue still drains.
		try {
			await getJson<any[]>(`${llamaBase}/slots`, QUEUE_BACKED_TIMEOUT_MS);
			lines.push("", "Queue check: /slots still answers — llama is healthy.");
		} catch (e: any) {
			tone = "error";
			lines.push(
				"",
				`Queue check: /slots did not answer (${e?.message ?? e}).`,
				"If /props still responds, the task queue is wedged and inference is down.",
				"Recover with: /stack restart llama   (~20 min cold load)",
			);
		}

		ctx.ui.setWorkingMessage?.(undefined);
		report(`stack slots ${action}`, lines, tone);
	}

	function showHelp() {
		report("stack help", [
			"/stack [status]           model, context, slots, throughput, GPU, forge, settings",
			"/stack env [FILTER]       every effective setting (.env + .env.local + exported)",
			"/stack set KEY=VALUE      edit .env, and say exactly what must restart",
			"/stack up | down          start / stop the stack via scripts/",
			"/stack restart [svc]      recreate llama and/or forge  (llama ≈ 20 min cold load)",
			"/stack smoke              scripts/smoke-test.sh",
			"/stack eval [--history]   scripts/run-eval.sh",
			"/stack bench [args]       scripts/bench.sh",
			"/stack logs [llama|forge] last 60 log lines",
			"/stack slots save|restore|erase [id]",
			"",
			"The model can call stack_status to read the stack. It cannot change it:",
			"every mutation above is a user-only command on purpose.",
			"",
			"Reconfiguration is never live — llama-server answers 501 to POST /props,",
			"and forge 0.8.2 is CLI-flag driven with no admin API.",
		]);
	}
}

function tail(text: string, n: number): string[] {
	const lines = text.replace(/\s+$/, "").split("\n");
	return lines.length <= n ? lines : lines.slice(lines.length - n);
}
