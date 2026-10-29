#!/usr/bin/env python3
"""Private installed host child. No arbitrary lease fields or paths are inputs."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import sys


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


managed = module("hive_lease_managed", "managed-projects.py")
terminal = module("hive_lease_private_state", "codex-project-terminal.py")
require = managed.require


def process_identity(pid):
    require(type(pid) is int and pid > 0, "process_identity_unavailable")
    root = Path(f"/proc/{pid}")
    require(root.stat().st_uid == os.getuid(), "process_identity_unavailable")
    def fields():
        value = (root / "stat").read_text()
        return value[value.rindex(") ") + 2:].split()
    before = fields()
    executable = os.readlink(root / "exe")
    info = (root / "exe").stat()
    require(before[0] != "Z" and executable.startswith("/") and not executable.endswith(" (deleted)"), "process_identity_unavailable")
    require(fields()[19] == before[19], "process_identity_changed")
    return {"pid": pid, "startTime": before[19], "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "executable": executable, "device": str(info.st_dev), "inode": str(info.st_ino)}


class InstalledControllerAuthority:
    def __init__(self, home, parent_pid):
        self.home = Path(home)
        self.parent_pid = parent_pid

    def verify(self, project_id, expected):
        require(isinstance(project_id, str) and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", project_id), "invalid_project")
        controller = terminal.signed(self.home / ".local/state/hive/codex-project-controller", "projects.json", "projects.key", "state")
        supervisor = terminal.signed(self.home / ".local/state/hive/codex-project-supervisor", "registry.json", "key", "state")
        require(controller.get("hostProcess") == process_identity(self.parent_pid)
                and supervisor.get("hostProcess") == controller["hostProcess"], "controller_process_changed")
        native = supervisor.get("nativeProcess")
        require(isinstance(native, dict) and native == process_identity(native.get("pid")), "native_process_changed")
        raw = Path(f"/proc/{native['pid']}/stat").read_text()
        require(int(raw[raw.rindex(") ") + 2:].split()[1]) == self.parent_pid, "native_parent_changed")
        require(supervisor["status"] == "ready" and supervisor["ownerId"] == controller["ownerId"]
                and supervisor["workspaceId"] == controller["workspaceId"], "native_lifetime_changed")
        project = controller["projects"][project_id]
        task = project["task"]
        prepared = task["prepared"]
        entry = supervisor["projects"][project_id]
        require(task["phase"] in {"running", "awaitingRegistration", "awaitingFirstPrompt"}
                and not entry.get("executionRevoked") and not task.get("executionRevoked")
                and entry["serverInstanceId"] == supervisor["serverInstanceId"] == task["nativeServerInstanceId"]
                and entry["threadId"] == task["nativeThreadId"]
                and entry["phase"] in {"awaitingFirstTurn", "awaitingPersistence", "persisted"}, "execution_authority_revoked")
        actual = {"repositoryId": project["repositoryId"], "taskId": task["taskId"], "leaseId": prepared["leaseId"],
                  "leaseGeneration": prepared["leaseGeneration"], "revision": task["request"]["revision"],
                  "checkoutIncarnation": task["checkoutIncarnation"]}
        require(actual == expected and prepared["taskId"] == task["taskId"]
                and prepared["repositoryId"] == entry["repositoryId"] == project["repositoryId"], "renewal_binding_changed")
        # Inspection is bounded, but process exit/replacement during it still
        # invalidates renewal before the managed receipt is updated.
        require(process_identity(self.parent_pid) == controller["hostProcess"]
                and process_identity(native["pid"]) == native, "native_process_changed")


def main():
    require(len(sys.argv) == 1, "arguments_not_supported")
    raw = sys.stdin.buffer.read(257)
    require(len(raw) <= 256, "request_too_large")
    request = json.loads(raw)
    require(isinstance(request, dict) and set(request) == {"schemaVersion", "projectId"}
            and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1, "invalid_request")
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    # Derive repository identity from the private signed journal, not request.
    controller = terminal.signed(home / ".local/state/hive/codex-project-controller", "projects.json", "projects.key", "state")
    repository_id = controller["projects"][request["projectId"]]["repositoryId"]
    result = managed.ManagedProjects(home)._renew_controller_lease(repository_id, request["projectId"], InstalledControllerAuthority(home, os.getppid()))
    print(json.dumps({"ok": True, "data": result}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"ok": False, "error": "lease_renewal_rejected"}))
        raise SystemExit(1) from None
