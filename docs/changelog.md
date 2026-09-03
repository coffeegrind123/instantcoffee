# Changelog

What changed on this stack, newest concern last within each entry. These were
blockquotes at the top of the README until 2026-08-25; they are history, not
instructions, and the README got unreadable carrying them.

For the reasoning behind a change rather than the fact of it, see
`../context/design/decisions.md`. For what is pinned right now, see
`../versions.lock` — that file, not this one, is the authority on current state.

---

**`ninfer-compare.sh --restore-only` puts the stack back in one command.** The
script's EXIT/INT/TERM trap does work — an interrupted run on 2026-09-03
recovered unaided — but it is not proof against a *second* signal, which one
run took between `docker rm -f` and `docker start`, leaving ninfer holding
~22 GiB of VRAM and llama `Exited (137)`. Recovery then meant remembering two
commands and a five-minute wait at exactly the moment the operator has least
context. The flag reaches the same `restore()` from outside the run that needed
it, is safe to run when nothing needs restoring, and names which of the three
states llama is actually in — already healthy, running but still loading, or
failed to start — instead of telling you to wait five minutes for a container
that is fine. Its run directory is suffixed `-restore` so a recovery can never
be mistaken for a measurement.

**It was controlled with a real container, not just an absent one.**
`docker rm -f` on a container that is not there also returns 0, so "removed
nothing successfully" and "removed the right thing" are indistinguishable from
the exit code alone. A stand-in named `ninfer-bench` was planted and confirmed
gone afterwards, with llama untouched and still healthy.

---

**The llama arm of the ninfer comparison is now measured four times and agrees
with itself; the ninfer arm has still never produced a number.** The three quiet
runs (1, 2 and 4) span **2066.1 to 2087.1 tok/s prefill — a 1.0% spread over
three hours** — on ~20,582 prompt tokens. Run 3 at load 4.00 gives **1998.1**
and **88.2** — 4% and 6% slower — which is a useful scale for what the quiet-box
rule is worth. **Decode is the noisier half and should always be quoted with its
range:** run 4 spans 77.1–93.8 tok/s across three rounds on a quiet box, against
run 2's 93.5–96.9. Prefill is stable to ~1%; decode is not.
Note that `--prompt-tokens 32768` produces ~20,580: `CHARS_PER_TOKEN_GUESS` is
3.6 against an actual ~5.73 for this filler, the flag is documented as a target
rather than a promise, and both arms share the generator. Do not quote 32768.

**Three defects were fixed, all in our own harness and none in either engine.**
(1) The ninfer readiness probe was `docker exec ninfer sh -c 'curl -sf
.../health'` and that image ships **no curl, no wget and no python3** — so the
probe exited **127**, command not found, on every iteration, which the loop
cannot distinguish from "not ready yet". It sat for nine minutes against a
server that had been answering `/health` in **0.43 s** since minute one, and
would have reported *"ninfer did not become healthy within 1800s"* about a
healthy engine. It now probes from the bench image over the compose network —
the right prober precisely because the arm uses it — and keeps 0/1/other
distinct so a broken probe stops the run instead of burning 1800 s. Controlled
three ways: present → 0, absent → 1, probe broken → 9. **That control failed on
its first attempt and the probe was innocent** — llama was still cold-loading
and honestly answering 503. (2) `_post_stream` discarded the HTTP error body,
so an entire ninfer arm reported `HTTPError: HTTP Error 400: Bad Request` four
times and said nothing about which field; it now raises `BackendRefused`
carrying what the server actually said. (3) The engine log was captured at
readiness, so it stopped at "listening" and held nothing about the requests;
`bench_arm` now also writes `<arm>.engine-after.log`.

**ninfer itself loads clean and the `O_DIRECT`-on-9p worry is settled.** Three
cold loads: 16.67 GiB of weights in **132.7 / 146.2 / 165.7 s**, once through to
`model loaded in 547.519 s` and listening. It reads its artifact faster than
llama reads its GGUF off the same mount. At our matched `--max-context 98304
--kv-dtype int8` it reports `pages=1536/1536`, `slack=1.59 GiB` and
**`headroom=0.00 MiB`** — worth knowing before anyone tries the 262K arm.

**The 400 is still undiagnosed, deliberately.** Reading ninfer's C++ validation
ruled out the obvious suspects — it does not reject unknown fields wholesale, so
`timings_per_token` is not it; `stream_options.include_usage` is parsed and
accepted; `max_tokens` is accepted as a fallback for `max_completion_tokens` —
and the remaining candidates are not worth guessing at when the next run will
print the server's own reason. Two of three attempts were stopped externally
mid-flight, once at 99.7% of the weight load, leaving ninfer holding ~22 GiB of
VRAM and llama `Exited (137)`. A fourth attempt was stopped the same way, and
that one clarified the trap: `restore()` completed on its own — `ninfer rm
rc=0`, llama back unaided — so the earlier hand recovery was a second signal
arriving mid-restore, not a broken trap. **Three of four failures were the run
being stopped from outside, not anything about ninfer**, which makes ~25
uninterrupted minutes the binding constraint rather than code.

---

