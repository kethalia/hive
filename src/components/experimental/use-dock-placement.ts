import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Edge = "top" | "right" | "bottom" | "left";
type Anchor = { edge: Edge; ratio: number };
const clamp = (n: number, max = 1) => Math.max(0, Math.min(max, n));

/** Store an edge and a fraction along it, so resizing never strands the dock in the canvas. */
export function useDockPlacement(surface: RefObject<HTMLDivElement | null>, disabled: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor>({ edge: "bottom", ratio: 0.5 });
  const [edge, setEdge] = useState<Edge>("bottom");
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
    anchor: Anchor;
    tap: HTMLButtonElement | null;
    movable: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const snap = useRef<Animation | null>(null);

  function bounds() {
    const viewport = window.visualViewport;
    const style = root.current && getComputedStyle(root.current);
    const gap = (name: string) =>
      Math.max(12, Number.parseFloat(style?.getPropertyValue(`scroll-${name}`) ?? "0") || 0);
    const left = (viewport?.offsetLeft ?? 0) + gap("padding-left");
    const top = (viewport?.offsetTop ?? 0) + gap("padding-top");
    return {
      left,
      top,
      width: Math.max(
        48,
        (viewport?.width ?? innerWidth) - gap("padding-left") - gap("padding-right"),
      ),
      height: Math.max(
        48,
        (viewport?.height ?? innerHeight) - gap("padding-top") - gap("padding-bottom"),
      ),
    };
  }
  function point(next = anchor.current) {
    const area = bounds(),
      box = surface.current?.getBoundingClientRect();
    const dx = Math.max(0, area.width - (box?.width ?? 48));
    const dy = Math.max(0, area.height - (box?.height ?? 48));
    return {
      x: area.left + (next.edge === "left" ? 0 : next.edge === "right" ? dx : dx * next.ratio),
      y: area.top + (next.edge === "top" ? 0 : next.edge === "bottom" ? dy : dy * next.ratio),
    };
  }
  function write(x: number, y: number) {
    if (!root.current) return;
    root.current.style.left = `${x}px`;
    root.current.style.top = `${y}px`;
  }
  function attach(next: Anchor, animate = true) {
    const previous = root.current?.getBoundingClientRect();
    snap.current?.cancel();
    anchor.current = next;
    setEdge(next.edge);
    const target = point(next);
    write(target.x, target.y);
    if (animate && previous && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      snap.current =
        root.current?.animate(
          [
            { transform: `translate(${previous.left - target.x}px, ${previous.top - target.y}px)` },
            { transform: "translate(0, 0)" },
          ],
          { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" },
        ) ?? null;
  }
  function cancel() {
    const previous = drag.current;
    if (!previous) return;
    drag.current = null;
    suppressClick.current = previous.moved;
    setDragging(false);
    attach(previous.anchor);
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0 || !event.isPrimary || drag.current) return;
    suppressClick.current = false;
    const target = event.target as Element;
    const handle = target.closest("[data-dock-drag-handle], [data-dock-expand]");
    const background =
      event.pointerType === "mouse" && !target.closest("button, .hive-dock-options");
    const tap =
      event.pointerType === "touch"
        ? target.closest<HTMLButtonElement>("[data-dock-expand], [data-dock-minimise]")
        : null;
    if (!handle && !background && !tap) return;
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    snap.current?.cancel();
    write(box.left, box.top);
    suppressClick.current = false;
    // Handle a touch tap on the draggable button at pointer-up. Browsers can
    // suppress the compatibility click following a drag; keyboard clicks stay native.
    if (tap) {
      event.preventDefault();
      tap.focus({ preventScroll: true });
    }
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: box.left,
      top: box.top,
      moved: false,
      anchor: { ...anchor.current },
      tap,
      movable: !!handle || background,
    };
    // Touch has implicit capture; mouse drags need explicit capture outside the handle.
    if (event.pointerType !== "touch")
      (handle ?? event.currentTarget).setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 6) return;
    start.moved = true;
    event.preventDefault();
    if (!start.movable) return;
    const area = bounds(),
      box = surface.current?.getBoundingClientRect();
    write(
      area.left + clamp(start.left + dx - area.left, Math.max(0, area.width - (box?.width ?? 48))),
      area.top + clamp(start.top + dy - area.top, Math.max(0, area.height - (box?.height ?? 48))),
    );
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    suppressClick.current = start.moved;
    if (!start.moved) {
      if (start.tap) {
        event.preventDefault();
        start.tap.click();
      }
      return;
    }
    if (!start.movable) return;
    const area = bounds(),
      box = surface.current?.getBoundingClientRect();
    if (!box) return;
    const distances: Record<Edge, number> = {
      top: box.top - area.top,
      bottom: area.top + area.height - box.bottom,
      left: box.left - area.left,
      right: area.left + area.width - box.right,
    };
    const nearest = (Object.keys(distances) as Edge[]).sort(
      (a, b) => distances[a] - distances[b],
    )[0];
    const horizontal = nearest === "top" || nearest === "bottom";
    const range = horizontal ? area.width - box.width : area.height - box.height;
    const offset = horizontal ? box.left - area.left : box.top - area.top;
    attach({ edge: nearest, ratio: range > 0 ? clamp(offset / range) : 0.5 });
  }
  function key(event: KeyboardEvent<HTMLButtonElement>) {
    if (
      disabled ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const current = anchor.current,
      horizontal = current.edge === "top" || current.edge === "bottom";
    if (event.key === "Home" || event.key === "End")
      return attach({ ...current, ratio: event.key === "Home" ? 0 : 1 });
    const nextEdge: Edge =
      event.key === "ArrowUp"
        ? "top"
        : event.key === "ArrowDown"
          ? "bottom"
          : event.key === "ArrowLeft"
            ? "left"
            : "right";
    const along = horizontal
      ? ["ArrowLeft", "ArrowRight"].includes(event.key)
      : ["ArrowUp", "ArrowDown"].includes(event.key);
    const area = bounds(),
      box = surface.current?.getBoundingClientRect();
    if (along && !event.shiftKey) {
      const range = horizontal
        ? area.width - (box?.width ?? 48)
        : area.height - (box?.height ?? 48);
      const sign = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      attach({ ...current, ratio: clamp(current.ratio + (sign * 24) / Math.max(1, range)) });
    } else attach({ edge: nextEdge, ratio: 0.5 });
  }

  const latest = useRef({ bounds, point, write, cancel });
  latest.current = { bounds, point, write, cancel };
  useLayoutEffect(() => {
    const update = () => {
      const area = latest.current.bounds();
      root.current?.style.setProperty("--dock-available-width", `${area.width}px`);
      if (!drag.current) {
        const next = latest.current.point();
        latest.current.write(next.x, next.y);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    if (surface.current) observer.observe(surface.current);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    const cancelOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        event.stopPropagation();
        latest.current.cancel();
      }
    };
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => {
      observer.disconnect();
      snap.current?.cancel();
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("keydown", cancelOnEscape, true);
    };
  }, [surface]);

  return {
    root,
    edge,
    dragging,
    key,
    handlers: {
      onPointerDown: down,
      onPointerMove: move,
      onPointerUp: up,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
        if (suppressClick.current && event.detail > 0) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
        }
      },
    },
  };
}
