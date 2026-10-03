#!/usr/bin/env python3
"""Credential-free, pinned-CLI restricted sandbox diagnostic (no model calls)."""

import argparse
from datetime import datetime, timezone
import errno
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import socket
import subprocess
import tempfile

CODEX_VERSION = "codex-cli 0.160.0"


def run(argv, env=None, cwd=None, timeout=15):
    try:
        with subprocess.Popen(argv, env=env, cwd=cwd, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, start_new_session=True) as child:
            try:
                stdout, stderr = child.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
                return {"error": "timeout"}
            return {"status": child.returncode, "stdout": stdout[:4096], "stderr": stderr[:4096]}
    except OSError as error:
        return {"error": type(error).__name__, "errno": error.errno}


def read_public(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return "unavailable"


def classify(result, operation):
    """Only a completed probe reporting a specific syscall outcome is evidence."""
    if result.get("error") or result.get("status") != 0:
        return "unavailable"
    try:
        payload = json.loads(result["stdout"])
    except (ValueError, KeyError):
        return "unavailable"
    if not isinstance(payload, dict) or payload.get("probe") != operation:
        return "unavailable"
    if payload.get("outcome") == "allowed":
        return "allowed"
    denied_errors = {
        "outside": [errno.EACCES, errno.EPERM, errno.ENOENT],
        "symlink": [errno.EACCES, errno.EPERM, errno.ENOENT],
        "write": [errno.EACCES, errno.EPERM, errno.EROFS],
        "network": [errno.EACCES, errno.EPERM],
    }
    if payload.get("outcome") == "error" and payload.get("errno") in denied_errors.get(operation, []):
        return "denied"
    return "unavailable"


PROBE = r'''
import json, socket, sys
operation, target = sys.argv[1:]
result = {"probe": operation}
try:
    if operation == "network":
        with socket.create_connection(("127.0.0.1", int(target)), timeout=2):
            pass
    elif operation == "write":
        with open(target, "w") as f:
            f.write("CHANGED")
    else:
        with open(target) as f:
            expected = "INSIDE_FIXTURE" if operation == "inside" else "OUTSIDE_FIXTURE"
            if f.read() != expected:
                raise RuntimeError("unexpected fixture contents")
    result["outcome"] = "allowed"
except OSError as error:
    result.update(outcome="error", errno=error.errno)
print(json.dumps(result))
'''


def diagnose(codex):
    report = {
        "schemaVersion": 1, "passed": False, "kernel": platform.release(),
        "at": datetime.now(timezone.utc).isoformat(),
        "profile": os.environ.get("HIVE_WORKSPACE_PROFILE", "unknown"),
        "imageVariant": os.environ.get("HIVE_IMAGE_VARIANT", "unknown"),
        "apparmor": read_public("/proc/self/attr/current"),
        "processSecurity": [line for line in read_public("/proc/self/status").splitlines()
                            if line.startswith(("Cap", "NoNewPrivs:", "Seccomp"))],
        "sysctls": {name: read_public("/proc/sys/" + name) for name in (
            "kernel/unprivileged_userns_clone", "kernel/apparmor_restrict_unprivileged_userns",
            "user/max_user_namespaces")},
        "requiredCli": CODEX_VERSION,
    }
    report["namespaces"] = {
        name: run(["unshare", "--user", "--map-root-user", *args, "/bin/true"])
        for name, args in {
            "user": [], "mount": ["--mount", "--propagation", "unchanged"],
            "mountPropagation": ["--mount"],
        }.items()
    }
    executable = shutil.which(codex)
    if executable is None:
        report["blocker"] = "Codex missing; supply --codex /absolute/path/to/pinned/codex. No tool was installed."
        return report
    version = run([executable, "--version"])
    report["cli"] = version
    if version.get("status") != 0 or version.get("stdout", "").strip() != CODEX_VERSION:
        report["blocker"] = "CLI mismatch or unavailable; use an isolated 0.160.0 install. Existing tools are preserved."
        return report
    # Codex refuses helper aliases beneath /tmp. Use a fresh private home child,
    # never the user's real CODEX_HOME; cleanup only this generated directory.
    with tempfile.TemporaryDirectory(prefix=".hive-sandbox-", dir=Path.home()) as directory:
        base = Path(directory)
        root = base / "root"
        root.mkdir()
        inside = root / "inside.txt"
        outside = base / "outside.txt"
        inside.write_text("INSIDE_FIXTURE")
        outside.write_text("OUTSIDE_FIXTURE")
        (root / "escape.txt").symlink_to(outside)
        home = base / "home"
        home.mkdir()
        # Never load the user's Codex config, plugins, auth, or shell environment.
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home),
               "CODEX_HOME": str(home), "LANG": "C.UTF-8"}
        profile = ('permissions.hive-readiness={filesystem={":minimal"="read",'
                   + json.dumps(str(root)) + '="read"},network={enabled=false}}')
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(8)
            cases = {"inside": str(inside), "outside": str(outside),
                     "symlink": str(root / "escape.txt"), "write": str(inside),
                     "network": str(listener.getsockname()[1])}
            results = {}
            for operation, target in cases.items():
                command = ["/usr/bin/python3", "-I", "-c", PROBE, operation, target]
                # Positive controls make missing fixtures/tools and unavailable network fail closed.
                control = run(command, env=env, cwd=root)
                if operation == "write":
                    inside.write_text("INSIDE_FIXTURE")
                result = run([executable, "sandbox", "-P", "hive-readiness", "-c", profile,
                              "-C", str(root), "--", *command], env=env, cwd=root)
                results[operation] = {"control": control, "sandbox": result,
                                      "outcome": classify(result, operation)}
            report["results"] = results
        report["unchanged"] = inside.read_text() == "INSIDE_FIXTURE"
        report["passed"] = (
            report["unchanged"]
            and all(classify(value["control"], name) == "allowed" for name, value in results.items())
            and results["inside"]["outcome"] == "allowed"
            and all(results[name]["outcome"] == "denied" for name in ("outside", "symlink", "write", "network"))
        )
    if not report["passed"]:
        report["blocker"] = (
            "Restricted sandbox not ready. In Infrastructure, inspect node AppArmor audit denials, "
            "effective pod security context and runtime seccomp policy. Startup errors, timeouts, "
            "missing tools and connection failures are not isolation evidence. Do not broaden permissions."
        )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default="codex", help="Pinned CLI path; never installs or replaces tools")
    args = parser.parse_args()
    output = diagnose(args.codex)
    print(json.dumps(output, indent=2))
    raise SystemExit(0 if output["passed"] else 1)
