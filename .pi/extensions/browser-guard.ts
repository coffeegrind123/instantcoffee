/**
 * Turn a browser tool timeout into an instruction the model can act on.
 *
 * Measured 2026-08-16, from a real session in ~/testing. Chrome had been wedged
 * for seventeen minutes — its own CDP endpoint answered nothing, while the MCP
 * server in front of it answered `tools/list` instantly. The model asked for a
 * page and got this, twice, sixty seconds apart:
 *
 *     Failed to call tool: Request timed out
 *
 *     Expected parameters:
 *       url (string) *required* - Absolute URL to load, including the scheme...
 *
 * A parameter dump, for a failure that has nothing to do with parameters. So it
 * did the only thing that message suggests: it sent the identical call again,
 * waited another sixty seconds, and only then guessed its way to curl. Two
 * minutes of wall clock and ~500 tokens for a page that was never going to load.
 *
 * The fix is not a shorter timeout (that is in mcp/adapter.json). It is telling
 * the model WHICH failure this is and what to do instead — and answering that
 * from a live probe of Chrome rather than from a guess, because "the browser is
 * wedged", "the server is down" and "the page itself is slow" have three
 * different right answers and the model cannot tell them apart from a timeout.
 *
 * Scope: this only ever rewrites the text of an ALREADY-FAILED browser tool
 * result. It cannot suppress a success, cannot retry anything, and cannot make
 * a call that the model did not make.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Tools the adapter registers from the browser server, plus their bare names. */
const BROWSER_TOOL = /^(?:browser_)?(?:navigate|click|type_text|get_text_content|get_interaction_tree)$/;

/**
 * Failures that mean "the transport gave up", as opposed to a real answer from
 * the browser (a 404 page, a selector that matched nothing). Only these are
 * rewritten — a genuine tool error is information and must reach the model
 * unaltered.
 */
const TRANSPORT_FAILURE =
	/request timed out|timed out|timeout|econnrefused|econnreset|socket hang up|fetch failed|connection closed/i;

/** Probes are cached briefly: one wedged browser usually fails several calls in a row. */
const PROBE_CACHE_MS = 15_000;

let cachedProbe: { at: number; state: string; detail: string } | undefined;

function repoRoot(): string | null {
	let dir: string;
	try {
		dir = dirname(fileURLToPath(import.meta.url));
	} catch {
		return null;
	}
	for (let i = 0; i < 6; i++) {
		if (existsSync(join(dir, "scripts", "browser.sh")) && existsSync(join(dir, ".env"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Ask Chrome itself. `browser.sh health` exits 0 healthy / 1 unknown / 2 wedged
 * and prints `<state>\t<detail>`; it probes the DevTools endpoint directly, so
 * it cannot be answered from the server's cached view of a browser that is gone.
 */
async function probeBrowser(): Promise<{ state: string; detail: string }> {
	const now = Date.now();
	if (cachedProbe && now - cachedProbe.at < PROBE_CACHE_MS) {
		return { state: cachedProbe.state, detail: cachedProbe.detail };
	}
	let state = "unknown";
	let detail = "could not run ./scripts/browser.sh health";
	const root = repoRoot();
	if (root) {
		try {
			const { stdout } = await run(join(root, "scripts", "browser.sh"), ["health"], {
				timeout: 20_000,
				cwd: root,
			});
			const [first = "", rest = ""] = stdout.trim().split("\t");
			if (first) {
				state = first;
				detail = rest;
			}
		} catch (error) {
			// A non-zero exit is a verdict, not a crash: browser.sh health uses the
			// exit code to say WHICH failure it is, and still prints the same line.
			const stdout = String((error as { stdout?: string }).stdout ?? "").trim();
			const [first = "", rest = ""] = stdout.split("\t");
			if (first) {
				state = first;
				detail = rest;
			} else {
				detail = String((error as Error).message ?? error).slice(0, 200);
			}
		}
	}
	cachedProbe = { at: now, state, detail };
	return { state, detail };
}

function advice(toolName: string, state: string, detail: string): string {
	const head = `The ${toolName} call did not return — the browser did not answer in time.`;
	const fallback =
		"Do NOT retry this call: it will fail the same way. Fetch the page with the bash tool " +
		"instead (curl, and an RSS or JSON endpoint where the site has one), or ask the operator " +
		"to fix the browser. Only come back to the browser tools if the task genuinely needs a " +
		"rendered page (JavaScript, login, clicking).";

	switch (state) {
		case "wedged":
			return (
				`${head}\n\nChrome is wedged: ${detail}. Every browser tool will hang until an ` +
				`operator runs ./scripts/browser.sh restart.\n\n${fallback}`
			);
		case "none":
			return (
				`${head}\n\nNo Chrome is running, and opening one from cold takes longer than a ` +
				`single tool call is allowed to wait. An operator can pre-open it with ` +
				`./scripts/browser.sh up.\n\n${fallback}`
			);
		case "ok":
			return (
				`${head}\n\nChrome itself is healthy (${detail}), so this was the page, not the ` +
				`browser: a slow or blocking site, or a navigation that never settled. Retrying ` +
				`the same URL is unlikely to help.\n\n${fallback}`
			);
		default:
			return (
				`${head}\n\nThe browser's own health could not be determined (${detail}).\n\n${fallback}`
			);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		const anyEvent = event as unknown as {
			toolName?: string;
			isError?: boolean;
			content?: unknown;
		};
		const toolName = anyEvent.toolName ?? "";
		if (!anyEvent.isError || !BROWSER_TOOL.test(toolName)) return;

		const text = Array.isArray(anyEvent.content)
			? (anyEvent.content as { type?: string; text?: string }[])
					.map((block) => (block?.type === "text" ? (block.text ?? "") : ""))
					.join("\n")
			: String(anyEvent.content ?? "");
		if (!TRANSPORT_FAILURE.test(text)) return;

		const { state, detail } = await probeBrowser();
		return { content: [{ type: "text" as const, text: advice(toolName, state, detail) }], isError: true };
	});
}
