import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createAccountWire, createCodexAccountManager } from "./codex-account.mjs";
import { validManagementRequest } from "./codex-management.mjs";

const root = "/unused/.local/share/hive/codex-native/codex";
function fixture({
  loseWrite = false,
  noUsage = false,
  noLimits = false,
  busy = false,
  foreignConfig = false,
  fresh = false,
} = {}) {
  const calls = [],
    events = [],
    lifetimeId = randomUUID();
  let version = fresh
      ? "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
      : "version-1",
    current = {
      model: "gpt-model",
      review_model: null,
      model_reasoning_effort: "high",
      model_verbosity: "medium",
      web_search: "cached",
      service_tier: "standard",
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
      api_key: "DO-NOT-RETURN",
    };
  let opened = 0,
    releases = 0;
  const manager = createCodexAccountManager({
    home: "/unused",
    profile: "software",
    lifetimeId,
    acquire() {
      if (busy) throw Error("locked");
      return {
        fd: 3,
        close() {
          releases++;
          events.push("unlock");
        },
      };
    },
    async open(_home, fd) {
      assert.equal(fd, 3);
      const process = ++opened;
      events.push(`open:${process}`);
      return {
        async call(method, params) {
          calls.push([method, params]);
          if (method === "account/read") return { account: { type: "chatgpt" } };
          if (method === "account/login/start")
            return {
              type: "chatgptDeviceCode",
              loginId: "login",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-1234",
            };
          if (method === "account/rateLimits/read") {
            if (noLimits) throw Error("unsupported");
            return {
              rateLimits: { credits: { balance: "12", unlimited: false } },
              rateLimitsByLimitId: {
                codex: {
                  limitName: "Codex",
                  primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1000 },
                  secondary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 2000 },
                },
              },
              token: "DO-NOT-RETURN",
            };
          }
          if (method === "account/usage/read") {
            if (noUsage) throw Error("unsupported");
            return {
              summary: { lifetimeTokens: 120, peakDailyTokens: 100 },
              dailyUsageBuckets: [{ startDate: "2026-11-16", tokens: 20 }],
              accessToken: "DO-NOT-RETURN",
            };
          }
          if (method === "config/read")
            return {
              config: current,
              layers: [
                {
                  name: {
                    type: "user",
                    file: foreignConfig ? "/other/config.toml" : `${root}/config.toml`,
                  },
                  version,
                },
              ],
              origins: { model: { name: { type: "user", file: "/private" } } },
            };
          if (method === "model/list")
            return {
              data: [
                {
                  model: "gpt-model",
                  displayName: "GPT Model",
                  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
                  serviceTiers: [
                    { id: "standard", name: "Standard" },
                    { id: "fast", name: "Fast" },
                  ],
                  credential: "DO-NOT-RETURN",
                },
              ],
              nextCursor: null,
            };
          if (method === "config/batchWrite") {
            assert.equal(params.expectedVersion, version);
            assert.equal(params.filePath, `${root}/config.toml`);
            assert.equal(params.reloadUserConfig, true);
            for (const edit of params.edits) {
              assert.equal(edit.mergeStrategy, "replace");
              current = { ...current, [edit.keyPath]: edit.value };
            }
            version = "version-2";
            events.push("write");
            if (loseWrite) throw Error("lost acknowledgement");
            return { status: "ok" };
          }
          throw Error("unexpected method");
        },
        async close() {
          events.push(`close:${process}`);
        },
      };
    },
  });
  return {
    manager,
    calls,
    events,
    lifetimeId,
    opened: () => opened,
    releases: () => releases,
    command: (action, generation = 0, extra = {}) =>
      manager.manage({ action, lifetimeId, generation, ...extra }),
  };
}

