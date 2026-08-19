import { createHash } from "node:crypto";

const MAX_STORED_TEXT = 280;
/**
 * How many times a sentence, word or phrase must repeat inside ONE response
 * before it counts as degenerate.
 *
 * Exported because `extensions/index.ts` declared its own copy of the same
 * number, and X5's argument rests on the two being "the same constant" — they
 * were the same VALUE, in two files, with nothing keeping them equal. Now there
 * is one.
 */
export const DEGENERATE_REPEATS = 4;
const DEGENERATE_WORD_REPEATS = 16;
const DEGENERATE_PHRASE_REPEATS = 8;
const DEGENERATE_MAX_PHRASE_WORDS = 4;

export function normalizeText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(normalizeText(text).slice(0, 4_000)).digest("hex").slice(0, 16);
}

function stripVolatile(text: string): string {
  return normalizeText(text).replace(/\d+/g, "#");
}

function wordShingles(text: string, n = 3): Set<string> {
  const words = stripVolatile(text).split(" ").filter(Boolean);
  const set = new Set<string>();
  if (words.length < n) {
    if (words.length > 0) set.add(words.join(" "));
    return set;
  }
  for (let i = 0; i <= words.length - n; i++) set.add(words.slice(i, i + n).join(" "));
  return set;
}

export function textSimilarity(a: string, b: string): number {
  const setA = wordShingles(a);
  const setB = wordShingles(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const shingle of setA) if (setB.has(shingle)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

export interface DegenerateInfo {
  repeats: number;
  unit: string;
  kind: "sentence" | "word" | "phrase";
}

function sameTokenSequence(tokens: string[], left: number, right: number, width: number): boolean {
  for (let offset = 0; offset < width; offset++) {
    if (tokens[left + offset] !== tokens[right + offset]) return false;
  }
  return true;
}

function repeatedTokenSequence(text: string): DegenerateInfo | undefined {
  const tokens = normalizeText(text).match(/[\p{L}\p{N}_'-]+/gu) ?? [];
  for (let width = 1; width <= DEGENERATE_MAX_PHRASE_WORDS; width++) {
    const minimumRepeats = width === 1 ? DEGENERATE_WORD_REPEATS : DEGENERATE_PHRASE_REPEATS;
    for (let start = 0; start + width * minimumRepeats <= tokens.length; start++) {
      let repeats = 1;
      while (
        start + (repeats + 1) * width <= tokens.length &&
        sameTokenSequence(tokens, start, start + repeats * width, width)
      ) {
        repeats++;
      }
      if (repeats >= minimumRepeats) {
        return {
          repeats,
          unit: tokens.slice(start, start + width).join(" "),
          kind: width === 1 ? "word" : "phrase",
        };
      }
    }
  }
  return undefined;
}

export function detectDegenerateRepetition(text: string, minSentenceRepeats: number): DegenerateInfo | undefined {
  const normalized = stripVolatile(text);
  if (normalized.length < 150) return undefined;
  const parts = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 15);
  if (parts.length >= minSentenceRepeats) {
    const counts = new Map<string, number>();
    for (const part of parts) counts.set(part, (counts.get(part) ?? 0) + 1);
    let unit = "";
    let repeats = 0;
    for (const [part, count] of counts) {
      if (count > repeats) {
        unit = part;
        repeats = count;
      }
    }
    if (repeats >= minSentenceRepeats && repeats / parts.length >= 0.5) {
      return { repeats, unit, kind: "sentence" };
    }
  }
  return repeatedTokenSequence(text);
}

export function snippet(text: string, limit = MAX_STORED_TEXT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

/**
 * How much of `text` can be kept without the RESULT still being degenerate.
 *
 * Forge fork: this used to be `Math.max(200, ceil(text.length / repeats * 2))` —
 * "about two copies of the repeated unit, but never less than 200 characters" —
 * and the floor is the whole defect. Whenever the repeated unit is shorter than
 * about 50 characters, which is the ordinary shape of a model that has fallen
 * into a loop ("Still working on it.", "Let me try again."), 200 characters is
 * still four to ten copies of it. `DEGENERATE_REPEATS` is 4, so the output was
 * itself degenerate, and the function reached a FIXED POINT that was still
 * degenerate: sanitizing it again returned the same length and the same
 * repetition, forever. Measured on this module before the change:
 *
 *     20 × "Still working on it."   419 chars  ->  328 chars, 9 repeats left
 *     12 × "I will now check…"      395 chars  ->  339 chars, 6 repeats left
 *      9 × a 52-char sentence       548 chars  ->  367 chars, clean
 *
 * `message_end` writes the sanitized message over the one pi holds, so those 9
 * repeats stayed in the transcript and were re-sent on every turn afterwards —
 * which is the one thing this function exists to prevent. (`§7`'s note that the
 * sanitizer "is idempotent on its own output" was wrong; the third bullet is the
 * only case it was ever true for.)
 *
 * Searching for the longest clean prefix computes the same intent — keep the
 * text up to where the repetition takes over — without assuming the repetition
 * starts at character 0 or spans the whole message, so a message with a genuine
 * answer followed by a short run of junk keeps the answer. The marker is part of
 * what is tested, because it quotes the unit once and a prefix one repeat below
 * the threshold plus the marker can cross it.
 *
 * `low = 0` is clean by construction: `detectDegenerateRepetition` returns
 * undefined below 150 normalized characters and the marker alone is shorter than
 * that. See Z3 in `context/design/subagents-loop-verifier-answers.md`.
 */
function cleanPrefixLength(text: string, marker: string): number {
  const clean = (n: number) =>
    !detectDegenerateRepetition(`${text.slice(0, n).trimEnd()}\n\n${marker}`, DEGENERATE_REPEATS);
  let low = 0;
  let high = text.length;
  if (clean(high)) return high;
  // 16 characters of granularity: finer than any repeated unit worth cutting,
  // and it bounds the search at ~8 detector runs on a 4k message.
  while (high - low > 16) {
    const mid = (low + high) >> 1;
    if (clean(mid)) low = mid;
    else high = mid;
  }
  return low;
}

export function sanitizeDegenerateText(text: string): string | undefined {
  const info = detectDegenerateRepetition(text, DEGENERATE_REPEATS);
  if (!info) return undefined;
  const marker = `[loop: degenerate repetition truncated — the same ${info.kind} "${snippet(info.unit, 60)}" repeated ${info.repeats}×. Do not continue this pattern.]`;
  return `${text.slice(0, cleanPrefixLength(text, marker)).trimEnd()}\n\n${marker}`;
}

/**
 * Markers a context layer appends when it shortens something, and which are not
 * part of what the tool actually said.
 *
 * Two of them exist on this stack: this module's own
 * `[... truncated: repeated N times ...]`, and `compaction-guard`'s
 * `[output capped at N% context: X chars, kept about Y. Full output:
 * /tmp/pi-tool-output-XXXX/<tool>-<callId>.txt. ...]`.
 *
 * The second is why this function exists. That marker names a spill file keyed
 * by the TOOL-CALL ID, which is unique per call, and it quotes the percentage of
 * context in use — so two byte-identical tool results carry different markers.
 * `detectStuck`'s rule 7 compares `fingerprint(text)` of each turn's tool
 * results, and a fingerprint that includes a per-call id can never match, on
 * exactly the saturated contexts where the cap fires and the model is most
 * likely to be stuck.
 *
 * Today the loop's `tool_result` handler runs BEFORE the guard's (registration
 * order, `scripts/pi-local.sh`), so it sees the raw text and the rule works. That
 * ordering is enforced by one line of a shell script whose comment says a
 * different order "costs a duplicate line, not a bug" — which is true of the
 * context-budget line it is about and false here. Stripping the marker makes the
 * rule ask about the tool's OUTPUT rather than about how the context layer chose
 * to shorten it, which is what it meant all along, and takes the ordering out of
 * the argument entirely.
 */
const SHORTENING_MARKER = /\n*\[(?:output capped|[^\]\n]*truncat)[^\]]*\]\n*/gi;

/** Text as the tool produced it, with any context-layer shortening marker removed. */
export function stripShorteningMarkers(text: string): string {
  return text.replace(SHORTENING_MARKER, "\n").trim();
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return "";
}

export function messageToText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  return contentToText((message as { content?: unknown }).content);
}

function contentToRepetitionText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if ("text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        if ("thinking" in part && typeof (part as { thinking?: unknown }).thinking === "string") {
          return (part as { thinking: string }).thinking;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if ("text" in content && typeof (content as { text?: unknown }).text === "string") {
      return (content as { text: string }).text;
    }
    if ("thinking" in content && typeof (content as { thinking?: unknown }).thinking === "string") {
      return (content as { thinking: string }).thinking;
    }
  }
  return "";
}

export function messageToRepetitionText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  return contentToRepetitionText((message as { content?: unknown }).content);
}

export function sanitizeDegenerateMessage(message: { content?: unknown }): unknown | undefined {
  const content = message.content;
  if (typeof content === "string") {
    const sanitized = sanitizeDegenerateText(content);
    return sanitized ? { ...message, content: sanitized } : undefined;
  }
  if (!Array.isArray(content)) return undefined;

  let changed = false;
  const parts = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const type = (part as { type?: string }).type;
    if (type === "text" && typeof (part as { text?: unknown }).text === "string") {
      const sanitized = sanitizeDegenerateText((part as { text: string }).text);
      if (sanitized) {
        changed = true;
        return { ...(part as object), text: sanitized };
      }
    }
    if (type === "thinking" && typeof (part as { thinking?: unknown }).thinking === "string") {
      const sanitized = sanitizeDegenerateText((part as { thinking: string }).thinking);
      if (sanitized) {
        changed = true;
        return { ...(part as object), thinking: sanitized };
      }
    }
    return part;
  });
  return changed ? { ...message, content: parts } : undefined;
}
