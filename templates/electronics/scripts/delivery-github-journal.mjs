// Private installed-controller state, outside the native checkout/home boundary.
import { createHash, createHmac, createPrivateKey, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const check = (value) => {
  if (!value) throw new Error("github_journal_unavailable");
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, x]) => [key, canonical(x)]),
        )
      : value;
export function createGitHubCollectionJournal(directory, privateKeyPem) {
  check(typeof directory === "string" && resolve(directory) === directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  check(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o077) === 0 &&
      realpathSync(directory) === directory,
  );
  const secret = createHash("sha256")
    .update("hive-github-journal-v1\0")
    .update(createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "der" }))
    .digest();
  const mac = (state) =>
    createHmac("sha256", secret)
      .update(JSON.stringify(canonical(state)))
      .digest("hex");
  const path = (requestId) => {
    check(
      typeof requestId === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId),
    );
    return join(directory, `${requestId}.json`);
  };
  function read(requestId) {
    const target = path(requestId);
    if (!existsSync(target)) return null;
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      check(
        stat.isFile() &&
          stat.uid === process.getuid() &&
          (stat.mode & 0o077) === 0 &&
          stat.size <= 1152 * 1024,
      );
      const saved = JSON.parse(readFileSync(fd, "utf8"));
      check(
        saved.schemaVersion === 1 &&
          /^[a-f0-9]{64}$/.test(saved.mac) &&
          saved.state?.requestId === requestId,
      );
      check(timingSafeEqual(Buffer.from(saved.mac, "hex"), Buffer.from(mac(saved.state), "hex")));
      return structuredClone(saved.state);
    } finally {
      closeSync(fd);
    }
  }
  return {
    read,
    write(requestId, state) {
      check(state?.requestId === requestId);
      const target = path(requestId);
      const old = read(requestId);
      if (!old) check(readdirSync(directory).length < 32);
      else
        check(
          old.contextDigest === state.contextDigest &&
            (!Object.hasOwn(old, "snapshot") ||
              JSON.stringify(canonical(old)) === JSON.stringify(canonical(state))),
        );
      const value = JSON.stringify({ schemaVersion: 1, state, mac: mac(state) });
      check(Buffer.byteLength(value) <= 1152 * 1024);
      const temporary = join(directory, `${randomUUID()}.tmp`),
        fd = openSync(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      try {
        writeFileSync(fd, value);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, target);
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    },
  };
}
