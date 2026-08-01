#!/usr/bin/env bash
#
# Run the full coding evaluation against a live stack and record results.
#
#   ./scripts/run-eval.sh              # run eval, save to results/latest.json
#   ./scripts/run-eval.sh --history    # also append to results/history.jsonl
#   ./scripts/run-eval.sh --badge      # also regenerate results badge
#
# The eval needs the stack to be running (./scripts/up.sh first).
# Results land in results/latest.json, which is COMMITTED so the README
# can display them.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HISTORY=0
BADGE=0

for arg in "$@"; do
  case "$arg" in
    --history) HISTORY=1 ;;
    --badge)   BADGE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

RESULTS_DIR="$REPO_ROOT/results"
mkdir -p "$RESULTS_DIR" "$REPO_ROOT/badges"

info "Running coding evaluation..."

# Run eval inside the compose network. Exit code is non-zero on failures.
set +e
compose --profile tools run --rm eval 2>&1 | tee /tmp/qwen36-eval-output.txt
EVAL_EXIT="${PIPESTATUS[0]}"
set -e

# Extract the JSON block from the output (it's wrapped in ```json ... ```)
python3 -c "
import re, sys, json
text = open('/tmp/qwen36-eval-output.txt').read()
m = re.search(r'\`\`\`json\s*\n(.*?)\n\`\`\`', text, re.S)
if m:
    data = json.loads(m.group(1))
    with open('$RESULTS_DIR/latest.json', 'w') as f:
        json.dump(data, f, indent=2)
    print('Results saved to results/latest.json')
else:
    # Fallback: try to find any JSON object with 'overall' key
    for m in re.finditer(r'\{[^}]+\}', text):
        try:
            data = json.loads(m.group(0))
            if 'overall' in data:
                with open('$RESULTS_DIR/latest.json', 'w') as f:
                    json.dump(data, f, indent=2)
                print('Results saved to results/latest.json (fallback parse)')
                break
        except json.JSONDecodeError:
            continue
    else:
        print('ERROR: could not extract JSON results from eval output')
        sys.exit(1)
" 2>&1 || { warn "Failed to parse eval output — see /tmp/qwen36-eval-output.txt"; exit 1; }

# Optionally append to history
if (( HISTORY )); then
  python3 -c "
import json, time
record = json.load(open('$RESULTS_DIR/latest.json'))
record['_timestamp'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
with open('$RESULTS_DIR/history.jsonl', 'a') as f:
    f.write(json.dumps(record) + '\n')
print('Appended to results/history.jsonl')
"
fi

# Optionally regenerate the results badge
if (( BADGE )); then
  python3 -c "
import json
data = json.load(open('$RESULTS_DIR/latest.json'))
score = data['overall']['score']
passed = data['overall']['passed']
total = data['overall']['total']
if score >= 0.9:   color = 'brightgreen'
elif score >= 0.7: color = 'green'
elif score >= 0.5: color = 'yellow'
elif score >= 0.3: color = 'orange'
else:              color = 'red'
badge = {
    'schemaVersion': 1,
    'label': 'eval',
    'message': f'{score:.0%} ({passed}/{total})',
    'color': color,
    'namedLogo': 'pytest',
    'style': 'flat'
}
import os
os.makedirs('$REPO_ROOT/badges', exist_ok=True)
with open('$REPO_ROOT/badges/eval.json', 'w') as f:
    json.dump(badge, f, indent=2)
print(f'Badge: {score:.0%} [{color}]')
"
fi

# Report
python3 -c "
import json
data = json.load(open('$RESULTS_DIR/latest.json'))
o = data['overall']
print()
print(f\"Overall: {o['score']:.2f}  ({o['passed']}/{o['total']} passed)\")
for name, s in sorted(data['suites'].items()):
    bar = '█' * int(s['score'] * 20) + '░' * (20 - int(s['score'] * 20))
    print(f\"  {name:20s} [{bar}] {s['score']:.2f}  ({s['passed']}/{s['total']})\")
"

info "Results: $RESULTS_DIR/latest.json"
(( EVAL_EXIT )) && warn "Some eval suites scored below the floor." || ok "All eval suites passed."
exit $EVAL_EXIT
