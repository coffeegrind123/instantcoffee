# Running pi in a container

`Dockerfile.pi` builds an image that carries the pi coding agent and everything
pi reaches for — the browser stack, `rtk`, `mcp2cli`, `uv`, a docker client — so
a session can be given its own home directory instead of sharing yours.

It is optional. Nothing else in this repo needs it, and `scripts/pi-local.sh`
works exactly the same on the host.

## What it does and does not run

It runs **pi**. In local mode it does **not** run llama-server or forge: those
stay in the compose stack on the host GPU, driven through a mounted docker
socket. In Anthropic mode the container talks directly to `api.anthropic.com`;
no inference container or host GPU is involved.

```
   container                                     host
   ┌──────────────────────────────┐
   │ pi          (pi-local.sh)    │
   │ Chrome + Zendriver MCP       │
   │ rtk, mcp2cli, uv, docker CLI │
   └──────┬───────────────┬───────┘
          │               │  /var/run/docker.sock
          │               └──────────────►  docker compose  →  forge + llama
          │                                                     (GPU)
          └── http://host.docker.internal:8081 ──────────────►  forge  :8081
```

With `STACK_BACKEND=anthropic`, the last two arrows are absent. pi reaches
Anthropic over HTTPS, and `--status` reports the configured seats, key presence,
and cache policy instead of probing forge.

`pi-local.sh` already detects `/.dockerenv` and swaps `localhost` for
`host.docker.internal`, so nothing in the repo changes to run from inside. Docker
Desktop proxies that name to the host, and forge's published port is reachable
through it even bound to `127.0.0.1`.

## Build

```bash
docker build -f Dockerfile.pi -t pi-agent:latest .
```

Roughly 3.7 GB, most of it Chrome and the node/python base. Nothing is `COPY`ed
out of the build context — the image is self-contained and the checkout arrives
at run time on the mount — so the context size is irrelevant.

Version pins are build args, defaulting to the values `.env` holds:

| Arg | Default | Kept in step with |
| --- | --- | --- |
| `PI_VERSION` | `latest` | — (`PI_AUTO_UPDATE` moves it after install) |
| `RTK_VERSION` | `0.45.0` | `RTK_VERSION` |
| `MCP2CLI_VERSION` | `3.3.1` | `MCP2CLI_VERSION` |
| `MCP_SDK_VERSION` | `1.29.0` | `MCP_SDK_VERSION` |

They are also written into the image as `PINNED_*` environment variables and as
OCI labels, so `docker inspect` answers "what is actually installed" without
cross-referencing `.env`.

## Run it without thinking about it

`scripts/pi-container.sh` is `scripts/pi-local.sh` with a container around it,
and the container is meant to be invisible: same flags, same banner, same
session. It creates the container on first use, reuses it after, and delegates
to `pi-local.sh` inside — so everything the launcher knows about the stack stays
in one place.

Set one key in `.env.local` — the agent home **as the docker daemon sees it**,
which this shell cannot derive because the daemon is what resolves bind sources:

```bash
PI_CONTAINER_HOME_HOST=/path/to/pi-home     # //c/path/to/pi-home on Docker Desktop
```

Then:

```bash
./scripts/pi-container.sh                 # a session
./scripts/pi-container.sh -p "summarize"  # any pi flag passes through
./scripts/pi-container.sh -C myproj       # work on <container home>/myproj
./scripts/pi-container.sh --session <id>  # resume one, in its own directory
./scripts/pi-container.sh --ovis          # the session in a herdr pane, so Ovis shows it
./scripts/pi-container.sh --shell         # a shell in there instead of pi
./scripts/pi-container.sh --status        # what is running, and against what
./scripts/pi-container.sh --stop          # state is all on the mount
./scripts/pi-container.sh --recreate      # adopt a rebuilt image
./scripts/pi-container.sh --print-only    # the two docker commands, and stop
```

`--` ends launcher-option parsing, and everything after `-p`/`--print` is passed
to pi unchanged. That prevents a prompt such as `--stop` from becoming a control
command. `--provider`, `--model`, and `--models` are rejected here and in
`pi-local.sh`; choose a mode instead of silently routing around `STACK_BACKEND`.

A one-off override works exactly as it does for `pi-local.sh`:

