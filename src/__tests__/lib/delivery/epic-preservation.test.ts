import { createHash } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/lib/delivery/release-evidence.server", () => ({ verifyReleaseEvidence: mocks.verify }));
vi.mock("@/lib/delivery/repository-policy.server", () => ({ repositoryPolicyStore: () => ({}) }));

import { preserveEpicTask } from "@/lib/delivery/epic-preservation.server";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
it("writes and reads back bounded evidence and records local session identity only", async () => {
  mocks.verify.mockResolvedValue(true);
  const binding = { workspaceId: u(4), buildId: u(5), nativeThreadId: "thread" };
  const task = {
    id: u(3),
    projectId: u(6),
    sourceSha: "a".repeat(40),
    managerBinding: binding,
    conversation: binding,
    currentSourceRevision: { headSha: "a".repeat(40) },
    project: { providerRepositoryId: "123" },
  };
  let artifactDigest = "",
    sessionDigest = "";
  const tx = {
    deliveryTask: { findMany: async () => [task] },
    deliveryEvent: { findMany: async () => [{ id: u(7), report: { summary: "done" } }] },
    deliveryEvidence: { findMany: async () => [{ id: u(8), status: "passed" }] },
    $executeRaw: async (_strings: unknown, ...args: unknown[]) => {
      artifactDigest = String(args[6]);
      sessionDigest = String(args[7]);
    },
    $queryRaw: async () => [{ artifact_digest: artifactDigest, session_digest: sessionDigest }],
  };
  const db = {
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  let payload: Record<string, unknown> = {};
  const store = {
    writeAndVerify: async (_key: string, bytes: Uint8Array, digest: string) => {
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
      payload = JSON.parse(new TextDecoder().decode(bytes));
      return { contentDigest: digest, size: bytes.length };
    },
  };
  const result = await preserveEpicTask(db, store, u(1), u(2), u(9));
  expect(result.artifactDigest).toBe(artifactDigest);
  expect(payload.session).toMatchObject({
    nativeThreadId: "thread",
    retention: "local-session-directory",
  });
  expect(payload.events).toHaveLength(1);
  expect(payload.evidence).toHaveLength(1);
});
