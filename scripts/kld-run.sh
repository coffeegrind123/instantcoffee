#!/usr/bin/env bash
#
# The q8_0-vs-f16 KV-cache fidelity run.
#
#   ./scripts/kld-run.sh --corpus /captures/corpus/deep.txt [--depths 8192,65536]
#   ./scripts/kld-run.sh --corpus ... --dry-run       print the four commands, run nothing
#
# WHY. context/design/inference-divergence-and-this-stack.md §4: this stack
# adopted q8_0 KV on throughput and VRAM and never on fidelity, and §7 item 4
# is the measurement that would price the real trade — 96K at q8_0 against
# ~64K at f16. `llama-perplexity --kl-divergence` reports mean/median KLD, its
# quantiles, and same-top-token agreement, teacher-forced and reproducible.
#
# TWO DEPTHS, NOT ONE. The article's headline is that divergence GROWS past
# ~40k. One number at 64K cannot show growth; the same corpus at 8K and at 64K
# can, and costs one extra pass per arm inside the same llama stop.
#
# --load-mode none IS NOT OPTIONAL HERE, and leaving it off does not fail — it
# HANGS. MODELS_DIR is a Docker Desktop bind mount, which is 9p, and
# demand-paging the GGUF through it was measured at 6.4 MB/s of resident growth
# on the first attempt at this run: 31 minutes in, 12.5 of 17.9 GB resident, no
# output past the tensor warnings, and the process indistinguishable from a
# stuck one. .env says the same thing about the server for the same reason
# (LLAMA_EXTRA_FLAGS carries it); this script has to say it separately because
# it does not go through compose.
#
# WHAT IT COSTS. llama-perplexity loads its own copy of the weights, so
# qwen38-llama must be STOPPED for the whole run — one ~20 minute cold reload
# afterwards over the 9p mount. All four passes therefore run inside ONE stop.
# 96K at f16 does not fit on this card (§6); 64K does, at ~20.5 GiB.
#
# THE CORPUS COMES FIRST, AND llama MUST BE UP TO BUILD IT.
# `capture.sh export` renders through llama's own /apply-template. Build the
# corpus, check its control passed, and only then run this.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker

CORPUS=""
DEPTHS="4096,8192,16384"
OUT_SUBDIR="kld"
DRY=0
KEEP_LOGITS=0
UNPINNED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus) CORPUS="${2:-}"; shift 2 || die "--corpus needs a value" ;;
    --corpus=*) CORPUS="${1#*=}"; shift ;;
    --depths) DEPTHS="${2:-}"; shift 2 || die "--depths needs a value" ;;
    --depths=*) DEPTHS="${1#*=}"; shift ;;
    --out-subdir) OUT_SUBDIR="${2:-}"; shift 2 || die "--out-subdir needs a value" ;;
    --keep-logits) KEEP_LOGITS=1; shift ;;
    --unpinned) UNPINNED=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
done

