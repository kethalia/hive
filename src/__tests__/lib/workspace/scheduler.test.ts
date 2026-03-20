import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startCleanupScheduler } from "@/lib/workspace/scheduler";

// ── Mocks ────────────────────────────────────────────────────────

// Mock cleanupWorkspace so we can track calls without real side effects
vi.mock("@/lib/workspace/cleanup", () => ({
  cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import { cleanupWorkspace } from "@/lib/workspace/cleanup";

const mockCleanup = vi.mocked(cleanupWorkspace);

function makeMockDb(workspaces: unknown[] = []) {
  return {
    workspace: {
      findMany: vi.fn().mockResolvedValue(workspaces),
    },
  } as any;
}

function makeMockClient() {
  return {} as any; // CoderClient — passed through to cleanupWorkspace
}

function staleWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-db-1",
    taskId: "task-1",
    coderWorkspaceId: "coder-ws-1",
    status: "running",
    task: {
      id: "task-1",
      status: "done",
      updatedAt: new Date("2020-01-01"),
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("startCleanupScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCleanup.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sweeps and cleans stale workspaces with terminal task status", async () => {
    const ws1 = staleWorkspace();
    const ws2 = staleWorkspace({
      id: "ws-db-2",
      coderWorkspaceId: "coder-ws-2",
      task: { id: "task-2", status: "failed", updatedAt: new Date("2020-01-01") },
    });
    const db = makeMockDb([ws1, ws2]);
    const client = makeMockClient();

    const handle = startCleanupScheduler(client, db, {
      intervalMs: 60_000,
      graceMs: 1_000,
    });

    // Flush the immediate sweep (microtask)
    await vi.advanceTimersByTimeAsync(0);

    expect(db.workspace.findMany).toHaveBeenCalledOnce();
    expect(mockCleanup).toHaveBeenCalledTimes(2);
    expect(mockCleanup).toHaveBeenCalledWith(client, "coder-ws-1", 0, db);
    expect(mockCleanup).toHaveBeenCalledWith(client, "coder-ws-2", 0, db);

    handle.stop();
  });

  it("skips workspaces for running/queued/verifying tasks", async () => {
    // The DB query filters these out, so findMany returns empty
    const db = makeMockDb([]);
    const client = makeMockClient();

    const handle = startCleanupScheduler(client, db, {
      intervalMs: 60_000,
      graceMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(db.workspace.findMany).toHaveBeenCalledOnce();
    // Verify the query filter includes terminal statuses only
    const findManyArgs = db.workspace.findMany.mock.calls[0][0];
    expect(findManyArgs.where.task.status.in).toEqual(["done", "failed"]);
    expect(mockCleanup).not.toHaveBeenCalled();

    handle.stop();
  });

  it("skips already-deleted workspaces via query filter", async () => {
    const db = makeMockDb([]);
    const client = makeMockClient();

    const handle = startCleanupScheduler(client, db, {
      intervalMs: 60_000,
      graceMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);

    const findManyArgs = db.workspace.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status.not).toBe("deleted");
    expect(mockCleanup).not.toHaveBeenCalled();

    handle.stop();
  });

  it("handles cleanup errors gracefully — logs and continues", async () => {
    const ws1 = staleWorkspace();
    const ws2 = staleWorkspace({
      id: "ws-db-2",
      coderWorkspaceId: "coder-ws-2",
    });

    mockCleanup
      .mockRejectedValueOnce(new Error("API timeout"))
      .mockResolvedValueOnce(undefined);

    const db = makeMockDb([ws1, ws2]);
    const client = makeMockClient();

    const handle = startCleanupScheduler(client, db, {
      intervalMs: 60_000,
      graceMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Both workspaces were attempted despite first failing
    expect(mockCleanup).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to clean workspace=coder-ws-1"),
    );

    handle.stop();
  });

  it("stop() clears the interval — no more sweeps fire", async () => {
    const db = makeMockDb([]);
    const client = makeMockClient();

    const handle = startCleanupScheduler(client, db, {
      intervalMs: 10_000,
      graceMs: 1_000,
    });

    // Flush immediate sweep
    await vi.advanceTimersByTimeAsync(0);
    expect(db.workspace.findMany).toHaveBeenCalledTimes(1);

    handle.stop();

    // Advance past several intervals — no more sweeps
    await vi.advanceTimersByTimeAsync(30_000);
    expect(db.workspace.findMany).toHaveBeenCalledTimes(1);
  });

  it("runs sweeps on the configured interval", async () => {
    const db = makeMockDb([]);
    const client = makeMockClient();

    const handle = startCleanupScheduler(client, db, {
      intervalMs: 5_000,
      graceMs: 1_000,
    });

    // Immediate sweep
    await vi.advanceTimersByTimeAsync(0);
    expect(db.workspace.findMany).toHaveBeenCalledTimes(1);

    // First interval sweep
    await vi.advanceTimersByTimeAsync(5_000);
    expect(db.workspace.findMany).toHaveBeenCalledTimes(2);

    // Second interval sweep
    await vi.advanceTimersByTimeAsync(5_000);
    expect(db.workspace.findMany).toHaveBeenCalledTimes(3);

    handle.stop();
  });
});
