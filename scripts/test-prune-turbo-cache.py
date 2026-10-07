import errno
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

    def test_budget_preserves_sidecars_and_untouched_entries(self):
        for index in range(3):
            for suffix in [".tar.zst", "-meta.json", "-manifest.json"]:
                self.cache_file(f"{index:016x}{suffix}")
        self.assertEqual(pruner.prune(self.projects, now=1000000, maximum=2, apply=True), (2, 24))
        self.assertEqual(len(list(self.cache.glob("*.json"))), 6)
        self.assertEqual(len(list(self.cache.glob("*.tar.zst"))), 1)

    def test_recent_sidecar_preserves_whole_group(self):
        archive = self.cache_file()
        metadata = self.cache_file("0123456789abcdef-meta.json", age=3600)
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertTrue(archive.exists())
        self.assertTrue(metadata.exists())

    def test_open_reader_keeps_metadata_across_passes(self):
        archive = self.cache_file()
        metadata = self.cache_file("0123456789abcdef-meta.json")
        with archive.open() as reader:
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
            self.assertEqual(reader.read(), "reproducible")
            self.assertEqual(metadata.read_text(), "reproducible")
            self.assertFalse(archive.exists())
            self.assertEqual(pruner.prune(self.projects, now=1000000 + 86400, apply=True), (0, 0))
            self.assertTrue(metadata.exists())
        self.assertEqual(pruner.prune(self.projects, now=1000000 + 8 * 86400, apply=True), (0, 0))
        self.assertTrue(metadata.exists())

    def test_unlink_errors_preserve_group_and_continue_to_next_repository(self):
        archive = self.cache_file()
        metadata = self.cache_file("0123456789abcdef-meta.json")
        other = self.projects / "other"
        cache = other / ".turbo/cache"
        cache.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(other)], check=True)
        removable = cache / "abcdef0123456789.tar.zst"
        real_unlink = os.unlink
        for code in [errno.EACCES, errno.EPERM, errno.EROFS]:
            with self.subTest(errno=code):
                os.utime(metadata, (1, 1))
                removable.write_text("reproducible")
                os.utime(removable, (1, 1))

                def unlink(name, **kwargs):
                    if name == archive.name:
                        raise OSError(code, "Protected cache entry")
                    return real_unlink(name, **kwargs)

                with mock.patch.object(pruner.os, "walk", return_value=[
                        (str(self.repo), [".turbo"], []), (str(other), [".turbo"], [])]), \
                        mock.patch.object(pruner.os, "unlink", side_effect=unlink):
                    self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
                self.assertTrue(archive.exists())
                self.assertTrue(metadata.exists())
                self.assertFalse(removable.exists())

    def test_orphan_sidecars_are_never_modified(self):
        metadata = self.cache_file("0123456789abcdef-meta.json")
        manifest = self.cache_file("0123456789abcdef-manifest.json")
        before = [path.stat().st_mtime_ns for path in [metadata, manifest]]
        with mock.patch.object(pruner.os, "unlink") as unlink, \
                mock.patch.object(pruner.os, "utime") as utime:
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        unlink.assert_not_called()
        utime.assert_not_called()
        self.assertEqual(before, [path.stat().st_mtime_ns for path in [metadata, manifest]])

    def test_generated_looking_top_level_repository_names(self):
        for name in ["build", "target", "dist", "Library"]:
            with self.subTest(name=name):
                repo = self.projects / name
                cache = repo / ".turbo/cache"
                cache.mkdir(parents=True)
                subprocess.run(["git", "init", "-q", str(repo)], check=True)
                archive = cache / "0123456789abcdef.tar.zst"
                archive.write_text("reproducible")
                os.utime(archive, (1, 1))
                self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
                self.assertFalse(archive.exists())

    def test_outer_timeout_preserves_inner_budgets(self):
        import re
        template = (ROOT / "templates/ai-dev-k8s/main.tf").read_text()
        maintenance = template.split('resource "coder_script" "workspace_cache_maintenance"')[1]
        outer = int(re.search(r"timeout\s*=\s*(\d+)", maintenance).group(1))
        shell = (ROOT / "templates/ai-dev-k8s/scripts/workspace-cache-maintenance.sh").read_text()
        npm = int(re.search(r"timeout[^\n]*? (\d+)s nice", shell).group(1))
        import inspect
        pruning = inspect.signature(pruner.prune).parameters["time_budget"].default
        self.assertGreaterEqual(outer, pruning + npm + 60)

    def test_generated_directories_are_not_searched(self):
        old = self.cache_file()
        preserved = []
        for name in ["Library", ".venv", "venv", "target", "build", "dist"]:
            cache = self.repo / name / "nested/.turbo/cache"
            cache.mkdir(parents=True)
            path = cache / old.name
            path.write_bytes(old.read_bytes())
            os.utime(path, (1, 1))
            preserved.append(path)
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
        self.assertTrue(all(path.exists() for path in preserved))

    def test_directory_budget_stops_discovery(self):
        old = self.cache_file()
        visited = []

        def walk(*args, **kwargs):
            for index in range(10):
                visited.append(index)
                yield str(self.repo), [], []
            self.fail("Discovery exhausted its budget without stopping")

        with mock.patch.object(pruner.os, "walk", side_effect=walk):
            self.assertEqual(pruner.prune(self.projects, now=1000000,
                                         max_directories=2, apply=True), (0, 0))
        self.assertEqual(visited, [0, 1, 2])
        self.assertTrue(old.exists())

    def test_elapsed_budget_returns_without_probing_git(self):
        old = self.cache_file()
        with mock.patch.object(pruner.time, "monotonic", side_effect=[0, 121]), \
                mock.patch.object(pruner.subprocess, "run") as probe:
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        probe.assert_not_called()
        self.assertTrue(old.exists())

    def test_git_probe_timeout_uses_remaining_budget(self):
        old = self.cache_file()
        with mock.patch.object(pruner.time, "monotonic", return_value=0) as clock, \
                mock.patch.object(pruner.subprocess, "run",
                                  side_effect=subprocess.TimeoutExpired("git", 1)) as probe:
            clock.side_effect = [0, 0, 0, 119]
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertEqual(probe.call_args.kwargs["timeout"], 1)
        self.assertTrue(old.exists())

    def test_cache_enumeration_stops_at_entry_limit(self):
        consumed = []

        def entries():
            for index in range(100):
                consumed.append(index)
                yield type("Entry", (), {"name": f"unrelated-{index}"})()
            self.fail("Cache enumeration was not bounded")

        stream = mock.MagicMock()
        stream.__enter__.return_value = entries()
        with mock.patch.object(pruner.os, "walk", return_value=[
                (str(self.repo), [".turbo"], [])]), \
                mock.patch.object(pruner.os, "scandir", return_value=stream), \
                mock.patch.object(pruner.os, "listdir", side_effect=AssertionError("eager listing")):
            self.assertEqual(pruner.prune(self.projects, now=1000000,
                                         max_cache_entries=3, apply=True), (0, 0))
        self.assertEqual(consumed, [0, 1, 2])
        stream.__exit__.assert_called_once()

    def test_cache_enumeration_checks_deadline_between_entries(self):
        clock = [0]
        consumed = []

        def entries():
            consumed.append(1)
            clock[0] = 121
            yield type("Entry", (), {"name": "unrelated"})()
            self.fail("Enumeration continued beyond the deadline")

        stream = mock.MagicMock()
        stream.__enter__.return_value = entries()
        with mock.patch.object(pruner.os, "walk", return_value=[
                (str(self.repo), [".turbo"], [])]), \
                mock.patch.object(pruner.os, "scandir", return_value=stream), \
                mock.patch.object(pruner.time, "monotonic", side_effect=lambda: clock[0]):
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertEqual(consumed, [1])
        stream.__exit__.assert_called_once()


if __name__ == "__main__":
    unittest.main()
