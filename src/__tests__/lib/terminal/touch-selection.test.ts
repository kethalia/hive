// @vitest-environment jsdom
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isTerminalTouchMouseEvent } from "@/lib/terminal/touch-mouse-events";
import { installTerminalTouchSelection } from "@/lib/terminal/touch-selection";

const clipboard = vi.hoisted(() => ({ begin: vi.fn(), release: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/terminal/selection-clipboard", () => ({
  terminalSelectionClipboard: () => clipboard,
}));
vi.mock("@/lib/terminal/actions", () => ({ copyTerminalSelection: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function setup(remote = true) {
  const container = document.createElement("div");
  container.innerHTML =
    '<div class="xterm"><div class="xterm-screen"></div><textarea></textarea></div>';
  document.body.append(container);
  const screen = container.querySelector<HTMLElement>(".xterm-screen")!;
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 240, width: 800, height: 240 }) as DOMRect;
  const term = {
    textarea: container.querySelector("textarea"),
    modes: { mouseTrackingMode: remote ? "drag" : "none" },
    cols: 80,
    rows: 24,
    options: { disableStdin: false },
    buffer: { active: { viewportY: 0 } },
    select: vi.fn(),
  };
  let current = term;
  const onStart = vi.fn();
  const onFinish = vi.fn();
  const events: MouseEvent[] = [];
  for (const type of ["mousedown", "mousemove", "mouseup"])
    screen.addEventListener(type, (event) => events.push(event as MouseEvent));
  const dispose = installTerminalTouchSelection(container, {
    terminal: () => current as unknown as Terminal,
    enabled: () => true,
    onStart,
    onFinish,
  });
  const touch = (type: string, x = 20, y = 20, count = 1, target: Element = screen) => {
    const point = { identifier: 1, clientX: x, clientY: y };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: {
        value:
          type === "touchend" || type === "touchcancel"
            ? []
            : Array.from({ length: count }, (_, i) => ({ ...point, identifier: i + 1 })),
      },
      changedTouches: { value: [point] },
    });
    target.dispatchEvent(event);
    return event;
  };
  return {
    container,
    screen,
    term,
    events,
    touch,
    dispose,
    onStart,
    onFinish,
    replace: () => {
      current = { ...term };
    },
  };
}

it("holds, drags and releases the same mouse events tmux expects without focusing the keyboard", () => {
  const state = setup();
  const disabled: boolean[] = [];
  state.screen.addEventListener("mousedown", () => disabled.push(state.term.textarea!.disabled));
  state.touch("touchstart");
  vi.advanceTimersByTime(499);
  expect(state.events).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(state.onStart).toHaveBeenCalledOnce();
  expect(clipboard.begin).toHaveBeenCalledOnce();
  expect(disabled).toEqual([true]);
  expect(state.term.textarea!.disabled).toBe(false);
  expect(state.touch("touchmove", 120, 40).defaultPrevented).toBe(true);
  expect(state.touch("touchend", 120, 40).defaultPrevented).toBe(true);
  expect(
    state.events.map((event) => [event.type, event.buttons, isTerminalTouchMouseEvent(event)]),
  ).toEqual([
    ["mousedown", 1, true],
    ["mousemove", 1, true],
    ["mouseup", 0, true],
  ]);
  expect(clipboard.release).toHaveBeenCalledOnce();
  expect(state.container.hasAttribute("data-terminal-touch-selecting")).toBe(false);
  expect(state.onFinish).toHaveBeenCalledOnce();
  state.dispose();
});

it.each([
  "tap",
  "swipe",
  "multi-touch",
  "disabled",
  "inert",
])("leaves %s out of selection", (kind) => {
  const state = setup();
  if (kind === "disabled") state.term.options.disableStdin = true;
  if (kind === "inert") state.container.setAttribute("inert", "");
  state.touch("touchstart", 20, 20, kind === "multi-touch" ? 2 : 1);
  if (kind === "tap") state.touch("touchend");
  if (kind === "swipe") expect(state.touch("touchmove", 20, 100).defaultPrevented).toBe(false);
  vi.advanceTimersByTime(600);
  expect(state.events).toEqual([]);
  expect(clipboard.release).not.toHaveBeenCalled();
  state.dispose();
});

it.each([
  "touchcancel",
  "multi-touch",
  "blur",
  "dispose",
  "replace",
  "inert",
])("releases a held mouse without copying on %s", (kind) => {
  const state = setup();
  state.touch("touchstart");
  vi.advanceTimersByTime(500);
  state.touch("touchmove", 100);
  if (kind === "touchcancel") state.touch("touchcancel");
  if (kind === "multi-touch") state.touch("touchmove", 100, 20, 2);
  if (kind === "blur") window.dispatchEvent(new Event("blur"));
  if (kind === "dispose") state.dispose();
  if (kind === "replace") {
    state.replace();
    state.touch("touchend", 100);
  }
  if (kind === "inert") {
    state.container.setAttribute("inert", "");
    state.touch("touchend", 100);
  }
  expect(state.events.at(-1)?.type).toBe("mouseup");
  expect(clipboard.release).not.toHaveBeenCalled();
  expect(clipboard.cancel).toHaveBeenCalled();
  state.dispose();
});

it("does not copy a stationary hold", () => {
  const state = setup();
  state.touch("touchstart");
  vi.advanceTimersByTime(600);
  state.touch("touchend");
  expect(clipboard.release).not.toHaveBeenCalled();
  expect(state.events.map((event) => event.type)).toEqual(["mousedown", "mouseup"]);
  state.dispose();
});

it("preserves an already focused terminal input during selection", () => {
  const state = setup();
  state.term.textarea!.focus();
  state.touch("touchstart");
  vi.advanceTimersByTime(500);
  state.touch("touchmove", 120);
  state.touch("touchend", 120);
  expect(document.activeElement).toBe(state.term.textarea);
  state.dispose();
});

it("ends the held drag when a pane parks and returns before the next touch event", () => {
  const state = setup();
  state.touch("touchstart");
  vi.advanceTimersByTime(500);
  state.touch("touchmove", 120);
  state.container.setAttribute("inert", "");
  state.container.removeAttribute("inert");
  state.touch("touchend", 120);
  expect(clipboard.release).not.toHaveBeenCalled();
  expect(state.events.at(-1)?.type).toBe("mouseup");
  state.dispose();
});

it.each(["chrome", "helper"])("does not turn a touch on %s into a terminal selection", (kind) => {
  const state = setup();
  const target = document.createElement("div");
  if (kind === "helper") {
    target.className = "xterm-helpers";
    state.screen.append(target);
  } else state.container.append(target);
  state.touch("touchstart", 20, 20, 1, target);
  vi.advanceTimersByTime(600);
  expect(state.onStart).not.toHaveBeenCalled();
  expect(clipboard.begin).not.toHaveBeenCalled();
  expect(state.events).toEqual([]);
  state.dispose();
});

it("uses xterm's own selection when the remote application does not enable mouse mode", async () => {
  const { copyTerminalSelection } = await import("@/lib/terminal/actions");
  const state = setup(false);
  state.touch("touchstart", 10, 10);
  vi.advanceTimersByTime(500);
  state.touch("touchmove", 60, 20);
  state.touch("touchend", 60, 20);
  expect(state.events).toEqual([]);
  expect(state.term.select).toHaveBeenCalledWith(1, 1, 86);
  expect(copyTerminalSelection).toHaveBeenCalledWith(state.term);
  state.dispose();
});
