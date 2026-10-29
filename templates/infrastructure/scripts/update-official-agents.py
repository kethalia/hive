#!/usr/bin/env python3
"""Bounded, allowlisted agent maintenance; never changes credentials or plugin choices."""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import uuid
import subprocess
import tarfile
import tempfile
import time
import urllib.request

LIMIT = 32 * 1024 * 1024
# Repository/path/name mappings are reviewed template code, never remote configuration.
SOURCES = [
    ('openai/skills', 'main', 'openai-49f948faa9258a0c61caceaf225e179651397431', [
        ('skills/.curated/cloudflare-deploy', 'cloudflare-deploy'),
        ('skills/.curated/security-best-practices', 'security-best-practices'),
        ('skills/.curated/security-threat-model', 'security-threat-model')]),
    ('vercel-labs/agent-skills', 'main', 'vercel-7c180d9044c9ae2b442b567aad4e42a28dd5ed62', [
        ('skills/react-best-practices', 'vercel-react-best-practices'),
        ('skills/composition-patterns', 'vercel-composition-patterns'),
        ('skills/web-design-guidelines', 'web-design-guidelines')]),
    ('neondatabase/agent-skills', 'main', 'neon-9df568a3f88a361ea33db00453ff754d07b3b3e1', [
        ('skills/neon-postgres', 'neon-postgres')]),
]


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Hive-official-agent-maintenance'})
    with urllib.request.urlopen(request, timeout=20) as response:
        value = response.read(LIMIT + 1)
    if len(value) > LIMIT:
        raise ValueError('download too large')
    return value


def digest(root):
    result = hashlib.sha256()
    if not root.is_dir():
        raise ValueError('missing skill')
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('nested symlink')
        if path.is_file() and path.name != '.hive-source':
            result.update(str(path.relative_to(root)).encode() + b'\0')
            result.update(path.read_bytes())
    return result.hexdigest()


def unpack(data, prefix, destination):
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if not member.name.startswith(prefix):
                continue
            relative = PurePosixPath(member.name[len(prefix):])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('unsafe archive path')
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError('archive links forbidden')
            total += member.size
            if total > LIMIT:
                raise ValueError('expanded archive too large')
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o600)
    if not (destination / 'SKILL.md').is_file():
        raise ValueError('missing SKILL.md')


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def update_skill(home, state, managed, source, name, revision, baseline, receipts, trusted_digest=None):
    destination = home / '.agents/skills' / name
    key = str(destination)
    existing = os.path.lexists(destination)
    previous = receipts.get(key)
    if existing:
        current = digest(destination)
        # Only explicitly recorded content or byte-equivalent template seed is managed.
        if previous:
            if current != previous['digest']:
                return 'preserved-user-edits'
        elif not baseline.is_dir() or current != (trusted_digest or digest(baseline)):
            return 'preserved-unmanaged'
    target = managed / f'{name}-{revision}'
    if not os.path.lexists(target):
        shutil.copytree(source, target)
    elif target.is_symlink() or digest(target) != digest(source):
        raise ValueError('managed revision differs')
    if existing and destination.is_symlink():
        resolved = destination.resolve()
        allowed = [managed.resolve(), (home / '.local/share/hive/official-skills').resolve()]
        if not any(resolved.is_relative_to(root) for root in allowed):
            return 'preserved-external-link'
    destination.parent.mkdir(parents=True, exist_ok=True)
    next_link = destination.with_name('.' + name + '.hive-' + uuid.uuid4().hex)
    next_link.symlink_to(target, target_is_directory=True)
    backup = None
    if os.path.lexists(destination) != existing or (existing and digest(destination) != current):
        next_link.unlink()
        return 'preserved-concurrent-change'
    if existing and not destination.is_symlink():
        backup = state / f'{name}-previous-{time.time_ns()}'
        destination.rename(backup)
    try:
        next_link.replace(destination)
    except Exception:
        if backup is not None:
            backup.rename(destination)
        raise
    # Retain the prior tree for recovery; never delete user-owned destinations.
    receipts[key] = {'digest': digest(source), 'revision': revision}
    atomic_json(state / 'skills.json', receipts)
    roots = [Path(os.environ.get('CODEX_HOME', str(home / '.codex'))),
             Path(os.environ.get('CLAUDE_CONFIG_DIR', str(home / '.claude')))]
    for root in roots:
        link = root / 'skills' / name
        if not os.path.lexists(link):
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(destination, target_is_directory=True)
        elif link.is_symlink() and link.resolve() != destination.resolve():
            # Neon template seed links directly to the immutable vendor tree.
            if link.resolve() == baseline.resolve() and digest(link) == (trusted_digest or digest(baseline)):
                temporary = link.with_name('.' + name + '.hive-' + uuid.uuid4().hex)
                temporary.symlink_to(destination, target_is_directory=True)
                temporary.replace(link)
    return 'updated'


def agents_running():
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            args = (process / 'cmdline').read_bytes().split(b'\0')
            # Includes native clients and app-server; don't replace active installations.
            if args and (Path(os.fsdecode(args[0])).name in ('codex', 'claude') or
                         any(b'@openai/codex/' in arg for arg in args[:2])):
                return True
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return False


