import { describe, expect, it, vi } from "vitest";
import { reconcileTaskIntents } from "@/lib/projects/task-intents.server";

function fixture() {
  return {
    claim: vi.fn().mockResolvedValue({ phase: "queued" }),
    execution: vi.fn().mockReturnValue({}),
    finish: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(undefined),
  };
}
describe("durable reconciliation cancellation", () => {
  it("does not claim after cancellation", async () => {
    const store = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      reconcileTaskIntents(store, vi.fn(), undefined, 1, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(store.claim).not.toHaveBeenCalled();
  });
  it("drains an already pending claim without starting host work or further DB operations", async () => {
    const store = fixture(),
      controller = new AbortController();
    let finishClaim!: (value: { phase: string }) => void;
    store.claim.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishClaim = resolve;
        }),
    );
    const execute = vi.fn(),
      pending = reconcileTaskIntents(store, execute, undefined, 1, { signal: controller.signal });
    controller.abort();
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishClaim({ phase: "queued" });
    await expect(pending).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });
  it.each([
    "late_success",
    "late_failure",
  ])("retains unknown durable claim after %s without acknowledging or retrying", async (kind) => {
    const store = fixture(),
      controller = new AbortController();
    const execute = vi.fn().mockImplementation(async () => {
      controller.abort();
      if (kind === "late_failure") throw new Error("unknown host outcome");
      return {};
    });
    await expect(
      reconcileTaskIntents(store, execute, undefined, 1, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(store.claim).toHaveBeenCalledTimes(1);
    expect(store.finish).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });
});
