#!/usr/bin/env python3
"""Where a GGUF's bytes land under a given -ngl: host RAM or VRAM.

Why this exists
---------------
`kld-run.sh` measures quant damage by scoring each quant against a Q8_0
reference. The reference is ~28.6 GB and the card is 24 GiB, so its base arm
must run partially offloaded, and every layer left on the CPU is host RAM. On
this box host RAM is what kills runs: a swapping base arm has written a short
logits file and still exited 0, and a sibling script in the same state took the
Windows host down. So the preflight has to know, before llama is stopped, how
many bytes a given -ngl leaves on the host.

The answer is read from the GGUF itself, not estimated from file size / layer
count: the tensor table gives every tensor's name and data offset, so each
tensor's size is the distance to the next offset. Alignment padding (at most
`general.alignment` - 1 bytes per tensor, ~27 KB on this model) is counted with
the tensor before it, which errs towards a larger host figure.

The placement rule
------------------
Read from src/llama-model.cpp at the pinned tag (b11118), not remembered:

    const int i_gpu_start = std::max(n_layer_all + 1 - n_gpu_layers, 0);
    const int act_gpu_layers = std::min(n_gpu_layers, n_layer_all + 1);
    layer il is on the CPU if il < i_gpu_start || (il - i_gpu_start) >= act_gpu_layers
    pimpl->dev_input  = { cpu_dev, ... };            // ALWAYS the CPU
    pimpl->dev_output = get_layer_buft_list(n_layer_all);

n_layer_all is `<arch>.block_count`, which on Qwen3.8-27B is 65: 64 trunk
blocks plus the MTP block (blk.64). So with -ngl k the GPU holds blocks
[66 - k, 64] and the output layer, and `token_embd` never leaves the host.

    -ngl 999  ->  every block and the output on the GPU; token_embd on the host
    -ngl 40   ->  blk.0..blk.25 and token_embd on the host, the rest on the GPU

`--fit` does not rescue an explicit -ngl: at b11118 it "adjusts unset
arguments" only, so `-ngl 999` on a file that does not fit is not scaled down.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from dataclasses import dataclass
from typing import BinaryIO

MIB = 1024 * 1024

# GGUF metadata value types: fixed-size scalars, then STRING and ARRAY.
FIXED_SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
T_U32, T_STRING, T_ARRAY = 4, 8, 9
DEFAULT_ALIGNMENT = 32

BLOCK_RE = re.compile(r"^blk\.(\d+)\.")
# Tensors that belong to llama.cpp's OUTPUT layer (dev_output). Everything that
# is neither a block tensor, nor input, nor one of these is reported, not
# guessed at — see `place()`.
OUTPUT_TENSORS = ("output.weight", "output_norm.weight", "output.bias")
INPUT_TENSORS = ("token_embd.weight", "token_embd_norm.weight")


@dataclass(frozen=True)
class Tensor:
    name: str
    offset: int
    nbytes: int


@dataclass(frozen=True)
class Model:
    arch: str
    block_count: int
    n_vocab: int
    tensors: tuple[Tensor, ...]

    @property
    def total_bytes(self) -> int:
        return sum(t.nbytes for t in self.tensors)


@dataclass(frozen=True)
class Placement:
    ngl: int
    host_bytes: int
    gpu_bytes: int
    host_blocks: tuple[int, ...]
    output_on_gpu: bool
    unplaced: tuple[str, ...]


# --- reading ------------------------------------------------------------------


def _u32(f: BinaryIO) -> int:
    return struct.unpack("<I", f.read(4))[0]


def _u64(f: BinaryIO) -> int:
    return struct.unpack("<Q", f.read(8))[0]


def _str(f: BinaryIO) -> str:
    return f.read(_u64(f)).decode("utf-8", "replace")


def _skip(f: BinaryIO, vtype: int) -> None:
    if vtype in FIXED_SIZES:
        f.read(FIXED_SIZES[vtype])
    elif vtype == T_STRING:
        f.read(_u64(f))
    elif vtype == T_ARRAY:
        etype, n = _u32(f), _u64(f)
        if etype in FIXED_SIZES:
            f.read(FIXED_SIZES[etype] * n)
        elif etype == T_STRING:
            for _ in range(n):
                f.read(_u64(f))
        else:
            raise ValueError(f"array of metadata type {etype}")
    else:
        raise ValueError(f"metadata type {vtype}")


def read_model(f: BinaryIO, file_size: int) -> Model:
    if f.read(4) != b"GGUF":
        raise ValueError("not a GGUF file (bad magic)")
    _version = _u32(f)
    n_tensors, n_kv = _u64(f), _u64(f)

    arch = ""
    alignment = DEFAULT_ALIGNMENT
    n_vocab = 0
    counts: dict[str, int] = {}
    for _ in range(n_kv):
        key = _str(f)
        vtype = _u32(f)
        if key == "general.architecture" and vtype == T_STRING:
            arch = _str(f)
        elif key == "general.alignment" and vtype == T_U32:
            alignment = _u32(f)
        elif key == "tokenizer.ggml.tokens" and vtype == T_ARRAY:
            etype, n = _u32(f), _u64(f)
            n_vocab = n
            if etype != T_STRING:
                raise ValueError("tokenizer.ggml.tokens is not a string array")
            for _ in range(n):
                f.read(_u64(f))
        elif key.endswith(".block_count") and vtype == T_U32:
            counts[key] = _u32(f)
        else:
            _skip(f, vtype)

    raw: list[tuple[str, int]] = []
    for _ in range(n_tensors):
        name = _str(f)
        n_dims = _u32(f)
        f.read(8 * n_dims)
        _ggml_type = _u32(f)
        raw.append((name, _u64(f)))

    data_start = -(-f.tell() // alignment) * alignment
    data_len = file_size - data_start
    order = sorted(raw, key=lambda t: t[1])
    tensors = []
    for i, (name, off) in enumerate(order):
        end = order[i + 1][1] if i + 1 < len(order) else data_len
        tensors.append(Tensor(name=name, offset=off, nbytes=end - off))

    key = f"{arch}.block_count"
    if key not in counts:
        raise ValueError(f"{key} not present in the metadata")
    return Model(arch=arch, block_count=counts[key], n_vocab=n_vocab, tensors=tuple(tensors))


def load(path: str) -> Model:
    import os

    with open(path, "rb") as f:
        return read_model(f, os.fstat(f.fileno()).st_size)


# --- placement ----------------------------------------------------------------


def layer_on_gpu(il: int, n_layer_all: int, ngl: int) -> bool:
    """llama_model::load_tensors' rule, verbatim. il == n_layer_all is the output layer."""
    i_gpu_start = max(n_layer_all + 1 - ngl, 0)
    act_gpu_layers = min(ngl, n_layer_all + 1)
    return not (il < i_gpu_start or (il - i_gpu_start) >= act_gpu_layers)