test("usage reads native windows/credits/tokens and excludes credentials", async () => {
  const f = fixture();
  try {
    const view = await f.command("usage");
    assert.equal(view.outcome, "read");
    assert.equal(view.generation, 0);
    assert.deepEqual(view.usage.windows[0], {
      id: "codex",
      name: "Codex",
      primary: { usedPercent: 30, minutes: 300, resetsAt: 1000 },
      secondary: { usedPercent: 15, minutes: 10080, resetsAt: 2000 },
    });
    assert.equal(view.usage.tokens.lifetime, 120);
    assert.deepEqual(view.usage.credits, { balance: "12", unlimited: false });
    assert.equal(JSON.stringify(view).includes("DO-NOT-RETURN"), false);
    assert.deepEqual(
      f.calls.map(([method]) => method).sort(),
      ["account/rateLimits/read", "account/usage/read"].sort(),
    );
    assert.equal(f.releases(), 1);
  } finally {
    await f.manager.close();
  }
});

test("unsupported usage methods expose partial availability without invented zero usage", async () => {
  for (const options of [{ noUsage: true }, { noLimits: true }]) {
    const f = fixture(options);
    try {
      const { usage } = await f.command("usage");
      assert.equal(usage.usageAvailable, !options.noUsage);
      assert.equal(usage.limitsAvailable, !options.noLimits);
      if (options.noUsage) assert.equal(usage.tokens, null);
      if (options.noLimits) assert.deepEqual(usage.windows, []);
    } finally {
      await f.manager.close();
    }
  }
  const f = fixture({ noUsage: true, noLimits: true });
  try {
    await assert.rejects(f.command("usage"));
  } finally {
    await f.manager.close();
  }
});

test("config projects the reviewed settings, models and origins while keeping approval/sandbox read-only", async () => {
  const f = fixture();
  try {
    const { config } = await f.command("config");
    assert.equal(config.version, "version-1");
    assert.equal(config.values.model, "gpt-model");
    assert.equal(config.origins.model, "user");
    assert.equal(config.approvalPolicy, "on-request");
    assert.equal(config.sandboxMode, "workspace-write");
    assert.deepEqual(
      config.models[0].tiers.map((tier) => tier.id),
      ["standard", "fast"],
    );
    assert.equal(JSON.stringify(config).includes("DO-NOT-RETURN"), false);
    assert.equal(JSON.stringify(config).includes("/private"), false);
  } finally {
    await f.manager.close();
  }
});

test("saving uses native version CAS and advances the shared account generation before delivery", async () => {
  const f = fixture();
  try {
    const saved = await f.command("save-config", 0, {
      version: "version-1",
      values: { model_verbosity: "high", service_tier: "fast" },
    });
    assert.equal(saved.outcome, "saved");
    assert.equal(saved.generation, 1);
    assert.equal(saved.config.version, "version-2");
    assert.equal(saved.config.values.model_verbosity, "high");
    assert.equal((await f.manager.run({ action: "status" })).generation, 1);
    const before = f.calls.length;
    await assert.rejects(
      f.command("save-config", 0, { version: "version-1", values: { model: null } }),
      /stale/,
    );
    await assert.rejects(
      f.manager.run({ action: "disconnect", lifetimeId: f.lifetimeId, generation: 0 }),
      /stale/,
    );
    assert.equal(f.calls.length, before);
    await assert.rejects(
      f.command("save-config", 1, { version: "version-1", values: { model: null } }),
      /stale/,
    );
    assert.equal(f.calls.filter(([method]) => method === "config/batchWrite").length, 1);
  } finally {
    await f.manager.close();
  }
});

test("a fresh native home uses its empty user-layer version for the first CAS write", async () => {
  const f = fixture({ fresh: true });
  try {
    const read = await f.command("config");
    assert.equal(
      read.config.version,
      "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    const saved = await f.command("save-config", 0, {
      version: read.config.version,
      values: { model_verbosity: "high" },
    });
    assert.equal(saved.outcome, "saved");
    assert.equal(saved.config.version, "version-2");
    assert.equal(
      f.calls.find(([method]) => method === "config/batchWrite")[1].expectedVersion,
      read.config.version,
    );
  } finally {
    await f.manager.close();
  }
});

