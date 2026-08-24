#!/usr/bin/env python3
"""Build the filler-prefixed corpora for the rotation-matched depth probe.

WHAT THIS IS FOR. `llama-perplexity`'s default mode scores chunk `i` over
absolute token offsets [n_ctx/2 + 1, n_ctx - 1] — the whole top half — and a
token's history is exactly its offset in the chunk. Changing n_ctx therefore
changes BOTH the amount of history and WHICH tokens get scored, which is the
confound that makes kv-cache-fidelity-measured.md §3d unreadable.

Prefixing the corpus with exactly n_ctx/2 tokens of filler shifts every corpus
token by half a chunk, so the pass scores the EXACT COMPLEMENT of the unshifted
pass. Run both and the union is the whole corpus at every depth — the same token
set at 2048, 4096 and 8192, with mean history N/2. That is the comparison §3d
could not make.

THE FILLER TOKEN COUNT MUST BE EXACT. Off by one and the two rotations are no
longer complementary: they overlap on one position per chunk and miss another.
So this does not estimate — it calibrates against the server's own tokenizer and
refuses if it cannot land on the target exactly.

TWO TOKENIZERS, AND THEY DISAGREE ON THE CORPUS. llama-server's /tokenize parses
control tokens; llama-perplexity calls common_tokenize(ctx, prompt, true) whose
fourth parameter parse_special defaults to false, so `<|im_start|>` arrives as
six ordinary pieces instead of one token. On this corpus that is +613 tokens,
+0.88%. It does NOT affect the filler, which is plain ASCII with no control-token
spelling in it (asserted below) — but it does mean the count this script writes
into the manifest is a PREDICTION about perplexity, and ppl-depth-run.sh checks
it against perplexity's own error path before scoring anything.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from probe_lib import TokenCounter, VOCAB  # noqa: E402

# The separator between filler and corpus. A run of newlines is its own
# pretoken under this BPE's regex, so it cannot merge into the corpus's first
# piece — but "cannot" is a prediction about a tokenizer we do not own, so
# additivity across this junction is MEASURED below and again by the run script
# against perplexity's own counter.
SEP = "\n\n"

# Pad words, cheapest first. The exact-landing loop needs at least one candidate
# that costs a single token; the longer ones let it close a multi-token gap in
# one step instead of failing.
#
# NO LEADING SPACES. render() joins with " ", so " a" would arrive as "  a" and
# tokenize to TWO tokens (220 then 264) instead of one — measured, after the
# first version of this list deadlocked the calibrator at 2047 of 2048 with
# every candidate overshooting by exactly the space it brought with it.
PAD_POOL = ["a", "to", "of", "and", "with", "harbor", "tessellate"]


def gen_words(n: int, seed: int) -> list[str]:
    """Varied filler words. NOT one repeated phrase.

    Repetition would give the model an almost free prediction and make the
    filler chunks' perplexity meaningless — and those chunks are the ones the
    control reads. probe_lib.filler() has the same shape; this returns a LIST
    because the calibrator has to add and remove individual words.
    """
    rng = random.Random(seed)
    out = []
    for i in range(n):
        out.append(f"{rng.choice(VOCAB)}{i % 97}")
        if i % 24 == 23:
            out.append("\n")
    return out


def render(words: list[str]) -> str:
    return " ".join(words) + SEP


def build_prefix(count: TokenCounter, target: int, seed: int,
                 verbose: bool = True) -> tuple[str, int]:
    """A string that tokenizes to EXACTLY `target` tokens, ending in SEP.

    Bisect to the largest word count that does not overshoot, then close the
    remainder one pad word at a time. Bisection alone cannot land exactly: a
    filler word like "ledger42" is three tokens, so consecutive word counts step
    the total by more than one.
    """
    if target <= 0:
        raise ValueError(f"target must be positive, got {target}")

    floor_n = count(render([]))
    if floor_n > target:
        raise ValueError(
            f"the separator alone is {floor_n} tokens, more than the {target} "
            f"asked for")

    # Bracket. Sample the rate rather than assuming one — the 1.35 words/token
    # constant that this repo's first document builder used overshot by 5x.
    sample = 200
    per_word = (count(render(gen_words(sample, seed))) - floor_n) / float(sample)
    hi = max(1, int(target / max(per_word, 0.1)) * 2)
    pool = gen_words(hi + 16, seed)
    while count(render(pool[:hi])) <= target and hi < len(pool):
        hi = min(len(pool), hi * 2)

    lo = 0
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if count(render(pool[:mid])) <= target:
            lo = mid
        else:
            hi = mid - 1
    words = list(pool[:lo])
    have = count(render(words))
    if verbose:
        print(f"    bisect        {lo} words -> {have} tokens "
              f"({target - have} short of {target})")

    # Close the gap. Each iteration must strictly increase the count or this
    # would spin; the assertion below is what turns a silent hang into an error.
    guard = 0
    while have < target:
        guard += 1
        if guard > 4 * (target + 1):
            raise RuntimeError("pad loop is not converging")
        placed = False
        for cand in PAD_POOL:
            words.append(cand)
            got = count(render(words))
            if got <= target and got > have:
                have = got
                placed = True
                break
            words.pop()
        if not placed:
            # Nothing fits in the gap that is left. Give the loop room by
            # dropping the last word — a multi-token filler word — and let the
            # single-token pads re-close it. Without this the calibrator can
            # dead-end one token short of an otherwise reachable target.
            if not words:
                raise RuntimeError(
                    f"stuck at {have}/{target} tokens with nothing to give back")
            words.pop()
            have = count(render(words))

    text = render(words)
    final = count(text)
    if final != target:
        raise RuntimeError(f"landed on {final}, wanted {target}")
    if "<|" in text:
        raise RuntimeError("filler contains a control-token spelling")
    if verbose:
        print(f"    exact         {len(words)} words -> {final} tokens")
    return text, len(words)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True,
                    help="the corpus to prefix, as the container sees it")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--llama-url", default=os.environ.get("LLAMA_URL", "http://llama:8080"))
    ap.add_argument("--filler-tokens", default="1024,2048,4096",
                    help="comma-separated exact filler sizes to build")
    ap.add_argument("--seed", type=int, default=20260824)
    ap.add_argument("--manifest", default=None,
                    help="where to write the manifest (default: OUT_DIR/manifest.json)")
    args = ap.parse_args()

    targets = [int(x) for x in args.filler_tokens.split(",") if x.strip()]
    if not targets:
        return _die("--filler-tokens is empty")

    corpus = open(args.corpus, encoding="utf-8").read()
    count = TokenCounter(args.llama_url)

    print(f"==> corpus  {args.corpus}")
    n_corpus = count(corpus)
    print(f"    {len(corpus)} bytes, {n_corpus} tokens through /tokenize "
          f"(control tokens PARSED — perplexity will report more)")

    os.makedirs(args.out_dir, exist_ok=True)
    base = os.path.basename(args.corpus)
    stem = base[:-4] if base.endswith(".txt") else base

    entries = []
    for target in targets:
        print(f"==> filler  {target} tokens")
        prefix, n_words = build_prefix(count, target, args.seed)

        # THE JUNCTION, MEASURED. If the last filler piece merged with the
        # corpus's first, the prefix would not be `target` tokens long inside the
        # concatenation even though it is on its own, and every chunk boundary
        # would be off by one with nothing to say so.
        joined = prefix + corpus
        n_joined = count(joined)
        additive = (n_joined == target + n_corpus)
        print(f"    junction      {n_joined} = {target} + {n_corpus}? "
              f"{'yes' if additive else 'NO — off by %+d' % (n_joined - target - n_corpus)}")
        if not additive:
            return _die("the filler/corpus junction is not additive under "
                        "/tokenize; the chunk arithmetic this probe rests on "
                        "would be wrong")

        arm_path = os.path.join(args.out_dir, f"{stem}-f{target}.txt")
        fil_path = os.path.join(args.out_dir, f"filler-{target}.txt")
        with open(arm_path, "w", encoding="utf-8") as fh:
            fh.write(joined)
        with open(fil_path, "w", encoding="utf-8") as fh:
            fh.write(prefix)
        print(f"    wrote         {arm_path}")
        entries.append({
            "filler_tokens": target,
            "filler_words": n_words,
            "arm_file": arm_path,
            "filler_file": fil_path,
            "tokenize_filler": target,
            "tokenize_joined": n_joined,
            "junction_additive": additive,
        })

    manifest = {
        "corpus": args.corpus,
        "corpus_bytes": len(corpus),
        "tokenize_corpus": n_corpus,
        "separator": SEP,
        "seed": args.seed,
        "note": ("tokenize_* are llama-server /tokenize counts with control "
                 "tokens PARSED. llama-perplexity parses none, so it will "
                 "report a larger number for anything containing the corpus. "
                 "The filler is plain ASCII and both tokenizers must agree on "
                 "it; ppl-depth-run.sh checks that against perplexity's own "
                 "error path."),
        "arms": entries,
    }
    path = args.manifest or os.path.join(args.out_dir, "manifest.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"==> manifest  {path}")
    return 0


def _die(msg: str) -> int:
    print(f"err  {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
