import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Explicit export-level review. Other functions in this same module use SSH or
// local processes and must not become callable merely because it is bundled.
const reviewed = new Map([
  [
    "lib/actions/workspaces.ts",
    new Set([
      "listWorkspacesAction",
      "listWorkspaceTemplatesAction",
      "getWorkspaceAction",
      "getWorkspaceAgentAction",
      "getWorkspaceSessionsAction",
      "getExistingTerminalPathsAction",
      "getWorkspaceSessionToolsAction",
      "createSessionAction",
      "createWorkspaceAction",
      "startWorkspaceAction",
      "stopWorkspaceAction",
      "deleteWorkspaceAction",
    ]),
  ],
  ["lib/actions/templates.ts", new Set(["listTemplateStatusesAction"])],
]);
export const PORTABLE_ACTION_FILE = ".open-next/cloudflare/hive-portable-actions.mjs";

export function portableActionManifest(manifest) {
  assert.ok(manifest && typeof manifest.node === "object" && !Array.isArray(manifest.node));
  const actions = {};
  for (const [id, entry] of Object.entries(manifest.node)) {
    if (!reviewed.get(entry?.filename)?.has(entry?.exportedName)) continue;
    assert.match(id, /^[0-7][a-f0-9]{41}$/);
    assert.ok(entry.workers && typeof entry.workers === "object");
    if (!Object.hasOwn(entry.workers, "app/(dashboard)/workspaces/page")) continue;
    actions[id] = {
      filename: entry.filename,
      exportedName: entry.exportedName,
      paths: ["/workspaces"],
      maxBodyBytes: entry.exportedName === "getExistingTerminalPathsAction" ? 786432 : 65536,
    };
  }
  for (const name of [
    "createWorkspaceAction",
    "startWorkspaceAction",
    "stopWorkspaceAction",
    "deleteWorkspaceAction",
  ])
    assert.ok(
      Object.values(actions).some((entry) => entry.exportedName === name),
      `Reviewed action missing from framework build: ${name}`,
    );
  // Deliberately exclude the framework encryption key and unrelated exports.
  return { schemaVersion: 1, actions };
}

export async function writePortableActions(root = process.cwd()) {
  const manifest = JSON.parse(
    await readFile(join(root, ".next-cloudflare/server/server-reference-manifest.json"), "utf8"),
  );
  const value = portableActionManifest(manifest);
  await writeFile(join(root, PORTABLE_ACTION_FILE), `export default ${JSON.stringify(value)};\n`);
  return value;
}
