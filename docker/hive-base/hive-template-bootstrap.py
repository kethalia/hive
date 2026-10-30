#!/usr/bin/env python3
"""Reconstruct a pinned public bootstrap packet from immutable image assets."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path('/usr/local/libexec/hive-template-runtime')
ASSETS = {
    'host': ('install-codex-host.py', 'codex-host.tar.xz', {'schemaVersion', 'archiveEncoding', 'archiveSha256', 'config'}, 180000),
    'read': ('install-workspace-read.py', 'workspace-read.tar.gz', {'schemaVersion', 'archiveSha256', 'manifestSha256', 'config'}, 65536),
    'voice': ('install-voice.py', 'voice.tar.gz', {'schemaVersion', 'archiveSha256', 'manifestSha256', 'config'}, 131072),
}

def require(value):
    if not value: raise ValueError('bootstrap_rejected')

def image_file(path, limit):
    require(path.parent == ROOT and path.name in {name for installer, archive, _, _ in ASSETS.values() for name in (installer, archive)})
    for parent in (Path('/usr'), Path('/usr/local'), Path('/usr/local/libexec'), ROOT):
        info = parent.lstat()
        require(parent.resolve() == parent and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    require(path.resolve() == path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022 and 0 < info.st_size <= limit)
        with os.fdopen(fd, 'rb', closefd=False) as stream: raw = stream.read(limit + 1)
        require(len(raw) == info.st_size and len(raw) <= limit)
        return raw
    finally: os.close(fd)

def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result

def prepare(kind, raw, read=image_file):
    require(kind in ASSETS and len(raw) <= 32768)
    packet = json.loads(raw, object_pairs_hook=unique)
    installer_name, archive_name, fields, archive_limit = ASSETS[kind]
    require(isinstance(packet, dict) and set(packet) == fields | {'imageInstallerSha256', 'imageArchiveSha256'})
    for key in ('imageInstallerSha256', 'imageArchiveSha256'):
        require(isinstance(packet[key], str) and re.fullmatch(r'[a-f0-9]{64}', packet[key]))
    installer = read(ROOT / installer_name, 65536)
    archive = read(ROOT / archive_name, archive_limit)
    require(hashlib.sha256(installer).hexdigest() == packet.pop('imageInstallerSha256'))
    require(hashlib.sha256(archive).hexdigest() == packet.pop('imageArchiveSha256'))
    packet['archive'] = base64.b64encode(archive).decode('ascii')
    return installer, (json.dumps(packet, separators=(',', ':')).encode() + b'\n')

def main():
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ASSETS)
        raw = sys.stdin.buffer.read(32769)
        source, packet = prepare(sys.argv[1], raw)
        sys.argv = ['hive-template-installer']
        sys.stdin = io.TextIOWrapper(io.BytesIO(packet), encoding='utf-8')
        exec(compile(source, '<pinned-hive-installer>', 'exec'), {'__name__': '__main__'})
    except Exception:
        sys.stderr.write('hive_template_bootstrap_failed\n')
        sys.exit(1)

if __name__ == '__main__': main()
