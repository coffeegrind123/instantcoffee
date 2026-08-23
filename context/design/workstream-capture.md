# Recording what the model actually saw

*2026-08-23. Closes item 2 of §7 of
`context/design/inference-divergence-and-this-stack.md` — "start keeping real
workstream captures", the item that document says every remaining fidelity
experiment is gated on. Ships `scripts/capture_proxy.py`,
`scripts/capture_sessions.py`, `scripts/capture.sh`, the `capture` and
`sessions` compose services, and 98 unit checks across two suites.*

The KLD run that would settle q8_0-vs-f16 needs a corpus, and the article that
prompted it says its own strongest secondary finding is that top-1 disagreement
is **prompt-dependent** — it clusters on content. A synthetic filler file would
understate it. So the corpus has to be a real workstream with real tool calls,
and until today nothing on this stack kept one.

## 1. What was already there, which the handoff overstated

The previous handoff said "nothing captures real workstreams yet". That is too
strong, and checking rather than believing it is what turned up the rest of this
document.

**pi keeps its own transcripts**, at
`~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`. On this box that is 706
recoverable turns across two projects, including a 150-turn session with 162
tool calls whose deepest prompt is 93,876 tokens, and a 34-turn one at 94,792.
Real long-context tool-heavy work, sitting on disk, being ignored.

`capture_sessions.py --import-pi` reads them. What it cannot invent is what they
do not contain, checked against a real transcript rather than assumed:

```
   role=assistant, role=toolResult, per-turn usage, stopReason, compaction
   NO role=system record anywhere          -> no system prompt
   NO JSON-Schema `properties` anywhere    -> no tool schemas
```

Those two absences are most of the prompt, and they are precisely the surface
the divergence article's failures live on — a tool-call envelope and its
arguments. **They have since been measured, by the corpus control in §6 doing
its job on real data.** Exporting the deepest imported session — 150 turns, 162
tool calls — produced:

```
   CONTROL: server reported 94164 tokens for this exchange, the corpus
            tokenizes to 88185 (delta -5979) -> SUSPECT
   exit code 1, and the tool says: do not run a fidelity measurement on this
```

**5,979 tokens, 6.3% of the prompt, and the part that carries the failure
surface**: `tools=0` in the sidecar. So a KLD run fed from a transcript would be
measuring a prompt the model never saw, and would look entirely reasonable while
doing it. `--allow-gaps` writes the file anyway, for whoever wants prose-at-depth
rather than tool fidelity, but the exit code stays 1 and the sidecar keeps the
delta. So every imported record carries `"gaps": ["system_prompt",
"tool_schemas"]`, and `--export` refuses to build a KLD corpus from a gapped
record without `--allow-gaps`. A transcript is a reconstruction of the
conversation; it is not the token stream.

Three more things about pi's transcripts were only learned by running against
real ones, and each would have silently corrupted a corpus:

- **`/loop` injects its per-iteration prompt as a `custom_message`, not a
  `message`.** The first cut walked `type == "message"` only, so the opening
  request of every looped session came out with an EMPTY message list — the
  instruction the entire session is executing, missing.
- **pi's usage keys are not OpenAI's, and `input` EXCLUDES the cached prefix.**
  Measured: `input 829 + cacheRead 10839 + output 1159 == totalTokens 12827`,
  exactly. Reading `input` as `prompt_tokens` understates a cached turn by an
  order of magnitude — and depth is the axis these captures exist to measure.
- **`compaction` records rewrite history.** Ignoring them leaves every later
  record claiming a history the model never saw. The importer truncates to the
  summary and flags those records `compaction_reconstructed`, because the exact
  framing pi puts the summary in is not in the transcript and is therefore
  inferred, not observed.

## 2. Where the tape is taken, and why the position is in every line

```
   pi -> capture -> forge -> llama     position: client-forge
       what the agent ASKED FOR. Additive — nothing restarts, only the client's
       base URL changes. Does not show forge's rewrites.

   pi -> forge -> capture -> llama     position: forge-llama    <- the default
       what the model SAW: pi's system prompt and tool schemas are on the wire
       by now, and so is every transformation forge applies.
```

Only the second can feed a fidelity measurement. §4 below is what happens when
you have both at once, and it is the reason the position is recorded on every
single line rather than inferred from a filename.

Inserting it costs one forge restart — seconds, and nothing warm is lost, since
the KV cache lives in llama, which does not move. `./scripts/capture.sh on`
writes the override into `.env.local` (gitignored, so a capture session cannot
be committed by accident) and `off` takes it out again.

## 3. Rules the recorder obeys, and the one that earned itself on day one

- **A recording failure never fails a request.** Every write is wrapped, and so
  is the call site — because an exception escaping the handler would kill the
  keep-alive connection an httpx pool is holding, which is a real behavioural
  change caused by a tape bug. The self-test installs a recorder that raises on
  every call and then makes a SECOND request down the SAME connection; with the
  call-site guard removed that check fails with `RemoteDisconnected`, which is
  how we know it is load-bearing rather than decorative.

  **It paid for itself immediately.** The first live run of the compose service
  logged

  ```
     [capture] recorder write failed (PermissionError(13, 'Permission denied')); proxying unaffected
  ```

  and kept serving. Docker Desktop presents a bind mount as root:root 0755 and
  the image's `forge` user (uid 1000) cannot write to it — the same reason the
  downloader is run `--user 0:0` against `MODELS_DIR`. The tape was empty and
  **said so**; the alternative is a healthy-looking recorder quietly recording
  nothing, which is the failure this whole exercise exists to avoid.

