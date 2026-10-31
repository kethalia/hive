import { publicationAwait } from "./publication-io";
import {
  TEMPLATE_LOG_LIMITS,
  type TemplateLogFallback,
  type TemplateLogPage,
  templateLogCursorSchema,
  templateLogRecordSchema,
} from "./publication-log-contracts";

/** Incremental JSON-array reader. Only complete, validated object rows advance
 * the cursor. A truncated/malformed row is never skipped or exposed as output. */
export async function readTemplateLogArray(
  response: Response,
  after: string,
  signal: AbortSignal,
): Promise<TemplateLogPage> {
  templateLogCursorSchema.parse(after);
  const result: TemplateLogPage = { records: [], nextAfter: after, hasMore: true, fallback: null };
  if (!response.body) return { ...result, fallback: "malformed" };
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let phase: "head" | "first" | "next" | "separator" | "tail" = "head",
    depth = 0,
    inString = false,
    escaped = false,
    row = "",
    rowBytes = 0,
    bytes = 0,
    ended = false;
  const stop = (reason: TemplateLogFallback) => {
    result.fallback = reason;
  };
  const complete = () => phase === "tail" && depth === 0;
  const process = (text: string) => {
    for (const character of text) {
      if (result.fallback) return;
      if (depth) {
        const code = character.codePointAt(0) ?? 0;
        rowBytes += code <= 127 ? 1 : code <= 2047 ? 2 : code <= 65535 ? 3 : 4;
        if (rowBytes > TEMPLATE_LOG_LIMITS.rowBytes) {
          stop("row_too_large");
          return;
        }
        row += character;
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
        } else if (character === '"') inString = true;
        else if (character === "{" || character === "[") depth++;
        else if (character === "}" || character === "]") depth--;
        if (depth === 0) {
          if (character !== "}") {
            stop("malformed");
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(row);
          } catch {
            stop("malformed");
            return;
          }
          const parsed = templateLogRecordSchema.safeParse(raw);
          if (!parsed.success || BigInt(parsed.data.id) <= BigInt(result.nextAfter)) {
            stop("malformed");
            return;
          }
          const value = parsed.data;
          result.records.push({ ...value, id: String(value.id) });
          result.nextAfter = String(value.id);
          row = "";
          rowBytes = 0;
          phase = "separator";
          if (result.records.length >= TEMPLATE_LOG_LIMITS.records) {
            stop("record_limit");
            return;
          }
        }
      } else if (
        character === " " ||
        character === "\n" ||
        character === "\r" ||
        character === "\t"
      )
        continue;
      else if (phase === "head") {
        if (character !== "[") {
          stop("malformed");
          return;
        }
        phase = "first";
      } else if (phase === "first" && character === "]") phase = "tail";
      else if ((phase === "first" || phase === "next") && character === "{") {
        row = "{";
        rowBytes = 1;
        depth = 1;
        inString = false;
        escaped = false;
      } else if (phase === "separator" && character === ",") phase = "next";
      else if (phase === "separator" && character === "]") phase = "tail";
      else {
        stop("malformed");
        return;
      }
    }
  };
  try {
    for (let chunks = 0; chunks < TEMPLATE_LOG_LIMITS.chunks; chunks++) {
      if (signal.aborted) {
        stop("deadline");
        break;
      }
      const next = await publicationAwait(reader.read(), signal);
      if (next.done) {
        ended = true;
        process(decoder.decode());
        if (!result.fallback) {
          if (!complete()) stop("malformed");
          else result.hasMore = false;
        }
        break;
      }
      const remaining = TEMPLATE_LOG_LIMITS.bytes - bytes,
        portion = next.value.subarray(0, remaining);
      bytes += portion.byteLength;
      process(decoder.decode(portion, { stream: true }));
      if (result.fallback) break;
      if (bytes >= TEMPLATE_LOG_LIMITS.bytes) {
        stop("byte_limit");
        break;
      }
      if (chunks === TEMPLATE_LOG_LIMITS.chunks - 1) stop("chunk_limit");
    }
  } catch {
    stop(signal.aborted ? "deadline" : "malformed");
  } finally {
    if (!ended)
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
  }
  return result;
}