**llama-server can stop serving for up to 18 minutes while reporting itself
healthy, and the cause is its own prompt cache.** Every request through forge
died with `ReadError`/502 and the smoke test failed `forge plain completion`,
while `docker ps` said `Up 5 hours (healthy)`, `/health` answered 200 in 37 ms
and the model sat resident in VRAM. `llama-server` was at 100% of one core in
`R` state with **zero voluntary context switches** and the GPU at 3%: it was
inside a **prompt-cache update**, which runs on the main loop and services
nothing at all while it does — no request, no `/slots`, no `/metrics`. The
engine's own log is the instrument (`prompt cache update took N ms`), and on
this box on one day it read 1.3–2.9 s in the common case, **24.78 s** on one of
six otherwise identical quiet rounds, **39.06 s** and **81.12 s** under load,
and once **1,109.11 s — 18 min 29 s**. That longest one is not a curiosity: it
is the exact cause of the smoke failure, which forge cancelled at 600.000 s to
the microsecond, its full `FORGE_BACKEND_TIMEOUT`, against a server that never
stopped answering `/health`.

**The entries are that big because this model is a hybrid.** 48 of Qwen3.8-27B's
64 layers hold a constant-size recurrent state, so a cached prompt costs ~150
MiB before its first KV byte and each `CTX_CHECKPOINTS` copy adds ~150 MiB more.
The server's own cache dump shows a **34-token** prompt occupying **300.559
MiB** and a 29,714-token prompt **1,783.870 MiB** against the `CACHE_RAM=2048`
cap — so at long contexts the cache holds one prompt, and every switch to a
different prompt evicts it and re-copies over a gigabyte on the critical path.

**`/health` is the wrong probe and `/slots` is the right diagnosis, but it must
not become a watchdog.** `/health` is answered by an HTTP thread and never
touches the inference loop; `/slots` and `/metrics` post a task to the same
queue a completion does. While stalled, `/health` answered in 37 ms and both
others timed out at 10 s; after the restart all three answered in ~5 ms — that
control is what makes the asymmetry a measurement rather than a guess. It is
deliberately NOT wired into the healthcheck: an update that legitimately
finishes after 18m29s looks identical from outside to one that never will, so
any threshold short enough to help would kill a working engine mid-copy.
`docker-compose.yml` is unchanged, and `docs/troubleshooting.md` carries the
diagnosis instead.

**"It is memory pressure" was the first explanation and it does not hold.** Six
quiet rounds with an identical ~1252 MiB payload and one eviction each ran 1.32,
1.32, 1.38, 1.98, 2.86 and 24.78 s — and the 24.78 s round had the *most* free
memory of the six (5,460 MiB). Contention makes the tail worse (both
three-figure observations came from a box at load 16–34 with another session
building) but the mechanism behind the variance is not identified, and the
retraction is recorded rather than quietly dropped.

**New: `./scripts/cache_stall_probe.py`** drives the operation deliberately —
pairs of mutually-different long prompts, a fresh nonce on each so
`--cache-reuse` cannot serve round two from round one — and samples `/health`
and `/slots` throughout, so "nothing was served" is measured rather than
asserted.

**`ninfer-compare.sh` now reports the confound instead of absorbing it.** Its
llama arm pays this tax on every round after the first (fresh nonce per request
means every round takes the slot from a different prompt) and ninfer has no
equivalent step. It lands inside wall-clock TTFT and *outside* the engine's own
`prompt eval` timing, so left unmeasured it would have shown llama losing badly
on time-to-first-token for a reason that is not the engine — the same shape as
the leftover-container queue wait that had to be retracted from
`bench_cross_engine.py`. `cache_stalls()` now writes the engine's own account of
every update inside each arm's window to `<run>/<arm>.cache-stalls`, summarises
it into `run.meta`, and warns on the console; `run.meta` also records
`CACHE_RAM` and `CTX_CHECKPOINTS`, which size the entry.

---

**The ninfer path is open on this card, and it costs 16.96 GiB — not 51.7.**
`OPEN-WORK.md` §00 had closed it twice over: upstream's build "rejects CUDA
architectures other than `sm_120a`", and the cost was recorded as 18 shards and
**51.7 GiB** of bf16 safetensors plus a conversion. Both are now corrected.
`sergiuszm/ninfer-4090` is `sm_89`-only by default against upstream's `120a`-only
`FATAL_ERROR`, and it **builds clean here** from its own unmodified Dockerfile —
290 objects, zero errors, and the binary carries **2 `sm_89` cubins with zero
PTX**, so the open gate is native Ada code and not a JIT fallback. The official
`.ninfer` artifact is published pre-converted and ungated: anonymous HEAD, no
token, `content-length: 18210531328` = **16.96 GiB, one file**. The 51.7 GiB
belongs only to converting the *uncensored fine-tune*, which is a separate and
later decision. Both forks' converter files are byte-identical to upstream, so
the previous session's 6-of-6 frontend-pin result and its MTP-head result
transfer by hash with nothing to re-verify.

