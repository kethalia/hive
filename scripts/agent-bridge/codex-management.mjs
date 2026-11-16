import { join } from "node:path";

// Adapted from CCS 86b3df8 apps/studio-server/src/codex-management.ts.
// Only native usage and the six reviewed user-config fields cross this boundary.
const fields = [
  "model",
  "review_model",
  "model_reasoning_effort",
  "model_verbosity",
  "web_search",
  "service_tier",
];
const choices = {
  model_reasoning_effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  model_verbosity: ["low", "medium", "high"],
  web_search: ["disabled", "cached", "live"],
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => (Array.isArray(value) ? value : []);
const numeric = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const integer = (value) => (Number.isSafeInteger(value) ? value : null);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const unavailable = () => {
  throw Error("managed_management_unavailable");
};
const stale = () => {
  throw Error("managed_auth_stale");
};
const text = (value, maximum = 160) => {
  if (typeof value !== "string" || value.length > maximum) unavailable();
  return value;
};
const nullableText = (value, maximum = 160) =>
  typeof value === "string" ? text(value, maximum) : null;
const exact = (value, keys) =>
  Object.keys(object(value)).sort().join(",") === [...keys].sort().join(",");

export function validManagementRequest(request) {
  if (
    !request ||
    !["usage", "config", "save-config"].includes(request.action) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.lifetimeId) ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !exact(request, [
      "action",
      "lifetimeId",
      "generation",
      ...(request.action === "save-config" ? ["version", "values"] : []),
    ])
  )
    return false;
  if (request.action !== "save-config") return true;
  if (
    typeof request.version !== "string" ||
    !request.version.length ||
    request.version.length > 2048 ||
    !request.values ||
    typeof request.values !== "object" ||
    Array.isArray(request.values) ||
    !Object.keys(request.values).length
  )
    return false;
  return Object.entries(request.values).every(
    ([key, value]) =>
      fields.includes(key) &&
      (value === null ||
        (typeof value === "string" &&
          value.length <= 160 &&
          (!choices[key] || choices[key].includes(value)))),
  );
}

export async function readUsage(rpc) {
  const [limits, usage] = await Promise.allSettled([
    rpc("account/rateLimits/read", {}),
    rpc("account/usage/read", {}),
  ]);
  if (limits.status === "rejected" && usage.status === "rejected") unavailable();
  const rates = limits.status === "fulfilled" ? object(limits.value) : {};
  const tokens = usage.status === "fulfilled" ? object(usage.value) : {};
  const buckets = object(rates.rateLimitsByLimitId);
  const entries = Object.keys(buckets).length
    ? Object.entries(buckets)
    : rates.rateLimits
      ? [["codex", rates.rateLimits]]
      : [];
  const window = (value) => {
    const item = object(value),
      percent = numeric(item.usedPercent),
      minutes = numeric(item.windowDurationMins);
    return percent === null
      ? null
      : {
          usedPercent: Math.max(0, Math.min(100, percent)),
          minutes: minutes !== null && minutes >= 0 ? minutes : null,
          resetsAt: integer(item.resetsAt),
        };
  };
  const credits = object(object(rates.rateLimits).credits);
  const summary = object(tokens.summary);
  return {
    limitsAvailable: limits.status === "fulfilled",
    usageAvailable: usage.status === "fulfilled",
    windows: entries.slice(0, 100).map(([id, value]) => {
      const item = object(value);
      return {
        id: text(id),
        name: text(item.limitName ?? item.limitId ?? id),
        primary: window(item.primary),
        secondary: window(item.secondary),
      };
    }),
    credits: Object.keys(credits).length
      ? {
          balance:
            typeof credits.balance === "string" || numeric(credits.balance) !== null
              ? text(String(credits.balance), 2048)
              : null,
          unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : null,
        }
      : null,
    resetCredits: count(object(rates.rateLimitResetCredits).availableCount),
    resets: Array.isArray(object(rates.rateLimitResetCredits).credits)
      ? rates.rateLimitResetCredits.credits.slice(0, 1000).map((value) => {
          const credit = object(value);
          return {
            id: text(credit.id, 2048),
            title: nullableText(credit.title, 500),
            description: nullableText(credit.description, 2000),
            resetType: credit.resetType === "codexRateLimits" ? "codexRateLimits" : "unknown",
            status: ["available", "redeeming", "redeemed"].includes(credit.status)
              ? credit.status
              : "unknown",
            grantedAt: integer(credit.grantedAt),
            expiresAt: integer(credit.expiresAt),
          };
        })
      : null,
    tokens:
      usage.status === "fulfilled"
        ? {
            lifetime: count(summary.lifetimeTokens),
            peakDaily: count(summary.peakDailyTokens),
            daily: array(tokens.dailyUsageBuckets)
              .slice(-400)
              .map((value) => {
                const item = object(value);
                if (count(item.tokens) === null) unavailable();
                return { date: text(item.startDate, 32), tokens: item.tokens };
              }),
          }
        : null,
  };
}

