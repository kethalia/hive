#!/usr/bin/env python3
"""Install a template-pinned host package. Preserve all task journals and checkouts."""
import base64
import fcntl
import gzip
import hashlib
import io
import json
import lzma
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
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


def kernel_identity(pid, with_executable=True):
    require(type(pid) is int and pid > 0)
    root = Path(f"/proc/{pid}")
    raw = (root / "stat").read_text()
    fields = raw[raw.rindex(") ") + 2:].split()
    # Nondumpable guardians can have root-owned proc inodes. The status UIDs
    # describe the process; directory ownership is not its execution identity.
    uid_line = next(line for line in (root / "status").read_text().splitlines() if line.startswith("Uid:"))
    require(all(int(value) == os.getuid() for value in uid_line.split()[1:]))
    require(fields[0] not in ("Z", "X") and fields[19].isdigit() and fields[1].isdigit())
    result = {"pid": pid, "parentPid": int(fields[1]), "startTime": fields[19], "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
    if with_executable:
        executable = os.readlink(root / "exe")
        info = (root / "exe").stat()
        require(executable.startswith("/") and not executable.endswith(" (deleted)") and stat.S_ISREG(info.st_mode))
        result.update(executable=executable, device=str(info.st_dev), inode=str(info.st_ino))
    after = (root / "stat").read_text()
    again = after[after.rindex(") ") + 2:].split()
    require(again[0] not in ("Z", "X") and again[19] == fields[19] and again[1] == fields[1])
    return result


def guarded_ready(identity, config, startup, target, initial=False):
    require(isinstance(startup, dict) and set(startup) == {"start", "ready"})
    expected, ready = startup["start"], startup["ready"]
    require(isinstance(expected, dict) and isinstance(ready, dict))
    require(set(expected) == {"schemaVersion", "type", "nonce", "configSha256", "packageManifestSha256", "nodeSha256", "port"})
    fields = {"schemaVersion", "type", "nonce", "configSha256", "packageManifestSha256", "nodeSha256", "workerSha256", "guardianSha256", "port", "lifetimeId", "bindingDigest", "generation", "ownershipDigest", "phase", "projects", "outerIdentity", "guardianIdentity", "workerIdentity"}
    require(set(ready) == fields and type(expected["schemaVersion"]) is int and type(ready["schemaVersion"]) is int and expected["schemaVersion"] == ready["schemaVersion"] == 1 and expected["type"] == "start" and ready["type"] == "ready")
    require(re.fullmatch(r"[A-Za-z0-9_-]{43}", expected["nonce"]) is not None)
    for key in ("nonce", "configSha256", "packageManifestSha256", "nodeSha256", "port"):
        require(ready[key] == expected[key])
    encoded = (json.dumps(config, separators=(",", ":"), sort_keys=True) + "\n").encode()
    require(hashlib.sha256(encoded).hexdigest() == ready["configSha256"])
    require(type(ready["port"]) is int and ready["port"] == config["port"] and ready["phase"] == "open")
    require(type(ready["generation"]) is int and ready["generation"] > 0 and str(uuid.UUID(ready["lifetimeId"])) == ready["lifetimeId"])
    require(all(isinstance(ready[key], str) and re.fullmatch(r"[a-f0-9]{64}", ready[key]) for key in ("configSha256", "packageManifestSha256", "nodeSha256", "workerSha256", "guardianSha256", "bindingDigest", "ownershipDigest")))
    require(isinstance(ready["projects"], list) and len(ready["projects"]) <= 32)
    project_ids = set()
    for project in ready["projects"]:
        require(set(project) == {"projectId", "bindingDigest"} and str(uuid.UUID(project["projectId"])) == project["projectId"] and re.fullmatch(r"[a-f0-9]{64}", project["bindingDigest"]))
        require(project["projectId"] not in project_ids)
        project_ids.add(project["projectId"])
    manifest_bytes = private_file(target / "package-manifest.json", 65536)
    require(hashlib.sha256(manifest_bytes).hexdigest() == ready["packageManifestSha256"])
    manifest = json.loads(manifest_bytes)
    require(manifest["files"]["codex-workspace-host-worker.mjs"] == ready["workerSha256"])
    require(manifest["guardian"]["elfSha256"] == manifest["files"]["codex-native-guardian"] == ready["guardianSha256"])
    outer, guardian, worker = (ready[key] for key in ("outerIdentity", "guardianIdentity", "workerIdentity"))
    identity_keys = {"pid", "parentPid", "startTime", "bootId", "executable", "device", "inode"}
    for claimed in (outer, guardian, worker):
        require(isinstance(claimed, dict) and set(claimed) == identity_keys)
        require(type(claimed["parentPid"]) is int and claimed["parentPid"] > 0)
    require({key: outer[key] for key in identity} == identity)
    require(guardian["parentPid"] == outer["pid"] and worker["parentPid"] == guardian["pid"])
    require(len({outer["pid"], guardian["pid"], worker["pid"]}) == 3)
    actual_outer = kernel_identity(outer["pid"])
    # The installer exits after startup; the same outer process is then reparented.
    require(all(actual_outer[key] == outer[key] for key in identity_keys - {"parentPid"}))
    if initial:
        require(actual_outer["parentPid"] == outer["parentPid"] == os.getpid())
    require(kernel_identity(worker["pid"]) == worker)
    require(kernel_identity(guardian["pid"], False) == {key: guardian[key] for key in ("pid", "parentPid", "startTime", "bootId")})
    require(worker["executable"] == outer["executable"])
    for claimed, executable, digest in ((outer, Path(identity["executable"]), ready["nodeSha256"]), (worker, Path(identity["executable"]), ready["nodeSha256"]), (guardian, target / "codex-native-guardian", ready["guardianSha256"])):
        info = executable.stat()
        require(claimed["executable"] == str(executable) and claimed["device"] == str(info.st_dev) and claimed["inode"] == str(info.st_ino))
        require(hashlib.sha256(executable.read_bytes()).hexdigest() == digest)
    return worker["pid"]


def startup_reply(channel):
    deadline = time.monotonic() + 20
    data = b""
    while b"\n" not in data:
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        channel.settimeout(remaining)
        chunk = channel.recv(32769 - len(data))
        require(chunk)
        data += chunk
        require(len(data) <= 32768)
    require(data.endswith(b"\n") and data.count(b"\n") == 1)
    return json.loads(data)


def confirm_ready(identity, config, startup=None, target=None):
    deadline = time.monotonic() + 20
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(f"http://127.0.0.1:{config['port']}/healthz", headers={"Host": urlparse(config["binding"]["appOrigin"]).netloc})
    while time.monotonic() < deadline:
        require(process_identity(identity["pid"]) == identity)
        listener_pid = guarded_ready(identity, config, startup, target) if config.get("guardianEnabled") else identity["pid"]
        if listener_owned(listener_pid, config["port"]):
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
    require(encoding in ("tar", "gzip", "xz"))
    if encoding == "gzip":
        require(len(archive) <= 160000)
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as stream:
            archive = stream.read(2 * 1024 * 1024 + 1)
    elif encoding == "xz":
        require(len(archive) <= 160000)
        stream = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=32 * 1024 * 1024)
        archive = stream.decompress(archive, max_length=2 * 1024 * 1024 + 1)
        require(stream.eof and not stream.unused_data)
    require(len(archive) <= 2 * 1024 * 1024)
    return archive


