#!/usr/bin/env bash
#
# What makes a span a cliff: perplexity's own token array, and per-token NLL.
#
#   ./scripts/ppl-cliff-run.sh --corpus /captures/corpus/deep-plus-pi.txt \
#       --from-run .ppl-depth-logs/20260824T142049Z \
#       --chunk 8192:81920:1 --chunk 2048:84992:3 --chunk 2048:86016:2
#
#   ./scripts/ppl-cliff-run.sh ... --dry-run        print every command, stop nothing
#   ./scripts/ppl-cliff-run.sh --analyse-only DIR   re-read a finished run
#
# THE QUESTION. kv-cache-fidelity-measured.md §3e: the depth effect is a CLIFF,
# not a slope — median span ratio 1.74, one span at 149,597x — and what makes a
# span a cliff was left open with one refuted hypothesis (repetitiveness; zlib
# says 0.345 against 0.364, indistinguishable and slightly the wrong way).
#
# TWO THINGS AN AGGREGATE CANNOT SAY, and this script gets both.
#
#   1. WHICH TOKENS. A chunk's perplexity is one number over 4095 scored
#      tokens. `--kl-divergence-base` writes a log-prob record per scored token,
#      so the per-token NLL behind that number is readable — and so is the token
#      the model wanted instead (scripts/ppl_tokens.py, LogitsBody.top1).
#
#   2. WHERE THEY ARE IN THE FILE. Span boundaries are token offsets, and §3e's
#      token->byte mapping was llama-server's /tokenize SCALED by the ratio of
#      two totals, drifting up to ~2,000 tokens. The scaling was never needed:
#      the two totals differ by ONE flag (`parse_special`), and with it set the
#      way perplexity sets it the counts agree exactly. See ppl_tokens.py.
#      This script proves that agreement element by element rather than by
#      length, because §3e itself records a corpus altered in 414 places that
#      produced identical token COUNTS.
#
# ISOLATION IS EXACT, AND THAT IS WHY THIS IS CHEAP. perplexity.cpp:547 clears
# the memory before every batch of chunks:
#       llama_memory_clear(llama_get_memory(ctx), true)
# so a chunk's result depends on nothing but its own n_ctx tokens at positions
# 0..n_ctx-1. Chunk 10 of a 16-chunk arm is therefore reproducible as chunk 0 of
# a file that starts at that chunk's first token — one model load and one chunk
# of decode instead of the whole arm, and 1.24 GiB of log-probs instead of 20.
#
# AND THE CONTROL IS FREE. If the isolation is sound, the isolated chunk's PPL
# must equal the source arm's per-chunk PPL, which `--from-run` reads out of the
# arm logs rather than being typed in. A mismatch means the slice is not the
# chunk and every per-token number behind it is about some other text.
#
# --chunk N:A:K  isolate K chunks of n_ctx N starting at corpus token A. The
#                staged file holds corpus tokens [A, A + max(K,2)*N) — max(K,2)
#                because perplexity refuses a file shorter than 2*n_ctx
#                (perplexity.cpp:480) and returns without scoring anything.
#
# COSTS. One model load per pass (2m51s measured on this box with
# --load-mode none) plus seconds of decode. The log-probs are
# n_chunk * (n_ctx - 1 - n_ctx/2) * nv * 2 bytes on the tape: 1.24 GiB for one
# 8192 chunk of this model, 311 MiB for one at 2048.
#
# --load-mode none IS NOT OPTIONAL, same as kld-run.sh and for the same reason:
# demand-paging the GGUF through the 9p bind mount ran at 6.4 MB/s and is
# indistinguishable from a hang.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# AFTER the source, NOT before, and this ordering is load-bearing.
# lib.sh line 4 runs `set -euo pipefail`, so a `set -uo pipefail` placed
# above it is silently overridden and errexit comes back ON — defeating the
# deliberate choice this script makes. That cost four wedged ppl-cliff runs
# and a whole OPEN-WORK section: restore() begins with a `docker kill` of a
# --rm container that has already exited, which always returns 1, and under
# errexit that killed the script before it could restart llama. The symptom
# was silent (stderr went to /dev/null) and looked like the trap not firing.
#
# AND `set -uo pipefail` ALONE DOES NOT UNDO IT. `set -u`/`-o pipefail` only
# ENABLE those options; nothing in that line turns errexit off. Disabling it
# takes `set +e` explicitly, which is why the line below is not decoration.
set -uo pipefail
set +e
require_cmd docker

