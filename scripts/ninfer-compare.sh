#!/usr/bin/env bash
#
# Measure ninfer-4090 against llama.cpp on this card, in matched units.
#
#   ./scripts/ninfer-compare.sh                    # matched-context arms
#   ./scripts/ninfer-compare.sh --ninfer-only      # skip the llama arm
#   ./scripts/ninfer-compare.sh --prompt-tokens 32768 --repeat 5
#   ./scripts/ninfer-compare.sh --wide             # add ninfer's 262K arm
#   ./scripts/ninfer-compare.sh --restore-only     # put the stack back, measure nothing
#
# WHY THE TWO ENGINES CANNOT BE INTERLEAVED
#
# bench_cross_engine.py interleaves its arms round by round so that drift lands
# on both. That is impossible here: the ninfer artifact is ~17 GiB and llama
# holds ~20 GiB, so on one 24 GiB card only one of them can be resident. The
# arms therefore run SEQUENTIALLY, and the defences against drift are (a) run
# them back to back on a quiet box, (b) repeat each arm and report the spread
# rather than a single number, and (c) record the load average at each arm so a
# reader can see whether the box changed underneath the measurement.
#
# RUN THIS ON A QUIET BOX. That is not a style note. A leftover bench container
# holding llama's single slot once pushed TTFT on a ~1300-token prompt from
# ~2 s to 11-17 s, rising with prompt length, reproducible across rounds -- it
# looked exactly like a real engine stall and was queue wait. See the retraction
# in scripts/bench_cross_engine.py. This script refuses to start if anything
# else is already on the GPU or if stray bench containers are alive.
#
# WHAT IS MATCHED, AND WHAT CANNOT BE
#
# Matched: the card, the prompts (same generator, same token targets, fresh
# nonce per request), the context window, ~8-bit KV on both sides, MTP-family
# speculative decoding on both sides, and the measurement (wall clock at the
# socket, through each engine's OpenAI endpoint).
#
# NOT matched, and stated rather than hidden:
#   * The WEIGHTS. llama serves whatever GGUF_FILE names -- by default the
#     orcarouter Q4_K_M fine-tune (16.96 GiB) -- while ninfer serves the
#     official groupwise-int artifact (16.96 GiB). Different quantisations, and
#     for the default GGUF a different FINE-TUNE. So a decode-rate difference is
#     engine AND weights, and this script does not try to separate them.
#     To narrow it, point the stack at unsloth UD-Q4_K_XL (already on disk, and
#     the same GGUF sergiuszm's published comparison used) via .env and
#     ./scripts/mode.sh, then re-run. There is deliberately no flag for that
#     here: switching GGUF means rewriting .env and a cold reload, which is
#     capacity-probe.sh's job and its .env-restore discipline, not this one's.
#   * The CHAT TEMPLATE. The orcarouter GGUF carries Qwen's stock 8952-char
#     template, unsloth's a 9993-char fork, and ninfer pins the official file.
#     Worth a few tokens of wrapper, which is why prompt_tokens is reported per
#     arm instead of assumed equal.
#   * REASONING. This stack pins REASONING_EFFORT=medium and ninfer is run with
#     --preserve-thinking, but the two engines need not spend the same number of
#     thinking tokens on the same prompt. Decode RATE is unaffected; time-to-
#     answer is, and this script does not claim to measure time-to-answer.
#
# ASYMMETRY IN THE CACHE GUARD, AND WHY PREFIX REUSE STAYS ON ANYWAY
#
# llama reports usage.prompt_tokens_details.cached_tokens, so bench_cross_engine
# can DETECT a prefix-cache hit on that arm and withhold the prefill rate.
# ninfer sends no equivalent field, so on its arm the leading per-request nonce
# is the ONLY defence -- there is no independent confirmation that a prefill
# actually ran. That asymmetry is real and is not fixable from here.
#
# ninfer does have --no-prefix-reuse, which would make its prefill honest by
# construction. It is deliberately NOT used: llama runs with --cache-prompt on,
# that is the production configuration on both sides, and disabling reuse on one
# arm only would stop the two being like-for-like. The nonce leads the prompt,
# so no two requests share anything past the chat-template preamble.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# AFTER the source, NOT before -- lib.sh line 4 turns errexit back ON, and
# `set -uo pipefail` above does not undo it. Same trap that wedged four
# ppl-cliff runs; see HANDOFF.md section 1. restore() below kills containers
# that may already be gone, which returns non-zero, which under errexit would
# kill this script before it restarted llama.
set +e

