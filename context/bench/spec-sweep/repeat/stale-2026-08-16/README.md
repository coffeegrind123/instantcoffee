Results from 2026-08-16, quarantined on 2026-08-22.

These predate three changes and are NOT comparable with the files one level up:
llama.cpp b10200 (not b10573), f16/f16 KV (not q8_0/q8_0), CTX_SIZE 32768 (not
65536), and the pre-Dynamic-V3 weights. `spec-sweep.sh --report` globs the
directory and would have printed them in the same table as today's runs with
nothing marking the difference. Re-run them rather than reading them.
