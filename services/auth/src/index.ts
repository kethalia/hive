import "dotenv/config";
import { addRoute } from "./router.js";
import { sendJson } from "./server.js";
import { startServer } from "./server.js";
import { handleLogin } from "./handlers/login.js";
import { handleLogout } from "./handlers/logout.js";
import { handleGetSession } from "./handlers/session.js";
import { handleGetCredentials } from "./handlers/credentials.js";
import { handleGetCoderToken } from "./handlers/token.js";

export { AuthServiceClient } from "./client.js";

addRoute("GET", "/health", async (_req, res) => {
  sendJson(res, 200, { status: "ok", uptime: process.uptime() });
});

addRoute("POST", "/login", async (req, res) => {
  await handleLogin(req, res);
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

const port = parseInt(process.env.AUTH_SERVICE_PORT ?? "4400", 10);
startServer(port);