test("lost config acknowledgement closes the mutator, reads durable state under its lock and never replays", async () => {
  const f = fixture({ loseWrite: true });
  try {
    const view = await f.command("save-config", 0, {
      version: "version-1",
      values: { model_verbosity: "high" },
    });
    assert.equal(view.outcome, "unknown");
    assert.equal(view.generation, 1);
    assert.equal(view.config.version, "version-2");
    assert.equal(view.config.values.model_verbosity, "high");
    assert.deepEqual(f.events, ["open:1", "write", "close:1", "open:2", "close:2", "unlock"]);
    assert.equal(f.calls.filter(([method]) => method === "config/batchWrite").length, 1);
    await assert.rejects(
      f.command("save-config", 0, { version: "version-1", values: { model_verbosity: "high" } }),
      /stale/,
    );
    assert.equal(f.calls.filter(([method]) => method === "config/batchWrite").length, 1);
  } finally {
    await f.manager.close();
  }
});

test("stale lifetime, pending login, auth lock and invalid model/settings cannot mutate native state", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.manager.manage({ action: "config", lifetimeId: randomUUID(), generation: 0 }),
      /stale/,
    );
    assert.equal(f.opened(), 0);
    for (const values of [
      { model: "unknown" },
      { model_reasoning_effort: "low" },
      { service_tier: "unsupported" },
    ])
      await assert.rejects(f.command("save-config", 0, { version: "version-1", values }), /stale/);
    assert.equal(
      f.calls.some(([method]) => method === "config/batchWrite"),
      false,
    );
    const pending = await f.manager.run({
      action: "connect",
      lifetimeId: f.lifetimeId,
      generation: 0,
    });
    const before = f.calls.length;
    await assert.rejects(f.command("config", pending.generation), /stale/);
    assert.equal(f.calls.length, before);
    assert.equal((await f.manager.peek()).state, "pending");
  } finally {
    await f.manager.close();
  }
  for (const options of [{ busy: true }, { foreignConfig: true }]) {
    const blocked = fixture(options);
    try {
      await assert.rejects(blocked.command("config"));
    } finally {
      await blocked.manager.close();
    }
    assert.equal(
      blocked.calls.some(([method]) => method === "config/batchWrite"),
      false,
    );
  }
});

test("management request allowlist rejects authority, arbitrary RPC and approval/sandbox edits", () => {
  const base = {
    action: "save-config",
    lifetimeId: randomUUID(),
    generation: 0,
    version: "v1",
    values: { model: null },
  };
  assert.equal(validManagementRequest(base), true);
  for (const request of [
    { ...base, method: "thread/start" },
    { ...base, home: "/other" },
    { ...base, executable: "/bin/sh" },
    { ...base, values: { approval_policy: "never" } },
    { ...base, values: { sandbox_mode: "danger-full-access" } },
    { ...base, values: { model: "x".repeat(161) } },
    { ...base, values: {} },
    { ...base, values: { web_search: "arbitrary" } },
  ])
    assert.equal(validManagementRequest(request), false);
});

test("only the Codex management wire enables the fixed read/write RPC allowlist", async () => {
  for (const management of [false, true]) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit("close"));
      return true;
    };
    const calls = [];
    child.stdin.on("data", (bytes) => {
      const request = JSON.parse(bytes.toString());
      calls.push(request.method);
      child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    });
    const wire = createAccountWire(child, () => {}, { management });
    try {
      if (management) await wire.call("config/read", { includeLayers: true });
      else await assert.rejects(wire.call("config/read", {}));
      for (const method of ["thread/start", "command/exec", "account/rateLimitResetCredit/consume"])
        await assert.rejects(wire.call(method, {}));
      assert.deepEqual(calls, management ? ["config/read"] : []);
    } finally {
      await wire.close();
    }
  }
});
