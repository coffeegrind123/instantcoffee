"""Tests for empty_turn_ab.

The statistics are checked against published values, not against this module's
own output: Fisher's lady-tasting-tea table and the classic [[1,9],[11,3]]
example, and the Wilson interval for 0 of 40.
"""

from __future__ import annotations

import json

import pytest

import empty_turn_ab as e


# --- arms -------------------------------------------------------------------------


def test_parse_arm_baseline_and_override():
    assert e.parse_arm("base:") == e.Arm("base", {})
    assert e.parse_arm("fp03:frequency_penalty=0.3,top_k=20").overrides == {"frequency_penalty": 0.3, "top_k": 20}


@pytest.mark.parametrize("spec", ["nocolon", ":frequency_penalty=0.3", "x:frequency_penatly=0.3", "x:top_k", "x y:"])
def test_parse_arm_refuses(spec):
    """A misspelt key must not become a silent A/A test."""
    with pytest.raises(ValueError):
        e.parse_arm(spec)


# --- the enum workload -----------------------------------------------------------------


def test_enum_prompt_is_deterministic_and_plants_answers():
    p1, b1 = e.build_enum_prompt(400, 11)
    p2, b2 = e.build_enum_prompt(400, 11)
    assert (p1, b1) == (p2, b2)
    assert len(b1) == 10
    for i in b1:
        assert f"node-{i:04d}  port={8000 + i}  " not in p1
    good = next(i for i in range(1, 401) if i not in b1)
    assert f"node-{good:04d}  port={8000 + good}  " in p1


def test_enum_prompt_differs_per_round():
    assert e.build_enum_prompt(400, 1)[0] != e.build_enum_prompt(400, 2)[0]


# --- the tape workload -----------------------------------------------------------------


def _tape(tmp_path, rows):
    path = tmp_path / "tape.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return str(path)


def _row(ptok, gaps=None, messages=True):
    return {
        "gaps": gaps or [],
        "request": {"messages": [{"role": "user", "content": "x"}] if messages else [], "tools": [{"type": "function"}]},
        "response": {"usage": {"prompt_tokens": ptok}},
    }


def test_tape_band_and_gap_refusal(tmp_path):
    path = _tape(tmp_path, [_row(1000), _row(90000), _row(91000, gaps=["system_prompt"]), _row(92000, messages=False)])
    keep, refused = e.load_tape(path, 85000)
    assert [k["line"] for k in keep] == [2]
    assert keep[0]["tools"] == [{"type": "function"}]
    assert len(refused) == 2 and "gaps" in refused[0] and "messages" in refused[1]


def test_tape_upper_bound(tmp_path):
    path = _tape(tmp_path, [_row(80000), _row(90000)])
    keep, _ = e.load_tape(path, 0, 85000)
    assert [k["prompt_tokens"] for k in keep] == [80000]


# --- classification ------------------------------------------------------------------


def _body(content="", reasoning="", tool_calls=None, finish="stop"):
    return {
        "choices": [{"finish_reason": finish, "message": {"content": content, "reasoning_content": reasoning, "tool_calls": tool_calls}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 50},
    }


def test_classify_empty_with_reasoning_is_empty():
    r = e.classify(200, _body(content="  \n", reasoning="node-0001 ok, node-0002 ok"))
    assert r["outcome"] == "empty" and r["reasoning_chars"] > 0 and r["finish_reason"] == "stop"


def test_classify_tool_call_is_an_answer():
    assert e.classify(200, _body(tool_calls=[{"id": "1"}]))["outcome"] == "answer"


def test_classify_text_is_an_answer():
    assert e.classify(200, _body(content="node-0042"))["outcome"] == "answer"


def test_classify_http_error_is_not_counted_as_empty():
    assert e.classify(500, "boom")["outcome"] == "error"
    assert e.classify(200, "not json")["outcome"] == "error"


# --- statistics ----------------------------------------------------------------------


def test_fisher_lady_tasting_tea():
    """Fisher (1935): [[3,1],[1,3]], two-sided p = 34/70 = 0.4857."""
    assert e.fisher_exact(3, 1, 1, 3) == pytest.approx(34 / 70, abs=1e-6)


def test_fisher_classic_example():
    """[[1,9],[11,3]]: two-sided p = 0.002759 (the standard worked example)."""
    assert e.fisher_exact(1, 9, 11, 3) == pytest.approx(0.002759, abs=2e-6)


def test_fisher_symmetric_table_is_one():
    assert e.fisher_exact(5, 5, 5, 5) == pytest.approx(1.0)


def test_wilson_zero_of_forty():
    """Upper bound for 0/40 at 95% is 0.0876."""
    lo, hi = e.wilson(0, 40)
    assert lo == 0.0 and hi == pytest.approx(0.0876, abs=5e-4)


def test_wilson_empty_sample():
    assert e.wilson(0, 0) == (0.0, 1.0)


# --- schedule and summary ------------------------------------------------------------


def test_schedule_pairs_every_arm_once_per_round_and_shuffles():
    arms = [e.Arm("a"), e.Arm("b"), e.Arm("c")]
    plan = e.schedule(arms, 30, seed=1)
    for r in range(30):
        assert sorted(a.name for rr, a in plan if rr == r) == ["a", "b", "c"]
    firsts = {[a.name for rr, a in plan if rr == r][0] for r in range(30)}
    assert len(firsts) > 1, "order never changes, so drift lands on one arm"
    assert plan == e.schedule(arms, 30, seed=1)


def test_summary_reports_counts_and_p():
    arms = [e.Arm("base"), e.Arm("fp03", {"frequency_penalty": 0.3})]
    recs = ([{"arm": "base", "outcome": "empty", "reasoning_chars": 9, "finish_reason": "stop"}] * 11
            + [{"arm": "base", "outcome": "answer"}] * 3
            + [{"arm": "fp03", "outcome": "empty", "reasoning_chars": 9, "finish_reason": "stop"}]
            + [{"arm": "fp03", "outcome": "answer"}] * 9)
    lines = "\n".join(e.summarise(recs, arms))
    assert "empty  11/14" in lines and "empty   1/10" in lines
    assert "p = 0.0028" in lines


def test_summary_says_when_the_workload_did_not_trigger():
    arms = [e.Arm("base"), e.Arm("fp03")]
    recs = [{"arm": "base", "outcome": "answer"}, {"arm": "fp03", "outcome": "answer"}]
    assert "did not trigger the failure" in "\n".join(e.summarise(recs, arms))


def test_errors_are_excluded_from_the_denominator():
    arms = [e.Arm("base"), e.Arm("x")]
    recs = [{"arm": "base", "outcome": "error"}, {"arm": "base", "outcome": "empty"}, {"arm": "x", "outcome": "answer"}]
    lines = e.summarise(recs, arms)
    assert "empty   1/1" in lines[0] and "errors 1" in lines[0]


# --- cli -----------------------------------------------------------------------------


def test_needs_two_arms(capsys):
    assert e.main(["--arm", "base:", "--rounds", "1"]) == 2


def test_tape_workload_needs_tape():
    with pytest.raises(SystemExit):
        e.main(["--workload", "tape", "--arm", "a:", "--arm", "b:"])


def test_self_test():
    assert e.main(["--self-test"]) == 0
