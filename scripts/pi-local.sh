#!/usr/bin/env bash
#
# Run the pi coding agent (pi.dev) against the local model.
#
#   ./scripts/pi-local.sh                 start a session
#   ./scripts/pi-local.sh -p "summarize"  any pi flag passes through
#   ./scripts/pi-local.sh --install-only  write ~/.pi/agent/models.json and stop
#   ./scripts/pi-local.sh --print-only    show the command without running it
#
# pi has no built-in notion of "an OpenAI-compatible proxy" as a flag — custom
# providers are declared in ~/.pi/agent/models.json. This script generates that
# file from .env so the model id, context window and port cannot drift apart
# from what the stack is actually serving.
#
# Deliberately NOT using pi's own /llama integration: that makes pi manage its
# own llama.cpp router and models, which would bypass forge entirely and lose
# every guardrail this repo exists to provide.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

INSTALL_ONLY=0; PRINT_ONLY=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --install-only) INSTALL_ONLY=1 ;;
    --print-only)   PRINT_ONLY=1 ;;
    *)              ARGS+=("$a") ;;
  esac
done

MODEL="$(env_get MODEL_ALIAS)"
CTX="$(env_get CTX_SIZE)"
MAX_TOKENS="$(env_get PI_MAX_TOKENS)"
: "${MAX_TOKENS:=8192}"

PORT="$(env_get FORGE_PORT)"

# Published ports bind to the host's loopback; inside a container the host is
# reachable as host.docker.internal instead.
[[ -f /.dockerenv ]] && HOST="host.docker.internal" || HOST="localhost"
BASE="http://${HOST}:${PORT}"

PI_DIR="${HOME}/.pi/agent"
MODELS_JSON="${PI_DIR}/models.json"

# --- generate models.json ----------------------------------------------------
# Merges into any existing file rather than overwriting it — pi keeps other
# providers here too, and clobbering someone's whole model config to add one
# local entry would be rude.
mkdir -p "$PI_DIR"
MODEL="$MODEL" BASE_URL="${BASE}/v1" CTX="$CTX" MAX_TOKENS="$MAX_TOKENS" \
MODELS_JSON="$MODELS_JSON" \
python3 - <<'PY'
import json, os, pathlib

path = pathlib.Path(os.environ["MODELS_JSON"])
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text() or "{}")
    except json.JSONDecodeError:
        raise SystemExit(f"{path} exists but is not valid JSON — refusing to overwrite it")

providers = data.setdefault("providers", {})
providers["forge"] = {
    "baseUrl": os.environ["BASE_URL"],
    # forge's OpenAI endpoint is the short path: pi -> forge -> llama.cpp.
    # Going via anthropic-messages would add a translation hop that drops
    # cache_control and thinking for no benefit here.
    "api": "openai-completions",
    # pi hides models it considers unauthenticated, so a keyless local server
    # still needs a placeholder. forge relocates exactly one credential and
    # llama.cpp ignores it.
    "apiKey": "local",
    "compat": {
        # Both still False on 3.8, but the reason changed and is worth writing
        # down, because the obvious reading of the 3.8 release notes says
        # otherwise.
        #
        # The MODEL supports both: the unsloth 3.8 template adds developer-role
        # handling, and `reasoning_effort` is a real template variable with four
        # levels. The ENGINE is what does not. llama.cpp only began forwarding an
        # API-level `reasoning_effort` field to the template in commit 7e4c0a9
        # (2026-08-14, "chat: pass reasoning_effort to template"), and the newest
        # published CUDA server image at migration time was server-cuda-b10423,
        # cut 2026-08-13 — a day earlier. So a client that sends the field gets
        # it silently dropped.
        #
        # Until an image ships with that commit, effort is set server-side via
        # --chat-template-kwargs from REASONING_EFFORT in .env, which applies to
        # the whole server rather than per request. Flip these to True only after
        # checking that the running build actually honours them.
        "supportsDeveloperRole": False,
        "supportsReasoningEffort": False,
    },
    "models": [
        {
            "id": os.environ["MODEL"],
            "name": "Qwen3.8-27B local (forge)",
            "contextWindow": int(os.environ["CTX"]),
            # Well under contextWindow on purpose: with --no-context-shift a
            # request that would overflow fails loudly, and an agentic loop's
            # prompt grows every turn. Comes from PI_MAX_TOKENS so it cannot
            # drift from the -n backstop in LLAMA_EXTRA_FLAGS.
            "maxTokens": int(os.environ["MAX_TOKENS"]),
            "input": ["text"],
            # Left false deliberately. Qwen reasons server-side under
            # --reasoning-budget and forge keeps it out of history, so there is
            # nothing for pi to drive. Set true only if you want pi's thinking
            # UI and have checked it round-trips.
            "reasoning": False,
        }
    ],
}
path.write_text(json.dumps(data, indent=2) + "\n")
path.chmod(0o600)
print(f"wrote {path}")
PY

