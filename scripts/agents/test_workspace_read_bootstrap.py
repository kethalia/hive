#!/usr/bin/env python3
import base64
import gzip
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("read_bootstrap", Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/start-workspace-read.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BootstrapTests(unittest.TestCase):
    def encoded(self, source):
        return base64.b64encode(gzip.compress(source, mtime=0)), hashlib.sha256(source).hexdigest().encode()

    def test_exact_pinned_installer_bytes(self):
        source = (Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/install-workspace-read.py").read_bytes()
        encoded, checksum = self.encoded(source)
        self.assertEqual(module.decode_installer(encoded, checksum + b"\n"), source)

    def test_rejects_changed_source_checksum_and_invalid_base64(self):
        encoded, checksum = self.encoded(b"print('must not execute')")
        for value, digest in [(encoded, b"0" * 64), (encoded + b"\n", checksum), (b"!", checksum), (encoded, checksum + b"junk")]:
            with self.assertRaises(Exception):
                module.decode_installer(value, digest)

    def test_rejects_extra_stream_and_trailing_bytes(self):
        source = b"fixed source"
        encoded, checksum = self.encoded(source)
        for suffix in [gzip.compress(b"second"), b"trailing"]:
            with self.assertRaises(Exception):
                module.decode_installer(base64.b64encode(base64.b64decode(encoded) + suffix), checksum)

    def test_rejects_truncated_and_oversized_output(self):
        encoded, checksum = self.encoded(b"x" * 65537)
        with self.assertRaises(Exception):
            module.decode_installer(encoded, checksum)
        encoded, checksum = self.encoded(b"valid")
        with self.assertRaises(Exception):
            module.decode_installer(base64.b64encode(base64.b64decode(encoded)[:-4]), checksum)

    def test_rejects_oversized_input_and_empty_source(self):
        with self.assertRaises(Exception):
            module.decode_installer(b"A" * 32769, b"a" * 64)
        encoded, checksum = self.encoded(b"")
        with self.assertRaises(Exception):
            module.decode_installer(encoded, checksum)


if __name__ == "__main__":
    unittest.main()
