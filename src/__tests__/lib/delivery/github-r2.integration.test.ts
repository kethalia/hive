import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@hive/db";
import { afterAll, expect, it } from "vitest";
import { GitHubSourceTransport } from "@/lib/delivery/github-transport.server";
import { createDeliveryGitHubCollector } from "../../../../templates/ai-dev-k8s/scripts/delivery-github-collector.mjs";
import { githubFixture } from "./github-fixture";
import { nativeFixture } from "./native-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL,
  origin = process.env.HIVE_LOCAL_R2_PROOF_ORIGIN,
  bearer = process.env.HIVE_LOCAL_R2_PROOF_BEARER;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local fixture only");
}
if (origin) {
  const u = new URL(origin);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.origin !== origin)
    throw new Error("Local R2 fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
it.skipIf(!url || !origin || !bearer)(
  "composes canonical signed collector, real PG nonce publication and actual local workerd R2 readback",
  async () => {
    const f = await nativeFixture(db);
    await f.create();
    const { snapshot, policy } = githubFixture();
    snapshot.providerAccountId = f.project.providerAccountId;
    snapshot.repository = { id: f.project.providerRepositoryId, fullName: f.project.fullName };
    snapshot.pullRequest.baseRepositoryId = f.project.providerRepositoryId;
    snapshot.pullRequest.headRepositoryId = f.project.providerRepositoryId;
    snapshot.workflowRuns[0].jobs[0].checkRunUrl = `https://api.github.com/repos/${f.project.fullName}/check-runs/80`;
    const uploads: string[] = [];
    const service = new GitHubSourceTransport(
      db,
      {
        reauthorize: f.dependencies.reauthorize,
        resolveTargetPolicy: () => ({ pullNumber: snapshot.pullRequest.number, policy }),
      },
      {
        writeAndVerify: async (key, content, digest) => {
          const result = await fetch(origin!, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
            body: JSON.stringify({
              operation: "artifact",
              key,
              contentBase64: Buffer.from(content).toString("base64"),
              digest,
            }),
            signal: AbortSignal.timeout(15000),
            redirect: "manual",
          });
          expect(result.status).toBe(200);
          uploads.push(key);
          return (await result.json()) as { contentDigest: string; size: number };
        },
      },
    );
    let lostAck = true,
      helperCalls = 0;
    const directory = mkdtempSync(join(tmpdir(), "hive-github-r2-collector-"));
    directories.push(directory);
    const options = {
      enabled: true,
      stateDirectory: directory,
      hiveOrigin: "https://hive.example.invalid",
      hostPrivateKeyPem: f.keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      currentRegistration: f.registration,
      currentProjectContext: () => f.context,
      runHelper: async (target: unknown) => {
        helperCalls++;
        expect(target).toMatchObject({
          providerRepositoryId: f.context.repositoryId,
          expectedHeadSha: f.context.revision,
        });
        return structuredClone(snapshot);
      },
      fetchImpl: async (target: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (target.endsWith("/challenge"))
          return Response.json(await service.requestChallenge(body));
        const result = await service.ingest(body);
        if (lostAck) {
          lostAck = false;
          throw new Error("fixture_lost_ack");
        }
        return Response.json(result);
      },
    };
    const input = {
      managerThreadId: f.managerThreadId,
      taskId: f.taskId,
      stepId: f.stepId,
      requestId: randomUUID(),
    };
    await expect(createDeliveryGitHubCollector(options).refresh(input)).rejects.toThrow(
      "fixture_lost_ack",
    );
    // A fresh collector instance must recover immutable source bytes from disk,
    // then reauthorize/publish through the server; no cached success is returned.
    const result = await createDeliveryGitHubCollector(options).refresh(input);
    expect(result.evidenceIds).toHaveLength(2);
    expect(result.replayed).toBe(true);
    expect(helperCalls).toBe(1);
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toBe(uploads[1]);
    expect(uploads[0]).toContain(
      `delivery/${f.user.id}/github/${f.context.repositoryId}/${f.context.revision}/`,
    );
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(2);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_source_consumed" },
      }),
    ).toBe(1);
    expect((await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).releaseMode).toBe(
      "disabled",
    );
  },
  20000,
);
