import hashlib
import hmac
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/managed-projects.py"
SPEC = importlib.util.spec_from_file_location("managed_projects", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
URL = "https://github.com/owner/repository.git"


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", *args], stderr=subprocess.DEVNULL).decode().strip()


class FixtureResolver:
    def resolve(self, repository_id):
        return MODULE.VerifiedRepository(repository_id, URL)


class FixtureGit(MODULE.GitDriver):
    """Explicit in-process injection only; cannot be selected by CLI or environment."""
    def __init__(self, bare):
        self.bare = bare
        self.fail_clone_once = False

    def run(self, cwd, args, repository=None):
        if args[0] == "clone" and self.fail_clone_once:
            self.fail_clone_once = False
            raise MODULE.ManagedError("fixture_interrupted_clone")
        command = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "init.templateDir="]
        if args[0] in {"clone", "fetch"}:
            command += ["-c", "protocol.file.allow=always", "-c", f"url.{self.bare}.insteadOf={URL}"]
        return self.execute(command + args, cwd, {"PATH": os.environ["PATH"], "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"})


class TestControllerAuthority:
    """Independent fixture issuer, not a completion assertion accepted by the CLI."""
    def __init__(self):
        self.key = os.urandom(32)

    def signature(self, payload):
        return hmac.new(self.key, json.dumps(payload, sort_keys=True).encode(), hashlib.sha256).hexdigest()

    def issue(self, record):
        binding = {"repositoryId": record["repositoryId"], "taskId": record["lastTaskId"], "revision": record["revision"], "projectIdentity": record["projectIdentity"], "checkoutIdentity": record["checkoutIdentity"], "checkoutIncarnation": record["checkoutIncarnation"], "leaseGeneration": record["leaseGeneration"], "cleanupRequestId": record["cleanupRequests"][-1]["id"]}
        digest = "sha256:" + "a" * 64
        payload = {"binding": binding, "completionEventId": "controller-completion-1", "policyVersion": "reviewed-policy-1", "artifact": {"digest": digest, "objectVersion": "immutable-r2-version-1"}, "productionObservation": {"id": "independently-queried-observation-1", "revision": record["revision"], "artifactDigest": digest}}
        return {"payload": payload, "signature": self.signature(payload)}

    def verify(self, envelope, expected):
        if not hmac.compare_digest(envelope.get("signature", ""), self.signature(envelope.get("payload"))):
            raise MODULE.ManagedError("controller_signature_invalid")
        payload = envelope["payload"]
        MODULE.require(payload["binding"] == expected, "controller_binding_mismatch")
        return payload


class ManagedProjectsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hive-managed-test-")
        self.base = Path(self.temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.source = self.base / "source"
        self.source.mkdir()
        git(self.source, "init", "-b", "main")
        (self.source / "README.md").write_text("fixture\n")
        (self.source / ".gitignore").write_text("*.cache\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "-m", "test: fixture")
        self.sha = git(self.source, "rev-parse", "HEAD")
        self.bare = self.base / "remote.git"
        git(self.base, "clone", "--bare", str(self.source), str(self.bare))
        self.backend = FixtureGit(self.bare)
        self.manager = MODULE.ManagedProjects(self.home, FixtureResolver(), self.backend)
        self.authority = TestControllerAuthority()
        # CI may host unrelated same-UID nondumpable processes. Enumerate only
        # this fixture's real process and explicitly tracked real children.
        # Production still scans all of /proc and fails closed on PermissionError.
        self.process_ids = {os.getpid()}
        original_iterdir = Path.iterdir
        def fixture_iterdir(path):
            if path == Path("/proc"):
                return iter(Path("/proc") / str(pid) for pid in self.process_ids)
            return original_iterdir(path)
        process_patch = mock.patch.object(Path, "iterdir", fixture_iterdir)
        process_patch.start()
        self.addCleanup(process_patch.stop)

    def tearDown(self):
        self.temporary.cleanup()

    def prepare(self, **kwargs):
        return self.manager.prepare("123", "task-one", self.sha, **kwargs)

    def release(self, prepared, sha=None):
        lease = prepared["lease"]
        return self.manager.release_lease("123", lease["taskId"], lease["id"], lease["generation"], sha or self.sha)

    def evidence(self):
        with self.manager.lock():
            _, _, record = self.manager.load("123")
            return self.authority.issue(record)

    def cleanup(self, envelope=None):
        return self.manager._remove_with_authority("123", "task-one", envelope or self.evidence(), self.authority)

    def retired_ready(self):
        prepared = self.prepare()
        self.release(prepared)
        self.manager.request_cleanup("123", "task-one")
        return Path(prepared["checkoutDirectory"])

    def test_prepares_exact_revision_reuses_and_rejects_other_writer(self):
        first = self.prepare()
        checkout = Path(first["checkoutDirectory"])
        self.assertEqual(git(checkout, "rev-parse", "HEAD"), self.sha)
        inode = checkout.stat().st_ino
        lease = first["lease"]
        second = self.prepare(lease_id=lease["id"], generation=lease["generation"])
        self.assertEqual(checkout.stat().st_ino, inode)
        self.assertGreater(second["lease"]["generation"], lease["generation"])
        with self.assertRaisesRegex(MODULE.ManagedError, "writer_busy"):
            self.manager.prepare("123", "task-two", self.sha)
        with self.assertRaisesRegex(MODULE.ManagedError, "stale_lease"):
            self.release(first)

    def test_existing_primary_clone_and_native_history_are_never_owned(self):
        primary = self.home / "projects/owner/repository"
        primary.mkdir(parents=True)
        (primary / "user-work").write_text("keep")
        history = self.home / ".codex/sessions"
        history.mkdir(parents=True)
        (history / "native-history").write_text("keep")
        self.prepare()
        self.assertEqual((primary / "user-work").read_text(), "keep")
        self.assertEqual((history / "native-history").read_text(), "keep")
        with self.assertRaisesRegex(MODULE.ManagedError, "invalid_request"):
            MODULE.dispatch(self.manager, {"schemaVersion": 1, "operation": "prepare", "provider": "github", "repositoryId": "123", "taskId": "x", "revision": self.sha, "path": str(primary)})

    def test_interrupted_clone_preserves_stage_and_recovers_from_signed_attempt(self):
        self.backend.fail_clone_once = True
        with self.assertRaisesRegex(MODULE.ManagedError, "interrupted_clone"):
            self.prepare()
        interrupted = self.manager.inspect("123")
        stage = Path(interrupted["projectDirectory"]) / interrupted["preservedStages"][0]
        (stage / "interruption-evidence").write_text("keep")
        lease = interrupted["lease"]
        completed = self.prepare(lease_id=lease["id"], generation=lease["generation"])
        self.assertEqual(completed["status"], "ready")
        self.assertEqual((stage / "interruption-evidence").read_text(), "keep")

    def test_publish_interruption_recovers_without_duplicate_clone(self):
        original = os.rename
        def interrupted_rename(source, destination):
            original(source, destination)
            raise OSError("fixture death after atomic publish")
        with mock.patch.object(MODULE.os, "rename", side_effect=interrupted_rename):
            with self.assertRaises(OSError):
                self.prepare()
        interrupted = self.manager.inspect("123")
        lease = interrupted["lease"]
        completed = self.prepare(lease_id=lease["id"], generation=lease["generation"])
        self.assertEqual(completed["status"], "ready")
        with self.manager.lock():
            self.assertEqual(len(self.manager.load("123")[2]["stages"]), 1)

    def test_cleanup_cli_never_accepts_completion_boolean_or_deletes(self):
        prepared = self.prepare()
        result = self.manager.request_cleanup("123", "task-one")
        self.assertEqual(result["status"], "controller_authority_unavailable")
        self.assertTrue(Path(prepared["checkoutDirectory"]).exists())
        with self.assertRaisesRegex(MODULE.ManagedError, "invalid_request"):
            MODULE.dispatch(self.manager, {"schemaVersion": 1, "provider": "github", "repositoryId": "123", "operation": "requestCleanup", "taskId": "task-one", "productionPassed": True})

    def test_trusted_fixture_removal_preserves_project_evidence_and_can_rehydrate(self):
        checkout = self.retired_ready()
        project = checkout.parent
        self.cleanup()
        self.assertFalse(checkout.exists())
        self.assertTrue((project / "evidence/controller-completion-1.json").is_file())
        self.assertEqual(self.manager.inspect("123")["status"], "checkout_removed")
        restored = self.prepare()
        self.assertEqual(git(Path(restored["checkoutDirectory"]), "rev-parse", "HEAD"), self.sha)
        self.release(restored)
        with self.assertRaisesRegex(MODULE.ManagedError, "request_stale"):
            self.cleanup()

    def test_released_checkout_fetches_new_exact_revision_without_losing_old_commit(self):
        prepared = self.prepare()
        self.release(prepared)
        (self.source / "README.md").write_text("next revision")
        git(self.source, "add", ".")
        git(self.source, "commit", "-m", "test: next revision")
        sha = git(self.source, "rev-parse", "HEAD")
        git(self.source, "push", str(self.bare), "main")
        resumed = self.manager.prepare("123", "task-two", sha)
        self.assertEqual(git(Path(resumed["checkoutDirectory"]), "rev-parse", "HEAD"), sha)

    def test_reused_inode_cannot_revive_old_checkout_cleanup_authority(self):
        # Deterministically model a filesystem reusing the same device/inode.
        # Production identity checks are unchanged; nonce authority must suffice.
        with mock.patch.object(self.manager, "identity", return_value={"device": 1, "inode": 2}):
            checkout = self.retired_ready()
            old_evidence = self.evidence()
            self.cleanup(old_evidence)
            restored = self.prepare()
            self.release(restored)
            with self.manager.lock():
                record = self.manager.load("123")[2]
                self.assertEqual(record["checkoutIdentity"], old_evidence["payload"]["binding"]["checkoutIdentity"])
                self.assertNotEqual(record["checkoutIncarnation"], old_evidence["payload"]["binding"]["checkoutIncarnation"])
            with self.assertRaisesRegex(MODULE.ManagedError, "request_stale"):
                self.cleanup(old_evidence)
            self.manager.request_cleanup("123", "task-one")
            with self.assertRaisesRegex(MODULE.ManagedError, "controller_binding_mismatch"):
                self.cleanup(old_evidence)
            self.assertTrue(checkout.exists())

    def test_new_lease_invalidates_cleanup_request_without_replacing_checkout(self):
        checkout = self.retired_ready()
        old_evidence = self.evidence()
        restored = self.prepare()
        self.release(restored)
        with self.assertRaisesRegex(MODULE.ManagedError, "request_stale"):
            self.cleanup(old_evidence)
        self.assertTrue(checkout.exists())

    def test_feature_branch_push_upstream_release_and_cleanup(self):
        prepared = self.prepare()
        checkout = Path(prepared["checkoutDirectory"])
        git(checkout, "switch", "-c", "codex/feature")
        (checkout / "feature").write_text("completed feature")
        git(checkout, "add", ".")
        git(checkout, "commit", "-m", "test: feature")
        sha = git(checkout, "rev-parse", "HEAD")
        git(checkout, "-c", f"url.{self.bare}.insteadOf={URL}", "push", "-u", "origin", "codex/feature")
        self.release(prepared, sha)
        self.manager.request_cleanup("123", "task-one")
        self.cleanup()
        self.assertFalse(checkout.exists())

    def test_upstream_allowance_rejects_execution_transport_and_ambiguous_config(self):
        prepared = self.prepare()
        checkout = Path(prepared["checkoutDirectory"])
        config = checkout / ".git/config"
        original = config.read_text()
        additions = [
            '[include]\npath = /does/not/exist\n',
            '[includeIf "gitdir:*"]\npath = /does/not/exist\n',
            '[credential]\nhelper = !echo forbidden\n',
            '[core]\nhooksPath = /tmp/forbidden\n',
            '[core]\nfsmonitor = !echo forbidden\n',
            '[filter "unsafe"]\nsmudge = echo forbidden\n',
            '[remote "origin"]\nurl = https://github.com/other/repository.git\n',
            '[remote "origin"]\npushurl = https://github.com/other/repository.git\n',
            '[branch "feature"]\nremote = other\nmerge = refs/heads/feature\n',
            '[branch "feature"]\nremote = origin\nmerge = refs/tags/feature\n',
            '[branch "feature"]\nremote = origin\nmerge = refs/heads/feature\nmerge = refs/heads/other\n',
            '[branch "feature"]\nremote = origin\n',
            '[branch "../escape"]\nremote = origin\nmerge = refs/heads/feature\n',
            '[branch "feature"]\nremote = origin\nmerge = refs/heads/feature\nrebase = true\n',
        ]
        for addition in additions:
            with self.subTest(addition=addition):
                config.write_text(original + "\n" + addition)
                with self.assertRaisesRegex(MODULE.ManagedError, "git_configuration_changed"):
                    self.release(prepared)
        config.write_text(original)
        self.release(prepared)

    def test_active_dirty_task_inspection_preserves_lease_and_edits(self):
        prepared = self.prepare()
        checkout = Path(prepared["checkoutDirectory"])
        (checkout / "README.md").write_text("unfinished work")
        inspected = self.manager.inspect("123")
        self.assertEqual(inspected["lease"], prepared["lease"])
        lease = inspected["lease"]
        with self.assertRaisesRegex(MODULE.ManagedError, "checkout_has_work"):
            self.prepare(lease_id=lease["id"], generation=lease["generation"])
        self.assertEqual((checkout / "README.md").read_text(), "unfinished work")
        self.assertEqual(self.manager.inspect("123")["lease"], lease)

    def test_forged_or_wrong_revision_authority_cannot_remove(self):
        checkout = self.retired_ready()
        permit = self.evidence()
        permit["payload"]["productionObservation"]["revision"] = "f" * 40
        with self.assertRaisesRegex(MODULE.ManagedError, "signature_invalid"):
            self.cleanup(permit)
        permit["signature"] = self.authority.signature(permit["payload"])
        with self.assertRaisesRegex(MODULE.ManagedError, "preservation_evidence"):
            self.cleanup(permit)
        self.assertTrue(checkout.exists())

    def test_dirty_untracked_and_ignored_work_block_cleanup(self):
        checkout = self.retired_ready()
        for path, content in [(checkout / "README.md", "changed"), (checkout / "untracked", "keep"), (checkout / "ignored.cache", "keep")]:
            path.write_text(content)
            with self.assertRaisesRegex(MODULE.ManagedError, "checkout_has_work"):
                self.cleanup()
            if path.name == "README.md":
                git(checkout, "checkout", "--", "README.md")
            else:
                path.unlink()

    def test_active_process_blocks_cleanup(self):
        checkout = self.retired_ready()
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"], cwd=checkout)
        self.process_ids.add(child.pid)
        try:
            with self.assertRaisesRegex(MODULE.ManagedError, "checkout_in_use"):
                self.cleanup()
        finally:
            child.kill()
            child.wait()
            self.process_ids.discard(child.pid)
        self.assertTrue(checkout.exists())

    def test_inaccessible_same_owner_process_blocks_cleanup(self):
        checkout = self.retired_ready()
        original = os.readlink
        def unreadable(path, *args, **kwargs):
            if Path(path) == Path(f"/proc/{os.getpid()}/cwd"):
                raise PermissionError("fixture nondumpable process")
            return original(path, *args, **kwargs)
        with mock.patch.object(MODULE.os, "readlink", side_effect=unreadable):
            with self.assertRaisesRegex(MODULE.ManagedError, "process_inspection_unavailable"):
                self.cleanup()
        self.assertTrue(checkout.exists())

    def test_inspect_verifies_checkout_provenance_without_rejecting_dirty_work(self):
        prepared = self.prepare()
        checkout = Path(prepared["checkoutDirectory"])
        (checkout / "README.md").write_text("unfinished edits")
        self.assertTrue(self.manager.inspect("123")["checkoutVerified"])
        saved = checkout.with_name("original-checkout")
        checkout.rename(saved)
        shutil.copytree(saved, checkout)
        with self.assertRaisesRegex(MODULE.ManagedError, "checkout_identity_changed"):
            self.manager.inspect("123")
        shutil.rmtree(checkout)
        saved.rename(checkout)
        git(checkout, "remote", "set-url", "origin", "https://github.com/other/repository.git")
        with self.assertRaisesRegex(MODULE.ManagedError, "git_configuration_changed"):
            self.manager.inspect("123")

    def test_open_file_reference_and_linked_worktree_block_cleanup(self):
        checkout = self.retired_ready()
        with (checkout / "README.md").open() as held:
            self.assertEqual(held.readline(), "fixture\n")
            with self.assertRaisesRegex(MODULE.ManagedError, "checkout_in_use"):
                self.cleanup()
        git(checkout, "worktree", "add", "--detach", str(self.base / "linked"), "HEAD")
        with self.assertRaisesRegex(MODULE.ManagedError, "linked_worktrees"):
            self.cleanup()

    def test_mount_and_checkout_symlink_are_retained(self):
        checkout = self.retired_ready()
        read_text = MODULE.Path.read_text
        def mounted(path, *args, **kwargs):
            if str(path) == "/proc/self/mountinfo":
                return f"1 0 0:1 / {checkout}/mounted rw - tmpfs tmpfs rw\n"
            return read_text(path, *args, **kwargs)
        with mock.patch.object(MODULE.Path, "read_text", mounted):
            with self.assertRaisesRegex(MODULE.ManagedError, "checkout_has_mount"):
                self.cleanup()
        os.rename(checkout, checkout.parent / "preserved-original")
        checkout.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(MODULE.ManagedError, "symlink_or_path_escape"):
            self.cleanup()
        self.assertEqual((self.source / "README.md").read_text(), "fixture\n")

    def test_expired_lease_does_not_authorize_another_writer(self):
        self.prepare()
        with mock.patch.object(MODULE.time, "time", return_value=10**12):
            with self.assertRaisesRegex(MODULE.ManagedError, "writer_busy"):
                self.manager.prepare("123", "task-two", self.sha)

    def test_production_git_auth_never_enters_argv_env_remote_or_owner_credentials(self):
        driver = MODULE.GitDriver()
        secret = "fixture_external_auth_secret"
        observed = {}
        def execute(command, cwd, environment):
            observed["command"] = command
            observed["environment"] = environment
            observed["askpass"] = Path(environment["GIT_ASKPASS"])
            self.assertNotIn(secret, json.dumps(command))
            self.assertNotIn(secret, json.dumps(environment))
            self.assertNotIn("CODER_SESSION_TOKEN", environment)
            self.assertNotIn("OPENAI_API_KEY", environment)
            self.assertIn("protocol.file.allow=never", command)
            self.assertIn("init.templateDir=", command)
            self.assertEqual(environment["GIT_CONFIG_GLOBAL"], os.devnull)
            return ""
        with mock.patch.dict(os.environ, {"CODER_SESSION_TOKEN": "owner-secret", "OPENAI_API_KEY": "unrelated-secret"}), mock.patch.object(driver, "execute", execute):
            driver.run(self.source, ["fetch", "origin", self.sha], MODULE.VerifiedRepository("123", URL, secret))
        self.assertFalse(observed["askpass"].exists())

    def test_unpreserved_local_commit_blocks_cleanup(self):
        prepared = self.prepare()
        checkout = Path(prepared["checkoutDirectory"])
        (checkout / "README.md").write_text("unpublished")
        git(checkout, "add", ".")
        git(checkout, "commit", "-m", "test: unpublished")
        sha = git(checkout, "rev-parse", "HEAD")
        self.release(prepared, sha)
        self.manager.request_cleanup("123", "task-one")
        with self.assertRaisesRegex(MODULE.ManagedError, "not_preserved_remotely"):
            self.cleanup()

    def test_reflog_only_commit_blocks_cleanup(self):
        checkout = self.retired_ready()
        (checkout / "local-work").write_text("unpublished work")
        git(checkout, "add", ".")
        git(checkout, "commit", "-m", "test: unpreserved reflog work")
        git(checkout, "reset", "--hard", self.sha)
        with self.assertRaisesRegex(MODULE.ManagedError, "commits_not_preserved_remotely"):
            self.cleanup()
        self.assertTrue(checkout.exists())

    def test_interrupted_stage_substitution_and_retry_budget_fail_closed(self):
        self.backend.fail_clone_once = True
        with self.assertRaises(MODULE.ManagedError):
            self.prepare()
        interrupted = self.manager.inspect("123")
        lease = interrupted["lease"]
        stage = Path(interrupted["projectDirectory"]) / interrupted["preservedStages"][0]
        saved = stage.with_name("saved-stage")
        stage.rename(saved)
        stage.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(MODULE.ManagedError, "symlink_or_path_escape"):
            self.prepare(lease_id=lease["id"], generation=lease["generation"])
        stage.unlink()
        saved.rename(stage)
        for _ in range(2):
            lease = self.manager.inspect("123")["lease"]
            self.backend.fail_clone_once = True
            with self.assertRaisesRegex(MODULE.ManagedError, "fixture_interrupted_clone"):
                self.prepare(lease_id=lease["id"], generation=lease["generation"])
        lease = self.manager.inspect("123")["lease"]
        with self.assertRaisesRegex(MODULE.ManagedError, "clone_attempt_budget_exhausted"):
            self.prepare(lease_id=lease["id"], generation=lease["generation"])
        self.assertTrue(stage.exists())

    def test_unmanaged_roots_symlinks_and_tampered_receipts_fail_closed(self):
        self.prepare()
        receipt = self.manager.state / "github-123.json"
        data = json.loads(receipt.read_text())
        data["record"]["revision"] = "f" * 40
        receipt.write_text(json.dumps(data))
        with self.assertRaisesRegex(MODULE.ManagedError, "signature_invalid"):
            self.manager.inspect("123")
        other_home = self.base / "other-home"
        (other_home / "projects").mkdir(parents=True)
        (other_home / "projects/.hive-managed").symlink_to(self.source, target_is_directory=True)
        other = MODULE.ManagedProjects(other_home, FixtureResolver(), self.backend)
        with self.assertRaisesRegex(MODULE.ManagedError, "symlink_or_path_escape"):
            other.prepare("123", "task", self.sha)
        with self.assertRaisesRegex(MODULE.ManagedError, "invalid_repository_id"):
            self.manager.inspect("../../source")

    def test_missing_inspect_is_readonly_and_does_not_adopt_existing_directory(self):
        value = self.manager.inspect("987")
        self.assertEqual(value["status"], "not_created")
        self.assertFalse((self.manager.root / "github/987").exists())
        (self.manager.root / "github/987").mkdir(parents=True)
        with self.assertRaisesRegex(MODULE.ManagedError, "unmanaged_project_exists"):
            self.manager.inspect("987")

    def test_expected_account_is_verified_with_same_agent_token_before_clone_lookup(self):
        from types import SimpleNamespace
        helper = SimpleNamespace(external_token=lambda: "fixture-private-token", github_json=mock.Mock(return_value=({"id": 789}, {})))
        spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _: None))
        with mock.patch.object(MODULE.importlib.util, "spec_from_file_location", return_value=spec), mock.patch.object(MODULE.importlib.util, "module_from_spec", return_value=helper):
            with self.assertRaisesRegex(MODULE.ManagedError, "repository_account_changed"):
                MODULE.GitHubResolver("456").resolve("123")
        helper.github_json.assert_called_once_with("fixture-private-token", "/user")


if __name__ == "__main__":
    unittest.main()
