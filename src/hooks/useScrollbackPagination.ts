"use client";

import { useCallback, useRef, useState } from "react";

export interface ScrollbackChunk {
  seqNum: number;
  data: string; // base64-encoded binary
}

interface PaginationState {
  chunks: ScrollbackChunk[];
  isLoading: boolean;
  hasMore: boolean;
  error: string | null;
}

interface UseScrollbackPaginationReturn extends PaginationState {
  loadMore: () => void;
  totalChunks: number;
}

const FETCH_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 50;

export function useScrollbackPagination(
  reconnectId: string | null,
  enabled: boolean,
): UseScrollbackPaginationReturn {
  const [state, setState] = useState<PaginationState>({
    chunks: [],
    isLoading: false,
    hasMore: true,
    error: null,
  });
  const totalChunksRef = useRef(0);
  const cursorRef = useRef<number | null>(null);
  const loadingRef = useRef(false);

  const loadMore = useCallback(() => {
    if (!reconnectId || !enabled || loadingRef.current || !state.hasMore) return;

    loadingRef.current = true;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    const params = new URLSearchParams({
      reconnectId,
      limit: String(PAGE_LIMIT),
    });
    if (cursorRef.current !== null) {
      params.set("cursor", String(cursorRef.current));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(`/api/terminal/scrollback?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timeout);
        if (!res.ok) {
          throw new Error(`Fetch failed: ${res.status}`);
        }

        const json = await res.json();
        const totalChunks: number = json.totalChunks ?? 0;
        const newChunks: ScrollbackChunk[] = json.chunks ?? [];

        totalChunksRef.current = totalChunks;

        setState((prev) => {
          const existingSeqNums = new Set(prev.chunks.map((c) => c.seqNum));
          const deduped = newChunks.filter(
            (c) => !existingSeqNums.has(c.seqNum),
          );

          const merged = [...deduped, ...prev.chunks];
          merged.sort((a, b) => a.seqNum - b.seqNum);

          const lowestSeqNum =
            merged.length > 0 ? merged[0].seqNum : null;

          if (lowestSeqNum !== null) {
            cursorRef.current = lowestSeqNum;
          }

          const hasMore =
            newChunks.length >= PAGE_LIMIT && (lowestSeqNum ?? 1) > 1;

          return {
            chunks: merged,
            isLoading: false,
            hasMore,
            error: null,
          };
        });

        loadingRef.current = false;
      })
      .catch((err) => {
        clearTimeout(timeout);
        loadingRef.current = false;

        const message =
          err.name === "AbortError"
            ? "Request timed out"
            : err.message || "Unknown error";

        console.warn(
          `[scrollback-pagination] Fetch failed for reconnectId=${reconnectId}:`,
          message,
        );

        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: message,
        }));
      });
  }, [reconnectId, enabled, state.hasMore]);

  return {
    ...state,
    totalChunks: totalChunksRef.current,
    loadMore,
  };
}