**Their 223K–567K context ceilings check out arithmetically, on our own
engine's geometry.** Qwen3.8-27B is a hybrid: only **16 of 64 layers cache KV**,
which is the whole reason 400K+ windows fit in 24 GB. `llama_kv_cache` prints 16
layers, `n_head_kv=4`, `n_embd_head_k=256`, and skips recurrent layers 3/7/11 —
ninfer's `range(3,64,4)` exactly. `scripts/kv_ceiling_check.py` reproduces the
engine's own `1632.00 MiB` to the hundredth, and all five published ceilings then
land inside a **0.32 GiB band** of residual slack on this card. No row proves
anything alone; the mutual agreement is the evidence. **Nothing about speed has
been measured** — every throughput number is still theirs.

**Keep llama.cpp regardless of how that measurement goes.** `ninfer-serve`
registers no `/tokenize`, no `/completion` and no logits export, and its own
perplexity tool is "not a serving endpoint or a logits-export API", reporting NLL
per *window* rather than per token. Every misfire-rate result and the whole
`ppl-*` family need per-token logprobs and `parse_special=False`. The realistic
outcome here is two engines, not a replacement.

**Three measurements lied before they were caught, all the same way.** A bench
reported "no content token was ever streamed" because under
`REASONING_EFFORT=medium` the model streams `delta.reasoning_content` with
`delta.content` null — a broken parser presenting as a dead engine. A "~6 s
hidden stall that scales with prompt length" was committed and then withdrawn: it
was leftover bench containers queueing on llama's single slot, and measured quiet
the gap is a flat 0.68–1.31 s across a 50× span of prompt length. And
`cuobjdump` reported no cubins *and* no PTX because the binary had been staged on
a path that exists inside the container but not on the host, so Docker mounted an
empty directory over it. **A negative result is worth nothing until the same
method has found something known to be there** — that control is what caught all
three, and `ninfer-compare.sh` now refuses to start with stray bench containers
alive.

---

**128K fits, and it halves decode.** The refusal that stood since 2026-08-23 was
arithmetic: it carried a `+1408` MiB engine delta measured on the OLD weights,
implying a 128K footprint of 22407 where the engine now says **21159**. A probe
loaded 128K with 921 MiB free — with the desktop at 2481 MiB, near the level that
had produced the previous refusal, so not because the box was quiet. Then the
cost was measured, both arms in one run against the same 90,029-token prompt:
prefill **1797.8 -> 1200.7** tok/s, decode **50.2 -> 26.1**, draft acceptance
flat. The three 128K decode runs span 4%. **96K stays the pin, now on a cost
measurement rather than on headroom arithmetic.**

The re-open condition named the wrong lever: it said to close NVIDIA Broadcast,
which has run continuously since 2026-08-25 through both captures, reading 920.1
MiB then and 0.1 MiB now. The floor came back on its own (median 1460.9 against
2741.3) and moved **765.8 MiB inside one 11-minute capture**. Measure it on the
day; a floor has a shelf life of hours.

**The experiment runner that wedged four times was `set -e`.** `ppl-cliff-run.sh`
turns errexit off on line 59 and sources `lib.sh` on line 60, which turns it back
on. `restore()` opens with a `docker kill` of a `--rm` container that has already
exited — always exit 1 — so the script died there, before restarting llama, with
stderr going to `/dev/null`. Every symptom follows, including "the trap did not
fire" (it fired and died identically). **Five scripts had the identical shape**,
one of them carrying a comment about `set -e` that the very next line undid. All
five fixed, pinned by 7 tests with controls. Note `set -uo pipefail` does **not**
disable `-e`; that takes an explicit `set +e`.

**`./scripts/mcp.sh` now wraps MCP server output** in the untrusted-content
envelope. `mcp/servers.json` gained an `inert` key and **absent means untrusted**,
so a web-facing server registered later is wrapped by default rather than
depending on whoever adds it having read the file. stderr stays outside the
envelope and discovery is not wrapped. 22 tests, controlled both ways.

---

**The chat template ships inside the GGUF, so the three modes do not run the
same one.** `coding`'s unsloth GGUF carries a 9993-char fork ("Unsloth fixes -
developer role, merged system messages, tool calling"); `uc-coding` and `prose`
carry Qwen's published 8952-char original, byte-identical to the Hub copy. They
disagree about which requests are legal: `reasoning_effort=high`, a `developer`
role and a second leading system message all render under `coding` and are
**HTTP 500** on the other two. `modes/uc-coding.env`'s "the ONLY difference from
coding is MODEL_REPO/GGUF_FILE" was true of the file and false of the behaviour.

The one to know about is **`REASONING_EFFORT=high`**, which `.env` and
`docs/reasoning.md` both described as "silently rewritten to `xhigh`". That was
read out of the unsloth GGUF and the pin moved to orcarouter on 2026-08-25. It
is baked into llama-server's launch flags, so on two of three modes it is not a
slower regime, it is a stack that answers nothing. `medium`, `low` and `xhigh`
work on both templates. All three modes ship `medium`, so nothing was down.

