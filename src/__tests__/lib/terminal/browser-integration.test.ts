// @vitest-environment jsdom
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTerminalBrowserIntegration,
  openTerminalLink,
  terminalClipboardProvider,
} from "@/lib/terminal/browser-integration";
import { createTerminalLinkMenu } from "@/lib/terminal/link-menu";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function settleValidation() {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((resolve) => setTimeout(resolve, 0));
}

function surface(
  allowClipboardWrite = false,
  onFileAction?: import("@/lib/terminal/link-target").TerminalFileActionHandler,
  validatePaths: import("@/lib/terminal/link-target").TerminalPathValidator = (paths) => paths,
) {
  const element = document.createElement("div");
  document.body.append(element);
  const osc = new Map<number, (data: string) => unknown>();
  const events = {
    scroll: () => {},
    parsed: () => {},
    resize: () => {},
    input: (_data = "") => {},
  };
  const resizeDispose = vi.fn();
  const scrollDispose = vi.fn();
  const parsedDispose = vi.fn();
  const lines = ["docs/image.png", "other output"];
  const term = {
    rows: 2,
    buffer: {
      active: {
        viewportY: 0,
        length: 2,
        getLine: (row: number) => ({
          isWrapped: false,
          translateToString: () => lines[row] ?? "",
          getCell: (col: number) => ({
            getWidth: () => 1,
            getChars: () => lines[row]?.[col] ?? "",
          }),
        }),
      },
    },
    onData: vi.fn((handler) => {
      events.input = handler;
      return { dispose: vi.fn() };
    }),
    onResize: vi.fn((handler) => {
      events.resize = handler;
      return { dispose: resizeDispose };
    }),
    onScroll: vi.fn((handler) => {
      events.scroll = handler;
      return { dispose: scrollDispose };
    }),
    onWriteParsed: vi.fn((handler) => {
      events.parsed = handler;
      return { dispose: parsedDispose };
    }),
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
    registerLinkProvider: vi.fn((_provider: ILinkProvider) => ({ dispose: vi.fn() })),
    loadAddon: vi.fn((addon) => addon.activate(term)),
  };
  const dispose = installTerminalBrowserIntegration(term as unknown as Terminal, {
    allowClipboardWrite,
    onFileAction,
    validatePaths,
  });
  let plainLink!: ILink;
  term.registerLinkProvider.mock.calls.at(-1)![0].provideLinks(1, (links) => {
    plainLink = links![0];
  });
  return {
    term,
    osc,
    dispose,
    events,
    lines,
    scrollDispose,
    parsedDispose,
    resizeDispose,
    plainLink,
  };
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
    "Open in Files (new window)",
    "Open in Files (new workspace)",
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

it("dismisses stale links after buffer changes and keyboard scrolling, but keeps unchanged redraws", () => {
  vi.useFakeTimers();
  const { term, dispose, events, lines, scrollDispose, parsedDispose, plainLink, resizeDispose } =
    surface();
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  term.element.append(screen);
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({ top: 0, height: 40 } as DOMRect);
  const show = () => plainLink.activate(new MouseEvent("click", { clientY: 10 }), "docs/image.png");
  show();
  events.parsed();
  lines[1] = "unrelated status update";
  events.parsed();
  expect(document.querySelector("[role=menu]")).not.toBeNull();
  // Hovering another confirmed file immediately replaces the menu and its anchor.
  plainLink.hover?.(new MouseEvent("mousemove", { clientY: 30 }), "docs/other.png");
  lines[1] = "replacement output";
  events.parsed();
  expect(document.querySelector("[role=menu]")).toBeNull();
  show();
  events.scroll();
  expect(document.querySelector("[role=menu]")).toBeNull();
  plainLink.hover?.(new MouseEvent("mousemove", { clientY: 10 }), "docs/image.png");
  events.scroll();
  vi.advanceTimersByTime(500);
  expect(document.querySelector("[role=menu]")).toBeNull();
  plainLink.hover?.(new MouseEvent("mousemove", { clientY: 10 }), "docs/image.png");
  lines[0] = "changed before hover delay elapsed";
  events.parsed();
  vi.advanceTimersByTime(500);
  expect(document.querySelector("[role=menu]")).toBeNull();
  dispose();
  expect(resizeDispose).toHaveBeenCalledOnce();
  expect(scrollDispose).toHaveBeenCalledOnce();
  expect(parsedDispose).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

function positionedSurface(
  validatePaths?: import("@/lib/terminal/link-target").TerminalPathValidator,
) {
  const result = surface(false, vi.fn(), validatePaths);
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  result.term.element.append(screen);
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({ top: 0, height: 40 } as DOMRect);
  return result;
}

it.each([
  "activate",
  "hover-click",
])("invalidates OSC metadata on writes after %s even when the label is unchanged", (mode) => {
  vi.useFakeTimers();
  const { term, events, dispose } = positionedSurface();
  if (mode === "activate") {
    term.options.linkHandler?.activate(
      new MouseEvent("click", { clientY: 10 }),
      "https://old.example",
      {} as never,
    );
  } else {
    term.options.linkHandler?.hover?.(
      new MouseEvent("mousemove", { clientY: 10 }),
      "https://old.example",
      {} as never,
    );
    vi.advanceTimersByTime(400);
    term.element.dispatchEvent(new MouseEvent("mousedown", { clientY: 10 }));
    term.element.dispatchEvent(new MouseEvent("mouseup", { clientY: 10 }));
  }
  expect(document.querySelector("[role=menu]")).not.toBeNull();
  events.parsed(); // OSC 8 URI changes cannot be verified through public text cells.
  expect(document.querySelector("[role=menu]")).toBeNull();
  dispose();
  vi.useRealTimers();
});

it("closes open menus and cancels pending menus on terminal-only resize", () => {
  vi.useFakeTimers();
  const { plainLink, events, dispose } = positionedSurface();
  plainLink.activate(new MouseEvent("click", { clientY: 10 }), "docs/image.png");
  events.resize();
  expect(document.querySelector("[role=menu]")).toBeNull();
  plainLink.hover?.(new MouseEvent("mousemove", { clientY: 10 }), "docs/image.png");
  events.resize();
  vi.advanceTimersByTime(500);
  expect(document.querySelector("[role=menu]")).toBeNull();
  dispose();
  vi.useRealTimers();
});

it("dismisses the new file menu when its row changes", () => {
  vi.useFakeTimers();
  const { plainLink, events, lines, dispose } = positionedSurface();
  plainLink.activate(new MouseEvent("click", { clientY: 10 }), "docs/image.png");
  plainLink.hover?.(new MouseEvent("mousemove", { clientY: 30 }), "docs/other.png");
  lines[1] = "changed pending row";
  events.parsed();
  vi.advanceTimersByTime(500);
  expect(document.querySelector("[role=menu]")).toBeNull();
  dispose();
  vi.useRealTimers();
});

it.each([
  "escape",
  "outside",
  "action",
  "replacement",
])("forgets the active anchor after %s closes the menu", (method) => {
  vi.useFakeTimers();
  const { term, plainLink, events, lines, dispose } = positionedSurface();
  plainLink.activate(new MouseEvent("click", { clientY: 10 }), "docs/image.png");
  let replacement: ReturnType<typeof createTerminalLinkMenu> | undefined;
  if (method === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  if (method === "outside")
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  if (method === "action")
    document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")[2].click();
  if (method === "replacement") {
    replacement = createTerminalLinkMenu();
    replacement.show("https://other.example", 0, 0);
  }
  term.element.dispatchEvent(new MouseEvent("mousemove", { clientY: 30 }));
  plainLink.hover?.(new MouseEvent("mousemove", { clientY: 30 }), "docs/other.png");
  lines[0] = "old menu row changed";
  events.parsed();
  vi.advanceTimersByTime(500);
  expect(document.querySelector("[role=menu]")?.textContent).toContain("docs/other.png");
  replacement?.dispose();
  dispose();
  vi.useRealTimers();
});

it("rejects missing explicit file links while allowing web URLs", () => {
  const { term, dispose } = surface(false, undefined, () => []);
  term.options.linkHandler?.activate(
    new MouseEvent("click"),
    "file:///home/coder/token/DPP",
    undefined as never,
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  term.options.linkHandler?.activate(
    new MouseEvent("click"),
    "https://example.com",
    undefined as never,
  );
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Copy URL");
  dispose();
});

it("ignores a delayed file check after leaving the link", async () => {
  vi.useFakeTimers();
  let resolve!: (paths: string[]) => void;
  const { term, dispose } = surface(
    false,
    undefined,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  term.options.linkHandler?.hover?.(
    new MouseEvent("mousemove"),
    "file:///home/coder/real.md",
    undefined as never,
  );
  expect(document.querySelector("[role=status]")?.textContent).toContain("Checking file…");
  term.options.linkHandler?.leave?.(
    new MouseEvent("mouseleave"),
    "file:///home/coder/real.md",
    undefined as never,
  );
  expect(document.querySelector("[role=status]")).toBeNull();
  resolve(["/home/coder/real.md"]);
  await settleValidation();
  vi.advanceTimersByTime(500);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  dispose();
});

it.each([
  "touchcancel",
  "touchmove",
])("does not open a delayed touch result after %s", (cancelEvent) => {
  const { term, plainLink, dispose } = surface();
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  term.element.append(screen);
  let probe!: MouseEvent;
  screen.addEventListener("mousemove", (event) => {
    probe = event;
  });
  term.element.dispatchEvent(touchEvent("touchstart"));
  term.element.dispatchEvent(touchEvent(cancelEvent, 100, 100));
  term.element.dispatchEvent(touchEvent("touchend", 100, 100));
  plainLink.hover?.(probe, plainLink.text);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  dispose();
});

it("shows loading after a quick tap and opens even when validation takes over five seconds", async () => {
  vi.useFakeTimers();
  let resolve!: (paths: string[]) => void;
  const { term, dispose } = positionedSurface(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const screen = term.element.querySelector(".xterm-screen")!;
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 40,
    bottom: 40,
    right: 800,
  } as DOMRect);
  screen.addEventListener("mousemove", (event) => {
    term.registerLinkProvider.mock.calls
      .at(-1)![0]
      .provideLinks(1, (links) => links?.[0]?.hover?.(event as MouseEvent, links[0].text));
  });
  term.element.dispatchEvent(touchEvent("touchstart", 10, 10));
  const end = touchEvent("touchend", 10, 10);
  term.element.dispatchEvent(end);
  expect(end.defaultPrevented).toBe(true);
  expect(document.querySelector("[role=status]")?.textContent).toContain("Checking file…");
  expect(document.querySelector("[role=menuitem]")).toBeNull();
  await vi.advanceTimersByTimeAsync(6000);
  resolve(["docs/image.png"]);
  await settleValidation();
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("docs/image.png");
  dispose();
});

it.each(["empty", "rejected", "other-cell"])("does not consume a blank-cell tap (%s)", (mode) => {
  const { term, dispose } = positionedSurface(
    mode === "rejected"
      ? () => []
      : mode === "other-cell"
        ? () => new Promise(() => {})
        : undefined,
  );
  const screen = term.element.querySelector(".xterm-screen")!;
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 40,
    bottom: 40,
    right: 800,
  } as DOMRect);
  term.element.dispatchEvent(touchEvent("touchstart", 700, 10));
  const end = touchEvent("touchend", 700, 10);
  term.element.dispatchEvent(end);
  expect(end.defaultPrevented).toBe(false);
  dispose();
});

function pendingFileHover() {
  let resolve!: (paths: string[]) => void;
  const result = positionedSurface(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  result.term.options.linkHandler?.hover?.(
    new MouseEvent("mousemove", { clientY: 10 }),
    "file:///home/coder/real.md",
    {} as never,
  );
  return { ...result, resolve: (paths = ["/home/coder/real.md"]) => resolve(paths) };
}

it("keeps pending OSC file validation through unrelated terminal writes", async () => {
  vi.useFakeTimers();
  const { lines, events, resolve, dispose } = pendingFileHover();
  lines[1] = "unrelated progress";
  events.parsed();
  resolve();
  await settleValidation();
  vi.advanceTimersByTime(500);
  expect(document.querySelector("[role=menu]")?.textContent).toContain("/home/coder/real.md");
  dispose();
});

it.each([
  "text",
  "metadata",
])("rejects pending OSC validation after anchored %s changes", async (change) => {
  vi.useFakeTimers();
  const { lines, events, osc, resolve, dispose } = pendingFileHover();
  if (change === "text") lines[0] = "replacement text";
  else expect(osc.get(8)?.(";file:///home/coder/replaced.md")).toBe(false);
  events.parsed();
  resolve();
  await settleValidation();
  vi.advanceTimersByTime(500);
  expect(document.querySelector("[role=menu]")).toBeNull();
  dispose();
});

it.each([
  true,
  false,
])("consumes mouse input before file validation completes (exists=%s)", async (exists) => {
  const { term, resolve, dispose } = pendingFileHover();
  const remote = vi.fn();
  term.element.addEventListener("mousedown", remote);
  term.element.addEventListener("mouseup", remote);
  term.element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 10 }));
  term.element.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 10 }),
  );
  term.element.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientY: 10 }),
  );
  expect(remote).not.toHaveBeenCalled();
  expect(document.querySelector("[role=menu]")).toBeNull();
  resolve(exists ? ["/home/coder/real.md"] : []);
  await settleValidation();
  expect(Boolean(document.querySelector("[role=menu]"))).toBe(exists);
  dispose();
});

