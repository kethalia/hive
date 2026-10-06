import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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
        recent = self.cache_file("0123456789abcdef-meta.json", age=3600)
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


if __name__ == "__main__":
    unittest.main()
