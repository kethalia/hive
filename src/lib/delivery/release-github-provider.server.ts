import { z } from "zod";
import { githubSourceDigest } from "./github-evidence.server";
import type { ReleaseActionIdentity } from "./release-action-journal";
import type { ReleaseEffectProvider } from "./release-effect-runner.server";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const branchBase = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/)
  .refine(
    (v) => !v.includes("..") && !v.includes("//") && !v.endsWith("/") && !v.endsWith(".lock"),
  );
export const githubReleaseRequestSchema = z
  .object({
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    pullRequestId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    pullNumber: z.number().int().positive().safe(),
    headSha: sha,
    baseSha: sha,
    baseRef: branchBase,
    rulesDigest: z.string().regex(/^[a-f0-9]{64}$/),
    method: z.enum(["merge", "squash", "rebase"]),
  })
  .strict();
const repoSchema = z
  .object({
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    allowedBaseRef: branchBase,
    mode: z.enum(["preview", "production"]).optional(),
    productionEnabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const mode = v.mode ?? "preview";
    if (
      (mode === "preview" && ["main", "master"].includes(v.allowedBaseRef.toLowerCase())) ||
      (mode === "production" && v.productionEnabled !== true)
    )
      ctx.addIssue({ code: "custom", message: "Release environment is not enabled" });
  });
type Request = z.infer<typeof githubReleaseRequestSchema>;

/** Dedicated fixed GitHub credential/endpoint. verifyBefore must freshly prove
 * repository/PR identities, head, tested base and effective strict branch rules;
 * GitHub's head precondition alone cannot atomically freeze the base. verifyMerged
 * must read back the exact attributed PR/merge result. Both are mandatory. */
export class GitHubReleaseProvider implements ReleaseEffectProvider {
  private readonly repository: z.infer<typeof repoSchema>;
  constructor(
    rawRepository: unknown,
    private readonly token: string,
    private readonly verifyBefore: (request: Request, signal: AbortSignal) => Promise<boolean>,
    private readonly verifyMerged: (
      request: Request,
      mergeSha: string,
      signal: AbortSignal,
    ) => Promise<boolean>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.repository = repoSchema.parse(rawRepository);
    if (!token || token.length > 4096) throw new Error("release_provider_unavailable");
  }
  private request(identity: ReleaseActionIdentity) {
    if (identity.kind !== "merge") throw new Error("release_provider_scope");
    const request = githubReleaseRequestSchema.parse(identity.request);
    if (
      request.repositoryId !== this.repository.repositoryId ||
      request.baseRef !== this.repository.allowedBaseRef
    )
      throw new Error("release_provider_scope");
    return request;
  }
  private async call(path: string, init: RequestInit, signal: AbortSignal) {
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.repository.owner}/${this.repository.name}/pulls/${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal,
      },
    );
    if (!response.body) throw new Error("release_provider_unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 1024 * 1024) throw new Error("release_provider_limit");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  }
  async dispatch(identity: ReleaseActionIdentity, signal: AbortSignal) {
    const request = this.request(identity);
    if (!(await this.verifyBefore(request, signal)) || signal.aborted)
      throw new Error("release_github_preflight_failed");
    const response = await this.call(
      `${request.pullNumber}/merge-async`,
      {
        method: "PUT",
        body: JSON.stringify({
          sha: request.headSha,
          merge_method: request.method,
          merge_action: "default",
          bypass_rules: false,
        }),
      },
      signal,
    );
    // 200 means already merged/enqueued and 409 means somebody else's pending
    // request; neither is attributable to this effect. No automatic adoption.
    if (response.status !== 202) throw new Error("release_github_uncertain");
    const pending = z
      .object({
        status: z.literal("pending"),
        details: z
          .object({
            uuid: z.string().uuid(),
            expected_head_sha: sha,
            bypass_rules: z.literal(false),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(response.body);
    if (pending.details.expected_head_sha !== request.headSha)
      throw new Error("release_github_head_changed");
    return { pending: true, reference: { provider: "github", requestId: pending.details.uuid } };
  }
  async lookup(
    identity: ReleaseActionIdentity,
    reference: Record<string, unknown> | null,
    signal: AbortSignal,
  ) {
    const request = this.request(identity);
    const ref = z
      .object({ provider: z.literal("github"), requestId: z.string().uuid() })
      .strict()
      .safeParse(reference);
    if (!ref.success) return null; // Lost 202 cannot safely identify our request.
    const response = await this.call(
      `${request.pullNumber}/merge-async/${ref.data.requestId}`,
      { method: "GET" },
      signal,
    );
    if (response.status !== 200 || response.body?.status !== "merged") return null;
    const merged = z
      .object({ status: z.literal("merged"), details: z.object({ sha }).passthrough() })
      .passthrough()
      .parse(response.body);
    if (!(await this.verifyMerged(request, merged.details.sha, signal)) || signal.aborted)
      return null;
    const evidence = {
      provider: "github",
      repositoryId: request.repositoryId,
      pullRequestId: request.pullRequestId,
      pullNumber: request.pullNumber,
      headSha: request.headSha,
      baseSha: request.baseSha,
      mergeSha: merged.details.sha,
      requestId: ref.data.requestId,
      rulesDigest: request.rulesDigest,
    };
    return {
      requestDigest: identity.requestDigest,
      receiptDigest: githubSourceDigest(evidence),
      evidence,
    };
  }
}
