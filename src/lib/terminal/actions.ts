import type { Terminal } from "@xterm/xterm";
import {
  handleTerminalPasteOutcome,
  normalizeClipboardText,
  readClipboardApiOutcome,
  type TerminalComposeRequest,
  type TerminalPasteController,
  type TerminalPasteOutcome,
  type TerminalPasteStatus,
} from "@/lib/terminal/clipboard";

export type ClipboardFallbackReason =
  | "clipboard-api-unavailable"
  | "clipboard-api-denied"
  | "clipboard-api-failed";

export type ClipboardActionStatus =
  | {
      action: "copy";
      outcome: "passthrough";
      reason: "no-selection";
    }
  | {
      action: "copy";
      outcome: "copied";
      method: "clipboard-api" | "exec-command";
      fallbackReason?: ClipboardFallbackReason;
    }
  | {
      action: "copy";
      outcome: "failed";
      reason: ClipboardFallbackReason;
      fallbackAttempted: true;
    }
  | TerminalPasteStatus
  | {
      action: "paste";
      outcome: "fallback";
      reason: "clipboard-api-unavailable";
      method: "native-browser";
    }
  | {
      action: "paste";
      outcome: "fallback";
      reason: Exclude<ClipboardFallbackReason, "clipboard-api-unavailable">;
      method: "exec-command";
      fallbackSucceeded: boolean;
    };

export type ClipboardStatusCallback = (status: ClipboardActionStatus) => void;

export interface ClipboardActionOptions {
  onStatus?: ClipboardStatusCallback;
  onCompose?: (request: TerminalComposeRequest) => void;
  onPasteOutcome?: (outcome: TerminalPasteOutcome) => void;
  onPasteFailure?: () => void;
  targetLabel?: string;
  workspaceId?: string;
}

type TerminalSelection = Pick<Terminal, "getSelection" | "clearSelection">;

function emitStatus(
  options: ClipboardActionOptions | undefined,
  status: ClipboardActionStatus,
): void {
  try {
    options?.onStatus?.(status);
  } catch {
    console.warn("[clipboard] status callback failed");
  }
}

function notifyPasteOutcome(
  options: ClipboardActionOptions | undefined,
  outcome: TerminalPasteOutcome,
): void {
  try {
    options?.onPasteOutcome?.(outcome);
  } catch {
    console.warn("[clipboard] paste outcome callback failed");
  }
}

function notifyPasteFailure(options: ClipboardActionOptions | undefined): void {
  try {
    options?.onPasteFailure?.();
  } catch {
    console.warn("[clipboard] paste failure callback failed");
  }
}

function getClipboard(): Clipboard | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.clipboard;
}

function classifyClipboardFailure(
  error: unknown,
): Exclude<ClipboardFallbackReason, "clipboard-api-unavailable"> {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = Reflect.get(error, "name");
    if (name === "NotAllowedError") return "clipboard-api-denied";
  }

  return "clipboard-api-failed";
}

function tryExecCommand(command: "copy" | "paste"): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;

  try {
    return document.execCommand(command);
  } catch {
    return false;
  }
}

