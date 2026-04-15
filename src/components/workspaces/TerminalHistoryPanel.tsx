"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useScrollbackPagination,
  type ScrollbackChunk,
} from "@/hooks/useScrollbackPagination";
import { createAnsiConverter } from "@/lib/terminal/ansi-to-html";
import { Loader2 } from "lucide-react";

interface TerminalHistoryPanelProps {
  reconnectId: string | null;
  visible: boolean;
  onScrollToBottom?: () => void;
}

function ChunkRow({ chunk, converter }: { chunk: ScrollbackChunk; converter: ReturnType<typeof createAnsiConverter> }) {
  const html = useMemo(() => {
    const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    return converter.convert(bytes);
  }, [chunk.data, converter]);

  return (
    <pre
      className="m-0 whitespace-pre-wrap break-all font-mono text-[13px] leading-[1.4] px-1"
      style={{ color: "#e5e5e5" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function TerminalHistoryPanel({
  reconnectId,
  visible,
  onScrollToBottom,
}: TerminalHistoryPanelProps) {
  const { chunks, isLoading, hasMore, error, loadMore } =
    useScrollbackPagination(reconnectId, visible);

  const scrollRef = useRef<HTMLDivElement>(null);

  const converter = useMemo(() => createAnsiConverter(), []);

  const virtualizer = useVirtualizer({
    count: chunks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 10,
  });

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (el.scrollTop === 0 && hasMore && !isLoading) {
      loadMore();
    }

    const atBottom =
      Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 2;
    if (atBottom) {
      onScrollToBottom?.();
    }
  }, [hasMore, isLoading, loadMore, onScrollToBottom]);

  useEffect(() => {
    if (visible && chunks.length === 0 && hasMore) {
      loadMore();
    }
  }, [visible, chunks.length, hasMore, loadMore]);

  if (!visible) return null;

  if (chunks.length === 0 && !isLoading && !hasMore) {
    return (
      <div
        className="flex items-center justify-center py-4 text-sm"
        style={{ backgroundColor: "#0a0a0a", color: "#666" }}
      >
        No older history available
      </div>
    );
  }

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ backgroundColor: "#0a0a0a", maxHeight: "60%" }}
    >
      {isLoading && (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-blue-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading older history…
        </div>
      )}
      {error && (
        <div className="px-2 py-1 text-xs text-yellow-400">
          Failed to load history: {error}
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const chunk = chunks[virtualRow.index];
            return (
              <div
                key={chunk.seqNum}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
              >
                <ChunkRow chunk={chunk} converter={converter} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
