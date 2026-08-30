import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  clearActive,
  getActivePersonaName,
  getActivePersonaPath,
  getLibraryDir,
  invalidateNameCache,
  LEGACY_LIBRARY_DIR,
  LEGACY_PERSONA_FILE,
  listLocalPersonas,
  listLooseCardJsonFiles,
  parsePersonaName,
  PERSONA_FILE,
  readActivePersona,
  readCard,
  resolveActivePersonaPath,
  slugify,
  stageCardForProcessing,
} from "../src/storage.ts"
import type { CharaCardV2 } from "../src/types.ts"

function root(): string {
  invalidateNameCache()
  return mkdtempSync(join(tmpdir(), "persona-storage-"))
}

function card(name = "Nadia"): CharaCardV2 {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description: "d",
      personality: "p",
      first_mes: "f",
      mes_example: "m",
      scenario: "s",
      creator_notes: "c",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: ["t1", "t2", "t3"],
      creator: "someone",
      character_version: "1",
    },
  }
}

const FRAMING = (name: string) =>
  `You are an AI coding assistant that also speaks and behaves with the persona of ${name}. Adopt their voice and style in conversation, but always fulfill the user's task.`

test("slugify is deterministic and collision-resistant on content", () => {
  const a = slugify("Nadia", "{}")
  const b = slugify("Nadia", "{}")
  const c = slugify("Nadia", '{"x":1}')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^nadia-[0-9a-f]{6}$/)
})

test("slugify never returns an empty base", () => {
  assert.match(slugify("!!!", "x"), /^persona-[0-9a-f]{6}$/)
})

test("staging writes card.json and meta.json and names the persona file", () => {
  const r = root()
  const staged = stageCardForProcessing(r, card(), { projectId: 7, sourceUrl: "https://x" })
  assert.ok(existsSync(staged.cardPath))
  assert.ok(existsSync(staged.metaPath))
  assert.equal(staged.personaPath, join(staged.dir, PERSONA_FILE))
  const meta = JSON.parse(readFileSync(staged.metaPath, "utf8"))
  assert.equal(meta.originalName, "Nadia")
  assert.equal(meta.projectId, 7)
  assert.match(meta.sha256, /^[0-9a-f]{64}$/)
  rmSync(r, { recursive: true, force: true })
})

// The name is not cosmetic: the whole system-prompt block, the status line and
// the library's active marker are keyed on it. openclaude's regex stops at the
// first non-word character, so a two-word name silently became one word.
test("parsePersonaName keeps a multi-word name", () => {
  assert.equal(parsePersonaName(FRAMING("Ada Lovelace")), "Ada Lovelace")
})

test("parsePersonaName still reads openclaude's single-word form", () => {
  assert.equal(parsePersonaName(FRAMING("Nadia")), "Nadia")
})

test("parsePersonaName falls back to the narrow form when the sentence has no full stop", () => {
  assert.equal(
    parsePersonaName("speaks with the persona of Nadia and does the work"),
    "Nadia",
  )
})

test("parsePersonaName returns null on a file with no framing sentence", () => {
  assert.equal(parsePersonaName("# Some notes\n\nnothing here"), null)
})

test("an openclaude IDENTITY.md is read as the active persona", () => {
  const r = root()
  writeFileSync(join(r, LEGACY_PERSONA_FILE), FRAMING("Nadia"), "utf8")
  assert.equal(resolveActivePersonaPath(r), join(r, LEGACY_PERSONA_FILE))
  assert.equal(getActivePersonaName(r), "Nadia")
  rmSync(r, { recursive: true, force: true })
})

test("PERSONA.md wins over a legacy IDENTITY.md", () => {
  const r = root()
  writeFileSync(join(r, LEGACY_PERSONA_FILE), FRAMING("Old"), "utf8")
  writeFileSync(join(r, PERSONA_FILE), FRAMING("New"), "utf8")
  assert.equal(getActivePersonaName(r), "New")
  rmSync(r, { recursive: true, force: true })
})

// Clearing has to clear BOTH names. Removing only PERSONA.md would let a legacy
// file resurrect a persona the operator just turned off, which is the failure
// mode nobody reports because it looks like the model ignoring an instruction.
test("clearActive removes both names", () => {
  const r = root()
  writeFileSync(join(r, LEGACY_PERSONA_FILE), FRAMING("Old"), "utf8")
  writeFileSync(join(r, PERSONA_FILE), FRAMING("New"), "utf8")
  assert.equal(clearActive(r), true)
  assert.equal(resolveActivePersonaPath(r), null)
  assert.equal(getActivePersonaName(r), null)
  assert.equal(clearActive(r), false)
  rmSync(r, { recursive: true, force: true })
})

