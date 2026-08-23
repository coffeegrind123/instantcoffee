#!/usr/bin/env python3
"""Turn a flat tape into workstreams, and one workstream into a KLD corpus.

    python3 scripts/capture_sessions.py --index                     # what is on the tape
    python3 scripts/capture_sessions.py --show s7f3a91              # one workstream, turn by turn
    python3 scripts/capture_sessions.py --export s7f3a91 --out ctx/corpus.txt
    python3 scripts/capture_sessions.py --import-pi ~/.pi/agent/sessions/<slug>/<file>.jsonl
    python3 scripts/capture_sessions.py --self-test

WHY SESSIONS HAVE TO BE REBUILT AT ALL
--------------------------------------
Nothing on the OpenAI wire carries a session id. What a coding agent actually
does is resend the whole conversation every turn with one more message on the
end, so a workstream is recoverable from content alone: turn N+1's message list
starts with turn N's. `capture_proxy.py` writes a per-message SHA-1 list on
every line for exactly this, and the chaining here is longest-common-prefix
over those lists.

Three things break the strict-prefix assumption, and each is CLASSIFIED rather
than silently dropped, because which one happened changes what the tape means:

    continuation  lcp == len(previous)      the ordinary case, one turn appended
    retry         lcp == len(both)          identical list resent — forge's
                                            --max-retries, or a client retry
    rewrite       0 < lcp < len(previous)   history was edited: a compaction,
                                            forge's _merge_consecutive joining
                                            two same-role messages, or the user
                                            rewinding the session
    new           lcp below the floor       a different workstream

A rewrite is the interesting one. It means the token stream the model saw is
NOT the previous prompt plus a suffix, so any prefix-cache or continuity
reasoning about that turn is wrong. The index prints the count; --show names
the turns.

WHAT --export PRODUCES, AND THE CONTROL ON IT
---------------------------------------------
`llama-perplexity --kl-divergence-base` needs a plain text file that is the
token stream, not a JSON transcript. So the exporter takes the DEEPEST record
of a workstream — the one whose prompt is longest — appends the assistant turn
the model actually produced, and renders the whole thing through the live
server's own `/apply-template`. That is the server's real Jinja template with
the real tool block, not a reimplementation of it here:

    * tools render (verified: the full <tools> schema block lands in the system
      turn), so the corpus carries the surface the article's failures live on
    * historical reasoning_content is preserved by this template, which matters
      because FORGE_REASONING_REPLAY=full puts it back on the wire every turn
    * the trailing generation prompt is measured, not assumed: it is the
      longest common suffix of two renders of deliberately different message
      lists, and it is printed in the sidecar so the strip is auditable

Then the control. The corpus is tokenized by the same server, and the count is
compared against what the SERVER ITSELF reported for that request —
usage.prompt_tokens + usage.completion_tokens. A reconstruction that has
quietly lost the tool block, dropped reasoning, or double-rendered a turn shows
up as a token delta of hundreds. An exporter that silently produced a plausible
but wrong corpus would otherwise poison the entire KLD measurement, which is
the one measurement this corpus exists to feed.

--import-pi, AND WHAT IT CANNOT GIVE YOU
----------------------------------------
pi keeps its own transcripts under ~/.pi/agent/sessions/<cwd-slug>/. They are
real work and there is no reason to waste them, so this reads them into the
same shape. Measured against a real transcript on this box, they contain
messages, tool calls, tool results and per-turn usage — and they do NOT contain
the system prompt or the tool schemas. Every imported record therefore carries

    "source": "pi-transcript", "gaps": ["system_prompt", "tool_schemas"]

and --export REFUSES to build a KLD corpus from one unless --allow-gaps is
passed, because a corpus missing the tool block is missing the failure surface
the whole experiment is about.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MIN_LCP = 2          # two shared messages before a REWRITE is called a continuation
MIN_LCP_RATIO = 0.5  # ...and at least half of the previous turn's list

# A full-prefix match (the new list starts with all of the previous one) is the
# ordinary case and is accepted at any length — except when the whole shared
# prefix is nothing but a system message. Two unrelated sessions of the same
# agent share that byte-for-byte, so on its own it is not evidence of anything;
# the self-test has a case that merges them if this guard is removed.


# ---------------------------------------------------------------------------
# tape loading
# ---------------------------------------------------------------------------


def load_tape(paths: list[str]) -> list[dict]:
    files: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            files += sorted(glob.glob(os.path.join(p, "*.jsonl")))
        else:
            files += sorted(glob.glob(p))
    recs = []
    for f in files:
        with open(f, encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    print(f"[sessions] {f}:{n}: unparseable line skipped", file=sys.stderr)
                    continue
                rec["_file"] = f
                recs.append(rec)
    return recs


def completions(recs: list[dict]) -> list[dict]:
    out = [r for r in recs if r.get("kind") == "completion" and (r.get("digest") or {}).get("messages")]
    out.sort(key=lambda r: (r.get("ts_start") or "", r.get("seq") or 0))
    return out


# ---------------------------------------------------------------------------
# session reconstruction
# ---------------------------------------------------------------------------


def prefix_is_only_system(rec: dict, n: int) -> bool:
    """Is the shared prefix nothing but system messages? Then it is not evidence."""
    msgs = ((rec.get("request") or {}).get("messages") or [])[:n]
    if not msgs:
        return False
    return all((m or {}).get("role") == "system" for m in msgs)


def lcp(a: list, b: list) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


class Session:
    def __init__(self, first: dict, position: str):
        seed = (first.get("digest") or {}).get("messages") or []
        self.id = "s" + hashlib.sha1(("|".join(seed[:1]) + (first.get("ts_start") or "")).encode()).hexdigest()[:6]
        self.position = position
        self.records: list[dict] = []
        self.joins: list[str] = []
        self.add(first, "new", 0)

    def add(self, rec: dict, join: str, n_lcp: int) -> None:
        rec["_join"] = join
        rec["_lcp"] = n_lcp
        self.records.append(rec)
        self.joins.append(join)

    @property
    def hashes(self) -> list:
        return (self.records[-1].get("digest") or {}).get("messages") or []

    @property
    def start(self) -> str:
        return self.records[0].get("ts_start") or ""

    @property
    def deepest(self) -> dict:
        """The deepest turn, ranked in ONE unit.

        Prompt tokens are the right measure, but a streamed response only
        carries them when the client asked for usage or the tape derived them
        from `timings` — so a session can mix records that have them with
        records that do not. Ranking a 509-token record against an 8-MESSAGE
        record picks whichever unit happens to be larger, which is not a
        comparison at all. So: tokens if every record has them, request bytes
        otherwise. `deepest_basis` says which was used, and --show prints it.
        """
        def tokens(r):
            return ((r.get("response") or {}).get("usage") or {}).get("prompt_tokens")
        if all(tokens(r) is not None for r in self.records):
            self.deepest_basis = "prompt_tokens"
            return max(self.records, key=tokens)
        self.deepest_basis = "request bytes (not every turn reported tokens)"
        return max(self.records, key=lambda r: (r.get("bytes") or {}).get("request") or 0)

    def stats(self) -> dict:
        tool_calls = 0
        tool_names: dict[str, int] = {}
        gen = 0
        prompt_max = 0
        models = set()
        for r in self.records:
            resp = r.get("response") or {}
            for tc in resp.get("tool_calls") or []:
                tool_calls += 1
                tool_names[tc.get("name") or "?"] = tool_names.get(tc.get("name") or "?", 0) + 1
            usage = resp.get("usage") or {}
            gen += usage.get("completion_tokens") or 0
            prompt_max = max(prompt_max, usage.get("prompt_tokens") or 0)
            if (r.get("request") or {}).get("model"):
                models.add(r["request"]["model"])
        digest = self.records[-1].get("digest") or {}
        return {
            "turns": len(self.records),
            "messages_max": max(((r.get("digest") or {}).get("n_messages") or 0) for r in self.records),
            "n_tools": digest.get("n_tools") or 0,
            "tool_calls": tool_calls,
            "tool_names": tool_names,
            "gen_tokens": gen,
            "prompt_max": prompt_max,
            "rewrites": self.joins.count("rewrite"),
            "retries": self.joins.count("retry"),
            "model": ",".join(sorted(models)) or "?",
            "sources": sorted({r.get("source", "proxy") for r in self.records}),
        }


def build_sessions(recs: list[dict]) -> list[Session]:
    """Chain records into workstreams by longest common prefix of message hashes."""
    open_sessions: list[Session] = []
    for rec in recs:
        hashes = (rec.get("digest") or {}).get("messages") or []
        position = rec.get("position") or "unlabelled"
        best: tuple[int, Session] | None = None
        for sess in open_sessions:
            if sess.position != position:
                continue
            n = lcp(sess.hashes, hashes)
            if n == 0 or prefix_is_only_system(rec, n):
                continue
            full_prefix = n == len(sess.hashes)
            if not full_prefix and (n < MIN_LCP or n < MIN_LCP_RATIO * len(sess.hashes)):
                continue
            if best is None or n > best[0]:
                best = (n, sess)
        if best is None:
            open_sessions.append(Session(rec, position))
            continue
        n, sess = best
        prev = len(sess.hashes)
        if n == prev == len(hashes):
            join = "retry"
        elif n == prev:
            join = "continuation"
        else:
            join = "rewrite"
        sess.add(rec, join, n)
    open_sessions.sort(key=lambda s: s.start)
    return open_sessions


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------


def cmd_index(sessions: list[Session]) -> int:
    if not sessions:
        print("no completion records on the tape")
        return 0
    print(f"{'id':>8}  {'start (UTC)':19}  {'turns':>5}  {'msgs':>5}  {'tools':>5}  {'calls':>5}  "
          f"{'prompt_max':>10}  {'gen':>7}  {'rw':>3}  {'rt':>3}  position")
    for s in sessions:
        st = s.stats()
        print(f"{s.id:>8}  {s.start[:19]:19}  {st['turns']:5d}  {st['messages_max']:5d}  {st['n_tools']:5d}  "
              f"{st['tool_calls']:5d}  {st['prompt_max']:10d}  {st['gen_tokens']:7d}  {st['rewrites']:3d}  "
              f"{st['retries']:3d}  {s.position}")
    print("\nrw = history rewrites (compaction / merge / rewind), rt = identical resends (retries)")
    print("pick one with --show <id>, build a KLD corpus with --export <id> --out FILE")
    return 0


def cmd_show(sess: Session) -> int:
    st = sess.stats()
    print(f"session {sess.id}   position={sess.position}   model={st['model']}   source={','.join(st['sources'])}")
    print(f"  {st['turns']} turns, {st['messages_max']} messages at the deepest, {st['n_tools']} tool schemas")
    print(f"  {st['tool_calls']} tool calls: " + ", ".join(f"{k}x{v}" for k, v in sorted(st['tool_names'].items(), key=lambda kv: -kv[1])))
    print(f"  prompt_max={st['prompt_max']} tokens, {st['gen_tokens']} generated, "
          f"{st['rewrites']} rewrites, {st['retries']} retries\n")
    print(f"{'#':>3}  {'join':12} {'lcp':>4}  {'msgs':>4}  {'prompt':>7}  {'gen':>5}  {'ttfb_ms':>7}  finish / calls")
    for i, r in enumerate(sess.records):
        resp = r.get("response") or {}
        usage = resp.get("usage") or {}
        calls = ",".join(tc.get("name") or "?" for tc in resp.get("tool_calls") or []) or (resp.get("finish_reason") or "-")
        print(f"{i:3d}  {r['_join']:12} {r['_lcp']:4d}  {(r.get('digest') or {}).get('n_messages', 0):4d}  "
              f"{usage.get('prompt_tokens', 0):7d}  {usage.get('completion_tokens', 0):5d}  "
              f"{(r.get('ms_to_first_byte') or 0):7.0f}  {calls[:48]}")
    deep = sess.deepest
    print(f"\ndeepest record: seq={deep.get('seq')} ts={deep.get('ts_start')} "
          f"prompt_tokens={((deep.get('response') or {}).get('usage') or {}).get('prompt_tokens')} "
          f"[chosen by {getattr(sess, 'deepest_basis', '?')}]")
    return 0


# ---------------------------------------------------------------------------
# corpus export
# ---------------------------------------------------------------------------


def _post(url: str, path: str, payload: dict, timeout: float = 120.0):
    req = urllib.request.Request(
        url.rstrip("/") + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def render(url: str, messages: list, tools=None) -> str:
    payload = {"messages": messages}
    if tools:
        payload["tools"] = tools
    out = _post(url, "/apply-template", payload)
    if "prompt" not in out:
        raise SystemExit(f"/apply-template returned no prompt: {json.dumps(out)[:400]}")
    return out["prompt"]


SENTINEL_PREFIX = "CAPTURE-CUT-"


def build_corpus(render_fn, messages: list, tools, sentinel: str) -> tuple[str, str]:
    """Render the exchange INCLUDING the assistant turn the model produced.

    The obvious way — render `messages + [final assistant]` — is wrong on this
    template, and wrong SILENTLY. Measured against the live server:

        [user, assistant(content="A1")]
            -> ...<|im_start|>assistant\n<think>\n\n</think>\n\nA1
               (a prefill: no <|im_end|>, no generation prompt)

        [user, assistant(tool_calls=[bash])]
            -> ...<|im_start|>assistant\n<think>\n\n</think>\n\n
               (THE TOOL CALL IS GONE — the template only emits a tool_call
                block for an assistant turn that is not last)

    A corpus built that way would end just before the tool call, which is the
    one thing the KLD run exists to look at, and would look perfectly healthy.

    So the final assistant turn is rendered in HISTORY position: a sentinel user
    message is appended after it, forcing the template down its ordinary
    assistant-turn branch, and everything from the sentinel's own <|im_start|>
    onward is cut. The cut is exact — the template opens every message with that
    token — and it is asserted, not hoped for.

    Returns (corpus, how) where `how` names what was cut, for the sidecar.
    """
    msgs = list(messages) + [{"role": "user", "content": sentinel}]
    full = render_fn(msgs, tools)
    if full.count(sentinel) != 1:
        raise SystemExit(
            f"sentinel {sentinel!r} appears {full.count(sentinel)} times in the render; cannot cut safely"
        )
    at = full.rindex(sentinel)
    start = full.rfind("<|im_start|>", 0, at)
    if start < 0:
        raise SystemExit("the sentinel turn does not open with <|im_start|>; the template changed")
    corpus = full[:start]
    how = f"cut at the sentinel turn's <|im_start|> (offset {start})"
    if corpus.endswith("<|im_end|>\n"):
        # The newline after the end-of-turn token is template scaffolding
        # between messages, not something the model emitted.
        corpus = corpus[:-1]
        how += "; trailing inter-message newline removed"
    return corpus, how


def n_tokens(url: str, text: str) -> int:
    return len(_post(url, "/tokenize", {"content": text})["tokens"])


def final_assistant_message(resp: dict) -> dict:
    msg: dict = {"role": "assistant", "content": resp.get("content") or ""}
    if resp.get("reasoning_content"):
        msg["reasoning_content"] = resp["reasoning_content"]
    calls = []
    for i, tc in enumerate(resp.get("tool_calls") or []):
        calls.append(
            {
                "id": tc.get("id") or f"call_{i}",
                "type": "function",
                "function": {"name": tc.get("name") or "", "arguments": tc.get("arguments") or ""},
            }
        )
    if calls:
        msg["tool_calls"] = calls
    return msg


def cmd_export(sess: Session, url: str, out_path: str, allow_gaps: bool, env: dict) -> int:
    rec = sess.deepest
    gaps = rec.get("gaps") or []
    if gaps and not allow_gaps:
        print(
            f"REFUSING: the deepest record of {sess.id} declares gaps {gaps}.\n"
            "  A corpus without the tool schemas is missing the surface the KLD run exists to measure.\n"
            "  Capture a real tape with capture_proxy.py, or pass --allow-gaps if you know what you are\n"
            "  giving up and will say so in the write-up.",
            file=sys.stderr,
        )
        return 2

    req = rec.get("request") or {}
    messages = list(req.get("messages") or [])
    tools = req.get("tools")
    if not messages:
        print(f"REFUSING: record seq={rec.get('seq')} has no messages", file=sys.stderr)
        return 2

    resp = rec.get("response") or {}
    messages.append(final_assistant_message(resp))

    sentinel = SENTINEL_PREFIX + hashlib.sha1(repr(messages[:1]).encode()).hexdigest()[:10]
    corpus, how = build_corpus(lambda m, t: render(url, m, t), messages, tools, sentinel)

    tokens = n_tokens(url, corpus)
    usage = resp.get("usage") or {}
    expected = (usage.get("prompt_tokens") or 0) + (usage.get("completion_tokens") or 0)
    delta = tokens - expected if expected else None

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(corpus)

    meta = {
        "session": sess.id,
        "position": sess.position,
        "source_record": {"seq": rec.get("seq"), "ts_start": rec.get("ts_start"), "file": rec.get("_file"), "path": rec.get("path")},
        "model": req.get("model"),
        "n_messages": len(messages),
        "n_tools": len(tools or []),
        "tool_names": [((t or {}).get("function") or {}).get("name") for t in (tools or [])],
        "chars": len(corpus),
        "tokens": tokens,
        "server_reported": {"prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"), "sum": expected or None},
        "token_delta": delta,
        "corpus_cut": how,
        "gaps": gaps,
        "stats": sess.stats(),
    }
    if env:
        meta["perplexity_command"] = (
            "docker compose stop llama && docker run --rm --gpus all "
            f"-v {env.get('MODELS_DIR', '<MODELS_DIR>')}:/models -v $(pwd)/{os.path.dirname(out_path) or '.'}:/corpus "
            f"--entrypoint /app/llama ghcr.io/ggml-org/llama.cpp:{env.get('LLAMA_TAG', '<LLAMA_TAG>')} perplexity "
            f"-m /models/{env.get('GGUF_FILE', '<GGUF_FILE>')} -f /corpus/{os.path.basename(out_path)} "
            "-c 65536 -ngl 99 -fa on --kl-divergence-base /corpus/base.logits"
        )
    meta_path = out_path + ".meta.json"
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)

    print(f"wrote {out_path}   {len(corpus)} chars, {tokens} tokens")
    print(f"      {meta_path}")
    print(f"  messages={len(messages)}  tools={len(tools or [])}  model={req.get('model')}")
    print(f"  {how}")
    if expected:
        verdict = "OK" if abs(delta) <= max(16, expected * 0.01) else "SUSPECT"
        print(f"  CONTROL: server reported {expected} tokens for this exchange, the corpus tokenizes "
              f"to {tokens} (delta {delta:+d}) -> {verdict}")
        if verdict == "SUSPECT":
            print("  A delta this large means the reconstruction is NOT the token stream the model saw.\n"
                  "  Do not run a fidelity measurement on it until that is explained.", file=sys.stderr)
            return 1
    else:
        print("  CONTROL SKIPPED: the record carries no usage, so nothing pins the reconstruction. "
              "Treat the corpus as unverified.")
    return 0


# ---------------------------------------------------------------------------
# pi transcript import
# ---------------------------------------------------------------------------


def _pi_assistant_history(content, calls) -> dict:
    """The assistant turn as it goes BACK into the next request's history."""
    msg: dict = {"role": "assistant", "content": _pi_text(content)}
    if calls:
        msg["tool_calls"] = [
            {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
            for c in calls
        ]
    return msg


def _pi_usage(usage) -> dict | None:
    """pi's usage keys are not OpenAI's, and `input` EXCLUDES the cached prefix.

    Measured on a real transcript: input 829 + cacheRead 10839 + output 1159 ==
    totalTokens 12827, exactly. So the OpenAI prompt_tokens this stack's server
    reported is input + cacheRead, not input — reading `input` as prompt_tokens
    understates the depth of a cached turn by an order of magnitude, and depth
    is the whole axis these captures exist to measure. The raw dict is kept
    alongside so nothing is lost to this mapping.
    """
    if not isinstance(usage, dict):
        return None
    inp = usage.get("input") or 0
    cached = usage.get("cacheRead") or 0
    out = {
        "prompt_tokens": inp + cached,
        "completion_tokens": usage.get("output") or 0,
        "total_tokens": usage.get("totalTokens"),
        "prompt_tokens_details": {"cached_tokens": cached},
        "raw": usage,
    }
    return out


def _pi_text(blocks) -> str:
    if isinstance(blocks, str):
        return blocks
    out = []
    for b in blocks or []:
        if isinstance(b, dict) and b.get("type") == "text":
            out.append(b.get("text") or "")
    return "".join(out)


def _pi_calls(blocks) -> list:
    calls = []
    for b in blocks or []:
        if isinstance(b, dict) and b.get("type") == "toolCall":
            args = b.get("arguments")
            calls.append(
                {
                    "id": b.get("id"),
                    "name": b.get("name"),
                    "arguments": args if isinstance(args, str) else json.dumps(args, ensure_ascii=False),
                }
            )
    return calls


def import_pi(path: str) -> list[dict]:
    """Rebuild the final conversation path from a pi transcript.

    pi's log is parent-chained and CAN branch (a rewind writes a new child of an
    older node), so walking the file in order would replay abandoned branches as
    if they had happened. This walks parentId backwards from the last message,
    which is the path that actually ran.
    """
    raw = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    by_id = {r.get("id"): r for r in raw if r.get("id")}
    last = None
    for r in raw:
        if r.get("type") == "message":
            last = r
    if last is None:
        return []
    chain = []
    node = last
    seen = set()
    while node is not None and node.get("id") not in seen:
        seen.add(node.get("id"))
        # custom_message is a REAL user turn on the wire: /loop injects its
        # per-iteration prompt as one, and the first turn of a looped session is
        # nothing else. Dropping them (which the first cut did) leaves the
        # opening request with an empty message list and silently removes the
        # instruction the whole session is executing.
        if node.get("type") in ("message", "custom_message", "compaction"):
            chain.append(node)
        node = by_id.get(node.get("parentId"))
    chain.reverse()

    session_id = next((r.get("id") for r in raw if r.get("type") == "session"), os.path.basename(path))
    messages: list[dict] = []
    records: list[dict] = []
    seq = 0
    compacted = False
    for node in chain:
        if node.get("type") == "compaction":
            # pi replaced everything before firstKeptEntryId with a summary. The
            # message list has to follow or every later record claims a history
            # the model never saw. The exact FRAMING pi puts the summary in is
            # not in the transcript, so this reconstructs it as a user turn and
            # flags every record after it — inferred, not observed.
            messages = [{"role": "user", "content": node.get("summary") or ""}]
            compacted = True
            continue
        if node.get("type") == "custom_message":
            messages.append({"role": "user", "content": node.get("content") or ""})
            continue
        msg = node.get("message") or {}
        role = msg.get("role")
        content = msg.get("content")
        if role == "user":
            messages.append({"role": "user", "content": _pi_text(content)})
        elif role == "toolResult":
            messages.append(
                {"role": "tool", "tool_call_id": msg.get("toolCallId"), "content": _pi_text(content)}
            )
        elif role == "assistant":
            calls = _pi_calls(content)
            resp = {
                "content": _pi_text(content),
                "reasoning_content": "",
                "tool_calls": [dict(c, index=i) for i, c in enumerate(calls)],
                "finish_reason": msg.get("stopReason"),
                "usage": _pi_usage(msg.get("usage")),
            }
            if not messages:
                # An assistant turn with nothing before it is not a request that
                # can have happened; something upstream was not understood. Say
                # so on stderr rather than emitting a record with an empty
                # message list, which indexes as a 0-message turn and looks like
                # data.
                print(f"[sessions] {os.path.basename(path)}: assistant turn with no prior "
                      f"messages at {node.get('timestamp')} — skipped", file=sys.stderr)
                messages.append(_pi_assistant_history(content, calls))
                continue
            seq += 1
            digest_msgs = [hashlib.sha1(json.dumps(m, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() for m in messages]
            records.append(
                {
                    "v": 1,
                    "kind": "completion",
                    "source": "pi-transcript",
                    "gaps": ["system_prompt", "tool_schemas"] + (["compaction_reconstructed"] if compacted else []),
                    "capture_id": str(session_id)[:12],
                    "seq": seq,
                    "position": "pi-transcript",
                    "path": "/v1/chat/completions",
                    "ts_start": node.get("timestamp"),
                    "status": 200,
                    "stream": None,
                    "request": {"model": msg.get("model"), "messages": list(messages), "tools": None, "sampling": {}},
                    "digest": {"messages": digest_msgs, "n_messages": len(messages)},
                    "response": resp,
                }
            )
            messages.append(_pi_assistant_history(content, calls))
    return records


def cmd_import_pi(paths: list[str], out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    total = 0
    for path in paths:
        recs = import_pi(path)
        if not recs:
            print(f"  {path}: no messages", file=sys.stderr)
            continue
        name = "imported-pi-" + os.path.basename(path).replace(".jsonl", "") + ".jsonl"
        dest = os.path.join(out_dir, name)
        with open(dest, "w", encoding="utf-8") as fh:
            for r in recs:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        total += len(recs)
        print(f"  {os.path.basename(path)} -> {dest}  ({len(recs)} turns)")
    print(f"{total} turns imported. NOTE: no system prompt and no tool schemas — see --help.")
    return 0


# ---------------------------------------------------------------------------
# self-test
# ---------------------------------------------------------------------------


def self_test() -> int:
    passed = failed = 0

    def check(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  PASS  {name}")
        else:
            failed += 1
            print(f"  FAIL  {name}" + (f"  — {detail}" if detail else ""))

    def rec(seq, hashes, ts, position="p", usage=None, calls=()):
        return {
            "kind": "completion",
            "seq": seq,
            "ts_start": ts,
            "position": position,
            "digest": {"messages": list(hashes), "n_messages": len(hashes)},
            "request": {"model": "m", "messages": [{"role": "user", "content": h} for h in hashes]},
            "response": {"usage": usage or {}, "tool_calls": [{"name": c} for c in calls]},
        }

    print("\nsession chaining")
    tape = [
        rec(1, ["a", "b"], "T1"),
        rec(2, ["a", "b", "c", "d"], "T2"),           # continuation
        rec(3, ["a", "b", "c", "d"], "T3"),           # retry: identical
        rec(4, ["a", "b", "X", "Y", "Z"], "T4"),      # rewrite: history edited
        rec(5, ["q", "r", "s"], "T5"),                # a different workstream
    ]
    sessions = build_sessions(completions(tape))
    check("two workstreams found", len(sessions) == 2, f"got {len(sessions)}")
    joins = sessions[0].joins
    check("joins classified", joins == ["new", "continuation", "retry", "rewrite"], str(joins))
    check("unrelated record starts its own session", sessions[1].joins == ["new"])

    print("\nsession chaining: a rewrite that drops below the floor is NOT chained")
    tape2 = [rec(1, ["a", "b", "c", "d", "e", "f"], "T1"), rec(2, ["a", "z"], "T2")]
    s2 = build_sessions(completions(tape2))
    check("compaction-shaped truncation starts a new session", len(s2) == 2, f"got {len(s2)}")

    print("\nsession chaining: a shared system prompt alone is not evidence")

    def sysrec(seq, hashes, ts, roles):
        r = rec(seq, hashes, ts)
        r["request"]["messages"] = [{"role": role, "content": h} for role, h in zip(roles, hashes)]
        return r

    # Two workstreams of the SAME agent: byte-identical system prompt, different
    # first user turn. The floor is what separates them — an lcp of 1 that is
    # not a full prefix is not enough.
    tape_sys = [
        sysrec(1, ["sys", "u1"], "T1", ["system", "user"]),
        sysrec(2, ["sys", "u1", "a1", "u2"], "T2", ["system", "user", "assistant", "user"]),
        sysrec(3, ["sys", "OTHER"], "T3", ["system", "user"]),
    ]
    ss = build_sessions(completions(tape_sys))
    check("identical system prompt does not merge two workstreams", len(ss) == 2, f"got {len(ss)}")
    check("...and the real continuation still chained", ss[0].joins == ["new", "continuation"], str(ss[0].joins))
    # And the degenerate case the guard exists for: a system-only request, whose
    # whole shared prefix carries no evidence at all.
    tape_sysonly = [sysrec(1, ["sys"], "T1", ["system"]), sysrec(2, ["sys", "u2"], "T2", ["system", "user"])]
    check("a system-only prefix does not chain", len(build_sessions(completions(tape_sysonly))) == 2)

    print("\nsession chaining: positions never mix")
    tape3 = [rec(1, ["a", "b"], "T1", position="forge-llama"), rec(2, ["a", "b", "c"], "T2", position="client-forge")]
    check("a client tape and a model tape stay separate", len(build_sessions(completions(tape3))) == 2)

    print("\ndeepest record is chosen by prompt tokens, not by arrival order")
    tape4 = [
        rec(1, ["a", "b"], "T1", usage={"prompt_tokens": 9000}),
        rec(2, ["a", "b", "c"], "T2", usage={"prompt_tokens": 120}),
    ]
    s4 = build_sessions(completions(tape4))[0]
    check("deepest by tokens", s4.deepest["seq"] == 1, f"got seq={s4.deepest['seq']}")

    print("\nstats")
    tape5 = [rec(1, ["a", "b"], "T1", usage={"prompt_tokens": 100, "completion_tokens": 7}, calls=("bash",)),
             rec(2, ["a", "b", "c"], "T2", usage={"prompt_tokens": 300, "completion_tokens": 5}, calls=("bash", "read"))]
    st = build_sessions(completions(tape5))[0].stats()
    check("tool calls counted", st["tool_calls"] == 3, str(st["tool_calls"]))
    check("generated tokens summed", st["gen_tokens"] == 12, str(st["gen_tokens"]))
    check("deepest prompt reported", st["prompt_max"] == 300, str(st["prompt_max"]))

    print("\npi transcript import")
    import tempfile
    trans = [
        {"type": "session", "id": "S1", "timestamp": "T0"},
        {"type": "message", "id": "m1", "parentId": None, "timestamp": "T1",
         "message": {"role": "user", "content": [{"type": "text", "text": "do it"}]}},
        {"type": "message", "id": "m2", "parentId": "m1", "timestamp": "T2",
         "message": {"role": "assistant", "usage": {"prompt_tokens": 10, "completion_tokens": 3}, "stopReason": "toolCall",
                     "content": [{"type": "text", "text": "sure"},
                                 {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"cmd": "ls"}}]}},
        {"type": "message", "id": "m3", "parentId": "m2", "timestamp": "T3",
         "message": {"role": "toolResult", "toolCallId": "c1", "content": [{"type": "text", "text": "DEAD-BRANCH"}]}},
        {"type": "message", "id": "m4", "parentId": "m3", "timestamp": "T4",
         "message": {"role": "assistant", "usage": {"prompt_tokens": 20, "completion_tokens": 2},
                     "content": [{"type": "text", "text": "NEVER-RAN"}]}},
        # The rewind. pi writes the replacement branch AFTER the branch it
        # abandons, so the path that actually ran is the one ending at the
        # LAST-WRITTEN node — not the longest chain, which here is the dead one.
        {"type": "message", "id": "m5", "parentId": "m2", "timestamp": "T5",
         "message": {"role": "toolResult", "toolCallId": "c1", "content": [{"type": "text", "text": "a.txt"}]}},
        {"type": "message", "id": "m6", "parentId": "m5", "timestamp": "T6",
         "message": {"role": "assistant", "usage": {"prompt_tokens": 20, "completion_tokens": 2},
                     "content": [{"type": "text", "text": "done"}]}},
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        for r in trans:
            fh.write(json.dumps(r) + "\n")
        tmp = fh.name
    try:
        recs = import_pi(tmp)
        check("one record per assistant turn", len(recs) == 2, f"got {len(recs)}")
        check("gaps declared on every record", all(r["gaps"] == ["system_prompt", "tool_schemas"] for r in recs))
        check("tool call carried across", recs[0]["response"]["tool_calls"][0]["name"] == "bash")
        check("arguments serialised as a string", recs[0]["response"]["tool_calls"][0]["arguments"] == '{"cmd": "ls"}')
        last_msgs = recs[1]["request"]["messages"]
        check("tool result became role=tool", last_msgs[2]["role"] == "tool" and last_msgs[2]["content"] == "a.txt")
        check("assistant tool_calls rebuilt into history", last_msgs[1].get("tool_calls")[0]["function"]["name"] == "bash")
        check("the abandoned branch is NOT in the conversation",
              not any(("NEVER-RAN" in json.dumps(m)) or ("DEAD-BRANCH" in json.dumps(m)) for m in last_msgs),
              json.dumps(last_msgs)[:200])
        s = build_sessions(completions(recs))
        check("imported turns chain into one session", len(s) == 1 and s[0].joins == ["new", "continuation"], str(s[0].joins if s else None))
    finally:
        os.unlink(tmp)

    print("\npi import: the three things real transcripts do that fixtures do not")
    trans2 = [
        {"type": "session", "id": "S2", "timestamp": "T0"},
        # /loop injects the user turn as custom_message, not as a message.
        {"type": "custom_message", "id": "c1", "parentId": None, "timestamp": "T1",
         "customType": "loop", "content": "LOOP-PROMPT"},
        {"type": "custom", "customType": "loop-state", "id": "x1", "parentId": "c1", "timestamp": "T1", "data": {}},
        {"type": "message", "id": "a1", "parentId": "x1", "timestamp": "T2",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "one"}],
                     "usage": {"input": 829, "cacheRead": 10839, "output": 1159, "totalTokens": 12827}}},
        {"type": "compaction", "id": "k1", "parentId": "a1", "timestamp": "T3", "summary": "SUMMARY-TEXT",
         "firstKeptEntryId": "a1", "tokensBefore": 12827},
        {"type": "message", "id": "u2", "parentId": "k1", "timestamp": "T4",
         "message": {"role": "user", "content": [{"type": "text", "text": "after"}]}},
        {"type": "message", "id": "a2", "parentId": "u2", "timestamp": "T5",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "two"}],
                     "usage": {"input": 10, "cacheRead": 20, "output": 5, "totalTokens": 35}}},
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        for r in trans2:
            fh.write(json.dumps(r) + "\n")
        tmp2 = fh.name
    try:
        r2 = import_pi(tmp2)
        check("custom_message became the user turn", r2[0]["request"]["messages"][0]["content"] == "LOOP-PROMPT")
        check("loop-state is traversed but not emitted",
              all("loop-state" not in json.dumps(m) for m in r2[0]["request"]["messages"]))
        u = r2[0]["response"]["usage"]
        check("prompt_tokens = input + cacheRead", u["prompt_tokens"] == 11668, str(u["prompt_tokens"]))
        check("completion_tokens = output", u["completion_tokens"] == 1159, str(u["completion_tokens"]))
        check("the raw pi usage is kept", u["raw"]["cacheRead"] == 10839)
        check("cached tokens surface where a reader expects them",
              u["prompt_tokens_details"]["cached_tokens"] == 10839)
        msgs2 = r2[1]["request"]["messages"]
        check("compaction truncated the history", msgs2[0]["content"] == "SUMMARY-TEXT", json.dumps(msgs2)[:160])
        check("pre-compaction turns are gone", not any("LOOP-PROMPT" in json.dumps(m) for m in msgs2))
        check("the compaction inference is declared", "compaction_reconstructed" in r2[1]["gaps"])
    finally:
        os.unlink(tmp2)

    print("\ncorpus construction: the sentinel cut")

    def fake_render(msgs, tools):
        """A stand-in for the real template, with the behaviour that matters:
        an assistant turn renders its tool call ONLY when it is not last."""
        out = []
        for i, m in enumerate(msgs):
            body = m.get("content") or ""
            if m.get("role") == "assistant" and m.get("tool_calls"):
                if i == len(msgs) - 1:
                    body = ""  # the trap: the real template drops it here
                else:
                    body = body + "<tool_call>" + m["tool_calls"][0]["function"]["name"] + "</tool_call>"
            if i == len(msgs) - 1 and m.get("role") == "assistant":
                out.append(f"<|im_start|>{m['role']}\n{body}")  # prefill, no end tag
            else:
                out.append(f"<|im_start|>{m['role']}\n{body}<|im_end|>\n")
        return "".join(out)

    convo = [{"role": "user", "content": "go"},
             {"role": "assistant", "content": "sure",
              "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "net_configure", "arguments": "{}"}}]}]
    corpus, how = build_corpus(fake_render, convo, None, "SENT-1")
    check("the final tool call survives the cut", "net_configure" in corpus, corpus)
    check("the sentinel turn is gone", "SENT-1" not in corpus, corpus)
    check("the corpus ends at the model's end-of-turn", corpus.endswith("<|im_end|>"), repr(corpus[-30:]))
    check("what was cut is reported", "im_start" in how and "offset" in how, how)
    # And the naive route, which this exists to avoid: it loses the call silently.
    naive = fake_render(convo, None)
    check("CONTROL: the naive render really does lose it", "net_configure" not in naive.split("<|im_start|>assistant")[-1])

    try:
        build_corpus(lambda m, t: "no sentinel here", convo, None, "SENT-1")
        check("a render without the sentinel is refused", False, "no exception raised")
    except SystemExit:
        check("a render without the sentinel is refused", True)

    print("\nfinal assistant message reconstruction")
    msg = final_assistant_message({"content": "", "reasoning_content": "why", "tool_calls": [{"id": "c1", "name": "bash", "arguments": '{"cmd":"ls"}'}]})
    check("reasoning preserved", msg["reasoning_content"] == "why")
    check("tool call shaped for the template", msg["tool_calls"][0]["function"]["arguments"] == '{"cmd":"ls"}')

    total = passed + failed
    print(f"\n{passed}/{total} passed", end="")
    if failed:
        print(f", {failed} FAILED")
        return 1
    print(" — all good")
    return 0


# ---------------------------------------------------------------------------


def read_env(path: str = ".env") -> dict:
    env = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tape", nargs="*", default=[os.environ.get("CAPTURE_DIR", "captures")],
                   help="tape files or directories (default: $CAPTURE_DIR or ./captures)")
    p.add_argument("--index", action="store_true")
    p.add_argument("--show", metavar="ID")
    p.add_argument("--export", metavar="ID")
    p.add_argument("--out", metavar="FILE")
    p.add_argument("--allow-gaps", action="store_true", help="export from a source that has no tool schemas anyway")
    p.add_argument("--llama-url", default=os.environ.get("LLAMA_URL", "http://llama:8080"))
    p.add_argument("--import-pi", nargs="*", metavar="FILE")
    p.add_argument("--import-out", default=None, help="where imported tapes are written (default: first --tape dir)")
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args(argv)

    if args.self_test:
        return self_test()

    if args.import_pi is not None:
        out_dir = args.import_out or (args.tape[0] if args.tape else "captures")
        paths = args.import_pi or []
        if not paths:
            print("--import-pi needs at least one transcript path", file=sys.stderr)
            return 2
        expanded: list[str] = []
        for pth in paths:
            expanded += sorted(glob.glob(os.path.expanduser(pth))) or [os.path.expanduser(pth)]
        return cmd_import_pi(expanded, out_dir)

    recs = completions(load_tape(args.tape))
    sessions = build_sessions(recs)

    if args.show or args.export:
        wanted = args.show or args.export
        match = [s for s in sessions if s.id == wanted or s.id.endswith(wanted)]
        if not match:
            print(f"no session {wanted!r}; run --index", file=sys.stderr)
            return 2
        sess = match[0]
        if args.show:
            return cmd_show(sess)
        if not args.out:
            print("--export needs --out FILE", file=sys.stderr)
            return 2
        return cmd_export(sess, args.llama_url, args.out, args.allow_gaps, read_env())

    return cmd_index(sessions)


if __name__ == "__main__":
    raise SystemExit(main())
