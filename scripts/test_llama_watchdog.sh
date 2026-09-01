#!/usr/bin/env bash
#
# Does the llama healthcheck's WATCHDOG actually behave?
#
#   ./scripts/test_llama_watchdog.sh
#
# WHAT IT IS TESTING, AND WHY IT IS NOT A UNIT TEST
#
# On 2026-09-01 llama-server aborted on a CUDA assert and did not exit. It held
# its PID and its VRAM with nothing listening on 8080, so `restart:
# unless-stopped` never fired — a restart policy only sees processes that end.
# Docker marked the container unhealthy 88 times over two hours and nothing on
# this box acts on unhealthy. The healthcheck in docker-compose.yml now ends the
# container itself when the server has been up and has stopped answering.
#
# A probe that can kill the stack is not something to ship on a reading. This
# drives the REAL shipped script — read out of the created container with
# `docker inspect`, not copied into this file, so the two cannot drift — against
# a throwaway container whose "llama-server" is a renamed `sleep`.
#
# THE FOUR THINGS THAT MUST HOLD, each one a way the naive version breaks a
# working stack:
#
#   1. It must NOT kill during a cold load. A 27B GGUF takes ~24 minutes off
#      this box's bind mount, and for some of that nothing is listening. The
#      guard is a sentinel — nothing is counted until the server has answered
#      once — so no assumption about when the port binds is being made.
#   2. It must not count an HTTP error. A server replying 503 is a server.
#   3. It must count consecutive nobody-home probes and, at the threshold, kill
#      the server so the container EXITS. Not "become unhealthy" — exit.
#   4. Its state must not survive the restart it causes, or the first failed
#      probe after the restart kills again and the container never comes up.
#      That is what the tmpfs is for, and 4 is the check that it works.
#
# Costs no GPU: the throwaway container never loads a model.

# NOT `set -e`. Every interesting step here EXPECTS a non-zero exit — a probe
# that fails is the subject, `docker exec` against the container the probe just
# killed is the confirmation — and `set -e` turned the whole suite into one
# silent early exit after the first section header. A test runner that stops at
# the first failure cannot report which cases passed.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Fixed by `container_name:` in docker-compose.yml, so a literal is the same
# string compose uses and there is no helper to go stale.
LLAMA="instantcoffee-llama"
NAME="instantcoffee-watchdog-test"
STATE="/run/llama-watchdog"
PASSED=0
FAILED=0

check() {
  local name="$1" cond="$2" detail="${3:-}"
  if [[ "$cond" == "1" ]]; then
    printf '  \033[32mPASS\033[0m  %s\n' "$name"
    PASSED=$((PASSED + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s%s\n' "$name" "${detail:+  — $detail}"
    FAILED=$((FAILED + 1))
  fi
}

eq() { # name got want
  local got="$2" want="$3"
  check "$1" "$([[ "$got" == "$want" ]] && echo 1 || echo 0)" "got '$got', want '$want'"
}

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --- the script under test, taken from the container that will run it ---------
#
# Deliberately NOT read from docker-compose.yml: `docker compose config`
# re-escapes $ as $$ so its output is a compose file again, and testing that
# text would test the escaping rather than the script. The created container's
# Config.Healthcheck.Test is the interpolated, literal, runtime string.
docker inspect "$LLAMA" >/dev/null 2>&1 \
  || die "$LLAMA does not exist — run ./scripts/up.sh first.
       This test reads the shipped probe out of the created container so it
       cannot drift from what actually runs."

# Read as JSON and split in python. `--format '{{range}}{{println .}}{{end}}'`
# looks right and is not: the script element is itself multi-line, so mapfile
# splits ONE element into a dozen and $PROBE ends up being its first line.
HC_JSON="$(docker inspect "$LLAMA" --format '{{json .Config.Healthcheck.Test}}')"
read_el() { printf '%s' "$HC_JSON" | python3 -c \
  "import json,sys; a=json.load(sys.stdin); print(a[$1] if len(a)>$1 else '')"; }
[[ "$(read_el 0)" == "CMD" && "$(read_el 1)" == "sh" ]] \
  || die "llama's healthcheck is not the sh watchdog (got '$(read_el 0)' '$(read_el 1)').
       Either docker-compose.yml changed or the container predates it; recreate
       it with ./scripts/up.sh."
PROBE="$(read_el 3)"
[[ "$PROBE" == *"$STATE"* ]] \
  || die "the probe does not mention $STATE — this test is out of date with it"
grep -q "kill -9" <<<"$PROBE" \
  || die "the probe contains no kill — nothing to test"

IMG="$(llama_image)"
info "probe read from $LLAMA; throwaway container from $IMG"

# `sleep` renamed, so the probe's /proc/*/comm scan has a real target and this
# test costs no GPU. --init mirrors the service's `init: true`, which is what
# makes the container exit when its only child dies.
start_target() {
  cleanup
  docker run -d --init --name "$NAME" --tmpfs "$STATE" \
    -e LLAMA_HEALTH_KILL_AFTER=3 --entrypoint sh "$IMG" \
    -c 'cp /bin/sleep /usr/local/bin/llama-server && exec llama-server 3600' \
    >/dev/null
  # The rename has to have taken effect before any probe runs, or case 3 would
  # pass for the wrong reason (nothing to kill is not the same as killed).
  local i c
  for i in $(seq 1 50); do
    # Compared to "1", not to "not 0": a docker exec that fails while the
    # container is still starting produces an EMPTY string, and "" != "0" would
    # make this loop declare success before the process exists.
    c="$(docker exec "$NAME" sh -c 'cat /proc/*/comm 2>/dev/null' 2>/dev/null | grep -c '^llama-server$' || true)"
    [[ "$c" == "1" ]] && return 0
    sleep 0.2
  done
  die "the throwaway container never produced a process named llama-server"
}

probe() { local rc=0; docker exec "$NAME" sh -c "$PROBE" >/dev/null 2>&1 || rc=$?; echo "$rc"; }
state()  { docker exec "$NAME" sh -c "cat $STATE/fails 2>/dev/null || echo -" 2>/dev/null | tr -d '\r\n'; }
alive()  { docker exec "$NAME" sh -c 'cat /proc/*/comm 2>/dev/null' 2>/dev/null | grep -c '^llama-server$' || true; }

# --- 1. a cold load must survive ---------------------------------------------
printf '\ncold load: nothing has ever answered, so nothing is counted\n'
start_target
for _ in 1 2 3 4 5; do probe >/dev/null; done
eq "five failed probes before the first success leave no counter" "$(state)" "-"
eq "...and llama-server is untouched" "$(alive)" "1"
eq "...and the container is still running" \
   "$(docker inspect -f '{{.State.Running}}' "$NAME")" "true"

# --- 2. a server that answers resets, and 503 is an answer --------------------
printf '\na server that answers: 200 resets the counter, 503 does not count\n'
# One listener, whose status comes from a file, so the same container can be
# healthy and then merely busy without restarting anything.
docker exec -d "$NAME" python3 -c '
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try: code = int(open("/tmp/mode").read().strip())
        except Exception: code = 200
        self.send_response(code); self.end_headers(); self.wfile.write(b"x")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8080), H).serve_forever()'
