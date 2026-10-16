// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  handleTerminalPasteOutcome,
  normalizeClipboardItems,
  normalizeClipboardText,
  pasteTextToXterm,
  readClipboardApiOutcome,
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

  it("selects one preferred asset type from each Clipboard API item", async () => {
    const pngBlob = new Blob(["png"], { type: "image/png" });
    const tiffBlob = new Blob(["tiff"], { type: "image/tiff" });
    const getType = vi.fn(async (type: string) => (type === "image/png" ? pngBlob : tiffBlob));
    const clipboard = {
      read: vi.fn().mockResolvedValue([
        {
          types: ["text/html", "image/tiff", "image/png"],
          getType,
        },
      ]),
      readText: vi.fn(),
    };

    const outcome = await readClipboardApiOutcome(clipboard as unknown as Clipboard);

    expect(outcome).toMatchObject({
      kind: "asset-files",
      files: [expect.objectContaining({ name: "clipboard-1.png", type: "image/png" })],
    });
    expect(getType).toHaveBeenCalledOnce();
    expect(getType).toHaveBeenCalledWith("image/png");
    expect(clipboard.readText).not.toHaveBeenCalled();
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

  it("pastes multiline text without submitting", async () => {
    const send = vi.fn();

    await handleTerminalPasteOutcome(
      { kind: "text", text: "one\ntwo", multiline: true },
      { term: null, send },
    );

    expect(send).toHaveBeenCalledExactlyOnceWith("one\ntwo");
  });

  it("pastes a single uploaded file path directly to the terminal", async () => {
    const imageFile = new File(["png"], "pasted.png", { type: "image/png" });
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
        workspaceId: "workspace-1",
        onStatus,
      },
    );

    expect(send).toHaveBeenCalledWith("/tmp/hive-terminal-paste/pasted.png");
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

  it("pastes multiple uploaded file paths without submitting", async () => {
    const imageFile = new File(["png"], "pasted.png", { type: "image/png" });
    const textFile = new File(["txt"], "notes.txt", { type: "text/plain" });
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
        workspaceId: "workspace-1",
        onStatus,
      },
    );

    expect(send).toHaveBeenCalledExactlyOnceWith(
      "/tmp/hive-terminal-paste/pasted.png\n/tmp/hive-terminal-paste/notes.txt",
    );
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

  it("reports image upload failure without throwing", async () => {
    const imageFile = new File(["png"], "pasted.png", { type: "image/png" });
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
        workspaceId: "workspace-1",
        onStatus,
      },
    );

    expect(onStatus).toHaveBeenCalledWith({
      action: "paste",
      outcome: "failed",
      reason: "upload-failed",
      message: "File paste failed: upload failed with payload details",
    });
  });
});

it("pastes a complete multiline prompt once and never sends Enter", async () => {
  const term = { paste: vi.fn() };
  const send = vi.fn();
  const prompt = "First instruction\r\nSecond instruction\nFinal instruction\n";
  await handleTerminalPasteOutcome(normalizeClipboardText(prompt), {
    term: term as never,
    send,
  });
  expect(term.paste).toHaveBeenCalledExactlyOnceWith(prompt);
  expect(send).not.toHaveBeenCalled();
});

it("prevents pasted escape sequences from ending bracketed paste early", () => {
  const term = { paste: vi.fn() };
  pasteTextToXterm(term as never, vi.fn(), "one\x1b[201~\ntwo");
  expect(term.paste).toHaveBeenCalledWith("one[201~\ntwo");
});

it.each(["c", "hello"])("pastes %s literally and clears armed modifiers", async (text) => {
  const { applyMobileModifiers, getMobileModifiers, setMobileModifiers } = await import(
    "@/lib/terminal/mobile-modifiers"
  );
  const send = vi.fn();
  const term = { paste: (data: string) => send(applyMobileModifiers(term, data)) };
  setMobileModifiers(term, { ctrl: true, alt: false, shift: false });
  pasteTextToXterm(term, send, text);
  expect(send).toHaveBeenCalledExactlyOnceWith(text);
  expect(getMobileModifiers(term).ctrl).toBe(false);
});

it("rejects an aggregate paste over 20 MiB before making an upload request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const files = [10 * 1024 * 1024, 10 * 1024 * 1024, 1].map(
    (size) => new File([new Uint8Array(size)], "file.bin"),
  );
  const onStatus = vi.fn();
  const send = vi.fn();
  await handleTerminalPasteOutcome(
    { kind: "asset-files", files },
    { term: null, send, workspaceId: "workspace-1", onStatus },
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(onStatus).toHaveBeenCalledWith({
    action: "paste",
    outcome: "failed",
    reason: "paste-too-large",
    message: "Pasted files must total 20 MiB or less.",
  });
  vi.unstubAllGlobals();
});
