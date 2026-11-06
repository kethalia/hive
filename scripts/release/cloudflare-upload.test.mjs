import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { packReleaseArtifact } from "./artifact.mjs";
import { uploadReleaseVersion } from "./cloudflare-upload.mjs";

const version = "b418f4a8-65c3-491d-a03a-cb6ed6668894";
const files = new Map([
  ["app/worker.js", Buffer.from("APP")],
  ["auth/worker.js", Buffer.from("AUTH")],
  ["assets/index.html", Buffer.from("ok")],
]);
const templateBindings = [
  { name: "ASSETS", type: "assets" },
  { name: "HIVE_RELEASE_SOURCE_SHA", text: "{{source_sha}}", type: "plain_text" },
  { name: "HIVE_RELEASE_ARTIFACT_DIGEST", text: "{{artifact_digest}}", type: "plain_text" },
];
const options = {
  archive: await packReleaseArtifact(files),
  component: "app",
  accountId: "a".repeat(32),
  script: "fixed-app",
  metadata: {
    compatibility_date: "2026-01-01",
    compatibility_flags: [],
    bindings: templateBindings,
    assets: {},
  },
  expectedConfigDigest: createHash("sha256")
    .update(JSON.stringify({ bindings: templateBindings, runtime: {} }))
    .digest("hex"),
  sourceSha: "a".repeat(40),
  apiToken: "secret",
  signal: AbortSignal.timeout(2000),
};
test("uploads manifest, only requested assets and version bytes to fixed endpoints", async () => {
  const calls = [];
  let writtenBindings;
  const fetcher = async (url, init) => {
    calls.push([url, init]);
    assert.equal(init.redirect, "error");
    if (url.endsWith("assets-upload-session")) {
      const { manifest } = JSON.parse(init.body);
      assert.equal(manifest["/index.html"].size, 2);
      return Response.json({
        success: true,
        result: { jwt: "session", buckets: [[manifest["/index.html"].hash]] },
      });
    }
    if (url.endsWith("base64=true")) {
      assert.equal(init.headers.Authorization, "Bearer session");
      return Response.json({ success: true, result: { jwt: "completion" } });
    }
    if (init.method === "GET")
      return Response.json({
        success: true,
        result: {
          id: version,
          resources: { bindings: writtenBindings, script_runtime: {}, script: { etag: "opaque" } },
        },
      });
    assert.match(url, /fixed-app\/versions\?bindings_inherit=strict$/);
    assert.equal(init.body.get("worker.js").size, 3);
    const uploaded = JSON.parse(init.body.get("metadata"));
    assert.equal(uploaded.assets.jwt, "completion");
    writtenBindings = uploaded.bindings;
    assert.equal(
      writtenBindings.find((b) => b.name === "HIVE_RELEASE_SOURCE_SHA").text,
      options.sourceSha,
    );
    return Response.json({ success: true, result: { id: version } });
  };
  const result = await uploadReleaseVersion({ ...options, fetcher });
  assert.equal(result.versionId, version);
  assert.equal(calls.length, 4);
  assert.equal(result.providerScriptHash, "opaque");
});
test("refuses server-supplied unknown asset hash before upload", async () => {
  let calls = 0;
  await assert.rejects(
    uploadReleaseVersion({
      ...options,
      fetcher: async () => {
        calls++;
        return Response.json({ success: true, result: { jwt: "session", buckets: [["bad"]] } });
      },
    }),
    /upload_bucket_invalid/,
  );
  assert.equal(calls, 1);
});
test("rejects candidate-controlled metadata fields and pre-aborted signals", async () => {
  await assert.rejects(
    uploadReleaseVersion({ ...options, metadata: { ...options.metadata, routes: ["evil"] } }),
    /upload_config/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    uploadReleaseVersion({ ...options, signal: controller.signal }),
    /upload_scope/,
  );
});

test("aborts a stalled response body before any version upload", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return new Response(new ReadableStream({ start() {} }));
  };
  await assert.rejects(
    uploadReleaseVersion({ ...options, signal: controller.signal, fetcher }),
    /upload_aborted/,
  );
  assert.equal(calls, 1);
});

test("holds an uploaded version when provider readback differs from enrolled configuration", async () => {
  let writtenBindings;
  const fetcher = async (url, init) => {
    if (url.endsWith("assets-upload-session"))
      return Response.json({ success: true, result: { jwt: "complete", buckets: [] } });
    if (init.method === "GET")
      return Response.json({
        success: true,
        result: {
          id: version,
          resources: {
            bindings: [...writtenBindings, { name: "foreign" }],
            script_runtime: {},
            script: { etag: "opaque" },
          },
        },
      });
    writtenBindings = JSON.parse(init.body.get("metadata")).bindings;
    return Response.json({ success: true, result: { id: version } });
  };
  await assert.rejects(uploadReleaseVersion({ ...options, fetcher }), /upload_config_changed/);
});

test("rejects duplicate release identity bindings before any provider request", async () => {
  let calls = 0;
  const metadata = { ...options.metadata, bindings: [...templateBindings, templateBindings[1]] };
  await assert.rejects(
    uploadReleaseVersion({
      ...options,
      metadata,
      fetcher: async () => {
        calls++;
        throw Error("unexpected");
      },
    }),
    /upload_identity_changed/,
  );
  assert.equal(calls, 0);
});

