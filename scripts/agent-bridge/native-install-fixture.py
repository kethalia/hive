"""Exercise the actual agent installer inside an isolated test home/network namespace."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

request = json.load(sys.stdin)
assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
control = Path('/home/coder/.local/state/hive/agent-bridge')
installer = '/opt/hive-agent-entry.py'

def run():
    result = subprocess.run(['/usr/bin/python3', '-I', '-B', installer], input=json.dumps(request).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HIVE_WORKSPACE_PROFILE': 'software', 'CODEX_HOME': '/home/coder/custom-codex', 'CLAUDE_CONFIG_DIR': '/home/coder/配置'}, timeout=20)
    assert result.returncode == 0, result.stderr.decode()
    return json.loads(result.stdout)

record = None
try:
    first = run()
    assert first['ready'] and not first['reused']
    record = json.loads((control / 'service.json').read_bytes())['record']
    assert record['phase'] == 'ready' and record['runtimeIdentity']['kind'] == 'agent-tools'
    second = run()
    assert second['ready'] and second['reused'] and second['lifetimeId'] == first['lifetimeId']
    config = json.loads(Path('/home/coder/.config/hive/agent-bridge.json').read_bytes())
    assert config['binding']['agentId'] == request['config']['binding']['agentId']
    assert config['environment'] == {'CODEX_HOME': '/home/coder/custom-codex', 'CLAUDE_CONFIG_DIR': '/home/coder/配置'}
    print(json.dumps({'passed': True, 'reused': True, 'lifetimeMatched': True}))
finally:
    if record:
        pid = record['process']['pid']
        raw = Path(f'/proc/{pid}/stat').read_text()
        assert raw[raw.rindex(') ') + 2:].split()[19] == record['process']['startTime']
        os.kill(pid, signal.SIGTERM)
        for _ in range(200):
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
                if waited: break
            except ChildProcessError:
                if not Path(f'/proc/{pid}').exists(): break
            time.sleep(0.02)
        assert not Path(f'/proc/{pid}').exists()
