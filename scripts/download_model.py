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
import time
from pathlib import Path

DEST = Path("/models")


def _human(num_bytes: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} PiB"


# A ~18 GB pull over a slow link will meet a dropped connection sooner or later,
# and a stall that never raises is worse than an error. Retry around it — each
# attempt resumes from the .incomplete file rather than starting over.
MAX_ATTEMPTS = int(os.environ.get("DOWNLOAD_ATTEMPTS", "12"))


def _remote_meta(repo: str, filename: str, token: str | None):
    """(size, sha256) the Hub currently serves for this path, or (None, None).

    Never raises: a stale local file is a quality problem, but an unreachable
    Hub must not stop an otherwise working stack from starting.
    """
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo, files_metadata=True, token=token or None)
        for sib in info.siblings or []:
            if sib.rfilename == filename:
                lfs = getattr(sib, "lfs", None)
                oid = None
                if lfs is not None:
                    oid = lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)
                return getattr(sib, "size", None), oid
    except Exception as exc:  # noqa: BLE001 - advisory only
        print(f"[warn] could not read remote metadata for {filename}: "
              f"{type(exc).__name__}: {exc}")
    return None, None


def fetch(repo: str, filename: str, token: str | None) -> Path:
    from huggingface_hub import hf_hub_download

    target = DEST / filename
    if target.exists():
        local_size = target.stat().st_size
        # Presence is NOT proof of currency. Repos re-upload under the same
        # filename: unsloth/Qwen3.8-27B-GGUF replaced every UD-* file in place
        # on 2026-08-19 for Dynamic V3, same names, different bytes. Skipping on
        # name alone silently pins the stack to whatever it downloaded first.
        remote_size, _ = _remote_meta(repo, filename, token)
        if remote_size is not None and remote_size != local_size:
            print(f"[stale] {filename} is {_human(local_size)} locally but "
                  f"{_human(remote_size)} on the Hub — the file was replaced "
                  f"upstream.")
            if os.environ.get("REDOWNLOAD_STALE", "").strip() not in ("1", "true", "yes"):
                print("[stale] keeping the local copy. Set REDOWNLOAD_STALE=1 "
                      "to replace it (and expect a full re-transfer).")
                return target
            backup = target.with_suffix(target.suffix + ".superseded")
            print(f"[stale] REDOWNLOAD_STALE set — moving the old file to "
                  f"{backup.name} and re-fetching.")
            if backup.exists():
                backup.unlink()
            target.rename(backup)
        else:
            if remote_size is None:
                print(f"[skip] {filename} already present ({_human(local_size)}) "
                      f"— remote size unknown, currency NOT checked")
            else:
                print(f"[skip] {filename} already present and current "
                      f"({_human(local_size)})")
            return target

    print(f"[get ] {repo} :: {filename}")
    # Download into a cache dir on the same volume, then move into place. The
    # move is what makes presence of the final path mean "complete" — a killed
    # transfer leaves a blob behind, never a truncated model file.
    cached = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            cached = hf_hub_download(
                repo_id=repo,
                filename=filename,
                cache_dir=str(DEST / ".hf-cache"),
                token=token or None,
            )
            break
        except Exception as exc:
            if attempt == MAX_ATTEMPTS:
                raise
            wait = min(60, 5 * attempt)
            print(f"[retry] attempt {attempt}/{MAX_ATTEMPTS} failed: "
                  f"{type(exc).__name__}: {exc}")
            print(f"[retry] resuming in {wait}s")
            time.sleep(wait)

    assert cached is not None
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
