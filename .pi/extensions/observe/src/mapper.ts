/**
 * pi extension events → instantcoffee-observe events.
 *
 * Pure functions only: no pi imports, no I/O, so the suite runs under
 * `node --experimental-strip-types --test` with no node_modules.
 *
 * Every shape here was taken from a capture of pi 0.85.1 on this stack (an
 * extension that dumped every event to JSONL), not from pi's docs. Three things
 * the capture showed that the docs do not say:
 *
 *   1. With parallel tool calls pi fires every `tool_execution_start` BEFORE the
 *      matching `tool_call`s, and results come back in completion order.
 *   2. A subagent's in-memory session never gets `session_shutdown`; its last
 *      event is `agent_settled`.
 *   3. A subagent fires `session_info_changed` (its "<type>#<id8>" name) before
 *      its own `session_start`.
 *
 * The observe side keeps Claude-Code-style event names (PreToolUse,
 * LLMGeneration, ...) because its renderers key on them; the payload fields are
 * pi's. docs/pi-protocol.md in instantcoffee-observe is the contract.
 */

export const AGENT_CLASS = "pi";

/** Default cap on any one free-text field sent to observe. */
export const DEFAULT_MAX_FIELD_CHARS = 64_000;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Envelope = Record<string, unknown>;

/** Who an event belongs to — resolved by the extension, sent explicitly. */
export interface Identity {
	/** The top-level (file-backed) session every event is grouped under. */
	sessionId: string;
	transcriptPath: string | null;
	cwd: string;
	sessionName: string | null;
	/** Set only for events from a subagent's in-memory session. */
	agent: SubagentIdentity | null;
}

