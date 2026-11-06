import "dotenv/config";
import { completeCoderOAuth, startCoderOAuth } from "./auth/coder-oauth.js";
import { DEFAULT_PORT } from "./auth/constants.js";
import { handleGetCredentials } from "./handlers/credentials.js";
import { handleLogin } from "./handlers/login.js";
import { handleLogout } from "./handlers/logout.js";
import { handleGetSession } from "./handlers/session.js";
import { handleGetCoderToken } from "./handlers/token.js";
import { addRoute } from "./router.js";
import { parseBody, sendError, sendJson, startServer } from "./server.js";

export { AuthServiceClient } from "./client.js";

addRoute("GET", "/health", async (_req, res) => {
  sendJson(res, 200, { status: "ok", uptime: process.uptime() });
});

addRoute("POST", "/login", async (req, res) => {
  await handleLogin(req, res);
});
addRoute("POST", "/oauth/start", async (_req, res) => {
  try {
    sendJson(res, 200, await startCoderOAuth());
  } catch {
    sendError(res, 503, "Coder sign-in unavailable", "CODER_OAUTH_UNAVAILABLE");
  }
});
addRoute("POST", "/oauth/callback", async (req, res) => {
  const input = (await parseBody(req)) as Record<string, unknown> | undefined;
  if (
    !input ||
    typeof input.state !== "string" ||
    typeof input.browserSecret !== "string" ||
    Object.keys(input).some((key) => !["state", "browserSecret", "code", "denied"].includes(key)) ||
    (input.code !== undefined && typeof input.code !== "string") ||
    (input.denied !== undefined && typeof input.denied !== "boolean")
  )
    return sendError(res, 400, "Invalid callback");
  try {
    sendJson(
      res,
      200,
      await completeCoderOAuth({
        state: input.state,
        browserSecret: input.browserSecret,
        code: input.code as string | undefined,
        denied: input.denied as boolean | undefined,
      }),
    );
  } catch {
    sendError(res, 401, "Coder sign-in could not be completed", "CODER_OAUTH_FAILED");
  }
});

addRoute("POST", "/logout", async (req, res) => {
  await handleLogout(req, res);
});

addRoute("GET", "/sessions/:id", async (req, res, params) => {
  await handleGetSession(req, res, params);
});

addRoute("GET", "/sessions/:id/credentials", async (req, res, params) => {
  await handleGetCredentials(req, res, params);
});

addRoute("GET", "/sessions/:id/token", async (req, res, params) => {
  await handleGetCoderToken(req, res, params);
});

const port = parseInt(process.env.AUTH_SERVICE_PORT ?? String(DEFAULT_PORT), 10);
startServer(port);
