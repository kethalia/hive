import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTerminal, terminalAuthProtocols } from "@/lib/terminal/auth-transport";

const ticket = `fixture.${"a".repeat(43)}`;
afterEach(() => vi.unstubAllGlobals());

describe("terminal authentication transport", () => {
  it("offers a ticket separately from the URL and preserves protocol negotiation", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ ticket }));
    vi.stubGlobal("fetch", fetchMock);
    const url = "wss://terminal.example.com/ws?agentId=agent";
    expect(await terminalAuthProtocols(url, "hive-terminal-v1")).toEqual([
      "hive-terminal-v1",
      `hive-ticket.${ticket}`,
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/terminal-ticket",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        body: JSON.stringify({ url }),
      }),
    );
    expect(await terminalAuthProtocols(url, "hive-audio-v1")).toEqual([
      "hive-audio-v1",
      `hive-ticket.${ticket}`,
    ]);
  });
  it("sends only a fresh ticket to the proxy, without account cookies or redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ticket }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://terminal.example.com/session-events?after=3";
    await fetchTerminal(url);
    expect(fetchMock).toHaveBeenLastCalledWith(
      url,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${ticket}` },
      }),
    );
  });
  it.each([
    Response.json({}, { status: 401 }),
    Response.json({ ticket: "malformed" }),
  ])("does not contact the proxy when authorization fails", async (response) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTerminal("https://terminal.example.com/keepalive/status")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not send a ticket after its request is cancelled", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ ticket }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchTerminal("https://terminal.example.com/session-events", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
