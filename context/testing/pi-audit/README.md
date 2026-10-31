# pi audit harness

The tools behind `context/pi-1.4-audit-2026-10-31.md`: checking this stack's
extensions against a new pi release, measuring what a change puts on the wire,
and driving the real TUI in the pi container. Nothing here is loaded by the
stack; every piece is passed in explicitly with `-e` or run by hand.

## extensions/ (load with `pi -e <file>`)

| File | Answers |
| --- | --- |
| `control-load-throw.ts` | Does a load error stop pi loudly? Must exit 1 with `CONTROL-LOAD-THROW`. Run it beside the real set before trusting a clean stderr. |
| `control-hook-throw.ts` | Does a hook error show? Must print `Extension error (...): CONTROL-HOOK-THROW` and still finish the turn. |
| `dump-payload.ts` | What the last request carried: total bytes, system prompt, tool names, tool-schema bytes. `DUMP_OUT=<file>`. |
| `dump-append.ts` | One line per request with its tool names, parent and children alike. `DUMP_APPEND=<file>`. One distinct list per session means the prompt prefix stays cacheable. |
| `probe-before-agent-start.ts` | Does `before_agent_start` fire for an extension-triggered run, and with what `messageType`? `PROBE_OUT=<file>`. |

## scripts/

| File | Answers |
| --- | --- |
| `event_timeline.py` | Where a run's time goes, from `pi --mode json`. |
| `contract_needles.py` | Did pi code the tool-result guard pins actually change, or only move to another bundle chunk? |
| `validate_pi_config.py` | Are the `models.json` / `settings.json` keys the launcher writes still in pi's published schemas? |
| `session_entries.py` | Every entry type in the newest session, counted (the `/loop` L1 check). |
| `turn_state.py` | Has the TUI's current turn finished, and which tools did it call? |
| `subagent_tools.py` | What a subagent child called (its calls are absent from the parent's JSON stream). |

## Recipes

**Two pi versions side by side**, without touching the global install or
`~/.pi`:

```bash
npm install --ignore-scripts --prefix "$W/pi14" @earendil-works/pi-coding-agent@1.4.0
PI_CODING_AGENT_DIR="$W/agent" ./scripts/pi-local.sh --print-only | grep '^pi ' > "$W/cmd.txt"
cd "$W/run" && PATH="$W/pi14/node_modules/.bin:$PATH" PI_CODING_AGENT_DIR="$W/agent" \
  DUMP_OUT="$W/payload.json" eval "$(cat "$W/cmd.txt") -e .../dump-payload.ts -p 'Reply with OK.'" </dev/null
```

`--print-only` mixes its status lines into stdout; keep only the `pi ` line.
The browser extension needs `BROWSER_MCP_HOST` / `BROWSER_MCP_PORT` /
`BROWSER_MCP_NATIVE=1` in the environment, which `pi-local.sh` exports when it
launches pi itself.

**Driving the real TUI in the pi container**, with this checkout mounted over
the container's repo path so uncommitted work is what runs:

```bash
export PI_CONTAINER_NAME=instantcoffee-pi-audit \
       PI_CONTAINER_EXTRA_ARGS="-v //c/users/user/downloads/as/data/qwen3.8-forge:/home/piuser/qwen3.8-forge"
tmux new-session -d -s piaudit -x 200 -y 50
tmux send-keys -t piaudit "./scripts/pi-container.sh" Enter
tmux send-keys -t piaudit -l 'your prompt'; tmux send-keys -t piaudit Enter
docker exec instantcoffee-pi-audit python3 /home/piuser/qwen3.8-forge/context/testing/pi-audit/scripts/turn_state.py
docker rm -f instantcoffee-pi-audit          # afterwards
```

It shares the operator's real home (`PI_CONTAINER_HOME_HOST`), so the launcher's
settings changes apply there. Run `/loop` in a scratch directory
(`docker exec -it -w /tmp/x ... scripts/pi-local.sh`): its prompts tell the
model to write `PROGRESS.md` into the working directory.

## Traps that cost time

- **`pi -p` waits for EOF on a non-TTY stdin.** From a tool shell (stdin is a
  socket) every headless run hung until `</dev/null` was added.
- **Do not pipe the launcher through `tee`.** pi then gets pipes instead of a
  TTY and waits on stdin rather than drawing; log with `tmux pipe-pane`.
- **A zero is only as good as the reader.** Loop iterations are
  `custom_message` entries; a reader that counted `custom` and `message` found
  no loop turns at all, so its "0 duplicates" proved nothing until it could see
  an entry known to be there.
- **Load time on a bind mount is not pi's.** 77-89 s to the first frame in the
  container; the same extension load from local disk takes seconds.
