import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'templates/ai-dev-k8s/scripts/install-codex-runtime.py'
SPEC = importlib.util.spec_from_file_location('runtime_install', SOURCE)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def archive(entries):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w') as output:
        for name, content, kind in entries:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.mode = 0o755
            info.size = len(content) if kind == tarfile.REGTYPE else 0
            info.linkname = '../../outside' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
            output.addfile(info, io.BytesIO(content) if info.isfile() else None)
    data.seek(0)
    return tarfile.open(fileobj=data, mode='r')


class PinnedRuntimeInstallTests(unittest.TestCase):
    def test_extracts_only_vendor_regular_files_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root)
            with archive([('package/' + runtime.BINARY, b'fixture', tarfile.REGTYPE), ('package/package.json', b'{}', tarfile.REGTYPE)]) as source:
                runtime.extract_vendor(source, target)
            self.assertEqual((target / runtime.BINARY).read_bytes(), b'fixture')
            self.assertEqual((target / runtime.BINARY).stat().st_mode & 0o777, 0o500)
            self.assertFalse((target / 'package.json').exists())

    def test_rejects_path_escape_symlink_hardlink_and_duplicate_binary(self):
        good = ('package/' + runtime.BINARY, b'fixture', tarfile.REGTYPE)
        for bad in [('package/vendor/../../outside', b'x', tarfile.REGTYPE), ('/absolute', b'x', tarfile.REGTYPE), ('package/vendor/link', b'', tarfile.SYMTYPE), ('package/vendor/link', b'', tarfile.LNKTYPE), good]:
            with self.subTest(bad=bad[0]), tempfile.TemporaryDirectory() as root:
                with archive([good, bad]) as source, self.assertRaises(ValueError):
                    runtime.extract_vendor(source, Path(root))

    def test_existing_or_modified_binary_is_not_replaced_or_executed(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root)
            binary = target / runtime.BINARY
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'not-the-pinned-runtime')
            with self.assertRaises(ValueError):
                runtime.verify_runtime(target)
            self.assertEqual(binary.read_bytes(), b'not-the-pinned-runtime')


if __name__ == '__main__':
    unittest.main()
