import { generateKeyPairSync, verify } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  config: vi.fn(),
  client: vi.fn(),
  resolve: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/lib/codex-session/registered-session.server", () => ({
  registeredSessionConfig: mock.config,
}));
vi.mock("@/lib/codex-session/registration.server", () => ({
  resolveVerifiedWorkspaceHost: mock.resolve,
}));
vi.mock("@/lib/codex-session/bootstrap-delivery.server", () => ({
  postToVerifiedWorkspaceApp: mock.post,
}));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: mock.client }));

import { discoverHostProjects } from "@/lib/projects/host.server";

const key = generateKeyPairSync("ed25519");
const user = { id: "11111111-1111-4111-8111-111111111111", coderUserId: "owner" };
const workspaceId = "22222222-2222-4222-8222-222222222222";
const binding = {
  coderOrigin: "https://coder.fixture.invalid",
  hiveUserId: user.id,
  ownerId: user.coderUserId,
  workspaceId,
  buildId: "build",
  agentId: "agent",
  templateId: "software",
  appOrigin: "https://gateway.fixture.invalid",
  appId: "app",
};
const page = {
  schemaVersion: 1,
  provider: "github",
  providerAccountId: "123",
  repositories: [],
  page: 2,
  perPage: 10,
  nextPage: null,
};
const client = { getWorkspace: vi.fn(), getSessionToken: () => "private-owner-token" };
beforeEach(() => {
  vi.clearAllMocks();
  mock.config.mockReturnValue({
    privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }),
    keyId: "issuer",
    hiveOrigin: "https://hive.fixture.invalid",
  });
  mock.client.mockResolvedValue(client);
  mock.resolve.mockResolvedValue({ binding, coder: client });
  mock.post.mockResolvedValue(page);
  client.getWorkspace.mockResolvedValue({
    id: workspaceId,
    owner_id: user.coderUserId,
    latest_build: { id: "build", status: "running" },
  });
});
const input = { workspaceId, page: 2, perPage: 10 };
describe("authenticated host project discovery", () => {
  it("signs only a bounded exact-host discovery request and returns a validated page", async () => {
    expect(await discoverHostProjects(user, input)).toEqual(page);
    expect(mock.client).toHaveBeenCalledWith(user.id);
    const [actualClient, actualBinding, request] = mock.post.mock.calls[0];
    expect(actualClient).toBe(client);
    expect(actualBinding).toEqual(binding);
    expect(request.path).toBe("/projects/discover");
    const { ticket } = JSON.parse(request.body);
    const [header, payload, signature] = ticket.split(".");
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        key.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "EdDSA",
      typ: "JWT",
      kid: "issuer",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({
      scope: "projects:discover",
      binding,
      request: { schemaVersion: 1, page: 2, perPage: 10 },
    });
    expect(claims.exp - claims.iat).toBe(45);
    expect(JSON.stringify(claims)).not.toContain("private-owner-token");
  });
  it("rejects changed workspace ownership/build after the host call", async () => {
    client.getWorkspace.mockResolvedValue({
      id: workspaceId,
      owner_id: "other",
      latest_build: { id: "build", status: "running" },
    });
    await expect(discoverHostProjects(user, input)).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
  });
  it("does not send a capability when independent host authorization fails", async () => {
    mock.resolve.mockRejectedValue(new Error("private provider error"));
    await expect(discoverHostProjects(user, input)).rejects.toMatchObject({
      code: "discovery_unavailable",
    });
    expect(mock.post).not.toHaveBeenCalled();
  });
  it("rejects caller-selected URLs and executable paths before credentials", async () => {
    await expect(
      discoverHostProjects(user, {
        ...input,
        appOrigin: "https://attacker.invalid",
        helperPath: "/tmp/forged",
      }),
    ).rejects.toThrow();
    expect(mock.client).not.toHaveBeenCalled();
  });
  it("surfaces only fixed helper diagnostics and rejects wrong pagination", async () => {
    mock.post.mockResolvedValue({ schemaVersion: 1, error: "github_auth_required" });
    await expect(discoverHostProjects(user, input)).rejects.toMatchObject({
      code: "github_auth_required",
    });
    mock.post.mockResolvedValue({ schemaVersion: 1, error: "private credentials" });
    await expect(discoverHostProjects(user, input)).rejects.toMatchObject({
      code: "github_invalid_response",
    });
    mock.post.mockResolvedValue({ ...page, page: 1 });
    await expect(discoverHostProjects(user, input)).rejects.toMatchObject({
      code: "github_invalid_response",
    });
  });
});
