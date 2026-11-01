/**
 * What Ovis needs from a pi session that it cannot read off disk or off the screen.
 *
 * Ovis (scripts/ovis.sh) shows a pi pane as a chat, built from pi's session file
 * and its screen. Measured 2026-11-01, three things of this stack never reach it:
 *
 *   1. COMMANDS. Ovis lists pi's builtins plus skills and prompts it finds as
 *      files; its own source says extension commands "are runtime-only and are
 *      not listed". Every command this stack adds (/stack, /loop, /agents,
 *      /persona, /prinny, /observe) is an extension command, and its skills and
 *      prompts load from pi-local.sh flags, so the menu showed none of them.
 *      -> `pi.getCommands()` (what pi's own `/` menu shows) is written to
 *         <OVIS_PI_CATALOG_DIR>/<pane>.json, which the Ovis patch in
 *         vendor/ovis-patches/ serves through Ovis's native-catalog seam.
 *
 *   2. NOTIFICATIONS. Most of those commands answer with `ctx.ui.notify`, which
 *      draws on pi's screen and is never saved, so a command run from the chat
 *      came back with nothing. `ctx.ui` is ONE object shared by every extension
 *      (pi's runner.js returns `runner.uiContext` from every context's `ui`), so
 *      wrapping its notify here sees every extension's notices.
 *      -> each is also saved with `pi.appendEntry("ovis-notice", ...)`: a custom
 *         entry, which pi never sends to the model, and which the Ovis patch
 *         shows as a notice in the chat.
 *
 *   3. STATUS. `ctx.ui.setStatus` (the /loop pill, ...) is screen-only too.
 *      -> the joined statuses become the pane's herdr `display_agent` line,
 *         which Ovis shows for the pane and updates live.
 *
 * Also the effort: this stack's model is configured with `reasoning: false`, so
 * pi records `thinkingLevel: "off"` and Ovis showed "off", while forge applies
 * REASONING_EFFORT server-side. pi-local.sh hands the real value over as
 * OVIS_REASONING_EFFORT, and it is saved once per session as an "ovis-meta"
 * entry the Ovis patch prefers.
 *
 * And the session before its first message: pi writes no session file until
 * the session has a user or assistant message (SessionManager._persist), so
 * a command run first (/stack, /persona) existed only in memory and Ovis had
 * nothing to read. Until pi writes the file, a copy of what it holds
 * (`ctx.sessionManager`, which IS pi's session manager) is kept at
 * <OVIS_PI_PREVIEW_DIR>/<the session file's name>, outside pi's sessions
 * directory so pi's own /resume never lists it, and the Ovis patch serves it.
 *
 * Inert outside a herdr pane (HERDR_ENV=1 and HERDR_PANE_ID), and pi-local.sh
 * loads it only there. Every write is best effort: a bridge that fails must
 * never cost the session a notification, a status or a turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const NOTICE_TYPE = "ovis-notice";
export const META_TYPE = "ovis-meta";
export const CATALOG_VERSION = 1;
export const CATALOG_DIR_DEFAULT = "/tmp/ovis/catalog";
export const PREVIEW_DIR_DEFAULT = "/tmp/ovis/preview";
/** How often an unwritten session's preview is refreshed. */
export const PREVIEW_INTERVAL_MS = 1000;
/** herdr metadata source this bridge reports under. */
export const HERDR_SOURCE = "instantcoffee";
/** A status change is reported at most this often; the last one always lands. */
export const STATUS_THROTTLE_MS = 1000;

const WRAPPED = Symbol.for("instantcoffee.ovis-bridge.wrapped");

type Ui = {
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus?: (key: string, text: string | undefined) => void;
  [WRAPPED]?: boolean;
};

type Command = { name: string; description?: string; source: string; sourceInfo?: { path?: string } };

/** The catalog file's rows: what pi's `/` menu holds, minus nothing. */
export function catalogRows(commands: readonly Command[]): { name: string; description: string; source: string; path?: string }[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? "",
    source: command.source,
    ...(command.sourceInfo?.path ? { path: command.sourceInfo.path } : {}),
  }));
}

/** One line for herdr's display_agent: the statuses in the order they were set. */
export function statusLine(statuses: ReadonlyMap<string, string>): string {
  return [...statuses.values()].map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ");
}

