import type { Terminal } from "@xterm/xterm";

export function copyTerminalSelection(term: Terminal): boolean {
  const selection = term.getSelection();
  if (!selection) return true;

  try {
    navigator.clipboard.writeText(selection).catch(() => {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = selection;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      } catch {
        console.warn("[clipboard] copy fallback failed");
      }
    });
  } catch {
    console.warn("[clipboard] writeText not available");
  }

  term.clearSelection();
  return false;
}

export function pasteToTerminal(
  term: Terminal,
  send: (data: string) => void,
): boolean {
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
