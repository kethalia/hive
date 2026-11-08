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

# Keep the installed package unchanged when loading sibling authentication helpers.
sys.dont_write_bytecode = True


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


class InstalledSealedHostObserver:
    """Construction fact only. Fixed installed bytes, never a PID/request option."""
    def __init__(self, home):
        self.home = Path(home).resolve()
        self.module = Path(__file__).resolve().with_name("codex-unstarted-transfer.mjs")

    def __call__(self):
        state = self.home / ".local/state/hive/codex-host-guardian"
        manager = ManagedProjects(self.home)
        manager.safe(state)
        if not os.path.lexists(state):
            return None  # Unguarded installs receive no exemption; scan strictly.
        manager.private(state, True)
        manager.private(state / "key")
        manager.private(state / "lifetime.json")
        key = (state / "key").read_bytes()
        require(len(key) == 32 and (state / "lifetime.json").stat().st_size <= 2 * 1024 * 1024, "sealed_guardian_unavailable")
        saved = json.loads((state / "lifetime.json").read_text())
        encoded = json.dumps(saved["state"], separators=(",", ":"), ensure_ascii=False).encode()
        require(hmac.compare_digest(saved["signature"], hmac.new(key, encoded, hashlib.sha256).hexdigest()), "sealed_guardian_unavailable")
        startup = saved["state"]["events"][4]["value"]
        install = self.home / ".local/state/hive/codex-host-install/process.json"
        manager.private(install)
        require(install.stat().st_size <= 65536, "sealed_guardian_unavailable")
        archive = json.loads(install.read_text())["archiveSha256"]
        require(isinstance(archive, str) and re.fullmatch(r"[0-9a-f]{64}", archive), "sealed_guardian_unavailable")
        directory = self.home / ".local/share/hive/codex-host" / archive
        require(self.module.parent == directory and self.module.resolve() == self.module, "sealed_guardian_unavailable")
        manager.private(directory, True)
        manifest_file = directory / "package-manifest.json"
        manager.private(manifest_file)
        require(manifest_file.stat().st_size <= 65536, "sealed_guardian_unavailable")
        manifest_raw = manifest_file.read_bytes()
        require(hashlib.sha256(manifest_raw).hexdigest() == startup["packageManifestSha256"], "sealed_guardian_package_changed")
        manifest = json.loads(manifest_raw)
        files = manifest.get("files")
        require(isinstance(files, dict) and 1 <= len(files) <= 64 and self.module.name in files, "sealed_guardian_package_changed")
        total = 0
        for name, digest in files.items():
            require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", name)
                    and all(p not in {".", ".."} for p in name.split("/"))
                    and isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest), "sealed_guardian_package_changed")
            file = directory / name
            manager.private(file)
            info = file.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 2 * 1024 * 1024, "sealed_guardian_package_changed")
            total += info.st_size
            require(total <= 2 * 1024 * 1024 and hashlib.sha256(file.read_bytes()).hexdigest() == digest, "sealed_guardian_package_changed")
        members = []
        for member in directory.rglob("*"):
            members.append(member)
            require(len(members) <= 128, "sealed_guardian_package_changed")
        require(all(not p.is_symlink() for p in members)
                and {str(p.relative_to(directory)) for p in members if p.is_file()} == set(files) | {"package-manifest.json"}, "sealed_guardian_package_changed")
        # No exception is needed once this exact actor is gone. This does not
        # establish tree closure: the ordinary scanner and operation guards run.
        actor = startup["guardianIdentity"]
        require(type(actor.get("pid")) is int and actor["pid"] > 0, "sealed_guardian_unavailable")
        try:
            raw = (Path("/proc") / str(actor["pid"]) / "stat").read_text()
            fields = raw[raw.rindex(") ") + 2:].split()
            if fields[0] in {"Z", "X"} or fields[19] != actor["startTime"] or Path("/proc/sys/kernel/random/boot_id").read_text().strip() != actor["bootId"]:
                return None
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            return None
        node = Path(startup["outerIdentity"]["executable"])
        roots = saved["state"]["events"][0]["value"]["hostRootInventory"]
        require(node.is_absolute() and node.resolve() == node and isinstance(roots, list) and len(roots) == 1
                and roots[0]["id"] == "host-worker" and roots[0]["role"] == "host"
                and roots[0]["executable"] == str(node) and roots[0]["sha256"] == startup["nodeSha256"], "sealed_guardian_unavailable")
        info = node.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                and info.st_size <= 256 * 1024 * 1024
                and hashlib.sha256(node.read_bytes()).hexdigest() == startup["nodeSha256"], "sealed_guardian_unavailable")
        code = "const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.verifySealedHostConstruction(process.argv[2])));"
        result = subprocess.run([str(node), "--input-type=module", "-e", code, self.module.as_uri(), str(self.home)],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, timeout=2, check=True)
        require(len(result.stdout) <= 8192, "sealed_guardian_unavailable")
        return json.loads(result.stdout)


