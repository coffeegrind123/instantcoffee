#!/usr/bin/env python3
"""Durable team-solve orchestrator for pi's Anthropic mode.

The workflow is a pi-native port of the GVS5H/Memdoor method:

    route -> plan -> ideate A + B -> solve -> check
          -> triage -> review -> manage -> repair -> check (repeat)
          -> audit -> strict final check

Every model role is a fresh `pi --mode json` process. Roles communicate only
through files in `.team-solve/`, and only the check command decides success.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

from prompts import ROLE_PROMPTS, role_prompt  # noqa: E402

STATE_DIR = ".team-solve"
STATE_VERSION = 1
MAX_MAX_HOURS = 24 * 366
READ_ONLY_TOOLS = "read,grep,find,ls"
WRITE_TOOLS = "read,bash,edit,write,grep,find,ls"
MODEL_DEFAULTS = {
    "fable": "claude-fable-5-1",
    "opus": "claude-opus-5-5",
    "sonnet": "claude-sonnet-5-5",
    "haiku": "claude-haiku-5-5",
}
TIER_THINKING = {
    "fable": "high",
    "opus": "high",
    "sonnet": "high",
    "haiku": "medium",
}
VALID_THINKING = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
SENSITIVE_NAMES = {
    ".env",
    ".env.local",
    ".env.local.example",
    "credentials",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
}
ROLE_TIERS = {
    "coding": {
        "router": "haiku",
        "plan": "fable",
        "ideate-a": "sonnet",
        "ideate-b": "sonnet",
        "solve": "opus",
        "cutoff": "haiku",
        "triage": "haiku",
        "review": "sonnet",
        "manager": "fable",
        "repair": "opus",
        "audit": "fable",
    },
    "everyday": {
        "router": "haiku",
        "plan": "sonnet",
        "ideate-a": "sonnet",
        "ideate-b": "sonnet",
        "solve": "sonnet",
        "cutoff": "haiku",
        "triage": "haiku",
        "review": "opus",
        "manager": "sonnet",
        "repair": "sonnet",
        "audit": "sonnet",
    },
    "research": {
        "router": "haiku",
        "plan": "fable",
        "ideate-a": "fable",
        "ideate-b": "sonnet",
        "solve": "fable",
        "cutoff": "haiku",
        "triage": "haiku",
        "review": "opus",
        "manager": "fable",
        "repair": "fable",
        "audit": "fable",
    },
    "writing": {
        "router": "haiku",
        "plan": "sonnet",
        "ideate-a": "sonnet",
        "ideate-b": "sonnet",
        "solve": "sonnet",
        "cutoff": "haiku",
        "triage": "haiku",
        "review": "opus",
        "manager": "sonnet",
        "repair": "sonnet",
        "audit": "fable",
    },
    "general": {
        "router": "haiku",
        "plan": "sonnet",
        "ideate-a": "sonnet",
        "ideate-b": "sonnet",
        "solve": "sonnet",
        "cutoff": "haiku",
        "triage": "haiku",
        "review": "opus",
        "manager": "sonnet",
        "repair": "sonnet",
        "audit": "fable",
    },
    "high-volume": {
        "router": "haiku",
        "plan": "sonnet",
        "ideate-a": "haiku",
        "ideate-b": "haiku",
        "solve": "haiku",
        "cutoff": "haiku",
        "triage": "haiku",
        "review": "sonnet",
        "manager": "sonnet",
        "repair": "haiku",
        "audit": "sonnet",
    },
}
WRITABLE_ROLES = {"solve", "repair"}
CUTOFF_SUMMARIZABLE_ROLES = {"solve", "repair"}
REQUIRED_OUTPUT_ROLES = set(ROLE_PROMPTS)
PROFILE_CHOICES = (
    "auto",
    "coding",
    "everyday",
    "research",
    "writing",
    "general",
    "high-volume",
)
CLAIMED_RUN: tuple[Path, Path] | None = None
EARLY_STOP_REQUESTED = False


class TeamSolveError(RuntimeError):
    pass


class TeamStopped(TeamSolveError):
    pass


def request_early_stop(_signum: int, _frame: Any) -> None:
    global EARLY_STOP_REQUESTED
    EARLY_STOP_REQUESTED = True


def log(message: str = "") -> None:
    print(message, file=sys.stderr, flush=True)


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_duration(raw: str | int | float, name: str) -> int:
    if isinstance(raw, (int, float)):
        seconds = int(raw)
    else:
        text = str(raw).strip().lower()
        match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*([smhd]?)", text)
        if not match:
            raise TeamSolveError(f"{name} must look like 90s, 30m, 4h, or 2d; got {raw!r}")
        value = float(match.group(1))
        seconds = int(value * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)])
    if seconds <= 0:
        raise TeamSolveError(f"{name} must be greater than zero")
    return seconds


def positive_finite_float(
    raw: str | int | float,
    name: str,
    *,
    maximum: float | None = None,
) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise TeamSolveError(f"{name} must be a finite number greater than zero") from exc
    if not math.isfinite(value) or value <= 0:
        raise TeamSolveError(f"{name} must be a finite number greater than zero")
    if maximum is not None and value > maximum:
        raise TeamSolveError(f"{name} must not exceed {maximum:g}")
    return value


def bounded_int_setting(key: str, default: int, minimum: int, maximum: int) -> int:
    raw = setting(key, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise TeamSolveError(f"{key} must be an integer from {minimum} to {maximum}") from exc
    if value < minimum or value > maximum:
        raise TeamSolveError(f"{key} must be an integer from {minimum} to {maximum}")
    return value


def optional_bool(raw: str | None, name: str) -> bool | None:
    if raw is None or not str(raw).strip():
        return None
    value = str(raw).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise TeamSolveError(f"{name} must be one of 1/0, true/false, yes/no, or on/off; got {raw!r}")


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$", line)
        if not match:
            continue
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        else:
            value = re.sub(r"\s+#.*$", "", value).strip()
        values[match.group(1)] = value
    return values


def setting(key: str, default: str = "", *, include_tracked: bool = True) -> str:
    if os.environ.get(key):
        return os.environ[key]
    local = read_env_file(REPO_ROOT / ".env.local")
    if key in local:
        return local[key]
    if include_tracked:
        tracked = read_env_file(REPO_ROOT / ".env")
        if key in tracked:
            return tracked[key]
    return default


def backend_problem() -> str | None:
    backend = setting("STACK_BACKEND", "local")
    if backend != "anthropic":
        return (
            f"/team-solve requires Anthropic mode; STACK_BACKEND is {backend!r}.\n"
            "Switch with /anthropic on or /stack mode anthropic, then relaunch pi."
        )
    key = setting("ANTHROPIC_API_KEY", include_tracked=False)
    if not key:
        return (
            "ANTHROPIC_API_KEY is not set in the pi environment or .env.local.\n"
            f"Add it to {REPO_ROOT / '.env.local'} and relaunch pi."
        )
    return None


def normalize_model(value: str) -> str:
    value = value.strip()
    if not value:
        raise TeamSolveError("model id is empty")
    return value if "/" in value else f"anthropic/{value}"


def model_for(tier: str) -> str:
    key = f"TEAM_SOLVE_{tier.upper()}_MODEL"
    return normalize_model(setting(key, MODEL_DEFAULTS[tier]))


def thinking_for(tier: str) -> str:
    key = f"TEAM_SOLVE_{tier.upper()}_THINKING"
    value = setting(key, TIER_THINKING[tier]).strip().lower()
    if value not in VALID_THINKING:
        raise TeamSolveError(f"{key} must be one of {', '.join(sorted(VALID_THINKING))}; got {value!r}")
    return value


def role_spec(
    profile: str,
    role: str,
    *,
    multi_day: bool = False,
) -> tuple[str, str, str]:
    tier = ROLE_TIERS[profile][role]
    if multi_day and role in {"plan", "manager", "audit"}:
        tier = "fable"
    return model_for(tier), thinking_for(tier), WRITE_TOOLS if role in WRITABLE_ROLES else READ_ONLY_TOOLS


def state_home(workspace: Path) -> Path:
    return workspace / STATE_DIR


def current_path(workspace: Path) -> Path:
    return state_home(workspace) / "current.json"


def atomic_json(path: Path, value: Any, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".tmp-{os.getpid()}-{threading.get_ident()}")
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.chmod(mode)
    os.replace(temp, path)


def atomic_text(path: Path, value: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".tmp-{os.getpid()}-{threading.get_ident()}")
    temp.write_text(value, encoding="utf-8")
    temp.chmod(mode)
    os.replace(temp, path)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


@contextmanager
def claim_run_lock(workspace: Path) -> Iterator[None]:
    if not workspace.is_dir():
        raise TeamSolveError(f"workspace is not a directory: {workspace}")
    home = state_home(workspace)
    home.mkdir(parents=True, exist_ok=True)
    home.chmod(0o700)
    path = home / "run.lock"
    with path.open("a+", encoding="utf-8") as handle:
        path.chmod(0o600)
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise TeamSolveError(f"another team-solve process owns {path}") from exc
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def set_current(workspace: Path, run_dir: Path) -> None:
    atomic_json(
        current_path(workspace),
        {"run_dir": os.path.relpath(run_dir, workspace), "updated_at": utc_now()},
    )


def current_run_dir(workspace: Path) -> Path | None:
    path = current_path(workspace)
    if not path.exists():
        return None
    try:
        data = read_json(path)
        raw = str(data["run_dir"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    run_dir = (workspace / raw).resolve()
    try:
        run_dir.relative_to(state_home(workspace).resolve())
    except ValueError:
        raise TeamSolveError(f"{path} points outside {state_home(workspace)}")
    return run_dir


def proc_start_ticks(pid: int) -> str | None:
    fields = proc_stat_fields(pid)
    return fields[19] if fields and len(fields) > 19 else None


def proc_stat_fields(pid: int) -> list[str] | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return None
    close = raw.rfind(")")
    if close < 0:
        return None
    return raw[close + 2 :].split()


def pid_alive(pid: int | None, start_ticks: str | None = None) -> bool:
    if not pid or pid <= 0:
        return False
    fields = proc_stat_fields(pid)
    if fields and fields[0] == "Z":
        return False
    try:
        os.kill(pid, 0)
    except PermissionError:
        pass
    except OSError:
        return False
    if start_ticks and proc_start_ticks(pid) not in (None, start_ticks):
        return False
    return True


def process_tree(root_pid: int) -> tuple[set[int], dict[int, int]]:
    """Return live descendants of root_pid and each process's group id."""
    table: dict[int, tuple[int, int, str]] = {}
    try:
        entries = Path("/proc").iterdir()
    except OSError:
        return {root_pid}, {}
    for entry in entries:
        if not entry.name.isdigit():
            continue
        fields = proc_stat_fields(int(entry.name))
        if not fields or len(fields) < 3:
            continue
        table[int(entry.name)] = (int(fields[1]), int(fields[2]), fields[0])

    tree = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, (parent, _, state) in table.items():
            if pid in tree or state == "Z":
                continue
            if parent in tree:
                tree.add(pid)
                changed = True
    groups = {pid: table[pid][1] for pid in tree if pid in table}
    return tree, groups


