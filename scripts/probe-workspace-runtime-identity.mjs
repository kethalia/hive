#!/usr/bin/env node
// Explicitly authorized read-only acceptance only. No workspace/template mutation.
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPrivateKey, randomUUID, sign, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  PRIVATE = "/tmp/hive-epic-coder-auth",
  CODER = "https://coder.kethalia.com",
  REF = "codex/delivery-system-design",
  HASH = /^[a-f0-9]{64}$/,
  UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  sha = (raw) => createHash("sha256").update(raw).digest("hex");

const SAFE_FAILURES = new Set([
  "probe_rejected",
  "invalid_plan",
  "private_input_rejected",
  "private_scope_rejected",
  "http_budget_exhausted",
  "transport_scope_rejected",
  "receipt_transport_failed",
  "receipt_verification_failed",
  "probe_ca_override_unsupported",
  "workspace_identity_changed",
  "app_agent_mismatch",
  "existing_web_session_missing",
  "cwd_not_verified",
  "path_results_invalid",
  "read_lifetime_changed",
  "project_catalog_scope_mismatch",
  "project_resolve_scope_mismatch",
  "epic_ref_mismatch",
  "workspace_app_changed",
  "disabled",
  "invalid_response",
  "workspace_unavailable",
  "read_unavailable",
  "tmux_unavailable",
  "tmux_timeout",
  "directory_unavailable",
  "github_auth_required",
]);
export function safeFailureCode(error) {
  return SAFE_FAILURES.has(error?.code)
    ? error.code
    : SAFE_FAILURES.has(error?.message)
      ? error.message
      : "bounded_probe_failed";
}

export const LIMITS = Object.freeze({ http: 80, milliseconds: 90000, ssh: 1 });
export function check(value, code = "probe_rejected") {
  if (!value) throw new Error(code);
}
export function parsePlan(value) {
  const fields = [
    "schemaVersion",
    "workspaceId",
    "ownerId",
    "templateId",
    "templateVersionId",
    "buildId",
    "imageDigest",
    "imageSourceSha",
    "helperSha256",
    "readArchiveSha256",
    "readManifestSha256",
    "hostArchiveSha256",
    "hostManifestSha256",
    "hiveOrigin",
    "githubAccountId",
    "repositoryId",
    "expectedRefSha",
    "projectsRoot",
    "sessionName",
    "expectedCwd",
  ];
  check(
    value &&
      typeof value === "object" &&
      Object.keys(value).length === fields.length &&
      fields.every((k) => Object.hasOwn(value, k)),
    "invalid_plan",
  );
  check(
    value.schemaVersion === 1 &&
      fields.filter((k) => k !== "schemaVersion").every((k) => typeof value[k] === "string"),
    "invalid_plan",
  );
  for (const k of ["workspaceId", "ownerId", "templateId", "templateVersionId", "buildId"])
    check(UUID.test(value[k]), "invalid_plan");
  for (const k of [
    "helperSha256",
    "readArchiveSha256",
    "readManifestSha256",
    "hostArchiveSha256",
    "hostManifestSha256",
  ])
    check(HASH.test(value[k]), "invalid_plan");
  check(
    /^sha256:[a-f0-9]{64}$/.test(value.imageDigest) &&
      /^[a-f0-9]{40}$/.test(value.imageSourceSha) &&
      /^[a-f0-9]{40}$/.test(value.expectedRefSha),
    "invalid_plan",
  );
  for (const k of ["githubAccountId", "repositoryId"])
    check(/^[1-9][0-9]{0,19}$/.test(value[k]), "invalid_plan");
  const hive = new URL(value.hiveOrigin);
  check(
    hive.protocol === "https:" &&
      hive.origin === value.hiveOrigin &&
      !hive.username &&
      !hive.password,
    "invalid_plan",
  );
  check(
    value.projectsRoot === "/home/coder" &&
      /^[A-Za-z0-9._-]{1,200}$/.test(value.sessionName) &&
      !value.sessionName.startsWith("git-clone-"),
    "invalid_plan",
  );
  check(
    typeof value.expectedCwd === "string" &&
      (value.expectedCwd === "/home/coder" || value.expectedCwd.startsWith("/home/coder/")) &&
      !value.expectedCwd.split("/").includes("..") &&
      !Array.from(value.expectedCwd).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    "invalid_plan",
  );
  return value;
}
function privateFile(path, max) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    check(
      s.isFile() &&
        s.uid === process.getuid() &&
        s.nlink === 1 &&
        !(s.mode & 0o077) &&
        s.size <= max,
      "private_input_rejected",
    );
    const bytes = readFileSync(fd);
    check(bytes.length <= max && bytes.length === s.size, "private_input_rejected");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
