/**
 * compaction-anchor.ts — Forge fork. May the task anchor be steered in?
 *
 * `session.steer()` is not a way to put text in a context. It is a way to put
 * text in a context AND get an answer to it: pi drains the steering queue at the
 * top of its agent loop, and when the loop has already finished it RESTARTS it
 * precisely because the queue is not empty —
 *
 *   AgentSession._handlePostAgentRun   agent-session.js:781
 *       return this.agent.hasQueuedMessages();
 *   AgentSession._runAgentPrompt       :744
 *       while (await this._handlePostAgentRun()) await this.agent.continue();
 *   Agent.continue                     agent.js:236
 *       last message is assistant → drain the steering queue → runPromptMessages
 *
 * — and pi's only two auto-compaction call sites are BOTH outside that loop:
 * `_handlePostAgentRun()` (`:776`), which runs after `agent.prompt()` has
 * resolved, and `prompt()` (`:865`), which runs before the next run starts.
 *
 * So the anchor fired from `onCompaction` behaved in two completely different
 * ways depending on which of them it came from, and nothing distinguished them.
 * From `prompt()` it rides on the prompt that is about to run, which is what it
 * is for. From `_handlePostAgentRun()` it manufactures a whole extra turn — one
 * more model call on the single llama slot the parent is blocked on — and the
 * reply to that turn becomes the child's answer, because `collectResponseText`
 * takes the run's last message. Measured against the shipped
 * `runSessionPrompt`: a child that had answered handed its parent "Understood —
 * nothing further to add."
 *
 * That is T1's and V6's argument for the OTHER steer in this package — "there is
 * no wrap-up to ask for, and asking manufactures a turn" — applied to the one
 * nobody had asked it about.
 *
 * The predicate lives here, imports nothing, and is therefore testable; the
 * runner reports the fact and the manager acts on it. See Z2 in
 * `context/design/subagents-loop-verifier-answers.md`.
 */

/** The slice of CompactionInfo this reads. Duck-typed so the module imports nothing. */
export interface CompactionLike {
  /** The run's agent loop had already emitted `agent_end` when this compaction happened. */
  afterRun?: boolean;
  /** pi is going to re-run the interrupted turn itself. */
  willRetry?: boolean;
}

/**
 * True when a steer sent now joins a turn that was going to happen anyway.
 *
 * `willRetry` is the one exception to `afterRun`, and it is the same rule rather
 * than a carve-out: pi has decided to re-run the interrupted turn, so the queue
 * is drained by a continuation the anchor did not cause.
 */
export function anchorReachesATurn(info: CompactionLike): boolean {
  return info.afterRun !== true || info.willRetry === true;
}
