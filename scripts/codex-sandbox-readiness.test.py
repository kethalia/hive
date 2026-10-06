"""Regression tests for evidence classification; these do not prove host isolation."""
import errno
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "templates/ai-dev-k8s/scripts/codex-sandbox-readiness.py"
spec = importlib.util.spec_from_file_location("readiness", source)
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


def completed(operation, outcome="allowed", error=None):
    return {"status": 0, "stdout": json.dumps({"probe": operation, "outcome": outcome, "errno": error}), "stderr": ""}


SAFE_STATUS = "\n".join(
    [key + ":\t0000000000000000" for key in readiness.CAPABILITY_FIELDS]
    + ["NoNewPrivs:\t1", "Seccomp:\t0", "Seccomp_filters:\t0"])


def public_security(path):
    return {"/proc/self/attr/current": readiness.APPARMOR_PROFILE,
            "/proc/self/status": SAFE_STATUS}.get(path, "1")


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(readiness, "read_public", side_effect=public_security)
        patcher.start()
        self.addCleanup(patcher.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.runtime = Path(directory.name)
        (self.runtime / "bin").mkdir()
        (self.runtime / "codex-resources").mkdir()
        self.native = str(self.runtime / "bin/codex")
        readiness.shutil.copyfile(sys.executable, self.native)
        self.helper = self.runtime / "codex-resources/bwrap"
        self.helper.write_bytes(b"test bundled helper")
        digest = hashlib.sha256(self.helper.read_bytes()).hexdigest()
        pin = patch.object(readiness, "BWRAP_SHA256", digest)
        pin.start()
        self.addCleanup(pin.stop)

    def test_unsafe_or_missing_outer_context_never_runs_probes(self):
        contexts = [(profile, SAFE_STATUS) for profile in (
            "unconfined", "hive-codex-v1 (complain)", "other (enforce)", "unavailable", "")]
        contexts += [(readiness.APPARMOR_PROFILE, status) for status in (
            "", "unavailable", SAFE_STATUS.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
            SAFE_STATUS.replace("NoNewPrivs:\t1", ""),
            SAFE_STATUS + "\nNoNewPrivs:\t1")]
        for key in readiness.CAPABILITY_FIELDS:
            line = key + ":\t0000000000000000"
            contexts += [(readiness.APPARMOR_PROFILE, status) for status in (
                SAFE_STATUS.replace(line, ""), SAFE_STATUS + "\n" + line,
                SAFE_STATUS.replace(line, key + ":\t0000000000000001"),
                SAFE_STATUS.replace(line, key + ":\tunavailable"))]
        for writable in (False, True):
            for profile, status in contexts:
                with self.subTest(profile=profile, status=status, writable=writable):
                    def read(path):
                        return {"/proc/self/attr/current": profile,
                                "/proc/self/status": status}.get(path, "1")
                    with patch.object(readiness, "read_public", side_effect=read), patch.object(readiness, "run") as run:
                        report = readiness.diagnose(sys.executable, writable=writable)
                    self.assertFalse(report["passed"])
                    self.assertTrue(report["outerSecurityBlockers"])
                    self.assertNotIn("results", report)
                    run.assert_not_called()

    def test_recorded_canary_has_required_outer_context(self):
        for filename in ("before-read.json", "after-read.json", "after-write.json"):
            evidence = json.loads((Path(__file__).resolve().parents[1] / "docs/checks/codex-sandbox/rollout" / filename).read_text())
            self.assertEqual(readiness.outer_security_blockers(
                evidence["apparmor"], evidence["processSecurity"]), [])

    def test_startup_failure_is_not_denial_even_with_a_forged_marker(self):
        result = completed("outside", "error", errno.EACCES)
        result.update(status=1, stderr="bwrap: Failed to make / slave: Permission denied")
        self.assertEqual(readiness.classify(result, "outside"), "unavailable")

    def test_timeouts_signals_missing_tools_and_invalid_output_are_not_denials(self):
        for result in [{"error": "timeout"}, {"error": "FileNotFoundError"},
                       {"status": -9}, {"status": 127}, {"status": 0, "stdout": "[]"},
                       {"status": 0, "stdout": ""}, completed("inside", "error", errno.EACCES)]:
            with self.subTest(result=result):
                self.assertEqual(readiness.classify(result, "outside"), "unavailable")

    def test_only_explicit_boundary_errors_count(self):
        for operation, error in [("outside", errno.ENOENT), ("symlink", errno.EACCES),
                                 ("write", errno.EROFS), ("network", errno.EPERM)]:
            self.assertEqual(readiness.classify(completed(operation, "error", error), operation), "denied")
        for error in [errno.ETIMEDOUT, errno.ECONNREFUSED, errno.ENETUNREACH, None]:
            self.assertEqual(readiness.classify(completed("network", "error", error), "network"), "unavailable")
        self.assertEqual(readiness.classify(completed("write", "error", errno.ENOENT), "write"), "unavailable")

    def test_allowed_escape_is_reported(self):
        self.assertEqual(readiness.classify(completed("outside"), "outside"), "allowed")

    def test_subprocess_timeout_and_missing_executable(self):
        self.assertEqual(readiness.run(["/nonexistent/hive-test-tool"])["error"], "FileNotFoundError")
        self.assertEqual(readiness.run([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.05),
                         {"error": "timeout"})

    def test_script_launcher_is_rejected(self):
        with patch.object(readiness.shutil, "which", return_value=str(source)):
            report = readiness.diagnose("codex")
        self.assertFalse(report["passed"])
        self.assertIn("native ELF", report["blocker"])

    def test_mismatched_cli_never_runs_sandbox(self):
        calls = []
        def fake_run(argv, **_):
            calls.append(argv)
            return {"status": 0, "stdout": "codex-cli 0.159.0\n", "stderr": ""}
        with patch.object(readiness.shutil, "which", return_value=self.native), patch.object(readiness, "run", fake_run):
            report = readiness.diagnose("codex")
        self.assertFalse(report["passed"])
        self.assertFalse(any("sandbox" in argv for argv in calls))
        self.assertIn("mismatch", report["blocker"])

    def test_scoped_write_requires_a_real_fixture_change(self):
        for change_file in (False, True):
            def fake_run(argv, **_):
                if argv[0] == "unshare":
                    return {"status": 0, "stdout": "", "stderr": ""}
                if "--version" in argv:
                    return {"status": 0, "stdout": readiness.CODEX_VERSION, "stderr": ""}
                operation = argv[-2]
                if "sandbox" not in argv:
                    return completed(operation)
                if operation == "write" and change_file:
                    Path(argv[-1]).write_text("CHANGED")
                return (completed(operation) if operation in ("inside", "write")
                        else completed(operation, "error", errno.EACCES))
            with patch.object(readiness.shutil, "which", return_value=self.native), patch.object(readiness, "run", fake_run):
                report = readiness.diagnose("codex", writable=True)
            self.assertEqual(report["passed"], change_file)

    def test_escaping_reads_and_writes_cannot_pass(self):
        for writable in (False, True):
            for escape in ("runtime-sibling", *readiness.ESCAPE_WRITES):
                for lie_about_denial in (False, True):
                    with self.subTest(writable=writable, escape=escape, lie=lie_about_denial):
                        def fake_run(argv, **_):
                            if argv[0] == "unshare":
                                return {"status": 0, "stdout": "", "stderr": ""}
                            if "--version" in argv:
                                return {"status": 0, "stdout": readiness.CODEX_VERSION, "stderr": ""}
                            operation = argv[-2]
                            if "sandbox" not in argv:
                                return completed(operation)
                            if operation == "write" and writable:
                                Path(argv[-1]).write_text("CHANGED")
                                return completed(operation)
                            if operation == escape:
                                if escape in readiness.ESCAPE_WRITES:
                                    Path(argv[-1]).write_text("ESCAPED")
                                    if lie_about_denial:
                                        return completed(operation, "error", errno.EACCES)
                                return completed(operation)
                            return (completed(operation) if operation == "inside"
                                    else completed(operation, "error", errno.EACCES))
                        with patch.object(readiness.shutil, "which", return_value=self.native), patch.object(readiness, "run", fake_run):
                            report = readiness.diagnose(self.native, writable=writable)
                        self.assertFalse(report["passed"])
                        if escape in readiness.ESCAPE_WRITES:
                            self.assertFalse(report["results"][escape]["externalFixturesUnchanged"])
                        self.assertEqual(list((self.runtime / "bin").iterdir()), [Path(self.native)])

    def test_runtime_sentinel_controls_and_isolated_helper_path(self):
        seen = {}
        def fake_run(argv, **kwargs):
            if argv[0] == "unshare":
                return {"status": 0, "stdout": "", "stderr": ""}
            if "--version" in argv:
                return {"status": 0, "stdout": readiness.CODEX_VERSION, "stderr": ""}
            operation = argv[-2]
            empty_path = Path(kwargs["env"]["PATH"])
            self.assertTrue(empty_path.is_dir())
            self.assertEqual(list(empty_path.iterdir()), [])
            if operation == "runtime-sibling":
                target = Path(argv[-1])
                self.assertEqual(target.parent, Path(self.native).parent)
                self.assertEqual(target.read_text(), "OUTSIDE_FIXTURE")
                seen["sentinel"] = target
            if "sandbox" not in argv:
                # Exercise the actual Python probe, including every positive write control.
                child = readiness.subprocess.run(argv, env=kwargs["env"], cwd=kwargs["cwd"],
                                                 capture_output=True, text=True, timeout=5)
                return {"status": child.returncode, "stdout": child.stdout, "stderr": child.stderr}
            return (completed(operation) if operation == "inside"
                    else completed(operation, "error", errno.EACCES))
        with patch.object(readiness.shutil, "which", return_value=self.native), patch.object(readiness, "run", fake_run):
            report = readiness.diagnose(self.native)
        self.assertTrue(report["passed"])
        self.assertEqual(report["bubblewrap"]["sha256"], readiness.BWRAP_SHA256)
        self.assertFalse(seen["sentinel"].exists())

    def test_missing_or_changed_bundled_helper_never_runs_sandbox(self):
        for missing in (False, True):
            if missing:
                self.helper.unlink()
            else:
                self.helper.write_bytes(b"wrong helper")
            with patch.object(readiness.shutil, "which", return_value=self.native), patch.object(
                readiness, "run", return_value={"status": 0, "stdout": readiness.CODEX_VERSION}
            ) as run:
                report = readiness.diagnose(self.native)
            self.assertFalse(report["passed"])
            self.assertIn("bubblewrap", report["blocker"])
            self.assertFalse(any("sandbox" in call.args[0] for call in run.call_args_list))

    def test_failure_cannot_be_hidden_by_passing_other_cases(self):
        for failed in [None, "inside", "outside", "symlink", "write", "network", "runtime-sibling", *readiness.ESCAPE_WRITES, "control"]:
            def fake_run(argv, **_):
                if argv[0] == "unshare":
                    return {"status": 0, "stdout": "", "stderr": ""}
                if "--version" in argv:
                    return {"status": 0, "stdout": readiness.CODEX_VERSION, "stderr": ""}
                operation = argv[-2]
                if "sandbox" not in argv:
                    return {"error": "timeout"} if failed == "control" else completed(operation)
                if operation == failed:
                    return {"status": 1, "stderr": "bwrap startup failure", "stdout": ""}
                return completed(operation) if operation == "inside" else completed(operation, "error", errno.EACCES)
            with patch.object(readiness.shutil, "which", return_value=self.native), patch.object(readiness, "run", fake_run):
                report = readiness.diagnose("codex")
            self.assertEqual(report["passed"], failed is None, failed)


if __name__ == "__main__":
    unittest.main()
