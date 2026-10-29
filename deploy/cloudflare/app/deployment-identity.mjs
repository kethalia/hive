import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { ACCOUNT_ID, APP_NAME, AUTH_NAME, validateRuntimeDatabase } from "./deployment-plan.mjs";

const keyNames = [
  "AUTH_SERVICE_SECRET",
  "ENCRYPTION_KEY",
  "COOKIE_SECRET",
  "PREVIEW_BEARER",
  "PREVIEW_COOKIE_SECRET",
];

export function previewIdentityScope(databaseUrl) {
  validateRuntimeDatabase(databaseUrl);
  const url = new URL(databaseUrl);
  return {
    accountId: ACCOUNT_ID,
    appName: APP_NAME,
    authName: AUTH_NAME,
    databaseHost: url.hostname,
    databaseName: url.pathname.slice(1),
    databaseRole: url.username,
  };
}

function validateIdentity(identity, scope) {
  assert.equal(identity.schemaVersion, 1);
  assert.match(identity.identityId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(identity.scope, scope, "Private preview identity scope mismatch");
  assert.deepEqual(Object.keys(identity.keys).sort(), [...keyNames].sort());
  for (const key of keyNames) assert.match(identity.keys[key], /^[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(identity.keys)).size, keyNames.length);
  return identity;
}

/** Explicit private identity, preserved across artifacts; never a production key source. */
export async function loadPreviewIdentity(path, scope, { createIfMissing = false } = {}) {
  assert.ok(
    typeof path === "string" && isAbsolute(path),
    "Choose an absolute private identity file",
  );
  const parent = dirname(path);
  const directory = await lstat(parent);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(directory.uid, process.getuid());
  assert.equal(directory.mode & 0o777, 0o700, "Identity directory must be private mode700");
  assert.equal(await realpath(parent), resolve(parent), "Identity directory cannot use symlinks");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code !== "ENOENT" || !createIfMissing) throw error;
    const identity = {
      schemaVersion: 1,
      identityId: randomUUID(),
      createdAt: new Date().toISOString(),
      scope,
      keys: Object.fromEntries(keyNames.map((key) => [key, randomBytes(32).toString("hex")])),
    };
    const created = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await created.writeFile(`${JSON.stringify(identity, null, 2)}\n`);
      await created.sync();
    } finally {
      await created.close();
    }
    // Reopen and validate even the first identity through the same guarded path.
    return loadPreviewIdentity(path, scope);
  }
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.nlink === 1, "Identity must be a single-link regular file");
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o777, 0o600, "Identity file must have mode600");
    return validateIdentity(JSON.parse(await handle.readFile("utf8")), scope);
  } finally {
    await handle.close();
  }
}

export function previewRuntimeBindings(identity, databaseUrl) {
  validateIdentity(identity, previewIdentityScope(databaseUrl));
  const keys = identity.keys;
  return {
    app: { DATABASE_URL: databaseUrl, ...keys },
    auth: {
      DATABASE_URL: databaseUrl,
      AUTH_SERVICE_SECRET: keys.AUTH_SERVICE_SECRET,
      ENCRYPTION_KEY: keys.ENCRYPTION_KEY,
    },
  };
}
