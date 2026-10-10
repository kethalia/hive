#!/usr/bin/env python3
"""Create task worktrees and retire only explicitly completed, unchanged checkouts."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time


GENERATED = {"node_modules", ".next", ".turbo", "coverage", "__pycache__", ".pytest_cache"}


def plain_path(path, root):
    path = Path(os.path.abspath(Path(path).expanduser()))
    if path == root or not path.is_relative_to(root):
        raise ValueError(f"Path must be below {root}: {path}")
    if path.resolve() != path:
        raise ValueError(f"Symlinked paths are not managed: {path}")
    return path


class Worktrees:
    def __init__(self, home):
        self.home = Path(home).expanduser().resolve()
        self.projects = self.home / "projects"
        self.state = plain_path(self.home / ".local/state/hive/worktrees", self.home)
        self.deadline = time.monotonic() + 80

    @contextmanager
    def lock(self):
        self.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        plain_path(self.state.parent, self.home)
        fd = os.open(self.state.parent / "worktree-lifecycle.lock",
                     os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def git(self, repo, *args):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Worktree maintenance budget reached")
        result = subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True,
            timeout=min(10, remaining), env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
        if result.returncode:
            raise ValueError(result.stderr.strip() or f"Git exited {result.returncode}")
        return result.stdout.strip()

    def primary(self, repo):
        repo = plain_path(repo, self.projects)
        if len(repo.relative_to(self.projects).parts) != 2:
            raise ValueError("Use the primary projects/<owner>/<repo> checkout")
        common = Path(self.git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        if common != repo / ".git" or not common.is_dir() or common.is_symlink():
            raise ValueError("Repository must be a primary clone, not another worktree")
        return repo

    def validate(self, repo, path):
        repo = self.primary(repo)
        path = plain_path(path, repo.parent)
        if path == repo or path.is_relative_to(repo):
            raise ValueError("Primary and nested repository directories cannot be retired")
        paths = [line[9:] for line in self.git(repo, "worktree", "list", "--porcelain").splitlines()
                 if line.startswith("worktree ")]
        if str(path) not in paths:
            raise ValueError("Path is not registered with this repository")
        common = self.git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
        if common != str(repo / ".git"):
            raise ValueError("Worktree Git metadata does not match its primary clone")
        return repo, path

    def record_path(self, path):
        return self.state / (hashlib.sha256(str(path).encode()).hexdigest() + ".json")

    def write_state(self, file, value):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        plain_path(self.state, self.home)
        fd, temporary = tempfile.mkstemp(dir=self.state)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(value, stream, indent=2)
                stream.write("\n")
            os.replace(temporary, file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def save(self, record):
        self.write_state(self.record_path(record["path"]), record)

    def load(self, path):
        file = self.record_path(path)
        if file.is_symlink():
            raise ValueError("Symlinked worktree records are not managed")
        record = json.loads(file.read_text())
        if record.get("version") != 1 or record.get("path") != str(path):
            raise ValueError("Invalid worktree record")
        return record

    def adopt(self, repo, path, fresh=False):
        repo, path = self.validate(repo, path)
        if not fresh and self.record_path(path).exists():
            return self.load(path)
        branch = self.git(path, "branch", "--show-current")
        record = {"version": 1, "repo": str(repo), "path": str(path), "branch": branch,
                  "status": "active", "created_at": time.time()}
        self.save(record)
        return record

    def create(self, repo, task, branch, base):
        repo = self.primary(repo)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", task) or task in {".", ".."}:
            raise ValueError("Task names must be a single safe directory name")
        self.git(repo, "check-ref-format", "--branch", branch)
        path = plain_path(repo.parent / ".worktrees" / repo.name / task, repo.parent)
        if path.exists():
            record = self.adopt(repo, path)
            if record["branch"] != branch or self.git(path, "branch", "--show-current") != branch:
                raise ValueError("Existing task checkout uses a different branch")
            record["status"] = "active"
            record.pop("completed_head", None)
            record.pop("completed_at", None)
            self.save(record)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            branches = self.git(repo, "for-each-ref", "--format=%(refname)", "refs/heads").splitlines()
            args = ["worktree", "add"]
            if "refs/heads/" + branch in branches:
                args += [str(path), branch]
            else:
                args += ["-b", branch, str(path), base]
            self.git(repo, *args)
            # A previous checkout may have been removed outside this helper.
            # A successful add starts a new active task, even if its record remains.
            self.adopt(repo, path, fresh=True)
        return {"path": str(path), "status": "active"}

    def clean_source(self, path):
        if self.git(path, "status", "--porcelain=v1", "--untracked-files=all"):
            raise ValueError("Tracked changes or untracked files remain")
        ignored = self.git(path, "ls-files", "--others", "--ignored", "--exclude-standard",
                           "--directory", "-z")
        for entry in ignored.split("\0"):
            if entry and not any(part in GENERATED for part in Path(entry).parts):
                raise ValueError("Ignored files outside recognized generated directories remain")

    def process_references(self, path):
        for process in Path("/proc").iterdir():
            if not process.name.isdigit():
                continue
            owned = False
            try:
                owned = process.stat().st_uid == os.getuid()
                links = [process / "cwd", *(process / "fd").iterdir()]
                for link in links:
                    try:
                        target = os.readlink(link)
                    except FileNotFoundError:
                        continue
                    if target == str(path) or target.startswith(str(path) + "/"):
                        return True
            except FileNotFoundError:
                continue
            except PermissionError:
                if owned:
                    raise ValueError("Cannot inspect a workspace-owner process")
        return False

    def mounted_paths(self):
        # st_dev alone misses bind mounts on the same filesystem. Linux mountinfo
        # encodes whitespace/backslashes using octal escapes in field five.
        mounted = set()
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            value = line.split()[4]
            value = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)
            mounted.add(Path(value))
        return mounted

    def remove_completed(self, record):
        repo, path = self.validate(record["repo"], record["path"])
        if record["status"] != "completed":
            return {"path": str(path), "status": "active"}
        if self.process_references(path):
            return {"path": str(path), "status": "deferred", "reason": "Process still references checkout"}
        if any(mount == path or mount.is_relative_to(path) for mount in self.mounted_paths()):
            raise ValueError("Mounted checkout or nested mount requires manual cleanup")
        if path.stat().st_dev != repo.stat().st_dev:
            raise ValueError("Checkout filesystem differs from the primary clone")
        if self.git(path, "branch", "--show-current") != record["branch"]:
            raise ValueError("Branch changed after registration")
        if self.git(path, "rev-parse", "HEAD") != record["completed_head"]:
            raise ValueError("HEAD changed after task completion")
        self.clean_source(path)
        # Mount points and nested repositories require separate handling.
        device = path.stat().st_dev
        def fail_walk(error):
            raise error

        for root, directories, files in os.walk(path, followlinks=False, onerror=fail_walk):
            if time.monotonic() >= self.deadline:
                raise TimeoutError("Worktree maintenance budget reached")
            if Path(root).stat().st_dev != device or (root != str(path) and ".git" in directories + files):
                raise ValueError("Nested repository or filesystem requires manual cleanup")
            if "HEAD" in files and "objects" in directories and ("refs" in directories or "packed-refs" in files):
                raise ValueError("Nested bare repository requires manual cleanup")
            for name in directories + files:
                if time.monotonic() >= self.deadline:
                    raise TimeoutError("Worktree maintenance budget reached")
                mode = (Path(root) / name).lstat().st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
                    raise ValueError("Socket or other special filesystem node requires manual cleanup")
        # Detached validation checkouts may contain a unique commit. Keep a branch
        # before removing their registration so committed history stays recoverable.
        retained = record["branch"]
        if not retained and not self.git(repo, "for-each-ref", "--contains", record["completed_head"],
                                         "--format=%(refname)", "refs/heads", "refs/remotes"):
            base = "hive/retained/" + hashlib.sha256(str(path).encode()).hexdigest()[:12] + "-" + record["completed_head"]
            retained = base
            branches = set(self.git(repo, "for-each-ref", "--format=%(refname)", "refs/heads").splitlines())
            suffix = 1
            while "refs/heads/" + retained in branches:
                retained = f"{base}-{suffix}"
                suffix += 1
            self.git(repo, "branch", retained, record["completed_head"])
        # Git performs its own final dirty/locked checks; never force removal or delete a branch.
        self.git(repo, "worktree", "remove", str(path))
        self.record_path(path).unlink()
        parent = path.parent
        grouping = repo.parent / ".worktrees"
        while parent.is_relative_to(grouping):
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
        return {"path": str(path), "status": "removed", "branch_retained": retained}

    def complete(self, path):
        path = plain_path(path, self.projects)
        record = self.load(path)
        self.validate(record["repo"], path)
        if self.git(path, "branch", "--show-current") != record["branch"]:
            raise ValueError("Branch changed after registration")
        self.clean_source(path)
        record.update(status="completed", completed_at=time.time(),
                      completed_head=self.git(path, "rev-parse", "HEAD"))
        self.save(record)
        return self.remove_completed(record)

    def prune(self):
        results = []
        if not self.state.exists():
            return results
        cursor_file = self.state / ".prune-cursor"
        if cursor_file.is_symlink():
            raise ValueError("Symlinked prune cursor is not managed")
        cursor = json.loads(cursor_file.read_text()) if cursor_file.exists() else ""
        if not isinstance(cursor, str) or (cursor and (Path(cursor).name != cursor or not cursor.endswith(".json"))):
            raise ValueError("Invalid prune cursor")
        files = sorted((file for file in self.state.iterdir() if file.suffix == ".json"),
                       key=lambda file: file.name)
        files = [file for file in files if file.name > cursor] + [file for file in files if file.name <= cursor]
        for index, file in enumerate(files):
            if index >= 200 or time.monotonic() >= self.deadline:
                results.append({"status": "deferred", "reason": "Maintenance budget reached"})
                break
            # Checkpoint before inspecting the record so malformed, active, slow,
            # or unremovable records cannot monopolize future bounded scans.
            self.write_state(cursor_file, file.name)
            try:
                if file.is_symlink():
                    raise ValueError("Symlinked record")
                raw = json.loads(file.read_text())
                path = plain_path(raw["path"], self.projects)
                record = self.load(path)
                if file != self.record_path(path):
                    raise ValueError("Record filename mismatch")
                if record["status"] == "completed":
                    results.append(self.remove_completed(record))
            except (OSError, ValueError, KeyError, subprocess.TimeoutExpired, TimeoutError) as error:
                results.append({"record": file.name, "status": "skipped", "reason": str(error)})
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", default=str(Path.home()), help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="Reuse or create .worktrees/<repo>/<task>")
    create.add_argument("repo")
    create.add_argument("task")
    create.add_argument("--branch", required=True)
    create.add_argument("--base", default="HEAD")
    adopt = sub.add_parser("adopt", help="Register an existing task checkout without changing files")
    adopt.add_argument("repo")
    adopt.add_argument("path")
    complete = sub.add_parser("complete", help="Finish a task and remove its idle clean checkout")
    complete.add_argument("path")
    sub.add_parser("prune", help="Retry cleanup of explicitly completed task checkouts")
    args = parser.parse_args()
    if os.environ.get("HIVE_WORKSPACE_PROFILE", "software") != "software":
        parser.error("Repository lifecycle operations belong in the software workspace")
    try:
        manager = Worktrees(args.home)
        with manager.lock():
            if args.command == "create":
                result = manager.create(args.repo, args.task, args.branch, args.base)
            elif args.command == "adopt":
                result = manager.adopt(args.repo, args.path)
            elif args.command == "complete":
                result = manager.complete(args.path)
            else:
                result = manager.prune()
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired, TimeoutError) as error:
        parser.exit(1, f"Worktree lifecycle: {error}\n")


if __name__ == "__main__":
    main()
