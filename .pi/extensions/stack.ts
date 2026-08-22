/**
 * /stack — inspect and control the forge + llama.cpp stack from inside pi.
 *
 * Everything here was written against endpoints probed on the running build
 * (llama-server b10200, forge 0.9.0), not against upstream docs. Two of those
 * probes contradicted the docs, and the contradictions shape this file:
 *
 *   1. `POST /props` answers 501 on this build. Nothing that llama-server takes
 *      as a startup flag — context, temperature, reasoning budget, MTP — can be
 *      changed at runtime. So `set` edits .env and tells you what to recreate;
 *      it never pretends to have tuned a live server.
 *
 *   2. forge 0.9.0 moved its own liveness to `/forge/health` and turned
 *      `/health` into the BACKEND's readiness, forwarded — measured returning
 *      502 with llama down, where 0.8.2's `/health` was unconditional forge
 *      liveness. `/v1/models` likewise forwards the backend's real catalog
 *      instead of a synthesized one-model list. So the forge probe below reads
 *      `/forge/health`, and a red forge line now means forge itself is gone,
 *      not that the model is still loading. Probe before you believe a route.
 *
 * The split that matters: observation is a model-callable tool (`stack_status`),
 * every mutation is a user-only command. The model should be able to see that
 * prefill collapsed; it should not be able to restart llama mid-task.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** An HTTP error that kept its status and body, so callers can tell 503-loading
 *  apart from 503-something-else without a second request. */
class HttpError extends Error {
	status: number;
	body: string;
	constructor(status: number, body: string) {
		super(`HTTP ${status}`);
		this.status = status;
		this.body = body;
	}
}

async function getJson<T>(url: string, timeoutMs = DIRECT_TIMEOUT_MS): Promise<T> {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
	return (await res.json()) as T;
}

/**
 * llama-server answers every endpoint with
 *   503 {"error":{"message":"Loading model",...}}
 * while it reads the GGUF. That is a normal 9-20 minute state on this box after
 * any recreate, not a fault — and reporting it as "UNREACHABLE" sends people
 * looking for a broken stack. It is also what a client sees as a bare
 * "Backend returned 503" if it asks the model a question mid-load.
 */
function isLoading(reason: unknown): boolean {
	return reason instanceof HttpError && reason.status === 503 && /loading model/i.test(reason.body);
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
		| { ok: false; error: string; loading: boolean };
	forge: { ok: true; health: string; models: string[] } | { ok: false; error: string };
	containers: Array<{ service: string; name: string; state: string; uptime: string }>;
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
	"REASONING_EFFORT",
	"THINK_LANG",
	"FORGE_CAPABILITY",
	"FORGE_MAX_RETRIES",
	"FORGE_VERSION",
	"LLAMA_TAG",
];

/**
 * The verdict of one `pi.exec`, with `killed` read before `code`.
 *
 * Forge fork, eighteenth pass (AI5). `pi.exec` is pi's `execCommand`
 * (`core/exec.js`), whose body is a `new Promise((resolve) => …)` with no
 * `reject` in it, and which resolves a child it killed on its own timeout with
 * `code: code ?? 0` — a signalled child exits with a signal and NO code. So
 * `result.code === 0` is TRUE for a command that never finished, and a
 * code-first verdict reads a wedge as a success that printed nothing.
 *
 * The seventeenth pass fixed the two call sites in this file where that produced
 * a wrong READING — `docker ps` (every container reported "not running") and
 * `dockerVram` — and left the other seven with a reason written into
 * `context/testing/probes/u2-the-probe-that-did-not-answer.mjs`:
 *
 * > The remaining seven are script runners whose output is reported verbatim,
 * > where a wedge shows up as empty output rather than as a wrong verdict.
 *
 * Five of the seven do not report output verbatim; they choose a verdict from
 * `r.code` and say a sentence about it. The worst two are the pair that recreate
 * llama, both on a 600-second timeout, in a file whose own text says the cold
 * load is "~9-20 minutes" — so the timeout is INSIDE the operation's normal
 * duration, and a killed `compose up -d --force-recreate llama` reported
 * *"llama recreated"*, at `warn`, to an operator who then waits for a container
 * that was never brought up. `/stack set` was the same shape one layer quieter:
 * a killed `env_set` was reported as `KEY: old -> new`, i.e. as an .env write
 * that did not happen.
 *
 * One helper rather than seven inline tests, for the reason
 * `vendor/pi-subagents-lite/src/spawn/git-failure.ts` is one module: the next
 * `pi.exec` in this file will be written by somebody reading a neighbour.
 * `tests/exec-verdicts.test.ts` in that package is the standing scan, and it now
 * covers this directory too.
 *
 * Returns undefined when the command really did run and exit 0.
 */
