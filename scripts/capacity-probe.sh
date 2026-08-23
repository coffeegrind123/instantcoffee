#!/usr/bin/env bash
#
# Answer "does it FIT, and what does it COST" for launch flags that spec-sweep.sh
# does not sweep — context window, ngram-simple's table size, reasoning effort.
#
#   ./scripts/capacity-probe.sh --config 'size-m-16|SPEC_NGRAM_SIZE_M=16' --bench repeat
#   ./scripts/capacity-probe.sh --config 'ctx-96k|CTX_SIZE=98304' --bench prefill
#   ./scripts/capacity-probe.sh --list                 # what has been probed
#   ./scripts/capacity-probe.sh --baseline             # measure .env as it stands
#
# WHY THIS IS NOT PART OF spec-sweep.sh
#
# spec-sweep.sh asks "which of these configs is fastest" and its answer is a
# decode rate. This asks "does the server come up at all, and what does it cost
# in VRAM" — a different question with a different failure mode. A config that
# OOMs is a RESULT here and a crash there. Keeping them apart also keeps a
# verified tool out of the path of an experiment.
#
# WHAT IT PROTECTS
#
# Every probe rewrites .env and recreates llama, so the same hazard applies as
# in spec-sweep.sh: a run that dies without restoring leaves .env holding an
# experimental value that the next `up.sh` would quietly adopt. Same defences,
# and one more that spec-sweep.sh cannot have — .env is COMMITTED, so the
# backup is verified against `git show HEAD:.env` before anything is written,
# and the restore is checked byte-for-byte afterwards.
#
# CTX_SIZE IS NOT ONE KNOB. --dry-penalty-last-n must track it: b10573 deleted
# the `-1 = context size` sentinel and rejects any negative, so a stale value is
# either a silent behaviour change (penalty window smaller than the context) or,
# if someone puts -1 back, an argument-parse failure that presents as a container
# restarting every few seconds WITH NO MODEL LOG AT ALL. Setting CTX_SIZE here
# sets DRY_PENALTY_LAST_N with it, and says so.
#
# READ THE VRAM NUMBER CORRECTLY, TWICE OVER.
#
# nvidia-smi reports the whole DEVICE, not this process, so anything else on the
# GPU is included. The stack-down floor is measured once and recorded next to
# every reading; the delta against it is the footprint, and the delta is what
# means something. (Measured 2026-08-22: floor 1881 MiB, loaded at 64K 22128, so
# llama's own footprint is 20247 — not the 22128 a careless read would quote.)
#
# AND IT HAS A RESOLUTION LIMIT. Three readings of the SAME config on the same
# box gave 22092 / 22128 / 22132 MiB — a spread of 40 MiB. So an effect smaller
# than roughly 50 MiB cannot be told apart from noise by this method, and should
# be reported as "below the resolution of this measurement" rather than as a
# number. Re-measure the baseline in the SAME run as the configs it is being
# compared with; a figure carried over from an earlier run is exactly the
# mixed-provenance trap that spec-sweep.sh grew a pin set to stop.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker jq

RESULTS_DIR="${RESULTS_DIR:-$REPO_ROOT/context/bench/capacity}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-3000}"
BENCH="none"
BENCH_ARGS=""
LIST_ONLY=0
BASELINE_ONLY=0
declare -a CONFIGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)       CONFIGS+=("$2"); shift 2 ;;
    --bench)        BENCH="$2"; shift 2 ;;
    # Passed through to the bench verbatim. Needed because bench.py defaults to
    # a 1024-token prompt and its --full sweep stops at 16384, so NEITHER
    # exercises a window bigger than that. Probing a 96K context without
    # --bench-args '--prompt-len 90000' measures that the server started, not
    # that the window works.
    --bench-args)   BENCH_ARGS="$2"; shift 2 ;;
    --list)         LIST_ONLY=1; shift ;;
    --baseline)     BASELINE_ONLY=1; shift ;;
    --results-dir)  RESULTS_DIR="$2"; shift 2 ;;
    --wait-timeout) WAIT_TIMEOUT="$2"; shift 2 ;;
    -h|--help)      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' \
                        "${BASH_SOURCE[0]}"; exit 0 ;;
    *)              die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$BENCH" in
  none|repeat|prefill|quality) ;;
  *) die "--bench must be none, repeat, prefill or quality; got '$BENCH'" ;;
