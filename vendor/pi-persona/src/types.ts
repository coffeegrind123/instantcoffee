// chara_card_v2 and persona-library shapes.
//
// Ported from openclaude's src/services/chubApi/types.ts and
// src/services/identity/types.ts. Field-for-field, because the card spec is
// somebody else's and paraphrasing it is how a parser starts reading the wrong
// key. See ../FORK.md.

export type SortMode =
  | "underrated"
  | "recent"
  | "trending"
  | "evergreen"
  | "latest"
  | "random"

export interface ChubSearchNode {
  id: number
  name: string
  tagline: string
  description: string
  topics: string[]
  nTokens: number
  nChats: number
  starCount: number
  rating: number
  ratingCount: number
  avatar_url: string
  max_res_url: string
  createdAt: string
  lastActivityAt: string
}

export interface ChubSearchResponse {
  data: {
    nodes: ChubSearchNode[]
    count: number
    page: number
    cursor: string | null
    previous_cursor: string | null
  }
}

export interface CharaCardV2Data {
  name: string
  description: string
  personality: string
  first_mes: string
  mes_example: string
  scenario: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  tags: string[]
  creator: string
  character_version: string
  avatar?: string
  extensions?: {
    chub?: {
      id?: number
      full_path?: string
      expressions?: unknown
      alt_expressions?: Record<string, unknown>
      background_image?: string
      related_lorebooks?: unknown[]
    }
    depth_prompt?: { depth: number; prompt: string }
    [k: string]: unknown
  }
  character_book?: {
    name?: string
    entries?: Array<Record<string, unknown>>
    [k: string]: unknown
  } | null
  [k: string]: unknown
}

export interface CharaCardV2 {
  spec: "chara_card_v2" | string
  spec_version: string
  data: CharaCardV2Data
}

export interface PersonaMeta {
  slug: string
  originalName: string
  sourceUrl?: string
  projectId?: number
  processedAt: string
  selectedPersona?: string
  sha256: string
  /** Source image URL for the card (e.g. a chub avatar), if any. Carried so a
   *  channel that can wear an avatar (vendor/prinny-channel) has one to wear. */
  avatarUrl?: string
}

export interface LocalPersonaEntry {
  slug: string
  dir: string
  cardPath: string
  personaPath: string | null
  metaPath: string
  meta: PersonaMeta | null
  isActive: boolean
}

export type CardSectionKind = "text" | "array" | "json" | "image" | "header"

export interface CardSectionEntry {
  name: string
  content: string
  kind: CardSectionKind
  isEmpty: boolean
  tokenCount: number
}
