import { rootCertificates } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAgentClose, mockAgentOptions, mockUndiciFetch } = vi.hoisted(() => ({
  mockAgentClose: vi.fn(),
  mockAgentOptions: vi.fn(),
  mockUndiciFetch: vi.fn(),
}));

vi.mock("undici", () => ({
  Agent: class MockAgent {
    constructor(options: unknown) {
      mockAgentOptions(options);
    }
    close = mockAgentClose;
  },
  fetch: mockUndiciFetch,
}));

describe("terminal-proxy fetchCoderApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockUndiciFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("extends public CA trust and closes the dispatcher", async () => {
    const { fetchCoderApi } = await import("../src/coder-fetch.js");

    const response = await fetchCoderApi("https://coder.example.com/api/v2/workspaces");

    expect(await response.json()).toEqual({ ok: true });
    expect(mockAgentOptions).toHaveBeenCalledWith({
      connect: { ca: [...rootCertificates, "trusted-private-ca"] },
    });
    expect(mockUndiciFetch).toHaveBeenCalledWith(
      "https://coder.example.com/api/v2/workspaces",
      expect.objectContaining({ dispatcher: expect.anything(), redirect: "error" }),
    );
    expect(mockAgentClose).toHaveBeenCalledOnce();
  });

  it("disables redirects for credential-bearing requests using public CA trust", async () => {
    vi.stubEnv("CODER_CA_CERT", "");
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
    try {
      const { fetchCoderApi } = await import("../src/coder-fetch.js");
      await fetchCoderApi("https://coder.example.com/api/v2/workspaces", {
        headers: { "Coder-Session-Token": "synthetic-token" },
        redirect: "follow",
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: "error" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
