"""Real Git plumbing and fake HTTP only; no credentials or provider effects."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import uuid

FIXTURE_SPEC = importlib.util.spec_from_file_location("hive_broker_fixture_test", Path(__file__).with_name("test_delivery_source_broker.py"))
FIXTURE = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(FIXTURE)
FakeGitHub = FIXTURE.FakeGitHub

SOURCE = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/delivery-source-runtime.py"
SPEC = importlib.util.spec_from_file_location("hive_source_runtime_test", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response:
    def __init__(self, url, status, value):
        self.url, self.status, self.headers = url, status, {}
        self.raw = io.BytesIO(json.dumps(value).encode())
    def __enter__(self): return self
    def __exit__(self, *_args): self.raw.close()
    def geturl(self): return self.url
    def read1(self, limit): return self.raw.read(limit)


class ProtectedBrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hive-protected-source-test-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.workspace, self.private = root / "checkout", root / "private"
        self.workspace.mkdir()
        self.git("init", "--template=")
        (self.workspace / "src").mkdir()
        (self.workspace / "src/main.txt").write_bytes(b"base\n")
        (self.workspace / "README.md").write_bytes(b"inherited untouched\n")
        self.git("add", "src/main.txt", "README.md")
        self.git("-c", "user.name=Initial", "-c", "user.email=initial@example.invalid", "commit", "-m", "test: base")
        parent = self.git("rev-parse", "HEAD").strip().decode()
        self.scope = {k: str(uuid.uuid4()) for k in ("ownerId", "taskId", "managerBindingId", "attemptId", "leaseId", "checkoutIncarnation")}
        self.scope.update(repositoryId="123", providerAccountId="456", fullName="fixture/source", baseBranch="main", parentSha=parent,
                          sourceVersion=0, serverInstanceId="native-fixture", leaseGeneration=1)
        self.now = 1793232000
        self.policy = {"version": "test-v1", "authorName": "Hive", "authorEmail": "codex@kethalia.com", "baseBranch": "main",
                       "allowedPrefixes": ["src", "tests", "docs"], "maxFiles": 5, "maxFileBytes": 1024, "maxBytes": 2048}
        self.identity = {}
        for key, path in (("checkout", self.workspace), ("git", self.workspace / ".git")):
            info = path.stat()
            self.identity[key] = {"device": info.st_dev, "inode": info.st_ino}
        self.metadata_open, self.grant_open, self.grant_calls = True, True, 0
        self.b = self.construct()
        self.imported = self.b.import_parent()
        (self.workspace / "src/main.txt").write_bytes(b"sealed raw\r\nsource\n")
        self.request = {"operationId": str(uuid.uuid4()), "paths": ["src/main.txt"], "deletions": [],
                        "message": "feat(source): protected publication", "title": "feat(source): bounded test", "body": "local only"}
        self.receipt = self.b.prepare(self.request)
        material = self.b.challenge_material(self.request["operationId"])
        self.grant = {**{k: self.scope[k] for k in ("ownerId", "taskId", "managerBindingId", "attemptId", "repositoryId", "providerAccountId",
                                                    "fullName", "parentSha", "sourceVersion", "leaseGeneration")},
                      "schemaVersion": 1, "action": "publish_source_revision", "id": str(uuid.uuid4()), "nonce": "d" * 64,
                      "expiresAt": self.now * 1000 + 60000, "operationId": self.request["operationId"], "branch": self.receipt["branch"],
                      "policy": self.policy, "policyDigest": material["policyDigest"], "target": material["target"],
                      "admission": {"checkoutIncarnation": self.scope["checkoutIncarnation"]}}
        self.grant["leaseGeneration"] = 3  # Attempt lease differs from physical checkout lease.
        self.remote = FakeGitHub(self.scope)
        self.effects = []
        class Opener:
            def open(_self, request, timeout):
                self.effects.append(request.full_url)
                self.assertEqual(request.headers["Authorization"], "Bearer synthetic-not-a-credential")
                try:
                    status, value = self.remote.request(request.method, request.full_url,
                                                       json.loads(request.data) if request.data is not None else None, {})
                except Exception:
                    raise OSError("synthetic lost acknowledgment") from None
                return Response(request.full_url, status, value)
        self.opener = Opener()
        self.addCleanup(patch.stopall)
        patch.object(MODULE.auth, "external_token", return_value="synthetic-not-a-credential").start()
        patch.object(MODULE.urllib.request, "build_opener", return_value=self.opener).start()

    def git(self, *args):
        return subprocess.check_output(["/usr/bin/git", *args], cwd=self.workspace, stderr=subprocess.DEVNULL,
                                       env={"PATH": "/usr/bin:/bin", "HOME": self.temp.name, "GIT_CONFIG_NOSYSTEM": "1",
                                            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"})

    def metadata(self):
        if not self.metadata_open:
            raise MODULE.PublicationHold("metadata_revoked")
        return self.identity

    def authorize(self):
        self.grant_calls += 1
        if not self.grant_open:
            raise MODULE.PublicationHold("grant_revoked")
        return self.grant

    def construct(self):
        return MODULE.ProtectedSourceBroker(self.private, self.workspace, self.scope, policy=self.policy,
                                            metadata_identity=self.identity, metadata_authority=self.metadata, attempt_lease_generation=3, clock=lambda: self.now)

    def publish(self):
        return self.b.publish_authorized(self.request["operationId"], self.grant, self.authorize)

    def test_exact_parent_import_without_inherited_blobs_and_trusted_author(self):
        self.assertEqual(self.imported["parentSha"], self.scope["parentSha"])
        self.assertEqual(self.imported["trees"], 2)
        self.assertLess(self.imported["bytes"], 1000)
        raw = self.b._git(["cat-file", "commit", self.receipt["commitSha"]])
        self.assertIn(b"author Hive <codex@kethalia.com>", raw)
        self.assertNotIn(b"fixture@example.invalid", raw)
        inherited = self.git("rev-parse", "HEAD:README.md").strip().decode()
        with self.assertRaisesRegex(MODULE.PublicationHold, "git_failed"):
            self.b._git(["cat-file", "blob", inherited])
        self.assertIn(inherited.encode(), self.b._git(["ls-tree", "-r", self.receipt["commitSha"]]))
        self.assertEqual(self.b._git(["show", self.receipt["commitSha"] + ":src/main.txt"]), b"sealed raw\r\nsource\n")

    def test_real_composition_has_no_fixture_or_unguarded_publish_path(self):
        self.assertFalse(hasattr(self.b, "seed_fixture_parent"))
        self.assertFalse(self.receipt["fixtureOnly"])
        self.assertFalse(self.receipt["freshAcceptanceAuthority"])
        with self.assertRaisesRegex(MODULE.PublicationHold, "authority_required"):
            self.b.publish(self.request["operationId"], None)

    def test_publish_fresh_readbacks_and_historical_replay_do_not_resend(self):
        (self.workspace / "src/main.txt").write_text("edited later")
        result = self.publish()
        self.assertEqual(result["phase"], "published")
        self.assertEqual(MODULE.auth.external_token.call_count, 1)
        self.assertGreaterEqual(self.grant_calls, len(self.effects) * 2)
        before = len(self.effects)
        self.assertEqual(self.publish(), result)
        self.assertEqual(len(self.effects), before)
        readback = self.b.fresh_readback(self.request["operationId"], self.grant, self.authorize)
        self.assertEqual(MODULE.auth.external_token.call_count, 2)
        self.assertEqual(readback["commit"]["sha"], self.receipt["commitSha"])
        self.assertEqual(readback["manifest"], {"files": self.b.load(self.request["operationId"])["manifest"], "deletions": []})
        self.assertTrue(readback["pullRequest"]["draft"])
        self.assertNotIn("synthetic-not-a-credential", json.dumps(readback))

    def test_revoked_admission_before_provider_auth_or_effect_is_held(self):
        self.grant_open = False
        self.assertEqual(self.publish()["heldReason"], "grant_revoked")
        MODULE.auth.external_token.assert_not_called()
        self.assertEqual(self.effects, [])

    def test_revoke_during_token_fetch_prevents_effect(self):
        def revoke():
            self.grant_open = False
            return "synthetic-not-a-credential"
        MODULE.auth.external_token.side_effect = revoke
        self.assertEqual(self.publish()["heldReason"], "grant_revoked")
        self.assertEqual(self.effects, [])

    def test_connected_account_change_cannot_change_credential_between_identity_and_effect(self):
        MODULE.auth.external_token.side_effect = ["synthetic-not-a-credential", "different-account-token"]
        result = self.publish()
        self.assertEqual(result["phase"], "published")
        self.assertEqual(MODULE.auth.external_token.call_count, 1)
        # Every synthetic HTTP request asserts the original exact bearer token.
        self.assertGreater(len(self.effects), 5)

    def test_expiry_or_changed_target_prevents_effect(self):
        self.grant["target"]["headSha"] = "a" * 40
        with self.assertRaisesRegex(MODULE.PublicationHold, "grant_mismatch"):
            self.publish()
        self.grant["target"]["headSha"] = self.receipt["commitSha"]
        self.now += 60
        self.assertEqual(self.publish()["heldReason"], "publication_grant_expired")
        self.assertEqual(self.effects, [])

    def test_metadata_revocation_and_checkout_swap_rejected(self):
        self.metadata_open = False
        with self.assertRaisesRegex(MODULE.PublicationHold, "metadata_revoked"):
            self.b.prepare(self.request)
        self.metadata_open = True
        original = self.workspace.with_name("original")
        self.workspace.rename(original)
        self.workspace.mkdir()
        with self.assertRaisesRegex(MODULE.PublicationHold, "metadata_identity_changed"):
            self.b.import_parent()
        self.assertEqual(self.effects, [])

    def test_policy_bounds_apply_before_sealing(self):
        request = {**self.request, "operationId": str(uuid.uuid4())}
        (self.workspace / "src/main.txt").write_bytes(b"x" * 1025)
        with self.assertRaisesRegex(MODULE.PublicationHold, "source_file_type_or_size"):
            self.b.prepare(request)
        self.assertEqual(self.effects, [])

    def test_lost_ref_and_pr_ack_recover_by_readback_without_repeating_post(self):
        prefix = "/repos/" + self.scope["fullName"]
        for suffix in ("/git/refs", "/pulls"):
            with self.subTest(suffix=suffix):
                operation_id = str(uuid.uuid4())
                request = {**self.request, "operationId": operation_id}
                receipt = self.b.prepare(request)
                grant = {**self.grant, "operationId": operation_id, "branch": receipt["branch"],
                         "target": self.b.challenge_material(operation_id)["target"]}
                self.remote.loss = prefix + suffix
                result = self.b.publish_authorized(operation_id, grant, lambda: grant)
                self.assertEqual(result["phase"], "published")
                posts = [body for method, url, body in self.remote.calls
                         if method == "POST" and url.endswith(suffix)
                         and (body.get("head") == receipt["branch"] or body.get("ref") == "refs/heads/" + receipt["branch"])]
                self.assertEqual(len(posts), 1)
                self.remote.prs.clear()  # Fake provider uses fixed PR number; isolated subcase.

    def test_readback_clock_starts_before_provider_observation(self):
        self.assertEqual(self.publish()["phase"], "published")
        original = self.opener.open
        def slow(request, timeout):
            result = original(request, timeout)
            self.now += 3
            return result
        with patch.object(self.opener, "open", side_effect=slow):
            with self.assertRaisesRegex(MODULE.PublicationHold, "provider_readback_stale"):
                self.b.fresh_readback(self.request["operationId"], self.grant, self.authorize)

    def test_partial_remote_effects_remain_held_after_revocation(self):
        original = self.opener.open
        def revoke_after_blob(request, timeout):
            result = original(request, timeout)
            if request.full_url.endswith("/git/blobs"):
                self.grant_open = False
            return result
        with patch.object(self.opener, "open", side_effect=revoke_after_blob):
            result = self.publish()
        self.assertEqual(result["phase"], "held")
        self.assertEqual(result["heldReason"], "grant_revoked")
        self.assertFalse(self.remote.refs)
        self.assertFalse(self.remote.prs)
        calls = len(self.effects)
        self.grant_open = True
        self.assertEqual(self.publish(), result)
        self.assertEqual(calls, len(self.effects))

    def test_parent_alternate_and_symlink_are_rejected(self):
        alternate = self.workspace / ".git/objects/info/alternates"
        alternate.write_text("/tmp/untrusted\n")
        with self.assertRaisesRegex(MODULE.PublicationHold, "parent_storage_unsupported"):
            self.b.import_parent()
        alternate.unlink()
        (self.workspace / "link").symlink_to("README.md")
        self.git("add", "link")
        self.git("-c", "user.name=Initial", "-c", "user.email=initial@example.invalid", "commit", "-m", "test: symlink")
        self.b.scope["parentSha"] = self.git("rev-parse", "HEAD").strip().decode()
        with self.assertRaisesRegex(MODULE.PublicationHold, "parent_storage_unsupported"):
            self.b.import_parent()

    def test_fixed_transport_rejects_redirect_arbitrary_repo_and_methods(self):
        transport = MODULE.AgentGitHubTransport("fixture/source", self.authorize)
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"}
        for method, url, body in (("GET", "https://evil.invalid/user", None),
                                  ("GET", "https://api.github.com/repos/other/private", None),
                                  ("PATCH", "https://api.github.com/repos/fixture/source/git/refs", {}),
                                  ("POST", "https://api.github.com/repos/fixture/source/hooks", {})):
            with self.assertRaisesRegex(MODULE.PublicationHold, "provider_path_invalid"):
                transport(method, url, body, headers)
        with patch.object(self.opener, "open", side_effect=urllib.error.HTTPError(
                "https://api.github.com/user", 302, "secret error text", {}, io.BytesIO(b"secret"))):
            self.assertEqual(transport("GET", "https://api.github.com/user", None, headers), (302, {}))
        self.assertEqual(self.effects, [])


if __name__ == "__main__":
    unittest.main()
