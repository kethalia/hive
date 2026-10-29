import type { PrismaClient } from "@hive/db";
import { describe, expect, it, vi } from "vitest";
import { DeliveryRepository } from "@/lib/delivery/repository";

class SeparateRuntimeDatabaseError extends Error {
  name = "PrismaClientKnownRequestError";
  code = "P2034";
  clientVersion = "6.19.3";
}
const owner = "11111111-1111-4111-8111-111111111111";
const input = {
  projectId: owner,
  workspaceId: owner,
  nativeThreadId: "thread",
  buildId: owner,
  serverInstanceId: "server",
};

describe("database errors across generated Prisma runtimes", () => {
  it("retries a known serialization failure from a different constructor", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(new SeparateRuntimeDatabaseError("conflict"))
      .mockResolvedValueOnce({ id: "binding" });
    const repository = new DeliveryRepository({
      $transaction: transaction,
    } as unknown as PrismaClient);
    expect(await repository.bindConversation(owner, input)).toEqual({ id: "binding" });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it("bounds serialization retries and never retries an unrecognized error", async () => {
    const transaction = vi.fn().mockRejectedValue(new SeparateRuntimeDatabaseError("conflict"));
    const repository = new DeliveryRepository({
      $transaction: transaction,
    } as unknown as PrismaClient);
    await expect(repository.bindConversation(owner, input)).rejects.toThrow("conflict");
    expect(transaction).toHaveBeenCalledTimes(3);
    transaction
      .mockClear()
      .mockRejectedValue(Object.assign(new Error("unknown"), { code: "P2034" }));
    await expect(repository.bindConversation(owner, input)).rejects.toThrow("unknown");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("recognizes only exact replay keys in the observed workerd adapter constraint shape", async () => {
    const task = {
      schemaVersion: 1,
      eventId: owner,
      id: owner,
      projectId: owner,
      outcome: "Fixture",
      branch: "fixture",
      sourceSha: "a".repeat(40),
      steps: [
        { id: owner, kind: "validate", criterionIds: ["C1"], requiredEvidenceKinds: ["check"] },
      ],
    };
    for (const [modelName, fields, shouldLookUpReplay] of [
      ["DeliveryTask", ["id"], true],
      ["Session", ["session_id"], false],
      ["DeliveryTask", ["unknown_key"], false],
    ] as const) {
      const error = Object.assign(new SeparateRuntimeDatabaseError("constraint"), {
        code: "P2002",
        meta: {
          modelName,
          driverAdapterError: {
            name: "DriverAdapterError",
            cause: { kind: "UniqueConstraintViolation", constraint: { fields } },
          },
        },
      });
      const findUnique = vi.fn().mockResolvedValue(null);
      const repository = new DeliveryRepository({
        $transaction: vi.fn().mockRejectedValue(error),
        deliveryEvent: { findUnique },
      } as unknown as PrismaClient);
      await expect(repository.createTask(owner, task)).rejects.toBe(error);
      expect(findUnique).toHaveBeenCalledTimes(shouldLookUpReplay ? 1 : 0);
    }
  });
});
