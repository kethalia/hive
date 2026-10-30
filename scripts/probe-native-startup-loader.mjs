// Fixture-only instrumentation. Never included in the installed host package.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const target = new URL(
  "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
  import.meta.url,
).href;
const runtime = new URL("./probe-native-startup-observer.mjs", import.meta.url).href;

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== target) return result;
  let source = Buffer.from(result.source).toString();
  // Node's test runner may inherit/register the same loader twice in a child.
  if (source.includes(`import { startupObserver } from ${JSON.stringify(runtime)}`)) return result;
  const digest = createHash("sha256").update(source).digest("hex");
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error("diagnostic_source_marker_changed");
    source = source.replace(before, after);
  };
  replace(
    'export const VERSION = "0.165.0";',
    `import { startupObserver } from ${JSON.stringify(runtime)};\nexport const VERSION = "0.165.0";`,
  );
  replace(
    "  const executable = readFileSync(config.codexExecutable);",
    `  const diagnostic = startupObserver({sourceSha256:${JSON.stringify(digest)}, metadata:!!config.metadataReadOnly});\n  const executable = readFileSync(config.codexExecutable);`,
  );
  replace(
    "  const reservation = createServer();",
    '  diagnostic.event("version_verified");\n  const reservation = createServer();',
  );
  replace(
    "  if (namespace) env = namespace.env;",
    '  diagnostic.event("namespace_prepared");\n  if (namespace) env = namespace.env;',
  );
  replace(
    '    env,\n    stdio: ["ignore", "ignore", "ignore", lock],',
    '    env,\n    stdio: ["ignore", "ignore", "pipe", lock],',
  );
  replace(
    "  let ws;\n  let closing = false;",
    "  diagnostic.spawned(child, endpoint);\n  let ws;\n  let closing = false;",
  );
  replace(
    "    closing = true;\n    ws?.terminate();",
    '    diagnostic.event("stop_requested");\n    closing = true;\n    ws?.terminate();',
  );
  if (source.includes("export async function waitForNativeSocket")) {
    replace("  signal,\n  stop,\n}) {", "  signal,\n  stop,\n  diagnostic,\n}) {");
    replace(
      "      deadline: startupDeadline,\n      signal,\n      stop,",
      "      deadline: startupDeadline,\n      signal,\n      stop,\n      diagnostic,",
    );
    replace(
      "    for (;;) {\n      assertCurrent();",
      "    let attempt = 0;\n    for (;;) {\n      diagnostic?.poll(child, attempt++);\n      assertCurrent();",
    );
    replace(
      '            socket.once("open", resolveOpen);\n            socket.once("error", reject);',
      '            socket.once("open", () => { diagnostic?.event("websocket_open", {attempt:attempt-1}); resolveOpen(); });\n            socket.once("error", error => { diagnostic?.socketError(error, attempt-1); reject(error); });',
    );
    replace(
      '      check(socket.readyState === WebSocket.OPEN, "native_disconnected");',
      '      diagnostic?.event("poll_complete", {open:socket.readyState === WebSocket.OPEN});\n      check(socket.readyState === WebSocket.OPEN, "native_disconnected");',
    );
  } else {
    replace(
      '      check(child.exitCode === null && child.signalCode === null, "native_start_failed");',
      '      diagnostic.poll(child, attempt);\n      check(child.exitCode === null && child.signalCode === null, "native_start_failed");',
    );
    replace(
      '          s.once("open", () => r(s));\n          s.once("error", j);',
      '          s.once("open", () => { diagnostic.event("websocket_open", {attempt}); r(s); });\n          s.once("error", error => { diagnostic.socketError(error, attempt); j(error); });',
    );
    replace(
      '    check(ws?.readyState === WebSocket.OPEN, "native_start_timeout");',
      '    diagnostic.event("poll_complete", {open: ws?.readyState === WebSocket.OPEN});\n    check(ws?.readyState === WebSocket.OPEN, "native_start_timeout");',
    );
  }
  replace(
    "    const call = async (method, params) => {\n      sourceInputAuthority?.();",
    '    const call = async (method, params) => {\n      sourceInputAuthority?.();\n      if (["initialize", "configRequirements/read", "command/exec"].includes(method)) diagnostic.event("request", {method});',
  );
  replace(
    "    if (namespace) await namespace.verify(call, namespace.verificationCwd);",
    '    if (namespace) await namespace.verify(call, namespace.verificationCwd);\n    diagnostic.event("namespace_verified");',
  );
  return { ...result, source, shortCircuit: true };
}

// The loader performs no writes and changes no timeouts, retries, arguments,
// permissions, provider configuration, or lifecycle cleanup behavior.
export const sourcePath = fileURLToPath(target);
