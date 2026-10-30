"""Read real sealed broker objects only; fake provider and explicit fixture authority."""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import unittest
import uuid


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


FIXTURE = module("apply_worker_fixture", Path(__file__).with_name("test_delivery_source_runtime.py"))
WORKER = FIXTURE.SOURCE.with_name("delivery-source-apply-worker.py")
MODULE = module("apply_worker", WORKER)


class PublishedObjectTests(unittest.TestCase):
    def setUp(self):
        self.fixture = FIXTURE.ProtectedBrokerTests("runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.assertEqual(f.publish()["phase"], "published")
        entry = f.b.load(f.request["operationId"])
        self.home = Path(f.temp.name) / "home"
        parent = self.home / ".local/state/hive/delivery-source-publisher/broker"
        parent.mkdir(parents=True, mode=0o700)
        os.chmod(parent.parent, 0o700)
        self.root = parent / f.request["operationId"]
        shutil.move(f.private, self.root)
        source = {"revisionId": str(uuid.uuid4()), "version": 1, "headSha": entry["commit"]["sha"]}
        self.state = {
            "scope": {"ownerId": f.scope["ownerId"], "taskId": f.scope["taskId"], "managerBindingId": f.scope["managerBindingId"],
                      "serverInstanceId": f.scope["serverInstanceId"], "checkoutBinding": {"leaseId": f.scope["leaseId"], "leaseGeneration": 1}},
            "accepted": {"operationId": f.request["operationId"], "producingAttemptId": f.scope["attemptId"], "sourceContext": source,
                         "repositoryId": f.scope["repositoryId"], "providerAccountId": f.scope["providerAccountId"],
                         "fullName": f.scope["fullName"], "baseBranch": f.scope["baseBranch"], "parentSha": f.scope["parentSha"],
                         "manifestDigest": entry["manifestDigest"], "treeSha": entry["commit"]["tree"], "branch": entry["branch"]},
            "admission": {"checkoutIncarnation": f.scope["checkoutIncarnation"]},
            "current": {"sourceContext": source, "headSha": source["headSha"]},
            "isCurrent": True, "publicationAuthorized": False, "executionAuthorized": False, "expiresAt": int(time.time() * 1000) + 20000,
        }
        self.reader = MODULE.PublishedObjects(self.home, f.request["operationId"])
        self.addCleanup(self.reader.close)

    def snapshot(self):
        return {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.root.rglob("*") if p.is_file()}

    def test_existing_published_operation_reads_verified_objects_without_mutation_or_lock_adoption(self):
        before = self.snapshot()
        with (self.root / "lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.reader.bind(self.state)
            raw = self.reader.read_object("commit", self.state["accepted"]["sourceContext"]["headSha"])
            self.assertEqual(MODULE.broker.object_id("commit", raw), self.state["accepted"]["sourceContext"]["headSha"])
            tree = self.reader.read_object("tree", self.state["accepted"]["treeSha"])
            self.assertGreater(len(tree), 0)
        self.assertEqual(self.snapshot(), before)

    def test_wrong_scope_historical_source_and_changed_commit_are_rejected(self):
        for alter in [
            lambda s: s["scope"].update(taskId=str(uuid.uuid4())),
            lambda s: s["accepted"].update(parentSha="a" * 40),
            lambda s: s["accepted"].update(treeSha="b" * 40),
            lambda s: s.update(isCurrent=False),
            lambda s: s.update(expiresAt=1),
        ]:
            state = copy.deepcopy(self.state); alter(state)
            with self.assertRaises(MODULE.broker.PublicationHold):
                self.reader.bind(state)

    def test_changed_sealed_bytes_or_unsigned_journal_do_not_become_source(self):
        entry_path = self.root / "operations" / (self.fixture.request["operationId"] + ".json")
        raw = entry_path.read_bytes()
        value = json.loads(raw); value["value"]["phase"] = "prepared"; entry_path.write_text(json.dumps(value))
        with self.assertRaisesRegex(MODULE.broker.PublicationHold, "journal_invalid"):
            self.reader.bind(self.state)
        entry_path.write_bytes(raw)
        sealed = next((self.root / "sealed").iterdir()); sealed.write_bytes(b"tampered")
        with self.assertRaisesRegex(MODULE.broker.PublicationHold, "manifest_changed"):
            self.reader.bind(self.state)

    def test_metadata_replacement_config_changes_and_unbound_reads_are_denied(self):
        with self.assertRaisesRegex(MODULE.broker.PublicationHold, "object_invalid"):
            self.reader.read_object("commit", self.state["accepted"]["sourceContext"]["headSha"])
        config = self.root / "repo.git/config"; config.write_bytes(config.read_bytes() + b"\n[include]\npath=/outside\n")
        with self.assertRaisesRegex(MODULE.broker.PublicationHold, "config_changed"):
            self.reader.bind(self.state)

    def test_real_private_fd_worker_applies_published_objects_without_touching_worktree(self, coordinator=False):
        fixtures = module("apply_managed_fixture", Path(__file__).with_name("test_managed_projects.py"))
        f = self.fixture
        bare = Path(f.temp.name) / "managed-remote.git"
        fixtures.git(Path(f.temp.name), "clone", "--bare", str(f.workspace), str(bare))
        manager = fixtures.MODULE.ManagedProjects(self.home, fixtures.FixtureResolver(), fixtures.FixtureGit(bare))
        prepared = manager.prepare("123", str(uuid.uuid4()), f.scope["parentSha"])
        checkout = Path(prepared["checkoutDirectory"])
        # Fixture's independent trusted issuer establishes the existing publication
        # and managed receipt's shared synthetic physical identity before apply.
        # No production CLI/environment can perform this fixture seeding.
        with manager.lock():
            _, receipt, record = manager.load("123")
            record["lease"]["id"] = f.scope["leaseId"]
            record["lease"]["generation"] = record["leaseGeneration"] = f.scope["leaseGeneration"]
            record["checkoutIncarnation"] = f.scope["checkoutIncarnation"]
            manager.write(receipt, record)
        (checkout / "src/main.txt").write_bytes(b"later dirty bytes\0retained\n")
        (checkout / "untracked").write_bytes(b"untracked retained\n")
        (checkout / ".git/info").mkdir(exist_ok=True)
        (checkout / ".git/info/exclude").write_text("ignored.cache\n")
        (checkout / "ignored.cache").write_bytes(b"ignored retained\n")
        (checkout / "README.md").write_bytes(b"nonoverlapping staged edit\n")
        fixtures.git(checkout, "add", "README.md")
        before = {str(p.relative_to(checkout)): p.read_bytes() for p in checkout.rglob("*")
                  if p.is_file() and ".git" not in p.relative_to(checkout).parts}
        project_id, application_id = str(uuid.uuid4()), str(uuid.uuid4())
        request = {"projectId": project_id, "repositoryId": "123", "applicationId": application_id,
                   "publicationOperationId": f.request["operationId"]}
        pin = lambda p: {"device": str(p.stat().st_dev), "inode": str(p.stat().st_ino)}
        a = self.state["accepted"]
        authority = {"operationId": request["publicationOperationId"], "sourceContext": a["sourceContext"],
                     "previousSourceContext": None, "parentSha": a["parentSha"], "treeSha": a["treeSha"],
                     "manifestDigest": a["manifestDigest"], "metadataIdentity": {"checkout": pin(checkout), "git": pin(checkout / ".git")},
                     "producer": {"runtimeId": str(uuid.uuid4()), "runtimeGeneration": 1, "admissionId": str(uuid.uuid4()), "admissionGeneration": 3,
                                  "producerDigest": "a" * 64, "checkoutIncarnation": f.scope["checkoutIncarnation"], "barrierGeneration": 0,
                                  "metadataPinsDigest": "b" * 64, "metadataPolicyDigest": "c" * 64, "namespaceReceiptDigest": "d" * 64}}
        if coordinator:
            physical = {"projectId": project_id, "repositoryId": "123", "preparationIntentId": prepared["lease"]["taskId"],
                        "revision": f.scope["parentSha"], "leaseId": f.scope["leaseId"], "leaseGeneration": 1}
            facts = copy.deepcopy(self.state)
            facts["scope"]["checkoutBinding"] = physical
            facts["admission"] = {k: authority["producer"][k] for k in ("runtimeId", "runtimeGeneration", "admissionId", "admissionGeneration",
                                                                        "producerDigest", "checkoutIncarnation", "barrierGeneration")}
            facts["metadata"] = {"pins": authority["metadataIdentity"], "pinsDigest": authority["producer"]["metadataPinsDigest"],
                                 "policyDigest": authority["producer"]["metadataPolicyDigest"], "namespaceReceiptDigest": authority["producer"]["namespaceReceiptDigest"]}
            material = {"home": str(self.home), "checkout": str(checkout), "managedReceipt": str(receipt),
                        "checkoutBinding": physical, "facts": facts,
                        "metadata": {**authority["producer"], "metadataPins": authority["metadataIdentity"]},
                        "request": {"managerThreadId": "fixture-root", "checkoutBinding": physical, "registrationId": str(uuid.uuid4()),
                                    "serverInstanceId": f.scope["serverInstanceId"], "parentTurnId": "fixture-turn", "cursorVersion": 1}}
            fixture_path = Path(f.temp.name) / "coordinator-fixture.json"
            fixture_path.write_text(json.dumps(material))
            # This is an independent runner, including when Python was launched
            # by node:test. Do not inherit its private child-runner IPC context.
            node_env = {k: v for k, v in os.environ.items() if k != "NODE_TEST_CONTEXT"}
            result = subprocess.run(["node", "--test", "--test-reporter=tap", "--test-name-pattern", "actual private FD3 coordinator retry",
                                     str(Path(__file__).resolve().parents[1] / "verify-codex-source-application.test.mjs")],
                                    env={**node_env, "HIVE_SOURCE_APPLY_REPLAY_FIXTURE": str(fixture_path)},
                                    capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).decode())
            self.assertIn(b"pass 1", result.stdout)
        else:
            parent, child = socket.socketpair()
            script = ("import importlib.util,os,sys\nos.dup2(int(sys.argv[1]),3)\n"
                      f"s=importlib.util.spec_from_file_location('worker',{str(WORKER)!r})\n"
                      "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"
                      f"m.run(m.protocol.Channel(),home={str(self.home)!r})\n")
            process = subprocess.Popen(["/usr/bin/python3", "-I", "-B", "-c", script, str(child.fileno())],
                                       pass_fds=(child.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child.close(); parent.settimeout(10)
            stream = parent.makefile("rwb", buffering=0)
            self.addCleanup(parent.close); self.addCleanup(stream.close)
            try:
                stream.write(json.dumps({"schemaVersion": 1, "type": "start", "value": request}).encode() + b"\n")
                sequence, completed = 0, False
                while True:
                    raw = stream.readline(65537)
                    self.assertTrue(raw, "worker closed before result")
                    frame = json.loads(raw); sequence += 1
                    self.assertEqual(frame["id"], sequence)
                    kind, value = frame["type"], frame["value"]
                    if kind == "result":
                        self.assertTrue(completed)
                        self.assertEqual(value["acceptedSource"], a["sourceContext"])
                        break
                    self.assertEqual(value["request"], request)
                    if kind == "authority":
                        self.state["expiresAt"] = int(time.time() * 1000) + 20000
                        response = {"authority": {**authority, "expiresAt": time.time() + 20}, "sourceState": self.state}
                    elif kind == "input_barrier":
                        response = {"closed": True, "applicationId": application_id}
                    else:
                        self.assertEqual(kind, "applied")
                        inspected = manager.inspect("123") # Proves managed lock released before callback.
                        self.assertEqual(inspected["acceptedSource"], a["sourceContext"])
                        self.assertNotIn("sourceUpdating", inspected)
                        completed = True
                        response = {"committed": True, "applicationId": application_id, "sourceContext": a["sourceContext"]}
                    stream.write(json.dumps({"schemaVersion": 1, "type": "response", "id": sequence, "value": response}).encode() + b"\n")
                out, error = process.communicate(timeout=5)
                self.assertEqual((process.returncode, out, error), (0, b"", b""))
            finally:
                if process.poll() is None:
                    process.kill(); process.wait()
        self.assertEqual(fixtures.git(checkout, "rev-parse", "HEAD"), a["sourceContext"]["headSha"])
        self.assertEqual(fixtures.git(checkout, "show", ":README.md"), "nonoverlapping staged edit")
        after = {str(p.relative_to(checkout)): p.read_bytes() for p in checkout.rglob("*")
                 if p.is_file() and ".git" not in p.relative_to(checkout).parts}
        self.assertEqual(before, after)

    def test_real_coordinator_recovers_lost_commit_ack_with_historical_expected_source(self):
        self.test_real_private_fd_worker_applies_published_objects_without_touching_worktree(coordinator=True)

    def test_worker_has_no_cli_paths_or_stdin_activation(self):
        for args in ([], [str(self.home)]):
            value = subprocess.run(["/usr/bin/python3", "-I", "-B", str(WORKER), *args], input=b"{}\n", capture_output=True, timeout=5)
            self.assertEqual((value.returncode, value.stdout, value.stderr), (1, b"", b""))
        with self.assertRaises(MODULE.broker.PublicationHold):
            MODULE.PublishedObjects(self.home, "../another")


if __name__ == "__main__":
    unittest.main()
