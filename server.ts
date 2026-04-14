import { createServer } from "node:http";
import next from "next";
import { handleUpgrade } from "./src/lib/terminal/proxy";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(handle);

  server.on("upgrade", (req, socket, head) => {
    const pathname = req.url?.split("?")[0] ?? "";
    if (pathname === "/api/terminal/ws") {
      handleUpgrade(req, socket, head);
    } else {
      app.getUpgradeHandler()(req, socket, head);
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (${dev ? "development" : "production"})`);
  });
});
