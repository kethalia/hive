import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "pruner", ROOT / "templates/ai-dev-k8s/scripts/prune-turbo-cache.py")
pruner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pruner)


class CacheSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.projects = Path(self.tmp.name) / "projects"
        self.repo = self.projects / "repo"
        self.cache = self.repo / ".turbo/cache"
        self.cache.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)

    def cache_file(self, name="0123456789abcdef.tar.zst", age=8 * 86400):
        path = self.cache / name
        path.write_text("reproducible")
        os.utime(path, (1000000 - age, 1000000 - age))
        return path

    def test_only_old_recognized_objects(self):
        old = self.cache_file()
        recent = self.cache_file("abcdef0123456789-meta.json", age=3600)
        unrelated = self.cache_file("user-notes.json")
        self.assertEqual(pruner.prune(self.projects, now=1000000), (1, 12))
        self.assertTrue(old.exists())
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(unrelated.exists())

    def test_tracked_cache_is_preserved(self):
        old = self.cache_file()
        subprocess.run(["git", "-C", str(self.repo), "add", ".turbo"], check=True)
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertTrue(old.exists())

    def test_symlinked_cache_directory_is_preserved(self):
        target = Path(self.tmp.name) / "outside"
        self.cache.rename(target)
        self.cache.symlink_to(target, target_is_directory=True)
        old = self.cache_file()
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertTrue(old.exists())

    def test_symlinked_object_is_preserved(self):
        target = self.repo / "source.txt"
        target.write_text("source")
        (self.cache / "0123456789abcdef.tar.zst").symlink_to(target)
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertEqual(target.read_text(), "source")

    def test_bounded_deletion(self):
        self.cache_file()
        self.cache_file("abcdef0123456789.tar.zst")
        self.assertEqual(pruner.prune(self.projects, now=1000000, maximum=1, apply=True), (1, 12))
        self.assertEqual(len(list(self.cache.iterdir())), 1)

    def test_timeout_skips_repository_and_continues(self):
        old = self.cache_file()
        other = self.projects / "other"
        cache = other / ".turbo/cache"
        cache.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(other)], check=True)
        removable = cache / old.name
        removable.write_bytes(old.read_bytes())
        os.utime(removable, (1, 1))
        real_run = subprocess.run

        def probe(args, **kwargs):
            if args[2] == str(self.repo):
                raise subprocess.TimeoutExpired(args, 10)
            self.assertTrue(old.exists())
            return real_run(args, **kwargs)

        with mock.patch.object(pruner.os, "walk", return_value=[
                (str(self.repo), [".turbo"], []), (str(other), [".turbo"], [])]), \
                mock.patch.object(pruner.subprocess, "run", side_effect=probe):
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
        self.assertTrue(old.exists())
        self.assertFalse(removable.exists())

    def test_budget_never_splits_hash_group(self):
        for index in range(667):
            for suffix in [".tar.zst", "-meta.json", "-manifest.json"]:
                self.cache_file(f"{index:016x}{suffix}")
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1998, 1998 * 12))
        self.assertEqual(sorted(p.name for p in self.cache.iterdir()),
                         sorted(f"{666:016x}{suffix}" for suffix in
                                [".tar.zst", "-meta.json", "-manifest.json"]))

    def test_recent_sidecar_preserves_whole_group(self):
        archive = self.cache_file()
        metadata = self.cache_file("0123456789abcdef-meta.json", age=3600)
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertTrue(archive.exists())
        self.assertTrue(metadata.exists())

    def test_archive_is_removed_before_sidecars(self):
        archive = self.cache_file()
        metadata = self.cache_file("0123456789abcdef-meta.json")
        real_unlink = os.unlink
        order = []

        def unlink(name, **kwargs):
            order.append(name)
            return real_unlink(name, **kwargs)

        with mock.patch.object(pruner.os, "unlink", side_effect=unlink):
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (2, 24))
        self.assertEqual(order, [archive.name, metadata.name])


if __name__ == "__main__":
    unittest.main()
