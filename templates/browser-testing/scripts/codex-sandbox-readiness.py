#!/usr/bin/env python3
"""Credential-free, pinned-CLI restricted sandbox diagnostic (no model calls)."""

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import socket
import subprocess
import tempfile

BWRAP_PINS = {
    "codex-cli 0.160.0": "01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8",
    "codex-cli 0.160.1": "77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c",
}
APPARMOR_PROFILE = "hive-codex-v1 (enforce)"
CAPABILITY_FIELDS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")
ESCAPE_WRITES = ("outside-write", "symlink-write", "outside-create", "symlink-create")


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
        "runtime-sibling": [errno.EACCES, errno.EPERM, errno.ENOENT],
        "write": [errno.EACCES, errno.EPERM, errno.EROFS],
        "network": [errno.EACCES, errno.EPERM],
        **{name: [errno.EACCES, errno.EPERM, errno.EROFS, errno.ENOENT] for name in ESCAPE_WRITES},
    }
    if payload.get("outcome") == "error" and payload.get("errno") in denied_errors.get(operation, []):
        return "denied"
    return "unavailable"


def outer_security_blockers(apparmor, process_security):
    """Require affirmative outer-boundary evidence before running any probes."""
    blockers = []
    if apparmor != APPARMOR_PROFILE:
        blockers.append("expected AppArmor profile: " + APPARMOR_PROFILE)
    fields = {}
    for line in process_security:
        key, separator, value = line.partition(":")
        if separator:
            fields.setdefault(key, []).append(value.strip())
    # Missing, malformed and duplicate fields fail closed, as do nonzero masks.
    for key in CAPABILITY_FIELDS:
        if fields.get(key) != ["0000000000000000"]:
            blockers.append(key + " must be present exactly once and zero")
    if fields.get("NoNewPrivs") != ["1"]:
        blockers.append("NoNewPrivs must be present exactly once and enabled")
    return blockers


