"""Read-only registry preconditions and published digest proof; no Docker/push."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("image_preview", ROOT / "tools/workspace-identity/preview-image.py")
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class ImagePreviewTests(unittest.TestCase):
    def setUp(self):
        self.env = {"EXPECTED_SOURCE_SHA": "a" * 40, "GITHUB_SHA": "a" * 40, "GITHUB_REPOSITORY": "kethalia/hive", "GITHUB_REF": "refs/heads/codex/delivery-system-design"}

    def test_wrong_ref_or_sha_rejects_before_registry_read(self):
        for change in ({"EXPECTED_SOURCE_SHA": "a" * 39}, {"GITHUB_SHA": "b" * 40}, {"GITHUB_REF": "refs/heads/main"}, {"GITHUB_REPOSITORY": "fork/hive"}):
            with patch.dict(os.environ, {**self.env, **change}, clear=True), patch.object(preview, "fetch") as fetch:
                with self.assertRaises(RuntimeError):
                    preview.run("absent")
                fetch.assert_not_called()

    def test_only_positive_public_package_and_exact404_are_absence(self):
        for public_status, tag_status, accepted in ((200, 404, True), (200, 200, False), (403, 404, False), (200, 500, False)):
            replies = [(200, b'{"token":"anonymous-fixture"}', {}), (public_status, b"", {}), (tag_status, b"", {})]
            with patch.dict(os.environ, self.env, clear=True), patch.object(preview, "fetch", side_effect=replies):
                if accepted:
                    self.assertTrue(preview.run("absent")["targetAbsent"])
                else:
                    with self.assertRaises(RuntimeError):
                        preview.run("absent")

    def test_published_manifest_must_match_smoke_tested_config_digest(self):
        manifest = json.dumps({"config": {"digest": "sha256:" + "c" * 64}}, separators=(",", ":")).encode()
        digest = "sha256:" + hashlib.sha256(manifest).hexdigest()
        pin = {"schemaVersion": 1, "sdkVersion": "v2.38.4", "goVersion": "go1.26.10", "sha256": "d" * 64}
        replies = [(200, b'{"token":"anonymous-fixture"}', {}), (200, b"", {}), (200, manifest, {"Docker-Content-Digest": digest})]
        for config, accepted in (("sha256:" + "c" * 64, True), ("sha256:" + "e" * 64, False)):
            with patch.dict(os.environ, {**self.env, "EXPECTED_CONFIG_DIGEST": config}, clear=True), patch.object(preview, "fetch", side_effect=replies), patch.object(Path, "read_text", return_value=json.dumps(pin)):
                if accepted:
                    proof = preview.run("published")
                    self.assertEqual(proof["image"], "ghcr.io/kethalia/hive-base@" + digest)
                    self.assertFalse(proof["activation"])
                    self.assertEqual(proof["helperSha256"], pin["sha256"])
                else:
                    with self.assertRaises(RuntimeError):
                        preview.run("published")

    def test_registry_digest_header_is_not_trusted_without_body_hash(self):
        replies = [(200, b'{"token":"anonymous-fixture"}', {}), (200, b"", {}), (200, b"{}", {"Docker-Content-Digest": "sha256:" + "f" * 64})]
        with patch.dict(os.environ, self.env, clear=True), patch.object(preview, "fetch", side_effect=replies):
            with self.assertRaises(RuntimeError):
                preview.run("published")


if __name__ == "__main__":
    unittest.main()
