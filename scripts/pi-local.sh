#!/usr/bin/env bash
#
# Run the pi coding agent (pi.dev) against the hosted Anthropic API.
#
#   ./scripts/pi-local.sh                 start a session
#   ./scripts/pi-local.sh -p "summarize"  any pi flag passes through
#   ./scripts/pi-local.sh --install-only  write ~/.pi/agent/models.json and stop
#   ./scripts/pi-local.sh --print-only    show the command without running it
#
# The name is historical: this launcher used to point pi at a local llama.cpp
# server behind the forge proxy. On the `anthropic` branch there is no local
# model, no proxy and no GPU — pi talks straight to api.anthropic.com over the
# Messages API, and the whole of the provider configuration is pi's own
# built-in `anthropic` provider plus the overrides written below.
#
# What this script still owns is everything that has to be true at launch and
# would otherwise be a knob nobody set: the API key, the prompt-cache tiers and
# warming policy, the three role models, and pi's compaction sizing. It reads
# them from .env and writes them into pi's agent directory, so the running
# session and the committed configuration cannot drift apart.

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

# The three roles this stack runs. One model per seat, and the seats are the
# whole design: the session that plans and verifies, the workers that read and
# implement, and one advisor that is only asked to think.
MAIN_MODEL="$(env_get ANTHROPIC_MODEL)";        : "${MAIN_MODEL:=claude-opus-5-5}"
SUBAGENT_ID="$(env_get ANTHROPIC_SUBAGENT_MODEL)"; : "${SUBAGENT_ID:=claude-haiku-5-5}"
ADVISOR_ID="$(env_get ANTHROPIC_ADVISOR_MODEL)";   : "${ADVISOR_ID:=claude-fable-5-1}"

# The window pi sizes its compaction against. Anthropic's Claude 5 family all
# report 1M; it is a floor for the arithmetic below, not a model id lookup, so
# a wrong value costs compaction timing rather than correctness.
CTX="$(env_get PI_CONTEXT_WINDOW)"; : "${CTX:=1000000}"

# Prompt-cache retention, in seconds, per tier — Anthropic's two ephemeral
# tiers, not ours to invent. A model that declares no lifetime for the active
# tier is simply never warmed (pi's own rule), so these are the switch.
CACHE_SHORT="$(env_get PI_CACHE_SHORT_SECONDS)"; : "${CACHE_SHORT:=300}"
CACHE_LONG="$(env_get PI_CACHE_LONG_SECONDS)";   : "${CACHE_LONG:=3600}"
CACHE_WARMING="$(env_get PI_CACHE_WARMING)";     : "${CACHE_WARMING:=idle}"
SHOW_CACHE_MISSES="$(env_get PI_SHOW_CACHE_MISS_NOTICES)"; : "${SHOW_CACHE_MISSES:=1}"

# The credential. env_get reads an already-exported variable first and then
# .env.local (gitignored) — never .env, which is tracked, so a key in .env would
# be a key in a public repository. .env.local.example carries the placeholder.
ANTHROPIC_KEY="$(env_get ANTHROPIC_API_KEY)"
[[ -n "$ANTHROPIC_KEY" ]] \
  || die "ANTHROPIC_API_KEY is not set. Put it in .env.local (gitignored):
  ANTHROPIC_API_KEY=sk-ant-...
or export it in the shell you launch from."
export ANTHROPIC_API_KEY="$ANTHROPIC_KEY"

# pi reads this itself and switches the Anthropic serializer's cache_control
# breakpoints from the 5-minute default to 1 hour. Exported rather than written
# into models.json because it is pi's variable, not a provider field.
CACHE_RETENTION="$(env_get PI_CACHE_RETENTION)"
[[ -n "$CACHE_RETENTION" ]] && export PI_CACHE_RETENTION="$CACHE_RETENTION"

# The endpoint, for the status line and for the model-listing probe below.
BASE="https://api.anthropic.com"

# AO10: `agent_dir` in lib.sh, not `${HOME}/.pi/agent`. This is where pi reads
# models.json and settings.json from, and it moves with PI_CODING_AGENT_DIR —
# two other sites in this file already knew that and this one did not, so on a
# relocated install the provider this script installs was written where pi does
# not look and `pi --list-models` showed no `forge` at all.
PI_DIR="$(agent_dir)"
MODELS_JSON="${PI_DIR}/models.json"

# --- generate models.json ----------------------------------------------------
# Merges into any existing file rather than overwriting it — pi keeps other
# providers here too, and clobbering the operator's whole model config to add one
# entry would be rude.
mkdir -p "$PI_DIR"
MODELS_JSON="$MODELS_JSON" MAIN_MODEL_ID="$MAIN_MODEL" SUBAGENT_MODEL_ID="$SUBAGENT_ID" \
ADVISOR_MODEL_ID="$ADVISOR_ID" CACHE_SHORT="$CACHE_SHORT" CACHE_LONG="$CACHE_LONG" \
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
anthropic = providers.setdefault("anthropic", {})

