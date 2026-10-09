import type { ClipboardActionStatus } from "./actions";

export interface ClipboardFeedback {
  message: string;
  tone: "loading" | "success" | "error" | "info";
}

export function clipboardFeedback(status: ClipboardActionStatus): ClipboardFeedback {
  if (status.action === "copy") {
    switch (status.outcome) {
      case "copying":
        return { message: "Copying selection...", tone: "loading" };
      case "copied":
        return { message: "Selection copied", tone: "success" };
      case "passthrough":
        return { message: "Select terminal text to copy", tone: "info" };
      case "failed":
        return {
          message:
            status.reason === "clipboard-api-denied"
              ? "Clipboard permission was denied. Long-press terminal text to select and copy."
              : "Could not copy to the clipboard. Long-press terminal text to select and copy.",
          tone: "error",
        };
    }
  }

  switch (status.outcome) {
    case "reading":
      return { message: "Reading clipboard...", tone: "loading" };
    case "uploading":
      return { message: "Uploading files...", tone: "loading" };
    case "pasted":
      return { message: "Paste complete", tone: "success" };
    case "empty":
      return {
        message: "Clipboard is empty. Use Upload files for PDFs and other documents.",
        tone: "info",
      };
    case "failed":
      return { message: status.message, tone: "error" };
    case "fallback":
      return {
        message:
          status.reason === "clipboard-api-denied"
            ? "Clipboard permission was denied. Use the browser paste control or Upload files."
            : "Use the browser paste control or Upload files to paste this content.",
        tone: status.method === "exec-command" && !status.fallbackSucceeded ? "error" : "info",
      };
  }
}
