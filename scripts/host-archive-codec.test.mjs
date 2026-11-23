import assert from "node:assert/strict";
import test from "node:test";
import { decodeHostArchive, encodeHostArchive } from "./host-archive-codec.mjs";

test("standard XZ encoding is repeatable and preserves exact archive bytes", () => {
  const bytes = Buffer.from("owned host package fixture\n".repeat(100));
  const a = encodeHostArchive(bytes);
  assert.deepEqual(encodeHostArchive(bytes), a);
  assert.deepEqual(decodeHostArchive(a), bytes);
  assert.throws(() => decodeHostArchive(a.subarray(0, a.length - 1)));
  assert.throws(() => decodeHostArchive(Buffer.concat([a, a])));
  assert.throws(() => decodeHostArchive(Buffer.concat([a, Buffer.from("extra")])));
});
test("build codec rejects compressed and expanded limits before artifact publication", () => {
  assert.throws(() => encodeHostArchive(Buffer.alloc(2 * 1024 * 1024 + 1)));
  assert.throws(() => decodeHostArchive(Buffer.alloc(160001)));
});
