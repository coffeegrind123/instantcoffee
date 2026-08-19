/** Re-check the second audit's F2 and F3 fixes through the real wiring. */
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

// --- F3: effective concurrency slot through ConfigStore -> AgentManager -----
const io = await jiti.import(`${R}/config/config-io.ts`);
const cs = await jiti.import(`${R}/config/config-store.ts`);
const am = await jiti.import(`${R}/agents/agent-manager.ts`);
const store = new cs.ConfigStore();
store.reload();
const mgr = new am.AgentManager(undefined, store.concurrency);
console.log("DEFAULT_CONCURRENCY (config-io) :", JSON.stringify(io.DEFAULT_CONCURRENCY));
console.log("store.concurrency               :", JSON.stringify(store.concurrency));
console.log("effective slot forge/qwen3.8-27b:", JSON.stringify(mgr.getSlot("forge/qwen3.8-27b")));
console.log("manager with NO config at all   :", JSON.stringify(new am.AgentManager().getSlot("x/y")));

// --- F2: does __verifier's own declaration reach the loader decision? -------
const t = await jiti.import(`${R}/agents/agent-types.ts`);
const dr = await jiti.import(`${R}/agents/declared-resources.ts`);
t.registerAgents(new Map(), {});
const own = t.getAgentConfig("__verifier");
const resolved = t.getConfig("__verifier", true, true);
const decided = dr.declaredResources(own, resolved);
console.log("");
console.log("getAgentConfig('__verifier') ext/skills:", own.extensions, "/", own.skills, " tools:", own.tools);
console.log("getConfig('__verifier')      ext/skills:", resolved.extensions, "/", resolved.skills, "  <- still general-purpose's");
console.log("declaredResources()          ext/skills:", decided.extensions, "/", decided.skills, "  <- what the loader uses");
console.log("=> noExtensions:", decided.extensions === false, " additionalExtensionPaths: []:", decided.extensions === false);
console.log("session allowed tools                 :", JSON.stringify(t.resolveSessionAllowedTools({
  registeredTools: t.getToolNamesForType("__verifier"), tools: own.tools,
})));
console.log("__verifier in the Agent tool enum     :", t.getAvailableTypes().includes("__verifier"), "(types:", t.getAvailableTypes().join(",") + ")");

// control: a visible agent is unaffected
const gp = t.getAgentConfig("general-purpose");
console.log("control general-purpose declared ext   :", dr.declaredResources(gp, t.getConfig("general-purpose", true, true)).extensions);

// --- the extra-extension list a child actually gets ------------------------
const dl = await jiti.import(`${R}/agents/subagent-denylist.ts`);
console.log("");
console.log("subagentExtraExtensionPaths()   :", JSON.stringify(dl.subagentExtraExtensionPaths()));
