"""Installer identity normalization. RPC itself is proven by the pinned Go tests."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
MODULES = []
for name in ("install-workspace-read", "install-codex-host", "install-agent-bridge", "install-voice"):
    spec = importlib.util.spec_from_file_location(name, ROOT / "templates/ai-dev-k8s/scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    MODULES.append(module)


class IdentityInstallTests(unittest.TestCase):
    def config(self):
        return {"binding": {"coderOrigin": "https://coder.invalid", "workspaceId": str(uuid.uuid4()), "buildId": str(uuid.uuid4()), "appId": str(uuid.uuid4()), "appOrigin": "https://hive-read--main--work--owner.apps.invalid", "agentId": str(uuid.uuid4())}, "unmodified": {"nested": True}}

    def exercise(self, module, mutate=lambda value: value, failures=(), persistent=None, late_success=False):
        config = self.config()
        before = json.dumps(config, sort_keys=True)
        actual = str(uuid.uuid4())
        fds = []
        clock = types.SimpleNamespace(now=0.0)
        self.helper_calls = []
        self.helper_sleeps = []
        def sleep(seconds):
            self.helper_sleeps.append(seconds)
            clock.now += seconds
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "helper"
            binary.write_bytes(b"fixed fixture helper, not an executable")
            pin = Path(directory) / "pin.json"
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            pin.write_text(json.dumps({"schemaVersion": 1, "sdkVersion": "v2.38.4", "goVersion": "go1.26.10", "sha256": digest}))
            def asset(path, _limit, _executable=False):
                selected = pin if str(path).endswith(".json") else binary
                fd = os.open(selected, os.O_RDONLY)
                fds.append(fd)
                return fd, selected.read_bytes()
            def run(args, **options):
                self.assertEqual(args, [f"/proc/self/fd/{fds[0]}"])
                self.assertEqual(os.readlink(f"/proc/self/fd/{fds[0]}"), str(binary))
                self.assertGreater(options["timeout"], 0)
                self.assertLessEqual(options["timeout"], 11)
                self.helper_calls.append(options)
                self.assertEqual(options["stderr"], subprocess.DEVNULL)
                self.assertEqual(options["env"], {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "CODER_AGENT_URL": "https://coder.invalid", "CODER_AGENT_TOKEN": "fixture-agent"})
                request = json.loads(options["input"])
                fields = ["schemaVersion", "sdkVersion", "kind", "coderOrigin", "workspaceId", "buildId", "appId", "appOrigin", "provisionalAgentId", "agentId"]
                response = {**request, "sdkVersion": "v2.38.4", "agentId": actual}
                selected = {key: response[key] for key in fields}
                response["manifestBindingSha256"] = hashlib.sha256(json.dumps(selected, separators=(",", ":")).encode()).hexdigest()
                failure = failures[len(self.helper_calls) - 1] if len(self.helper_calls) <= len(failures) else persistent
                if failure == "timeout":
                    clock.now += options["timeout"]
                    raise subprocess.TimeoutExpired("fixed helper", options["timeout"])
                if failure == "exit":
                    raise subprocess.CalledProcessError(1, "fixed helper")
                if late_success:
                    clock.now += 30
                response = mutate(response)
                return types.SimpleNamespace(stdout=json.dumps(response).encode())
            try:
                with patch.object(module, "image_asset", side_effect=asset), patch.object(module.subprocess, "run", side_effect=run), patch.object(module.subprocess, "Popen", side_effect=AssertionError("Identity normalization must not launch a service")), patch.object(module.time, "monotonic", side_effect=lambda: clock.now), patch.object(module.time, "sleep", side_effect=sleep), patch.dict(os.environ, {"CODER_AGENT_URL": "https://coder.invalid", "CODER_AGENT_TOKEN": "fixture-agent", "CODER_SESSION_TOKEN": "owner-not-forwarded"}, clear=True):
                    kind = {"install-workspace-read": "workspace-read", "install-codex-host": "project-host", "install-agent-bridge": "agent-tools", "install-voice": "voice"}[module.__name__]
                    value = module.normalize_agent_config(config, kind)
            finally:
                self.helper_elapsed = clock.now
                self.assertEqual(json.dumps(config, sort_keys=True), before)
                for fd in fds:
                    with self.assertRaises(OSError):
                        os.fstat(fd)
        return config, actual, value

    def test_all_installers_preserve_bootstrap_and_normalize_only_agent(self):
        for module in MODULES:
            with self.subTest(module=module.__name__):
                original, actual, (effective, evidence) = self.exercise(module)
                self.assertNotEqual(original["binding"]["agentId"], actual)
                expected = json.loads(json.dumps(original))
                expected["binding"]["agentId"] = actual
                self.assertEqual(effective, expected)
                self.assertEqual(evidence["provisionalAgentId"], original["binding"]["agentId"])
                self.assertEqual(evidence["agentId"], actual)
                self.assertEqual(len(evidence["helperSha256"]), 64)
                self.assertEqual(len(self.helper_calls), 1)
                self.assertEqual(self.helper_sleeps, [])

    def test_transient_failed_or_timed_out_reads_can_recover_without_reinstall_or_launch(self):
        for module in MODULES:
            for failures in (("exit", "timeout"), ("timeout", "exit")):
                with self.subTest(module=module.__name__, failures=failures):
                    _, actual, (effective, _) = self.exercise(module, failures=failures)
                    self.assertEqual(effective["binding"]["agentId"], actual)
                    self.assertEqual(len(self.helper_calls), 3)
                    self.assertEqual(self.helper_sleeps, [0.5, 1.0])
                    self.assertLess(self.helper_elapsed, 30)

    def test_deadline_caps_each_helper_timeout_and_stops_reading(self):
        for module in MODULES:
            with self.subTest(module=module.__name__):
                with self.assertRaises(subprocess.TimeoutExpired):
                    self.exercise(module, persistent="timeout")
                self.assertEqual([call["timeout"] for call in self.helper_calls], [11, 11, 6.5])
                self.assertEqual(self.helper_elapsed, 30)

    def test_fast_read_failures_stop_at_attempt_limit(self):
        for module in MODULES:
            with self.subTest(module=module.__name__):
                with self.assertRaises(subprocess.CalledProcessError):
                    self.exercise(module, persistent="exit")
                self.assertEqual(len(self.helper_calls), 10)
                self.assertEqual(len(self.helper_sleeps), 9)
                self.assertLessEqual(max(self.helper_sleeps), 4)
                self.assertLess(self.helper_elapsed, 30)

    def test_valid_reply_after_deadline_is_not_accepted_or_retried(self):
        for module in MODULES:
            with self.subTest(module=module.__name__):
                with self.assertRaises(RuntimeError):
                    self.exercise(module, late_success=True)
                self.assertEqual(len(self.helper_calls), 1)
                self.assertEqual(self.helper_sleeps, [])

    def test_malformed_or_changed_manifest_output_never_changes_config(self):
        def wrong_scope(value):
            changed = {**value, "buildId": str(uuid.uuid4())}
            fields = ["schemaVersion", "sdkVersion", "kind", "coderOrigin", "workspaceId", "buildId", "appId", "appOrigin", "provisionalAgentId", "agentId"]
            changed["manifestBindingSha256"] = hashlib.sha256(json.dumps({key: changed[key] for key in fields}, separators=(",", ":")).encode()).hexdigest()
            return changed
        changes = [lambda v: {**v, "agentId": str(uuid.uuid4())}, wrong_scope, lambda v: {**v, "schemaVersion": True}, lambda v: {**v, "sdkVersion": "different"}, lambda v: {**v, "extra": True}]
        for module in MODULES:
            for change in changes:
                with self.subTest(module=module.__name__), self.assertRaises(RuntimeError):
                    self.exercise(module, change)
                self.assertEqual(len(self.helper_calls), 1)
                self.assertEqual(self.helper_sleeps, [])

    def test_same_build_changed_agent_or_legacy_receipt_is_held(self):
        for module in MODULES[:2]:
            with tempfile.TemporaryDirectory() as directory:
                config = self.config()
                path = Path(directory) / "config.json"
                raw = (json.dumps(config) + "\n").encode()
                path.write_bytes(raw)
                path.chmod(0o600)
                identity = {"buildId": config["binding"]["buildId"], "agentId": str(uuid.uuid4()), "manifestBindingSha256": "1" * 64}
                previous = {"runtimeIdentity": identity}
                module.same_build_identity(previous, dict(identity), path)
                for changed in ({**identity, "agentId": str(uuid.uuid4())}, {**identity, "manifestBindingSha256": "2" * 64}):
                    with self.assertRaises(RuntimeError):
                        module.same_build_identity(previous, changed, path)
                legacy = {"configSha256": hashlib.sha256(raw).hexdigest()}
                with self.assertRaises(RuntimeError):
                    module.same_build_identity(legacy, identity, path)
                module.same_build_identity(legacy, {**identity, "buildId": str(uuid.uuid4())}, path)

    def test_user_writable_image_asset_is_never_trusted(self):
        for module in MODULES:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "binary"
                path.write_bytes(b"fixture")
                with self.assertRaises(RuntimeError):
                    module.image_asset(path, 4096, True)


if __name__ == "__main__":
    unittest.main()
