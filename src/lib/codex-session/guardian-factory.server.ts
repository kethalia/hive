import { getDb } from "@hive/db";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { deliverGuardianEnrollment, requestGuardianIdentity } from "./bootstrap-delivery.server";
import { guardianDeploymentPolicy, guardianDigest } from "./guardian-contracts";
import { type GuardianOwnerTransport, GuardianService } from "./guardian-service.server";
import { registeredSessionConfig } from "./registered-session.server";
import { resolveVerifiedWorkspaceHost } from "./registration.server";
import { RegistrationRejected } from "./registration-store.server";

export function createGuardianService(
  options: { signal?: AbortSignal; transport?: GuardianOwnerTransport } = {},
) {
  const db = getDb(),
    config = registeredSessionConfig(),
    policy = guardianDeploymentPolicy();
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new RegistrationRejected();
  const resolve = async (
    principal: { hiveUserId: string; coderUserId: string },
    workspaceId: string,
  ) => {
    options.signal?.throwIfAborted();
    const user = await db.user.findUnique({ where: { id: principal.hiveUserId } });
    if (!user || user.coderUserId !== principal.coderUserId) throw new RegistrationRejected();
    const coder = await getCoderClientForUser(
      user.id,
      options.signal ? { signal: options.signal } : undefined,
    );
    const { binding } = await resolveVerifiedWorkspaceHost(
      config,
      async () => coder,
      principal,
      workspaceId,
    );
    options.signal?.throwIfAborted();
    return { binding, coder };
  };
  const currentCoder = async (binding: Parameters<GuardianOwnerTransport["identity"]>[0]) => {
    const fresh = await resolve(
      { hiveUserId: binding.hiveUserId, coderUserId: binding.ownerId },
      binding.workspaceId,
    );
    if (guardianDigest(fresh.binding) !== guardianDigest(binding)) throw new RegistrationRejected();
    return fresh.coder;
  };
  return new GuardianService(db, config, policy, encryptionKey, {
    signal: options.signal,
    transport: options.transport ?? {
      async identity(binding, nonce) {
        const value = await requestGuardianIdentity(await currentCoder(binding), binding, nonce);
        options.signal?.throwIfAborted();
        return value;
      },
      async bootstrap(binding, grant) {
        const value = await deliverGuardianEnrollment(await currentCoder(binding), binding, grant);
        options.signal?.throwIfAborted();
        return value;
      },
    },
    async resolveWorkspace(principal, workspaceId) {
      return (await resolve(principal, workspaceId)).binding;
    },
  });
}
