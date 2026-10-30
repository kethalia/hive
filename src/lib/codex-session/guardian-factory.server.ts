import { getDb } from "@hive/db";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { guardianDeploymentPolicy } from "./guardian-contracts";
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
  return new GuardianService(db, config, policy, encryptionKey, {
    signal: options.signal,
    transport: options.transport,
    async resolveWorkspace(principal, workspaceId) {
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
      return binding;
    },
  });
}
