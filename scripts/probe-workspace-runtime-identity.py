"""Read-only runtime receipt inspection. Fixed paths; no agent credential output."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import sys

HOME = Path("/home/coder")


def require(value):
    if not value:
        raise RuntimeError("runtime_receipt_invalid")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n"


def read(path, limit, private=True):
    path = Path(path)
    if private:
        require(path.resolve() == path)
    else:
        # Fixed provisioner downward-API mounts use symlinks inside their mount.
        resolved = path.resolve()
        require(str(resolved).startswith(str(path.parent) + "/"))
        path = resolved
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit)
        require((info.st_uid == os.getuid() and not info.st_mode & 0o077) if private else (info.st_uid == 0 and not info.st_mode & 0o022))
        raw = bytearray()
        while len(raw) <= limit:
            block = os.read(fd, min(65536, limit + 1 - len(raw)))
            if not block:
                break
            raw.extend(block)
        require(len(raw) <= limit and len(raw) == info.st_size)
        return bytes(raw)
    finally:
        os.close(fd)


def verify_package(package, manifest_name, expected_sha):
    raw = read(package / manifest_name, 262144)
    require(sha(raw) == expected_sha)
    manifest = json.loads(raw)
    require(isinstance(manifest.get("files"), dict) and 1 <= len(manifest["files"]) <= 256)
    total = 0
    for name, digest in manifest["files"].items():
        require(isinstance(name, str) and not name.startswith("/") and not any(p in ("", ".", "..") for p in name.split("/")))
        content = read(package / name, 2 * 1024 * 1024)
        total += len(content)
        require(total <= 4 * 1024 * 1024 and sha(content) == digest)


def process(record, expected_argv):
    require(isinstance(record, dict) and type(record.get("pid")) is int and record["pid"] > 0)
    root = Path("/proc") / str(record["pid"])
    before = (root / "stat").read_text()
    fields = before[before.rindex(") ") + 2:].split()
    require(fields[0] not in ("Z", "X") and fields[19] == record["startTime"])
    require(Path("/proc/sys/kernel/random/boot_id").read_text().strip() == record["bootId"])
    require(root.stat().st_uid == os.getuid())
    executable = os.readlink(root / "exe")
    require(executable == record["executable"] == "/usr/bin/node")
    if "executableSha256" in record:
        require(sha((root / "exe").read_bytes()) == record["executableSha256"])
    with (root / "cmdline").open("rb") as stream:
        argv = stream.read(8193)
    require(len(argv) <= 8192 and argv.rstrip(b"\0").split(b"\0") == [p.encode() for p in expected_argv])
    with (root / "environ").open("rb") as stream:
        environment = stream.read(131073)
    require(len(environment) <= 131072)
    keys = {part.split(b"=", 1)[0] for part in environment.split(b"\0") if b"=" in part}
    after = (root / "stat").read_text()
    current = after[after.rindex(") ") + 2:].split()
    require(current[0] not in ("Z", "X") and current[19] == record["startTime"] and os.readlink(root / "exe") == executable)
    return keys


def identity(config, receipt, bootstrap, expected, helper_sha):
    require(config["binding"] == {k: expected[k] for k in config["binding"]})
    raw_config = canonical(config)
    require(sha(raw_config) == receipt["configSha256"])
    require(sha(canonical(bootstrap["config"])) == receipt["bootstrapConfigSha256"])
    value = receipt["runtimeIdentity"]
    require(value["sdkVersion"] == "v2.38.4" and value["helperSha256"] == helper_sha)
    for key in ("coderOrigin", "workspaceId", "buildId", "appId", "appOrigin"):
        require(value[key] == expected[key])
    require(value["agentId"] == expected["agentId"] == config["binding"]["agentId"])
    require(value["provisionalAgentId"] == bootstrap["config"]["binding"]["agentId"] != value["agentId"])
    fields = ["schemaVersion", "sdkVersion", "kind", "coderOrigin", "workspaceId", "buildId", "appId", "appOrigin", "provisionalAgentId", "agentId"]
    selected = {key: value[key] for key in fields}
    require(sha(json.dumps(selected, separators=(",", ":"), ensure_ascii=False).encode()) == value["manifestBindingSha256"])
    return {"bootstrapConfigSha256": receipt["bootstrapConfigSha256"], "effectiveConfigSha256": receipt["configSha256"], "manifestBindingSha256": value["manifestBindingSha256"], "agentNormalized": True}


def inspect(value):
    plan, read_binding, host_binding = value["plan"], value["readBinding"], value["hostBinding"]
    helper = Path("/usr/local/libexec/hive-workspace-identity")
    info = helper.lstat()
    require(0 < info.st_size <= 64 * 1024 * 1024 and helper.resolve() == helper and info.st_uid == 0 and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o022)
    require(sha(helper.read_bytes()) == plan["helperSha256"])
    pin = json.loads(read(helper.with_suffix(".json"), 4096, False))
    require(pin == {"schemaVersion": 1, "sdkVersion": "v2.38.4", "goVersion": "go1.26.10", "sha256": plan["helperSha256"]})
    require(os.environ.get("HIVE_RUNTIME_BUILD_ID") == plan["buildId"])
    read_config_raw = read(HOME / ".config/hive/workspace-read.json", 32768)
    read_config = json.loads(read_config_raw)
    require(read_config_raw == canonical(read_config))
    envelope = json.loads(read(HOME / ".local/state/hive/workspace-read/service.json", 65536))
    key = read(HOME / ".local/state/hive/workspace-read/receipt-key", 32)
    require(len(key) == 32 and hmac.compare_digest(envelope["signature"], hmac.new(key, canonical(envelope["record"]).rstrip(b"\n"), hashlib.sha256).hexdigest()))
    read_receipt = envelope["record"]
    require(read_receipt["phase"] == "ready" and read_receipt["lifetimeId"] == value["readLifetimeId"])
    read_bootstrap = json.loads(read("/opt/hive-workspace-read-template/request.json", 3 * 1024 * 1024, False))
    read_result = identity(read_config, read_receipt, read_bootstrap, read_binding, plan["helperSha256"])
    require(read_receipt["archiveSha256"] == read_bootstrap["archiveSha256"] == plan["readArchiveSha256"])
    require(read_config["manifestSha256"] == read_bootstrap["manifestSha256"] == plan["readManifestSha256"])
    require(read_config["projectsRoot"] == plan["projectsRoot"])
    package = HOME / ".local/share/hive/workspace-read" / plan["readArchiveSha256"]
    require(read_config["packageDirectory"] == str(package))
    verify_package(package, "manifest.json", plan["readManifestSha256"])
    keys = process(read_receipt["process"], ["/usr/bin/node", str(package / "hive-workspace-read.mjs")])
    require(not any(key.startswith(b"CODER_AGENT_") or key in (b"CODER_SESSION_TOKEN", b"CODER_CONFIG_DIR") for key in keys))
    host_config_raw = read(HOME / ".config/hive/codex-host.json", 16384)
    host_config = json.loads(host_config_raw)
    require(host_config_raw == canonical(host_config))
    host_receipt = json.loads(read(HOME / ".local/state/hive/codex-host-install/process.json", 16384))
    host_bootstrap = json.loads(read("/opt/hive-codex-host-template/request.json", 3 * 1024 * 1024, False))
    host_result = identity(host_config, host_receipt, host_bootstrap, host_binding, plan["helperSha256"])
    require(host_receipt["archiveSha256"] == host_bootstrap["archiveSha256"] == plan["hostArchiveSha256"])
    require(not host_config["managerEnabled"] and host_config.get("deliveryExecutionEnabled") is not True)
    host_package = HOME / ".local/share/hive/codex-host" / plan["hostArchiveSha256"]
    verify_package(host_package, "package-manifest.json", plan["hostManifestSha256"])
    host_entry = "codex-workspace-host-outer.mjs" if host_config.get("guardianEnabled") is True else "codex-workspace-host.mjs"
    host_keys = process(host_receipt["process"], ["/usr/bin/node", str(host_package / host_entry)])
    require(b"CODER_SESSION_TOKEN" not in host_keys)
    require(read_receipt["runtimeIdentity"]["provisionalAgentId"] == host_receipt["runtimeIdentity"]["provisionalAgentId"])
    return {"schemaVersion": 1, "passed": True, "helperRootPinMatches": True, "manifestBuildEnvironmentMatches": True, "readReceiptHmacVerified": True, "readPackageFilesVerified": True, "hostPackageFilesVerified": True, "readProcessIdentityVerified": True, "readServiceNoAgentOrOwnerCredential": True, "sameRuntimeAgentAcrossApps": True, "hostManagerDisabled": True, "hostOuterNoOwnerCredential": True, "read": read_result, "host": host_result}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(16385)
        require(len(raw) <= 16384)
        print(json.dumps(inspect(json.loads(raw)), sort_keys=True, separators=(",", ":")))
    except Exception:
        print(json.dumps({"schemaVersion": 1, "passed": False, "failureCode": "runtime_receipt_invalid"}))
        raise SystemExit(1) from None
