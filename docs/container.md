# Running pi in a container

`Dockerfile.pi` builds an image that carries the pi coding agent and everything
pi reaches for — the browser stack, `rtk`, `mcp2cli`, `uv`, a docker client — so
a session can be given its own home directory instead of sharing yours.

It is optional. Nothing else in this repo needs it, and `scripts/pi-local.sh`
works exactly the same on the host.

## What it does and does not run

It runs **pi**. It does **not** run llama-server or forge: those stay in the
compose stack on the host GPU, driven through a mounted docker socket.

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
| `MCP_ADAPTER_VERSION` | `2.26.0` | `MCP_ADAPTER_VERSION` |
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
./scripts/pi-container.sh --shell         # a shell in there instead of pi
./scripts/pi-container.sh --status        # what is running, and against what
./scripts/pi-container.sh --stop          # state is all on the mount
./scripts/pi-container.sh --recreate      # adopt a rebuilt image
./scripts/pi-container.sh --print-only    # the two docker commands, and stop
```

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
qpi                       # alias for ~/qwen3.8-forge/scripts/pi-local.sh
```

## What is in the image, and where

| | |
| --- | --- |
| `pi` | global npm, installed with `--ignore-scripts` to match how `pi-local.sh` updates it |
| `rtk`, `mcp2cli`, `uv` | `/usr/local/bin` |
| Zendriver MCP | `/opt/zendriver-mcp` — the exact path `ZENDRIVER_MCP_DIR` defaults to |
| Chrome + Xvfb on `:99` | matches `BROWSER_MCP_DISPLAY` |
| docker CLI + compose plugin, `gh`, `git`, `rg`, `jq`, `fd` | |

**Everything is installed into the image, never into `$HOME`.** `$HOME` is the
bind mount, so anything the build writes there is shadowed away the moment the
volume is attached — the classic way a tool that is "built in" turns out to be
missing at run time. `pi-mcp-adapter` is the one thing that cannot follow this
rule, because pi insists on `~/.pi/agent/npm`; the start script installs it on
first run instead, and skips it thereafter.

`x11-utils` is a hard dependency, not a convenience. `scripts/browser.sh` probes
the display with `xdpyinfo` before launching Chrome; without it the probe falls
back to a `pgrep` that a **stale** `/tmp/.X11-unix/X99` socket satisfies — the
socket outlives the process that created it — so Chrome silently drops to
headless, and headless is what many sites block or stall.

Ghidra and GhidraMCP are deliberately absent: ~3 GB of JDK and Ghidra for a
server `mcp/servers.json` does not register. Add the blocks and an
`mcp/servers.json` entry if you want it.

## First start

The entrypoint seeds `~/.bashrc` if absent, brings up Xvfb, installs
`pi-mcp-adapter` on first run, and then prints what it could and could not
verify:

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
