/**
 * agent-id.ts — Forge fork, twenty-fourth pass (AO1). Which record a caller
 * means, when the identifier it was given is not the identifier it was shown.
 *
 * ## The two spellings of one agent
 *
 * An agent id is `randomUUID().slice(0, 17)` — seventeen characters. Every
 * model-facing surface in this package publishes the first EIGHT of it:
 *
 * ```
 *   AgentStatus                 `${record.id.slice(0, SHORT_ID_LENGTH)} (type) status`
 *   the background result       `[Subagent "type" ${id.slice(0, 8)} completed]`
 *   StopAgent's own error       `Running agents: ${short} (type), …`
 *   StopAgent's own success     `Stopped agent ${agentId.slice(0, 8)}`
 * ```
 *
 * and `executeStopAgentTool` looked the answer up with `manager.getRecord(id)`,
 * which is `this.agents.get(id)` — an exact `Map` lookup on the SEVENTEEN.
 *
 * So the tool refused every identifier the model had been shown, and the refusal
 * was the worst part of it: `Agent <id> not found. Running agents: …` hands back
 * a list of eight-character ids, under a helper whose docstring says *"one line,
 * easy for LLM to parse"*. It is easy to parse and impossible to use. A model
 * that reads it and retries gets the identical answer, forever — on a tool whose
 * whole purpose is stopping a run that is holding the one llama slot.
 *
 * Only `run_in_background`'s own success message ever carried the full id
 * (`Agent ID: ${agentId}`), and only for as long as it stayed in the window.
 *
 * ## Why the lookup moved rather than the printers
 *
 * Printing seventeen characters everywhere would fix it and cost the tokens the
 * short form exists to save, on every listing, forever. The published form is
 * the one to keep: eight hex characters of a v4 UUID, unique within any session
 * this manager will ever hold.
 *
 * So the LOOKUP learns the published form, with the ladder this package already
 * uses for the same question one field over — `resolveType` in `agent-types.ts`,
 * which resolves an agent TYPE by exact name, then by a unique case-insensitive
 * match, and reports `ambiguous` rather than picking. The rule there is written
 * as *"Never a silent pick (US-2)"*, and it is the rule here:
 *
 * ```
 *   exact                    → resolved      a full id is never ambiguous
 *   one case-insensitive hit → resolved      a model that upper-cased the hex
 *   one prefix hit           → resolved      the eight characters it was shown
 *   two or more             → ambiguous      say which, never choose
 *   none                     → not-found
 * ```
 *
 * Exact BEFORE prefix matters and is not theoretical: an id is a prefix of
 * itself and of nothing else, but a truncated id could in principle be a prefix
 * of two records, and the full id must resolve to its own record even then.
 *
 * ## Why it imports nothing
 *
 * Same reason as `record-activity.ts`, `status-listing.ts`, `turn-tracking.ts`
 * and `git-failure.ts`: `agent-manager.ts` and `tool-execution.ts` both import
 * pi, so neither can be loaded by `node --experimental-strip-types --test`, and
 * a rule that cannot be driven by the suite is a rule with no control run.
 */

/**
 * What a requested identifier resolved to.
 *
 * `candidates` are canonical ids, in the order the caller listed them, so a
 * message built from it names records the caller can find again.
 */
export type AgentIdResolution =
  | { kind: "resolved"; id: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "not-found" };

/**
 * The record `requested` names, among `known`.
 *
 * `known` is every id the manager holds, in its own order. Nothing here mutates
 * or allocates per candidate beyond the two folded strings.
 */
export function resolveAgentId(requested: unknown, known: Iterable<string>): AgentIdResolution {
  const wanted = typeof requested === "string" ? requested.trim() : "";
  if (wanted === "") return { kind: "not-found" };

  const ids = [...known];
  // Exact first: a full id resolves to its own record even where it is also a
  // prefix of another one.
  if (ids.includes(wanted)) return { kind: "resolved", id: wanted };

  const folded = wanted.toLowerCase();
  const sameName = ids.filter((id) => id.toLowerCase() === folded);
  if (sameName.length === 1) return { kind: "resolved", id: sameName[0]! };
  if (sameName.length > 1) return { kind: "ambiguous", candidates: sameName };

  const prefixed = ids.filter((id) => id.toLowerCase().startsWith(folded));
  if (prefixed.length === 1) return { kind: "resolved", id: prefixed[0]! };
  if (prefixed.length > 1) return { kind: "ambiguous", candidates: prefixed };

  return { kind: "not-found" };
}

/**
 * The shortest prefix length at which every one of `ids` is distinct.
 *
 * Never shorter than `atLeast`, and never longer than the longest id. This is
 * the whole reason `ambiguousAgentIdMessage` is not a one-liner: the candidates
 * of an ambiguity are BY CONSTRUCTION identical at the length that was asked,
 * so printing them at that length says `abcdefgh, abcdefgh` and then asks for
 * more of an id it has not shown. AO1 is a message that names something in a
 * spelling the next call cannot use; a message that names two things in the
 * same spelling is the same mistake with the volume up.
 */
export function distinguishingLength(ids: readonly string[], atLeast = 1): number {
  const longest = ids.reduce((max, id) => Math.max(max, id.length), 0);
  for (let n = Math.max(atLeast, 1); n < longest; n++) {
    if (new Set(ids.map((id) => id.slice(0, n))).size === ids.length) return n;
  }
  return longest;
}

/**
 * What to say when an identifier named more than one record.
 *
 * Built here so the sentence and the resolution stay together, and so the
 * candidates are printed at a length that actually tells them apart — see
 * `distinguishingLength`.
 */
export function ambiguousAgentIdMessage(requested: string, candidates: readonly string[], shortLength: number): string {
  const width = distinguishingLength(candidates, shortLength);
  const shown = candidates.map((id) => id.slice(0, width)).join(", ");
  return `"${requested}" matches ${candidates.length} agents: ${shown}. Use more of the id.`;
}
