# Modes: coding and prose

The two switchable regimes, the model behind each, and every sampler knob
they set. Applied with `./scripts/mode.sh` or `/stack mode` inside pi.

Nothing in this stack filters content. That was checked rather than assumed, on
2026-08-13:

| Layer | Finding |
| --- | --- |
| forge | No content filtering. Its `guardrails/` are tool-call plumbing — response validation, retry nudges, step enforcement. Removing them breaks tool calling and unlocks nothing. |
| pi | Its system prompt is mechanical: tool list, "show file paths", "be concise", cwd. **Zero** safety, refusal, or content language. `--system-prompt` replaces it wholesale anyway. |
| chat template | No refusal text, no injected default system prompt. |
| llama.cpp | No such feature exists. |

So if an uncensored model is behaving timidly here, the cause is configuration,
not a filter. Four things constrain output, and **`prose` mode already fixes the
first three** — they are listed so the reasoning is inspectable, not as a to-do:

1. **A sampler profile tuned for code.** `TEMPERATURE=0.6` is Qwen's "precise
   coding" preset, and XTC/DRY ship disabled. `prose` moves to 1.0 with DRY on.
2. **The MTP quant caps your sampling range.** DavidAU's card asks for
   `temp <= 1` and `repeat pen 1.0` on MTP quants, then separately recommends
   `repeat pen 1.1-1.15` for chat/roleplay and regular GGUFs "for creative/
   complex and/or temps over 1". Those conflict, and the card resolves it: use
   a non-MTP quant if you want to go above temp 1. `prose` sits at exactly 1.0,
   which is the highest the MTP quant tolerates.
3. **`THINK_LANG=zh`** appends a page of instructions about reasoning language,
   verbatim tool arguments and code identifiers. Not a filter, but dead weight
   in a fiction session. `prose` sets it `off`.
4. **pi loads the project's `AGENTS.md`/`CLAUDE.md` by default** — in a code
   repo that injects coding conventions into a writing session. This one is
   per-session, not per-mode: pass `-nc`, or `PI_CONTEXT_FILES=0`.

For a writing session, drop pi's coding tools too — it is an agent, and will
otherwise reach for `read`/`bash`/`edit`/`write`:

```bash
qpi -nt -nc --system-prompt "You are a literary fiction writer. Return only prose."
```

## Two modes

The stack ships two regimes. A mode is just a file of `KEY=VALUE` lines in
`modes/`; adding one means adding a file.

```bash
./scripts/mode.sh                    # which preset .env matches, and what differs
./scripts/mode.sh --list
./scripts/mode.sh prose              # rewrite .env
./scripts/mode.sh prose --restart    # ...and recreate llama
```

From inside pi, the same thing — the extension shells out to that script rather
than carrying a second definition of what "prose mode" means:

```
/stack mode                 # status
/stack mode prose           # switch, then offer the restart it needs
```

| | `coding` | `prose` |
| --- | --- | --- |
| model | unsloth `UD-Q4_K_XL` | `Qwen3.8-27B-Uncensored` `IQ4_XS` |
| temperature | 1.0 | 1.0 |
| DRY | off | 0.8 |
| `REASONING_EFFORT` | medium | medium |
| `THINK_LANG` | zh | off |

Both modes now sit at temperature 1.0. On 3.6 `coding` ran at 0.6, which was
Qwen3.6's separate "precise coding" preset; the 3.8 card publishes a single
thinking preset and it is 1.0, and the GGUF metadata says the same
(`general.sampling.temp=1.0`). The old **0.913 / 27-27** scorecard was measured
on 3.6 at 0.6; it described neither this model nor this temperature, and it was
deleted along with the rest of the eval harness rather than left to rot.

`prose` moved model as well as version. There is no 3.8 Fable-Fusion — DavidAU
had published one 3.8 model at migration time, with no GGUF — so the whole
Fable-Fusion card, including its `temp <= 1` MTP ceiling and its rep-pen ban,
is gone with it.

