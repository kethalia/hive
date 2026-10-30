import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_RECONCILE_PATH } from "@/lib/projects/reconcile-transport";
import { dispatchProjectTaskReconciliation } from "../../../../deploy/cloudflare/jobs/project-tasks";

const secret = "b".repeat(64),
  result = { schemaVersion: 1, processed: 1, retry: 0, stale: 0 };
afterEach(() => vi.useRealTimers());
describe("app-owned project reconciliation jobs transport", () => {
  it("fails closed without the flag/binding/private key and has no caller-selected scope", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    expect(await dispatchProjectTaskReconciliation({ APP_SERVICE: { fetch } })).toEqual({
      enabled: false,
    });
    await expect(
      dispatchProjectTaskReconciliation({ HIVE_PROJECT_TASKS_ENABLED: "true" }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await dispatchProjectTaskReconciliation({
        HIVE_PROJECT_TASKS_ENABLED: "true",
        HIVE_PROJECT_TASK_RECONCILE_SECRET: secret,
        APP_SERVICE: { fetch },
      }),
    ).toEqual({ enabled: true, processed: 1, retry: 0, stale: 0 });
    expect(fetch).toHaveBeenCalledWith(
      `https://hive-app.internal${PROJECT_RECONCILE_PATH}`,
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        signal: expect.any(AbortSignal),
        body: '{"schemaVersion":1}',
      }),
    );
  });
  it("rejects redirects, oversized/foreign bodies and counts exceeding one intent", async () => {
    for (const response of [
      new Response(null, { status: 307 }),
      Response.json({ ...result, ownerId: "leak" }),
      Response.json({ ...result, retry: 1 }),
      Response.json({ data: "x".repeat(513) }),
    ])
      await expect(
        dispatchProjectTaskReconciliation({
          HIVE_PROJECT_TASKS_ENABLED: "true",
          HIVE_PROJECT_TASK_RECONCILE_SECRET: secret,
          APP_SERVICE: { fetch: vi.fn().mockResolvedValue(response) },
        }),
      ).rejects.toThrow();
  });
  it("aborts the real transport signal and awaits a late fetch rather than claiming completion", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined, release!: (value: Response) => void;
    const fetch = vi.fn().mockImplementation((_url, init) => {
      signal = init.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = dispatchProjectTaskReconciliation({
      HIVE_PROJECT_TASKS_ENABLED: "true",
      HIVE_PROJECT_TASK_RECONCILE_SECRET: secret,
      APP_SERVICE: { fetch },
    });
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60001);
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(false);
    release(Response.json(result));
    await expect(pending).rejects.toThrow();
  });
  it("rejects a stalled reply on deadline even when underlying body cancellation never settles", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const pending = dispatchProjectTaskReconciliation({
      HIVE_PROJECT_TASKS_ENABLED: "true",
      HIVE_PROJECT_TASK_RECONCILE_SECRET: secret,
      APP_SERVICE: { fetch },
    });
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60001);
    await rejected;
  });
});
