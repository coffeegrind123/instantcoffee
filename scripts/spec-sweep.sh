#!/usr/bin/env bash
#
# Sweep the speculative-decoding knobs and report decode rate, draft acceptance
# and — the number this script exists for — average draft length per cycle.
#
#   ./scripts/spec-sweep.sh                     # the whole 12-config grid
#   ./scripts/spec-sweep.sh --only baseline,pmin-040
#   ./scripts/spec-sweep.sh --resume            # skip configs already measured
#                                               #   ON THIS EXACT STACK
#   ./scripts/spec-sweep.sh --dry-run           # print the plan and the cost
#   ./scripts/spec-sweep.sh --repeat 3 --prompt-len 2048
#   ./scripts/spec-sweep.sh --workload repeat   # the repetition workload (see below)
#   ./scripts/spec-sweep.sh --report            # re-print the table, run nothing
#   ./scripts/spec-sweep.sh --pins              # what would be stamped right now
#
# Every result records the PIN SET that produced it — llama.cpp image and
# digest, context size, KV cache types, and the weights by size and mtime.
# --resume re-runs anything measured on a different one instead of skipping it,
# and --report refuses to let a mixed table pass as a comparison. See the pin
# set comment further down for what went wrong before that existed.
#
# --workload picks what is being measured, and the two are not interchangeable:
#
#   synthetic (default, bench.py)   nonce-randomised keyword soup. Measures raw
#                                   prefill and decode. The nonce defeats the
#                                   prompt CACHE but not ngram-simple — see the
#                                   caveat below, which was wrong until
#                                   2026-08-22 and is now measured.
#   repeat (bench_repeat.py)        a file-rewrite task, the shape pi actually
#                                   produces. Reports ECHO so a flat result can
#                                   be told apart from a workload that failed to
#                                   repeat. This is the one that can show
#                                   ngram-simple's upside.
#
# Results are namespaced per workload, so --resume never confuses the two.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS, AND WHY IT SWEEPS p-min BEFORE n-max
#
# bench.py's closing advice is to sweep SPEC_DRAFT_N_MAX. Read against the
# engine that advice is incomplete, and following it first is what makes a
# sweep come back flat.
#
# In llama.cpp b10200 (commit 5f55650a7, 2026-07-30) the MTP draft loop is
# common/speculative.cpp:1520-1670, and per draft step it does:
#
#     llama_decode(ctx_dft, batch);                    // a full MTP forward
#     common_sampler_sample(...); cur_p = candidates;
#     if (cur_p->data[0].p < params.p_min) { stop; }    // <-- p-min gate
#     result.push_back(id);
#     if (params.n_max <= result.size()) { stop; }      // <-- n-max gate
#
# The p-min gate is tested BEFORE the n-max gate. With SPEC_DRAFT_P_MIN=0.75
# the second token survives only when the MTP head's top-1 probability clears
# 0.75, so the draft is frequently cut at length 1 and n-max is never reached.
# Sweeping n-max under a tight p-min therefore measures nothing: the knob being
# raised is not the knob that is binding. High acceptance with a low decode
# rate is the signature of exactly that state — acceptance is bought by
# refusing to draft, not earned by drafting well.
#
# So the grid below moves p-min first at fixed n-max, then opens n-max once
# p-min is loose enough for it to matter.
#
# The derived metric that settles it is `draft/cycle` in the report:
#
#     draft_per_cycle = draft_n / (predicted_n - draft_accepted)
#
# One verify cycle emits one target-sampled token plus its accepted drafts, so
# (predicted_n - draft_accepted) is the cycle count. If draft/cycle sits near
# 1.0 while n-max is 2, the drafts are being truncated by p-min and no amount
# of n-max will help. If it sits near n-max, n-max is the binding constraint
# and raising it is the right move.
#
# ---------------------------------------------------------------------------
# WHY EVERY CONFIG COSTS A FULL RESTART
#
# llama-server does have per-request speculative fields — speculative.n_max,
# speculative.p_min, speculative.type — but in b10200 the entire block is
# compiled out. tools/server/server-schema.cpp:196:
#
#     // TODO: to keep things simple, we disable speculative parameter
#     // adjustments for now
#     #if 0
#         add((new field_num("speculative.n_max", ...
#     #endif
#
# They are launch flags only, so each config is a container recreate. On this
# box that is the ~27 min cold load recorded in versions.lock (mmap off,
# MODELS_DIR on a 9p bind mount), and the default grid is therefore a ~3 hour
# job. It is resumable on purpose: --resume skips any config whose result file
# already exists, so an interrupted sweep costs one reload, not six.
#
# ---------------------------------------------------------------------------
# DRAFTER PRIORITY IS FIXED IN THE ENGINE, NOT BY THE ORDER YOU TYPE
#
# --spec-type takes a comma-separated list (common/arg.cpp:4048) but the
# priority is hard-coded in common_speculative_init (common/speculative.cpp
# :2404-2437), under the comment "this list here defines the priority of the
# speculators / the one with highest priority are listed first". Every n-gram
# implementation is pushed before every draft-model one, ngram-simple first of
# all. Arbitration is a first-non-empty cascade: common_speculative_draft()
# clears dp.drafting as soon as an impl returns tokens, so later impls are
# skipped for that sequence.
#
# That is why `ngram-simple,draft-mtp` is worth measuring. ngram-simple runs no
# llama_decode at all — it is a lookup over an n-gram table built from the live
# context — so when it hits, the MTP forward pass is skipped entirely.
#
# CAVEAT, AND IT IS A REAL ONE — BUT NOT THE ONE THIS COMMENT USED TO CLAIM:
# bench.py gives every prompt a unique nonce specifically to defeat the prompt
# cache. It was stated here, and believed for five days, that this also defeats
# ngram-simple, so the synthetic ngram rows "measure overhead only".
#
# That is false, and the script's own numbers say so. The nonce randomises the
# salt and the ordering, but the keyword soup is drawn from a SMALL FIXED
# vocabulary, so short spans recur inside a single prompt and the table
# ngram-simple builds from the live context still hits. Measured 2026-08-22 on
# --workload synthetic: ngram-n4 drafts 4.10 tokens per cycle where the matching
# draft-mtp-only n4 drafts 3.42. ngram-simple is drafting there.
#
# The consequence for reading a synthetic table: an ngram row's margin over its
# draft-mtp twin is PARTLY REAL DRAFTING, not pure overhead, so it cannot be
# quoted as "ngram costs nothing". It also still understates the upside by a
# long way — on --workload repeat the same pair is 182.5 against 120.2 tok/s.
#
# Its upside is measured by --workload repeat, which runs the file-rewrite task
# in bench_repeat.py and reports ECHO so that "the drafter did nothing" can be
# told apart from "the model did not repeat anything". Run both: synthetic
# decides p-min and n-max, repeat decides whether ngram-simple earns its place.
# ---------------------------------------------------------------------------

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker

