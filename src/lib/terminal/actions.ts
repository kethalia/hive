import type { Terminal } from "@xterm/xterm";

function execCommandCopyFallback(text: string): void {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  } catch {
    console.warn("[clipboard] copy fallback failed");
  }
}

export function copyTerminalSelection(term: Terminal): boolean {
  const selection = term.getSelection();
  if (!selection) return true;

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(selection).catch(() => {
      execCommandCopyFallback(selection);
    });
  } else {
    execCommandCopyFallback(selection);
  }

  term.clearSelection();
  return false;
}

export function pasteToTerminal(
  term: Terminal,
  send: (data: string) => void,
): boolean {
  if (!navigator.clipboard?.readText) {
    console.warn("[clipboard] readText not available");
    return false;
  }

  navigator.clipboard
    .readText()
    .then((text) => {
      if (text) {
        send(text);
      }
    })
    .catch((err) => {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        console.warn("[clipboard] paste permission denied");
      } else {
        console.warn("[clipboard] paste failed:", err);
      }
    });

  return false;
}
