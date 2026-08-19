/**
 * n1 — AA1. `before_agent_start` fires from ONE place in pi, and it is not a
 * place the loop can reach.
 *
 * `vendor/pi-loop-mode` registers a `before_agent_start` handler whose whole job
 * is to append the loop's goal and rules to the system prompt. pi emits that
 * event from exactly one call site:
 *
 *   AgentSession.prompt()          agent-session.js:885
 *       const result = await this._extensionRunner.emitBeforeAgentStart(…)
 *       result.systemPrompt !== undefined
 *         → _systemPromptOverride = result.systemPrompt          :902
 *           agent.state.systemPrompt = result.systemPrompt       :903
 *         else
 *           _systemPromptOverride = undefined                    :907
 *           agent.state.systemPrompt = _baseSystemPrompt         :908
 *
 * and the loop delivers every one of its turns through the OTHER entry point:
 *
 *   pi.sendMessage(msg, {triggerTurn:true})
 *     → AgentSession.sendCustomMessage                           :1068
 *     → (idle)  await this._runAgentPrompt(appMessage)           :1090
 *     → (busy)  agent.steer / agent.followUp                     :1083/:1086
 *
 * `_runAgentPrompt` (:744) does not emit the event. So the handler cannot run on
 * a turn the loop drives — which in an unattended run is every turn.
 *
 * The second half is what the run is left holding. `_runAgentPrompt`'s `finally`
 * clears `_systemPromptOverride` (:753) and does NOT restore
 * `agent.state.systemPrompt`, while `_installAgentNextTurnRefresh` (:274) rebuilds
 * every turn AFTER the first from `_systemPromptOverride ?? _baseSystemPrompt`
 * (:286). So a run that did not go through `prompt()`:
 *
 *   turn 1   agent.state.systemPrompt   ← whatever the last prompt() left
 *   turn 2+  _systemPromptOverride ?? _baseSystemPrompt   ← the override is gone
 *
 * i.e. the block appears on the first turn and vanishes on the second, inside
 * one iteration, at the very front of the cached prefix.
 *
 *   node --experimental-strip-types n1-the-system-prompt-no-loop-turn-ever-sees.mjs
 */

import { readFileSync } from "node:fs";

const { makeHost, REPO } = await import("./_host.mjs");
const loopExtension = (await import("../../../vendor/pi-loop-mode/extensions/index.ts")).default;

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";

// ── part 1: the call sites, read out of the shipped pi ───────────────────────