it("preserves Shift selection while file validation is pending", async () => {
  const { term, resolve, dispose } = pendingFileHover();
  const remote = vi.fn();
  term.element.addEventListener("mousedown", remote);
  term.element.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, shiftKey: true, clientY: 10 }),
  );
  term.element.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, shiftKey: true, clientY: 10 }),
  );
  expect(remote).toHaveBeenCalledOnce();
  resolve();
  await settleValidation();
  expect(document.querySelector("[role=menu]")).toBeNull();
  dispose();
});

it.each([
  "before-release",
  "after-release",
  "missing",
])("holds plain-path clicks during validation (%s)", async (mode) => {
  let resolve!: (paths: string[]) => void;
  const { term, dispose } = positionedSurface(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const screen = term.element.querySelector(".xterm-screen")!;
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 40,
    bottom: 40,
    right: 800,
  } as DOMRect);
  const remote = vi.fn();
  term.element.addEventListener("mousedown", remote);
  term.element.addEventListener("mouseup", remote);
  term.element.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }),
  );
  term.element.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
  if (mode === "before-release") {
    resolve(["docs/image.png"]);
    await settleValidation();
  }
  term.element.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
  expect(remote).not.toHaveBeenCalled();
  resolve(mode === "missing" ? [] : ["docs/image.png"]);
  await new Promise((done) => setTimeout(done, 0));
  expect(Boolean(document.querySelector("[role=menu]"))).toBe(mode !== "missing");
  dispose();
});

