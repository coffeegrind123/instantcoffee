# Thinking, and what replaced reasoning effort

On the local branch this page was about `REASONING_EFFORT` — a Qwen3.8 template
knob whose upstream default ate any budget you gave it — and about `THINK_LANG`,
a client-side fragment that made the model reason in Mandarin. Neither survives
the move to the hosted Anthropic API, and neither should: both were workarounds
for a 27B whose reasoning was the weakest part of it. A frontier model does its
own thinking, and what is left to decide is how much of it pi asks for and what
it costs.

## What is gone

- **`REASONING_EFFORT` and `REASONING_BUDGET`.** They were llama-server launch
  flags — `--chat-template-kwargs '{"reasoning_effort": …}'` and
  `--reasoning-budget` — and there is no llama-server. Which level was worth it,
  and the measurement that settled it (medium passed everything while writing the
  least code), is history now: `docs/changelog.md` and
  `context/design/the-template-is-part-of-the-model.md`.
- **`THINK_LANG`, and the Chinese-reasoning fragment it pointed at.** The
  fragile half of that idea was never the score, it was the leak: a model
  reasoning in one language that then writes a character from it into an
  `old_string`, a file path or a tool-call argument has produced a patch that
  does not apply. On the local branch that risk was accepted by operator decision
  ahead of any measurement, resting on a community claim that Qwen reasons best
  in Mandarin. On this branch the fragment is gone, and so is the harness that
  would have A/B'd it — a frontier model does not need to be told which language
  to think in, and a page of system prompt on every request is the wrong price
  for the instruction.
- **The reasoning-replay knobs and the template probe.** `FORGE_REASONING_REPLAY`,
  the chat-template override, the probe that asked which request shapes the
  active template refuses — all properties of a local engine whose template
  ships inside the weights. None of them has an analogue here.

None of this was a downgrade. Reasoning on the local stack was something the
*stack* had to arrange and then defend; here it is something the provider does,
and the whole class of "the proxy dropped the reasoning field" defects is gone
with the proxy.

## What is left: thinking on the Anthropic path

pi's built-in `anthropic` provider drives the Messages API, where thinking is a
real per-request feature rather than a server launch flag. pi exposes it as a
thinking level, and the orchestrator's agent types pin their own:
`prompts/orchestrator/agents/worker.md`, `.../explorer.md` and `.../advisor.md`
all declare `thinking: high`, because planning and implementation are the two
jobs where deliberation pays and a lookup is not.

Two consequences are worth knowing.

- **Reasoning arrives as a `thinking` block, and only `text` is forwarded.**
  `vendor/prinny-channel` allowlists `type === "text"`, so a Matrix sender never
  sees the deliberation and the harness does — the same boundary the local
  branch kept with a proxy, now enforced by the provider's own content typing.
  Reasoning is never merged into `content`, so nothing that reads the answer can
  accidentally read the thinking.
- **Thinking is billed.** On the local branch a high effort level cost
  wall-clock; here it costs tokens. That is the reason the orchestrator leaves
  thinking to the agent types that need it, and the reason the advisor is a
  separate, stronger model rather than the session doing its own planning in
  between tool calls.

## The one interaction that could still bite

A cached prefix and a thinking block are both part of the request, and a cache
write that is thrown away on the next turn is real money. That is what
`showCacheMissNotices` and the session's `cacheRead` / `cacheWrite` /
`cacheWrite1h` accounting exist for — see [pi.md](pi.md) and
[orchestrator.md](orchestrator.md).

---

[← back to the README](../README.md)
