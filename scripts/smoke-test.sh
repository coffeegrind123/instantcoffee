#!/usr/bin/env bash
# Run the end-to-end check against the running stack.
#
# When HEADROOM_ENABLED=1 the same tool-call check also runs one hop further
# out, through headroom — because that is then the path a pi session actually
# takes, and a proxy that drops the tools array looks exactly like a model that
# stopped calling tools.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker

if [[ "$(env_get HEADROOM_ENABLED)" == "1" ]]; then
  # Compose interpolation reads the shell environment, so this reaches the
  # smoketest service without being a committed key in .env.
  export HEADROOM_SMOKE_URL="http://headroom:8787"
  dim "headroom is enabled — the smoke test will check that hop too"
fi

compose --profile tools run --rm smoketest "$@"
