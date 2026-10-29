// Installed controller callback only. Never a native dynamic tool or generic RPC.
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createGitHubCollectionJournal } from "./delivery-github-journal.mjs";

const check = (value, code) => {
  if (!value) throw new Error(code);
};
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, x]) => [key, canonical(x)]),
        )
      : value;
export const githubCollectorProofPayload = (phase, value) => {
  const { proof: _proof, ...unsigned } = value;
  const path =
    phase === "challenge" ? "/api/delivery/github-source/challenge" : "/api/delivery/github-source";
  return `hive-github-source-v1\nPOST\n${path}\n${JSON.stringify(canonical(unsigned))}`;
};
export function collectFixedGitHubSnapshot(target, timeoutMs) {
  const helper = fileURLToPath(new URL("./github-evidence.py", import.meta.url));
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(
      ["PATH", "HOME", "CODER_AGENT_URL", "CODER_AGENT_TOKEN", "CODER_AGENT_TOKEN_FILE"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    const child = spawn("/usr/bin/python3", ["-I", helper], {
      env: environment,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks = [];
    let size = 0,
      settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        reject(new Error("github_collection_failed"));
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(true), Math.max(1, Math.min(55000, timeoutMs)));
    child.on("error", () => finish(true));
    child.stdin.on("error", () => finish(true));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) finish(true);
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) return finish(true);
      try {
        finish(false, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(true);
      }
    });
    child.stdin.end(JSON.stringify(target));
  });
}
async function beforeDeadline(operation, deadline) {
  check(Date.now() < deadline, "github_source_response_timeout");
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("github_source_response_timeout")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function boundedJson(response, maximum, deadline) {
  check(response.status >= 200 && response.status < 300, "github_source_request_rejected");
  check(
    response.headers.get("content-type")?.split(";")[0] === "application/json",
    "github_source_response_invalid",
  );
  const reader = response.body?.getReader();
  check(reader, "github_source_response_invalid");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await beforeDeadline(() => reader.read(), deadline);
      if (next.done) break;
      size += next.value.length;
      check(size <= maximum, "github_source_response_limit");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export function createDeliveryGitHubCollector(options) {
  if (options.enabled !== true)
    return {
      refresh: async () => {
        throw new Error("github_collector_disabled");
      },
    };
  const {
    hiveOrigin,
    currentRegistration,
    currentProjectContext,
    hostPrivateKeyPem,
    fetchImpl = fetch,
    runHelper = collectFixedGitHubSnapshot,
  } = options;
  const origin = new URL(hiveOrigin),
    key = createPrivateKey(hostPrivateKeyPem);
  check(
    origin.protocol === "https:" &&
      origin.origin === hiveOrigin &&
      !origin.username &&
      !origin.password &&
      key.asymmetricKeyType === "ed25519",
    "github_collector_configuration_invalid",
  );
  const journal = createGitHubCollectionJournal(options.stateDirectory, hostPrivateKeyPem);
  let busy = false;
  return {
    async refresh(input) {
      check(
        input &&
          Object.keys(input).every((key) =>
            ["managerThreadId", "taskId", "stepId", "requestId"].includes(key),
          ) &&
          uuid(input.taskId) &&
          uuid(input.stepId),
        "github_collector_request_invalid",
      );
      check(!busy, "github_collector_busy");
      busy = true;
      try {
        const registration = currentRegistration(),
          checkoutBinding = structuredClone(currentProjectContext(input.managerThreadId));
        check(
          registration?.expiresAt > Date.now() &&
            registration.threads.some(
              (t) =>
                t.threadId === input.managerThreadId && t.projectId === checkoutBinding?.projectId,
            ),
          "github_collector_registration_unavailable",
        );
        const base = {
          schemaVersion: 1,
          action: "collect_github_evidence",
          registrationId: registration.id,
          serverInstanceId: registration.serverInstanceId,
          managerThreadId: input.managerThreadId,
          checkoutBinding,
          taskId: input.taskId,
          stepId: input.stepId,
        };
        const send = async (phase, payload) => {
          const now = Date.now(),
            value = {
              ...base,
              ...payload,
              issuedAt: now,
              expiresAt: Math.min(now + 30000, currentRegistration()?.expiresAt ?? 0),
            };
          const proof = sign(
            null,
            Buffer.from(githubCollectorProofPayload(phase, value)),
            key,
          ).toString("base64url");
          const path =
            phase === "challenge"
              ? "/api/delivery/github-source/challenge"
              : "/api/delivery/github-source";
          const deadline = Date.now() + 10000;
          const result = await beforeDeadline(
            () =>
              fetchImpl(`${hiveOrigin}${path}`, {
                method: "POST",
                redirect: "manual",
                credentials: "omit",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...value, proof }),
                signal: AbortSignal.timeout(10000),
              }),
            deadline,
          );
          return boundedJson(result, 65536, deadline);
        };
        const requestId = input.requestId ?? randomUUID();
        check(uuid(requestId), "github_collector_request_invalid");
        const contextDigest = createHash("sha256")
          .update(JSON.stringify(canonical(base)))
          .digest("hex");
        let saved = journal.read(requestId);
        check(!saved || saved.contextDigest === contextDigest, "github_journal_scope_conflict");
        const freshChallenge = !saved;
        if (!saved) {
          saved = { requestId, contextDigest, challenge: await send("challenge", { requestId }) };
        }
        const challenge = saved.challenge;
        const target = challenge?.target;
        const providerId = (value) => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
        check(
          challenge?.id === requestId &&
            Object.keys(challenge).length === 9 &&
            challenge.schemaVersion === 1 &&
            challenge.action === base.action &&
            challenge.registrationId === registration.id &&
            uuid(challenge.managerBindingId) &&
            /^[a-f0-9]{64}$/.test(challenge.nonce) &&
            /^[a-f0-9]{64}$/.test(challenge.policyDigest) &&
            Number.isSafeInteger(challenge.expiresAt) &&
            challenge.expiresAt > Date.now() &&
            challenge.expiresAt <= Date.now() + 60000 &&
            target?.schemaVersion === 1 &&
            Object.keys(target).length === 6 &&
            providerId(target.providerRepositoryId) &&
            providerId(target.providerAccountId) &&
            typeof target.fullName === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(target.fullName) &&
            ![".", ".."].includes(target.fullName.split("/")[1]) &&
            Number.isSafeInteger(target.pullNumber) &&
            target.pullNumber > 0 &&
            target.pullNumber <= 2147483647 &&
            typeof target.expectedHeadSha === "string" &&
            /^[a-f0-9]{40}$/.test(target.expectedHeadSha) &&
            target.providerRepositoryId === checkoutBinding.repositoryId &&
            target.expectedHeadSha === checkoutBinding.revision,
          "github_collector_challenge_invalid",
        );
        if (freshChallenge) {
          saved = { ...saved, challengeValidated: true };
          journal.write(requestId, saved);
        }
        const snapshot = Object.hasOwn(saved, "snapshot")
          ? structuredClone(saved.snapshot)
          : await runHelper(
              structuredClone(challenge.target),
              challenge.expiresAt - Date.now() - 1000,
            );
        check(
          Buffer.byteLength(JSON.stringify(snapshot)) <= 1024 * 1024,
          "github_collector_snapshot_limit",
        );
        if (!Object.hasOwn(saved, "snapshot")) {
          saved = { ...saved, snapshot };
          journal.write(requestId, saved);
        }
        const current = currentRegistration();
        check(
          current?.id === registration.id &&
            current.serverInstanceId === registration.serverInstanceId &&
            current.expiresAt > Date.now() &&
            JSON.stringify(canonical(currentProjectContext(input.managerThreadId))) ===
              JSON.stringify(canonical(checkoutBinding)) &&
            challenge.expiresAt > Date.now(),
          "github_collector_lifetime_changed",
        );
        return send("snapshot", {
          challengeId: challenge.id,
          nonce: challenge.nonce,
          policyDigest: challenge.policyDigest,
          snapshot,
        });
      } finally {
        busy = false;
      }
    },
  };
}
