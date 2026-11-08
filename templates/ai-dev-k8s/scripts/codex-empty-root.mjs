// Fixed private installed enrollment seam. No CLI/model-selected mapping authority.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (v) =>
  JSON.stringify(
    (function sort(x) {
      return Array.isArray(x)
        ? x.map(sort)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.keys(x)
                .sort()
                .map((k) => [k, sort(x[k])]),
            )
          : x;
    })(v),
  );
function run(home, operation, proposal, grant, claims, lifetimeId) {
  const code = String.raw`import sys,json,importlib.util,pathlib,time
sys.dont_write_bytecode=True
p=json.load(sys.stdin);source=pathlib.Path(p['module']);spec=importlib.util.spec_from_file_location('empty_managed',source);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m);manager=m.ManagedProjects.installed(p['home'])
if p['operation']=='initialize':
 if not (manager.state/'root.json').exists():
  with manager.lock():pass
 result=None
elif p['operation']=='inspect':result=manager._inspect_empty_root(manager._installed_observer,p["lifetimeId"])
else:
 class Authority:
  guardian=manager._installed_observer
  def verify(self,proposal):
   m.require(manager._empty_digest(proposal)==p['claims']['emptyRoot']['proposalDigest'] and p['claims']['exp']*1000>time.time()*1000,'empty_root_authority_expired')
   return {'expiresAt':p['claims']['exp']*1000,'enrollmentToken':p['grant'],'anchor':p['claims']['emptyRoot']}
 result=manager._revalidate_empty_root(p['proposal'],Authority())
print(json.dumps(result,separators=(',',':')))`;
  const result = execFileSync("/usr/bin/python3", ["-I", "-c", code], {
    input: JSON.stringify({
      home,
      operation,
      proposal,
      grant,
      claims,
      lifetimeId,
      module: join(dirname(fileURLToPath(import.meta.url)), "managed-projects.py"),
    }),
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
    maxBuffer: 32768,
  });
  return JSON.parse(result);
}
export function initializeEmptyRoot(home) {
  return run(home, "initialize");
}
export function inspectEmptyRoot(home, lifetimeId) {
  if (!existsSync(join(home, ".local/state/hive/managed-projects/root.json"))) return null;
  const proposal = run(home, "inspect", null, null, null, lifetimeId);
  if (proposal && Buffer.byteLength(JSON.stringify(proposal)) > 16384)
    throw new Error("empty_root_inventory_bound");
  return proposal;
}
export function applyEmptyRoot(home, proposal, grant, claims) {
  if (
    !proposal ||
    claims.emptyRoot?.proposalDigest !== sha(canonical(proposal)) ||
    claims.exp * 1000 <= Date.now()
  )
    throw new Error("empty_root_authority_rejected");
  return run(home, "apply", proposal, grant, claims);
}
