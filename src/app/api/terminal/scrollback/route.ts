import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  try {
    const db = getDb();
    const chunks = await db.scrollbackChunk.findMany({
      where: { reconnectId },
      orderBy: { seqNum: "asc" },
      select: { data: true },
    });

    if (chunks.length === 0) {
      return new Response(null, {
        status: 200,
        headers: { "Content-Length": "0" },
      });
    }

    const buffers = chunks.map((c) => Buffer.from(c.data));
    const body = Buffer.concat(buffers);

    console.log(
      `[scrollback] hydration request reconnectId=${reconnectId} chunks=${chunks.length} bytes=${body.byteLength}`,
    );

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
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
