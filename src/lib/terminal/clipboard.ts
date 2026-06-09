import type { Terminal } from "@xterm/xterm";

export const TERMINAL_PASTE_ASSET_MAX_FILES = 4;
export const TERMINAL_PASTE_ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const TERMINAL_PASTE_ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export type TerminalPasteSource = "clipboard-api" | "native-paste" | "toolbar" | "context-menu";

export type TerminalPasteOutcome =
  | { kind: "empty" }
  | { kind: "text"; text: string; multiline: boolean }
  | { kind: "image-files"; files: File[] }
  | { kind: "unsupported-files"; files: File[] };

export interface TerminalComposeRequest {
  draft: string;
  append?: boolean;
  targetLabel?: string;
}

export interface TerminalPasteController {
  term: Terminal | null;
  send: (data: string) => void;
  openCompose: (request: TerminalComposeRequest) => void;
  workspaceId?: string;
  targetLabel?: string;
  onStatus?: (message: string) => void;
}

export function isMultilinePaste(text: string): boolean {
  return /\r|\n/.test(text);
}

export function normalizeClipboardText(text: string): TerminalPasteOutcome {
  if (!text) return { kind: "empty" };
  return { kind: "text", text, multiline: isMultilinePaste(text) };
}

export function normalizeClipboardItems(items: DataTransferItemList | null): TerminalPasteOutcome {
  if (!items || items.length === 0) return { kind: "empty" };

  const files = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  if (files.length === 0) return { kind: "empty" };
  const imageFiles = files.filter((file) => TERMINAL_PASTE_ASSET_MIME_TYPES.includes(file.type));
  return imageFiles.length === files.length
    ? { kind: "image-files", files: imageFiles }
    : { kind: "unsupported-files", files };
}

export function pasteTextToXterm(
  term: Pick<Terminal, "paste"> | null,
  send: (data: string) => void,
  text: string,
): void {
  if (term && typeof term.paste === "function") {
    term.paste(text);
    return;
  }
  send(text);
}

export async function uploadTerminalPasteImages(
  workspaceId: string,
  files: readonly File[],
): Promise<string[]> {
  const body = new FormData();
  for (const file of files) {
    body.append("files", file);
  }

  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/paste-assets`,
    {
      method: "POST",
      body,
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    paths?: string[];
    error?: string;
  } | null;
  if (!response.ok || !payload?.paths) {
    throw new Error(payload?.error ?? "Failed to upload pasted image");
  }
  return payload.paths;
}

export async function handleTerminalPasteOutcome(
  outcome: TerminalPasteOutcome,
  controller: TerminalPasteController,
): Promise<void> {
  if (outcome.kind === "empty") {
    controller.onStatus?.("Clipboard is empty.");
    return;
  }

  if (outcome.kind === "unsupported-files") {
    controller.onStatus?.("Only png, jpeg, webp, and gif images can be pasted.");
    return;
  }

  if (outcome.kind === "image-files") {
    if (!controller.workspaceId) {
      controller.onStatus?.("Image paste requires a workspace target.");
      return;
    }
    if (outcome.files.length > TERMINAL_PASTE_ASSET_MAX_FILES) {
      controller.onStatus?.(`Paste up to ${TERMINAL_PASTE_ASSET_MAX_FILES} images at once.`);
      return;
    }
    if (outcome.files.some((file) => file.size > TERMINAL_PASTE_ASSET_MAX_BYTES)) {
      controller.onStatus?.("Each pasted image must be 5 MiB or smaller.");
      return;
    }

    const paths = await uploadTerminalPasteImages(controller.workspaceId, outcome.files);
    controller.openCompose({
      draft: paths.join("\n"),
      append: true,
      targetLabel: controller.targetLabel,
    });
    controller.onStatus?.("Pasted image path added to compose.");
    return;
  }

  if (outcome.multiline) {
    controller.openCompose({
      draft: outcome.text,
      append: true,
      targetLabel: controller.targetLabel,
    });
    controller.onStatus?.("Multiline paste staged in compose.");
    return;
  }

  pasteTextToXterm(controller.term, controller.send, outcome.text);
  controller.onStatus?.("Paste complete.");
}

export function readNativePasteOutcome(event: ClipboardEvent): TerminalPasteOutcome {
  const fileOutcome = normalizeClipboardItems(event.clipboardData?.items ?? null);
  if (fileOutcome.kind === "image-files" || fileOutcome.kind === "unsupported-files") {
    return fileOutcome;
  }

  const text = event.clipboardData?.getData("text/plain") ?? "";
  return normalizeClipboardText(text);
}

export function readDataTransferOutcome(dataTransfer: DataTransfer | null): TerminalPasteOutcome {
  const fileOutcome = normalizeClipboardItems(dataTransfer?.items ?? null);
  if (fileOutcome.kind === "image-files" || fileOutcome.kind === "unsupported-files") {
    return fileOutcome;
  }

  const text = dataTransfer?.getData("text/plain") ?? "";
  return normalizeClipboardText(text);
}
