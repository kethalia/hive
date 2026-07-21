import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuthorizedWorkspaceIds } from "../src/authorized-workspaces.js";

const auth = {
  token: "secret-token",
  coderUrl: "https://coder.example.test/",
  sessionId: "session-1",
  username: "alice",
};

describe("resolveAuthorizedWorkspaceIds", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns valid workspace IDs from the authenticated Coder response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          workspaces: [{ id: "workspace-1" }, { id: "" }, { id: 42 }, { id: "workspace-2" }],
        }),
        { status: 200 },
      ),
    );

    await expect(resolveAuthorizedWorkspaceIds(auth)).resolves.toEqual(
      new Set(["workspace-1", "workspace-2"]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://coder.example.test/api/v2/workspaces?q=owner%3Ame",
      expect.objectContaining({
        headers: expect.objectContaining({ "Coder-Session-Token": "secret-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("aborts a stalled workspace request after the authorization deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });

    const authorization = resolveAuthorizedWorkspaceIds(auth);
    const rejection = expect(authorization).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toHaveProperty("aborted", true);
  });

  it("keeps the deadline active while parsing a stalled response body", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const response = new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
    const jsonMock = vi.spyOn(response, "json").mockImplementation(() => {
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      requestSignal = init?.signal;
      return Promise.resolve(response);
    });

    const authorization = resolveAuthorizedWorkspaceIds(auth);
    const rejection = expect(authorization).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(jsonMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(requestSignal).toHaveProperty("aborted", true);
  });
});
