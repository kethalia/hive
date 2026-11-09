// Actual workerd/SQLite + unchanged PrismaNeon/PostgreSQL. Host/provider actions
// are fixed synthetic responses; this is not live guardian or model acceptance.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { tsImport } from "tsx/esm/api";
import { compatibilityDatabaseTransport } from "../../../services/migrate/src/delivery/compatibility-ws.mjs";

const url = process.env.HIVE_TASK_WAKE_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
  assert.equal(target.pathname, "/hive_d10_test_project_wake_20261109");
}
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = await import(
  pathToFileURL(
    require.resolve("miniflare", { paths: [dirname(require.resolve("wrangler/package.json"))] }),
  ).href
);
const { PrismaClient } = await tsImport("../../../packages/db/src/index.ts", import.meta.url);
const intentModule = await tsImport(
  "../../../src/lib/projects/task-intents.server.ts",
  import.meta.url,
);
const { ProjectTaskIntents } = intentModule.default ?? intentModule;
const key = "a".repeat(64);
async function fixture(t, { pilot = true } = {}) {
  const db = new PrismaClient({ datasourceUrl: url });
  t.after(() => db.$disconnect());
  const user = await db.user.create({
    data: {
      coderUrl: "https://fixture.invalid",
      coderUserId: randomUUID(),
      username: "wake-fixture",
      email: "fixture@example.invalid",
    },
  });
  const project = await db.deliveryProject.create({
    data: {
      ownerId: user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/wake",
    },
  });
  const identity = { ownerId: user.id, projectId: project.id, taskId: randomUUID() },
    workspaceId = randomUUID(),
    requestId = randomUUID();
  const payload = {
    ...identity,
    workspaceId,
    requestId,
    requestDigest: "b".repeat(64),
    hostRequest: {
      schemaVersion: 1,
      projectId: project.id,
      taskId: identity.taskId,
      requestId,
      repositoryId: "123",
      expectedAccountId: "456",
      revision: "a".repeat(40),
      model: "fixture",
      effort: "high",
      text: "synthetic private task",
    },
  };
  const enrollment = pilot
    ? identity
    : { ownerId: randomUUID(), projectId: randomUUID(), taskId: randomUUID() };
  const binding = {
    coderOrigin: user.coderUrl,
    workspaceId,
    agentId: randomUUID(),
    buildId: randomUUID(),
  };
  const store = new ProjectTaskIntents(db, key);
  const directory = await mkdtemp(join(tmpdir(), "hive-task-wake-pg-"));
  const transport = await compatibilityDatabaseTransport(url, {
    knownTrustFixture: !new URL(url).password,
  });
  t.after(() => transport.close());
  // Reproduce the framework/custom-Worker split with two independent bundles.
  const frameworkPath = `${directory}/framework.mjs`;
  const framework = await build({
    stdin: {
      contents: `export {readTaskWake} from ${JSON.stringify(resolve("src/lib/projects/task-wake.server.ts"))};`,
      loader: "ts",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["node:*"],
  });
  const wasm = new Map();
  const compiled = await build({
    stdin: {
      contents: `
    import {readTaskWake as frameworkRead} from ${JSON.stringify(frameworkPath)};
    import {ProjectTaskWake as Base} from ${JSON.stringify(resolve("deploy/cloudflare/native/project-task-wake.mjs"))};
    import {withTaskWakeEnvironment,readTaskWake} from ${JSON.stringify(resolve("src/lib/projects/task-wake.server.ts"))};
    import {reconcileProjectTasks} from ${JSON.stringify(resolve("src/lib/projects/task.server.ts"))};
    import {createCloudflareDatabaseRequest} from '@hive/db/cloudflare';
    import {runExactProjectTaskWake} from ${JSON.stringify(resolve("deploy/cloudflare/app/project-tasks.ts"))};
    export class ProjectTaskWake extends Base {
      tick(){return this.alarm()}
      fixtureState(){return JSON.parse(this.ctx.storage.sql.exec('SELECT state FROM wake WHERE id=1').one().state)}
      fixtureWrite(value){this.ctx.storage.sql.exec('UPDATE wake SET state=? WHERE id=1',JSON.stringify(value))}
    }
    export default {async fetch(request,env){return withTaskWakeEnvironment(env,async()=>{
      const input=await request.json(), identity=JSON.parse(env.HIVE_FIXTURE_TASK_IDENTITY), enrolled=JSON.parse(env.HIVE_PROJECT_TASK_WAKE_TASK_JSON);
      const stub=env.HIVE_PROJECT_TASK_WAKE.getByName('project-task/v1/'+enrolled.ownerId+'/'+enrolled.taskId);
      if(input.operation==='reserve')return Response.json(await readTaskWake(enrolled,true));
      if(input.operation==='cross-bundle')return Response.json(await frameworkRead(enrolled));
      if(input.operation==='state')return Response.json(await stub.fixtureState());
      if(input.operation==='write'){await stub.fixtureWrite(input.state);return Response.json({ok:true})}
      if(input.operation==='tick'){await stub.tick();return Response.json({ok:true})}
      if(input.operation==='short-attempt'){const state=await stub.fixtureState();try{const result=await runExactProjectTaskWake(env,{...state,inFlightUntil:Date.now()+500});return Response.json({held:false,phase:result.phase})}catch{return Response.json({held:true})}}
      if(input.operation==='browser'){
        const database=createCloudflareDatabaseRequest(env.DATABASE_URL,{queryTimeoutMillis:5000,transactionTimeoutMillis:5000,connectionTimeoutMillis:5000});
        return database.run(async()=>{try{return Response.json(await reconcileProjectTasks({ownerId:identity.ownerId,taskId:identity.taskId},1))}finally{await database.close()}})
      }
      return new Response(null,{status:404});
    })}};`,
      loader: "ts",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    conditions: ["workerd", "worker", "browser"],
    target: "es2022",
    external: ["node:*", "cloudflare:*", frameworkPath],
    banner: {
      js: 'import {createRequire as fixtureRequire} from "node:module";const require=fixtureRequire("/");',
    },
    define: { "import.meta.url": '"file:///hive-wake-fixture.mjs"' },
    plugins: [
      {
        name: "synthetic-host-only",
        setup(b) {
          b.onResolve({ filter: /(?:^\.\/host\.server$|\/projects\/host\.server$)/ }, () => ({
            path: "host",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `import {env} from 'cloudflare:workers'; export async function signedHostProjectRequest(user,workspaceId,path,payload,options){options?.signal?.throwIfAborted(); const r=await env.HOST_FIXTURE.fetch('https://synthetic.invalid/host',{method:'POST',body:JSON.stringify({ownerId:user.id,workspaceId,path,projectId:payload.projectId,taskId:payload.taskId})});if(!r.ok)throw Error('synthetic_ack_lost');return r.json()}`,
            loader: "js",
          }));
          b.onResolve(
            {
              filter:
                /^@\/lib\/(?:coder\/user-client|codex-session\/(?:registered-session|registration|bootstrap-delivery)\.server)$/,
            },
            (args) =>
              args.importer.endsWith("task.server.ts")
                ? { path: "registration", namespace: "fixture-registration" }
                : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "fixture-registration" }, () => ({
            loader: "js",
            contents: `
            import {env} from 'cloudflare:workers';
            export async function getCoderClientForUser(){return {fixture:true}}
            export function registeredSessionConfig(){return {}}
            export function createRegisteredSessionService(){return {authority:{fixture:true}}}
            export async function resolveVerifiedWorkspaceHost(){return {binding:JSON.parse(env.HIVE_FIXTURE_BINDING)}}
            export async function provisionRegisteredHost(authority,coder,principal,workspaceId,agentId,projectIds){
              const response=await env.REGISTRATION_FIXTURE.fetch('https://synthetic.invalid/register',{method:'POST',body:JSON.stringify({principal,workspaceId,agentId,projectIds})});
              if(!response.ok)throw Error('synthetic_registration_rejected');
            }
          `,
          }));
          b.onResolve({ filter: /\.wasm(?:\?module)?$/ }, (args) => {
            const path = resolve(args.resolveDir, args.path.replace(/\?module$/, ""));
            wasm.set(path, readFile(path));
            return { path, external: true };
          });
        },
      },
    ],
  });
  let hostCalls = 0,
    statusCalls = 0,
    startCalls = 0,
    registrations = 0,
    registrationLost = false,
    deferRepair = false,
    effects = 0,
    loseAck = false,
    waitHost;
  const seen = new Set();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: "wake",
          modulesRoot: "/",
          modules: [
            {
              type: "ESModule",
              path: `${directory}/worker.mjs`,
              contents: compiled.outputFiles[0].text,
            },
            { type: "ESModule", path: frameworkPath, contents: framework.outputFiles[0].text },
            ...(await Promise.all(
              [...wasm].map(async ([path, bytes]) => ({
                type: "CompiledWasm",
                path,
                contents: await bytes,
              })),
            )),
          ],
          compatibilityDate: "2026-10-29",
          compatibilityFlags: ["nodejs_compat"],
          outboundService: "database-only",
          durableObjects: {
            HIVE_PROJECT_TASK_WAKE: { className: "ProjectTaskWake", useSQLite: true },
          },
          bindings: {
            DATABASE_URL: url,
            ENCRYPTION_KEY: key,
            HIVE_RUNTIME_TARGET: "cloudflare",
            HIVE_PROJECT_TASKS_ENABLED: "true",
            HIVE_NATIVE_MODE: "preview",
            HIVE_NATIVE_PREVIEW_ENABLED: "true",
            HIVE_PROJECT_TASK_WAKE_ENABLED: "true",
            HIVE_PROJECT_TASK_WAKE_TASK_JSON: JSON.stringify(enrollment),
            HIVE_FIXTURE_TASK_IDENTITY: JSON.stringify(identity),
            HIVE_FIXTURE_BINDING: JSON.stringify(binding),
          },
          serviceBindings: {
            REGISTRATION_FIXTURE: async (request) => {
              const body = await request.json();
              assert.equal(body.principal.hiveUserId, user.id);
              assert.equal(body.principal.coderUserId, user.coderUserId);
              assert.equal(body.workspaceId, workspaceId);
              assert.equal(body.agentId, binding.agentId);
              assert.deepEqual(body.projectIds, [project.id]);
              registrations++;
              if (deferRepair) deferRepair = false;
              else registrationLost = false;
              return Response.json({ registered: true });
            },
            HOST_FIXTURE: async (request) => {
              const body = await request.json();
              assert.equal(body.ownerId, identity.ownerId);
              assert.equal(body.workspaceId, workspaceId);
              assert.equal(body.taskId, identity.taskId);
              assert.ok(["/projects/tasks/start", "/projects/tasks/status"].includes(body.path));
              hostCalls++;
              if (body.path === "/projects/tasks/status") statusCalls++;
              else startCalls++;
              if (body.path === "/projects/tasks/start" && !seen.has(body.taskId)) {
                seen.add(body.taskId);
                effects++;
              }
              if (waitHost) await waitHost;
              if (loseAck) {
                loseAck = false;
                return new Response(null, { status: 503 });
              }
              return Response.json({
                schemaVersion: 1,
                projectId: project.id,
                taskId: identity.taskId,
                phase:
                  body.path === "/projects/tasks/status" && registrationLost
                    ? "awaitingRegistration"
                    : "running",
                nativeThreadId: "synthetic-thread",
                terminalSessionName: null,
                reason: null,
              });
            },
          },
        },
        {
          name: "database-only",
          modules: true,
          script: transport.route(0),
          compatibilityDate: "2026-10-29",
          compatibilityFlags: ["nodejs_compat"],
        },
      ],
    }),
  );
  t.after(async () => {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await mf.ready;
  async function call(operation, data = {}) {
    const response = await mf.dispatchFetch("https://local.invalid/fixture", {
      method: "POST",
      body: JSON.stringify({ operation, ...data }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function due() {
    const state = await call("state");
    await call("write", { state: { ...state, nextWake: Date.now() - 1, inFlightUntil: 0 } });
  }
  return {
    db,
    store,
    user,
    project,
    identity,
    payload,
    call,
    due,
    transport,
    hostCalls: () => hostCalls,
    effects: () => effects,
    startCalls: () => startCalls,
    statusCalls: () => statusCalls,
    registrations: () => registrations,
    loseRegistration: (defer = false) => {
      registrationLost = true;
      deferRepair = defer;
    },
    loseAck: () => {
      loseAck = true;
    },
    block: (value) => {
      waitHost = value;
    },
  };
}

test("actual SQLite alarm arms before PG visibility and hands off the exact encrypted intent without browser polling", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const reserved = await f.call("reserve");
  const crossBundle = await f.call("cross-bundle");
  assert.equal(crossBundle.deadline, reserved.deadline);
  assert.equal(crossBundle.ownerId, f.identity.ownerId);
  await f.due();
  await f.call("tick");
  assert.equal(f.hostCalls(), 0); // reserve -> crash, no visible row
  await f.store.enqueue(f.payload, reserved.deadline);
  let release;
  f.block(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  t.after(() => release());
  await f.due();
  // The actual platform alarm is already armed; no post-commit notification.
  for (let n = 0; n < 160 && f.effects() === 0; n++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.effects(), 1);
  // The synthetic effect precedes its ACK and the PostgreSQL finish commit.
  const beforeAck = await f.db.projectTaskIntent.findUniqueOrThrow({
    where: { id: f.identity.taskId },
  });
  assert.equal(beforeAck.phase, "queued");
  release();
  let settled = await f.call("state");
  for (let n = 0; n < 160 && settled.phase === "active"; n++) {
    await new Promise((r) => setTimeout(r, 50));
    settled = await f.call("state");
  }
  assert.equal(settled.phase, "running");
  const row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.phase, "running");
  const queries = f.transport.counts[0].queries;
  await f.call("tick");
  await f.call("tick");
  assert.equal(f.transport.counts[0].queries, queries);
  assert.equal(f.effects(), 1);
  const state = JSON.stringify(await f.call("state"));
  assert.ok(!state.includes(f.payload.hostRequest.text));
  assert.ok(!state.includes(key));
});
test("concurrent browser/alarm and unknown host ACK use the same PG lease and idempotent task identity", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const r = await f.call("reserve");
  await f.store.enqueue(f.payload, r.deadline);
  await f.due();
  let release;
  f.block(
    new Promise((r) => {
      release = r;
    }),
  );
  f.loseAck();
  const alarm = f.call("tick");
  for (let n = 0; n < 80 && !f.hostCalls(); n++) await new Promise((r) => setTimeout(r, 10));
  await f.call("browser");
  assert.equal(f.hostCalls(), 1);
  release();
  await alarm;
  let row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.failureCount, 1);
  await f.db.projectTaskIntent.update({
    where: { id: row.id },
    data: { nextAttemptAt: new Date(0) },
  });
  await f.due();
  await f.call("tick");
  row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(row.phase, "running");
  assert.equal(f.effects(), 1);
  assert.equal(f.hostCalls(), 2);
});
test("late visible commit is held by the browser path and never dispatched", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  await f.call("reserve");
  const old = await f.call("state");
  const createdAt = Date.now() - 1800001;
  await f.call("write", { state: { ...old, createdAt, deadline: createdAt + 1800000 } });
  await f.call("tick");
  await f.store.enqueue(f.payload);
  await f.call("browser");
  const row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.phase, "blocked");
  assert.equal(row.status.reason, "preparation_timeout");
  assert.equal(f.hostCalls(), 0);
});
test("post-write expiry rolls back enqueue and expired leases are reclaimed without another task", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.enqueue(f.payload, Date.now() - 1));
  assert.equal(await f.db.projectTaskIntent.count({ where: { id: f.identity.taskId } }), 0);
  const delayedStore = new ProjectTaskIntents(f.db, key, undefined, async (tx) => {
    await tx.$queryRaw`SELECT 1 AS value FROM pg_sleep(0.35)`;
  });
  await assert.rejects(delayedStore.enqueue(f.payload, Date.now() + 150));
  assert.equal(await f.db.projectTaskIntent.count({ where: { id: f.identity.taskId } }), 0);
  const r = await f.call("reserve");
  await f.store.enqueue(f.payload, r.deadline);
  const claim = await f.store.claim({ ownerId: f.user.id, taskId: f.identity.taskId });
  assert.ok(claim);
  await f.db.projectTaskIntent.update({
    where: { id: f.identity.taskId },
    data: { leaseUntil: new Date(0) },
  });
  await f.due();
  await f.call("tick");
  assert.equal(f.effects(), 1);
});
test("actual PG maintenance admission and changed repository ownership never reach the host", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const r = await f.call("reserve");
  await f.store.enqueue(f.payload, r.deadline);
  await f.db.codexHostSlot.create({
    data: {
      ownerId: f.user.id,
      coderOrigin: f.user.coderUrl,
      coderOwnerId: f.user.coderUserId,
      workspaceId: f.payload.workspaceId,
      agentId: randomUUID(),
      accountMaintenance: {
        schemaVersion: 1,
        purpose: "account-maintenance",
        ownerId: f.user.id,
        coderOrigin: f.user.coderUrl,
        coderOwnerId: f.user.coderUserId,
        workspaceId: f.payload.workspaceId,
        phase: "requested",
      },
    },
  });
  await f.due();
  await f.call("tick");
  assert.equal(f.hostCalls(), 0);
  const g = await fixture(t);
  const s = await g.call("reserve");
  await g.store.enqueue(g.payload, s.deadline);
  await g.db.deliveryProject.update({
    where: { id: g.project.id },
    data: { providerAccountId: "999" },
  });
  await g.due();
  await g.call("tick");
  assert.equal(g.hostCalls(), 0);
});

