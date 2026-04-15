import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

import { GET } from "../route";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

const mockedGetDb = vi.mocked(getDb);

function makeRequest(url: string) {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

describe("GET /api/terminal/scrollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when reconnectId is missing", async () => {
    const res = await GET(makeRequest("/api/terminal/scrollback"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing/);
  });

  it("returns 400 when reconnectId is not a valid UUID", async () => {
    const res = await GET(
      makeRequest("/api/terminal/scrollback?reconnectId=not-a-uuid"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid/);
  });

  it("returns 200 with empty body when no chunks found", async () => {
    mockedGetDb.mockReturnValue({
      scrollbackChunk: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any);

    const res = await GET(
      makeRequest(
        "/api/terminal/scrollback?reconnectId=11111111-1111-1111-1111-111111111111",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("0");
  });

  it("returns concatenated binary data ordered by seqNum", async () => {
    mockedGetDb.mockReturnValue({
      scrollbackChunk: {
        findMany: vi.fn().mockResolvedValue([
          { data: Buffer.from("hello ") },
          { data: Buffer.from("world") },
        ]),
      },
    } as any);

    const res = await GET(
      makeRequest(
        "/api/terminal/scrollback?reconnectId=22222222-2222-2222-2222-222222222222",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe("hello world");
  });

  it("returns 500 on Prisma error", async () => {
    mockedGetDb.mockReturnValue({
      scrollbackChunk: {
        findMany: vi.fn().mockRejectedValue(new Error("connection lost")),
      },
    } as any);

    const res = await GET(
      makeRequest(
        "/api/terminal/scrollback?reconnectId=33333333-3333-3333-3333-333333333333",
      ),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });
});
