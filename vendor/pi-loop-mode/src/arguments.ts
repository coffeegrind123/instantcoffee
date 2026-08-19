export interface StartArgs {
  description: string;
  criteria: string;
  maxIterations: number;
  untilDone: boolean;
  delaySeconds: number;
  checkCommand: string;
  checkTimeoutSeconds: number;
  model: string;
  rescueModel: string;
  goalFile: string;
}

/**
 * A double-quoted value may contain escaped quotes: `"grep \"foo\" bar"`.
 *
 * The naive `"([^"]*)"` stopped at the first backslash-quote and handed the loop
 * a truncated command — `grep \` — which then ran, failed, and was reported as a
 * failing goal check. It matters more since the `loop` TOOL landed: that path
 * builds this string with `JSON.stringify`, so every command containing a double
 * quote arrived pre-broken.
 *
 * `(?:[^"\\]|\\.)*` consumes an escape pair as one unit, which is the standard
 * shape and also exactly what `JSON.stringify` produces.
 */
const DOUBLE_QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;

/**
 * Undo only `\"` and `\\`.
 *
 * Deliberately not a general unescape: a Windows path in a check command
 * (`--check "C:\bin\test.exe"`) contains backslashes that are not escapes, and
 * turning `\b` into `b` would break a command that works today.
 */
function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\(["\\])/g, "$1");
}

function extractCheckCommand(text: string): { rest: string; checkCommand: string } {
  const match = text.match(new RegExp(String.raw`--check(?:=|\s+)(?:${DOUBLE_QUOTED}|'([^']*)'|(\S+))`));
  if (!match || match.index === undefined) return { rest: text, checkCommand: "" };
  const raw = match[1] !== undefined ? unescapeDoubleQuoted(match[1]) : (match[2] ?? match[3] ?? "");
  const checkCommand = raw.trim();
  const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.trim();
  return { rest, checkCommand };
}

/**
 * Split a goal into the objective and its completion criteria at "Done when:".
 *
 * Extracted so a caller that already HAS a goal — the `loop` tool, whose schema
 * has a `goal` field — can use it without handing the text to the flag scanner
 * below. See `parseStartArgs`' warning.
 */
export function splitGoal(text: string): { description: string; criteria: string } {
  const match = text.match(/^(.*?)(?:\bDone when\b\s*:?\s*)(.*)$/i);
  return {
    description: (match?.[1] ?? text).trim().replace(/[.\s]+$/, ""),
    criteria: (match?.[2] ?? "").trim(),
  };
}

/**
 * Parse a `/loop` argument line: flags anywhere, and whatever is left is the goal.
 *
 * **This scans the whole string for flags, so never hand it text that came from
 * a structured field.** The `loop` tool used to build a `/loop` line by splicing
 * its `goal` parameter into one and re-parsing it, which made every flag the
 * command accepts reachable from a text field: `--check "<shell>"` (run through
 * `bash -lc` once per iteration, forever), `--model` (switches the operator's
 * session model), `--max`, `--delay`, `--file`, `--until-done`. A goal's own
 * `--check` even won over the tool's declared `check` parameter, because
 * `extractCheckCommand` takes the first match and the goal is spliced in first.
 *
 * The tool now builds a `StartArgs` directly (see `startArgsFromToolParams` in
 * extensions/index.ts) and uses {@link splitGoal}. This function is for the
 * slash command, where a human typing flags is the intent.
 */
export function parseStartArgs(args: string): StartArgs {
  const { rest, checkCommand } = extractCheckCommand(args.trim());
  const tokens = rest.split(/\s+/);
  let maxIterations = 0;
  let untilDone = false;
  let delaySeconds = 0;
  let checkTimeoutSeconds = 120;
  let model = "";
  let rescueModel = "";
  let goalFile = "";
  const kept: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--max" && tokens[i + 1]) {
      maxIterations = Math.max(0, Number.parseInt(tokens[++i], 10) || 0);
    } else if (token.startsWith("--max=")) {
      maxIterations = Math.max(0, Number.parseInt(token.slice("--max=".length), 10) || 0);
    } else if (token === "--delay" && tokens[i + 1]) {
      delaySeconds = Math.max(0, Number.parseInt(tokens[++i], 10) || 0);
    } else if (token.startsWith("--delay=")) {
      delaySeconds = Math.max(0, Number.parseInt(token.slice("--delay=".length), 10) || 0);
    } else if (token === "--rescue-model" && tokens[i + 1]) {
      rescueModel = tokens[++i];
    } else if (token.startsWith("--rescue-model=")) {
      rescueModel = token.slice("--rescue-model=".length);
    } else if (token === "--model" && tokens[i + 1]) {
      model = tokens[++i];
    } else if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
    } else if ((token === "--file" || token === "--goal-file") && tokens[i + 1]) {
      goalFile = tokens[++i];
    } else if (token.startsWith("--file=")) {
      goalFile = token.slice("--file=".length);
      // The alias had only the space form. Every other flag here accepts both,
      // and a `--goal-file=SPEC.md` fell through to `kept` and became part of
      // the GOAL text — so the run's goal read "… --goal-file=SPEC.md" and the
      // spec pointed at GOAL.md, which nobody wrote. V8's shape, one flag over.
    } else if (token.startsWith("--goal-file=")) {
      goalFile = token.slice("--goal-file=".length);
    } else if (token === "--check-timeout" && tokens[i + 1]) {
      checkTimeoutSeconds = Math.max(1, Number.parseInt(tokens[++i], 10) || 120);
    } else if (token.startsWith("--check-timeout=")) {
      checkTimeoutSeconds = Math.max(1, Number.parseInt(token.slice("--check-timeout=".length), 10) || 120);
    } else if (token === "--until-done") {
      untilDone = true;
    } else {
      kept.push(token);
    }
  }

  const { description, criteria } = splitGoal(kept.join(" ").trim());
  return {
    description,
    criteria,
    maxIterations,
    untilDone,
    delaySeconds,
    checkCommand,
    checkTimeoutSeconds,
    model,
    rescueModel,
    goalFile,
  };
}
