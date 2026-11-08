import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  artifactDigest,
  packReleaseArtifact,
  readReleaseArtifact,
} from "../../../../scripts/release/artifact.mjs";
import { runSourceBuildCompatibility } from "../../src/delivery/compatibility-source-build.mjs";
import { digest } from "../../src/delivery/contracts.mjs";
import { packSourceBuild } from "../../src/delivery/pack-source-build.mjs";
import { deriveSourceBuildApproval } from "../../src/delivery/source-build-approval.mjs";
import { sourcePlanIntent } from "../../src/delivery/source-plan-intent.mjs";
import { databaseCatalogSchema, sourceBuildCompatibilitySchema } from "../../src/delivery/wire.mjs";

const hash = (c) => c.repeat(64),
  sha = (c) => c.repeat(40);
function fixture() {
  const plan = {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: sha("b"),
    oldAppDigest: hash("c"),
    newAppDigest: hash("d"),
    compatibilityDigest: hash("e"),
    beforeSchemaDigest: hash("f"),
    afterSchemaDigest: hash("a"),
    batchSize: 10,
    statementTimeoutMs: 1000,
    lockTimeoutMs: 100,
    schemaSql: "SELECT 1",
    expandSql: ["SELECT 1"],
    highWaterSql: "SELECT 1",
    batchSql: "SELECT 1",
    integritySql: "SELECT 1",
    integrityTables: [{ schema: "public", name: "fixture" }],
  };
  const id = randomUUID(),
    config = {
      schemaVersion: 2,
      kind: "automatic-source-build",
      catalogId: id,
      planIntentDigest: digest(sourcePlanIntent(plan)),
      recipeSha: sha("e"),
      toolchain: { node: "24.21.0", pnpm: "10.32.1" },
      sourceSha: plan.sourceSha,
      compatibilityDigest: plan.compatibilityDigest,
      postgresImage: `registry.example/db@sha256:${hash("a")}`,
      baseline: {
        sourceSha: sha("a"),
        treeSha: sha("c"),
        providerBuildUuid: randomUUID(),
        branch: "main",
      },
      candidate: {
        headSha: plan.sourceSha,
        baseSha: sha("a"),
        mergeSha: sha("d"),
        treeSha: sha("e"),
        policyDigest: hash("a"),
        checksDigest: hash("b"),
        controlDigest: hash("c"),
      },
      scenarioPath: "scripts/release/compatibility/fixture.mjs",
      scenarioDigest: hash("a"),
      compatibilityDate: "2026-10-29",
    };
  const catalog = {
    schemaVersion: 1,
    id,
    ownerId: randomUUID(),
    repositoryId: "1",
    repositoryOwnerId: "2",
    environmentKey: "production",
    targetDigest: hash("b"),
    targetId: randomUUID(),
    databaseName: "hive_d10_test",
    databaseHost: "db.example",
    databasePort: 5432,
    workflowRef: `test/repo/.github/workflows/controlled-database-job.yml@${sha("f")}`,
    workflowSha: sha("f"),
    dispatcherSha: sha("e"),
    branchRef: "refs/heads/main",
    authorityOrigin: "https://hive.example",
    authorityPublicKeyPem: "fixture-public-key".repeat(4),
    validFrom: 1000,
    expiresAt: 2000,
    automaticPlan: sourcePlanIntent(plan),
    compatibilityTest: {
      config,
      repositoryOwner: "test",
      repositoryName: "repo",
      workflowId: "3",
      jobName: "fixed-database-compatibility",
    },
  };
  return { config, catalog, plan };
}
test("source-build mode pins plan intent while keeping omitted execution disabled and legacy digests unchanged", () => {
  const { config, catalog } = fixture(),
    parsed = databaseCatalogSchema.parse(catalog);
  assert.equal(parsed.automaticExecutionEnabled, undefined);
  assert.deepEqual(sourceBuildCompatibilitySchema.parse(config), config);
  for (const mutate of [
    (c) => {
      c.compatibilityTest.config.candidate.baseSha = sha("f");
    },
    (c) => {
      c.compatibilityTest.config.candidate.headSha = sha("f");
    },
    (c) => {
      c.automaticPlan.expandSql = ["SELECT 2"];
    },
    (c) => {
      c.compatibilityTest.config.newAppDigest = hash("f");
    },
    (c) => {
      c.compatibilityTest.config.baseline.artifactDigest = hash("f");
    },
    (c) => {
      delete c.automaticPlan;
    },
  ]) {
    const changed = structuredClone(catalog);
    mutate(changed);
    assert.throws(() => databaseCatalogSchema.parse(changed));
  }
  const { automaticPlan: _plan, compatibilityTest: _test, ...legacy } = catalog;
  assert.deepEqual(databaseCatalogSchema.parse(legacy), legacy);
  assert.equal(digest(databaseCatalogSchema.parse(legacy)), digest(legacy));
  assert.throws(() => databaseCatalogSchema.parse({ ...legacy, automaticExecutionEnabled: true }));
});
test("source-build reader rejects links, malformed archives and changed trusted scenarios before any process runs", async () => {
  const { config } = fixture(),
    root = await mkdtemp(join(tmpdir(), "hive-d10-source-test-"));
  const scenarioName = `source_${randomUUID().replaceAll("-", "")}.mjs`,
    scenarioPath = `scripts/release/compatibility/${scenarioName}`;
  const scenario = Buffer.from("throw Error('Scenario must not run for changed artifacts');\n"),
    files = new Map([
      ["app/worker.js", Buffer.from("throw Error('Never import candidate in trusted Node');")],
    ]);
  await mkdir("scripts/release/compatibility", { recursive: true });
  await writeFile(scenarioPath, scenario);
  try {
    const bound = {
      ...config,
      scenarioPath,
      scenarioDigest: createHash("sha256").update(scenario).digest("hex"),
    };
    await mkdir(join(root, "old"));
    await mkdir(join(root, "new"));
    await writeFile(join(root, "old", "release.tar"), await packReleaseArtifact(files));
    await symlink(join(root, "old", "release.tar"), join(root, "new", "release.tar"));
    await assert.rejects(
      runSourceBuildCompatibility(bound, { artifactDirectory: root }),
      /artifact_path/,
    );
    await rm(join(root, "new", "release.tar"));
    await writeFile(join(root, "new", "release.tar"), Buffer.from("malformed archive"));
    await assert.rejects(runSourceBuildCompatibility(bound, { artifactDirectory: root }));
    await writeFile(join(root, "new", "release.tar"), await packReleaseArtifact(files));
    await assert.rejects(
      runSourceBuildCompatibility(
        { ...bound, scenarioDigest: hash("f") },
        { artifactDirectory: root },
      ),
      /scenario_changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scenarioPath, { force: true });
  }
});

