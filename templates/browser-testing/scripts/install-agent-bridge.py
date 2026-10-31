#!/usr/bin/env python3
"""Install only the independently pinned agent service. Never adopt/kill a process."""
import base64
import fcntl
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
from urllib.parse import urlsplit
import uuid
import zlib

MEMBERS = {"agent-host.mjs", "agent-start.mjs", "agent-tools.py", "manifest.json"}
PROFILES = {"software", "browser", "game", "electronics", "infrastructure"}
BINDING = {"coderOrigin", "ownerId", "workspaceId", "buildId", "agentId", "templateId", "appOrigin", "appId"}
CONFIG = {"schemaVersion", "binding", "profile", "home", "hiveOrigin", "issuerKeyId", "issuerPublicKeyPem", "packageDirectory", "manifestSha256", "helperSha256", "port"}


def require(value):
    if not value:
        raise RuntimeError("agent_bridge_install_rejected")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def identifier(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def absolute(value):
    return isinstance(value, str) and 0 < len(value) <= 4096 and value.startswith("/") and os.path.normpath(value) == value and "\\" not in value and all(ord(c) >= 32 and ord(c) != 127 for c in value)


def origin(value):
    require(isinstance(value, str) and value.startswith("https://"))
    u = urlsplit(value)
    require(u.scheme == "https" and u.hostname and u.netloc == u.netloc.lower() and not u.path and not u.query and not u.fragment and not u.username and not u.password)
    require(u.port is None or 0 < u.port <= 65535 and u.port != 443)


def public_key(value):
    require(isinstance(value, str) and value.startswith("-----BEGIN PUBLIC KEY-----\n") and "PRIVATE" not in value and len(value) <= 256)
    lines = value.splitlines()
    require(len(lines) == 3 and lines[0] == "-----BEGIN PUBLIC KEY-----" and lines[-1] == "-----END PUBLIC KEY-----" and value.endswith("\n"))
    raw = base64.b64decode(lines[1], validate=True)
    require(len(raw) == 44 and raw[:12] == bytes.fromhex("302a300506032b6570032100") and base64.b64encode(raw).decode() == lines[1])
    return raw


def validate(request, home, profile):
    require(isinstance(request, dict) and set(request) == {"schemaVersion", "archive", "archiveSha256", "manifestSha256", "config"} and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1)
    require(digest(request["archiveSha256"]) and digest(request["manifestSha256"]) and isinstance(request["archive"], str) and len(request["archive"]) <= 174764)
    compressed = base64.b64decode(request["archive"], validate=True)
    require(len(compressed) <= 131072)
    inflater = zlib.decompressobj(31)
    archive = inflater.decompress(compressed, 524289)
    require(inflater.eof and not inflater.unused_data and not inflater.unconsumed_tail and 0 < len(archive) <= 524288 and sha(archive) == request["archiveSha256"])
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        end = 0
        for member in tar:
            require(member.name in MEMBERS and member.name not in files and member.isreg() and not member.linkname and not member.pax_headers and not member.sparse and 0 < member.size <= 524288)
            files[member.name] = tar.extractfile(member).read()
            require(len(files[member.name]) == member.size)
            end = max(end, member.offset_data + ((member.size + 511) // 512) * 512)
    require(set(files) == MEMBERS and len(archive) % 512 == 0 and len(archive) - end >= 1024 and not any(archive[end:]))
    require(sha(files["manifest.json"]) == request["manifestSha256"])
    manifest = json.loads(files["manifest.json"])
    require(isinstance(manifest, dict) and set(manifest) == {"schemaVersion", "files"} and type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1)
    require(isinstance(manifest["files"], dict) and set(manifest["files"]) == MEMBERS - {"manifest.json"})
    require(all(digest(expected) and sha(files[name]) == expected for name, expected in manifest["files"].items()))
    c = request["config"]
    require(isinstance(c, dict) and set(c) == CONFIG and type(c["schemaVersion"]) is int and c["schemaVersion"] == 1 and c["home"] == str(home) and type(c["port"]) is int and c["port"] == 13344)
    require(c["profile"] == profile and profile in PROFILES and digest(c["helperSha256"]) and c["helperSha256"] == manifest["files"]["agent-tools.py"])
    require(all(absolute(c[k]) for k in ("home", "packageDirectory")))
    require(isinstance(c["binding"], dict) and set(c["binding"]) == BINDING and all(identifier(v) for k, v in c["binding"].items() if not k.endswith("Origin")))
    for value in (c["hiveOrigin"], c["binding"]["coderOrigin"], c["binding"]["appOrigin"]): origin(value)
    require(isinstance(c["issuerKeyId"], str) and re.fullmatch(r"[A-Za-z0-9._-]{1,64}", c["issuerKeyId"]))
    public_key(c["issuerPublicKeyPem"])
    require(c["manifestSha256"] == request["manifestSha256"])
    target = home / ".local/share/hive/agent-bridge" / request["archiveSha256"]
    require(c["packageDirectory"] == str(target))
    environment = {key: os.environ[key] for key in ("CODEX_HOME", "CLAUDE_CONFIG_DIR") if os.environ.get(key)}
    require(all(absolute(value) for value in environment.values()))
    effective = {"schemaVersion": 1, "home": str(home), "issuer": c["hiveOrigin"], "issuerKeyId": c["issuerKeyId"], "issuerPublicKeyPem": c["issuerPublicKeyPem"], "binding": c["binding"], "profile": c["profile"], "packageDirectory": str(target), "manifestSha256": c["manifestSha256"], "helperSha256": c["helperSha256"], "environment": environment, "port": 13344}
    encoded = canonical(effective) + b"\n"
    require(len(encoded) <= 32768)
    return files, target, encoded



def directory(path, private=True):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    s = path.lstat()
    require(path.resolve() == path and stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid() and not s.st_mode & (0o077 if private else 0o022))
    return path


def private_file(path, limit=65536):
    require(path.resolve() == path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1 and not s.st_mode & 0o077 and s.st_size <= limit)
        raw = os.read(fd, limit + 1)
        require(len(raw) <= limit and len(raw) == s.st_size)
        return raw
    finally:
        os.close(fd)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, raw):
    temp = path.with_name("." + path.name + "." + str(uuid.uuid4()))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(raw)
            out.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    if path.exists() or path.is_symlink():
        private_file(path)
    os.replace(temp, path)
    fsync_dir(path.parent)


def install_package(root, target, files):
    if target.exists() or target.is_symlink():
        directory(target)
        require({p.name for p in target.iterdir()} == MEMBERS)
        for name, raw in files.items():
            require(private_file(target / name, 524288) == raw)
        return
    stage = root / (".stage-" + str(uuid.uuid4()))
    directory(stage)
    for name, raw in files.items():
        fd = os.open(stage / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400 if name.endswith(".json") else 0o500)
        try:
            with os.fdopen(fd, "wb", closefd=False) as out:
                out.write(raw)
                out.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
    for name, raw in files.items():
        require(private_file(stage / name, 524288) == raw)
    fsync_dir(stage)
    os.rename(stage, target)
    fsync_dir(root)


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def process_identity(pid):
    require(type(pid) is int and pid > 0)
    root = Path(f"/proc/{pid}")
    raw = (root / "stat").read_text()
    fields = raw[raw.rindex(") ") + 2:].split()
    require(fields[0] not in ("Z", "X"))
    uid = next(line for line in (root / "status").read_text().splitlines() if line.startswith("Uid:"))
    require(all(int(v) == os.getuid() for v in uid.split()[1:]))
    executable = os.readlink(root / "exe")
    info = (root / "exe").stat()
    require(executable.startswith("/") and not executable.endswith(" (deleted)") and stat.S_ISREG(info.st_mode) and info.st_size <= 268435456)
    argv = (root / "cmdline").read_bytes().split(b"\0")
    require(argv[-1] == b"")
    again = (root / "stat").read_text()
    after = again[again.rindex(") ") + 2:].split()
    require(after[19] == fields[19] and after[0] not in ("Z", "X"))
    return {"pid": pid, "startTime": fields[19], "bootId": boot_id(), "uid": os.getuid(), "executable": executable,
            "device": str(info.st_dev), "inode": str(info.st_ino), "executableSha256": sha((root / "exe").read_bytes()),
            "argv": [v.decode() for v in argv[:-1]]}


def prior_state(record):
    """A reused numeric PID is not the recorded process. Never signal either."""
    if record["bootId"] != boot_id():
        return "absent"
    try:
        raw = Path(f"/proc/{record['pid']}/stat").read_text()
    except FileNotFoundError:
        return "absent"
    fields = raw[raw.rindex(") ") + 2:].split()
    if fields[19] != record["startTime"]:
        return "absent"
    require(process_identity(record["pid"]) == record)
    return "same"


def port_free():
    # Check both families so an unknown wildcard/IPv6 listener is never adopted.
    for family, address in ((socket.AF_INET, ("127.0.0.1", 13344)), (socket.AF_INET6, ("::1", 13344))):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as sock:
                # Match Node's normal listener restart semantics: TIME_WAIT is
                # not a live listener. Never enable SO_REUSEPORT.
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(address)
        except OSError as error:
            if family == socket.AF_INET6 and error.errno in (97, 99):
                continue
            return False
    return True


def listener_owned(pid):
    sockets = set()
    for p in Path(f"/proc/{pid}/fd").iterdir():
        try:
            target = os.readlink(p)
        except FileNotFoundError:
            continue
        if target.startswith("socket:["):
            sockets.add(target[8:-1])
    return any(fields[1] == "0100007F:3420" and fields[3] == "0A" and fields[9] in sockets
               for line in Path("/proc/net/tcp").read_text().splitlines()[1:] if (fields := line.split()))


def config_digest(config):
    c = config
    payload = {"schemaVersion": 1, "issuer": c["issuer"], "issuerKeyId": c["issuerKeyId"], "issuerPublicKeySha256": sha(public_key(c["issuerPublicKeyPem"])), "binding": c["binding"], "profile": c["profile"], "home": c["home"], "manifestSha256": c["manifestSha256"], "helperSha256": c["helperSha256"], "environment": c["environment"]}
    return sha(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())


def ready(identity, config, config_sha, lifetime=None):
    require(process_identity(identity["pid"]) == identity and listener_owned(identity["pid"]))
    request = urllib.request.Request("http://127.0.0.1:13344/healthz", headers={"Host": urlsplit(config["binding"]["appOrigin"]).netloc})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, _request, _fp, _code, _message, _headers, _target): return None
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=1) as response:
        require(response.status == 200 and response.headers.get("Location") is None)
        raw = response.read(4097)
    require(len(raw) <= 4096)
    body = json.loads(raw)
    require(isinstance(body, dict) and set(body) == {"schemaVersion", "lifetimeId", "configDigest", "manifestSha256", "helperSha256", "profile", "configFileSha256"})
    require(type(body["schemaVersion"]) is int and body["schemaVersion"] == 1 and identifier(body["lifetimeId"]) and body["configDigest"] == config_digest(config) and body["manifestSha256"] == config["manifestSha256"] and body["helperSha256"] == config["helperSha256"] and body["profile"] == config["profile"] and body["configFileSha256"] == config_sha and (lifetime is None or body["lifetimeId"] == lifetime))
    require(process_identity(identity["pid"]) == identity and listener_owned(identity["pid"]))
    return body["lifetimeId"]


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
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    files, target, bootstrap_encoded = validate(request, home, os.environ.get("HIVE_WORKSPACE_PROFILE"))
    effective, runtime_identity = normalize_agent_config(request["config"], "agent-tools")
    request = {**request, "config": effective}
    files, target, encoded = validate(request, home, os.environ.get("HIVE_WORKSPACE_PROFILE"))
    bootstrap_sha = sha(bootstrap_encoded)
    for parent in (home / ".local", home / ".local/share", home / ".local/share/hive", home / ".local/state", home / ".local/state/hive", home / ".config", home / ".config/hive"):
        directory(parent, False)
    packages = directory(home / ".local/share/hive/agent-bridge")
    control = directory(home / ".local/state/hive/agent-bridge")
    history = directory(control / "history")
    fd = os.open(control / "installer.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock = os.fstat(fd)
    require(stat.S_ISREG(lock.st_mode) and lock.st_uid == os.getuid() and lock.st_nlink == 1 and not lock.st_mode & 0o077)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    record_path, key_path = control / "service.json", control / "receipt-key"
    try:
        if not key_path.exists():
            require(not record_path.exists())
            atomic(key_path, os.urandom(32))
        key = private_file(key_path, 32)
        require(len(key) == 32)
        def seal(record):
            return canonical({"record": record, "signature": hmac.new(key, canonical(record), hashlib.sha256).hexdigest()}) + b"\n"
        def load():
            if not record_path.exists():
                return None
            value = json.loads(private_file(record_path))
            require(isinstance(value, dict) and set(value) == {"record", "signature"} and isinstance(value["record"], dict) and hmac.compare_digest(value["signature"], hmac.new(key, canonical(value["record"]), hashlib.sha256).hexdigest()))
            return value["record"]
        def save(value):
            if record_path.exists():
                prior = private_file(record_path)
                out = history / (str(uuid.uuid4()) + ".json")
                atomic(out, prior)
            atomic(record_path, seal(value))
        previous = load()
        config_sha = sha(encoded)
        same = previous and previous.get("archiveSha256") == request["archiveSha256"] and previous.get("manifestSha256") == request["manifestSha256"] and previous.get("configSha256") == config_sha
        if previous:
            same_build_identity(previous, runtime_identity, home / ".config/hive/agent-bridge.json")
            require(previous.get("phase") == "ready" and isinstance(previous.get("process"), dict))
            state = prior_state(previous["process"])
            if state == "same":
                require(same and previous.get("bootstrapConfigSha256") == bootstrap_sha and private_file(home / ".config/hive/agent-bridge.json", 32768) == encoded)
                install_package(packages, target, files)
                lifetime = ready(previous["process"], json.loads(encoded), config_sha, previous["lifetimeId"])
                return {"schemaVersion": 1, "ready": True, "reused": True, "lifetimeId": lifetime}
        else:
            require(not (home / ".config/hive/agent-bridge.json").exists())
        require(port_free())
        install_package(packages, target, files)
        node = Path("/usr/bin/node")
        require(node.resolve() == node and node.stat().st_uid == 0 and stat.S_ISREG(node.stat().st_mode) and not node.stat().st_mode & 0o022)
        version = subprocess.check_output([str(node), "--version"], env={"PATH": "/usr/bin:/bin"}, timeout=2).decode().strip()
        require(re.fullmatch(r"v24\.[0-9]+\.[0-9]+", version))
        node_sha = sha(node.read_bytes())
        record = {"schemaVersion": 1, "phase": "preparing", "launchId": str(uuid.uuid4()), "archiveSha256": request["archiveSha256"], "manifestSha256": request["manifestSha256"], "configSha256": config_sha, "bootstrapConfigSha256": bootstrap_sha, "runtimeIdentity": runtime_identity, "nodeSha256": node_sha, "process": None, "lifetimeId": None}
        save(record)
        atomic(home / ".config/hive/agent-bridge.json", encoded)
        log_path = control / ("service-" + record["launchId"] + ".log")
        log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        record["phase"] = "starting"
        save(record)  # A crash after this point cannot silently retry/adopt a child.
        try:
            child = subprocess.Popen([str(node), str(target / "agent-start.mjs")], stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd,
                                     env={"PATH": str(home / ".local/bin") + ":/usr/local/bin:/usr/bin:/bin", "HOME": str(home), "USER": pwd.getpwuid(os.getuid()).pw_name, "LANG": "C.UTF-8"}, close_fds=True, start_new_session=True)
            record["attemptedPid"] = child.pid
            save(record)
            identity = process_identity(child.pid)
            require(identity["executable"] == str(node) and identity["executableSha256"] == node_sha and identity["argv"] == [str(node), str(target / "agent-start.mjs")])
            record["process"] = identity
            save(record)
            deadline = time.monotonic() + 8
            while True:
                try:
                    lifetime = ready(identity, json.loads(encoded), config_sha)
                    break
                except Exception:
                    require(time.monotonic() < deadline)
                    time.sleep(0.05)
            record.update(phase="ready", lifetimeId=lifetime)
            save(record)
            return {"schemaVersion": 1, "ready": True, "reused": False, "lifetimeId": lifetime}
        except Exception:
            record["phase"] = "uncertain"
            save(record)
            raise
        finally:
            os.close(log_fd)
    finally:
        os.close(fd)


def main():
    try:
        require(len(sys.argv) == 1)
        raw = sys.stdin.buffer.read(262145)
        require(len(raw) <= 262144)
        result = install(json.loads(raw))
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    except Exception:
        sys.stderr.write("agent_bridge_install_failed\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
