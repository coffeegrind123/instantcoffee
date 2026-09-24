/**
 * Ties a subagent's in-memory session back to the parent `Agent` call that
 * spawned it.
 *
 * pi-subagents-lite runs children in the parent's process with
 * `SessionManager.inMemory`, and nothing it emits links the two: the child's
 * session header has no parentSession, the foreground result's `details` has no
 * agentId, and it publishes nothing on `pi.events`. What IS true:
 *
 *   - A child binds the SAME module instance as the parent (with its own event
 *     bus), so module-scope state — this registry — is shared between them.
 *     That sharing is exactly what pi-loop-mode got wrong; here it is the point.
 *   - There is one top-level session per process, so which SESSION a child
 *     belongs to is never ambiguous. Only which Agent call is.
 *   - The parent's `tool_call` for Agent carries `_resolvedAgent` (the type), and
 *     the child is named "<type>#<id8>". Children are matched to pending calls
 *     first-in-first-out within a type — exact unless two calls of the same type
 *     are in flight at once, in which case two siblings may swap parents.
 *   - A background call's result says "Agent ID: <full id>", which matches the
 *     child's "#<id8>" suffix exactly, so background children are re-pointed at
 *     their true parent call when that result arrives.
 *   - With SUBAGENT_MAX_DEPTH=2 a child delegates through its own `SubAgent`
 *     tool (never `Agent`, which is filtered out of children). Those calls are
 *     registered with the spawning child's id, so a grandchild links to the
 *     child that spawned it rather than to the top-level session.
 */

import { parseChildName, type SubagentIdentity } from "./mapper.ts";

export const DEFAULT_AGENT_TYPE = "general-purpose";

/** The operator's delegation tool, and the one a delegating child gets. */
export const SPAWN_TOOLS = new Set(["Agent", "SubAgent"]);

export interface PendingSpawn {
	toolCallId: string;
	rootSessionId: string;
	/** The child that made the call; null when the top-level session did. */
	spawnerAgentId: string | null;
	type: string;
	description: string | null;
	background: boolean;
	at: number;
}

export interface RootSession {
	sessionId: string;
	transcriptPath: string | null;
	cwd: string;
	name: string | null;
}

export class SpawnRegistry {
	root: RootSession | null = null;
	private pending: PendingSpawn[] = [];
	private children = new Map<string, SubagentIdentity>();

	/** A `tool_call` for Agent (top-level) or SubAgent (from a child). */
	onAgentCall(
		toolCallId: string,
		rootSessionId: string,
		input: unknown,
		at: number,
		spawnerAgentId: string | null = null,
	): void {
		const i = (input ?? {}) as Record<string, unknown>;
		const type =
			str(i._resolvedAgent) ?? str(i.agent) ?? str(i.subagent_type) ?? DEFAULT_AGENT_TYPE;
		this.pending.push({
			toolCallId,
			rootSessionId,
			spawnerAgentId,
			type,
			description: str(i.description),
			background: i.run_in_background === true,
			at,
		});
	}

	/**
	 * Identity for an in-memory session, claiming a pending spawn on first sight.
	 * Stable: later calls for the same session return the same identity.
	 */
	claim(childSessionId: string, name: string | null): SubagentIdentity {
		const known = this.children.get(childSessionId);
		if (known) {
			if (name && known.agentName !== name) {
				this.refine(known, name);
			}
			return known;
		}

		const parsed = parseChildName(name);
		const idx = parsed
			? this.pending.findIndex((p) => p.type === parsed.type)
			: this.pending.length > 0
				? 0
				: -1;
		const spawn = idx >= 0 ? this.pending.splice(idx, 1)[0] : undefined;

		const identity: SubagentIdentity = {
			agentId: childSessionId,
			agentType: parsed?.type ?? spawn?.type ?? "session",
			agentName: name ?? spawn?.type ?? "subagent",
			description: spawn?.description ?? null,
			parentToolUseId: spawn?.toolCallId ?? null,
			parentAgentId: spawn?.spawnerAgentId ?? null,
			background: spawn?.background ?? false,
		};
		this.children.set(childSessionId, identity);
		return identity;
	}

	/** The name often arrives after the first event; fill in the type from it. */
	private refine(identity: SubagentIdentity, name: string): void {
		identity.agentName = name;
		const parsed = parseChildName(name);
		if (parsed && identity.agentType === "session") {
			identity.agentType = parsed.type;
		}
	}

	/**
	 * A background Agent call returned "Agent ID: <full id>". Re-point the child
	 * whose name carries that id's prefix at this call. Returns the child's
	 * identity when one was found.
	 */
	onBackgroundId(toolCallId: string, fullAgentId: string): SubagentIdentity | null {
		for (const identity of this.children.values()) {
			const parsed = parseChildName(identity.agentName);
			if (parsed && fullAgentId.startsWith(parsed.shortId)) {
				identity.parentToolUseId = toolCallId;
				identity.background = true;
				return identity;
			}
		}
		return null;
	}

	/** The Agent call finished; a spawn that never produced a child is dropped. */
	onAgentEnd(toolCallId: string): void {
		this.pending = this.pending.filter((p) => p.toolCallId !== toolCallId);
	}

	isChild(sessionId: string): boolean {
		return this.children.has(sessionId);
	}

	child(sessionId: string): SubagentIdentity | undefined {
		return this.children.get(sessionId);
	}

	forget(sessionId: string): void {
		this.children.delete(sessionId);
	}

	/** The top-level session was replaced (/new, /resume, /fork, /reload). */
	resetRoot(): void {
		this.root = null;
		this.pending = [];
	}

	pendingCount(): number {
		return this.pending.length;
	}
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() !== "" ? v : null;
}
