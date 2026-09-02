#!/usr/bin/env python3
"""Standalone unit tests for scripts/browser_cli.py. No server, no network.

    python3 scripts/test_browser_cli.py

What is worth testing here is the layer between a shell word and a JSON value.
Everything else in that file is I/O against a server that has its own test
suite; the argument parser is ours, and its failure mode is the quiet one — a
mistyped parameter that vanishes produces a call that succeeds and does the
wrong thing.
"""

import http.server
import importlib.util
import io
import json
import os
import pathlib
import socket
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("browser_cli", HERE / "browser_cli.py")
assert spec and spec.loader
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f"  ok   {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL {label}: got {got!r}, want {want!r}")


def check_dies(label: str, fn) -> None:
    """The CLI reports argument problems by exiting, not by raising."""
    err = io.StringIO()
    real, sys.stderr = sys.stderr, err
    try:
        fn()
    except SystemExit as e:
        code = e.code
    else:
        code = None
    finally:
        sys.stderr = real
    if code:
        print(f"  ok   {label} (exit {code}: {err.getvalue().strip()[:60]})")
    else:
        FAILURES.append(label)
        print(f"  FAIL {label}: did not exit")


NAVIGATE = {
    "name": "navigate",
    "description": "Navigate the active tab to a URL. Waits for load.",
    "inputSchema": {
        "type": "object",
        "properties": {"url": {"type": "string"}},
        "required": ["url"],
    },
}

SCREENSHOT = {
    "name": "screenshot",
    "description": "Take a screenshot.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "save_path": {"type": "string"},
            "full_resolution": {"type": "boolean", "default": False},
            "quality": {"type": "integer", "default": 60},
            "scale": {"type": "number"},
            "regions": {"type": "array"},
        },
        "required": [],
    },
}


