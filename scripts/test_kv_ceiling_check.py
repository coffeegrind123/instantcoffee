"""Tests for kv_ceiling_check.

The load-bearing test is `test_control_reproduces_engine_report`: it checks the
model against a number this repo's own llama.cpp computed and printed. Every
other assertion here is only worth as much as that one.
"""

from __future__ import annotations

import pytest

from kv_ceiling_check import (
    BYTES_PER_ELEMENT,
    GEOMETRY_QWEN38_27B,
    GIB,
    MIB,
    NINFER_4090_CLAIMS,
    NINFER_ARTIFACT_BYTES,
    RTX_4090_BYTES,
    CeilingClaim,
    KVGeometry,
    bytes_per_token,
    check_ceilings,
    kv_bytes,
    main,
    run_control,
    slack_spread,
    tokens_for_budget,
)


# --- the control ------------------------------------------------------------


def test_control_reproduces_engine_report():
    """llama.cpp printed 1632.00 MiB for K and 3264.00 for K+V at 98,304 cells.

    If this fails, the geometry or the q8_0 element size is wrong and nothing
    else in this module should be believed.
    """
    k_mib, kv_mib = run_control(GEOMETRY_QWEN38_27B)
    assert k_mib == pytest.approx(1632.00, abs=0.005)
    assert kv_mib == pytest.approx(3264.00, abs=0.005)


def test_control_entry_point_passes():
    assert main(["--control"]) == 0


def test_control_fails_on_wrong_layer_count():
    """A negative control: the check must be able to FAIL.

    Using all 64 layers instead of the 16 that carry KV -- the exact mistake
    that makes every large-context claim look fabricated -- must not pass.
    """
    wrong = KVGeometry(name="wrong", kv_layers=64, kv_heads=4, head_dim=256)
    k_mib, _ = run_control(wrong)
    assert k_mib != pytest.approx(1632.00, abs=0.005)
    assert k_mib == pytest.approx(4 * 1632.00, abs=0.05)


# --- geometry ---------------------------------------------------------------


def test_geometry_matches_engine_print_info():
    g = GEOMETRY_QWEN38_27B
    assert g.kv_layers == 16          # llama_kv_cache: "16 layers"
    assert g.kv_heads == 4            # print_info: n_head_kv = 4
    assert g.head_dim == 256          # print_info: n_embd_head_k = 256
    assert g.total_layers == 64       # print_info: n_layer = 64


def test_elements_per_token():
    g = GEOMETRY_QWEN38_27B
    assert g.elements_per_token_per_side == 16 * 4 * 256
    assert g.elements_per_token == 2 * 16 * 4 * 256 == 32768


# --- element sizes ----------------------------------------------------------


def test_q8_0_carries_its_block_scale():
    """q8_0 is 34 bytes per 32 elements, not 1 byte per element."""
    assert BYTES_PER_ELEMENT["q8_0"] == 34 / 32
    assert BYTES_PER_ELEMENT["q8_0"] > BYTES_PER_ELEMENT["int8"]


def test_bytes_per_token_int8_is_32_kib():
    per_tok = bytes_per_token(GEOMETRY_QWEN38_27B, "int8", "int8")
    assert per_tok == 32 * 1024


def test_unknown_format_raises():
    with pytest.raises(KeyError):
        bytes_per_token(GEOMETRY_QWEN38_27B, "int8", "not-a-format")


def test_negative_tokens_rejected():
    with pytest.raises(ValueError):
        kv_bytes(GEOMETRY_QWEN38_27B, -1, "int8", "int8")


def test_negative_budget_rejected():
    with pytest.raises(ValueError):
        tokens_for_budget(GEOMETRY_QWEN38_27B, -1, "int8", "int8")


def test_tokens_for_budget_inverts_kv_bytes():
    used = kv_bytes(GEOMETRY_QWEN38_27B, 50_000, "e8-4bit", "e8-4bit")
    assert tokens_for_budget(GEOMETRY_QWEN38_27B, used, "e8-4bit", "e8-4bit") == (
        pytest.approx(50_000)
    )


