"""Explicit local fixture setup; never installed or imported by production.

Real protected broker objects + managed checkout, with an injected fake GitHub
provider. Fixture rebinding authenticates synthetic DB identities before apply;
no production receipt is adopted and no network/authentication is used.
"""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


runtime = module("fixture_runtime", ROOT / "scripts/agents/test_delivery_source_runtime.py")
managed = module("fixture_managed", ROOT / "scripts/agents/test_managed_projects.py")
worker = module("fixture_worker", ROOT / "templates/ai-dev-k8s/scripts/delivery-source-apply-worker.py")


def setup(home):
    f = runtime.ProtectedBrokerTests("runTest")
    f.setUp()
    try:
        assert f.publish()["phase"] == "published"
        entry = f.b.load(f.request["operationId"])
        parent = home / ".local/state/hive/delivery-source-publisher/broker"
        parent.mkdir(parents=True, mode=0o700)
        os.chmod(parent.parent, 0o700)
        shutil.move(f.private, parent / f.request["operationId"])
        bare = home / "fixture-remote.git"
        managed.git(home, "clone", "--bare", str(f.workspace), str(bare))
        manager = managed.MODULE.ManagedProjects(home, managed.FixtureResolver(), managed.FixtureGit(bare))
        prepared = manager.prepare("123", str(uuid.uuid4()), f.scope["parentSha"])
        checkout = Path(prepared["checkoutDirectory"])
        (checkout / "src/main.txt").write_bytes(b"later dirty bytes\0remain\n")
        (checkout / "README.md").write_bytes(b"nonoverlapping staged edit\n")
        managed.git(checkout, "add", "README.md")
        (checkout / "untracked").write_bytes(b"untracked retained\n")
        (checkout / ".git/info").mkdir(exist_ok=True)
        (checkout / ".git/info/exclude").write_text("ignored.cache\n")
        (checkout / "ignored.cache").write_bytes(b"ignored retained\n")
        _, _, record = manager.load("123")
        pin = lambda p: {"device": str(p.stat().st_dev), "inode": str(p.stat().st_ino)}
        result = {"operationId": f.request["operationId"], "headSha": entry["commit"]["sha"],
                  "treeSha": entry["commit"]["tree"], "manifestDigest": entry["manifestDigest"],
                  "checkout": str(checkout), "revision": f.scope["parentSha"],
                  "leaseId": record["lease"]["id"], "leaseGeneration": record["lease"]["generation"],
                  "checkoutIncarnation": record["checkoutIncarnation"],
                  "checkoutIdentity": pin(checkout), "gitIdentity": pin(checkout / ".git")}
        (home / "material.json").write_text(json.dumps(result))
        return result
    finally:
        f.doCleanups()


def bind(home, value):
    material = json.loads((home / "material.json").read_text())
    manager = managed.MODULE.ManagedProjects(home)
    with manager.lock():
        _, path, record = manager.load("123")
        record["lease"]["taskId"] = value["checkoutBinding"]["preparationIntentId"]
        record["lastTaskId"] = record["lease"]["taskId"]
        manager.write(path, record)
    root = home / ".local/state/hive/delivery-source-publisher/broker" / material["operationId"]
    entry_path = root / "operations" / (material["operationId"] + ".json")
    entry = json.loads(entry_path.read_text())["value"]
    scope = value["scope"]
    entry["scope"] = scope
    entry["branch"] = value["branch"]
    entry["requestDigest"] = worker.sha(worker.canonical({"scope": scope, "policyDigest": entry["policyDigest"], "request": entry["request"]}))
    signature = hmac.new((root / "key").read_bytes(), worker.canonical(entry), hashlib.sha256).hexdigest()
    entry_path.write_bytes(worker.canonical({"value": entry, "mac": signature}))
    return {"bound": True}


def inspect(home):
    manager = managed.MODULE.ManagedProjects(home)
    return manager.inspect("123")


if __name__ == "__main__":
    action, home = sys.argv[1], Path(sys.argv[2]).resolve()
    assert home.name.startswith("hive-application-installed-") and home.is_dir()
    if action == "worker":
        # Explicit fixture DI only: the installed worker itself accepts no path CLI.
        worker.run(worker.protocol.Channel(), home=home)
    else:
        result = setup(home) if action == "setup" else bind(home, json.load(sys.stdin)) if action == "bind" else inspect(home)
        print(json.dumps(result))
