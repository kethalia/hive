// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyTerminalSelection, pasteToTerminal } from "@/lib/terminal/actions";

function makeMockTerminal() {
  return {
    getSelection: vi.fn(),
    hasSelection: vi.fn(),
    clearSelection: vi.fn(),
  } as unknown as import("@xterm/xterm").Terminal;
}

describe("copyTerminalSelection", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(""),
      },
    });
  });

  it("copies selection text and clears selection, returns false", () => {
    const term = makeMockTerminal();
    (term.getSelection as ReturnType<typeof vi.fn>).mockReturnValue(
      "hello world",
    );

    const result = copyTerminalSelection(term);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello world");
    expect(term.clearSelection).toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("returns true (SIGINT passthrough) when no selection", () => {
    const term = makeMockTerminal();
    (term.getSelection as ReturnType<typeof vi.fn>).mockReturnValue("");

    const result = copyTerminalSelection(term);

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe("pasteToTerminal", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue("pasted text"),
      },
    });
  });

  it("reads clipboard and calls send with text, returns false", async () => {
    const term = makeMockTerminal();
    const send = vi.fn();

    const result = pasteToTerminal(term, send);
    expect(result).toBe(false);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith("pasted text");
    });
  });

  it("does not call send when clipboard is empty", async () => {
    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const term = makeMockTerminal();
    const send = vi.fn();

    pasteToTerminal(term, send);

    await new Promise((r) => setTimeout(r, 10));
    expect(send).not.toHaveBeenCalled();
  });

  it("handles NotAllowedError without crashing", async () => {
    const err = new DOMException("Permission denied", "NotAllowedError");
    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const term = makeMockTerminal();
    const send = vi.fn();

    pasteToTerminal(term, send);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith("[clipboard] paste permission denied");
    });

    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
