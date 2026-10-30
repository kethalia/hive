import hashlib
import base64
import gzip
import importlib.util
import io
import json
import lzma
import zlib
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import tempfile
import types
import unittest
import uuid
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
    def test_compressed_bootstrap_decodes_with_strict_expansion_bounds(self):
        raw = b"template-owned fixture"
        request = {"archive": base64.b64encode(gzip.compress(raw, mtime=0)).decode(), "archiveEncoding": "gzip"}
        self.assertEqual(installer.decode_archive(request), raw)
        request["archive"] = base64.b64encode(gzip.compress(b"x" * (2 * 1024 * 1024 + 1), mtime=0)).decode()
        with self.assertRaises(RuntimeError):
            installer.decode_archive(request)
        request["archiveEncoding"] = "unknown"
        with self.assertRaises(RuntimeError):
            installer.decode_archive(request)

    def test_xz_bootstrap_is_bounded_complete_and_single_stream(self):
        raw = b"template-owned xz fixture"
        packed = lzma.compress(raw, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, preset=6)
        def decode(value):
            return installer.decode_archive({"archive": base64.b64encode(value).decode(), "archiveEncoding": "xz"})
        self.assertEqual(decode(packed), raw)
        changed = bytearray(packed); changed[-5] ^= 1
        for value in (packed[:-1], bytes(changed), packed+b"trailing", packed+packed,
                      lzma.compress(b"x" * (2 * 1024 * 1024 + 1)), b"x" * 160001):
            with self.assertRaises((RuntimeError, lzma.LZMAError)):
                decode(value)
        # Valid XZ block-header CRC with a 4-GiB dictionary declaration. Reject
        # from the memory bound before allocating it; no huge compressor fixture.
        large_dictionary = bytearray(packed)
        self.assertEqual((large_dictionary[12],large_dictionary[14],large_dictionary[15]), (2,0x21,1))
        large_dictionary[16] = 40
        large_dictionary[20:24] = zlib.crc32(large_dictionary[12:20]).to_bytes(4,"little")
        with self.assertRaises(lzma.LZMAError):
            decode(bytes(large_dictionary))

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

    def test_optional_guardian_requires_matching_elf_metadata_and_installs_without_compilation(self):
        binary = bytearray(64)
        binary[:6] = b"\x7fELF\x02\x01"
        binary[16:20] = b"\x03\x00\x3e\x00"
        binary = bytes(binary)
        original = json.loads(next(value for name, value, _ in self.entries if name == "package-manifest.json"))
        self.assertNotIn("guardian", original)
        for malformed in (None, "missing_metadata", "wrong_architecture", "wrong_digest", "not_elf"):
            manifest = json.loads(json.dumps(original))
            payload = b"#!/bin/sh\n" if malformed == "not_elf" else binary
            manifest["files"]["codex-native-guardian"] = hashlib.sha256(payload).hexdigest()
            if malformed != "missing_metadata":
                manifest["guardian"] = {"schemaVersion": 1, "platform": "linux", "architecture": "arm64" if malformed == "wrong_architecture" else "x64", "elfSha256": "0" * 64 if malformed == "wrong_digest" else hashlib.sha256(payload).hexdigest(), "sourceSha256": "1" * 64, "recipeSha256": "2" * 64}
            entries = [(name, json.dumps(manifest).encode() if name == "package-manifest.json" else value, kind) for name, value, kind in self.entries]
            content = archive(entries + [("codex-native-guardian", payload, tarfile.REGTYPE)])
            digest = hashlib.sha256(content).hexdigest()
            if malformed:
                with self.subTest(malformed=malformed), self.assertRaises(RuntimeError):
                    installer.package_files(content, digest)
            else:
                with tempfile.TemporaryDirectory() as directory, patch.object(installer.subprocess, "run") as run, patch.object(installer.subprocess, "Popen") as start:
                    installed = installer.install_package(Path(directory), content, digest)
                    self.assertEqual((installed / "codex-native-guardian").read_bytes(), binary)
                    self.assertEqual((installed / "codex-native-guardian").stat().st_mode & 0o777, 0o500)
                    run.assert_not_called()
                    start.assert_not_called()

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

    def test_delivery_execution_requires_explicit_complete_isolated_guardian_capability(self):
        legacy = {"profile": "software", "enabled": True, "managerEnabled": False}
        installer.validate_execution_config(legacy)
        with self.assertRaises(RuntimeError):
            installer.validate_execution_config({**legacy, "managerEnabled": True})
        enabled = {**legacy, "managerEnabled": True, "guardianEnabled": True,
                   "nativeIsolationEnabled": True, "deliveryExecutionEnabled": True}
        installer.validate_execution_config(enabled)
        for patch_value in ({"deliveryExecutionEnabled": "true"}, {"managerEnabled": False},
                            {"guardianEnabled": False}, {"nativeIsolationEnabled": False}):
            with self.assertRaises(RuntimeError):
                installer.validate_execution_config({**enabled, **patch_value})

    def test_acceptance_requires_exact_explicit_delivery_producer(self):
        producer = {"schemaVersion": 1, "codeDigest": "a" * 64, "promptDigest": "b" * 64, "schemaDigest": "c" * 64, "permissionsDigest": "5cb0236664ba9833dc964200828cc6b650583eb0b7d2bd43d587889c5a9b175b", "runtimeVersion": "0.165.0", "model": "gpt-6.1-sol", "effort": "low", "maxDurationMs": 30000, "maxInputBytes": 262144, "maxOutputBytes": 65536}
        enabled = {"profile": "software", "enabled": True, "managerEnabled": True, "guardianEnabled": True, "nativeIsolationEnabled": True, "deliveryExecutionEnabled": True, "acceptance": producer}
        installer.validate_execution_config(enabled)
        for patch_value in ({"allowTools": True}, {"maxDurationMs": 300001}, {"codeDigest": "invalid"}, {"maxInputBytes": True}, {"runtimeVersion": "future"}):
            with self.assertRaises(RuntimeError):
                installer.validate_execution_config({**enabled, "acceptance": {**producer, **patch_value}})
        with self.assertRaises(RuntimeError):
            installer.validate_execution_config({**enabled, "deliveryExecutionEnabled": False})

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


