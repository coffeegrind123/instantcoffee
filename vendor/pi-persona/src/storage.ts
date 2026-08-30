// The persona library on disk, and the one active persona.
//
// Ported from openclaude's src/services/identity/storage.ts. Two deliberate
// departures, both explained in ../FORK.md:
//
//   1. Every function takes an explicit `root`. openclaude calls
//      getClaudeConfigHomeDir() at each site; doing the pi equivalent here would
//      mean importing pi into a module the tests run with bare node. The pi
//      coupling (../extensions/index.ts) resolves `root` once from getAgentDir()
//      and passes it down.
//   2. The active file is PERSONA.md, not IDENTITY.md, and the library lives at
//      <root>/personas/. openclaude's names are kept as READ fallbacks so a
//      library copied from an openclaude install still resolves.

import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type { CharaCardV2, LocalPersonaEntry, PersonaMeta } from "./types.ts"

/** Basename of the active persona file, and of each library entry's copy. */
export const PERSONA_FILE = "PERSONA.md"
/** openclaude's name for the same file. Read, never written. */
export const LEGACY_PERSONA_FILE = "IDENTITY.md"
/** Directory under `root` holding the library. */
export const LIBRARY_DIR = "personas"
/** openclaude's name for the same directory. Read, never written. */
export const LEGACY_LIBRARY_DIR = "identities"

export function getLibraryDir(root: string): string {
  const preferred = join(root, LIBRARY_DIR)
  if (existsSync(preferred)) return preferred
  const legacy = join(root, LEGACY_LIBRARY_DIR)
  if (existsSync(legacy)) return legacy
  return preferred
}

export function getActivePersonaPath(root: string): string {
  return join(root, PERSONA_FILE)
}

/**
 * Where an active persona actually lives right now: PERSONA.md if it exists,
 * else openclaude's IDENTITY.md if THAT exists, else null.
 *
 * Split from getActivePersonaPath deliberately. Reads must find a persona
 * written by openclaude; writes must never create a second name for the same
 * thing, so they always target PERSONA.md.
 */
export function resolveActivePersonaPath(root: string): string | null {
  const preferred = join(root, PERSONA_FILE)
  if (existsSync(preferred)) return preferred
  const legacy = join(root, LEGACY_PERSONA_FILE)
  if (existsSync(legacy)) return legacy
  return null
}

export function ensureLibraryDir(root: string): string {
  const dir = getLibraryDir(root)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function slugify(name: string, content: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "persona"
  const hash = createHash("sha256").update(`${name}\n${content}`).digest("hex").slice(0, 6)
  return `${base}-${hash}`
}

export interface StagedCard {
  slug: string
  dir: string
  cardPath: string
  personaPath: string
  metaPath: string
}

export interface StageOptions {
  sourceUrl?: string
  projectId?: number
  selectedPersona?: string
  avatarUrl?: string
}

export function stageCardForProcessing(
  root: string,
  card: CharaCardV2,
  meta: StageOptions = {},
): StagedCard {
  ensureLibraryDir(root)
  const cardJson = JSON.stringify(card, null, 2)
  const slug = slugify(card.data.name, cardJson)
  const dir = join(getLibraryDir(root), slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const cardPath = join(dir, "card.json")
  const personaPath = join(dir, PERSONA_FILE)
  const metaPath = join(dir, "meta.json")
  writeFileSync(cardPath, cardJson, "utf8")
  const sha256 = createHash("sha256").update(cardJson).digest("hex")
  const payload: PersonaMeta = {
    slug,
    originalName: card.data.name,
    sourceUrl: meta.sourceUrl,
    projectId: meta.projectId,
    processedAt: new Date().toISOString(),
    selectedPersona: meta.selectedPersona,
    sha256,
    avatarUrl: meta.avatarUrl,
  }
  writeFileSync(metaPath, JSON.stringify(payload, null, 2), "utf8")
  return { slug, dir, cardPath, personaPath, metaPath }
}

export function listLocalPersonas(root: string): LocalPersonaEntry[] {
  const dir = getLibraryDir(root)
  if (!existsSync(dir)) return []
  const activeName = getActivePersonaName(root)
  const entries: LocalPersonaEntry[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const cardPath = join(full, "card.json")
    if (!existsSync(cardPath)) continue
    const metaPath = join(full, "meta.json")
    let meta: PersonaMeta | null = null
    try {
      if (existsSync(metaPath)) {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as PersonaMeta
      }
    } catch {
      meta = null
    }
    let personaPath: string | null = null
    for (const candidate of [join(full, PERSONA_FILE), join(full, LEGACY_PERSONA_FILE)]) {
      if (existsSync(candidate)) {
        personaPath = candidate
        break
      }
    }
    const isActive = !!(
      activeName &&
      meta &&
      activeName.toLowerCase() === meta.originalName.toLowerCase()
    )
    entries.push({ slug: name, dir: full, cardPath, personaPath, metaPath, meta, isActive })
  }
  entries.sort((a, b) => (b.meta?.processedAt ?? "").localeCompare(a.meta?.processedAt ?? ""))
  return entries
}

/** Loose card.json files dropped straight into the library directory. */
export function listLooseCardJsonFiles(root: string): string[] {
  const dir = getLibraryDir(root)
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".json")) continue
    const full = join(dir, name)
    try {
      if (statSync(full).isFile()) out.push(full)
    } catch {
      /* ignore */
    }
  }
  return out.sort()
}

