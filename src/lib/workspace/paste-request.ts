import { MIMEType } from "node:util";
import { publicationAwait } from "@/lib/templates/publication-io";
import {
  TERMINAL_PASTE_ASSET_MAX_FILES,
  TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES,
} from "@/lib/terminal/paste-limits";

export const TERMINAL_PASTE_REQUEST_TIMEOUT_MS = 120_000;

export class PasteRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function multipartBoundary(contentType: string): string {
  if (contentType.length > 1024) throw new PasteRequestError("Invalid multipart boundary", 400);
  const mimeType = new MIMEType(contentType);
  const boundary = mimeType.params.get("boundary") ?? "";
  // RFC 2046 boundaries are at most 70 ASCII characters and cannot end in space.
  if (
    mimeType.essence !== "multipart/form-data" ||
    !/^[0-9A-Za-z'()+_,./:=? -]{1,70}$/.test(boundary) ||
    boundary.endsWith(" ")
  ) {
    throw new PasteRequestError("Invalid multipart boundary", 400);
  }
  return boundary;
}

function assertPartLimit(body: Buffer, boundary: string): void {
  const marker = Buffer.from(`--${boundary}`);
  let offset = 0;
  let parts = 0;
  while (true) {
    offset = body.indexOf(marker, offset);
    if (offset === -1) break;
    offset += marker.length;
    // Exclude closing delimiters. Conservatively count every other marker,
    // including malformed ones: this can overcount, but cannot miss parser entries.
    if (body[offset] === 0x2d && body[offset + 1] === 0x2d) continue;
    if (++parts > TERMINAL_PASTE_ASSET_MAX_FILES) {
      throw new PasteRequestError(
        `Paste up to ${TERMINAL_PASTE_ASSET_MAX_FILES} multipart parts at once`,
        413,
      );
    }
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
    const boundary = multipartBoundary(contentType);
    // A fixed buffer also bounds metadata overhead for tiny/empty stream chunks.
    const body = Buffer.allocUnsafe(TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES);
    let size = 0;
    let chunks = 0;
    while (true) {
      if (++chunks > 65536) throw new PasteRequestError("Paste request has too many chunks", 413);
      const { done, value } = await publicationAwait(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      if (size + value.byteLength > TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES) {
        throw new PasteRequestError("Paste request is too large", 413);
      }
      body.set(value, size);
      size += value.byteLength;
    }
    const bytes = body.subarray(0, size);
    // Count before the parser can allocate entries/strings/Files for empty parts.
    assertPartLimit(bytes, boundary);
    // Use exactly the validated boundary in both scans and parsing, even when
    // the supplied Content-Type has duplicate/quoted/extra parameters.
    const formData = await new Response(bytes, {
      headers: { "Content-Type": `multipart/form-data; boundary="${boundary}"` },
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
    try {
      reader.releaseLock();
    } catch {}
  }
}
