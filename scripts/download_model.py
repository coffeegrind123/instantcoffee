#!/usr/bin/env python3
"""Fetch the GGUF (and optional vision projector) into the models volume.

Runs inside the forge image via `docker compose --profile tools run --rm
downloader`, so the host needs no Python and no huggingface CLI.

Downloads are resumable and content-addressed by the Hub, so re-running after an
interrupted transfer continues rather than restarting, and re-running when the
file is already complete is a cheap no-op.
"""

from __future__ import annotations

import hashlib
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


# filename -> sha256, filled in by _verify. main() prints these in a shape that
# can be pasted straight into versions.lock, because the alternative is hashing
# a 17 GB file by hand afterwards and typing the result in — which is exactly
# how prose_model_size came to hold the wrong model's byte count on 2026-08-25.
VERIFIED: dict[str, str] = {}


def _sha256(path: Path, label: str) -> str:
    """SHA-256 of a local file, streamed.

    A ~17 GB read, so it is worth what it costs only because the alternative is
    trusting a size match. The Hub hands us the LFS oid for free and that oid IS
    a sha256, so verifying is a comparison rather than a leap of faith. Sizes
    collide; content hashes do not.
    """
    h = hashlib.sha256()
    seen = 0
    total = path.stat().st_size
    with open(path, "rb") as fh:
        while chunk := fh.read(16 * 1024 * 1024):
            h.update(chunk)
            seen += len(chunk)
            if total and seen % (2 * 1024 * 1024 * 1024) < 16 * 1024 * 1024:
                print(f"[hash] {label}: {100 * seen // total}%", flush=True)
    return h.hexdigest()


def _verify(target: Path, remote_size, remote_sha, filename: str) -> bool:
    """Does the local file match what the Hub serves? Loud about WHY it does not.

    Returns False only for a definite mismatch. An unreachable Hub (both values
    None) is reported and treated as "cannot tell", never as a failure — the
    same reasoning as _remote_meta.
    """
    local_size = target.stat().st_size
    if remote_size is None and remote_sha is None:
        print(f"[warn] {filename}: no remote metadata — currency NOT checked")
        return True
    if remote_size is not None and remote_size != local_size:
        print(f"[stale] {filename} is {_human(local_size)} locally but "
              f"{_human(remote_size)} on the Hub — the file was replaced upstream.")
        return False
    if remote_sha:
        if os.environ.get("SKIP_HASH_CHECK", "").strip() in ("1", "true", "yes"):
            print(f"[skip] {filename}: SKIP_HASH_CHECK set — size matched, content NOT verified")
            return True
        print(f"[hash] verifying {filename} against the Hub's LFS oid "
              f"({_human(local_size)} to read)...")
        local_sha = _sha256(target, filename)
        if local_sha != remote_sha:
            print(f"[BAD ] {filename}: SIZE MATCHES BUT CONTENT DOES NOT.")
            print(f"[BAD ]   local  {local_sha}")
            print(f"[BAD ]   remote {remote_sha}")
            return False
        VERIFIED[filename] = local_sha
        print(f"[ok  ] {filename} sha256 {local_sha}")
    else:
        print(f"[warn] {filename}: Hub published no sha256 — size matched, "
              f"content NOT verified")
    return True


