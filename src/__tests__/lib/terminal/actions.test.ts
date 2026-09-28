// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyTerminalSelection,
  pasteClipboardApiToTerminal,
  pasteNativeClipboardEventToTerminal,
  pasteToTerminal,
} from "@/lib/terminal/actions";

function makeMockTerminal(selection = "") {
  return {
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn(),
  };
}

function installClipboard(options: {
  writeText?: ReturnType<typeof vi.fn>;
  readText?: ReturnType<typeof vi.fn>;
  read?: ReturnType<typeof vi.fn>;
}) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: options.writeText,
      readText: options.readText,
      read: options.read,
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
    await vi.waitFor(() => {
      expect(term.clearSelection).toHaveBeenCalledOnce();
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

  it("reads clipboard text once, uses xterm paste, emits status, and returns false", async () => {
    const send = vi.fn();
    const onStatus = vi.fn();
    const term = { paste: vi.fn() };

    const result = pasteToTerminal(term as never, send, { onStatus });

    expect(result).toBe(false);
    expect(readText).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(term.paste).toHaveBeenCalledWith("pasted terminal payload");
      expect(send).not.toHaveBeenCalled();
      expect(onStatus).toHaveBeenCalledWith({
        action: "paste",
        outcome: "pasted",
        method: "clipboard-api",
      });
    });
    expect(warningText()).not.toContain("pasted terminal payload");
  });

  it("pastes multiline clipboard text directly even with a compose target", async () => {
    readText.mockResolvedValue("echo one\necho two");
    const send = vi.fn();
    const onCompose = vi.fn();
    const onStatus = vi.fn();

    const result = pasteToTerminal(null, send, {
      onCompose,
      onStatus,
      targetLabel: "main",
    });

    expect(result).toBe(false);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledExactlyOnceWith("echo one\necho two");
      expect(onCompose).not.toHaveBeenCalled();
      expect(onStatus).toHaveBeenCalledWith({
        action: "paste",
        outcome: "pasted",
        method: "clipboard-api",
      });
    });
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

describe("pasteClipboardApiToTerminal", () => {
  beforeEach(() => {
    installExecCommand(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uploads image clipboard items and pastes a single returned workspace path directly", async () => {
    const pngBlob = new Blob(["png"], { type: "image/png" });
    const read = vi.fn().mockResolvedValue([
      {
        types: ["image/png"],
        getType: vi.fn().mockResolvedValue(pngBlob),
      },
    ]);
    installClipboard({ read, readText: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ paths: ["/tmp/hive-terminal-paste/image.png"] }),
      }),
    );
    const onCompose = vi.fn();
    const onStatus = vi.fn();
    const send = vi.fn();

    const result = pasteClipboardApiToTerminal(null, send, {
      onCompose,
      onStatus,
      workspaceId: "workspace-1",
      targetLabel: "main",
    });

    expect(result).toBe(false);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace-1/terminal/paste-assets",
        expect.objectContaining({
          method: "POST",
          body: expect.any(FormData),
        }),
      );
      expect(send).toHaveBeenCalledWith("/tmp/hive-terminal-paste/image.png");
      expect(onStatus).toHaveBeenCalledWith({
        action: "paste",
        outcome: "uploading",
        method: "clipboard-api",
      });
      expect(onStatus).toHaveBeenCalledWith({
        action: "paste",
        outcome: "pasted",
        method: "clipboard-api",
      });
    });
    expect(onCompose).not.toHaveBeenCalled();
  });

  it("falls back to native handling when the Clipboard API cannot read", () => {
    removeClipboard();
    const send = vi.fn();
    const onStatus = vi.fn();

    const result = pasteClipboardApiToTerminal(null, send, { onStatus });

    expect(result).toBe(true);
    expect(onStatus).toHaveBeenCalledWith({
      action: "paste",
      outcome: "fallback",
      reason: "clipboard-api-unavailable",
      method: "native-browser",
    });
  });

  it("skips exec-command fallback when a captured native paste handled the failure", async () => {
    const execCommand = installExecCommand(true);
    installClipboard({
      read: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      readText: vi.fn(),
    });
    const onPasteFailure = vi.fn(() => true);
    const onStatus = vi.fn();

    const result = pasteClipboardApiToTerminal(null, vi.fn(), {
      onPasteFailure,
      onStatus,
    });

    expect(result).toBe(false);
    await vi.waitFor(() => expect(onPasteFailure).toHaveBeenCalledOnce());
    expect(execCommand).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "paste", outcome: "fallback" }),
    );
  });

  it("runs exec-command paste inside the request fallback wrapper", async () => {
    const execCommand = installExecCommand(true);
    installClipboard({
      read: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      readText: vi.fn(),
    });
    const runPasteFallback = vi.fn((fallback: () => boolean) => fallback());

    pasteClipboardApiToTerminal(null, vi.fn(), {
      onPasteFailure: () => false,
      runPasteFallback,
    });

    await vi.waitFor(() => expect(runPasteFallback).toHaveBeenCalledOnce());
    expect(execCommand).toHaveBeenCalledWith("paste");
  });

  it("skips default outcome dispatch when the request callback takes ownership", async () => {
    installClipboard({
      readText: vi.fn().mockResolvedValue("API text"),
    });
    const onPasteOutcome = vi.fn(() => true);
    const send = vi.fn();

    pasteClipboardApiToTerminal(null, send, { onPasteOutcome });

    await vi.waitFor(() => expect(onPasteOutcome).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();
  });
});

