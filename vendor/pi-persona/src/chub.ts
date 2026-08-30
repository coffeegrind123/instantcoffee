// chub.ai gateway client. Ported from openclaude's src/services/chubApi/client.ts.
//
// `fetch` only — no dependency, nothing to install, which is what lets this
// package be loaded by absolute path like every other extension in this repo.
//
// Every call takes an explicit AbortSignal or falls back to a timeout. A hung
// gateway inside a slash command hangs the TUI, and the operator's only clue is
// a cursor that stopped blinking.

import type { CharaCardV2, ChubSearchResponse, SortMode } from "./types.ts"

/** Upstream's public gateway key. Overridable with CHUB_API_KEY. */
const DEFAULT_KEY = "REDACTED-CHUB-KEY"

export const PAGE_SIZE = 8
export const DEFAULT_TIMEOUT_MS = 15_000

export const SORT_MODES: SortMode[] = [
  "trending",
  "recent",
  "underrated",
  "evergreen",
  "latest",
  "random",
]

export const SORT_HINT: Record<SortMode, string> = {
  trending: "top trending this week",
  recent: "newcomer special — recently added",
  underrated: "high AI rating, fewer chats — hidden gems",
  evergreen: "most-chatted classics",
  latest: "newest creations, sorted by created_at",
  random: "surprise me",
}

export function isSortMode(value: string): value is SortMode {
  return (SORT_MODES as string[]).includes(value)
}

function key(): string {
  return process.env.CHUB_API_KEY || DEFAULT_KEY
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const k = key()
  return { "ch-api-key": k, samwise: k, ...extra }
}

export function sortParams(sort: SortMode): string {
  switch (sort) {
    case "trending":
      return "special_mode=trending&include_forks=true"
    case "recent":
      return "special_mode=newcomer&include_forks=true"
    case "underrated":
      return "sort=ai_rating&min_users_chatted=0&min_tokens=500&include_forks=true&max_tokens=2100&nsfl=false&min_ai_rating=90"
    case "evergreen":
      return "sort=chats_user&min_users_chatted=10&min_tokens=500&include_forks=true&max_tokens=1800&nsfl=false"
    case "latest":
      return "sort=created_at&include_forks=true&nsfl=true"
    case "random":
      return "sort=random&min_users_chatted=5&min_tokens=500&include_forks=true&max_tokens=1800&nsfl=false"
  }
}

export interface SearchOptions {
  sort: SortMode
  page?: number
  search?: string
  nsfw?: boolean
  signal?: AbortSignal
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
}

export function buildSearchUrl(opts: SearchOptions): string {
  const params = new URLSearchParams()
  params.set("namespace", "characters")
  params.set("first", String(PAGE_SIZE))
  params.set("page", String(opts.page ?? 1))
  params.set("nsfw", String(opts.nsfw ?? true))
  params.set("min_tags", "3")
  if (opts.search) params.set("search", opts.search)
  return `https://gateway.chub.ai/search?${params.toString()}&${sortParams(opts.sort)}`
}

export async function searchCharacters(opts: SearchOptions): Promise<ChubSearchResponse> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(buildSearchUrl(opts), {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    // A bodyless POST is not the same request. Upstream sends `{}`; so do we.
    body: "{}",
    signal: opts.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(
      `chub search failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
    )
  }
  const json = (await res.json()) as ChubSearchResponse
  if (!json?.data?.nodes) {
    throw new Error(
      `chub search returned unexpected shape: ${JSON.stringify(json).slice(0, 200)}`,
    )
  }
  return json
}

export function buildCardUrl(projectId: number): string {
  return `https://gateway.chub.ai/api/v4/projects/${projectId}/repository/files/card.json/raw?ref=main&response_type=blob`
}

export async function downloadCard(
  projectId: number,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<CharaCardV2> {
  const doFetch = fetchImpl ?? fetch
  const res = await doFetch(buildCardUrl(projectId), {
    method: "GET",
    headers: headers({ "private-token": key() }),
    signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(
      `chub card download failed (${projectId}): ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
    )
  }
  const json = (await res.json()) as CharaCardV2
  if (!json?.data?.name) {
    throw new Error(
      `chub card ${projectId} returned unexpected shape: ${JSON.stringify(json).slice(0, 200)}`,
    )
  }
  return json
}
