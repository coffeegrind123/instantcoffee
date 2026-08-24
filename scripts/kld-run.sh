#!/usr/bin/env bash
#
# The q8_0-vs-f16 KV-cache fidelity run.
#
#   ./scripts/kld-run.sh --corpus /captures/corpus/deep.txt [--depths 8192,65536]
#   ./scripts/kld-run.sh --corpus ... --null-control   f16 vs f16: RUN THIS FIRST
#   ./scripts/kld-run.sh --corpus ... --dry-run        print the commands, run nothing
#
# RUN THE NULL CONTROL BEFORE QUOTING ANY NUMBER. `--null-control` points the
# test arm at the base arm's own KV type, so the run compares f16 against f16
# across two processes. It must return KLD ~ 0 and same-top-1 ~ 100%; whatever
# it does return is this instrument's FLOOR, and a q8_0 result is only worth the
# distance between it and that floor. `--base-kv` / `--test-kv` set the two arms
# independently if you want some other pair.
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
BASE_KV="f16"
TEST_KV="q8_0"
NULL_CONTROL=0
ALLOW_SWAP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus) CORPUS="${2:-}"; shift 2 || die "--corpus needs a value" ;;
    --corpus=*) CORPUS="${1#*=}"; shift ;;
    --depths) DEPTHS="${2:-}"; shift 2 || die "--depths needs a value" ;;
    --depths=*) DEPTHS="${1#*=}"; shift ;;
    --out-subdir) OUT_SUBDIR="${2:-}"; shift 2 || die "--out-subdir needs a value" ;;
    --keep-logits) KEEP_LOGITS=1; shift ;;
    --base-kv) BASE_KV="${2:-}"; shift 2 || die "--base-kv needs a value" ;;
    --base-kv=*) BASE_KV="${1#*=}"; shift ;;
    --test-kv) TEST_KV="${2:-}"; shift 2 || die "--test-kv needs a value" ;;
    --test-kv=*) TEST_KV="${1#*=}"; shift ;;
    --null-control) NULL_CONTROL=1; shift ;;
    --allow-swap) ALLOW_SWAP=1; shift ;;
    --unpinned) UNPINNED=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,42p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
done

# THE NULL CONTROL IS A FIRST-CLASS ARM, NOT A THING TO REMEMBER.
#
# `--null-control` PREPENDS the base arm's own KV type to the list of test arms,
# so the run compares f16 against f16 before it compares anything else: two
# independent processes, the same weights, the same corpus, the same flags,
# reading the SAME logits file. It must come back at KLD ~ 0 and same-top-1
# ~ 100%. Whatever it actually returns is this instrument's FLOOR, and every
# q8_0 number is worth only the distance between it and that floor.
#
# It prepends rather than replaces because the control and the measurement then
# share one base pass and one base file, which is both cheaper (the base arm is
# the expensive half) and a stricter comparison than two runs a day apart.
#
# It exists as a flag because the first run of this script had no control at
# all, and a 4.7% top-1 flip rate with no floor under it is equally consistent
# with a broken comparison. A control you have to remember to run is a control
# that does not get run.
TEST_KVS="$TEST_KV"
if (( NULL_CONTROL )); then TEST_KVS="${BASE_KV},${TEST_KV}"; fi
for kv in "$BASE_KV" ${TEST_KVS//,/ }; do
  case "$kv" in
    f32|f16|bf16|q8_0|q5_0|q5_1|q4_0|q4_1|iq4_nl) ;;
    *) die "unknown KV cache type '$kv' (f32 f16 bf16 q8_0 q5_0 q5_1 q4_0 q4_1 iq4_nl)" ;;
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

# Both arms are in the filenames so a null control and a q8_0 run can share a
# directory without one silently overwriting the other's evidence.
logits_path() { echo "${OUTDIR}/logits-${BASE_KV}-$1.bin"; }
base_log()    { echo "${OUTDIR}/base-${BASE_KV}-$1.log"; }
test_log()    { echo "${OUTDIR}/test-$2-vs-${BASE_KV}-$1.log"; }

