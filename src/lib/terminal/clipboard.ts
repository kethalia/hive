import type { Terminal } from "@xterm/xterm";

export const TERMINAL_PASTE_ASSET_MAX_FILES = 10;
export const TERMINAL_PASTE_ASSET_MAX_BYTES = 10 * 1024 * 1024;
const TERMINAL_PASTE_ASSET_MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["text/plain", "txt"],
]);

export type TerminalPasteSource = "clipboard-api" | "native-paste" | "toolbar" | "context-menu";

export type TerminalPasteOutcome =
  | { kind: "empty" }
  | { kind: "text"; text: string; multiline: boolean }
  | { kind: "asset-files"; files: File[] };

export type TerminalPasteStatus =
  | {
      action: "paste";
      outcome: "uploading";
      method: "clipboard-api";
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
      outcome: "failed";
      reason: "workspace-required" | "too-many-files" | "file-too-large" | "upload-failed";
      message: string;
    };

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
  onStatus?: (status: TerminalPasteStatus) => void;
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
  return { kind: "asset-files", files };
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

export async function uploadTerminalPasteAssets(
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
    throw new Error(payload?.error ?? "Failed to upload pasted file");
  }
  return payload.paths;
}

function clipboardFileName(index: number, type: string): string {
  const extension = TERMINAL_PASTE_ASSET_MIME_EXTENSIONS.get(type) ?? "bin";
  return `clipboard-${index + 1}.${extension}`;
}

function preferredClipboardAssetType(item: ClipboardItem): string | null {
  for (const type of TERMINAL_PASTE_ASSET_MIME_EXTENSIONS.keys()) {
    if (type !== "text/plain" && item.types.includes(type)) return type;
  }

  return item.types.find((type) => type !== "text/plain" && type !== "text/html") ?? null;
}

export async function readClipboardApiOutcome(clipboard: Clipboard): Promise<TerminalPasteOutcome> {
  if (typeof clipboard.read === "function") {
    const items = await clipboard.read();
    const files: File[] = [];

    for (const item of items) {
      const type = preferredClipboardAssetType(item);
      if (!type) continue;
      const blob = await item.getType(type);
      files.push(
        new File([blob], clipboardFileName(files.length, blob.type || type), {
          type: blob.type || type,
        }),
      );
    }

    if (files.length > 0) return { kind: "asset-files", files };
  }

  if (typeof clipboard.readText !== "function") return { kind: "empty" };
  return normalizeClipboardText(await clipboard.readText());
}

export async function handleTerminalPasteOutcome(
  outcome: TerminalPasteOutcome,
  controller: TerminalPasteController,
): Promise<void> {
  if (outcome.kind === "empty") {
    controller.onStatus?.({ action: "paste", outcome: "empty", method: "clipboard-api" });
    return;
  }

  if (outcome.kind === "asset-files") {
    if (!controller.workspaceId) {
      controller.onStatus?.({
        action: "paste",
        outcome: "failed",
        reason: "workspace-required",
        message: "File paste requires a workspace target.",
      });
      return;
    }
    if (outcome.files.length > TERMINAL_PASTE_ASSET_MAX_FILES) {
      controller.onStatus?.({
        action: "paste",
        outcome: "failed",
        reason: "too-many-files",
        message: `Paste up to ${TERMINAL_PASTE_ASSET_MAX_FILES} files at once.`,
      });
      return;
    }
    if (outcome.files.some((file) => file.size > TERMINAL_PASTE_ASSET_MAX_BYTES)) {
      controller.onStatus?.({
        action: "paste",
        outcome: "failed",
        reason: "file-too-large",
        message: "Each pasted file must be 10 MiB or smaller.",
      });
      return;
    }

    try {
      controller.onStatus?.({ action: "paste", outcome: "uploading", method: "clipboard-api" });
      const paths = await uploadTerminalPasteAssets(controller.workspaceId, outcome.files);
      if (paths.length === 1) {
        pasteTextToXterm(controller.term, controller.send, paths[0] ?? "");
        controller.onStatus?.({ action: "paste", outcome: "pasted", method: "clipboard-api" });
        return;
      }

      controller.openCompose({
        draft: paths.join("\n"),
        append: true,
        targetLabel: controller.targetLabel,
      });
      controller.onStatus?.({ action: "paste", outcome: "pasted", method: "clipboard-api" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Failed to upload pasted file";
      controller.onStatus?.({
        action: "paste",
        outcome: "failed",
        reason: "upload-failed",
        message: `File paste failed: ${reason}`,
      });
    }
    return;
  }

  if (outcome.multiline) {
    controller.openCompose({
      draft: outcome.text,
      append: true,
      targetLabel: controller.targetLabel,
    });
    controller.onStatus?.({ action: "paste", outcome: "pasted", method: "clipboard-api" });
    return;
  }

  pasteTextToXterm(controller.term, controller.send, outcome.text);
  controller.onStatus?.({ action: "paste", outcome: "pasted", method: "clipboard-api" });
}

export function readNativePasteOutcome(event: ClipboardEvent): TerminalPasteOutcome {
  const fileOutcome = normalizeClipboardItems(event.clipboardData?.items ?? null);
  if (fileOutcome.kind === "asset-files") {
    return fileOutcome;
  }

  const text = event.clipboardData?.getData("text/plain") ?? "";
  return normalizeClipboardText(text);
}

export function readDataTransferOutcome(dataTransfer: DataTransfer | null): TerminalPasteOutcome {
  const fileOutcome = normalizeClipboardItems(dataTransfer?.items ?? null);
  if (fileOutcome.kind === "asset-files") {
    return fileOutcome;
  }

  const text = dataTransfer?.getData("text/plain") ?? "";
  return normalizeClipboardText(text);
}
