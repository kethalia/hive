import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vendor = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = vendor("miniflare");
const { build } = vendor("esbuild");
const ownerA = "10000000-0000-4000-8000-000000000001";
const ownerB = "20000000-0000-4000-8000-000000000002";
const directory = fileURLToPath(new URL(".", import.meta.url));

// Only the provider/database dispatcher is replaced. The production actor,
// routing helper, RPC, storage transactions and automatically fired alarms run
// unchanged inside workerd with SQLite-backed Durable Objects.
const bundled = await build({
  stdin: {
    contents: `
      import {HiveBackground as Actor} from './background-wake.mjs';
      import {wakeBackground} from '../../../src/lib/queue/background-wake.server.ts';
      export class ProbeBackground extends Actor {
        async snapshot() {
          return {owner:await this.ctx.storage.get('owner')??null,
            pending:await this.ctx.storage.get('pending')??null,
            alarm:await this.ctx.storage.getAlarm()};
        }
        async due() { await this.ctx.storage.setAlarm(Date.now()); }
      }
      export default {async fetch(request,env){
        const input=await request.json();
        const database=input.database??env.HIVE_DATABASE_NAME;
        const stub=env.BACKGROUND.getByName(database+':'+input.owner);
        try {
          if(input.operation==='wake') await wakeBackground({...env,HIVE_DATABASE_NAME:database},input.owner);
          else if(input.operation==='wrong-owner') await stub.wake(input.other);
          else if(input.operation==='due') await stub.due();
          return Response.json(await stub.snapshot());
        } catch(error) {return Response.json({error:error.message},{status:409});}
      }};
    `,
    resolveDir: directory,
    sourcefile: "background-workerd-fixture.mjs",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  plugins: [
    {
      name: "fixture-dispatch-only",
      setup(build) {
        build.onResolve({ filter: /^\.\/background$/ }, () => ({
          path: "dispatcher",
          namespace: "fixture",
        }));
        build.onResolve({ filter: /^@opennextjs\/cloudflare$/ }, () => ({
          path: "context",
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "context"
              ? "export function getCloudflareContext(){throw Error('request context not used by actor fixture')}"
              : `export async function dispatchBackground(env,owner){
          const response=await env.DISPATCH.fetch('https://dispatch.invalid/',{method:'POST',body:JSON.stringify({owner,coderUrl:process.env.CODER_URL,runtimeTarget:process.env.HIVE_RUNTIME_TARGET})});
          if(!response.ok)throw Error('fixture dispatch failed');
          return (await response.json()).next;
        }`,
          loader: "js",
        }));
      },
    },
  ],
});
async function runtime(t, dispatch) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: "background-fixture",
          modules: true,
          script: bundled.outputFiles[0].text,
          compatibilityDate: "2026-10-29",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          durableObjects: { BACKGROUND: { className: "ProbeBackground", useSQLite: true } },
          bindings: {
            HIVE_DATABASE_NAME: "hive_fixture",
            CODER_URL: "https://coder.fixture.invalid",
            HIVE_RUNTIME_TARGET: "cloudflare",
          },
          serviceBindings: {
            DISPATCH: async (request) => {
              const input = await request.json();
              // nodejs_compat supplies runtime vars to alarms without OpenNext.
              assert.equal(input.coderUrl, "https://coder.fixture.invalid");
              assert.equal(input.runtimeTarget, "cloudflare");
              return dispatch({ owner: input.owner });
            },
          },
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const call = async (operation, owner = ownerA, extra = {}) => {
    const response = await mf.dispatchFetch("https://fixture.invalid/", {
      method: "POST",
      body: JSON.stringify({ operation, owner, ...extra }),
    });
    return { status: response.status, ...(await response.json()) };
  };
  return { mf, call };
}
async function until(operation, predicate, description, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await operation();
    if (predicate(value)) return value;
    if (Date.now() - start > timeout) throw Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("real transaction arms an alarm, dispatches owner once, and becomes idle", {
  timeout: 10000,
}, async (t) => {
  const calls = [];
  const { call } = await runtime(t, async (input) => {
    calls.push(input);
    return Response.json({ next: null });
  });
  const initial = await call("wake");
  assert.equal(initial.status, 200);
  assert.equal(initial.owner, ownerA);
  assert(initial.alarm > 0);
  const idle = await until(
    () => call("snapshot"),
    (state) => calls.length === 1 && state.alarm === null,
    "alarm completion",
  );
  assert.equal(idle.pending, null);
  assert.deepEqual(calls, [{ owner: ownerA }]);
});
test("a concurrent RPC wake survives dispatch and schedules a second real alarm", {
  timeout: 10000,
}, async (t) => {
  const started = gate(),
    release = gate(),
    calls = [];
  t.after(() => release.resolve());
  const { call } = await runtime(t, async (input) => {
    calls.push(input);
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
    return Response.json({ next: null });
  });
  await call("wake");
  await started.promise;
  const concurrent = await call("wake");
  assert.equal(concurrent.status, 200);
  assert(concurrent.pending > 0);
  release.resolve();
  await until(
    () => call("snapshot"),
    (state) => calls.length === 2 && state.alarm === null,
    "retained wake second alarm",
  );
  assert.deepEqual(calls, [{ owner: ownerA }, { owner: ownerA }]);
});
test("failed dispatch preserves its fallback and retry uses the same owner", {
  timeout: 10000,
}, async (t) => {
  let calls = 0;
  const { call } = await runtime(t, async ({ owner }) => {
    assert.equal(owner, ownerA);
    return ++calls === 1 ? new Response(null, { status: 503 }) : Response.json({ next: null });
  });
  await call("wake");
  const fallback = await until(
    () => call("snapshot"),
    (state) => calls === 1 && state.alarm > Date.now() + 60000,
    "persisted failure fallback",
  );
  assert.equal(fallback.owner, ownerA);
  // Advance only the stored test alarm; execute the actual alarm handler again.
  await call("due");
  await until(
    () => call("snapshot"),
    (state) => calls === 2 && state.alarm === null,
    "successful retry",
  );
});
test("database and owner names isolate actors and a conflicting owner rolls back", {
  timeout: 10000,
}, async (t) => {
  const entered = gate(),
    release = gate(),
    calls = [];
  t.after(() => release.resolve());
  const { call } = await runtime(t, async (input) => {
    calls.push(input);
    entered.resolve();
    await release.promise;
    return Response.json({ next: null });
  });
  await call("wake");
  await entered.promise;
  assert.deepEqual(await call("snapshot", ownerB), {
    status: 200,
    owner: null,
    pending: null,
    alarm: null,
  });
  assert.deepEqual(await call("snapshot", ownerA, { database: "other_fixture" }), {
    status: 200,
    owner: null,
    pending: null,
    alarm: null,
  });
  const before = await call("snapshot");
  assert.equal((await call("wrong-owner", ownerA, { other: ownerB })).status, 409);
  assert.deepEqual(await call("snapshot"), before);
  await call("wake", ownerB);
  await call("wake", ownerA, { database: "other_fixture" });
  await until(
    async () => calls.length,
    (count) => count === 3,
    "separate owner/database dispatches",
  );
  release.resolve();
  for (const [owner, extra] of [
    [ownerA, {}],
    [ownerB, {}],
    [ownerA, { database: "other_fixture" }],
  ])
    await until(
      () => call("snapshot", owner, extra),
      (state) => state.alarm === null,
      "isolated completion",
    );
  assert.deepEqual(calls.map((c) => c.owner).sort(), [ownerA, ownerA, ownerB].sort());
});
