# Speculative-decoding sweep results

Written by `./scripts/spec-sweep.sh`. Read them with `--report` rather than by
opening the JSON — the report is where the caveats live.

```
./scripts/spec-sweep.sh --workload repeat    --report
./scripts/spec-sweep.sh --workload synthetic --report
./scripts/spec-sweep.sh --pins               # what this box would stamp now
```

## Layout

    synthetic/   bench.py        raw prefill and decode, nonce-randomised
    repeat/      bench_repeat.py the file-rewrite shape pi actually produces

They are namespaced because they measure different things and `--resume` must
never confuse the two. **`repeat` is the one that decides production.** See the
header of `spec-sweep.sh` for why, and for the p-min-before-n-max argument.

## Every file records the stack that produced it

Each `<config>.json` carries a `pins` object — llama.cpp tag and image digest,
context size, both KV cache types, and the weights by size and mtime — plus
`measured_utc`. `--resume` re-runs anything whose pins differ from this box
instead of skipping it, and `--report` refuses to let a mixed table pass as a
comparison.

This exists because it already went wrong. Two 2026-08-16 files (b10200,
f16/f16, 32K, pre-Dynamic-V3) sat in `repeat/` for six days looking current, at
73.8 and 72.2 tok/s — entirely plausible as slow configs. Nothing in the file
said otherwise; an mtime is what caught them. They are now in
`repeat/stale-2026-08-16/`, stamped with their own pins so they say it
themselves.

The weights are pinned by **size and mtime, not sha256**. unsloth replaces
`UD-*` files in place (they did on 2026-08-19 for Dynamic V3), so the filename
proves nothing — but hashing 17.5 GB over a 9p mount costs more than the whole
bench, and size+mtime already separates every generation of that file on disk.

The files that predate pin stamping carry `pins_source:
"backfilled-2026-08-22"`,
and `--report` flags them as reconstructed on every print. The reconstruction is
evidenced — see the 2026-08-22 entry in `context/design/decisions.md` — but it
is not the same thing as a stamp written at run time, and it is not allowed to
look like one.

## Reading the table

`DEC-MEAN`, `DEC-MAX` and `SPREAD` all come out of the same `--repeat` runs.
Read **SPREAD first**: it is max − min within a single config, and if it is
wider than the gap between two rows then those rows are not distinguishable.
On the synthetic workload it reaches 17.3 tok/s, wider than the gaps between the
top four configs — that ranking is noise. Handoffs written before the
2026-08-22 provenance pass quote `DEC-MAX`, which is what this table printed
unlabelled.

`DRAFT/CYCLE` is a property of the drafting rather than of the clock, so it is
the most contention-resistant number here and the one to prefer when decode is
close. `ACCEPT` is a rate, not a goal — it is expected to fall as p-min drops.