PROBE = r'''
import json, socket, sys
operation, target = sys.argv[1:]
result = {"probe": operation}
try:
    if operation == "network":
        with socket.create_connection(("127.0.0.1", int(target)), timeout=2):
            pass
    elif operation in ("write", "outside-write", "symlink-write", "outside-create", "symlink-create"):
        # Never mistake creation of a private tmpfs shadow for overwriting an
        # existing external file. Creation is tested separately on a real
        # read-only bind mount outside the writable root.
        mode = "r+" if operation in ("outside-write", "symlink-write") else "w"
        with open(target, mode) as f:
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


def diagnose(codex, writable=False):
    report = {
        "schemaVersion": 1, "passed": False, "writableFixture": writable, "kernel": platform.release(),
        "at": datetime.now(timezone.utc).isoformat(),
        "profile": os.environ.get("HIVE_WORKSPACE_PROFILE", "unknown"),
        "imageVariant": os.environ.get("HIVE_IMAGE_VARIANT", "unknown"),
        "apparmor": read_public("/proc/self/attr/current"),
        "processSecurity": [line for line in read_public("/proc/self/status").splitlines()
                            if line.startswith(("Cap", "NoNewPrivs:", "Seccomp"))],
        "sysctls": {name: read_public("/proc/sys/" + name) for name in (
            "kernel/unprivileged_userns_clone", "kernel/apparmor_restrict_unprivileged_userns",
            "user/max_user_namespaces")},
        "supportedCli": sorted(BWRAP_PINS),
    }
    report["outerSecurityBlockers"] = outer_security_blockers(
        report["apparmor"], report["processSecurity"])
    if report["outerSecurityBlockers"]:
        report["blocker"] = "Outer security context is unsafe or unavailable; no probes were run."
        return report
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
    # A launcher script is not the executable re-entered inside bubblewrap.
    # Require the pinned native ELF so the only extra readable path is explicit.
    executable = str(Path(executable).resolve())
    with open(executable, "rb") as binary:
        if binary.read(4) != b"\x7fELF":
            report["blocker"] = "Supply --codex with the pinned native ELF, not its npm launcher."
            return report
    report["runtimeReadableExecutable"] = executable
    version = run([executable, "--version"])
    report["cli"] = version
    required_digest = BWRAP_PINS.get(version.get("stdout", "").strip())
    if version.get("status") != 0 or required_digest is None:
        report["blocker"] = "CLI mismatch or unavailable; supported versions: " + ", ".join(sorted(BWRAP_PINS)) + ". Existing tools are preserved."
        return report
    helper = Path(executable).parent.parent / "codex-resources" / "bwrap"
    try:
        helper_digest = hashlib.sha256(helper.read_bytes()).hexdigest()
    except OSError:
        helper_digest = None
    report["bubblewrap"] = {"selection": "bundled-only", "path": str(helper),
                            "sha256": helper_digest, "requiredSHA256": required_digest}
    if helper_digest != required_digest:
        report["blocker"] = "Pinned bundled bubblewrap is missing or has a different digest."
        return report
    # Codex refuses helper aliases beneath /tmp. Use a fresh private home child,
    # never the user's real CODEX_HOME; cleanup only this generated directory.
    with ExitStack() as stack:
        directory = stack.enter_context(tempfile.TemporaryDirectory(prefix=".hive-sandbox-", dir=Path.home()))
        try:
            runtime_sibling = stack.enter_context(tempfile.NamedTemporaryFile(
                mode="w", prefix=".hive-runtime-sentinel-", dir=Path(executable).parent))
        except OSError:
            report["blocker"] = "Use a separately copied runtime in a writable directory for the sibling probe."
            return report
        runtime_sibling.write("OUTSIDE_FIXTURE")
        runtime_sibling.flush()
        base = Path(directory)
        root = base / "root"
        root.mkdir()
        inside = root / "inside.txt"
        outside = base / "outside.txt"
        read_only = base / "read-only"
        read_only.mkdir()
        outside_new = read_only / "outside-new.txt"
        inside.write_text("INSIDE_FIXTURE")
        outside.write_text("OUTSIDE_FIXTURE")
        (root / "escape.txt").symlink_to(outside)
        (root / "escape-new.txt").symlink_to(outside_new)
        home = base / "home"
        home.mkdir()
        empty_path = home / "empty-path"
        empty_path.mkdir()
        # Never load the user's Codex config, plugins, auth, or shell environment.
        # Absolute command paths need no PATH tools. Exclude system bwrap so
        # Codex can only fall back to the digest-checked bundled helper.
        env = {"PATH": str(empty_path), "HOME": str(home),
               "CODEX_HOME": str(home), "LANG": "C.UTF-8"}
        access = "write" if writable else "read"
        profile = ('permissions.hive-readiness={filesystem={":minimal"="read",'
                   + json.dumps(str(root)) + '=' + json.dumps(access) + ','
                   + json.dumps(str(read_only)) + '="read",'
                   + json.dumps(str(Path(executable).resolve())) + '="read"},network={enabled=false}}')
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(8)
            cases = {"inside": str(inside), "outside": str(outside),
                     "symlink": str(root / "escape.txt"), "write": str(inside),
                     "outside-write": str(outside), "symlink-write": str(root / "escape.txt"),
                     "outside-create": str(outside_new), "symlink-create": str(root / "escape-new.txt"),
                     "runtime-sibling": runtime_sibling.name,
                     "network": str(listener.getsockname()[1])}
            results = {}
            for operation, target in cases.items():
                command = ["/usr/bin/python3", "-I", "-c", PROBE, operation, target]
                # Positive controls make missing fixtures/tools and unavailable network fail closed.
                control = run(command, env=env, cwd=root)
                if operation == "write":
                    inside.write_text("INSIDE_FIXTURE")
                if operation in ESCAPE_WRITES:
                    outside.write_text("OUTSIDE_FIXTURE")
                    outside_new.unlink(missing_ok=True)
                result = run([executable, "sandbox", "-P", "hive-readiness", "-c", profile,
                              "-C", str(root), "--", *command], env=env, cwd=root)
                results[operation] = {"control": control, "sandbox": result,
                                      "outcome": classify(result, operation),
                                      "externalFixturesUnchanged": (
                                          outside.read_text() == "OUTSIDE_FIXTURE"
                                          and not outside_new.exists())}
            report["results"] = results
        report["unchanged"] = inside.read_text() == "INSIDE_FIXTURE"
        report["passed"] = (
            inside.read_text() == ("CHANGED" if writable else "INSIDE_FIXTURE")
            and all(classify(value["control"], name) == "allowed" for name, value in results.items())
            and results["inside"]["outcome"] == "allowed"
            and results["write"]["outcome"] == ("allowed" if writable else "denied")
            and all(value["externalFixturesUnchanged"] for value in results.values())
            and all(results[name]["outcome"] == "denied" for name in (
                "outside", "symlink", "network", "runtime-sibling", *ESCAPE_WRITES))
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
    parser.add_argument("--codex", default=str(Path.home() / ".local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"), help="Pinned native CLI ELF; never installs or replaces tools")
    parser.add_argument("--writable-fixture", action="store_true", help="Also verify a scoped writable fixture; no user files are touched")
    args = parser.parse_args()
    output = diagnose(args.codex, args.writable_fixture)
    print(json.dumps(output, indent=2))
    raise SystemExit(0 if output["passed"] else 1)
