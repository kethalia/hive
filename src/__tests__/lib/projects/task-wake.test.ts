import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskIntentHandedOff } from "@/lib/projects/task-intents.server";
import {
  assertTaskWakeActive,
  readTaskWake,
  taskWakeApplies,
  withTaskWakeEnvironment,
} from "@/lib/projects/task-wake.server";
import {
  TASK_WAKE_DURATION_MS,
  taskWakeName,
  taskWakeReceiptSchema,
} from "@/lib/projects/task-wake-contracts";

const identity = { ownerId: randomUUID(), projectId: randomUUID(), taskId: randomUUID() };
const createdAt = Date.now();
const receipt = {
  schemaVersion: 1 as const,
  ...identity,
  createdAt,
  deadline: createdAt + TASK_WAKE_DURATION_MS,
  requests: 1,
  attempts: 0,
  phase: "active" as const,
  nextWake: createdAt + 1000,
  inFlightUntil: 0,
};
const reserve = vi.fn(),
  inspect = vi.fn();
const getByName = vi.fn(() => ({ reserve, inspect }));
const env = {
  HIVE_NATIVE_MODE: "preview",
  HIVE_NATIVE_PREVIEW_ENABLED: "true",
  HIVE_PROJECT_TASK_WAKE_ENABLED: "true",
  HIVE_PROJECT_TASK_WAKE_TASK_JSON: JSON.stringify(identity),
  HIVE_PROJECT_TASK_WAKE: { getByName },
};
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("exact-task durable wake admission", () => {
  it("recognizes retained handoff only from exact status and fully erased prompt", () => {
    const status = {
      schemaVersion: 1,
      projectId: identity.projectId,
      taskId: identity.taskId,
      phase: "awaitingRegistration",
      nativeThreadId: "known-thread",
      terminalSessionName: null,
      reason: null,
    };
    const row = {
      id: identity.taskId,
      projectId: identity.projectId,
      phase: "preparing",
      status,
      ciphertext: null,
      iv: null,
      authTag: null,
    };
    expect(taskIntentHandedOff(row)).toBe(true);
    for (const name of ["ciphertext", "iv", "authTag"] as const)
      expect(taskIntentHandedOff({ ...row, [name]: new Uint8Array([1]) })).toBe(false);
    for (const phase of ["queued", "blocked"])
      expect(taskIntentHandedOff({ ...row, phase })).toBe(false);
    expect(taskIntentHandedOff({ ...row, status: { ...status, nativeThreadId: null } })).toBe(
      false,
    );
    expect(taskIntentHandedOff({ ...row, status: { ...status, taskId: randomUUID() } })).toBe(
      false,
    );
  });

  it("holds an enabled invocation without its scoped binding context", async () => {
    vi.stubEnv("HIVE_PROJECT_TASK_WAKE_ENABLED", "true");
    await expect(readTaskWake(identity, true)).rejects.toThrow("task_wake_context_unavailable");
    expect(getByName).not.toHaveBeenCalled();
  });

  it("does no binding lookup or RPC when absent/off", async () => {
    expect(await readTaskWake(identity, true)).toBeNull();
    await withTaskWakeEnvironment({ ...env, HIVE_PROJECT_TASK_WAKE_ENABLED: "false" }, async () => {
      expect(await readTaskWake(identity, true)).toBeNull();
      expect(await readTaskWake(identity)).toBeNull();
    });
    expect(getByName).not.toHaveBeenCalled();
  });
  it("scopes call-site applicability without weakening the strict adapter", async () => {
    await withTaskWakeEnvironment(env, async () => {
      expect(taskWakeApplies(identity)).toBe(true);
      const other = { ...identity, taskId: randomUUID() };
      expect(taskWakeApplies(other)).toBe(false);
      await expect(readTaskWake(other)).rejects.toThrow("task_wake_unavailable");
    });
    expect(getByName).not.toHaveBeenCalled();
    await expect(
      withTaskWakeEnvironment({ ...env, HIVE_PROJECT_TASK_WAKE_TASK_JSON: undefined }, async () =>
        taskWakeApplies(identity),
      ),
    ).rejects.toThrow();
  });
  it("routes server identity exactly and preserves the original deadline on replay", async () => {
    reserve.mockResolvedValue(receipt);
    inspect.mockResolvedValue({ ...receipt, requests: 2 });
    await withTaskWakeEnvironment(env, async () => {
      expect(await readTaskWake(identity, true)).toEqual(receipt);
      expect((await readTaskWake(identity))?.deadline).toBe(receipt.deadline);
    });
    expect(getByName).toHaveBeenCalledWith(taskWakeName(identity));
    expect(reserve).toHaveBeenCalledWith(identity);
  });
  it("rejects foreign owner/project/task and malformed or foreign receipts", async () => {
    for (const field of ["ownerId", "projectId", "taskId"])
      await expect(
        withTaskWakeEnvironment(env, () =>
          readTaskWake({ ...identity, [field]: randomUUID() }, true),
        ),
      ).rejects.toThrow();
    expect(getByName).not.toHaveBeenCalled();
    reserve.mockResolvedValue({ ...receipt, ownerId: randomUUID() });
    await expect(
      withTaskWakeEnvironment(env, () => readTaskWake(identity, true)),
    ).rejects.toThrow();
    reserve.mockResolvedValue({ ...receipt, deadline: receipt.deadline + 1 });
    await expect(
      withTaskWakeEnvironment(env, () => readTaskWake(identity, true)),
    ).rejects.toThrow();
  });
  it("holds inactive Preview and production invocations before namespace access", async () => {
    for (const change of [
      { HIVE_NATIVE_MODE: "production" },
      { HIVE_NATIVE_PREVIEW_ENABLED: "false" },
    ])
      await expect(
        withTaskWakeEnvironment({ ...env, ...change }, () => readTaskWake(identity, true)),
      ).rejects.toThrow("task_wake_unavailable");
    expect(getByName).not.toHaveBeenCalled();
  });
  it("fails a lost reservation ACK within five seconds without retry", async () => {
    vi.useFakeTimers();
    reserve.mockReturnValue(new Promise(() => {}));
    const result = withTaskWakeEnvironment(env, () => readTaskWake(identity, true));
    const rejected = expect(result).rejects.toThrow("task_wake_unavailable");
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(reserve).toHaveBeenCalledOnce();
  });
  it("never authorizes a terminal receipt or a replay past its first deadline", () => {
    for (const phase of ["held", "running"] as const)
      expect(() => assertTaskWakeActive({ ...receipt, phase })).toThrow("task_wake_held");
    vi.useFakeTimers();
    vi.setSystemTime(receipt.deadline);
    expect(() => assertTaskWakeActive(receipt)).toThrow("task_wake_held");
    expect(taskWakeReceiptSchema.safeParse({ ...receipt, requests: 101 }).success).toBe(false);
    expect(taskWakeReceiptSchema.safeParse({ ...receipt, text: "private prompt" }).success).toBe(
      false,
    );
  });
});
