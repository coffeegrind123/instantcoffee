/**
 * The browser MCP server, through pi's built-in MCP (pi >= 0.99).
 *
 * Replaced pi-mcp-adapter on 2026-10-31 (context/pi-1.4-audit-2026-10-31.md).
 * Registered from an extension rather than written to mcp.json because:
 *
 *   - the URL comes from BROWSER_MCP_HOST / BROWSER_MCP_PORT, which pi-local.sh
 *     exports from .env, and mcp.json interpolates variables only in `env` and
 *     `headers`, not in `url`;
 *   - a registration applies in whatever project pi runs in, with no trust
 *     prompt and no file left behind in someone else's repo;
 *   - subagent children load this file too (pi-subagents-lite's
 *     subagent-denylist.ts), so they reach the same server the same way.
 *
 * The surface, measured on the wire (same flags, live server), bytes of tool
 * schemas on every request:
 *
 *   adapter (5 native + mcp + mcpScript)          14,394
 *   this    (5 direct + codemode)                 13,273
 *
 * The other 93 tools have `codemode` exposure: a script finds them with
 * searchTools() and calls them as tools.mcp__browser__<tool>(args), which is the
 * adapter's `mcp` proxy and its `mcpScript` batching in one tool. The declared
 * tool list never changes mid-session.
 *
 * That last point is why it is not `deferred`. tool_search DECLARES what it
 * loads, and on this chat template the tool declarations sit at the top of the
 * prompt, so every search re-prefilled the whole conversation (measured on a
 * child: 5,623 / 6,694 / 10,397-token prefills, against a few hundred per
 * steady turn; at 128K deep that is a minute or more each), and a child's
 * searches grew its declared browser tools 0 -> 20 -> 41.
 *
 * Every nested call still runs extensions' tool_call / tool_result hooks, and
 * browser-guard.ts fences a codemode result whose script called the browser.
 */

export const BROWSER_SERVER = "browser";

/**
 * The browse loop, declared to the model like built-in tools. `start_browser`
 * is not here on purpose: its schema alone is ~2.3 KB and the server opens the
 * browser itself on the first tool that needs one.
 */
export const DIRECT_TOOLS = ["navigate", "get_interaction_tree", "click", "type_text", "get_text_content"] as const;

/**
 * Per-request timeout, seconds. Must stay below the point where a wedged tab is
 * worth waiting for: warm calls take 25-417 ms, and browser-guard.ts turns a
 * timeout into recovery instructions.
 */
export const REQUEST_TIMEOUT_S = 30;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "8931";

export interface BrowserServerConfig {
  url: string;
  timeout: number;
  exposure: "codemode";
  toolExposure: Record<string, "direct">;
  description: string;
}

export function browserServerConfig(env: NodeJS.ProcessEnv = process.env): BrowserServerConfig {
  const host = env.BROWSER_MCP_HOST || DEFAULT_HOST;
  const port = env.BROWSER_MCP_PORT || DEFAULT_PORT;
  return {
    url: `http://${host}:${port}/mcp`,
    timeout: REQUEST_TIMEOUT_S,
    exposure: "codemode",
    toolExposure: Object.fromEntries(DIRECT_TOOLS.map((tool) => [tool, "direct" as const])),
    // One line in the prompt's mcp_servers section, and what searchTools() ranks by.
    description: "Real Chrome: tabs, forms, cookies, storage, network and console logs, JS, waits, Cloudflare challenges",
  };
}

export default function browserMcp(pi: { registerMcpServer?: (name: string, config: BrowserServerConfig) => void }) {
  if (typeof pi.registerMcpServer !== "function") {
    console.warn("[browser-mcp] this pi has no built-in MCP (needs >= 0.99); browser tools are unavailable");
    return;
  }
  pi.registerMcpServer(BROWSER_SERVER, browserServerConfig());
}
