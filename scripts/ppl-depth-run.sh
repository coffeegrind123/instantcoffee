#!/usr/bin/env bash
#
# The depth question, by the safe route: does perplexity on THIS model really
# degrade with n_ctx, or was kv-cache-fidelity-measured.md §3d reading a
# different set of tokens at every depth?
#
#   ./scripts/ppl-depth-run.sh --corpus /captures/corpus/deep-s26b5bb.txt
#   ./scripts/ppl-depth-run.sh --corpus ... --dry-run     print everything, run nothing
#   ./scripts/ppl-depth-run.sh --corpus ... --analyse-only .ppl-depth-logs/<stamp>
#
# THIS IS NOT ppl-stride-run.sh AND IT IS NOT perplexity_v2. That path allocated
# n_ctx*n_vocab floats with no reserve() — 12.2 GiB peak — and deadlocked the
# operator's Windows host twice on 2026-08-24. It stays disarmed. This script
# uses the DEFAULT mode, whose resident cost is (n_ctx/2)*n_vocab*4 and only
# when n_ctx > n_batch, writes no logits file at all, and is ~20x faster per
# token. The deepest arm here wants 3.79 GiB; that path wanted 12.2.
#
# THE INSTRUMENT. Default mode scores chunk j over offsets [n_ctx/2+1, n_ctx-1]
# — always the whole top half, never a subrange — and a scored token's history
# is exactly its offset. So n_ctx changes WHICH tokens are scored as well as how
# much history they carry, and §3d compared 17 chunks of one partition against 8
# chunks of another.
#
# Prefix the corpus with EXACTLY n_ctx/2 tokens of filler and every corpus token
# moves half a chunk, so the pass scores the exact complement:
#
#     F = 0      chunk j scores corpus [jN + N/2 + 1, jN + N - 1]
#     F = N/2    chunk j scores corpus [jN + 1,       jN + N/2 - 1]
#
# Two passes per depth, and the union is every corpus token in the window, each
# scored once, each with history in [N/2+1, N-1]. Identical token set at 2048,
# 4096 and 8192. That is the comparison §3d could not make.
#
# WHY NOT THE FILLER-REGION DESIGN IN THE 2026-08-24c HANDOFF. It placed a
# 1024-token region at offset N/2 in a 2048 arm and an 8192 arm and called them
# "the same tokens". They are not: the 8192 arm's chunk also scores the 3071
# corpus tokens after the region and emits ONE number for all 4095. No filler
# placement separates them, because the scored set is always the whole top half.
#
# THREE THINGS ARE CHECKED BEFORE ANY NUMBER IS READ.
#   1. The filler's token count under PERPLEXITY'S OWN tokenizer, read off its
#      error path (`tokenizes to only %zu tokens`), which is the only place
#      default mode ever prints one. llama-server's /tokenize does NOT agree —
#      it parses control tokens and perplexity does not (+613, +0.88% on
#      deep-s26b5bb) — so the builder's count is a prediction until this
#      confirms it. The probe allocates nothing and scores nothing.
#   2. The whole-chunk alignment control: the same corpus behind a filler of a
#      WHOLE chunk must reproduce every per-chunk NLL, shifted by one chunk.
#   3. Warm-up chunks are dropped by the analyser, because in the F=N/2 pass
#      chunk 0's scored tokens carry filler as their history — and more of it at
#      larger N, which is exactly the confound this exists to remove.
#
# WHAT IT COSTS. llama-perplexity loads its own copy of the weights, so
# qwen38-llama must be STOPPED for the probe and pass stages. ~3.5 min per load,
# ~13 min of scoring, eleven loads: about an hour, then one cold reload.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# lib.sh sets -e. Turn it back off DELIBERATELY and after the source, not before:
# a failed pass here is data (it gets reported and the run continues to the
# next arm), and a bare `cmd; rc=$?` under -e exits before the assignment.
set +e
require_cmd docker python3