RESULTS_DIR="${RESULTS_DIR:-$REPO_ROOT/context/bench/spec-sweep}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-3000}"
PROMPT_LEN=""
REPEAT="3"
WORKLOAD="synthetic"
FUNCS=""
RESUME=0
DRY_RUN=0
REPORT_ONLY=0
PINS_ONLY=0
ONLY=""

# ---------------------------------------------------------------------------
# THE n-max ROWS ADDED 2026-08-22, AND WHY THE ANSWER IS NOT OBVIOUS
#
# The 2026-08-17 sweep settled on n-max 4 / p-min 0.40 and closed with: draft
# per cycle still pins against the ceiling at n-max 4 (3.79 of 4), so n-max 6/8
# is untested and may pay further. Two things since then make that worth
# finishing, and they point in OPPOSITE directions.
#
# For raising n-max — llama.cpp 2b562109 (#26079, 2026-08-20), now pinned via
# LLAMA_TAG=server-cuda-b10573. Before it, ggml_cuda_should_use_mmvq() had no
# Ada Lovelace entry, so a 4090 used the MMVQ (GEMV) kernel for every verify
# batch up to MMVQ_MAX_BATCH_SIZE=8. The verify batch is 1+n_max, so on b10200
# every row of the old sweep ran on GEMV and n-max 6/8 would have been measured
# in the worst part of that curve. b10573 crosses Q4_K/Q5_K to MMQ above ne11 7
# — i.e. exactly at the batch that n-max 7+ produces. A public RTX 4090
# draft-mtp config circulating with 44-134 tok/s runs n-max 6 at p-min 0.82,
# which is why that specific pair gets its own row rather than being
# interpolated.
#
# Against raising n-max — the most careful public measurement of this model,
# posted to llama.cpp#27342 from an H200, sweeps MTP n-max on Qwen3.8-27B and
# finds the quantized case inverts against the BF16 case:
#
#     Qwen3.8-27B BF16     n-max 2/3/4/7 -> 1.48x / 1.56x / 1.58x / 1.48x
#     Qwen3.8-27B Q4_K_M   n-max 2/3/4/7 -> 1.30x / 1.24x / 1.17x / 0.91x
#
# On a 4-bit quant MTP got monotonically WORSE with depth, and at n-max 7 it
# was slower than no speculation at all. The stated cause is that the marginal
# cost of one more verified token is 6.7% at BF16 but 23.4% at Q4_K_M, so
# drafting deeper stops paying much sooner. This stack runs a 4-bit quant.
#
# Hence n3 as well as n6/n8: if that H200 curve holds here, the optimum is
# BELOW the current 4, not above it, and the 2026-08-17 result would be an
# artefact of having moved p-min and n-max in the same step. Either way this
# grid brackets it. Run it on a quiet box — see spec_variance_note in
# versions.lock.
#
# name | SPEC_TYPE | SPEC_DRAFT_N_MAX | SPEC_DRAFT_P_MIN
CONFIGS=(
  "baseline|draft-mtp|2|0.75"
  "pmin-050|draft-mtp|2|0.50"
  "pmin-040|draft-mtp|2|0.40"
  "pmin-040-n3|draft-mtp|3|0.40"
  "pmin-040-n4|draft-mtp|4|0.40"
  "pmin-040-n6|draft-mtp|6|0.40"
  "pmin-040-n8|draft-mtp|8|0.40"
  "pmin-082-n6|draft-mtp|6|0.82"
  "ngram-pmin-040-n3|ngram-simple,draft-mtp|3|0.40"
  "ngram-pmin-040-n4|ngram-simple,draft-mtp|4|0.40"
  "ngram-pmin-040-n6|ngram-simple,draft-mtp|6|0.40"
  "ngram-baseline|ngram-simple,draft-mtp|2|0.75"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)         ONLY="$2"; shift 2 ;;
    --resume)       RESUME=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --report)       REPORT_ONLY=1; shift ;;
    # Print the pin set this box would stamp on a result right now, and exit.
    # Useful on its own ("what am I actually running?") and it is how a pin
    # mismatch reported by --report gets diagnosed without reading JSON.
    --pins)         PINS_ONLY=1; shift ;;
    --repeat)       REPEAT="$2"; shift 2 ;;
    --prompt-len)   PROMPT_LEN="$2"; shift 2 ;;
    --workload)     WORKLOAD="$2"; shift 2 ;;
    --funcs)        FUNCS="$2"; shift 2 ;;
    --results-dir)  RESULTS_DIR="$2"; shift 2 ;;
    --wait-timeout) WAIT_TIMEOUT="$2"; shift 2 ;;
    # Print the whole leading comment block, however long it grows — a fixed
    # line range silently truncates --help the next time the header is edited.
    -h|--help)      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' \
                        "${BASH_SOURCE[0]}"; exit 0 ;;
    *)              die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$WORKLOAD" in
  synthetic|repeat) ;;
  *) die "--workload must be 'synthetic' (bench.py) or 'repeat' (bench_repeat.py), got '$WORKLOAD'" ;;