export default function ovisBridge(pi: ExtensionAPI): void {
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId) return;

  const dir = process.env.OVIS_PI_CATALOG_DIR || CATALOG_DIR_DEFAULT;
  const previewDir = process.env.OVIS_PI_PREVIEW_DIR || PREVIEW_DIR_DEFAULT;
  const herdr = process.env.HERDR_BIN_PATH;
  const statuses = new Map<string, string>();
  let sessionFile: string | undefined;
  let session: { getHeader?: () => unknown; getEntries?: () => unknown[] } | undefined;
  let previewTimer: ReturnType<typeof setInterval> | undefined;
  let previewWritten: string | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReported: string | undefined;

  const writeCatalog = (): void => {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${paneId}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        version: CATALOG_VERSION,
        pane_id: paneId,
        pid: process.pid,
        session_file: sessionFile ?? null,
        written_at: new Date().toISOString(),
        commands: catalogRows(pi.getCommands() as Command[]),
        statuses: Object.fromEntries(statuses),
      }));
      renameSync(tmp, file);
    } catch {
      // best effort: no catalog only means Ovis lists what it scans
    }
  };

  // Until pi writes the session file. Then the preview goes, and so does the timer.
  const writePreview = (): void => {
    if (!sessionFile || !session) return;
    const file = join(previewDir, basename(sessionFile));
    try {
      if (existsSync(sessionFile)) {
        rmSync(file, { force: true });
        if (previewTimer !== undefined) clearInterval(previewTimer);
        previewTimer = undefined;
        return;
      }
      const lines = [session.getHeader?.(), ...(session.getEntries?.() ?? [])].filter(Boolean).map((entry) => JSON.stringify(entry));
      const text = `${lines.join("\n")}\n`;
      // Only a change is written: every rename is a new inode, Ovis reloads the
      // chat on it, and a notice opened there snapped shut each second (2026-11-01).
      if (text === previewWritten && existsSync(file)) return;
      mkdirSync(previewDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      previewWritten = text;
    } catch {
      // best effort: without it Ovis shows the session from its first message
    }
  };

  const reportStatus = (): void => {
    statusTimer = undefined;
    const line = statusLine(statuses);
    if (!herdr || line === lastReported) return;
    lastReported = line;
    // The pane id goes FIRST: herdr 0.9.3 rejects the documented order
    // (`--source <ID> <PANE_ID>`) with "unknown option: <ID>" (measured 2026-11-01).
    const args = line
      ? ["pane", "report-metadata", paneId, "--source", HERDR_SOURCE, "--display-agent", `pi · ${line}`]
      : ["pane", "report-metadata", paneId, "--source", HERDR_SOURCE, "--clear-display-agent"];
    execFile(herdr, args, { timeout: 5000 }, () => undefined);
  };

  const wrap = (ui: Ui | undefined): void => {
    if (!ui || ui[WRAPPED]) return;
    const notify = typeof ui.notify === "function" ? ui.notify.bind(ui) : undefined;
    const setStatus = typeof ui.setStatus === "function" ? ui.setStatus.bind(ui) : undefined;
    try {
      ui.notify = (message, type) => {
        notify?.(message, type);
        try {
          pi.appendEntry(NOTICE_TYPE, { message: String(message), level: type ?? "info" });
        } catch {
          // a notice that could not be saved still showed on the screen
        }
        writePreview();
      };
      ui.setStatus = (key, text) => {
        setStatus?.(key, text);
        if (text === undefined || text === "") statuses.delete(key);
        else statuses.set(key, text);
        writeCatalog();
        if (statusTimer === undefined) statusTimer = setTimeout(reportStatus, STATUS_THROTTLE_MS);
      };
      ui[WRAPPED] = true;
    } catch {
      // a UI object that refuses new properties stays as pi made it
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    wrap(ctx.ui as Ui);
    try {
      sessionFile = ctx.sessionManager.getSessionFile();
      session = ctx.sessionManager as typeof session;
    } catch {
      sessionFile = undefined;
    }
    const effort = process.env.OVIS_REASONING_EFFORT;
    if (effort) {
      try {
        pi.appendEntry(META_TYPE, { reasoningEffort: effort });
      } catch {
        // Ovis then shows what pi recorded
      }
    }
    writeCatalog();
    previewWritten = undefined;
    writePreview();
    if (previewTimer !== undefined) clearInterval(previewTimer);
    previewTimer = setInterval(writePreview, PREVIEW_INTERVAL_MS);
    previewTimer.unref?.();
  });

  // A session that ends before pi wrote it leaves no preview behind.
  pi.on("session_shutdown", async () => {
    if (previewTimer !== undefined) clearInterval(previewTimer);
    previewTimer = undefined;
    if (sessionFile) rmSync(join(previewDir, basename(sessionFile)), { force: true });
    previewWritten = undefined;
  });

  // pi can replace its UI object (setUIContext); wrap whatever is current.
  pi.on("agent_start", async (_event, ctx) => wrap(ctx.ui as Ui));
}
