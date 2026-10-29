"""Protected-host source broker. No CLI or default activation.

Only the fixed host may compose this module, after independent guardian admission
and continuous read-only Git metadata protection. Callbacks are host capabilities,
never request fields. Native execution must not see this process, its private
store, token, or IPC. Local journals are recovery records, not server authority.
"""
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


broker = sibling("hive_protected_source_core", "delivery-source-broker.py")
auth = sibling("hive_source_agent_auth", "github-projects.py")
require, oid = broker.require, broker.oid
PublicationHold, UnknownOutcome = broker.PublicationHold, broker.UnknownOutcome
canonical, sha = broker.canonical, broker.sha
MAX_PARENT_TREES, MAX_PARENT_BYTES = 64, 5 * 1024 * 1024


def policy_value(value):
    require(isinstance(value, dict) and set(value) == {
        "version", "authorName", "authorEmail", "baseBranch", "allowedPrefixes",
        "maxFiles", "maxFileBytes", "maxBytes"}, "source_policy_invalid")
    require(isinstance(value["version"], str) and 0 < len(value["version"]) <= 100,
            "source_policy_invalid")
    for field, limit in (("authorName", 100), ("authorEmail", 254)):
        text = value[field]
        require(isinstance(text, str) and 0 < len(text) <= limit
                and all(ord(c) >= 32 and ord(c) != 127 and c not in "<>" for c in text),
                "source_policy_invalid")
    require(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value["authorEmail"]), "source_policy_invalid")
    require(isinstance(value["allowedPrefixes"], list) and 0 < len(value["allowedPrefixes"]) <= 10
            and all(isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", v)
                    for v in value["allowedPrefixes"]), "source_policy_invalid")
    for field, maximum in (("maxFiles", 100), ("maxFileBytes", 1024 * 1024), ("maxBytes", 5 * 1024 * 1024)):
        require(type(value[field]) is int and 0 < value[field] <= maximum, "source_policy_invalid")
    branch = value["baseBranch"]
    require(isinstance(branch, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,150}", branch)
            and not any(v in branch for v in ("..", "//", "@{"))
            and not branch.endswith(("/", ".", ".lock")), "source_policy_invalid")
    return json.loads(canonical(value))


