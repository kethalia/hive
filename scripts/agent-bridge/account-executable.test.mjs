import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const publishedBytes = 309732776;
const publishedSha = "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5";
const runtimePath =
  ".local/share/hive/codex-runtime/0.165.0-linux-x64-c06a67fd8ac76508/vendor/x86_64-unknown-linux-musl/bin/codex";

test("account executable admits the pinned release size and retains hash/mode/size fences", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "hive-account-executable-"));
  const path = join(home, runtimePath);
  const fixtureKey = `hiveAccountExecutable${randomUUID()}`;
  let spawned = 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(join(home, ".local/share/hive/codex-native"), { recursive: true });
    if (process.env.HIVE_CODEX_ACCOUNT_TEST_BINARY) {
      copyFileSync(process.env.HIVE_CODEX_ACCOUNT_TEST_BINARY, path);
    } else {
      // Same actual file size as the vendor release, without vendoring its
      // 295 MiB payload. The real filesystem and SHA256 checks still execute.
      writeFileSync(path, "");
      truncateSync(path, publishedBytes);
    }
    chmodSync(path, 0o500);
    assert.equal(statSync(path).size, publishedBytes);
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    const digest = hash.digest("hex");
    if (process.env.HIVE_CODEX_ACCOUNT_TEST_BINARY) assert.equal(digest, publishedSha);
    globalThis[fixtureKey] = () => {
      spawned++;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stdin.on("data", (bytes) => {
        const message = JSON.parse(bytes.toString());
        if (message.method === "initialize")
          child.stdout.write(
            `${JSON.stringify({ id: message.id, result: { userAgent: "codex/0.165.0 (fixture)" } })}\n`,
          );
        else assert.equal(message.method, "initialized");
      });
      child.kill = () => {
        setImmediate(() => child.emit("close", 0));
        return true;
      };
      return child;
    };
    const sourceUrl = new URL("./codex-account.mjs", import.meta.url);
    const original = readFileSync(sourceUrl, "utf8");
    assert(original.includes(`const SHA = "${publishedSha}";`));
    const lock = new URL(
      "../../templates/ai-dev-k8s/scripts/codex-managed-auth-lock.mjs",
      import.meta.url,
    );
    const load = async (expectedDigest) => {
      const source = original
        .replace(
          'import { spawn } from "node:child_process";',
          `const spawn = globalThis[${JSON.stringify(fixtureKey)}];`,
        )
        .replace(
          '"../../templates/ai-dev-k8s/scripts/codex-managed-auth-lock.mjs"',
          JSON.stringify(lock.href),
        )
        .replace(`const SHA = "${publishedSha}";`, `const SHA = "${expectedDigest}";`);
      return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    };
    const valid = await load(digest);
    await t.test(
      "published 0.165.0 bytes with a valid hash reach auth-only initialization",
      async () => {
        const session = await valid.openAccountSession(home, 3, () => {});
        await session.close();
        assert.equal(spawned, 1);
      },
    );
    await t.test("wrong hash cannot launch", async () => {
      const invalid = await load("0".repeat(64));
      await assert.rejects(
        invalid.openAccountSession(home, 3, () => {}),
        /managed_auth_unavailable/,
      );
      assert.equal(spawned, 1);
    });
    await t.test("group-writable executable cannot launch", async () => {
      chmodSync(path, 0o570);
      await assert.rejects(
        valid.openAccountSession(home, 3, () => {}),
        /managed_auth_unavailable/,
      );
      assert.equal(spawned, 1);
      chmodSync(path, 0o500);
    });
    await t.test("executable above the reviewed 512 MiB limit cannot launch", async () => {
      chmodSync(path, 0o700);
      truncateSync(path, 512 * 1024 * 1024 + 1);
      chmodSync(path, 0o500);
      await assert.rejects(
        valid.openAccountSession(home, 3, () => {}),
        /managed_auth_unavailable/,
      );
      assert.equal(spawned, 1);
    });
  } finally {
    delete globalThis[fixtureKey];
    rmSync(home, { recursive: true, force: true });
  }
});
