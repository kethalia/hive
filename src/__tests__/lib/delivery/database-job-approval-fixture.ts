import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { DatabaseJobStore } from "@/lib/delivery/database-job-store.server";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import {
  databaseCatalogSchema,
  databaseOidcAudience,
  databasePlanApprovalSchema,
} from "../../../../services/migrate/src/delivery/wire.mjs";
import type { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";

type Fixture = Awaited<ReturnType<typeof acceptanceCandidateFixture>>;
/** Real store, RSA workload identity and signed response. Only the external
 * issuer and compatibility-job GETs are doubles; no SQL runner is installed. */
export function databaseApprovalFixture(db: PrismaClient, f: Fixture) {
  const issuer = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = generateKeyPairSync("ed25519");
  const sha = "a".repeat(40),
    hash = (value: string) => value.repeat(64);
  const id = randomUUID(),
    now = Date.now();
  const plan = {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: f.publication.headSha,
    oldAppDigest: hash("b"),
    newAppDigest: hash("c"),
    compatibilityDigest: hash("d"),
    beforeSchemaDigest: hash("e"),
    afterSchemaDigest: hash("f"),
    batchSize: 10,
    statementTimeoutMs: 1000,
    lockTimeoutMs: 100,
    schemaSql: "SELECT 1",
    expandSql: ["SELECT 1"],
    highWaterSql: "SELECT 1",
    batchSql: "SELECT 1",
    integritySql: "SELECT 1",
    integrityTables: [{ schema: "public", name: "fixture" }],
  };
  const compatibility = {
    schemaVersion: 1,
    kind: "workerd",
    catalogId: id,
    planDigest: githubSourceDigest(plan),
    sourceSha: plan.sourceSha,
    oldAppDigest: plan.oldAppDigest,
    newAppDigest: plan.newAppDigest,
    compatibilityDigest: plan.compatibilityDigest,
    postgresImage: `registry.example/postgres@sha256:${hash("e")}`,
    oldAuthDigest: hash("1"),
    newAuthDigest: hash("2"),
    oldArtifactUrl: "https://example.invalid/old",
    newArtifactUrl: "https://example.invalid/new",
    scenarioPath: "scripts/release/compatibility/reviewed.mjs",
    scenarioDigest: hash("f"),
    compatibilityDate: "2026-10-29",
  };
  const [owner, name] = f.project.fullName.split("/");
  const catalog = databaseCatalogSchema.parse({
    schemaVersion: 1,
    id,
    ownerId: f.user.id,
    repositoryId: f.project.providerRepositoryId,
    repositoryOwnerId: f.project.providerAccountId,
    environmentKey: "fixture-preview",
    targetDigest: hash("9"),
    targetId: randomUUID(),
    databaseName: "hive_d10_fixture",
    databaseHost: "localhost",
    databasePort: 5432,
    workflowRef: `${owner}/${name}/.github/workflows/database.yml@${sha}`,
    workflowSha: sha,
    dispatcherSha: sha,
    branchRef: "refs/heads/database-fixture",
    authorityOrigin: "https://fixture.invalid",
    authorityPublicKeyPem: signer.publicKey.export({ type: "spki", format: "pem" }).toString(),
    validFrom: now - 1000,
    expiresAt: now + 120000,
    compatibilityTest: {
      config: compatibility,
      repositoryOwner: owner,
      repositoryName: name,
      workflowId: "5",
      jobName: `call / fixed-database-compatibility-${githubSourceDigest(compatibility)}`,
    },
  });
  const request = databasePlanApprovalSchema.parse({
    schemaVersion: 1,
    catalogId: id,
    ownerId: f.user.id,
    taskId: f.taskId,
    sourceSha: plan.sourceSha,
    githubRunId: "12",
    githubRunAttempt: 1,
    purpose: "approve_database_plan",
    plan,
    compatibility: {
      contractDigest: plan.compatibilityDigest,
      mixedVersionChecksDigest: githubSourceDigest(compatibility),
      databaseEnforcedInvariantDigest: hash("e"),
    },
  });
  let compatibilityConclusion = "success";
  const fetcher: typeof fetch = async (input, init) => {
    if ((init?.method ?? "GET") !== "GET") throw Error("unexpected provider mutation");
    const url = new URL(String(input));
    if (url.href === "https://token.actions.githubusercontent.com/.well-known/jwks")
      return Response.json({
        keys: [
          {
            ...issuer.publicKey.export({ format: "jwk" }),
            kid: "fixture",
            use: "sig",
            alg: "RS256",
          },
        ],
      });
    const root = `https://api.github.com/repos/${owner}/${name}/actions/runs/12/attempts/1`;
    if (url.href === root)
      return Response.json({
        id: 12,
        run_attempt: 1,
        workflow_id: 5,
        event: "workflow_dispatch",
        head_sha: sha,
        repository: { id: Number(catalog.repositoryId) },
        head_repository: { id: Number(catalog.repositoryId) },
      });
    if (url.href === `${root}/jobs?per_page=100`)
      return Response.json({
        total_count: 1,
        jobs: [
          {
            run_id: 12,
            run_attempt: 1,
            name: catalog.compatibilityTest!.jobName,
            status: "completed",
            conclusion: compatibilityConclusion,
          },
        ],
      });
    throw Error("unexpected authority provider read");
  };
  const store = new DatabaseJobStore(
    db,
    f.policies,
    () => [catalog],
    signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    {
      observe: async () => {
        throw Error("unexpected deployment observation");
      },
    },
    fetcher,
    "fixture-read-only",
  );
  const token = (body: { sourceSha: string; githubRunId: string; githubRunAttempt: number }) => {
    const stamp = Math.floor(Date.now() / 1000),
      encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      aud: databaseOidcAudience(body),
      repository_id: catalog.repositoryId,
      repository_owner_id: catalog.repositoryOwnerId,
      sha: catalog.dispatcherSha,
      ref: catalog.branchRef,
      event_name: "workflow_dispatch",
      run_id: body.githubRunId,
      run_attempt: String(body.githubRunAttempt),
      job_workflow_ref: catalog.workflowRef,
      job_workflow_sha: catalog.workflowSha,
      jti: randomUUID(),
      iat: stamp - 1,
      nbf: stamp - 1,
      exp: stamp + 60,
    };
    const message = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(claims)}`;
    return `${message}.${sign("RSA-SHA256", Buffer.from(message), issuer.privateKey).toString("base64url")}`;
  };
  return {
    store,
    catalog,
    request,
    token,
    failCompatibility: () => {
      compatibilityConclusion = "failure";
    },
    passCompatibility: () => {
      compatibilityConclusion = "success";
    },
  };
}
