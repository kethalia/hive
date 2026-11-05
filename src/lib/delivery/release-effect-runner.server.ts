import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { type ReleaseActionIdentity, releaseActionIdentitySchema } from "./release-action-journal";

const receiptSchema = z
  .object({
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidence: z.record(z.unknown()),
  })
  .strict();
export type ReleaseEffectReceipt = z.infer<typeof receiptSchema>;

/** Methods run in their own transactions. begin atomically locks/revalidates
 * scope, enrollment, evidence, pause, target and live fence, then persists
 * effect_started. Only its winning caller gets an identity. Reconciliation
 * never grants dispatch. record must revalidate the identity and target fence;
 * a false return means the result lost authority and must not advance a release. */
export interface ReleaseEffectJournal {
  begin(actionId: string): Promise<ReleaseActionIdentity | null>;
  reconciliation(
    actionId: string,
  ): Promise<{ identity: ReleaseActionIdentity; reference: Record<string, unknown> | null } | null>;
  hold(identity: ReleaseActionIdentity, reference?: Record<string, unknown>): Promise<void>;
  record(identity: ReleaseActionIdentity, receipt: ReleaseEffectReceipt): Promise<boolean>;
}

/** Deployment-owned adapter with fixed endpoints/credentials. It must apply
 * the provider's available preconditions and verify exact scope and attribution.
 * Some providers lack atomic compare-and-swap; their residual external-writer
 * race must be explicitly accepted by policy. A desired state alone is not a
 * receipt. lookup is read-only and returns null for ambiguous evidence. */
export interface ReleaseEffectProvider {
  dispatch(identity: ReleaseActionIdentity, signal: AbortSignal): Promise<unknown>;
  lookup(
    identity: ReleaseActionIdentity,
    reference: Record<string, unknown> | null,
    signal: AbortSignal,
  ): Promise<unknown | null>;
}

export class ReleaseEffectRunner {
  constructor(
    private readonly journal: ReleaseEffectJournal,
    private readonly provider: ReleaseEffectProvider,
  ) {}
  private async record(identity: ReleaseActionIdentity, raw: unknown) {
    const receipt = receiptSchema.parse(raw);
    if (
      receipt.requestDigest !== identity.requestDigest ||
      Buffer.byteLength(canonicalGitHubSource(receipt.evidence)) > 32768 ||
      githubSourceDigest(receipt.evidence) !== receipt.receiptDigest
    )
      throw new Error("release_receipt_mismatch");
    if (await this.journal.record(identity, receipt)) return "observed";
    await this.journal.hold(identity);
    return "held";
  }
  async dispatch(
    actionId: string,
    signal: AbortSignal,
  ): Promise<"not_started" | "held" | "observed"> {
    const raw = await this.journal.begin(actionId);
    if (!raw) return "not_started";
    const identity = releaseActionIdentitySchema.parse(raw);
    if (identity.id !== actionId) throw new Error("release_action_identity_mismatch");
    // A crash, abort, malformed response or lost acknowledgement after begin is
    // uncertain even if the provider call was never reached. Never redispatch.
    try {
      if (signal.aborted) throw new Error("release_effect_aborted");
      const receipt = await this.provider.dispatch(identity, signal);
      const pending = z
        .object({ pending: z.literal(true), reference: z.record(z.unknown()) })
        .strict()
        .safeParse(receipt);
      if (pending.success) {
        if (Buffer.byteLength(canonicalGitHubSource(pending.data.reference)) > 4096)
          throw new Error("release_reference_invalid");
        await this.journal.hold(identity, pending.data.reference);
        return "held";
      }
      if (signal.aborted) throw new Error("release_effect_aborted");
      return await this.record(identity, receipt);
    } catch {
      await this.journal.hold(identity);
      return "held";
    }
  }
  async reconcile(
    actionId: string,
    signal: AbortSignal,
  ): Promise<"not_found" | "held" | "observed"> {
    const raw = await this.journal.reconciliation(actionId);
    if (!raw) return "not_found";
    const identity = releaseActionIdentitySchema.parse(raw.identity);
    if (identity.id !== actionId) throw new Error("release_action_identity_mismatch");
    try {
      if (signal.aborted) return "held";
      const receipt = await this.provider.lookup(identity, raw.reference, signal);
      if (!receipt || signal.aborted) return "held";
      return await this.record(identity, receipt);
    } catch {
      return "held";
    }
  }
}
