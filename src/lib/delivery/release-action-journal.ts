import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
const kind = z.enum(["merge", "promote", "recover", "database_job"]);

/** A provider effect is identified before dispatch. This projection is not an
 * authorization: the transactional caller must lock and revalidate current
 * release, policy, approval, target, fencing generation and provider scope. */
export const releaseActionIdentitySchema = z
  .object({
    id,
    releaseId: id,
    kind,
    targetDigest: digest,
    request: z.record(z.unknown()),
    requestDigest: digest,
    generation: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      if (
        Buffer.byteLength(canonicalGitHubSource(v.request)) > 32768 ||
        githubSourceDigest(v.request) !== v.requestDigest
      )
        ctx.addIssue({ code: "custom", message: "Release request digest mismatch" });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid release request" });
    }
  });
export type ReleaseActionIdentity = z.infer<typeof releaseActionIdentitySchema>;

export const releaseActionJournalSchema = z
  .object({
    identity: releaseActionIdentitySchema,
    phase: z.enum(["prepared", "effect_started", "held", "observed", "canceled"]),
    receiptDigest: digest.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.phase === "observed") !== (v.receiptDigest !== null))
      ctx.addIssue({ code: "custom", message: "Invalid release receipt state" });
  });
export type ReleaseActionJournal = z.infer<typeof releaseActionJournalSchema>;

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dispatch") }).strict(),
  z.object({ type: z.literal("unknown") }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("observed"), requestDigest: digest, receiptDigest: digest }).strict(),
]);

/** The DB transaction records effect_started before remote I/O. An uncertain
 * outcome cannot dispatch again, including after a restart or expired lease.
 * 'observed' is only for an independently authenticated, action-attributed
 * provider receipt; finding the desired remote state alone is insufficient.
 * State/identity immutability and concurrent fencing also require DB guards. */
export function transitionReleaseAction(raw: unknown, rawEvent: unknown): ReleaseActionJournal {
  const journal = releaseActionJournalSchema.parse(raw),
    event = eventSchema.parse(rawEvent);
  const fail = (): never => {
    throw new Error("release_action_transition_denied");
  };
  if (event.type === "dispatch") {
    if (journal.phase !== "prepared") return fail();
    return { ...journal, phase: "effect_started" };
  }
  if (event.type === "cancel") {
    if (journal.phase !== "prepared") return fail();
    return { ...journal, phase: "canceled" };
  }
  if (event.type === "unknown") {
    if (journal.phase === "held") return journal;
    if (journal.phase !== "effect_started") return fail();
    return { ...journal, phase: "held" };
  }
  if (event.requestDigest !== journal.identity.requestDigest) return fail();
  if (journal.phase === "observed") {
    if (journal.receiptDigest !== event.receiptDigest) return fail();
    return journal;
  }
  if (journal.phase !== "effect_started" && journal.phase !== "held") return fail();
  return { ...journal, phase: "observed", receiptDigest: event.receiptDigest };
}
