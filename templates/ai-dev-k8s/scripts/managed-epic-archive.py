#!/usr/bin/env python3
"""Verify a controller archive token and archive a released managed checkout.

This never adopts or deletes a user checkout. The fixed private host config owns
its issuer key; stdin cannot choose a key, path, repository URL, or authority.
"""
import base64
import hashlib
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
    require(isinstance(request, dict))
    home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    if request.get("operation") == "cleanup-inspect":
        require(set(request) == {"operation", "repositoryId", "taskId"})
        spec = importlib.util.spec_from_file_location("hive_cleanup_managed", Path(__file__).with_name("managed-projects.py"))
        managed = importlib.util.module_from_spec(spec); sys.modules[spec.name] = managed; spec.loader.exec_module(managed)
        result = managed.ManagedProjects.installed(home)._inspect_cleanup(request["repositoryId"], request["taskId"])
        print(json.dumps(result, separators=(",", ":"))); return
    cleanup = request.get("operation") == "cleanup"
    require(set(request) == ({"operation", "token"} if cleanup else {"token"}))
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
    fd = os.open(config_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(fd); require((actual.st_dev, actual.st_ino) == (info.st_dev, info.st_ino) and actual.st_uid == os.getuid() and not actual.st_mode & 0o077)
        config_bytes = os.read(fd, 16385); require(len(config_bytes) <= 16384)
    finally: os.close(fd)
    config = json.loads(config_bytes)
    if cleanup: require(hashlib.sha256(config_bytes).hexdigest() == claims["configSha256"])
    require(claims.get("schemaVersion") == 1 and claims.get("ownerId") == config["binding"]["ownerId"] and claims.get("hiveUserId") == config["binding"]["hiveUserId"] and claims.get("workspaceId") == config["binding"]["workspaceId"] and claims.get("buildId") == config["binding"]["buildId"])
    require(isinstance(claims.get("expiresAt"), int) and (cleanup or int(time.time() * 1000) < claims["expiresAt"]) and claims["expiresAt"] <= int(time.time() * 1000) + 60000)
    if cleanup:
        require(claims.get("purpose") == "managed-checkout-cleanup" and isinstance(claims.get("issuedAt"), int) and 0 < claims["expiresAt"] - claims["issuedAt"] <= 45000 and claims["issuedAt"] <= int(time.time() * 1000))
    with tempfile.TemporaryDirectory(prefix="hive-epic-verify-") as directory:
        temp = Path(directory)
        (temp / "key").write_text(config["issuerPublicKeyPem"])
        (temp / "message").write_bytes((("hive-project-cleanup-v1\n" if cleanup else "hive-project-archive-v1\n") + parts[0]).encode())
        (temp / "signature").write_bytes(signature)
        result = subprocess.run(["/usr/bin/openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(temp / "key"), "-rawin", "-in", str(temp / "message"), "-sigfile", str(temp / "signature")], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        require(result.returncode == 0)
    spec = importlib.util.spec_from_file_location("hive_epic_managed", Path(__file__).with_name("managed-projects.py"))
    managed = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = managed
    spec.loader.exec_module(managed)
    if cleanup:
        spec = importlib.util.spec_from_file_location("hive_cleanup_private", Path(__file__).with_name("codex-project-terminal.py"))
        private = importlib.util.module_from_spec(spec); sys.modules[spec.name] = private; spec.loader.exec_module(private)
        canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        digest = lambda value: hashlib.sha256(canonical(value)).hexdigest()
        class CleanupAuthority:
            def verify_history(self, evidence, expected):
                require(evidence == token and claims["binding"] == expected)
                return {**claims, "authorizationToken": token}
            def verify(self, evidence, expected):
                require(int(time.time() * 1000) < claims["expiresAt"])
                return self.verify_history(evidence, expected)
            def before_remove(self, evidence, expected):
                self.verify(evidence, expected); return True
            def guardian(self):
                state = private.signed(home / ".local/state/hive/codex-host-guardian", "lifetime.json", "key", "state")
                require(state.get("phase") in {"open", "startupReady", "treeExited", "closed"})
                startup = state["events"][4]["value"]
                require(startup["lifetimeId"] == claims["lifetimeId"] and startup["configSha256"] == claims["configSha256"])
                observer = managed.InstalledSealedHostObserver(home)
                context = observer()
                if claims["lifetimeId"] == claims["closedLifetimeId"]:
                    receipts = [event["value"] for event in state["events"] if event["name"] == "treeExited"]
                    require(len(receipts) == 1 and state["phase"] in {"treeExited", "closed"})
                    receipt = receipts[0]
                    require(receipt.get("guardianExited") is True and receipt["finalWaitResult"] == "ECHILD" and receipt["waitFlags"] == "__WALL" and digest(receipt) == claims["treeReceiptDigest"] and receipt["workerBarrier"]["barrierId"] == claims["barrierId"] and context is None)
                return context
            def cleanup_receipt(self, expected):
                require(expected == claims["binding"])
                return {"schemaVersion": 1, "authorizationId": claims["authorizationId"], "authorizationDigest": digest(claims), "cleanupRequestId": expected["cleanupRequestId"], "bindingDigest": digest(expected), "outcome": "checkout_removed", "currentVolumeDigest": digest(claims["currentVolume"])}
        result = managed.ManagedProjects.installed(home)._remove_with_authority(claims["binding"]["repositoryId"], claims["binding"]["taskId"], token, CleanupAuthority())
        print(json.dumps(result, separators=(",", ":"))); return
    class Authority:
        def verify(self, evidence, expected):
            require(evidence == token and expected["repositoryId"] == claims["repositoryId"] and expected["taskId"] == claims["taskId"] and expected["leaseId"] == claims["leaseId"] and expected["leaseGeneration"] == claims["leaseGeneration"] and expected["checkoutIncarnation"] == claims["checkoutIncarnation"] and expected["revision"] == claims["acceptedSourceSha"])
            return {"binding": expected, "treeReceiptDigest": claims["treeReceiptDigest"], "preservationDigest": claims["preservationDigest"], "leaseReleaseDigest": claims["leaseReleaseDigest"]}
    result = managed.ManagedProjects.installed(home)._archive_accepted_source(claims["repositoryId"], claims["taskId"], token, Authority())
    print(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "archive_rejected"}), file=sys.stderr)
        sys.exit(1)
