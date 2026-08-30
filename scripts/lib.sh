#!/usr/bin/env bash
# Shared helpers. Sourced by every script in this directory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

# --- output ------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m';  C_OFF=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_DIM=""; C_OFF=""
fi

info()  { printf '%s==>%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()    { printf '%s  ok%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn()  { printf '%swarn%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()   { printf '%serr %s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
dim()   { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "'$c' is required but not on PATH"
  done
}

# --- compose -----------------------------------------------------------------
# Always run compose from the repo root with .env, plus .env.local when present
# so machine-specific overrides never have to be committed.
compose() {
  local env_files=".env"
  [[ -f "$REPO_ROOT/.env.local" ]] && env_files=".env,.env.local"
  ( cd "$REPO_ROOT" && COMPOSE_ENV_FILES="$env_files" docker compose "$@" )
}

# Read one key out of the merged env, honouring .env.local overrides.
#
# An exported variable wins over both files, so a per-invocation override works
# the way anyone would expect it to:
#     PI_CONTEXT_FILES=1 ./scripts/pi-local.sh
# It previously did not — the value was read from .env only and the override was
# ignored in silence, which is the worst way for a knob to not work. This also
# matches how docker compose already resolves the same names.
env_get() {
  local key="$1" val=""
  if [[ -n "${!key+x}" ]]; then printf '%s' "${!key}"; return 0; fi
  for f in "$REPO_ROOT/.env" "$REPO_ROOT/.env.local"; do
    [[ -f "$f" ]] || continue
    local line
    line="$(grep -E "^[[:space:]]*${key}=" "$f" | tail -n1 || true)"
    [[ -n "$line" ]] && val="${line#*=}"
  done
  # Strip surrounding quotes and trailing comment/whitespace.
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

# Rewrite a key in .env in place, preserving comments and ordering.
env_set() {
  local key="$1" value="$2" file="$REPO_ROOT/.env"
  grep -qE "^[[:space:]]*${key}=" "$file" \
    || die "key '$key' not found in .env — refusing to append blindly"
  # '|' as the sed delimiter: values here are versions and tags, never paths.
  sed -i -E "s|^([[:space:]]*${key}=).*$|\1${value}|" "$file"
}

# The llama server image. LLAMA_IMAGE wins when set; otherwise the upstream
# ggml-org repository plus LLAMA_TAG, which is what every caller hardcoded
# before this existed and is therefore the unchanged default.
#
# Centralised because it was written out three times, and the copy that mattered
# was the one in capacity-probe.sh's gpu_mem_idle(): it pulls the image to read
# the device with llama stopped, and a pull that FAILS there returns an empty
# string rather than an error, which lands in the results JSON as an empty
# vram_idle_mib and makes every delta in that run meaningless.
llama_image() {
  local img; img="$(env_get LLAMA_IMAGE)"
  if [[ -n "$img" ]]; then printf '%s' "$img"; return 0; fi
  local tag; tag="$(env_get LLAMA_TAG)"; : "${tag:=server-cuda-b10689}"
  printf 'ghcr.io/ggml-org/llama.cpp:%s' "$tag"
}

# --- system-prompt fragments -------------------------------------------------
# Path of the prompt fragment selected by THINK_LANG, or nothing when off.
#
# This is client-side on purpose, and not by preference: llama-server's -sys is
# registered only for the completion/cli/diffusion/mtmd examples (verified in
# common/arg.cpp at b10200 — LLAMA_EXAMPLE_SERVER is absent and server.cpp never
# reads params.system_prompt), and forge 0.8.2 has no system-prompt flag at all.
# The launchers are the only place left that can do it. See prompts/README.md.
think_prompt_path() {
  local lang; lang="$(env_get THINK_LANG)"
  [[ -z "$lang" || "$lang" == "off" ]] && return 0
  local p="$REPO_ROOT/prompts/think-${lang}.md"
  # Loud rather than silent: a system prompt that fails to load changes how the
  # agent behaves without changing anything you can see.
  [[ -r "$p" ]] || die "THINK_LANG=$lang but $p is missing or unreadable"
  printf '%s' "$p"
}

# --- pi's agent directory ----------------------------------------------------
# AO10, twenty-fifth pass. Where pi keeps models.json, settings.json, sessions/
# and channels/. `pi-local.sh` asked this question in FOUR places and answered it
# two ways: `PI_DIR` at the top ignored the override while the prinny state path
# and the MCP adapter path honoured it. On a relocated install the launcher then
# wrote `models.json` and `settings.json` into a directory pi does not read, so
# pi started with **no `forge` provider at all** — the local model unreachable,
# which is the one thing this script exists to arrange.
#
# The rule is pi's own `getAgentDir()` (`dist/config.js`), and it is the same
# rule `vendor/pi-subagents-lite/src/agent-dir.ts` writes for the TypeScript
# side, kept in step deliberately — see AN7 and AO7. Note the guard is a bare
# truthiness test, not `-n` after trimming: a value of "  " is a relative
# directory to pi, and where the two disagree pi is right by definition, because
# pi is the one that writes the files.
agent_dir() {
  local override="${PI_CODING_AGENT_DIR:-}"
  if [[ -n "$override" ]]; then
    # pi runs the value through `expandTildePath`, so a value that works for pi
    # has to work here. `~` and `~/…` only; anything else is left alone.
    if [[ "$override" == "~" ]]; then
      printf '%s' "$HOME"
    elif [[ "$override" == "~/"* ]]; then
      printf '%s/%s' "$HOME" "${override#\~/}"
    else
      printf '%s' "$override"
    fi
    return 0
  fi
  printf '%s/.pi/agent' "$HOME"
}

# --- json --------------------------------------------------------------------
# Prefer host python3; fall back to a throwaway container so the scripts work on
# a machine that has Docker but no Python.
json_eval() {
  local code="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "$code"
  else
    docker run --rm -i python:3.13-slim python -c "$code"
  fi
}

# --- registry ----------------------------------------------------------------
# Anonymous pull token for a public ghcr repository.
ghcr_token() {
  curl -fsSL "https://ghcr.io/token?scope=repository:$1:pull&service=ghcr.io" \
    | json_eval 'import sys,json; print(json.load(sys.stdin)["token"])'
}

GHCR_ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'

# Latest llama.cpp build number behind the floating :server-cuda tag.
# ggml-org stamps the build (e.g. b10200) into the index annotations, which is
# both cheaper and more reliable than paging the tag list.
llama_latest_build() {
  local repo="ggml-org/llama.cpp" tok
  tok="$(ghcr_token "$repo")"
  curl -fsSL -H "Authorization: Bearer $tok" -H "Accept: $GHCR_ACCEPT" \
    "https://ghcr.io/v2/$repo/manifests/server-cuda" \
    | json_eval 'import sys,json; print(json.load(sys.stdin).get("annotations",{}).get("org.opencontainers.image.version",""))'
}

# Digest of a given tag, for the lock file.
llama_tag_digest() {
  local repo="ggml-org/llama.cpp" tok
  tok="$(ghcr_token "$repo")"
  curl -fsSI -H "Authorization: Bearer $tok" -H "Accept: $GHCR_ACCEPT" \
    "https://ghcr.io/v2/$repo/manifests/$1" \
    | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:"{print $2}'
}

# Does this tag exist?
llama_tag_exists() {
  local repo="ggml-org/llama.cpp" tok code
  tok="$(ghcr_token "$repo")"
  code="$(curl -fsS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $tok" -H "Accept: $GHCR_ACCEPT" \
    "https://ghcr.io/v2/$repo/manifests/$1" 2>/dev/null || true)"
  [[ "$code" == "200" ]]
}

forge_latest_version() {
  curl -fsSL "https://pypi.org/pypi/forge-guardrails/json" \
    | json_eval 'import sys,json; print(json.load(sys.stdin)["info"]["version"])'
}

# --- huggingface -------------------------------------------------------------
# Content hash of one file in a model repo, so a re-uploaded quant is visible.
# unsloth revises quants in the weeks after a release (2026-08-11 HN thread,
# Aurornis), and nothing in this repo would otherwise notice: GGUF_FILE pins a
# *name*, and the name does not change when the bytes behind it do.
#
# REPORT ONLY. This never downloads anything and is never wired into the
# downloader — scripts/download_model.py returns early whenever the target file
# already exists, and an 18 GB refetch is a decision for a human to make.
#
# Echoes "<lfs-sha256> <repo-lastModified>", or nothing when the API is
# unreachable or the file is not in the repo.
hf_file_revision() {
  local repo="$1" file="$2"
  curl -fsSL --max-time 20 "https://huggingface.co/api/models/${repo}?blobs=true" 2>/dev/null \
    | HF_FILE="$file" json_eval '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
want = os.environ["HF_FILE"]
for s in d.get("siblings") or []:
    if s.get("rfilename") == want:
        sha = (s.get("lfs") or {}).get("sha256", "")
        if sha:
            print(sha, d.get("lastModified", ""))
        raise SystemExit(0)
' 2>/dev/null || true
}

# Value of a key in versions.lock ("key = value" lines), or nothing.
lock_get() {
  local key="$1" file="$REPO_ROOT/versions.lock"
  [[ -f "$file" ]] || return 0
  awk -v k="$key" -F= '
    $1 ~ "^[[:space:]]*"k"[[:space:]]*$" {
      sub(/^[[:space:]]+/, "", $2); sub(/[[:space:]]+$/, "", $2); print $2; exit
    }' "$file"
}

# Set ONE field in versions.lock, in place, preserving everything else.
#
# WHY THIS EXISTS. update.sh used to rewrite versions.lock from a here-doc
# template, and that template was the WHOLE file — so every hand-recorded block
# in it (spec_verdict, depth_ppl, tool_grammar, kv_alt, the model rollback
# hashes, ~900 lines of measurement that cost days of GPU time) was destroyed on
# any update. The file's own header admitted this had already happened twice,
# which made the documented "just run update.sh" path the most destructive
# command in the repo. Nobody should have to know that. So the writer changed
# rather than the warning getting louder.
#
# Continuation lines — the indented prose under a key — are PRESERVED, not
# rewritten, because they are hand-written. That means they can now describe a
# value that has just changed, so update.sh reports which keys carry prose for a
# human to re-read. Preserving something stale and saying so beats deleting
# something irreplaceable and not.
lock_set() {
  local key="$1" file="$REPO_ROOT/versions.lock"
  local tmp; tmp="$(mktemp)"
  LOCK_VAL="$2" awk -v k="$key" '
    # The key line is `key<pad>= value`. Replace only what follows the "= ",
    # keeping the original alignment so the file stays column-aligned.
    !done && $0 ~ "^[[:space:]]*"k"[[:space:]]*=" {
      match($0, /^[^=]*=[ ]?/)
      printf "%s%s\n", substr($0, 1, RLENGTH), ENVIRON["LOCK_VAL"]
      done = 1
      next
    }
    { print }
    END { if (!done) printf "%-20s= %s\n", k, ENVIRON["LOCK_VAL"] }
  ' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file"
}

# Does this key carry hand-written continuation prose beneath it?
# Used to tell the operator which preserved blocks may now be stale.
lock_has_prose() {
  local key="$1" file="$REPO_ROOT/versions.lock"
  [[ -f "$file" ]] || return 1
  awk -v k="$key" '
    $0 ~ "^[[:space:]]*"k"[[:space:]]*=" { inkey = 1; next }
    inkey && /^[[:space:]]+[^[:space:]]/ { found = 1; exit }
    inkey { exit }
    END { exit !found }
  ' "$file"
}


# --------------------------------------------------------------------------
# Stack provenance: WHICH engine and WHICH weights produced a measurement.
#
# spec-sweep.sh has stamped this since 2026-08-22, because two six-day-old
# result files from a different build sat in its results directory printing as
# though they were current. capacity-probe.sh stamped nothing at all — its
# result JSONs carry a label, a settings delta and a timestamp, so a row taken
# on the pre-V3 weights at b10200 prints identically to one taken today. That
# is the same shape of gap, one script over, and it is unfixable in hindsight:
# provenance can only be captured at measurement time.
#
# This is the part of the pin set that is INVARIANT across one invocation —
# the engine image and the weights on disk. Per-config values (ctx size, KV
# type) deliberately live with the caller, because capacity-probe.sh rewrites
# .env between configs and a memoized ctx_size would report the first config's
# window for every row after it.
capture_stack_pins() {
  if [[ -n "${STACK_PINS_JSON:-}" ]]; then printf '%s' "$STACK_PINS_JSON"; return 0; fi

  local tag models gguf image digest st size mtime
  tag="$(env_get LLAMA_TAG)"
  models="$(env_get MODELS_DIR)"
  gguf="$(env_get GGUF_FILE)"
  image="$(llama_image)"

  # llama_tag CARRIES THE WHOLE IMAGE REFERENCE WHEN A FORK IS IN USE, and the
  # bare tag otherwise. This function used to build the image name from a
  # hardcoded ggml-org repository, which meant a probe running a FORK looked up
  # the UPSTREAM image's digest and stamped it into the results — a provenance
  # field that positively asserts the wrong engine is worse than no field, and
  # it is the same mixed-provenance trap the pin set exists to stop.
  #
  # The KEY SET is deliberately unchanged so every result file written before
  # this still compares as the same stack; only the VALUE widens, and it widens
  # only when LLAMA_IMAGE is set, which no upstream run does.
  [[ -n "$(env_get LLAMA_IMAGE)" ]] && tag="$image"

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
  #
  # size+mtime rather than a hash: hashing 17.5 GB over a 9p mount takes
  # minutes, and the failure this catches is "the weights were swapped", which
  # moves both.
  st="$(docker run --rm --entrypoint sh -v "$models:/models:ro" "$image" \
          -c "stat -c '%s %Y' '/models/$gguf'" 2>/dev/null || true)"
  size="${st%% *}"; mtime="${st##* }"
  [[ "$size" == "$st" ]] && { size=""; mtime=""; }

  STACK_PINS_JSON="$(jq -nc \
    --arg tag "$tag" --arg digest "$digest" \
    --arg repo "$(env_get MODEL_REPO)" --arg gguf "$gguf" \
    --arg size "$size" --arg mtime "$mtime" \
    '{llama_tag:$tag, llama_digest:$digest,
      model_repo:$repo, gguf_file:$gguf,
      gguf_size:$size, gguf_mtime:$mtime}')"
  printf '%s' "$STACK_PINS_JSON"
}

# Print only the keys that differ, so a mismatch names the cause instead of
# dumping two JSON blobs and leaving the reader to spot the one changed field.
pin_diff() {
  jq -rn --argjson a "$1" --argjson b "$2" '
    ($a + $b | keys_unsorted[]) as $k
    | select(($a[$k] // "") != ($b[$k] // ""))
    | "      \($k): \($a[$k] // "-")  ->  \($b[$k] // "-")"' | sort -u
}


# --- gguf --------------------------------------------------------------------
# n_vocab, from the GGUF's own metadata.  Shared by kld-run.sh and
# ppl-stride-run.sh:  gguf_n_vocab <models_dir> <gguf_file> <sidecar_image>
#
# Everything that bounds these experiments' host-memory cost is n_ctx * n_vocab,
# so n_vocab has to be a fact rather than a remembered constant. GGUF puts its
# metadata key-value block at the head of the file and `tokenizer.ggml.tokens`
# early within it, so this reads under 2 KB and stops at the array's count — it
# never touches the token strings, let alone the tensors.
#
# `llama_vocab_n_tokens()` is exactly the length of that array, which is the
# same number perplexity writes into the logits file's header — so verify_logits
# later re-states it from an independent source, and a disagreement would show.
gguf_n_vocab() {
  local models="$1" gguf="$2" sidecar="$3"
  docker run --rm -i --user 0:0 -v "${models}:/models:ro" \
      --entrypoint python "$sidecar" - "/models/${gguf}" <<'GGUFPY' 2>&1
import struct, sys
FIXED = {0:1, 1:1, 2:2, 3:2, 4:4, 5:4, 6:4, 7:1, 10:8, 11:8, 12:8}
T_STR, T_ARR = 8, 9
try:
    f = open(sys.argv[1], "rb")
    if f.read(4) != b"GGUF":
        print("not a GGUF file"); sys.exit(1)
    _ver, _ntensors, nkv = struct.unpack("<IQQ", f.read(20))
    u32 = lambda: struct.unpack("<I", f.read(4))[0]
    u64 = lambda: struct.unpack("<Q", f.read(8))[0]
    st  = lambda: f.read(u64())
    def skip(t):
        if t in FIXED: f.read(FIXED[t])
        elif t == T_STR: st()
        elif t == T_ARR:
            et, n = u32(), u64()
            if et in FIXED: f.read(FIXED[et] * n)
            elif et == T_STR:
                for _ in range(n): st()
            else: raise ValueError("array of metadata type %d" % et)
        else: raise ValueError("metadata type %d" % t)
    for _ in range(nkv):
        key = st().decode("utf-8", "replace")
        t = u32()
        if key == "tokenizer.ggml.tokens" and t == T_ARR:
            u32(); print(u64()); sys.exit(0)
        skip(t)
    print("tokenizer.ggml.tokens not present in the metadata"); sys.exit(1)
except Exception as e:
    print("%s: %s" % (type(e).__name__, e)); sys.exit(1)
GGUFPY
}
