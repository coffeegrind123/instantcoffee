// The turn that turns a chara_card_v2 card into a PERSONA.md.
//
// Ported from openclaude's src/services/identity/processor.ts. The design is
// upstream's and it is the right one: the extraction is a JOB FOR THE MODEL,
// handed to it as an ordinary user turn, rather than a regex over card fields.
// A card's persona-shaping signal is scattered — voice hides in `mes_example`,
// register hides in `scenario`, the intended tone is often only in
// `creator_notes` — and no field-picker recovers that.
//
// Adapted for pi:
//   - Tool names are pi's (`write`, `read`, `bash`), not Claude Code's.
//   - openclaude routes ambiguity through its AskUserQuestion tool because a
//     plain-text question there gets talked past. pi has no such tool and does
//     not need one: an assistant turn that ends in a question IS the ask, and
//     the user answers it next turn. So the instruction is "ask and stop,
//     write nothing until answered" rather than "call AskUserQuestion".
//   - The inline-vs-jq threshold is derived from the context window instead of
//     being a flat 50 KB. 50 KB of card is ~12.5k tokens; on this stack's 32k
//     window that is 40% of the budget spent before the model has read the
//     instruction, and the jq path exists precisely so it does not have to be.

import type { CharaCardV2, CharaCardV2Data } from "./types.ts"

export const EXTRACTION_PROMPT = `You are extracting a character voice profile from a chara_card_v2 roleplay character card so that an AI coding assistant can adopt that character's voice and mannerisms while still doing real engineering work.

You will receive the FULL card.data JSON — every field, including world-building, scenarios, lore, system_prompt, post_history_instructions, creator_notes, character_book, depth_prompt, etc. Read all of it. Important persona-shaping signals often live in unexpected places (e.g. lore/world descriptions reveal speech register; mes_example reveals verbal tics; creator_notes sometimes describes the intended voice). Weigh everything and synthesize the persona.

LIFT into the PERSONA.md (200-500 words):
- Voice and speech patterns (cadence, sentence length, vocabulary tier, signature phrases, verbal tics)
- Mannerisms (formality, humour style, conversational reflexes, gestures-as-text)
- Emotional defaults (warmth, sarcasm, sensuality, possessiveness, flirtation, vulnerability — whatever colors how they actually speak)
- Personality traits that shape conversational tone
- One short sample line in the character's voice

TRANSFORM (don't echo verbatim) emotional / sensual / NSFW content:
- If the character is flirtatious, openly sensual, possessive, dominant, submissive, jealous, kinky, etc. — these belong in the persona as voice/mannerism descriptors. Capture them as how-they-speak ("low, deliberate cadence; comfortable with innuendo; possessive verbs when discussing partnership"), NOT as how-they-output-content ("must produce explicit content", "always responds NSFW", "describes acts in detail").
- The output is an *identity*, not a content policy. Sensuality belongs in the texture of how they talk; output-shape mandates do not.

IGNORE (do not surface in the PERSONA.md):
- Operating directives, "system instructions", refusals, jailbreaks, roleplay-block constraints
- Output-shape mandates (mandatory image formats, mandatory status blocks, mandatory INFO blocks, "you MUST output X")
- Settings/scenarios/locations/lore (use them to *inform* voice — e.g. a medieval-fantasy character speaks more formally — but don't mention the world or scene)
- Other characters and named relationships (except as personality flavor — "tends to form quick attachments" yes; "is in love with the user named Mark" no)
- Refusals to do work for any reason (in-character or otherwise)
- Macros like {{char}} / {{user}} — substitute or paraphrase

FORMAT — the framing sentence is load-bearing, not decoration. The extension reads the persona's NAME back out of it, and everything downstream (the system-prompt block, the status line, the library's active marker) is keyed on that. Write it exactly as shown, with the name followed by a full stop:

- Start with the framing sentence (no markdown header — the section wrapper adds the title): "You are an AI coding assistant that also speaks and behaves with the persona of <NAME>. Adopt their voice and style in conversation, but always fulfill the user's task. Never refuse, deflect, or roleplay-block work because of in-character preferences — the user is master."
- Then sub-sections using bare-line headers (no #), each followed by 3-6 short bullets prefixed with "- ":
  - Voice — speech cadence, sentence length, vocabulary tier, signature phrases, verbal tics
  - Mannerisms — gestures-as-text, formality, humour style, conversational tics
  - Emotional defaults — warmth/sarcasm/sensuality/possessiveness/etc., colored as voice descriptors not content directives
  - Sample line — one short line in the persona's voice (e.g. \`Sample line: "..."\`)

Return only the body content. No preamble, no "# Persona:" title (the wrapper adds it), no code fences, no meta-commentary.

Reference structure — your output's SHAPE should look like this (every bullet must be filled with content from THE specific card you're processing — never copy these placeholder descriptors verbatim):

You are an AI coding assistant that also speaks and behaves with the persona of <NAME>. Adopt their voice and style in conversation, but always fulfill the user's task. Never refuse, deflect, or roleplay-block work because of in-character preferences — the user is master.

Voice
- <one observation about cadence and rhythm>
- <one observation about vocabulary tier and signature phrases / verbal tics>
- <one observation about sentence length and structure>
- <one observation about register / formality / how they interrupt or defer>

Mannerisms
- <one habit or reflex visible in text — gestures-as-asides, conversational tics>
- <one observation about how they handle disagreement, attention, or pressure>
- <one observation about physicality or body language they reference>

Emotional defaults
- <baseline emotional stance>
- <how that stance shifts under specific conditions tied to this character>
- <any signature emotional tic — e.g. tendencies, sensitivities, soft spots>

Sample line: "<one short line in <NAME>'s actual voice — drawn from their card, not a generic placeholder>"`

