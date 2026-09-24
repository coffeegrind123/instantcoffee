/**
 * observe — stream this pi session to instantcoffee-observe.
 *
 * Inert unless OBSERVE_URL is set; scripts/pi-local.sh exports it when
 * OBSERVE_ENABLED=1. Registers no tools, so it costs the model's window
 * nothing. `/observe` shows delivery status.
 *
 * Loaded twice per delegation: once by the parent (-e) and once inside each
 * subagent (SUBAGENT_EXTRA_EXTENSIONS). Both bindings share this module's
 * scope — see src/linker.ts for why that is what makes parent/child linking
 * possible — so ALL per-session state below is keyed by pi session id, never
 * held in a single module variable that a child would clobber.
 */

import {
	base,
	backgroundAgentId,
	clip,
	contentText,
	DEFAULT_MAX_FIELD_CHARS,
	llmGeneration,
	postToolUse,
	preToolUse,
	type AssistantMessage,
	type ContextUsage,
	type Envelope,
	type GenerationTiming,
	type Identity,
	type ModelInfo,
	type ToolStart,
} from "./src/mapper.ts";
import { SPAWN_TOOLS, SpawnRegistry } from "./src/linker.ts";
import { gitContext } from "./src/git.ts";
import { now } from "./src/clock.ts";
import { Sender } from "./src/sender.ts";

const SHUTDOWN_FLUSH_MS = 1500;
const SEND_TIMEOUT_MS = 2000;
const OFFLINE_BACKOFF_MS = 10_000;
const MAX_QUEUE = 2000;

