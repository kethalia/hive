import { TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES } from "@/lib/terminal/paste-limits";

export const TERMINAL_PASTE_REQUEST_TIMEOUT_MS = 120_000;

export class PasteRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function readTerminalPasteFormData(
  request: Request,
  signal: AbortSignal,
): Promise<FormData> {
  const reader = request.body?.getReader();
  if (!reader) throw new PasteRequestError("Expected multipart form data", 400);
  // Cancellation is best-effort; a hostile/stalled source must not hold the slot.
  const cancel = () => void reader.cancel().catch(() => {});
  const abort = () => cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength)) {
        throw new PasteRequestError("Invalid Content-Length", 400);
      }
      if (Number(contentLength) > TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES) {
        throw new PasteRequestError("Paste request is too large", 413);
      }
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data\s*;/i.test(contentType)) {
      throw new PasteRequestError("Expected multipart form data", 400);
    }
    // A fixed buffer also bounds metadata overhead for tiny/empty stream chunks.
    const body = Buffer.allocUnsafe(TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (size + value.byteLength > TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES) {
        throw new PasteRequestError("Paste request is too large", 413);
      }
      body.set(value, size);
      size += value.byteLength;
    }
    // Only bounded bytes reach the multipart parser, regardless of Content-Length.
    const formData = await new Response(body.subarray(0, size), {
      headers: { "Content-Type": contentType },
    }).formData();
    signal.throwIfAborted();
    return formData;
  } catch (error) {
    cancel();
    if (signal.aborted) throw signal.reason;
    if (error instanceof PasteRequestError) throw error;
    throw new PasteRequestError("Expected multipart form data", 400);
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
