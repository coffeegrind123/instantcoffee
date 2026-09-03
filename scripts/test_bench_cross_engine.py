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
