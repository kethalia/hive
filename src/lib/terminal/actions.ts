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
    const result = navigator.clipboard.readText();
    result
      .then((text) => {
        if (text) {
          send(text);
        }
      })
      .catch((err) => {
        // We've already swallowed the keypress (returned false below). If the
        // Clipboard API rejected — most often a NotAllowedError because the
        // page lacks permission or the browser is restricting access — fall
        // back to dispatching a synthetic paste so the browser can handle it
        // with its native gesture-based permission flow.
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          console.warn("[clipboard] paste permission denied; falling back to native paste");
        } else {
          console.warn("[clipboard] paste failed:", err);
        }
        try {
          document.execCommand("paste");
        } catch {
          // execCommand may also be blocked; nothing more we can do here.
        }
      });
  } catch {
    return true;
  }

  return false;
}
