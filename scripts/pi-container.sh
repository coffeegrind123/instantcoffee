#!/usr/bin/env bash
#
# Run pi against the local model, in its own container.
#
#   ./scripts/pi-container.sh                 start a session
#   ./scripts/pi-container.sh -C myproj       work on <container home>/myproj
#   ./scripts/pi-container.sh --session <id>  resume a session, in its own directory
#   ./scripts/pi-container.sh -p "summarize"  any pi flag passes through
#   ./scripts/pi-container.sh --shell         a shell in the container, not pi
#   ./scripts/pi-container.sh --status        what is running, and against what
#   ./scripts/pi-container.sh --stop          stop it (all state is on the mount)
#   ./scripts/pi-container.sh --recreate      drop and recreate, e.g. after a rebuild
#   ./scripts/pi-container.sh --print-only    show the docker commands and stop
#
# This is scripts/pi-local.sh with a container around it, and the container is
# meant to be invisible: the same flags, the same banner, the same session. It
# creates the container on first use, reuses it afterwards, and delegates to
# pi-local.sh inside — so everything pi-local.sh knows about the stack stays in
# exactly one place.
#
# Reusing a long-lived container rather than `docker run --rm` per session is
# deliberate: the browser server and its Chrome live in there, and they are
# stateful. A throwaway container per session would relaunch Chrome every time,
# which is the same mistake scripts/browser.sh exists to avoid (a fresh browser
# per call means the page you opened is gone by the next command).
#
# Requires Dockerfile.pi to be built. See docs/container.md.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# ---------------------------------------------------------------------------
# Already inside? Then the container is not the point — just run pi.
#
# This is what makes the script safe to alias unconditionally: the alias works
# the same whether you are on the host or already in a session's shell, instead
# of trying to start a container from inside one.
# ---------------------------------------------------------------------------
if [[ "${PI_AGENT_CONTAINER:-}" == "1" ]]; then
  exec "$REPO_ROOT/scripts/pi-local.sh" "$@"
fi

require_cmd docker

IMAGE="$(env_get PI_CONTAINER_IMAGE)";      : "${IMAGE:=pi-agent:latest}"
NAME="$(env_get PI_CONTAINER_NAME)";        : "${NAME:=instantcoffee-pi}"
CHOME="$(env_get PI_CONTAINER_HOME)";       : "${CHOME:=/home/piuser}"
HHOME="$(env_get PI_CONTAINER_HOME_HOST)"
CREPO="$(env_get PI_CONTAINER_REPO)";       : "${CREPO:=${CHOME}/qwen3.8-forge}"
SHM="$(env_get PI_CONTAINER_SHM)";          : "${SHM:=2g}"
EXTRA="$(env_get PI_CONTAINER_EXTRA_ARGS)"
READY_TIMEOUT="$(env_get PI_CONTAINER_READY_TIMEOUT)"; : "${READY_TIMEOUT:=300}"

MODE=run
WORKDIR_ARG=""
PRINT_ONLY=0
# A session names its own directory, and these are the flags that name a
# session. They are OBSERVED, not consumed: pi gets them verbatim, and the only
# thing this script does with them is work out which directory to start in.
# See workdir_from_session.
#
# --continue and --resume are deliberately not here. Both mean "the previous
# session FOR THIS DIRECTORY", so there is nothing to infer — the current
# directory is already the answer, and inferring one would change what they mean.
SESSION_FLAG=""
SESSION_SEL=""
SESSION_DIR_ARG=""
ARGS=()
# `shift 2` on a flag whose value is missing returns non-zero, and this file runs
# under `set -e`, so the launcher would exit with no message at all. Take the
# value only when there is one and let pi report its own missing argument.
#
# The explicit `return 0` is the whole point and was learned the expensive way:
# without it the function returns the failed test's status, and `VAR="$(take_value
# "$@")"` propagates that under `set -e`. `pi-container.sh --session` with no id
# printed NOTHING and exited 0 — the precise failure the guard exists to avoid,
# reintroduced by the guard.
take_value() { [[ $# -ge 2 ]] && printf '%s' "$2"; return 0; }
while (( $# )); do
  case "$1" in
    -C|--project)  WORKDIR_ARG="${2:-}"; shift 2 ;;
    --shell)       MODE=shell; shift ;;
    --status)      MODE=status; shift ;;
    --stop)        MODE=stop; shift ;;
    --recreate)    MODE=recreate; shift ;;
    --print-only)  PRINT_ONLY=1; shift ;;
    -h|--help)     sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    --session|--session-id|--fork)
                   SESSION_FLAG="$1"; SESSION_SEL="$(take_value "$@")"
                   ARGS+=("$1"); shift
                   if (( $# )); then ARGS+=("$1"); shift; fi ;;
    --session=*|--session-id=*|--fork=*)
                   SESSION_FLAG="${1%%=*}"; SESSION_SEL="${1#*=}"
                   ARGS+=("$1"); shift ;;
    --session-dir) SESSION_DIR_ARG="$(take_value "$@")"
                   ARGS+=("$1"); shift
                   if (( $# )); then ARGS+=("$1"); shift; fi ;;
    --session-dir=*) SESSION_DIR_ARG="${1#*=}"; ARGS+=("$1"); shift ;;
    *)             ARGS+=("$1"); shift ;;
  esac
