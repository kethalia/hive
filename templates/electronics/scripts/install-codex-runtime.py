#!/usr/bin/env python3
"""Install the fixed official native runtime separately from nightly CLI updates.
No credentials, plugins, settings, trust changes or package-manager installation.
"""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import subprocess
import sys
import tarfile
import urllib.request
import uuid

VERSION = "0.165.0"
NAME = "0.165.0-linux-x64-c06a67fd8ac76508"
URL = "https://registry.npmjs.org/@openai/codex/-/codex-0.165.0-linux-x64.tgz"
INTEGRITY = "FotDc7bVHwaommtsdDP8PPrH0a5IwC/t8H/LhdEcH4EBqgeYFRCtptiHcuwgvNRCLbTbOyFE/Ur6GzYCljgaSQ=="
BINARY_SHA256 = "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5"
BINARY = "vendor/x86_64-unknown-linux-musl/bin/codex"


def require(value):
    if not value:
        raise ValueError("runtime_install_rejected")


def extract_vendor(archive, destination):
    seen, total = set(), 0
    for member in archive:
        path = PurePosixPath(member.name)
        require(not path.is_absolute() and ".." not in path.parts and not member.issym() and not member.islnk())
        if not member.name.startswith("package/vendor/"):
            continue
        relative = PurePosixPath(member.name[len("package/"):])
        require(str(relative) not in seen and (member.isdir() or member.isfile()))
        seen.add(str(relative))
        target = destination / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if member.isdir():
            target.mkdir(mode=0o700, exist_ok=True)
            continue
        total += member.size
        require(member.size <= 400 * 1024 * 1024 and total <= 800 * 1024 * 1024)
        with archive.extractfile(member) as source, target.open("xb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        target.chmod(0o500 if member.mode & 0o111 else 0o400)
    require((destination / BINARY).is_file())


def verify_runtime(destination):
    executable = destination / BINARY
    require(executable.resolve() == executable and executable.stat().st_uid == os.getuid()
            and not executable.stat().st_mode & 0o022)
    with executable.open("rb") as source:
        require(hashlib.file_digest(source, "sha256").hexdigest() == BINARY_SHA256)
    result = subprocess.run([str(executable), "--version"], env={"PATH": "/usr/bin:/bin"}, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=True)
    require(result.stdout.decode().strip() == f"codex-cli {VERSION}")
    return executable


def install():
    require(len(sys.argv) == 1 and os.uname().machine == "x86_64" and sys.platform == "linux")
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    root = home / ".local/share/hive/codex-runtime"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(root.resolve() == root and root.stat().st_uid == os.getuid() and not root.stat().st_mode & 0o077)
    destination = root / NAME
    if destination.exists():
        return verify_runtime(destination)
    stage = root / (".install-" + str(uuid.uuid4()))
    stage.mkdir(mode=0o700)
    # Interrupted stage directories are retained for inspection, never overwritten.
    download = stage / "official-package.tgz"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(URL, timeout=30) as response, download.open("xb") as output:
        require(response.status == 200 and response.url == URL)
        digest, size = hashlib.sha512(), 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            require(size <= 256 * 1024 * 1024)
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    require(base64.b64encode(digest.digest()).decode() == INTEGRITY)
    with tarfile.open(download, "r:gz") as archive:
        extract_vendor(archive, stage)
    verify_runtime(stage)
    download.unlink()
    # No replacing an existing runtime, even when another installer raced us.
    require(not destination.exists())
    os.rename(stage, destination)
    return verify_runtime(destination)


if __name__ == "__main__":
    try:
        executable = install()
        print(json.dumps({"schemaVersion": 1, "version": VERSION, "sha256": BINARY_SHA256, "executable": str(executable)}))
    except Exception:
        print("Pinned Codex runtime installation rejected.", file=sys.stderr)
        raise SystemExit(1) from None
