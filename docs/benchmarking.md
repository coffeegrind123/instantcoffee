# Verifying it works, and benchmarking

The smoke test, what CI checks without a GPU, and using `bench.sh` to tune
speculative decoding.

There is no scored eval suite in this repo any more (removed 2026-08-15, with
the 3.8 migration — the 9-suite harness, its committed scorecard, its badges and
the Harbor adapter all went together). Four things verify the stack now, and
each answers a different question:

```bash
./scripts/up.sh                  # start it

./scripts/smoke-test.sh          # does it work end to end, at all
./scripts/bench.sh --full        # how fast, and is MTP paying for itself
./scripts/ab-think-lang.sh       # is THINK_LANG earning its place

./scripts/rtk.sh --check         # do rtk's filters still match the allow-list

# No GPU needed — the same checks CI runs:
python3 scripts/test_repeat_detector.py   # 14 unit tests
python3 scripts/test_cjk_detector.py      # CJK leak detector, both directions
(cd vendor/pi-loop-mode && npm test)      # 39 tests for the /loop fork
(cd vendor/prinny-channel && npm test)    # 296 tests for the Matrix channel
(cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts)
docker compose --profile tools config     # validate compose
```

`rtk.sh --check` is the odd one out: it tests a binary this repo does not own,
because `vendor/rtk-pi`'s allow-list is a set of claims about that binary's
behaviour. It needs no GPU and no stack — only the pinned rtk.

## bench.sh measures the engine, not the proxy

Two ways to get a throughput number that looks fine and means nothing, both of
which this repo has actually shipped:

**Dividing token counts by wall clock.** That measures forge's overhead as if it
were engine throughput. `bench.sh` talks to llama-server directly and reports
`timings.prompt_per_second` / `timings.predicted_per_second`, which llama
measures around the compute itself and forge strips out of the response. The
version this replaced scored the same before and after a fix that made prefill
**~65x faster** — a benchmark that cannot see a 65x regression is worse than
none.

**Reusing a prompt.** `--cache-prompt` is on, so the second run of a fixed
prompt is served from the prefix cache and reports a prefill rate for work it
never did. Every prompt `bench.sh` sends carries a unique nonce **at the front**
(a prefix cache matches from the start, so a trailing nonce would not help), and
any run whose `timings.cache_n` is non-zero is printed as `CACHED (excluded)`
rather than counted.

## Tuning MTP with it

When `SPEC_TYPE=draft-mtp` is on, llama reports `draft_n` and
`draft_n_accepted`, and `bench.sh` prints acceptance per run and in aggregate.
**Do not hand-tune `SPEC_DRAFT_N_MAX` with `bench.sh` — that is the trap this
repo fell into.** Use `./scripts/spec-sweep.sh`, which sweeps the knobs together
and reports the number that tells them apart.

In llama.cpp b10200 the MTP draft loop (`common/speculative.cpp:1520-1670`)
tests the **p-min gate before the n-max gate**. At `p-min=0.75` the second token
survives only if the head's top-1 probability clears 0.75, so the draft is cut
to length 1 on most cycles and `n-max` is never reached — raising it measures a
knob held shut by a different one. That is exactly why the inherited "2 fastest,
3 no better, 4 collapses" result looked settled and was wrong.

The diagnostic is `draft/cycle` = `draft_n / (predicted_n - draft_accepted)`:
near 1.0 at n-max 2 means p-min is truncating; near n-max means n-max is
binding. **Acceptance is not the target** — it falls as p-min drops, and that is
the trade being bought.

```bash
./scripts/spec-sweep.sh --dry-run                    # plan and cost
./scripts/spec-sweep.sh                              # novel text (pessimistic)
./scripts/spec-sweep.sh --workload repeat            # repetitive (agentic)
./scripts/spec-sweep.sh --report                     # re-print, run nothing
```

Run **both** workloads. `bench.sh` nonce-randomises every prompt to defeat the
prefix cache, which also defeats `ngram-simple` — measured on the repeat
workload alone, `ngram-simple` looks like a flat 2× win; measured on novel text
at n-max 2 it *costs* 25%. Only the pair gives the real answer.

If no draft counters appear at all, either `SPEC_TYPE` is empty or the GGUF has
no MTP head — check `block_count`, which must be **65**, not 64.


## Every measurement command

