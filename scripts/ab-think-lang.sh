#!/usr/bin/env bash
#
# Measure the THINK_LANG system-prompt fragment before trusting it.
#
#   ./scripts/ab-think-lang.sh                  3 passes per arm (default)
#   ./scripts/ab-think-lang.sh --repeat 5       more passes, less noise
#   ./scripts/ab-think-lang.sh --lang zh        pick the fragment explicitly
#   ./scripts/ab-think-lang.sh --save           write results/think-lang-ab.json
#   ./scripts/ab-think-lang.sh -v               show reasoning-trace heads
#
# Runs the same task set twice — once with the fragment, once without — with
# thinking enabled in both arms, and reports quality, reasoning cost, and
# whether Chinese leaked out of the thinking block into output or tool
# arguments. Exit code is non-zero when the fragment should NOT be adopted.
#
# The stack must be up (./scripts/up.sh). Nothing here downloads a model.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LANG_CODE=""
SAVE=0
PASSTHRU=()

while (( $# )); do
  case "$1" in
    --lang)   LANG_CODE="${2:?--lang needs a value}"; shift 2 ;;
    --save)   SAVE=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)        PASSTHRU+=("$1"); shift ;;
  esac
done

require_cmd docker

# Default to the fragment .env selects; fall back to zh when THINK_LANG is off,
# since measuring it is the whole reason to run this before switching it on.
if [[ -z "$LANG_CODE" ]]; then
  LANG_CODE="$(env_get THINK_LANG)"
  [[ -z "$LANG_CODE" || "$LANG_CODE" == "off" ]] && LANG_CODE="zh"
fi

FRAGMENT="$REPO_ROOT/prompts/think-${LANG_CODE}.md"
[[ -r "$FRAGMENT" ]] || die "no fragment at $FRAGMENT (--lang ${LANG_CODE})"

# The eval budget is the thinking budget: with REASONING_BUDGET=0 the model
# cannot think at all, so both arms would be identical and the run would report
# a meaningless dead heat. Refuse rather than produce that number.
BUDGET="$(env_get REASONING_BUDGET)"
[[ "$BUDGET" == "0" ]] && die "REASONING_BUDGET=0 disables thinking entirely — \
there is nothing to A/B. Set it to -1 or a positive cap in .env first."

info "A/B: prompts/think-${LANG_CODE}.md vs no system prompt"
dim  "reasoning budget: ${BUDGET} tokens"

# /work/prompts is where Dockerfile.forge copies this directory.
cmd=(--profile tools run --rm ab-think-lang
     --system-prompt-file "/work/prompts/think-${LANG_CODE}.md")

if (( SAVE )); then
  mkdir -p "$REPO_ROOT/results"
fi

set +e
compose "${cmd[@]}" "${PASSTHRU[@]}" 2>&1 | tee /tmp/qwen36-ab-think-lang.txt
STATUS="${PIPESTATUS[0]}"
set -e

if (( SAVE )); then
  # The container cannot write to the repo, so the JSON block is lifted out of
  # the captured output rather than mounted back.
  python3 - "$REPO_ROOT/results/think-lang-ab.json" <<'PY' || warn "could not extract JSON — see /tmp/qwen36-ab-think-lang.txt"
import json, re, sys
text = open("/tmp/qwen36-ab-think-lang.txt", encoding="utf-8", errors="replace").read()
m = re.search(r"```json\s*\n(.*?)\n```", text, re.S)
if not m:
    raise SystemExit("no JSON block in output")
data = json.loads(m.group(1))
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
print(f"saved {sys.argv[1]}")
PY
fi

echo
if (( STATUS == 0 )); then
  ok "Fragment is safe to adopt — see the VERDICT line for whether it is worth it."
  dim "To enable it:  set THINK_LANG=${LANG_CODE} in .env"
else
  warn "Do not adopt this fragment on this model — see the VERDICT line above."
fi
exit "$STATUS"
