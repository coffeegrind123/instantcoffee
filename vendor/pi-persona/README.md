# pi-persona

A character persona for pi's voice, over engineering that does not change.

```
/persona                      pick a source: local library, chub.ai, search, random
/persona local                browse the library; activate a cached one for free
/persona chub trending        browse chub.ai by sort mode
/persona search <query>       free-text search on chub.ai
/persona random               adopt a random persona
/persona show                 read the active persona file
/persona status               what is active, and what it costs per request
/persona clear                back to the neutral voice
/persona prompt full|lean     how much of the persona contract to send
/persona immersion <mode>     auto | immersion | analysis | off
```

The persona governs **how** things are said. It has no authority over
thoroughness, tool choice, code quality, test coverage, or honesty about
results — that is stated in the block itself, and it is the point of the design
rather than a caveat on it. A "lazy" character still reads every file.

## How a persona is made

1. You pick a chara_card_v2 card — from chub.ai, or a `card.json` you dropped in
   `~/.pi/agent/personas/`.
2. The card is staged, and the **model** is handed a turn that reads it and
   writes a 200-500 word voice profile: cadence, vocabulary tier, verbal tics,
   mannerisms, emotional defaults, one sample line. Card operating directives —
   jailbreaks, output-shape mandates, in-character refusals — are dropped on the
   way through.
3. That profile lands at `~/.pi/agent/PERSONA.md` (active) and in the library
   entry (cached). It takes effect on the next turn.
4. Re-selecting a card you have already extracted activates the cached profile
   with no model turn at all.

## Where things live

```
~/.pi/agent/PERSONA.md                   the active persona
~/.pi/agent/personas/<slug>/card.json    the staged card
~/.pi/agent/personas/<slug>/PERSONA.md   the extracted profile
~/.pi/agent/personas/<slug>/meta.json    provenance: source, hash, avatar URL
~/.pi/agent/persona-settings.json        prompt mode, immersion mode
```

`~/.pi/agent` follows pi's own `PI_CODING_AGENT_DIR`, so a pi session with a home
of its own gets a library of its own. An `IDENTITY.md` / `identities/` library
copied from openclaude is read as-is.

## Cost

Nothing when no persona is active — the extension registers no tool and adds no
prompt. With one active it prepends ~3,683 tokens (`full`) or ~2,311 (`lean`) to
every request, byte-stable across turns. `/persona status` prints the live
number. `FORK.md` has the wire measurements and what `lean` gives up.

## Configuration

Everything is settable for one launch from the environment, which beats the
persisted file:

| variable | values | what it does |
| --- | --- | --- |
| `PERSONA_ENABLED` | `0` / `1` | whether `scripts/pi-local.sh` loads it at all |
| `PERSONA_PROMPT_MODE` | `full` / `lean` | how much of the contract to send |
| `PERSONA_IMMERSION` | `auto` / `immersion` / `analysis` / `off` | first-message marker |
| `CHUB_API_KEY` | a key | overrides the public gateway key |

## Tests

```bash
cd vendor/pi-persona && npm run lint && npm test
```

103 tests. The extension suite drives the real factory against the installed pi;
it skips itself when pi is not on PATH, and the source assertions run anyway.

See `FORK.md` for provenance, the six departures from upstream, and the
measurements.
