// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getMobileTerminalDiagnosticsState,
  recordMobileTerminalFit,
  recordMobileTerminalResizeRequest,
  recordMobileTerminalResizeSent,
  resetMobileTerminalDiagnosticsState,
} from "@/lib/terminal/mobile-terminal-diagnostics-state";
import { sampleMobileViewportDiagnostics } from "@/lib/terminal/mobile-viewport-diagnostics";

function setViewportSize(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function setVisualViewport(overrides: Partial<VisualViewport>) {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      width: 390,
      height: 800,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      ...overrides,
    },
  });
}

function setRect(element: Element, rect: Partial<DOMRect>) {
  element.getBoundingClientRect = () =>
    ({
      x: rect.x ?? rect.left ?? 0,
      y: rect.y ?? rect.top ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
      top: rect.top ?? rect.y ?? 0,
      right: rect.right ?? (rect.x ?? rect.left ?? 0) + (rect.width ?? 0),
      bottom: rect.bottom ?? (rect.y ?? rect.top ?? 0) + (rect.height ?? 0),
      left: rect.left ?? rect.x ?? 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("sampleMobileViewportDiagnostics", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    setViewportSize(390, 800);
    setVisualViewport({ height: 800 });
    resetMobileTerminalDiagnosticsState();
  });

  it("samples keyboard-shrunk viewport and terminal geometry without terminal text", () => {
    setVisualViewport({ height: 500, offsetTop: 0, pageTop: 300 });
    document.documentElement.style.setProperty("--app-visual-viewport-height", "500px");
    document.documentElement.style.setProperty("--app-visual-viewport-offset-top", "0px");

    const shell = document.createElement("section");
    shell.dataset.terminalShell = "true";
    setRect(shell, { x: 0, y: 64, width: 390, height: 500 });

    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    textarea.value = "SECRET_TERMINAL_INPUT";
    textarea.setAttribute("aria-label", "Terminal input");
    setRect(textarea, { x: 8, y: 460, width: 1, height: 1 });

    shell.append(textarea, "SECRET_TERMINAL_BUFFER");
    document.body.append(shell);
    textarea.focus();

    const snapshot = sampleMobileViewportDiagnostics({ now: () => 1234 });

    expect(snapshot.sampledAt).toBe(1234);
    expect(snapshot.viewport.layout).toEqual({ width: 390, height: 800 });
    expect(snapshot.viewport.visual).toMatchObject({ height: 500, offsetTop: 0, pageTop: 300 });
    expect(snapshot.viewport.keyboardInsetBottom).toBe(300);
    expect(snapshot.terminal.shellRect).toMatchObject({ x: 0, y: 64, width: 390, height: 500 });
    expect(snapshot.terminal.helperTextareaRect).toMatchObject({
      x: 8,
      y: 460,
      width: 1,
      height: 1,
    });
    expect(snapshot.activeElement).toMatchObject({
      tagName: "textarea",
      ariaLabel: "Terminal input",
      className: "xterm-helper-textarea",
    });
    expect(snapshot.cssVars["--app-visual-viewport-height"]).toBe("500px");
    expect(JSON.stringify(snapshot)).not.toContain("SECRET_TERMINAL");
  });

  it("separates visual viewport pan from bottom keyboard inset", () => {
    setVisualViewport({ height: 500, offsetTop: 180, pageTop: 420 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 420 });
    Object.defineProperty(window, "pageYOffset", { configurable: true, value: 420 });

    const snapshot = sampleMobileViewportDiagnostics({ now: () => 5678 });

    expect(snapshot.viewport.visual).toMatchObject({
      height: 500,
      offsetTop: 180,
      pageTop: 420,
    });
    expect(snapshot.viewport.keyboardInsetBottom).toBe(120);
    expect(snapshot.document?.scrollY).toBe(420);
  });

  it("falls back safely when visualViewport is missing", () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });

    const snapshot = sampleMobileViewportDiagnostics({ now: () => 9012 });

    expect(snapshot.viewport.layout).toEqual({ width: 390, height: 800 });
    expect(snapshot.viewport.visual).toBeNull();
    expect(snapshot.viewport.keyboardInsetBottom).toBeNull();
  });

  it("returns null terminal geometry when terminal nodes are missing", () => {
    const snapshot = sampleMobileViewportDiagnostics({ now: () => 3456 });

    expect(snapshot.terminal).toMatchObject({
      shellRect: null,
      helperTextareaRect: null,
      xterm: { rows: null, cols: null, updatedAt: null, source: null },
      fit: { count: 0, lastAt: null, lastSource: null, rows: null, cols: null },
      resizeRequest: { count: 0, lastAt: null, lastSource: null, rows: null, cols: null },
      resizeSent: { count: 0, lastAt: null, lastSource: null, rows: null, cols: null },
    });
    expect(snapshot.activeElement).toBeNull();
  });

  it("samples sanitized xterm size and resize-send diagnostics from runtime state", () => {
    recordMobileTerminalFit(24, 80, "initial-layout-refit", () => 100);
    recordMobileTerminalResizeRequest(30, 100, "xterm-on-resize", () => 200);
    recordMobileTerminalResizeSent(30, 100, "xterm-on-resize", () => 300);

    const snapshot = sampleMobileViewportDiagnostics({ now: () => 400 });

    expect(snapshot.terminal.xterm).toEqual({
      rows: 30,
      cols: 100,
      updatedAt: 300,
      source: "xterm-on-resize",
    });
    expect(snapshot.terminal.fit).toEqual({
      count: 1,
      lastAt: 100,
      lastSource: "initial-layout-refit",
      rows: 24,
      cols: 80,
    });
    expect(snapshot.terminal.resizeRequest).toEqual({
      count: 1,
      lastAt: 200,
      lastSource: "xterm-on-resize",
      rows: 30,
      cols: 100,
    });
    expect(snapshot.terminal.resizeSent).toEqual({
      count: 1,
      lastAt: 300,
      lastSource: "xterm-on-resize",
      rows: 30,
      cols: 100,
    });
  });

  it("ignores invalid or non-positive runtime dimensions", () => {
    expect(recordMobileTerminalResizeRequest(0, 80, "invalid", () => 100)).toBe(false);
    expect(recordMobileTerminalResizeSent(24, -1, "invalid", () => 200)).toBe(false);

    expect(getMobileTerminalDiagnosticsState()).toMatchObject({
      xterm: { rows: null, cols: null, updatedAt: null, source: null },
      resizeRequest: { count: 0, lastAt: null, lastSource: null, rows: null, cols: null },
      resizeSent: { count: 0, lastAt: null, lastSource: null, rows: null, cols: null },
    });
  });
});
