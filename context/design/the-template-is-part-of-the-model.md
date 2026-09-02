# The template is part of the model, and the modes do not ship the same one

2026-09-02. Source: a second r/LocalLLaMA sweep for Qwen3.8 setups (the first is
`ngram-mod-and-the-load-confound.md`, 2026-08-31). Almost everything in it was
already measured and refused here. Two lines were not. A comment on `1w4ur6e`
asks a poster "Are you using the fixed chat template?" and `1w1lq7u` recommends
a third-party template "to use fewer thinking tokens". Neither says what is
being fixed, and neither is worth adopting. Asking *what a fixed template
fixes* is what produced this note.

**Verdict: four request shapes render on `coding` and return HTTP 500 on
`uc-coding` and `prose`, and forge reports every one of them as an opaque
`502 Backend returned 500` with the diagnostic discarded. One of the four,
`REASONING_EFFORT=high`, is a value `.env` and `docs/reasoning.md` both
described as safe. Nothing is broken at the pinned settings; the exposure is a
documented knob that is now a total outage on two of the three modes.**

## The thing that was not being looked at

`modes/uc-coding.env` opens with "The ONLY difference from coding is
MODEL_REPO/GGUF_FILE". That sentence is true of the file and false of the
behaviour, because a GGUF carries its own chat template and the two GGUFs do not
carry the same one. Read out of the headers with the same ranged-fetch reader
`scripts/gguf_probe.py` uses — off the Hub, no download:

| Mode | GGUF | `tokenizer.chat_template` |
| --- | --- | --- |
| `coding` | `unsloth/Qwen3.8-27B-GGUF` `UD-Q4_K_XL` | 9993 chars |
| `uc-coding` | `orcarouter/…-Uncensored-GGUF` `Q4_K_M` | 8952 chars |
| `prose` | `orcarouter/…-Uncensored-GGUF` `Q4_K_M` | 8952 chars |

