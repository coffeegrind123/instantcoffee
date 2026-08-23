#!/usr/bin/env python3
"""Record what the model ACTUALLY saw. A transparent, recording reverse proxy.

    # model-facing tape: forge -> capture -> llama   (what the fidelity work needs)
    docker compose --profile capture up -d capture
    #   then point forge at it:  FORGE_BACKEND_URL=http://capture:8082

    # client-facing tape: pi -> capture -> forge     (additive, nothing restarts)
    python3 scripts/capture_proxy.py --upstream http://127.0.0.1:8081 \
        --listen-port 8082 --position client-forge --out-dir ./captures

    python3 scripts/capture_proxy.py --self-test     # 8 checks, no server needed

WHY THIS EXISTS
---------------
`context/design/inference-divergence-and-this-stack.md` ends with four things
worth doing and says of the second one that everything else is gated on it:

    2. Start keeping real workstream captures. Every experiment above is gated
       on having one [...] Nothing else here can be done well without it.

The q8_0-vs-f16 KLD run needs a corpus, and a synthetic filler file will
understate the answer, because the article's own strongest secondary finding is
that top-1 disagreement is prompt-dependent and clusters on content. The corpus
has to be a real workstream with real tool calls in it.

WHAT WAS ALREADY THERE, AND WHY IT IS NOT ENOUGH
------------------------------------------------
pi *does* keep client-side transcripts, in
`~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl` — 342 message records and
178 tool results in one real session on this box. The handoff's "nothing
captures real workstreams yet" is too strong and `capture_sessions.py
--import-pi` reads them. But measured against a transcript from this machine,
they carry:

    role=assistant, role=toolResult, usage, stopReason, a compaction marker
    NO system prompt        (checked: no role=system record anywhere)
    NO tool schemas         (checked: no JSON-Schema `properties` anywhere)

Those two absences are most of the prompt and they are exactly the surface the
divergence article's failures live on — a tool-call envelope and its arguments.
A corpus rebuilt from a transcript is a reconstruction of the conversation, not
of the token stream. This proxy records the token stream.

WHERE TO PUT IT, AND WHAT EACH POSITION MEANS
---------------------------------------------
    pi -> capture -> forge -> llama     --position client-forge
        The agent's intent. Additive: nothing in the running stack restarts,
        only the client's base URL changes. Does NOT show forge's rewrites.

    pi -> forge -> capture -> llama     --position forge-llama
        What the model actually saw: post-guardrail, post-reasoning-replay,
        post-_merge_consecutive, with pi's system prompt and tool schemas on
        the wire. This is the tape the fidelity experiments need. Costs one
        forge restart to insert (seconds — the KV cache lives in llama, which
        does not move).

The position is recorded in every line, because a tape is not interpretable
without it.

RULES THIS THING OBEYS
----------------------
* **A recording failure never fails a request.** Every write is wrapped; a
  failure increments a counter, prints once to stderr, and emits a
  `recorder_error` line if it still can. The self-test injects a recorder that
  raises on every call and requires the proxied request to succeed anyway.
* **No buffering of a stream.** SSE is forwarded chunk-by-chunk with
  `read1()` and an explicit flush, and re-framed as chunked transfer to the
  client. The self-test's fake upstream sends one chunk, sleeps, then sends the
  rest, and requires the client to have seen bytes before the sleep ended — a
  control that FAILS if a future edit ever buffers the body.
* **Only completion-shaped paths are recorded.** Health checks and /props are
  forwarded and counted, never written. `/health` alone is 5,760 lines a day at
  the compose interval.
* **Credentials are never written.** Authorization / X-Api-Key / Cookie are
  forwarded but not recorded, and no header is recorded except user-agent.
* **The tape is capped.** Request bodies carry the whole conversation, so a
  session's bytes grow quadratically in its turns: a 200-turn session at 90k
  tokens is ~80 MB. --max-bytes stops RECORDING (never proxying) and says so
  loudly in the tape and on stderr, rather than filling a disk quietly.

WHAT A LINE LOOKS LIKE
----------------------
One JSON object per completion request, `kind:"completion"`, carrying the full
request (messages, tools, sampling), the assembled response (content,
reasoning_content, tool_calls, finish_reason, usage), wall-clock timings
including time-to-first-byte, and a `digest.messages` list of per-message
hashes. That hash list is what `capture_sessions.py` chains on to rebuild a
workstream out of a flat tape, because nothing on the OpenAI wire carries a
session id.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import http.client
import json
import os
import signal
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

RECORD_VERSION = 1

# Paths whose bodies are worth a tape line. Everything else is forwarded and
# counted only. /v1/messages is forge's inbound Anthropic-shaped route, which
# matters when this sits in the client-forge position.
DEFAULT_RECORD_PATHS = (
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/completions",
    "/completions",
    "/completion",
    "/infill",
    "/v1/messages",
)

# RFC 9110 hop-by-hop headers: they describe THIS connection and must not be
# relayed onto the next one.
HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)

# Recorded from the request for attribution. Deliberately excludes every
# credential-bearing header; those are forwarded and forgotten.
HEADERS_RECORDED = ("user-agent", "content-type", "x-forge-session")

SAMPLING_KEYS = (
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "typical_p",
    "repeat_penalty",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "max_tokens",
    "max_completion_tokens",
    "n_predict",
    "reasoning_effort",
    "stream",
    "logprobs",
    "top_logprobs",
    "n_probs",
)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


def canonical(obj) -> str:
    """Stable JSON for hashing. sort_keys so key order cannot change a digest."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------------------