def validate_execution_config(config):
    # Explicit delivery capability is separate from legacy manager-only config.
    require(isinstance(config, dict) and config.get("profile") == "software" and config.get("enabled") is True)
    delivery = config.get("deliveryExecutionEnabled", False)
    require(type(delivery) is bool and (not delivery or (config.get("managerEnabled") is True and config.get("guardianEnabled") is True and config.get("nativeIsolationEnabled") is True)))
    require(config.get("managerEnabled") is False or delivery)


def image_asset(path, limit, executable=False):
    """Pin an immutable root-owned image asset, returning its open descriptor."""
    require(path.is_absolute() and path.resolve() == path)
    for parent in path.parents:
        info = parent.stat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022 and 0 < info.st_size <= limit and (not executable or info.st_mode & 0o111))
        raw = os.read(fd, limit + 1)
        require(len(raw) == info.st_size and len(raw) <= limit)
        os.lseek(fd, 0, os.SEEK_SET)
        return fd, raw
    except Exception:
        os.close(fd)
        raise


def normalize_agent_config(config, kind):
    """One authenticated manifest read before hashing the effective config."""
    require(isinstance(config, dict) and isinstance(config.get("binding"), dict))
    binding = config["binding"]
    expected = {"schemaVersion": 1, "kind": kind, "coderOrigin": binding["coderOrigin"], "workspaceId": binding["workspaceId"], "buildId": binding["buildId"], "appId": binding["appId"], "appOrigin": binding["appOrigin"], "provisionalAgentId": binding["agentId"]}
    helper_fd, binary = image_asset(Path("/usr/local/libexec/hive-workspace-identity"), 64 * 1024 * 1024, True)
    try:
        pin_fd, pin_raw = image_asset(Path("/usr/local/libexec/hive-workspace-identity.json"), 4096)
        os.close(pin_fd)
        pin = json.loads(pin_raw)
        binary_sha = hashlib.sha256(binary).hexdigest()
        require(isinstance(pin, dict) and set(pin) == {"schemaVersion", "sdkVersion", "goVersion", "sha256"} and type(pin["schemaVersion"]) is int and pin["schemaVersion"] == 1 and pin["sdkVersion"] == "v2.38.4" and pin["goVersion"] == "go1.26.10" and pin["sha256"] == binary_sha)
        agent_env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        for key in ("CODER_AGENT_URL", "CODER_AGENT_TOKEN", "CODER_AGENT_TOKEN_FILE"):
            if key in os.environ:
                agent_env[key] = os.environ[key]
        reply = subprocess.run([f"/proc/self/fd/{helper_fd}"], input=json.dumps(expected, separators=(",", ":")).encode(), env=agent_env, pass_fds=(helper_fd,), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=11, check=True)
        require(0 < len(reply.stdout) <= 16384)
        value = json.loads(reply.stdout)
        fields = ["schemaVersion", "sdkVersion", "kind", "coderOrigin", "workspaceId", "buildId", "appId", "appOrigin", "provisionalAgentId", "agentId"]
        require(isinstance(value, dict) and set(value) == set(fields) | {"manifestBindingSha256"} and all(value[key] == expected[key] for key in expected) and type(value["schemaVersion"]) is int and value["sdkVersion"] == "v2.38.4")
        require(isinstance(value["agentId"], str) and str(uuid.UUID(value["agentId"])) == value["agentId"] and uuid.UUID(value["agentId"]).int != 0)
        selected = {key: value[key] for key in fields}
        require(hashlib.sha256(json.dumps(selected, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() == value["manifestBindingSha256"])
        normalized = json.loads(json.dumps(config))
        normalized["binding"]["agentId"] = value["agentId"]
        return normalized, {**value, "helperSha256": binary_sha}
    finally:
        os.close(helper_fd)


def same_build_identity(previous, identity, config_path):
    prior = previous.get("runtimeIdentity")
    if isinstance(prior, dict) and prior.get("buildId") != identity["buildId"]:
        return
    if not isinstance(prior, dict):
        raw = private_file(config_path, 32768)
        require(hashlib.sha256(raw).hexdigest() == previous.get("configSha256"))
        old = json.loads(raw)
        require(isinstance(old, dict) and isinstance(old.get("binding"), dict))
        if old["binding"].get("buildId") != identity["buildId"]:
            return
    # A legacy receipt cannot be silently adopted in the same build. New build
    # startup may preserve its old history only after the normal process checks.
    require(isinstance(prior, dict) and prior.get("manifestBindingSha256") == identity["manifestBindingSha256"] and prior.get("agentId") == identity["agentId"])


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
        validate_execution_config(config)
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
        bootstrap_sha = hashlib.sha256(encoded).hexdigest()
        config, runtime_identity = normalize_agent_config(config, "project-host")
        encoded = (json.dumps(config, separators=(",", ":"), sort_keys=True) + "\n").encode()
        require(len(encoded) <= 16384)
        receipt_path = state / "process.json"
        if receipt_path.exists() or receipt_path.is_symlink():
            receipt = json.loads(private_file(receipt_path, 16384))
            same_build_identity(receipt, runtime_identity, config_root / "codex-host.json")
            try:
                live = process_identity(receipt["process"]["pid"]) == receipt["process"]
            except (FileNotFoundError, ProcessLookupError):
                live = False
            if live:
                require(receipt.get("bootstrapConfigSha256") == bootstrap_sha)
                require(receipt["archiveSha256"] == request["archiveSha256"] and receipt["configSha256"] == hashlib.sha256(encoded).hexdigest())
                require(private_file(config_root / "codex-host.json", 16384) == encoded)
                confirm_ready(receipt["process"], config, receipt.get("guardianStartup"), target)
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
        channel = child_channel = None
        startup = None
        guarded = config.get("guardianEnabled") is True
        try:
            spawn_options = {}
            if guarded:
                manifest_bytes = private_file(target / "package-manifest.json", 65536)
                manifest = json.loads(manifest_bytes)
                require({"codex-workspace-host-outer.mjs", "codex-workspace-host-worker.mjs", "codex-native-guardian"} <= manifest["files"].keys() and "guardian" in manifest)
                channel, child_channel = socket.socketpair()
                inherited = child_channel.fileno()
                # The standalone installer owns its descriptors and has no threads.
                # Keep FD3 through exec; replace only the child's copy of install.lock.
                os.fstat(3)
                def attach_startup_channel():
                    os.dup2(inherited, 3, inheritable=True)
                    if inherited != 3:
                        os.close(inherited)
                spawn_options = {"pass_fds": tuple({3, inherited}), "preexec_fn": attach_startup_channel}
                startup = {"start": {"schemaVersion": 1, "type": "start", "nonce": base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="), "configSha256": hashlib.sha256(encoded).hexdigest(), "packageManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(), "nodeSha256": hashlib.sha256(Path(node).read_bytes()).hexdigest(), "port": config["port"]}, "ready": None}
            entry = "codex-workspace-host-outer.mjs" if guarded else "codex-workspace-host.mjs"
            child = subprocess.Popen([node, str(target / entry)], env=host_env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, start_new_session=True, **spawn_options)
            if child_channel is not None:
                child_channel.close()
            identity = process_identity(child.pid)
            receipt = {"schemaVersion": 1, "archiveSha256": request["archiveSha256"], "configSha256": hashlib.sha256(encoded).hexdigest(), "bootstrapConfigSha256": bootstrap_sha, "runtimeIdentity": runtime_identity, "process": identity}
            if guarded:
                receipt["guardianStartup"] = startup
            # Persist the launch before waiting: lost ACK must not launch a duplicate.
            atomic(receipt_path, (json.dumps(receipt) + "\n").encode())
            if guarded:
                channel.sendall((json.dumps(startup["start"]) + "\n").encode())
                startup["ready"] = startup_reply(channel)
                guarded_ready(identity, config, startup, target, initial=True)
                atomic(receipt_path, (json.dumps(receipt) + "\n").encode())
            # Preserve process/work and receipt if readiness fails; never spawn a duplicate.
            confirm_ready(identity, config, startup, target)
        finally:
            os.close(log)
            if child_channel is not None:
                child_channel.close()
            if channel is not None:
                channel.close()
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
