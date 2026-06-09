// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  handleTerminalPasteOutcome,
  normalizeClipboardItems,
  normalizeClipboardText,
  pasteTextToXterm,
} from "@/lib/terminal/clipboard";

describe("terminal clipboard normalization", () => {
  it("classifies empty, single-line, and multiline text", () => {
    expect(normalizeClipboardText("")).toEqual({ kind: "empty" });
    expect(normalizeClipboardText("echo ok")).toEqual({
      kind: "text",
      text: "echo ok",
      multiline: false,
    });
    expect(normalizeClipboardText("echo one\necho two")).toEqual({
      kind: "text",
      text: "echo one\necho two",
      multiline: true,
    });
  });

  it("classifies image and unsupported file clipboard items", () => {
    const imageFile = new File(["png"], "pasted.png", { type: "image/png" });
    const textFile = new File(["txt"], "notes.txt", { type: "text/plain" });
    const imageItems = {
      length: 1,
      0: { kind: "file", getAsFile: () => imageFile },
    } as unknown as DataTransferItemList;
    const mixedItems = {
      length: 2,
      0: { kind: "file", getAsFile: () => imageFile },
      1: { kind: "file", getAsFile: () => textFile },
    } as unknown as DataTransferItemList;

    expect(normalizeClipboardItems(imageItems)).toEqual({
      kind: "image-files",
      files: [imageFile],
    });
    expect(normalizeClipboardItems(mixedItems)).toEqual({
      kind: "unsupported-files",
      files: [imageFile, textFile],
    });
  });
});

describe("terminal paste dispatch", () => {
  it("uses xterm paste for single-line text when available", () => {
    const term = { paste: vi.fn() };
    const send = vi.fn();

    pasteTextToXterm(term as never, send, "echo ok");

    expect(term.paste).toHaveBeenCalledWith("echo ok");
    expect(send).not.toHaveBeenCalled();
  });

  it("stages multiline text in compose", async () => {
    const openCompose = vi.fn();
    const send = vi.fn();

    await handleTerminalPasteOutcome(
      { kind: "text", text: "one\ntwo", multiline: true },
      { term: null, send, openCompose, targetLabel: "main" },
    );

    expect(send).not.toHaveBeenCalled();
    expect(openCompose).toHaveBeenCalledWith({
      draft: "one\ntwo",
      append: true,
      targetLabel: "main",
    });
  });
});
