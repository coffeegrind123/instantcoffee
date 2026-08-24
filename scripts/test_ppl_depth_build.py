#!/usr/bin/env python3
"""Tests for ppl_depth_build's file handling.

THE ONE THAT MATTERS is test_a_corpus_with_carriage_returns_is_not_rewritten.
The whole rotation design rests on the arm file being the SAME TOKENS as the
corpus, shifted by a whole number of chunks. Python's text mode quietly breaks
that for any corpus containing carriage returns: universal-newline translation
turns "\\r\\n" into "\\n" and a bare "\\r" into "\\n" on the way in, and writing the
result back does not undo it.

Measured 2026-08-24 on a real corpus rather than imagined: `pi-150turn.txt`
holds 414 CR bytes, 10 of them in "\\r\\n" pairs. The arm file built from it came
out 10 bytes shorter and differed in 414 places — and the alignment control
caught it at 871.8x its own printing floor, on exactly the four chunks that
contained the changed bytes. `deep-s26b5bb.txt` has zero CRs, which is why this
survived every earlier run and only appeared when a second corpus arrived.

A unit test is the cheap place for this. The control found it, but the control
costs an hour of GPU time and a stopped server.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ppl_depth_build import read_corpus_bytes, write_arm_file  # noqa: E402

# Every way a carriage return can appear, plus plain text either side of them.
NASTY = (b"<|im_start|>system\r\n# Tools\r\n\r\nplain line\n"
         b"bare CR here:\rand text after it\n"
         b"mixed \r\n and \r and \n in one line\n"
         b"trailing CRLF at EOF\r\n")


class TestByteExactness(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.corpus = os.path.join(self.dir, "corpus.txt")
        with open(self.corpus, "wb") as fh:
            fh.write(NASTY)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_the_reader_returns_the_file_unchanged(self):
        self.assertEqual(read_corpus_bytes(self.corpus), NASTY)

    def test_text_mode_would_have_changed_it(self):
        """The control for the test above: prove the hazard is real, not theory."""
        with open(self.corpus, encoding="utf-8") as fh:
            through_text_mode = fh.read().encode("utf-8")
        self.assertNotEqual(through_text_mode, NASTY)
        self.assertEqual(through_text_mode.count(b"\r"), 0,
                         "text mode strips every CR — that is the whole bug")
        self.assertLess(len(through_text_mode), len(NASTY),
                        "and \\r\\n pairs lose a byte each")

    def test_a_corpus_with_carriage_returns_is_not_rewritten(self):
        """THE ONE THAT MATTERS: the arm file must END with the corpus, byte for byte."""
        arm = os.path.join(self.dir, "corpus-f8.txt")
        prefix = "filler filler\n\n"
        write_arm_file(arm, prefix, read_corpus_bytes(self.corpus))
        with open(arm, "rb") as fh:
            got = fh.read()
        self.assertEqual(got, prefix.encode("utf-8") + NASTY)
        self.assertTrue(got.endswith(NASTY),
                        "the corpus half of an arm file must be the corpus")
        self.assertEqual(len(got) - len(NASTY), len(prefix.encode("utf-8")),
                         "and the prefix must be the only thing added")

    def test_the_corpus_byte_count_is_preserved_exactly(self):
        arm = os.path.join(self.dir, "corpus-f8.txt")
        write_arm_file(arm, "x\n\n", read_corpus_bytes(self.corpus))
        self.assertEqual(os.stat(arm).st_size - len(b"x\n\n"),
                         os.stat(self.corpus).st_size)

    def test_a_corpus_with_no_carriage_returns_is_unaffected_either_way(self):
        """Why this survived: the first corpus had none, so both modes agreed."""
        clean = os.path.join(self.dir, "clean.txt")
        body = b"<|im_start|>system\nno carriage returns here\nat all\n"
        with open(clean, "wb") as fh:
            fh.write(body)
        with open(clean, encoding="utf-8") as fh:
            self.assertEqual(fh.read().encode("utf-8"), read_corpus_bytes(clean))


if __name__ == "__main__":
    unittest.main(verbosity=2)
