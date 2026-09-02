#!/usr/bin/env bash
#
# Measure llama-server's HOST RAM over a period, without stopping llama.
#
#   ./scripts/host-ram-floor.sh                    # 60 samples, 15 s apart (15 min)
#   ./scripts/host-ram-floor.sh --samples 20 --interval 30
#   ./scripts/host-ram-floor.sh --label after-ckpt-4
#   ./scripts/host-ram-floor.sh --report
#   ./scripts/host-ram-floor.sh --budget           # no sampling: cost model only
#
# WHY THIS EXISTS
#
# vram-floor.sh answers "how much of the GPU is the desktop holding". Nothing
# answered the same question for host RAM, and on 2026-09-02 that gap cost the
# box: llama-server sat at RssAnon 7.58 GiB / VmHWM 11.2 GiB, the 22 GiB VM was
# down to 690 MiB free with 3.3 GiB in swap, and prompt processing had decayed
# from 1714 tok/s in the first minute after load to 32.2 tok/s seventeen hours
# later -- a 53x collapse, and the second time this stack has produced it.
#
# The first time (2026-08-13) it was CACHE_RAM=8192; see the note beside that
# key in .env. The second time it was CTX_CHECKPOINTS=16, whose comment in .env
# said the cost was VRAM. It is not. create_checkpoint() in the server calls
# llama_state_seq_get_data_ext() three times -- target KV, draft KV, and the
# speculative state (the ngram map) -- and all three land in host-side
# std::vectors. The setting was budgeted against the wrong resource and the
# only floor script watched the wrong device, so nothing measured it.
#
# WHAT IT READS, AND WHY THOSE FIELDS
#
#   gen tok/s llamacpp:predicted_tokens_seconds, a WINDOWED gauge -- it reads 0
#             on an idle interval, so idle samples are dropped rather than
#             averaged in. A capture taken at rest reports "idle", not "0.0".
#   RssAnon   the number that matters. Anonymous heap: prompt cache, context
#             checkpoints, ngram map. NOT the weights.
#   RssFile   the control. With -ngl 999 the GGUF is in VRAM and this is single
#             -digit MiB. If it is GiB-scale the model is NOT offloaded and
#             every other reading here means something different.
#   RssShmem  CUDA host-mapped/pinned pages (the /dev/zero mappings).
#   VmSwap    llama's own pages that have already been evicted. Non-zero here
#             is the mechanism of the collapse, not a side effect of it.
#   VmHWM     peak RSS. A plateau that retreats still took the box down at its
#             peak, so the ceiling is what a budget has to be set against.
#
# Host free/swap come from the VM's /proc/meminfo, and prompt throughput from
# llama's own /metrics, so a capture can show pressure and its consequence on
# one row. NO host bridge needed: this is all inside the VM.
#
# THE COST MODEL (--budget) is fitted from the server's own eviction log, which
# prints an exact size for every checkpoint it drops. See CTX_CHECKPOINTS in
# .env for the five points and the fit.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker awk

RESULTS_DIR="${RESULTS_DIR:-$REPO_ROOT/context/bench/capacity}"
CONTAINER="${LLAMA_CONTAINER:-instantcoffee-llama}"
LLAMA_PORT_EFF="$(env_get LLAMA_PORT)"
METRICS_URL="${METRICS_URL:-http://host.docker.internal:${LLAMA_PORT_EFF:-8080}/metrics}"

SAMPLES=60
INTERVAL=15
REPORT_ONLY=0
BUDGET_ONLY=0
LABEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --samples)  SAMPLES="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --label)    LABEL="$2"; shift 2 ;;
    --report)   REPORT_ONLY=1; shift ;;
    --budget)   BUDGET_ONLY=1; shift ;;
    -h|--help)  sed -n '2,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "unknown argument '$1'" ;;
  esac
done

[[ "$LABEL" =~ ^[a-z0-9-]*$ ]] || die "--label must be [a-z0-9-]; got '$LABEL'"
OUT_CSV="$RESULTS_DIR/host-ram${LABEL:+-$LABEL}.csv"

# The llama-server pid INSIDE the container. Not pid 1: init: true puts
# docker-init in front, and reading pid 1's status would measure the reaper.
llama_pid() {
  docker exec "$CONTAINER" sh -c 'pgrep -f "^/app/llama-server" | head -1' 2>/dev/null \
    | tr -d '\r' | grep -oE '^[0-9]+$' | head -1 || true
}