[[ -n "$CORPUS" ]] || die "--corpus is required (a file under \$CAPTURES_DIR, addressed as /captures/...)"
case "$CORPUS" in
  /captures/*) ;;
  *) die "--corpus must be a /captures/... path: the runner mounts \$CAPTURES_DIR there and nothing else is visible to it" ;;
esac

LLAMA_TAG_V="$(env_get LLAMA_TAG)";      : "${LLAMA_TAG_V:=server-cuda-b10573}"
GGUF="$(env_get GGUF_FILE)";             [[ -n "$GGUF" ]] || die "GGUF_FILE is not set in .env"
MODELS="$(env_get MODELS_DIR)";          [[ -n "$MODELS" ]] || die "MODELS_DIR is not set in .env"
CAPS="$(env_get CAPTURES_DIR)";          [[ -n "$CAPS" ]] || die "CAPTURES_DIR is not set in .env"
NGL="$(env_get NGL)";                    : "${NGL:=999}"
IMAGE="ghcr.io/ggml-org/llama.cpp:${LLAMA_TAG_V}"
# The llama.cpp image has no python; the forge image does, and it is already
# built on this box because capture.sh builds it. Only used to read the sidecar.
SIDECAR_IMAGE="qwen38-forge/proxy:$(env_get FORGE_VERSION)"
LLAMA_CT="${LLAMA_CONTAINER:-qwen38-llama}"

OUTDIR="/captures/${OUT_SUBDIR}"
REF_TOKENS=""
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ---------------------------------------------------------------------------
# Preflight. Everything that can be checked without stopping the server is
# checked BEFORE the server is stopped — a failure discovered after the stop
# costs a 20-minute reload to find out.
# ---------------------------------------------------------------------------
preflight() {
  echo "==> preflight"

  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || die "image $IMAGE is not present locally; pull it before stopping the server"

  docker run --rm -v "${MODELS}:/models:ro" alpine test -f "/models/${GGUF}" \
    || die "/models/${GGUF} is not readable through the MODELS_DIR mount"

  docker run --rm -v "${CAPS}:/captures" alpine test -f "$CORPUS" \
    || die "corpus $CORPUS is not readable through the CAPTURES_DIR mount"

  local deepest=0 d
  for d in ${DEPTHS//,/ }; do (( d > deepest )) && deepest=$d; done
  local bytes; bytes="$(docker run --rm -v "${CAPS}:/captures" alpine stat -c %s "$CORPUS")"
  echo "    corpus        $CORPUS  ${bytes} bytes"

  # The sidecar `capture.sh export` writes beside the corpus is what pins the
  # reconstruction to the server's own token counter. A corpus that failed that
  # control measures a prompt the model never saw, which is the one failure this
  # whole exercise exists to avoid — and it looks like a perfectly good file.
  # The sidecar is read HERE, not trusted from memory, and a SUSPECT verdict or
  # a non-empty `gaps` list refuses the run.
  local side="${CORPUS}.meta.json"
  local sidecar_rc=0
  if docker run --rm -v "${CAPS}:/captures" alpine test -f "$side"; then
    local report
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
print('CUT ' + str(m.get('corpus_cut')))
sys.exit(0 if (verdict == 'OK' and not gaps) else 1)
" 2>&1)" || sidecar_rc=1
    echo "    sidecar       ${report//$'\n'/$'\n'                  }"
  else
    sidecar_rc=1
    echo "    sidecar       ABSENT at ${side} — this corpus was not built by"
    echo "                  capture.sh export, so nothing pins it to the server's"
    echo "                  own token counter."
  fi
  if (( sidecar_rc )); then
    echo
    echo "    REFUSING: the corpus is not pinned (SUSPECT delta, declared gaps, or no"
    echo "    sidecar at all). Rebuild it with 'capture.sh export', or, if you"
    echo "    deliberately want prose-at-depth rather than tool fidelity, say so by"
    echo "    passing --unpinned."
    (( UNPINNED )) || return 1
    echo "    --unpinned given; continuing anyway."
  fi

  # ---- the tokenizer mismatch, measured rather than assumed --------------
  #
  # llama-perplexity tokenizes its -f file with parse_special = FALSE. Read at
  # the pinned tag rather than inferred: tools/perplexity/perplexity.cpp calls
  #     common_tokenize(ctx, params.prompt, true)
  # and common.h declares
  #     bool parse_special = false
  # as the fourth parameter's default. There is no flag to change it — the whole
  # argument list was checked for one.
  #
  # So the `<|im_start|>` / `<|im_end|>` markers that `capture.sh export` renders
  # through the real chat template arrive at perplexity as ORDINARY TEXT and are
  # split into several pieces each, instead of the single control token the
  # server used. The comparison between the two arms is unaffected — both arms
  # see the identical token sequence — but the sequence is not byte-for-byte the
  # one the model saw at serve time, and that is exactly the kind of thing this
  # repo refuses to leave implicit.
  #
  # The size of the effect is measurable and is measured here: llama's own
  # /tokenize DOES parse specials, so its count is the serve-time reference, and
  # perplexity prints its own count at the top of every run. The two are printed
  # side by side in the summary.
  if [[ -z "${SKIP_TOKENIZE:-}" ]]; then
    local ref
    ref="$(compose --profile tools run --rm --no-deps --entrypoint python sessions -c "
import json, os, urllib.request
url = os.environ.get('LLAMA_URL', 'http://llama:8080')
text = open('$CORPUS', encoding='utf-8').read()
req = urllib.request.Request(url + '/tokenize',
        data=json.dumps({'content': text}).encode(),
        headers={'Content-Type': 'application/json'})
print(len(json.load(urllib.request.urlopen(req, timeout=300))['tokens']))
" 2>/dev/null | tail -n 1)"
    if [[ "$ref" =~ ^[0-9]+$ ]]; then
      REF_TOKENS="$ref"
      echo "    tokens        ${REF_TOKENS} through llama's own /tokenize (control tokens PARSED)"
      echo "                  perplexity will report a LARGER number: it parses none. See the"
      echo "                  note in this script for the source line that causes it."
    else
      echo "    tokens        llama's /tokenize did not answer; the run will still work,"
      echo "                  but there is nothing to compare perplexity's count against."
    fi
  fi

  # ---- the two limits that actually bound the depth of this experiment ------
  #
  # Both were read out of tools/perplexity/perplexity.cpp at the pinned tag, not
  # inferred from a failure, and neither is the VRAM limit the design document
  # predicted would be the binding one.
  #
  # (1) THE CORPUS MUST HOLD AT LEAST 2*n_ctx TOKENS.
  #         if (int(tokens.size()) < 2*n_ctx) { ...error...; return; }
  #     The run scores only the SECOND half of each chunk (`const int first =
  #     n_ctx/2`), using the first half as context, so a chunk is only counted
  #     when a whole second one can follow it. The consequence is structural and
  #     worth stating plainly: a server with a CTX_SIZE-token window can only
  #     ever produce a captured corpus of CTX_SIZE tokens, so the deepest KLD
  #     arm a captured workstream can support is CTX_SIZE/2. On this stack that
  #     is 49,152 — and 64K, the depth §6 of the divergence document asks for,
  #     is not reachable from a real session at all. It would need a corpus
  #     twice this server's own context window.
  #
  # (2) HOST RAM, NOT VRAM, IS THE CEILING.
  #     The base arm holds two buffers sized on n_ctx:
  #         logits.reserve(size_t(n_ctx) * n_vocab)          4 B per entry
  #         log_probs.resize(size_t(n_ctx) * nv)             2 B per entry
  #     with n_vocab 151,936 and nv = 2*((n_vocab+1)/2)+4. That is ~0.87 GiB of
  #     ordinary host memory per 1,024 tokens of n_ctx, on top of everything
  #     else on the box. 64K would want ~56 GiB. The card is irrelevant to it.
  local nvocab=151936
  local avail_mb; avail_mb="$(docker run --rm alpine free -m | awk '/^Mem:/{print $7}')"
  local swap_mb;  swap_mb="$(docker run --rm alpine free -m | awk '/^Swap:/{print $4}')"
  echo "    host memory   ${avail_mb} MiB available, ${swap_mb} MiB free swap"
  local blocked=0
  for d in ${DEPTHS//,/ }; do
    local need_mb=$(( d * (nvocab * 4 + (nvocab + 8) * 2) / 1048576 ))
    local need_tok=$(( 2 * d ))
    local verdict="ok"
    if [[ -n "$REF_TOKENS" ]] && (( REF_TOKENS < need_tok )); then
      verdict="REFUSED: needs ${need_tok} tokens, the corpus has ${REF_TOKENS}"
      blocked=1
    elif (( need_mb > avail_mb + swap_mb )); then
      verdict="REFUSED: needs ~${need_mb} MiB host RAM, only $(( avail_mb + swap_mb )) MiB incl. swap"
      blocked=1
    elif (( need_mb > avail_mb )); then
      verdict="tight: ~${need_mb} MiB wanted against ${avail_mb} MiB free — will swap"
    else
      verdict="ok: ~${need_mb} MiB host RAM, ${need_tok} tokens needed"
    fi
    printf '    n_ctx %-6s %s\n' "$d" "$verdict"
  done
  if (( blocked )); then
    echo
    echo "    At least one depth cannot run. Drop it from --depths, or build a"
    echo "    longer corpus — but note limit (1): a captured session cannot exceed"
    echo "    the server's own context window, so n_ctx above CTX_SIZE/2 is not"
    echo "    reachable from real traffic at all."
    (( DRY )) || return 1
  fi

  docker run --rm -v "${CAPS}:/captures" alpine mkdir -p "$OUTDIR" \
    || die "cannot create $OUTDIR under the captures mount"

  local free; free="$(docker run --rm -v "${CAPS}:/captures" alpine df -Pm /captures | awk 'NR==2{print $4}')"
  echo "    free on tape  ${free} MiB"

  # A live session dies mid-turn when llama stops. Ten minutes of quiet is not
  # the same as nobody being there — this is the check the last session did not
  # make before restarting forge.
  local recent
  recent="$(docker logs --since 10m "$LLAMA_CT" 2>&1 | grep -cE 'slot launch_slot_|prompt processing' || true)"
  echo "    llama traffic ${recent} task lines in the last 10 minutes"
  if (( recent > 0 )); then
    if (( DRY )); then
      echo "    (a dry run stops nothing, so this is a note rather than a refusal)"
    else
      echo
      echo "    REFUSING: something is using the server right now. Stopping it would"
      echo "    kill that session mid-turn. Wait for it, or stop it deliberately."
      return 1
    fi
  fi
  return 0
}

# ---------------------------------------------------------------------------
# One pass. arm=base writes the logits file; arm=test reads it and reports.
# ---------------------------------------------------------------------------
pass() {
  local arm="$1" kvtype="$2" depth="$3" logits="$4" log="$5"
  local extra=()
  if [[ "$arm" == "test" ]]; then extra+=(--kl-divergence); fi

  local cmd=(
    docker run --rm --gpus all
      -v "${MODELS}:/models:ro"
      -v "${CAPS}:/captures"
      --entrypoint /app/llama
      "$IMAGE" perplexity
      -m "/models/${GGUF}"
      -f "$CORPUS"
      -c "$depth"
      -ngl "$NGL"
      -fa on
      -ctk "$kvtype" -ctv "$kvtype"
      -kvu
      -np 1
      -ub 512
      --load-mode none
      --kl-divergence-base "$logits"
      "${extra[@]}"
  )

  echo
  echo "--- ${arm}  kv=${kvtype}  n_ctx=${depth}  ->  ${log}"
  printf '   '; printf ' %q' "${cmd[@]}"; echo
  if (( DRY )); then return 0; fi

  # Tee through the captures mount so the raw output survives this shell.
  "${cmd[@]}" > "${LOCAL_LOGDIR}/$(basename "$log")" 2>&1
  local rc=$?
  echo "    exit ${rc}"
  tail -n 25 "${LOCAL_LOGDIR}/$(basename "$log")" | sed 's/^/    | /'
  return $rc
}

LOCAL_LOGDIR="${REPO_ROOT}/.kld-logs/${STAMP}"
mkdir -p "$LOCAL_LOGDIR"

echo "q8_0-vs-f16 KV fidelity run   ${STAMP}"
echo "  image     ${IMAGE}"
echo "  model     /models/${GGUF}"
echo "  corpus    ${CORPUS}"
echo "  depths    ${DEPTHS}"
echo "  logs      ${LOCAL_LOGDIR}"
echo

preflight || die "preflight failed; nothing was stopped"

if (( DRY )); then
  echo
  echo "==> dry run: the passes that WOULD run"
  for d in ${DEPTHS//,/ }; do
    pass base f16   "$d" "${OUTDIR}/logits-f16-${d}.bin" "${OUTDIR}/base-f16-${d}.log"
    pass test q8_0  "$d" "${OUTDIR}/logits-f16-${d}.bin" "${OUTDIR}/test-q8_0-${d}.log"
  done
  echo
  echo "dry run only; qwen38-llama was not touched."
  exit 0
fi

echo
echo "==> stopping ${LLAMA_CT} (it holds the card; a ~20 min cold reload follows this run)"
docker stop "$LLAMA_CT" >/dev/null || die "could not stop ${LLAMA_CT}"

restore() {
  echo
  echo "==> restarting ${LLAMA_CT}"
  docker start "$LLAMA_CT" >/dev/null && echo "    started; the model is now reading off disk (~20 min)" \
    || echo "    FAILED to start ${LLAMA_CT} — start it by hand with ./scripts/up.sh"
}
trap restore EXIT INT TERM

FAILED=0
for d in ${DEPTHS//,/ }; do
  LOG_BASE="${OUTDIR}/logits-f16-${d}.bin"
  pass base f16  "$d" "$LOG_BASE" "${OUTDIR}/base-f16-${d}.log"  || { FAILED=1; echo "    base arm at ${d} failed; skipping its test arm"; continue; }
  pass test q8_0 "$d" "$LOG_BASE" "${OUTDIR}/test-q8_0-${d}.log" || FAILED=1
  if (( ! KEEP_LOGITS )); then
    # Full-vocab logits are tens of GB per depth. They are reproducible from the
    # base arm; the numbers that matter are in the logs.
    docker run --rm -v "${CAPS}:/captures" alpine rm -f "$LOG_BASE" || true
    echo "    removed $LOG_BASE (pass --keep-logits to keep it)"
  fi
done

echo
echo
echo "==> tokenization, both counts"
echo "    llama /tokenize (specials parsed)   ${REF_TOKENS:-unmeasured}"
grep -hoE 'tokenizing the input[^\n]*|^main: [0-9]+ tokens|n_tokens = [0-9]+|[0-9]+ tokens in the file' "${LOCAL_LOGDIR}"/*.log 2>/dev/null | sort -u | sed 's/^/    perplexity: /'

echo "==> logs in ${LOCAL_LOGDIR}"
grep -hiE 'kl divergence|kl_div|top.?token|Mean KLD|Median KLD|Maximum KLD|q99|same token|PPL|ETA' "${LOCAL_LOGDIR}"/*.log 2>/dev/null | sed 's/^/  /' | tail -60

exit $FAILED
