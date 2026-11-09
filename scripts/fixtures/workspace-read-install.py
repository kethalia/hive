"""Actual installer/Node proof inside a task-owned home and network namespace."""
import ctypes
import hashlib
import hmac
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request

request = json.load(sys.stdin)
assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0  # Reap our own orphaned service only.
home = Path("/home/coder")
assert request["config"]["home"] == str(home)
for p in (home / ".config", home / ".config/hive"):
    p.mkdir(parents=True, exist_ok=True)
    p.chmod(0o2755)
control = home / ".local/state/hive/workspace-read"
processes = []
checks = {"manifestIdentitySynthetic": True}
installer = "/opt/hive-read-install-entry.py"


def run(value=request, success=True):
    result = subprocess.run(["/usr/bin/python3", "-I", "-B", installer], input=json.dumps(value).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HIVE_WORKSPACE_PROFILE": value["config"]["profile"]}, timeout=20)
    if success:
        assert result.returncode == 0, "installer rejected valid isolated request"
        reply = json.loads(result.stdout)
        assert reply["ready"] is True
        return reply
    assert result.returncode == 1 and result.stdout == b"" and result.stderr == b"workspace_read_install_failed\n"


def envelope():
    value = json.loads((control / "service.json").read_bytes())
    key = (control / "receipt-key").read_bytes()
    raw = json.dumps(value["record"], sort_keys=True, separators=(",", ":")).encode()
    assert hmac.compare_digest(value["signature"], hmac.new(key, raw, hashlib.sha256).hexdigest())
    return value


def fixture_record(record):
    # Deliberately synthetic negative/reboot/PID-reuse records, never a product
    # repair or an authorization endpoint. Original bytes are preserved below.
    key = (control / "receipt-key").read_bytes()
    raw = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
    value = {"record": record, "signature": hmac.new(key, raw, hashlib.sha256).hexdigest()}
    (control / "service.json").write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def inspect(pid):
    root = Path(f"/proc/{pid}")
    raw = (root / "stat").read_text()
    return {"startTime": raw[raw.rindex(") ") + 2:].split()[19], "executable": os.readlink(root / "exe")}


def stop(record):
    p = record["process"]
    current = inspect(p["pid"])
    assert current["startTime"] == p["startTime"] and current["executable"] == p["executable"]
    os.kill(p["pid"], signal.SIGTERM)  # Fresh exact own fixture process, before reap.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            waited, _ = os.waitpid(p["pid"], os.WNOHANG)
            if waited:
                break
        except ChildProcessError:
            if not Path(f"/proc/{p['pid']}").exists():
                break
        time.sleep(0.02)
    assert not Path(f"/proc/{p['pid']}").exists(), "own service did not exit/reap"
    processes.remove(record)


def track():
    record = envelope()["record"]
    assert record["phase"] == "ready"
    processes.append(record)
    return record


try:
    first = run()
    a = track()
    assert first["reused"] is False
    assert a["bootstrapConfigSha256"] == hashlib.sha256((json.dumps(request["config"], sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    assert a["runtimeIdentity"]["provisionalAgentId"] == request["config"]["binding"]["agentId"]
    effective = json.loads((home / ".config/hive/workspace-read.json").read_bytes())
    assert effective["binding"]["agentId"] == a["runtimeIdentity"]["agentId"] != request["config"]["binding"]["agentId"]
    assert a["configSha256"] != a["bootstrapConfigSha256"]
    checks["bootstrapAndEffectiveIdentityRecorded"] = True
    config = home / ".config/hive/workspace-read.json"
    before = (config.read_bytes(), config.stat().st_ino, config.stat().st_mtime_ns)
    histories = list((control / "history").iterdir())
    repeated = run()
    assert repeated["reused"] is True and repeated["lifetimeId"] == first["lifetimeId"]
    assert envelope()["record"]["process"] == a["process"]
    assert before == (config.read_bytes(), config.stat().st_ino, config.stat().st_mtime_ns)
    assert list((control / "history").iterdir()) == histories
    checks["actualNodeRepeatedVerifiedIdentity"] = True
    checks["existingConfigParentsUnchanged"] = (home / ".config").stat().st_mode & 0o7777 == 0o2755
    changed = json.loads(json.dumps(request))
    changed["config"]["projectsRoot"] += "/other"
    run(changed, False)
    assert before[0] == config.read_bytes() and inspect(a["process"]["pid"])["startTime"] == a["process"]["startTime"]
    checks["changedLiveRequestRejectedWithoutRestart"] = True
    original = (control / "service.json").read_bytes()
    changed_record = json.loads(json.dumps(a))
    changed_record["process"]["executable"] = "/different-executable"
    fixture_record(changed_record)
    run(success=False)
    assert inspect(a["process"]["pid"])["startTime"] == a["process"]["startTime"]
    (control / "service.json").write_bytes(original)
    checks["samePidSameStartChangedExecutableHeld"] = True
    stop(a)
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 13342))
    listener.listen()
    run(success=False)
    assert listener.fileno() >= 0
    listener.close()
    checks["unknownListenerNeverKilledOrAdopted"] = True
    restarted = run()
    b = track()
    assert restarted["reused"] is False and b["lifetimeId"] != a["lifetimeId"]
    stop(b)
    checks["provedAbsentProcessCanRestartOnFreePort"] = True
    reused = json.loads(json.dumps(b))
    reused["process"]["pid"] = os.getpid()
    reused["process"]["startTime"] = "0"
    fixture_record(reused)
    run()
    c = track()
    assert c["process"]["pid"] != os.getpid()
    stop(c)
    checks["reusedPidDoesNotKillUnrelatedLiveProcess"] = True
    old_boot = json.loads(json.dumps(c))
    old_boot["process"]["bootId"] = "prior-boot-fixture"
    fixture_record(old_boot)
    run()
    d = track()
    stop(d)
    checks["priorBootAbsenceCanRestartOnFreePort"] = True
    # A real child startup fails on an independently held service lock. The
    # installer retains the attempted PID and uncertainty, never silently retries.
    import fcntl
    lock_path = Path(request["config"]["stateDirectory"]) / "service.lock"
    with lock_path.open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(success=False)
    uncertain = envelope()["record"]
    assert uncertain["phase"] == "uncertain" and uncertain["attemptedPid"] > 0
    try:
        os.waitpid(uncertain["attemptedPid"], 0)
    except ChildProcessError:
        pass
    assert not Path(f"/proc/{uncertain['attemptedPid']}").exists()
    retained = (control / "service.json").read_bytes()
    run(success=False)
    assert (control / "service.json").read_bytes() == retained
    checks["actualUncertainStartupRetainedAndNotRetried"] = True
    assert len(list((control / "history").iterdir())) >= 8
    checks["historyAndPriorBuildStatePreserved"] = True
    assert not processes
    print(json.dumps({"passed": True, "checks": checks, "networkNamespace": os.readlink("/proc/self/ns/net"), "homeInode": str(home.stat().st_ino), "syntheticNodeRootOwnershipObservation": True}, separators=(",", ":")))
finally:
    for record in list(processes):
        stop(record)