def fetch(repo: str, filename: str, token: str | None) -> Path:
    from huggingface_hub import hf_hub_download

    target = DEST / filename
    remote_size, remote_sha = _remote_meta(repo, filename, token)
    if target.exists():
        # Presence is NOT proof of currency. Repos re-upload under the same
        # filename: unsloth/Qwen3.8-27B-GGUF replaced every UD-* file in place
        # on 2026-08-19 for Dynamic V3, same names, different bytes. Skipping on
        # name alone silently pins the stack to whatever it downloaded first.
        #
        # Nor is a size match proof of CONTENT. The Hub hands us the LFS oid,
        # which is a sha256, so the strong check costs a read rather than a
        # round trip — and a re-upload that happens to preserve the byte count
        # would sail past a size-only comparison.
        if _verify(target, remote_size, remote_sha, filename):
            print(f"[skip] {filename} already present and verified "
                  f"({_human(target.stat().st_size)})")
            return target
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

    # Verify what we just wrote, not what we hoped we wrote. A transfer that
    # ends early still gets moved into place by the line above, and without
    # this the only symptom is llama-server failing to load a file this script
    # already called "[done]".
    if not _verify(target, remote_size, remote_sha, filename):
        raise RuntimeError(
            f"{filename} does not match the Hub after download — the file on "
            f"disk is wrong, not merely stale. It has been left in place for "
            f"inspection; delete it and re-run to retry."
        )
    print(f"[done] {target} ({_human(target.stat().st_size)})")
    return target


def main() -> int:
    repo = os.environ.get("MODEL_REPO", "").strip()
    gguf = os.environ.get("GGUF_FILE", "").strip()
    mmproj = os.environ.get("MMPROJ_FILE", "").strip()
    token = os.environ.get("HF_TOKEN", "").strip()

    # The speculative DRAFT model, for the draft-* spec types that need a second
    # file on disk (draft-dflash, draft-dspark, draft-eagle3, draft-simple).
    # Empty for draft-mtp, which reads its head out of the main GGUF, and for
    # the ngram-* types, which need no model at all.
    draft_repo = os.environ.get("DRAFT_MODEL_REPO", "").strip()
    draft_gguf = os.environ.get("DRAFT_GGUF_FILE", "").strip()

    if not repo or not gguf:
        print("MODEL_REPO and GGUF_FILE must be set", file=sys.stderr)
        return 2

    # Half a draft pin is worse than none: a repo with no filename silently
    # fetches nothing, and a filename with no repo would be looked for in the
    # TARGET's repo, where a near-namesake may well exist and load.
    if bool(draft_repo) != bool(draft_gguf):
        print("DRAFT_MODEL_REPO and DRAFT_GGUF_FILE must be set together "
              f"(repo={draft_repo!r}, file={draft_gguf!r})", file=sys.stderr)
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

    # Tracked so the versions.lock block below can label the draft's hash under
    # its own keys instead of emitting a second, ambiguous `model_file` line.
    draft_names: set[str] = set()
    if draft_gguf:
        fetch(draft_repo, draft_gguf, token)
        draft_names.add(draft_gguf)
    else:
        print("[skip] DRAFT_GGUF_FILE empty — no speculative draft model")

    # The blob cache is a full second copy of every file downloaded this run.
    cache = DEST / ".hf-cache"
    if cache.exists():
        shutil.rmtree(cache, ignore_errors=True)
        print("[info] pruned download cache")

    print("\nModels in place:")
    for f in sorted(DEST.glob("*.gguf")):
        print(f"  {f.name:<46} {_human(f.stat().st_size)}")

    if VERIFIED:
        print("\nFor versions.lock — verified against the Hub's LFS oid this run:")
        print(f"  model_repo          = {repo}")
        for name, sha in VERIFIED.items():
            if name in draft_names:
                continue
            size = (DEST / name).stat().st_size
            print(f"  model_file          = {name}")
            print(f"  model_file_size     = {size}")
            print(f"  model_file_sha256   = {sha}")
        for name in sorted(draft_names & VERIFIED.keys()):
            size = (DEST / name).stat().st_size
            print(f"  draft_model_repo    = {draft_repo}")
            print(f"  draft_model_file    = {name}")
            print(f"  draft_model_size    = {size}")
            print(f"  draft_model_sha256  = {VERIFIED[name]}")
    else:
        print("\n[warn] nothing was content-verified this run — the Hub published "
              "no sha256, was unreachable, or SKIP_HASH_CHECK was set. Do NOT "
              "record a hash in versions.lock from this run.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
