#!/usr/bin/env python3
"""Fixed accepted-source metadata worker. Private parent FD3, no path/RPC CLI.

Only the parent can supply fresh server application authority and a durable input
barrier. Sealed objects come from the fixed installed publisher operation. This
worker neither contacts GitHub nor releases the physical writer/guardian hold.
"""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import time
import uuid

sys.dont_write_bytecode = True


def sibling(name):
    spec = importlib.util.spec_from_file_location("hive_apply_" + name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


protocol = sibling("delivery-source-worker")
broker = sibling("delivery-source-broker")
managed = sibling("managed-projects")
require = broker.require
canonical = broker.canonical
sha = broker.sha


def identifier(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


class PublishedObjects:
    """Read an existing immutable published operation without acquiring its writer lock.

    The publisher keeps its lifetime flock. This reader never initializes a repo,
    regenerates a key, prepares an operation or invokes any provider method.
    """
    def __init__(self, home, operation_id):
        require(identifier(operation_id), "apply_operation_invalid")
        self.home, self.operation_id = Path(home), operation_id
        self.root = self.home / ".local/state/hive/delivery-source-publisher/broker" / operation_id
        require(self.root.resolve() == self.root, "apply_object_path_changed")
        for path in (self.root.parent.parent, self.root.parent, self.root, self.root / "operations",
                     self.root / "sealed", self.root / "repo.git", self.root / "home"):
            info = path.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
                    "apply_object_path_changed")
        self.key = broker.read_private(self.root / "key", 32)
        require(len(self.key) == 32, "apply_object_key_invalid")
        self.fd = os.open(self.root / "repo.git", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.pin = self.identity(os.fstat(self.fd))
        self.bound = None
        self.total = 0

    @staticmethod
    def identity(info):
        return (info.st_dev, info.st_ino)

    def signed(self, path):
        envelope = json.loads(broker.read_private(path, 2 * broker.MAX_BYTES))
        require(isinstance(envelope, dict) and set(envelope) == {"value", "mac"}
                and isinstance(envelope["mac"], str)
                and hmac.compare_digest(envelope["mac"], hmac.new(self.key, canonical(envelope["value"]), hashlib.sha256).hexdigest()),
                "apply_object_journal_invalid")
        return envelope["value"]

    def bind(self, source):
        require(isinstance(source, dict) and source.get("isCurrent") is True
                and source.get("publicationAuthorized") is False and source.get("executionAuthorized") is False
                and type(source.get("expiresAt")) is int and time.time() * 1000 < source["expiresAt"], "apply_source_state_invalid")
        scope, accepted = source["scope"], source["accepted"]
        physical = scope["checkoutBinding"]
        expected = {
            "ownerId": scope["ownerId"], "taskId": scope["taskId"], "managerBindingId": scope["managerBindingId"],
            "attemptId": accepted["producingAttemptId"], "repositoryId": accepted["repositoryId"],
            "providerAccountId": accepted["providerAccountId"], "fullName": accepted["fullName"],
            "baseBranch": accepted["baseBranch"], "parentSha": accepted["parentSha"],
            "sourceVersion": accepted["sourceContext"]["version"] - 1,
            "serverInstanceId": scope["serverInstanceId"], "leaseId": physical["leaseId"],
            "leaseGeneration": physical["leaseGeneration"], "checkoutIncarnation": source["admission"]["checkoutIncarnation"],
        }
        require(accepted["operationId"] == self.operation_id and source["current"]["sourceContext"] == accepted["sourceContext"]
                and source["current"]["headSha"] == accepted["sourceContext"]["headSha"], "apply_source_state_invalid")
        entry = self.signed(self.root / "operations" / (self.operation_id + ".json"))
        require(entry.get("schemaVersion") == 1 and entry.get("phase") == "published"
                and entry.get("scope") == expected and entry.get("request", {}).get("operationId") == self.operation_id
                and entry.get("requestDigest") == sha(canonical({"scope": expected, "policyDigest": entry.get("policyDigest"), "request": entry["request"]})),
                "apply_object_scope_changed")
        manifest = entry.get("manifest")
        require(isinstance(manifest, list) and len(manifest) <= 100
                and entry.get("manifestDigest") == accepted["manifestDigest"]
                and sha(canonical({"files": manifest, "deletions": sorted(entry["request"]["deletions"])})) == accepted["manifestDigest"],
                "apply_object_manifest_changed")
        sealed_bytes = 0
        for item in manifest:
            require(isinstance(item, dict) and set(item) == {"path", "contentDigest", "size", "mode", "blobSha"}
                    and re.fullmatch(r"[a-f0-9]{64}", item["contentDigest"] or "")
                    and type(item["size"]) is int and 0 <= item["size"] <= 1024 * 1024
                    and item["mode"] in {"100644", "100755"}, "apply_object_manifest_changed")
            sealed_bytes += item["size"]
            require(sealed_bytes <= broker.MAX_BYTES, "apply_object_manifest_changed")
            raw = broker.read_private(self.root / "sealed" / item["contentDigest"], 1024 * 1024)
            require(len(raw) == item["size"] and sha(raw) == item["contentDigest"]
                    and broker.object_id("blob", raw) == item["blobSha"], "apply_object_manifest_changed")
        commit = entry.get("commit", {})
        require(commit.get("sha") == accepted["sourceContext"]["headSha"] and commit.get("tree") == accepted["treeSha"]
                and commit.get("parents") == [accepted["parentSha"]] and entry.get("branch") == accepted["branch"],
                "apply_object_commit_changed")
        bound = {"scope": expected, "operationId": self.operation_id, "commit": commit,
                 "manifestDigest": accepted["manifestDigest"], "sourceContext": accepted["sourceContext"]}
        require(self.bound is None or self.bound == bound, "apply_object_scope_changed")
        self.bound = bound
        self.validate_store()

    def validate_store(self):
        require(self.fd is not None and self.identity(os.fstat(self.fd)) == self.pin
                and self.identity((self.root / "repo.git").lstat()) == self.pin
                and (self.root / "repo.git").resolve() == self.root / "repo.git", "apply_object_path_changed")
        store = self.signed(self.root / "store.json")
        require(store.get("configDigest") == sha(broker.read_private(self.root / "repo.git/config", 1024 * 1024)), "apply_object_config_changed")
        for name in ("objects/info/alternates", "objects/info/http-alternates", "info/grafts", "commondir", "shallow", "config.worktree", "refs/replace"):
            require(not os.path.lexists(self.root / "repo.git" / name), "apply_object_config_changed")

    def read_object(self, kind, object_id):
        require(self.bound is not None and kind in {"commit", "tree", "blob"}
                and re.fullmatch(r"[a-f0-9]{40}", object_id or ""), "apply_object_invalid")
        self.validate_store()
        # Reuse the reviewed bounded, sanitized Git subprocess implementation,
        # never the broker constructor (which could create/mutate a store).
        reader = object.__new__(broker._SourceBrokerCore)
        reader.root = self.root
        reader.isolate_git_process_group = False
        raw = reader._execute(["--git-dir=" + f"/proc/{os.getpid()}/fd/{self.fd}", "cat-file", kind, object_id])
        self.total += len(raw)
        require(len(raw) <= 1024 * 1024 and self.total <= 8 * 1024 * 1024
                and broker.object_id(kind, raw) == object_id, "apply_object_invalid")
        self.validate_store()
        return raw

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def run(channel, *, home=None):
    start = channel.receive()
    require(isinstance(start, dict) and set(start) == {"schemaVersion", "type", "value"}
            and start["schemaVersion"] == 1 and start["type"] == "start", "apply_protocol_invalid")
    request = start["value"]
    require(isinstance(request, dict) and set(request) == {"projectId", "repositoryId", "applicationId", "publicationOperationId"}
            and all(identifier(request[k]) for k in ("projectId", "applicationId", "publicationOperationId"))
            and re.fullmatch(r"[1-9][0-9]{0,19}", request["repositoryId"] or ""), "apply_protocol_invalid")
    home = Path(pwd.getpwuid(os.getuid()).pw_dir if home is None else home)
    manager = managed.ManagedProjects(home)
    # Never initialize/adopt a managed root as a side effect of application.
    for path in (manager.state / "key", manager.state / "root.json", manager.state / f"github-{request['repositoryId']}.json"):
        manager.private(path)
    objects = PublishedObjects(home, request["publicationOperationId"])
    class Authority:
        def verify(self, expected, operation_id):
            result = channel.exchange("authority", {"request": request, "expected": expected, "operationId": operation_id})
            require(isinstance(result, dict) and set(result) == {"authority", "sourceState"}, "apply_protocol_invalid")
            objects.bind(result["sourceState"])
            return result["authority"]
    class Barrier:
        def enter(self, expected, operation_id):
            self.verify(expected, operation_id)
            return self
        def verify(self, expected, operation_id, producer=None):
            result = channel.exchange("input_barrier", {"request": request, "expected": expected, "operationId": operation_id, "producer": producer})
            require(result == {"closed": True, "applicationId": request["applicationId"]}, "apply_barrier_unavailable")
        def complete(self, expected, source):
            # Called only after managed receipt durability and lock release. Parent
            # synchronizes both journals, commits/reads back the independent server
            # application, then releases input. Lost ACK keeps the independent hold.
            result = channel.exchange("applied", {"request": request, "expected": expected, "sourceContext": source})
            require(result == {"committed": True, "applicationId": request["applicationId"], "sourceContext": source}, "apply_commit_unavailable")
    try:
        result = manager._apply_accepted_source(request["repositoryId"], request["projectId"], request["publicationOperationId"], Authority(), Barrier(), objects)
        channel.send("result", {"applicationId": request["applicationId"], "publicationOperationId": request["publicationOperationId"], "acceptedSource": result["acceptedSource"]})
    finally:
        objects.close()


if __name__ == "__main__":
    channel = None
    try:
        require(len(sys.argv) == 1, "apply_protocol_invalid")
        channel = protocol.Channel()
        run(channel)
    except Exception:
        if channel is not None:
            try:
                channel.send("error", {"code": "source_application_worker_failed"})
            except Exception:
                pass
        sys.exit(1)
    finally:
        if channel is not None:
            channel.socket.close()
