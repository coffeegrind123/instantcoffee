# Troubleshooting

Symptoms in the order you are likely to hit them.

**`pi does not list anthropic/claude-…` and the session refuses to start.**
The catalog bundled with an installed pi lags the published one, and the lag is
not cosmetic: pi 0.85.1 ships 14 anthropic models and **none** of this branch's
three. The launcher runs `pi update --models` before every launch
(`PI_UPDATE_MODELS_ON_LAUNCH`, fails soft); if it could not reach the registry,
the seat probe is what refuses. The fix is the one the error names:

```bash
pi update --models
```

If you turned the launch refresh off, run it by hand after a pi upgrade. A model
the catalog does not know is how a seat silently falls back to the parent's
model — the one outcome the three-seat design exists to prevent — so the probe
refuses rather than defaulting.

**The anthropic provider is missing entirely, or `pi --list-models` shows no
Claude models.** pi hides a provider whose models have no usable credentials.
Set the key:

```bash
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' >> .env.local    # gitignored
```

or export it in the shell you launch from. The launcher checks for it before it
does anything else and refuses with `ANTHROPIC_API_KEY is not set`, so a session
that started anyway was launched through `pi` directly rather than through
`scripts/pi-local.sh` — and in that case the provider config and the
orchestrator seed were never written either.

**A subagent is running on the orchestrator's model.** That is a bill, not a bug
report, and it happens when the seed was not read: either orchestrator mode was
off (`ORCHESTRATOR=0`, so `SUBAGENT_MODEL`/`ADVISOR_MODEL` were never seeded), or
pi was launched directly instead of through the launcher. Check the launch
banner — it prints all three seat ids — and check that `ORCHESTRATOR=1` is in
effect for the session that spawned it. The launcher refuses to start
orchestrator mode if `SUBAGENT_MODEL` or `ADVISOR_MODEL` is not
`provider/model-id`, so a malformed value fails loudly rather than at the first
spawn.

**`AttributeError: 'Tool' object has no attribute 'inputSchema'` from an MCP
call.** The mcp2cli install lost its SDK pin. MCP Python SDK 2.0.0 renamed that
field and mcp2cli 3.3.1 still reads the old name. `./scripts/mcp.sh --install`
reinstalls with `mcp==${MCP_SDK_VERSION}` and fixes it. CI fails if the pin
moves to 2.x.

**A command's output in the session looks nothing like what I get in my own
shell.** That is rtk, and it is doing its job — `git status` comes back as a
compact stat block, a test run comes back as its failures. `./scripts/rtk.sh
--status` lists exactly which commands this applies to; everything else is
untouched. If you need the raw bytes for one session, launch with
`RTK_DISABLED=1`; to turn it off for good, set `RTK_ENABLED=0` in `.env`.

The case that is *not* normal is output that looks wrong rather than short — a
count that disagrees with reality, a test run that reports success when it
failed. Run `./scripts/rtk.sh --check` first: it re-runs every measurement the
allow-list rests on, including that a failing pytest still exits non-zero and
still names what broke. If that passes and the output is still wrong, the command
does not belong on the allow-list — take it out of `vendor/rtk-pi/src/gate.ts`
and record why, the way the entries already there do.

**A browser tool call hangs, then the model retries it and things get worse.**
The server's own tool budget is sized below pi's request timeout on purpose
(`BROWSER_MCP_TOOL_TIMEOUT`); when it fires, `.pi/extensions/browser-guard.ts`
rewrites the result into a sentence naming which failure it is — wedged, not
started, or a slow page — and tells the model to fall back to `bash` rather than
retry. If it keeps happening, ask the health probe rather than the server:

```bash
./scripts/browser.sh health     # exit 0 healthy, 2 wedged
./scripts/browser.sh status     # the probe first, zendriver's cached view after
./scripts/browser.sh reap       # clear leftovers from servers that died
```

**The observe dashboard shows no sessions.** It is watching a host directory, and
that directory did not move with the container's home. `OBSERVE_PI_HOME_HOST` and
`PI_CONTAINER_HOME_HOST` are host paths resolved by the docker daemon; a wrong
one does not error, it just shows nothing. `docker compose logs -f observe` says
which paths it mounted. `OBSERVE_ENABLED=0` turns the extension off entirely, and
`/observe` inside a session shows what was sent, dropped and why.

**The bind-mount trap (Docker Desktop on Windows/WSL).**
Docker Desktop resolves bind sources on the **Windows** side. A WSL-style path
such as `/home/you/pi-home` mounts an **empty directory** rather than failing, so
the container sees nothing and the error surfaces somewhere unrelated.
`PI_CONTAINER_HOME_HOST` must be the `//c/...` form. This is the same rule the
observe service followed for its model directory back when there was one.

**pi is not installed.** Any launcher that cannot find `pi` exits with
`pi is not installed — npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
That is the whole fix; the launcher never installs it for you, because an agent
session must not be blocked by a registry round trip.

---

[← back to the README](../README.md)
