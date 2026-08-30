# Tool-count bench — what a large `tools` array costs at decode time

Run 2026-08-30 with `scripts/bench_tools.py`, to size llama.cpp **#27679**
(`0cc5b149`, *chat: scope the qwen3-coder workarounds*) on this box before
adopting the build that carries it.

    docker compose --profile tools run --rm \
        --entrypoint python bench /work/scripts/bench_tools.py \
        --counts 0,15,100 --repeat 9 --max-tokens 512 --warmup 2

Both builds: same weights (`orcarouter/Qwen3.8-27B-Uncensored-Q4_K_M`, the
uc-coding regime), same `CTX_SIZE=98304`, same `q8_0/q8_0` KV, same
`ngram-simple,draft-mtp` at n-max 4 / p-min 0.40, same box, same session,
b10573 measured between two b10689 loads.

## Why a new probe was needed

Neither `bench.py` nor `bench_repeat.py` sends a `tools` array. llama.cpp builds
the tool-call grammar *from the tools in the request*, so with no tools there is
no grammar and nothing for a trigger-cost change to move. Either bench would
have returned a flat row, and a flat row reads as **"the fix does nothing"**
when the truth is **"the instrument cannot see it"**.

That absence was confirmed with a control rather than by a single grep: searching
`scripts/` for `"tools"` *does* hit `smoke_test.py`, `bench_literal.py` and
`ab_think_lang.py`, so the method works and the absence in the two throughput
benches is real.

## Why the raw tool-count curve is not the answer

A 100-tool request carries ~11,600 prompt tokens against a few hundred at zero,
and this stack has already measured decode falling with context depth. So a
tools-only curve confounds the **grammar** with the **depth the schemas add**.
Every tool arm is therefore paired with a **ballast** arm: no tools, padded with
inert prose to the same prompt depth. The ratio between them is the grammar.

Two more controls, both of which fired during development and changed the result:

* **Prefix cache.** The tools block renders *ahead* of the user message, so a
  nonce in the message does not stop it being cached — measured `cache_n=10603`
  on the 100-tool arm. Tool names are now salted per run; `cache_n` is 0 on
  every row below.
* **Warmup.** The first generation after a load runs ~10% slow (llama.cpp#27342,
  where a reporter bisected a "13% regression" that was entirely this). Two
  warmups are discarded per run.

An `n=3` pilot gave 83.0% / 93.8% — non-monotonic, i.e. noise. `versions.lock`
puts decode reproducibility at ~6% on a settled box. These are `n=9`.

## Result

Median decode tok/s, n=9 per cell:

| arm | b10573 | b10689 | delta |
| --- | ---: | ---: | ---: |
| tools=0 | 58.62 | 63.88 | +9.0% |
| tools=15 | 55.86 | 57.60 | +3.1% |
| tools=100 | 46.64 | 54.61 | **+17.1%** |
| ballast≈15 (no tools, same depth) | 62.36 | 60.25 | −3.4% |
| ballast≈100 (no tools, same depth) | 59.88 | 56.88 | −5.0% |

**Grammar cost, depth-matched** — the tools arm as a fraction of its ballast arm:

| tool count | b10573 | b10689 |
| --- | ---: | ---: |
| 15 | 89.6% | **95.6%** |
| 100 | **77.9%** | **96.0%** |

On b10573 the cost **grows with tool count** — 10.4% at 15 tools, 22.1% at 100.
On b10689 it is **flat at ~4%**. That is precisely the shape #27679 describes:
one `<function=NAME>` grammar trigger per tool, checked against every sampled
token, removed for templates that support reasoning. Confirmed on this box.

## Read the no-tools arms before trusting the deltas

The three no-tools cells move in **opposite directions** between builds (+9.0%,
−3.4%, −5.0%). There is no consistent build difference on the no-tools path —
that spread is the box, and it is the same ~6% this repo already documents.

This is why the **ratio** is the load-bearing number and the raw deltas are not:
the ratio is computed within one build and one session, so box conditions cancel.
The +17.1% at 100 tools is real but carries that noise; the +3.1% at 15 tools is
inside it and should not be quoted as a speedup on its own.

## What it means for this stack

**At the tool count this stack actually runs, the win is small.** Adapter mode
puts ~10–15 schemas on the wire (`docs/context-budget.md`), which is the 15-tool
row: ~3%, inside the noise floor.

The fix pays at high tool counts — and high tool counts are the configuration
this repo **deliberately avoids**. Wiring all 98 browser tools in the normal MCP
way was rejected for costing ~19k tokens of window; this measurement says it
would also have cost ~22% of decode on b10573. The adapter-mode decision was
made for context budget and is independently validated here on throughput.

So b10689 is adopted for correctness and headroom, not for a speedup anyone will
feel today. If a future client ever loads schemas directly, this row is why it
still should not.
