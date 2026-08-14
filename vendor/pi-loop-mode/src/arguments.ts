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

function extractCheckCommand(text: string): { rest: string; checkCommand: string } {
  const match = text.match(/--check(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (!match || match.index === undefined) return { rest: text, checkCommand: "" };
  const checkCommand = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.trim();
  return { rest, checkCommand };
}

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

  const text = kept.join(" ").trim();
  const match = text.match(/^(.*?)(?:\bDone when\b\s*:?\s*)(.*)$/i);
  const description = (match?.[1] ?? text).trim().replace(/[.\s]+$/, "");
  const criteria = (match?.[2] ?? "").trim();
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
