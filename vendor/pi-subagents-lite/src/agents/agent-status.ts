/**
 * agent-status.ts — AgentStatus tool implementation.
 *
 * A lightweight informational tool that lists all agents (running, queued,
 * completed, stopped, error) from the manager and returns a clear message
 * about not polling for status.
 *
 * ## Why it is bounded
 *
 * Forge fork: this listed EVERY agent ever spawned in the session, unbounded, in
 * one line, into the parent's context. `AgentManager` never evicts a settled
 * record — `/agents` needs them, and so does a continuation — so on a long
 * session the tool's own result is the thing that fills the window it exists to
 * report on. A run with fifty delegations produced a ~2 kB line of which the
 * last three entries were the only ones anyone could act on.
 *
 * The bound is "everything not finished, plus the most recent few that are".
 * A running or queued agent is actionable and must never be dropped, however
 * many there are; a settled one is history, and history is what `/agents` is
 * for. The elided count is stated rather than silently omitted, because a tool
 * that quietly answers a different question is worse than a long one.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { getManager } from "../shell.js";
// The selection rule lives in a module that imports nothing, so it can be tested;
// this file cannot be loaded by the suite. See status-listing.ts.
import { listedStatus, selectAgentsToList } from "./status-listing.js";

function formatAgent(record: AgentRecord): string {
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  // Not `lifecycle.status` directly: a record whose answer is still being
  // checked reads `completed` there, and the parent acts on this line. See
  // listedStatus in status-listing.ts.
  return `${shortId} (${record.display.type}) ${listedStatus(record)}`;
}

/** List agents with type, short ID, and status, plus a don't-poll nudge. */
export async function executeAgentStatusTool(
  _toolCallId: string,
  _params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const manager = getManager()!;
  const agents = manager.listAgents();

  const nudge = "Don't poll — you'll receive notifications when agents complete.";

  if (agents.length === 0) {
    return {
      content: [{ type: "text", text: `No agents running or completed.\n\n${nudge}` }],
    };
  }

  const { listed, elided } = selectAgentsToList(agents);
  const formatted = listed.map(formatAgent).join(", ");
  const more = elided > 0 ? ` (+${elided} older, see /agents)` : "";
  return {
    content: [{ type: "text", text: `${formatted}${more}\n\n${nudge}` }],
  };
}
