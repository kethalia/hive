"""Test-only root-ownership observation shim for the private user namespace.

The outer harness verifies real UID0, inode/hash/version before entering. The
namespace maps that inode's owner to65534. Product code/config has no bypass.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import os
import stat
import subprocess

pin = json.loads(Path("/opt/hive-read-node-pin.json").read_text())
node = Path("/usr/bin/node")
observed = node.stat()
assert pin["uid"] == 0 and observed.st_uid == 65534
assert str(observed.st_dev) == pin["device"] and str(observed.st_ino) == pin["inode"]
assert observed.st_size == pin["size"] and stat.S_ISREG(observed.st_mode) and not observed.st_mode & 0o022
assert hashlib.sha256(node.read_bytes()).hexdigest() == pin["sha256"]
assert subprocess.check_output([str(node), "--version"], timeout=2).decode().strip() == pin["version"]
original_stat = Path.stat


def fixture_stat(path, *args, **kwargs):
    result = original_stat(path, *args, **kwargs)
    if str(path) == "/usr/bin/node":
        assert result.st_dev == observed.st_dev and result.st_ino == observed.st_ino and result.st_uid == 65534
        fields = list(result)
        fields[4] = 0
        return os.stat_result(fields)
    return result


spec = importlib.util.spec_from_file_location("read_installer_under_test", "/opt/hive-read-installer.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
# Explicit fixture-only identity, independently covered by SDK/live proofs.
# Functions must retain their imports in one shared execution namespace.
import runpy
fixture = runpy.run_path("/opt/hive-identity-fixture.py", run_name="fixture_identity")
installer.normalize_agent_config = fixture["fixture_normalize"]
Path.stat = fixture_stat
installer.main()
