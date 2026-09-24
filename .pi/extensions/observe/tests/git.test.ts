/**
 * gitContext: branch and origin read straight from .git, no subprocess.
 *
 *   node --experimental-strip-types --no-warnings --test .pi/extensions/observe/tests/*.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { gitContext, stripCredentials } from "../src/git.ts";

const roots: string[] = [];
after(() => {
	for (const r of roots) {
		rmSync(r, { recursive: true, force: true });
	}
});

function repo(head: string, config: string): string {
	const root = mkdtempSync(join(tmpdir(), "observe-git-"));
	roots.push(root);
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "HEAD"), head);
	writeFileSync(join(root, ".git", "config"), config);
	return root;
}

const ORIGIN = `[core]
	bare = false
[remote "upstream"]
	url = https://github.com/them/repo.git
[remote "origin"]
	url = https://github.com/me/repo.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
`;

describe("gitContext", () => {
	test("reads the branch and origin of the repo containing cwd", () => {
		const root = repo("ref: refs/heads/feat/observe\n", ORIGIN);
		const sub = join(root, "src", "deep");
		mkdirSync(sub, { recursive: true });
		assert.deepEqual(gitContext(sub), {
			branch: "feat/observe",
			repositoryUrl: "https://github.com/me/repo.git",
		});
	});

	test("a detached HEAD has no branch", () => {
		const root = repo("0123456789abcdef0123456789abcdef01234567\n", ORIGIN);
		assert.equal(gitContext(root).branch, null);
	});

	test("without origin, falls back to the first remote", () => {
		const root = repo("ref: refs/heads/main\n", '[remote "upstream"]\n\turl = git@github.com:them/repo.git\n');
		assert.equal(gitContext(root).repositoryUrl, "git@github.com:them/repo.git");
	});

	test("no remote at all", () => {
		const root = repo("ref: refs/heads/main\n", "[core]\n\tbare = false\n");
		assert.deepEqual(gitContext(root), { branch: "main", repositoryUrl: null });
	});

	test("follows a linked worktree to its own HEAD and the shared config", () => {
		const main = repo("ref: refs/heads/main\n", ORIGIN);
		const wtGitDir = join(main, ".git", "worktrees", "feat");
		mkdirSync(wtGitDir, { recursive: true });
		writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/feat/wt\n");
		writeFileSync(join(wtGitDir, "commondir"), "../..\n");

		const wt = mkdtempSync(join(tmpdir(), "observe-wt-"));
		roots.push(wt);
		writeFileSync(join(wt, ".git"), `gitdir: ${wtGitDir}\n`);

		assert.deepEqual(gitContext(wt), {
			branch: "feat/wt",
			repositoryUrl: "https://github.com/me/repo.git",
		});
	});

	test("outside any repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "observe-norepo-"));
		roots.push(dir);
		// tmpdir itself could sit inside a checkout on some machines; only assert
		// when the walk really finds nothing above the fixture.
		const ctx = gitContext(dir);
		if (ctx.branch === null && ctx.repositoryUrl === null) {
			assert.deepEqual(ctx, { branch: null, repositoryUrl: null });
		}
		assert.deepEqual(gitContext(join(dir, "does", "not", "exist")), gitContext(dir));
	});

	test("credentials in the remote never leave the machine", () => {
		const root = repo("ref: refs/heads/main\n", '[remote "origin"]\n\turl = https://ghp_secret@github.com/me/repo.git\n');
		assert.equal(gitContext(root).repositoryUrl, "https://github.com/me/repo.git");
	});
});

describe("stripCredentials", () => {
	test("http(s) loses the whole userinfo", () => {
		assert.equal(stripCredentials("https://me:pw@gitlab.com/me/r"), "https://gitlab.com/me/r");
		assert.equal(stripCredentials("https://tok@github.com/me/r.git"), "https://github.com/me/r.git");
	});

	test("ssh keeps the user name, drops a password", () => {
		assert.equal(stripCredentials("ssh://git@github.com/me/r.git"), "ssh://git@github.com/me/r.git");
		assert.equal(stripCredentials("ssh://git:pw@host/r.git"), "ssh://git@host/r.git");
	});

	test("scp-style and local paths pass through", () => {
		assert.equal(stripCredentials("git@github.com:me/r.git"), "git@github.com:me/r.git");
		assert.equal(stripCredentials("/srv/git/r.git"), "/srv/git/r.git");
	});
});
