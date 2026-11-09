// Real SQLite alarms + actual PrismaNeon/PostgreSQL + split framework request ALS.
// Zero push subscriptions. No provider request or push delivery is performed.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { tsImport } from "tsx/esm/api";
import { compatibilityDatabaseTransport } from "../../../services/migrate/src/delivery/compatibility-ws.mjs";

const url = process.env.HIVE_AGENT_WAKE_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  assert.equal(target.hostname, "127.0.0.1");
  assert.match(target.pathname, /^\/hive_f07_agent_wake_[a-z0-9_]+$/);
}
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = await import(
  pathToFileURL(
    require.resolve("miniflare", { paths: [dirname(require.resolve("wrangler/package.json"))] }),
  ).href
);
const { PrismaClient } = await tsImport("../../../packages/db/src/index.ts", import.meta.url);
async function fixture(t) {
  const db = new PrismaClient({ datasourceUrl: url });
  let closeRuntime = async () => {};
  let ownerId;
  t.after(async () => {
    try {
      await closeRuntime();
    } finally {
      if (ownerId) await db.user.deleteMany({ where: { id: ownerId } });
      await db.$disconnect();
    }
  });
  const coderOrigin = "https://coder.notification-wake.invalid",
    token = randomBytes(32).toString("hex");
  const user = await db.user.create({
    data: {
      coderUrl: coderOrigin,
      coderUserId: randomUUID(),
      username: "wake-proof",
      email: `${randomUUID()}@example.invalid`,
    },
  });
  ownerId = user.id;
  const source = await db.notificationSource.create({
    data: {
      id: randomUUID(),
      userId: user.id,
      workspaceId: randomUUID(),
      workspaceName: "synthetic-software",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    },
  });
  const identity = { ownerId: user.id, sourceId: source.id, eventKey: "exact-event" };
  const directory = await mkdtemp(join(tmpdir(), "hive-agent-wake-pg-"));
  const transport = await compatibilityDatabaseTransport(url, {
    knownTrustFixture: !new URL(url).password,
  });
  closeRuntime = async () => {
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  };
  const frameworkPath = `${directory}/framework.mjs`;
  const base = {
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    conditions: ["workerd", "worker", "browser"],
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    define: { "import.meta.url": '"file:///hive-agent-wake.mjs"' },
    banner: {
      js: 'import {createRequire as fixtureRequire} from "node:module";const require=fixtureRequire("/");',
    },
  };
  const wasm = new Map();
  const plugin = {
    name: "actual-prisma-wasm",
    setup(b) {
      b.onResolve({ filter: /\.wasm(?:\?module)?$/ }, (args) => {
        const path = resolve(args.resolveDir, args.path.replace(/\?module$/, ""));
        wasm.set(path, readFile(path));
        return { path, external: true };
      });
    },
  };
  const framework = await build({
    ...base,
    plugins: [plugin],
    stdin: {
      contents: `export { cloudflareAgentEventRoute as POST } from ${JSON.stringify(resolve("src/lib/push/agent-events-route.ts"))};`,
      loader: "ts",
      resolveDir: process.cwd(),
    },
  });
  const compiled = await build({
    ...base,
    external: [...base.external, frameworkPath],
    plugins: [plugin],
    stdin: {
      loader: "ts",
      resolveDir: process.cwd(),
      contents: `
    import {POST} from ${JSON.stringify(frameworkPath)};
    import {createAppWorker} from ${JSON.stringify(resolve("deploy/cloudflare/app/composition.ts"))};
    import {AgentNotificationWake as Base} from ${JSON.stringify(resolve("deploy/cloudflare/native/agent-notification-wake.mjs"))};
    import {withAgentWakeEnvironment} from ${JSON.stringify(resolve("src/lib/push/agent-event-wake.server.ts"))};
    import {dispatchScheduled} from ${JSON.stringify(resolve("deploy/cloudflare/jobs/worker.ts"))};
    export class AgentNotificationWake extends Base {
      tick(){return this.alarm()}
      fixtureState(){return JSON.parse(this.ctx.storage.sql.exec('SELECT state FROM wake WHERE id=1').one().state)}
      fixtureWrite(value){this.ctx.storage.sql.exec('UPDATE wake SET state=? WHERE id=1',JSON.stringify(value))}
    }
    const app=createAppWorker({fetch:r=>POST(r)},{schemaVersion:1,actions:{}});
    export default {async fetch(request,env,ctx){
      const input=await request.json(), identity=JSON.parse(env.HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON);
      const stub=env.HIVE_AGENT_NOTIFICATION_WAKE.getByName('agent-notification/v1/'+identity.ownerId+'/'+identity.sourceId+'/'+identity.eventKey);
      if(input.operation==='accept') return app.fetch(new Request('https://local.invalid/api/notifications/events',{method:'POST',headers:{Authorization:'Bearer '+input.token},body:JSON.stringify(input.event)}),env,ctx);
      if(input.operation==='reserve')return Response.json(await stub.reserve(identity));
      if(input.operation==='state')return Response.json(await stub.fixtureState());
      if(input.operation==='write'){await stub.fixtureWrite(input.state);return Response.json({ok:true})}
      if(input.operation==='tick'){await stub.tick();return Response.json({ok:true})}
      if(input.operation==='alternate')return Response.json(await dispatchScheduled(env));
      return new Response(null,{status:404});
    }};`,
    },
  });
  const options = {
    cf: false,
    log: new Log(LogLevel.ERROR),
    unsafeInspectDurableObjects: true,
    resourcePersistencePath: directory,
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
          HIVE_AGENT_NOTIFICATION_WAKE: {
            className: "AgentNotificationWake",
            useSQLite: true,
            unsafeUniqueKey: "agent-notification-pg-local",
          },
        },
        bindings: {
          DATABASE_URL: url,
          HIVE_RUNTIME_TARGET: "cloudflare",
          CODER_URL: coderOrigin,
          HIVE_NATIVE_MODE: "preview",
          HIVE_NATIVE_PREVIEW_ENABLED: "true",
          HIVE_PREVIEW_ACCESS_REQUIRED: "false",
          HIVE_PREVIEW_ORIGIN: "https://local.invalid",
          HIVE_AGENT_NOTIFICATION_WAKE_ENABLED: "true",
          HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON: JSON.stringify(identity),
          HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED: "true",
          HIVE_AGENT_NOTIFICATION_DISPATCH_ENABLED: "true",
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
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  closeRuntime = async () => {
    try {
      await mf.dispose();
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  await mf.ready;
  async function call(operation, data = {}) {
    const response = await mf.dispatchFetch("https://local.invalid/fixture", {
      method: "POST",
      body: JSON.stringify({ operation, ...data }),
    });
    assert.ok(response.ok, `local fixture ${operation} status ${response.status}`);
    return response.json();
  }
  async function due() {
    await call("write", {
      state: { ...(await call("state")), nextWake: Date.now() - 1, inFlightUntil: 0 },
    });
  }
  return {
    db,
    mf,
    identity,
    token,
    source,
    transport,
    call,
    due,
    disable: async () => {
      options.workers[0].bindings.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED = "false";
      await mf.setOptions(convertV4MiniflareOptions(options));
    },
  };
}
test("real platform alarm dispatches committed exact outbox after producer request closes, then stops DB polling", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const receipt = await f.call("reserve");
  await f.due();
  await f.call("tick"); // precommit wake sees no row and retains reservation
  assert.equal((await f.call("state")).deadline, receipt.deadline);
  const input = {
    eventId: f.identity.eventKey,
    kind: "ready",
    agent: "codex",
    sessionName: "native-main",
    projectName: "synthetic-project",
  };
  assert.deepEqual(await f.call("accept", { token: f.token, event: input }), { accepted: true });
  const [stored] = await f.db.$queryRawUnsafe(
    "SELECT payload FROM agent_notification_events WHERE source_id=$1::uuid",
    f.source.id,
  );
  assert.equal(stored.payload.tag, `hive-${f.source.id}-${input.eventId}`);
  await f.due(); // arm actual alarm. No postcommit tick, browser or scheduled dispatcher.
  let state;
  for (let n = 0; n < 400; n++) {
    state = await f.call("state");
    if (state.phase !== "active") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(state.phase, "terminal");
  const [row] = await f.db.$queryRawUnsafe(
    "SELECT status,attempts FROM agent_notification_events WHERE source_id=$1::uuid",
    f.source.id,
  );
  assert.deepEqual(row, { status: "delivered", attempts: 1 });
  const queries = f.transport.counts[0].queries;
  await f.call("tick");
  await f.call("tick");
  assert.equal(f.transport.counts[0].queries, queries);
  const raw = JSON.stringify(await f.call("state"));
  assert.ok(!raw.includes(input.projectName));
  assert.ok(!raw.includes(f.token));
  assert.ok(!raw.includes(stored.payload.body));
});
test("retained disabled SQLite enrollment fences a late row through the actual alternate jobs consumer", {
  skip: !url,
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  await f.call("reserve");
  await f.call("write", { state: { ...(await f.call("state")), nextWake: Date.now() + 60000 } });
  const input = { eventId: f.identity.eventKey, kind: "approval", agent: "claude" };
  await f.call("accept", { token: f.token, event: input });
  await f.disable();
  await f.call("tick");
  assert.equal((await f.call("state")).phase, "held");
  const queries = f.transport.counts[0].queries;
  await f.call("tick");
  assert.equal(f.transport.counts[0].queries, queries);
  const result = await f.call("alternate");
  assert.equal(result.agentNotifications.failed, 1);
  assert.equal(result.agentNotifications.delivered, 0);
  const [row] = await f.db.$queryRawUnsafe(
    "SELECT status,attempts FROM agent_notification_events WHERE source_id=$1::uuid",
    f.source.id,
  );
  assert.deepEqual(row, { status: "failed", attempts: 1 });
});
