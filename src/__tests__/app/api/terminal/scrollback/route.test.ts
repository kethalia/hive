import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/terminal/scrollback/route";

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const mockFindMany = vi.fn();
const mockCount = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    scrollbackChunk: {
      findMany: mockFindMany,
      count: mockCount,
    },
  }),
}));

function makeRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/terminal/scrollback");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

function makeChunk(seqNum: number, text: string) {
  return { data: Buffer.from(text), seqNum };
}

beforeEach(() => {
  mockFindMany.mockReset();
  mockCount.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/terminal/scrollback", () => {
  describe("backward compatibility (no cursor/limit)", () => {
    it("returns all chunks ascending when no pagination params", async () => {
      const chunks = [makeChunk(1, "hello"), makeChunk(2, " world")];
      mockFindMany.mockResolvedValue(chunks);
      mockCount.mockResolvedValue(2);

      const res = await GET(makeRequest({ reconnectId: VALID_UUID }));

      expect(res.status).toBe(200);
      expect(res.headers.get("X-Total-Chunks")).toBe("2");
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.toString()).toBe("hello world");

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { reconnectId: VALID_UUID },
        orderBy: { seqNum: "asc" },
        select: { data: true },
      });
    });

    it("returns empty response with X-Total-Chunks when no chunks exist", async () => {
      mockFindMany.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);

      const res = await GET(makeRequest({ reconnectId: VALID_UUID }));

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Length")).toBe("0");
      expect(res.headers.get("X-Total-Chunks")).toBe("0");
    });
  });

  describe("cursor-based pagination", () => {
    it("filters chunks with seqNum < cursor and returns JSON", async () => {
      const chunks = [makeChunk(4, "d"), makeChunk(3, "c")];
      mockFindMany.mockResolvedValue(chunks);
      mockCount.mockResolvedValue(10);

      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "5", limit: "10" }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("X-Total-Chunks")).toBe("10");

      const body = await res.json();
      expect(body.totalChunks).toBe(10);
      expect(body.chunks).toHaveLength(2);
      expect(body.chunks[0].seqNum).toBe(3);
      expect(body.chunks[1].seqNum).toBe(4);

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { reconnectId: VALID_UUID, seqNum: { lt: 5 } },
        orderBy: { seqNum: "desc" },
        take: 10,
        select: { data: true, seqNum: true },
      });
    });

    it("uses default limit of 50 when only cursor is provided", async () => {
      mockFindMany.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);

      await GET(makeRequest({ reconnectId: VALID_UUID, cursor: "100" }));

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });

    it("caps limit at 200", async () => {
      mockFindMany.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);

      await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "100", limit: "999" }),
      );

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 }),
      );
    });

    it("uses limit without cursor (no seqNum filter)", async () => {
      mockFindMany.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);

      await GET(makeRequest({ reconnectId: VALID_UUID, limit: "10" }));

      const call = mockFindMany.mock.calls[0][0];
      expect(call.where).toEqual({ reconnectId: VALID_UUID });
      expect(call.take).toBe(10);
      expect(call.orderBy).toEqual({ seqNum: "desc" });
    });

    it("reverses desc-ordered results to ascending in JSON response", async () => {
      mockFindMany.mockResolvedValue([
        makeChunk(3, "third"),
        makeChunk(2, "second"),
        makeChunk(1, "first"),
      ]);
      mockCount.mockResolvedValue(5);

      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "4", limit: "3" }),
      );

      const body = await res.json();
      expect(body.chunks[0].seqNum).toBe(1);
      expect(body.chunks[1].seqNum).toBe(2);
      expect(body.chunks[2].seqNum).toBe(3);
      expect(Buffer.from(body.chunks[0].data, "base64").toString()).toBe("first");
      expect(Buffer.from(body.chunks[1].data, "base64").toString()).toBe("second");
      expect(Buffer.from(body.chunks[2].data, "base64").toString()).toBe("third");
    });
  });

  describe("X-Total-Chunks header", () => {
    it("is present on all successful responses", async () => {
      mockFindMany.mockResolvedValue([makeChunk(1, "x")]);
      mockCount.mockResolvedValue(42);

      const res = await GET(makeRequest({ reconnectId: VALID_UUID }));
      expect(res.headers.get("X-Total-Chunks")).toBe("42");
    });
  });

  describe("validation and error handling", () => {
    it("returns 400 for missing reconnectId", async () => {
      const res = await GET(makeRequest({}));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Missing required parameter");
    });

    it("returns 400 for invalid reconnectId format", async () => {
      const res = await GET(makeRequest({ reconnectId: "not-a-uuid" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid reconnectId");
    });

    it("returns 400 for non-numeric cursor", async () => {
      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "abc" }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid cursor");
    });

    it("returns 400 for negative cursor", async () => {
      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "-5" }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for cursor=0", async () => {
      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "0" }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for non-numeric limit", async () => {
      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, limit: "xyz" }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid limit");
    });

    it("returns 400 for limit=0", async () => {
      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, limit: "0" }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for negative limit", async () => {
      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, limit: "-1" }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 500 on database error", async () => {
      mockFindMany.mockRejectedValue(new Error("DB connection failed"));
      mockCount.mockResolvedValue(0);

      const res = await GET(makeRequest({ reconnectId: VALID_UUID }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Internal server error");
    });
  });

  describe("boundary conditions", () => {
    it("returns empty chunks array when cursor points before first chunk", async () => {
      mockFindMany.mockResolvedValue([]);
      mockCount.mockResolvedValue(5);

      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "1" }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Total-Chunks")).toBe("5");
      const body = await res.json();
      expect(body.chunks).toHaveLength(0);
      expect(body.totalChunks).toBe(5);
    });

    it("handles cursor at last chunk (returns all but last)", async () => {
      const chunks = [makeChunk(2, "b"), makeChunk(1, "a")];
      mockFindMany.mockResolvedValue(chunks);
      mockCount.mockResolvedValue(3);

      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "3", limit: "50" }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.chunks).toHaveLength(2);
      expect(body.chunks[0].seqNum).toBe(1);
      expect(body.chunks[1].seqNum).toBe(2);
    });

    it("handles limit larger than available chunks", async () => {
      const chunks = [makeChunk(1, "only")];
      mockFindMany.mockResolvedValue(chunks);
      mockCount.mockResolvedValue(1);

      const res = await GET(
        makeRequest({ reconnectId: VALID_UUID, cursor: "100", limit: "200" }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.chunks).toHaveLength(1);
      expect(Buffer.from(body.chunks[0].data, "base64").toString()).toBe("only");
    });
  });
});
