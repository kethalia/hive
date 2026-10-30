import { afterEach, beforeEach, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({
  template: vi.fn(),
  notification: vi.fn(),
  rotation: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock("@/lib/templates/push-queue", () => ({ createTemplatePushWorker: workers.template }));
vi.mock("@/lib/push/event-queue", () => ({ createNotificationWorker: workers.notification }));
vi.mock("@/lib/queue/token-rotation", () => ({
  createTokenRotationWorker: workers.rotation,
  scheduleTokenRotation: workers.schedule,
}));

import { register } from "@/instrumentation";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("HIVE_DISABLE_BACKGROUND_WORKERS", "false");
  vi.stubEnv("HIVE_DISABLE_TOKEN_ROTATION_WORKER", "false");
});
afterEach(() => vi.unstubAllEnvs());
it("selective rotation cutover preserves template and notification workers", async () => {
  vi.stubEnv("HIVE_DISABLE_TOKEN_ROTATION_WORKER", "true");
  await register();
  expect(workers.template).toHaveBeenCalledOnce();
  expect(workers.notification).toHaveBeenCalledOnce();
  expect(workers.rotation).not.toHaveBeenCalled();
  expect(workers.schedule).not.toHaveBeenCalled();
});
it("default Node startup retains all legacy workers and the rotation schedule", async () => {
  await register();
  for (const worker of Object.values(workers)) expect(worker).toHaveBeenCalledOnce();
});
it("the global switch still disables every background worker", async () => {
  vi.stubEnv("HIVE_DISABLE_BACKGROUND_WORKERS", "true");
  await register();
  for (const worker of Object.values(workers)) expect(worker).not.toHaveBeenCalled();
});
