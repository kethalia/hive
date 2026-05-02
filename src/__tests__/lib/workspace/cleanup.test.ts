import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoderClient } from "@/lib/coder/client";
import { cleanupWorkspace } from "@/lib/workspace/cleanup";

// ── Helpers ───────────────────────────────────────────────────────

function makeMockCoderClient(overrides?: Partial<Record<string, any>>) {
  return {
    stopWorkspace: vi.fn().mockResolvedValue(undefined),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CoderClient;
}

function makeMockDb() {
  return {
    workspace: {
      update: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("cleanupWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stops, deletes, and updates DB in order", async () => {
    const client = makeMockCoderClient();
    const db = makeMockDb();
    const callOrder: string[] = [];

    (client.stopWorkspace as any).mockImplementation(() => {
      callOrder.push("stop");
      return Promise.resolve();
    });
    (client.deleteWorkspace as any).mockImplementation(() => {
      callOrder.push("delete");
      return Promise.resolve();
    });
    db.workspace.update.mockImplementation(() => {
      callOrder.push("dbUpdate");
      return Promise.resolve({});
    });

    await cleanupWorkspace(client, "ws-001", 0, db);

    expect(callOrder).toEqual(["stop", "delete", "dbUpdate"]);
    expect(client.stopWorkspace).toHaveBeenCalledWith("ws-001");
    expect(client.deleteWorkspace).toHaveBeenCalledWith("ws-001");
    expect(db.workspace.update).toHaveBeenCalledWith({
      where: { coderWorkspaceId: "ws-001" },
      data: { status: "deleted" },
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[cleanup] workspace=ws-001 stopped and deleted"),
    );
  });

  it("logs error but does not throw when cleanup fails", async () => {
    const client = makeMockCoderClient({
      stopWorkspace: vi.fn().mockRejectedValue(new Error("already stopped")),
    });
    const db = makeMockDb();

    // Should not throw
    await cleanupWorkspace(client, "ws-001", 0, db);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[cleanup] workspace=ws-001 cleanup failed: already stopped"),
    );
    // deleteWorkspace should NOT have been called because stopWorkspace threw
    expect(client.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("waits the grace period before stopping", async () => {
    vi.useFakeTimers();

    const client = makeMockCoderClient();
    const db = makeMockDb();

    const promise = cleanupWorkspace(client, "ws-001", 5000, db);

    // Nothing called yet — still in grace period
    expect(client.stopWorkspace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(client.stopWorkspace).toHaveBeenCalledWith("ws-001");

    vi.useRealTimers();
  });
});