# pi's own `anthropic` provider already knows the endpoint, the wire and every
# Claude model: api `anthropic-messages` against https://api.anthropic.com,
# `x-api-key` + `anthropic-version: 2023-06-01`, and the full catalog. So nothing
# below redefines it. Two things are worth writing down rather than inheriting,
# because .env decides both and a value that lives only in someone's head is a
# value nobody can find later:
#
#   * the key. `$ANTHROPIC_API_KEY` is pi's own interpolation syntax, so this
#     file names the variable and never the secret — and never auth.json, which
#     is the other place pi would happily store one.
#   * promptCache, the model's best-effort cache lifetime in seconds per
#     retention tier. pi warms an idle prompt cache ONLY for a model that
#     declares a lifetime, so this is the switch the whole caching story hangs
#     off (see cacheWarming below, and PI_CACHE_RETENTION in .env). The tiers are
#     Anthropic's own — 5 minutes by default, 1 hour on the long tier.
#
# The models themselves are pi's, so a catalog refresh is what brings a new
# Claude id in: run `pi update --models`. modelOverrides only annotates ids pi
# already lists; it cannot invent one.
anthropic["apiKey"] = "$ANTHROPIC_API_KEY"

overrides = anthropic.setdefault("modelOverrides", {})
tiers = {"short": int(os.environ["CACHE_SHORT"]), "long": int(os.environ["CACHE_LONG"])}
for role in ("MAIN_MODEL_ID", "SUBAGENT_MODEL_ID", "ADVISOR_MODEL_ID"):
    overrides.setdefault(os.environ[role], {})["promptCache"] = dict(tiers)

path.write_text(json.dumps(data, indent=2) + "\n")
path.chmod(0o600)
print(f"wrote {path}")
PY

# --- pi settings: compaction, cache warming --------------------------------
#
# Written to pi's GLOBAL settings on purpose: the loop runs in whatever project
# you point it at, and a .pi/settings.json in this repo would only apply to
# sessions started here (and only when the project is trusted).
#
# Compaction. The arithmetic is inherited from the local-model branch, where
# pi's defaults (reserveTokens 16384, keepRecentTokens 20000) were sized for a
# 200k window and were actively harmful on 32k: measured against pi 0.84.2 and
# eight real sessions, the trigger fired at 50% while the actual compaction could
# not run until the context passed keepRecentTokens, so pi compacted every turn
# and freed nothing, and above ~87% full half the assistant turns came back
# empty. The formula below only ever TIGHTENS pi's defaults — at the 1M window
# the Claude 5 family reports it evaluates back to exactly 16384/20000, so it is
# a no-op there and live protection if PI_CONTEXT_WINDOW is set low.
#
# Cache warming. pi keeps an eligible provider prompt cache alive by re-sending
# the prefix before it expires, and it will only do so for a model that declares
# a cache lifetime — which is what promptCache in models.json is for. The
# default is "streaming" (warm during a run); "idle" also warms between runs,
# which is what a session with long gaps between turns actually needs, and pi
# refuses to warm at all unless it estimates the avoided cache-miss cost beats
# its own floor. showCacheMissNotices is on because the whole point of paying for
# cache writes is knowing when they are being thrown away.
CTX="$CTX" PI_DIR="$PI_DIR" CACHE_WARMING="$CACHE_WARMING" \
SHOW_CACHE_MISSES="$SHOW_CACHE_MISSES" python3 - <<'PY'
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

data["cacheWarming"] = os.environ["CACHE_WARMING"]
data["showCacheMissNotices"] = os.environ["SHOW_CACHE_MISSES"] == "1"

path.write_text(json.dumps(data, indent=2) + "\n")
print(f"wrote {path} (compaction: {compaction}, cacheWarming: {data['cacheWarming']})")
PY

if (( INSTALL_ONLY )); then
  dim "Provider 'anthropic' configured. Check with: pi --list-models"
  exit 0
fi

# --- launch ------------------------------------------------------------------
pi_flags=(--provider anthropic --model "$MAIN_MODEL")

# pi discovers AGENTS.md / CLAUDE.md by walking parent directories. Loaded by
# default: an agent that ignores the conventions file in the repo it is editing
# costs more in rework than the tokens save. PI_CONTEXT_FILES=0 passes -nc.
CTX_FILES_NOTE="context files off"
if [[ "$(env_get PI_CONTEXT_FILES)" == "1" ]]; then
  CTX_FILES_NOTE="context files on"
else
  pi_flags+=(-nc)
fi

# The tool-result guard, FIRST — before every other extension, deliberately.
#
# pi renders a tool result with `getTextOutput`, whose only input check is
# `if (!result) return ""`. That covers a missing result, not a result without
# `content`, and every wrong shape a tool can return is truthy — so a tool that
# does `return "some message"` reaches `"...".content.filter(...)`, which
# arrives from a render callback as an uncaughtException and exits pi mid-turn.
# It has cost this stack two sessions, both to vendor/prinny-channel
# (2026-08-30 action:status hitting its throttle, 2026-09-01 action:react with
# no message_id). Upstream has closed the missing guard `no-action` seven times.
#
# The fix is a `tool_result` handler, because that is the one point pi still
# lets a result be corrected: `afterToolCall` already computes `result.content
# ?? []` and then discards it unless some handler modified something. See
# vendor/pi-toolresult-guard/README.md for the whole mechanism, and its
# tests/pi-contract.test.ts, which pins the five pi shapes it depends on against
# the installed pi and says "delete this package" if pi ever guards the read.
#
# FIRST because `emitToolResult` runs handlers in extension order and each sees
# the previous one's edits: going first means every other tool_result handler in
# the session reads a content array that has already been made safe. It
# registers no tool and no command, so it costs nothing in the window.
TRGUARD_DIR="$REPO_ROOT/vendor/pi-toolresult-guard"
if [[ -r "$TRGUARD_DIR/extensions/index.ts" ]]; then
  pi_flags+=(-e "$TRGUARD_DIR/extensions/index.ts")
