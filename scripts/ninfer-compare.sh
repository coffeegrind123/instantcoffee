#!/usr/bin/env bash
#
# Measure ninfer-4090 against llama.cpp on this card, in matched units.
#
#   ./scripts/ninfer-compare.sh                    # matched-context arms
#   ./scripts/ninfer-compare.sh --ninfer-only      # skip the llama arm
#   ./scripts/ninfer-compare.sh --prompt-tokens 32768 --repeat 5
#   ./scripts/ninfer-compare.sh --wide             # add ninfer's 262K arm
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
RUN_DIR="$OUT_DIR/$STAMP"
mkdir -p "$RUN_DIR"

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

# --- arms --------------------------------------------------------------------
bench_arm() {
  local label="$1" url="$2" out="$3"
  info "benching $label at $url"
  echo "loadavg_before_$label=$(cut -d' ' -f1-3 /proc/loadavg)" >> "$RUN_DIR/run.meta"
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
  echo "loadavg_after_$label=$(cut -d' ' -f1-3 /proc/loadavg)" >> "$RUN_DIR/run.meta"
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
  info "waiting for ninfer /health (cold load of a 17 GiB artifact takes minutes)"
  local waited=0
  while [[ $waited -lt 1800 ]]; do
    if docker exec "$NINFER_CT" sh -c \
        'curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1' 2>/dev/null; then
      ok "ninfer healthy after ${waited}s"
      docker logs "$NINFER_CT" > "$RUN_DIR/ninfer-$name.log" 2>&1
      return 0
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$NINFER_CT" 2>/dev/null)" != "true" ]]; then
      warn "ninfer container exited during load — capturing its log now"
      docker logs "$NINFER_CT" > "$RUN_DIR/ninfer-$name.log" 2>&1
      tail -30 "$RUN_DIR/ninfer-$name.log" >&2
      return 1
    fi
    sleep 10
    waited=$((waited + 10))
  done
  warn "ninfer did not become healthy within 1800s"
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
