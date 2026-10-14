// @vitest-environment jsdom
import { Blob } from "node:buffer";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSelectionClipboard } from "@/lib/terminal/selection-clipboard";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Blob", Blob);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(deferred = false) {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const write = vi.fn().mockImplementation(async (items) => {
    await items[0].data["text/plain"];
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, ...(deferred ? { write } : {}) },
  });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(public data: object) {}
    },
  );
  return { clipboard: createSelectionClipboard(), writeText, write };
}

it("requires Copy for unsolicited output even when clipboard permission is granted", () => {
  const { clipboard, writeText } = setup();
  clipboard.provider.writeText("c" as never, "remote command");
  expect(writeText).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledOnce();
  const options = vi.mocked(toast).mock.calls[0][1]!;
  if (options.action && typeof options.action === "object" && "onClick" in options.action)
    options.action.onClick({} as never);
  expect(writeText).toHaveBeenCalledExactlyOnceWith("remote command");
  clipboard.dispose();
});

it.each([false, true])("copies one response following release (deferred=%s)", async (deferred) => {
  const { clipboard, writeText, write } = setup(deferred);
  clipboard.begin();
  clipboard.provider.writeText("c" as never, "while holding");
  expect(writeText).not.toHaveBeenCalled();
  clipboard.release();
  expect(write).toHaveBeenCalledTimes(deferred ? 1 : 0);
  clipboard.provider.writeText("c" as never, "selected\ntext");
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledTimes(deferred ? 0 : 1);
  if (!deferred) expect(writeText).toHaveBeenCalledWith("selected\ntext");
  else
    expect(await (await write.mock.calls[0][0][0].data["text/plain"]).text()).toBe(
      "selected\ntext",
    );
  clipboard.provider.writeText("c" as never, "extra response");
  expect(toast).toHaveBeenCalledWith("Terminal text is ready to copy", expect.anything());
  expect(write).toHaveBeenCalledTimes(deferred ? 1 : 0);
  clipboard.dispose();
});

it.each([
  "cancel",
  "timeout",
  "dispose",
])("does not copy an abandoned selection (%s)", async (reason) => {
  const { clipboard, writeText, write } = setup(true);
  clipboard.begin();
  clipboard.release();
  if (reason === "timeout") await vi.advanceTimersByTimeAsync(3000);
  else clipboard[reason as "cancel" | "dispose"]();
  clipboard.provider.writeText("c" as never, "late text");
  await vi.runAllTimersAsync();
  expect(writeText).not.toHaveBeenCalled();
  await expect(write.mock.results[0].value).rejects.toThrow("cancelled");
  clipboard.dispose();
});

it("keeps selection responses isolated between panes", async () => {
  const { clipboard: first, writeText } = setup();
  const second = createSelectionClipboard();
  first.begin();
  first.release();
  second.provider.writeText("c" as never, "other pane");
  expect(writeText).not.toHaveBeenCalled();
  first.provider.writeText("c" as never, "first pane");
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledExactlyOnceWith("first pane");
  first.dispose();
  second.dispose();
});

it("offers a fresh Copy gesture when the reserved browser write is denied", async () => {
  const { clipboard, write, writeText } = setup(true);
  write.mockRejectedValue(new Error("denied"));
  clipboard.begin();
  clipboard.release();
  clipboard.provider.writeText("c" as never, "selection");
  await vi.runAllTimersAsync();
  expect(writeText).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    "Terminal text is ready to copy",
    expect.objectContaining({ action: expect.objectContaining({ label: "Copy" }) }),
  );
  clipboard.dispose();
});

it("rejects oversized/empty responses and never reads the OS clipboard", () => {
  const { clipboard, writeText } = setup();
  clipboard.provider.writeText("c" as never, "");
  clipboard.provider.writeText("c" as never, "x".repeat(1024 * 1024 + 1));
  expect(toast).not.toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
  expect(clipboard.provider.readText("c" as never)).toBe("");
  clipboard.dispose();
});