# The tape
# ---------------------------------------------------------------------------


class Recorder:
    """Append-only JSONL, rotated by UTC day, capped in bytes, never fatal.

    `write` swallows everything. The one thing worse than losing a tape line is
    losing the request that produced it: this proxy sits in the production path
    and a recorder bug must not be able to take the stack down.
    """

    def __init__(self, out_dir: str, capture_id: str, position: str, upstream: str, max_bytes: int):
        self.out_dir = out_dir
        self.capture_id = capture_id
        self.position = position
        self.upstream = upstream
        self.max_bytes = max_bytes
        self.counts: collections.Counter = collections.Counter()
        self._lock = threading.Lock()
        self._fh = None
        self._day = None
        self._path = None
        self._stopped = False
        self._warned = False
        os.makedirs(out_dir, exist_ok=True)
        # Existing files count against the cap, so a restart cannot walk past it.
        self._bytes = self._dir_bytes()

    def _dir_bytes(self) -> int:
        total = 0
        try:
            for name in os.listdir(self.out_dir):
                if name.startswith("capture-") and name.endswith(".jsonl"):
                    total += os.path.getsize(os.path.join(self.out_dir, name))
        except OSError:
            pass
        return total

    def _fh_for_now(self):
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if self._fh is None or day != self._day:
            if self._fh is not None:
                try:
                    self._fh.close()
                except OSError:
                    pass
            self._day = day
            self._path = os.path.join(self.out_dir, f"capture-{day}.jsonl")
            self._fh = open(self._path, "a", encoding="utf-8")
        return self._fh

    @property
    def path(self):
        return self._path

    @property
    def bytes_written(self) -> int:
        return self._bytes

    @property
    def stopped(self) -> bool:
        return self._stopped

    def write(self, rec: dict) -> None:
        try:
            line = json.dumps(rec, ensure_ascii=False) + "\n"
        except Exception as exc:  # unserialisable body: say so, keep the shape
            self.counts["record_serialise_error"] += 1
            line = (
                json.dumps(
                    {
                        "v": RECORD_VERSION,
                        "kind": "recorder_error",
                        "ts": utcnow(),
                        "error": f"{type(exc).__name__}: {exc}",
                        "seq": rec.get("seq"),
                    }
                )
                + "\n"
            )
        try:
            with self._lock:
                if self._stopped:
                    return
                fh = self._fh_for_now()
                fh.write(line)
                fh.flush()
                self._bytes += len(line.encode("utf-8", "replace"))
                self.counts["recorded"] += 1
                if self.max_bytes and self._bytes >= self.max_bytes:
                    self._stopped = True
                    stop = {
                        "v": RECORD_VERSION,
                        "kind": "recorder_stopped",
                        "ts": utcnow(),
                        "reason": "max_bytes reached; PROXYING CONTINUES, recording does not",
                        "bytes": self._bytes,
                        "max_bytes": self.max_bytes,
                    }
                    fh.write(json.dumps(stop) + "\n")
                    fh.flush()
                    print(
                        f"[capture] RECORDING STOPPED: {self._bytes} bytes >= --max-bytes "
                        f"{self.max_bytes}. Proxying continues.",
                        file=sys.stderr,
                        flush=True,
                    )
        except Exception as exc:
            self.counts["record_write_error"] += 1
            if not self._warned:
                self._warned = True
                print(f"[capture] recorder write failed ({exc!r}); proxying unaffected", file=sys.stderr, flush=True)

    def close(self) -> None:
        try:
            with self._lock:
                if self._fh is not None:
                    self._fh.close()
                    self._fh = None
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Response assembly
# ---------------------------------------------------------------------------


