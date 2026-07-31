#!/usr/bin/env python3
"""Fetch the GGUF (and optional vision projector) into the models volume.

Runs inside the forge image via `docker compose --profile tools run --rm
downloader`, so the host needs no Python and no huggingface CLI.

Downloads are resumable and content-addressed by the Hub, so re-running after an
interrupted transfer continues rather than restarting, and re-running when the
file is already complete is a cheap no-op.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

DEST = Path("/models")


def _human(num_bytes: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} PiB"


def fetch(repo: str, filename: str, token: str | None) -> Path:
    from huggingface_hub import hf_hub_download

    target = DEST / filename
    if target.exists():
        print(f"[skip] {filename} already present ({_human(target.stat().st_size)})")
        return target

    print(f"[get ] {repo} :: {filename}")
    # Download into a cache dir on the same volume, then move into place. The
    # move is what makes presence of the final path mean "complete" — a killed
    # transfer leaves a blob behind, never a truncated model file.
    cached = hf_hub_download(
        repo_id=repo,
        filename=filename,
        cache_dir=str(DEST / ".hf-cache"),
        token=token or None,
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    # Resolve the symlink the cache hands back before moving.
    shutil.move(os.path.realpath(cached), target)
    print(f"[done] {target} ({_human(target.stat().st_size)})")
    return target


def main() -> int:
    repo = os.environ.get("MODEL_REPO", "").strip()
    gguf = os.environ.get("GGUF_FILE", "").strip()
    mmproj = os.environ.get("MMPROJ_FILE", "").strip()
    token = os.environ.get("HF_TOKEN", "").strip()

    if not repo or not gguf:
        print("MODEL_REPO and GGUF_FILE must be set", file=sys.stderr)
        return 2

    if not DEST.is_dir():
        print(f"{DEST} is not mounted — check MODELS_DIR in .env", file=sys.stderr)
        return 2

    free = shutil.disk_usage(DEST).free
    print(f"[info] {DEST} has {_human(free)} free")

    fetch(repo, gguf, token)
    if mmproj:
        fetch(repo, mmproj, token)
    else:
        print("[skip] MMPROJ_FILE empty — text-only setup")

    # The blob cache is a full second copy of every file downloaded this run.
    cache = DEST / ".hf-cache"
    if cache.exists():
        shutil.rmtree(cache, ignore_errors=True)
        print("[info] pruned download cache")

    print("\nModels in place:")
    for f in sorted(DEST.glob("*.gguf")):
        print(f"  {f.name:<46} {_human(f.stat().st_size)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