class ManagedProjects:
    require_source = staticmethod(require)

    def _apply_accepted_source(self, repository_id, project_id, operation_id, authority, input_barrier, objects, checkpoint=None):
        """Internal inert composition only; never exposed through dispatch/CLI."""
        spec = importlib.util.spec_from_file_location("hive_managed_source_apply", Path(__file__).with_name("managed-source-apply.py"))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        return helper.apply(self, repository_id, project_id, operation_id, authority, input_barrier, objects, checkpoint)

    def __init__(self, home, resolver=None, git=None):
        self.home = Path(home).resolve()
        self.root = self.home / "projects/.hive-managed"
        self.state = self.home / ".local/state/hive/managed-projects"
        self.resolver = resolver or GitHubResolver()
        self.driver = git or GitDriver()
        self.key = None
        self._installed_observer = None

    @classmethod
    def installed(cls, home):
        manager = cls(home)
        manager._installed_observer = InstalledSealedHostObserver(manager.home)
        return manager

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
    def lock(self, remount=None):
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
            if remount is not None:
                require(root_record.exists() and self.root.exists(), "remount_receipt_missing")
            if not root_record.exists():
                require(not self.root.exists(), "unmanaged_root_exists")
                self.root.mkdir(parents=True, mode=0o700)
                self.write(root_record, {"schemaVersion": 1, "path": str(self.root), "identity": self.identity(self.root), "createdAt": time.time()})
            root = self.read(root_record)
            marker = self.state / "unstarted-remount.json"
            if marker.exists():
                pending = self.read(marker)
                require(pending.get("phase") == "complete" or remount is not None, "remount_reconciliation_required")
            require(root["path"] == str(self.root) and (remount is not None or root["identity"] == self.identity(self.root)), "managed_root_changed")
            if remount is not None:
                self._remount_ticket(remount)
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

    def _sealed_guardian(self, value, checkout):
        construction = {"guardian", "outer", "sourceSha256", "guardianSha256", "constructionDigest", "cwd", "lifetimeId"}
        require(isinstance(value, dict) and value.get("sourceSha256") == "3f633c951f47a99e885f5761146522a32793e6adbd274481d4dfc01b8d4ce4a3"
                and (set(value) == construction or (set(value) == construction | {"recoveryId", "expiresAt"}
                     and value["expiresAt"] > time.time() * 1000)), "sealed_guardian_unavailable")
        identity, outer, cwd = value["guardian"], value["outer"], value["cwd"]
        require(cwd["path"] == str(self.home / ".local/share/hive/codex-host") and not Path(cwd["path"]).is_relative_to(checkout),
                "sealed_guardian_unavailable")
        self.private(Path(cwd["path"]), True)
        require(self.identity(Path(cwd["path"])) == {k: int(cwd[k]) for k in ("device", "inode")}, "sealed_guardian_changed")
        proc = Path("/proc") / str(identity["pid"])
        raw = (proc / "stat").read_text(); fields = raw[raw.rindex(") ") + 2:].split()
        uids = next((line.split()[1:] for line in (proc / "status").read_text().splitlines() if line.startswith("Uid:")), [])
        require(fields[0] not in {"Z", "X"} and fields[19] == identity["startTime"] and int(fields[1]) == outer["pid"]
                and identity["parentPid"] == outer["pid"] and len(uids) == 4 and all(int(v) == os.getuid() for v in uids)
                and Path("/proc/sys/kernel/random/boot_id").read_text().strip() == identity["bootId"], "sealed_guardian_changed")
        parent = Path("/proc") / str(outer["pid"])
        parent_stat = (parent / "stat").read_text(); parent_fields = parent_stat[parent_stat.rindex(") ") + 2:].split()
        parent_uids = next((line.split()[1:] for line in (parent / "status").read_text().splitlines() if line.startswith("Uid:")), [])
        require(parent_fields[0] not in {"Z", "X"} and parent_fields[19] == outer["startTime"]
                and outer["bootId"] == identity["bootId"] and len(parent_uids) == 4 and all(int(v) == os.getuid() for v in parent_uids),
                "sealed_guardian_changed")
        return identity["pid"]

    def process_references(self, checkout, _guardian=None):
        prefix = str(checkout)
        sealed = _guardian() if _guardian is not None else None
        guardian_pid = self._sealed_guardian(sealed, checkout) if sealed else None
        try:
            for process in Path("/proc").iterdir():
                if not process.name.isdigit(): continue
                owned = None
                try:
                    # A nondumpable same-real-UID process can have root-owned
                    # proc inodes. Status UIDs, not directory owner, decide scope.
                    with (process / "status").open() as source: status = source.read(65537)
                    require(len(status) <= 65536, "process_inspection_unavailable")
                    uids = next((line.split()[1:] for line in status.splitlines() if line.startswith("Uid:")), [])
                    require(len(uids) == 4 and all(v.isdigit() for v in uids), "process_inspection_unavailable")
                    owned = any(int(v) == os.getuid() for v in uids)
                    if not owned: continue
                    exempt = int(process.name) == guardian_pid
                    links = [process / "cwd", process / "exe"]
                    try: links.extend((process / "fd").iterdir())
                    except PermissionError: require(exempt, "process_inspection_unavailable")
                    for link in links:
                        try: target = os.readlink(link).removesuffix(" (deleted)")
                        except FileNotFoundError: continue
                        except PermissionError:
                            require(exempt, "process_inspection_unavailable"); continue
                        if target == prefix or target.startswith(prefix + "/"): return True
                    try: mappings = (process / "maps").read_text().splitlines()
                    except PermissionError:
                        require(exempt, "process_inspection_unavailable"); mappings = []
                    for mapping in mappings:
                        parts = mapping.split(maxsplit=5)
                        if len(parts) == 6 and (parts[5] == prefix or parts[5].startswith(prefix + "/")): return True
                except (FileNotFoundError, ProcessLookupError): continue
                except PermissionError:
                    require(owned is False, "process_inspection_unavailable")
            return False
        finally:
            if sealed:
                require(_guardian() == sealed, "sealed_guardian_changed")
                self._sealed_guardian(sealed, checkout)

    def no_consumers(self, path, _guardian=None):
        require(not self.process_references(path, _guardian if _guardian is not None else self._installed_observer), "checkout_in_use")

    def prepare(self, repository_id, task_id, requested_revision, lease_id=None, generation=None, ttl=900):
        require(identifier(task_id) and revision(requested_revision), "invalid_task_or_revision")
        require(type(ttl) is int and 30 <= ttl <= 3600, "invalid_lease_ttl")
        with self.lock():
            project, receipt = self.paths(repository_id)
            remote = self.verified(repository_id)
            if receipt.exists():
                project, receipt, record = self.load(repository_id)
                require(not record.get("sourceUpdating"), "source_update_pending")
                require(not record.get("acceptedSource"), "accepted_source_prepare_unavailable")
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
                          "leaseGeneration": 0, "renewalSequence": 0, "lease": None, "lastTaskId": task_id, "cleanupRequests": []}
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
        result = {"provider": "github", "repositoryId": record["repositoryId"], "projectDirectory": str(project),
                "checkoutDirectory": str(project / "checkout") if record.get("checkoutIdentity") else None,
                "revision": record["revision"], "status": record["status"], "lease": record["lease"],
                "checkoutIncarnation": record.get("checkoutIncarnation"), "renewalSequence": record.get("renewalSequence", 0),
                "checkoutIdentity": {key: str(value) for key, value in record["checkoutIdentity"].items()} if record.get("checkoutIdentity") else None,
                "preservedStages": [stage["name"] for stage in record["stages"] if stage["status"] != "published"]}
        if record.get("acceptedSource") is not None:
            result["acceptedSource"] = record["acceptedSource"]
        if record.get("sourceUpdating") is not None:
            result["sourceUpdating"] = {key: record["sourceUpdating"][key] for key in ("operationId", "phase")}
        return result

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
            verified = record["status"] == "ready" and not record.get("sourceUpdating")
            if verified:
                self.checkout_valid(project / "checkout", record)
            return {**self.summary(project, record), "checkoutVerified": verified}

    def _renew_controller_lease(self, repository_id, project_id, authority, ttl=3600):
        """Installed helper only. No dispatch/CLI operation accepts renewal fields.

        Authority re-reads private signed journals and kernel process identities
        under the managed writer lock. Dirty/untracked/ignored work is retained.
        """
        require(authority is not None and type(ttl) is int and 30 <= ttl <= 3600, "renewal_authority_required")
        with self.lock():
            project, receipt, record = self.load(repository_id)
            lease = record.get("lease")
            require(record["status"] == "ready" and not record.get("sourceUpdating")
                    and lease and lease["expiresAt"] > time.time(), "lease_not_active")
            sequence = record.get("renewalSequence", 0)
            require(type(sequence) is int and 0 <= sequence < 9007199254740991, "invalid_renewal_sequence")
            expected = {"repositoryId": repository_id, "taskId": lease["taskId"], "leaseId": lease["id"],
                        "leaseGeneration": lease["generation"], "revision": record["revision"],
                        "checkoutIncarnation": record["checkoutIncarnation"]}
            require(identifier(expected["checkoutIncarnation"]), "checkout_incarnation_missing")
            if record.get("acceptedSource") is not None:
                expected["currentSource"] = record["acceptedSource"]
            authority.verify(project_id, expected)
            self.checkout_valid(project / "checkout", record)
            if record.get("acceptedSource") is not None:
                require(self.git(project / "checkout", "rev-parse", "HEAD") == record["acceptedSource"]["headSha"], "renewal_source_changed")
            # Recheck expiry after bounded authority/provenance inspection; a
            # slow validation cannot revive an authority that expired meanwhile.
            now = time.time()
            require(lease["expiresAt"] > now, "lease_not_active")
            lease["expiresAt"] = now + ttl
            record["renewalSequence"] = sequence + 1
            record["lastRenewedAt"] = now
            # Keep old requests as evidence. Their sequence no longer authorizes
            # cleanup, even after release; clearing a flag alone is insufficient.
            self.write(receipt, record)
            return self.summary(project, record)

    @staticmethod
    def _remount_digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

    @staticmethod
    def _remount_identity(value):
        require(isinstance(value, dict) and set(value) == {"device", "inode"}
                and all(isinstance(v, str) and re.fullmatch(r"[0-9]{1,24}", v) for v in value.values()), "remount_identity_invalid")
        return {k: int(v) for k, v in value.items()}

    def _remount_ticket(self, ticket):
        require(isinstance(ticket, dict) and ticket.get("expiresAt", 0) > time.time() * 1000
                and all(isinstance(ticket.get(k), str) and re.fullmatch(r"[a-f0-9]{64}", ticket[k])
                        for k in ["attestationDigest", "continuationDigest", "originalProofDigest"]), "remount_authority_invalid")
        mapping = ticket["mapping"]
        old, current = mapping["old"], mapping["current"]
        require(set(old) == set(current) == {"root", "project", "checkout"}, "remount_identity_invalid")
        for group in [old, current]:
            for value in group.values(): self._remount_identity(value)
            require(len({v["device"] for v in group.values()}) == 1, "remount_volume_changed")
        require(old["root"]["device"] != current["root"]["device"]
                and all(old[k]["inode"] == current[k]["inode"] for k in old), "remount_volume_changed")
        require(ticket["volume"]["mountPath"] == str(self.home) and ticket["volume"]["subPath"] == ""
                and ticket["volume"]["subPathExpr"] == "" and ticket["volume"]["readOnly"] is False
                and ticket["volume"]["claimReadOnly"] is False, "remount_volume_changed")
        return mapping

    def _remount_mount(self, paths, device):
        mounts = []
        for row in Path("/proc/self/mountinfo").read_text().splitlines():
            fields = row.split(); require(len(fields) >= 6, "remount_mount_unknown")
            point = fields[4].replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")
            mounts.append((fields[0], fields[2], fields[3], point))
        selected = []
        for path in [self.home, *paths]:
            matches = [m for m in mounts if str(path) == m[3] or str(path).startswith(m[3].rstrip("/") + "/")]
            require(matches, "remount_mount_unknown")
            selected.append(max(matches, key=lambda m: len(m[3])))
        require(len(set(selected)) == 1 and selected[0][3] == str(self.home)
                and selected[0][1] == f"{os.major(device)}:{os.minor(device)}", "remount_mount_changed")

    def _remount_records(self, repository_id, ticket, guardian=None):
        mapping = self._remount_ticket(ticket)
        project, receipt = self.paths(repository_id)
        paths = {"root": self.root, "project": project, "checkout": project / "checkout"}
        for key, path in paths.items():
            self.private(path, True)
            require(self.identity(path) == self._remount_identity(mapping["current"][key]), "remount_identity_changed")
        self._remount_mount(list(paths.values()), int(mapping["current"]["root"]["device"]))
        require([x.name for x in self.state.glob("github-*.json")] == [receipt.name], "remount_competing_repository")
        root_file = self.state / "root.json"
        marker_file = self.state / "unstarted-remount.json"
        marker = self.read(marker_file) if marker_file.exists() else None
        if marker:
            require(marker["mappingDigest"] == self._remount_digest(mapping) and marker["attestationDigest"] == ticket["attestationDigest"]
                    and marker["continuationDigest"] == ticket["continuationDigest"] and marker["recoveryId"] == ticket["recoveryId"], "remount_replay_conflict")
            for file, old, new, old_raw, new_raw in [
                    (root_file, marker["oldRoot"], marker["newRoot"], marker["oldRootRaw"], marker["newRootRaw"]),
                    (receipt, marker["oldProject"], marker["newProject"], marker["oldProjectRaw"], marker["newProjectRaw"])]:
                actual = self.read(file)
                require(actual in [old, new] and file.read_bytes() in [old_raw.encode(), new_raw.encode()], "remount_replay_conflict")
            require(hashlib.sha256(marker["oldRootRaw"].encode()).hexdigest() == mapping["oldRootRecordSha256"]
                    and hashlib.sha256(marker["oldProjectRaw"].encode()).hexdigest() == mapping["oldProjectRecordSha256"], "remount_receipt_changed")
            root, record = marker["oldRoot"], marker["oldProject"]
        else:
            for file, key in [(root_file, "oldRootRecordSha256"), (receipt, "oldProjectRecordSha256")]:
                self.private(file)
                require(hashlib.sha256(file.read_bytes()).hexdigest() == mapping[key], "remount_receipt_changed")
            root, record = self.read(root_file), self.read(receipt)
        require(root["path"] == str(self.root) and root["identity"] == self._remount_identity(mapping["old"]["root"])
                and record["projectIdentity"] == self._remount_identity(mapping["old"]["project"])
                and record["checkoutIdentity"] == self._remount_identity(mapping["old"]["checkout"])
                and record["status"] == "ready" and not record.get("sourceUpdating") and not record.get("acceptedSource")
                and record["lease"]["taskId"] == ticket["taskId"] and record["repositoryId"] == repository_id,
                "remount_binding_changed")
        lease = record["lease"]
        require(self._remount_digest({"id": lease["id"], "taskId": lease["taskId"], "generation": lease["generation"],
                "expiresAtMillis": int(lease["expiresAt"] * 1000)}) == mapping["oldLeaseDigest"], "remount_lease_changed")
        physical = dict(record, checkoutIdentity=self._remount_identity(mapping["current"]["checkout"]))
        self.checkout_valid(project / "checkout", physical)
        require(self.git(project / "checkout", "rev-parse", "HEAD") == record["revision"], "renewal_source_changed")
        self.clean(project / "checkout"); self.no_consumers(project / "checkout", guardian)
        return project, receipt, root, record, marker

    def _inspect_unstarted_checkout(self, repository_id, project_id, authority):
        ticket = authority.continuity(project_id, "inspecting")
        if ticket is None: return self.inspect(repository_id)
        guardian = (lambda: authority.guardian(project_id)) if hasattr(authority, "guardian") else None
        with self.lock(remount=ticket):
            project, _, _, record, _ = self._remount_records(repository_id, ticket, guardian)
            require(authority.continuity(project_id, "inspecting") == ticket, "remount_authority_changed")
            self._remount_ticket(ticket)
            return {**self.summary(project, record), "checkoutVerified": True, "remount": {
                "attestationDigest": ticket["attestationDigest"], "continuationDigest": ticket["continuationDigest"],
                "mappingDigest": self._remount_digest(ticket["mapping"]), "volumeDigest": self._remount_digest(ticket["volume"]),
                "mapping": ticket["mapping"]}}

    def _revalidate_unstarted_remount(self, repository_id, project_id, authority, ticket, ttl):
        guardian = (lambda: authority.guardian(project_id)) if hasattr(authority, "guardian") else None
        with self.lock(remount=ticket):
            project, receipt, root, record, marker = self._remount_records(repository_id, ticket, guardian)
            lease = record["lease"]
            expected = {"repositoryId": repository_id, "taskId": lease["taskId"], "leaseId": lease["id"],
                "leaseGeneration": lease["generation"], "revision": record["revision"], "checkoutIncarnation": record["checkoutIncarnation"],
                "checkoutIdentity": ticket["mapping"]["old"]["checkout"]}
            grant = authority.verify(project_id, expected)
            require(grant["expiresAt"] > time.time() * 1000 and authority.continuity(project_id, "consuming") == ticket,
                    "remount_authority_changed")
            if not marker:
                require(not grant.get("replayOnly"), "remount_replay_conflict")
                require(not record.get("unstartedRevalidation") and (record.get("renewalSequence", 0) == grant["renewalSequence"]), "remount_replay_conflict")
                new_root = dict(root, identity=self._remount_identity(ticket["mapping"]["current"]["root"]))
                new_record = json.loads(json.dumps(record)); now = time.time()
                new_record["projectIdentity"] = self._remount_identity(ticket["mapping"]["current"]["project"])
                new_record["checkoutIdentity"] = self._remount_identity(ticket["mapping"]["current"]["checkout"])
                new_record["lease"]["expiresAt"] = now + ttl
                new_record["renewalSequence"] = record.get("renewalSequence", 0) + 1
                new_record["lastRenewedAt"] = now
                new_record["unstartedRevalidation"] = {"transferId": grant["transferId"], "recoveryId": grant["recoveryId"],
                    "proofDigest": grant["proofDigest"], "expected": expected, "previousLease": dict(lease),
                    "newLease": dict(new_record["lease"]), "renewalSequence": new_record["renewalSequence"],
                    "remountDigest": self._remount_digest(ticket["mapping"]), "attestationDigest": ticket["attestationDigest"]}
                marker = {"schemaVersion": 1, "phase": "pending", "mappingDigest": self._remount_digest(ticket["mapping"]),
                    "attestationDigest": ticket["attestationDigest"], "continuationDigest": ticket["continuationDigest"],
                    "recoveryId": ticket["recoveryId"], "oldRoot": root, "newRoot": new_root,
                    "oldProject": record, "newProject": new_record,
                    "oldRootRaw": (self.state / "root.json").read_text(), "oldProjectRaw": receipt.read_text(),
                    "newRootRaw": json.dumps({"record": new_root, "signature": self.signature(new_root)}, sort_keys=True),
                    "newProjectRaw": json.dumps({"record": new_record, "signature": self.signature(new_record)}, sort_keys=True)}
                require(authority.verify(project_id, expected) == grant and grant["expiresAt"] > time.time() * 1000,
                        "renewal_authority_expired")
                self._remount_ticket(ticket)
                self.write(self.state / "unstarted-remount.json", marker)
            require(authority.verify(project_id, expected) == grant and authority.continuity(project_id, "consuming") == ticket
                    and grant["expiresAt"] > time.time() * 1000, "renewal_authority_expired")
            self._remount_records(repository_id, ticket, guardian)
            if marker["phase"] == "complete": return self.summary(project, marker["newProject"])
            for file, replacement in [(self.state / "root.json", marker["newRoot"]), (receipt, marker["newProject"])]:
                require(authority.verify(project_id, expected) == grant and grant["expiresAt"] > time.time() * 1000,
                        "renewal_authority_expired")
                self._remount_ticket(ticket)
                self.write(file, replacement)
            require(authority.verify(project_id, expected) == grant and grant["expiresAt"] > time.time() * 1000,
                    "renewal_authority_expired")
            self._remount_ticket(ticket)
            self.write(self.state / "unstarted-remount.json", dict(marker, phase="complete"))
            return self.summary(project, marker["newProject"])

    def _revalidate_unstarted_lease(self, repository_id, project_id, authority, ttl=3600):
        """Private owner recovery only; expiry never releases the retained writer."""
        require(authority is not None and type(ttl) is int and 30 <= ttl <= 3600, "renewal_authority_required")
        continuity = authority.continuity(project_id, "consuming") if hasattr(authority, "continuity") else None
        if continuity is not None:
            return self._revalidate_unstarted_remount(repository_id, project_id, authority, continuity, ttl)
        guardian = (lambda: authority.guardian(project_id)) if hasattr(authority, "guardian") else None
        with self.lock():
            project, receipt, record = self.load(repository_id)
            lease = record.get("lease")
            require(record["status"] == "ready" and lease and not record.get("sourceUpdating")
                    and not record.get("acceptedSource"), "renewal_binding_changed")
            expected = {"repositoryId": repository_id, "taskId": lease["taskId"], "leaseId": lease["id"],
                        "leaseGeneration": lease["generation"], "revision": record["revision"],
                        "checkoutIncarnation": record["checkoutIncarnation"], "checkoutIdentity": {key: str(value) for key, value in record["checkoutIdentity"].items()}}
            grant = authority.verify(project_id, expected)
            require(grant["expiresAt"] > time.time() * 1000, "renewal_authority_expired")
            prior = record.get("unstartedRevalidation")
            require(not grant.get("replayOnly") or prior, "renewal_replay_conflict")
            if prior:
                require(prior["transferId"] == grant["transferId"] and prior["recoveryId"] == grant["recoveryId"]
                        and prior["proofDigest"] == grant["proofDigest"] and prior["expected"] == expected
                        and prior["renewalSequence"] == record.get("renewalSequence")
                        and prior["newLease"] == lease, "renewal_replay_conflict")
            sequence = record.get("renewalSequence", 0)
            require(type(sequence) is int and 0 <= sequence < 9007199254740991
                    and (prior or sequence == grant["renewalSequence"]), "renewal_binding_changed")
            self.checkout_valid(project / "checkout", record)
            require(self.git(project / "checkout", "rev-parse", "HEAD") == record["revision"], "renewal_source_changed")
            self.clean(project / "checkout")
            self.no_consumers(project / "checkout", guardian)
            require(authority.verify(project_id, expected) == grant and grant["expiresAt"] > time.time() * 1000,
                    "renewal_authority_expired")
            if prior:
                return self.summary(project, record)  # Current physical proof, no second extension.
            original = dict(lease)
            now = time.time()
            lease["expiresAt"] = now + ttl
            record["renewalSequence"] = sequence + 1
            record["lastRenewedAt"] = now
            record["unstartedRevalidation"] = {"transferId": grant["transferId"], "recoveryId": grant["recoveryId"],
                "proofDigest": grant["proofDigest"], "expected": expected, "previousLease": original,
                "newLease": dict(lease), "renewalSequence": sequence + 1}
            self.write(receipt, record)
            return self.summary(project, record)

    def release_lease(self, repository_id, task_id, lease_id, generation, expected_revision):
        require(revision(expected_revision), "invalid_revision")
        with self.lock():
            project, receipt, record = self.load(repository_id)
            lease = record.get("lease")
            require(not record.get("sourceUpdating"), "source_update_pending")
            previous = record.get("lastLeaseRelease")
            if not lease and previous and (previous.get("taskId"), previous.get("leaseId"), previous.get("leaseGeneration"), previous.get("revision")) == (task_id, lease_id, generation, expected_revision):
                require(previous.get("checkoutIncarnation") == record.get("checkoutIncarnation"), "stale_lease")
                checkout = project / "checkout"
                self.checkout_valid(checkout, record)
                require(self.git(checkout, "rev-parse", "HEAD") == expected_revision, "release_revision_mismatch")
                self.no_consumers(checkout)
                return {**self.summary(project, record), "releaseReceipt": previous}
            require(type(generation) is int and lease and (lease["taskId"], lease["id"], lease["generation"]) == (task_id, lease_id, generation), "stale_lease")
            if record.get("checkoutIdentity"):
                checkout = project / "checkout"
                self.checkout_valid(checkout, record)
                require(self.git(checkout, "rev-parse", "HEAD") == expected_revision, "release_revision_mismatch")
                self.no_consumers(checkout)
            if record.get("acceptedSource") is not None:
                require(expected_revision == record["acceptedSource"]["headSha"], "release_revision_mismatch")
            else:
                record["revision"] = expected_revision
            released = {"schemaVersion": 1, "repositoryId": repository_id, "taskId": task_id,
                        "leaseId": lease_id, "leaseGeneration": generation, "revision": expected_revision,
                        "checkoutIncarnation": record.get("checkoutIncarnation"),
                        "checkoutIdentity": {k: str(v) for k, v in record.get("checkoutIdentity", {}).items()}, "releasedAt": int(time.time() * 1000)}
            require(identifier(released["checkoutIncarnation"]), "checkout_incarnation_missing")
            # The outer guardian must attest this receipt after tree closure. The
            # local signed journal alone does not establish kernel quiescence.
            record["lastLeaseRelease"] = released
            record["lease"] = None
            self.write(receipt, record)
            return {**self.summary(project, record), "releaseReceipt": released}

    def _archive_accepted_source(self, repository_id, task_id, signed_evidence, authority):
        """Inert trusted-outer seam. No CLI caller or model-provided authority.

        Only a verified server decision binding tree exit, retention and the
        exact released lease may archive an accepted source and permit reuse.
        """
        with self.lock():
            project, receipt, record = self.load(repository_id)
            require(authority is not None and not record.get("lease") and not record.get("sourceUpdating"), "archive_authority_unavailable")
            released, source = record.get("lastLeaseRelease"), record.get("acceptedSource")
            previous = record.get("lastSourceArchive")
            if released and not source and isinstance(previous, dict):
                archived = self.read(project / "evidence" / f"source-{previous['digest']}.json")
                expected = archived["binding"]
                evidence = authority.verify(signed_evidence, expected)
                require(task_id == expected["taskId"] and evidence == archived["evidence"] and released == archived["releaseReceipt"] and record.get("checkoutIncarnation") == expected["checkoutIncarnation"], "archive_scope_changed")
                checkout = project / "checkout"
                self.checkout_valid(checkout, record)
                require(self.git(checkout, "rev-parse", "HEAD") == expected["revision"], "release_revision_mismatch")
                self.no_consumers(checkout)
                return {"archiveDigest": previous["digest"], "revision": expected["revision"], "checkoutRetained": True}
            require(released and source and released.get("taskId") == task_id and released.get("checkoutIncarnation") == record.get("checkoutIncarnation") and released.get("revision") == source.get("headSha"), "archive_scope_changed")
            expected = {"repositoryId": repository_id, "taskId": task_id,
                        "leaseId": released["leaseId"], "leaseGeneration": released["leaseGeneration"],
                        "checkoutIncarnation": released["checkoutIncarnation"], "revision": released["revision"],
                        "acceptedSource": source}
            evidence = authority.verify(signed_evidence, expected)
            require(isinstance(evidence, dict) and evidence.get("binding") == expected
                    and all(isinstance(evidence.get(k), str) and re.fullmatch(r"[0-9a-f]{64}", evidence[k])
                            for k in ("treeReceiptDigest", "preservationDigest", "leaseReleaseDigest")), "archive_evidence_invalid")
            require(evidence["leaseReleaseDigest"] == hashlib.sha256(json.dumps(released, sort_keys=True, separators=(",", ":")).encode()).hexdigest(), "archive_evidence_invalid")
            checkout = project / "checkout"
            self.checkout_valid(checkout, record)
            require(self.git(checkout, "rev-parse", "HEAD") == released["revision"], "release_revision_mismatch")
            self.clean(checkout)
            self.no_consumers(checkout)
            archive = {"schemaVersion": 1, "binding": expected, "evidence": evidence,
                       "releaseReceipt": released, "sourceLastApplied": record.get("sourceLastApplied"),
                       "sourceAppliedOperation": record.get("sourceAppliedOperation")}
            digest = hashlib.sha256(json.dumps(archive, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            archive_dir = project / "evidence"
            self.safe(archive_dir)
            archive_dir.mkdir(mode=0o700, exist_ok=True)
            self.private(archive_dir, directory=True)
            self.write(archive_dir / f"source-{digest}.json", archive)
            record["lastSourceArchive"] = {"digest": digest}
            record["revision"] = released["revision"]
            record.pop("acceptedSource", None)
            record.pop("sourceLastApplied", None)
            record.pop("sourceAppliedOperation", None)
            self.write(receipt, record)
            return {"archiveDigest": digest, "revision": record["revision"], "checkoutRetained": True}

    def request_cleanup(self, repository_id, task_id):
        require(identifier(task_id), "invalid_task")
        with self.lock():
            project, receipt, record = self.load(repository_id)
            require(not record.get("sourceUpdating") and not record.get("acceptedSource"), "accepted_source_cleanup_unavailable")
            require(task_id == record["lastTaskId"], "cleanup_task_mismatch")
            require(len(record["cleanupRequests"]) < 100, "cleanup_request_limit")
            record["cleanupRequests"].append({"id": str(uuid.uuid4()), "taskId": task_id, "revision": record["revision"], "checkoutIdentity": record["checkoutIdentity"], "checkoutIncarnation": record.get("checkoutIncarnation"), "leaseGeneration": record["leaseGeneration"], "renewalSequence": record.get("renewalSequence", 0), "requestedAt": time.time()})
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
            require(not record.get("sourceUpdating") and not record.get("acceptedSource"), "accepted_source_cleanup_unavailable")
            require(task_id == record["lastTaskId"] and record["cleanupRequests"] and not record["lease"], "cleanup_not_quiescent")
            cleanup_request = record["cleanupRequests"][-1]
            require(cleanup_request["taskId"] == task_id and cleanup_request["revision"] == record["revision"]
                    and cleanup_request["checkoutIdentity"] == record["checkoutIdentity"]
                    and identifier(record.get("checkoutIncarnation"))
                    and cleanup_request.get("checkoutIncarnation") == record["checkoutIncarnation"]
                    and cleanup_request.get("leaseGeneration") == record["leaseGeneration"]
                    and cleanup_request.get("renewalSequence") == record.get("renewalSequence", 0), "cleanup_request_stale")
            expected = {"repositoryId": repository_id, "taskId": task_id, "revision": record["revision"],
                        "projectIdentity": record["projectIdentity"], "checkoutIdentity": record["checkoutIdentity"], "checkoutIncarnation": record["checkoutIncarnation"], "leaseGeneration": record["leaseGeneration"], "renewalSequence": record.get("renewalSequence", 0), "cleanupRequestId": cleanup_request["id"]}
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
        manager = ManagedProjects.installed(pwd.getpwuid(os.getuid()).pw_dir)
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
