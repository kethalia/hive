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

describe("auth-service fetchCoderApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockUndiciFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses and closes a verified private-CA dispatcher", async () => {
    const { fetchCoderApi } = await import("../src/auth/coder-fetch.js");

    const response = await fetchCoderApi("https://coder.example.com/api/v2/buildinfo");

    expect(await response.json()).toEqual({ ok: true });
    expect(mockAgentOptions).toHaveBeenCalledWith({
      connect: { ca: [...rootCertificates, "trusted-private-ca"] },
    });
    expect(mockUndiciFetch).toHaveBeenCalledWith(
      "https://coder.example.com/api/v2/buildinfo",
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
    expect(mockAgentClose).toHaveBeenCalledOnce();
  });

  it("preserves a null body for no-content responses", async () => {
    mockUndiciFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { fetchCoderApi } = await import("../src/auth/coder-fetch.js");

    const response = await fetchCoderApi("https://coder.example.com/api/v2/users/me/keys/key", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(mockAgentClose).toHaveBeenCalledOnce();
  });
});
