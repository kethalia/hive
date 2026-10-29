"""Read-only source collection; fixture transport never contacts GitHub."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/github-evidence.py"
SPEC = importlib.util.spec_from_file_location("github_evidence", SOURCE)
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)
SHA = "a" * 40
STAMP = "2026-10-29T10:00:00Z"
REQUEST = {"schemaVersion": 1, "providerRepositoryId": "42", "providerAccountId": "7", "fullName": "owner/repo", "pullNumber": 5, "expectedHeadSha": SHA}


class Response(io.BytesIO):
    status = 200

    def __init__(self, value, headers=None):
        super().__init__(value if isinstance(value, bytes) else json.dumps(value).encode())
        self.headers = headers or {}


def fixture():
    pr = {"id": 50, "number": 5, "base": {"repo": {"id": 42}}, "head": {"sha": SHA, "repo": {"id": 42}}, "user": {"id": 8}, "state": "open", "draft": False, "updated_at": STAMP}
    run = {"id": 60, "workflow_id": 61, "check_suite_id": 62, "run_number": 9, "run_attempt": 2, "head_sha": SHA, "status": "completed", "conclusion": "success", "updated_at": STAMP, "event": "pull_request", "repository": {"id": 42}}
    job = {"id": 70, "run_id": 60, "run_attempt": 2, "name": "Test", "status": "completed", "conclusion": "success", "started_at": STAMP, "completed_at": STAMP, "check_run_url": "https://api.github.com/repos/owner/repo/check-runs/80"}
    check = {"id": 80, "check_suite": {"id": 62}, "name": "Test", "head_sha": SHA, "status": "completed", "conclusion": "success", "started_at": STAMP, "completed_at": STAMP, "app": {"id": 81, "slug": "github-actions"}}
    review = {"id": 90, "user": {"id": 9}, "state": "APPROVED", "commit_id": SHA, "submitted_at": STAMP, "body": "PRIVATE_REVIEW_PROSE"}
    marker = {"code_review": {"commit_sha": SHA, "status": "completed", "has_any_findings": False, "has_unresolved_findings": False}, "security_review": {"irrelevant": "DROP_THIS_FIELD"}}
    comment = {"id": 91, "user": {"id": 10, "type": "Bot"}, "performed_via_github_app": {"id": 11}, "updated_at": STAMP, "created_at": STAMP, "body": "PRIVATE_COMMENT\n<!-- codex-review-state:v1 " + json.dumps(marker) + " -->"}
    graph = {"data": {"repository": {"databaseId": 42, "pullRequest": {"databaseId": 50, "headRefOid": SHA, "reviewThreads": {"nodes": [{"id": "THREAD", "isResolved": True, "isOutdated": False}], "pageInfo": {"hasNextPage": False, "endCursor": None}}}}}}
    values = {"user": {"id": 7}, "repo": {"id": 42, "full_name": "owner/repo", "temp_clone_token": "PRIVATE_CLONE_TOKEN"}, "pr": pr, "runs": [run], "jobs": [job], "checks": [check], "reviews": [review], "comments": [comment], "graph": graph}
    return values


def transport(values, hook=None):
    requests = []

    def read(reader, path, body=None):
        requests.append((path, body))
        if hook:
            result = hook(path, body, len(requests))
            if result is not None:
                return copy.deepcopy(result), {}
        if path == "/user":
            value = values["user"]
        elif path == "/repos/owner/repo":
            value = values["repo"]
        elif path == "/repos/owner/repo/pulls/5":
            value = values["pr"]
        elif path.startswith("/repos/owner/repo/actions/runs?"):
            value = {"workflow_runs": values["runs"]}
        elif path.startswith("/repos/owner/repo/actions/runs/60/attempts/2/jobs?"):
            value = {"jobs": values["jobs"]}
        elif "/check-runs?" in path:
            value = {"check_runs": values["checks"]}
        elif path.startswith("/repos/owner/repo/pulls/5/reviews?"):
            value = values["reviews"]
        elif path.startswith("/repos/owner/repo/issues/5/comments?"):
            value = values["comments"]
        elif path == "/graphql":
            value = values["graph"]
        else:
            raise AssertionError("unexpected fixed path")
        return copy.deepcopy(value), {}

    return requests, read


class EvidenceTests(unittest.TestCase):
    def collect(self, values=None, hook=None):
        values = values or fixture()
        requests, read = transport(values, hook)
        with patch.object(evidence.AUTH, "external_token", return_value="PRIVATE_AGENT_TOKEN") as token, patch.object(evidence.Reader, "read", read):
            result = evidence.collect(REQUEST)
        token.assert_called_once()
        return result, requests

    def test_fixed_identifiers_current_attempt_and_allowlisted_metadata_only(self):
        result, requests = self.collect()
        self.assertEqual(result["repository"]["id"], "42")
        self.assertEqual(result["providerAccountId"], "7")
        self.assertEqual(result["workflowRuns"][0]["runAttempt"], 2)
        self.assertTrue(any("/attempts/2/jobs?" in path for path, _ in requests))
        self.assertEqual(result["reviewSummaries"][0]["marker"]["code_review"]["commit_sha"], SHA)
        encoded = json.dumps(result)
        for secret in ("PRIVATE_AGENT_TOKEN", "PRIVATE_CLONE_TOKEN", "PRIVATE_REVIEW_PROSE", "PRIVATE_COMMENT", "DROP_THIS_FIELD"):
            self.assertNotIn(secret, encoded)
        self.assertTrue(result["collectionsComplete"])
        self.assertGreater(sum(path == "/repos/owner/repo/pulls/5" for path, _ in requests), 1)

    def test_request_has_no_arbitrary_url_or_provider_override(self):
        for changes in ({"url": "https://evil.invalid"}, {"providerRepositoryId": "../42"}, {"providerAccountId": 7}, {"fullName": "owner/.."}, {"pullNumber": True}, {"expectedHeadSha": "main"}):
            with self.subTest(changes=changes), self.assertRaises(evidence.EvidenceError):
                evidence.parameters({**REQUEST, **changes})

    def test_repository_account_head_and_revision_changes_fail_closed(self):
        for field, change in (("repo", {"id": 999}), ("user", {"id": 999}), ("pr", {"head": {"sha": "b" * 40, "repo": {"id": 42}}})):
            values = fixture()
            values[field].update(change)
            with self.subTest(field=field), self.assertRaises(evidence.EvidenceError):
                self.collect(values)
        calls = {"pr": 0}

        def changed(path, _body, _n):
            if path == "/repos/owner/repo/pulls/5":
                calls["pr"] += 1
                if calls["pr"] > 1:
                    value = fixture()["pr"]
                    value["head"]["sha"] = "b" * 40
                    return value
        with self.assertRaisesRegex(evidence.EvidenceError, "github_revision_changed"):
            self.collect(hook=changed)

    def test_same_head_rerun_or_review_edit_during_collection_is_rejected(self):
        for kind in ("run", "review"):
            count = {"n": 0}

            def changed(path, _body, _n):
                if kind == "run" and path.startswith("/repos/owner/repo/actions/runs?"):
                    count["n"] += 1
                    if count["n"] > 1:
                        value = fixture()["runs"]
                        value[0]["run_attempt"] = 3
                        return {"workflow_runs": value}
                if kind == "review" and path.startswith("/repos/owner/repo/issues/5/comments?"):
                    count["n"] += 1
                    if count["n"] > 1:
                        value = fixture()["comments"]
                        value[0]["body"] = "Edited marker"
                        return value
            with self.subTest(kind=kind), self.assertRaisesRegex(evidence.EvidenceError, "github_(run|review)_changed"):
                self.collect(hook=changed)

    def test_graphql_errors_incomplete_cursor_or_wrong_head_never_return_partial_success(self):
        for change in ("errors", "cursor", "head"):
            values = fixture()
            if change == "errors":
                values["graph"]["errors"] = [{"message": "PRIVATE_GRAPHQL_ERROR"}]
            elif change == "cursor":
                values["graph"]["data"]["repository"]["pullRequest"]["reviewThreads"]["pageInfo"]["hasNextPage"] = True
            else:
                values["graph"]["data"]["repository"]["pullRequest"]["headRefOid"] = "b" * 40
            with self.subTest(change=change), self.assertRaises(evidence.EvidenceError):
                self.collect(values)

    def test_pagination_reconstructs_only_known_endpoint_and_stops_at_limit(self):
        reader = Mock()
        reader.read.side_effect = [([1], {"Link": '<https://api.github.com/repositories/42/pulls/5/reviews?per_page=100&page=2>; rel="next"'}), ([2], {})]
        self.assertEqual(evidence.paginate(reader, "/repos/owner/repo/pulls/5/reviews", "42"), [1, 2])
        self.assertEqual(reader.read.call_args.args[0], "/repos/owner/repo/pulls/5/reviews?per_page=100&page=2")
        for link in ('<https://evil.invalid/x?per_page=100&page=2>; rel="next"', '<https://api.github.com/repos/other/repo/pulls/5/reviews?per_page=100&page=2>; rel="next"', '<https://api.github.com/repos/owner/repo/pulls/5/reviews?per_page=99&page=2>; rel="next"'):
            reader.read.side_effect = None
            reader.read.return_value = ([], {"Link": link})
            with self.assertRaisesRegex(evidence.EvidenceError, "pagination"):
                evidence.paginate(reader, "/repos/owner/repo/pulls/5/reviews", "42")

    def test_redirect_permission_and_size_limits_do_not_leak_token_or_provider_bodies(self):
        for status in (302, 401, 403, 429):
            opener = Mock()
            opener.open.side_effect = urllib.error.HTTPError("https://api.github.com/user", status, "PRIVATE_AGENT_TOKEN", {}, io.BytesIO(b"PRIVATE_RESPONSE"))
            with patch.object(evidence.urllib.request, "build_opener", return_value=opener):
                reader = evidence.Reader("PRIVATE_AGENT_TOKEN")
                with self.assertRaises(evidence.EvidenceError) as caught:
                    reader.read("/user")
                self.assertNotIn("PRIVATE", str(caught.exception))
        opener = Mock()
        opener.open.return_value = Response(b"x" * (evidence.MAX_RESPONSE + 1))
        with patch.object(evidence.urllib.request, "build_opener", return_value=opener), self.assertRaisesRegex(evidence.EvidenceError, "limit"):
            evidence.Reader("PRIVATE_AGENT_TOKEN").read("/user")

    def test_malformed_duplicate_or_unrecognized_marker_never_returns_untrusted_payload(self):
        for body in ('<!-- codex-review-state:v1 {"code_review":{"token":"PRIVATE"}} -->', '<!-- codex-review-state:v1 not-json -->', '<!-- codex-review-state:v1 {} --><!-- codex-review-state:v1 {} -->'):
            result = evidence.marker(body)
            self.assertIsNone(result["marker"])
            self.assertTrue(result["markerPresent"])
            self.assertNotIn("PRIVATE", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
