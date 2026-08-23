/**
 * notice-buffer.ts — Forge fork, twenty-third pass (AN6). The setup warnings a
 * spawn holds back, and the one place they are let go.
 *
 * ## What is in it
 *
 * `runAgentImpl` cannot notify while it is building a child, and its own comment
 * says why:
 *
 * > Buffer warnings during setup to avoid inserting custom_message entries
 * > between tool_use and tool_result in the session tree (causes Anthropic 400).
 *
 * So five different setup checks write into a buffer instead, and every one of
 * them is a sentence about the agent file the operator just edited:
 *
 * ```
 *   agent "X": both tools and exclude_tools set — tools (whitelist) wins
 *   agent "X": both extensions and exclude_extensions set — extensions wins
 *   Custom prompt file not found: … Falling back to replace mode.
 *   extension "Y" not found in loaded extensions
 *   tool "Z" not found …                      (resolveVisibleTools)
 * ```
 *
 * ## The two ways they were lost
 *
 * **The run throws.** The flush was a bare loop *after* `await
 * runSessionPrompt(...)`, with no `finally` around it, so any rejection took the
 * whole buffer with it — `ABORTED_BEFORE_START` (a parent signal already
 * aborted), a provider fault on the first call, a session that could not bind.
 * The run most likely to have been *caused* by a misconfiguration is exactly the
 * run whose misconfiguration warning was dropped.
 *
 * **There is no UI.** The flush read
 * `if (ctx.ui?.notify) ctx.ui.notify(...) else console.warn(...)`, and pi's
 * `noOpUIContext.notify` is `() => {}` (`extensions/runner.js:92`) — a real
 * function, so the `else` was unreachable and the warnings went nowhere at all
 * under `pi -p`, a cron run, or an unattended `/loop`. That is AC1's rule, and
 * the answer to it is thirty lines away in this same package: `reportDrop` in
 * `spawn/spawn-coordinator.ts` does `console.warn` unconditionally and *then*
 * tries the UI.
 *
 * > A delivery that did not happen is the loudest thing this class can report;
 * > it must not be the quietest.
 *
 * ## Why a module
 *
 * `agent-runner.ts` imports `@earendil-works/pi-coding-agent`, which does not
 * resolve under the bare `node --experimental-strip-types --test` the suite runs
 * on, so nothing in it can be driven by a test. This module imports nothing —
 * the same move `record-teardown.ts`, `nudge-schedule.ts`, `turn-tracking.ts`
 * and `run-answer.ts` each made, and for the same reason.
 */

/** The prefix every line this package writes to the console carries. */
export const NOTICE_PREFIX = "[pi-subagents-lite]";

/** The half of `ExtensionContext` a flush needs. Duck-typed so this imports nothing. */
export interface NoticeTarget {
  ui?: { notify?: (message: string, level: string) => void };
}

/**
 * Setup warnings held until the child's run is over, and released exactly once.
 *
 * `add` is bound so it can be handed straight to a callee expecting a
 * `(msg: string) => void` — which is how all five writers take it.
 */
export class NoticeBuffer {
  private notices: string[] = [];

  readonly add = (message: string): void => {
    this.notices.push(message);
  };

  /** What is held, without releasing it. For tests and for a caller that wants to look. */
  get pending(): readonly string[] {
    return this.notices;
  }

  /**
   * Release everything held, on both channels, and empty the buffer.
   *
   * Both, not one or the other: `console.warn` is the one that exists headless,
   * and the UI is the one an operator is actually looking at. Idempotent — a
   * second call has nothing left to say — so a `finally` and a normal-path call
   * cannot double-report.
   *
   * Never throws. A UI that is going away is the ordinary case on the path this
   * was written for.
   */
  flush(target?: NoticeTarget, log: (line: string) => void = console.warn): void {
    const notices = this.notices;
    this.notices = [];
    for (const message of notices) {
      const line = `${NOTICE_PREFIX} ${message}`;
      try {
        log(line);
      } catch {
        // A console that cannot be written is not a reason to skip the UI.
      }
      try {
        target?.ui?.notify?.(line, "warning");
      } catch {
        // Headless, or a session already torn down. The line above is the record.
      }
    }
  }
}
