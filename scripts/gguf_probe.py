#!/usr/bin/env python3
"""Read a GGUF's header off the Hub, without downloading the weights.

The three questions modes/prose.env says to ask BEFORE selecting a model, after
the OBLITERATUS source GGUF passed every card claim and then failed the smoke
test on a stripped chat template:

  1. chat template — length, and whether it supports tools / tool_call /
     reasoning_effort / thinking. A 506-char bare im_start loop kills native
     function calling and makes --chat-template-kwargs a no-op.
  2. MTP — abliteration re-saves through transformers, which silently drops the
     MTP head while config.json still advertises it. Wants block_count=65,
     nextn_predict_layers=1, and blk.<n>.nextn.* tensors present.
  3. size — against the VRAM headroom the 96K config leaves.

Usage: gguf_probe.py <repo> <file> [<repo> <file> ...]
"""
import json, pathlib, struct, sys, urllib.request

# GGUF metadata value types.
U8, I8, U16, I16, U32, I32, F32, BOOL, STR, ARR, U64, I64, F64 = range(13)
FIXED = {U8: 1, I8: 1, U16: 2, I16: 2, U32: 4, I32: 4, F32: 4, BOOL: 1,
         U64: 8, I64: 8, F64: 8}


class Buf:
    def __init__(self, data): self.d, self.o = data, 0
    def need(self, n):
        if self.o + n > len(self.d):
            raise EOFError(f"need {n} at {self.o}, have {len(self.d)}")
    def raw(self, n):
        self.need(n); v = self.d[self.o:self.o + n]; self.o += n; return v
    def u32(self): return struct.unpack_from("<I", self.raw(4))[0]
    def u64(self): return struct.unpack_from("<Q", self.raw(8))[0]
    def string(self):
        return self.raw(self.u64()).decode("utf-8", "replace")
    def value(self, t):
        if t == STR:
            return self.string()
        if t in FIXED:
            b = self.raw(FIXED[t])
            if t == BOOL: return b[0] != 0
            fmt = {U8: "<B", I8: "<b", U16: "<H", I16: "<h", U32: "<I",
                   I32: "<i", F32: "<f", U64: "<Q", I64: "<q", F64: "<d"}[t]
            return struct.unpack_from(fmt, b)[0]
        if t == ARR:
            et, n = self.u32(), self.u64()
            if et in FIXED:                       # skip bulk, keep the count
                self.raw(FIXED[et] * n); return f"<{n} x type{et}>"
            if et == STR:                          # 151k tokens — skip, don't build
                for _ in range(n): self.raw(self.u64())
                return f"<{n} strings>"
            raise ValueError(f"array of type {et}")
        raise ValueError(f"value type {t}")


def _token():
    """Gated repos need one. Read from the HF cache; never logged."""
    import os
    t = os.environ.get("HF_TOKEN")
    if t: return t.strip()
    f = pathlib.Path.home() / ".cache" / "huggingface" / "token"
    return f.read_text().strip() if f.is_file() else None


def fetch(repo, name, nbytes):
    url = f"https://huggingface.co/{repo}/resolve/main/{name}"
    headers = {"Range": f"bytes=0-{nbytes - 1}", "User-Agent": "gguf-probe"}
    tok = _token()
    if tok: headers["Authorization"] = f"Bearer {tok}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=180) as r:
        total = None
        cr = r.headers.get("Content-Range")
        if cr and "/" in cr:
            try: total = int(cr.rsplit("/", 1)[1])
            except ValueError: pass
        return r.read(), total


def probe(repo, name, nbytes=48 << 20):
    data, total = fetch(repo, name, nbytes)
    b = Buf(data)
    if b.raw(4) != b"GGUF":
        return {"error": "not a GGUF (bad magic)"}
    version, n_tensors, n_kv = b.u32(), b.u64(), b.u64()
    kv = {}
    for _ in range(n_kv):
        k = b.string()
        kv[k] = b.value(b.u32())
    names = []
    try:
        for _ in range(n_tensors):
            names.append(b.string())
            nd = b.u32()
            b.raw(8 * nd); b.u32(); b.u64()
    except EOFError:
        names.append("<truncated>")
    tmpl = kv.get("tokenizer.chat_template") or ""
    nextn = sorted({n for n in names if ".nextn." in n})
    arch = kv.get("general.architecture", "?")
    return {
        "size": total, "version": version, "tensors": n_tensors, "arch": arch,
        "block_count": kv.get(f"{arch}.block_count"),
        "nextn_predict_layers": kv.get(f"{arch}.nextn_predict_layers"),
        "template_chars": len(tmpl),
        "tools": "tools" in tmpl,
        "tool_call": "tool_call" in tmpl,
        "reasoning_effort": "reasoning_effort" in tmpl,
        "thinking": "thinking" in tmpl,
        "nextn_tensors": len(nextn),
        "nextn_sample": nextn[:4],
    }


if __name__ == "__main__":
    args = sys.argv[1:]
    for repo, name in zip(args[::2], args[1::2]):
        print(f"\n=== {repo}\n    {name}")
        try:
            r = probe(repo, name)
        except Exception as e:
            print(f"    FAILED: {e!r}"); continue
        if "error" in r:
            print(f"    {r['error']}"); continue
        gb = r["size"] / 1e9 if r["size"] else 0
        print(f"    size            {r['size']:,} B ({gb:.2f} GB)")
        print(f"    arch            {r['arch']}  tensors={r['tensors']}  "
              f"block_count={r['block_count']}  nextn_predict_layers={r['nextn_predict_layers']}")
        print(f"    chat template   {r['template_chars']} chars   "
              f"tools={'T' if r['tools'] else 'F'} "
              f"tool_call={'T' if r['tool_call'] else 'F'} "
              f"reasoning_effort={'T' if r['reasoning_effort'] else 'F'} "
              f"thinking={'T' if r['thinking'] else 'F'}")
        print(f"    MTP tensors     {r['nextn_tensors']}  {r['nextn_sample']}")
