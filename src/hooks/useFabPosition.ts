"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const STORAGE_KEY = "fab_position";
const DEFAULT_CORNER: Corner = "bottom-right";
const OFFSET = 16;
const TAP_THRESHOLD = 5;
const SNAP_DURATION = 200;

function readCorner(): Corner {
  if (typeof window === "undefined") return DEFAULT_CORNER;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (
    stored === "top-left" ||
    stored === "top-right" ||
    stored === "bottom-left" ||
    stored === "bottom-right"
  ) {
    return stored;
  }
  return DEFAULT_CORNER;
}

function viewportMetrics() {
  const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
  if (vv) {
    return {
      width: vv.width,
      height: vv.height,
      offsetLeft: vv.offsetLeft,
      offsetTop: vv.offsetTop,
    };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetLeft: 0,
    offsetTop: 0,
  };
}

export function cornerToPosition(corner: Corner) {
  const { width, height, offsetLeft, offsetTop } = viewportMetrics();
  switch (corner) {
    case "top-left":
      return { x: offsetLeft + OFFSET, y: offsetTop + OFFSET };
    case "top-right":
      return { x: offsetLeft + width - 56 - OFFSET, y: offsetTop + OFFSET };
    case "bottom-left":
      return { x: offsetLeft + OFFSET, y: offsetTop + height - 56 - OFFSET };
    case "bottom-right":
      return {
        x: offsetLeft + width - 56 - OFFSET,
        y: offsetTop + height - 56 - OFFSET,
      };
  }
}

export function nearestCorner(x: number, y: number): Corner {
  const corners: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

  const targets = corners.map((c) => {
    const pos = cornerToPosition(c);
    const dx = x - pos.x;
    const dy = y - pos.y;
    return { corner: c, dist: Math.sqrt(dx * dx + dy * dy) };
  });

  targets.sort((a, b) => a.dist - b.dist);
  return targets[0].corner;
}

export function useFabPosition() {
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isSnapping, setIsSnapping] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const dragDistRef = useRef(0);
  const snapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (snapTimeoutRef.current !== null) {
        clearTimeout(snapTimeoutRef.current);
        snapTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setPosition(cornerToPosition(corner));
  }, [corner]);

  useEffect(() => {
    const handleResize = () => {
      setPosition(cornerToPosition(corner));
    };
    window.addEventListener("resize", handleResize);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", handleResize);
    vv?.addEventListener("scroll", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      vv?.removeEventListener("resize", handleResize);
      vv?.removeEventListener("scroll", handleResize);
    };
  }, [corner]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    dragDistRef.current = 0;
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      dragDistRef.current = Math.max(dragDistRef.current, Math.sqrt(dx * dx + dy * dy));
      setPosition((prev) => {
        const { width, height, offsetLeft, offsetTop } = viewportMetrics();
        return {
          x: Math.max(offsetLeft, Math.min(offsetLeft + width - 56, prev.x + e.movementX)),
          y: Math.max(offsetTop, Math.min(offsetTop + height - 56, prev.y + e.movementY)),
        };
      });
    },
    [isDragging],
  );

  const onPointerUp = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);

    const wasDrag = dragDistRef.current >= TAP_THRESHOLD;

    if (wasDrag) {
      setPosition((current) => {
        const newCorner = nearestCorner(current.x, current.y);
        localStorage.setItem(STORAGE_KEY, newCorner);
        setCorner(newCorner);
        setIsSnapping(true);
        if (snapTimeoutRef.current !== null) {
          clearTimeout(snapTimeoutRef.current);
        }
        snapTimeoutRef.current = setTimeout(() => {
          setIsSnapping(false);
          snapTimeoutRef.current = null;
        }, SNAP_DURATION);
        return cornerToPosition(newCorner);
      });
    }

    return wasDrag;
  }, [isDragging]);

  return {
    corner,
    position,
    isDragging,
    isSnapping,
    dragDist: dragDistRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
