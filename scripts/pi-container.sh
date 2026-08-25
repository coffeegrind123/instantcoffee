#!/usr/bin/env bash
#
# Run pi against the local model, in its own container.
#
#   ./scripts/pi-container.sh                 start a session
#   ./scripts/pi-container.sh -C myproj       work on <container home>/myproj
#   ./scripts/pi-container.sh -p "summarize"  any pi flag passes through
#   ./scripts/pi-container.sh --shell         a shell in the container, not pi
#   ./scripts/pi-container.sh --status        what is running, and against what
#   ./scripts/pi-container.sh --stop          stop it (all state is on the mount)
#   ./scripts/pi-container.sh --recreate      drop and recreate, e.g. after a rebuild
#   ./scripts/pi-container.sh --print-only    show the docker command and stop
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
ARGS=()
while (( $# )); do
  case "$1" in
    -C|--project)  WORKDIR_ARG="${2:-}"; shift 2 ;;
    --shell)       MODE=shell; shift ;;
    --status)      MODE=status; shift ;;
    --stop)        MODE=stop; shift ;;
    --recreate)    MODE=recreate; shift ;;
    --print-only)  PRINT_ONLY=1; shift ;;
    -h|--help)     sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
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

# NOTE: this function's STDOUT is the answer, so every human-facing line inside
# it goes to stderr. A note printed on stdout is captured into the path, and
# docker then rejects it with "Cwd must be an absolute path" — which names the
# symptom and nothing about the note that caused it.
note() { dim "$@" >&2; }

resolve_workdir() {
  local want="$1"
  if [[ -n "$want" ]]; then
    [[ "$want" == /* ]] || want="${CHOME}/${want}"
    in_container_dir "$want" || die "'${want}' does not exist in the container"
    printf '%s' "$want"; return 0
  fi

  # Only inside the container's HOME. "Does this path exist in there" is a false
  # positive for every system directory: /tmp, /usr and / all exist on both
  # sides and mean different things, so running from the host's /tmp would have
  # put pi in the CONTAINER's /tmp — an empty directory, silently, with the
  # session looking perfectly normal. The container's world is its home.
  if [[ "$PWD" == "$CHOME" || "$PWD" == "$CHOME"/* ]] && in_container_dir "$PWD"; then
    printf '%s' "$PWD"; return 0
  fi

  if [[ "$PWD" == "$HOME"/* ]]; then
    local mapped="${CHOME}/${PWD#"$HOME"/}"
    if in_container_dir "$mapped"; then
      note "working on ${mapped} (the container's equivalent of ${PWD})"
      printf '%s' "$mapped"; return 0
    fi
  fi

  note "${PWD} is not visible to the container — working on ${CHOME}."
  note "Pass -C <dir> to choose, or start from a directory under ${HHOME}."
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
  exit 0
fi

ensure_up

in_container_dir "$CREPO" \
  || die "no checkout at ${CREPO} inside the container.
     Clone this repo into ${HHOME} (it appears as ${CHOME} in there), or point
     PI_CONTAINER_REPO at wherever it actually is."

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
