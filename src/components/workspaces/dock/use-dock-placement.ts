import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { captureDockPose, type DockPoint, dockSpring, rotateDock } from "./dock-flight";

type Edge = "top" | "right" | "bottom" | "left";
type Anchor = { edge: Edge; ratio: number };
const clamp = (n: number, max = 1) => Math.max(0, Math.min(max, n));

/** Store an edge and a fraction along it, so resizing never strands the dock in the canvas. */
export function useDockPlacement(surface: RefObject<HTMLDivElement | null>, disabled: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor>({ edge: "bottom", ratio: 0.5 });
  const [edge, setEdge] = useState<Edge>("bottom");
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const coast = useRef<number | null>(null);
  const motionTicket = useRef(0);
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
    vx: number;
    vy: number;
    lastX: number;
    lastY: number;
    lastTime: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const rotation = useRef<Animation[]>([]);

  function stopMotion(freeze = false) {
    motionTicket.current++;
    if (coast.current !== null) cancelAnimationFrame(coast.current);
    coast.current = null;
    for (const animation of rotation.current) {
      if (freeze) {
        const time = animation.currentTime;
        animation.pause();
        animation.currentTime = time;
      } else animation.cancel();
    }
    if (!freeze) {
      rotation.current = [];
      surface.current?.style.removeProperty("scale");
    }
    setSettling(false);
  }

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
  function constrain() {
    const shell = surface.current,
      host = root.current;
    if (!shell || !host) return;
    const area = bounds();
    shell.style.removeProperty("scale");
    let box = shell.getBoundingClientRect();
    if (box.width > area.width + 0.1 || box.height > area.height + 0.1) {
      shell.style.scale = String(Math.min(area.width / box.width, area.height / box.height));
      box = shell.getBoundingClientRect();
    }
    const dx =
      box.left < area.left ? area.left - box.left : Math.min(0, area.left + area.width - box.right);
    const dy =
      box.top < area.top ? area.top - box.top : Math.min(0, area.top + area.height - box.bottom);
    if (dx || dy)
      write(Number.parseFloat(host.style.left) + dx, Number.parseFloat(host.style.top) + dy);
  }

  function fly(
    next: Anchor,
    velocity: DockPoint = { x: 0, y: 0 },
    animate = true,
    projected?: DockPoint,
  ) {
    const host = root.current,
      shell = surface.current;
    if (!host || !shell) return;
    const pose = captureDockPose(host, shell);
    stopMotion();
    coast.current = 0; // Suppress observer anchoring while React resolves the new axis.
    anchor.current = next;
    const area = bounds();
    host.style.setProperty("--dock-available-width", `${area.width}px`);
    host.style.setProperty("--dock-available-height", `${area.height}px`);
    // Child layout effects settle scrolling/overflow before target geometry is read.
    flushSync(() => {
      setEdge(next.edge);
      setSettling(true);
    });
    host.dataset.orientation =
      next.edge === "left" || next.edge === "right" ? "vertical" : "horizontal";
    const width = shell.offsetWidth,
      height = shell.offsetHeight;
    if (projected) {
      const horizontal = next.edge === "top" || next.edge === "bottom";
      const span = horizontal ? width : height;
      const range = (horizontal ? area.width : area.height) - span;
      const value = horizontal ? projected.x - area.left : projected.y - area.top;
      anchor.current = {
        edge: next.edge,
        ratio: range > 0 ? clamp((value - span / 2) / range) : 0.5,
      };
    }
    const target = point();
    write(target.x, target.y);
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      coast.current = null;
      setSettling(false);
      return;
    }
    const from = {
      x: pose.bounds.left + pose.bounds.width / 2,
      y: pose.bounds.top + pose.bounds.height / 2,
    };
    const to = { x: target.x + width / 2, y: target.y + height / 2 };
    const spring = dockSpring(from, to, velocity);
    const rotationDuration = 320;
    rotation.current = rotateDock(pose, host, shell, rotationDuration);
    for (const animation of rotation.current) animation.currentTime = 0;
    write(from.x - width / 2, from.y - height / 2);
    constrain();
    const generation = motionTicket.current,
      start = performance.now();
    const step = (now: number) => {
      if (generation !== motionTicket.current) return;
      const elapsed = now - start;
      for (const animation of rotation.current)
        animation.currentTime = Math.min(elapsed, rotationDuration);
      const centre = spring(elapsed);
      write(centre.x - width / 2, centre.y - height / 2);
      constrain();
      const actual = shell.getBoundingClientRect();
      const landed =
        Math.hypot(actual.left + actual.width / 2 - to.x, actual.top + actual.height / 2 - to.y) <
        0.1;
      const ready = rotation.current.length === 0 || elapsed >= rotationDuration;
      if ((ready && landed) || elapsed >= 1200) {
        coast.current = null;
        for (const animation of rotation.current) animation.cancel();
        rotation.current = [];
        shell.style.removeProperty("scale");
        const end = point();
        write(end.x, end.y);
        setSettling(false);
      } else coast.current = requestAnimationFrame(step);
    };
    coast.current = requestAnimationFrame(step);
  }
  function attach(next: Anchor, animate = true) {
    fly(next, { x: 0, y: 0 }, animate);
  }

  function nearest() {
    const area = bounds(),
      box = surface.current?.getBoundingClientRect();
    if (!box) return anchor.current;
    const distances: Record<Edge, number> = {
      top: box.top - area.top,
      bottom: area.top + area.height - box.bottom,
      left: box.left - area.left,
      right: area.left + area.width - box.right,
    };
    const centres: Record<Edge, number> = {
      top: box.top + box.height / 2 - area.top,
      bottom: area.top + area.height - box.top - box.height / 2,
      left: box.left + box.width / 2 - area.left,
      right: area.left + area.width - box.left - box.width / 2,
    };
    // Prefer the centre's nearest edge when a long strip touches several edges.
    const next = (Object.keys(distances) as Edge[]).sort((a, b) =>
      Math.abs(distances[a] - distances[b]) > 1
        ? distances[a] - distances[b]
        : centres[a] - centres[b],
    )[0];
    const horizontal = next === "top" || next === "bottom";
    const range = horizontal ? area.width - box.width : area.height - box.height;
    const offset = horizontal ? box.left - area.left : box.top - area.top;
    return { edge: next, ratio: range > 0 ? clamp(offset / range) : 0.5 };
  }
  function releaseMomentum(vx: number, vy: number) {
    const shell = surface.current;
    if (!shell) return;
    const speed = Math.hypot(vx, vy);
    if (speed < 0.05) {
      attach(nearest());
      return;
    }
    const box = shell.getBoundingClientRect(),
      area = bounds();
    const projected = {
      x: area.left + clamp(box.left + box.width / 2 + vx * 220 - area.left, area.width),
      y: area.top + clamp(box.top + box.height / 2 + vy * 220 - area.top, area.height),
    };
    const distances: Record<Edge, number> = {
      left: (projected.x - area.left) / area.width,
      right: (area.left + area.width - projected.x) / area.width,
      top: (projected.y - area.top) / area.height,
      bottom: (area.top + area.height - projected.y) / area.height,
    };
    const choices = Object.keys(distances) as Edge[];
    const edge = choices.sort((a, b) => distances[a] - distances[b])[0];
    fly({ edge, ratio: 0.5 }, { x: vx, y: vy }, true, projected);
  }

  function cancel() {
    const previous = drag.current;
    if (!previous) return;
    drag.current = null;
    suppressClick.current = previous.moved;
    setDragging(false);
    attach(previous.anchor);
  }
  function finishMovement() {
    drag.current = null;
    setDragging(false);
    stopMotion();
    const end = point();
    write(end.x, end.y);
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (
      disabled ||
      event.button !== 0 ||
      !event.isPrimary ||
      drag.current ||
      surface.current?.querySelector('nav[aria-busy="true"]')
    )
      return;
    suppressClick.current = false;
    const target = event.target as Element;
    const handle = target.closest("[data-dock-drag-handle], [data-dock-expand]");
    const background =
      event.pointerType === "mouse" && !target.closest("button, .hive-dock-options");
    const tap =
      event.pointerType === "touch"
        ? target.closest<HTMLButtonElement>("[data-dock-expand], [data-dock-minimise]")
        : null;
    const control = target.closest("[data-dock-minimise]");
    if (!handle && !background && !tap && !control) return;
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const movable = !!handle || background;
    stopMotion(movable);
    if (movable) write(box.left, box.top);
    else {
      const end = point();
      write(end.x, end.y);
    }
    constrain();
    const origin = root.current?.getBoundingClientRect() ?? box;
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
      left: origin.left,
      top: origin.top,
      moved: false,
      anchor: { ...anchor.current },
      tap,
      movable,
      vx: 0,
      vy: 0,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: performance.now(),
    };
    // Touch has implicit capture; mouse drags need explicit capture outside the handle.
    if (event.pointerType !== "touch")
      (handle ?? control ?? event.currentTarget).setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    const now = performance.now(),
      dt = Math.max(8, now - start.lastTime);
    const retain = Math.exp(-dt / 20);
    start.vx =
      start.vx * retain +
      Math.max(-6, Math.min(6, (event.clientX - start.lastX) / dt)) * (1 - retain);
    start.vy =
      start.vy * retain +
      Math.max(-6, Math.min(6, (event.clientY - start.lastY) / dt)) * (1 - retain);
    start.lastX = event.clientX;
    start.lastY = event.clientY;
    start.lastTime = now;
    if (!start.moved && Math.hypot(dx, dy) < 6) return;
    start.moved = true;
    event.preventDefault();
    if (!start.movable) return;
    const wantedX = start.left + dx,
      wantedY = start.top + dy;
    write(wantedX, wantedY);
    constrain();
    // A screen boundary absorbs velocity normal to it instead of inventing momentum.
    if (Math.abs(Number.parseFloat(root.current?.style.left ?? "0") - wantedX) > 0.5) start.vx = 0;
    if (Math.abs(Number.parseFloat(root.current?.style.top ?? "0") - wantedY) > 0.5) start.vy = 0;
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
    const decay = Math.exp(-(performance.now() - start.lastTime) / 80);
    releaseMomentum(start.vx * decay, start.vy * decay);
  }
  function key(event: KeyboardEvent<HTMLButtonElement>) {
    if (
      disabled ||
      drag.current ||
      surface.current?.querySelector('nav[aria-busy="true"]') ||
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

  const latest = useRef({ bounds, point, write, cancel, stopMotion });
  latest.current = { bounds, point, write, cancel, stopMotion };
  useLayoutEffect(() => {
    const update = () => {
      const area = latest.current.bounds();
      root.current?.style.setProperty("--dock-available-width", `${area.width}px`);
      root.current?.style.setProperty("--dock-available-height", `${area.height}px`);
      if (!drag.current && coast.current === null) {
        const next = latest.current.point();
        latest.current.write(next.x, next.y);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    if (surface.current) observer.observe(surface.current);
    const resize = () => {
      latest.current.stopMotion();
      update();
    };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
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
      motionTicket.current++;
      if (coast.current !== null) cancelAnimationFrame(coast.current);
      for (const animation of rotation.current) animation.cancel();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("keydown", cancelOnEscape, true);
    };
  }, [surface]);

  return {
    root,
    edge,
    dragging,
    settling,
    moving: dragging || settling,
    finishMovement,
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
