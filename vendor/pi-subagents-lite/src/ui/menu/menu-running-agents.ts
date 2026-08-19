/**
 * menu-running-agents.ts — Running agents menu concern.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Agent list is a snapshot at construction time (stale until re-entry is acceptable).
 * Selecting an agent opens an actions submenu (SelectList).
 *
 * Exports:
 *   - showRunningAgentsMenu: list running/queued/completed agents
 *   - buildAgentActionsList: per-agent action sub-menu (view result, steer, stop, clear)
 *
 * Private helpers (single-consumer, co-located):
 *   - showConversationViewer: show ConversationViewer for agent snapshot
 *   - showTextViewer: show simple text viewer for result/error
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../types.js";
import { SHORT_ID_LENGTH } from "../../types.js";
import { ConversationViewer } from "../conversation-viewer.js";
import { getDisplayName } from "../format.js";
import { verificationBadgeText } from "../verification-badge.js";
import { SEPARATOR_ID, buildSelectListTheme, createDelegatingComponent, installSeparatorSkip } from "./helpers.js";
import { getManager, getStore } from "../../shell.js";
import type { Theme } from "../types.js";
import { isActiveRecord, isBusyRecord, isVerifyingRecord } from "../../agents/record-activity.ts";
// Forge fork, fifteenth pass (AF2): the sentences the manager's booleans turn
// into. In a module that imports nothing, so they can be tested — this file
// imports pi-tui and the suite cannot load it.
import { bulkReport, clearReport, steerReport, stopReport } from "../action-report.ts";

/**
 * Running or queued — the only non-terminal statuses (ADR-0006: active work is
 * never cleared) — and the two questions next to it.
 *
 * Forge fork: these used to be one local `isActive` here and a different rule
 * inside the widget's `categorizeAgents`, and the difference was a record whose
 * VERIFIER was still running. See `record-activity.ts` for what that cost.
 */
const isActive = (record: AgentRecord): boolean => isActiveRecord(record);
const isVerifying = (record: AgentRecord): boolean => isVerifyingRecord(record);
const isBusy = (record: AgentRecord): boolean => isBusyRecord(record);

async function showConversationViewer(ctx: ExtensionCommandContext, record: AgentRecord): Promise<void> {
  if (!record.execution?.session) return;
  const manager = getManager();

  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => {
      const viewer = new ConversationViewer(
        tui,
        record.execution.session!,
        record,
        theme,
        done,
        () => manager?.abort(record.id, "user"),
        kb,
        // AF2: the viewer discarded this boolean, so an operator's typed
        // follow-up to a settled agent — refused whenever the model's
        // concurrency slot is held, which at this fork's default of 1 is any
        // other agent running — vanished with no line anywhere.
        async (msg: string) => {
          // Never rejects — the viewer does not await it, and an unhandled
          // rejection from a UI callback takes the process with it.
          try {
            const sent = (await manager?.steer(record.id, msg)) === true;
            if (sent) return;
            const report = steerReport(false, record.id.slice(0, SHORT_ID_LENGTH), isActive(record) ? "steer" : "continue");
            ctx.ui.notify(report.text, report.level);
          } catch (err) {
            ctx.ui.notify(`Steer failed for ${record.id.slice(0, SHORT_ID_LENGTH)}: ${String(err)}`, "error");
          }
        },
      );
      viewer.setModelDisplayStyle(getStore().agent.modelDisplayStyle);
      return viewer;
    },
    { overlay: true },
  );
}