function execCommandCopyFallback(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";

  try {
    document.body.appendChild(textarea);
    textarea.select();
    return tryExecCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function completeCopyFallback(
  text: string,
  reason: ClipboardFallbackReason,
  options: ClipboardActionOptions | undefined,
): void {
  const fallbackSucceeded = execCommandCopyFallback(text);

  if (fallbackSucceeded) {
    emitStatus(options, {
      action: "copy",
      outcome: "copied",
      method: "exec-command",
      fallbackReason: reason,
    });
    return;
  }

  emitStatus(options, {
    action: "copy",
    outcome: "failed",
    reason,
    fallbackAttempted: true,
  });
  console.warn("[clipboard] copy fallback failed");
}

function completePasteFallback(
  reason: Exclude<ClipboardFallbackReason, "clipboard-api-unavailable">,
  options: ClipboardActionOptions | undefined,
): void {
  const fallbackSucceeded = tryExecCommand("paste");
  emitStatus(options, {
    action: "paste",
    outcome: "fallback",
    reason,
    method: "exec-command",
    fallbackSucceeded,
  });
  console.warn("[clipboard] paste fallback attempted");
}

function createTerminalPasteController(
  term: Terminal | null,
  send: (data: string) => void,
  options: ClipboardActionOptions | undefined,
): TerminalPasteController {
  return {
    term,
    send,
    openCompose: (request) => options?.onCompose?.(request),
    workspaceId: options?.workspaceId,
    targetLabel: options?.targetLabel,
    onStatus: (status) => emitStatus(options, status),
  };
}

export function copyTerminalSelection(
  term: TerminalSelection,
  options?: ClipboardActionOptions,
): boolean {
  const selection = term.getSelection();
  if (!selection) {
    emitStatus(options, {
      action: "copy",
      outcome: "passthrough",
      reason: "no-selection",
    });
    return true;
  }

  const clipboard = getClipboard();
  if (typeof clipboard?.writeText !== "function") {
    completeCopyFallback(selection, "clipboard-api-unavailable", options);
    term.clearSelection();
    return false;
  }

  try {
    const writeResult = clipboard.writeText(selection);
    void writeResult
      .then(() => {
        emitStatus(options, {
          action: "copy",
          outcome: "copied",
          method: "clipboard-api",
        });
      })
      .catch((error: unknown) => {
        completeCopyFallback(selection, classifyClipboardFailure(error), options);
      });
  } catch (error) {
    completeCopyFallback(selection, classifyClipboardFailure(error), options);
  }

  term.clearSelection();
  return false;
}

export function pasteToTerminal(
  term: Terminal | null,
  send: (data: string) => void,
  options?: ClipboardActionOptions,
): boolean {
  const clipboard = getClipboard();
  if (typeof clipboard?.readText !== "function") {
    emitStatus(options, {
      action: "paste",
      outcome: "fallback",
      reason: "clipboard-api-unavailable",
      method: "native-browser",
    });
    return true;
  }

  try {
    const readResult = clipboard.readText();
    void readResult
      .then((text) => {
        void handleTerminalPasteOutcome(
          normalizeClipboardText(text),
          createTerminalPasteController(term, send, options),
        );
      })
      .catch((error: unknown) => {
        completePasteFallback(classifyClipboardFailure(error), options);
      });
  } catch (error) {
    completePasteFallback(classifyClipboardFailure(error), options);
  }

  return false;
}

export function pasteClipboardApiToTerminal(
  term: Terminal | null,
  send: (data: string) => void,
  options?: ClipboardActionOptions,
): boolean {
  const clipboard = getClipboard();
  if (
    !clipboard ||
    (typeof clipboard.read !== "function" && typeof clipboard.readText !== "function")
  ) {
    emitStatus(options, {
      action: "paste",
      outcome: "fallback",
      reason: "clipboard-api-unavailable",
      method: "native-browser",
    });
    return true;
  }

  void readClipboardApiOutcome(clipboard)
    .then((outcome) => {
      notifyPasteOutcome(options, outcome);
      return handleTerminalPasteOutcome(
        outcome,
        createTerminalPasteController(term, send, options),
      );
    })
    .catch((error: unknown) => {
      notifyPasteFailure(options);
      completePasteFallback(classifyClipboardFailure(error), options);
    });

  return false;
}

export async function pasteNativeClipboardEventToTerminal(
  event: ClipboardEvent,
  controller: {
    term: Terminal | null;
    send: (data: string) => void;
    onCompose: (request: TerminalComposeRequest) => void;
    workspaceId?: string;
    targetLabel?: string;
    onStatus?: (status: TerminalPasteStatus) => void;
  },
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const { readNativePasteOutcome } = await import("@/lib/terminal/clipboard");
  const outcome = readNativePasteOutcome(event);
  await handleTerminalPasteOutcome(outcome, {
    term: controller.term,
    send: controller.send,
    openCompose: controller.onCompose,
    workspaceId: controller.workspaceId,
    targetLabel: controller.targetLabel,
    onStatus: controller.onStatus,
  });
}

export async function dropDataTransferToTerminal(
  event: DragEvent,
  controller: {
    term: Terminal | null;
    send: (data: string) => void;
    onCompose: (request: TerminalComposeRequest) => void;
    workspaceId?: string;
    targetLabel?: string;
    onStatus?: (status: TerminalPasteStatus) => void;
  },
): Promise<void> {
  const { readDataTransferOutcome } = await import("@/lib/terminal/clipboard");
  const outcome = readDataTransferOutcome(event.dataTransfer);
  if (outcome.kind !== "empty") {
    event.preventDefault();
  }
  await handleTerminalPasteOutcome(outcome, {
    term: controller.term,
    send: controller.send,
    openCompose: controller.onCompose,
    workspaceId: controller.workspaceId,
    targetLabel: controller.targetLabel,
    onStatus: controller.onStatus,
  });
}