sample_once() {
  local pid="$1" st free swapused ptps
  st="$(docker exec "$CONTAINER" cat "/proc/$pid/status" 2>/dev/null || true)"
  [[ -n "$st" ]] || return 1
  free="$(awk '/^MemFree:/{print $2}' /proc/meminfo)"
  swapused="$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{print t-f}' /proc/meminfo)"
  # llamacpp:predicted_tokens_seconds is a WINDOWED gauge, not a counter: it
  # reads 0 whenever no generation happened in the interval. A failed scrape
  # must not read as 0 either. Both become "nan" so the report can drop them
  # rather than average an idle sample into a throughput figure.
  ptps="$(curl -s -m 5 "$METRICS_URL" 2>/dev/null \
            | awk '/^llamacpp:predicted_tokens_seconds /{print $2}' | head -1)"
  [[ -n "$ptps" && "$ptps" != "0" ]] || ptps="nan"
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$(date +%H:%M:%S)" \
    "$(awk '/^RssAnon:/{print $2}'  <<<"$st")" \
    "$(awk '/^RssFile:/{print $2}'  <<<"$st")" \
    "$(awk '/^RssShmem:/{print $2}' <<<"$st")" \
    "$(awk '/^VmSwap:/{print $2}'   <<<"$st")" \
    "$(awk '/^VmHWM:/{print $2}'    <<<"$st")" \
    "$free" "$swapused" "$ptps"
}

