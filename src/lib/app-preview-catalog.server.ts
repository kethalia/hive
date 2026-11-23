import { z } from "zod";
import type { AppPreview } from "./app-preview-catalog";
import { appPreviewBranchSlug, appPreviewOrigin } from "./app-preview-origin.mjs";

const repository = "kethalia/hive";
const openPullRequestsUrl = `https://api.github.com/repos/${repository}/pulls?state=open&base=main&sort=updated&per_page=30`;

const pullRequests = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
    head: z.object({
      ref: z.string().min(1).max(256),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
      repo: z.object({ full_name: z.string() }).nullable(),
    }),
  }),
);

async function readOpenPullRequests(signal: AbortSignal) {
  const init = {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Hive-preview-catalog" },
    // Workers supports manual redirects. The status check below rejects 3xx.
    redirect: "manual" as const,
    // The catalog needs one public GitHub read per refresh. Share it at the
    // edge so continuous use stays within GitHub's anonymous request budget.
    cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 240, "400-599": -1 } },
    signal,
  };
  const response = await fetch(openPullRequestsUrl, init);
  if (!response.ok) throw new Error("GitHub preview catalog unavailable");
  return pullRequests.parse(await response.json());
}

export async function readAppPreviewCandidates() {
  const signal = AbortSignal.timeout(8_000);
  const prs = (await readOpenPullRequests(signal)).filter(
    (pr) => pr.head.repo?.full_name === repository && pr.head.ref !== "main",
  );
  const previews: AppPreview[] = [];
  const aliasCounts = new Map<string, number>();
  const candidates = prs.map((pr) => {
    const slug = appPreviewBranchSlug(pr.head.ref);
    aliasCounts.set(slug, (aliasCounts.get(slug) ?? 0) + 1);
    return { pr, slug };
  });
  for (const { pr, slug } of candidates) {
    if (appPreviewOrigin(slug) && aliasCounts.get(slug) === 1) {
      previews.push({
        slug,
        number: pr.number,
        title: pr.title,
        branch: pr.head.ref,
        revision: pr.head.sha,
      });
    }
  }
  return previews;
}
