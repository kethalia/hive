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

  it("classifies image and generic file clipboard items", () => {
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
      kind: "asset-files",
      files: [imageFile],
    });
    expect(normalizeClipboardItems(mixedItems)).toEqual({
      kind: "asset-files",
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

  it("pastes a single uploaded file path directly to the terminal", async () => {
    const imageFile = new File(["png"], "pasted.png", { type: "image/png" });
    const openCompose = vi.fn();
    const onStatus = vi.fn();
    const send = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          paths: ["/tmp/hive-terminal-paste/pasted.png"],
        }),
      }),
    );

    await handleTerminalPasteOutcome(
      { kind: "asset-files", files: [imageFile] },
      {
        term: null,
        send,
        openCompose,
        workspaceId: "workspace-1",
        onStatus,
      },
    );

    expect(send).toHaveBeenCalledWith("/tmp/hive-terminal-paste/pasted.png");
    expect(openCompose).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("Paste complete.");
  });

  it("stages multiple uploaded file paths in compose", async () => {
    const imageFile = new File(["png"], "pasted.png", { type: "image/png" });
    const textFile = new File(["txt"], "notes.txt", { type: "text/plain" });
    const openCompose = vi.fn();
    const onStatus = vi.fn();
    const send = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          paths: ["/tmp/hive-terminal-paste/pasted.png", "/tmp/hive-terminal-paste/notes.txt"],
        }),
      }),
    );

    await handleTerminalPasteOutcome(
      { kind: "asset-files", files: [imageFile, textFile] },
      {
        term: null,
        send,
        openCompose,
        workspaceId: "workspace-1",
        targetLabel: "main",
        onStatus,
      },
    );

    expect(send).not.toHaveBeenCalled();
    expect(openCompose).toHaveBeenCalledWith({
      draft: "/tmp/hive-terminal-paste/pasted.png\n/tmp/hive-terminal-paste/notes.txt",
      append: true,
      targetLabel: "main",
    });
    expect(onStatus).toHaveBeenCalledWith("Pasted file paths added to compose.");
  });

  it("reports image upload failure without throwing", async () => {
    const imageFile = new File(["png"], "pasted.png", { type: "image/png" });
    const openCompose = vi.fn();
    const onStatus = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: "upload failed with payload details" }),
      }),
    );

    await handleTerminalPasteOutcome(
      { kind: "asset-files", files: [imageFile] },
      {
        term: null,
        send: vi.fn(),
        openCompose,
        workspaceId: "workspace-1",
        onStatus,
      },
    );

    expect(openCompose).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("File paste failed.");
  });
});
