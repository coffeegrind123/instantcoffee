/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 * Kept: general-purpose + Explore. Plan removed (user can create via .md file).
 */

import type { AgentConfig } from "./types.js";

/** Internal agent type used by the answer verifier. */
export const VERIFIER_AGENT_TYPE = "__verifier";

/**
 * Forge fork: `bash` removed.
 *
 * `Explore`'s prompt opens "# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS"
 * and lists ten prohibitions, of which exactly one was enforced — `edit` and
 * `write` really are absent. The other nine were enforced by the prompt, and a
 * shell is a superset of both missing tools: `sed -i`, `tee`, `> file`, `rm`,
 * `git checkout`.
 *
 * This repo has already measured what a prompt-level prohibition on tool use is
 * worth against this model, on this stack. From
 * `.pi/extensions/compaction-guard/src/output-cap.ts`:
 *
 *   "The notice was in front of the model, saying 'Do not read whole files or run
 *    commands with large output this turn', at 84.5% of the window. It ran the
 *    command regardless. That is not a bug in the notice and not a threshold that
 *    needs tuning: a soft instruction does not bind."
 *
 * That measurement is the whole argument. `Explore` is one of the two types the
 * `Agent` tool advertises, so it is what a model reaches for when it wants a safe
 * look around — including at a dirty tree, or at another repo through
 * `worktree_path`. The guarantee a reader takes from the name and the header is
 * now the one the tool set actually gives.
 *
 * The cost is real and is named in the prompt below: no `git log`, no `git diff`,
 * no shell pipelines. `general-purpose` is the agent for those. Reverting is one
 * line — put "bash" back and restore the prohibition list — and the decision is
 * recorded in `context/design/subagents-loop-verifier-units.md` (U9).
 */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for complex, multi-step tasks",
      // registeredTools omitted — means "all available tools" (resolved at lookup time)
      // extensions and skills intentionally omitted — resolved by global default
      systemPrompt: "",
      isDefault: true,
    },
  ],
  [
    "Explore",
    {
      name: "Explore",
      displayName: "Explore",
      description: "Fast codebase exploration agent (read-only)",
      registeredTools: READ_ONLY_TOOLS,
      // extensions and skills intentionally omitted — resolved by global default,
      systemPrompt: `# READ-ONLY MODE — ENFORCED BY YOUR TOOL SET
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code.

You have four tools: read, grep, find, ls. There is no edit, no write, and no shell,
so you cannot change anything on disk even by accident. This is not a rule you are
being asked to follow — it is the whole of what you can do.

What that means in practice:
- You cannot run git. If the task needs history, a diff, or a build, say so plainly
  and stop: it wants a general-purpose agent, not this one.
- You cannot create files, including temporary ones, anywhere.
- Report everything as your final message. That message is your only output.

# Tool Usage
- Use find for file pattern matching, grep for content search, read for file contents
- Use ls to list a directory
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`,
      isDefault: true,
    },
  ],
  [
    // Forge fork. The judge from src/agents/verify.ts, as an agent type so it
    // reuses model resolution, settings and the subagent denylist rather than
    // building a session by hand.
    //
    // It is deliberately the emptiest agent in the file. No tools, no
    // extensions, no skills, one turn: it is shown a task and an answer and
    // asked whether one addresses the other, and every capability it does not
    // need is a way for it to do something other than judge. `max_turns: 1`
    // also makes its cost predictable, which matters when the check runs on the
    // same single llama slot the parent is waiting on.
    VERIFIER_AGENT_TYPE,
    {
      name: VERIFIER_AGENT_TYPE,
      displayName: "verify",
      description: "Checks a subagent's answer against the task it was given (internal)",
      // Kept out of the Agent tool's type list. Measured: without this the
      // schema grows 357 -> 368 chars because "__verifier" joins the enum, and
      // the model is offered an internal type it has no reason to call.
      hidden: true,
      registeredTools: [],
      tools: false,
      extensions: false,
      skills: false,
      preloadSkills: false,
      // The two switches that decide what goes into a system PROMPT, as opposed
      // to what the session can DO. Both were left undeclared, and both resolve
      // from global config when an agent does not set them:
      //
      //   includeContextFiles = agentConfig?.includeContextFiles ?? store.agent.includeContextFiles
      //   mode = resolveEffectiveSystemPromptMode(store.agent.systemPromptMode, agentConfig?.includeSystemPrompt)
      //
      // `DEFAULT_AGENT.includeContextFiles` is TRUE, so the judge was handed
      // every AGENTS.md / CLAUDE.md on the path from cwd to "/" plus the agent
      // dir, inside `<project_context>`. Measured with the real builder: 571 →
      // 6,543 chars of system prompt, ~4.6% of the judge's window, per verified
      // delegation. The cost is the smaller half. A project context file is
      // where house rules live — "never simplify what was asked for", "an answer
      // without file:line is incomplete" — and those are instructions for the
      // WORKER. Given to the judge they become extra criteria nobody wrote into
      // the verifier, silently changing what ADDRESSED means.
      //
      // The whole argument for a separate judge (verify.ts, "Why the judge must
      // not run in the child's own session") is that it is harder to fool
      // BECAUSE IT KNOWS LESS. These two lines are what make that true.
      //
      // `includeSystemPrompt: false` is the same shape and worse: an operator
      // who sets systemPromptMode to "inherit" for their subagents — a supported
      // setting in the /agents menu — would otherwise hand the judge the
      // operator's entire system prompt.
      includeContextFiles: false,
      includeSystemPrompt: false,
      // And the environment block, which costs a `git rev-parse` and a `git
      // branch` per judge call — ~100 ms measured on this box's 9p mount, on the
      // one llama slot the parent's Agent call is blocked on. The judge is shown
      // a task and an answer; it has no working tree, no tools to use one with,
      // and one turn in which not to.
      includeEnvironment: false,
      maxTurns: 1,
      systemPrompt:
        "You judge whether an answer addresses the task it was given. You are shown only the task and the answer — " +
        "never how the answer was produced, and you do not need it. You are not checking whether the work is correct. " +
        "Reply in exactly the two lines you are asked for and nothing else.",
      isDefault: true,
    },
  ],
]);
