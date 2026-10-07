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

        with mock.patch.object(pruner, "discovery", return_value=[
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

                with mock.patch.object(pruner, "discovery", return_value=[
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

        with mock.patch.object(pruner, "discovery", side_effect=walk):
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
        with mock.patch.object(pruner, "discovery", return_value=[
                (str(self.repo), [".turbo"], [])]), \
                mock.patch.object(pruner.time, "monotonic", return_value=0) as clock, \
                mock.patch.object(pruner.subprocess, "run",
                                  side_effect=subprocess.TimeoutExpired("git", 1)) as probe:
            clock.side_effect = [0, 0, 119]
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertEqual(probe.call_args.kwargs["timeout"], 1)
        self.assertTrue(old.exists())

    def test_cache_enumeration_stops_at_entry_limit(self):
        consumed = []

        def entries():
            for index in range(100):
                consumed.append(index)
                yield type("Entry", (), {"name": f"unrelated-{index}", "cookie": index + 1})()
            self.fail("Cache enumeration was not bounded")

        stream = mock.MagicMock()
        stream.__enter__.return_value = entries()
        with mock.patch.object(pruner, "discovery", return_value=[
                (str(self.repo), [".turbo"], [])]), \
                mock.patch.object(pruner, "cache_entries", return_value=stream), \
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
            yield type("Entry", (), {"name": "unrelated", "cookie": 1})()
            self.fail("Enumeration continued beyond the deadline")

        stream = mock.MagicMock()
        stream.__enter__.return_value = entries()
        with mock.patch.object(pruner, "discovery", return_value=[
                (str(self.repo), [".turbo"], [])]), \
                mock.patch.object(pruner, "cache_entries", return_value=stream), \
                mock.patch.object(pruner.time, "monotonic", side_effect=lambda: clock[0]):
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertEqual(consumed, [1])
        stream.__exit__.assert_called_once()

    def test_discovery_resumes_past_large_early_tree(self):
        for index in range(8):
            (self.repo / f"source-{index}" / "nested").mkdir(parents=True)
        later = self.repo / "source-7/nested/.turbo/cache"
        later.mkdir(parents=True)
        archive = later / "0123456789abcdef.tar.zst"
        archive.write_text("reproducible")
        os.utime(archive, (1, 1))
        state = {}
        for _ in range(20):
            pruner.prune(self.projects, now=1000000, max_directories=2, apply=True, state=state)
            # Model separate invocations, including JSON checkpoint round-trip.
            import json
            state = json.loads(json.dumps(state))
            if not archive.exists():
                break
        self.assertFalse(archive.exists())

    def test_cache_cursor_passes_preserved_prefix(self):
        archive = self.cache_file()
        names = ["unrelated-0", "unrelated-1", "unrelated-2", archive.name]
        state = {}

        def stream(fd, cookie=0):
            result = mock.MagicMock()
            result.__enter__.return_value = iter([
                type("Entry", (), {"name": name, "cookie": index + 1})()
                for index, name in enumerate(names) if index >= cookie])
            return result

        for _ in range(3):
            with mock.patch.object(pruner, "discovery", return_value=[
                    (str(self.repo), [".turbo"], [])]), \
                    mock.patch.object(pruner, "cache_entries", side_effect=stream):
                pruner.prune(self.projects, now=1000000, max_cache_entries=2,
                             apply=True, state=state)
            import json
            state = json.loads(json.dumps(state))
        self.assertFalse(archive.exists())
        self.assertEqual(state["cursors"], {})

    def test_scheduled_run_persists_progress(self):
        state_path = Path(self.tmp.name) / "state/checkpoint.json"
        def run(projects, **kwargs):
            kwargs["state"]["pending"] = ["repo/next"]
            kwargs["state"]["cursors"] = {"repo/.turbo/cache": {"device": 1, "inode": 2, "cookie": 42}}
            return 0, 0
        with mock.patch.object(pruner, "prune", side_effect=run):
            pruner.scheduled_prune(self.projects, state_path)
        with mock.patch.object(pruner, "prune", return_value=(0, 0)) as run:
            pruner.scheduled_prune(self.projects, state_path)
            self.assertEqual(run.call_args.kwargs["state"], {
                "pending": ["repo/next"], "cursors": {"repo/.turbo/cache": {"device": 1, "inode": 2, "cookie": 42}}})

    def test_real_cookie_resumes_after_reopening_directory(self):
        for index in range(20):
            self.cache_file(f"{index:016x}.tar.zst")
        fd = os.open(self.cache, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with pruner.cache_entries(fd) as entries:
                prefix = [next(entries) for _ in range(5)]
                expected = [entry.name for entry in entries]
        finally:
            os.close(fd)
        fd = os.open(self.cache, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with pruner.cache_entries(fd, prefix[-1].cookie) as entries:
                self.assertEqual([entry.name for entry in entries], expected)
        finally:
            os.close(fd)

    def test_large_cookie_is_sought_without_replay(self):
        archive = self.cache_file()
        identity = self.cache.stat()
        cookie = 2**50
        state = {"cursors": {"repo/.turbo/cache": {
            "device": identity.st_dev, "inode": identity.st_ino, "cookie": cookie}}}
        stream = mock.MagicMock()
        stream.__enter__.return_value = iter([
            type("Entry", (), {"name": archive.name, "cookie": cookie + 100})()])
        with mock.patch.object(pruner, "discovery", return_value=[
                (str(self.repo), [".turbo"], [])]), \
                mock.patch.object(pruner, "cache_entries", return_value=stream) as scan:
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True,
                                         state=state, max_cache_entries=1), (1, 12))
        self.assertEqual(scan.call_args.args[1], cookie)
        self.assertFalse(archive.exists())

    def test_replaced_directory_resets_cookie(self):
        identity = self.cache.stat()
        state = {"cursors": {"repo/.turbo/cache": {
            "device": identity.st_dev, "inode": identity.st_ino + 1, "cookie": 123}}}
        stream = mock.MagicMock()
        stream.__enter__.return_value = iter([])
        with mock.patch.object(pruner, "discovery", return_value=[
                (str(self.repo), [".turbo"], [])]), \
                mock.patch.object(pruner, "cache_entries", return_value=stream) as scan:
            pruner.prune(self.projects, now=1000000, state=state)
        self.assertEqual(scan.call_args.args[1], 0)
        self.assertEqual(state["cursors"], {})

    def test_wide_discovery_directory_resumes_without_materializing_entries(self):
        consumed = []
        resumes = []
        state = {}

        def stream(fd, cookie=0):
            resumes.append(cookie)
            def entries():
                for index in range(cookie, 1000000):
                    consumed.append(index)
                    yield type("Entry", (), {"name": f"file-{index}", "cookie": index + 1})()
            result = mock.MagicMock()
            result.__enter__.return_value = entries()
            return result

        with mock.patch.object(pruner, "cache_entries", side_effect=stream), \
                mock.patch.object(pruner.os, "walk", side_effect=AssertionError("eager walk")):
            for _ in range(2):
                self.assertEqual(list(pruner.discovery(
                    self.projects, state, float("inf"), max_entries=3)), [])
        self.assertEqual(consumed, list(range(6)))
        self.assertEqual(resumes, [0, 3])
        self.assertEqual(state["pending"], ["."])

    def test_discovery_checks_deadline_within_directory(self):
        clock = [0]
        state = {}
        consumed = []
        def entries():
            consumed.append(1)
            clock[0] = 121
            yield type("Entry", (), {"name": "unrelated", "cookie": 88})()
            self.fail("Discovery read past its deadline")
        stream = mock.MagicMock()
        stream.__enter__.return_value = entries()
        with mock.patch.object(pruner, "cache_entries", return_value=stream), \
                mock.patch.object(pruner.time, "monotonic", side_effect=lambda: clock[0]):
            self.assertEqual(list(pruner.discovery(self.projects, state, 120)), [])
        self.assertEqual(consumed, [1])
        self.assertEqual(state["discovery_cursors"]["."]["cookie"], 88)
        stream.__exit__.assert_called_once()

    def test_uncompressed_archives_follow_retention_policy(self):
        old = self.cache_file("0123456789abcdef.tar")
        recent = self.cache_file("abcdef0123456789.tar", age=3600)
        metadata = self.cache_file("0123456789abcdef-meta.json")
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(metadata.exists())

    def test_replacement_between_validation_and_rename_is_restored(self):
        archive = self.cache_file()
        real_rename = os.rename
        def replace_then_rename(src, dst, **kwargs):
            replacement = archive.with_name("replacement")
            replacement.write_text("new producer archive")
            os.replace(replacement, archive)
            return real_rename(src, dst, **kwargs)
        with mock.patch.object(pruner.os, "rename", side_effect=replace_then_rename):
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertEqual(archive.read_text(), "new producer archive")
        self.assertEqual(list(self.cache.glob(".hive-prune-*")), [])

    def test_truncation_between_validation_and_rename_is_restored(self):
        archive = self.cache_file()
        real_rename = os.rename
        def truncate_then_rename(src, dst, **kwargs):
            archive.write_text("changed")
            return real_rename(src, dst, **kwargs)
        with mock.patch.object(pruner.os, "rename", side_effect=truncate_then_rename):
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertEqual(archive.read_text(), "changed")

    def test_publication_after_quarantine_is_preserved(self):
        archive = self.cache_file()
        real_rename = os.rename
        def rename_then_publish(src, dst, **kwargs):
            result = real_rename(src, dst, **kwargs)
            archive.write_text("fresh publication")
            return result
        with mock.patch.object(pruner.os, "rename", side_effect=rename_then_publish):
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
        self.assertEqual(archive.read_text(), "fresh publication")

    def test_restore_does_not_overwrite_new_publication(self):
        archive = self.cache_file()
        real_rename = os.rename
        def race(src, dst, **kwargs):
            archive.write_text("changed before quarantine")
            result = real_rename(src, dst, **kwargs)
            archive.write_text("newer publication")
            return result
        with mock.patch.object(pruner.os, "rename", side_effect=race):
            self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (0, 0))
        self.assertEqual(archive.read_text(), "newer publication")
        preserved = list(self.cache.glob(".hive-prune-*/" + archive.name))
        self.assertEqual(len(preserved), 1)
        self.assertEqual(preserved[0].read_text(), "changed before quarantine")

    def test_generated_looking_repositories_under_owner_directories(self):
        for name in ["build", "target", "dist", "Library", ".venv"]:
            with self.subTest(name=name):
                repo = self.projects / "owner" / name
                cache = repo / ".turbo/cache"
                cache.mkdir(parents=True)
                subprocess.run(["git", "init", "-q", str(repo)], check=True)
                archive = cache / "0123456789abcdef.tar.zst"
                archive.write_text("reproducible")
                os.utime(archive, (1, 1))
                self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
                self.assertFalse(archive.exists())

    def test_generated_looking_repository_with_git_file(self):
        repo = self.projects / "owner/group/target"
        cache = repo / ".turbo/cache"
        cache.mkdir(parents=True)
        git_dir = Path(self.tmp.name) / "separate-git-dir"
        subprocess.run(["git", "init", "-q", "--separate-git-dir", str(git_dir), str(repo)],
                       check=True)
        self.assertTrue((repo / ".git").is_file())
        archive = cache / "0123456789abcdef.tar.zst"
        archive.write_text("reproducible")
        os.utime(archive, (1, 1))
        self.assertEqual(pruner.prune(self.projects, now=1000000, apply=True), (1, 12))
        self.assertFalse(archive.exists())


if __name__ == "__main__":
    unittest.main()
