import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('updates', Path(__file__).resolve().parents[2] / 'templates/ai-dev-k8s/scripts/update-official-agents.py')
updates = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updates)


class OfficialUpdatesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.state = self.home / '.local/state/hive/agent-updates'
        self.managed = self.home / '.local/share/hive/official-skills/updates'
        self.state.mkdir(parents=True)
        self.managed.mkdir(parents=True)
        self.source = self.home / 'new'
        self.source.mkdir()
        (self.source / 'SKILL.md').write_text('new official skill')
        self.baseline = self.home / '.local/share/hive/official-skills/seed'
        self.baseline.mkdir()
        (self.baseline / 'SKILL.md').write_text('old official skill')
        self.destination = self.home / '.agents/skills/example'
        self.destination.parent.mkdir(parents=True)
        self.env = patch.dict(os.environ, {'CODEX_HOME': str(self.home / '.codex'), 'CLAUDE_CONFIG_DIR': str(self.home / '.claude')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.receipts = {}

    def update(self):
        return updates.update_skill(self.home, self.state, self.managed, self.source, 'example', 'a' * 40, self.baseline, self.receipts)

    def test_adopts_seed_preserves_previous_and_links_agents(self):
        self.destination.mkdir()
        (self.destination / 'SKILL.md').write_text('old official skill')
        self.assertEqual(self.update(), 'updated')
        self.assertEqual((self.destination / 'SKILL.md').read_text(), 'new official skill')
        self.assertEqual(len(list(self.state.glob('example-previous-*'))), 1)
        self.assertTrue((self.home / '.codex/skills/example').is_symlink())
        self.assertIn(str(self.destination), json.loads((self.state / 'skills.json').read_text()))

    def test_user_edits_are_not_replaced(self):
        self.update()
        (self.destination / 'SKILL.md').write_text('user modified')
        self.assertEqual(self.update(), 'preserved-user-edits')
        self.assertEqual((self.destination / 'SKILL.md').read_text(), 'user modified')

    def test_unmanaged_directory_and_external_link_preserved(self):
        self.destination.mkdir()
        (self.destination / 'SKILL.md').write_text('user skill')
        self.assertEqual(self.update(), 'preserved-unmanaged')
        (self.destination / 'SKILL.md').unlink()
        self.destination.rmdir()
        external = self.home / 'external'
        external.mkdir()
        (external / 'SKILL.md').write_text('old official skill')
        self.destination.symlink_to(external)
        self.assertEqual(self.update(), 'preserved-external-link')

    def test_failed_switch_restores_original_directory(self):
        self.destination.mkdir()
        (self.destination / 'SKILL.md').write_text('old official skill')
        with patch.object(Path, 'replace', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):
                self.update()
        self.assertFalse(self.destination.is_symlink())
        self.assertEqual((self.destination / 'SKILL.md').read_text(), 'old official skill')

    def test_seed_symlink_user_edits_cannot_self_authenticate(self):
        trusted = updates.digest(self.baseline)
        self.destination.symlink_to(self.baseline)
        (self.baseline / 'SKILL.md').write_text('user edit through seed link')
        result = updates.update_skill(self.home, self.state, self.managed, self.source,
                                      'example', 'a' * 40, self.baseline, {}, trusted)
        self.assertEqual(result, 'preserved-unmanaged')
        self.assertEqual((self.destination / 'SKILL.md').read_text(), 'user edit through seed link')

    def test_codex_staging_failure_keeps_original_link(self):
        original = self.home / '.local/lib/node_modules/@openai/codex/bin/codex.js'
        original.parent.mkdir(parents=True)
        original.write_text('previous binary')
        link = self.home / '.local/bin/codex'
        link.parent.mkdir(parents=True)
        link.symlink_to(original)
        with patch.object(updates, 'bounded', return_value=1), patch.object(updates, 'fetch', return_value=b'{"version":"1.2.3"}'):
            self.assertEqual(updates.update_tool('codex', self.home, self.state, {}), 'update-failed-preserved')
        self.assertEqual(link.resolve(), original)
        self.assertEqual(original.read_text(), 'previous binary')

    def test_current_codex_does_not_stage_again(self):
        original = self.home / '.local/lib/node_modules/@openai/codex/bin/codex.js'
        original.parent.mkdir(parents=True)
        original.write_text('binary')
        (original.parent.parent / 'package.json').write_text('{"version":"1.2.3"}')
        link = self.home / '.local/bin/codex'
        link.parent.mkdir(parents=True)
        link.symlink_to(original)
        with patch.object(updates, 'fetch', return_value=b'{"version":"1.2.3"}'), patch.object(updates, 'bounded') as run:
            self.assertEqual(updates.update_tool('codex', self.home, self.state, {}), 'current')
            run.assert_not_called()
        self.assertFalse((self.state / 'tools').exists())

    def test_archive_rejects_traversal_links_and_missing_skill(self):
        for name, kind in [('root/skills/../../escape', tarfile.REGTYPE), ('root/skills/SKILL.md', tarfile.SYMTYPE), ('unrelated/file', tarfile.REGTYPE)]:
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz') as archive:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = 0
                archive.addfile(member, io.BytesIO())
            with tempfile.TemporaryDirectory() as target:
                with self.assertRaises(ValueError):
                    updates.unpack(data.getvalue(), 'root/skills/', Path(target))


if __name__ == '__main__':
    unittest.main()

class PinnedCoordinatorTests(unittest.TestCase):
    def test_only_exact_kernel_inode_path_hash_and_private_pin_is_exempt(self):
        import hashlib
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as root:
            home=Path(root)
            binary=home/updates.COORDINATOR_RELATIVE
            binary.parent.mkdir(parents=True)
            (home/'.local/share/hive/codex-runtime').chmod(0o700)
            binary.write_bytes(b'fixture-native')
            binary.chmod(0o500)
            process=home/'process';process.mkdir()
            (process/'exe').symlink_to(binary)
            with patch.object(updates.pwd,'getpwuid',return_value=SimpleNamespace(pw_dir=str(home))), patch.object(updates,'COORDINATOR_SHA256',hashlib.sha256(b'fixture-native').hexdigest()):
                self.assertTrue(updates.pinned_coordinator(process,{}))
                binary.chmod(0o700);binary.write_bytes(b'changed');binary.chmod(0o500)
                self.assertFalse(updates.pinned_coordinator(process,{}))
                binary.chmod(0o700);binary.write_bytes(b'fixture-native');binary.chmod(0o522)
                self.assertFalse(updates.pinned_coordinator(process,{}))
                binary.chmod(0o500)
                (process/'exe').unlink();(process/'exe').symlink_to(str(binary)+' (deleted)')
                self.assertFalse(updates.pinned_coordinator(process,{}))

    def test_interactive_and_unreadable_executables_remain_blocking(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)
            self.assertFalse(updates.pinned_coordinator(p,{}))
            (p/'exe').symlink_to('/usr/bin/python3')
            self.assertFalse(updates.pinned_coordinator(p,{}))