test("cancelled setup retains the exact unknown lease and closes its independent DB lifetime", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const r = await f.call("reserve");
  await f.store.enqueue(f.payload, r.deadline);
  f.block(new Promise((resolve) => setTimeout(resolve, 900)));
  const result = await f.call("short-attempt");
  assert.equal(result.held, true);
  const row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.phase, "queued");
  assert.ok(row.leaseId);
  assert.ok(row.leaseUntil.getTime() > Date.now());
  assert.equal(f.effects(), 1);
  await f.call("browser");
  assert.equal(f.hostCalls(), 1);
});

test("foreign-owner intent with the same task ID stays invisible to the enrolled task", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t),
    g = await fixture(t);
  await f.call("reserve");
  const foreign = {
    ...g.payload,
    taskId: f.identity.taskId,
    hostRequest: { ...g.payload.hostRequest, taskId: f.identity.taskId },
  };
  await g.store.enqueue(foreign);
  await f.due();
  await f.call("tick");
  assert.equal(f.hostCalls(), 0);
  assert.equal(g.hostCalls(), 0);
  const row = await g.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.ownerId, g.user.id);
  assert.equal(row.phase, "queued");
  assert.equal(row.leaseId, null);
});

test("browser-first dispatch succeeds before the alarm with one effect and no failure/backoff", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const reserved = await f.call("reserve");
  // Keep the real alarm armed while ensuring the browser wins even on slow CI.
  await f.call("write", { state: { ...reserved, nextWake: Date.now() + 60000 } });
  await f.store.enqueue(f.payload, reserved.deadline);
  assert.equal((await f.call("state")).attempts, 0);
  const result = await f.call("browser");
  assert.equal(result.processed, 1);
  assert.equal(result.retry, 0);
  assert.equal(f.hostCalls(), 1);
  assert.equal(f.effects(), 1);
  const row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.phase, "running");
  assert.equal(row.failureCount, 0);
  assert.equal(row.leaseId, null);
  await f.due();
  await f.call("tick");
  assert.equal((await f.call("state")).phase, "running");
  assert.equal(f.effects(), 1);
  assert.equal(f.hostCalls(), 1);
});