```bash
ORCHESTRATOR=1 ./scripts/pi-container.sh
SUBAGENT_MAX_CONCURRENT=4 ORCHESTRATOR=1 ./scripts/pi-container.sh -p "..."
```

Every exported variable that is a key in `.env`, `.env.local` or
`.env.local.example` is forwarded into the container as `-e NAME` — by name, so
docker copies the value and it never appears on a command line or in
`--print-only`. The launch prints `forwarding: ...` when it forwards anything.
Before 2026-09-24 these were dropped in silence: `docker exec` starts with the
container's environment, not yours.

## Resuming a session

`--session <id>` is enough. You do not have to be standing anywhere in
particular, and you do not need `-C`:

```bash
~/qwen3.8-forge/scripts/pi-container.sh --session 01a042c0
```

**Why that needs saying.** pi keys sessions on the directory they were started
in and looks one up by the key for the CURRENT directory, so `--session` from
the wrong directory is not an error — it is a miss. pi starts a *new* session
and the one you asked for sits there untouched. The container makes that easy to
hit, because the launcher's default working directory comes from where you typed
the command while the session's comes from where it ran; a session recorded in
the container home while you type from the repo checkout is two different keys.

So the launcher reads the answer out of the session file. Its first line is the
header pi wrote when the session began —
`{"type":"session","version":3,"id":"01a042c0-…","cwd":"/home/piuser"}` — and
`cwd` is where the session starts. Partial ids work, the same ones pi accepts.
`--session-id` and `--fork` are treated the same way. `--continue` and
`--resume` are not: both mean "the previous session *for this directory*", so
there is nothing to infer.

The directory *name* under `sessions/` is deliberately not decoded. The key is
the path with every `/` turned into `-`, which is lossy — `--home-piuser-qwen3.8-forge--`
could be read two ways, and one of them is wrong. The header cannot be.

Four things it will say rather than guess:

- the id matches sessions in **more than one directory** — it refuses and lists
  them with their directories. Several matches in the *same* directory are fine:
  the directory is not in question, and which session to open is pi's to decide.
- the session's directory **is not in the container** — it refuses, names the
  directory, and prints the `PI_CONTAINER_EXTRA_ARGS` line that would mount it.
- **nothing matches** — a warning, then the usual rules. `--session-id` may
  legitimately name a session that does not exist yet.
- **`-C` disagrees** with the session's directory — `-C` still wins, because it
  is the explicit one, but you are told that pi will not find the session there.

`--print-only` is how to check any of this without starting anything: it prints
the `docker run` that would create the container and, when the container is
already up, the `docker exec` that would start the session — working directory
and all.

One alias and the container stops existing as far as you are concerned:

```bash
echo "alias qpi='~/qwen3.8-forge/scripts/pi-container.sh'" >> ~/.bashrc
```

That alias is safe to use everywhere, including from a shell **inside** the
container: the image sets `PI_AGENT_CONTAINER=1`, and the script sees it and
just runs `pi-local.sh` instead of trying to start a container from inside one.

### Which directory pi works on — and mounting your projects

pi works on the current directory, and **the container only sees what is mounted
into it**. Its home is one mount; a project living in a different home is not
visible at all, and launching from there lands you in the container home with
nothing familiar in it.

So mount each project you want it to work on. One `-v` per project, the host
path on the left, a path under the container home on the right:

```bash
# .env.local
PI_CONTAINER_EXTRA_ARGS=-v /host/path/to/proj:/home/piuser/proj
```

then `./scripts/pi-container.sh --recreate`. Mount **projects**, not a whole home
directory — a home carries SSH keys, `gh` credentials and tokens, and this
container is credential-free on purpose.

Keeping the basename identical is what makes it automatic. The launcher tests
candidates *inside* the container rather than translating paths by rule, and
says which it picked:

1. your `$PWD`, if that exact path is inside one of the container's bind mounts;
2. otherwise the same path relative to your `$HOME` — `~/proj` →
   `<container home>/proj`, which is why the basename matters;
3. otherwise the container home, with a loud warning that names the mount you
   are missing.

