import { expect, it, vi } from "vitest";
import { verifyEpicLineage } from "@/lib/delivery/epic-lineage.server";

const base = "a".repeat(40),
  head = "b".repeat(40);
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
it("accepts a fixed-repository compare only when the base is an ancestor", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ id: 123, full_name: "owner/repo" }))
    .mockResolvedValueOnce(
      response({ status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: base } }),
    )
    .mockResolvedValueOnce(response({ id: 123, full_name: "owner/repo" }));
  await expect(
    verifyEpicLineage({ repositoryId: "123", base, head }, "read-token", fetcher),
  ).resolves.toMatchObject({ base, head, mergeBase: base });
  expect(fetcher.mock.calls[1][0]).toContain(`/compare/${base}...${head}?per_page=1`);
  expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: "manual" });
});
it("uses the Worker-supported manual mode and never follows redirects", async () => {
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    if (init.redirect !== "manual") throw Error("unsupported redirect mode");
    return new Response(null, { status: 302, headers: { Location: "https://example.invalid" } });
  });
  await expect(
    verifyEpicLineage(
      { repositoryId: "123", base, head },
      "fixture-read-token",
      fetcher as typeof fetch,
    ),
  ).rejects.toThrow("epic_lineage_unavailable");
  expect(fetcher).toHaveBeenCalledOnce();
});
it("rejects unrelated commits and changed repository identity", async () => {
  const diverged = vi
    .fn()
    .mockResolvedValueOnce(response({ id: 123, full_name: "owner/repo" }))
    .mockResolvedValueOnce(
      response({
        status: "diverged",
        base_commit: { sha: base },
        merge_base_commit: { sha: "c".repeat(40) },
      }),
    );
  await expect(
    verifyEpicLineage({ repositoryId: "123", base, head }, "read-token", diverged),
  ).rejects.toThrow("epic_lineage_unverified");
  const wrongRepo = vi.fn().mockResolvedValueOnce(response({ id: 456, full_name: "owner/repo" }));
  await expect(
    verifyEpicLineage({ repositoryId: "123", base, head }, "read-token", wrongRepo),
  ).rejects.toThrow("epic_lineage_unverified");
  expect(wrongRepo).toHaveBeenCalledOnce();
});
