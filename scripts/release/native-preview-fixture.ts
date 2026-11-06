import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { packReleaseArtifact } from "./artifact.mjs";

// Synthetic bytes and identities only. Importing this helper registers no tests
// and makes no network calls; installed PG proofs supply their own authorities.
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const target = {
  provider: "cloudflare-native-preview",
  accountId: "225177f82b9234ede14e897fe15e0cb5",
  workerName: "hive",
  previewId: "9b772c5c22f84deeb1af85e68f819798",
  previewName: "codex/delivery-system-design",
  previewSlug: "codex-delivery-system-design",
  origin: "https://codex-delivery-system-design-hive.b00ste.workers.dev",
};
export const publicConfig = {
  mainModule: "worker.js",
  compatibilityDate: "2026-10-29",
  compatibilityFlags: ["nodejs_compat"],
  cpuMs: 100,
  placement: { region: "aws:us-east-1" },
  assets: { run_worker_first: true },
  vars: {
    HIVE_NATIVE_MODE: "preview",
    HIVE_NATIVE_PREVIEW_ENABLED: "true",
    HIVE_RELEASE_SOURCE_SHA: "{{source_sha}}",
    HIVE_RELEASE_ARTIFACT_DIGEST: "{{artifact_digest}}",
  } as Record<string, string>,
  secretNames: [
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "COOKIE_SECRET",
    "AUTH_SERVICE_SECRET",
    "HIVE_CODER_OAUTH_CLIENT_SECRET",
  ],
};
export const publisher = {
  repositoryId: "1",
  repositoryOwnerId: "2",
  runId: "9",
  runAttempt: 1,
  workflowSha: "b".repeat(40),
};
export const callerWorkflowPath = ".github/workflows/native-builder-caller.yml";
export const callerWorkflowBytes = Buffer.from(
  `name: Native builder caller\non:\n  push:\n    branches: [codex/delivery-system-design]\njobs:\n  build:\n    uses: kethalia/hive/.github/workflows/controlled-native-preview-build.yml@${"c".repeat(40)}\n`,
);
export const callerWorkflowBlobSha = createHash("sha1")
  .update(`blob ${callerWorkflowBytes.length}\0`)
  .update(callerWorkflowBytes)
  .digest("hex");
export const config = {
  controllerOrigin: "https://controller.example",
  target,
  publicConfig,
  privateBindingRevision: uuid(10),
  compatibilityRevision: uuid(12),
  bootstrapEnabled: true,
  builderPolicy: {
    owner: "kethalia",
    name: "hive",
    repositoryId: "1",
    repositoryOwnerId: "2",
    workflowId: "3",
    callerWorkflowPath,
    callerWorkflowBlobSha,
    reusableWorkflowPath: `kethalia/hive/.github/workflows/controlled-native-preview-build.yml@${"c".repeat(40)}`,
    workflowSha: "c".repeat(40),
  },
  publisherPolicy: {
    repositoryId: "1",
    repositoryOwnerId: "2",
    workflowRef: `kethalia/hive/.github/workflows/controlled-native-preview-publish.yml@${"b".repeat(40)}`,
    workflowSha: "b".repeat(40),
    ref: "refs/heads/trusted-publisher",
    contextSha: "b".repeat(40),
    audiencePrefix: "urn:hive:native-release:epic:",
  },
};
export const scope = {
  purpose: "bootstrap-baseline",
  ownerId: uuid(1),
  releaseId: uuid(2),
  artifactReleaseId: uuid(2),
  artifactId: uuid(3),
  sourceSha: "a".repeat(40),
  builderRunId: "4",
  builderRunAttempt: 1,
  builderArtifactId: "5",
};
export async function archive() {
  return packReleaseArtifact(
    new Map([
      ["app/worker.js", Buffer.from('throw Error("candidate must never execute")')],
      ["app/module.wasm", Buffer.from("wasm")],
      ["assets/index.html", Buffer.from("hello")],
      ["assets/_headers", Buffer.from("/*\n  X-Test: true")],
    ]),
  ) as Promise<Buffer>;
}
export function zipArchive(bytes: Buffer, compress = false, descriptor = false) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const data = compress ? deflateRawSync(bytes) : bytes,
    name = Buffer.from("release.tar");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(descriptor ? 8 : 0, 6);
  local.writeUInt16LE(compress ? 8 : 0, 8);
  local.writeUInt16LE(name.length, 26);
  if (!descriptor) {
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
  }
  const desc = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
  if (descriptor) {
    desc.writeUInt32LE(0x08074b50);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(data.length, 8);
    desc.writeUInt32LE(bytes.length, 12);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(descriptor ? 8 : 0, 8);
  central.writeUInt16LE(compress ? 8 : 0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length + desc.length, 16);
  return Buffer.concat([local, name, data, desc, central, name, end]);
}
