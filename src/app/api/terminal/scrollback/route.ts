import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function parsePositiveInt(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return NaN;
  return n;
}

export async function GET(request: NextRequest) {
  const reconnectId = request.nextUrl.searchParams.get("reconnectId");

  if (!reconnectId || !UUID_RE.test(reconnectId)) {
    return new Response(
      JSON.stringify({
        error: reconnectId
          ? "Invalid reconnectId format — expected UUID"
          : "Missing required parameter: reconnectId",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const rawCursor = request.nextUrl.searchParams.get("cursor");
  const rawLimit = request.nextUrl.searchParams.get("limit");

  const cursor = parsePositiveInt(rawCursor);
  const limit = parsePositiveInt(rawLimit);

  if (rawCursor !== null && (cursor === null || Number.isNaN(cursor))) {
    return new Response(
      JSON.stringify({ error: "Invalid cursor — expected positive integer" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (rawLimit !== null && (limit === null || Number.isNaN(limit))) {
    return new Response(
      JSON.stringify({ error: "Invalid limit — expected positive integer" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const isPaginated = rawCursor !== null || rawLimit !== null;
  const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  try {
    const db = getDb();

    const [chunks, totalChunks] = await Promise.all([
      isPaginated
        ? db.scrollbackChunk
            .findMany({
              where: {
                reconnectId,
                ...(cursor ? { seqNum: { lt: cursor } } : {}),
              },
              orderBy: { seqNum: "desc" },
              take: effectiveLimit,
              select: { data: true },
            })
            .then((rows) => rows.reverse())
        : db.scrollbackChunk.findMany({
            where: { reconnectId },
            orderBy: { seqNum: "asc" },
            select: { data: true },
          }),
      db.scrollbackChunk.count({ where: { reconnectId } }),
    ]);

    if (chunks.length === 0) {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Length": "0",
          "X-Total-Chunks": String(totalChunks),
        },
      });
    }

    const buffers = chunks.map((c) => Buffer.from(c.data));
    const body = Buffer.concat(buffers);

    console.log(
      `[scrollback] hydration request reconnectId=${reconnectId} chunks=${chunks.length} totalChunks=${totalChunks} bytes=${body.byteLength}${cursor ? ` cursor=${cursor}` : ""}`,
    );

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
        "X-Total-Chunks": String(totalChunks),
      },
    });
  } catch (err) {
    console.error("[scrollback] hydration error", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
