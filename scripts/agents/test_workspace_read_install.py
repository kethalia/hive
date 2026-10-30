"""Pure installer validation and real /proc identity checks; no listener is started."""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import uuid

SOURCE = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/install-workspace-read.py"
spec = importlib.util.spec_from_file_location("read_install", SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def package(home, members=None, extra=None):
    files = members or {"hive-workspace-read.mjs": b"export const fixture=true;\n", "hive-workspace-read.py": b"print('fixture')\n"}
    manifest = json.dumps({"schemaVersion": 1, "files": {k: hashlib.sha256(v).hexdigest() for k, v in files.items()}}, separators=(",", ":")).encode()
    files = {**files, "manifest.json": manifest}
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, raw in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(raw)
            member.mode = 0o400 if name.endswith(".json") else 0o500
            tar.addfile(member, io.BytesIO(raw))
        if extra:
            tar.addfile(extra)
    archive = output.getvalue()
    archive_sha = hashlib.sha256(archive).hexdigest()
    key = bytes.fromhex("302a300506032b6570032100") + bytes(range(32))
    config = {"schemaVersion": 1, "profile": "software", "projectsRoot": str(home), "home": str(home),
              "hiveOrigin": "https://hive.invalid", "issuerKeyId": "fixture", "issuerPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(key).decode() + "\n-----END PUBLIC KEY-----\n",
              "binding": {**{k: str(uuid.uuid4()) for k in installer.BINDING if not k.endswith("Origin")}, "coderOrigin": "https://coder.invalid", "appOrigin": "https://hive-read--main--fixture--owner.apps.invalid"},
              "manifestSha256": hashlib.sha256(manifest).hexdigest(), "port": 13342,
              "packageDirectory": str(home / ".local/share/hive/workspace-read" / archive_sha)}
    config["stateDirectory"] = str(home / ".local/state/hive/workspace-read" / config["binding"]["buildId"])
    return {"schemaVersion": 1, "archive": base64.b64encode(gzip.compress(archive, mtime=0)).decode(), "archiveSha256": archive_sha, "manifestSha256": config["manifestSha256"], "config": config}


class ReadInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hive-read-install-unit-")
        self.home = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_exact_archive_manifest_and_derived_paths_validate_on_each_profile(self):
        for profile in installer.PROFILES:
            request = package(self.home)
            request["config"]["profile"] = profile
            files, target, encoded = installer.validate(request, self.home, profile)
            self.assertEqual(set(files), installer.MEMBERS)
            self.assertEqual(target.name, request["archiveSha256"])
            self.assertEqual(json.loads(encoded), request["config"])

    def test_foreign_paths_keys_and_command_fields_reject_before_any_child(self):
        for change in ({"home": "/other"}, {"profile": "browser"}, {"port": 13343}, {"stateDirectory": str(self.home / "other")},
                       {"packageDirectory": str(self.home / "other")}, {"command": "id"}, {"issuerPublicKeyPem": "-----BEGIN PRIVATE KEY-----\nsecret\n"}):
            request = package(self.home)
            request["config"].update(change)
            with patch.object(installer.pwd, "getpwuid", return_value=type("User", (), {"pw_dir": str(self.home)})()), patch.dict(os.environ, {"HIVE_WORKSPACE_PROFILE": "software"}), patch.object(installer.subprocess, "Popen") as child:
                with self.assertRaises(Exception):
                    installer.install(request)
                child.assert_not_called()
            self.assertFalse((self.home / ".config").exists())

    def test_archive_corruption_duplicate_links_and_traversal_are_rejected(self):
        for name, kind in (("../outside", tarfile.REGTYPE), ("hive-workspace-read.py", tarfile.REGTYPE), ("linked", tarfile.SYMTYPE), ("dir", tarfile.DIRTYPE)):
            extra = tarfile.TarInfo(name)
            extra.type = kind
            extra.linkname = "hive-workspace-read.py" if kind == tarfile.SYMTYPE else ""
            request = package(self.home, extra=extra)
            with self.assertRaises(Exception):
                installer.validate(request, self.home, "software")
        request = package(self.home)
        request["manifestSha256"] = "0" * 64
        with self.assertRaises(Exception):
            installer.validate(request, self.home, "software")

    def test_gzip_bomb_concatenated_stream_and_trailing_data_are_bounded(self):
        request = package(self.home)
        for raw in (gzip.compress(b"x" * 131073), base64.b64decode(request["archive"]) + gzip.compress(b"other"), base64.b64decode(request["archive"]) + b"trailing"):
            bad = {**request, "archive": base64.b64encode(raw).decode()}
            with self.assertRaises(Exception):
                installer.validate(bad, self.home, "software")

    def test_private_files_reject_permission_hardlink_and_symlink_substitution(self):
        path = self.home / "config"
        path.write_bytes(b"private")
        path.chmod(0o600)
        self.assertEqual(installer.private_file(path), b"private")
        path.chmod(0o644)
        with self.assertRaises(Exception):
            installer.private_file(path)
        path.chmod(0o600)
        linked = self.home / "linked"
        os.link(path, linked)
        with self.assertRaises(Exception):
            installer.private_file(path)
        linked.unlink()
        linked.symlink_to(path)
        with self.assertRaises(Exception):
            installer.private_file(linked)

    def test_package_reuse_verifies_every_byte_and_never_adopts_extra_files(self):
        request = package(self.home)
        files, target, _ = installer.validate(request, self.home, "software")
        root = installer.directory(target.parent)
        installer.install_package(root, target, files)
        before = {p.name: (p.read_bytes(), p.stat().st_ino) for p in target.iterdir()}
        installer.install_package(root, target, files)
        self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_ino) for p in target.iterdir()})
        (target / "extra").write_text("unknown")
        with self.assertRaises(Exception):
            installer.install_package(root, target, files)
        self.assertTrue((target / "extra").exists())

    def test_real_process_identity_is_exact_and_changed_executable_is_not_absent(self):
        identity = installer.process_identity(os.getpid())
        self.assertEqual(installer.prior_state(identity), "same")
        with self.assertRaises(Exception):
            installer.prior_state({**identity, "executable": "/different"})

    def test_reused_pid_is_absent_but_same_start_changed_exe_or_inaccessible_proc_is_hold(self):
        record = {"pid": 12345, "bootId": "current", "startTime": "100", "executable": "/usr/bin/node"}
        def raw(start):
            return "12345 (node) " + " ".join(["S", *["0"] * 18, str(start)])
        with patch.object(installer, "boot_id", return_value="current"), patch.object(Path, "read_text", return_value=raw(200)), patch.object(installer, "process_identity") as inspect:
            self.assertEqual(installer.prior_state(record), "absent")
            inspect.assert_not_called()
        with patch.object(installer, "boot_id", return_value="current"), patch.object(Path, "read_text", return_value=raw(100)), patch.object(installer, "process_identity", return_value={**record, "executable": "/changed"}):
            with self.assertRaises(Exception):
                installer.prior_state(record)
        with patch.object(installer, "boot_id", return_value="current"), patch.object(Path, "read_text", side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                installer.prior_state(record)
        with patch.object(installer, "boot_id", return_value="new-boot"), patch.object(Path, "read_text") as inspect:
            self.assertEqual(installer.prior_state(record), "absent")
            inspect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
