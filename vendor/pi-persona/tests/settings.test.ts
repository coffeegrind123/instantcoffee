import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { DEFAULT_SETTINGS, loadSettings, saveSettings, settingsPath } from "../src/settings.ts"

function root(): string {
  return mkdtempSync(join(tmpdir(), "persona-settings-"))
}

// Defaults are the whole safety story for this package: a fresh install must
// inject no marker and must not silently pick the cheaper block.
test("the defaults are auto immersion and the full block", () => {
  const r = root()
  assert.deepEqual(loadSettings(r, {}), DEFAULT_SETTINGS)
  assert.equal(DEFAULT_SETTINGS.immersionMode, "auto")
  assert.equal(DEFAULT_SETTINGS.promptMode, "full")
  rmSync(r, { recursive: true, force: true })
})

test("settings round-trip through the file", () => {
  const r = root()
  saveSettings(r, { immersionMode: "analysis", promptMode: "lean" })
  assert.deepEqual(loadSettings(r, {}), { immersionMode: "analysis", promptMode: "lean" })
  rmSync(r, { recursive: true, force: true })
})

// A corrupt settings file must not be the reason a session has no persona.
test("an unparseable file degrades to defaults instead of throwing", () => {
  const r = root()
  writeFileSync(settingsPath(r), "{ not json", "utf8")
  assert.deepEqual(loadSettings(r, {}), DEFAULT_SETTINGS)
  rmSync(r, { recursive: true, force: true })
})

test("unknown values in the file are ignored, known ones beside them are kept", () => {
  const r = root()
  writeFileSync(
    settingsPath(r),
    JSON.stringify({ immersionMode: "loud", promptMode: "lean", extra: 1 }),
    "utf8",
  )
  assert.deepEqual(loadSettings(r, {}), { immersionMode: "auto", promptMode: "lean" })
  rmSync(r, { recursive: true, force: true })
})

// The rest of this stack is driven from .env for one launch at a time; a knob
// that can only be set by editing persisted state is a knob that outlives the
// experiment it was set for.
test("the environment wins over the file", () => {
  const r = root()
  saveSettings(r, { immersionMode: "off", promptMode: "full" })
  const s = loadSettings(r, { PERSONA_IMMERSION: "immersion", PERSONA_PROMPT_MODE: "lean" })
  assert.deepEqual(s, { immersionMode: "immersion", promptMode: "lean" })
  // and does not rewrite the file
  assert.deepEqual(loadSettings(r, {}), { immersionMode: "off", promptMode: "full" })
  rmSync(r, { recursive: true, force: true })
})

test("a nonsense environment value is ignored rather than obeyed", () => {
  const r = root()
  const s = loadSettings(r, { PERSONA_IMMERSION: "yes", PERSONA_PROMPT_MODE: "big" })
  assert.deepEqual(s, DEFAULT_SETTINGS)
  rmSync(r, { recursive: true, force: true })
})
