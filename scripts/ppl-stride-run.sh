#!/usr/bin/env bash
#
# ############################################################################
# ## DISARMED 2026-08-24. THIS SCRIPT TOOK THE WINDOWS HOST DOWN, TWICE.     ##
# ############################################################################
#
# It will not run without --i-have-read-the-deadlock-note. Read this first.
#
# WHAT HAPPENED. `--ppl-stride` selects perplexity_v2(), which requests logits
# for EVERY position (`common_batch_add(..., /*logits=*/true)` unconditionally,
# perplexity.cpp:376) and accumulates the whole chunk into one
# std::vector<float> with no reserve() anywhere. With this model's n_vocab of
# 248,320 that vector is
#
#     W = 2048   ->  2.0 GiB final,   3.1 GiB peak across the last realloc
#     W = 4096   ->  4.1 GiB final,   6.1 GiB peak
#     W = 8192   ->  8.1 GiB final,  12.2 GiB peak
#
# on top of 17.9 GB of weights that `--load-mode none` reads into RAM because
# MODELS_DIR is a 9p bind mount. The Docker VM has 22 GiB and is shared with
# every other container on the box. The result was not a slow run and not an
# OOM kill: the whole WINDOWS HOST deadlocked and had to be recovered by the
# operator. Twice — once on the real run, once on a four-config timing probe
# that reloaded the model four times in a row.
#
# THE GUARD THAT DID NOT GUARD. The preflight below computes that peak
# correctly — it printed `peak ~12125 MiB` before the run that killed the box —
# and then classified it as TIGHT, a WARNING, because free+swap covered it on
# paper. Swap covering a 12 GiB spike is not the same as the machine surviving
# it. There is no verdict between "ok" and "REFUSED" that is safe here, so
# TIGHT is now a refusal.
#
# AND IT IS NOT WORTH IT ANYWAY, WHICH IS THE PART THAT SETTLES IT.
# perplexity_v2 measured **144.35 s to decode one 2048-token chunk** on this
# stack — 14 tok/s, against 558 tok/s for the default mode's 4096-token chunk
# in the same image with the same weights and the same KV type
# (.kld-logs/20260823T210410Z/base-f16-4096.log, 7.34 s/pass). A 20x slowdown,
# cause NOT isolated: two variables moved at once (-b 512 and the
# all-positions logits request) and the probe that would have separated them is
# what deadlocked the host the second time. At that rate the shallowest arm of
# the intended run is 5 h 20 m and the full ladder is over two days.
#
# SO THE ROUTE IS CLOSED, not merely dangerous. If the §3d depth question is
# picked up again it needs a different instrument — see
# `context/design/kv-cache-fidelity-measured.md` §3d "What has not been tested
# yet", which now records this attempt and what it cost.
#
# WHAT SURVIVED AND IS WORTH KEEPING:
#   * scripts/ppl_stride_analyse.py + its 19 tests. The alignment arithmetic is
#     correct and verified against synthesised logs, including a control that a
#     deliberate one-chunk offset breaks the agreement. If v2 numbers ever
#     arrive by another route, that script aligns them.
#   * perplexity's own token count for deep-s26b5bb is **70,053** — v2 prints it
#     unconditionally where the default mode prints it only on the error path.
#     That closes limit (3)'s bracket of [69,632, 73,727] to an exact number.
#   * The +stride/2 arithmetic (perplexity.cpp:2043) confirmed against a real
#     run: `-c 1792` produced `Calculation chunk = 2048`, n_seq=1, 133 chunks.
#
# ############################################################################
#
# The direct test of the fixed-state hypothesis: score the SAME tokens at two
# different history lengths.
#
#   ./scripts/ppl-stride-run.sh --corpus /captures/corpus/deep-s26b5bb.txt
#   ./scripts/ppl-stride-run.sh --corpus ... --windows 2048,4096,8192 --null-control
#   ./scripts/ppl-stride-run.sh --corpus ... --analyse-only .ppl-stride-logs/<stamp>
#
# WHY. `context/design/kv-cache-fidelity-measured.md` §3d records a result
# nobody can explain: perplexity climbs steeply with n_ctx on this stack —
# 11.61 at 4096, 16.06 at 8192, 94.00 at 16384 — reproducible to four decimals,
# on two different corpora, with the logits path, the batch count, the trained
# context, flash attention and the physical ubatch each refused by its own
# control. §3c gives it a candidate mechanism that is a property of the model
# rather than a defect: `qwen35` is a HYBRID and 48 of its 64 layers are
# state-space with a FIXED-SIZE recurrent state, so a token's loss should depend
# on how much history has been squeezed into that state.
#
# THE CONFOUND THAT MAKES §3d UNREADABLE. `llama-perplexity`'s default mode
# scores positions n_ctx/2 .. n_ctx-1 of each chunk, so changing n_ctx changes
# BOTH how much history a scored token carries AND WHICH TOKENS ARE SCORED —
# every depth partitions the document differently. §3d's "PPL ex-chunk 1" column
# is an attempt to control for that by hand and it does not close it.
#
# WHAT THIS RUNS INSTEAD. `--ppl-stride` selects `perplexity_v2()`, which is a
# different function with a different scoring rule (perplexity.cpp:296-441 at
# the pinned tag, read before this was written):
#
#     chunk i covers tokens [i*stride, i*stride + n_ctx)
#     llama_memory_clear() at the top of every chunk
#     scored: j = n_ctx-stride-1 .. n_ctx-2, i.e. the LAST `stride` tokens
#
# So every scored token carries between n_ctx-stride and n_ctx-1 tokens of
# history — a FIXED history band, whatever the position in the document — and
# consecutive chunks advance by exactly `stride`. Two runs at different n_ctx
# with the SAME stride therefore score the same absolute token ranges, offset by
# a whole number of chunks:
#
#     window W, chunk i  ->  scored tokens [i*S + W - S, i*S + W - 1]
#     so W2's chunk k IS W1's chunk k + (W2-W1)/S, token for token.
#
# That is the measurement §3d could not make. If PPL on the SAME tokens is
# worse at W=8192 than at W=2048, more history is what costs — and the
# fixed-size state is the only thing on this architecture that can charge for
# it. If it is flat, §3c's mechanism is dead and §3d is a partition artefact
# after all.
#
# WHAT IT STILL CANNOT SEPARATE, and this is a real limit rather than a caveat:
# a token cannot carry more history without also sitting at a larger ROPE
# POSITION. History length and position index move together by construction, in
# this tool and in any other. A positive result says "more context costs"; it
# does not say whether the charge is made by the SSM state or by RoPE. What it
# DOES isolate, which §3d does not, is the token set: the tokens, their order
# and their place in the document are identical across arms.
#
# THE ARITHMETIC QUIRK YOU MUST KNOW ABOUT. perplexity.cpp:2040 does
#     params.n_ctx += params.ppl_stride/2;
# AFTER argument parsing, so `-c` is not the window. This script takes
# --windows as the EFFECTIVE window and passes `-c (W - stride/2)`, then reads
# the window back out of the run's own log (`Calculation chunk = N`) rather than
# trusting the arithmetic.
#
# HOST MEMORY, AND WHY THE WINDOWS ARE POWERS OF TWO. perplexity_v2 requests
# logits for EVERY position and accumulates the whole chunk into one
# std::vector<float> of W * n_vocab floats — 8.1 GiB at W=8192 with this
# model's n_vocab of 248,320 — with no reserve() anywhere. The vector therefore
# reallocs geometrically, and during the last realloc the old and new buffers
# are both live. Choosing W as a power-of-two multiple of the batch makes the
# final insert land exactly on capacity, which caps the peak at 1.5x instead of
# 3x. The preflight simulates libstdc++'s growth rule rather than assuming it.
#
# WHAT IT COSTS. Every chunk is a full W-token prefill from a cleared cache, so
# an arm costs n_chunk * W tokens of prefill — ~1.0M tokens at W=8192 on a
# 70k-token corpus. llama-perplexity loads its own copy of the weights, so
# instantcoffee-llama is stopped for the whole run and restarted by a trap on every
# exit path. --load-mode none is NOT optional; see kld-run.sh's header.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker

