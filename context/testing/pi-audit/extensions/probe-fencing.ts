/**
 * Is browser output fenced as untrusted web content in what the MODEL is sent?
 *
 * Hooks `context`, which runs after every tool_result handler and carries the
 * messages exactly as the next request will. For each tool result from a
 * browser tool or from codemode, appends {tool, fenced} to $PROBE_OUT.
 *
 * Load it in a subagent child through SUBAGENT_EXTRA_EXTENSIONS: a child's
 * transcript records only result sizes, so this is the one place a child's
 * fencing can be observed. Lines carry `session` (the session file) so a
 * parent's lines can be told from a child's.
 */
import { appendFileSync } from "node:fs";

const BROWSER = /^(?:mcp__browser__|browser_)/;
const MARKER = /--- BEGIN UNTRUSTED WEB CONTENT [0-9a-f]{16}/;

export default function (pi: any) {
  const seen = new Set<string>();
  pi.on("context", (event: any, ctx: any) => {
    const session = ctx?.sessionManager?.getSessionId?.() ?? "?";
    for (const m of event.messages ?? []) {
      if (m?.role !== "toolResult") continue;
      const name = String(m.toolName ?? "");
      if (!BROWSER.test(name) && name !== "codemode") continue;
      const id = String(m.toolCallId ?? "");
      if (seen.has(id)) continue;
      seen.add(id);
      const text = (m.content ?? []).map((b: any) => (b?.type === "text" ? b.text : "")).join("");
      appendFileSync(process.env.PROBE_OUT!, JSON.stringify({ session, tool: name, fenced: MARKER.test(text), chars: text.length }) + "\n");
    }
    return undefined;
  });
}