else
  warn "$TRGUARD_DIR is missing — a tool that returns a malformed result will exit pi this session."
fi

# Rewrites a browser-tool timeout into an instruction instead of a parameter
# dump. Loaded whenever the browser is, by absolute path for the same reasons as
# the extensions above. It registers no tools and no commands, so it costs
# nothing in the window; it only ever edits the text of a browser call that
# already failed.
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

    # AN4 (twenty-third pass). The two switches this block did not forward.
    #
    # The comment at the top of it states the rule they broke — "a value that
    # only ever lives in .env is a knob that silently does nothing" — and both
    # are documented as .env knobs where every one of their siblings lives:
    #
    #   SUBAGENT_TRANSCRIPT     agents/transcript-entry.ts   README.md:811
    #                           "…4,000 characters each; SUBAGENT_TRANSCRIPT=0
    #                            turns it off"
    #   SUBAGENT_VERIFY_LOG     agents/verify-log.ts         HANDOFF, 20th pass
    #                           "SUBAGENT_TRANSCRIPT=0 turns it off, as
    #                            SUBAGENT_VERIFY_LOG=0 does"
    #
    # Neither reached the process. Both defaults are ON and both write per
    # delegation — up to 60 session entries of 4,000 characters, and one JSONL
    # line per verifier model call — so the operator who went looking for the
    # switch is the operator who had a reason to.
    #
    # `SUBAGENT_VERIFY_LOG_FILE` comes with it: it is the other half of the same
    # module's contract and useless without a way to set it.
    #
    # `tests/env-switches.test.ts` in the package now scans its own sources for
    # `env.SUBAGENT_*` reads and fails when one of them is not named here, so
    # the third one cannot arrive the same way.
    SUBAGENT_TRANSCRIPT_VALUE="$(env_get SUBAGENT_TRANSCRIPT)"
    [[ -n "$SUBAGENT_TRANSCRIPT_VALUE" ]] && export SUBAGENT_TRANSCRIPT="$SUBAGENT_TRANSCRIPT_VALUE"

    SUBAGENT_VERIFY_LOG_VALUE="$(env_get SUBAGENT_VERIFY_LOG)"
    [[ -n "$SUBAGENT_VERIFY_LOG_VALUE" ]] && export SUBAGENT_VERIFY_LOG="$SUBAGENT_VERIFY_LOG_VALUE"

    SUBAGENT_VERIFY_LOG_FILE_VALUE="$(env_get SUBAGENT_VERIFY_LOG_FILE)"
    [[ -n "$SUBAGENT_VERIFY_LOG_FILE_VALUE" ]] && export SUBAGENT_VERIFY_LOG_FILE="$SUBAGENT_VERIFY_LOG_FILE_VALUE"

    # How deep delegation goes: 1 (unset) = only this session spawns; 2 = its
    # children may spawn one level further, through their own SubAgent tool
    # (vendor/pi-subagents-lite/src/spawn/build-context.ts). Orchestrator mode
    # below defaults it to 2.
    SUBAGENT_MAX_DEPTH_VALUE="$(env_get SUBAGENT_MAX_DEPTH)"
    [[ -n "$SUBAGENT_MAX_DEPTH_VALUE" ]] && export SUBAGENT_MAX_DEPTH="$SUBAGENT_MAX_DEPTH_VALUE"
  fi
fi