esac

# Results are namespaced by workload. The two measure different things and a
# shared directory would let --resume skip a config that was only ever run
# under the other one.
RESULTS_DIR="$RESULTS_DIR/$WORKLOAD"
mkdir -p "$RESULTS_DIR"

# --- .env protection ---------------------------------------------------------
# The sweep rewrites three keys in .env. A whole-file backup is restored on any
# exit path, including Ctrl-C and a failed reload, because leaving .env holding
# a sweep value would silently change what the next `up.sh` starts.
#
# THE BACKUP LIVES IN THE REPO, NOT IN TMPDIR, AND THAT IS THE POINT.
# It used to be `mktemp "${TMPDIR:-/tmp}/spec-sweep-env.XXXXXX"`. On 2026-08-22
# another process in this container deleted /tmp wholesale (~5,430 entries)
# while a sweep was mid-flight. The RESULTS survived, because they are written
# under context/bench/ — but the .env backup would not have, and restore_env
# only acted `if [[ -s "$ENV_BACKUP" ]]`. A vanished backup therefore made the
# restore a SILENT NO-OP, leaving .env holding whichever config the sweep was
# on: an n-max 6 or 8 value quietly becoming production, printing nothing. It
# missed us by luck, and the failure would have shown up days later as "the
# stack got slower" with no trace of why.
#
# Two changes, both aimed at that:
#   1. fixed path next to .env, so nothing outside the repo can remove it;
#   2. a missing backup is LOUD and says what to check.
ENV_BACKUP="$REPO_ROOT/.env.spec-sweep-backup"
ENV_RESTORED=0

# env_get() reads .env (and .env.local, and the process environment). The backup
# needs the same lookup against a different file; keeping it a one-liner beside
# env_get is how the two stay comparable.
env_backup_get() {
  local line; line="$(grep -E "^[[:space:]]*${1}=" "$ENV_BACKUP" | tail -n1 || true)"
  printf '%s' "${line#*=}"
}

# A leftover backup means an earlier sweep died before restoring, so .env is
# very likely still holding THAT sweep's config. Starting a new sweep would
# overwrite the backup with those sweep values and destroy the only surviving
# copy of the real ones, so refuse and make the operator look.
check_stale_env_backup() {
  [[ -s "$ENV_BACKUP" ]] || return 0
  warn "an .env backup from an earlier sweep is still present:"
  warn "    $ENV_BACKUP"
  warn "That sweep did not restore, so .env may still hold its config."
  warn "    .env   : SPEC_TYPE=$(env_get SPEC_TYPE) n-max=$(env_get SPEC_DRAFT_N_MAX) p-min=$(env_get SPEC_DRAFT_P_MIN)"
  warn "    backup : SPEC_TYPE=$(env_backup_get SPEC_TYPE) n-max=$(env_backup_get SPEC_DRAFT_N_MAX) p-min=$(env_backup_get SPEC_DRAFT_P_MIN)"
  die  "compare them, put the right one back (cp '$ENV_BACKUP' .env), delete the backup, then re-run"
}

restore_env() {
  [[ "$ENV_RESTORED" == 1 ]] && return 0
  ENV_RESTORED=1
  if [[ -s "$ENV_BACKUP" ]]; then
    cp "$ENV_BACKUP" "$REPO_ROOT/.env"
    rm -f "$ENV_BACKUP"
    info ".env restored to its pre-sweep state"
    return 0
  fi
  # The branch that used to be silent. If it fires, .env is holding a sweep
  # value RIGHT NOW and the only copy of the original is gone.
  warn "##################################################################"
  warn "# .env WAS NOT RESTORED — the backup is missing or empty:"
  warn "#     $ENV_BACKUP"
  warn "# .env currently holds:"
  warn "#     SPEC_TYPE=$(env_get SPEC_TYPE)"
  warn "#     SPEC_DRAFT_N_MAX=$(env_get SPEC_DRAFT_N_MAX)"
  warn "#     SPEC_DRAFT_P_MIN=$(env_get SPEC_DRAFT_P_MIN)"
  warn "# If those are a sweep config rather than yours, fix them BEFORE the"
  warn "# next ./scripts/up.sh. spec_config in versions.lock records the"
  warn "# values this repo considers production."
  warn "##################################################################"
  return 1
}

