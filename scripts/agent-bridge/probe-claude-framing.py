"""Opt-in local vendor CLI proof. Network namespace denies provider traffic.

Supply reviewed vendor binaries via HIVE_TEST_CLAUDE_EXECUTABLE and
HIVE_TEST_BWRAP. This does not install/update a CLI or complete a real login.
Only sanitized booleans and public vendor metadata are written to stdout.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import time
import urllib.parse

PINS = {
    "4f4178ce41d83e23341ebfbaecdbcf8ea6bf7baea0690025abe49eeec3a5d01d": "2.1.312",
    "dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed": "2.1.319",
}
binary = Path(os.environ["HIVE_TEST_CLAUDE_EXECUTABLE"]).resolve()
bwrap = Path(os.environ["HIVE_TEST_BWRAP"]).resolve()


def digest(path):
    with path.open("rb") as stream: return hashlib.file_digest(stream, "sha256").hexdigest()


sha = digest(binary)
assert sha in PINS
assert digest(bwrap) == "755c8d6a9b893905a4aabab058bd6c02c453e5e8653adb84fc08e570607f3f36"
driver = Path(__file__).with_name("claude-account-driver.py").read_text()

with tempfile.TemporaryDirectory(prefix="hive-claude-framing-") as temp:
    root = Path(temp)
    (root / "config").mkdir(mode=0o700)
    lock = os.open(root / "auth.lock", os.O_RDWR | os.O_CREAT, 0o600)
    assert lock == 3
    args = [str(bwrap), "--unshare-user", "--unshare-net", "--unshare-pid", "--as-pid-1",
            "--sync-fd", "3", "--die-with-parent", "--ro-bind", "/usr", "/usr",
            "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--tmpfs", "/tmp", "--bind", temp, temp, "--ro-bind", str(binary), "/claude",
            "--bind", "/proc", "/proc", "--dev", "/dev"]
    for path in ["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ssl", "/etc/resolv.conf", "/etc/hosts"]:
        if Path(path).exists(): args += ["--ro-bind", path, path]
    for path in ["/usr/bin/xdg-open", "/usr/bin/sensible-browser"]:
        if Path(path).exists(): args += ["--ro-bind", "/usr/bin/false", path]
    args += ["--chdir", temp, "--", "/usr/bin/python3", "-I", "-B", "-c", driver]
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        pass_fds=(lock,), start_new_session=True,
        env={"HOME": temp, "CLAUDE_CONFIG_DIR": temp + "/config", "HIVE_CLAUDE_EXECUTABLE": "/claude",
             "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TERM": "dumb", "BROWSER": "/usr/bin/false",
             "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
    sequence = 0
    buffer = bytearray()

    def call(method, params=None):
        global sequence, buffer
        sequence += 1
        process.stdin.write((json.dumps({"id": sequence, "method": method, "params": params}) + "\n").encode())
        process.stdin.flush()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            while b"\n" in buffer:
                raw, _, buffer = buffer.partition(b"\n")
                value = json.loads(raw)
                if value.get("id") == sequence: return value
            if select.select([process.stdout], [], [], 0.05)[0]:
                chunk = os.read(process.stdout.fileno(), 4096)
                assert chunk
                buffer.extend(chunk)
                assert len(buffer) <= 65536
        raise RuntimeError("local_vendor_protocol_deadline")

    try:
        assert call("initialize")["result"]["protocol"] == "hive-claude-cli-auth-v1"
        assert call("account/read")["result"] == {"account": None}
        pending = call("account/login/start")["result"]
        url = urllib.parse.urlsplit(pending["verificationUrl"])
        assert url.scheme == "https" and url.netloc == "claude.com" and url.path == "/cai/oauth/authorize"
        descriptor = os.fstat(lock)
        inherited = False
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit(): continue
            try:
                if (entry / "exe").stat().st_ino != binary.stat().st_ino: continue
                inherited |= any(p.stat().st_ino == descriptor.st_ino and p.stat().st_dev == descriptor.st_dev for p in (entry / "fd").iterdir())
            except (FileNotFoundError, PermissionError, ProcessLookupError): pass
        assert inherited
        # Invalid synthetic code cannot complete authentication. All network
        # traffic remains impossible, including a CLI's attempted exchange.
        code = {"loginId": pending["loginId"], "code": "NOT_A_REAL_CODE#WRONG_STATE"}
        assert call("account/login/submitCode", code)["result"] == {"accepted": True}
        assert "error" in call("account/login/submitCode", code)
        assert call("account/login/cancel", {"loginId": pending["loginId"]})["result"]["status"] == "canceled"
        assert call("account/read")["result"] == {"account": None}
        assert not list(root.rglob(".credentials.json"))
        print(json.dumps({"schemaVersion": 1, "localOnly": True, "version": PINS[sha], "binarySha256": sha,
            "networkNamespaceIsolated": True, "browserOpenersDisabled": True,
            "officialLoginOrigin": url.scheme + "://" + url.netloc, "officialLoginPath": url.path,
            "manualCodePrompt": True, "singleUseInputAccepted": True, "duplicateInputRejected": True,
            "finalCLIInheritedAuthLock": inherited, "cancelledThenFreshSignedOut": True,
            "realProviderRequests": 0, "credentialFileCreated": False, "rawURLOrCodeExported": False}))
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=2)
        process.stdin.close()
        process.stdout.close()
        os.close(lock)