esac

mkdir -p "$RESULTS_DIR"

# --- .env protection ---------------------------------------------------------
ENV_BACKUP="$REPO_ROOT/.env.capacity-probe-backup"
ENV_RESTORED=0

check_stale_env_backup() {
  [[ -s "$ENV_BACKUP" ]] || return 0
  warn "an .env backup from an earlier probe is still present:"
  warn "    $ENV_BACKUP"
  warn "That probe did not restore, so .env may still hold an experimental value."
  warn "    .env   : CTX_SIZE=$(env_get CTX_SIZE) SPEC_NGRAM_SIZE_M=$(env_get SPEC_NGRAM_SIZE_M) REASONING_EFFORT=$(env_get REASONING_EFFORT)"
  die  "compare against 'git show HEAD:.env', put the right one back, delete the backup, then re-run"
}

restore_env() {
  [[ "$ENV_RESTORED" == 1 ]] && return 0
  ENV_RESTORED=1
  if [[ -s "$ENV_BACKUP" ]]; then
    cp "$ENV_BACKUP" "$REPO_ROOT/.env"
    rm -f "$ENV_BACKUP"
    if cmp -s "$REPO_ROOT/.env" <(git -C "$REPO_ROOT" show HEAD:.env 2>/dev/null); then
      ok ".env restored and verified byte-identical to HEAD"
    else
      # Not necessarily wrong — .env may have had uncommitted edits before the
      # probe — but it is worth saying out loud rather than assuming.
      info ".env restored to its pre-probe state (which differed from HEAD)"
    fi
    return 0
  fi
  warn "##################################################################"
  warn "# .env WAS NOT RESTORED — the backup is missing or empty:"
  warn "#     $ENV_BACKUP"
  warn "# .env currently holds:"
  warn "#     CTX_SIZE=$(env_get CTX_SIZE)  DRY_PENALTY_LAST_N=$(env_get DRY_PENALTY_LAST_N)"
  warn "#     SPEC_NGRAM_SIZE_M=$(env_get SPEC_NGRAM_SIZE_M)"
  warn "#     REASONING_EFFORT=$(env_get REASONING_EFFORT)  REASONING_BUDGET=$(env_get REASONING_BUDGET)"
  warn "# .env is committed, so the fix is:  git -C $REPO_ROOT checkout -- .env"
  warn "##################################################################"
  return 1
}

# --- measurement -------------------------------------------------------------
# nvidia-smi is not in this container but IS in the llama image, so the reading
# is taken from inside the service. Returns "used total" in MiB, or nothing.
gpu_mem() {
  compose exec -T llama nvidia-smi --query-gpu=memory.used,memory.total \
      --format=csv,noheader,nounits 2>/dev/null | tr -d ' ' | tr ',' ' ' | head -1
}

# The same reading with llama STOPPED, so the per-config numbers have a floor to
# be measured against.
#
# It has to stop the service, and the first version of this did not — it read the
# device from a throwaway container while llama was still up and got 22132 MiB,
# four MiB from the loaded reading. That would have been recorded as an "idle
# floor", looked entirely plausible, and made every VRAM delta in this file
# meaningless. nvidia-smi reports the DEVICE; there is no way to ask it for a
# floor without taking the tenant off the card.
#
# The cost is nil in practice: every probe recreates llama anyway, so this just
# stops it a few seconds earlier than the first `--force-recreate` would.
gpu_mem_idle() {
  compose stop llama >/dev/null 2>&1 || true
  docker run --rm --gpus all --entrypoint nvidia-smi \
      "ghcr.io/ggml-org/llama.cpp:$(env_get LLAMA_TAG)" \
      --query-gpu=memory.used,memory.total --format=csv,noheader,nounits \
      2>/dev/null | tr -d ' ' | tr ',' ' ' | head -1
}

# What the SERVER says it is serving, which is the only claim worth recording:
# .env asking for a window is not the same as the engine granting one.
server_n_ctx() {
  compose exec -T llama sh -c \
    'curl -s --max-time 10 http://127.0.0.1:8080/props' 2>/dev/null \
    | jq -r '.default_generation_settings.n_ctx // .n_ctx // empty' 2>/dev/null
}

