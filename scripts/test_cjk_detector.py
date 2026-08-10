#!/usr/bin/env python3
"""Unit tests for the CJK leak detector in ab_think_lang.py.

Runs anywhere — no GPU, no stack, no network:
    python3 scripts/test_cjk_detector.py

This detector is the go/no-go for THINK_LANG. If it under-reports, a config
that writes Chinese into file paths gets adopted; if it over-reports, a config
that works gets rejected because someone wrote "café" in a docstring. Both
directions are tested.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name: str, path: Path):
    """Import a sibling script by path.

    Registered in sys.modules before exec: @dataclass resolves its own module
    out of sys.modules, and a module loaded without being registered there
    raises AttributeError on the decorator rather than anything informative.
    """
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ab = _load("ab_think_lang", HERE / "ab_think_lang.py")

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f"  [ok]   {label}")
    else:
        print(f"  [FAIL] {label}: got {got!r}, want {want!r}")
        FAILURES.append(label)


def main() -> int:
    print("CJK leak detector")

    print("\n-- must flag (a leak that would break a run) --")
    leaks = [
        ("han ideographs", "the value is 配置文件"),
        ("single hanzi in a path", "/srv/app/配置/settings.json"),
        ("fullwidth comma", "foo，bar"),
        ("ideographic full stop", "done。"),
        ("corner brackets", "「config」"),
        ("ideographic space", "a　b"),
        ("hiragana", "これ"),
        ("katakana", "テスト"),
        ("fullwidth colon", "key：value"),
        ("extension A ideograph", "㐀"),
        ("compatibility ideograph", "豈"),
        ("mixed into json args", '{"path": "/etc/配置.json"}'),
    ]
    for label, text in leaks:
        check(label, ab.has_cjk(text), True)

    print("\n-- must not flag (legitimate output) --")
    clean = [
        ("plain ascii code", "def read_config(path):\n    return json.load(path)"),
        ("accented latin", "naive café résumé Zürich"),
        ("cyrillic", "привет мир"),
        ("greek", "λ = 0.5 and Δt"),
        ("emoji", "shipped 🚀 ok"),
        ("empty string", ""),
        ("ascii punctuation", "a, b. c: d; (e) [f] {g}"),
        ("em dash and quotes", "an em—dash and “smart quotes”"),
        ("math symbols", "x ≤ y ≥ z ± 1 → ∞"),
        ("box drawing", "├── scripts"),
    ]
    for label, text in clean:
        check(label, ab.has_cjk(text), False)

    print("\n-- counting --")
    check("counts every char, not matches", len(ab.cjk_chars("配置文件")), 4)
    check("counts across a mixed string", len(ab.cjk_chars("a配b置c")), 2)
    check("empty counts zero", len(ab.cjk_chars("")), 0)
    check("clean text counts zero", len(ab.cjk_chars("hello world")), 0)

    print("\n-- excerpting --")
    sample = ab.cjk_sample("path=/srv/配置/settings.json")
    check("sample is non-empty on a leak", bool(sample), True)
    check("sample contains the offender", "配" in sample, True)
    check("sample is empty on clean text", ab.cjk_sample("all ascii"), "")
    check("sample flattens newlines",
          "\n" not in ab.cjk_sample("line one\nline 配 two"), True)

    print("\n-- reply plumbing --")
    reply = ab.Reply(tool_calls=[{
        "function": {"name": "read_file",
                     "arguments": '{"path": "/etc/配置.json"}'}}])
    check("tool args are searchable", ab.has_cjk(reply.tool_arg_text), True)
    check("empty tool calls yield no text", ab.Reply().tool_arg_text.strip(), "")

    print("\n-- verdict gating --")
    base = {"score": 0.90, "reasoning_chars": 1000.0, "seconds": 10.0,
            "cjk_visible": 0, "cjk_tool_args": 0}
    # A leak in tool args must reject regardless of how good the score looks.
    great_but_leaky = {"score": 1.00, "reasoning_chars": 400.0, "seconds": 6.0,
                       "cjk_visible": 0, "cjk_tool_args": 3}
    _, code = ab.verdict(base, great_but_leaky, 0.05)
    check("tool-arg leak rejects even at a perfect score", code, 1)

    visible_leak = {"score": 1.00, "reasoning_chars": 400.0, "seconds": 6.0,
                    "cjk_visible": 7, "cjk_tool_args": 0}
    _, code = ab.verdict(base, visible_leak, 0.05)
    check("visible leak rejects", code, 1)

    worse = {"score": 0.70, "reasoning_chars": 400.0, "seconds": 6.0,
             "cjk_visible": 0, "cjk_tool_args": 0}
    _, code = ab.verdict(base, worse, 0.05)
    check("a real quality drop rejects", code, 1)

    cheaper = {"score": 0.89, "reasoning_chars": 600.0, "seconds": 7.0,
               "cjk_visible": 0, "cjk_tool_args": 0}
    text, code = ab.verdict(base, cheaper, 0.05)
    check("same quality plus cheaper reasoning adopts", code, 0)
    check("and says so", "ADOPT (cost)" in text, True)

    wash = {"score": 0.89, "reasoning_chars": 980.0, "seconds": 9.9,
            "cjk_visible": 0, "cjk_tool_args": 0}
    text, code = ab.verdict(base, wash, 0.05)
    check("a wash changes nothing", "NO CHANGE" in text, True)

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} — {', '.join(FAILURES)}")
        return 1
    print("All CJK detector tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