async function showTextViewer(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  kind: "result" | "error",
  text: string,
): Promise<void> {
  const titleSuffix = kind === "result" ? record.id.slice(0, SHORT_ID_LENGTH) : "Error";
  const textLines = text.split("\n");
  const displayName = getDisplayName(record.display.type);
  const chromeLines = 5; // top border + title + sep + footer + bottom border
  const MIN_VIEWPORT = 3;
  const VIEWPORT_HEIGHT_PCT = 70;
  let scrollOffset = 0;
  let autoScroll = true;

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      const border = theme.fg("border", "│");

      const viewportHeight = () => {
        const maxRows = Math.floor((tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
        return Math.max(MIN_VIEWPORT, maxRows - chromeLines);
      };

      return {
        invalidate() {},
        render(width: number) {
          const innerW = width - 4;
          const out: string[] = [theme.fg("border", `\u256d${"\u2500".repeat(width - 2)}\u256e`)];

          // Title row: │ name · suffix pad │
          const titleStr = theme.bold(theme.fg("accent", `${displayName} \u00b7 ${titleSuffix}`));
          const titlePad = Math.max(0, innerW - visibleWidth(titleStr));
          out.push(`${border} ${truncateToWidth(titleStr + " ".repeat(titlePad), innerW, "...", true)} ${border}`);

          // Separator
          out.push(`${border} ${theme.fg("dim", "\u2500".repeat(innerW))} ${border}`);

          // Content with scrolling
          const vp = viewportHeight();
          const maxScroll = Math.max(0, textLines.length - vp);
          if (autoScroll) scrollOffset = maxScroll;
          const vs = Math.min(scrollOffset, maxScroll);
          const visible = textLines.slice(vs, vs + vp);

          for (let i = 0; i < vp; i++) {
            const line = visible[i] ?? "";
            const truncated = truncateToWidth(line, innerW, "...", true);
            const padLen = Math.max(0, innerW - visibleWidth(truncated));
            out.push(`${border} ${truncated}${" ".repeat(padLen)} ${border}`);
          }

          // Footer
          const scrollPct = textLines.length <= vp ? "100%" : `${Math.round(((vs + vp) / textLines.length) * 100)}%`;
          const count = theme.fg("dim", `${textLines.length} lines \u00b7 ${scrollPct}`);
          const footerText = theme.fg("dim", "q/Esc close");
          const gap = Math.max(1, innerW - visibleWidth(count) - visibleWidth(footerText));
          out.push(`${border} ${count}${" ".repeat(gap)}${footerText} ${border}`);

          out.push(theme.fg("border", `\u2570${"\u2500".repeat(width - 2)}\u256f`));
          return out;
        },
        handleInput(data: string) {
          if (matchesKey(data, "q") || matchesKey(data, "escape")) {
            done();
            return;
          }

          const vp = viewportHeight();
          const maxScroll = Math.max(0, textLines.length - vp);

          if (matchesKey(data, "up")) {
            scrollOffset = Math.max(0, scrollOffset - 1);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "down")) {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "pageUp")) {
            scrollOffset = Math.max(0, scrollOffset - vp);
            autoScroll = false;
          } else if (matchesKey(data, "pageDown")) {
            scrollOffset = Math.min(maxScroll, scrollOffset + vp);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "home") || data === "g") {
            scrollOffset = 0;
            autoScroll = false;
          } else if (data === "G") {
            scrollOffset = maxScroll;
            autoScroll = true;
          }
        },
      };
    },
    { overlay: true },
  );
}

/**
 * Build a SelectList of actions for a single agent (view result/error/snapshot,
 * steer, stop) for use as a submenu inside a delegating component.
 * @param done — return to the parent agent list (cancel / no actions).
 * @param setActive — swap the delegating component's active child (steer input).
 * @param onClose — close the entire menu (stop).
 */
