#!/usr/bin/env python3
"""Check a published context-ceiling claim against KV-cache arithmetic.

Why this exists
---------------
Engines and forks publish "maximum context on a 24 GB card" tables. Those tables
are cheap to fabricate and expensive to test: testing one means downloading an
artifact and binary-searching on a real GPU. But a ceiling claim is not free --
it *implies* a KV-cache size, and that size is fixed by the model's geometry,
which can be read off an engine that is already running.

So a ceiling claim can be falsified, or corroborated, without moving any bytes:

    kv_bytes(tokens) + artifact_bytes  must fit the card, and

when several ceilings are published for the same card and artifact at different
KV precisions, they must all land on *the same* residual slack. A set of claims
that agrees with itself to a fraction of a GiB is the fingerprint of one real
binary search on one machine. A set that scatters is arithmetic someone wrote
down.

Qwen3.8-27B is a hybrid: only 16 of its 64 layers carry a KV cache at all (the
other 48 are gated-delta-net layers with constant-size recurrent state). That is
the whole reason very large windows are physically possible on 24 GB, and it is
also the easiest thing to get wrong -- assuming 64 KV layers overstates the cache
by 4x and makes every real claim look like a lie.

The control
-----------
`GEOMETRY_QWEN38_27B` is not read from a spec sheet. It is read off this repo's
own running llama.cpp, which prints both the geometry and the resulting cache
size, so the model here can be checked against a number the engine computed:

    llama_kv_cache: size = 3264.00 MiB ( 98304 cells, 16 layers, 1/1 seqs),
                    K (q8_0): 1632.00 MiB, V (q8_0): 1632.00 MiB
    print_info: n_head_kv = 4
    print_info: n_embd_head_k = 256

`--control` reproduces those two figures. Run it before trusting any other
output of this script: a negative result ("the claim does not close") means
nothing until the instrument has been shown to reproduce a number known to be
right.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import sys


MIB = 1024 ** 2
GIB = 1024 ** 3


@dataclass(frozen=True, slots=True)
class KVGeometry:
    """Per-token KV shape of a model, in elements.

    `kv_layers` is the count of layers that actually hold a KV cache, NOT the
    model's layer count. For a hybrid those differ and the difference is large.
    """

    name: str
    kv_layers: int
    kv_heads: int
    head_dim: int
    total_layers: int | None = None

    @property
    def elements_per_token_per_side(self) -> int:
        """Elements of K (equivalently V) cached per token, across all layers."""
        return self.kv_layers * self.kv_heads * self.head_dim

    @property
    def elements_per_token(self) -> int:
        """Elements of K and V together, per token, across all layers."""
        return 2 * self.elements_per_token_per_side


# Read off this repo's running llama.cpp, not from a model card. See module
# docstring; `--control` re-derives the engine's own printed cache size.
GEOMETRY_QWEN38_27B = KVGeometry(
    name="qwen3.8-27b",
    kv_layers=16,
    kv_heads=4,
    head_dim=256,
    total_layers=64,
)


# Bytes per cached element, by KV format.
#
# q8_0 is a block quantisation: 32 elements share one fp16 scale, so a block is
# 32 bytes of payload plus 2 bytes of scale = 34 bytes per 32 elements. Treating
# it as a flat 1 byte/element understates the cache by 6.25% and is the single
# most common arithmetic slip in this area.
BYTES_PER_ELEMENT: dict[str, float] = {
    "f16": 2.0,
    "bf16": 2.0,
    "q8_0": 34.0 / 32.0,
    "int8": 1.0,
    "fp8": 1.0,
    "q4_0": 18.0 / 32.0,
    "int4": 0.5,
    "e8-4bit": 0.5,
    "e8-2bit": 0.25,
}


def bytes_per_token(geometry: KVGeometry, k_format: str, v_format: str) -> float:
    """Cache bytes consumed by one token, K and V together, across all layers."""
    for fmt in (k_format, v_format):
        if fmt not in BYTES_PER_ELEMENT:
            raise KeyError(
                f"unknown KV format {fmt!r}; known: {sorted(BYTES_PER_ELEMENT)}"
            )
    side = geometry.elements_per_token_per_side
    return side * BYTES_PER_ELEMENT[k_format] + side * BYTES_PER_ELEMENT[v_format]


def kv_bytes(geometry: KVGeometry, tokens: int, k_format: str, v_format: str) -> float:
    """Total KV-cache bytes for a window of `tokens`."""
    if tokens < 0:
        raise ValueError(f"tokens must be non-negative, got {tokens}")
    return tokens * bytes_per_token(geometry, k_format, v_format)


def tokens_for_budget(
    geometry: KVGeometry, budget_bytes: float, k_format: str, v_format: str
) -> float:
    """How many tokens a fixed KV budget holds at a given precision."""
    if budget_bytes < 0:
        raise ValueError(f"budget must be non-negative, got {budget_bytes}")
    return budget_bytes / bytes_per_token(geometry, k_format, v_format)


@dataclass(frozen=True, slots=True)
class CeilingClaim:
    """One published "max context" row."""

    label: str
    k_format: str
    v_format: str
    tokens: int


@dataclass(frozen=True, slots=True)
class CeilingVerdict:
    claim: CeilingClaim
    bytes_per_token: float
    kv_bytes: float
    implied_total_bytes: float
    slack_bytes: float

    @property
    def fits(self) -> bool:
        return self.slack_bytes >= 0


def check_ceilings(
    geometry: KVGeometry,
    claims: list[CeilingClaim],
    artifact_bytes: float,
    card_bytes: float,
) -> list[CeilingVerdict]:
    """Turn each ceiling claim into the memory total it implies."""
    verdicts = []
    for claim in claims:
        per_tok = bytes_per_token(geometry, claim.k_format, claim.v_format)
        cache = claim.tokens * per_tok
        total = cache + artifact_bytes
        verdicts.append(
            CeilingVerdict(
                claim=claim,
                bytes_per_token=per_tok,
                kv_bytes=cache,
                implied_total_bytes=total,
                slack_bytes=card_bytes - total,
            )
        )
    return verdicts


def slack_spread(verdicts: list[CeilingVerdict]) -> float:
    """Range of residual slack across claims.

    This is the number that matters. Several ceilings measured by binary search
    on ONE machine against ONE artifact must leave near-identical slack, because
    the thing being searched for is the same wall each time. A tight spread
    corroborates the whole table at once; a wide one says the rows were not all
    produced the same way.
    """
    if not verdicts:
        return 0.0
    slacks = [v.slack_bytes for v in verdicts]
    return max(slacks) - min(slacks)


def run_control(geometry: KVGeometry) -> tuple[float, float]:
    """Re-derive the cache size this repo's llama.cpp printed at 98,304 cells.

    Returns (K MiB, K+V MiB). The engine printed 1632.00 and 3264.00.
    """
    side = 98304 * geometry.elements_per_token_per_side * BYTES_PER_ELEMENT["q8_0"]
    return side / MIB, 2 * side / MIB


# The claim set this was written to adjudicate: UDPSendToFailed/ninfer-4090's
# published "Verified Context Ceilings Matrix" for the RTX 4090, against its
# stated 16.96 GiB groupwise artifact.
NINFER_4090_CLAIMS = [
    CeilingClaim("rk2v4-e8", "e8-2bit", "e8-4bit", 567_000),
    CeilingClaim("rk4v4-e8", "e8-4bit", "e8-4bit", 433_000),
    CeilingClaim("rk4v4", "int4", "int4", 433_000),
    CeilingClaim("rk8v4", "int8", "e8-4bit", 294_000),
    CeilingClaim("int8", "int8", "int8", 223_000),
]

NINFER_ARTIFACT_BYTES = 18_210_531_328  # HEAD on the published .ninfer, exact
RTX_4090_BYTES = 24564 * MIB  # nvidia-smi memory.total on this box


def _format_report(
    geometry: KVGeometry,
    verdicts: list[CeilingVerdict],
    artifact_bytes: float,
    card_bytes: float,
) -> str:
    lines = []
    lines.append(
        f"geometry: {geometry.name}  "
        f"{geometry.kv_layers} KV layers"
        + (f" of {geometry.total_layers}" if geometry.total_layers else "")
        + f", {geometry.kv_heads} KV heads, head_dim {geometry.head_dim}"
    )
    lines.append(
        f"          {geometry.elements_per_token} elements/token (K+V, all layers)"
    )
    lines.append(
        f"artifact: {artifact_bytes / GIB:.2f} GiB     "
        f"card: {card_bytes / GIB:.2f} GiB"
    )
    lines.append("")
    header = (
        f"{'claim':12} {'K/V':>16} {'B/token':>9} {'ceiling':>10} "
        f"{'KV GiB':>8} {'implied':>9} {'slack GiB':>10}"
    )
    lines.append(header)
    lines.append("-" * len(header))
    for v in verdicts:
        kv = f"{v.claim.k_format}/{v.claim.v_format}"
        lines.append(
            f"{v.claim.label:12} {kv:>16} {v.bytes_per_token:9.0f} "
            f"{v.claim.tokens:10,d} {v.kv_bytes / GIB:8.2f} "
            f"{v.implied_total_bytes / GIB:9.2f} {v.slack_bytes / GIB:10.2f}"
            + ("" if v.fits else "   OVER")
        )
    lines.append("")
    spread = slack_spread(verdicts)
    lines.append(f"slack spread across claims: {spread / GIB:.2f} GiB")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--control",
        action="store_true",
        help="reproduce the live engine's printed KV size and exit",
    )
    parser.add_argument(
        "--artifact-bytes",
        type=int,
        default=NINFER_ARTIFACT_BYTES,
        help="on-card weight footprint in bytes (default: the published .ninfer)",
    )
    parser.add_argument(
        "--card-bytes",
        type=int,
        default=RTX_4090_BYTES,
        help="total VRAM in bytes (default: this box's 4090, 24564 MiB)",
    )
    parser.add_argument(
        "--budget-mib",
        type=float,
        default=None,
        help="instead of ceilings, report tokens held per format at this KV budget",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON")
    args = parser.parse_args(argv)

    geometry = GEOMETRY_QWEN38_27B

    if args.control:
        k_mib, kv_mib = run_control(geometry)
        ok = abs(k_mib - 1632.00) < 0.005 and abs(kv_mib - 3264.00) < 0.005
        print(f"CONTROL  K (q8_0) @98304 cells = {k_mib:8.2f} MiB   engine: 1632.00")
        print(f"CONTROL  K+V      @98304 cells = {kv_mib:8.2f} MiB   engine: 3264.00")
        print("CONTROL  " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1

    if args.budget_mib is not None:
        budget = args.budget_mib * MIB
        rows = [
            ("q8_0", "q8_0"),
            ("int8", "int8"),
            ("e8-4bit", "e8-4bit"),
            ("e8-2bit", "e8-4bit"),
        ]
        for k_fmt, v_fmt in rows:
            n = tokens_for_budget(geometry, budget, k_fmt, v_fmt)
            print(
                f"  at {args.budget_mib:.0f} MiB of KV, "
                f"{k_fmt + '/' + v_fmt:>18} holds {n:12,.0f} tokens"
            )
        return 0

    verdicts = check_ceilings(
        geometry, NINFER_4090_CLAIMS, args.artifact_bytes, args.card_bytes
    )
    if args.json:
        print(
            json.dumps(
                {
                    "geometry": {
                        "name": geometry.name,
                        "kv_layers": geometry.kv_layers,
                        "kv_heads": geometry.kv_heads,
                        "head_dim": geometry.head_dim,
                        "elements_per_token": geometry.elements_per_token,
                    },
                    "artifact_bytes": args.artifact_bytes,
                    "card_bytes": args.card_bytes,
                    "claims": [
                        {
                            "label": v.claim.label,
                            "k_format": v.claim.k_format,
                            "v_format": v.claim.v_format,
                            "tokens": v.claim.tokens,
                            "bytes_per_token": v.bytes_per_token,
                            "kv_bytes": v.kv_bytes,
                            "implied_total_bytes": v.implied_total_bytes,
                            "slack_bytes": v.slack_bytes,
                            "fits": v.fits,
                        }
                        for v in verdicts
                    ],
                    "slack_spread_bytes": slack_spread(verdicts),
                },
                indent=2,
            )
        )
        return 0

    print(_format_report(geometry, verdicts, args.artifact_bytes, args.card_bytes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