docker exec "$NAME" sh -c 'echo 200 > /tmp/mode'
for _ in $(seq 1 40); do
  [[ "$(docker exec "$NAME" sh -c 'curl -fsS --max-time 1 -o /dev/null http://127.0.0.1:8080/health; echo $?' | tr -d '\r\n')" == "0" ]] && break
  sleep 0.25
done
eq "a healthy probe exits 0" "$(probe)" "0"
eq "...and records that the server has been up" \
   "$(docker exec "$NAME" sh -c "[ -f $STATE/up ] && echo yes || echo no" | tr -d '\r\n')" "yes"

docker exec "$NAME" sh -c "echo 5 > $STATE/fails; echo 503 > /tmp/mode"
eq "a 503 probe still fails" "$(probe)" "1"
eq "...but does NOT count — a server answering 503 is a server" "$(state)" "5"
eq "...and llama-server is untouched" "$(alive)" "1"

# --- 3. the wedge: count to the threshold, then end the container ------------
printf '\nthe wedge: the server stops answering after having been up\n'
docker exec "$NAME" sh -c "rm -f $STATE/fails"
docker exec "$NAME" sh -c 'for d in /proc/[0-9]*; do grep -q python3 "$d/comm" 2>/dev/null && kill -9 "${d#/proc/}"; done; true' >/dev/null 2>&1 || true
for _ in $(seq 1 40); do
  [[ "$(docker exec "$NAME" sh -c 'curl -fsS --max-time 1 -o /dev/null http://127.0.0.1:8080/health; echo $?' | tr -d '\r\n')" == "7" ]] && break
  sleep 0.25
done
eq "first nobody-home probe counts 1" "$(probe >/dev/null; state)" "1"
eq "second counts 2, and still does not kill" "$(probe >/dev/null; state)" "2"
eq "...llama-server is alive one probe short of the threshold" "$(alive)" "1"
probe >/dev/null            # the third, at LLAMA_HEALTH_KILL_AFTER=3
for _ in $(seq 1 40); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" == "false" ]] && break
  sleep 0.25
done
eq "the third probe ends the CONTAINER, not just the health status" \
   "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" "false"
# In `docker logs`, not only in the health log. A healthcheck's own output goes
# to .State.Health.Log[].Output, which nobody reads and which does not survive
# the restart it is explaining; the probe writes to /proc/1/fd/2 as well so the
# reason sits immediately above the reload in the ordinary container log.
check "...and said why in docker logs, where the operator will look" \
      "$(docker logs "$NAME" 2>&1 | grep -q 'watchdog: llama-server unreachable' && echo 1 || echo 0)" \
      "$(docker logs "$NAME" 2>&1 | tail -2)"

# --- 4. the state must not survive the restart it caused ---------------------
printf '\nthe restart it causes must start from zero\n'
start_target
docker exec "$NAME" sh -c "touch $STATE/up $STATE/fails /tmp/control-marker"
docker restart -t 5 "$NAME" >/dev/null
for _ in $(seq 1 40); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" == "true" ]] && break
  sleep 0.25
done
eq "the watchdog's state is gone after a restart" \
   "$(docker exec "$NAME" sh -c "ls $STATE | wc -l" | tr -d '\r\n ')" "0"
# The control. Without it, "the file is gone" could just mean the restart wiped
# the container, which it does not — and the whole point of the tmpfs is that it
# behaves differently from the writable layer.
eq "CONTROL — a file outside the tmpfs survives the same restart" \
   "$(docker exec "$NAME" sh -c '[ -f /tmp/control-marker ] && echo yes || echo no' | tr -d '\r\n')" "yes"

total=$((PASSED + FAILED))
printf '\n%d/%d passed' "$PASSED" "$total"
if (( FAILED )); then printf ', %d FAILED\n' "$FAILED"; exit 1; fi
printf ' — all good\n'
