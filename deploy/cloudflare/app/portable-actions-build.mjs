import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Export-level admission. Other exports in these modules may require a workspace helper.
const workspaceActions = new Set([
  "listWorkspacesAction",
  "listWorkspaceTemplatesAction",
  "getWorkspaceAction",
  "getWorkspaceAgentAction",
  "getWorkspaceSessionsAction",
  "createSessionAction",
  "createWorkspaceAction",
  "startWorkspaceAction",
  "stopWorkspaceAction",
  "deleteWorkspaceAction",
]);
export function portableActionManifest(manifest) {
  assert.ok(manifest?.node && typeof manifest.node === "object");
  const actions = {};
  for (const [id, entry] of Object.entries(manifest.node)) {
    const allowed =
      (entry.filename === "lib/actions/workspaces.ts" &&
        workspaceActions.has(entry.exportedName)) ||
      (entry.filename === "lib/actions/templates.ts" &&
        entry.exportedName === "listTemplateStatusesAction");
    if (!allowed || !Object.hasOwn(entry.workers ?? {}, "app/(dashboard)/workspaces/page"))
      continue;
    assert.match(id, /^[0-7][a-f0-9]{41}$/);
    actions[id] = { paths: ["/workspaces"], maxBodyBytes: 65536 };
  }
  assert.ok(Object.keys(actions).length > 0, "Build contains no reviewed workspace actions");
  return { schemaVersion: 1, actions };
}
export async function writePortableActions(root = process.cwd()) {
  const manifest = JSON.parse(
    await readFile(join(root, ".next-cloudflare/server/server-reference-manifest.json"), "utf8"),
  );
  const value = portableActionManifest(manifest);
  await writeFile(
    join(root, ".open-next/cloudflare/hive-portable-actions.mjs"),
    `export default ${JSON.stringify(value)};\n`,
  );
  return value;
}
