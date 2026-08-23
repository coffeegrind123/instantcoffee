# What forge does to a tool-calling turn

*2026-08-23. Found on the first day of `context/design/workstream-capture.md`,
by holding a client-side tape and a model-side tape of the same three-turn
conversation next to each other. Every number here is from a matched pair on
the live stack; the two headline findings were then re-confirmed with plain
curl, no capture proxy in the loop, and traced to the line of forge source that
causes them.*

§1–§4 are the findings. §5 is what was done about them the same day: two
build-time patches, both measured against a separately tagged test image with
the running stack untouched. They are not live — a patch applies at image build
time, so the containers keep the old behaviour until someone rebuilds.

## 1. The model's own words never reach the client on a tool-call turn

Matched pair, identical request, no proxy of ours in the path:

```
   llama :8080   content   "I'm going to look up the current weather in Paris for you."
                 reasoning "The user wants me to say one sentence about what I'm about to do…"
                 tool      weather {"city":"Paris"}

   forge :8081   content   "The user wants me to say one sentence about what I'm about to do…"
                 reasoning  (no reasoning_content key at all)
                 tool      weather {"city": "Paris"}
```

The model said a sentence. The client received the model's **private
deliberation in its place**, and the sentence is gone.

The cause is not this repo's patches. It is structural, in
`forge/proxy/convert.py` at 0.9.0, and it is four lines:

```python
   reasoning = tool_calls[0].reasoning if tool_calls else None
   message = {
       "role": "assistant",
       "content": reasoning if reasoning_replay == "full" else None,
       "tool_calls": tc_list,
   }
   if reasoning and reasoning_replay == "keep-last":
       message["reasoning_content"] = reasoning
```

`tool_calls_to_openai` builds its response out of `ToolCall` objects, and a
forge `ToolCall` carries a `reasoning` field and no content field. The assistant
text that accompanied the call is not dropped at the last step — **it has
nowhere to live in forge's internal model at all**, so it never survives past
the client that parsed it.

This is the same shape as the bug `patches/forge_reasoning_passthrough.py`
already fixes for `TextResponse` — that patch's own docstring records the
symptom, "with the *previous* turn's deliberation forwarded as though it were
the answer". It fixed the text path. The tool-call path has the same hole, and
on an agent loop the tool-call path is nearly every turn.

Note what `reasoning_replay=full` does to the leak argument. The patch's
docstring is explicit that reasoning must not go into `content`, because pi maps
`reasoning_content` onto a *thinking* block while downstream consumers that
forward assistant output — the Matrix channel in `vendor/prinny-channel` —
allowlist `text` blocks only. On the tool-call path with `full`, the reasoning
**is** the text block.

Measured, both settings, same request:

| `FORGE_REASONING_REPLAY` | client's `content` | client's `reasoning_content` | model's sentence |
| --- | --- | --- | --- |
| `full` (current) | the reasoning | absent | lost |
| `keep-last` | `""` | the reasoning | lost |

`keep-last` closes the leak. Neither recovers the sentence.

## 2. Two smaller things on the same four lines

- **forge mints new tool-call ids.** `"id": f"call_{uuid.uuid4().hex[:8]}"` —
  the id the client sees is not the id the model emitted.
- **Arguments are re-encoded, not passed through.** `json.dumps(tc.args)`, so
  `{"city":"Paris"}` reaches the client as `{"city": "Paris"}`. Values survive;
  bytes do not.

The second matters to how `bench_literal.py`'s clean negative should be read.
That probe scores parsed field VALUES, which the re-encode preserves, so its
224/224 result stands exactly as recorded. But it is now a second reason —
alongside the grammar — that the article's *structural* failures are not
reachable through the forge path: a malformed envelope cannot survive a
parse-and-redump. Literal fidelity of string values is what that probe measures,
and the record should say so for both reasons.

## 3. forge rewrites the conversation before llama sees it

The client-side and model-side tapes of the same third turn, side by side:

```
   client -> forge                       forge -> llama
   system                                system
   user     "Apply this: …"              user     "Apply this: …\n\nNow confirm…\n\nNow confirm…"
   assistant + tool_calls                assistant + tool_calls
   tool     "applied ok, link up"        tool     "applied ok, link up"
   user     "Now confirm…"               assistant + tool_calls
   assistant + tool_calls                tool     "applied ok, link up"
   tool     "applied ok, link up"
   user     "Now confirm…"
```

Eight messages become six. **Every user turn after the first is folded into the
first user message**, so the newest instruction does not arrive last — it
arrives in the middle of the prompt, ahead of the assistant and tool turns it
was a response to.

The paired tape is what settles the attribution: the client-side capture shows
the driver sending user turns in their proper position, so this is forge, not
the test client. That control is the reason the capture proxy can sit in either
position.

## 4. And that rewriting pins the prefix cache

Three arms, same three-turn conversation, same server, each with its own nonce
in the system prompt so no arm warms another's cache. `cache_n` is llama's own
count of tokens it did not have to evaluate:

