"""Actual Python PTY proof; no Coder/GitHub/network or existing user files."""
import base64
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "src/lib/workspace/paste-writer.ts"
WRITER = SOURCE.read_text().split("String.raw`", 1)[1].split("`;", 1)[0]
NONCE = "a" * 32


class Writer:
    def __init__(self, root):
        source = WRITER.replace("ROOT='/tmp/hive-terminal-paste'", "ROOT=" + repr(str(root))).replace("signal.alarm(110)", "signal.alarm(2)")
        self.master, slave = pty.openpty()
        self.child = subprocess.Popen(["python3", "-I", "-c", source, NONCE], stdin=slave, stdout=slave, stderr=subprocess.DEVNULL)
        os.close(slave)
        self.buffer = b""

    def read(self):
        while b"\n" not in self.buffer:
            if not select.select([self.master], [], [], 3)[0]:
                raise AssertionError("bounded PTY read")
            self.buffer += os.read(self.master, 8192)
        line, self.buffer = self.buffer.split(b"\n", 1)
        value = json.loads(line)
        assert value.pop("nonce") == NONCE
        return value

    def send(self, value):
        raw = json.dumps(value).encode() + b"\n"
        while raw:
            count = os.write(self.master, raw)
            raw = raw[count:]

    def close(self):
        self.child.wait(timeout=4)
        os.close(self.master)


class PasteWriterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hive-paste-writer-")
        self.root = Path(self.temp.name) / "paste"
        self.writer = None

    def tearDown(self):
        if self.writer:
            self.writer.close()
        self.temp.cleanup()

    def start(self):
        self.writer = Writer(self.root)
        return self.writer

    def test_binary_exact_bytes_digest_fsync_and_private_nonoverwrite(self):
        writer = self.start()
        self.assertEqual(writer.read(), {"type": "ready"})
        data = bytes(range(256)) * 150
        digest = hashlib.sha256(data).hexdigest()
        writer.send({"files": [{"name": "fixed-file.bin", "size": len(data), "sha256": digest}]})
        self.assertEqual(writer.read(), {"type": "manifest"})
        writer.send({"type": "file", "index": 0})
        for sequence, offset in enumerate(range(0, len(data), 16384)):
            writer.send({"sequence": sequence, "data": base64.b64encode(data[offset:offset+16384]).decode()})
            self.assertEqual(writer.read(), {"type": "chunk", "index": 0, "sequence": sequence})
        self.assertEqual(writer.read(), {"type": "file", "index": 0, "size": len(data), "sha256": digest, "path": str(self.root / "fixed-file.bin")})
        self.assertEqual(writer.read(), {"type": "complete"})
        self.assertEqual((self.root / "fixed-file.bin").read_bytes(), data)
        self.assertEqual((self.root / "fixed-file.bin").stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.root.glob("*.part")), [])

    def test_bad_digest_retains_no_partial_or_final_file(self):
        writer = self.start(); writer.read()
        writer.send({"files": [{"name": "bad.bin", "size": 1, "sha256": "0"*64}]}); writer.read()
        writer.send({"type": "file", "index": 0})
        writer.send({"sequence": 0, "data": "eA=="}); writer.read()
        self.assertEqual(writer.read(), {"type": "error"})
        writer.child.wait(timeout=3)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_ten_empty_files_are_explicitly_admitted_one_at_a_time(self):
        writer = self.start(); writer.read()
        digest = hashlib.sha256(b"").hexdigest()
        writer.send({"files": [{"name": f"empty-{index}", "size": 0, "sha256": digest} for index in range(10)]})
        writer.read()
        for index in range(10):
            writer.send({"type": "file", "index": index})
            self.assertEqual(writer.read()["index"], index)
        self.assertEqual(writer.read(), {"type": "complete"})

    def test_symlink_directory_never_escapes(self):
        outside = Path(self.temp.name) / "outside"; outside.mkdir()
        self.root.symlink_to(outside, target_is_directory=True)
        writer = self.start()
        self.assertEqual(writer.read(), {"type": "error"})
        self.assertEqual(list(outside.iterdir()), [])

    def test_existing_final_is_never_overwritten(self):
        self.root.mkdir(mode=0o700)
        target = self.root / "exists"; target.write_bytes(b"retained")
        writer = self.start(); writer.read()
        writer.send({"files": [{"name": "exists", "size": 0, "sha256": hashlib.sha256(b"").hexdigest()}]}); writer.read()
        writer.send({"type": "file", "index": 0})
        self.assertEqual(writer.read(), {"type": "error"})
        writer.child.wait(timeout=3)
        self.assertEqual(target.read_bytes(), b"retained")
        self.assertFalse((self.root / "exists.part").exists())

    def test_self_timeout_cleans_partial_after_input_stops(self):
        writer = self.start(); writer.read()
        writer.send({"files": [{"name": "unfinished", "size": 10, "sha256": "a"*64}]}); writer.read()
        writer.send({"type": "file", "index": 0})
        self.assertEqual(writer.read(), {"type": "error"})
        writer.child.wait(timeout=3)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_preexisting_partial_symlink_is_not_followed_or_removed(self):
        self.root.mkdir(mode=0o700)
        outside=Path(self.temp.name)/"outside-file";outside.write_bytes(b"retained")
        partial=self.root/"symlink.part";partial.symlink_to(outside)
        writer=self.start();writer.read()
        writer.send({"files":[{"name":"symlink","size":0,"sha256":hashlib.sha256(b"").hexdigest()}]});writer.read()
        writer.send({"type":"file","index":0})
        self.assertEqual(writer.read(),{"type":"error"})
        writer.child.wait(timeout=3)
        self.assertEqual(outside.read_bytes(),b"retained")
        self.assertTrue(partial.is_symlink())

    def test_path_escape_manifest_rejected(self):
        writer = self.start(); writer.read()
        writer.send({"files": [{"name": "../escape", "size": 0, "sha256": "a"*64}]})
        self.assertEqual(writer.read(), {"type": "error"})
        self.assertFalse((Path(self.temp.name) / "escape").exists())

    def test_unknown_active_writer_prevents_another_ready_without_queueing(self):
        writer = self.start()
        self.assertEqual(writer.read(), {"type": "ready"})
        other = Writer(self.root)
        try:
            self.assertEqual(other.read(), {"type": "error"})
            other.child.wait(timeout=1)
            self.assertNotEqual(other.child.returncode, 0)
        finally:
            other.close()


if __name__ == "__main__":
    unittest.main()