CORPUS=""
DEPTHS="2048,4096,8192"
WIN_HI=65536
OUT_SUBDIR="ppl-depth"
DRY=0
SKIP_BUILD=0
ANALYSE_ONLY=""
UNPINNED=0
BATCH=2048

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus) CORPUS="${2:-}"; shift 2 || die "--corpus needs a value" ;;
    --corpus=*) CORPUS="${1#*=}"; shift ;;
    --depths) DEPTHS="${2:-}"; shift 2 || die "--depths needs a value" ;;
    --depths=*) DEPTHS="${1#*=}"; shift ;;
    --window-hi) WIN_HI="${2:-}"; shift 2 || die "--window-hi needs a value" ;;
    --window-hi=*) WIN_HI="${1#*=}"; shift ;;
    --out-subdir) OUT_SUBDIR="${2:-}"; shift 2 || die "--out-subdir needs a value" ;;
    --batch) BATCH="${2:-}"; shift 2 || die "--batch needs a value" ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --analyse-only) ANALYSE_ONLY="${2:-}"; shift 2 || die "--analyse-only needs a log directory" ;;
    --unpinned) UNPINNED=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,66p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
done

DEPTH_LIST=( ${DEPTHS//,/ } )
(( ${#DEPTH_LIST[@]} >= 2 )) || die "--depths needs at least two depths: one number answers nothing"
SHALLOWEST="${DEPTH_LIST[0]}"
DEEPEST="${DEPTH_LIST[0]}"
for d in "${DEPTH_LIST[@]}"; do
  (( d % 2 == 0 )) || die "depth $d is odd; n_ctx/2 has to be exact"
  (( WIN_HI % d == 0 )) || die "--window-hi ${WIN_HI} is not a multiple of depth ${d}; chunks are whole"
  (( d < SHALLOWEST )) && SHALLOWEST=$d
  (( d > DEEPEST )) && DEEPEST=$d
done
WIN_LO="$DEEPEST"

LLAMA_TAG_V="$(env_get LLAMA_TAG)";      : "${LLAMA_TAG_V:=server-cuda-b10573}"
GGUF="$(env_get GGUF_FILE)";             [[ -n "$GGUF" ]] || die "GGUF_FILE is not set in .env"
MODELS="$(env_get MODELS_DIR)";          [[ -n "$MODELS" ]] || die "MODELS_DIR is not set in .env"
CAPS="$(env_get CAPTURES_DIR)";          [[ -n "$CAPS" ]] || die "CAPTURES_DIR is not set in .env"
NGL="$(env_get NGL)";                    : "${NGL:=999}"
IMAGE="ghcr.io/ggml-org/llama.cpp:${LLAMA_TAG_V}"
SIDECAR_IMAGE="qwen38-forge/proxy:$(env_get FORGE_VERSION)"
LLAMA_CT="${LLAMA_CONTAINER:-qwen38-llama}"
OUTDIR="/captures/${OUT_SUBDIR}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_LOGDIR="${REPO_ROOT}/.ppl-depth-logs/${STAMP}"

# --analyse-only re-reads a finished run. It touches no container and stops
# nothing, so a bad analysis never costs a reload to redo.
if [[ -n "$ANALYSE_ONLY" ]]; then
  [[ -d "$ANALYSE_ONLY" ]] || die "no such log directory: $ANALYSE_ONLY"
  analyse_dir="$ANALYSE_ONLY"
else
  [[ -n "$CORPUS" ]] || die "--corpus is required (a file under \$CAPTURES_DIR, addressed as /captures/...)"
  case "$CORPUS" in
    /captures/*) ;;
    *) die "--corpus must be a /captures/... path: the runner mounts \$CAPTURES_DIR there" ;;
  esac
fi

# The filler sizes the run needs: one half-chunk per depth, plus one WHOLE chunk
# at the shallowest depth for the alignment control.
declare -A FILLER_SET=()
for d in "${DEPTH_LIST[@]}"; do FILLER_SET[$((d / 2))]=1; done
FILLER_SET[$SHALLOWEST]=1
FILLERS="$(printf '%s\n' "${!FILLER_SET[@]}" | sort -n | paste -sd, -)"

CORPUS_BASE="$(basename "$CORPUS" .txt)"
arm_file()  { echo "${OUTDIR}/${CORPUS_BASE}-f$1.txt"; }

# The compose network, read rather than assumed: the project name is derived
# from the directory and a rename would silently break a hardcoded string.
llama_network() {
  docker inspect "$LLAMA_CT" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null
}

# ---------------------------------------------------------------------------
# Preflight. Everything checkable while the server is still up is checked here,
# because a failure found after the stop costs a cold reload to discover.
# ---------------------------------------------------------------------------
preflight() {
  echo "==> preflight"
  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || die "image $IMAGE is not present locally; pull it before stopping the server"
  docker image inspect "$SIDECAR_IMAGE" >/dev/null 2>&1 \
    || die "image $SIDECAR_IMAGE is not present locally (capture.sh builds it)"
  docker run --rm -v "${MODELS}:/models:ro" alpine test -f "/models/${GGUF}" \
    || die "/models/${GGUF} is not readable through the MODELS_DIR mount"
  docker run --rm -v "${CAPS}:/captures" alpine test -f "$CORPUS" \
    || die "corpus $CORPUS is not readable through the CAPTURES_DIR mount"

  local bytes; bytes="$(docker run --rm -v "${CAPS}:/captures" alpine stat -c %s "$CORPUS")"
  echo "    corpus        $CORPUS  ${bytes} bytes"
  echo "    depths        ${DEPTHS}"
  echo "    window        corpus [${WIN_LO}, ${WIN_HI})"
  echo "    fillers       ${FILLERS} tokens"

  # The sidecar pins the corpus to the server's own token counter. Same check
  # kld-run.sh makes, and for the same reason: a corpus that failed it measures
  # a prompt the model never saw and looks like a perfectly good file.
  local side="${CORPUS}.meta.json" sidecar_rc=0 report
  if docker run --rm -v "${CAPS}:/captures" alpine test -f "$side"; then
    report="$(docker run --rm -v "${CAPS}:/captures" --entrypoint python "$SIDECAR_IMAGE" -c "
import json, sys
m = json.load(open('$side'))
sr = m.get('server_reported') or {}
exp = sr.get('sum') or 0
delta = m.get('token_delta')
gaps = m.get('gaps') or []
verdict = 'UNPINNED'
if exp:
    verdict = 'OK' if abs(delta) <= max(16, exp * 0.01) else 'SUSPECT'
print(f\"tokens={m.get('tokens')} server={exp} delta={delta} verdict={verdict} gaps={gaps or 'none'}\")
sys.exit(0 if (verdict == 'OK' and not gaps) else 1)
" 2>&1)" || sidecar_rc=1
    echo "    sidecar       ${report}"
  else
    sidecar_rc=1
    echo "    sidecar       ABSENT at ${side}"
  fi
  if (( sidecar_rc )); then
    echo "    REFUSING: the corpus is not pinned. Rebuild it with 'capture.sh export',"
    echo "    or pass --unpinned if prose-at-depth is what you actually want."
    (( UNPINNED )) || return 1
    echo "    --unpinned given; continuing anyway."
  fi

  # ---- host memory, on the same product kld-run.sh guards ------------------
  #
  # Default mode holds ONE buffer sized on n_vocab, and only when the chunk needs
  # more than one batch (perplexity.cpp:533):
  #     if (num_batches > 1) logits.reserve(size_t(n_ctx) * n_vocab);
  # Only positions >= n_ctx/2 request output, so the RESIDENT part is the rows
  # actually inserted: (n_ctx/2) * n_vocab * 4 bytes. At n_ctx <= n_batch there
  # is no buffer at all — llama_get_logits_ith is read in place.
  #
  # There is no log_probs vector here because there is no --kl-divergence-base:
  # §3d's D1 established that omitting it is byte-identical and ~10x faster.
  local nvocab; nvocab="$(gguf_n_vocab "$MODELS" "$GGUF" "$SIDECAR_IMAGE")"
  if [[ "$nvocab" =~ ^[0-9]+$ ]]; then
    echo "    n_vocab       ${nvocab} (read from the GGUF, not assumed)"
  else
    echo "    n_vocab       COULD NOT BE READ: ${nvocab}"
    echo "                  nothing is guarding the depths you picked. Refusing."
    return 1
  fi
  local avail_mb swap_mb
  avail_mb="$(docker run --rm alpine free -m | awk '/^Mem:/{print $4}')"
  swap_mb="$(docker run --rm alpine free -m | awk '/^Swap:/{print $4}')"
  echo "    host memory   ${avail_mb} MiB FREE (not free+swap: ${swap_mb} MiB of swap is"
  echo "                  deliberately not counted — a pass that only fits in swap has"
  echo "                  written a short file and exited 0, and a sibling script in"
  echo "                  the same state took the host down, twice)"
  local blocked=0 d need_mb
  for d in "${DEPTH_LIST[@]}"; do
    need_mb=0
    (( d > BATCH )) && need_mb=$(( (d / 2) * nvocab * 4 / 1048576 ))
    if (( need_mb > avail_mb )); then
      printf '    n_ctx %-6s REFUSED: ~%s MiB resident against %s MiB free\n' "$d" "$need_mb" "$avail_mb"
      blocked=1
    else
      printf '    n_ctx %-6s ok: ~%s MiB resident (%s chunks per rotation)\n' \
        "$d" "$need_mb" "$(( WIN_HI / d ))"
    fi
  done
  (( blocked )) && { (( DRY )) || return 1; }

  local free; free="$(docker run --rm -v "${CAPS}:/captures" alpine df -Pm /captures | awk 'NR==2{print $4}')"
  echo "    free on tape  ${free} MiB (this run writes text files, not logits)"

  local recent
  recent="$(docker logs --since 10m "$LLAMA_CT" 2>&1 | grep -cE 'slot launch_slot_|prompt processing' || true)"
  echo "    llama traffic ${recent} task lines in the last 10 minutes"
  if (( recent > 0 )); then
    if (( DRY )); then
      echo "    (a dry run stops nothing, so this is a note rather than a refusal)"
    else
      echo "    REFUSING: something is using the server; stopping it would kill that"
      echo "    session mid-turn."
      return 1
    fi
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Stage a script into the captures mount so a container can run it.
#
# THIS IS NOT A CONVENIENCE. The repo lives on a 9p bind of a Windows directory,
# and `docker run -v /home/claudeuser/qwen3.8-forge/scripts:/scripts` mounts a
# DIFFERENT, empty view — Docker Desktop resolves bind sources against the
# Windows side, so the container sees nothing. (Hardcoding the
# //c/users/... path would work and would break on any other machine.) The
# captures mount is already a real shared path both sides agree on, and
# streaming through `cat` needs no host-path arithmetic at all.
#
# The forge image's own /work/scripts is baked in at build time, so it does not
# carry anything written after the image was built. That is why this exists
# rather than reusing it.
# ---------------------------------------------------------------------------
SCRIPT_STAGE="${OUTDIR}/_scripts"
stage_script() {
  local src="$1" name; name="$(basename "$1")"
  docker run --rm -i -v "${CAPS}:/captures" alpine sh -c \
    "mkdir -p '${SCRIPT_STAGE}' && cat > '${SCRIPT_STAGE}/${name}'" < "$src" \
    || die "could not stage ${name} into ${SCRIPT_STAGE}"
}

# ---------------------------------------------------------------------------
# Build the filler-prefixed corpora. NEEDS llama UP: the filler is calibrated
# against the server's own tokenizer, never against a words-per-token constant.
# ---------------------------------------------------------------------------
build_corpora() {
  local net; net="$(llama_network)"
  [[ -n "$net" ]] || die "could not read ${LLAMA_CT}'s network; is it running?"
  echo "==> building the filler-prefixed corpora (network ${net})"
  local cmd=(
    docker run --rm --network "$net"
      -v "${CAPS}:/captures"
      --user 0:0
      -e LLAMA_URL=http://llama:8080
      -e PYTHONPATH="${SCRIPT_STAGE}"
      --entrypoint python "$SIDECAR_IMAGE"
      "${SCRIPT_STAGE}/ppl_depth_build.py"
        --corpus "$CORPUS" --out-dir "$OUTDIR" --filler-tokens "$FILLERS"
  )
  printf '   '; printf ' %q' "${cmd[@]}"; echo
  (( DRY )) && return 0
  stage_script "${REPO_ROOT}/scripts/ppl_depth_build.py"
  stage_script "${REPO_ROOT}/scripts/probe_lib.py"
  "${cmd[@]}" || die "corpus build failed"
}

# ---------------------------------------------------------------------------
# One llama-perplexity invocation. `mode` is probe (error path, scores nothing)
# or pass (a real scored run).
# ---------------------------------------------------------------------------
run_perplexity() {
  local mode="$1" file="$2" nctx="$3" chunks="$4" log="$5"
  local extra=()
  if [[ "$mode" == "probe" ]]; then
    # n_ctx large enough that tokens.size() < 2*n_ctx always trips, so the run
    # returns at perplexity.cpp:483 having printed the count and touched nothing.
    # q8_0 KV purely to keep the context allocation small; it cannot affect a
    # tokenizer.
    extra+=(-ctk q8_0 -ctv q8_0)
  else
    extra+=(-ctk f16 -ctv f16 --chunks "$chunks")
  fi
  local cmd=(
    docker run --rm --gpus all
      -v "${MODELS}:/models:ro" -v "${CAPS}:/captures"
      --entrypoint /app/llama "$IMAGE" perplexity
      -m "/models/${GGUF}" -f "$file"
      -c "$nctx" -b "$BATCH" -ub 512
      -ngl "$NGL" -fa on -kvu -np 1
      --load-mode none
      "${extra[@]}"
  )
  echo
  echo "--- ${mode}  ${log}   n_ctx=${nctx}$( [[ $mode == pass ]] && echo "  chunks=${chunks}" )"
  printf '   '; printf ' %q' "${cmd[@]}"; echo
  (( DRY )) && return 0
  "${cmd[@]}" > "${LOCAL_LOGDIR}/${log}" 2>&1
  local rc=$?
  echo "    exit ${rc}"
  return $rc
}

# The probe context. Must satisfy 2*PROBE_CTX > (corpus + largest filler), or
# the "probe" turns into a real scored run of unknown length.
PROBE_CTX=40960

# Sets PROBE_COUNT rather than echoing it: run_perplexity prints the command it
# is about to run, and a command substitution would swallow that into the value.
PROBE_COUNT=""
probe_tokens() {
  local file="$1" log="$2"
  PROBE_COUNT=""
  run_perplexity probe "$file" "$PROBE_CTX" 0 "$log"
  (( DRY )) && return 0
  PROBE_COUNT="$(grep -oE 'tokenizes to only [0-9]+ tokens' "${LOCAL_LOGDIR}/${log}" \
    | grep -oE '[0-9]+' | head -n1)"
  # A probe that SCORED instead of erroring is the dangerous failure: it means
  # PROBE_CTX was too small for the file and a long run just happened silently.
  if [[ -z "$PROBE_COUNT" ]] && grep -q 'calculating perplexity over' "${LOCAL_LOGDIR}/${log}"; then
    die "probe on ${file} SCORED instead of hitting the error path: PROBE_CTX ${PROBE_CTX} is too small"
  fi
}

# ---------------------------------------------------------------------------
main_run() {
  mkdir -p "$LOCAL_LOGDIR"
  echo "depth probe   ${STAMP}"
  echo "  image       ${IMAGE}"
  echo "  corpus      ${CORPUS}"
  echo "  logs        ${LOCAL_LOGDIR}"
  echo

  preflight || die "preflight failed; nothing was stopped"
  (( SKIP_BUILD )) || build_corpora

  if (( DRY )); then
    echo
    echo "==> dry run: the probes and passes that WOULD run"
    run_perplexity probe "$CORPUS" "$PROBE_CTX" 0 "probe-corpus.log"
    for f in ${FILLERS//,/ }; do
      run_perplexity probe "$(arm_file "$f")" "$PROBE_CTX" 0 "probe-f${f}.log"
    done
    for d in "${DEPTH_LIST[@]}"; do
      run_perplexity pass "$CORPUS" "$d" "$(( WIN_HI / d ))" "arm-${d}-f0.log"
      run_perplexity pass "$(arm_file $((d/2)))" "$d" "$(( WIN_HI / d ))" "arm-${d}-f$((d/2)).log"
    done
    run_perplexity pass "$(arm_file "$SHALLOWEST")" "$SHALLOWEST" \
      "$(( WIN_HI / SHALLOWEST + 1 ))" "ctl-${SHALLOWEST}-f${SHALLOWEST}.log"
    echo
    echo "dry run only; ${LLAMA_CT} was not touched."
    rmdir "$LOCAL_LOGDIR" 2>/dev/null || true
    exit 0
  fi

  echo
  echo "==> stopping ${LLAMA_CT} (it holds the card; a cold reload follows this run)"
  docker stop "$LLAMA_CT" >/dev/null || die "could not stop ${LLAMA_CT}"
  restore() {
    echo
    echo "==> restarting ${LLAMA_CT}"
    docker start "$LLAMA_CT" >/dev/null && echo "    started; the model is now reading off disk" \
      || echo "    FAILED to start ${LLAMA_CT} — start it by hand with ./scripts/up.sh"
  }
  trap restore EXIT INT TERM

  # ---- stage 1: perplexity's own token counts -----------------------------
  #
  # Read, not inferred. The builder calibrated against llama-server's /tokenize,
  # which parses control tokens; perplexity does not. On the filler alone the two
  # must agree (plain ASCII, no control-token spelling), and the difference
  # arm_count - corpus_count is exactly the filler under PERPLEXITY'S tokenizer.
  # If that is off by even one token the two rotations stop being complementary,
  # so this refuses rather than warns.
  echo
  echo "==> stage 1: perplexity's own token counts (error path; scores nothing)"
  probe_tokens "$CORPUS" "probe-corpus.log"
  local n_corpus="$PROBE_COUNT"
  [[ "$n_corpus" =~ ^[0-9]+$ ]] || die "the corpus probe did not print a token count; see ${LOCAL_LOGDIR}/probe-corpus.log"
  echo "    corpus        ${n_corpus} tokens (perplexity; control tokens NOT parsed)"
  local bad=0 f n_arm delta
  for f in ${FILLERS//,/ }; do
    probe_tokens "$(arm_file "$f")" "probe-f${f}.log"; n_arm="$PROBE_COUNT"
    if [[ ! "$n_arm" =~ ^[0-9]+$ ]]; then
      echo "    filler ${f}   PROBE FAILED (no count printed)"; bad=1; continue
    fi
    delta=$(( n_arm - n_corpus ))
    if (( delta == f )); then
      printf '    filler %-6s %s tokens, %s - %s = %s  exact\n' "$f" "$n_arm" "$n_arm" "$n_corpus" "$delta"
    else
      printf '    filler %-6s %s tokens, delta %s but wanted %s  OFF BY %+d\n' \
        "$f" "$n_arm" "$delta" "$f" "$(( delta - f ))"
      bad=1
    fi
  done
  if (( bad )); then
    echo
    echo "    REFUSING: a filler is not the length the design needs under"
    echo "    perplexity's own tokenizer. The two rotations would overlap on some"
    echo "    positions and miss others, and every depth number would inherit it."
    return 1
  fi
  # The probe context has to be big enough that the error path is what ran.
  if (( 2 * PROBE_CTX <= n_corpus )); then
    die "PROBE_CTX ${PROBE_CTX} is too small for a ${n_corpus}-token corpus: the probe scored instead of erroring"
  fi

  # ---- stage 2: the passes ------------------------------------------------
  echo
  echo "==> stage 2: the passes"
  local failed=0 d chunks
  for d in "${DEPTH_LIST[@]}"; do
    chunks=$(( WIN_HI / d ))
    if (( chunks * d > n_corpus )); then
      echo "    n_ctx ${d}: the corpus holds ${n_corpus} tokens, the window needs $(( chunks * d ))"
      failed=1; continue
    fi
    run_perplexity pass "$CORPUS" "$d" "$chunks" "arm-${d}-f0.log" || failed=1
    run_perplexity pass "$(arm_file $((d/2)))" "$d" "$chunks" "arm-${d}-f$((d/2)).log" || failed=1
  done
  run_perplexity pass "$(arm_file "$SHALLOWEST")" "$SHALLOWEST" \
    "$(( WIN_HI / SHALLOWEST + 1 ))" "ctl-${SHALLOWEST}-f${SHALLOWEST}.log" || failed=1

  analyse "$LOCAL_LOGDIR"
  return $failed
}

# The analyser runs on THIS side, not in a container: the logs are on the repo's
# own filesystem, it imports nothing outside the standard library, and keeping it
# out of a container means a bad analysis costs nothing to redo.
analyse() {
  local dir="$1"
  echo
  echo "==> analysis"
  python3 "${REPO_ROOT}/scripts/ppl_depth_analyse.py" \
      --logdir "$dir" --window "${WIN_LO},${WIN_HI}" \
      --control "arm-${SHALLOWEST}-f0.log,ctl-${SHALLOWEST}-f${SHALLOWEST}.log,1" \
      --json "${dir}/result.json"
}

if [[ -n "$ANALYSE_ONLY" ]]; then
  analyse "$analyse_dir"
  exit $?
fi
main_run