# Streams the session to instantcoffee-observe, the dashboard for this stack
# (https://github.com/coffeegrind123/instantcoffee-observe): prompts, tool calls,
# LLM generations with token counts and timing, compactions, and every
# subagent linked to the Agent call that spawned it. The extension registers no
# tools, so it costs the window nothing; a dashboard that is not running costs
# one failed request per ten seconds, never a stalled turn.
#
# It has to be handed to children explicitly: a child does not inherit -e, and
# SUBAGENT_EXTRA_EXTENSIONS REPLACES the fork's default list (rtk-pi) rather
# than adding to it, so this appends to whatever list is in effect. The
# extension is inert without OBSERVE_URL, which is what makes it safe for a
# child to also discover it under .pi/extensions/ when pi runs in this repo.
OBSERVE_EXT="$REPO_ROOT/.pi/extensions/observe/index.ts"
OBSERVE_NOTE=""
if [[ "$(env_get OBSERVE_ENABLED)" == "1" ]]; then
  if [[ ! -r "$OBSERVE_EXT" ]]; then
    warn "$OBSERVE_EXT is missing — this session will not reach observe."
  else
    # 127.0.0.1, not localhost: the dashboard binds IPv4 loopback, and
    # "localhost" may resolve to ::1 first — curl then falls back to IPv4 and
    # reports it reachable while Node's fetch in the extension is refused.
    #
    # Inside a container the dashboard is on the host instead. This is the one
    # place the launcher still needs to know which side of the socket it is on;
    # the model path no longer does, because api.anthropic.com is a name either
    # way.
    OBSERVE_HOST="127.0.0.1"
    [[ -f /.dockerenv ]] && OBSERVE_HOST="host.docker.internal"
    OBSERVE_URL_VALUE="$(env_get OBSERVE_URL)"
    # The port the stack's observe service publishes (docker-compose.yml).
    OBSERVE_PORT_VALUE="$(env_get OBSERVE_PORT)"
    : "${OBSERVE_URL_VALUE:=http://${OBSERVE_HOST}:${OBSERVE_PORT_VALUE:-4981}}"
    export OBSERVE_URL="${OBSERVE_URL_VALUE%/}"
    OBSERVE_SLUG_VALUE="$(env_get OBSERVE_PROJECT_SLUG)"
    [[ -n "$OBSERVE_SLUG_VALUE" ]] && export OBSERVE_PROJECT_SLUG="$OBSERVE_SLUG_VALUE"
    pi_flags+=(-e "$OBSERVE_EXT")

    if [[ -n "$SUBAGENTS_NOTE" ]]; then
      OBSERVE_EXTRAS="${SUBAGENT_EXTRA_EXTENSIONS-$REPO_ROOT/vendor/rtk-pi/extensions/index.ts}"
      export SUBAGENT_EXTRA_EXTENSIONS="${OBSERVE_EXTRAS:+$OBSERVE_EXTRAS,}$OBSERVE_EXT"
    fi

    # Said at launch rather than discovered later: a dashboard that is down is
    # not an error, but an operator expecting to watch the session should know.
    # Probed with the same client pi uses (Node's fetch), not curl: curl
    # retries other address families that the extension never will.
    if node -e 'fetch(process.argv[1] + "/api/health", { signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$OBSERVE_URL" >/dev/null 2>&1; then
      OBSERVE_NOTE=", observe"
    else
      OBSERVE_NOTE=", observe (not reachable at $OBSERVE_URL)"
    fi
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
    #
    # AN2 (twenty-third pass): ASK THE BOOTSTRAP, do not stat the entry. This
    # line used to test `runtime/dist/server.js` alone, which is true of a
    # runtime compiled from sources this checkout no longer has — measured on
    # this box at the time: the staged tree was missing `server/src/connect.ts`
    # entirely, the stamp was eight days behind the source, and this line said
    # nothing. The next start would then re-stage inside the connect budget
    # (about a minute of `npm install` and `tsc` against a 120s handshake that
    # already spends 27.5s importing the Matrix stack), which is the confusing
    # loop of timeouts `/prinny prepare` exists to prevent.
    #
    # `--staged` prints one word and exits 0 current / 1 stale / 2 absent. It
    # costs a node start and a sha256 over ~140KB, once, only with the channel
    # enabled.
    PRINNY_STATE="${PRINNY_STATE_DIR:-$(agent_dir)/channels/prinny}"
    PRINNY_STAGED="$(node "$PRINNY_DIR/server/bin/prinny-channel.mjs" --staged 2>/dev/null || true)"
    if [[ "$PRINNY_STAGED" == "absent" || -z "$PRINNY_STAGED" ]]; then
      dim "The prinny channel runtime is not built — run /prinny prepare once (~1 min)."
      PRINNY_NOTE=", /prinny (runtime not built)"
    elif [[ "$PRINNY_STAGED" == "stale" ]]; then
      dim "The prinny channel runtime was built from different sources — run /prinny prepare (~1 min)."
      PRINNY_NOTE=", /prinny (runtime stale)"
    elif [[ ! -f "$PRINNY_STATE/.env" ]]; then
      dim "The prinny channel has no credentials — run /prinny configure."
      PRINNY_NOTE=", /prinny (not configured)"
    fi
  else
    # A submodule since 2026-08-30 — vendor/prinny-channel lives in its own repo
    # (github.com/coffeegrind123/pi-prinny-channel) and is pinned here by commit.
    # A clone without --recurse-submodules leaves the directory EMPTY rather than
    # absent, which reads as a broken package instead of a missing flag.
    if [[ -d "$PRINNY_DIR" ]]; then
      warn "$PRINNY_DIR is empty — it is a git submodule that was never checked out."
      warn "Fix it once with: git submodule update --init --recursive"
    else
      warn "$PRINNY_DIR is missing — /prinny will not exist this session."
    fi
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