# --- size pi's compaction for THIS window ------------------------------------
# pi's defaults (reserveTokens 16384, keepRecentTokens 20000) are sized for a
# 200k window and are actively harmful on 32k. Measured against pi 0.84.2's own
# dist and 8 real sessions under ~/.pi/agent/sessions:
#
#   * shouldCompact() turns true at 50% of the window, but prepareCompaction()
#     returns undefined until the context exceeds keepRecentTokens — so from 50%
#     to ~66% pi decides to compact on every turn and silently does nothing.
#   * The first compaction that actually fires lands at 28.8k of 32.7k (88%),
#     and always keeps keepRecentTokens = 61% of the window, plus a summary that
#     is merged into the previous one and grows every time (observed: 1,666 ->
#     11,054 chars). From compaction #4 the session sat at 94-96% full and
#     compaction freed nothing at all.
#   * Above ~87% full, 33 of 63 assistant turns came back completely empty
#     (content: [], stopReason "stop"). Below it, 3 of 196.
#
# Sizing both knobs off CTX_SIZE keeps the trigger at 50% of whatever window the
# stack is actually serving and cuts back to ~20% of it, which is the difference
# between compacting every turn and compacting every ~50.
#
# This is written to pi's GLOBAL settings on purpose: the loop runs in whatever
# project you point it at, and a .pi/settings.json in this repo would only apply
# to sessions started here (and only when the project is trusted).
CTX="$CTX" PI_DIR="$PI_DIR" python3 - <<'PY'
import json, os, pathlib

path = pathlib.Path(os.environ["PI_DIR"]) / "settings.json"
ctx = int(os.environ["CTX"])
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text() or "{}")
    except json.JSONDecodeError:
        raise SystemExit(f"{path} exists but is not valid JSON — refusing to overwrite it")

