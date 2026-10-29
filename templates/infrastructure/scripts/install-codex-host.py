#!/usr/bin/env python3
"""Install a template-pinned host package. Preserve all task journals and checkouts."""
import base64
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
from urllib.parse import urlparse
import uuid


def require(value):
    if not value:
        raise RuntimeError("Managed host installation rejected")


def private_directory(path):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077)
    return path


def private_file(path, limit=2 * 1024 * 1024):
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and not info.st_mode & 0o077 and info.st_size <= limit)
    return path.read_bytes()


def atomic(path, value):
    temp = path.with_name(f".{path.name}.{uuid.uuid4()}")
    with temp.open("xb") as out:
        os.chmod(temp, 0o600)
        out.write(value)
        out.flush()
        os.fsync(out.fileno())
    if path.exists() or path.is_symlink():
        private_file(path)
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def process_identity(pid):
    root = Path(f"/proc/{pid}")
    require(type(pid) is int and pid > 0 and root.stat().st_uid == os.getuid())
    raw = (root / "stat").read_text()
    fields = raw[raw.rindex(") ") + 2:].split()
    require(fields[0] != "Z")
    return {"pid": pid, "startTime": fields[19], "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "executable": os.readlink(root / "exe")}


def listener_owned(pid, port):
    try:
        sockets = set()
        for path in Path(f"/proc/{pid}/fd").iterdir():
            try:
                target = os.readlink(path)
                if target.startswith("socket:["):
                    sockets.add(target[8:-1])
            except FileNotFoundError:
                continue
        for line in Path("/proc/net/tcp").read_text().splitlines()[1:]:
            fields = line.split()
            if fields[1] == f"0100007F:{port:04X}" and fields[3] == "0A" and fields[9] in sockets:
                return True
    except (FileNotFoundError, ProcessLookupError):
        pass
    return False


def confirm_ready(identity, config):
    deadline = time.monotonic() + 20
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(f"http://127.0.0.1:{config['port']}/healthz", headers={"Host": urlparse(config["binding"]["appOrigin"]).netloc})
    while time.monotonic() < deadline:
        require(process_identity(identity["pid"]) == identity)
        if listener_owned(identity["pid"], config["port"]):
            try:
                with opener.open(request, timeout=1) as response:
                    if response.status == 200:
                        return
            except OSError:
                pass
        time.sleep(0.1)
    raise RuntimeError("Host readiness was not confirmed")


def package_files(archive, digest):
    require(re.fullmatch(r"[a-f0-9]{64}", digest) and len(archive) <= 2 * 1024 * 1024 and hashlib.sha256(archive).hexdigest() == digest)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for member in tar:
            require(member.isfile() and not member.issym() and not member.islnk() and member.size <= 1024 * 1024 and len(files) < 64)
            require(member.name in {"vendor/ws.mjs", "codex-native-guardian"} or re.fullmatch(r"[a-z0-9-]+\.(?:mjs|py|json)", member.name))
            require(member.name not in files)
            files[member.name] = tar.extractfile(member).read()
    require("package-manifest.json" in files)
    manifest = json.loads(files["package-manifest.json"])
    require(manifest["schemaVersion"] == 1 and manifest["nodeMajor"] == 24 and manifest["nativeVersion"] == "0.165.0" and manifest["wsVersion"] == "8.21.3")
    require(set(files) == set(manifest["files"]) | {"package-manifest.json"})
    require(all(hashlib.sha256(files[name]).hexdigest() == expected for name, expected in manifest["files"].items()))
    if "codex-native-guardian" in files or "guardian" in manifest:
        guardian = manifest.get("guardian", {})
        binary = files.get("codex-native-guardian", b"")
        require(guardian.get("schemaVersion") == 1 and guardian.get("platform") == "linux" and guardian.get("architecture") == "x64")
        require(guardian.get("elfSha256") == hashlib.sha256(binary).hexdigest())
        require(all(isinstance(guardian.get(key), str) and re.fullmatch(r"[a-f0-9]{64}", guardian[key]) for key in ("sourceSha256", "recipeSha256")))
        require(len(binary) >= 64 and binary[:6] == b"\x7fELF\x02\x01" and binary[16:20] == b"\x03\x00\x3e\x00")
    require({"codex-workspace-host.mjs", "install-codex-runtime.py", "vendor/ws.mjs"} <= files.keys())
    return files


def install_package(root, archive, digest):
    files = package_files(archive, digest)
    target = root / digest
    if target.exists() or target.is_symlink():
        private_directory(target)
        actual = {str(path.relative_to(target)) for path in target.rglob("*") if path.is_file()}
        require(actual == set(files))
        for name, content in files.items():
            require(private_file(target / name) == content)
        return target
    stage = private_directory(root / (".install-" + str(uuid.uuid4())))
    for name, content in files.items():
        destination = stage / name
        private_directory(destination.parent)
        with destination.open("xb") as out:
            os.chmod(destination, 0o400 if name.endswith(".json") else 0o500)
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
    # Interrupted stages are retained for inspection, never adopted or overwritten.
    os.rename(stage, target)
    return target


def decode_archive(request):
    archive = base64.b64decode(request["archive"], validate=True)
    encoding = request.get("archiveEncoding", "tar")
    require(encoding in ("tar", "gzip"))
    if encoding == "gzip":
        require(len(archive) <= 160000)
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as stream:
            archive = stream.read(2 * 1024 * 1024 + 1)
    require(len(archive) <= 2 * 1024 * 1024)
    return archive


def install(request):
    require(os.environ.get("HIVE_WORKSPACE_PROFILE") == "software")
    required = {"schemaVersion", "archive", "archiveSha256", "config"}
    require(set(request) in (required, required | {"archiveEncoding"}) and request["schemaVersion"] == 1)
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    root = private_directory(home / ".local/share/hive/codex-host")
    config_root = private_directory(home / ".config/hive")
    state = private_directory(home / ".local/state/hive/codex-host-install")
    lock = os.open(state / "install.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    require(os.fstat(lock).st_uid == os.getuid() and not os.fstat(lock).st_mode & 0o077)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        archive = decode_archive(request)
        config = request["config"]
        # Manager activation requires the separate producer-isolation acceptance.
        require(isinstance(config, dict) and config.get("managerEnabled") is False and config.get("profile") == "software" and config.get("enabled") is True)
        encoded = (json.dumps(config, separators=(",", ":"), sort_keys=True) + "\n").encode()
        require(len(encoded) <= 16384)
        target = install_package(root, archive, request["archiveSha256"])
        node = shutil.which("node")
        require(node is not None)
        node = str(Path(node).resolve())
        node_info = Path(node).stat()
        require(Path(node).parent in {Path("/usr/bin"), Path("/usr/local/bin")} and node_info.st_uid == 0 and not node_info.st_mode & 0o022)
        env = {key: os.environ[key] for key in ["PATH", "HOME", "USER", "LANG"] if key in os.environ}
        require(int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], env=env, timeout=5)) >= 24)
        subprocess.run([node, "--input-type=module", "-e", "const m=await import(process.argv[1]);m.validateHostConfig(JSON.parse(process.env.HIVE_HOST_CONFIG));", (target / "codex-workspace-host.mjs").as_uri()], env={**env, "HIVE_HOST_CONFIG": encoded.decode()}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=True)
        receipt_path = state / "process.json"
        if receipt_path.exists() or receipt_path.is_symlink():
            receipt = json.loads(private_file(receipt_path, 16384))
            try:
                live = process_identity(receipt["process"]["pid"]) == receipt["process"]
            except (FileNotFoundError, ProcessLookupError):
                live = False
            if live:
                require(receipt["archiveSha256"] == request["archiveSha256"] and receipt["configSha256"] == hashlib.sha256(encoded).hexdigest())
                require(private_file(config_root / "codex-host.json", 16384) == encoded)
                confirm_ready(receipt["process"], config)
                return {"status": "already_running", "archiveSha256": request["archiveSha256"]}
        subprocess.run(["/usr/bin/python3", str(target / "install-codex-runtime.py")], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180, check=True)
        atomic(config_root / "codex-host.json", encoded)
        host_env = {**env, "HIVE_WORKSPACE_PROFILE": "software"}
        for name in ["CODER_AGENT_TOKEN", "CODER_AGENT_TOKEN_FILE", "CODER_AGENT_URL"]:
            if name in os.environ:
                host_env[name] = os.environ[name]
        # Never pass owner CLI authentication or unrelated integration credentials.
        log = os.open(state / "host.log", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        require(os.fstat(log).st_uid == os.getuid() and not os.fstat(log).st_mode & 0o077)
        child = subprocess.Popen([node, str(target / "codex-workspace-host.mjs")], env=host_env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, start_new_session=True)
        os.close(log)
        identity = process_identity(child.pid)
        atomic(receipt_path, (json.dumps({"schemaVersion": 1, "archiveSha256": request["archiveSha256"], "configSha256": hashlib.sha256(encoded).hexdigest(), "process": identity}) + "\n").encode())
        # Preserve process/work and receipt if readiness fails; never spawn a duplicate.
        confirm_ready(identity, config)
        return {"status": "started", "archiveSha256": request["archiveSha256"]}
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 1)
        raw = sys.stdin.buffer.read(3 * 1024 * 1024 + 1)
        require(len(raw) <= 3 * 1024 * 1024)
        print(json.dumps(install(json.loads(raw))))
    except Exception:
        print("Managed host installation rejected; existing work is retained.", file=sys.stderr)
        raise SystemExit(1) from None
