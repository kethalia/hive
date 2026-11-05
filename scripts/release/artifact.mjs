import { createHash } from "node:crypto";
import tar from "tar-stream";

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const validPath = (p) =>
  typeof p === "string" &&
  p.length <= 512 &&
  !p.includes("\\") &&
  [...p].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
  !p.startsWith("/") &&
  p.split("/").every((x) => x && x !== "." && x !== "..") &&
  /^(app|auth)\/(worker\.js|[A-Za-z0-9_./-]+\.wasm)$|^assets\/[A-Za-z0-9_./()[\]-]+$/.test(p);

// The publisher consumes bytes only: it never imports the bundle, follows links,
// or asks a bundler to resolve paths inside candidate-controlled JavaScript.
export async function readReleaseArtifact(bytes, { topology } = {}) {
  if (topology !== undefined && topology !== "single") throw Error("artifact_topology");
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARCHIVE)
    throw Error("artifact_size");
  const files = new Map();
  const extract = tar.extract();
  let total = 0;
  await new Promise((resolve, reject) => {
    extract.on("error", reject);
    extract.on("finish", resolve);
    extract.on("entry", (header, stream, next) => {
      stream.on("error", reject);
      if (
        header.type !== "file" ||
        !validPath(header.name) ||
        files.has(header.name) ||
        files.size >= MAX_FILES ||
        !Number.isSafeInteger(header.size) ||
        header.size < 0 ||
        header.size > MAX_FILE ||
        total + header.size > MAX_ARCHIVE
      ) {
        stream.resume();
        extract.destroy(Error("artifact_entry"));
        return;
      }
      total += header.size;
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > header.size) extract.destroy(Error("artifact_entry"));
        else chunks.push(chunk);
      });
      stream.on("end", () => {
        if (size !== header.size) {
          extract.destroy(Error("artifact_entry"));
          return;
        }
        files.set(header.name, Buffer.concat(chunks, size));
        next();
      });
    });
    extract.end(bytes);
  });
  if (
    !files.has("app/worker.js") ||
    (topology !== "single" && !files.has("auth/worker.js")) ||
    (topology === "single" && [...files.keys()].some((name) => name.startsWith("auth/")))
  )
    throw Error("artifact_missing_worker");
  return files;
}

// Length-prefixed canonical digest makes filenames, byte content and membership
// unambiguous; independently computed for each worker and its app assets.
export function artifactDigest(files, component) {
  if (!["app", "auth"].includes(component)) throw Error("artifact_component");
  const hash = createHash("sha256");
  for (const [path, data] of [...files]
    .filter(
      ([path]) =>
        path.startsWith(`${component}/`) || (component === "app" && path.startsWith("assets/")),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = Buffer.from(path);
    const sizes = Buffer.alloc(12);
    sizes.writeUInt32BE(name.length);
    sizes.writeBigUInt64BE(BigInt(data.length), 4);
    hash.update(sizes).update(name).update(data);
  }
  return hash.digest("hex");
}

/** Builder-side packing; the privileged reader still validates the complete
 * archive independently. Entries are bytes, never paths opened by the publisher. */
export async function packReleaseArtifact(files) {
  if (!(files instanceof Map) || files.size > MAX_FILES) throw Error("artifact_entry");
  const pack = tar.pack();
  const chunks = [];
  let total = 0;
  const collected = new Promise((resolve, reject) => {
    pack.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_ARCHIVE) pack.destroy(Error("artifact_size"));
      else chunks.push(chunk);
    });
    pack.on("error", reject);
    pack.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!validPath(name) || !Buffer.isBuffer(data) || data.length > MAX_FILE) {
      pack.destroy(Error("artifact_entry"));
      return collected;
    }
    await new Promise((resolve, reject) =>
      pack.entry(
        { name, type: "file", size: data.length, mode: 0o644, mtime: new Date(0) },
        data,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  pack.finalize();
  return collected;
}