8952 is not merely "smaller". It is **byte-identical to Qwen's own published
`chat_template.jinja`**, sha256 `c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041`
— confirmed by fetching that file from `Qwen/Qwen3.8-27B` and hashing it. The
9993-char one is a fork whose own trailing line says what it is:

    {#- Unsloth fixes - developer role, merged system messages, tool calling #}

So the model this stack serves runs the **stock** template and the model it
serves in `coding` runs a **patched** one. The patches are not cosmetic.

## What the fork changes

`diff` of the two, five hunks, in the order they appear:

1. **A leading RUN of system/developer messages is merged.** Stock renders only
   `messages[0]` as system and raises for any other system message anywhere.
   The fork accumulates a leading run into one `merged_system`, and treats
   `developer` as a system role.
2. **`reasoning_effort == 'high'` is rewritten to `'xhigh'`** before the
   membership test. Stock has no such line, so `high` falls through to
   `raise_exception('Unexpected reasoning effort high. Supported types are
   xhigh (default), medium, and low.')`.
3. **The `No user query found in messages.` guard is deleted.**
4. **Tool-call argument typing is checked**: a missing `name` raises with a
   sentence naming the problem, and `arguments` arriving as a JSON *string*
   raises "Parse them into an object before calling apply_chat_template"
   instead of reaching `|items` on a string.
5. A late system message raises **unconditionally** rather than via
   `loop.first`, which is the same refusal by a different route.

## Measured, on the live server, at the current pin

`scripts/template_probe.py`, run the house way inside the compose network:

```bash
docker compose --profile tools run --rm --build \
    --entrypoint python bench /work/scripts/template_probe.py
```

The llama column is `/apply-template`, which renders and generates nothing. The
forge column is one token through `/v1/chat/completions`, which is what the
operator's client actually does.

**This table was measured BEFORE patch 13** (below), which is why every forge
cell says the same thing. That is the finding, not a formatting choice. After
patch 13 the same run returns
`502 Backend returned 500: Unexpected reasoning effort high. Supported types…`
in those cells; the llama and control columns are unchanged.

| case | llama :8080 | forge :8081 |
| --- | --- | --- |
| one leading system · | OK 91 chars | accepted |
| system + developer | **500** | **502** |
| two leading system | **500** | **502** |
| late system message | **500** | **502** |
| `reasoning_effort=medium` · | OK 91 chars | accepted |
| `reasoning_effort=high` (kwargs) | **500** | **502** |
| `reasoning_effort=high` (top level) | **500** | **502** |
| tool args as object · | OK 1411 chars | accepted |
| tool args as JSON string | OK 1411 chars | accepted |
| ends on a tool result | OK 1383 chars | accepted |

`·` marks a control. Every control passes in the same run against the same
server, which is what makes the failing rows evidence about the template rather
than about the harness.

**Five rows fail, four of them are the difference from `coding`.** The fifth,
`late system message`, is refused by both templates — unsloth's hunk 5 keeps
that rule and makes it unconditional — so it is a property of Qwen3.8's template
family, not of the mode. The two `reasoning_effort=high` rows are one cause
reached by two routes: llama.cpp special-cases only `"none"` at
`server-common.cpp:1089-1094` and forwards every other value to the template, so
the top-level API field and `chat_template_kwargs` land in the same place.

The 500s carry the sentence. The 502s do not — this is the probe's own output,
after it digs the sentence out from behind minja's backtrace:

    llama:  FAIL HTTP 500: System message must be at the beginning.
    llama:  FAIL HTTP 500: Unexpected reasoning effort high. Supported types …
    forge:  FAIL HTTP 502: Backend returned 500

Verbatim from `docker logs instantcoffee-llama`, which is where the sentence
survives:

    W srv operator(): got exception: {"error":{"code":500,"message":"\n---------
    ---\nWhile executing CallExpression at line 49, column 28 in source:\n...',
    'low') %}↵        {{- raise_exception('Unexpected reasoning effort ' ~ reason
    ...\n   ^\nError: Jinja Exception: Unexpected reasoning effort high.
    Supported types are xhigh (default), medium, and low.","type":"server_error"}}

## Two hypotheses this measurement REFUTED

Both were read straight off the diff and both are wrong, which is the reason the
probe hits the server rather than reasoning about the template:

- **"OpenAI-wire `arguments` are a JSON string, so the stock template will call
  `|items` on a string and break."** It does not. llama.cpp parses the arguments
  into an object before templating; the string and object forms render to
  **identical 1411-char prompts**. The fork's guard is defensive, not a fix for
  anything reachable here.
- **"A message list ending on a tool result will hit `No user query found in
  messages.`"** It does not — that shape renders in 1383 chars. Deleting the
  guard (hunk 3) fixes a shape this stack does not produce.

So the fork's tool-calling changes buy nothing here. The system-message and
`reasoning_effort` changes are the whole of the difference that matters.

## Severity, honestly

**`reasoning_effort=high` is the one to act on.** It is not a per-request
concern: `REASONING_EFFORT` is baked into llama-server's launch flags in
`docker-compose.yml:93`, so setting it to `high` on `uc-coding` or `prose` means
**every request fails**, from a value both `.env` and `docs/reasoning.md`
listed as "silently rewritten to `xhigh`". That reading was correct when it was
taken — the pin was unsloth `UD-Q4_K_XL` then, and the pin moved on 2026-08-25
(the `[DIFFERENT STACK]` table in `ngram-mod-and-the-load-confound.md` is the
same event). The reading did not move with it. All three modes ship `medium`
today, so nothing is currently down.

**The system-message rows are NOT reachable from pi as this stack configures
it** — settled 2026-09-02 by reading pi's own shipped adapter rather than by
capturing traffic, because pi's session entries carry only
`user`/`assistant`/`toolResult` and the prompt is assembled at request time.

`dist/bundle/chunks/openai-completions-*.js` — the adapter this provider
selects (`"api": "openai-completions"`) — constructs `role: "system"` in exactly
two places:

1. `payload.messages.unshift({role:"system", content: systemPrompt})` — the main
   prompt, at position 0. Legal in both templates.
2. `let kimiToolMessage = {role:"system", tools: …}; params.push(kimiToolMessage)`
   — a MID-CONVERSATION system message carrying deferred tools, which is exactly
   the shape that raises. It is gated on `compat.deferredToolsMode === "kimi"`,
   a value `scripts/pi-local.sh` does not set for this provider.

The one `role:"developer"` in the bundle is in the **Responses API** path
(`convertResponsesTools`, `deferredToolsMode === "additional-tools"`), which
this stack does not take, and `pi-local.sh` sets `supportsDeveloperRole: False`
besides.

So both refusals are real and currently unreachable **from this client**. That
is a property of two flags in a generated config, not a property of the stack:
`supportsDeveloperRole: True` would make every turn on `uc-coding`/`prose` a
500. The flags and the reasoning behind them are corrected in `pi-local.sh` —
the comment there justified them on an ENGINE limitation that has since expired
(b10689 forwards `reasoning_effort`; measured, not assumed) and on "the MODEL
supports both", which was true of the unsloth template the stack stopped serving
on 2026-08-25.

What is measured either way is that **forge does not protect against these
shapes** — `_merge_consecutive` did not merge two adjacent system messages, and
a `developer` role passed straight through. Any other client hits them.

## What to do, cheapest first

1. **Done in this commit.** The `high` row in `docs/reasoning.md`, the
   `REASONING_EFFORT` block in `.env`, and the "ONLY difference" claim in
   `modes/uc-coding.env` now say which mode they are true of.
2. **DONE in this commit — patch 13, `forge_backend_error_detail.py`.** `502
   Backend returned 500` discarded the one string that identifies the cause,
   which is the same defect class `patches/forge_merge_consecutive.py` was
   written for ("forge returns to the client as an opaque HTTP 502").

   The obvious patch — append `exc.body` — is the wrong one. Upstream keeps a
   backend's raw body off the exception message **on purpose**, and says so in
   `forge/errors.py`: the message is logged and returned, and an intermediary
   can echo an inbound credential into a body. So patch 13 lifts only the
   `error.message` string out of a well-formed JSON error envelope — the shape
   a backend authors to be read — and leaves HTML, plain text, JSON arrays and
   message-less envelopes exactly where upstream put them. Status codes are
   untouched: a backend 500 is still forge's 502. `FORGE_BACKEND_ERROR_DETAIL=0`
   restores upstream's behaviour exactly, and default-on is a judgement about a
   loopback backend with no gateway, not a claim that upstream is wrong.

   Eighteen checks in `test_forge_patches.py` (115/115 in the image), including
   both directions of the flag — a test that only proves the new behaviour
   cannot tell a working flag from one that is never read — and the four
   "left alone" body shapes, which are requirements rather than edge cases: a
   patch that appended the raw body would pass the first check and fail those.

   Verified live after recreating forge, which is the same table as above with
   one column changed:

       502 Backend returned 500: Unexpected reasoning effort high. Supported
           types are xhigh (default), medium, and low.
       502 Backend returned 500: System message must be at the beginning.
3. **`--chat-template-file` is PLUMBED AND INERT.** `CHAT_TEMPLATE_FILE=` in
   `.env`, empty, so the flag is never passed and every measurement in
   `context/bench/` still describes the stack that produced it — confirmed by
   `docker compose config`, which resolves to zero occurrences of the flag.
   No new mount was needed: `/models` is already bind-mounted into llama, so a
   filename there resolves as `${MODELS_DIR}/<name>`.

   Getting a template out of a 16 GB artifact is the part that would otherwise
   stop this, so `scripts/gguf_probe.py --dump-template <repo> <file> <out>`
   now writes one from the same ranged header fetch the probe already used —
   no weights downloaded. Verified byte-for-byte against an independently
   extracted copy (`12827f24b742…`, 9993 bytes).

   **Left inert deliberately, and this is the reason to keep it that way:** a
   template swap changes the prompt bytes of every request. It invalidates the
   prefix cache wholesale, and the spec-decoding pin was chosen on the repeat
   workload against *this* prompt shape. unsloth's fork also merges a leading
   run of system/developer messages into one block, which is a different prefix
   on any turn carrying more than one — and the KV prefix cache is what
   `FORGE_MERGE_ACROSS_TOOLS=0` exists to protect. It would fix three of the
   four disagreements; a genuinely late system message is refused either way.
   Adopting it costs `./scripts/bench.sh --full` and a spec-sweep round to
   re-establish the numbers, which is a measurement campaign, not a config
   change.

## The transferable rule

**A GGUF is weights AND a template, and this repo's mode machinery only ever
treated it as weights.** `mode.sh` diffs samplers; nothing diffs the template
that ships with the file. Every claim in this repo of the form "read out of the
template embedded in the GGUF" is a claim about *one* GGUF, and it expires the
moment the pin moves. `scripts/gguf_probe.py` already reads the template's
length and capabilities off the Hub before a model is selected — what it does
not do is compare that template against the one currently in service.

---

[back to context/README.md](../README.md)