export function execVerdict(
	result: { code: number; killed?: boolean },
	timeoutMs: number,
): { failed: true; reason: string; killed: boolean } | undefined {
	if (result.killed) {
		return {
			failed: true,
			killed: true,
			reason: `did not finish within ${Math.round(timeoutMs / 1000)}s and was killed — it did not run to completion, so nothing below is its answer`,
		};
	}
	if (result.code !== 0) return { failed: true, killed: false, reason: `exited ${result.code}` };
	return undefined;
}

async function collectStatus(pi: ExtensionAPI, env: StackEnv, compose: ComposeInfo): Promise<StackStatus> {
	const inDocker = existsSync("/.dockerenv");
	const host = inDocker ? "host.docker.internal" : env.get("BIND_ADDR", "127.0.0.1") || "127.0.0.1";
	const llamaUrl = `http://${host}:${env.get("LLAMA_PORT", "8080")}`;
	const forgeUrl = `http://${host}:${env.get("FORGE_PORT", "8081")}`;

	const [propsR, slotsR, metricsR, healthR, modelsR, loraR, psR, vramR] = await Promise.allSettled([
		getJson<any>(`${llamaUrl}/props`, DIRECT_TIMEOUT_MS),
		getJson<any[]>(`${llamaUrl}/slots`, QUEUE_BACKED_TIMEOUT_MS),
		getText(`${llamaUrl}/metrics`, QUEUE_BACKED_TIMEOUT_MS),
		getJson<any>(`${forgeUrl}/forge/health`, DIRECT_TIMEOUT_MS),
		getJson<any>(`${forgeUrl}/v1/models`, DIRECT_TIMEOUT_MS),
		getJson<any[]>(`${llamaUrl}/lora-adapters`, QUEUE_BACKED_TIMEOUT_MS),
		dockerPs(pi),
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
		llama = {
			ok: false,
			error: String((propsR.reason as any)?.message ?? propsR.reason),
			loading: isLoading(propsR.reason),
		};
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
	// `dockerPs` returns null for a daemon that did not answer, and leaving
	// `containers` empty is the honest answer: the formatter prints nothing for a
	// service it was never told about, rather than a false "not running".
	const running = psR.status === "fulfilled" ? psR.value : null;
	if (running) {
		for (const [service, name] of compose.containers) {
			const r = running.get(name);
			containers.push({ service, name, state: r?.state ?? "not running", uptime: r?.uptime ?? "" });
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
 * What docker says is running, or null when it did not say.
 *
 * Seventeenth pass (AH3): `!killed` before `code`, and it is not defensive.
 * `pi.exec` is pi's `execCommand`, which resolves a child it killed on its own
 * timeout with `code: code ?? 0` — a signalled child exits with a signal and NO
 * code — and an empty stdout. So a docker daemon that did not answer within ten
 * seconds arrived looking exactly like a healthy `docker ps` that listed
 * nothing, and every container in the compose file was reported "not running".
 * On this box the documented way docker wedges is memory pressure, which is also
 * exactly when an operator runs `/stack status`, and the obvious next action on
 * that report is to recreate containers that are fine.
 *
 * Eighteenth pass (AI5): lifted out of `collectStatus`'s `Promise.allSettled`
 * array so the verdict sits next to the call. It was twenty-three lines away,
 * which is correct and invisible to a scan — and `tests/exec-verdicts.test.ts`
 * now covers this directory, with a twelve-line window.
 */
async function dockerPs(pi: ExtensionAPI): Promise<Map<string, { state: string; uptime: string }> | null> {
	try {
		const r = await pi.exec("docker", ["ps", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"], {
			timeout: 10_000,
		});
		if (execVerdict(r, 10_000)) return null;
		const running = new Map<string, { state: string; uptime: string }>();
		for (const line of r.stdout.split("\n")) {
			const [name, state, status] = line.split("\t");
			if (name) running.set(name.trim(), { state: (state ?? "").trim(), uptime: (status ?? "").trim() });
		}
		return running;
	} catch {
		return null;
	}
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
		// `killed` first, for the reason spelled out at the `docker ps` call site:
		// a wedged daemon resolves `code: 0` with nothing on stdout, and `""` is
		// not a VRAM reading. Through `execVerdict` since AI5, so there is one
		// implementation of the rule in this file rather than a copy per site.
		if (execVerdict(r, 15_000)) return null;
		return r.stdout.trim().split("\n")[0] || null;
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
	} else if (s.llama.loading) {
		const c = s.containers.find((x) => x.service === "llama");
		out.push(`llama    LOADING — reading the GGUF into VRAM${c?.uptime ? `  (container ${c.uptime.toLowerCase()})` : ""}`);
		out.push(`         Normal after any recreate: ~9-20 min on this box.`);
		out.push(`         Until it finishes every request fails with 503 "Loading model",`);
		out.push(`         which a client shows as a bare "Backend returned 503".`);
		out.push(`         Re-run /stack to check; ./scripts/logs.sh llama to watch.`);
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
];

/**
 * Is this factory being run for a SUBAGENT's session?
 *
 * A subagent does not inherit the parent's `-e` flags, but it does DISCOVER
 * `<cwd>/.pi/extensions/**` — so everything in this directory reaches a child for
 * free, measured: `vendor/pi-subagents-lite/src/agents/subagent-denylist.ts`
 * records compaction-guard capping a CHILD's own `read` result inside the child
 * session. `stack_status` arrived by the same route and nobody asked for it: it
 * costs a child ~173 tokens of schema on every turn of a window whose whole value
 * is coming back with a small answer, against the ~177 that justified removing
 * the `loop` tool from children, and a subagent has no business inspecting the
 * inference stack it is running on.
 *
 * `vendor/pi-subagents-lite` publishes its spawn depth on this global for exactly
 * this check; see that package's `src/shell.ts`. Absent (a plain pi session, or
 * this file used anywhere else) reads as false, so nothing changes.
 */
function bornInsideSubagentSpawn(): boolean {
	const depth = (globalThis as unknown as Record<string, unknown>)["__PI_SUBAGENT_SPAWN_DEPTH__"];
	return typeof depth === "number" && depth > 0;
}

export default function stackExtension(pi: ExtensionAPI) {
	// A subagent's instance registers nothing: not `stack_status`, not `/stack`,
	// not the entry renderer. Observation is for the operator's session.
	if (bornInsideSubagentSpawn()) return;

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
					"qwen3.8-forge repo not found from this directory — /stack needs docker-compose.yml, .env and scripts/lib.sh.",
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
			if (parts[0] === "mode" && parts.length === 2) {
				const hits = listModes().filter((m) => m.startsWith(parts[1]));
				return hits.length ? hits.map((m) => ({ value: `mode ${m}`, label: m })) : null;
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
				case "mode":
					return mode(ctx, rest);
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

	/** Mode names, from modes/*.env — the same files scripts/mode.sh reads. */
	function listModes(): string[] {
		try {
			return readdirSync(join(root!, "modes"))
				.filter((f) => f.endsWith(".env"))
				.map((f) => f.slice(0, -4))
				.sort();
		} catch {
			return [];
		}
	}

	/**
	 * Switching regimes is delegated to scripts/mode.sh rather than reimplemented
	 * here. Two implementations of "what is prose mode" would drift, and the one
	 * in the shell is the one that also works without pi running.
	 */
	async function mode(ctx: ExtensionCommandContext, rest: string[]) {
		const script = join(root!, "scripts", "mode.sh");
		if (!existsSync(script)) {
			report("stack mode", [`missing ${script}`], "error");
			return;
		}
		const target = rest[0];

		if (!target) {
			const r = await pi.exec("bash", [script], { cwd: root!, timeout: 60_000 });
			// AI5: `killed` before `code`. See execVerdict.
			const bad = execVerdict(r, 60_000);
			report(
				"stack mode",
				[
					...(bad ? [`mode.sh ${bad.reason}`, ""] : []),
					...tail(cleanShellOutput(r.stdout, r.stderr).join("\n"), 60),
				],
				bad ? "error" : "info",
			);
			return;
		}

		const modes = listModes();
		if (modes.length && !modes.includes(target)) {
			report("stack mode", [`no such mode '${target}'`, `available: ${modes.join(", ")}`], "error");
			return;
		}

		const ok = await ctx.ui.confirm(
			`Switch to ${target} mode?`,
			`Rewrites the ${target} keys in .env (model, sampling, thinking language).\n\n` +
				`Nothing is live until llama is recreated — llama-server answers 501 to\n` +
				`POST /props — and that is a ~9-20 minute cold load on this box.\n\n` +
				`You will be asked separately whether to restart now.`,
		);
		if (!ok) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		const applied = await pi.exec("bash", [script, target], { cwd: root!, timeout: 120_000 });
		// AI5: `killed` before `code`, and read HERE, next to the call, because
		// twelve lines is what `tests/exec-verdicts.test.ts` scans. A `mode.sh`
		// killed at 120s rewrote an unknown number of .env keys, so the
		// confirmation below — which then offers to recreate llama on the mode it
		// claims is set — must not be printed.
		const applyBad = execVerdict(applied, 120_000);
		// "unchanged" lines are the majority and say nothing; the restart advice is
		// answered by the prompt that follows, so both are dropped here.
		const lines = cleanShellOutput(applied.stdout, applied.stderr, [
			/\(unchanged\)\s*$/,
			// Both are dim() output, and the continuation line is indented — anchor
			// on optional leading space, not on column zero. Trimming the whole line
			// instead would flatten the indented key tree that `/stack mode` prints.
			/^\s*apply it with:/,
			/^\s*or: docker compose/,
		]);
		if (applyBad) {
			report(`stack mode ${target}`, [`mode.sh ${applyBad.reason}`, ...lines], "error");
			return;
		}

		const restart = await ctx.ui.confirm(
			`Recreate llama now?`,
			`.env is on ${target}. Recreating loads the mode's model and sampling.\n` +
				`Expect ~9-20 minutes before it answers again, and this session's model\n` +
				`access goes away for that whole time.\n\nSay no to apply it later.`,
		);
		if (!restart) {
			report(`stack mode ${target}`, [...lines, "", "Not restarted. Apply with: /stack restart llama"], "warn");
			return;
		}

		ctx.ui.setWorkingMessage?.(`Recreating llama on ${target}…`);
		try {
			const bash =
				`set -euo pipefail\nsource "${join(root!, "scripts", "lib.sh")}"\ncompose up -d --force-recreate llama\n`;
			const r = await pi.exec("bash", ["-c", bash], { cwd: root!, timeout: 600_000 });
			// AI5: `killed` before `code`, and this is the site where the two
			// numbers are visibly in conflict — the timeout is ten minutes and the
			// paragraph below says the cold load is nine to twenty. A killed
			// `compose up` reported "llama recreated" and the operator waited for a
			// container that was never brought up.
			const bad = execVerdict(r, 600_000);
			report(
				`stack mode ${target}`,
				[
					...lines,
					"",
					bad
						? `recreate FAILED (${bad.reason})`
						: "llama recreated. It now spends ~9-20 min reading the GGUF, and every",
					...(bad
						? tail(cleanShellOutput(r.stdout, r.stderr).join("\n"), 12)
						: [
								'request until then fails with 503 "Loading model" — asking the model',
								'anything now just returns "Backend returned 503".',
								"",
								"Check with /stack — it reports LOADING until the model is up.",
							]),
				],
				bad ? "error" : "warn",
			);
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
			: "forge has no admin API and is CLI-flag driven";

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
		// AI5: `killed` before `code`. `env_set` rewrites .env in place; a killed
		// one may have written nothing, or half of it, and the line below reports
		// the edit as done.
		const setBad = execVerdict(r, 20_000);
		if (setBad) {
			report(
				"stack set",
				[
					`env_set ${setBad.reason}`,
					...(setBad.killed ? [`Check ${join(root!, ".env")} before assuming ${key} is unchanged.`] : []),
					r.stderr.trim() || r.stdout.trim(),
				],
				"error",
			);
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
				// AI5: `killed` before `code`. The same pair of numbers as the
				// `/stack mode` recreate above — a ten-minute timeout over an
				// operation the confirmation prompt describes as "roughly 20
				// minutes" — so "llama is loading" was said about a compose command
				// pi had killed.
				const bad = execVerdict(r, 600_000);
				report(
					"stack restart",
					[
						`docker compose up -d --force-recreate ${services.join(" ")} (${bad ? bad.reason : "exit 0"})`,
						...tail(r.stdout + r.stderr, 20),
						"",
						bad ? "" : cold ? "llama is loading. /stack status will show it once /props answers." : "",
					].filter(Boolean),
					bad ? "error" : "warn",
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
			// AI5: this one already PRINTED `killed` — "(timed out)" — and then took
			// its severity from `code` alone, so a killed `up.sh` was reported at
			// `info` with the timeout noted inside the body of a green result. The
			// half-knowledge is the tell: the field was read for the sentence and
			// not for the verdict.
			const bad = execVerdict(r, timeout);
			report(
				title,
				[
					`${script} ${scriptArgs.join(" ")}`.trim() +
						`  ->  ${bad ? bad.reason : "exit 0"}${r.killed ? "" : ` (exit ${r.code})`} in ${secs}s`,
					"",
					...tail(r.stdout, 60),
					...(r.stderr.trim() ? ["", "stderr:", ...tail(r.stderr, 20)] : []),
				],
				bad ? "error" : "info",
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
		// AI5: `killed` before `code`. A wedged daemon resolves `code: 0` with an
		// empty stdout, which here reads as a container that logged nothing —
		// exactly the `docker ps` misreading the seventeenth pass fixed, one
		// command over.
		const bad = execVerdict(r, 30_000);
		report(
			`stack logs ${service ?? "llama"}`,
			bad ? [`docker logs ${bad.reason}`, "", ...tail(r.stdout + r.stderr, 60)] : tail(r.stdout + r.stderr, 60),
			bad ? "error" : "info",
		);
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
			"/stack mode              which preset .env matches, and what differs",
			"/stack mode coding|prose  switch regime, then offer the restart it needs",
			"/stack env [FILTER]       every effective setting (.env + .env.local + exported)",
			"/stack set KEY=VALUE      edit .env, and say exactly what must restart",
			"/stack up | down          start / stop the stack via scripts/",
			"/stack restart [svc]      recreate llama and/or forge  (llama ≈ 20 min cold load)",
			"/stack smoke              scripts/smoke-test.sh",
			"/stack bench [args]       scripts/bench.sh",
			"/stack logs [llama|forge] last 60 log lines",
			"/stack slots save|restore|erase [id]",
			"",
			"The model can call stack_status to read the stack. It cannot change it:",
			"every mutation above is a user-only command on purpose.",
			"",
			"Reconfiguration is never live — llama-server answers 501 to POST /props,",
			"and forge is CLI-flag driven with no admin API.",
		]);
	}
}

/**
 * lib.sh only emits colour when stdout is a TTY, which it is not under pi.exec —
 * but a mode file or a future script could still carry escapes, and they render
 * as literal garbage inside a TUI entry rather than as colour.
 */
function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Turn lib.sh's console output into something that belongs in a TUI panel.
 *
 * Two problems with printing it raw. Its `==>` / `ok` / `warn` / dim prefixes
 * are shell chrome that reads as noise once it is already inside a titled box.
 * And info/ok/dim go to stdout while warn/die go to stderr, so concatenating
 * the two streams reorders the transcript — which is how a run ended up showing
 * "apply it with: mode.sh coding --restart" *above* the warning it answers, and
 * above the restart that had already happened.
 *
 * `drop` removes advice that the caller is about to invalidate.
 */
function cleanShellOutput(stdout: string, stderr: string, drop: RegExp[] = []): string[] {
	const clean = (text: string) =>
		stripAnsi(text)
			.split("\n")
			.map((l) => l.replace(/^\s*(==>|ok|warn|err)\s+/, "").trimEnd())
			.filter((l) => l.trim().length > 0)
			.filter((l) => !drop.some((re) => re.test(l)));
	// stderr last and labelled: it is the warnings, and they are the part worth
	// reading after a wall of "unchanged".
	const out = clean(stdout);
	const errs = clean(stderr);
	return errs.length ? [...out, ...errs] : out;
}

function tail(text: string, n: number): string[] {
	const lines = text.replace(/\s+$/, "").split("\n");
	return lines.length <= n ? lines : lines.slice(lines.length - n);
}