def signal_process_tree(root_pid: int, owns_process_group: bool, signum: int) -> set[int]:
    pids, groups = process_tree(root_pid)
    current_pid = os.getpid()
    current_group = os.getpgrp()
    target_groups = {
        group
        for pid, group in groups.items()
        if group in pids and group != current_group
    }
    if owns_process_group and root_pid in groups:
        root_group = groups[root_pid]
        if root_group != current_group:
            target_groups.add(root_group)

    signalled_groups: set[int] = set()
    for group in sorted(target_groups):
        if group <= 0 or group == current_group:
            continue
        try:
            os.killpg(group, signum)
            signalled_groups.add(group)
        except OSError:
            continue
    for pid in sorted(pids):
        if pid == current_pid or groups.get(pid) in signalled_groups:
            continue
        try:
            os.kill(pid, signum)
        except OSError:
            continue
    return pids


def wait_for_processes(pids: set[int], timeout: float) -> set[int]:
    deadline = time.time() + timeout
    remaining = set(pids)
    while remaining and time.time() < deadline:
        remaining = {pid for pid in remaining if pid_alive(pid)}
        if remaining:
            time.sleep(0.1)
    return remaining


def stop_process_tree(
    root_pid: int,
    owns_process_group: bool,
    *,
    grace: float = 10,
) -> set[int]:
    pids = signal_process_tree(root_pid, owns_process_group, signal.SIGTERM)
    remaining = wait_for_processes(pids, grace)
    if not remaining:
        return set()
    refreshed, _ = process_tree(root_pid)
    hard_targets = remaining | refreshed
    pids = signal_process_tree(root_pid, owns_process_group, signal.SIGKILL)
    hard_targets |= pids
    for pid in hard_targets:
        if pid == os.getpid():
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            continue
    return wait_for_processes(hard_targets, 5)


def stop_tracked_processes(state: dict[str, Any]) -> set[int]:
    survivors: set[int] = set()
    for raw_record in (state.get("active_processes") or {}).values():
        if not isinstance(raw_record, dict):
            continue
        pid = safe_pid(raw_record.get("pid"))
        ticks = raw_record.get("pid_start_ticks")
        group = safe_pid(raw_record.get("pgroup"))
        if pid and pid_alive(pid, ticks):
            survivors |= stop_process_tree(pid, group == pid, grace=5)
    return {pid for pid in survivors if pid_alive(pid)}


def tail(path: Path, limit: int = 80) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-limit:])


def compact_text(text: str, limit: int = 240) -> str:
    one = " ".join(text.split())
    return one if len(one) <= limit else one[: limit - 1] + "…"


def sensitive_path(name: str) -> bool:
    path = Path(name)
    if path.name in SENSITIVE_NAMES or path.name.startswith(".env."):
        return True
    lowered = path.name.lower()
    return (
        path.suffix.lower() in {".key", ".pem", ".p12", ".pfx"}
        or "secret" in lowered
        or "credential" in lowered
    )


def git_excludes() -> list[str]:
    return [
        ":(exclude).team-solve",
        ":(exclude).env",
        ":(exclude).env.*",
        ":(exclude,glob)**/.env",
        ":(exclude,glob)**/.env.*",
        ":(exclude,glob)*.pem",
        ":(exclude,glob)**/*.pem",
        ":(exclude,glob)*.key",
        ":(exclude,glob)**/*.key",
        ":(exclude,glob)*.p12",
        ":(exclude,glob)**/*.p12",
        ":(exclude,glob)*.pfx",
        ":(exclude,glob)**/*.pfx",
        ":(exclude,glob)*secret*",
        ":(exclude,glob)**/*secret*",
        ":(exclude,glob)*credential*",
        ":(exclude,glob)**/*credential*",
    ]


def filtered_git_status(workspace: Path) -> str:
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(workspace),
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ],
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"ERROR: {exc}"
    records = result.stdout.split(b"\0")
    lines: list[str] = []
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        raw = record.decode("utf-8", errors="surrogateescape")
        status = raw[:2]
        path = raw[3:] if len(raw) > 3 else raw
        source = ""
        if status[:1] in ("R", "C") and index < len(records):
            source = records[index].decode("utf-8", errors="surrogateescape")
            index += 1
        if path.startswith(f"{STATE_DIR}/") or path == STATE_DIR:
            continue
        if sensitive_path(path) or (source and sensitive_path(source)):
            continue
        suffix = f" <- {source}" if source else ""
        lines.append(f"{status} {path}{suffix}")
    return "\n".join(lines) + ("\n" if lines else "")


@dataclass
class RoleRun:
    ok: bool
    text: str
    reason: str
    usage: dict[str, float]
    seconds: float


