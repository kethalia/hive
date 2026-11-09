import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/templates/artifact-manifest.json", async () => {
  const { createHash } = await import("node:crypto");
  return {
    default: {
      schemaVersion: 1,
      templates: {
        "ai-dev-k8s": {
          archiveDigest: createHash("sha256").update("verified-tar").digest("hex"),
          archiveBytes: 12,
        },
      },
    },
  };
});

import { readTemplateArtifact } from "@/lib/templates/artifact.node";

describe("Node build artifact reader", () => {
  let root: string;
  const cwd = process.cwd;
  const digest = createHash("sha256").update("verified-tar").digest("hex");
  const asset = () => join(root, "public/hive-template-artifacts", `${digest}.tar`);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hive-node-artifact-"));
    process.cwd = () => root;
    await mkdir(join(root, "public/hive-template-artifacts"), { recursive: true });
  });
  afterEach(async () => {
    process.cwd = cwd;
    await rm(root, { recursive: true, force: true });
  });
  it("returns exact reviewed bytes with no runtime templates directory", async () => {
    await writeFile(asset(), "verified-tar");
    expect(await readTemplateArtifact("ai-dev-k8s")).toEqual(Buffer.from("verified-tar"));
  });
  it("rejects unknown, missing, altered and oversized inputs", async () => {
    await expect(readTemplateArtifact("../ai-dev-k8s")).rejects.toThrow("Unknown");
    await expect(readTemplateArtifact("ai-dev-k8s")).rejects.toThrow();
    await writeFile(asset(), "modified-tar");
    await expect(readTemplateArtifact("ai-dev-k8s")).rejects.toThrow("digest");
    await writeFile(asset(), Buffer.alloc(1024 * 1024 + 1));
    await expect(readTemplateArtifact("ai-dev-k8s")).rejects.toThrow("size");
  });
});
