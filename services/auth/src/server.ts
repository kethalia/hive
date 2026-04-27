import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { matchRoute } from "./router.js";
import { closeDb } from "./db.js";
import { ErrorCode } from "./auth/constants.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  code?: string
): void {
  sendJson(res, status, { error: message, code: code ?? "ERROR" });
}

export function startServer(port: number): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    console.log(`[auth-service] ${method} ${pathname}`);

    const match = matchRoute(method, pathname);
    if (!match) {
      sendError(res, 404, "Not found", ErrorCode.NOT_FOUND);
      return;
    }

    try {
      await match.handler(req, res, match.params);
    } catch (err) {
      if (err instanceof Error && err.message === "Request body too large") {
        sendError(res, 413, "Request body too large", ErrorCode.BAD_REQUEST);
        return;
      }
      if (err instanceof Error && err.message === "Invalid JSON body") {
        sendError(res, 400, "Invalid JSON body", ErrorCode.BAD_REQUEST);
        return;
      }
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error(`[auth-service] Handler error: ${message}`);
      sendError(res, 500, "Internal server error", ErrorCode.INTERNAL_ERROR);
    }
  });

  server.listen(port, () => {
    console.log(`[auth-service] Listening on port ${port}`);
  });

  const shutdown = () => {
    console.log("[auth-service] Shutting down...");
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}
