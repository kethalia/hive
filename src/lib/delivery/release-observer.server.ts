import { z } from "zod";
import { NativePreviewReleaseReader } from "./release-native-preview-reader.server";
import {
  boundedReleaseJson,
  RELEASE_HEALTH_PATH,
  withReleaseDeadline,
} from "../../../deploy/cloudflare/app/release-health";
import { githubSourceDigest } from "./github-evidence.server";
import { cloudflareReleaseTargetSchema } from "./release-cloudflare-provider.server";

const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  sha = z.string().regex(/^[a-f0-9]{40}$/);
const componentSchema = z
  .object({ deploymentId: uuid, versionId: uuid, sourceSha: sha, artifactDigest: digest })
  .strict();
const observationSchema = z
  .object({
    startedAt: z.number().int().nonnegative().safe(),
    endedAt: z.number().int().nonnegative().safe(),
    app: componentSchema,
    auth: componentSchema,
  })
  .strict();
const configSchema = z
  .object({
    target: cloudflareReleaseTargetSchema,
    origin: z
      .string()
      .url()
      .refine((v) => {
        try {
          const u = new URL(v);
          return u.protocol === "https:" && u.origin === v && !u.username && !u.password;
        } catch {
          return false;
        }
      }),
    minimumRequests: z.number().int().positive().max(1000000),
    maxErrorRate: z.number().min(0).max(1),
    settleDelayMs: z.number().int().min(60000).max(86400000),
  })
  .strict();
const HEALTH_COMPONENT = z
  .object({
    component: z.enum(["app", "auth"]),
    ready: z.literal(true),
    sourceSha: sha,
    artifactDigest: digest,
  })
  .strict();
const healthSchema = z
  .object({ schemaVersion: z.literal(1), app: HEALTH_COMPONENT, auth: HEALTH_COMPONENT })
  .strict();
// The source is the Cloudflare documented workersInvocationsAdaptive aggregate.
// Adaptive sampling and delayed ingestion remain limitations; a lack of data is
// unknown, never zero errors. A settle delay is an operator policy, not proof of
// globally complete ingestion.
const query = `query HiveReleaseMetrics($accountTag: string, $start: string, $end: string, $script: string) { viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 2, filter: {scriptName: $script, datetime_geq: $start, datetime_lt: $end}) { sum { requests errors } } } } }`;

/** Read-only fixed provider observer. Caller separately authenticates build
 * attestation and serializes target ownership. The current-deployment reader is
 * a fixed Cloudflare account/script adapter; it runs before and after probes to
 * detect observed drift. No automatic retry or production route is installed. */
