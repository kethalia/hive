import type { Terminal } from "@xterm/xterm";

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
  | {
      action: "paste";
      outcome: "pasted";
      method: "clipboard-api";
    }
  | {
      action: "paste";
      outcome: "empty";
      method: "clipboard-api";
    }
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
  _term: Terminal | null,
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
        if (!text) {
          emitStatus(options, {
            action: "paste",
            outcome: "empty",
            method: "clipboard-api",
          });
          return;
        }

        send(text);
        emitStatus(options, {
          action: "paste",
          outcome: "pasted",
          method: "clipboard-api",
        });
      })
      .catch((error: unknown) => {
        completePasteFallback(classifyClipboardFailure(error), options);
      });
  } catch (error) {
    completePasteFallback(classifyClipboardFailure(error), options);
  }

  return false;
}