export interface SubagentIdentity {
	agentId: string;
	agentType: string;
	agentName: string;
	description: string | null;
	parentToolUseId: string | null;
	/** The subagent that spawned this one; null when the top-level session did. */
	parentAgentId: string | null;
	background: boolean;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ModelInfo {
	id: string | null;
	provider: string | null;
}

/** Truncate a string, saying how much was cut so nothing is silently lost. */
export function clip(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max)}\n…[truncated ${text.length - max} of ${text.length} chars]`;
}

/** Clip every string inside a JSON-ish value; bounds tool args and details. */
export function clipDeep(value: unknown, max: number, depth = 0): unknown {
	if (typeof value === "string") {
		return clip(value, max);
	}
	if (depth > 8 || value === null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => clipDeep(v, max, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] = clipDeep(v, max, depth + 1);
	}
	return out;
}

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	mimeType?: string;
}

/** Join a pi content array's text blocks; images become a placeholder. */
export function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block?.type === "image") {
			parts.push(`[image ${block.mimeType ?? ""}]`.trim());
		}
	}
	return parts.join("\n");
}

function thinkingText(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	return (content as ContentBlock[])
		.filter((b) => b?.type === "thinking" && typeof b.thinking === "string")
		.map((b) => b.thinking as string)
		.join("\n");
}

function toolCalls(content: unknown): Array<{ id: string; name: string }> {
	if (!Array.isArray(content)) {
		return [];
	}
	return (content as Array<{ type?: string; id?: string; name?: string }>)
		.filter((b) => b?.type === "toolCall")
		.map((b) => ({ id: String(b.id ?? ""), name: String(b.name ?? "") }));
}

/** The fields every envelope carries. */
export function base(name: string, who: Identity, at: number, model: ModelInfo | null): Envelope {
	const env: Envelope = {
		hook_event_name: name,
		agent_class: AGENT_CLASS,
		session_id: who.sessionId,
		timestamp: at,
		cwd: who.cwd,
	};
	if (who.transcriptPath) {
		env.transcript_path = who.transcriptPath;
	}
	if (who.sessionName) {
		env.slug = who.sessionName;
	}
	if (model?.id) {
		env.model = model.id;
	}
	if (model?.provider) {
		env.provider = model.provider;
	}
	if (who.agent) {
		env.agent_id = who.agent.agentId;
		env.agent_type = who.agent.agentType;
		env.agent_name = who.agent.agentName;
		if (who.agent.description) {
			env.agent_description = who.agent.description;
		}
		if (who.agent.parentToolUseId) {
			env.parent_tool_use_id = who.agent.parentToolUseId;
		}
		if (who.agent.parentAgentId) {
			env.parent_agent_id = who.agent.parentAgentId;
		}
	}
	return env;
}

export interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	provider?: string;
	model?: string;
	responseModel?: string;
	responseId?: string;
	stopReason?: string;
	errorMessage?: string;
	timestamp?: number;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		reasoning?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
}

export interface GenerationTiming {
	/** When pi handed the request to the provider (before_provider_request). */
	requestAt: number | null;
	/**
	 * First streamed update of the assistant message. Through forge this lands
	 * milliseconds before the end — forge asks llama for a non-streamed reply
	 * and replays it as SSE — so it is only a real time-to-first-token for a
	 * provider that streams (e.g. a remote subagent model).
	 */
	firstTokenAt: number | null;
	/** HTTP status from after_provider_response. */
	status: number | null;
	turnIndex: number | null;
}

/** message_end(role=assistant) → LLMGeneration. */
export function llmGeneration(
	msg: AssistantMessage,
	who: Identity,
	at: number,
	timing: GenerationTiming,
	usage: ContextUsage | null,
	maxChars: number,
): Envelope {
	const env = base("LLMGeneration", who, at, { id: msg.model ?? null, provider: msg.provider ?? null });
	const u = msg.usage ?? {};
	const calls = toolCalls(msg.content);

	Object.assign(env, {
		input_tokens: u.input ?? 0,
		output_tokens: u.output ?? 0,
		cache_read_tokens: u.cacheRead ?? 0,
		cache_creation_tokens: u.cacheWrite ?? 0,
		reasoning_tokens: u.reasoning ?? 0,
		total_tokens: u.totalTokens ?? 0,
		cost_usd: u.cost?.total ?? 0,
		stop_reason: msg.stopReason ?? null,
		tool_calls: calls,
		text: clip(contentText(msg.content), maxChars),
		thinking: clip(thinkingText(msg.content), maxChars),
	});
	if (msg.responseModel && msg.responseModel !== msg.model) {
		env.actual_model = msg.responseModel;
	}
	if (msg.responseId) {
		env.response_id = msg.responseId;
	}
	if (msg.errorMessage) {
		env.error_message = clip(msg.errorMessage, maxChars);
	}
	if (timing.turnIndex !== null) {
		env.turn_index = timing.turnIndex;
	}
	if (timing.status !== null) {
		env.http_status = timing.status;
	}
	if (timing.requestAt !== null) {
		env.duration_ms = Math.max(0, at - timing.requestAt);
		if (timing.firstTokenAt !== null) {
			env.ttft_ms = Math.max(0, timing.firstTokenAt - timing.requestAt);
		}
	}
	if (usage) {
		env.context_tokens = usage.tokens;
		env.context_window = usage.contextWindow;
	}
	return env;
}

export interface ToolStart {
	toolCallId: string;
	toolName: string;
	input: unknown;
	startedAt: number;
}

/** tool_call → PreToolUse. `input` is post-mutation (other extensions may edit it). */
export function preToolUse(start: ToolStart, who: Identity, at: number, model: ModelInfo | null, maxChars: number): Envelope {
	return {
		...base("PreToolUse", who, at, model),
		tool_name: start.toolName,
		tool_use_id: start.toolCallId,
		tool_input: clipDeep(start.input, maxChars),
	};
}

export interface ToolEnd {
	toolCallId: string;
	toolName: string;
	result: { content?: unknown; details?: unknown } | undefined;
	isError: boolean;
}

/** tool_execution_end → PostToolUse / PostToolUseFailure. */
export function postToolUse(
	end: ToolEnd,
	start: ToolStart | undefined,
	who: Identity,
	at: number,
	model: ModelInfo | null,
	maxChars: number,
): Envelope {
	const env: Envelope = {
		...base(end.isError ? "PostToolUseFailure" : "PostToolUse", who, at, model),
		tool_name: end.toolName,
		tool_use_id: end.toolCallId,
		tool_response: {
			content: clip(contentText(end.result?.content), maxChars),
			details: clipDeep(end.result?.details ?? null, maxChars),
		},
		is_error: end.isError,
	};
	if (start) {
		env.tool_input = clipDeep(start.input, maxChars);
		env.duration_ms = Math.max(0, at - start.startedAt);
	}
	if (end.isError) {
		env.error = clip(contentText(end.result?.content), maxChars);
	}
	return env;
}

/** A background Agent call's result text carries the full id; foreground ones do not. */
export function backgroundAgentId(resultText: string): string | null {
	const m = /Agent ID:\s*([0-9a-zA-Z_-]{8,})/.exec(resultText);
	return m ? m[1] : null;
}

/** "<type>#<id8>" is how pi-subagents-lite names a child session. */
export function parseChildName(name: string | null | undefined): { type: string; shortId: string } | null {
	if (!name) {
		return null;
	}
	const m = /^([\w.-]+)#([0-9a-zA-Z]{6,})$/.exec(name.trim());
	return m ? { type: m[1], shortId: m[2] } : null;
}
