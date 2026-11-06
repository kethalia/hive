import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadPreviewIdentity,
  previewIdentityScope,
  previewRuntimeBindings,
} from "./deployment-identity.mjs";

const databaseUrl =
  "postgresql://hive_app_runtime:synthetic@ep-jolly-sky-b7fhirib-pooler.c-13.us-east-1.aws.neon.tech/hive_app_preview?sslmode=require";
const scope = previewIdentityScope(databaseUrl);

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "hive-preview-identity-test-"));
  try {
    await run(directory, join(directory, "identity.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("two artifact preparations preserve encryption/session identity and app/auth key agreement", () =>
  fixture(async (_, path) => {
    const first = await loadPreviewIdentity(path, scope, { createIfMissing: true });
    const original = await readFile(path, "utf8");
    const second = await loadPreviewIdentity(path, scope, { createIfMissing: true });
    const firstBindings = previewRuntimeBindings(first, databaseUrl);
    const secondBindings = previewRuntimeBindings(second, databaseUrl);
    assert.deepEqual(secondBindings, firstBindings);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(firstBindings.app.ENCRYPTION_KEY, firstBindings.auth.ENCRYPTION_KEY);
    assert.equal(firstBindings.app.AUTH_SERVICE_SECRET, firstBindings.auth.AUTH_SERVICE_SECRET);
    assert.ok(!Object.hasOwn(firstBindings.auth, "COOKIE_SECRET"));
  }));

test("missing identity requires explicit first-create and forbidden scope never rewrites it", () =>
  fixture(async (_, path) => {
    await assert.rejects(loadPreviewIdentity(path, scope));
    const identity = await loadPreviewIdentity(path, scope, { createIfMissing: true });
    const original = await readFile(path, "utf8");
    for (const field of Object.keys(scope))
      await assert.rejects(
        loadPreviewIdentity(path, { ...scope, [field]: "foreign" }, { createIfMissing: true }),
      );
    assert.throws(() =>
      previewRuntimeBindings(identity, databaseUrl.replace("hive_app_runtime", "owner")),
    );
    assert.equal(await readFile(path, "utf8"), original);
  }));

test("identity rejects readable modes, file/directory symlinks and hardlinks", () =>
  fixture(async (directory, path) => {
    await loadPreviewIdentity(path, scope, { createIfMissing: true });
    await chmod(path, 0o644);
    await assert.rejects(loadPreviewIdentity(path, scope));
    await chmod(path, 0o600);
    const alias = join(directory, "alias.json");
    await symlink(path, alias);
    await assert.rejects(loadPreviewIdentity(alias, scope));
    const hardlink = join(directory, "hardlink.json");
    await link(path, hardlink);
    await assert.rejects(loadPreviewIdentity(path, scope));
    await rm(hardlink);
    await chmod(directory, 0o755);
    await assert.rejects(loadPreviewIdentity(path, scope));
    await chmod(directory, 0o700);
    const directoryAlias = `${directory}-alias`;
    try {
      await symlink(directory, directoryAlias);
      await assert.rejects(loadPreviewIdentity(join(directoryAlias, "identity.json"), scope));
    } finally {
      await rm(directoryAlias, { force: true });
    }
  }));

test("malformed identity keys are rejected without replacement", () =>
  fixture(async (_, path) => {
    const identity = await loadPreviewIdentity(path, scope, { createIfMissing: true });
    identity.keys.ENCRYPTION_KEY = "invalid";
    await writeFile(path, JSON.stringify(identity));
    await assert.rejects(loadPreviewIdentity(path, scope, { createIfMissing: true }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).keys.ENCRYPTION_KEY, "invalid");
  }));
