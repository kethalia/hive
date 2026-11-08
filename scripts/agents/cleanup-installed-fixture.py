"""Local integration driver. Transport/home doubles only; installed verifier and
managed deletion code run unchanged against a real owned temporary Git checkout.
No provider credentials, network Git transport or production paths are used."""
import base64
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
from unittest import mock
sys.dont_write_bytecode = True
ROOT=Path(__file__).resolve().parents[2]

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value);return value
fixture=load("cleanup_fixture_support",ROOT/"scripts/agents/test_managed_projects.py")
request=json.load(sys.stdin);base=Path(request["base"]);home=base/"home";source=base/"source";bare=base/"remote.git"
if request["operation"]=="create":
    home.mkdir(mode=0o700);source.mkdir()
    fixture.git(source,"init","-b","main");(source/"README.md").write_text("owned cleanup fixture\n");(source/".gitignore").write_text("*.cache\n")
    (source/"src").mkdir();(source/"src/fixture.ts").write_text("export const behavior = true;\n")
    fixture.git(source,"add",".");fixture.git(source,"commit","-m","test: cleanup fixture")
    revision=fixture.git(source,"rev-parse","HEAD");fixture.git(base,"clone","--bare",str(source),str(bare))
    manager=fixture.MODULE.ManagedProjects(home,fixture.FixtureResolver(),fixture.FixtureGit(bare))
    prepared=manager.prepare("123",request["taskId"],revision)
    checkout=Path(prepared["checkoutDirectory"]);gitdir=checkout/".git"
    print(json.dumps({"prepared":prepared,"revision":revision,"gitIdentity":{k:str(v) for k,v in manager.identity(gitdir).items()}}));sys.exit(0)
manager=fixture.MODULE.ManagedProjects(home,fixture.FixtureResolver(),fixture.FixtureGit(bare))
# Existing tests explicitly scope /proc to the real fixture processes; no
# production scanner function is replaced and no opaque process is exempted.
original_iterdir=Path.iterdir
process_ids={os.getpid(),os.getppid()}
def iter_processes(path):
    return iter(Path("/proc")/str(pid) for pid in process_ids) if path==Path("/proc") else original_iterdir(path)