class Orchestrator:
    def __init__(
        self,
        workspace: Path,
        run_dir: Path,
        state: dict[str, Any],
        *,
        activate: bool = True,
        enforce_budget: bool = True,
    ):
        self.workspace = workspace
        self.run_dir = run_dir
        self.state = state
        self.enforce_budget = enforce_budget
        self.persist_process_state = activate
        self.state_lock = threading.Lock()
        self.proc_lock = threading.Lock()
        self.current_procs: dict[int, subprocess.Popen[bytes]] = {}
        self.last_inventory_refresh = 0.0
        self.stop_requested = False
        self.cancel_requested = threading.Event()
        self.pi_bin = setting("TEAM_SOLVE_PI_BIN", "pi")
        self.role_timeout = parse_duration(
            str(state.get("role_timeout_sec") or setting("TEAM_SOLVE_ROLE_TIMEOUT", "4h")),
            "TEAM_SOLVE_ROLE_TIMEOUT",
        )
        self.check_timeout = parse_duration(
            str(state.get("check_timeout_sec") or setting("TEAM_SOLVE_CHECK_TIMEOUT", "1h")),
            "TEAM_SOLVE_CHECK_TIMEOUT",
        )
        raw_started = state.get("started_epoch")
        try:
            started = float(time.time() if raw_started is None else raw_started)
        except (TypeError, ValueError) as exc:
            raise TeamSolveError("saved started_epoch must be a finite positive timestamp") from exc
        if not math.isfinite(started) or started <= 0:
            raise TeamSolveError("saved started_epoch must be a finite positive timestamp")
        profile = str(state.get("profile") or "auto")
        if profile not in PROFILE_CHOICES:
            raise TeamSolveError(
                f"saved profile must be one of {', '.join(PROFILE_CHOICES)}; got {profile!r}"
            )
        raw_max_hours = 72 if state.get("max_hours") is None else state["max_hours"]
        max_hours = positive_finite_float(
            raw_max_hours,
            "max_hours",
            maximum=MAX_MAX_HOURS,
        )
        self.deadline = started + max_hours * 3600
        if not math.isfinite(self.deadline):
            raise TeamSolveError("saved budget produces a non-finite deadline")
        if activate:
            global CLAIMED_RUN
            self.state["pid"] = os.getpid()
            self.state["pid_start_ticks"] = proc_start_ticks(os.getpid())
            self.state["owns_process_group"] = os.getpgrp() == os.getpid()
            self.state["status"] = "running"
            self.state["updated_at"] = utc_now()
            CLAIMED_RUN = (workspace, run_dir)
            self.save()

    def save(self) -> None:
        with self.state_lock:
            self.state["updated_at"] = utc_now()
            atomic_json(self.run_dir / "state.json", self.state)

    def set_phase(self, phase: str, round_no: int | None = None) -> None:
        self.state["phase"] = phase
        if round_no is not None:
            self.state["current_round"] = round_no
        if self.persist_process_state:
            self.save()
        log(f"[team-solve] {phase}" + (f" round {round_no}" if round_no is not None else ""))

    def budget_problem(self) -> str | None:
        if time.time() >= self.deadline:
            return f"total budget expired ({self.state.get('max_hours')} hours)"
        return None

    def require_budget(self) -> None:
        if not self.enforce_budget:
            return
        problem = self.budget_problem()
        if problem:
            raise TeamSolveError(problem)

    def remaining_seconds(self) -> float:
        return max(0.0, self.deadline - time.time())

    def bounded_timeout(self, requested: float) -> float:
        return min(float(requested), self.remaining_seconds())

    def handle_signal(self, signum: int, _frame: Any) -> None:
        self.stop_requested = True

    def register_process(self, proc: subprocess.Popen[bytes]) -> None:
        with self.proc_lock:
            self.current_procs[proc.pid] = proc
        with self.state_lock:
            self.state.setdefault("active_processes", {})[str(proc.pid)] = {
                "pid": proc.pid,
                "pid_start_ticks": proc_start_ticks(proc.pid),
                "pgroup": proc.pid,
                "root_pid": proc.pid,
            }
        self.refresh_process_inventory(force=True)

    def refresh_process_inventory(self, *, force: bool = False) -> None:
        if not self.persist_process_state:
            return
        now = time.time()
        if not force and now - self.last_inventory_refresh < 1:
            return
        self.last_inventory_refresh = now
        with self.proc_lock:
            roots = list(self.current_procs)
        discovered: dict[str, dict[str, Any]] = {}
        for root_pid in roots:
            pids, groups = process_tree(root_pid)
            for pid in pids:
                if pid == os.getpid() or not pid_alive(pid):
                    continue
                discovered[str(pid)] = {
                    "pid": pid,
                    "pid_start_ticks": proc_start_ticks(pid),
                    "pgroup": groups.get(pid, pid),
                    "root_pid": root_pid,
                }
        with self.state_lock:
            active = self.state.setdefault("active_processes", {})
            for key, record in list(active.items()):
                if not isinstance(record, dict):
                    active.pop(key, None)
                    continue
                pid = safe_pid(record.get("pid"))
                if not pid_alive(pid, record.get("pid_start_ticks")):
                    active.pop(key, None)
            active.update(discovered)
            if not active:
                self.state.pop("active_processes", None)
        self.save()

    def unregister_process(self, proc: subprocess.Popen[bytes]) -> None:
        with self.proc_lock:
            self.current_procs.pop(proc.pid, None)
        with self.state_lock:
            active = self.state.setdefault("active_processes", {})
            active.pop(str(proc.pid), None)
            for key, record in list(active.items()):
                if not isinstance(record, dict) or record.get("root_pid") != proc.pid:
                    continue
                pid = safe_pid(record.get("pid"))
                if not pid_alive(pid, record.get("pid_start_ticks")):
                    active.pop(key, None)
            if not active:
                self.state.pop("active_processes", None)
        if self.persist_process_state:
            self.save()

    def terminate_process(self, proc: subprocess.Popen[bytes], grace: float = 10) -> None:
        try:
            pgroup = os.getpgid(proc.pid)
        except OSError:
            pgroup = proc.pid
        stop_process_tree(proc.pid, pgroup == proc.pid, grace=grace)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    def terminate_all(self) -> None:
        with self.proc_lock:
            procs = list(self.current_procs.values())
        for proc in procs:
            self.terminate_process(proc)
        for proc in procs:
            self.unregister_process(proc)

    def install_signals(self) -> None:
        signal.signal(signal.SIGTERM, self.handle_signal)
        signal.signal(signal.SIGINT, self.handle_signal)

    def role_done_path(self, round_no: int, role: str) -> Path:
        round_dir = self.run_dir / f"round-{round_no:02d}"
        if role == "ideate-a":
            return round_dir / "proposals" / "A.md"
        if role == "ideate-b":
            return round_dir / "proposals" / "B.md"
        return round_dir / f"{role}.md"

    def role_key(self, round_no: int, role: str) -> str:
        return f"{round_no:02d}:{role}"

    def role_evidence_paths(self, round_no: int, role: str) -> list[Path]:
        round_dir = self.run_dir / f"round-{round_no:02d}"
        worker = round_dir / ("solve.md" if round_no == 1 else "repair.md")
        task = self.run_dir / "task.md"
        tasks = round_dir / "tasks-before.json"
        plan = round_dir / "plan.md"
        proposal_a = round_dir / "proposals" / "A.md"
        proposal_b = round_dir / "proposals" / "B.md"
        check = round_dir / "check.log"
        diff = round_dir / "diff.txt"
        triage = round_dir / "triage.md"
        review = round_dir / "review.md"
        manager = round_dir / "manager.md"
        if role in {"router", "plan"}:
            return [task]
        if role in {"ideate-a", "ideate-b"}:
            return [task, round_dir / "tasks-initial.json", plan]
        if role in {"solve", "triage"}:
            return [task, tasks, plan, proposal_a, proposal_b, check, diff]
        if role == "review":
            return [task, tasks, plan, proposal_a, proposal_b, check, diff, triage]
        if role == "manager":
            return [task, tasks, plan, proposal_a, proposal_b, check, diff, triage, review, worker]
        if role == "repair":
            previous = self.run_dir / f"round-{round_no - 1:02d}"
            return [
                task,
                tasks,
                self.run_dir / "round-01" / "plan.md",
                previous / "manager.md",
                previous / "triage.md",
                previous / "review.md",
                previous / "diff.txt",
                previous / "check.log",
                manager,
            ]
        if role == "cutoff":
            return [task, plan]
        if role == "audit":
            return [
                task,
                self.run_dir / "tasks.json",
                self.run_dir / "final-check.log",
                self.run_dir / "final-diff.txt",
                *sorted(
                    path
                    for path in self.run_dir.rglob("*")
                    if path.is_file()
                    and path.suffix in {".md", ".json", ".txt", ".log"}
                    and path.name not in {"state.json", "result.json"}
                ),
            ]
        return [task]

    def role_evidence_sha256(self, round_no: int, role: str) -> str:
        digest = hashlib.sha256()
        for path in self.role_evidence_paths(round_no, role):
            try:
                relative = path.relative_to(self.run_dir).as_posix()
            except ValueError:
                relative = str(path)
            digest.update(relative.encode("utf-8", errors="surrogateescape"))
            digest.update(b"\0")
            try:
                data = path.read_bytes()
            except OSError:
                digest.update(b"<missing>")
            else:
                digest.update(len(data).to_bytes(8, "big"))
                digest.update(data)
            digest.update(b"\0")
        return digest.hexdigest()

    def role_prompt_sha256(
        self,
        round_no: int,
        role: str,
        extra_context: str = "",
    ) -> str:
        prompt = role_prompt(role) + "\n\n" + self.role_context(round_no, role)
        if extra_context:
            prompt += "\n\n" + extra_context
        evidence = self.role_evidence_sha256(round_no, role)
        return hashlib.sha256((prompt + "\n\nEVIDENCE\n" + evidence).encode()).hexdigest()

    def load_tasks(self) -> list[dict[str, Any]]:
        path = self.run_dir / "tasks.json"
        try:
            data = read_json(path)
        except (OSError, ValueError):
            data = self.state.get("tasks") or []
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    def save_tasks(self, tasks: list[dict[str, Any]]) -> None:
        self.state["tasks"] = tasks
        atomic_json(self.run_dir / "tasks.json", tasks)
        if self.persist_process_state:
            self.save()

    def prior_role(
        self,
        round_no: int,
        role: str,
        prompt_sha256: str,
        *,
        model: str = "",
        thinking: str = "",
    ) -> str | None:
        key = self.role_key(round_no, role)
        record = (self.state.get("roles") or {}).get(key) or {}
        output = self.role_done_path(round_no, role)
        if record.get("status") != "done" or not output.exists():
            return None
        if record.get("prompt_sha256") != prompt_sha256:
            return None
        if model and record.get("model") != model:
            return None
        if thinking and record.get("thinking") != thinking:
            return None
        try:
            text = output.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        if hashlib.sha256(text.encode()).hexdigest() != record.get("output_sha256"):
            return None
        if text:
            return text
        return None

    def role_context(self, round_no: int, role: str) -> str:
        round_dir = self.run_dir / f"round-{round_no:02d}"
        if role == "audit":
            tasks_path = self.run_dir / "tasks.json"
        elif role in {"ideate-a", "ideate-b"}:
            tasks_path = round_dir / "tasks-initial.json"
        else:
            tasks_path = round_dir / "tasks-before.json"
        try:
            context_tasks = read_json(tasks_path)
        except (OSError, ValueError):
            context_tasks = self.load_tasks()
        if not isinstance(context_tasks, list):
            context_tasks = []
        tasks_text = task_lines(context_tasks)
        base = (
            f"Workspace: {self.workspace}\n"
            f"Task file: {self.run_dir / 'task.md'}\n"
            f"Check command (do not edit): {self.state['check']}\n"
            f"Run directory: {self.run_dir}\n"
            f"Round: {round_no}\n"
            f"Profile: {self.state.get('resolved_profile') or self.state['profile']}\n"
            "Use absolute paths from this context. Do not delegate to another agent.\n"
        )
        if role not in {"router", "plan"}:
            base += (
                f"Task list: {tasks_path}\n"
                f"Current task list:\n{tasks_text}\n"
                f"Current task chosen by the manager: {self.state.get('next_task') or '(none)'}\n"
            )
        if role == "plan":
            return (
                base
                + "Write the plan as your final answer. "
                + f"The orchestrator will save it to {round_dir / 'plan.md'}."
            )
        if role in ("ideate-a", "ideate-b"):
            return base + f"Read {round_dir / 'plan.md'}. Return only your proposal."
        if role == "solve":
            return (
                base
                + f"Read {round_dir / 'plan.md'} and both proposals in {round_dir / 'proposals'}.\n"
                + "Complete the current task as the first milestone toward the full deliverable.\n"
                + "Modify the workspace as needed, then return your completion summary."
            )
        if role == "triage":
            return (
                base
                + f"Read {round_dir / 'check.log'} and {round_dir / 'diff.txt'}.\n"
                + f"The captured check exit status is {self.state.get('last_check', {}).get('exit', 'unknown')}."
            )
        if role == "review":
            return (
                base
                + f"Read {round_dir / 'check.log'}, {round_dir / 'diff.txt'}, "
                + f"{round_dir / 'triage.md'}, and the changed files."
            )
        if role == "manager":
            improvement = ""
            if (
                self.state.get("improve")
                and round_no < int(self.state.get("max_rounds") or 0)
            ):
                improvement = (
                    "\nImprovement mode is active. The check may already pass. "
                    "Return CONTINUE with the highest-value non-check-gaming improvement "
                    "until the final round; reserve DONE for the final round."
                )
            return (
                base
                + f"Read {round_dir / 'plan.md'}, {round_dir / 'triage.md'}, "
                + f"{round_dir / 'review.md'}, {round_dir / 'check.log'}, "
                + f"{round_dir / 'diff.txt'}, and {round_dir / ('solve.md' if round_no == 1 else 'repair.md')}."
                + improvement
            )
        if role == "repair":
            previous = self.run_dir / f"round-{round_no - 1:02d}"
            manager = previous / "manager.md"
            manager_text = manager.read_text(encoding="utf-8", errors="replace") if manager.exists() else ""
            next_task = self.state.get("next_task") or field_value(manager_text, "NEXT_TASK")
            return (
                base
                + f"Read {previous / 'manager.md'}, {previous / 'review.md'}, "
                + f"{previous / 'triage.md'}, {previous / 'diff.txt'}, and {previous / 'check.log'}.\n"
                + f"The manager's next task is: {next_task or '(not present; read manager.md)'}\n"
                + f"Keep the original plan at {self.run_dir / 'round-01' / 'plan.md'} in view."
            )
        if role == "cutoff":
            return base + "Summarize only the cut-off attempt supplied after this context."
        if role == "audit":
            return (
                base
                + f"Read {self.run_dir / 'final-check.log'}, "
                + f"{self.run_dir / 'final-diff.txt'}, "
                + f"{self.run_dir / 'tasks.json'}, and every ledger file in {self.run_dir}."
            )
        return base

    def role_environment(self, round_no: int, role: str) -> dict[str, str]:
        allowed = (
            "PATH",
            "LANG",
            "LC_ALL",
            "TERM",
            "TZ",
            "NO_COLOR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_OAUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "TEAM_SOLVE_TEST_FAKE_PI_LOG",
            "TEAM_SOLVE_TEST_FIX",
        )
        env = {key: os.environ[key] for key in allowed if key in os.environ}
        env.update(
            {
                key: value
                for key, value in os.environ.items()
                if key.startswith("TEAM_SOLVE_TEST_")
            }
        )
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"):
            value = setting(key, include_tracked=False)
            if value:
                env[key] = value

        sandbox = self.run_dir / "sandbox" / f"round-{round_no:02d}" / role
        home = sandbox / "home"
        tmp = sandbox / "tmp"
        pi_agent = sandbox / "pi-agent"
        for path in (home, tmp, pi_agent):
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o700)
        env.update(
            {
                "HOME": str(home),
                "TMPDIR": str(tmp),
                "PI_CODING_AGENT_DIR": str(pi_agent),
                "PI_OFFLINE": "1",
                "PI_TELEMETRY": "0",
                "TEAM_SOLVE_ROLE": role,
                "TEAM_SOLVE_WORKSPACE": str(self.workspace),
            }
        )
        return env

    def run_role(self, round_no: int, role: str, extra_context: str = "") -> str:
        if self.cancel_requested.is_set():
            raise TeamSolveError(f"{role} cancelled after a sibling role failed")
        self.require_budget()
        profile = self.state.get("resolved_profile") or self.state.get("profile")
        if profile not in ROLE_TIERS:
            profile = "coding" if role == "router" else "general"
        model, thinking, tools = role_spec(
            profile,
            role,
            multi_day=bool(self.state.get("multi_day")),
        )
        round_dir = self.run_dir / f"round-{round_no:02d}"
        round_dir.mkdir(parents=True, exist_ok=True)
        output_path = self.role_done_path(round_no, role)
        attempts = int(self.state.get("role_retries", 1)) + 1
        prompt = role_prompt(role) + "\n\n" + self.role_context(round_no, role)
        if extra_context:
            prompt += "\n\n" + extra_context
        evidence_sha256 = self.role_evidence_sha256(round_no, role)
        prompt_sha256 = self.role_prompt_sha256(round_no, role, extra_context)
        cached = self.prior_role(
            round_no,
            role,
            prompt_sha256,
            model=model,
            thinking=thinking,
        )
        if cached is not None:
            log(f"  [{role}] already complete; skipped")
            return cached

        role_record = {
            "status": "running",
            "role": role,
            "round": round_no,
            "model": model,
            "thinking": thinking,
            "tools": tools,
            "prompt_sha256": prompt_sha256,
            "evidence_sha256": evidence_sha256,
            "started_at": utc_now(),
        }
        key = self.role_key(round_no, role)
        with self.state_lock:
            self.state.setdefault("roles", {})[key] = role_record
        self.save()

        last_reason = ""
        for attempt in range(1, attempts + 1):
            self.require_budget()
            attempt_timeout = self.bounded_timeout(self.role_timeout)
            if attempt_timeout <= 0:
                self.require_budget()
            log_path = round_dir / f"{role}.attempt-{attempt}.jsonl"
            err_path = round_dir / f"{role}.attempt-{attempt}.stderr.log"
            role_record.update(
                {
                    "status": "running",
                    "reason": "",
                    "attempt": attempt,
                    "attempt_started_at": utc_now(),
                    "log": os.path.relpath(log_path, self.run_dir),
                    "stderr": os.path.relpath(err_path, self.run_dir),
                }
            )
            with self.state_lock:
                self.state.setdefault("roles", {})[key] = dict(role_record)
            self.save()
            log(f"  [{role}] {model} {thinking} attempt {attempt}/{attempts}")
            cmd = [
                self.pi_bin,
                "--mode",
                "json",
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-context-files",
                "--no-prompt-templates",
                "--no-mcp",
                "--no-approve",
                "--model",
                model,
                "--thinking",
                thinking,
                "--tools",
                tools,
                "--name",
                f"team-{self.state['run_id']}-{round_no}-{role}-{attempt}",
                "--",
                prompt,
            ]
            env = self.role_environment(round_no, role)
            started = time.time()
            with log_path.open("wb") as out, err_path.open("wb") as err:
                try:
                    proc = subprocess.Popen(
                        cmd,
                        cwd=self.workspace,
                        env=env,
                        stdin=subprocess.DEVNULL,
                        stdout=out,
                        stderr=err,
                        start_new_session=True,
                    )
                except OSError as exc:
                    last_reason = f"could not start pi: {exc}"
                    break
                self.register_process(proc)
                timed_out = False
                try:
                    while proc.poll() is None:
                        if self.stop_requested:
                            self.terminate_process(proc)
                            raise TeamStopped("stopped by operator")
                        if self.cancel_requested.is_set():
                            self.terminate_process(proc)
                            raise TeamSolveError(f"{role} cancelled after a sibling role failed")
                        if time.time() - started > attempt_timeout:
                            timed_out = True
                            self.terminate_process(proc)
                            break
                        self.refresh_process_inventory()
                        time.sleep(0.2)
                    rc = proc.wait()
                finally:
                    self.unregister_process(proc)

            seconds = time.time() - started
            parsed = parse_pi_events(log_path)
            reason = ""
            cutoff_summary = ""
            if timed_out:
                reason = f"timed out after {attempt_timeout:.0f}s"
            elif self.stop_requested:
                raise TeamStopped("stopped by operator")
            elif rc != 0:
                reason = f"pi exited {rc}: {tail(err_path, 8)}"
            elif parsed["aborted"]:
                reason = "pi reported an aborted run"
            elif parsed["error"]:
                reason = parsed["error"]
            elif not parsed["settled"]:
                reason = "pi stream ended without agent_settled"
            elif (
                parsed["last_stop"] == "length"
                and role in CUTOFF_SUMMARIZABLE_ROLES
            ):
                parts = []
                if parsed["reasoning"]:
                    parts.append("## Partial reasoning\n" + parsed["reasoning"])
                if parsed["text"]:
                    parts.append("## Partial text\n" + parsed["text"])
                partial = "\n\n".join(parts).strip() or "(no partial text or reasoning was emitted)"
                if len(partial) > 12000:
                    partial = partial[:4500] + "\n\n[middle omitted]\n\n" + partial[-7000:]
                cutoff_dir = self.run_dir / f"round-{round_no:02d}"
                partial_path = cutoff_dir / f"{role}.cutoff.md"
                atomic_text(partial_path, partial.rstrip() + "\n")
                try:
                    cutoff_summary = self.run_role(
                        round_no,
                        "cutoff",
                        extra_context=(
                            f"The cut-off worker role was {role}.\n"
                            f"The original task was: {self.state.get('next_task') or '(read tasks.json)'}\n\n"
                            f"{partial}"
                        ),
                    ).strip()
                except TeamStopped:
                    raise
                except TeamSolveError as exc:
                    reason = f"cut-off attempt could not be summarized: {exc}"
                else:
                    with self.state_lock:
                        self.state["cutoff_count"] = int(self.state.get("cutoff_count") or 0) + 1
                    log(f"  [{role}] cut off at the output limit; summarized for the manager")
            elif parsed["last_stop"] != "stop":
                reason = (
                    f"assistant did not finish cleanly (stopReason={parsed['last_stop'] or 'missing'}): "
                    f"{parsed['last_error'] or 'no detail'}"
                )
            elif role in REQUIRED_OUTPUT_ROLES and not parsed["text"].strip():
                reason = "role returned no text"

            usage = parsed["usage"]
            common = {
                "seconds": round(seconds, 3),
                "attempt": attempt,
                "log": os.path.relpath(log_path, self.run_dir),
                "stderr": os.path.relpath(err_path, self.run_dir),
                "usage": usage,
                "finished_at": utc_now(),
            }
            if not reason:
                if cutoff_summary:
                    output_text = (
                        parsed["text"].rstrip()
                        + "\n\n## Cut-off summary\n"
                        + cutoff_summary.rstrip()
                        + "\n"
                    )
                else:
                    output_text = parsed["text"].rstrip() + "\n"
                atomic_text(output_path, output_text)
                role_record.update(common)
                role_record.update(
                    {
                        "status": "done",
                        "reason": "",
                        "cutoff_summarized": bool(cutoff_summary),
                        "output_sha256": hashlib.sha256(output_text.encode()).hexdigest(),
                    }
                )
            else:
                role_record.update(common)
                role_record.update({"status": "failed", "reason": reason})
            with self.state_lock:
                self.state.setdefault("roles", {})[key] = dict(role_record)
                totals = self.state.setdefault("usage", {})
                for name, value in usage.items():
                    totals[name] = round(float(totals.get(name, 0)) + float(value), 9)
            self.save()
            if not reason:
                log(f"  [{role}] done in {seconds:.0f}s")
                return parsed["text"]
            last_reason = reason
            log(f"  [{role}] failed: {reason}")

        role_record["status"] = "failed"
        role_record["reason"] = last_reason
        with self.state_lock:
            self.state.setdefault("roles", {})[key] = dict(role_record)
        self.save()
        raise TeamSolveError(f"{role} failed: {last_reason}")

    def run_parallel(self, round_no: int, roles: tuple[str, str]) -> tuple[str, str]:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = {role: pool.submit(self.run_role, round_no, role) for role in roles}
            done, _ = concurrent.futures.wait(
                futures.values(),
                return_when=concurrent.futures.FIRST_EXCEPTION,
            )
            for future in done:
                error = future.exception()
                if error is not None:
                    for pending in futures.values():
                        pending.cancel()
                    self.cancel_requested.set()
                    self.terminate_all()
                    raise error
            return futures[roles[0]].result(), futures[roles[1]].result()

    def capture_diff(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        parts = [
            f"captured_at: {utc_now()}",
            f"workspace: {self.workspace}",
        ]
        git = subprocess.run(
            ["git", "-C", str(self.workspace), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if git.returncode != 0 or git.stdout.strip() != "true":
            parts.append("workspace is not a git repository; no diff snapshot available")
        else:
            parts.append(f"\n## status\n{filtered_git_status(self.workspace)}")
            excludes = git_excludes()
            commands = [
                (
                    "diff stat",
                    [
                        "git",
                        "-C",
                        str(self.workspace),
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--stat",
                        "--",
                        ".",
                        *excludes,
                    ],
                ),
                (
                    "diff",
                    [
                        "git",
                        "-C",
                        str(self.workspace),
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--binary",
                        "--",
                        ".",
                        *excludes,
                    ],
                ),
            ]
            for label, command in commands:
                try:
                    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
                except (OSError, subprocess.TimeoutExpired) as exc:
                    parts.append(f"\n## {label}\nERROR: {exc}")
                    continue
                text = (result.stdout + result.stderr).replace(".team-solve/", "<team-solve>/")
                parts.append(f"\n## {label} (exit {result.returncode})\n{text[:1_000_000]}")
                if len(text) > 1_000_000:
                    parts.append(f"\n[truncated {len(text) - 1_000_000} characters]")

            try:
                untracked = subprocess.run(
                    ["git", "-C", str(self.workspace), "ls-files", "--others", "--exclude-standard", "-z"],
                    capture_output=True,
                    timeout=30,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                parts.append(f"\n## untracked files\nERROR: {exc}")
            else:
                names = [
                    name
                    for name in untracked.stdout.decode("utf-8", errors="surrogateescape").split("\0")
                    if name and not name.startswith(f"{STATE_DIR}/") and not sensitive_path(name)
                ]
                parts.append(f"\n## untracked files\n{len(names)} file(s)")
                for name in names:
                    try:
                        result = subprocess.run(
                            [
                                "git",
                                "-C",
                                str(self.workspace),
                                "diff",
                                "--no-index",
                                "--no-textconv",
                                "--binary",
                                "--",
                                os.devnull,
                                name,
                            ],
                            capture_output=True,
                            text=True,
                            errors="replace",
                            timeout=30,
                        )
                    except (OSError, subprocess.TimeoutExpired) as exc:
                        parts.append(f"\n### {name}\nERROR: {exc}")
                        continue
                    text = (result.stdout + result.stderr).replace(".team-solve/", "<team-solve>/")
                    parts.append(f"\n### {name}\n{text[:1_000_000]}")
                    if len(text) > 1_000_000:
                        parts.append(f"\n[truncated {len(text) - 1_000_000} characters]")
        content = "\n".join(parts).rstrip() + "\n"
        if len(content) > 2_000_000:
            content = content[:2_000_000] + f"\n[global diff truncated at 2,000,000 characters]\n"
        atomic_text(destination, content)

    def run_check(self, destination: Path, *, record: bool = True) -> dict[str, Any]:
        self.require_budget()
        timeout_seconds = (
            self.bounded_timeout(self.check_timeout)
            if self.enforce_budget
            else self.check_timeout
        )
        if timeout_seconds <= 0:
            self.require_budget()
        destination.parent.mkdir(parents=True, exist_ok=True)
        started = time.time()
        log(f"  [check] {self.state['check']}")
        with destination.open("wb") as out:
            try:
                proc = subprocess.Popen(
                    ["bash", "--noprofile", "--norc", "-c", self.state["check"]],
                    cwd=self.workspace,
                    stdin=subprocess.DEVNULL,
                    stdout=out,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as exc:
                out.write(f"could not start check: {exc}\n".encode())
                result = {"exit": 127, "timed_out": False, "seconds": 0, "at": utc_now()}
                if record:
                    self.state["last_check"] = result
                    self.save()
                return result
            self.register_process(proc)
            timed_out = False
            try:
                while proc.poll() is None:
                    if self.stop_requested:
                        self.terminate_process(proc)
                        raise TeamStopped("stopped by operator")
                    if time.time() - started > timeout_seconds:
                        timed_out = True
                        self.terminate_process(proc)
                        break
                    self.refresh_process_inventory()
                    time.sleep(0.2)
                rc = proc.wait()
            finally:
                self.unregister_process(proc)
        exit_code = 124 if timed_out else rc
        destination.chmod(0o600)
        result = {
            "exit": exit_code,
            "timed_out": timed_out,
            "seconds": round(time.time() - started, 3),
            "at": utc_now(),
            "log": os.path.relpath(destination, self.run_dir),
        }
        if record:
            self.state["last_check"] = result
            self.save()
        log(f"  [check] exit {exit_code}" + (" (timed out)" if timed_out else ""))
        return result

    def route_profile(self) -> str:
        requested = self.state["profile"]
        if requested != "auto":
            self.state["resolved_profile"] = requested
            self.state["route_reason"] = "explicit --profile"
            self.save()
            return requested
        try:
            text = self.run_role(0, "router")
            data = json.loads(text.strip())
            if not isinstance(data, dict):
                raise ValueError("router response must be a JSON object")
            profile = data.get("profile")
            if profile in ("coding", "everyday", "research", "writing", "general", "high-volume"):
                horizon = data.get("horizon")
                if (
                    horizon in ("session", "multi-day")
                    and self.state.get("multi_day") is None
                ):
                    self.state["multi_day"] = horizon == "multi-day"
                self.state["resolved_profile"] = profile
                self.state["route_reason"] = str(data.get("rationale") or "Haiku router")
                self.save()
                return profile
            reason = "router returned an invalid profile"
        except TeamStopped:
            raise
        except TeamSolveError as exc:
            if self.budget_problem():
                raise
            reason = str(exc)
        except (ValueError, TypeError) as exc:
            reason = f"router returned invalid JSON: {exc}"
        profile = heuristic_profile(self.state["task_text"], self.state["check"])
        if self.state.get("multi_day") is None:
            self.state["multi_day"] = heuristic_multi_day(
                self.state["task_text"],
                self.state["check"],
            )
        self.state["resolved_profile"] = profile
        self.state["route_reason"] = f"fallback after {reason}"
        self.save()
        return profile

    def execute(self) -> int:
        if EARLY_STOP_REQUESTED:
            raise TeamStopped("stopped by operator")
        self.install_signals()
        self.set_phase("preflight")
        if self.state.get("finished"):
            write_result(self.run_dir, self.workspace, self.state)
            report_finished(self)
            return 0 if self.state.get("status") == "solved" else 1

        baseline_path = self.run_dir / "round-00" / "baseline-check.log"
        baseline = self.state.get("baseline_check")
        if not baseline:
            baseline = self.run_check(baseline_path)
            self.state["baseline_check"] = baseline
            self.save()

        if baseline["exit"] == 0 and not self.state.get("improve"):
            self.state["status"] = "solved"
            self.state["finished"] = True
            self.state["finished_at"] = utc_now()
            self.state["summary"] = "verification command already passed; no model work was needed"
            self.state["resolved_profile"] = self.state["profile"] if self.state["profile"] != "auto" else "skipped"
            self.state["route_reason"] = "baseline passed; no routing task was started"
            self.save()
            write_result(self.run_dir, self.workspace, self.state)
            report_finished(self)
            return 0

        profile = self.route_profile()
        self.state["resolved_profile"] = profile
        self.save()
        log(f"[team-solve] profile: {profile} ({self.state.get('route_reason', '')})")

        self.set_phase("plan", 1)
        plan = self.run_role(1, "plan")
        existing_tasks = self.load_tasks()
        tasks = (
            existing_tasks
            if existing_tasks
            else reconcile_tasks([], parse_task_items(plan), "")
        )
        self.save_tasks(tasks)
        initial_tasks = self.run_dir / "round-01" / "tasks-initial.json"
        if not initial_tasks.exists():
            atomic_json(initial_tasks, tasks)
        if tasks and not self.state.get("next_task"):
            self.state["next_task"] = tasks[0]["description"]
        self.set_phase("ideate", 1)
        self.run_parallel(1, ("ideate-a", "ideate-b"))

        rounds = int(self.state["max_rounds"])
        round_no = 1
        check = baseline
        while round_no <= rounds:
            self.require_budget()
            tasks = reconcile_tasks(
                self.load_tasks(),
                self.load_tasks(),
                self.state.get("next_task") or "",
            )
            self.save_tasks(tasks)
            round_dir = self.run_dir / f"round-{round_no:02d}"
            atomic_json(round_dir / "tasks-before.json", tasks)
            if round_no == 1:
                self.set_phase("solve", round_no)
                self.run_role(round_no, "solve")
            else:
                self.set_phase("repair", round_no)
                self.run_role(round_no, "repair")

            self.set_phase("verify", round_no)
            check = self.run_check(self.run_dir / f"round-{round_no:02d}" / "check.log")
            self.state["last_check"] = check
            self.save()

            self.capture_diff(round_dir / "diff.txt")
            self.set_phase("triage", round_no)
            self.run_role(round_no, "triage")
            self.set_phase("review", round_no)
            self.run_role(round_no, "review")
            self.set_phase("manage", round_no)
            self.state.pop("next_task", None)
            manager = self.run_role(round_no, "manager")
            status = field_value(manager, "STATUS").upper()
            next_task = field_value(manager, "NEXT_TASK")
            previous_tasks = self.load_tasks()
            curated = parse_task_items(manager)
            tasks = reconcile_tasks(previous_tasks, curated, next_task)
            if not next_task:
                pending = [task for task in tasks if task.get("status") != "done"]
                if pending:
                    next_task = str(pending[0].get("description") or "")
            tasks = reconcile_tasks(previous_tasks, curated, next_task)
            self.save_tasks(tasks)
            if next_task:
                self.state["next_task"] = next_task
            improving = bool(self.state.get("improve"))
            if (
                check["exit"] == 0
                and status == "DONE"
                and (not improving or round_no >= rounds)
            ):
                break
            if check["exit"] != 0 and status == "DONE":
                log("[team-solve] manager said DONE while the check failed; continuing")
            if improving and check["exit"] == 0 and status == "DONE":
                log("[team-solve] continuing improvement after a passing check")
            if round_no >= rounds:
                break
            if check["exit"] != 0 and not next_task:
                next_task = (
                    "Fix the failing verification command at its root cause, "
                    "or switch to a different approach from the proposals."
                )
                self.state["next_task"] = next_task
                self.save_tasks(
                    reconcile_tasks(
                        self.load_tasks(),
                        self.load_tasks(),
                        next_task,
                    )
                )
            if self.state.get("improve") and not next_task:
                self.state["next_task"] = (
                    "Address the highest-value item in review.md without weakening "
                    "the verification command or its tests."
                )
            round_no += 1

        self.set_phase("final-check", round_no)
        self.capture_diff(self.run_dir / "final-diff.txt")
        final_check = self.run_check(self.run_dir / "final-check.log")
        self.state["final_check"] = final_check
        self.save()

        self.set_phase("audit", round_no)
        try:
            self.run_role(round_no, "audit")
        except TeamStopped:
            raise
        except TeamSolveError as exc:
            self.state.setdefault("warnings", []).append(f"final audit failed: {exc}")
            log(f"[team-solve] warning: final audit failed: {exc}")

        survivors = stop_tracked_processes(self.state)
        if survivors:
            self.state.setdefault("warnings", []).append(
                f"live child processes remained after the final check: {sorted(survivors)}"
            )
        else:
            self.state.pop("active_processes", None)

        self.state["status"] = "solved" if final_check["exit"] == 0 else "failed"
        self.state["finished"] = True
        self.state["finished_at"] = utc_now()
        self.state["summary"] = (
            "verification command passed"
            if final_check["exit"] == 0
            else f"verification command exited {final_check['exit']}"
        )
        self.save()
        write_result(self.run_dir, self.workspace, self.state)
        report_finished(self)
        if final_check["exit"] == 0:
            return 0
        print(tail(self.run_dir / "final-check.log", 200))
        return 1


def extract_content(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def extract_reasoning(message: dict[str, Any]) -> str:
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "thinking":
            continue
        thought = block.get("thinking")
        if isinstance(thought, str):
            parts.append(thought)
    return "\n".join(parts)


def add_usage(target: dict[str, float], usage: Any) -> None:
    if not isinstance(usage, dict):
        return
    for key in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            target[key] = round(target.get(key, 0.0) + float(value), 6)
    cost = usage.get("cost")
    if isinstance(cost, dict):
        total = cost.get("total")
        if isinstance(total, (int, float)):
            target["cost_usd"] = round(target.get("cost_usd", 0.0) + float(total), 9)


def parse_pi_events(path: Path) -> dict[str, Any]:
    text = ""
    reasoning = ""
    last_stop = ""
    last_error = ""
    settled = False
    aborted = False
    usage: dict[str, float] = {}
    fatal = ""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return {
            "text": "",
            "reasoning": "",
            "last_stop": "",
            "last_error": str(exc),
            "settled": False,
            "aborted": False,
            "usage": {},
            "error": f"cannot read pi event log: {exc}",
        }
    for line_no, raw_line in enumerate(raw.split(b"\n"), start=1):
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError as exc:
            if not fatal:
                fatal = f"malformed pi JSON on line {line_no}: {exc}"
            continue
        if not isinstance(event, dict):
            if not fatal:
                fatal = f"malformed pi event on line {line_no}: expected a JSON object"
            continue
        kind = event.get("type")
        if kind == "message_end":
            message = event.get("message")
            if not isinstance(message, dict):
                if not fatal:
                    fatal = f"malformed pi event on line {line_no}: message must be an object"
                continue
            if message.get("role") == "assistant":
                content = message.get("content")
                if content is not None and not isinstance(content, (str, list)):
                    if not fatal:
                        fatal = (
                            f"malformed pi event on line {line_no}: "
                            "assistant content must be a string or array"
                        )
                    continue
                if isinstance(content, list) and any(
                    not isinstance(block, dict) for block in content
                ):
                    if not fatal:
                        fatal = (
                            f"malformed pi event on line {line_no}: "
                            "assistant content blocks must be objects"
                        )
                    continue
                candidate = extract_content(message)
                text = candidate
                reasoning = extract_reasoning(message)
                last_stop = str(message.get("stopReason") or "")
                last_error = str(message.get("errorMessage") or "")
                add_usage(usage, message.get("usage"))
        elif kind == "agent_settled":
            settled = True
            aborted = bool(event.get("aborted"))
        elif kind == "auto_retry_end" and event.get("success") is False:
            fatal = str(event.get("finalError") or "automatic provider retry failed")
    return {
        "text": text,
        "reasoning": reasoning,
        "last_stop": last_stop,
        "last_error": last_error,
        "settled": settled,
        "aborted": aborted,
        "usage": usage,
        "error": fatal,
    }


def heuristic_profile(task: str, check: str) -> str:
    text = f"{task}\n{check}".lower()
    if re.search(r"\b(research|investigat|survey|compare|analysis|literature)\w*", text):
        return "research"
    if re.search(r"\b(high[- ]volume|batch(?:es)?|bulk)\b", text) or (
        re.search(r"\b(classif(?:y|ication)|normaliz(?:e|ation)|routing)\b", text)
        and re.search(r"\b(records?|items?|rows?|documents?|tickets?|requests?)\b", text)
    ):
        return "high-volume"
    if re.search(r"\b(test|build|compile|lint|refactor|fix|implement|code|bug|agent)\w*", text):
        complex_markers = re.search(
            r"\b(architect|distributed|concurr|race|migrat|multi[- ]file|security|"
            r"performance|optimi[sz]|protocol|compiler|database|schema|"
            r"memory|kernel|refactor)\w*",
            text,
        )
        return "coding" if complex_markers or len(text) > 800 else "everyday"
    if re.search(r"\b(write|writing|document|docs?|readme|prose|report|copyedit)\w*", text):
        return "writing"
    return "general"


def heuristic_multi_day(task: str, check: str) -> bool:
    text = f"{task}\n{check}".lower()
    return bool(
        re.search(
            r"\b(multi[- ]day|multi[- ]week|long[- ]horizon|weeks? of work|"
            r"research program|sustained investigation)\b",
            text,
        )
    )


def task_section(text: str) -> str:
    field = re.search(r"(?ims)^\s*TASKS\s*:\s*$([\s\S]*)", text)
    if field:
        return field.group(1)
    heading = re.search(
        r"(?ims)^\s*#{1,6}\s+(?:tasks|milestones)\s*$([\s\S]*?)(?=^\s*#{1,6}\s+|\Z)",
        text,
    )
    return heading.group(1) if heading else ""


def parse_task_items(text: str, maximum: int = 20) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in task_section(text).splitlines():
        match = re.match(r"^\s*[-*]\s+(?:\[([^\]]+)\]\s*)?(.+?)\s*$", line)
        if not match:
            continue
        raw_status = (match.group(1) or "todo").strip().lower().replace("_", "-")
        if raw_status not in {"todo", "done", "in-progress"}:
            raw_status = "todo"
        description = re.sub(r"\s+", " ", match.group(2)).strip()
        if not description:
            continue
        key = description.casefold()
        if key in seen:
            continue
        seen.add(key)
        items.append({"description": description, "status": raw_status})
        if len(items) >= maximum:
            break
    return items


def reconcile_tasks(
    previous: list[dict[str, Any]],
    curated: list[dict[str, str]],
    next_task: str,
) -> list[dict[str, Any]]:
    source = curated or [
        {
            "description": str(item.get("description") or "").strip(),
            "status": str(item.get("status") or "todo").strip().lower(),
        }
        for item in previous
        if isinstance(item, dict)
    ]
    source = [item for item in source if item["description"]]
    if not source:
        source = [
            {
                "description": (
                    next_task
                    or "Satisfy the verification command and clear required review findings."
                ),
                "status": "todo",
            }
        ]

    ids = {
        str(item.get("description") or "").casefold(): int(item.get("id") or 0)
        for item in previous
        if isinstance(item, dict)
    }
    next_id = max([0, *ids.values()]) + 1
    tasks: list[dict[str, Any]] = []
    for item in source[:20]:
        description = str(item["description"]).strip()
        status = str(item.get("status") or "todo").strip().lower()
        if status not in {"todo", "done", "in-progress"}:
            status = "todo"
        task_id = ids.get(description.casefold())
        if not task_id:
            task_id = next_id
            next_id += 1
        tasks.append({"id": task_id, "description": description, "status": status})

    if next_task:
        matched = False
        for task in tasks:
            if task["description"].casefold() == next_task.casefold():
                task["status"] = "in-progress"
                matched = True
                break
        if not matched and len(tasks) < 20:
            tasks.append({"id": next_id, "description": next_task, "status": "in-progress"})
    return tasks


def task_lines(tasks: list[dict[str, Any]], maximum: int = 20) -> str:
    lines = []
    for task in tasks[:maximum]:
        if not isinstance(task, dict):
            continue
        status = str(task.get("status") or "todo").lower()
        label = "done" if status == "done" else "in-progress" if status == "in-progress" else "todo"
        description = str(task.get("description") or "").strip()
        if description:
            lines.append(f"- [{label}] {description}")
    return "\n".join(lines) or "(none)"


def field_value(text: str, name: str) -> str:
    match = re.search(rf"(?m)^\s*{re.escape(name)}\s*:\s*(.+?)\s*$", text)
    return match.group(1).strip() if match else ""


def audit_sort_key(path: Path) -> tuple[int, str]:
    match = re.fullmatch(r"round-(\d+)", path.parent.name)
    return (int(match.group(1)) if match else 0, str(path))


def latest_audit(run_dir: Path) -> Path | None:
    audits = sorted(run_dir.glob("round-*/audit.md"), key=audit_sort_key)
    return audits[-1] if audits else None


@contextmanager
def result_lock(run_dir: Path) -> Iterator[None]:
    path = run_dir / ".result.lock"
    with path.open("a+", encoding="utf-8") as handle:
        path.chmod(0o600)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def write_result_unlocked(run_dir: Path, workspace: Path, state: dict[str, Any]) -> None:
    artifacts = {
        name: os.path.relpath(run_dir / name, workspace)
        for name in ("task.md", "tasks.json", "state.json", "final-check.log", "final-diff.txt")
        if (run_dir / name).exists()
    }
    audit = latest_audit(run_dir)
    if audit:
        artifacts["audit"] = os.path.relpath(audit, workspace)
    result = {
        "version": STATE_VERSION,
        "run_id": state.get("run_id"),
        "status": state.get("status"),
        "summary": state.get("summary"),
        "profile": state.get("resolved_profile") or state.get("profile"),
        "multi_day": bool(state.get("multi_day")),
        "route_reason": state.get("route_reason"),
        "check": state.get("check"),
        "baseline_check": state.get("baseline_check"),
        "last_check": state.get("last_check"),
        "final_check": state.get("final_check"),
        "max_rounds": state.get("max_rounds"),
        "max_hours": state.get("max_hours"),
        "created_at": state.get("created_at"),
        "finished_at": state.get("finished_at"),
        "usage": state.get("usage") or {},
        "tasks": state.get("tasks") or [],
        "cutoff_count": state.get("cutoff_count") or 0,
        "roles": state.get("roles") or {},
        "warnings": state.get("warnings") or [],
        "artifacts": artifacts,
    }
    atomic_json(run_dir / "result.json", result)


def write_result(run_dir: Path, workspace: Path, state: dict[str, Any]) -> None:
    with result_lock(run_dir):
        write_result_unlocked(run_dir, workspace, state)


def report_finished(orchestrator: Orchestrator) -> None:
    status = str(orchestrator.state.get("status") or "unknown").upper()
    summary = orchestrator.state.get("summary") or ""
    log(f"[team-solve] {status}: {summary}")
    audit = latest_audit(orchestrator.run_dir)
    if audit:
        log(f"[team-solve] audit: {audit}")
    log(f"[team-solve] result: {orchestrator.run_dir / 'result.json'}")


def initial_config(args: argparse.Namespace, workspace: Path) -> dict[str, Any]:
    task_text = ""
    if args.task_file:
        task_path = Path(args.task_file)
        if not task_path.is_absolute():
            task_path = workspace / task_path
        if not task_path.is_file():
            raise TeamSolveError(f"task file not found: {task_path}")
        task_text = task_path.read_text(encoding="utf-8", errors="replace")
    elif args.goal:
        task_text = " ".join(args.goal).strip()
    if not task_text:
        task_text = f"Make this verification command pass without weakening it:\n\n{args.check}"
    check = args.check.strip()
    if not check:
        raise TeamSolveError("--check must not be empty")
    profile = args.profile or setting("TEAM_SOLVE_DEFAULT_PROFILE", "auto")
    if profile not in PROFILE_CHOICES:
        raise TeamSolveError(
            "TEAM_SOLVE_DEFAULT_PROFILE must be one of "
            f"{', '.join(PROFILE_CHOICES)}; got {profile!r}"
        )
    rounds = (
        args.rounds
        if args.rounds is not None
        else bounded_int_setting("TEAM_SOLVE_MAX_ROUNDS", 10, 1, 100)
    )
    role_retries = (
        args.role_retries
        if args.role_retries is not None
        else bounded_int_setting("TEAM_SOLVE_ROLE_RETRIES", 1, 0, 5)
    )
    raw_max_hours = args.max_hours
    if raw_max_hours is None:
        raw_max_hours = setting("TEAM_SOLVE_MAX_HOURS", "72")
    max_hours = positive_finite_float(
        raw_max_hours,
        "TEAM_SOLVE_MAX_HOURS" if args.max_hours is None else "--max-hours",
        maximum=MAX_MAX_HOURS,
    )
    role_timeout_raw = args.role_timeout or setting("TEAM_SOLVE_ROLE_TIMEOUT", "4h")
    check_timeout_raw = args.check_timeout or setting("TEAM_SOLVE_CHECK_TIMEOUT", "1h")
    role_timeout = parse_duration(
        role_timeout_raw,
        "--role-timeout" if args.role_timeout else "TEAM_SOLVE_ROLE_TIMEOUT",
    )
    check_timeout = parse_duration(
        check_timeout_raw,
        "--check-timeout" if args.check_timeout else "TEAM_SOLVE_CHECK_TIMEOUT",
    )
    multi_day = getattr(args, "multi_day", None)
    if multi_day is None:
        multi_day = optional_bool(setting("TEAM_SOLVE_MULTI_DAY", ""), "TEAM_SOLVE_MULTI_DAY")
    return {
        "version": STATE_VERSION,
        "run_id": time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6],
        "workspace": str(workspace),
        "task_text": task_text,
        "task_sha256": hashlib.sha256(task_text.encode()).hexdigest(),
        "check": check,
        "profile": profile,
        "max_rounds": rounds,
        "max_hours": max_hours,
        "role_timeout_sec": role_timeout,
        "check_timeout_sec": check_timeout,
        "role_retries": role_retries,
        "multi_day": multi_day,
        "improve": bool(args.improve),
        "created_at": utc_now(),
        "started_epoch": time.time(),
        "status": "created",
        "phase": "created",
        "roles": {},
        "usage": {},
        "warnings": [],
    }


def config_matches(state: dict[str, Any], config: dict[str, Any]) -> bool:
    keys = (
        "workspace",
        "task_sha256",
        "check",
        "profile",
        "max_rounds",
        "improve",
        "multi_day",
    )
    return all(state.get(key) == config.get(key) for key in keys)


def write_task(run_dir: Path, task_text: str) -> None:
    path = run_dir / "task.md"
    path.write_text(task_text.rstrip() + "\n", encoding="utf-8")
    path.chmod(0o600)


def create_run(workspace: Path, config: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    home = state_home(workspace)
    home.mkdir(parents=True, exist_ok=True)
    home.chmod(0o700)
    run_dir = home / "runs" / config["run_id"]
    run_dir.mkdir(parents=True, exist_ok=False)
    run_dir.chmod(0o700)
    write_task(run_dir, config["task_text"])
    atomic_json(run_dir / "state.json", config)
    set_current(workspace, run_dir)
    return run_dir, config


def load_current(workspace: Path) -> tuple[Path, dict[str, Any]] | None:
    run_dir = current_run_dir(workspace)
    if run_dir is None or not (run_dir / "state.json").exists():
        return None
    return run_dir, read_json(run_dir / "state.json")


def active_problem(state: dict[str, Any]) -> str | None:
    status = state.get("status")
    if status == "running" and pid_alive(safe_pid(state.get("pid")), state.get("pid_start_ticks")):
        return f"run {state.get('run_id')} is already active in process {state.get('pid')}"
    for record in (state.get("active_processes") or {}).values():
        if not isinstance(record, dict):
            continue
        pid = safe_pid(record.get("pid"))
        if pid_alive(pid, record.get("pid_start_ticks")):
            return (
                f"run {state.get('run_id')} still has a live child process {pid}; "
                "use /team-solve stop before resuming"
            )
    return None


def cmd_run(args: argparse.Namespace) -> int:
    workspace = Path(args.dir).expanduser().resolve()
    if not workspace.is_dir():
        raise TeamSolveError(f"workspace is not a directory: {workspace}")
    problem = backend_problem()
    if problem:
        raise TeamSolveError(problem)
    config = initial_config(args, workspace)
    with claim_run_lock(workspace):
        existing = load_current(workspace)
        if not args.fresh and existing:
            old_dir, old_state = existing
            if config_matches(old_state, config) and not old_state.get("finished"):
                active = active_problem(old_state)
                if active:
                    raise TeamSolveError(active)
                log(f"[team-solve] resuming {old_state['run_id']} from {old_dir}")
                orchestrator = Orchestrator(workspace, old_dir, old_state)
                return orchestrator.execute()
        if existing:
            active = active_problem(existing[1])
            if active:
                raise TeamSolveError(active)
        run_dir, state = create_run(workspace, config)
        log(f"[team-solve] run {state['run_id']} in {run_dir}")
        orchestrator = Orchestrator(workspace, run_dir, state)
        return orchestrator.execute()


def cmd_resume(args: argparse.Namespace) -> int:
    workspace = Path(args.dir).expanduser().resolve()
    if not workspace.is_dir():
        raise TeamSolveError(f"workspace is not a directory: {workspace}")
    problem = backend_problem()
    if problem:
        raise TeamSolveError(problem)
    if not current_path(workspace).exists():
        raise TeamSolveError(f"no previous team-solve run in {workspace}")
    with claim_run_lock(workspace):
        existing = load_current(workspace)
        if not existing:
            raise TeamSolveError(f"no previous team-solve run in {workspace}")
        run_dir, state = existing
        active = active_problem(state)
        if active:
            raise TeamSolveError(active)
        if state.get("finished") and state.get("status") == "solved":
            checker = Orchestrator(
                workspace,
                run_dir,
                state,
                activate=False,
                enforce_budget=False,
            )
            rechecked = checker.run_check(run_dir / "resume-check.log", record=False)
            state["last_check"] = rechecked
            state["final_check"] = rechecked
            if rechecked["exit"] == 0:
                state["summary"] = "verification command still passes after resume recheck"
                state["finished_at"] = utc_now()
                checker.save()
                write_result(run_dir, workspace, state)
                print_status(workspace, state)
                return 0
            state["status"] = "running"
            state["finished"] = False
            state["finished_at"] = utc_now()
            state["summary"] = "resume recheck failed; reopening the team run"
            state.setdefault("warnings", []).append(
                f"resume recheck exited {rechecked['exit']}; prior solved state was reopened"
            )
            checker.save()
        if args.max_hours is not None:
            state["max_hours"] = positive_finite_float(
                args.max_hours,
                "--max-hours",
                maximum=MAX_MAX_HOURS,
            )
            state["started_epoch"] = time.time()
        state["status"] = "running"
        state["finished"] = False
        state.pop("finished_at", None)
        state.pop("summary", None)
        Orchestrator(
            workspace,
            run_dir,
            state,
            activate=False,
        )
        with result_lock(run_dir):
            result_path = run_dir / "result.json"
            if result_path.exists():
                result_path.unlink()
            orchestrator = Orchestrator(workspace, run_dir, state)
        return orchestrator.execute()


def print_status(workspace: Path, state: dict[str, Any]) -> None:
    pid = safe_pid(state.get("pid"))
    live = pid_alive(pid, state.get("pid_start_ticks"))
    print(f"run       {state.get('run_id')}")
    print(f"status    {state.get('status')}" + (" (process alive)" if live else ""))
    print(f"phase     {state.get('phase')}  round {state.get('current_round', 0)}/{state.get('max_rounds')}")
    profile = state.get("resolved_profile") or state.get("profile")
    print(f"profile   {profile}  {state.get('route_reason', '')}".rstrip())
    print(f"horizon   {'multi-day' if state.get('multi_day') else 'session'}")
    tasks = state.get("tasks") or []
    if tasks:
        done = sum(
            1
            for task in tasks
            if isinstance(task, dict) and task.get("status") == "done"
        )
        print(f"tasks     {done}/{len(tasks)} done  next: {state.get('next_task') or '(none)'}")
    check = state.get("last_check") or {}
    if check:
        print(f"check     exit {check.get('exit')}  {check.get('seconds', '?')}s")
    usage = state.get("usage") or {}
    if usage:
        print(
            "usage     "
            f"input {int(usage.get('input', 0)):,}  output {int(usage.get('output', 0)):,}"
            f"  cost ${float(usage.get('cost_usd', 0)):.4f}"
        )
    roles = state.get("roles") or {}
    if roles:
        print("roles")
        for key, item in sorted(roles.items(), key=role_record_sort_key):
            detail = item.get("reason") or ""
            print(
                f"  {key:<22} {item.get('status', '?'):<8} "
                f"{item.get('model', '?'):<32} {item.get('seconds', 0):>7}s  {compact_text(detail, 90)}"
            )
    if state.get("finished_at"):
        print(f"finished  {state['finished_at']}  {state.get('summary', '')}")
    if state.get("warnings"):
        print("warnings")
        for warning in state["warnings"]:
            print(f"  {warning}")


def role_record_sort_key(item: tuple[str, dict[str, Any]]) -> tuple[int, int, str, str]:
    key, record = item
    round_no = int(record.get("round") or key.split(":", 1)[0] or 0)
    attempt = int(record.get("attempt") or 0)
    started = str(record.get("attempt_started_at") or record.get("started_at") or "")
    return round_no, attempt, started, key


def role_log_path(run_dir: Path, record: dict[str, Any], key: str) -> Path:
    raw = record.get("log")
    if raw:
        return run_dir / str(raw)
    role = str(record.get("role") or key.split(":", 1)[-1])
    round_no = int(record.get("round") or key.split(":", 1)[0] or 0)
    attempt = int(record.get("attempt") or 1)
    return run_dir / f"round-{round_no:02d}" / f"{role}.attempt-{attempt}.jsonl"


def latest_role_record(
    state: dict[str, Any],
    role: str,
) -> tuple[str, dict[str, Any]] | None:
    records = [
        (key, value)
        for key, value in (state.get("roles") or {}).items()
        if value.get("role") == role
    ]
    return max(records, key=role_record_sort_key) if records else None


def latest_running_role(
    state: dict[str, Any],
    roles: set[str],
) -> tuple[str, dict[str, Any]] | None:
    records = [
        (key, value)
        for key, value in (state.get("roles") or {}).items()
        if value.get("role") in roles and value.get("status") == "running"
    ]
    return max(records, key=role_record_sort_key) if records else None


def cmd_status(args: argparse.Namespace) -> int:
    workspace = Path(args.dir).expanduser().resolve()
    existing = load_current(workspace)
    if not existing:
        print(f"no team-solve run in {workspace}")
        return 1
    run_dir, state = existing
    if state.get("finished"):
        with result_lock(run_dir):
            latest = read_json(run_dir / "state.json")
            state = latest
            if latest.get("finished"):
                write_result_unlocked(run_dir, workspace, latest)
    print_status(workspace, state)
    return 0 if state.get("status") not in ("failed", "error", "stopped") else 1


def cmd_logs(args: argparse.Namespace) -> int:
    workspace = Path(args.dir).expanduser().resolve()
    existing = load_current(workspace)
    if not existing:
        raise TeamSolveError(f"no team-solve run in {workspace}")
    run_dir, state = existing
    if args.role:
        mapped_role = "manager" if args.role == "manage" else args.role
        if mapped_role in ("check", "verify"):
            round_no = int(state.get("current_round") or 0)
            path = (
                run_dir / f"round-{round_no:02d}" / "check.log"
                if round_no
                else run_dir / "final-check.log"
            )
        elif mapped_role == "final-check":
            path = run_dir / "final-check.log"
        elif mapped_role == "baseline":
            path = run_dir / "round-00" / "baseline-check.log"
        else:
            selected = latest_role_record(state, mapped_role)
            if not selected:
                raise TeamSolveError(f"no logs for role {args.role!r}")
            key, record = selected
            path = role_log_path(run_dir, record, key)
    else:
        role = str(state.get("phase") or "")
        if role in ("check", "verify"):
            round_no = int(state.get("current_round") or 0)
            path = (
                run_dir / f"round-{round_no:02d}" / "check.log"
                if round_no
                else run_dir / "final-check.log"
            )
        elif role == "final-check":
            path = run_dir / "final-check.log"
        elif role in ("preflight", "created"):
            selected = latest_running_role(state, {"router"})
            if selected:
                key, record = selected
                path = role_log_path(run_dir, record, key)
            else:
                path = run_dir / "round-00" / "baseline-check.log"
        elif role == "ideate":
            selected = (
                latest_running_role(state, {"ideate-a", "ideate-b"})
                or latest_role_record(state, "ideate-b")
                or latest_role_record(state, "ideate-a")
            )
            if selected:
                key, record = selected
                path = role_log_path(run_dir, record, key)
            else:
                path = run_dir / "launcher.log"
        else:
            mapped_role = "manager" if role == "manage" else role
            selected = latest_role_record(state, mapped_role)
            if selected:
                key, record = selected
                path = role_log_path(run_dir, record, key)
            else:
                path = run_dir / "launcher.log"
    print(str(path))
    print(tail(path, args.lines))
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    workspace = Path(args.dir).expanduser().resolve()
    if not workspace.is_dir():
        raise TeamSolveError(f"workspace is not a directory: {workspace}")
    if not current_path(workspace).exists():
        raise TeamSolveError(f"no team-solve run in {workspace}")
    with claim_run_lock(workspace):
        existing = load_current(workspace)
        if not existing:
            raise TeamSolveError(f"no team-solve run in {workspace}")
        run_dir, state = existing
        check = args.check or state.get("check")
        if not check:
            raise TeamSolveError("the saved run has no check command")
        effective_state = dict(state)
        effective_state["check"] = check
        orchestrator = Orchestrator(
            workspace,
            run_dir,
            effective_state,
            activate=False,
            enforce_budget=False,
        )
        result = orchestrator.run_check(run_dir / "manual-check.log", record=False)
        print(f"exit {result['exit']}")
        print(tail(run_dir / "manual-check.log", args.lines))
        return 0 if result["exit"] == 0 else 1


def cmd_stop(args: argparse.Namespace) -> int:
    workspace = Path(args.dir).expanduser().resolve()
    existing = load_current(workspace)
    if not existing:
        raise TeamSolveError(f"no team-solve run in {workspace}")
    run_dir, state = existing
    pid = safe_pid(state.get("pid"))
    pid_ticks = state.get("pid_start_ticks")
    was_alive = pid_alive(pid, pid_ticks)
    survivors: set[int] = set()
    active_records = dict(state.get("active_processes") or {})
    if was_alive:
        survivors = stop_process_tree(
            pid,
            bool(state.get("owns_process_group")),
            grace=10,
        )

    survivors |= stop_tracked_processes({"active_processes": active_records})
    if survivors:
        print(f"stop incomplete for run {state.get('run_id')}: live pids {sorted(survivors)}")
        return 1

    try:
        with claim_run_lock(workspace):
            latest = read_json(run_dir / "state.json")
            if safe_pid(latest.get("pid")) != pid or latest.get("pid_start_ticks") != pid_ticks:
                print(
                    f"run {state.get('run_id')} changed process generation during stop; "
                    "the new generation was left running"
                )
                return 1
            terminal = latest.get("status") in ("solved", "failed", "error", "stopped")
            if not latest.get("finished") and not terminal:
                latest["status"] = "stopped"
                latest["finished"] = True
                latest["finished_at"] = utc_now()
                latest["summary"] = (
                    "stopped by operator"
                    if was_alive
                    else "stopped by operator (process was no longer alive)"
                )
                finish_running_roles(latest, "stopped", str(latest["summary"]))
                atomic_json(run_dir / "state.json", latest)
            if latest.get("finished"):
                write_result(run_dir, workspace, latest)
    except TeamSolveError as exc:
        print(f"stop could not acquire the run state after termination: {exc}")
        return 1

    if not was_alive:
        print("run is not active")
    else:
        print(f"stopped run {state.get('run_id')}")
    return 0


def requested_workspace(args: argparse.Namespace) -> Path:
    return Path(getattr(args, "dir", ".")).expanduser().resolve()


def finish_running_roles(
    state: dict[str, Any],
    status: str,
    reason: str,
    *,
    clear_processes: bool = True,
) -> None:
    for record in (state.get("roles") or {}).values():
        if not isinstance(record, dict) or record.get("status") != "running":
            continue
        record["status"] = status
        record["reason"] = reason
        record["finished_at"] = utc_now()
    if clear_processes:
        state.pop("active_processes", None)


def safe_pid(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def terminalize_claimed_run(
    args: argparse.Namespace | None,
    status: str,
    summary: str,
) -> bool:
    """Finalize only the run this invocation actually activated."""
    global CLAIMED_RUN
    try:
        if CLAIMED_RUN is None or args is None or not hasattr(args, "dir"):
            return False
        claimed_workspace, run_dir = CLAIMED_RUN
        if claimed_workspace.resolve() != requested_workspace(args):
            return False
        try:
            state = read_json(run_dir / "state.json")
        except (OSError, ValueError):
            return False
        if safe_pid(state.get("pid")) != os.getpid():
            return False
        if state.get("finished") and state.get("status") != "running":
            write_result(run_dir, claimed_workspace, state)
            return False

        survivors = stop_tracked_processes(state)
        if survivors:
            summary = f"{summary}; live child processes remain: {sorted(survivors)}"
        state["status"] = status
        state["finished"] = True
        state["finished_at"] = utc_now()
        state["summary"] = summary
        role_status = "stopped" if status == "stopped" else "failed"
        finish_running_roles(
            state,
            role_status,
            summary,
            clear_processes=not survivors,
        )
        atomic_json(run_dir / "state.json", state)
        write_result(run_dir, claimed_workspace, state)
        return True
    except Exception as exc:
        log(f"[team-solve] could not record terminal state: {type(exc).__name__}: {exc}")
        return False


def validate_cli_number(args: argparse.Namespace) -> None:
    value = getattr(args, "max_hours", None)
    if value is not None:
        positive_finite_float(value, "--max-hours", maximum=MAX_MAX_HOURS)


def cmd_preview(args: argparse.Namespace) -> int:
    backend = setting("STACK_BACKEND", "local")
    profile = args.profile
    print(f"backend   {backend}")
    print(f"profile   {profile}")
    print(f"check     {args.check}")
    print("")
    profiles = (
        [profile]
        if profile != "auto"
        else ["coding", "everyday", "research", "writing", "general", "high-volume"]
    )
    for name in profiles:
        print(name)
        roles = (
            "router",
            "plan",
            "ideate-a",
            "ideate-b",
            "solve",
            "cutoff",
            "triage",
            "review",
            "manager",
            "repair",
            "audit",
        )
        multi_day = args.multi_day
        if multi_day is None:
            multi_day = optional_bool(
                setting("TEAM_SOLVE_MULTI_DAY", ""),
                "TEAM_SOLVE_MULTI_DAY",
            )
        print(f"horizon   {'multi-day' if multi_day else 'session'}")
        for role in roles:
            model, thinking, tools = role_spec(name, role, multi_day=bool(multi_day))
            access = "write" if role in WRITABLE_ROLES else "read-only"
            print(f"  {role:<10} {model:<34} thinking={thinking:<6} {access}")
        print("")
    return 0


def cmd_help(_args: argparse.Namespace) -> int:
    print(COMMAND_HELP)
    return 0


COMMAND_HELP = """\
/team-solve run [goal words] --check "COMMAND" [options]
    Start or resume a durable, command-checked Anthropic team run.
    --task-file FILE        use a statement file instead of inline goal words
    --profile PROFILE       auto, coding, everyday, research, writing, general, high-volume
    --rounds N              maximum repair rounds (default 10)
    --max-hours H           total wall-clock budget (default 72)
    --role-timeout D        per-role limit, e.g. 30m, 4h (default 4h)
    --check-timeout D       per-check limit, e.g. 10m, 1h (default 1h)
    --multi-day             promote planning/management/audit to Fable
    --improve               keep improving after the check starts passing
    --fresh                 start a new run instead of resuming a matching one

/team-solve resume [--max-hours H]
    Continue the current durable run from its completed role markers.

/team-solve status
    Show phase, round, models, check status, usage, and role outcomes.

/team-solve logs [--role ROLE] [--lines N]
    Show the latest role JSONL or active check log.

/team-solve check [--check "COMMAND"]
    Rerun the saved command without invoking a model.

/team-solve stop
    Stop the detached run and its active pi/check child process.

/team-solve preview --check "COMMAND" [--profile PROFILE] [--multi-day]
    Print the model/role allocation without making a model call.

Ground truth is always the verification command. A model cannot mark a failing
check as done. Runs continue after leaving pi; use status/resume/stop here.
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="team-solve", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="start or resume a run")
    run.add_argument("goal", nargs="*", help="task statement; quote it as one argument")
    add_run_options(run, resume=False)
    run.set_defaults(func=cmd_run)

    resume = sub.add_parser("resume", help="resume the current run")
    resume.add_argument("--dir", default=".")
    resume.add_argument("--max-hours", type=float)
    resume.set_defaults(func=cmd_resume)

    status = sub.add_parser("status", help="show run status")
    status.add_argument("--dir", default=".")
    status.set_defaults(func=cmd_status)

    logs = sub.add_parser("logs", help="show role logs")
    logs.add_argument("--dir", default=".")
    logs.add_argument("--role")
    logs.add_argument("--lines", type=int, default=120)
    logs.set_defaults(func=cmd_logs)

    check = sub.add_parser("check", help="rerun the check")
    check.add_argument("--dir", default=".")
    check.add_argument("--check")
    check.add_argument("--lines", type=int, default=120)
    check.set_defaults(func=cmd_check)

    stop = sub.add_parser("stop", help="stop the current run")
    stop.add_argument("--dir", default=".")
    stop.set_defaults(func=cmd_stop)

    preview = sub.add_parser("preview", help="show model allocation")
    preview.add_argument("--profile", choices=PROFILE_CHOICES, default="auto")
    preview.add_argument("--check", default='<verification command>')
    preview.add_argument(
        "--multi-day",
        action=argparse.BooleanOptionalAction,
        default=None,
    )
    preview.set_defaults(func=cmd_preview)

    help_cmd = sub.add_parser("help", help="show command help")
    help_cmd.set_defaults(func=cmd_help)
    return parser


def add_run_options(parser: argparse.ArgumentParser, *, resume: bool) -> None:
    parser.add_argument("--dir", default=".")
    parser.add_argument("--task-file")
    parser.add_argument("--check", required=not resume)
    parser.add_argument("--profile", choices=PROFILE_CHOICES)
    parser.add_argument("--rounds", type=int)
    parser.add_argument("--max-hours", type=float)
    parser.add_argument("--role-timeout")
    parser.add_argument("--check-timeout")
    parser.add_argument("--role-retries", type=int)
    parser.add_argument(
        "--multi-day",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="promote planning, management, and audit to Fable for sustained work",
    )
    parser.add_argument("--improve", action="store_true")
    parser.add_argument("--fresh", action="store_true")


def main(argv: list[str] | None = None) -> int:
    global CLAIMED_RUN, EARLY_STOP_REQUESTED
    CLAIMED_RUN = None
    EARLY_STOP_REQUESTED = False
    args: argparse.Namespace | None = None
    previous_handlers: dict[int, Any] = {}
    try:
        parser = build_parser()
        args = parser.parse_args(argv)
        if getattr(args, "cmd", "") in ("run", "resume"):
            for signum in (signal.SIGTERM, signal.SIGINT):
                previous_handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, request_early_stop)
        if getattr(args, "cmd", "") in ("run", "resume") and os.environ.get("TEAM_SOLVE_ROLE"):
            raise TeamSolveError(
                f"refusing to start a team run inside role {os.environ['TEAM_SOLVE_ROLE']!r}"
            )
        profile = getattr(args, "profile", None)
        if profile is not None and profile not in PROFILE_CHOICES:
            raise TeamSolveError(
                f"TEAM_SOLVE_DEFAULT_PROFILE must be one of {', '.join(PROFILE_CHOICES)}; got {profile!r}"
            )
        rounds = getattr(args, "rounds", None)
        if rounds is not None and (rounds < 1 or rounds > 100):
            raise TeamSolveError("--rounds must be between 1 and 100")
        retries = getattr(args, "role_retries", None)
        if retries is not None and (retries < 0 or retries > 5):
            raise TeamSolveError("--role-retries must be between 0 and 5")
        validate_cli_number(args)
        if hasattr(args, "lines") and args.lines < 1:
            raise TeamSolveError("--lines must be greater than zero")
        return int(args.func(args))
    except TeamStopped as exc:
        terminalize_claimed_run(args, "stopped", str(exc))
        log(f"[team-solve] stopped: {exc}")
        return 130
    except KeyboardInterrupt:
        terminalize_claimed_run(args, "stopped", "stopped by operator")
        log("[team-solve] stopped by operator")
        return 130
    except (TeamSolveError, OSError, ValueError, TypeError) as exc:
        terminalize_claimed_run(args, "error", str(exc))
        log(f"[team-solve] {exc}")
        return 2
    except Exception as exc:
        summary = f"{type(exc).__name__}: {exc}"
        terminalize_claimed_run(args, "error", summary)
        log(f"[team-solve] internal error: {summary}")
        return 2
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main())
