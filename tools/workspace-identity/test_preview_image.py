"""Preview publication guards use fixed registry fixtures without network access."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "preview_image", Path(__file__).with_name("preview-image.py")
)
preview = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preview)

SOURCE = "a" * 40
CONFIG_DIGEST = "sha256:" + "b" * 64
MANIFEST = json.dumps({"config": {"digest": CONFIG_DIGEST}}).encode()
MANIFEST_DIGEST = "sha256:" + hashlib.sha256(MANIFEST).hexdigest()
PIN = {
    "schemaVersion": 1,
    "sdkVersion": "v2.38.4",
    "goVersion": "go1.26.10",
    "sha256": "c" * 64,
}


class PreviewImageTests(unittest.TestCase):
    def environment(self, variant="cli"):
        return {
            "EXPECTED_SOURCE_SHA": SOURCE,
            "GITHUB_SHA": SOURCE,
            "GITHUB_REPOSITORY": "kethalia/hive",
            "GITHUB_REF": "refs/heads/codex/workspace-accounts-p03",
            "PREVIEW_VARIANT": variant,
            "EXPECTED_LOCAL_IMAGE_ID": CONFIG_DIGEST,
        }

    def registry(self, variant, published=False, target_exists=None):
        tag = f"preview-{variant}-{SOURCE}"
        self.calls = []

        def fetch(url, token=None):
            self.calls.append((url, token))
            token_url = preview.REGISTRY + "/token?service=ghcr.io&scope=repository:kethalia/hive-base:pull"
            if url == token_url:
                self.assertIsNone(token)
                return 200, b'{"token":"fixture-public-pull"}', {}
            self.assertEqual(token, "fixture-public-pull")
            prefix = preview.REGISTRY + "/v2/" + preview.PACKAGE + "/manifests/"
            if url == prefix + "cli-latest":
                return 200, b"public-package-fixture", {}
            self.assertEqual(url, prefix + tag)
            if target_exists is False or (target_exists is None and not published):
                return 404, b"", {}
            return 200, MANIFEST, {"Docker-Content-Digest": MANIFEST_DIGEST}

        return fetch

    def test_each_variant_requires_public_package_and_absent_exact_tag(self):
        for variant in sorted(preview.VARIANTS):
            with (
                self.subTest(variant=variant),
                patch.dict(os.environ, self.environment(variant), clear=True),
            ):
                with patch.object(preview, "fetch", side_effect=self.registry(variant)):
                    result = preview.run("absent")
                self.assertEqual(result["variant"], variant)
                self.assertEqual(result["sourceSha"], SOURCE)
                self.assertTrue(result["targetAbsent"])
                self.assertEqual(
                    result["imageTag"], f"ghcr.io/kethalia/hive-base:preview-{variant}-{SOURCE}"
                )
                self.assertEqual(len(self.calls), 3)

    def test_each_published_variant_proves_its_exact_local_and_registry_identity(self):
        for variant in sorted(preview.VARIANTS):
            for local_id, kind in ((CONFIG_DIGEST, "config"), (MANIFEST_DIGEST, "manifest")):
                environment = {**self.environment(variant), "EXPECTED_LOCAL_IMAGE_ID": local_id}
                with (
                    self.subTest(variant=variant, local_id=kind),
                    patch.dict(os.environ, environment, clear=True),
                    patch.object(preview, "fetch", side_effect=self.registry(variant, published=True)),
                    patch.object(Path, "read_text", return_value=json.dumps(PIN)),
                ):
                    result = preview.run("published")
                    self.assertEqual(result["variant"], variant)
                    self.assertEqual(result["image"], "ghcr.io/kethalia/hive-base@" + MANIFEST_DIGEST)
                    self.assertEqual(result["localImageIdKind"], kind)
                    self.assertEqual(result["helperSha256"], PIN["sha256"])
                    self.assertFalse(result["activation"])

    def test_invalid_scope_is_rejected_before_any_registry_read(self):
        for field, value in (
            ("PREVIEW_VARIANT", "infra"),
            ("PREVIEW_VARIANT", "cli/../../main"),
            ("PREVIEW_VARIANT", ""),
            ("GITHUB_REF", "refs/heads/main"),
            ("GITHUB_REPOSITORY", "another/hive"),
            ("EXPECTED_SOURCE_SHA", "a" * 39),
            ("GITHUB_SHA", "d" * 40),
        ):
            with (
                self.subTest(field=field, value=value),
                patch.dict(os.environ, {**self.environment(), field: value}, clear=True),
            ):
                with patch.object(preview, "fetch") as fetch, self.assertRaises(RuntimeError):
                    preview.run("absent")
                fetch.assert_not_called()

    def test_unknown_mode_is_rejected_before_any_registry_read(self):
        with patch.object(preview, "fetch") as fetch, self.assertRaises(RuntimeError):
            preview.run("replace")
        fetch.assert_not_called()

    def test_default_variant_remains_cli(self):
        environment = self.environment()
        del environment["PREVIEW_VARIANT"]
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(preview, "fetch", side_effect=self.registry("cli")),
        ):
            self.assertEqual(preview.run("absent")["variant"], "cli")

    def test_existing_target_and_missing_publication_are_rejected(self):
        for mode, exists in (("absent", True), ("published", False)):
            with (
                self.subTest(mode=mode),
                patch.dict(os.environ, self.environment(), clear=True),
                patch.object(preview, "fetch", side_effect=self.registry("cli", target_exists=exists)),
                self.assertRaises(RuntimeError),
            ):
                preview.run(mode)

    def test_unrelated_local_image_and_modified_helper_pin_are_rejected(self):
        for local_id, pin in (
            ("sha256:" + "d" * 64, PIN),
            (CONFIG_DIGEST, {**PIN, "sdkVersion": "unreviewed"}),
        ):
            environment = {**self.environment(), "EXPECTED_LOCAL_IMAGE_ID": local_id}
            with (
                self.subTest(local_id=local_id, pin=pin),
                patch.dict(os.environ, environment, clear=True),
                patch.object(preview, "fetch", side_effect=self.registry("cli", published=True)),
                patch.object(Path, "read_text", return_value=json.dumps(pin)),
                self.assertRaises(RuntimeError),
            ):
                preview.run("published")


if __name__ == "__main__":
    unittest.main()
