#!/usr/bin/env python3
"""Fixed, read-only GitHub evidence fetch. JSON is NOT proof of producer authority.

Invoke only through a registered, challenge-bound trusted host source channel.
The agent's external-auth token stays inside this process. No clones or mutations.
"""
import hashlib
import importlib.util
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("hive_github_projects", Path(__file__).with_name("github-projects.py"))
AUTH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUTH)
ORIGIN = "https://api.github.com"
API_VERSION = "2026-03-10"
MAX_PAGES = 5
MAX_REQUESTS = 64
MAX_BYTES = 8 * 1024 * 1024
MAX_RESPONSE = 1024 * 1024
THREAD_QUERY = """query HiveReviewThreads($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){databaseId pullRequest(number:$number){databaseId headRefOid reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated}pageInfo{hasNextPage endCursor}}}}}"""


class EvidenceError(Exception):
    pass


def identifier(value):
    if type(value) is not int or not 0 < value < 10**20:
        raise EvidenceError("github_invalid_identity")
    return str(value)


def parameters(value):
    keys = {"schemaVersion", "providerRepositoryId", "providerAccountId", "fullName", "pullNumber", "expectedHeadSha"}
    if not isinstance(value, dict) or set(value) != keys or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise EvidenceError("invalid_request")
    for field in ("providerRepositoryId", "providerAccountId"):
        if not isinstance(value[field], str) or not re.fullmatch(r"[1-9][0-9]{0,19}", value[field]):
            raise EvidenceError("invalid_request")
    if (not isinstance(value["fullName"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", value["fullName"]) or
            value["fullName"].split("/")[1] in {".", ".."} or
            type(value["pullNumber"]) is not int or not 0 < value["pullNumber"] < 2**31 or
            not isinstance(value["expectedHeadSha"], str) or not re.fullmatch(r"[a-f0-9]{40}", value["expectedHeadSha"])):
        raise EvidenceError("invalid_request")
    return value


class Reader:
    def __init__(self, token):
        self.token, self.deadline, self.requests, self.bytes = token, time.monotonic() + 45, 0, 0
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), AUTH.NoRedirect())

    def read(self, path, body=None):
        self.requests += 1
        remaining = self.deadline - time.monotonic()
        if self.requests > MAX_REQUESTS or remaining <= 0:
            raise EvidenceError("github_snapshot_limit")
        if not path.startswith("/") or path.startswith("//") or (body is not None and path != "/graphql"):
            raise EvidenceError("invalid_request")
        request = urllib.request.Request(ORIGIN + path, data=None if body is None else json.dumps(body).encode(), headers={
            "Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
            "Content-Type": "application/json", "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "Hive-evidence-reader/1",
        }, method="GET" if body is None else "POST")
        try:
            with self.opener.open(request, timeout=min(8, remaining)) as response:
                if response.status != 200:
                    raise EvidenceError("github_unavailable")
                payload = bytearray()
                while True:
                    if time.monotonic() >= self.deadline:
                        raise EvidenceError("github_snapshot_timeout")
                    chunk = response.read1(min(65536, MAX_RESPONSE + 1 - len(payload)))
                    if not chunk:
                        break
                    payload.extend(chunk)
                    self.bytes += len(chunk)
                    if len(payload) > MAX_RESPONSE or self.bytes > MAX_BYTES:
                        raise EvidenceError("github_snapshot_limit")
                return json.loads(payload), response.headers
        except urllib.error.HTTPError as error:
            code = "github_auth_required" if error.code == 401 else "github_permission_denied" if error.code in (403, 404) else "github_rate_limited" if error.code == 429 else "github_redirect_rejected" if 300 <= error.code < 400 else "github_unavailable"
            if error.code == 403 and error.headers.get("X-RateLimit-Remaining") == "0":
                code = "github_rate_limited"
            error.close()
            raise EvidenceError(code) from None
        except (TimeoutError, urllib.error.URLError):
            raise EvidenceError("github_unavailable") from None
        except (ValueError, UnicodeDecodeError):
            raise EvidenceError("github_invalid_response") from None


