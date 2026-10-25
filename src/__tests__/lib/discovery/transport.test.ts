import { afterEach, describe, expect, it, vi } from "vitest";
import { readDiscovery } from "@/lib/discovery/transport";
import { DiscoveryError } from "@/lib/discovery/types";

afterEach(() => vi.unstubAllGlobals());
describe("discovery HTTP transport", () => {
  it("uses a cancellable private GET and passes the selected workspace/refresh", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(
      await readDiscovery(
        "sessions",
        { workspaceId: "dev/one", buildId: "build" },
        controller.signal,
        true,
      ),
    ).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/discovery/sessions?workspaceId=dev%2Fone&refresh=1",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
    controller.abort();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("classifies expired login redirects as authorization loss", async () => {
    const response = new Response("<html>Login</html>");
    Object.defineProperty(response, "redirected", { value: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(readDiscovery("workspaces")).rejects.toMatchObject({ status: 401 });
  });
  it("keeps HTTP denial status even when a proxy returns a non-JSON error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })));
    await expect(readDiscovery("sessions")).rejects.toMatchObject({ status: 403 });
  });
  it("rejects malformed success payloads instead of replacing snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
    await expect(readDiscovery("workspaces")).rejects.toBeInstanceOf(DiscoveryError);
  });
});
