"""Inert protected accepted-source application; no CLI, network or default authority.

The installed composition must supply independent producer authorization, fresh
accepted-source facts and a durable target-project input barrier. A publication
receipt or this private recovery journal is not execution authority.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import struct
import subprocess
import time

MAX_INDEX = 16 * 1024 * 1024
MAX_OBJECT = 1024 * 1024
MAX_OBJECT_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 10000


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def snapshot(value):
    return json.loads(json.dumps(value, sort_keys=True, allow_nan=False))


def context(value, require):
    require(isinstance(value, dict) and set(value) == {"revisionId", "version", "headSha"}
            and isinstance(value["revisionId"], str) and re.fullmatch(r"[a-f0-9-]{36}", value["revisionId"])
            and type(value["version"]) is int and value["version"] > 0
            and isinstance(value["headSha"], str) and re.fullmatch(r"[a-f0-9]{40}", value["headSha"]), "source_context_invalid")
    return value


def index_entries(raw, require):
    """Only ordinary SHA-1 index v2, including staged adds/deletes/mode changes.

    Refuse unresolved stages, intent-to-add, skip-worktree, assume-unchanged,
    split/sparse indexes and non-cache extensions rather than silently lose them.
    """
    require(32 <= len(raw) <= MAX_INDEX and raw[:4] == b"DIRC"
            and hashlib.sha1(raw[:-20]).digest() == raw[-20:], "source_index_invalid")
    version, count = struct.unpack(">II", raw[4:12])
    require(version == 2 and count <= MAX_ENTRIES, "source_index_unsupported")
    entries, offset = {}, 12
    for _ in range(count):
        start = offset
        require(offset + 62 < len(raw) - 20, "source_index_invalid")
        mode = struct.unpack(">I", raw[offset + 24:offset + 28])[0]
        flags = struct.unpack(">H", raw[offset + 60:offset + 62])[0]
        require(flags & 0xF000 == 0, "source_index_unsupported")
        object_id = raw[offset + 40:offset + 60].hex()
        end = raw.find(b"\0", offset + 62, len(raw) - 20)
        require(end >= offset + 62, "source_index_invalid")
        name = raw[offset + 62:end]
        require(len(name) <= 4095 and name not in entries and not name.startswith(b"/")
                and all(part not in (b"", b".", b"..", b".git") for part in name.split(b"/")), "source_index_unsupported")
        require(mode in (0o100644, 0o100755, 0o120000, 0o160000), "source_index_unsupported")
        entries[name] = (mode, object_id)
        offset = start + ((end + 1 - start + 7) // 8) * 8
        require(raw[end:offset] == b"\0" * (offset - end), "source_index_invalid")
    while offset < len(raw) - 20:
        require(offset + 8 <= len(raw) - 20, "source_index_invalid")
        kind, size = raw[offset:offset + 4], struct.unpack(">I", raw[offset + 4:offset + 8])[0]
        require(kind == b"TREE" and offset + 8 + size <= len(raw) - 20, "source_index_unsupported")
        offset += 8 + size
    require(offset == len(raw) - 20, "source_index_invalid")
    return entries


class Application:
    def __init__(self, manager, repository_id, project_id, operation_id, authority, barrier, objects, checkpoint):
        self.m = manager
        self.require = manager.require_source
        self.require(all(value is not None for value in (authority, barrier, objects)), "source_authority_required")
        self.require(isinstance(operation_id, str) and re.fullmatch(r"[a-f0-9-]{36}", operation_id)
                     and isinstance(project_id, str) and re.fullmatch(r"[a-f0-9-]{36}", project_id), "source_identity_invalid")
        self.repository_id, self.project_id, self.operation_id = repository_id, project_id, operation_id
        self.authority, self.barrier, self.objects = authority, barrier, objects
        self.checkpoint = checkpoint or (lambda _phase: None)
        self.deadline = time.monotonic() + 60
        self.work = manager.state / "source-applications" / operation_id
        self.checkout_fd = self.git_fd = self.work_fd = None

    def parent_fd(self, path):
        if hasattr(self, "metadata") and path.parent == self.metadata:
            return self.git_fd
        if path.parent == self.work:
            return self.work_fd
        return None

    def close(self):
        for fd in (self.checkout_fd, self.git_fd, self.work_fd):
            if fd is not None:
                os.close(fd)

    def exists(self, path):
        parent = self.parent_fd(path)
        try:
            os.stat(path.name if parent is not None else path, dir_fd=parent, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    def pin(self, path, directory=False):
        self.m.safe(path)
        parent = self.parent_fd(path)
        info = os.stat(path.name, dir_fd=parent, follow_symlinks=False) if parent is not None else path.lstat()
        self.require(info.st_uid == os.getuid() and not info.st_mode & 0o022
                     and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)), "source_path_changed")
        return {"device": str(info.st_dev), "inode": str(info.st_ino)}

    def read(self, path, limit=MAX_INDEX):
        parent = self.parent_fd(path)
        fd = os.open(path.name if parent is not None else path, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            info = os.fstat(fd)
            self.require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "source_file_limit")
            raw = bytearray()
            while len(raw) <= limit:
                part = os.read(fd, min(65536, limit + 1 - len(raw)))
                if not part:
                    break
                raw.extend(part)
            self.require(len(raw) <= limit, "source_file_limit")
            return bytes(raw)
        finally:
            os.close(fd)

    def fsync_directory(self, path):
        if hasattr(self, "metadata") and path == self.metadata:
            os.fsync(self.git_fd)
            return
        if path == self.work and self.work_fd is not None:
            os.fsync(self.work_fd)
            return
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def write_new(self, path, raw):
        parent = self.parent_fd(path)
        fd = os.open(path.name if parent is not None else path,
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb", closefd=False) as out:
                out.write(raw)
                out.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        self.fsync_directory(path.parent)

    def git(self, arguments, payload=None, index=None, allow_failure=False):
        self.verify_pins()
        remaining = self.deadline - time.monotonic()
        self.require(remaining > 0, "source_apply_timeout")
        environment = {"PATH": "/usr/bin:/bin", "HOME": str(self.work), "LANG": "C.UTF-8",
                       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                       "GIT_NO_REPLACE_OBJECTS": "1", "GIT_TERMINAL_PROMPT": "0",
                       "GIT_NO_LAZY_FETCH": "1",
                       "GIT_OPTIONAL_LOCKS": "0", "GIT_TRACE": "0", "GIT_TRACE_CURL": "0"}
        if index is not None:
            environment["GIT_INDEX_FILE"] = str(index)
        command = ["/usr/bin/git", "--git-dir=/proc/self/fd/" + str(self.git_fd),
                   "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                   "-c", "core.sparseCheckout=false", "-c", "core.splitIndex=false",
                   "-c", "core.untrackedCache=false", "-c", "index.version=2",
                   "-c", "protocol.allow=never", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", *arguments]
        process = subprocess.Popen(command, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=self.work,
                                   env=environment, pass_fds=(self.git_fd,))
        output, written = bytearray(), 0
        deadline = time.monotonic() + min(remaining, 15)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                if payload is not None:
                    os.set_blocking(process.stdin.fileno(), False)
                    selector.register(process.stdin, selectors.EVENT_WRITE)
                while selector.get_map():
                    wait = deadline - time.monotonic()
                    self.require(wait > 0, "source_git_timeout")
                    events = selector.select(wait)
                    self.require(bool(events), "source_git_timeout")
                    for key, _mask in events:
                        if key.fileobj is process.stdin:
                            if written < len(payload):
                                written += os.write(process.stdin.fileno(), payload[written:written + 65536])
                            if written == len(payload):
                                selector.unregister(process.stdin)
                                process.stdin.close()
                        else:
                            chunk = os.read(process.stdout.fileno(), min(65536, MAX_INDEX + 1 - len(output)))
                            if not chunk:
                                selector.unregister(process.stdout)
                            output.extend(chunk)
                            self.require(len(output) <= MAX_INDEX, "source_git_output_limit")
            result = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            self.require(False, "source_git_timeout")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            if process.stdin is not None:
                process.stdin.close()
            process.stdout.close()
        self.require(allow_failure or result == 0, "source_git_rejected")
        return result, bytes(output)

    def verify_pins(self):
        self.require(self.pin(self.checkout, True) == self.expected["checkoutIdentity"]
                     and self.pin(self.metadata, True) == self.metadata_pin, "source_metadata_changed")
        for fd, expected in ((self.checkout_fd, self.expected["checkoutIdentity"]), (self.git_fd, self.metadata_pin)):
            info = os.fstat(fd)
            self.require({"device": str(info.st_dev), "inode": str(info.st_ino)} == expected, "source_metadata_changed")
        self.pin(self.metadata / "objects", True)
        self.require(not any(os.path.lexists(self.metadata / path) for path in
                             ("objects/info/alternates", "objects/info/http-alternates", "commondir", "info/grafts")),
                     "source_storage_unsupported")

    def verify(self):
        self.require(time.monotonic() < self.deadline, "source_apply_timeout")
        self.input_hold.verify(snapshot(self.expected), self.operation_id, None)
        # This injected capability validates independent producer authority AND
        # freshly signed accepted-source facts. There is no installed factory yet.
        observed = self.authority.verify(snapshot(self.expected), self.operation_id)
        self.require(len(json.dumps(observed, allow_nan=False)) <= 32768, "source_authority_limit")
        observed = snapshot(observed)
        self.require(isinstance(observed, dict) and set(observed) == {
            "operationId", "sourceContext", "previousSourceContext", "parentSha", "treeSha", "manifestDigest",
            "metadataIdentity", "producer", "expiresAt"}, "source_authority_shape")
        target = context(observed["sourceContext"], self.require)
        prior = observed["previousSourceContext"]
        if prior is not None:
            context(prior, self.require)
        self.require(observed["operationId"] == self.operation_id and prior == self.expected["currentSource"]
                     and observed["parentSha"] == (prior["headSha"] if prior else self.expected["revision"])
                     and target["version"] == (prior["version"] + 1 if prior else 1)
                     and target["headSha"] != observed["parentSha"]
                     and isinstance(observed["expiresAt"], (int, float)) and time.time() < observed["expiresAt"] <= time.time() + 30,
                     "source_authority_stale")
        self.require(re.fullmatch(r"[a-f0-9]{40}", observed["treeSha"] or "")
                     and re.fullmatch(r"[a-f0-9]{64}", observed["manifestDigest"] or ""), "source_authority_shape")
        pins = observed["metadataIdentity"]
        self.require(isinstance(pins, dict) and set(pins) == {"checkout", "git"}
                     and pins["checkout"] == self.expected["checkoutIdentity"]
                     and all(isinstance(pin, dict) and set(pin) == {"device", "inode"}
                             and all(isinstance(v, str) and re.fullmatch(r"[0-9]{1,20}", v) for v in pin.values())
                             for pin in pins.values()), "source_metadata_changed")
        producer = observed["producer"]
        self.require(isinstance(producer, dict) and set(producer) == {
            "runtimeId", "runtimeGeneration", "admissionId", "admissionGeneration",
            "producerDigest", "checkoutIncarnation", "barrierGeneration",
            "metadataPinsDigest", "metadataPolicyDigest", "namespaceReceiptDigest"}
            and all(isinstance(producer[k], str) and re.fullmatch(r"[a-f0-9-]{36}", producer[k]) for k in ("runtimeId", "admissionId"))
            and all(type(producer[k]) is int and producer[k] > 0 for k in ("runtimeGeneration", "admissionGeneration"))
            and producer["checkoutIncarnation"] == self.expected["checkoutIncarnation"]
            and type(producer["barrierGeneration"]) is int and producer["barrierGeneration"] >= 0
            and all(isinstance(producer[k], str) and re.fullmatch(r"[a-f0-9]{64}", producer[k])
                    for k in ("producerDigest", "metadataPinsDigest", "metadataPolicyDigest", "namespaceReceiptDigest")), "source_authority_shape")
        self.input_hold.verify(snapshot(self.expected), self.operation_id, snapshot(producer))
        immutable = {key: value for key, value in observed.items() if key != "expiresAt"}
        if hasattr(self, "approval"):
            self.require(immutable == self.approval, "source_authority_changed")
        else:
            self.approval = immutable
        self.metadata_pin = pins["git"]
        self.verify_pins()
        self.require(self.record["lease"]["expiresAt"] > time.time(), "source_lease_inactive")
        return observed

    def save(self, phase):
        self.journal["phase"] = phase
        self.record["sourceUpdating"] = self.journal
        self.m.write(self.receipt, self.record)
        self.checkpoint(phase)

    def import_objects(self):
        total, visited = 0, set()
        def read(kind, oid):
            nonlocal total
            self.require(re.fullmatch(r"[a-f0-9]{40}", oid or ""), "source_object_invalid")
            status, _ = self.git(["cat-file", "-e", oid], allow_failure=True)
            if status == 0:
                _, size = self.git(["cat-file", "-s", oid])
                self.require(int(size) <= MAX_OBJECT if kind != "blob" else True, "source_object_limit")
                if kind == "blob":
                    self.require(self.git(["cat-file", "-t", oid])[1].strip() == b"blob", "source_object_invalid")
                    return None
                raw = self.git(["cat-file", kind, oid])[1]
            else:
                raw = self.objects.read_object(kind, oid)
                self.require(isinstance(raw, bytes) and len(raw) <= MAX_OBJECT, "source_object_limit")
            total += len(raw)
            self.require(total <= MAX_OBJECT_BYTES
                         and hashlib.sha1(f"{kind} {len(raw)}\0".encode() + raw).hexdigest() == oid, "source_object_invalid")
            self.require(self.git(["hash-object", "--no-filters", "-w", "-t", kind, "--stdin"], raw)[1].strip().decode() == oid, "source_object_invalid")
            loose = self.metadata / "objects" / oid[:2] / oid[2:]
            if loose.exists():
                self.pin(loose)
                fd = os.open(loose, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
                self.fsync_directory(loose.parent)
                self.fsync_directory(loose.parent.parent)
            return raw
        commit = read("commit", self.approval["sourceContext"]["headSha"])
        headers = commit.split(b"\n\n", 1)[0].split(b"\n")
        self.require(headers[0] == b"tree " + self.approval["treeSha"].encode()
                     and [v[7:] for v in headers if v.startswith(b"parent ")] == [self.approval["parentSha"].encode()], "source_commit_invalid")
        def tree(oid, depth):
            self.require(depth <= 32 and len(visited) < 4096, "source_tree_limit")
            if oid in visited:
                return
            visited.add(oid)
            raw, offset = read("tree", oid), 0
            while offset < len(raw):
                end = raw.find(b"\0", offset)
                self.require(end > offset and end + 21 <= len(raw), "source_tree_invalid")
                mode, name = raw[offset:end].split(b" ", 1)
                self.require(name not in (b"", b".", b"..") and name.lower() != b".git" and b"/" not in name
                             and mode in (b"40000", b"100644", b"100755"), "source_tree_unsupported")
                child = raw[end + 1:end + 21].hex()
                tree(child, depth + 1) if mode == b"40000" else read("blob", child)
                offset = end + 21
        tree(self.approval["treeSha"], 0)

    def lock_file(self, name, artifact):
        self.verify_pins()
        target, origin = self.metadata / name, self.work / artifact
        expected = self.journal[artifact + "Identity"]
        self.require(self.pin(origin) == expected, "source_artifact_changed")
        digest = self.journal["candidateIndexDigest"] if artifact == "candidate-index" else sha((self.approval["sourceContext"]["headSha"] + "\n").encode())
        self.require(sha(self.read(origin)) == digest, "source_artifact_changed")
        if self.exists(target):
            self.require(self.pin(target) == expected, "source_foreign_lock")
        else:
            os.link(artifact, name, src_dir_fd=self.work_fd, dst_dir_fd=self.git_fd, follow_symlinks=False)
            self.fsync_directory(self.metadata)

    def reload_applied(self):
        _project, _receipt, current = self.m.load(self.repository_id)
        lease = current.get("lease")
        self.require(current.get("sourceUpdating") is None and current.get("sourceAppliedOperation") == self.operation_id
                     and current.get("acceptedSource") == self.approval["sourceContext"]
                     and current.get("revision") == self.expected["revision"]
                     and current.get("checkoutIncarnation") == self.expected["checkoutIncarnation"]
                     and {k: str(v) for k, v in current["checkoutIdentity"].items()} == self.expected["checkoutIdentity"]
                     and lease and lease["expiresAt"] > time.time()
                     and (lease["id"], lease["generation"], lease["taskId"]) ==
                         (self.expected["leaseId"], self.expected["leaseGeneration"], self.expected["taskId"]),
                     "source_applied_binding_changed")
        self.record = current
        self.verify_pins()
        self.require(self.read(self.metadata / "HEAD", 100) == (self.approval["sourceContext"]["headSha"] + "\n").encode(),
                     "source_head_cas_failed")
        index_entries(self.read(self.metadata / "index"), self.require)

    def run(self):
        with self.m.lock():
            self.apply_locked()
        self.checkpoint("metadata_unlocked")
        with self.m.lock():
            self.reload_applied()
        # Releasing input is outside the managed lock: a newly admitted lease
        # inspection must never race an unfinished local metadata transaction.
        self.verify()
        self.input_hold.complete(snapshot(self.expected), snapshot(self.record["acceptedSource"]))
        self.checkpoint("barrier_completed")
        return self.m.summary(self.project, self.record)

    def apply_locked(self):
        self.project, self.receipt, self.record = self.m.load(self.repository_id)
        lease = self.record.get("lease")
        self.require(self.record["status"] == "ready" and lease and lease["expiresAt"] > time.time(), "source_lease_inactive")
        self.checkout, self.metadata = self.project / "checkout", self.project / "checkout/.git"
        self.m.checkout_valid(self.checkout, self.record)
        self.checkout_fd = os.open(self.checkout, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.git_fd = os.open(".git", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.checkout_fd)
        current = self.record.get("acceptedSource")
        if current is not None:
            context(current, self.require)
        pending = self.record.get("sourceUpdating")
        completed = self.record.get("sourceLastApplied") if self.record.get("sourceAppliedOperation") == self.operation_id else None
        expected = {"projectId": self.project_id, "repositoryId": self.repository_id, "taskId": lease["taskId"],
                    "leaseId": lease["id"], "leaseGeneration": lease["generation"], "revision": self.record["revision"],
                    "checkoutIncarnation": self.record["checkoutIncarnation"],
                    "checkoutIdentity": {k: str(v) for k, v in self.record["checkoutIdentity"].items()}, "currentSource": current}
        recovery = pending or completed
        if recovery:
            self.require(recovery["operationId"] == self.operation_id
                         and all(expected[k] == recovery["expected"][k] for k in expected if k != "currentSource"), "source_operation_conflict")
            self.expected = recovery["expected"]
            self.approval = recovery["approval"]
        else:
            self.expected = expected
        self.input_hold = self.barrier.enter(snapshot(self.expected), self.operation_id)
        self.verify()
        if not pending and self.record.get("sourceAppliedOperation") == self.operation_id:
            self.require(current == self.approval["sourceContext"], "source_operation_conflict")
            self.require(self.read(self.metadata / "HEAD", 100) == (current["headSha"] + "\n").encode(), "source_head_cas_failed")
            index_entries(self.read(self.metadata / "index"), self.require)
            return
        if not pending:
            self.require(not self.work.exists(), "source_operation_artifacts_exist")
            self.journal = {"operationId": self.operation_id, "expected": self.expected, "approval": self.approval, "phase": "intent"}
            self.save("intent")
        else:
            self.journal = pending
        self.work.parent.mkdir(mode=0o700, exist_ok=True)
        self.m.private(self.work.parent, True)
        self.work.mkdir(mode=0o700, exist_ok=True)
        self.m.private(self.work, True)
        self.work_fd = os.open(self.work, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        if self.journal["phase"] == "intent":
            self.import_objects()
            self.checkpoint("objects_imported")
            self.verify()
            old = self.read(self.metadata / "HEAD", 100)
            self.require(old == (self.approval["parentSha"] + "\n").encode(), "source_head_cas_failed")
            original = self.read(self.metadata / "index")
            original_entries = index_entries(original, self.require)
            for name, raw in (("original-index", original), ("candidate-index", original),
                              ("candidate-head", (self.approval["sourceContext"]["headSha"] + "\n").encode())):
                path = self.work / name
                if path.exists():
                    self.require(self.read(path) == raw, "source_artifact_changed")
                else:
                    self.write_new(path, raw)
            self.git(["read-tree", "-i", "-m", self.approval["parentSha"], self.approval["sourceContext"]["headSha"]], index=self.work / "candidate-index")
            self.checkpoint("candidate_index_written")
            candidate = self.read(self.work / "candidate-index")
            candidate_entries = index_entries(candidate, self.require)
            # read-tree's two-tree merge rejects overlaps; independently check
            # every preexisting staged difference survives in the candidate.
            parent = {}
            for row in self.git(["ls-tree", "-r", "-z", self.approval["parentSha"]])[1].split(b"\0"):
                if row:
                    fields, name = row.split(b"\t", 1)
                    mode, _kind, oid = fields.split()
                    parent[name] = (int(mode, 8), oid.decode())
            for name in set(original_entries) | set(parent):
                if original_entries.get(name) != parent.get(name):
                    self.require(candidate_entries.get(name) == original_entries.get(name), "source_staged_work_conflict")
            self.journal.update(originalIndexDigest=sha(original), candidateIndexDigest=sha(candidate),
                                **{name + "Identity": self.pin(self.work / name) for name in ("candidate-index", "candidate-head")})
            self.save("prepared")
        self.verify()
        self.require(sha(self.read(self.work / "original-index")) == self.journal["originalIndexDigest"], "source_original_index_changed")
        head = self.read(self.metadata / "HEAD", 100)
        old_head = (self.approval["parentSha"] + "\n").encode()
        new_head = (self.approval["sourceContext"]["headSha"] + "\n").encode()
        self.require(head in (old_head, new_head), "source_head_cas_failed")
        index_digest = sha(self.read(self.metadata / "index"))
        self.require(index_digest in (self.journal["originalIndexDigest"], self.journal["candidateIndexDigest"]), "source_index_cas_failed")
        if head == old_head:
            self.require(index_digest == self.journal["originalIndexDigest"], "source_index_cas_failed")
            self.lock_file("HEAD.lock", "candidate-head")
            self.checkpoint("head_lock_linked")
            self.lock_file("index.lock", "candidate-index")
            self.checkpoint("index_lock_linked")
            self.verify()
            self.require(self.read(self.metadata / "HEAD", 100) == old_head
                         and sha(self.read(self.metadata / "index")) == index_digest, "source_metadata_cas_failed")
            self.checkpoint("head_cas_verified")
            os.replace("HEAD.lock", "HEAD", src_dir_fd=self.git_fd, dst_dir_fd=self.git_fd)
            self.fsync_directory(self.metadata)
            self.checkpoint("head_renamed")
            self.save("head_applied")
        else:
            self.require(self.pin(self.metadata / "HEAD") == self.journal["candidate-headIdentity"], "source_head_cas_failed")
        installed_index = self.pin(self.metadata / "index") == self.journal["candidate-indexIdentity"]
        if not installed_index:
            self.require(index_digest == self.journal["originalIndexDigest"], "source_index_cas_failed")
            self.lock_file("index.lock", "candidate-index")
            self.verify()
            self.require(sha(self.read(self.metadata / "index")) == self.journal["originalIndexDigest"], "source_index_cas_failed")
            os.replace("index.lock", "index", src_dir_fd=self.git_fd, dst_dir_fd=self.git_fd)
            self.fsync_directory(self.metadata)
            self.checkpoint("index_renamed")
            self.save("index_applied")
        else:
            self.require(index_digest == self.journal["candidateIndexDigest"], "source_index_cas_failed")
        for lock_name, artifact in (("HEAD.lock", "candidate-head"), ("index.lock", "candidate-index")):
            path = self.metadata / lock_name
            if self.exists(path):
                self.require(self.pin(path) == self.journal[artifact + "Identity"], "source_foreign_lock")
                os.unlink(lock_name, dir_fd=self.git_fd)
                self.fsync_directory(self.metadata)
        # Remove only operation-owned private aliases/lock artifacts. The
        # original index recovery bytes are retained permanently.
        for name in ("candidate-head", "candidate-index"):
            artifact = self.work / name
            if self.exists(artifact):
                self.require(self.pin(artifact) == self.journal[name + "Identity"], "source_artifact_changed")
                os.unlink(name, dir_fd=self.work_fd)
        self.fsync_directory(self.work)
        self.checkpoint("aliases_removed")
        self.verify()
        self.record["acceptedSource"] = self.approval["sourceContext"]
        self.record["sourceAppliedOperation"] = self.operation_id
        self.save("applied")
        self.verify()
        self.record["sourceLastApplied"] = self.journal
        self.record["sourceUpdating"] = None
        self.m.write(self.receipt, self.record)


def apply(manager, repository_id, project_id, operation_id, authority, barrier, objects, checkpoint=None):
    application = Application(manager, repository_id, project_id, operation_id, authority, barrier, objects, checkpoint)
    try:
        return application.run()
    finally:
        # Closing local descriptors never releases the input barrier.
        application.close()
