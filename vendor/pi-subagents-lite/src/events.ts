import type { AgentRecord } from "./types.js";

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, isKeyRelease } from "@earendil-works/pi-tui";
import { registerAgents, setAgentScanDirs, scanAndMerge } from "./agents/agent-types.js";
import { AgentManager } from "./agents/agent-manager.js";
import { AgentWidget, type UICtx } from "./ui/agent-widget.js";
import { ConversationViewer } from "./ui/conversation-viewer.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { toolCallListener } from "./agents/tool-execution.js";
import { isBusyRecord } from "./agents/record-activity.ts";
import { steerReport } from "./ui/action-report.ts";
import { registerAgentTool } from "./registration.js";
import { SHORT_ID_LENGTH } from "./types.js";
import {
  getManager,
  getWidget,
  getCoordinator,
  getStore,
  setSessionCtx,
  setManager,
  setWidget,
  setCoordinator,
} from "./shell.js";

// --- Config loader — session_start handler logic ---

/** Idempotent — safe to call on every session_start. */
export function ensureManagerAndWidget(): void {
  const currentManager = getManager();
  const currentWidget = getWidget();

  if (!currentManager) {
    // Coordinator needs the manager, so wire onComplete after creating it.
    const newManager = new AgentManager(
      undefined,
      getStore().concurrency as unknown as ConstructorParameters<typeof AgentManager>[1],
      undefined,
    );
    setManager(newManager);
    // Sync the manager as a config side-effect target (concurrency setters call setConcurrency).
    getStore().setDeps({ manager: newManager });

    const coordinator = new SpawnCoordinator(newManager);
    setCoordinator(coordinator);

    newManager.setOnComplete((record) => {
      coordinator.onAgentComplete(record);
      getWidget()?.update();
    });

    // AL5: the widget's 80 ms refresh now stops when there is nothing to draw,
    // so something has to start it again. `startAgent` and `continueSettledAgent`
    // both announce here; `SpawnCoordinator.spawn` also calls `ensureTimer`
    // directly, and both are idempotent.
    newManager.setOnStart(() => {
      const widget = getWidget();
      widget?.ensureTimer();
      widget?.update();
    });
  }

  if (!currentWidget) {
    const newWidget = new AgentWidget(getManager()!, (id: string) => getCoordinator()?.liveView(id));
    setWidget(newWidget);
    // Sync widget as config side-effect target — setDeps re-syncs all display settings from config.
    getStore().setDeps({ widget: newWidget });
  }
}

export async function scanAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  const agentDir = getAgentDir();
  const userAgentDir = path.join(agentDir, "agents");
  const projectTrusted = ctx.isProjectTrusted();
  const sharedAgentDir = projectTrusted ? path.join(ctx.cwd, ".agents", "agents") : "";
  const projectAgentDir = projectTrusted ? path.join(ctx.cwd, ".pi", "agents") : "";

  // Store scan dirs for on-demand discovery (agents added during the session)
  setAgentScanDirs(userAgentDir, projectAgentDir, sharedAgentDir);

  const disableDefaults = getStore().agent.disableDefaultAgents;

  const merged = await scanAndMerge({ disableDefaultAgents: disableDefaults });

  registerAgents(merged, { disableDefaultAgents: disableDefaults });
}

export async function loadConfigAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  // Project config (.pi/subagents-lite.json) loads only in trusted projects,
  // mirroring the .pi/agents scan-dir gate in scanAndRegisterAgents.
  const projectDir = ctx.isProjectTrusted() ? path.join(ctx.cwd, ".pi") : undefined;
  getStore().setProjectDir(projectDir);
  // ConfigStore is authoritative for config + session overrides + widget/manager
  // side effects.
  getStore().reload();
  // AN1: said once, here, because this is the only moment the answer changes and
  // the only channel a TUI operator reads. `config-io.ts` has already written the
  // same fact to the console for a headless run. The next save moves the file
  // aside rather than replacing it — which is worth saying now, not afterwards.
  const unreadable = getStore().globalConfigUnreadable;
  if (unreadable && ctx.ui?.notify) {
    ctx.ui.notify(
      `[subagents] The global config could not be read (${unreadable.error ?? "unreadable"}) — ` +
        "running on defaults. Fix it before changing anything in /agents: the next save keeps the " +
        "old file as <name>.corrupt-<time> and starts fresh.",
      "warning",
    );
  }
  ensureManagerAndWidget();
  await scanAndRegisterAgents(ctx);
}

