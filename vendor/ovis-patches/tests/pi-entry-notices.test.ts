/** This stack's pi entries, as the notices Ovis's chat shows. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { piEntryNotice } from "../pi-entry-notices.ts";

const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });

describe("piEntryNotice", () => {
  test("a notify() the bridge saved", () => {
    assert.deepEqual(piEntryNotice(custom("ovis-notice", { message: " Loop paused ", level: "warning" })),
      { kind: "notice", text: "Loop paused", source: "ovis-notice" });
  });

  test("a /stack report: a summary line with content, then every line", () => {
    assert.deepEqual(piEntryNotice(custom("stack-report", { title: "stack", lines: ["llama    up", "forge  up"], tone: "info" })),
      { kind: "notice", text: "stack · llama up\nllama    up\nforge  up", source: "stack-report" });
  });

  test("a /stack report with no lines is its title", () => {
    assert.equal(piEntryNotice(custom("stack-report", { title: "stack env", lines: [] }))?.text, "stack env");
  });

  test("a subagent transcript part names the agent and says what was cut", () => {
    const notice = piEntryNotice(custom("subagent-turn", { shortId: "a1b2", agentType: "general-purpose", phase: "turn", lines: ["read x"], dropped: 3 }));
    assert.equal(notice?.text, "[subagent a1b2 general-purpose] turn\nread x\n… 3 more lines");
  });

  test("Matrix bridge output is a string", () => {
    assert.equal(piEntryNotice(custom("prinny-output", "sent to #room"))?.text, "sent to #room");
  });

  test("an empty one is no notice, and not handed back to Ovis either", () => {
    assert.equal(piEntryNotice(custom("stack-report", { lines: [] })), null);
  });

  test("anything else is left to Ovis's own rules", () => {
    assert.equal(piEntryNotice(custom("loop-state", { active: true })), undefined);
    assert.equal(piEntryNotice({ type: "custom_message", customType: "ovis-notice", content: "x" }), undefined);
    assert.equal(piEntryNotice({ type: "message" }), undefined);
  });
});
