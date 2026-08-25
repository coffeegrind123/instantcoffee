# Reasoning effort and thinking language

`REASONING_EFFORT` — the 3.8 knob that will bite you — and reasoning in
a language other than the answer's.

## Reasoning effort — the 3.8 knob that will bite you

New in 3.8, and the reason release-day reports are full of 20-minute answers:
the model takes a `reasoning_effort` level, and **upstream's default is
`xhigh`**. At `xhigh` the template prepends

> *Reasoning effort is set to xhigh. Please think carefully through the task,
> validate key assumptions, consider plausible alternatives, and prioritize
> correctness, consistency, and clarity in the final answer.*

and the model does exactly that — public reports on release day include 22-36k
thinking tokens for a single SVG. Against `REASONING_BUDGET=4096` that is not
"slower", it is a truncation on **every** turn: the answer arrives mid-thought
with the budget message stapled to it.

This stack sets `REASONING_EFFORT=medium`, passed to llama-server as
`--chat-template-kwargs '{"preserve_thinking": true, "reasoning_effort": "..."}'`.

The accepted values, read out of the template embedded in the GGUF and confirmed
by rendering it:

| Value | What the template does |
| --- | --- |
| `xhigh` | Prepends the steering paragraph above. Upstream default |
| `high` | Silently rewritten to `xhigh` |
| `medium` | **Injects nothing at all.** What this stack runs |
| `low` | Prepends "keep your thinking brief and focused" |
| anything else | `raise_exception()` — the request fails |

That last row includes `none`, which several release-day write-ups list as a
fourth level. It is not one — *for this setting*. It also includes the empty
string, so never leave `REASONING_EFFORT=` blank in `.env`.

### But the API is a different path, and it does accept `none`

`REASONING_EFFORT` reaches the template through `--chat-template-kwargs`. A
**request** has two routes the template never sees first
(`tools/server/server-common.cpp:1073-1094`):

```jsonc
{"reasoning_effort": "none"}                              // thinking off entirely
{"chat_template_kwargs": {"reasoning_effort": "low"}}     // per-turn override
```

llama.cpp intercepts a top-level `"none"` and maps it to `enable_thinking=false`
before rendering, so it never raises. And a request's `chat_template_kwargs` are
merged **over** the server's, so a client picks its own effort per turn with no
restart. **forge forwards both** — verified end to end, content length through
forge tracked llama within 1% on identical prompts. Only `none` is special-cased
at the top level; `low`/`medium`/`xhigh` must go via `chat_template_kwargs`.

### Which level is actually worth it

Measured with `bench_quality.py` — 8 coding tasks, 5 hidden edge-case assertions
each, the model's code **executed**, LOC standing in for over-engineering:

| effort | pass% | LOC | reason chars | wall |
| --- | --- | --- | --- | --- |
| `none` | **100.0** | 283 | 0 | 36.3s |
| `low` | **100.0** | 205 | 30,235 | 136.9s |
| `medium` | **100.0** | **198** | 40,319 | 189.8s |
| `xhigh` | 90.0 | 254 | 83,868 | 495.7s |

`medium` stays the default: it is at 100% while writing the least code of any
level that passes, and the one level that loses assertions is the one writing
28% more.

**Three of those eight tasks were added on 2026-08-23 because the other five had
stopped discriminating.** On the five-task set every level scored 100% and the
bench could only compare verbosity. The new tasks — an arithmetic parser, an
interval overlap across mixed UTC offsets, and an RFC-4180 line parser — were
each chosen so the *obvious shortcut* fails the assertion carrying the contract.
That was verified by writing the shortcut and scoring it, not by assuming:
`float(eval(s))` gets 4/5 because it raises `SyntaxError` rather than
`ValueError`; `next(csv.reader([s]))` gets 4/5 because it accepts an
unterminated quote.

**Do not read the `xhigh` row as a regression.** The new set is not
deterministic the way the old one was, so a single grid cell is one sample. On
repeats, `medium` was clean in 5 of 6 and `xhigh` in 3 of 5 — the direction the
bench is built to detect, and not separable at that sample size. Re-check a
surprising cell with `--only <task> --level <level> --repeat <n>` before
believing it.

What the failures actually are is worth knowing, because it is the whole
argument against a high effort setting: a 99-line shunting-yard with a
nested-closure precedence table that **raises `ValueError` on valid input**. It
passes exactly one assertion — the one checking that malformed input raises —
and fails all four that ask it to compute something. A validator strict enough
to reject everything looks careful and does no work.

Historical, on the five-task set and **not comparable** with the table above
(denominator 25 rather than 40) — kept because it is what the `medium` decision
was originally made on: pre-V3 weights scored `none` 84.0 / `low` 96.0 /
`medium` 100.0 / `xhigh` 100.0, and the V3 weights took all four to 100.0.

Measure quality, not length: an earlier pass here compared output *size* and got
the answer backwards, because the whole complaint about `xhigh` is that it
produces **more** output, not less.

Raising it is a two-key change, not one: `xhigh` without a matching increase to
`REASONING_BUDGET` (and the context to hold it) just moves where the truncation
lands — and on this box the context cannot grow to make room, because 128K does
not fit at the measured desktop floor.

## Thinking in another language

`THINK_LANG=zh` appends `prompts/think-zh.md` to the client's system prompt,
which asks the model to reason in Simplified Chinese while keeping everything
that leaves the thinking block — prose, code, quoted text, and tool-call
arguments — in the user's language.

The claim comes from the 2026-08-11 HN thread: Qwen reasons best and most
cheaply in Mandarin because that is what it was most natively trained on. The
follow-up question in that thread — *better thinking, or just shorter?* — was
never answered, and nobody posted a measurement.

**`coding` mode turns this on, by operator decision, ahead of that measurement.**
It is running on a community claim, not a local result. `prose` mode sets it
`off` — the fragment is a page about verbatim tool arguments and code
identifiers, which buys a fiction session nothing. `THINK_LANG=off` in `.env`
reverts it anywhere, and the A/B below is how you find out whether it earns its
place in `coding`.

It costs nothing in readability on this stack specifically: the provider entry
declares `reasoning: false`, so pi never renders a thinking trace and you would
not be reading it anyway. The real risk is the opposite one — a model reasoning in
Chinese that then writes a Chinese character into an `old_string` or a file path
has produced a patch that does not apply.

That is what the A/B harness checks:

```bash
./scripts/up.sh                       # the stack must be running
./scripts/ab-think-lang.sh --repeat 3 # ~36 requests, both arms, thinking on
```

It runs six objectively-scored tasks with and without the fragment and prints:

| metric | baseline | think-lang |
| --- | --- | --- |
| mean score | … | … |
| mean reasoning chars | … | … |
| CJK in visible output | 0 | … |
| CJK in tool args | 0 | … |

Any Chinese in tool-call arguments exits non-zero and the verdict tells you not
to adopt it, whatever the score did. Since it is already on, treat a non-zero
exit as a signal to set `THINK_LANG=off` rather than as advice you can defer.

`pi-local.sh` prints `thinking in zh` in its launch banner whenever it is
active, so a session can never be running it silently.

Neither llama-server nor forge can inject a system prompt — verified, with the
receipts, in `prompts/README.md` — so this is applied by the launchers, and by
`ab_think_lang.py`, which takes `--system-prompt-file`.

Adding another language is a file: drop `prompts/think-<code>.md` and set
`THINK_LANG=<code>`. An unknown code fails the launch loudly rather than starting
a session without the prompt it was told to use.

---

[← back to the README](../README.md)