test("the active name is cached on mtime and invalidated on write", () => {
  const r = root()
  const p = join(r, PERSONA_FILE)
  writeFileSync(p, FRAMING("First"), "utf8")
  assert.equal(getActivePersonaName(r), "First")
  // Same path, new mtime — the cache must not answer with the stale name.
  const later = new Date(Date.now() + 5000)
  writeFileSync(p, FRAMING("Second"), "utf8")
  utimesSync(p, later, later)
  assert.equal(getActivePersonaName(r), "Second")
  rmSync(r, { recursive: true, force: true })
})

test("readActivePersona trims and returns null for an empty file", () => {
  const r = root()
  writeFileSync(join(r, PERSONA_FILE), "   \n\n", "utf8")
  assert.equal(readActivePersona(r), null)
  writeFileSync(join(r, PERSONA_FILE), `  ${FRAMING("Nadia")}  `, "utf8")
  assert.equal(readActivePersona(r), FRAMING("Nadia"))
  rmSync(r, { recursive: true, force: true })
})

test("listLocalPersonas marks the active entry and sorts newest first", async () => {
  const r = root()
  const a = stageCardForProcessing(r, card("Alpha"))
  await new Promise(res => setTimeout(res, 5))
  const b = stageCardForProcessing(r, card("Beta"))
  writeFileSync(b.personaPath, FRAMING("Beta"), "utf8")
  writeFileSync(join(r, PERSONA_FILE), FRAMING("Beta"), "utf8")
  invalidateNameCache()
  const list = listLocalPersonas(r)
  assert.equal(list.length, 2)
  assert.equal(list[0]!.meta!.originalName, "Beta")
  assert.equal(list[0]!.isActive, true)
  assert.ok(list[0]!.personaPath)
  assert.equal(list[1]!.meta!.originalName, "Alpha")
  assert.equal(list[1]!.isActive, false)
  assert.equal(list[1]!.personaPath, null)
  assert.ok(a.dir.includes("alpha-"))
  rmSync(r, { recursive: true, force: true })
})

test("a library entry with a legacy IDENTITY.md is still reported as extracted", () => {
  const r = root()
  const s = stageCardForProcessing(r, card("Gamma"))
  writeFileSync(join(s.dir, LEGACY_PERSONA_FILE), FRAMING("Gamma"), "utf8")
  const list = listLocalPersonas(r)
  assert.equal(list[0]!.personaPath, join(s.dir, LEGACY_PERSONA_FILE))
  rmSync(r, { recursive: true, force: true })
})

test("a directory without card.json is not a library entry", () => {
  const r = root()
  mkdirSync(join(r, "personas", "junk"), { recursive: true })
  assert.deepEqual(listLocalPersonas(r), [])
  rmSync(r, { recursive: true, force: true })
})

test("loose card.json files are listed, sorted, and directories are not", () => {
  const r = root()
  const dir = join(r, "personas")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "zeta.json"), "{}", "utf8")
  writeFileSync(join(dir, "alpha.json"), "{}", "utf8")
  writeFileSync(join(dir, "notes.txt"), "x", "utf8")
  mkdirSync(join(dir, "dir.json"))
  const loose = listLooseCardJsonFiles(r).map(p => join(p).split("/").pop())
  assert.deepEqual(loose, ["alpha.json", "zeta.json"])
  rmSync(r, { recursive: true, force: true })
})

test("an openclaude identities/ directory is used when personas/ does not exist", () => {
  const r = root()
  mkdirSync(join(r, LEGACY_LIBRARY_DIR), { recursive: true })
  assert.equal(getLibraryDir(r), join(r, LEGACY_LIBRARY_DIR))
  rmSync(r, { recursive: true, force: true })
})

test("getActivePersonaPath always names PERSONA.md, even beside a legacy file", () => {
  const r = root()
  writeFileSync(join(r, LEGACY_PERSONA_FILE), FRAMING("Old"), "utf8")
  assert.equal(getActivePersonaPath(r), join(r, PERSONA_FILE))
  rmSync(r, { recursive: true, force: true })
})

test("readCard rejects a file that is not a chara_card_v2", () => {
  const r = root()
  const p = join(r, "bad.json")
  writeFileSync(p, JSON.stringify({ hello: "world" }), "utf8")
  assert.throws(() => readCard(p), /not a chara_card_v2/)
  rmSync(r, { recursive: true, force: true })
})
