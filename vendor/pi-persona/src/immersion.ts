// Persona immersion-mode marker injection.
//
// Ported from openclaude's src/services/identity/personaImmersion.ts, which
// documents the mechanism this file implements:
//
//   DeepSeek-V4's roleplay training has a thinking-mode control that lives in
//   the FIRST USER MESSAGE, not the system prompt. Without the marker the model
//   routes to "pure analysis" — it stands OUTSIDE the character and deliberates
//   ("should I do this?", "the character would deflect, so..."). With it, the
//   thinking happens IN character. The upstream FAQ is explicit that the
//   instruction belongs "at the end of the first round user message — this is
//   the injection position during training, with the most stable effect".
//   Source: https://github.com/victorchen96/deepseek_v4_rolepaly_instruct
//
// WHAT IS DIFFERENT HERE, and it is the whole point of the `auto` default:
// this stack does not serve DeepSeek. It serves Qwen3.8-27B behind forge, and
// pi reports every model on it under the `forge` provider id. The markers are
// exact strings a specific model was trained on; injected anywhere else they are
// three lines of Chinese instructional text the model has no routing for.
// openclaude's own `auto` mode declines to inject on non-DeepSeek providers for
// that reason, and the port keeps that judgement rather than assuming it
// transfers. `auto` here therefore resolves to "off" unless the live model
// actually looks like DeepSeek, which is checked against ctx.model rather than
// assumed from the provider name.
//
// `immersion` and `analysis` remain selectable by hand — an operator pointing
// this stack at a DeepSeek endpoint, or wanting to measure the markers against
// Qwen, should not have to edit the source to try it. Nothing here is measured
// on this stack; see ../FORK.md.

export type ImmersionMode = "auto" | "immersion" | "analysis" | "off"

export const IMMERSION_MODES: ImmersionMode[] = ["auto", "immersion", "analysis", "off"]

export function isImmersionMode(v: string): v is ImmersionMode {
  return (IMMERSION_MODES as string[]).includes(v)
}

// Verbatim from the upstream documentation. These must NOT be translated,
// reformatted or "cleaned up" — the model is trained on these exact strings,
// and a paraphrase is a different string that routes nowhere.
export const IMMERSION_MARKER = `

【角色沉浸要求】在你的思考过程（<think>标签内）中，请遵守以下规则：
1. 请以角色第一人称进行内心独白，用括号包裹内心活动，例如"（心想：……）"或"(内心OS：……)"
2. 用第一人称描写角色的内心感受，例如"我心想""我觉得""我暗自"等
3. 思考内容应沉浸在角色中，通过内心独白分析剧情和规划回复`

export const ANALYSIS_MARKER = `

【思维模式要求】在你的思考过程（<think>标签内）中，请遵守以下规则：
1. 禁止使用圆括号包裹内心独白，例如"（心想：……）"或"(内心OS：……)"，所有分析内容直接陈述即可
2. 禁止以角色第一人称描写内心活动，例如"我心想""我觉得""我暗自"等，请用分析性语言替代
3. 思考内容应聚焦于剧情走向分析和回复内容规划，不要在思考中进行角色扮演式的内心戏表演`

export interface ModelIdentity {
  id?: string
  provider?: string
  baseUrl?: string
}

/**
 * Whether the live model looks like DeepSeek.
 *
 * Checked against the model id and baseUrl as well as the provider, because on
 * this stack the provider is always `forge` — a proxy in front of llama.cpp —
 * so "provider === 'deepseek'" would be false for a genuinely DeepSeek model
 * served through it, and the auto mode would silently never fire for the one
 * case it exists to serve.
 */
export function looksLikeDeepSeek(model: ModelIdentity | undefined | null): boolean {
  if (!model) return false
  const haystack = [model.provider, model.id, model.baseUrl]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toLowerCase()
  return haystack.includes("deepseek")
}

/**
 * Which marker to inject, or null for none.
 *
 *   off        -> null
 *   no persona -> null   (the marker only makes sense with a character to be)
 *   immersion  -> IMMERSION_MARKER
 *   analysis   -> ANALYSIS_MARKER
 *   auto       -> IMMERSION_MARKER on a DeepSeek-looking model, else null
 */
export function chooseMarker(
  mode: ImmersionMode,
  hasPersona: boolean,
  model: ModelIdentity | undefined | null,
): string | null {
  if (mode === "off") return null
  if (!hasPersona) return null
  if (mode === "immersion") return IMMERSION_MARKER
  if (mode === "analysis") return ANALYSIS_MARKER
  return looksLikeDeepSeek(model) ? IMMERSION_MARKER : null
}

export interface PriorMessage {
  role?: string
  /** pi marks extension-injected and synthetic turns; those are not "the user". */
  synthetic?: boolean
}

/**
 * Whether this is the first user-authored turn of the conversation.
 *
 * The marker's documented position is the end of the first round user message.
 * Anything not authored by a person — tool results, extension-injected messages,
 * custom messages — does not consume the first turn.
 */
export function isFirstUserTurn(prior: readonly PriorMessage[]): boolean {
  for (const m of prior) {
    if (m?.role !== "user") continue
    if (m.synthetic) continue
    return false
  }
  return true
}

/**
 * Append the marker to a user prompt if every gate passes. Safe to call
 * unconditionally.
 *
 * Slash commands are skipped: pi checks extension commands BEFORE the `input`
 * event, but skill commands (`/skill:foo`) and prompt templates (`/template`)
 * are expanded AFTER it, and a marker glued onto the end of `/loop status`
 * becomes part of that command's argument string.
 */
export function maybeAppendMarker(
  text: string,
  prior: readonly PriorMessage[],
  mode: ImmersionMode,
  hasPersona: boolean,
  model: ModelIdentity | undefined | null,
): string {
  if (typeof text !== "string") return text
  if (text.trimStart().startsWith("/")) return text
  if (!isFirstUserTurn(prior)) return text
  const marker = chooseMarker(mode, hasPersona, model)
  if (!marker) return text
  return text + marker
}
