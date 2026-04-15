// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrollbackPagination } from "@/hooks/useScrollbackPagination";

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeJsonResponse(
  chunks: Array<{ seqNum: number; data: string }>,
  totalChunks: number,
) {
  return new Response(JSON.stringify({ chunks, totalChunks }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Total-Chunks": String(totalChunks),
    },
  });
}

function toBase64(text: string): string {
  return Buffer.from(text).toString("base64");
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScrollbackPagination", () => {
  it("returns initial state when not enabled", () => {
    const { result } = renderHook(() =>
      useScrollbackPagination(VALID_UUID, false),
    );

    expect(result.current.chunks).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("does not fetch when reconnectId is null", () => {
    const { result } = renderHook(() =>
      useScrollbackPagination(null, true),
    );

    act(() => {
      result.current.loadMore();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches chunks and updates state", async () => {
    const chunks = [
      { seqNum: 1, data: toBase64("hello") },
      { seqNum: 2, data: toBase64("world") },
    ];
    fetchMock.mockResolvedValueOnce(makeJsonResponse(chunks, 5));

    const { result } = renderHook(() =>
      useScrollbackPagination(VALID_UUID, true),
    );

    await act(async () => {
      result.current.loadMore();
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    expect(result.current.chunks).toHaveLength(2);
    expect(result.current.chunks[0].seqNum).toBe(1);
    expect(result.current.chunks[1].seqNum).toBe(2);
    expect(result.current.error).toBeNull();
  });

  it("advances cursor and accumulates chunks across pages", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      seqNum: 51 + i,
      data: toBase64(`chunk-${51 + i}`),
    }));
    fetchMock.mockResolvedValueOnce(makeJsonResponse(page1, 200));

    const { result } = renderHook(() =>
      useScrollbackPagination(VALID_UUID, true),
    );

    await act(async () => {
      result.current.loadMore();
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    expect(result.current.chunks).toHaveLength(50);
    expect(result.current.hasMore).toBe(true);

    const page2 = Array.from({ length: 50 }, (_, i) => ({
      seqNum: 1 + i,
      data: toBase64(`chunk-${1 + i}`),
    }));
    fetchMock.mockResolvedValueOnce(makeJsonResponse(page2, 200));

    await act(async () => {
      result.current.loadMore();
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    expect(result.current.chunks).toHaveLength(100);
    expect(result.current.chunks[0].seqNum).toBe(1);
    expect(result.current.hasMore).toBe(false);

    const url = new URL(fetchMock.mock.calls[1][0], "http://localhost");
    expect(url.searchParams.get("cursor")).toBe("51");
  });

  it("deduplicates chunks by seqNum", async () => {
    const chunks1 = Array.from({ length: 50 }, (_, i) => ({
      seqNum: 51 + i,
      data: toBase64(`chunk-${51 + i}`),
    }));
    fetchMock.mockResolvedValueOnce(makeJsonResponse(chunks1, 200));

    const { result } = renderHook(() =>
      useScrollbackPagination(VALID_UUID, true),
    );

    await act(async () => {
      result.current.loadMore();
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    expect(result.current.chunks).toHaveLength(50);

    const chunks2 = Array.from({ length: 50 }, (_, i) => ({
      seqNum: 26 + i,
      data: toBase64(`chunk-${26 + i}`),
    }));
    fetchMock.mockResolvedValueOnce(makeJsonResponse(chunks2, 200));

    await act(async () => {
      result.current.loadMore();
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    expect(result.current.chunks).toHaveLength(75);
    const seqNums = result.current.chunks.map((c) => c.seqNum);
    for (let i = 1; i < seqNums.length; i++) {
      expect(seqNums[i]).toBeGreaterThan(seqNums[i - 1]);
    }
    expect(seqNums[0]).toBe(26);
    expect(seqNums[seqNums.length - 1]).toBe(100);
  });

  it("sets hasMore to false when fewer than PAGE_LIMIT chunks returned", async () => {
    const chunks = [{ seqNum: 1, data: toBase64("only") }];
    fetchMock.mockResolvedValueOnce(makeJsonResponse(chunks, 1));

    const { result } = renderHook(() =>
      useScrollbackPagination(VALID_UUID, true),
    );

    await act(async () => {
      result.current.loadMore();
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    expect(result.current.hasMore).toBe(false);
  });

  it("handles fetch error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() =>
      useScrollbackPagination(VALID_UUID, true),
    );

    await act(async () => {
      result.current.loadMore();
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    expect(result.current.error).toBe("Network error");
    expect(result.current.chunks).toEqual([]);
  });

  it("handles non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));

    const { result } = renderHook(() =>
      useScrollbackPagination(VALID_UUID, true),
    );

    await act(async () => {
      result.current.loadMore();
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    expect(result.current.error).toBe("Fetch failed: 500");
  });
});
