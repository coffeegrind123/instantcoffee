#!/usr/bin/env bash
#
# Benchmark the stack: prompt processing speed + token generation speed.
#
#   ./scripts/bench.sh                    # short benchmark
#   ./scripts/bench.sh --prompt-len 4096  # custom prompt length
#   ./scripts/bench.sh --full             # full sweep (pp 256..16384)
#
# Runs inside the compose network. Requires an active backend.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LLAMA_URL="${LLAMA_URL:-http://llama:8080}"
PROMPT_LEN=1024
FULL_SWEEP=0

for arg in "$@"; do
  case "$arg" in
    --prompt-len) PROMPT_LEN="${2:-1024}"; shift ;;
    --full)       FULL_SWEEP=1 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
  esac
done

bench_one() {
  local pp_tokens="$1"
  # Generate a prompt of roughly pp_tokens tokens using repetition with variation
  local prompt
  prompt=$(python3 -c "
import sys
words = ['function', 'def', 'class', 'return', 'import', 'data', 'process',
         'value', 'result', 'config', 'module', 'handler', 'compute',
         'validate', 'transform', 'execute', 'initialize', 'finalize',
         'error', 'success', 'request', 'response', 'argument', 'parameter']
# ~1 token per word on average for code-tuned tokenizers
n = $pp_tokens
s = ' '.join(words[i % len(words)] for i in range(n))
print(f'Write a Python script that does the following: {s}')
" 2>&1)

  local payload
  payload=$(python3 -c "
import json
print(json.dumps({
    'model': '${MODEL_ALIAS:-qwen3.6-27b}',
    'messages': [{'role': 'user', 'content': $(python3 -c "import json; print(json.dumps('$prompt'))" 2>/dev/null || echo '""')}],
    'max_tokens': 256,
    'stream': False
}))
" 2>&1)

  local started
  started=$(python3 -c "import time; print(time.time())")

  local status body
  read -r status body <<<"$(curl -s -w '\n%{http_code}' -X POST \
    "${LLAMA_URL}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>&1)"

  local elapsed
  elapsed=$(python3 -c "import time; print(f'{time.time() - $started:.2f}')")

  local comp_tokens=0 prompt_tokens=0
  if [ "$status" = "200" ]; then
    comp_tokens=$(echo "$body" | python3 -c "
import sys,json
d=json.load(sys.stdin)
u=d.get('usage',{})
print(u.get('completion_tokens',0))
" 2>/dev/null || echo 0)
    prompt_tokens=$(echo "$body" | python3 -c "
import sys,json
d=json.load(sys.stdin)
u=d.get('usage',{})
print(u.get('prompt_tokens',0))
" 2>/dev/null || echo 0)
  fi

  local pp_tps="N/A" tg_tps="N/A"
  if [ "$prompt_tokens" -gt 0 ] 2>/dev/null && [ "$comp_tokens" -gt 0 ] 2>/dev/null; then
    pp_tps=$(python3 -c "print(f'{${prompt_tokens}/${elapsed}:.0f}')" 2>/dev/null || echo N/A)
    tg_tps=$(python3 -c "print(f'{${comp_tokens}/${elapsed}:.0f}')" 2>/dev/null || echo N/A)
  fi

  printf "  pp_tokens=%-6s elapsed=%-6s pp=%-8s tg=%-8s status=%s\n" \
    "$prompt_tokens" "${elapsed}s" "${pp_tps} tok/s" "${tg_tps} tok/s" "$status"
}

info "Benchmark — prompt processing + generation speed"
echo ""

if [ "$FULL_SWEEP" -eq 1 ]; then
  for pp in 256 512 1024 2048 4096 8192 16384; do
    bench_one "$pp"
  done
else
  bench_one "$PROMPT_LEN"
fi

echo ""
info "Done. For a detailed per-layer breakdown, run:"
info "  docker compose --profile mainline run --rm llama --list-devices"
