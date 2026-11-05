#!/usr/bin/env python3
"""Verify a controller archive token and archive a released managed checkout.

This never adopts or deletes a user checkout. The fixed private host config owns
its issuer key; stdin cannot choose a key, path, repository URL, or authority.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True

def require(value):
    if not value:
        raise ValueError("archive_rejected")

def decode(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]+", value))
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

def main():
    require(len(sys.argv) == 1)
    raw = sys.stdin.buffer.read(16385)
    require(len(raw) <= 16384)
    request = json.loads(raw)
    require(isinstance(request, dict) and set(request) == {"token"})
    token = request["token"]
    require(isinstance(token, str) and len(token) <= 15000)
    parts = token.split(".")
    require(len(parts) == 2)
    signature = decode(parts[1])
    claims = json.loads(decode(parts[0]))
    home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    config_path = home / ".config/hive/codex-host.json"
    info = config_path.lstat()
    require(config_path.resolve() == config_path and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077 and info.st_size <= 16384)
    config = json.loads(config_path.read_text())
    require(claims.get("schemaVersion") == 1 and claims.get("ownerId") == config["binding"]["ownerId"] and claims.get("hiveUserId") == config["binding"]["hiveUserId"] and claims.get("workspaceId") == config["binding"]["workspaceId"] and claims.get("buildId") == config["binding"]["buildId"])
    require(isinstance(claims.get("expiresAt"), int) and int(time.time() * 1000) < claims["expiresAt"] <= int(time.time() * 1000) + 60000)
    with tempfile.TemporaryDirectory(prefix="hive-epic-verify-") as directory:
        temp = Path(directory)
        (temp / "key").write_text(config["issuerPublicKeyPem"])
        (temp / "message").write_bytes(("hive-project-archive-v1\n" + parts[0]).encode())
        (temp / "signature").write_bytes(signature)
        result = subprocess.run(["/usr/bin/openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(temp / "key"), "-rawin", "-in", str(temp / "message"), "-sigfile", str(temp / "signature")], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        require(result.returncode == 0)
    spec = importlib.util.spec_from_file_location("hive_epic_managed", Path(__file__).with_name("managed-projects.py"))
    managed = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = managed
    spec.loader.exec_module(managed)
    class Authority:
        def verify(self, evidence, expected):
            require(evidence == token and expected["repositoryId"] == claims["repositoryId"] and expected["taskId"] == claims["taskId"] and expected["leaseId"] == claims["leaseId"] and expected["leaseGeneration"] == claims["leaseGeneration"] and expected["checkoutIncarnation"] == claims["checkoutIncarnation"] and expected["revision"] == claims["acceptedSourceSha"])
            return {"binding": expected, "treeReceiptDigest": claims["treeReceiptDigest"], "preservationDigest": claims["preservationDigest"], "leaseReleaseDigest": claims["leaseReleaseDigest"]}
    result = managed.ManagedProjects(home)._archive_accepted_source(claims["repositoryId"], claims["taskId"], token, Authority())
    print(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "archive_rejected"}), file=sys.stderr)
        sys.exit(1)