# /persona comes from vendor/pi-persona — a port of openclaude's /identity
# system (see vendor/pi-persona/FORK.md). Loaded by absolute path like everything
# above, so the same code runs whatever directory pi was started in.
#
# It needs no node_modules: its only bare import is pi's own package, which pi
# resolves from its own module root.
#
# On by DEFAULT, and that is a measured decision rather than an oversight. With
# no persona active it contributes ZERO tokens — `before_agent_start` returns
# undefined, and it registers no tool, so there is no schema to pay for on a turn
# that never uses it. The cost only appears once a persona IS active, and then it
# is large and worth knowing about: ~4,708 tokens of every request in `full`
# mode, ~2,718 in `lean`, against a 32,768-token window. `/persona status` prints
# the live number; the wire measurements are in FORK.md.
#
# Loaded AFTER vendor/rtk-pi and everything else, and the order matters for one
# reason: `before_agent_start` handlers CHAIN, each seeing the previous one's
# result as `event.systemPrompt`. This one PREPENDS its block, which is where
# openclaude puts it and why the persona is read as identity rather than as
# decoration on top of "you are a coding assistant". Running last means it is in
# front of everything any other extension appended, which is the position the
# block was written for.
PERSONA_DIR="$REPO_ROOT/vendor/pi-persona"
PERSONA_NOTE=""
if [[ "$(env_get PERSONA_ENABLED)" == "1" ]]; then
  if [[ -r "$PERSONA_DIR/extensions/index.ts" ]]; then
    pi_flags+=(-e "$PERSONA_DIR/extensions/index.ts")
    PERSONA_NOTE=", /persona"

    # Exported rather than passed as a flag: the extension reads both from
    # `process.env`, and a value that only ever lives in .env is a knob that
    # silently does nothing. Empty stays unset so the package's own defaults
    # apply — exporting an empty PERSONA_PROMPT_MODE would be a mode nobody
    # chose rather than "not configured".
    PERSONA_PROMPT_VALUE="$(env_get PERSONA_PROMPT_MODE)"
    [[ -n "$PERSONA_PROMPT_VALUE" ]] && export PERSONA_PROMPT_MODE="$PERSONA_PROMPT_VALUE"
    PERSONA_IMMERSION_VALUE="$(env_get PERSONA_IMMERSION)"
    [[ -n "$PERSONA_IMMERSION_VALUE" ]] && export PERSONA_IMMERSION="$PERSONA_IMMERSION_VALUE"

    # chub.ai's gateway key, if there is one. The extension sends NO key when
    # this is unset and both routes were measured answering 200 without one, so
    # this is optional in the strict sense — it is exported because an operator
    # who has a key wants it sent, not because anything breaks without it.
    #
    # Read through env_get, which means .env.local (gitignored) or the
    # environment, and NEVER .env — that file is tracked, and a key committed to
    # a public repo is the thing this whole arrangement exists to avoid.
    # .env.local.example carries the placeholder, not the value.
    CHUB_KEY_VALUE="$(env_get CHUB_API_KEY)"
    [[ -n "$CHUB_KEY_VALUE" ]] && export CHUB_API_KEY="$CHUB_KEY_VALUE"

    # Said at launch, where it can be acted on. A persona is global to the agent
    # home and survives restarts, so a session can inherit one adopted days ago
    # and pay for it without anything in the transcript saying so. The status
    # line shows it once the TUI is up; this shows it before the window is spent.
    PERSONA_ACTIVE_FILE="$(agent_dir)/PERSONA.md"
    [[ -r "$PERSONA_ACTIVE_FILE" ]] || PERSONA_ACTIVE_FILE="$(agent_dir)/IDENTITY.md"
    if [[ -r "$PERSONA_ACTIVE_FILE" ]]; then
      PERSONA_NAME="$(sed -n 's/.*persona of \([^.]*\)\..*/\1/p' "$PERSONA_ACTIVE_FILE" | head -n1)"
      PERSONA_NOTE=", /persona (${PERSONA_NAME:-active})"
      dim "A persona is active (${PERSONA_NAME:-unnamed}) — it costs ~2.7-4.7k tokens of every request."
      dim "Clear it with /persona clear, or see what it costs with /persona status."
    fi
  else
    # A submodule, since 2026-08-30 — vendor/pi-persona lives in its own repo
    # (github.com/coffeegrind123/pi-persona) and is pinned here by commit. A
    # clone without --recurse-submodules leaves the directory EMPTY rather than
    # absent, which reads as a broken package instead of a missing flag.
    if [[ -d "$PERSONA_DIR" ]]; then
      warn "$PERSONA_DIR is empty — it is a git submodule that was never checked out."
      warn "Fix it once with: git submodule update --init --recursive"
    else
      warn "$PERSONA_DIR is missing — /persona will not exist this session."
    fi
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
    ADAPTER_PKG="$(agent_dir)/npm/node_modules/pi-mcp-adapter/package.json"
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

# The web-content rules, whenever a browser is on the tool surface.
#
# This is the HIGHEST-AUTHORITY place available: pi's --append-system-prompt is
# repeatable and documented as taking text or file contents, so the rules land
# in the system prompt rather than in a skill the model may or may not consult.
#
# It is not sufficient on its own and is not meant to be. A system prompt is
# read once, at the top of the session; a hostile page arrives thousands of
# tokens later, mid-loop. The mechanical half is the envelope that
# scripts/untrusted_content.py and .pi/extensions/browser-guard.ts wrap around
# the returned bytes, which travels WITH the payload. Rules give the model the
# reason; the envelope puts that reason next to the attempt.
#
# Attached only when the browser is enabled: ~460 tokens is cheap against a
# 98,304-token window, and free when there is nothing to defend against.
WEB_RULES="$REPO_ROOT/prompts/web-untrusted.md"
WEB_RULES_NOTE=""
if [[ "$(env_get BROWSER_MCP_ENABLED)" == "1" ]]; then
  if [[ -r "$WEB_RULES" ]]; then
    pi_flags+=(--append-system-prompt "$(cat "$WEB_RULES")")
    WEB_RULES_NOTE=", web-content rules"
  else
    warn "$WEB_RULES is missing — the browser is enabled with no anti-injection rules in the system prompt."
  fi
