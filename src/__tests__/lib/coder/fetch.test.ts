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
    expect(mockAgentOptions).toHaveBeenCalledWith({ connect: { ca: "trusted-private-ca" } });
    expect(mockUndiciFetch).toHaveBeenCalledWith(
      "https://coder.example.com/api/v2/buildinfo",
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
    expect(mockAgentClose).toHaveBeenCalledOnce();
  });
});