def paginate(reader, path, repository_id, key=None, query=None):
    query = query or {}
    records = []
    for page in range(1, MAX_PAGES + 1):
        params = {**query, "per_page": 100, "page": page}
        value, headers = reader.read(path + "?" + urllib.parse.urlencode(params))
        values = value if key is None else value[key]
        if not isinstance(values, list) or len(values) > 100:
            raise EvidenceError("github_invalid_response")
        records.extend(values)
        link = headers.get("Link", "")
        if len(link) > 8192:
            raise EvidenceError("github_invalid_pagination")
        next_page = None
        for part in link.split(",") if link else []:
            match = re.fullmatch(r'\s*<([^>]+)>;\s*rel="([a-z ]+)"\s*', part)
            if not match:
                raise EvidenceError("github_invalid_pagination")
            if "next" not in match[2].split():
                continue
            url = urllib.parse.urlsplit(match[1])
            original = re.sub(r"^/repos/[^/]+/[^/]+", "/repositories/" + repository_id, path)
            parsed = urllib.parse.parse_qs(url.query)
            if (url.scheme != "https" or url.netloc != "api.github.com" or url.path not in (path, original) or url.fragment or
                    set(parsed) != set(params) or any(parsed.get(k) != [str(v)] for k, v in params.items() if k != "page") or
                    parsed.get("page") != [str(page + 1)] or next_page is not None):
                raise EvidenceError("github_invalid_pagination")
            next_page = page + 1
        if next_page is None:
            return records
    raise EvidenceError("github_snapshot_incomplete")


def marker(body):
    if not isinstance(body, str) or len(body) > 65536:
        raise EvidenceError("github_invalid_response")
    matches = re.findall(r"<!--\s*codex-review-state:v1\s+(.*?)\s*-->", body, re.S)
    parsed = None
    if len(matches) == 1:
        try:
            parsed = json.loads(matches[0])
        except ValueError:
            pass
    fields = {"commit_sha", "status", "has_any_findings", "has_unresolved_findings"}
    if (not isinstance(parsed, dict) or set(parsed) - {"code_review", "security_review"} or
            not isinstance(parsed.get("code_review"), dict) or set(parsed["code_review"]) != fields):
        parsed = None
    elif (parsed["code_review"]["commit_sha"] is not None and not isinstance(parsed["code_review"]["commit_sha"], str) or
          parsed["code_review"]["status"] is not None and not isinstance(parsed["code_review"]["status"], str) or
          any(parsed["code_review"][field] is not None and type(parsed["code_review"][field]) is not bool for field in ("has_any_findings", "has_unresolved_findings"))):
        parsed = None
    else:
        parsed = {"code_review": parsed["code_review"]}
    return {"bodyDigest": hashlib.sha256(body.encode()).hexdigest(), "marker": parsed,
            "markerPresent": "codex-review-state:" in body, "markerCount": len(matches)}


def pull(record, expected):
    if (record["number"] != expected["pullNumber"] or identifier(record["base"]["repo"]["id"]) != expected["providerRepositoryId"] or
            record["head"]["sha"] != expected["expectedHeadSha"]):
        raise EvidenceError("github_revision_changed")
    return {"id": identifier(record["id"]), "number": record["number"], "headSha": record["head"]["sha"],
            "headRepositoryId": identifier(record["head"]["repo"]["id"]), "baseRepositoryId": identifier(record["base"]["repo"]["id"]),
            "authorId": identifier(record["user"]["id"]), "state": record["state"], "draft": record["draft"], "updatedAt": record["updated_at"]}


