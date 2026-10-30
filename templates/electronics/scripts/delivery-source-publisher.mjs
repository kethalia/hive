// Inert installed-host capability. No native HTTP/RPC entry or default factory.
import { spawn } from "node:child_process";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sourceCanonical as canonical,
  sourceCheck as check,
  createSourcePublisherJournal,
  sourceDigest as digest,
  sourceUuid as uuid,
} from "./delivery-source-publisher-journal.mjs";

const hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
  sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v),
  label = (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === keys.slice().sort().join(",");
const same = (a, b) => canonical(a) === canonical(b);
const copy = (value) => JSON.parse(canonical(value));
const pathFor = (phase) =>
  `/api/delivery/source-publication${phase === "publish" ? "" : `/${phase}`}`;
export const sourcePublisherProofPayload = (phase, value) => {
  check(["policy", "challenge", "publish"].includes(phase), "source_phase_invalid");
  const { proof: _proof, ...unsigned } = value;
  return `hive-source-transport-v1\nPOST\n${pathFor(phase)}\n${canonical(unsigned)}`;
};
function context(value) {
  const c = copy(value);
  check(
    exact(c, [
      "ownerId",
      "managerBindingId",
      "registration",
      "checkoutBinding",
      "taskId",
      "stepId",
      "attemptId",
      "attemptLeaseGeneration",
      "checkoutPath",
      ...(c.sourceContext ? ["sourceContext"] : []),
    ]),
    "source_context_invalid",
  );
  check(
    [c.ownerId, c.managerBindingId, c.taskId, c.stepId, c.attemptId].every(uuid) &&
      positive(c.attemptLeaseGeneration),
    "source_context_invalid",
  );
  check(
    exact(c.registration, ["id", "serverInstanceId", "expiresAt"]) &&
      uuid(c.registration.id) &&
      label(c.registration.serverInstanceId) &&
      positive(c.registration.expiresAt) &&
      c.registration.expiresAt > Date.now(),
    "source_registration_invalid",
  );
  const p = c.checkoutBinding;
  check(
    exact(p, [
      "projectId",
      "preparationIntentId",
      "repositoryId",
      "revision",
      "leaseId",
      "leaseGeneration",
    ]) &&
      [p.projectId, p.preparationIntentId, p.leaseId].every(uuid) &&
      /^[1-9][0-9]{0,19}$/.test(p.repositoryId) &&
      sha(p.revision) &&
      positive(p.leaseGeneration),
    "source_context_invalid",
  );
  if (c.sourceContext)
    check(
      exact(c.sourceContext, ["revisionId", "version", "headSha"]) &&
        uuid(c.sourceContext.revisionId) &&
        positive(c.sourceContext.version) &&
        sha(c.sourceContext.headSha),
      "source_context_invalid",
    );
  check(
    typeof c.checkoutPath === "string" &&
      resolve(c.checkoutPath) === c.checkoutPath &&
      realpathSync(c.checkoutPath) === c.checkoutPath &&
      lstatSync(c.checkoutPath).isDirectory(),
    "source_checkout_invalid",
  );
  return c;
}
const identity = (c) => ({
  ...c,
  registration: { id: c.registration.id, serverInstanceId: c.registration.serverInstanceId },
});
function proposal(value) {
  const v = copy(value);
  check(
    exact(v, ["operationId", "paths", "deletions", "message", "title", "body"]) &&
      uuid(v.operationId),
    "source_proposal_invalid",
  );
  for (const key of ["paths", "deletions"])
    check(
      Array.isArray(v[key]) &&
        v[key].length <= 100 &&
        new Set(v[key]).size === v[key].length &&
        v[key].every(
          (p) =>
            typeof p === "string" &&
            p.length <= 240 &&
            /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(p) &&
            !p
              .split("/")
              .some(
                (part) =>
                  [".", "..", ".git", ".github", ".gitmodules", ".gitattributes"].includes(
                    part.toLowerCase(),
                  ) ||
                  part.toLowerCase().startsWith(".env") ||
                  /\.(pem|key)$/i.test(part),
              ),
        ),
      "source_proposal_invalid",
    );
  check(
    v.paths.length + v.deletions.length > 0 &&
      v.paths.length + v.deletions.length <= 100 &&
      !v.paths.some((p) => v.deletions.includes(p)),
    "source_proposal_invalid",
  );
  for (const [key, max] of [
    ["message", 4000],
    ["title", 160],
    ["body", 8000],
  ])
    check(
      typeof v[key] === "string" &&
        Buffer.byteLength(v[key]) > 0 &&
        Buffer.byteLength(v[key]) <= max &&
        !v[key].includes("\0"),
      "source_proposal_invalid",
    );
  check(
    /^(feat|fix|docs|test|refactor|chore|perf|build|ci)(\([a-z0-9_-]+\))?!?: [^\r\n]+$/.test(
      v.title,
    ) &&
      /^(feat|fix|docs|test|refactor|chore|perf|build|ci)(\([a-z0-9_-]+\))?!?: [^\r\n]+/.test(
        v.message,
      ),
    "source_proposal_invalid",
  );
  return v;
}
function metadata(value, c) {
  const v = copy(value),
    keys = [
      "runtimeId",
      "runtimeGeneration",
      "admissionId",
      "admissionGeneration",
      "producerDigest",
      "checkoutIncarnation",
      "barrierGeneration",
      "metadataPins",
      "metadataPinsDigest",
      "metadataPolicyDigest",
      "namespaceReceiptDigest",
    ];
  check(
    exact(v, keys) &&
      [v.runtimeId, v.admissionId, v.checkoutIncarnation].every(uuid) &&
      [v.runtimeGeneration, v.admissionGeneration].every(positive) &&
      Number.isSafeInteger(v.barrierGeneration) &&
      v.barrierGeneration >= 0 &&
      [
        v.producerDigest,
        v.metadataPinsDigest,
        v.metadataPolicyDigest,
        v.namespaceReceiptDigest,
      ].every(hex),
    "source_metadata_unverified",
  );
  check(exact(v.metadataPins, ["checkout", "git"]), "source_metadata_unverified");
  for (const [key, path] of [
    ["checkout", c.checkoutPath],
    ["git", `${c.checkoutPath}/.git`],
  ]) {
    const pins = v.metadataPins[key];
    check(
      exact(pins, ["device", "inode"]) &&
        Object.values(pins).every(
          (n) => typeof n === "string" && /^(0|[1-9][0-9]{0,19})$/.test(n) && BigInt(n) < 2n ** 64n,
        ),
      "source_metadata_unverified",
    );
    const stat = lstatSync(path, { bigint: true });
    check(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.dev.toString() === pins.device &&
        stat.ino.toString() === pins.inode,
      "source_metadata_changed",
    );
  }
  return v;
}
const admissionOf = (v) =>
  Object.fromEntries(
    [
      "runtimeId",
      "runtimeGeneration",
      "admissionId",
      "admissionGeneration",
      "producerDigest",
      "checkoutIncarnation",
      "barrierGeneration",
    ].map((k) => [k, v[k]]),
  );
async function whileActive(operation, signal) {
  check(!signal.aborted, "source_publisher_uncertain");
  let onAbort;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        onAbort = () => reject(new Error("source_publisher_uncertain"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function jsonResponse(response, deadline) {
  check(
    response.status >= 200 &&
      response.status < 300 &&
      response.headers.get("content-type")?.split(";")[0] === "application/json",
    "source_request_rejected",
  );
  const reader = response.body?.getReader();
  check(reader, "source_response_invalid");
  let active = true,
    timer;
  try {
    return await Promise.race([
      (async () => {
        const chunks = [];
        let size = 0;
        for (let i = 0; i < 1024 && active; i++) {
          const part = await reader.read();
          check(active, "source_response_timeout");
          if (part.done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
          size += part.value.length;
          check(size <= 65536, "source_response_limit");
          chunks.push(part.value);
        }
        throw new Error("source_response_limit");
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("source_response_timeout")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
    let cancel;
    try {
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise((done) => {
          cancel = setTimeout(done, 100);
        }),
      ]);
    } finally {
      clearTimeout(cancel);
    }
  }
}

/** Fixed worker only. A callback is trusted composition, never model arguments. */
export function runFixedSourceWorker(start, exchange, { timeoutMs = 120000, signal } = {}) {
  check(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000,
    "source_worker_configuration_invalid",
  );
  return new Promise((done, reject) => {
    const env = Object.fromEntries(
      ["PATH", "HOME", "CODER_AGENT_URL", "CODER_AGENT_TOKEN", "CODER_AGENT_TOKEN_FILE"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    const child = spawn(
        "/usr/bin/python3",
        ["-I", fileURLToPath(new URL("./delivery-source-worker.py", import.meta.url))],
        { env, detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] },
      ),
      channel = child.stdio[3];
    if (!channel) {
      child.on("error", () => {});
      child.once("close", () => reject(new Error("source_worker_uncertain")));
      if (child.pid && child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      return;
    }
    let active = true,
      buffer = Buffer.alloc(0),
      total = 0,
      frames = 0,
      lastId = 0,
      result = null,
      failure = null,
      chain = Promise.resolve();
    let stop;
    const stopped = new Promise((resolve) => {
      stop = resolve;
    });
    const execution = new AbortController();
    const kill = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    const fail = () => {
      if (failure) return;
      failure = new Error("source_worker_uncertain");
      active = false;
      execution.abort();
      stop();
      kill();
      channel?.destroy();
    };
    const send = (value) => {
      check(active, "source_worker_uncertain");
      const raw = Buffer.from(`${canonical(value)}\n`);
      total += raw.length;
      check(raw.length <= 65536 && total <= 8 * 1024 * 1024, "source_worker_protocol_limit");
      channel.write(raw);
    };
    const timer = setTimeout(fail, timeoutMs),
      abort = () => fail();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) fail();
    child.on("error", fail);
    channel.on("error", fail);
    channel.on("data", (chunk) => {
      if (!active) return;
      try {
        total += chunk.length;
        check(total <= 8 * 1024 * 1024, "source_worker_protocol_limit");
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.includes(10)) {
          const end = buffer.indexOf(10);
          check(end < 65536 && ++frames <= 4096, "source_worker_protocol_limit");
          const raw = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          chain = chain
            .then(async () => {
              check(active && !result, "source_worker_protocol_invalid");
              const frame = JSON.parse(raw.toString("utf8"));
              check(
                exact(frame, ["schemaVersion", "type", "id", "value"]) &&
                  frame.schemaVersion === 1 &&
                  frame.id === lastId + 1,
                "source_worker_protocol_invalid",
              );
              lastId = frame.id;
              if (frame.type === "error") throw new Error("source_worker_failed");
              if (frame.type === "result") {
                check(
                  exact(frame.value, ["receipt", "readback"]),
                  "source_worker_protocol_invalid",
                );
                result = copy(frame.value);
                return;
              }
              check(
                ["authorize", "prepared"].includes(frame.type),
                "source_worker_protocol_invalid",
              );
              const value = await Promise.race([
                exchange(frame.type, copy(frame.value), { signal: execution.signal }),
                stopped.then(() => {
                  throw new Error("source_worker_uncertain");
                }),
              ]);
              send({
                schemaVersion: 1,
                type: frame.type === "prepared" ? "grant" : "response",
                id: frame.id,
                value,
              });
            })
            .catch(fail);
        }
        check(buffer.length <= 65536, "source_worker_protocol_limit");
      } catch {
        fail();
      }
    });
    child.once("close", async (code) => {
      await chain;
      const groupPresent = () => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return error.code !== "ESRCH";
        }
      };
      const reapDeadline = Date.now() + 1000;
      while (groupPresent() && Date.now() < reapDeadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (groupPresent()) failure = new Error("source_worker_group_unresolved");
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code !== 0 || failure || !result || buffer.length) {
        reject(failure ?? new Error("source_worker_uncertain"));
      } else done(result);
    });
    try {
      send({ schemaVersion: 1, type: "start", value: start });
    } catch {
      fail();
    }
  });
}

export function createDeliverySourcePublisher(options = {}) {
  if (options.enabled !== true)
    return {
      publish: async () => {
        throw new Error("source_publisher_disabled");
      },
      close: async () => {},
    };
  const {
    currentContext,
    authorizeMetadata,
    hiveOrigin,
    hostPrivateKeyPem,
    fetchImpl = fetch,
    runWorker = runFixedSourceWorker,
  } = options;
  const origin = new URL(hiveOrigin),
    key = createPrivateKey(hostPrivateKeyPem);
  check(
    origin.protocol === "https:" &&
      origin.origin === hiveOrigin &&
      !origin.username &&
      !origin.password &&
      key.asymmetricKeyType === "ed25519" &&
      typeof currentContext === "function" &&
      typeof authorizeMetadata === "function",
    "source_publisher_configuration_invalid",
  );
  const journal = createSourcePublisherJournal(options.stateDirectory, hostPrivateKeyPem);
  let closed = false,
    held = false,
    job = null,
    abort = null;
  async function post(phase, wire, signal) {
    const controller = new AbortController(),
      deadline = Date.now() + 10000;
    let timer;
    try {
      const incoming = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      const response = await Promise.race([
        fetchImpl(hiveOrigin + pathFor(phase), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: wire,
          redirect: "manual",
          signal: incoming,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("source_response_timeout"));
          }, 10000);
        }),
      ]);
      check(!incoming.aborted, "source_response_timeout");
      return await jsonResponse(response, deadline);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async function execute(threadId, input, signal) {
    check(!closed && label(threadId), "source_publisher_unavailable");
    const proposed = proposal(input),
      live = context(await whileActive(() => currentContext(threadId), signal));
    let state = journal.read(proposed.operationId);
    const stable = (c) => ({
      ownerId: c.ownerId,
      managerBindingId: c.managerBindingId,
      registration: { id: c.registration.id, serverInstanceId: c.registration.serverInstanceId },
      checkoutBinding: c.checkoutBinding,
      checkoutPath: c.checkoutPath,
    });
    if (state) {
      check(
        state.proposalDigest === digest(proposed) && same(stable(state.context), stable(live)),
        "source_publisher_replay_conflict",
      );
      if (!state.finalWire)
        check(state.contextDigest === digest(identity(live)), "source_publisher_context_changed");
    } else {
      state = {
        schemaVersion: 1,
        operationId: proposed.operationId,
        context: live,
        contextDigest: digest(identity(live)),
        proposal: proposed,
        proposalDigest: digest(proposed),
      };
      journal.write(proposed.operationId, state);
    }
    const save = () => {
      check(!signal.aborted, "source_publisher_uncertain");
      journal.write(state.operationId, state);
    };
    const frozen = state.context;
    const current = async () => {
      check(!signal.aborted, "source_publisher_uncertain");
      const next = context(await whileActive(() => currentContext(threadId), signal));
      check(same(identity(next), identity(frozen)), "source_publisher_context_changed");
      return next;
    };
    const signed = (phase, extra, registration = frozen.registration) => {
      const now = Date.now();
      check(registration.expiresAt > now, "source_registration_expired");
      const value = {
        schemaVersion: 1,
        action: "publish_source_revision",
        registrationId: registration.id,
        serverInstanceId: registration.serverInstanceId,
        managerThreadId: threadId,
        checkoutBinding: frozen.checkoutBinding,
        ...(frozen.sourceContext ? { sourceContext: frozen.sourceContext } : {}),
        taskId: frozen.taskId,
        stepId: frozen.stepId,
        attemptId: frozen.attemptId,
        issuedAt: now,
        expiresAt: Math.min(now + 55000, registration.expiresAt),
        ...extra,
      };
      value.proof = sign(
        null,
        Buffer.from(sourcePublisherProofPayload(phase, value)),
        key,
      ).toString("base64url");
      return canonical(value);
    };
    const final = async () => {
      check(typeof state.finalWire === "string" && state.grant, "source_publisher_uncertain");
      const result = await post("publish", state.finalWire, signal);
      check(
        !signal.aborted &&
          result.executionAuthorized === false &&
          result.sourceContext &&
          uuid(result.sourceContext.revisionId) &&
          result.sourceContext.version === state.grant.sourceVersion + 1 &&
          result.sourceContext.headSha === state.grant.target.headSha &&
          result.inputSourceSha === state.grant.parentSha &&
          typeof result.replayed === "boolean" &&
          typeof result.current === "boolean",
        "source_publication_receipt_invalid",
      );
      const receipt = {
        sourceContext: result.sourceContext,
        inputSourceSha: result.inputSourceSha,
        executionAuthorized: false,
      };
      if (state.result) check(same(state.result, receipt), "source_publication_receipt_changed");
      else {
        state.result = receipt;
        save();
      }
      return result;
    };
    if (state.finalWire) return final();
    const verifyMetadata = async () => {
      await current();
      const observed = metadata(
        await whileActive(() => authorizeMetadata(copy(frozen)), signal),
        frozen,
      );
      check(!signal.aborted, "source_publisher_uncertain");
      if (state.metadata) check(same(state.metadata, observed), "source_metadata_changed");
      else {
        state.metadata = observed;
        save();
      }
      if (state.grant)
        check(same(admissionOf(observed), state.grant.admission), "source_admission_changed");
      return observed;
    };
    await verifyMetadata();
    const fresh = await current(),
      response = await post(
        "policy",
        signed(
          "policy",
          { requestId: randomUUID(), operationId: state.operationId },
          fresh.registration,
        ),
        signal,
      );
    check(
      response.operationId === state.operationId &&
        response.parentSha === (frozen.sourceContext?.headSha ?? frozen.checkoutBinding.revision) &&
        response.sourceVersion === (frozen.sourceContext?.version ?? 0) &&
        same(response.sourceContext, frozen.sourceContext) &&
        response.repositoryId === frozen.checkoutBinding.repositoryId &&
        /^[1-9][0-9]{0,19}$/.test(response.providerAccountId) &&
        typeof response.fullName === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(response.fullName) &&
        response.branch === `codex/delivery/${frozen.taskId}/${state.operationId}` &&
        hex(response.policyDigest) &&
        digest(response.policy) === response.policyDigest &&
        positive(response.expiresAt) &&
        response.expiresAt > Date.now(),
      "source_policy_scope_changed",
    );
    const { expiresAt: _expires, ...policy } = response;
    if (state.policy) check(same(state.policy, policy), "source_policy_changed");
    else {
      state.policy = copy(policy);
      save();
    }
    const meta = await verifyMetadata();
    const reauthorize = async (workerSignal) => {
      await current();
      await verifyMetadata();
      check(
        state.grant && state.challengeWire && !workerSignal?.aborted,
        "source_publisher_uncertain",
      );
      const result = await post(
        "challenge",
        state.challengeWire,
        workerSignal ? AbortSignal.any([signal, workerSignal]) : signal,
      );
      check(
        same(result, state.grant) &&
          same(result.admission, admissionOf(state.metadata)) &&
          result.expiresAt > Date.now(),
        "source_grant_changed",
      );
      return copy(state.grant);
    };
    const start = {
      root: journal.brokerRoot(state.operationId),
      workspace: frozen.checkoutPath,
      scope: {
        ownerId: frozen.ownerId,
        taskId: frozen.taskId,
        managerBindingId: frozen.managerBindingId,
        attemptId: frozen.attemptId,
        repositoryId: policy.repositoryId,
        providerAccountId: policy.providerAccountId,
        fullName: policy.fullName,
        baseBranch: policy.policy.baseBranch,
        parentSha: policy.parentSha,
        sourceVersion: policy.sourceVersion,
        serverInstanceId: frozen.registration.serverInstanceId,
        leaseId: frozen.checkoutBinding.leaseId,
        leaseGeneration: frozen.checkoutBinding.leaseGeneration,
        checkoutIncarnation: meta.checkoutIncarnation,
      },
      policy: policy.policy,
      metadataIdentity: meta.metadataPins,
      attemptLeaseGeneration: frozen.attemptLeaseGeneration,
      request: proposed,
    };
    const result = await runWorker(
      start,
      async (type, value, control = {}) => {
        check(!signal.aborted && !control.signal?.aborted, "source_publisher_uncertain");
        if (type === "authorize") {
          check(
            exact(value, ["action"]) && ["metadata", "publication"].includes(value.action),
            "source_worker_protocol_invalid",
          );
          return value.action === "metadata"
            ? (await verifyMetadata()).metadataPins
            : reauthorize(control.signal);
        }
        check(
          type === "prepared" && exact(value, ["receipt", "challenge"]),
          "source_worker_protocol_invalid",
        );
        const material = value.challenge,
          receipt = value.receipt;
        check(
          exact(material, ["operationId", "policyDigest", "manifest", "target"]) &&
            material.operationId === state.operationId &&
            material.policyDigest === policy.policyDigest &&
            material.target &&
            sha(material.target.headSha) &&
            sha(material.target.treeSha) &&
            material.target.manifestDigest === digest(material.manifest) &&
            receipt.operationId === state.operationId &&
            ["prepared", "published"].includes(receipt.phase) &&
            receipt.commitSha === material.target.headSha &&
            receipt.treeSha === material.target.treeSha &&
            receipt.manifestDigest === material.target.manifestDigest &&
            receipt.branch === policy.branch &&
            receipt.parentSha === policy.parentSha &&
            receipt.fixtureOnly === false &&
            receipt.freshAcceptanceAuthority === false,
          "source_worker_preparation_invalid",
        );
        await verifyMetadata();
        if (state.challengeWire) {
          const previous = JSON.parse(state.challengeWire);
          check(
            same(previous.target, material.target) &&
              same(previous.manifest, material.manifest) &&
              previous.policyDigest === material.policyDigest,
            "source_sealed_bytes_changed",
          );
        } else {
          const now = await current();
          state.challengeWire = signed(
            "challenge",
            { requestId: randomUUID(), ...material },
            now.registration,
          );
          save();
        }
        const grant = await post(
          "challenge",
          state.challengeWire,
          control.signal ? AbortSignal.any([signal, control.signal]) : signal,
        );
        check(
          !signal.aborted &&
            !control.signal?.aborted &&
            grant.id === JSON.parse(state.challengeWire).requestId &&
            grant.action === "publish_source_revision" &&
            grant.schemaVersion === 1 &&
            grant.registrationId === frozen.registration.id &&
            grant.ownerId === frozen.ownerId &&
            grant.managerBindingId === frozen.managerBindingId &&
            grant.taskId === frozen.taskId &&
            grant.stepId === frozen.stepId &&
            grant.attemptId === frozen.attemptId &&
            grant.operationId === state.operationId &&
            same(grant.target, material.target) &&
            same(grant.policy, policy.policy) &&
            grant.policyDigest === policy.policyDigest &&
            grant.repositoryId === policy.repositoryId &&
            grant.providerAccountId === policy.providerAccountId &&
            grant.fullName === policy.fullName &&
            grant.branch === policy.branch &&
            grant.parentSha === policy.parentSha &&
            grant.sourceVersion === policy.sourceVersion &&
            same(grant.sourceContext, frozen.sourceContext) &&
            grant.leaseGeneration === frozen.attemptLeaseGeneration &&
            positive(grant.cursorVersion) &&
            positive(grant.nativeSequence) &&
            hex(grant.checkoutBindingDigest) &&
            hex(grant.nonce) &&
            positive(grant.expiresAt) &&
            grant.expiresAt > Date.now() &&
            same(grant.admission, admissionOf(state.metadata)),
          "source_grant_scope_changed",
        );
        if (state.grant) check(same(state.grant, grant), "source_grant_changed");
        else {
          state.grant = copy(grant);
          save();
        }
        return copy(state.grant);
      },
      { timeoutMs: options.workerTimeoutMs ?? 120000, signal },
    );
    check(
      !signal.aborted &&
        exact(result, ["receipt", "readback"]) &&
        result.receipt?.phase === "published" &&
        result.receipt.operationId === state.operationId &&
        result.receipt.commitSha === state.grant?.target.headSha &&
        result.readback &&
        same(result.readback.manifest, JSON.parse(state.challengeWire).manifest),
      "source_publication_uncertain",
    );
    const end = await current();
    await verifyMetadata();
    state.finalWire = signed(
      "publish",
      { challengeId: state.grant.id, nonce: state.grant.nonce, readback: result.readback },
      end.registration,
    );
    save();
    return final();
  }
  return {
    publish(thread, proposed) {
      check(!closed && !held && !job, "source_publisher_busy");
      const controller = new AbortController();
      abort = controller;
      const budget = options.workerTimeoutMs ?? 120000;
      check(
        Number.isSafeInteger(budget) && budget > 0 && budget <= 120000,
        "source_publisher_configuration_invalid",
      );
      const timer = setTimeout(() => controller.abort(), budget);
      job = execute(thread, proposed, controller.signal)
        .catch((error) => {
          if (error?.message === "source_worker_group_unresolved") held = true;
          throw new Error(
            /^source_[a-z0-9_]+$/.test(error?.message ?? "")
              ? error.message
              : "source_publisher_uncertain",
          );
        })
        .finally(() => {
          clearTimeout(timer);
          controller.abort();
          job = null;
          abort = null;
        });
      return job;
    },
    async close() {
      closed = true;
      abort?.abort();
      try {
        await job;
      } catch {}
      check(!held, "source_worker_group_unresolved");
      journal.close();
    },
  };
}