New: `scripts/template_probe.py` measures which shapes the *active* template
refuses (ten cases, four controls). `scripts/gguf_probe.py --dump-template`
extracts a template from any GGUF on the Hub without downloading the weights.
`CHAT_TEMPLATE_FILE` is plumbed and **inert** — declared empty in all three mode
files, because `mode.sh` only rewrites keys the target mode declares, and a
model-coupled key that survives a switch would run one model's weights under
another's template in silence.

**Patch 13: a backend fault now says why.** All five of those refusals reached
the client as the same `Backend returned 500` while llama-server's body named
each one. Upstream keeps a backend's raw body off the message deliberately — an
intermediary can echo a credential into one — so the patch does not append the
body: it lifts the single `error.message` string out of a well-formed JSON error
envelope and leaves HTML, plain text and non-object bodies exactly where
upstream put them. Status codes unchanged. `FORGE_BACKEND_ERROR_DETAIL=0`
restores upstream. `test_forge_patches.py` is now 115/115.

**128K is still refused, for a new reason: the desktop, not the model.** The
model gave back 678 MiB when the pin moved to orcarouter — which alone would
have opened 128K — and the Windows VRAM floor grew 1240 MiB over the same ten
days, to 2528/2741/2824 against the 1501 `versions.lock` calls "the ORDINARY
state". `NVIDIA Broadcast` alone holds 920 MiB. 128K is now one process away
from fitting at +336 MiB, which is thinner than the ~824 MiB 96K keeps free, so
nothing changed. The floor is a property of what happens to be open: **measure
it on the day** before spending headroom.

**A restart policy only sees processes that end, and llama-server did not end.**
The same 2026-09-01 abort that produced the two forge patches below had a second
half: the container stayed `Up 7 hours (unhealthy)` with a dead server inside
it. `/proc/7/stat` sampled 3 s apart moved +248 ticks — spinning, not hung — and
`docker restart` needed the full 30 s timeout and a SIGKILL to end it. Docker has
no "restart when unhealthy"; it recorded 88 consecutive failures and did nothing
else, because nothing else is what it does.

The usual fix is an `autoheal` sidecar with `/var/run/docker.sock` mounted —
root on the host, granted to a container, for one service's benefit. It was not
needed. `init: true` was already in the file, so tini is PID 1 and llama-server
is an ordinary child; **an ordinary child is killable from inside the PID
namespace, and a namespace's PID 1 is not.** The healthcheck now kills the
server so the container exits and `restart: unless-stopped` — already there —
takes over. No socket, no sidecar, no new image.

Three guards keep it from breaking a working stack, and the middle one was
confirmed live on the reload that shipped it:

- Nothing is counted until the server has answered **once**. A ~24 minute cold
  load must not look like a wedge, and this tests that condition rather than
  assuming when the port binds.
- `curl` exit 22 does not count. Every probe of the load window came back
  `curl: (22) The requested URL returned error: 503`. A server answering 503 is
  a server; only 7 (refused) and 28 (timeout) mean nobody home.
- `--max-time 4` under Docker's `timeout: 5s`, so the probe always finishes and
  records its own result. The wedged container's probes were being killed at
  Docker's timeout, which is why nothing ever accumulated.

Two details that are load-bearing rather than decorative. The counter lives in a
**tmpfs**: the writable layer survives `docker restart`, so a counter in `/tmp`
would survive the restart it just caused and the next failed probe would kill
again, forever. And the reason is written to `/proc/1/fd/2`, so it appears in
`docker logs` immediately above the reload instead of only in
`State.Health.Log[].Output`, which nobody reads and which the restart discards.

`scripts/test_llama_watchdog.sh` is **15/15**, and it reads the probe out of the
created container with `docker inspect` rather than carrying a copy — the test
and the shipped text cannot drift. `docker compose config` is deliberately not
the source: it re-escapes `$` as `$$` so its output is a compose file again, and
asserting on that would test the escaping. `LLAMA_HEALTH_KILL_AFTER=8` (× the
15 s interval = two minutes) is the new `.env` key, defaulted in compose so an
older `.env` starts the same container it always did.

**Separately, the abort itself was chased down to a different suspect.**
llama.cpp#23154 reports the ngram spec map growing VRAM until a CUDA OOM. Using
`vram-floor.sh`'s method — the Windows per-process GPU counter for `vmwp`, which
that script established is llama and nothing else here — across 41 minutes
spanning 24 short conversations, three 58K context builds, five 2,000-token deep
generations and a 93K-token conversation: **llama moved 6.1 MiB, and 0.0 MiB
across a quieter 69-sample capture.** It does not leak.

Four reproductions did not crash either. `common_ngram_map_begin` is pure CPU,
so it was never the thing that aborted — it is the last line before the decode
that did. The first attempt matched every line the crash logged (`selected slot
by LRU`, `exceeds cache size limit`, the shrink, the refresh) and survived; the
fourth reached a **larger** context (93,123 tokens) and a **larger** rehash than
the crash at 93% key deletion, and survived. Attempts 2 and 3 failed to raise
the key count for a reason the source explains: any request whose prompt is
shorter than the last one culls keys, so a branched follow-up culls the keys it
is meant to be planting.