Moved out of the README's day-to-day table on 2026-08-25, where 40-odd rows of
paragraph-length cells had made the everyday commands unfindable.

| Command | What it does |
| --- | --- |
| `./scripts/ab-think-lang.sh` | A/B the `THINK_LANG` prompt before trusting it |
| `./scripts/spec-sweep.sh --dry-run` | Plan the speculative-decoding sweep and price it |
| `./scripts/spec-sweep.sh --only baseline,pmin-050,pmin-040` | Is the MTP draft p-min-bound or n-max-bound |
| `./scripts/spec-sweep.sh --workload repeat` | What `ngram-simple` is worth on repetitive output |
| `./scripts/spec-sweep.sh --report` | Re-print the last sweep's table without running anything — with mean, max and within-config spread, and a provenance block that says whether every row came off one stack |
| `./scripts/spec-sweep.sh --pins` | What build, context size, KV types and weights this box would stamp on a result right now |
| `./scripts/capacity-probe.sh --config 'ctx-96k\|CTX_SIZE=98304' --bench prefill` | Does a launch flag FIT, and what does it cost in VRAM — context window, ngram table size, draft cache type |
| `./scripts/capacity-probe.sh --list` | Re-print the capacity table without running anything — now with within-config SPREAD, SPREAD% and DRAFT/CYCLE, and a provenance footer |
| `python3 scripts/kv_alt_analyse.py` | Compare two launch configs across SEVERAL COLD LOADS, with the LOAD as the unit of replication. `capacity-probe.sh` writes one JSON per config and one config is one cold load, so alternating the arms (`kvalt-a-f16`, `kvalt-a-q8_0`, `kvalt-b-f16`, …) gives several independent loads per arm. Prints the between-load and within-load spreads side by side, because their ratio says whether a one-load-per-arm design could ever have answered the question — which is exactly what `versions.lock:kv_accept_note` says went wrong with its own -2.6 % prefill figure |
| `./scripts/vram-floor.sh` | How much VRAM the Windows desktop is holding, sampled over 15 minutes without stopping llama, and what that leaves for a bigger context window |
| `./scripts/vram-floor.sh --report` | Re-print the last floor capture without re-sampling |
| `./scripts/vram-floor.sh --label active` | Capture under a name of its own, so an idle capture and a busy-desktop one can be compared instead of overwriting each other |
| `./scripts/kld-run.sh --corpus /captures/corpus/deep-s26b5bb.txt --depths 4096 --null-control` | What q8_0 KV actually costs against f16, in KL divergence and top-1 agreement, on a real captured workstream. `--null-control` is not optional the first time: it points the test arm at the base arm's own KV type, so the run compares f16 with f16 and whatever that returns is the instrument's floor. Stops llama for the duration and refuses a depth that would only fit in swap |
| `./scripts/ppl-depth-run.sh --corpus /captures/corpus/deep-s26b5bb.txt` | Does perplexity really degrade with context length on this model, or was the old ladder just scoring different tokens at every depth? Prefixes the corpus with EXACTLY n_ctx/2 tokens of filler so one pass scores the exact complement of another — the union is every corpus token once, at every depth. Reads its own filler length off `llama-perplexity`'s error path before scoring anything, and runs a whole-chunk alignment control as a first-class pass |
| `./scripts/ppl-depth-run.sh --corpus … --depths 8192 --rotations 0,2048,4096,6144` | The within-depth control: four quarter-offset rotations cover each corpus quarter TWICE through two different chunk alignments, which is the only way to tell a property of the content from a property of where the chunk boundary fell |
| `./scripts/ppl-depth-run.sh --analyse-only .ppl-depth-logs/<stamp>` | Re-read a finished depth run — per-arm perplexity on the matched token set, the per-span map, and the alignment control's verdict against the log's own printing floor. Touches no container, so a bad analysis costs nothing to redo |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/bench_quality.py --control` | Prove the quality harness before trusting it: reference implementations must score 5/5 or the grid refuses to run |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/ctx_needle.py --tokens 90000 --control 105000` | Prove a context window is real: a nonce at each end of the document must come back, and a prompt past the limit must be refused by name |
| `./scripts/bench-literal.sh` | Do exact operational literals — a UUID, a commit hash, `GigabitEthernet0/0/1.201`, `page_size=112` — survive from deep context into a TOOL-CALL ARGUMENT? Two controls run first: the identical request at ~2k, so a failure at depth can be told apart from a probe that never worked, and a detection control that re-scores that real response against deliberately wrong expectations, so a clean result cannot come from a probe that is simply blind |
| `docker run --rm --entrypoint python instantcoffee/proxy:${FORGE_VERSION} /work/scripts/test_forge_patches.py` | Do the ten build-time forge patches actually BEHAVE? The patches already fail the build when forge's source moves — that is a check on the input. This drives the patched functions inside the image: content vs reasoning_content on a tool-call turn, a reasoning-only turn surviving, the cross-tool merge staying off and `FORGE_MERGE_ACROSS_TOOLS=1` putting it back, a validation failure with no attempt left raising rather than returning an empty 200, the OpenAI SSE text path carrying the reasoning and the backend's finish_reason, and a backend read timeout on the STREAMING path becoming a clean 408 instead of escaping raw — that last one driven through a fake transport that times out on stream open AND mid-stream, because a guard around only the stream-open would miss the second |
| `./scripts/bench-literal.sh --sweep 2000,16000,48000,90000 --repeat 3` | The same probe as a depth sweep. Reports per-field exact-match rates and classifies each miss — `tail_swap` and `dropped_head` are flipped tokens, `truncated` and `missing` are usually the model declining to copy |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/bench_repeat.py` | Decode speed on repetitive output — the file-rewrite shape pi actually produces |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/bench_tools.py --counts 0,15,100 --repeat 9` | What a large `tools` array costs at DECODE time. The only bench here that sends tool schemas at all — `bench.py` and `bench_repeat.py` send none, so llama builds no tool grammar and a trigger-cost change comes back flat, which reads as "the fix does nothing" rather than "the instrument cannot see it". Every tool arm is paired with a BALLAST arm — no tools, padded with inert prose to the same prompt depth — because a 100-tool request carries ~11.6k extra prompt tokens and decode falls with depth on this model, so a tools-only curve confounds the grammar with the depth. Tool names are salted per run (the tools block renders AHEAD of the user message, so a nonce there does not defeat the prefix cache: `cache_n` reached 10603 before this), tool-call responses are excluded rather than averaged in, and warmups are discarded. Do not run it below `--repeat 9`: an n=3 pilot returned a non-monotonic 17% that was entirely noise |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/bench_quality.py` | Which `REASONING_EFFORT` is worth it, scored on executed tests rather than output length |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/bench_quality.py --only eval_expr --level xhigh --repeat 4 --show-code` | Re-run one grid cell several times and print what a failing run wrote — the task set is not deterministic, so one cell is one sample |