describe("pasteNativeClipboardEventToTerminal", () => {
  it("suppresses native paste propagation and dispatches text once through xterm", async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: null,
        getData: vi.fn(() => "printf ok"),
      },
    });
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");
    const term = { paste: vi.fn() };
    const send = vi.fn();
    const onCompose = vi.fn();

    await pasteNativeClipboardEventToTerminal(event, {
      term: term as never,
      send,
      onCompose,
      workspaceId: "ws-1",
      targetLabel: "main",
    });

    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(term.paste).toHaveBeenCalledOnce();
    expect(term.paste).toHaveBeenCalledWith("printf ok");
    expect(send).not.toHaveBeenCalled();
    expect(onCompose).not.toHaveBeenCalled();
  });
});

it("copies native mobile selection only from the selected terminal", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  installClipboard({ writeText });
  const { getTerminalSelectionText } = await import("@/lib/terminal/actions");
  const element = document.createElement("div");
  element.textContent = "native mobile selection";
  document.body.append(element);
  const range = document.createRange();
  range.selectNodeContents(element);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  const term = { element, getSelection: vi.fn(() => ""), clearSelection: vi.fn() };
  expect(getTerminalSelectionText(term)).toBe("native mobile selection");
  expect(getTerminalSelectionText({ ...term, element: document.createElement("div") })).toBe("");
  copyTerminalSelection(term);
  expect(writeText).toHaveBeenCalledWith("native mobile selection");
  element.remove();
  window.getSelection()?.removeAllRanges();
});

it("keeps terminal selection when both clipboard write methods fail", async () => {
  installClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
  installExecCommand(false);
  const term = makeMockTerminal("keep this selection");
  const onStatus = vi.fn();
  copyTerminalSelection(term, { onStatus });
  await vi.waitFor(() =>
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" })),
  );
  expect(term.clearSelection).not.toHaveBeenCalled();
});

describe("native selection copy completion", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  function selectedTerminal() {
    const element = document.createElement("div");
    element.textContent = "selected text";
    document.body.append(element);
    const select = (target: HTMLElement = element) => {
      const range = document.createRange();
      range.selectNodeContents(target);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    };
    select();
    return { element, select, getSelection: vi.fn(() => ""), clearSelection: vi.fn() };
  }

  it.each([
    "api",
    "fallback",
    "missing-api",
  ])("clears native selection on %s copy success", async (mode) => {
    installClipboard({
      writeText:
        mode === "missing-api"
          ? undefined
          : mode === "api"
            ? vi.fn().mockResolvedValue(undefined)
            : vi.fn().mockRejectedValue(new Error("denied")),
    });
    installExecCommand(true);
    const term = selectedTerminal();
    const onStatus = vi.fn();
    copyTerminalSelection(term, { onStatus });
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ outcome: "copied" })),
    );
    expect(window.getSelection()?.rangeCount).toBe(0);
  });

  it.each([
    true,
    false,
  ])("preserves backward selection direction during fallback (success: %s)", async (success) => {
    installClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    installExecCommand(success);
    const term = selectedTerminal();
    const text = term.element.firstChild!;
    window.getSelection()?.setBaseAndExtent(text, text.textContent!.length, text, 0);
    const onStatus = vi.fn();
    copyTerminalSelection(term, { onStatus });
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: success ? "copied" : "failed" }),
      ),
    );
    if (success) {
      expect(window.getSelection()?.rangeCount).toBe(0);
    } else {
      expect(window.getSelection()?.toString()).toBe("selected text");
      expect(window.getSelection()?.anchorOffset).toBe(text.textContent!.length);
      expect(window.getSelection()?.focusOffset).toBe(0);
    }
  });

  it("preserves native selection when API and fallback both fail", async () => {
    installClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    installExecCommand(false);
    const term = selectedTerminal();
    const onStatus = vi.fn();
    copyTerminalSelection(term, { onStatus });
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" })),
    );
    expect(window.getSelection()?.toString()).toBe("selected text");
  });

  it.each([
    false,
    true,
  ])("preserves a newer range while copy is pending (fallback: %s)", async (fallback) => {
    let finish: (() => void) | undefined;
    const write = new Promise<void>((resolve, reject) => {
      finish = () => (fallback ? reject(new Error("denied")) : resolve());
    });
    installClipboard({ writeText: vi.fn(() => write) });
    installExecCommand(true);
    const term = selectedTerminal();
    const onStatus = vi.fn();
    copyTerminalSelection(term, { onStatus });
    const replacement = document.createElement("span");
    replacement.textContent = "selected text";
    term.element.append(replacement);
    term.select(replacement);
    finish?.();
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ outcome: "copied" })),
    );
    expect(window.getSelection()?.anchorNode).toBe(replacement);
    expect(window.getSelection()?.toString()).toBe("selected text");
  });
});