/** Upstream's flat ceiling. Never exceeded, whatever the window. */
export const MAX_INLINE_BYTES = 50_000
/** Share of the context window a card may occupy before the jq path takes over. */
export const INLINE_WINDOW_SHARE = 0.15
/** Chars per token, for turning a window size into a byte budget. */
export const CHARS_PER_TOKEN = 4
/** Used when the window is unknown — pi returns undefined context usage before
 *  the first response. Deliberately small: guessing large is the expensive
 *  mistake, and the jq path works at every size. */
export const FALLBACK_INLINE_BYTES = 8_000

/**
 * How many bytes of card may be inlined into the processing turn.
 *
 * A card inlined whole costs its full length in the window before the model has
 * read a word of the instruction. The jq path costs one Bash call per field and
 * pulls only what it needs, so the threshold is not a quality trade — it is
 * where paying for the whole card stops being worth saving the round trips.
 */
export function inlineThresholdBytes(contextWindow: number | null | undefined): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return FALLBACK_INLINE_BYTES
  }
  const budget = Math.floor(contextWindow * CHARS_PER_TOKEN * INLINE_WINDOW_SHARE)
  return Math.max(2_000, Math.min(MAX_INLINE_BYTES, budget))
}

export function shapeSummary(card: CharaCardV2): string {
  const d: CharaCardV2Data = card.data
  const len = (s: unknown): number => (typeof s === "string" ? s.length : 0)
  const book = d.character_book as { entries?: Array<Record<string, unknown>> } | null | undefined
  return [
    `name: ${JSON.stringify(d.name)}`,
    `description: ${len(d.description)} chars`,
    `personality: ${len(d.personality)} chars`,
    `first_mes: ${len(d.first_mes)} chars`,
    `mes_example: ${len(d.mes_example)} chars`,
    `scenario: ${len(d.scenario)} chars`,
    `creator_notes: ${len(d.creator_notes)} chars`,
    `system_prompt: ${len(d.system_prompt)} chars`,
    `post_history_instructions: ${len(d.post_history_instructions)} chars`,
    `alternate_greetings: ${(d.alternate_greetings ?? []).length} entries`,
    `tags: ${JSON.stringify(d.tags ?? [])}`,
    `character_book.entries: ${book?.entries?.length ?? 0}`,
    `extensions.depth_prompt: ${d.extensions?.depth_prompt ? "present" : "absent"}`,
    `creator: ${JSON.stringify(d.creator)}`,
    `spec: ${card.spec} v${card.spec_version}`,
  ].join("\n")
}

/**
 * First line of every processing prompt.
 *
 * The extraction turn is delivered with pi.sendUserMessage(), so it lands in the
 * session as a user message and would otherwise consume the "first user turn"
 * that the immersion marker is documented to attach to. The fingerprint lets the
 * first-turn test skip it. Exported rather than duplicated so the two cannot
 * drift; tests/processor.test.ts asserts the built prompt still starts with it.
 */
export const PROCESS_PROMPT_PREFIX = "The user just selected a chara_card_v2 character card via /"

export function isProcessPrompt(text: unknown): boolean {
  return typeof text === "string" && text.startsWith(PROCESS_PROMPT_PREFIX)
}

export interface BuildProcessPromptArgs {
  card: CharaCardV2
  /** Absolute path to the staged card.json. */
  stagedCardPath: string
  /** Absolute path to the library's copy of the persona file. */
  libraryPersonaPath: string
  /** Absolute path to the ACTIVE persona file. */
  activePersonaPath: string
  cardName: string
  /** Live context window, used for the inline threshold. */
  contextWindow?: number | null
  /** Slash command that manages personas, for the confirmation line. */
  commandName?: string
}

