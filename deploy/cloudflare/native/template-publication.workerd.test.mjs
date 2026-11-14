import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vendor = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = vendor("miniflare");
const { build } = vendor("esbuild");
const actorId = "10000000-0000-4000-8000-000000000001";
const origin = "https://coder.fixture.invalid";
// The actor's configured-origin policy is the only source dependency replaced.
// Provider transport, native fetch, cancellation, parsing and identity checks run
// unchanged. All outbound requests terminate in the local synthetic service.
const bundled = await build({
  stdin: {
    contents: `
      import {CoderTemplatePublicationProvider} from '../../../src/lib/templates/publication-provider.ts';
      export default {async fetch(){
        try {
          await CoderTemplatePublicationProvider.create({
            ownerId:'${actorId}',coderUserId:'${actorId}',sessionId:'${actorId}',
            sessionExpiresAt:new Date(Date.now()+60000),tokenExpiresAt:null,
            origin:'${origin}',token:'synthetic-fixture-token'
          });
          return Response.json({ok:true});
        } catch(error) {return Response.json({code:error.code??'unexpected'},{status:502});}
      }};
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    sourcefile: "template-provider-workerd-fixture.mjs",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["node:*"],
  plugins: [
    {
      name: "configured-origin-fixture",
      setup(builder) {
        builder.onResolve({ filter: /publication-actor$/ }, () => ({
          path: "origin",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export function getConfiguredCoderUrl(){return '${origin}'};export function isConfiguredCoderUrl(value){return value==='${origin}'}`,
          loader: "js",
        }));
      },
    },
  ],
});

for (const matches of [true, false]) {
  test(`actual workerd provider calls native fetch with its supported receiver and ${matches ? "accepts" : "rejects"} actor identity`, async (t) => {
    let requests = 0;
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        log: new Log(LogLevel.NONE),
        workers: [
          {
            name: "template-provider-fixture",
            modules: true,
            script: bundled.outputFiles[0].text,
            compatibilityDate: "2026-10-29",
            compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
            outboundService: async (request) => {
              requests++;
              assert.equal(request.url, `${origin}/api/v2/users/me`);
              assert.equal(request.method, "GET");
              assert.equal(request.headers.get("Coder-Session-Token"), "synthetic-fixture-token");
              return Response.json({
                id: matches ? actorId : "20000000-0000-4000-8000-000000000002",
              });
            },
          },
        ],
      }),
    );
    t.after(() => mf.dispose());
    const response = await mf.dispatchFetch("https://request.invalid/");
    assert.equal(response.status, matches ? 200 : 502);
    assert.deepEqual(
      await response.json(),
      matches ? { ok: true } : { code: "provider_identity_mismatch" },
    );
    assert.equal(requests, 1);
  });
}
