#!/usr/bin/env bash
#
# Sweep the speculative-decoding knobs and report decode rate, draft acceptance
# and — the number this script exists for — average draft length per cycle.
#
#   ./scripts/spec-sweep.sh                     # the default 6-config grid
#   ./scripts/spec-sweep.sh --only baseline,pmin-040
#   ./scripts/spec-sweep.sh --resume            # skip configs already measured
#   ./scripts/spec-sweep.sh --dry-run           # print the plan and the cost
#   ./scripts/spec-sweep.sh --repeat 3 --prompt-len 2048
#   ./scripts/spec-sweep.sh --workload repeat   # the repetition workload (see below)
#   ./scripts/spec-sweep.sh --report            # re-print the table, run nothing
#
# --workload picks what is being measured, and the two are not interchangeable:
#
#   synthetic (default, bench.py)   nonce-randomised keyword soup. Measures raw
#                                   prefill and decode. Has no repetition by
#                                   construction, so ngram-simple cannot fire
#                                   and its rows measure overhead only.
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
# CAVEAT, AND IT IS A REAL ONE: bench.py gives every prompt a unique nonce
# specifically to defeat the prompt cache. That also defeats ngram-simple,
# whose whole value is repeated spans. Under the default --workload synthetic
# the ngram rows therefore measure its OVERHEAD (should be ~nil) and confirm it
# does not regress MTP — they do NOT measure its upside, and a flat ngram row
# there is not evidence against it.
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
ONLY=""

# name | SPEC_TYPE | SPEC_DRAFT_N_MAX | SPEC_DRAFT_P_MIN
CONFIGS=(
  "baseline|draft-mtp|2|0.75"
  "pmin-050|draft-mtp|2|0.50"
  "pmin-040|draft-mtp|2|0.40"
  "pmin-040-n4|draft-mtp|4|0.40"
  "ngram-pmin-040-n4|ngram-simple,draft-mtp|4|0.40"
  "ngram-baseline|ngram-simple,draft-mtp|2|0.75"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)         ONLY="$2"; shift 2 ;;
    --resume)       RESUME=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --report)       REPORT_ONLY=1; shift ;;
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
ENV_BACKUP="$(mktemp "${TMPDIR:-/tmp}/spec-sweep-env.XXXXXX")"
ENV_RESTORED=0

restore_env() {
  [[ "$ENV_RESTORED" == 1 ]] && return 0
  ENV_RESTORED=1
  if [[ -s "$ENV_BACKUP" ]]; then
    cp "$ENV_BACKUP" "$REPO_ROOT/.env"
    info ".env restored to its pre-sweep state"
  fi
  rm -f "$ENV_BACKUP"
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
    ok "$name — already measured, skipping (--resume)"
    return 0
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

  # Stamp the config onto the result so the report is self-describing.
  local tmp; tmp="$(mktemp)"
  jq --arg n "$name" --arg t "$stype" --arg x "$nmax" --arg p "$pmin" --arg w "$WORKLOAD" \
     '. + {config: {name: $n, spec_type: $t, n_max: ($x|tonumber), p_min: ($p|tonumber), workload: $w}}' \
     "$js" >"$tmp" && mv "$tmp" "$js"

  ok "  $name recorded"
  return 0
}

report() {
  local files=("$RESULTS_DIR"/*.json)
  [[ -e "${files[0]}" ]] || { warn "no results in $RESULTS_DIR yet"; return 1; }

  printf '\n%s workload: %s\n' "==>" "$WORKLOAD"
  printf '%-20s %-22s %5s %6s %10s %10s %8s %11s %6s\n' \
    CONFIG SPEC-TYPE N-MAX P-MIN PREFILL DECODE ACCEPT DRAFT/CYCLE ECHO
  printf '%.0s-' {1..108}; printf '\n'

  jq -r -s '
    def num(x): if (x|type) == "number" then x else 0 end;
    sort_by(.config.name)
    | .[]
    | . as $doc
    | ([ $doc.rows[]
         | select(.error == null and .cached != true and .unrepeated != true) ]) as $u
    | ([ $u[] | select(.draft_n != null) ]) as $d
    | ( [ $u[].prompt_tps    | num(.) ] | max ) as $pp
    | ( [ $u[].predicted_tps | num(.) ] | max ) as $tg
    | ( [ $d[].draft_n         | num(.) ] | add // 0 ) as $dn
    | ( [ $d[].draft_accepted  | num(.) ] | add // 0 ) as $da
    | ( [ $d[].predicted_n     | num(.) ] | add // 0 ) as $pn
    | ( if $dn > 0 then ($da / $dn) else 0 end ) as $acc
    | ( ($pn - $da) ) as $cycles
    | ( if $cycles > 0 then ($dn / $cycles) else 0 end ) as $dpc
    | ([ $u[] | select(.echo != null) | .echo ]) as $ec
    | [ $doc.config.name,
        $doc.config.spec_type,
        ($doc.config.n_max | tostring),
        ($doc.config.p_min | tostring),
        ($pp  * 10 | round / 10 | tostring),
        ($tg  * 10 | round / 10 | tostring),
        (if $dn > 0 then (($acc * 1000 | round / 10 | tostring) + "%") else "-" end),
        (if $cycles > 0 then ($dpc * 100 | round / 100 | tostring) else "-" end),
        (if ($ec | length) > 0
         then ((($ec | add) / ($ec | length)) * 1000 | round / 10 | tostring) + "%"
         else "-" end)
      ] | @tsv
  ' "${files[@]}" | while IFS=$'\t' read -r n t x p pp tg ac dpc ec; do
    printf '%-20s %-22s %5s %6s %10s %10s %8s %11s %6s\n' \
      "$n" "$t" "$x" "$p" "$pp" "$tg" "$ac" "$dpc" "$ec"
  done

  cat <<'EOF'

How to read DRAFT/CYCLE (the column this sweep was built for):
  ~1.0 with n-max 2  -> p-min is truncating the draft. Lower SPEC_DRAFT_P_MIN.
  ~n-max             -> n-max is binding. Raise SPEC_DRAFT_N_MAX.
  Between            -> both bite; take the row with the best DECODE and stop.

ACCEPT is a rate, not a goal. It is expected to fall as p-min drops; that is
the trade being bought. DECODE is the number that decides.

ECHO (--workload repeat only) is the share of generated 12-token windows that
also occur in the prompt — the ceiling on what ngram-simple could ever draft.
It is a property of the workload, not of the config, so it should be roughly
constant down the column. If it is not, the runs are not comparable. A high
ECHO next to a DRAFT/CYCLE pinned at n-max is repetition the engine is paying
full price for; that is the case ngram-simple exists to fix. ECHO reads "-" on
the synthetic workload, which has no repetition by construction.
EOF
}

main() {
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
  cp "$REPO_ROOT/.env" "$ENV_BACKUP"
  trap restore_env EXIT INT TERM

  info "sweeping ${#selected[@]} config(s) into $RESULTS_DIR"
  dim "current: SPEC_TYPE=$(env_get SPEC_TYPE) n-max=$(env_get SPEC_DRAFT_N_MAX) p-min=$(env_get SPEC_DRAFT_P_MIN)"

  local failed=0 c
  for c in "${selected[@]}"; do
    run_config "$c" || failed=$((failed + 1))
  done

  restore_env
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