```
   arm                       turn 0            turn 1              turn 2
   direct (no forge)         0 / 395      391 / 517  75.6%    513 / 702  73.1%
   forge, keep-last          0 / 399      352 / 517  68.1%    352 / 635  55.4%
   forge, full               0 / 396      349 / 582  60.0%    349 / 754  46.3%
```

Read the `cache_n` column, not the percentage. Direct, the reused prefix
**grows** with the conversation: 391, then 513. Through forge it is **pinned**:
352, 352 — and 349, 349. It stops growing at exactly the point where the rewrite
begins, because a prompt whose first user message changes every turn shares no
prefix past that message.

`full` costs extra on top: 754 prompt tokens at turn 2 against 702 direct and
635 at `keep-last`, because the replayed reasoning accumulates in the history as
content.

**What this does and does not establish.** It is three turns at ~700 tokens on a
synthetic conversation, and llama has machinery — context checkpoints, and the
`f_sim_best` LCP-similarity slot selection this repo has seen reach 0.988 in a
real session — that can salvage reuse a naive prefix argument would miss. So
this is not yet "forge costs you a full re-prefill every agentic turn at 90k".
It is: **in a clean measurement, forge's history rewriting stops the reusable
prefix from growing, and the same workload without forge grows it.** That is a
throughput question worth an order of magnitude at depth, and the tape can now
answer it directly on a real session — `cache_n` is on every record.

## 5. Both are now fixed, and the fixes are measured

Written the same day as §1–§4, against a SEPARATELY TAGGED test image and a
throwaway forge container on a spare port, with the running stack never touched.
Neither is live: patches apply at image build time, so the containers in front of
you keep the old behaviour until somebody rebuilds.

**`patches/forge_toolcall_content.py`** gives `ToolCall` a `content` field, has
the llama.cpp client populate it at both native-mode sites, and has both
response builders emit the model's content as `content` and its reasoning as
`reasoning_content`. Matched triple, identical request:

```
   llama :8080            content "I'm going to look up the current weather in Paris."
                          reasoning "The user wants me to say one sentence…"
   forge :8081 unpatched  content "The user wants me to say one sentence…"   <- the reasoning
                          reasoning (no key at all)
   forge :8097 patched    content "I'll check the current weather in Paris for you."
                          reasoning "The user wants me to say one sentence…"
```

Same result on the streaming path, which is a separate builder
(`tool_calls_to_sse_events`) and was tested separately.

**The replay policy survives it, and lands in a better place.** `full` was set
for KV-prefix reuse via `preserve_thinking`, so the question is whether the
reasoning still reaches the backend. Captured between the patched forge and
llama, the assistant history message on turn 2 now reads:

```
   assistant  content="I'm going to check the current weather in Paris for you."
              extra=['tool_calls', 'reasoning_content']
```

Both fields, in the right places. Before the patch that message carried the
reasoning as `content` and no `reasoning_content` at all — which means the
replay was landing AFTER the `</think>` block instead of inside it, and could
never have reproduced the token sequence the model originally generated. The
patch does not weaken the preserve_thinking argument; it is the first thing that
makes it structurally possible.

**`patches/forge_merge_across_tools.py`** restricts `_merge_consecutive` to
messages that are truly adjacent, and puts the cross-tool case behind
`FORGE_MERGE_ACROSS_TOOLS=1`. Same three-turn conversation, one nonce per arm:

```
   arm                          turn 0        turn 1          turn 2        msgs
   direct (no forge)            0 / 395   391 / 517       513 / 702           8
   forge, unpatched             0 / 396   349 / 582       349 / 754           6
   forge, patched (default)     0 / 396   392 / 518       514 / 703           8
   forge, patched, flag ON      0 / …         …           350 / 697           6
```

The patched default reproduces the no-forge baseline to within a token — 514
against 513 — with the user turns back in their own positions
(`system,user,assistant,tool,user,assistant,tool,user`). The flag restores the
upstream behaviour exactly, which is what makes the row above it a measurement
rather than a hope: turn it on and the pinning comes straight back.

Note the third column of the unpatched row. `full` was also inflating the prompt
— 754 tokens against 703 — because the reasoning was being replayed as content
and accumulating. That goes away with the first patch, for free.

`./scripts/smoke-test.sh`'s eleven checks pass against the patched build,
including the real tool call.

**What is deliberately still not touched.** `forge/proxy/convert_anthropic.py`
has the same hole as §1 in a starker form: it appends the reasoning as a `text`
block and never emits the model's content at all. This stack's client speaks
OpenAI, and doing it right on the Anthropic wire means deciding how a `thinking`
block is shaped and signed. Prompt-mode extraction is left alone for a different
reason: with `FORGE_CAPABILITY=native` it is not on this stack's path, and in
prompt mode the call was parsed OUT of the text, so "the content that came with
it" is a genuinely different question.

## 6. How to reproduce any of it

```sh
   ./scripts/capture.sh on                    # forge -> capture -> llama
   #  …drive one real pi turn through forge…
   ./scripts/capture.sh index                 # three turns as three sessions = §3
   ./scripts/capture.sh off

   # the §1 pair needs no capture at all: the same request to :8080 and :8081
```

`scripts/capture_proxy.py --upstream http://<forge> --position client-forge`
run beside it gives the client-side half of §3's pair.
