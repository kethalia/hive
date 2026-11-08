import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: undefined as unknown, host: vi.fn() }));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => mocks.db,
}));
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mocks.host }));

import { reconcileEpicPreviewMerge } from "@/lib/delivery/epic-merge-reconcile.server";
import { projectReconcileRoute } from "@/lib/projects/reconcile-route.server";
import { hostEpicMerge } from "../../../../scripts/host-epic-merge";
import { admittedEpicMergeFixture } from "./epic-merge-fixture";
import { epicMergeProviderFixture } from "./epic-merge-provider-fixture";

const url = process.env.HIVE_EPIC_MERGE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/hive_acceptance_test(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname))
)
  throw Error("Owned local fixture database only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test_unused",
});
mocks.db = db;
afterAll(() => db.$disconnect());
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.host.mockReset();
});
describe.skipIf(!url)("task-local pending epic merge gates", () => {
  it("keeps two real children pending while unrelated queued project work reconciles", async () => {
    const first = await admittedEpicMergeFixture(db, mocks.host),
      firstCatalog = JSON.parse(process.env.HIVE_DELIVERY_REPOSITORY_POLICIES_JSON!);
    const second = await admittedEpicMergeFixture(db, mocks.host),
      secondCatalog = JSON.parse(process.env.HIVE_DELIVERY_REPOSITORY_POLICIES_JSON!);
    vi.stubEnv(
      "HIVE_DELIVERY_REPOSITORY_POLICIES_JSON",
      JSON.stringify([...firstCatalog, ...secondCatalog]),
    );
    vi.stubEnv(
      "HIVE_DELIVERY_EPIC_ISOLATION_POLICY",
      JSON.stringify({
        schemaVersion: 1,
        workspaces: [...first.policy.workspaces, ...second.policy.workspaces],
      }),
    );
    const p = await epicMergeProviderFixture(db, first);
    vi.stubEnv("HIVE_DELIVERY_EPIC_MERGE_ENABLED", "true");
    vi.stubEnv("HIVE_DELIVERY_EPIC_MERGE_CONFIG_JSON", JSON.stringify(p.config));
    vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "true");
    vi.stubEnv("HIVE_PROJECT_TASK_RECONCILE_SECRET", "d".repeat(64));
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "false");
    const deliveries: string[] = [];
    mocks.host.mockImplementation(async (user, workspace, path, request, options) => {
      if (path === "/projects/epic-merge")
        return hostEpicMerge({ request, token: "fixture-connected-secret" }, p.fetcher);
      if (["/projects/tasks/start", "/projects/tasks/status"].includes(path)) {
        deliveries.push(user.id);
        return {
          schemaVersion: 1,
          projectId: request.projectId,
          taskId: request.taskId,
          phase: "preparing",
          nativeThreadId: null,
          terminalSessionName: null,
          reason: null,
        };
      }
      return (user.id === first.root.user.id ? first.originalHost : second.originalHost)(
        user,
        workspace,
        path,
        request,
        options,
      );
    });
    // Existing real queued intent belongs to the other project. Prioritize it
    // through the queue's mutable scheduling field, without bypassing its claim.
    const intent = await db.projectTaskIntent.findFirstOrThrow({
      where: { ownerId: second.root.user.id, id: second.childIntent },
    });
    await db.projectTaskIntent.update({
      where: { id: intent.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const response = await projectReconcileRoute(
      new Request("https://hive.example.invalid/api/internal/project-tasks/reconcile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${"d".repeat(64)}`,
          "X-Hive-Reconcile-Deadline": String(Date.now() + 40000),
        },
        body: JSON.stringify({ schemaVersion: 1 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 1, retry: 0 });
    expect(deliveries).toContain(second.root.user.id);
    expect(mocks.host.mock.calls.some((call) => call[2] === "/projects/epic-merge")).toBe(true);
    expect(
      await db.deliveryRelease.count({
        where: { taskId: { in: [first.child.taskId, second.child.taskId] } },
      }),
    ).toBe(0);
    expect(p.remote.writes).toBe(0);
    const aborted = new AbortController();
    aborted.abort(Error("explicit parent cancellation"));
    await expect(reconcileEpicPreviewMerge(db, first.scope, aborted.signal)).rejects.toThrow(
      "explicit parent cancellation",
    );
    const broken = new Proxy(db, {
      get(target, key) {
        if (key === "$transaction")
          return async () => {
            throw Error("unexpected database failure");
          };
        return Reflect.get(target, key);
      },
    });
    await expect(
      reconcileEpicPreviewMerge(broken, first.scope, AbortSignal.timeout(30000)),
    ).rejects.toThrow("unexpected database failure");
  }, 30000);
});
