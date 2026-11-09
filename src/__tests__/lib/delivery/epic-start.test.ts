import type { Prisma, PrismaClient } from "@hive/db";
import { expect, it, vi } from "vitest";
import { epicDigest } from "@/lib/delivery/epic-contracts";
import { reserveEpicStart } from "@/lib/delivery/epic-start.server";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = {
  intentId: u(3),
  requestId: u(4),
  workspaceId: u(5),
  expectedRevision: "c".repeat(40),
  textDigest: "d".repeat(64),
  criteria: ["a"],
  dependsOn: [],
  role: "implementation",
};
const plan = {
  schemaVersion: 1,
  epicId: u(1),
  projectId: u(2),
  ownerIntentDigest: "a".repeat(64),
  outcomeDigest: "b".repeat(64),
  criteria: ["a"],
  version: 1,
  previousPlanDigest: null,
  maxConcurrentTasks: 1,
  tasks: [
    node,
    { ...node, intentId: u(6), requestId: u(7), role: "integration", dependsOn: [u(3)] },
  ],
};
const policy = {
  schemaVersion: 1,
  workspaces: [
    {
      ownerId: u(9),
      workspaceId: u(5),
      buildId: u(8),
      isolationDomain: "pvc-1",
      validUntil: 2000000000000,
    },
  ],
};
function transaction(starts: unknown[] = []) {
  const query = vi
    .fn()
    .mockImplementation((query) =>
      Promise.resolve(
        String(query).includes("clock_timestamp") ? [{ now: new Date(1900000000000) }] : [],
      ),
    )
    .mockResolvedValueOnce([{ plan, plan_digest: epicDigest(plan) }])
    .mockResolvedValueOnce([{ now: new Date(1900000000000) }])
    .mockResolvedValueOnce(starts);
  const execute = vi.fn().mockResolvedValue(1);
  return {
    tx: { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient,
    execute,
  };
}
const db = {} as PrismaClient;
it("reserves an enrolled workspace before preparation and replays the same reservation", async () => {
  const first = transaction();
  expect((await reserveEpicStart(first.tx, db, u(9), u(1), u(3), policy)).replayed).toBe(false);
  expect(first.execute).toHaveBeenCalledOnce();
  const replay = transaction([
    {
      intent_id: u(3),
      workspace_id: u(5),
      build_id: u(8),
      isolation_domain: "pvc-1",
      phase: "accepted",
    },
  ]);
  expect((await reserveEpicStart(replay.tx, db, u(9), u(1), u(3), policy)).replayed).toBe(true);
  expect(replay.execute).not.toHaveBeenCalled();
});
it("holds capacity and rejects expired or changed enrollment", async () => {
  const busy = transaction([{ intent_id: u(6), phase: "accepted" }]);
  await expect(reserveEpicStart(busy.tx, db, u(9), u(1), u(3), policy)).rejects.toThrow(
    "epic_wip_limit",
  );
  const expired = transaction();
  await expect(
    reserveEpicStart(expired.tx, db, u(9), u(1), u(3), {
      ...policy,
      workspaces: [{ ...policy.workspaces[0], validUntil: 1 }],
    }),
  ).rejects.toThrow("epic_isolation_unverified");
  const changed = transaction([
    {
      intent_id: u(3),
      workspace_id: u(5),
      build_id: u(8),
      isolation_domain: "different",
      phase: "reserved",
    },
  ]);
  await expect(reserveEpicStart(changed.tx, db, u(9), u(1), u(3), policy)).rejects.toThrow(
    "epic_start_changed",
  );
});
