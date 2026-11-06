import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import { type ReleaseActionIdentity, releaseActionIdentitySchema } from "./release-action-journal";
import { PostgresReleaseEffectJournal } from "./release-effect-journal.server";
import {
  verifyNativeBuilder,
  verifyNativePublisher,
} from "./release-native-preview-authority.server";
import {
  type NativeArtifact,
  nativeArtifactSchema,
  nativeBootstrapEnrollmentSchema,
  nativeDigest,
  nativePublicationGrantSchema,
  nativePublicationReceiptSchema,
  nativePublicationRequestSchema,
  nativePublisherIdentitySchema,
  nativeReleaseSnapshotSchema,
} from "./release-native-preview-contracts";

type Tx = Prisma.TransactionClient;
const uuid = z.string().uuid();
const grantInput = z
  .object({ actionId: uuid, ownerId: uuid, publisher: nativePublisherIdentitySchema })
  .strict();
export type NativeStoreConfiguration = {
  target: unknown;
  builderPolicy: unknown;
  publisherPolicy: unknown;
  publicConfig: unknown;
  privateBindingRevision: string;
  compatibilityRevision: string;
  bootstrap?: unknown;
};
const deny = (): never => {
  throw Error("native_publication_held");
};
/** Immutable authority facts augment the EXISTING release/action journal. The
 * controller/DB are operator-trusted. No write-provider token belongs here. */