test("actual single-Worker local artifacts preserve both versions and assets against isolated PostgreSQL", {
  skip: !process.env.HIVE_D10_SOURCE_BUILD_TEST_DATABASE_URL,
  timeout: 120000,
}, async () => {
  const { config, catalog, plan } = fixture(),
    root = await mkdtemp(join(tmpdir(), "hive-d10-source-live-test-"));
  const scenarioPath = `scripts/release/compatibility/source_live_${randomUUID().replaceAll("-", "")}.mjs`;
  const fixtureTable = `source_build_${randomUUID().replaceAll("-", "")}`;
  const noDatabaseScenarioPath = `scripts/release/compatibility/no_database_${randomUUID().replaceAll("-", "")}.mjs`;
  const scenario = Buffer.from(`import {execFileSync} from 'node:child_process';
const sql=(statement)=>execFileSync('/usr/bin/psql',[process.env.DATABASE_URL,'-X','-v','ON_ERROR_STOP=1','-c',statement],{stdio:'ignore'});
if(process.argv[2]==='prepare') sql("CREATE TABLE IF NOT EXISTS users (id uuid primary key,coder_url text not null,coder_user_id uuid not null,username text not null,email text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),terminal_controls_beyond_mobile boolean not null default false); CREATE TABLE IF NOT EXISTS sessions (id uuid primary key,session_id uuid not null unique,user_id uuid not null references users(id),expires_at timestamptz not null,created_at timestamptz not null default now()); CREATE TABLE IF NOT EXISTS coder_tokens (id uuid primary key,user_id uuid not null references users(id),credential_source text not null default 'legacy'); CREATE TABLE ${fixtureTable} (id int primary key, value text, added text); INSERT INTO ${fixtureTable} VALUES (1,'baseline','expanded')");
else { const oldIdentity=await (await fetch(process.env.HIVE_OLD_APP+'/isolation')).json(),newIdentity=await (await fetch(process.env.HIVE_NEW_APP+'/isolation')).json();if(oldIdentity.identity!==newIdentity.identity||oldIdentity.origin===newIdentity.origin)throw Error('old/new isolated identities differ');const encrypted=await (await fetch(process.env.HIVE_OLD_APP+'/encrypt',{method:'POST',body:'persisted-credential'})).text();if(!/^[a-f0-9]+$/.test(encrypted))throw Error('invalid encrypted row');const write=await fetch(process.env.HIVE_OLD_APP+'/db',{method:'POST',body:encrypted});if(!write.ok)throw Error('old app SQL write failed');const stored=await (await fetch(process.env.HIVE_NEW_APP+'/db')).text();if(await (await fetch(process.env.HIVE_NEW_APP+'/decrypt',{method:'POST',body:stored})).text()!=='persisted-credential')throw Error('new version cannot decrypt old row'); const created=await fetch(process.env.HIVE_OLD_APP+'/session',{method:'POST'});if(!created.ok)throw Error('old app session creation failed');const session=await created.json();const cookie={Cookie:session.cookie};const read=await fetch(process.env.HIVE_NEW_APP+'/session',{headers:cookie});if(!read.ok||(await read.json()).userId!==session.userId)throw Error('new app cannot read old session');const changed=await fetch(process.env.HIVE_NEW_APP+'/session',{method:'PATCH',headers:cookie});if(!changed.ok)throw Error('new app update failed');const reread=await fetch(process.env.HIVE_OLD_APP+'/session',{headers:cookie});if(!reread.ok||(await reread.json()).email!=='updated@example.invalid')throw Error('old app cannot read new update');const deleted=await fetch(process.env.HIVE_NEW_APP+'/session',{method:'DELETE',headers:cookie});if(!deleted.ok||(await fetch(process.env.HIVE_OLD_APP+'/session',{headers:cookie})).status!==404)throw Error('session revocation not shared'); for(const [origin,version] of [[process.env.HIVE_OLD_APP,'old'],[process.env.HIVE_NEW_APP,'new']]) { const r=await fetch(origin+'/version'); if(await r.text()!==version) throw Error('wrong local version'); const asset=await fetch(origin+'/proof.txt'); if(await asset.text()!=='asset-'+version) throw Error('missing local assets'); } sql("DO $$ BEGIN IF (SELECT count(*) FROM ${fixtureTable} WHERE added='expanded')<>1 THEN RAISE EXCEPTION 'invariant failed'; END IF; END $$"); }
`);
  const artifact = async (version) => {
    const build = join(root, `build-${version}`);
    await mkdir(join(build, "build/app"), { recursive: true });
    await mkdir(join(build, ".open-next/assets"), { recursive: true });
    await writeFile(
      join(build, "worker.ts"),
      `import {createNativeWorker} from ${JSON.stringify(resolve("deploy/cloudflare/native/composition.mjs"))};
import {createCloudflareDatabaseRequest} from ${JSON.stringify(resolve("packages/db/src/cloudflare.ts"))};
import {getDb} from ${JSON.stringify(resolve("packages/db/src/workerd.ts"))};
import {runRequestLifetime} from ${JSON.stringify(resolve("deploy/cloudflare/app/request-lifetime.ts"))};
import auth from ${JSON.stringify(resolve("deploy/cloudflare/auth/worker.ts"))};
import {createSession} from ${JSON.stringify(resolve("services/auth/src/auth/session.ts"))};
import {signCookie,verifyCookie} from ${JSON.stringify(resolve("packages/auth/src/index.ts"))};
const app={async fetch(request,env){
 if(env.HIVE_NATIVE_MODE!=='preview'||env.HIVE_NATIVE_PRODUCTION_ACTIVE!=='false'||env.HIVE_PREVIEW_ACCESS_REQUIRED!=='false'||env.HIVE_PREVIEW_ORIGIN!==new URL(request.url).origin||env.HIVE_PUBLIC_ORIGIN!==new URL(request.url).origin||!env.AUTH_SERVICE_SECRET||!env.ENCRYPTION_KEY||!env.COOKIE_SECRET||env.HIVE_DELIVERY_DATABASE_ENABLED!=='false'||env.HIVE_DELIVERY_RELEASE_ENABLED!=='false')return new Response('invalid isolated native bindings',{status:500});
 const path=new URL(request.url).pathname;
 if(path==='/db'){if(request.method==='POST'){await getDb().$executeRawUnsafe('UPDATE ${fixtureTable} SET value=$1 WHERE id=1',await request.text());return new Response('stored')}return new Response((await getDb().$queryRawUnsafe('SELECT value FROM ${fixtureTable} WHERE id=1'))[0].value)}
 if(path==='/session'){
  if(request.method==='POST'){const user=await getDb().user.create({data:{coderUrl:env.CODER_URL,coderUserId:crypto.randomUUID(),username:'compatibility',email:'initial@example.invalid'}});const id=await createSession(user.id);return Response.json({userId:user.id,cookie:'__Host-hive-session='+signCookie(id,env.COOKIE_SECRET)})}
  const signed=verifyCookie((request.headers.get('Cookie')??'').slice('__Host-hive-session='.length),env.COOKIE_SECRET);if(!signed)return new Response('invalid cookie',{status:401});
  const read=await env.AUTH_SERVICE.fetch('https://auth.internal/sessions/'+signed.sessionId,{headers:{Authorization:'Bearer '+env.AUTH_SERVICE_SECRET}});if(!read.ok||request.method==='GET')return read;
  const session=await read.json();if(request.method==='PATCH'){await getDb().user.update({where:{id:session.userId},data:{email:'updated@example.invalid'}});return new Response('updated')}
  return env.AUTH_SERVICE.fetch('https://auth.internal/logout',{method:'POST',headers:{Authorization:'Bearer '+env.AUTH_SERVICE_SECRET,'Content-Type':'application/json'},body:JSON.stringify({sessionId:signed.sessionId})});
 }
 const hex=(bytes)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 const bytes=(text)=>new Uint8Array(text.match(/../g).map(v=>parseInt(v,16)));
 if(path==='/isolation')return Response.json({origin:env.HIVE_PUBLIC_ORIGIN,identity:hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode([env.AUTH_SERVICE_SECRET,env.ENCRYPTION_KEY,env.COOKIE_SECRET,env.HIVE_CODER_OAUTH_CLIENT_SECRET].join(':'))))});
 if(path==='/encrypt'||path==='/decrypt'){
  const key=await crypto.subtle.importKey('raw',bytes(env.ENCRYPTION_KEY),'AES-GCM',false,['encrypt','decrypt']);
  if(path==='/encrypt'){const iv=crypto.getRandomValues(new Uint8Array(12));return new Response(hex(iv)+hex(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(await request.text()))));}
  const input=await request.text();return new Response(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(input.slice(0,24))},key,bytes(input.slice(24))));
 }
 return path==='/version'?new Response('${version}'):env.ASSETS.fetch(request);
}};const scoped={fetch(request,env,context){const database=createCloudflareDatabaseRequest(env.DATABASE_URL);return runRequestLifetime(database,context,()=>app.fetch(request,env))}};export default createNativeWorker({app:scoped,auth,jobs:{scheduled(){throw Error('Production scheduling must stay disabled')}}});`,
    );
    await writeFile(
      join(build, "wrangler.json"),
      JSON.stringify({
        name: `compatibility-${version}`,
        main: "worker.ts",
        compatibility_date: config.compatibilityDate,
        compatibility_flags: ["nodejs_compat"],
      }),
    );
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--config",
        join(build, "wrangler.json"),
        "--outdir",
        join(build, "build/app"),
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, HOME: build, WRANGLER_SEND_METRICS: "false" },
        stdio: "ignore",
        timeout: 60000,
      },
    );
    await writeFile(join(build, ".open-next/assets/proof.txt"), Buffer.from(`asset-${version}`));
    await packSourceBuild(build);
    const bytes = await readFile(join(build, "release.tar")),
      files = await readReleaseArtifact(bytes, { topology: "single" });
    return { bytes, digest: artifactDigest(files, "app") };
  };
  await mkdir("scripts/release/compatibility", { recursive: true });
  await writeFile(scenarioPath, scenario);
  try {
    const old = await artifact("old"),
      next = await artifact("new");
    for (const [label, archive] of [
      ["old", old],
      ["new", next],
    ]) {
      await mkdir(join(root, label));
      await writeFile(join(root, label, "release.tar"), archive.bytes);
    }
    const actual = {
      ...config,
      scenarioPath,
      scenarioDigest: createHash("sha256").update(scenario).digest("hex"),
    };
    const result = await runSourceBuildCompatibility(actual, {
      artifactDirectory: root,
      fixtureDatabaseUrl: process.env.HIVE_D10_SOURCE_BUILD_TEST_DATABASE_URL,
    });
    assert.equal(result.kind, "automatic-source-build");
    assert.equal(result.applicationDatabase.transport, "isolated-neon-websocket");
    assert.ok(result.applicationDatabase.queries.every((count) => count > 0));
    assert.notEqual(old.digest, next.digest);
    assert.equal(result.oldAppDigest, old.digest);
    assert.equal(result.newAppDigest, next.digest);
    assert.deepEqual(result.sourceBuild, {
      baseline: actual.baseline,
      candidate: actual.candidate,
      artifactMeaning: "local-compatibility-test",
    });
    assert.equal(result.catalogDigest, digest(actual));
    const actualCatalog = {
        ...catalog,
        compatibilityTest: { ...catalog.compatibilityTest, config: actual },
      },
      intent = {
        catalogId: catalog.id,
        ownerId: catalog.ownerId,
        taskId: randomUUID(),
        sourceSha: plan.sourceSha,
        dispatchId: randomUUID(),
        planIntent: sourcePlanIntent(plan),
      },
      approval = deriveSourceBuildApproval(actualCatalog, intent, result.actualSourceBuild);
    assert.equal(approval.plan.oldAppDigest, old.digest);
    assert.equal(approval.plan.newAppDigest, next.digest);
    assert.deepEqual(sourcePlanIntent(approval.plan), catalog.automaticPlan);
    assert.equal(
      approval.compatibility.actualSourceBuild.oldArchiveDigest,
      createHash("sha256").update(old.bytes).digest("hex"),
    );
    const noDatabaseScenario = Buffer.from(
      "if(process.argv[2]==='verify')for(const origin of [process.env.HIVE_OLD_APP,process.env.HIVE_NEW_APP]){const response=await fetch(origin+'/version');if(!response.ok)throw Error('fixture failed')}\n",
    );
    await writeFile(noDatabaseScenarioPath, noDatabaseScenario);
    await assert.rejects(
      runSourceBuildCompatibility(
        {
          ...actual,
          scenarioPath: noDatabaseScenarioPath,
          scenarioDigest: createHash("sha256").update(noDatabaseScenario).digest("hex"),
        },
        {
          artifactDirectory: root,
          fixtureDatabaseUrl: process.env.HIVE_D10_SOURCE_BUILD_TEST_DATABASE_URL,
        },
      ),
      /application_database_unverified/,
    );

    for (const changed of [
      { ...result.actualSourceBuild, intentDigest: hash("0") },
      { ...result.actualSourceBuild, recipeSha: sha("0") },
      { ...result.actualSourceBuild, configDigest: hash("0") },
    ])
      assert.throws(() => deriveSourceBuildApproval(actualCatalog, intent, changed));
    assert.throws(() =>
      deriveSourceBuildApproval(
        actualCatalog,
        { ...intent, planIntent: { ...intent.planIntent, expandSql: ["DROP TABLE unrelated"] } },
        result.actualSourceBuild,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scenarioPath, { force: true });
    await rm(noDatabaseScenarioPath, { force: true });
  }
});
