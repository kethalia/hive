"""Free local fixture tests only. No native/GitHub credentials or live requests."""
import base64
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlparse
import uuid

SOURCE = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/delivery-source-broker.py"
SPEC = importlib.util.spec_from_file_location("hive_source_broker", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def git_object(kind, raw):
    return hashlib.sha1(kind.encode() + b" " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


class FakeGitHub:
    def __init__(self, scope):
        self.scope, self.calls, self.refs, self.prs, self.commits = scope, [], {}, [], {}
        self.loss, self.before_effect, self.mismatch, self.permission = None, False, None, True

    def request(self, method, url, body, headers):
        self.calls.append((method, url, body))
        assert urlparse(url).netloc == "api.github.com" and url.startswith("https://api.github.com/")
        assert "Authorization" not in headers  # No real credential transport exists.
        path = urlparse(url).path
        prefix = "/repos/" + self.scope["fullName"]
        if self.loss == path and self.before_effect:
            raise MODULE.UnknownOutcome("ack lost")
        if path == "/user":
            return 200, {"id": int(self.scope["providerAccountId"])}
        if path == prefix:
            return 200, {"id": int(self.scope["repositoryId"]), "full_name": self.scope["fullName"], "permissions": {"push": self.permission}}
        if method == "POST" and path.endswith("/git/blobs"):
            result = {"sha": git_object("blob", base64.b64decode(body["content"]))}
        elif method == "POST" and path.endswith("/git/trees"):
            ordered = sorted(body["tree"], key=lambda e: (e["path"] + ("/" if e["type"] == "tree" else "")).encode())
            raw = b"".join(e["mode"].lstrip("0").encode() + b" " + e["path"].encode() + b"\0" + bytes.fromhex(e["sha"]) for e in ordered)
            result = {"sha": git_object("tree", raw)}
        elif method == "POST" and path.endswith("/git/commits"):
            def actor(key):
                value = body[key]
                timestamp = str(int(datetime.fromisoformat(value["date"]).timestamp()))
                return f"{value['name']} <{value['email']}> {timestamp} +0000"
            raw = ("tree " + body["tree"] + "\n" + "".join("parent " + p + "\n" for p in body["parents"])
                   + "author " + actor("author") + "\ncommitter " + actor("committer") + "\n\n" + body["message"]).encode()
            key = git_object("commit", raw)
            self.commits[key] = {"sha": key, "tree": {"sha": body["tree"]}, "parents": [{"sha": p} for p in body["parents"]]}
            result = {"sha": key}
        elif method == "GET" and "/git/commits/" in path:
            result = self.commits.get(path.rsplit("/", 1)[-1])
            return 200, self.change(result, path)
        elif method == "POST" and path.endswith("/git/refs"):
            branch = body["ref"].removeprefix("refs/heads/")
            if branch in self.refs: return 422, {}
            self.refs[branch] = body["sha"]
            result = {"ref": body["ref"], "object": {"sha": body["sha"], "type": "commit"}}
        elif method == "GET" and "/git/ref/heads/" in path:
            branch = path.split("/git/ref/heads/", 1)[1]
            if branch not in self.refs: return 404, {}
            return 200, self.change({"ref": "refs/heads/" + branch, "object": {"type": "commit", "sha": self.refs[branch]}}, path)
        elif method == "POST" and path.endswith("/pulls"):
            result = {"id": 991, "number": 7, "head": {"repo": {"id": int(self.scope["repositoryId"])}, "ref": body["head"], "sha": self.refs[body["head"]]},
                      "base": {"repo": {"id": int(self.scope["repositoryId"])}, "ref": body["base"]}, "state": "open", "draft": True, "merged_at": None,
                      "title": body["title"], "body": body["body"]}
            self.prs.append(result)
        elif method == "GET" and path.endswith("/pulls"):
            return 200, json.loads(json.dumps(self.prs))
        elif method == "GET" and "/pulls/" in path:
            return 200, self.change(self.prs[0], path)
        else:
            raise AssertionError("unexpected fixture route")
        if self.loss == path: raise MODULE.UnknownOutcome("ack lost after effect")
        return 201, self.change(result, path)

    def change(self, value, path):
        value = json.loads(json.dumps(value))
        if self.mismatch: value = self.mismatch(value, path)
        return value


class SourceBrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hive-source-broker-fixture-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.workspace, self.store = root / "workspace", root / "private"
        (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "src/main.txt").write_bytes(b"published raw\r\nbytes\n")
        self.scope = {k: str(uuid.uuid4()) for k in ("ownerId", "taskId", "managerBindingId", "attemptId", "leaseId", "checkoutIncarnation")}
        self.scope.update(repositoryId="123", providerAccountId="456", fullName="fixture/source", baseBranch="main", parentSha="a" * 40,
                          sourceVersion=1, serverInstanceId="native-fixture", leaseGeneration=1)
        seed = self.broker()
        self.scope["parentSha"] = seed.seed_fixture_parent({"src/main.txt": b"base\n", "src/remove.txt": b"delete me\n"})
        self.b = self.broker()
        self.request = {"operationId": str(uuid.uuid4()), "paths": ["src/main.txt"], "deletions": ["src/remove.txt"],
                        "message": "feat(source): publish bounded snapshot", "title": "feat(source): fixture publication", "body": "Synthetic publication only"}
        self.remote = FakeGitHub(self.scope)

    def broker(self):
        return MODULE.SourceBrokerFixture(self.store, self.workspace, self.scope, fixture_only=True, clock=lambda: 1793232000)

    def provider(self, transport=None, scope=None):
        return MODULE.FixedGitHubFixtureProvider(scope or self.scope, transport or self.remote.request, fixture_only=True)

    def test_no_default_activation_or_network_transport(self):
        with self.assertRaisesRegex(MODULE.PublicationHold, "unactivated"):
            MODULE.SourceBrokerFixture(self.store, self.workspace, self.scope)
        with self.assertRaisesRegex(MODULE.PublicationHold, "unactivated"):
            MODULE.FixedGitHubFixtureProvider(self.scope, self.remote.request)
        with self.assertRaisesRegex(MODULE.PublicationHold, "unactivated"):
            MODULE.FixedGitHubFixtureProvider(self.scope, fixture_only=True)
        self.assertEqual(self.remote.calls, [])

    def test_raw_snapshot_and_commit_survive_later_edits_restart_and_replay(self):
        receipt = self.b.prepare(self.request)
        original = receipt["commitSha"]
        self.assertEqual(self.b._git(["show", original + ":src/main.txt"]), b"published raw\r\nbytes\n")
        self.assertNotIn(b"remove.txt", self.b._git(["ls-tree", "-r", original]))
        (self.workspace / "src/main.txt").write_text("later edit, not published")
        self.assertEqual(self.broker().prepare(self.request), receipt)
        result = self.broker().publish(self.request["operationId"], self.provider())
        self.assertEqual(result["phase"], "published")
        self.assertEqual(result["commitSha"], original)
        self.assertFalse(result["freshAcceptanceAuthority"])
        blobs = [base64.b64decode(body["content"]) for method, url, body in self.remote.calls if method == "POST" and url.endswith("/git/blobs")]
        self.assertEqual(blobs, [b"published raw\r\nbytes\n"])
        before = len(self.remote.calls)
        self.assertEqual(self.b.publish(self.request["operationId"], self.provider()), result)
        self.assertEqual(before, len(self.remote.calls))  # Historical receipt only.

    def test_deterministic_commit_and_changed_request_conflict(self):
        first = self.b.prepare(self.request)
        another = {**self.request, "operationId": str(uuid.uuid4())}
        self.assertEqual(self.b.prepare(another)["commitSha"], first["commitSha"])
        with self.assertRaisesRegex(MODULE.PublicationHold, "replay_conflict"):
            self.b.prepare({**self.request, "message": "fix: changed content"})
        self.assertEqual(self.remote.calls, [])

    def test_source_callbacks_and_inherited_git_environment_never_execute(self):
        marker = Path(self.temp.name) / "executed"
        metadata = self.workspace / ".git"; metadata.mkdir()
        (metadata / "config").write_text(f"[core]\nhooksPath={marker}\nfsmonitor=!touch {marker}\n[filter \"pwn\"]\nclean=touch {marker}\n[include]\npath={marker}\n")
        (self.workspace / ".gitattributes").write_text("* filter=pwn diff=pwn\n")
        with patch.dict(os.environ, {"GIT_DIR": str(metadata), "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.fsmonitor", "GIT_CONFIG_VALUE_0": "!touch " + str(marker), "GIT_EXTERNAL_DIFF": str(marker)}):
            result = self.b.prepare(self.request)
        self.assertEqual(result["phase"], "prepared")
        self.assertFalse(marker.exists())
        (self.store / "repo.git/config").write_text("[include]\npath=/forbidden\n")
        with self.assertRaisesRegex(MODULE.PublicationHold, "configuration_changed"):
            self.b.prepare({**self.request, "operationId": str(uuid.uuid4())})

    def test_protected_paths_and_scope_override_rejected(self):
        for path in ("../secret", "/etc/passwd", "src/../private", "src/.git/config", "src/.env", "docs/key.pem", ".github/workflows/check.yml", "src/.gitmodules", "src/.gitattributes"):
            with self.subTest(path=path), self.assertRaises(MODULE.PublicationHold):
                self.b.prepare({**self.request, "paths": [path]})
        with self.assertRaisesRegex(MODULE.PublicationHold, "request_invalid"):
            self.b.prepare({**self.request, "repositoryId": "999"})

    def test_symlink_hardlink_fifo_directory_and_size_rejected(self):
        secret = Path(self.temp.name) / "secret"; secret.write_text("never publish")
        source = self.workspace / "src/main.txt"
        source.unlink(); source.symlink_to(secret)
        with self.assertRaises(MODULE.PublicationHold): self.b.prepare(self.request)
        source.unlink(); os.link(secret, source)
        with self.assertRaisesRegex(MODULE.PublicationHold, "type_or_size"): self.b.prepare(self.request)
        source.unlink(); os.mkfifo(source)
        with self.assertRaisesRegex(MODULE.PublicationHold, "type_or_size"): self.b.prepare(self.request)
        source.unlink(); source.mkdir()
        with self.assertRaisesRegex(MODULE.PublicationHold, "type_or_size"): self.b.prepare(self.request)
        source.rmdir(); source.write_bytes(b"x" * (MODULE.MAX_FILE + 1))
        with self.assertRaisesRegex(MODULE.PublicationHold, "type_or_size"): self.b.prepare(self.request)
        source.unlink(); (self.workspace / "src/link").symlink_to(Path(self.temp.name), target_is_directory=True)
        with self.assertRaises(MODULE.PublicationHold): self.b.prepare({**self.request, "paths": ["src/link/secret"]})

    def test_total_size_count_deletion_and_unknown_files_policy(self):
        for i in range(6): (self.workspace / f"src/file{i}").write_bytes(b"x" * MODULE.MAX_FILE)
        with self.assertRaisesRegex(MODULE.PublicationHold, "total_limit"):
            self.b.prepare({**self.request, "paths": [f"src/file{i}" for i in range(6)]})
        with self.assertRaisesRegex(MODULE.PublicationHold, "paths_invalid"):
            self.b.prepare({**self.request, "paths": [f"src/{i}" for i in range(101)]})
        with self.assertRaisesRegex(MODULE.PublicationHold, "deleted_path_missing"):
            self.b.prepare({**self.request, "operationId": str(uuid.uuid4()), "deletions": ["src/missing"]})
        receipt = self.b.prepare({**self.request, "operationId": str(uuid.uuid4())})
        self.assertNotIn(b"file0", self.b._git(["ls-tree", "-r", receipt["treeSha"]]))

    def test_private_journal_tampering_fifo_and_changed_scope_hold(self):
        self.b.prepare(self.request)
        journal = self.b.operation_path(self.request["operationId"])
        original = journal.read_bytes(); value = json.loads(original)
        value["value"]["phase"] = "published"; journal.write_text(json.dumps(value))
        with self.assertRaisesRegex(MODULE.PublicationHold, "tampered"): self.b.prepare(self.request)
        journal.unlink(); os.mkfifo(journal, 0o600)
        with self.assertRaisesRegex(MODULE.PublicationHold, "unsafe"): self.b.prepare(self.request)
        journal.unlink(); journal.write_bytes(original); journal.chmod(0o600)
        changed = {**self.scope, "serverInstanceId": "different-lifetime"}
        other = MODULE.SourceBrokerFixture(self.store, self.workspace, changed, fixture_only=True)
        with self.assertRaisesRegex(MODULE.PublicationHold, "scope_or_shape"): other.prepare(self.request)

    def test_publish_rechecks_account_repository_permission_and_sanitizes_errors(self):
        self.b.prepare(self.request); self.remote.permission = False
        result = self.b.publish(self.request["operationId"], self.provider())
        self.assertEqual(result["heldReason"], "provider_repository_changed")
        self.assertFalse(any(method == "POST" for method, _, _ in self.remote.calls))
        def failed(*_args): raise RuntimeError("credential=never expose")
        request = {**self.request, "operationId": str(uuid.uuid4())}; self.b.prepare(request)
        result = self.b.publish(request["operationId"], self.provider(failed))
        self.assertEqual(result["heldReason"], "provider_unavailable")
        self.assertNotIn("credential", json.dumps(result))

    def test_ref_ack_loss_recovers_only_exact_readback(self):
        prepared = self.b.prepare(self.request)
        self.remote.loss = "/repos/fixture/source/git/refs"
        result = self.b.publish(self.request["operationId"], self.provider())
        self.assertEqual(result["phase"], "published")
        self.assertEqual(self.remote.refs[prepared["branch"]], prepared["commitSha"])
        self.assertEqual(sum(method == "POST" and url.endswith("/git/refs") for method, url, _ in self.remote.calls), 1)

    def test_ref_conflict_never_overwrites_an_existing_branch(self):
        prepared = self.b.prepare(self.request)
        self.remote.refs[prepared["branch"]] = "b" * 40
        result = self.b.publish(self.request["operationId"], self.provider())
        self.assertEqual(result["heldReason"], "provider_ref_mismatch")
        self.assertEqual(self.remote.refs[prepared["branch"]], "b" * 40)
        self.assertEqual(self.remote.prs, [])

    def test_pr_ack_loss_recovers_unique_matching_pr_or_holds_without_repost(self):
        self.b.prepare(self.request); self.remote.loss = "/repos/fixture/source/pulls"
        result = self.b.publish(self.request["operationId"], self.provider())
        self.assertEqual(result["phase"], "published"); self.assertEqual(len(self.remote.prs), 1)
        request = {**self.request, "operationId": str(uuid.uuid4())}; self.b.prepare(request)
        self.remote.before_effect = True
        result = self.b.publish(request["operationId"], self.provider())
        self.assertEqual(result["phase"], "held")
        calls = len(self.remote.calls)
        self.broker().publish(request["operationId"], self.provider())
        self.assertEqual(len(self.remote.calls), calls)
        self.assertEqual(len(self.remote.prs), 1)

    def test_wrong_blob_commit_parent_or_pr_scope_never_publishes(self):
        for kind in ("blob", "parent", "pr_head", "pr_repo", "pr_base", "pr_closed", "pr_title"):
            with self.subTest(kind=kind):
                request = {**self.request, "operationId": str(uuid.uuid4())}; self.b.prepare(request)
                remote = FakeGitHub(self.scope)
                def change(result, path):
                    if kind == "blob" and path.endswith("/git/blobs"): result["sha"] = "b" * 40
                    if kind == "parent" and "/git/commits/" in path: result["parents"] = [{"sha": "b" * 40}]
                    if "/pulls" in path:
                        if kind == "pr_head": result["head"]["sha"] = "b" * 40
                        if kind == "pr_repo": result["head"]["repo"]["id"] = 999
                        if kind == "pr_base": result["base"]["ref"] = "other"
                        if kind == "pr_closed": result["state"] = "closed"
                        if kind == "pr_title": result["title"] = "Changed remotely"
                    return result
                remote.mismatch = change
                result = self.b.publish(request["operationId"], self.provider(remote.request))
                self.assertEqual(result["phase"], "held")

    def test_budget_crash_phase_sealed_tampering_and_lock_are_fail_closed(self):
        self.b.prepare(self.request)
        with self.b.lock(), self.assertRaisesRegex(MODULE.PublicationHold, "broker_busy"):
            self.broker().prepare(self.request)
        entry = self.b.load(self.request["operationId"]); entry["requestsUsed"] = MODULE.MAX_REQUESTS - 1; self.b.save(entry)
        result = self.b.publish(self.request["operationId"], self.provider())
        self.assertEqual(result["heldReason"], "provider_request_budget")
        self.assertEqual(self.b.load(self.request["operationId"])["requestsUsed"], MODULE.MAX_REQUESTS)
        self.assertEqual(len(self.remote.calls), 1)
        request = {**self.request, "operationId": str(uuid.uuid4())}; self.b.prepare(request)
        entry = self.b.load(request["operationId"]); entry["phase"] = "pr-pending"; self.b.save(entry)
        with self.assertRaisesRegex(MODULE.PublicationHold, "phase_ambiguous"): self.b.publish(request["operationId"], self.provider())
        request = {**self.request, "operationId": str(uuid.uuid4())}; self.b.prepare(request)
        entry = self.b.load(request["operationId"])
        (self.b.objects / entry["manifest"][0]["contentDigest"]).write_bytes(b"tampered")
        result = self.b.publish(request["operationId"], self.provider())
        self.assertEqual(result["heldReason"], "sealed_object_changed")

    def test_policy_and_workspace_incarnation_drift_cannot_replay_sealed_work(self):
        self.b.prepare(self.request)
        stricter = MODULE.SourceBrokerFixture(self.store, self.workspace, self.scope, fixture_only=True, allowed_prefixes=("src",))
        with self.assertRaisesRegex(MODULE.PublicationHold, "scope_or_shape"):
            stricter.publish(self.request["operationId"], self.provider())
        previous = self.workspace.with_name("previous")
        self.workspace.rename(previous); (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "src/main.txt").write_text("replaced checkout")
        with self.assertRaisesRegex(MODULE.PublicationHold, "identity_changed"):
            self.b.prepare({**self.request, "operationId": str(uuid.uuid4())})
        with self.assertRaisesRegex(MODULE.PublicationHold, "scope_or_shape"):
            self.broker().prepare(self.request)

    def test_snapshot_detects_file_replacement_during_read(self):
        source, read = self.workspace / "src/main.txt", os.read
        changed = False
        def adversarial(fd, count):
            nonlocal changed
            raw = read(fd, count)
            if not changed:
                changed = True
                source.rename(source.with_name("preserved")); source.write_text("raced replacement")
            return raw
        with patch.object(MODULE.os, "read", adversarial), self.assertRaisesRegex(MODULE.PublicationHold, "changed_during_snapshot"):
            self.b.prepare(self.request)
        self.assertEqual(self.remote.calls, [])

    def test_unsafe_store_aliases_and_unknown_journal_files_are_preserved(self):
        outside = Path(self.temp.name) / "outside"; outside.mkdir()
        (self.store / "repo.git/objects/info/alternates").write_text(str(outside))
        with self.assertRaisesRegex(MODULE.PublicationHold, "storage_changed"):
            self.b.prepare(self.request)
        (self.store / "repo.git/objects/info/alternates").unlink()
        (self.store / "operations/interrupted.tmp").write_text("preserve evidence")
        with self.assertRaisesRegex(MODULE.PublicationHold, "unknown_file"):
            self.b.prepare(self.request)
        self.assertEqual((self.store / "operations/interrupted.tmp").read_text(), "preserve evidence")

    def test_malformed_provider_shapes_redirects_and_ambiguous_prs_hold(self):
        for kind in ("permissions", "redirect", "pr_head", "duplicate_pr"):
            with self.subTest(kind=kind):
                request = {**self.request, "operationId": str(uuid.uuid4())}; self.b.prepare(request)
                remote = FakeGitHub(self.scope)
                def transport(method, url, body, headers):
                    status, value = remote.request(method, url, body, headers)
                    if kind == "permissions" and url.endswith("/repos/fixture/source"): value["permissions"] = None
                    if kind == "redirect": return 302, {"url": "https://attacker.invalid/"}
                    if kind == "pr_head" and method == "POST" and url.endswith("/pulls"): value["head"] = None
                    if kind == "duplicate_pr" and method == "POST" and url.endswith("/pulls"):
                        remote.prs.append(json.loads(json.dumps(remote.prs[0])))
                        raise MODULE.UnknownOutcome("lost")
                    return status, value
                result = self.b.publish(request["operationId"], self.provider(transport))
                self.assertEqual(result["phase"], "held")

    def test_executable_mode_and_journal_capacity_are_explicit(self):
        source = self.workspace / "src/main.txt"; source.chmod(0o755)
        result = self.b.prepare(self.request)
        self.assertTrue(self.b._git(["ls-tree", result["commitSha"], "src/main.txt"]).startswith(b"100755"))
        template = self.b.load(self.request["operationId"])
        for _ in range(31):
            entry = json.loads(json.dumps(template)); entry["request"]["operationId"] = str(uuid.uuid4())
            entry["requestDigest"] = MODULE.sha(MODULE.canonical({"scope": self.scope, "policyDigest": self.b.policy_digest, "request": entry["request"]}))
            self.b.save(entry)
        with self.assertRaisesRegex(MODULE.PublicationHold, "capacity"):
            self.b.prepare({**self.request, "operationId": str(uuid.uuid4())})
        self.assertEqual(len(list(self.b.journals.iterdir())), 32)


if __name__ == "__main__":
    unittest.main()
