#!/usr/bin/env python3
"""Opt-in managed checkout prototype. CLI cleanup only records requests.

No arbitrary paths, remote URLs, adoption, controller impersonation, or production
deletion operation. The imported class supports explicit test authority injection;
that is not a security boundary against code already running as the workspace owner.
"""
from contextlib import contextmanager
from dataclasses import dataclass, field
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


class ManagedError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ManagedError(code)


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", value) is not None


def revision(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def canonical(value):
    return isinstance(value, str) and re.fullmatch(r"https://github\.com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}\.git", value) is not None


@dataclass(frozen=True)
class VerifiedRepository:
    repository_id: str
    canonical_url: str
    token: str = field(default="", repr=False)


class GitHubResolver:
    """Reuse the installed discovery helper's agent-only external-auth boundary."""
    def __init__(self, expected_account_id=None):
        self.expected_account_id = expected_account_id

    def resolve(self, repository_id):
        path = Path(__file__).with_name("github-projects.py")
        spec = importlib.util.spec_from_file_location("hive_github_projects", path)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        try:
            token = helper.external_token()
            if self.expected_account_id is not None:
                identity, _ = helper.github_json(token, "/user")
                require(str(identity.get("id")) == self.expected_account_id, "repository_account_changed")
            request = urllib.request.Request(
                f"https://api.github.com/repositories/{repository_id}",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                         "X-GitHub-Api-Version": helper.API_VERSION, "User-Agent": "Hive-managed-projects/1"},
            )
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), helper.NoRedirect())
            with opener.open(request, timeout=10) as response:
                require(response.status == 200, "repository_unavailable")
                payload = response.read(1024 * 1024 + 1)
                require(len(payload) <= 1024 * 1024, "repository_response_too_large")
                raw = json.loads(payload)
            metadata = helper.repository(raw)
            expected = metadata["htmlUrl"] + ".git"
            require(metadata["providerRepositoryId"] == repository_id and raw.get("clone_url") == expected
                    and metadata["permissions"]["pull"] is True and canonical(expected), "repository_identity_mismatch")
            return VerifiedRepository(repository_id, expected, token)
        except ManagedError:
            raise
        except Exception:
            # Never print provider responses, subprocess output, or authentication URLs.
            raise ManagedError("repository_auth_or_lookup_unavailable") from None


