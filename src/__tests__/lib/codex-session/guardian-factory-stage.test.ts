import { expect, it, vi } from "vitest";

const failure = vi.hoisted(() => new Error("private configuration detail"));
vi.mock("@hive/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/codex-session/registered-session.server", () => ({
  registeredSessionConfig: () => {
    throw failure;
  },
}));

import { createGuardianService } from "@/lib/codex-session/guardian-factory.server";

it("labels configuration failure while preserving the original factory error", () => {
  const stages: string[] = [];
  expect(() => createGuardianService({ onProvisionStage: (stage) => stages.push(stage) })).toThrow(
    failure,
  );
  expect(stages).toEqual(["guardian_config"]);
});