apply_setting() {
  local kv="$1" key="${1%%=*}" val="${1#*=}"
  env_set "$key" "$val"
  # CTX_SIZE is not one knob; see the header.
  if [[ "$key" == "CTX_SIZE" ]]; then
    env_set DRY_PENALTY_LAST_N "$val"
    dim "    DRY_PENALTY_LAST_N set to $val with it (b10573 rejects the old -1 sentinel)"
  fi
}

probe() {
  local spec="$1"
  local label="${spec%%|*}"
  local settings="${spec#*|}"
  local js="$RESULTS_DIR/$label.json"
  local raw="$RESULTS_DIR/$label.log"

  info "$label — $settings"

  local applied=() kv
  IFS=',' read -ra applied <<< "$settings"
  for kv in "${applied[@]}"; do
    [[ -z "$kv" ]] && continue
    [[ "$kv" == *=* ]] || die "setting '$kv' is not KEY=VALUE"
    apply_setting "$kv"
  done

  local ok_load=1 n_ctx="" used="" total="" err=""
  info "  recreating llama (cold load is ~15 min on this box) ..."
  if compose up -d --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" llama \
       >"$raw" 2>&1; then
    ok "  llama healthy"
    read -r used total <<< "$(gpu_mem)"
    n_ctx="$(server_n_ctx)"
    # Capture the startup log on SUCCESS too, not only on failure. The first
    # version saved it only when llama refused to come up, which meant the one
    # run that raised a real question — why 96K->128K cost 245 MiB when the KV
    # arithmetic says 1152 — had no engine-side accounting to check, and the
    # container had already been recreated by the time anyone looked. The
    # engine's own numbers are the control for a VRAM figure sampled from
    # nvidia-smi; keep them next to the sample.
    {
      printf '\n===== llama startup log (%s) =====\n' "$label"
      compose logs --no-color llama 2>&1 | tail -400
    } >>"$raw" || true
  else
    ok_load=0
    err="$(compose logs --tail 60 llama 2>&1 | tail -30)"
    warn "  $label — llama did NOT come up. That is a result, not a crash."
    printf '%s\n' "$err" | tail -12 >&2
    compose logs --tail 200 llama >>"$raw" 2>&1 || true
  fi

  local bench_json="null"
  if (( ok_load )) && [[ "$BENCH" != "none" ]]; then
    local bench_cmd=() extra=()
    # Unquoted on purpose: BENCH_ARGS is an argument LIST from the operator.
    [[ -n "$BENCH_ARGS" ]] && read -ra extra <<< "$BENCH_ARGS"
    case "$BENCH" in
      repeat)  bench_cmd=(--profile tools run --rm --build
                          --entrypoint python bench /work/scripts/bench_repeat.py
                          --repeat 3 "${extra[@]}") ;;
      quality) # Executes model-written code, so it runs in the throwaway bench
               # container and nowhere else — see bench_quality.py's header.
               bench_cmd=(--profile tools run --rm --build
                          --entrypoint python bench /work/scripts/bench_quality.py
                          "${extra[@]}") ;;
      *)       bench_cmd=(--profile tools run --rm --build bench
                          --repeat 3 "${extra[@]}") ;;
    esac
    info "  benching [$BENCH] ..."
    if compose "${bench_cmd[@]}" >>"$raw" 2>&1; then
      bench_json="$(awk 'f{print; next} /^\{$/{f=1; print}' "$raw" | jq -c '.' 2>/dev/null || echo null)"
    else
      warn "  bench failed; see $raw"
    fi
  fi

  # $lbl, NOT $label. `label` is a jq keyword (`label $out | ... break $out`),
  # so jq rejects a VARIABLE of that name outright — quoting the object key does
  # not help, because the error is on the `--arg` binding. Verified both ways:
  #   jq -n --arg lbl   t '{"label":$lbl}'    -> works
  #   jq -n --arg label t '{"label":$label}'  -> syntax error
  #
  # This cost a 15-minute cold load and a bench run to find, because the
  # measurement helpers were probed against the live stack but the line that
  # RECORDS the measurement was not. Test the write path, not just the reads.
  jq -n \
    --arg lbl "$label" --arg settings "$settings" \
    --argjson loaded "$ok_load" \
    --arg n_ctx "$n_ctx" --arg used "$used" --arg total "$total" \
    --arg idle "${IDLE_USED:-}" \
    --arg when "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg bench "$BENCH" \
    --argjson result "$bench_json" \
    '{"label":$lbl, "settings":$settings, "loaded":($loaded == 1),
      "server_n_ctx":$n_ctx,
      "vram_used_mib":$used, "vram_total_mib":$total, "vram_idle_mib":$idle,
      "bench":$bench, "measured_utc":$when, "result":$result}' >"$js"

  if (( ok_load )); then
    ok "  $label — n_ctx=$n_ctx  VRAM ${used}/${total} MiB (idle floor ${IDLE_USED:-?})"
  fi
  return 0
}

