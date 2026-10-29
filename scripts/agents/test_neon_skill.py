import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("neon_skill", Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/install-neon-skill.py")
skill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(skill)


def archive(name="SKILL.md", kind=tarfile.REGTYPE):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as bundle:
        member = tarfile.TarInfo(skill.PREFIX + name)
        member.type = kind
        member.linkname = "/tmp/untrusted"
        member.size = 4 if kind == tarfile.REGTYPE else 0
        bundle.addfile(member, io.BytesIO(b"test") if member.size else None)
    return output.getvalue()


class NeonSkillTests(unittest.TestCase):
    def test_preserves_existing_skill_and_installs_missing_agents(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            existing = home / ".agents/skills/neon-postgres"
            existing.mkdir(parents=True)
            (existing / "SKILL.md").write_text("user version")
            with patch.object(Path, "home", return_value=home), patch.dict(os.environ, {
                "HIVE_WORKSPACE_PROFILE": "software", "CODEX_HOME": str(home / "custom-codex"),
                "CLAUDE_CONFIG_DIR": str(home / "custom-claude")
            }), patch.object(skill.urllib.request, "urlopen", return_value=io.BytesIO(archive())) as download:
                skill.install()
                self.assertEqual((existing / "SKILL.md").read_text(), "user version")
                for directory in ["custom-codex", "custom-claude"]:
                    target = home / directory / "skills/neon-postgres"
                    self.assertTrue(target.is_symlink())
                    self.assertEqual((target / "SKILL.md").read_text(), "test")
                skill.install()
                self.assertEqual(download.call_count, 1)

    def test_preserves_dangling_user_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            existing = home / ".agents/skills/neon-postgres"
            existing.parent.mkdir(parents=True)
            existing.symlink_to(home / "missing-user-skill")
            with patch.object(Path, "home", return_value=home), patch.dict(os.environ, {
                "HIVE_WORKSPACE_PROFILE": "software", "CODEX_HOME": str(home / ".codex"),
                "CLAUDE_CONFIG_DIR": str(home / ".claude")
            }), patch.object(skill.urllib.request, "urlopen", return_value=io.BytesIO(archive())):
                skill.install()
            self.assertEqual(existing.readlink(), home / "missing-user-skill")

    def test_specialists_do_not_download(self):
        with patch.dict(os.environ, {"HIVE_WORKSPACE_PROFILE": "browser"}), patch.object(skill.urllib.request, "urlopen") as download:
            skill.install()
            download.assert_not_called()

    def test_rejects_traversal_links_and_missing_skill(self):
        for name, kind in [("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("README.md", tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    skill.unpack(archive(name, kind), Path(directory))

    def test_download_failure_does_not_create_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.object(Path, "home", return_value=home), patch.dict(os.environ, {"HIVE_WORKSPACE_PROFILE": "software"}), patch.object(skill.urllib.request, "urlopen", side_effect=TimeoutError):
                with self.assertRaises(TimeoutError):
                    skill.install()
            self.assertFalse((home / ".agents/skills/neon-postgres").exists())


if __name__ == "__main__":
    unittest.main()