fi

# THINK_LANG is gone on this branch, along with prompts/think-zh.md.
#
# It made the local model reason in Mandarin while answering in English, which
# was worth trying on a 27B whose reasoning was the weakest part of it. On a
# frontier model it is a workaround with nothing left to work around, and it
# costs a page of system prompt on every request — the opposite of what this
# branch is for. It also breaks prompt-cache reuse across sessions with a
# different THINK_LANG, which is now a first-class concern rather than a
# footnote.

# Orchestrator mode: opus coordinates and verifies, every subagent runs on
# haiku, and the advisor — the one seat that is only ever asked to think — runs
# on fable. Up to SUBAGENT_MAX_CONCURRENT children at once. See ORCHESTRATOR in
# .env and docs/orchestrator.md.
#
# Nothing here touches the operator's own subagent settings. The models and the
# per-provider cap go into a file this launch writes and the fork reads as its
# SESSION layer (vendor/pi-subagents-lite/src/config/mode-seed.ts), which every
# reset in /agents returns to — so a "clear" cannot quietly move the children
# onto the orchestrator's model and its price. The worker/explorer/advisor agent
# types come from prompts/orchestrator/agents through SUBAGENT_MODE_AGENTS_DIR,
# above the operator's global agents and below a project's own.
#
# `model` in that seed is the session DEFAULT every child inherits; `overrides`
# is keyed by agent type and sits ABOVE it in the fork's precedence (session
# type > session default > config type > config default > frontmatter > parent).
# That ordering is the only reason one role can hold a different model from its
# siblings, so it is worth naming rather than rediscovering.
ORCH_NOTE=""
ORCH_MAX_AGENTS_CEILING=15
if [[ "$(env_get ORCHESTRATOR)" == "1" ]]; then
  [[ -n "$SUBAGENTS_NOTE" ]] \
    || die "ORCHESTRATOR=1 needs the subagent extension loaded (SUBAGENTS_ENABLED=1, and see the warning above if it is set)."

  ORCH_MODEL="$(env_get SUBAGENT_MODEL)"
  ORCH_MODEL="${ORCH_MODEL:-anthropic/${SUBAGENT_ID}}"
  [[ "$ORCH_MODEL" =~ ^[^/[:space:]]+/[^[:space:]]+$ ]] \
    || die "SUBAGENT_MODEL must be provider/model-id, got '$ORCH_MODEL'."
  ORCH_PROVIDER="${ORCH_MODEL%%/*}"
  ORCH_MODEL_ID="${ORCH_MODEL#*/}"

  ORCH_ADVISOR="$(env_get ADVISOR_MODEL)"
  ORCH_ADVISOR="${ORCH_ADVISOR:-anthropic/${ADVISOR_ID}}"
  [[ "$ORCH_ADVISOR" =~ ^[^/[:space:]]+/[^[:space:]]+$ ]] \
    || die "ADVISOR_MODEL must be provider/model-id, got '$ORCH_ADVISOR'."
  ORCH_ADVISOR_ID="${ORCH_ADVISOR#*/}"

  ORCH_CAP="$(env_get SUBAGENT_MAX_CONCURRENT)"
  ORCH_CAP="${ORCH_CAP:-$ORCH_MAX_AGENTS_CEILING}"
  [[ "$ORCH_CAP" =~ ^[0-9]+$ ]] && (( ORCH_CAP >= 1 && ORCH_CAP <= ORCH_MAX_AGENTS_CEILING )) \
    || die "SUBAGENT_MAX_CONCURRENT must be 1-${ORCH_MAX_AGENTS_CEILING}, got '$ORCH_CAP'."

  # Positive check, not an assumption: pi lists a model only when its provider
  # is known AND has credentials, so an unknown id and a missing key both fail
  # here instead of as a spawn error inside the session. It does not prove the
  # key is VALID — the first spawn does.
  #
  # Both the child model and the advisor are checked, and the advisor especially:
  # a model id the catalog does not know is how a seat silently ends up on
  # whatever the parent is running, which is the one failure this branch exists
  # to prevent. `pi update --models` is the fix, because the published catalog
  # moves ahead of the one bundled with the installed pi.
  for pair in "${ORCH_PROVIDER}:${ORCH_MODEL_ID}" "${ORCH_PROVIDER}:${ORCH_ADVISOR_ID}"; do
    if ! pi --list-models "${pair#*:}" 2>/dev/null \
         | awk -v p="${pair%%:*}" -v m="${pair#*:}" '$1 == p && $2 == m { found = 1 } END { exit !found }'; then
      die "pi does not list ${pair%%:*}/${pair#*:} (unknown to this pi $(pi --version 2>/dev/null), or no credentials for '${pair%%:*}'). Refresh the catalog with: pi update --models"
    fi
  done

  ORCH_SEED="$PI_DIR/orchestrator-mode.json"
  ORCH_MODEL="$ORCH_MODEL" ORCH_PROVIDER="$ORCH_PROVIDER" ORCH_ADVISOR="$ORCH_ADVISOR" \
  ORCH_CAP="$ORCH_CAP" ORCH_SEED="$ORCH_SEED" \
  python3 - <<'PY'