def main() -> int:
    print("browser_cli: argument parsing")
    check("--name value", bc.parse_tool_args(NAVIGATE, ["--url", "https://x.dev"]), {"url": "https://x.dev"})
    check("--name=value", bc.parse_tool_args(NAVIGATE, ["--url=https://x.dev"]), {"url": "https://x.dev"})
    check("dashes in a flag name", bc.parse_tool_args(SCREENSHOT, ["--save-path", "/tmp/a.png"]), {"save_path": "/tmp/a.png"})
    check("--args-json merges", bc.parse_tool_args(NAVIGATE, ["--args-json", '{"url":"https://y.dev"}']), {"url": "https://y.dev"})

    print("browser_cli: type coercion")
    check("integer", bc.parse_tool_args(SCREENSHOT, ["--quality", "80"]), {"quality": 80})
    check("number", bc.parse_tool_args(SCREENSHOT, ["--scale", "1.5"]), {"scale": 1.5})
    check("array as JSON", bc.parse_tool_args(SCREENSHOT, ["--regions", "[1,2]"]), {"regions": [1, 2]})
    check("boolean word", bc.parse_tool_args(SCREENSHOT, ["--full_resolution", "true"]), {"full_resolution": True})
    check("boolean off", bc.parse_tool_args(SCREENSHOT, ["--full_resolution", "no"]), {"full_resolution": False})
    # A bare flag is true ONLY where the schema says boolean — anywhere else it
    # is a missing value, and treating it as a shorthand would silently send the
    # wrong type.
    check("bare boolean flag", bc.parse_tool_args(SCREENSHOT, ["--full_resolution"]), {"full_resolution": True})
    check(
        "bare boolean before another flag",
        bc.parse_tool_args(SCREENSHOT, ["--full_resolution", "--save_path", "/tmp/a.png"]),
        {"full_resolution": True, "save_path": "/tmp/a.png"},
    )

    print("browser_cli: bad input fails loudly")
    check_dies("unknown parameter", lambda: bc.parse_tool_args(NAVIGATE, ["--ur", "https://x.dev"]))
    check_dies("missing value", lambda: bc.parse_tool_args(NAVIGATE, ["--url"]))
    check_dies("non-integer for an integer", lambda: bc.parse_tool_args(SCREENSHOT, ["--quality", "high"]))
    check_dies("non-JSON for an array", lambda: bc.parse_tool_args(SCREENSHOT, ["--regions", "1,2"]))
    check_dies("positional argument", lambda: bc.parse_tool_args(NAVIGATE, ["https://x.dev"]))

    print("browser_cli: result rendering")
    check("text block", bc.text_of({"content": [{"type": "text", "text": "hi"}]}), "hi")
    # An image must never reach the conversation as base64: one screenshot is
    # tens of thousands of tokens, and this model cannot read it anyway.
    img = bc.text_of({"content": [{"type": "image", "mimeType": "image/png", "data": "A" * 5000}]})
    check("image is summarised, not dumped", ("A" * 100 not in img and "save_path" in img), True)
    check("first sentence", bc.first_sentence(NAVIGATE["description"]), "Navigate the active tab to a URL.")
    check("tool name normalising", bc.normalise("get-text-content"), "get_text_content")

    print("browser_cli: help rendering")
    help_text = bc.tool_help(NAVIGATE)
    check("help names the required arg", "--url <string>" in help_text, True)
    check("help marks it required", "(required)" in help_text, True)

    # ---------------------------------------------------------------------
    # Chrome health. The bug this replaces: the MCP server answered `tools/list`
    # instantly and reported "Browser: Running, 1 tab" for four hours while
    # Chrome's own CDP endpoint answered nothing and every navigate hung. So the
    # probe must go to Chrome, and it must be able to say "wedged" out loud.
    # ---------------------------------------------------------------------
    print("browser_cli: process introspection")
    me = os.getpid()
    check("_ppid finds a real parent", bc._ppid(me) == os.getppid(), True)
    check("_ppid on a pid that cannot exist", bc._ppid(2**22), None)
    check("_descends_from own parent", bc._descends_from(me, os.getppid()), True)
    check("_descends_from an unrelated pid", bc._descends_from(me, 2**22 - 1), False)
    check("_read_cmdline of self is non-empty", len(bc._read_cmdline(me)) > 0, True)

    print("browser_cli: CDP probe")
    # A closed port must fail FAST — a slow "no" here would reproduce the hang.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        dead_port = probe.getsockname()[1]
    started = time.time()
    alive, _ = bc.cdp_ok(dead_port, timeout=2.0)
    check("closed port reports not alive", alive, False)
    check("and does so quickly", time.time() - started < 5.0, True)

    class _Version(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_a):  # noqa: D401 — silence the default logger
            pass

        def do_GET(self):
            body = json.dumps({"Browser": "Chrome/150.0.0.0"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.HTTPServer(("127.0.0.1", 0), _Version)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    live_port = server.server_address[1]
    try:
        alive, detail = bc.cdp_ok(live_port, timeout=5.0)
        check("an answering endpoint reports alive", alive, True)
        check("and names the build", detail, "Chrome/150.0.0.0")

        print("browser_cli: health verdicts")
        real_find = bc.find_chrome
        try:
            bc.find_chrome = lambda: None
            check("no browser is 'none', not 'wedged'", bc.chrome_health()[0], "none")
            bc.find_chrome = lambda: (me, live_port)
            check("an answering browser is 'ok'", bc.chrome_health()[0], "ok")
            bc.find_chrome = lambda: (me, dead_port)
            state, detail = bc.chrome_health()
            check("a silent browser is 'wedged'", state, "wedged")
            # The detail is what an operator acts on, so it must carry both the
            # pid to kill and the endpoint that failed.
            check("and the verdict names pid and port", str(me) in detail and str(dead_port) in detail, True)
        finally:
            bc.find_chrome = real_find
    finally:
        server.shutdown()
        server.server_close()

    # AR2 — three server states, three verdicts, and no traceback.
    #
    # `is_up` caught ConnectionError and RuntimeError. A server that ACCEPTS the
    # connection and then says nothing raises TimeoutError, which is an OSError
    # and not a ConnectionError, so it escaped — out of `status`, which is the
    # one command you run when calls have stopped returning. Reproduced against
    # a socket that accepts and never answers.
    print("browser_cli: server states")
    import socket as _socket
    import subprocess as _subprocess
    import sys as _sys
    import threading as _threading

    def _status_exit(port: int) -> tuple[int, str, bool]:
        env = dict(os.environ, BROWSER_MCP_HOST="127.0.0.1",
                   BROWSER_MCP_PORT=str(port), BROWSER_MCP_AUTOSTART="0")
        r = _subprocess.run([_sys.executable, str(HERE / "browser_cli.py"), "status"],
                            capture_output=True, text=True, env=env, timeout=120)
        return r.returncode, r.stdout, "Traceback" in r.stderr

    hung = _socket.socket()
    hung.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    hung.bind(("127.0.0.1", 0))
    hung_port = hung.getsockname()[1]
    hung.listen(5)
    _held: list = []

    def _accept_forever() -> None:
        while True:
            try:
                conn, _ = hung.accept()
                _held.append(conn)
            except OSError:
                return

    _threading.Thread(target=_accept_forever, daemon=True).start()
    try:
        code, out, traced = _status_exit(hung_port)
        check("a hung server exits 2, not a traceback", (code, traced), (2, False))
        check("and says so", "HUNG" in out and "restart" in out, True)
    finally:
        hung.close()

    # The control: with nothing listening it must still say "down" and exit 1.
    # A probe that reported everything as hung would pass the test above.
    free = _socket.socket()
    free.bind(("127.0.0.1", 0))
    free_port = free.getsockname()[1]
    free.close()
    code, out, traced = _status_exit(free_port)
    check("nothing listening still exits 1", (code, traced), (1, False))
    check("and still says down", "down" in out, True)

    # --- a stale pid file is not a stopped server -----------------------------
    #
    # Measured 2026-09-02: the pid file named a process that no longer existed
    # while the real supervisor had been up 26 hours. read_pid() returned None,
    # stop_server() read that as "nothing to stop", start_server() then found the
    # port answering and said "already up" — so `restart` reported success and
    # changed nothing, leaving a freshly deployed fix on disk and unloaded.
    import subprocess as _sp

    print("\nstale pid file")
    # A port nothing can already be using. Hardcoding the real one (8931) made
    # this pass here and FAIL in the container it was deployed to, where a live
    # server owns that port and find_supervisor correctly returned it instead of
    # the fixture -- a test that only worked where the thing it tests was absent.
    _probe = _socket.socket()
    _probe.bind(("127.0.0.1", 0))
    marker_port = _probe.getsockname()[1]
    _probe.close()
    saved_port = bc.PORT
    bc.PORT = marker_port
    # A real process whose /proc cmdline carries both markers. Extra argv words
    # land in cmdline verbatim, which is exactly what find_supervisor matches on.
    child = _sp.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)", "zendriver-mcp",
         "--port", str(marker_port)]
    )
    try:
        time.sleep(0.3)
        check("finds the running server when the pid file cannot", bc.find_supervisor(), child.pid)

        # It must key on the PORT, not the script name: other agent sessions run
        # their own bridges and killing one of those breaks somebody else.
        bc.PORT = marker_port + 1
        check("ignores a server on a different port", bc.find_supervisor(), None)
        bc.PORT = marker_port

        # Prefers the supervisor over its child: the supervisor is what the pid
        # file names and what closes Chrome on the way out.
        real_cmdline, real_ppid = bc._read_cmdline, bc._ppid
        try:
            bc._read_cmdline = lambda pid: (
                "python browser_cli.py supervise" if pid == 4242 else real_cmdline(pid)
            )
            bc._ppid = lambda pid: 4242 if pid == child.pid else real_ppid(pid)
            check("prefers the supervisor over its child", bc.find_supervisor(), 4242)
        finally:
            bc._read_cmdline, bc._ppid = real_cmdline, real_ppid

        # And stop_server must actually signal it instead of returning quietly.
        signalled: list[int] = []
        real_up, real_read, real_kill, real_call = bc.is_up, bc.read_pid, os.kill, bc.call_tool
        real_pidfile = bc.PID_FILE
        # Snapshot it so the assertion below can actually fail.
        _sentinel = object()
        try:
            with open(real_pidfile) as _fh:
                pidfile_before = _fh.read()
        except OSError:
            pidfile_before = _sentinel  # type: ignore[assignment]
        try:
            bc.is_up = lambda *a, **k: True          # the port answers
            bc.read_pid = lambda: None               # the pid file cannot say who
            bc.call_tool = lambda *a, **k: None      # no server to ask
            # PID_FILE is computed at import from PORT, so moving PORT does NOT
            # move it: stop_server()'s cleanup would delete the REAL pid file of a
            # running server. It did, on the first run inside the container --
            # leaving a live supervisor that read_pid() could no longer name,
            # which is precisely the bug under test, caused by the test.
            bc.PID_FILE = os.path.join(
                os.path.dirname(real_pidfile) or ".", f"test-{marker_port}.pid"
            )
            os.kill = lambda pid, sig: signalled.append(pid) if sig != 0 else None
            bc.stop_server(quiet=True)
        finally:
            bc.is_up, bc.read_pid, os.kill, bc.call_tool = real_up, real_read, real_kill, real_call
            bc.PID_FILE = real_pidfile
        try:
            with open(real_pidfile) as _fh:
                pidfile_after = _fh.read()
        except OSError:
            pidfile_after = _sentinel  # type: ignore[assignment]
        check("the real pid file is untouched", pidfile_after, pidfile_before)
        check("stop_server signals the found server", child.pid in signalled, True)
    finally:
        child.kill()
        child.wait()
        bc.PORT = saved_port

    # The control: with no such process, find_supervisor must say so rather than
    # returning some other python it happened to see.
    bc.PORT = 65001
    check("no server means None, not a guess", bc.find_supervisor(), None)
    bc.PORT = saved_port

    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("\nall browser_cli tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
