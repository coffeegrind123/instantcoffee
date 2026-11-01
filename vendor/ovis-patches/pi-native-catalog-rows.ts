/**
 * The rows Ovis's native-catalog seam gets for a pi pane, from the file
 * .pi/extensions/ovis-bridge.ts writes. Pure: no Ovis imports, so this stack's
 * CI can test it with plain node (scripts/test_ovis.py runs it).
 *
 * A catalog is used only when it is about THIS pane's live pi: the same pane id,
 * a pid that is alive, and, where herdr names the pane's session file, the same
 * session file. Anything else is null, which Ovis treats as "no answer" and
 * leaves its own scanned rows in place.
 */

export interface PiCatalog {
  version: number;
  pane_id: string;
  pid: number;
  session_file: string | null;
  commands: { name: string; description?: string; source: string; path?: string }[];
}

export interface PaneLike {
  pane_id: string;
  agent_session?: { value?: unknown } | null;
}

export interface Row {
  name: string;
  description: string;
  source: "user" | "skill" | "plugin";
  origin?: "user";
  id: string;
  forms?: { match: "bare" | "other"; interaction: "terminal" }[];
  visibility?: "terminal";
}

/**
 * Commands whose handler draws its own TUI component (`ctx.ui.custom`), which
 * Ovis cannot turn into a card the way it does pi's select/confirm/input. Sent
 * from the chat, `/agents` opened its menu unseen and the next messages were
 * typed into it (2026-11-01). Listed as terminal commands, Ovis says so and the
 * menu is used from its Terminal tab. scripts/test_ovis.py fails when a package
 * that calls ui.custom registers a command missing here.
 */
export const TERMINAL_COMMANDS: readonly string[] = [
  "agents", // vendor/pi-subagents-lite: its whole menu system
  "mcp", // pi's bundled MCP manager (dist/extensions/mcp/ui.js), "enter manage • escape/ctrl+c close"
  "llama", // pi's bundled llama.cpp router manager (dist/extensions/llama/ui.js)
];

export const CATALOG_VERSION = 1;

const SOURCE: Record<string, Row["source"]> = { extension: "plugin", prompt: "user", skill: "skill" };

export function piCatalogRows(catalog: unknown, pane: PaneLike, alive: (pid: number) => boolean): Row[] | null {
  if (catalog === null || typeof catalog !== "object") return null;
  const c = catalog as Partial<PiCatalog>;
  if (c.version !== CATALOG_VERSION || c.pane_id !== pane.pane_id) return null;
  if (typeof c.pid !== "number" || !alive(c.pid)) return null;
  const herdrSession = pane.agent_session?.value;
  if (typeof herdrSession === "string" && typeof c.session_file === "string" && herdrSession !== c.session_file) return null;
  if (!Array.isArray(c.commands)) return null;
  const rows: Row[] = [];
  for (const command of c.commands) {
    if (!command || typeof command.name !== "string" || !command.name) continue;
    const source = SOURCE[command.source];
    if (!source) continue;
    rows.push({
      name: command.name,
      description: typeof command.description === "string" && command.description ? command.description : `Run /${command.name}`,
      source,
      ...(source === "skill" ? { origin: "user" as const } : {}),
      id: typeof command.path === "string" && command.path ? command.path : `pi:${command.source}:${command.name}`,
      ...(source === "plugin" && TERMINAL_COMMANDS.includes(command.name)
        ? { forms: [{ match: "bare" as const, interaction: "terminal" as const }, { match: "other" as const, interaction: "terminal" as const }], visibility: "terminal" as const }
        : {}),
    });
  }
  return rows;
}
