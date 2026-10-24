"""Tests for kld_budget.

The control that matters is not in this file, because CI has no model files: on
2026-10-04 `kld_budget.place(model, 999)` was run against both GGUFs this stack
serves and reproduced llama.cpp's own load-time report (capacity logs, b10573+,
66/66 layers offloaded):

    file                                  engine CUDA_Host / CUDA0     this module
    Qwen3.8-27B-UD-Q4_K_XL.gguf           682.03 / 16053.22 MiB         682.03 / 16053.22
    Qwen3.8-27B-Uncensored-Q4_K_M.gguf    682.03 / 15339.44 MiB         682.03 / 15339.43

The tests here pin the parser and the placement rule on a synthetic GGUF built
in memory, including the negative control that the rule can tell blocks apart.
"""

from __future__ import annotations

import io
import json
import struct

import pytest

import kld_budget as kb
from kld_budget import MIB, layer_on_gpu, logits_buffers_bytes, max_ngl_for_vram, place, read_model


# --- a minimal GGUF writer ------------------------------------------------------


def _s(text: str) -> bytes:
    raw = text.encode()
    return struct.pack("<Q", len(raw)) + raw


def build_gguf(
    tensors: list[tuple[str, int]],
    block_count: int,
    n_vocab: int = 8,
    arch: str = "qwen35",
    alignment: int | None = None,
) -> bytes:
    """A GGUF v3 with real metadata and a tensor table; tensor data is zeros.

    Tensors are laid out in the order given, each padded to the alignment, so
    each one's size as the parser sees it is its byte count rounded up.
    """
    align = alignment or kb.DEFAULT_ALIGNMENT
    kv = [
        _s("general.architecture") + struct.pack("<I", kb.T_STRING) + _s(arch),
        _s(f"{arch}.block_count") + struct.pack("<II", kb.T_U32, block_count),
        _s("tokenizer.ggml.tokens")
        + struct.pack("<IIQ", kb.T_ARRAY, kb.T_STRING, n_vocab)
        + b"".join(_s(f"t{i}") for i in range(n_vocab)),
        # A key the parser must skip without understanding it.
        _s("general.name") + struct.pack("<I", kb.T_STRING) + _s("synthetic"),
    ]
    if alignment is not None:
        kv.append(_s("general.alignment") + struct.pack("<II", kb.T_U32, alignment))

    infos, offset = [], 0
    for name, nbytes in tensors:
        infos.append(_s(name) + struct.pack("<I", 1) + struct.pack("<Q", nbytes)
                     + struct.pack("<I", 0) + struct.pack("<Q", offset))
        offset += -(-nbytes // align) * align

    head = b"GGUF" + struct.pack("<IQQ", 3, len(tensors), len(kv)) + b"".join(kv) + b"".join(infos)
    head += b"\0" * ((-len(head)) % align)
    return head + b"\0" * offset


def model_from(blob: bytes) -> kb.Model:
    return read_model(io.BytesIO(blob), len(blob))


# A three-block model with an MTP-style extra block, so n_layer_all = 4.
TENSORS = [
    ("token_embd.weight", 1024),
    ("blk.0.attn.weight", 96),
    ("blk.1.attn.weight", 160),
    ("blk.2.attn.weight", 224),
    ("blk.3.nextn.weight", 288),
    ("output_norm.weight", 32),
    ("output.weight", 512),
]


@pytest.fixture
def model() -> kb.Model:
    return model_from(build_gguf(TENSORS, block_count=4))


# --- parsing ------------------------------------------------------------------


def test_reads_metadata(model):
    assert model.arch == "qwen35"
    assert model.block_count == 4
    assert model.n_vocab == 8
    assert len(model.tensors) == len(TENSORS)


def test_sizes_are_offset_deltas(model):
    sizes = {t.name: t.nbytes for t in model.tensors}
    assert sizes == dict(TENSORS)


def test_padding_is_counted_with_the_tensor_before_it():
    m = model_from(build_gguf([("token_embd.weight", 33), ("output.weight", 40)], block_count=1))
    sizes = {t.name: t.nbytes for t in m.tensors}
    assert sizes == {"token_embd.weight": 64, "output.weight": 64}


def test_honours_general_alignment():
    blob = build_gguf([("token_embd.weight", 10), ("output.weight", 10)], block_count=1, alignment=64)
    sizes = {t.name: t.nbytes for t in model_from(blob).tensors}
    assert sizes == {"token_embd.weight": 64, "output.weight": 64}


def test_rejects_non_gguf():
    with pytest.raises(ValueError, match="magic"):
        read_model(io.BytesIO(b"GGML" + b"\0" * 64), 68)


def test_missing_block_count_is_an_error_not_a_zero():
    blob = build_gguf(TENSORS, block_count=4).replace(b"qwen35.block_count", b"qwen35.block_cnt__")
    with pytest.raises(ValueError, match="block_count"):
        model_from(blob)


# --- the placement rule ----------------------------------------------------------


def test_rule_full_offload_puts_every_layer_and_output_on_gpu():
    assert all(layer_on_gpu(il, 65, 999) for il in range(66))


def test_rule_zero_ngl_keeps_everything_on_cpu():
    assert not any(layer_on_gpu(il, 65, 0) for il in range(66))


def test_rule_ngl_counts_from_the_top_and_includes_output():
    """-ngl 1 offloads only the output layer; -ngl 2 adds the last block."""
    assert [il for il in range(66) if layer_on_gpu(il, 65, 1)] == [65]
    assert [il for il in range(66) if layer_on_gpu(il, 65, 2)] == [64, 65]


def test_rule_matches_the_qwen38_worked_example():
    """The docstring's -ngl 40 example: blk.0..25 on the host."""
    host = [il for il in range(65) if not layer_on_gpu(il, 65, 40)]
    assert host == list(range(26))


def test_full_offload_leaves_only_input_on_host(model):
    p = place(model, 999)
    assert p.host_bytes == 1024
    assert p.gpu_bytes == model.total_bytes - 1024
    assert p.host_blocks == ()
    assert p.output_on_gpu


def test_partial_offload(model):
    p = place(model, 3)  # GPU: blk.2, blk.3, output
    assert p.host_blocks == (0, 1)
    assert p.host_bytes == 1024 + 96 + 160
    assert p.gpu_bytes == 224 + 288 + 32 + 512


def test_negative_control_block_index_matters(model):
    """The rule must FAIL to confuse blocks: swapping which block is big must move bytes."""
    swapped = [(n, {96: 288, 288: 96}.get(b, b)) for n, b in TENSORS]
    other = model_from(build_gguf(swapped, block_count=4))
    assert place(other, 3).host_bytes != place(model_from(build_gguf(TENSORS, 4)), 3).host_bytes


def test_unknown_tensor_is_counted_on_host_and_named():
    m = model_from(build_gguf(TENSORS + [("rope_freqs.weight", 64)], block_count=4))
    p = place(m, 999)
    assert p.unplaced == ("rope_freqs.weight",)
    assert p.host_bytes == 1024 + 64


def test_max_ngl_for_vram(model):
    full = place(model, 999).gpu_bytes
    assert max_ngl_for_vram(model, full) == model.block_count + 1
    assert max_ngl_for_vram(model, 544) == 1  # output layer alone
    assert max_ngl_for_vram(model, 0) == 0


# --- logits buffers --------------------------------------------------------------


def test_logits_buffers_match_kld_run_formula():
    """Same expression as kld-run.sh's preflight, at the real vocab."""
    n_ctx, n_vocab = 4096, 248320
    nv = 2 * ((n_vocab + 1) // 2) + 4
    assert logits_buffers_bytes(n_ctx, n_vocab) == (n_ctx // 2) * n_vocab * 4 + n_ctx * nv * 2
    assert logits_buffers_bytes(n_ctx, n_vocab) // MIB == 3880


# --- the CLI -------------------------------------------------------------------


def test_cli_reports_json(tmp_path, capsys):
    path = tmp_path / "m.gguf"
    path.write_bytes(build_gguf(TENSORS, block_count=4))
    assert kb.main([str(path), "--ngl", "3", "--n-ctx", "4096", "--vram-mib", "1"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["block_count"] == 4
    assert out["host_blocks"] == 2
    assert out["host_total_mib"] == out["host_weights_mib"] + out["logits_buffers_mib"]
    assert out["max_ngl_for_vram"] == model_from(path.read_bytes()).block_count + 1


def test_cli_error_is_json_and_nonzero(tmp_path, capsys):
    path = tmp_path / "bad.gguf"
    path.write_bytes(b"nope")
    assert kb.main([str(path)]) == 1
    assert "error" in json.loads(capsys.readouterr().out)
