// Flatten a chara_card_v2 into browsable sections, with a token estimate per
// section so the card viewer can say what a field would cost before it is read.
//
// Ported from openclaude's src/services/identity/cardSections.ts.

import type { CardSectionEntry, CardSectionKind, CharaCardV2, CharaCardV2Data } from "./types.ts"

/** ~4 chars per token. Deliberately the same crude estimate openclaude uses:
 *  this number is for ordering and for a "that field is huge" warning, not for
 *  a budget anything is enforced against. */
export function approxTokens(s: string): number {
  if (!s) return 0
  return Math.ceil(s.length / 4)
}

function toText(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v, null, 2)
}

function entry(name: string, content: string, kind: CardSectionKind): CardSectionEntry {
  const trimmed = content?.trim?.() ?? ""
  return {
    name,
    content,
    kind,
    isEmpty: trimmed.length === 0 || trimmed === "[]" || trimmed === "{}",
    tokenCount: approxTokens(content),
  }
}

function arrayEntry(name: string, items: unknown[]): CardSectionEntry {
  if (!items || items.length === 0) return entry(name, "", "array")
  const formatted = items
    .map((it, i) => `[${i + 1}] ${typeof it === "string" ? it : JSON.stringify(it, null, 2)}`)
    .join("\n\n")
  return entry(name, formatted, "array")
}

function jsonEntry(name: string, value: unknown): CardSectionEntry {
  if (value == null) return entry(name, "", "json")
  return entry(name, JSON.stringify(value, null, 2), "json")
}

export function flattenCardForViewer(card: CharaCardV2): CardSectionEntry[] {
  const d: CharaCardV2Data = card.data
  return [
    entry("name", toText(d.name), "text"),
    entry("description", toText(d.description), "text"),
    entry("personality", toText(d.personality), "text"),
    entry("first_mes", toText(d.first_mes), "text"),
    arrayEntry("alternate_greetings", d.alternate_greetings ?? []),
    entry("mes_example", toText(d.mes_example), "text"),
    entry("scenario", toText(d.scenario), "text"),
    entry("creator_notes", toText(d.creator_notes), "text"),
    entry("system_prompt", toText(d.system_prompt), "text"),
    entry("post_history_instructions", toText(d.post_history_instructions), "text"),
    arrayEntry("tags", (d.tags ?? []) as unknown[]),
    jsonEntry("character_book", d.character_book ?? null),
    jsonEntry("extensions.depth_prompt", d.extensions?.depth_prompt),
    jsonEntry("extensions.chub", d.extensions?.chub),
    entry("avatar", toText(d.avatar ?? ""), "image"),
    entry("creator", toText(d.creator), "text"),
    entry("character_version", toText(d.character_version), "text"),
    entry("spec", `${card.spec} (v${card.spec_version})`, "text"),
  ]
}

/** One-line summary of a card for a picker row. */
export function describeCard(card: CharaCardV2): string {
  const d = card.data
  const tags = (d.tags ?? []).slice(0, 4).join(", ")
  const total = flattenCardForViewer(card).reduce((n, s) => n + s.tokenCount, 0)
  const bits = [`~${total} tok`]
  if (d.creator) bits.push(`by ${d.creator}`)
  if (tags) bits.push(tags)
  return `${d.name} — ${bits.join(" · ")}`
}
