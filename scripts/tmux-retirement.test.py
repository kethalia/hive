import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "retire_tmux", ROOT / "templates/ai-dev-k8s/scripts/retire-tmux-snapshots.py"
)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
LEGACY = (ROOT / "scripts/fixtures/legacy-tmux-module.conf").read_text()


class TmuxRetirement(unittest.TestCase):
    def test_generated_configs_are_archived_and_snapshot_data_survives(self):
        for interval in [1, 5, 30]:
            with self.subTest(interval=interval), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                config = home / ".tmux.conf"
                original = LEGACY.replace("interval '1'", f"interval '{interval}'")
                config.write_text(original)
                snapshots = home / ".tmux/resurrect"
                snapshots.mkdir(parents=True)
                saved = snapshots / "existing.txt"
                saved.write_text("saved user output")
                prior_backup = home / ".tmux.conf.hive-retired-existing"
                prior_backup.write_text("preserve this file")
                backup = migration.retire(home)
                self.assertFalse(config.exists())
                self.assertEqual(backup.read_text(), original)
                self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
                self.assertEqual(saved.read_text(), "saved user output")
                self.assertEqual(prior_backup.read_text(), "preserve this file")
                self.assertIsNone(migration.retire(home))
                self.assertEqual(len(list(home.glob(".tmux.conf.hive-retired-*"))), 2)

    def test_preserves_custom_configuration_even_when_it_uses_the_same_plugins(self):
        for content in ["set -g mouse on\n", LEGACY + "# personal setting\n", ""]:
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                config = home / ".tmux.conf"
                config.write_text(content)
                self.assertIsNone(migration.retire(home))
                self.assertEqual(config.read_text(), content)
                self.assertEqual(list(home.glob(".tmux.conf.hive-retired-*")), [])

    def test_preserves_symlinks_and_hardlinks(self):
        for linked in ["symlink", "hardlink"]:
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                target = home / "shared.conf"
                target.write_text(LEGACY)
                config = home / ".tmux.conf"
                if linked == "symlink":
                    config.symlink_to(target)
                else:
                    os.link(target, config)
                self.assertIsNone(migration.retire(home))
                self.assertTrue(config.exists())
                self.assertEqual(target.read_text(), LEGACY)

    def test_preserves_non_text_configurations(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / ".tmux.conf"
            config.write_bytes(b"\xff\xfe")
            self.assertIsNone(migration.retire(home))
            self.assertEqual(config.read_bytes(), b"\xff\xfe")


if __name__ == "__main__":
    unittest.main()
