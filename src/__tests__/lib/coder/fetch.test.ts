import { createServer } from "node:http";
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

describe("fetchCoderApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockUndiciFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses and closes a verified private-CA dispatcher", async () => {
    const { fetchCoderApi } = await import("@/lib/coder/fetch");

    const response = await fetchCoderApi("https://coder.example.com/api/v2/buildinfo");

    expect(await response.json()).toEqual({ ok: true });
    expect(mockAgentOptions).toHaveBeenCalledWith({
      connect: { ca: [...rootCertificates, "trusted-private-ca"] },
    });
    expect(mockUndiciFetch).toHaveBeenCalledWith(
      "https://coder.example.com/api/v2/buildinfo",
      expect.objectContaining({ dispatcher: expect.anything(), redirect: "error" }),
    );
    expect(mockAgentClose).toHaveBeenCalledOnce();
  });

  it("preserves a null body for no-content responses", async () => {
    mockUndiciFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { fetchCoderApi } = await import("@/lib/coder/fetch");

    const response = await fetchCoderApi("https://coder.example.com/api/v2/users/me/keys/key", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(mockAgentClose).toHaveBeenCalledOnce();
  });

  it("never forwards a credential header on redirects while allowing explicit manual handling", async () => {
    vi.stubEnv("CODER_CA_CERT", "");
    let redirectedRequests = 0;
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/target" });
      } else {
        redirectedRequests++;
        res.writeHead(200);
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server unavailable");
      const url = `http://127.0.0.1:${address.port}/redirect`;
      const { fetchCoderApi } = await import("@/lib/coder/fetch");
      await expect(
        fetchCoderApi(url, {
          headers: { "Coder-Session-Token": "synthetic-token" },
          redirect: "follow",
        }),
      ).rejects.toThrow();
      const response = await fetchCoderApi(url, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(redirectedRequests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
