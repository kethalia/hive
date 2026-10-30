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
});