## Capturing real workstreams

The corpora the depth and KL runs above score are recorded from real sessions,
not synthesised.

| Command | What it does |
| --- | --- |
| `./scripts/capture.sh on` | Start recording real workstreams: forge is repointed at the capture container, so the tape is what the MODEL saw — pi's system prompt, the tool schemas, and forge's own rewrites. `off` puts it back. Off by default; the override lives in the gitignored `.env.local` |
| `./scripts/capture.sh index` | What workstreams are on the tape, rebuilt from a flat log by longest-common-prefix over per-message hashes. `rw` counts history REWRITES — a turn whose prompt was not the previous one plus a suffix |
| `./scripts/capture.sh export s7f3a91 --out /captures/corpus/deep.txt` | Turn one workstream into a `llama-perplexity --kl-divergence-base` corpus, rendered through the server's own `/apply-template` and checked against the token count the server itself reported for that request |
| `./scripts/capture.sh import-pi ~/.pi/agent/sessions/<slug>/*.jsonl` | Read pi's own transcripts into the same shape — real sessions already on disk. They carry no system prompt and no tool schemas, so every record is stamped `gaps` and refused for a corpus without `--allow-gaps` |
| `./scripts/capture.sh self-test` | 98 checks over the recorder and the session rebuilder, no server needed. Includes the two controls that can fail: an unbuffered-stream check and a recorder that raises on every write |

## Testing the vendored forks

| Command | What it does |
| --- | --- |
| `cd vendor/pi-loop-mode && npm test` | Test the vendored `/loop` fork (39 tests, no install) |
| `cd vendor/prinny-channel && npm test` | Test the Matrix channel (296 tests, no install) |
| `cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts` | Test the rtk gate (28 tests, no install) |

---

[← back to the README](../README.md)
