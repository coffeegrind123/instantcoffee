/**
 * renderer.ts — Rendering helpers for the Agent tool and subagent-result messages.
 *
 * Extracted from index.ts to separate display concerns from extension wiring.
 */

import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "./types.js";
import type { AgentVerification } from "../types.js";
import type { SubagentEntry } from "../agents/transcript-entry.ts";
import { buildStatsParts, formatMs, getDisplayName, buildModelThinkingTag, resolveModelLabel } from "./format.js";
import { verificationBadge } from "./verification-badge.js";

/**
 * Forge fork: the verifier's verdict as a trailing marker on a result header.
 *
 * `details.verification` is written by buildAgentDetails for every checked
 * answer and was, until this, read by nothing — so a transcript showed the same
 * line whether the answer had been checked and passed or never checked at all.
 * Empty string when there is no verdict: absence means the verifier did not
 * run, and a marker for that would restore the ambiguity.
 */
function verificationSuffix(d: Record<string, unknown> | undefined, theme: Theme): string {
  const badge = verificationBadge(d?.verification as AgentVerification | undefined);
  if (!badge) return "";
  return ` ${theme.fg(badge.tone, `${badge.icon} ${badge.label}`)}`;
}

// --- Stats rendering helpers ---

/** Format agent display name with optional model/thinking level: "Agent (mimo-v2.5-pro · high)" or "Agent". */
export function agentNameLabel(
  d: Record<string, unknown>,
  theme: Theme,
  modelDisplayStyle: "id" | "name" = "id",
): string {
  const typeName = getDisplayName((d.type as string) || "");
  const modelLabel = resolveModelLabel(
    modelDisplayStyle,
    d.modelName as string | undefined,
    d.modelId as string | undefined,
  );
  const thinkingLevel = d.thinkingLevel as string | undefined;
  const tag = buildModelThinkingTag(modelLabel, thinkingLevel);
  return tag ? `${theme.bold(typeName)} ${theme.fg("dim", tag)}` : theme.bold(typeName);
}

export function buildStatsLine(d: Record<string, unknown>, theme: Theme, showCost: boolean): string {
  const parts = buildStatsParts(
    {
      toolUses: (d.toolUses as number) ?? 0,
      turnCount: d.turnCount as number | undefined,
      maxTurns: d.maxTurns as number | undefined,
      input: (d.input as number) ?? 0,
      output: (d.output as number) ?? 0,
      contextPercent: d.contextPercent as number | null,
      compactions: (d.compactions as number) ?? 0,
      cost: showCost ? (d.cost as number | undefined) : undefined,
    },
    theme,
  );
  parts.push(formatMs(d.durationMs as number));
  return parts.join("·");
}

// --- Agent tool renderers ---

/** Render the Agent tool call line (e.g., "▸ Agent (model)"). */
export function renderAgentToolCall(args: Record<string, unknown>, theme: Theme): Text {
  const typeName = getDisplayName((args.agent as string) || "");
  const label = typeName || "Agent";
  let text = `▸ ${theme.fg("accent", theme.bold(label))}`;

  const modelOverride = args._modelOverride as string | undefined;
  if (modelOverride) {
    text += ` (${modelOverride})`;
  }

  return new Text(text, 0, 0);
}

export function renderAgentToolResult(
  result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
  modelDisplayStyle: "id" | "name" = "id",
): Text {
  const { expanded } = options;
  const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
  const d = result.details;
  const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const desc = (d?.description as string) || "";

  if (d && d.turnCount != null) {
    const namePart = agentNameLabel(d, theme, modelDisplayStyle);
    const statsLine = buildStatsLine(d, theme, showCost);
    let lines = `${icon} ${namePart}·${statsLine}${verificationSuffix(d, theme)}\n  ${theme.fg("text", desc)}`;
    if (expanded && text) {
      lines +=
        "\n" +
        text
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n");
    }
    return new Text(lines, 0, 0);
  }

  // Minimal card — background spawns (no stats) use space placeholder.
  // `details.background` is the reliable signal; the text tests are kept as a
  // fallback for results that predate it. On their own they were wrong: the
  // spawn message reads "[Agent running] Success! You delegated…", which
  // contains neither phrase, so every background spawn drew a success tick the
  // instant it started.
  const isBackground =
    d?.background === true || text.includes("running in background") || text.includes("queued");
  const prefix = isBackground ? "  " : `${icon} `;
  if (desc) {
    return new Text(`${prefix}${theme.fg("text", desc)}`, 0, 0);
  }

  return new Text(`${prefix}${theme.fg("dim", text)}`, 0, 0);
}

// --- Message renderer — subagent-result ---

