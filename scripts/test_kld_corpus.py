"""Tests for kld_corpus: the build is deterministic and refuses a short corpus."""

from __future__ import annotations

import io
import zipfile

import pytest

import kld_corpus as kc


def _zip(member: str, data: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(member, data)
    return buf.getvalue()


BIG = b"x" * (kc.MIN_TOKENS * kc.CHARS_PER_TOKEN_FLOOR)


def fake_fetch(responses: dict[str, bytes]):
    seen = []

    def fetch(url: str) -> bytes:
        seen.append(url)
        return responses[url]

    fetch.seen = seen
    return fetch


def responses(code_a=BIG, code_b=b"// b", prose=BIG):
    r = {kc.RAW.format(tag=kc.LLAMA_TAG, path=p): d for p, d in zip(kc.CODE_FILES, (code_a, code_b))}
    r[kc.WIKITEXT_URL] = _zip(kc.WIKITEXT_MEMBER, prose)
    return r


def test_build_concatenates_code_files_in_order():
    code, prose, meta = kc.build(fake_fetch(responses()))
    assert code == BIG + b"\n" + b"// b"
    assert prose == BIG
    assert meta["outputs"]["code.txt"]["sha256"] == kc.sha256(code)


def test_code_is_read_at_the_pinned_tag():
    f = fake_fetch(responses())
    kc.build(f)
    assert all(f"/{kc.LLAMA_TAG}/src/" in u for u in f.seen[:2])


def test_meta_records_every_source():
    _, _, meta = kc.build(fake_fetch(responses()))
    assert [s["url"] for s in meta["sources"]][-1] == kc.WIKITEXT_URL
    assert len(meta["sources"]) == len(kc.CODE_FILES) + 1


@pytest.mark.parametrize("which", ["code", "prose"])
def test_short_corpus_is_refused(which):
    short = b"y" * 100
    r = responses(code_a=short, code_b=b"", prose=BIG) if which == "code" else responses(prose=short)
    with pytest.raises(ValueError, match=which):
        kc.build(fake_fetch(r))


def test_main_writes_files(tmp_path, monkeypatch):
    monkeypatch.setattr(kc, "http_get", fake_fetch(responses()))
    assert kc.main(["--out", str(tmp_path)]) == 0
    assert (tmp_path / "code.txt").read_bytes().startswith(b"x")
    assert (tmp_path / "prose.txt").read_bytes() == BIG
    assert "llama_tag" in (tmp_path / "corpus.json").read_text()
