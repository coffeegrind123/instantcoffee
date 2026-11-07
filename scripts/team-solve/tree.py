"""The workspace a team run works in: what it was at the start, what changed,
and putting a saved state back.

Every state of the workspace is a git tree object written through a private
index (GIT_INDEX_FILE), so the project's own index, branch and stash are never
touched. A state holds every file git would not ignore, tracked or untracked,
so one diff covers edits, new files, deleted files, binaries, and an edit to a
file that was already untracked when the run started. `git diff` against the
index (the previous diff.txt) showed the operator's own uncommitted work as the
team's, showed an edited pre-existing untracked file as wholly new, and lost a
change a role had `git add`-ed.

Secrets never enter a state: the sensitive paths the run's diffs already hide
(.env*, *.pem, *.key, *secret*, *credential*, ...) are excluded from every
snapshot, so their contents are never written into the object store, never
shown to a role and never touched by a restore.

Outside a git repository the same code runs against a shadow repository in
.team-solve/shadow.git with the workspace as its work tree, so diffs,
snapshots and the keep net work in a plain folder too.

    start()            base tree + base commit, HEAD where it was, refs kept
    snapshot()         the workspace now, as a tree id
    diff(binary)       base -> now as a unified diff (new files in full)
    changed_files()    [(added, removed, path)] base -> now
    save(name)         now as <name>.tree + <name>.patch in the run folder
    restore(name)      the workspace put back to a saved state
    restore_head()     HEAD moved by a role? put it back
    baseline_copy(d)   the base tree extracted into d, ignored entries linked in
    drop_refs()        forget the run's refs once it is finished

Ported from the deepseek-codex team-solve skill (teamsolve/gitstate.py).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

STATE_DIR = ".team-solve"
GIT_TIMEOUT = 600
# In the shadow repository, where .team-solve/ is also in info/exclude, a
# pathspec naming it from the top (":(exclude).team-solve" or the glob
# ".team-solve/**") makes `git add` exit 1 ("paths are ignored"). The
# "**/.team-solve/**" form covers the top level too and works in both kinds
# of repository (measured).
SNAPSHOT_EXCLUDES = (
    ":(exclude,glob)**/.team-solve/**",
    ":(exclude,glob)**/__pycache__/**",
    ":(exclude,glob).env",
    ":(exclude,glob).env.*",
    ":(exclude,glob)**/.env",
    ":(exclude,glob)**/.env.*",
    ":(exclude,glob)**/*.pem",
    ":(exclude,glob)**/*.key",
    ":(exclude,glob)**/*.p12",
    ":(exclude,glob)**/*.pfx",
    ":(exclude,glob)**/*secret*",
    ":(exclude,glob)**/*credential*",
    ":(exclude,glob)**/id_rsa",
    ":(exclude,glob)**/id_ed25519",
)
SHADOW_EXCLUDES = (
    ".team-solve/",
    "__pycache__/",
    "node_modules/",
    ".venv/",
    "venv/",
    "target/",
    ".mypy_cache/",
    ".pytest_cache/",
    "*.pyc",
)
IDENTITY = {
    "GIT_AUTHOR_NAME": "team-solve",
    "GIT_AUTHOR_EMAIL": "team-solve@localhost",
    "GIT_COMMITTER_NAME": "team-solve",
    "GIT_COMMITTER_EMAIL": "team-solve@localhost",
}


class TreeError(RuntimeError):
    pass


def ensure_state_dir(workspace: Path) -> Path:
    """.team-solve/ with a .gitignore of '*', so a run never shows up in the
    project's `git status` and never lands in its own diff."""
    home = workspace / STATE_DIR
    home.mkdir(parents=True, exist_ok=True)
    ignore = home / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    return home