it("reanchors a repeated file destination to its second row", () => {
  vi.useFakeTimers();
  const { term, plainLink, lines, events, dispose } = positionedSurface();
  lines[1] = lines[0];
  let second!: ILink;
  term.registerLinkProvider.mock.calls.at(-1)![0].provideLinks(2, (links) => {
    second = links![0];
  });
  plainLink.activate(new MouseEvent("click", { clientY: 10 }), plainLink.text);
  second.hover?.(new MouseEvent("mousemove", { clientY: 30 }), second.text);
  vi.advanceTimersByTime(400);
  const menu = document.querySelector("[role=menu]");
  lines[0] = "changed first occurrence";
  events.parsed();
  expect(document.querySelector("[role=menu]")).toBe(menu);
  expect(menu).not.toBeNull();
  dispose();
});

it.each([
  "input",
  "parsed",
] as const)("rechecks relative files after terminal %s", async (activity) => {
  const validate = vi.fn((paths: string[]) => paths);
  const { term, events, dispose } = surface(false, undefined, validate);
  const provider = term.registerLinkProvider.mock.calls.at(-1)![0];
  const callback = vi.fn();
  provider.provideLinks(1, callback);
  expect(validate).toHaveBeenCalledTimes(1);
  if (activity === "input") events.input("\r");
  else events.parsed();
  validate.mockReturnValue([]);
  provider.provideLinks(1, callback);
  expect(validate).toHaveBeenCalledTimes(2);
  expect(callback).toHaveBeenLastCalledWith([]);
  dispose();
});