The test is **"is this path inside a bind mount"**, not "does this path exist in
there". The latter is a false positive for `/tmp`, `/usr` and `/`, which exist
on both sides and mean different things — silently landing pi in the container's
empty `/tmp` looks like a perfectly normal session. Scoping the check to the
container's *home* was the first fix and was too blunt: it rejected exactly the
deliberately-mounted project this section is about.

`--status` prints the mount list, which is the fastest answer to "why can't it
see my code".

The container is long-lived and reused rather than created per session, because
the browser server and its Chrome live in it and are stateful — a throwaway
container per session relaunches Chrome every time, which is the mistake
`scripts/browser.sh` exists to avoid.

Rebuilding the image does **not** touch a container already created from the old
one, so the script compares the two and warns; `--recreate` adopts the new
build. Without that check a fix is present in the Dockerfile and absent from
every session, with nothing anywhere saying why.

## The container runs its own clone, and it drifts

`pi-container.sh` execs `${PI_CONTAINER_REPO}/scripts/pi-local.sh` **inside** the
container, so the logic lives in one place. **The files do not.** That path is
under `PI_CONTAINER_HOME_HOST`, which is a different host directory from the
repo you edit unless you deliberately made them the same — on this box
`…/as/data` (host) and `…/as/data2` (container), two independent clones of one
remote.

They drift the moment you commit on one. Measured 2026-08-30: the container's
clone was **nine commits behind**, so sessions there ran with no
`prompts/delegate.md`, no `SUBAGENT_NUDGE`, and without two harness bug fixes —
while the fixed files sat on the host being read. It is the same failure shape as
the image drift above, one level down, and it was silent.

`pi-container.sh` now warns at launch when the two HEADs differ, naming both
commits and both paths. To update:

```bash
./scripts/pi-container.sh --shell
cd /home/piuser/qwen3.8-forge && git pull
```

**Keep that clone's host-specific values in `.env.local`, never as edits to the
tracked `.env`.** `.env` is committed here, so a one-line local edit to it is
what blocks the fast-forward — which is exactly why that clone sat nine commits
behind. `scripts/lib.sh` reads `.env.local` *after* `.env` and the later file
wins, so an override there survives every pull instead of fighting it.

## Run it by hand

Pick a directory on the host to be the container's home. Everything pi writes —
`~/.pi`, the checkout, caches — lives there and nowhere else.

```bash
docker run -it --name pi \
  -v /path/to/pi-home:/home/piuser \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  --shm-size=2g \
  pi-agent:latest
```

On **Docker Desktop for Windows the bind source must be the Windows path** in
docker's form — `//c/path/to/pi-home`, not a WSL path and not a relative `./`
one. Docker Desktop resolves bind sources on the Windows side, and a WSL-style
source silently mounts an **empty directory** instead of failing. This is the
same rule `MODELS_DIR` follows in `.env`, and the same class of bug that made
`Dockerfile.forge` bake its scripts in rather than mount them.

Each flag earns its place:

| Flag | Why |
| --- | --- |
| `-v …:/home/piuser` | the agent's home. Without it every session starts empty and loses `~/.pi` on exit |
| `-v /var/run/docker.sock` | `up.sh`, `down.sh`, `logs.sh`, `mode.sh` and `smoke-test.sh` all shell out to `docker compose`. Without it they fail with a permission error that reads like a broken script |
| `--add-host host.docker.internal:host-gateway` | how pi reaches forge. Docker Desktop provides the name already; this makes it work on plain Linux too |
| `--shm-size=2g` | Chrome. The default 64 MB `/dev/shm` kills renderer processes under pressure, which surfaces as pages that half-load and `navigate` calls that time out — i.e. as "the browser is broken" |

Then, inside:

```bash
cd ~/your-project
pi                        # alias for ~/qwen3.8-forge/scripts/pi-local.sh (so is qpi)
```

`pi` is an alias, so it applies to interactive shells only. pi's subagents
start their children by running `pi` off PATH, and those must get the real
binary, which is also `command pi` when you want stock pi. A home seeded before
2026-11-01 has only `qpi`; add the line from the image's default `.bashrc`.

## What is in the image, and where

