"""Unactivated source-publication fixture adapter. No HTTP client or credentials.

The injected transport is trusted test composition, never model JSON. Production
must not wire this up before metadata/isolation/admission authority is reviewed.
"""
import base64
import json
import re
from urllib.parse import urlencode


class PublicationHold(Exception):
    pass


class UnknownOutcome(Exception):
    """Fixture transport lost an acknowledgement; remote effects may exist."""


def require(value, reason):
    if not value:
        raise PublicationHold(reason)


def oid(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{40}", value) is not None


def mapping(value):
    require(isinstance(value, dict), "provider_response_invalid")
    return value


class FixedGitHubFixtureProvider:
    def __init__(self, scope, transport=None, *, fixture_only=False):
        require(fixture_only is True and callable(transport), "publication_unactivated")
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", scope["fullName"])
                and scope["fullName"].split("/")[1] not in {".", ".."}, "provider_scope_invalid")
        self.scope, self.transport = dict(scope), transport
        self.prefix = "/repos/" + scope["fullName"]

    def request(self, method, path, body, charge):
        charge()  # Durable budget reservation precedes even a failed request.
        require(path == "/user" or path == self.prefix or path.startswith(self.prefix + "/"), "provider_path_invalid")
        try:
            result = self.transport(method, "https://api.github.com" + path, body,
                                    {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"})
        except UnknownOutcome:
            raise
        except Exception:
            raise PublicationHold("provider_unavailable") from None
        require(isinstance(result, tuple) and len(result) == 2 and type(result[0]) is int,
                "provider_response_invalid")
        try:
            require(len(json.dumps(result[1], allow_nan=False).encode()) <= 1024 * 1024, "provider_response_limit")
        except (ValueError, TypeError, RecursionError):
            raise PublicationHold("provider_response_invalid") from None
        require(not 300 <= result[0] < 400, "provider_redirect_rejected")
        require(result[0] not in (401, 403, 404), "provider_permission_unavailable")
        return result

    def verify_identity(self, charge):
        status, user = self.request("GET", "/user", None, charge)
        require(status == 200 and isinstance(user, dict) and str(user.get("id")) == self.scope["providerAccountId"], "provider_account_changed")
        status, repo = self.request("GET", self.prefix, None, charge)
        require(status == 200 and isinstance(repo, dict) and str(repo.get("id")) == self.scope["repositoryId"]
                and isinstance(repo.get("full_name"), str) and repo["full_name"].lower() == self.scope["fullName"].lower()
                and mapping(repo.get("permissions")).get("push") is True, "provider_repository_changed")

    def blob(self, raw, expected, charge):
        status, result = self.request("POST", self.prefix + "/git/blobs",
                                      {"encoding": "base64", "content": base64.b64encode(raw).decode()}, charge)
        require(status == 201 and isinstance(result, dict) and result.get("sha") == expected, "provider_blob_mismatch")

    def tree(self, entries, expected, charge):
        status, result = self.request("POST", self.prefix + "/git/trees", {"tree": entries}, charge)
        require(status == 201 and isinstance(result, dict) and result.get("sha") == expected, "provider_tree_mismatch")

    def commit(self, body, expected, charge):
        status, result = self.request("POST", self.prefix + "/git/commits", body, charge)
        require(status == 201 and isinstance(result, dict) and result.get("sha") == expected, "provider_commit_mismatch")
        status, readback = self.request("GET", self.prefix + "/git/commits/" + expected, None, charge)
        require(status == 200 and isinstance(readback, dict) and readback.get("sha") == expected
                and mapping(readback.get("tree")).get("sha") == body["tree"]
                and isinstance(readback.get("parents"), list)
                and [mapping(p).get("sha") for p in readback["parents"]] == body["parents"], "provider_commit_readback_mismatch")

    def read_ref(self, branch, expected, charge):
        status, result = self.request("GET", self.prefix + "/git/ref/heads/" + branch, None, charge)
        require(status == 200 and isinstance(result, dict) and result.get("ref") == "refs/heads/" + branch
                and mapping(result.get("object")).get("type") == "commit"
                and mapping(result.get("object")).get("sha") == expected, "provider_ref_mismatch")

    def create_ref(self, branch, expected, charge):
        try:
            status, _ = self.request("POST", self.prefix + "/git/refs", {"ref": "refs/heads/" + branch, "sha": expected}, charge)
            require(status in (201, 409, 422), "provider_ref_rejected")
        except UnknownOutcome:
            pass  # Exact readback can recover only this already-journaled ref.
        self.read_ref(branch, expected, charge)

    def verify_pr(self, result, branch, commit, title, body):
        require(isinstance(result, dict) and type(result.get("id")) is int and result["id"] > 0
                and type(result.get("number")) is int and result["number"] > 0, "provider_pr_invalid")
        head, base = mapping(result.get("head")), mapping(result.get("base"))
        require(str(mapping(head.get("repo")).get("id")) == self.scope["repositoryId"]
                and str(mapping(base.get("repo")).get("id")) == self.scope["repositoryId"]
                and head.get("ref") == branch and head.get("sha") == commit
                and base.get("ref") == self.scope["baseBranch"] and result.get("state") == "open"
                and result.get("draft") is True and result.get("merged_at") is None
                and result.get("title") == title and result.get("body") == body, "provider_pr_mismatch")
        return {"id": str(result["id"]), "number": result["number"]}

    def create_pr(self, branch, commit, title, body, charge):
        try:
            status, result = self.request("POST", self.prefix + "/pulls",
                                          {"head": branch, "base": self.scope["baseBranch"], "title": title, "body": body, "draft": True}, charge)
            require(status == 201, "provider_pr_rejected")
        except UnknownOutcome:
            # Bounded lookup is recovery, not permission to repeat a non-idempotent POST.
            matches = []
            for page in (1, 2):
                query = urlencode({"state": "all", "head": self.scope["fullName"].split("/")[0] + ":" + branch,
                                   "base": self.scope["baseBranch"], "per_page": 100, "page": page})
                status, results = self.request("GET", self.prefix + "/pulls?" + query, None, charge)
                require(status == 200 and isinstance(results, list) and len(results) <= 100, "provider_pr_lookup_invalid")
                matches.extend(r for r in results if mapping(mapping(r).get("head")).get("ref") == branch)
                if len(results) < 100:
                    break
            else:
                raise PublicationHold("provider_pr_lookup_incomplete")
            require(len(matches) == 1, "provider_pr_outcome_unknown")
            result = matches[0]
        receipt = self.verify_pr(result, branch, commit, title, body)
        status, readback = self.request("GET", self.prefix + "/pulls/" + str(receipt["number"]), None, charge)
        require(status == 200 and self.verify_pr(readback, branch, commit, title, body) == receipt, "provider_pr_readback_mismatch")
        return receipt