- **No buffering of a stream.** SSE is forwarded chunk by chunk with `read1()`
  and an explicit flush, re-framed as chunked transfer. The control: the
  self-test's fake upstream sends one chunk, sleeps 0.6s, then sends the rest,
  and requires the client to have seen bytes before that sleep ended. An edit
  that accumulates the body and writes it once returns a byte-identical response
  and would pass every content assertion; this is the only check that catches it.

- **Only completion-shaped paths are recorded.** `/health` alone is 5,760 lines
  a day at the compose interval. Everything else is forwarded and counted.

- **Credentials are never written.** Authorization / X-Api-Key / Cookie are
  forwarded and forgotten; the only header kept is user-agent.

- **The tape is capped and says when it stops.** Requests carry the whole
  conversation, so a session's bytes grow quadratically in its turns — a
  200-turn session at 90k tokens is ~80 MB. Past `--max-bytes`, RECORDING stops
  and proxying does not, with a `recorder_stopped` line and a stderr warning.

## 4. What a line holds that the wire did not appear to

`usage` is absent from an SSE stream unless the client asks for it, which pi
does not. The counts are there anyway, under `timings`, and the mapping was
verified against a matched pair rather than assumed:

```
   non-streamed:  usage.prompt_tokens 509   cached_tokens 383   completion 226
   its timings:   prompt_n 126   cache_n 383   predicted_n 226
                  -> prompt_n is what was EVALUATED; the total prompt is
                     prompt_n + cache_n, and predicted_n is completion_tokens
```

So the recorder derives usage from timings when the server did not send it, and
marks it `derived_from: "timings"` so it can never be mistaken for what the
server itself reported. `timings` also carries `draft_n` / `draft_n_accepted`,
so **every record gets its own speculative-decoding acceptance** — the only
other place this stack can see that number is llama's log, where it is a line
per task with nothing tying it to the request that caused it.

## 5. Rebuilding a workstream out of a flat tape

Nothing on the OpenAI wire carries a session id. What an agent does is resend
the whole conversation with one more message on the end, so the tape chains on
content: every line carries a per-message SHA-1 list, and sessions are built by
longest common prefix over those lists. Joins are classified, not smoothed over:

```
   continuation  lcp == len(previous)     one turn appended, the ordinary case
   retry         lcp == len(both)         identical list resent
   rewrite       0 < lcp < len(previous)  history was EDITED
   new           below the floor          a different workstream
```

A `rewrite` is the interesting one: it means the token stream was not the
previous prompt plus a suffix, so any prefix-cache reasoning about that turn is
wrong. §4 of `forge-on-the-tool-call-path.md` is what happened when the index
showed three consecutive turns of one conversation as three separate sessions.

Two floor rules earned their place in the self-test: a full-prefix match is
accepted at any length, **except** when the shared prefix is nothing but a
system message — two unrelated sessions of the same agent share that
byte-for-byte — and a truncation that drops below half the previous list starts
a new session rather than pretending a compaction was a continuation.

## 6. The corpus, and the trap in building one

`llama-perplexity --kl-divergence-base` wants a plain text file that IS the
token stream. So `--export` takes the deepest record of a workstream, appends
the assistant turn the model actually produced, and renders the whole thing
through the live server's own `/apply-template` — the real Jinja template with
the real tool block, not a reimplementation.

**The obvious way to do that is wrong, and wrong silently.** Measured against
the live server:

```
   [user, assistant(content="A1")]
       -> ...<|im_start|>assistant\n<think>\n\n</think>\n\nA1
          a PREFILL: no <|im_end|>, no generation prompt

   [user, assistant(tool_calls=[...])]
       -> ...<|im_start|>assistant\n<think>\n\n</think>\n\n
          THE TOOL CALL IS GONE
```

The template only emits a tool-call block for an assistant turn that is **not
last**. A corpus built the obvious way ends just before the tool call — the one
thing the KLD run exists to look at — and looks perfectly healthy while doing
it. So the final assistant turn is rendered in HISTORY position: a sentinel user
message is appended after it, and everything from the sentinel's own
`<|im_start|>` is cut. The cut is asserted, not hoped for.

And then the control, which is the part worth copying. The corpus is tokenized
by the same server and compared against what **the server itself reported** for
that request, `usage.prompt_tokens + usage.completion_tokens`:

```
   naive prefill render :   833 tokens  (server said 905)  delta -72   tool call LOST
   sentinel-cut render  :   905 tokens  (server said 905)  delta  +0   tool call present
```

An exact reconstruction of the token stream, pinned by the server's own counter.
A delta of hundreds is what a corpus that has quietly lost the tool block, or
dropped reasoning, or double-rendered a turn looks like — and without the
control it looks like a file.

## 7. What this does not do

- **It does not decide anything about q8_0 KV.** It builds the corpus that
  measurement needs. The run itself still costs a llama stop and still caps at
  ~64K for the f16 arm.
- **It does not capture anything until someone turns it on.** `capture.sh on`
  is a deliberate act, and `off` puts the stack back.
- **A `client-forge` tape is not a fidelity tape.** It is what the agent asked
  for. Only the `forge-llama` position sees what the model saw — which, as it
  turns out, is a different conversation.