# n_vocab comes from the GGUF's own metadata — gguf_n_vocab() in lib.sh, shared
# with ppl-stride-run.sh, which bounds its host memory on the same product.

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
  # (2) HOST RAM, NOT VRAM, IS THE CEILING — AND IT IS SIZED ON n_vocab.
  #     The base arm holds two buffers sized on n_ctx * n_vocab:
  #         logits.reserve(size_t(n_ctx) * n_vocab)          4 B per entry
  #         log_probs.resize(size_t(n_ctx) * nv)             2 B per entry
  #     with nv = 2*((n_vocab+1)/2)+4. `reserve` commits address space but only
  #     the rows actually inserted are touched, and only positions >= n_ctx/2
  #     produce output — so the RESIDENT cost is (n_ctx/2)*n_vocab*4 for the
  #     logits plus the whole n_ctx*nv*2 for log_probs, which resize() zeroes
  #     and therefore faults in completely.
  #
  #     n_vocab IS READ OUT OF THE GGUF, NOT ASSUMED. This block used to
  #     hardcode 151,936 (Qwen3-8B's). The model actually pinned here has
  #     248,320, so every verdict it printed was 63% under — it called n_ctx
  #     16384 "ok: ~14244 MiB" for a pass that in fact wanted ~22.7 GiB on a
  #     22 GiB box. A wrong constant in a guard is worse than no guard: it
  #     answers confidently.
  local nvocab
  nvocab="$(gguf_n_vocab "$MODELS" "$GGUF" "$SIDECAR_IMAGE")"
  if [[ "$nvocab" =~ ^[0-9]+$ ]]; then
    echo "    n_vocab       ${nvocab} (tokenizer.ggml.tokens, read from the GGUF)"
  else
    echo "    n_vocab       COULD NOT BE READ from /models/${GGUF}: ${nvocab}"
    echo "                  the host-memory verdicts below cannot be computed, so they"
    echo "                  are not printed. Nothing is guarding the depth you picked."
    nvocab=""
  fi
  local nv=$(( nvocab ? 2 * ((nvocab + 1) / 2) + 4 : 0 ))
  local avail_mb; avail_mb="$(docker run --rm alpine free -m | awk '/^Mem:/{print $7}')"
  local swap_mb;  swap_mb="$(docker run --rm alpine free -m | awk '/^Swap:/{print $4}')"
  echo "    host memory   ${avail_mb} MiB available, ${swap_mb} MiB free swap"
  local blocked=0
  for d in ${DEPTHS//,/ }; do
    local need_mb=0
    (( nvocab )) && need_mb=$(( ( (d / 2) * nvocab * 4 + d * nv * 2 ) / 1048576 ))
    local need_tok=$(( 2 * d ))
    local verdict="ok"
    if [[ -n "$REF_TOKENS" ]] && (( REF_TOKENS < need_tok )); then
      verdict="REFUSED: needs ${need_tok} tokens, the corpus has ${REF_TOKENS}"
      blocked=1
    elif (( ! nvocab )); then
      verdict="unchecked: n_vocab unknown, so host memory was not verified"
    elif (( need_mb > avail_mb + swap_mb )); then
      verdict="REFUSED: needs ~${need_mb} MiB host RAM, only $(( avail_mb + swap_mb )) MiB incl. swap"
      blocked=1
    elif (( need_mb > avail_mb )); then
      # THIS WAS A WARNING UNTIL 2026-08-24 AND IS NOW A REFUSAL. Two separate
      # failures, both from a pass that fit only into swap:
      #
      #   1. OBSERVED TWICE at n_ctx 16384 on this box: the base arm swaps, one
      #      of its ~3.8 GiB log-prob writes comes up short, the ofstream
      #      latches badbit, EVERY LATER WRITE IS SILENTLY DISCARDED, and
      #      perplexity exits 0 with a file holding 0.6 GB of an expected 15.2.
      #      The identical write to the identical directory completes when the
      #      box has headroom, so it is memory pressure and not the path.
      #   2. A sibling script (ppl-stride-run.sh) printed the SAME "tight, it
      #      will swap" warning, proceeded, and DEADLOCKED THE WINDOWS HOST —
      #      twice. Recovering it needed an operator at the keyboard.
      #
      # There is no outcome on this side of the line worth having. A pass that
      # only fits in swap produces a corrupt logits file at best and takes the
      # machine out at worst, so "free+swap covers it" is not a reason to run.
      # --allow-swap exists because a future box may have real swap on real
      # NVMe and a smaller model; it is not a flag to reach for here.
      if (( ALLOW_SWAP )); then
        verdict="TIGHT (--allow-swap): ~${need_mb} MiB wanted against ${avail_mb} MiB
                  free. It WILL swap. A swapping base arm has been observed
                  writing a SHORT logits file and still exiting 0, and a
                  sibling script in the same state took the host down"
      else
        verdict="REFUSED: ~${need_mb} MiB wanted against ${avail_mb} MiB free — it
                  would swap. Free real memory or drop this depth. A swapping
                  base arm has written a SHORT logits file and exited 0 (twice),
                  and a sibling script in the same state DEADLOCKED THE HOST
                  (twice). Pass --allow-swap only if you have read both."
        blocked=1
      fi
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

# ---------------------------------------------------------------------------
# Size the logits file the base arm just wrote against what it MUST be.
#
# WHY THIS EXISTS. perplexity.cpp never checks the ofstream after a write:
#     logits_stream.write("_logits_", 8);
#     logits_stream.write((const char *)&n_vocab, sizeof(n_vocab));
#     logits_stream.write((const char *)tokens.data(), n_chunk*n_ctx*sizeof(tokens[0]));
#     out.write((const char *)log_probs.data(), size_t(n_token)*nv*sizeof(uint16_t));
# — four writes, no `if (!logits_stream)` anywhere, and the base arm exits 0
# either way. A short write is therefore SILENT at the producing end and
# surfaces one process later as
#     kl_divergence: failed reading log-probs for chunk 0
# which reads like a corrupt file of unknown provenance. It happened at
# n_ctx=16384 on the first run of this script and cost a whole depth.
#
# The expected size is not guessed: the writer's own header states n_ctx,
# n_vocab and n_chunk, so this reads those three ints back out of the file and
# derives the rest from the same expressions the writer used.
#
#     8                                  "_logits_"
#     4                                  n_ctx      (int32, written by perplexity())
#     4                                  n_vocab    (int32)
#     4                                  n_chunk    (int32)
#     n_chunk * n_ctx * 4                the evaluation tokens (llama_token)
#     n_chunk * (n_ctx - 1 - n_ctx/2)
#             * nv * 2                   the log-probs, nv = 2*((n_vocab+1)/2)+4
#
# The reader consumes exactly this and in exactly this order, so a mismatch of
# any size means the test arm is going to fail or, worse, read the wrong bytes.
verify_logits() {
  local logits="$1"
  local report rc=0
  report="$(docker run --rm -v "${CAPS}:/captures" --entrypoint python "$SIDECAR_IMAGE" -c "
import os, struct, sys
path = '$logits'
try:
    size = os.stat(path).st_size
except OSError as e:
    print('MISSING  ' + str(e)); sys.exit(1)
with open(path, 'rb') as f:
    head = f.read(20)
if len(head) < 20 or head[:8] != b'_logits_':
    print('BAD HEADER  first 20 bytes: ' + head[:20].hex()); sys.exit(1)
n_ctx, n_vocab, n_chunk = struct.unpack('<iii', head[8:20])
nv = 2 * ((n_vocab + 1) // 2) + 4
first = n_ctx // 2
per_chunk = (n_ctx - 1 - first) * nv * 2
want = 20 + n_chunk * n_ctx * 4 + n_chunk * per_chunk
print(f'header    n_ctx={n_ctx} n_vocab={n_vocab} n_chunk={n_chunk} nv={nv}')
print(f'per chunk {per_chunk:,} bytes of log-probs')
print(f'expected  {want:,}')
print(f'actual    {size:,}')
if size == want:
    print('verdict   COMPLETE')
    sys.exit(0)
if size > want:
    print(f'verdict   LONGER than the header describes, by {size - want:,} bytes —')
    print('          this is not a short write. Stale file, or a different corpus.')
    sys.exit(1)
short = want - size
# The reader consumes the header and the token block, then one per_chunk block
# per chunk in order, so the first read that runs out is the first chunk beyond
# what the file actually holds.
avail = max(0, size - (20 + n_chunk * n_ctx * 4))
readable = avail // per_chunk
print(f'verdict   TRUNCATED, short by {short:,} bytes ({short / per_chunk:.3f} chunks)')
print(f'          {readable} of {n_chunk} chunks are complete; the test arm will')
print(f'          fail reading log-probs for chunk {readable}')
sys.exit(1)
" 2>&1)" || rc=1
  echo "    logits file"
  echo "${report}" | sed 's/^/                  /'
  return $rc
}

LOCAL_LOGDIR="${REPO_ROOT}/.kld-logs/${STAMP}"
# Not on a dry run — it writes nothing, and an empty stamped directory per
# --dry-run is litter that looks like a run that produced no output.
(( DRY )) || mkdir -p "$LOCAL_LOGDIR"

echo "KV-cache fidelity run   ${STAMP}"
echo "  image     ${IMAGE}"
echo "  model     /models/${GGUF}"
echo "  corpus    ${CORPUS}"
echo "  depths    ${DEPTHS}"
echo "  base arm  -ctk ${BASE_KV} -ctv ${BASE_KV}   (writes the logits)"
for kv in ${TEST_KVS//,/ }; do
  if [[ "$kv" == "$BASE_KV" ]]; then
    echo "  test arm  -ctk ${kv} -ctv ${kv}   NULL CONTROL — measures the instrument, not the KV type"
  else
    echo "  test arm  -ctk ${kv} -ctv ${kv}   (reads the logits, reports KLD)"
  fi
done
if (( ! NULL_CONTROL )) && [[ ",${TEST_KVS}," != *",${BASE_KV},"* ]]; then
  echo
  echo "  NOTE: no null control in this run. Nothing establishes the floor these"
  echo "        numbers sit above. Add --null-control unless one has already been"
  echo "        run against this corpus, this model and these depths."
fi
echo "  logs      ${LOCAL_LOGDIR}"
echo

preflight || die "preflight failed; nothing was stopped"

if (( DRY )); then
  echo
  echo "==> dry run: the passes that WOULD run"
  for d in ${DEPTHS//,/ }; do
    pass base "$BASE_KV" "$d" "$(logits_path "$d")" "$(base_log "$d")"
    for kv in ${TEST_KVS//,/ }; do
      pass test "$kv" "$d" "$(logits_path "$d")" "$(test_log "$d" "$kv")"
    done
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
  LOG_BASE="$(logits_path "$d")"
  pass base "$BASE_KV" "$d" "$LOG_BASE" "$(base_log "$d")" \
    || { FAILED=1; echo "    base arm at ${d} failed; skipping its test arm"; continue; }

  # Between the arms, because a truncated file is the base arm's failure and
  # naming it here is the difference between "perplexity wrote a short file" and
  # "the test arm cannot read chunk 0".
  if ! verify_logits "$LOG_BASE"; then
    FAILED=1
    echo "    the base arm at ${d} did not write a complete logits file; skipping its"
    echo "    test arm. Its own exit code was 0 — perplexity.cpp never checks the"
    echo "    ofstream. Keep the file (--keep-logits) and look at it before re-running."
    continue
  fi

  for kv in ${TEST_KVS//,/ }; do
    pass test "$kv" "$d" "$LOG_BASE" "$(test_log "$d" "$kv")" || FAILED=1
  done
  if (( ! KEEP_LOGITS )); then
    # Full-vocab logits are ~10 GB per depth. They are reproducible from the
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
