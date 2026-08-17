/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 * Kept: general-purpose + Explore. Plan removed (user can create via .md file).
 */

import type { AgentConfig } from "./types.js";

/** Internal agent type used by the answer verifier. */
export const VERIFIER_AGENT_TYPE = "__verifier";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find"];

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
      systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
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
      maxTurns: 1,
      systemPrompt:
        "You judge whether an answer addresses the task it was given. You are shown only the task and the answer — " +
        "never how the answer was produced, and you do not need it. You are not checking whether the work is correct. " +
        "Reply in exactly the two lines you are asked for and nothing else.",
      isDefault: true,
    },
  ],
]);
