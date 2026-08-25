# Repository layout

Every file and directory, and what it is for.

```
.gitignore              .env.local, models, caches
.env                    committed config + version pins
.env.local.example      machine-local override template (copy to .env.local)
versions.lock           what update.sh last verified (generated)
docker-compose.yml      llama + forge, plus tools-profile one-shots
Dockerfile.forge        forge proxy image, pinned to FORGE_VERSION
Dockerfile.pi           optional: pi + the browser stack in a container of its own
.github/workflows/ci.yml  CI pipeline (lint, build, verify)
badges/ci.json          shield.io endpoint JSON for the CI badge
README.md               what this is, how to run it, and where to read more
docs/                   public documentation, split out of the README 2026-08-25
  modes.md              the three regimes, their models, every sampler value
  pi.md                 /stack, /loop, subagents, /prinny, provider config
  context-budget.md     MCP-without-MCP, filtered bash output, the browser
  reasoning.md          REASONING_EFFORT and thinking language
  quants.md             what fits in 24 GiB and what each step down costs
  benchmarking.md       verifying it works; every measurement command; capture
  troubleshooting.md    symptoms, in the order you are likely to hit them
  container.md          running pi in a container; mount rules; moving a home
  layout.md             this file
  changelog.md          what changed, and when
prompts/
  think-zh.md           reason in Mandarin, answer in the user's language
  README.md             why this is applied client-side and not in the engine
scripts/
  lib.sh                shared helpers, sourced by every script here
  setup.sh              prerequisites -> model -> build -> up -> verify
  update.sh             update everything, verify, roll back on failure
  up.sh / down.sh       start / stop the stack
  logs.sh               tail llama or forge
  smoke-test.sh         run smoke_test.py against the running stack
  download-model.sh     runner for download_model.py
  smoke_test.py         end-to-end checks (runs inside the compose network)
  ab_think_lang.py      A/B a thinking-language prompt: quality, cost, leakage
  ab-think-lang.sh      runner for the above (resolves the fragment from .env)
  test_repeat_detector.py  standalone unit tests for the loop detector
  test_cjk_detector.py     standalone unit tests for the CJK leak detector
  bench.sh              runner for bench.py
  bench.py              prefill / decode / MTP acceptance, from llama's timings
  bench_repeat.py       the repetition workload bench.py cannot measure — its
                        nonce defeats ngram-simple as well as the prefix cache.
                        Reports "echo" so a flat result can be told apart from
                        a workload that failed to repeat
  bench_quality.py      reasoning effort vs ANSWER QUALITY: 8 tasks x 5 hidden
                        edge-case assertions, model code executed, LOC as the
                        over-engineering proxy. Length is not quality.
                        --control scores a known-correct reference for every
                        task and the grid refuses to start unless all pass;
                        --only/--level/--repeat re-run one cell, because the
                        set is not deterministic and one cell is one sample;
                        --show-code prints what a failing cell wrote
  capacity-probe.sh     does a launch flag FIT and what does it cost — context
                        window, ngram size_m, draft KV type. Records VRAM
                        against a stack-down idle floor and llama's own -lv 5
                        allocation table, and restores .env on every exit path
  ctx_needle.py         proves a context window is real rather than advertised:
                        a distinct nonce at EACH END of the document must come
                        back, plus a negative control past the limit. Sizes the
                        prompt from the server's /tokenize, not an estimate
  bench_literal.py      do exact literals survive from deep context into a
                        TOOL-CALL ARGUMENT? The failure the Level1Techs
                        divergence experiments actually found is not worse
                        prose, it is a corrupted port, hostname, interface or
                        kwarg inside a structured call. Eight literal shapes,
                        one per observed failure surface, at both ends of the
                        document. The shallow control is on by default and is
                        what makes a deep failure interpretable
  capture_proxy.py      the workstream tape: a transparent recording reverse
                        proxy that sits between forge and llama (or in front of
                        forge) and writes one JSONL line per completion —
                        full request, assembled response, timings, and a
                        per-message hash list. Streams are forwarded chunk by
                        chunk, never buffered, and a recording failure can never
                        fail a request. --self-test runs the checks
  capture_sessions.py   reads the tape back: rebuilds workstreams by chaining on
                        those hashes, classifies each join (continuation / retry
                        / rewrite), exports a KLD corpus pinned to the server's
                        own token count, and imports pi's transcripts with their
                        gaps named
  test_capture_proxy.py the recorder's unit + live-socket suite, including the
                        no-buffering control and the exploding-recorder control
  test_forge_patches.py behaviour gate for the five build-time forge patches.
                        Runs INSIDE the built image, because it imports the
                        patched package. CI runs it after the image build
  probe_lib.py          shared by ctx_needle.py and bench_literal.py: the nonce,
                        the varied filler, and the document builder that
                        CALIBRATES its length against the server's tokenizer.
                        Not an entrypoint — it is imported, which is why it is
                        easy to forget in Dockerfile.forge's COPY list
  vram-floor.sh         what the WINDOWS DESKTOP holds on the shared GPU,
                        sampled over a period and WITHOUT stopping llama.
                        Decomposes the device with Windows' own GPU perf
                        counters, since nvidia-smi returns [N/A] per process
                        under WDDM. Needs the host bridge
  spec-sweep.sh         sweep SPEC_TYPE x n-max x p-min, report draft/cycle.
                        Every result records the pin set that produced it,
                        so --resume cannot skip a row measured on another
                        build and --report cannot pass a mixed table off as
                        a comparison
  slot-cache.sh         save/restore KV cache — UNUSED, and read its header first
  mode.sh               switch between the regimes in modes/
  download_model.py     resumable GGUF fetch
  pi-local.sh           launch pi against the stack (the only client)
  pi-container.sh       the same, in the Dockerfile.pi container; creates it
                        on first use, reuses it after, and delegates to
                        pi-local.sh inside. A no-op wrapper when already in
                        one, so an alias to it is safe everywhere
  mcp.sh                call an MCP server as a CLI (wraps mcp2cli)
  browser.sh            drive Chrome as a CLI (resolves .env, runs browser_cli.py)
  browser_cli.py        the client: server lifecycle, tool discovery, tool calls
  test_browser_cli.py   standalone unit tests for the browser CLI's arg parsing
  rtk.sh                install/pin rtk, and --check its filters against the
                        allow-list they are trusted to match
modes/
  coding.env            mainline unsloth quant, Qwen's published preset
  uc-coding.env         decensored model, coding's sampler profile (tool-use)
  prose.env             decensored model, card sampling, no thinking-language
patches/
  forge_merge_consecutive.py  build-time fix for a forge crash on structured
                        message content; fails the build if forge changes
  forge_cached_tokens.py      build-time fix for forge dropping llama's
                        prompt-cache counter; fails the build if forge changes
  forge_reasoning_passthrough.py  build-time fix for forge destroying a
                        reasoning-only turn and hardcoding finish_reason;
                        fails the build if forge changes
  forge_toolcall_content.py  build-time fix for the same class of loss on the
                        TOOL-CALL path: a forge ToolCall has a `reasoning` field
                        and no content field, so the model's own sentence has
                        nowhere to live and the response builder fills `content`
                        with the reasoning instead. Restores both, each in its
                        own field
  forge_merge_across_tools.py  build-time fix for _merge_consecutive folding
                        every user turn into the FIRST user message — upstream's
                        workaround for a MISTRAL template's parity checker,
                        which rewrites the prompt PREFIX every agentic turn and
                        pins the KV cache on a template that never needed it.
                        FORGE_MERGE_ACROSS_TOOLS=1 restores the old behaviour
.pi/extensions/
  stack.ts              /stack command + stack_status tool inside pi
  browser-guard.ts      turns a browser-tool timeout into an instruction
  compaction-guard/     bounds pi's carried-over summary, caps oversized tool
                        results, and shows the model its context budget — in
                        every session, not just /loop
    src/                pure modules — the cap, the notice (no pi import)
    tests/              node --test suite, 37 tests
vendor/pi-loop-mode/    /loop — fork of pi-loop-mode@2.5.4, loaded from here
  FORK.md               what was changed and why (context-recovery race)
  tests/                node --test suite for the fork's recovery ladder
vendor/pi-subagents-lite/  Agent — fork of pi-subagents-lite@1.11.0, in-process
  FORK.md               why this package of 341, the wire cost, what was changed
  src/spawn/result-cap.ts  bounds a BACKGROUND result — the one path the guard
                        cannot see, because pi injects it without a tool_result
  tests/                node --test suite for the cap, plus a lint that works
vendor/prinny-channel/  /prinny — Matrix channel, converted from a Claude plugin
  FORK.md               what the conversion changed, and why forwarding exists
  extensions/index.ts   the pi extension: tools, /prinny, forwarding, lifecycle
  src/                  pure modules — client, gate, block renderer, access
  server/               the Matrix sidecar, run as a child process
  tests/                296 tests, no node_modules
vendor/rtk-pi/          bash output filtering — fork of rtk's own pi extension
  FORK.md               the measurements, and why it filters an allow-list
  src/gate.ts           what is filtered and what is accepted back (no pi import)
  extensions/index.ts   the pi coupling, and nothing else
  tests/                node --test suite for the gate
mcp/servers.json        registry of MCP servers reachable via scripts/mcp.sh
mcp/adapter.json        pi-mcp-adapter config: how pi reaches the browser server
skills/mcp-tools/       pi skill teaching the model to use scripts/mcp.sh
skills/browser/         pi skill for CLI mode (scripts/browser.sh)
skills/browser-tools/   pi skill for adapter mode (native browser_* tools)
context/                why things are the way they are
  README.md              index of the above, and the conventions it follows
  design/decisions.md    all design decisions, flags, quant choice
```

---

[← back to the README](../README.md)
