import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/codex-session/registration.server", () => ({
  resolveVerifiedWorkspaceHost: mocks.resolve,
}));
vi.mock("@/lib/agents/portable-client.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agents/portable-client.server")>();
  return {
    ...original,
    AgentBridgeClient: class {
      execute = mocks.execute;
    },
  };
});

import {
  AgentBridgeService,
  type AgentBridgeServiceConfig,
} from "@/lib/agents/portable-service.server";

const principal = { hiveUserId: randomUUID(), coderUserId: randomUUID() },
  workspaceId = randomUUID(),
  templateId = randomUUID();
const binding = {
  coderOrigin: "https://coder.example",
  hiveUserId: principal.hiveUserId,
  ownerId: principal.coderUserId,
  workspaceId,
  buildId: randomUUID(),
  agentId: randomUUID(),
  templateId,
  appOrigin: "https://agent.example",
  appId: randomUUID(),
};
const config: AgentBridgeServiceConfig = {
  issuer: "https://hive.example",
  keyId: "test",
  privateKeyPem: "fixture",
  pins: [
    {
      templateId,
      profile: "software",
      manifestSha256: "a".repeat(64),
      helperSha256: "b".repeat(64),
    },
  ],
  cookieDomains: [],
  home: "/home/coder",
};
const deps = {
  coderForPrincipal: vi.fn().mockResolvedValue({}),
  transport: vi.fn().mockReturnValue(() => Promise.reject(new Error())),
};
const service = new AgentBridgeService(config, deps);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ binding });
  mocks.execute.mockResolvedValue({ message: "done" });
});
describe("portable agent authority", () => {
  it.each([
    {
      operation: "claude-account" as const,
      account: {
        action: "code" as const,
        lifetimeId: randomUUID(),
        generation: 1,
        code: "PRIVATE_CODE#STATE",
      },
    },
    { operation: "rename-terminal-session" as const, oldName: "one", newName: "two" },
    { operation: "kill-terminal-session" as const, sessionName: "one" },
    {
      operation: "codex-account" as const,
      account: { action: "connect" as const, lifetimeId: randomUUID(), generation: 0 },
    },
  ])("preserves owner/build denial for $operation", async (request) => {
    mocks.resolve.mockRejectedValueOnce(Error("owner denied"));
    await expect(service.execute(principal, workspaceId, request)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    mocks.resolve
      .mockResolvedValueOnce({ binding })
      .mockResolvedValueOnce({ binding: { ...binding, buildId: randomUUID() } });
    await expect(service.execute(principal, workspaceId, request)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("resolves owner-only app and matching build before and after a mutation", async () => {
    expect(await service.execute(principal, workspaceId, { operation: "install" })).toEqual({
      message: "done",
    });
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve.mock.calls[0][0]).toMatchObject({
      appSlug: "hive-agent",
      gatewayPort: 13344,
      softwareTemplateIds: [templateId],
    });
    expect(mocks.resolve.mock.calls[1][4]).toBe(binding.agentId);
  });
  it("does not submit when authorization fails", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("owner mismatch"));
    await expect(
      service.execute(principal, workspaceId, { operation: "install" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("reports unknown mutation outcome if the build changes after execution", async () => {
    mocks.resolve
      .mockResolvedValueOnce({ binding })
      .mockResolvedValueOnce({ binding: { ...binding, buildId: randomUUID() } });
    await expect(
      service.execute(principal, workspaceId, { operation: "install" }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("fails closed on a changed binding after a read", async () => {
    mocks.resolve
      .mockResolvedValueOnce({ binding })
      .mockResolvedValueOnce({ binding: { ...binding, appId: randomUUID() } });
    await expect(
      service.execute(principal, workspaceId, { operation: "sessions" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("notification installation retains mutation uncertainty after a build replacement", async () => {
    mocks.resolve
      .mockResolvedValueOnce({ binding })
      .mockResolvedValueOnce({ binding: { ...binding, buildId: randomUUID() } });
    mocks.execute.mockResolvedValueOnce({
      sourceId: randomUUID(),
      generation: 1,
      createdAt: "2026-11-06T00:00:00.000Z",
      credentialHash: "a".repeat(64),
      callbackOrigin: config.issuer,
    });
    await expect(
      service.execute(principal, workspaceId, {
        operation: "install-notifications",
        sourceId: randomUUID(),
        generation: 1,
        createdAt: "2026-11-06T00:00:00.000Z",
        token: "d".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});

it("provider-scoped account authority cannot issue another provider or a generic operation", async () => {
  for (const provider of ["codex", "claude"] as const) {
    const scoped = new AgentBridgeService({ ...config, accountProvider: provider }, deps);
    await scoped.execute(principal, workspaceId, {
      operation: provider === "codex" ? "codex-account" : "claude-account",
      account: { action: "status" },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    for (const request of [
      {
        operation: provider === "codex" ? "claude-account" : "codex-account",
        account: { action: "status" as const },
      },
      { operation: "install" as const },
      { operation: "sessions" as const },
      { operation: "inventory" as const },
    ] as const)
      await expect(scoped.execute(principal, workspaceId, request)).rejects.toMatchObject({
        code: "unavailable",
      });
    expect(deps.coderForPrincipal).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  }
});
