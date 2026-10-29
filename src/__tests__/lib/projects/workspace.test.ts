import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));

import { spawn } from "node:child_process";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { discoverWorkspaceProjects } from "@/lib/projects/workspace";

const user = { id: "hive-user", coderUserId: "coder-owner" };
const input = { workspaceId: "11111111-1111-4111-8111-111111111111" };
const client = {
  getWorkspace: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getBaseUrl: () => "https://coder.example.com",
  getSessionToken: () => "user-only-token",
};
const page = {
  schemaVersion: 1,
  provider: "github",
  providerAccountId: "123",
  repositories: [],
  page: 1,
  perPage: 100,
  nextPage: null,
};

function child(reply: unknown, code = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  let request = "";
  child.stdin.on("data", (chunk) => {
    request += chunk.toString();
  });
  child.stdin.on("finish", () => {
    child.stdout.write(JSON.stringify(reply));
    child.emit("close", code);
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  return { child, request: () => JSON.parse(request) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
  vi.mocked(getCoderClientForUser).mockResolvedValue(client as never);
  client.getWorkspace.mockResolvedValue({
    owner_id: "coder-owner",
    owner_name: "owner",
    name: "software",
    latest_build: { id: "build-1", status: "running" },
  });
  client.getWorkspaceResources.mockResolvedValue([
    { agents: [{ name: "main", status: "connected" }] },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

describe("workspace GitHub project discovery", () => {
  it("is disabled before accessing credentials or starting a helper", async () => {
    vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "false");
    await expect(discoverWorkspaceProjects(user, input)).rejects.toMatchObject({
      code: "discovery_disabled",
    });
    expect(getCoderClientForUser).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it("checks fresh workspace ownership before SSH and never uses an unrelated owner credential", async () => {
    client.getWorkspace.mockResolvedValue({ owner_id: "someone-else" });
    await expect(discoverWorkspaceProjects(user, input)).rejects.toMatchObject({
      code: "workspace_forbidden",
    });
    expect(getCoderClientForUser).toHaveBeenCalledWith("hive-user");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("uses fixed helper source, per-user credentials privately, and only numeric page input", async () => {
    const run = child(page);
    expect(await discoverWorkspaceProjects(user, input)).toEqual(page);
    expect(run.request()).toEqual({ schemaVersion: 1, page: 1, perPage: 100 });
    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[1]).toContain("owner/software.main");
    expect(call[2]).toMatchObject({
      env: { CODER_SESSION_TOKEN: "user-only-token", CODER_URL: "https://coder.example.com" },
    });
    expect(JSON.stringify(call[1])).not.toContain("user-only-token");
    expect(JSON.stringify(call[1])).toContain("external-auth");
  });
  it("does not cache successful metadata across provider revocation", async () => {
    child(page);
    await discoverWorkspaceProjects(user, input);
    child({ schemaVersion: 1, error: "github_auth_required" }, 1);
    await expect(discoverWorkspaceProjects(user, input)).rejects.toMatchObject({
      code: "github_auth_required",
    });
    expect(client.getWorkspace).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("rejects an invalid result and suppresses arbitrary remote error prose", async () => {
    child({ schemaVersion: 1, error: "private-provider-token" }, 1);
    await expect(discoverWorkspaceProjects(user, input)).rejects.toMatchObject({
      code: "discovery_unavailable",
    });
    child({ ...page, page: 2 });
    await expect(discoverWorkspaceProjects(user, input)).rejects.toMatchObject({
      code: "github_invalid_response",
    });
  });
  it("rejects unsupported request fields before authorization", async () => {
    await expect(
      discoverWorkspaceProjects(user, { ...input, url: "https://attacker.invalid" }),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(getCoderClientForUser).not.toHaveBeenCalled();
  });

  it("kills an oversized helper response without returning partial metadata", async () => {
    const run = child("x".repeat(1024 * 1024 + 1));
    await expect(discoverWorkspaceProjects(user, input)).rejects.toMatchObject({
      code: "discovery_unavailable",
    });
    expect(run.child.kill).toHaveBeenCalledOnce();
  });
});