with mock.patch.object(Path,"iterdir",iter_processes):
    if request["operation"]=="release":
        with manager.lock():
            _,_,record=manager.load("123");lease=record["lease"];revision=record["revision"]
        manager.release_lease("123",request["taskId"],lease["id"],lease["generation"],revision)
        print(json.dumps(manager._inspect_cleanup("123",request["taskId"])));sys.exit(0)
    if request["operation"] in {"empty-inspect", "empty-apply", "empty-prepare"}:
        # Explicit kernel/mount observation double: same real paths/inodes,
        # observed in a later epoch on the same provider volume. Old HMAC bytes
        # and the actual signed cleanup history are never rewritten.
        identity = manager.identity
        manager.identity = lambda path: {**identity(path), "device": identity(path)["device"] + 1}
        inventory = manager._empty_inventory
        def protocol_inventory(*args, **kwargs):
            result = inventory(*args, **kwargs)
            # Only the fixed deployment HOME path differs in this owned fixture.
            result["root"]["path"] = "/home/coder/projects/.hive-managed"
            return result
        manager._empty_inventory = protocol_inventory
        if request["operation"] == "empty-inspect":
            before = {str(p):p.read_bytes() for p in manager.state.glob("*.json")}
            try:
                manager.prepare("123", "next-epoch-task", fixture.git(source,"rev-parse","HEAD"))
                raise AssertionError("unmapped old root admitted")
            except fixture.MODULE.ManagedError as error:
                assert str(error) == "managed_root_changed"
            proposal = manager._inspect_empty_root(lifetime_id=request["lifetimeId"])
            assert before == {str(p):p.read_bytes() for p in manager.state.glob("*.json")}
            print(json.dumps(proposal));sys.exit(0)
        if request["operation"] == "empty-prepare":
            next_task = manager.prepare("123", request["nextTaskId"], fixture.git(source,"rev-parse","HEAD"))
            assert next_task["lease"]["taskId"] == request["nextTaskId"]
            marker = manager.read(manager.state/"cleanup-123.json")
            print(json.dumps({"prepared":next_task,"cleanupReceipt":marker["receipt"],"retainedProject":(manager.root/"github/123/evidence").is_dir()}));sys.exit(0)
        proposal, claims, token = request["proposal"], request["claims"], request["enrollmentToken"]
        class EnrollmentAuthority:
            def guardian(self):return None
            def verify(self, actual):
                fixture.MODULE.require(manager._empty_digest(actual) == claims["emptyRoot"]["proposalDigest"] and claims["exp"]*1000 > fixture.MODULE.time.time()*1000, "empty_root_authority_expired")
                return {"expiresAt":claims["exp"]*1000,"enrollmentToken":token,"anchor":claims["emptyRoot"]}
        result = manager._revalidate_empty_root(proposal, EnrollmentAuthority())
        root_before = (manager.state / "root.json").read_bytes()
        assert manager._inspect_empty_root(lifetime_id=claims["lifetimeId"]) == proposal
        manager._revalidate_empty_root(proposal, EnrollmentAuthority())
        assert (manager.state / "root.json").read_bytes() == root_before
        marker = manager.read(manager.state/"cleanup-123.json")
        print(json.dumps({"mapping":result,"cleanupReceipt":marker["receipt"]}));sys.exit(0)
    if request["operation"]=="cleanup":
        config=base64.b64decode(request["configBytes"]);configdir=home/".config/hive";configdir.mkdir(mode=0o700,parents=True,exist_ok=True)
        (configdir/"codex-host.json").write_bytes(config);(configdir/"codex-host.json").chmod(0o600)
        claims=json.loads(base64.urlsafe_b64decode(request["token"].split(".")[0]+"=="));tree=request["tree"]
        stat=(Path("/proc")/str(os.getppid())/"stat").read_text();fields=stat[stat.rindex(") ")+2:].split()
        outer={"pid":os.getppid(),"startTime":fields[19],"bootId":Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
        directory=home/".local/state/hive/codex-host-guardian";directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        state={"phase":"closed","events":[{"name":"begin"},{"name":"guardianStarted"},{"name":"workerStarted"},{"name":"workerReady"},{"name":"startupReady","value":{"lifetimeId":claims["lifetimeId"],"configSha256":claims["configSha256"],"outerIdentity":outer}},{"name":"treeExited","value":tree}]}
        key=os.urandom(32);(directory/"key").write_bytes(key);(directory/"key").chmod(0o600)
        saved={"state":state,"signature":hmac.new(key,json.dumps(state,separators=(",",":"),ensure_ascii=False).encode(),hashlib.sha256).hexdigest()}
        (directory/"lifetime.json").write_text(json.dumps(saved));(directory/"lifetime.json").chmod(0o600)
        helper=load("cleanup_installed_helper",ROOT/"templates/ai-dev-k8s/scripts/managed-epic-archive.py")
        original_spec=importlib.util.spec_from_file_location
        class Loader:
            def create_module(self,spec):return None
            def exec_module(self,module):
                class Factory:
                    @staticmethod
                    def installed(unused): return manager
                module.ManagedProjects=Factory
                module.InstalledSealedHostObserver=lambda unused:lambda:None
        def specs(name,path):
            return importlib.util.spec_from_loader(name,Loader()) if name=="hive_epic_managed" else original_spec(name,path)
        output=io.StringIO()
        with mock.patch.object(helper.pwd,"getpwuid",return_value=types.SimpleNamespace(pw_dir=str(home))),mock.patch.object(helper.importlib.util,"spec_from_file_location",specs),mock.patch.object(sys,"stdin",io.TextIOWrapper(io.BytesIO(json.dumps({"operation":"cleanup","token":request["token"]}).encode()))),mock.patch.object(sys,"stdout",output):
            helper.main()
        print(output.getvalue().strip());sys.exit(0)
raise ValueError("unknown fixture operation")
