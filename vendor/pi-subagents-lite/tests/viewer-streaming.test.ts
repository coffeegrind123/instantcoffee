/**
 * The conversation viewer keeps a finished thinking/text block on screen while
 * the rest of its message is still streaming.
 *
 * pi 1.4 (pi-agent-core agent.js): the loop streams into a COPY of the
 * transcript (`createContextSnapshot()` → `messages.slice()`), and the agent's
 * own `state.messages` — which is what `AgentSession.messages` returns — gets
 * the assistant message only at `message_end` (`processEvents`: push). So while
 * a message streams, the viewer's only copy of it is its accumulators, and they
 * are cleared at `thinking_end` / `text_end`: a finished block was on screen in
 * neither place until `message_end` pushed the final message.
 *
 * (Upstream 1.17.1 fixes the same symptom by re-rendering `session.messages`'
 * last slot at the boundaries, on the premise that pi replaces that slot while
 * streaming. Against pi 1.4 that slot is the PREVIOUS message, so its fix would
 * not reach this; the in-flight message travels on the event instead.)
 *
 * Driven with pi's real `Agent` and a scripted stream, through pi's own jiti.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PI_ROOT } from "./pi-install.ts";

const PI_ENTRY = `${PI_ROOT}/dist/index.js`;
const JITI = `${PI_ROOT}/node_modules/jiti/lib/jiti.mjs`;
const DEPS = `${PI_ROOT}/node_modules`;
const SRC = fileURLToPath(new URL("../src", import.meta.url));

const THOUGHT = "ZEBRA-THOUGHT";
const ANSWER = "OKAPI-ANSWER";

/** Every theme method returns its text argument unstyled. */
const theme: any = new Proxy({}, { get: () => (...args: unknown[]) => args[args.length - 1] });

/**
 * A scripted provider stream: thinking block, then text block, then done. ONE
 * `partial` object, mutated in place between events and sent with every one, as
 * pi-ai's providers do (api/openai-completions.js: `block.text += …`,
 * `partial: output`) — so a viewer that kept a reference instead of a copy would
 * later see the block being streamed and draw it twice.
 */
function scriptedStream(model: any) {
  const partial: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now() };
  const final = () => ({ ...partial, content: partial.content.map((c: any) => ({ ...c })) });
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial };
      partial.content.push({ type: "thinking", thinking: "" });
      yield { type: "thinking_start", contentIndex: 0, partial };
      partial.content[0].thinking = THOUGHT;
      yield { type: "thinking_delta", contentIndex: 0, delta: THOUGHT, partial };
      yield { type: "thinking_end", contentIndex: 0, content: THOUGHT, partial };
      partial.content.push({ type: "text", text: "" });
      yield { type: "text_start", contentIndex: 1, partial };
      partial.content[1].text = ANSWER;
      yield { type: "text_delta", contentIndex: 1, delta: ANSWER, partial };
      yield { type: "text_end", contentIndex: 1, content: ANSWER, partial };
      yield { type: "done", reason: "stop", message: final() };
    },
    result: async () => final(),
  };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("conversation viewer — a finished block stays visible mid-message", { skip: !existsSync(JITI) && "pi is not installed globally" }, () => {
  it("shows the thinking while the text streams, and each block once", async () => {
    const { createJiti } = await import(JITI);
    const jiti = createJiti(`file://${PI_ENTRY}`, {
      interopDefault: true,
      alias: {
        "@earendil-works/pi-coding-agent": PI_ENTRY,
        "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui/dist/index.js`,
      },
    });
    const { Agent } = await jiti.import(`${DEPS}/@earendil-works/pi-agent-core/dist/index.js`);
    const { ConversationViewer } = await jiti.import(`${SRC}/ui/conversation-viewer.ts`);

    const model = { id: "m", name: "m", api: "openai-completions", provider: "p", reasoning: true, input: ["text"],
      contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [], messages: [] },
      streamFn: () => scriptedStream(model),
      getApiKey: () => "k",
    });
    const session: any = {
      get messages() {
        return agent.state.messages;
      },
      subscribe: (fn: (e: any) => void) => agent.subscribe(fn),
      getContextUsage: () => undefined,
    };
    const record: any = {
      display: { type: "general-purpose", description: "probe" },
      lifecycle: { status: "running", startedAt: Date.now() },
      stats: { toolUses: 0, turnCount: 0, maxTurns: undefined, compactionCount: 0, lifetimeUsage: { input: 0, output: 0, cost: 0 } },
      execution: { session },
    };
    const tui: any = { requestRender() {}, terminal: { rows: 400 } };
    const viewer = new ConversationViewer(tui, session, record, theme, () => {});
    viewer.render(100); // the first render fixes the width the viewer renders at

    const seen: Record<string, { screen: string; inTranscript: boolean }> = {};
    agent.subscribe((e: any) => {
      const key = e.type === "message_update" ? e.assistantMessageEvent.type : e.type;
      if (!["text_delta", "text_end", "message_end"].includes(key)) return;
      if (e.type === "message_update" || e.message?.role === "assistant") {
        seen[key] = {
          screen: viewer.render(100).join("\n"),
          inTranscript: agent.state.messages.some((m: any) => m.role === "assistant"),
        };
      }
    });

    await agent.prompt("go");
    viewer.dispose();

    // The premise, measured: the in-flight message is not in session.messages.
    assert.equal(seen.text_delta.inTranscript, false, "pi 1.4 keeps the partial out of state.messages");
    assert.equal(seen.message_end.inTranscript, true, "control — and pushes it at message_end");

    assert.equal(count(seen.text_delta.screen, THOUGHT), 1, "finished thinking, while text streams");
    assert.equal(count(seen.text_delta.screen, ANSWER), 1, "streaming text, once");
    assert.equal(count(seen.text_end.screen, THOUGHT), 1, "after text_end, thinking still there");
    assert.equal(count(seen.text_end.screen, ANSWER), 1, "after text_end, the finished text still there");
    assert.equal(count(seen.message_end.screen, THOUGHT), 1, "control — once from the transcript");
    assert.equal(count(seen.message_end.screen, ANSWER), 1, "control — once from the transcript");
  });
});
