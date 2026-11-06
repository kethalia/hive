import { z } from "zod";
import { DeliveryConflict } from "./state";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[1-9][0-9]{0,19}$/);
/** Read-only provider proof for two immutable commits in the exact repository.
 * Repository names are resolved freshly from the stable numeric identity. */
export async function verifyEpicLineage(
  input: { repositoryId: string; base: string; head: string },
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  id.parse(input.repositoryId);
  sha.parse(input.base);
  sha.parse(input.head);
  if (!token || token.length > 4096) throw new DeliveryConflict("epic_lineage_unavailable");
  const read = async (url: string) => {
    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    if (!response.ok || !response.body) throw new DeliveryConflict("epic_lineage_unavailable");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1024 * 1024) throw new DeliveryConflict("epic_lineage_unavailable");
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
  const repo = z
    .object({
      id: z.number().int().positive().safe(),
      full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    })
    .passthrough()
    .parse(await read(`https://api.github.com/repositories/${input.repositoryId}`));
  if (String(repo.id) !== input.repositoryId) throw new DeliveryConflict("epic_lineage_unverified");
  const [owner, name] = repo.full_name.split("/");
  const result = z
    .object({
      status: z.enum(["ahead", "identical", "behind", "diverged"]),
      base_commit: z.object({ sha }),
      merge_base_commit: z.object({ sha }),
    })
    .passthrough()
    .parse(
      await read(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${input.base}...${input.head}?per_page=1`,
      ),
    );
  if (
    !["ahead", "identical"].includes(result.status) ||
    result.base_commit.sha !== input.base ||
    result.merge_base_commit.sha !== input.base ||
    (result.status === "identical" && input.base !== input.head)
  )
    throw new DeliveryConflict("epic_lineage_unverified");
  const current = z
    .object({ id: z.number().int().positive().safe(), full_name: z.string() })
    .parse(
      await read(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      ),
    );
  if (String(current.id) !== input.repositoryId || current.full_name !== repo.full_name)
    throw new DeliveryConflict("epic_lineage_unverified");
  return { ...input, status: result.status, mergeBase: result.merge_base_commit.sha };
}
