/**
 * Forge fork: pi's built-in `mcp` and `codemode` extensions for a child that
 * gets the browser.
 *
 * A child's resource loader loads built-ins only from factories it is handed
 * (pi `resource-loader.js`: `extensionFactories` entries marked `builtin`), and
 * this fork hands none by default. The browser moved from pi-mcp-adapter — a pi
 * package, which a child discovered on its own — to pi's built-in MCP on
 * 2026-10-31, so without these a child would load `browser-mcp.ts`, register a
 * server nothing connects, and have no browser at all.
 *
 * Only these two, and only when the parent runs the browser natively
 * (`BROWSER_MCP_NATIVE=1`, exported by pi-local.sh). codemode is how the 93
 * non-direct browser tools are reached (their exposure is `codemode`, see
 * browser-mcp.ts). `tool-search` stays out: it declares what it loads, and a
 * changed tool list re-prefills the whole prompt on this template.
 *
 * Looked up at runtime rather than imported by name: pi before 0.99 has neither
 * creator, and a named import of a missing export fails the whole module.
 */

import { BROWSER_SERVER } from "../../../../.pi/extensions/browser-mcp.ts";

export interface BuiltinFactory {
  name: string;
  factory: unknown;
  builtin: true;
  replaceable: true;
}

type Creator = () => unknown;

export function childBuiltinExtensions(
  sdk: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): BuiltinFactory[] {
  if (env.BROWSER_MCP_NATIVE !== "1") return [];
  const out: BuiltinFactory[] = [];
  for (const [name, creator] of [
    ["mcp", "createMcpExtension"],
    ["codemode", "createCodemodeExtension"],
  ] as const) {
    const create = sdk[creator];
    if (typeof create === "function") {
      out.push({ name, factory: (create as Creator)(), builtin: true, replaceable: true });
    }
  }
  return out;
}

/**
 * codemode and every browser tool (`mcp__browser__*`), for a child's session
 * allowlist.
 *
 * The allowlist is fixed when the child's session is created, from the tools
 * known then; MCP tools register later, when the server connects. pi lets an
 * unlisted MCP tool through only for codemode/tool_search and never declares it,
 * so without an entry a child's first request had none of the five direct
 * tools (measured on pi 1.4.0). And any entry starting with `mcp__` turns MCP
 * filtering on (agent-session.js `_allowlistFiltersMcp`): listing the five by
 * name cut a child's codemode off from the other 93 (measured in the TUI:
 * "tools.mcp__browser__execute_js does not exist"). The pattern allows the
 * whole browser server and still keeps a child off any other MCP server.
 * codemode is listed so it is declared from the first request rather than
 * activated when the server connects, which would change the tool list once.
 */
export function childBrowserToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.BROWSER_MCP_NATIVE !== "1") return [];
  return ["codemode", `mcp__${BROWSER_SERVER}__*`];
}