it.each([
  "\x1b[<35;10;5M", // SGR motion
  "\x1b[<0;10;5M", // SGR press
  "\x1b[<0;10;5m", // SGR release
  "\x1b[M#*%", // legacy report
  "\x1b[35;10;5M", // urxvt report
])("keeps pending relative validation through mouse report %j", async (report) => {
  let resolve!: (paths: string[]) => void;
  const validate = vi.fn(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const { term, events, dispose } = surface(false, undefined, validate);
  const provider = term.registerLinkProvider.mock.calls.at(-1)![0];
  const callback = vi.fn();
  provider.provideLinks(1, callback);
  events.input(report);
  resolve(["docs/image.png"]);
  await settleValidation();
  expect(callback.mock.calls[0][0]).toHaveLength(1);
  provider.provideLinks(1, vi.fn());
  expect(validate).toHaveBeenCalledTimes(1);
  dispose();
});

it.each([
  "cd ../other\r",
  "\r",
  "\x1b[A",
  "\x1b[200~cd ../other\x1b[201~",
])("still invalidates relative paths for keyboard or pasted input %j", (data) => {
  const validate = vi.fn((paths: string[]) => paths);
  const { term, events, dispose } = surface(false, undefined, validate);
  events.input(data);
  term.registerLinkProvider.mock.calls.at(-1)![0].provideLinks(1, vi.fn());
  expect(validate).toHaveBeenCalledTimes(2);
  dispose();
});

it.each([
  false,
  true,
])("handles pending relative paths during output (link row changed=%s)", async (changed) => {
  let resolve!: (paths: string[]) => void;
  const { term, events, lines, dispose } = surface(
    false,
    undefined,
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const provider = term.registerLinkProvider.mock.calls.at(-1)![0];
  const callback = vi.fn();
  provider.provideLinks(1, callback);
  for (let i = 0; i < 5; i++) {
    lines[1] = `Build progress ${i}`;
    events.parsed();
  }
  if (changed) {
    lines[0] = "different/path.png";
    events.parsed();
  }
  await settleValidation();
  expect(callback).not.toHaveBeenCalled();
  resolve(["docs/image.png"]);
  await settleValidation();
  expect(callback.mock.calls[0][0]).toHaveLength(changed ? 0 : 1);
  dispose();
});

it("closes pending path feedback immediately when its row is replaced", async () => {
  let resolve!: (paths: string[]) => void;
  const { term, lines, events, dispose } = positionedSurface(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const screen = term.element.querySelector(".xterm-screen")!;
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 40,
    right: 800,
    bottom: 40,
  } as DOMRect);
  term.element.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10 }));
  term.element.dispatchEvent(new MouseEvent("mousemove", { clientX: 11, clientY: 10 }));
  expect(document.querySelector("[role=status]")).not.toBeNull();
  lines[0] = "replacement output";
  events.parsed();
  expect(document.querySelector("[role=status]")).toBeNull();
  resolve(["docs/image.png"]);
  await settleValidation();
  expect(document.querySelector("[role=menu]")).toBeNull();
  dispose();
});

