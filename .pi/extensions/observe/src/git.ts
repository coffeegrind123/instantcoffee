/**
 * The git checkout a session runs in: branch and origin URL.
 *
 * Read straight from .git rather than by running `git`: this runs on every
 * top-level session start and settle, and a subprocess there would be the one
 * thing in this extension that can stall a turn. Plain files cover what is
 * needed — HEAD for the branch, config for the remote, and the `gitdir:` /
 * `commondir` indirection a linked worktree adds:
 *
 *   <worktree>/.git            file: "gitdir: <main>/.git/worktrees/<name>"
 *   <main>/.git/worktrees/<n>/HEAD       this worktree's branch
 *   <main>/.git/worktrees/<n>/commondir  "../.." → <main>/.git (shared config)
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GitContext {
	/** Checked-out branch; null when detached or outside a repository. */
	branch: string | null;
	/** origin's URL (else the first remote's), credentials removed. */
	repositoryUrl: string | null;
}

const NONE: GitContext = { branch: null, repositoryUrl: null };
const HEAD_REF = /^ref:\s*refs\/heads\/(.+)$/;
const GITDIR_LINE = /^gitdir:\s*(.+)$/;
const HTTP_SCHEMES = new Set(["http:", "https:"]);

function read(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function kind(path: string): "dir" | "file" | null {
	try {
		const st = statSync(path);
		return st.isDirectory() ? "dir" : "file";
	} catch {
		return null;
	}
}

/** The .git directory for `start`, walking up; null outside a repository. */
function findGitDir(start: string): string | null {
	let dir = resolve(start);
	for (;;) {
		const dotGit = join(dir, ".git");
		const k = kind(dotGit);
		if (k === "dir") {
			return dotGit;
		}
		if (k === "file") {
			const m = GITDIR_LINE.exec((read(dotGit) ?? "").trim());
			if (m) {
				return isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/** Remote URLs from a git config, keyed by remote name, in file order. */
function remotes(config: string): Map<string, string> {
	const out = new Map<string, string>();
	let remote: string | null = null;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) {
			continue;
		}
		const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line) ?? /^\[\s*remote\.([^\]\s]+)\s*\]$/i.exec(line);
		if (section) {
			remote = section[1];
			continue;
		}
		if (line.startsWith("[")) {
			remote = null;
			continue;
		}
		const kv = /^url\s*=\s*(.*)$/i.exec(line);
		if (remote !== null && kv && !out.has(remote)) {
			out.set(remote, kv[1].replace(/^"(.*)"$/, "$1").trim());
		}
	}
	return out;
}

/**
 * Remove credentials from a remote URL before it leaves the machine. http(s)
 * loses the whole userinfo (a token is often the user name); other URL schemes
 * keep the user name (`ssh://git@...` is routing) but lose any password.
 * scp-style `git@host:path` and local paths have no password to lose.
 */
export function stripCredentials(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	if (!parsed.username && !parsed.password) {
		return url;
	}
	parsed.password = "";
	if (HTTP_SCHEMES.has(parsed.protocol)) {
		parsed.username = "";
	}
	return parsed.toString();
}

export function gitContext(cwd: string): GitContext {
	const gitDir = findGitDir(cwd);
	if (!gitDir) {
		return NONE;
	}

	const head = (read(join(gitDir, "HEAD")) ?? "").trim();
	const branch = HEAD_REF.exec(head)?.[1] ?? null;

	const common = (read(join(gitDir, "commondir")) ?? "").trim();
	const commonDir = common === "" ? gitDir : isAbsolute(common) ? common : resolve(gitDir, common);
	const urls = remotes(read(join(commonDir, "config")) ?? "");
	const url = urls.get("origin") ?? urls.values().next().value ?? null;

	return { branch, repositoryUrl: url === null ? null : stripCredentials(url) };
}