done

# ---------------------------------------------------------------------------
# The one thing that cannot be defaulted.
#
# A bind SOURCE is resolved by the DAEMON, not by this shell, so it cannot be
# derived from anything here. On Docker Desktop it also has to be the Windows
# path in docker's form: a WSL-style source silently mounts an EMPTY directory
# instead of failing, which arrives as "my home is gone" rather than as a bad
# path. Same rule as MODELS_DIR.
# ---------------------------------------------------------------------------
if [[ -z "$HHOME" ]]; then
  die "PI_CONTAINER_HOME_HOST is not set — this script cannot guess where the
     agent's home directory lives on the host, because the docker daemon is the
     one that resolves it. Put it in .env.local:

       PI_CONTAINER_HOME_HOST=/path/to/pi-home

     On Docker Desktop for Windows use docker's form of the Windows path
     (//c/path/to/pi-home), never a WSL path and never a relative ./ one."
fi

# --- container state --------------------------------------------------------
# `docker inspect` on a missing container exits non-zero AND prints a newline to
# stdout, so the obvious `... || echo absent` yields a value with a leading
# newline that matches neither "running" nor "absent" — the container is then
# neither created nor started, and docker is asked to start something that does
# not exist. Capture, strip, then decide.
state() {
  local s
  s="$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$s" ]] && printf '%s' "$s" || printf 'absent'
}

# Sets the global RUN_CMD array rather than printing it. A command assembled by
# printing and re-reading loses the argument boundaries the moment a path
# contains a space, and the failure is docker complaining about a flag nobody
# typed.
RUN_CMD=()
build_run_cmd() {
  RUN_CMD=(docker run -d -it --name "$NAME"
           -v "${HHOME}:${CHOME}"
           -v /var/run/docker.sock:/var/run/docker.sock
           --add-host host.docker.internal:host-gateway
           --shm-size="$SHM"
           -e "PI_HOME_HOSTPATH=${HHOME}")
  # Split on whitespace on purpose: this is a flag string, not a path.
  if [[ -n "$EXTRA" ]]; then
    local extra_arr; read -r -a extra_arr <<< "$EXTRA"
    RUN_CMD+=("${extra_arr[@]}")
  fi
  RUN_CMD+=("$IMAGE")
}

# The image the container was BUILT from, against the image that tag points at
# now. Rebuilding pi-agent:latest does not touch a container already created
# from the old one, and the symptom is a fix that is present in the Dockerfile
# and absent from every session — with nothing anywhere saying why.
image_drifted() {
  local want have
  want="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null)" || return 1
  have="$(docker inspect -f '{{.Image}}' "$NAME" 2>/dev/null)" || return 1
  [[ -n "$want" && -n "$have" && "$want" != "$have" ]]
}

wait_ready() {
  local waited=0
  while (( waited < READY_TIMEOUT )); do
    docker exec "$NAME" test -f /tmp/.pi-agent-ready 2>/dev/null && return 0
    # A container that died during start-up will never produce the marker;
    # noticing that beats waiting out the whole timeout on a corpse.
    [[ "$(state)" == running ]] || return 1
    sleep 1; waited=$(( waited + 1 ))
  done
  return 1
}

