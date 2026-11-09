"""Local Git fixtures only. No CLI/environment switch enables apply authority."""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

_fixture_spec = importlib.util.spec_from_file_location("hive_managed_source_fixture", Path(__file__).with_name("test_managed_projects.py"))
_fixture = importlib.util.module_from_spec(_fixture_spec)
_fixture_spec.loader.exec_module(_fixture)
MODULE, FixtureGit, FixtureResolver, git = _fixture.MODULE, _fixture.FixtureGit, _fixture.FixtureResolver, _fixture.git


class FixtureBarrier:
    def __init__(self):
        self.active = False
        self.busy = False
        self.completed = 0
        self.expected = None

    def enter(self, expected, operation_id):
        self.active = True
        if self.expected is None:
            self.expected = copy.deepcopy(expected)
        self.verify(expected, operation_id)
        return self

    def verify(self, expected, _operation_id, _producer=None):
        MODULE.require(self.active and not self.busy and expected == self.expected, "fixture_input_not_quiescent")

    def complete(self, expected, _current):
        self.verify(expected, None)
        self.completed += 1
        self.active = False


class FixtureAuthority:
    def __init__(self, fixture):
        self.fixture = fixture
        self.value = {
            "operationId": fixture.operation, "sourceContext": {"revisionId": str(uuid.uuid4()), "version": 1, "headSha": fixture.target},
            "previousSourceContext": None, "parentSha": fixture.base_sha,
            "treeSha": git(fixture.source, "rev-parse", "HEAD^{tree}"), "manifestDigest": "a" * 64,
            "metadataIdentity": {"checkout": fixture.pin(fixture.checkout), "git": fixture.pin(fixture.checkout / ".git")},
            "producer": {"runtimeId": str(uuid.uuid4()), "runtimeGeneration": 1,
                         "admissionId": str(uuid.uuid4()), "admissionGeneration": 1,
                         "producerDigest": "b" * 64, "checkoutIncarnation": fixture.prepared["checkoutIncarnation"],
                         "barrierGeneration": 0, "metadataPinsDigest": "e" * 64, "metadataPolicyDigest": "c" * 64,
                         "namespaceReceiptDigest": "d" * 64}}
        self.expired = False
        self.calls = 0

    def verify(self, expected, operation_id):
        self.calls += 1
        MODULE.require(operation_id == self.fixture.operation and expected["repositoryId"] == "123"
                       and expected["revision"] == self.fixture.base_sha
                       and expected["checkoutIncarnation"] == self.fixture.prepared["checkoutIncarnation"], "fixture_scope_changed")
        return {**copy.deepcopy(self.value), "expiresAt": time.time() + (-1 if self.expired else 20)}


class FixtureObjects:
    def __init__(self, source):
        self.source = source
        self.corrupt = False

    def read_object(self, kind, oid):
        if self.corrupt:
            return b"corrupt"
        return subprocess.check_output(["/usr/bin/git", "-C", str(self.source), "cat-file", kind, oid])


class ManagedSourceApplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hive-source-apply-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home, self.source = self.root / "home", self.root / "source"
        self.home.mkdir()
        self.source.mkdir()
        git(self.source, "init", "-b", "main")
        (self.source / "a.txt").write_text("old a\n")
        (self.source / "b.txt").write_text("old b\n")
        (self.source / ".gitignore").write_text("*.cache\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "-m", "test: base")
        self.base_sha = git(self.source, "rev-parse", "HEAD")
        self.bare = self.root / "remote.git"
        git(self.root, "clone", "--bare", str(self.source), str(self.bare))
        self.manager = MODULE.ManagedProjects(self.home, FixtureResolver(), FixtureGit(self.bare))
        self.prepared = self.manager.prepare("123", "fixture-task", self.base_sha)
        self.checkout = Path(self.prepared["checkoutDirectory"])
        self.project = str(uuid.uuid4())
        self.operation = str(uuid.uuid4())
        (self.source / "b.txt").write_text("accepted b\n")
        git(self.source, "add", "b.txt")
        git(self.source, "commit", "-m", "feat: accepted fixture")
        self.target = git(self.source, "rev-parse", "HEAD")
        self.authority = FixtureAuthority(self)
        self.barrier = FixtureBarrier()
        self.objects = FixtureObjects(self.source)

    @staticmethod
    def pin(path):
        s = path.stat()
        return {"device": str(s.st_dev), "inode": str(s.st_ino)}

    def apply(self, checkpoint=None):
        return self.manager._apply_accepted_source("123", self.project, self.operation,
                                                  self.authority, self.barrier, self.objects, checkpoint)

    def record(self):
        with self.manager.lock():
            return self.manager.load("123")[2]

    def snapshot(self):
        result = {}
        for path in self.checkout.rglob("*"):
            relative = str(path.relative_to(self.checkout))
            if relative == ".git" or relative.startswith(".git/"):
                continue
            info = path.lstat()
            if path.is_symlink():
                value = ("symlink", os.readlink(path))
            elif path.is_file():
                value = ("file", hashlib.sha256(path.read_bytes()).hexdigest())
            else:
                continue
            result[relative] = (*value, info.st_mode, info.st_ino, info.st_mtime_ns)
        return result

    def user_work(self):
        (self.checkout / "a.txt").write_text("staged a\n")
        git(self.checkout, "add", "a.txt")
        (self.checkout / "a.txt").write_text("staged plus unstaged a\n")
        (self.checkout / "b.txt").write_bytes(b"concurrent dirty b\x00\xff")
        (self.checkout / "secret.cache").write_bytes(b"ignored\x00\xff")
        (self.checkout / "untracked").write_bytes(b"untracked\x00\xfe")
        (self.checkout / "alias").symlink_to("untracked")

    def test_applies_head_and_index_preserving_all_worktree_bytes_and_unrelated_staging(self):
        self.user_work()
        before, original_index = self.snapshot(), (self.checkout / ".git/index").read_bytes()
        staged = git(self.checkout, "rev-parse", ":a.txt")
        result = self.apply()
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.target)
        self.assertEqual(git(self.checkout, "rev-parse", ":a.txt"), staged)
        self.assertEqual(git(self.checkout, "rev-parse", ":b.txt"), git(self.source, "rev-parse", "HEAD:b.txt"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(result["revision"], self.base_sha)
        self.assertEqual(result["lease"], self.prepared["lease"])
        self.assertEqual(result["checkoutIncarnation"], self.prepared["checkoutIncarnation"])
        self.assertEqual(result["acceptedSource"], self.authority.value["sourceContext"])
        self.assertNotIn("sourceUpdating", result)
        self.assertFalse(self.barrier.active)
        work = self.manager.state / "source-applications" / self.operation
        self.assertEqual((work / "original-index").read_bytes(), original_index)
        self.assertEqual((self.checkout / ".git/HEAD").stat().st_nlink, 1)
        self.assertEqual((self.checkout / ".git/index").stat().st_nlink, 1)
        self.assertEqual(self.apply()["acceptedSource"], result["acceptedSource"])
        self.assertEqual(self.snapshot(), before)

    def test_staged_overlap_holds_without_changing_head_index_or_worktree(self):
        (self.checkout / "b.txt").write_text("user staged b\n")
        git(self.checkout, "add", "b.txt")
        before, original = self.snapshot(), (self.checkout / ".git/index").read_bytes()
        with self.assertRaisesRegex(MODULE.ManagedError, "source_git_rejected|source_staged_work_conflict"):
            self.apply()
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.base_sha)
        self.assertEqual((self.checkout / ".git/index").read_bytes(), original)
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(self.record()["sourceUpdating"])
        self.assertFalse(self.manager.inspect("123")["checkoutVerified"])
        self.assertTrue(self.barrier.active)

    def test_crash_after_head_index_or_applied_receipt_recovers_without_second_worktree_write(self):
        for point in ("objects_imported", "prepared", "head_lock_linked", "index_lock_linked",
                      "head_renamed", "head_applied", "index_renamed", "index_applied", "aliases_removed", "applied"):
            with self.subTest(point=point):
                fixture = ManagedSourceApplyTests()
                fixture.setUp()
                try:
                    fixture.user_work()
                    before = fixture.snapshot()
                    def crash(phase):
                        if phase == point:
                            raise RuntimeError("fixture_crash")
                    with self.assertRaisesRegex(RuntimeError, "fixture_crash"):
                        fixture.apply(crash)
                    self.assertTrue(fixture.barrier.active)
                    self.assertTrue(fixture.record()["sourceUpdating"])
                    result = fixture.apply()
                    self.assertEqual(result["acceptedSource"], fixture.authority.value["sourceContext"])
                    self.assertEqual(fixture.snapshot(), before)
                finally:
                    fixture.doCleanups()

    def test_foreign_git_locks_are_never_removed_or_adopted(self):
        for name in ("HEAD.lock", "index.lock"):
            with self.subTest(name=name):
                path = self.checkout / ".git" / name
                path.write_bytes(b"foreign work")
                original = path.stat().st_ino
                with self.assertRaisesRegex(MODULE.ManagedError, "source_foreign_lock"):
                    self.apply()
                self.assertEqual(path.read_bytes(), b"foreign work")
                self.assertEqual(path.stat().st_ino, original)
                path.unlink()  # Test-owned foreign fixture, never the application.
                if name == "HEAD.lock":
                    # The owned HEAD lock left by the second case is tested by
                    # normal recovery; this first case never acquired one.
                    self.assertFalse((self.checkout / ".git/HEAD.lock").exists())

    def test_changed_head_or_index_during_apply_holds_expected_old_cas(self):
        original_head = (self.checkout / ".git/HEAD").read_bytes()
        def change(phase):
            if phase == "prepared":
                (self.checkout / ".git/HEAD").write_bytes(b"f" * 40 + b"\n")
        with self.assertRaisesRegex(MODULE.ManagedError, "source_head_cas_failed"):
            self.apply(change)
        self.assertEqual((self.checkout / ".git/HEAD").read_bytes(), b"f" * 40 + b"\n")
        self.assertTrue(self.barrier.active)
        (self.checkout / ".git/HEAD").write_bytes(original_head)
        def change_index(_phase):
            pass
        self.apply(change_index)

    def test_authority_loss_after_head_change_retains_hold_until_fresh_agreement(self):
        def expire(phase):
            if phase == "head_applied":
                self.authority.expired = True
        with self.assertRaisesRegex(MODULE.ManagedError, "source_authority_stale"):
            self.apply(expire)
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.target)
        self.assertTrue(self.barrier.active)
        self.assertEqual(self.record()["revision"], self.base_sha)
        self.authority.expired = False
        self.apply()
        self.assertFalse(self.barrier.active)

    def test_index_cas_conflict_after_head_change_preserves_foreign_index_and_hold(self):
        changed = []
        def change(phase):
            if phase == "head_applied":
                # Simulate an independently detected host metadata writer. The
                # normal model mount cannot perform this write.
                (self.checkout / "a.txt").write_text("late staged work\n")
                foreign = self.root / "foreign-index"
                foreign.write_bytes((self.checkout / ".git/index").read_bytes())
                environment = {**os.environ, "GIT_INDEX_FILE": str(foreign)}
                subprocess.check_call(["git", "-C", str(self.checkout), "add", "a.txt"], env=environment)
                os.replace(foreign, self.checkout / ".git/index")
                changed.append((self.checkout / ".git/index").read_bytes())
        with self.assertRaisesRegex(MODULE.ManagedError, "source_index_cas_failed"):
            self.apply(change)
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.target)
        self.assertEqual((self.checkout / ".git/index").read_bytes(), changed[0])
        self.assertTrue(self.record()["sourceUpdating"])
        self.assertTrue(self.barrier.active)

    def test_same_content_index_still_installs_operation_owned_inode(self):
        (self.checkout / "b.txt").write_text("accepted b\n")
        git(self.checkout, "add", "b.txt")
        before = self.snapshot()
        self.apply()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.target)

    def test_replaced_checkout_and_changed_producer_cannot_recover_partial_application(self):
        def stop(phase):
            if phase == "head_applied":
                raise RuntimeError("fixture_crash")
        with self.assertRaisesRegex(RuntimeError, "fixture_crash"):
            self.apply(stop)
        old = self.checkout.with_name("preserved-checkout")
        self.checkout.rename(old)
        self.checkout.mkdir()
        with self.assertRaisesRegex(MODULE.ManagedError, "checkout_identity_changed"):
            self.apply()
        self.checkout.rmdir()
        old.rename(self.checkout)
        self.authority.value["producer"]["runtimeGeneration"] += 1
        with self.assertRaisesRegex(MODULE.ManagedError, "source_authority_changed"):
            self.apply()
        self.assertTrue(self.barrier.active)

    def test_concurrent_apply_cannot_enter_managed_writer_section_twice(self):
        conflicts = []
        def concurrent(phase):
            if phase == "prepared":
                with self.assertRaises(BlockingIOError):
                    self.apply()
                conflicts.append(True)
        self.apply(concurrent)
        self.assertEqual(conflicts, [True])
        self.assertEqual(self.barrier.completed, 1)

    def test_owned_candidate_content_tampering_cannot_become_head(self):
        def tamper(phase):
            if phase == "prepared":
                path = self.manager.state / "source-applications" / self.operation / "candidate-head"
                path.write_bytes(b"f" * 40 + b"\n")
        with self.assertRaisesRegex(MODULE.ManagedError, "source_artifact_changed"):
            self.apply(tamper)
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.base_sha)
        self.assertTrue(self.barrier.active)

    def test_checkout_replacement_after_cas_cannot_redirect_descriptor_rename(self):
        preserved = self.checkout.with_name("preserved-owned-checkout")
        def replace(phase):
            if phase == "head_cas_verified":
                self.checkout.rename(preserved)
                self.checkout.mkdir()
                (self.checkout / ".git").mkdir()
                (self.checkout / ".git/HEAD").write_text("FOREIGN_SENTINEL\n")
        with self.assertRaisesRegex(MODULE.ManagedError, "source_metadata_changed"):
            self.apply(replace)
        self.assertEqual((self.checkout / ".git/HEAD").read_text(), "FOREIGN_SENTINEL\n")
        self.assertEqual((preserved / ".git/HEAD").read_text(), self.target + "\n")
        self.assertTrue(self.barrier.active)

    def test_lost_barrier_ack_recovers_applied_metadata_from_fresh_state(self):
        def lost(phase):
            if phase == "barrier_completed":
                raise RuntimeError("fixture_lost_ack")
        with self.assertRaisesRegex(RuntimeError, "fixture_lost_ack"):
            self.apply(lost)
        self.assertIsNone(self.record()["sourceUpdating"])
        self.assertTrue(self.manager.inspect("123")["checkoutVerified"])
        self.assertEqual(self.record()["acceptedSource"], self.authority.value["sourceContext"])
        self.apply()
        self.assertNotIn("sourceUpdating", self.manager.inspect("123"))

    def test_rejected_barrier_release_cannot_turn_ready_receipt_into_execution_permission(self):
        complete = self.barrier.complete
        observations = []
        def rejected(expected, current):
            # complete runs outside the managed lock, after durable application.
            observations.append(self.manager.inspect("123"))
            self.assertTrue(self.barrier.active)
            raise RuntimeError("fixture_release_rejected")
        self.barrier.complete = rejected
        with self.assertRaisesRegex(RuntimeError, "fixture_release_rejected"):
            self.apply()
        self.assertTrue(observations[0]["checkoutVerified"])
        self.assertNotIn("sourceUpdating", observations[0])
        self.assertTrue(self.barrier.active)  # Execution still needs this authority.
        self.barrier.complete = complete
        self.apply()
        self.assertFalse(self.barrier.active)

    def test_post_unlock_fresh_receipt_rejects_released_lease(self):
        def release(phase):
            if phase == "metadata_unlocked":
                # Simulate a trusted controller mutation; ordinary release also
                # checks process references and cannot overlook our retained FDs.
                with self.manager.lock():
                    _project, path, record = self.manager.load("123")
                    record["lease"] = None
                    self.manager.write(path, record)
        with self.assertRaisesRegex(MODULE.ManagedError, "source_applied_binding_changed"):
            self.apply(release)
        self.assertEqual(self.barrier.completed, 0)
        self.assertTrue(self.barrier.active)

    def test_unjournaled_candidate_index_gap_is_preserved_for_review(self):
        def crash(phase):
            if phase == "candidate_index_written":
                raise RuntimeError("fixture_crash")
        with self.assertRaisesRegex(RuntimeError, "fixture_crash"):
            self.apply(crash)
        candidate = self.manager.state / "source-applications" / self.operation / "candidate-index"
        preserved = candidate.read_bytes()
        with self.assertRaisesRegex(MODULE.ManagedError, "source_artifact_changed"):
            self.apply()
        self.assertEqual(candidate.read_bytes(), preserved)
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.base_sha)
        self.assertTrue(self.barrier.active)

    def test_busy_input_corrupt_objects_and_unsupported_staging_never_apply(self):
        self.barrier.busy = True
        with self.assertRaisesRegex(MODULE.ManagedError, "fixture_input_not_quiescent"):
            self.apply()
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.base_sha)
        self.barrier.busy = False
        self.objects.corrupt = True
        with self.assertRaisesRegex(MODULE.ManagedError, "source_object_invalid"):
            self.apply()
        self.objects.corrupt = False
        git(self.checkout, "update-index", "--assume-unchanged", "a.txt")
        with self.assertRaisesRegex(MODULE.ManagedError, "source_index_unsupported"):
            self.apply()
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), self.base_sha)

    def test_cleanup_and_prepare_cannot_reinterpret_accepted_head_as_physical_base(self):
        self.apply()
        with self.assertRaisesRegex(MODULE.ManagedError, "accepted_source_prepare_unavailable"):
            self.manager.prepare("123", "fixture-task", self.base_sha)
        with self.assertRaisesRegex(MODULE.ManagedError, "accepted_source_cleanup_unavailable"):
            self.manager.request_cleanup("123", "fixture-task")
        self.assertEqual(self.record()["revision"], self.base_sha)

    def test_renewal_checks_base_and_accepted_source_separately(self):
        self.apply()
        seen = []
        class Authority:
            def verify(_self, project, expected):
                self.assertEqual(project, self.project)
                seen.append(copy.deepcopy(expected))
        self.manager._renew_controller_lease("123", self.project, Authority())
        self.assertEqual(seen[0]["revision"], self.base_sha)
        self.assertEqual(seen[0]["currentSource"], self.authority.value["sourceContext"])
        self.assertEqual(self.record()["revision"], self.base_sha)

    def test_two_source_advances_keep_one_physical_base_and_all_user_work(self):
        self.user_work()
        before = self.snapshot()
        first = self.apply()["acceptedSource"]
        producer = copy.deepcopy(self.authority.value["producer"])
        (self.source / "b.txt").write_text("second accepted b\n")
        git(self.source, "add", "b.txt")
        git(self.source, "commit", "-m", "feat: second accepted fixture")
        self.target = git(self.source, "rev-parse", "HEAD")
        self.operation = str(uuid.uuid4())
        self.authority = FixtureAuthority(self)
        self.authority.value["sourceContext"]["version"] = 2
        self.authority.value["previousSourceContext"] = first
        self.authority.value["parentSha"] = first["headSha"]
        self.authority.value["producer"] = {**producer, "barrierGeneration": 1}
        self.barrier = FixtureBarrier()
        result = self.apply()
        self.assertEqual(result["acceptedSource"]["version"], 2)
        self.assertEqual(result["revision"], self.base_sha)
        self.assertEqual(result["lease"], self.prepared["lease"])
        self.assertEqual(self.snapshot(), before)

    def test_unmerged_intent_to_add_and_split_index_are_retained_for_review(self):
        for kind in ("unmerged", "intent-to-add", "split-index"):
            with self.subTest(kind=kind):
                fixture = ManagedSourceApplyTests()
                fixture.setUp()
                try:
                    if kind == "unmerged":
                        oid = git(fixture.checkout, "rev-parse", "HEAD:a.txt")
                        payload = f"0 {'0' * 40}\ta.txt\n100644 {oid} 1\ta.txt\n100644 {oid} 2\ta.txt\n"
                        subprocess.run(["git", "-C", str(fixture.checkout), "update-index", "--index-info"], input=payload.encode(), check=True)
                    elif kind == "intent-to-add":
                        (fixture.checkout / "intent").write_text("not staged\n")
                        git(fixture.checkout, "add", "-N", "intent")
                    else:
                        git(fixture.checkout, "update-index", "--split-index")
                    original = (fixture.checkout / ".git/index").read_bytes()
                    with self.assertRaisesRegex(MODULE.ManagedError, "source_index_unsupported"):
                        fixture.apply()
                    self.assertEqual((fixture.checkout / ".git/index").read_bytes(), original)
                    self.assertEqual(git(fixture.checkout, "rev-parse", "HEAD"), fixture.base_sha)
                    self.assertTrue(fixture.barrier.active)
                finally:
                    fixture.doCleanups()

    @unittest.skipUnless(os.environ.get("HIVE_TEST_SOURCE_APPLY_SCALE") == "1", "explicit bounded real-home scale probe")
    def test_hive_scale_1977_files_297_directories(self):
        import json
        source_paths = [Path(MODULE.__file__), Path(MODULE.__file__).with_name("managed-source-apply.py"),
                        Path(MODULE.__file__).with_name("codex-project-lease.py")]
        source_hashes = {str(path.relative_to(Path.cwd())): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_paths}
        scale = tempfile.TemporaryDirectory(prefix=".source-scale-", dir=Path.cwd())
        self.addCleanup(scale.cleanup)
        root = Path(scale.name)
        self.home, self.source = root / "home", root / "source"
        self.home.mkdir()
        self.source.mkdir()
        git(self.source, "init", "-b", "main")
        for i in range(1977):
            directory = self.source / f"d{i % 297}"
            directory.mkdir(exist_ok=True)
            (directory / f"f{i}.txt").write_text(f"fixture {i}\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "-m", "test: scale base")
        self.base_sha = git(self.source, "rev-parse", "HEAD")
        self.bare = root / "remote.git"
        git(root, "clone", "--bare", str(self.source), str(self.bare))
        self.manager = MODULE.ManagedProjects(self.home, FixtureResolver(), FixtureGit(self.bare))
        self.prepared = self.manager.prepare("123", "fixture-task", self.base_sha)
        self.checkout = Path(self.prepared["checkoutDirectory"])
        (self.source / "d0/f0.txt").write_text("accepted change\n")
        git(self.source, "add", "d0/f0.txt")
        git(self.source, "commit", "-m", "feat: scale accepted change")
        self.target = git(self.source, "rev-parse", "HEAD")
        self.authority = FixtureAuthority(self)
        self.barrier = FixtureBarrier()
        self.objects = FixtureObjects(self.source)
        started = time.monotonic()
        result = {"schemaVersion": 1, "files": 1977, "directories": 297, "realHomeFilesystem": True,
                  "accountInference": False, "providerWrites": False, "passed": False}
        try:
            self.apply()
            result["passed"] = True
        except Exception as error:
            result["errorCategory"] = str(error) if isinstance(error, MODULE.ManagedError) else type(error).__name__
            raise
        finally:
            result["applySeconds"] = round(time.monotonic() - started, 3)
            result["sourceHashes"] = source_hashes
            result["sourceStable"] = all(hashlib.sha256((Path.cwd() / path).read_bytes()).hexdigest() == digest
                                         for path, digest in source_hashes.items())
            path = os.environ.get("HIVE_SOURCE_APPLY_SCALE_EVIDENCE")
            if path:
                with open(path, "x") as stream:
                    json.dump(result, stream, indent=2)
                    stream.write("\n")


if __name__ == "__main__":
    unittest.main()
