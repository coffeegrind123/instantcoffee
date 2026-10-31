#!/usr/bin/env python3
"""Validate the models.json / settings.json pi-local.sh generates against the
schemas the installed pi publishes (pi >= 1.2 ships them in its package).

    python3 validate_pi_config.py <pi-coding-agent/schemas> <agent dir>

Zero errors means every key the launcher writes is still one pi knows.
"""
import json
import sys

import jsonschema

schemas, agent = sys.argv[1], sys.argv[2]
for name in ("models", "settings"):
    with open(f"{schemas}/{name}.schema.json") as fh:
        schema = json.load(fh)
    with open(f"{agent}/{name}.json") as fh:
        doc = json.load(fh)
    cls = jsonschema.Draft202012Validator if "2020-12" in schema.get("$schema", "") else jsonschema.Draft7Validator
    errors = sorted(cls(schema).iter_errors(doc), key=lambda e: list(e.path))
    print(f"{name}.json errors: {len(errors)}")
    for e in errors[:10]:
        print("  ", list(e.path), e.message[:200])
