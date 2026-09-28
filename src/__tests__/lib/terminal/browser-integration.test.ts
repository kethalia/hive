// @vitest-environment jsdom
import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTerminalBrowserIntegration,
  openTerminalLink,
  terminalClipboardProvider,
} from "@/lib/terminal/browser-integration";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function surface(
  allowClipboardWrite = false,
  onFileAction?: import("@/lib/terminal/link-target").TerminalFileActionHandler,
) {
  const element = document.createElement("div");
  document.body.append(element);
  const osc = new Map<number, (data: string) => unknown>();
  const term = {
    element,
    cols: 80,
    options: {} as Terminal["options"],
    parser: {
      registerOscHandler: vi.fn((id: number, handler: (data: string) => unknown) => {
        osc.set(id, handler);
        return { dispose: vi.fn() };
      }),
    },
    input: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    loadAddon: vi.fn((addon) => addon.activate(term)),
  };
  const dispose = installTerminalBrowserIntegration(term as unknown as Terminal, {
    allowClipboardWrite,
    onFileAction,
  });
  return { term, osc, dispose };
}

describe("terminal browser integration", () => {
  it("opens only HTTP(S) links locally without an opener", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/file", "invalid"])
      openTerminalLink(url);
    expect(open).not.toHaveBeenCalled();
    openTerminalLink("https://example.com/docs");
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("consumes link mouse presses before they reach the remote TUI", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { term, dispose } = surface();
    const remote = vi.fn();
    term.element.addEventListener("mousedown", remote);
    term.element.addEventListener("mouseup", remote);
    term.options.linkHandler?.hover?.(
      new MouseEvent("mousemove"),
      "https://example.com",
      {} as never,
    );
    term.element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    term.element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    expect(remote).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    clickOpenUrl();
    expect(open).toHaveBeenCalledOnce();
    dispose();
    term.element.dispatchEvent(new MouseEvent("mousedown"));
    expect(remote).toHaveBeenCalledOnce();
  });

  it("does not open links after dragging or a Shift selection", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { term, dispose } = surface();
    term.options.linkHandler?.hover?.(
      new MouseEvent("mousemove"),
      "https://example.com",
      {} as never,
    );
    term.element.dispatchEvent(new MouseEvent("mousedown", { clientX: 1 }));
    term.element.dispatchEvent(new MouseEvent("mouseup", { clientX: 30 }));
    term.element.dispatchEvent(new MouseEvent("mousedown", { shiftKey: true }));
    term.element.dispatchEvent(new MouseEvent("mouseup", { shiftKey: true }));
    expect(open).not.toHaveBeenCalled();
    dispose();
  });

  it("handles real OSC 52 clipboard writes while never reading local clipboard data", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText, readText },
    });
    const { term, osc, dispose } = surface(true);
    const text = "a complete\nCodex selection";
    await osc.get(52)?.(`c;${btoa(text)}`);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    await osc.get(52)?.("c;?");
    expect(readText).not.toHaveBeenCalled();
    expect(term.input).toHaveBeenCalledWith("\x1b]52;c;\x07", false);
    dispose();
  });

  it("offers a local Copy action if browser clipboard permission requires a gesture", async () => {
    const { toast } = await import("sonner");
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    terminalClipboardProvider.writeText("c" as never, "selection");
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Terminal text is ready to copy",
        expect.objectContaining({ action: expect.objectContaining({ label: "Copy" }) }),
      ),
    );
  });
});

function touchEvent(type: string, x = 10, y = 20): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: [{ clientX: x, clientY: y }] },
    changedTouches: { value: [{ clientX: x, clientY: y }] },
  });
  return event;
}

it("does not open an old hover when touching padding without a link result", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { term, dispose } = surface();
  term.options.linkHandler?.hover?.(
    new MouseEvent("mousemove"),
    "https://old.example",
    {} as never,
  );
  term.element.dispatchEvent(touchEvent("touchstart"));
  term.element.dispatchEvent(touchEvent("touchend"));
  expect(open).not.toHaveBeenCalled();
  dispose();
});

it("opens only the current touch result, including delayed providers and repeated taps", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { term, dispose } = surface();
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  term.element.append(screen);
  const probes: MouseEvent[] = [];
  screen.addEventListener("mousemove", (event) => probes.push(event));
  const hover = (event: MouseEvent, url: string) =>
    term.options.linkHandler?.hover?.(event, url, {} as never);
  term.element.dispatchEvent(touchEvent("touchstart"));
  term.element.dispatchEvent(touchEvent("touchcancel"));
  term.element.dispatchEvent(touchEvent("touchstart"));
  hover(probes[0], "https://old.example");
  term.element.dispatchEvent(touchEvent("touchend"));
  expect(open).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++) {
    term.element.dispatchEvent(touchEvent("touchstart"));
    hover(probes.at(-1)!, "https://current.example");
    term.element.dispatchEvent(touchEvent("touchend"));
    clickOpenUrl();
  }
  expect(open).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenLastCalledWith(
    "https://current.example/",
    "_blank",
    "noopener,noreferrer",
  );
  dispose();
});

