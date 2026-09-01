# Spending the context window

Three things that would otherwise eat the window before the model reads
anything: MCP tool schemas, unfiltered bash output, and a browser.

## MCP, without MCP

You can still reach MCP servers — just not by loading their schemas. This is
**on by default**: the launcher passes pi a skill that teaches it about
`./scripts/mcp.sh`, which fronts [mcp2cli](https://github.com/knowsuchagency/mcp2cli):

```bash
./scripts/mcp.sh --servers                    # what is registered
./scripts/mcp.sh everything --search sum      # find a tool
./scripts/mcp.sh everything get-sum --help    # that one tool's arguments
./scripts/mcp.sh everything get-sum --a 20 --b 22
#=> The sum of 20 and 22 is 42.
```

The economics are the whole point. Wiring an MCP server into a client puts every
tool's schema in the prompt on every turn, forever. Here the always-on cost is
the skill's name and description — about 60 tokens, because pi loads a skill's
body only when a task matches — and a tool's schema enters the context only when
the model asks for that one tool with `<tool> --help`. `--compact` lists a whole
server for roughly 2 tokens per tool.

Servers are declared in `mcp/servers.json`, `stdio` or `url`, one line each. An
`auth_header` value takes `env:VAR` and `file:/path` prefixes, so no credential
goes in the committed file — CI rejects a literal one.

One server does not go through here: the browser. It is stateful and this path
spawns a fresh server per call, so it gets its own long-lived process and its own
wrapper — see [A browser](#a-browser).

This is on without a measurement gate in front of it because the cost is bounded
and known — the skill description, and nothing else until the model chooses to
call a server. It needs `uv` on PATH; `MCP2CLI_ENABLED=0` turns it off, and
`pi-local.sh` says which state it is in.

Two things that were measured rather than assumed, on 2026-08-12:

- **`uv tool install mcp2cli` is broken as of today.** The MCP Python SDK
  released 2.0.0, which renames `Tool.inputSchema` to `input_schema`; mcp2cli
  3.3.1 still reads the old name, so an unpinned install resolves 2.0.0 and every
  call dies with `AttributeError` before it reaches the server. `MCP_SDK_VERSION`
  pins `mcp==1.29.0` and `scripts/mcp.sh` installs with that pin. CI fails if the
  pin moves to 2.x.
- **mcp2cli's persistent sessions did not work here.** `--session-start` returns
  "session daemon did not start in time". Each call therefore spawns the server
  (~5s for an `npx` one). The skill tells the model to batch questions rather
  than reach for sessions.

### What does not survive the trip

- **Streaming is not incremental.** forge accepts `stream=true` and returns SSE, but
  inference completes before the events are emitted, because rescue parsing and
  retries need the whole response. Expect the reply to land at once after a pause,
  not to type itself out.
- **The model name is ignored** end to end. It is a label; llama.cpp serves
  whatever GGUF it was started with.
- **`reasoning_effort` does not survive as an API field** on the pinned build,
  which is why the provider entry declares it unsupported. Thinking depth is set
  server-side by `REASONING_EFFORT` in `.env` and capped by `REASONING_BUDGET`.
- **Prompt caching is not an API-level feature here.** There is no
  `cache_control` on the OpenAI wire; the stack gets the same effect from
  `--cache-prompt` + `--slot-save-path` (KV cache persisted to disk, so warm
  restarts skip re-prefill), `preserve_thinking` (no KV re-prefill across
  agentic turns), and `--ctx-checkpoints` (fast rewind). See `.env` for
  `CACHE_RAM`, `CACHE_REUSE` and the related knobs.

## Shorter bash output

Same arithmetic as the MCP section, pointed at the other big consumer of the
context window. [rtk](https://github.com/rtk-ai/rtk) is a Rust binary that filters a
command's output before the client reads it — `git status` compacted, test
runners reduced to their failures. `scripts/rtk.sh` installs a pinned build;
`vendor/rtk-pi` is the pi extension that decides what gets filtered.

**On by default, and inert without the binary** — the extension warns once and
filters nothing, so `RTK_ENABLED=1` is safe on a fresh clone. One command to make
it live:

```bash
./scripts/rtk.sh --install     # pinned build, sha256-verified, ~10 MB
./scripts/rtk.sh --status      # what is filtered, and whether the pin matches
```

Measured here on 2026-08-16, against rtk 0.45.0:

| command | raw | filtered | saved |
| --- | --- | --- | --- |
| `git status` | 275 B | 49 B | 82% |
| `pytest -q` (43 tests, 3 failing) | 1312 B | 476 B | 64% |
| `find vendor -name '*.ts'` | 1718 B | 773 B | 55% |
| `git diff HEAD~1` | 2384 B | 2213 B | 7% |
| `cat README.md` | 67652 B | 67652 B | 0% |
| `ls -1` | 123 B | 242 B | **-97%** |

### Why it filters an allow-list rather than everything

Upstream's pi extension hands **every** bash command to rtk and applies whatever
comes back. This one filters 23 commands and passes the rest through untouched,
because of what running the binary turned up rather than reading its docs:

- **Some rewrites substitute a different command.** `npm run lint` becomes
  `rtk lint` — the indirection is discarded, so whatever the package's lint
  script actually is gets replaced by a bare eslint. `uv run pytest` becomes
  `uv run rtk pytest`, resolving a pytest outside the venv. Both are silent, and
  a 27B model at `REASONING_EFFORT=medium` has no way to smell either.
- **Two commands in rtk's coverage table have no filter behind them** on 0.45.0:
  `npm test` and `cargo nextest` (bare or `run`) both come back "no rewrite".
  Bare `ruff` likewise — only `ruff check`/`ruff format` match.

What was *not* found is worth saying too, because the issue tracker suggested
otherwise. Diffed against the real command, rtk's filters are mostly faithful:
`find` returned the same 38-file set, `grep -rl` the same paths, `rtk read` the
same bytes at every size tried up to 180 KB. The allow-list is narrow because
most filters **save nothing on a repo shaped like this one**, not because most of
them lie.

**And one command it will not rewrite whatever the allow-list says: one a person
has already approved.** With the Matrix permission relay on (`/prinny permissions
all`), a `bash` call is shown to a human on their phone before it runs — and this
extension's handler runs one position AFTER that relay, on the same tool-call
input object. So the approver read `git status` and pi ran `rtk git status`,
which is an approval for a different command; the channel log recorded the first
one too. The relay now stamps what it showed on the call, and rtk stands down
when it sees the stamp — leaving the command unfiltered, which is the direction
every other decision in that file already fails in. With the relay off (the
default) nothing is stamped and nothing changes. See AJ3 in
`context/design/subagents-loop-verifier-authority.md`.

`cat` is the one entry denied on principle rather than arithmetic. It costs 0%
to deny today, and rtk's README advertises "signatures and structure over full
bodies" — so the current losslessness is undocumented and could turn off in a
point release. The failure that would cause is this stack's known one: an edit
whose `old_string` no longer matches the file.

### Keeping it honest

Two halves, both in CI, because neither implies the other:

```bash
cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts
./scripts/rtk.sh --check
```

The unit tests cover which commands are handed to rtk and what is accepted back.
`--check` re-runs every measurement in the allow-list against the installed
binary and fails if one stops holding — it is what caught `npm test` and
`cargo nextest` being in rtk's coverage table with no filter behind them, and
what will catch `rtk read` the day it starts summarising. `RTK_VERSION` is pinned
for the same reason: rtk shipped 45 minor versions in seven months, and the
filters are what the allow-list is trusting.

One check earns its place over all the others — and on 2026-08-31 it caught a
real one: `scripts/test_repeat_detector.py` called `sys.exit()` at module level,
which aborted collection for the WHOLE suite. `pytest scripts/ -q` reported "no
tests ran" while 124 tests sat there passing. Fixed by guarding the script body
with `__main__`; the file still runs standalone.

(Also note: pytest is not in the container image, it is installed at runtime and
vanishes on a container restart — it did once on 2026-09-01. Reinstall with
`pip install --break-system-packages pytest`, or use
`python3 -m unittest discover -s scripts -p "test_*.py"`, which needs nothing.)

A `pytest` collection error must
still exit non-zero and still name what failed. Upstream #2317 reports filters
masking hard failures behind benign summaries; it does not reproduce on 0.45.0,
and pytest is only on the allow-list because of that. A masked failure here means
the model reports a green run and moves on, which is worse than no filtering at
all.

Verified end to end on 2026-08-16: a pi session against the local model ran
`git status` through the bash tool and it arrived as `rtk git status` — 42 tokens
saved on a single call, 64.8% across the session.

`RTK_DISABLED=1 qpi` turns filtering off for one session without editing `.env`.

## A browser

The model can drive a real Chrome — open pages, read them, click, type, fill
forms, read cookies and network logs, get past bot protection. **On by default**;
nothing runs until a tool is called.

Underneath is [Zendriver-MCP-fork](https://github.com/coffeegrind123/Zendriver-MCP-fork)
— CDP rather than WebDriver, so it is not detected as automation — running as a
**long-lived HTTP server** that `./scripts/browser.sh` starts, health-checks and
stops. `ZENDRIVER_MCP_DIR` points at the checkout; it is not vendored, because it
pulls zendriver and a Chrome.

**That process ownership is the fixed point of the design.** The server is not
something pi spawns: it outlives any one session, survives `/clear`, is shared
with anything else on the box, and is stopped deliberately. What changes between
the two modes below is only how pi *reaches* it.

### Adapter mode — the browse loop as native tools (default)

With `MCP_ADAPTER_ENABLED=1`, pi loads
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) and
`mcp/adapter.json` points it at the running server. Five tools register as
ordinary pi tools; the other 93 stay one search away:

```
browser_navigate({ url: "https://example.com" })
browser_get_text_content({ max_chars: 4000 })
browser_get_interaction_tree({ limit: 40 })
browser_click({ selector: "3" })
browser_type_text({ selector: "7", text: "hello" })

mcp({ search: "cookie" })                     → any of the other 93, with schemas
mcp({ tool: "browser_set_cookie", args: … })  → call one
mcpScript({ code: "…" })                      → several calls in ONE turn
```

Measured on 2026-08-16 — not from the READMEs. The token figures are the bytes
**pi actually put on the wire**, captured from a stub model that logged the
request (the adapter's own README claims "~200 tokens" for the proxy tool; it is
720):

| | tokens | per call |
| --- | --- | --- |
| All 98 schemas, the normal MCP way | ~19,000 (60% of the window) | — |
| `mcp` proxy tool | 720 | — |
| `mcpScript` | 302 | — |
| The five direct tools | 1,155 | 25–417 ms |
| **Adapter mode total** | **2,178 (6.6%)** | in-process |
| pi's own `read`/`bash`/`edit`/`write`, for scale | 723 | — |
| CLI mode (`skills/browser`) | ~120 | 1.7–6.5 s |

Two levers if 6.6% is too much: `"scriptMode": false` in `mcp/adapter.json`
settings drops `mcpScript` (−302), and shortening `directTools` to
`navigate`/`get_interaction_tree`/`get_text_content` drops another ~500 at the
cost of a proxy hop for every click and keystroke.

The per-call figure is why this exists: the CLI pays a Python start and a full
`tools/list` on every invocation, and `mcpScript` collapses navigate → read →
click → read into a single turn, which on a 27B local model is worth more than
the token arithmetic.

`start_browser` is deliberately **not** one of the five — its schema alone is
2.3 KB (~570 tokens, the largest on the server). Instead `browser.sh` runs the
server with `ZENDRIVER_MCP_AUTOSTART_BROWSER=1`, so the first tool that needs a
browser opens one. That fix lives in the server, so both modes get it.

`freezeDirectTools` is on: the registered surface is part of the prompt prefix,
and this stack reuses KV cache across turns and restarts, so a reconnect must not
rewrite it mid-session.

The package is **not vendored** — 42 dependencies, 83 MB installed. `pi-local.sh`
checks for it, warns with the exact install command, and falls back to CLI mode
rather than passing pi a `--mcp-config` flag that only exists when the adapter is
loaded:

```bash
pi install npm:pi-mcp-adapter@2.26.0     # the version .env pins
```

### CLI mode — the same server, through the shell

`MCP_ADAPTER_ENABLED=0` (or no adapter installed) loads `skills/browser` instead,
and the model shells out. This is also what a human or a script uses, and it needs
no npm package at all:

```bash
./scripts/browser.sh navigate --url https://example.com   # opens Chrome if needed
./scripts/browser.sh get_text_content                     # the page as plain text
./scripts/browser.sh get_interaction_tree                 # numbered clickable elements
./scripts/browser.sh get_interaction_tree --links         # ...with each link's target
./scripts/browser.sh click --selector 3
./scripts/browser.sh --search cookie                      # find one of the other 98 tools
./scripts/browser.sh <tool> --help                        # that one tool's parameters
./scripts/browser.sh up | status | down                   # the server, in both modes
```

### Why it is not just another entry in mcp/servers.json

There deliberately is not one — `mcp/servers.json` says so where the entry would
be, and CI keeps it that way. Three reasons, all measured on 2026-08-16:

- **A browser is stateful and mcp2cli is not.** mcp2cli spawns the server per
  call, and its `--session-start` daemon does not work here (same finding as
  above). Every call would therefore get a fresh process and a fresh Chrome:
  `navigate` opens a page that the next command cannot see. The server here runs
  once and every call reaches that one process, whose `BrowserSession` is a
  module-level singleton — so the tab survives across calls that are separate OS
  processes. Verified by navigating in one shell command and reading the page in
  the next.
- **Latency.** One mcp2cli invocation costs **11-60 s** on this box (it is a fat
  Python venv paying its import cost on every call). One direct `tools/call` POST
  to the running server costs **24 ms**. A browser task is 20-plus calls.

- **A stale tool list, silently.** Found while testing the entry that used to be
  in the registry: mcp2cli **caches the tool list per URL**, so after the server's
  surface changes it keeps offering the old one. A gateway-mode experiment left it
  convinced the server had 10 tools, and `get-page-info` came back as
  `invalid choice` rather than as anything naming the real problem. `--refresh`
  fixes it — if you know to. Both supported paths read `tools/list` live.

Both paths therefore speak MCP streamable-http to the server directly. `browser.sh`
does it in **stateless mode**, where a single POST carries a whole `tools/call`
with no initialize handshake, in stdlib-only Python: no `uv`, no install step,
nothing pinned.

### The context arithmetic, again

Wiring these 98 tools into a client that loads schemas costs **76,893 bytes —
about 19k tokens** — before the first message. That was **60% of the 32K window**
this was measured on; at today's `CTX_SIZE=98304` it is **about 20%**. Still a
fifth of the window spent before the model has read anything. Neither mode
pays that. Adapter mode buys back 5 tools and a search hop for 2,178 tokens; CLI
mode pays almost nothing standing and charges for discovery instead:

| What | Cost |
| --- | --- |
| The skill's name and description, every session | ~120 tokens |
| `--list --compact` (all 98 names) | ~370 tokens |
| `--search <word>` (typically 8 lines) | ~100 tokens |
| One tool's `--help` | ~130 tokens |

The server *does* ship a search gateway (`ZENDRIVER_MCP_GATEWAY=1`) that collapses
98 tools to 10 for clients that load schemas. Both modes deliberately turn it off:
neither loads schemas up front, so the gateway would only add a `call_tool`
indirection hop and hide 88 tools behind a search that the adapter's own `mcp`
proxy and the CLI both do better.

### Nothing to manage

The model is never told to start, stop or check anything, and neither skill
mentions a lifecycle command. That is not politeness — every
sentence about operating a service is context that could have been the page it
was asked to read, and a model that believes it must repair the browser will
spend a turn trying.

So the machinery holds itself up, at three levels:

- **The server starts with the session** (`BROWSER_MCP_AUTOUP`), before the model
  can reach a closed port.
- **A supervisor restarts it if it dies** — `browser.sh up` starts a supervisor,
  not the server, and it puts the server back with exponential backoff, giving up
  loudly after 10 restarts in 10 minutes. It also kills the dead server's process
  group, because a crashed server leaves Chrome re-parented to init holding its
  profile (measured: `ppid=1`, and the replacement server started a second Chrome
  beside it).
- **Chrome opens on the first tool that needs it, and is replaced if it dies.**
  Both live in the server, so the CLI and the adapter get them equally. Verified
  by killing each layer under a live session and watching the next call succeed.

**None of that covered the failure that actually happened.** On 2026-08-16 Chrome
stopped answering its own DevTools endpoint while the MCP server in front of it
stayed perfectly healthy — `tools/list` instant, `get_browser_status` cheerfully
reporting *"Running, 1 tab"*, and every `navigate` hanging until the client gave
up. It sat like that for four hours. The supervisor was watching the half that
had not broken, and `status` was asking the server about a browser that was gone,
which is a question the server answers from cache. A health check that cannot
fail is not a health check.

So health is now measured against Chrome itself:

- **`./scripts/browser.sh health`** probes Chrome's CDP endpoint directly —
  found by process ancestry, so it cannot report another session's browser as
  this one's — and exits `0` healthy, `2` wedged. `status` grew the same probe
  and the same third exit code, and prints zendriver's view only *after* it,
  clearly labelled as the cached opinion it is.
- **The supervisor watches Chrome, not just the server.** Two consecutive failed
  probes (30 s apart) and it restarts the server, whose process group takes the
  wedged Chrome with it. It does not try `stop_browser` first: that is a call
  into the process whose browser is the thing not responding.
- **`browser.sh up` opens Chrome up front** (`BROWSER_MCP_WARM`). A cold launch
  measured **74 s** — longer than the MCP SDK's default per-request timeout, so
  the first tool call used to fail with a timeout while nothing was wrong.
- **`./scripts/browser.sh reap [--dry-run]`** clears leftovers from servers that
  died without stopping. Deliberately narrow: only processes whose parent is
  already gone, and only profile directories no live Chrome references — several
  agent sessions on this box run their own bridge, and those have live owners.

And when a call does time out, the model is told something it can act on. It used
to get `Failed to call tool: Request timed out` followed by a dump of the tool's
parameters — a parameter dump, for a failure that has nothing to do with
parameters. It did the only thing that message suggests: sent the identical call
again, waited another 60 s, and only then guessed its way to `curl`. Two minutes
and ~500 tokens for a page that was never going to load.
`.pi/extensions/browser-guard.ts` now rewrites that result, using a live probe to
say *which* failure it is — wedged, not started, or a slow page — and to tell the
model to fall back to `bash` rather than retry. It registers no tools and no
commands, so it costs nothing in the window.

`./scripts/browser.sh up | status | down | logs` still exist — for you, not for
the model. Chrome costs a few hundred MB while it is open; `down` stops it and
the supervisor together.

### Two things that were measured rather than assumed

- **`FASTMCP_HOST` / `FASTMCP_PORT` are ignored.** FastMCP documents them, but in
  mcp SDK ≥ 1.28 `FastMCP.__init__` passes its own keyword defaults straight to
  `Settings`, bypassing the environment. Exporting `FASTMCP_PORT=8931` produced a
  server bound to **8000**, announcing 8000, with no error. The fork's `run.py`
  now takes `--transport / --host / --port` and sets `mcp.settings` directly.
- **A tool call needs no `initialize`.** In stateless mode the server answers a
  bare `tools/call` POST, which is what makes a shell wrapper practical. In
  stateful mode (`run.py --stateful`) it does not, and the reply is framed as SSE.

### Knobs

| Variable | Default | What it does |
| --- | --- | --- |
| `BROWSER_MCP_ENABLED` | `1` | Offer the browser at all (loads one of the two skills) |
| `MCP_ADAPTER_ENABLED` | `1` | Native tools via pi-mcp-adapter; `0` falls back to the CLI |
| `MCP_ADAPTER_VERSION` | `2.26.0` | Pinned adapter version, checked at launch |
| `BROWSER_MCP_AUTOUP` | `1` | Start the server at launch in adapter mode (no Chrome yet) |
| `ZENDRIVER_MCP_DIR` | `/opt/zendriver-mcp` | The Zendriver-MCP checkout to run |
| `BROWSER_MCP_HOST` / `_PORT` | `127.0.0.1` / `8931` | Where the server listens; `mcp/adapter.json` interpolates both |
| `BROWSER_MCP_DISPLAY` | `:99` | X display for Chrome; empty inherits `DISPLAY` |
| `BROWSER_MCP_AUTOSTART` | `1` | Let a tool call start the server, and the server open Chrome |
| `BROWSER_MCP_TIMEOUT` | `180` | Seconds one tool call may take |

Adapter tuning that is not a port — the direct-tool list, the output guard, the
lifecycle — lives in `mcp/adapter.json`, commented in place.


## Commands

| Command | What it does |
| --- | --- |
| `./scripts/mcp.sh --servers` | List MCP servers reachable as a CLI |
| `./scripts/rtk.sh --install` | One-time: install the pinned rtk that filters bash output |
| `./scripts/rtk.sh --status` | What is being filtered, and whether the pin matches |
| `./scripts/rtk.sh --check` | Do rtk's filters still behave the way the allow-list assumes |
| `./scripts/browser.sh status` | Is the browser up, and what page is open |
| `./scripts/browser.sh health` | Probe Chrome itself (exit 2 = wedged) |
| `./scripts/browser.sh reap` | Clear leftovers from servers that died |
| `./scripts/browser.sh down` | Stop Chrome and its server |
| `pi install npm:pi-mcp-adapter@2.26.0` | One-time: the browser as native pi tools |

---

[← back to the README](../README.md)
