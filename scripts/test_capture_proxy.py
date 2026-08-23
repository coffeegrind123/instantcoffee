#!/usr/bin/env python3
"""Unit + live-socket tests for the capture proxy — no LLM, no GPU, no compose.

Run with: python3 scripts/test_capture_proxy.py
     or:  python3 scripts/capture_proxy.py --self-test

WHAT THESE ARE FOR
------------------
The proxy sits in the production path between forge and llama. Two of its
promises are the kind that fail silently, so both get a control that can FAIL
rather than an assertion that can only pass:

  * "a stream is not buffered".  The fake upstream sends one SSE chunk, sleeps
    SLEEP_S, then sends the rest. The test requires the client to have seen
    bytes before that sleep ended. A future edit that accumulates the body and
    writes it once still returns a byte-identical response and would pass every
    content assertion — this is the only check that catches it.
  * "a recorder failure never fails a request".  The test installs a recorder
    whose every write raises, and requires the proxied request to come back 200
    with an intact body.

The assembler tests use the article's own failure surface: a tool call whose
arguments arrive split across deltas, including a split through the MIDDLE of a
multi-byte UTF-8 character, which is routine at 60 t/s and decodes to U+FFFD if
the buffer is kept as str instead of bytes.
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import capture_proxy as cp  # noqa: E402

PASSED = 0
FAILED = 0
SLEEP_S = 0.6


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print(f"  PASS  {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}" + (f"  — {detail}" if detail else ""))


def eq(name: str, got, want) -> None:
    check(name, got == want, f"got {got!r}, want {want!r}")


# ---------------------------------------------------------------------------
# 1. Assembler: pure, no sockets
# ---------------------------------------------------------------------------


def sse(obj) -> bytes:
    return b"data: " + json.dumps(obj).encode() + b"\n\n"


def test_assembler() -> None:
    print("\nStreamAssembler")

    a = cp.StreamAssembler()
    # A tool call whose name and arguments arrive in pieces, the way llama.cpp
    # actually streams one.
    a.feed(sse({"choices": [{"delta": {"reasoning_content": "thinking"}}]}))
    a.feed(sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "conf"}}]}}]}))
    a.feed(sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"iface":"Gigabit'}}]}}]}))
    a.feed(sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'Ethernet0/0/1.201","port":5432}'}}]}}]}))
    a.feed(sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 11, "completion_tokens": 7}}))
    a.feed(b"data: [DONE]\n\n")
    r = a.result()
    eq("tool call name", r["tool_calls"][0]["name"], "conf")
    eq("arguments rejoined exactly", r["tool_calls"][0]["arguments"], '{"iface":"GigabitEthernet0/0/1.201","port":5432}')
    eq("finish_reason", r["finish_reason"], "tool_calls")
    eq("usage carried", r["usage"]["prompt_tokens"], 11)
    eq("reasoning kept separate from content", (r["reasoning_content"], r["content"]), ("thinking", ""))
    check("saw [DONE]", r["saw_done"])
    eq("no parse errors", r["stream_parse_errors"], 0)

    # A frame split at an arbitrary byte boundary, mid-multibyte-character.
    a = cp.StreamAssembler()
    frame = sse({"choices": [{"delta": {"content": "café — ünïcode"}}]})
    cut = frame.index(b"caf") + 4  # lands inside the two-byte é
    a.feed(frame[:cut])
    a.feed(frame[cut:])
    eq("multi-byte char split across chunks", a.result()["content"], "café — ünïcode")

    # The counts llama.cpp puts in `timings` when the client did not ask for
    # usage. The numbers here are a real matched pair off this stack.
    a = cp.StreamAssembler()
    a.feed(sse({"choices": [{"delta": {"content": "x"}}]}))
    a.feed(sse({"choices": [{"delta": {}, "finish_reason": "stop"}],
                "timings": {"prompt_n": 126, "cache_n": 383, "predicted_n": 226, "draft_n": 122, "draft_n_accepted": 112}}))
    r = a.result()
    eq("usage derived: prompt_n + cache_n", r["usage"]["prompt_tokens"], 509)
    eq("usage derived: predicted_n", r["usage"]["completion_tokens"], 226)
    eq("cached tokens carried", r["usage"]["prompt_tokens_details"]["cached_tokens"], 383)
    eq("derivation is declared, not disguised", r["usage"]["derived_from"], "timings")
    eq("draft acceptance recorded per request", r["spec"]["acceptance"], 0.9180)

    # A real `usage` always wins over the derived one.
    a = cp.StreamAssembler()
    a.feed(sse({"choices": [{"delta": {}}], "usage": {"prompt_tokens": 1}, "timings": {"prompt_n": 999, "predicted_n": 9}}))
    r = a.result()
    eq("server-reported usage is not overwritten", r["usage"]["prompt_tokens"], 1)
    check("...and is not marked derived", "derived_from" not in r["usage"])

    # llama.cpp's native /completion shape.
    a = cp.StreamAssembler()
    a.feed(b'data: {"content":"he","stop":false}\n\n')
    a.feed(b'data: {"content":"llo","stop":true,"stop_type":"eos"}\n\n')
    r = a.result()
    eq("native /completion content", r["content"], "hello")
    eq("native /completion stop", r["finish_reason"], "eos")

    # Garbage must be counted, not raised, and must not eat the good frames.
    a = cp.StreamAssembler()
    a.feed(b"data: {not json}\n\n")
    a.feed(sse({"choices": [{"delta": {"content": "ok"}}]}))
    r = a.result()
    eq("bad frame counted", r["stream_parse_errors"], 1)
    eq("good frame after a bad one still lands", r["content"], "ok")


def test_request_summary() -> None:
    print("\nsummarise_request")
    body = json.dumps(
        {
            "model": "m",
            "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}],
            "tools": [{"type": "function", "function": {"name": "bash", "parameters": {}}}],
            "temperature": 0.7,
            "stream": True,
            "cache_prompt": True,
        }
    ).encode()
    s = cp.summarise_request(body)
    eq("messages kept in full", s["request"]["messages"][1]["content"], "U")
    eq("sampling extracted", s["request"]["sampling"]["temperature"], 0.7)
    eq("unknown keys preserved under other", s["request"]["other"]["cache_prompt"], True)
    eq("per-message digests", len(s["digest"]["messages"]), 2)
    eq("tool names recorded", s["digest"]["tool_names"], ["bash"])

    # The digest must be stable against key order — session chaining depends on
    # it, and JSON key order is not guaranteed across hops.
    a = cp.summarise_request(json.dumps({"messages": [{"role": "user", "content": "x"}]}).encode())
    b = cp.summarise_request(json.dumps({"messages": [{"content": "x", "role": "user"}]}).encode())
    eq("digest is key-order stable", a["digest"]["messages"], b["digest"]["messages"])

    s = cp.summarise_request(b"not json at all")
    check("unparseable body does not raise", s.get("parse_error") is True)


# ---------------------------------------------------------------------------
# 2. Live sockets: a fake upstream and the real proxy
# ---------------------------------------------------------------------------

WHOLE_BODY = json.dumps(
    {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "r",
                    "tool_calls": [{"id": "call_9", "function": {"name": "bash", "arguments": '{"cmd":"ls -la"}'}}],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 42, "completion_tokens": 3},
    }
).encode()


class FakeUpstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):
        pass

    def do_GET(self):
        body = b'{"status":"ok"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(n) or b"{}")
        self.server.last_request = req
        self.server.last_headers = dict(self.headers)
        if not req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(WHOLE_BODY)))
            self.end_headers()
            self.wfile.write(WHOLE_BODY)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()  # HTTP/1.1 + no length: the proxy must stream it
        first = sse({"choices": [{"delta": {"content": "first"}}]})
        self.wfile.write(first)
        self.wfile.flush()
        self.server.t_first_sent = time.time()
        time.sleep(SLEEP_S)  # the gap the no-buffering control measures
        self.wfile.write(sse({"choices": [{"delta": {"content": "-rest"}}, ]}))
        self.wfile.write(sse({"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 7}}))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


class Args:
    upstream = ""
    upstream_timeout = 30.0
    record_paths = ",".join(cp.DEFAULT_RECORD_PATHS)
    verbose = False


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Harness:
    """A fake upstream and a real capture proxy in front of it, on real sockets."""

    def __init__(self, tmpdir: str):
        self.up_port = free_port()
        self.up = ThreadingHTTPServer(("127.0.0.1", self.up_port), FakeUpstream)
        self.up.daemon_threads = True
        self.up.last_request = None
        self.up.t_first_sent = None
        threading.Thread(target=self.up.serve_forever, daemon=True).start()

        args = Args()
        args.upstream = f"http://127.0.0.1:{self.up_port}"
        cfg = cp.Config(args)
        self.tape_dir = tmpdir
        self.recorder = cp.Recorder(tmpdir, "testcap", "self-test", args.upstream, 8 * 1024**3)
        self.port = free_port()
        self.srv = cp.CaptureServer(("127.0.0.1", self.port), cp.Handler, cfg=cfg, recorder=self.recorder)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.srv.shutdown()
        self.up.shutdown()
        self.recorder.close()

    def wait_for(self, n: int, kind="completion", timeout: float = 3.0):
        """The tape line is written AFTER the response is flushed, so a client
        that has its body can still be ahead of the recorder. Poll rather than
        assume; a real ordering bug still fails, it just takes `timeout`."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            recs = self.records(kind)
            if len(recs) >= n:
                return recs
            time.sleep(0.02)
        return self.records(kind)

    def records(self, kind="completion"):
        out = []
        for name in sorted(os.listdir(self.tape_dir)):
            if not name.endswith(".jsonl"):
                continue
            with open(os.path.join(self.tape_dir, name), encoding="utf-8") as fh:
                for line in fh:
                    if line.strip():
                        rec = json.loads(line)
                        if kind is None or rec.get("kind") == kind:
                            out.append(rec)
        return out


