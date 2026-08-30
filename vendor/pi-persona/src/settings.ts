// Persona settings, persisted next to the library.
//
// A JSON file rather than pi's settings.json: this package is loaded by absolute
// path from a checkout, and writing into pi's own settings would put a key there
// that survives the checkout being deleted. Everything here is also settable per
// launch from the environment, which is how the rest of this stack is driven.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { type ImmersionMode, isImmersionMode } from "./immersion.ts"
import { isPromptMode, type PromptMode } from "./prompt.ts"

export interface PersonaSettings {
  immersionMode: ImmersionMode
  promptMode: PromptMode
}

export const DEFAULT_SETTINGS: PersonaSettings = {
  // `auto` resolves to "no marker" on anything that is not DeepSeek — see
  // immersion.ts. Nothing is injected on this stack unless it is asked for.
  immersionMode: "auto",
  // The faithful port. `lean` is ~1,270 tokens cheaper per turn; FORK.md has
  // both measurements and what lean gives up.
  promptMode: "full",
}

export function settingsPath(root: string): string {
  return join(root, "persona-settings.json")
}

/**
 * Read settings. The environment wins over the file, so an operator can change
 * either for one launch without editing state that then outlives the launch.
 * An unparseable or partial file degrades to defaults rather than throwing —
 * a corrupt settings file must not be the reason a session has no persona.
 */
export function loadSettings(root: string, env: NodeJS.ProcessEnv = process.env): PersonaSettings {
  const out: PersonaSettings = { ...DEFAULT_SETTINGS }
  try {
    const path = settingsPath(root)
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersonaSettings>
      if (typeof raw?.immersionMode === "string" && isImmersionMode(raw.immersionMode)) {
        out.immersionMode = raw.immersionMode
      }
      if (typeof raw?.promptMode === "string" && isPromptMode(raw.promptMode)) {
        out.promptMode = raw.promptMode
      }
    }
  } catch {
    /* defaults */
  }
  const envImmersion = env.PERSONA_IMMERSION
  if (envImmersion && isImmersionMode(envImmersion)) out.immersionMode = envImmersion
  const envPrompt = env.PERSONA_PROMPT_MODE
  if (envPrompt && isPromptMode(envPrompt)) out.promptMode = envPrompt
  return out
}

export function saveSettings(root: string, settings: PersonaSettings): void {
  const path = settingsPath(root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}
