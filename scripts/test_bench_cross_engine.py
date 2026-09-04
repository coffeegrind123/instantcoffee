"""Tests for bench_cross_engine.

Two of these exist because the bug happened. `--probe` against llama b10689
showed the model streaming its output in `delta.reasoning_content` with
`delta.content` set to `null`, and the first parser read only `content`. The
symptom was "no content token was ever streamed" -- which reads as a dead
ENGINE and was a dead PARSER. `test_reasoning_content_is_counted` and
`test_content_null_is_not_content` pin that shape.
"""

from __future__ import annotations

import json

import pytest

import bench_cross_engine
from bench_cross_engine import (
    FILLER_WORDS,
    Round,
    _extract_content,
    build_prompt,
    report,
)


# --- the parser bug that actually happened ----------------------------------


def test_reasoning_content_is_counted():
    """Verbatim frame shape from llama b10689 under REASONING_EFFORT=medium."""
    frame = json.loads(
        '{"choices":[{"finish_reason":null,"index":0,'
        '"delta":{"reasoning_content":"The"}}],"object":"chat.completion.chunk"}'
    )
    text, source = _extract_content(frame)
    assert text == "The"
    assert source == "reasoning_content"


def test_content_null_is_not_content():
    """The opening frame carries role and a null content. It is not a token."""
    frame = json.loads(
        '{"choices":[{"finish_reason":null,"index":0,'
        '"delta":{"role":"assistant","content":null}}]}'
    )
    assert _extract_content(frame) == (None, None)


def test_plain_content_still_wins():
    frame = {"choices": [{"delta": {"content": "hello"}}]}
    assert _extract_content(frame) == ("hello", "content")


def test_content_preferred_over_reasoning_when_both_present():
    frame = {"choices": [{"delta": {"content": "a", "reasoning_content": "b"}}]}
    text, source = _extract_content(frame)
    assert (text, source) == ("a", "content")


def test_list_shaped_content():
    frame = {"choices": [{"delta": {"content": [{"type": "text", "text": "hi"}]}}]}
    assert _extract_content(frame) == ("hi", "content")


def test_usage_only_frame_yields_no_content():
    """The final frame has an empty `choices` list and carries usage."""
    frame = json.loads(
        '{"choices":[],"usage":{"completion_tokens":16,"prompt_tokens":385,'
        '"total_tokens":401,"prompt_tokens_details":{"cached_tokens":0}}}'
    )
    assert _extract_content(frame) == (None, None)


def test_empty_string_is_not_a_token():
    assert _extract_content({"choices": [{"delta": {"content": ""}}]}) == (None, None)


def test_missing_choices_is_survivable():
    assert _extract_content({}) == (None, None)
    assert _extract_content({"choices": None}) == (None, None)


# --- the prefix-cache guard -------------------------------------------------


def test_cache_hit_withholds_the_prefill_rate():
    """A cached prefill did not happen, so its rate is not a measurement."""
    r = Round(
        arm="llama",
        ok=True,
        ttft_s=0.1,
        decode_s=1.0,
        reported_prompt_tokens=90000,
        reported_completion_tokens=64,
        cached_tokens=89000,
    )
    assert r.cache_contaminated
    assert r.prefill_tok_s is None, "a 900k tok/s figure must never be reported"
    # Decode is unaffected by a prefix hit and is still reported.
    assert r.decode_tok_s == pytest.approx(63.0)


def test_zero_cached_tokens_is_not_contamination():
    r = Round(
        arm="llama",
        ok=True,
        ttft_s=1.0,
        decode_s=1.0,
        reported_prompt_tokens=1000,
        reported_completion_tokens=64,
        cached_tokens=0,
    )
    assert not r.cache_contaminated
    assert r.prefill_tok_s == pytest.approx(1000.0)


def test_absent_cached_tokens_is_not_contamination():
    """An engine that does not report the field must not be treated as cached."""
    r = Round(
        arm="ninfer",
        ok=True,
        ttft_s=1.0,
        decode_s=1.0,
        reported_prompt_tokens=1000,
        reported_completion_tokens=64,
        cached_tokens=None,
    )
    assert not r.cache_contaminated
    assert r.prefill_tok_s == pytest.approx(1000.0)


