import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyUnstartedCoderLifecycle } from "@/lib/codex-session/guardian-unstarted-contracts";

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
