"""Real broker/PTY/child handling with a local CLI double; no provider calls."""
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time
import unittest

DRIVER = Path(__file__).resolve().parents[1] / "agent-bridge/claude-account-driver.py"
FAKE = '''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['CLAUDE_CONFIG_DIR']); args=sys.argv[1:]
with (p/'argv').open('a') as f:f.write(json.dumps(args)+'\\n')
if args==['auth','status','--json']:
 ok=(p/'signed-in').exists();print(json.dumps({'loggedIn':ok,'unknownPrivateField':'must-not-export'}));sys.exit(0 if ok else 1)
if args==['auth','logout']:
 (p/'signed-in').unlink(missing_ok=True);sys.exit(0)
if args==['auth','login']:
 (p/'login-pid').write_text(str(os.getpid()))
 if (p/'oversized').exists(): print('x'*70000,flush=True);sys.exit(1)
 print('https://claude.com/cai/oauth/authorize?state=fixture',flush=True)
 print('Paste code here > ',end='',flush=True)
 code=sys.stdin.readline().strip();print(code,flush=True)
 if code=='SECRET_TEST_CODE#STATE':(p/'signed-in').touch();sys.exit(0)
 sys.exit(1)
sys.exit(99)
'''


class ClaudeDriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hive-claude-driver-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        cli = self.root / "claude"
        cli.write_text(FAKE)
        cli.chmod(0o700)
        self.lock = os.open(self.root / "lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(lambda: os.close(self.lock))
        wrapper = "import os,sys;os.dup2(int(sys.argv[1]),3,inheritable=True);os.execv('/usr/bin/python3',['python3','-I','-B',sys.argv[2]])"
        self.process = subprocess.Popen(["/usr/bin/python3", "-c", wrapper, str(self.lock), str(DRIVER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, pass_fds=(self.lock,),
            env={"HOME": str(self.root), "CLAUDE_CONFIG_DIR": str(self.root), "HIVE_CLAUDE_EXECUTABLE": str(cli), "PATH": "/usr/bin:/bin"})
        self.addCleanup(self.close)
        self.sequence = 0
        self.buffer = bytearray()
        self.frames = []

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.process.stdin.close()
        self.process.stdout.close()

    def call(self, method, params=None):
        self.sequence += 1
        self.process.stdin.write((json.dumps({"id": self.sequence, "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                raw, _, self.buffer = self.buffer.partition(b"\n")
                value = json.loads(raw)
                self.frames.append(value)
                if value.get("id") == self.sequence: return value
            if select.select([self.process.stdout], [], [], 0.05)[0]:
                data = os.read(self.process.stdout.fileno(), 4096)
                if not data: break
                self.buffer.extend(data)
        self.fail("local broker response deadline")

    def test_fixed_cli_flow_has_one_code_write_and_sanitized_fresh_status(self):
        self.assertEqual(self.call("account/read")["result"], {"account": None})
        pending = self.call("account/login/start")["result"]
        self.assertEqual(pending["type"], "claudeCli")
        self.assertEqual(self.call("account/login/submitCode", {"loginId": pending["loginId"], "code": "SECRET_TEST_CODE#STATE"})["result"], {"accepted": True})
        self.assertIn("error", self.call("account/login/submitCode", {"loginId": pending["loginId"], "code": "SECRET_TEST_CODE#STATE"}))
        for _ in range(20):
            value = self.call("account/read")
            if value.get("result", {}).get("account"): break
            time.sleep(0.01)
        self.assertEqual(value["result"], {"account": {"type": "claude"}})
        self.call("account/logout")
        self.assertEqual(self.call("account/read")["result"], {"account": None})
        calls = [json.loads(line) for line in (self.root / "argv").read_text().splitlines()]
        self.assertEqual(calls.count(["auth", "login"]), 1)
        self.assertTrue(all(call in (["auth", "login"], ["auth", "logout"], ["auth", "status", "--json"]) for call in calls))
        self.assertNotIn("SECRET_TEST_CODE", json.dumps(self.frames))
        self.assertNotIn("must-not-export", json.dumps(self.frames))

    def test_cancel_waits_for_exact_child_and_late_code_cannot_reopen_it(self):
        pending = self.call("account/login/start")["result"]
        pid = int((self.root / "login-pid").read_text())
        self.assertIn("error", self.call("account/login/start"))
        self.assertEqual(self.call("account/login/cancel", {"loginId": pending["loginId"]})["result"], {"status": "canceled"})
        with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
        self.assertIn("error", self.call("account/login/submitCode", {"loginId": pending["loginId"], "code": "SECRET_TEST_CODE#STATE"}))
        self.assertFalse((self.root / "signed-in").exists())

    def test_arbitrary_commands_control_characters_and_large_output_never_escape(self):
        self.assertIn("error", self.call("arbitrary/exec", {"command": "unsafe"}))
        pending = self.call("account/login/start")["result"]
        self.assertIn("error", self.call("account/login/submitCode", {"loginId": pending["loginId"], "code": "one\ntwo"}))
        self.call("account/login/cancel", {"loginId": pending["loginId"]})
        (self.root / "oversized").touch()
        self.assertIn("error", self.call("account/login/start"))
        self.assertLess(len(json.dumps(self.frames)), 4096)


if __name__ == "__main__": unittest.main()
