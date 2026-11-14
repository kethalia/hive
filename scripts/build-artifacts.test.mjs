import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import tar from "tar-stream";
import { buildRuntimeArtifacts } from "./build-runtime-artifacts.mjs";
import {
  buildTemplateArtifacts,
  templateArtifact,
  templateNames,
} from "./build-template-artifacts.mjs";
import { buildTemplateHashes } from "./build-template-hashes.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hive-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "src/lib/templates",
    "src/lib/workspace",
    "scripts/notifications",
    "public",
    ...templateNames.map((name) => `templates/${name}/scripts`),
  ])
    await mkdir(join(root, path), { recursive: true });
  for (const name of templateNames) {
    await writeFile(join(root, `templates/${name}/main.tf`), `# ${name}\n`);
    await writeFile(join(root, `templates/${name}/scripts/agent-tools.py`), "print('fixture')\n", {
      mode: 0o755,
    });
  }
  for (const name of ["install.py", "agent-hook.py"])
    await writeFile(join(root, "scripts/notifications", name), "print('fixture')\n");
  return root;
}
test("template archives are deterministic and match UI hashes and extracted paths", async (t) => {
  const root = await fixture(t);
  const first = await buildTemplateArtifacts(root, "manifest");
  await buildTemplateArtifacts(root, "assets");
  const hashes = await buildTemplateHashes(root);
  assert.deepEqual(await buildTemplateArtifacts(root, "check"), first);
  for (const name of templateNames) {
    const result = await templateArtifact(join(root, "templates", name));
    assert.equal(result.metadata.contentHash, hashes[name]);
    assert.equal(
      result.metadata.archiveDigest,
      createHash("sha256").update(result.archive).digest("hex"),
    );
    assert.deepEqual(
      await readFile(
        join(root, "public/hive-template-artifacts", `${result.metadata.archiveDigest}.tar`),
      ),
      result.archive,
    );
    const entries = [],
      extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      entries.push(header);
      stream.resume();
      stream.on("end", next);
    });
    const done = new Promise((resolve, reject) => {
      extract.on("finish", resolve);
      extract.on("error", reject);
    });
    extract.end(result.archive);
    await done;
    assert.deepEqual(
      entries.map((e) => e.name),
      ["scripts/", "main.tf", "scripts/agent-tools.py"],
    );
    assert(entries.every((e) => e.uid === 0 && e.gid === 0 && e.mtime.getTime() === 0));
    assert.equal(entries[2].mode, 0o755);
  }
  await writeFile(join(root, "templates/ai-dev-k8s/main.tf"), "changed");
  await assert.rejects(buildTemplateArtifacts(root, "assets"), /stale/);
});
test("template inputs reject private files and symlinked root or ancestor", async (t) => {
  const root = await fixture(t),
    directory = join(root, "templates/ai-dev-k8s");
  await writeFile(join(directory, ".env.production"), "private");
  await assert.rejects(templateArtifact(directory), /private/);
  await rm(join(directory, ".env.production"));
  await symlink(directory, join(root, "linked-template"));
  await assert.rejects(templateArtifact(join(root, "linked-template")), /regular|symlink/);
  await symlink(join(root, "templates"), join(root, "linked-templates"));
  await assert.rejects(
    templateArtifact(join(root, "linked-templates/ai-dev-k8s")),
    /regular|symlink/,
  );
});
test("runtime source ancestor symlink is rejected before replacing existing output", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "public/hive-runtime-artifacts"));
  await writeFile(join(root, "public/hive-runtime-artifacts/sentinel"), "preserved");
  await rm(join(root, "scripts/notifications"), { recursive: true });
  await symlink(join(root, "templates/ai-dev-k8s/scripts"), join(root, "scripts/notifications"));
  await writeFile(join(root, "templates/ai-dev-k8s/scripts/install.py"), "outside");
  await writeFile(join(root, "templates/ai-dev-k8s/scripts/agent-hook.py"), "outside");
  await assert.rejects(buildRuntimeArtifacts(root), /regular|symlink/);
  assert.equal(
    await readFile(join(root, "public/hive-runtime-artifacts/sentinel"), "utf8"),
    "preserved",
  );
});
test("both builders reject an output ancestor symlink", async (t) => {
  const root = await fixture(t),
    outside = join(root, "outside");
  await mkdir(outside);
  await rm(join(root, "public"), { recursive: true });
  await symlink(outside, join(root, "public"));
  await buildTemplateArtifacts(root, "manifest");
  await assert.rejects(buildTemplateArtifacts(root, "assets"), /regular|symlink/);
  await assert.rejects(buildRuntimeArtifacts(root), /regular|symlink/);
});
test("runtime manifest pins exact emitted bytes and rejects oversized inputs", async (t) => {
  const root = await fixture(t),
    manifest = await buildRuntimeArtifacts(root);
  assert.equal(Object.keys(manifest).length, 3);
  for (const [path, metadata] of Object.entries(manifest)) {
    const bytes = await readFile(join(root, "public/hive-runtime-artifacts", path));
    assert.equal(metadata.bytes, bytes.length);
    assert.equal(metadata.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  await writeFile(join(root, "scripts/notifications/install.py"), Buffer.alloc(524289));
  await assert.rejects(buildRuntimeArtifacts(root), /size limit/);
});