/** Remove the active persona. Clears BOTH names, so a legacy file cannot
 *  resurrect a persona the operator just cleared. */
export function clearActive(root: string): boolean {
  let removed = false
  for (const name of [PERSONA_FILE, LEGACY_PERSONA_FILE]) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    try {
      unlinkSync(path)
      removed = true
    } catch {
      /* ignore */
    }
  }
  invalidateNameCache()
  return removed
}

/**
 * The persona's name, read out of the persona file's framing sentence.
 *
 * openclaude matches `/persona of ([A-Za-z][\w'-]{0,40})/i`, which stops at the
 * first non-word character — so "Ada Lovelace" is stored, displayed and
 * interpolated into the whole system-prompt block as "Ada". The sentence the
 * extraction prompt mandates ends the name with a full stop, so the wider form
 * is tried first and the openclaude form is kept as the fallback for a file
 * whose sentence was reworded.
 */
export function parsePersonaName(md: string): string | null {
  const wide = md.match(/persona of ([^.\n]{1,60})\./i)
  if (wide?.[1]) {
    const name = wide[1].trim()
    if (name) return name
  }
  const narrow = md.match(/persona of ([A-Za-z][\w'-]{0,40})/i)
  return narrow?.[1] ?? null
}

let cachedName: { path: string; mtimeMs: number; name: string | null } | null = null

export function invalidateNameCache(): void {
  cachedName = null
}

export function getActivePersonaName(root: string): string | null {
  const path = resolveActivePersonaPath(root)
  if (!path) {
    cachedName = null
    return null
  }
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }
  if (cachedName && cachedName.path === path && cachedName.mtimeMs === mtimeMs) {
    return cachedName.name
  }
  let name: string | null = null
  try {
    name = parsePersonaName(readFileSync(path, "utf8"))
  } catch {
    name = null
  }
  cachedName = { path, mtimeMs, name }
  return name
}

/** The active persona body, trimmed, or null when there is none. */
export function readActivePersona(root: string): string | null {
  const path = resolveActivePersonaPath(root)
  if (!path) return null
  try {
    const md = readFileSync(path, "utf8").trim()
    return md || null
  } catch {
    return null
  }
}

export function readCard(cardPath: string): CharaCardV2 {
  const raw = readFileSync(cardPath, "utf8")
  const json = JSON.parse(raw) as CharaCardV2
  if (!json?.data?.name) {
    throw new Error(`${cardPath} is not a chara_card_v2 card (no data.name)`)
  }
  return json
}
