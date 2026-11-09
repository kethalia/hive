import { createHash, createPublicKey, verify } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import type { WorkspaceResource } from "@/lib/coder/types";
import { guardianDigest } from "./guardian-contracts";
import {
  type EmptyRootProposal,
  type EmptyRootVolume,
  emptyRootAnchorSchema,
  emptyRootCleanupHistorySchema,
  emptyRootProposalSchema,
  emptyRootVolumeSchema,
} from "./guardian-empty-root-contracts";
import { guardianVolumeSchema } from "./guardian-remount-contracts";
import type { GuardianRuntimeIdentity } from "./guardian-store.server";
import { guardianEnrollmentClaimsSchema } from "./guardian-transport-contracts";
import type { RegistrationBinding } from "./registration.server";
import { RegistrationRejected } from "./registration-store.server";

const check: (v: unknown) => asserts v = (v) => {
  if (!v) throw new RegistrationRejected();
};
// Historical provider identity is deliberately NOT GuardianVolume. Incomplete
// boundVolumeName is retained as history, never substituted or used as authority.
const historicalHomeSchema = guardianVolumeSchema.extend({
  boundVolumeName: guardianVolumeSchema.shape.boundVolumeName.or(z.literal("")),
});
export type HistoricalHomeIdentity = Omit<z.infer<typeof historicalHomeSchema>, "boundVolumeName">;
export function readHistoricalHomeIdentity(resources: WorkspaceResource[]) {
  const rows = resources.filter(
    (r) => r.type === "kubernetes_deployment_v1" && r.name === "workspace",
  );
  check(rows.length === 1 && rows[0].agents?.length === 1);
  check(
    resources.flatMap((r) => r.agents ?? []).filter((a) => a.id === rows[0].agents?.[0].id)
      .length === 1,
  );
  z.string().uuid().parse(rows[0].id);
  const values = (rows[0].metadata ?? []).filter((m) => m.key === "hive_home_volume_v1");
  check(
    values.length === 1 &&
      !values[0].sensitive &&
      typeof values[0].value === "string" &&
      values[0].value.length <= 2048,
  );
  const { boundVolumeName, ...identity } = historicalHomeSchema.parse(JSON.parse(values[0].value));
  return { resourceId: rows[0].id, identity, observedBoundVolumeName: boundVolumeName || null };
}
export type UnusedBootstrapSource = ReturnType<typeof readHistoricalHomeIdentity> & {
  oldBuildId: string;
};

