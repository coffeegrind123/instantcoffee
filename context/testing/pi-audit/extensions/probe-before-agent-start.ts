/**
 * Does before_agent_start fire for a run an extension starts? Records every
 * before_agent_start (messageType, whether it has a prompt) to $PROBE_OUT, and
 * after the first run settles starts a second one with
 * sendMessage(..., { triggerTurn: true }).
 *
 * Measured 2026-10-31: pi 0.87.1 records one line (messageType null); pi 1.4.0
 * records two, the second {"messageType":"custom","hasPrompt":false}. That is
 * the premise change behind the /loop fix (L1).
 */
import { appendFileSync } from "node:fs";

export default function (pi: any) {
  let sent = false;
  pi.on("before_agent_start", (event: any) => {
    appendFileSync(
      process.env.PROBE_OUT!,
      JSON.stringify({
        messageType: event.messageType ?? null,
        hasPrompt: typeof event.prompt === "string",
        customType: event.message?.customType ?? null,
      }) + "\n",
    );
  });
  pi.on("agent_settled", () => {
    if (sent) return;
    sent = true;
    pi.sendMessage({ customType: "probe-trigger", content: "Reply with the single word AGAIN.", display: false }, { triggerTurn: true });
  });
}
