import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CRITICAL_PERCENT,
  NOTICE_MESSAGE_TYPE,
  NOTICE_PERCENT,
  contextNoticeMessage,
  contextNoticeText,
  hasBudgetMessage,
} from "../src/context-notice.ts";

const WINDOW = 32_768;
const at = (percent: number) => ({ tokens: Math.round((WINDOW * percent) / 100), contextWindow: WINDOW, percent });

describe("contextNoticeText", () => {
  it("says nothing while there is room", () => {
    assert.equal(contextNoticeText(at(10)), undefined);
    assert.equal(contextNoticeText(at(59)), undefined);
  });

  it("starts at the notice threshold, below the empty-turn cliff", () => {
    assert.ok(NOTICE_PERCENT < 87, "the notice must arrive before the measured cliff at 87%");
    const text = contextNoticeText(at(NOTICE_PERCENT)) as string;
    assert.ok(text.startsWith("[context budget]"));
    assert.ok(text.includes("60% used"));
  });

  it("escalates to a hard instruction at the critical threshold", () => {
    const advisory = contextNoticeText(at(CRITICAL_PERCENT - 1)) as string;
    const critical = contextNoticeText(at(CRITICAL_PERCENT)) as string;
    assert.ok(!advisory.includes("CRITICAL"));
    assert.ok(critical.includes("CRITICAL"));
    assert.ok(critical.includes("Do not read whole files"));
  });

  it("reports the room that is actually left", () => {
    const text = contextNoticeText(at(75)) as string;
    // 25% of 32,768 is 8,192 tokens.
    assert.ok(text.includes("8.2k of 32.8k tokens left"), text);
  });

  it("stays silent when usage is unknown, which is the state right after a compaction", () => {
    assert.equal(contextNoticeText({ tokens: null, contextWindow: WINDOW, percent: null }), undefined);
    assert.equal(contextNoticeText(undefined), undefined);
    assert.equal(contextNoticeText({ tokens: 100, contextWindow: 0 }), undefined);
    assert.equal(contextNoticeText({ tokens: -1, contextWindow: WINDOW }), undefined);
  });

  it("derives the percentage when pi does not supply one", () => {
    const text = contextNoticeText({ tokens: Math.round(WINDOW * 0.7), contextWindow: WINDOW }) as string;
    assert.ok(text.includes("70% used"), text);
  });

  it("carries no loop vocabulary, since it runs in ordinary sessions", () => {
    for (const percent of [65, 85, 95]) {
      const text = contextNoticeText(at(percent)) as string;
      for (const word of ["loop", "PROGRESS.md", "iteration", "GOAL.md"]) {
        assert.ok(!text.includes(word), `"${word}" must not appear at ${percent}%: ${text}`);
      }
    }
  });
});

describe("contextNoticeMessage", () => {
  it("builds a hidden custom message, or nothing at all", () => {
    assert.equal(contextNoticeMessage(at(10)), undefined);
    const message = contextNoticeMessage(at(70)) as {
      role: string;
      customType: string;
      display: boolean;
      content: { type: string; text: string }[];
    };
    assert.equal(message.role, "custom");
    assert.equal(message.customType, NOTICE_MESSAGE_TYPE);
    assert.equal(message.display, false);
    assert.equal(message.content[0].type, "text");
    assert.ok(message.content[0].text.includes("[context budget]"));
  });
});

describe("hasBudgetMessage", () => {
  it("recognises this extension's notice", () => {
    assert.equal(hasBudgetMessage([{ customType: NOTICE_MESSAGE_TYPE }]), true);
  });

  it("recognises the loop's notice, so the two never both fire", () => {
    // vendor/pi-loop-mode/src/context-budget.ts BUDGET_MESSAGE_TYPE
    assert.equal(hasBudgetMessage([{ role: "user" }, { customType: "loop-context-budget" }]), true);
  });

  it("is false for ordinary messages", () => {
    assert.equal(hasBudgetMessage([{ role: "user" }, { role: "assistant" }, null, { customType: "loop-state" }]), false);
    assert.equal(hasBudgetMessage([]), false);
  });
});