| | |
| --- | --- |
| `pi` | global npm, installed with `--ignore-scripts` to match how `pi-local.sh` updates it |
| `rtk`, `mcp2cli`, `uv` | `/usr/local/bin` |
| Zendriver MCP | `/opt/zendriver-mcp` — the exact path `ZENDRIVER_MCP_DIR` defaults to |
| Chrome + Xvfb on `:99` | matches `BROWSER_MCP_DISPLAY` |
| docker CLI + compose plugin, `gh`, `git`, `rg`, `jq`, `fd` | |
| Ovis + herdr | `/opt/ovis`, the pinned prebuilt bundle (sha256-checked), with herdr's pi integration in `integrations/` |

**Everything is installed into the image, never into `$HOME`.** `$HOME` is the
bind mount, so anything the build writes there is shadowed away the moment the
volume is attached — the classic way a tool that is "built in" turns out to be
missing at run time. (pi-mcp-adapter used to be the one exception, installed
into `~/.pi/agent/npm` on first run; it was retired for pi's built-in MCP on
2026-10-31, which ships with pi itself.)

pi's own network traffic is off in the image: `PI_TELEMETRY=0` (no install ping
to pi.dev, no provider attribution) and `PI_OFFLINE=1` (no catalog refresh,
version check, package update checks or fd/rg downloads, which is why `fd-find`
and `ripgrep` are installed). `PI_AUTO_UPDATE` is unaffected: `pi-local.sh` runs
npm for that.

`x11-utils` is a hard dependency, not a convenience. `scripts/browser.sh` probes
the display with `xdpyinfo` before launching Chrome; without it the probe falls
back to a `pgrep` that a **stale** `/tmp/.X11-unix/X99` socket satisfies — the
socket outlives the process that created it — so Chrome silently drops to
headless, and headless is what many sites block or stall.

Ghidra and GhidraMCP are deliberately absent: ~3 GB of JDK and Ghidra for a
server `mcp/servers.json` does not register. Add the blocks and an
`mcp/servers.json` entry if you want it.

## Ovis: the session in a browser or on a phone

