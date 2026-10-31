// Host-only recovery records. HMAC/filesystem ownership are not producer authority.
import { execFileSync } from "node:child_process";
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

const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => [key, sorted(v)]),
        )
      : value;
export const sourceCanonical = (value) => JSON.stringify(sorted(value));
export const sourceDigest = (value) =>
  createHash("sha256").update(sourceCanonical(value)).digest("hex");
export const sourceCheck = (value, code = "source_publisher_journal_unavailable") => {
  if (!value) throw new Error(code);
};
export const sourceUuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const MAX = 256 * 1024;
export function createSourcePublisherJournal(directory, pem) {
  sourceCheck(typeof directory === "string" && resolve(directory) === directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  sourceCheck(
    dir.isDirectory() &&
      !dir.isSymbolicLink() &&
      dir.uid === process.getuid() &&
      !(dir.mode & 0o077) &&
      realpathSync(directory) === directory,
  );
  const secret = createHash("sha256")
    .update("hive-source-publisher-journal-v1\0")
    .update(createPrivateKey(pem).export({ type: "pkcs8", format: "der" }))
    .digest();
  let closed = false;
  const lock = openSync(
    join(directory, "publisher.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const st = fstatSync(lock);
    sourceCheck(st.isFile() && st.nlink === 1 && st.uid === process.getuid() && !(st.mode & 0o077));
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
    });
  } catch {
    closeSync(lock);
    throw new Error("source_publisher_locked");
  }
  const sync = () => {
    const fd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const mac = (state) => createHmac("sha256", secret).update(sourceCanonical(state)).digest("hex");
  const path = (id) => {
    sourceCheck(sourceUuid(id));
    return join(directory, `${id}.json`);
  };
  function guard() {
    sourceCheck(!closed);
    const names = readdirSync(directory);
    sourceCheck(
      names.length <= 34 &&
        names.every(
          (name) =>
            name === "publisher.lock" ||
            name === "broker" ||
            (sourceUuid(name.slice(0, -5)) && name.endsWith(".json")),
        ),
    );
  }
  function read(id) {
    guard();
    const file = path(id);
    if (!existsSync(file)) return null;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      sourceCheck(
        st.isFile() &&
          st.nlink === 1 &&
          st.uid === process.getuid() &&
          !(st.mode & 0o077) &&
          st.size <= MAX,
      );
      const value = JSON.parse(readFileSync(fd, "utf8"));
      sourceCheck(
        value.schemaVersion === 1 &&
          typeof value.mac === "string" &&
          /^[a-f0-9]{64}$/.test(value.mac) &&
          value.state?.operationId === id,
      );
      sourceCheck(
        timingSafeEqual(Buffer.from(value.mac, "hex"), Buffer.from(mac(value.state), "hex")),
      );
      return structuredClone(value.state);
    } finally {
      closeSync(fd);
    }
  }
  return {
    read,
    write(id, state) {
      guard();
      sourceCheck(state?.operationId === id);
      const old = read(id);
      if (old) {
        sourceCheck(
          old.contextDigest === state.contextDigest && old.proposalDigest === state.proposalDigest,
        );
        for (const key of [
          "context",
          "proposal",
          "metadata",
          "policy",
          "challengeWire",
          "grant",
          "finalWire",
          "result",
        ])
          if (Object.hasOwn(old, key))
            sourceCheck(sourceCanonical(old[key]) === sourceCanonical(state[key]));
      } else sourceCheck(readdirSync(directory).filter((v) => v.endsWith(".json")).length < 32);
      const raw = sourceCanonical({ schemaVersion: 1, state, mac: mac(state) });
      sourceCheck(Buffer.byteLength(raw) <= MAX);
      const temp = join(directory, `${randomUUID()}.tmp`),
        fd = openSync(
          temp,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      try {
        writeFileSync(fd, raw);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path(id));
      sync();
    },
    brokerRoot(id) {
      path(id);
      const parent = join(directory, "broker");
      mkdirSync(parent, { mode: 0o700, recursive: true });
      const st = lstatSync(parent);
      sourceCheck(
        st.isDirectory() &&
          st.uid === process.getuid() &&
          !(st.mode & 0o077) &&
          realpathSync(parent) === parent,
      );
      return join(parent, id);
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(lock);
      }
    },
  };
}
