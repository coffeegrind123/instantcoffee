/**
 * Control: an extension whose before_agent_start handler throws. pi must print
 * "Extension error (...): CONTROL-HOOK-THROW" on stderr and still finish the
 * turn. Proves a hook failure would be visible in the real set's stderr.
 */
export default function (pi: { on(event: string, handler: () => void): void }) {
  pi.on("before_agent_start", () => {
    throw new Error("CONTROL-HOOK-THROW");
  });
}
