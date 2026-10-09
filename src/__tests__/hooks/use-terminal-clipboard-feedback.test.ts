// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalClipboardFeedback } from "@/hooks/useTerminalClipboardFeedback";
import { copyTerminalSelection, pasteClipboardApiToTerminal } from "@/lib/terminal/actions";

const mockToast = vi.hoisted(() => ({
  loading: vi.fn(() => "pending-toast"),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: mockToast }));

describe("terminal clipboard feedback", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows pending copy immediately and replaces the toast after the clipboard write completes", async () => {
    let finishCopy: (() => void) | undefined;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishCopy = resolve;
            }),
        ),
      },
    });
    const { result } = renderHook(useTerminalClipboardFeedback);
    const term = { getSelection: () => "selected text", clearSelection: vi.fn() };
    act(() => {
      copyTerminalSelection(term, { onStatus: result.current.onStatus });
    });

    expect(result.current.busyAction).toBe("copy");
    expect(mockToast.loading).toHaveBeenCalledWith("Copying selection...", {
      id: undefined,
      position: "top-center",
    });
    expect(mockToast.success).not.toHaveBeenCalled();
    await act(async () => finishCopy?.());
    expect(result.current.busyAction).toBeUndefined();
    expect(result.current.message).toBe("Selection copied");
    expect(mockToast.success).toHaveBeenCalledWith("Selection copied", {
      id: "pending-toast",
      position: "top-center",
    });
  });

  it("updates one progress toast from clipboard reading to file upload to success", async () => {
    let finishRead: ((items: ClipboardItem[]) => void) | undefined;
    let finishUpload: ((response: Response) => void) | undefined;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn(
          () =>
            new Promise<ClipboardItem[]>((resolve) => {
              finishRead = resolve;
            }),
        ),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishUpload = resolve;
          }),
      ),
    );
    const { result } = renderHook(useTerminalClipboardFeedback);
    const send = vi.fn();
    act(() => {
      pasteClipboardApiToTerminal(null, send, {
        workspaceId: "workspace-1",
        onStatus: result.current.onStatus,
      });
    });
    expect(result.current.busyAction).toBe("paste");
    expect(mockToast.loading).toHaveBeenLastCalledWith("Reading clipboard...", {
      id: undefined,
      position: "top-center",
    });

    await act(async () => {
      finishRead?.([
        {
          types: ["image/png"],
          getType: vi.fn().mockResolvedValue(new Blob(["png"], { type: "image/png" })),
        } as unknown as ClipboardItem,
      ]);
    });
    expect(result.current.message).toBe("Uploading files...");
    expect(mockToast.loading).toHaveBeenLastCalledWith("Uploading files...", {
      id: "pending-toast",
      position: "top-center",
    });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      finishUpload?.(new Response(JSON.stringify({ paths: ["/tmp/document.png"] })));
    });
    expect(result.current.busyAction).toBeUndefined();
    expect(send).toHaveBeenCalledExactlyOnceWith("/tmp/document.png");
    expect(mockToast.success).toHaveBeenCalledWith("Paste complete", {
      id: "pending-toast",
      position: "top-center",
    });
  });

  it("replaces pending reading with actionable feedback when the clipboard is empty", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue("") },
    });
    const { result } = renderHook(useTerminalClipboardFeedback);
    const send = vi.fn();
    act(() => {
      pasteClipboardApiToTerminal(null, send, { onStatus: result.current.onStatus });
    });
    await waitFor(() => expect(result.current.busyAction).toBeUndefined());
    expect(mockToast.info).toHaveBeenCalledWith(
      "Clipboard is empty. Use Upload files for PDFs and other documents.",
      { id: "pending-toast", position: "top-center" },
    );
    expect(send).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("reports clipboard permission failure without claiming paste succeeded", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(useTerminalClipboardFeedback);
    act(() => {
      pasteClipboardApiToTerminal(null, vi.fn(), { onStatus: result.current.onStatus });
    });
    await waitFor(() => expect(result.current.busyAction).toBeUndefined());
    expect(mockToast.error).toHaveBeenCalledWith(
      "Clipboard permission was denied. Use the browser paste control or Upload files.",
      { id: "pending-toast", position: "top-center" },
    );
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("dismisses unfinished progress on unmount and ignores late status callbacks", () => {
    const { result, unmount } = renderHook(useTerminalClipboardFeedback);
    const onStatus = result.current.onStatus;
    act(() => onStatus({ action: "paste", outcome: "reading", method: "clipboard-api" }));
    unmount();
    expect(mockToast.dismiss).toHaveBeenCalledExactlyOnceWith("pending-toast");
    onStatus({ action: "paste", outcome: "uploading", method: "clipboard-api" });
    expect(mockToast.loading).toHaveBeenCalledOnce();
  });
});