require_cmd docker python3

# Docker Desktop bind-mounts the WINDOWS side of this 9p mount, so a source path
# given as /home/claudeuser/... resolves to a DIVERGENT view in which files this
# container wrote are invisible. Every working mount in this stack uses the
# //c/... form and so must these. ~/ == C:\users\user\downloads\as\data.
WIN_HOME="//c/users/user/downloads/as/data"
case "$REPO_ROOT" in
  /home/claudeuser/*) WIN_REPO="${WIN_HOME}/${REPO_ROOT#/home/claudeuser/}" ;;
  *) die "REPO_ROOT is $REPO_ROOT, outside the 9p mount at /home/claudeuser.
The Windows path mapping this script needs for bind mounts does not apply.
Set WIN_REPO by hand and remove this guard if you know the right path." ;;
esac

NINFER_IMAGE="${NINFER_IMAGE:-ninfer-4090:sm89}"
NINFER_CT="ninfer-bench"
NINFER_ARTIFACT="${NINFER_ARTIFACT:-qwen3_8_27b.ninfer}"
LLAMA_CT="instantcoffee-llama"
NETWORK="${NINFER_NETWORK:-instantcoffee_default}"

PROMPT_TOKENS=8192
PREDICT=128
REPEAT=3
RUN_LLAMA=1
RUN_NINFER=1
WIDE=0
RESTORE_ONLY=0
KV_DTYPE="int8"
CONTEXT=""
OUT_DIR="${REPO_ROOT}/.ninfer-compare"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt-tokens) PROMPT_TOKENS="$2"; shift 2 ;;
    --predict)       PREDICT="$2"; shift 2 ;;
    --repeat)        REPEAT="$2"; shift 2 ;;
    --context)       CONTEXT="$2"; shift 2 ;;
    --kv-dtype)      KV_DTYPE="$2"; shift 2 ;;
    --ninfer-only)   RUN_LLAMA=0; shift ;;
    --llama-only)    RUN_NINFER=0; shift ;;
    --wide)          WIDE=1; shift ;;
    --restore-only)  RESTORE_ONLY=1; shift ;;
    --out)           OUT_DIR="$2"; shift 2 ;;
    -h|--help)       sed -n '2,/^set -uo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Match llama's live window unless told otherwise, so the KV cache is the same
# size on both sides and the comparison is not secretly a memory-pressure test.
if [[ -z "$CONTEXT" ]]; then
  CONTEXT="$(env_get CTX_SIZE 2>/dev/null || echo 98304)"
fi

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
# A --restore-only run is not a measurement and must never be mistaken for one
# when someone lists this directory later, so it is named for what it is.
RUN_DIR="$OUT_DIR/$STAMP$([[ "$RESTORE_ONLY" -eq 1 ]] && echo "-restore")"
mkdir -p "$RUN_DIR"
# 0777, and it is not laziness. This directory is created here as root and then
# bind-mounted into the bench container as /out, where bench_cross_engine.py
# runs as the forge image's NON-ROOT user -- so on 2026-09-03 the llama arm
# finished its three rounds, printed its table, and then died on
# `PermissionError: [Errno 13] ... '/out/llama.json'`, losing every
# engine-native counter it had just collected. The console table survived only
# because bench_arm tees it. The failure comes AFTER the measurement, so it
# destroys results that cost GPU time and cannot be recovered without re-running
# the arm.
chmod 0777 "$RUN_DIR"

# --- provenance --------------------------------------------------------------
# Same discipline as run.meta: a measurement that cannot say what produced it is
# not a measurement. Backfilling this later is exactly what the 2026-09-03
# session had to do after pairing runs across a silent model change.
write_meta() {
  {
    echo "stamp=$STAMP"
    echo "context=$CONTEXT"
    echo "prompt_tokens_target=$PROMPT_TOKENS"
    echo "predict=$PREDICT"
    echo "repeat=$REPEAT"
    echo "kv_dtype_ninfer=$KV_DTYPE"
    echo "ninfer_image=$NINFER_IMAGE"
    echo "ninfer_artifact=$NINFER_ARTIFACT"
    echo "ninfer_image_id=$(docker image inspect "$NINFER_IMAGE" --format '{{.Id}}' 2>/dev/null || echo unknown)"
    echo "llama_gguf=$(env_get GGUF_FILE 2>/dev/null || echo unknown)"
    echo "llama_model_repo=$(env_get MODEL_REPO 2>/dev/null || echo unknown)"
    echo "llama_spec_type=$(env_get SPEC_TYPE 2>/dev/null || echo unknown)"
    echo "llama_cache_type_k=$(env_get CACHE_TYPE_K 2>/dev/null || echo unknown)"
    # Both of these size the prompt-cache entry whose save blocks llama's main
    # loop between rounds -- the confound cache_stalls() below reports. A run
    # that cannot say what they were cannot be compared with another.
    echo "llama_cache_ram=$(env_get CACHE_RAM 2>/dev/null || echo unknown)"
    echo "llama_ctx_checkpoints=$(env_get CTX_CHECKPOINTS 2>/dev/null || echo unknown)"
    echo "llama_image=$(docker inspect "$LLAMA_CT" --format '{{.Config.Image}}' 2>/dev/null || echo unknown)"
    echo "git_head=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "gpu=$(docker exec "$LLAMA_CT" nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv,noheader 2>/dev/null || echo unknown)"
    echo "loadavg_at_start=$(cut -d' ' -f1-3 /proc/loadavg)"
  } > "$RUN_DIR/run.meta"
}

# --- the quiet-box gate ------------------------------------------------------
preflight() {
  local strays
  strays="$(docker ps -q --filter 'name=instantcoffee-bench-run' | wc -l)"
  if [[ "$strays" -gt 0 ]]; then
    docker ps --filter 'name=instantcoffee-bench-run' --format '  {{.Names}}  {{.Status}}'
    die "$strays stray bench container(s) are alive and will queue on llama's \
one slot. That contamination once produced an 11-17 s TTFT that looked like a \
real prompt-proportional stall. Remove them first: \
docker rm -f \$(docker ps -aq --filter name=instantcoffee-bench-run)"
  fi

  local load
  load="$(cut -d' ' -f1 /proc/loadavg)"
  if awk "BEGIN{exit !($load > 4.0)}"; then
    warn "load average is $load — measurements taken now will be contaminated."
    warn "This is the single largest error source in this script. Continuing anyway;"
    warn "treat any surprising number as the box, not the engine, until re-run quiet."
  fi

  if [[ "$RUN_NINFER" -eq 1 ]]; then
    docker image inspect "$NINFER_IMAGE" >/dev/null 2>&1 \
      || die "image $NINFER_IMAGE not found — build it first: \
(cd ~/ninfer-4090 && docker build --tag $NINFER_IMAGE .)"
  fi
}

# --- restore -----------------------------------------------------------------
# Every path out of this script goes through here, including the error paths.
# It must be safe to run twice and safe to run when nothing needs restoring:
# `docker rm -f` on an absent container returns non-zero, and that non-zero is
# precisely what killed the ppl-cliff runners under errexit.
RESTORED=0
restore() {
  local rc=$?
  echo "$(date +%H:%M:%S)  restore entered (caller rc=$rc)" >> "$RUN_DIR/restore.log"
  [[ "$RESTORED" -eq 1 ]] && return 0
  RESTORED=1

  docker rm -f "$NINFER_CT" >/dev/null 2>&1
  echo "  ninfer rm rc=$?" >> "$RUN_DIR/restore.log"

  if [[ "$(docker inspect -f '{{.State.Running}}' "$LLAMA_CT" 2>/dev/null)" != "true" ]]; then
    info "restarting $LLAMA_CT"
    docker start "$LLAMA_CT" >/dev/null 2>&1
    echo "  llama start rc=$?" >> "$RUN_DIR/restore.log"
  else
    echo "  llama already running" >> "$RUN_DIR/restore.log"
  fi
  return 0
}
trap restore EXIT INT TERM

# --- --restore-only ----------------------------------------------------------
#
# PUT THE STACK BACK, WITHOUT MEASURING ANYTHING.
#
# The trap above is entered on INT/TERM and works -- attempt 4 on 2026-09-03 was
# stopped from outside and restore() completed unaided. But it is not proof
# against a SECOND signal: attempt 3 took one while restore was still running
# and stopped between `docker rm -f` and `docker start`, leaving ninfer holding
# ~22 GiB of VRAM and llama `Exited (137)`. Recovering that meant remembering
# two commands and a five-minute wait, at the exact moment the operator has
# least context.
#
# So the same code path is reachable from outside the run that needed it:
#
#     ./scripts/ninfer-compare.sh --restore-only
#
# It is deliberately safe to run when nothing needs restoring -- `docker rm -f`
# on an absent container and an already-running llama are both normal outcomes,
# not errors -- so it can be the reflex after any interrupted run without first
# working out whether it was necessary.
if [[ "$RESTORE_ONLY" -eq 1 ]]; then
  info "restore-only: removing $NINFER_CT if present, starting $LLAMA_CT if stopped"
  restore
  cat "$RUN_DIR/restore.log"
  # Say which of the three states it is actually in. "Running" alone would tell
  # an operator to wait five minutes for a container that was already healthy,
  # and a wrong instruction is worse than none at the point where someone is
  # recovering from an interrupted run.
  if [[ "$(docker inspect -f '{{.State.Running}}' "$LLAMA_CT" 2>/dev/null)" != "true" ]]; then
    warn "$LLAMA_CT is NOT running and could not be started; check: docker logs $LLAMA_CT"
  elif [[ "$(docker inspect -f '{{.State.Health.Status}}' "$LLAMA_CT" 2>/dev/null)" == "healthy" ]]; then
    ok "$LLAMA_CT is up and healthy — nothing to wait for"
  else
    ok "$LLAMA_CT is running but still loading — expect ~5 minutes before /health returns 200"
  fi
  # RESTORED is already 1, so the EXIT trap will not run it a second time.
  exit 0
fi

# --- arms --------------------------------------------------------------------
bench_arm() {
  local label="$1" url="$2" out="$3"
  info "benching $label at $url"
  echo "loadavg_before_$label=$(cut -d' ' -f1-3 /proc/loadavg)" >> "$RUN_DIR/run.meta"
  local arm_start; arm_start="$(date -u +%s)"
  # SAMPLE LOAD *DURING* THE ARM, not just side to side.
  #
  # On 2026-09-04 run 20260904-102103 recorded loadavg_before_ninfer=41.35 and
  # loadavg_after_ninfer=72.40 against loadavg_before_llama=1.96 -- so the two
  # arms were measured on what was effectively two different machines, and the
  # ninfer numbers could not be quoted. Two endpoints and a lagging 5-minute
  # average cannot tell a self-inflicted spike (ninfer runs with host-kv=8.00
  # GiB on a 22 GiB box) from another session's build. A 5-second series can.
  ( while :; do
      echo "$(date -u +%H:%M:%S) $(cut -d' ' -f1-3 /proc/loadavg)"
      sleep 5
    done ) > "$RUN_DIR/$label.loadavg" 2>/dev/null &
  local sampler=$!
  # The bench image bakes /work in at build time -- it is NOT a bind mount --
  # so both the script and the output directory have to be mounted explicitly.
  # Without the output mount the --json file is written inside the container and
  # vanishes with it on --rm, leaving only the console table.
  compose --profile tools run --rm \
    -v "$WIN_REPO/scripts/bench_cross_engine.py:/work/scripts/bench_cross_engine.py:ro" \
    -v "$WIN_REPO/.ninfer-compare/$STAMP:/out" \
    --entrypoint python bench /work/scripts/bench_cross_engine.py \
    --url "$url" --label "$label" \
    --prompt-tokens "$PROMPT_TOKENS" --predict "$PREDICT" --repeat "$REPEAT" \
    --json "/out/$out" 2>&1 | tee "$RUN_DIR/$label.log"
  kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
  echo "loadavg_after_$label=$(cut -d' ' -f1-3 /proc/loadavg)" >> "$RUN_DIR/run.meta"
  # The peak is what disqualifies a measurement, and it is the one number an
  # endpoint pair reliably misses.
  if [[ -s "$RUN_DIR/$label.loadavg" ]]; then
    awk -v label="$label" '
      {n++; if ($2+0 > max) max=$2+0; sum+=$2+0}
      END {if (n) printf "loadavg_during_%s=n=%d peak=%.2f mean=%.2f\n", label, n, max, sum/n}
    ' "$RUN_DIR/$label.loadavg" >> "$RUN_DIR/run.meta"
  fi
  # A payload reduction is a REAL DIFFERENCE BETWEEN THE ARMS. It is negotiated
  # inside the bench and would otherwise live only in that arm's console log and
  # its own JSON -- so lift it into run.meta, which is the file anyone comparing
  # two runs actually opens. "full" is written explicitly rather than omitted:
  # an absent key reads as "not recorded", which is not the same as "nothing was
  # dropped", and this is exactly the sort of caveat that goes missing.
  if [[ -s "$RUN_DIR/$out" ]]; then
    python3 - "$RUN_DIR/$out" "$label" >> "$RUN_DIR/run.meta" <<'PYRED'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as exc:
    print(f"payload_{sys.argv[2]}=unreadable ({type(exc).__name__})")
    raise SystemExit(0)
label = sys.argv[2]
adj = (d.get("payload_adjustments") or {}).get(label)
print(f"payload_{label}=" + (",".join(adj) if adj else "full"))
mid = (d.get("payload_model_ids") or {}).get(label)
if mid:
    print(f"payload_model_id_{label}={mid}")
note = (d.get("payload_notes") or {}).get(label)
if note:
    print(f"payload_note_{label}={note}")
PYRED
  fi
  cache_stalls "$label" "$arm_start"
  # The ninfer log captured at readiness stops at "listening" and therefore
  # contains nothing about the REQUESTS. On 2026-09-03 every ninfer round
  # returned 400 and the only record of it was the bench's own one-line
  # summary; the engine's account of why was overwritten by restore before
  # anyone could read it. Re-capture after the arm, into a separate file so the
  # readiness snapshot is still there to compare against.
  if [[ "$(docker inspect -f '{{.State.Running}}' "$NINFER_CT" 2>/dev/null)" == "true" ]]; then
    docker logs "$NINFER_CT" > "$RUN_DIR/$label.engine-after.log" 2>&1
  fi
}

# --- the confound this comparison would otherwise hide -----------------------
#
# THE LLAMA ARM PAYS A TAX THE NINFER ARM DOES NOT, AND IT LANDS INSIDE WALL
# CLOCK BUT NOT INSIDE prompt_ms.
#
# bench_cross_engine gives every request a fresh nonce, so on llama every round
# after the first takes the slot from a DIFFERENT prompt -- which makes
# llama-server save the old slot state into its `--cache-ram 2048` prompt cache
# before prefill starts. On this hybrid model that entry is ~1.78 GiB at 30k
# tokens (48 of 64 layers hold a constant-size recurrent state, so even a
# 34-token prompt occupies 300 MiB, and each --ctx-checkpoints copy adds ~150
# MiB), the cache holds one of them, and the switch evicts and re-copies the
# lot.
#
# Measured on this box 2026-09-03: usually 1.3-2.9 s, but 24.78 s on one of six
# otherwise identical quiet rounds, 39.06 s and 81.12 s under load, and
# **1109.11 s -- 18 min 29 s -- once**. It runs on the main loop before prefill,
# so it is inside time-to-first-token and OUTSIDE the engine's own prompt eval
# timing. ninfer has no equivalent step.
#
# Left unmeasured it would show up as llama losing badly on TTFT for a reason
# that is not the engine, exactly like the leftover-container queue wait that
# had to be retracted from bench_cross_engine.py. So: read the engine's own
# account of it out of the log for the arm's window, and put it in the run
# directory next to the numbers it explains.
cache_stalls() {
  local label="$1" start="$2" window took n
  [[ "$(docker inspect -f '{{.State.Running}}' "$LLAMA_CT" 2>/dev/null)" == "true" ]] || return 0
  window=$(( $(date -u +%s) - start + 5 ))
  docker logs "$LLAMA_CT" --since "${window}s" 2>&1 \
    | grep -E 'prompt cache update took|prompt_save:|making room for prompt cache' \
    > "$RUN_DIR/$label.cache-stalls" 2>/dev/null
  # `docker logs` writes llama's output on STDERR, which is why the 2>&1 above
  # is load-bearing and not decoration -- without it this file is always empty
  # and the confound reads as absent rather than as unmeasured.
  took="$(grep -oE 'prompt cache update took [0-9.]+ ms' "$RUN_DIR/$label.cache-stalls" \
          | grep -oE '[0-9.]+' || true)"
  n="$(printf '%s\n' "$took" | grep -c . || true)"
  if [[ -z "$took" ]]; then
    echo "cache_stalls_$label=none logged in ${window}s window" >> "$RUN_DIR/run.meta"
    return 0
  fi
  local total_ms max_ms
  total_ms="$(printf '%s\n' "$took" | awk '{s+=$1} END{printf "%.0f", s}')"
  max_ms="$(printf '%s\n' "$took" | awk 'BEGIN{m=0} {if($1>m)m=$1} END{printf "%.0f", m}')"
  echo "cache_stalls_$label=n=$n total_ms=$total_ms max_ms=$max_ms" >> "$RUN_DIR/run.meta"
  warn "$label: $n prompt-cache update(s) inside this arm, worst \
$(awk "BEGIN{printf \"%.2f\", $max_ms/1000}")s, total \
$(awk "BEGIN{printf \"%.2f\", $total_ms/1000}")s -- that time is inside TTFT and \
outside prompt_ms. See $RUN_DIR/$label.cache-stalls"
}

start_ninfer() {
  local ctx="$1" kv="$2" name="$3"
  info "starting ninfer  ctx=$ctx  kv=$kv"
  docker run -d --name "$NINFER_CT" --gpus all \
    --network "$NETWORK" \
    -v "$(env_get MODELS_DIR):/workspace/models:ro" \
    "$NINFER_IMAGE" \
    ninfer-serve "models/$NINFER_ARTIFACT" \
    --host 0.0.0.0 --port 8080 \
    --max-context "$ctx" --kv-capacity "$ctx" \
    --max-concurrency 1 --max-pending-requests 16 \
    --pending-timeout-ms 600000 \
    --prefill-chunk 1024 --kv-dtype "$kv" \
    --spec mtp --draft-tokens 3 --lm-head-draft \
    --preserve-thinking > "$RUN_DIR/ninfer.cid" 2>"$RUN_DIR/ninfer-start.err"
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    warn "ninfer failed to start:"; cat "$RUN_DIR/ninfer-start.err" >&2
    return 1
  fi

  # Cold load is minutes, not seconds -- the artifact is ~17 GiB off a 9p
  # mount. Poll /health rather than guessing a sleep, and capture the log
  # BEFORE the container can go away: `docker logs` on a removed container
  # returns nothing, and that lesson was paid for once already.
  # THE PROBE RUNS FROM A CONTAINER WE CONTROL, NOT INSIDE NINFER'S.
  #
  # It used to be `docker exec ninfer sh -c 'curl -sf .../health'`. That image
  # ships NO curl, NO wget and NO python3, so the probe exited 127 -- command
  # not found -- on every one of 180 iterations, which this loop cannot tell
  # apart from "not ready yet". On 2026-09-03 it sat there for nine minutes
  # against a server that had been answering /health in 0.43 s since minute
  # one, and would have declared "ninfer did not become healthy within 1800s"
  # about a perfectly healthy engine. A guard that fails identically for "not
  # ready" and "cannot ask" reports the wrong system as broken.
  #
  # The bench image is the right prober precisely because the ARM uses it: if
  # this cannot reach ninfer, neither can the measurement, so a probe failure
  # is never a false alarm about the wrong thing. Exit codes are kept distinct
  # on purpose -- 0 healthy, 1 not yet, anything else means the probe itself is
  # broken and we stop rather than burn 1800 s.
  info "waiting for ninfer /health (cold load of a 17 GiB artifact takes minutes)"
  # WALL CLOCK, NOT A SLEEP TALLY.
  #
  # This used to count only its own `sleep 10` and ignore what each iteration
  # actually costs -- and each iteration is a `compose run --rm`, which is a
  # container create, start, python, and teardown: 15-25 s. On 2026-09-04 it
  # announced "healthy after 340s" for a load the engine's own log timed at
  # 810.204 s. An operator reading that number cannot reconcile it with the
  # runbook's timeline and has no way to tell a slow load from a stalled one.
  # The 1800 budget was wrong in the same direction: 1800 SLEEP seconds is
  # closer to 45 minutes of wall clock.
  local probe_t0 waited prc
  probe_t0="$(date -u +%s)"
  # urllib.error imported EXPLICITLY: it resolves as a side effect of importing
  # urllib.request today, and if that ever stops being true the NameError would
  # surface as a traceback, exit 1, and read as "not ready yet" forever -- the
  # same silent failure this rewrite exists to remove.
  local probe_py='import sys,urllib.error,urllib.request
try:
    with urllib.request.urlopen("http://'"$NINFER_CT"':8080/health", timeout=5) as r:
        sys.exit(0 if r.status == 200 else 1)
except urllib.error.HTTPError:
    sys.exit(1)
except Exception:
    sys.exit(1)'
  while :; do
    waited=$(( $(date -u +%s) - probe_t0 ))
    [[ $waited -lt 1800 ]] || break
    compose --profile tools run --rm --entrypoint python bench -c "$probe_py" \
      >/dev/null 2>"$RUN_DIR/ninfer-probe.err"
    prc=$?
    waited=$(( $(date -u +%s) - probe_t0 ))
    if [[ $prc -eq 0 ]]; then
      # The gate itself is sound: on 2026-09-04 the engine logged `listening
      # on ...` at 00:53:46 and this probe passed at 00:53:58 -- 12 s later,
      # never early. It was only the CLOCK that lied, reporting 340 s for a
      # load that took 822 s wall (engine: "model loaded in 810.204 s").
      # Both numbers are printed now so the two can never drift apart again
      # without someone seeing it.
      ok "ninfer answered /health after ${waited}s (wall clock)"
      docker logs "$NINFER_CT" 2>&1 | grep -E "model loaded in|listening on" >&2 || true
      docker logs "$NINFER_CT" > "$RUN_DIR/ninfer-$name.log" 2>&1
      return 0
    fi
    if [[ $prc -ne 1 ]]; then
      warn "the READINESS PROBE ITSELF failed (rc=$prc) — this says nothing about ninfer:"
      tail -5 "$RUN_DIR/ninfer-probe.err" >&2
      die "cannot probe ninfer, so cannot measure it. Fix the probe, not the engine."
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$NINFER_CT" 2>/dev/null)" != "true" ]]; then
      warn "ninfer container exited during load — capturing its log now"
      docker logs "$NINFER_CT" > "$RUN_DIR/ninfer-$name.log" 2>&1
      tail -30 "$RUN_DIR/ninfer-$name.log" >&2
      return 1
    fi
    sleep 10
  done
  warn "ninfer did not become healthy within 1800s of wall clock"
  docker logs "$NINFER_CT" > "$RUN_DIR/ninfer-$name.log" 2>&1
  return 1
}

# --- main --------------------------------------------------------------------
preflight
write_meta
info "run dir: $RUN_DIR"

# llama FIRST, while it is up and serving its production configuration. Doing it
# this way round also keeps the stack down for the shortest possible window.
if [[ "$RUN_LLAMA" -eq 1 ]]; then
  if [[ "$(docker inspect -f '{{.State.Running}}' "$LLAMA_CT" 2>/dev/null)" != "true" ]]; then
    warn "$LLAMA_CT is not running — starting it for the llama arm"
    docker start "$LLAMA_CT" >/dev/null 2>&1
    sleep 30
  fi
  bench_arm llama "http://llama:8080" "llama.json"
fi

if [[ "$RUN_NINFER" -eq 1 ]]; then
  info "stopping $LLAMA_CT to free the GPU (restore runs on every exit path)"
  docker stop "$LLAMA_CT" >/dev/null 2>&1
  echo "llama stop rc=$?" >> "$RUN_DIR/restore.log"

  if start_ninfer "$CONTEXT" "$KV_DTYPE" "matched"; then
    bench_arm "ninfer" "http://$NINFER_CT:8080" "ninfer.json"
  else
    warn "matched-context ninfer arm did not run"
  fi
  docker rm -f "$NINFER_CT" >/dev/null 2>&1

  if [[ "$WIDE" -eq 1 ]]; then
    if start_ninfer 262144 rk4v4-e8 "wide"; then
      bench_arm "ninfer262k" "http://$NINFER_CT:8080" "ninfer262k.json"
    else
      warn "262K ninfer arm did not run"
    fi
    docker rm -f "$NINFER_CT" >/dev/null 2>&1
  fi
fi

restore
info "results in $RUN_DIR"
ls -la "$RUN_DIR"