def place(model: Model, ngl: int) -> Placement:
    n = model.block_count
    host = gpu = 0
    host_blocks: set[int] = set()
    unplaced: list[str] = []
    output_on_gpu = layer_on_gpu(n, n, ngl)

    for t in model.tensors:
        m = BLOCK_RE.match(t.name)
        if m:
            il = int(m.group(1))
            if layer_on_gpu(il, n, ngl):
                gpu += t.nbytes
            else:
                host += t.nbytes
                host_blocks.add(il)
        elif t.name in INPUT_TENSORS:
            host += t.nbytes
        elif t.name in OUTPUT_TENSORS:
            if output_on_gpu:
                gpu += t.nbytes
            else:
                host += t.nbytes
        else:
            # Counted on the HOST, which is the side a wrong guess costs least
            # on, and named so a new tensor class shows up instead of hiding.
            host += t.nbytes
            unplaced.append(t.name)

    return Placement(
        ngl=ngl,
        host_bytes=host,
        gpu_bytes=gpu,
        host_blocks=tuple(sorted(host_blocks)),
        output_on_gpu=output_on_gpu,
        unplaced=tuple(unplaced),
    )


def max_ngl_for_vram(model: Model, vram_budget_bytes: int) -> int:
    """The largest -ngl whose GPU-resident weights fit the budget (0 if none)."""
    best = 0
    for ngl in range(0, model.block_count + 2):
        if place(model, ngl).gpu_bytes <= vram_budget_bytes:
            best = ngl
    return best


def logits_buffers_bytes(n_ctx: int, n_vocab: int) -> int:
    """The base arm's two n_vocab-sized buffers, as kld-run.sh's preflight sizes them.

    logits:    (n_ctx/2) * n_vocab * 4   (only the scored half is ever written)
    log_probs: n_ctx * nv * 2, nv = 2*((n_vocab+1)/2)+4   (resize() faults it all in)
    """
    nv = 2 * ((n_vocab + 1) // 2) + 4
    return (n_ctx // 2) * n_vocab * 4 + n_ctx * nv * 2


# --- entry point --------------------------------------------------------------


def report(model: Model, ngl: int, n_ctx: int | None) -> dict:
    p = place(model, ngl)
    out = {
        "arch": model.arch,
        "block_count": model.block_count,
        "n_vocab": model.n_vocab,
        "total_mib": model.total_bytes // MIB,
        "ngl": ngl,
        "host_weights_mib": p.host_bytes // MIB,
        "gpu_weights_mib": p.gpu_bytes // MIB,
        "host_blocks": len(p.host_blocks),
        "output_on_gpu": p.output_on_gpu,
        "unplaced": list(p.unplaced),
    }
    if n_ctx:
        out["logits_buffers_mib"] = logits_buffers_bytes(n_ctx, model.n_vocab) // MIB
        out["host_total_mib"] = out["host_weights_mib"] + out["logits_buffers_mib"]
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("gguf")
    ap.add_argument("--ngl", type=int, default=999)
    ap.add_argument("--n-ctx", type=int, default=0, help="add the base arm's logits buffers")
    ap.add_argument("--vram-mib", type=int, default=0,
                    help="also print the largest -ngl whose weights fit this many MiB")
    args = ap.parse_args(argv)

    try:
        model = load(args.gguf)
    except (OSError, ValueError, struct.error) as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 1

    out = report(model, args.ngl, args.n_ctx or None)
    if args.vram_mib:
        out["max_ngl_for_vram"] = max_ngl_for_vram(model, args.vram_mib * MIB)
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