// Minimal structural types for the parts of pi's API used here, so this file
// type-checks without pi's node_modules (the suite runs with none).
interface SessionManagerLike {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getSessionName(): string | undefined;
}
interface Ctx {
	cwd: string;
	mode?: string;
	model?: { id?: string; provider?: string; contextWindow?: number };
	thinkingLevel?: string;
	sessionManager: SessionManagerLike;
	getContextUsage?(): ContextUsage | undefined;
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
type Handler = (event: any, ctx: Ctx) => unknown;
interface PiLike {
	on(event: string, handler: Handler): void;
	registerCommand?(name: string, opts: { description?: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
}

interface SessionState {
	timing: GenerationTiming;
	tools: Map<string, ToolStart>;
	systemPromptChars: number | null;
	turns: number;
	toolUses: number;
	inputTokens: number;
	outputTokens: number;
	startedAt: number;
}

// --- module scope: shared by the parent binding and every child binding ----

const registry = new SpawnRegistry();
const sessions = new Map<string, SessionState>();
let sender: Sender | null = null;

function envInt(name: string, fallback: number): number {
	const n = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getSender(): Sender | null {
	const url = (process.env.OBSERVE_URL ?? "").trim().replace(/\/+$/, "");
	if (!url) {
		return null;
	}
	sender ??= new Sender({
		url,
		projectSlug: (process.env.OBSERVE_PROJECT_SLUG ?? "").trim() || null,
		timeoutMs: envInt("OBSERVE_TIMEOUT_MS", SEND_TIMEOUT_MS),
		maxQueue: MAX_QUEUE,
		backoffMs: OFFLINE_BACKOFF_MS,
	});
	return sender;
}

function state(sessionId: string): SessionState {
	let s = sessions.get(sessionId);
	if (!s) {
		s = {
			timing: { requestAt: null, firstTokenAt: null, status: null, turnIndex: null },
			tools: new Map(),
			systemPromptChars: null,
			turns: 0,
			toolUses: 0,
			inputTokens: 0,
			outputTokens: 0,
			startedAt: now(),
		};
		sessions.set(sessionId, s);
	}
	return s;
}

/**
 * Who this event belongs to. A session with no file, seen while a different
 * top-level session is live, is a subagent; anything else is (or becomes) the
 * top-level session.
 */
function identify(ctx: Ctx): { who: Identity; piSessionId: string; isChild: boolean } {
	const sm = ctx.sessionManager;
	const id = sm.getSessionId();
	const file = sm.getSessionFile() ?? null;
	const name = sm.getSessionName() ?? null;

	const isChild =
		registry.isChild(id) || (!file && registry.root !== null && registry.root.sessionId !== id);

	if (isChild && registry.root) {
		const agent = registry.claim(id, name);
		const root = registry.root;
		return {
			piSessionId: id,
			isChild: true,
			who: { sessionId: root.sessionId, transcriptPath: root.transcriptPath, cwd: ctx.cwd, sessionName: root.name, agent },
		};
	}

	if (!registry.root || registry.root.sessionId !== id) {
		registry.root = { sessionId: id, transcriptPath: file, cwd: ctx.cwd, name };
	} else if (name && registry.root.name !== name) {
		registry.root.name = name;
	}
	return {
		piSessionId: id,
		isChild: false,
		who: { sessionId: id, transcriptPath: file, cwd: ctx.cwd, sessionName: registry.root.name, agent: null },
	};
}

// The top-level session's checkout. Sent on SessionStart and on every Stop, so
// a branch switched mid-session shows up once the turn settles.
function gitOf(ctx: Ctx): { git_branch: string | null; git_repository_url: string | null } {
	try {
		const g = gitContext(ctx.cwd);
		return { git_branch: g.branch, git_repository_url: g.repositoryUrl };
	} catch {
		return { git_branch: null, git_repository_url: null };
	}
}

function modelOf(ctx: Ctx): ModelInfo {
	return { id: ctx.model?.id ?? null, provider: ctx.model?.provider ?? null };
}

function usageOf(ctx: Ctx): ContextUsage | null {
	try {
		return ctx.getContextUsage?.() ?? null;
	} catch {
		return null;
	}
}

export default function observe(pi: PiLike): void {
	const out = getSender();
	if (!out) {
		return;
	}
	const maxChars = envInt("OBSERVE_MAX_FIELD_CHARS", DEFAULT_MAX_FIELD_CHARS);

	// Every handler is wrapped: an observability bug must never surface as a
	// failed tool call or a crashed turn.
	const on = (name: string, fn: Handler) =>
		pi.on(name, (event, ctx) => {
			try {
				return fn(event, ctx);
			} catch {
				return undefined;
			}
		});

	const emit = (env: Envelope) => out.send(env);

	on("session_start", (e, ctx) => {
		const { who, piSessionId, isChild } = identify(ctx);
		state(piSessionId).startedAt = now();
		if (isChild) {
			emit({ ...base("SubagentStart", who, now(), modelOf(ctx)), background: who.agent?.background ?? false });
			return;
		}
		emit({
			...base("SessionStart", who, now(), modelOf(ctx)),
			source: e?.reason ?? null,
			previous_session_file: e?.previousSessionFile ?? null,
			thinking_level: ctx.thinkingLevel ?? null,
			context_window: ctx.model?.contextWindow ?? usageOf(ctx)?.contextWindow ?? null,
			pi_mode: ctx.mode ?? null,
			...gitOf(ctx),
		});
	});

	on("session_info_changed", (e, ctx) => {
		const { who, isChild } = identify(ctx);
		if (!isChild) {
			emit({ ...base("SessionRename", who, now(), modelOf(ctx)), name: e?.name ?? null });
		}
	});

	on("before_agent_start", (e, ctx) => {
		const { who, piSessionId } = identify(ctx);
		const s = state(piSessionId);
		const prompt = typeof e?.systemPrompt === "string" ? e.systemPrompt : null;
		// The system prompt is the stack's biggest standing cost; send it when it
		// changes, not with every prompt.
		if (prompt !== null && prompt.length !== s.systemPromptChars) {
			s.systemPromptChars = prompt.length;
			emit({
				...base("SystemPrompt", who, now(), modelOf(ctx)),
				system_prompt: clip(prompt, maxChars),
				system_prompt_chars: prompt.length,
			});
		}
	});

	on("input", (e, ctx) => {
		const { who } = identify(ctx);
		emit({
			...base("UserPromptSubmit", who, now(), modelOf(ctx)),
			prompt: clip(typeof e?.text === "string" ? e.text : "", maxChars),
			source: e?.source ?? null,
			images: Array.isArray(e?.images) ? e.images.length : 0,
		});
	});

	on("turn_start", (e, ctx) => {
		const { piSessionId } = identify(ctx);
		const s = state(piSessionId);
		s.turns++;
		s.timing = { requestAt: null, firstTokenAt: null, status: null, turnIndex: e?.turnIndex ?? null };
	});

	on("before_provider_request", (_e, ctx) => {
		const s = state(identify(ctx).piSessionId);
		s.timing.requestAt = now();
		s.timing.firstTokenAt = null;
	});

	on("after_provider_response", (e, ctx) => {
		state(identify(ctx).piSessionId).timing.status = typeof e?.status === "number" ? e.status : null;
	});

	on("message_update", (e, ctx) => {
		if (e?.message?.role !== "assistant") {
			return;
		}
		const s = state(ctx.sessionManager.getSessionId());
		s.timing.firstTokenAt ??= now();
	});

	on("message_end", (e, ctx) => {
		const msg = e?.message;
		const { who, piSessionId } = identify(ctx);
		if (msg?.role === "assistant") {
			const s = state(piSessionId);
			s.inputTokens += msg.usage?.input ?? 0;
			s.outputTokens += msg.usage?.output ?? 0;
			emit(llmGeneration(msg as AssistantMessage, who, now(), s.timing, usageOf(ctx), maxChars));
			return;
		}
		// Extension-injected messages: background subagent results, loop
		// handoffs, persona notes. Surface them rather than guess which matter.
		if (msg?.role === "custom") {
			emit({
				...base("CustomMessage", who, now(), modelOf(ctx)),
				custom_type: msg.customType ?? null,
				text: clip(contentText(msg.content), maxChars),
				display: msg.display ?? null,
			});
		}
	});

	on("tool_execution_start", (e, ctx) => {
		const { piSessionId } = identify(ctx);
		state(piSessionId).tools.set(String(e?.toolCallId), {
			toolCallId: String(e?.toolCallId),
			toolName: String(e?.toolName),
			input: e?.args,
			startedAt: now(),
		});
	});

	// tool_call carries the input AFTER other extensions' mutations (for Agent it
	// gains `_resolvedAgent`), so PreToolUse is sent from here, not from
	// tool_execution_start.
	on("tool_call", (e, ctx) => {
		const { who, piSessionId, isChild } = identify(ctx);
		const s = state(piSessionId);
		const id = String(e?.toolCallId);
		const start: ToolStart = s.tools.get(id) ?? { toolCallId: id, toolName: String(e?.toolName), input: e?.input, startedAt: now() };
		start.input = e?.input ?? start.input;
		s.tools.set(id, start);
		s.toolUses++;

		if (SPAWN_TOOLS.has(start.toolName)) {
			registry.onAgentCall(id, who.sessionId, start.input, now(), isChild ? (who.agent?.agentId ?? null) : null);
		}
		emit(preToolUse(start, who, now(), modelOf(ctx), maxChars));
	});

	on("tool_execution_end", (e, ctx) => {
		const { who, piSessionId } = identify(ctx);
		const s = state(piSessionId);
		const id = String(e?.toolCallId);
		const start = s.tools.get(id);
		s.tools.delete(id);

		const env = postToolUse(
			{ toolCallId: id, toolName: String(e?.toolName), result: e?.result, isError: e?.isError === true },
			start,
			who,
			now(),
			modelOf(ctx),
			maxChars,
		);

		if (SPAWN_TOOLS.has(String(e?.toolName))) {
			registry.onAgentEnd(id);
			const bgId = backgroundAgentId(contentText(e?.result?.content));
			const child = bgId ? registry.onBackgroundId(id, bgId) : null;
			if (child) {
				env.spawned_agent_id = child.agentId;
			}
		}
		emit(env);
	});

	on("agent_settled", (_e, ctx) => {
		const { who, piSessionId, isChild } = identify(ctx);
		const s = state(piSessionId);
		if (isChild) {
			emit({
				...base("SubagentStop", who, now(), modelOf(ctx)),
				turn_count: s.turns,
				tool_uses: s.toolUses,
				input_tokens: s.inputTokens,
				output_tokens: s.outputTokens,
				duration_ms: now() - s.startedAt,
			});
			return;
		}
		emit({ ...base("Stop", who, now(), modelOf(ctx)), context: usageOf(ctx), ...gitOf(ctx) });
	});

	on("session_before_compact", (e, ctx) => {
		const { who } = identify(ctx);
		emit({
			...base("PreCompact", who, now(), modelOf(ctx)),
			trigger: e?.reason ?? null,
			will_retry: e?.willRetry ?? false,
			custom_instructions: e?.customInstructions ?? null,
			context: usageOf(ctx),
		});
	});

	on("session_compact", (e, ctx) => {
		const { who } = identify(ctx);
		const entry = e?.compactionEntry ?? {};
		emit({
			...base("PostCompact", who, now(), modelOf(ctx)),
			trigger: e?.reason ?? null,
			tokens_before: typeof entry.tokensBefore === "number" ? entry.tokensBefore : null,
			summary: clip(typeof entry.summary === "string" ? entry.summary : "", maxChars),
			from_extension: e?.fromExtension ?? false,
			will_retry: e?.willRetry ?? false,
			context: usageOf(ctx),
		});
	});

	on("session_compact_failed", (e, ctx) => {
		const { who } = identify(ctx);
		emit({
			...base("CompactionFailed", who, now(), modelOf(ctx)),
			trigger: e?.reason ?? null,
			error: e?.errorMessage ?? null,
			aborted: e?.aborted ?? false,
			will_retry: e?.willRetry ?? false,
		});
	});

	on("model_select", (e, ctx) => {
		const { who } = identify(ctx);
		emit({
			...base("ModelChange", who, now(), { id: e?.model?.id ?? null, provider: e?.model?.provider ?? null }),
			previous_model: e?.previousModel?.id ?? null,
			source: e?.source ?? null,
		});
	});

	on("thinking_level_select", (e, ctx) => {
		const { who } = identify(ctx);
		emit({ ...base("ThinkingLevelChange", who, now(), modelOf(ctx)), level: e?.level ?? null, previous_level: e?.previousLevel ?? null });
	});

	on("user_bash", (e, ctx) => {
		const { who } = identify(ctx);
		emit({
			...base("UserBash", who, now(), modelOf(ctx)),
			command: clip(typeof e?.command === "string" ? e.command : "", maxChars),
			exclude_from_context: e?.excludeFromContext ?? false,
		});
	});

	// pi is blocked on the human (a confirm/select dialog) — the same moment
	// Claude Code raises Notification.
	on("ui_prompt_start", (e, ctx) => {
		const { who } = identify(ctx);
		emit({
			...base("Notification", who, now(), modelOf(ctx)),
			message: e?.title ?? e?.kind ?? "pi is waiting for input",
			notification_type: e?.kind ?? null,
		});
	});

	on("session_tree", (e, ctx) => {
		const { who } = identify(ctx);
		emit({ ...base("SessionTree", who, now(), modelOf(ctx)), new_leaf_id: e?.newLeafId ?? null, old_leaf_id: e?.oldLeafId ?? null });
	});

	on("session_shutdown", async (e, ctx) => {
		const { who, piSessionId, isChild } = identify(ctx);
		sessions.delete(piSessionId);
		if (isChild) {
			registry.forget(piSessionId);
			return;
		}
		emit({ ...base("SessionEnd", who, now(), modelOf(ctx)), reason: e?.reason ?? null, target_session_file: e?.targetSessionFile ?? null });
		registry.resetRoot();
		// pi exits right after a quit; give the tail of the queue a moment.
		await out.flush(SHUTDOWN_FLUSH_MS);
	});

	pi.registerCommand?.("observe", {
		description: "Show instantcoffee-observe delivery status",
		handler: async (_args, ctx) => {
			const st = out.snapshot();
			const last = st.lastError ? `, last error: ${st.lastError}` : "";
			ctx.ui?.notify(
				`observe → ${st.url}: ${st.sent} sent, ${st.dropped} dropped, ${st.queued} queued${last}`,
				st.lastError && !st.lastOkAt ? "warning" : "info",
			);
		},
	});
}