What is left is headroom, and it has moved. At the busiest moment measured, the
device held 23,323 of 24,564 MiB — 1,241 MiB free — and that number belongs to
the Windows desktop, whose floor now reads **min 2007.5 / median 2033.5 / max
2050.4 MiB against an August range of 1405–2027**. Today's median is above the
whole range the 96K window was chosen against. `context/OPEN-WORK.md` §0f has
the attempt table and the four things to do in order; the short version is that
the pin is not at fault, `CTX_SIZE` is the only lever that returns VRAM in GiB,
and `CUDA_LAUNCH_BLOCKING=1` on the next recurrence names the real failure
site.

---

**"Stream ended without finish_reason", twice, for a backend that had been dead
for two hours.** On 2026-09-01 llama-server aborted mid-generation on a CUDA
assert — `ggml-cuda.cu:2651 GGML_ASSERT(stat == cudaSuccess)` inside
`ggml_cuda_graph_update_executable`, immediately after a `common_ngram_map_begin`
shrink on the `ngram-map-k` speculative path — and then **did not exit**. It sat
in `R` state spinning on a core with its port closed, so `restart: unless-stopped`
never fired; Docker only marked the container unhealthy, 88 times, and nothing
acts on unhealthy. Four turns over the next 40 minutes each burned the full
600-second `FORGE_BACKEND_TIMEOUT` against it.

None of that reached the operator. What reached the operator was a protocol
complaint, and the path from one to the other is five links long, each read off
the running system rather than reasoned about:

1. `LlamafileClient.send()` has no `httpx.ReadTimeout` handler — zero, counted —
   though `OpenAICompatClient.send()` has had one all along. The timeout escaped
   raw to forge's generic handler.
2. `_send_exception` does `error_msg = str(exc)`, and `httpx.ReadTimeout` carries
   no message. forge's own log line is the proof: `<< ERROR:` and then nothing.
3. So the wire carried `data: {"error": ""}`.
4. pi's bundled OpenAI SDK guards exactly this case —
   `if(data&&data.error)throw new APIError(...)`, read out of
   `chunk-NUHFSC37.js`. **An empty string is falsy.** The one check that would
   have surfaced the failure did not fire.
5. pi's completions loop reads only `choices[0]`, so the chunk was skipped
   whole, `[DONE]` arrived with `hasFinishReason` still false, and pi raised the
   only message it has for a stream that stopped early.

**Patch 11** (`forge_llamafile_timeout.py`) gives `send()` and `send_stream()`
the 408 conversion. **Patch 12** (`forge_sse_error_shape.py`) makes the message
never empty, sends the error as an object rather than a bare string, and adds a
terminal `finish_reason: "error"` — deliberately not `"stop"`, because patches
3, 8 and 9 all exist because a failure that ends the stream the way a completion
does is invisible to everything above it. Proven live against a socket that
accepts and never answers: the same request now returns
`{"error": {"message": "Backend returned 408: Read timeout", ...}}`.

**Patch 10 was aimed at the wrong file, and had been since it shipped.** It
guards `OpenAICompatClient.send_stream`. Its docstring claimed the streaming
path was "the ONLY path that matters here"; it is the one path that never runs —
`run_inference` takes `stream=False` and the proxy never overrides it, which is
the same fact README records from the other end when it says two SSE events is
the healthy count. It is kept, because the hole is real and upstream #142 is
open, but it never covered this stack's traffic. **A patch that verifies its
input text will apply cleanly to the wrong file forever without complaining
once.**

`test_forge_patches.py` is **97/97** in the rebuilt image (was 70), and the
negative control — the same suite run against the unpatched package copied out
of the running container — fails 11. One of the new assertions was vacuous on
its first run and the control is what caught it: `'"error"' in wire` is
satisfied by the broken shape too. `smoke-test.sh` 11/11 on the recovered stack.

The llama.cpp crash itself is upstream and unfixed — see `context/OPEN-WORK.md`,
along with the fact that nothing on this box restarts a container that goes
unhealthy.

---

**A tool that returned a bare string was exiting pi mid-turn**, twice, and on
2026-09-01 it took a session with it. pi renders a tool result with
`getTextOutput`, whose only input check is `if (!result) return ""` — that
covers a MISSING result, not a result without `content`, and every wrong shape
a tool can return is truthy. `prinny({action:"react"})` with no `message_id`
hit an early `return "prinny(react) needs a message_id…"`, reached
`"...".content.filter(...)`, and left as an `uncaughtException` from a render
callback. The same thing happened on 2026-08-30 to `action:status` hitting its
throttle. The stored transcript is misleading either time: pi's session writer
normalises to `content: []` while the UI event does not, so the saved record
looks harmless and does not contain the string that caused it. **Read the stack
trace, not the session file.**

Fixed twice over, because the two fixes answer different questions.
`vendor/prinny-channel@18f2fdd` routes all four of its early returns through a
`say()` helper — that is the tool honouring its own type. **`vendor/pi-toolresult-guard`
is new** and covers every OTHER tool, including MCP tools and anything an
extension registers, none of which the compiler can see. Upstream has closed
the missing guard `no-action` seven times, so the check is ours to make.