def review_threads(reader, request, pr):
    owner, name = request["fullName"].split("/")
    threads, cursor, seen = [], None, set()
    for _ in range(MAX_PAGES):
        graph, _ = reader.read("/graphql", {"query": THREAD_QUERY, "variables": {"owner": owner, "name": name, "number": request["pullNumber"], "cursor": cursor}})
        if graph.get("errors"):
            raise EvidenceError("github_snapshot_incomplete")
        repo = graph["data"]["repository"]
        graph_pr = repo["pullRequest"]
        if identifier(repo["databaseId"]) != request["providerRepositoryId"] or identifier(graph_pr["databaseId"]) != pr["id"] or graph_pr["headRefOid"] != pr["headSha"]:
            raise EvidenceError("github_revision_changed")
        page = graph_pr["reviewThreads"]
        if not isinstance(page["nodes"], list) or len(page["nodes"]) > 100 or type(page["pageInfo"]["hasNextPage"]) is not bool:
            raise EvidenceError("github_invalid_response")
        threads.extend({"id": node["id"], "isResolved": node["isResolved"], "isOutdated": node["isOutdated"]} for node in page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]
        if not isinstance(cursor, str) or not 1 <= len(cursor) <= 1000 or cursor in seen:
            raise EvidenceError("github_invalid_pagination")
        seen.add(cursor)
    else:
        raise EvidenceError("github_snapshot_incomplete")
    return threads


