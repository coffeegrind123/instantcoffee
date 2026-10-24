#!/usr/bin/env python3
"""Build the two plain-text corpora a weights-axis KLD run scores.

    python kld_corpus.py --out /captures/corpus/kld-weights

writes `code.txt`, `prose.txt` and `corpus.json` (every source URL, its
sha256, and the sha256 of each output) into --out.

Why these two
-------------
ironblock/discipline#334 published the first Qwen3.8-27B KLD ladder on
12 x 4,096-token chunks of C++ source and of wikitext-2, and found prose costs
1.3-1.6x more than code on every quant. Their files are not public, but they
posted short hashes: their `prose.txt` is `173c87a5...` and this script's
prose.txt is `173c87a53759...`, so the prose corpus is the same file and their
prose rows compare directly. Their `code.txt` (`a23ee696...`) is not ours. The
GSQ-RCO IQ3_S arm, which they measured, calibrates the code side: if this
harness lands on their 0.0542 within a standard error, our code rows are
comparable to theirs too.

- **prose**: wikitext-2-raw `wiki.test.raw`, from the URL llama.cpp's own
  scripts/get-wikitext-2.sh uses (read at b11118), so the file is the one every
  published llama.cpp perplexity number is computed on.
- **code**: llama.cpp's own `src/llama-context.cpp` + `src/llama-graph.cpp` at
  the tag this stack pins: real C++, ~297 KB (~90K tokens, nearly twice the
  49,152 a 12-chunk run consumes), and fixed forever by the tag.

Both are written as plain text and are NOT captured sessions, so kld-run.sh
needs `--unpinned` for them. That is correct: there is no server-side token
count to pin them to.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile
from typing import Callable

WIKITEXT_URL = "https://huggingface.co/datasets/ggml-org/ci/resolve/main/wikitext-2-raw-v1.zip"
WIKITEXT_MEMBER = "wikitext-2-raw/wiki.test.raw"
LLAMA_TAG = "b11118"
CODE_FILES = ("src/llama-context.cpp", "src/llama-graph.cpp")
RAW = "https://raw.githubusercontent.com/ggml-org/llama.cpp/{tag}/{path}"

# 12 chunks x 4,096 tokens, and the run needs the whole of each chunk.
MIN_TOKENS = 12 * 4096
# Conservative chars/token for refusing an obviously short corpus before a GPU
# run finds out. Code tokenizes denser than this; prose about the same.
CHARS_PER_TOKEN_FLOOR = 3

Fetch = Callable[[str], bytes]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def http_get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def build(fetch: Fetch, tag: str = LLAMA_TAG) -> tuple[bytes, bytes, dict]:
    sources = []

    parts = []
    for path in CODE_FILES:
        url = RAW.format(tag=tag, path=path)
        data = fetch(url)
        sources.append({"url": url, "sha256": sha256(data), "bytes": len(data)})
        parts.append(data)
    code = b"\n".join(parts)

    blob = fetch(WIKITEXT_URL)
    sources.append({"url": WIKITEXT_URL, "sha256": sha256(blob), "bytes": len(blob)})
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        prose = z.read(WIKITEXT_MEMBER)

    for name, data in (("code", code), ("prose", prose)):
        if len(data) < MIN_TOKENS * CHARS_PER_TOKEN_FLOOR:
            raise ValueError(
                f"{name} corpus is {len(data):,} bytes; a {MIN_TOKENS:,}-token run needs "
                f"at least ~{MIN_TOKENS * CHARS_PER_TOKEN_FLOOR:,}"
            )

    meta = {
        "llama_tag": tag,
        "sources": sources,
        "outputs": {
            "code.txt": {"sha256": sha256(code), "bytes": len(code)},
            "prose.txt": {"sha256": sha256(prose), "bytes": len(prose)},
        },
    }
    return code, prose, meta


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", default=LLAMA_TAG)
    args = ap.parse_args(argv)

    try:
        code, prose, meta = build(http_get, args.tag)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as e:
        print(f"kld_corpus: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    for name, data in (("code.txt", code), ("prose.txt", prose)):
        with open(os.path.join(args.out, name), "wb") as f:
            f.write(data)
    with open(os.path.join(args.out, "corpus.json"), "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    for name, o in meta["outputs"].items():
        print(f"{name:10s} {o['bytes']:>10,} bytes  sha256 {o['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
