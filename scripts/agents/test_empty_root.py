"""Local post-cleanup boundary fixtures, not a combined live F06 acceptance claim."""
import copy
import hashlib
import json
import time
import unittest
from pathlib import Path
from unittest import mock
import test_managed_projects as fixture
MODULE = fixture.MODULE


class EmptyAuthority:
    def __init__(self, proposal):
        self.proposal = copy.deepcopy(proposal)
        self.expires = int(time.time() * 1000) + 30000
        self.calls = 0

    def guardian(self):
        return None

    def verify(self, proposal):
        self.calls += 1
        MODULE.require(proposal == self.proposal, "fixture_scope_changed")
        return {"expiresAt": self.expires, "enrollmentToken": "fixture-signed-enrollment",
                "anchor": {**({"unusedBootstrapDigest": MODULE.ManagedProjects._empty_digest(proposal["unusedBootstrap"])} if "unusedBootstrap" in proposal else {}), "currentVolume": {"lifetimeId": "new-epoch"},
                           "records": {"root": proposal["root"]["newRecordSha256"],
                                       "projects": {r["repositoryId"]: r["newRecordSha256"] for r in proposal["projects"]}}}}


class EmptyRootTests(unittest.TestCase):
    setUp = fixture.ManagedProjectsTests.setUp
    tearDown = fixture.ManagedProjectsTests.tearDown
    prepare = fixture.ManagedProjectsTests.prepare
    release = fixture.ManagedProjectsTests.release
    evidence = fixture.ManagedProjectsTests.evidence
    cleanup = fixture.ManagedProjectsTests.cleanup

    def completed_fixture(self):
        prepared = self.prepare()
        self.release(prepared)
        self.manager.request_cleanup("123", "task-one")
        self.cleanup()
        with self.manager.lock():
            project, file, record = self.manager.load("123")
            receipt = {"schemaVersion": 1, "authorizationId": "fixture-authorization", "outcome": "checkout_removed",
                       "cleanupRequestId": record["cleanupRequests"][-1]["id"]}
            record["lastCleanup"] = receipt
            # Explicit fixture: retained records were made on a previous mount.
            root = self.manager.read(self.manager.state / "root.json")
            root["identity"]["device"] -= 1
            record["projectIdentity"]["device"] = root["identity"]["device"]
            self.manager.write(self.manager.state / "root.json", root)
            self.manager.write(file, record)
            receipt = {**receipt, "recordDigests": {"root": hashlib.sha256((self.manager.state / "root.json").read_bytes()).hexdigest(),
                                                   "project": hashlib.sha256(file.read_bytes()).hexdigest()}}
            marker = {"schemaVersion": 1, "phase": "complete", "binding": {"cleanupRequestId": receipt["cleanupRequestId"]},
                      "receipt": receipt, "evidence": {"authorizationToken": "fixture-completed-cleanup-token"}}
            self.manager.write(self.manager.state / "cleanup-123.json", marker)
            self.manager.write(project / "evidence" / ("cleanup-" + receipt["cleanupRequestId"] + ".json"), marker)
        return project, file

    def test_unchanged_empty_root_anchors_current_volume_then_remounts(self):
        with self.manager.lock(): pass
        proposal = self.manager._inspect_empty_root(lifetime_id="fresh")
        self.assertEqual(proposal["mode"], "initial-current")
        self.assertEqual(proposal["root"]["old"], proposal["root"]["current"])
        self.assertEqual(proposal["root"]["recordSha256"], proposal["root"]["newRecordSha256"])
        self.manager._revalidate_empty_root(proposal, EmptyAuthority(proposal))
        identity = self.manager.identity
        with mock.patch.object(self.manager, "identity", lambda path: {**identity(path), "device": identity(path)["device"] + 1}):
            remount = self.manager._inspect_empty_root(lifetime_id="later")
            self.assertEqual(remount["mode"], "remount")
            self.assertEqual(remount["projects"], [])
            self.manager._revalidate_empty_root(remount, EmptyAuthority(remount))

    def test_changed_unanchored_root_cannot_adopt_current_volume(self):
        with self.manager.lock(): pass
        identity = self.manager.identity
        with mock.patch.object(self.manager, "identity", lambda path: {**identity(path), "device": identity(path)["device"] + 1}):
            with self.assertRaisesRegex(MODULE.ManagedError, "empty_root_volume_provenance_missing"):
                self.manager._inspect_empty_root(lifetime_id="later")

    def unused_descriptor(self):
        fixture_path = Path(__file__).parents[1] / "fixtures/unused-bootstrap-root.json"
        descriptor = json.loads(fixture_path.read_text())["unusedBootstrap"]
        descriptor["rootRecordSha256"] = hashlib.sha256((self.manager.state / "root.json").read_bytes()).hexdigest()
        return descriptor

    def test_unused_bootstrap_maps_only_under_exact_grant_and_replays_after_mapping_ack_loss(self):
        with self.manager.lock(): pass
        root_file = self.manager.state / "root.json"
        raw = root_file.read_bytes()
        descriptor = self.unused_descriptor()
        auth = self.home / ".local/share/hive/codex-native/codex/auth.json"
        auth.parent.mkdir(parents=True)
        auth.write_bytes(b'opaque fixture auth, not parsed')
        original_identity = self.manager.identity
        observed = lambda path: {**original_identity(path), "device": original_identity(path)["device"] + 1}
        with mock.patch.object(self.manager, "identity", observed):
            proposal = self.manager._inspect_empty_root(lifetime_id="new-epoch", unused_bootstrap=descriptor)
            self.assertEqual(proposal["mode"], "initial-unused-remount")
            self.assertEqual(proposal["projects"], [])
            self.assertEqual(root_file.read_bytes(), raw)  # Inspection never maps.
            authority = EmptyAuthority(proposal)
            wrong = EmptyAuthority(proposal)
            verify = wrong.verify
            def wrong_grant(value):
                result = verify(value); result["anchor"]["unusedBootstrapDigest"] = "0" * 64; return result
            wrong.verify = wrong_grant
            with self.assertRaisesRegex(MODULE.ManagedError, "unused_bootstrap_grant_changed"):
                self.manager._revalidate_empty_root(proposal, wrong)
            self.assertEqual(root_file.read_bytes(), raw)
            real_write = self.manager.write
            def interrupted_write(path, value):
                real_write(path, value)
                if path == root_file: raise RuntimeError("fixture mapping ACK lost")
            with mock.patch.object(self.manager, "write", interrupted_write):
                with self.assertRaisesRegex(RuntimeError, "ACK lost"):
                    self.manager._revalidate_empty_root(proposal, authority)
            self.assertNotEqual(root_file.read_bytes(), raw)
            self.assertEqual(self.manager._inspect_empty_root(lifetime_id="new-epoch", unused_bootstrap=descriptor), proposal)
            self.manager._revalidate_empty_root(proposal, authority)
            # Lost DB/enrollment ACK must return the exact original descriptor.
            self.assertEqual(self.manager._inspect_empty_root(lifetime_id="new-epoch", unused_bootstrap=descriptor), proposal)
            self.assertEqual(json.loads(self.manager.read(self.manager.state / "empty-root.json")["oldRootRaw"])["record"], json.loads(raw)["record"])
            self.assertEqual(auth.read_bytes(), b'opaque fixture auth, not parsed')

    def test_unused_snapshot_rejects_history_checkouts_consumers_and_changed_root(self):
        with self.manager.lock(): pass
        self.assertEqual(self.manager._capture_unused_bootstrap_root()["raw"], (self.manager.state / "root.json").read_text())
        root_raw = (self.manager.state / "root.json").read_bytes()
        for name in ["github-123.json", "empty-root.json", "unknown.json"]:
            path = self.manager.state / name
            path.write_text("{}"); path.chmod(0o600)
            with self.assertRaises(MODULE.ManagedError):
                self.manager._capture_unused_bootstrap_root()
            path.unlink()
        (self.manager.root / "checkout").mkdir()
        with self.assertRaisesRegex(MODULE.ManagedError, "empty_root_not_empty"):
            self.manager._capture_unused_bootstrap_root()
        (self.manager.root / "checkout").rmdir()
        with mock.patch.object(self.manager, "process_references", return_value=["opaque"]):
            with self.assertRaisesRegex(MODULE.ManagedError, "checkout_in_use"):
                self.manager._capture_unused_bootstrap_root()
        descriptor = self.unused_descriptor(); descriptor["rootRecordSha256"] = "0" * 64
        with self.assertRaisesRegex(MODULE.ManagedError, "unused_bootstrap_root_changed"):
            self.manager._inspect_empty_root(lifetime_id="new", unused_bootstrap=descriptor)
        self.assertEqual((self.manager.state / "root.json").read_bytes(), root_raw)

    def test_prior_anchored_project_cannot_disappear_on_a_later_epoch(self):
        import shutil
        project, file = self.completed_fixture()
        proposal = self.manager._inspect_empty_root()
        self.manager._revalidate_empty_root(proposal, EmptyAuthority(proposal))
        file.unlink(); shutil.rmtree(project)
        identity = self.manager.identity
        with mock.patch.object(self.manager, "identity", lambda path: {**identity(path), "device": identity(path)["device"] + 1}):
            with self.assertRaisesRegex(MODULE.ManagedError, "empty_root_inventory_changed"):
                self.manager._inspect_empty_root(lifetime_id="later")

    def test_completed_history_maps_only_identity_then_fresh_prepare(self):
        project, file = self.completed_fixture()
        old = self.manager.read(file)
        proposal = self.manager._inspect_empty_root()
        authority = EmptyAuthority(proposal)
        result = self.manager._revalidate_empty_root(proposal, authority)
        mapped = self.manager.read(file)
        self.assertTrue(result["revalidated"])
        self.assertFalse(result["leaseRenewed"])
        self.assertEqual({k: v for k, v in old.items() if k != "projectIdentity"}, {k: v for k, v in mapped.items() if k != "projectIdentity"})
        saved = file.read_bytes()
        self.assertEqual(self.manager._inspect_empty_root(lifetime_id="new-epoch"), proposal)
        self.manager._revalidate_empty_root(proposal, authority)
        self.assertEqual(file.read_bytes(), saved)
        prepared = self.manager.prepare("123", "task-two", self.sha)
        self.assertEqual(prepared["lease"]["taskId"], "task-two")
        self.assertTrue((project / "checkout").is_dir())

    def test_partial_mapping_holds_generic_operations_then_replays_exact_bytes(self):
        _, file = self.completed_fixture()
        proposal = self.manager._inspect_empty_root()
        authority = EmptyAuthority(proposal)
        real = self.manager.write
        clock = [time.time()]
        def write(path, value):
            real(path, value)
            if path == self.manager.state / "root.json":
                clock[0] = authority.expires / 1000 + 1
        with mock.patch.object(self.manager, "write", write), mock.patch.object(MODULE.time, "time", lambda: clock[0]):
            with self.assertRaisesRegex(MODULE.ManagedError, "empty_root_authority_expired"):
                self.manager._revalidate_empty_root(proposal, authority)
        self.assertNotEqual(self.manager.read(file)["projectIdentity"], self.manager.identity(self.manager.paths("123")[0]))
        with self.assertRaisesRegex(MODULE.ManagedError, "empty_root_reconciliation_required"):
            self.manager.prepare("123", "task-two", self.sha)
        self.assertEqual(self.manager._inspect_empty_root(), proposal)
        authority.expires += 60000  # New fixture issuer grant; never a stale-grant extension.
        self.manager._revalidate_empty_root(proposal, authority)
        self.assertEqual(self.manager.read(file)["projectIdentity"], self.manager.identity(self.manager.paths("123")[0]))

    def test_expired_grant_and_competing_lock_write_nothing(self):
        _, file = self.completed_fixture()
        proposal = self.manager._inspect_empty_root()
        authority = EmptyAuthority(proposal)
        authority.expires = int(time.time() * 1000) - 1
        before = file.read_bytes()
        with self.assertRaisesRegex(MODULE.ManagedError, "empty_root_authority_expired"):
            self.manager._revalidate_empty_root(proposal, authority)
        self.assertFalse((self.manager.state / "empty-root.json").exists())
        self.assertEqual(file.read_bytes(), before)
        other = MODULE.ManagedProjects(self.home)
        authority.expires += 60000
        with self.manager.lock(empty_root=True):
            with self.assertRaises(BlockingIOError): other._revalidate_empty_root(proposal, authority)
        self.assertFalse((self.manager.state / "empty-root.json").exists())
        self.manager._revalidate_empty_root(proposal, authority)

    def test_active_or_unproven_inventory_never_writes(self):
        for invalid in ["lease", "checkout", "marker", "record", "inode"]:
            with self.subTest(invalid=invalid):
                project, file = self.completed_fixture() if invalid == "lease" else (project, file)
                # Keep a fresh signed baseline for each bounded mutation.
                original = file.read_bytes(); root = (self.manager.state / "root.json").read_bytes()
                if invalid == "lease":
                    record = self.manager.read(file); record["lease"] = {"id": "foreign"}; self.manager.write(file, record)
                elif invalid == "checkout": (project / "checkout").mkdir()
                elif invalid == "marker":
                    marker = self.manager.read(self.manager.state / "cleanup-123.json"); marker["phase"] = "deleting"; self.manager.write(self.manager.state / "cleanup-123.json", marker)
                elif invalid == "record":
                    record = self.manager.read(file); record["revision"] = "b" * 40; self.manager.write(file, record)
                else:
                    record = self.manager.read(file); record["projectIdentity"]["inode"] += 1; self.manager.write(file, record)
                changed = file.read_bytes()
                with self.assertRaises(MODULE.ManagedError): self.manager._inspect_empty_root()
                self.assertEqual(file.read_bytes(), changed)
                self.assertEqual((self.manager.state / "root.json").read_bytes(), root)
                file.write_bytes(original)
                if invalid == "checkout": (project / "checkout").rmdir()
                if invalid == "marker":
                    marker["phase"] = "complete"; self.manager.write(self.manager.state / "cleanup-123.json", marker)


if __name__ == "__main__": unittest.main()