for (const single of [false, true]) {
  test(`matches pinned Wrangler asset hashes/MIME and ${single ? "raw single-asset" : "base64 multipart"} wire format`, async () => {
    const input = new Map([
      ["app/worker.js", Buffer.from("APP")],
      ["auth/worker.js", Buffer.from("AUTH")],
      ["assets/index.html", Buffer.from("hello")],
      ["assets/message.txt", Buffer.from("hello")],
      ["assets/empty.bin", Buffer.from("")],
      ["assets/main.js", Buffer.from("script")],
      ["assets/file.hiveunknownextension", Buffer.from("opaque")],
    ]);
    // Independent fixed vectors from Wrangler 4.155.0's blake3-wasm@2.1.5
    // hash(base64 bytes + case-preserved extension), not uploader-derived IDs.
    const expected = new Map([
      ["a2b82584e50075886b08927390f2f573", ["hello", "text/html; charset=utf-8"]],
      ["f0b3413d4cabb000327fad369003d6a5", ["hello", "text/plain; charset=utf-8"]],
      ["869618f6a67498e0c3d5285d8322329d", ["", "application/octet-stream"]],
    ]);
    const session = `header.${Buffer.from(JSON.stringify({ wrangler_single_asset_uploads: single })).toString("base64url")}.signature`;
    let fixedBindings,
      uploads = 0,
      versions = 0;
    const fetcher = async (url, init) => {
      assert.equal(init.redirect, "error");
      if (url.endsWith("assets-upload-session")) {
        assert.equal(
          url,
          `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/workers/scripts/fixed-app/assets-upload-session`,
        );
        const { manifest } = JSON.parse(init.body);
        assert.deepEqual(manifest["/index.html"], {
          hash: "a2b82584e50075886b08927390f2f573",
          size: 5,
        });
        assert.deepEqual(manifest["/message.txt"], {
          hash: "f0b3413d4cabb000327fad369003d6a5",
          size: 5,
        });
        assert.deepEqual(manifest["/empty.bin"], {
          hash: "869618f6a67498e0c3d5285d8322329d",
          size: 0,
        });
        expected.set(manifest["/main.js"].hash, ["script", "text/javascript; charset=utf-8"]);
        expected.set(manifest["/file.hiveunknownextension"].hash, ["opaque", "application/null"]);
        return Response.json({
          success: true,
          result: { jwt: session, buckets: [[...expected.keys()]] },
        });
      }
      if (url.includes("/workers/assets/upload")) {
        uploads++;
        assert.equal(init.headers.Authorization, `Bearer ${session}`);
        if (single) {
          const hash = url.split("/").at(-1),
            [value, type] = expected.get(hash);
          assert.equal(
            url,
            `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/workers/assets/upload/${hash}`,
          );
          assert.equal(init.headers["Content-Type"], type);
          assert.ok(init.body instanceof Uint8Array);
          assert.equal(Buffer.from(init.body).toString(), value);
        } else {
          assert.equal(
            url,
            `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/workers/assets/upload?base64=true`,
          );
          assert.ok(init.body instanceof FormData);
          assert.equal(init.headers["Content-Type"], undefined);
          for (const [hash, [value, type]] of expected) {
            const entry = init.body.get(hash);
            assert.equal(entry.name, hash);
            assert.equal(entry.type, type);
            assert.equal(await entry.text(), Buffer.from(value).toString("base64"));
          }
        }
        return Response.json({ success: true, result: { jwt: "completion" } });
      }
      if (url.endsWith("/versions?bindings_inherit=strict")) {
        versions++;
        assert.equal(uploads, single ? expected.size : 1);
        const metadata = JSON.parse(init.body.get("metadata"));
        assert.equal(metadata.assets.jwt, "completion");
        fixedBindings = metadata.bindings;
        return Response.json({ success: true, result: { id: version } });
      }
      assert.equal(init.method, "GET");
      assert.equal(url.endsWith(`/versions/${version}`), true);
      return Response.json({
        success: true,
        result: {
          id: version,
          resources: { bindings: fixedBindings, script_runtime: {}, script: { etag: "opaque" } },
        },
      });
    };
    const result = await uploadReleaseVersion({
      ...options,
      archive: await packReleaseArtifact(input),
      fetcher,
    });
    assert.equal(result.versionId, version);
    assert.equal(versions, 1);
  });
}

test("invalid later bucket is rejected before any asset bucket upload", async () => {
  let calls = 0;
  await assert.rejects(
    uploadReleaseVersion({
      ...options,
      fetcher: async (_url, init) => {
        calls++;
        const { manifest } = JSON.parse(init.body);
        return Response.json({
          success: true,
          result: { jwt: "session", buckets: [[manifest["/index.html"].hash], ["foreign-hash"]] },
        });
      },
    }),
    /upload_bucket_invalid/,
  );
  assert.equal(calls, 1);
});

for (const single of [false, true])
  test(`unknown ${single ? "raw" : "bulk"} asset upload acknowledgement never retries or uploads a version`, async () => {
    let calls = 0;
    const session = `header.${Buffer.from(JSON.stringify({ wrangler_single_asset_uploads: single })).toString("base64url")}.signature`;
    await assert.rejects(
      uploadReleaseVersion({
        ...options,
        fetcher: async (url, init) => {
          calls++;
          if (calls === 1) {
            const { manifest } = JSON.parse(init.body);
            return Response.json({
              success: true,
              result: { jwt: session, buckets: [[manifest["/index.html"].hash]] },
            });
          }
          assert.match(url, /\/workers\/assets\/upload/);
          throw Error("lost asset acknowledgement");
        },
      }),
      /lost asset acknowledgement/,
    );
    assert.equal(calls, 2);
  });