CORPUS=""
FROM_RUN=""
CHUNK_SPECS=()
OUT_SUBDIR="ppl-cliff"
# The KV type the PASSES use. Default f16 because a fidelity question wants the
# unquantised reference; set it to compare. The server runs q8_0/q8_0, so an
# f16-only run measures a configuration this stack does not serve.
KV_TYPE="f16"
# --kl-divergence-base is what makes a pass expensive: one log-prob record is
# 2*((n_vocab+1)/2)+4 uint16 per scored token, which on this model's 248,320
# vocabulary is 496,648 bytes A TOKEN — 2.0 GiB per 8192 chunk, written across
# the 9p bind of a Windows drive. §3d's D1 established that omitting it is
# byte-identical in the printed perplexity and ~10x faster. So a comparison that
# only needs the CHUNK number (arm control, KV-type deltas) should not pay for
# per-token records it will not read.
NO_LOGITS=0
DRY=0
SKIP_TOKENS=0
TOKEN_CTX=256
ANALYSE_ONLY=""
KEEP_LOGITS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus) CORPUS="${2:-}"; shift 2 || die "--corpus needs a value" ;;
    --from-run) FROM_RUN="${2:-}"; shift 2 || die "--from-run needs a value" ;;
    --chunk) CHUNK_SPECS+=("${2:-}"); shift 2 || die "--chunk needs N:A:K" ;;
    --out-subdir) OUT_SUBDIR="${2:-}"; shift 2 || die "--out-subdir needs a value" ;;
    --kv) KV_TYPE="${2:-}"; shift 2 || die "--kv needs a value (f16, q8_0, ...)" ;;
    --no-logits) NO_LOGITS=1; shift ;;
    --token-ctx) TOKEN_CTX="${2:-}"; shift 2 || die "--token-ctx needs a value" ;;
    --skip-tokens) SKIP_TOKENS=1; shift ;;
    --keep-logits) KEEP_LOGITS=1; shift ;;
    --analyse-only) ANALYSE_ONLY="${2:-}"; shift 2 || die "--analyse-only needs a directory" ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
done

LLAMA_TAG_V="$(env_get LLAMA_TAG)";      : "${LLAMA_TAG_V:=server-cuda-b10573}"
GGUF="$(env_get GGUF_FILE)";             [[ -n "$GGUF" ]] || die "GGUF_FILE is not set in .env"
MODELS="$(env_get MODELS_DIR)";          [[ -n "$MODELS" ]] || die "MODELS_DIR is not set in .env"
CAPS="$(env_get CAPTURES_DIR)";          [[ -n "$CAPS" ]] || die "CAPTURES_DIR is not set in .env"
LLAMA_PORT_V="$(env_get LLAMA_PORT)";    : "${LLAMA_PORT_V:=8080}"
NGL="$(env_get NGL)";                    : "${NGL:=999}"
IMAGE="ghcr.io/ggml-org/llama.cpp:${LLAMA_TAG_V}"
SIDECAR_IMAGE="instantcoffee/proxy:$(env_get FORGE_VERSION)"
LLAMA_CT="${LLAMA_CONTAINER:-instantcoffee-llama}"
# The tokenizer is reached over the compose network by its alias rather than
# over a published port: ppl_depth_build.py already does exactly this, and a
# published port is a property of docker-compose.yml that a sibling container
# has no reason to depend on.
LLAMA_URL="${LLAMA_URL:-http://llama:${LLAMA_PORT_V}}"
OUTDIR="/captures/${OUT_SUBDIR}"
[[ "$KV_TYPE" == "f16" ]] || OUTDIR="/captures/${OUT_SUBDIR}-${KV_TYPE}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_LOGDIR="${REPO_ROOT}/.ppl-cliff-logs/${STAMP}"
RUNNER_CT="ppl-cliff-pass-$$"

if [[ -n "$ANALYSE_ONLY" ]]; then
  [[ -d "$ANALYSE_ONLY" ]] || die "no such log directory: $ANALYSE_ONLY"