CORPUS=""
WINDOWS="2048,4096,8192"
STRIDE=512
BATCH=512
KV="f16"
OUT_SUBDIR="ppl-stride"
NULL_CONTROL=0
UNPINNED=0
CHUNKS=""
DRY=0
ANALYSE_ONLY=""
ARMED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus) CORPUS="${2:-}"; shift 2 || die "--corpus needs a value" ;;
    --corpus=*) CORPUS="${1#*=}"; shift ;;
    --windows) WINDOWS="${2:-}"; shift 2 || die "--windows needs a value" ;;
    --windows=*) WINDOWS="${1#*=}"; shift ;;
    --stride) STRIDE="${2:-}"; shift 2 || die "--stride needs a value" ;;
    --stride=*) STRIDE="${1#*=}"; shift ;;
    --batch) BATCH="${2:-}"; shift 2 || die "--batch needs a value" ;;
    --batch=*) BATCH="${1#*=}"; shift ;;
    --kv) KV="${2:-}"; shift 2 || die "--kv needs a value" ;;
    --kv=*) KV="${1#*=}"; shift ;;
    --chunks) CHUNKS="${2:-}"; shift 2 || die "--chunks needs a value" ;;
    --chunks=*) CHUNKS="${1#*=}"; shift ;;
    --out-subdir) OUT_SUBDIR="${2:-}"; shift 2 || die "--out-subdir needs a value" ;;
    --null-control) NULL_CONTROL=1; shift ;;
    --unpinned) UNPINNED=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --i-have-read-the-deadlock-note) ARMED=1; shift ;;
    --analyse-only) ANALYSE_ONLY="${2:-}"; shift 2 || die "--analyse-only needs a directory" ;;
    --analyse-only=*) ANALYSE_ONLY="${1#*=}"; shift ;;
    -h|--help) sed -n '2,86p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