# --- rates ------------------------------------------------------------------


def test_decode_excludes_the_first_token():
    """decode_s spans first->last token, so it covers n-1 inter-token gaps."""
    r = Round(arm="a", ok=True, decode_s=2.0, reported_completion_tokens=101)
    assert r.decode_tok_s == pytest.approx(50.0)


def test_decode_needs_more_than_one_token():
    r = Round(arm="a", ok=True, decode_s=2.0, reported_completion_tokens=1)
    assert r.decode_tok_s is None


def test_decode_falls_back_to_chunk_count():
    r = Round(arm="a", ok=True, decode_s=1.0, content_chunks=51)
    assert r.decode_tok_s == pytest.approx(50.0)


def test_failed_round_reports_no_rates():
    r = Round(arm="a", ok=False, ttft_s=1.0, reported_prompt_tokens=100)
    assert r.prefill_tok_s is None
    assert r.decode_tok_s is None


# --- prompt construction ----------------------------------------------------


def test_nonce_leads_the_prompt():
    """A trailing nonce leaves the whole body cacheable, defeating the point."""
    p = build_prompt(256)
    assert p.startswith("[run ")
    head = p[:32]
    assert FILLER_WORDS[:16] not in head


def test_prompts_differ_every_call():
    prompts = {build_prompt(128)[:40] for _ in range(20)}
    assert len(prompts) == 20


def test_prompt_scales_with_target():
    assert len(build_prompt(4096)) > 8 * len(build_prompt(256))


# --- the report -------------------------------------------------------------


def test_report_names_the_cache_hit():
    rounds = [
        Round(
            arm="llama", ok=True, ttft_s=0.1, decode_s=1.0, total_s=1.1,
            reported_prompt_tokens=9000, reported_completion_tokens=64,
            cached_tokens=8000, content_fields=["content"],
        )
    ]
    out = report(rounds)
    assert "PREFIX CACHE HIT" in out
    assert "8000" in out
    assert "CACHED" in out


def test_report_names_the_reasoning_field():
    rounds = [
        Round(
            arm="llama", ok=True, ttft_s=1.0, decode_s=1.0, total_s=2.0,
            reported_prompt_tokens=1000, reported_completion_tokens=64,
            cached_tokens=0, content_fields=["reasoning_content"],
        )
    ]
    out = report(rounds)
    assert "reasoning_content" in out


def test_report_distinguishes_absent_fields_from_zero():
    rounds = [
        Round(
            arm="ninfer", ok=True, ttft_s=1.0, decode_s=1.0, total_s=2.0,
            reported_prompt_tokens=1000, content_chunks=64,
            missing_fields=["usage.completion_tokens"],
        )
    ]
    out = report(rounds)
    assert "DID NOT SEND" in out
    assert "usage.completion_tokens" in out
    # The chunk-count fallback must be marked, not passed off as a token count.
    assert "*" in out


def test_report_survives_a_failed_round():
    rounds = [Round(arm="ninfer", ok=False, error="ConnectionRefusedError")]
    out = report(rounds)
    assert "FAILED" in out
    assert "ConnectionRefusedError" in out
    assert "no reading" in out


# --- what the quiet-server measurement established ---------------------------


def test_llama_ttft_gap_is_constant():
    """TTFT - prompt_ms does NOT scale with prompt length on a quiet server.

    Measured 2026-09-03 against llama b10689, one client, nothing else on the
    slot. Recorded as a test because the FIRST version of this measurement was
    taken with stray bench containers still holding the slot, which produced a
    gap that appeared to grow with the prompt (11-17 s at ~1300 tokens) and was
    pure queue wait. The retraction is the point: these are the clean numbers,
    and any future reading far outside this band means contention, not a
    regression.
    """
    observed = [
        # prompt_tokens, TTFT s, prompt_ms
        (201, 0.97, 291.435),
        (688, 1.44, 683.247),
        (2637, 2.75, 1441.621),
        (10432, 7.23, 6186.416),
    ]
    gaps = [ttft - pms / 1000.0 for _, ttft, pms in observed]
    assert all(0.5 < g < 1.5 for g in gaps), gaps
    # A 50x span in prompt length moves the gap by well under a second.
    assert max(gaps) - min(gaps) < 0.8


