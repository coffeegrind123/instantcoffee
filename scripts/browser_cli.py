#!/usr/bin/env python3
"""Drive a long-lived Zendriver MCP browser server from the shell.

Called through ./scripts/browser.sh, which resolves the .env knobs first. See
skills/browser/SKILL.md for the loop this is meant to be used with.

Why this exists rather than ./scripts/mcp.sh browser <tool>:

  1. A browser is STATEFUL. mcp2cli spawns the server per call and its
     --session-start daemon does not work here (measured 2026-08-12, see the
     README), so every call would get a fresh process and a fresh Chrome:
     `navigate` would open a page that `get_text_content` could never see. The
     server therefore runs once, over HTTP, and every call reaches that one
     process. Its BrowserSession is a module-level singleton, so the tab
     survives across calls that are separate OS processes.
  2. Latency. On this box, one mcp2cli invocation costs 11-43 s (it is a fat
     Python venv, and it pays that import cost on every call); one raw
     tools/call POST to the running server costs 24 ms. A browser task is
     20-plus calls, so that difference decides whether the model can use a
     browser at all.

The transport is MCP streamable-http in stateless mode, which needs no
initialize handshake: a single POST carries a whole tools/call. Everything here
is stdlib — no dependency to install, nothing to keep pinned.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

# --- configuration -----------------------------------------------------------
# Every value is resolved by browser.sh from .env and handed over as an env var,
# so this file has no opinion about where the defaults live.
HOST = os.environ.get("BROWSER_MCP_HOST") or "127.0.0.1"
PORT = int(os.environ.get("BROWSER_MCP_PORT") or "8931")
PATH = os.environ.get("BROWSER_MCP_PATH") or "/mcp"
URL = f"http://{HOST}:{PORT}{PATH}"
SERVER_DIR = os.environ.get("ZENDRIVER_MCP_DIR") or "/opt/zendriver-mcp"
PYTHON = os.environ.get("BROWSER_MCP_PYTHON") or sys.executable or "python3"
DISPLAY = os.environ.get("BROWSER_MCP_DISPLAY") or ""
STATE_DIR = os.environ.get("BROWSER_MCP_STATE_DIR") or os.path.expanduser(
    "~/.cache/qwen-forge-browser"
)
AUTOSTART = (os.environ.get("BROWSER_MCP_AUTOSTART") or "1") == "1"
START_TIMEOUT = float(os.environ.get("BROWSER_MCP_START_TIMEOUT") or "60")
CALL_TIMEOUT = float(os.environ.get("BROWSER_MCP_TIMEOUT") or "180")

PID_FILE = os.path.join(STATE_DIR, f"server-{PORT}.pid")
LOG_FILE = os.path.join(STATE_DIR, f"server-{PORT}.log")

# Zendriver's own guard text, matched so an "I forgot to open a browser" error
# can be recovered from instead of returned to the model as a failure.
NO_BROWSER = "Browser not started"


def err(msg: str) -> None:
    print(msg, file=sys.stderr)


def die(msg: str, code: int = 1) -> "None":
    err(f"err  {msg}")
    raise SystemExit(code)


# --- transport ---------------------------------------------------------------
def rpc(method: str, params: dict | None = None, timeout: float = 30.0) -> dict:
    """One JSON-RPC call. Raises ConnectionError when nothing is listening."""
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    ).encode()
    req = urllib.request.Request(
        URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            # Both are required by the streamable-http spec even though a
            # stateless server answers with plain JSON.
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type", "")
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:  # server answered, but not with a result
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"HTTP {e.code} from {URL}: {detail}") from e
    except urllib.error.URLError as e:
        raise ConnectionError(str(e.reason)) from e

    if "text/event-stream" in ctype:
        # A stateful server frames the reply as SSE; take the first data line.
        for line in raw.splitlines():
            if line.startswith("data:"):
                raw = line[5:].strip()
                break
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"unparseable reply from {URL}: {raw[:300]}") from e
    if "error" in msg:
        e = msg["error"]
        raise RuntimeError(f"{e.get('message', 'error')} (code {e.get('code')})")
    return msg.get("result") or {}


def is_up(timeout: float = 3.0) -> bool:
    try:
        rpc("tools/list", timeout=timeout)
        return True
    except (ConnectionError, RuntimeError):
        return False


def list_tools() -> list[dict]:
    return rpc("tools/list").get("tools") or []


# --- server lifecycle --------------------------------------------------------
def read_pid() -> int | None:
    try:
        with open(PID_FILE) as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def start_server(quiet: bool = False) -> None:
    if is_up():
        if not quiet:
            print(f"  ok browser MCP already up at {URL}")
        return

    run_py = os.path.join(SERVER_DIR, "run.py")
    if not os.path.isfile(run_py):
        die(
            f"no Zendriver MCP checkout at {SERVER_DIR} (expected {run_py}).\n"
            "     Clone it and point ZENDRIVER_MCP_DIR at it:\n"
            "       git clone https://github.com/coffeegrind123/Zendriver-MCP-fork.git"
        )

    env = dict(os.environ)
    # Chrome needs an X display even headless-adjacent: this stack runs it
    # against the Xvfb that is already in the container. Without it the launch
    # fails deep inside zendriver with an error that does not name the cause.
    if DISPLAY:
        env["DISPLAY"] = DISPLAY
    # The full tool surface is deliberate. The server's search gateway exists to
    # shrink an MCP *schema* surface for a client that loads schemas; pi loads
    # none, and this CLI is already lazy (--search, then one --help). Turning the
    # gateway on here would only add a call_tool indirection hop and hide 88
    # tools behind a search that the CLI does better.
    env.pop("ZENDRIVER_MCP_GATEWAY", None)
    # Open Chrome on the first tool that needs it, in the SERVER rather than in
    # this client, so every client gets it — the CLI, and pi's MCP adapter, which
    # would otherwise have to carry start_browser's 2.3 KB schema (~570 tokens,
    # the largest on the server) purely to satisfy a precondition.
    if AUTOSTART:
        env["ZENDRIVER_MCP_AUTOSTART_BROWSER"] = "1"

    os.makedirs(STATE_DIR, exist_ok=True)
    log = open(LOG_FILE, "ab", buffering=0)
    log.write(f"\n=== start {time.strftime('%Y-%m-%d %H:%M:%S')} {URL} ===\n".encode())
    # A supervisor, not the server itself. Nobody is watching this process: if
    # the server dies mid-session — a Chrome that takes it down, an OOM kill —
    # the next tool call would get a connection refused, and the model's job is
    # to read a web page, not to notice that a service needs restarting.
    proc = subprocess.Popen(
        [PYTHON, os.path.abspath(__file__), "supervise"],
        cwd=SERVER_DIR,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        # Detach from this shell so the server outlives the CLI invocation that
        # started it — the whole point is that it stays up between calls.
        start_new_session=True,
    )
    with open(PID_FILE, "w") as fh:
        fh.write(str(proc.pid))

    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            die(f"browser MCP server exited immediately (rc={proc.returncode}) — see {LOG_FILE}")
        if is_up(timeout=2.0):
            if not quiet:
                print(f"  ok browser MCP up at {URL} (pid {proc.pid}, log {LOG_FILE})")
            return
        time.sleep(0.5)
    die(f"browser MCP server did not answer within {START_TIMEOUT:.0f}s — see {LOG_FILE}")


def supervise() -> "None":
    """Run the server, and put it back when it dies. Never returns.

    Spawned detached by start_server(); this process is what PID_FILE names, so
    stopping it stops the server with it.
    """
    run_py = os.path.join(SERVER_DIR, "run.py")
    argv = [
        PYTHON,
        run_py,
        "--transport",
        "streamable-http",
        "--host",
        HOST,
        "--port",
        str(PORT),
    ]
    child: subprocess.Popen | None = None

    def reap_group(proc: subprocess.Popen) -> None:
        """Kill everything the dead server spawned, Chrome included.

        The server is started in its own process group, so one killpg reaches
        the browser it launched. Without this a crashed server leaves Chrome
        resident and re-parented to init — measured: a SIGKILLed server left a
        Chrome with ppid=1 holding its profile, and the next server started a
        second one beside it.
        """
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def shutdown(_signum: int, _frame: object) -> None:
        # Take the server with us, and let it close Chrome on the way: a SIGTERM
        # to the server alone leaves the browser resident with its profile open.
        if child and child.poll() is None:
            try:
                call_tool("stop_browser", {}, timeout=20.0)
            except Exception:  # noqa: BLE001 — shutting down either way
                pass
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
            reap_group(child)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    # A crash loop must not become a fork bomb against a browser that cannot
    # start at all (no X display, no Chrome). Back off, and give up loudly.
    restarts: list[float] = []
    delay = 1.0
    while True:
        # Its own process group, so reap_group() can take Chrome with it.
        child = subprocess.Popen(
            argv, cwd=SERVER_DIR, stdin=subprocess.DEVNULL, start_new_session=True
        )
        rc = child.wait()
        reap_group(child)
        now = time.time()
        restarts = [t for t in restarts if now - t < 600] + [now]
        print(
            f"[supervisor] server exited rc={rc}; restart "
            f"{len(restarts)} of 10 in the last 10 min",
            flush=True,
        )
        if len(restarts) >= 10:
            print("[supervisor] giving up — 10 restarts in 10 minutes", flush=True)
            raise SystemExit(1)
        time.sleep(delay)
        delay = min(delay * 2, 30.0)
        if len(restarts) == 1:
            delay = 1.0  # a lone crash after a long healthy run is not a loop


def stop_server(quiet: bool = False) -> None:
    up = is_up()
    if up:
        # Kill Chrome through the server first. A SIGTERM to the server does NOT
        # take the browser with it — measured 2026-08-16: the server died and
        # Chrome stayed resident with its profile still open.
        try:
            call_tool("stop_browser", {}, timeout=30.0)
        except Exception as e:  # noqa: BLE001 — best effort, we are shutting down
            err(f"warn stop_browser failed ({e}); the Chrome process may be left behind")

    pid = read_pid()
    if pid is None:
        if not quiet:
            print("  ok browser MCP is not running" if not up else "  ok stopped (no pid file)")
        return
    os.kill(pid, signal.SIGTERM)
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            if not quiet:
                print(f"  ok browser MCP stopped (pid {pid})")
            _rm(PID_FILE)
            return
        time.sleep(0.3)
    os.kill(pid, signal.SIGKILL)
    _rm(PID_FILE)
    if not quiet:
        print(f"  ok browser MCP killed (pid {pid} ignored SIGTERM)")


def _rm(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def status() -> int:
    pid = read_pid()
    if not is_up():
        print(f"down  {URL}" + (f"  (stale pid {pid})" if pid else ""))
        print(f"      start it with: ./scripts/browser.sh up   (log: {LOG_FILE})")
        return 1
    tools = list_tools()
    print(f"up    {URL}  pid {pid or '?'}  {len(tools)} tools  log {LOG_FILE}")
    if any(t["name"] == "get_browser_status" for t in tools):
        try:
            print("      " + text_of(call_tool("get_browser_status", {})).replace("\n", " ")[:300])
        except Exception as e:  # noqa: BLE001
            err(f"warn could not read browser status: {e}")
    return 0


# --- tool calls --------------------------------------------------------------
def call_tool(name: str, arguments: dict, timeout: float | None = None) -> dict:
    return rpc(
        "tools/call",
        {"name": name, "arguments": arguments},
        timeout=timeout if timeout is not None else CALL_TIMEOUT,
    )


def text_of(result: dict) -> str:
    """Flatten an MCP result to what a human (or a 27B model) should read."""
    out = []
    for block in result.get("content") or []:
        kind = block.get("type")
        if kind == "text":
            out.append(block.get("text", ""))
        elif kind == "image":
            # Never print base64 into the conversation: one screenshot is tens of
            # thousands of tokens. Tools that produce images take save_path.
            data = block.get("data") or ""
            out.append(
                f"[image {block.get('mimeType', 'image/png')}, {len(data)} base64 chars "
                "— pass save_path=<file> to write it to disk instead of returning it]"
            )
        else:
            out.append(json.dumps(block, separators=(",", ":")))
    return "\n".join(out)


def first_sentence(desc: str) -> str:
    text = " ".join((desc or "").split())
    i = text.find(". ")
    return text[: i + 1] if i != -1 else text


def normalise(name: str) -> str:
    """Accept get-text-content as well as get_text_content."""
    return name.replace("-", "_")


def coerce(value: str, spec: dict) -> object:
    """Turn a shell string into the JSON type the tool's schema asks for."""
    typ = spec.get("type")
    if typ is None:  # anyOf / union — let the server validate it
        for branch in spec.get("anyOf") or []:
            if branch.get("type") and branch.get("type") != "null":
                typ = branch["type"]
                break
    if typ == "integer":
        try:
            return int(value)
        except ValueError:
            die(f"expected an integer, got {value!r}")
    if typ == "number":
        try:
            return float(value)
        except ValueError:
            die(f"expected a number, got {value!r}")
    if typ == "boolean":
        low = value.strip().lower()
        if low in {"1", "true", "yes", "on"}:
            return True
        if low in {"0", "false", "no", "off"}:
            return False
        die(f"expected a boolean, got {value!r}")
    if typ in {"object", "array"}:
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            die(f"expected JSON for a {typ} parameter, got {value!r}")
    return value