# --- the pin set that produced a result --------------------------------------
# A result file used to record its spec config and nothing else, so --resume
# would skip a config that had in fact been measured on a different llama.cpp
# build, a different KV type, a different context window or different WEIGHTS,
# and --report would print those rows in one table with today's as though they
# were comparable.
#
# That is not hypothetical. Two 2026-08-16 files (b10200 / f16-f16 / 32K /
# pre-Dynamic-V3) sat in the repeat/ directory until they had to be quarantined
# BY HAND into repeat/stale-2026-08-16/, and the only thing that caught them was
# someone noticing the mtime. A six-day-old number in a fresh-looking table is
# the most expensive kind of wrong, because it reads as a measurement.
#
# So every result now carries the pins. --resume compares them and re-runs on a
# mismatch; --report says so when the table is mixed.
#
# THE WEIGHTS ARE PINNED BY SIZE AND MTIME, NOT BY SHA256, and that is a
# deliberate trade. unsloth replaces UD-* files IN PLACE — they did exactly that
# on 2026-08-19 for Dynamic V3 — so the filename proves nothing and something
# about the bytes has to be recorded. But hashing 17.5 GB across a 9p bind mount
# costs more than the entire bench does. Size and mtime already separate every
# generation of this file present on disk (17559178144 for V3 against
# 17923394624 for the .superseded predecessor), which is all this needs to do.
PINS_JSON=""

capture_pins() {
  if [[ -n "$PINS_JSON" ]]; then printf '%s' "$PINS_JSON"; return 0; fi

  local tag models gguf image digest st size mtime
  tag="$(env_get LLAMA_TAG)"
  models="$(env_get MODELS_DIR)"
  gguf="$(env_get GGUF_FILE)"
  image="ghcr.io/ggml-org/llama.cpp:$tag"

  # The digest of the image ON THIS BOX, not the one versions.lock remembers.
  # A re-pulled tag is precisely the drift this exists to catch, and the lock
  # file is written by hand.
  digest="$(docker image inspect "$image" \
              --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' \
              2>/dev/null || true)"
  digest="${digest##*@}"

  # MODELS_DIR is a Docker-Desktop host path (`//d/...`); it is not readable
  # from this container, so the stat runs inside a throwaway container against
  # the same mount the llama service uses. The llama image is used rather than
  # a small one because it is already local — pulling alpine here would make a
  # pin capture depend on the network. ~1.1 s, once per invocation.
  st="$(docker run --rm --entrypoint sh -v "$models:/models:ro" "$image" \
          -c "stat -c '%s %Y' '/models/$gguf'" 2>/dev/null || true)"
  size="${st%% *}"; mtime="${st##* }"
  [[ "$size" == "$st" ]] && { size=""; mtime=""; }

  # SPEC_NGRAM_* are launch flags this script does NOT sweep — they come from
  # .env and stay fixed for a whole run — so they belong with the stack rather
  # than with the swept config. They matter here: `size_m` sets
  # n_outputs_per_seq (1 + common_speculative_n_max()), which is ~529 MiB of
  # output buffer at its default of 48, and changing it changes both VRAM and
  # what ngram-simple can draft. Without them in the pin set, a size_m
  # experiment produces result files indistinguishable from the baseline.
  # Empty means "flag not passed", i.e. the engine default.
  PINS_JSON="$(jq -nc \
    --arg tag "$tag" --arg digest "$digest" \
    --arg ctx "$(env_get CTX_SIZE)" \
    --arg k "$(env_get CACHE_TYPE_K)" --arg v "$(env_get CACHE_TYPE_V)" \
    --arg repo "$(env_get MODEL_REPO)" --arg gguf "$gguf" \
    --arg size "$size" --arg mtime "$mtime" \
    --arg nmh "$(env_get SPEC_NGRAM_MIN_HITS)" \
    --arg nsn "$(env_get SPEC_NGRAM_SIZE_N)" \
    --arg nsm "$(env_get SPEC_NGRAM_SIZE_M)" \
    '{llama_tag:$tag, llama_digest:$digest, ctx_size:$ctx,
      cache_type_k:$k, cache_type_v:$v,
      model_repo:$repo, gguf_file:$gguf,
      gguf_size:$size, gguf_mtime:$mtime,
      ngram_min_hits:$nmh, ngram_size_n:$nsn, ngram_size_m:$nsm}')"
  printf '%s' "$PINS_JSON"
}

