// Tests for the fork's filtering gate.
//
//   node --experimental-strip-types --test tests/*.test.ts   (from vendor/rtk-pi)
//
// scripts/rtk.sh --check verifies the other half of the contract — that the rtk
// BINARY still behaves the way the allow-list assumes. This file covers the half
// that lives here: which commands are handed to it at all, and what is accepted
// back. Both halves have to hold; neither implies the other.
//
// The cases below are the two real defects the fork exists for, plus the shell
// forms that make a shorter answer a wrong one. They are written as commands,
// not as regex assertions, because the regexes are an implementation detail and
// the commands are the contract.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractRewrite, isAllowed, shouldFilter } from "../src/gate.ts";

describe("shouldFilter — what reaches rtk", () => {
  test("allow-listed commands, bare and with arguments", () => {
    for (const cmd of [
      "git status",
      "git status -s",
      "git diff HEAD~1",
      "pytest",
      "pytest -q tests/",
      "cargo test --all",
      "find . -name '*.rs'",
      "docker ps",
      "gh pr view 12",
      "ruff check src",
    ]) {
      assert.equal(shouldFilter(cmd), true, cmd);
    }
  });

  test("a rewrite that substitutes a different command is refused", () => {
    // `npm run lint` -> `rtk lint` discards the indirection: whatever the
    // package's lint script is gets replaced by a bare eslint. `uv run pytest`
    // -> `uv run rtk pytest` resolves a pytest outside the venv. Both reproduce
    // on 0.45.0; both are silent.
    assert.equal(shouldFilter("npm run lint"), false);
    assert.equal(shouldFilter("npm run test"), false);
    assert.equal(shouldFilter("uv run pytest"), false);
    assert.equal(shouldFilter("npx tsc"), false);
    assert.equal(shouldFilter("poetry run pytest"), false);
  });

  test("anything whose output leaves the model's eyes is refused", () => {
    // A pipe means a parser, a redirect means a file. Shorter is wrong in both.
    for (const cmd of [
      "git status | grep foo",
      "pytest | tee log.txt",
      "cargo test > out.txt",
      "git status && git log",
      "echo hi; git status",
      "git status || true",
      "find . -name '*.rs' | wc -l",
      "echo $(git status)",
      "git status\ncargo test",
    ]) {
      assert.equal(shouldFilter(cmd), false, cmd);
    }
  });

  test("a prefix changes what the rewrite means, so prefixed forms are refused", () => {
    // rtk strips these before matching its own rules, so the thing rewritten is
    // not the thing that was measured.
    for (const cmd of [
      "sudo docker ps",
      "timeout 30 cargo test",
      "PYTHONPATH=. pytest",
      "env FOO=1 git status",
      "nice cargo build",
    ]) {
      assert.equal(shouldFilter(cmd), false, cmd);
    }
  });

  test("denied commands stay denied", () => {
    // Not because they are wrong — cat, grep and ls were all diffed against the
    // real command and agree. Because they save nothing here (cat 0%, grep 0-6%)
    // or lose (ls -1 is 97% BIGGER filtered), and because a summarised file read
    // is how an edit's old_string stops matching.
    for (const cmd of ["cat src/main.rs", "head -20 f", "tail f", "ls -la", "grep -rn foo src", "rg foo", "aws eks describe-cluster"]) {
      assert.equal(shouldFilter(cmd), false, cmd);
    }
  });

  test("already-rewritten and empty commands are left alone", () => {
    assert.equal(shouldFilter("rtk git status"), false);
    assert.equal(shouldFilter(""), false);
    assert.equal(shouldFilter("   "), false);
  });

  test("runs of whitespace do not lose the match", () => {
    // rtk normalises these itself (`git   status` -> `rtk git status`), so the
    // only thing at stake is whether the allow-list sees them. Missing them
    // costs a saving silently, which is the kind of quiet loss that never gets
    // noticed.
    assert.equal(shouldFilter("git   status"), true);
    assert.equal(shouldFilter("  git status  "), true);
    assert.equal(shouldFilter("cargo\ttest"), true);
    // Collapsing must not resurrect something the refusals caught.
    assert.equal(shouldFilter("git   status  |  grep foo"), false);
    assert.equal(shouldFilter("  uv   run pytest"), false);
  });

  test("prefix matching respects token boundaries", () => {
    assert.equal(isAllowed("git status"), true);
    assert.equal(isAllowed("git statusfoo"), false);
    assert.equal(isAllowed("git stash list"), true);
    assert.equal(isAllowed("git stash"), false);
    assert.equal(isAllowed("findutils --version"), false);
  });
});

describe("extractRewrite — what comes back from rtk", () => {
  test("a plain rewrite is taken", () => {
    assert.equal(extractRewrite("rtk git status\n"), "rtk git status");
  });

  test("an advisory banner is not spliced into the command", () => {
    // Defence in depth, not a regression test: rtk 0.45.0 writes advisories to
    // stderr, so this input does not occur today. It is pinned anyway because
    // the result is handed to a shell, and because "which stream does it use"
    // is a property of a binary this repo does not own.
    const withBanner =
      "[rtk] /!\\ No hook installed - run `rtk init -g` for automatic token savings\nrtk git status\n";
    assert.equal(extractRewrite(withBanner), "rtk git status");
  });

  test("output that is not a command is dropped", () => {
    assert.equal(extractRewrite(""), null);
    assert.equal(extractRewrite("\n \n"), null);
    assert.equal(extractRewrite("[rtk] some advisory and nothing else"), null);
    assert.equal(extractRewrite("error: unknown command\n"), null);
  });

  test("a prefixed rewrite is dropped rather than run", () => {
    // `uv run pytest` comes back as `uv run rtk pytest`. The gate should never
    // send it, but if the allow-list is widened carelessly this is the backstop.
    assert.equal(extractRewrite("uv run rtk pytest\n"), null);
    assert.equal(extractRewrite("sudo rtk docker ps\n"), null);
  });

  test("a rewrite carrying shell metacharacters is dropped", () => {
    assert.equal(extractRewrite("rtk git status | rtk grep foo\n"), null);
    assert.equal(extractRewrite("rtk git status > out.txt\n"), null);
  });
});