def parse_tool_args(tool: dict, argv: list[str]) -> dict:
    """--url X / --url=X / --flag, validated against the tool's own schema.

    Unknown flags are an error rather than a silent drop: a mistyped parameter
    that vanishes produces a call that succeeds and does the wrong thing, which
    is the worst failure mode available here.
    """
    schema = tool.get("inputSchema") or {}
    props = schema.get("properties") or {}
    args: dict = {}
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == "--stdin":
            blob = sys.stdin.read().strip()
            if blob:
                try:
                    args.update(json.loads(blob))
                except json.JSONDecodeError as e:
                    die(f"--stdin expects a JSON object: {e}")
            i += 1
            continue
        if token == "--args-json":
            if i + 1 >= len(argv):
                die("--args-json needs a JSON object")
            try:
                args.update(json.loads(argv[i + 1]))
            except json.JSONDecodeError as e:
                die(f"--args-json expects a JSON object: {e}")
            i += 2
            continue
        if not token.startswith("--"):
            die(f"unexpected argument {token!r} — parameters are passed as --name value")

        key, eq, inline = token[2:].partition("=")
        key = normalise(key)
        if key not in props:
            known = ", ".join(sorted(props)) or "(none)"
            die(f"{tool['name']} has no parameter '{key}'. It takes: {known}")
        spec = props[key]
        if eq:
            args[key] = coerce(inline, spec)
            i += 1
            continue
        # A bare --flag means true, but only where the schema says boolean;
        # anywhere else it is a missing value, not a shorthand.
        nxt = argv[i + 1] if i + 1 < len(argv) else None
        if nxt is None or (nxt.startswith("--") and spec.get("type") == "boolean"):
            if spec.get("type") != "boolean":
                die(f"--{key} needs a value")
            args[key] = True
            i += 1
            continue
        args[key] = coerce(nxt, spec)
        i += 2
    return args


