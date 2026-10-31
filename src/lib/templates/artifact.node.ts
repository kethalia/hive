import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import manifest from "./artifact-manifest.json";
import { KNOWN_TEMPLATES, type KnownTemplate } from "./catalog";

/** Upload the same build-verified bytes used by Workers; never rescan a live directory. */
export async function readTemplateArtifact(name: string): Promise<Buffer> {
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(name))
    throw new Error("Unknown template artifact");
  const entry = manifest.templates[name as KnownTemplate];
  if (
    manifest.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(entry.archiveDigest) ||
    !Number.isSafeInteger(entry.archiveBytes) ||
    entry.archiveBytes <= 0 ||
    entry.archiveBytes > 1024 * 1024
  )
    throw new Error("Invalid template artifact manifest");
  const file = await open(
    join(process.cwd(), "public/hive-template-artifacts", `${entry.archiveDigest}.tar`),
    "r",
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== entry.archiveBytes)
      throw new Error("Template artifact size mismatch");
    const bytes = Buffer.alloc(entry.archiveBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (
      offset !== entry.archiveBytes ||
      createHash("sha256").update(bytes.subarray(0, offset)).digest("hex") !== entry.archiveDigest
    )
      throw new Error("Template artifact digest mismatch");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}
