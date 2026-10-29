#!/usr/bin/env python3
"""Bounded workspace-local GitHub discovery; never clone or emit credentials.

Protocol: stdin {schemaVersion:1,page?:1,perPage?:100}; stdout one JSON result.
Pagination is explicit. Search belongs over the caller's owner-scoped page cache,
not GitHub's public repository search. No request may choose an API origin/provider.

Sources: https://coder.com/docs/reference/cli/external-auth/access-token
https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user
This asset is disabled/unintegrated until a trusted owner/workspace bridge invokes it.
"""
import json
import os
import re
import selectors
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

API_ORIGIN = "https://api.github.com"
REQUEST_LIMIT = 4096
TOKEN_LIMIT = 4096
RESPONSE_LIMIT = 4 * 1024 * 1024
TIMEOUT = 10
MAX_PAGE = 10000
API_VERSION = "2026-03-10"


class DiscoveryError(Exception):
    """Fixed, non-sensitive error codes only; never include provider response text."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_parameters(value):
    if not isinstance(value, dict) or set(value) - {"schemaVersion", "page", "perPage"}:
        raise DiscoveryError("invalid_request")
    if type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
        raise DiscoveryError("unsupported_schema")
    page, per_page = value.get("page", 1), value.get("perPage", 100)
    if type(page) is not int or not 1 <= page <= MAX_PAGE:
        raise DiscoveryError("invalid_page")
    if type(per_page) is not int or not 1 <= per_page <= 100:
        raise DiscoveryError("invalid_page_size")
    return page, per_page


def external_token():
    # No owner CLI token, config/keyring, custom headers, debug logger, proxy, or
    # caller-supplied provider/command is inherited. Only agent auth is permitted.
    if not os.environ.get("CODER_AGENT_TOKEN") and not os.environ.get("CODER_AGENT_TOKEN_FILE"):
        raise DiscoveryError("workspace_agent_required")
    if not os.environ.get("CODER_AGENT_URL"):
        raise DiscoveryError("workspace_agent_required")
    environment = {key: os.environ[key] for key in (
        "PATH", "HOME", "CODER_AGENT_TOKEN", "CODER_AGENT_TOKEN_FILE", "CODER_AGENT_URL",
    ) if key in os.environ}
    environment.update({"NO_COLOR": "1", "TERM": "dumb"})
    deadline = time.monotonic() + TIMEOUT
    try:
        with tempfile.TemporaryDirectory(prefix="hive-github-auth-") as config:
            command = ["coder", "--global-config", config, "--use-keyring=false",
                       "--flight-recorder-size=0", "external-auth", "access-token",
                       "github", "--auth", "token"]
            with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=environment) as process:
                output = bytearray()
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        while True:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0 or not selector.select(remaining):
                                raise DiscoveryError("external_auth_timeout")
                            chunk = os.read(process.stdout.fileno(), TOKEN_LIMIT + 1 - len(output))
                            if not chunk:
                                break
                            output.extend(chunk)
                            if len(output) > TOKEN_LIMIT:
                                raise DiscoveryError("external_auth_invalid_response")
                    status = process.wait(timeout=max(0.001, deadline - time.monotonic()))
                    if status != 0:
                        # Coder prints an authentication URL on stdout with exit 1.
                        # Do not return it or accidentally use it as a bearer token.
                        raise DiscoveryError("github_auth_required" if status == 1 else "external_auth_unavailable")
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
    except DiscoveryError:
        raise
    except subprocess.TimeoutExpired:
        raise DiscoveryError("external_auth_timeout") from None
    except (OSError, ValueError):
        raise DiscoveryError("external_auth_unavailable") from None
    try:
        token = bytes(output).decode("ascii").strip()
    except UnicodeDecodeError:
        raise DiscoveryError("external_auth_invalid_response") from None
    if not token or not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token) or "://" in token:
        raise DiscoveryError("external_auth_invalid_response")
    return token


def repository(record):
    try:
        identifier = record["id"]
        owner, name = record["owner"]["login"], record["name"]
        node_id = record["node_id"]
        branch = record["default_branch"]
        if (type(identifier) is not int or not 0 < identifier < 10**20 or
                not isinstance(owner, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", owner) or
                not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", name) or name in {".", ".."} or
                record["full_name"] != f"{owner}/{name}" or
                not isinstance(node_id, str) or not re.fullmatch(r"[A-Za-z0-9_=/+-]{1,256}", node_id) or
                not isinstance(branch, str) or not 1 <= len(branch) <= 255 or
                any(ord(character) < 32 or ord(character) == 127 for character in branch) or
                type(record["private"]) is not bool or type(record["archived"]) is not bool):
            raise DiscoveryError("github_invalid_response")
        permissions = record.get("permissions", {})
        if not isinstance(permissions, dict):
            raise DiscoveryError("github_invalid_response")
        return {"provider": "github", "providerRepositoryId": str(identifier),
                "nodeId": node_id, "fullName": record["full_name"], "name": name,
                "owner": owner, "defaultBranch": branch, "private": record["private"],
                "archived": record["archived"], "htmlUrl": f"https://github.com/{owner}/{name}",
                "permissions": {key: permissions.get(key) if type(permissions.get(key)) is bool else None
                                for key in ("pull", "push", "admin")}}
    except (KeyError, TypeError, AttributeError):
        raise DiscoveryError("github_invalid_response") from None


def next_page(link, page, per_page):
    if not link:
        return None
    if len(link) > 8192:
        raise DiscoveryError("github_invalid_pagination")
    candidates = []
    for section in link.split(","):
        match = re.fullmatch(r'\s*<([^>]+)>;\s*rel="([a-z ]+)"\s*', section)
        if not match:
            raise DiscoveryError("github_invalid_pagination")
        if "next" not in match[2].split():
            continue
        url = urllib.parse.urlsplit(match[1])
        values = urllib.parse.parse_qs(url.query, strict_parsing=True)
        # Never follow a returned URL. Validate its exact fixed endpoint and next
        # numeric page, then reconstruct the request from integers on the next call.
        if (url.scheme != "https" or url.netloc != "api.github.com" or
                url.path != "/user/repos" or url.fragment or
                set(values) - {"page", "per_page", "sort", "direction", "affiliation", "visibility"} or
                values.get("page") != [str(page + 1)] or values.get("per_page") != [str(per_page)] or
                values.get("sort", ["full_name"]) != ["full_name"] or
                values.get("direction", ["asc"]) != ["asc"] or
                values.get("visibility", ["all"]) != ["all"] or
                values.get("affiliation", ["owner,collaborator,organization_member"]) != ["owner,collaborator,organization_member"]):
            raise DiscoveryError("github_invalid_pagination")
        candidates.append(page + 1)
    if len(candidates) > 1:
        raise DiscoveryError("github_invalid_pagination")
    if candidates and page == MAX_PAGE:
        raise DiscoveryError("pagination_limit_reached")
    return candidates[0] if candidates else None


def github_json(token, path):
    allowed_repository = re.fullmatch(r"/repositories/[1-9][0-9]{0,19}", path)
    allowed_commit = re.fullmatch(r"/repos/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}/commits/(?:[A-Za-z0-9._~-]|%[0-9A-F]{2}){1,765}", path)
    if path != "/user" and not path.startswith("/user/repos?") and not allowed_repository and not allowed_commit:
        raise DiscoveryError("invalid_request")
    request = urllib.request.Request(f"{API_ORIGIN}{path}", headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION, "User-Agent": "Hive-project-discovery/1",
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            if response.status != 200:
                raise DiscoveryError("github_unavailable")
            deadline = time.monotonic() + TIMEOUT
            payload = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise DiscoveryError("github_timeout")
                chunk = response.read1(min(65536, RESPONSE_LIMIT + 1 - len(payload)))
                if not chunk:
                    break
                payload.extend(chunk)
                if len(payload) > RESPONSE_LIMIT:
                    raise DiscoveryError("github_response_too_large")
            return json.loads(payload), response.headers
    except urllib.error.HTTPError as error:
        if error.code == 401:
            code = "github_auth_required"
        elif error.code == 429 or (error.code == 403 and error.headers.get("X-RateLimit-Remaining") == "0"):
            code = "github_rate_limited"
        elif error.code == 403:
            code = "github_permission_denied"
        elif 300 <= error.code < 400:
            code = "github_redirect_rejected"
        else:
            code = "github_unavailable"
        error.close()
        raise DiscoveryError(code) from None
    except (TimeoutError, urllib.error.URLError):
        raise DiscoveryError("github_unavailable") from None
    except (ValueError, UnicodeDecodeError):
        raise DiscoveryError("github_invalid_response") from None

def discover(value):
    page, per_page = request_parameters(value)
    token = external_token()
    # Capture identity and repositories using exactly the same token. A reconnect
    # cannot silently append a different account's repositories to a cached page.
    identity, _ = github_json(token, "/user")
    if not isinstance(identity, dict) or type(identity.get("id")) is not int or not 0 < identity["id"] < 10**20:
        raise DiscoveryError("github_invalid_response")
    query = urllib.parse.urlencode({"page": page, "per_page": per_page, "sort": "full_name",
                                   "direction": "asc", "visibility": "all"})
    records, headers = github_json(token, f"/user/repos?{query}")
    if not isinstance(records, list) or len(records) > per_page:
        raise DiscoveryError("github_invalid_response")
    projects = [repository(record) for record in records]
    if len({item["providerRepositoryId"] for item in projects}) != len(projects):
        raise DiscoveryError("github_invalid_response")
    following = next_page(headers.get("Link", ""), page, per_page)
    return {"schemaVersion": 1, "provider": "github", "providerAccountId": str(identity["id"]),
            "repositories": projects, "page": page, "perPage": per_page, "nextPage": following}


def resolve_repository(value):
    if (not isinstance(value, dict) or set(value) != {"schemaVersion", "operation", "repositoryId", "expectedAccountId"}
            or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1
            or value.get("operation") != "resolve"
            or any(not isinstance(value.get(field), str) or not re.fullmatch(r"[1-9][0-9]{0,19}", value[field])
                   for field in ("repositoryId", "expectedAccountId"))):
        raise DiscoveryError("invalid_request")
    token = external_token()
    identity, _ = github_json(token, "/user")
    if not isinstance(identity, dict) or type(identity.get("id")) is not int or str(identity["id"]) != value["expectedAccountId"]:
        raise DiscoveryError("github_auth_required")
    raw, _ = github_json(token, f"/repositories/{value['repositoryId']}")
    metadata = repository(raw)
    if (metadata["providerRepositoryId"] != value["repositoryId"] or metadata["permissions"]["pull"] is not True
            or raw.get("clone_url") != metadata["htmlUrl"] + ".git"):
        raise DiscoveryError("github_permission_denied")
    branch = urllib.parse.quote(metadata["defaultBranch"], safe="")
    commit, _ = github_json(token, f"/repos/{metadata['owner']}/{metadata['name']}/commits/{branch}")
    if not isinstance(commit, dict) or not isinstance(commit.get("sha"), str) or not re.fullmatch(r"[a-f0-9]{40}", commit["sha"]):
        raise DiscoveryError("github_invalid_response")
    return {"schemaVersion": 1, "providerAccountId": str(identity["id"]), "repository": metadata,
            "defaultRevision": commit["sha"]}


def main():
    try:
        raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
        if len(raw) > REQUEST_LIMIT:
            raise DiscoveryError("request_too_large")
        value = json.loads(raw)
        result = resolve_repository(value) if isinstance(value, dict) and value.get("operation") == "resolve" else discover(value)
        status = 0
    except DiscoveryError as error:
        result, status = {"schemaVersion": 1, "error": str(error)}, 1
    except Exception:
        # No traceback, CLI stdout/stderr, token, remote body, or arbitrary URL.
        result, status = {"schemaVersion": 1, "error": "discovery_unavailable"}, 1
    print(json.dumps(result, separators=(",", ":")))
    return status


if __name__ == "__main__":
    sys.exit(main())
