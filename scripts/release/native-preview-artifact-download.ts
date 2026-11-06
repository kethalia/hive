import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { publicationBody, publicationFetch } from "../../src/lib/templates/publication-io";
import { nativeJson, sha256 } from "./native-preview-upload";

const MAX = 128 * 1024 * 1024;
const id = z.string().regex(/^[1-9][0-9]{0,19}$/);

/** GitHub's immutable artifact ZIP contains exactly one regular release.tar.
 * Decode to memory with explicit bounds; never extract candidate paths to disk. */
export function nativeArchiveFromZip(zip: Buffer): Buffer {
  const fail = (): never => {
    throw Error("native_artifact_zip_invalid");
  };
  if (zip.length < 98 || zip.length > MAX) return fail();
  const end = zip.length - 22;
  if (
    zip.readUInt32LE(end) !== 0x06054b50 ||
    zip.readUInt16LE(end + 20) !== 0 ||
    zip.readUInt16LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 6) !== 0 ||
    zip.readUInt16LE(end + 8) !== 1 ||
    zip.readUInt16LE(end + 10) !== 1
  )
    return fail();
  const central = zip.readUInt32LE(end + 16),
    centralSize = zip.readUInt32LE(end + 12);
  if (
    central + centralSize !== end ||
    centralSize < 46 ||
    central < 30 ||
    zip.readUInt32LE(central) !== 0x02014b50
  )
    return fail();
  const flags = zip.readUInt16LE(central + 8),
    method = zip.readUInt16LE(central + 10);
  const compressed = zip.readUInt32LE(central + 20),
    size = zip.readUInt32LE(central + 24);
  const nameSize = zip.readUInt16LE(central + 28),
    extra = zip.readUInt16LE(central + 30),
    comment = zip.readUInt16LE(central + 32);
  const mode = zip.readUInt32LE(central + 38) >>> 16;
  if (
    (flags & ~0x0808) !== 0 ||
    ![0, 8].includes(method) ||
    size === 0 ||
    size > MAX ||
    zip.readUInt16LE(central + 34) !== 0 ||
    zip.readUInt32LE(central + 42) !== 0 ||
    (mode !== 0 && (mode & 0xf000) !== 0x8000) ||
    nameSize !== 11 ||
    46 + nameSize + extra + comment !== centralSize ||
    zip.subarray(central + 46, central + 57).toString() !== "release.tar" ||
    zip.readUInt32LE(0) !== 0x04034b50 ||
    zip.readUInt16LE(6) !== flags ||
    zip.readUInt16LE(8) !== method ||
    zip.readUInt16LE(26) !== 11 ||
    zip.subarray(30, 41).toString() !== "release.tar"
  )
    return fail();
  const start = 41 + zip.readUInt16LE(28),
    finish = start + compressed;
  if (start > central || finish > central) return fail();
  if ((flags & 8) === 0) {
    if (
      finish !== central ||
      zip.readUInt32LE(18) !== compressed ||
      zip.readUInt32LE(22) !== size ||
      zip.readUInt32LE(14) !== zip.readUInt32LE(central + 16)
    )
      return fail();
  } else {
    const descriptor = central - finish;
    const offset =
      descriptor === 16 && zip.readUInt32LE(finish) === 0x08074b50 ? finish + 4 : finish;
    if (
      ![12, 16].includes(descriptor) ||
      offset + 12 !== central ||
      zip.readUInt32LE(offset) !== zip.readUInt32LE(central + 16) ||
      zip.readUInt32LE(offset + 4) !== compressed ||
      zip.readUInt32LE(offset + 8) !== size
    )
      return fail();
  }
  const contents = zip.subarray(start, finish);
  const archive =
    method === 0 ? Buffer.from(contents) : inflateRawSync(contents, { maxOutputLength: size });
  if (archive.length !== size) return fail();
  // ZIP is SHA256-bound to authenticated GitHub artifact metadata; CRC is also
  // checked so corrupt archives never become new artifact attestations.
  let crc = 0xffffffff;
  for (const byte of archive) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  if ((crc ^ 0xffffffff) >>> 0 !== zip.readUInt32LE(central + 16)) return fail();
  return archive;
}

export async function downloadNativeArtifact(input: {
  artifactId: string;
  token: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}) {
  const artifactId = id.parse(input.artifactId),
    fetcher = input.fetcher ?? fetch;
  if (!/^[!-~]{1,4096}$/.test(input.token)) throw Error("native_artifact_token_invalid");
  const base = `https://api.github.com/repos/kethalia/hive/actions/artifacts/${artifactId}`;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const metadata = z
    .object({
      id: z.union([z.string(), z.number().int().positive().safe()]).transform(String),
      name: z.literal("hive-native-release"),
      expired: z.literal(false),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      size_in_bytes: z.number().int().positive().max(MAX),
    })
    .parse(await nativeJson(fetcher, base, { method: "GET", headers }, input.signal));
  if (metadata.id !== artifactId) throw Error("native_artifact_identity_changed");
  const redirect = await publicationFetch(
    Promise.resolve().then(() =>
      fetcher(`${base}/zip`, {
        method: "GET",
        headers,
        redirect: "manual",
        credentials: "omit",
        signal: input.signal,
      }),
    ),
    input.signal,
  );
  await redirect.body?.cancel().catch(() => {});
  if (redirect.status !== 302) throw Error("native_artifact_download_held");
  const location = new URL(redirect.headers.get("location") ?? "");
  if (
    location.protocol !== "https:" ||
    location.port ||
    location.username ||
    location.password ||
    location.hash ||
    ![".blob.core.windows.net", ".actions.githubusercontent.com"].some((suffix) =>
      location.hostname.endsWith(suffix),
    )
  )
    throw Error("native_artifact_download_held");
  // Never forward the GitHub credential to the signed storage location.
  const response = await publicationFetch(
    Promise.resolve().then(() =>
      fetcher(location.toString(), {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: input.signal,
      }),
    ),
    input.signal,
  );
  if (response.status !== 200 || response.redirected) {
    await response.body?.cancel().catch(() => {});
    throw Error("native_artifact_download_held");
  }
  const zip = Buffer.from(await publicationBody(response, MAX, input.signal));
  if (`sha256:${sha256(zip)}` !== metadata.digest)
    throw Error("native_artifact_zip_digest_changed");
  return { archive: nativeArchiveFromZip(zip), artifactZipDigest: metadata.digest.slice(7) };
}