def tool_help(tool: dict) -> str:
    schema = tool.get("inputSchema") or {}
    props = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    sig = " ".join(
        f"--{n} <{(s.get('type') or 'any')}>" if n in required else f"[--{n} <{(s.get('type') or 'any')}>]"
        for n, s in props.items()
    )
    lines = [f"usage: ./scripts/browser.sh {tool['name']} {sig}".rstrip(), ""]
    lines.append(" ".join((tool.get("description") or "").split()))
    if props:
        lines.append("")
        lines.append("parameters:")
        for name, spec in props.items():
            typ = spec.get("type") or "any"
            mark = "required" if name in required else "optional"
            default = spec.get("default")
            tail = f", default {json.dumps(default)}" if default is not None else ""
            lines.append(f"  --{name} <{typ}>  ({mark}{tail})")
            desc = " ".join((spec.get("description") or "").split())
            if desc:
                lines.append(f"      {desc}")
    return "\n".join(lines)


def ensure_up() -> None:
    if is_up():
        return
    if not AUTOSTART:
        die("browser MCP is not running — start it with ./scripts/browser.sh up")
    err("==> browser MCP is not running; starting it")
    start_server(quiet=True)


# --- main --------------------------------------------------------------------
USAGE = """\
Drive a real Chrome from the shell. The server stays up between calls, so a page
you open in one call is still open in the next.

  ./scripts/browser.sh up | down | restart | status | logs
  ./scripts/browser.sh --list --compact          every tool name (~2 tokens each)
  ./scripts/browser.sh --search <word>           find a tool by name or purpose
  ./scripts/browser.sh <tool> --help             that one tool's parameters
  ./scripts/browser.sh <tool> --name value       call it

  ./scripts/browser.sh start_browser
  ./scripts/browser.sh navigate --url https://example.com
  ./scripts/browser.sh get_interaction_tree      numbered, clickable elements
  ./scripts/browser.sh click --selector 3        click by that number
  ./scripts/browser.sh get_text_content          the page as text, paginated

Output flags: --json (full MCP envelope), --head N (first N lines).
"""


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help", "help"}:
        print(USAGE)
        return 0

    cmd, rest = argv[0], argv[1:]

    if cmd == "supervise":  # internal: what start_server() actually spawns
        supervise()
        return 0
    if cmd == "up":
        start_server()
        return 0
    if cmd == "down":
        stop_server()
        return 0
    if cmd == "restart":
        stop_server(quiet=True)
        start_server()
        return 0
    if cmd == "status":
        return status()
    if cmd == "logs":
        n = int(rest[0]) if rest and rest[0].isdigit() else 40
        if not os.path.isfile(LOG_FILE):
            print(f"no log yet at {LOG_FILE}")
            return 0
        with open(LOG_FILE, errors="replace") as fh:
            for line in fh.readlines()[-n:]:
                print(line.rstrip())
        return 0

    # Everything below talks to the server.
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--head", type=int, default=0)
    out_flags, rest = parser.parse_known_args(rest)

    if cmd in {"--list", "-l"}:
        ensure_up()
        compact = "--compact" in rest
        tools = list_tools()
        if compact:
            print(" ".join(t["name"] for t in tools))
        else:
            for t in tools:
                print(f"{t['name']:<28} {first_sentence(t.get('description') or '')[:90]}")
            err(f"\n{len(tools)} tools. Cheaper: --list --compact, or --search <word>.")
        return 0

    if cmd in {"--search", "-s"}:
        if not rest:
            die("--search needs a word")
        ensure_up()
        pat = re.compile(re.escape(rest[0]), re.I)
        hits = [
            t
            for t in list_tools()
            if pat.search(t["name"]) or pat.search(t.get("description") or "")
        ]
        if not hits:
            print(f"no tool matches '{rest[0]}' — try a broader word, or --list --compact")
            return 1
        for t in hits:
            print(f"{t['name']:<28} {first_sentence(t.get('description') or '')[:90]}")
        return 0

    # A tool call.
    name = normalise(cmd)
    ensure_up()
    tools = {t["name"]: t for t in list_tools()}
    tool = tools.get(name)
    if tool is None:
        near = [n for n in tools if name.split("_")[0] in n][:8]
        die(
            f"no tool named '{name}'."
            + (f" Close: {', '.join(near)}." if near else "")
            + " Find one with: ./scripts/browser.sh --search <word>"
        )

    if any(a in {"--help", "-h"} for a in rest):
        print(tool_help(tool))
        return 0

    arguments = parse_tool_args(tool, rest)
    result = call_tool(name, arguments)

    # One retry after opening a browser: on a fresh server every tool but
    # start_browser fails this way, and the recovery is unambiguous.
    body = text_of(result)
    if result.get("isError") and NO_BROWSER in body and name != "start_browser" and AUTOSTART:
        err("==> no browser open; calling start_browser first")
        start = call_tool("start_browser", {})
        if start.get("isError"):
            err(text_of(start))
            return 1
        result = call_tool(name, arguments)
        body = text_of(result)

    if out_flags.json:
        print(json.dumps(result, separators=(",", ":")))
    else:
        if out_flags.head > 0:
            body = "\n".join(body.splitlines()[: out_flags.head])
        print(body)
    return 1 if result.get("isError") else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ConnectionError as exc:
        die(f"cannot reach the browser MCP server at {URL} ({exc}).\n"
            "     Start it with: ./scripts/browser.sh up")
    except RuntimeError as exc:
        die(str(exc))
    except KeyboardInterrupt:
        raise SystemExit(130) from None
