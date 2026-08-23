#!/usr/bin/env bash
#
# Measure the WINDOWS HOST's VRAM floor over a period, without stopping llama.
#
#   ./scripts/vram-floor.sh                    # 60 samples, 15 s apart (15 min)
#   ./scripts/vram-floor.sh --samples 20 --interval 30
#   ./scripts/vram-floor.sh --report           # re-read the last capture
#
# WHY THIS EXISTS
#
# This box's GPU is shared with the Windows desktop, and every context-window
# decision has been made against a floor nobody had measured. The previous
# method was "docker compose stop llama, read nvidia-smi, start it again" — one
# sample, costing a 15-20 minute cold reload, taken at whatever the desktop
# happened to be doing that minute. It produced a 622 MiB range (1405 / 1536 /
# 1881 / 1905 / 1961 / 2027) with no way to tell where inside it a decision
# should sit, and 128K was refused against its worst end.
#
# HOW IT AVOIDS STOPPING LLAMA
#
# Windows' own performance counters decompose the device, which nvidia-smi
# cannot do here — `nvidia-smi --query-compute-apps` returns [N/A] for every
# used_gpu_memory under WDDM, naming the processes but not their sizes.
#
#   \GPU Adapter Memory(*)\Dedicated Usage   whole device
#   \GPU Process Memory(*)\Dedicated Usage   per process, by pid
#
# `vmwp` is the Hyper-V worker process hosting the WSL2/Docker VM. qwen38-llama
# is the only GPU-enabled container on this box (checked across every running
# container's HostConfig.DeviceRequests), so vmwp's dedicated usage IS llama's,
# and:
#
#   floor = adapter total - vmwp
#
# MEASURED 2026-08-23, and both halves were controlled before being believed:
#
#   * the adapter counter read 23,099.8 MB while nvidia-smi read 23,088 MiB at
#     the same moment — agreement within 12 MiB, so the counters are in real
#     VRAM units and not some commit-charge abstraction.
#   * vmwp held EXACTLY 21,677.4 MB across consecutive samples while the total
#     moved, so all device-usage variation is the desktop and none of it is
#     llama. That is what makes the subtraction valid.
#
# DO NOT SUM THE PER-PROCESS COUNTERS. They double-count: dwm maps every other
# window's surface, so it reports ~4.7 GB and the per-process column sums to
# 27,800 MB on a 24,564 MiB device. Only the adapter total is additive. dwm's
# apparent size is also why "close a browser and the floor drops" is wrong —
# the closable applications are 50-200 MB each.
#
# NEEDS THE HOST BRIDGE, and checks it properly. ~/.claude-host-bridge-token
# EXISTING DOES NOT MEAN THE BRIDGE IS RUNNING; that assumption cost a session.
# This probes the port.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd jq curl

HOSTEXEC="${HOSTEXEC:-$HOME/claude-host-bridge/hostexec}"
# The bridge writes to the Windows side of the 9p mount; we read it back here.
HOST_DIR_WIN='C:\Users\User\Downloads\as\data\claude-host-bridge'
HOST_DIR_WSL="$HOME/claude-host-bridge"
CSV_NAME="vram-floor-paired.csv"
RESULTS_DIR="${RESULTS_DIR:-$REPO_ROOT/context/bench/capacity}"

SAMPLES=60
INTERVAL=15
REPORT_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --samples)  SAMPLES="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --report)   REPORT_ONLY=1; shift ;;
    -h|--help)  sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "unknown argument '$1'" ;;
  esac
done

# The token file is not the bridge. Probe the port: a 401 is a RUNNING bridge
# refusing an unauthenticated request, which is exactly what we want to see.
require_bridge() {
  local code
  [[ -x "$HOSTEXEC" ]] || die "no hostexec at $HOSTEXEC"
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
            http://host.docker.internal:6799/health 2>/dev/null || true)"
  case "$code" in
    000|"") die "the host bridge is NOT running (nothing listening on 6799).
       ~/.claude-host-bridge-token existing does not mean it is up.
       Ask the user to run $HOST_DIR_WIN\\start-bridge.bat" ;;
    *) ok "bridge is up (HTTP $code from /health)" ;;
  esac
}

