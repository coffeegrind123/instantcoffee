#!/usr/bin/env python3
"""The stranded-tool-call counter, one case per Strata rule.

Each case is a single completion record classified in isolation, so a rule that
regresses fails on its own line rather than shifting a tape total.
"""

from __future__ import annotations

import unittest

import stranded_tool_calls as s


def completion(reasoning="", tool_calls=None, finish="stop", tools=("net_configure",)):
    return {
        "kind": "completion",
        "capture_id": "test",
        "seq": 1,
        "response": {
            "reasoning_content": reasoning,
            "tool_calls": list(tool_calls or []),
            "finish_reason": finish,
        },
        "request": {
            "tools": [{"type": "function", "function": {"name": n}} for n in tools],
        },
    }


CALL = '<tool_call>\n{"name": "net_configure", "arguments": {"iface": "eth0"}}\n</tool_call>'


class ScanRules(unittest.TestCase):
    def test_plain_stranded(self):
        c = s.classify(completion(reasoning=f"I should call it.\n{CALL}\n"))
        self.assertEqual(c["stranded"], ["net_configure"])

    def test_recovered_not_stranded(self):
        # Same markup, but the call ALSO came back as a real tool_call.
        c = s.classify(completion(
            reasoning=f"{CALL}",
            tool_calls=[{"name": "net_configure", "arguments": "{}"}],
            finish="tool_calls",
        ))
        self.assertEqual(c["stranded"], [])

    def test_fenced_is_quoted(self):
        c = s.classify(completion(reasoning=f"like this:\n```\n{CALL}\n```\n"))
        self.assertEqual(c["stranded"], [])
        self.assertEqual(c["fenced"], 1)

    def test_inline_code_is_quoted(self):
        c = s.classify(completion(reasoning=f"the `{CALL}` tag"))
        self.assertEqual(c["stranded"], [])
        self.assertEqual(c["fenced"], 1)

    def test_undeclared_name_stays_text(self):
        bad = CALL.replace("net_configure", "rm_rf_slash")
        c = s.classify(completion(reasoning=bad))
        self.assertEqual(c["stranded"], [])
        self.assertEqual(c["undeclared"], ["rm_rf_slash"])

    def test_length_cut_stays_text(self):
        c = s.classify(completion(reasoning=f"{CALL}", finish="length"))
        self.assertEqual(c["stranded"], [])
        self.assertEqual(c["length_cut"], 1)

    def test_plain_reasoning_no_markup(self):
        c = s.classify(completion(reasoning="Just thinking, no call here."))
        self.assertEqual(c["stranded"], [])
        self.assertEqual(c["markup_hits"], 0)
        self.assertTrue(c["has_reasoning"])

    def test_non_completion_ignored(self):
        self.assertIsNone(s.classify({"kind": "session_start"}))

    def test_two_calls_one_fenced_one_live(self):
        other = CALL.replace("eth0", "eth1")
        rc = f"```\n{CALL}\n```\nand then really:\n{other}"
        c = s.classify(completion(reasoning=rc))
        self.assertEqual(c["fenced"], 1)
        self.assertEqual(c["stranded"], ["net_configure"])

    def test_unterminated_fence_swallows(self):
        # A fence that never closes runs to end of text, so a call after it is
        # still quoted, not stranded.
        c = s.classify(completion(reasoning=f"```\n{CALL}"))
        self.assertEqual(c["stranded"], [])
        self.assertEqual(c["fenced"], 1)


class CodeSpans(unittest.TestCase):
    def test_fence_beats_inline(self):
        # A lone backtick inside an open fence is body, not an inline span.
        spans = s.code_spans("```\na ` b\n```")
        self.assertEqual(len(spans), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
