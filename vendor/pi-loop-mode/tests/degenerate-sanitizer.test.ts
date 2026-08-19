/**
 * Z3 — the sanitizer left the repetition in, and its fixed point was still
 * degenerate.
 *
 * `sanitizeDegenerateText` cut at `Math.max(200, ceil(text.length / repeats * 2))`
 * — "about two copies of the repeated unit, but never less than 200 characters".
 * The floor is the defect. When the repeated unit is shorter than about fifty
 * characters, which is the ordinary shape of a model that has fallen into a loop
 * ("Still working on it.", "Let me try again."), 200 characters is still four to
 * ten copies of it, and `DEGENERATE_REPEATS` is 4. So the output was itself
 * degenerate, and running the function on its own output returned the same
 * length and the same repetition — a fixed point it could not leave.
 *
 * That matters because of X5's mechanism, in reverse. `message_end` returns the
 * sanitized message and pi writes it OVER the object it holds
 * (`agent-session.js:425`), so what stayed in the transcript, and was re-sent on
 * every turn afterwards, was still a run of the repeated sentence — under a
 * marker announcing that it had been truncated.
 *
 * The second describe is the other direction, and it was wrong before this pass
 * too: the old formula assumed the repetition was the WHOLE message, so a real
 * answer followed by a short run of junk had the answer cut off with it.
 *
 * Controls throughout: the eighth pass's own example (a 52-character sentence
 * repeated nine times) was already clean under the old rule and must stay clean;
 * a message with no repetition must still be returned untouched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectDegenerateRepetition, sanitizeDegenerateText } from "../src/repetition.ts";

const DEGENERATE_REPEATS = 4;
const repeat = (unit: string, times: number) => Array.from({ length: times }, () => unit).join(" ");
const isDegenerate = (text: string) => Boolean(detectDegenerateRepetition(text, DEGENERATE_REPEATS));

describe("Z3 — what the sanitizer stores is not itself degenerate", () => {
  it("removes a SHORT repeated sentence rather than leaving nine copies of it", () => {
    const text = repeat("Still working on it.", 20);
    assert.ok(isDegenerate(text), "the input is what this is about");

    const sanitized = sanitizeDegenerateText(text);
    assert.ok(sanitized, "it is sanitized at all");
    // Before the fix this held 9 copies: max(200, 419/20*2) === 200 characters,
    // and 200 characters of a 20-character sentence is ten of them.
    assert.equal(isDegenerate(sanitized), false, "and what is stored is clean");
  });

  it("is idempotent, which is the property §7 claimed and did not have", () => {
    for (const text of [repeat("Still working on it.", 20), repeat("I will now check the file again.", 12)]) {
      const once = sanitizeDegenerateText(text);
      assert.ok(once);
      assert.equal(
        sanitizeDegenerateText(once),
        undefined,
        "sanitizing the sanitized text finds nothing left to cut",
      );
    }
  });

  it("control — the eighth pass's own example was already clean and still is", () => {
    const text = repeat("The feature has been implemented successfully in the module.", 9);
    const sanitized = sanitizeDegenerateText(text);
    assert.ok(sanitized);
    assert.equal(isDegenerate(sanitized), false);
    assert.match(sanitized, /degenerate repetition truncated/, "and it still says what it did");
    assert.match(sanitized, /repeated 9×/, "and still reports the count the model produced, not the count kept");
  });

  it("control — a message with no repetition is not touched", () => {
    const text =
      "The three callers of tokenize() are src/parser.ts:41, src/lexer.ts:9 and tools/lint.ts:88. " +
      "The third goes through the compatibility shim in tools/shim.ts, which forwards its arguments unchanged.";
    assert.equal(sanitizeDegenerateText(text), undefined);
  });
});

describe("Z3 — and it keeps the answer that came before the repetition", () => {
  const ANSWER =
    "The three callers of tokenize() are src/parser.ts:41, src/lexer.ts:9 and " +
    "tools/lint.ts:88. The first two call it directly; the third goes through " +
    "the compatibility shim in tools/shim.ts, which forwards its arguments " +
    "unchanged and is the only caller that passes a custom dialect. Nothing else " +
    "in the tree references the symbol at all, including the tests.";

  it("a real answer followed by a run of junk keeps the answer", () => {
    const sanitized = sanitizeDegenerateText(`${ANSWER} ${repeat("Let me check again.", 20)}`);
    assert.ok(sanitized);
    // The old rule cut at 200 characters — a third of the way into the answer.
    assert.match(sanitized, /only caller that passes a custom dialect/, "the answer survives the cut");
    assert.equal(isDegenerate(sanitized), false, "and the repetition does not");
  });

  it("control — junk with no answer in front of it keeps almost nothing", () => {
    const sanitized = sanitizeDegenerateText(repeat("Let me check again.", 20));
    assert.ok(sanitized);
    assert.equal(isDegenerate(sanitized), false);
    assert.ok(sanitized.length < 260, `kept ${sanitized.length} chars, which is the marker and little else`);
  });
});
