import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("project_browser_remote", Path(__file__).with_name("remote.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrivateInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hive-project-browser-input-")
        self.path = Path(self.temp.name) / "input.json"
        self.path.write_text(json.dumps({"synthetic": True}))
        self.path.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def test_owner_regular_private_input_is_bounded(self):
        self.assertEqual(MODULE.private_json(self.path, 100), {"synthetic": True})
        with self.assertRaises(AssertionError):
            MODULE.private_json(self.path, 2)

    def test_symlink_and_hardlink_are_rejected(self):
        linked = self.path.with_name("link")
        linked.symlink_to(self.path)
        with self.assertRaises((OSError, AssertionError)):
            MODULE.private_json(linked, 100)
        linked.unlink()
        os.link(self.path, linked)
        with self.assertRaises(AssertionError):
            MODULE.private_json(self.path, 100)

    def test_parent_symlink_is_not_a_private_input_path(self):
        parent = Path(self.temp.name) / "alias"
        parent.symlink_to(Path(self.temp.name), target_is_directory=True)
        with self.assertRaises(AssertionError):
            MODULE.private_json(parent / self.path.name, 100)

    def test_fifo_and_world_readable_input_are_rejected_without_blocking(self):
        fifo = self.path.with_name("fifo")
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(AssertionError):
            MODULE.private_json(fifo, 100)
        self.path.chmod(0o644)
        with self.assertRaises(AssertionError):
            MODULE.private_json(self.path, 100)


if __name__ == "__main__":
    unittest.main()