function emitSites() {
  const src = readFileSync(`${PI}/core/agent-session.js`, "utf8").split("\n");
  const hits = [];
  src.forEach((line, i) => {
    if (line.includes("emitBeforeAgentStart(")) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

function runAgentPromptBody() {
  const src = readFileSync(`${PI}/core/agent-session.js`, "utf8").split("\n");
  // _runAgentPrompt starts at :744; print it whole — it is nine lines.
  return src.slice(743, 756).map((l, i) => `  ${744 + i}  ${l.replace(/^ {4}/, "")}`).join("\n");
}

console.log("=".repeat(78));
console.log("pi 0.84.2 — every place `before_agent_start` is emitted");
console.log("=".repeat(78));
for (const hit of emitSites()) console.log(`  agent-session.js:${hit.line}  ${hit.text}`);
console.log(`\n  total call sites: ${emitSites().length}   (and it is inside AgentSession.prompt())`);

console.log(`\n  AgentSession._runAgentPrompt — the path pi.sendMessage takes:\n`);
console.log(runAgentPromptBody());
console.log("\n  No emitBeforeAgentStart. The `finally` clears the override and leaves");
console.log("  agent.state.systemPrompt exactly as the last prompt() set it.\n");

// ── part 2: pi's two entry points, modelled, driving the shipped loop ────────

/**
 * The half of AgentSession that decides which system prompt a turn is sent
 * with. Every line is one of the citations above; nothing here is invented.
 */
function sessionModel() {
  const base = "<base system prompt>";
  let stateSystemPrompt = base; // agent.state.systemPrompt
  let override; // _systemPromptOverride
  let running = false; // _isAgentRunActive  ==  isStreaming  ==  !isIdle
  const steering = [];
  const followUp = [];
  const turns = []; // {via, turn, systemPrompt}

  /** agent-loop.js: turn 1 takes createContextSnapshot(); turns 2+ take prepareNextTurn. */
  const runTurns = async (via, count, onTurn) => {
    running = true;
    try {
      for (let t = 1; t <= count; t++) {
        const systemPrompt = t === 1 ? stateSystemPrompt : (override ?? base); // :286
        turns.push({ via, turn: t, systemPrompt });
        await onTurn?.(t);
      }
      // _handlePostAgentRun → agent.continue() drains steering then follow-ups.
      const queued = [...steering.splice(0), ...followUp.splice(0)];
      for (const msg of queued) {
        turns.push({ via: `${via}+queued`, turn: 1, systemPrompt: override ?? base });
        await msg.onDelivered?.();
      }
    } finally {
      override = undefined; // :753
      running = false;
    }
  };

  return {
    isIdle: () => !running,
    /** AgentSession.prompt() — what a HUMAN types. :792 */
    async prompt(emitBeforeAgentStart, turnCount = 1, onTurn) {
      const result = await emitBeforeAgentStart();
      if (result?.systemPrompt !== undefined) {
        override = result.systemPrompt; // :902
        stateSystemPrompt = result.systemPrompt; // :903
      } else {
        override = undefined; // :907
        stateSystemPrompt = base; // :908
      }
      await runTurns("prompt()", turnCount, onTurn);
    },
    /** AgentSession.sendCustomMessage() — what pi.sendMessage() reaches. :1068 */
    async sendMessage(message, options, turnCount = 1, onTurn) {
      if (options?.deliverAs === "nextTurn") return;
      if (running && options?.triggerTurn !== false) {
        (options?.deliverAs === "followUp" ? followUp : steering).push(message);
        return;
      }
      if (options?.triggerTurn) await runTurns("sendMessage()", turnCount, onTurn); // :1090
    },
    turns,
  };
}

const BLOCK = /Loop mode is active/;

async function scenario(label, body) {
  const host = makeHost({ idle: true });
  loopExtension(host.pi, host.ctx);
  const session = sessionModel();
  host.ctx.isIdle = () => session.isIdle();
  // Every pi.sendMessage the loop makes goes through the model.
  const queue = [];
  host.pi.sendMessage = (m, options) => queue.push({ m, options });
  await body(host, session, queue);
  return { label, turns: session.turns };
}

// _host.mjs keeps its handler map private; reach the handler through fire().
const beforeAgentStart = (host) => async () => {
  const out = await host.fire("before_agent_start", { systemPrompt: "<base system prompt>" });
  return out.filter(Boolean).pop();
};

const rows = [];

rows.push(
  await scenario("an unattended loop: /loop start, then loop turns", async (host, session, queue) => {
    await host.run("start ship the feature --max 4");
    // The loop scheduled its first turn through pi.sendMessage.
    for (let i = 0; i < 2 && queue.length > 0; i++) {
      const { m, options } = queue.shift();
      await session.sendMessage(m, options, 2, async () => {});
      // …and the turn ends, which is where the loop schedules the next one.
      await host.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: `did batch ${i}` }] }] });
    }
    await host.quit();
  }),
);

rows.push(
  await scenario("the operator types once, then the loop carries on", async (host, session, queue) => {
    await host.run("start ship the feature --max 4");
    queue.length = 0;
    // A human types. THIS is the only path that emits before_agent_start.
    await session.prompt(beforeAgentStart(host), 1);
    // Then the loop's own turns resume.
    await host.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "answered" }] }] });
    for (let i = 0; i < 1 && queue.length > 0; i++) {
      const { m, options } = queue.shift();
      await session.sendMessage(m, options, 2, async () => {});
    }
    await host.quit();
  }),
);

console.log("=".repeat(78));
console.log("what system prompt each turn was actually sent with");
console.log("=".repeat(78));
for (const row of rows) {
  console.log(`\n  ${row.label}`);
  if (row.turns.length === 0) console.log("    (no turns)");
  for (const t of row.turns) {
    const has = BLOCK.test(t.systemPrompt) ? "WITH the loop block" : "base prompt only";
    console.log(`    ${String(t.via).padEnd(18)} turn ${t.turn}   ${has}`);
  }
}

console.log(`
  Read the second block downward. The loop's rules reach the model on the turn
  the OPERATOR typed, survive onto the first turn of the next loop-driven run
  because nothing restored agent.state.systemPrompt, and are gone again by that
  run's second turn — a system-prompt change inside one iteration, at offset 0
  of the cached prefix.

  In the first block they never appear at all, which is the unattended case and
  therefore the case the loop exists for.
`);

process.exit(0);
