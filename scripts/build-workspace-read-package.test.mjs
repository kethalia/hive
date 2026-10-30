import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import tar from "tar-stream";
import { hostArchive } from "./build-codex-host-archive.mjs";
import {
  syncWorkspaceReadPackage,
  workspaceReadInstaller,
  workspaceReadPackage,
} from "./build-workspace-read-package.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hive-read-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "templates/ai-dev-k8s/scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, "hive-workspace-read.mjs"), "export const fixture = true;\n");
  await writeFile(join(scripts, "hive-workspace-read.py"), "print('fixture')\n");
  await writeFile(join(scripts, "install-workspace-read.py"), "print('installer')\n");
  return { root, scripts };
}
test("read package is deterministic and pins only its two independent service members", async (t) => {
  const { root, scripts } = await fixture(t);
  const one = await workspaceReadPackage(root),
    two = await workspaceReadPackage(root);
  assert.deepEqual(one, two);
  assert.deepEqual(gunzipSync(one.compressed), one.archive);
  const extracted = new Map(),
    extractor = tar.extract();
  const done = new Promise((resolve, reject) => {
    extractor.on("error", reject);
    extractor.on("finish", resolve);
    extractor.on("entry", (header, stream, next) => {
      assert.equal(header.type, "file");
      assert.equal(header.uid, 0);
      assert.equal(header.mtime.getTime(), 0);
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        extracted.set(header.name, Buffer.concat(chunks));
        next();
      });
    });
  });
  extractor.end(one.archive);
  await done;
  assert.deepEqual(
    [...extracted.keys()],
    ["hive-workspace-read.mjs", "hive-workspace-read.py", "manifest.json"],
  );
  const manifest = JSON.parse(extracted.get("manifest.json"));
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert.deepEqual(extracted.get(name), await readFile(join(scripts, name)));
    assert.equal(createHash("sha256").update(extracted.get(name)).digest("hex"), digest);
  }
  assert.equal(
    createHash("sha256").update(extracted.get("manifest.json")).digest("hex"),
    one.manifestSha256,
  );
});
test("check rejects stale package or changed source until deliberate resynchronization", async (t) => {
  const { root, scripts } = await fixture(t);
  await syncWorkspaceReadPackage(root);
  await syncWorkspaceReadPackage(root, true);
  await writeFile(join(scripts, "hive-workspace-read.py"), "print('changed')\n");
  await assert.rejects(syncWorkspaceReadPackage(root, true), /stale/);
  await syncWorkspaceReadPackage(root);
  await syncWorkspaceReadPackage(root, true);
  await writeFile(join(scripts, "hive-workspace-read.py"), Buffer.alloc(65537));
  await assert.rejects(workspaceReadPackage(root), /bounds/);
});

test("combined public bootstrap retains room for both configs under unchanged metadata budget", async (t) => {
  const root = resolve("."),
    host = await hostArchive(root),
    read = await workspaceReadPackage(root),
    installer = await workspaceReadInstaller(root);
  const hostInstaller = await readFile(
    join(root, "templates/ai-dev-k8s/scripts/install-codex-host.py"),
  );
  const loader = await readFile(join(root, "templates/ai-dev-k8s/scripts/start-workspace-read.py"));
  const fixedBytes =
    host.compressed.toString("base64").length +
    read.compressed.toString("base64").length +
    installer.compressed.toString("base64").length +
    hostInstaller.length +
    loader.length +
    64;
  // Terraform separately bounds actual annotations. Reserve 8KiB here for the
  // two fixed JSON configurations, their field names and annotation names.
  assert.ok(
    fixedBytes + 8192 <= 240000,
    `combined bootstrap ${fixedBytes} leaves insufficient config room`,
  );
  t.diagnostic(
    JSON.stringify({
      hostCompressedBytes: host.compressed.length,
      readCompressedBytes: read.compressed.length,
      installerCompressedBytes: installer.compressed.length,
      fixedBytes,
      configReserve: 8192,
      limit: 240000,
    }),
  );
});
