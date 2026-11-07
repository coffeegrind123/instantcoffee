#!/usr/bin/env python3
"""End-to-end tests for the pi-native Anthropic team-solve orchestrator."""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from unittest.mock import patch


REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "team-solve" / "team_solve.py"
PROMPTS = REPO / "scripts" / "team-solve" / "prompts.py"


FAKE_PI = r'''#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import sys
import time

role = os.environ["TEAM_SOLVE_ROLE"]
if role == os.environ.get("TEAM_SOLVE_TEST_FAIL_ROLE"):
    time.sleep(float(os.environ.get("TEAM_SOLVE_TEST_FAIL_DELAY", "0")))
    sys.exit(7)
args = sys.argv[1:]
record = {
    "role": role,
    "args": args,
    "started": time.time(),
}
workspace = pathlib.Path.cwd()
if role in ("ideate-a", "ideate-b", "direct", "plan"):
    time.sleep(0.2)
sleep_roles = {
    item.strip()
    for item in os.environ.get("TEAM_SOLVE_TEST_SLEEP_ROLES", "").split(",")
    if item.strip()
}
if role in sleep_roles:
    pid_dir = pathlib.Path(os.environ["TEAM_SOLVE_TEST_PIDS"])
    pid_dir.mkdir(parents=True, exist_ok=True)
    record_path = pid_dir / f"{role}.json"
    child_pid = None
    detached_pid = None
    if os.environ.get("TEAM_SOLVE_TEST_DESCENDANTS") == "1":
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(120)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        child_pid = child.pid
        detached = subprocess.Popen(
            [sys.executable, "-c", "import os, time; os.setsid(); time.sleep(120)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        detached_pid = detached.pid
    record_path.write_text(
        json.dumps(
            {
                "role": role,
                "pid": os.getpid(),
                "child": child_pid,
                "detached": detached_pid,
            }
        ),
        encoding="utf-8",
    )
    time.sleep(120)

fix_roles = {
    item.strip()
    for item in os.environ.get("TEAM_SOLVE_TEST_FIX_ROLES", "solve").split(",")
    if item.strip()
}
if role in fix_roles and os.environ.get("TEAM_SOLVE_TEST_FIX", "1") == "1":
    (workspace / "fixed.txt").write_text("fixed\n", encoding="utf-8")

# TEAM_SOLVE_TEST_WRITES: {"role": [[path, content], ...]} written by that role.
for path, content in json.loads(os.environ.get("TEAM_SOLVE_TEST_WRITES", "{}")).get(role, []):
    target = workspace / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def next_in(name, default):
    """The n-th call of a role gets the n-th entry of TEAM_SOLVE_TEST_<NAME> (the last repeats)."""
    items = [item for item in os.environ.get(f"TEAM_SOLVE_TEST_{name}", "").split(",") if item]
    if not items:
        return default
    counter = pathlib.Path(os.environ["TEAM_SOLVE_TEST_FAKE_PI_LOG"] + f".{name}")
    used = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(used + 1))
    return items[min(used, len(items) - 1)]

if role == "router" and os.environ.get("TEAM_SOLVE_TEST_MALFORMED_ROUTER") == "1":
    print("{not valid json", flush=True)
    text = '{"profile":"coding","rationale":"implementation task"}'
elif role == "router" and os.environ.get("TEAM_SOLVE_TEST_ROUTER_PAYLOAD") == "array":
    text = '[{"profile":"coding","rationale":"array must be rejected"}]'
elif role == "router":
    text = json.dumps(
        {
            "profile": os.environ.get("TEAM_SOLVE_TEST_ROUTER_PROFILE", "coding"),
            "horizon": os.environ.get("TEAM_SOLVE_TEST_ROUTER_HORIZON", "session"),
            "rationale": "implementation task",
        }
    )
elif role == "manager":
    if next_in("MANAGERS", "") == "CONTINUE" or os.environ.get("TEAM_SOLVE_TEST_MANAGER_CONTINUE") == "1":
        text = (
            "STATUS: CONTINUE\n"
            "NEXT_TASK: create fixed.txt\n"
            "WHY: the check still fails\n"
            "TASKS:\n"
            "- [done] inspect the workspace\n"
            "- [todo] create fixed.txt\n"
        )
    else:
        text = (
            "STATUS: DONE\n"
            "WHY: fixed.txt now exists\n"
            "TASKS:\n"
            "- [done] create fixed.txt\n"
        )
elif role == "cutoff":
    text = (
        "The worker pursued a direct implementation and established that fixed.txt "
        "was required. It did not finish its final verification summary."
    )
elif role == "triage":
    text = "CLASS: implementation\nEVIDENCE: fixed.txt\nREPAIR: implemented\nAVOID: none"
elif role == "review":
    verdict = next_in("REVIEWS", "PASS")
    text = f"## Verdict\n{verdict}\n\n## Findings\nNone\n\n## Required next action\nNone\n\n## Residual risks\nNone"
elif role == "judge":
    text = f"verdict: {next_in('JUDGES', 'PASS')}\nthe change against the task"
elif role == "plan" and os.environ.get("TEAM_SOLVE_TEST_PLAN_CHECK"):
    text = (
        "## Deliverable\nchanges to this tree\n\n"
        f"## Check\n{os.environ['TEAM_SOLVE_TEST_PLAN_CHECK']}\n\n"
        "## Scope\n`.`\n\n"
        "## Done when\n- (inferred) the task is done\n\n"
        "## Tasks\n- [todo] do the task\n"
    )
else:
    text = f"{role} complete"

stop_reason = "length" if role == os.environ.get("TEAM_SOLVE_TEST_STOP_LENGTH_ROLE") else "stop"
message = {
    "type": "message_end",
    "message": {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "stopReason": stop_reason,
        "usage": {
            "input": 10,
            "output": 2,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 12,
            "cost": {"total": 0.001},
        },
    },
}
print(json.dumps(message), flush=True)
if role == os.environ.get("TEAM_SOLVE_TEST_EMPTY_FINAL_ROLE"):
    empty = {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": ""}],
            "stopReason": "stop",
        },
    }
    print(json.dumps(empty), flush=True)
print(json.dumps({"type": "agent_settled", "aborted": False}), flush=True)
record["finished"] = time.time()
with open(os.environ["TEAM_SOLVE_TEST_FAKE_PI_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record) + "\n")
'''


