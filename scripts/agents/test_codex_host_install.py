import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("installer", ROOT / "templates/ai-dev-k8s/scripts/install-codex-host.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def archive(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as stream:
        for name, value, kind in entries:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(value) if kind == tarfile.REGTYPE else 0
            info.linkname = "/tmp/outside" if kind == tarfile.SYMTYPE else ""
            stream.addfile(info, io.BytesIO(value) if kind == tarfile.REGTYPE else None)
    return out.getvalue()


class HostInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        bundle = Path(cls.temp.name) / "bundle"
        subprocess.run(["node", "scripts/build-codex-host-bundle.mjs", str(bundle)], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        cls.entries = [(str(path.relative_to(bundle)), path.read_bytes(), tarfile.REGTYPE) for path in sorted(bundle.rglob("*")) if path.is_file()]
        cls.content = archive(cls.entries)
        cls.digest = hashlib.sha256(cls.content).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_valid_package_is_private_idempotent_and_preserves_other_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prior = root / "prior-version"
            prior.mkdir()
            (prior / "journal").write_text("retain")
            installed = installer.install_package(root, self.content, self.digest)
            subprocess.run(["python3", str(installed / "codex-project-lease.py")], input=b"{}", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.assertFalse((installed / "__pycache__").exists())
            self.assertEqual(installer.install_package(root, self.content, self.digest), installed)
            self.assertEqual((prior / "journal").read_text(), "retain")
            self.assertEqual(installed.stat().st_mode & 0o777, 0o700)
            self.assertEqual((installed / "codex-workspace-host.mjs").stat().st_mode & 0o777, 0o500)

    def test_rejects_archive_digest_manifest_tamper_traversal_links_and_duplicates(self):
        bad = [
            (self.content, "0" * 64),
            (archive(self.entries + [("../escape", b"x", tarfile.REGTYPE)]), None),
            (archive(self.entries + [("linked.mjs", b"", tarfile.SYMTYPE)]), None),
            (archive(self.entries + [self.entries[0]]), None),
            (archive([(name, value + b"bad" if name == "codex-workspace-host.mjs" else value, kind) for name, value, kind in self.entries]), None),
        ]
        for content, digest in bad:
            with self.subTest(digest=digest), self.assertRaises(Exception):
                installer.package_files(content, digest or hashlib.sha256(content).hexdigest())

    def test_existing_tampered_package_and_symlink_are_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installed = installer.install_package(root, self.content, self.digest)
            module = installed / "codex-workspace-host.mjs"
            module.chmod(0o600)
            module.write_bytes(b"user edit")
            with self.assertRaises(RuntimeError):
                installer.install_package(root, self.content, self.digest)
            self.assertEqual(module.read_bytes(), b"user edit")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / self.digest).symlink_to(root, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                installer.install_package(root, self.content, self.digest)

    def test_existing_live_config_changes_fail_before_replacement_or_spawn(self):
        import base64
        config = {"managerEnabled": False, "profile": "software", "enabled": True}
        request = {"schemaVersion": 1, "archive": base64.b64encode(self.content).decode(), "archiveSha256": self.digest, "config": config}
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = installer.private_directory(home / ".local/state/hive/codex-host-install")
            old_config = installer.private_directory(home / ".config/hive") / "codex-host.json"
            installer.atomic(old_config, b"retained config")
            installer.atomic(state / "process.json", json.dumps({"process": installer.process_identity(os.getpid()), "archiveSha256": self.digest, "configSha256": "0" * 64}).encode())
            with patch.dict(os.environ, {"HIVE_WORKSPACE_PROFILE": "software"}), patch.object(installer.pwd, "getpwuid", return_value=types.SimpleNamespace(pw_dir=str(home))), patch.object(installer.subprocess, "run"), patch.object(installer.subprocess, "Popen") as start, patch.object(installer.subprocess, "check_output", return_value=b"24"):
                with self.assertRaises(RuntimeError):
                    installer.install(request)
                start.assert_not_called()
            self.assertEqual(old_config.read_bytes(), b"retained config")

    def test_specialist_activation_is_rejected_before_start(self):
        with patch.dict(os.environ, {"HIVE_WORKSPACE_PROFILE": "browser"}), patch.object(installer.subprocess, "Popen") as start:
            with self.assertRaises(RuntimeError):
                installer.install({})
            start.assert_not_called()

    def test_listener_ownership_is_bound_to_actual_process(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            self.assertTrue(installer.listener_owned(os.getpid(), listener.getsockname()[1]))
            self.assertFalse(installer.listener_owned(2147483647, listener.getsockname()[1]))


class BuildIdentityTests(unittest.TestCase):
    def test_only_valid_provisioner_identity_is_accepted(self):
        script = ROOT / "templates/ai-dev-k8s/scripts/hive-build-identity.sh"
        good = "22c4f094-46f0-4a76-86ca-37ad74254872"
        for value in [good, "", good + "\nBAD", "'$(touch /tmp/do-not-run)'", "INVALID"]:
            result = subprocess.run(["sh", str(script)], env={"PATH": "/usr/bin:/bin", "CODER_WORKSPACE_BUILD_ID": value}, capture_output=True, text=True)
            if value == good:
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout), {"build_id": good})
            else:
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