capture() {
  local pid
  pid="$(llama_pid)"
  [[ -n "$pid" ]] || die "no llama-server process in '$CONTAINER'.
       Is it up? \`docker ps --filter name=$CONTAINER\`"
  ok "llama-server pid $pid inside $CONTAINER"

  # Fail loudly on the one reading that invalidates every other one.
  local rssfile
  rssfile="$(docker exec "$CONTAINER" awk '/^RssFile:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)"
  if (( rssfile > 1048576 )); then
    warn "RssFile is $(( rssfile / 1024 )) MiB -- the weights are NOT all in VRAM."
    warn "Check -ngl. Every anon reading below is then a different quantity."
  fi

  local mins=$(( SAMPLES * INTERVAL / 60 ))
  info "sampling $SAMPLES times every ${INTERVAL}s (~${mins} min), llama untouched ..."
  mkdir -p "$RESULTS_DIR"
  : > "$OUT_CSV"
  local i n=0
  for (( i = 0; i < SAMPLES; i++ )); do
    if sample_once "$pid" >> "$OUT_CSV"; then
      n=$(( n + 1 ))
    else
      # A vanished pid is a restart, not a bad sample. Say which.
      [[ -n "$(llama_pid)" ]] || die "llama-server exited mid-capture ($n samples in)"
      warn "sample $i unreadable"
    fi
    printf '\r  %s/%s samples' "$n" "$SAMPLES" >&2
    (( i + 1 < SAMPLES )) && sleep "$INTERVAL"
  done
  printf '\n' >&2
  (( n > 0 )) || die "captured nothing"
  ok "  $n samples -> $OUT_CSV"
}

report() {
  local f="$OUT_CSV"
  [[ -s "$f" ]] || die "no capture at $f -- run without --report first"
  info "reading $f"
  awk -F, '
    function med(a, n,   i, j, x, s) {
      for (i=1;i<=n;i++) s[i]=a[i]
      for (i=2;i<=n;i++) { x=s[i]; j=i-1; while (j>0 && s[j]>x) { s[j+1]=s[j]; j-- } s[j+1]=x }
      return (n%2) ? s[(n+1)/2] : (s[n/2]+s[n/2+1])/2
    }
    { n++; anon[n]=$2/1024; shm[n]=$4/1024; swp[n]=$5/1024; hwm[n]=$6/1024
      free[n]=$7/1024; hswap[n]=$8/1024
      if ($9 != "nan" && $9+0 > 0) { tp[++nt]=$9 }
      if (n==1 || anon[n]<amin) amin=anon[n]; if (n==1 || anon[n]>amax) amax=anon[n]
      if (n==1 || free[n]<fmin) fmin=free[n]; if (n==1 || free[n]>fmax) fmax=free[n]
      if (n==1 || hwm[n]>hmax)  hmax=hwm[n] }
    END {
      if (n==0) { print "no samples"; exit 1 }
      printf "\n==> llama-server host RAM over %d samples (MiB)\n\n", n
      printf "  %-28s %10s %10s %10s\n", "", "min", "median", "max"
      printf "  %-28s %10.0f %10.0f %10.0f\n", "RssAnon (heap)",      amin, med(anon,n), amax
      printf "  %-28s %10s %10.0f %10s\n",     "RssShmem (cuda host)", "-", med(shm,n),  "-"
      printf "  %-28s %10s %10.0f %10s\n",     "VmSwap (llama evicted)", "-", med(swp,n), "-"
      printf "  %-28s %10s %10s %10.0f\n",     "VmHWM (peak RSS)",     "-",  "-", hmax
      printf "\n==> the VM around it (MiB)\n\n"
      printf "  %-28s %10.0f %10.0f %10.0f\n", "host MemFree",  fmin, med(free,n), fmax
      printf "  %-28s %10s %10.0f %10s\n",     "host swap used", "-", med(hswap,n), "-"
      if (nt > 0)
        printf "  %-28s %10s %10.1f %10s\n", "gen tok/s (busy samples)", "-", med(tp,nt), "-"
      else
        printf "  %-28s %10s %10s %10s\n", "gen tok/s", "-", "idle", "-"
      printf "\n"
      if (med(free,n) < 1024)
        printf "  WARN  median free is under 1 GiB. This is the pressure that took\n        prompt processing from 1714 tok/s to 32 tok/s on 2026-09-02.\n\n"
      if (med(swp,n) > 0)
        printf "  WARN  llama has %.0f MiB of its OWN pages in swap. Every touch of\n        those is a major fault on the decode path.\n\n", med(swp,n)
    }' "$f"
}

# What the current .env actually reserves, from the fitted cost model. Cheap,
# needs nothing running, and is the check to make BEFORE changing a window size.
budget() {
  local ckpt step cram ctx
  # env_get returns empty for a key .env does not carry; a blank would make awk
  # silently print a 0-checkpoint budget, which is the wrong kind of wrong here.
  ckpt="$(env_get CTX_CHECKPOINTS)";    [[ -n "$ckpt" ]] || die "CTX_CHECKPOINTS is not set in .env"
  step="$(env_get CHECKPOINT_MIN_STEP)"; step="${step:-0}"
  cram="$(env_get CACHE_RAM)";          [[ -n "$cram" ]] || die "CACHE_RAM is not set in .env"
  ctx="$(env_get CTX_SIZE)";            [[ -n "$ctx"  ]] || die "CTX_SIZE is not set in .env"
  info "host-RAM budget implied by .env"
  awk -v ckpt="$ckpt" -v cram="$cram" -v ctx="$ctx" -v step="$step" '
    BEGIN {
      base = 149.6          # MiB, context-independent: draft state + ngram map
      per  = 4.02 / 1024    # MiB per token of target KV
      each = base + per * ctx
      printf "\n  CTX_SIZE           = %d\n", ctx
      printf "  CTX_CHECKPOINTS    = %d  (min step %d)\n", ckpt, step
      printf "  CACHE_RAM          = %d MiB\n\n", cram
      printf "  checkpoint at full context = %.0f + %.0f = %.0f MiB\n", base, per*ctx, each
      printf "  x %d checkpoints            = %.0f MiB (%.2f GiB)\n", ckpt, ckpt*each, ckpt*each/1024
      printf "  + prompt cache             = %d MiB\n", cram
      printf "  ------------------------------------------\n"
      printf "  RESERVED HOST RAM          = %.0f MiB (%.2f GiB)\n\n", ckpt*each + cram, (ckpt*each + cram)/1024
      printf "  The %.0f MiB base is paid PER CHECKPOINT and does not shrink with\n", base
      printf "  a smaller context window -- it is the draft KV and the ngram map.\n\n"
    }'
}

main() {
  if (( BUDGET_ONLY )); then budget; exit 0; fi
  budget
  (( REPORT_ONLY )) || capture
  report
}
main "$@"
