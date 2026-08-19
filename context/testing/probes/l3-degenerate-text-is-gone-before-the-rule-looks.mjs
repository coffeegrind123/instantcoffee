/**
 * l3 — X5. The rule was reading the message AFTER the loop's own sanitizer had
 * rewritten it, so it could not fire in a real session at all.
 *
 * `message_end` returns a sanitized replacement for a degenerate assistant
 * message. pi does not treat that as advice:
 *
 *   ExtensionRunner.emitMessageEnd (runner.js:610) threads each handler's
 *   returned message into the next handler and hands the last one back;
 *   AgentSession._emitExtensionEvent (agent-session.js:481) then calls
 *   _replaceMessageInPlace(event.message, normalized) (agent-session.js:425),
 *   which DELETES every key of the object agent-core is holding and copies the
 *   replacement over it.
 *
 * Its own comment says why: "Mutating this object in place keeps agent state,
 * later turn/agent events, listeners, and the eventual
 * SessionManager.appendMessage(event.message) persistence in sync." `agent_end`
 * is one of those later events, and its `messages` are those same objects.
 *
 * So by the time `detectStuck`'s degenerate rule looked, the repetition had been
 * cut out and replaced with a one-line marker — and the sanitizer and the rule
 * use the SAME threshold (DEGENERATE_REPEATS), so anything the rule could have
 * caught had already been truncated. The rule was unreachable.
 *
 * It was invisible because `_host.mjs` did not replay the replacement: it built a
 * fresh message object for `agent_end` and ignored what the handlers returned.
 * Four passes of probes therefore showed the rule firing on text that, in a real
 * session, no longer existed. The host now replays it — see
 * `applyMessageEndReplacement` there.
 *
 * FIXED: the buffer takes the ORIGINAL message. The two buffers next to it still
 * take the sanitized one, because they feed the repetition WINDOWS and the
 * sanitized text is what the model sees next turn.
 *
 *   run: node --experimental-strip-types l3-degenerate-text-is-gone-before-the-rule-looks.mjs
 */

import { makeHost } from "./_host.mjs";
import loopMode from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts";
import {
  detectDegenerateRepetition,
  messageToRepetitionText,
  sanitizeDegenerateMessage,
} from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/src/repetition.ts";

const DEGENERATE = Array.from({ length: 9 }, () => "I will now verify the parser handles nested quotes.").join(" ");
const raw = { role: "assistant", content: [{ type: "text", text: DEGENERATE }], stopReason: "stop", usage: { output: 40 } };
const sanitized = sanitizeDegenerateMessage(raw);
const afterReplacement = messageToRepetitionText(sanitized ?? raw);

console.log(`
=== l3 — the degenerate text was gone before the rule read it ===

  what the model produced          ${DEGENERATE.length} chars, 9 identical sentences
  what message_end returned        ${afterReplacement.length} chars, truncated + a marker
  pi then writes that OVER the object agent_end holds (_replaceMessageInPlace)

  detectDegenerateRepetition(…, DEGENERATE_REPEATS = 4):
    BEFORE  over the message agent_end holds   ${JSON.stringify(detectDegenerateRepetition(afterReplacement, 4) ?? null)}
    NOW     over what the model produced       ${JSON.stringify(detectDegenerateRepetition(messageToRepetitionText(raw), 4))}

  The two thresholds are the same NUMBER: DEGENERATE_REPEATS is declared once in
  extensions/index.ts and again in src/repetition.ts, and both are 4. So this was
  never "sometimes late" — every input the rule could have matched was truncated
  first, one handler earlier. (Two declarations of one constant is the ninth
  pass's note: nothing keeps them equal.)
`);

const host = makeHost({ percent: 20 });
loopMode(host.pi);
await host.run("start audit the parser");

// ONE object, emitted to message_end and then handed to agent_end, exactly as pi
// does it — the host applies the replacement in place.
const message = { role: "assistant", content: [{ type: "text", text: DEGENERATE }], stopReason: "stop", usage: { output: 40 } };
host.notices.length = 0;
await host.fire("message_end", { message });
await host.fire("tool_result", { toolName: "read", content: "out", isError: false });
await host.fire("agent_end", { messages: [message] });

console.log(`  driving the shipped module, with the replacement applied:
    the object agent_end saw : ${JSON.stringify(String(message.content[0].text).slice(-64))}
    notice                   : ${host.notices.join(" | ") || "(no notice)"}
`);
await host.quit();

console.log(`  The control for the harness change is the rest of the probe suite: g2, h4,
  i1, i2, j1, j2, k1 and k2 all print what they printed before it, because none
  of them uses text the sanitizer touches. That is the point — the divergence
  was invisible until an input existed that could see it.
`);
