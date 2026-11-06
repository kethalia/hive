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
for name in ("install-workspace-read", "install-codex-host"):
    spec = importlib.util.spec_from_file_location(name, ROOT / "templates/ai-dev-k8s/scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    MODULES.append(module)


class IdentityInstallTests(unittest.TestCase):
    def config(self):
        return {"binding": {"coderOrigin": "https://coder.invalid", "workspaceId": str(uuid.uuid4()), "buildId": str(uuid.uuid4()), "appId": str(uuid.uuid4()), "appOrigin": "https://hive-read--main--work--owner.apps.invalid", "agentId": str(uuid.uuid4())}, "unmodified": {"nested": True}}

    def exercise(self, module, mutate=lambda value: value, failure=False):
        config = self.config()
        before = json.dumps(config, sort_keys=True)
        actual = str(uuid.uuid4())
        fds = []
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
                self.assertEqual(options["timeout"], 11)
                self.assertEqual(options["stderr"], subprocess.DEVNULL)
                self.assertEqual(options["env"], {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "CODER_AGENT_URL": "https://coder.invalid", "CODER_AGENT_TOKEN": "fixture-agent"})
                request = json.loads(options["input"])
                fields = ["schemaVersion", "sdkVersion", "kind", "coderOrigin", "workspaceId", "buildId", "appId", "appOrigin", "provisionalAgentId", "agentId"]
                response = {**request, "sdkVersion": "v2.38.4", "agentId": actual}
                selected = {key: response[key] for key in fields}
                response["manifestBindingSha256"] = hashlib.sha256(json.dumps(selected, separators=(",", ":")).encode()).hexdigest()
                if failure:
                    raise subprocess.TimeoutExpired("fixed helper", 11)
                response = mutate(response)
                return types.SimpleNamespace(stdout=json.dumps(response).encode())
            with patch.object(module, "image_asset", side_effect=asset), patch.object(module.subprocess, "run", side_effect=run), patch.dict(os.environ, {"CODER_AGENT_URL": "https://coder.invalid", "CODER_AGENT_TOKEN": "fixture-agent", "CODER_SESSION_TOKEN": "owner-not-forwarded"}, clear=True):
                value = module.normalize_agent_config(config, "workspace-read")
            self.assertEqual(json.dumps(config, sort_keys=True), before)
        for fd in fds:
            with self.assertRaises(OSError):
                os.fstat(fd)
        return config, actual, value

    def test_both_installers_preserve_bootstrap_and_normalize_only_agent(self):
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

    def test_malformed_or_changed_manifest_output_never_changes_config(self):
        changes = [lambda v: {**v, "agentId": str(uuid.uuid4())}, lambda v: {**v, "buildId": str(uuid.uuid4())}, lambda v: {**v, "schemaVersion": True}, lambda v: {**v, "sdkVersion": "different"}, lambda v: {**v, "extra": True}]
        for module in MODULES:
            for change in changes:
                with self.subTest(module=module.__name__), self.assertRaises(RuntimeError):
                    self.exercise(module, change)
            with self.assertRaises(subprocess.TimeoutExpired):
                self.exercise(module, failure=True)

    def test_same_build_changed_agent_or_legacy_receipt_is_held(self):
        for module in MODULES:
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