async function configuration(rpc, root) {
  const result = object(await rpc("config/read", { includeLayers: true }));
  const layer = array(result.layers).find(
    (value) => object(value.name).type === "user" && !object(value.name).profile,
  );
  // Native 0.165 supplies an empty user-layer version even before this file exists.
  if (!layer?.version || object(layer.name).file !== join(root, "config.toml")) unavailable();
  return { result, layer, config: object(result.config), version: text(layer.version, 2048) };
}

export async function readConfig(rpc, root) {
  const { result, config, version } = await configuration(rpc, root);
  const models = [];
  let cursor = null;
  for (let index = 0; index < 2; index++) {
    const page = object(await rpc("model/list", { cursor, limit: 100, includeHidden: false }));
    if (!Array.isArray(page.data)) unavailable();
    models.push(...page.data.slice(0, 100));
    cursor = nullableText(page.nextCursor, 4096);
    if (!cursor) break;
  }
  const values = Object.fromEntries(fields.map((key) => [key, config[key] ?? null]));
  if (
    !Object.entries(values).every(
      ([key, value]) =>
        value === null ||
        (typeof value === "string" &&
          value.length <= 160 &&
          (!choices[key] || choices[key].includes(value))),
    )
  )
    unavailable();
  return {
    version,
    values,
    origins: Object.fromEntries(
      fields.map((key) => [
        key,
        text(object(object(object(result.origins)[key]).name).type ?? "default"),
      ]),
    ),
    models: models.slice(0, 200).map((value) => {
      const item = object(value);
      return {
        id: text(item.model),
        name: text(item.displayName),
        efforts: array(item.supportedReasoningEfforts)
          .slice(0, 20)
          .map((value) => text(object(value).reasoningEffort)),
        tiers: array(item.serviceTiers)
          .slice(0, 20)
          .map((value) => {
            const tier = object(value);
            return { id: text(tier.id), name: text(tier.name ?? tier.id) };
          }),
      };
    }),
    truncated: !!cursor,
    approvalPolicy: nullableText(config.approval_policy),
    sandboxMode: nullableText(config.sandbox_mode),
  };
}

export async function saveConfig(rpc, root, request, onSubmit) {
  const current = await configuration(rpc, root);
  if (current.version !== request.version) stale();
  const catalog = await readConfig(rpc, root);
  if (catalog.version !== current.version) stale();
  const values = request.values;
  for (const id of [values.model, values.review_model])
    if (
      id &&
      id !== current.config.model &&
      id !== current.config.review_model &&
      !catalog.models.some((model) => model.id === id)
    )
      stale();
  const model = catalog.models.find((model) => model.id === (values.model ?? current.config.model));
  if (
    model &&
    values.model_reasoning_effort &&
    !model.efforts.includes(values.model_reasoning_effort)
  )
    stale();
  if (model && values.service_tier && !model.tiers.some((tier) => tier.id === values.service_tier))
    stale();
  onSubmit();
  const result = object(
    await rpc("config/batchWrite", {
      expectedVersion: current.version,
      filePath: join(root, "config.toml"),
      reloadUserConfig: true,
      edits: Object.entries(values).map(([keyPath, value]) => ({
        keyPath,
        value,
        mergeStrategy: "replace",
      })),
    }),
  );
  if (!["ok", "okOverridden"].includes(result.status)) unavailable();
  return result.status === "okOverridden" || result.overriddenMetadata != null;
}