class GuardedReadinessTests(unittest.TestCase):
    def test_kernel_identity_matches_actual_process_and_parent(self):
        identity = installer.kernel_identity(os.getpid())
        self.assertEqual(identity["parentPid"], os.getppid())
        self.assertEqual({key: identity[key] for key in installer.process_identity(os.getpid())}, installer.process_identity(os.getpid()))
        self.assertEqual(installer.kernel_identity(os.getpid(), False), {key: identity[key] for key in ("pid", "parentPid", "startTime", "bootId")})

    def test_startup_channel_accepts_one_bounded_frame_only(self):
        for payload, accepted in [(b'{"type":"ready"}\n', True), (b'{}\n{}\n', False), (b'x' * 32769, False), (b'not-json\n', False), (b'', False)]:
            with self.subTest(size=len(payload)):
                reader, writer = socket.socketpair()
                try:
                    writer.sendall(payload)
                    writer.shutdown(socket.SHUT_WR)
                    if accepted:
                        self.assertEqual(installer.startup_reply(reader), {"type": "ready"})
                    else:
                        with self.assertRaises((RuntimeError, ValueError)):
                            installer.startup_reply(reader)
                finally:
                    reader.close()
                    writer.close()

    def test_ready_binds_exact_nonce_package_config_and_kernel_chain(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            node, guardian_path = root / "node", root / "codex-native-guardian"
            node.write_bytes(b"fixture node bytes")
            guardian_path.write_bytes(b"fixture guardian bytes")
            node.chmod(0o500)
            guardian_path.chmod(0o500)
            digest = lambda value: hashlib.sha256(value).hexdigest()
            worker_hash = digest(b"fixed worker")
            manifest = {"files": {"codex-workspace-host-worker.mjs": worker_hash, "codex-native-guardian": digest(guardian_path.read_bytes())}, "guardian": {"elfSha256": digest(guardian_path.read_bytes())}}
            manifest_bytes = json.dumps(manifest).encode()
            installer.atomic(root / "package-manifest.json", manifest_bytes)
            config = {"port": 43210, "guardianEnabled": True}
            config_bytes = (json.dumps(config, separators=(",", ":"), sort_keys=True) + "\n").encode()
            start = {"schemaVersion": 1, "type": "start", "nonce": base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("="), "configSha256": digest(config_bytes), "packageManifestSha256": digest(manifest_bytes), "nodeSha256": digest(node.read_bytes()), "port": config["port"]}
            def identity(pid, parent, path):
                info = path.stat()
                return {"pid": pid, "parentPid": parent, "startTime": str(pid + 100), "bootId": "a7c69fb9-d39d-4d88-99df-08190049c226", "executable": str(path), "device": str(info.st_dev), "inode": str(info.st_ino)}
            outer, guardian, worker = identity(1000, os.getpid(), node), identity(1001, 1000, guardian_path), identity(1002, 1001, node)
            ready = {**start, "type": "ready", "workerSha256": worker_hash, "guardianSha256": digest(guardian_path.read_bytes()), "lifetimeId": str(uuid.uuid4()), "bindingDigest": "a" * 64, "ownershipDigest": "b" * 64, "generation": 1, "phase": "open", "projects": [], "outerIdentity": outer, "guardianIdentity": guardian, "workerIdentity": worker}
            receipt_identity = {key: outer[key] for key in ("pid", "startTime", "bootId", "executable")}
            live = {entry["pid"]: entry for entry in (outer, guardian, worker)}
            def inspect(pid, with_executable=True):
                found = live[pid]
                return dict(found) if with_executable else {key: found[key] for key in ("pid", "parentPid", "startTime", "bootId")}
            startup = {"start": start, "ready": ready}
            with patch.object(installer, "kernel_identity", side_effect=inspect):
                self.assertEqual(installer.guarded_ready(receipt_identity, config, startup, root, initial=True), 1002)
                # Parent exit may reparent the same outer; guardian and worker edges stay exact.
                live[1000] = {**outer, "parentPid": 1}
                self.assertEqual(installer.guarded_ready(receipt_identity, config, startup, root), 1002)
                with self.assertRaises(RuntimeError):
                    installer.guarded_ready(receipt_identity, config, startup, root, initial=True)
                live[1000] = outer
                mutations = [
                    {"nonce": "y" * 43}, {"configSha256": "0" * 64}, {"packageManifestSha256": "0" * 64},
                    {"workerSha256": "0" * 64}, {"guardianSha256": "0" * 64}, {"phase": "closed"},
                    {"workerIdentity": {**worker, "startTime": "1"}}, {"workerIdentity": {**worker, "parentPid": 999}},
                    {"guardianIdentity": {**guardian, "parentPid": 999}}, {"guardianIdentity": {**guardian, "inode": "0"}},
                    {"outerIdentity": {**outer, "executable": "/tmp/other"}}, {"extra": True},
                ]
                for change in mutations:
                    with self.subTest(change=change), self.assertRaises(RuntimeError):
                        installer.guarded_ready(receipt_identity, config, {"start": start, "ready": {**ready, **change}}, root)
                with self.assertRaises(RuntimeError):
                    installer.guarded_ready(receipt_identity, config, {"start": start, "ready": None}, root)


if __name__ == "__main__":
    unittest.main()