def test_quiet_server_prefill_is_in_the_expected_band():
    """The same rows put prefill where this repo's other instruments put it.

    bench.py reported 718 tok/s at ~1053 tokens and the 2026-09-03 capacity
    probe reported 1797.8 tok/s at 90,029. Prefill rises with prompt length as
    the fixed cost amortises, so a mid-size prompt landing near 1700-1800 is
    the expected shape, not a surprise.
    """
    rows = [(688, 683.247), (2637, 1441.621), (10432, 6186.416)]
    rates = [n / (ms / 1000.0) for n, ms in rows]
    assert rates[0] < rates[1], "prefill should improve as fixed cost amortises"
    assert 1500 < rates[2] < 2000


# --- payload negotiation ----------------------------------------------------
#
# The ninfer arm answered HTTP 400 to a warm-up and three rounds on 2026-09-03
# and produced no number at all. On 2026-09-04, with the body finally captured,
# it turned out to be one line:
#
#   {"error":{"code":null,"message":"missing required field: model",
#             "param":"model","type":"invalid_request_error"}}
#
# `model` is optional in llama.cpp's server and REQUIRED in ninfer's. Diagnosing
# that cost four attempts across two sessions, each one a ~9-minute engine load
# with the production llama server down throughout. These tests pin the ladder
# that turns that into one request -- and, just as load-bearing, pin that it
# stays out of the way when nothing is wrong and never masks a non-400 fault.

REFUSED = (
    'HTTP 400 Bad Request: {"error":{"code":null,'
    '"message":"missing required field: model","param":"model",'
    '"type":"invalid_request_error"}}'
)
REFUSED_VAGUE = 'HTTP 400 Bad Request: {"message":"bad request"}'


def _fake_rounds(monkeypatch, accept, model_id="qwen3.8-27b"):
    """Install a run_round whose success is decided by `accept(adjustments)`.

    Records every attempted adjustment tuple so a test can assert on ORDER, not
    just on the final answer. `/v1/models` is stubbed rather than reached.
    """
    seen: list[tuple[str, ...]] = []

    def fake(arm, base_url, prompt, predict, timeout, model, adjustments=(),
             model_id_arg=None):
        seen.append(tuple(adjustments))
        verdict = accept(tuple(adjustments))
        ok = verdict is True
        return Round(arm=arm, ok=ok, error=None if ok else verdict)

    monkeypatch.setattr(bench_cross_engine, "run_round", fake)
    monkeypatch.setattr(
        bench_cross_engine, "_discover_model_id", lambda url, timeout: model_id
    )
    return seen


def test_the_field_the_server_named_is_tried_first(monkeypatch):
    """ninfer said `param: model`. That must cost ONE request, not five.

    Walking the whole ladder blind would work too, but every rung is a request,
    and the point of reading the error is to not send four pointless ones.
    """
    seen = _fake_rounds(monkeypatch, lambda red: red == ("add-model",))
    red, note, mid = bench_cross_engine.negotiate_payload(
        "ninfer", "http://x", 5.0, None, REFUSED
    )
    assert red == ("add-model",)
    assert mid == "qwen3.8-27b"
    assert seen == [("add-model",)], seen


def test_single_field_is_isolated_not_piled_up(monkeypatch):
    """Naming ONE culprit beats dropping four innocent fields alongside it."""
    seen = _fake_rounds(
        monkeypatch, lambda red: red == ("max-completion-tokens",)
    )
    red, note, _ = bench_cross_engine.negotiate_payload(
        "ninfer", "http://x", 5.0, None, REFUSED_VAGUE
    )
    assert red == ("max-completion-tokens",)
    assert "max-completion-tokens" in note
    assert all(len(r) == 1 for r in seen), "cumulative pass must not have run"
    assert () not in seen, (
        "the full payload was already refused by the caller's warm-up; "
        "re-sending it costs a prompt switch, measured at 237.4 s on llama"
    )


