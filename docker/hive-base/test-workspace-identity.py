"""Image smoke: pin the root-owned helper and exercise failure without credentials."""
import hashlib
import json
from pathlib import Path
import stat
import subprocess

binary = Path("/usr/local/libexec/hive-workspace-identity")
pin = Path("/usr/local/libexec/hive-workspace-identity.json")
for path in (binary, pin):
    info = path.lstat()
    assert path.resolve() == path and stat.S_ISREG(info.st_mode)
    assert info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022
metadata = json.loads(pin.read_text())
assert metadata == {"schemaVersion": 1, "sdkVersion": "v2.38.4", "goVersion": "go1.26.10", "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
r = subprocess.run([str(binary)], input=b"{}", capture_output=True, timeout=2, env={"PATH": "/usr/bin:/bin"})
assert r.returncode == 1 and r.stdout == b"" and r.stderr == b"workspace_identity_unavailable\n"
