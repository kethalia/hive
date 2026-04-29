"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type Corner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

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

export function cornerToPosition(corner: Corner) {
  switch (corner) {
    case "top-left":
      return { x: OFFSET, y: OFFSET };
    case "top-right":
      return { x: window.innerWidth - 56 - OFFSET, y: OFFSET };
    case "bottom-left":
      return { x: OFFSET, y: window.innerHeight - 56 - OFFSET };
    case "bottom-right":
      return {
        x: window.innerWidth - 56 - OFFSET,
        y: window.innerHeight - 56 - OFFSET,
      };
  }
}

export function nearestCorner(x: number, y: number): Corner {
  const midX = window.innerWidth / 2;
  const midY = window.innerHeight / 2;

  const corners: Corner[] = [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ];

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

  useEffect(() => {
    setPosition(cornerToPosition(corner));
  }, [corner]);

  useEffect(() => {
    const handleResize = () => {
      setPosition(cornerToPosition(corner));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [corner]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      dragDistRef.current = 0;
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      dragDistRef.current = Math.max(
        dragDistRef.current,
        Math.sqrt(dx * dx + dy * dy),
      );
      setPosition((prev) => ({
        x: Math.max(0, Math.min(window.innerWidth - 56, prev.x + e.movementX)),
        y: Math.max(
          0,
          Math.min(window.innerHeight - 56, prev.y + e.movementY),
        ),
      }));
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
        setTimeout(() => setIsSnapping(false), SNAP_DURATION);
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
