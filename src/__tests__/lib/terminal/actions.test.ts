// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTerminalSelection, pasteToTerminal } from "@/lib/terminal/actions";

function makeMockTerminal(selection = "") {
  return {
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn(),
  };
}

function installClipboard(options: {
  writeText?: ReturnType<typeof vi.fn>;
  readText?: ReturnType<typeof vi.fn>;
}) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: options.writeText,
      readText: options.readText,
    },
  });
}

function removeClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
}

function installExecCommand(result = true) {
  const execCommand = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

function warningText() {
  return vi.mocked(console.warn).mock.calls.flat().map(String).join("\n");
}

describe("copyTerminalSelection", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard({ writeText, readText: vi.fn().mockResolvedValue("") });
    installExecCommand(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true and emits passthrough status when there is no selection", () => {
    const term = makeMockTerminal("");
    const onStatus = vi.fn();

    const result = copyTerminalSelection(term, { onStatus });

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(term.clearSelection).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith({
      action: "copy",
      outcome: "passthrough",
      reason: "no-selection",
    });
  });

  it("copies selected text through the Clipboard API, clears selection, and returns false", async () => {
    const term = makeMockTerminal("selected terminal payload");
    const onStatus = vi.fn();

    const result = copyTerminalSelection(term, { onStatus });

    expect(result).toBe(false);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("selected terminal payload");
    expect(term.clearSelection).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith({
        action: "copy",
        outcome: "copied",
        method: "clipboard-api",
      });
    });
  });

  it("falls back to execCommand with categorical status when writeText rejects", async () => {
    writeText.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    const execCommand = installExecCommand(true);
    const term = makeMockTerminal("selected terminal payload");
    const onStatus = vi.fn();

    const result = copyTerminalSelection(term, { onStatus });

    expect(result).toBe(false);
    await vi.waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(onStatus).toHaveBeenCalledWith({
        action: "copy",
        outcome: "copied",
        method: "exec-command",
        fallbackReason: "clipboard-api-denied",
      });
    });
    expect(warningText()).not.toContain("selected terminal payload");
  });

  it("falls back to execCommand when the Clipboard API is missing", () => {
    removeClipboard();
    const execCommand = installExecCommand(true);
    const term = makeMockTerminal("selected terminal payload");
    const onStatus = vi.fn();

    const result = copyTerminalSelection(term, { onStatus });

    expect(result).toBe(false);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(onStatus).toHaveBeenCalledWith({
      action: "copy",
      outcome: "copied",
      method: "exec-command",
      fallbackReason: "clipboard-api-unavailable",
    });
    expect(warningText()).not.toContain("selected terminal payload");
  });

  it("reports fallback failure without warning selected payloads", async () => {
    writeText.mockRejectedValue(new Error("selected terminal payload"));
    installExecCommand(false);
    const term = makeMockTerminal("selected terminal payload");
    const onStatus = vi.fn();

    copyTerminalSelection(term, { onStatus });

    await vi.waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith({
        action: "copy",
        outcome: "failed",
        reason: "clipboard-api-failed",
        fallbackAttempted: true,
      });
    });
    expect(warningText()).toContain("[clipboard] copy fallback failed");
    expect(warningText()).not.toContain("selected terminal payload");
  });
});

describe("pasteToTerminal", () => {
  let readText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    readText = vi.fn().mockResolvedValue("pasted terminal payload");
    installClipboard({ writeText: vi.fn().mockResolvedValue(undefined), readText });
    installExecCommand(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads clipboard text once, sends it exactly, emits status, and returns false", async () => {
    const send = vi.fn();
    const onStatus = vi.fn();

    const result = pasteToTerminal(null, send, { onStatus });

    expect(result).toBe(false);
    expect(readText).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith("pasted terminal payload");
      expect(onStatus).toHaveBeenCalledWith({
        action: "paste",
        outcome: "pasted",
        method: "clipboard-api",
      });
    });
    expect(warningText()).not.toContain("pasted terminal payload");
  });

  it("does not send empty clipboard text and reports an empty outcome", async () => {
    readText.mockResolvedValue("");
    const send = vi.fn();
    const onStatus = vi.fn();

    const result = pasteToTerminal(null, send, { onStatus });

    expect(result).toBe(false);
    await vi.waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith({
        action: "paste",
        outcome: "empty",
        method: "clipboard-api",
      });
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows native fallback when the Clipboard API is missing", () => {
    removeClipboard();
    const send = vi.fn();
    const onStatus = vi.fn();

    const result = pasteToTerminal(null, send, { onStatus });

    expect(result).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith({
      action: "paste",
      outcome: "fallback",
      reason: "clipboard-api-unavailable",
      method: "native-browser",
    });
  });

  it("reports NotAllowedError categorically and does not send or log clipboard text", async () => {
    readText.mockRejectedValue(new DOMException("pasted terminal payload", "NotAllowedError"));
    const execCommand = installExecCommand(true);
    const send = vi.fn();
    const onStatus = vi.fn();

    const result = pasteToTerminal(null, send, { onStatus });

    expect(result).toBe(false);
    await vi.waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith("paste");
      expect(onStatus).toHaveBeenCalledWith({
        action: "paste",
        outcome: "fallback",
        reason: "clipboard-api-denied",
        method: "exec-command",
        fallbackSucceeded: true,
      });
    });
    expect(send).not.toHaveBeenCalled();
    expect(warningText()).toContain("[clipboard] paste fallback attempted");
    expect(warningText()).not.toContain("pasted terminal payload");
  });

  it("reports generic paste failures categorically without logging error payloads", async () => {
    readText.mockRejectedValue(new Error("pasted terminal payload"));
    installExecCommand(false);
    const send = vi.fn();
    const onStatus = vi.fn();

    const result = pasteToTerminal(null, send, { onStatus });

    expect(result).toBe(false);
    await vi.waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith({
        action: "paste",
        outcome: "fallback",
        reason: "clipboard-api-failed",
        method: "exec-command",
        fallbackSucceeded: false,
      });
    });
    expect(send).not.toHaveBeenCalled();
    expect(warningText()).toContain("[clipboard] paste fallback attempted");
    expect(warningText()).not.toContain("pasted terminal payload");
  });
});
