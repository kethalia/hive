import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────

const mockCompareTemplates = vi.fn();

vi.mock("@/lib/templates/staleness", () => ({
  compareTemplates: (...args: unknown[]) => mockCompareTemplates(...args),
  KNOWN_TEMPLATES: ["hive", "ai-dev"] as const,
}));

// ── GET route tests ──────────────────────────────────────────────

describe("GET /api/templates/status", () => {
  let GET: typeof import("@/app/api/templates/status/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/templates/status/route");
    GET = mod.GET;
  });

  it("returns JSON array of template statuses", async () => {
    const statuses = [
      {
        name: "hive",
        stale: false,
        lastPushed: "2026-04-10T12:00:00Z",
        activeVersionId: "v1",
        localHash: "abc",
        remoteHash: "abc",
      },
      {
        name: "ai-dev",
        stale: true,
        lastPushed: "2026-04-09T08:00:00Z",
        activeVersionId: "v2",
        localHash: "def",
        remoteHash: "ghi",
      },
    ];
    mockCompareTemplates.mockResolvedValue(statuses);

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(statuses);
    expect(mockCompareTemplates).toHaveBeenCalledWith(["hive", "ai-dev"]);
  });

  it("returns 500 when compareTemplates throws", async () => {
    mockCompareTemplates.mockRejectedValue(new Error("Coder unreachable"));

    const response = await GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to fetch template statuses");
  });

  it("passes all known template names to compareTemplates", async () => {
    mockCompareTemplates.mockResolvedValue([]);

    await GET();

    const calledWith = mockCompareTemplates.mock.calls[0][0];
    expect(calledWith).toContain("hive");
    expect(calledWith).toContain("ai-dev");
    expect(calledWith).toHaveLength(2);
  });
});