It is not a wrapper hoping to land near the problem: `afterToolCall` **already
computes** `result.content ?? []` and then discards it, because
`normalizeToolResultImages` returns its argument by reference and
`emitToolResult` returns nothing unless a handler modified something. One
handler that returns `{content}` flips that branch and releases the repair pi
had already worked out. `tests/pi-contract.test.ts` pins all five shapes against
the installed pi and says "delete this package" if the read is ever guarded.
Loaded first in `scripts/pi-local.sh`, so every other `tool_result` handler
reads a content array that is already safe. No tool, no command, zero tokens.
The one gap is `tool_execution_update`, which bypasses the hook; nothing in this
stack streams partial results, and a test pins that path so the gap stays visible.

**Also 2026-09-01: selecting a persona now switches the old one off.**
Overwriting `PERSONA.md` was half a switch — it changes the system prompt and
leaves a transcript full of assistant turns in the old voice, which a model
imitates more reliably than it obeys a block telling it who it is. Worst on the
extraction path, where `sendUserMessage` reaches `AgentSession.prompt()` and so
the turn that writes the NEW persona ran under the OLD one's whole block, then
cached the result in the library for every future activation. And the body was
being sanded off: physical description was on none of the extraction lists, so
cards written in flat anatomical terms produced personas talking about their own
"assets". Appearance is now lifted at the card's own detail in the card's own
words. Block cost `full` ~3,683 → ~4,215, `lean` ~2,311 → ~2,516.

---

**The speculative pin moved twice on 2026-08-31/09-01**, and the entry below
from 2026-08-17 is history rather than current state. `.env` now runs
**`SPEC_TYPE=ngram-map-k,draft-mtp`, `n-max 4`, `p-min 0.40`**.

Measured directly against the old pin in a single run: **map-k +38.7%**,
`ngram-mod 12:64:32` +29.1%, both p<0.002, ordering stable in all 8 rounds.
map-k beats ngram-mod by +8.7% (n=24, p=0.015), replicated four times across
three runs (8.7 / 8.6 / 9.3 / 7.5%). It is also the STEADIEST of the three —
25.7% within-round spread against ngram-simple's 39.3%.

**The novel-text axis is unresolved, not clean.** map-k measured -6.6% against
ngram-mod on the synthetic workload, but that run could only detect effects
above 10.6%, so it cannot tell -6.6% from zero. Read as "no LARGE cost". The
same caveat applies retroactively to ngram-mod's own synthetic result, which
was reported at the time as "no measurable cost" from the same instrument.

Getting here took five measurement attempts, four of them void, because the
same config measured 181.4 then 202.3 tok/s an hour apart on this shared box.
What made the fifth work: load stamped into every result, `--rounds N`
interleaving, and `scripts/spec_sweep_compare.py`, which decides round health
from recorded numbers rather than judgement applied after seeing the winner.
See `context/design/ngram-mod-and-the-load-confound.md`.

---

**Migrated from Qwen3.6-27B on 2026-08-15**, the day 3.8-27B released. The
architecture string is unchanged (`qwen35`), so the pinned llama.cpp build
loads it as-is, and UD-Q4_K_XL is the same 17.9 GB — but three things moved:
MTP now ships in the mainline quant (no `*-MTP-GGUF` repo), the card publishes
one thinking temperature (1.0) where 3.6 published two, and there is a new
`reasoning_effort` control that defaults to `xhigh` and will eat any budget you
give it. See `REASONING_EFFORT` in `.env` and the 2026-08-15 entry in
`context/design/decisions.md`.

**Verified on this box on migration day:** smoke test 11/11 (including a real
tool call through forge), prefill **1175 tok/s**, decode **39.6 tok/s**, MTP
acceptance **86.2%**, VRAM **21469 / 24564 MiB** at 32K — within 100 MiB of
what 3.6 used, so the quant table below carries over unchanged. Decode is well
down on the 69.2 tok/s `versions.lock` recorded for 3.6; 86% acceptance at a
draft depth of **2** points at the inherited `SPEC_DRAFT_N_MAX` being too low
for 3.8's draft head, and that sweep is not finished.

**Settled 2026-08-17 — and the draft depth was not the problem.** A full 2×6
sweep (`./scripts/spec-sweep.sh`) found **p-min** was the binding knob: at
`p-min=0.75` the draft was cut to a single token on ~70% of cycles, so raising
`n-max` under it measured nothing. `.env` now runs
**`SPEC_TYPE=ngram-simple,draft-mtp`, `n-max 4`, `p-min 0.40`** — the measured
optimum, worth **1.23× on novel text and 2.20× on repetitive** against the old
values, and re-verified at 11/11 on the smoke test. `ngram-simple` drafts up to
48 tokens per lookup with no forward pass, but it is only safe at n-max 4 — at
n-max 2 it *costs* 25% on novel text. Costs 529 MiB of VRAM. Full tables in
`context/design/decisions.md` (2026-08-16 / 2026-08-17) and raw results in
`context/bench/spec-sweep/`.

