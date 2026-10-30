"""Read-only preview registry guard/proof; publishing stays in the reviewed job."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

REGISTRY = "https://ghcr.io"
PACKAGE = "kethalia/hive-base"
ACCEPT = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def fetch(path, token=None):
    require(path.startswith(REGISTRY + "/"))
    headers = {"Accept": ACCEPT}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(path, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=10) as response:
            raw = response.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024)
            return response.status, raw, response.headers
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return 404, b"", {}
        raise RuntimeError("preview_registry_unavailable") from None


def require(value):
    if not value:
        raise RuntimeError("workspace_image_preview_rejected")


def run(mode):
    source = os.environ.get("EXPECTED_SOURCE_SHA", "")
    require(re.fullmatch("[a-f0-9]{40}", source) is not None)
    require(os.environ.get("GITHUB_SHA") == source and os.environ.get("GITHUB_REPOSITORY") == "kethalia/hive" and os.environ.get("GITHUB_REF") == "refs/heads/codex/delivery-system-design")
    tag = "preview-cli-" + source
    status, raw, _ = fetch(REGISTRY + "/token?service=ghcr.io&scope=repository:kethalia/hive-base:pull")
    require(status == 200)
    token = json.loads(raw).get("token")
    require(isinstance(token, str) and 0 < len(token) <= 8192)
    # Anonymous pull of the already-existing package confirms its public scope.
    status, _, _ = fetch(REGISTRY + "/v2/" + PACKAGE + "/manifests/cli-latest", token)
    require(status == 200)
    status, raw, headers = fetch(REGISTRY + "/v2/" + PACKAGE + "/manifests/" + tag, token)
    if mode == "absent":
        require(status == 404)
        return {"schemaVersion": 1, "sourceSha": source, "publicPackage": True, "targetAbsent": True, "imageTag": "ghcr.io/" + PACKAGE + ":" + tag}
    require(mode == "published" and status == 200)
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    require(headers.get("Docker-Content-Digest") == digest)
    manifest = json.loads(raw)
    config_digest = os.environ.get("EXPECTED_CONFIG_DIGEST", "")
    require(re.fullmatch("sha256:[a-f0-9]{64}", config_digest) is not None and manifest.get("config", {}).get("digest") == config_digest)
    pin = json.loads(Path("/tmp/workspace-preview-helper.json").read_text())
    require(set(pin) == {"schemaVersion", "sdkVersion", "goVersion", "sha256"} and type(pin["schemaVersion"]) is int and pin["schemaVersion"] == 1 and pin["sdkVersion"] == "v2.38.4" and pin["goVersion"] == "go1.26.10" and re.fullmatch("[a-f0-9]{64}", pin["sha256"]) is not None)
    return {"schemaVersion": 1, "sourceSha": source, "publicPackage": True, "image": "ghcr.io/" + PACKAGE + "@" + digest, "imageTag": "ghcr.io/" + PACKAGE + ":" + tag, "imageConfigDigest": config_digest, "helperSha256": pin["sha256"], "sdkVersion": pin["sdkVersion"], "goVersion": pin["goVersion"], "activation": False}


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2)
        print(json.dumps(run(sys.argv[1]), sort_keys=True, separators=(",", ":")))
    except Exception:
        print("workspace_image_preview_rejected", file=sys.stderr)
        raise SystemExit(1) from None
