#!/usr/bin/env bash
#
# Stage the Prime 4+ reverse-engineering workspace into re-work/, which is the
# directory Dockerfile.pi copies into the pi agent image. The material itself is
# never committed — this repo is public and the case embeds vendor firmware, the
# filesystems carved out of it, and a working root exploit. re-work/README.md is
# the long form.
#
#   ./scripts/stage-re-work.sh            sync the workspace into re-work/
#   ./scripts/stage-re-work.sh --check    report what would change, copy nothing
#   ./scripts/stage-re-work.sh --clean    remove the staged copy, keep the placeholders
#
# Source: $RE_WORK_SRC, from .env.local (it is a host path, so it does not
# belong in the committed .env). Defaults to this repo's parent directory, which
# is where the workspace sits on the machine this branch was built on.
#
# This is a deliberate two-step rather than a bind mount: the point is that a
# container built from this image carries the analysis with it, on any host,
# without the operator having to remember to mount anything.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE=sync
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    --clean) MODE=clean ;;
    *)       die "unknown argument '$a' (try --check or --clean)" ;;
  esac
done

SRC="$(env_get RE_WORK_SRC)"
: "${SRC:=$(dirname "$REPO_ROOT")}"
DST="$REPO_ROOT/re-work"

# What travels with the image. Left of the pipe is relative to RE_WORK_SRC,
# right of it is where it lands under re-work/. Adding a line here is the whole
# of "put this in the container too".
MAP=(
  "cases/prime4plus-5.0.4|prime4plus-5.0.4"
  "refs/PrimeBox|PrimeBox"
)

# Anything else, without editing this script: RE_WORK_EXTRA is a
# space-separated list of RE_WORK_SRC-relative paths, each staged under its own
# basename.
for p in $(env_get RE_WORK_EXTRA); do
  MAP+=("$p|$(basename "$p")")
done

# The update image is the case's own sample and lives at the workspace root as
# well as inside the case's samples/. It is staged only when the case's copy is
# missing, because copying 453 MB twice is nothing but a slower build.
SAMPLE="PRIME4PLUS-5.0.4-Update.img"

if [[ "$MODE" == clean ]]; then
  [[ -d "$DST" ]] || { dim "re-work/ does not exist — nothing to clean"; exit 0; }
  for entry in "$DST"/*; do
    [[ -e "$entry" ]] || continue
    case "$(basename "$entry")" in
      README.md|.gitkeep) continue ;;
    esac
    rm -rf "$entry"
  done
  ok "cleaned $(basename "$DST")/ — the tracked placeholders are untouched"
  exit 0
fi

[[ -d "$SRC" ]] || die "RE_WORK_SRC=$SRC is not a directory. Set it in .env.local."
require_cmd rsync

RSYNC_FLAGS=(-a --delete --exclude '.git/' --exclude '__pycache__/' --exclude '*.pyc')
[[ "$MODE" == check ]] && RSYNC_FLAGS+=(-n -i)

staged=0
for pair in "${MAP[@]}"; do
  from="${pair%%|*}"; to="${pair##*|}"
  if [[ ! -d "$SRC/$from" ]]; then
    warn "$SRC/$from is missing — skipped"
    continue
  fi
  mkdir -p "$DST/$to"
  if [[ "$MODE" == check ]]; then
    info "would sync $from -> re-work/$to"
  else
    info "syncing $from -> re-work/$to"
  fi
  rsync "${RSYNC_FLAGS[@]}" "$SRC/$from/" "$DST/$to/"
  staged=1
done

case_sample="cases/prime4plus-5.0.4/samples/$SAMPLE"
if [[ -f "$SRC/$case_sample" ]]; then
  # The case carries its own copy, so the MAP loop above already brought it in.
  dim "the update image travels inside the case's samples/ — not copied again"
elif [[ -f "$SRC/$SAMPLE" ]]; then
  sample_dir="$DST/prime4plus-5.0.4/samples"
  if [[ "$MODE" == check ]]; then
    info "would copy $SAMPLE -> re-work/prime4plus-5.0.4/samples/"
  else
    mkdir -p "$sample_dir"
    cp -a "$SRC/$SAMPLE" "$sample_dir/$SAMPLE"
    info "copied $SAMPLE -> re-work/prime4plus-5.0.4/samples/"
  fi
elif [[ "$staged" == 0 ]]; then
  die "nothing to stage: neither the Prime 4+ case nor PrimeBox exists under $SRC"
fi

if [[ "$MODE" == check ]]; then
  dim "check only — re-work/ was not modified"
  exit 0
fi

# A manifest inside the staged tree, so a session in the container can tell what
# it is looking at and when it was staged without asking the host.
{
  printf 'staged_utc = %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'source     = %s\n' "$SRC"
  printf 'repo       = %s\n' "$REPO_ROOT"
} > "$DST/.manifest"

# The size is the reason this prints: it is the image, the build context and
# every rebuild, and it is easy to add a directory here and not notice.
size="$(du -sh "$DST" 2>/dev/null | cut -f1)"
files="$(find "$DST" -type f 2>/dev/null | wc -l)"
ok "staged ${size:-?} across ${files} files into re-work/"
dim "git status must stay clean: only README.md and .gitkeep are tracked there"
dim "build with: docker build -f Dockerfile.pi -t pi-agent:latest ."