/** Render a subagent-result message injected after background agent completion. */
export function renderSubagentResult(
  message: { content?: string; details?: Record<string, unknown> },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
  modelDisplayStyle: "id" | "name" = "id",
  hide = false,
): Container {
  const { expanded } = options;
  if (hide) return new Container();

  const d = message.details;
  const text = (message.content as string)?.trim() || "";

  const inner = new Container();
  inner.addChild(new Text(theme.fg("customMessageLabel", "Subagent Result"), 0, 0));
  inner.addChild(new Spacer(1));

  if (d && d.turnCount != null) {
    const isError = d.status === "error" || d.status === "aborted" || d.status === "stopped";
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

    const namePart = agentNameLabel(d, theme, modelDisplayStyle);
    const statsLine = buildStatsLine(d, theme, showCost);
    let headerLine = `${icon} ${namePart}·${statsLine}${verificationSuffix(d, theme)}\n  ${theme.fg("text", (d.description as string) || "")}`;
    if (d.outputFile as string) {
      headerLine += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
    }
    if (d.worktreePath as string) {
      headerLine += `\n  ${theme.fg("dim", `worktree: ${d.worktreePath}`)}`;
    }
    inner.addChild(new Text(headerLine, 0, 0));

    if (expanded && text) {
      inner.addChild(new Spacer(1));
      inner.addChild(
        new Text(
          text
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
          0,
          0,
        ),
      );
    }
  } else {
    inner.addChild(new Text(buildFallbackResultLine(d, theme, modelDisplayStyle), 0, 0));
  }

  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(inner);

  const outer = new Container();
  outer.addChild(new Spacer(1));
  outer.addChild(box);
  outer.addChild(new Spacer(1));
  return outer;
}

function buildFallbackResultLine(
  d: Record<string, unknown> | undefined,
  theme: Theme,
  modelDisplayStyle: "id" | "name" = "id",
): string {
  const icon = theme.fg("success", "✓");
  let line = icon;
  if (d?.type) {
    line += ` ${agentNameLabel(d, theme, modelDisplayStyle)}`;
  }
  line += verificationSuffix(d, theme);
  const desc = (d?.description as string) || "";
  if (desc) line += `\n  ${theme.fg("text", desc)}`;
  if (d?.outputFile) {
    line += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
  }
  if (d?.worktreePath) {
    line += `\n  ${theme.fg("dim", `worktree: ${d.worktreePath}`)}`;
  }
  return line;
}

// --- Entry renderer — a subagent's own turns in the operator's transcript ---

/** How many lines a collapsed transcript entry shows. */
export const TRANSCRIPT_COLLAPSED_LINES = 8;

const PHASE_LABEL: Record<SubagentEntry["phase"], string> = {
  brief: "task",
  turn: "turn",
  verify: "check",
  repair: "repair",
  done: "done",
  capped: "capped",
};

/**
 * One entry of a subagent's transcript.
 *
 * Forge fork, twentieth pass. Deliberately quiet: this is a record, not an
 * event, and it sits between the operator's own turns. The header names the
 * agent the way `/agents` and the widget already do — short id, then type — so
 * three interleaved delegations can be told apart by eye without a second
 * vocabulary. Collapsed to `TRANSCRIPT_COLLAPSED_LINES`; ctrl+o expands, which
 * is the same key that expands a tool result.
 */
export function renderSubagentEntry(
  data: SubagentEntry | undefined,
  options: { expanded?: boolean },
  theme: Theme,
): Container {
  const entry = data ?? { agentId: "", shortId: "?", agentType: "agent", phase: "turn" as const, lines: [] };
  const box = new Container();
  const phase = PHASE_LABEL[entry.phase] ?? entry.phase;
  const turn = entry.phase === "turn" && entry.turn ? ` ${entry.turn}` : "";
  const head =
    `${theme.fg("dim", "subagent")} ${theme.fg("accent", entry.shortId)} ` +
    `${theme.fg("dim", getDisplayName(entry.agentType) || entry.agentType)} ` +
    `${theme.fg("dim", `· ${phase}${turn}`)}`;
  box.addChild(new Text(head, 0, 0));
  if (entry.description) box.addChild(new Text(`  ${theme.fg("text", entry.description)}`, 0, 0));

  const lines = entry.lines ?? [];
  const shown = options.expanded ? lines : lines.slice(0, TRANSCRIPT_COLLAPSED_LINES);
  for (const line of shown) box.addChild(new Text(`  ${theme.fg("dim", line)}`, 0, 0));

  const hidden = lines.length - shown.length + (entry.dropped ?? 0);
  if (hidden > 0) {
    box.addChild(new Text(`  ${theme.fg("dim", `… ${hidden} more line(s)`)}`, 0, 0));
  }
  return box;
}