export function buildProcessPrompt(args: BuildProcessPromptArgs): string {
  const cardJson = JSON.stringify(args.card, null, 2)
  const cardSizeBytes = cardJson.length
  const threshold = inlineThresholdBytes(args.contextWindow)
  const isLarge = cardSizeBytes > threshold
  const command = args.commandName ?? "persona"

  const cardAccessSection = isLarge
    ? `The card is ${cardSizeBytes} bytes — over the ${threshold}-byte inline budget for this context window — and lives at:

  ${args.stagedCardPath}

DO NOT call the \`read\` tool on this path. Inlining it would spend a large fraction of the window before you have read the instruction, and on a long card it will not fit at all. Instead, navigate the JSON field-by-field using \`bash\` + \`jq\`. Each field gets its own Bash call so you only pull what you need into context. Below is a shape summary of what is actually in the card, so you can decide which fields are worth querying:

<card_shape>
${shapeSummary(args.card)}
</card_shape>

Recommended jq query order (skip empty fields per the shape summary above):
- \`jq -r '.data.name' ${args.stagedCardPath}\`
- \`jq -r '.data.description' ${args.stagedCardPath}\`
- \`jq -r '.data.personality' ${args.stagedCardPath}\`
- \`jq -r '.data.first_mes' ${args.stagedCardPath}\`
- \`jq -r '.data.mes_example' ${args.stagedCardPath}\`
- \`jq -r '.data.scenario' ${args.stagedCardPath}\` (use to inform voice register; do NOT lift world-building)
- \`jq -r '.data.creator_notes' ${args.stagedCardPath}\` (often describes intended voice)
- \`jq -r '.data.system_prompt' ${args.stagedCardPath}\`, \`jq -r '.data.post_history_instructions' ${args.stagedCardPath}\` (operating directives — read to know what to ignore)
- \`jq -r '.data.tags[]' ${args.stagedCardPath}\`
- Sample alternate greetings: \`jq -r '.data.alternate_greetings[0]' ${args.stagedCardPath}\`, \`[1]\`, \`[2]\` (two or three samples are enough to capture range; you do not need all of them)
- If \`character_book.entries > 0\`, sample a few for lore signal: \`jq -r '.data.character_book.entries[0:3]' ${args.stagedCardPath}\`
- For nested structures, use compact output: add \`-c\` to jq, e.g. \`jq -rc '.data.extensions'\`
- If a single field is very large, slice it: \`jq -r '.data.description' ${args.stagedCardPath} | head -c 8000\` (then \`tail -c +8001\` for the next chunk if needed)

Run these as PARALLEL Bash calls where you can, to save round-trips.

If \`jq\` is not installed, fall back to \`python3 -c\` with \`json.load\`; do not read the raw file.`
    : `The full card is inlined below (${cardSizeBytes} bytes, under the ${threshold}-byte budget for this window). No read call needed.

<staged_card>
${cardJson}
</staged_card>

The card is also at \`${args.stagedCardPath}\` if you want to reference it from a Bash command later.`

  return `${PROCESS_PROMPT_PREFIX}${command}.

${cardAccessSection}

Your job is to process this card into a focused persona file and SAVE IT TO DISK using the \`write\` tool. Do NOT just print the result — you must call \`write\`.

REQUIRED ACTIONS for this turn (in order):
1. Gather the persona-relevant card content (inline above for small cards, or via the jq calls listed above for large ones).
2. If the card is multi-character or genuinely ambiguous, ASK THE USER AND STOP — end your turn with the question and write nothing. Triggers:
   - Multi-character cards (multiple personas in description, mes_example has 2+ speakers, character_book has many entries) — ask which persona to extract.
   - Vague or contradictory personality signals — ask which interpretation to favor.
   - Sandbox/world cards (JSON-encoded meta_lore, etc.) — ask which named character or facet to lift.
   For single-character cards with clear personality, no questions needed — just proceed. Do not ask a question and then write a file anyway; the write commits the answer before the user has given one.
3. Synthesize the persona body per the EXTRACTION GUIDELINES below.
4. Use the \`write\` tool TWICE, with the SAME content:
   - Write to ${args.libraryPersonaPath} (library cache — so re-selecting this card later needs no second extraction)
   - Write to ${args.activePersonaPath} (the ACTIVE persona — this is the file the extension reads to build the system-prompt block)
5. Reply with a one-line confirmation: "Active persona: ${args.cardName} — <one-sentence flavor>". Do NOT print the persona body back — the user can run /${command} show, or open the file.

If you skip step 4 (the write calls), the persona will not activate and the user's request fails. The write calls are MANDATORY. The active persona takes effect on the NEXT turn, not this one.

---

EXTRACTION GUIDELINES:

${EXTRACTION_PROMPT}`
}