done

LLAMA_TAG_V="$(env_get LLAMA_TAG)";      : "${LLAMA_TAG_V:=server-cuda-b10573}"
GGUF="$(env_get GGUF_FILE)";             [[ -n "$GGUF" ]] || die "GGUF_FILE is not set in .env"
MODELS="$(env_get MODELS_DIR)";          [[ -n "$MODELS" ]] || die "MODELS_DIR is not set in .env"
CAPS="$(env_get CAPTURES_DIR)";          [[ -n "$CAPS" ]] || die "CAPTURES_DIR is not set in .env"
NGL="$(env_get NGL)";                    : "${NGL:=999}"
IMAGE="ghcr.io/ggml-org/llama.cpp:${LLAMA_TAG_V}"
SIDECAR_IMAGE="instantcoffee/proxy:$(env_get FORGE_VERSION)"
LLAMA_CT="${LLAMA_CONTAINER:-instantcoffee-llama}"
ANALYSER="${REPO_ROOT}/scripts/ppl_stride_analyse.py"

# --analyse-only re-reads an earlier run's logs. It exists because the arms are
# the expensive part and the alignment arithmetic is the part worth iterating on.
if [[ -n "$ANALYSE_ONLY" ]]; then
  [[ -d "$ANALYSE_ONLY" ]] || die "$ANALYSE_ONLY is not a directory"
  mapfile -t logs < <(find "$ANALYSE_ONLY" -maxdepth 1 -name 'w*.log' | sort -t w -k2 -n)
  (( ${#logs[@]} )) || die "no w*.log files in $ANALYSE_ONLY"
  exec python3 "$ANALYSER" "${logs[@]}" --stride "$STRIDE" --per-chunk \
       --json "${ANALYSE_ONLY}/aligned.json"
fi

# ---------------------------------------------------------------------------
# The gate. See the banner at the top of this file.
#
# --dry-run is exempt: it stops nothing, starts nothing and allocates nothing,
# and being able to read the preflight's memory verdicts WITHOUT arming the run
# is the whole point of keeping this script rather than deleting it.
# ---------------------------------------------------------------------------
if (( ! DRY && ! ARMED )); then
  cat >&2 <<'REFUSE'
err  REFUSING TO RUN.

     This script deadlocked the Windows host on 2026-08-24, twice. It is not a
     slow run and not an OOM kill — the machine stops and an operator has to
     recover it.

     CAUSE: perplexity_v2 requests logits for every position and accumulates
     n_ctx * n_vocab floats (8.1 GiB at window 8192 with n_vocab 248,320, 12.2
     GiB across the last realloc) on top of 17.9 GB of weights that
     --load-mode none reads into RAM, on a 22 GiB VM shared with every other
     container on this box.

     AND IT IS NOT WORTH THE RISK: perplexity_v2 measured 144.35 s per
     2048-token chunk here, 20x slower per token than the default mode. The
     shallowest arm of the intended run is over five hours.

     Read the banner at the top of this file and
     context/design/kv-cache-fidelity-measured.md section 3d before arming it.

     --dry-run works and is safe: it prints every command and the memory
     verdicts, and touches nothing.
REFUSE
  exit 1
fi

[[ -n "$CORPUS" ]] || die "--corpus is required (a file under \$CAPTURES_DIR, addressed as /captures/...)"
case "$CORPUS" in
  /captures/*) ;;
  *) die "--corpus must be a /captures/... path: the runner mounts \$CAPTURES_DIR there and nothing else is visible to it" ;;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_LOGDIR="${REPO_ROOT}/.ppl-stride-logs/${STAMP}"

# ---------------------------------------------------------------------------
# The arm list. A repeated window IS the null control: the same configuration
# in a second process, which is the only thing that establishes that a
# difference between two windows is a difference and not run-to-run noise.
# It is placed SECOND rather than last so a non-deterministic engine aborts the
# run after two cheap arms instead of after an hour of them.
# ---------------------------------------------------------------------------
WIN_LIST=()
for w in ${WINDOWS//,/ }; do WIN_LIST+=("$w"); done
(( ${#WIN_LIST[@]} )) || die "--windows is empty"
IFS=$'\n' WIN_LIST=($(printf '%s\n' "${WIN_LIST[@]}" | sort -n)); unset IFS

ARMS=()
for i in "${!WIN_LIST[@]}"; do
  ARMS+=("${WIN_LIST[$i]}:a")
  if (( NULL_CONTROL && i == 0 )); then ARMS+=("${WIN_LIST[$i]}:null"); fi
done

arm_log() { echo "${LOCAL_LOGDIR}/w$1${2:+-$2}.log"; }

# ---------------------------------------------------------------------------
# n_vocab out of the GGUF's own metadata — see lib.sh. Everything that bounds
# this run's host-memory cost is n_ctx * n_vocab, so it has to be a fact.
# ---------------------------------------------------------------------------

# libstdc++'s vector growth, simulated rather than assumed.
#
# perplexity_v2 does `logits.insert(logits.end(), ...)` once per batch with no
# reserve(), so capacity follows _M_check_len: newcap = max(2*cap, size+n). The
# old and new buffers are both live across a realloc, which is the peak that
# actually has to fit. Echoes "<peak_elements> <final_elements>".
vector_peak() {
  local total="$1" batch="$2"
  local cap=0 size=0 peak=0 n newcap
  while (( size < total )); do
    n=$(( total - size < batch ? total - size : batch ))
    if (( size + n > cap )); then
      newcap=$(( 2 * cap > size + n ? 2 * cap : size + n ))
      (( cap + newcap > peak )) && peak=$(( cap + newcap ))
      cap=$newcap
    fi
    size=$(( size + n ))
  done
  (( cap > peak )) && peak=$cap
  echo "$peak $cap"
}

preflight() {
  echo "==> preflight"

  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || die "image $IMAGE is not present locally; pull it before stopping the server"
  docker run --rm -v "${MODELS}:/models:ro" alpine test -f "/models/${GGUF}" \
    || die "/models/${GGUF} is not readable through the MODELS_DIR mount"
  docker run --rm -v "${CAPS}:/captures" alpine test -f "$CORPUS" \
    || die "corpus $CORPUS is not readable through the CAPTURES_DIR mount"

  # ---- the stride/window arithmetic, refused before anything is stopped -----
  #
  # These are not style preferences. Each one silently produces a run that looks
  # fine and answers a different question than the one asked.
  (( STRIDE > 0 && STRIDE % 2 == 0 )) \
    || die "--stride must be a positive EVEN number: perplexity.cpp:2043 adds stride/2 to n_ctx with integer division, so an odd stride loses half a token off the window"
  local base_w="${WIN_LIST[0]}" w
  for w in "${WIN_LIST[@]}"; do
    (( w > STRIDE )) || die "window $w must exceed the stride $STRIDE — perplexity_v2 scores j = n_ctx-stride-1 .. n_ctx-2, which is empty otherwise"
    (( (w - base_w) % STRIDE == 0 )) \
      || die "window $w is not $base_w plus a whole number of strides ($STRIDE). Its chunks land BETWEEN the other arms' chunks, so no arm scores the same tokens as any other and the comparison this script exists to make does not exist."
    local c=$(( w - STRIDE / 2 ))
    (( c > 0 )) || die "window $w gives -c $c"
    # perplexity.cpp:2036  params.n_parallel = max(1, n_batch / n_ctx);
    #                      params.n_ctx      = n_parallel * n_ctx;
    # so a batch at least as large as -c MULTIPLIES the window without saying so.
    (( BATCH < c )) \
      || die "--batch $BATCH is >= -c $c for window $w; perplexity.cpp sets n_parallel = n_batch/n_ctx and then MULTIPLIES n_ctx by it, so the window would not be $w"
  done

  local bytes; bytes="$(docker run --rm -v "${CAPS}:/captures" alpine stat -c %s "$CORPUS")"
  echo "    corpus        $CORPUS  ${bytes} bytes"

  # ---- the corpus must be pinned to the server's own token counter ----------
  # Same rule and same reason as kld-run.sh: a corpus that failed its export
  # control measures a prompt the model never saw, and it looks like a good file.
  local side="${CORPUS}.meta.json" sidecar_rc=0 report
  if docker run --rm -v "${CAPS}:/captures" alpine test -f "$side"; then
    report="$(docker run --rm -v "${CAPS}:/captures" --entrypoint python "$SIDECAR_IMAGE" -c "
import json, sys
m = json.load(open('$side'))
sr = m.get('server_reported') or {}
exp = sr.get('sum') or 0
tok = m.get('tokens') or 0
delta = m.get('token_delta')
gaps = m.get('gaps') or []
verdict = 'UNPINNED'
if exp:
    verdict = 'OK' if abs(delta) <= max(16, exp * 0.01) else 'SUSPECT'
print(f\"tokens={tok} server={exp} delta={delta} verdict={verdict} \"
      f\"msgs={m.get('n_messages')} tools={m.get('n_tools')} gaps={gaps or 'none'}\")
sys.exit(0 if (verdict == 'OK' and not gaps) else 1)
" 2>&1)" || sidecar_rc=1
    echo "    sidecar       ${report//$'\n'/$'\n'                  }"
  else
    sidecar_rc=1
    echo "    sidecar       ABSENT at ${side}"
  fi
  if (( sidecar_rc )); then
    echo "    REFUSING: corpus not pinned. Rebuild with 'capture.sh export', or pass --unpinned."
    (( UNPINNED )) || return 1
    echo "    --unpinned given; continuing anyway."
  fi

  # ---- host memory, sized on what perplexity_v2 actually allocates ----------
  #
  # This is a DIFFERENT formula from kld-run.sh's, and using that one here would
  # under-predict badly. The KL path holds (n_ctx/2)*n_vocab*4 of logits because
  # only the second half of a chunk requests them; perplexity_v2 requests logits
  # for EVERY position (`common_batch_add(..., true)` unconditionally) and
  # accumulates the WHOLE chunk — n_ctx*n_vocab*4 — even though it only ever
  # reads the last `stride` rows of it. There is no logits FILE in this mode, so
  # the silent-short-write failure of §3b cannot happen; the failure here is
  # swapping or the OOM killer.
  local nvocab
  nvocab="$(gguf_n_vocab "$MODELS" "$GGUF" "$SIDECAR_IMAGE")"
  if [[ "$nvocab" =~ ^[0-9]+$ ]]; then
    echo "    n_vocab       ${nvocab} (tokenizer.ggml.tokens, read from the GGUF)"
  else
    echo "    n_vocab       COULD NOT BE READ: ${nvocab}"
    echo "                  host-memory verdicts are NOT printed rather than guessed."
    nvocab=""
  fi
  local avail_mb; avail_mb="$(docker run --rm alpine free -m | awk '/^Mem:/{print $7}')"
  local swap_mb;  swap_mb="$(docker run --rm alpine free -m | awk '/^Swap:/{print $4}')"

  # THE SERVER'S OWN MEMORY IS ABOUT TO BE RELEASED, and not counting it turns a
  # runnable window into a refusal. This script stops instantcoffee-llama before the
  # first arm, so whatever it is holding right now is headroom the arms will
  # actually have. It is added EXPLICITLY and printed on its own line rather than
  # folded into `avail_mb`, because "free memory" that depends on an action this
  # script has not taken yet is exactly the kind of number that should not be
  # quietly inflated. If the stop fails, the run dies at `docker stop` and never
  # reaches an arm.
  local llama_mb=0
  if docker inspect -f '{{.State.Running}}' "$LLAMA_CT" 2>/dev/null | grep -q true; then
    llama_mb="$(docker stats --no-stream --format '{{.MemUsage}}' "$LLAMA_CT" 2>/dev/null \
                | awk '{v=$1; u=$1; sub(/[0-9.]+/,"",u); sub(/[A-Za-z]+/,"",v);
                        printf "%d", (u ~ /^G/ ? v*1024 : (u ~ /^M/ ? v : v/1024)) }')"
    [[ "$llama_mb" =~ ^[0-9]+$ ]] || llama_mb=0
  fi
  echo "    host memory   ${avail_mb} MiB available, ${swap_mb} MiB free swap"
  if (( llama_mb > 0 )); then
    echo "                  + ${llama_mb} MiB held by ${LLAMA_CT}, which this run stops"
    echo "                  = ${avail_mb} + ${llama_mb} = $(( avail_mb + llama_mb )) MiB for the arms"
    avail_mb=$(( avail_mb + llama_mb ))
  fi

  local blocked=0
  for w in "${WIN_LIST[@]}"; do
    local need_tok=$(( 2 * w ))          # perplexity_v2's own guard, verbatim
    local verdict="ok"
    local peak_mb=0 final_mb=0
    if [[ -n "$nvocab" ]]; then
      read -r pk fin <<<"$(vector_peak $(( w * nvocab )) $(( BATCH * nvocab )))"
      # + llama's own host-side output buffer, one batch wide.
      peak_mb=$(( (pk * 4 + BATCH * nvocab * 4) / 1048576 ))
      final_mb=$(( (fin * 4 + BATCH * nvocab * 4) / 1048576 ))
    fi
    if [[ -n "$REF_TOKENS" ]] && (( REF_TOKENS < need_tok )); then
      verdict="REFUSED: perplexity_v2 needs ${need_tok} tokens, the corpus has ~${REF_TOKENS}"
      blocked=1
    elif [[ -z "$nvocab" ]]; then
      verdict="unchecked: n_vocab unknown, so host memory was not verified"
    elif (( peak_mb > avail_mb + swap_mb )); then
      verdict="REFUSED: peak ~${peak_mb} MiB, only $(( avail_mb + swap_mb )) MiB incl. swap"
      blocked=1
    elif (( peak_mb > avail_mb )); then
      # NOT a warning. This exact verdict printed `peak ~12125 MiB` against
      # 15333 MiB and the run that followed deadlocked the Windows host. Swap
      # covering the spike on paper is not the machine surviving it.
      verdict="REFUSED: peak ~${peak_mb} MiB (settling to ~${final_mb}) against
                  ${avail_mb} MiB free. It would swap, and a swapping arm of this
                  shape took the host down on 2026-08-24. Free real memory or
                  drop the window; do not lean on swap."
      blocked=1
    else
      verdict="ok: peak ~${peak_mb} MiB, settling to ~${final_mb}; needs ${need_tok} tokens"
    fi
    printf '    window %-6s -c %-6s %s\n' "$w" "$(( w - STRIDE / 2 ))" "$verdict"
  done
  if (( blocked )); then
    echo
    echo "    At least one window cannot run. Drop it, reclaim memory, or lower --batch"
    echo "    (the peak is dominated by n_ctx*n_vocab and only weakly by the batch)."
    (( DRY )) || return 1
  fi

  local recent
  recent="$(docker logs --since 10m "$LLAMA_CT" 2>&1 | grep -cE 'slot launch_slot_|prompt processing' || true)"
  echo "    llama traffic ${recent} task lines in the last 10 minutes"
  if (( recent > 0 )); then
    if (( DRY )); then
      echo "    (a dry run stops nothing, so this is a note rather than a refusal)"
    else
      echo
      echo "    REFUSING: something is using the server right now."
      return 1
    fi
  fi
  return 0
}

# ---------------------------------------------------------------------------
# One arm.
# ---------------------------------------------------------------------------
pass() {
  local window="$1" label="$2" log="$3"
  local c=$(( window - STRIDE / 2 ))
  local extra=()
  [[ -n "$CHUNKS" ]] && extra+=(--chunks "$CHUNKS")

  local cmd=(
    docker run --rm --gpus all
      -v "${MODELS}:/models:ro"
      -v "${CAPS}:/captures"
      --entrypoint /app/llama
      "$IMAGE" perplexity
      -m "/models/${GGUF}"
      -f "$CORPUS"
      -c "$c"
      --ppl-stride "$STRIDE"
      -ngl "$NGL"
      -fa on
      -ctk "$KV" -ctv "$KV"
      -kvu
      -np 1
      -b "$BATCH"
      -ub "$BATCH"
      --load-mode none
      "${extra[@]}"
  )

  echo
  echo "--- window ${window}  (-c ${c} +stride/2)  ${label}  ->  ${log}"
  printf '   '; printf ' %q' "${cmd[@]}"; echo
  if (( DRY )); then return 0; fi

  "${cmd[@]}" > "$log" 2>&1
  local rc=$?
  echo "    exit ${rc}"
  # The running series is the result; show its head and tail rather than 25
  # lines of tensor warnings.
  grep -oE '^\[1\].*' "$log" | head -c 400 | sed 's/^/    | /'
  echo
  grep -E 'have [0-9]+ tokens|computing over' "$log" | sed 's/^/    | /'
  return $rc
}

(( DRY )) || mkdir -p "$LOCAL_LOGDIR"

echo "strided-perplexity run   ${STAMP}"
echo "  image     ${IMAGE}"
echo "  model     /models/${GGUF}"
echo "  corpus    ${CORPUS}"
echo "  windows   ${WINDOWS}   (EFFECTIVE n_ctx; -c is this minus stride/2)"
echo "  stride    ${STRIDE}    (tokens scored per chunk, and the chunk advance)"
echo "  kv        ${KV}        (orthogonal here: the 48 SSM layers ignore -ctk/-ctv)"
echo "  arms      ${ARMS[*]}"
if (( ! NULL_CONTROL )); then
  echo
  echo "  NOTE: no null control. Nothing establishes that a difference between two"
  echo "        windows is larger than run-to-run noise. Add --null-control unless"
  echo "        one has already been run against this corpus and this model."
fi
echo "  logs      ${LOCAL_LOGDIR}"

REF_TOKENS=""
if [[ -z "${SKIP_TOKENIZE:-}" ]]; then
  ref="$(compose --profile tools run --rm --no-deps --entrypoint python sessions -c "
import json, os, urllib.request
url = os.environ.get('LLAMA_URL', 'http://llama:8080')
text = open('$CORPUS', encoding='utf-8').read()
req = urllib.request.Request(url + '/tokenize',
        data=json.dumps({'content': text}).encode(),
        headers={'Content-Type': 'application/json'})
print(len(json.load(urllib.request.urlopen(req, timeout=300))['tokens']))
" 2>/dev/null | tail -n 1)"
  [[ "$ref" =~ ^[0-9]+$ ]] && REF_TOKENS="$ref"
fi
echo
if [[ -n "$REF_TOKENS" ]]; then
  echo "  tokens    ${REF_TOKENS} through llama's own /tokenize (control tokens PARSED)."
  echo "            perplexity parses none, and — unlike its default mode — v2 PRINTS"
  echo "            its own count, so this run closes that bracket exactly."
else
  echo "  tokens    llama's /tokenize did not answer; perplexity_v2 prints its own count."
fi

preflight || die "preflight failed; nothing was stopped"

if (( DRY )); then
  echo
  echo "==> dry run: the arms that WOULD run"
  for a in "${ARMS[@]}"; do
    w="${a%%:*}"; lab="${a##*:}"
    [[ "$lab" == "a" ]] && lab=""
    pass "$w" "${lab:-arm}" "$(arm_log "$w" "$lab")"
  done
  echo
  echo "dry run only; ${LLAMA_CT} was not touched."
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

FAILED=0
DONE_LOGS=()
for a in "${ARMS[@]}"; do
  w="${a%%:*}"; lab="${a##*:}"
  [[ "$lab" == "a" ]] && lab=""
  log="$(arm_log "$w" "$lab")"
  if pass "$w" "${lab:-arm}" "$log"; then
    DONE_LOGS+=("$log")
  else
    FAILED=1
    echo "    window ${w} ${lab:-arm} failed; its log is kept at ${log}"
    # A partial log is still worth aligning — the analyser reports it as
    # INCOMPLETE rather than pretending the arm finished.
    [[ -s "$log" ]] && DONE_LOGS+=("$log")
  fi

  # The null control decides whether anything after it is worth running.
  if [[ "$lab" == "null" ]]; then
    if ! python3 "$ANALYSER" "$(arm_log "$w" "")" "$log" --stride "$STRIDE" >/dev/null 2>&1; then
      echo "    the null control could not be parsed; continuing, but read the logs"
    elif ! diff -q <(grep -oE '\[[0-9]+\][0-9.]+' "$(arm_log "$w" "")") \
                   <(grep -oE '\[[0-9]+\][0-9.]+' "$log") >/dev/null; then
      echo
      echo "    NULL CONTROL FAILED: the same window in two processes did not produce"
      echo "    the same running series. Nothing below would be readable, so the run"
      echo "    stops here rather than spending an hour producing numbers nobody can"
      echo "    subtract."
      FAILED=1
      break
    else
      echo "    null control: identical to every printed digit"
    fi
  fi
done

echo
echo "==> alignment"
if (( ${#DONE_LOGS[@]} )); then
  python3 "$ANALYSER" "${DONE_LOGS[@]}" --stride "$STRIDE" --per-chunk \
      --json "${LOCAL_LOGDIR}/aligned.json" || FAILED=1
else
  echo "    no arm produced a log"
  FAILED=1
fi

echo
echo "==> logs in ${LOCAL_LOGDIR}"
exit $FAILED