export function buildAgentActionsList(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  theme: Theme,
  done: () => void,
  setActive: (c: Component) => void,
  onClose: () => void,
): SelectList {
  const items: SelectItem[] = [];
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  const isRunning = isActive(record);
  const hasSession = !!record.execution.session;
  const hasResult = !!record.result && record.result.length > 0;
  const hasError = !!record.error && record.error.length > 0;

  if (record.lifecycle.status === "running" && hasSession) {
    items.push({ value: "view-snapshot", label: "View snapshot" });
  }
  if (hasSession && !isRunning) {
    items.push({ value: "view-conversation", label: "View conversation" });
  }
  if (hasResult) {
    items.push({ value: "view-result", label: "View result" });
  }
  if (hasError) {
    items.push({ value: "view-error", label: "View error" });
  }
  if (isRunning) {
    items.push({ value: "steer", label: "Steer" });
    items.push({ value: "stop", label: "Stop" });
  } else if (isVerifying(record)) {
    // Still no Clear — `removeRecord` disposes the session a repair is running
    // in, and opens the completion gate with "" under a parent that is waiting
    // for the real answer. That is Y1 and it stands.
    //
    // Stop, though, now does something. T5 is closed: `stopAgent` recognises a
    // verifying record and aborts `execution.verifyAbort`, which routes through
    // `verifyAnswer`'s catch — the child's answer goes out annotated as
    // unchecked, the phase clears, and the gate opens. The label says which run
    // is being stopped, because the child's own run has already finished and
    // "Stop" alone would read as a claim about that.
    items.push({ value: "stop", label: "Stop the answer check" });
  } else {
    items.push({ value: "clear", label: "Clear" });
  }

  if (items.length === 0) {
    ctx.ui.notify(`Agent ${shortId} — no actions available`, "info");
    done();
    return new SelectList([], 5, buildSelectListTheme(theme));
  }

  const list = new SelectList(items, 10, buildSelectListTheme(theme));
  list.onSelect = async (item) => {
    if (item.value === "view-snapshot" || item.value === "view-conversation") {
      await showConversationViewer(ctx, record);
    } else if (item.value === "view-result") {
      await showTextViewer(ctx, record, "result", record.result!);
    } else if (item.value === "view-error") {
      await showTextViewer(ctx, record, "error", record.error!);
    } else if (item.value === "steer") {
      // Swap to an inline steer input within the menu context.
      const input = new Input();
      input.setValue("");
      input.onSubmit = async (value) => {
        const trimmed = value.trim();
        if (trimmed) {
          const sent = await getManager()!.steer(record.id, trimmed);
          // The one call site that has always read the boolean; it now says WHY,
          // because on this fork the likeliest reason is a full concurrency slot
          // and the operator can simply wait. See action-report.ts.
          const report = steerReport(sent, shortId, isActive(record) ? "steer" : "continue");
          ctx.ui.notify(report.text, report.level);
        }
        setActive(list);
      };
      input.onEscape = () => setActive(list);
      setActive(input);
    } else if (item.value === "stop") {
      // AF2: the record can settle between the menu being built and this being
      // chosen — which is the normal case, since `/agents` is open exactly while
      // agents are finishing — and `abort()` says so by returning false.
      const verifying = isVerifying(record);
      const stopped = getManager()?.abort(record.id, "user") === true;
      const report = stopReport(stopped, shortId, verifying);
      ctx.ui.notify(report.text, report.level);
      onClose();
    } else if (item.value === "clear") {
      // AF2, and Y1 is why the refusal exists: `clear()` returns false for a
      // record whose answer is still being checked, because `removeRecord`
      // disposes the session a repair is running in.
      const cleared = getManager()?.clear(record.id) === true;
      const report = clearReport(cleared, shortId, isVerifying(record));
      ctx.ui.notify(report.text, report.level);
      onClose();
    }
  };
  list.onCancel = () => done();
  return list;
}