it("does not activate a touch link that was invalidated before release", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { term, dispose } = surface();
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  term.element.append(screen);
  screen.addEventListener("mousemove", (event) =>
    term.options.linkHandler?.hover?.(event, "https://example.com", {} as never),
  );
  term.element.dispatchEvent(touchEvent("touchstart"));
  term.options.linkHandler?.leave?.(
    new MouseEvent("mouseleave"),
    "https://example.com",
    {} as never,
  );
  term.element.dispatchEvent(touchEvent("touchend"));
  expect(open).not.toHaveBeenCalled();
  dispose();
});

it("does not register clipboard protocols on read-only surfaces", () => {
  const { osc, dispose } = surface();
  expect(osc.has(52)).toBe(false);
  dispose();
});

it.each([
  0, 1, 7, 8, 20,
])("rechecks the same xterm cell and tolerates %s px of touch movement", (movement) => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { term, dispose } = surface();
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  term.element.append(screen);
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: 800,
    width: 800,
  } as DOMRect);
  const remoteMotion = vi.fn();
  term.element.addEventListener("mousemove", remoteMotion);
  // Match xterm 6's Linkifier contract: mouseleave clears the link but retains
  // the last buffer cell, and mousemove only queries when that cell changes.
  let lastColumn = 0;
  let currentLink = false;
  screen.addEventListener("mouseleave", (event) => {
    currentLink = false;
    term.options.linkHandler?.leave?.(event, "https://example.com", {} as never);
  });
  screen.addEventListener("mousemove", (event) => {
    const column = Math.ceil(event.clientX / 10);
    if (column === lastColumn) return;
    lastColumn = column;
    if (column !== 1) return;
    currentLink = true;
    term.options.linkHandler?.hover?.(event, "https://example.com", {} as never);
  });
  for (let i = 0; i < 2; i++) {
    term.element.dispatchEvent(touchEvent("touchstart"));
    expect(currentLink).toBe(true);
    term.element.dispatchEvent(touchEvent("touchmove", 10 + movement));
    // Returning to the start must not turn an actual scroll into a tap.
    term.element.dispatchEvent(touchEvent("touchend"));
    if (movement < 8) clickOpenUrl();
    else expect(document.querySelector("[role=menu]")).toBeNull();
  }
  expect(open).toHaveBeenCalledTimes(movement < 8 ? 2 : 0);
  expect(remoteMotion).not.toHaveBeenCalled();
  dispose();
});

function clickOpenUrl() {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")).find(
    (item) => item.textContent === "Open URL in browser",
  );
  expect(button).toBeDefined();
  button?.click();
}

it("shows file actions on hover and keeps the menu open while entering it", () => {
  vi.useFakeTimers();
  const onFileAction = vi.fn();
  const { term, dispose } = surface(false, onFileAction);
  term.options.linkHandler?.hover?.(
    new MouseEvent("mousemove", { clientX: 20, clientY: 30 }),
    "file:///home/coder/my%20file.png",
    {} as never,
  );
  expect(document.querySelector("[role=menu]")).toBeNull();
  vi.advanceTimersByTime(400);
  const menu = document.querySelector("[role=menu]")!;
  expect(menu).not.toBeNull();
  term.options.linkHandler?.leave?.(
    new MouseEvent("mouseleave"),
    "file:///home/coder/my%20file.png",
    {} as never,
  );
  menu.dispatchEvent(new Event("pointerenter"));
  vi.advanceTimersByTime(500);
  expect(menu.isConnected).toBe(true);
  const buttons = Array.from(menu.querySelectorAll("button"));
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Copy path",
    "Download",
    "Open in Files in a new window",
    "Open in Files in a new workspace",
  ]);
  buttons[3].click();
  expect(onFileAction).toHaveBeenCalledWith("/home/coder/my file.png", "new-workspace");
  expect(menu.isConnected).toBe(false);
  dispose();
  vi.useRealTimers();
});

it("rejects unsafe OSC links and dismisses a menu with Escape", () => {
  const { term, dispose } = surface();
  term.options.linkHandler?.activate(new MouseEvent("click"), "javascript:alert(1)", {} as never);
  expect(document.querySelector("[role=menu]")).toBeNull();
  term.options.linkHandler?.activate(new MouseEvent("click"), "https://example.com", {} as never);
  expect(document.querySelector("[role=menu]")).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector("[role=menu]")).toBeNull();
  dispose();
});
