"""Internal source publication plumbing and explicitly separate fixture wrapper.

No CLI/default activation. Private composition is never model JSON. Production
composition requires delivery-source-runtime.py and independent host authority.
0600/HMAC alone do not isolate this signer from same-UID native execution.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("hive_source_provider", Path(__file__).with_name("delivery-source-provider.py"))
_provider = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_provider)
PublicationHold, UnknownOutcome = _provider.PublicationHold, _provider.UnknownOutcome
FixedGitHubFixtureProvider = _provider.FixedGitHubFixtureProvider
require, oid = _provider.require, _provider.oid
MAX_FILE, MAX_BYTES, MAX_FILES, MAX_REQUESTS = 1024 * 1024, 5 * 1024 * 1024, 100, 256
GIT = "/usr/bin/git"
PHASES = {"intent", "sealed", "prepared", "objects", "ref-pending", "ref-created", "pr-pending", "published", "held"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def object_id(kind, raw):
    return hashlib.sha1(kind.encode() + b" " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_directory(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, "private_path_invalid")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "private_directory_unsafe")
    return path


def read_private(path, maximum):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                    and info.st_mode & 0o077 == 0 and info.st_size <= maximum, "private_file_unsafe")
            raw = bytearray()
            while len(raw) <= maximum:
                part = os.read(fd, min(65536, maximum + 1 - len(raw)))
                if not part:
                    break
                raw.extend(part)
            require(len(raw) <= maximum, "private_file_limit")
            return bytes(raw)
        finally:
            os.close(fd)
    except OSError:
        raise PublicationHold("private_file_unavailable") from None


def atomic(path, raw):
    require(len(raw) <= 2 * MAX_BYTES, "journal_limit")
    temp = path.parent / (str(uuid.uuid4()) + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)
    fsync_directory(path.parent)


class _SourceBrokerCore:
    def __init__(self, root, workspace, scope, *, allowed_prefixes=("src", "tests", "docs"), clock=time.time,
                 author_name="Hive fixture", author_email="fixture@example.invalid",
                 max_files=MAX_FILES, max_file_bytes=MAX_FILE, max_bytes=MAX_BYTES,
                 isolate_git_process_group=True):
        self.author_name, self.author_email = author_name, author_email
        self.max_files, self.max_file_bytes, self.max_bytes = max_files, max_file_bytes, max_bytes
        self.isolate_git_process_group = isolate_git_process_group
        fields = {"ownerId", "taskId", "managerBindingId", "attemptId", "repositoryId", "providerAccountId", "fullName",
                  "baseBranch", "parentSha", "sourceVersion", "serverInstanceId", "leaseId", "leaseGeneration", "checkoutIncarnation"}
        require(isinstance(scope, dict) and set(scope) == fields, "scope_invalid")
        for key in ("ownerId", "taskId", "managerBindingId", "attemptId", "leaseId", "checkoutIncarnation"):
            require(str(uuid.UUID(scope[key])) == scope[key], "scope_invalid")
        require(oid(scope["parentSha"]) and type(scope["sourceVersion"]) is int and scope["sourceVersion"] >= 0
                and type(scope["leaseGeneration"]) is int and scope["leaseGeneration"] > 0
                and re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", scope["serverInstanceId"])
                and all(re.fullmatch(r"[1-9][0-9]{0,19}", scope[k]) for k in ("repositoryId", "providerAccountId"))
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,150}", scope["baseBranch"])
                and not any(v in scope["baseBranch"] for v in ("..", "//", "@{")), "scope_invalid")
        self.root = private_directory(root)
        self.workspace = Path(workspace)
        require(self.workspace.is_absolute() and self.workspace.resolve() == self.workspace
                and self.workspace.is_dir() and not self.root.is_relative_to(self.workspace), "workspace_invalid")
        self.scope, self.clock = dict(scope), clock
        require(isinstance(allowed_prefixes, tuple) and allowed_prefixes and all(re.fullmatch(r"[a-zA-Z0-9_-]+", p) for p in allowed_prefixes), "path_policy_invalid")
        self.allowed_prefixes = allowed_prefixes
        info = self.workspace.lstat()
        self.workspace_identity = {"device": info.st_dev, "inode": info.st_ino}
        self.policy_digest = sha(canonical({"schemaVersion": 1, "prefixes": allowed_prefixes, "maxFiles": self.max_files,
                                            "maxFile": self.max_file_bytes, "maxBytes": self.max_bytes, "workspaceIdentity": self.workspace_identity,
                                            "authorName": self.author_name, "authorEmail": self.author_email}))
        self.journals, self.objects = private_directory(self.root / "operations"), private_directory(self.root / "sealed")
        private_directory(self.root / "home")
        key = self.root / "key"
        if not key.exists():
            require(not any(self.journals.iterdir()) and not (self.root / "repo.git").exists(), "journal_key_missing")
            fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.write(fd, os.urandom(32)); os.fsync(fd)
            finally:
                os.close(fd)
            fsync_directory(self.root)
        self.key = read_private(key, 32)
        require(len(self.key) == 32, "journal_key_invalid")
        self.git_dir = self.root / "repo.git"
        with self.lock():
            if not self.git_dir.exists():
                require(not (self.root / "store.json").exists(), "git_store_missing")
                self._execute(["init", "--bare", "--template=", str(self.git_dir)])
                os.chmod(self.git_dir, 0o700)
                os.chmod(self.git_dir / "config", 0o600)
                self.write_signed(self.root / "store.json", {"configDigest": sha((self.git_dir / "config").read_bytes())})
            self.validate_store()

    @contextmanager
    def lock(self):
        fd = os.open(self.root / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "lock_unsafe")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise PublicationHold("broker_busy") from None
            yield
        finally:
            os.close(fd)

    def write_signed(self, path, value):
        raw = canonical(value)
        atomic(path, canonical({"value": value, "mac": hmac.new(self.key, raw, hashlib.sha256).hexdigest()}))

    def read_signed(self, path):
        try:
            signed = json.loads(read_private(path, 2 * MAX_BYTES))
            require(set(signed) == {"value", "mac"} and isinstance(signed["mac"], str)
                    and hmac.compare_digest(signed["mac"], hmac.new(self.key, canonical(signed["value"]), hashlib.sha256).hexdigest()), "journal_tampered")
            return signed["value"]
        except (ValueError, KeyError, TypeError):
            raise PublicationHold("journal_invalid") from None

    def validate_store(self):
        require(self.git_dir.resolve() == self.git_dir and self.git_dir.is_dir(), "git_store_unsafe")
        require(sha(read_private(self.git_dir / "config", MAX_FILE)) == self.read_signed(self.root / "store.json").get("configDigest"), "git_configuration_changed")
        for name in ("objects/info/alternates", "info/grafts", "commondir", "shallow", "config.worktree", "refs/replace"):
            require(not os.path.lexists(self.git_dir / name), "git_storage_changed")
        hooks = self.git_dir / "hooks"
        require(not os.path.lexists(hooks) or (hooks.resolve() == hooks and hooks.is_dir() and not any(hooks.iterdir())), "git_hooks_changed")
        for name in ("objects", "refs", "objects/info", "info"):
            path = self.git_dir / name
            require(not path.exists() or (path.is_dir() and path.resolve() == path), "git_storage_changed")

    def _execute(self, args, raw=None, identity=None, object_directory=None):
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.root / "home"), "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull, "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1",
               "GIT_ATTR_NOSYSTEM": "1", "GIT_TRACE": "0", "GIT_TRACE_CURL": "0"}
        if object_directory is not None:
            env["GIT_OBJECT_DIRECTORY"] = str(object_directory)
            env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = ""
        if identity:
            for role in ("AUTHOR", "COMMITTER"):
                env.update({f"GIT_{role}_NAME": self.author_name, f"GIT_{role}_EMAIL": self.author_email, f"GIT_{role}_DATE": identity})
        command = [GIT, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "init.templateDir=", "-c", "protocol.allow=never",
                   "-c", "credential.helper=", "-c", "core.attributesFile=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
                   "-c", "commit.gpgSign=false", *args]
        require(raw is None or len(raw) <= 2 * MAX_BYTES, "git_input_limit")
        try:
            process = subprocess.Popen(command, cwd=self.root / "home", env=env,
                                       stdin=subprocess.PIPE if raw is not None else subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       start_new_session=self.isolate_git_process_group)
        except OSError:
            raise PublicationHold("git_unavailable") from None
        output, offset, deadline = bytearray(), 0, time.monotonic() + 10
        try:
            with selectors.DefaultSelector() as poll:
                os.set_blocking(process.stdout.fileno(), False)
                poll.register(process.stdout, selectors.EVENT_READ)
                if raw is not None:
                    os.set_blocking(process.stdin.fileno(), False)
                    if raw: poll.register(process.stdin, selectors.EVENT_WRITE)
                    else: process.stdin.close()
                while poll.get_map():
                    remaining = deadline - time.monotonic()
                    require(remaining > 0, "git_timeout")
                    events = poll.select(remaining)
                    require(events, "git_timeout")
                    for event, _mask in events:
                        if event.fileobj is process.stdin:
                            offset += os.write(process.stdin.fileno(), raw[offset:offset + 65536])
                            if offset == len(raw): poll.unregister(process.stdin); process.stdin.close()
                        else:
                            part = os.read(process.stdout.fileno(), 65536)
                            if not part: poll.unregister(process.stdout)
                            else:
                                output.extend(part)
                                require(len(output) <= 2 * MAX_BYTES, "git_output_limit")
            require(process.wait(timeout=max(0.001, deadline - time.monotonic())) == 0, "git_failed")
        except (OSError, subprocess.TimeoutExpired):
            raise PublicationHold("git_unavailable") from None
        finally:
            if process.poll() is None:
                if self.isolate_git_process_group:
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait()
            if process.stdin and not process.stdin.closed: process.stdin.close()
            process.stdout.close()
        return bytes(output)

    def _git(self, args, raw=None, identity=None):
        self.validate_store()
        return self._execute(["--git-dir=" + str(self.git_dir), *args], raw, identity)

    def checked_path(self, value):
        require(isinstance(value, str) and len(value) <= 240 and re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", value), "source_path_invalid")
        parts = value.split("/")
        require(len(parts) <= 16 and parts[0] in self.allowed_prefixes and not any(p in {".", ".."} or p.lower() in {".git", ".github", ".gitmodules", ".gitattributes"}
                or p.lower().startswith(".env") or p.lower().endswith((".pem", ".key")) for p in parts), "source_path_protected")
        return parts

    def seal_file(self, path, remaining):
        parts = self.checked_path(path)
        fd = os.open(self.workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            root_info = os.fstat(fd)
            require({"device": root_info.st_dev, "inode": root_info.st_ino} == self.workspace_identity, "workspace_identity_changed")
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = child
            file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                before = os.fstat(file_fd)
                require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= self.max_file_bytes, "source_file_type_or_size")
                require(before.st_size <= remaining, "snapshot_total_limit")
                raw = bytearray()
                maximum = min(self.max_file_bytes, remaining)
                while len(raw) <= maximum:
                    part = os.read(file_fd, min(65536, maximum + 1 - len(raw)))
                    if not part:
                        break
                    raw.extend(part)
                after, current = os.fstat(file_fd), os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                fingerprint = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
                require(len(raw) <= maximum and fingerprint(before) == fingerprint(after)
                        and current.st_ino == after.st_ino and current.st_dev == after.st_dev, "source_changed_during_snapshot")
                current_root = self.workspace.lstat()
                require(current_root.st_dev == root_info.st_dev and current_root.st_ino == root_info.st_ino, "workspace_identity_changed")
            finally:
                os.close(file_fd)
        except OSError:
            raise PublicationHold("source_path_unavailable") from None
        finally:
            os.close(fd)
        raw = bytes(raw); key = sha(raw); destination = self.objects / key
        if os.path.lexists(destination):
            require(read_private(destination, MAX_FILE) == raw, "sealed_object_changed")
        else:
            atomic(destination, raw)
        return {"path": path, "contentDigest": key, "size": len(raw), "mode": "100755" if before.st_mode & 0o111 else "100644",
                "blobSha": object_id("blob", raw)}

    def tree(self, files, known_trees=frozenset()):
        root, trees = {}, []
        for path, value in files.items():
            node = root
            for part in path.split("/")[:-1]:
                node = node.setdefault(part, {})
                require(isinstance(node, dict), "tree_path_conflict")
            name = path.split("/")[-1]
            require(name not in node, "tree_path_conflict")
            node[name] = value
        def build(node):
            entries = []
            for name, value in sorted(node.items()):
                if isinstance(value, dict):
                    child = build(value); mode, kind, object_sha = "040000", "tree", child
                else:
                    mode, object_sha = value; kind = "blob"
                entries.append({"path": name, "mode": mode, "type": kind, "sha": object_sha})
            raw = b"".join(f"{v['mode']} {v['type']} {v['sha']}\t{v['path']}\0".encode() for v in entries)
            tree_sha = self._git(["mktree", "--missing", "-z"], raw).decode().strip()
            if tree_sha not in known_trees:
                trees.append({"sha": tree_sha, "entries": entries})
            require(len(trees) <= 64, "tree_limit")
            return tree_sha
        return build(root), trees

    def operation_path(self, operation_id):
        require(str(uuid.UUID(operation_id)) == operation_id, "operation_invalid")
        return self.journals / (operation_id + ".json")

    def guard_journals(self):
        names = list(self.journals.iterdir())
        require(len(names) <= 32 and all(re.fullmatch(r"[a-f0-9-]{36}\.json", p.name) for p in names), "journal_capacity_or_unknown_file")
        for path in names: self.read_signed(path)

    def load(self, operation_id):
        entry = self.read_signed(self.operation_path(operation_id))
        require(isinstance(entry, dict) and entry.get("schemaVersion") == 1 and entry.get("phase") in PHASES
                and entry.get("policyDigest") == self.policy_digest
                and entry.get("scope") == self.scope and entry.get("request", {}).get("operationId") == operation_id
                and entry.get("requestDigest") == sha(canonical({"scope": self.scope, "policyDigest": self.policy_digest, "request": entry["request"]}))
                and type(entry.get("requestsUsed")) is int and 0 <= entry["requestsUsed"] <= MAX_REQUESTS, "journal_scope_or_shape_invalid")
        if entry["phase"] != "intent":
            files = entry.get("manifest")
            require(isinstance(files, list) and len(files) <= self.max_files and all(isinstance(v, dict) for v in files), "journal_manifest_invalid")
            for item in files:
                require(set(item) == {"path", "contentDigest", "size", "mode", "blobSha"}
                        and isinstance(item["contentDigest"], str) and re.fullmatch(r"[a-f0-9]{64}", item["contentDigest"])
                        and type(item["size"]) is int and 0 <= item["size"] <= self.max_file_bytes and item["mode"] in {"100644", "100755"}
                        and oid(item["blobSha"]), "journal_manifest_invalid")
                self.checked_path(item["path"])
            require([v["path"] for v in files] == sorted(entry["request"]["paths"])
                    and sum(v["size"] for v in files) <= self.max_bytes
                    and entry.get("manifestDigest") == sha(canonical({"files": files, "deletions": sorted(entry["request"]["deletions"])})), "journal_manifest_invalid")
        if entry["phase"] not in {"intent", "sealed"}:
            commit, trees = entry.get("commit"), entry.get("trees")
            require(isinstance(commit, dict) and oid(commit.get("sha")) and oid(commit.get("tree"))
                    and commit.get("parents") == [self.scope["parentSha"]]
                    and commit.get("message") == entry["request"]["message"].rstrip("\n") + "\n"
                    and entry.get("branch") == f"codex/delivery/{self.scope['taskId']}/{operation_id}"
                    and isinstance(trees, list) and 0 <= len(trees) <= 64, "journal_commit_invalid")
            actor = {"name": self.author_name, "email": self.author_email, "date": entry.get("createdAt")}
            require(commit.get("author") == actor and commit.get("committer") == actor, "journal_commit_invalid")
            for tree in trees:
                require(isinstance(tree, dict) and set(tree) == {"sha", "entries"} and oid(tree["sha"])
                        and isinstance(tree["entries"], list) and len(tree["entries"]) <= 10100, "journal_tree_invalid")
                for value in tree["entries"]:
                    require(isinstance(value, dict) and set(value) == {"path", "mode", "type", "sha"}
                            and isinstance(value["path"], str) and re.fullmatch(r"[A-Za-z0-9_.-]+", value["path"])
                            and value["path"] not in {".", ".."} and value["path"].lower() != ".git"
                            and (value["mode"], value["type"]) in {("040000", "tree"), ("100644", "blob"), ("100755", "blob")}
                            and oid(value["sha"]), "journal_tree_invalid")
        return entry

    def save(self, entry):
        self.write_signed(self.operation_path(entry["request"]["operationId"]), entry)

    @staticmethod
    def receipt(entry):
        return {"operationId": entry["request"]["operationId"], "phase": entry["phase"], "manifestDigest": entry.get("manifestDigest"),
                "commitSha": entry.get("commit", {}).get("sha"), "treeSha": entry.get("commit", {}).get("tree"),
                "parentSha": entry["scope"]["parentSha"], "branch": entry.get("branch"), "pullRequest": entry.get("pullRequest"),
                "heldReason": entry.get("heldReason"), "fixtureOnly": True, "freshAcceptanceAuthority": False}

    def prepare(self, request):
        require(isinstance(request, dict) and set(request) == {"operationId", "paths", "deletions", "message", "title", "body"}, "request_invalid")
        request = json.loads(canonical(request))
        path = self.operation_path(request["operationId"])
        for key in ("paths", "deletions"):
            require(isinstance(request[key], list) and len(request[key]) <= self.max_files and len(set(request[key])) == len(request[key]), "request_paths_invalid")
            for value in request[key]: self.checked_path(value)
        require(0 < len(request["paths"]) + len(request["deletions"]) <= self.max_files
                and not set(request["paths"]) & set(request["deletions"]), "request_paths_invalid")
        for key, limit in (("message", 4000), ("title", 160), ("body", 8000)):
            require(isinstance(request[key], str) and 0 < len(request[key].encode()) <= limit and "\0" not in request[key], "request_text_invalid")
        require(re.match(r"^(feat|fix|docs|test|refactor|chore|perf|build|ci)(\([a-z0-9_-]+\))?!?: [^\r\n]+", request["message"])
                and re.fullmatch(r"(feat|fix|docs|test|refactor|chore|perf|build|ci)(\([a-z0-9_-]+\))?!?: [^\r\n]+", request["title"]), "conventional_title_required")
        request_digest = sha(canonical({"scope": self.scope, "policyDigest": self.policy_digest, "request": request}))
        with self.lock():
            self.guard_journals()
            if os.path.lexists(path):
                entry = self.load(request["operationId"])
                require(entry["requestDigest"] == request_digest, "operation_replay_conflict")
                if entry["phase"] not in {"intent", "sealed"}: return self.receipt(entry)
            else:
                names = list(self.journals.iterdir())
                require(len(names) < 32 and all(re.fullmatch(r"[a-f0-9-]{36}\.json", p.name) for p in names), "journal_capacity_or_unknown_file")
                entry = {"schemaVersion": 1, "scope": self.scope, "policyDigest": self.policy_digest, "request": request, "requestDigest": request_digest,
                         "createdAt": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(), "phase": "intent", "requestsUsed": 0}
                self.save(entry)
            if entry["phase"] == "intent":
                manifest = []
                for p in sorted(request["paths"]):
                    manifest.append(self.seal_file(p, self.max_bytes - sum(v["size"] for v in manifest)))
                require(sum(v["size"] for v in manifest) <= self.max_bytes, "snapshot_total_limit")
                entry.update(manifest=manifest, manifestDigest=sha(canonical({"files": manifest, "deletions": sorted(request["deletions"])})), phase="sealed")
                self.save(entry)
            raw = self._git(["ls-tree", "-r", "-z", "--full-tree", self.scope["parentSha"]])
            files = {}
            for row in raw.split(b"\0"):
                if not row: continue
                metadata, name = row.split(b"\t", 1); mode, kind, object_sha = metadata.decode().split(" ")
                name = name.decode("utf-8", errors="strict")
                require(mode in ("100644", "100755") and kind == "blob" and oid(object_sha), "parent_storage_unsupported")
                require(re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", name) and len(files) < 10000, "parent_tree_invalid")
                files[name] = (mode, object_sha)
            for deleted in request["deletions"]:
                require(deleted in files, "deleted_path_missing")
                del files[deleted]
            for item in entry["manifest"]:
                blob = read_private(self.objects / item["contentDigest"], MAX_FILE)
                require(sha(blob) == item["contentDigest"] and len(blob) == item["size"], "sealed_object_changed")
                require(self._git(["hash-object", "--no-filters", "-w", "--stdin"], blob).decode().strip() == item["blobSha"], "blob_identity_changed")
                files[item["path"]] = (item["mode"], item["blobSha"])
            # Preserve verified parent subtree identities. Only changed trees
            # need provider writes, regardless of the unchanged repository size.
            known_trees = {self._git(["rev-parse", self.scope["parentSha"] + "^{tree}"]).decode().strip()}
            for row in self._git(["ls-tree", "-d", "-r", "-z", self.scope["parentSha"]]).split(b"\0"):
                if row:
                    metadata = row.split(b"\t", 1)[0].decode().split(" ")
                    require(len(metadata) == 3 and metadata[:2] == ["040000", "tree"] and oid(metadata[2]), "parent_tree_invalid")
                    known_trees.add(metadata[2])
            tree, trees = self.tree(files, known_trees)
            message = request["message"].rstrip("\n") + "\n"
            commit_sha = self._git(["commit-tree", tree, "-p", self.scope["parentSha"]], message.encode(), entry["createdAt"]).decode().strip()
            actor = {"name": self.author_name, "email": self.author_email, "date": entry["createdAt"]}
            entry.update(phase="prepared", trees=trees, commit={"sha": commit_sha, "tree": tree, "parents": [self.scope["parentSha"]],
                         "message": message, "author": actor, "committer": actor}, branch=f"codex/delivery/{self.scope['taskId']}/{request['operationId']}")
            self.save(entry)
            return self.receipt(entry)

    def publish(self, operation_id, provider):
        require(isinstance(provider, _provider._FixedGitHubProvider) and provider.scope == self.scope, "provider_scope_invalid")
        with self.lock():
            self.guard_journals()
            entry = self.load(operation_id)
            if entry["phase"] in {"held", "published"}: return self.receipt(entry)
            require(entry["phase"] == "prepared", "publication_phase_ambiguous")
            def charge():
                require(entry["requestsUsed"] < MAX_REQUESTS, "provider_request_budget")
                entry["requestsUsed"] += 1; self.save(entry)
            def phase(value):
                entry["phase"] = value; self.save(entry)
            try:
                provider.verify_identity(charge)
                for item in entry["manifest"]:
                    raw = read_private(self.objects / item["contentDigest"], MAX_FILE)
                    require(sha(raw) == item["contentDigest"] and object_id("blob", raw) == item["blobSha"], "sealed_object_changed")
                    provider.verify_identity(charge)
                    provider.blob(raw, item["blobSha"], charge)
                for tree in entry["trees"]:
                    provider.verify_identity(charge)
                    provider.tree(tree["entries"], tree["sha"], charge)
                commit = entry["commit"]
                provider.verify_identity(charge)
                provider.commit({k: v for k, v in commit.items() if k != "sha"}, commit["sha"], charge)
                phase("objects"); provider.verify_identity(charge)
                phase("ref-pending"); provider.create_ref(entry["branch"], commit["sha"], charge)
                phase("ref-created"); provider.verify_identity(charge)
                phase("pr-pending")
                pr = provider.create_pr(entry["branch"], commit["sha"], entry["request"]["title"], entry["request"]["body"], charge)
                provider.verify_identity(charge)
                provider.read_ref(entry["branch"], commit["sha"], charge)
                entry.update(phase="published", pullRequest=pr); self.save(entry)
            except (PublicationHold, UnknownOutcome) as error:
                entry.update(phase="held", heldReason=str(error) if isinstance(error, PublicationHold) else "provider_outcome_unknown")
                self.save(entry)
            return self.receipt(entry)


class SourceBrokerFixture(_SourceBrokerCore):
    def __init__(self, root, workspace, scope, *, fixture_only=False, allowed_prefixes=("src", "tests", "docs"), clock=time.time):
        require(fixture_only is True, "publication_unactivated")
        super().__init__(root, workspace, scope, allowed_prefixes=allowed_prefixes, clock=clock)

    def publish(self, operation_id, provider):
        require(isinstance(provider, FixedGitHubFixtureProvider), "provider_scope_invalid")
        return super().publish(operation_id, provider)

    def seed_fixture_parent(self, files):
        """Test composition only: production parent import is deliberately absent."""
        with self.lock():
            require(isinstance(files, dict) and len(files) <= self.max_files and sum(len(raw) for raw in files.values()) <= MAX_BYTES, "fixture_parent_limit")
            entries = {}
            for path, raw in files.items():
                self.checked_path(path)
                require(isinstance(raw, bytes) and len(raw) <= MAX_FILE, "fixture_parent_invalid")
                entries[path] = ("100644", self._git(["hash-object", "--no-filters", "-w", "--stdin"], raw).decode().strip())
            tree, _ = self.tree(entries)
            return self._git(["commit-tree", tree], b"test: fixture parent\n", "2026-10-29T00:00:00+00:00").decode().strip()