export class NativePreviewPublicationStore {
  constructor(
    private readonly db: PrismaClient,
    readonly config: NativeStoreConfiguration,
    private readonly githubReadToken: string,
    private readonly authorize: (tx: Tx, identity: ReleaseActionIdentity) => Promise<boolean>,
    private readonly verifyArtifactRelease: (tx: Tx, manifest: NativeArtifact) => Promise<boolean>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async transaction<T>(fn: (tx: Tx) => Promise<T>) {
    for (let attempt = 0; ; attempt++)
      try {
        return await this.db.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 10000,
        });
      } catch (error) {
        if (attempt >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
  }
  private async now(tx: Tx) {
    return (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime();
  }
  private journal(ownerId: string) {
    return new PostgresReleaseEffectJournal(this.db, ownerId, this.authorize);
  }
  async submitArtifact(raw: unknown, token: string, signal: AbortSignal) {
    const manifest = nativeArtifactSchema.parse(raw),
      publisher = await verifyNativePublisher(
        manifest,
        token,
        "artifact",
        this.config.publisherPolicy,
        Date.now(),
        signal,
        this.fetcher,
      );
    const builder = await verifyNativeBuilder(
      manifest,
      this.config.builderPolicy,
      this.githubReadToken,
      signal,
      this.fetcher,
    );
    signal.throwIfAborted();
    if (
      manifest.targetDigest !== nativeDigest(this.config.target) ||
      nativeDigest(manifest.publicConfig) !== nativeDigest(this.config.publicConfig) ||
      manifest.privateBindingRevision !== this.config.privateBindingRevision ||
      manifest.compatibilityRevision !== this.config.compatibilityRevision
    )
      return deny();
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          owner_id: string;
          target_digest: string;
          active_release_id: string | null;
          phase: string;
        }[]
      >`SELECT r.owner_id,r.target_digest,t.active_release_id,r.phase FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.id=${manifest.releaseId}::uuid FOR UPDATE OF t,r`;
      const row = rows[0];
      if (
        !row ||
        row.owner_id !== manifest.ownerId ||
        row.target_digest !== manifest.targetDigest ||
        row.active_release_id !== manifest.releaseId ||
        row.phase !== "active" ||
        !(await this.verifyArtifactRelease(tx, manifest))
      )
        return deny();
      const merges = await tx.$queryRaw<
        { receipt: Record<string, unknown> }[]
      >`SELECT receipt FROM delivery_release_actions WHERE release_id=${manifest.releaseId}::uuid AND kind='merge' AND phase='observed'`;
      if (
        !this.bootstrapMatches(manifest) &&
        (merges.length !== 1 ||
          merges[0].receipt.provider !== "github" ||
          merges[0].receipt.mergeSha !== manifest.sourceSha)
      )
        return deny();
      const previous = await tx.$queryRaw<
        { manifest_digest: string }[]
      >`SELECT manifest_digest FROM delivery_native_release_artifacts WHERE id=${manifest.id}::uuid`;
      if (previous.length) {
        if (previous[0].manifest_digest !== nativeDigest(manifest)) return deny();
        return { artifactId: manifest.id, replay: true };
      }
      await tx.$executeRaw`INSERT INTO delivery_native_release_artifacts(id,owner_id,release_id,target_digest,manifest,manifest_digest,builder_evidence,publisher_identity) VALUES (${manifest.id}::uuid,${manifest.ownerId}::uuid,${manifest.releaseId}::uuid,${manifest.targetDigest},${canonicalGitHubSource(manifest)}::jsonb,${nativeDigest(manifest)},${canonicalGitHubSource(builder)}::jsonb,${canonicalGitHubSource(publisher.publisher)}::jsonb)`;
      signal.throwIfAborted();
      if ((await this.now(tx)) >= Math.min(builder.expiresAt, publisher.expiresAt)) return deny();
      return { artifactId: manifest.id, replay: false };
    });
  }
  async artifact(ownerId: string, id: string) {
    uuid.parse(ownerId);
    uuid.parse(id);
    const rows = await this.db.$queryRaw<
      { manifest: unknown; manifest_digest: string }[]
    >`SELECT manifest,manifest_digest FROM delivery_native_release_artifacts WHERE owner_id=${ownerId}::uuid AND id=${id}::uuid`;
    if (rows.length !== 1 || nativeDigest(rows[0].manifest) !== rows[0].manifest_digest)
      return deny();
    return nativeArtifactSchema.parse(rows[0].manifest);
  }
  /** The sole first-execution grant. A replay does NOT return the old grant;
   * response loss is uncertainty and never permission to execute another POST. */
  async grant(raw: unknown, token: string, signal: AbortSignal) {
    const input = grantInput.parse(raw),
      publisher = await verifyNativePublisher(
        input,
        token,
        "grant",
        this.config.publisherPolicy,
        Date.now(),
        signal,
        this.fetcher,
      );
    if (nativeDigest(input.publisher) !== nativeDigest(publisher.publisher)) return deny();
    const pending = await this.db.$queryRaw<
      { request: unknown }[]
    >`SELECT a.request FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id WHERE a.id=${input.actionId}::uuid AND r.owner_id=${input.ownerId}::uuid`;
    if (pending.length !== 1) return deny();
    const request = nativePublicationRequestSchema.parse(pending[0].request),
      artifact = await this.artifact(input.ownerId, request.artifactId);
    const builder = await verifyNativeBuilder(
      artifact,
      this.config.builderPolicy,
      this.githubReadToken,
      signal,
      this.fetcher,
    );
    return this.transaction(async (tx) => {
      const existing = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_native_publication_grants WHERE action_id=${input.actionId}::uuid`;
      if (existing.length) return deny();
      const identity = await this.journal(input.ownerId).beginInTransaction(tx, input.actionId);
      if (
        !identity ||
        nativeDigest(identity.request) !== nativeDigest(request) ||
        identity.targetDigest !== nativeDigest(this.config.target)
      )
        return deny();
      if (
        artifact.ownerId !== input.ownerId ||
        artifact.targetDigest !== identity.targetDigest ||
        nativeDigest(artifact.publicConfig) !== request.publicConfigDigest ||
        artifact.sourceSha !== request.sourceSha ||
        artifact.artifactDigest !== request.artifactDigest ||
        artifact.privateBindingRevision !== request.privateBindingRevision ||
        artifact.privateBindingRevision !== this.config.privateBindingRevision ||
        artifact.compatibilityRevision !== request.compatibilityRevision ||
        artifact.compatibilityRevision !== this.config.compatibilityRevision
      )
        return deny();
      const now = await this.now(tx),
        expiresAt = Math.min(
          now + 120000,
          publisher.expiresAt,
          builder.expiresAt,
          request.purpose === "bootstrap-baseline"
            ? nativeBootstrapEnrollmentSchema.parse(this.config.bootstrap).expiresAt
            : Infinity,
        );
      if (expiresAt <= now) return deny();
      const grant = nativePublicationGrantSchema.parse({
        schemaVersion: 1,
        provider: "cloudflare-native-preview",
        id: randomUUID(),
        purpose: request.purpose,
        issuedAt: now,
        actionId: identity.id,
        releaseId: identity.releaseId,
        ownerId: input.ownerId,
        generation: identity.generation,
        requestDigest: identity.requestDigest,
        target: this.config.target,
        artifact,
        publisher: publisher.publisher,
        expectedCurrentDeploymentId: request.expectedCurrentDeploymentId,
        expiresAt,
      });
      await tx.$executeRaw`INSERT INTO delivery_native_publication_grants(id,action_id,artifact_id,grant_data,grant_digest,expires_at) VALUES (${grant.id}::uuid,${identity.id}::uuid,${artifact.id}::uuid,${canonicalGitHubSource(grant)}::jsonb,${nativeDigest(grant)},${new Date(expiresAt)})`;
      signal.throwIfAborted();
      if ((await this.now(tx)) >= expiresAt) return deny();
      return grant;
    });
  }
  /** Persist the authenticated returned-ID receipt BEFORE any CF readback. This
   * records an effect observation even if pause/revocation now blocks authority
   * to ACK it. Recording to the main journal reauthorizes separately afterward. */
  async receipt(raw: unknown, token: string, signal: AbortSignal) {
    const receipt = nativePublicationReceiptSchema.parse(raw),
      publisher = await verifyNativePublisher(
        receipt,
        token,
        "receipt",
        this.config.publisherPolicy,
        Date.now(),
        signal,
        this.fetcher,
      );
    if (nativeDigest(publisher.publisher) !== nativeDigest(receipt.publisher)) return deny();
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { grant_data: unknown; grant_digest: string }[]
      >`SELECT g.grant_data,g.grant_digest FROM delivery_native_publication_grants g JOIN delivery_release_actions a ON a.id=g.action_id JOIN delivery_releases r ON r.id=a.release_id JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE g.id=${receipt.grantId}::uuid AND a.id=${receipt.actionId}::uuid FOR UPDATE OF t,r,a`;
      if (rows.length !== 1 || nativeDigest(rows[0].grant_data) !== rows[0].grant_digest)
        return deny();
      const grant = nativePublicationGrantSchema.parse(rows[0].grant_data),
        a = grant.artifact;
      if (
        grant.actionId !== receipt.actionId ||
        grant.requestDigest !== receipt.requestDigest ||
        grant.target.previewId !== receipt.previewId ||
        nativeDigest(grant.publisher) !== nativeDigest(receipt.publisher) ||
        a.sourceSha !== receipt.sourceSha ||
        a.artifactDigest !== receipt.artifactDigest ||
        nativeDigest(a.publicConfig) !== receipt.publicConfigDigest ||
        a.archiveDigest !== receipt.archiveDigest ||
        a.moduleManifestDigest !== receipt.moduleManifestDigest ||
        a.assetsManifestDigest !== receipt.assetsManifestDigest
      )
        return deny();
      const previous = await tx.$queryRaw<
        { receipt_digest: string }[]
      >`SELECT receipt_digest FROM delivery_native_publication_receipts WHERE action_id=${receipt.actionId}::uuid`;
      if (previous.length) {
        if (previous[0].receipt_digest !== nativeDigest(receipt)) return deny();
        return { stored: true, receiptDigest: nativeDigest(receipt), replay: true };
      }
      await tx.$executeRaw`INSERT INTO delivery_native_publication_receipts(action_id,grant_id,receipt,receipt_digest,publisher_identity) VALUES (${receipt.actionId}::uuid,${receipt.grantId}::uuid,${canonicalGitHubSource(receipt)}::jsonb,${nativeDigest(receipt)},${canonicalGitHubSource(publisher.publisher)}::jsonb)`;
      signal.throwIfAborted();
      if ((await this.now(tx)) >= publisher.expiresAt) return deny();
      return { stored: true, receiptDigest: nativeDigest(receipt), replay: false };
    });
  }
  bootstrapMatches(artifact: NativeArtifact) {
    const configured = nativeBootstrapEnrollmentSchema.safeParse(this.config.bootstrap);
    if (!configured.success) return false;
    const b = configured.data;
    return (
      b.ownerId === artifact.ownerId &&
      b.releaseId === artifact.releaseId &&
      b.artifactId === artifact.id &&
      b.sourceSha === artifact.sourceSha &&
      b.artifactDigest === artifact.artifactDigest &&
      b.archiveDigest === artifact.archiveDigest &&
      b.publicConfigDigest === nativeDigest(artifact.publicConfig) &&
      b.expiresAt > Date.now()
    );
  }
  async verifyPreparation(
    tx: Tx,
    ownerId: string,
    identity: ReleaseActionIdentity,
    rawSnapshot: unknown,
    completed: {
      id: string;
      kind: string;
      request: Record<string, unknown>;
      receipt: Record<string, unknown>;
    }[],
  ) {
    try {
      completed = completed.filter((action) => action.id !== identity.id);
      const snapshot = nativeReleaseSnapshotSchema.parse(
        (rawSnapshot as { native?: unknown }).native,
      );
      const request = nativePublicationRequestSchema.parse(identity.request);
      if (
        nativeDigest(snapshot.target) !== identity.targetDigest ||
        identity.targetDigest !== nativeDigest(this.config.target) ||
        nativeDigest(snapshot.recoveryBaseline) !== nativeDigest(request.recoveryBaseline) ||
        (identity.kind === "recover") !== (request.purpose === "recover")
      )
        return false;
      const rows = await tx.$queryRaw<
        { manifest: unknown; manifest_digest: string }[]
      >`SELECT manifest,manifest_digest FROM delivery_native_release_artifacts WHERE id=${request.artifactId}::uuid AND owner_id=${ownerId}::uuid AND target_digest=${identity.targetDigest}`;
      if (rows.length !== 1 || nativeDigest(rows[0].manifest) !== rows[0].manifest_digest)
        return false;
      const artifact = nativeArtifactSchema.parse(rows[0].manifest);
      if (
        artifact.sourceSha !== request.sourceSha ||
        artifact.artifactDigest !== request.artifactDigest ||
        nativeDigest(artifact.publicConfig) !== request.publicConfigDigest ||
        artifact.privateBindingRevision !== request.privateBindingRevision ||
        artifact.compatibilityRevision !== request.compatibilityRevision ||
        request.privateBindingRevision !== this.config.privateBindingRevision ||
        request.compatibilityRevision !== this.config.compatibilityRevision
      )
        return false;
      if (request.purpose === "bootstrap-baseline") {
        if (
          identity.kind !== "promote" ||
          snapshot.purpose !== "bootstrap-baseline" ||
          !this.bootstrapMatches(artifact)
        )
          return false;
        const accepted = await tx.$queryRaw<
          { observation_digest: string }[]
        >`SELECT observation_digest FROM delivery_native_release_baselines WHERE target_digest=${identity.targetDigest} LIMIT 1`;
        return accepted.length === 0;
      }
      if (snapshot.purpose !== "publication" || !request.recoveryBaseline) return false;
      const b = request.recoveryBaseline;
      const baselines = await tx.$queryRaw<
        { manifest: unknown; manifest_digest: string; evidence: unknown }[]
      >`SELECT a.manifest,a.manifest_digest,b.evidence FROM delivery_native_release_baselines b JOIN delivery_native_release_artifacts a ON a.id=b.artifact_id WHERE b.observation_digest=${b.healthyObservationDigest} AND b.owner_id=${ownerId}::uuid AND b.target_digest=${identity.targetDigest} AND b.artifact_id=${b.artifactId}::uuid`;
      if (
        baselines.length !== 1 ||
        nativeDigest(baselines[0].manifest) !== baselines[0].manifest_digest
      )
        return false;
      const baselineArtifact = nativeArtifactSchema.parse(baselines[0].manifest);
      if (
        baselineArtifact.sourceSha !== b.sourceSha ||
        baselineArtifact.artifactDigest !== b.artifactDigest ||
        nativeDigest(baselineArtifact.publicConfig) !== b.publicConfigDigest ||
        baselineArtifact.privateBindingRevision !== b.privateBindingRevision ||
        baselineArtifact.compatibilityRevision !== b.compatibilityRevision ||
        b.privateBindingRevision !== this.config.privateBindingRevision ||
        b.compatibilityRevision !== this.config.compatibilityRevision
      )
        return false;
      if (identity.kind === "promote") {
        const merges = completed.filter(
          (a) => a.kind === "merge" && a.receipt.provider === "github",
        );
        return (
          artifact.releaseId === identity.releaseId &&
          merges.length === 1 &&
          merges[0].receipt.mergeSha === artifact.sourceSha &&
          !completed.some((a) => a.kind === "promote")
        );
      }
      const promotions = completed.filter(
        (a) => a.kind === "promote" && a.request.provider === "cloudflare-native-preview",
      );
      return (
        request.artifactId === b.artifactId &&
        promotions.length === 1 &&
        promotions[0].receipt.deploymentId === request.expectedCurrentDeploymentId &&
        !completed.some((a) => a.kind === "recover")
      );
    } catch {
      return false;
    }
  }
  async reauthorize(raw: unknown, token: string, signal: AbortSignal) {
    const input = grantInput.extend({ grantId: uuid }).parse(raw),
      publisher = await verifyNativePublisher(
        input,
        token,
        "reauthorize",
        this.config.publisherPolicy,
        Date.now(),
        signal,
        this.fetcher,
      );
    if (nativeDigest(input.publisher) !== nativeDigest(publisher.publisher)) return deny();
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          grant_data: unknown;
          grant_digest: string;
          phase: string;
          release_id: string;
          release_phase: string;
          active_release_id: string | null;
          target_generation: number;
          generation: number;
          target_digest: string;
          request_digest: string;
        }[]
      >`SELECT g.grant_data,g.grant_digest,a.phase,a.release_id,r.phase AS release_phase,t.active_release_id,t.generation AS target_generation,a.generation,a.target_digest,a.request_digest FROM delivery_native_publication_grants g JOIN delivery_release_actions a ON a.id=g.action_id JOIN delivery_releases r ON r.id=a.release_id JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE g.id=${input.grantId}::uuid AND a.id=${input.actionId}::uuid AND r.owner_id=${input.ownerId}::uuid FOR UPDATE OF t,r,a`;
      if (
        rows.length !== 1 ||
        rows[0].phase !== "effect_started" ||
        nativeDigest(rows[0].grant_data) !== rows[0].grant_digest
      )
        return deny();
      const grant = nativePublicationGrantSchema.parse(rows[0].grant_data);
      const receipt = await tx.$queryRaw<
        { action_id: string }[]
      >`SELECT action_id FROM delivery_native_publication_receipts WHERE action_id=${input.actionId}::uuid`;
      const action = await tx.$queryRaw<
        {
          request: Record<string, unknown>;
          kind: string;
          target_digest: string;
          generation: number;
        }[]
      >`SELECT request,kind,target_digest,generation FROM delivery_release_actions WHERE id=${input.actionId}::uuid`;
      if (
        receipt.length ||
        action.length !== 1 ||
        nativeDigest(grant.publisher) !== nativeDigest(publisher.publisher) ||
        grant.ownerId !== input.ownerId ||
        grant.actionId !== input.actionId ||
        grant.releaseId !== rows[0].release_id ||
        grant.releaseId !== rows[0].active_release_id ||
        grant.generation !== rows[0].generation ||
        grant.generation !== rows[0].target_generation ||
        grant.requestDigest !== rows[0].request_digest ||
        nativeDigest(action[0].request) !== grant.requestDigest ||
        nativeDigest(grant.target) !== rows[0].target_digest ||
        rows[0].release_phase !== (action[0].kind === "recover" ? "held" : "active")
      )
        return deny();
      const identity = releaseActionIdentitySchema.parse({
        id: input.actionId,
        releaseId: grant.releaseId,
        kind: action[0].kind,
        targetDigest: action[0].target_digest,
        request: action[0].request,
        requestDigest: grant.requestDigest,
        generation: action[0].generation,
      });
      if (!(await this.authorize(tx, identity))) return deny();
      signal.throwIfAborted();
      if ((await this.now(tx)) >= Math.min(grant.expiresAt, publisher.expiresAt)) return deny();
      return { authorized: true, grantDigest: rows[0].grant_digest };
    });
  }
  async resolveBaseline() {
    const rows = await this.db.$queryRaw<
      { manifest: unknown; manifest_digest: string; observation_digest: string }[]
    >`SELECT a.manifest,a.manifest_digest,b.observation_digest FROM delivery_native_release_baselines b JOIN delivery_native_release_artifacts a ON a.id=b.artifact_id WHERE b.target_digest=${nativeDigest(this.config.target)} ORDER BY b.created_at DESC,b.observation_digest DESC LIMIT 1`;
    if (rows.length !== 1 || nativeDigest(rows[0].manifest) !== rows[0].manifest_digest)
      return deny();
    const a = nativeArtifactSchema.parse(rows[0].manifest);
    if (
      a.privateBindingRevision !== this.config.privateBindingRevision ||
      a.compatibilityRevision !== this.config.compatibilityRevision
    )
      return deny();
    return {
      provider: "cloudflare-native-preview" as const,
      artifactId: a.id,
      sourceSha: a.sourceSha,
      artifactDigest: a.artifactDigest,
      publicConfigDigest: nativeDigest(a.publicConfig),
      privateBindingRevision: a.privateBindingRevision,
      compatibilityRevision: a.compatibilityRevision,
      healthyObservationDigest: rows[0].observation_digest,
    };
  }
  async recordBaseline(
    tx: Tx,
    ownerId: string,
    releaseId: string,
    evidence: Record<string, unknown>,
    evidenceDigest: string,
  ) {
    if (
      evidence.provider !== "cloudflare-native-preview" ||
      evidence.scope !== "sampled-health-no-atomic-exclusion" ||
      evidence.smoke !== "passed" ||
      evidence.metrics !== "sampled-only" ||
      !Array.isArray(evidence.samples) ||
      evidence.samples.length < 2
    )
      return deny();
    const rows = await tx.$queryRaw<
      { manifest: unknown; manifest_digest: string; request: unknown; receipt: unknown }[]
    >`SELECT a.manifest,a.manifest_digest,x.request,x.receipt FROM delivery_release_actions x JOIN delivery_native_publication_grants g ON g.action_id=x.id JOIN delivery_native_release_artifacts a ON a.id=g.artifact_id WHERE x.id=${String(evidence.actionId)}::uuid AND x.release_id=${releaseId}::uuid AND x.phase='observed' AND a.owner_id=${ownerId}::uuid`;
    if (rows.length !== 1 || nativeDigest(rows[0].manifest) !== rows[0].manifest_digest)
      return deny();
    const a = nativeArtifactSchema.parse(rows[0].manifest),
      request = nativePublicationRequestSchema.parse(rows[0].request);
    if (
      a.id !== evidence.artifactId ||
      a.sourceSha !== evidence.sourceSha ||
      a.artifactDigest !== evidence.artifactDigest ||
      request.publicConfigDigest !== evidence.publicConfigDigest ||
      a.privateBindingRevision !== this.config.privateBindingRevision ||
      a.compatibilityRevision !== this.config.compatibilityRevision
    )
      return deny();
    await tx.$executeRaw`INSERT INTO delivery_native_release_baselines(observation_digest,artifact_id,action_id,owner_id,target_digest,evidence) VALUES (${evidenceDigest},${a.id}::uuid,${String(evidence.actionId)}::uuid,${ownerId}::uuid,${a.targetDigest},${canonicalGitHubSource(evidence)}::jsonb)`;
  }
  async observedPublication(ownerId: string, releaseId: string, kind: "promote" | "recover") {
    const rows = await this.db.$queryRaw<
      {
        id: string;
        request: unknown;
        request_digest: string;
        generation: number;
        target_digest: string;
        receipt: unknown;
        receipt_digest: string;
        grant_data: unknown;
        grant_digest: string;
        publication_receipt: unknown;
        publication_receipt_digest: string;
      }[]
    >`SELECT a.id,a.request,a.request_digest,a.generation,a.target_digest,a.receipt,a.receipt_digest,g.grant_data,g.grant_digest,p.receipt AS publication_receipt,p.receipt_digest AS publication_receipt_digest FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id JOIN delivery_native_publication_grants g ON g.action_id=a.id JOIN delivery_native_publication_receipts p ON p.action_id=a.id WHERE a.release_id=${releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND a.kind=${kind} AND a.phase='observed'`;
    if (rows.length !== 1) return null;
    const r = rows[0];
    if (
      nativeDigest(r.request) !== r.request_digest ||
      nativeDigest(r.receipt) !== r.receipt_digest ||
      nativeDigest(r.grant_data) !== r.grant_digest ||
      nativeDigest(r.publication_receipt) !== r.publication_receipt_digest
    )
      return null;
    return {
      identity: releaseActionIdentitySchema.parse({
        id: r.id,
        releaseId,
        kind,
        request: r.request,
        requestDigest: r.request_digest,
        generation: r.generation,
        targetDigest: r.target_digest,
      }),
      grant: nativePublicationGrantSchema.parse(r.grant_data),
      receipt: nativePublicationReceiptSchema.parse(r.publication_receipt),
    };
  }
  async holdUnacknowledged(ownerId: string, actionId: string) {
    const rows = await this.db.$queryRaw<
      {
        release_id: string;
        kind: string;
        target_digest: string;
        request: Record<string, unknown>;
        request_digest: string;
        generation: number;
      }[]
    >`SELECT a.release_id,a.kind,a.target_digest,a.request,a.request_digest,a.generation FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id WHERE a.id=${actionId}::uuid AND r.owner_id=${ownerId}::uuid AND a.phase IN ('effect_started','held')`;
    if (rows.length !== 1) return;
    const row = rows[0];
    await this.journal(ownerId).hold(
      releaseActionIdentitySchema.parse({
        id: actionId,
        releaseId: row.release_id,
        kind: row.kind,
        targetDigest: row.target_digest,
        request: row.request,
        requestDigest: row.request_digest,
        generation: row.generation,
      }),
    );
  }
  async pendingReceipt(ownerId: string, actionId: string) {
    const authorized = await this.journal(ownerId).reconciliation(actionId);
    if (!authorized) return null;
    const rows = await this.db.$queryRaw<
      { receipt: unknown; receipt_digest: string; grant_data: unknown; grant_digest: string }[]
    >`SELECT r.receipt,r.receipt_digest,g.grant_data,g.grant_digest FROM delivery_native_publication_receipts r JOIN delivery_native_publication_grants g ON g.id=r.grant_id WHERE r.action_id=${actionId}::uuid`;
    if (
      rows.length !== 1 ||
      nativeDigest(rows[0].receipt) !== rows[0].receipt_digest ||
      nativeDigest(rows[0].grant_data) !== rows[0].grant_digest
    )
      return null;
    return {
      identity: authorized.identity,
      receipt: nativePublicationReceiptSchema.parse(rows[0].receipt),
      grant: nativePublicationGrantSchema.parse(rows[0].grant_data),
    };
  }
  async record(ownerId: string, identity: ReleaseActionIdentity, receipt: Record<string, unknown>) {
    return this.journal(ownerId).record(identity, {
      requestDigest: identity.requestDigest,
      receiptDigest: githubSourceDigest(receipt),
      evidence: receipt,
    });
  }
  async hold(ownerId: string, identity: ReleaseActionIdentity) {
    return this.journal(ownerId).hold(identity);
  }
}