const same = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function createFetchGuard(plan, token, signal, fetchImpl) {
  const apps = new Map(),
    counts = { total: 0, blocked: 0 },
    statuses = {};
  const add = (binding, type) => apps.set(binding.appOrigin, { binding, type });
  async function fetchGuard(input, init = {}) {
    signal.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : input),
      method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    let category;
    try {
      check(counts.total < LIMITS.http, "http_budget_exhausted");
      check(
        url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          init.redirect === "manual",
        "transport_scope_rejected",
      );
      if (url.origin === CODER) {
        check(
          method === "GET" &&
            same(headers.get("Coder-Session-Token") ?? "", token) &&
            !headers.has("Cookie") &&
            !headers.has("Authorization"),
          "transport_scope_rejected",
        );
        const simple = [
          `/api/v2/workspaces/${plan.workspaceId}`,
          `/api/v2/workspacebuilds/${plan.buildId}/resources`,
          "/api/v2/applications/host",
        ];
        if (simple.includes(url.pathname)) check(!url.search, "transport_scope_rejected");
        else {
          check(
            url.pathname === "/api/v2/applications/auth-redirect" &&
              [...url.searchParams.keys()].join() === "redirect_uri",
            "transport_scope_rejected",
          );
          const target = new URL(url.searchParams.get("redirect_uri"));
          const app = apps.get(target.origin);
          check(
            app &&
              !target.search &&
              !target.hash &&
              (app.type === "read"
                ? target.pathname === "/workspace/read"
                : ["/projects/discover", "/projects/resolve", "/projects/resolve-ref"].includes(
                    target.pathname,
                  )),
            "transport_scope_rejected",
          );
        }
        category = "coderRead";
      } else {
        const app = apps.get(url.origin);
        check(
          app && !headers.has("Coder-Session-Token") && !headers.has("Authorization"),
          "transport_scope_rejected",
        );
        check(
          app.type === "read"
            ? url.pathname === "/workspace/read"
            : ["/projects/discover", "/projects/resolve", "/projects/resolve-ref"].includes(
                url.pathname,
              ),
          "transport_scope_rejected",
        );
        if (method === "GET") {
          check(
            [...url.searchParams.keys()].join() === "coder_application_connect_api_key_35e783" &&
              url.searchParams.get("coder_application_connect_api_key_35e783") &&
              !headers.has("Cookie"),
            "transport_scope_rejected",
          );
          category = "appCookieExchange";
        } else {
          check(
            method === "POST" &&
              !url.search &&
              /^coder_subdomain_app_session_token_[a-f0-9]{32}=[A-Za-z0-9_-]{1,512}$/.test(
                headers.get("Cookie") ?? "",
              ),
            "transport_scope_rejected",
          );
          check(
            typeof init.body === "string" && Buffer.byteLength(init.body) <= 20000,
            "transport_scope_rejected",
          );
          const body = JSON.parse(init.body);
          check(
            Object.keys(body).join() === "ticket" && typeof body.ticket === "string",
            "transport_scope_rejected",
          );
          const claims = JSON.parse(Buffer.from(body.ticket.split(".")[1], "base64url").toString());
          check(
            claims.aud === app.binding.appOrigin &&
              claims.binding.workspaceId === plan.workspaceId &&
              claims.binding.buildId === plan.buildId &&
              claims.binding.agentId === app.binding.agentId,
            "transport_scope_rejected",
          );
          if (app.type === "read")
            check(
              claims.scope === "workspace:read:v1" &&
                ["identity", "sessions", "directory", "paths"].includes(claims.request.operation),
              "transport_scope_rejected",
            );
          else
            check(
              claims.scope ===
                {
                  "/projects/discover": "projects:discover",
                  "/projects/resolve": "projects:resolve",
                  "/projects/resolve-ref": "projects:resolve-ref",
                }[url.pathname],
              "transport_scope_rejected",
            );
          category = app.type === "read" ? "readPost" : "projectPost";
        }
      }
    } catch (error) {
      counts.blocked++;
      throw error;
    }
    counts.total++;
    const response = await fetchImpl(input, {
      ...init,
      signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
    });
    const key = `${category}:${response.status}`;
    statuses[key] = (statuses[key] ?? 0) + 1;
    return response;
  }
  return { fetch: fetchGuard, add, counts, statuses };
}
async function inspectRemote(input, token, scratch, signal) {
  signal.throwIfAborted();
  const code = readFileSync(join(ROOT, "scripts/probe-workspace-runtime-identity.py"), "utf8"),
    quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
  const configDir = join(scratch, "coder-empty");
  mkdirSync(configDir, { mode: 0o700 });
  return await new Promise((done, reject) => {
    const child = spawn(
      "coder",
      [
        "--global-config",
        configDir,
        "ssh",
        "--wait=yes",
        "codex/hive-epic-test",
        "--",
        "/usr/bin/python3",
        "-c",
        quote(code),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: scratch,
          CODER_URL: CODER,
          CODER_SESSION_TOKEN: token,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let size = 0,
      output = "",
      exited = false;
    const stop = () => {
        if (!exited) child.kill("SIGKILL");
      },
      timer = setTimeout(stop, 15000);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size > 32768) stop();
      else output += b.toString();
    });
    child.stderr.on("data", (b) => {
      size += b.length;
      if (size > 32768) stop();
    });
    child.on("error", () => reject(new Error("receipt_transport_failed")));
    child.on("close", (status) => {
      exited = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      try {
        check(status === 0 && size <= 32768, "receipt_transport_failed");
        const value = JSON.parse(output);
        check(value.schemaVersion === 1 && value.passed === true, "receipt_verification_failed");
        done(value);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
async function run(plan) {
  check(!process.env.CODER_CA_CERT?.trim(), "probe_ca_override_unsupported");
  const user = JSON.parse(privateFile(`${PRIVATE}/preview-user.json`, 16384)),
    issuer = JSON.parse(privateFile(`${PRIVATE}/project-host-identity.json`, 32768)),
    token = privateFile(`${PRIVATE}/session`, 8192).toString().trim();
  check(
    UUID.test(user.hiveUserId) &&
      user.coderUserId === plan.ownerId &&
      token &&
      !/\s/.test(token) &&
      /^[A-Za-z0-9._-]{1,64}$/.test(issuer.keyId) &&
      createPrivateKey(issuer.privateKeyPem).asymmetricKeyType === "ed25519",
    "private_scope_rejected",
  );
  const [
    { CoderClient },
    { resolveVerifiedWorkspaceHost },
    { WorkspaceReadClient },
    { requestVerifiedWorkspaceRead, postToVerifiedWorkspaceApp },
    { projectPageSchema, repositoryProjectSchema },
  ] = await Promise.all([
    import("../src/lib/coder/client.ts"),
    import("../src/lib/codex-session/registration.server.ts"),
    import("../src/lib/workspaces/read-client.server.ts"),
    import("../src/lib/codex-session/bootstrap-delivery.server.ts"),
    import("../src/lib/projects/contracts.ts"),
  ]);
  const signal = AbortSignal.timeout(LIMITS.milliseconds),
    originalFetch = globalThis.fetch,
    guard = createFetchGuard(plan, token, signal, originalFetch),
    observations = [],
    scratch = mkdtempSync(join(tmpdir(), "hive-runtime-read-acceptance-"));
  globalThis.fetch = guard.fetch;
  const proof = {
    schemaVersion: 1,
    passed: false,
    stage: "fresh_owner_build",
    scope: {
      workspaceId: plan.workspaceId,
      ownerId: plan.ownerId,
      templateId: plan.templateId,
      templateVersionId: plan.templateVersionId,
      buildId: plan.buildId,
      imageDigest: plan.imageDigest,
      imageSourceSha: plan.imageSourceSha,
    },
    limits: LIMITS,
    checks: {},
    counts: guard.counts,
    statuses: guard.statuses,
    scratch,
    workspaceOrTemplateMutations: false,
    projectOrTmuxCreation: false,
    githubWrites: false,
    authorizationBookkeepingMayAdvance: true,
    accountInference: false,
  };
  try {
    const coder = new CoderClient({ baseUrl: CODER, sessionToken: token, signal }),
      principal = { hiveUserId: user.hiveUserId, coderUserId: user.coderUserId };
    const verifyWorkspace = async () => {
      const w = await coder.getWorkspace(plan.workspaceId);
      check(
        w.id === plan.workspaceId &&
          w.owner_id === plan.ownerId &&
          w.owner_name === "codex" &&
          w.name === "hive-epic-test" &&
          w.template_id === plan.templateId &&
          w.latest_build.id === plan.buildId &&
          w.latest_build.template_version_id === plan.templateVersionId &&
          w.latest_build.status === "running",
        "workspace_identity_changed",
      );
    };
    const binding = async (appSlug, gatewayPort) =>
      (
        await resolveVerifiedWorkspaceHost(
          {
            hiveOrigin: plan.hiveOrigin,
            softwareTemplateIds: [plan.templateId],
            appSlug,
            gatewayPort,
            cookieDomains: [],
          },
          async () => coder,
          principal,
          plan.workspaceId,
        )
      ).binding;
    await verifyWorkspace();
    const readBinding = await binding("hive-read", 13342),
      hostBinding = await binding("codex-session", 13341);
    check(readBinding.agentId === hostBinding.agentId, "app_agent_mismatch");
    guard.add(readBinding, "read");
    guard.add(hostBinding, "host");
    proof.checks.freshOwnerBuildAgentApp = true;
    proof.stage = "signed_read_operations";
    const client = new WorkspaceReadClient(
      {
        privateKeyPem: issuer.privateKeyPem,
        keyId: issuer.keyId,
        hiveOrigin: plan.hiveOrigin,
        profile: "software",
        manifestSha256: plan.readManifestSha256,
        projectsRoot: plan.projectsRoot,
        home: "/home/coder",
      },
      coder,
      readBinding,
      async (...args) => {
        const v = await requestVerifiedWorkspaceRead(...args);
        if (v?.operation === "identity") observations.push(v);
        return v;
      },
    );
    const sessions = await client.read({ operation: "sessions" }, signal);
    check(
      sessions.sessions.some((s) => s.name === plan.sessionName),
      "existing_web_session_missing",
    );
    const cwd = await client.read(
      { operation: "directory", sessionName: plan.sessionName },
      signal,
    );
    check(cwd.state === "present" && cwd.cwd === plan.expectedCwd, "cwd_not_verified");
    const paths = await client.read(
      {
        operation: "paths",
        sessionName: plan.sessionName,
        paths: [
          "/home/coder",
          "/home/coder/.config/hive/workspace-read.json",
          "/etc/passwd",
          `/home/coder/.hive-read-probe-absent-${randomUUID()}`,
        ],
      },
      signal,
    );
    check(
      paths.source === "tmux" &&
        paths.cwd === plan.expectedCwd &&
        paths.candidates.map((x) => x.status).join() ===
          "directory,file,outside_supported_root,missing",
      "path_results_invalid",
    );
    check(
      observations.length === 3 &&
        observations.every((x) => x.lifetimeId === observations[0].lifetimeId),
      "read_lifetime_changed",
    );
    Object.assign(proof.checks, {
      signedReadIdentityVerified: true,
      signedSessionsVerified: true,
      signedCwdVerified: true,
      signedPathsVerified: true,
      outsideRootExplicit: true,
    });
    proof.stage = "signed_project_reads";
    const post = async (path, request) => {
      const now = Math.floor(Date.now() / 1000),
        claims = {
          iss: plan.hiveOrigin,
          aud: hostBinding.appOrigin,
          scope: {
            "/projects/discover": "projects:discover",
            "/projects/resolve": "projects:resolve",
            "/projects/resolve-ref": "projects:resolve-ref",
          }[path],
          jti: randomUUID(),
          iat: now,
          exp: now + 45,
          binding: hostBinding,
          request,
        };
      const encoded = [{ alg: "EdDSA", typ: "JWT", kid: issuer.keyId }, claims]
        .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url"))
        .join(".");
      const ticket = `${encoded}.${sign(null, Buffer.from(encoded), createPrivateKey(issuer.privateKeyPem)).toString("base64url")}`;
      return postToVerifiedWorkspaceApp(coder, hostBinding, {
        path,
        body: JSON.stringify({ ticket }),
        expiresAt: claims.exp,
        signal,
      });
    };
    const page = projectPageSchema.parse(
      await post("/projects/discover", { schemaVersion: 1, page: 1, perPage: 100 }),
    );
    check(
      page.providerAccountId === plan.githubAccountId &&
        page.repositories.some(
          (r) => r.fullName === "kethalia/hive" && r.providerRepositoryId === plan.repositoryId,
        ),
      "project_catalog_scope_mismatch",
    );
    const request = {
        schemaVersion: 1,
        repositoryId: plan.repositoryId,
        expectedAccountId: plan.githubAccountId,
      },
      resolved = await post("/projects/resolve", request),
      ref = await post("/projects/resolve-ref", { ...request, branch: REF });
    for (const value of [resolved, ref])
      check(
        value.schemaVersion === 1 &&
          value.providerAccountId === plan.githubAccountId &&
          repositoryProjectSchema.parse(value.repository).fullName === "kethalia/hive" &&
          value.repository.providerRepositoryId === plan.repositoryId,
        "project_resolve_scope_mismatch",
      );
    check(
      /^[a-f0-9]{40}$/.test(resolved.defaultRevision) &&
        ref.branch === REF &&
        ref.revision === plan.expectedRefSha,
      "epic_ref_mismatch",
    );
    Object.assign(proof.checks, {
      projectDiscoveryVerified: true,
      projectResolveVerified: true,
      exactEpicRefVerified: true,
    });
    proof.stage = "runtime_receipts";
    await verifyWorkspace();
    check(
      JSON.stringify(await binding("hive-read", 13342)) === JSON.stringify(readBinding) &&
        JSON.stringify(await binding("codex-session", 13341)) === JSON.stringify(hostBinding),
      "workspace_app_changed",
    );
    proof.counts.ssh = 1;
    proof.runtime = await inspectRemote(
      { plan, readBinding, hostBinding, readLifetimeId: observations[0].lifetimeId },
      token,
      scratch,
      signal,
    );
    await verifyWorkspace();
    proof.checks.ownerBuildStableAfterInspection = true;
    proof.passed = true;
    proof.stage = "complete";
  } catch (error) {
    proof.failureCode = safeFailureCode(error);
  } finally {
    globalThis.fetch = originalFetch;
  }
  proof.limitations = [
    "Whole image digest comes from the parent-reviewed deployment record; runtime helper/component hashes are independently observed.",
    "The80-request counter covers direct fetches. One SSH session has a separate15s client deadline; its protocol traffic is not included in that counter.",
    "No workspace/template configuration changes, tmux creation, project enrollment, native inference or GitHub writes are performed. Scoped app authentication and replay ledgers may advance.",
    "Transport abort/SSH client termination is not evidence of kernel quiescence; all operations are bounded reads.",
  ];
  return proof;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  try {
    check(
      process.argv.length === 6 && process.argv[2] === "--run" && process.argv[4] === "--evidence",
      "explicit_run_required",
    );
    const planPath = resolve(process.argv[3]);
    output = resolve(process.argv[5]);
    check(
      planPath.startsWith(`${PRIVATE}/`) &&
        output.startsWith(join(ROOT, "docs/checks/autonomous-delivery/")) &&
        output.endsWith(".json"),
      "probe_path_rejected",
    );
    const plan = parsePlan(JSON.parse(privateFile(planPath, 16384))),
      tested = [
        "scripts/probe-workspace-runtime-identity.mjs",
        "scripts/probe-workspace-runtime-identity.py",
        "src/lib/coder/client.ts",
        "src/lib/coder/fetch.ts",
        "src/lib/codex-session/registration.server.ts",
        "src/lib/codex-session/bootstrap-delivery.server.ts",
        "src/lib/workspaces/read-client.server.ts",
        "src/lib/workspaces/read-contracts.ts",
        "src/lib/projects/contracts.ts",
        "src/lib/security/workspace-app-isolation.ts",
        "pnpm-lock.yaml",
      ],
      sources = Object.fromEntries(tested.map((p) => [p, sha(readFileSync(join(ROOT, p)))]));
    const proof = await run(plan);
    proof.createdAt = new Date().toISOString();
    proof.sourceDigests = sources;
    proof.sourceStable = tested.every((p) => sha(readFileSync(join(ROOT, p))) === sources[p]);
    proof.passed = proof.passed && proof.sourceStable;
    const json = `${JSON.stringify(proof, null, 2)}\n`;
    let formatted = json;
    try {
      formatted = execFileSync("pnpm", ["exec", "biome", "format", `--stdin-file-path=${output}`], {
        cwd: ROOT,
        input: json,
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {}
    writeFileSync(output, formatted, { flag: "wx", mode: 0o600 });
    console.log(
      JSON.stringify({
        passed: proof.passed,
        stage: proof.stage,
        http: proof.counts.total,
        evidence: output,
      }),
    );
    process.exitCode = proof.passed ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ passed: false, stage: "probe_rejected" }));
    process.exitCode = 1;
  }
}