// --- Event listener setup ---

/** Open the viewer overlay; the viewerOpen flag prevents nav deactivation while open. */
async function openViewer(ctx: ExtensionContext, record: AgentRecord | null): Promise<void> {
  if (!record) return;
  if (!record.execution?.session) return;
  const widget = getWidget();
  if (!widget) return;
  const manager = getManager();

  try {
    widget.setViewerOpen(true);

    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      const viewer = new ConversationViewer(
        tui,
        record.execution.session!,
        record,
        theme,
        done,
        () => manager?.abort(record.id, "user"),
        kb,
        // Forge fork, fifteenth pass (AF2): `steer()` answers with a boolean and
        // this discarded it. `continueSettledAgent` refuses when the record is
        // still settling, has no session, is streaming, or the model's
        // concurrency slot is full — and at this fork's default of 1 that last
        // one is every continuation attempted while any other agent runs. The
        // operator typed a follow-up into the composer, the composer closed, and
        // nothing happened, anywhere, in silence. The `/agents` menu's own steer
        // has always reported it; see src/ui/action-report.ts.
        async (msg: string) => {
          // Never rejects: the viewer calls this without awaiting, and node
          // turns an unhandled rejection from a UI callback into a dead process.
          try {
            const sent = (await manager?.steer(record.id, msg)) === true;
            if (sent) return;
            const report = steerReport(
              false,
              record.id.slice(0, SHORT_ID_LENGTH),
              isBusyRecord(record) ? "steer" : "continue",
            );
            ctx.ui.notify(report.text, report.level);
          } catch (err) {
            ctx.ui.notify(`Steer failed for ${record.id.slice(0, SHORT_ID_LENGTH)}: ${String(err)}`, "error");
          }
        },
      );
      viewer.setModelDisplayStyle(getStore().agent.modelDisplayStyle);
      return viewer;
    });
  } finally {
    widget.setViewerOpen(false);
  }
}

type InputListenerResult = { consume: true } | undefined;

/** Exposed for tests to drive the real handler with a stubbed ctx. */
export function createNavInputHandler(ctx: ExtensionContext): (data: string) => InputListenerResult {
  return (data: string) => {
    const widget = getWidget();

    // Only fire on key press (not release).
    if (isKeyRelease(data)) return undefined;

    // Viewer overlay open — don't consume, don't deactivate.
    if (widget?.isViewerOpen()) {
      return undefined;
    }

    // Editor lost focus (dialog, menu, etc.) — deactivate.
    if (widget && !widget.isEditorFocused()) {
      if (widget.isNavActive()) widget.navDeactivate();
      return undefined;
    }

    if (widget) {
      if (!widget.isNavActive()) {
        // ↓ or ← + empty editor + visible agents exist → activate.
        //
        // ← is here because it is the key Claude Code advertises for the same
        // move ("← for agents"), and because both of the packages that have
        // built this affordance independently — nicobailon's fleet-status and
        // tintinweb's fleet-list — accept both keys. It costs one predicate and
        // is only reachable on an empty editor, where ← has nothing to move
        // over anyway.
        const editorEmpty = (ctx.ui as any).getEditorText?.() === "";
        const activator = matchesKey(data, "down") || matchesKey(data, "left");
        if (activator && widget.hasVisibleAgents() && editorEmpty) {
          widget.navActivate();
          return { consume: true };
        }
      } else {
        if (matchesKey(data, "down")) {
          widget.navDown();
          return { consume: true };
        }
        if (matchesKey(data, "up")) {
          widget.navUp();
          return { consume: true };
        }
        if (matchesKey(data, "escape")) {
          widget.navDeactivate();
          return { consume: true };
        }
        if (matchesKey(data, "enter")) {
          const record = widget.navSelect();
          openViewer(ctx, record).catch((err) => {
            ctx.ui.notify(`Failed to open agent viewer: ${String(err)}`, "error");
          });
          return { consume: true };
        }
        // Any other key → deactivate, pass through.
        widget.navDeactivate();
      }
    }

    // ctrl+o toggles tool expansion — sync compact mode with the new state.
    // Not consumed: pi's built-in handler owns the actual toggle.
    if (matchesKey(data, "ctrl+o")) {
      // Read state after a tick so the built-in handler applies the toggle first.
      setTimeout(() => {
        const ui = ctx.ui as unknown as { getToolsExpanded?: () => boolean };
        const expanded = ui.getToolsExpanded?.();
        if (expanded !== undefined) {
          getStore().notifyToolsExpanded(expanded);
        }
      }, 0);
    }

    return undefined; // Don't consume the input
  };
}