def collect(value):
    request = parameters(value)
    reader = Reader(AUTH.external_token())
    identity, _ = reader.read("/user")
    if identifier(identity["id"]) != request["providerAccountId"]:
        raise EvidenceError("github_account_changed")
    prefix = "/repos/" + request["fullName"]
    repository, _ = reader.read(prefix)
    if identifier(repository["id"]) != request["providerRepositoryId"] or repository["full_name"].lower() != request["fullName"].lower():
        raise EvidenceError("github_repository_changed")
    pr_path = prefix + "/pulls/" + str(request["pullNumber"])
    pr = pull(reader.read(pr_path)[0], request)
    runs = paginate(reader, prefix + "/actions/runs", request["providerRepositoryId"], "workflow_runs", {"head_sha": request["expectedHeadSha"]})
    if len(runs) > 20:
        raise EvidenceError("github_snapshot_limit")
    workflow_runs = []
    for run in runs:
        if identifier(run["repository"]["id"]) != request["providerRepositoryId"] or run["head_sha"] != request["expectedHeadSha"]:
            raise EvidenceError("github_repository_changed")
        jobs = paginate(reader, prefix + "/actions/runs/" + identifier(run["id"]) + "/attempts/" + str(run["run_attempt"]) + "/jobs", request["providerRepositoryId"], "jobs")
        workflow_runs.append({"id": identifier(run["id"]), "workflowId": identifier(run["workflow_id"]), "checkSuiteId": identifier(run["check_suite_id"]),
                              "runNumber": run["run_number"], "runAttempt": run["run_attempt"], "headSha": run["head_sha"], "status": run["status"],
                              "conclusion": run["conclusion"], "updatedAt": run["updated_at"], "event": run["event"],
                              "jobs": [{"id": identifier(job["id"]), "runId": identifier(job["run_id"]), "runAttempt": job["run_attempt"], "name": job["name"],
                                        "status": job["status"], "conclusion": job["conclusion"], "startedAt": job["started_at"], "completedAt": job["completed_at"],
                                        "checkRunUrl": job["check_run_url"]} for job in jobs]})
    checks = paginate(reader, prefix + "/commits/" + request["expectedHeadSha"] + "/check-runs", request["providerRepositoryId"], "check_runs", {"filter": "all"})
    reviews = paginate(reader, pr_path + "/reviews", request["providerRepositoryId"])
    comments = paginate(reader, prefix + "/issues/" + str(request["pullNumber"]) + "/comments", request["providerRepositoryId"])
    threads = review_threads(reader, request, pr)
    # Recheck identity, stable repository and exact current PR after all pages.
    final = pull(reader.read(pr_path)[0], request)
    final_repo = reader.read(prefix)[0]
    final_user = reader.read("/user")[0]
    if final != pr or identifier(final_repo["id"]) != request["providerRepositoryId"]:
        raise EvidenceError("github_revision_changed")
    if identifier(final_user["id"]) != request["providerAccountId"]:
        raise EvidenceError("github_account_changed")
    # A rerun may appear while the PR head stays unchanged. Re-fetch workflow
    # revisions and checks, rather than accepting an old success from that race.
    final_runs = paginate(reader, prefix + "/actions/runs", request["providerRepositoryId"], "workflow_runs", {"head_sha": request["expectedHeadSha"]})
    run_fields = ("id", "workflow_id", "run_number", "run_attempt", "head_sha", "status", "conclusion", "updated_at", "check_suite_id")
    run_versions = lambda values: sorted([json.dumps([run.get(k) for k in run_fields], separators=(",", ":")) for run in values])
    if run_versions(final_runs) != run_versions(runs):
        raise EvidenceError("github_run_changed")
    final_checks = paginate(reader, prefix + "/commits/" + request["expectedHeadSha"] + "/check-runs", request["providerRepositoryId"], "check_runs", {"filter": "all"})
    check_fields = ("id", "head_sha", "name", "status", "conclusion", "started_at", "completed_at", "check_suite", "app")
    check_versions = lambda values: sorted([json.dumps([check.get(k) for k in check_fields], sort_keys=True, separators=(",", ":")) for check in values])
    if check_versions(final_checks) != check_versions(checks):
        raise EvidenceError("github_run_changed")
    final_reviews = paginate(reader, pr_path + "/reviews", request["providerRepositoryId"])
    final_comments = paginate(reader, prefix + "/issues/" + str(request["pullNumber"]) + "/comments", request["providerRepositoryId"])
    final_threads = review_threads(reader, request, pr)
    stable = lambda records: sorted(json.dumps(record, sort_keys=True, separators=(",", ":")) for record in records)
    if stable(final_reviews) != stable(reviews) or stable(final_comments) != stable(comments) or stable(final_threads) != stable(threads):
        raise EvidenceError("github_review_changed")
    if pull(reader.read(pr_path)[0], request) != pr:
        raise EvidenceError("github_revision_changed")
    return {"schemaVersion": 1, "provider": "github", "providerAccountId": request["providerAccountId"],
            "repository": {"id": request["providerRepositoryId"], "fullName": repository["full_name"]}, "pullRequest": pr,
            "observedAt": datetime.now(timezone.utc).isoformat(), "collectionsComplete": True, "workflowRuns": workflow_runs,
            "checks": [{"id": identifier(check["id"]), "checkSuiteId": identifier(check["check_suite"]["id"]), "name": check["name"], "headSha": check["head_sha"],
                        "status": check["status"], "conclusion": check["conclusion"], "startedAt": check["started_at"], "completedAt": check["completed_at"],
                        "appId": identifier(check["app"]["id"]), "appSlug": check["app"]["slug"]} for check in checks],
            "reviews": [{"id": identifier(review["id"]), "userId": identifier(review["user"]["id"]), "state": review["state"], "commitId": review["commit_id"],
                         "submittedAt": review.get("submitted_at"), "bodyDigest": hashlib.sha256((review.get("body") or "").encode()).hexdigest()} for review in reviews],
            "reviewSummaries": [{"id": identifier(comment["id"]), "userId": identifier(comment["user"]["id"]), "userType": comment["user"]["type"],
                                 "appId": identifier(comment["performed_via_github_app"]["id"]) if comment.get("performed_via_github_app") else None,
                                 "updatedAt": comment["updated_at"], "createdAt": comment["created_at"], **marker(comment["body"])} for comment in comments],
            "reviewThreads": threads}


def main():
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise EvidenceError("request_too_large")
        result, status = collect(json.loads(raw)), 0
    except (EvidenceError, AUTH.DiscoveryError) as error:
        result, status = {"schemaVersion": 1, "error": str(error)}, 1
    except Exception:
        result, status = {"schemaVersion": 1, "error": "github_evidence_unavailable"}, 1
    print(json.dumps(result, separators=(",", ":")))
    return status


if __name__ == "__main__":
    sys.exit(main())
