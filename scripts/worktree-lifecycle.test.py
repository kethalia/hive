"""Exercise lifecycle cleanup against disposable real Git repositories."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "templates/ai-dev-k8s/scripts/worktree-lifecycle.py"
spec = importlib.util.spec_from_file_location("worktree_lifecycle", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hive-lifecycle-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.repo = self.home / "projects/owner/repo"
        self.repo.mkdir(parents=True)
        self.git(self.repo, "init", "-b", "main")
        self.git(self.repo, "config", "user.name", "Test")
        self.git(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "source.txt").write_text("original\n")
        (self.repo / ".gitignore").write_text("node_modules/\n.next/\n.local-only\n")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "test: initial fixture")
        self.manager = module.Worktrees(self.home)

    def git(self, repo, *args):
        result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                                env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"}, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def create(self):
        result = self.manager.create(self.repo, "task", "fix/task", "HEAD")
        return Path(result["path"])

    def mark(self, path):
        record = self.manager.load(path)
        record.update(status="completed", completed_head=self.git(path, "rev-parse", "HEAD"),
                      completed_at=1)
        self.manager.save(record)

    def test_create_reuses_task_without_copying_dependencies(self):
        path = self.create()
        self.assertEqual(path, self.repo.parent / ".worktrees/repo/task")
        self.assertEqual(self.git(self.repo, "branch", "--show-current"), "main")
        self.assertFalse((path / "node_modules").exists())
        again = self.manager.create(self.repo, "task", "fix/task", "HEAD")
        self.assertEqual(again["path"], str(path))
        self.assertEqual(len(list(self.manager.state.glob("*.json"))), 1)

    def test_finish_removes_generated_outputs_and_retains_commits(self):
        path = self.create()
        (path / "source.txt").write_text("finished\n")
        self.git(path, "commit", "-am", "fix: finished task")
        head = self.git(path, "rev-parse", "HEAD")
        (path / "node_modules").mkdir()
        (path / "node_modules/package.js").write_text("generated")
        result = self.manager.complete(path)
        self.assertEqual(result["status"], "removed")
        self.assertFalse(path.exists())
        self.assertTrue(self.repo.exists())
        self.assertEqual(self.git(self.repo, "rev-parse", "fix/task"), head)

    def test_dirty_untracked_and_unknown_ignored_files_are_preserved(self):
        for name in ["source.txt", "new-source.txt", ".local-only"]:
            with self.subTest(name=name):
                path = self.create()
                file = path / name
                file.write_text("must retain\n")
                with self.assertRaises(ValueError):
                    self.manager.complete(path)
                self.assertEqual(file.read_text(), "must retain\n")
                self.assertEqual(self.manager.load(path)["status"], "active")
                if name == "source.txt":
                    self.git(path, "restore", "source.txt")
                else:
                    file.unlink()

    def test_prune_does_not_discover_or_delete_unmanaged_or_active_tasks(self):
        path = self.create()
        unmanaged = self.repo.parent / "repo-unmanaged"
        self.git(self.repo, "worktree", "add", "-b", "fix/unmanaged", str(unmanaged))
        self.assertEqual(self.manager.prune(), [])
        self.assertTrue(path.exists())
        self.assertTrue(unmanaged.exists())

    def test_changed_completed_head_is_preserved(self):
        path = self.create()
        self.mark(path)
        (path / "source.txt").write_text("continued work\n")
        self.git(path, "commit", "-am", "fix: resumed task")
        result = self.manager.prune()
        self.assertEqual(result[0]["status"], "skipped")
        self.assertTrue(path.exists())

    def test_changed_completed_branch_and_nested_repositories_are_preserved(self):
        path = self.create()
        self.mark(path)
        self.git(path, "switch", "-c", "fix/resumed")
        self.assertEqual(self.manager.prune()[0]["status"], "skipped")
        self.git(path, "switch", "fix/task")
        nested = path / "node_modules/nested"
        nested.mkdir(parents=True)
        self.git(nested, "init")
        self.assertEqual(self.manager.prune()[0]["status"], "skipped")
        self.assertTrue((nested / ".git").exists())

    def test_active_process_defers_and_later_prune_retires_task(self):
        path = self.create()
        process = subprocess.Popen(
            ["python3", "-c", "import sys; f=open(sys.argv[1]); print('ready',flush=True); sys.stdin.read()",
             str(path / "source.txt")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready")
            self.assertEqual(self.manager.complete(path)["status"], "deferred")
            self.assertTrue(path.exists())
        finally:
            process.communicate("", timeout=5)
        self.assertEqual(self.manager.prune()[0]["status"], "removed")

    def test_primary_paths_and_symlinked_state_cannot_be_deleted(self):
        with self.assertRaises(ValueError):
            self.manager.adopt(self.repo, self.repo)
        link = self.repo.parent / "alias"
        link.symlink_to(self.repo)
        with self.assertRaises(ValueError):
            self.manager.adopt(self.repo, link)
        target = self.home / "outside-state"
        target.mkdir()
        state = self.home / ".local/state/hive/worktrees"
        state.parent.mkdir(parents=True)
        state.symlink_to(target)
        with self.assertRaises(ValueError):
            module.Worktrees(self.home)

    def test_locked_task_is_preserved(self):
        path = self.create()
        self.git(self.repo, "worktree", "lock", str(path))
        self.mark(path)
        self.assertEqual(self.manager.prune()[0]["status"], "skipped")
        self.assertTrue(path.exists())

    def test_detached_unique_commit_keeps_a_recovery_branch(self):
        path = self.repo.parent / "repo-validation"
        self.git(self.repo, "worktree", "add", "--detach", str(path), "HEAD")
        (path / "source.txt").write_text("validation commit\n")
        self.git(path, "commit", "-am", "test: validation fixture")
        head = self.git(path, "rev-parse", "HEAD")
        self.manager.adopt(self.repo, path)
        result = self.manager.complete(path)
        self.assertEqual(result["status"], "removed")
        self.assertEqual(self.git(self.repo, "rev-parse", result["branch_retained"]), head)

    def test_forged_record_cannot_remove_another_checkout(self):
        path = self.create()
        self.mark(path)
        record = self.manager.load(path)
        record["path"] = str(self.home / "unrelated")
        self.manager.record_path(path).write_text(json.dumps(record))
        self.assertEqual(self.manager.prune()[0]["status"], "skipped")
        self.assertTrue(path.exists())

    def test_lifecycle_commands_are_serialized(self):
        with self.manager.lock():
            with self.assertRaises(BlockingIOError):
                with self.manager.lock():
                    self.fail("Second writer acquired lock")


class ManifestTests(unittest.TestCase):
    def test_manifest_is_seeded_once_and_never_overwrites_local_choices_or_symlinks(self):
        content = (ROOT / "templates/ai-dev-k8s/scripts/tools-ci.sh").read_text()
        block = content[content.index("# Seed once:"):content.index("worktree_helper=")]
        defaults = "example/one|example/one\nexample/two|example/two\n"
        import base64
        block = block.replace("${repositories_manifest_b64}", base64.b64encode(defaults.encode()).decode())
        with tempfile.TemporaryDirectory(prefix="hive-manifest-") as temporary:
            home = Path(temporary)
            script = "set -eu\n" + block.replace("$HOME", str(home))

            def run():
                result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)

            manifest = home / "repositories.txt"
            run()
            self.assertEqual(manifest.read_text(), defaults)
            for choice in ["example/one|example/one\n", ""]:
                manifest.write_text(choice)
                run()
                self.assertEqual(manifest.read_text(), choice)
            manifest.unlink()
            target = home / "user-manifest"
            target.write_text("user choices\n")
            manifest.symlink_to(target)
            run()
            self.assertEqual(target.read_text(), "user choices\n")
            self.assertTrue(manifest.is_symlink())
            self.assertEqual(list(home.glob(".hive-repositories.*")), [])


if __name__ == "__main__":
    unittest.main()