class StreamAssembler:
    """Rebuild one assistant message out of SSE deltas, byte-boundary safe.

    Buffers BYTES and splits on newline, so a multi-byte UTF-8 character split
    across two TCP chunks — which is routine at 60 t/s — is reassembled rather
    than decoded into a replacement character. The self-test has a case for
    exactly that split.

    Understands both shapes this stack can produce: the OpenAI
    `choices[].delta` shape, and llama.cpp's native /completion shape, which
    puts `content` at the top level and signals the end with `stop: true`.
    """

    def __init__(self) -> None:
        self.buf = b""
        self.content: list[str] = []
        self.reasoning: list[str] = []
        self.tool_calls: dict[int, dict] = {}
        self.finish_reason = None
        self.usage = None
        self.timings = None
        self.n_events = 0
        self.parse_errors = 0
        self.saw_done = False

    def feed(self, chunk: bytes) -> None:
        self.buf += chunk
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            self._line(line.strip())

    def finish(self) -> None:
        if self.buf.strip():
            self._line(self.buf.strip())
            self.buf = b""

    def _line(self, line: bytes) -> None:
        if not line or not line.startswith(b"data:"):
            return
        payload = line[len(b"data:") :].strip()
        if payload == b"[DONE]":
            self.saw_done = True
            return
        try:
            obj = json.loads(payload.decode("utf-8"))
        except Exception:
            self.parse_errors += 1
            return
        self.n_events += 1
        self._event(obj)

    def _event(self, obj: dict) -> None:
        if not isinstance(obj, dict):
            self.parse_errors += 1
            return
        if obj.get("usage"):
            self.usage = obj["usage"]
        if obj.get("timings"):
            self.timings = obj["timings"]
        choices = obj.get("choices")
        if isinstance(choices, list) and choices:
            for ch in choices:
                if not isinstance(ch, dict):
                    continue
                delta = ch.get("delta")
                if not isinstance(delta, dict):
                    delta = ch.get("message") if isinstance(ch.get("message"), dict) else {}
                self._delta(delta)
                if ch.get("finish_reason"):
                    self.finish_reason = ch["finish_reason"]
            return
        # llama.cpp native /completion
        if isinstance(obj.get("content"), str):
            if obj["content"]:
                self.content.append(obj["content"])
            if obj.get("stop"):
                self.finish_reason = obj.get("stop_type") or "stop"
        if isinstance(obj.get("reasoning_content"), str) and obj["reasoning_content"]:
            self.reasoning.append(obj["reasoning_content"])

    def _delta(self, delta: dict) -> None:
        if not isinstance(delta, dict):
            return
        if isinstance(delta.get("content"), str) and delta["content"]:
            self.content.append(delta["content"])
        for key in ("reasoning_content", "reasoning"):
            val = delta.get(key)
            if isinstance(val, str) and val:
                self.reasoning.append(val)
        for tc in delta.get("tool_calls") or []:
            if not isinstance(tc, dict):
                continue
            idx = tc.get("index", 0)
            slot = self.tool_calls.setdefault(idx, {"id": None, "name": None, "arguments": []})
            if tc.get("id"):
                slot["id"] = tc["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                slot["name"] = fn["name"]
            if isinstance(fn.get("arguments"), str) and fn["arguments"]:
                slot["arguments"].append(fn["arguments"])

    def result(self) -> dict:
        usage = self.usage or usage_from_timings(self.timings)
        calls = []
        for idx in sorted(self.tool_calls):
            slot = self.tool_calls[idx]
            calls.append(
                {
                    "index": idx,
                    "id": slot["id"],
                    "name": slot["name"],
                    "arguments": "".join(slot["arguments"]),
                }
            )
        return {
            "content": "".join(self.content),
            "reasoning_content": "".join(self.reasoning),
            "tool_calls": calls,
            "finish_reason": self.finish_reason,
            "usage": usage,
            "spec": spec_from_timings(self.timings),
            "timings": self.timings,
            "stream_events": self.n_events,
            "stream_parse_errors": self.parse_errors,
            "saw_done": self.saw_done,
        }


def usage_from_timings(timings) -> dict | None:
    """llama.cpp does not put `usage` in an SSE stream unless the client asks for
    it, but it DOES put `timings` in the final chunk — and the counts are there.

    Verified against a matched pair on this stack rather than assumed: one
    non-streamed request reported usage.prompt_tokens 509 with cached_tokens
    383, and its timings read prompt_n 126, cache_n 383 — so prompt_n is what
    was EVALUATED and the total prompt is prompt_n + cache_n. predicted_n was
    226 against completion_tokens 226.

    Marked `derived_from: timings` so a reader can never mistake this for what
    the server itself put in the usage field.
    """
    if not isinstance(timings, dict):
        return None
    if timings.get("prompt_n") is None and timings.get("predicted_n") is None:
        return None
    prompt_n = timings.get("prompt_n") or 0
    cache_n = timings.get("cache_n") or 0
    predicted = timings.get("predicted_n") or 0
    return {
        "prompt_tokens": prompt_n + cache_n,
        "completion_tokens": predicted,
        "total_tokens": prompt_n + cache_n + predicted,
        "prompt_tokens_details": {"cached_tokens": cache_n},
        "derived_from": "timings",
    }


def spec_from_timings(timings) -> dict | None:
    """Per-request speculative-decoding acceptance, free with every response.

    The only other place this stack can see draft acceptance is llama's own log,
    where it is a line per task with nothing tying it to the request that
    produced it. Here it lands on the same record as the prompt that caused it,
    which is what makes "the file-rewrite shape drafts 21-25 while ordinary work
    drafts 3.7" a measurement rather than an anecdote.
    """
    if not isinstance(timings, dict) or timings.get("draft_n") is None:
        return None
    drafted = timings.get("draft_n") or 0
    accepted = timings.get("draft_n_accepted") or 0
    return {
        "draft_n": drafted,
        "draft_n_accepted": accepted,
        "acceptance": round(accepted / drafted, 4) if drafted else None,
    }


def parse_whole_response(raw: bytes) -> dict:
    """Pull the same shape out of a non-streamed body."""
    out = {
        "content": "",
        "reasoning_content": "",
        "tool_calls": [],
        "finish_reason": None,
        "usage": None,
        "timings": None,
        "stream_events": 0,
        "stream_parse_errors": 0,
        "saw_done": False,
    }
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception:
        out["parse_error"] = True
        return out
    if not isinstance(obj, dict):
        out["parse_error"] = True
        return out
    out["timings"] = obj.get("timings")
    out["usage"] = obj.get("usage") or usage_from_timings(out["timings"])
    out["spec"] = spec_from_timings(out["timings"])
    choices = obj.get("choices")
    if isinstance(choices, list) and choices:
        ch = choices[0] or {}
        msg = ch.get("message") or ch.get("delta") or {}
        if isinstance(msg.get("content"), str):
            out["content"] = msg["content"]
        for key in ("reasoning_content", "reasoning"):
            if isinstance(msg.get(key), str) and msg[key]:
                out["reasoning_content"] = msg[key]
        for i, tc in enumerate(msg.get("tool_calls") or []):
            fn = (tc or {}).get("function") or {}
            args = fn.get("arguments")
            if not isinstance(args, str):
                args = canonical(args) if args is not None else ""
            out["tool_calls"].append(
                {"index": tc.get("index", i), "id": tc.get("id"), "name": fn.get("name"), "arguments": args}
            )
        out["finish_reason"] = ch.get("finish_reason")
        return out
    if isinstance(obj.get("content"), str):  # native /completion
        out["content"] = obj["content"]
        out["finish_reason"] = obj.get("stop_type") or ("stop" if obj.get("stop") else None)
    if isinstance(obj.get("reasoning_content"), str):
        out["reasoning_content"] = obj["reasoning_content"]
    return out


def summarise_request(body: bytes) -> dict:
    """The request as sent, in full, plus the digests sessions are rebuilt from."""
    try:
        obj = json.loads(body.decode("utf-8"))
    except Exception:
        return {"parse_error": True, "bytes": len(body)}
    if not isinstance(obj, dict):
        return {"parse_error": True, "bytes": len(body)}
    messages = obj.get("messages")
    tools = obj.get("tools")
    sampling = {k: obj[k] for k in SAMPLING_KEYS if k in obj}
    known = set(SAMPLING_KEYS) | {"messages", "tools", "model", "prompt", "system"}
    other = {k: v for k, v in obj.items() if k not in known}
    req = {
        "model": obj.get("model"),
        "messages": messages,
        "tools": tools,
        "sampling": sampling,
        "other": other,
        "bytes": len(body),
    }
    if "prompt" in obj:  # native /completion carries a rendered prompt already
        req["prompt"] = obj["prompt"]
    if "system" in obj:
        req["system"] = obj["system"]
    digest = {}
    if isinstance(messages, list):
        digest["messages"] = [sha1(canonical(m)) for m in messages]
        digest["n_messages"] = len(messages)
    if isinstance(tools, list):
        digest["tools"] = sha1(canonical(tools))
        digest["n_tools"] = len(tools)
        digest["tool_names"] = [((t or {}).get("function") or {}).get("name") for t in tools]
    if isinstance(obj.get("prompt"), str):
        digest["prompt"] = sha1(obj["prompt"])
    return {"request": req, "digest": digest}


# ---------------------------------------------------------------------------
# The proxy
# ---------------------------------------------------------------------------


class CaptureServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, *, cfg, recorder):
        self.cfg = cfg
        self.recorder = recorder
        self.seq = 0
        self.seq_lock = threading.Lock()
        self.started = time.time()
        self.traffic: collections.Counter = collections.Counter()
        super().__init__(addr, handler)

    def next_seq(self) -> int:
        with self.seq_lock:
            self.seq += 1
            return self.seq


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "capture-proxy/1"

    # ── plumbing ───────────────────────────────────────────────────────────

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
        if self.server.cfg.verbose:
            sys.stderr.write("[capture] %s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        self._proxy("GET")

    def do_POST(self):
        self._proxy("POST")

    def do_PUT(self):
        self._proxy("PUT")

    def do_PATCH(self):
        self._proxy("PATCH")

    def do_DELETE(self):
        self._proxy("DELETE")

    def do_HEAD(self):
        self._proxy("HEAD")

    def do_OPTIONS(self):
        self._proxy("OPTIONS")

    # ── body reading ───────────────────────────────────────────────────────

    def _read_body(self) -> bytes:
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            return self._read_chunked()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _read_chunked(self) -> bytes:
        out = bytearray()
        while True:
            line = self.rfile.readline().strip()
            if not line:
                break
            try:
                size = int(line.split(b";")[0], 16)
            except ValueError:
                break
            if size == 0:
                self.rfile.readline()  # trailing CRLF
                break
            out += self.rfile.read(size)
            self.rfile.readline()
        return bytes(out)

    # ── local endpoints ────────────────────────────────────────────────────

    def _capture_endpoint(self) -> bool:
        """/capture/* is answered here, never forwarded.

        Same reasoning as forge's /forge/health: a healthcheck that forwards the
        BACKEND's readiness marks this container unhealthy for the whole ~24
        minute cold load of a model that is loading perfectly normally.
        """
        path = self.path.split("?", 1)[0].rstrip("/")
        if path not in ("/capture/health", "/capture/stats"):
            return False
        rec = self.server.recorder
        payload = {
            "ok": True,
            "capture_id": rec.capture_id,
            "position": rec.position,
            "upstream": rec.upstream,
            "uptime_s": round(time.time() - self.server.started, 1),
            "tape": rec.path,
            "bytes_written": rec.bytes_written,
            "max_bytes": rec.max_bytes,
            "recording_stopped": rec.stopped,
            "counts": dict(rec.counts),
            "traffic": dict(self.server.traffic),
        }
        body = json.dumps(payload, indent=2).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return True

    # ── the hop ────────────────────────────────────────────────────────────

    def _proxy(self, method: str) -> None:
        if self._capture_endpoint():
            return

        cfg = self.server.cfg
        rec = self.server.recorder
        path = self.path
        bare = path.split("?", 1)[0]
        record_this = bare in cfg.record_paths
        self.server.traffic[f"{method} {bare}"] += 1

        body = self._read_body()

        headers = {}
        for key, value in self.headers.items():
            if key.lower() in HOP_BY_HOP or key.lower() in ("host", "content-length", "accept-encoding"):
                continue
            headers[key] = value
        headers["Host"] = cfg.up_host_header
        # identity: a gzipped SSE stream is unreadable to the assembler, and no
        # backend in this stack compresses one. Forcing it makes the tape a
        # faithful copy of the bytes instead of a decode that might fail.
        headers["Accept-Encoding"] = "identity"
        if body:
            headers["Content-Length"] = str(len(body))

        t0 = time.time()
        started = utcnow()
        seq = self.server.next_seq() if record_this else None

        try:
            conn = http.client.HTTPConnection(cfg.up_host, cfg.up_port, timeout=cfg.upstream_timeout)
            conn.request(method, path, body=body or None, headers=headers)
            resp = conn.getresponse()
        except Exception as exc:
            self.server.traffic["upstream_error"] += 1
            msg = json.dumps({"error": {"message": f"capture-proxy: upstream unreachable: {exc!r}", "type": "upstream_error"}}).encode()
            try:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            except Exception:
                pass
            if record_this:
                try:
                    rec.write(
                        {
                            "v": RECORD_VERSION,
                            "kind": "error",
                            "capture_id": rec.capture_id,
                            "seq": seq,
                            "position": rec.position,
                            "upstream": rec.upstream,
                            "path": bare,
                            "ts_start": started,
                            "ms_total": round((time.time() - t0) * 1000, 1),
                            "error": f"{type(exc).__name__}: {exc}",
                            **summarise_request(body),
                        }
                    )
                except Exception:
                    rec.counts["record_call_error"] += 1
            return

        ctype = resp.getheader("Content-Type") or ""
        clen = resp.getheader("Content-Length")
        streaming = ("event-stream" in ctype.lower()) or (clen is None and method != "HEAD")

        out_headers = [(k, v) for k, v in resp.getheaders() if k.lower() not in HOP_BY_HOP and k.lower() != "content-length"]

        assembler = StreamAssembler() if streaming else None
        raw = bytearray() if (record_this and not streaming) else None
        resp_bytes = 0
        first_byte_ms = None
        disconnected = False

        try:
            if streaming:
                self.send_response(resp.status)
                for k, v in out_headers:
                    self.send_header(k, v)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    try:
                        chunk = resp.read1(65536)
                    except AttributeError:  # pragma: no cover - very old stdlib
                        chunk = resp.read(65536)
                    if not chunk:
                        break
                    if first_byte_ms is None:
                        first_byte_ms = round((time.time() - t0) * 1000, 1)
                    resp_bytes += len(chunk)
                    if assembler is not None and record_this:
                        try:
                            assembler.feed(chunk)
                        except Exception:
                            rec.counts["assemble_error"] += 1
                    try:
                        self.wfile.write(b"%X\r\n" % len(chunk) + chunk + b"\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        disconnected = True
                        break
                if not disconnected:
                    try:
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        disconnected = True
                if assembler is not None and record_this:
                    assembler.finish()
            else:
                payload = resp.read()
                first_byte_ms = round((time.time() - t0) * 1000, 1)
                resp_bytes = len(payload)
                if raw is not None:
                    raw += payload
                self.send_response(resp.status)
                for k, v in out_headers:
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if method != "HEAD":
                    try:
                        self.wfile.write(payload)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        disconnected = True
        finally:
            try:
                conn.close()
            except Exception:
                pass

        if not record_this:
            return

        if streaming:
            response = assembler.result() if assembler else {}
        else:
            response = parse_whole_response(bytes(raw or b""))

        record = {
            "v": RECORD_VERSION,
            "kind": "completion",
            "capture_id": rec.capture_id,
            "seq": seq,
            "position": rec.position,
            "upstream": rec.upstream,
            "path": bare,
            "method": method,
            "ts_start": started,
            "ms_to_first_byte": first_byte_ms,
            "ms_total": round((time.time() - t0) * 1000, 1),
            "status": resp.status,
            "stream": streaming,
            "client_disconnect": disconnected,
            "client": {
                "ip": self.client_address[0] if self.client_address else None,
                **{k.replace("-", "_"): self.headers.get(k) for k in HEADERS_RECORDED if self.headers.get(k)},
            },
            "bytes": {"request": len(body), "response": resp_bytes},
            "response": response,
        }
        record.update(summarise_request(body))
        # Belt and braces. Recorder.write already swallows everything, but this
        # promise is "a recording failure never fails a request", and an
        # exception escaping HERE would propagate out of the handler and kill
        # the keep-alive connection an httpx pool is holding — a real
        # behavioural change from a tape bug. The self-test proves the point by
        # installing a recorder that raises on every call and then making a
        # SECOND request down the same connection.
        try:
            rec.write(record)
        except Exception as exc:
            rec.counts["record_call_error"] += 1
            print(f"[capture] recorder raised out of write(): {exc!r}; request unaffected", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


class Config:
    def __init__(self, args):
        parts = urlsplit(args.upstream)
        if parts.scheme not in ("http", ""):
            raise SystemExit(f"--upstream must be http:// (got {args.upstream!r}); TLS is not proxied here")
        self.up_host = parts.hostname or "127.0.0.1"
        self.up_port = parts.port or 80
        self.up_host_header = parts.netloc or self.up_host
        self.upstream_timeout = args.upstream_timeout
        self.record_paths = frozenset(p.strip() for p in args.record_paths.split(",") if p.strip())
        self.verbose = args.verbose


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--upstream", default=os.environ.get("CAPTURE_UPSTREAM", "http://llama:8080"))
    p.add_argument("--listen-host", default=os.environ.get("CAPTURE_HOST", "0.0.0.0"))
    p.add_argument("--listen-port", type=int, default=int(os.environ.get("CAPTURE_PORT", "8082")))
    p.add_argument("--out-dir", default=os.environ.get("CAPTURE_DIR", "/captures"))
    p.add_argument(
        "--position",
        default=os.environ.get("CAPTURE_POSITION", "unlabelled"),
        help="what this tape IS: forge-llama (what the model saw) or client-forge (what the agent asked for)",
    )
    p.add_argument("--record-paths", default=os.environ.get("CAPTURE_RECORD_PATHS", ",".join(DEFAULT_RECORD_PATHS)))
    p.add_argument("--max-bytes", type=int, default=int(os.environ.get("CAPTURE_MAX_BYTES", str(8 * 1024**3))))
    p.add_argument("--upstream-timeout", type=float, default=float(os.environ.get("CAPTURE_UPSTREAM_TIMEOUT", "1800")))
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--self-test", action="store_true", help="run the built-in checks and exit")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        from capture_proxy_selftest import run_self_test  # type: ignore

        return run_self_test()

    cfg = Config(args)
    if args.position == "unlabelled":
        print(
            "[capture] WARNING: --position is unlabelled. A tape is not interpretable without "
            "knowing whether it sits before or after forge.",
            file=sys.stderr,
        )
    capture_id = uuid.uuid4().hex[:12]
    recorder = Recorder(args.out_dir, capture_id, args.position, args.upstream, args.max_bytes)
    recorder.write(
        {
            "v": RECORD_VERSION,
            "kind": "session_start",
            "capture_id": capture_id,
            "ts": utcnow(),
            "position": args.position,
            "upstream": args.upstream,
            "listen": f"{args.listen_host}:{args.listen_port}",
            "record_paths": sorted(cfg.record_paths),
            "pid": os.getpid(),
        }
    )
    srv = CaptureServer((args.listen_host, args.listen_port), Handler, cfg=cfg, recorder=recorder)

    def shutdown(signum, _frame):
        recorder.write(
            {
                "v": RECORD_VERSION,
                "kind": "session_end",
                "capture_id": capture_id,
                "ts": utcnow(),
                "signal": signum,
                "counts": dict(recorder.counts),
                "traffic": dict(srv.traffic),
            }
        )
        recorder.close()
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(
        f"[capture] {args.listen_host}:{args.listen_port} -> {args.upstream}  position={args.position}  "
        f"tape={recorder.path}",
        file=sys.stderr,
        flush=True,
    )
    try:
        srv.serve_forever(poll_interval=0.2)
    finally:
        recorder.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