def test_current_pin_budget_recovers_current_window():
    """The stack's 3264 MiB of q8_0 KV is exactly its 98,304-token window."""
    n = tokens_for_budget(GEOMETRY_QWEN38_27B, 3264 * MIB, "q8_0", "q8_0")
    assert n == pytest.approx(98304, abs=1)


# --- the published ceilings -------------------------------------------------


def test_every_published_ceiling_fits_the_card():
    verdicts = check_ceilings(
        GEOMETRY_QWEN38_27B, NINFER_4090_CLAIMS, NINFER_ARTIFACT_BYTES, RTX_4090_BYTES
    )
    assert len(verdicts) == len(NINFER_4090_CLAIMS)
    for v in verdicts:
        assert v.fits, f"{v.claim.label} implies {v.implied_total_bytes / GIB:.2f} GiB"


def test_published_ceilings_agree_on_the_residual_slack():
    """Five ceilings binary-searched on one card must leave the same slack.

    They land inside a third of a GiB of each other. That mutual consistency is
    the corroboration -- no single row proves anything on its own.
    """
    verdicts = check_ceilings(
        GEOMETRY_QWEN38_27B, NINFER_4090_CLAIMS, NINFER_ARTIFACT_BYTES, RTX_4090_BYTES
    )
    assert slack_spread(verdicts) < 0.35 * GIB
    for v in verdicts:
        assert 0.15 * GIB < v.slack_bytes < 0.65 * GIB


def test_slack_shrinks_as_kv_precision_rises():
    """Coarser search granularity at higher precision, so slack is monotone.

    Ordered by bytes/token, the residual slack should not increase: each extra
    bit makes the binary search step larger in tokens-of-headroom terms.
    """
    verdicts = check_ceilings(
        GEOMETRY_QWEN38_27B, NINFER_4090_CLAIMS, NINFER_ARTIFACT_BYTES, RTX_4090_BYTES
    )
    ordered = sorted(verdicts, key=lambda v: v.bytes_per_token)
    slacks = [v.slack_bytes for v in ordered]
    assert slacks == sorted(slacks, reverse=True)


def test_a_fabricated_ceiling_is_caught():
    """Negative control: a claim that does not come from a real search fails.

    Doubling the int8 ceiling keeps the KV format honest but overruns the card,
    which is exactly what the check exists to notice.
    """
    bogus = [CeilingClaim("bogus-int8", "int8", "int8", 446_000)]
    verdicts = check_ceilings(
        GEOMETRY_QWEN38_27B, bogus, NINFER_ARTIFACT_BYTES, RTX_4090_BYTES
    )
    assert not verdicts[0].fits


def test_a_scattered_claim_set_is_caught():
    """Negative control on the spread test itself."""
    scattered = [
        CeilingClaim("a", "int8", "int8", 223_000),
        CeilingClaim("b", "e8-4bit", "e8-4bit", 300_000),
    ]
    verdicts = check_ceilings(
        GEOMETRY_QWEN38_27B, scattered, NINFER_ARTIFACT_BYTES, RTX_4090_BYTES
    )
    assert slack_spread(verdicts) > 2 * GIB


def test_artifact_size_matches_the_published_file():
    """HEAD on the ungated .ninfer returned this content-length exactly."""
    assert NINFER_ARTIFACT_BYTES == 18_210_531_328
    assert NINFER_ARTIFACT_BYTES / GIB == pytest.approx(16.96, abs=0.005)


def test_card_size_matches_this_box():
    """nvidia-smi memory.total on the 4090 in this machine."""
    assert RTX_4090_BYTES == 24564 * MIB


# --- entry point ------------------------------------------------------------


def test_report_entry_point(capsys):
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "slack spread across claims" in out
    assert "rk4v4-e8" in out


def test_json_entry_point(capsys):
    import json

    assert main(["--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["geometry"]["elements_per_token"] == 32768
    assert len(payload["claims"]) == len(NINFER_4090_CLAIMS)
    assert all(c["fits"] for c in payload["claims"])


def test_budget_entry_point(capsys):
    assert main(["--budget-mib", "3264"]) == 0
    out = capsys.readouterr().out
    assert "98,304" in out
