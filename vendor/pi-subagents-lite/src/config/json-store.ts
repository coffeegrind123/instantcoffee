/**
 * json-store.ts — Forge fork, twenty-third pass (AN1). What a config file that
 * cannot be parsed means, and what may be done to it afterwards.
 *
 * ## The failure
 *
 * `readGlobalRaw()` was
 *
 * ```js
 *   try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
 *   catch { return {}; }
 * ```
 *
 * — one `catch`, two very different facts. **Absent** is the ordinary state of a
 * fresh install and reads correctly as `{}`. **Malformed** is a file with
 * content in it, and reading it as `{}` says the operator has no settings when
 * what is true is that nobody could read them.
 *
 * That alone is survivable: every value falls back to its default and somebody
 * notices their model pins are gone. What is not survivable is the next line of
 * the same story. `ConfigStore` holds that `{}` as the global layer, and the
 * first `/agents` toggle calls `saveGlobal(this.globalRaw)` — which writes the
 * `{}` plus the one key that was just changed, through a tmp file and a rename,
 * over the only copy of the file. Driven through the real store, with one comma
 * removed from a realistic config:
 *
 * ```
 *   on disk BEFORE                       277 bytes, 6 agent keys, 2 concurrency
 *   effective default model after load   null            (was forge/qwen3.8-27b)
 *   effective concurrency after load     {"default":1}   (was 2, providers too)
 *   on disk AFTER one widget toggle      { "agent": { "showCompletionCards": false } }
 * ```
 *
 * ## The two controls, both in this tree
 *
 * The same package's PROJECT layer already gets this right, deliberately, and
 * `config-io.ts`'s header says so: *"a malformed project file is never
 * overwritten."* `readProjectRaw` returns the literal string `"malformed"`,
 * `layerFor` refuses to hand it out, and `saveProject` warns and returns.
 *
 * And `vendor/prinny-channel/server/src/access.ts` takes the other route for the
 * allowlist, with the reasoning attached:
 *
 * > Quarantine rather than delete: it may be a hand-edit the user wants back,
 * > and starting from defaults beats refusing to run.
 *
 * So one file in this stack refuses to write and another moves the bytes aside,
 * and the two that had neither are the two nobody had written a sentence about.
 *
 * ## Which of the two, and why
 *
 * Quarantine. Refusing to write is right for the project layer, where the file
 * is shared, checked in, and somebody else's to fix; it is wrong for a file that
 * exists only to hold what the operator just typed into a menu, because the
 * menu would then silently stop working — a toggle that flips back is a worse
 * mystery than a file that moved.
 *
 * So: the bytes are renamed to `<file>.corrupt-<timestamp>` before the first
 * write that would have replaced them, and the operator is told the name. The
 * rename happens once per bad file; after it the file is absent, which is a
 * state everything here already handles.
 *
 * ## Never throws
 *
 * A config layer is not worth a session. Every path here returns a value; the
 * caller decides what to say about it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** What a read found. `absent` and `malformed` are the two the old `catch` merged. */
export type LayerStatus = "absent" | "loaded" | "malformed";

export interface LayerRead<T> {
  status: LayerStatus;
  /** Present only for `loaded`. */
  value?: T;
  /** Present only for `malformed`: the parser's own words, for the operator. */
  error?: string;
}

/** True for a JSON object — not an array, not null, not a scalar. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one JSON object from disk, distinguishing absent from malformed.
 *
 * A file that parses to something that is not an object is `malformed` too: a
 * top-level array or `null` is not a config, and reading it as one would put a
 * shape into the layer that every consumer would then have to guard.
 */
export function readJsonObject(file: string): LayerRead<Record<string, unknown>> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "absent" };
    return { status: "malformed", error: `${err}` };
  }
  // An empty or whitespace-only file is what a truncated write or an editor
  // leaves behind. It is not a parse failure worth quarantining — there is
  // nothing in it to keep.
  if (text.trim() === "") return { status: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: "malformed", error: err instanceof Error ? err.message : `${err}` };
  }
  if (!isPlainObject(parsed)) return { status: "malformed", error: "not a JSON object" };
  return { status: "loaded", value: parsed };
}

/** The name a quarantined file takes. Exported so a test and a notice agree on it. */
export function quarantineName(file: string, now: number): string {
  return `${file}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Move a file the reader could not parse out of the way.
 *
 * Returns the new path, or undefined when there was nothing to move or the move
 * failed — in which case the caller writes anyway. Losing an unreadable file is
 * bad; refusing to save the operator's settings because a rename failed is
 * worse, and the notice says which happened.
 */
export function quarantine(file: string, now: number = Date.now()): string | undefined {
  const target = quarantineName(file, now);
  try {
    fs.renameSync(file, target);
    return target;
  } catch {
    return undefined;
  }
}

/** Write JSON atomically: a tmp file beside it, then a rename. */
export function writeJsonAtomic(file: string, value: unknown): { ok: true } | { ok: false; error: string } {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${err}` };
  }
}