import json, os
seed = {
    # The session default: every child inherits this unless an override below
    # names its agent type. One child running on the orchestrator's model is a
    # bill nobody chose, so the default is the cheap seat.
    "model": os.environ["ORCH_MODEL"],
    # The advisor is the only seat on the planning model. A per-agent-type entry
    # sits above the session default, not under it.
    "overrides": {"advisor": os.environ["ORCH_ADVISOR"]},
    "concurrency": {"providers": {os.environ["ORCH_PROVIDER"]: int(os.environ["ORCH_CAP"])}},
}
with open(os.environ["ORCH_SEED"], "w") as fh:
    json.dump(seed, fh, indent=2)
PY
  export SUBAGENT_MODE_CONFIG="$ORCH_SEED"

  # No answer judge in this mode, whatever SUBAGENT_VERIFY says: the
  # orchestrator re-runs every claimed check itself, which is a stronger check
  # than a one-turn judge reading the answer, and the judge would add a model
  # call per child.
  export SUBAGENT_VERIFY=0
  SUBAGENTS_NOTE="${SUBAGENTS_NOTE/, subagents (unverified)/, subagents}"

  # Two levels unless .env says otherwise: workers may split their item among
  # helpers, which may not split further. Each level has its own concurrency
  # pool of SUBAGENT_MAX_CONCURRENT, so a full level of waiting workers cannot
  # starve their own helpers.
  export SUBAGENT_MAX_DEPTH="${SUBAGENT_MAX_DEPTH_VALUE:-2}"
  [[ "$SUBAGENT_MAX_DEPTH" == "1" || "$SUBAGENT_MAX_DEPTH" == "2" ]] \
    || die "SUBAGENT_MAX_DEPTH must be 1 or 2, got '$SUBAGENT_MAX_DEPTH'."

  ORCH_AGENTS="$REPO_ROOT/prompts/orchestrator/agents"
  [[ -r "$ORCH_AGENTS/worker.md" && -r "$ORCH_AGENTS/explorer.md" && -r "$ORCH_AGENTS/advisor.md" ]] \
    || die "$ORCH_AGENTS is missing its worker/explorer/advisor agent types."
  export SUBAGENT_MODE_AGENTS_DIR="$ORCH_AGENTS"

  ORCH_PROMPT="$REPO_ROOT/prompts/orchestrator/main.md"
  [[ -r "$ORCH_PROMPT" ]] || die "$ORCH_PROMPT is missing."
  ORCH_TEXT="$(cat "$ORCH_PROMPT")"
  ORCH_TEXT="${ORCH_TEXT//\{\{MAX_AGENTS\}\}/$ORCH_CAP}"
  ORCH_TEXT="${ORCH_TEXT//\{\{SUBAGENT_MODEL\}\}/$ORCH_MODEL}"
  ORCH_TEXT="${ORCH_TEXT//\{\{ADVISOR_MODEL\}\}/$ORCH_ADVISOR}"
  ORCH_TEXT="${ORCH_TEXT//\{\{MAX_DEPTH\}\}/$SUBAGENT_MAX_DEPTH}"
  [[ "$ORCH_TEXT" != *"{{"* ]] || die "$ORCH_PROMPT has a placeholder this launcher does not fill."
  pi_flags+=(--append-system-prompt "$ORCH_TEXT")
  ORCH_NOTE=", orchestrator (${ORCH_CAP}x ${ORCH_MODEL}, advisor ${ORCH_ADVISOR}, depth ${SUBAGENT_MAX_DEPTH})"
fi

# The delegation nudge, whenever subagents are actually registered.
#
# NOT in orchestrator mode: it tells the model that agents share one slot and
# to prefer one well-scoped agent, which is the opposite of that mode's premise.
#
# Same lever and same reasoning as the web rules above: --append-system-prompt is
# the highest-authority place available, and this belongs there rather than in a
# skill the model may or may not consult — a skill it never opens cannot tell it
# to delegate.
#
# GATED ON SUBAGENTS_ENABLED, not just on SUBAGENT_NUDGE. A fragment describing
# an `Agent` tool that was never registered is not a harmless no-op: it invites
# the model to call something that does not exist, and a failed tool call costs
# a turn and an apology. Both switches must be on.
#
# The fragment deliberately carries a THRESHOLD as well as encouragement (~five
# file reads or three searches). FORK.md measured that a child which grows to
# ~18k tokens evicts the parent's prefix cache and costs it a full re-prefill —
# 442 ms to 2,949 ms on a small parent — so "delegate more" without a floor
# would trade cheap reads for expensive ones. See SUBAGENT_NUDGE in .env.
DELEGATE_RULES="$REPO_ROOT/prompts/delegate.md"
DELEGATE_NOTE=""
if [[ "$(env_get SUBAGENTS_ENABLED)" == "1" && "$(env_get SUBAGENT_NUDGE)" == "1" && -z "$ORCH_NOTE" ]]; then
  if [[ -r "$DELEGATE_RULES" ]]; then
    pi_flags+=(--append-system-prompt "$(cat "$DELEGATE_RULES")")
    DELEGATE_NOTE=", delegation nudge"
  else
    warn "$DELEGATE_RULES is missing — subagents are registered with nothing telling the model to use them."
  fi
