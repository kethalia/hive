import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { $queryRaw: vi.fn() },
  create: vi.fn(),
  close: vi.fn(),
  run: vi.fn(),
  jobs: vi.fn(),
  events: vi.fn(),
  notices: vi.fn(),
  rotation: vi.fn(),
  cleanup: vi.fn(),
  wake: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@hive/db", () => ({ getDb: () => mocks.db }));
vi.mock("@hive/db/cloudflare", () => ({ createCloudflareDatabaseRequest: mocks.create }));
vi.mock("@/lib/templates/publication-service", () => ({ dispatchTemplateJobs: mocks.jobs }));
vi.mock("@/lib/push/agent-events", () => ({ dispatchAgentEvents: mocks.events }));
vi.mock("@/lib/templates/publication-notices", () => ({ dispatchTemplateNotices: mocks.notices }));
vi.mock("@/lib/queue/token-rotation-cloudflare.server", () => ({
  dispatchLegacyTokenRotation: mocks.rotation,
}));
vi.mock("@/lib/terminal/diagnostics.server", () => ({ cleanupTerminalDiagnostics: mocks.cleanup }));
vi.mock("@/lib/queue/background-wake.server", () => ({ wakeBackground: mocks.wake }));
vi.mock("@/lib/push/bounded-send", () => ({ sendBoundedPush: mocks.send }));

import {
  type BackgroundEnvironment,
  dispatchBackground,
  repairBackground,
} from "../../../deploy/cloudflare/native/background";

const owner = "10000000-0000-4000-8000-000000000001";
const env: BackgroundEnvironment = {
  HIVE_NATIVE_MODE: "preview",
  HIVE_DATABASE_NAME: "hive_foundation_preview",
  HIVE_DATABASE_ROLE: "hive_foundation_runtime",
  DATABASE_URL: "postgresql://hive_foundation_runtime:fixture@localhost/hive_foundation_preview",
  HIVE_PUBLIC_ORIGIN: "https://fixture.workers.dev",
  ASSETS: { fetch: vi.fn() },
  BACKGROUND: { getByName: vi.fn() },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.run.mockImplementation(async (run: () => Promise<unknown>) => run());
  mocks.create.mockReturnValue({ run: mocks.run, close: mocks.close });
  mocks.db.$queryRaw.mockResolvedValue([{ at: null }]);
});
afterEach(() => vi.restoreAllMocks());
describe("background scope and drained queue boundaries", () => {
  it.each([
    { HIVE_NATIVE_MODE: "bootstrap" },
    { HIVE_NATIVE_MODE: "production" },
    { DATABASE_URL: "postgresql://hive_production_runtime:fixture@localhost/hive_production" },
    { HIVE_DATABASE_ROLE: "owner" },
    { HIVE_DATABASE_NAME: "hive_production" },
    { HIVE_PUBLIC_ORIGIN: "https://hive.kethalia.com" },
    { DATABASE_URL: "not a database URL" },
  ])("holds inherited or mismatched scope before opening any database: %j", async (change) => {
    await expect(dispatchBackground({ ...env, ...change }, owner)).rejects.toThrow(
      "Deployment environment unavailable",
    );
    await expect(repairBackground({ ...env, ...change })).rejects.toThrow(
      "Deployment environment unavailable",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.jobs).not.toHaveBeenCalled();
  });
  it("passes only the current owner to all queues and closes the database after the due read", async () => {
    const next = new Date(Date.now() + 60000);
    mocks.db.$queryRaw.mockResolvedValue([{ at: next }]);
    expect(await dispatchBackground(env, owner)).toBe(next.getTime());
    expect(mocks.jobs).toHaveBeenCalledWith(
      mocks.db,
      env.ASSETS,
      expect.objectContaining({ ownerId: owner }),
    );
    expect(mocks.events).toHaveBeenCalledWith(
      mocks.db,
      expect.any(Function),
      expect.objectContaining({ ownerId: owner }),
    );
    expect(mocks.notices).toHaveBeenCalledWith(
      mocks.db,
      env.HIVE_PUBLIC_ORIGIN,
      expect.objectContaining({ ownerId: owner }),
    );
    expect(mocks.rotation).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({ ownerId: owner }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0],
    );
  });
  it("drains a failed first queue, runs the remaining queues, then closes and preserves failure", async () => {
    let release!: () => void;
    mocks.jobs.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          release = () => reject(Error("failed job"));
        }),
    );
    const work = dispatchBackground(env, owner);
    const rejected = expect(work).rejects.toThrow("Background dispatch incomplete");
    await vi.waitFor(() => expect(mocks.jobs).toHaveBeenCalledOnce());
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.events).not.toHaveBeenCalled();
    release();
    await rejected;
    expect(mocks.events).toHaveBeenCalledOnce();
    expect(mocks.notices).toHaveBeenCalledOnce();
    expect(mocks.rotation).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("continues later repair pages after one actor rejects and drains before closing", async () => {
    const owners = Array.from({ length: 51 }, (_, i) => ({
      ownerId: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    }));
    mocks.db.$queryRaw
      .mockResolvedValueOnce(owners.slice(0, 50))
      .mockResolvedValueOnce(owners.slice(50));
    mocks.wake.mockRejectedValueOnce(Error("unavailable actor"));
    await expect(repairBackground(env)).rejects.toThrow("Background repair incomplete");
    expect(mocks.wake).toHaveBeenCalledTimes(51);
    expect(mocks.wake).toHaveBeenLastCalledWith(env, owners[50].ownerId);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0],
    );
  });
});
