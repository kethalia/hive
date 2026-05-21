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
    try {
      const result = navigator.clipboard.writeText(selection);
      if (result && typeof result.catch === "function") {
        result.catch(() => execCommandCopyFallback(selection));
      }
    } catch {
      execCommandCopyFallback(selection);
    }
  } else {
    execCommandCopyFallback(selection);
  }

  term.clearSelection();
  return false;
}

export function pasteToTerminal(_term: Terminal, send: (data: string) => void): boolean {
  if (!navigator.clipboard?.readText) {
    console.warn("[clipboard] readText not available; allowing native paste");
    return true;
  }

  try {
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
  } catch {
    return true;
  }

  return false;
}
