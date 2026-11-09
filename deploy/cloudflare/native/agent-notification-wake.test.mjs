import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = await import(
  pathToFileURL(
    require.resolve("miniflare", { paths: [dirname(require.resolve("wrangler/package.json"))] }),
  ).href
);
const identity = () => ({ ownerId: randomUUID(), sourceId: randomUUID(), eventKey: randomUUID() });
async function fixture(t, enrolled = identity()) {
  const directory = await mkdtemp(join(tmpdir(), "hive-task-wake-sqlite-"));
  const bundle = await build({
    stdin: {
      contents: `import { AgentNotificationWake as Wake } from ${JSON.stringify(resolve("deploy/cloudflare/native/agent-notification-wake.mjs"))};
    export class AgentNotificationWake extends Wake { tick(){return this.alarm()} testRead(){return JSON.parse(this.ctx.storage.sql.exec("SELECT state FROM wake WHERE id=1").one().state)} testWrite(state){this.ctx.storage.sql.exec("UPDATE wake SET state=? WHERE id=1",JSON.stringify(state))} }
    export default { async fetch(request,env){
      const {method,value,objectName}=await request.json();
      const scope=JSON.parse(env.HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON);
      const name=objectName??('agent-notification/v1/'+scope.ownerId+'/'+scope.sourceId+'/'+scope.eventKey);
      const stub=env.HIVE_AGENT_NOTIFICATION_WAKE.getByName(name);
      try { return Response.json({value:await stub[method](value)}); }
      catch { return Response.json({error:true},{status:409}); }
    } };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    plugins: [
      {
        name: "bounded-reconciler-double",
        setup(b) {
          b.onResolve({ filter: /app\/agent-notification-wake$/ }, () => ({
            path: "fixture-runner",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `export async function runExactAgentNotificationWake(env, state) {
        return env.ATTEMPT.fetch('https://fixture.invalid/attempt', {method:'POST',body:JSON.stringify(state)}).then(r=>r.json());
      }`,
            loader: "js",
          }));
        },
      },
    ],
  });
  let calls = 0,
    reply = { phase: "retry", nextWake: Date.now() + 60000 },
    blocked;
  const options = {
    unsafeInspectDurableObjects: true,
    cf: false,
    log: new Log(LogLevel.ERROR),
    resourcePersistencePath: directory,
    workers: [
      {
        name: "wake",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-10-29",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          HIVE_NATIVE_MODE: "preview",
          HIVE_NATIVE_PREVIEW_ENABLED: "true",
          HIVE_AGENT_NOTIFICATION_WAKE_ENABLED: "true",
          HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON: JSON.stringify(enrolled),
          HIVE_PROJECT_TASKS_ENABLED: "true",
        },
        durableObjects: {
          HIVE_AGENT_NOTIFICATION_WAKE: {
            className: "AgentNotificationWake",
            useSQLite: true,
            unsafeUniqueKey: "agent-notification-wake-local",
          },
        },
        serviceBindings: {
          ATTEMPT: async (request) => {
            calls++;
            const state = await request.json();
            assert.ok(state.inFlightUntil > Date.now());
            if (blocked) await blocked;
            return Response.json(reply);
          },
        },
      },
    ],
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await mf.ready;
  const name = `agent-notification/v1/${enrolled.ownerId}/${enrolled.sourceId}/${enrolled.eventKey}`;
  function client() {
    return Object.fromEntries(
      ["reserve", "inspect", "tick", "testRead", "testWrite"].map((method) => [
        method,
        async (value) => {
          const response = await mf.dispatchFetch("https://fixture.invalid/call", {
            method: "POST",
            body: JSON.stringify({ method, value }),
          });
          const result = await response.json();
          if (!response.ok) throw Error("fixture_rpc_rejected");
          return result.value;
        },
      ]),
    );
  }
  const stub = client();
  const read = () => stub.testRead();
  const write = (state) => stub.testWrite(state);
  return {
    enrolled,
    stub,
    read,
    write,
    calls: () => calls,
    reply: (value) => {
      reply = value;
    },
    block: (value) => {
      blocked = value;
    },
    disable: async () => {
      options.workers[0].bindings.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED = "false";
      await mf.setOptions(convertV4MiniflareOptions(options));
    },
    foreignObject: () =>
      mf.dispatchFetch("https://fixture.invalid/call", {
        method: "POST",
        body: JSON.stringify({ method: "reserve", value: enrolled, objectName: "foreign" }),
      }),
    evict: () => mf.unsafeEvictDurableObject("wake", "AgentNotificationWake", { name }),
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
      await mf.ready;
      return client();
    },
  };
}
test("real SQLite reservation survives isolate and workerd restart without extending the first deadline", async (t) => {
  const f = await fixture(t),
    first = await f.stub.reserve(f.enrolled);
  assert.equal(first.deadline - first.createdAt, 1800000);
  assert.equal(f.calls(), 0); // reserve -> crash before any enqueue
  await f.evict();
  assert.equal((await f.stub.reserve(f.enrolled)).deadline, first.deadline);
  const replay = await (await f.restart()).reserve(f.enrolled);
  assert.equal(replay.createdAt, first.createdAt);
  assert.equal(replay.deadline, first.deadline);
});
test("wrong owner, source, event and object name cannot reserve", async (t) => {
  const f = await fixture(t);
  for (const field of ["ownerId", "sourceId", "eventKey"])
    await assert.rejects(f.stub.reserve({ ...f.enrolled, [field]: randomUUID() }));
  assert.equal((await f.foreignObject()).status, 409);
  assert.equal(f.calls(), 0);
});
test("alarm durably budgets before I/O, serializes duplicate deliveries, and terminal alarms do no I/O", async (t) => {
  const f = await fixture(t);
  await f.stub.reserve(f.enrolled);
  await f.write({ ...(await f.read()), nextWake: Date.now() - 1 });
  let release;
  f.block(
    new Promise((r) => {
      release = r;
    }),
  );
  const first = f.stub.tick();
  for (let n = 0; n < 100 && f.calls() === 0; n++) await new Promise((r) => setTimeout(r, 5));
  const persisted = await f.read();
  assert.equal(persisted.attempts, 1);
  assert.ok(persisted.inFlightUntil > Date.now());
  await f.write({ ...persisted, inFlightUntil: Date.now() - 1, nextWake: Date.now() - 1 });
  await f.stub.tick();
  assert.equal(f.calls(), 1);
  f.reply({ phase: "terminal" });
  release();
  await first;
  assert.equal((await f.read()).phase, "terminal");
  await f.stub.tick();
  await f.stub.tick();
  assert.equal(f.calls(), 1);
});
test("expired and budget-exhausted reservations retain holds and never rearm authority", async (t) => {
  const f = await fixture(t);
  await f.stub.reserve(f.enrolled);
  const state = await f.read();
  state.createdAt = Date.now() - 1800001;
  state.deadline = state.createdAt + 1800000;
  await f.write(state);
  await f.stub.tick();
  const expired = await f.stub.reserve(f.enrolled);
  assert.equal(expired.phase, "held");
  assert.equal(expired.deadline, state.deadline);
  assert.equal(f.calls(), 0);
  const g = await fixture(t);
  await g.stub.reserve(g.enrolled);
  await g.write({ ...(await g.read()), requests: 99 });
  assert.equal((await g.stub.inspect(g.enrolled)).phase, "held");
  await g.stub.tick();
  assert.equal(g.calls(), 0);
});
test("late/unknown attempt completion cannot overwrite a retained terminal hold", async (t) => {
  const f = await fixture(t);
  await f.stub.reserve(f.enrolled);
  await f.write({ ...(await f.read()), nextWake: Date.now() - 1 });
  let release;
  f.block(
    new Promise((r) => {
      release = r;
    }),
  );
  const pending = f.stub.tick();
  for (let n = 0; n < 100 && !f.calls(); n++) await new Promise((r) => setTimeout(r, 5));
  await f.write({ ...(await f.read()), requests: 99 });
  assert.equal((await f.stub.inspect(f.enrolled)).phase, "held");
  f.reply({ phase: "terminal" });
  release();
  await pending;
  assert.equal((await f.read()).phase, "held");
  assert.equal(f.calls(), 1);
});

test("revoked enrollment holds the persisted event and performs no external work", async (t) => {
  const f = await fixture(t);
  await f.stub.reserve(f.enrolled);
  await f.disable();
  await f.stub.tick();
  assert.equal((await f.read()).phase, "held");
  assert.equal(f.calls(), 0);
});
