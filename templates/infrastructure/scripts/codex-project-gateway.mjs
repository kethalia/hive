// No CLI or listener startup. Called only by a trusted host integration.
import { startBridge } from "./codex-session-bridge.mjs";

/** Registry authorization is independent of ticket claims. This function does not
 * register the host with Hive or establish provisioner authority; deployment stays
 * disabled until the registration result has been durably accepted by Hive.
 */
export function startProjectGateway(config, supervisor) {
  const keys = [
    "schemaVersion",
    "protocolVersion",
    "hiveOrigin",
    "appOrigin",
    "publicKeyPem",
    "keyId",
    "stateDirectory",
    "port",
  ];
  if (!config || Object.keys(config).some((key) => !keys.includes(key)))
    throw new Error("invalid_gateway_configuration");
  if (supervisor.state.status !== "ready" || !supervisor.runtime.alive())
    throw new Error("native_lifetime_unavailable");
  const binding = Object.fromEntries(
    ["ownerId", "workspaceId", "buildId"].map((key) => [key, supervisor.config[key]]),
  );
  binding.serverInstanceId = supervisor.state.serverInstanceId;
  return startBridge(
    { ...config, binding },
    {
      authorizeBinding: (candidate) => supervisor.authorizeBinding(candidate),
      createNativeSocket: () => supervisor.runtime.createReadSocket(),
      onRevoked: (callback) => supervisor.onRevoked(callback),
    },
  );
}
