"""Read-only acceptance inspector tests. No Coder/network/workspace calls."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("runtime_probe", ROOT / "scripts/probe-workspace-runtime-identity.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class RuntimeProbeTests(unittest.TestCase):
    def test_normalized_receipt_keeps_original_bootstrap_digest(self):
        provisional, actual = str(uuid.uuid4()), str(uuid.uuid4())
        expected = {"coderOrigin": "https://coder.invalid", "workspaceId": str(uuid.uuid4()), "buildId": str(uuid.uuid4()), "appId": str(uuid.uuid4()), "appOrigin": "https://hive-read--main--work--owner.apps.invalid", "agentId": actual}
        config = {"binding": dict(expected)}
        bootstrap = {"config": {"binding": {**expected, "agentId": provisional}}}
        identity = {"schemaVersion": 1, "sdkVersion": "v2.38.4", "kind": "workspace-read", **{k: expected[k] for k in ("coderOrigin", "workspaceId", "buildId", "appId", "appOrigin")}, "provisionalAgentId": provisional, "agentId": actual}
        identity["manifestBindingSha256"] = probe.sha(json.dumps(identity, separators=(",", ":")).encode())
        identity["helperSha256"] = "a" * 64
        record = {"configSha256": probe.sha(probe.canonical(config)), "bootstrapConfigSha256": probe.sha(probe.canonical(bootstrap["config"])), "runtimeIdentity": identity}
        result = probe.identity(config, record, bootstrap, expected, "a" * 64)
        self.assertTrue(result["agentNormalized"])
        self.assertNotEqual(result["bootstrapConfigSha256"], result["effectiveConfigSha256"])
        record["runtimeIdentity"]["agentId"] = provisional
        with self.assertRaises(RuntimeError):
            probe.identity(config, record, bootstrap, expected, "a" * 64)

    def test_private_evidence_rejects_link_and_shared_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "receipt"
            file.write_bytes(b"fixture")
            file.chmod(0o600)
            self.assertEqual(probe.read(file, 32), b"fixture")
            file.chmod(0o644)
            with self.assertRaises(RuntimeError):
                probe.read(file, 32)
            file.chmod(0o600)
            linked = Path(directory) / "alias"
            linked.symlink_to(file)
            with self.assertRaises(RuntimeError):
                probe.read(linked, 32)

    def test_current_package_bytes_must_match_pinned_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = root / "module.mjs"
            module.write_bytes(b"fixed")
            module.chmod(0o500)
            manifest = json.dumps({"files": {module.name: probe.sha(module.read_bytes())}}).encode()
            (root / "manifest.json").write_bytes(manifest)
            (root / "manifest.json").chmod(0o400)
            probe.verify_package(root, "manifest.json", probe.sha(manifest))
            module.chmod(0o600)
            module.write_bytes(b"drift")
            with self.assertRaises(RuntimeError):
                probe.verify_package(root, "manifest.json", probe.sha(manifest))

    def test_proc_observation_pins_actual_owned_node_and_never_uses_stale_pid(self):
        node = Path("/usr/bin/node")
        if not node.is_file():
            self.skipTest("fixed Node executable unavailable; no replacement installed")
        args = [str(node), "-e", "setTimeout(()=>{},5000)"]
        child = subprocess.Popen(args, env={"PATH": "/usr/bin:/bin"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            root = Path("/proc") / str(child.pid)
            raw = (root / "stat").read_text()
            record = {"pid": child.pid, "startTime": raw[raw.rindex(") ") + 2:].split()[19], "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "executable": str(node), "executableSha256": probe.sha(node.read_bytes())}
            keys = probe.process(record, args)
            self.assertNotIn(b"CODER_SESSION_TOKEN", keys)
            self.assertFalse(any(k.startswith(b"CODER_AGENT_") for k in keys))
            with self.assertRaises(RuntimeError):
                probe.process({**record, "startTime": "0"}, args)
        finally:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