class GitDriver:
    """Production transport: HTTPS only, no inherited owner tokens or Git configuration."""
    def run(self, cwd, args, repository=None):
        environment = {key: os.environ[key] for key in ("PATH", "HOME", "USER", "LANG") if key in os.environ}
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                            "GIT_TERMINAL_PROMPT": "0", "GIT_TRACE": "0", "GIT_TRACE_CURL": "0",
                            "GIT_LFS_SKIP_SMUDGE": "1", "GIT_NO_REPLACE_OBJECTS": "1"})
        with tempfile.TemporaryDirectory(prefix="hive-managed-credential-") as private:
            if repository and repository.token:
                token_file = Path(private) / "token"
                token_file.write_text(repository.token)
                token_file.chmod(0o600)
                askpass = Path(private) / "askpass"
                askpass.write_text("#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\n"
                                   "prompt = sys.argv[1] if len(sys.argv)>1 else ''\n"
                                   "if 'Username' in prompt: print('x-access-token')\n"
                                   f"elif 'Password' in prompt: print(Path({str(token_file)!r}).read_text())\n"
                                   "else: raise SystemExit(1)\n")
                askpass.chmod(0o700)
                environment["GIT_ASKPASS"] = str(askpass)
            command = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                       "-c", "init.templateDir=", "-c", "http.followRedirects=false",
                       "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never",
                       "-c", "protocol.https.allow=always", *args]
            return self.execute(command, cwd, environment)

    @staticmethod
    def execute(command, cwd, environment):
        process = subprocess.Popen(command, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        output = bytearray()
        deadline = time.monotonic() + 45
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    require(remaining > 0 and selector.select(remaining), "git_timeout")
                    chunk = os.read(process.stdout.fileno(), min(65536, 2 * 1024 * 1024 + 1 - len(output)))
                    if not chunk:
                        break
                    output.extend(chunk)
                    require(len(output) <= 2 * 1024 * 1024, "git_output_too_large")
            require(process.wait(timeout=max(0.001, deadline - time.monotonic())) == 0, "git_failed")
            return bytes(output).decode("utf-8", errors="replace").strip()
        except subprocess.TimeoutExpired:
            raise ManagedError("git_timeout") from None
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            process.stdout.close()


class ManagedProjects:
    def __init__(self, home, resolver=None, git=None):
        self.home = Path(home).resolve()
        self.root = self.home / "projects/.hive-managed"
        self.state = self.home / ".local/state/hive/managed-projects"
        self.resolver = resolver or GitHubResolver()
        self.driver = git or GitDriver()
        self.key = None

    def safe(self, path):
        require(path.is_absolute() and path.is_relative_to(self.home) and path.resolve() == path,
                "symlink_or_path_escape")
        return path

    def private(self, path, directory=False):
        self.safe(path)
        info = path.stat()
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077
                and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)),
                "state_not_private")

    @staticmethod
    def identity(path):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode), "directory_required")
        return {"device": info.st_dev, "inode": info.st_ino}

    def signature(self, value):
        return hmac.new(self.key, json.dumps(value, sort_keys=True, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()

    def write(self, path, record):
        self.safe(path)
        envelope = {"record": record, "signature": self.signature(record)}
        fd, temporary = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(envelope, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def read(self, path):
        self.private(path)
        require(path.stat().st_size <= 1024 * 1024, "receipt_too_large")
        try:
            envelope = json.loads(path.read_text())
            require(hmac.compare_digest(envelope["signature"], self.signature(envelope["record"])), "receipt_signature_invalid")
            return envelope["record"]
        except (KeyError, TypeError, ValueError):
            raise ManagedError("receipt_invalid") from None

    @contextmanager
    def lock(self):
        self.safe(self.state)
        self.state.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.private(self.state, True)
        fd = os.open(self.state / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            key = self.state / "key"
            if not key.exists():
                require(not list(self.state.glob("*.json")), "receipt_key_missing")
                out = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(out, "wb") as stream:
                    stream.write(os.urandom(32))
                    stream.flush()
                    os.fsync(stream.fileno())
            self.private(key)
            self.key = key.read_bytes()
            require(len(self.key) == 32, "receipt_key_invalid")
            root_record = self.state / "root.json"
            self.safe(self.root)
            if not root_record.exists():
                require(not self.root.exists(), "unmanaged_root_exists")
                self.root.mkdir(parents=True, mode=0o700)
                self.write(root_record, {"schemaVersion": 1, "path": str(self.root), "identity": self.identity(self.root), "createdAt": time.time()})
            root = self.read(root_record)
            require(root["path"] == str(self.root) and root["identity"] == self.identity(self.root), "managed_root_changed")
            yield
        finally:
            os.close(fd)

    def paths(self, repository_id):
        require(isinstance(repository_id, str) and re.fullmatch(r"[1-9][0-9]{0,19}", repository_id), "invalid_repository_id")
        project = self.safe(self.root / "github" / repository_id)
        return project, self.state / f"github-{repository_id}.json"

    def load(self, repository_id):
        project, receipt = self.paths(repository_id)
        record = self.read(receipt)
        require(record["provider"] == "github" and record["repositoryId"] == repository_id
                and record["projectIdentity"] == self.identity(project), "project_identity_changed")
        return project, receipt, record

    def verified(self, repository_id):
        result = self.resolver.resolve(repository_id)
        require(result.repository_id == repository_id and canonical(result.canonical_url), "repository_identity_mismatch")
        return result

    def git(self, path, *args, repository=None):
        return self.driver.run(path, list(args), repository)

    def config_digest(self, config):
        """Ignore only validated upstream pairs; all other settings remain pinned.

        Parse with Git's grammar outside the checkout and explicitly disable includes.
        Never execute a command in a changed checkout before validating this policy.
        """
        self.safe(config)
        require(config.is_file() and config.stat().st_size <= 1024 * 1024, "git_configuration_changed")
        raw = self.git(self.home, "config", "--null", "--no-includes", "--file", str(config), "--list")
        pinned = []
        branches = {}
        for item in raw.split("\0"):
            if not item:
                continue
            key, separator, value = item.partition("\n")
            match = re.fullmatch(r"branch\.(.+)\.(remote|merge)", key)
            if not match:
                pinned.append((key, separator, value))
                continue
            branch, setting = match.groups()
            require(separator and setting not in branches.setdefault(branch, {}), "git_configuration_changed")
            branches[branch][setting] = value
        for branch, settings in branches.items():
            require(set(settings) == {"remote", "merge"} and settings["remote"] == "origin"
                    and settings["merge"].startswith("refs/heads/"), "git_configuration_changed")
            try:
                self.git(self.home, "check-ref-format", "refs/heads/" + branch)
                self.git(self.home, "check-ref-format", settings["merge"])
            except ManagedError:
                raise ManagedError("git_configuration_changed") from None
        return hashlib.sha256(json.dumps(sorted(pinned), separators=(",", ":")).encode()).hexdigest()

    def checkout_valid(self, checkout, record):
        self.safe(checkout)
        require(identifier(record.get("checkoutIncarnation")), "checkout_incarnation_missing")
        require(record.get("checkoutIdentity") == self.identity(checkout), "checkout_identity_changed")
        self.safe(checkout / ".git")
        require((checkout / ".git").is_dir(), "checkout_not_primary")
        require(not any((checkout / ".git" / name).exists() for name in
                        ("shallow", "objects/info/alternates", "info/grafts", "commondir")), "checkout_git_storage_changed")
        config = checkout / ".git/config"
        self.safe(config)
        require(record.get("gitConfigPolicy") == 1 and self.config_digest(config) == record.get("gitConfigDigest"), "git_configuration_changed")
        require(self.git(checkout, "rev-parse", "--show-toplevel") == str(checkout)
                and self.git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir") == str(checkout / ".git"), "checkout_git_path_changed")
        require(self.git(checkout, "remote", "get-url", "origin") == record["canonicalUrl"], "remote_identity_changed")

    def clean(self, checkout):
        require(not self.git(checkout, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"), "checkout_has_work")
        require(not self.git(checkout, "stash", "list"), "checkout_has_stash")

    def process_references(self, checkout):
        prefix = str(checkout)
        for process in Path("/proc").iterdir():
            if not process.name.isdigit():
                continue
            owned = False
            try:
                owned = process.stat().st_uid == os.getuid()
                if not owned:
                    continue
                for link in [process / "cwd", process / "exe", *(process / "fd").iterdir()]:
                    try:
                        target = os.readlink(link).removesuffix(" (deleted)")
                    except FileNotFoundError:
                        continue
                    if target == prefix or target.startswith(prefix + "/"):
                        return True
                for mapping in (process / "maps").read_text().splitlines():
                    parts = mapping.split(maxsplit=5)
                    if len(parts) == 6 and (parts[5] == prefix or parts[5].startswith(prefix + "/")):
                        return True
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                require(not owned, "process_inspection_unavailable")
        return False

    def no_consumers(self, path):
        require(not self.process_references(path), "checkout_in_use")

    def prepare(self, repository_id, task_id, requested_revision, lease_id=None, generation=None, ttl=900):
        require(identifier(task_id) and revision(requested_revision), "invalid_task_or_revision")
        require(type(ttl) is int and 30 <= ttl <= 3600, "invalid_lease_ttl")
        with self.lock():
            project, receipt = self.paths(repository_id)
            remote = self.verified(repository_id)
            if receipt.exists():
                project, receipt, record = self.load(repository_id)
                active = record.get("lease")
                if active:
                    require(type(generation) is int and active["taskId"] == task_id and active["id"] == lease_id
                            and active["generation"] == generation, "checkout_writer_busy")
                    require(record["revision"] == requested_revision, "resume_revision_mismatch")
                else:
                    require(lease_id is None and generation is None, "stale_lease")
            else:
                require(lease_id is None and generation is None, "stale_lease")
                require(not project.exists(), "unmanaged_project_exists")
                project.parent.mkdir(mode=0o700, exist_ok=True)
                project.mkdir(mode=0o700)
                record = {"schemaVersion": 1, "provider": "github", "repositoryId": repository_id,
                          "canonicalUrl": remote.canonical_url, "createdAt": time.time(),
                          "projectIdentity": self.identity(project), "checkoutIdentity": None, "checkoutIncarnation": None,
                          "revision": requested_revision, "status": "preparing", "stages": [],
                          "preparationId": str(uuid.uuid4()),
                          "leaseGeneration": 0, "lease": None, "lastTaskId": task_id, "cleanupRequests": []}
            require(record["canonicalUrl"] == remote.canonical_url, "repository_canonical_url_changed")
            checkout = self.safe(project / "checkout")
            publishing = next((stage for stage in record["stages"] if stage["status"] == "publishing"), None)
            if publishing:
                stage = self.safe(project / publishing["name"])
                if not checkout.exists():
                    require(stage.exists() and self.identity(stage) == record["checkoutIdentity"], "stage_identity_changed")
                    self.no_consumers(stage)
                    require(record.get("gitConfigPolicy") == 1 and self.config_digest(stage / ".git/config") == record["gitConfigDigest"], "git_configuration_changed")
                    os.rename(stage, checkout)
                require(self.identity(checkout) == record["checkoutIdentity"], "checkout_identity_changed")
                publishing["status"] = "published"
                self.write(receipt, record)
            if checkout.exists():
                self.checkout_valid(checkout, record)
                # Preserve modified work, but never claim an exact clean revision for it.
                self.clean(checkout)
                if not record["lease"]:
                    self.no_consumers(checkout)
                if self.git(checkout, "rev-parse", "HEAD") != requested_revision:
                    require(not record["lease"], "resume_revision_mismatch")
                    self.no_consumers(checkout)
                    self.git(checkout, "fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*", repository=remote)
                    require(not self.git(checkout, "rev-list", "--all", "--reflog", "HEAD", "--not", "--remotes=origin"), "commits_not_preserved_remotely")
                    self.git(checkout, "fetch", "--no-tags", "origin", requested_revision, repository=remote)
                    self.git(checkout, "checkout", "--detach", requested_revision, repository=remote)
            else:
                require(record.get("checkoutIdentity") is None, "checkout_missing_unexpectedly")
                if record.get("preparationId") is None:
                    record["preparationId"] = str(uuid.uuid4())
                record["leaseGeneration"] += 1
                record["lease"] = {"id": str(uuid.uuid4()), "taskId": task_id,
                                   "generation": record["leaseGeneration"], "expiresAt": time.time() + ttl}
                record["lastTaskId"] = task_id
                self.write(receipt, record)
                self.materialize(project, receipt, record, remote, requested_revision)
            record["leaseGeneration"] += 1
            record["lease"] = {"id": record["lease"]["id"] if record.get("lease") else str(uuid.uuid4()),
                               "taskId": task_id, "generation": record["leaseGeneration"], "expiresAt": time.time() + ttl}
            record["lastTaskId"] = task_id
            record["status"] = "ready"
            record["revision"] = requested_revision
            self.write(receipt, record)
            return self.summary(project, record)

    def materialize(self, project, receipt, record, remote, target):
        # Interrupted unsealed attempts are preserved. Only a signed publishing stage
        # is resumed in-place; otherwise make a bounded new attempt after provenance checks.
        for attempt in record["stages"]:
            stage = self.safe(project / attempt["name"])
            if attempt["status"] not in {"preparing", "interrupted"}:
                continue
            require(stage.exists() and self.identity(stage) == attempt["identity"], "stage_identity_changed")
            self.no_consumers(stage)
            # Do not run repository configuration from an interrupted unsealed clone.
            attempt["status"] = "preserved"
        require(sum(stage["preparationId"] == record["preparationId"] for stage in record["stages"]) < 3, "clone_attempt_budget_exhausted")
        stage = project / (".staging-" + str(uuid.uuid4()))
        stage.mkdir(mode=0o700)
        attempt = {"name": stage.name, "identity": self.identity(stage), "status": "preparing", "createdAt": time.time(), "preparationId": record["preparationId"]}
        record["stages"].append(attempt)
        self.write(receipt, record)
        try:
            self.git(project, "clone", "--no-checkout", "--filter=blob:none", "--origin", "origin", "--", remote.canonical_url, str(stage), repository=remote)
            require(self.git(stage, "remote", "get-url", "origin") == remote.canonical_url, "remote_identity_changed")
            self.git(stage, "fetch", "--no-tags", "origin", target, repository=remote)
            self.git(stage, "checkout", "--detach", target, repository=remote)
            require(self.git(stage, "rev-parse", "HEAD") == target, "clone_revision_mismatch")
            self.clean(stage)
            require(not (project / "checkout").exists(), "checkout_appeared_concurrently")
            record["checkoutIdentity"] = self.identity(stage)
            record["checkoutIncarnation"] = str(uuid.uuid4())
            record["gitConfigDigest"] = self.config_digest(stage / ".git/config")
            record["gitConfigPolicy"] = 1
            record["revision"] = target
            attempt["status"] = "publishing"
            self.write(receipt, record)
            os.rename(stage, project / "checkout")
            attempt["status"] = "published"
        except (OSError, ManagedError):
            if attempt["status"] != "publishing":
                attempt["status"] = "interrupted"
            record["status"] = "interrupted"
            self.write(receipt, record)
            raise
        self.write(receipt, record)

    @staticmethod
    def summary(project, record):
        return {"provider": "github", "repositoryId": record["repositoryId"], "projectDirectory": str(project),
                "checkoutDirectory": str(project / "checkout") if record.get("checkoutIdentity") else None,
                "revision": record["revision"], "status": record["status"], "lease": record["lease"],
                "preservedStages": [stage["name"] for stage in record["stages"] if stage["status"] != "published"]}

    def inspect(self, repository_id):
        with self.lock():
            project, receipt = self.paths(repository_id)
            if not receipt.exists():
                require(not project.exists(), "unmanaged_project_exists")
                return {"provider": "github", "repositoryId": repository_id, "status": "not_created",
                        "checkoutVerified": False, "lease": None, "revision": None}
            project, _, record = self.load(repository_id)
            # Read-only provenance check, deliberately without clean(): unfinished
            # edits are valid active-task state, but a replaced checkout is not.
            verified = record["status"] == "ready"
            if verified:
                self.checkout_valid(project / "checkout", record)
            return {**self.summary(project, record), "checkoutVerified": verified}

    def release_lease(self, repository_id, task_id, lease_id, generation, expected_revision):
        require(revision(expected_revision), "invalid_revision")
        with self.lock():
            project, receipt, record = self.load(repository_id)
            lease = record.get("lease")
            require(type(generation) is int and lease and (lease["taskId"], lease["id"], lease["generation"]) == (task_id, lease_id, generation), "stale_lease")
            if record.get("checkoutIdentity"):
                checkout = project / "checkout"
                self.checkout_valid(checkout, record)
                require(self.git(checkout, "rev-parse", "HEAD") == expected_revision, "release_revision_mismatch")
                self.no_consumers(checkout)
            record["revision"] = expected_revision
            record["lease"] = None
            self.write(receipt, record)
            return self.summary(project, record)

    def request_cleanup(self, repository_id, task_id):
        require(identifier(task_id), "invalid_task")
        with self.lock():
            project, receipt, record = self.load(repository_id)
            require(task_id == record["lastTaskId"], "cleanup_task_mismatch")
            require(len(record["cleanupRequests"]) < 100, "cleanup_request_limit")
            record["cleanupRequests"].append({"id": str(uuid.uuid4()), "taskId": task_id, "revision": record["revision"], "checkoutIdentity": record["checkoutIdentity"], "checkoutIncarnation": record.get("checkoutIncarnation"), "leaseGeneration": record["leaseGeneration"], "requestedAt": time.time()})
            self.write(receipt, record)
            return {"status": "controller_authority_unavailable", "checkoutRetained": True,
                    "requestId": record["cleanupRequests"][-1]["id"]}

    def _remove_with_authority(self, repository_id, task_id, signed_evidence, authority):
        """Internal validation seam; no CLI/env path supplies an authority or calls it.

        Production controller verification is deliberately unimplemented. Unit tests
        inject their independently keyed test controller, never a self-asserted bool.
        """
        with self.lock():
            project, receipt, record = self.load(repository_id)
            require(authority is not None, "controller_authority_unavailable")
            require(task_id == record["lastTaskId"] and record["cleanupRequests"] and not record["lease"], "cleanup_not_quiescent")
            cleanup_request = record["cleanupRequests"][-1]
            require(cleanup_request["taskId"] == task_id and cleanup_request["revision"] == record["revision"]
                    and cleanup_request["checkoutIdentity"] == record["checkoutIdentity"]
                    and identifier(record.get("checkoutIncarnation"))
                    and cleanup_request.get("checkoutIncarnation") == record["checkoutIncarnation"]
                    and cleanup_request.get("leaseGeneration") == record["leaseGeneration"], "cleanup_request_stale")
            expected = {"repositoryId": repository_id, "taskId": task_id, "revision": record["revision"],
                        "projectIdentity": record["projectIdentity"], "checkoutIdentity": record["checkoutIdentity"], "checkoutIncarnation": record["checkoutIncarnation"], "leaseGeneration": record["leaseGeneration"], "cleanupRequestId": cleanup_request["id"]}
            evidence = authority.verify(signed_evidence, expected)
            require(isinstance(evidence, dict) and evidence.get("binding") == expected
                    and identifier(evidence.get("completionEventId")) and identifier(evidence.get("policyVersion")), "invalid_completion_evidence")
            artifact = evidence.get("artifact", {})
            observation = evidence.get("productionObservation", {})
            require(isinstance(artifact, dict) and isinstance(observation, dict)
                    and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", ""))
                    and identifier(artifact.get("objectVersion")) and identifier(observation.get("id"))
                    and observation.get("revision") == record["revision"]
                    and observation.get("artifactDigest") == artifact["digest"], "invalid_preservation_evidence")
            checkout = project / "checkout"
            self.checkout_valid(checkout, record)
            require(self.git(checkout, "rev-parse", "HEAD") == record["revision"], "cleanup_revision_changed")
            self.clean(checkout)
            self.no_consumers(checkout)
            for line in Path("/proc/self/mountinfo").read_text().splitlines():
                mounted = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), line.split()[4])
                require(not (mounted == str(checkout) or mounted.startswith(str(checkout) + "/")), "checkout_has_mount")
            require(self.git(checkout, "worktree", "list", "--porcelain").count("worktree ") == 1, "checkout_has_linked_worktrees")
            for directory, names, files in os.walk(checkout, followlinks=False):
                current = Path(directory)
                for name in names + files:
                    path = current / name
                    info = path.lstat()
                    require(not path.is_symlink() and (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)), "checkout_has_special_path")
                    require(not (name == ".git" and path != checkout / ".git"), "checkout_has_nested_repository")
                require(not (current != checkout / ".git" and {"HEAD", "objects", "refs"}.issubset(set(names + files))), "checkout_has_nested_repository")
            remote = self.verified(repository_id)
            require(remote.canonical_url == record["canonicalUrl"], "repository_canonical_url_changed")
            self.git(checkout, "fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*", repository=remote)
            require(not self.git(checkout, "rev-list", "--all", "--reflog", "HEAD", "--not", "--remotes=origin"), "commits_not_preserved_remotely")
            self.clean(checkout)
            self.no_consumers(checkout)
            evidence_dir = project / "evidence"
            self.safe(evidence_dir)
            evidence_dir.mkdir(mode=0o700, exist_ok=True)
            self.write(evidence_dir / f"{evidence['completionEventId']}.json", evidence)
            require(self.identity(checkout) == record["checkoutIdentity"] and shutil.rmtree.avoids_symlink_attacks, "safe_removal_unavailable")
            shutil.rmtree(checkout)
            record["checkoutIdentity"] = None
            record["checkoutIncarnation"] = None
            record["gitConfigDigest"] = None
            record["preparationId"] = None
            record["status"] = "checkout_removed"
            self.write(receipt, record)
            return self.summary(project, record)


def dispatch(manager, value):
    common = {"schemaVersion", "operation", "provider", "repositoryId"}
    operation = value.get("operation") if isinstance(value, dict) else None
    fields = {
        "prepare": {"taskId", "revision", "leaseId", "generation", "ttlSeconds", "expectedAccountId"},
        "inspect": set(), "releaseLease": {"taskId", "leaseId", "generation", "revision"},
        "requestCleanup": {"taskId"},
    }
    require(operation in fields and set(value) <= common | fields[operation]
            and type(value.get("schemaVersion")) is int and value["schemaVersion"] == 1
            and value.get("provider") == "github", "invalid_request")
    repository_id = value.get("repositoryId")
    if operation == "prepare":
        if "expectedAccountId" in value:
            account = value["expectedAccountId"]
            require(isinstance(account, str) and re.fullmatch(r"[1-9][0-9]{0,19}", account), "invalid_account")
            require(isinstance(manager.resolver, GitHubResolver), "account_verifier_required")
            manager.resolver.expected_account_id = account
        return manager.prepare(repository_id, value.get("taskId"), value.get("revision"), value.get("leaseId"), value.get("generation"), value.get("ttlSeconds", 900))
    if operation == "inspect":
        return manager.inspect(repository_id)
    if operation == "releaseLease":
        return manager.release_lease(repository_id, value.get("taskId"), value.get("leaseId"), value.get("generation"), value.get("revision"))
    return manager.request_cleanup(repository_id, value.get("taskId"))


def main():
    try:
        require(len(sys.argv) == 1, "arguments_not_supported")
        raw = sys.stdin.buffer.read(8193)
        require(len(raw) <= 8192, "request_too_large")
        # HOME/env cannot redirect production receipts or turn on fixture transports.
        manager = ManagedProjects(pwd.getpwuid(os.getuid()).pw_dir)
        result = dispatch(manager, json.loads(raw))
        print(json.dumps({"ok": True, "data": result}))
    except ManagedError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        raise SystemExit(1)
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"ok": False, "error": "managed_project_operation_rejected"}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