# Read a file the bridge wrote. PowerShell 5.1's Out-File -Encoding utf8 emits a
# BOM, and some paths emit UTF-16LE; strip NULs and the BOM rather than guessing.
read_host_csv() {
  tr -d '\000' < "$HOST_DIR_WSL/$CSV_NAME" 2>/dev/null | sed 's/\xef\xbb\xbf//' | grep ',' || true
}

capture() {
  require_bridge
  local vmpid
  info "finding the VM worker process holding the GPU ..."
  # Pick the vmwp actually holding VRAM, not merely the largest by working set.
  # There can be more than one VM on a Windows box (WSL2, Hyper-V, WSA) and only
  # the one Docker Desktop runs has the GPU; choosing by RAM would silently pick
  # the wrong one and every floor reading after it would be nonsense.
  vmpid="$("$HOSTEXEC" -t 100000 '$g = (Get-Counter "\GPU Process Memory(*)\Dedicated Usage" -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.CookedValue -gt 0 }
$best = $g | ForEach-Object { if ($_.InstanceName -match "pid_(\d+)_") { [pscustomobject]@{ P=[int]$matches[1]; V=[double]$_.CookedValue } } } |
  Group-Object P | ForEach-Object { [pscustomobject]@{ P=[int]$_.Name; V=($_.Group | Measure-Object V -Sum).Sum } } |
  Where-Object { (Get-Process -Id $_.P -ErrorAction SilentlyContinue).ProcessName -eq "vmwp" } |
  Sort-Object V -Descending | Select-Object -First 1
if ($best) { $best.P }' 2>/dev/null | tr -d '\r' | grep -oE '^[0-9]+$' | head -1 || true)"
  [[ -n "$vmpid" ]] || die "no vmwp process is holding GPU memory on the host.
       Is Docker Desktop running, and is llama up? If llama is DOWN this is
       expected — the floor is then just nvidia-smi, with nothing to subtract."
  ok "  vmwp pid $vmpid (the WSL2/Docker VM, i.e. llama)"

  local mins=$(( SAMPLES * INTERVAL / 60 ))
  info "sampling $SAMPLES times every ${INTERVAL}s (~${mins} min), llama untouched ..."

  # Detached: /exec is synchronous and the listener is single-threaded, so a
  # 15-minute foreground call would block /health and everything else.
  "$HOSTEXEC" -j "Remove-Item -ErrorAction SilentlyContinue \"$HOST_DIR_WIN\\$CSV_NAME\"
1..$SAMPLES | ForEach-Object {
  \$tot = (Get-Counter \"\\GPU Adapter Memory(*)\\Dedicated Usage\" -ErrorAction SilentlyContinue).CounterSamples | Where-Object { \$_.CookedValue -gt 0 } | Measure-Object CookedValue -Sum
  \$vm = (Get-Counter \"\\GPU Process Memory(*)\\Dedicated Usage\" -ErrorAction SilentlyContinue).CounterSamples | Where-Object { \$_.InstanceName -match \"pid_${vmpid}_\" } | Measure-Object CookedValue -Sum
  \$t = [math]::Round(\$tot.Sum/1MB,1); \$v = [math]::Round(\$vm.Sum/1MB,1)
  ((Get-Date -Format \"HH:mm:ss\") + \",\" + \$t + \",\" + \$v + \",\" + [math]::Round(\$t-\$v,1)) | Out-File -Append -Encoding utf8 -Width 4096 \"$HOST_DIR_WIN\\$CSV_NAME\"
  Start-Sleep -Seconds $INTERVAL }" >/dev/null 2>&1 \
    || die "could not start the sampling job on the host"

  local n=0 want="$SAMPLES" waited=0 budget=$(( SAMPLES * INTERVAL + 120 ))
  while (( n < want && waited < budget )); do
    sleep "$INTERVAL"; waited=$(( waited + INTERVAL ))
    n="$(read_host_csv | grep -c ',' || true)"
    printf '\r  %s/%s samples' "$n" "$want" >&2
  done
  printf '\n' >&2
  (( n > 0 )) || die "the sampling job wrote nothing — read $HOST_DIR_WSL/jobs/ for its stderr"
  (( n >= want )) || warn "captured $n of $want samples before the budget ran out"

  mkdir -p "$RESULTS_DIR"
  read_host_csv > "$RESULTS_DIR/vram-floor.csv"
  ok "  $n samples -> $RESULTS_DIR/vram-floor.csv"
}

report() {
  local f="$RESULTS_DIR/vram-floor.csv"
  [[ -s "$f" ]] || die "no capture at $f — run without --report first"

  # The engine's own -lv 5 delta, not a sampled one. 96K CUDA0 total is 20426
  # MiB and 128K is 21834; sampled deltas got this wrong by 1163 MiB once.
  local delta_128k=1408 total=24564
  awk -F, -v d="$delta_128k" -v tot="$total" '
    { n++; t[n]=$2; v[n]=$3; f[n]=$4
      if (n==1 || $4<fmin) fmin=$4
      if (n==1 || $4>fmax) fmax=$4
      fsum+=$4
      if (n==1 || $3<vmin) vmin=$3
      if (n==1 || $3>vmax) vmax=$3
      if (n==1 || $2<tmin) tmin=$2
      if (n==1 || $2>tmax) tmax=$2 }
    END {
      if (n==0) { print "no samples"; exit 1 }
      # median without sorting the whole array in awk: insertion sort, n is ~60
      for (i=1;i<=n;i++) s[i]=f[i]
      for (i=2;i<=n;i++) { x=s[i]; j=i-1; while (j>0 && s[j]>x) { s[j+1]=s[j]; j-- } s[j+1]=x }
      med = (n%2) ? s[(n+1)/2] : (s[n/2]+s[n/2+1])/2
      printf "\n==> host VRAM floor over %d samples\n\n", n
      printf "  %-26s %10s %10s %10s\n", "", "min", "median", "max"
      printf "  %-26s %10.1f %10s %10.1f\n", "device total (MiB)", tmin, "-", tmax
      printf "  %-26s %10.1f %10s %10.1f\n", "llama, via vmwp (MiB)", vmin, "-", vmax
      printf "  %-26s %10.1f %10.1f %10.1f\n", "WINDOWS HOST FLOOR (MiB)", fmin, med, fmax
      printf "\n  llama moved %.1f MiB across the whole capture", vmax-vmin
      if (vmax-vmin < 1) printf " (i.e. not at all)"
      printf "\n  the floor moved %.1f MiB, and that is all desktop\n", fmax-fmin
      printf "\n==> what this leaves for a bigger window\n\n"
      printf "  free at the CURRENT window  = %.0f - device total\n", tot
      printf "  free at 128K                = %.0f - (device total + %d)\n\n", tot, d
      printf "  %-14s %12s %12s %12s\n", "", "best case", "median", "worst case"
      printf "  %-14s %12.0f %12.0f %12.0f\n", "free now", tot-tmin, tot-(vmin+med), tot-tmax
      printf "  %-14s %12.0f %12.0f %12.0f\n", "free at 128K", tot-tmin-d, tot-(vmin+med)-d, tot-tmax-d
      printf "\nThere is NO draft-KV rescue to add to that last row. Quantising the MTP\n"
      printf "draft cache (-ctkd/-ctvd q8_0) reads like a ~240 MiB saving at 128K and is\n"
      printf "measured to COST ~284: it saves 240 MiB of draft KV and spends ~524 MiB of\n"
      printf "draft compute buffer, because the quantised path drops the draft context\n"
      printf "onto a full-width workspace. Measured at 64K and 96K, 2026-08-23; see\n"
      printf "draft_kv_note in versions.lock. Do not put it back in this arithmetic.\n"
    }' "$f"
}

main() {
  (( REPORT_ONLY )) || capture
  report
}
main "$@"
