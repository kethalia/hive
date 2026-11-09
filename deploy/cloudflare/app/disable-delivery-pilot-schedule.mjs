// Standalone recovery path: no checkout, build artifact, app credential or DB required.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ACCOUNT = "225177f82b9234ede14e897fe15e0cb5",
  NAME = "hive-jobs-compatibility-preview",
  CRON = "*/5 * * * *";
const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts`;
export async function inspectPilotSchedule(receipt, api) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.accountId, ACCOUNT);
  assert.equal(receipt.name, NAME);
  assert.equal(receipt.action, "enable");
  assert.match(receipt.tag, /^[a-f0-9]{32}$/);
  assert.ok(Number.isFinite(Date.parse(receipt.createdOn)));
  const scripts = await api("GET", base);
  assert.ok(Array.isArray(scripts.result));
  if (scripts.result_info?.total_count !== undefined)
    assert.equal(scripts.result_info.total_count, scripts.result.length);
  const matches = scripts.result.filter((x) => x.id === NAME);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].tag, receipt.tag);
  assert.equal(matches[0].created_on, receipt.createdOn);
  const deployments = await api("GET", `${base}/${NAME}/deployments`);
  const latest = deployments.result?.deployments?.[0];
  assert.equal(latest?.id, receipt.deploymentId);
  assert.deepEqual(latest.versions, [{ percentage: 100, version_id: receipt.versionId }]);
  const schedule = await api("GET", `${base}/${NAME}/schedules`);
  const crons = schedule.result?.schedules?.map((x) => x.cron);
  assert.ok(
    Array.isArray(crons) && (crons.length === 0 || (crons.length === 1 && crons[0] === CRON)),
  );
  return {
    name: NAME,
    tag: receipt.tag,
    createdOn: receipt.createdOn,
    deploymentId: receipt.deploymentId,
    versionId: receipt.versionId,
    schedules: crons,
  };
}
async function privateJson(path) {
  assert.ok(isAbsolute(path));
  const dir = dirname(path),
    ds = await lstat(dir);
  assert.ok(
    ds.isDirectory() &&
      !ds.isSymbolicLink() &&
      ds.uid === process.getuid() &&
      (ds.mode & 0o777) === 0o700,
  );
  assert.equal(await realpath(dir), resolve(dir));
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    assert.ok(
      s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600,
    );
    return JSON.parse(await f.readFile("utf8"));
  } finally {
    await f.close();
  }
}
async function main() {
  const [path, ...flags] = process.argv.slice(2);
  assert.ok(path && flags.length <= 1 && (!flags.length || flags[0] === "--disable"));
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  assert.match(token, /^[\x21-\x7e]{20,512}$/);
  const receipt = await privateJson(path);
  const api = async (method, url, body) => {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    assert.equal(r.ok, true);
    const json = await r.json();
    assert.equal(json.success, true);
    return json;
  };
  const observed = await inspectPilotSchedule(receipt, api);
  if (!flags.length) {
    console.log(JSON.stringify({ verified: true, cloudWrites: 0, ...observed }));
    return;
  }
  if (observed.schedules.length === 0) {
    console.log(JSON.stringify({ disabled: true, readbackVerified: true, cloudWrites: 0 }));
    return;
  }
  const runId = randomUUID(),
    dir = dirname(path),
    attempt = join(dir, `emergency-disable-attempt-${runId}.json`);
  const file = await open(attempt, "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify({
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        receipt,
        ...observed,
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const result = await api("PUT", `${base}/${NAME}/schedules`, []);
  assert.deepEqual(result.result?.schedules, []);
  const after = await api("GET", `${base}/${NAME}/schedules`);
  assert.deepEqual(after.result?.schedules, []);
  await writeFile(
    join(dir, `emergency-disable-result-${runId}.json`),
    JSON.stringify({ schemaVersion: 1, verifiedAt: new Date().toISOString(), schedules: [] }),
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify({ disabled: true, readbackVerified: true }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      "Schedule recovery rejected or uncertain. Preserve the attempt; inspect provider state before any retry.",
    );
    process.exitCode = 1;
  });
