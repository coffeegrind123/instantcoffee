#!/usr/bin/env bash
#
# Fetch a Thireus recipe-built model: 852 per-tensor shards, each pulled at the
# quant level the recipe assigns it.
#
# Runs inside the ik_llama image (docker compose --profile tools run --rm
# ik-downloader). Resumable — quant_downloader.sh checks each shard's hash and
# skips what is already correct, so re-running after an interruption is cheap.

set -euo pipefail

SUITE=/opt/gguf-tool-suite
DEST=/models/ik

MODEL_NAME="${IK_MODEL_NAME:?IK_MODEL_NAME not set}"
RECIPE="${IK_RECIPE:?IK_RECIPE not set}"

# 852 shards against a default limit of 1024 open files is uncomfortably close,
# and the failure mode is a confusing "too many open files" partway through.
ulimit -n 9999 2>/dev/null || echo "[warn] could not raise the open-file limit"

conf="$SUITE/models/$MODEL_NAME/download.conf"
[[ -f "$conf" ]] || { echo "no download.conf for $MODEL_NAME at $conf" >&2; exit 2; }

recipe_path="$SUITE/$RECIPE"
[[ -f "$recipe_path" ]] || { echo "recipe not found: $recipe_path" >&2; exit 2; }

# quant_downloader.sh reads download.conf from its own directory.
cp -f "$conf" "$SUITE/download.conf"

mkdir -p "$DEST"
cd "$DEST"

echo "[info] model   : $MODEL_NAME"
echo "[info] recipe  : $(basename "$RECIPE")"
echo "[info] dest    : $DEST ($(df -h "$DEST" | awk 'NR==2{print $4}') free)"
echo

bash "$SUITE/quant_downloader.sh" "$recipe_path"

echo
echo "[info] shards present: $(find "$DEST" -maxdepth 1 -name '*.gguf' | wc -l)"
first="$(find "$DEST" -maxdepth 1 -name '*-00001-of-*.gguf' | head -1)"
if [[ -n "$first" ]]; then
  echo "[info] first shard   : $(basename "$first")"
  echo "[info] total size    : $(du -sh "$DEST" | cut -f1)"
else
  echo "[warn] no *-00001-of-*.gguf shard found — the download may be incomplete" >&2
  exit 1
fi