export async function showRunningAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const agents = getManager()?.listAgents() ?? [];
  if (agents.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }
  const running = agents.filter(isActive);
  // `isBusy`, not `isActive`: a record whose verifier is still running is not
  // finished, and both bulk clears used to reach it. See isVerifying.
  const finished = agents.filter((r) => !isBusy(r));
  const completed = agents.filter((r) => r.lifecycle.status === "completed" && !isVerifying(r));

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const buildAgentItems = (): SelectItem[] => {
      const items: SelectItem[] = agents.map((record) => {
        const elapsed = Math.round((Date.now() - record.lifecycle.startedAt) / 1000);
        // A verifying record wears the running glyph, because that is what it is
        // doing \u2014 the status underneath already says `completed` and the row
        // would otherwise claim the wait is over. See isVerifying.
        const statusIcon = isVerifying(record)
          ? "\u25B6"
          : record.lifecycle.status === "running"
            ? "\u25B6"
            : record.lifecycle.status === "completed"
              ? "\u2713"
              : record.lifecycle.status === "queued"
                ? "\u23F3"
                : record.lifecycle.status === "error"
                  ? "\u2717"
                  : "\u2022";
        const statusText = isVerifying(record) ? `${record.lifecycle.status} \u00B7 checking` : record.lifecycle.status;
        const headline = record.display.description ? record.display.description : "";
        const suffix = headline ? ` \u2014 ${headline}` : "";
        // Uncoloured on purpose: this is a SelectList label, which is measured
        // and truncated as plain text; an ANSI sequence in it would be counted
        // as visible width.
        const verdict = verificationBadgeText(record.verification);
        const verdictPart = verdict ? `  ${verdict}` : "";
        return {
          value: record.id,
          label: `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${record.display.type}  ${statusText}${verdictPart}  ${elapsed}s${suffix}`,
        };
      });
      if (running.length > 0) {
        items.push({ value: SEPARATOR_ID, label: " " });
        items.push({ value: "__stop-all", label: `Stop ${running.length} running agent(s)` });
      }
      if (finished.length > 0) {
        // One group: "Clear done" (only when completed agents exist) above "Clear all".
        // completed is always a subset of finished, so the group is [Clear done, Clear all]
        // or [Clear all] — never [Clear done] alone.
        items.push({ value: SEPARATOR_ID, label: " " });
        if (completed.length > 0) {
          items.push({ value: "__clear-done", label: "Clear done" });
        }
        items.push({ value: "__clear-all", label: "Clear all" });
      }
      return items;
    };

    const agentList = new SelectList(buildAgentItems(), 15, buildSelectListTheme(theme));
    // SelectList does not skip __sep__ rows itself; install the same skip
    // mechanism the wrapped menus use.
    installSeparatorSkip(agentList);

    const delegator = createDelegatingComponent(agentList);

    /**
     * Apply a bulk action and report what actually happened.
     *
     * Forge fork, fifteenth pass (AF2). The three bulk actions looped over
     * `running` / `finished` / `completed` — arrays snapshotted before
     * `ctx.ui.custom` opened — discarded every boolean, and reported the
     * SNAPSHOT's length as the number of agents acted on. `/agents` is open
     * exactly while agents are settling, so "Cleared 7 finished agent(s)" could
     * describe six clears and one record that is now having its answer checked
     * and refused (Y1) — which the operator then never looks for again.
     *
     * The target list is re-derived here, at the moment the action is chosen,
     * from the manager rather than from the snapshot.
     */
    const applyBulk = (verb: "Stopped" | "Cleared", select: (record: AgentRecord) => boolean) => {
      const manager = getManager();
      const targets = (manager?.listAgents() ?? []).filter(select);
      let applied = 0;
      for (const record of targets) {
        const ok = verb === "Stopped" ? manager?.abort(record.id, "user") : manager?.clear(record.id);
        if (ok === true) applied++;
      }
      const report = bulkReport(verb, applied, targets.length);
      ctx.ui.notify(report.text, report.level);
    };

    agentList.onSelect = async (item) => {
      if (item.value === "__stop-all") {
        applyBulk("Stopped", isActive);
        done(undefined);
        return;
      }
      if (item.value === "__clear-all") {
        applyBulk("Cleared", (record) => !isBusy(record));
        done(undefined);
        return;
      }
      if (item.value === "__clear-done") {
        applyBulk("Cleared", (record) => record.lifecycle.status === "completed" && !isVerifying(record));
        done(undefined);
        return;
      }
      const record = agents.find((r) => r.id === item.value);
      if (record) {
        const actionsList = buildAgentActionsList(
          ctx,
          record,
          theme,
          () => {
            delegator.setActive(agentList);
          },
          delegator.setActive.bind(delegator),
          () => done(undefined),
        );
        delegator.setActive(actionsList);
      }
    };
    agentList.onCancel = () => done(undefined);

    // Simple title wrapper — SettingsListWrapper doesn't work with delegators
    // because it intercepts onSelect on the wrapper target, not on the active child.
    const sep = "\u2500";
    const title = theme.bold(theme.fg("accent", "Running Agents"));
    return {
      invalidate() {
        delegator.invalidate();
      },
      render(width: number) {
        const lines: string[] = [];
        lines.push(sep.repeat(width));
        lines.push("");
        lines.push("  " + title);
        lines.push("");
        lines.push(...delegator.render(width));
        lines.push("");
        lines.push(sep.repeat(width));
        return lines;
      },
      handleInput(data: string) {
        delegator.handleInput?.(data);
      },
    };
  });
}
