import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  prepare: vi.fn(),
  install: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/push/install", () => ({
  installNotificationHooks: mocks.install,
  prepareNotificationWorkspace: mocks.prepare,
}));
vi.mock("@hive/db", () => ({
  getDb: () => ({
    notificationSource: {
      upsert: mocks.upsert,
      updateMany: mocks.update,
      findUniqueOrThrow: mocks.read,
      deleteMany: mocks.remove,
    },
  }),
}));

import { DELETE, POST } from "@/app/api/notifications/sources/route";
import { callbackTokenHash } from "@/lib/push/source-credentials";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const request = (origin = "https://hive.test", method = "POST") =>
  new Request("https://hive.test/api/notifications/sources", {
    method,
    headers: { origin },
    body: JSON.stringify({ workspaceId }),
  });
type Source = {
  id: string;
  userId: string;
  workspaceId: string;
  workspaceName: string;
  tokenHash: string;
  pendingTokenHash: string | null;
  credentialGeneration: number;
  createdAt: Date;
};
let row: Source | null;
let remote: { generation: number; token: string };
let failStage: boolean;
let failConfirm: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COOKIE_SECRET", "test-notification-callback-secret");
  row = {
    id: "source",
    userId: "owner",
    workspaceId,
    workspaceName: "dev",
    tokenHash: "original-hash",
    pendingTokenHash: null,
    credentialGeneration: 0,
    createdAt: new Date("2026-10-16T00:00:00Z"),
  };
  remote = { generation: 0, token: "original-token" };
  failStage = false;
  failConfirm = false;
  mocks.session.mockResolvedValue({ user: { id: "owner" } });
  mocks.prepare.mockResolvedValue({ workspaceName: "dev" });
  mocks.upsert.mockImplementation(async ({ create }) => {
    row ??= { ...create, pendingTokenHash: null, credentialGeneration: 0, createdAt: new Date() };
    return { ...row };
  });
  mocks.read.mockImplementation(async () => {
    if (!row) throw new Error("Revoked");
    return { ...row };
  });
  mocks.update.mockImplementation(async ({ where, data }) => {
    if (data.pendingTokenHash && failStage) throw new Error("Database unavailable before install");
    if (data.tokenHash && failConfirm) throw new Error("Database unavailable after install");
    if (!row || Object.entries(where).some(([key, value]) => row?.[key as keyof Source] !== value))
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  mocks.remove.mockImplementation(async () => {
    row = null;
    return { count: 1 };
  });
  mocks.install.mockImplementation(async (_prepared, _url, token, version) => {
    if (version.generation >= remote.generation) remote = { generation: version.generation, token };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("workspace notification setup", () => {
  it("rejects cross-origin and unauthenticated setup", async () => {
    expect((await POST(request("https://evil.test"))).status).toBe(403);
    mocks.session.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("checks workspace ownership before staging credentials", async () => {
    mocks.prepare.mockRejectedValue(new Error("Workspace owner required"));
    expect((await POST(request())).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("stores only hashes and registers the candidate before remote installation", async () => {
    mocks.install.mockImplementationOnce(async (_prepared, url, token) => {
      expect(url).toBe("https://hive.test/api/notifications/events");
      expect(row?.tokenHash).toBe("original-hash");
      expect(row?.pendingTokenHash).toBe(callbackTokenHash(token));
      expect(JSON.stringify(row)).not.toContain(token);
    });
    expect((await POST(request())).status).toBe(200);
    expect(row?.pendingTokenHash).toBeNull();
    expect(row?.tokenHash).not.toBe("original-hash");
  });
  it("does not touch the remote credential if staging fails", async () => {
    failStage = true;
    expect((await POST(request())).status).toBe(400);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(row?.tokenHash).toBe("original-hash");
  });
  it("retains the working credential when SSH installation fails", async () => {
    mocks.install.mockRejectedValueOnce(new Error("Workspace unavailable"));
    expect((await POST(request())).status).toBe(400);
    expect(row?.tokenHash).toBe("original-hash");
    const stagedHash = row?.pendingTokenHash;
    expect((await POST(request())).status).toBe(200);
    expect(row?.tokenHash).toBe(stagedHash);
  });
  it("keeps the installed token accepted if confirmation fails, and recovers on retry", async () => {
    failConfirm = true;
    expect((await POST(request())).status).toBe(400);
    expect(callbackTokenHash(remote.token)).toBe(row?.pendingTokenHash);
    const token = remote.token;
    failConfirm = false;
    expect((await POST(request())).status).toBe(200);
    expect(remote.token).toBe(token);
    expect(row?.tokenHash).toBe(callbackTokenHash(token));
  });
  it("shares a staged token across concurrent requests and ignores late confirmations", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.install.mockImplementationOnce(async (_prepared, _url, token, version) => {
      started();
      await holdFirst;
      if (version.generation >= remote.generation)
        remote = { generation: version.generation, token };
    });
    const first = POST(request());
    await firstStarted;
    expect((await POST(request())).status).toBe(200);
    expect(mocks.install.mock.calls[0][2]).toBe(mocks.install.mock.calls[1][2]);
    expect((await POST(request())).status).toBe(200);
    const newest = remote.token;
    release();
    expect((await first).status).toBe(200);
    expect(remote.token).toBe(newest);
    expect(row?.tokenHash).toBe(callbackTokenHash(newest));
    expect(row?.credentialGeneration).toBe(2);
  });
  it("creates and stages a new connection before its first installation", async () => {
    row = null;
    expect((await POST(request())).status).toBe(200);
    expect(row).toMatchObject({ credentialGeneration: 1, pendingTokenHash: null });
  });
  it("only revokes the current user's source", async () => {
    expect((await DELETE(request("https://hive.test", "DELETE"))).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({ where: { userId: "owner", workspaceId } });
  });
});