def test_falls_back_to_cumulative_when_no_single_field_explains_it(monkeypatch):
    need = ("add-model", "no-timings-per-token")
    seen = _fake_rounds(monkeypatch, lambda red: red == need)
    red, note, _ = bench_cross_engine.negotiate_payload(
        "ninfer", "http://x", 5.0, None, REFUSED_VAGUE
    )
    assert red == need
    assert "only after" in note
    assert any(len(r) == 1 for r in seen), "singles must be tried first"


def test_a_non_400_fault_is_never_retried_into_silence(monkeypatch):
    """A 500, a refused connection or a timeout is a DIFFERENT fault.

    Retrying adjusted payloads against it would report a healthy-looking empty
    set while hiding the real error, and would burn requests doing it.
    """
    seen = _fake_rounds(monkeypatch, lambda red: True)
    red, note, _ = bench_cross_engine.negotiate_payload(
        "ninfer", "http://x", 5.0, None, "URLError: connection refused"
    )
    assert red == ()
    assert "not negotiable" in note and "connection refused" in note
    assert seen == [], "must not send a single request against a non-400"


def test_add_model_rung_is_dropped_when_the_id_cannot_be_read(monkeypatch):
    """No id means the rung CANNOT be applied. Drop it, do not raise mid-ladder."""
    seen = _fake_rounds(monkeypatch, lambda red: False, model_id=None)
    red, note, mid = bench_cross_engine.negotiate_payload(
        "ninfer", "http://x", 5.0, None, REFUSED
    )
    assert mid is None
    assert all("add-model" not in r for r in seen), seen
    assert red == ()


def test_exhausted_ladder_leaves_the_payload_alone(monkeypatch):
    """If nothing helps, the measured rounds must send the UNADJUSTED payload.

    What lands in the run directory is then the server's own 400 body, not a
    mutated request nobody chose.
    """
    _fake_rounds(monkeypatch, lambda red: REFUSED_VAGUE)
    red, note, _ = bench_cross_engine.negotiate_payload(
        "ninfer", "http://x", 5.0, None, REFUSED_VAGUE
    )
    assert red == ()
    assert "no adjustment helped" in note
    assert "bad request" in note, "the server's own words must survive"


def test_every_ladder_rung_actually_changes_the_payload():
    """A rung that silently no-ops would report a change that never happened."""
    for name in bench_cross_engine.ADJUSTMENT_LADDER:
        payload = {
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 128,
            "temperature": 0.0,
            "stream": True,
            "stream_options": {"include_usage": True},
            "timings_per_token": True,
            "model": "qwen",
        }
        before = json.dumps(payload, sort_keys=True)
        bench_cross_engine._adjust_payload(payload, name, "OTHER-ID")
        assert json.dumps(payload, sort_keys=True) != before, name


def test_unknown_adjustment_raises_rather_than_no_ops():
    with pytest.raises(ValueError, match="unknown payload adjustment"):
        bench_cross_engine._adjust_payload({}, "no-such-field")


def test_add_model_without_an_id_raises():
    with pytest.raises(ValueError, match="add-model needs a model id"):
        bench_cross_engine._adjust_payload({}, "add-model", None)


def test_add_model_sets_the_discovered_id():
    payload = {}
    bench_cross_engine._adjust_payload(payload, "add-model", "qwen3.8-27b")
    assert payload == {"model": "qwen3.8-27b"}


def test_max_completion_tokens_preserves_the_budget():
    payload = {"max_tokens": 128}
    bench_cross_engine._adjust_payload(payload, "max-completion-tokens")
    assert payload == {"max_completion_tokens": 128}, (
        "renaming must carry the value across; a dropped budget would make the "
        "arm generate until the context ends and the decode rate meaningless"
    )


def test_model_id_is_read_from_v1_models(monkeypatch):
    """Hard-coding the id would send one engine the other's name after a rebuild."""
    import io

    class FakeResp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        bench_cross_engine.urllib.request,
        "urlopen",
        lambda url, timeout=None: FakeResp(
            b'{"object":"list","data":[{"id":"qwen3.8-27b","object":"model"}]}'
        ),
    )
    assert bench_cross_engine._discover_model_id("http://x", 5.0) == "qwen3.8-27b"


