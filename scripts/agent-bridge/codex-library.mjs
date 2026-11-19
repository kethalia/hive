import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const sections = ["skills", "plugins", "sessions", "integrations"];
const array = (value) => (Array.isArray(value) ? value : []);
const label = (value, max = 160) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const key = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const within = (home, path) => {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const location = relative(home, path);
  return !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`);
};
// Native sends the full tool schemas for each server. Bound each page before projection.
const integrationPageSize = 4;
const sessionStates = new Map([
  ["notLoaded", "saved"],
  ["active", "running"],
  ["idle", "idle"],
  ["systemError", "error"],
]);
const stale = () => {
  throw Error("managed_auth_stale");
};

export function validLibraryRequest(request) {
  if (
    !sections.includes(request.section) ||
    (request.sessionId !== undefined &&
      (request.section !== "skills" ||
        typeof request.sessionId !== "string" ||
        !sessionId.test(request.sessionId)))
  )
    return false;
  if (request.action === "library") {
    const { section, search, archived, cursor } = request;
    return (
      (search === null ||
        (section === "sessions" && typeof search === "string" && search.length <= 160)) &&
      (archived === false || (section === "sessions" && archived === true)) &&
      (cursor === null ||
        (["sessions", "integrations"].includes(section) &&
          typeof cursor === "string" &&
          cursor.length > 0 &&
          cursor.length <= 2048))
    );
  }
  return (
    typeof request.id === "string" &&
    /^[0-9a-f]{64}$/.test(request.id) &&
    typeof request.revision === "string" &&
    /^[0-9a-f]{64}$/.test(request.revision) &&
    ((request.section === "skills" && ["enable", "disable"].includes(request.change)) ||
      (request.section === "plugins" &&
        ["enable", "disable", "install", "remove"].includes(request.change)))
  );
}

async function skills(rpc, home, id) {
  let directory = home;
  if (id) {
    const { thread } = await rpc("thread/read", { threadId: id, includeTurns: false });
    if (thread?.id !== id || !within(home, thread.cwd)) stale();
    const resolved = await realpath(thread.cwd).catch(() => null);
    if (!within(home, resolved)) stale();
    directory = resolved;
  }
  const native = await rpc("skills/list", { cwds: [directory], forceReload: true });
  const group = native?.data?.find((item) => item.cwd === directory);
  if (!Array.isArray(group?.skills)) throw Error("managed_management_unavailable");
  const entries = group.skills.filter(
    (item) =>
      typeof item.path === "string" && isAbsolute(item.path) && item.path.endsWith("/SKILL.md"),
  );
  return {
    entries: entries.map((item) => {
      const scope = ["user", "repo", "system", "admin"].includes(item.scope)
        ? item.scope
        : "unknown";
      const enabled = item.enabled === true;
      return {
        item,
        row: {
          id: key(item.path),
          revision: key([directory, item.path, enabled, scope, item.pluginId]),
          name: label(item.interface?.displayName || item.name) || "Unnamed skill",
          description: label(item.interface?.shortDescription || item.description, 500),
          scope,
          enabled,
          pluginId: label(item.pluginId) || null,
          editable: ["user", "repo", "system"].includes(scope) && !item.pluginId,
        },
      };
    }),
    partial: array(group.errors).length > 0,
    directory: label(directory, 1024),
  };
}

async function plugins(rpc) {
  const native = await rpc("plugin/list", {});
  if (!Array.isArray(native?.marketplaces)) throw Error("managed_management_unavailable");
  const entries = native.marketplaces.flatMap((market) =>
    array(market.plugins)
      .filter((item) => typeof item.id === "string" && /^[\w.-]+@[\w.-]+$/.test(item.id))
      .map((item) => {
        const available = item.availability === "AVAILABLE" && item.installPolicy === "AVAILABLE";
        const localMarket = typeof market.path === "string" && isAbsolute(market.path);
        return {
          item,
          market,
          row: {
            id: key(item.id),
            revision: key([
              item.id,
              market.path,
              item.source,
              item.installed,
              item.enabled,
              item.version,
              item.localVersion,
              item.availability,
              item.installPolicy,
              item.mustShowInstallationInterstitial,
            ]),
            name: label(item.interface?.displayName || item.name) || item.id.slice(0, 160),
            description: label(item.interface?.shortDescription, 500),
            marketplace: label(market.name),
            version: label(item.localVersion || item.version) || null,
            installed: item.installed === true,
            enabled: item.enabled === true,
            installable:
              available &&
              !item.mustShowInstallationInterstitial &&
              (localMarket || item.source?.type === "remote"),
            editable:
              item.installPolicy !== "INSTALLED_BY_DEFAULT" && item.availability === "AVAILABLE",
          },
        };
      }),
  );
  // Marketplaces can overlap. Only expose actions on an unambiguous native ID.
  const counts = new Map();
  for (const { row } of entries) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return {
    entries: entries
      .filter(({ row }) => counts.get(row.id) === 1)
      .sort((a, b) => Number(b.row.installed) - Number(a.row.installed)),
    partial: array(native.marketplaceLoadErrors).length > 0 || counts.size !== entries.length,
  };
}

function projectRows(section, { entries, partial, directory }) {
  return {
    section,
    rows: entries.slice(0, 200).map(({ row }) => row),
    partial: partial || entries.length > 200,
    nextCursor: null,
    ...(directory !== undefined ? { directory } : {}),
  };
}

export async function readLibrary(rpc, home, request) {
  const { section, cursor } = request;
  if (section === "skills") return projectRows(section, await skills(rpc, home, request.sessionId));
  if (section === "plugins") return projectRows(section, await plugins(rpc));
  const native =
    section === "sessions"
      ? await rpc("thread/list", {
          cursor,
          limit: 25,
          sortKey: "updated_at",
          modelProviders: [],
          sourceKinds: ["cli", "vscode", "exec", "appServer"],
          archived: request.archived,
          searchTerm: request.search,
        })
      : await rpc("mcpServerStatus/list", {
          cursor,
          limit: integrationPageSize,
          detail: "toolsAndAuthOnly",
        });
  if (!Array.isArray(native?.data)) throw Error("managed_management_unavailable");
  const rows =
    section === "sessions"
      ? native.data
          .slice(0, 25)
          .filter((item) => sessionId.test(label(item.id)))
          .map((item) => ({
            id: label(item.id),
            name: label(item.name || item.preview || "Untitled session"),
            directory: label(item.cwd, 1024),
            model: label(item.model) || null,
            parent: label(item.parentThreadId) || null,
            updatedAt:
              Number.isSafeInteger(item.updatedAt) && Math.abs(item.updatedAt) <= 8_640_000_000_000
                ? item.updatedAt
                : null,
            status: sessionStates.get(item.status?.type) ?? "unknown",
            canInspectSkills: sessionId.test(label(item.id)) && within(home, item.cwd),
          }))
      : native.data.slice(0, integrationPageSize).map((item) => ({
          name: label(item.name),
          pluginId: label(item.pluginId) || null,
          auth: ["unsupported", "notLoggedIn", "bearerToken", "oAuth"].includes(item.authStatus)
            ? item.authStatus
            : "unknown",
          runtime: label(item.runtimeStatus?.type ?? item.runtimeStatus) || null,
          tools: Object.keys(item.tools ?? {})
            .slice(0, 100)
            .map((name) => label(name)),
        }));
  return {
    section,
    rows,
    partial: typeof native.nextCursor === "string" && native.nextCursor.length > 2048,
    nextCursor:
      typeof native.nextCursor === "string" && native.nextCursor.length <= 2048
        ? native.nextCursor || null
        : null,
  };
}

export async function saveLibrary(rpc, home, root, request, onSubmit) {
  const { section, change } = request;
  const get =
    section === "skills" ? () => skills(rpc, home, request.sessionId) : () => plugins(rpc);
  const current = (await get()).entries.find(({ row }) => row.id === request.id);
  if (!current || current.row.revision !== request.revision) stale();
  const { row, item, market } = current;
  const enabled = change === "enable";
  if (section === "skills") {
    if (!row.editable || row.enabled === enabled) stale();
    onSubmit();
    const native = await rpc("skills/config/write", { path: item.path, enabled });
    if (native?.effectiveEnabled !== enabled) throw Error("managed_management_unavailable");
  } else if (change === "install") {
    if (row.installed || !row.installable) stale();
    onSubmit();
    await rpc("plugin/install", {
      ...(market.path ? { marketplacePath: market.path } : { remoteMarketplaceName: market.name }),
      pluginName: item.name,
    });
  } else if (change === "remove") {
    if (!row.installed || !row.editable) stale();
    onSubmit();
    await rpc("plugin/uninstall", { pluginId: item.id });
  } else {
    if (!row.installed || !row.editable || row.enabled === enabled) stale();
    const config = await rpc("config/read", { includeLayers: true });
    const layer = array(config?.layers).find(
      (value) => value.name?.type === "user" && !value.name.profile,
    );
    if (!layer?.version || layer.name.file !== join(root, "config.toml")) stale();
    onSubmit();
    await rpc("config/batchWrite", {
      filePath: join(root, "config.toml"),
      edits: [
        {
          keyPath: `plugins.${JSON.stringify(item.id)}.enabled`,
          value: enabled,
          mergeStrategy: "replace",
        },
      ],
      expectedVersion: layer.version,
    });
  }
  const result = await get();
  const updated = result.entries.find((entry) => entry.row.id === request.id)?.row;
  if (
    change === "remove"
      ? updated?.installed || (!updated && result.partial)
      : change === "install"
        ? !updated?.installed
        : updated?.enabled !== enabled
  )
    throw Error("managed_management_unavailable");
  return projectRows(section, result);
}
