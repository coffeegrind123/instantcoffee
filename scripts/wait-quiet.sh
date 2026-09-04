#!/bin/bash
# Wait for a window that is quiet AND STAYS quiet, then exit 0.
#
#   ./scripts/wait-quiet.sh && setsid nohup ./scripts/ninfer-compare.sh ... &
#
# Exists because a comparison taken on a busy box is not a slower measurement,
# it is a WRONG one: same engine, same prompt, ninfer prefilled 1025 t/s at
# load 41-72 and 1948 t/s at mean load 2.66. See HANDOFF part 7 section 5.
#
# Two lessons paid for on 2026-09-04:
#  - `pgrep -c` prints 0 AND exits 1 on no-match, so `|| echo 0` yields "0\n0"
#    and every [ -eq ] after it dies with "integer expression expected". The
#    first version of this script looped 26 minutes doing nothing because of it.
#  - Matching only `rustc`/`cargo` misses `clippy-driver`, which is what
#    `cargo clippy` actually spawns. A build was running while this reported
#    READY. Match the toolchain directory instead of guessing exe names.
#  - A single passing sample is not a quiet window: the box had 1-min load 1.36
#    with 5-min 7.36 while a build was starting up again. Require the condition
#    to hold for HOLD consecutive samples.
HOLD=${HOLD:-3}
ok_streak=0
i=0
while [ $i -lt 360 ]; do
  h=$(docker inspect -f '{{.State.Health.Status}}' instantcoffee-llama 2>/dev/null)
  l=$(cut -d' ' -f1 /proc/loadavg)
  # any process out of the rust toolchain: rustc, cargo, clippy-driver, rustdoc
  b=$(pgrep -f '\.rustup/toolchains' 2>/dev/null | wc -l)
  n=$(docker ps -aq --filter name=instantcoffee-bench-run 2>/dev/null | wc -l)
  if [ "$h" = healthy ] && [ "$b" -eq 0 ] && [ "$n" -eq 0 ] \
     && awk "BEGIN{exit !($l < 2.5)}"; then
    ok_streak=$((ok_streak + 1))
    if [ "$ok_streak" -ge "$HOLD" ]; then
      echo "READY $(date +%H:%M:%S) after ${ok_streak} clean samples  load=$(cat /proc/loadavg)"
      exit 0
    fi
  else
    [ "$ok_streak" -gt 0 ] && echo "reset at $(date +%H:%M:%S): health=$h rust=$b bench=$n load=$l"
    ok_streak=0
  fi
  sleep 20; i=$((i+1))
done
echo "TIMEOUT $(date +%H:%M:%S) health=$h rust=$b bench=$n load=$l"
exit 1
