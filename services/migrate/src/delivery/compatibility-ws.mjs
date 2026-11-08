import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { requireValue } from "./contracts.mjs";

const require = createRequire(import.meta.url);

/** Local-only transport for unchanged artifact drivers. The target is fixed by
 * the trusted harness, never by a WebSocket URL or candidate message. */
export async function compatibilityDatabaseTransport(
  databaseUrl,
  { knownTrustFixture = false } = {},
) {
  const target = new URL(databaseUrl);
  requireValue(
    ["127.0.0.1", "localhost"].includes(target.hostname) &&
      target.port &&
      (target.pathname === "/hive_compatibility" ||
        /^\/hive_d10_test(?:_[a-z0-9_]+)?$/.test(target.pathname)) &&
      (!knownTrustFixture || !target.password),
    "migration_compatibility_fixture_scope",
  );
  const { WebSocketServer } = require("ws"),
    server = createServer(),
    sockets = new Set(),
    counts = [
      { connections: 0, queries: 0 },
      { connections: 0, queries: 0 },
    ];
  const ws = new WebSocketServer({ server, maxPayload: 1048576 });
  ws.on("connection", (socket, request) => {
    const version = request.headers["x-hive-compatibility-version"];
    if (!["0", "1"].includes(version) || sockets.size >= 16) {
      socket.terminate();
      return;
    }
    const stats = counts[Number(version)],
      upstream = connect({ host: target.hostname, port: Number(target.port) });
    stats.connections++;
    sockets.add(upstream);
    let client = Buffer.alloc(0),
      startup = false,
      trustVerified = false,
      transparent = false,
      response = Buffer.alloc(0),
      firstReady = true,
      failed = false,
      commandCompleted = false;
    const close = () => {
      upstream.destroy();
      socket.terminate();
      sockets.delete(upstream);
    };
    upstream.setTimeout(30000, close);
    const flushClient = () => {
      if (client.length > 65536) return close();
      if (!startup) {
        if (client.length < 8) return;
        const length = client.readUInt32BE(0);
        if (length < 8 || length > 65536 || client.readUInt32BE(4) !== 196608) return close();
        if (client.length < length) return;
        const frame = client.subarray(0, length),
          parameters = frame.subarray(8);
        if (parameters.at(-1) !== 0 || parameters.at(-2) !== 0) return close();
        const fields = parameters.toString("utf8").split("\0").slice(0, -2),
          values = new Map();
        if (fields.length % 2 !== 0) return close();
        for (let index = 0; index < fields.length; index += 2) {
          if (!fields[index] || values.has(fields[index])) return close();
          values.set(fields[index], fields[index + 1]);
        }
        if (
          values.get("user") !== decodeURIComponent(target.username) ||
          values.get("database") !== decodeURIComponent(target.pathname.slice(1))
        )
          return close();
        upstream.write(frame);
        client = client.subarray(length);
        startup = true;
        if (!knownTrustFixture) {
          transparent = true;
          if (client.length) upstream.write(client);
          client = Buffer.alloc(0);
          return;
        }
      }
      if (!trustVerified || client.length < 5) return;
      const length = client.readUInt32BE(1) + 1;
      if (length < 5 || length > 65536) return close();
      if (client.length < length) return;
      // Neon pipelines a Password packet. Only the explicitly passwordless,
      // known-trust local fixture has already authenticated without it.
      if (client[0] === 112) client = client.subarray(length);
      transparent = true;
      if (client.length) upstream.write(client);
      client = Buffer.alloc(0);
    };
    socket.on("message", (data) => {
      if (transparent) upstream.write(data);
      else {
        client = Buffer.concat([client, Buffer.from(data)]);
        flushClient();
      }
    });
    upstream.on("data", (data) => {
      response = Buffer.concat([response, data]);
      if (response.length > 1048576) return close();
      while (response.length >= 5) {
        const length = response.readUInt32BE(1) + 1;
        if (length < 5 || length > 1048576) return close();
        if (response.length < length) break;
        if (knownTrustFixture && !trustVerified && response[0] === 82) {
          if (length !== 9 || response.readUInt32BE(5) !== 0) return close();
          trustVerified = true;
          flushClient();
        }
        if (response[0] === 69) failed = true;
        if (response[0] === 67) commandCompleted = true;
        if (response[0] === 90) {
          if (!firstReady && !failed && commandCompleted) stats.queries++;
          firstReady = false;
          failed = false;
          commandCompleted = false;
        }
        response = response.subarray(length);
      }
      if (socket.readyState === 1) socket.send(data);
      else close();
    });
    socket.on("close", close);
    socket.on("error", close);
    upstream.on("close", close);
    upstream.on("error", close);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    counts,
    origin: `ws://127.0.0.1:${port}`,

    route(version) {
      requireValue(version === 0 || version === 1, "migration_compatibility_fixture_scope");
      return `export default {fetch(request){const u=new URL(request.url);
        if(u.hostname!==${JSON.stringify(target.hostname)}||u.port||u.pathname!=='/v2'||u.search||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('denied',{status:403});
        return fetch('http://127.0.0.1:${port}/',{headers:{Upgrade:'websocket','X-Hive-Compatibility-Version':'${version}'}})}};`;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      ws.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function startSourceCompatibilityWorker({
  files,
  directory,
  port,
  bindings,
  date,
  transport,
  version,
}) {
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = await import(
    pathToFileURL(
      require.resolve("miniflare", {
        paths: [dirname(require.resolve("wrangler/package.json"))],
      }),
    ).href
  );
  const modules = [...files]
    .filter(([name]) => name.startsWith("app/"))
    .map(([name, bytes]) => ({
      type: name.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
      path: `${directory}/${name}`,
      contents: name.endsWith(".wasm") ? bytes : bytes.toString("utf8"),
    }));
  modules.sort((a, b) =>
    a.path.endsWith("/worker.js")
      ? -1
      : b.path.endsWith("/worker.js")
        ? 1
        : a.path.localeCompare(b.path),
  );
  const instance = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new Log(LogLevel.NONE),
      host: "127.0.0.1",
      port,
      workers: [
        {
          name: "application",
          modulesRoot: "/",
          modules,
          compatibilityDate: date,
          compatibilityFlags: ["nodejs_compat"],
          bindings,
          outboundService: "isolated-neon",
          serviceBindings: {
            ASSETS: async (request) => {
              const name = `assets${new URL(request.url).pathname}`,
                bytes = files.get(name);
              return new Response(bytes ?? null, {
                status: bytes ? 200 : 404,
                headers: {
                  "Content-Type": name.endsWith(".js")
                    ? "text/javascript"
                    : name.endsWith(".css")
                      ? "text/css"
                      : "application/octet-stream",
                },
              });
            },
          },
        },
        {
          name: "isolated-neon",
          modules: true,
          script: transport.route(version),
          compatibilityDate: date,
          compatibilityFlags: ["nodejs_compat"],
        },
      ],
    }),
  );
  try {
    await instance.ready;
    return instance;
  } catch (error) {
    await instance.dispose();
    throw error;
  }
}