ensure_up() {
  local st; st="$(state)"

  if [[ "$st" == running ]]; then
    image_drifted && warn "the container predates the current ${IMAGE} — ./scripts/pi-container.sh --recreate to adopt it"
    return 0
  fi

  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || die "image '${IMAGE}' is not built — docker build -f Dockerfile.pi -t ${IMAGE} ."

  if [[ "$st" == absent ]]; then
    info "Creating ${NAME} from ${IMAGE}"
    build_run_cmd
    "${RUN_CMD[@]}" >/dev/null || die "could not create the container"
  else
    info "Starting ${NAME} (was ${st})"
    docker start "$NAME" >/dev/null || die "could not start the container"
  fi

  if ! wait_ready; then
    warn "the container did not report ready within ${READY_TIMEOUT}s — its start-up log:"
    docker logs --tail 40 "$NAME" 2>&1 | sed 's/^/  /' >&2
    die "give it longer with PI_CONTAINER_READY_TIMEOUT, or investigate with --shell"
  fi

  # The banner start.sh printed inside is the operator's, not the container's —
  # surface it, or the container has swallowed the one report that says whether
  # forge is up and the model is loaded.
  docker logs --tail 40 "$NAME" 2>&1 | sed -n '/^Display:/,$p'
}

# --- which directory pi works on --------------------------------------------
# pi works on the CURRENT directory, and the caller's current directory is not
# necessarily a path the container has. So: test candidates inside the container
# rather than translating paths by rule, and say which one was chosen. A guessed
# mapping that happens to resolve is how you end up editing the wrong checkout.
in_container_dir() { docker exec "$NAME" test -d "$1" 2>/dev/null; }