Since **2026-08-25** the model is
[`mradermacher/Qwen3.8-27B-OBLITERATED-i1-GGUF`](https://huggingface.co/mradermacher/Qwen3.8-27B-OBLITERATED-i1-GGUF)
(`i1-Q4_K_M`), an imatrix requant of
[`OBLITERATUS/Qwen3.8-27B-OBLITERATED`](https://huggingface.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED),
which publishes no GGUF itself. It was picked over five candidates because it is
the only 3.8 decensored build that removes **soft deflections** — the
safety-lecture-instead-of-substance answer — and not just hard refusals, while
still measuring what that cost: MMLU **84.5 -> 82.3**, a real **-2.1pp** that
sits outside the reported stderr. The damage is not uniform, and that is the
whole reason it is acceptable here: **STEM -3.3pp** against **humanities
-1.0pp**. A fiction regime spends its capability in humanities and pays in STEM,
which is the cheapest place on this model to take the hit — and exactly why it
must not be promoted to `coding`. It is also 714 MiB *smaller* than the coding
model, so it improves VRAM headroom rather than eating it. Weaker part of the
evidence, stated plainly: its refusal claim rests on manual auditing, not on a
held-out prompt set with a published count.

The runner-up is kept documented in `modes/prose.env` and `.env` rather than
discarded:
[`JonathanColetti/Qwen3.8-27B-Uncensored-GGUF`](https://huggingface.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF),
which has the best *evidence* of the field — Heretic refusal-direction removal
merged at bf16 (no quantized round trip), **12/100 refusals against the base
model's 98/100** at KL 0.1191 off a published 23-point Pareto front, and a mean
0-shot capability delta of **-0.5** across MMLU/ARC-C/HellaSwag/Winogrande, every
delta inside stderr. It keeps more capability and refuses more often. **If one
model ever has to serve both regimes, use that one, not OBLITERATUS.**

Operationally the thing to check in any replacement is the MTP head: abliteration
re-saves through transformers, which silently drops `blk.64` while `config.json`
still advertises it, and `--spec-type draft-mtp` then dies on a file that looks
correct. Read the GGUF header off the Hub *before* downloading — 866 tensors,
`block_count=65`, `nextn_predict_layers=1`, `blk.64.nextn.*` present. This README
used to claim most decensored 3.8 GGUFs fail that check; re-measured on
2026-08-25 across the five most popular (JonathanColetti, huihui `UD-Q4_K_XL`,
huihui `Q4_K`, HauhauCS `Q4_K_P`, mradermacher OBLITERATED `i1-Q4_K_M`), **all
five passed**. The check is still worth running on anything new — the failure is
silent — but it is not the common case it was written up as.

DRY stays at 0.8 in `prose` as a preference now, not as a card requirement: it
penalises repeated *sequences* rather than repeated tokens, which is what keeps
long fiction from collapsing into the same phrasing without flattening style the
way a flat repeat penalty does. `DRY_MULTIPLIER=0.0` gives Qwen's preset
unmodified.

Known cost of the prose model, stated by its publisher: the draft head was
trained against the unmodified weights, so MTP acceptance may fall. Speculative
decoding verifies every drafted token against the target, so that is a decode-
speed risk and never a quality one.

> **`max_tokens` bites in prose mode.** This is a thinking model with
> `REASONING_BUDGET=4096`, so a request must leave room for the thinking block
> *and* the prose. Measured: a "150 word noir scene" used 4212 chars of
> reasoning and returned 913 chars of story — 1286 completion tokens. Ask for
> `max_tokens=400` and you get an **empty** `content` and
> `finish_reason=length`, because llama's `--reasoning-format deepseek` puts the
> thinking in `reasoning_content` where a naive client never looks. Keep
> `max_tokens` well above the reasoning budget, or set `REASONING_BUDGET=0` and
> switch to Qwen's non-thinking preset (`temp 0.7, top_p 0.80, presence 1.5`).

## The knobs

Every sampler this build supports is wired through `.env`, and each ships at
llama.cpp's **disabled** value, so `coding` is Qwen's published preset and
nothing else. The chain runs:

```
penalties -> dry -> top_n_sigma -> top_k -> typ_p -> top_p -> min_p -> xtc -> temperature
```

`prose` mode sets the first four already. The remaining dial worth reaching for
is **XTC** ("exclude top choices"), which drops the most-probable tokens when
several are plausible — the one sampler here aimed squarely at stopping prose
collapsing into the same phrasings. Neither card mentions it, so it is left off:

```bash
XTC_PROBABILITY=0.5
XTC_THRESHOLD=0.1
```

Prefer **DRY** over `REPEAT_PENALTY` for prose. A flat repeat penalty also
punishes ordinary function words and flattens style — which is the problem
`smoothing_factor` is usually reached for.

> The model itself is not the limiter: Heretic took refusals from **98/100 to
> 12/100** on the 3.8 base, per the card's own measurement. (The 3.6 prose model
> this replaces measured 99/100 → 4/100 by the same method — a different weight
> edit on a different base, so the two numbers are not a regression, they are
> different experiments.)

---

[← back to the README](../README.md)