report() {
  local files=("$RESULTS_DIR"/*.json)
  [[ -e "${files[0]}" ]] || { warn "no probes in $RESULTS_DIR yet"; return 1; }
  printf '\n%s capacity probes\n' "==>"
  printf '%-16s %-34s %6s %8s %9s %9s %9s\n' \
    LABEL SETTINGS LOADED N_CTX VRAM-MiB FREE-MiB DECODE
  printf '%.0s-' {1..100}; printf '\n'
  jq -r -s '
    sort_by(.measured_utc) | .[]
    | ([ (.result.rows // [])[] | select(.error == null and .cached != true) | .predicted_tps ]) as $tg
    | [ .label, .settings,
        (if .loaded then "yes" else "NO" end),
        (.server_n_ctx // "-"),
        (.vram_used_mib // "-"),
        (if (.vram_used_mib // "") != "" and (.vram_total_mib // "") != ""
         then ((.vram_total_mib|tonumber) - (.vram_used_mib|tonumber) | tostring) else "-" end),
        (if ($tg|length) > 0 then (($tg|add)/($tg|length) * 10 | round / 10 | tostring) else "-" end)
      ] | @tsv' "${files[@]}" \
  | while IFS=$'\t' read -r l s ld n v f d; do
      printf '%-16s %-34s %6s %8s %9s %9s %9s\n' "$l" "$s" "$ld" "$n" "$v" "$f" "$d"
    done
  printf '\nLOADED=NO is a result: the config does not fit. VRAM is whole-device,\n'
  printf 'so read it against the idle floor recorded in each JSON, not as zero.\n'
  printf 'DECODE is the mean of the bench runs, and only comparable within one\n'
  printf 'workload — see --bench in the header.\n'
}

main() {
  if (( LIST_ONLY )); then report; return $?; fi

  [[ -f "$REPO_ROOT/.env" ]] || die ".env not found — run ./scripts/setup.sh first"
  check_stale_env_backup
  cp "$REPO_ROOT/.env" "$ENV_BACKUP"
  trap 'restore_env || true' EXIT INT TERM

  info "measuring the idle GPU floor — this STOPS llama, which every probe would anyway"
  IDLE_USED=""
  local idle_total=""
  read -r IDLE_USED idle_total <<< "$(gpu_mem_idle || true)"
  [[ -n "$IDLE_USED" ]] && dim "  idle floor: ${IDLE_USED}/${idle_total} MiB" \
                        || warn "  could not read an idle floor; VRAM deltas will be absolute only"
  export IDLE_USED

  if (( BASELINE_ONLY )); then
    CONFIGS=("baseline|CTX_SIZE=$(env_get CTX_SIZE)")
  fi
  [[ ${#CONFIGS[@]} -gt 0 ]] || die "nothing to probe — pass --config 'label|KEY=VAL' or --baseline"

  local c
  for c in "${CONFIGS[@]}"; do probe "$c"; done

  restore_env || true
  trap - EXIT INT TERM

  info "restoring the pre-probe server so the stack is left as it was found"
  compose up -d --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" llama >/dev/null 2>&1 \
    || warn "could not bring llama back on the original config — run ./scripts/up.sh"

  report || true
  ok "probe complete"
}

main "$@"