compaction = data.setdefault("compaction", {})
# Trigger at 50% of the window; never later than pi's own default headroom.
compaction["reserveTokens"] = min(16384, ctx // 2)
# Keep ~20% of the window after a compaction, floored so a tiny window still
# keeps a usable turn and capped at pi's default so a large one is unchanged.
compaction["keepRecentTokens"] = max(2000, min(20000, round(ctx * 0.2)))

# pi's HTTP IDLE timeout, i.e. how long a request may go without producing a
# byte. Default 300_000 ms. Measured 2026-08-16 in ~/testing: a session's first
# two requests both died with `Error: terminated` at exactly 301 s, ten minutes
# before the first token, because prefill emits nothing while it runs and this
# box had collapsed to 20-37 tok/s of prefill under memory pressure (the README
# records 1,175 tok/s healthy). 6.5k tokens of prompt at 35 tok/s is 187 s of
# silence; queueing and a prompt-cache eviction pushed it past 300.
#
# Sized so a FULL window still prefills inside the budget at 36 tok/s - the
# degraded floor, not the healthy rate - then clamped: never below pi's own
# default, never above 15 min, because past that a genuinely dead connection is
# just a hang.
data["httpIdleTimeoutMs"] = min(900, max(300, -(-ctx // 36))) * 1000

path.write_text(json.dumps(data, indent=2) + "\n")
print(f"wrote {path} (compaction: {compaction}, httpIdleTimeoutMs: {data['httpIdleTimeoutMs']})")
PY

if (( INSTALL_ONLY )); then
  dim "Provider 'forge' installed. Check with: pi --list-models"
  exit 0
fi

# --- launch ------------------------------------------------------------------
pi_flags=(--provider forge --model "$MODEL")

# pi discovers AGENTS.md / CLAUDE.md by walking parent directories. Loaded by
# default: an agent that ignores the conventions file in the repo it is editing
# costs more in rework than the tokens save. PI_CONTEXT_FILES=0 passes -nc.
CTX_FILES_NOTE="context files off"
if [[ "$(env_get PI_CONTEXT_FILES)" == "1" ]]; then
  CTX_FILES_NOTE="context files on"
else
  pi_flags+=(-nc)
fi

# /stack, loaded by absolute path for the same reason --skill is below.
#
# Auto-discovery of .pi/extensions/ is scoped to the project pi was STARTED in,
# and it also requires that project to be trusted. Both bite: started in another
# project the extension is simply absent, and started here without -a it is
# silently skipped — in which case `/stack` is not a command, so pi forwards the
# text to the model and you get an invented answer about stack files rather than
# an error. Verified both ways, 2026-08-13.
#
# -e is not additive to discovery in the harmful sense: loading the same path
# twice (once discovered here, once explicit) registers ONE `/stack`, not
# `/stack:1` and `/stack:2` — pi dedupes by path. Checked before relying on it.
STACK_EXT="$REPO_ROOT/.pi/extensions/stack.ts"
STACK_NOTE=""
if [[ -r "$STACK_EXT" ]]; then
  pi_flags+=(-e "$STACK_EXT")
  STACK_NOTE=", /stack"
else
  warn "$STACK_EXT is missing — /stack will not be available this session."
fi

# Rewrites a browser-tool timeout into an instruction instead of a parameter
# dump. Loaded whenever the browser is, by absolute path for the same reasons as
# /stack. It registers no tools and no commands, so it costs nothing in the
# window; it only ever edits the text of a browser call that already failed.
GUARD_EXT="$REPO_ROOT/.pi/extensions/browser-guard.ts"
if [[ -r "$GUARD_EXT" ]]; then
  pi_flags+=(-e "$GUARD_EXT")
fi

# /loop comes from vendor/pi-loop-mode — a fork of pi-loop-mode@2.5.4 that this
# repo carries and edits (see vendor/pi-loop-mode/FORK.md). It is loaded by
# absolute path, like /stack above, so the same code runs whatever directory pi
# was started in, and so the fix travels with the checkout instead of living in
# a user-global npm install that the next `pi update` would quietly replace.
#
# The extension needs no node_modules: its only non-relative import is a
# `import type` of pi's own types, which is erased before the file ever runs.
LOOP_DIR="$REPO_ROOT/vendor/pi-loop-mode"
LOOP_NOTE=""
if [[ -r "$LOOP_DIR/extensions/index.ts" ]]; then
  pi_flags+=(-e "$LOOP_DIR/extensions/index.ts")
  # Skill and prompt templates ship in the same package; without them /loop works
  # but the model loses the guidance the loop skill exists to give it.
  [[ -d "$LOOP_DIR/skills/loop-skill" ]] && pi_flags+=(--skill "$LOOP_DIR/skills/loop-skill")
  [[ -d "$LOOP_DIR/prompts" ]] && pi_flags+=(--prompt-template "$LOOP_DIR/prompts")
  LOOP_NOTE=", /loop"

  # Exported, not passed as a flag: the fork reads it from `process.env`, and a
  # value that only ever lives in .env is a knob that silently does nothing.
  # Only "1" is exported — anything else leaves the variable unset, which is the
  # default (ask the operator) rather than a third state.
  #
  # AJ2: the `loop` TOOL's `check` parameter is a shell command `runGoalCheck`
  # runs with `bash -lc` once per iteration, and pi.exec emits no `tool_call`, so
  # nothing in this stack reviews it. By default the operator is told and asked;
  # this is the standing yes for an unattended run that wants it anyway. The
  # slash command's own --check is unaffected either way.
  if [[ "$(env_get LOOP_TOOL_CHECK)" == "1" ]]; then
    export LOOP_TOOL_CHECK=1
    LOOP_NOTE=", /loop (model may arm checks)"
  fi
else
  warn "$LOOP_DIR is missing — /loop will not exist this session."
fi

# An npm install of the upstream package registers a SECOND /loop from a different
# path (pi only dedupes identical paths), and the two would fight over the same
# session state. Say so rather than letting the operator debug it live.
if pi list 2>/dev/null | grep -q "pi-loop-mode@"; then
  warn "The upstream pi-loop-mode npm package is still installed in pi's user settings."
  warn "It shadows vendor/pi-loop-mode and reintroduces the context-recovery bug it forks around."
  warn "Remove it with: pi uninstall npm:pi-loop-mode"
  LOOP_NOTE=", /loop (conflicting npm install)"
fi

# The compaction guard carries the non-loop-specific half of the /loop context
# work into every session: it bounds the summary pi carries from one compaction
# into the next, and shows the model its remaining budget above 60% of the
# window. Both were measured on THIS stack (42 real compaction points, 259
# assistant turns) and neither depends on a loop being active — see the header
# of .pi/extensions/compaction-guard/index.ts.
#
# It registers no tools and no commands, so it costs nothing in the window
# except the ~40-token budget line it adds above 60%.
#
# Loaded AFTER vendor/pi-loop-mode on purpose. Both can append a context-budget
# line, pi runs `context` handlers in registration order, and whichever runs
# second stands down when it sees the other's message. With a loop running its
# own loop-flavoured line is the better one, so the loop must get first refusal.
# (Both sides check, so a different order costs a duplicate line, not a bug.)
GUARD_DIR="$REPO_ROOT/.pi/extensions/compaction-guard"
CGUARD_NOTE=""
if [[ -r "$GUARD_DIR/index.ts" ]]; then
  pi_flags+=(-e "$GUARD_DIR/index.ts")
  CGUARD_NOTE=", compaction guard"
else
  warn "$GUARD_DIR is missing — compaction will use pi's unbounded summary this session."
fi

# Subagents come from vendor/pi-subagents-lite — a fork of pi-subagents-lite@1.11.0
# (see vendor/pi-subagents-lite/FORK.md). pi ships none deliberately; of the 341
# packages the catalog matches on "subagent", this one was picked for the three
# things this stack actually needs and the rest mostly cannot use.
#
# It runs subagents IN PROCESS (pi's own createAgentSession), not as child `pi -p`
# processes the way the popular packages do. On one llama slot a child process
# buys no parallelism — it queues at the server — while costing a second system
# prompt that evicts the parent's cached prefix. In-process keeps one prefix
# resident, and the win that survives here is context isolation: the child burns
# its own window on the search and the parent gets back a bounded summary.
#
# Loaded AFTER the compaction guard, and only when the guard is present: the
# fork's src/spawn/result-cap.ts imports the guard's measured cap constants by
# relative path to bound a finished BACKGROUND subagent's result, which reaches
# the context as an injected message and so never passes the guard's own
# `tool_result` hook. Without the guard that import cannot resolve and the
# extension would fail to load, so this skips it with a reason instead.
#
# Off by default. A subagent tool costs its schema on EVERY turn whether or not
# it is ever called, and on a 32k window that is a standing charge to opt into
# rather than inherit.
SUBAGENTS_DIR="$REPO_ROOT/vendor/pi-subagents-lite"
SUBAGENTS_NOTE=""
if [[ "$(env_get SUBAGENTS_ENABLED)" == "1" ]]; then
  if [[ ! -r "$SUBAGENTS_DIR/src/index.ts" ]]; then
    warn "$SUBAGENTS_DIR is missing — subagents will not exist this session."
  elif [[ ! -r "$GUARD_DIR/src/output-cap.ts" ]]; then
    warn "The compaction guard is missing, so subagents were left out of this session."
    warn "A background subagent's result reaches the context uncapped without it."
  else
    pi_flags+=(-e "$SUBAGENTS_DIR/src/index.ts")
    SUBAGENTS_NOTE=", subagents"

    # Exported, not passed as a flag: the fork reads both from `process.env`,
    # and a value that only ever lives in .env is a knob that silently does
    # nothing. Empty stays unset so the fork's own defaults apply — exporting an
    # empty SUBAGENT_EXTRA_EXTENSIONS would mean "no extra extensions", which is
    # the opposite of "not configured".
    SUBAGENT_VERIFY_VALUE="$(env_get SUBAGENT_VERIFY)"
    [[ -n "$SUBAGENT_VERIFY_VALUE" ]] && export SUBAGENT_VERIFY="$SUBAGENT_VERIFY_VALUE"
    [[ "$SUBAGENT_VERIFY_VALUE" == "0" ]] && SUBAGENTS_NOTE=", subagents (unverified)"

    SUBAGENT_ROUNDS_VALUE="$(env_get SUBAGENT_VERIFY_ROUNDS)"
    [[ -n "$SUBAGENT_ROUNDS_VALUE" ]] && export SUBAGENT_VERIFY_ROUNDS="$SUBAGENT_ROUNDS_VALUE"

    # Per-call deadline for the judge and each repair, in ms. Verification runs
    # after the child's status has gone terminal, and every stop path keys off
    # "running" — so without this a wedged llama-server hangs the parent's Agent
    # tool call with no operator-reachable exit. Default 300000 in the fork.
    SUBAGENT_TIMEOUT_VALUE="$(env_get SUBAGENT_VERIFY_TIMEOUT_MS)"
    [[ -n "$SUBAGENT_TIMEOUT_VALUE" ]] && export SUBAGENT_VERIFY_TIMEOUT_MS="$SUBAGENT_TIMEOUT_VALUE"

    SUBAGENT_EXTRAS_VALUE="$(env_get SUBAGENT_EXTRA_EXTENSIONS)"
    [[ -n "$SUBAGENT_EXTRAS_VALUE" ]] && export SUBAGENT_EXTRA_EXTENSIONS="$SUBAGENT_EXTRAS_VALUE"
  fi
fi

# /prinny comes from vendor/prinny-channel — the Matrix channel, converted from
# the Claude Code plugin of the same name (see vendor/prinny-channel/FORK.md).
# Loaded by absolute path for the same reasons as /stack and /loop above.
#
# It needs no node_modules either: its only bare imports are typebox and pi's own
# packages, which pi resolves from its own module root. The Matrix layer is a
# CHILD process whose ~105MB of dependencies live outside this repo, under
# ~/.pi/agent/channels/prinny/runtime — built once by `/prinny prepare`.
#
# Opt-in, because it logs a bot into a homeserver and makes this session
# addressable from the internet. PRINNY_ENABLED=0 (the default) leaves it out
# entirely rather than loading it in a dormant state, so there is nothing to
# misconfigure until you ask for it.
PRINNY_DIR="$REPO_ROOT/vendor/prinny-channel"
PRINNY_NOTE=""
if [[ "$(env_get PRINNY_ENABLED)" == "1" ]]; then
  if [[ -r "$PRINNY_DIR/extensions/index.ts" ]]; then
    pi_flags+=(-e "$PRINNY_DIR/extensions/index.ts")
    # The skills explain which /prinny subcommand to run; without them the model
    # is left to invent an answer about a command it cannot see.
    for skill in prinny-access prinny-configure; do
      [[ -d "$PRINNY_DIR/skills/$skill" ]] && pi_flags+=(--skill "$PRINNY_DIR/skills/$skill")
    done
    PRINNY_NOTE=", /prinny"

    # Said now rather than mid-session. An unbuilt runtime means the channel
    # never comes up, and the only clue is a line in a log file the operator has
    # no reason to open.
    PRINNY_STATE="${PRINNY_STATE_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/channels/prinny}"
    if [[ ! -f "$PRINNY_STATE/runtime/dist/server.js" ]]; then
      dim "The prinny channel runtime is not built — run /prinny prepare once (~1 min)."
      PRINNY_NOTE=", /prinny (runtime not built)"
    elif [[ ! -f "$PRINNY_STATE/.env" ]]; then
      dim "The prinny channel has no credentials — run /prinny configure."
      PRINNY_NOTE=", /prinny (not configured)"
    fi
  else
    warn "$PRINNY_DIR is missing — /prinny will not exist this session."
  fi
fi

# rtk — compresses the output of an allow-list of bash commands before pi sees
# it. Loaded by absolute path like everything else above, from vendor/rtk-pi
# rather than by `rtk init --agent pi`: that writes into whichever project pi was
# started in, which is your project, not this checkout.
#
# On by default, and safe to leave on with no binary installed — the extension
# warns once at load and filters nothing, so the session is never worse than it
# would have been. That is why this checks for the extension but does not check
# for rtk itself: a missing binary is a note, not a launch-time decision.
#
# It filters an allow-list, not everything, because some of rtk's filters return
# output that is wrong rather than short. vendor/rtk-pi/FORK.md has the
# measurements; ./scripts/rtk.sh --check re-runs them.
#
# Loaded AFTER vendor/prinny-channel, and that order is load-bearing rather than
# incidental. Both register a `tool_call` handler, pi runs them in registration
# order, and prinny's is the Matrix permission relay: it shows the approver
# `describeCall(toolName, event.input)` and blocks by returning `{block:true}`,
# which makes pi return from `emitToolCall` immediately. So with prinny first,
# the command a person is asked to approve is the command the model wrote, and a
# blocked command is never handed to rtk at all. The other way round the relay
# would quote `rtk git status` for a model that asked for `git status`, which is
# an approval for a command nobody typed. (`permissionMode` is `off` by default,
# so this only bites a session that has turned the relay on — which is exactly
# the session that cares.)
RTK_DIR="$REPO_ROOT/vendor/rtk-pi"
RTK_NOTE=""
if [[ "$(env_get RTK_ENABLED)" == "1" ]]; then
  if [[ -r "$RTK_DIR/extensions/index.ts" ]]; then
    pi_flags+=(-e "$RTK_DIR/extensions/index.ts")

    # Exported here rather than in scripts/rtk.sh, because rtk.sh is not in the
    # path that matters: the extension shells out to `rtk rewrite` itself, and
    # the rewritten command (`rtk git status`) is then run by pi's bash tool.
    # Both inherit THIS environment and neither goes through rtk.sh, so setting
    # it there alone would leave a stack meant to run with the network unplugged
    # relying on rtk's own default. It is off by default upstream; this makes it
    # off because the checkout says so.
    export RTK_TELEMETRY_DISABLED=1
    if command -v rtk >/dev/null 2>&1 || [[ -x "$HOME/.local/bin/rtk" ]]; then
      RTK_NOTE=", rtk"
      # A filter set that does not match the pin is the one failure here that is
      # invisible from inside a session: commands keep working and quietly report
      # something else. Say it at launch, where it can be acted on.
      WANT_RTK="$(env_get RTK_VERSION)"
      HAVE_RTK="$( { command -v rtk >/dev/null 2>&1 && rtk --version || "$HOME/.local/bin/rtk" --version; } 2>/dev/null \
                   | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
      if [[ -n "$WANT_RTK" && -n "$HAVE_RTK" && "$WANT_RTK" != "$HAVE_RTK" ]]; then
        warn "rtk ${HAVE_RTK} is installed but .env pins ${WANT_RTK}."
        warn "The allow-list in vendor/rtk-pi was measured against ${WANT_RTK}."
        warn "Align them: ./scripts/rtk.sh --install   (then ./scripts/rtk.sh --check)"
        RTK_NOTE=", rtk (${HAVE_RTK}, pin says ${WANT_RTK})"
      fi
    else
      dim "rtk is not installed — bash output will not be filtered this session."
      dim "Install it once with: ./scripts/rtk.sh --install"
      RTK_NOTE=", rtk (not installed)"
    fi
  else
    warn "$RTK_DIR is missing — bash output will not be filtered."
  fi
fi

# MCP servers, reached as a CLI rather than as MCP. --skill is additive and takes
# an absolute path, so the skill travels with the repo instead of being installed
# into ~/.pi — nothing outside this checkout is touched, and it still applies when
# pi is started in another project's directory.
MCP_NOTE=""
if [[ "$(env_get MCP2CLI_ENABLED)" == "1" ]]; then
  SKILL_DIR="$REPO_ROOT/skills/mcp-tools"
  [[ -r "$SKILL_DIR/SKILL.md" ]] \
    || die "MCP2CLI_ENABLED=1 but $SKILL_DIR/SKILL.md is missing"
  pi_flags+=(--skill "$SKILL_DIR")
  MCP_NOTE=", mcp via cli"
  # Both of these are said now rather than mid-session, where the model would
  # read a slow or failing install as "the tool does not work" and quietly stop
  # reaching for it.
  if ! command -v uv >/dev/null 2>&1; then
    warn "uv is not on PATH — ./scripts/mcp.sh cannot install mcp2cli when the model reaches for it."
    warn "Install uv, or set MCP2CLI_ENABLED=0 to stop offering the skill."
  elif [[ ! -x "${HOME}/.local/bin/mcp2cli" ]] && ! command -v mcp2cli >/dev/null 2>&1; then
    dim "mcp2cli is not installed yet — the first MCP call will install it (~30s)."
    dim "Do it now instead with: ./scripts/mcp.sh --install"
  fi
fi

# A browser. Two ways in, and the difference is only which side of the wire pi
# sits on — scripts/browser.sh owns the server process either way, so the browser
# outlives the session and is shared with anything else on this box.
#
#   adapter mode (default)  pi-mcp-adapter connects to that server over HTTP and
#                           registers the browse loop as native pi tools. Calls
#                           cost 25-417 ms and the other 93 tools stay one
#                           mcp({ search }) away.
#   cli mode                the model shells out to ./scripts/browser.sh. No npm
#                           package, ~120 tokens, 1.7-6.5 s per call.
#
# Neither starts Chrome here. In adapter mode the SERVER is started (see
# BROWSER_MCP_AUTOUP) because the model's first call otherwise hits a closed
# port; Chrome itself still waits for a tool that needs it.
BROWSER_NOTE=""
if [[ "$(env_get BROWSER_MCP_ENABLED)" == "1" ]]; then
  # Said now rather than mid-session: without the checkout the first browser call
  # fails, and the model reads that as "the web is not available to me".
  ZDIR="$(env_get ZENDRIVER_MCP_DIR)"
  if [[ -z "$ZDIR" ]]; then
    # Must support --transport, not merely exist: a clone from before the HTTP
    # transport passes an -f test and then serves stdio only, 63 tools short.
    for cand in /opt/zendriver-mcp "$HOME/Zendriver-MCP"; do
      [[ -f "$cand/run.py" ]] && grep -q -- "--transport" "$cand/run.py" \
        && { ZDIR="$cand"; break; }
    done
  fi
  BROWSER_OK=1
  if [[ ! -f "${ZDIR:-/nonexistent}/run.py" ]]; then
    warn "No Zendriver MCP checkout at '${ZDIR:-<unset>}' — the browser cannot start."
    warn "Clone https://github.com/coffeegrind123/Zendriver-MCP-fork and set ZENDRIVER_MCP_DIR,"
    warn "or set BROWSER_MCP_ENABLED=0 to stop offering it."
    BROWSER_OK=0
  fi

  # mcp/adapter.json reaches the server through these two, so the config cannot
  # name a port that browser.sh does not bind. The adapter fails loudly on a
  # missing variable rather than resolving a wrong URL.
  BROWSER_HOST="$(env_get BROWSER_MCP_HOST)"; : "${BROWSER_HOST:=127.0.0.1}"
  BROWSER_PORT="$(env_get BROWSER_MCP_PORT)"; : "${BROWSER_PORT:=8931}"
  export BROWSER_MCP_HOST="$BROWSER_HOST" BROWSER_MCP_PORT="$BROWSER_PORT"

  USE_ADAPTER=0
  if [[ "$(env_get MCP_ADAPTER_ENABLED)" == "1" ]]; then
    # --mcp-config is a flag the ADAPTER registers, so passing it without the
    # package installed makes pi reject the whole command line. Check first.
    ADAPTER_PKG="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-mcp-adapter/package.json"
    WANT_VER="$(env_get MCP_ADAPTER_VERSION)"
    if [[ -r "$ADAPTER_PKG" ]]; then
      USE_ADAPTER=1
      HAVE_VER="$(json_eval "import json;print(json.load(open('$ADAPTER_PKG')).get('version',''))" 2>/dev/null || true)"
      if [[ -n "$WANT_VER" && -n "$HAVE_VER" && "$HAVE_VER" != "$WANT_VER" ]]; then
        warn "pi-mcp-adapter ${HAVE_VER} is installed but .env pins ${WANT_VER}."
        warn "The tool surface the browser skill describes was written against ${WANT_VER}."
        warn "Align them: pi install npm:pi-mcp-adapter@${WANT_VER}   (or update MCP_ADAPTER_VERSION)"
      fi
    else
      warn "MCP_ADAPTER_ENABLED=1 but pi-mcp-adapter is not installed — falling back to the CLI."
      warn "Install it once with: pi install npm:pi-mcp-adapter@${WANT_VER:-latest}"
    fi
  fi

  if (( USE_ADAPTER )); then
    ADAPTER_CFG="$REPO_ROOT/mcp/adapter.json"
    BROWSER_SKILL="$REPO_ROOT/skills/browser-tools"
    [[ -r "$ADAPTER_CFG" ]] || die "MCP_ADAPTER_ENABLED=1 but $ADAPTER_CFG is missing"
    [[ -r "$BROWSER_SKILL/SKILL.md" ]] || die "$BROWSER_SKILL/SKILL.md is missing"
    pi_flags+=(--mcp-config "$ADAPTER_CFG" --skill "$BROWSER_SKILL")
    BROWSER_NOTE=", browser (native tools)"

    # Idempotent: a no-op when the server is already up, which is the common case
    # on a second session. Failure is not fatal — the model still has the tools
    # and the skill says how to bring the server back.
    if (( BROWSER_OK )) && [[ "$(env_get BROWSER_MCP_AUTOUP)" != "0" ]]; then
      if ! "$REPO_ROOT/scripts/browser.sh" up >/dev/null 2>&1; then
        warn "The browser server did not start — see ./scripts/browser.sh logs"
        BROWSER_NOTE=", browser (server down)"
      fi
    fi
  else
    BROWSER_SKILL="$REPO_ROOT/skills/browser"
    [[ -r "$BROWSER_SKILL/SKILL.md" ]] \
      || die "BROWSER_MCP_ENABLED=1 but $BROWSER_SKILL/SKILL.md is missing"
    pi_flags+=(--skill "$BROWSER_SKILL")
    BROWSER_NOTE=", browser (cli)"
    "$REPO_ROOT/scripts/browser.sh" status >/dev/null 2>&1 && BROWSER_NOTE=", browser (cli, up)"
  fi
  (( BROWSER_OK )) || BROWSER_NOTE=", browser (no checkout)"
fi

# Replayed from .env because bash does not expand aliases inside scripts.
EXTRA_ARGS="$(env_get PI_EXTRA_ARGS)"
if [[ -n "$EXTRA_ARGS" ]]; then
  read -r -a extra <<< "$EXTRA_ARGS"
  pi_flags+=("${extra[@]}")
fi

# THINK_LANG fragment, if one is selected. pi's --help documents
# --append-system-prompt as taking "text or file contents" and as repeatable,
# but the file is read here anyway so the same bytes reach both clients.
THINK_FILE="$(think_prompt_path)"
THINK_NOTE=""
if [[ -n "$THINK_FILE" ]]; then
  pi_flags+=(--append-system-prompt "$(cat "$THINK_FILE")")
  THINK_NOTE=", thinking in $(env_get THINK_LANG)"
fi

if (( PRINT_ONLY )); then
  printf 'pi'; printf ' %q' "${pi_flags[@]}"; printf '\n'
  exit 0
fi

command -v pi >/dev/null 2>&1 \
  || die "pi is not installed — npm install -g --ignore-scripts @earendil-works/pi-coding-agent"

# --- keep pi current ---------------------------------------------------------
# pi ships often and the stack is only ever tested against the current release.
# Checked at most once per PI_UPDATE_INTERVAL_H hours (a stamp file), because a
# registry round trip on every launch is latency you would feel and a network
# dependency a local-model stack should not have.
#
# Fails SOFT, always: no npm, no network, a registry hiccup — warn and launch on
# what is installed. An agent session must never be blocked by an update check.
if [[ "$(env_get PI_AUTO_UPDATE)" == "1" ]]; then
  STAMP="${HOME}/.pi/.last-update-check"
  INTERVAL_H="$(env_get PI_UPDATE_INTERVAL_H)"; : "${INTERVAL_H:=24}"
  AGE_H=$(( INTERVAL_H + 1 ))
  [[ -f "$STAMP" ]] && AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$STAMP" 2>/dev/null || echo 0) ) / 3600 ))
  if (( AGE_H >= INTERVAL_H )); then
    if command -v npm >/dev/null 2>&1; then
      CUR="$(pi --version 2>/dev/null | tr -d ' ')"
      LATEST="$(timeout 20 npm view @earendil-works/pi-coding-agent version 2>/dev/null | tr -d ' ')"
      mkdir -p "$(dirname "$STAMP")" && touch "$STAMP"
      if [[ -n "$LATEST" && "$LATEST" != "$CUR" ]]; then
        info "Updating pi ${CUR:-?} -> ${LATEST}"
        if timeout 300 npm install -g --ignore-scripts @earendil-works/pi-coding-agent >/dev/null 2>&1; then
          ok "pi $(pi --version 2>/dev/null)"
        else
          warn "pi update failed — continuing on ${CUR:-the installed version}"
        fi
      fi
    else
      warn "PI_AUTO_UPDATE=1 but npm is not on PATH — skipping the update check"
    fi
  fi
fi

# forge has to answer before pi starts, or the first request fails inside pi's
# UI where the cause is much harder to see.
#
# TWO probes, not one, because forge 0.9 split them and conflating them produces
# a lie. /forge/health is forge's own liveness. /health is the BACKEND's
# readiness, forwarded — it returns 502 for the whole ~25 minute cold load of a
# model that is loading perfectly normally. Probing only /health (which is what
# this did until 2026-08-15) reports "forge is not answering" when forge is up
# and healthy and the only thing happening is that the weights are still being
# read off disk.
curl -fsS -m 5 -o /dev/null "${BASE}/forge/health" 2>/dev/null \
  || die "forge is not answering at ${BASE} — start it with ./scripts/up.sh"

curl -fsS -m 5 -o /dev/null "${BASE}/health" 2>/dev/null \
  || die "forge is up but the model is not loaded yet at ${BASE} — llama-server is
still reading the GGUF. Watch it with ./scripts/logs.sh llama, or measure real
progress with:
  docker exec ${LLAMA_CONTAINER:-qwen38-llama} sh -c 'grep ^rchar /proc/7/io'
A cold load of a 17.9 GB quant takes ~25 minutes on this box."

echo "pi -> ${BASE}  (model: ${MODEL}, ${CTX_FILES_NOTE}${THINK_NOTE}${MCP_NOTE}${BROWSER_NOTE}${RTK_NOTE}${STACK_NOTE}${LOOP_NOTE}${CGUARD_NOTE}${SUBAGENTS_NOTE}${PRINNY_NOTE})"
exec pi "${pi_flags[@]}" "${ARGS[@]}"
