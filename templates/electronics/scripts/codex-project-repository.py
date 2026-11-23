#!/usr/bin/env python3
"""Managed-host repository resolution using the workspace's existing GitHub login."""
import importlib.util
import json
from pathlib import Path
import re
import sys
import urllib.parse

spec = importlib.util.spec_from_file_location("workspace_github", Path(__file__).with_name("github-projects.py"))
github = importlib.util.module_from_spec(spec)
spec.loader.exec_module(github)
DiscoveryError = github.DiscoveryError
github_json = github.github_json
repository = github.repository
workspace_token = github.workspace_token

def valid_branch(value):
    return (isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,150}", value)
            and ".." not in value and "//" not in value
            and all(not part.startswith(".") and not part.endswith(".lock") for part in value.split("/"))
            and not value.endswith(("/", ".")))


def resolve_repository(value):
    explicit_ref = isinstance(value, dict) and value.get("operation") == "resolve_ref"
    required = {"schemaVersion", "operation", "repositoryId", "expectedAccountId"} | ({"branch"} if explicit_ref else set())
    if (not isinstance(value, dict) or set(value) != required
            or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1
            or value.get("operation") not in ("resolve", "resolve_ref")
            or (explicit_ref and not valid_branch(value.get("branch")))
            or any(not isinstance(value.get(field), str) or not re.fullmatch(r"[1-9][0-9]{0,19}", value[field])
                   for field in ("repositoryId", "expectedAccountId"))):
        raise DiscoveryError("invalid_request")
    token = workspace_token()
    identity, _ = github_json(token, "/user")
    if not isinstance(identity, dict) or type(identity.get("id")) is not int or str(identity["id"]) != value["expectedAccountId"]:
        raise DiscoveryError("github_auth_required")
    raw, _ = github_json(token, f"/repositories/{value['repositoryId']}")
    metadata = repository(raw)
    if (metadata["providerRepositoryId"] != value["repositoryId"] or metadata["permissions"]["pull"] is not True
            or raw.get("clone_url") != metadata["htmlUrl"] + ".git"):
        raise DiscoveryError("github_permission_denied")
    source_branch = value["branch"] if explicit_ref else metadata["defaultBranch"]
    encoded_branch = urllib.parse.quote(source_branch, safe="/")
    record, _ = github_json(token, f"/repos/{metadata['owner']}/{metadata['name']}/git/ref/heads/{encoded_branch}")
    if (not isinstance(record, dict) or record.get("ref") != "refs/heads/" + source_branch
            or not isinstance(record.get("object"), dict) or record["object"].get("type") != "commit"
            or not isinstance(record["object"].get("sha"), str)
            or not re.fullmatch(r"[a-f0-9]{40}", record["object"]["sha"])):
        raise DiscoveryError("github_invalid_response")
    result = {"schemaVersion": 1, "providerAccountId": str(identity["id"]), "repository": metadata}
    if explicit_ref:
        result.update(branch=source_branch, revision=record["object"]["sha"])
    else:
        result["defaultRevision"] = record["object"]["sha"]
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(github.REQUEST_LIMIT + 1)
        if len(raw) > github.REQUEST_LIMIT:
            raise DiscoveryError("request_too_large")
        value = json.loads(raw)
        result = resolve_repository(value) if isinstance(value, dict) and "operation" in value else github.discover(value)
        status = 0
    except DiscoveryError as error:
        result, status = {"schemaVersion": 1, "error": str(error)}, 1
    except Exception:
        result, status = {"schemaVersion": 1, "error": "discovery_unavailable"}, 1
    print(json.dumps(result, separators=(",", ":")))
    return status


if __name__ == "__main__":
    sys.exit(main())
