// No CLI or listener startup. Called only by a trusted host integration.
import { startBridge } from "./codex-session-bridge.mjs";
import { createProjectTerminal } from "./codex-project-terminal.mjs";

/** Registry authorization is independent of ticket claims. This function does not
 * register the host with Hive or establish provisioner authority; deployment stays
 * disabled until the registration result has been durably accepted by Hive.
 */
export function startProjectGateway(config, supervisor, controllerRegistration, discovery) {
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
      authorizeBinding: (candidate) => {
        if (controllerRegistration && !controllerRegistration.isActive())
          throw new Error("controller_registration_unavailable");
        return supervisor.authorizeBinding(candidate);
      },
      createTerminal: controllerRegistration
        ? (verifiedConfig) =>
            createProjectTerminal(verifiedConfig, {
              authorize(candidate) {
                const registration = controllerRegistration.currentRegistration();
                if (!registration || registration.serverInstanceId !== candidate.serverInstanceId)
                  throw new Error("controller_registration_unavailable");
                const thread = registration.threads.find((t) => t.threadId === candidate.threadId);
                if (!thread) throw new Error("terminal_thread_unregistered");
                supervisor.authorizeBinding(candidate);
                supervisor.lease(supervisor.project(thread.projectId));
                if (!supervisor.snapshot(thread.projectId).attached)
                  throw new Error("terminal_not_attached");
                return { projectId: thread.projectId };
              },
              onRevoked(callback) {
                const native = supervisor.onRevoked(callback),
                  registered = controllerRegistration.onRevoked(callback);
                return () => {
                  native();
                  registered();
                };
              },
            })
        : undefined,
      handleBootstrap: controllerRegistration?.handleBootstrap,
      handleProjects: discovery?.handleProjects,
      createNativeSocket: () => supervisor.runtime.createReadSocket(),
      onRevoked: (callback) => {
        const native = supervisor.onRevoked(callback);
        const controller = controllerRegistration?.onRevoked(callback);
        return () => {
          native();
          controller?.();
        };
      },
    },
  );
}
