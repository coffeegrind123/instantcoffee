# Depth-probe results

One `result.json` per `scripts/ppl-depth-run.sh` run, copied out of the run's
`.ppl-depth-logs/<stamp>/` directory — which is gitignored, because a run is a
few hundred KB of tensor warnings and progress output and the numbers that
matter are here and in `context/design/kv-cache-fidelity-measured.md` §3e.

Same convention as `context/bench/capacity/`: the JSON is the machine-readable
record behind a number a document quotes, so a figure can be traced without
re-running an hour of GPU time.

Each file carries, for every arm:

- `ppl` over the **matched token set**, with `scored_tokens` and the window;
- `missed_tokens` — positive when the rotations partition the corpus (the
  multiples of N/2 that no rotation reaches), **negative when they overlap**,
  which a resolving run does deliberately and which means the arm's `ppl` is a
  weighted average rather than the corpus scored once;
- `rotation_spread_pct` — how far apart the rotations of one arm are. They score
  complementary halves at an identical history distribution, so this is the
  scale of a pure token-set effect at maximum disjointness, and it is the
  yardstick every cross-depth claim should be read against;
- `control` — the whole-chunk alignment control, whose verdict is a ratio
  against the log's own four-decimal printing floor rather than a threshold
  anyone picked.

`asymmetry_bound_pct` prices the one way the arms' token sets are not identical:
the misses are nested, so the whole discrepancy is the handful of tokens the
deeper arm scores and the shallower one does not.