# Is this path inside one of the container's bind mounts?
#
# This is the predicate that decides whether a directory on both sides is the
# SAME directory. "Does it exist in there" is not: /tmp, /usr and / exist on
# both and mean different things. Scoping to the container's HOME instead was
# the first fix and was too blunt — it also rejected a project deliberately
# mounted somewhere else, which is the whole point of PI_CONTAINER_EXTRA_ARGS.
#
# The docker socket is skipped: it is a mount, it is not a place to work, and
# `/var/run/...` would otherwise match a caller who happened to be sitting there.
path_in_mount() {
  local p="$1" d
  while read -r d; do
    [[ -z "$d" || "$d" == "/var/run/docker.sock" ]] && continue
    [[ "$p" == "$d" || "$p" == "$d"/* ]] && return 0
  done < <(docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$NAME" 2>/dev/null)
  return 1
}

# NOTE: this function's STDOUT is the answer, so every human-facing line inside
# it goes to stderr. A note printed on stdout is captured into the path, and
# docker then rejects it with "Cwd must be an absolute path" — which names the
# symptom and nothing about the note that caused it.
note() { dim "$@" >&2; }

# --- which directory a SESSION belongs to ------------------------------------
#
# pi stores a session under `<agent dir>/sessions/<project key>/<stamp>_<uuid>`
# and looks one up by the key for the CURRENT directory — so `--session <id>`
# from the wrong directory is not an error, it is a miss: pi starts a new
# session and the one you asked for sits there untouched. The container makes
# that easy to hit, because the launcher's default working directory comes from
# where you typed the command, and the session's comes from where it ran.
#
# The answer is in the session file. Its first line is the header pi wrote when
# the session began:
#
#     {"type":"session","version":3,"id":"01a042c0-…","cwd":"/home/piuser"}
#
# `cwd` is read from there and nowhere else. The directory NAME is not decoded:
# the key is the path with every `/` turned into `-`, which is lossy — a
# directory whose own name contains a dash is indistinguishable from one more
# level of nesting, and `--home-piuser-qwen3.8-forge--` is a real example of a
# key that could be read two ways. The header cannot be read two ways.
#
# Runs inside the container because that is where the sessions are, and asks
# lib.sh's `agent_dir` for the root rather than assuming `~/.pi/agent` — that is
# AO10's rule, and this is a fifth reader of it.
#
# Prints the directory on stdout, or nothing. Everything else is stderr.
session_file_cwd() {
  local sel="$1" root="$SESSION_DIR_ARG"
  if [[ -z "$root" ]]; then
    root="$(docker exec "$NAME" bash -c 'source "$1/scripts/lib.sh"; agent_dir' _ "$CREPO" 2>/dev/null)/sessions"
  fi
  docker exec -i "$NAME" python3 - "$sel" "$root" <<'PY_SESSION'
import glob, json, os, sys

sel, root = sys.argv[1], sys.argv[2]

# A path is a path; anything else is an id or a fragment of one. pi accepts a
# partial UUID, so this has to match the way pi does — and then REFUSE an
# ambiguous one rather than pick, because the pick decides a working directory.
if "/" in sel:
    matches = [sel] if os.path.isfile(sel) else []
else:
    matches = sorted(glob.glob(os.path.join(root, "*", "*" + glob.escape(sel) + "*.jsonl")))

def cwd_of(path):
    with open(path, encoding="utf-8") as fh:
        header = json.loads(fh.readline())
    return header.get("cwd") if header.get("type") == "session" else None

if not matches:
    print("NONE")
    raise SystemExit(0)

try:
    found = [(m, cwd_of(m)) for m in matches]
except (OSError, ValueError) as exc:
    print("UNREADABLE\t%s\t%s" % (matches[0], exc))
    raise SystemExit(0)

# Several matches are only a problem when they disagree about the DIRECTORY.
# That is the only question being asked here; which of them to open is pi's,
# and pi is better placed to refuse it — it can see both and this cannot.
places = {cwd for _, cwd in found}
if len(places) > 1:
    print("MANY")
    for m, cwd in found:
        print("\t%s\t%s" % (cwd, m))
    raise SystemExit(0)

path, cwd = found[0]
if not cwd:
    print("NOCWD\t%s" % path)
else:
    print("OK\t%s\t%s" % (cwd, path))
PY_SESSION
}

# The half that talks. Prints the directory to use, or nothing to leave the
# normal resolution alone.
workdir_from_session() {
  local sel="$1" verdict rest cwd path
  verdict="$(session_file_cwd "$sel" || true)"
  rest="${verdict#*$'\t'}"
  case "${verdict%%$'\t'*}" in
    OK*)
      cwd="${rest%%$'\t'*}"; path="${rest#*$'\t'}"
      # A session whose directory is gone is worth stopping for: pi would start
      # in some other directory, miss the session, and open a new one silently.
      in_container_dir "$cwd" || die "session '${sel}' belongs to ${cwd}, which the container does not have.
It was recorded in $(basename "$path").
Mount it — in .env.local, using the host path:
    PI_CONTAINER_EXTRA_ARGS=-v <host path>:${cwd}
then ./scripts/pi-container.sh --recreate. Or pass -C <dir> to start elsewhere."
      printf '%s' "$cwd"
      ;;
    MANY*)
      die "'${sel}' matches sessions in more than one directory, so which one to
start in cannot be decided from the id alone:
$(printf '%s\n' "$verdict" | tail -n +2)
Pass more of the id, or the file path, or -C <dir> to choose the directory yourself."
      ;;
    NOCWD*|UNREADABLE*)
      warn "the session file for '${sel}' has no usable header ($(printf '%s' "$rest" | tr '\t' ' ')),"
      warn "so its directory is unknown — falling back to the usual rules."
      ;;
    *)
      # NONE, or the lookup itself could not run. Not fatal: --session-id may
      # legitimately name a session that does not exist yet, and pi's own error
      # is better than a guess from here.
      warn "no session file matches '${sel}' under the container's sessions directory."
      warn "Starting where the usual rules point; pi looks up sessions by directory,"
      warn "so if it is somewhere else, pass -C <dir>."
      ;;
  esac
}

# A session selector answers "which directory", and it answers it better than
# the caller's shell does. -C still wins — it is the explicit one — but when
# both are present and they disagree, say so: pi looks the session up under the
# -C directory's key, does not find it, and quietly starts a new one.
apply_session_workdir() {
  [[ -n "$SESSION_SEL" && "$MODE" == run ]] || return 0
  local from; from="$(workdir_from_session "$SESSION_SEL")"
  if [[ -z "$WORKDIR_ARG" ]]; then
    [[ -n "$from" ]] || return 0
    WORKDIR_ARG="$from"
    note "working on ${from} — where ${SESSION_FLAG} ${SESSION_SEL} was recorded"
    return 0
  fi
  [[ -n "$from" && "$from" != "$WORKDIR_ARG" ]] || return 0
  warn "-C says ${WORKDIR_ARG}, but ${SESSION_FLAG} ${SESSION_SEL} was recorded in ${from}."
  warn "pi looks sessions up by directory, so it will not find that one here — it will"
  warn "start a new session instead. Drop the -C to resume it where it lives."
}

resolve_workdir() {
  local want="$1"
  if [[ -n "$want" ]]; then
    [[ "$want" == /* ]] || want="${CHOME}/${want}"
    in_container_dir "$want" || die "'${want}' does not exist in the container"
    printf '%s' "$want"; return 0
  fi

  # The same absolute path, but only if it is genuinely shared — see path_in_mount.
  if path_in_mount "$PWD" && in_container_dir "$PWD"; then
    printf '%s' "$PWD"; return 0
  fi

  if [[ "$PWD" == "$HOME"/* ]]; then
    local mapped="${CHOME}/${PWD#"$HOME"/}"
    if in_container_dir "$mapped"; then
      note "working on ${mapped} (the container's equivalent of ${PWD})"
      printf '%s' "$mapped"; return 0
    fi
  fi

  # Loud, and with the fix in it. A one-line "not visible" is how you end up in
  # a session that runs perfectly against the wrong — empty — directory.
  warn "${PWD} is not mounted into the container, so pi cannot see it."
  warn "Starting in ${CHOME} instead, which holds:"
  docker exec "$NAME" sh -c "ls -1 '${CHOME}' 2>/dev/null | head -8 | sed 's/^/       /'" >&2 || true
  warn "To work on ${PWD}, mount it — in .env.local, and using the host path:"
  warn "    PI_CONTAINER_EXTRA_ARGS=-v <host path>:${CHOME}/$(basename "$PWD")"
  warn "then ./scripts/pi-container.sh --recreate. Or pass -C <dir> for somewhere it can already see."
  printf '%s' "$CHOME"
}

# --- modes ------------------------------------------------------------------
case "$MODE" in
  stop)
    [[ "$(state)" == absent ]] && { ok "${NAME} does not exist"; exit 0; }
    info "Stopping ${NAME}"
    docker stop "$NAME" >/dev/null && ok "stopped — every byte of state is on ${HHOME}"
    exit 0 ;;

  recreate)
    if [[ "$(state)" != absent ]]; then
      info "Removing ${NAME}"
      docker rm -f "$NAME" >/dev/null
    fi
    ensure_up
    ok "recreated from $(docker image inspect -f '{{.Id}}' "$IMAGE" | cut -c8-19)"
    exit 0 ;;

  status)
    st="$(state)"
    printf 'container    %s (%s)\n' "$NAME" "$st"
    printf 'image        %s\n' "$IMAGE"
    printf 'home         %s -> %s\n' "$HHOME" "$CHOME"
    printf 'checkout     %s\n' "$CREPO"
    if [[ "$st" == running ]]; then
      image_drifted && printf 'drift        YES — created from an older %s; --recreate to adopt it\n' "$IMAGE" \
                    || printf 'drift        no\n'
      in_container_dir "$CREPO" && printf 'checkout     present\n' \
                                || printf 'checkout     MISSING inside the container\n'
      # The question every confused session actually has: what can pi see?
      printf 'mounts       '
      docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$NAME" 2>/dev/null \
        | grep -v '^/var/run/docker.sock$' | grep -v '^$' | paste -sd' ' -
      if docker exec "$NAME" curl -fsS -m 3 -o /dev/null http://host.docker.internal:8081/forge/health 2>/dev/null; then
        docker exec "$NAME" curl -fsS -m 3 -o /dev/null http://host.docker.internal:8081/health 2>/dev/null \
          && printf 'forge        up, model loaded\n' \
          || printf 'forge        up, model still loading\n'
      else
        printf 'forge        not answering — ./scripts/up.sh\n'
      fi
    fi
    exit 0 ;;
esac

# --- run --------------------------------------------------------------------
if (( PRINT_ONLY )); then
  build_run_cmd
  printf '%q ' "${RUN_CMD[@]}"; echo
  # The create command is half of it, and the half nobody has to debug. What
  # decides which directory the session runs in is the exec, so print that too
  # — but only when the container is already running, because working it out
  # means asking the container what it can see. This is also how the
  # session-to-directory inference is checked without starting a session.
  if [[ "$(state)" == running ]]; then
    apply_session_workdir
    printf '%q ' docker exec -it -w "$(resolve_workdir "$WORKDIR_ARG")" "$NAME" \
                 "${CREPO}/scripts/pi-local.sh" "${ARGS[@]}"; echo
  fi
  exit 0
fi

ensure_up

in_container_dir "$CREPO" \
  || die "no checkout at ${CREPO} inside the container.
     Clone this repo into ${HHOME} (it appears as ${CHOME} in there), or point
     PI_CONTAINER_REPO at wherever it actually is."

apply_session_workdir
WORKDIR="$(resolve_workdir "$WORKDIR_ARG")"

# -t only when there is a terminal on BOTH ends. `docker exec -it` against a
# pipe fails with "the input device is not a TTY", which would break every
# non-interactive use (-p, CI, a subagent) for no reason.
tty_flags=(-i)
[[ -t 0 && -t 1 ]] && tty_flags=(-it)

if [[ "$MODE" == shell ]]; then
  exec docker exec "${tty_flags[@]}" -w "$WORKDIR" "$NAME" bash -l
fi

exec docker exec "${tty_flags[@]}" -w "$WORKDIR" "$NAME" \
     "${CREPO}/scripts/pi-local.sh" "${ARGS[@]}"
