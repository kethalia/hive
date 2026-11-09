import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { artifactDigest, packReleaseArtifact } from "../../../../scripts/release/artifact.mjs";
import { runWorkerdCompatibility } from "../../src/delivery/compatibility-workerd.mjs";

const hash = (v) => v.repeat(64);
test("workerd adapter rejects changed scenario and release archive before starting processes", async () => {
  const name = `fixture_${randomUUID().replaceAll("-", "")}.mjs`,
    dir = "scripts/release/compatibility",
    path = `${dir}/${name}`,
    script = Buffer.from("// trusted scenario fixture\n");
  await mkdir(dir, { recursive: true });
  await writeFile(path, script);
  const files = new Map([
      ["app/worker.js", Buffer.from("export default {}")],
      ["auth/worker.js", Buffer.from("export default {}")],
    ]),
    archive = await packReleaseArtifact(files);
  const config = {
    schemaVersion: 1,
    kind: "workerd",
    catalogId: randomUUID(),
    planDigest: hash("a"),
    sourceSha: "b".repeat(40),
    oldAppDigest: artifactDigest(files, "app"),
    newAppDigest: hash("c"),
    oldAuthDigest: artifactDigest(files, "auth"),
    newAuthDigest: artifactDigest(files, "auth"),
    compatibilityDigest: hash("d"),
    postgresImage: `registry.example/db@sha256:${hash("e")}`,
    oldArtifactUrl: "https://artifacts.example/old",
    newArtifactUrl: "https://artifacts.example/new",
    scenarioPath: path,
    scenarioDigest: createHash("sha256").update(script).digest("hex"),
    compatibilityDate: "2026-10-29",
  };
  try {
    let called = 0;
    const fetcher = async () => {
      called++;
      return new Response(archive);
    };
    await assert.rejects(
      runWorkerdCompatibility({ ...config, scenarioDigest: hash("f") }, { fetcher }),
      /scenario_changed/,
    );
    assert.equal(called, 0);
    await assert.rejects(runWorkerdCompatibility(config, { fetcher }), /artifact_changed/);
    assert.equal(called, 2);
  } finally {
    await rm(path, { force: true });
  }
});

test("local workerd runs both packed app/auth versions and assets against fixture PostgreSQL", {
  skip: !process.env.HIVE_D10_TEST_DATABASE_URL,
  timeout: 120000,
}, async () => {
  const name = `integration_${randomUUID().replaceAll("-", "")}.mjs`,
    dir = "scripts/release/compatibility",
    path = `${dir}/${name}`;
  const script = Buffer.from(`import {execFileSync} from 'node:child_process';
const p=(sql)=>execFileSync('/usr/bin/psql',[process.env.DATABASE_URL,'-X','-v','ON_ERROR_STOP=1','-c',sql],{stdio:'ignore'});
if(process.argv[2]==='prepare') p("CREATE TABLE IF NOT EXISTS d10_workerd_fixture (value text); INSERT INTO d10_workerd_fixture VALUES ('prepared')");
else { for(const [origin,version] of [[process.env.HIVE_OLD_APP,'old'],[process.env.HIVE_NEW_APP,'new']]) { const r=await fetch(origin+'/proof'); const j=await r.json(); if(j.auth!=='auth-'+version||j.asset!=='asset-'+version||j.version!==version) throw Error('missing binding'); } p('SELECT value FROM d10_workerd_fixture'); }`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, script);
  const makeFiles = (version) =>
    new Map([
      [
        "app/worker.js",
        Buffer.from(
          `export default { async fetch(req, env) { const a = await env.AUTH_SERVICE.fetch('https://auth/proof'); const b = await env.ASSETS.fetch('http://assets/fixture.txt'); return Response.json({auth:await a.text(),asset:await b.text(),version:'${version}'}); } }`,
        ),
      ],
      [
        "auth/worker.js",
        Buffer.from(`export default {fetch(){return new Response('auth-${version}')}}`),
      ],
      ["assets/fixture.txt", Buffer.from(`asset-${version}`)],
    ]);
  const oldFiles = makeFiles("old"),
    newFiles = makeFiles("new");
  const oldArchive = await packReleaseArtifact(oldFiles),
    newArchive = await packReleaseArtifact(newFiles);
  const config = {
    schemaVersion: 1,
    kind: "workerd",
    catalogId: randomUUID(),
    planDigest: hash("a"),
    sourceSha: "b".repeat(40),
    oldAppDigest: artifactDigest(oldFiles, "app"),
    newAppDigest: artifactDigest(newFiles, "app"),
    oldAuthDigest: artifactDigest(oldFiles, "auth"),
    newAuthDigest: artifactDigest(newFiles, "auth"),
    compatibilityDigest: hash("d"),
    postgresImage: `registry.example/db@sha256:${hash("e")}`,
    oldArtifactUrl: "https://artifacts.example/old",
    newArtifactUrl: "https://artifacts.example/new",
    scenarioPath: path,
    scenarioDigest: createHash("sha256").update(script).digest("hex"),
    compatibilityDate: "2026-10-29",
  };
  try {
    const result = await runWorkerdCompatibility(config, {
      fetcher: async (url) => new Response(url.endsWith("/old") ? oldArchive : newArchive),
      fixtureDatabaseUrl: process.env.HIVE_D10_TEST_DATABASE_URL,
    });
    assert.equal(result.oldAppDigest, config.oldAppDigest);
  } finally {
    await rm(path, { force: true });
  }
});
