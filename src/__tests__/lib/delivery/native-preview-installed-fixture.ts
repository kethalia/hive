import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { expect } from "vitest";
import type { z } from "zod";
import { createInstalledReleaseController } from "@/lib/delivery/release-installed.server";
import {
  nativeArtifactSchema,
  nativeDigest,
} from "@/lib/delivery/release-native-preview-contracts";
import { nativeReleaseRoute } from "@/lib/delivery/release-native-preview-route.server";
import {
  archive,
  config as basePublisherConfig,
  callerWorkflowBytes,
  target,
  zipArchive,
} from "../../../../scripts/release/native-preview-fixture";
import {
  type nativePublisherScopeSchema,
  publishNativePreview,
} from "../../../../scripts/release/native-preview-publisher";
import { inspectNativeArchive, sha256 } from "../../../../scripts/release/native-preview-upload";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";

/** Real installed authority and PostgreSQL; only external GitHub/Cloudflare
 * transports and candidate bytes are synthetic. No candidate module executes. */
export async function nativeInstalledFixture(
  db: PrismaClient,
  options: { bootstrapTtlMs?: number } = {},
) {
  await db.$executeRawUnsafe(
    "TRUNCATE delivery_native_release_baselines,delivery_native_publication_receipts,delivery_native_publication_grants,delivery_native_release_artifacts,delivery_release_targets CASCADE",
  );
  const source = await acceptanceCandidateFixture(db, undefined, {
    releaseRepository: { fullName: "kethalia/hive", baseBranch: "codex/delivery-system-design" },
  });
  const revision = await db.deliverySourceRevision.findFirstOrThrow({
    where: { operationId: source.publication.operationId },
  });
  const bytes = await archive(),
    zip = zipArchive(bytes),
    inspected = await inspectNativeArchive(bytes);
  const repositoryId = source.project.providerRepositoryId,
    repositoryOwnerId = source.project.providerAccountId;
  const config = structuredClone(basePublisherConfig);
  config.publicConfig.vars = { ...config.publicConfig.vars, HIVE_RELEASE_HEALTH_ENABLED: "true" };
  config.publicConfig.secretNames.push("HIVE_RELEASE_PROBE_SECRET");
  config.builderPolicy.repositoryId = repositoryId;
  config.builderPolicy.repositoryOwnerId = repositoryOwnerId;
  config.publisherPolicy.repositoryId = repositoryId;
  config.publisherPolicy.repositoryOwnerId = repositoryOwnerId;
  const scope = {
    purpose: "bootstrap-baseline" as const,
    ownerId: source.user.id,
    releaseId: randomUUID(),
    artifactReleaseId: "",
    artifactId: randomUUID(),
    sourceSha: revision.headSha,
    builderRunId: "4",
    builderRunAttempt: 1,
    builderArtifactId: "5",
  };
  scope.artifactReleaseId = scope.releaseId;
  const artifact = nativeArtifactSchema.parse({
    schemaVersion: 1,
    provider: "cloudflare-native-preview",
    id: scope.artifactId,
    ownerId: scope.ownerId,
    releaseId: scope.releaseId,
    sourceSha: scope.sourceSha,
    targetDigest: nativeDigest(target),
    archiveDigest: inspected.archiveDigest,
    artifactDigest: inspected.artifactDigest,
    moduleManifestDigest: inspected.moduleManifestDigest,
    assetsManifestDigest: inspected.assetsManifestDigest,
    builder: {
      repositoryId,
      repositoryOwnerId,
      runId: "4",
      runAttempt: 1,
      artifactId: "5",
      artifactZipDigest: sha256(zip),
      workflowId: "3",
    },
    publicConfig: config.publicConfig,
    privateBindingRevision: config.privateBindingRevision,
    compatibilityRevision: config.compatibilityRevision,
  });
  const tested = {
    workflow: {
      audiencePrefix: "urn:hive:release-tested:native:",
      repositoryId,
      repositoryOwnerId,
      workflowRef: "kethalia/hive/.github/workflows/test.yml@refs/heads/main",
      workflowSha: "1".repeat(40),
      controlDigest: "3".repeat(64),
    },
    run: {
      repositoryId,
      owner: "kethalia",
      name: "hive",
      workflowId: "62",
      testJobName: "fixed-tested-tree",
    },
  };
  const riskCatalog = { owner: "kethalia", name: "hive", allowedPrefixes: ["src/"] };
  const controllerConfig = {
    provider: "cloudflare-native-preview",
    target,
    externalWriterPolicy: "observed-drift-hold-no-atomic-cas",
    github: {
      repositoryId,
      owner: "kethalia",
      name: "hive",
      allowedBaseRef: "codex/delivery-system-design",
    },
    builder: config.builderPolicy,
    publisher: config.publisherPolicy,
    publicConfig: config.publicConfig,
    privateBindingRevision: config.privateBindingRevision,
    compatibilityRevision: config.compatibilityRevision,
    riskCatalog,
    authority: {
      targetDigest: nativeDigest(target),
      riskCatalogDigest: nativeDigest(riskCatalog),
      mergeMethod: "squash",
      baselines: null,
      tested,
    },
    observation: { windowMs: 1000, minimumSamples: 2 },
    bootstrap: {
      enabled: true,
      ownerId: scope.ownerId,
      releaseId: scope.releaseId,
      taskId: source.taskId,
      sourceRevisionId: revision.id,
      sourceSha: scope.sourceSha,
      artifactId: scope.artifactId,
      artifactDigest: artifact.artifactDigest,
      archiveDigest: artifact.archiveDigest,
      publicConfigDigest: nativeDigest(config.publicConfig),
      expiresAt: Date.now() + (options.bootstrapTtlMs ?? 120000),
    },
  };
  const env = {
    HIVE_DELIVERY_RELEASE_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify(controllerConfig),
    HIVE_DELIVERY_RELEASE_GITHUB_TOKEN: "fixture-github-read",
    HIVE_DELIVERY_RELEASE_CLOUDFLARE_TOKEN: "fixture-controller-read",
    HIVE_RELEASE_PROBE_SECRET: "f".repeat(64),
  };
  const publisher = {
    repositoryId,
    repositoryOwnerId,
    runId: "9",
    runAttempt: 1,
    workflowSha: config.publisherPolicy.workflowSha,
  };
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signAudience = (audience: string) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "native" })).toString(
      "base64url",
    );
    const claims = Buffer.from(
      JSON.stringify({
        iss: "https://token.actions.githubusercontent.com",
        aud: audience,
        sub: "repo:kethalia/hive:environment:hive-native-release",
        repository_id: repositoryId,
        repository_owner_id: repositoryOwnerId,
        run_id: publisher.runId,
        run_attempt: String(publisher.runAttempt),
        event_name: "workflow_dispatch",
        job_workflow_ref: config.publisherPolicy.workflowRef,
        job_workflow_sha: config.publisherPolicy.workflowSha,
        sha: config.publisherPolicy.contextSha,
        ref: config.publisherPolicy.ref,
        iat: now,
        nbf: now,
        exp: now + 300,
        jti: randomUUID(),
      }),
    ).toString("base64url");
    const input = `${header}.${claims}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  };
  const state = {
    current: "unverified-auto-deployment",
    writes: [] as string[],
    requests: [] as string[],
    deployments: new Map<string, Record<string, any>>(),
    losePostAck: false,
    loseReceiptAck: false,
    loseGrantAck: false,
    unhealthy: false,
    driftBeforePost: false,
    builderRunning: false,
    builderAttempt: 1,
    callerChanged: false,
    onRead: undefined as undefined | ((path: string) => void),
    github: undefined as undefined | ((url: URL, init?: RequestInit) => Promise<Response | null>),
  };
  let activeActionId: string = scope.artifactId;
  const builds = new Map([["4", { artifactId: "5", sourceSha: artifact.sourceSha, zip }]]);
  let controller: NonNullable<ReturnType<typeof createInstalledReleaseController>>;
  const json = (result: unknown) => Response.json({ success: true, result, errors: [] });
  const fetcher: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? "GET",
      path = url.pathname;
    state.requests.push(`${method} ${url.origin}${path}`);
    if (url.origin === "https://token.actions.githubusercontent.com")
      return Response.json({
        keys: ["native", "tested"].map((kid) => ({
          ...keys.publicKey.export({ format: "jwk" }),
          kid,
          alg: "RS256",
          use: "sig",
        })),
      });
    if (url.hostname === "fixture.actions.githubusercontent.com")
      return Response.json({ value: signAudience(url.searchParams.get("audience")!) });
    if (url.origin === config.controllerOrigin) {
      const operation = path.split("/").at(-1) as "artifact" | "grant" | "reauthorize" | "receipt";
      if (controller.kind !== "native-preview") throw Error("wrong controller kind");
      const response = await nativeReleaseRoute(new Request(url, init), operation, controller);
      if (
        (operation === "grant" && state.loseGrantAck) ||
        (operation === "receipt" && state.loseReceiptAck)
      ) {
        state.loseGrantAck = state.loseReceiptAck = false;
        throw Error("synthetic lost controller ACK after commit");
      }
      return response;
    }
    if (url.origin === "https://api.github.com") {
      const extra = await state.github?.(url, init);
      if (extra) return extra;
      const runId = path.match(/\/actions\/runs\/(\d+)(?:\/attempts\/1)?$/)?.[1],
        build = runId ? builds.get(runId) : undefined;
      if (build)
        return Response.json({
          id: Number(runId),
          run_attempt: state.builderAttempt,
          workflow_id: 3,
          status: state.builderRunning ? "in_progress" : "completed",
          conclusion: "success",
          head_sha: build.sourceSha,
          head_branch: "codex/delivery-system-design",
          event: "push",
          path: `${config.builderPolicy.callerWorkflowPath}@codex/delivery-system-design`,
          repository: { id: Number(repositoryId) },
          head_repository: { id: Number(repositoryId) },
          referenced_workflows: [
            {
              path: config.builderPolicy.reusableWorkflowPath,
              sha: config.builderPolicy.workflowSha,
            },
          ],
        });
      if (path === `/repos/kethalia/hive/contents/${config.builderPolicy.callerWorkflowPath}`) {
        expect([...builds.values()].some((b) => b.sourceSha === url.searchParams.get("ref"))).toBe(
          true,
        );
        const content = state.callerChanged
          ? Buffer.from("unreviewed alternate artifact producer")
          : callerWorkflowBytes;
        return Response.json({
          type: "file",
          encoding: "base64",
          path: config.builderPolicy.callerWorkflowPath,
          sha: config.builderPolicy.callerWorkflowBlobSha,
          size: content.length,
          content: content.toString("base64"),
        });
      }
      const artifactId = path.match(/\/actions\/artifacts\/(\d+)(?:\/zip)?$/)?.[1],
        found = [...builds].find(([, b]) => b.artifactId === artifactId);
      if (found && path.endsWith("/zip"))
        return new Response(null, {
          status: 302,
          headers: { location: `https://fixture.blob.core.windows.net/${artifactId}.zip` },
        });
      if (found)
        return Response.json({
          id: Number(artifactId),
          name: "hive-native-release",
          expired: false,
          digest: `sha256:${sha256(found[1].zip)}`,
          size_in_bytes: found[1].zip.length,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          workflow_run: {
            id: Number(found[0]),
            repository_id: Number(repositoryId),
            head_repository_id: Number(repositoryId),
            head_sha: found[1].sourceSha,
          },
        });
    }
    if (url.hostname === "fixture.blob.core.windows.net") {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      const build = [...builds.values()].find((b) => path === `/${b.artifactId}.zip`)!;
      return new Response(new Uint8Array(build.zip));
    }
    if (url.origin === "https://api.cloudflare.com") {
      if (method === "GET") {
        state.onRead?.(path);
        if (path.endsWith(`/previews/${encodeURIComponent(target.previewName)}`))
          return json({ id: target.previewId, name: target.previewName, slug: target.previewSlug });
        if (path.endsWith("/deployments/latest"))
          return json(state.deployments.get(state.current) ?? { id: state.current });
        const deployment = state.deployments.get(path.split("/").at(-1)!);
        if (deployment) return json(deployment);
      }
      if (method === "POST") {
        expect(new Headers(init?.headers).get("authorization")).not.toBe(
          "Bearer fixture-controller-read",
        );
        const rows = await db.$queryRaw<
          { phase: string; grant_data: { id: string; actionId: string } }[]
        >`SELECT a.phase,g.grant_data FROM delivery_native_publication_grants g JOIN delivery_release_actions a ON a.id=g.action_id WHERE a.id=${activeActionId}::uuid`;
        expect(rows[0]?.phase).toBe("effect_started");
        expect(rows[0]?.grant_data.actionId).toBe(activeActionId);
        state.writes.push(path);
        if (path.endsWith("/assets-upload-session"))
          return json({
            jwt: "fixture-assets-session",
            buckets: [
              Object.values(JSON.parse(String(init?.body)).manifest).map(
                (entry: any) => entry.hash,
              ),
            ],
          });
        if (path.endsWith("/assets/upload")) {
          if (state.driftBeforePost) state.current = "external-auto-deployment";
          return json({ jwt: "fixture-assets-complete" });
        }
        if (path.endsWith(`/previews/${target.previewId}/deployments`)) {
          const form = init?.body as FormData;
          expect(form.getAll("files").length).toBeGreaterThan(0);
          const metadata = JSON.parse(String(form.get("metadata")));
          expect(Array.isArray(metadata.env)).toBe(false);
          for (const name of config.publicConfig.secretNames)
            expect(metadata.env[name]).toEqual({ type: "inherit" });
          const id = randomUUID(),
            created_on = new Date().toISOString();
          const env = Object.fromEntries(
            Object.entries(metadata.env).map(([name, entry]) => [
              name,
              (entry as any).type === "inherit"
                ? { type: "secret_text", text: "provider-secret-must-never-escape" }
                : entry,
            ]),
          );
          state.deployments.set(id, { ...metadata, env, id, created_on });
          state.current = id;
          if (state.losePostAck) {
            state.losePostAck = false;
            throw Error("synthetic native POST applied then ACK lost");
          }
          return json({ id, created_on });
        }
      }
    }
    if (url.origin === target.origin && path === "/.well-known/hive-release-health") {
      expect(new Headers(init?.headers).get("x-hive-release-probe")).toBe(
        env.HIVE_RELEASE_PROBE_SECRET,
      );
      const active = state.deployments.get(state.current)!;
      return Response.json({
        schemaVersion: 1,
        ...Object.fromEntries(
          ["app", "auth"].map((component) => [
            component,
            {
              component,
              ready: !state.unhealthy,
              sourceSha: active.env.HIVE_RELEASE_SOURCE_SHA.text,
              artifactDigest: active.env.HIVE_RELEASE_ARTIFACT_DIGEST.text,
            },
          ]),
        ),
      });
    }
    throw Error(`Unexpected synthetic transport ${method} ${url.origin}${path}`);
  };
  controller = createInstalledReleaseController(db, env, fetcher)!;
  if (controller.kind !== "native-preview") throw Error("native installed discriminator missing");
  const native = controller;
  const publish = (selected: z.infer<typeof nativePublisherScopeSchema> = scope) => {
    activeActionId = selected.actionId ?? selected.artifactId;
    return publishNativePreview({
      config,
      scope: selected,
      publisher,
      githubToken: "fixture-github-read",
      cloudflareToken: "fixture-publisher-write",
      oidcUrl: "https://fixture.actions.githubusercontent.com/oidc",
      oidcRequestToken: "fixture-oidc-request",
      signal: AbortSignal.timeout(30000),
      fetcher,
    });
  };
  const install = (next: unknown) => {
    env.HIVE_DELIVERY_RELEASE_CONFIG_JSON = JSON.stringify(next);
    controller = createInstalledReleaseController(db, env, fetcher)!;
    if (controller.kind !== "native-preview") throw Error("wrong native kind");
    return controller;
  };
  const testedToken = (payload: unknown, mergeSha: string) => {
    const now = Math.floor(Date.now() / 1000),
      encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      aud: tested.workflow.audiencePrefix + nativeDigest(payload),
      repository_id: repositoryId,
      repository_owner_id: repositoryOwnerId,
      sha: mergeSha,
      ref: `refs/pull/${revision.pullNumber}/merge`,
      event_name: "pull_request",
      run_id: "60",
      run_attempt: "1",
      job_workflow_ref: tested.workflow.workflowRef,
      job_workflow_sha: tested.workflow.workflowSha,
      jti: randomUUID(),
      iat: now - 1,
      nbf: now - 1,
      exp: now + 300,
    };
    const message = `${encode({ alg: "RS256", kid: "tested" })}.${encode(claims)}`;
    return `${message}.${sign("RSA-SHA256", Buffer.from(message), keys.privateKey).toString("base64url")}`;
  };
  const token = (purpose: string, body: unknown) =>
    signAudience(`${config.publisherPolicy.audiencePrefix}${purpose}:${nativeDigest(body)}`);
  return {
    source,
    revision,
    artifact,
    scope,
    config,
    controllerConfig,
    env,
    publisher,
    state,
    native,
    publish,
    fetcher,
    token,
    inspected,
    bytes,
    builds,
    install,
    testedToken,
  };
}