def bounded(command, environment, timeout=150):
    process = subprocess.Popen(command, env=environment, start_new_session=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise


def switch_link(link, target):
    temporary = link.with_name('.' + link.name + '.hive-' + uuid.uuid4().hex)
    temporary.symlink_to(target)
    temporary.replace(link)


def update_tool(name, home, state, environment):
    link = home / '.local/bin' / name
    # Only conventional vendor-managed symlinks are eligible, never user wrappers.
    if not link.is_symlink():
        return 'preserved-unmanaged-tool'
    original = os.readlink(link)
    previous = link.resolve()
    if name == 'codex':
        allowed = [home / '.local/lib/node_modules/@openai/codex', state / 'tools']
        if not any(previous.is_relative_to(root) for root in allowed):
            return 'preserved-unmanaged-tool'
        version = json.loads(fetch('https://registry.npmjs.org/@openai%2fcodex/latest'))['version']
        if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?', version):
            raise ValueError('invalid npm version')
        package = previous.parent.parent / 'package.json'
        if package.is_file() and json.loads(package.read_text()).get('version') == version:
            return 'current'
        tools = state / 'tools'
        tools.mkdir(exist_ok=True)
        stage = tools / ('codex-' + uuid.uuid4().hex)
        stage.mkdir()
        command = ['npm', 'install', '-g', '--prefix', str(stage), '@openai/codex@' + version,
                   '--fetch-retries=1', '--fetch-timeout=20000']
        try:
            failed = bounded(command, environment) or bounded([str(stage / 'bin/codex'), '--version'], environment, 10)
        except Exception:
            shutil.rmtree(stage)
            raise
        if failed:
            shutil.rmtree(stage)
            return 'update-failed-preserved'
        if not link.is_symlink() or os.readlink(link) != original:
            return 'preserved-concurrent-change'
        switch_link(link, stage / 'bin/codex')
    else:
        if not previous.is_relative_to(home / '.local/share/claude/versions'):
            return 'preserved-unmanaged-tool'
        try:
            code = bounded([str(link), 'install', 'latest'], environment)
            healthy = bounded([str(link), '--version'], environment, 10) == 0
        except Exception:
            if previous.is_file():
                switch_link(link, original)
            raise
        if code or not healthy:
            if previous.is_file():
                switch_link(link, original)
            return 'update-failed-preserved'
    return 'updated'


def main():
    os.umask(0o077)
    home = Path.home()
    state = home / '.local/state/hive/agent-updates'
    managed = home / '.local/share/hive/official-skills/updates'
    state.mkdir(parents=True, exist_ok=True)
    managed.mkdir(parents=True, exist_ok=True)
    with (state / 'update.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Official agent update already running; skipped.')
            return
        results = {'checkedAt': int(time.time()), 'skills': {}, 'tools': {}}
        receipt_path = state / 'skills.json'
        receipts = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        for repo, branch, seed, skills in SOURCES:
            if repo.startswith('neondatabase/') and os.environ.get('HIVE_WORKSPACE_PROFILE') != 'software':
                continue
            try:
                revision = json.loads(fetch(f'https://api.github.com/repos/{repo}/commits/{branch}'))['sha']
                if not re.fullmatch('[a-f0-9]{40}', revision):
                    raise ValueError('invalid revision')
                data = fetch(f'https://codeload.github.com/{repo}/tar.gz/{revision}')
                seed_revision = seed.rsplit('-', 1)[1]
                seed_data = fetch(f'https://codeload.github.com/{repo}/tar.gz/{seed_revision}')
                for relative, name in skills:
                    try:
                        with tempfile.TemporaryDirectory(prefix='.update-', dir=managed) as temporary:
                            source = Path(temporary)
                            unpack(data, f'{repo.split("/")[1]}-{revision}/{relative}/', source)
                            baseline = home / '.local/share/hive/official-skills' / seed
                            if not repo.startswith('neondatabase/'):
                                baseline = baseline / relative
                            with tempfile.TemporaryDirectory(prefix='.seed-', dir=managed) as original:
                                unpack(seed_data, f'{repo.split("/")[1]}-{seed_revision}/{relative}/', Path(original))
                                results['skills'][name] = update_skill(home, state, managed, source, name, revision, baseline, receipts, digest(Path(original)))
                    except Exception:
                        results['skills'][name] = 'failed-preserved'
            except Exception:
                results['skills'][repo] = 'fetch-failed-preserved'
        environment = dict(os.environ, PATH=str(home / '.local/bin') + ':' + os.environ.get('PATH', ''),
                           npm_config_prefix=str(home / '.local'))
        active = agents_running()
        for name in ('codex', 'claude'):
            if active:
                results['tools'][name] = 'deferred-active-agent'
                continue
            try:
                results['tools'][name] = update_tool(name, home, state, environment)
            except Exception:
                results['tools'][name] = 'update-failed-preserved'
        results['plugins'] = 'User-managed plugins are not changed; review updates in native plugin UI.'
        atomic_json(state / 'last-run.json', results)
        print(json.dumps(results))


if __name__ == '__main__':
    main()
