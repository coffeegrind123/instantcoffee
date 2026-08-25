#!/usr/bin/env python3
"""Standalone unit tests for download_model.py's content verification.

    python3 scripts/test_download_verify.py

WHY THIS EXISTS

The thing being tested is a guard that only fires on a bad download, which is
precisely the case you cannot reach by running the real script on a good one.
Exercising it against the actual 17 GB GGUF would prove the happy path and
nothing else, at the cost of a full-file read per run. So the fixtures here are
a few bytes each and the interesting cases are the failures.

The case that matters most is SIZE MATCHES BUT CONTENT DOES NOT. Before
2026-08-25 the script compared sizes only — it fetched the Hub's LFS oid (which
IS a sha256) and threw it away — so that case passed silently and the stack
pinned itself to whatever bytes it happened to have.
"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# download_model.py writes to /models at import time only via constants, so it
# is safe to import here without the volume mounted.
import download_model as dm  # noqa: E402

FAILURES: list[str] = []
PASSES = 0


def check(name: str, got, want) -> None:
    global PASSES
    if got == want:
        PASSES += 1
    else:
        FAILURES.append(f"{name}: got {got!r}, want {want!r}")


def tmpfile(body: bytes) -> Path:
    fh = tempfile.NamedTemporaryFile(delete=False, suffix=".gguf")
    fh.write(body)
    fh.close()
    return Path(fh.name)


def main() -> int:
    body = b"gguf pretend weights" * 64
    sha = hashlib.sha256(body).hexdigest()
    size = len(body)
    p = tmpfile(body)

    # --- _sha256 agrees with hashlib, including across the chunk loop --------
    check("_sha256 matches hashlib", dm._sha256(p, "t"), sha)

    big = tmpfile(b"x" * (5 * 1024 * 1024))
    check("_sha256 on a multi-chunk file",
          dm._sha256(big, "t"), hashlib.sha256(b"x" * (5 * 1024 * 1024)).hexdigest())

    # --- the happy path ------------------------------------------------------
    check("size+sha both match -> ok", dm._verify(p, size, sha, "t.gguf"), True)

    # --- THE case size-only comparison could never catch ---------------------
    wrong = hashlib.sha256(b"different bytes entirely").hexdigest()
    check("size matches but sha does NOT -> reject",
          dm._verify(p, size, wrong, "t.gguf"), False)

    # --- ordinary staleness --------------------------------------------------
    check("size mismatch -> reject", dm._verify(p, size + 1, sha, "t.gguf"), False)
    check("size mismatch wins even with a good sha",
          dm._verify(p, size + 1, sha, "t.gguf"), False)

    # --- degraded metadata is 'cannot tell', never 'failed' ------------------
    check("no remote metadata at all -> tolerate",
          dm._verify(p, None, None, "t.gguf"), True)
    check("size known, no sha published -> tolerate",
          dm._verify(p, size, None, "t.gguf"), True)

    # --- the escape hatch ----------------------------------------------------
    os.environ["SKIP_HASH_CHECK"] = "1"
    try:
        check("SKIP_HASH_CHECK bypasses the hash but keeps the size check",
              dm._verify(p, size, wrong, "t.gguf"), True)
        check("SKIP_HASH_CHECK does NOT bypass a size mismatch",
              dm._verify(p, size + 1, wrong, "t.gguf"), False)
    finally:
        del os.environ["SKIP_HASH_CHECK"]

    # --- a verified file is recorded for versions.lock, a skipped one is not --
    dm.VERIFIED.clear()
    dm._verify(p, size, sha, "recorded.gguf")
    check("verified file is recorded", dm.VERIFIED.get("recorded.gguf"), sha)

    dm.VERIFIED.clear()
    dm._verify(p, size, None, "unhashed.gguf")
    check("file with no published sha is NOT recorded",
          "unhashed.gguf" in dm.VERIFIED, False)

    os.environ["SKIP_HASH_CHECK"] = "1"
    try:
        dm.VERIFIED.clear()
        dm._verify(p, size, sha, "skipped.gguf")
        check("file skipped by SKIP_HASH_CHECK is NOT recorded",
              "skipped.gguf" in dm.VERIFIED, False)
    finally:
        del os.environ["SKIP_HASH_CHECK"]

    for f in (p, big):
        f.unlink(missing_ok=True)

    total = PASSES + len(FAILURES)
    if FAILURES:
        print(f"{PASSES}/{total} passed — FAILURES:")
        for f in FAILURES:
            print(f"  {f}")
        return 1
    print(f"{PASSES}/{total} passed — all good")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