test("terminal handoff preserves browser-only status and repeated lost-registration repair", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const reserved = await f.call("reserve");
  await f.call("write", { state: { ...reserved, nextWake: Date.now() + 60000 } });
  await f.store.enqueue(f.payload, reserved.deadline);
  await f.call("browser");
  await f.due();
  await f.call("tick");
  assert.equal((await f.call("state")).phase, "running");
  f.loseRegistration(true);
  await f.db.projectTaskIntent.update({
    where: { id: f.identity.taskId },
    data: { nextAttemptAt: new Date(0) },
  });
  assert.equal((await f.call("browser")).processed, 1);
  let row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.phase, "preparing");
  assert.equal(row.status.phase, "awaitingRegistration");
  assert.equal(row.ciphertext, null);
  await f.db.projectTaskIntent.update({
    where: { id: f.identity.taskId },
    data: { nextAttemptAt: new Date(0) },
  });
  assert.equal((await f.call("browser")).processed, 1);
  row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.phase, "running");
  assert.equal(row.status.nativeThreadId, "synthetic-thread");
  assert.equal(f.registrations(), 2);
  assert.equal(f.startCalls(), 1);
  assert.equal(f.effects(), 1);
  assert.equal(f.statusCalls(), 4);
  const queries = f.transport.counts[0].queries;
  await f.call("tick");
  assert.equal(f.transport.counts[0].queries, queries);
});
test("preparation deadline after handoff does not expire browser metadata repair", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const reserved = await f.call("reserve");
  await f.call("write", { state: { ...reserved, nextWake: Date.now() + 60000 } });
  await f.store.enqueue(f.payload, reserved.deadline);
  await f.call("browser");
  await f.due();
  await f.call("tick");
  const state = await f.call("state"),
    createdAt = Date.now() - 1800001;
  await f.call("write", { state: { ...state, createdAt, deadline: createdAt + 1800000 } });
  f.loseRegistration(true);
  await f.db.projectTaskIntent.update({
    where: { id: f.identity.taskId },
    data: { nextAttemptAt: new Date(0) },
  });
  assert.equal((await f.call("browser")).processed, 1);
  const pending = await f.db.projectTaskIntent.findUniqueOrThrow({
    where: { id: f.identity.taskId },
  });
  assert.equal(pending.phase, "preparing");
  assert.equal(pending.status.phase, "awaitingRegistration");
  await f.db.projectTaskIntent.update({
    where: { id: f.identity.taskId },
    data: { nextAttemptAt: new Date(0) },
  });
  assert.equal((await f.call("browser")).processed, 1);
  assert.equal(f.registrations(), 2);
  assert.equal(f.startCalls(), 1);
  assert.equal(f.effects(), 1);
  const row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.phase, "running");
  assert.equal(row.failureCount, 0);
});
test("valid nonpilot exact-task reconciliation keeps baseline and never contacts the pilot object", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t, { pilot: false });
  const reserved = await f.call("reserve");
  const state = { ...reserved, nextWake: Date.now() + 60000 };
  await f.call("write", { state });
  await f.store.enqueue(f.payload);
  assert.equal((await f.call("browser")).processed, 1);
  assert.equal(f.effects(), 1);
  assert.deepEqual(await f.call("state"), state);
});