class AgentGitHubTransport:
    """Fixed API origin, agent-scoped auth, no proxy/redirect/error-body output."""
    def __init__(self, full_name, authorize):
        require(isinstance(full_name, str) and re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", full_name)
            and full_name.split("/")[1] not in {".", ".."} and callable(authorize), "provider_scope_invalid")
        self.prefix, self.authorize = "/repos/" + full_name, authorize
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), auth.NoRedirect())
        self._token = None

    def allowed(self, method, url, body):
        parsed = urllib.parse.urlsplit(url)
        require(parsed.scheme == "https" and parsed.netloc == "api.github.com"
                and not parsed.fragment and "%" not in parsed.path, "provider_path_invalid")
        path, prefix = parsed.path, self.prefix
        if method == "GET":
            require(body is None, "provider_body_invalid")
            allowed = path in ("/user", prefix) or bool(re.fullmatch(
                re.escape(prefix) + r"/(?:git/commits/[a-f0-9]{40}|git/ref/heads/codex/delivery/[a-f0-9-]{36}/[a-f0-9-]{36}|pulls/[1-9][0-9]{0,9})", path))
            if path == prefix + "/pulls":
                query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
                allowed = set(query) == {"state", "head", "base", "per_page", "page"} and all(len(v) == 1 for v in query.values())
                require(allowed and query["state"] == ["all"] and query["per_page"] == ["100"]
                        and query["page"] in (["1"], ["2"]), "provider_path_invalid")
                return
            require(allowed and not parsed.query, "provider_path_invalid")
        else:
            require(method == "POST" and not parsed.query and path in {
                prefix + "/git/blobs", prefix + "/git/trees", prefix + "/git/commits",
                prefix + "/git/refs", prefix + "/pulls"} and isinstance(body, dict), "provider_path_invalid")

    def __call__(self, method, url, body, headers):
        self.allowed(method, url, body)
        require(headers == {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"},
                "provider_headers_invalid")
        self.authorize()  # Fresh server admission before even obtaining a credential.
        if self._token is None:
            try:
                self._token = auth.external_token()
            except Exception:
                raise PublicationHold("provider_agent_auth_unavailable") from None
        raw = None if body is None else canonical(body)
        require(raw is None or len(raw) <= 2 * broker.MAX_BYTES, "provider_request_limit")
        # Token retrieval can take time. Recheck immediately before an external effect.
        self.authorize()
        request = urllib.request.Request(url, data=raw, method=method, headers={
            **headers, "Authorization": "Bearer " + self._token, "User-Agent": "hive-source-broker",
            "Content-Type": "application/json", "Accept-Encoding": "identity"})
        started = time.monotonic()
        try:
            with self.opener.open(request, timeout=10) as response:
                require(response.geturl() == url and not response.headers.get("Content-Encoding"), "provider_redirect_rejected")
                data = bytearray()
                while len(data) <= 1024 * 1024:
                    require(time.monotonic() - started < 10, "provider_response_timeout")
                    part = response.read1(min(65536, 1024 * 1024 + 1 - len(data)))
                    if not part:
                        break
                    data.extend(part)
                require(len(data) <= 1024 * 1024, "provider_response_limit")
                return response.status, json.loads(data)
        except urllib.error.HTTPError as error:
            # Never read or retain a provider error body/header (may contain secrets).
            status = error.code
            error.close()
            return status, {}
        except PublicationHold:
            raise
        except Exception:
            if method == "POST":
                raise UnknownOutcome("provider_outcome_unknown") from None
            raise PublicationHold("provider_unavailable") from None


class ProtectedSourceBroker(broker._SourceBrokerCore):
    def __init__(self, root, workspace, scope, *, policy, metadata_identity, metadata_authority, attempt_lease_generation, clock=time.time):
        require(callable(metadata_authority), "metadata_authority_required")
        require(type(attempt_lease_generation) is int and attempt_lease_generation > 0, "attempt_lease_invalid")
        self.attempt_lease_generation = attempt_lease_generation
        self.publication_policy = policy_value(policy)
        require(self.publication_policy["baseBranch"] == scope["baseBranch"], "source_policy_invalid")
        require(isinstance(metadata_identity, dict) and set(metadata_identity) == {"checkout", "git"}
                and all(isinstance(v, dict) and set(v) == {"device", "inode"}
                        and all(type(n) is int and n >= 0 for n in v.values())
                        for v in metadata_identity.values()), "metadata_identity_invalid")
        self.metadata_identity = json.loads(canonical(metadata_identity))
        self.metadata_authority = metadata_authority
        self.workspace = Path(workspace)
        self.check_metadata()
        p = self.publication_policy
        super().__init__(root, workspace, scope, allowed_prefixes=tuple(p["allowedPrefixes"]), clock=clock,
                         author_name=p["authorName"], author_email=p["authorEmail"],
                         max_files=p["maxFiles"], max_file_bytes=p["maxFileBytes"], max_bytes=p["maxBytes"])
        self.check_metadata()

    def check_metadata(self):
        # Callback must check persisted finalized admission and the installed mount
        # inventory. Inode equality alone cannot prove absence of an earlier writer.
        observed = self.metadata_authority()
        require(observed == self.metadata_identity, "metadata_authority_changed")
        for key, path in (("checkout", self.workspace), ("git", self.workspace / ".git")):
            try:
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    info = os.fstat(fd)
                    require({"device": info.st_dev, "inode": info.st_ino} == observed[key], "metadata_identity_changed")
                finally:
                    os.close(fd)
            except OSError:
                raise PublicationHold("metadata_identity_changed") from None

    def import_parent(self):
        """Import exact commit and trees, no history, blobs, filters, refs or index.

        Inherited blob IDs come from SHA-verified parent trees. mktree --missing
        preserves them without copying large repository assets into the broker.
        """
        self.check_metadata()
        objects = self.workspace / ".git" / "objects"
        require(objects.resolve() == objects and objects.is_dir(), "parent_storage_unsupported")
        for name in ("info/alternates", "info/http-alternates"):
            require(not os.path.lexists(objects / name), "parent_storage_unsupported")
        total, visited = 0, set()

        def read(kind, object_sha):
            nonlocal total
            self.check_metadata()
            raw = self._execute(["--git-dir=" + str(self.git_dir), "cat-file", kind, object_sha], object_directory=objects)
            require(broker.object_id(kind, raw) == object_sha, "parent_object_mismatch")
            total += len(raw)
            require(total <= MAX_PARENT_BYTES, "parent_import_limit")
            require(self._git(["hash-object", "-t", kind, "--no-filters", "-w", "--stdin"], raw).decode().strip() == object_sha,
                    "parent_object_mismatch")
            return raw

        with self.lock():
            raw = read("commit", self.scope["parentSha"])
            match = re.match(rb"tree ([a-f0-9]{40})\n", raw)
            require(match is not None, "parent_commit_invalid")

            def visit(tree_sha, depth):
                require(depth <= 16, "parent_import_limit")
                if tree_sha in visited:
                    return
                visited.add(tree_sha)
                require(len(visited) <= MAX_PARENT_TREES, "parent_import_limit")
                tree, offset = read("tree", tree_sha), 0
                while offset < len(tree):
                    end = tree.find(b"\0", offset)
                    require(end > offset and end + 21 <= len(tree), "parent_tree_invalid")
                    header = tree[offset:end].split(b" ", 1)
                    require(len(header) == 2 and header[0] in {b"40000", b"100644", b"100755"}
                            and re.fullmatch(rb"[A-Za-z0-9_.-]+", header[1])
                            and header[1].lower() not in {b".", b"..", b".git"}, "parent_storage_unsupported")
                    child = tree[end + 1:end + 21].hex()
                    if header[0] == b"40000":
                        visit(child, depth + 1)
                    offset = end + 21

            visit(match[1].decode(), 0)
            self.check_metadata()
        return {"parentSha": self.scope["parentSha"], "trees": len(visited), "bytes": total}

    @staticmethod
    def receipt(entry):
        result = broker._SourceBrokerCore.receipt(entry)
        result["fixtureOnly"] = False
        # Even a real GitHub receipt has NO server/native/release authority.
        return result

    def prepare(self, request):
        self.check_metadata()
        result = super().prepare(request)
        self.check_metadata()
        return result

    def challenge_material(self, operation_id):
        with self.lock():
            entry = self.load(operation_id)
            require(entry["phase"] in {"prepared", "published"}, "publication_phase_ambiguous")
            return {"operationId": operation_id, "policyDigest": sha(canonical(self.publication_policy)),
                    "manifest": {"files": entry["manifest"], "deletions": sorted(entry["request"]["deletions"])},
                    "target": {"headSha": entry["commit"]["sha"], "treeSha": entry["commit"]["tree"],
                               "manifestDigest": entry["manifestDigest"]}}

    def publish_authorized(self, operation_id, grant, reauthorize):
        require(callable(reauthorize) and isinstance(grant, dict), "publication_authority_required")
        grant = json.loads(canonical(grant))
        with self.lock():
            entry = self.load(operation_id)
            require(entry["phase"] in {"prepared", "published", "held"}, "publication_phase_ambiguous")
            for key in ("ownerId", "taskId", "managerBindingId", "attemptId", "repositoryId", "providerAccountId",
                        "fullName", "parentSha", "sourceVersion"):
                require(grant.get(key) == self.scope[key], "publication_grant_mismatch")
            require(grant.get("leaseGeneration") == self.attempt_lease_generation
                    and grant.get("schemaVersion") == 1 and grant.get("action") == "publish_source_revision"
                    and grant.get("operationId") == operation_id and grant.get("branch") == entry["branch"]
                    and grant.get("policy") == self.publication_policy
                    and grant.get("policyDigest") == sha(canonical(self.publication_policy))
                    and grant.get("target") == {"headSha": entry["commit"]["sha"], "treeSha": entry["commit"]["tree"],
                                                "manifestDigest": entry["manifestDigest"]}
                    and isinstance(grant.get("admission"), dict)
                    and grant["admission"].get("checkoutIncarnation") == self.scope["checkoutIncarnation"],
                    "publication_grant_mismatch")
            previous = entry.get("publicationGrant")
            require(previous is None or previous == grant, "publication_grant_changed")
            entry["publicationGrant"] = grant
            self.save(entry)

        def authorize():
            self.check_metadata()
            require(type(grant.get("expiresAt")) is int and self.clock() * 1000 < grant["expiresAt"], "publication_grant_expired")
            # Re-POST the exact signed challenge. Server revalidates all fences;
            # an exact replay returns the same cap and NEVER extends its expiry.
            require(reauthorize() == grant, "publication_authority_changed")
            require(self.clock() * 1000 < grant["expiresAt"], "publication_grant_expired")

        provider = broker._provider._FixedGitHubProvider(self.scope, AgentGitHubTransport(self.scope["fullName"], authorize))
        return super().publish(operation_id, provider)

    def publish(self, *_args, **_kwargs):
        raise PublicationHold("publication_authority_required")

    def fresh_readback(self, operation_id, grant, reauthorize):
        """Bounded fresh provider observations; signer persists the final envelope."""
        with self.lock():
            entry = self.load(operation_id)
            require(entry["phase"] == "published" and entry.get("publicationGrant") == grant, "publication_grant_mismatch")
            def authorize():
                self.check_metadata()
                require(type(grant.get("expiresAt")) is int and self.clock() * 1000 < grant["expiresAt"]
                        and reauthorize() == grant and self.clock() * 1000 < grant["expiresAt"], "publication_authority_changed")
            provider = broker._provider._FixedGitHubProvider(self.scope, AgentGitHubTransport(self.scope["fullName"], authorize))
            def charge():
                require(entry["requestsUsed"] < broker.MAX_REQUESTS, "provider_request_budget")
                entry["requestsUsed"] += 1
                self.save(entry)
            observed_at = self.clock()
            provider.verify_identity(charge)
            commit, branch = entry["commit"], entry["branch"]
            status, value = provider.request("GET", provider.prefix + "/git/commits/" + commit["sha"], None, charge)
            require(status == 200 and isinstance(value, dict) and value.get("sha") == commit["sha"]
                    and broker._provider.mapping(value.get("tree")).get("sha") == commit["tree"]
                    and isinstance(value.get("parents"), list)
                    and [broker._provider.mapping(v).get("sha") for v in value["parents"]] == [self.scope["parentSha"]],
                    "provider_commit_readback_mismatch")
            provider.read_ref(branch, commit["sha"], charge)
            status, value = provider.request("GET", provider.prefix + "/pulls/" + str(entry["pullRequest"]["number"]), None, charge)
            require(status == 200 and provider.verify_pr(value, branch, commit["sha"], entry["request"]["title"], entry["request"]["body"]) == entry["pullRequest"],
                    "provider_pr_readback_mismatch")
            authorize()
            require(0 <= self.clock() - observed_at <= 10, "provider_readback_stale")
            return {"observedAt": datetime.fromtimestamp(observed_at, timezone.utc).isoformat(),
                    "providerAccountId": self.scope["providerAccountId"], "repositoryId": self.scope["repositoryId"],
                    "fullName": self.scope["fullName"],
                    "manifest": {"files": entry["manifest"], "deletions": sorted(entry["request"]["deletions"])},
                    "commit": {"sha": commit["sha"], "treeSha": commit["tree"], "parentSha": self.scope["parentSha"]},
                    "reference": {"name": "refs/heads/" + branch, "sha": commit["sha"], "type": "commit"},
                    "pullRequest": {**entry["pullRequest"], "headRepositoryId": self.scope["repositoryId"],
                                    "baseRepositoryId": self.scope["repositoryId"], "headRef": branch,
                                    "headSha": commit["sha"], "baseRef": self.scope["baseBranch"], "state": "open", "draft": True}}
