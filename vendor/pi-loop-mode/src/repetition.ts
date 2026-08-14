import { createHash } from "node:crypto";

const MAX_STORED_TEXT = 280;
const DEGENERATE_REPEATS = 4;
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

export function sanitizeDegenerateText(text: string): string | undefined {
  const info = detectDegenerateRepetition(text, DEGENERATE_REPEATS);
  if (!info) return undefined;
  const keepLength = Math.max(200, Math.min(text.length, Math.ceil((text.length / info.repeats) * 2)));
  return (
    `${text.slice(0, keepLength).trimEnd()}\n\n` +
    `[loop: degenerate repetition truncated — the same ${info.kind} "${snippet(info.unit, 60)}" repeated ${info.repeats}×. Do not continue this pattern.]`
  );
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
