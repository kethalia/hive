"""Local-only factory composition: real Git/managed helpers, fake GitHub HTTP.

Never packaged. The parent test substitutes only the two fixed Python entrypoints
to supply this private home and an explicit provider double; no credentials exist.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


managed = module("factory_managed_fixture", ROOT / "scripts/agents/test_managed_projects.py")


def setup(home):
    seed = home / "seed"
    seed.mkdir()
    managed.git(seed, "init", "--template=")
    (seed / "src").mkdir()
    (seed / "src/main.txt").write_bytes(b"base\n")
    (seed / "README.md").write_bytes(b"untouched\n")
    managed.git(seed, "add", ".")
    managed.git(seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "test: base")
    revision = managed.git(seed, "rev-parse", "HEAD").strip()
    bare = home / "remote.git"
    managed.git(home, "clone", "--bare", str(seed), str(bare))
    manager = managed.MODULE.ManagedProjects(home, managed.FixtureResolver(), managed.FixtureGit(bare))
    prepared = manager.prepare("123", str(uuid.uuid4()), revision)
    checkout = Path(prepared["checkoutDirectory"])
    (checkout / "src/main.txt").write_bytes(b"published fixture bytes\n")
    (checkout / "README.md").write_bytes(b"unrelated staged bytes\n")
    managed.git(checkout, "add", "README.md")
    (checkout / "untracked").write_bytes(b"retain untracked\n")
    (checkout / ".git/info").mkdir(exist_ok=True)
    (checkout / ".git/info/exclude").write_text("ignored.cache\n")
    (checkout / "ignored.cache").write_bytes(b"retain ignored\n")
    _, _, record = manager.load("123")
    pin = lambda p: {"device": str(p.stat().st_dev), "inode": str(p.stat().st_ino)}
    return {"checkout": str(checkout), "revision": revision, "leaseId": record["lease"]["id"],
            "leaseGeneration": record["lease"]["generation"], "checkoutIncarnation": record["checkoutIncarnation"],
            "checkoutIdentity": pin(checkout), "gitIdentity": pin(checkout / ".git")}


def publish(home):
    worker = module("factory_publisher_worker", ROOT / "templates/ai-dev-k8s/scripts/delivery-source-worker.py")
    fixture = module("factory_provider_fixture", ROOT / "scripts/agents/test_delivery_source_runtime.py")
    channel = worker.Channel()
    first = channel.receive()
    scope = first["value"]["scope"]
    remote = fixture.FakeGitHub(scope)

    class Response:
        def __init__(self, url, status, value):
            self.url, self.status, self.headers = url, status, {}
            self.raw = io.BytesIO(json.dumps(value).encode())
        def __enter__(self): return self
        def __exit__(self, *_): self.raw.close()
        def geturl(self): return self.url
        def read1(self, limit): return self.raw.read(limit)

    class Opener:
        def open(self, request, timeout):
            assert request.headers["Authorization"] == "Bearer synthetic-not-a-credential"
            status, value = remote.request(request.method, request.full_url,
                                           json.loads(request.data) if request.data else None, {})
            return Response(request.full_url, status, value)

    original_spec = worker.importlib.util.spec_from_file_location

    def load_runtime(name, path):
        spec = original_spec(name, path)
        if name == "hive_fixed_source_runtime":
            assert Path(path).resolve() == ROOT / "templates/ai-dev-k8s/scripts/delivery-source-runtime.py"
            execute = spec.loader.exec_module

            def injected(value):
                execute(value)
                value.auth.external_token = lambda: "synthetic-not-a-credential"
                value.urllib.request.build_opener = lambda *_: Opener()
            spec.loader.exec_module = injected
        return spec

    worker.importlib.util.spec_from_file_location = load_runtime
    receive = channel.receive
    pending = [first]
    channel.receive = lambda: pending.pop() if pending else receive()
    try:
        worker.run(channel)
        (home / "provider-effects.json").write_text(json.dumps({
            "requests": len(remote.calls), "writes": sum(call[0] == "POST" for call in remote.calls),
            "pullRequests": len(remote.prs)}))
    finally:
        channel.socket.close()


if __name__ == "__main__":
    action, home = sys.argv[1], Path(sys.argv[2]).resolve()
    assert home.name.startswith("hive-delivery-installed-") and home.is_dir()
    if action == "publisher":
        publish(home)
    elif action == "apply":
        worker = module("factory_apply_worker", ROOT / "templates/ai-dev-k8s/scripts/delivery-source-apply-worker.py")
        channel = worker.protocol.Channel()
        try:
            worker.run(channel, home=home)
        finally:
            channel.socket.close()
    else:
        manager = managed.MODULE.ManagedProjects(home)
        if action == "setup":
            result = setup(home)
        elif action == "bind":
            task_id = json.load(sys.stdin)["preparationIntentId"]
            with manager.lock():
                _, path, record = manager.load("123")
                record["lease"]["taskId"] = task_id
                record["lastTaskId"] = task_id
                manager.write(path, record)
            result = {"bound": True}
        else:
            assert action == "inspect"
            result = manager.inspect("123")
        print(json.dumps(result))
