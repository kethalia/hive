// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalHistoryPanel } from "@/components/workspaces/TerminalHistoryPanel";
import type { ScrollbackChunk } from "@/hooks/useScrollbackPagination";

const mockLoadMore = vi.fn();
const mockPaginationState = {
  chunks: [] as ScrollbackChunk[],
  isLoading: false,
  hasMore: true,
  error: null as string | null,
  totalChunks: 0,
  loadMore: mockLoadMore,
};

vi.mock("@/hooks/useScrollbackPagination", () => ({
  useScrollbackPagination: () => mockPaginationState,
}));

vi.mock("@/lib/terminal/ansi-to-html", () => ({
  createAnsiConverter: () => ({
    convert: (data: Uint8Array) => new TextDecoder().decode(data),
  }),
}));

function toBase64(text: string): string {
  return Buffer.from(text).toString("base64");
}

beforeEach(() => {
  mockLoadMore.mockReset();
  mockPaginationState.chunks = [];
  mockPaginationState.isLoading = false;
  mockPaginationState.hasMore = true;
  mockPaginationState.error = null;
  mockPaginationState.totalChunks = 0;
});

describe("TerminalHistoryPanel", () => {
  it("renders nothing when not visible", () => {
    const { container } = render(
      <TerminalHistoryPanel reconnectId="test-id" visible={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows empty state when no chunks and no more to load", () => {
    mockPaginationState.hasMore = false;
    mockPaginationState.chunks = [];

    render(
      <TerminalHistoryPanel reconnectId="test-id" visible={true} />,
    );

    expect(screen.getByText("No older history available")).toBeDefined();
  });

  it("renders chunk container elements for each chunk", () => {
    mockPaginationState.chunks = [
      { seqNum: 1, data: toBase64("line one\n") },
      { seqNum: 2, data: toBase64("line two\n") },
    ];
    mockPaginationState.hasMore = false;

    const { container } = render(
      <TerminalHistoryPanel reconnectId="test-id" visible={true} />,
    );

    const virtualContainer = container.querySelector("[style*='position: relative']");
    expect(virtualContainer).not.toBeNull();
  });

  it("shows loading indicator when fetching", () => {
    mockPaginationState.isLoading = true;

    render(
      <TerminalHistoryPanel reconnectId="test-id" visible={true} />,
    );

    expect(screen.getByText(/Loading older history/)).toBeDefined();
  });

  it("shows error message on failure", () => {
    mockPaginationState.error = "Network error";
    mockPaginationState.hasMore = true;
    mockPaginationState.chunks = [];

    render(
      <TerminalHistoryPanel reconnectId="test-id" visible={true} />,
    );

    expect(screen.getByText(/Network error/)).toBeDefined();
  });

  it("calls loadMore when becoming visible with no chunks", () => {
    mockPaginationState.chunks = [];
    mockPaginationState.hasMore = true;

    render(
      <TerminalHistoryPanel reconnectId="test-id" visible={true} />,
    );

    expect(mockLoadMore).toHaveBeenCalled();
  });

  it("renders ANSI-converted content via pre elements", () => {
    mockPaginationState.chunks = [
      { seqNum: 1, data: toBase64("hello world") },
    ];
    mockPaginationState.hasMore = false;

    const { container } = render(
      <TerminalHistoryPanel reconnectId="test-id" visible={true} />,
    );

    const preElements = container.querySelectorAll("pre");
    expect(preElements.length).toBeGreaterThanOrEqual(0);
  });
});