export function authorizeUnusedBootstrapRoot(
  binding: RegistrationBinding,
  raw: EmptyRootProposal,
  volume: EmptyRootVolume,
  identity: GuardianRuntimeIdentity,
  source: UnusedBootstrapSource,
  now = Date.now(),
) {
  const p = emptyRootProposalSchema.parse(raw),
    current = emptyRootVolumeSchema.parse(volume),
    u = p.unusedBootstrap;
  check(
    p.mode === "initial-unused-remount" &&
      u &&
      source.resourceId &&
      u.coderOrigin === binding.coderOrigin &&
      u.hiveUserId === binding.hiveUserId &&
      u.ownerId === binding.ownerId &&
      u.workspaceId === binding.workspaceId &&
      u.templateId === binding.templateId &&
      u.newBuildId === binding.buildId &&
      u.oldBuildId === source.oldBuildId &&
      u.newConfigSha256 === identity.configSha256 &&
      u.newPackageManifestSha256 === identity.packageManifestSha256 &&
      u.oldLifetimeId !== identity.lifetimeId &&
      current.lifetimeId === identity.lifetimeId &&
      current.buildId === binding.buildId &&
      current.observedAt <= now &&
      now - current.observedAt <= 30000 &&
      current.volumeDigest === guardianDigest(current.volume) &&
      current.volume.pvcName === `coder-${binding.workspaceId}-home` &&
      current.volume.boundVolumeName === `pvc-${current.volume.pvcUid}`,
  );
  const { boundVolumeName: _currentBinding, ...physicalVolume } = current.volume;
  check(
    guardianDigest(source.identity) === guardianDigest(physicalVolume) &&
      (source.observedBoundVolumeName === null ||
        source.observedBoundVolumeName === current.volume.boundVolumeName),
  );
  return emptyRootAnchorSchema.parse({
    schemaVersion: 1,
    purpose: "empty-managed-root",
    proposalDigest: guardianDigest(p),
    currentVolume: current,
    records: { root: p.root.newRecordSha256, projects: {} },
    identities: { root: p.root.current, projects: {} },
    unusedBootstrapDigest: guardianDigest(u),
  });
}
function decode(token: string, domain: string, key: string) {
  check(token.length <= 12000);
  const parts = token.split(".");
  check(parts.length === (domain === "hive-project-cleanup-v1" ? 2 : 3));
  const body = parts.length === 2 ? parts[0] : parts[1];
  check(parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
  const message = parts.length === 2 ? `${domain}\n${body}` : `${parts[0]}.${body}`;
  check(
    verify(
      null,
      Buffer.from(message),
      createPublicKey(key),
      Buffer.from(parts.at(-1)!, "base64url"),
    ),
  );
  return JSON.parse(Buffer.from(body, "base64url").toString());
}
export function readEmptyRootResource(resources: WorkspaceResource[], agentId: string) {
  const rows = resources.filter(
    (r) => r.type === "kubernetes_deployment_v1" && r.name === "workspace",
  );
  check(
    rows.length === 1 &&
      rows[0].agents?.length === 1 &&
      rows[0].agents[0].id === agentId &&
      resources.flatMap((r) => r.agents ?? []).filter((a) => a.id === agentId).length === 1,
  );
  const values = (rows[0].metadata ?? []).filter((m) => m.key === "hive_home_volume_v1");
  check(
    values.length === 1 &&
      !values[0].sensitive &&
      typeof values[0].value === "string" &&
      values[0].value.length <= 2048,
  );
  return {
    resourceId: rows[0].id,
    volume: guardianVolumeSchema.parse(JSON.parse(values[0].value)),
  };
}
export async function authorizeEmptyRoot(
  db: PrismaClient,
  binding: RegistrationBinding,
  raw: EmptyRootProposal,
  volume: EmptyRootVolume,
  publicKeyPem: string,
  now = Date.now(),
) {
  const p = emptyRootProposalSchema.parse(raw),
    current = emptyRootVolumeSchema.parse(volume);
  check(
    current.buildId === binding.buildId &&
      current.volumeDigest === guardianDigest(current.volume) &&
      current.observedAt <= now &&
      now - current.observedAt <= 30000,
  );
  check(new Set(p.projects.map((x) => x.repositoryId)).size === p.projects.length);
  check(
    p.mode !== "initial-current" ||
      (!p.projects.length &&
        !p.previousEnrollment &&
        guardianDigest(p.root.old) === guardianDigest(p.root.current) &&
        p.root.recordSha256 === p.root.newRecordSha256),
  );
  let oldVolume: unknown, previous: ReturnType<typeof emptyRootAnchorSchema.parse> | undefined;
  if (p.previousEnrollment) {
    const claims = guardianEnrollmentClaimsSchema.parse(
      decode(p.previousEnrollment, "enrollment", publicKeyPem),
    );
    check(
      claims.exp > claims.iat &&
        claims.exp - claims.iat <= 60 &&
        claims.scope === "workspace:guardian:enroll" &&
        claims.hiveUserId === binding.hiveUserId &&
        claims.coderOwnerId === binding.ownerId &&
        claims.workspaceId === binding.workspaceId &&
        claims.buildId !== binding.buildId,
    );
    previous = emptyRootAnchorSchema.parse(claims.emptyRoot);
    const grant = await db.codexGuardianEnrollmentGrant.findFirst({
      where: {
        ownerId: binding.hiveUserId,
        id: claims.jti,
        runtimeId: claims.runtimeId,
        tokenDigest: createHash("sha256").update(p.previousEnrollment).digest("hex"),
      },
    });
    check(
      grant?.consumedAt &&
        previous.records.root === p.root.recordSha256 &&
        guardianDigest(previous.identities.root) === guardianDigest(p.root.old),
    );
    check(
      claims.lifetimeId === previous.currentVolume.lifetimeId &&
        claims.buildId === previous.currentVolume.buildId &&
        grant.bindingDigest === guardianDigest(claims),
    );
    check(
      Object.keys(previous.records.projects).every((id) =>
        p.projects.some((row) => row.repositoryId === id),
      ),
    );
    oldVolume = previous.currentVolume.volume;
  }
  for (const row of p.projects) {
    const claims = emptyRootCleanupHistorySchema.parse(
        decode(row.cleanupToken, "hive-project-cleanup-v1", publicKeyPem),
      ),
      receipt = row.cleanupReceipt;
    check(
      claims.schemaVersion === 1 &&
        claims.purpose === "managed-checkout-cleanup" &&
        claims.hiveUserId === binding.hiveUserId &&
        claims.ownerId === binding.ownerId &&
        claims.workspaceId === binding.workspaceId &&
        claims.binding.repositoryId === row.repositoryId &&
        claims.authorizationId === receipt.authorizationId &&
        claims.binding.cleanupRequestId === receipt.cleanupRequestId &&
        guardianDigest(claims) === receipt.authorizationDigest &&
        guardianDigest(claims.binding) === receipt.bindingDigest &&
        guardianDigest(claims.currentVolume) === receipt.currentVolumeDigest,
    );
    const events = await db.deliveryEvent.findMany({
      where: {
        ownerId: binding.hiveUserId,
        type: { in: ["checkout_cleanup_authorized", "checkout_cleanup_completed"] },
        payload: { path: ["authorizationId"], equals: receipt.authorizationId },
      },
      take: 3,
    });
    check(events.length === 2);
    const authorized = events.find((e) => e.type === "checkout_cleanup_authorized"),
      completed = events.find((e) => e.type === "checkout_cleanup_completed");
    check(
      authorized &&
        completed &&
        authorized.taskId === claims.deliveryTaskId &&
        completed.taskId === claims.deliveryTaskId &&
        authorized.requestDigest === guardianDigest(claims) &&
        guardianDigest(authorized.payload) === guardianDigest(claims) &&
        completed.requestDigest === guardianDigest(receipt) &&
        guardianDigest(completed.payload) === guardianDigest(receipt),
    );
    if (previous && previous.records.projects[row.repositoryId] === row.recordSha256)
      check(
        guardianDigest(previous.identities.projects[row.repositoryId]) === guardianDigest(row.old),
      );
    else
      check(
        receipt.recordDigests.root === p.root.recordSha256 &&
          receipt.recordDigests.project === row.recordSha256 &&
          guardianDigest(claims.binding.rootIdentity) === guardianDigest(p.root.old) &&
          guardianDigest(claims.binding.projectIdentity) === guardianDigest(row.old),
      );
    if (oldVolume) check(guardianDigest(oldVolume) === guardianDigest(claims.currentVolume.volume));
    else oldVolume = claims.currentVolume.volume;
    check(
      row.old.device === p.root.old.device &&
        row.current.device === p.root.current.device &&
        row.old.inode === row.current.inode,
    );
  }
  check(
    (oldVolume || p.mode === "initial-current") &&
      guardianDigest(oldVolume ?? current.volume) === guardianDigest(current.volume) &&
      p.root.old.inode === p.root.current.inode,
  );
  return emptyRootAnchorSchema.parse({
    schemaVersion: 1,
    purpose: "empty-managed-root",
    proposalDigest: guardianDigest(p),
    currentVolume: current,
    records: {
      root: p.root.newRecordSha256,
      projects: Object.fromEntries(
        p.projects.map((row) => [row.repositoryId, row.newRecordSha256]),
      ),
    },
    identities: {
      root: p.root.current,
      projects: Object.fromEntries(p.projects.map((row) => [row.repositoryId, row.current])),
    },
  });
}
