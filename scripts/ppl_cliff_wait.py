#!/usr/bin/env python3
"""Wait for llama.cpp's --kl-divergence-base token array to land, then exit.

Runs inside the sidecar container, against the /captures mount.

WHY THIS IS A FILE AND NOT `python -c "..."`.

It used to be an interpolated `python -c` string in ppl-cliff-run.sh, with the
logits path substituted by the shell. That means the shell parses the Python
source: a backtick or a `$(...)` anywhere in it becomes command substitution,
and a bare `$name` becomes an empty string. The same trap already fired once in
this repo -- a backtick inside a COMMENT became a substitution and produced
`line 245: sl: command not found`, which landed harmlessly only by luck
(context/OPEN-WORK.md section 4). As a file, the shell parses arguments and
nothing else.

The waiter reads the header for itself rather than being told how big the file
will be: n_chunk is min(n_chunks, corpus / n_ctx), and computing it caller-side
would duplicate perplexity's own arithmetic.

Header layout, little-endian: b"_logits_" then three int32 -- n_ctx, n_vocab,
n_chunk. The token array is n_chunk * n_ctx int32 immediately after it.
"""

import argparse
import os
import struct
import sys
import time

MAGIC = b"_logits_"
HEADER_BYTES = 20


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--path", required=True,
                    help="the --kl-divergence-base file to watch")
    ap.add_argument("--timeout", type=float, default=1800.0,
                    help="seconds to wait before giving up (default: 1800)")
    ap.add_argument("--poll", type=float, default=2.0,
                    help="seconds between checks (default: 2)")
    args = ap.parse_args()

    deadline = time.time() + args.timeout
    head = None

    while time.time() < deadline:
        try:
            size = os.path.getsize(args.path)
        except OSError:
            # Not created yet; perplexity writes the header only once it starts.
            time.sleep(args.poll)
            continue

        if head is None and size >= HEADER_BYTES:
            with open(args.path, "rb") as f:
                raw = f.read(HEADER_BYTES)
            if raw[:8] != MAGIC:
                # Say what actually arrived, not just that it was wrong: a bad
                # header here usually means the flag was dropped or the file is
                # a leftover, and the bytes tell those apart.
                print("BAD HEADER " + raw.hex())
                return 1
            head = struct.unpack("<iii", raw[8:HEADER_BYTES])
            n_ctx, n_vocab, n_chunk = head
            print("    header        n_ctx=%d n_vocab=%d n_chunk=%d -> %d tokens"
                  % (n_ctx, n_vocab, n_chunk, n_chunk * n_ctx))

        if head is not None:
            n_ctx, _n_vocab, n_chunk = head
            want = HEADER_BYTES + n_chunk * n_ctx * 4
            if size >= want:
                print("    array         %d bytes on disk; killing the pass" % size)
                return 0

        time.sleep(args.poll)

    print("TIMED OUT waiting for the token array")
    return 1


if __name__ == "__main__":
    sys.exit(main())
