import { randomUUID } from "node:crypto";
import { duplexPair } from "node:stream";
import { expect, it } from "vitest";
import {
  maintenanceReadyAuthorization,
  maintenanceReadyResponseSchema,
} from "@/lib/codex-session/account-maintenance-contracts";
import { guardianWire } from "../../../../templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs";

it("32-project maximum descriptors omit all step snapshots and cross the actual bounded guardian wire", async () => {
  for (const stepsPerTask of [1, 2, 64]) {
    const ownerIntentRuntimeId = randomUUID(),
      ownerIntentEventId = randomUUID(),
      runtimeId = randomUUID();
    const authorizations = Array.from({ length: 32 }, () => {
      const nativeReceiptEventId = randomUUID();
      const raw = {
        projectId: randomUUID(),
        nativeReceiptEventId,
        managerBindingId: randomUUID(),
        executionEpochVersion: Number.MAX_SAFE_INTEGER,
        runnable: false,
        completed: false,
        holdReason: "maintenance_previous_attempt_held" as const,
        claimContinuation: {
          ownerIntentRuntimeId,
          ownerIntentEventId,
          epochRuntimeId: runtimeId,
          nativeReceiptEventId,
          epochResumeEventId: randomUUID(),
          epochVersion: Number.MAX_SAFE_INTEGER,
          inputRequestId: randomUUID(),
        },
        taskState: [
          {
            taskId: randomUUID(),
            steps: Array.from({ length: stepsPerTask }, () => ({
              id: randomUUID(),
              kind: "validate",
              state: "pending",
              version: Number.MAX_SAFE_INTEGER,
            })),
          },
        ],
      };
      return maintenanceReadyAuthorization(raw);
    });
    const ready = maintenanceReadyResponseSchema.parse({
      ready: true,
      maintenanceId: randomUUID(),
      ownerIntentRuntimeId,
      ownerIntentEventId,
      runnableProjectIds: authorizations.map((a) => a.projectId),
      authorizations,
    });
    expect(Buffer.byteLength(JSON.stringify(authorizations))).toBeLessThanOrEqual(28000);
    const response = { ...ready, runtimeId }; // Existing outer adds this fixed runtime identity.
    const encoded = Buffer.from(
      `${JSON.stringify({
        protocolVersion: 1,
        type: "response",
        id: Number.MAX_SAFE_INTEGER,
        ok: true,
        value: response,
      })}\n`,
    );
    expect(encoded.length).toBeLessThanOrEqual(32768);
    expect(encoded.toString()).not.toContain("taskState");
    const [left, right] = duplexPair();
    let lost = 0;
    const server = guardianWire(left, { maintenanceResumeReady: async () => response }, () => {
      lost++;
    });
    const client = guardianWire(right, {}, () => {
      lost++;
    });
    try {
      expect(await client.request("maintenanceResumeReady", {}, 1000)).toEqual(response);
      expect(lost).toBe(0);
    } finally {
      server.close();
      client.close();
    }
    expect(() =>
      maintenanceReadyResponseSchema.parse({
        ...ready,
        authorizations: [...authorizations, authorizations[0]],
      }),
    ).toThrow();
  }
});