def post(base: str, path: str, payload: dict, timeout: float = 30.0):
    req = urllib.request.Request(
        base + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def test_live(tmpdir: str) -> None:
    print("\nlive socket: non-streaming")
    h = Harness(tmpdir)
    try:
        status, body = post(h.base, "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "hi"}], "stream": False})
        eq("status forwarded", status, 200)
        eq("body byte-identical", body, WHOLE_BODY)
        eq("upstream saw the request", h.up.last_request["messages"][0]["content"], "hi")
        eq("accept-encoding forced to identity", h.up.last_headers.get("Accept-Encoding"), "identity")
        recs = h.wait_for(1)
        eq("one tape line", len(recs), 1)
        r = recs[0]
        eq("tool call recorded", r["response"]["tool_calls"][0]["arguments"], '{"cmd":"ls -la"}')
        eq("usage recorded", r["response"]["usage"]["prompt_tokens"], 42)
        eq("reasoning recorded", r["response"]["reasoning_content"], "r")
        eq("position recorded", r["position"], "self-test")
        check("timings recorded", isinstance(r["ms_total"], float) and r["ms_total"] >= 0)

        print("\nlive socket: streaming, and the no-buffering control")
        t0 = time.time()
        req = urllib.request.Request(
            h.base + "/v1/chat/completions",
            data=json.dumps({"model": "m", "messages": [{"role": "user", "content": "hi"}], "stream": True}).encode(),
            headers={"Content-Type": "application/json"},
        )
        chunks = []
        with urllib.request.urlopen(req, timeout=30) as resp:
            first = resp.read1(4096) if hasattr(resp, "read1") else resp.read(64)
            t_first_recv = time.time()
            chunks.append(first)
            while True:
                c = resp.read1(4096) if hasattr(resp, "read1") else resp.read(4096)
                if not c:
                    break
                chunks.append(c)
        whole = b"".join(chunks)
        gap = t_first_recv - t0
        check(
            "client saw bytes BEFORE the upstream's mid-stream sleep ended",
            gap < SLEEP_S * 0.75,
            f"first byte at {gap:.2f}s, upstream slept {SLEEP_S}s — this is the buffering control",
        )
        check("stream body carries every frame", b"first" in whole and b"-rest" in whole and b"[DONE]" in whole)
        recs = h.wait_for(2)
        eq("second tape line", len(recs), 2)
        s = recs[1]
        eq("stream flagged", s["stream"], True)
        eq("stream reassembled", s["response"]["content"], "first-rest")
        eq("stream finish_reason", s["response"]["finish_reason"], "stop")
        eq("stream usage", s["response"]["usage"]["prompt_tokens"], 7)
        check("time-to-first-byte recorded", s["ms_to_first_byte"] is not None and s["ms_to_first_byte"] < SLEEP_S * 1000)

        print("\nlive socket: what must NOT be recorded")
        with urllib.request.urlopen(h.base + "/health", timeout=10) as r:
            eq("health forwarded", r.read(), b'{"status":"ok"}')
        time.sleep(0.1)
        eq("health not written to the tape", len(h.records()), 2)
        check("health still counted", h.srv.traffic.get("GET /health") == 1, str(dict(h.srv.traffic)))

        print("\nlive socket: /capture/health is answered locally")
        with urllib.request.urlopen(h.base + "/capture/health", timeout=10) as r:
            payload = json.loads(r.read())
        eq("capture health ok", payload["ok"], True)
        eq("capture health knows its position", payload["position"], "self-test")
        check("capture health not forwarded", h.srv.traffic.get("GET /capture/health") is None)
    finally:
        h.stop()


def test_recorder_failure_is_not_fatal(tmpdir: str) -> None:
    print("\nlive socket: a recorder that always raises must not break a request")
    h = Harness(tmpdir)

    class ExplodingRecorder(cp.Recorder):
        def write(self, rec):  # noqa: D102
            raise RuntimeError("tape on fire")

    h.srv.recorder = ExplodingRecorder(tmpdir, "boom", "self-test", h.recorder.upstream, 0)
    # One KEEP-ALIVE connection, two requests. If the recorder's exception
    # escapes the handler, the response to request 1 still arrives — it was
    # flushed before the tape write — and only the SECOND request down the same
    # connection shows the damage. Testing with one urlopen per request would
    # pass while forge's httpx pool was having its connections torn down.
    conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=20)
    body_json = json.dumps({"model": "m", "messages": [{"role": "user", "content": "hi"}], "stream": False})
    try:
        for i in (1, 2):
            conn.request("POST", "/v1/chat/completions", body=body_json, headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            payload = resp.read()
            eq(f"request {i} survives a broken recorder", resp.status, 200)
            eq(f"request {i} body intact", payload, WHOLE_BODY)
    except Exception as exc:  # the failure this control exists to catch
        check("keep-alive connection survives a broken recorder", False, repr(exc))
    else:
        check("keep-alive connection survives a broken recorder", True)
    finally:
        conn.close()
        h.stop()


def test_upstream_down(tmpdir: str) -> None:
    print("\nlive socket: upstream unreachable is a 502 with a reason, and a tape line")
    port = free_port()  # nothing is listening here
    args = Args()
    args.upstream = f"http://127.0.0.1:{port}"
    cfg = cp.Config(args)
    rec = cp.Recorder(tmpdir, "down", "self-test", args.upstream, 8 * 1024**3)
    srv = cp.CaptureServer(("127.0.0.1", free_port()), cp.Handler, cfg=cfg, recorder=rec)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        try:
            post(base, "/v1/chat/completions", {"messages": [{"role": "user", "content": "hi"}]})
            check("502 when upstream is down", False, "request unexpectedly succeeded")
        except urllib.error.HTTPError as e:
            eq("502 when upstream is down", e.code, 502)
            check("502 body names the cause", b"upstream unreachable" in e.read())
        errs = [r for r in _read_all(tmpdir) if r.get("kind") == "error"]
        check("failure is on the tape too", len(errs) >= 1)
    finally:
        srv.shutdown()
        rec.close()


def test_max_bytes(tmpdir: str) -> None:
    print("\nRecorder: the byte cap stops RECORDING, loudly, and stays stopped")
    rec = cp.Recorder(tmpdir, "cap", "self-test", "http://x", max_bytes=200)
    for i in range(10):
        rec.write({"v": 1, "kind": "completion", "seq": i, "pad": "x" * 50})
    rec.close()
    lines = _read_all(tmpdir)
    stops = [r for r in lines if r.get("kind") == "recorder_stopped"]
    eq("stop line written exactly once", len(stops), 1)
    check("stop line says proxying continues", "PROXYING CONTINUES" in stops[0]["reason"])
    check("recording actually stopped", len([r for r in lines if r.get("kind") == "completion"]) < 10)


def _read_all(tmpdir: str) -> list:
    out = []
    for name in sorted(os.listdir(tmpdir)):
        if name.endswith(".jsonl"):
            with open(os.path.join(tmpdir, name), encoding="utf-8") as fh:
                out += [json.loads(line) for line in fh if line.strip()]
    return out


def run_self_test() -> int:
    import shutil
    import tempfile

    test_assembler()
    test_request_summary()
    for fn in (test_live, test_recorder_failure_is_not_fatal, test_upstream_down, test_max_bytes):
        tmp = tempfile.mkdtemp(prefix="captest-")
        try:
            fn(tmp)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    total = PASSED + FAILED
    print(f"\n{PASSED}/{total} passed", end="")
    if FAILED:
        print(f", {FAILED} FAILED")
        return 1
    print(" — all good")
    return 0


if __name__ == "__main__":
    raise SystemExit(run_self_test())