def test_model_id_absent_is_none_not_a_crash(monkeypatch):
    def boom(url, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(bench_cross_engine.urllib.request, "urlopen", boom)
    assert bench_cross_engine._discover_model_id("http://x", 5.0) is None


# --- the guarantee that lives in main(), not in the negotiator ---------------


def _drive_main(monkeypatch, tmp_path, accept, argv_extra=(), model_id="qwen3.8-27b"):
    """Run main() end to end with a faked run_round; return (calls, json, rc)."""
    calls: list[tuple[str, int, tuple[str, ...], str | None]] = []

    def fake(arm, base_url, prompt, predict, timeout, model, adjustments=(),
             model_id_arg=None):
        calls.append((arm, predict, tuple(adjustments), model_id_arg))
        verdict = accept(arm, tuple(adjustments))
        ok = verdict is True
        return Round(
            arm=arm,
            ok=ok,
            error=None if ok else verdict,
            ttft_s=1.0 if ok else None,
            total_s=2.0 if ok else None,
            decode_s=1.0 if ok else None,
            reported_prompt_tokens=100 if ok else None,
            reported_completion_tokens=8 if ok else None,
        )

    monkeypatch.setattr(bench_cross_engine, "run_round", fake)
    monkeypatch.setattr(
        bench_cross_engine, "_discover_model_id", lambda url, timeout: model_id
    )
    out = tmp_path / "r.json"
    rc = bench_cross_engine.main(
        ["--url", "http://x", "--label", "eng", "--prompt-tokens", "64",
         "--repeat", "2", "--json", str(out), *argv_extra]
    )
    return calls, json.loads(out.read_text()), rc


def test_healthy_arm_pays_nothing_for_the_negotiation_machinery(
    monkeypatch, tmp_path
):
    """One warm-up plus the measured rounds. NOT ONE REQUEST MORE.

    This is the whole reason negotiation hangs off the warm-up's refusal rather
    than sending a probe of its own. Every extra request on llama is an extra
    prompt-cache switch, and that was measured at 237398.29 ms -- 4 minutes --
    on this box on 2026-09-04.
    """
    calls, doc, rc = _drive_main(monkeypatch, tmp_path, lambda arm, red: True)
    assert rc == 0
    assert len(calls) == 3, calls          # warm-up + 2 measured rounds
    assert all(red == () for _, _, red, _ in calls)
    assert doc["payload_adjustments"] == {"eng": []}
    assert doc["payload_notes"] == {}


def test_a_refused_arm_negotiates_rewarms_and_then_measures(monkeypatch, tmp_path):
    """The order matters: adjust, warm up AGAIN, then measure.

    Without the second warm-up the first measured round absorbs the cold-start
    cost (2.09 s against 0.97 s here), and that lands in TTFT -- which is the
    prefill number the whole comparison turns on.
    """
    def accept(arm, red):
        return True if red == ("add-model",) else REFUSED

    calls, doc, rc = _drive_main(monkeypatch, tmp_path, accept)
    assert rc == 0
    assert doc["payload_adjustments"] == {"eng": ["add-model"]}
    assert doc["payload_model_ids"] == {"eng": "qwen3.8-27b"}
    assert "add-model" in doc["payload_notes"]["eng"]

    assert calls[0] == ("eng", 8, (), None), "warm-up sends the full payload"
    assert [c[2] for c in calls[-2:]] == [("add-model",)] * 2
    assert ("eng", 8, ("add-model",), "qwen3.8-27b") in calls[1:-2], (
        "a discarded warm-up must run again with the accepted shape"
    )
    # the id must reach the measured rounds, not just the negotiation
    assert all(c[3] == "qwen3.8-27b" for c in calls[-2:])
    assert all(r["ok"] for r in doc["rounds"])


def test_no_negotiate_reports_the_refusal_and_changes_nothing(monkeypatch, tmp_path):
    calls, doc, rc = _drive_main(
        monkeypatch, tmp_path, lambda arm, red: REFUSED, ("--no-negotiate",)
    )
    assert rc == 1, "no round succeeded, so the exit status must say so"
    assert doc["payload_adjustments"] == {"eng": []}
    assert all(red == () for _, _, red, _ in calls)
    assert all("missing required field" in (r["error"] or "") for r in doc["rounds"]), (
        "the server's own 400 body must reach the run directory"
    )


def test_no_warmup_says_it_did_not_negotiate_rather_than_implying_full(
    monkeypatch, tmp_path
):
    """An absent key reads as 'nothing was dropped'. It is not the same claim."""
    _, doc, _ = _drive_main(
        monkeypatch, tmp_path, lambda arm, red: True, ("--no-warmup",)
    )
    assert doc["payload_adjustments"] == {"eng": []}
    assert "not negotiated" in doc["payload_notes"]["eng"]


# --- the regression that killed the ninfer arm on 2026-09-04 ----------------


def test_backend_refused_is_recorded_not_raised(monkeypatch):
    """An HTTP error must END A ROUND, never the run.

    BackendRefused was added to carry the server's 400 body -- which is what
    finally named `model` -- but it is a RuntimeError, and run_round's except
    tuple listed only URLError/HTTPError/TimeoutError/OSError. So it stopped
    being caught: the ninfer warm-up raised, main() never reached the rounds,
    no ninfer.json was written, and a nine-minute engine load bought exactly
    one traceback.
    """
    def boom(url, payload, timeout):
        raise bench_cross_engine.BackendRefused(
            'HTTP 400 Bad Request: {"error":{"message":"missing required '
            'field: model","param":"model"}}'
        )
        yield  # pragma: no cover - generator, never reached

    monkeypatch.setattr(bench_cross_engine, "_post_stream", boom)
    rnd = bench_cross_engine.run_round("ninfer", "http://x", "p", 8, 5.0, None)
    assert rnd.ok is False
    assert "BackendRefused" in rnd.error
    assert "missing required field: model" in rnd.error, (
        "the whole point of the exception is that the body survives into the "
        "round record, and from there into the run directory"
    )


def test_a_plain_http_error_is_still_recorded():
    """The types BackendRefused replaced must keep working."""
    import urllib.error

    def boom(url, payload, timeout):
        raise urllib.error.URLError("connection refused")
        yield  # pragma: no cover

    import unittest.mock as m
    with m.patch.object(bench_cross_engine, "_post_stream", boom):
        rnd = bench_cross_engine.run_round("eng", "http://x", "p", 8, 5.0, None)
    assert rnd.ok is False and "URLError" in rnd.error


def test_an_inert_rung_costs_no_request(monkeypatch):
    """`no-model` pops a key we never send. Re-sending is provably useless.

    The payload it produces is byte-identical to the one the caller already has
    a 400 for, so the attempt can only return the same 400 -- while costing a
    request, which on llama is a prompt-cache switch measured at up to 237 s.
    """
    seen = _fake_rounds(monkeypatch, lambda red: False, model_id=None)
    # model_id=None drops add-model, leaving no-model as the only inert rung
    bench_cross_engine.negotiate_payload(
        "ninfer", "http://x", 5.0, None, REFUSED_VAGUE
    )
    assert ("no-model",) not in seen, seen


def test_an_inert_rung_is_still_tried_when_it_does_change_things(monkeypatch):
    """With --model given, `no-model` DOES alter the payload, so it must run."""
    seen = _fake_rounds(monkeypatch, lambda red: False, model_id=None)
    bench_cross_engine.negotiate_payload(
        "ninfer", "http://x", 5.0, "some-model", REFUSED_VAGUE
    )
    assert ("no-model",) in seen, seen


def test_the_builder_is_the_one_the_rounds_use(monkeypatch):
    """If the negotiator compared against a COPY, drift would silently skip rungs."""
    sent = {}

    def capture(url, payload, timeout):
        sent.update(payload)
        raise bench_cross_engine.BackendRefused("HTTP 400 Bad Request: {}")
        yield  # pragma: no cover

    monkeypatch.setattr(bench_cross_engine, "_post_stream", capture)
    bench_cross_engine.run_round("eng", "http://x", "PROMPT", 64, 5.0, None)
    assert sent == bench_cross_engine._build_round_payload("PROMPT", 64, None)
