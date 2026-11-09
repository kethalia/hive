import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decodeHostArchive,
  encodeHostArchive,
  HOST_IMAGE_ARCHIVE_MAX_BYTES,
} from "./host-archive-codec.mjs";

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
  assert.throws(() => decodeHostArchive(Buffer.alloc(HOST_IMAGE_ARCHIVE_MAX_BYTES + 1)));
});
test("image packages can exceed the retired inline metadata limit within decoder bounds", () => {
  const bytes = randomBytes(192 * 1024);
  const encoded = encodeHostArchive(bytes);
  assert.ok(encoded.length > 160000);
  assert.ok(encoded.length <= HOST_IMAGE_ARCHIVE_MAX_BYTES);
  assert.deepEqual(decodeHostArchive(encoded), bytes);
});
test("stock XZ decoding accepts the tuned encoder and existing preset6 archives remain readable", () => {
  const bytes = Buffer.from("legacy and current host archive fixture\n".repeat(100));
  const legacy = execFileSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      "import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read(),format=lzma.FORMAT_XZ,check=lzma.CHECK_CRC64,preset=6))",
    ],
    { input: bytes },
  );
  assert.deepEqual(decodeHostArchive(legacy), bytes);
  const stock = execFileSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      "import lzma,sys;d=lzma.LZMADecompressor(format=lzma.FORMAT_XZ,memlimit=32*1024*1024);out=d.decompress(sys.stdin.buffer.read(),max_length=2*1024*1024+1);assert d.eof and not d.unused_data;sys.stdout.buffer.write(out)",
    ],
    { input: encodeHostArchive(bytes) },
  );
  assert.deepEqual(stock, bytes);
});