forge went 0.8.2 → **0.9.0** in the same change, and that one is not a version
bump: 0.9 rejects `--budget-mode` for externally managed backends (the proxy
refuses to start), and `/health` now forwards the *backend's* readiness while
forge's own liveness moved to `/forge/health`. Both are handled here — see the
forge notes in `.env`. pi went 0.84.1 → 0.84.2, which is uneventful.

**Superseded 2026-08-22.** The line that used to stand here said llama.cpp
"stays pinned at `b10200` deliberately: nothing between it and the newest
published CUDA image is Qwen3.8-specific". That is no longer true, and the
pin has moved to **`server-cuda-b10573`**. Four commits in the gap bear on
this stack: a Qwen tool-call parsing fix (#26793), an MTP memory-allocation
fix (#26605), a `draft-mtp` fix (#27400), and `2b562109` (#26079), which adds
a CUDA MMVQ→MMQ crossover table labelled "tuned on RTX 4090" where `b10200`
had **no Ada Lovelace entry at all**. That last one changes nothing at the
current `n-max 4` — both builds pick the same kernel for a verify batch of 5
— but it is what makes the `n-max 6/8` rows of the sweep measure something
other than a GEMV cliff. The three correctness fixes are the immediate
reason to move.

**Also 2026-08-22 — the 32K context ceiling was a misdiagnosis, and is gone.**
The KV cache did not have to be `f16/f16`. A stock CUDA build compiles only
**matched** flash-attention KV pairs (`f16/f16`, `q4_0/q4_0`, `q8_0/q8_0`,
`bf16/bf16`); the experiment that produced the ~65x prefill collapse used
`f16` K with `q8_0` V, and it was the *mismatch* that pushed flash attention
onto the CPU, not the quantization. Confirmed by llama.cpp#20866. Matched
`q8_0/q8_0` halves the cache, so `CTX_SIZE` is now **98304**. 4-bit KV stays
off the table — llama.cpp#27109 (open) has `q4_x` collapsing prefill to
34–106 t/s on this exact `qwen35` hybrid architecture against 991–1276 t/s at
`q8_0`, which is what makes most of the public 130K–250K 4090 recipes
unusable here. DFlash2 (PR #27342) is **not** adopted: a report on the PR from
an RTX 4090 running this model against multi-turn tool-result histories — this
stack's exact workload — measures generation collapsing to 12–14 tok/s on a
real agentic session, with `draft-mtp` immune on the identical request.
Full reasoning and citations in the 2026-08-22 entry of
`context/design/decisions.md`.

**Measured on the box the same day**, on `b10573` / `q8_0-q8_0` / `65536`:
smoke test **11/11** including a real tool call through forge; VRAM
**22382 MiB of 24564** — double the context for **+384 MiB** against the old
f16/f16 32K config's 21998 MiB, with ~2.1 GiB spare. Prefill by prompt length:
1121 @ 541, 1504 @ 1053, 1799 @ 2077, 2032 @ 4125, 2338 @ 8221, 1706–2162 @
16413, 2243 @ 32797 tok/s — four digits throughout and *rising* with depth,
which is the proof that flash attention is on the GPU (llama.cpp#27109's 4-bit
failure is the opposite shape: two digits, falling). Decode 52.6–70.4 tok/s.
Two outlier runs were discarded as host contention, not measurement — see the
`verified` block in `versions.lock` for why and what the control was.

**Throughput itself is unchanged; the win banked here is the window.** The
speed work is `./scripts/spec-sweep.sh`, which now has n3/n6/n8 rows —
and it must be run on a quiet box.

---

**`Dockerfile.pi` — pi in a container of its own, 2026-08-26.** Optional, and
nothing else in this repo depends on it. It carries pi, Chrome + the Zendriver
MCP server, `rtk`, `mcp2cli`, `uv` and a docker client, so a session can be given
its own home directory. llama and forge stay in the compose stack on the host
GPU, driven through a mounted docker socket; `pi-local.sh` already swaps
`localhost` for `host.docker.internal` when it sees `/.dockerenv`, so no script
changed.

Three things it does deliberately, each paid for elsewhere in this stack:
every tool is installed into the **image** rather than `$HOME`, because `$HOME`
is the bind mount and anything the build writes there is shadowed the moment the
volume is attached; `x11-utils` is a hard dependency, because `browser.sh`'s
display probe otherwise falls back to a `pgrep` that a stale
`/tmp/.X11-unix/X99` socket satisfies and Chrome drops silently to headless; and
the image seeds **no credentials** of any kind, saying so at startup rather than
letting it be found at the first commit.

**Verified on the box:** the built image reaches forge at
`host.docker.internal:8081` and completes a real pi turn with a tool call; the
Zendriver server comes up with **98 tools** and drives a headed Chrome on Xvfb
through `navigate` + `get_text_content`; `scripts/browser.sh up/status/navigate/down`
works from inside against the read-only checkout.

`docs/container.md` also records the three absolute-path dependencies that break
quietly when an **existing** agent home is relocated — the crypto snapshot's
IndexedDB key above all — and why the one-bot-per-Matrix-account lock cannot see
across two containers' home directories.

**`scripts/pi-container.sh`, the same day.** The container is plumbing, so it
should not be something you drive: the launcher creates it on first use, reuses
it after, and delegates to `pi-local.sh` inside, so the flags, the banner and
the session are the ones already documented. It is a no-op wrapper when already
inside one — the image sets `PI_AGENT_CONTAINER=1` — which is what makes an
alias to it safe everywhere.

Three of its behaviours were bugs first and are worth keeping in mind. `docker
inspect` on a missing container exits non-zero **and** prints a newline, so the
obvious `... || echo absent` yields a value matching neither branch and docker
gets asked to start something that does not exist. A note printed on a function's
stdout is captured into the path it returns, and arrives as docker's
`Cwd must be an absolute path`. And "does this directory exist in the container"
is a false positive for `/tmp`, `/usr` and `/`, which exist on both sides and
mean different things — so the working-directory search is scoped to the
container's home, and running from the host's `/tmp` falls back with a note
instead of silently landing pi in an empty directory that looks fine.

**Corrected the same day:** scoping the working-directory search to the
container's *home* was too blunt. It also rejected a project deliberately
mounted somewhere else — which is the entire point of `PI_CONTAINER_EXTRA_ARGS`
— so launching from a mounted project still fell back to the home. The test is
now "is this path inside one of the container's bind mounts", which is the
question that was actually being asked: it keeps `/tmp` and `/usr` out and lets
a mounted project in. The fallback also says which mount is missing and prints
the `-v` line to add, rather than one dim line about not being visible.

**A relocated agent home needs `prinny-bot`'s `node_modules` too, 2026-08-26.**
`docs/container.md` said to copy the built runtime and verify with `--staged`,
which reports `current` and proves the source fingerprint matches. It does not
prove the channel can start. Where `PRINNY_BOT_PATH` names a local checkout the
runtime's `node_modules/@prinny/bot` is a symlink into it, and node resolves
through the symlink to the real path — so the bot's dependencies are looked up
in that checkout, not in the runtime. Omit them and every reader says healthy
until the sidecar throws `ERR_MODULE_NOT_FOUND` on `matrix-js-sdk`, which the
session surfaces as the far less specific "the channel is up but has not logged
into Matrix yet" — because the sidecar is up, and holding the account lock,
having failed a single import. The doc now says to import the module as the
check, rather than to trust the fingerprint.

**An unattended `/loop` could get stuck and stay stuck, 2026-08-27.** A run
against this stack produced nothing for 33 iterations and ~45 minutes of GPU,
and the loop's own escalation never fired. Four defects in a line, three of them
silent:

- **forge returned an empty 200 with no log line.** `FORGE_MAX_RETRIES=0` bounds
  the attempt loop at one; `FORGE_MAX_TOOL_ERRORS=2` bounds tool-error kinds at
  three. The second outlived the first, so the first malformed tool call left
  forge queueing a correction for an attempt it could not make, falling out of
  its own loop and returning `None` — an empty assistant turn with no usage, no
  finish_reason and nothing in the log. A tool call cut off at the token cap is
  exactly what produces it: truncated JSON does not decode to a dict.
  `patches/forge_empty_turn.py` (patch 8) makes exhaustion whichever budget runs
  out first, and makes both empty exits loud.
- **forge reported truncation as a natural stop, and dropped the reasoning, on
  the one path pi uses.** `_emit_text`'s own docstring said so: the OpenAI SSE
  path carried neither. llama-server reports `length` for a capped generation,
  streaming or not; forge said `stop`. `patches/forge_text_sse_passthrough.py`
  (patch 9).
- **the loop's stuck ladder could never pass rung 1.** An intervention zeroes the
  counter the next narration-only verdict needs, and the streak was cleared by
  any turn without a verdict — so the rescue model (3), the hard reset (3) and
  the compaction (5) were unreachable. Six interventions in that run, every one
  logged `stuckStreak: 1`.
- **an empty turn counted as narration**, so three of them — ~85 s of GPU each,
  carrying no answer, no tool call and nothing any text rule can read — were
  needed before anything fired. It now has its own rule and fires on the first.

Both loop halves are in `vendor/pi-loop-mode` (FORK.md, AP1/AP2). The image was
rebuilt: `test_forge_patches.py` 70/70, loop suite 295/295, smoke test 11/11.

**`pi-container.sh --session <id>` now starts in the session's own directory,
2026-08-27.** It used to need `-C /home/piuser` alongside it, and getting that
wrong was not an error: pi keys sessions on the directory they were started in
and looks one up by the key for the current directory, so `--session` from the
wrong place quietly starts a *new* session and leaves the one you asked for
untouched. The launcher now reads `cwd` out of the session file's own header —
not out of the directory name under `sessions/`, which is the path with every
`/` turned into `-` and cannot be decoded back. `--session-id` and `--fork` get
the same treatment; `--continue` and `--resume` deliberately do not, since both
already mean "for this directory". It refuses rather than guesses when an id
spans two directories or when the session's directory is not in the container,
and `-C` still wins while saying that pi will not find the session there.

`--print-only` now also prints the `docker exec` it would run, working directory
and all, when the container is already up — the create command was the half
nobody has to debug.

---

[← back to the README](../README.md)
