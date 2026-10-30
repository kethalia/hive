import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(), run: vi.fn() }));
vi.mock("@hive/db/cloudflare", () => ({ createCloudflareDatabaseRequest: calls.create }));
vi.mock("../../../../services/auth/src/auth/rotation-scheduler", () => ({
  runCredentialRotation: calls.run,
}));

import worker from "../../../../deploy/cloudflare/auth/worker";

beforeEach(() => {
  vi.clearAllMocks();
  calls.close.mockResolvedValue(undefined);
  calls.create.mockReturnValue({ run: (f: () => unknown) => f(), close: calls.close });
});
it("rotation scheduled activation is exact and default-off before database construction", async () => {
  for (const value of [undefined, "false", "TRUE"])
    await worker.scheduled({}, { HIVE_TOKEN_ROTATION_ENABLED: value });
  expect(calls.create).not.toHaveBeenCalled();
});
it("auth worker awaits rotation inside its request scope and closes even on sanitized failure", async () => {
  calls.run.mockImplementation(async () => {
    expect(calls.close).not.toHaveBeenCalled();
    throw new Error("private credential detail");
  });
  await expect(worker.scheduled({}, { HIVE_TOKEN_ROTATION_ENABLED: "true" })).rejects.toThrow(
    "Credential rotation unavailable",
  );
  expect(calls.close).toHaveBeenCalledOnce();
});
