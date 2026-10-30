import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  close: vi.fn(),
  dispatch: vi.fn(),
  send: vi.fn(),
  reconcile: vi.fn(),
  token: vi.fn(),
  tokenSend: vi.fn(),
  templates: vi.fn(),
  db: {},
}));
vi.mock("@hive/db", () => ({ getDb: () => calls.db }));
vi.mock("@hive/db/cloudflare", () => ({
  createCloudflareDatabaseRequest: (...args: unknown[]) => calls.create(...args),
}));
vi.mock("@/lib/delivery/dispatch", () => ({
  dispatchNotificationBatch: (...args: unknown[]) => calls.dispatch(...args),
  sendDeliveryPush: (...args: unknown[]) => calls.send(...args),
}));

vi.mock("@/lib/projects/task.server", () => ({
  reconcileProjectTasks: (...args: unknown[]) => calls.reconcile(...args),
}));
vi.mock("@/lib/auth/rotation-notices", () => ({
  dispatchTokenWarnings: (...args: unknown[]) => calls.token(...args),
  sendTokenWarning: (...args: unknown[]) => calls.tokenSend(...args),
}));
vi.mock("../../../../deploy/cloudflare/jobs/template-publications", () => ({
  dispatchTemplatePublication: (...args: unknown[]) => calls.templates(...args),
}));

import worker, { dispatchScheduled } from "../../../../deploy/cloudflare/jobs/worker";

beforeEach(() => {
  vi.clearAllMocks();
  calls.close.mockResolvedValue(undefined);
  calls.create.mockReturnValue({ run: (run: () => unknown) => run(), close: calls.close });
  calls.templates.mockResolvedValue({ enabled: false });
});
describe("scheduled delivery Worker lifetime", () => {
  it("requires explicit activation before creating a database context", async () => {
    expect(await dispatchScheduled({})).toEqual({ enabled: false });
    expect(calls.create).not.toHaveBeenCalled();
    expect((await worker.fetch()).status).toBe(404);
  });
  it("keeps the database open through provider delivery and closes after completion", async () => {
    calls.send.mockResolvedValue("delivered");
    calls.dispatch.mockImplementation(async (db, send) => {
      expect(calls.close).not.toHaveBeenCalled();
      expect(db).toBe(calls.db);
      await send("fixture-owner", { title: "Fixture" });
      expect(calls.close).not.toHaveBeenCalled();
      return { delivered: 1, retry: 0, failed: 0, stale: 0 };
    });
    expect(
      await dispatchScheduled({
        HIVE_DELIVERY_DISPATCH_ENABLED: "true",
        DATABASE_URL: "fixture-url",
        VAPID_SUBJECT: "mailto:fixture@example.invalid",
      }),
    ).toMatchObject({ enabled: true, delivered: 1 });
    expect(calls.send).toHaveBeenCalledWith(
      calls.db,
      "fixture-owner",
      { title: "Fixture" },
      "mailto:fixture@example.invalid",
    );
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it("reconciles accepted project work without a browser or push activation", async () => {
    calls.reconcile.mockImplementation(async () => {
      expect(calls.close).not.toHaveBeenCalled();
      return { enabled: true, processed: 1, retry: 0, stale: 0 };
    });
    expect(await dispatchScheduled({ HIVE_PROJECT_TASKS_ENABLED: "true" })).toMatchObject({
      enabled: true,
      projectTasks: { processed: 1 },
    });
    expect(calls.dispatch).not.toHaveBeenCalled();
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it("dispatches token metadata independently without asking the jobs Worker for auth secrets", async () => {
    calls.token.mockImplementation(async (db, send) => {
      expect(db).toBe(calls.db);
      expect(calls.close).not.toHaveBeenCalled();
      await send("owner", { kind: "token" });
      return { delivered: 1 };
    });
    expect(
      await dispatchScheduled({
        HIVE_TOKEN_WARNING_DISPATCH_ENABLED: "true",
        VAPID_SUBJECT: "mailto:fixture@example.invalid",
      }),
    ).toMatchObject({ tokenWarnings: { delivered: 1 } });
    expect(calls.tokenSend).toHaveBeenCalledWith(
      calls.db,
      "owner",
      { kind: "token" },
      "mailto:fixture@example.invalid",
    );
    expect(calls.dispatch).not.toHaveBeenCalled();
    expect(calls.reconcile).not.toHaveBeenCalled();
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it("does not strand preparation when notification dispatch fails", async () => {
    calls.dispatch.mockRejectedValue(new Error("provider failure"));
    calls.reconcile.mockResolvedValue({ enabled: true, processed: 1 });
    await expect(
      dispatchScheduled({
        HIVE_PROJECT_TASKS_ENABLED: "true",
        HIVE_DELIVERY_DISPATCH_ENABLED: "true",
      }),
    ).rejects.toThrow();
    expect(calls.reconcile).toHaveBeenCalledOnce();
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it("closes failed invocations without exposing database/provider error details", async () => {
    calls.dispatch.mockRejectedValue(new Error("private database details"));
    await expect(worker.scheduled({}, { HIVE_DELIVERY_DISPATCH_ENABLED: "true" })).rejects.toThrow(
      "Delivery dispatch unavailable",
    );
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it("awaits template work alongside failed notifications before closing the database", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    calls.dispatch.mockRejectedValue(new Error("push provider"));
    calls.templates.mockImplementation(async (db, env) => {
      expect(db).toBe(calls.db);
      expect(env.HIVE_TEMPLATE_PUBLICATION_ENABLED).toBe("true");
      await pending;
      expect(calls.close).not.toHaveBeenCalled();
      return { enabled: true, claimed: 1, progressed: 1, heldOrDeferred: 0 };
    });
    const work = dispatchScheduled({
      HIVE_DELIVERY_DISPATCH_ENABLED: "true",
      HIVE_TEMPLATE_PUBLICATION_ENABLED: "true",
    });
    const rejection = expect(work).rejects.toThrow("durable dispatch");
    await Promise.resolve();
    expect(calls.close).not.toHaveBeenCalled();
    finish?.();
    await rejection;
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it("allows a template-only wake and returns only its aggregate result", async () => {
    calls.templates.mockResolvedValue({
      enabled: true,
      claimed: 1,
      progressed: 0,
      heldOrDeferred: 1,
    });
    expect(await dispatchScheduled({ HIVE_TEMPLATE_PUBLICATION_ENABLED: "true" })).toEqual({
      enabled: true,
      templatePublications: { enabled: true, claimed: 1, progressed: 0, heldOrDeferred: 1 },
    });
    expect(calls.dispatch).not.toHaveBeenCalled();
    expect(calls.reconcile).not.toHaveBeenCalled();
    expect(calls.close).toHaveBeenCalledOnce();
  });
});
