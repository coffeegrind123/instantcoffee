// RTK for pi — bash output compression, restricted to a measured allow-list.
//
// Forked from rtk-ai/rtk `hooks/pi/rtk.ts` at v0.45.0. See ../FORK.md for what
// changed and why. Upstream's version is a thin delegate that hands every bash
// command to `rtk rewrite` and applies whatever comes back. This one refuses to
// do that, because some rewrites change what the command MEANS: `npm run lint`
// becomes `rtk lint`, which throws away the indirection and runs a bare eslint
// instead of whatever the package's lint script actually is, and `uv run pytest`
// becomes `uv run rtk pytest`, resolving a different pytest than the venv's. A
// 27B model at 32K has no way to notice either, and neither does anything
// downstream of it. Both measured on 2026-08-16 against rtk 0.45.0.
//
// Most of rtk's filters turned out to be faithful when actually diffed against
// the real command — `find` returns the same file set, `grep -rl` the same
// paths, `rtk read` the same bytes. The allow-list is narrow because most
// filters save nothing on a repo shaped like this one, not because most of them
// lie. The two that do misbehave are worth the whole apparatus anyway.
//
// Every decision lives in ../src/gate.ts, which imports nothing from pi so it
// can be tested with bare node. This file is the pi coupling and nothing else.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isToolCallEventType } from "@earendil-works/pi-coding-agent"

import { approvedAsWritten, extractRewrite, parseSemver, shouldFilter } from "../src/gate.ts"

const REWRITE_TIMEOUT_MS = 2_000
const MIN_SUPPORTED_RTK_MINOR = 23

// Calls `rtk rewrite`; returns the rewritten command or null (pass through).
//
// Exit code contract: 0 or 3 with stdout means a rewrite was found, 1 means
// there is no rtk equivalent. Both non-rewrite paths pass the command through.
async function rewriteCommand(
  pi: ExtensionAPI,
  cmd: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await pi.exec("rtk", ["rewrite", cmd], {
    timeout: REWRITE_TIMEOUT_MS,
    signal,
  })
  if (result.killed) return null
  if (result.code !== 0 && result.code !== 3) return null
  return extractRewrite(result.stdout)
}

export default async function (pi: ExtensionAPI) {
  // Probe rtk at load time. A missing binary is not an error worth failing a
  // session over — scripts/pi-local.sh has already said so at launch, in a place
  // the operator can see, and the stack works fine without any of this.
  const ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })
  // `killed` before `code`, for the same reason `rewriteCommand` does it: pi's
  // `execCommand` resolves a child it killed on the timeout with `code: code ?? 0`
  // — a signalled child exits with no code — so a WEDGED rtk arrives here looking
  // exactly like a healthy one that printed nothing. Without this, the probe
  // passed, `parseSemver("")` returned null, the version guard was skipped, and
  // every allow-listed command then paid a 2s timeout before failing open, with
  // nothing said about it. Same shape as AA2, one call site over; see AB3 in
  // context/design/subagents-loop-verifier-signals.md.
  if (ver.killed) {
    console.warn(
      `[rtk] rtk --version did not answer within ${REWRITE_TIMEOUT_MS}ms - bash output will not be filtered`
    )
    return
  }
  if (ver.code !== 0) {
    console.warn("[rtk] rtk is not on PATH - bash output will not be filtered")
    return
  }

  const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ""))
  if (parsed) {
    const [major, minor] = parsed
    if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
      console.warn(
        `[rtk] rtk ${ver.stdout.trim()} predates \`rtk rewrite\` (need >= 0.23.0) - not filtering`
      )
      return
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!isToolCallEventType("bash", event)) return

      const raw = event.input.command
      if (typeof raw !== "string") return
      const cmd = raw.trim()

      // AJ3 (nineteenth pass): a command a person has already approved is left
      // exactly as they read it. `vendor/prinny-channel`'s relay runs first on
      // the same mutable `event.input` and stamps what it showed the approver;
      // rewriting after that would mean the string on the phone and the string
      // pi runs are two different commands. See approvedAsWritten in ../src/gate.ts.
      if (approvedAsWritten(event.input)) {
        console.warn(
          "[rtk] not rewriting a command that was approved on Matrix as written; running it unfiltered"
        )
        return
      }

      // Checked before anything else so an operator can kill filtering for one
      // launch without editing .env: RTK_DISABLED=1 qpi
      if (process.env.RTK_DISABLED === "1") return

      if (!shouldFilter(cmd)) return

      const rewritten = await rewriteCommand(pi, cmd, ctx.signal)
      if (rewritten && rewritten !== cmd) {
        event.input.command = rewritten
      }
    } catch (err) {
      // Fail open, always. A filter that cannot decide must not be the reason a
      // command does not run.
      console.warn("[rtk] rewrite failed; running the command unfiltered", err)
      return
    }
  })
}
