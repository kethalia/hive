import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyWorkspaceAgentAccess } from "../src/workspace-authorization.js";

const input = {
  coderUrl: "https://coder.example.test/",
  token: "secret-token",
  workspaceId: "workspace-1",
  agentId: "agent-1",
};

describe("verifyWorkspaceAgentAccess", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts an agent in the authenticated workspace build", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          latest_build: { resources: [{ agents: [{ id: "agent-1" }] }] },
        }),
        { status: 200 },
      ),
    );

    await expect(verifyWorkspaceAgentAccess(input)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://coder.example.test/api/v2/workspaces/workspace-1",
      expect.objectContaining({
        headers: expect.objectContaining({ "Coder-Session-Token": "secret-token" }),
      }),
    );
  });

  it("rejects an agent from a different workspace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          latest_build: { resources: [{ agents: [{ id: "other-agent" }] }] },
        }),
        { status: 200 },
      ),
    );

    await expect(verifyWorkspaceAgentAccess(input)).resolves.toEqual({ ok: false, status: 403 });
  });

  it("reports upstream failures without exposing response content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private body", { status: 503 }));

    await expect(verifyWorkspaceAgentAccess(input)).resolves.toEqual({ ok: false, status: 502 });
  });
});