export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("tool_call", toolCallListener);

  pi.on("turn_start", async (_event, ctx) => {
    // Set UI context on first turn
    if (!getWidget()) {
      ensureManagerAndWidget();
    }
    getWidget()?.setUICtx(ctx.ui as unknown as UICtx);
  });

  /**
   * The handle that ends the terminal-input subscription.
   *
   * Forge fork, twenty-first pass (AL7). It was captured and never called: the
   * one thing in this package whose only purpose is to END something, and the
   * package had no reference to it apart from the assignment and the guard that
   * reads it as "already done".
   *
   * It has never leaked, and the reason is a property of the HOST rather than of
   * anything here — measured against pi 0.84.2 rather than assumed:
   * `runtimeHost.setBeforeSessionInvalidate` (`interactive-mode.js:345`) calls
   * `resetExtensionUI()`, whose body reaches `clearExtensionTerminalInputListeners()`
   * (`:1726`), and `teardownCurrent` runs that on every `/new`, `/resume`,
   * `/fork` and import (`agent-session-runtime.js:111`). `stop()` does the same
   * on the way out (`:5425`). So pi unsubscribes for us, every time.
   *
   * Two reasons to call it anyway. The guard below is `!unregisterTerminalInput`,
   * so if pi ever stopped clearing, the symptom would be nav keys that silently
   * stop working after a `/new` — the widget's arrows, Enter into the viewer,
   * Escape — with nothing to report it, because the extension believes it is
   * still subscribed. And a teardown that depends on somebody else's teardown is
   * exactly what this pass is about: `session_shutdown` already disposes the
   * coordinator, the store, the widget and the manager, and this was the fifth
   * thing in the list with no line.
   */
  let unregisterTerminalInput: (() => void) | undefined;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    setSessionCtx(ctx);
    await loadConfigAndRegisterAgents(ctx);
    // Re-register with updated agent type list (now includes user/project agents)
    registerAgentTool(pi);
    // ctrl+o syncs compact mode with tool expansion (push-based, no polling)
    if (ctx.hasUI && !unregisterTerminalInput) {
      unregisterTerminalInput = ctx.ui.onTerminalInput(createNavInputHandler(ctx));
    }
    // Sync compact mode with initial tool expansion state
    getStore().notifyToolsExpanded(false);
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const currentManager = getManager();
    if (currentManager) {
      const records = currentManager.listAgents();
      // Forge fork, fourteenth pass (AE5): `isBusyRecord`. A record whose answer
      // is still being checked reads `completed`, and `mgr.dispose()` two lines
      // down disposes the session a repair is running IN — so the one agent the
      // reload is about to cut off was the one the count left out.
      const active = records.filter(isBusyRecord);
      if (active.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`${active.length} agent(s) killed by reload`, "warning");
      }
    }
    // AL7: ours to end, and ended here. pi clears its own subscription list a
    // moment later (`beforeSessionInvalidate`), so this is idempotent — the
    // handle pi returns unsubscribes and drops the entry, and running it twice
    // is a no-op. Cleared so the guard in `session_start` re-registers.
    try {
      unregisterTerminalInput?.();
    } catch {
      // A teardown is not worth an extension error on the way out.
    }
    unregisterTerminalInput = undefined;
    // Dispose coordinator, store, widget, then manager
    getCoordinator()?.dispose();
    setCoordinator(null);
    getStore().dispose();
    getWidget()?.dispose();
    setWidget(null);
    const mgr = getManager();
    if (mgr) {
      await mgr.dispose();
      setManager(null);
    }
  });
}