export class CloudflareReleaseObserver {
  private readonly config: z.infer<typeof configSchema>;
  constructor(
    rawConfig: unknown,
    private readonly credentials: {
      analyticsToken: string;
      probeSecret: string;
      previewBearer: string;
    },
    private readonly readCurrent: (
      component: "app" | "auth",
      signal: AbortSignal,
    ) => Promise<{ deploymentId: string; versionId: string }>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = configSchema.parse(rawConfig);
    if (this.config.target.topology === "single" && this.config.target.environment !== "production")
      throw new Error("release_native_preview_unsupported");
    if (
      !credentials.analyticsToken ||
      !/^[a-f0-9]{64}$/.test(credentials.probeSecret) ||
      !/^[a-f0-9]{64}$/.test(credentials.previewBearer)
    )
      throw new Error("release_observer_unavailable");
  }
  targetDigest() {
    return githubSourceDigest(this.config.target);
  }
  configDigest() {
    return githubSourceDigest(this.config);
  }
  settleDelayMs() {
    return this.config.settleDelayMs;
  }
  singleWorker() {
    return this.config.target.topology === "single";
  }
  private async current(expected: z.infer<typeof observationSchema>, signal: AbortSignal) {
    if (
      this.singleWorker() &&
      githubSourceDigest(expected.app) !== githubSourceDigest(expected.auth)
    )
      throw new Error("release_observer_deployment_changed");
    for (const component of this.singleWorker() ? (["app"] as const) : (["app", "auth"] as const)) {
      const actual = await this.readCurrent(component, signal);
      if (
        actual.deploymentId !== expected[component].deploymentId ||
        actual.versionId !== expected[component].versionId
      )
        throw new Error("release_observer_deployment_changed");
    }
  }
  private async metrics(
    script: string,
    input: z.infer<typeof observationSchema>,
    signal: AbortSignal,
  ) {
    const response = await this.fetcher("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${this.credentials.analyticsToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: this.config.target.accountId,
          script,
          start: new Date(input.startedAt).toISOString(),
          end: new Date(input.endedAt).toISOString(),
        },
      }),
    });
    if (!response.ok) throw new Error("release_metrics_unavailable");
    const raw = await boundedReleaseJson(response, 262144, signal);
    const result = z
      .object({
        errors: z.array(z.unknown()).optional(),
        data: z
          .object({
            viewer: z
              .object({
                accounts: z
                  .array(
                    z
                      .object({
                        workersInvocationsAdaptive: z
                          .array(
                            z
                              .object({
                                sum: z
                                  .object({
                                    requests: z.number().nonnegative().finite(),
                                    errors: z.number().nonnegative().finite(),
                                  })
                                  .passthrough(),
                              })
                              .passthrough(),
                          )
                          .length(1),
                      })
                      .passthrough(),
                  )
                  .length(1),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(raw);
    if (result.errors?.length) throw new Error("release_metrics_unavailable");
    const values = result.data.viewer.accounts[0].workersInvocationsAdaptive[0].sum;
    if (values.requests < this.config.minimumRequests || values.errors > values.requests)
      throw new Error("release_metrics_unhealthy_or_incomplete");
    return { ...values, passed: values.errors / values.requests <= this.config.maxErrorRate };
  }
  async probe(raw: unknown, signal: AbortSignal) {
    return withReleaseDeadline((inner) => this.probeWithin(raw, inner), signal, 6000);
  }
  private async probeWithin(raw: unknown, signal: AbortSignal) {
    const input = observationSchema.parse(raw);
    await this.current(input, signal);
    const response = await this.fetcher(`${this.config.origin}${RELEASE_HEALTH_PATH}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${this.credentials.previewBearer}`,
        "X-Hive-Release-Probe": this.credentials.probeSecret,
      },
    });
    if (response.status === 503) {
      await response.body?.cancel().catch(() => {});
      await this.current(input, signal);
      if (signal.aborted) throw new Error("release_observer_aborted");
      const evidence = {
        schemaVersion: 1,
        startedAt: input.startedAt,
        endedAt: Date.now(),
        smoke: "failed",
        metrics: "unknown",
        status: 503,
        deployments: { app: input.app, auth: input.auth },
        configDigest: this.configDigest(),
      };
      return { evidence, evidenceDigest: githubSourceDigest(evidence) };
    }
    if (!response.ok) throw new Error("release_smoke_unavailable");
    const health = healthSchema.parse(await boundedReleaseJson(response, 4096, signal));
    for (const name of ["app", "auth"] as const)
      if (
        health[name].component !== name ||
        health[name].sourceSha !== input[name].sourceSha ||
        health[name].artifactDigest !== input[name].artifactDigest
      )
        throw new Error("release_smoke_identity_changed");
    await this.current(input, signal);
    if (signal.aborted) throw new Error("release_observer_aborted");
    const evidence = {
      schemaVersion: 1,
      startedAt: input.startedAt,
      endedAt: Date.now(),
      smoke: "passed",
      metrics: "unknown",
      health,
      deployments: { app: input.app, auth: input.auth },
      configDigest: this.configDigest(),
    };
    return { evidence, evidenceDigest: githubSourceDigest(evidence) };
  }
  async observe(raw: unknown, signal: AbortSignal) {
    return withReleaseDeadline((inner) => this.observeWithin(raw, inner), signal, 18000);
  }
  private async observeWithin(raw: unknown, signal: AbortSignal) {
    const input = observationSchema.parse(raw),
      now = Date.now();
    if (
      input.startedAt >= input.endedAt ||
      input.endedAt > now - this.config.settleDelayMs ||
      input.endedAt - input.startedAt > 86400000
    )
      throw new Error("release_observation_window_unavailable");
    await this.current(input, signal);
    const response = await this.fetcher(`${this.config.origin}${RELEASE_HEALTH_PATH}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${this.credentials.previewBearer}`,
        "X-Hive-Release-Probe": this.credentials.probeSecret,
      },
    });
    if (!response.ok) throw new Error("release_smoke_unavailable");
    const health = healthSchema.parse(await boundedReleaseJson(response, 4096, signal));
    for (const component of ["app", "auth"] as const) {
      const actual = health[component],
        expected = input[component];
      if (
        actual.component !== component ||
        actual.sourceSha !== expected.sourceSha ||
        actual.artifactDigest !== expected.artifactDigest
      )
        throw new Error("release_smoke_identity_changed");
    }
    const app = await this.metrics(this.config.target.scripts.app, input, signal),
      auth = this.singleWorker()
        ? app
        : await this.metrics(this.config.target.scripts.auth, input, signal);
    await this.current(input, signal);
    if (signal.aborted) throw new Error("release_observer_aborted");
    const evidence = {
      schemaVersion: 1,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      smoke: "passed",
      metrics: app.passed && auth.passed ? "passed" : "failed",
      health,
      analytics: this.singleWorker() ? { worker: app } : { app, auth },
      ...(this.singleWorker() ? { topology: "single" as const } : {}),
      deployments: { app: input.app, auth: input.auth },
      limitations: "sampled_metrics_ingestion_delay_not_a_completeness_guarantee",
      configDigest: this.configDigest(),
    };
    return { evidence, evidenceDigest: githubSourceDigest(evidence) };
  }
}

/** Native Preview identity is a separate observation type. It cannot satisfy
 * the existing lifecycle's healthy/source/build facts or promotion receipts. */
export class NativePreviewReleaseIdentityObserver {
  private readonly reader: NativePreviewReleaseReader;
  constructor(target: unknown, token: string, fetcher: typeof fetch = fetch) {
    this.reader = new NativePreviewReleaseReader(target, token, fetcher);
  }
  async observeIdentity(signal: AbortSignal) {
    try {
      const identity = await this.reader.readCurrent(signal);
      return {
        kind: "native-preview-identity" as const,
        state: "observed" as const,
        eligibility: "unverified" as const,
        identity,
      };
    } catch {
      return {
        kind: "native-preview-identity" as const,
        state: "hold" as const,
        eligibility: "unverified" as const,
      };
    }
  }
}
