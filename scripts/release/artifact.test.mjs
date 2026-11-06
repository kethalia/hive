import assert from "node:assert/strict";
import test from "node:test";
import tar from "tar-stream";
import { artifactDigest, packReleaseArtifact, readReleaseArtifact } from "./artifact.mjs";

async function archive(entries) {
  const pack = tar.pack();
  const chunks = [];
  pack.on("data", (chunk) => chunks.push(chunk));
  for (const [header, content] of entries) pack.entry(header, content);
  pack.finalize();
  await new Promise((resolve, reject) => {
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  return Buffer.concat(chunks);
}
const valid = [
  [{ name: "app/worker.js" }, "export default {}"],
  [{ name: "auth/worker.js" }, "export default {}"],
  [{ name: "assets/index.html" }, "<html>"],
];
test("canonical digest binds component files and bytes", async () => {
  const files = await readReleaseArtifact(await archive(valid));
  const before = artifactDigest(files, "app");
  files.set("assets/index.html", Buffer.from("changed"));
  assert.notEqual(before, artifactDigest(files, "app"));
  assert.equal(
    artifactDigest(files, "auth"),
    artifactDigest(await readReleaseArtifact(await archive(valid)), "auth"),
  );
});
test("accepts Next.js dynamic routes and route groups in asset paths", async () => {
  const files = new Map(valid.map(([h, body]) => [h.name, Buffer.from(body)]));
  files.set(
    "assets/_next/static/chunks/app/(dashboard)/[name]/[[...path]]/page.js",
    Buffer.from("chunk"),
  );
  assert.deepEqual(await readReleaseArtifact(await packReleaseArtifact(files)), files);
});
test("rejects traversal, links, duplicate entries and missing workers", async () => {
  for (const extra of [
    [{ name: "assets/../secret" }, "x"],
    [{ name: "assets/link", type: "symlink", linkname: "/etc/passwd" }, ""],
    [{ name: "app/worker.js" }, "x"],
    [{ name: "auth/extra.js" }, "x"],
  ]) {
    await assert.rejects(readReleaseArtifact(await archive([...valid, extra])));
  }
  await assert.rejects(readReleaseArtifact(await archive([valid[0]])));
});

test("build archive round trips exactly and is deterministic", async () => {
  const files = new Map(valid.map(([h, body]) => [h.name, Buffer.from(body)]));
  const bytes = await packReleaseArtifact(files);
  assert.deepEqual(await readReleaseArtifact(bytes), files);
  assert.deepEqual(await packReleaseArtifact(files), bytes);
  await assert.rejects(packReleaseArtifact(new Map([["../escape", Buffer.from("x")]])));
});
