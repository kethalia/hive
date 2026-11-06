import { describe, expect, it, vi } from "vitest";
import { reconcileTaskIntents, TaskExecutionStageError } from "@/lib/projects/task-intents.server";

function fixture() {
  return {
    claim: vi.fn().mockResolvedValue({ phase: "queued" }),
    execution: vi.fn().mockReturnValue({}),
    finish: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(undefined),
  };
}
describe("durable reconciliation cancellation", () => {
  it("classifies opaque decode and status-write failures without exposing their messages", async () => {
    const store = fixture();
    const execute = vi.fn().mockResolvedValue({});
    store.execution.mockImplementationOnce(() => {
      throw new Error("private decode secret");
    });
    await reconcileTaskIntents(store, execute, undefined, 1);
    expect(store.fail).toHaveBeenLastCalledWith(expect.anything(), "intent_read");
    expect(execute).not.toHaveBeenCalled();
    store.finish.mockRejectedValueOnce(new Error("private storage secret"));
    await reconcileTaskIntents(store, execute, undefined, 1);
    expect(store.fail).toHaveBeenLastCalledWith(expect.anything(), "status_write");
    expect(JSON.stringify(store.fail.mock.calls)).not.toContain("secret");
  });
  it.each([
    "decode",
    "finish",
  ])("does not acknowledge cancellation at the %s boundary", async (boundary) => {
    const store = fixture(),
      controller = new AbortController();
    if (boundary === "decode")
      store.execution.mockImplementation(() => {
        controller.abort();
        throw new Error("private");
      });
    else
      store.finish.mockImplementation(async () => {
        controller.abort();
        throw new Error("private");
      });
    await expect(
      reconcileTaskIntents(store, async () => ({}) as never, undefined, 1, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(store.fail).not.toHaveBeenCalled();
  });
  it("records only trusted failure stages and leaves unknown errors unclassified", async () => {
    const store = fixture();
    await reconcileTaskIntents(
      store,
      async () => {
        throw new TaskExecutionStageError("guardian");
      },
      undefined,
      1,
    );
    expect(store.fail).toHaveBeenCalledWith(expect.anything(), "guardian");
    store.fail.mockClear();
    await reconcileTaskIntents(
      store,
      async () => {
        throw new Error("secret bearer");
      },
      undefined,
      1,
    );
    expect(store.fail).toHaveBeenCalledWith(expect.anything(), undefined);
  });
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
    "late_stage_failure",
  ])("retains unknown durable claim after %s without acknowledging or retrying", async (kind) => {
    const store = fixture(),
      controller = new AbortController();
    const execute = vi.fn().mockImplementation(async () => {
      controller.abort();
      if (kind === "late_failure") throw new Error("unknown host outcome");
      if (kind === "late_stage_failure") throw new TaskExecutionStageError("guardian");
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