[Ovis](https://github.com/devswha/ovis) is a web client for agents running in
[herdr](https://github.com/herdrdev/herdr) panes: it shows pi's own transcript
(thinking, tool calls, answers, context use), answers pi's prompts, sends
messages, and opens the pane's terminal. It runs inside the pi container,
**on by default**:

```bash
OVIS_ENABLED=1     # .env; 0 starts neither herdr nor Ovis
OVIS_PORT=7317     # host side, published on 127.0.0.1 only
```

The container's start script calls `scripts/ovis.sh start`, which starts herdr
headless and the Ovis server under a restart loop (log `/tmp/ovis/ovis.log`).
Changing either key needs `./scripts/pi-container.sh --recreate`, because the
port is fixed when the container is created; the launcher warns when the two
disagree.

**Every pane is a pi chat.** Ovis's chat tab is whatever runs in the pane, and
herdr's default pane is a shell, so typing there ran shell commands and a new
workspace or tab said "Message Shell". herdr runs `$SHELL` for every new pane,
and `ovis.sh` starts it with `scripts/ovis-shims/pane-shell`: pi through
`pi-local.sh` in the pane's directory, then bash when you quit pi. Anything
that runs `$SHELL -c ...` gets plain bash. The first pane starts in
`OVIS_PI_DIR` (default the container home); `OVIS_PI_PANE=0` gives plain
shells.

In Ovis: **New workspace** honours its Agent picker, which defaults to pi until
you pick something else in that browser (Shell is then a real shell); the
**+** tab button and splits open on pi. herdr's restore of agent sessions after
its own restart is off (`resume_agents_on_restore = false` in
`~/.config/herdr/config.toml`, set by `ovis.sh` unless you set it): it typed
`pi --session …` into the pi the pane had already started. Your earlier
conversations are under pi's `/resume`.

Ovis only sees pi when pi runs in a herdr pane, so plain launches are
unchanged and a further session meant for Ovis is started with `--ovis`:

```bash
./scripts/pi-container.sh --ovis               # pi in a new herdr pane, attached here
ORCHESTRATOR=1 ./scripts/pi-container.sh --ovis -C myproj
```

The terminal attaches to the pane; **Ctrl+B then Q detaches** and pi keeps
running, in Ovis. Exported stack keys reach the pane the same way they reach a
plain launch (herdr starts panes from its own environment, so `ovis.sh` writes
them into a one-shot launch script that deletes itself). A `pi` started from
Ovis itself, or typed into a pane, goes through `pi-local.sh` too: the
container's `.bashrc` aliases `pi` to it, and `scripts/ovis-shims/` (first on
herdr's PATH) covers a pane whose shell reads no `.bashrc`. `.bashrc` puts
`/usr/local/bin` ahead of the shim, so in a bash pane the alias is what does it
(measured 2026-11-01: one launcher run per `pi`, the Ovis start included), and
`pi-local.sh` takes the shim off PATH before its own `exec pi` either way.

Open `http://127.0.0.1:7317/` and paste the token:

```bash
./scripts/pi-container.sh --shell      # then:
./scripts/ovis.sh token
```

It is generated once into `~/.config/ovis/token` in the container home (mode
0600); `OVIS_TOKEN` in the container checkout's `.env.local` overrides it.
Every request except `/api/health` and the page itself needs it. Ovis telemetry
and self-update are always off.

Ovis itself listens on `127.0.0.1:7318` inside the container, behind a byte
relay on `0.0.0.0:7317` (`scripts/ovis_forward.py`). Docker delivers a
published port to the container's own address, never to its loopback, and Ovis
shows "Anyone who can reach 0.0.0.0 on your network can type into every pane"
for any non-loopback bind without a token, with no setting to turn it off.
Behind the relay it sees a loopback bind. Who gets in is unchanged: Ovis checks
a configured token before it looks at where a connection came from.

herdr runs with `SHELL=/bin/bash`. The container has no `SHELL`, and herdr then
gives every pane `/bin/sh`, which has no bracketed paste: text pasted from Ovis
arrived as `^[[200~...` and ran as a command.

**No sign-in: `OVIS_TOKEN=off`** in the container checkout's `.env.local`, then
`./scripts/ovis.sh stop && ./scripts/ovis.sh start` inside (no recreate
needed). Ovis then lets in anything that reaches the port, until a device is
paired: every program on the host, every container on the same Docker (through
`host.docker.internal:7317`, the agent's own bash tool included), and a web
page that rebinds its own name to 127.0.0.1, which passes Ovis's same-origin
check. Whatever gets in can type into pi, and this container mounts the docker
socket. `--status` says when it is on.

**This stack's commands and output in the chat.** Out of the box Ovis knows
pi's builtins and the skills and prompts it finds as files, and reads the chat
from pi's session file. Measured 2026-11-01, none of this stack showed: its
commands are registered by extensions at run time, its skills and prompts load
from `pi-local.sh` flags, and its commands answer through `ctx.ui.notify` or
entries pi draws with a custom renderer, neither of which Ovis reads. Two
pieces close that, and the chat then lists, runs and answers every one:

- `.pi/extensions/ovis-bridge.ts`, loaded by `pi-local.sh` in a herdr pane
  only, writes pi's live command list (`pi.getCommands()`) to
  `/tmp/ovis/catalog/<pane>.json`; saves every extension's `notify` as an
  `ovis-notice` entry (never sent to the model); keeps a preview of the session
  until pi writes its file, which pi does only at the first message, so a
  command run first still shows; reports footer statuses (the `/loop` pill) as
  the pane's line in Ovis's sidebar; and records `REASONING_EFFORT`, which pi
  itself records as `off` for this model.
- `scripts/ovis_patch.py` edits Ovis's server at every `ovis.sh start`, from
  `vendor/ovis-patches/`: a native-catalog provider for pi; those entries as
  chat notices (`/stack` reports, subagent transcripts, notices); as a
  command's result, so it reads Done rather than "No result seen"; the preview;
  the effort; and room for pi's extension-status footer line, without which
  no pi dialog (`/persona`, `/stack mode`) became a card while a status was
  set. Each file is pinned to the bundle's sha256 and anything else is refused
  loudly; Ovis then runs as shipped.

Commands that draw their own TUI (`/agents`, pi's `/mcp` and `/llama`) cannot
become cards and are listed as terminal commands: sent from the chat, Ovis
opens the pane's terminal with the menu in it. `scripts/test_ovis.py` fails when
a command from a package that draws custom TUI, or an entry type an extension
renders, is not covered.

**On a phone**, publish the host port to your tailnet from the machine that
runs Docker (on Windows, from the Windows side): `tailscale serve --bg 7317`.
Nothing here does that for you.

`./scripts/ovis.sh status` (inside) and `./scripts/pi-container.sh --status`
(outside) say whether it is up. `./scripts/ovis.sh stop` stops the Ovis server
and leaves herdr and its panes running.

**Why the integration is loaded by path.** Without herdr's pi integration Ovis
cannot find pi's session file and falls back to reading the screen, which
showed 0 turns when measured. `herdr integration install pi` would write it into
`~/.pi/agent/extensions`, which is on the home mount and would load into every
session; the image generates it into `/opt/ovis/integrations` instead, and
`pi-local.sh` passes it with `-e` only when `HERDR_ENV=1`. It talks only to
herdr's local socket.

## Why the extensions load from a copy

The repo arrives on a Windows bind mount, and pi took 111-113 s to load its
extension set from it against 3-5 s from the container's own disk (measured
2026-11-01; nearly all of it the vendored packages, `pi-subagents-lite` alone
~90 s). So inside the container `pi-local.sh` copies `.pi/extensions` and the
five vendored packages into `/var/tmp/pi-ext/ext.XXXXXX` at each launch (~4 s)
and loads `vendor/` from there; the first screen comes up in about 12 s.

- **`.pi/extensions` still load from the repo.** pi also discovers them when it
  runs inside the repo, and a second path to the same extension registers it
  twice and fails the whole load. They are in the copy only because vendor code
  imports from them.
- **One copy per launch.** A running session may still spawn subagents from its
  copy; copies older than a day are removed. `prinny-channel` is not copied.
- `PI_STACK_REPO_ROOT` tells `/stack`, the browser guard and subagent children
  where the real repo is, since the copy is not it.
- `PI_EXT_LOCAL_COPY=0` loads everything from the repo again. Edits to vendor
  code take effect at the next launch either way.

## First start

The entrypoint seeds `~/.bashrc` if absent, brings up Xvfb, and then prints
what it could and could not verify:

```
Display: :99 (Xvfb, listening)
Stack checkout: /home/piuser/qwen3.8-forge
Docker: 29.3.1 (socket reachable)
forge: up, model loaded (host.docker.internal:8081)
pi:      0.84.3
rtk:     rtk 0.45.0
...
```

The forge line uses **two** probes, never one. `/forge/health` is forge's own
liveness; `/health` is the backend's readiness, forwarded. Conflating them
reports "forge is down" for the whole cold load of a model that is loading
perfectly normally — see `pi-local.sh`, which learned the same lesson.
Anthropic mode does not print that line; it reports the hosted backend and
whether `ANTHROPIC_API_KEY` was forwarded, without printing the value.

`tini` is PID 1 so Xvfb, Chrome and the browser server get reaped. Without a
real init they accumulate as zombies across a long session, and Chrome's hold
their profile locks so the next launch fails.

## The knobs that do not follow the container's home

`PI_SESSIONS_DIR`, `MODELS_DIR` and `CAPTURES_DIR` are handed to **docker
compose**, which resolves them on the host. They are host paths and they do not
move with the container's `HOME`. A stale one fails as a `FileNotFoundError` on
a path that plainly exists — the container simply has no view of it.

So when the container's home is not the same directory the compose stack was
configured against, point `PI_SESSIONS_DIR` at the new home's
`.pi/agent/sessions` **as the host sees it**.

The start script prints the value at every start. It cannot derive a host path
from its own `HOME`, so it does not guess — give it the answer and it will check
instead:

```bash
docker run -e PI_HOME_HOSTPATH=/path/to/pi-home ...
```

Then a `PI_SESSIONS_DIR` pointing somewhere else is named at startup, rather
than being discovered later as `capture.sh import-pi` reading another home's
transcripts.

`MODELS_DIR` and `CAPTURES_DIR` are usually worth sharing — the GGUF is ~18 GB
and there is no reason for two copies.

## No credentials, on purpose

The image seeds no SSH config, no `gh` auth, no `.gitconfig`, no git credential
store. It reads and writes the checkout under its own home and talks to forge;
it does not push anywhere. The start script says so once, rather than letting it
be discovered at the first commit:

```
git:     no identity or credentials in this container (local commits will be refused)
```

Adding any of it is a decision to make on purpose. Drop the files into the mount
and they are simply there — nothing in the image removes them.

## Moving an existing agent home into a container

If you are relocating a home that pi has already used rather than starting
clean, three things are keyed on the **absolute** path and will not follow a
rename. All three fail quietly.

1. **`~/.pi/agent/channels/prinny/crypto/snapshot.json`.** The snapshot's `dbs`
   map is keyed by the IndexedDB database name, which is
   `<state-dir>/crypto/store::matrix-sdk-crypto` — an absolute path. Under a new
   home, matrix-sdk-crypto asks for a name that is not in the restored set, gets
   an **empty** database, and comes back as a **new device with no room keys**.
   The visible symptom is peers refusing to send keys, which reads as a
   homeserver or pairing problem. Rewrite that one key.

2. **`PRINNY_BOT_PATH`** in the channel's `.env`, if set — it points at a local
   `prinny-bot` checkout and is consulted by `/prinny prepare`.

3. **`~/.pi/agent/sessions/`.** Session directories are keyed on the working
   directory they were started in, so transcripts recorded under the old home
   are unreachable under the new one. There is nothing to fix; either accept it
   or keep the home path identical. (`--session <id>` still finds them from
   anywhere — it reads the directory out of the session header — but it will
   then refuse, because that directory is exactly what the container no longer
   has.)

Copy the built `channels/prinny/runtime` along with the checkout and it stays
valid — the stamp is a content fingerprint of `vendor/prinny-channel/server/src`,
not a path — so `--staged` reports `current` and no rebuild is needed.

**But `--staged` is not proof the channel can start.** If `PRINNY_BOT_PATH`
points at a local `prinny-bot` checkout, the runtime's
`node_modules/@prinny/bot` is a **symlink into it**, and node resolves *through*
the symlink to the real path — so `matrix-js-sdk` and the rest are looked up in
**that checkout's** `node_modules`, not the runtime's. Copy the bot checkout
without its `node_modules` and everything reports healthy right up until the
sidecar starts, at which point the log shows:

```
unhandled rejection: Error [ERR_MODULE_NOT_FOUND]:
  Cannot find package 'matrix-js-sdk' imported from .../prinny-bot/dist/index.js
```

and the session says only *"the channel is up but has not logged into Matrix
yet"* — because the sidecar IS up, and is holding the account lock, having
failed one import. So verify the thing that actually matters, which is that the
module loads:

```bash
node vendor/prinny-channel/server/bin/prinny-channel.mjs --staged   # source fingerprint
node -e "import('<runtime>/node_modules/@prinny/bot/dist/index.js')
           .then(() => console.log('bot module loads'))"            # dependency tree
```

## One bot per Matrix account, and containers cannot see each other

`vendor/prinny-channel/server/src/account-lock.ts` enforces one bot per Matrix
account with an `O_EXCL` lock — but the lock lives at
`homedir()/.prinny/account-locks/`. **Two containers have different home
directories, so neither can see the other's lock.** Nothing stops a second bot
starting on the same account, and two processes rewriting one Olm account is
unrecoverable: peers encrypt to the devices they know, the identity keys they
cached end up pointing at nothing, and the account has to be stripped to one
device and re-minted.

Sharing the lock directory between containers does not fix this and makes it
worse. `holderIsAlive` decides liveness with `process.kill(pid, 0)` and
`/proc/<pid>/stat`, both of which are meaningless across PID namespaces: a live
holder in one container reads as **dead** in the other, the lock is broken as
stale, and a second bot starts — which is the exact failure the lock exists to
prevent.

Two ways to be safe, in order of preference:

- **Give the account one owner.** Decide which home runs the channel and make
  the others unable to log in — renaming their `channels/prinny/.env` is enough,
  because `loadEnvFile()` then finds no credentials and the launcher says so at
  startup. Leave a note beside it saying why, or the missing file is a mystery
  later.
- **Share a PID namespace** (`--pid=container:<other>`) *and* bind a shared
  `~/.prinny`, which makes the lock's liveness checks valid again. Correct, but
  it couples the two containers' lifetimes.

`PRINNY_ENABLED=0` is the default, so a freshly copied home is inert until you
turn it on.

---

[← back to the README](../README.md)
