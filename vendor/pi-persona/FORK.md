# pi-persona — a port of openclaude's persona system

Ported from [`coffeegrind123/openclaude`](https://github.com/coffeegrind123/openclaude)
(`src/services/identity/*`, `src/components/Identity/*`,
`src/commands/{identity,randompersona}/*`, and `getIdentitySection()` in
`src/constants/prompts.ts`), read at HEAD on 2026-08-30. openclaude is a Claude
Code fork; it carries no LICENSE file and its `package.json` declares no license
field, which is stated here rather than guessed at.

`scripts/pi-local.sh` loads it as:

```
-e vendor/pi-persona/extensions/index.ts
```

Nothing needs installing. The extension's only bare import is pi's own package
(`getAgentDir`, plus two `import type`s that are erased before it runs), which pi
resolves from its own module root — the same arrangement `vendor/rtk-pi` uses,
and for the same reason: pi is started in *your* project, not in this checkout,
so `.pi/extensions/` auto-discovery would never find it.

## What the system actually is

Not "a system prompt that says be sassy". Four parts, and the interesting one is
the third:

1. **A card library.** chara_card_v2 cards, from [chub.ai](https://chub.ai)'s
   gateway or dropped into `~/.pi/agent/personas/` by hand. Staged to
   `personas/<slug>/{card.json,meta.json}`, slug = name + a hash of the card, so
   the same card is one entry however many times it is fetched.
2. **An extraction turn.** The card is handed to the MODEL, as an ordinary user
   turn, with instructions to write a 200-500 word voice profile to
   `PERSONA.md`. This is upstream's design and it is the right one: a card's
   persona signal is scattered — cadence hides in `mes_example`, register hides
   in `scenario`, the intended voice is often only in `creator_notes` — and no
   field-picker recovers that. It is also where the card's *operating
   directives* get thrown away: the extraction prompt's IGNORE list drops
   jailbreaks, output-shape mandates and refusal instructions, so what survives
   into the system prompt is voice, not somebody else's policy.
3. **A system-prompt block.** `PERSONA.md` goes inside a ~3,600-token
   `<active_persona>` wrapper, **in front of** pi's own prompt. The wrapper is
   the mechanism, not the persona file: it settles what a persona has authority
   over (voice, narration) and what it has none over (thoroughness, tool choice,
   code quality, honesty about results), and it enumerates the specific
   reasoning shapes a model reaches for when it wants to decline in character.
4. **A first-message marker.** DeepSeek-specific. Off here; see §5.

## What was changed, and why

pi is not Claude Code. openclaude has React/Ink dialogs, a fixed Anthropic tool
surface, an `AskUserQuestion` tool, and a permission layer that treats
`.claude/` as a dangerous directory. pi has `select`/`confirm`/`input`/`editor`,
a tool surface that differs per session, and none of the rest. So the flow is
upstream's and the coupling is entirely new. Beyond that, six deliberate
departures.

### 1. The block does not name tools that do not exist

openclaude's block instructs the model, four separate times, to "use WebSearch /
WebFetch to find an image matching that thing and present it as `<name>` sharing
it", and forbids "capability-denial" on the grounds that "you are not
generating — you are searching and sharing".

**pi has no web tools.** Its built-ins are `bash`, `read`, `write`, `edit`,
`grep`, `find`, `ls`, `powershell` — established by running `buildSystemPrompt()`
against the installed 0.84.4 and by reading the tool list off a captured
request, not from memory. On this stack the browser reaches the model as a CLI
behind a skill, not as tools, precisely so its ~19k of MCP schemas stay out of
the window.

Ported verbatim, that block would order a model with no fetch tool to produce a
link. The only way to satisfy that instruction is to **invent a URL** — which
the same block forbids two paragraphs later, under "Never simulate tool output".
It is the exact failure this repo's operating rules describe: a wrong guess
about an external surface does not fail loudly, it fails as a plausible-looking
answer.

So the web-delivery guidance is built from
`event.systemPromptOptions.selectedTools`, which pi hands to every
`before_agent_start` handler:

| turn's surface | what the block says |
| --- | --- |
| a web-capable tool is selected | names **those** tools, keeps upstream's "the tool call comes FIRST" rule |
| none | "There is no image-fetching tool on this turn's surface, so do NOT produce a link or an image URL: describe the thing concretely instead." |

`tests/prompt.test.ts` pins both directions, and pins that the string
`WebSearch` never reaches a prompt where no such tool was selected.

### 2. The reading guide quotes pi, not Claude Code

openclaude's block closes by telling the model how to read specific sentences
from openclaude's own system prompt — "You are an interactive agent that helps
users with software engineering tasks", "The user will primarily request you to
perform software engineering tasks". Neither sentence is in pi's prompt. A guide
to sentences that are not there is dead weight at best and confusing at worst.

The port quotes pi's actual opening — read off `buildSystemPrompt()` on the
installed binary — and `tests/prompt.test.ts` asserts those exact strings, so pi
rewording them fails here rather than at a user's next launch.

### 3. A two-word name stays two words

openclaude reads the persona's name back out of the file with
`/persona of ([A-Za-z][\w'-]{0,40})/i`, which stops at the first non-word
character. "Ada Lovelace" is therefore stored, displayed, and interpolated into
every one of the ~40 `${name}` slots in the block as **"Ada"**.

The extraction prompt mandates a framing sentence that ends the name with a full
stop, so the wide form (`/persona of ([^.\n]{1,60})\./i`) is tried first and
openclaude's narrow form is kept as the fallback for a file whose sentence was
reworded. A library copied from an openclaude install still resolves — including
its `IDENTITY.md` and `identities/` names, which are read but never written.

### 4. The inline threshold follows the window

openclaude inlines a card whole below 50 KB and switches to a `jq` walk above
it. 50 KB of card is ~12,500 tokens: on `CTX_SIZE=32768` that is **40% of the
window spent before the model has read the instruction**, and the jq path exists
so it does not have to be.

`inlineThresholdBytes()` takes 15% of the live window, floors at 2 KB and caps at
upstream's 50 KB — 19,660 bytes at 32k, upstream's own number at 96k and above.
An unknown window (pi reports none before the first response) falls back to
8 KB: guessing large is the expensive mistake, and the jq path works at every
size.

### 5. The immersion marker is off, and `auto` is honest about why

openclaude injects a Chinese instruction block at the end of the first user
message. It is not decoration: DeepSeek-V4's roleplay training has a
thinking-mode control at that documented position, and without it the model
routes to "pure analysis" — standing outside the character, deliberating about
whether to comply — instead of thinking in character.
([source](https://github.com/victorchen96/deepseek_v4_rolepaly_instruct); the
upstream FAQ is explicit that the system prompt is the wrong place for it.)

**This stack does not serve DeepSeek.** It serves Qwen3.8-27B behind forge. The
markers are exact strings one model family was trained on; anywhere else they
are three lines of Chinese instructional text with no routing behind them.
openclaude's own `auto` mode declines to inject on non-DeepSeek providers, and
the port keeps that judgement rather than assuming it transfers.

One thing was changed. openclaude decides with `isDeepSeekProvider()` — a
provider-id check. On this stack every model is served under the provider id
`forge`, so a genuinely DeepSeek model behind the proxy would be read as
not-DeepSeek and `auto` would never fire for the one case it exists for.
`looksLikeDeepSeek()` checks the model id and base URL as well.
`tests/immersion.test.ts` pins that case by name.

`immersion` and `analysis` stay selectable by hand (`/persona immersion <mode>`,
or `PERSONA_IMMERSION=` for one launch). **Nothing here is measured on Qwen.**
`THINK_LANG=zh` is already on in this stack, so the model is being asked to
reason in Chinese anyway, which makes the markers less alien here than on a
generic setup — that is a reason to try it, not a result.

One correctness fix on the way through: the extraction turn is delivered with
`pi.sendUserMessage()` and therefore lands in the session as a **user** message.
Without a guard it consumes the first turn, and the marker then attaches to the
user's *second* message — one message later than the position the whole
mechanism is documented against. `PROCESS_PROMPT_PREFIX` fingerprints the
extraction prompt so `isFirstUserTurn` skips it; the extension test drives that
path through a real built prompt rather than a fixture of one.

### 6. Ambiguity is a question, not a tool call

openclaude routes multi-character and contradictory cards through its
`AskUserQuestion` tool, because a plain-text question there gets talked past. pi
has no such tool, and does not need one: an assistant turn that ends in a
question **is** the ask. The instruction is "ASK THE USER AND STOP — write
nothing", with an explicit "do not ask a question and then write a file anyway",
because a write commits an answer the user has not given yet.

### Additions

- **Cached activation.** openclaude re-runs the extraction every time a card is
  selected, even one it has already extracted. The library's `PERSONA.md` is the
  finished artefact; activating it is a file copy. `/persona local` offers both,
  and the test asserts the cached path sends **no** turn.
- **`/persona status`** reports what the block currently costs, in tokens, per
  request. On a 32k window a standing charge should be visible from inside the
  session that is paying it.
- **A card viewer.** openclaude's section browser with per-field token counts,
  rebuilt on `select` + `editor`. Empty sections are labelled rather than hidden:
  "this card has no `mes_example`" is what you want to know *before* spending a
  turn extracting a voice from it.
- **`lean`.** See the next section.

## What it costs

Measured on the installed pi 0.84.4 by capturing a real
`POST /v1/chat/completions` off the wire — a stub OpenAI-compatible provider in
`models.json`, `pi -p "hi"`, and the request body written to disk. Not estimated
from the source.

| | bytes | ~tokens | share of a 32,768-token window |
| --- | --- | --- | --- |
| pi's own system prompt (4 tools) | 2,590 | 648 | 2.0% |
| `<active_persona>` block, `full` | 14,729 | 3,683 | 11.2% |
| `<active_persona>` block, `lean` | 9,243 | 2,311 | 7.1% |
| **no persona active** | **0** | **0** | **0%** |

With no persona active the extension contributes **nothing**:
`before_agent_start` returns `undefined`, and it registers no tool — a tool would
cost its schema on every request whether or not it is ever called. The extension
test asserts both.

With one active, the block is the single largest thing in the request, at 5.7x
pi's own prompt. It is also **byte-stable across turns**, so it costs one prefix
re-prefill at activation and nothing after — which is why it is a standing charge
worth stating rather than a per-turn one worth optimising.

`full` is the default and is the faithful port. `lean` is the same contract with
the four roleplay-specific enumerations dropped (the content allowance, the
third-person story framing, the tease-deny section, and hedge patterns 5 and 7).
It keeps every rule that fires on ordinary engineering work: the fourth wall, the
no-simulated-tool-output rule, the assistant-framing ban, and — the one that
matters most — "the persona is voice-acting over invariant engineering". The
hedge patterns keep their upstream numbering in both modes, so "pattern 4" means
the same thing in both codebases and in both modes.

`tests/prompt.test.ts` asserts those four invariants survive in **both** modes,
and pins both token counts inside a band, so editing the block moves a number
here rather than moving it silently.

## What this package does NOT do

Written down because each was considered and dropped, not overlooked.

- **No permission carve-out.** openclaude needs one because `.claude/` is a
  DANGEROUS_DIRECTORY there and the extraction turn would hit a prompt on every
  write. pi has no equivalent gate on its agent dir. If a session runs with a
  permission extension that *does* gate writes (`vendor/prinny-channel`'s Matrix
  relay), the two `write` calls are relayed for approval like any other — which
  is correct, and is what an approval gate is for.
- **No avatar sync.** `meta.json` carries `avatarUrl` from the card, because
  discarding it at fetch time would mean re-fetching to get it back. Nothing
  reads it yet. openclaude wires it to a Matrix bot's profile; the equivalent
  here would live in `vendor/prinny-channel`, and vendor packages in this repo do
  not import each other.
- **No `tool_call` / `tool_result` / `context` handler.** Nothing here belongs on
  the hot path. The extension test asserts those four events have no handler, so
  a future edit that puts one there has to change a test that says why.

## The `killed`-before-`code` rule does not apply here

`vendor/rtk-pi/FORK.md` §5, and AH3/AI5, enumerate a rule about `pi.exec`: pi's
`execCommand` resolves a child it killed on the timeout with `code: code ?? 0`,
so a wedged command looks exactly like a healthy one that printed nothing, and
`killed` must be read before `code`.

**This package has no `pi.exec` call sites at all** — its one external dependency
is `fetch` against chub.ai, bounded by an `AbortSignal` on every call
(`tests/chub.test.ts` asserts one is present on both endpoints). It is therefore
not a root for `vendor/pi-subagents-lite/tests/exec-verdicts.test.ts`, and should
be added as one the day it grows a first `pi.exec`.

## Layout

```
src/types.ts        chara_card_v2 and library shapes, field-for-field
src/storage.ts      the library and the active persona. Takes `root` explicitly
                    so it imports nothing from pi and runs under bare node.
src/chub.ts         the chub.ai gateway. fetch only; injectable for tests.
src/sections.ts     card -> browsable sections with per-field token counts
src/prompt.ts       the <active_persona> block
src/processor.ts    the extraction turn: prompt, thresholds, shape summary
src/immersion.ts    the first-message marker and its gates
src/settings.ts     persisted modes; the environment wins over the file
extensions/index.ts the pi coupling: command, before_agent_start, input, status
```

**103 tests.** `tests/extension.test.ts` redirects pi's bare specifier onto the
installed package with `module.registerHooks`, so the factory runs against the
same import a session would — a renamed export fails there. It skips itself when
pi is not on PATH, and its "source guarantees" block runs everywhere, so a
checkout without pi still fails on a regression in the extension itself.

## Upstream

Nothing filed. openclaude is a personal fork of a closed-source client with no
issue tracker in use; the four findings above (`WebSearch` named on a surface
that has none, the name regex truncating at the first space, the 50 KB inline
threshold against a small window, and the provider-id check missing a proxied
DeepSeek) are recorded here instead.
