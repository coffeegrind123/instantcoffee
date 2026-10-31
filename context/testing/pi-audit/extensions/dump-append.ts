/**
 * Append every provider request's tool names to $DUMP_APPEND, one JSON line per
 * request. Load it in a parent with -e and in subagent children through
 * SUBAGENT_EXTRA_EXTENSIONS: lines with Agent are the parent's. A tool list
 * that changes mid-session re-prefills the prompt on templates that render
 * tools at the top, so `jq -c .tools | sort -u | wc -l` should be 1 per session.
 */
import { appendFileSync } from "node:fs";

export default function (pi: any) {
  pi.on("before_provider_request", (event: any) => {
    const tools = Array.isArray(event.payload?.tools) ? event.payload.tools : [];
    appendFileSync(
      process.env.DUMP_APPEND!,
      JSON.stringify({ at: Date.now(), tools: tools.map((t: any) => t.function?.name ?? t.name) }) + "\n",
    );
    return undefined;
  });
}
