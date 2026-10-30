import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const driver = `import importlib.util,json,sys,base64
p=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('boot','docker/hive-base/hive-template-bootstrap.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assets={k:base64.b64decode(v) for k,v in p['assets'].items()}
def read(path,limit):
 data=assets[path.name]
 if len(data)>limit: raise ValueError()
 return data
source,packet=m.prepare(p['kind'],p['request'].encode(),read)
result=json.loads(packet)
assert base64.b64decode(result['archive'])==assets[m.ASSETS[p['kind']][1]]
assert source==assets[m.ASSETS[p['kind']][0]]
assert 'imageArchiveSha256' not in result and 'imageInstallerSha256' not in result
`;
for (const [kind, archive, installer] of [
  ["host", "codex-host.tar.xz", "install-codex-host.py"],
  ["read", "workspace-read.tar.gz", "install-workspace-read.py"],
  ["voice", "voice.tar.gz", "install-voice.py"],
  ["agent", "agent-bridge.tar.gz", "install-agent-bridge.py"],
]) {
  test(`${kind} bootstrap reconstructs only image-pinned bytes and rejects tampering`, async () => {
    const a = await readFile(`templates/ai-dev-k8s/assets/${archive}`),
      i = await readFile(`templates/ai-dev-k8s/scripts/${installer}`);
    const fields = {
      schemaVersion: 1,
      archiveSha256: "a".repeat(64),
      config: {},
      ...(kind === "host" ? { archiveEncoding: "xz" } : { manifestSha256: "b".repeat(64) }),
      imageArchiveSha256: sha(a),
      imageInstallerSha256: sha(i),
    };
    const assets = { [archive]: a.toString("base64"), [installer]: i.toString("base64") };
    const run = (request, value = assets) =>
      spawnSync("python3", ["-I", "-B", "-c", driver], {
        input: JSON.stringify({ kind, request, assets: value }),
        encoding: "utf8",
      });
    const ok = run(JSON.stringify(fields));
    assert.equal(ok.status, 0, ok.stderr);
    assert.notEqual(
      run(JSON.stringify({ ...fields, imageArchiveSha256: "0".repeat(64) })).status,
      0,
    );
    assert.notEqual(
      run(JSON.stringify({ ...fields, imageInstallerSha256: "0".repeat(64) })).status,
      0,
    );
    assert.notEqual(run(JSON.stringify({ ...fields, archive: "attacker" })).status, 0);
    assert.notEqual(run(`{"schemaVersion":1,${JSON.stringify(fields).slice(1)}`).status, 0);
    assert.notEqual(run(" ".repeat(32769)).status, 0);
  });
}

test("image launcher executes pinned installer bytes with reconstructed stdin in a private namespace", {
  skip: process.env.HIVE_VOICE_INSTALL_NATIVE !== "1",
  timeout: 30000,
}, async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "hive-image-launch-")),
    assetsDir = join(root, "assets");
  await mkdir(assetsDir, { mode: 0o755 });
  try {
    const installer = Buffer.from(
      'import json,sys,base64,hashlib\nr=json.load(sys.stdin)\nprint(hashlib.sha256(base64.b64decode(r["archive"])).hexdigest())\n',
    );
    const archive = Buffer.from("synthetic-public-archive");
    await writeFile(join(assetsDir, "install-codex-host.py"), installer, { mode: 0o444 });
    await writeFile(join(assetsDir, "codex-host.tar.xz"), archive, { mode: 0o444 });
    const request = JSON.stringify({
      schemaVersion: 1,
      archiveEncoding: "xz",
      archiveSha256: "a".repeat(64),
      config: {},
      imageInstallerSha256: sha(installer),
      imageArchiveSha256: sha(archive),
    });
    const result = spawnSync(
      "bwrap",
      [
        "--unshare-user",
        "--uid",
        "0",
        "--gid",
        "0",
        "--unshare-net",
        "--die-with-parent",
        "--tmpfs",
        "/usr",
        "--ro-bind",
        "/usr/bin",
        "/usr/bin",
        "--ro-bind",
        "/usr/lib",
        "/usr/lib",
        "--ro-bind",
        "/usr/lib64",
        "/usr/lib64",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--dir",
        "/usr/local",
        "--dir",
        "/usr/local/libexec",
        "--ro-bind",
        assetsDir,
        "/usr/local/libexec/hive-template-runtime",
        "--ro-bind",
        resolve("docker/hive-base/hive-template-bootstrap.py"),
        "/usr/local/libexec/hive-template-bootstrap",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/usr/bin/python3",
        "-I",
        "-B",
        "/usr/local/libexec/hive-template-bootstrap",
        "host",
      ],
      { input: request, encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout.trim(), sha(archive));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
