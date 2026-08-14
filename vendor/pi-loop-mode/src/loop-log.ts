import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";

export const LOG_FILE = ".pi-loop-log.jsonl";
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface LoopLogEntry {
  ts: string;
  iteration: number;
  event: string;
  model?: string;
  score?: number;
  checkPassed?: boolean;
  stuckStreak?: number;
  notice?: string;
  [key: string]: unknown;
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function readBoundedTail(file: string, maxBytes: number): string {
  const size = fileSize(file);
  if (size === 0) return "";
  if (size <= maxBytes) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  const bytes = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(bytes);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    readSync(descriptor, buffer, 0, bytes, size - bytes);
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const tail = buffer.toString("utf8");
  const firstNewline = tail.indexOf("\n");
  return firstNewline >= 0 ? tail.slice(firstNewline + 1) : "";
}

function rotateLog(file: string, maxBytes: number): void {
  const backup = `${file}.1`;
  rmSync(backup, { force: true });
  if (fileSize(file) <= maxBytes) {
    renameSync(file, backup);
    return;
  }
  writeFileSync(backup, readBoundedTail(file, maxBytes));
  truncateSync(file, 0);
}

export function appendLogEntry(file: string, entry: LoopLogEntry, maxBytes = MAX_LOG_BYTES): void {
  try {
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > maxBytes) return;
    const size = fileSize(file);
    if (size > 0 && size + lineBytes > maxBytes) rotateLog(file, maxBytes);
    appendFileSync(file, line);
  } catch {
    // Logging must never break the loop.
  }
}

function parseEntries(raw: string): LoopLogEntry[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LoopLogEntry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is LoopLogEntry => Boolean(entry));
}

export function readLogEntries(file: string, maxBytes = MAX_LOG_BYTES): LoopLogEntry[] {
  return [...parseEntries(readBoundedTail(`${file}.1`, maxBytes)), ...parseEntries(readBoundedTail(file, maxBytes))];
}

export function formatLoopStats(all: LoopLogEntry[], startTime: number, file = LOG_FILE): string {
  if (all.length === 0) return `No loop log found or log is empty (${file}).`;
  const current = startTime > 0 ? all.filter((entry) => Date.parse(entry.ts) >= startTime) : [];
  const scope = current.length > 0 ? current : all;
  const label = current.length > 0 ? "current run" : "all runs";
  const counts = new Map<string, number>();
  for (const entry of scope) counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1);
  const eventSummary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  const scores = scope.map((entry) => entry.score).filter((score): score is number => typeof score === "number");
  const spanMs = Date.parse(scope[scope.length - 1].ts) - Date.parse(scope[0].ts);
  const perHour = spanMs > 60_000 ? ((counts.get("continue") ?? 0) / (spanMs / 3_600_000)).toFixed(1) : "-";
  const interventions =
    (counts.get("stuck") ?? 0) +
    (counts.get("audit") ?? 0) +
    (counts.get("regression") ?? 0) +
    (counts.get("rescue_start") ?? 0) +
    (counts.get("compact") ?? 0);
  return [
    `Loop stats (${label}, ${scope.length} entries, ${file}):`,
    `Events: ${eventSummary}`,
    `Interventions: ${interventions} (rescue ${counts.get("rescue_start") ?? 0}, compact ${counts.get("compact") ?? 0})`,
    `Productive iterations/h: ${perHour}`,
    scores.length > 0 ? `Score: first ${scores[0]}, best ${Math.max(...scores)}, last ${scores[scores.length - 1]}` : "Score: -",
  ].join("\n");
}
