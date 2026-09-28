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

function surface() {
  const element = document.createElement("div");
  document.body.append(element);
  const osc = new Map<number, (data: string) => unknown>();
  const term = {
    element,
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
  const dispose = installTerminalBrowserIntegration(term as unknown as Terminal);
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
    const { term, osc, dispose } = surface();
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
