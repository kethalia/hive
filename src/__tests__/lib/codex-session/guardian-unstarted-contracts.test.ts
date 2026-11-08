import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  guardianRemountEnrollments,
  guardianTransferContinuationSchema,
} from "@/lib/codex-session/guardian-remount-contracts";
import {
  verifyUnstartedCoderLifecycle,
  verifyUnusedEpochCoderLifecycle,
} from "@/lib/codex-session/guardian-unstarted-contracts";

describe("exact unused-reservation Coder lifecycle", () => {
  const scope = { workspaceId: randomUUID(), oldBuildId: randomUUID(), newBuildId: randomUUID() };
  const rows = [
    {
      id: scope.newBuildId,
      workspace_id: scope.workspaceId,
      build_number: 12,
      transition: "start",
      status: "running",
      job: { status: "succeeded" },
    },
    {
      id: randomUUID(),
      workspace_id: scope.workspaceId,
      build_number: 11,
      transition: "stop",
      status: "stopped",
      job: { status: "succeeded" },
    },
    {
      id: scope.oldBuildId,
      workspace_id: scope.workspaceId,
      build_number: 10,
      transition: "start",
      status: "running",
      job: { status: "succeeded" },
    },
  ];
  it("allows exactly one known unused stop/start pair and rejects missing/extra/foreign hops", () => {
    const heldBuildId = randomUUID(),
      held = { ...rows[0], id: heldBuildId, build_number: 12 };
    const chain = [
      { ...rows[0], build_number: 14 },
      { ...rows[1], id: randomUUID(), build_number: 13 },
      held,
      ...rows.slice(1),
    ];
    const extended = { ...scope, heldBuildId };
    expect(verifyUnusedEpochCoderLifecycle(chain, extended)).toBe(true);
    expect(
      verifyUnusedEpochCoderLifecycle(
        chain.filter((r) => r.build_number !== 13),
        extended,
      ),
    ).toBe(false);
    expect(
      verifyUnusedEpochCoderLifecycle(
        chain.map((r) => (r.id === heldBuildId ? { ...r, workspace_id: randomUUID() } : r)),
        extended,
      ),
    ).toBe(false);
    expect(
      verifyUnusedEpochCoderLifecycle(
        [{ ...rows[0], id: randomUUID(), build_number: 15 }, ...chain],
        extended,
      ),
    ).toBe(false);
    expect(verifyUnusedEpochCoderLifecycle(chain, { ...extended, heldBuildId: randomUUID() })).toBe(
      false,
    );
  });
  it("leaves operator remount enrollment absent by default and rejects malformed or unbounded inputs", () => {
    expect(guardianRemountEnrollments({})).toEqual([]);
    expect(() =>
      guardianRemountEnrollments({ HIVE_GUARDIAN_REMOUNT_ATTESTATIONS_JSON: "not-json" }),
    ).toThrow();
    expect(() =>
      guardianRemountEnrollments({
        HIVE_GUARDIAN_REMOUNT_ATTESTATIONS_JSON: JSON.stringify(Array(9).fill({})),
      }),
    ).toThrow();
    expect(
      guardianTransferContinuationSchema.safeParse({ schemaVersion: 2, unusedEpochHop: [] })
        .success,
    ).toBe(false);
  });
  it("accepts a normal consecutive stopped/restarted predecessor whose historical start still says running", () => {
    expect(verifyUnstartedCoderLifecycle(rows, scope)).toBe(true);
  });
  it.each([
    "no_stop",
    "failed_stop",
    "intervening_start",
    "foreign_workspace",
    "duplicate_number",
    "wrong_successor",
    "newer_build",
  ] as const)("holds %s", (mode) => {
    const input = structuredClone(rows);
    if (mode === "no_stop") input.splice(1, 1);
    if (mode === "failed_stop") input[1].job.status = "failed";
    if (mode === "intervening_start") input[1].transition = "start";
    if (mode === "foreign_workspace") input[1].workspace_id = randomUUID();
    if (mode === "duplicate_number") input[1].build_number = input[0].build_number;
    if (mode === "wrong_successor") input[0].id = randomUUID();
    if (mode === "newer_build") input.unshift({ ...input[0], id: randomUUID(), build_number: 13 });
    expect(verifyUnstartedCoderLifecycle(input, scope)).toBe(false);
  });
});
