/**
 * The audit rung's progress signal, read off the workspace instead of off
 * tool-result wording.
 *
 * `hasStateChange` counts a bash result as progress only when its text holds a
 * CHANGE_WORDS word. Measured on a 50-iteration unattended run (2026-11-01,
 * `context/pi-1.4-audit-2026-10-31.md` §9): the model made 77 tool calls in the
 * audit window, every one `bash`, and committed a test batch every iteration —
 * files written through bash, `git commit -q` (silent), rtk reporting `ok`. No
 * result held a change word, and the rung fired twice on a run that was
 * committing every turn.
 *
 * The fix fingerprints the workspace at the end of each iteration (HEAD, the
 * porcelain status, and the tracked diff) and counts a changed fingerprint as
 * progress. These cases run the real probe against a real git repository, so
 * the script is under test, not a stub of it:
 *
 *   commit every turn, results say only "ok"     → no audit   (the bug)
 *   edit a tracked file every turn, no commit    → no audit
 *   nothing changes                              → audit on 8 (control)
 *   only the loop's own tracked log changes      → audit on 8 (the loop
 *                                                  appends to it every turn;
 *                                                  the model's `git add -A`
 *                                                  had committed it)
 *   not a git repository                         → audit on 8 (old behaviour)
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { LOG_FILE } from "../src/loop-log.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const AUDIT = /no concrete progress for 8 iterations/;

/** pi's `execCommand`, reduced to what the module relies on: cwd, timeout, the result shape. */
function realExec(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = options.timeout
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGTERM");
        }, options.timeout)
      : undefined;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, killed });
    });
  });
}

function makeHost(cwd: string) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage() {},
    exec: (cmd: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
      realExec(cmd, args, { cwd, ...options }),
    async setModel() {
      return true;
    },
  };

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string) {
        notices.push(String(message));
      },
      setStatus() {},
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32_768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 6_000, contextWindow: 32_768, percent: 18 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  const fire = async (name: string, event: unknown) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };

  return {
    async start(args: string) {
      loopModeExtension(pi as never);
      await command!(args, ctx);
    },
    /** One turn whose only tool output is rtk's terse `ok`, answered differently each time. */
    async turn(i: number) {
      notices.length = 0;
      const message = {
        role: "assistant",
        content: [{ type: "text", text: `Turn ${i}: pinned edge case number ${i * 7 + 3} and the suite is green.` }],
        stopReason: "stop",
        usage: { output: 40 },
      };
      await fire("message_end", { message });
      await fire("tool_result", { toolName: "bash", content: [{ type: "text", text: `ok\n${i}` }] });
      await fire("agent_end", { messages: [message] });
      return notices.join(" | ");
    },
    async stop() {
      await command!("stop", ctx);
    },
  };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-workspace-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const origin = process.cwd();
const made: string[] = [];

/**
 * `LOG_FILE` is relative to the PROCESS cwd, which in pi is the directory the
 * loop runs on. Run each case from inside its workspace so the log lands where
 * a real run puts it.
 */
function enter(dir: string): string {
  made.push(dir);
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  process.chdir(origin);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runTurns(dir: string, turns: number, between: (i: number) => void): Promise<string[]> {
  const host = makeHost(dir);
  await host.start("start build the converter");
  const notices: string[] = [];
  for (let i = 1; i <= turns; i++) {
    between(i);
    notices.push(await host.turn(i));
  }
  await host.stop();
  return notices;
}

describe("the audit rung reads progress off the workspace", () => {
  it("does not fire on a run that commits every turn while its results only say ok", async () => {
    const dir = enter(makeRepo());
    const notices = await runTurns(dir, 10, (i) => {
      writeFileSync(join(dir, `t${i}.txt`), `${i}\n`);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", `t${i}`);
    });
    assert.deepEqual(notices.filter((n) => AUDIT.test(n)), [], notices.join("\n"));
  });

  it("does not fire when a tracked file is edited every turn without a commit", async () => {
    const dir = enter(makeRepo());
    const notices = await runTurns(dir, 10, (i) => writeFileSync(join(dir, "a.txt"), `a\n${"x".repeat(i)}\n`));
    assert.deepEqual(notices.filter((n) => AUDIT.test(n)), [], notices.join("\n"));
  });

  it("control: fires on the eighth turn when nothing changes", async () => {
    const dir = enter(makeRepo());
    const notices = await runTurns(dir, 8, () => {});
    assert.match(notices[7], AUDIT);
    assert.equal(notices.slice(0, 7).filter((n) => AUDIT.test(n)).length, 0);
  });

  it("does not count the loop's own log as progress, even when it is tracked", async () => {
    const dir = enter(makeRepo());
    writeFileSync(join(dir, LOG_FILE), "");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "the model's git add -A took the loop log");
    const notices = await runTurns(dir, 8, () => {});
    assert.match(notices[7], AUDIT);
  });

  it("falls back to the result wording outside a git repository", async () => {
    const dir = enter(mkdtempSync(join(tmpdir(), "loop-nogit-")));
    const notices = await runTurns(dir, 8, (i) => writeFileSync(join(dir, `t${i}.txt`), `${i}\n`));
    assert.match(notices[7], AUDIT);
  });
});
