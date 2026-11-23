import { z } from "zod";
import type { appPreviewCatalogSchema } from "./app-preview-catalog";
import { appPreviewOrigin } from "./app-preview-origin.mjs";

const repository = "kethalia/hive";
const checkName = "Workers Builds: hive";
const cloudflareBuildPath =
  /^\/225177f82b9234ede14e897fe15e0cb5\/workers\/services\/view\/hive\/production\/previews\/([a-z0-9-]+)\/builds\/[a-f0-9-]+$/;

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
const checks = z.object({
  check_runs: z.array(
    z.object({
      app: z.object({ id: z.number(), slug: z.string() }).nullable(),
      name: z.string(),
      conclusion: z.string().nullable(),
      details_url: z.string().nullable(),
      head_sha: z.string(),
    }),
  ),
});

async function readGitHub(path: string, signal: AbortSignal): Promise<unknown> {
  const init = {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Hive-preview-catalog" },
    redirect: "error" as const,
    // These fixed public URLs carry no caller identity. Cache successful reads at
    // the edge to share GitHub's anonymous read budget across Hive users.
    cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 120, "400-599": -1 } },
    signal,
  };
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, init);
  if (!response.ok) throw new Error("GitHub preview catalog unavailable");
  return response.json();
}

function branchAlias(branch: string) {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deployedSlug(details: string | null, branch: string): string | null {
  if (!details) return null;
  const url = URL.parse(details);
  if (url?.origin !== "https://dash.cloudflare.com" || url.username || url.password) return null;
  const slug = cloudflareBuildPath.exec(url.pathname)?.[1];
  // Workers Builds keys the preview by PR head branch. Require its reported
  // alias to agree with that branch before constructing a public hostname.
  return slug && slug === branchAlias(branch) && appPreviewOrigin(slug) ? slug : null;
}

export async function readAppPreviewCatalog() {
  const signal = AbortSignal.timeout(8_000);
  const prs = pullRequests
    .parse(await readGitHub("pulls?state=open&base=main&sort=updated&per_page=30", signal))
    .filter((pr) => pr.head.repo?.full_name === repository && pr.head.ref !== "main");
  const previews: z.infer<typeof appPreviewCatalogSchema> = [];
  const aliasCounts = new Map<string, number>();
  for (const pr of prs) {
    const alias = branchAlias(pr.head.ref);
    aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
  }
  for (let offset = 0; offset < prs.length; offset += 5) {
    const batch = await Promise.all(
      prs.slice(offset, offset + 5).map(async (pr) => {
        const result = checks.parse(
          await readGitHub(
            `commits/${pr.head.sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=latest`,
            signal,
          ),
        );
        const check = result.check_runs.find(
          (row) =>
            row.app?.id === 85455 &&
            row.app.slug === "cloudflare-workers-and-pages" &&
            row.name === checkName &&
            row.conclusion === "success" &&
            row.head_sha === pr.head.sha,
        );
        const slug = deployedSlug(check?.details_url ?? null, pr.head.ref);
        return slug && aliasCounts.get(slug) === 1
          ? { slug, number: pr.number, title: pr.title, branch: pr.head.ref, revision: pr.head.sha }
          : null;
      }),
    );
    previews.push(...batch.filter((preview) => preview !== null));
  }
  return previews;
}
