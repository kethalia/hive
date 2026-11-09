import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { githubSourceDigest } from "./github-evidence.server";
import { releaseBuildManifestSchema } from "./release-build-attestation.server";

const providerId = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const releaseBuildRunConfigSchema = z
  .object({
    repositoryId: providerId,
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    workflowId: providerId,
  })
  .strict();
/** GitHub run success is separate from the signed manifest. A token minted
 * before workflow completion cannot itself prove the job or workflow succeeded. */
export class GitHubBuildRunVerifier {
  private readonly config: z.infer<typeof releaseBuildRunConfigSchema>;
  constructor(
    raw: unknown,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = releaseBuildRunConfigSchema.parse(raw);
    if (!token || token.length > 4096) throw new Error("release_build_run_unavailable");
  }
  authority() {
    return structuredClone(this.config);
  }
  async verify(rawManifest: unknown, signal: AbortSignal) {
    const manifest = releaseBuildManifestSchema.parse(rawManifest);
    if (manifest.repositoryId !== this.config.repositoryId)
      throw new Error("release_build_run_scope");
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.config.owner}/${this.config.name}/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}`,
      {
        method: "GET",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) throw new Error("release_build_run_unavailable");
    const id = z.union([z.string(), z.number().int().positive().safe()]).transform(String);
    const run = z
      .object({
        id,
        run_attempt: z.number().int().positive().safe(),
        workflow_id: id,
        status: z.literal("completed"),
        conclusion: z.literal("success"),
        event: z.literal("push"),
        head_sha: z.string().regex(/^[a-f0-9]{40}$/),
        repository: z.object({ id }).passthrough(),
        head_repository: z.object({ id }).passthrough(),
      })
      .passthrough()
      .parse(await boundedReleaseJson(response, 262144, signal));
    if (
      signal.aborted ||
      run.id !== manifest.runId ||
      run.run_attempt !== manifest.runAttempt ||
      run.workflow_id !== this.config.workflowId ||
      run.repository.id !== manifest.repositoryId ||
      run.head_repository.id !== manifest.repositoryId ||
      run.head_sha !== manifest.mergeSha
    )
      throw new Error("release_build_run_scope");
    const evidence = {
      provider: "github",
      repositoryId: manifest.repositoryId,
      workflowId: this.config.workflowId,
      runId: run.id,
      runAttempt: run.run_attempt,
      mergeSha: run.head_sha,
      status: "completed",
      conclusion: "success",
      manifestDigest: githubSourceDigest(manifest),
    };
    return { evidence, evidenceDigest: githubSourceDigest(evidence) };
  }
}
