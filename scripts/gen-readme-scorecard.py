#!/usr/bin/env python3
"""
Generate the eval scorecard markdown block for the README.

Reads results/latest.json (if it exists) and produces the scorecard table.
Also generates shield.io badge JSON files for CI and eval status.

Usage:
    python3 scripts/gen-readme-scorecard.py           # print scorecard to stdout
    python3 scripts/gen-readme-scorecard.py --write    # update README.md in-place
    python3 scripts/gen-readme-scorecard.py --badges   # write badge JSON files
    python3 scripts/gen-readme-scorecard.py --all      # do everything
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS_FILE = REPO_ROOT / "results" / "latest.json"
README_FILE = REPO_ROOT / "README.md"
BADGES_DIR = REPO_ROOT / "badges"

# Marker comments in README that bracket the scorecard section.
# Everything between them is replaced on --write.
MARKER_START = "<!-- eval-scorecard-start -->"
MARKER_END = "<!-- eval-scorecard-end -->"


def _score_bar(score: float, width: int = 20) -> str:
    filled = int(score * width)
    return "█" * filled + "░" * (width - filled)


def _score_color(score: float) -> str:
    if score >= 0.9: return "brightgreen"
    if score >= 0.7: return "green"
    if score >= 0.5: return "yellow"
    if score >= 0.3: return "orange"
    return "red"


def _badge_json(label: str, message: str, color: str, logo: str = "") -> dict:
    b: dict = {
        "schemaVersion": 1,
        "label": label,
        "message": message,
        "color": color,
        "style": "flat",
    }
    if logo:
        b["namedLogo"] = logo
    return b


def generate_scorecard(data: dict) -> str:
    """Return the full scorecard markdown block."""
    lines = []
    overall = data.get("overall", {})
    suites = data.get("suites", {})

    # Overall summary line with shield.io badge
    score = overall.get("score", 0)
    pct = int(round(score * 100))
    color = _score_color(score)
    badge_url = (
        f"https://img.shields.io/badge/eval-{pct}%25%20"
        f"({overall.get('passed',0)}%2F{overall.get('total',0)})-{color}"
        f"?logo=pytest&style=flat"
    )
    lines.append(f"![Eval]({badge_url})")
    lines.append("")
    lines.append(
        f"**Latest eval:** {score:.0%} — "
        f"{overall.get('passed', 0)}/{overall.get('total', 0)} tests pass "
        f"(floor: {os.environ.get('EVAL_SCORE_FLOOR', '0.5')})"
    )
    lines.append("")

    if not suites or all(
        all(t.get("detail") == "pending" for t in s.get("tests", []))
        for s in suites.values()
    ):
        lines.append("_No eval results yet. Run `./scripts/run-eval.sh` after starting the stack "
                      "with Qwen3.6-27B loaded._")
        return "\n".join(lines)

    # Per-suite table
    lines.append("| Suite | Score | Passed | Bar |")
    lines.append("| --- | --- | --- | --- |")
    for name in sorted(suites):
        s = suites[name]
        bar = _score_bar(s.get("score", 0))
        lines.append(
            f"| {name} | [{bar}] {s['score']:.2f} | "
            f"{s['passed']}/{s['total']} | "
            f"![]({_badge_url_for(suites, name)}) |"
        )
    lines.append("")
    return "\n".join(lines)


def _badge_url_for(suites: dict, name: str) -> str:
    s = suites[name]
    score = s.get("score", 0)
    color = _score_color(score)
    return (
        f"https://img.shields.io/badge/"
        f"{name}-{score:.0%}-{color}?style=flat-square"
    )


def update_readme(scorecard: str, data: dict) -> bool:
    """Replace the scorecard section in README.md. Returns True on success."""
    try:
        readme = README_FILE.read_text("utf-8")
    except FileNotFoundError:
        print(f"ERROR: README not found at {README_FILE}", file=sys.stderr)
        return False

    start = readme.find(MARKER_START)
    end = readme.find(MARKER_END)

    if start == -1 or end == -1:
        print("ERROR: README missing scorecard markers. Add these comments:", file=sys.stderr)
        print(f"  {MARKER_START}", file=sys.stderr)
        print(f"  {MARKER_END}", file=sys.stderr)
        return False

    # Also update the top-of-README eval badge to match
    overall = data.get("overall", {})
    score = overall.get("score", 0)
    pct = int(round(score * 100))
    passed = overall.get("passed", 0)
    total = overall.get("total", 0)
    color = _score_color(score)
    badge_url = (
        f"https://img.shields.io/badge/"
        f"eval-{pct}%25%20({passed}%2F{total})-{color}"
        f"?logo=pytest&style=flat"
    )
    readme = re.sub(
        r'\[!\[Eval\]\(https://img\.shields\.io/badge/eval-[^\[\]]+\)\]',
        f'[![Eval]({badge_url})]',
        readme, count=1,
    )

    new_section = f"{MARKER_START}\n\n{scorecard}\n\n{MARKER_END}"
    updated = readme[:start] + new_section + readme[end + len(MARKER_END):]
    README_FILE.write_text(updated, "utf-8")
    print(f"README updated ({len(scorecard)} chars scorecard)")
    return True


def write_badges(data: dict) -> None:
    """Write shield.io endpoint JSON files to badges/."""
    BADGES_DIR.mkdir(parents=True, exist_ok=True)
    overall = data.get("overall", {})
    suites = data.get("suites", {})

    # CI badge
    (BADGES_DIR / "ci.json").write_text(
        json.dumps(_badge_json("ci", "passing", "brightgreen", "githubactions"),
                   indent=2), "utf-8")

    # Eval overall badge
    score = overall.get("score", 0)
    (BADGES_DIR / "eval.json").write_text(
        json.dumps(_badge_json(
            "eval", f"{score:.0%} ({overall.get('passed',0)}/{overall.get('total',0)})",
            _score_color(score), "pytest"), indent=2), "utf-8")

    # Per-suite badges
    for name, s in suites.items():
        (BADGES_DIR / f"suite-{name}.json").write_text(
            json.dumps(_badge_json(
                name, f"{s['score']:.0%}", _score_color(s['score'])),
                       indent=2), "utf-8")

    print(f"Badges written to {BADGES_DIR}/ ({len(suites) + 2} files)")


def _ensure_markers() -> None:
    """If the README exists and has no markers, append the section skeleton."""
    try:
        readme = README_FILE.read_text("utf-8")
    except FileNotFoundError:
        return

    if MARKER_START in readme:
        return  # Markers already present

    skeleton = f"""

## Eval Results

{MARKER_START}

_Run `./scripts/run-eval.sh` with the stack running to populate results._

{MARKER_END}
"""
    README_FILE.write_text(readme.rstrip() + skeleton + "\n", "utf-8")
    print(f"Scorecard markers added to README (run eval to populate)")


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="update README.md")
    ap.add_argument("--badges", action="store_true", help="write badge JSON files")
    ap.add_argument("--all", action="store_true", help="--write + --badges")
    ap.add_argument("--init", action="store_true", help="add markers to README if missing")
    args = ap.parse_args()

    if args.init:
        _ensure_markers()
        return 0

    if args.all:
        args.write = args.badges = True

    # Load results (or produce empty skeleton)
    try:
        data = json.loads(RESULTS_FILE.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        data = {"overall": {"score": 0, "passed": 0, "total": 0}, "suites": {}}

    scorecard = generate_scorecard(data)
    print(scorecard)

    ok = True
    if args.write:
        ok = update_readme(scorecard, data) and ok
    if args.badges:
        write_badges(data)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
