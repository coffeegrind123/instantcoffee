/**
 * Write the LAST provider request's shape to $DUMP_OUT: total bytes, system
 * prompt (text and length), tool names and their schema bytes. What the model
 * is actually sent on every turn, for comparing two pi versions or two tool
 * surfaces with the same flags.
 */
import { writeFileSync } from "node:fs";

export default function (pi: any) {
  pi.on("before_provider_request", (event: any) => {
    const p = event.payload ?? {};
    const msgs = Array.isArray(p.messages) ? p.messages : [];
    const sys = msgs.filter((m: any) => m.role === "system" || m.role === "developer");
    const sysText = sys.map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    const tools = Array.isArray(p.tools) ? p.tools : [];
    writeFileSync(
      process.env.DUMP_OUT!,
      JSON.stringify(
        {
          keys: Object.keys(p).sort(),
          total_bytes: JSON.stringify(p).length,
          system_chars: sysText.length,
          tool_names: tools.map((t: any) => t.function?.name ?? t.name),
          tools_bytes: JSON.stringify(tools).length,
          roles: msgs.map((m: any) => m.role),
          system: sysText,
        },
        null,
        1,
      ),
    );
    return undefined;
  });
}
