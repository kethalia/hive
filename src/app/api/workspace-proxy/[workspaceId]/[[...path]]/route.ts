// Never redirect proxy resources: scripts included by an old document could still
// execute with Hive authority. Return inert content without contacting a workspace.
export function GET() {
  return Response.json(
    {
      error:
        "Workspace proxy retired. Open workspace tools from Hive to use their authenticated app URLs.",
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
        "Permissions-Policy": "camera=(), microphone=(), clipboard-read=(), clipboard-write=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export const HEAD = GET;
export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
export const PATCH = GET;
export const OPTIONS = GET;