class Tree:
    def __init__(self, workspace: Path, run_dir: Path, run_id: str):
        self.ws = workspace
        self.rd = run_dir
        self.run_id = run_id
        self.env = dict(os.environ)
        for key in ("GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"):
            self.env.pop(key, None)
        probe = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=workspace,
            capture_output=True,
            text=True,
            env=self.env,
        )
        self.real = probe.returncode == 0 and probe.stdout.strip() == "true"
        if not self.real:
            self._shadow()
        self.top = Path(self.git("rev-parse", "--show-toplevel").strip())
        self.prefix = self.git("rev-parse", "--show-prefix").strip()

    # --- plumbing -----------------------------------------------------------

    def _shadow(self) -> None:
        shadow = ensure_state_dir(self.ws) / "shadow.git"
        if not shadow.is_dir():
            subprocess.run(
                ["git", "init", "-q", "--bare", str(shadow)],
                check=True,
                capture_output=True,
                env=self.env,
            )
            with (shadow / "info" / "exclude").open("a", encoding="utf-8") as handle:
                handle.write("\n".join(SHADOW_EXCLUDES) + "\n")
        self.env["GIT_DIR"] = str(shadow)
        self.env["GIT_WORK_TREE"] = str(self.ws)

    def git(self, *args: str, env: dict[str, str] | None = None, check: bool = True,
            binary: bool = False, cwd: Path | None = None, stdin: str | None = None) -> str | bytes:
        merged = dict(self.env, **(env or {}))
        result = subprocess.run(
            ["git", *args],
            cwd=cwd or self.ws,
            capture_output=True,
            env=merged,
            input=stdin,
            text=not binary,
            timeout=GIT_TIMEOUT,
        )
        if check and result.returncode != 0:
            err = result.stderr if not binary else result.stderr.decode("utf-8", "replace")
            raise TreeError(f"git {' '.join(args[:3])}: exit {result.returncode}: {err.strip()[:500]}")
        return result.stdout

    def _read(self, name: str) -> str:
        path = self.rd / name
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""

    def _write(self, name: str, text: str) -> None:
        path = self.rd / name
        path.write_text(text, encoding="utf-8")
        path.chmod(0o600)

    def _keep(self, name: str, sha: str) -> None:
        """A ref per saved state, so `git gc` never prunes a state the run may put back."""
        self.git("update-ref", f"refs/team-solve/{self.run_id}/{name}", sha)

    def snapshot(self) -> str:
        """The workspace as it is now: every file git does not ignore, minus the
        sensitive paths, as a tree object id."""
        fd, index = tempfile.mkstemp(prefix="team-solve-index-")
        os.close(fd)
        try:
            env = {"GIT_INDEX_FILE": index}
            real_index = str(self.git("rev-parse", "--git-path", "index")).strip()
            if not os.path.isabs(real_index):
                real_index = str(self.ws / real_index)
            # Seeding from the project's index reuses its stat cache, so only
            # changed files are hashed. copy2, not copyfile: git trusts a cached
            # entry only when the file is older than the index file itself
            # ("racy git"), and a fresh mtime on the copy made a same-size
            # rewrite within the same second invisible.
            seeded = os.path.exists(real_index)
            if seeded:
                shutil.copy2(real_index, index)
            else:
                os.unlink(index)
            for attempt in range(3):
                try:
                    self.git("add", "-A", "--", ".", *SNAPSHOT_EXCLUDES, env=env)
                    # A sensitive file that is tracked stays in the seeded index:
                    # drop it so its content never enters a state.
                    tracked = str(self.git("ls-files", "-z", "--cached", "--", ".", env=env)).split("\0")
                    sensitive = [path for path in tracked if path and _sensitive(path)]
                    if sensitive:
                        self.git("rm", "-q", "--cached", "--ignore-unmatch", "--", *sensitive, env=env)
                    return str(self.git("write-tree", env=env)).strip()
                except TreeError:
                    if os.path.exists(index):
                        os.unlink(index)
                    head = str(self.git("rev-parse", "-q", "--verify", "HEAD", check=False)).strip()
                    if attempt == 0 and head:
                        self.git("read-tree", "HEAD", env=env)
                    else:
                        self.git("read-tree", "--empty", env=env)
            raise TreeError("could not write a tree of the workspace")
        finally:
            if os.path.exists(index):
                os.unlink(index)

    # --- the run's states ---------------------------------------------------

    def start(self) -> str:
        existing = self._read("base.txt")
        if existing:
            return existing
        base = self.snapshot()
        head = str(self.git("rev-parse", "-q", "--verify", "HEAD", check=False)).strip()
        args = ["commit-tree", base, "-m", f"team-solve {self.run_id}: the workspace as the run found it"]
        if head:
            args += ["-p", head]
        commit = str(self.git(*args, env=IDENTITY)).strip()
        self._keep("base", commit)
        self._write("base-commit.txt", commit + "\n")
        if self.real:
            where = str(self.git("symbolic-ref", "-q", "--short", "HEAD", check=False)).strip() or head
            if where:
                self._write("head.txt", where + "\n")
        self._write("base.txt", base + "\n")
        return base

    @property
    def base(self) -> str:
        return self._read("base.txt")

    def diff(self, binary: bool = False, now: str | None = None) -> str:
        now = now or self.snapshot()
        args = ["diff", "--relative", "--no-color", "--no-ext-diff", "--no-textconv"]
        if binary:
            args.append("--binary")
        return str(self.git(*args, self.base, now))

    def changed_files(self, now: str | None = None) -> list[tuple[str, str, str]]:
        now = now or self.snapshot()
        out = []
        for line in str(self.git("diff", "--relative", "--numstat", "--no-renames", self.base, now)).splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3:
                out.append((parts[0], parts[1], parts[2]))
        return out

    def existed_at_base(self, path: str) -> bool:
        result = subprocess.run(
            ["git", "cat-file", "-e", f"{self.base}:{self.prefix}{path}"],
            cwd=self.ws,
            env=self.env,
            capture_output=True,
        )
        return result.returncode == 0

    def save(self, name: str) -> str:
        now = self.snapshot()
        commit = str(self.git(
            "commit-tree", now, "-p", self._read("base-commit.txt"),
            "-m", f"team-solve {self.run_id}: {name}", env=IDENTITY,
        )).strip()
        self._keep(name, commit)
        self._write(f"{name}.tree", now + "\n")
        patch = self.rd / f"{name}.patch"
        patch.write_bytes(self.git(
            "diff", "--relative", "--binary", "--no-color", "--no-ext-diff", "--no-textconv",
            self.base, now, binary=True,
        ))
        patch.chmod(0o600)
        return now

    def saved(self, name: str) -> str:
        return self._read(f"{name}.tree")

    def restore(self, name: str) -> int:
        target = self.saved(name)
        if not target:
            raise TreeError(f"no saved state {name}")
        return self.restore_tree(target)

    def restore_tree(self, target: str) -> int:
        """Put the workspace back to a tree. Ignored and sensitive files are left alone."""
        now = self.snapshot()
        if now == target:
            return 0
        fields = str(self.git("diff", "--relative", "--name-status", "--no-renames", "-z", now, target)).split("\0")
        write, delete = [], []
        for i in range(0, len(fields) - 1, 2):
            status, path = fields[i], fields[i + 1]
            (delete if status.startswith("D") else write).append(path)
        for path in delete:
            full = self.ws / path
            if full.is_symlink() or full.exists():
                full.unlink()
            _prune_empty(self.ws, full.parent)
        if write:
            fd, index = tempfile.mkstemp(prefix="team-solve-index-")
            os.close(fd)
            os.unlink(index)
            try:
                env = {"GIT_INDEX_FILE": index}
                self.git("read-tree", target, env=env)
                for path in write:
                    full = self.ws / path
                    if full.is_dir() and not full.is_symlink():
                        shutil.rmtree(full)
                listing = "".join(f"{self.prefix}{path}\0" for path in write)
                self.git("checkout-index", "-f", "-z", "--stdin", env=env, cwd=self.top, stdin=listing)
            finally:
                if os.path.exists(index):
                    os.unlink(index)
        after = self.snapshot()
        if after != target:
            raise TreeError(f"the workspace did not come back to {target[:12]} (it is {after[:12]})")
        return len(write) + len(delete)

    def restore_head(self) -> str:
        """A role that ran `git checkout` moved HEAD: put it back. Returns a report line or ''."""
        want = self._read("head.txt")
        if not (self.real and want):
            return ""
        now = str(self.git("symbolic-ref", "-q", "--short", "HEAD", check=False)).strip() or \
            str(self.git("rev-parse", "-q", "--verify", "HEAD", check=False)).strip()
        if now == want:
            return ""
        a = str(self.git("rev-parse", "-q", "--verify", now, check=False)).strip()
        b = str(self.git("rev-parse", "-q", "--verify", want, check=False)).strip()
        if a and a == b:
            return ""
        result = subprocess.run(["git", "checkout", "-q", want], cwd=self.ws, env=self.env,
                                capture_output=True, text=True)
        if result.returncode == 0:
            return f"HEAD had moved to {now}; put back on {want}"
        return f"HEAD MOVED to {now} and could not be put back on {want}: {result.stderr.strip()[:200]}"

    def baseline_copy(self, dest: Path) -> Path:
        """The base tree extracted into dest, with the project's ignored entries
        (installed dependencies, build outputs, virtualenvs) linked in from the
        live workspace, so a check that needs node_modules or a venv runs there
        as it would in place. Returns the folder that corresponds to the workspace."""
        dest.mkdir(parents=True, exist_ok=True)
        # An empty start (a new folder) has nothing to extract, and `git archive`
        # of an empty tree is no tar that tarfile reads (measured: ReadError).
        if str(self.git("ls-tree", "--name-only", self.base)).strip():
            data = self.git("archive", "--format=tar", self._read("base-commit.txt"), binary=True)
            fd, tar_path = tempfile.mkstemp(prefix="team-solve-base-", suffix=".tar")
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                with tarfile.open(tar_path) as archive:
                    try:
                        archive.extractall(dest, filter="tar")
                    except TypeError:
                        archive.extractall(dest)
            except tarfile.TarError as exc:
                raise TreeError(f"could not extract the start of the run: {exc}") from exc
            finally:
                os.unlink(tar_path)
        ignored = str(self.git("ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z",
                               cwd=self.top, check=False))
        for entry in ignored.split("\0"):
            entry = entry.rstrip("/")
            if not entry or STATE_DIR in entry.split("/"):
                continue
            src, dst = self.top / entry, dest / entry
            if dst.is_symlink() or dst.exists() or not (src.is_symlink() or src.exists()):
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(src, dst)
        return dest / self.prefix if self.prefix else dest

    def drop_refs(self) -> None:
        refs = str(self.git("for-each-ref", "--format=%(refname)", f"refs/team-solve/{self.run_id}/", check=False))
        for ref in refs.split():
            self.git("update-ref", "-d", ref, check=False)


def _sensitive(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    lowered = name.lower()
    return (
        name in {".env", "id_rsa", "id_ed25519"}
        or name.startswith(".env.")
        or lowered.endswith((".pem", ".key", ".p12", ".pfx"))
        or "secret" in lowered
        or "credential" in lowered
    )


def _prune_empty(root: Path, directory: Path) -> None:
    root = root.resolve()
    directory = directory.resolve()
    while directory != root and root in directory.parents and directory.is_dir() and not any(directory.iterdir()):
        directory.rmdir()
        directory = directory.parent