def write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def load_module():
    spec = importlib.util.spec_from_file_location("team_solve_under_test", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TeamSolvePi(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="team-solve-pi-test-")
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.workspace, check=True)
        self.fake_pi = self.root / "fake-pi"
        self.record = self.root / "pi-calls.jsonl"
        write_executable(self.fake_pi, FAKE_PI)
        self.env = {
            **os.environ,
            "STACK_BACKEND": "anthropic",
            "ANTHROPIC_API_KEY": "test-key-not-real",
            "TEAM_SOLVE_PI_BIN": str(self.fake_pi),
            "TEAM_SOLVE_TEST_FAKE_PI_LOG": str(self.record),
            "TEAM_SOLVE_ROLE_TIMEOUT": "10s",
            "TEAM_SOLVE_CHECK_TIMEOUT": "5s",
            "TEAM_SOLVE_MAX_HOURS": "1",
            "TEAM_SOLVE_DEFAULT_PROFILE": "auto",
            "TEAM_SOLVE_TEST_FIX": "1",
        }
        for key in list(self.env):
            if key.startswith("TEAM_SOLVE_") and key not in {
                "TEAM_SOLVE_PI_BIN",
                "TEAM_SOLVE_ROLE_TIMEOUT",
                "TEAM_SOLVE_CHECK_TIMEOUT",
                "TEAM_SOLVE_MAX_HOURS",
                "TEAM_SOLVE_DEFAULT_PROFILE",
                "TEAM_SOLVE_TEST_FAKE_PI_LOG",
                "TEAM_SOLVE_TEST_FIX",
            }:
                self.env.pop(key, None)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_team(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--dir", str(self.workspace)]
            if args and args[0] not in {"help", "preview"}
            else [sys.executable, str(SCRIPT), *args],
            cwd=self.workspace,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def start_team(self, *args: str) -> subprocess.Popen[str]:
        return subprocess.Popen(
            [sys.executable, str(SCRIPT), *args, "--dir", str(self.workspace)],
            cwd=self.workspace,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )

    def wait_for(self, predicate, timeout: float = 15) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail("timed out waiting for test condition")

    @staticmethod
    def process_alive(pid: int) -> bool:
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().split()
        except OSError:
            return False
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return len(fields) > 2 and fields[2] != "Z"

    def records(self) -> list[dict[str, object]]:
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines() if line.strip()]

    def current_run(self) -> Path:
        pointer = json.loads((self.workspace / ".team-solve" / "current.json").read_text())
        return self.workspace / pointer["run_dir"]

    def test_end_to_end_parallel_roles_and_authoritative_final_check(self) -> None:
        result = self.run_team(
            "run",
            "implement the missing file",
            "--check",
            "test -f fixed.txt",
            "--rounds",
            "2",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("SOLVED", result.stderr)

        run_dir = self.current_run()
        state = json.loads((run_dir / "state.json").read_text())
        result_json = json.loads((run_dir / "result.json").read_text())
        self.assertEqual(state["status"], "solved")
        self.assertEqual(state["resolved_profile"], "coding")
        self.assertEqual(state["final_check"]["exit"], 0)
        self.assertEqual(result_json["status"], "solved")
        self.assertEqual(result_json["final_check"]["exit"], 0)
        self.assertEqual(state["roles"]["01:solve"]["model"], "anthropic/claude-opus-5-5")
        self.assertEqual(state["roles"]["00:router"]["model"], "anthropic/claude-haiku-5-5")
        self.assertEqual(state["roles"]["01:plan"]["model"], "anthropic/claude-fable-5-1")
        self.assertEqual(json.loads((run_dir / "tasks.json").read_text())[0]["status"], "done")
        self.assertEqual(state["tasks"], result_json["tasks"])
        self.assertFalse((run_dir / "round-01" / "check.log").read_text().strip())
        self.assertEqual(stat.S_IMODE((self.workspace / ".team-solve").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(run_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((run_dir / "state.json").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((run_dir / "result.json").stat().st_mode), 0o600)
        ledgers = "\n".join(
            path.read_text(errors="replace")
            for path in run_dir.rglob("*")
            if path.is_file()
        )
        self.assertNotIn("test-key-not-real", ledgers)

        records = self.records()
        by_role = {record["role"]: record for record in records}
        self.assertEqual(
            set(by_role),
            {
                "router",
                "direct",
                "plan",
                "ideate-a",
                "ideate-b",
                "solve",
                "triage",
                "review",
                "manager",
                "audit",
            },
        )
        # the direct attempt changed nothing, so the team took over; the check
        # and the review settled it with no judge
        self.assertFalse(state["direct_passed"])
        self.assertEqual(state["rounds"]["1"], {"check": "pass", "exit": 0, "review": "PASS", "judge": "skipped",
                                                "accepted": True, "outside_scope": 0})
        d = by_role["direct"]
        p = by_role["plan"]
        self.assertLess(max(float(d["started"]), float(p["started"])), min(float(d["finished"]), float(p["finished"])))
        a = by_role["ideate-a"]
        b = by_role["ideate-b"]
        self.assertLess(max(float(a["started"]), float(b["started"])), min(float(a["finished"]), float(b["finished"])))
        for role in ("plan", "solve", "triage", "review", "manager", "audit"):
            self.assertTrue((run_dir / "round-01" / f"{role}.md").exists(), role)
        self.assertTrue((run_dir / "round-01" / "proposals" / "A.md").exists())
        self.assertTrue((run_dir / "round-01" / "proposals" / "B.md").exists())
        self.assertTrue((run_dir / "round-01" / "audit.md").exists())

    def test_manual_check_does_not_mutate_saved_run(self) -> None:
        started = self.run_team("run", "--check", "test -f fixed.txt", "--profile", "coding")
        self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
        run_dir = self.current_run()
        before = json.loads((run_dir / "state.json").read_text())
        state_bytes = (run_dir / "state.json").read_bytes()
        (self.workspace / "fixed.txt").unlink()

        checked = self.run_team("check", "--check", "false")
        self.assertEqual(checked.returncode, 1, checked.stdout + checked.stderr)
        after = json.loads((run_dir / "state.json").read_text())
        self.assertEqual((run_dir / "state.json").read_bytes(), state_bytes)
        self.assertEqual(after["status"], "solved")
        self.assertEqual(after["check"], before["check"])
        self.assertEqual(after["pid"], before["pid"])
        self.assertEqual(after["last_check"], before["last_check"])
        self.assertEqual(after["final_check"], before["final_check"])
        self.assertTrue((run_dir / "manual-check.log").exists())

    def test_status_reports_models_and_roles(self) -> None:
        started = self.run_team("run", "--check", "test -f fixed.txt", "--profile", "coding")
        self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
        status = self.run_team("status")
        self.assertEqual(status.returncode, 0, status.stdout + status.stderr)
        self.assertIn("status    solved", status.stdout)
        self.assertIn("anthropic/claude-opus-5-5", status.stdout)
        self.assertIn("01:solve", status.stdout)

    def test_manager_done_cannot_override_a_failed_check(self) -> None:
        self.env["TEAM_SOLVE_TEST_FIX"] = "0"
        result = self.run_team(
            "run",
            "--check",
            "test -f fixed.txt",
            "--profile",
            "coding",
            "--rounds",
            "1",
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        run_dir = self.current_run()
        state = json.loads((run_dir / "state.json").read_text())
        self.assertEqual(state["status"], "failed")
        self.assertNotEqual(state["final_check"]["exit"], 0)
        self.assertIn("STATUS: DONE", (run_dir / "round-01" / "manager.md").read_text())
        self.assertEqual(json.loads((run_dir / "result.json").read_text())["status"], "failed")

    def test_baseline_pass_skips_router_and_resume_restores_result(self) -> None:
        result = self.run_team("run", "--check", "true", "--profile", "auto")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        run_dir = self.current_run()
        state = json.loads((run_dir / "state.json").read_text())
        self.assertEqual(state["status"], "solved")
        self.assertEqual(state["resolved_profile"], "skipped")
        self.assertIn("baseline passed", state["route_reason"])
        self.assertEqual(self.records(), [])
        (run_dir / "result.json").unlink()

        resumed = self.run_team("resume")
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertTrue((run_dir / "resume-check.log").exists())
        result_json = json.loads((run_dir / "result.json").read_text())
        self.assertEqual(result_json["status"], "solved")
        self.assertEqual(result_json["baseline_check"]["exit"], 0)

    def test_improve_forces_work_after_a_passing_baseline(self) -> None:
        result = self.run_team(
            "run",
            "--check",
            "true",
            "--profile",
            "auto",
            "--improve",
            "--rounds",
            "2",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertEqual(state["resolved_profile"], "coding")
        self.assertIn("00:router", state["roles"])
        self.assertIn("02:audit", state["roles"])
        self.assertIn("02:repair", state["roles"])

    def test_preflight_failure_preserves_the_current_solved_run(self) -> None:
        started = self.run_team("run", "--check", "true", "--profile", "auto")
        self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
        run_dir = self.current_run()
        state_before = (run_dir / "state.json").read_bytes()
        result_before = (run_dir / "result.json").read_bytes()

        failed = self.run_team(
            "run",
            "--task-file",
            "missing-task.md",
            "--check",
            "true",
            "--profile",
            "coding",
        )
        self.assertEqual(failed.returncode, 2, failed.stdout + failed.stderr)
        self.assertIn("task file not found", failed.stderr)
        self.assertEqual((run_dir / "state.json").read_bytes(), state_before)
        self.assertEqual((run_dir / "result.json").read_bytes(), result_before)

    def test_resume_and_check_do_not_create_a_typo_workspace(self) -> None:
        missing = self.root / "missing-workspace"
        for action in ("resume", "check"):
            result = subprocess.run(
                [sys.executable, str(SCRIPT), action, "--dir", str(missing)],
                cwd=self.root,
                env=self.env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("workspace is not a directory", result.stderr)
            self.assertFalse(missing.exists())

    def test_round_two_repair_receives_round_one_manager_artifacts(self) -> None:
        self.env["TEAM_SOLVE_TEST_FIX"] = "1"
        self.env["TEAM_SOLVE_TEST_FIX_ROLES"] = "repair"
        self.env["TEAM_SOLVE_TEST_MANAGER_CONTINUE"] = "1"
        result = self.run_team(
            "run",
            "--check",
            "test -f fixed.txt",
            "--profile",
            "coding",
            "--rounds",
            "2",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        run_dir = self.current_run()
        self.assertIn(
            "NEXT_TASK: create fixed.txt",
            (run_dir / "round-01" / "manager.md").read_text(),
        )
        repair = next(record for record in self.records() if record["role"] == "repair")
        prompt = str(repair["args"][-1])
        self.assertIn("round-01/manager.md", prompt)
        self.assertIn("round-01/review.md", prompt)
        self.assertIn("The manager's next task is: create fixed.txt", prompt)
        self.assertEqual(json.loads((run_dir / "state.json").read_text())["status"], "solved")

    def test_stop_kills_parallel_ideators_and_their_descendants(self) -> None:
        pid_dir = self.root / "active-pids"
        self.env["TEAM_SOLVE_TEST_SLEEP_ROLES"] = "ideate-a,ideate-b"
        self.env["TEAM_SOLVE_TEST_DESCENDANTS"] = "1"
        self.env["TEAM_SOLVE_TEST_PIDS"] = str(pid_dir)
        args = (
            "run",
            "--check",
            "test -f fixed.txt",
            "--profile",
            "coding",
            "--rounds",
            "1",
        )
        run_process = self.start_team(*args)
        try:
            self.wait_for(lambda: (self.workspace / ".team-solve" / "current.json").exists())
            self.wait_for(
                lambda: (pid_dir / "ideate-a.json").exists()
                and (pid_dir / "ideate-b.json").exists()
            )

            second = self.run_team(*args)
            self.assertEqual(second.returncode, 2, second.stdout + second.stderr)
            self.assertIn("another team-solve process owns", second.stderr)

            logs = self.run_team("logs", "--role", "ideate-a")
            self.assertEqual(logs.returncode, 0, logs.stdout + logs.stderr)
            self.assertIn("ideate-a.attempt-1.jsonl", logs.stdout)

            stopped = self.run_team("stop")
            self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
        finally:
            if run_process.poll() is None:
                os.killpg(run_process.pid, signal.SIGKILL)
        stdout, stderr = run_process.communicate(timeout=20)
        self.assertIn(run_process.returncode, (0, 130, -signal.SIGTERM, -signal.SIGKILL), stdout + stderr)

        pids = [
            int(json.loads((pid_dir / f"{role}.json").read_text())["pid"])
            for role in ("ideate-a", "ideate-b")
        ]
        children = [
            int(json.loads((pid_dir / f"{role}.json").read_text())[field])
            for role in ("ideate-a", "ideate-b")
            for field in ("child", "detached")
        ]
        self.wait_for(lambda: not any(self.process_alive(pid) for pid in pids + children))

        run_dir = self.current_run()
        state = json.loads((run_dir / "state.json").read_text())
        self.assertEqual(state["status"], "stopped")
        self.assertTrue(state["finished"])
        self.assertEqual(json.loads((run_dir / "result.json").read_text())["status"], "stopped")

        self.env.pop("TEAM_SOLVE_TEST_SLEEP_ROLES")
        self.env.pop("TEAM_SOLVE_TEST_DESCENDANTS")
        self.env.pop("TEAM_SOLVE_TEST_PIDS")
        resumed = self.run_team("resume")
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        records = self.records()
        self.assertEqual(sum(record["role"] == "plan" for record in records), 1)
        self.assertEqual(sum(record["role"] == "ideate-a" for record in records), 1)
        self.assertEqual(sum(record["role"] == "ideate-b" for record in records), 1)
        self.assertEqual(sum(record["role"] == "solve" for record in records), 1)
        resumed_state = json.loads((run_dir / "state.json").read_text())
        self.assertEqual(resumed_state["status"], "solved")
        self.assertEqual(json.loads((run_dir / "result.json").read_text())["status"], "solved")

    def test_hard_killed_orchestrator_leaves_children_for_resume_guard_and_stop(self) -> None:
        pid_dir = self.root / "orphaned-pids"
        self.env["TEAM_SOLVE_TEST_SLEEP_ROLES"] = "ideate-a,ideate-b"
        self.env["TEAM_SOLVE_TEST_DESCENDANTS"] = "1"
        self.env["TEAM_SOLVE_TEST_PIDS"] = str(pid_dir)
        run_process = self.start_team(
            "run",
            "--check",
            "test -f fixed.txt",
            "--profile",
            "coding",
            "--rounds",
            "1",
        )
        try:
            self.wait_for(lambda: (self.workspace / ".team-solve" / "current.json").exists())
            self.wait_for(
                lambda: (pid_dir / "ideate-a.json").exists()
                and (pid_dir / "ideate-b.json").exists()
            )
            run_dir = self.current_run()
            child_pids = {
                int(json.loads((pid_dir / f"{role}.json").read_text())[field])
                for role in ("ideate-a", "ideate-b")
                for field in ("pid", "child", "detached")
            }

            def inventory_complete() -> bool:
                state = json.loads((run_dir / "state.json").read_text())
                tracked = {
                    int(record["pid"])
                    for record in (state.get("active_processes") or {}).values()
                }
                return child_pids <= tracked

            self.wait_for(inventory_complete)
            os.kill(run_process.pid, signal.SIGKILL)
            run_process.communicate(timeout=10)

            resume = self.run_team("resume")
            self.assertEqual(resume.returncode, 2, resume.stdout + resume.stderr)
            self.assertIn("still has a live child process", resume.stderr)

            stopped = self.run_team("stop")
            self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
            self.wait_for(lambda: not any(self.process_alive(pid) for pid in child_pids))
            state = json.loads((run_dir / "state.json").read_text())
            self.assertEqual(state["status"], "stopped")
            self.assertNotIn("active_processes", state)
            self.assertEqual(json.loads((run_dir / "result.json").read_text())["status"], "stopped")
        finally:
            if run_process.poll() is None:
                os.kill(run_process.pid, signal.SIGKILL)
                run_process.communicate(timeout=10)

    def test_parallel_ideator_failure_cancels_the_slow_sibling(self) -> None:
        pid_dir = self.root / "sibling-pids"
        self.env["TEAM_SOLVE_TEST_FAIL_ROLE"] = "ideate-a"
        self.env["TEAM_SOLVE_TEST_FAIL_DELAY"] = "1"
        self.env["TEAM_SOLVE_TEST_SLEEP_ROLES"] = "ideate-b"
        self.env["TEAM_SOLVE_TEST_PIDS"] = str(pid_dir)
        run_process = self.start_team(
            "run",
            "--check",
            "false",
            "--profile",
            "coding",
            "--rounds",
            "1",
        )
        self.wait_for(lambda: (pid_dir / "ideate-b.json").exists())
        stdout, stderr = run_process.communicate(timeout=15)
        self.assertEqual(run_process.returncode, 2, stdout + stderr)
        sibling = int(json.loads((pid_dir / "ideate-b.json").read_text())["pid"])
        self.wait_for(lambda: not self.process_alive(sibling))
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertEqual(state["status"], "error")
        self.assertEqual(state["roles"]["01:ideate-a"]["status"], "failed")

    def test_malformed_router_stream_falls_back_to_heuristics(self) -> None:
        self.env["TEAM_SOLVE_TEST_MALFORMED_ROUTER"] = "1"
        result = self.run_team("run", "--check", "test -f fixed.txt", "--profile", "auto")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertEqual(state["resolved_profile"], "everyday")
        self.assertIn("malformed pi JSON on line 1", state["route_reason"])

    def test_router_array_payload_falls_back_instead_of_being_extracted(self) -> None:
        self.env["TEAM_SOLVE_TEST_ROUTER_PAYLOAD"] = "array"
        result = self.run_team("run", "--check", "test -f fixed.txt", "--profile", "auto")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertEqual(state["resolved_profile"], "everyday")
        self.assertIn("router returned invalid JSON", state["route_reason"])

    def test_auto_router_promotes_multi_day_work_without_upgrading_execution(self) -> None:
        self.env["TEAM_SOLVE_TEST_ROUTER_PROFILE"] = "everyday"
        self.env["TEAM_SOLVE_TEST_ROUTER_HORIZON"] = "multi-day"
        result = self.run_team(
            "run",
            "--check",
            "test -f fixed.txt",
            "--profile",
            "auto",
            "--rounds",
            "1",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertEqual(state["resolved_profile"], "everyday")
        self.assertTrue(state["multi_day"])
        self.assertEqual(
            state["roles"]["01:plan"]["model"],
            "anthropic/claude-fable-5-1",
        )
        self.assertEqual(
            state["roles"]["01:solve"]["model"],
            "anthropic/claude-sonnet-5-5",
        )

    def test_length_and_empty_final_are_rejected(self) -> None:
        self.env["TEAM_SOLVE_TEST_STOP_LENGTH_ROLE"] = "plan"
        length = self.run_team("run", "--check", "false", "--profile", "coding")
        self.assertEqual(length.returncode, 2, length.stdout + length.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertEqual(state["status"], "error")
        self.assertIn("stopReason=length", state["roles"]["01:plan"]["reason"])

        self.env.pop("TEAM_SOLVE_TEST_STOP_LENGTH_ROLE")
        self.env["TEAM_SOLVE_TEST_EMPTY_FINAL_ROLE"] = "plan"
        empty = self.run_team(
            "run",
            "--check",
            "false",
            "--profile",
            "coding",
            "--fresh",
        )
        self.assertEqual(empty.returncode, 2, empty.stdout + empty.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertIn("role returned no text", state["roles"]["01:plan"]["reason"])

    def test_solver_cutoff_is_summarized_and_does_not_discard_workspace_progress(self) -> None:
        self.env["TEAM_SOLVE_TEST_STOP_LENGTH_ROLE"] = "solve"
        result = self.run_team(
            "run",
            "--check",
            "test -f fixed.txt",
            "--profile",
            "coding",
            "--rounds",
            "1",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        run_dir = self.current_run()
        state = json.loads((run_dir / "state.json").read_text())
        self.assertEqual(state["cutoff_count"], 1)
        self.assertTrue(state["roles"]["01:solve"]["cutoff_summarized"])
        self.assertEqual(state["roles"]["01:cutoff"]["model"], "anthropic/claude-haiku-5-5")
        self.assertIn(
            "fixed.txt was required",
            (run_dir / "round-01" / "solve.md").read_text(),
        )
        self.assertIn(
            "did not finish",
            (run_dir / "round-01" / "cutoff.md").read_text(),
        )

    # --- prompt-only runs: the planner settles the check, or the judge decides ---

    def roles_called(self) -> list[str]:
        return [str(record["role"]) for record in self.records()]

    def test_judge_only_task_with_until_outside_git(self) -> None:
        subprocess.run(["rm", "-rf", str(self.workspace / ".git")], check=True)
        self.env.update({
            "TEAM_SOLVE_TEST_FIX": "0",
            "TEAM_SOLVE_TEST_PLAN_CHECK": "judge",
            "TEAM_SOLVE_TEST_WRITES": json.dumps({
                "direct": [["answer.md", "use any name\n"]],
                "repair": [["answer.md", "use feature/<topic>\n"]],
            }),
            "TEAM_SOLVE_TEST_REVIEWS": "FAIL,PASS",
            "TEAM_SOLVE_TEST_JUDGES": "PASS",
            "TEAM_SOLVE_TEST_MANAGERS": "CONTINUE,DONE",
        })
        result = self.run_team(
            "run", "Write answer.md: a note on naming git branches",
            "--until", "answer.md names the prefix feature/",
            "--profile", "coding", "--rounds", "3",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("judged, not checked", result.stderr)
        self.assertEqual((self.workspace / "answer.md").read_text(), "use feature/<topic>\n")
        run_dir = self.current_run()
        state = json.loads((run_dir / "state.json").read_text())
        self.assertEqual(state["check_kind"], "judge")
        self.assertEqual(state["check"], "")
        self.assertEqual(state["repository"], "shadow")
        self.assertTrue(state["direct_passed"])                      # nothing to run: the change passes test-0
        self.assertEqual(state["rounds"]["1"]["review"], "FAIL")
        self.assertEqual(state["rounds"]["2"], {"check": "none", "exit": None, "review": "PASS", "judge": "PASS",
                                                "accepted": True, "outside_scope": 0})
        roles = self.roles_called()
        self.assertNotIn("solve", roles)                                # the direct attempt was the round-1 work
        self.assertNotIn("ideate-a", roles)
        self.assertEqual(roles.count("judge"), 1)                      # round 1 failed the review: no judge
        self.assertEqual(roles.count("repair"), 1)
        task = (run_dir / "task.md").read_text()
        done_when = task.split("## Done when", 1)[1].strip().splitlines()
        self.assertEqual(done_when[0], "- answer.md names the prefix feature/")
        self.assertIn("End condition (the run is done only when this holds): answer.md names the prefix feature/",
                      (run_dir / "prompt.md").read_text())
        self.assertTrue((self.workspace / ".team-solve" / "shadow.git").is_dir())
        status = self.run_team("status")
        self.assertIn("judged, not checked", status.stdout)
        self.assertIn("until     answer.md names the prefix feature/", status.stdout)
        checked = self.run_team("check")
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertIn("the last judge said PASS", checked.stdout)

    def test_planner_settles_a_command_and_the_direct_attempt_passes(self) -> None:
        self.env.update({"TEAM_SOLVE_TEST_FIX_ROLES": "direct", "TEAM_SOLVE_TEST_PLAN_CHECK": "`test -f fixed.txt`"})
        result = self.run_team("run", "create fixed.txt", "--profile", "coding")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("checked by `test -f fixed.txt`", result.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertEqual((state["check"], state["check_source"], state["check_kind"]),
                         ("test -f fixed.txt", "planner", "command"))
        self.assertEqual(state["baseline_check"]["exit"], 1)            # on a copy of the start: no fixed.txt yet
        self.assertTrue(state["direct_passed"])
        roles = self.roles_called()
        for absent in ("ideate-a", "ideate-b", "solve", "repair", "judge"):
            self.assertNotIn(absent, roles)
        self.assertEqual(subprocess.run(["git", "status", "--porcelain"], cwd=self.workspace, capture_output=True,
                                        text=True).stdout, "?? fixed.txt\n")   # .team-solve is ignored

    def test_a_check_that_passed_before_any_work_needs_the_judge(self) -> None:
        self.env.update({
            "TEAM_SOLVE_TEST_FIX": "0",
            "TEAM_SOLVE_TEST_WRITES": json.dumps({"direct": [["notes.md", "notes\n"]]}),
            "TEAM_SOLVE_TEST_JUDGES": "PASS",
        })
        result = self.run_team("run", "write notes.md", "--check", "true", "--profile", "coding")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertTrue(state["check_uninformative"])
        self.assertEqual(state["rounds"]["1"]["judge"], "PASS")
        self.assertIn("judge", self.roles_called())

    def test_keep_net_puts_back_the_last_accepted_state(self) -> None:
        self.env.update({
            "TEAM_SOLVE_TEST_FIX": "0",
            "TEAM_SOLVE_TEST_WRITES": json.dumps({
                "direct": [["v.txt", "good\n"]],
                "repair": [["v.txt", "broken\n"]],
            }),
        })
        result = self.run_team("run", "make v.txt good", "--check", "grep -qx good v.txt",
                               "--profile", "coding", "--rounds", "2", "--improve")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.workspace / "v.txt").read_text(), "good\n")
        run_dir = self.current_run()
        state = json.loads((run_dir / "state.json").read_text())
        self.assertEqual(state["rounds"]["2"]["check"], "fail")
        self.assertTrue(state["keep"].startswith("put back: the last accepted state (round 1)"))
        self.assertIn("broken", (run_dir / "team.patch").read_text())
        self.assertEqual(state["final_check"]["status"], "pass")

    def test_keep_net_puts_back_the_direct_attempt_when_the_team_proves_nothing(self) -> None:
        self.env.update({
            "TEAM_SOLVE_TEST_FIX": "0",
            "TEAM_SOLVE_TEST_REVIEWS": "FAIL",
            "TEAM_SOLVE_TEST_MANAGER_CONTINUE": "1",
            "TEAM_SOLVE_TEST_WRITES": json.dumps({
                "direct": [["v.txt", "direct\n"]],
                "solve": [["v.txt", "solve\n"]],
                "repair": [["v.txt", "repair\n"]],
            }),
        })
        result = self.run_team("run", "make v.txt right", "--check", "grep -qx right v.txt",
                               "--profile", "coding", "--rounds", "2")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual((self.workspace / "v.txt").read_text(), "direct\n")
        run_dir = self.current_run()
        state = json.loads((run_dir / "state.json").read_text())
        self.assertTrue(state["keep"].startswith("put back: the direct attempt"))
        self.assertIn("+repair", (run_dir / "team.patch").read_text())

    def test_baseline_counts_only_the_failures_the_change_adds(self) -> None:
        (self.workspace / "check.py").write_text(
            "import os, sys\n"
            "fails = ['t.py::old']\n"
            "if not (os.path.exists('feature.txt') and open('feature.txt').read().strip() == 'yes'):\n"
            "    fails.append('t.py::feature')\n"
            "for f in fails:\n"
            "    print('FAILED ' + f + ' - boom')\n"
            "print(f'{len(fails)} failed, 3 passed in 0.01s')\n"
            "sys.exit(1)\n"
        )
        self.env.update({"TEAM_SOLVE_TEST_FIX": "0",
                         "TEAM_SOLVE_TEST_WRITES": json.dumps({"direct": [["feature.txt", "yes\n"]]})})
        result = self.run_team("run", "make the feature test pass", "--check", f"{sys.executable} check.py",
                               "--profile", "coding")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        run_dir = self.current_run()
        self.assertIn("adds no failing test", (run_dir / "final-check.log").read_text())
        self.assertNotIn("judge", self.roles_called())

    def test_a_failure_unlike_the_baseline_counts_against_the_change(self) -> None:
        (self.workspace / "check.sh").write_text('test -f fixed.txt || { echo "missing at $(date +%s%N)"; exit 1; }\n'
                                                 'grep -q right fixed.txt || { echo "wrong content"; exit 1; }\n')
        self.env.update({"TEAM_SOLVE_TEST_FIX": "0", "TEAM_SOLVE_TEST_REVIEWS": "PASS",
                         "TEAM_SOLVE_TEST_WRITES": json.dumps({"direct": [["fixed.txt", "wrong\n"]],
                                                               "solve": [["fixed.txt", "wrong\n"]]})})
        result = self.run_team("run", "write fixed.txt", "--check", "bash check.sh", "--profile", "coding",
                               "--rounds", "1")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        state = json.loads((self.current_run() / "state.json").read_text())
        self.assertEqual(state["direct_check"]["status"], "fail")
        self.assertIn("fails differently", (self.current_run() / "round-01" / "direct-check.log").read_text())

    def test_run_without_a_task_or_check_is_refused(self) -> None:
        result = self.run_team("run")
        self.assertEqual(result.returncode, 2)
        self.assertIn("no task", result.stderr)
        self.assertEqual(self.records(), [])


class TeamSolveUnits(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.module = load_module()

    def test_pi_usage_uses_authoritative_message_end_not_cumulative_updates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-events-") as tmp:
            path = Path(tmp) / "events.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps({"type": "message_update", "usage": {"input": 99, "output": 99}}),
                        json.dumps(
                            {
                                "type": "message_end",
                                "message": {
                                    "role": "assistant",
                                    "content": [{"type": "text", "text": "done"}],
                                    "stopReason": "stop",
                                    "usage": {
                                        "input": 10,
                                        "output": 3,
                                        "cacheRead": 4,
                                        "cacheWrite": 2,
                                        "totalTokens": 19,
                                        "cost": {"total": 0.01},
                                    },
                                },
                            }
                        ),
                        json.dumps({"type": "agent_settled", "aborted": False}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            parsed = self.module.parse_pi_events(path)
        self.assertEqual(parsed["text"], "done")
        self.assertTrue(parsed["settled"])
        self.assertEqual(parsed["usage"]["input"], 10)
        self.assertEqual(parsed["usage"]["output"], 3)
        self.assertEqual(parsed["usage"]["cost_usd"], 0.01)

    def test_final_empty_message_clears_superseded_text(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-events-") as tmp:
            path = Path(tmp) / "events.jsonl"
            events = [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "temporary progress"}],
                        "stopReason": "stop",
                    },
                },
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": ""}],
                        "stopReason": "stop",
                    },
                },
                {"type": "agent_settled", "aborted": False},
            ]
            path.write_text("\n".join(json.dumps(event) for event in events) + "\n")
            parsed = self.module.parse_pi_events(path)
        self.assertTrue(parsed["settled"])
        self.assertEqual(parsed["text"], "")
        self.assertEqual(parsed["error"], "")

    def test_missing_final_stop_reason_does_not_reuse_an_earlier_stop(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-events-") as tmp:
            path = Path(tmp) / "events.jsonl"
            events = [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "progress"}],
                        "stopReason": "stop",
                    },
                },
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "final without status"}],
                    },
                },
                {"type": "agent_settled", "aborted": False},
            ]
            path.write_text("\n".join(json.dumps(event) for event in events) + "\n")
            parsed = self.module.parse_pi_events(path)
        self.assertTrue(parsed["settled"])
        self.assertEqual(parsed["text"], "final without status")
        self.assertEqual(parsed["last_stop"], "")

    def test_event_parser_preserves_unicode_line_separators(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-events-") as tmp:
            path = Path(tmp) / "events.jsonl"
            prose = "first\u2028second\u2029third"
            event = {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": prose}],
                    "stopReason": "stop",
                },
            }
            path.write_bytes(
                (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
                + b'{"type":"agent_settled","aborted":false}\n'
            )
            parsed = self.module.parse_pi_events(path)
        self.assertEqual(parsed["text"], prose)
        self.assertEqual(parsed["error"], "")

    def test_event_parser_reports_malformed_and_non_object_records(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-events-") as tmp:
            path = Path(tmp) / "events.jsonl"
            path.write_text('{"type":"agent_settled","aborted":false}\n{oops\n')
            malformed = self.module.parse_pi_events(path)
            path.write_text('{"type":"agent_settled","aborted":false}\n[]\n')
            non_object = self.module.parse_pi_events(path)
            path.write_text('{"type":"message_end","message":[]}\n')
            bad_message = self.module.parse_pi_events(path)
            path.write_text(
                '{"type":"message_end","message":{"role":"assistant","content":{}}}\n'
            )
            bad_content = self.module.parse_pi_events(path)
        self.assertIn("malformed pi JSON on line 2", malformed["error"])
        self.assertIn("line 2", non_object["error"])
        self.assertIn("expected a JSON object", non_object["error"])
        self.assertIn("message must be an object", bad_message["error"])
        self.assertIn("content must be a string or array", bad_content["error"])

    def test_role_cache_invalidates_on_prompt_or_output_changes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-cache-") as tmp:
            workspace = Path(tmp) / "workspace"
            run_dir = workspace / ".team-solve" / "runs" / "run"
            output = run_dir / "round-01" / "plan.md"
            output.parent.mkdir(parents=True)
            output.write_text("cached plan\n")
            state = {
                "run_id": "test",
                "check": "true",
                "profile": "coding",
                "resolved_profile": "coding",
                "role_timeout_sec": 3600,
                "check_timeout_sec": 3600,
            }
            orchestrator = self.module.Orchestrator(
                workspace,
                run_dir,
                state,
                activate=False,
            )
            prompt_sha = orchestrator.role_prompt_sha256(1, "plan")
            state["roles"] = {
                "01:plan": {
                    "role": "plan",
                    "round": 1,
                    "status": "done",
                    "model": "anthropic/claude-fable-5-1",
                    "thinking": "high",
                    "prompt_sha256": prompt_sha,
                    "output_sha256": self.module.hashlib.sha256(b"cached plan\n").hexdigest(),
                }
            }
            self.assertEqual(
                orchestrator.prior_role(
                    1,
                    "plan",
                    prompt_sha,
                    model="anthropic/claude-fable-5-1",
                    thinking="high",
                ),
                "cached plan\n",
            )
            self.assertIsNone(
                orchestrator.prior_role(
                    1,
                    "plan",
                    prompt_sha,
                    model="anthropic/claude-sonnet-5-5",
                    thinking="high",
                )
            )
            self.assertIsNone(
                orchestrator.prior_role(
                    1,
                    "plan",
                    prompt_sha,
                    model="anthropic/claude-fable-5-1",
                    thinking="xhigh",
                )
            )
            output.write_text("tampered\n")
            self.assertIsNone(orchestrator.prior_role(1, "plan", prompt_sha))
            output.write_text("cached plan\n")
            self.assertIsNone(orchestrator.prior_role(1, "plan", "different prompt"))

    def test_role_cache_tracks_the_evidence_files_the_role_reads(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-evidence-") as tmp:
            workspace = Path(tmp) / "workspace"
            run_dir = workspace / ".team-solve" / "runs" / "run"
            round_dir = run_dir / "round-01"
            round_dir.mkdir(parents=True)
            (run_dir / "task.md").write_text("task\n")
            check = round_dir / "check.log"
            check.write_text("failure one\n")
            orchestrator = self.module.Orchestrator(
                workspace,
                run_dir,
                {
                    "run_id": "test",
                    "check": "false",
                    "profile": "coding",
                    "resolved_profile": "coding",
                    "role_timeout_sec": 3600,
                    "check_timeout_sec": 3600,
                },
                activate=False,
            )
            before = orchestrator.role_prompt_sha256(1, "triage")
            check.write_text("failure two\n")
            after = orchestrator.role_prompt_sha256(1, "triage")
        self.assertNotEqual(before, after)

    def test_diff_excludes_tracked_and_untracked_secret_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-diff-") as tmp:
            workspace = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
            (workspace / "keep.txt").write_text("visible-before\n")
            (workspace / "secret-config.txt").write_text("secret-before\n")
            subprocess.run(["git", "add", "keep.txt", "secret-config.txt"], cwd=workspace, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Team Solve Test",
                    "-c",
                    "user.email=team-solve@example.invalid",
                    "commit",
                    "-qm",
                    "fixture",
                ],
                cwd=workspace,
                check=True,
            )
            run_dir = workspace / ".team-solve" / "runs" / "run"
            run_dir.mkdir(parents=True)
            orchestrator = self.module.Orchestrator(
                workspace,
                run_dir,
                {"role_timeout_sec": 3600, "check_timeout_sec": 3600},
                activate=False,
            )
            # The diff is measured from the run's start: take it, then change files.
            orchestrator.tree.start()
            (workspace / "keep.txt").write_text("visible-after\n")
            (workspace / "secret-config.txt").write_text("SECRET_VALUE\n")
            (workspace / "untracked-secret.txt").write_text("UNTRACKED_SECRET\n")
            destination = run_dir / "diff.txt"
            orchestrator.capture_diff(destination)
            captured = destination.read_text()
        self.assertIn("visible-after", captured)
        self.assertNotIn("SECRET_VALUE", captured)
        self.assertNotIn("UNTRACKED_SECRET", captured)
        self.assertNotIn("secret-config.txt", captured)
        self.assertNotIn("untracked-secret.txt", captured)

    def test_latest_role_log_sorting_is_numeric(self) -> None:
        state = {
            "roles": {
                "02:ideate-a": {"role": "ideate-a", "round": 2, "attempt": 1},
                "10:ideate-a": {"role": "ideate-a", "round": 10, "attempt": 1},
            }
        }
        selected = self.module.latest_role_record(state, "ideate-a")
        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected[0], "10:ideate-a")

    def test_saved_budget_rejects_non_finite_values(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-budget-") as tmp:
            workspace = Path(tmp)
            run_dir = workspace / ".team-solve" / "runs" / "run"
            run_dir.mkdir(parents=True)
            base = {
                "profile": "coding",
                "role_timeout_sec": 3600,
                "check_timeout_sec": 3600,
            }
            for field, value in (
                ("max_hours", 0),
                ("max_hours", 1e308),
                ("started_epoch", float("nan")),
                ("started_epoch", float("inf")),
            ):
                with self.subTest(field=field, value=value):
                    state = {**base, field: value}
                    with self.assertRaises(self.module.TeamSolveError):
                        self.module.Orchestrator(
                            workspace,
                            run_dir,
                            state,
                            activate=False,
                        )

    def test_stop_terminalizes_a_created_run(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-created-") as tmp:
            workspace = Path(tmp)
            run_dir = workspace / ".team-solve" / "runs" / "run"
            run_dir.mkdir(parents=True)
            state = {
                "version": self.module.STATE_VERSION,
                "run_id": "created-run",
                "status": "created",
                "phase": "created",
                "roles": {},
                "usage": {},
            }
            self.module.atomic_json(run_dir / "state.json", state)
            self.module.atomic_json(
                self.module.current_path(workspace),
                {
                    "run_dir": os.path.relpath(run_dir, workspace),
                    "updated_at": self.module.utc_now(),
                },
            )
            with redirect_stderr(StringIO()):
                code = self.module.main(["stop", "--dir", str(workspace)])
            self.assertEqual(code, 0)
            stopped = json.loads((run_dir / "state.json").read_text())
            self.assertEqual(stopped["status"], "stopped")
            self.assertTrue(stopped["finished"])
            self.assertEqual(json.loads((run_dir / "result.json").read_text())["status"], "stopped")

    def test_invalid_environment_defaults_fail_cleanly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-env-") as tmp:
            cases = [
                {"TEAM_SOLVE_DEFAULT_PROFILE": "bogus"},
                {"TEAM_SOLVE_MAX_HOURS": "nan"},
                {"TEAM_SOLVE_MAX_HOURS": "inf"},
                {"TEAM_SOLVE_MAX_HOURS": "1e308"},
                {"TEAM_SOLVE_MULTI_DAY": "sometimes"},
                {"TEAM_SOLVE_MAX_ROUNDS": "abc"},
            ]
            for values in cases:
                with self.subTest(values=values):
                    stderr = StringIO()
                    run_env = {
                        **values,
                        "STACK_BACKEND": "anthropic",
                        "ANTHROPIC_API_KEY": "test-key-not-real",
                    }
                    with patch.dict(os.environ, run_env, clear=False):
                        with redirect_stderr(stderr):
                            code = self.module.main(["run", "--dir", tmp, "--check", "true"])
                    self.assertEqual(code, 2)
                    self.assertNotIn("Traceback", stderr.getvalue())
                    for key in values:
                        self.assertIn(key, stderr.getvalue())
                    with patch.dict(os.environ, run_env, clear=False):
                        self.assertEqual(self.module.main(["help"]), 0)
            self.assertFalse((Path(tmp) / ".team-solve").exists())

    def test_model_profiles_and_thinking_are_configurable(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TEAM_SOLVE_FABLE_MODEL": "claude-fable-test",
                "TEAM_SOLVE_FABLE_THINKING": "xhigh",
                "TEAM_SOLVE_OPUS_MODEL": "anthropic/claude-opus-test",
            },
            clear=False,
        ):
            self.assertEqual(
                self.module.role_spec("coding", "plan"),
                ("anthropic/claude-fable-test", "xhigh", self.module.READ_ONLY_TOOLS),
            )
            self.assertEqual(
                self.module.role_spec("coding", "solve")[0],
                "anthropic/claude-opus-test",
            )
        with patch.dict(os.environ, {"TEAM_SOLVE_HAIKU_THINKING": "turbo"}, clear=False):
            with self.assertRaisesRegex(self.module.TeamSolveError, "TEAM_SOLVE_HAIKU_THINKING"):
                self.module.role_spec("coding", "triage")

    def test_parser_defaults_cover_multi_day_runs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-defaults-") as tmp:
            with patch.dict(os.environ, {}, clear=False):
                for key in list(os.environ):
                    if key.startswith("TEAM_SOLVE_"):
                        os.environ.pop(key, None)
                args = self.module.build_parser().parse_args(["run", "--check", "true"])
                config = self.module.initial_config(args, Path(tmp))
        self.assertEqual(config["profile"], "auto")
        self.assertEqual(config["max_rounds"], 10)
        self.assertEqual(config["max_hours"], 72)
        self.assertEqual(config["role_timeout_sec"], 4 * 3600)
        self.assertIsNone(config["multi_day"])

    def test_heuristic_profiles_match_the_model_guidance(self) -> None:
        self.assertEqual(self.module.heuristic_profile("research and compare sources", "true"), "research")
        self.assertEqual(self.module.heuristic_profile("write the README", "true"), "writing")
        self.assertEqual(
            self.module.heuristic_profile("bulk-classify these records", "pytest"),
            "high-volume",
        )
        self.assertEqual(self.module.heuristic_profile("fix the build", "pytest"), "everyday")
        self.assertEqual(
            self.module.heuristic_profile("fix tests and update README", "pytest"),
            "everyday",
        )
        self.assertEqual(
            self.module.heuristic_profile("implement a concurrent migration", "pytest"),
            "coding",
        )
        self.assertEqual(self.module.heuristic_profile("answer this question", "true"), "general")

    def test_default_model_allocation_matches_model_strengths(self) -> None:
        models = {
            "fable": ("anthropic/claude-fable-5-1", "high"),
            "opus": ("anthropic/claude-opus-5-5", "high"),
            "sonnet": ("anthropic/claude-sonnet-5-5", "high"),
            "haiku": ("anthropic/claude-haiku-5-5", "medium"),
        }
        with patch.dict(os.environ, {}, clear=False):
            for key in list(os.environ):
                if key.startswith("TEAM_SOLVE_") and key.endswith(("_MODEL", "_THINKING")):
                    os.environ.pop(key, None)
            for profile, roles in self.module.ROLE_TIERS.items():
                for role, tier in roles.items():
                    want = models[tier]
                    got = self.module.role_spec(profile, role)
                    self.assertEqual((got[0], got[1]), want, f"{profile}/{role}")

    def test_multi_day_runs_promote_long_horizon_roles_to_fable(self) -> None:
        self.assertEqual(
            self.module.role_spec("everyday", "plan", multi_day=True)[:2],
            ("anthropic/claude-fable-5-1", "high"),
        )
        self.assertEqual(
            self.module.role_spec("writing", "audit", multi_day=True)[0],
            "anthropic/claude-fable-5-1",
        )
        self.assertEqual(
            self.module.role_spec("high-volume", "audit", multi_day=True)[0],
            "anthropic/claude-fable-5-1",
        )

    def test_roles_cannot_start_nested_team_runs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="team-solve-nested-") as tmp:
            stderr = StringIO()
            with patch.dict(os.environ, {"TEAM_SOLVE_ROLE": "solve"}, clear=False):
                with redirect_stderr(stderr):
                    code = self.module.main(["run", "--dir", tmp, "--check", "true"])
        self.assertEqual(code, 2)
        self.assertIn("refusing to start a team run inside role 'solve'", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
