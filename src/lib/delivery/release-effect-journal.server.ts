import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import { type ReleaseActionIdentity, releaseActionIdentitySchema } from "./release-action-journal";
import type { ReleaseEffectJournal, ReleaseEffectReceipt } from "./release-effect-runner.server";
import { appendReleaseNotice } from "./release-notice.server";

const uuid = z.string().uuid();
type Tx = Prisma.TransactionClient;
type Row = {
  id: string;
  release_id: string;
  owner_id: string;
  task_id: string;
  kind: string;
  target_digest: string;
  request: Record<string, unknown>;
  request_digest: string;
  remote_reference: Record<string, unknown> | null;
  generation: number;
  phase: string;
  release_phase: string;
  active_release_id: string | null;
  target_generation: number;
};

/** Internal seam only. The deployment-owned authorizer must revalidate locked
 * policy enrollment, task/source/evidence, release snapshot, target, pause and
 * risk before dispatch/acknowledgement. No API route or provider is installed. */
export class PostgresReleaseEffectJournal implements ReleaseEffectJournal {
  constructor(
    private readonly db: PrismaClient,
    private readonly ownerId: string,
    private readonly authorize: (tx: Tx, identity: ReleaseActionIdentity) => Promise<boolean>,
  ) {
    uuid.parse(ownerId);
  }
  private async transaction<T>(run: (tx: Tx) => Promise<T>) {
    for (let retry = 0; ; retry++) {
      try {
        return await this.db.$transaction(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 10000,
        });
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
    }
  }
  private async locked(tx: Tx, actionId: string): Promise<Row | null> {
    uuid.parse(actionId);
    const rows = await tx.$queryRaw<
      Row[]
    >`SELECT a.id,a.release_id,r.owner_id,r.task_id,a.kind,a.target_digest,a.request,a.request_digest,a.remote_reference,a.generation,a.phase,r.phase AS release_phase,t.active_release_id,t.generation AS target_generation
      FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id
      JOIN delivery_release_targets t ON t.target_digest=a.target_digest
      WHERE a.id=${actionId}::uuid AND r.owner_id=${this.ownerId}::uuid FOR UPDATE OF t,r,a`;
    return rows[0] ?? null;
  }
  private identity(row: Row): ReleaseActionIdentity {
    return releaseActionIdentitySchema.parse({
      id: row.id,
      releaseId: row.release_id,
      kind: row.kind,
      targetDigest: row.target_digest,
      request: row.request,
      requestDigest: row.request_digest,
      generation: row.generation,
    });
  }
  private fenced(row: Row) {
    return (
      row.active_release_id === row.release_id &&
      row.target_generation === row.generation &&
      (row.kind === "recover" ? row.release_phase === "held" : row.release_phase === "active")
    );
  }
  private matches(row: Row, identity: ReleaseActionIdentity) {
    return (
      canonicalGitHubSource(this.identity(row)) ===
      canonicalGitHubSource(releaseActionIdentitySchema.parse(identity))
    );
  }
  /** Native publication grants append their immutable authorization in the
   * SAME caller transaction as this existing journal transition. */
  async beginInTransaction(tx: Tx, actionId: string) {
    const row = await this.locked(tx, actionId);
    if (!row || row.phase !== "prepared" || !this.fenced(row)) return null;
    const identity = this.identity(row);
    if (!(await this.authorize(tx, identity))) return null;
    await tx.$executeRaw`UPDATE delivery_release_actions SET phase='effect_started',updated_at=clock_timestamp() WHERE id=${identity.id}::uuid`;
    return identity;
  }
  async begin(actionId: string) {
    return this.transaction((tx) => this.beginInTransaction(tx, actionId));
  }
  async reconciliation(actionId: string) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, actionId);
      if (!row || !["effect_started", "held"].includes(row.phase) || !this.fenced(row)) return null;
      const identity = this.identity(row);
      return (await this.authorize(tx, identity))
        ? { identity, reference: row.remote_reference }
        : null;
    });
  }
  async hold(identity: ReleaseActionIdentity, reference?: Record<string, unknown>) {
    const encoded = reference === undefined ? null : canonicalGitHubSource(reference);
    if (encoded !== null && Buffer.byteLength(encoded) > 4096)
      throw new Error("release_reference_invalid");
    await this.transaction(async (tx) => {
      const row = await this.locked(tx, identity.id);
      if (!row || !this.matches(row, identity)) throw new Error("release_action_identity_mismatch");
      if (row.phase === "effect_started") {
        await tx.$executeRaw`UPDATE delivery_release_actions SET phase='held',remote_reference=${encoded}::jsonb,updated_at=clock_timestamp() WHERE id=${identity.id}::uuid`;
        if (encoded === null)
          await appendReleaseNotice(tx, {
            ownerId: row.owner_id,
            taskId: row.task_id,
            releaseId: row.release_id,
            aggregateKey: `release-action:${row.id}`,
            aggregateVersion: 1,
            type: "release_action_held",
          });
      } else if (!["held", "observed"].includes(row.phase))
        throw new Error("release_action_transition_denied");
      else if (encoded !== null && canonicalGitHubSource(row.remote_reference) !== encoded)
        throw new Error("release_reference_mismatch");
    });
  }
  async record(identity: ReleaseActionIdentity, receipt: ReleaseEffectReceipt) {
    if (
      receipt.requestDigest !== identity.requestDigest ||
      !/^[a-f0-9]{64}$/.test(receipt.receiptDigest) ||
      Buffer.byteLength(canonicalGitHubSource(receipt.evidence)) > 32768 ||
      githubSourceDigest(receipt.evidence) !== receipt.receiptDigest
    )
      return false;
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, identity.id);
      if (
        !row ||
        !this.matches(row, identity) ||
        !this.fenced(row) ||
        !["effect_started", "held"].includes(row.phase)
      )
        return false;
      if (!(await this.authorize(tx, identity))) return false;
      await tx.$executeRaw`UPDATE delivery_release_actions SET phase='observed',receipt_digest=${receipt.receiptDigest},receipt=${canonicalGitHubSource(receipt.evidence)}::jsonb,updated_at=clock_timestamp() WHERE id=${identity.id}::uuid`;
      return true;
    });
  }
}
