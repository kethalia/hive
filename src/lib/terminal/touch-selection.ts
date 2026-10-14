import type { Terminal } from "@xterm/xterm";
import { DRAG_LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from "@/lib/gestures/conventions";
import { copyTerminalSelection } from "./actions";
import { observeTerminalActivity } from "./activity";
import { terminalSelectionClipboard } from "./selection-clipboard";
import { isTerminalSelectionSurface } from "./selection-surface";
import { markTerminalTouchMouseEvent } from "./touch-mouse-events";

type Point = Pick<Touch, "clientX" | "clientY">;

/** Translate a held finger into the same mouse drag that desktop tmux receives. */
export function installTerminalTouchSelection(
  container: HTMLElement,
  {
    terminal,
    enabled,
    onStart,
    onFinish,
  }: {
    terminal: () => Terminal | null;
    enabled: () => boolean;
    onStart: () => void;
    onFinish: () => void;
  },
) {
  let gesture:
    | {
        id: number;
        start: Point;
        last: Point;
        term: Terminal;
        target: HTMLElement;
        active: boolean;
        moved: boolean;
        remote: boolean;
        anchor?: { x: number; y: number };
      }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const usable = () => enabled() && container.isConnected && !container.closest("[inert]");
  const mouse = (type: string, point: Point, buttons: number) => {
    if (!gesture) return;
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX: point.clientX,
      clientY: point.clientY,
    });
    markTerminalTouchMouseEvent(event);
    // xterm focuses its textarea on mousedown. Disable it only during dispatch
    // so a selection cannot open the soft keyboard or steal another pane's input.
    const helper = gesture.term.textarea;
    const disabled = helper?.disabled;
    const suppressFocus = type === "mousedown" && helper && document.activeElement !== helper;
    try {
      if (suppressFocus) helper.disabled = true;
      gesture.target.dispatchEvent(event);
    } finally {
      if (suppressFocus) helper.disabled = disabled ?? false;
    }
  };
  const cell = (point: Point) => {
    if (!gesture) return undefined;
    const rect = gesture.target.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    return {
      x: Math.max(
        0,
        Math.min(
          gesture.term.cols - 1,
          Math.floor(((point.clientX - rect.left) * gesture.term.cols) / rect.width),
        ),
      ),
      y:
        gesture.term.buffer.active.viewportY +
        Math.max(
          0,
          Math.min(
            gesture.term.rows - 1,
            Math.floor(((point.clientY - rect.top) * gesture.term.rows) / rect.height),
          ),
        ),
    };
  };
  const selectLocal = (point: Point) => {
    if (!gesture?.anchor) return;
    const end = cell(point);
    if (!end) return;
    const a = gesture.anchor.y * gesture.term.cols + gesture.anchor.x;
    const b = end.y * gesture.term.cols + end.x;
    const start = Math.min(a, b);
    gesture.term.select(
      start % gesture.term.cols,
      Math.floor(start / gesture.term.cols),
      Math.abs(b - a) + 1,
    );
  };
  const finish = (copy: boolean) => {
    clearTimeout(timer);
    const current = gesture;
    if (!current) return;
    if (current.active) {
      if (
        copy &&
        current.moved &&
        usable() &&
        terminal() === current.term &&
        !current.term.options.disableStdin
      ) {
        if (current.remote) terminalSelectionClipboard(current.term)?.release();
        else copyTerminalSelection(current.term);
      } else terminalSelectionClipboard(current.term)?.cancel();
      if (current.remote) mouse("mouseup", current.last, 0);
      delete container.dataset.terminalTouchSelecting;
      onFinish();
    }
    gesture = undefined;
  };
  const cancel = () => finish(false);
  const activity = observeTerminalActivity(container, cancel);
  const start = (event: TouchEvent) => {
    activity.flush();
    cancel();
    const term = terminal();
    const target = container.querySelector<HTMLElement>(".xterm-screen");
    if (
      !usable() ||
      !term ||
      !target ||
      event.touches.length !== 1 ||
      term.options.disableStdin ||
      !isTerminalSelectionSurface(target, event.target, event.touches[0])
    )
      return;
    const touch = event.touches[0];
    gesture = {
      id: touch.identifier,
      start: { clientX: touch.clientX, clientY: touch.clientY },
      last: touch,
      term,
      target,
      active: false,
      moved: false,
      remote: false,
    };
    timer = setTimeout(() => {
      activity.flush();
      if (!gesture || !usable() || terminal() !== term || term.options.disableStdin)
        return cancel();
      gesture.active = true;
      gesture.remote = term.modes.mouseTrackingMode !== "none";
      container.dataset.terminalTouchSelecting = "true";
      const current = gesture;
      onStart();
      if (gesture !== current) return;
      if (gesture.remote) {
        terminalSelectionClipboard(term)?.begin();
        mouse("mousedown", gesture.start, 1);
      } else {
        gesture.anchor = cell(gesture.start);
        selectLocal(gesture.start);
      }
    }, LONG_PRESS_MS);
  };
  const move = (event: TouchEvent) => {
    activity.flush();
    if (!gesture) return;
    if (
      event.touches.length !== 1 ||
      !usable() ||
      terminal() !== gesture.term ||
      gesture.term.options.disableStdin
    )
      return cancel();
    const touch = Array.from(event.touches).find((item) => item.identifier === gesture?.id);
    if (!touch) return cancel();
    if (!gesture.active) {
      if (
        Math.hypot(touch.clientX - gesture.start.clientX, touch.clientY - gesture.start.clientY) >=
        DRAG_LONG_PRESS_MOVE_PX
      )
        cancel();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    gesture.last = { clientX: touch.clientX, clientY: touch.clientY };
    gesture.moved ||=
      Math.hypot(touch.clientX - gesture.start.clientX, touch.clientY - gesture.start.clientY) >=
      DRAG_LONG_PRESS_MOVE_PX;
    if (gesture.remote) mouse("mousemove", touch, 1);
    else selectLocal(touch);
  };
  const end = (event: TouchEvent) => {
    activity.flush();
    if (
      !gesture ||
      !Array.from(event.changedTouches).some((item) => item.identifier === gesture?.id)
    )
      return;
    if (gesture.active) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    finish(event.type === "touchend" && event.touches.length === 0);
  };
  const visibility = () => {
    if (document.hidden) cancel();
  };
  container.addEventListener("touchstart", start, { capture: true, passive: true });
  container.addEventListener("touchmove", move, { capture: true, passive: false });
  document.addEventListener("touchend", end, { capture: true, passive: false });
  document.addEventListener("touchcancel", end, { capture: true, passive: false });
  window.addEventListener("blur", cancel);
  window.addEventListener("resize", cancel);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    activity.dispose();
    cancel();
    container.removeEventListener("touchstart", start, true);
    container.removeEventListener("touchmove", move, true);
    document.removeEventListener("touchend", end, true);
    document.removeEventListener("touchcancel", end, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("resize", cancel);
    document.removeEventListener("visibilitychange", visibility);
  };
}