test("terminal handoff cannot authorize a contradictory queued prompt", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t),
    reserved = await f.call("reserve");
  await f.call("write", { state: { ...reserved, phase: "running", nextWake: Date.now() + 60000 } });
  await f.store.enqueue(f.payload);
  const result = await f.call("browser");
  assert.equal(result.processed, 0);
  assert.equal(f.startCalls(), 0);
  assert.equal(f.effects(), 0);
  const row = await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } });
  assert.equal(row.phase, "queued");
  assert.ok(row.ciphertext);
});

test("delayed alarm preserves prior handoff through awaitingRegistration and expired preparation", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t),
    reserved = await f.call("reserve");
  await f.call("write", { state: { ...reserved, nextWake: Date.now() + 60000 } });
  await f.store.enqueue(f.payload, reserved.deadline);
  assert.equal((await f.call("browser")).processed, 1);
  assert.equal((await f.call("state")).phase, "active");
  f.loseRegistration(true);
  await f.db.projectTaskIntent.update({
    where: { id: f.identity.taskId },
    data: { nextAttemptAt: new Date(0) },
  });
  assert.equal((await f.call("browser")).processed, 1);
  const pending = await f.db.projectTaskIntent.findUniqueOrThrow({
    where: { id: f.identity.taskId },
  });
  assert.equal(pending.phase, "preparing");
  assert.equal(pending.status.phase, "awaitingRegistration");
  assert.equal(pending.status.nativeThreadId, "synthetic-thread");
  assert.equal(pending.ciphertext, null);
  assert.equal((await f.call("state")).phase, "active");
  // An active autonomous attempt observes durable handoff without status/repair work.
  assert.deepEqual(await f.call("short-attempt"), { held: false, phase: "running" });
  assert.equal(f.registrations(), 1);
  assert.equal(f.statusCalls(), 2);
  const createdAt = Date.now() - 1800001;
  await f.call("write", {
    state: { ...(await f.call("state")), createdAt, deadline: createdAt + 1800000 },
  });
  await f.call("tick");
  assert.equal((await f.call("state")).phase, "held");
  await f.store.holdWake(f.user.id, f.identity.taskId);
  assert.equal(
    (await f.db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.identity.taskId } })).phase,
    "preparing",
  );
  await f.db.projectTaskIntent.update({
    where: { id: f.identity.taskId },
    data: { nextAttemptAt: new Date(0) },
  });
  assert.equal((await f.call("browser")).processed, 1);
  const repaired = await f.db.projectTaskIntent.findUniqueOrThrow({
    where: { id: f.identity.taskId },
  });
  assert.equal(repaired.phase, "running");
  assert.equal(repaired.failureCount, 0);
  assert.equal(f.registrations(), 2);
  assert.equal(f.startCalls(), 1);
  assert.equal(f.effects(), 1);
  assert.equal((await f.call("state")).phase, "held");
  const queries = f.transport.counts[0].queries;
  await f.call("tick");
  assert.equal(f.transport.counts[0].queries, queries);
});