fi

if (( PRINT_ONLY )); then
  printf 'pi'; printf ' %q' "${pi_flags[@]}"; printf '\n'
  exit 0
fi

command -v pi >/dev/null 2>&1 \
  || die "pi is not installed — npm install -g --ignore-scripts @earendil-works/pi-coding-agent"

# --- model catalog -----------------------------------------------------------
# The catalog bundled with the installed pi lags the published one, and the lag
# is not cosmetic: pi 0.85.1 ships no `claude-opus-5-5`, no `claude-haiku-5-5`
# and no `claude-sonnet-5-5`. Before a refresh the anthropic provider lists 14
# models; after one it lists 17. So a launch on a model the bundle does not know
# would fail its own `--list-models` probe — or worse, a role silently falls back
# to the parent's model.
#
# Fails SOFT: a registry round trip is not worth blocking a session for, and a
# catalog refresh is additive. The probe in orchestrator mode above is what
# actually refuses a model that is still missing.
if [[ "$(env_get PI_UPDATE_MODELS_ON_LAUNCH)" != "0" ]]; then
  timeout 60 pi update --models >/dev/null 2>&1 \
    && CATALOG_NOTE=", catalog refreshed" \
    || CATALOG_NOTE=", catalog refresh failed"
else
  CATALOG_NOTE=""
fi

# --- keep pi current ---------------------------------------------------------
# pi ships often and the stack is only ever tested against the current release.
# Checked at most once per PI_UPDATE_INTERVAL_H hours (a stamp file), because a
# registry round trip on every launch is latency you would feel.
#
# Fails SOFT, always: no npm, no network, a registry hiccup — warn and launch on
# what is installed. An agent session must never be blocked by an update check.
if [[ "$(env_get PI_AUTO_UPDATE)" == "1" ]]; then
  STAMP="${PI_DIR}/.last-update-check"
  INTERVAL_H="$(env_get PI_UPDATE_INTERVAL_H)"; : "${INTERVAL_H:=24}"
  AGE_H=$(( INTERVAL_H + 1 ))
  [[ -f "$STAMP" ]] && AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$STAMP" 2>/dev/null || echo 0) ) / 3600 ))
  if (( AGE_H >= INTERVAL_H )); then
    if command -v npm >/dev/null 2>&1; then
      # Both substitutions are guarded with `|| true`, and that is not
      # decoration. lib.sh runs `set -euo pipefail`, and under `set -e` an
      # unguarded `X="$(failing-command)"` is FATAL — so this block, whose whole
      # written purpose two paragraphs up is "fails SOFT, always: no npm, no
      # network, a registry hiccup", used to kill the launch outright and print
      # nothing at all when the registry could not be reached. The failure mode
      # was the one the comment promised could not happen.
      CUR="$(pi --version 2>/dev/null | tr -d ' ' || true)"
      LATEST="$(timeout 20 npm view @earendil-works/pi-coding-agent version 2>/dev/null | tr -d ' ' || true)"
      mkdir -p "$(dirname "$STAMP")" 2>/dev/null && touch "$STAMP" 2>/dev/null \
        || warn "could not write the update stamp ${STAMP} — the check will just run again next launch"
      if [[ -n "$LATEST" && "$LATEST" != "$CUR" ]]; then
        info "Updating pi ${CUR:-?} -> ${LATEST}"
        if timeout 300 npm install -g --ignore-scripts @earendil-works/pi-coding-agent >/dev/null 2>&1; then
          ok "pi $(pi --version 2>/dev/null)"
          # Same rule as above: a failing command on the LAST line of a `then`
          # block is fatal under `set -e`, and `a && b` counts as one failing
          # command when `a` fails.
          pi update --models >/dev/null 2>&1 \
            && CATALOG_NOTE=", catalog refreshed" \
            || warn "the model catalog did not refresh — a new Claude id may be missing from pi --list-models"
        else
          warn "pi update failed — continuing on ${CUR:-the installed version}"
        fi
      fi
    else
      warn "PI_AUTO_UPDATE=1 but npm is not on PATH — skipping the update check"
    fi
  fi
fi

echo "pi -> ${BASE}  (model: ${MAIN_MODEL}, subagents: ${SUBAGENT_ID}, advisor: ${ADVISOR_ID}, cache: ${CACHE_WARMING}/$(env_get PI_CACHE_RETENTION || echo short)${CATALOG_NOTE}, ${CTX_FILES_NOTE}${MCP_NOTE}${BROWSER_NOTE}${WEB_RULES_NOTE}${DELEGATE_NOTE}${RTK_NOTE}${LOOP_NOTE}${CGUARD_NOTE}${SUBAGENTS_NOTE}${ORCH_NOTE}${PRINNY_NOTE}${PERSONA_NOTE}${OBSERVE_NOTE})"
exec pi "${pi_flags[@]}" "${ARGS[@]}"