it("intercepts a stationary click after Escape suppresses a late plain-path hover", async () => {
  let resolve!: (paths: string[]) => void;
  const { term, dispose } = positionedSurface(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const provider = term.registerLinkProvider.mock.calls.at(-1)![0];
  provider.provideLinks(1, (links) => {
    links?.[0]?.hover?.(new MouseEvent("mousemove", { clientX: 10, clientY: 10 }), links[0].text);
  });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  resolve(["docs/image.png"]);
  await settleValidation();
  expect(document.querySelector("[role=menu]")).toBeNull();
  const remoteMouse = vi.fn();
  term.element.addEventListener("mousedown", remoteMouse);
  term.element.addEventListener("mouseup", remoteMouse);
  for (const type of ["mousedown", "mouseup"]) {
    const event = new MouseEvent(type, {
      clientX: 10,
      clientY: 10,
      bubbles: true,
      cancelable: true,
    });
    term.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(remoteMouse).not.toHaveBeenCalled();
  expect(document.querySelector("[role=menu]")?.textContent).toContain("docs/image.png");
  dispose();
});

it.each([
  false,
  true,
])("intercepts OSC clicks after Escape (validation finished=%s)", async (finished) => {
  let resolve!: (paths: string[]) => void;
  const { term, dispose } = positionedSurface(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const uri = "file:///home/coder/image.png";
  term.options.linkHandler?.hover?.(
    new MouseEvent("mousemove", { clientX: 10, clientY: 10 }),
    uri,
    {} as never,
  );
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  if (finished) {
    resolve(["/home/coder/image.png"]);
    await settleValidation();
  }
  expect(document.querySelector("[role=status], [role=menu]")).toBeNull();
  const remote = vi.fn();
  term.element.addEventListener("mousedown", remote);
  term.element.addEventListener("mouseup", remote);
  for (const type of ["mousedown", "mouseup"]) {
    term.element.dispatchEvent(
      new MouseEvent(type, { clientX: 10, clientY: 10, bubbles: true, cancelable: true }),
    );
  }
  if (!finished) {
    resolve(["/home/coder/image.png"]);
    await settleValidation();
  }
  expect(remote).not.toHaveBeenCalled();
  expect(document.querySelector("[role=menu]")?.textContent).toContain("/home/coder/image.png");
  dispose();
});

it("abandons a slow tap when mouse movement resumes", async () => {
  vi.useFakeTimers();
  let resolve!: (paths: string[]) => void;
  const { term, dispose } = positionedSurface(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const screen = term.element.querySelector(".xterm-screen")!;
  screen.addEventListener("mousemove", (event) => {
    if ((event as MouseEvent).clientY === 10)
      term.options.linkHandler?.hover?.(
        event as MouseEvent,
        "file:///home/coder/image.png",
        {} as never,
      );
  });
  term.element.dispatchEvent(touchEvent("touchstart", 10, 10));
  term.element.dispatchEvent(touchEvent("touchend", 10, 10));
  expect(document.querySelector("[role=status]")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(6000);
  screen.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 20, clientY: 30 }));
  expect(document.querySelector("[role=status]")).toBeNull();
  resolve(["/home/coder/image.png"]);
  await settleValidation();
  expect(document.querySelector("[role=menu]")).toBeNull();
  term.options.linkHandler?.hover?.(
    new MouseEvent("mousemove", { clientX: 20, clientY: 30 }),
    "https://example.com",
    {} as never,
  );
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector("[role=menu]")?.textContent).toContain("https://example.com");
  dispose();
});

it.each([
  false,
  true,
])("transfers a pending OSC tap to a stationary mouse press (resolves before release=%s)", async (beforeRelease) => {
  let resolve!: (paths: string[]) => void;
  const { term, dispose } = positionedSurface(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const screen = term.element.querySelector(".xterm-screen")!;
  screen.addEventListener("mousemove", (event) =>
    term.options.linkHandler?.hover?.(
      event as MouseEvent,
      "file:///home/coder/image.png",
      {} as never,
    ),
  );
  term.element.dispatchEvent(touchEvent("touchstart", 10, 10));
  term.element.dispatchEvent(touchEvent("touchend", 10, 10));
  expect(document.querySelector("[role=status]")).not.toBeNull();
  const remote = vi.fn();
  term.element.addEventListener("mousedown", remote);
  term.element.addEventListener("mouseup", remote);
  const init = { clientX: 10, clientY: 10, bubbles: true, cancelable: true };
  // jsdom lacks PointerEvent; add its pointerType to the mouse event.
  const pointer = new MouseEvent("pointerdown", init);
  Object.defineProperty(pointer, "pointerType", { value: "mouse" });
  term.element.dispatchEvent(pointer);
  term.element.dispatchEvent(new MouseEvent("mousedown", init));
  if (beforeRelease) {
    resolve(["/home/coder/image.png"]);
    await settleValidation();
    expect(document.querySelector("[role=menu]")).toBeNull();
  }
  term.element.dispatchEvent(new MouseEvent("mouseup", init));
  if (!beforeRelease) {
    resolve(["/home/coder/image.png"]);
    await settleValidation();
  }
  expect(remote).not.toHaveBeenCalled();
  expect(document.querySelector("[role=menu]")?.textContent).toContain("/home/coder/image.png");
  dispose();
});