# Print only the keys that differ, so a mismatch names the cause instead of
# dumping two JSON blobs and leaving the reader to spot the one changed field.
pin_diff() {
  jq -rn --argjson a "$1" --argjson b "$2" '
    ($a + $b | keys_unsorted[]) as $k
    | select(($a[$k] // "") != ($b[$k] // ""))
    | "      \($k): \($a[$k] // "-")  ->  \($b[$k] // "-")"' | sort -u
}

select_configs() {
  local out=() c name
  for c in "${CONFIGS[@]}"; do
    name="${c%%|*}"
    if [[ -n "$ONLY" ]] && [[ ",$ONLY," != *",$name,"* ]]; then
      continue
    fi
    out+=("$c")
  done
  # No die() here: this runs inside a process substitution, so exit would only
  # kill the subshell and the caller would sail on with an empty list. The
  # caller checks the array length instead.
  [[ ${#out[@]} -gt 0 ]] && printf '%s\n' "${out[@]}"
}

# Does the llama container that is ALREADY running serve this exact config?
#
# Worth the effort because a recreate costs ~27 min here, and the first config
# in a sweep is usually the one the stack is already on. The comparison reads
# the live container's own argv rather than .env: .env is what the next start
# would use, not necessarily what this process was started with, and trusting it
# would silently bench the wrong server — the one failure mode of this whole
# script that produces plausible numbers instead of an error.
live_matches() {
  local want_type="$1" want_nmax="$2" want_pmin="$3"
  local cid argv health

  cid="$(compose ps -q llama 2>/dev/null | head -n1)" || return 1
  [[ -n "$cid" ]] || return 1

  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)" || return 1
  [[ "$health" == "healthy" ]] || return 1

  argv="$(docker inspect --format '{{range .Config.Cmd}}{{.}} {{end}}' "$cid" 2>/dev/null)" || return 1
  [[ -n "$argv" ]] || return 1

  local got_type got_nmax got_pmin
  got_type="$(sed -nE 's/.*--spec-type[[:space:]]+([^[:space:]]+).*/\1/p' <<<"$argv")"
  got_nmax="$(sed -nE 's/.*--spec-draft-n-max[[:space:]]+([^[:space:]]+).*/\1/p' <<<"$argv")"
  got_pmin="$(sed -nE 's/.*--spec-draft-p-min[[:space:]]+([^[:space:]]+).*/\1/p' <<<"$argv")"

  # A missing field means the running server predates these flags, or the argv
  # could not be read. Either way: do not guess, just recreate.
  [[ -n "$got_type" && -n "$got_nmax" && -n "$got_pmin" ]] || return 1

  # Numeric compare so 0.75 and .75 and 0.750 do not read as three configs.
  awk -v a="$got_nmax" -v b="$want_nmax" 'BEGIN{exit !(a+0==b+0)}' || return 1
  awk -v a="$got_pmin" -v b="$want_pmin" 'BEGIN{exit !(a+0==b+0)}' || return 1
  [[ "$got_type" == "$want_type" ]] || return 1

  return 0
}

# Extract the JSON document bench.py prints after its human-readable summary.
# It starts at the first line that is exactly "{" and runs to EOF.
extract_json() {
  awk 'f{print; next} /^\{$/{f=1; print}' "$1"
}

run_config() {
  local spec="$1"
  local name="${spec%%|*}"; local rest="${spec#*|}"
  local stype="${rest%%|*}";  rest="${rest#*|}"
  local nmax="${rest%%|*}"
  local pmin="${rest##*|}"

  local raw="$RESULTS_DIR/$name.log"
  local js="$RESULTS_DIR/$name.json"

  if [[ "$RESUME" == 1 && -s "$js" ]]; then
    # --resume used to skip on the mere existence of a result file. It now has
    # to be a result from THIS stack; see the pin-set comment above.
    local stored current
    stored="$(jq -cS '.pins // empty' "$js" 2>/dev/null || true)"
    current="$(capture_pins | jq -cS '.')"
    if [[ -n "$stored" && "$stored" == "$current" ]]; then
      ok "$name — already measured on this exact stack, skipping (--resume)"
      return 0
    fi
    if [[ -z "$stored" ]]; then
      warn "$name — existing result carries no pin set (it predates pin stamping)."
      warn "  It cannot be shown to match this build/weights/KV, so it is being re-run."
    else
      warn "$name — existing result was measured on a DIFFERENT stack; re-running:"
      pin_diff "$stored" "$current" >&2
    fi
  fi

  info "$name — SPEC_TYPE=$stype n-max=$nmax p-min=$pmin"

  if live_matches "$stype" "$nmax" "$pmin"; then
    ok "  the running llama already serves this config — benching it as-is (saved a ~27 min reload)"
    # .env is still aligned to it for the same reason, so nothing to write.
  else
    env_set SPEC_TYPE          "$stype"
    env_set SPEC_DRAFT_N_MAX   "$nmax"
    env_set SPEC_DRAFT_P_MIN   "$pmin"

    info "  recreating llama (cold load is ~27 min on this box) ..."
    if ! compose up -d --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" llama; then
      warn "$name — llama did not become healthy within ${WAIT_TIMEOUT}s; skipping"
      compose logs --tail 40 llama || true
      return 1
    fi
    ok "  llama healthy"
  fi

  local bench_args=(--repeat "$REPEAT")
  local -a bench_cmd
  if [[ "$WORKLOAD" == "repeat" ]]; then
    [[ -n "$FUNCS" ]] && bench_args+=(--funcs "$FUNCS")
    # bench_repeat.py is baked into the image alongside bench.py
    # (Dockerfile.forge), so it is reached by overriding the entrypoint rather
    # than by adding a near-duplicate compose service.
    bench_cmd=(--profile tools run --rm --build
               --entrypoint python bench /work/scripts/bench_repeat.py)
  else
    [[ -n "$PROMPT_LEN" ]] && bench_args+=(--prompt-len "$PROMPT_LEN")
    bench_cmd=(--profile tools run --rm --build bench)
  fi

  info "  benching [$WORKLOAD] (${bench_args[*]}) ..."
  if ! compose "${bench_cmd[@]}" "${bench_args[@]}" >"$raw" 2>&1; then
    warn "$name — bench failed; see $raw"
    tail -20 "$raw" >&2 || true
    return 1
  fi

  extract_json "$raw" >"$js"
  if [[ ! -s "$js" ]]; then
    warn "$name — no JSON block in bench output; see $raw"
    rm -f "$js"
    return 1
  fi

  # Stamp the config AND the pin set onto the result, so the report is
  # self-describing and --resume can tell "already measured" from "measured on
  # something else". measured_utc is stamped too: it is the field that would
  # have made the Aug-16 quarantine a one-line check instead of an mtime hunt.
  local tmp; tmp="$(mktemp)"
  jq --arg n "$name" --arg t "$stype" --arg x "$nmax" --arg p "$pmin" --arg w "$WORKLOAD" \
     --arg rep "$REPEAT" --arg plen "$PROMPT_LEN" \
     --arg when "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     --argjson pins "$(capture_pins)" \
     '. + {config: {name: $n, spec_type: $t, n_max: ($x|tonumber), p_min: ($p|tonumber),
                    workload: $w, repeat: ($rep|tonumber),
                    prompt_len: (if $plen == "" then null else ($plen|tonumber) end)},
           pins: $pins,
           measured_utc: $when}' \
     "$js" >"$tmp" && mv "$tmp" "$js"

  ok "  $name recorded"
  return 0
}

report() {
  local files=("$RESULTS_DIR"/*.json)
  # Prime the cache in THIS shell. capture_pins memoises into PINS_JSON, but
  # every other caller invokes it inside $( ), where the assignment dies with
  # the subshell — so without this line the docker probe runs once per call.
  PINS_JSON="${PINS_JSON:-$(capture_pins)}"
  [[ -e "${files[0]}" ]] || { warn "no results in $RESULTS_DIR yet"; return 1; }

  printf '\n%s workload: %s\n' "==>" "$WORKLOAD"
  printf '%-20s %-22s %5s %6s %8s %8s %8s %7s %7s %11s %6s\n' \
    CONFIG SPEC-TYPE N-MAX P-MIN PREFILL DEC-MEAN DEC-MAX SPREAD ACCEPT DRAFT/CYCLE ECHO
  printf '%.0s-' {1..128}; printf '\n'

  # DEC-MEAN, DEC-MAX and SPREAD all come out of the same --repeat runs, and
  # printing all three is the fix for a trap this script laid on 2026-08-22.
  # It used to print `max` alone, unlabelled. Ranking the same twelve configs by
  # mean and by max disagreed on which of n3 and n4 won, and the disagreement
  # was invisible because the column said only "DECODE" — a number was quoted in
  # a handoff without anyone knowing which statistic it was. Neither is wrong;
  # quoting one without saying which is.
  #
  # SPREAD (max - min within one config) is the column that decides whether any
  # of this is a result at all. On the synthetic workload it reached 17.3 tok/s,
  # which is wider than the gaps between the top four configs — i.e. the ranking
  # was noise, and was reported as an inverted-U before that was noticed.
  jq -r -s '
    def num(x): if (x|type) == "number" then x else 0 end;
    # Fixed decimal places, trailing zeros KEPT. tostring in jq drops them, so a
    # column ends up holding "191", "191.0" and "4.1" beside "23.54" and reads
    # as three different precisions when it is one. Built from the rounded
    # integer rather than from float formatting, which is why it is this long.
    def dec($n): (. * pow(10; $n) | round | tostring) as $i
      | (if ($i | startswith("-")) then "-" else "" end) as $sg
      | ($i | ltrimstr("-")) as $d
      | (if (($d | length) < ($n + 1)) then (("0" * ($n + 1 - ($d | length))) + $d) else $d end) as $d
      | $sg + ($d[0:(($d | length) - $n)]) + "." + ($d[-$n:]);
    def r1: dec(1);
    def r2: dec(2);
    .[]
    | . as $doc
    | ([ $doc.rows[]
         | select(.error == null and .cached != true and .unrepeated != true) ]) as $u
    | ([ $u[] | select(.draft_n != null) ]) as $d
    | ([ $u[].predicted_tps | num(.) ]) as $tgs
    | ( [ $u[].prompt_tps    | num(.) ] | max ) as $pp
    | ( if ($tgs|length) > 0 then (($tgs|add) / ($tgs|length)) else 0 end ) as $tgmean
    | ( $tgs | max ) as $tgmax
    | ( $tgs | min ) as $tgmin
    | ( [ $d[].draft_n         | num(.) ] | add // 0 ) as $dn
    | ( [ $d[].draft_accepted  | num(.) ] | add // 0 ) as $da
    | ( [ $d[].predicted_n     | num(.) ] | add // 0 ) as $pn
    | ( if $dn > 0 then ($da / $dn) else 0 end ) as $acc
    | ( ($pn - $da) ) as $cycles
    | ( if $cycles > 0 then ($dn / $cycles) else 0 end ) as $dpc
    | ([ $u[] | select(.echo != null) | .echo ]) as $ec
    | [ $tgmean,
        ($doc.config.name // "?"),
        ($doc.config.spec_type // "?"),
        ($doc.config.n_max | tostring),
        ($doc.config.p_min | tostring),
        ($pp | r1),
        ($tgmean | r1),
        ($tgmax | r1),
        (if ($tgs|length) > 1 then (($tgmax - $tgmin) | r1) else "-" end),
        (if $dn > 0 then ((($acc * 100) | r1) + "%") else "-" end),
        (if $cycles > 0 then ($dpc | r2) else "-" end),
        (if ($ec | length) > 0
         then ((((($ec | add) / ($ec | length)) * 100) | r1) + "%")
         else "-" end)
      ] | @tsv
  ' "${files[@]}" \
  | sort -t"$(printf '\t')" -k1,1gr \
  | cut -f2- \
  | while IFS=$'\t' read -r n t x p pp mean mx sp ac dpc ec; do
      printf '%-20s %-22s %5s %6s %8s %8s %8s %7s %7s %11s %6s\n' \
        "$n" "$t" "$x" "$p" "$pp" "$mean" "$mx" "$sp" "$ac" "$dpc" "$ec"
    done

  report_pins "${files[@]}"

  cat <<'EOF'

Rows are sorted by DEC-MEAN, best first.

READ SPREAD BEFORE READING THE RANKING. It is max-min across this config's own
--repeat runs. If SPREAD is wider than the gap between two rows, those two rows
are not distinguishable and ranking them is false precision. Earlier handoffs
quote DEC-MAX, which is what this table printed, unlabelled, before the
2026-08-22 provenance pass.

How to read DRAFT/CYCLE (the column this sweep was built for):
  ~1.0 with n-max 2  -> p-min is truncating the draft. Lower SPEC_DRAFT_P_MIN.
  ~n-max             -> n-max is binding. Raise SPEC_DRAFT_N_MAX.
  Between            -> both bite; take the row with the best DECODE and stop.
It is a property of the drafting rather than of the clock, so it is the most
contention-resistant number here and the one to prefer when decode is close.

ACCEPT is a rate, not a goal. It is expected to fall as p-min drops; that is
the trade being bought. DECODE is the number that decides.

ECHO (--workload repeat only) is the share of generated 12-token windows that
also occur in the prompt — the ceiling on what ngram-simple could ever draft.
It is a property of the workload, not of the config, so it should be roughly
constant down the column. If it is not, the runs are not comparable. A high
ECHO next to a DRAFT/CYCLE pinned at n-max is repetition the engine is paying
full price for; that is the case ngram-simple exists to fix. ECHO reads "-" on
the synthetic workload, whose repetition is incidental rather than measured.
EOF
}

# The provenance block under the table. A sweep table is only a table if every
# row came off the same stack, and nothing here checked that until 2026-08-22 —
# two six-day-old files from a different build, KV type and context size sat in
# repeat/ printing as though they were current.
report_pins() {
  local files=("$@") cur rows n_groups n_unstamped
  cur="$(capture_pins | jq -cS '.')"

  rows="$(jq -s -r --argjson cur "$cur" '
    # Key order is not meaning: a stamp written by jq -nc and one written by a
    # backfill script differ only in the order their keys came out. Normalise
    # both sides before comparing, or every result reads as a different stack.
    def norm: if . == null then null else (to_entries | sort_by(.key) | from_entries) end;
    group_by(.pins | norm | tojson)
    | map({ pins: .[0].pins,
            n: length,
            src: ([ .[].pins_source // empty ] | unique | join(", ")),
            names: ([ .[].config.name // "?" ] | sort | join(", ")) })
    | .[]
    | [ (if .pins == null then "UNSTAMPED"
         elif (.pins | norm | tojson) == ($cur | norm | tojson) then "CURRENT"
         else "OTHER" end),
        (if .pins == null then "-"
         else ([ "llama=" + (.pins.llama_tag // "?"),
                 "digest=" + ((.pins.llama_digest // "?") | sub("^sha256:"; "") | .[0:12]),
                 "ctx=" + (.pins.ctx_size // "?"),
                 "kv=" + (.pins.cache_type_k // "?") + "/" + (.pins.cache_type_v // "?"),
                 "gguf=" + (.pins.gguf_file // "?") + " " + (.pins.gguf_size // "?") + "b"
                     + " mtime " + (.pins.gguf_mtime // "?"),
                 "ngram(min_hits/n/m)=" + ((.pins.ngram_min_hits // "") | if . == "" then "def" else . end)
                     + "/" + ((.pins.ngram_size_n // "") | if . == "" then "def" else . end)
                     + "/" + ((.pins.ngram_size_m // "") | if . == "" then "def" else . end)
               ] | join("  ")) end),
        (.n | tostring),
        .names,
        (.src // "") ] | @tsv
  ' "${files[@]}")"

  n_groups="$(printf '%s\n' "$rows" | grep -c . || true)"
  n_unstamped="$(printf '%s\n' "$rows" | grep -c '^UNSTAMPED' || true)"

  printf '\n%s provenance\n' "==>"
  if [[ "$n_groups" -gt 1 ]]; then
    warn "THIS TABLE MIXES $n_groups DIFFERENT STACKS. The rows above are NOT comparable."
    warn "Re-run the odd ones out, or move them aside — see stale-2026-08-16/ for the pattern."
  fi
  local kind pins n names src n_current=0
  while IFS=$'\t' read -r kind pins n names src; do
    [[ -n "$kind" ]] || continue
    case "$kind" in
      CURRENT)   n_current=$((n_current + 1))
                 printf '  [current stack] %s result(s)\n    %s\n' "$n" "$pins" ;;
      OTHER)     warn "  [DIFFERENT STACK] $n result(s): $names"
                 warn "    $pins" ;;
      UNSTAMPED) warn "  [NO PIN SET] $n result(s) predating pin stamping: $names"
                 warn "    Nothing records which build, KV type, context size or weights"
                 warn "    produced these. Re-run them, or do not quote them." ;;
    esac
    # A backfilled stamp is a reconstruction, however well evidenced. Say so
    # every time rather than letting it pass as something the sweep recorded.
    [[ -n "$src" ]] && dim "    pins_source: $src (reconstructed, not stamped at run time)"
  done <<< "$rows"
  if [[ "$n_groups" == 1 && "$n_unstamped" == 0 && "$n_current" == 1 ]]; then
    ok "  all results came off the stack this box is configured for"
  fi
  return 0
}

main() {
  if [[ "$PINS_ONLY" == 1 ]]; then
    capture_pins | jq -S '.'
    return 0
  fi

  if [[ "$REPORT_ONLY" == 1 ]]; then
    report
    return $?
  fi

  local selected; mapfile -t selected < <(select_configs)
  [[ ${#selected[@]} -gt 0 ]] || die "no configs selected (--only '$ONLY' matched nothing)"

  if [[ "$DRY_RUN" == 1 ]]; then
    info "plan — ${#selected[@]} config(s), workload '$WORKLOAD', each a full llama recreate"
    local c
    for c in "${selected[@]}"; do
      printf '  %-20s SPEC_TYPE=%-22s n-max=%s p-min=%s\n' \
        "${c%%|*}" "$(cut -d'|' -f2 <<<"$c")" "$(cut -d'|' -f3 <<<"$c")" "$(cut -d'|' -f4 <<<"$c")"
    done
    dim "cold load is ~27 min per config on this box (versions.lock), so this"
    dim "is roughly $(( ${#selected[@]} * 30 )) minutes plus bench time. --resume makes it restartable."
    return 0
  fi

  [[ -f "$REPO_ROOT/.env" ]] || die ".env not found — run ./scripts/setup.sh first"
  check_stale_env_backup
  # Captured ONCE, before the first recreate, and reused for every result in
  # this run. Capturing per config would let a mid-sweep weight change stamp
  # different pins on rows of the same table — the exact confusion pins exist
  # to prevent. If something does change under a running sweep, the next sweep
  # will disagree with these files and --report will say so.
  PINS_JSON="$(capture_pins)"
  dim "pins: $(printf '%s' "$PINS_JSON" | jq -r '"\(.llama_tag)  ctx=\(.ctx_size)  kv=\(.cache_type_k)/\(.cache_type_v)  gguf=\(.gguf_file) \(.gguf_size)b"')"
  cp "$REPO_ROOT/.env" "$ENV_BACKUP"
  # `|| true` because restore_env now RETURNS 1 when the backup has vanished,
  # and this script runs under `set -e`. Without it a missing backup would abort
  # the run at the restore step — skipping the server restore and the report,
  # i.e. turning a warning into a second failure. The warning is the product
  # here; the non-zero is for callers who want to test the branch.
  trap 'restore_env || true' EXIT INT TERM

  info "sweeping ${#selected[@]} config(s) into $RESULTS_DIR"
  dim "current: SPEC_TYPE=$(env_get SPEC_TYPE) n-max=$(env_get SPEC_DRAFT_N_MAX) p-min=$(env_get SPEC_DRAFT_P_MIN)"

  local failed=0 c
  for c in "${selected[@]}"; do
    run_config "$c" || failed=$((failed + 1))
  done

  restore_env || true
  trap - EXIT INT TERM

  # .env is back to its pre-sweep values by now, so these are the originals.
  if live_matches "$(env_get SPEC_TYPE)" "$(env_get SPEC_DRAFT_N_MAX)" "$(env_get SPEC_DRAFT_P_MIN)"; then
    ok "llama is already serving the pre-sweep config — no reload needed"
  else
    info "restoring the pre-sweep server so the stack is left as it was found"
    compose up -d --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" llama >/dev/null 2>&1 \
      || warn "could not bring llama back up on the original config — run ./scripts/up.sh"
  fi

  report || true

  if [[ "$failed" -gt 0 ]]; then
    warn "$failed config(s) failed — see the .log files in $RESULTS_DIR"
    return 1
  fi
  ok "sweep complete"
}

main "$@"