else
  [[ -n "$CORPUS" ]] || die "--corpus is required (a /captures/... path)"
  case "$CORPUS" in
    /captures/*) ;;
    *) die "--corpus must be a /captures/... path: the runner mounts \$CAPTURES_DIR there" ;;
  esac
  (( ${#CHUNK_SPECS[@]} )) || die "at least one --chunk N:A:K is required"
fi
CORPUS_BASE="$(basename "${CORPUS:-none}" .txt)"

# spec -> the four numbers, validated. A malformed spec that reaches the tape
# builder becomes a file of the wrong length and a pass that scores the wrong
# text, which is exactly the failure this whole script exists to rule out.
parse_spec() {
  local spec="$1"
  IFS=':' read -r SPEC_N SPEC_A SPEC_K <<<"$spec"
  [[ "$SPEC_N" =~ ^[0-9]+$ && "$SPEC_A" =~ ^[0-9]+$ && "$SPEC_K" =~ ^[0-9]+$ ]] \
    || die "--chunk '$spec' is not N:A:K with three integers"
  (( SPEC_N > 0 && SPEC_K > 0 )) || die "--chunk '$spec': N and K must be positive"
  (( SPEC_N % 2 == 0 )) || die "--chunk '$spec': n_ctx $SPEC_N is odd; n_ctx/2 has to be exact"
  SPEC_SPAN=$(( SPEC_K > 2 ? SPEC_K * SPEC_N : 2 * SPEC_N ))
  SPEC_NAME="c${SPEC_N}-a${SPEC_A}-k${SPEC_K}"
}

# The compose network, read rather than assumed: the project name is derived
# from the directory and a rename would silently break a hardcoded string.
llama_network() {
  docker inspect "$LLAMA_CT" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null
}

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

  local nvocab; nvocab="$(gguf_n_vocab "$MODELS" "$GGUF" "$SIDECAR_IMAGE")"
  [[ "$nvocab" =~ ^[0-9]+$ ]] || die "could not read n_vocab from the GGUF: ${nvocab}"
  echo "    n_vocab       ${nvocab} (read from the GGUF, not assumed)"

  # ---- host memory ---------------------------------------------------------
  #
  # A --kl-divergence-base pass holds TWO big host buffers, not the one
  # ppl-depth-run.sh guards, and the second is the one that is easy to forget:
  #
  #   perplexity.cpp:512  if (num_batches > 1) logits.reserve(n_ctx * n_vocab)
  #                       resident part is (n_ctx/2) * n_vocab * 4 bytes
  #   perplexity.cpp:526  log_probs.resize(n_ctx * nv), nv = 2*((n_vocab+1)/2)+4
  #                       n_ctx * nv * 2 bytes, ALLOCATED IN FULL
  #
  # At n_ctx 8192 on this model that is 2.49 GiB + 2.49 GiB. The 10 % margin is
  # the one ppl-depth-run.sh calibrated against a measured arm (+8.2 % over the
  # arithmetic), not a round number.
  local avail_mb; avail_mb="$(docker run --rm alpine free -m | awk '/^Mem:/{print $4}')"
  echo "    host memory   ${avail_mb} MiB FREE (swap deliberately not counted)"
  local nv=$(( 2 * ((nvocab + 1) / 2) + 4 ))
  local blocked=0 spec need_mb logits_mb probs_mb bytes
  local total_bytes=0
  for spec in "${CHUNK_SPECS[@]}"; do
    parse_spec "$spec"
    logits_mb=0
    (( SPEC_N > 2048 )) && logits_mb=$(( (SPEC_N / 2) * nvocab * 4 / 1048576 ))
    probs_mb=$(( SPEC_N * nv * 2 / 1048576 ))
    bytes=$(( SPEC_K * (SPEC_N - 1 - SPEC_N / 2) * nv * 2 ))
    if (( NO_LOGITS )); then probs_mb=0; bytes=0; fi
    need_mb=$(( (logits_mb + probs_mb) * 110 / 100 ))
    total_bytes=$(( total_bytes + bytes ))
    if (( need_mb > avail_mb )); then
      printf '    %-22s REFUSED: ~%s MiB resident against %s MiB free\n' "$SPEC_NAME" "$need_mb" "$avail_mb"
      blocked=1
    else
      printf '    %-22s ok: ~%s MiB resident (%s logits + %s log_probs, +10%%), %s MiB on the tape\n' \
        "$SPEC_NAME" "$need_mb" "$logits_mb" "$probs_mb" "$(( bytes / 1048576 ))"
    fi
  done
  (( blocked )) && { (( DRY )) || return 1; }

  local free; free="$(docker run --rm -v "${CAPS}:/captures" alpine df -Pm /captures | awk 'NR==2{print $4}')"
  echo "    free on tape  ${free} MiB against $(( total_bytes / 1048576 )) MiB of log-probs"
  if (( free < total_bytes / 1048576 + 1024 )); then
    echo "    REFUSING: the log-probs do not fit with a GiB to spare."
    (( DRY )) || return 1
  fi

  local recent
  recent="$(docker logs --since 10m "$LLAMA_CT" 2>&1 | grep -cE 'slot launch_slot_|prompt processing' || true)"
  if ! docker ps --format '{{.Names}}' | grep -qx "$LLAMA_CT"; then
    echo "    llama         NOT RUNNING — stage 1 needs its tokenizer. Start it first."
    (( DRY )) || return 1
    recent=0
  fi
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
# Stage a script into the captures mount so a container can run it. Same reason
# as ppl-depth-run.sh: the repo is a 9p bind of a Windows directory and
# `-v <repo>/scripts:/scripts` mounts a DIFFERENT, empty view.
# ---------------------------------------------------------------------------
SCRIPT_STAGE="${OUTDIR}/_scripts"
stage_script() {
  local src="$1" name; name="$(basename "$1")"
  docker run --rm -i -v "${CAPS}:/captures" alpine sh -c \
    "mkdir -p '${SCRIPT_STAGE}' && cat > '${SCRIPT_STAGE}/${name}'" < "$src" \
    || die "could not stage ${name} into ${SCRIPT_STAGE}"
}

# ---------------------------------------------------------------------------
# Stage 1: the map, and the slice files, both proved while llama is still up.
# ---------------------------------------------------------------------------
build_inputs() {
  echo
  echo "==> stage 1: token->byte map and slice files (llama is still up; it owns the tokenizer)"
  stage_script "${REPO_ROOT}/scripts/ppl_tokens.py"
  stage_script "${REPO_ROOT}/scripts/ppl_cliff_stage.py"
  local specs; specs="$(printf '%s\n' "${CHUNK_SPECS[@]}" | paste -sd, -)"
  local net; net="$(llama_network)"
  [[ -n "$net" ]] || die "could not read ${LLAMA_CT}'s network; is it running?"
  # --user 0:0 because the sidecar image runs unprivileged and /captures is a
  # 9p bind of a Windows directory: a write from the image's own uid is EACCES,
  # and it surfaces as a traceback three quarters of the way through the map.
  docker run --rm --network "$net" --user 0:0 \
    -v "${CAPS}:/captures" --entrypoint python "$SIDECAR_IMAGE" \
    "${SCRIPT_STAGE}/ppl_cliff_stage.py" \
      --corpus "$CORPUS" --corpus-base "$CORPUS_BASE" --outdir "$OUTDIR" \
      --url "$LLAMA_URL" --specs "$specs" \
    || die "stage 1 failed; nothing was stopped"
}

# ---------------------------------------------------------------------------
# One llama-perplexity invocation.
# ---------------------------------------------------------------------------
pass() {
  local file="$1" nctx="$2" chunks="$3" logits="$4" log="$5"
  local cmd=(
    docker run --rm --gpus all --name "$RUNNER_CT"
      -v "${MODELS}:/models:ro" -v "${CAPS}:/captures"
      --entrypoint /app/llama "$IMAGE" perplexity
      -m "/models/${GGUF}" -f "$file"
      -c "$nctx" -b 2048 -ub 512
      -ngl "$NGL" -fa on -ctk "$KV_TYPE" -ctv "$KV_TYPE" -kvu -np 1
      --load-mode none
      --chunks "$chunks"
  )
  (( NO_LOGITS )) || cmd+=(--kl-divergence-base "$logits")
  echo
  echo "--- ${log}   n_ctx=${nctx} chunks=${chunks} kv=${KV_TYPE}"
  printf '   '; printf ' %q' "${cmd[@]}"; echo
  (( DRY )) && return 0
  docker rm -f "$RUNNER_CT" >/dev/null 2>&1
  "${cmd[@]}" > "${LOCAL_LOGDIR}/${log}" 2>&1
  local rc=$?
  echo "    exit ${rc}"
  grep -oE '\[[0-9]+\][0-9.]+' "${LOCAL_LOGDIR}/${log}" | sed 's/^/    | /'
  return $rc
}

# The token-array pass. n_ctx is small so n_chunk*n_ctx covers nearly the whole
# corpus, and the run is KILLED the moment the array is on disk: the write at
# perplexity.cpp:525 happens before the first llama_decode, so nothing is
# computed and nothing is lost. It costs one model load.
token_pass() {
  local logits="${OUTDIR}/${CORPUS_BASE}.tokens.logits"
  local log="tokens.log"
  local cmd=(
    docker run --rm --gpus all --name "$RUNNER_CT"
      -v "${MODELS}:/models:ro" -v "${CAPS}:/captures"
      --entrypoint /app/llama "$IMAGE" perplexity
      -m "/models/${GGUF}" -f "$CORPUS"
      -c "$TOKEN_CTX" -b 2048 -ub 512
      -ngl "$NGL" -fa on -ctk q8_0 -ctv q8_0 -kvu -np 1
      --load-mode none
      --kl-divergence-base "$logits"
  )
  echo
  echo "--- ${log}   n_ctx=${TOKEN_CTX}, killed as soon as the token array lands"
  printf '   '; printf ' %q' "${cmd[@]}"; echo
  (( DRY )) && return 0
  docker rm -f "$RUNNER_CT" >/dev/null 2>&1
  docker run --rm -v "${CAPS}:/captures" alpine rm -f "$logits" >/dev/null 2>&1
  "${cmd[@]}" > "${LOCAL_LOGDIR}/${log}" 2>&1 &
  local runner_pid=$!
  # Wait for the array, then kill. The waiter is a FILE, not an interpolated
  # `python -c` string: as a string the shell parses the Python source, so a
  # backtick or $(...) anywhere in it becomes command substitution. That trap
  # already fired once here (a backtick in a comment -> `sl: command not
  # found`), and it corrupted nothing by luck rather than by design. See
  # scripts/ppl_cliff_wait.py, which also explains why it reads the header
  # instead of being told the size.
  stage_script "${REPO_ROOT}/scripts/ppl_cliff_wait.py"
  docker run --rm --user 0:0 -v "${CAPS}:/captures" --entrypoint python "$SIDECAR_IMAGE" \
    "${SCRIPT_STAGE}/ppl_cliff_wait.py" --path "$logits" --timeout 1800
  local waiter_rc=$?
  # Guarded for the same reason as restore()'s: an expected non-zero here must
  # never be fatal. The runner may already have exited on its own.
  docker kill "$RUNNER_CT" >/dev/null 2>&1 || true
  wait "$runner_pid" 2>/dev/null
  if (( waiter_rc )); then
    echo "    the token pass did not produce an array; see ${LOCAL_LOGDIR}/${log}"
    tail -n 20 "${LOCAL_LOGDIR}/${log}" | sed 's/^/    | /'
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
main_run() {
  mkdir -p "$LOCAL_LOGDIR"
  # --analyse-only needs the corpus and cannot guess it. Recorded here so a
  # finished run can be re-read with just its directory, which is what the
  # header promises. Before this, --analyse-only handed the analyser an EMPTY
  # --corpus and died on FileNotFoundError: '' — and then ran the log-prob
  # cleanup with CORPUS_BASE defaulted to "none", which deleted nothing purely
  # by luck. With a real corpus that same path would have destroyed the GiB of
  # log-probs the re-read exists to use.
  # STAMP THE STACK, NOT JUST THE ARGUMENTS. capacity-probe.sh records the
  # engine and the weights with every result and refuses to compare across them
  # ("THIS TABLE MIXES 4 DIFFERENT STACKS"); these logs had no such stamp, and on
  # 2026-09-03 that cost a wrong result — per-token series from 2026-08-24 were
  # pooled with series measured today, and the model had changed underneath
  # (unsloth UD-Q4_K_XL -> orcarouter Q4_K_M on 2026-08-25). Every pair in that
  # comparison straddled the switch. A run that cannot say which weights produced
  # it will eventually be compared with one that used different ones.
  {
    printf 'CORPUS=%s\n' "$CORPUS"
    printf 'KV_TYPE=%s\n' "$KV_TYPE"
    printf 'SPECS=%s\n' "$(printf '%s\n' "${CHUNK_SPECS[@]}" | paste -sd, -)"
    printf 'GGUF_FILE=%s\n' "$GGUF"
    printf 'MODEL_REPO=%s\n' "$(env_get MODEL_REPO)"
    printf 'LLAMA_IMAGE=%s\n' "$IMAGE"
    printf 'STAMPED_UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${LOCAL_LOGDIR}/run.meta"
  echo "cliff probe   ${STAMP}"
  echo "  image       ${IMAGE}"
  echo "  corpus      ${CORPUS}"
  echo "  logs        ${LOCAL_LOGDIR}"
  echo "  chunks      ${CHUNK_SPECS[*]}"
  echo "  KV type     ${KV_TYPE} (the server runs $(env_get CACHE_TYPE_K)/$(env_get CACHE_TYPE_V))"
  (( NO_LOGITS )) && echo "  log-probs   NOT written (--no-logits): chunk numbers only, no per-token data"
  echo

  preflight || die "preflight failed; nothing was stopped"
  (( DRY )) || build_inputs

  if (( DRY )); then
    echo
    echo "==> dry run: the passes that WOULD run"
    (( SKIP_TOKENS )) || echo "    (token pass at n_ctx ${TOKEN_CTX}, killed after the header)"
    local spec
    for spec in "${CHUNK_SPECS[@]}"; do
      parse_spec "$spec"
      pass "${OUTDIR}/${CORPUS_BASE}-${SPEC_NAME}.txt" "$SPEC_N" "$SPEC_K" \
        "${OUTDIR}/${CORPUS_BASE}-${SPEC_NAME}.logits" "${SPEC_NAME}.log"
    done
    echo
    echo "dry run only; ${LLAMA_CT} was not touched."
    rmdir "$LOCAL_LOGDIR" 2>/dev/null || true
    exit 0
  fi

  echo
  echo "==> stopping ${LLAMA_CT} (it holds the card; a cold reload follows this run)"
  docker stop "$LLAMA_CT" >/dev/null || die "could not stop ${LLAMA_CT}"
  # RESTORE WRITES TO A FILE AS WELL AS STDOUT, AND THE FILE IS THE EVIDENCE.
  # Four runs on 2026-08-24 ended with ${LLAMA_CT} stopped and restore's two
  # messages missing, and the record's best hypothesis was "stdout is closed, so
  # every echo fails silently". THAT HYPOTHESIS CANNOT EXPLAIN THE CONTAINER
  # STAYING DOWN ON ITS OWN: docker start below is unconditional, a failing echo
  # returns non-zero into nothing, and set -e is not in force — so a closed
  # stdout would still have restarted llama. For it to stay down you need EITHER
  # restore never reached, OR docker start itself failing. Those are different
  # bugs with different fixes and stdout cannot tell them apart.
  #
  # So each line is appended with its own redirection (the fd is opened and
  # closed per write, so nothing here depends on an fd inherited from the
  # session), and the exit status of docker start is recorded rather than
  # inferred from which echo ran. Read ${LOCAL_LOGDIR}/restore.log after any run
  # that ends with llama down:
  #   file absent            -> restore was never reached (killed before it, or
  #                             the process died without running its EXIT trap,
  #                             which means SIGKILL)
  #   "start rc=0" + down    -> docker start returned success and the container
  #                             still stopped; look at docker, not at this script
  #   "start rc=<non-zero>"  -> docker start failed, and the reason is on the line
  #   entered, no start line -> killed INSIDE restore, between kill and start
  # NOT `local`: the EXIT trap can fire after main_run has returned, and a local
  # would be out of scope by then — the writes would silently go nowhere, which
  # is the exact failure mode this instrument exists to rule out.
  restore_log="${LOCAL_LOGDIR}/restore.log"
  rlog() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$restore_log" 2>/dev/null || true; }
  restore() {
    rlog "restore entered (caller rc=$?)"
    # BOTH of these are `|| true` / `if` on purpose, and it is belt-and-braces
    # against the errexit bug fixed at the top of this file rather than trust in
    # it. The runner is `--rm` and has normally exited by now, so `docker kill`
    # returns 1 on the ORDINARY path — it is an expected failure, never a fatal
    # one. Restarting llama is the single most important thing this script does;
    # nothing in here may be allowed to abort it.
    local kill_rc=0
    docker kill "$RUNNER_CT" >/dev/null 2>&1 || kill_rc=$?
    rlog "docker kill ${RUNNER_CT} rc=${kill_rc} (1 is normal: --rm already gone)"
    echo
    echo "==> restarting ${LLAMA_CT}"
    local start_rc=0
    if docker start "$LLAMA_CT" >/dev/null 2>>"$restore_log"; then start_rc=0; else start_rc=$?; fi
    rlog "docker start ${LLAMA_CT} rc=${start_rc}"
    rlog "state now: $(docker inspect -f '{{.State.Status}}' "$LLAMA_CT" 2>&1)"
    if (( start_rc == 0 )); then
      echo "    started; the model is now reading off disk"
    else
      echo "    FAILED to start ${LLAMA_CT} — start it by hand with ./scripts/up.sh"
    fi
  }
  trap restore EXIT INT TERM

  local failed=0
  if (( SKIP_TOKENS )); then
    echo
    echo "==> --skip-tokens: the corpus token array is not being re-read this run"
  else
    token_pass || failed=1
  fi

  local spec
  for spec in "${CHUNK_SPECS[@]}"; do
    parse_spec "$spec"
    pass "${OUTDIR}/${CORPUS_BASE}-${SPEC_NAME}.txt" "$SPEC_N" "$SPEC_K" \
      "${OUTDIR}/${CORPUS_BASE}-${SPEC_NAME}.logits" "${SPEC_NAME}.log" || failed=1
  done

  # RESTART BEFORE THE ANALYSIS, AND NOT FROM THE TRAP. Three runs on
  # 2026-08-24 all ended with instantcoffee-llama stopped: the last line of output was
  # the log-prob cleanup, restore printed neither of its two messages, and the
  # container sat Exited until it was started by hand. The third run had an
  # explicit restore call AFTER analyse and it still did not run, which places
  # the kill inside the final step — a docker run that deletes several GiB
  # across the 9p mount and takes minutes. So the restart must not sit behind
  # anything slow.
  #
  # It belongs here on the merits anyway: the passes are done, the card is free,
  # and the analysis needs no GPU. It also LETS the analysis reach a server, so
  # a token id that does not occur in the corpus can be detokenized instead of
  # printing as <id N>. The trap stays for the abnormal path, and docker start
  # on a running container is a no-op that returns 0.
  restore
  analyse "$LOCAL_LOGDIR"
  return $failed
}

# The analyser runs in the sidecar rather than on this side, because the logits
# files are on the tape and only a container can see them.
analyse() {
  local dir="$1"
  stage_script "${REPO_ROOT}/scripts/ppl_tokens.py"
  stage_script "${REPO_ROOT}/scripts/ppl_cliff_analyse.py"
  stage_script "${REPO_ROOT}/scripts/ppl_depth_analyse.py"
  local armdir="/captures/${OUT_SUBDIR}/_arms"
  if [[ -n "$FROM_RUN" ]]; then
    [[ -d "$FROM_RUN" ]] || die "--from-run ${FROM_RUN} is not a directory"
    docker run --rm -v "${CAPS}:/captures" alpine sh -c "rm -rf '${armdir}' && mkdir -p '${armdir}'"
    local f
    for f in "$FROM_RUN"/arm-*.log; do
      [[ -e "$f" ]] || continue
      docker run --rm -i -v "${CAPS}:/captures" alpine sh -c \
        "cat > '${armdir}/$(basename "$f")'" < "$f"
    done
  fi
  # The isolated run's own logs have to cross the same mount: the analyser is in
  # a container and the repo's .ppl-cliff-logs is not visible to it. Without
  # them the control has only one side and prints nothing.
  local isodir="/captures/${OUT_SUBDIR}/_iso"
  docker run --rm -v "${CAPS}:/captures" alpine sh -c "rm -rf '${isodir}' && mkdir -p '${isodir}'"
  local g
  for g in "$dir"/c*.log; do
    [[ -e "$g" ]] || continue
    docker run --rm -i -v "${CAPS}:/captures" alpine sh -c \
      "cat > '${isodir}/$(basename "$g")'" < "$g"
  done
  echo
  echo "==> analysis"
  docker run --rm --user 0:0 -v "${CAPS}:/captures" --entrypoint python "$SIDECAR_IMAGE" \
    "${SCRIPT_STAGE}/ppl_cliff_analyse.py" \
      --outdir "$OUTDIR" --corpus "$CORPUS" --corpus-base "$CORPUS_BASE" \
      --specs "$(printf '%s\n' "${CHUNK_SPECS[@]}" | paste -sd, -)" \
      --logdir "$isodir" --kv "$KV_TYPE" \
      $( [[ -n "$FROM_RUN" ]] && echo --arms "$armdir" ) \
      --json "${OUTDIR}/result.json" | tee "${dir}/analysis.txt"
  docker run --rm -i -v "${CAPS}:/captures" alpine sh -c \
    "cat '${OUTDIR}/result.json'" > "${dir}/result.json" 2>/dev/null || true
  if (( ! KEEP_LOGITS )); then
    echo
    echo "==> removing the log-probs (they are GiB; --keep-logits keeps them)"
    docker run --rm -v "${CAPS}:/captures" alpine sh -c \
      "rm -f ${OUTDIR}/${CORPUS_BASE}-*.logits ${OUTDIR}/${CORPUS_BASE}.tokens.logits"
  fi
}

if [[ -n "$ANALYSE_ONLY" ]]; then
  # Recover the corpus from the run itself; an explicit --corpus still wins.
  if [[ -f "$ANALYSE_ONLY/run.meta" ]]; then
    [[ -z "$CORPUS" ]] && CORPUS="$(sed -n 's/^CORPUS=//p' "$ANALYSE_ONLY/run.meta" | head -1)"
    if (( ! ${#CHUNK_SPECS[@]} )); then
      metaspecs="$(sed -n 's/^SPECS=//p' "$ANALYSE_ONLY/run.meta" | head -1)"
      [[ -n "$metaspecs" ]] && IFS=, read -ra CHUNK_SPECS <<< "$metaspecs"
    fi
  fi
  # RECOVER THE SPECS FROM THE LOGS if there is no run.meta. The pass logs are
  # named c<N>-a<A>-k<K>.log, which is the spec with different punctuation, so a
  # run made before run.meta existed is still re-readable.
  if (( ! ${#CHUNK_SPECS[@]} )); then
    nm=""
    for g in "$ANALYSE_ONLY"/c*.log; do
      [[ -e "$g" ]] || continue
      nm="$(basename "$g" .log)"
      [[ "$nm" =~ ^c([0-9]+)-a([0-9]+)-k([0-9]+)$ ]] \
        && CHUNK_SPECS+=("${BASH_REMATCH[1]}:${BASH_REMATCH[2]}:${BASH_REMATCH[3]}")
    done
    (( ${#CHUNK_SPECS[@]} )) && info "specs recovered from pass logs: ${CHUNK_SPECS[*]}"
  fi
  [[ -n "$CORPUS" ]] || die "no corpus: this run predates run.meta and no --corpus was given.
       Re-run as: $0 --analyse-only $ANALYSE_ONLY --corpus /captures/corpus/<name>.txt
       (add --keep-logits to keep the log-probs for further analysis)"
  (( ${#CHUNK_SPECS[@]} )) || die "no chunk specs: none in run.meta, none recoverable from
       the pass logs in $ANALYSE_ONLY, and none given with --chunk."
  CORPUS_BASE="$(basename "$CORPUS" .txt)"
  analyse "$ANALYSE_ONLY"
  exit 0
fi
main_run
