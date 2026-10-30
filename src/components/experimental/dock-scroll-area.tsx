import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { useDockAxis } from "./dock-axis";

export function DockScrollArea({
  children,
  label,
  activeItem,
  suspendLayout = false,
}: {
  children: ReactNode;
  label: "keys" | "spaces";
  activeItem?: string;
  suspendLayout?: boolean;
}) {
  const axis = useDockAxis();
  const Previous = axis.vertical ? ChevronUp : ChevronLeft;
  const Next = axis.vertical ? ChevronDown : ChevronRight;
  const id = useId();
  const frame = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  const measure = useCallback(() => {
    // A cap is already in the DOM while its tray makes room. Preserve the settled
    // overflow controls instead of treating that temporary width as real overflow.
    if (suspendLayout) return;
    const node = viewport.current,
      shell = frame.current;
    if (!node || !shell) return;
    const next = {
      overflow: node[axis.total] > shell[axis.client] + 1,
      left: node[axis.scroll] > 1,
      right: node[axis.scroll] + node[axis.client] < node[axis.total] - 1,
    };
    setEdges((current) =>
      current.overflow === next.overflow &&
      current.left === next.left &&
      current.right === next.right
        ? current
        : next,
    );
  }, [suspendLayout, axis]);
  const reveal = useCallback(() => {
    const node = viewport.current;
    if (!node || suspendLayout) return;
    const selected = Array.from(node.querySelectorAll<HTMLElement>("[data-dock-space]")).find(
      (item) => item.dataset.dockSpace === activeItem,
    );
    if (selected) {
      const item = selected.getBoundingClientRect(),
        bounds = node.getBoundingClientRect();
      const padding = Math.max(0, Math.min(10, (bounds[axis.size] - item[axis.size]) / 2));
      if (item[axis.start] < bounds[axis.start] + padding)
        node[axis.scroll] -= bounds[axis.start] + padding - item[axis.start];
      else if (item[axis.end] > bounds[axis.end] - padding)
        node[axis.scroll] += item[axis.end] - bounds[axis.end] + padding;
    }
  }, [activeItem, suspendLayout, axis]);
  useLayoutEffect(() => {
    const update = () => {
      reveal();
      measure();
    };
    update();
    const observer = new ResizeObserver(update);
    if (frame.current) observer.observe(frame.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [measure, reveal]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    if (axis.vertical) return;
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
      const next = Math.max(
        0,
        Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta),
      );
      if (Math.abs(next - node.scrollLeft) < 1) return;
      event.preventDefault();
      node.scrollLeft = next;
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [axis]);
  function scroll(direction: number) {
    const node = viewport.current;
    if (!node) return;
    node.scrollBy({
      [axis.scrollTo]: direction * Math.max(56, node[axis.client] - 60),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }
  return (
    <div
      ref={frame}
      className="hive-dock-scroll-frame"
      data-overflow={edges.overflow}
      data-can-left={edges.left}
      data-can-right={edges.right}
    >
      {edges.overflow ? (
        <Button
          type="button"
          variant="ghost"
          className="hive-dock-scroll-control"
          data-dock-scroll-control
          aria-label={`Scroll ${label} ${axis.vertical ? "up" : "left"}`}
          aria-controls={id}
          disabled={!edges.left}
          onClick={() => scroll(-1)}
        >
          <Previous aria-hidden="true" />
        </Button>
      ) : null}
      <div ref={viewport} id={id} className="hive-dock-options" onScroll={measure}>
        {children}
      </div>
      {edges.overflow ? (
        <Button
          type="button"
          variant="ghost"
          className="hive-dock-scroll-control"
          data-dock-scroll-control
          aria-label={`Scroll ${label} ${axis.vertical ? "down" : "right"}`}
          aria-controls={id}
          disabled={!edges.right}
          onClick={() => scroll(1)}
        >
          <Next aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
